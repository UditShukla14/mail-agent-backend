import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';

// Helper function to ensure consistent data format
const ensureAnalyticsData = (data, defaultValue = []) => {
  if (!data || !Array.isArray(data)) {
    return defaultValue;
  }
  return data;
};

// Helper function to format volume over time data
const formatVolumeOverTime = (volumeData) => {
  if (!volumeData || !Array.isArray(volumeData)) {
    return [];
  }
  
  // Fill in missing dates with zero counts for the last 30 days
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dateMap = new Map();
  
  // Initialize all dates with zero count
  for (let d = new Date(thirtyDaysAgo); d <= today; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    dateMap.set(dateStr, 0);
  }
  
  // Override with actual data
  volumeData.forEach(item => {
    if (item._id && item.count !== undefined) {
      dateMap.set(item._id, item.count);
    }
  });
  
  // Convert to array format expected by frontend
  return Array.from(dateMap.entries()).map(([date, count]) => ({
    date,
    count
  }));
};

export const getEmailAnalytics = async (req, res) => {
  try {
    const { email: queryEmail, folderId } = req.query;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Use the email from query params if provided, otherwise use user's email
    const targetEmail = queryEmail || req.user.email;

    if (!targetEmail) {
      return res.status(400).json({ 
        success: false,
        error: 'Email parameter required' 
      });
    }

    // Get user from database using worxstreamUserId
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Check if user has any email accounts
    const emailAccounts = await EmailAccount.find({ userId: user._id });
    
    if (emailAccounts.length === 0) {
      return res.json({
        success: true,
        data: {
          volumeOverTime: [],
          categories: [],
          sentiment: [],
          priority: [],
          enrichedCount: 0
        }
      });
    }
    
    // Get all email addresses for this user
    const userEmails = emailAccounts.map(account => account.email);
    
    // Build base match criteria - check for emails from any of the user's email accounts
    const baseMatchCriteria = { 
      userId: user._id,
      email: { $in: userEmails }
    };
    
    // If specific email is requested and it exists in user's accounts, filter by that email
    // Otherwise, use all user's email addresses
    if (targetEmail && userEmails.includes(targetEmail)) {
      baseMatchCriteria.email = targetEmail;
    }
    
    // Add folder filter if provided and not 'all'
    if (folderId && folderId !== 'all') {
      baseMatchCriteria.folder = folderId;
    }
    
    // First, check if we have any enriched emails for this specific email and folder
    const enrichedMatchCriteria = { ...baseMatchCriteria };
    enrichedMatchCriteria['aiMeta.enrichedAt'] = { $exists: true };

    const enrichedCount = await Email.countDocuments(enrichedMatchCriteria);

    // If no enriched emails, trigger enrichment for all unenriched emails for this email and folder
    if (enrichedCount === 0) {
      const unenrichedMatchCriteria = { 
        userId: user._id,
        email: targetEmail,
        $or: [
          { 'aiMeta.enrichedAt': { $exists: false } },
          { 'aiMeta.enrichedAt': null }
        ]
      };
      
      if (folderId) {
        unenrichedMatchCriteria.folder = folderId;
      }

      const unenrichedEmails = await Email.find(unenrichedMatchCriteria);

      if (unenrichedEmails.length > 0) {
        try {
          // Use the queue service instead of direct enrichment to prevent infinite loops
          const enrichmentQueueService = await import('../services/enrichmentQueueService.js');
          await enrichmentQueueService.default.addToQueue(unenrichedEmails);
        } catch (enrichmentError) {
          // Silently handle enrichment queue errors
        }
      }
    }

    // Get volume over time (last 30 days) for this specific email and folder
    const volumeOverTime = await Email.aggregate([
      { 
        $match: baseMatchCriteria
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 30 }
    ]);

    // Get categories distribution for this specific email and folder
    // First, get all categories from the user's email account
    const emailAccount = await EmailAccount.findOne({ userId: user._id, email: userEmails[0] });
    const allCategories = emailAccount?.categories || [];
    
    // Get actual email counts for each category
    const categoriesMatchCriteria = { ...baseMatchCriteria };
    categoriesMatchCriteria['aiMeta.category'] = { $exists: true, $ne: null };

    // Get actual email counts for each category
    const actualCategoriesInDB = await Email.aggregate([
      { 
        $match: { ...baseMatchCriteria, 'aiMeta.category': { $exists: true, $ne: null } }
      },
      {
        $group: {
          _id: "$aiMeta.category",
          count: { $sum: 1 }
        }
      }
    ]);

    const emailCategories = await Email.aggregate([
      { 
        $match: categoriesMatchCriteria
      },
      {
        $group: {
          _id: "$aiMeta.category",
          value: { $sum: 1 },
          unreadCount: { $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] } }
        }
      }
    ]);

    // Merge categories from EmailAccount with actual email counts
    const categories = allCategories.map(category => {
      // Try exact match first, then case-insensitive match
      let emailCategory = emailCategories.find(ec => ec._id === category.name);
      if (!emailCategory) {
        emailCategory = emailCategories.find(ec => 
          ec._id.toLowerCase() === category.name.toLowerCase()
        );
      }
      return {
        name: category.name,
        label: category.label,
        color: category.color,
        value: emailCategory ? emailCategory.value : 0,
        unreadCount: emailCategory ? emailCategory.unreadCount : 0
      };
    });

    // Add a catch-all category for emails that have category data but don't match EmailAccount categories
    const matchedCategoryNames = emailCategories.map(ec => ec._id);
    const unmatchedCategories = actualCategoriesInDB.filter(ac => !matchedCategoryNames.includes(ac._id));
    
    if (unmatchedCategories.length > 0) {
      const unmatchedTotal = unmatchedCategories.reduce((sum, cat) => sum + cat.count, 0);
      categories.push({
        name: 'unmatched',
        label: 'Other Categories',
        color: '#BDBDBD',
        value: unmatchedTotal,
        unreadCount: 0 // We don't have unread count for unmatched categories
      });
    }

    // Special handling for 'work' category - map it to 'product_technical' if it exists
    const workCategory = categories.find(cat => cat.name === 'product_technical');
    const workEmails = actualCategoriesInDB.find(ac => ac._id === 'work');
    if (workEmails && workCategory) {
      workCategory.value += workEmails.count;
    }

    // Get sentiment analysis for this specific email and folder
    const sentimentMatchCriteria = { ...baseMatchCriteria };
    sentimentMatchCriteria['aiMeta.sentiment'] = { $exists: true, $ne: null };

    const sentiment = await Email.aggregate([
      { 
        $match: sentimentMatchCriteria
      },
      {
        $group: {
          _id: "$aiMeta.sentiment",
          value: { $sum: 1 }
        }
      },
      {
        $project: {
          name: "$_id",
          value: 1,
          _id: 0
        }
      }
    ]);

    // Get priority distribution for this specific email and folder
    const priorityMatchCriteria = { ...baseMatchCriteria };
    priorityMatchCriteria['aiMeta.priority'] = { $exists: true, $ne: null };

    const priority = await Email.aggregate([
      { 
        $match: priorityMatchCriteria
      },
      {
        $group: {
          _id: "$aiMeta.priority",
          value: { $sum: 1 }
        }
      },
      {
        $project: {
          name: "$_id",
          value: 1,
          _id: 0
        }
      }
    ]);

    // Count total analyzed emails (those with aiMeta field)
    const analyzedEmailsCount = await Email.countDocuments({
      ...baseMatchCriteria,
      'aiMeta': { $exists: true, $ne: null }
    });

    // Ensure all data is properly formatted and sanitized
    const formattedVolumeOverTime = formatVolumeOverTime(volumeOverTime);
    const sanitizedCategories = ensureAnalyticsData(categories).map(cat => ({
      name: cat.name || 'Unknown',
      label: cat.label || cat.name || 'Unknown',
      color: cat.color || '#000000',
      value: parseInt(cat.value) || 0,
      unreadCount: parseInt(cat.unreadCount) || 0
    }));
    const sanitizedSentiment = ensureAnalyticsData(sentiment).map(sent => ({
      name: sent.name || 'neutral',
      value: parseInt(sent.value) || 0
    }));
    const sanitizedPriority = ensureAnalyticsData(priority).map(pri => ({
      name: pri.name || 'medium',
      value: parseInt(pri.value) || 0
    }));

    res.json({
      success: true,
      data: {
        volumeOverTime: formattedVolumeOverTime,
        categories: sanitizedCategories,
        sentiment: sanitizedSentiment,
        priority: sanitizedPriority,
        enrichedCount: parseInt(enrichedCount) || 0,
        analyzedEmailsCount: parseInt(analyzedEmailsCount) || 0
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Internal server error', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

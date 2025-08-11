import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import emailEnrichmentService from '../services/emailEnrichment.js';

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

export const getEmailStats = async (req, res) => {
  try {
    const { email: queryEmail, folderId } = req.query;
    const worxstreamUserId = Number(req.user.id);

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Use the email from query params if provided, otherwise use all connected email accounts
    const targetEmail = queryEmail || null;

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
          total: 0,
          read: 0,
          important: 0,
          flagged: 0
        }
      });
    }
    
    // Get all email addresses for this user
    const userEmails = emailAccounts.map(account => account.email);
    
    // Build match criteria - check for emails from any of the user's email accounts
    const matchCriteria = { 
      userId: user._id,
      email: { $in: userEmails }
    };
    
    // If specific email is requested and it exists in user's accounts, filter by that email
    // Otherwise, use all user's email addresses
    if (targetEmail && userEmails.includes(targetEmail)) {
      matchCriteria.email = targetEmail;
    }
    
    // Add folder filter if provided and not 'all' or 'Inbox' (since Inbox is a display name, not folder ID)
    if (folderId && folderId !== 'all' && folderId !== 'Inbox') {
      matchCriteria.folder = folderId;
    }

    const stats = await Email.aggregate([
      { 
        $match: matchCriteria
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          read: { $sum: { $cond: [{ $eq: ["$read", true] }, 1, 0] } },
          important: { $sum: { $cond: [{ $eq: ["$important", true] }, 1, 0] } },
          flagged: { $sum: { $cond: [{ $eq: ["$flagged", true] }, 1, 0] } }
        }
      }
    ]);
    
    // Ensure we always return consistent data structure
    const finalStats = stats[0] || { total: 0, read: 0, important: 0, flagged: 0 };
    
    // Ensure all fields are numbers
    const sanitizedStats = {
      total: parseInt(finalStats.total) || 0,
      read: parseInt(finalStats.read) || 0,
      important: parseInt(finalStats.important) || 0,
      flagged: parseInt(finalStats.flagged) || 0
    };
    
    res.json({
      success: true,
      data: sanitizedStats
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

export const getEmailAnalytics = async (req, res) => {
  try {
    const { email: queryEmail, folderId } = req.query;
    const worxstreamUserId = Number(req.user.id);

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Use the email from query params if provided, otherwise use all connected email accounts
    const targetEmail = queryEmail || null;

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
    
    // Add folder filter if provided and not 'all' or 'Inbox' (since Inbox is a display name, not folder ID)
    if (folderId && folderId !== 'all' && folderId !== 'Inbox') {
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
        $or: [
          { 'aiMeta.enrichedAt': { $exists: false } },
          { 'aiMeta.enrichedAt': null }
        ]
      };
      
      // Add email filter only if targetEmail is specified
      if (targetEmail) {
        unenrichedMatchCriteria.email = targetEmail;
      } else {
        unenrichedMatchCriteria.email = { $in: userEmails };
      }
      
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
    // Get categories from the currently active email account (like priority and sentiment)
    const activeEmail = targetEmail || userEmails[0];
    const emailAccount = await EmailAccount.findOne({ userId: user._id, email: activeEmail });
    const allCategories = emailAccount?.categories || [];
    
    console.log(`🔍 Analytics: Active account: ${activeEmail}`);
    console.log(`🔍 Analytics: Found ${allCategories.length} categories for active account`);
    console.log(`🔍 Analytics: Categories:`, allCategories.map(c => c.name));
    
    console.log(`🔍 Analytics: Base match criteria:`, baseMatchCriteria);
    console.log(`🔍 Analytics: User emails:`, userEmails);
    console.log(`🔍 Analytics: Target email:`, targetEmail);
    
    // Get actual email counts for each category for THIS specific account
    const categoriesMatchCriteria = { ...baseMatchCriteria };
    categoriesMatchCriteria['aiMeta.category'] = { $exists: true, $ne: null };
    
    console.log(`🔍 Analytics: Category match criteria:`, categoriesMatchCriteria);

    // Get actual email counts for each category
    const actualCategoriesInDB = await Email.aggregate([
      { 
        $match: categoriesMatchCriteria
      },
      {
        $group: {
          _id: "$aiMeta.category",
          count: { $sum: 1 }
        }
      }
    ]);
    
    console.log(`🔍 Analytics: Actual categories in DB:`, actualCategoriesInDB);
    
    // Debug: Check if emails have aiMeta.category field
    const emailsWithCategory = await Email.countDocuments(categoriesMatchCriteria);
    const totalEmails = await Email.countDocuments(baseMatchCriteria);
    console.log(`🔍 Analytics: Emails with category field: ${emailsWithCategory}/${totalEmails}`);
    
    // Debug: Sample emails to see what's in aiMeta.category
    const sampleEmails = await Email.find(categoriesMatchCriteria).limit(5).select('aiMeta.category');
    console.log(`🔍 Analytics: Sample emails with categories:`, sampleEmails.map(e => e.aiMeta?.category));
    
    // Debug: Check what emails exist for this account
    const accountEmails = await Email.find(baseMatchCriteria).limit(3).select('email aiMeta.category');
    console.log(`🔍 Analytics: Sample account emails:`, accountEmails.map(e => ({ email: e.email, category: e.aiMeta?.category })));
    
    // Debug: Check ALL emails for this account to see which one is missing
    const allAccountEmails = await Email.find(baseMatchCriteria).select('id email aiMeta.category aiMeta.enrichedAt');
    console.log(`🔍 Analytics: ALL emails for account:`, allAccountEmails.map(e => ({ 
      id: e.id, 
      email: e.email, 
      category: e.aiMeta?.category,
      enrichedAt: e.aiMeta?.enrichedAt
    })));

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
    
    console.log(`🔍 Analytics: Email categories aggregation result:`, emailCategories);

        // Merge categories from EmailAccount with actual email counts
    const categories = allCategories.map(category => {
      // Use name for backend filtering as intended - emails should store the name value
      let emailCategory = emailCategories.find(ec => ec._id === category.name);
      
      if (!emailCategory) {
        // Try case-insensitive match on name
        emailCategory = emailCategories.find(ec => 
          ec._id.toLowerCase() === category.name.toLowerCase()
        );
      }
      
      if (!emailCategory) {
        // Try normalized match (handle spaces, underscores, case differences)
        const normalizedName = category.name.toLowerCase().replace(/[_\s]/g, '');
        emailCategory = emailCategories.find(ec => {
          const normalizedEmailCategory = ec._id.toLowerCase().replace(/[_\s]/g, '');
          return normalizedEmailCategory === normalizedName;
        });
      }
      
      if (emailCategory) {
        console.log(`🔍 Analytics: Category "${category.name}" matched: "${emailCategory._id}" -> "${category.name}"`);
      } else {
        console.log(`🔍 Analytics: Category "${category.name}" - No matching emails found (emails may be storing label instead of name)`);
      }
      
      return {
        name: category.name,
        label: category.label,
        color: category.color,
        value: emailCategory ? emailCategory.value : 0,
        unreadCount: emailCategory ? emailCategory.unreadCount : 0
      };
    });
    
    console.log(`🔍 Analytics: Final merged categories:`, categories.map(c => ({ name: c.name, value: c.value, unreadCount: c.unreadCount })));
    
    // Since emails can only have categories from EmailAccount, we don't need to add unmatched categories
    // All categories should be properly matched above

    // Note: Custom categories are now handled automatically above
    // No need for special category mapping since we show all categories that exist in emails
    
    console.log(`🔍 Analytics: Final categories after adding custom ones:`, categories.map(c => ({ name: c.name, value: c.value })));

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

export const getUnreadEmailsSummary = async (req, res) => {
  try {
    const { email: queryEmail, folderId, timePeriod = '24h' } = req.query;
    const worxstreamUserId = Number(req.user.id);

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Use the email from query params if provided, otherwise use all connected email accounts
    const targetEmail = queryEmail || null;

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
          emails: [],
          total: 0,
          lastUpdated: new Date().toISOString(),
          timePeriod: timePeriod
        }
      });
    }
    
    // Get all email addresses for this user
    const userEmails = emailAccounts.map(account => account.email);

    // Calculate time period based on parameter
    let timeAgo;
    switch (timePeriod) {
      case '3d':
        timeAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        break;
      case '7d':
        timeAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '24h':
      default:
        timeAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        break;
    }

    // Build match criteria - show only unread emails from specified time period with summaries
    const matchCriteria = {
      userId: user._id,
      email: { $in: userEmails },
      read: false,
      timestamp: { $gte: timeAgo },
      'aiMeta.summary': { $exists: true, $ne: null, $ne: '' }
    };
    
    // If specific email is requested and it exists in user's accounts, filter by that email
    // Otherwise, use all user's email addresses
    if (targetEmail && userEmails.includes(targetEmail)) {
      matchCriteria.email = targetEmail;
    }
    
    // Add folder filter if provided and not 'all' or 'Inbox' (since Inbox is a display name, not folder ID)
    if (folderId && folderId !== 'all' && folderId !== 'Inbox') {
      matchCriteria.folder = folderId;
    }

    // Get unread emails from specified time period with summaries using aggregation for proper sorting
    const unreadEmails = await Email.aggregate([
      {
        $match: matchCriteria
      },
      {
        $sort: {
          timestamp: -1  // Sort by newest first
        }
      },
      {
        $limit: 20
      },
      {
        $project: {
          id: 1,
          subject: 1,
          from: 1,
          timestamp: 1,
          'aiMeta.priority': 1,
          'aiMeta.category': 1,
          'aiMeta.summary': 1,
          important: 1,
          flagged: 1
        }
      }
    ]);

    // Sanitize and format the email data
    const sanitizedEmails = unreadEmails.map(email => ({
      id: email.id || '',
      subject: email.subject || '(No Subject)',
      from: email.from || '',
      timestamp: email.timestamp ? email.timestamp.toISOString() : new Date().toISOString(),
      aiMeta: {
        priority: email.aiMeta?.priority || 'medium',
        category: email.aiMeta?.category || 'Other',
        summary: email.aiMeta?.summary || ''
      },
      important: Boolean(email.important),
      flagged: Boolean(email.flagged)
    }));

    res.json({
      success: true,
      data: {
        emails: sanitizedEmails,
        total: sanitizedEmails.length,
        lastUpdated: new Date().toISOString(),
        timePeriod: timePeriod
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
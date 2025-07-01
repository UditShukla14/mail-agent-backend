import Email from '../models/email.js';
import User from '../models/User.js';
import emailEnrichmentService from '../services/emailEnrichment.js';

export const getEmailStats = async (req, res) => {
  try {
    console.log('User from request:', req.user);
    console.log('Query parameters:', req.query);
    
    const { email: queryEmail, appUserId, folderId } = req.query;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    // Use the email from query params if provided, otherwise fall back to token email
    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId) {
      console.error('No user email or appUserId found in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log('Fetching stats for email:', targetEmail, 'appUserId:', targetAppUserId, 'folderId:', folderId);

    // Get user from database using appUserId (not email)
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      console.error('User not found in database for appUserId:', targetAppUserId);
      return res.status(401).json({ error: 'User not found' });
    }

    console.log('Fetching stats for user:', user._id, 'and email:', targetEmail, 'folderId:', folderId);
    
    // Build match criteria
    const matchCriteria = { 
      userId: user._id,
      email: targetEmail
    };
    
    // Add folder filter if provided
    if (folderId) {
      matchCriteria.folder = folderId;
      console.log('Filtering by folderId:', folderId);
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

    console.log('Stats result:', stats);
    
    // Log the actual stats being returned
    const finalStats = stats[0] || { total: 0, read: 0, important: 0, flagged: 0 };
    console.log('📊 Final stats being returned:', finalStats);
    
    res.json(finalStats);
  } catch (error) {
    console.error('Error fetching email stats:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

export const getEmailAnalytics = async (req, res) => {
  try {
    console.log('User from request:', req.user);
    console.log('Query parameters:', req.query);
    
    const { email: queryEmail, appUserId, folderId } = req.query;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    // Use the email from query params if provided, otherwise fall back to token email
    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId) {
      console.error('No user email or appUserId found in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log('Fetching analytics for email:', targetEmail, 'appUserId:', targetAppUserId, 'folderId:', folderId);

    // Get user from database using appUserId (not email)
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      console.error('User not found in database for appUserId:', targetAppUserId);
      return res.status(401).json({ error: 'User not found' });
    }

    console.log('Fetching analytics for user:', user._id, 'and email:', targetEmail, 'folderId:', folderId);

    // Build base match criteria
    const baseMatchCriteria = { 
      userId: user._id,
      email: targetEmail
    };
    
    // Add folder filter if provided
    if (folderId) {
      baseMatchCriteria.folder = folderId;
      console.log('Filtering analytics by folderId:', folderId);
    }

    // DEBUG: Check what folders exist in the database for this email
    const folderStats = await Email.aggregate([
      { 
        $match: { 
          userId: user._id,
          email: targetEmail
        } 
      },
      {
        $group: {
          _id: "$folder",
          count: { $sum: 1 }
        }
      }
    ]);
    console.log('📂 Available folders in database for', targetEmail, ':', folderStats);

    // First, check if we have any enriched emails for this specific email and folder
    const enrichedMatchCriteria = { ...baseMatchCriteria };
    if (folderId) {
      enrichedMatchCriteria.folder = folderId;
    }
    enrichedMatchCriteria['aiMeta.enrichedAt'] = { $exists: true };

    const enrichedCount = await Email.countDocuments(enrichedMatchCriteria);

    console.log('Enriched emails count for', targetEmail, 'folderId:', folderId, ':', enrichedCount);

    // If no enriched emails, trigger enrichment for all unenriched emails for this email and folder
    if (enrichedCount === 0) {
      console.log('No enriched emails found. Triggering enrichment process...');
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
        console.log(`Found ${unenrichedEmails.length} unenriched emails. Adding to enrichment queue...`);
        // Use the queue service instead of direct enrichment to prevent infinite loops
        const enrichmentQueueService = await import('../services/enrichmentQueueService.js');
        await enrichmentQueueService.default.addToQueue(unenrichedEmails);
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
    const categoriesMatchCriteria = { ...baseMatchCriteria };
    categoriesMatchCriteria['aiMeta.category'] = { $exists: true, $ne: null };

    const categories = await Email.aggregate([
      { 
        $match: categoriesMatchCriteria
      },
      {
        $group: {
          _id: "$aiMeta.category",
          value: { $sum: 1 },
          unreadCount: { $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] } }
        }
      },
      {
        $project: {
          name: "$_id",
          value: 1,
          unreadCount: 1,
          _id: 0
        }
      }
    ]);

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

    console.log('Analytics results for', targetEmail, 'folderId:', folderId, ':', {
      volumeOverTime: volumeOverTime.length,
      categories: categories.length,
      sentiment: sentiment.length,
      priority: priority.length,
      enrichedCount
    });

    // Log the actual data being returned
    console.log('📊 Categories data:', categories);
    console.log('📊 Sentiment data:', sentiment);
    console.log('📊 Priority data:', priority);
    console.log('📊 Volume over time data:', volumeOverTime);

    res.json({
      volumeOverTime: volumeOverTime.map(item => ({
        date: item._id,
        count: item.count
      })),
      categories,
      sentiment,
      priority,
      enrichedCount
    });
  } catch (error) {
    console.error('Error fetching email analytics:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

export const getUnreadEmailsSummary = async (req, res) => {
  try {
    console.log('User from request:', req.user);
    console.log('Query parameters:', req.query);
    
    const { email: queryEmail, appUserId, folderId, timePeriod = '24h' } = req.query;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    // Use the email from query params if provided, otherwise fall back to token email
    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId) {
      console.error('No user email or appUserId found in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log('Fetching unread emails summary for email:', targetEmail, 'appUserId:', targetAppUserId, 'folderId:', folderId, 'timePeriod:', timePeriod);

    // Get user from database using appUserId (not email)
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      console.error('User not found in database for appUserId:', targetAppUserId);
      return res.status(401).json({ error: 'User not found' });
    }

    console.log('Fetching unread emails summary for user:', user._id, 'and email:', targetEmail, 'folderId:', folderId, 'timePeriod:', timePeriod);

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
      email: targetEmail,
      read: false,
      timestamp: { $gte: timeAgo },
      'aiMeta.summary': { $exists: true, $ne: null, $ne: '' }
    };
    
    // Add folder filter if provided
    if (folderId) {
      matchCriteria.folder = folderId;
      console.log('Filtering unread emails by folderId:', folderId);
    }

    console.log('🔍 Unread emails match criteria:', JSON.stringify(matchCriteria, null, 2));
    console.log(`🕐 ${timePeriod} ago timestamp:`, timeAgo);

    // Debug: Check total unread emails without time filter
    const totalUnreadCount = await Email.countDocuments({
      userId: user._id,
      email: targetEmail,
      read: false
    });
    console.log('📧 Total unread emails (all time):', totalUnreadCount);

    // Debug: Check unread emails with summaries in specified time period
    const unreadWithSummaryCount = await Email.countDocuments({
      userId: user._id,
      email: targetEmail,
      read: false,
      timestamp: { $gte: timeAgo },
      'aiMeta.summary': { $exists: true, $ne: null, $ne: '' }
    });
    console.log(`📧 Unread emails with summaries in last ${timePeriod}:`, unreadWithSummaryCount);

    // Debug: Check all emails for this user/email to see the data structure
    const sampleEmails = await Email.find({
      userId: user._id,
      email: targetEmail
    }).limit(3);
    console.log('📧 Sample emails structure:', JSON.stringify(sampleEmails.map(e => ({
      id: e.id,
      read: e.read,
      timestamp: e.timestamp,
      folder: e.folder,
      subject: e.subject,
      hasSummary: !!e.aiMeta?.summary
    })), null, 2));

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

    console.log(`Found ${unreadEmails.length} unread emails from last ${timePeriod} for`, targetEmail, 'folderId:', folderId);

    // Log the actual data being returned
    console.log('📧 Unread emails data:', unreadEmails.map(email => ({
      id: email.id,
      subject: email.subject,
      from: email.from,
      timestamp: email.timestamp,
      priority: email.aiMeta?.priority,
      category: email.aiMeta?.category,
      hasSummary: !!email.aiMeta?.summary
    })));

    res.json({
      emails: unreadEmails,
      total: unreadEmails.length,
      lastUpdated: new Date().toISOString(),
      timePeriod: timePeriod
    });
  } catch (error) {
    console.error('Error fetching unread emails summary:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}; 
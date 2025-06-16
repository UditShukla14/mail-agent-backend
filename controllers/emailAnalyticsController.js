import Email from '../models/email.js';
import User from '../models/User.js';
import emailEnrichmentService from '../services/emailEnrichment.js';

export const getEmailStats = async (req, res) => {
  try {
    console.log('User from request:', req.user);
    const { email, appUserId } = req.user;

    if (!email || !appUserId) {
      console.error('No user email or appUserId found in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get user from database to get the correct MongoDB _id
    const user = await User.findOne({ email, appUserId });
    if (!user) {
      console.error('User not found in database');
      return res.status(401).json({ error: 'User not found' });
    }

    console.log('Fetching stats for user:', user._id);
    const stats = await Email.aggregate([
      { 
        $match: { 
          userId: user._id 
        } 
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
    res.json(stats[0] || { total: 0, read: 0, important: 0, flagged: 0 });
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
    const { email, appUserId } = req.user;

    if (!email || !appUserId) {
      console.error('No user email or appUserId found in request');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get user from database to get the correct MongoDB _id
    const user = await User.findOne({ email, appUserId });
    if (!user) {
      console.error('User not found in database');
      return res.status(401).json({ error: 'User not found' });
    }

    console.log('Fetching analytics for user:', user._id);

    // First, check if we have any enriched emails
    const enrichedCount = await Email.countDocuments({
      userId: user._id,
      'aiMeta.enrichedAt': { $exists: true }
    });

    console.log('Enriched emails count:', enrichedCount);

    // If no enriched emails, trigger enrichment for all unenriched emails
    if (enrichedCount === 0) {
      console.log('No enriched emails found. Triggering enrichment process...');
      const unenrichedEmails = await Email.find({
        userId: user._id,
        $or: [
          { 'aiMeta.enrichedAt': { $exists: false } },
          { 'aiMeta.enrichedAt': null }
        ]
      });

      if (unenrichedEmails.length > 0) {
        console.log(`Found ${unenrichedEmails.length} unenriched emails. Starting enrichment...`);
        await emailEnrichmentService.enrichBatch(unenrichedEmails);
      }
    }

    // Get volume over time (last 30 days)
    const volumeOverTime = await Email.aggregate([
      { 
        $match: { 
          userId: user._id 
        } 
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

    // Get categories distribution
    const categories = await Email.aggregate([
      { 
        $match: { 
          userId: user._id,
          'aiMeta.category': { $exists: true, $ne: null }
        } 
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

    // Get sentiment analysis
    const sentiment = await Email.aggregate([
      { 
        $match: { 
          userId: user._id,
          'aiMeta.sentiment': { $exists: true, $ne: null }
        } 
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

    // Get priority distribution
    const priority = await Email.aggregate([
      { 
        $match: { 
          userId: user._id,
          'aiMeta.priority': { $exists: true, $ne: null }
        } 
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

    console.log('Analytics results:', {
      volumeOverTime: volumeOverTime.length,
      categories: categories.length,
      sentiment: sentiment.length,
      priority: priority.length
    });

    res.json({
      volumeOverTime: volumeOverTime.map(item => ({
        date: item._id,
        count: item.count
      })),
      categories,
      sentiment,
      priority
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
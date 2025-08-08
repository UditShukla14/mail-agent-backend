import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';

export const getUnreadEmailsSummary = async (req, res) => {
  try {
    const { email: queryEmail, folderId, timePeriod = '24h' } = req.query;
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
    
    // Add folder filter if provided and not 'all'
    if (folderId && folderId !== 'all') {
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

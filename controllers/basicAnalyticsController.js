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

export const getEmailStats = async (req, res) => {
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
    if (targetEmail && userEmails.includes(targetEmail)) {
      matchCriteria.email = targetEmail;
    }
    
    // If folderId is provided, add it to the criteria
    if (folderId) {
      matchCriteria.folder = folderId;
    }

    // Get basic email statistics
    const totalEmails = await Email.countDocuments(matchCriteria);
    const readEmails = await Email.countDocuments({ ...matchCriteria, read: true });
    const importantEmails = await Email.countDocuments({ ...matchCriteria, important: true });
    const flaggedEmails = await Email.countDocuments({ ...matchCriteria, flagged: true });

    res.json({
      success: true,
      data: {
        total: totalEmails,
        read: readEmails,
        important: importantEmails,
        flagged: flaggedEmails
      }
    });
  } catch (error) {
    console.error('Error getting email stats:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get email statistics' 
    });
  }
};

// controllers/focusController.js
import EmailAccount from '../models/EmailAccount.js';
import Email from '../models/email.js';
import User from '../models/User.js';

// Generate a unique folder name for focus items
const generateFocusFolderName = (type, value) => {
  const sanitizedValue = value
    .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .toLowerCase()
    .substring(0, 30); // Limit length
  
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
  return `focus_${type}_${sanitizedValue}_${timestamp}`;
};

// Add a new focus item (subject or email)
export const addFocusItem = async (req, res) => {
  try {
    console.log('🔍 addFocusItem called with:', {
      body: req.body,
      user: req.user,
      extractedValue: req.body.value,
      valueType: typeof req.body.value
    });

    const { email: queryEmail, type, value } = req.body;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      console.error('❌ No worXstream user ID found');
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    if (!type || !value || !queryEmail) {
      return res.status(400).json({ 
        success: false,
        error: 'Email, type, and value are required' 
      });
    }

    if (!['subject', 'email'].includes(type)) {
      return res.status(400).json({ 
        success: false,
        error: 'Type must be either "subject" or "email"' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Get or create email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: queryEmail 
    });

    if (!emailAccount) {
      console.log('🆕 Creating new email account for:', queryEmail);
      emailAccount = new EmailAccount({
        userId: user._id,
        email: queryEmail,
        provider: 'outlook' // Default, can be updated later
      });
    }

    // Check if focus item already exists
    const existingFocusItem = emailAccount.focusedItems.find(
      item => item.type === type && item.value.toLowerCase() === value.toLowerCase()
    );

    if (existingFocusItem) {
      return res.status(400).json({ 
        success: false,
        error: 'Focus item already exists' 
      });
    }

    // Generate folder name
    const folderName = generateFocusFolderName(type, value);

    // Add focus item
    const newFocusItem = {
      type,
      value,
      folderName,
      createdAt: new Date(),
      lastActivity: new Date(),
      emailCount: 0,
      isActive: true
    };

    emailAccount.focusedItems.push(newFocusItem);
    await emailAccount.save();

    console.log('✅ Focus item added:', newFocusItem);

    // Update existing emails to assign them to this focus folder
    let query = { userId: user._id, email: queryEmail };
    
    if (type === 'subject') {
      // For subject focus, match emails with similar subjects
      query.subject = { $regex: value, $options: 'i' };
    } else if (type === 'email') {
      // For email focus, match emails from/to/cc/bcc that email address
      query.$or = [
        { from: { $regex: value, $options: 'i' } },
        { to: { $regex: value, $options: 'i' } },
        { cc: { $regex: value, $options: 'i' } },
        { bcc: { $regex: value, $options: 'i' } }
      ];
    }

    const updatedEmails = await Email.updateMany(
      query,
      { focusFolder: folderName }
    );

    // Update email count
    newFocusItem.emailCount = updatedEmails.modifiedCount;
    await emailAccount.save();

    console.log(`📧 Updated ${updatedEmails.modifiedCount} emails for focus folder: ${folderName}`);

    res.json({
      success: true,
      data: newFocusItem,
      emailsUpdated: updatedEmails.modifiedCount
    });
  } catch (error) {
    console.error('❌ Error in addFocusItem:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Remove a focus item
export const removeFocusItem = async (req, res) => {
  try {
    console.log('🗑️ removeFocusItem called with:', {
      params: req.params,
      body: req.body,
      user: req.user,
      folderNameFromParams: req.params.folderName,
      emailFromBody: req.body.email
    });

    const { folderName } = req.params;
    const { email: queryEmail } = req.body;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      console.error('❌ No worXstream user ID found');
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    if (!folderName || !queryEmail) {
      return res.status(400).json({ 
        success: false,
        error: 'Folder name and email are required' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Get email account
    const emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: queryEmail 
    });

    if (!emailAccount) {
      return res.status(404).json({ 
        success: false,
        error: 'Email account not found' 
      });
    }

    // Find and remove focus item
    const focusItemIndex = emailAccount.focusedItems.findIndex(
      item => item.folderName === folderName
    );

    if (focusItemIndex === -1) {
      return res.status(404).json({ 
        success: false,
        error: 'Focus item not found' 
      });
    }

    const removedFocusItem = emailAccount.focusedItems.splice(focusItemIndex, 1)[0];
    await emailAccount.save();

    // Remove focus folder from all emails
    const updatedEmails = await Email.updateMany(
      { userId: user._id, email: queryEmail, focusFolder: folderName },
      { $unset: { focusFolder: 1 } }
    );

    console.log(`📧 Removed focus folder from ${updatedEmails.modifiedCount} emails`);

    res.json({
      success: true,
      data: removedFocusItem,
      emailsUpdated: updatedEmails.modifiedCount
    });
  } catch (error) {
    console.error('❌ Error in removeFocusItem:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Get all focus items for an email account
export const getFocusItems = async (req, res) => {
  try {
    console.log('🔍 getFocusItems called with:', {
      query: req.query,
      user: req.user
    });

    const { email: queryEmail } = req.query;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      console.error('❌ No worXstream user ID found');
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    const targetEmail = queryEmail || req.user.email;

    if (!targetEmail) {
      console.error('❌ Missing email');
      return res.status(400).json({ 
        success: false,
        error: 'Email is required' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Get email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    if (!emailAccount) {
      console.log('🆕 Creating new email account for:', targetEmail);
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook' // Default, can be updated later
      });
      await emailAccount.save();
    }

    // Get email counts for each focus item
    const focusItemsWithCounts = await Promise.all(
      emailAccount.focusedItems.map(async (focusItem) => {
        const emailCount = await Email.countDocuments({
          userId: user._id,
          email: targetEmail,
          focusFolder: focusItem.folderName
        });

        return {
          ...focusItem.toObject(),
          emailCount
        };
      })
    );

    console.log('📋 Returning focus items:', focusItemsWithCounts.length, 'items');
    res.json({
      success: true,
      data: focusItemsWithCounts
    });
  } catch (error) {
    console.error('❌ Error in getFocusItems:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Get emails for a specific focus folder
export const getFocusFolderEmails = async (req, res) => {
  try {
    console.log('📧 getFocusFolderEmails called with:', {
      params: req.params,
      query: req.query,
      user: req.user
    });

    const { folderName } = req.params;
    const { email: queryEmail, page = 1, limit = 20 } = req.query;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      console.error('❌ No worXstream user ID found');
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    if (!folderName || !queryEmail) {
      return res.status(400).json({ 
        success: false,
        error: 'Folder name and email are required' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    // Get emails for the focus folder
    const emails = await Email.find({
      userId: user._id,
      email: queryEmail,
      focusFolder: folderName
    })
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limitNum)
    .select('-content'); // Exclude content for performance

    // Get total count
    const totalEmails = await Email.countDocuments({
      userId: user._id,
      email: queryEmail,
      focusFolder: folderName
    });

    console.log(`📧 Found ${emails.length} emails in focus folder: ${folderName}`);

    res.json({
      success: true,
      data: {
        emails,
        pagination: {
          page: parseInt(page),
          limit: limitNum,
          total: totalEmails,
          pages: Math.ceil(totalEmails / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('❌ Error in getFocusFolderEmails:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Update focus item activity (called when new emails arrive)
export const updateFocusItemActivity = async (userId, email, focusFolder) => {
  try {
    const emailAccount = await EmailAccount.findOne({ userId, email });
    if (!emailAccount) return;

    const focusItem = emailAccount.focusedItems.find(
      item => item.folderName === focusFolder
    );

    if (focusItem) {
      focusItem.lastActivity = new Date();
      focusItem.emailCount = await Email.countDocuments({
        userId,
        email,
        focusFolder
      });
      await emailAccount.save();
    }
  } catch (error) {
    console.error('❌ Error updating focus item activity:', error);
  }
};

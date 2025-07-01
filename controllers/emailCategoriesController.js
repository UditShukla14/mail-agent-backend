import EmailAccount from '../models/EmailAccount.js';
import User from '../models/User.js';

// Get categories for a specific email account
export const getEmailCategories = async (req, res) => {
  try {
    console.log('🔍 getEmailCategories called with:', {
      query: req.query,
      user: req.user
    });

    const { email: queryEmail, appUserId } = req.query;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    console.log('🎯 Target email and appUserId:', { targetEmail, targetAppUserId });

    if (!targetEmail || !targetAppUserId) {
      console.error('❌ Missing email or appUserId');
      return res.status(400).json({ error: 'Email and appUserId are required' });
    }

    // Get user
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      console.error('❌ User not found for appUserId:', targetAppUserId);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('✅ User found:', user._id);

    // Get or create email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    console.log('📧 Email account lookup result:', emailAccount ? 'Found' : 'Not found');

    if (!emailAccount) {
      console.log('🆕 Creating new email account for:', targetEmail);
      // Create new email account with default categories
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook' // Default, can be updated later
        // categories will use default from schema
      });
      await emailAccount.save();
      console.log('✅ New email account created with ID:', emailAccount._id);
    }

    console.log('📋 Returning categories:', emailAccount.categories.length, 'categories');
    res.json(emailAccount.categories);
  } catch (error) {
    console.error('❌ Error in getEmailCategories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update categories for a specific email account
export const updateEmailCategories = async (req, res) => {
  try {
    const { email: queryEmail, appUserId, categories } = req.body;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId || !categories) {
      return res.status(400).json({ error: 'Email, appUserId, and categories are required' });
    }

    // Get user
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get or create email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    if (!emailAccount) {
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook'
      });
    }

    // Update categories
    emailAccount.categories = categories;
    await emailAccount.save();

    res.json({ 
      message: 'Categories updated successfully',
      categories: emailAccount.categories 
    });
  } catch (error) {
    console.error('Error updating email categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add a new category to a specific email account
export const addEmailCategory = async (req, res) => {
  try {
    const { email: queryEmail, appUserId, category } = req.body;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId || !category) {
      return res.status(400).json({ error: 'Email, appUserId, and category are required' });
    }

    // Get user
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get or create email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    if (!emailAccount) {
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook'
      });
    }

    // Check if category name already exists
    const existingCategory = emailAccount.categories.find(cat => cat.name === category.name);
    if (existingCategory) {
      return res.status(400).json({ error: 'Category with this name already exists' });
    }

    // Add new category
    emailAccount.categories.push(category);
    await emailAccount.save();

    res.json({ 
      message: 'Category added successfully',
      categories: emailAccount.categories 
    });
  } catch (error) {
    console.error('Error adding email category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete a category from a specific email account
export const deleteEmailCategory = async (req, res) => {
  try {
    const { email: queryEmail, appUserId, categoryName } = req.params;
    const { email: tokenEmail, appUserId: tokenAppUserId } = req.user;

    const targetEmail = queryEmail || tokenEmail;
    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetEmail || !targetAppUserId || !categoryName) {
      return res.status(400).json({ error: 'Email, appUserId, and categoryName are required' });
    }

    // Get user
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get email account
    const emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    if (!emailAccount) {
      return res.status(404).json({ error: 'Email account not found' });
    }

    // Remove category
    emailAccount.categories = emailAccount.categories.filter(cat => cat.name !== categoryName);
    await emailAccount.save();

    res.json({ 
      message: 'Category deleted successfully',
      categories: emailAccount.categories 
    });
  } catch (error) {
    console.error('Error deleting email category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all email accounts for a user
export const getUserEmailAccounts = async (req, res) => {
  try {
    const { appUserId } = req.params;
    const { appUserId: tokenAppUserId } = req.user;

    const targetAppUserId = appUserId || tokenAppUserId;

    if (!targetAppUserId) {
      return res.status(400).json({ error: 'appUserId is required' });
    }

    // Get user
    const user = await User.findOne({ appUserId: targetAppUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get all email accounts for this user
    const emailAccounts = await EmailAccount.find({ 
      userId: user._id,
      isActive: true 
    });

    res.json(emailAccounts);
  } catch (error) {
    console.error('Error getting user email accounts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}; 
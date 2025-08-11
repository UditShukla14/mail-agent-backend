import EmailAccount from '../models/EmailAccount.js';
import User from '../models/User.js';

// Get categories for a specific email account
export const getEmailCategories = async (req, res) => {
  try {
    console.log('🔍 getEmailCategories called with:', {
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

    console.log('🎯 Target email and worxstreamUserId:', { targetEmail, worxstreamUserId });

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
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
      // Create new email account without categories - user must set them up
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook' // Default, can be updated later
        // categories will be empty - user must select them
      });
      await emailAccount.save();
      console.log('✅ New email account created with ID:', emailAccount._id);
    }

    console.log('📋 Returning categories:', emailAccount.categories.length, 'categories');
    res.json({
      success: true,
      data: emailAccount.categories
    });
  } catch (error) {
    console.error('❌ Error in getEmailCategories:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Update categories for a specific email account
export const updateEmailCategories = async (req, res) => {
  try {
    console.log('🔧 Backend: updateEmailCategories called with:', {
      body: req.body,
      user: req.user,
      headers: req.headers
    });

    const { email: queryEmail, categories } = req.body;
    const worxstreamUserId = req.user.id;

    console.log('🔧 Backend: Extracted data:', { queryEmail, categories, worxstreamUserId });

    if (!worxstreamUserId) {
      console.error('❌ Backend: No worXstream user ID found');
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    const targetEmail = queryEmail || req.user.email;

    if (!targetEmail || !categories) {
      console.error('❌ Backend: Missing required fields:', { targetEmail: !!targetEmail, categories: !!categories });
      return res.status(400).json({ 
        success: false,
        error: 'Email and categories are required' 
      });
    }

    console.log('🔧 Backend: Looking up user with worxstreamUserId:', worxstreamUserId);

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      console.error('❌ Backend: User not found for worxstreamUserId:', worxstreamUserId);
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    console.log('🔧 Backend: User found:', user._id);

    // Get or create email account
    let emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    console.log('🔧 Backend: Email account lookup result:', emailAccount ? 'Found' : 'Not found');

    if (!emailAccount) {
      console.log('🔧 Backend: Creating new email account for:', targetEmail);
      emailAccount = new EmailAccount({
        userId: user._id,
        email: targetEmail,
        provider: 'outlook'
        // categories will be empty - user must select them
      });
    }

    // Update categories
    console.log('🔧 Backend: Updating categories:', categories);
    emailAccount.categories = categories;
    await emailAccount.save();

    console.log('🔧 Backend: Categories updated successfully');

    res.json({ 
      success: true,
      message: 'Categories updated successfully',
      data: emailAccount.categories
    });
  } catch (error) {
    console.error('❌ Backend: Error updating email categories:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Add a new category to a specific email account
export const addEmailCategory = async (req, res) => {
  try {
    const { email: queryEmail, category } = req.body;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    const targetEmail = queryEmail || req.user.email;

    if (!targetEmail || !category) {
      return res.status(400).json({ 
        success: false,
        error: 'Email and category are required' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
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
        // categories will be empty - user must select them
      });
    }

    // Check if category name already exists
    const existingCategory = emailAccount.categories.find(cat => cat.name === category.name);
    if (existingCategory) {
      return res.status(400).json({ 
        success: false,
        error: 'Category with this name already exists' 
      });
    }

    // Add new category
    emailAccount.categories.push(category);
    await emailAccount.save();

    res.json({ 
      success: true,
      message: 'Category added successfully',
      data: emailAccount.categories 
    });
  } catch (error) {
    console.error('Error adding email category:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Delete a category from a specific email account
export const deleteEmailCategory = async (req, res) => {
  try {
    const { email: queryEmail, categoryName } = req.params;
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    const targetEmail = queryEmail || req.user.email;

    if (!targetEmail || !categoryName) {
      return res.status(400).json({ 
        success: false,
        error: 'Email and categoryName are required' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Get email account
    const emailAccount = await EmailAccount.findOne({ 
      userId: user._id, 
      email: targetEmail 
    });

    if (!emailAccount) {
      return res.status(404).json({ 
        success: false,
        error: 'Email account not found' 
      });
    }

    // Remove category
    emailAccount.categories = emailAccount.categories.filter(cat => cat.name !== categoryName);
    await emailAccount.save();

    res.json({ 
      success: true,
      message: 'Category deleted successfully',
      data: emailAccount.categories 
    });
  } catch (error) {
    console.error('Error deleting email category:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
};

// Get all email accounts for a user
export const getUserEmailAccounts = async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;

    if (!worxstreamUserId) {
      return res.status(401).json({ 
        success: false,
        error: 'User not authenticated' 
      });
    }

    // Get user
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Get all email accounts for this user
    const emailAccounts = await EmailAccount.find({ userId: user._id });

    const accounts = emailAccounts.map(account => ({
      email: account.email,
      provider: account.provider,
      categories: account.categories
    }));

    res.json({
      success: true,
      data: accounts
    });
  } catch (error) {
    console.error('Error getting user email accounts:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
}; 
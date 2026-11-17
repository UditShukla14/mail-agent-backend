// routes/account.js
import express from 'express';
import Token from '../models/Token.js';
import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { authenticateUser } from '../middleware/auth.js';
import { getUserTokens, deleteToken, refreshSpecificToken } from '../utils/tokenManager.js';
import { deleteMailSubscriptionForAccount } from '../services/outlookSubscriptionService.js';
import { debug } from '../utils/logger.js';

const router = express.Router();

// Get token for a specific email account
router.get('/token/:email', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const email = req.params.email;
    const provider = req.query.provider || 'outlook'; // Default to outlook
    
    debug(`🔍 Getting token for email: ${email}, user: ${worxstreamUserId}, provider: ${provider}`);
    
    // Get token from database
    const token = await getToken(worxstreamUserId, email, provider);
    
    if (!token) {
      return res.status(404).json({
        success: false,
        error: `No valid token found for email ${email}`,
        code: 'TOKEN_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      data: {
        email,
        provider,
        hasToken: true
      }
    });
  } catch (error) {
    console.error('Error getting token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get token',
      details: error.message
    });
  }
});

// Get all connected accounts for the authenticated user
router.get('/accounts', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const worxstreamUser = req.user;
    
    debug(`🔄 Getting accounts for worXstream user: ${worxstreamUserId} (${worxstreamUser.email})`);
    
    // Check if user exists in mail agent database
    let user = await User.findOne({ worxstreamUserId });
    
    if (!user) {
      debug(`📝 Creating new user in mail agent database for worXstream user: ${worxstreamUserId}`);
      
      // Create new user in mail agent database
      user = new User({
        worxstreamUserId: worxstreamUserId,
        name: worxstreamUser.name,
        email: worxstreamUser.email,
        emailVerifiedAt: worxstreamUser.email_verified_at ? new Date(worxstreamUser.email_verified_at) : null,
        status: worxstreamUser.status || '1',
        isAdmin: worxstreamUser.is_admin || false,
        createdAt: worxstreamUser.created_at ? new Date(worxstreamUser.created_at) : new Date(),
        updatedAt: worxstreamUser.updated_at ? new Date(worxstreamUser.updated_at) : new Date()
      });
      
      await user.save();
      debug(`✅ Created new user in mail agent database: ${user._id}`);
    } else {
      debug(`✅ Found existing user in mail agent database: ${user._id}`);
    }
    
    // Get email accounts from EmailAccount model (like original mail-agent)
    const emailAccounts = await EmailAccount.find({ userId: user._id });
    
    // Also get tokens to check if accounts are still connected
    const tokens = await getUserTokens(worxstreamUserId);
    const tokenMap = new Map(tokens.map(token => [token.email, token]));
    
    // Create EmailAccount records for any tokens that don't have them
    for (const token of tokens) {
      const existingAccount = emailAccounts.find(account => account.email === token.email);
      if (!existingAccount) {
        debug(`🔄 Creating missing EmailAccount record for ${token.email}`);
        try {
          const newEmailAccount = new EmailAccount({
            userId: user._id,
            email: token.email,
            provider: token.provider,
            isActive: true
          });
          await newEmailAccount.save();
          debug(`✅ Created EmailAccount record for ${token.email}`);
          emailAccounts.push(newEmailAccount);
        } catch (error) {
          console.error(`❌ Failed to create EmailAccount record for ${token.email}:`, error);
        }
      }
    }
    
    const accounts = emailAccounts.map(account => {
      const token = tokenMap.get(account.email);
      return {
        id: account._id.toString(),
        email: account.email,
        provider: account.provider,
        isActive: account.isActive,
        categories: account.categories,
        isExpired: token ? token.isExpired : true, // If no token, consider expired
        createdAt: account.createdAt,
        updatedAt: account.updatedAt
      };
    });
    
    debug(`📧 Found ${accounts.length} email accounts for user: ${worxstreamUserId}`);
    
    res.json({ 
      success: true,
      data: accounts,
      userExists: true
    });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch accounts',
      details: error.message 
    });
  }
});

// Refresh a specific token
router.post('/refresh-token', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email, provider = 'outlook' } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    debug(`🔄 Refreshing token for: ${email} (${provider}) for worXstream user: ${worxstreamUserId}`);

    const success = await refreshSpecificToken(worxstreamUserId, email, provider);
    
    if (success) {
      res.json({
        success: true,
        message: `Token refreshed successfully for ${email}`
      });
    } else {
      res.status(400).json({
        success: false,
        error: `Failed to refresh token for ${email}`
      });
    }
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh token',
      details: error.message
    });
  }
});

// Unlink an email account
router.delete('/unlink', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email, provider } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    debug(`🔄 Unlinking account: ${email} for worXstream user: ${worxstreamUserId}`);
    debug(`🔍 Request body:`, req.body);
    debug(`🔍 User ID type:`, typeof worxstreamUserId, 'Value:', worxstreamUserId);
    debug(`🔍 Email:`, email, 'Provider:', provider);

    // Find the user to get their MongoDB _id
    const user = await User.findOne({ worxstreamUserId });
    debug(`🔍 User lookup result:`, user ? 'Found' : 'Not found');
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Check what tokens exist for this user
    const userTokens = await getUserTokens(worxstreamUserId);
    debug(`🔍 Available tokens for user:`, userTokens.map(t => ({ email: t.email, provider: t.provider })));

    // Tear down Graph webhook subscription before deleting the token
    if (!provider || provider === 'outlook') {
      try {
        await deleteMailSubscriptionForAccount(worxstreamUserId, email);
      } catch (subErr) {
        console.warn(`⚠️ Graph subscription cleanup failed for ${email}:`, subErr.message);
      }
    }
    
    // Delete the token for this account
    const tokenDeleted = await deleteToken(worxstreamUserId, email, provider);
    debug(`🔍 Token deletion result:`, tokenDeleted);
    
    if (!tokenDeleted) {
      return res.status(404).json({ 
        success: false,
        error: 'Account not found or already unlinked' 
      });
    }

    // Delete all emails associated with this account
    const emailResult = await Email.deleteMany({ 
      userId: user._id, 
      email: email 
    });

    // Delete the EmailAccount record (which contains categories) for this account
    const emailAccountResult = await EmailAccount.deleteOne({ 
      userId: user._id, 
      email: email 
    });

    debug(`✅ Successfully unlinked account: ${email}`);
    debug(`📧 Deleted ${emailResult.deletedCount} emails for account: ${email}`);
    debug(`🏷️ Deleted ${emailAccountResult.deletedCount} email account record (with categories) for account: ${email}`);

    res.json({ 
      success: true, 
      message: 'Account unlinked successfully',
      deletedEmails: emailResult.deletedCount,
      deletedEmailAccount: emailAccountResult.deletedCount
    });

  } catch (error) {
    console.error('❌ Error unlinking account:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to unlink account',
      details: error.message 
    });
  }
});

export default router;

// routes/account.js
import express from 'express';
import Token from '../models/Token.js';
import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { authenticateUser } from '../middleware/auth.js';
import { getUserTokens, deleteToken } from '../utils/tokenManager.js';

const router = express.Router();

// Get all connected accounts for the authenticated user
router.get('/accounts', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const worxstreamUser = req.user;
    
    console.log(`🔄 Getting accounts for worXstream user: ${worxstreamUserId} (${worxstreamUser.email})`);
    console.log(`📋 Full user object:`, JSON.stringify(worxstreamUser, null, 2));
    
    // Check if user exists in mail agent database
    let user = await User.findOne({ worxstreamUserId });
    
    if (!user) {
      console.log(`📝 Creating new user in mail agent database for worXstream user: ${worxstreamUserId}`);
      
      // Create new user in mail agent database
      user = new User({
        worxstreamUserId: worxstreamUserId,
        name: worxstreamUser.name,
        email: worxstreamUser.email,
        email_verified_at: worxstreamUser.email_verified_at,
        status: worxstreamUser.status,
        is_admin: worxstreamUser.is_admin,
        created_at: worxstreamUser.created_at,
        updated_at: worxstreamUser.updated_at
      });
      
      await user.save();
      console.log(`✅ Created new user in mail agent database: ${user._id}`);
    } else {
      console.log(`✅ Found existing user in mail agent database: ${user._id}`);
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
        console.log(`🔄 Creating missing EmailAccount record for ${token.email}`);
        try {
          const newEmailAccount = new EmailAccount({
            userId: user._id,
            email: token.email,
            provider: token.provider,
            isActive: true
          });
          await newEmailAccount.save();
          console.log(`✅ Created EmailAccount record for ${token.email}`);
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
    
    console.log(`📧 Found ${accounts.length} email accounts for user: ${worxstreamUserId}`);
    
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

// Unlink an email account
router.delete('/unlink', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    console.log(`🔄 Unlinking account: ${email} for worXstream user: ${worxstreamUserId}`);

    // Find the user to get their MongoDB _id
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // Delete the token for this account
    const tokenDeleted = await deleteToken(worxstreamUserId, email);
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

    console.log(`✅ Successfully unlinked account: ${email}`);
    console.log(`📧 Deleted ${emailResult.deletedCount} emails for account: ${email}`);
    console.log(`🏷️ Deleted ${emailAccountResult.deletedCount} email account record (with categories) for account: ${email}`);

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

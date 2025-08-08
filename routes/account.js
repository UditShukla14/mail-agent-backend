// routes/account.js
import express from 'express';
import Token from '../models/Token.js';
import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { authenticateUser } from '../middleware/auth.js';
import { getToken, getUserTokens, deleteToken } from '../utils/tokenManager.js';
import { searchMessages as searchOutlookMessages } from '../services/outlookService.js';
import { searchMessages as searchGmailMessages } from '../services/gmailService.js';

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

// Search messages across email accounts
router.post('/search', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { query, email, folderId, page = 1, limit = 20 } = req.body;
    
    if (!query || !email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required parameters: query and email' 
      });
    }

    console.log(`🔍 Search request for user ${worxstreamUserId}, email: ${email}, query: "${query}"`);

    // Get user token for the specified email using getToken (same as other functions)
    let accessToken;
    let provider;
    
    // Try Outlook first
    accessToken = await getToken(worxstreamUserId, email, 'outlook');
    if (accessToken) {
      provider = 'outlook';
      console.log(`✅ Found Outlook token for ${email}, token length: ${accessToken.length}`);
    } else {
      // Try Gmail
      accessToken = await getToken(worxstreamUserId, email, 'gmail');
      if (accessToken) {
        provider = 'gmail';
        console.log(`✅ Found Gmail token for ${email}, token length: ${accessToken.length}`);
      } else {
        console.log(`❌ No token found for email: ${email}`);
        return res.status(404).json({ 
          success: false,
          error: 'Email account not found or not connected' 
        });
      }
    }

    let searchResult;
    
    console.log(`🔍 Calling search function for provider: ${provider}`);
    
    if (provider === 'outlook') {
      console.log(`📧 Searching Outlook with query: "${query}", limit: ${limit}`);
      searchResult = await searchOutlookMessages(
        accessToken, 
        query, 
        limit
      );
      console.log(`📧 Outlook search result:`, {
        messageCount: searchResult.messages.length,
        hasNextLink: !!searchResult.nextLink,
        totalCount: searchResult.totalCount
      });
    } else if (provider === 'gmail') {
      console.log(`📨 Searching Gmail with query: "${query}", folderId: ${folderId}, limit: ${limit}`);
      searchResult = await searchGmailMessages(
        accessToken, 
        query, 
        folderId, 
        limit
      );
      console.log(`📨 Gmail search result:`, {
        messageCount: searchResult.messages.length,
        hasNextLink: !!searchResult.nextLink,
        totalCount: searchResult.totalCount
      });
    } else {
      console.log(`❌ Unsupported provider: ${provider}`);
      return res.status(400).json({ 
        success: false,
        error: 'Unsupported email provider' 
      });
    }

    console.log(`✅ Search completed. Found ${searchResult.messages.length} messages`);

    res.json({
      success: true,
      data: {
        messages: searchResult.messages,
        nextLink: searchResult.nextLink,
        totalCount: searchResult.totalCount,
        query,
        email,
        folderId
      }
    });

  } catch (error) {
    console.error('❌ Error searching messages:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to search messages',
      details: error.message 
    });
  }
});

// Test getting recent emails (no search)
router.get('/test-emails', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    console.log(`🧪 Test getting recent emails for user ${worxstreamUserId}, email: ${email}`);

    // Get user token for the specified email using getToken (same as other functions)
    let accessToken;
    let provider;
    
    // Try Outlook first
    accessToken = await getToken(worxstreamUserId, email, 'outlook');
    if (accessToken) {
      provider = 'outlook';
      console.log(`✅ Found Outlook token for ${email}, token length: ${accessToken.length}`);
    } else {
      // Try Gmail
      accessToken = await getToken(worxstreamUserId, email, 'gmail');
      if (accessToken) {
        provider = 'gmail';
        console.log(`✅ Found Gmail token for ${email}, token length: ${accessToken.length}`);
      } else {
        console.log(`❌ No token found for email: ${email}`);
        return res.status(404).json({ 
          success: false,
          error: 'Email account not found or not connected' 
        });
      }
    }

    let result;
    
    if (provider === 'outlook') {
      const { getMessagesByFolder } = await import('../services/outlookService.js');
      result = await getMessagesByFolder(accessToken, 'inbox', null, 5);
    } else if (provider === 'gmail') {
      const { getMessagesByFolder } = await import('../services/gmailService.js');
      result = await getMessagesByFolder(accessToken, 'INBOX', null, 5);
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Unsupported email provider' 
      });
    }

    res.json({
      success: true,
      data: {
        provider: token.provider,
        email,
        result
      }
    });

  } catch (error) {
    console.error('❌ Error in test emails:', error);
    res.status(500).json({ 
      success: false,
      error: 'Test emails failed',
      details: error.message 
    });
  }
});

// Test search functionality
router.get('/test-search', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email, query = 'test' } = req.query;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    console.log(`🧪 Test search for user ${worxstreamUserId}, email: ${email}, query: "${query}"`);

    // Get user token for the specified email using getToken (same as other functions)
    let accessToken;
    let provider;
    
    // Try Outlook first
    accessToken = await getToken(worxstreamUserId, email, 'outlook');
    if (accessToken) {
      provider = 'outlook';
      console.log(`✅ Found Outlook token for ${email}, token length: ${accessToken.length}`);
    } else {
      // Try Gmail
      accessToken = await getToken(worxstreamUserId, email, 'gmail');
      if (accessToken) {
        provider = 'gmail';
        console.log(`✅ Found Gmail token for ${email}, token length: ${accessToken.length}`);
      } else {
        console.log(`❌ No token found for email: ${email}`);
        return res.status(404).json({ 
          success: false,
          error: 'Email account not found or not connected' 
        });
      }
    }

    let searchResult;
    
    if (provider === 'outlook') {
      searchResult = await searchOutlookMessages(accessToken, query, 5);
    } else if (provider === 'gmail') {
      searchResult = await searchGmailMessages(accessToken, query, null, 5);
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Unsupported email provider' 
      });
    }

    res.json({
      success: true,
      data: {
        provider: token.provider,
        query,
        email,
        result: searchResult
      }
    });

  } catch (error) {
    console.error('❌ Error in test search:', error);
    res.status(500).json({ 
      success: false,
      error: 'Test search failed',
      details: error.message 
    });
  }
});

// Get folders for a specific email account
router.get('/folders', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = req.user.id;
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing email parameter' 
      });
    }

    console.log(`📂 Getting folders for user ${worxstreamUserId}, email: ${email}`);

    // Get user token for the specified email using getToken (same as other functions)
    let accessToken;
    let provider;
    
    // Try Outlook first
    accessToken = await getToken(worxstreamUserId, email, 'outlook');
    if (accessToken) {
      provider = 'outlook';
      console.log(`✅ Found Outlook token for ${email}, token length: ${accessToken.length}`);
    } else {
      // Try Gmail
      accessToken = await getToken(worxstreamUserId, email, 'gmail');
      if (accessToken) {
        provider = 'gmail';
        console.log(`✅ Found Gmail token for ${email}, token length: ${accessToken.length}`);
      } else {
        console.log(`❌ No token found for email: ${email}`);
        return res.status(404).json({ 
          success: false,
          error: 'Email account not found or not connected' 
        });
      }
    }

    let folders;
    
    if (provider === 'outlook') {
      const { getMailFolders } = await import('../services/outlookService.js');
      folders = await getMailFolders(accessToken);
    } else if (provider === 'gmail') {
      const { getMailFolders } = await import('../services/gmailService.js');
      folders = await getMailFolders(accessToken);
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Unsupported email provider' 
      });
    }

    console.log(`✅ Retrieved ${folders.length} folders for ${email}`);

    res.json({
      success: true,
      data: folders
    });

  } catch (error) {
    console.error('❌ Error fetching folders:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch folders',
      details: error.message 
    });
  }
});

export default router;

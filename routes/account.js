// routes/account.js
import express from 'express';
import Token from '../models/Token.js';
import Email from '../models/email.js';
import User from '../models/User.js';

const router = express.Router();

router.get('/accounts', async (req, res) => {
  const { appUserId } = req.query;
  if (!appUserId) return res.status(400).json({ error: 'Missing appUserId' });

  const tokens = await Token.find({ appUserId });
  const accounts = tokens.map(token => ({
    email: token.email,
    provider: token.provider
  }));
  
  res.json({ accounts });
});

router.delete('/unlink', async (req, res) => {
  try {
    const { appUserId, email } = req.body;
    
    if (!appUserId || !email) {
      return res.status(400).json({ error: 'Missing appUserId or email' });
    }

    console.log(`🔄 Unlinking account: ${email} for user: ${appUserId}`);

    // Find the user to get their MongoDB _id
    const user = await User.findOne({ appUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete the token for this account
    const tokenResult = await Token.deleteOne({ appUserId, email });
    if (tokenResult.deletedCount === 0) {
      return res.status(404).json({ error: 'Account not found or already unlinked' });
    }

    // Delete all emails associated with this account
    const emailResult = await Email.deleteMany({ 
      userId: user._id, 
      email: email 
    });

    console.log(`✅ Successfully unlinked account: ${email}`);
    console.log(`📧 Deleted ${emailResult.deletedCount} emails for account: ${email}`);

    res.json({ 
      success: true, 
      message: 'Account unlinked successfully',
      deletedEmails: emailResult.deletedCount
    });

  } catch (error) {
    console.error('❌ Error unlinking account:', error);
    res.status(500).json({ 
      error: 'Failed to unlink account',
      details: error.message 
    });
  }
});

export default router;

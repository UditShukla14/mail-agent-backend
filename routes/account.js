// routes/account.js
import express from 'express';
import Token from '../models/Token.js';

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

export default router;

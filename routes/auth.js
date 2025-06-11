// routes/auth.js
import express from 'express';
import { outlookLogin, outlookRedirect, handleCallback } from '../controllers/authController.js';

const router = express.Router();

// 🌐 Outlook OAuth Flow
router.get('/outlook/login', outlookLogin);
router.get('/outlook/redirect', outlookRedirect);

// 🔄 OAuth Callback Handler
router.post('/callback', handleCallback);

export default router;

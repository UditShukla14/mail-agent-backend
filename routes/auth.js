// routes/auth.js
import express from 'express';
import { 
  outlookLogin, 
  outlookRedirect, 
  gmailLogin, 
  gmailRedirect, 
  handleCallback 
} from '../controllers/authController.js';

const router = express.Router();

// 🌐 Outlook OAuth Flow
router.get('/outlook/login', outlookLogin);
router.get('/outlook/redirect', outlookRedirect);

// 🌐 Gmail OAuth Flow
router.get('/gmail/login', gmailLogin);
router.get('/gmail/redirect', gmailRedirect);

// 🔄 OAuth Callback Handler
router.post('/callback', handleCallback);

export default router;

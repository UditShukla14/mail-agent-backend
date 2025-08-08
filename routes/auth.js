// routes/auth.js
import express from 'express';
import { 
  outlookLogin, 
  outlookRedirect, 
  gmailLogin, 
  gmailRedirect, 
  handleCallback 
} from '../controllers/authController.js';
import { authenticateUser, validateMailAccess } from '../middleware/auth.js';

const router = express.Router();

// OAuth login endpoints (require worXstream authentication)
router.get('/outlook/login', authenticateUser, validateMailAccess, outlookLogin);
router.get('/gmail/login', authenticateUser, validateMailAccess, gmailLogin);

// OAuth callback endpoints (no auth required as they're called by OAuth providers)
router.get('/outlook/redirect', outlookRedirect);
router.get('/gmail/redirect', gmailRedirect);

// Frontend callback verification (requires worXstream authentication)
router.post('/callback', authenticateUser, validateMailAccess, handleCallback);

export default router;

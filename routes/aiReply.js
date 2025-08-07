import express from 'express';
import { generateReply, generateComposeEmail, improveEmail } from '../controllers/aiReplyController.js';
import { authenticateUser, validateMailAccess } from '../middleware/auth.js';

const router = express.Router();

// Generate AI reply for existing email
router.post('/generate-reply', authenticateUser, validateMailAccess, generateReply);

// Generate AI compose email
router.post('/generate-compose', authenticateUser, validateMailAccess, generateComposeEmail);

// Improve existing email content
router.post('/improve-email', authenticateUser, validateMailAccess, improveEmail);

export default router; 
import express from 'express';
import { generateReply, generateComposeEmail, improveEmail } from '../controllers/aiReplyController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Generate AI reply for existing email
router.post('/generate-reply', authenticateUser, generateReply);

// Generate AI compose email
router.post('/generate-compose', authenticateUser, generateComposeEmail);

// Improve existing email content
router.post('/improve-email', authenticateUser, improveEmail);

export default router; 
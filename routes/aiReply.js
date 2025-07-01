import express from 'express';
import { generateReply, generateComposeEmail, improveEmail } from '../controllers/aiReplyController.js';

const router = express.Router();

// Generate AI reply for existing email
router.post('/generate-reply', generateReply);

// Generate AI compose email
router.post('/generate-compose', generateComposeEmail);

// Improve existing email content
router.post('/improve-email', improveEmail);

export default router; 
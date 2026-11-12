import express from 'express';
import { searchEmails, getEmailMessage } from '../controllers/emailSearchController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Read-only views of the signed-in user's stored mailbox (used by the worXstream AI agent).
router.get('/search', authenticateUser, searchEmails);
router.get('/:id', authenticateUser, getEmailMessage);

export default router;

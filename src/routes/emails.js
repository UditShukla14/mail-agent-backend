import express from 'express';
import { searchEmails, getEmailMessage, getConversation, listFolders, listAttachments, liveSearch, syncStatus } from '../controllers/emailSearchController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Read-only views of the signed-in user's stored mailbox (used by the worXstream AI agent).
router.get('/search', authenticateUser, searchEmails);
router.get('/live-search', authenticateUser, liveSearch);
router.get('/sync-status', authenticateUser, syncStatus);
router.get('/folders', authenticateUser, listFolders);
router.get('/conversation/:conversationId', authenticateUser, getConversation);
router.get('/:id/attachments', authenticateUser, listAttachments);
router.get('/:id', authenticateUser, getEmailMessage);

export default router;

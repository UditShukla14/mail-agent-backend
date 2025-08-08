// routes/emailSearch.js
import express from 'express';
import { searchEmails } from '../controllers/emailSearchController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Search emails endpoint (requires authentication)
router.get('/search', authenticateUser, searchEmails);

export default router;

import express from 'express';
import { getEmailAnalytics, getUnreadEmailsSummary } from '../controllers/emailAnalyticsController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Get detailed email analytics
router.get('/analytics', authenticateUser, getEmailAnalytics);

// Get unread emails summary from last 24 hours
router.get('/unread-summary', authenticateUser, getUnreadEmailsSummary);

export default router;

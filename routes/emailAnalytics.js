import express from 'express';
import { getEmailStats } from '../controllers/basicAnalyticsController.js';
import { getEmailAnalytics } from '../controllers/advancedAnalyticsController.js';
import { getUnreadEmailsSummary } from '../controllers/summaryAnalyticsController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Get email statistics
router.get('/stats', authenticateUser, getEmailStats);

// Get detailed email analytics
router.get('/analytics', authenticateUser, getEmailAnalytics);

// Get unread emails summary from last 24 hours
router.get('/unread-summary', authenticateUser, getUnreadEmailsSummary);

export default router; 
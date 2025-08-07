import express from 'express';
import { getEmailStats, getEmailAnalytics, getUnreadEmailsSummary } from '../controllers/emailAnalyticsController.js';
import { authenticateUser, validateMailAccess } from '../middleware/auth.js';

const router = express.Router();

// Get email statistics
router.get('/stats', authenticateUser, validateMailAccess, getEmailStats);

// Get detailed email analytics
router.get('/analytics', authenticateUser, validateMailAccess, getEmailAnalytics);

// Get unread emails summary from last 24 hours
router.get('/unread-summary', authenticateUser, validateMailAccess, getUnreadEmailsSummary);

export default router; 
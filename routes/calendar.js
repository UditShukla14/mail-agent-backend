import express from 'express';
import { 
  getCalendarEvents, 
  getMultiAccountCalendarEvents, 
  getStoredCalendarEvents,
  syncCalendarEvents
} from '../controllers/calendarController.js';
import { authenticateUser } from '../middleware/auth.js';
import Token from '../models/Token.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateUser);

/**
 * GET /calendar/events
 * Get calendar events for a specific email account
 * Query params: email, startDate (optional), endDate (optional)
 * Headers: x-access-token, x-provider (optional, defaults to outlook)
 */
router.get('/events', getCalendarEvents);

/**
 * POST /calendar/events/multi
 * Get calendar events for multiple email accounts
 * Body: { accounts: [{ email, accessToken, provider }], startDate (optional), endDate (optional) }
 */
router.post('/events/multi', getMultiAccountCalendarEvents);

/**
 * GET /calendar/events/stored
 * Get stored calendar events from database (without API calls)
 * Query params: email, startDate (optional), endDate (optional)
 */
router.get('/events/stored', getStoredCalendarEvents);

/**
 * POST /calendar/sync
 * Sync calendar events from email provider (Outlook/Gmail)
 * Query params: email, startDate (optional), endDate (optional)
 */
router.post('/sync', syncCalendarEvents);

/**
 * GET /calendar/debug/tokens
 * Debug endpoint to check what tokens exist for the authenticated user
 */
router.get('/debug/tokens', async (req, res) => {
  try {
    const { user } = req;
    
    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    const userTokens = await Token.find({ worxstreamUserId: user.id });
    
    res.json({
      success: true,
      data: {
        userId: user.id,
        totalTokens: userTokens.length,
        tokens: userTokens.map(t => ({
          email: t.email,
          provider: t.provider,
          hasAccessToken: !!t.access_token,
          hasRefreshToken: !!t.refresh_token,
          expiresIn: t.expires_in,
          timestamp: t.timestamp
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get token debug info',
      details: error.message
    });
  }
});

export default router;

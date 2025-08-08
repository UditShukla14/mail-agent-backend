import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import tokenRefreshService from '../services/tokenRefreshService.js';
import { refreshSpecificToken, getUserTokens } from '../utils/tokenManager.js';

const router = express.Router();

// Get token refresh service status
router.get('/status', authenticateUser, (req, res) => {
  try {
    const status = tokenRefreshService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Error getting token refresh status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get token refresh status'
    });
  }
});

// Manually trigger token refresh for all tokens
router.post('/refresh-all', authenticateUser, async (req, res) => {
  try {
    console.log('🔄 Manual token refresh triggered by user:', req.user.id);
    await tokenRefreshService.manualRefresh();
    
    res.json({
      success: true,
      message: 'Token refresh completed'
    });
  } catch (error) {
    console.error('Error during manual token refresh:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh tokens'
    });
  }
});

// Refresh a specific token
router.post('/refresh-specific', authenticateUser, async (req, res) => {
  try {
    const { email, provider } = req.body;
    const worxstreamUserId = Number(req.user.id);

    if (!email || !provider) {
      return res.status(400).json({
        success: false,
        error: 'Email and provider are required'
      });
    }

    console.log(`🔄 Manual token refresh for ${email} (${provider}) by user:`, worxstreamUserId);
    
    const success = await refreshSpecificToken(worxstreamUserId, email, provider);
    
    if (success) {
      res.json({
        success: true,
        message: `Token refreshed successfully for ${email}`
      });
    } else {
      res.status(400).json({
        success: false,
        error: `Failed to refresh token for ${email}`
      });
    }
  } catch (error) {
    console.error('Error refreshing specific token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh token'
    });
  }
});

// Get all tokens for the current user with refresh status
router.get('/tokens', authenticateUser, async (req, res) => {
  try {
    const worxstreamUserId = Number(req.user.id);
    const tokens = await getUserTokens(worxstreamUserId);
    
    res.json({
      success: true,
      data: tokens
    });
  } catch (error) {
    console.error('Error getting user tokens:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user tokens'
    });
  }
});

export default router;

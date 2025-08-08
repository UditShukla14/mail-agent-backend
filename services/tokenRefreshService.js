import Token from '../models/Token.js';
import EmailAccount from '../models/EmailAccount.js';
import { refreshToken } from '../utils/tokenManager.js';
import notificationService from './notificationService.js';

class TokenRefreshService {
  constructor() {
    this.isRunning = false;
    this.interval = null;
    this.checkInterval = 5 * 60 * 1000; // Check every 5 minutes
  }

  // Start the background token refresh service
  start() {
    if (this.isRunning) {
      console.log('🔄 Token refresh service is already running');
      return;
    }

    console.log('🚀 Starting token refresh service...');
    this.isRunning = true;

    // Run initial check
    this.checkAndRefreshTokens();

    // Set up periodic checks
    this.interval = setInterval(() => {
      this.checkAndRefreshTokens();
    }, this.checkInterval);
  }

  // Stop the background token refresh service
  stop() {
    if (!this.isRunning) {
      console.log('🔄 Token refresh service is not running');
      return;
    }

    console.log('🛑 Stopping token refresh service...');
    this.isRunning = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // Check and refresh expired tokens
  async checkAndRefreshTokens() {
    try {
      console.log('🔍 Checking for expired tokens...');
      
      // Find all tokens that are expired or will expire in the next 10 minutes
      const now = Date.now();
      const tenMinutesFromNow = now + 10 * 60 * 1000; // 10 minutes from now
      
      const expiredTokens = await Token.find({
        $expr: {
          $lt: [
            { $add: ['$timestamp', { $multiply: ['$expires_in', 1000] }] },
            tenMinutesFromNow
          ]
        }
      });

      console.log(`🔍 Found ${expiredTokens.length} expired or expiring tokens`);

      if (expiredTokens.length === 0) {
        console.log('✅ No tokens need refreshing');
        return;
      }

      // Refresh each expired token
      for (const token of expiredTokens) {
        try {
          console.log(`🔄 Refreshing token for ${token.email} (${token.provider})`);
          
          const refreshed = await refreshToken(token.refresh_token, token.provider);
          
          if (refreshed) {
            // Update the token in the database
            token.access_token = refreshed.access_token;
            token.refresh_token = refreshed.refresh_token;
            token.expires_in = refreshed.expires_in;
            token.timestamp = refreshed.timestamp;
            await token.save();
            
            console.log(`✅ Successfully refreshed token for ${token.email}`);
            
            // Notify user about successful refresh
            notificationService.notifyTokenRefreshed(token.worxstreamUserId, token.email, token.provider);
          } else {
            console.log(`❌ Failed to refresh token for ${token.email}`);
            
            // Mark the token as expired in the EmailAccount
            try {
              await EmailAccount.findOneAndUpdate(
                { email: token.email, provider: token.provider },
                { isExpired: true }
              );
              console.log(`⚠️ Marked ${token.email} as expired in EmailAccount`);
              
              // Notify user about failed refresh
              notificationService.notifyTokenRefreshFailed(token.worxstreamUserId, token.email, token.provider, new Error('Token refresh failed'));
            } catch (emailAccountError) {
              console.error(`❌ Failed to update EmailAccount for ${token.email}:`, emailAccountError);
            }
          }
        } catch (error) {
          console.error(`❌ Error refreshing token for ${token.email}:`, error);
        }
      }

      console.log('✅ Token refresh check completed');
    } catch (error) {
      console.error('❌ Error in token refresh service:', error);
    }
  }

  // Manually trigger a token refresh check
  async manualRefresh() {
    console.log('🔄 Manual token refresh triggered');
    await this.checkAndRefreshTokens();
  }

  // Get service status
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      lastCheck: this.lastCheck
    };
  }
}

// Create a singleton instance
const tokenRefreshService = new TokenRefreshService();

export default tokenRefreshService;

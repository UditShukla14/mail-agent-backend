import { Server } from 'socket.io';

class NotificationService {
  constructor() {
    this.io = null;
  }

  // Set the Socket.IO instance
  setIO(io) {
    this.io = io;
  }

  // Notify user about token expiration
  notifyTokenExpiration(worxstreamUserId, email, provider) {
    if (!this.io) {
      console.log('⚠️ Socket.IO not available for token expiration notification');
      return;
    }

    try {
      // Find the user's socket and send notification
      this.io.sockets.sockets.forEach((socket) => {
        if (socket.user && socket.user.id === worxstreamUserId) {
          socket.emit('token-expired', {
            email,
            provider,
            message: `Your ${provider} account (${email}) has expired. Please re-authenticate to continue using this account.`,
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`📢 Token expiration notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token expiration notification:', error);
    }
  }

  // Notify user about successful token refresh
  notifyTokenRefreshed(worxstreamUserId, email, provider) {
    if (!this.io) {
      console.log('⚠️ Socket.IO not available for token refresh notification');
      return;
    }

    try {
      // Find the user's socket and send notification
      this.io.sockets.sockets.forEach((socket) => {
        if (socket.user && socket.user.id === worxstreamUserId) {
          socket.emit('token-refreshed', {
            email,
            provider,
            message: `Your ${provider} account (${email}) has been refreshed successfully.`,
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`📢 Token refresh notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token refresh notification:', error);
    }
  }

  // Notify user about failed token refresh
  notifyTokenRefreshFailed(worxstreamUserId, email, provider, error) {
    if (!this.io) {
      console.log('⚠️ Socket.IO not available for token refresh failure notification');
      return;
    }

    try {
      // Find the user's socket and send notification
      this.io.sockets.sockets.forEach((socket) => {
        if (socket.user && socket.user.id === worxstreamUserId) {
          socket.emit('token-refresh-failed', {
            email,
            provider,
            message: `Failed to refresh your ${provider} account (${email}). Please re-authenticate.`,
            error: error?.message || 'Unknown error',
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`📢 Token refresh failure notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token refresh failure notification:', error);
    }
  }
}

// Create a singleton instance
const notificationService = new NotificationService();

export default notificationService;

import { Server } from 'socket.io';
import { debug } from '../utils/logger.js';

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
      debug('⚠️ Socket.IO not available for token expiration notification');
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

      debug(`📢 Token expiration notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token expiration notification:', error);
    }
  }

  // Notify user about successful token refresh
  notifyTokenRefreshed(worxstreamUserId, email, provider) {
    if (!this.io) {
      debug('⚠️ Socket.IO not available for token refresh notification');
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

      debug(`📢 Token refresh notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token refresh notification:', error);
    }
  }

  // Notify user about failed token refresh
  notifyTokenRefreshFailed(worxstreamUserId, email, provider, error) {
    if (!this.io) {
      debug('⚠️ Socket.IO not available for token refresh failure notification');
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

      debug(`📢 Token refresh failure notification sent to user ${worxstreamUserId} for ${email}`);
    } catch (error) {
      console.error('❌ Error sending token refresh failure notification:', error);
    }
  }

  matchesUser(socket, worxstreamUserId) {
    const target = String(worxstreamUserId);
    if (socket.worxstreamUserId != null && String(socket.worxstreamUserId) === target) {
      return true;
    }
    if (socket.user?.id != null && String(socket.user.id) === target) {
      return true;
    }
    return false;
  }

  // Notify connected clients about a newly arrived mail (Graph webhook)
  notifyNewMail(worxstreamUserId, email, message) {
    if (!this.io) {
      debug('⚠️ Socket.IO not available for new mail notification');
      return;
    }

    try {
      let emitted = 0;
      this.io.sockets.sockets.forEach((socket) => {
        if (this.matchesUser(socket, worxstreamUserId)) {
          socket.emit('mail:new', {
            email,
            provider: 'outlook',
            message: {
              id: message.id,
              from: message.from,
              to: message.to,
              subject: message.subject,
              preview: message.preview,
              timestamp: message.timestamp,
              read: message.read,
              folder: message.folder,
              important: message.important,
              flagged: message.flagged,
              conversationId: message.conversationId,
              hasAttachments: message.hasAttachments,
              isProcessed: message.isProcessed
            },
            timestamp: new Date().toISOString()
          });
          emitted += 1;
        }
      });

      console.log(`📢 mail:new emitted to ${emitted} socket(s) for user ${worxstreamUserId} (${email})`);
    } catch (error) {
      console.error('❌ Error sending new mail notification:', error);
    }
  }
}

// Create a singleton instance
const notificationService = new NotificationService();

export default notificationService;

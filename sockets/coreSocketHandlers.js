import { getToken, getUserTokens } from '../utils/tokenManager.js';
import { getMailFolders } from '../services/outlookService.js';
import emailEnrichmentService from '../services/emailEnrichment.js';

export const initCoreSocketHandlers = (socket, io) => {
  // Unified socket initialization - called when user logs into worXstream
  socket.on('unified:init', async ({ worxstreamUserId, userInfo }) => {
    try {
      // Store worxstreamUserId on socket for unified access
      socket.worxstreamUserId = worxstreamUserId;
      
      // Store user info for future reference
      socket.userInfo = userInfo;
      
      // Register this socket with the email enrichment service
      emailEnrichmentService.registerSocket(socket);
      
      console.log(`🔗 Unified socket initialized for user: ${worxstreamUserId}`);
      socket.emit('unified:connected', { status: 'connected', userId: worxstreamUserId });
    } catch (error) {
      console.error('❌ Error initializing unified socket:', error);
      socket.emit('unified:error', { message: 'Failed to initialize unified socket' });
    }
  });

  // Mail-specific initialization (for when user navigates to mail page)
  socket.on('mail:init', async ({ worxstreamUserId, email }) => {
    try {
      // Store worxstreamUserId on socket for later use
      socket.worxstreamUserId = worxstreamUserId;
    
      // Use the authenticated user's ID instead of the passed worxstreamUserId
      const userId = socket.user?.id || worxstreamUserId;
    
      const token = await getToken(userId, email, 'outlook');
      if (!token) {
        // Check if user has any connected accounts
        const userTokens = await getUserTokens(userId);
        if (userTokens.length === 0) {
          socket.emit('mail:error', 'No email accounts connected. Please connect your email account first.');
          return;
        } else {
          socket.emit('mail:error', `Email account ${email} not connected. Please connect this account or use a connected account.`);
          return;
        }
      }

      const folders = await getMailFolders(token);
      socket.emit('mail:folders', folders);
    } catch (error) {
      console.error('❌ Error in mail:init:', error);
      socket.emit('mail:error', 'Failed to initialize mail service');
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
};

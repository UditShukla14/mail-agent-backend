// sockets/mailSocket.js
import {
  getMailFolders,
  getMessagesByFolder,
  getMessageById,
  sendEmail,
  replyToEmail,
  replyAllToEmail,
  markMessageRead,
  markMessageImportant,
  deleteMessage
} from '../services/outlookService.js';

import { getToken, getUserTokens } from '../utils/tokenManager.js';
import User from '../models/User.js';
import Email from '../models/email.js';
import emailEnrichmentService from '../services/emailEnrichment.js';
import enrichmentQueueService from '../services/enrichmentQueueService.js';
import axios from 'axios';
import emailService from '../services/emailService.js';

export const initMailSocket = (socket, io) => {

  const folderPaginationMap = new Map();
  
  // Debounce mechanism to prevent rapid-fire requests
  const debounceMap = new Map();
  const DEBOUNCE_DELAY = 1000; // 1 second
  
  const debounce = (key, callback) => {
    if (debounceMap.has(key)) {
      clearTimeout(debounceMap.get(key));
    }
    debounceMap.set(key, setTimeout(() => {
      debounceMap.delete(key);
      callback();
    }, DEBOUNCE_DELAY));
  };

  // Unified socket initialization - called when user logs into worXstream
  socket.on('unified:init', async ({ worxstreamUserId, userInfo }) => {
    try {
      console.log('🔗 Unified socket initialization received:', { worxstreamUserId, userInfo });
      
      // Store worxstreamUserId on socket for unified access
      socket.worxstreamUserId = worxstreamUserId;
      
      // Store user info for future reference
      socket.userInfo = userInfo;
      
      // Register this socket with the email enrichment service
      emailEnrichmentService.registerSocket(socket);
      
      console.log(`🔗 Unified socket initialized for user: ${worxstreamUserId}`);
      socket.emit('unified:connected', { status: 'connected', userId: worxstreamUserId });
      console.log('📤 Sent unified:connected event');
    } catch (error) {
      console.error('❌ Error initializing unified socket:', error);
      socket.emit('unified:error', { message: 'Failed to initialize unified socket' });
    }
  });

  // Mail-specific initialization (for when user navigates to mail page)
  socket.on('mail:init', async ({ worxstreamUserId, email }) => {
    try {
      console.log('📧 Mail initialization for:', { worxstreamUserId, email });
      
      // Check if this user already has an active socket for this email
      const userSockets = Array.from(io.sockets.sockets.values()).filter(s => 
        s.worxstreamUserId === worxstreamUserId && s.id !== socket.id
      );
      
      if (userSockets.length > 0) {
        console.log(`🔄 User ${worxstreamUserId} already has ${userSockets.length} active socket(s), skipping duplicate initialization`);
        // Clean up old sockets
        userSockets.forEach(oldSocket => {
          console.log(`🧹 Cleaning up old socket: ${oldSocket.id}`);
          oldSocket.disconnect();
        });
      }
      
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

      // Register this socket with the enrichment service for this user
      emailEnrichmentService.registerSocket(socket);
      console.log('✅ Socket registered with enrichment service');

      const folders = await getMailFolders(token);
      socket.emit('mail:folders', folders);
      
      console.log('✅ Mail initialization completed');
    } catch (error) {
      console.error('❌ Error in mail:init:', error);
      socket.emit('mail:error', 'Failed to initialize mail service');
    }
  });

  // Test handler to verify socket communication
  socket.on('mail:test', (data) => {
    console.log('🧪 Test event received:', data);
    socket.emit('mail:testResponse', { 
      message: 'Test response from backend',
      timestamp: new Date().toISOString(),
      data: data
    });
    console.log('📤 Sent test response');
  });

  // New handler for enriching specific emails
  socket.on('mail:enrichEmails', async ({ worxstreamUserId, email, messageIds, forceReanalyze = false }) => {
    try {
      console.log('🔍 Enrichment request received:', { 
        worxstreamUserId, 
        email, 
        messageIds: messageIds.length, 
        forceReanalyze 
      });
      
      // Get the messages that need enrichment
      const messages = await Email.find({ id: { $in: messageIds } });
      
      console.log('📧 Found messages in database:', messages.length);
      
      if (messages.length === 0) {
        console.log('❌ No messages found for enrichment');
        return;
      }

      let messagesNeedingEnrichment;
      
      if (forceReanalyze) {
        // Force re-enrichment: process all messages regardless of current AI metadata
        console.log('🔄 Force re-enrichment requested - processing all messages');
        messagesNeedingEnrichment = messages;
        
        // Clear existing AI metadata for force re-enrichment
        await Email.updateMany(
          { id: { $in: messageIds } },
          { 
            $unset: { aiMeta: 1 },
            $set: { isProcessed: false, updatedAt: new Date() }
          }
        );
        console.log('🧹 Cleared existing AI metadata for force re-enrichment');
      } else {
        // Normal enrichment: only process messages without AI metadata
        messagesNeedingEnrichment = messages.filter(msg => !msg.aiMeta?.enrichedAt);
        console.log('📧 Messages needing enrichment:', messagesNeedingEnrichment.length);
      }
      
      if (messagesNeedingEnrichment.length > 0) {
        // Pass the socket instance directly to the enrichment queue service
        // This ensures we use the same socket that made the request
        await enrichmentQueueService.addToQueue(messagesNeedingEnrichment, socket);
        
        console.log('✅ Enrichment request queued successfully');
      } else {
        console.log('✅ All messages already enriched');
      }
    } catch (error) {
      console.error('❌ Error in mail:enrichEmails:', error);
      socket.emit('mail:error', 'Failed to start enrichment process');
    }
  });

  // 📥 INIT
      socket.on('mail:init', async ({ worxstreamUserId, email }) => {
      // Store worxstreamUserId on socket for later use
      socket.worxstreamUserId = worxstreamUserId;
    
    // Use the authenticated user's ID instead of the passed worxstreamUserId
    // Ensure we use the correct type (Number) for worxstreamUserId
    const userId = Number(socket.user?.id || worxstreamUserId);
    
    console.log('🔍 Debug: mail:init called with:', {
      passedWorxstreamUserId: worxstreamUserId,
      socketUserId: socket.user?.id,
      finalUserId: userId,
      email: email,
      socketUser: socket.user
    });
    
    // Check if the email has a valid token for this user
    const token = await getToken(userId, email, 'outlook');
    if (!token) {
      // Check if user has any connected accounts
      const userTokens = await getUserTokens(userId);
      if (userTokens.length === 0) {
        socket.emit('mail:error', 'No email accounts connected. Please connect your email account first.');
        return;
      } else {
        socket.emit('mail:error', `Email account ${email} is not connected or has expired. Available accounts: ${userTokens.map(t => t.email).join(', ')}`);
        return;
      }
    }

    const folders = await getMailFolders(token);
    socket.emit('mail:folders', folders);
  });

  // 📁 Load paginated folder messages
      socket.on('mail:getFolder', async ({ worxstreamUserId, email, folderId, page = 1, filters = {} }) => {
    console.log('📨 Received mail:getFolder event with filters:', { worxstreamUserId, email, folderId, page, filters });
    
    const debounceKey = `getFolder:${worxstreamUserId}:${email}:${folderId}:${page}:${JSON.stringify(filters)}`;
    
    debounce(debounceKey, async () => {
      try {
        // Use the authenticated user's ID instead of the passed worxstreamUserId
        // Ensure we use the correct type (Number) for worxstreamUserId
        const userId = Number(socket.user?.id || worxstreamUserId);
        
        console.log('🔍 Using emailService for filtered results');
        
        // Use the emailService which supports filtering
        const messages = await emailService.getFolderMessages(userId, email, folderId, page, 20, filters);
        
        // Get total count with filters for pagination
        const totalCount = await emailService.getFolderMessageCount(userId, email, folderId, filters);
        const hasMore = totalCount > page * 20;
        
        console.log(`📧 Found ${messages.length} messages matching filters, total: ${totalCount}`);

        // Emit messages immediately with database IDs
        const messagesWithDbId = messages.map(msg => ({
          ...msg.toObject(),
          dbId: msg._id.toString() // Include the MongoDB ObjectId as dbId
        }));
        
        socket.emit('mail:folderMessages', {
          folderId,
          page,
          messages: messagesWithDbId,
          nextLink: hasMore ? `page=${page + 1}` : null
        });

      } catch (error) {
        console.error('❌ Error in mail:getFolder:', error);
        socket.emit('mail:error', 'Failed to process folder request');
      }
    });
  });

  // 📧 Full message
  socket.on('mail:getMessage', async ({ worxstreamUserId, email, messageId }) => {
    console.log(`[Debug] Getting message ${messageId} for ${email}`);
    try {
      // Use emailService to get message with AI metadata combined
      const emailService = await import('../services/emailService.js');
      
      const message = await emailService.default.getMessage(worxstreamUserId, email, messageId);
      console.log('[Debug] Message details being sent:', {
        id: message.id,
        hasAttachments: message.attachments?.length > 0,
        attachmentCount: message.attachments?.length,
        hasAiMeta: !!message.aiMeta
      });

      if (message) {
        socket.emit('mail:message', message);
      } else {
        socket.emit('mail:error', 'Message not found');
      }
    } catch (error) {
      console.error('Failed to get message:', error);
      socket.emit('mail:error', error.message);
    }
  });

  // 📎 Get attachments separately
  socket.on('mail:getAttachments', async ({ worxstreamUserId, email, messageId }) => {
    console.log(`[Debug] Getting attachments for message ${messageId} for ${email}`);
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', 'Token not found');

      const { getAttachmentsByMessageId } = await import('../services/outlookService.js');
      const attachments = await getAttachmentsByMessageId(token, messageId);
      console.log('[Debug] Attachments being sent:', {
        messageId,
        attachmentCount: attachments.length,
        attachments: attachments.map(att => ({ name: att.name, contentId: att.contentId, isInline: att.isInline }))
      });

      socket.emit('mail:attachments', { messageId, attachments });
    } catch (error) {
      console.error('Failed to get attachments:', error);
      socket.emit('mail:error', error.message);
    }
  });

  // 📤 Send email
  socket.on('mail:send', async ({ worxstreamUserId, email, to, subject, body, cc, bcc }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return socket.emit('mail:error', 'Token not found');

    const result = await sendEmail(token, { to, subject, body, cc, bcc });
    socket.emit('mail:sent', result);
  });

  // 📧 Reply to email
  socket.on('mail:reply', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      console.log(`📧 Reply requested for message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      const result = await replyToEmail(token, { 
        messageId, 
        comment, 
        toRecipients, 
        ccRecipients, 
        bccRecipients 
      });

      if (result.success) {
        console.log(`✅ Reply sent successfully for message ${messageId}`);
        socket.emit('mail:replied', { messageId, success: true });
      } else {
        console.error(`❌ Failed to send reply for message ${messageId}:`, result.error);
        socket.emit('mail:error', `Failed to send reply: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error in mail:reply:', error);
      socket.emit('mail:error', 'Failed to send reply: ' + error.message);
    }
  });

  // 📧 Reply all to email
  socket.on('mail:replyAll', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      console.log(`📧 Reply all requested for message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      const result = await replyAllToEmail(token, { 
        messageId, 
        comment, 
        toRecipients, 
        ccRecipients, 
        bccRecipients 
      });

      if (result.success) {
        console.log(`✅ Reply all sent successfully for message ${messageId}`);
        socket.emit('mail:repliedAll', { messageId, success: true });
      } else {
        console.error(`❌ Failed to send reply all for message ${messageId}:`, result.error);
        socket.emit('mail:error', `Failed to send reply all: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error in mail:replyAll:', error);
      socket.emit('mail:error', 'Failed to send reply all: ' + error.message);
    }
  });

  // ✅ Mark as read
  socket.on('mail:markRead', async ({ worxstreamUserId, email, messageId }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageRead(token, messageId);
      socket.emit('mail:markedRead', { messageId });
    } catch {
      socket.emit('mail:error', 'Failed to mark as read');
    }
  });

  // ⭐ Mark as important
  socket.on('mail:markImportant', async ({ worxstreamUserId, email, messageId, flag }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageImportant(token, messageId, flag);
      socket.emit('mail:importantMarked', { messageId, flag });
    } catch {
      socket.emit('mail:error', 'Failed to update importance');
    }
  });

  // 🔄 Retry enrichment
  socket.on('mail:retryEnrichment', async ({ worxstreamUserId, email, messageId }) => {
    console.log('🔄 Retry enrichment requested for:', { worxstreamUserId, email, messageId });
    try {
      const emailDoc = await Email.findOne({ id: messageId, email: email });
      if (!emailDoc) {
        console.error('❌ Email not found:', messageId);
        socket.emit('mail:error', 'Email not found');
        return;
      }
      console.log('📧 Found email document:', emailDoc._id);

      // Reset enrichment status and force reprocessing
      await Email.findByIdAndUpdate(emailDoc._id, {
        'aiMeta.summary': 'Analyzing...',
        'aiMeta.error': null,
        'aiMeta.enrichedAt': null,
        isProcessed: false
      });
      console.log('✅ Reset enrichment status');

      // Get user to get worxstreamUserId
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error('❌ User not found:', worxstreamUserId);
        socket.emit('mail:error', 'User not found');
        return;
      }

      // Get fresh message content
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const message = await getMessageById(token, messageId);
      if (!message) {
        console.error('❌ Message not found:', messageId);
        socket.emit('mail:error', 'Message not found');
        return;
      }

      // Update email with fresh content
      const updatedEmail = await Email.findByIdAndUpdate(
        emailDoc._id,
        {
          $set: {
            ...message,
            userId: user._id,
            email: email,
            isProcessed: false
          }
        },
        { new: true }
      );

      // Start enrichment
      console.log('🚀 Starting enrichment process');
      await emailEnrichmentService.enrichEmail(updatedEmail, true); // Pass true to force reprocessing
      console.log('✅ Enrichment process completed');
    } catch (error) {
      console.error('❌ Failed to retry enrichment:', error);
      socket.emit('mail:error', 'Failed to retry enrichment: ' + error.message);
    }
  });

  // 🗑️ Delete message
  socket.on('mail:delete', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log('🗑️ Delete message requested:', { worxstreamUserId, email, messageId });
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      // Delete from Outlook
      const success = await deleteMessage(token, messageId);
      if (!success) {
        throw new Error('Failed to delete message from Outlook');
      }

      // Delete from our database and update counts
      await emailService.deleteMessage(worxstreamUserId, email, messageId);
      console.log('✅ Message deleted successfully:', messageId);

      // Notify client of successful deletion
      socket.emit('mail:deleted', { messageId });
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('mail:error', 'Failed to delete message: ' + error.message);
    }
  });

  // 🏷️ Update email category
  socket.on('mail:updateCategory', async ({ worxstreamUserId, email, messageId, category }) => {
    try {
      console.log('🏷️ Update category requested:', { worxstreamUserId, email, messageId, category });
      
      // Get user to verify they exist
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error('❌ User not found:', worxstreamUserId);
        return socket.emit('mail:error', 'User not found');
      }

      // Find the email document
      const emailDoc = await Email.findOne({ id: messageId, email: email });
      if (!emailDoc) {
        console.error('❌ Email not found:', messageId);
        return socket.emit('mail:error', 'Email not found');
      }

      // Update the category in the database
      const updatedEmail = await Email.findByIdAndUpdate(
        emailDoc._id,
        {
          $set: {
            'aiMeta.category': category,
            updatedAt: new Date()
          }
        },
        { new: true }
      );

      console.log('✅ Category updated successfully:', { messageId, category });

      // Emit success event back to client
      socket.emit('mail:categoryUpdated', { 
        messageId, 
        category,
        aiMeta: updatedEmail.aiMeta 
      });

      // Emit analytics refresh event to update dashboard widgets
      socket.emit('mail:analyticsRefresh', {
        messageId,
        category,
        email: email,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error updating category:', error);
      socket.emit('mail:error', 'Failed to update category: ' + error.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Mail socket disconnected: ${socket.id}`);
  });
};

// 🔁 Email fetch in date range
async function fetchEmailsInRange(token, startDate, endDate) {
  const startISO = new Date(startDate).toISOString();
  const endISO = new Date(endDate).toISOString();
  const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${startISO} and receivedDateTime le ${endISO}&$orderby=receivedDateTime desc&$top=50`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data.value.map(msg => ({
    id: msg.id,
    from: `${msg.from?.emailAddress?.name || ''} <${msg.from?.emailAddress?.address || ''}>`,
    subject: msg.subject || '(No Subject)',
    preview: msg.bodyPreview,
    content: msg.body?.content || '',
    timestamp: msg.receivedDateTime,
    read: msg.isRead,
    folder: 'Inbox',
    important: msg.importance === 'high',
    flagged: msg.flag?.flagStatus === 'flagged'
  }));
}

// sockets/mailSocket.js
import {
  getMailFolders,
  getMessagesByFolder,
  getMessageById,
  sendEmail,
  markMessageRead,
  markMessageImportant
} from '../services/outlookService.js';

import { getToken } from '../utils/tokenManager.js';
import User from '../models/User.js';
import Email from '../models/email.js';
import emailEnrichmentService from '../services/emailEnrichment.js';
import enrichmentQueueService from '../services/enrichmentQueueService.js';
import axios from 'axios';

export const initMailSocket = (socket, io) => {
  console.log(`📬 Mail socket connected: ${socket.id}`);

  const folderPaginationMap = new Map();

  // 📥 INIT
  socket.on('mail:init', async ({ appUserId, email }) => {
    const token = await getToken(appUserId, email, 'outlook');
    if (!token) return socket.emit('mail:error', 'Token not found');

    const folders = await getMailFolders(token);
    socket.emit('mail:folders', folders);
  });

  // 📁 Load paginated folder messages
  socket.on('mail:getFolder', async ({ appUserId, email, folderId, page = 1 }) => {
    try {
      console.log(`📨 Processing folder request for ${email} in folder ${folderId}`);
      
      const token = await getToken(appUserId, email, 'outlook');
      if (!token) {
        console.error(`❌ Token not found for ${email}`);
        return socket.emit('mail:error', 'Token not found');
      }

      const key = `${socket.id}-${folderId}`;
      if (page === 1) folderPaginationMap.delete(key);
      const nextLink = page === 1 ? null : folderPaginationMap.get(key);

      const { messages, nextLink: newNextLink } = await getMessagesByFolder(token, folderId, nextLink);
      if (newNextLink) folderPaginationMap.set(key, newNextLink);

      // Get user from database
      const user = await User.findOne({ appUserId });
      if (!user) {
        console.error(`❌ User not found for appUserId: ${appUserId}`);
        socket.emit('mail:error', 'User not found');
        return;
      }

      console.log(`💾 Saving ${messages.length} messages to database`);

      // Save messages to database with proper validation
      const savedMessages = await Promise.all(messages.map(async msg => {
        try {
          // Ensure all required fields are present
          const emailData = {
            id: msg.id,
            userId: user._id,
            email: email,
            from: msg.from || '',
            subject: msg.subject || '(No Subject)',
            content: msg.content || '',
            preview: msg.preview || '',
            timestamp: msg.timestamp || new Date(),
            read: msg.read || false,
            folder: folderId,
            important: msg.important || false,
            flagged: msg.flagged || false,
            isProcessed: false,
            updatedAt: new Date()
          };

          // Validate required fields
          if (!emailData.id || !emailData.userId || !emailData.email) {
            console.error('❌ Message missing required fields:', {
              id: emailData.id,
              hasUserId: !!emailData.userId,
              email: emailData.email
            });
            return null;
          }

          const savedMsg = await Email.findOneAndUpdate(
            { id: msg.id },
            { $set: emailData },
            { 
              upsert: true, 
              new: true,
              setDefaultsOnInsert: true
            }
          );

          console.log(`✅ Saved message ${msg.id}`);
          return savedMsg;
        } catch (error) {
          console.error(`❌ Failed to save message ${msg.id}:`, error);
          return null;
        }
      }));

      const validMessages = savedMessages.filter(Boolean);
      console.log(`✅ Successfully saved ${validMessages.length} messages`);

      // Emit messages immediately
      socket.emit('mail:folderMessages', {
        folderId,
        page,
        messages: validMessages,
        nextLink: newNextLink
      });

      // Start enrichment in background
      if (validMessages.length > 0) {
        try {
          console.log(`🔄 Starting enrichment for ${validMessages.length} messages`);
          await emailEnrichmentService.enrichBatch(validMessages, socket);
        } catch (error) {
          console.error('❌ Failed to start enrichment process:', error);
          socket.emit('mail:error', 'Failed to start enrichment process');
        }
      }
    } catch (error) {
      console.error('❌ Error in mail:getFolder:', error);
      socket.emit('mail:error', 'Failed to process folder request');
    }
  });

  // 📧 Full message
  socket.on('mail:getMessage', async ({ appUserId, email, messageId }) => {
    const token = await getToken(appUserId, email, 'outlook');
    if (!token) return socket.emit('mail:error', 'Token not found');

    const message = await getMessageById(token, messageId);
    if (message) {
      // Get user from database
      const user = await User.findOne({ appUserId });
      if (!user) {
        socket.emit('mail:error', 'User not found');
        return;
      }

      // Save or update message in database
      const savedMessage = await Email.findOneAndUpdate(
        { id: message.id },
        { 
          $set: {
            ...message,
            userId: user._id,
            email: email
          }
        },
        { upsert: true, new: true }
      );

      socket.emit('mail:message', savedMessage);
      
      // Start enrichment in background
      try {
        await emailEnrichmentService.enrichEmail(savedMessage);
      } catch (error) {
        console.error('Failed to enrich message:', error);
        socket.emit('mail:error', 'Failed to enrich message');
      }
    } else {
      socket.emit('mail:error', 'Message not found');
    }
  });

  // 📤 Send email
  socket.on('mail:send', async ({ appUserId, email, to, subject, body, cc, bcc }) => {
    const token = await getToken(appUserId, email, 'outlook');
    if (!token) return socket.emit('mail:error', 'Token not found');

    const result = await sendEmail(token, { to, subject, body, cc, bcc });
    socket.emit('mail:sent', result);
  });

  // ✅ Mark as read
  socket.on('mail:markRead', async ({ appUserId, email, messageId }) => {
    const token = await getToken(appUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageRead(token, messageId);
      socket.emit('mail:markedRead', messageId);
    } catch {
      socket.emit('mail:error', 'Failed to mark as read');
    }
  });

  // ⭐ Mark as important
  socket.on('mail:markImportant', async ({ appUserId, email, messageId, flag }) => {
    const token = await getToken(appUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageImportant(token, messageId, flag);
      socket.emit('mail:importantMarked', { messageId, flag });
    } catch {
      socket.emit('mail:error', 'Failed to update importance');
    }
  });

  // 🔄 Retry enrichment
  socket.on('mail:retryEnrichment', async ({ appUserId, email, messageId }) => {
    console.log('🔄 Retry enrichment requested for:', { appUserId, email, messageId });
    try {
      const emailDoc = await Email.findOne({ id: messageId });
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

      // Get user to get appUserId
      const user = await User.findOne({ appUserId });
      if (!user) {
        console.error('❌ User not found:', appUserId);
        socket.emit('mail:error', 'User not found');
        return;
      }

      // Get fresh message content
      const token = await getToken(appUserId, email, 'outlook');
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

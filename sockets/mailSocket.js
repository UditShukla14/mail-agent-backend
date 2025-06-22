// sockets/mailSocket.js
import {
  getMailFolders,
  getMessagesByFolder,
  getMessageById,
  sendEmail,
  markMessageRead,
  markMessageImportant,
  deleteMessage
} from '../services/outlookService.js';

import { getToken } from '../utils/tokenManager.js';
import User from '../models/User.js';
import Email from '../models/email.js';
import emailEnrichmentService from '../services/emailEnrichment.js';
import enrichmentQueueService from '../services/enrichmentQueueService.js';
import axios from 'axios';
import emailService from '../services/emailService.js';
import { Server } from 'socket.io';

export const initMailSocket = (socket, io) => {
  console.log(`📬 Mail socket connected: ${socket.id}`);

  const folderPaginationMap = new Map();

  // Handle real-time enrichment updates
  socket.on('mail:enrichmentUpdate', (data) => {
    // Broadcast the update to all connected clients
    io.emit('mail:enrichmentUpdate', data);
  });

  // New handler for enriching specific emails
  socket.on('mail:enrichEmails', async ({ appUserId, email, messageIds }) => {
    try {
      console.log('🔄 Enrichment requested for messages:', messageIds);
      
      // Get the messages that need enrichment
      const messages = await Email.find({ id: { $in: messageIds } });
      
      if (messages.length === 0) {
        console.log('❌ No messages found for enrichment');
        return;
      }

      // Filter out already enriched messages
      const messagesNeedingEnrichment = messages.filter(msg => !msg.aiMeta?.enrichedAt);
      
      if (messagesNeedingEnrichment.length > 0) {
        console.log(`🔄 Starting enrichment for ${messagesNeedingEnrichment.length} messages`);
        await enrichmentQueueService.addToQueue(messagesNeedingEnrichment);
      } else {
        console.log('✅ All messages are already enriched');
      }
    } catch (error) {
      console.error('❌ Error in mail:enrichEmails:', error);
      socket.emit('mail:error', 'Failed to start enrichment process');
    }
  });

  // 📥 INIT
  socket.on('mail:init', async ({ appUserId, email }) => {
    // Store appUserId on socket for later use
    socket.appUserId = appUserId;
    
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

      console.log(`🔄 Processing ${messages.length} messages`);

      // Process messages efficiently
      const savedMessages = await Promise.all(messages.map(async msg => {
        try {
          // First check if message exists and get its current state
          const existingMessage = await Email.findOne({ id: msg.id });
          
          // If message exists and hasn't changed, return it
          if (existingMessage && 
              existingMessage.subject === (msg.subject || '(No Subject)') &&
              existingMessage.from === (msg.from || '') &&
              existingMessage.preview === (msg.preview || '') &&
              existingMessage.read === (msg.read || false) &&
              existingMessage.important === (msg.important || false) &&
              existingMessage.flagged === (msg.flagged || false)) {
            console.log(`⏭️ Skipping unchanged message ${msg.id}`);
            return existingMessage;
          }

          // Message is new or has changed, prepare update data
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
            isProcessed: existingMessage?.isProcessed || false,
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

          // Only update if message is new or has changed
          const savedMsg = await Email.findOneAndUpdate(
            { id: msg.id },
            { $set: emailData },
            { 
              upsert: true, 
              new: true,
              setDefaultsOnInsert: true
            }
          );

          console.log(`✅ ${existingMessage ? 'Updated' : 'Saved new'} message ${msg.id}`);
          return savedMsg;
        } catch (error) {
          console.error(`❌ Failed to save message ${msg.id}:`, error);
          return null;
        }
      }));

      const validMessages = savedMessages.filter(Boolean);
      console.log(`✅ Successfully processed ${validMessages.length} messages`);

      // Emit messages immediately
      socket.emit('mail:folderMessages', {
        folderId,
        page,
        messages: validMessages,
        nextLink: newNextLink
      });

      // Remove automatic enrichment for all messages
      // Enrichment will now only happen when specifically requested from enriched email list
    } catch (error) {
      console.error('❌ Error in mail:getFolder:', error);
      socket.emit('mail:error', 'Failed to process folder request');
    }
  });

  // 📧 Full message
  socket.on('mail:getMessage', async ({ appUserId, email, messageId }) => {
    console.log(`[Debug] Getting message ${messageId} for ${email}`);
    try {
      const token = await getToken(appUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', 'Token not found');

      const message = await getMessageById(token, messageId);
      console.log('[Debug] Message details being sent:', {
        id: message.id,
        hasAttachments: message.attachments?.length > 0,
        attachmentCount: message.attachments?.length
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

  // 🗑️ Delete message
  socket.on('mail:delete', async ({ appUserId, email, messageId }) => {
    try {
      console.log('🗑️ Delete message requested:', { appUserId, email, messageId });
      
      const token = await getToken(appUserId, email, 'outlook');
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
      await emailService.deleteMessage(appUserId, email, messageId);
      console.log('✅ Message deleted successfully:', messageId);

      // Notify client of successful deletion
      socket.emit('mail:deleted', { messageId });
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('mail:error', 'Failed to delete message: ' + error.message);
    }
  });

  // 🏷️ Update email category
  socket.on('mail:updateCategory', async ({ appUserId, email, messageId, category }) => {
    try {
      console.log('🏷️ Update category requested:', { appUserId, email, messageId, category });
      
      // Get user to verify they exist
      const user = await User.findOne({ appUserId });
      if (!user) {
        console.error('❌ User not found:', appUserId);
        return socket.emit('mail:error', 'User not found');
      }

      // Find the email document
      const emailDoc = await Email.findOne({ id: messageId, userId: user._id });
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

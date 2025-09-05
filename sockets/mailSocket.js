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
        
        console.log('🔍 Loading emails with filters:', filters);
        
        // For page 1, try to get messages from database with filters first
        let messages = [];
        let hasMore = false;
        
        if (page === 1) {
          // First page: try database with filters, then fetch from Outlook if needed
          messages = await emailService.getFolderMessages(userId, email, folderId, page, 20, filters);
          
          // If we don't have enough messages in database, fetch from Outlook
          if (messages.length < 20) {
            console.log('📥 Not enough messages in database, fetching from Outlook...');
            
            const token = await getToken(userId, email, 'outlook');
            if (token) {
              const key = `${socket.id}-${folderId}`;
              const nextLink = folderPaginationMap.get(key);
              
              const { messages: outlookMessages, nextLink: newNextLink } = await getMessagesByFolder(token, folderId, nextLink);
              if (newNextLink) folderPaginationMap.set(key, newNextLink);
              
              // Get user from database
              const user = await User.findOne({ worxstreamUserId: userId });
              if (user) {
                // Save new messages to database
                const savedMessages = await Promise.all(outlookMessages.map(async msg => {
                  try {
                    const emailData = {
                      id: msg.id,
                      userId: user._id,
                      email: email,
                      from: msg.from || '',
                      to: msg.to || '',
                      cc: msg.cc || '',
                      bcc: msg.bcc || '',
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

                    const savedMsg = await Email.findOneAndUpdate(
                      { id: msg.id, email: email },
                      { $set: emailData },
                      { upsert: true, new: true, setDefaultsOnInsert: true }
                    );
                    return savedMsg;
                  } catch (error) {
                    console.error(`❌ Failed to save message ${msg.id}:`, error);
                    return null;
                  }
                }));

                // Now get the filtered messages from database (including newly saved ones)
                messages = await emailService.getFolderMessages(userId, email, folderId, page, 20, filters);
              }
              
              // Check if there are more messages in Outlook
              hasMore = !!newNextLink;
            }
          } else {
            // We have enough messages from database, check if there are more
            const totalCount = await emailService.getFolderMessageCount(userId, email, folderId, filters);
            hasMore = totalCount > page * 20;
          }
        } else {
          // Load more: fetch from Outlook API without filters
          console.log('📥 Load more: fetching from Outlook API...');
          
          const token = await getToken(userId, email, 'outlook');
          if (token) {
            const key = `${socket.id}-${folderId}`;
            const nextLink = folderPaginationMap.get(key);
            
            const { messages: outlookMessages, nextLink: newNextLink } = await getMessagesByFolder(token, folderId, nextLink);
            if (newNextLink) folderPaginationMap.set(key, newNextLink);
            
            // Get user from database
            const user = await User.findOne({ worxstreamUserId: userId });
            if (user) {
              // Save new messages to database
              const savedMessages = await Promise.all(outlookMessages.map(async msg => {
                try {
                  const emailData = {
                    id: msg.id,
                    userId: user._id,
                    email: email,
                    from: msg.from || '',
                    to: msg.to || '',
                    cc: msg.cc || '',
                    bcc: msg.bcc || '',
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

                  const savedMsg = await Email.findOneAndUpdate(
                    { id: msg.id, email: email },
                    { $set: emailData },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                  );
                  return savedMsg;
                } catch (error) {
                  console.error(`❌ Failed to save message ${msg.id}:`, error);
                  return null;
                }
              }));

              // Get all messages from database and apply filters on frontend
              const allMessages = await emailService.getFolderMessages(userId, email, folderId, 1, 1000, {}); // Get all messages
              
              // Apply filters on frontend
              let filteredMessages = allMessages;
              if (filters.category && filters.category !== 'All') {
                filteredMessages = filteredMessages.filter(msg => msg.aiMeta?.category === filters.category);
              }
              if (filters.priority && filters.priority !== 'All') {
                filteredMessages = filteredMessages.filter(msg => msg.aiMeta?.priority === filters.priority);
              }
              if (filters.sentiment && filters.sentiment !== 'All') {
                filteredMessages = filteredMessages.filter(msg => msg.aiMeta?.sentiment === filters.sentiment);
              }
              
              // Paginate the filtered results
              const startIndex = (page - 1) * 20;
              messages = filteredMessages.slice(startIndex, startIndex + 20);
            }
            
            // Check if there are more messages in Outlook
            hasMore = !!newNextLink;
          }
        }
        
        console.log(`📧 Found ${messages.length} messages, hasMore: ${hasMore}`);

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

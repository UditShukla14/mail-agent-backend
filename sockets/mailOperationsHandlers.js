import { getToken } from '../utils/tokenManager.js';
import { 
  getMessagesByFolder, 
  getMessageById, 
  sendEmail,
  replyToEmail,
  replyAllToEmail
} from '../services/outlookService.js';
import emailService from '../services/emailService.js';

export const initMailOperationsHandlers = (socket, io) => {
  // Get folder messages with pagination
  socket.on('mail:getFolder', async ({ worxstreamUserId, email, folderId, page = 1 }) => {
    try {
      console.log(`📁 Getting folder messages for ${email} in folder ${folderId}, page ${page}`);
      
      const pageSize = 20;
      const messages = await emailService.getFolderMessages(worxstreamUserId, email, folderId, page, pageSize);
      
      console.log(`📧 Retrieved ${messages.length} messages from folder ${folderId}`);
      
      // Check if there are more messages to load
      const totalCount = await emailService.getFolderMessageCount(worxstreamUserId, email, folderId);
      const hasMore = totalCount > page * pageSize;
      
      // Emit messages immediately
      socket.emit('mail:folderMessages', {
        messages,
        folderId,
        page,
        nextLink: hasMore ? `page=${page + 1}` : null
      });
      console.log('✅ Emitted mail:folderMessages event');

      // Remove automatic enrichment - let the frontend request enrichment when needed
      console.log('⏭️ Skipping automatic enrichment - will be handled by frontend requests');
    } catch (error) {
      console.error('❌ Error in mail:getFolder:', error);
      socket.emit('mail:error', 'Failed to get folder messages');
    }
  });

  // Get specific message
  socket.on('mail:getMessage', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log(`📧 Getting message ${messageId} for ${email}`);
      
      const message = await emailService.getMessage(worxstreamUserId, email, messageId);
      
      console.log(`✅ Retrieved message ${messageId}`);
      
      // Emit message immediately
      socket.emit('mail:message', message);
      console.log('✅ Emitted mail:message event');

      // Remove automatic enrichment - let the frontend request enrichment when needed
      console.log('⏭️ Skipping automatic enrichment - will be handled by frontend requests');
    } catch (error) {
      console.error('❌ Error getting message:', error);
      socket.emit('mail:error', 'Failed to get message');
    }
  });

  // Get message attachments
  socket.on('mail:getAttachments', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log(`📎 Getting attachments for message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const { getAttachmentsByMessageId } = await import('../services/outlookService.js');
      const attachments = await getAttachmentsByMessageId(token, messageId);
      socket.emit('mail:attachments', { messageId, attachments });
      console.log(`✅ Retrieved ${attachments.length} attachments for message ${messageId}`);
    } catch (error) {
      console.error('❌ Error getting attachments:', error);
      socket.emit('mail:error', 'Failed to get attachments');
    }
  });

  // Send email
  socket.on('mail:send', async ({ worxstreamUserId, email, to, subject, body, cc, bcc }) => {
    try {
      console.log(`📤 Sending email from ${email} to ${to}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const result = await sendEmail(token, { to, subject, body, cc, bcc });
      socket.emit('mail:sent', { success: true, messageId: result.id });
      console.log(`✅ Email sent successfully: ${result.id}`);
    } catch (error) {
      console.error('❌ Error sending email:', error);
      socket.emit('mail:error', 'Failed to send email');
    }
  });

  // Reply to email
  socket.on('mail:reply', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      console.log(`↩️ Replying to message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const result = await replyToEmail(token, messageId, comment, toRecipients, ccRecipients, bccRecipients);
      socket.emit('mail:replied', { success: true, messageId: result.id });
      console.log(`✅ Reply sent successfully: ${result.id}`);
    } catch (error) {
      console.error('❌ Error replying to email:', error);
      socket.emit('mail:error', 'Failed to reply to email');
    }
  });

  // Reply all to email
  socket.on('mail:replyAll', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      console.log(`↩️ Replying all to message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const result = await replyAllToEmail(token, messageId, comment, toRecipients, ccRecipients, bccRecipients);
      socket.emit('mail:repliedAll', { success: true, messageId: result.id });
      console.log(`✅ Reply all sent successfully: ${result.id}`);
    } catch (error) {
      console.error('❌ Error replying all to email:', error);
      socket.emit('mail:error', 'Failed to reply all to email');
    }
  });
};

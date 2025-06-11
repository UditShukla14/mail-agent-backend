const emailService = require('../services/email');
const emailEnrichmentService = require('../services/emailEnrichment');

class MailHandler {
  constructor(io) {
    this.io = io;
  }

  async handleGetFolder(socket, data) {
    try {
      console.log('Handling getFolder request:', data);
      const { appUserId, email, folderId, page = 1 } = data;
      const pageSize = 20; // Number of emails per page
      const messages = await emailService.getFolderMessages(appUserId, email, folderId, page, pageSize);
      
      console.log(`Retrieved ${messages.length} messages from folder ${folderId}`);
      
      // Check if there are more messages to load
      const totalCount = await emailService.getFolderMessageCount(appUserId, email, folderId);
      const hasMore = totalCount > page * pageSize;
      
      // Emit messages immediately
      socket.emit('mail:folderMessages', {
        messages,
        folderId,
        page,
        nextLink: hasMore ? `page=${page + 1}` : null
      });
      console.log('Emitted mail:folderMessages event');

      // Start enriching emails in the background
      console.log('Starting background enrichment process');
      emailEnrichmentService.enrichBatch(messages, socket);
    } catch (error) {
      console.error('Error getting folder messages:', error);
      socket.emit('error', { message: 'Failed to get folder messages' });
    }
  }

  async handleGetMessage(socket, data) {
    try {
      console.log('Handling getMessage request:', data);
      const { appUserId, email, messageId } = data;
      const message = await emailService.getMessage(appUserId, email, messageId);
      
      console.log(`Retrieved message ${messageId}`);
      
      // Emit message immediately
      socket.emit('mail:message', message);
      console.log('Emitted mail:message event');

      // Enrich the full message content
      console.log('Starting message enrichment');
      emailEnrichmentService.enrichEmail(message, socket);
    } catch (error) {
      console.error('Error getting message:', error);
      socket.emit('error', { message: 'Failed to get message' });
    }
  }

  async handleMarkRead(socket, data) {
    try {
      console.log('Handling markRead request:', data);
      const { appUserId, email, messageId } = data;
      await emailService.markAsRead(appUserId, email, messageId);
      socket.emit('mail:read', { messageId });
      console.log(`Marked message ${messageId} as read`);
    } catch (error) {
      console.error('Error marking message as read:', error);
      socket.emit('error', { message: 'Failed to mark message as read' });
    }
  }

  async handleMarkImportant(socket, data) {
    try {
      console.log('Handling markImportant request:', data);
      const { appUserId, email, messageId, flag } = data;
      await emailService.markAsImportant(appUserId, email, messageId, flag);
      socket.emit('mail:important', { messageId, flag });
      console.log(`Marked message ${messageId} important flag as ${flag}`);
    } catch (error) {
      console.error('Error marking message as important:', error);
      socket.emit('error', { message: 'Failed to mark message as important' });
    }
  }

  registerHandlers(socket) {
    console.log('Registering mail handlers for socket:', socket.id);
    socket.on('mail:getFolder', data => this.handleGetFolder(socket, data));
    socket.on('mail:getMessage', data => this.handleGetMessage(socket, data));
    socket.on('mail:markRead', data => this.handleMarkRead(socket, data));
    socket.on('mail:markImportant', data => this.handleMarkImportant(socket, data));
  }
}

module.exports = MailHandler; 
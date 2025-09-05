import emailService from '../services/emailService.js';


class MailHandler {
  constructor(io) {
    this.io = io;
  }

  async handleGetFolder(socket, data) {
    try {
      console.log('Handling getFolder request:', data);
      const { worxstreamUserId, email, folderId, page = 1, filters = {} } = data;
      const pageSize = 20; // Number of emails per page
      const messages = await emailService.getFolderMessages(worxstreamUserId, email, folderId, page, pageSize, filters);
      
      console.log(`Retrieved ${messages.length} messages from folder ${folderId}`);
      
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
      console.log('Emitted mail:folderMessages event');

      // Remove automatic enrichment - let the frontend request enrichment when needed
      console.log('Skipping automatic enrichment - will be handled by frontend requests');
    } catch (error) {
      console.error('Error getting folder messages:', error);
      socket.emit('error', { message: 'Failed to get folder messages' });
    }
  }

  async handleGetMessage(socket, data) {
    try {
      console.log('Handling getMessage request:', data);
      const { worxstreamUserId, email, messageId } = data;
      const message = await emailService.getMessage(worxstreamUserId, email, messageId);
      
      console.log(`Retrieved message ${messageId}`);
      
      // Emit message immediately
      socket.emit('mail:message', message);
      console.log('Emitted mail:message event');

      // Remove automatic enrichment - let the frontend request enrichment when needed
      console.log('Skipping automatic enrichment - will be handled by frontend requests');
    } catch (error) {
      console.error('Error getting message:', error);
      socket.emit('error', { message: 'Failed to get message' });
    }
  }

  async handleMarkRead(socket, data) {
    try {
      console.log('Handling markRead request:', data);
      const { worxstreamUserId, email, messageId } = data;
      await emailService.markAsRead(worxstreamUserId, email, messageId);
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
      const { worxstreamUserId, email, messageId, flag } = data;
      await emailService.markAsImportant(worxstreamUserId, email, messageId, flag);
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

export default MailHandler; 
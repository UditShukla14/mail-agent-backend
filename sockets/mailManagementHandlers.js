import { getToken } from '../utils/tokenManager.js';
import { 
  markMessageRead, 
  markMessageImportant, 
  deleteMessage 
} from '../services/outlookService.js';
import emailService from '../services/emailService.js';
import Email from '../models/email.js';
import EmailAccount from '../models/EmailAccount.js';
import User from '../models/User.js';

export const initMailManagementHandlers = (socket, io) => {
  // Mark message as read
  socket.on('mail:markRead', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log(`📖 Marking message ${messageId} as read`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }
      await markMessageRead(token, messageId);
      socket.emit('mail:read', { messageId });
      console.log(`✅ Marked message ${messageId} as read`);
    } catch (error) {
      console.error('❌ Error marking message as read:', error);
      socket.emit('mail:error', 'Failed to mark message as read');
    }
  });

  // Mark message as important
  socket.on('mail:markImportant', async ({ worxstreamUserId, email, messageId, flag }) => {
    try {
      console.log(`⭐ Marking message ${messageId} important flag as ${flag}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }
      await markMessageImportant(token, messageId, flag);
      socket.emit('mail:important', { messageId, flag });
      console.log(`✅ Marked message ${messageId} important flag as ${flag}`);
    } catch (error) {
      console.error('❌ Error marking message as important:', error);
      socket.emit('mail:error', 'Failed to mark message as important');
    }
  });

  // Delete message
  socket.on('mail:delete', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log(`🗑️ Deleting message ${messageId}`);
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        socket.emit('mail:error', 'Token not found');
        return;
      }
      await deleteMessage(token, messageId);
      socket.emit('mail:deleted', { messageId });
      console.log(`✅ Deleted message ${messageId}`);
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('mail:error', 'Failed to delete message');
    }
  });

  // Update message category
  socket.on('mail:updateCategory', async ({ worxstreamUserId, email, messageId, category }) => {
    try {
      console.log(`🏷️ Updating category for message ${messageId} to ${category}`);
      
      // Get user from database
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        socket.emit('mail:error', 'User not found');
        return;
      }

      // Get email account to validate category
      const emailAccount = await EmailAccount.findOne({ 
        userId: user._id, 
        email: email 
      });
      
      if (!emailAccount) {
        socket.emit('mail:error', 'Email account not found');
        return;
      }

      // Validate category exists in user's email account
      const validCategories = emailAccount.categories.map(cat => cat.name);
      if (!validCategories.includes(category)) {
        socket.emit('mail:error', 'Invalid category');
        return;
      }

      // Update the email's category in database
      const updatedEmail = await Email.findOneAndUpdate(
        { id: messageId, userId: user._id },
        { 
          $set: { 
            'aiMeta.category': category,
            'aiMeta.enrichedAt': new Date()
          } 
        },
        { new: true }
      );

      if (!updatedEmail) {
        socket.emit('mail:error', 'Message not found');
        return;
      }

      socket.emit('mail:categoryUpdated', { 
        messageId, 
        category,
        email: updatedEmail 
      });
      console.log(`✅ Updated category for message ${messageId} to ${category}`);
    } catch (error) {
      console.error('❌ Error updating message category:', error);
      socket.emit('mail:error', 'Failed to update message category');
    }
  });
};

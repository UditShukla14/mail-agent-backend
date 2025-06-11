import { getToken } from '../utils/tokenManager.js';
import { getMessagesByFolder } from './outlookService.js';
import Email from '../models/email.js';
import User from '../models/User.js';

class EmailService {
  async getFolderMessages(appUserId, email, folderId, page = 1, pageSize = 20) {
    try {
      // Validate input parameters
      if (!appUserId || !email || !folderId) {
        console.error('❌ Invalid parameters:', { appUserId, email, folderId });
        throw new Error('Missing required parameters');
      }

      console.log(`🔄 Getting folder messages for ${email} in folder ${folderId}`);

      const token = await getToken(appUserId, email, 'outlook');
      if (!token) {
        console.error(`❌ Token not found for ${email}`);
        throw new Error('Token not found');
      }

      const skip = (page - 1) * pageSize;
      const { messages } = await getMessagesByFolder(token, folderId, null, pageSize);

      if (!messages || messages.length === 0) {
        console.log('📭 No messages found in folder');
        return [];
      }

      // Get user from database
      const user = await User.findOne({ appUserId });
      if (!user) {
        console.error(`❌ User not found for appUserId: ${appUserId}`);
        throw new Error('User not found');
      }

      console.log(`💾 Saving ${messages.length} messages to database`);

      // Store messages in database with user reference
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

          // Validate required fields before saving
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

      return validMessages;
    } catch (error) {
      console.error('❌ Error getting folder messages:', error);
      throw error;
    }
  }

  async getFolderMessageCount(appUserId, email, folderId) {
    try {
      const token = await getToken(appUserId, email, 'outlook');
      if (!token) throw new Error('Token not found');

      // Get total count from database
      const count = await Email.countDocuments({ folder: folderId });
      return count;
    } catch (error) {
      console.error('Error getting folder message count:', error);
      throw error;
    }
  }

  async getMessage(appUserId, email, messageId) {
    try {
      // Validate input parameters
      if (!appUserId || !email || !messageId) {
        console.error('❌ Invalid parameters:', { appUserId, email, messageId });
        throw new Error('Missing required parameters');
      }

      console.log(`🔄 Getting message ${messageId} for ${email}`);

      const token = await getToken(appUserId, email, 'outlook');
      if (!token) {
        console.error(`❌ Token not found for ${email}`);
        throw new Error('Token not found');
      }

      // Get user from database
      const user = await User.findOne({ appUserId });
      if (!user) {
        console.error(`❌ User not found for appUserId: ${appUserId}`);
        throw new Error('User not found');
      }

      // Get message from database first
      let message = await Email.findOne({ id: messageId });
      
      if (!message) {
        console.log(`📥 Message ${messageId} not found in DB, fetching from Outlook`);
        // If not in database, fetch from Outlook and save
        const outlookMessage = await getMessageById(token, messageId);
        if (!outlookMessage) {
          console.error(`❌ Message ${messageId} not found in Outlook`);
          throw new Error('Message not found');
        }

        console.log(`💾 Saving message ${messageId} to database`);
        message = await Email.create({
          ...outlookMessage,
          userId: user._id,
          email: email,
          isProcessed: false
        });
      }

      return message;
    } catch (error) {
      console.error('❌ Error getting message:', error);
      throw error;
    }
  }

  // New method to mark message as processed
  async markMessageAsProcessed(messageId) {
    try {
      await Email.findOneAndUpdate(
        { id: messageId },
        { $set: { isProcessed: true } }
      );
    } catch (error) {
      console.error('Error marking message as processed:', error);
      throw error;
    }
  }
}

export default new EmailService(); 
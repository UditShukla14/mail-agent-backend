import { getToken } from '../utils/tokenManager.js';
import { getMessagesByFolder, getMessageById } from './outlookService.js';
import Email from '../models/email.js';
import User from '../models/User.js';

class EmailService {
  async getFolderMessages(worxstreamUserId, email, folderId, page = 1, pageSize = 20) {
    try {
      // Validate input parameters
      if (!worxstreamUserId || !email || !folderId) {
        console.error('❌ Invalid parameters:', { worxstreamUserId, email, folderId });
        throw new Error('Missing required parameters');
      }

      console.log(`🔄 Getting folder messages for ${email} in folder ${folderId}`);

      const token = await getToken(worxstreamUserId, email, 'outlook');
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
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error(`❌ User not found for worxstreamUserId: ${worxstreamUserId}`);
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
            { id: msg.id, email: email },
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

  async getFolderMessageCount(worxstreamUserId, email, folderId) {
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) throw new Error('Token not found');

      // Get total count from database
      const count = await Email.countDocuments({ folder: folderId });
      return count;
    } catch (error) {
      console.error('Error getting folder message count:', error);
      throw error;
    }
  }

  async getMessage(worxstreamUserId, email, messageId) {
    try {
      // Validate input parameters
      if (!worxstreamUserId || !email || !messageId) {
        console.error('❌ Invalid parameters:', { worxstreamUserId, email, messageId });
        throw new Error('Missing required parameters');
      }

      console.log(`🔄 Getting message ${messageId} for ${email}`);

      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error(`❌ Token not found for ${email}`);
        throw new Error('Token not found');
      }

      // Get user from database
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error(`❌ User not found for worxstreamUserId: ${worxstreamUserId}`);
        throw new Error('User not found');
      }

      // Get AI metadata from database first
      let dbMessage = await Email.findOne({ id: messageId, email: email });
      let aiMetadata = null;
      
      if (dbMessage) {
        console.log(`📊 Found AI metadata in database for message ${messageId}`);
        aiMetadata = dbMessage.aiMeta;
      } else {
        console.log(`📥 Message ${messageId} not found in DB, will fetch from Outlook only`);
      }

      // Always fetch fresh message data from Outlook (including attachments)
      console.log(`📥 Fetching fresh message data from Outlook for ${messageId}`);
      const outlookMessage = await getMessageById(token, messageId);
      if (!outlookMessage) {
        console.error(`❌ Message ${messageId} not found in Outlook`);
        throw new Error('Message not found');
      }

      // Process content to replace cid: URLs with data URLs for inline attachments
      let processedContent = outlookMessage.content;
      if (outlookMessage.attachments && outlookMessage.attachments.length > 0) {
        console.log('Processing content to replace CID URLs with data URLs');
        outlookMessage.attachments.forEach((attachment) => {
          if (attachment.contentId && attachment.contentBytes) {
            const cidUrl = `cid:${attachment.contentId}`;
            const dataUrl = `data:${attachment.contentType};base64,${attachment.contentBytes}`;
            console.log(`Replacing ${cidUrl} with data URL for ${attachment.name}`);
            
            // Use global replace to handle multiple occurrences
            const escapedCidUrl = cidUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            processedContent = processedContent.replace(new RegExp(escapedCidUrl, 'g'), dataUrl);
          }
        });
      }

      // Remove any remaining cid: URLs to prevent browser errors
      const cidRegex = /cid:([^"'\s>]+)/g;
      const remainingCids = processedContent.match(cidRegex);
      if (remainingCids) {
        console.log('Removing remaining CID URLs to prevent browser errors:', remainingCids);
        processedContent = processedContent.replace(
          /<img[^>]*src=["']cid:[^"']*["'][^>]*>/gi,
          '<div style="color: #666; font-style: italic; padding: 10px; border: 1px dashed #ccc; margin: 10px 0;">[Inline image not available]</div>'
        );
      }

      // Combine Outlook data with AI metadata from database
      const combinedMessage = {
        ...outlookMessage,
        content: processedContent, // Use processed content
        aiMeta: aiMetadata // Include AI metadata if available
      };

      // If message doesn't exist in DB, save it with AI metadata
      if (!dbMessage) {
        console.log(`💾 Saving new message ${messageId} to database`);
        await Email.create({
          ...outlookMessage,
          userId: user._id,
          email: email,
          isProcessed: false
        });
      }

      console.log(`✅ Returning combined message with ${aiMetadata ? 'AI metadata' : 'no AI metadata'} and ${outlookMessage.attachments?.length || 0} attachments`);
      console.log(`📄 Content processing: ${outlookMessage.content.length} chars → ${processedContent.length} chars`);
      return combinedMessage;
    } catch (error) {
      console.error('❌ Error getting message:', error);
      throw error;
    }
  }

  // New method to mark message as processed
  async markMessageAsProcessed(messageId, email) {
    try {
      await Email.findOneAndUpdate(
        { id: messageId, email: email },
        { $set: { isProcessed: true } }
      );
    } catch (error) {
      console.error('Error marking message as processed:', error);
      throw error;
    }
  }

  async deleteMessage(worxstreamUserId, email, messageId) {
    try {
      // Get the message to check its folder and read status
      const message = await Email.findOne({ id: messageId, email: email });
      if (!message) {
        throw new Error('Message not found');
      }

      // Delete the message
      await Email.deleteOne({ id: messageId, email: email });

      // Update folder counts
      if (message.folder) {
        const folder = await Email.findOne({ folder: message.folder });
        if (folder) {
          const totalCount = await Email.countDocuments({ folder: message.folder });
          const unreadCount = await Email.countDocuments({ 
            folder: message.folder,
            read: false 
          });

          // Update folder counts in the database
          await Email.updateMany(
            { folder: message.folder },
            { 
              $set: {
                folderTotalCount: totalCount,
                folderUnreadCount: unreadCount
              }
            }
          );
        }
      }

      return true;
    } catch (error) {
      console.error('Error deleting message:', error);
      throw error;
    }
  }
}

export default new EmailService(); 
import { getToken } from '../utils/tokenManager.js';
import { getMessagesByFolder, getMessageById } from './outlookService.js';
import Email from '../models/email.js';
import User from '../models/User.js';
import focusAssignmentService from './focusAssignmentService.js';

class EmailService {
  async getFolderMessages(worxstreamUserId, email, folderId, page = 1, pageSize = 20, filters = {}) {
    try {
      // Validate input parameters
      if (!worxstreamUserId || !email || !folderId) {
        console.error('❌ Invalid parameters:', { worxstreamUserId, email, folderId });
        throw new Error('Missing required parameters');
      }


      // Get user from database
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error(`❌ User not found for worxstreamUserId: ${worxstreamUserId}`);
        throw new Error('User not found');
      }

      // Build database query with filters
      const query = {
        userId: user._id,
        email: email,
        folder: folderId
      };

      // Add AI metadata filters if provided
      if (filters.category && filters.category !== 'All') {
        query['aiMeta.category'] = filters.category;
      }
      if (filters.priority && filters.priority !== 'All') {
        query['aiMeta.priority'] = filters.priority;
      }
      if (filters.sentiment && filters.sentiment !== 'All') {
        query['aiMeta.sentiment'] = filters.sentiment;
      }


      // Calculate pagination
      const skip = (page - 1) * pageSize;

      // Query emails directly from database with filters
      const messages = await Email.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(pageSize)
        .select('-content'); // Exclude content for performance


      // If no messages found in database, try to fetch from Outlook and save them
      if (messages.length === 0 && page === 1) {
        
        const token = await getToken(worxstreamUserId, email, 'outlook');
        if (!token) {
          console.error(`❌ Token not found for ${email}`);
          throw new Error('Token not found');
        }

        const { messages: outlookMessages } = await getMessagesByFolder(token, folderId, null, pageSize);

        if (outlookMessages && outlookMessages.length > 0) {

          // Store messages in database with user reference
          const savedMessages = await Promise.all(outlookMessages.map(async msg => {
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
                timestamp: (() => {
                  if (msg.timestamp && msg.timestamp !== '') {
                    const receivedTime = new Date(msg.timestamp);
                    return receivedTime;
                  } else {
                    return new Date();
                  }
                })(),
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

              // Check if this email should be assigned to a focus folder
              let focusFolder = null;
              try {
                focusFolder = await focusAssignmentService.assignFocusFolder(
                  emailData, 
                  user._id, 
                  email
                );
              } catch (error) {
                console.error('⚠️ Error assigning focus folder:', error);
                // Continue without focus folder assignment
              }
              
              // Add focus folder to email data if assigned
              if (focusFolder) {
                emailData.focusFolder = focusFolder;
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

              return savedMsg;
            } catch (error) {
              console.error(`❌ Failed to save message ${msg.id}:`, error);
              return null;
            }
          }));

          const validMessages = savedMessages.filter(Boolean);

          // Apply filters to the saved messages if any filters are provided
          if (Object.keys(filters).length > 0) {
            const filteredMessages = this.applyFilters(validMessages, filters);
            return filteredMessages;
          }

          return validMessages;
        }
      }

      return messages;
    } catch (error) {
      console.error('❌ Error getting folder messages:', error);
      throw error;
    }
  }

  async getFolderMessageCount(worxstreamUserId, email, folderId, filters = {}) {
    try {
      // Get user from database
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error(`❌ User not found for worxstreamUserId: ${worxstreamUserId}`);
        throw new Error('User not found');
      }

      // Build database query with filters
      const query = {
        userId: user._id,
        email: email,
        folder: folderId
      };

      // Add AI metadata filters if provided
      if (filters.category && filters.category !== 'All') {
        query['aiMeta.category'] = filters.category;
      }
      if (filters.priority && filters.priority !== 'All') {
        query['aiMeta.priority'] = filters.priority;
      }
      if (filters.sentiment && filters.sentiment !== 'All') {
        query['aiMeta.sentiment'] = filters.sentiment;
      }

      // Get total count from database with filters
      const count = await Email.countDocuments(query);
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
        aiMetadata = dbMessage.aiMeta;
      } else {
      }

      // Always fetch fresh message data from Outlook (including attachments)
      const outlookMessage = await getMessageById(token, messageId);
      if (!outlookMessage) {
        console.error(`❌ Message ${messageId} not found in Outlook`);
        throw new Error('Message not found');
      }

      // Process content to replace cid: URLs with data URLs for inline attachments
      let processedContent = outlookMessage.content;
      if (outlookMessage.attachments && outlookMessage.attachments.length > 0) {
        outlookMessage.attachments.forEach((attachment) => {
          if (attachment.contentId && attachment.contentBytes) {
            const cidUrl = `cid:${attachment.contentId}`;
            const dataUrl = `data:${attachment.contentType};base64,${attachment.contentBytes}`;
            
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
        processedContent = processedContent.replace(
          /<img[^>]*src=["']cid:[^"']*["'][^>]*>/gi,
          '<div style="color: #666; font-style: italic; padding: 10px; border: 1px dashed #ccc; margin: 10px 0;">[Inline image not available]</div>'
        );
      }

      // Combine Outlook data with AI metadata from database
      const combinedMessage = {
        ...outlookMessage,
        content: processedContent, // Use processed content
        aiMeta: aiMetadata, // Include AI metadata if available
        dbId: dbMessage?._id?.toString() // Include database ID for short URLs
      };

      // If message doesn't exist in DB, save it with AI metadata
      if (!dbMessage) {
        
        // Check if this email should be assigned to a focus folder
        let focusFolder = null;
        try {
          focusFolder = await focusAssignmentService.assignFocusFolder(
            outlookMessage, 
            user._id, 
            email
          );
        } catch (error) {
          console.error('⚠️ Error assigning focus folder:', error);
          // Continue without focus folder assignment
        }
        
        const savedMessage = await Email.create({
          ...outlookMessage,
          userId: user._id,
          email: email,
          focusFolder: focusFolder, // Add focus folder if assigned
          isProcessed: false
        });
        
        // Update the combined message with the new database ID
        combinedMessage.dbId = savedMessage._id.toString();
      }

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

  // Apply filters to messages
  applyFilters(messages, filters) {
    return messages.filter(message => {
      // Category filter
      if (filters.category && filters.category !== 'All') {
        const messageCategory = message.aiMeta?.category;
        if (!messageCategory || messageCategory !== filters.category) {
          return false;
        }
      }

      // Priority filter
      if (filters.priority && filters.priority !== 'All') {
        const messagePriority = message.aiMeta?.priority;
        if (!messagePriority || messagePriority !== filters.priority) {
          return false;
        }
      }

      // Sentiment filter
      if (filters.sentiment && filters.sentiment !== 'All') {
        const messageSentiment = message.aiMeta?.sentiment;
        if (!messageSentiment || messageSentiment !== filters.sentiment) {
          return false;
        }
      }

      return true;
    });
  }
}

export default new EmailService(); 
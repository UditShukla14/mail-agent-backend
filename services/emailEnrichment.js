import Email from '../models/email.js';
import emailService from './emailService.js';
import enrichmentQueueService from './enrichmentQueueService.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { analyzeEmail, analyzeEmailBatch } from './claudeApiService.js';

class EmailEnrichmentService {
  constructor() {
    this.io = null;
    this.enrichmentQueue = new Set();
  }

  setIO(io) {
    this.io = io;
  }

  async enrichEmail(email, forceReprocess = false) {
    try {
      // Validate required fields
      if (!email || !email.email || !email.userId) {
        console.error('❌ Invalid email object:', email);
        throw new Error('Invalid email object - missing required fields');
      }

      // Initialize aiMeta if it doesn't exist
      if (!email.aiMeta) {
        email.aiMeta = {
          summary: null,
          category: null,
          priority: null,
          sentiment: null,
          actionItems: [],
          enrichedAt: null,
          version: null,
          error: null
        };
      }

      // Skip if already enriched and not forcing reprocess
      if (!forceReprocess && email.isProcessed && email.aiMeta?.summary) {
        console.log('⏭️ Email already enriched, skipping:', email.id);
        return email;
      }

      console.log('🚀 Starting email enrichment for:', email.id);
      
      // Get user to find their socket
      const user = await User.findById(email.userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Find the socket for this user
      const userSocket = this.findUserSocket(user.worxstreamUserId);
      if (userSocket) {
        userSocket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'analyzing',
          message: 'Analyzing email content...'
        });
      }

      // Generate AI analysis
      const analysis = await this.generateAnalysis(email);
      
      // Remove fallback values if they don't exist
      const cleanedAnalysis = {
        summary: analysis.summary || 'No summary available',
        category: analysis.category || 'Other',
        priority: analysis.priority || 'medium',
        sentiment: analysis.sentiment || 'neutral',
        actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
        enrichedAt: new Date().toISOString(),
        version: '1.0',
        error: null
      };

      // Update email with analysis
      const updatedEmail = await Email.findByIdAndUpdate(
        email._id,
        {
          $set: {
            aiMeta: cleanedAnalysis,
            isProcessed: true
          }
        },
        { new: true }
      );

      // Emit completion status to specific user
      if (userSocket) {
        console.log(`📤 Emitting enrichment status for message ${email.id} to socket ${userSocket.id}`);
        userSocket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'completed',
          message: 'Analysis complete',
          aiMeta: cleanedAnalysis,
          email: updatedEmail
        });
        console.log(`✅ Enrichment status emitted successfully for message ${email.id}`);
      } else {
        console.log(`❌ No user socket found for message ${email.id}`);
      }

      console.log('✅ Email enrichment completed:', email.id);
      return updatedEmail;
    } catch (error) {
      console.error('❌ Email enrichment failed:', error);
      // Update email with error
      await Email.findByIdAndUpdate(email._id, {
        $set: {
          'aiMeta.error': error.message,
          'aiMeta.enrichedAt': new Date().toISOString(),
          'aiMeta.version': '1.0',
          isProcessed: false
        }
      });

      // Get user to find their socket
      const user = await User.findById(email.userId);
      if (user) {
        const userSocket = this.findUserSocket(user.worxstreamUserId);
        if (userSocket) {
          userSocket.emit('mail:enrichmentStatus', {
            messageId: email.id,
            status: 'error',
            message: error.message
          });
        }
      }

      throw error;
    }
  }

  // Register a socket for unified access
  registerSocket(socket) {
    if (!this.io) {
      console.warn('⚠️ IO not set, cannot register socket');
      return;
    }
    
    // Socket is already registered with IO, just log for tracking
    console.log(`📡 Socket registered for user: ${socket.worxstreamUserId} with socket ID: ${socket.id}`);
    
    // Verify the socket is actually in the IO sockets collection
    const sockets = Array.from(this.io.sockets.sockets.values());
    const foundSocket = sockets.find(s => s.id === socket.id);
    if (foundSocket) {
      console.log(`✅ Socket ${socket.id} confirmed in IO sockets collection`);
    } else {
      console.log(`❌ Socket ${socket.id} not found in IO sockets collection`);
    }
  }

  // Helper method to find a user's socket
  findUserSocket(worxstreamUserId) {
    if (!this.io) {
      console.log('❌ IO not available for socket lookup');
      return null;
    }
    
    // Get all connected sockets
    const sockets = Array.from(this.io.sockets.sockets.values());
    console.log(`🔍 Looking for socket for user ${worxstreamUserId}, total sockets: ${sockets.length}`);
    
    // Find the socket that has this worxstreamUserId (handle both string and number types)
    const userSocket = sockets.find(socket => {
      const socketUserId = socket.worxstreamUserId;
      const matches = String(socketUserId) === String(worxstreamUserId);
      if (matches) {
        console.log(`✅ Found socket for user ${worxstreamUserId}: ${socket.id}`);
        console.log(`📧 Socket details: connected=${socket.connected}, userInfo=${JSON.stringify(socket.userInfo)}`);
      }
      return matches;
    });
    
    if (!userSocket) {
      console.log(`❌ No socket found for user ${worxstreamUserId}`);
      // Log all available sockets for debugging
      sockets.forEach(socket => {
        console.log(`📡 Socket ${socket.id}: worxstreamUserId = ${socket.worxstreamUserId}, connected = ${socket.connected}`);
      });
    }
    
    return userSocket;
  }

  async enrichBatch(emails, socket) {
    try {
      console.log(`🔄 Starting batch enrichment for ${emails.length} emails`);

      // Get the worxstreamUserId from the first email's user
      const firstEmail = emails[0];
      if (!firstEmail || !firstEmail.userId) {
        throw new Error('Invalid email batch - missing user information');
      }

      const user = await User.findById(firstEmail.userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Find the socket for this user
      const userSocket = this.findUserSocket(user.worxstreamUserId);

      // Filter out already enriched emails and validate required fields
      const unenrichedEmails = [];
      for (const email of emails) {
        // Validate email object
        if (!email || typeof email !== 'object') {
          console.error('❌ Invalid email object:', email);
          continue;
        }

        // Check required fields
        if (!email.id || !email.email || !email.userId) {
          console.error('❌ Email missing required fields:', {
            id: email.id,
            email: email.email,
            userId: email.userId
          });
          continue;
        }

        // Check if already enriched - use database check instead of in-memory
        const existingEmail = await Email.findById(email._id);
        if (existingEmail?.aiMeta?.enrichedAt && !existingEmail?.aiMeta?.error && existingEmail?.isProcessed) {
          console.log(`✅ Email ${email.id} already enriched`);
          // Emit already enriched status to specific user
          if (userSocket) {
            userSocket.emit('mail:enrichmentStatus', {
              messageId: email.id,
              status: 'completed',
              message: 'Already enriched',
              aiMeta: existingEmail.aiMeta,
              email: existingEmail
            });
          }
          continue;
        }

        // Add to unenriched list
        unenrichedEmails.push(email);
      }
      
      if (unenrichedEmails.length === 0) {
        console.log('📧 No emails need enrichment');
        return true;
      }

      console.log(`📧 Found ${unenrichedEmails.length} emails needing enrichment`);

      // Process emails in batches to prevent rate limiting
      const batchSize = 5; // Back to 5 emails per batch as requested
      const maxRetries = 3;
      const baseDelay = 120000; // 2 minutes base delay for API overload protection

      for (let i = 0; i < unenrichedEmails.length; i += batchSize) {
        const batch = unenrichedEmails.slice(i, i + batchSize);
        console.log(`🔄 Processing batch of ${batch.length} emails`);

        let retryCount = 0;
        let success = false;

        while (!success && retryCount < maxRetries) {
          try {
            // Get full message content for each email in batch
            const messages = await Promise.all(batch.map(async (email) => {
              const user = await User.findById(email.userId);
              if (!user) {
                throw new Error('User not found');
              }
              return emailService.getMessage(user.worxstreamUserId, email.email, email.id);
            }));

            // Generate batch analysis
            const analyses = await this.generateBatchAnalysis(messages);

            // Update each email with its analysis
            await Promise.all(batch.map(async (email, index) => {
              const analysis = analyses[index];
              if (analysis) {
                const updatedEmail = await Email.findByIdAndUpdate(
                  email._id,
                  {
                    aiMeta: {
                      ...analysis,
                      enrichedAt: new Date(),
                      error: null,
                      version: '1.0'
                    },
                    isProcessed: true
                  },
                  { new: true }
                );

                // Emit success status to specific user
                if (userSocket) {
                  console.log(`📤 Emitting enrichment status for message ${email.id} to socket ${userSocket.id}`);
                  userSocket.emit('mail:enrichmentStatus', {
                    messageId: email.id,
                    status: 'completed',
                    message: 'Analysis complete',
                    aiMeta: analysis,
                    email: updatedEmail
                  });
                  console.log(`✅ Batch enrichment status emitted successfully for message ${email.id}`);
                } else {
                  console.log(`❌ No user socket found for message ${email.id}`);
                }
              }
            }));

            success = true;
            console.log(`✅ Successfully processed batch of ${batch.length} emails`);

          } catch (error) {
            retryCount++;
            console.error(`❌ Error processing batch (attempt ${retryCount}/${maxRetries}):`, error);

            // Emit error to specific user
            if (userSocket) {
              batch.forEach(email => {
                userSocket.emit('mail:enrichmentStatus', {
                  messageId: email.id,
                  status: 'error',
                  message: `Error processing email (attempt ${retryCount}/${maxRetries}): ${error.message}`,
                  error: true
                });
              });
            }

            if (retryCount < maxRetries) {
              const delay = baseDelay * Math.pow(2, retryCount - 1); // Exponential backoff
              console.log(`⏳ Waiting ${delay/1000} seconds before retry ${retryCount}/${maxRetries}...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              // Update emails with error status after all retries failed
              await Promise.all(batch.map(async (email) => {
                await Email.findByIdAndUpdate(email._id, {
                  $set: {
                    'aiMeta.error': `Failed after ${maxRetries} attempts: ${error.message}`,
                    'aiMeta.enrichedAt': new Date(),
                    'aiMeta.version': '1.0',
                    isProcessed: false
                  }
                });
              }));
            }
          }
        }

        // Add delay between batches to prevent rate limiting
        if (i + batchSize < unenrichedEmails.length) {
          const delay = 30000; // 30 seconds delay between batches to prevent API overload
          console.log(`⏳ Waiting ${delay/1000} seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      return true;
    } catch (error) {
      console.error('❌ Error in enrichBatch:', error);
      if (socket) {
        socket.emit('mail:error', 'Failed to process email batch');
      }
      throw error;
    }
  }

  async generateAnalysis(message) {
    try {
      // Extract relevant information from the message
      const { subject, content, from, to } = message;
      
      console.log('🔍 generateAnalysis - Message:', {
        userId: message.userId,
        email: message.email,
        from: message.from,
        to: message.to
      });
      
      // Get user and email account for categories
      const user = await User.findById(message.userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Get email account for this specific email (use the user's email address)
      const emailAccount = await EmailAccount.findOne({ 
        userId: user._id, 
        email: message.email 
      });

      console.log('🔍 generateAnalysis - Email account lookup:', {
        userId: user._id,
        email: message.email,
        found: !!emailAccount,
        categoriesCount: emailAccount?.categories?.length || 0
      });

      if (!emailAccount) {
        throw new Error('Email account not found');
      }

      // Create detailed category information for AI
      const categoryInfo = emailAccount.categories.map(cat => 
        `- ${cat.name}: ${cat.description}`
      ).join('\n');
      
      const categoryNames = emailAccount.categories.map(c => c.name).join(', ');
      
      // Prepare the prompt for AI analysis with enhanced category context
      const prompt = `Analyze this email and provide insights:

Email Details:
Subject: ${subject}
From: ${from}
To: ${to}
Content: ${content}

Available Categories (choose the most appropriate one):
${categoryInfo}

Please provide:
1. A brief summary (2-3 sentences)
2. The category (must be one of: ${categoryNames})
3. Priority level (urgent, high, medium, low)
4. Sentiment (positive, negative, neutral)
5. Key action items or next steps (if any)

Format the response as a JSON object with these fields:
{
  "summary": "string",
  "category": "string",
  "priority": "string",
  "sentiment": "string",
  "actionItems": ["string"]
}`;

      // Implement retry logic with exponential backoff
      const maxRetries = 3;
      const baseDelay = 60000; // 1 minute base delay
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Use the centralized API service for analysis
          const analysis = await analyzeEmail(message);
          return analysis;
        } catch (error) {
          // If this is the last attempt, throw the error
          if (attempt === maxRetries - 1) {
            throw error;
          }
          
          // Otherwise, wait and retry
          const delay = baseDelay * Math.pow(2, attempt);
          console.log(`⏳ Error occurred, waiting ${delay/1000} seconds before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      console.error('❌ AI analysis failed:', error);
      throw new Error('Failed to generate AI analysis: ' + error.message);
    }
  }

  async generateBatchAnalysis(messages) {
    try {
      console.log('🔍 generateBatchAnalysis - Processing batch of', messages.length, 'emails');
      
      // Use the centralized API service for batch analysis
      const analyses = await analyzeEmailBatch(messages);
      
      return analyses;
    } catch (error) {
      console.error('❌ AI batch analysis failed:', error);
      throw new Error('Failed to generate AI batch analysis: ' + error.message);
    }
  }
}

const service = new EmailEnrichmentService();
export default service; 
import Email from '../models/email.js';
import emailService from './emailService.js';
import enrichmentQueueService from './enrichmentQueueService.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { makeClaudeApiCall } from './claudeApiService.js';

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
      
      // Validate and normalize category to ensure it's a valid internal name
      let normalizedCategory = analysis.category;
      
      // Get the valid categories from the email account to validate against
      const emailAccount = await EmailAccount.findOne({ 
        userId: email.userId, 
        email: email.email 
      });
      
      if (emailAccount && emailAccount.categories) {
        const validCategories = emailAccount.categories.map(cat => cat.name);
        const categoryDetails = emailAccount.categories.map(cat => `${cat.name} (${cat.label}): ${cat.description}`).join(', ');
        
        // If the AI returned an invalid category, fail the enrichment
        if (!validCategories.includes(normalizedCategory)) {
          console.error(`❌ AI returned invalid category: "${normalizedCategory}" for email ${email.id}. Valid categories: ${validCategories.join(', ')}`);
          console.error(`📋 Category details: ${categoryDetails}`);
          throw new Error(`AI returned invalid category: "${normalizedCategory}". Valid categories are: ${validCategories.join(', ')}. Please ensure the AI uses the exact internal name from the provided list.`);
        }
      }
      
      // Remove fallback values if they don't exist
      const cleanedAnalysis = {
        summary: analysis.summary || 'No summary available',
        category: normalizedCategory,
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
      
      // Check if this is a "no categories" error
      if (error.message.includes('No categories defined yet')) {
        console.log('⏭️ Email enrichment skipped - user needs to create categories first');
        
        // Update email to indicate it's waiting for categories
        await Email.findByIdAndUpdate(email._id, {
          $set: {
            'aiMeta.error': 'Waiting for user to create categories',
            'aiMeta.enrichedAt': new Date().toISOString(),
            'aiMeta.version': '1.0',
            isProcessed: false
          }
        });
        
        // Emit status to user
        const user = await User.findById(email.userId);
        if (user) {
          const userSocket = this.findUserSocket(user.worxstreamUserId);
          if (userSocket) {
            userSocket.emit('mail:enrichmentStatus', {
              messageId: email.id,
              status: 'waiting',
              message: 'Please create email categories first to enable AI analysis'
            });
          }
        }
        
        // Return the email without enrichment
        return email;
      }
      
      // Update email with error for other types of failures
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
        to: message.to,
        messageKeys: Object.keys(message),
        messageEmailType: typeof message.email,
        messageEmailValue: message.email
      });
      
      // Get user and email account for categories
      const user = await User.findById(message.userId);
      if (!user) {
        throw new Error('User not found');
      }

      console.log('🔍 generateAnalysis - User lookup:', {
        messageUserId: message.userId,
        foundUser: user._id,
        worxstreamUserId: user.worxstreamUserId,
        userEmail: user.email
      });

      // Get email account for this specific email (use the user's email address)
      const emailAccount = await EmailAccount.findOne({ 
        userId: user._id, 
        email: message.email 
      });

      // Debug: Check all email accounts for this user
      const allUserAccounts = await EmailAccount.find({ userId: user._id });
      console.log('🔍 generateAnalysis - All user email accounts:', {
        totalAccounts: allUserAccounts.length,
        accounts: allUserAccounts.map(acc => ({
          email: acc.email,
          hasCategories: !!acc.categories,
          categoriesCount: acc.categories?.length || 0
        }))
      });

      console.log('🔍 generateAnalysis - Email account lookup:', {
        userId: user._id,
        email: message.email,
        found: !!emailAccount,
        categoriesCount: emailAccount?.categories?.length || 0,
        categories: emailAccount?.categories?.map(cat => ({
          name: cat.name,
          label: cat.label,
          description: cat.description
        })) || []
      });

      if (!emailAccount) {
        throw new Error('Email account not found');
      }

      // 🚨 CRITICAL FIX: Don't process if no categories defined
      if (!emailAccount.categories || emailAccount.categories.length === 0) {
        console.log('⏭️ Skipping enrichment - no categories defined yet for account:', message.email);
        throw new Error('No categories defined yet. Please create categories first before processing emails.');
      }

      // Create detailed category information for AI
      const categoryInfo = emailAccount.categories.map(cat => 
        `- ${cat.name} (${cat.label}): ${cat.description}`
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
2. The category (must be exactly one of: ${categoryNames})
3. Priority level (urgent, high, medium, low)
4. Sentiment (positive, negative, neutral)
5. Key action items or next steps (if any)

IMPORTANT CATEGORIZATION RULES: 
- The category field must be exactly one of the internal category names listed above (e.g., "prasad_sir", not "Prasad Sir"). 
- Use the exact internal name, not the display label.
- ALWAYS check the sender (From field) first when categorizing emails.
- If a category description mentions a specific sender (like "All mails from prasad goswami sir"), that category should be used for emails from that sender.
- Consider both the category name and description when making your decision.
- If the email content doesn't clearly match any category, choose the closest one based on the description.
- Pay special attention to sender-specific categories - they take priority over general content-based categories.

Format the response as a JSON object with these fields:
{
  "summary": "string",
  "category": "string",
  "priority": "string",
  "sentiment": "string",
  "actionItems": ["string"]
}`;

      // Log the exact prompt being sent to AI for debugging
      console.log('🤖 AI Prompt being sent:', {
        emailId: message.id,
        from: message.from,
        subject: message.subject,
        categories: emailAccount.categories.map(cat => ({
          name: cat.name,
          label: cat.label,
          description: cat.description
        })),
        promptLength: prompt.length
      });
      console.log('📝 Full AI Prompt:', prompt);

      // Implement retry logic with exponential backoff
      const maxRetries = 3;
      const baseDelay = 60000; // 1 minute base delay
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Use the custom prompt with user's categories instead of generic analyzeEmail
          const analysis = await this.makeCustomAnalysisCall(message, prompt);
          
          // Log the AI response for debugging
          console.log('🤖 AI Response received:', {
            emailId: message.id,
            from: message.from,
            aiResponse: analysis,
            category: analysis.category,
            summary: analysis.summary?.substring(0, 100) + '...'
          });
          
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

  async makeCustomAnalysisCall(message, prompt) {
    try {
      console.log('🔍 makeCustomAnalysisCall - Using custom prompt for user categories');
      
      const response = await makeClaudeApiCall(prompt);
      
      try {
        const analysis = JSON.parse(response);
        
        // Validate and normalize category to ensure it's a valid internal name
        let normalizedCategory = analysis.category;
        
        // Get the valid categories from the email account to validate against
        const user = await User.findById(message.userId);
        if (user) {
          const emailAccount = await EmailAccount.findOne({ 
            userId: user._id, 
            email: message.email 
          });
          
          if (emailAccount && emailAccount.categories) {
            const validCategories = emailAccount.categories.map(cat => cat.name);
            const categoryDetails = emailAccount.categories.map(cat => `${cat.name} (${cat.label}): ${cat.description}`).join(', ');
            
            // If the AI returned an invalid category, fail the enrichment
            if (!validCategories.includes(normalizedCategory)) {
              console.error(`❌ AI returned invalid category: "${normalizedCategory}" for email ${message.id}. Valid categories: ${validCategories.join(', ')}`);
              console.error(`📋 Category details: ${categoryDetails}`);
              throw new Error(`AI returned invalid category: "${normalizedCategory}". Valid categories are: ${validCategories.join(', ')}. Please ensure the AI uses the exact internal name from the provided list.`);
            }
          }
        }
        
        return {
          summary: analysis.summary || 'No summary available',
          category: normalizedCategory,
          priority: analysis.priority || 'medium',
          sentiment: analysis.sentiment || 'neutral',
          actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
          enrichedAt: new Date().toISOString(),
          version: '1.0',
          error: null
        };
      } catch (parseError) {
        console.error('❌ Failed to parse Claude response:', response);
        
        // Try to fix common JSON issues
        try {
          // Remove any leading/trailing text that's not JSON
          let cleanedResponse = response.trim();
          
          // Find the first { and last } to extract just the JSON part
          const firstBrace = cleanedResponse.indexOf('{');
          const lastBrace = cleanedResponse.lastIndexOf('}');
          
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
          }
          
          console.log('🔧 Attempting to parse cleaned response:', cleanedResponse);
          const analysis = JSON.parse(cleanedResponse);
          
          // Validate category again after cleaning
          let normalizedCategory = analysis.category;
          const user = await User.findById(message.userId);
          if (user) {
            const emailAccount = await EmailAccount.findOne({ 
              userId: user._id, 
              email: message.email 
            });
            
            if (emailAccount && emailAccount.categories) {
              const validCategories = emailAccount.categories.map(cat => cat.name);
              const categoryDetails = emailAccount.categories.map(cat => `${cat.name} (${cat.label}): ${cat.description}`).join(', ');
              
              if (!validCategories.includes(normalizedCategory)) {
                console.error(`❌ Cleaned response has invalid category: "${normalizedCategory}" for email ${message.id}. Valid categories: ${validCategories.join(', ')}`);
                console.error(`📋 Category details: ${categoryDetails}`);
                throw new Error(`Invalid category after cleaning: "${normalizedCategory}". Valid categories are: ${validCategories.join(', ')}. Please ensure the AI uses the exact internal name from the provided list.`);
              }
            }
          }
          
          return {
            summary: analysis.summary || 'No summary available',
            category: normalizedCategory,
            priority: analysis.priority || 'medium',
            sentiment: analysis.sentiment || 'neutral',
            actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
            enrichedAt: new Date().toISOString(),
            version: '1.0',
            error: null
          };
        } catch (secondParseError) {
          console.error('❌ Failed to parse even after cleaning:', secondParseError.message);
          
          // Return a fallback analysis that indicates failure
          return {
            summary: 'Analysis failed - could not parse response',
            category: null, // No category assigned due to parsing failure
            priority: 'medium',
            sentiment: 'neutral',
            actionItems: [],
            enrichedAt: new Date().toISOString(),
            version: '1.0',
            error: 'Failed to parse Claude response: ' + parseError.message
          };
        }
      }
    } catch (error) {
      console.error('❌ Custom analysis call failed:', error);
      throw error;
    }
  }

  async generateBatchAnalysis(messages) {
    try {
      console.log('🔍 generateBatchAnalysis - Processing batch of', messages.length, 'emails');
      
      // For batch analysis, we'll need to implement custom logic for each user's categories
      // For now, fall back to the generic service
      throw new Error('Custom batch analysis not yet implemented - use single email enrichment');
    } catch (error) {
      console.error('❌ AI batch analysis failed:', error);
      throw new Error('Failed to generate AI batch analysis: ' + error.message);
    }
  }
}

const service = new EmailEnrichmentService();
export default service; 
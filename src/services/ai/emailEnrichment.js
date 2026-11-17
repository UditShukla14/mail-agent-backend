import Email from '../../models/email.js';
import emailService from '../emailService.js';
import User from '../../models/User.js';
import EmailAccount from '../../models/EmailAccount.js';
import { makeClaudeApiCall } from './claudeApiService.js';
import { debug } from '../../utils/logger.js';

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
        debug('⏭️ Email already enriched, skipping:', email.id);
        return email;
      }

      debug('🚀 Starting email enrichment for:', email.id);
      
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
      
      // Check if the analysis has an error
      if (analysis.error) {
        console.error(`❌ AI analysis failed for email ${email.id}:`, analysis.error);
        throw new Error(`AI analysis failed: ${analysis.error}`);
      }
      
      // Validate that we have all required fields
      if (!analysis.summary || !analysis.category || !analysis.priority || !analysis.sentiment) {
        console.error(`❌ AI analysis missing required fields for email ${email.id}:`, analysis);
        throw new Error('AI analysis missing required fields: summary, category, priority, or sentiment');
      }
      
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
      
      // Use the validated analysis without fallback values
      const cleanedAnalysis = {
        summary: analysis.summary,
        category: normalizedCategory,
        priority: analysis.priority,
        sentiment: analysis.sentiment,
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
        debug(`📤 Emitting enrichment status for message ${email.id} to socket ${userSocket.id}`);
        userSocket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'completed',
          message: 'Analysis complete',
          aiMeta: cleanedAnalysis,
          email: updatedEmail
        });
        debug(`✅ Enrichment status emitted successfully for message ${email.id}`);
      } else {
        debug(`❌ No user socket found for message ${email.id}`);
      }

      debug('✅ Email enrichment completed:', email.id);
      return updatedEmail;
    } catch (error) {
      console.error('❌ Email enrichment failed:', error);
      
      // Check if this is a "no categories" error
      if (error.message.includes('No categories defined yet')) {
        debug('⏭️ Email enrichment skipped - user needs to create categories first');
        
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
    debug(`📡 Socket registered for user: ${socket.worxstreamUserId} with socket ID: ${socket.id}`);
    
    // Verify the socket is actually in the IO sockets collection
    const sockets = Array.from(this.io.sockets.sockets.values());
    const foundSocket = sockets.find(s => s.id === socket.id);
    if (foundSocket) {
      debug(`✅ Socket ${socket.id} confirmed in IO sockets collection`);
    } else {
      debug(`❌ Socket ${socket.id} not found in IO sockets collection`);
    }
  }

  // Helper method to find a user's socket
  findUserSocket(worxstreamUserId) {
    if (!this.io) {
      debug('❌ IO not available for socket lookup');
      return null;
    }
    
    // Get all connected sockets
    const sockets = Array.from(this.io.sockets.sockets.values());
    debug(`🔍 Looking for socket for user ${worxstreamUserId}, total sockets: ${sockets.length}`);
    
    // Find the socket that has this worxstreamUserId (handle both string and number types)
    const userSocket = sockets.find(socket => {
      const socketUserId = socket.worxstreamUserId;
      const matches = String(socketUserId) === String(worxstreamUserId);
      if (matches) {
        debug(`✅ Found socket for user ${worxstreamUserId}: ${socket.id}`);
      }
      return matches;
    });
    
    if (!userSocket) {
      debug(`❌ No socket found for user ${worxstreamUserId}`);
      // Log all available sockets for debugging
      sockets.forEach(socket => {
        debug(`📡 Socket ${socket.id}: worxstreamUserId = ${socket.worxstreamUserId}, connected = ${socket.connected}`);
      });
    }
    
    return userSocket;
  }

  // Unregister a socket when it disconnects
  unregisterSocket(socket) {
    if (!this.io) {
      debug('⚠️ IO not available for socket unregistration');
      return;
    }
    
    debug(`📡 Unregistering socket: ${socket.id} for user: ${socket.worxstreamUserId}`);
    
    // The socket is automatically removed from IO when it disconnects
    // This method is mainly for logging and cleanup purposes
    if (socket.worxstreamUserId) {
      debug(`🧹 Socket cleanup completed for user: ${socket.worxstreamUserId}`);
    }
  }


  async generateAnalysis(message) {
    try {
      // Extract relevant information from the message
      const { subject, content, from, to } = message;
      
      
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

      // Debug: Check all email accounts for this user
      const allUserAccounts = await EmailAccount.find({ userId: user._id });


      if (!emailAccount) {
        throw new Error('Email account not found');
      }

      // 🚨 CRITICAL FIX: Don't process if no categories defined
      if (!emailAccount.categories || emailAccount.categories.length === 0) {
        debug('⏭️ Skipping enrichment - no categories defined yet for account:', message.email);
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

      // Implement retry logic with exponential backoff
      const maxRetries = 3;
      const baseDelay = 60000; // 1 minute base delay
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Use the custom prompt with user's categories instead of generic analyzeEmail
          const analysis = await this.makeCustomAnalysisCall(message, prompt);
          
          // Log the AI response for debugging
          
          return analysis;
        } catch (error) {
          // If this is the last attempt, throw the error
          if (attempt === maxRetries - 1) {
            throw error;
          }
          
          // Otherwise, wait and retry
          const delay = baseDelay * Math.pow(2, attempt);
          debug(`⏳ Error occurred, waiting ${delay/1000} seconds before retry ${attempt + 1}/${maxRetries}`);
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
      debug('🔍 makeCustomAnalysisCall - Using custom prompt for user categories');
      
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
          summary: analysis.summary,
          category: normalizedCategory,
          priority: analysis.priority,
          sentiment: analysis.sentiment,
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
          
          debug('🔧 Attempting to parse cleaned response:', cleanedResponse);
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
            summary: analysis.summary,
            category: normalizedCategory,
            priority: analysis.priority,
            sentiment: analysis.sentiment,
            actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
            enrichedAt: new Date().toISOString(),
            version: '1.0',
            error: null
          };
        } catch (secondParseError) {
          console.error('❌ Failed to parse even after cleaning:', secondParseError.message);
          
          // Return error object instead of fallback values
          return {
            summary: null,
            category: null,
            priority: null,
            sentiment: null,
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
}

const service = new EmailEnrichmentService();
export default service; 
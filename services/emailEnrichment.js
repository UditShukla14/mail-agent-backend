import Email from '../models/email.js';
import emailService from './emailService.js';
import enrichmentQueueService from './enrichmentQueueService.js';
import User from '../models/User.js';

class EmailEnrichmentService {
  constructor() {
    this.socket = null;
    this.enrichmentQueue = new Set();
  }

  setSocket(socket) {
    this.socket = socket;
  }

  async enrichEmail(email, forceReprocess = false) {
    try {
      // Validate required fields
      if (!email || !email.email || !email.userId) {
        console.error('❌ Invalid email object:', email);
        throw new Error('Invalid email object - missing required fields');
      }

      // Skip if already enriched and not forcing reprocess
      if (!forceReprocess && email.isProcessed && email.aiMeta?.summary) {
        console.log('⏭️ Email already enriched, skipping:', email.id);
        return email;
      }

      console.log('🚀 Starting email enrichment for:', email.id);
      
      // Emit analyzing status
      if (this.socket) {
        this.socket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'analyzing',
          message: 'Analyzing email content...'
        });
      }

      // Generate AI analysis
      const analysis = await this.generateAnalysis(email);
      
      // Remove fallback values if they don't exist
      const cleanedAnalysis = {
        summary: analysis.summary,
        category: analysis.category,
        priority: analysis.priority || undefined,
        sentiment: analysis.sentiment || undefined,
        actionItems: analysis.actionItems || [],
        enrichedAt: new Date()
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

      // Emit completion status
      if (this.socket) {
        this.socket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'completed',
          message: 'Analysis complete',
          aiMeta: cleanedAnalysis
        });
      }

      console.log('✅ Email enrichment completed:', email.id);
      return updatedEmail;
    } catch (error) {
      console.error('❌ Email enrichment failed:', error);
      // Update email with error
      await Email.findByIdAndUpdate(email._id, {
        $set: {
          'aiMeta.error': error.message,
          isProcessed: false
        }
      });

      // Emit error status
      if (this.socket) {
        this.socket.emit('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'error',
          message: error.message
        });
      }

      throw error;
    }
  }

  async enrichBatch(emails, socket) {
    try {
      console.log(`🔄 Starting batch enrichment for ${emails.length} emails`);

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

        // Check if already enriched
        const existingEmail = await Email.findById(email._id);
        if (existingEmail?.aiMeta?.enrichedAt && !existingEmail?.aiMeta?.error) {
          console.log(`✅ Email ${email.id} already enriched`);
          // Emit already enriched status
          if (socket) {
            socket.emit('mail:enrichmentUpdate', {
              messageId: email.id,
              status: 'completed',
              message: 'Already enriched',
              aiMeta: existingEmail.aiMeta,
              email: existingEmail // Send full email object
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

      // Process emails in batches of 5
      const batchSize = 5;
      for (let i = 0; i < unenrichedEmails.length; i += batchSize) {
        const batch = unenrichedEmails.slice(i, i + batchSize);
        console.log(`🔄 Processing batch of ${batch.length} emails`);

        try {
          // Get full message content for each email in batch
          const messages = await Promise.all(batch.map(async (email) => {
            const user = await User.findById(email.userId);
            if (!user) {
              throw new Error('User not found');
            }
            return emailService.getMessage(user.appUserId, email.email, email.id);
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
                { new: true } // Return the updated document
              );

              // Emit success status with full email object
              if (socket) {
                socket.emit('mail:enrichmentUpdate', {
                  messageId: email.id,
                  status: 'completed',
                  message: 'Analysis complete',
                  aiMeta: analysis,
                  email: updatedEmail // Send full email object
                });
              }
            }
          }));

          // Add delay between batches to avoid rate limits
          if (i + batchSize < unenrichedEmails.length) {
            console.log('⏳ Waiting 30 seconds before next batch...');
            await new Promise(resolve => setTimeout(resolve, 30000));
          }
        } catch (error) {
          console.error('❌ Error processing batch:', error);
          // Emit error for each email in the batch
          batch.forEach(email => {
            if (socket) {
              socket.emit('mail:enrichmentUpdate', {
                messageId: email.id,
                status: 'error',
                message: error.message,
                error: true
              });
            }
          });
          // Continue with next batch even if one fails
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
      
      // Prepare the prompt for AI analysis
      const prompt = `Analyze this email and provide insights:
Subject: ${subject}
From: ${from}
To: ${to}
Content: ${content}

Please provide:
1. A brief summary (2-3 sentences)
2. The category (Work, Personal, Finance, Shopping, Travel, Social, Newsletter, Marketing, Important Documents, Other)
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
          // Call Claude API for analysis
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-3-haiku-20240307',
              max_tokens: 1000,
              messages: [
                {
                  role: 'user',
                  content: prompt
                }
              ]
            })
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Claude API error:', {
              status: response.status,
              statusText: response.statusText,
              error: errorData
            });

            // If rate limited, wait and retry
            if (response.status === 429) {
              const delay = baseDelay * Math.pow(2, attempt);
              console.log(`⏳ Rate limited, waiting ${delay/1000} seconds before retry ${attempt + 1}/${maxRetries}`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }

            throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          
          if (!data.content || !data.content[0] || !data.content[0].text) {
            console.error('❌ Invalid response format from Claude:', data);
            throw new Error('Invalid response format from Claude API');
          }

          let analysis;
          try {
            analysis = JSON.parse(data.content[0].text);
          } catch (parseError) {
            console.error('❌ Failed to parse Claude response:', data.content[0].text);
            throw new Error('Failed to parse Claude response as JSON');
          }

          // Validate and normalize the response
          return {
            summary: analysis.summary || 'No summary available',
            category: analysis.category || 'Other',
            priority: analysis.priority || 'medium',
            sentiment: analysis.sentiment || 'neutral',
            actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
            version: '1.0'
          };
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
      // Prepare batch prompt
      const batchPrompt = `Analyze these emails and provide insights for each one. For each email, provide:
1. A brief summary (2-3 sentences)
2. The category (Work, Personal, Finance, Shopping, Travel, Social, Newsletter, Marketing, Important Documents, Other)
3. Priority level (urgent, high, medium, low)
4. Sentiment (positive, negative, neutral)
5. Key action items or next steps (if any)

Emails to analyze:
${messages.map((msg, index) => `
Email ${index + 1}:
Subject: ${msg.subject}
From: ${msg.from}
To: ${msg.to}
Content: ${msg.content}
---`).join('\n')}

Format the response as a JSON array of objects, where each object has these fields:
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
          // Call Claude API for batch analysis
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-3-haiku-20240307',
              max_tokens: 4000, // Increased for batch processing
              messages: [
                {
                  role: 'user',
                  content: batchPrompt
                }
              ]
            })
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Claude API error:', {
              status: response.status,
              statusText: response.statusText,
              error: errorData
            });

            // If rate limited, wait and retry
            if (response.status === 429) {
              const delay = baseDelay * Math.pow(2, attempt);
              console.log(`⏳ Rate limited, waiting ${delay/1000} seconds before retry ${attempt + 1}/${maxRetries}`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }

            throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          
          if (!data.content || !data.content[0] || !data.content[0].text) {
            console.error('❌ Invalid response format from Claude:', data);
            throw new Error('Invalid response format from Claude API');
          }

          let analyses;
          try {
            analyses = JSON.parse(data.content[0].text);
            if (!Array.isArray(analyses)) {
              throw new Error('Response is not an array');
            }
          } catch (parseError) {
            console.error('❌ Failed to parse Claude response:', data.content[0].text);
            throw new Error('Failed to parse Claude response as JSON array');
          }

          // Validate and normalize each analysis
          return analyses.map(analysis => ({
            summary: analysis.summary || 'No summary available',
            category: analysis.category || 'Other',
            priority: analysis.priority || 'medium',
            sentiment: analysis.sentiment || 'neutral',
            actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
            version: '1.0'
          }));
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
      console.error('❌ Batch AI analysis failed:', error);
      throw new Error('Failed to generate batch AI analysis: ' + error.message);
    }
  }
}

const service = new EmailEnrichmentService();
export default service; 
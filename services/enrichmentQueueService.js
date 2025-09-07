import { processEnrichmentBatch } from './enrichmentProcessor.js';
import Email from '../models/email.js';
import emailEnrichmentService from './emailEnrichment.js';
import User from '../models/User.js';

class EnrichmentQueueService {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.batchSize = 10; // Increased batch size for better throughput
    this.rateLimitDelay = 30000; // Reduced to 30 seconds between batches
    this.maxRetries = 3;
    this.currentTokens = 0;
    this.maxTokensPerMinute = 1000; // Claude API limit
    this.maxRequestsPerMinute = 1000; // Claude API limit
    this.processingEmails = new Set(); // Track emails currently being processed
    this.tokenUsageHistory = []; // Track token usage over time
    this.requestHistory = []; // Track request count over time
    this.lastResetTime = Date.now();
  }

  // Check if we can process more requests without hitting limits
  canProcessBatch() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean old history entries
    this.tokenUsageHistory = this.tokenUsageHistory.filter(entry => entry.timestamp > oneMinuteAgo);
    this.requestHistory = this.requestHistory.filter(entry => entry.timestamp > oneMinuteAgo);
    
    // Check token limit
    const currentTokens = this.tokenUsageHistory.reduce((sum, entry) => sum + entry.tokens, 0);
    const currentRequests = this.requestHistory.length;
    
    // Estimate tokens for next batch (rough estimate: 1000 tokens per email)
    const estimatedTokens = this.batchSize * 1000;
    
    return currentTokens + estimatedTokens <= this.maxTokensPerMinute && 
           currentRequests + 1 <= this.maxRequestsPerMinute;
  }

  // Record token usage
  recordTokenUsage(tokens) {
    this.tokenUsageHistory.push({
      timestamp: Date.now(),
      tokens: tokens
    });
  }

  // Record request
  recordRequest() {
    this.requestHistory.push({
      timestamp: Date.now()
    });
  }

  // Calculate dynamic delay based on current usage
  getDynamicDelay() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    const recentTokens = this.tokenUsageHistory
      .filter(entry => entry.timestamp > oneMinuteAgo)
      .reduce((sum, entry) => sum + entry.tokens, 0);
    
    const recentRequests = this.requestHistory
      .filter(entry => entry.timestamp > oneMinuteAgo).length;
    
    // If we're close to limits, increase delay
    const tokenUsageRatio = recentTokens / this.maxTokensPerMinute;
    const requestUsageRatio = recentRequests / this.maxRequestsPerMinute;
    
    if (tokenUsageRatio > 0.8 || requestUsageRatio > 0.8) {
      return 120000; // 2 minutes if close to limit
    } else if (tokenUsageRatio > 0.5 || requestUsageRatio > 0.5) {
      return 60000; // 1 minute if moderate usage
    } else {
      return 30000; // 30 seconds if low usage
    }
  }

  async addToQueue(emails, socket = null) {
    try {
      console.log(`📧 Adding ${emails.length} emails to enrichment queue`);
      console.log(`📧 Socket provided: ${!!socket}`);
      
      // Validate emails before adding to queue
      const validEmails = emails.filter(email => {
        if (!email || typeof email !== 'object') {
          console.error('❌ Invalid email object:', email);
          return false;
        }
        
        if (!email.id || !email.email || !email.userId) {
          console.error('❌ Email missing required fields:', {
            id: email.id,
            email: email.email,
            userId: email.userId
          });
          return false;
        }
        
        return true;
      });
      
      console.log(`📧 Valid emails: ${validEmails.length}`);
      
      if (validEmails.length === 0) {
        console.log('❌ No valid emails to add to queue');
        return;
      }

      // Filter out already enriched emails and currently processing emails
      const unenrichedEmails = await this.filterUnenrichedEmails(validEmails);
      const notProcessingEmails = unenrichedEmails.filter(email => !this.processingEmails.has(email.id));
      
      console.log(`📧 Unenriched emails: ${unenrichedEmails.length}, Not processing: ${notProcessingEmails.length}`);
      
      if (notProcessingEmails.length === 0) {
        console.log('✅ All emails are already enriched or being processed');
        return;
      }

      // Add emails to processing set to prevent duplicates
      notProcessingEmails.forEach(email => this.processingEmails.add(email.id));
      
      // Store the socket with the emails for processing
      const queueItem = {
        emails: notProcessingEmails,
        socket: socket
      };
      
      this.queue.push(queueItem);
      console.log(`📧 Added ${notProcessingEmails.length} emails to queue. Queue length: ${this.queue.length}`);
      
      // Start processing if not already running
      if (!this.processing) {
        console.log('🚀 Starting queue processing');
        this.processQueue();
      } else {
        console.log('⏳ Queue is already processing');
      }
    } catch (error) {
      console.error('❌ Error adding emails to queue:', error);
      throw error;
    }
  }

  async filterUnenrichedEmails(emails) {
    const emailIds = emails.map(email => email.id);
    
    // Find already enriched emails
    const enrichedEmails = await Email.find({
      id: { $in: emailIds },
      $or: [
        { 'aiMeta.enrichedAt': { $exists: true }, 'aiMeta.error': { $exists: false } },
        { isProcessed: true }
      ]
    }).select('id');

    const enrichedIds = new Set(enrichedEmails.map(e => e.id));
    
    // Return only unenriched emails
    return emails.filter(email => !enrichedIds.has(email.id));
  }

  async processQueue() {
    if (this.processing) {
      console.log('⏳ Queue is already processing, skipping');
      return;
    }

    console.log('🚀 Starting queue processing');
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Check if we can process without hitting limits
        if (!this.canProcessBatch()) {
          const delay = this.getDynamicDelay();
          console.log(`⏳ Rate limit reached, waiting ${delay/1000} seconds before next batch`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        const queueItem = this.queue.splice(0, 1)[0]; // Take one item at a time
        console.log(`📧 Processing queue item with ${queueItem.emails.length} emails`);
        
        // Record this request
        this.recordRequest();
        
        await this.processBatch(queueItem.emails, queueItem.socket);
        
        // Clear processing state for this batch
        queueItem.emails.forEach(email => this.processingEmails.delete(email.id));
        
        // Add dynamic delay between batches if there are more emails
        if (this.queue.length > 0) {
          const delay = this.getDynamicDelay();
          console.log(`⏳ Waiting ${delay/1000} seconds before next batch`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      console.log('✅ Queue processing completed');
    } catch (error) {
      console.error('❌ Error in queue processing:', error);
    } finally {
      this.processing = false;
      console.log('🏁 Queue processing finished');
    }
  }

  async processBatch(batch, socket = null) {
    console.log(`📧 Processing batch of ${batch.length} emails`);
    console.log(`📧 Socket provided for batch: ${!!socket}`);
    
    // Filter out already enriched emails and validate required fields
    const unprocessedEmails = batch.filter(email => {
      // Check if email has required fields
      if (!email.email || !email.userId) {
        console.error('❌ Invalid email object in batch:', {
          id: email.id,
          hasEmail: !!email.email,
          hasUserId: !!email.userId
        });
        return false;
      }

      // Check if already processed
      const isProcessed = email.aiMeta && 
                         email.aiMeta.version === '1.0' && 
                         email.aiMeta.enrichedAt &&
                         email.isProcessed;
      if (isProcessed) {
        return false;
      }

      return true;
    });

    console.log(`📧 Unprocessed emails: ${unprocessedEmails.length}`);

    if (unprocessedEmails.length === 0) {
      console.log('✅ No emails need processing in this batch');
      return false; // Return false to indicate no processing was needed
    }

    
    // Process emails in batches of 5 for API calls (matching claudeApiService)
    const batchSize = 5;
    const batches = [];
    
    for (let i = 0; i < unprocessedEmails.length; i += batchSize) {
      batches.push(unprocessedEmails.slice(i, i + batchSize));
    }

    for (const emailBatch of batches) {
      try {
        console.log(`📧 Processing email batch of ${emailBatch.length} emails`);
        
        // Get the user for this batch to emit events to the correct user
        const firstEmail = emailBatch[0];
        const user = await User.findById(firstEmail.userId);
        if (!user) {
          console.error('❌ User not found for email batch');
          continue;
        }
        
        console.log(`👤 Found user: ${user.worxstreamUserId} for email batch`);
        
        // Create emit callback function that uses the provided socket or falls back to finding the user's socket
        const emitCallback = (event, data) => {
          try {
            // Use the provided socket if available, otherwise fall back to finding the user's socket
            const targetSocket = socket || (emailEnrichmentService.io ? emailEnrichmentService.findUserSocket(user.worxstreamUserId) : null);
            
            if (targetSocket) {
              targetSocket.emit(event, data);
            }
          } catch (error) {
            // Socket error - don't fail the enrichment process
            console.log(`📡 Socket error for ${event}: ${error.message}, continuing processing...`);
          }
        };
        
        // Process the entire batch using the rate-limited processor
        console.log(`📡 Calling processEnrichmentBatch with emitCallback for ${emailBatch.length} emails`);
        
        // Estimate and record token usage for this batch
        const estimatedTokens = emailBatch.length * 1000; // Rough estimate
        this.recordTokenUsage(estimatedTokens);
        
        await processEnrichmentBatch(emailBatch, emitCallback);
        console.log(`✅ processEnrichmentBatch completed for ${emailBatch.length} emails`);

        // Rate limiting is handled by the processor, no additional delay needed
      } catch (error) {
        console.error('❌ Error processing batch:', error);
        // Continue with next batch even if one fails
      }
    }

    console.log('✅ Batch processing completed successfully');
    return true; // Return true to indicate successful processing
  }

  getQueueLength() {
    return this.queue.length;
  }

  isProcessing() {
    return this.processing;
  }

  // Method to force re-enrichment of specific emails
  async forceReenrich(emailIds) {
    const emails = await Email.find({ id: { $in: emailIds } });
    if (emails.length === 0) {
      console.log('❌ No emails found for re-enrichment');
      return;
    }
    
    // Clear existing enrichment data
    await Email.updateMany(
      { id: { $in: emailIds } },
      { 
        $unset: { 
          'aiMeta': 1 
        },
        $set: {
          isProcessed: false
        }
      }
    );
    
    await this.addToQueue(emails);
  }

  // Method to clear processing state (useful for debugging)
  clearProcessingState() {
    this.processingEmails.clear();
    console.log('🧹 Processing state cleared');
  }
}

const service = new EnrichmentQueueService();
export default service;
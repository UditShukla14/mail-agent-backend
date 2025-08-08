import { processEnrichmentBatch } from './enrichmentProcessor.js';
import Email from '../models/email.js';
import emailEnrichmentService from './emailEnrichment.js';
import User from '../models/User.js';

class EnrichmentQueueService {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.batchSize = 5; // Consistent with other services
    this.rateLimitDelay = 60000; // 1 minute delay between batches
    this.maxRetries = 3;
    this.currentTokens = 0;
    this.maxTokensPerMinute = 1000; // Assuming a default maxTokensPerMinute
    this.processingEmails = new Set(); // Track emails currently being processed
  }

  async addToQueue(emails) {
    try {
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
      
      if (validEmails.length === 0) {
        return;
      }

      // Filter out already enriched emails and currently processing emails
      const unenrichedEmails = await this.filterUnenrichedEmails(validEmails);
      const notProcessingEmails = unenrichedEmails.filter(email => !this.processingEmails.has(email.id));
      
      if (notProcessingEmails.length === 0) {
        return;
      }

      // Add emails to processing set to prevent duplicates
      notProcessingEmails.forEach(email => this.processingEmails.add(email.id));
      
      this.queue.push(...notProcessingEmails);
      
      // Start processing if not already running
      if (!this.processing) {
        this.processQueue();
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
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        
        await this.processBatch(batch);
        
        // Clear processing state for this batch
        batch.forEach(email => this.processingEmails.delete(email.id));
        
        // Add delay between batches if there are more emails
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        }
      }
    } catch (error) {
      console.error('❌ Error in queue processing:', error);
    } finally {
      this.processing = false;
    }
  }

  async processBatch(batch) {
    
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

    if (unprocessedEmails.length === 0) {
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
        
        // Get the user for this batch to emit events to the correct user
        const firstEmail = emailBatch[0];
        const user = await User.findById(firstEmail.userId);
        if (!user) {
          console.error('❌ User not found for email batch');
          continue;
        }
        
        // Create emit callback function that tries to emit to specific user
        // but continues processing even if socket is not available
        const emitCallback = (event, data) => {
          try {
            if (emailEnrichmentService.io) {
              // Find the specific user's socket and emit to them
              const userSocket = emailEnrichmentService.findUserSocket(user.worxstreamUserId);
              if (userSocket) {
                userSocket.emit(event, data);
              } else {
                // User socket not found - this is normal when user is not on mail page
                // Don't retry or broadcast - just log and continue
                console.log(`📡 User ${user.worxstreamUserId} socket not found for ${event}, continuing processing...`);
              }
            }
          } catch (error) {
            // Socket error - don't fail the enrichment process
            console.log(`📡 Socket error for ${event}: ${error.message}, continuing processing...`);
          }
        };
        
        // Process the entire batch using the rate-limited processor
        await processEnrichmentBatch(emailBatch, emitCallback);

        // Rate limiting is handled by the processor, no additional delay needed
      } catch (error) {
        console.error('❌ Error processing batch:', error);
        // Continue with next batch even if one fails
      }
    }

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
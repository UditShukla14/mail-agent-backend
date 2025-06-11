import { processEnrichmentBatch } from './enrichmentProcessor.js';
import Email from '../models/email.js';
import emailEnrichmentService from './emailEnrichment.js';

class EnrichmentQueueService {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.batchSize = 10; // Increased batch size to 10 emails
    this.rateLimitDelay = 60000; // 1 minute delay between batches
    this.maxRetries = 3;
    this.currentTokens = 0;
    this.maxTokensPerMinute = 1000; // Assuming a default maxTokensPerMinute
  }

  async addToQueue(emails) {
    try {
      console.log(`📧 Processing ${emails.length} emails for queue`);
      
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
      
      console.log(`📧 Adding ${validEmails.length} valid emails to enrichment queue`);
      
      if (validEmails.length === 0) {
        console.log('❌ No valid emails to process');
        return;
      }
      
      // Add valid emails to queue
      this.queue.push(...validEmails);
      
      // Start processing if not already running
      if (!this.processing) {
        console.log('🔄 Starting queue processing');
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
      console.log('⏳ Queue processing already in progress');
      return;
    }

    this.processing = true;
    console.log(`🔄 Starting queue processing with ${this.queue.length} emails`);

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        console.log(`🔄 Processing batch of ${batch.length} emails`);
        
        await this.processBatch(batch);
        
        if (this.queue.length > 0) {
          console.log(`⏳ Waiting ${this.rateLimitDelay/1000} seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        }
      }
    } catch (error) {
      console.error('❌ Error processing queue:', error);
    } finally {
      this.processing = false;
      console.log('✅ Queue processing completed');
    }
  }

  async processBatch(batch) {
    console.log('🔄 Processing batch of', batch.length, 'emails');
    
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
        console.log('⏭️ Skipping already enriched email:', email.id);
        return false;
      }

      return true;
    });

    if (unprocessedEmails.length === 0) {
      console.log('✅ All emails in batch are already enriched or invalid');
      return;
    }

    console.log('📝 Processing', unprocessedEmails.length, 'unprocessed emails');
    
    // Process remaining unprocessed emails
    for (const email of unprocessedEmails) {
      try {
        // Check if we're within rate limits
        if (this.currentTokens >= this.maxTokensPerMinute) {
          console.log('⏳ Rate limit reached, waiting for token reset...');
          await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 1 minute
          this.currentTokens = 0;
        }

        // Estimate tokens for this email
        const estimatedTokens = Math.ceil(email.content?.length / 4) || 100; // Default to 100 if no content
        
        if (this.currentTokens + estimatedTokens > this.maxTokensPerMinute) {
          console.log('⏳ Would exceed rate limit, waiting for token reset...');
          await new Promise(resolve => setTimeout(resolve, 60000));
          this.currentTokens = 0;
        }

        console.log(`🔄 Processing email ${email.id} for ${email.email}`);
        
        // Process the email
        const result = await this.processEmailWithRetry(email);
        
        if (result.success) {
          console.log(`✅ Successfully processed email ${email.id}`);
        } else {
          console.error(`❌ Failed to process email ${email.id}:`, result.error);
        }
        
        // Add delay between processing to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('❌ Error processing email:', email.id, error);
        // Continue with next email even if one fails
      }
    }
  }

  async processEmailWithRetry(email, retryCount = 0) {
    try {
      const result = await emailEnrichmentService.enrichEmail(email);
      return { success: true, data: result };
    } catch (error) {
      console.error(`❌ Attempt ${retryCount + 1} failed for email ${email.id}: ${error.message}`);
      
      if (retryCount < this.maxRetries) {
        console.log(`⏳ Waiting ${this.rateLimitDelay/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        return this.processEmailWithRetry(email, retryCount + 1);
      }
      
      return { success: false, error };
    }
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
}

const service = new EnrichmentQueueService();
export default service;
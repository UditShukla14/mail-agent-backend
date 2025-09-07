import emailEnrichmentService from './emailEnrichment.js';
import Email from '../models/email.js';

// Configuration
const CONFIG = {
  retryDelay: 60000, // 1 minute delay between retries
  maxRetries: 3,
  batchSize: 5 // Back to 5 emails per batch as requested
};

// Process a single email with retries
async function processEmailWithRetry(email, retryCount = 0, emitCallback = null) {
  try {
    // Try to emit analyzing status (but don't fail if socket is not available)
    try {
      if (emitCallback) {
        console.log(`📡 Calling emitCallback for analyzing status for email ${email.id}`);
        emitCallback('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'analyzing',
          message: 'Analyzing email content...'
        });
      } else {
        console.log(`⚠️ No emitCallback available for analyzing status for email ${email.id}`);
      }
    } catch (socketError) {
      console.log('📡 Socket not available for analyzing status, continuing with processing...');
    }

    // Use our custom enrichment service with database categories instead of hardcoded ones
    console.log(`🔍 Processing email ${email.id} with custom enrichment service`);
    const updatedEmail = await emailEnrichmentService.enrichEmail(email, false);
    
    console.log(`✅ Email ${email.id} processed and saved to database successfully`);
    
    // Try to emit completion status (but don't fail if socket is not available)
    try {
      if (emitCallback) {
        console.log(`📡 Calling emitCallback for completion status for email ${email.id}`);
        emitCallback('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'completed',
          message: 'Email analysis completed',
          aiMeta: updatedEmail.aiMeta,
          email: updatedEmail
        });
      } else {
        console.log(`⚠️ No emitCallback available for completion status for email ${email.id}`);
      }
    } catch (socketError) {
      console.log(`📡 Socket not available for completion status for email ${email.id}, but data is saved to database`);
    }
    
    return { success: true, data: updatedEmail };
  } catch (error) {
    console.error(`❌ Attempt ${retryCount + 1} failed for email ${email.id}: ${error.message}`);
    
    if (retryCount < CONFIG.maxRetries) {
      const delay = CONFIG.retryDelay * Math.pow(2, retryCount); // Exponential backoff
      console.log(`⏳ Waiting ${delay/1000} seconds before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return processEmailWithRetry(email, retryCount + 1, emitCallback);
    }
    
    // ALWAYS save error status to database
    await Email.findByIdAndUpdate(email._id, {
      $set: {
        'aiMeta.error': `Failed after ${CONFIG.maxRetries} attempts: ${error.message}`,
        'aiMeta.enrichedAt': new Date(),
        'aiMeta.version': '1.0',
        isProcessed: false
      }
    });

    console.log(`❌ Email ${email.id} failed after ${CONFIG.maxRetries} attempts, error saved to database`);

    // Try to emit error status (but don't fail if socket is not available)
    try {
      if (emitCallback) {
        console.log(`📡 Calling emitCallback for error status for email ${email.id}`);
        emitCallback('mail:enrichmentStatus', {
          messageId: email.id,
          status: 'error',
          message: `Failed after ${CONFIG.maxRetries} attempts: ${error.message}`,
          error: true
        });
      } else {
        console.log(`⚠️ No emitCallback available for error status for email ${email.id}`);
      }
    } catch (socketError) {
      console.log(`📡 Socket not available for error status for email ${email.id}, but error is saved to database`);
    }
    
    return { success: false, error };
  }
}

// Process a batch of emails
export async function processEnrichmentBatch(emails, emitCallback = null) {
  console.log(`🔄 Processing batch of ${emails.length} emails`);
  
  // Process emails in chunks
  const results = [];
  for (let i = 0; i < emails.length; i += CONFIG.batchSize) {
    const chunk = emails.slice(i, i + CONFIG.batchSize);
    console.log(`📧 Processing chunk of ${chunk.length} emails`);
    
    const chunkResults = await Promise.allSettled(
      chunk.map(email => processEmailWithRetry(email, 0, emitCallback))
    );
    results.push(...chunkResults);
    
    // Add a delay between chunks
    if (i + CONFIG.batchSize < emails.length) {
      const delay = 30000; // 30 seconds delay between chunks
      console.log(`⏳ Waiting ${delay/1000} seconds before next chunk...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const successful = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const failed = results.length - successful;
  
  console.log(`✅ Batch completed: ${successful} successful, ${failed} failed`);
  
  return {
    successful: results.filter(r => r.status === 'fulfilled' && r.value?.success).map(r => r.value.data),
    failed: results.filter(r => r.status === 'rejected' || !r.value?.success).map(r => r.reason || r.value?.error)
  };
} 
import emailEnrichmentService from './emailEnrichment.js';
import Email from '../models/email.js';

// Rate limiting configuration
const RATE_LIMIT = {
  tokensPerMinute: 40000, // Reduced from 45000 to be more conservative
  maxConcurrent: 2, // Reduced from 3 to 2 concurrent processes
  retryDelay: 60000, // 1 minute delay between retries
  maxRetries: 3,
  batchSize: 3 // Reduced batch size to 3 emails
};

// Token usage tracking
let currentTokenUsage = 0;
let lastResetTime = Date.now();

// Reset token usage every minute
setInterval(() => {
  currentTokenUsage = 0;
  lastResetTime = Date.now();
}, 60000);

// More accurate token estimation
function estimateTokenCount(text) {
  // Count words and characters for better estimation
  const words = text.split(/\s+/).length;
  const chars = text.length;
  
  // Average of word-based and character-based estimation
  const wordBasedEstimate = words * 1.3; // Average word is ~1.3 tokens
  const charBasedEstimate = chars / 4; // Rough character-based estimate
  
  return Math.ceil((wordBasedEstimate + charBasedEstimate) / 2);
}

// Check if we're within rate limits with buffer
function checkRateLimit(content) {
  const estimatedTokens = estimateTokenCount(content);
  const timeSinceReset = Date.now() - lastResetTime;
  const buffer = 0.2; // 20% buffer for safety
  
  // If we're close to the limit, wait
  if (timeSinceReset < 60000 && 
      (currentTokenUsage + estimatedTokens) > (RATE_LIMIT.tokensPerMinute * (1 - buffer))) {
    console.log(`⏳ Rate limit buffer reached. Current usage: ${currentTokenUsage}, Estimated: ${estimatedTokens}`);
    return false;
  }
  
  currentTokenUsage += estimatedTokens;
  return true;
}

// Process a single email with retries
async function processEmailWithRetry(email, retryCount = 0) {
  try {
    if (!checkRateLimit(email.content)) {
      throw new Error('Rate limit exceeded');
    }

    const result = await emailEnrichmentService.enrichEmail(email);
    return { success: true, data: result };
  } catch (error) {
    console.error(`❌ Attempt ${retryCount + 1} failed for email ${email.id}: ${error.message}`);
    
    if (retryCount < RATE_LIMIT.maxRetries) {
      const delay = RATE_LIMIT.retryDelay * Math.pow(2, retryCount); // Exponential backoff
      console.log(`⏳ Waiting ${delay/1000} seconds before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return processEmailWithRetry(email, retryCount + 1);
    }
    
    return { success: false, error };
  }
}

// Process a batch of emails
export async function processEnrichmentBatch(emails) {
  console.log(`🔄 Processing batch of ${emails.length} emails`);
  
  // Process emails in smaller chunks to respect rate limits
  const results = [];
  for (let i = 0; i < emails.length; i += RATE_LIMIT.batchSize) {
    const chunk = emails.slice(i, i + RATE_LIMIT.batchSize);
    console.log(`📧 Processing chunk of ${chunk.length} emails`);
    
    const chunkResults = await Promise.allSettled(
      chunk.map(email => processEmailWithRetry(email))
    );
    results.push(...chunkResults);
    
    // Add a longer delay between chunks to prevent rate limit issues
    if (i + RATE_LIMIT.batchSize < emails.length) {
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
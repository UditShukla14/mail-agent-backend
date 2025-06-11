import emailEnrichmentService from './emailEnrichment.js';
import Email from '../models/email.js';

// Rate limiting configuration
const RATE_LIMIT = {
  tokensPerMinute: 45000, // Slightly below the 50k limit to be safe
  maxConcurrent: 3, // Process 3 emails at a time
  retryDelay: 60000, // 1 minute delay between retries
  maxRetries: 3
};

// Token usage tracking
let currentTokenUsage = 0;
let lastResetTime = Date.now();

// Reset token usage every minute
setInterval(() => {
  currentTokenUsage = 0;
  lastResetTime = Date.now();
}, 60000);

// Estimate token count (rough estimation)
function estimateTokenCount(text) {
  return Math.ceil(text.length / 4); // Rough estimate: 1 token ≈ 4 characters
}

// Check if we're within rate limits
function checkRateLimit(content) {
  const estimatedTokens = estimateTokenCount(content);
  const timeSinceReset = Date.now() - lastResetTime;
  
  if (timeSinceReset < 60000 && currentTokenUsage + estimatedTokens > RATE_LIMIT.tokensPerMinute) {
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
      console.log(`⏳ Waiting ${RATE_LIMIT.retryDelay/1000} seconds before retry...`);
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.retryDelay));
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
  for (let i = 0; i < emails.length; i += RATE_LIMIT.maxConcurrent) {
    const chunk = emails.slice(i, i + RATE_LIMIT.maxConcurrent);
    const chunkResults = await Promise.allSettled(
      chunk.map(email => processEmailWithRetry(email))
    );
    results.push(...chunkResults);
    
    // Add a small delay between chunks to prevent rate limit issues
    if (i + RATE_LIMIT.maxConcurrent < emails.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
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
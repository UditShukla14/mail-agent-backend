// services/claudeApiService.js
import { RateLimiter } from 'limiter';
import { ANTHROPIC_MODEL } from '../utils/anthropicConfig.js';

// Rate limiting configuration
const RATE_LIMIT = {
  tokensPerMinute: 40000, // Conservative limit
  maxConcurrent: 1, // Only one concurrent request
  retryDelay: 60000, // 1 minute delay between retries
  maxRetries: 3,
  batchSize: 5 // Back to 5 emails per batch as requested
};

// Create a rate limiter
const limiter = new RateLimiter({
  tokensPerInterval: RATE_LIMIT.tokensPerMinute,
  interval: 'minute',
  fireImmediately: false
});

// Token usage tracking
let currentTokenUsage = 0;
let lastResetTime = Date.now();

// Reset token usage every minute
setInterval(() => {
  currentTokenUsage = 0;
  lastResetTime = Date.now();
  console.log('🔄 Reset Claude API token usage counter');
}, 60000);

// Estimate token count
function estimateTokenCount(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  const wordBasedEstimate = words * 1.3;
  const charBasedEstimate = chars / 4;
  return Math.ceil((wordBasedEstimate + charBasedEstimate) / 2);
}

// Check if we're within rate limits
async function checkRateLimit(content) {
  const estimatedTokens = estimateTokenCount(content);
  const timeSinceReset = Date.now() - lastResetTime;
  const buffer = 0.2; // 20% buffer for safety
  
  // If we're close to the limit, wait
  if (timeSinceReset < 60000 && 
      (currentTokenUsage + estimatedTokens) > (RATE_LIMIT.tokensPerMinute * (1 - buffer))) {
    console.log(`⏳ Rate limit buffer reached. Current usage: ${currentTokenUsage}, Estimated: ${estimatedTokens}`);
    return false;
  }
  
  // Wait for rate limiter
  await limiter.removeTokens(estimatedTokens);
  currentTokenUsage += estimatedTokens;
  return true;
}

// Make a single Claude API call with rate limiting
async function makeClaudeApiCall(prompt, retryCount = 0) {
  try {
    // Check rate limit before making the call
    if (!(await checkRateLimit(prompt))) {
      throw new Error('Rate limit exceeded');
    }

    console.log(`🔄 Making Claude API call (attempt ${retryCount + 1})`);
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
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

      // Model/config errors won't succeed on retry
      if (response.status === 404) {
        throw new Error(
          `Claude API error: ${response.status} ${response.statusText} (model: ${ANTHROPIC_MODEL})`
        );
      }

      // If rate limited, wait and retry
      if (response.status === 429 || response.status === 529) {
        if (retryCount < RATE_LIMIT.maxRetries) {
          const delay = RATE_LIMIT.retryDelay * Math.pow(2, retryCount);
          console.log(`⏳ Rate limited, waiting ${delay/1000} seconds before retry ${retryCount + 1}/${RATE_LIMIT.maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return makeClaudeApiCall(prompt, retryCount + 1);
        }
      }

      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.error('❌ Invalid response format from Claude:', data);
      throw new Error('Invalid response format from Claude API');
    }

    console.log(`✅ Claude API call successful`);
    return data.content[0].text;

  } catch (error) {
    console.error(`❌ Claude API call failed (attempt ${retryCount + 1}):`, error.message);
    
    if (retryCount < RATE_LIMIT.maxRetries) {
      const delay = RATE_LIMIT.retryDelay * Math.pow(2, retryCount);
      console.log(`⏳ Waiting ${delay/1000} seconds before retry ${retryCount + 1}/${RATE_LIMIT.maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeClaudeApiCall(prompt, retryCount + 1);
    }
    
    throw error;
  }
}

// Analyze a single email
export async function analyzeEmail(email) {
  console.log(`🔍 Analyzing email: ${email.id}`);
  
  const prompt = `Analyze this email and provide insights:

Email Details:
From: ${email.from}
Subject: ${email.subject}
Content: ${email.content || email.preview}

Please provide:
1. A brief summary (2-3 sentences)
2. The category (choose the most appropriate one based on content and sender)
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
}

Please respond with only the JSON object, no additional text.`;

  const response = await makeClaudeApiCall(prompt);
  
  try {
    const analysis = JSON.parse(response);
    
    // Validate that we have the required fields
    if (!analysis.summary || !analysis.category || !analysis.priority || !analysis.sentiment) {
      console.error('❌ Claude response missing required fields:', analysis);
      throw new Error('Claude response missing required fields: summary, category, priority, or sentiment');
    }
    
    // Validate priority and sentiment values
    const validPriorities = ['urgent', 'high', 'medium', 'low'];
    const validSentiments = ['positive', 'negative', 'neutral'];
    
    if (!validPriorities.includes(analysis.priority)) {
      console.error('❌ Invalid priority value:', analysis.priority);
      throw new Error(`Invalid priority value: ${analysis.priority}. Must be one of: ${validPriorities.join(', ')}`);
    }
    
    if (!validSentiments.includes(analysis.sentiment)) {
      console.error('❌ Invalid sentiment value:', analysis.sentiment);
      throw new Error(`Invalid sentiment value: ${analysis.sentiment}. Must be one of: ${validSentiments.join(', ')}`);
    }
    
    return {
      summary: analysis.summary,
      category: analysis.category,
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
      
      // Fix common issues with actionItems array
      cleanedResponse = cleanedResponse.replace(/"actionItems":\s*\[([^\]]*)\]/g, (match, items) => {
        // Split by commas and clean up each item
        const itemList = items.split(',').map(item => {
          item = item.trim();
          // Remove quotes and clean up
          item = item.replace(/^["']|["']$/g, '');
          // Escape any remaining quotes
          item = item.replace(/"/g, '\\"');
          return `"${item}"`;
        }).filter(item => item !== '""'); // Remove empty items
        
        return `"actionItems": [${itemList.join(', ')}]`;
      });
      
      console.log('🔧 Attempting to parse cleaned response:', cleanedResponse);
      const analysis = JSON.parse(cleanedResponse);
      
      // Validate that we have the required fields
      if (!analysis.summary || !analysis.category || !analysis.priority || !analysis.sentiment) {
        console.error('❌ Claude response missing required fields:', analysis);
        throw new Error('Claude response missing required fields: summary, category, priority, or sentiment');
      }
      
      // Validate priority and sentiment values
      const validPriorities = ['urgent', 'high', 'medium', 'low'];
      const validSentiments = ['positive', 'negative', 'neutral'];
      
      if (!validPriorities.includes(analysis.priority)) {
        console.error('❌ Invalid priority value:', analysis.priority);
        throw new Error(`Invalid priority value: ${analysis.priority}. Must be one of: ${validPriorities.join(', ')}`);
      }
      
      if (!validSentiments.includes(analysis.sentiment)) {
        console.error('❌ Invalid sentiment value:', analysis.sentiment);
        throw new Error(`Invalid sentiment value: ${analysis.sentiment}. Must be one of: ${validSentiments.join(', ')}`);
      }
      
      return {
        summary: analysis.summary,
        category: analysis.category,
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
}

// Analyze a batch of emails
export async function analyzeEmailBatch(emails) {
  console.log(`🔄 Analyzing batch of ${emails.length} emails`);
  
  const batchPrompt = `Analyze these emails and provide a JSON array response. Each email should have the following structure:
{
  "summary": "Brief summary of the email content",
  "category": "Choose the most appropriate category based on content and sender",
  "priority": "One of: urgent, high, medium, low",
  "sentiment": "One of: positive, negative, neutral",
  "actionItems": ["List of action items from the email"]
}

Emails:
${emails.map((email, index) => `
Email ${index + 1}:
From: ${email.from}
Subject: ${email.subject}
Content: ${email.content || email.preview}
`).join('\n')}

Please respond with only the JSON array, no additional text.`;

  const response = await makeClaudeApiCall(batchPrompt);
  
  try {
    const analyses = JSON.parse(response);
    
    if (!Array.isArray(analyses)) {
      throw new Error('Response is not an array');
    }
    
    return analyses.map((analysis, index) => {
      // Check if this analysis has an error or is missing required fields
      if (!analysis || !analysis.summary || !analysis.category || !analysis.priority || !analysis.sentiment) {
        console.error(`❌ Batch analysis ${index + 1} missing required fields:`, analysis);
        return {
          summary: null,
          category: null,
          priority: null,
          sentiment: null,
          actionItems: [],
          enrichedAt: new Date().toISOString(),
          version: '1.0',
          error: 'Missing required fields in batch analysis'
        };
      }
      
      // Validate priority and sentiment values
      const validPriorities = ['urgent', 'high', 'medium', 'low'];
      const validSentiments = ['positive', 'negative', 'neutral'];
      
      if (!validPriorities.includes(analysis.priority)) {
        console.error(`❌ Batch analysis ${index + 1} has invalid priority:`, analysis.priority);
        return {
          summary: null,
          category: null,
          priority: null,
          sentiment: null,
          actionItems: [],
          enrichedAt: new Date().toISOString(),
          version: '1.0',
          error: `Invalid priority value: ${analysis.priority}`
        };
      }
      
      if (!validSentiments.includes(analysis.sentiment)) {
        console.error(`❌ Batch analysis ${index + 1} has invalid sentiment:`, analysis.sentiment);
        return {
          summary: null,
          category: null,
          priority: null,
          sentiment: null,
          actionItems: [],
          enrichedAt: new Date().toISOString(),
          version: '1.0',
          error: `Invalid sentiment value: ${analysis.sentiment}`
        };
      }
      
      // Valid analysis
      return {
        summary: analysis.summary,
        category: analysis.category,
        priority: analysis.priority,
        sentiment: analysis.sentiment,
        actionItems: Array.isArray(analysis.actionItems) ? analysis.actionItems : [],
        enrichedAt: new Date().toISOString(),
        version: '1.0',
        error: null
      };
    });
  } catch (parseError) {
    console.error('❌ Failed to parse Claude batch response:', response);
    throw new Error('Failed to parse Claude response as JSON array: ' + parseError.message);
  }
}

// Export the makeClaudeApiCall function for use in other services
export { makeClaudeApiCall };

// Get current rate limit status
export function getRateLimitStatus() {
  return {
    currentTokenUsage,
    timeSinceReset: Date.now() - lastResetTime,
    tokensPerMinute: RATE_LIMIT.tokensPerMinute,
    remainingTokens: Math.max(0, RATE_LIMIT.tokensPerMinute - currentTokenUsage)
  };
} 
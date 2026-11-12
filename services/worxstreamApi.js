import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// API Configuration for worXstream backend
const WORXSTREAM_API_CONFIG = {
  // Same variables and default as the Sign and Chat servers (API_BACKEND_URL, then the production API).
  baseURL: (
    process.env.WORXSTREAM_API_URL
    || process.env.API_BACKEND_URL
    || process.env.VITE_API_BACKEND_URL
    || 'https://api.worxstream.ai'
  ).replace(/\/+$/, ''),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
};

/**
 * The user object from a /api/user-info body. Same shapes the Sign and Chat servers accept:
 * `{ data: { user } }`, `{ user }`, or the user fields at the top level.
 */
export function extractUserFromUserInfo(body) {
  if (!body || typeof body !== 'object') return null;
  const nested = body.data && typeof body.data === 'object' ? body.data : null;
  const candidate = nested?.user ?? body.user ?? (body.id != null || body.email ? body : null) ?? (nested && (nested.id != null || nested.email) ? nested : null);
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate.id != null ? candidate : null;
}

class WorxstreamApiService {
  constructor(config) {
    this.baseURL = config.baseURL;
    this.timeout = config.timeout;
    this.headers = config.headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    
    console.log(`🌐 Making request to worXstream API: ${url}`);
    
    const config = {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers,
      },
    };

    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    config.signal = controller.signal;

    try {
      const response = await axios(url, config);
      clearTimeout(timeoutId);

      console.log(`✅ worXstream API response: ${response.status}`);

      if (!response.data.success && response.data.error) {
        throw {
          message: response.data.error,
          status: response.status,
          code: response.data.code,
        };
      }

      return response.data;
    } catch (error) {
      clearTimeout(timeoutId);
      
      console.error(`❌ worXstream API error:`, error.message);
      if (error.response) {
        console.error(`❌ Response status:`, error.response.status);
        console.error(`❌ Response data:`, error.response.data);
      }
      
      if (error.name === 'AbortError') {
        throw { message: 'Request timeout', status: 408 };
      }
      
      if (error.response) {
        throw {
          message: error.response.data?.error || `HTTP ${error.response.status}`,
          status: error.response.status,
          code: error.response.data?.code,
        };
      }
      
      throw { message: error.message, status: 500 };
    }
  }

  // Verify user token with worXstream backend
  async verifyUserToken(token) {
    try {
      console.log(`🔐 Verifying token with worXstream API...`);
      
      // Accept: application/json makes Laravel answer an unknown/old token with 401 JSON instead of redirecting
      // to a login page; redirects are not followed so a redirect is read as "token not accepted".
      const response = await this.request('/api/user-info', {
        method: 'GET',
        maxRedirects: 0,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      
      console.log('✅ Token verification successful');
      
      // The response should already contain the user data structure
      // Check if it has the expected format
      const user = extractUserFromUserInfo(response);
      if (user) {
        return { success: true, user };
      } else {
        // A 200 that is not user data (for example a login page) means the token was not accepted.
        console.warn('⚠️ Token verification: response is not user data');
        return {
          success: false,
          error: 'Token not accepted',
          status: 401,
        };
      }
    } catch (error) {
      console.error(`❌ Token verification failed:`, error.message);
      return {
        success: false,
        error: error.message,
        status: error.status,
      };
    }
  }

  // Get user info by token
  async getUserInfo(token) {
    const response = await this.request('/api/user-info', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    
    return response;
  }

  // Note: Subscription validation is now handled through the user info API
  // which includes subscription details, eliminating the need for separate API calls
}

// Export the config for use in other files
export { WORXSTREAM_API_CONFIG };

// Create API instance
export const worxstreamApi = new WorxstreamApiService(WORXSTREAM_API_CONFIG);

// Default export for the class
export default WorxstreamApiService; 
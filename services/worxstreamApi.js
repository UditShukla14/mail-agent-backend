import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// API Configuration for worXstream backend
const WORXSTREAM_API_CONFIG = {
  baseURL: process.env.WORXSTREAM_API_URL || 'http://localhost:8000',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
};

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

      console.log(`✅ worXstream API response:`, response.status, response.data);

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
      
      const response = await this.request('/api/user-info', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      
      console.log(`✅ Token verification successful:`, response);
      console.log(`🔍 Response structure:`, {
        hasUser: !!response.user,
        hasId: !!response.id,
        hasEmail: !!response.email,
        responseKeys: Object.keys(response),
        responseType: typeof response
      });
      
      // The response should already contain the user data structure
      // Check if it has the expected format
      if (response && (response.user || response.id || response.email)) {
        return {
          success: true,
          user: response.user || response, // Use response.user if it exists, otherwise use response directly
        };
      } else {
        console.warn('⚠️ Unexpected response format:', response);
        return {
          success: false,
          error: 'Invalid response format from API',
          status: 500,
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
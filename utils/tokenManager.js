// utils/tokenManager.js
import axios from 'axios';
import Token from '../models/Token.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import dotenv from 'dotenv';

dotenv.config();

// In-memory token cache to prevent excessive DB queries
const tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// 🔁 Get valid access_token or refresh if expired
export const getToken = async (worxstreamUserId, email, provider) => {
  try {
    // Ensure worxstreamUserId is a number
    const numericUserId = Number(worxstreamUserId);
    
    const cacheKey = `${numericUserId}:${email}:${provider}`;
    const cached = tokenCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.token;
    }

    const tokenDoc = await Token.findOne({ worxstreamUserId: numericUserId, email, provider });
    
    if (!tokenDoc) {
      return null;
    }

    const access_token = tokenDoc.access_token;
    if (!access_token) {
      return null;
    }

    const refresh_token = tokenDoc.refresh_token;
    if (!refresh_token) {
      return null;
    }

    const { expires_in, timestamp } = tokenDoc;

    const isExpired = Date.now() > timestamp + expires_in * 1000 - 60000;
    console.log('🔍 Debug: Token expiration check:', {
      email,
      isExpired,
      currentTime: Date.now(),
      tokenTimestamp: timestamp,
      expiresIn: expires_in,
      expirationTime: timestamp + expires_in * 1000 - 60000
    });
    
    if (!isExpired) {
      // Cache the valid token
      tokenCache.set(cacheKey, {
        token: access_token,
        timestamp: Date.now()
      });
      return access_token;
    }

    const refreshed = await refreshToken(refresh_token, provider);
    if (refreshed) {
      tokenDoc.access_token = refreshed.access_token;
      tokenDoc.refresh_token = refreshed.refresh_token;
      tokenDoc.expires_in = refreshed.expires_in;
      tokenDoc.timestamp = refreshed.timestamp;
      await tokenDoc.save();
      
      // Cache the refreshed token
      tokenCache.set(cacheKey, {
        token: refreshed.access_token,
        timestamp: Date.now()
      });
      return refreshed.access_token;
    }

    // If refresh failed, mark the token as expired in EmailAccount
    try {
      const EmailAccount = (await import('../models/EmailAccount.js')).default;
      await EmailAccount.findOneAndUpdate(
        { email, provider },
        { isExpired: true }
      );
    } catch (emailAccountError) {
      console.error(`❌ Failed to update EmailAccount for ${email}:`, emailAccountError);
    }

    return null;
  } catch (err) {
    console.error(`❌ Error getting token for ${email}:`, err);
    return null;
  }
};

// 💾 Save token (no encryption needed since we're using worXstream auth)
export const saveToken = async (worxstreamUserId, email, tokenResponse, provider) => {
  try {
    const { access_token, refresh_token, expires_in } = tokenResponse;

    if (!access_token || !refresh_token) {
      console.error(`❌ Missing tokens for ${email}`);
      return false;
    }

    const tokenDoc = await Token.findOneAndUpdate(
      { worxstreamUserId, email, provider },
      {
        access_token,
        refresh_token,
        expires_in,
        timestamp: Date.now()
      },
      { upsert: true, new: true }
    );

    
    // Create or update EmailAccount record
    try {
      
      // Find the user to get their MongoDB _id
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error(`❌ User not found for worxstreamUserId: ${worxstreamUserId}`);
        throw new Error('User not found');
      }
      
      // Create or update EmailAccount record
      const emailAccount = await EmailAccount.findOneAndUpdate(
        { userId: user._id, email },
        {
          userId: user._id,
          email,
          provider,
          isActive: true
        },
        { upsert: true, new: true }
      );
      
    } catch (emailAccountError) {
      console.error(`❌ Failed to create EmailAccount record for ${email}:`, emailAccountError);
      // Don't fail the entire token save process if EmailAccount creation fails
      // The EmailAccount will be created when needed by other features
    }
    
    // Add a small delay to ensure the token is properly saved
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify the token was saved
    const savedToken = await getToken(worxstreamUserId, email, provider);
    if (!savedToken) {
      console.error(`❌ Token verification failed after save for ${email}`);
      throw new Error('Token verification failed after save');
    }
    
    return true;
  } catch (err) {
    console.error(`❌ Failed to save token for ${email}:`, err);
    return false;
  }
};

// 🔁 Refresh token using provider-specific logic
export const refreshToken = async (refresh_token, provider) => {
  try {
    
    let url, data;

    if (provider === 'outlook') {
      url = `https://login.microsoftonline.com/common/oauth2/v2.0/token`;
      data = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        refresh_token,
        grant_type: "refresh_token",
        redirect_uri: process.env.REDIRECT_URI
      });
    } else if (provider === 'gmail') {
      url = 'https://oauth2.googleapis.com/token';
      data = new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        refresh_token,
        grant_type: "refresh_token"
      });
    }

    const res = await axios.post(url, data, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const { access_token, refresh_token: new_refresh, expires_in } = res.data;
    
    console.log(`✅ Token refresh successful for ${provider}:`, {
      hasAccessToken: !!access_token,
      hasRefreshToken: !!new_refresh,
      expiresIn: expires_in
    });

    return {
      access_token,
      refresh_token: new_refresh || refresh_token,
      expires_in,
      timestamp: Date.now()
    };
  } catch (err) {
    console.error(`🔴 Token refresh failed (${provider}):`, err?.response?.data || err.message);
    console.error(`🔴 Full error details:`, {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message
    });
    
    // Check if the refresh token itself is invalid
    if (err.response?.status === 400 || err.response?.status === 401) {
      const errorData = err.response?.data;
      if (errorData?.error === 'invalid_grant' || errorData?.error_description?.includes('refresh')) {
        // The user will need to re-authenticate to get a new refresh token
      }
    }
    
    return null;
  }
};

// 🗑️ Delete token for a user
export const deleteToken = async (worxstreamUserId, email, provider) => {
  try {
    // Ensure worxstreamUserId is a number
    const numericUserId = Number(worxstreamUserId);
    
    const result = await Token.deleteOne({ worxstreamUserId: numericUserId, email, provider });
    
    if (result.deletedCount > 0) {
      return true;
    } else {
      return false;
    }
  } catch (err) {
    console.error(`❌ Error deleting token for ${email}:`, err);
    return false;
  }
};

// 📋 Get all tokens for a user (with automatic refresh)
export const getUserTokens = async (worxstreamUserId) => {
  try {
    // Ensure worxstreamUserId is a number
    const numericUserId = Number(worxstreamUserId);
    const tokens = await Token.find({ worxstreamUserId: numericUserId });
    
    const refreshedTokens = [];
    
    for (const token of tokens) {
      const isExpired = Date.now() > token.timestamp + token.expires_in * 1000 - 60000;
      
      if (isExpired) {
        // Try to refresh the token
        const refreshed = await refreshToken(token.refresh_token, token.provider);
        
        if (refreshed) {
          // Update the token in the database
          token.access_token = refreshed.access_token;
          token.refresh_token = refreshed.refresh_token;
          token.expires_in = refreshed.expires_in;
          token.timestamp = refreshed.timestamp;
          await token.save();
          
          
          refreshedTokens.push({
            email: token.email,
            provider: token.provider,
            expires_in: refreshed.expires_in,
            timestamp: refreshed.timestamp,
            isExpired: false // Token is now fresh
          });
        } else {
          refreshedTokens.push({
            email: token.email,
            provider: token.provider,
            expires_in: token.expires_in,
            timestamp: token.timestamp,
            isExpired: true
          });
        }
      } else {
        // Token is still valid
        refreshedTokens.push({
          email: token.email,
          provider: token.provider,
          expires_in: token.expires_in,
          timestamp: token.timestamp,
          isExpired: false
        });
      }
    }
    
    return refreshedTokens;
  } catch (err) {
    console.error(`❌ Error getting tokens for worxstreamUserId ${worxstreamUserId}:`, err);
    return [];
  }
};

// Clear token cache (useful for testing or when tokens are updated)
export const clearTokenCache = () => {
  tokenCache.clear();
};

// 🔄 Manually refresh a specific token
export const refreshSpecificToken = async (worxstreamUserId, email, provider) => {
  try {
    
    const numericUserId = Number(worxstreamUserId);
    const tokenDoc = await Token.findOne({ worxstreamUserId: numericUserId, email, provider });
    
    if (!tokenDoc) {
      return false;
    }
    
    const refreshed = await refreshToken(tokenDoc.refresh_token, provider);
    if (refreshed) {
      tokenDoc.access_token = refreshed.access_token;
      tokenDoc.refresh_token = refreshed.refresh_token;
      tokenDoc.expires_in = refreshed.expires_in;
      tokenDoc.timestamp = refreshed.timestamp;
      await tokenDoc.save();
      
      // Clear cache for this token
      const cacheKey = `${numericUserId}:${email}:${provider}`;
      tokenCache.delete(cacheKey);
      
      return true;
    } else {
      return false;
    }
  } catch (err) {
    console.error(`❌ Error refreshing token for ${email}:`, err);
    return false;
  }
};

// Get cache stats (useful for debugging)
export const getTokenCacheStats = () => {
  return {
    size: tokenCache.size,
    entries: Array.from(tokenCache.keys())
  };
};

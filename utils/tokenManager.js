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
    const cacheKey = `${worxstreamUserId}:${email}:${provider}`;
    const cached = tokenCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.token;
    }

    const tokenDoc = await Token.findOne({ worxstreamUserId, email, provider });
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

    return null;
  } catch (err) {
    console.error(`❌ Error getting token for ${email}:`, err);
    return null;
  }
};

// 💾 Save token (no encryption needed since we're using worXstream auth)
export const saveToken = async (worxstreamUserId, email, tokenResponse, provider) => {
  try {
    console.log(`🔄 Saving token for ${email} (${provider}) with worxstreamUserId: ${worxstreamUserId}`);
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

    console.log(`✅ Token saved with ID: ${tokenDoc._id}`);
    
    // Create or update EmailAccount record
    try {
      console.log(`🔄 Creating/updating EmailAccount record for ${email}`);
      
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
      
      console.log(`✅ EmailAccount record created/updated with ID: ${emailAccount._id}`);
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
    
    console.log(`✅ Token verified for ${email}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to save token for ${email}:`, err);
    return false;
  }
};

// 🔁 Refresh token using provider-specific logic
const refreshToken = async (refresh_token, provider) => {
  try {
    let url, data;

    if (provider === 'outlook') {
      url = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
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
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: "refresh_token"
      });
    }

    const res = await axios.post(url, data, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const { access_token, refresh_token: new_refresh, expires_in } = res.data;

    return {
      access_token,
      refresh_token: new_refresh || refresh_token,
      expires_in,
      timestamp: Date.now()
    };
  } catch (err) {
    console.error(`🔴 Token refresh failed (${provider}):`, err?.response?.data || err.message);
    return null;
  }
};

// 🗑️ Delete token for a user
export const deleteToken = async (worxstreamUserId, email, provider) => {
  try {
    console.log(`🔄 Deleting token for ${email} (${provider}) with worxstreamUserId: ${worxstreamUserId}`);
    const result = await Token.deleteOne({ worxstreamUserId, email, provider });
    
    if (result.deletedCount > 0) {
      console.log(`✅ Token deleted for ${email}`);
      return true;
    } else {
      console.log(`❌ No token found to delete for ${email}`);
      return false;
    }
  } catch (err) {
    console.error(`❌ Error deleting token for ${email}:`, err);
    return false;
  }
};

// 📋 Get all tokens for a user
export const getUserTokens = async (worxstreamUserId) => {
  try {
    const tokens = await Token.find({ worxstreamUserId });
    
    return tokens.map(token => ({
      email: token.email,
      provider: token.provider,
      accessToken: token.access_token, // Include the actual access token
      expires_in: token.expires_in,
      timestamp: token.timestamp,
      isExpired: Date.now() > token.timestamp + token.expires_in * 1000 - 60000
    }));
  } catch (err) {
    console.error(`❌ Error getting tokens for worxstreamUserId ${worxstreamUserId}:`, err);
    return [];
  }
};

// Clear token cache (useful for testing or when tokens are updated)
export const clearTokenCache = () => {
  tokenCache.clear();
  console.log('🗑️ Token cache cleared');
};

// Get cache stats (useful for debugging)
export const getTokenCacheStats = () => {
  return {
    size: tokenCache.size,
    entries: Array.from(tokenCache.keys())
  };
};

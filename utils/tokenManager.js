// utils/tokenManager.js
import axios from 'axios';
import Token from '../models/Token.js';
import dotenv from 'dotenv';
import CryptoJS from 'crypto-js';

dotenv.config();
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  console.error('❌ TOKEN_ENCRYPTION_KEY is not defined in environment variables');
  process.exit(1);
}

// Create a derived key using PBKDF2
const deriveKey = (key) => {
  const salt = CryptoJS.enc.Utf8.parse('mail-agent-salt');
  return CryptoJS.PBKDF2(key, salt, {
    keySize: 256 / 32,
    iterations: 1000
  });
};

const derivedKey = deriveKey(ENCRYPTION_KEY);

// 🔐 Encrypt any value using AES
const encrypt = (text) => {
  try {
    if (!text) {
      console.error('❌ Attempted to encrypt null or undefined value');
      return null;
    }
    const encrypted = CryptoJS.AES.encrypt(text, derivedKey, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString();
  } catch (error) {
    console.error('❌ Encryption failed:', error);
    return null;
  }
};

// 🔐 Decrypt AES-encrypted value
const decrypt = (cipherText) => {
  try {
    if (!cipherText) {
      console.error('❌ Attempted to decrypt null or undefined value');
      return null;
    }
    const bytes = CryptoJS.AES.decrypt(cipherText, derivedKey, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7
    });
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    if (!decrypted) {
      throw new Error('Decryption resulted in empty string');
    }
    return decrypted;
  } catch (error) {
    console.error('❌ Decryption failed:', error);
    return null;
  }
};

// 🔁 Get valid access_token or refresh if expired
export const getToken = async (appUserId, email, provider) => {
  try {
    console.log(`🔄 Getting token for ${email} (${provider}) with appUserId: ${appUserId}`);
    const tokenDoc = await Token.findOne({ appUserId, email, provider });
    if (!tokenDoc) {
      console.log(`❌ Token not found in DB for ${email} (${provider})`);
      return null;
    }

    console.log(`✅ Token found in DB for ${email}`);
    const access_token = decrypt(tokenDoc.access_token);
    if (!access_token) {
      console.error(`❌ Failed to decrypt access token for ${email}`);
      return null;
    }

    const refresh_token = decrypt(tokenDoc.refresh_token);
    if (!refresh_token) {
      console.error(`❌ Failed to decrypt refresh token for ${email}`);
      return null;
    }

    const { expires_in, timestamp } = tokenDoc;

    const isExpired = Date.now() > timestamp + expires_in * 1000 - 60000;
    if (!isExpired) {
      console.log(`✅ Token is still valid for ${email}`);
      return access_token;
    }

    console.log(`🔄 Token expired for ${email}, refreshing...`);
    const refreshed = await refreshToken(refresh_token, provider);
    if (refreshed) {
      const encryptedAccessToken = encrypt(refreshed.access_token);
      const encryptedRefreshToken = encrypt(refreshed.refresh_token);
      
      if (!encryptedAccessToken || !encryptedRefreshToken) {
        console.error(`❌ Failed to encrypt refreshed tokens for ${email}`);
        return null;
      }

      tokenDoc.access_token = encryptedAccessToken;
      tokenDoc.refresh_token = encryptedRefreshToken;
      tokenDoc.expires_in = refreshed.expires_in;
      tokenDoc.timestamp = refreshed.timestamp;
      await tokenDoc.save();
      console.log(`✅ Token refreshed successfully for ${email}`);
      return refreshed.access_token;
    }

    console.log(`❌ Token refresh failed for ${email}`);
    return null;
  } catch (err) {
    console.error(`❌ Error getting token for ${email}:`, err);
    return null;
  }
};

// 💾 Save token securely (encrypted)
export const saveToken = async (appUserId, email, tokenResponse, provider) => {
  try {
    console.log(`🔄 Saving token for ${email} (${provider}) with appUserId: ${appUserId}`);
    const { access_token, refresh_token, expires_in } = tokenResponse;

    const encryptedAccessToken = encrypt(access_token);
    const encryptedRefreshToken = encrypt(refresh_token);

    if (!encryptedAccessToken || !encryptedRefreshToken) {
      console.error(`❌ Failed to encrypt tokens for ${email}`);
      return false;
    }

    const encryptedToken = await Token.findOneAndUpdate(
      { appUserId, email, provider },
      {
        access_token: encryptedAccessToken,
        refresh_token: encryptedRefreshToken,
        expires_in,
        timestamp: Date.now()
      },
      { upsert: true, new: true }
    );

    console.log(`✅ Token saved with ID: ${encryptedToken._id}`);
    
    // Add a small delay to ensure the token is properly saved
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify the token was saved
    const savedToken = await getToken(appUserId, email, provider);
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

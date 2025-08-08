// controllers/authController.js
import axios from 'axios';
import dotenv from 'dotenv';
import { saveToken, getToken } from '../utils/tokenManager.js';
import { google } from 'googleapis';
import { authenticateUser } from '../middleware/auth.js';

dotenv.config();

const { 
  CLIENT_ID, 
  CLIENT_SECRET, 
  REDIRECT_URI,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI 
} = process.env;

// 1️⃣ Redirect to Microsoft Login
export const outlookLogin = async (req, res) => {
  try {
    // Verify user is authenticated with worXstream
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    const worxstreamUserId = req.user.id;
    const { callbackUrl } = req.query;

    const scopes = [
      'openid',
      'profile',
      'email',
      'offline_access',
      'User.Read',
      'Mail.ReadWrite',
      'Mail.Send'
    ].join(' ');

    const statePayload = Buffer.from(JSON.stringify({ worxstreamUserId, callbackUrl })).toString('base64');
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
      `?client_id=${CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_mode=query` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&prompt=select_account` +
      `&state=${statePayload}`;

    res.json({
      success: true,
      authUrl,
      worxstreamUserId
    });
  } catch (error) {
    console.error('Outlook login error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate Outlook login',
      code: 'LOGIN_INIT_ERROR'
    });
  }
};

// 2️⃣ Handle Redirect and Token Exchange
export const outlookRedirect = async (req, res) => {
  const code = req.query.code;
  let state;

  console.log('Received query:', req.query);

  try {
    state = JSON.parse(Buffer.from(req.query.state, 'base64').toString());
  } catch (err) {
    return res.status(400).send('Invalid state parameter');
  }

  const { worxstreamUserId, callbackUrl } = state;

  if (!code || !worxstreamUserId) {
    return res.status(400).send('Missing code or worxstreamUserId');
  }

  try {
    console.log('🔄 Exchanging code for token...');
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    console.log('✅ Token received from Microsoft');

    console.log('🔄 Fetching user profile...');
    const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const outlookUser = profileRes.data;
    const email = outlookUser.mail || outlookUser.userPrincipalName;
    console.log(`✅ User profile fetched: ${email}`);

    console.log('🔄 Saving tokens...');
    const saved = await saveToken(worxstreamUserId, email, { access_token, refresh_token, expires_in }, 'outlook');
    if (!saved) {
      throw new Error('Failed to save token');
    }
    console.log('✅ Tokens saved successfully');

    console.log('🔄 Verifying token...');
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) {
      throw new Error('Token verification failed');
    }
    console.log('✅ Token verified');

    if (callbackUrl) {
      const redirectUrl = new URL(callbackUrl);
      redirectUrl.searchParams.set('provider', 'outlook');
      redirectUrl.searchParams.set('worxstreamUserId', worxstreamUserId);
      redirectUrl.searchParams.set('email', email);
      redirectUrl.searchParams.set('success', 'true');
      return res.redirect(redirectUrl.toString());
    }

    res.send(`
      <html>
        <head>
          <title>Account Connected</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 2rem; }
            .success { color: #22c55e; font-size: 1.5rem; margin-bottom: 1rem; }
            .message { color: #64748b; }
          </style>
        </head>
        <body>
          <div class="success">✅ Account Connected Successfully</div>
          <div class="message">You can now close this window and return to the dashboard.</div>
          <script>
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Outlook OAuth error:', err?.response?.data || err.message);

    if (callbackUrl) {
      const redirectUrl = new URL(callbackUrl);
      redirectUrl.searchParams.set('error', 'oauth_failed');
      redirectUrl.searchParams.set('error_details', err?.response?.data?.error_description || err.message);
      return res.redirect(redirectUrl.toString());
    }

    res.status(500).send(`
      <html>
        <head>
          <title>Connection Failed</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 2rem; }
            .error { color: #ef4444; font-size: 1.5rem; margin-bottom: 1rem; }
            .message { color: #64748b; }
          </style>
        </head>
        <body>
          <div class="error">❌ Connection Failed</div>
          <div class="message">Please try again or contact support if the problem persists.</div>
        </body>
      </html>
    `);
  }
};

// Gmail OAuth Functions
export const gmailLogin = async (req, res) => {
  try {
    // Verify user is authenticated with worXstream
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    const worxstreamUserId = req.user.id;
    const { callbackUrl } = req.query;

    const oauth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REDIRECT_URI
    );

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    const statePayload = Buffer.from(JSON.stringify({ worxstreamUserId, callbackUrl })).toString('base64');
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: statePayload,
      prompt: 'consent'
    });

    res.json({
      success: true,
      authUrl,
      worxstreamUserId
    });
  } catch (error) {
    console.error('Gmail login error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate Gmail login',
      code: 'LOGIN_INIT_ERROR'
    });
  }
};

export const gmailRedirect = async (req, res) => {
  const code = req.query.code;
  let state;

  try {
    state = JSON.parse(Buffer.from(req.query.state, 'base64').toString());
  } catch (err) {
    return res.status(400).send('Invalid state parameter');
  }

  const { worxstreamUserId, callbackUrl } = state;

  if (!code || !worxstreamUserId) {
    return res.status(400).send('Missing code or worxstreamUserId');
  }

  try {
    console.log('🔄 Exchanging code for Gmail token...');
    const oauth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);
    const { access_token, refresh_token, expiry_date } = tokens;
    console.log('✅ Token received from Google');

    console.log('🔄 Fetching user profile...');
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2'
    });

    const profile = await oauth2.userinfo.get();
    const email = profile.data.email;
    console.log(`✅ User profile fetched: ${email}`);

    console.log('🔄 Saving tokens...');
    const saved = await saveToken(worxstreamUserId, email, {
      access_token,
      refresh_token,
      expires_in: Math.floor((expiry_date - Date.now()) / 1000)
    }, 'gmail');

    if (!saved) {
      throw new Error('Failed to save token');
    }
    console.log('✅ Tokens saved successfully');

    console.log('🔄 Verifying token...');
    const token = await getToken(worxstreamUserId, email, 'gmail');
    if (!token) {
      throw new Error('Token verification failed');
    }
    console.log('✅ Token verified');

    if (callbackUrl) {
      const redirectUrl = new URL(callbackUrl);
      redirectUrl.searchParams.set('provider', 'gmail');
      redirectUrl.searchParams.set('worxstreamUserId', worxstreamUserId);
      redirectUrl.searchParams.set('email', email);
      redirectUrl.searchParams.set('success', 'true');
      return res.redirect(redirectUrl.toString());
    }

    res.send(`
      <html>
        <head>
          <title>Account Connected</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 2rem; }
            .success { color: #22c55e; font-size: 1.5rem; margin-bottom: 1rem; }
            .message { color: #64748b; }
          </style>
        </head>
        <body>
          <div class="success">✅ Account Connected Successfully</div>
          <div class="message">You can now close this window and return to the dashboard.</div>
          <script>
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Gmail OAuth error:', err?.response?.data || err.message);

    if (callbackUrl) {
      const redirectUrl = new URL(callbackUrl);
      redirectUrl.searchParams.set('error', 'oauth_failed');
      redirectUrl.searchParams.set('error_details', err?.response?.data?.error_description || err.message);
      return res.redirect(redirectUrl.toString());
    }

    res.status(500).send(`
      <html>
        <head>
          <title>Connection Failed</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 2rem; }
            .error { color: #ef4444; font-size: 1.5rem; margin-bottom: 1rem; }
            .message { color: #64748b; }
          </style>
        </head>
        <body>
          <div class="error">❌ Connection Failed</div>
          <div class="message">Please try again or contact support if the problem persists.</div>
        </body>
      </html>
    `);
  }
};

// 3️⃣ Handle Frontend Callback
export const handleCallback = async (req, res) => {
  const { worxstreamUserId, provider, email } = req.body;

  if (!worxstreamUserId || !provider || !email) {
    return res.status(400).json({ 
      error: 'Missing required parameters' 
    });
  }

  try {
    console.log(`🔄 Verifying account: ${email} (${provider})`);
    const token = await getToken(worxstreamUserId, email, provider);
    if (!token) {
      throw new Error('Account not found');
    }

    console.log(`✅ Account verified: ${email}`);
    return res.json({ 
      success: true, 
      email,
      provider
    });
  } catch (err) {
    console.error('❌ Callback verification error:', err);
    return res.status(500).json({ 
      error: 'Failed to verify account',
      details: err.message
    });
  }
};

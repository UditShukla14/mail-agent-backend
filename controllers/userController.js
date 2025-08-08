// controllers/userController.js
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Token from '../models/Token.js';

const JWT_SECRET = 'dev-secret';

// POST /register
export const registerUser = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash });

    // Generate token for the new user
    const token = jwt.sign(
      { userId: user._id, worxstreamUserId: user.worxstreamUserId, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const isProduction = process.env.NODE_ENV === 'production';
    const cookieDomain = isProduction ? '.worxstream.io' : undefined;
    const cookieSameSite = isProduction ? 'none' : 'lax';

    // Set the token as an HTTP-only cookie for cross-site usage
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction, // true in production, false in dev
      sameSite: cookieSameSite,
      domain: cookieDomain,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    // Set the worxstreamUserId as a cookie for middleware auth
    res.cookie('worxstreamUserId', user.worxstreamUserId, {
      httpOnly: false, // Can be read by the browser if needed
      secure: isProduction,
      sameSite: cookieSameSite,
      domain: cookieDomain,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
      message: 'User registered successfully.',
      token,
      worxstreamUserId: user.worxstreamUserId
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
};

// POST /login
export const loginUser = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign(
      { userId: user._id, worxstreamUserId: user.worxstreamUserId, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const isProduction = process.env.NODE_ENV === 'production';
    const cookieDomain = isProduction ? '.worxstream.io' : undefined;
    const cookieSameSite = isProduction ? 'none' : 'lax';

    // Set the token as an HTTP-only cookie for cross-site usage
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction, // true in production, false in dev
      sameSite: cookieSameSite,
      domain: cookieDomain,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    // Set the worxstreamUserId as a cookie for middleware auth
    res.cookie('worxstreamUserId', user.worxstreamUserId, {
      httpOnly: false, // Can be read by the browser if needed
      secure: isProduction,
      sameSite: cookieSameSite,
      domain: cookieDomain,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({ token, worxstreamUserId: user.worxstreamUserId });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
};

// GET /profile - Get user profile data
export const getUserProfile = async (req, res) => {
  try {
    const { worxstreamUserId } = req.query;
    
    if (!worxstreamUserId) {
      return res.status(400).json({ error: 'worxstreamUserId is required' });
    }

    // Get user details
    const user = await User.findOne({ worxstreamUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get linked accounts
    const tokens = await Token.find({ worxstreamUserId });
    const linkedAccounts = tokens.map(token => ({
      email: token.email,
      provider: token.provider,
      createdAt: token.createdAt
    }));

    // Calculate account statistics
    const totalAccounts = linkedAccounts.length;
    const outlookAccounts = linkedAccounts.filter(acc => acc.provider === 'outlook').length;
    const gmailAccounts = linkedAccounts.filter(acc => acc.provider === 'gmail').length;

    const profile = {
      user: {
        email: user.email,
        worxstreamUserId: user.worxstreamUserId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      accounts: {
        total: totalAccounts,
        outlook: outlookAccounts,
        gmail: gmailAccounts,
        linkedAccounts
      }
    };

    res.json(profile);
  } catch (err) {
    console.error('Profile fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
};

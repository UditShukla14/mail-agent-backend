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
      { userId: user._id, appUserId: user.appUserId, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set the token as an HTTP-only cookie for cross-site usage
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      domain: '.worxstream.io',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
      message: 'User registered successfully.',
      token,
      appUserId: user.appUserId
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
      { userId: user._id, appUserId: user.appUserId, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set the token as an HTTP-only cookie for cross-site usage
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      domain: '.worxstream.io',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({ token, appUserId: user.appUserId });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
};

// GET /profile - Get user profile data
export const getUserProfile = async (req, res) => {
  try {
    const { appUserId } = req.query;
    
    if (!appUserId) {
      return res.status(400).json({ error: 'appUserId is required' });
    }

    // Get user details
    const user = await User.findOne({ appUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get linked accounts
    const tokens = await Token.find({ appUserId });
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
        appUserId: user.appUserId,
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

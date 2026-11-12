import { verifyBearerToken, DEV_USER, isDevFallbackAllowed } from './utils/authVerify.js';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import emailsRoutes from './routes/emails.js';
import { initMailSocket } from './sockets/mailSocket.js';
import connectDB from './utils/db.js';
import emailEnrichmentService from './services/emailEnrichment.js';
import axios from 'axios'; // Added axios for token verification

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import accountRoutes from './routes/account.js';
import emailAnalyticsRoutes from './routes/emailAnalytics.js';
import emailCategoriesRoutes from './routes/emailCategories.js';
import aiReplyRoutes from './routes/aiReply.js';
import tokenRefreshRoutes from './routes/tokenRefresh.js';
import calendarRoutes from './routes/calendar.js';
import focusRoutes from './routes/focus.js';
import webhookRoutes from './routes/webhooks.js';

import './services/enrichmentQueueService.js'; // This will initialize the service
import tokenRefreshService from './services/tokenRefreshService.js';
import notificationService from './services/notificationService.js';
import outlookSubscriptionRenewalService from './services/outlookSubscriptionRenewalService.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration for worXstream integration
const allowedOrigins = [
  'http://localhost:4173', // worXstream web app (local dev)
  'https://app.worxstream.ai', // worXstream web app (production)
  // Anything else, comma-separated, e.g. CORS_ORIGINS=https://staging.example.com
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Info'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar']
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Add a middleware to ensure CORS headers are set
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Info');
  }
  next();
});

// Socket.IO configuration
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Info'],
    exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar']
  },
  path: '/socket.io',
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: true,
  allowUpgrades: true,
  cookie: {
    name: 'io',
    path: '/',
    httpOnly: true,
    sameSite: 'none',
    secure: true
  }
});

// Set the IO instance for the email enrichment service
emailEnrichmentService.setIO(io);

// Set the IO instance for the notification service
notificationService.setIO(io);

// Memory management and cleanup
const cleanup = () => {
  console.log('🧹 Running memory cleanup...');
  
  // Clear token cache periodically
  if (global.gc) {
    global.gc();
    console.log('🗑️ Garbage collection completed');
  }
  
  // Clear any accumulated data structures
  if (global.tokenCache) {
    global.tokenCache.clear();
  }
};

// Run cleanup every 5 minutes
setInterval(cleanup, 5 * 60 * 1000);

// Add a middleware to handle WebSocket upgrade requests
app.use((req, res, next) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }
  next();
});

// Middleware
app.use(express.json());
app.use(cookieParser());

// Public Microsoft Graph webhooks (no worXstream JWT)
app.use('/webhooks', webhookRoutes);

// Routes
app.use('/user', userRoutes);
app.use('/auth', authRoutes);
app.use('/account', accountRoutes);
app.use('/email-analytics', emailAnalyticsRoutes);
app.use('/emails', emailsRoutes);
app.use('/email-categories', emailCategoriesRoutes);
app.use('/ai-reply', aiReplyRoutes);
app.use('/token-refresh', tokenRefreshRoutes);
app.use('/calendar', calendarRoutes);
app.use('/focus', focusRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Mail Agent Backend is running 🚀',
    integration: 'worXstream',
    version: '2.0.0'
  });
});

// Initialize socket handlers
io.use(async (socket, next) => {
  try {
    // Identity comes only from verifying the bearer token with worXstream; user info supplied by the
    // client (handshake query or payloads) is never trusted.
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const { user, reason } = await verifyBearerToken(token);
    if (user) {
      socket.user = user;
      socket.token = token;
      console.log('✅ Socket authenticated for user:', user.email);
      return next();
    }

    if (isDevFallbackAllowed() && reason !== 'invalid') {
      console.log('⚠️ Development mode: worXstream unreachable, using the development user');
      socket.user = { ...DEV_USER };
      socket.token = token;
      return next();
    }

    console.log(`❌ Socket authentication failed (${reason || 'invalid'})`);
    return next(new Error(reason === 'unavailable' ? 'Authentication service unavailable' : 'Invalid token'));
  } catch (error) {
    console.error('❌ Socket authentication error:', error.message);
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id, 'User:', socket.user?.email);
  
  // Log connection event
  console.log(`📨 Socket connected: ${socket.id} for user: ${socket.user?.email}`);

  initMailSocket(socket, io);

  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
    
    // Clean up user-specific data
    if (socket.worxstreamUserId) {
      console.log(`🧹 Cleaning up socket data for user: ${socket.worxstreamUserId}`);
      // Remove from enrichment service
      try {
        emailEnrichmentService.unregisterSocket(socket);
      } catch (error) {
        console.log('⚠️ Error unregistering socket from enrichment service:', error.message);
      }
    }
  });
  
  // Add debugging for all events (commented out as onAny is not available in this Socket.IO version)
  // socket.onAny((eventName, ...args) => {
  //   console.log(`📨 Socket event received: ${eventName}`, args);
  // });
});

// Connect to MongoDB
connectDB();

const PORT = process.env.PORT || 8000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Mail Agent Backend running on port ${PORT}`);
  console.log(`🔗 Integrated with worXstream backend: ${process.env.WORXSTREAM_API_URL || process.env.API_BACKEND_URL || 'https://api.worxstream.ai'}`);
  
  // Start the token refresh service
  tokenRefreshService.start();
  console.log('🔄 Token refresh service started');

  // Outlook Graph subscription renewal + one-time backfill for existing accounts
  outlookSubscriptionRenewalService.start();
  outlookSubscriptionRenewalService.backfill().catch((err) => {
    console.error('❌ Outlook subscription startup backfill failed:', err.message);
  });
});

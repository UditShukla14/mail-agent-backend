import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { initMailSocket } from './sockets/mailSocket.js';
import connectDB from './utils/db.js';
import emailEnrichmentService from './services/emailEnrichment.js';


import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import accountRoutes from './routes/account.js';
import emailAnalyticsRoutes from './routes/emailAnalytics.js';
import emailCategoriesRoutes from './routes/emailCategories.js';
import aiReplyRoutes from './routes/aiReply.js';
import tokenRefreshRoutes from './routes/tokenRefresh.js';

import './services/enrichmentQueueService.js'; // This will initialize the service
import tokenRefreshService from './services/tokenRefreshService.js';
import notificationService from './services/notificationService.js';

dotenv.config();

// Environment Variables:
// - NODE_ENV: Set to 'development' for verbose logging, 'production' for minimal logging
// - JWT_SECRET: Secret key for JWT token verification (must match frontend secret)

const app = express();
const httpServer = createServer(app);

// CORS configuration for worXstream integration
const allowedOrigins = [
  'http://localhost:3000', // worXstream frontend dev
  'http://localhost:4173', // Mail agent frontend dev
  'http://localhost:4174', // worXstream frontend dev (Vite)
  'https://xmail.worxstream.io', // Mail agent subdomain
  'https://worxstream.io', // Main worXstream domain
  'https://app.worxstream.io' // Main app domain
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
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar']
  },
  path: '/socket.io',
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: false, // Disable EIO3 to prevent session issues
  allowUpgrades: true,
  cookie: false, // Disable cookie to prevent session conflicts
  serveClient: false, // Don't serve client files
  maxHttpBufferSize: 1e6, // 1MB buffer
  upgradeTimeout: 10000, // 10 second upgrade timeout
  allowRequest: (req, callback) => {
    // Allow all requests for now, authentication happens in middleware
    callback(null, true);
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

// Routes
app.use('/user', userRoutes);
app.use('/auth', authRoutes);
app.use('/account', accountRoutes);
app.use('/email-analytics', emailAnalyticsRoutes);
app.use('/email-categories', emailCategoriesRoutes);
app.use('/ai-reply', aiReplyRoutes);
app.use('/token-refresh', tokenRefreshRoutes);

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
    console.log('🔐 Socket authentication check for:', socket.id);
    
    // Debug: Log what we're receiving
    console.log('🔍 Socket handshake debug:', {
      auth: socket.handshake.auth,
      headers: socket.handshake.headers,
      query: socket.handshake.query
    });
    
    // Check for authentication token in handshake
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('❌ No token provided for socket connection');
      return next(new Error('Authentication required'));
    }
    
    // Debug: Log the token we're trying to verify
    console.log('🔍 Token debug:', {
      tokenType: typeof token,
      tokenLength: token.length,
      tokenPreview: token.substring(0, 50) + '...',
      isJWT: token.split('.').length === 3
    });

    // Verify the token and extract user info (SECURE)
    try {
      const userInfo = await verifyAndExtractUserInfo(token);
      
      if (userInfo && userInfo.id && userInfo.email) {
        console.log('✅ Token verified, user authenticated:', userInfo.email);
        socket.user = userInfo;
        socket.token = token;
        next();
        return;
      } else {
        console.log('❌ Invalid user info from token');
        next(new Error('Authentication failed: Invalid user info'));
        return;
      }
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      
      // If JWT verification fails, reject the connection
      next(new Error('Authentication failed: Invalid JWT token'));
      return;
    }
  } catch (error) {
    console.error('❌ Socket authentication error:', error);
    next(error);
  }
});

// Handle preflight requests and CORS for Socket.IO
io.engine.on('initial_headers', (headers, req) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  }
});



// JWT token verification function
async function verifyAndExtractUserInfo(token) {
  try {
    // Remove 'Bearer ' prefix if present
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    
    // First, try to verify as JWT token
    try {
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET || 'your-secret-key');
      
      if (decoded.id || decoded.userId) {
        return {
          id: decoded.id || decoded.userId,
          email: decoded.email
        };
      }
    } catch (jwtError) {
      console.log('🔍 Token is not a valid JWT, trying alternative verification...');
    }
    
    // Alternative: Verify with worXstream API if configured
    if (process.env.WORXSTREAM_API_URL && process.env.WORXSTREAM_API_TOKEN) {
      try {
        const axios = await import('axios');
        const response = await axios.default.get(`${process.env.WORXSTREAM_API_URL}/api/user-info`, {
          headers: {
            'Authorization': `Bearer ${cleanToken}`
          },
          timeout: 5000
        });
        
        if (response.data && response.data.user) {
          return {
            id: response.data.user.id || response.data.user.userId,
            email: response.data.user.email
          };
        }
      } catch (apiError) {
        console.log('🔍 API verification failed, trying local verification...');
      }
    }
    
    // Local verification: Check if token matches a user in our database
    try {
      const User = await import('./models/User.js');
      const user = await User.default.findOne({ 
        $or: [
          { 'tokens.token': cleanToken },
          { 'authToken': cleanToken },
          { 'sessionToken': cleanToken }
        ]
      });
      
      if (user) {
        return {
          id: user._id.toString(),
          email: user.email
        };
      }
    } catch (dbError) {
      console.log('🔍 Database verification failed...');
    }
    
    // Development fallback: Try to decode as base64 (INSECURE - only for development)
    if (process.env.NODE_ENV === 'development') {
      try {
        const decoded = JSON.parse(Buffer.from(cleanToken, 'base64').toString());
        if (decoded.id && decoded.email) {
          console.log('⚠️ DEVELOPMENT MODE: Using base64 decoded token');
          return decoded;
        }
      } catch (base64Error) {
        // Not a base64 token
      }
    }
    
    // If all verification methods fail, reject the token
    throw new Error('Token verification failed: Invalid or expired token');
  } catch (error) {
    throw new Error(`Token verification failed: ${error.message}`);
  }
}

io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id, 'User:', socket.user?.email);
  
  // Log connection event
  console.log(`📨 Socket connected: ${socket.id} for user: ${socket.user?.email}`);

  initMailSocket(socket, io);

  socket.on('disconnect', (reason) => {
    console.log('👋 Client disconnected:', socket.id, 'Reason:', reason);
  });
  
  socket.on('error', (error) => {
    console.error('❌ Socket error:', socket.id, error);
  });
  
  // Add debugging for all events
  socket.onAny((eventName, ...args) => {
    console.log(`📨 Socket event received: ${eventName}`, args);
  });
});

// Handle connection errors
io.engine.on('connection_error', (err) => {
  console.error('❌ Socket.IO connection error:', err);
});

// Connect to MongoDB
connectDB();

const PORT = process.env.PORT || 8000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Mail Agent Backend running on port ${PORT}`);
  console.log(`🔗 Integrated with worXstream backend: ${process.env.WORXSTREAM_API_URL || 'http://localhost:8080'}`);
  
  // Start the token refresh service
  tokenRefreshService.start();
  console.log('🔄 Token refresh service started');
});

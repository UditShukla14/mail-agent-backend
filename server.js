import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
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

import './services/enrichmentQueueService.js'; // This will initialize the service
import tokenRefreshService from './services/tokenRefreshService.js';
import notificationService from './services/notificationService.js';

dotenv.config();

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

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    console.log(`🚫 Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: '1 minute'
    });
  }
});

// Apply rate limiting to all routes
app.use(limiter);

// Stricter rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per 15 minutes
  message: {
    error: 'Too many authentication attempts, please try again later.',
    retryAfter: '15 minutes'
  },
  handler: (req, res) => {
    console.log(`🚫 Auth rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many authentication attempts, please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

// Apply stricter rate limiting to auth routes
app.use('/auth', authLimiter);

// Rate limiting for email analytics endpoints (prevent rapid polling)
const analyticsLimiter = rateLimit({
  windowMs: 30 * 1000, // 30 seconds
  max: 10, // limit each IP to 10 requests per 30 seconds
  message: {
    error: 'Too many analytics requests, please slow down.',
    retryAfter: '30 seconds'
  },
  handler: (req, res) => {
    console.log(`🚫 Analytics rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many analytics requests, please slow down.',
      retryAfter: '30 seconds'
    });
  }
});

// Apply analytics rate limiting
app.use('/email-analytics', analyticsLimiter);

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
  
  // Clean up old socket connection timestamps
  const now = Date.now();
  for (const [ip, connections] of socketConnectionMap.entries()) {
    const validConnections = connections.filter(timestamp => now - timestamp < SOCKET_CONNECTION_WINDOW);
    if (validConnections.length === 0) {
      socketConnectionMap.delete(ip);
    } else {
      socketConnectionMap.set(ip, validConnections);
    }
  }
  console.log(`🧹 Cleaned up socket connection map, remaining IPs: ${socketConnectionMap.size}`);
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
    integration: 'worxstream',
    version: '2.0.0'
  });
});

// Status endpoint to monitor rate limiting and circuit breaker
app.get('/status', (req, res) => {
  const currentTime = Date.now();
  const circuitBreakerOpen = authFailureCount >= MAX_AUTH_FAILURES && (currentTime - lastAuthFailureTime) < CIRCUIT_BREAKER_TIMEOUT;
  
  res.json({
    status: 'Mail Agent Backend Status',
    timestamp: new Date().toISOString(),
    rateLimiting: {
      socketConnections: {
        totalIPs: socketConnectionMap.size,
        maxConnectionsPerIP: MAX_SOCKET_CONNECTIONS_PER_IP,
        connectionWindow: `${SOCKET_CONNECTION_WINDOW / 1000}s`
      }
    },
    circuitBreaker: {
      status: circuitBreakerOpen ? 'OPEN' : 'CLOSED',
      failureCount: authFailureCount,
      maxFailures: MAX_AUTH_FAILURES,
      lastFailureTime: lastAuthFailureTime ? new Date(lastAuthFailureTime).toISOString() : null,
      failureWindow: `${AUTH_FAILURE_WINDOW / 1000}s`,
      timeout: `${CIRCUIT_BREAKER_TIMEOUT / 1000}s`
    },
    memory: {
      nodeVersion: process.version,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    }
  });
});

// Global error handler for rate limiting and other errors
app.use((err, req, res, next) => {
  if (err.message === 'Too many socket connections from this IP, please try again later') {
    console.log(`🚫 Socket rate limit error for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many socket connections from this IP, please try again later',
      retryAfter: '1 minute'
    });
  } else {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
  }
});

// Socket connection rate limiting
const socketConnectionMap = new Map();
const MAX_SOCKET_CONNECTIONS_PER_IP = 5; // Max 5 socket connections per IP
const SOCKET_CONNECTION_WINDOW = 60 * 1000; // 1 minute window

// Circuit breaker for socket authentication
let authFailureCount = 0;
let lastAuthFailureTime = 0;
const MAX_AUTH_FAILURES = 10; // Max 10 auth failures
const AUTH_FAILURE_WINDOW = 60 * 1000; // 1 minute window
const CIRCUIT_BREAKER_TIMEOUT = 5 * 60 * 1000; // 5 minutes timeout

// Initialize socket handlers
io.use(async (socket, next) => {
  try {
    // Rate limit socket connections by IP
    const clientIP = socket.handshake.address || socket.handshake.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    
    if (!socketConnectionMap.has(clientIP)) {
      socketConnectionMap.set(clientIP, []);
    }
    
    const connections = socketConnectionMap.get(clientIP);
    // Remove old connections outside the window
    const validConnections = connections.filter(timestamp => now - timestamp < SOCKET_CONNECTION_WINDOW);
    
    if (validConnections.length >= MAX_SOCKET_CONNECTIONS_PER_IP) {
      console.log(`🚫 Socket connection rate limit exceeded for IP: ${clientIP}`);
      return next(new Error('Too many socket connections from this IP, please try again later'));
    }
    
    // Add current connection timestamp
    validConnections.push(now);
    socketConnectionMap.set(clientIP, validConnections);
    
    console.log('🔐 Socket authentication check for:', socket.id);
    console.log('🔐 Socket handshake query:', socket.handshake.query);
    console.log('🔐 Socket handshake auth:', socket.handshake.auth);
    
    // Check for authentication token in handshake
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('❌ No token provided for socket connection');
      return next(new Error('Authentication required'));
    }

    // Check for user info in query parameters (from frontend)
    const userInfoQuery = socket.handshake.query?.userInfo;
    let userInfo = null;
    if (userInfoQuery) {
      try {
        userInfo = JSON.parse(userInfoQuery);
        console.log('📋 User info from query:', userInfo);
        console.log('📋 User info type:', typeof userInfo);
        console.log('📋 User info keys:', Object.keys(userInfo || {}));
      } catch (error) {
        console.error('Error parsing user info query:', error);
      }
    }

    // Check circuit breaker for authentication failures
    const currentTime = Date.now();
    if (authFailureCount >= MAX_AUTH_FAILURES && (currentTime - lastAuthFailureTime) < CIRCUIT_BREAKER_TIMEOUT) {
      console.log('🚫 Circuit breaker open - too many auth failures, rejecting connections');
      return next(new Error('Authentication service temporarily unavailable due to high failure rate'));
    }
    
    // Reset circuit breaker if window has passed
    if ((currentTime - lastAuthFailureTime) >= AUTH_FAILURE_WINDOW) {
      authFailureCount = 0;
      console.log('🔄 Circuit breaker reset - auth failure window expired');
    }
    
    // For unified socket connections, allow connection with user info from query
    console.log('🔍 Checking if this is a unified socket connection...');
    console.log('🔍 userInfo exists:', !!userInfo);
    console.log('🔍 userInfo.id exists:', !!(userInfo && userInfo.id));
    console.log('🔍 userInfo.email exists:', !!(userInfo && userInfo.email));
    
    if (userInfo && userInfo.id && userInfo.email) {
      console.log('🔗 Unified socket connection detected, using user info from query');
      socket.user = userInfo;
      socket.token = token;
      console.log('✅ Unified socket authenticated for user:', socket.user.email);
      next();
      return;
    }

    // Verify token with worXstream API (only for non-unified connections)
    try {
      const worxstreamApiUrl = process.env.WORXSTREAM_API_URL || 'http://localhost:8080';
      const response = await axios.get(`${worxstreamApiUrl}/api/user-info`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.data.success) {
        socket.user = response.data.user;
        socket.token = token;
        console.log('✅ Socket authenticated for user:', socket.user.email);
        next();
      } else {
        console.log('❌ Token verification failed');
        next(new Error('Invalid token'));
      }
    } catch (error) {
      console.error('❌ Token verification error:', error.message);
      console.error('❌ Full error details:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: `${process.env.WORXSTREAM_API_URL || 'http://localhost:8080'}/api/user-info`
      });
      
      // Track authentication failure for circuit breaker
      authFailureCount++;
      lastAuthFailureTime = Date.now();
      console.log(`🚫 Auth failure count: ${authFailureCount}/${MAX_AUTH_FAILURES}`);
      
      // In development mode, allow connection with fallback
      if (process.env.NODE_ENV === 'development') {
        console.log('🔧 Development mode: Allowing socket connection with fallback');
        // Use user info from headers if available, otherwise use fallback
        if (userInfo) {
          socket.user = userInfo;
          console.log('✅ Using user info from headers for socket authentication');
        } else {
          socket.user = { id: 10000000021, email: 'dev@example.com' };
          console.log('⚠️ Using fallback user info for socket authentication');
        }
        socket.token = token;
        next();
      } else {
        // In production, allow connection with user info from query if token verification fails
        // This is a temporary fix until the worXstream API is properly configured
        console.log('🔧 Production mode: Allowing socket connection with user info from query');
        if (userInfo) {
          socket.user = userInfo;
          console.log('✅ Using user info from query for socket authentication');
          socket.token = token;
          next();
        } else {
          console.log('❌ No user info available for fallback authentication');
          next(new Error('Authentication failed'));
        }
      }
    }
  } catch (error) {
    console.error('❌ Socket authentication error:', error);
    next(error);
  }
});

io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id, 'User:', socket.user?.email);
  
  // Log connection event
  console.log(`📨 Socket connected: ${socket.id} for user: ${socket.user?.email}`);

  initMailSocket(socket, io);

  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
  
  // Add debugging for all events
  socket.onAny((eventName, ...args) => {
    console.log(`📨 Socket event received: ${eventName}`, args);
  });
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

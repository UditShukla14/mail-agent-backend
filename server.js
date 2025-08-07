import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
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

import './services/enrichmentQueueService.js'; // This will initialize the service

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
      } catch (error) {
        console.error('Error parsing user info query:', error);
      }
    }

    // Verify token with worXstream API
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
        next(new Error('Authentication failed'));
      }
    }
  } catch (error) {
    console.error('❌ Socket authentication error:', error);
    next(error);
  }
});

io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id, 'User:', socket.user?.email);
  
  // Log every event received
  socket.onAny((event, ...args) => {
    console.log(`📨 Received event: ${event}`, args.length ? args[0] : '');
  });

  initMailSocket(socket, io);

  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
});

// Connect to MongoDB
connectDB();

const PORT = process.env.PORT || 8000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Mail Agent Backend running on port ${PORT}`);
  console.log(`🔗 Integrated with worXstream backend: ${process.env.WORXSTREAM_API_URL || 'http://localhost:8080'}`);
});

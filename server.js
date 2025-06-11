import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { initMailSocket } from './sockets/mailSocket.js';
import connectDB from './utils/db.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import accountRoutes from './routes/account.js';
// import mailRoutes from './routes/mail.js';

import './services/enrichmentQueueService.js'; // This will initialize the service

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked request from origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Socket.IO configuration
const io = new Server(httpServer, {
  cors: corsOptions,
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000
});

// Middleware
app.use(express.json());

// Routes
app.use('/user', userRoutes);
app.use('/auth', authRoutes);
app.use('/account', accountRoutes);
// app.use('/mail', mailRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Server is running 🚀' });
});

// Initialize socket handlers
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);
  
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
  console.log(`🚀 Server running on port ${PORT}`);
});

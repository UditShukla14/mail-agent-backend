import 'dotenv/config';
import { createServer } from 'http';
import { Server } from 'socket.io';

import { createApp } from './app.js';
import connectDB from './config/db.js';
import { socketCorsOptions } from './config/cors.js';
import { initMailSocket } from './sockets/mailSocket.js';
import { verifyBearerToken, DEV_USER, isDevFallbackAllowed } from './utils/authVerify.js';
import { debug } from './utils/logger.js';
import { rememberCompany } from './services/companies.js';

import emailEnrichmentService from './services/ai/emailEnrichment.js';
import './services/ai/enrichmentQueueService.js'; // starts the enrichment queue on import
import notificationService from './services/notificationService.js';
import tokenRefreshService from './services/auth/tokenRefreshService.js';
import outlookSubscriptionRenewalService from './services/outlook/outlookSubscriptionRenewalService.js';
import { markInterruptedSyncJobs } from './services/sync/syncJobs.js';

const app = createApp();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: socketCorsOptions,
  path: '/socket.io',
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: true,
  allowUpgrades: true,
  cookie: { name: 'io', path: '/', httpOnly: true, sameSite: 'none', secure: true },
});

emailEnrichmentService.setIO(io);
notificationService.setIO(io);

// Identity comes only from verifying the bearer token with worXstream; user info supplied by the
// client (handshake query or payloads) is never trusted.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Authentication required'));

    const { user, reason } = await verifyBearerToken(token);
    if (user) {
      rememberCompany(user, socket.handshake.auth?.companyId); // the company this person is working in: Raven credit is that company's
      socket.user = user;
      socket.token = token;
      debug('Socket authenticated for user:', user.email);
      return next();
    }

    if (isDevFallbackAllowed() && reason !== 'invalid') {
      console.log('Development mode: worXstream unreachable, using the development user');
      socket.user = { ...DEV_USER };
      socket.token = token;
      return next();
    }

    console.log(`Socket authentication failed (${reason || 'invalid'})`);
    return next(new Error(reason === 'unavailable' ? 'Authentication service unavailable' : 'Invalid token'));
  } catch (error) {
    console.error('Socket authentication error:', error.message);
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  debug('Client connected:', socket.id, 'User:', socket.user?.email);
  initMailSocket(socket, io);

  socket.on('disconnect', () => {
    debug('Client disconnected:', socket.id);
    if (socket.worxstreamUserId) {
      try {
        emailEnrichmentService.unregisterSocket(socket);
      } catch (error) {
        console.log('Error unregistering socket from enrichment service:', error.message);
      }
    }
  });
});

connectDB();

const PORT = process.env.PORT || 8000;

httpServer.listen(PORT, () => {
  console.log(`Mail Agent Backend running on port ${PORT}`);
  console.log(`Integrated with worXstream backend: ${process.env.WORXSTREAM_API_URL || process.env.API_BACKEND_URL || 'https://api.worxstream.ai'}`);

  // A sync-all left running by a previous process is not running any more
  markInterruptedSyncJobs().catch((err) => console.error('Could not reset sync jobs:', err.message));

  // Work that touches EVERY connected account only runs when asked for. By default each account is looked after
  // when its own owner uses mail: tokens refresh when a request needs them, and ensureSubscriptionForAccount runs
  // on mail:init / mail:getFolders.
  if (process.env.BACKGROUND_FOR_ALL_ACCOUNTS === 'true') {
    tokenRefreshService.start();
    console.log('Token refresh service started (all accounts)');
    outlookSubscriptionRenewalService.start();
    outlookSubscriptionRenewalService.backfill().catch((err) => {
      console.error('Outlook subscription startup backfill failed:', err.message);
    });
  }
});

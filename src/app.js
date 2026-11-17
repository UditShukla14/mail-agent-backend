import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { corsOptions } from './config/cors.js';

import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import emailsRoutes from './routes/emails.js';
import emailAnalyticsRoutes from './routes/emailAnalytics.js';
import emailCategoriesRoutes from './routes/emailCategories.js';
import aiReplyRoutes from './routes/aiReply.js';
import tokenRefreshRoutes from './routes/tokenRefresh.js';
import calendarRoutes from './routes/calendar.js';
import focusRoutes from './routes/focus.js';
import webhookRoutes from './routes/webhooks.js';

export const VERSION = '2.0.0';

export function createApp() {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(cookieParser());

  // Public Microsoft Graph webhooks (no worXstream JWT)
  app.use('/webhooks', webhookRoutes);

  app.use('/auth', authRoutes);
  app.use('/account', accountRoutes);
  app.use('/emails', emailsRoutes);
  app.use('/email-analytics', emailAnalyticsRoutes);
  app.use('/email-categories', emailCategoriesRoutes);
  app.use('/ai-reply', aiReplyRoutes);
  app.use('/token-refresh', tokenRefreshRoutes);
  app.use('/calendar', calendarRoutes);
  app.use('/focus', focusRoutes);

  app.get('/', (req, res) => {
    res.json({ status: 'Mail Agent Backend is running', integration: 'worXstream', version: VERSION });
  });

  return app;
}

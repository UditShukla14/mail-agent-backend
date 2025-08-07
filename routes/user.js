// routes/user.js
// This file is deprecated - authentication is now handled by worXstream backend
// User management is done through the main worXstream application

import express from 'express';

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ 
    status: 'User routes are deprecated',
    message: 'Authentication is now handled by worXstream backend'
  });
});

export default router;

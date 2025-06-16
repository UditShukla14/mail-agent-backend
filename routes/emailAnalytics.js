import express from 'express';
import { getEmailStats, getEmailAnalytics } from '../controllers/emailAnalyticsController.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Use the same JWT_SECRET as in userController
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// Middleware to verify token from cookies or Authorization header
const verifyToken = (req, res, next) => {
    // Try to get token from cookie first
    let token = req.cookies.token;
    
    // If not in cookie, try Authorization header
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }
    
    if (!token) {
        console.error('No token found in request');
        return res.status(401).json({ message: 'Access token is required' });
    }

    try {
        console.log('Verifying token with secret:', JWT_SECRET);
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('Token decoded:', decoded);
        // Set the user ID from the decoded token
        req.user = {
            _id: decoded.userId, // This matches the userId field in the Email model
            email: decoded.email,
            appUserId: decoded.appUserId
        };
        console.log('User set in request:', req.user);
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        return res.status(403).json({ 
            message: 'Invalid or expired token', 
            details: error.message,
            token: token.substring(0, 10) + '...' // Log first 10 chars of token for debugging
        });
    }
};

// Get email statistics
router.get('/stats', verifyToken, getEmailStats);

// Get detailed email analytics
router.get('/analytics', verifyToken, getEmailAnalytics);

export default router; 
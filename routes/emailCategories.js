import express from 'express';
import jwt from 'jsonwebtoken';
import {
  getEmailCategories,
  updateEmailCategories,
  addEmailCategory,
  deleteEmailCategory,
  getUserEmailAccounts
} from '../controllers/emailCategoriesController.js';

const router = express.Router();

// Use the same JWT_SECRET as in other routes
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
            _id: decoded.userId,
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

// Apply authentication middleware to all routes
router.use(verifyToken);

// Get categories for a specific email account
router.get('/', getEmailCategories);

// Update categories for a specific email account
router.put('/', updateEmailCategories);

// Add a new category to a specific email account
router.post('/add', addEmailCategory);

// Delete a category from a specific email account
router.delete('/:categoryName', deleteEmailCategory);

// Get all email accounts for a user
router.get('/accounts/:appUserId', getUserEmailAccounts);

export default router; 
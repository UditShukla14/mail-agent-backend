import express from 'express';
import {
  getEmailCategories,
  updateEmailCategories,
  addEmailCategory,
  deleteEmailCategory,
  getUserEmailAccounts
} from '../controllers/emailCategoriesController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Get categories for a specific email account
router.get('/', getEmailCategories);

// Update categories for a specific email account
router.put('/', updateEmailCategories);

// Add a new category to a specific email account
router.post('/add', addEmailCategory);

// Delete a category from a specific email account
router.delete('/:categoryName', deleteEmailCategory);

// Get all email accounts for a user
router.get('/accounts', getUserEmailAccounts);

export default router; 
import express from 'express';
import {
  addFocusItem,
  removeFocusItem,
  getFocusItems,
  getFocusFolderEmails
} from '../controllers/focusController.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Add a new focus item (subject or email)
router.post('/add', addFocusItem);

// Remove a focus item
router.delete('/:folderName', removeFocusItem);

// Get all focus items for an email account
router.get('/', getFocusItems);

// Get emails for a specific focus folder
router.get('/:folderName/emails', getFocusFolderEmails);

export default router;

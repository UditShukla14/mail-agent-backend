// routes/user.js
import express from 'express';
import { registerUser, loginUser, getUserProfile } from '../controllers/userController.js';
import User from '../models/User.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile', getUserProfile);

// Get user categories
router.get('/categories', async (req, res) => {
  try {
    const { appUserId } = req.query;
    if (!appUserId) {
      return res.status(400).json({ error: 'appUserId is required' });
    }

    const user = await User.findOne({ appUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ categories: user.categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Update user categories
router.put('/categories', async (req, res) => {
  try {
    const { appUserId } = req.query;
    const { categories } = req.body;

    if (!appUserId) {
      return res.status(400).json({ error: 'appUserId is required' });
    }
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: 'Categories must be an array' });
    }

    const user = await User.findOne({ appUserId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.categories = categories;
    await user.save();

    res.json({ categories: user.categories });
  } catch (error) {
    console.error('Error updating categories:', error);
    res.status(500).json({ error: 'Failed to update categories' });
  }
});

export default router;

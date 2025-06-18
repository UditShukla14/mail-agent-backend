// models/User.js
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  appUserId: {
    type: String,
    unique: true,
    default: uuidv4
  },
  categories: {
    type: [{
      name: { type: String, required: true },
      color: { type: String, default: '#8884D8' },
      createdAt: { type: Date, default: Date.now }
    }],
    default: [
      { name: 'Work', color: '#0088FE' },
      { name: 'Personal', color: '#00C49F' },
      { name: 'Finance', color: '#FFBB28' },
      { name: 'Shopping', color: '#FF8042' },
      { name: 'Travel', color: '#8884D8' },
      { name: 'Social', color: '#82CA9D' },
      { name: 'Newsletter', color: '#FFC658' },
      { name: 'Marketing', color: '#FF6B6B' },
      { name: 'Important Documents', color: '#4ECDC4' },
      { name: 'Other', color: '#45B7D1' }
    ]
  }
}, {
  timestamps: true
});

export default mongoose.model('User', userSchema);

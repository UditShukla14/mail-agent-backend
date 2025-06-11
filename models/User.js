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
  outlookSync: {
    firstSyncComplete: { type: Boolean, default: false },
    firstSyncedRange: {
      start: Date,
      end: Date
    }
  },
  appUserId: {
    type: String,
    unique: true,
    default: uuidv4
  }
}, {
  timestamps: true
});

export default mongoose.model('User', userSchema);

// models/User.js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  worxstreamUserId: {
    type: Number,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  // Additional fields for worXstream integration
  emailVerifiedAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    default: '1' // '1' for active, '0' for inactive
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
userSchema.index({ worxstreamUserId: 1 });
userSchema.index({ email: 1 });

export default mongoose.model('User', userSchema);

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
  }
}, {
  timestamps: true
});

// Index for efficient queries
userSchema.index({ worxstreamUserId: 1 });
userSchema.index({ email: 1 });

export default mongoose.model('User', userSchema);

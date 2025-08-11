import mongoose from 'mongoose';

const emailAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  provider: {
    type: String,
    enum: ['outlook', 'gmail'],
    required: true
  },
  categories: {
    type: [{
      name: { type: String, required: true },
      label: { type: String, required: true },
      description: { type: String, required: true },
      color: { type: String, default: '#8884D8' },
      createdAt: { type: Date, default: Date.now }
    }],
    default: [] // No default categories - users must select their own
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index to ensure unique email per user
emailAccountSchema.index({ userId: 1, email: 1 }, { unique: true });

export default mongoose.model('EmailAccount', emailAccountSchema); 
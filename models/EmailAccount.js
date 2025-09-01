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
  focusedItems: {
    type: [{
      type: { type: String, enum: ['subject', 'email'], required: true },
      value: { type: String, required: true }, // subject text or email address
      folderName: { type: String, required: true }, // generated folder name
      createdAt: { type: Date, default: Date.now },
      lastActivity: { type: Date, default: Date.now },
      emailCount: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true }
    }],
    default: []
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

// Index for focused items queries
emailAccountSchema.index({ userId: 1, 'focusedItems.value': 1 });
emailAccountSchema.index({ userId: 1, 'focusedItems.folderName': 1 });

export default mongoose.model('EmailAccount', emailAccountSchema); 
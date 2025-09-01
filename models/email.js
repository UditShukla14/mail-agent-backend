// models/email.js
import mongoose from 'mongoose';

const emailSchema = new mongoose.Schema({
  id: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true },
  from: { type: String, required: true },
  to: { type: String, default: '' },
  cc: { type: String, default: '' },
  bcc: { type: String, default: '' },
  subject: { type: String, default: '(No Subject)' },
  preview: String,
  content: String,
  timestamp: { type: Date, required: true },
  read: { type: Boolean, default: false },
  folder: { type: String, required: true },
  focusFolder: { type: String, default: null }, // Focus folder this email belongs to
  important: { type: Boolean, default: false },
  flagged: { type: Boolean, default: false },
  
  // AI Enrichment
  aiMeta: {
    summary: { type: String },
    category: { 
      type: String
    },
    priority: {
      type: String,
      enum: ['urgent', 'high', 'medium', 'low']
    },
    sentiment: {
      type: String,
      enum: ['positive', 'negative', 'neutral']
    },
    actionItems: [String],
    enrichedAt: { type: Date },
    version: { type: String },
    error: { type: String }
  },
  
  // Processing status
  isProcessed: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Indexes
emailSchema.index({ userId: 1, folder: 1 });
emailSchema.index({ userId: 1, timestamp: -1 });
emailSchema.index({ userId: 1, 'aiMeta.category': 1 });
emailSchema.index({ userId: 1, 'aiMeta.priority': 1 });
emailSchema.index({ userId: 1, isProcessed: 1 });
emailSchema.index({ userId: 1, focusFolder: 1 }); // Index for focus folder queries
// Compound unique index: message ID should be unique per email account
emailSchema.index({ email: 1, id: 1 }, { unique: true });

const Email = mongoose.model('Email', emailSchema);
export default Email;

// models/email.js
import mongoose from 'mongoose';

const emailSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true },
  from: { type: String, required: true },
  subject: { type: String, default: '(No Subject)' },
  preview: String,
  content: String,
  timestamp: { type: Date, required: true },
  read: { type: Boolean, default: false },
  folder: { type: String, required: true },
  important: { type: Boolean, default: false },
  flagged: { type: Boolean, default: false },
  
  // AI Enrichment
  aiMeta: {
    summary: { type: String },
    category: { 
      type: String, 
      enum: [
        'Work',
        'Personal',
        'Finance',
        'Shopping',
        'Travel',
        'Social',
        'Newsletter',
        'Marketing',
        'Important Documents',
        'Other'
      ],
      default: 'Other'
    },
    priority: {
      type: String,
      enum: ['urgent', 'high', 'medium', 'low'],
      default: 'medium'
    },
    sentiment: {
      type: String,
      enum: ['positive', 'negative', 'neutral'],
      default: 'neutral'
    },
    actionItems: [String],
    enrichedAt: { type: Date },
    version: { type: String },
    error: { type: String }
  }
}, {
  timestamps: true
});

// Indexes
emailSchema.index({ userId: 1, folder: 1 });
emailSchema.index({ userId: 1, timestamp: -1 });
emailSchema.index({ userId: 1, 'aiMeta.category': 1 });
emailSchema.index({ userId: 1, 'aiMeta.priority': 1 });

const Email = mongoose.model('Email', emailSchema);
export default Email;

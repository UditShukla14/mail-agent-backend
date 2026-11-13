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
  },
  // Microsoft Graph change-notification subscription (Outlook push)
  worxstreamUserId: {
    type: Number,
    default: null
  },
  graphSubscriptionId: {
    type: String,
    default: null
  },
  graphSubscriptionExpiresAt: {
    type: Date,
    default: null
  },
  outlookInboxFolderId: {
    type: String,
    default: null
  },
  // What the push subscription watches ('/me/messages' = every folder; created, updated and deleted)
  graphSubscriptionResource: {
    type: String,
    default: null
  },
  // The date range chosen for the last clean-and-resync; later full passes start from syncFrom
  syncFrom: { type: Date, default: null },
  syncTo: { type: Date, default: null },
  lastSyncAt: { type: Date, default: null }
}, {
  timestamps: true
});

// Compound index to ensure unique email per user
emailAccountSchema.index({ userId: 1, email: 1 }, { unique: true });

// Index for focused items queries
emailAccountSchema.index({ userId: 1, 'focusedItems.value': 1 });
emailAccountSchema.index({ userId: 1, 'focusedItems.folderName': 1 });

// Lookup Graph webhook notifications by subscription id
emailAccountSchema.index({ graphSubscriptionId: 1 }, { sparse: true });

export default mongoose.model('EmailAccount', emailAccountSchema); 
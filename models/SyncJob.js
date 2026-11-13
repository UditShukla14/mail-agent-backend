// models/SyncJob.js — the latest "sync all" run of one mail account (status survives a page refresh or a server restart)
import mongoose from 'mongoose';

const syncJobSchema = new mongoose.Schema({
  worxstreamUserId: { type: Number, required: true },
  email: { type: String, required: true },
  status: { type: String, enum: ['running', 'done', 'failed', 'interrupted'], required: true },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  /** Live counters while running: foldersDone, foldersTotal, folder, scanned, updated, added. */
  progress: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Final counters once done: folders, foldersFailed, scanned, updated, added, removed. */
  summary: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: '' },
}, { timestamps: true });

syncJobSchema.index({ worxstreamUserId: 1, email: 1 }, { unique: true });

export default mongoose.models.SyncJob || mongoose.model('SyncJob', syncJobSchema);

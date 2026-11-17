// models/SyncState.js — where the delta sync of one folder left off (Microsoft's saved "what changed since" link)
import mongoose from 'mongoose';

const syncStateSchema = new mongoose.Schema({
  email: { type: String, required: true },
  folderId: { type: String, required: true },
  /** Pass to the folder's delta endpoint to get only the changes since the last sync. */
  deltaLink: { type: String, required: true },
  /** The earliest mail the first (full) pass covered, if it was limited. */
  since: { type: Date, default: null },
}, { timestamps: true });

syncStateSchema.index({ email: 1, folderId: 1 }, { unique: true });

export default mongoose.models.SyncState || mongoose.model('SyncState', syncStateSchema);

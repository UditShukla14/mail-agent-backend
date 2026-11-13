/**
 * Background "sync all" jobs: one per mail account at a time. A job runs on the server whether or not the page that
 * started it stays open; progress goes to every open page of the user, and the latest status is kept in Mongo so a page
 * opened later (or after a refresh) can ask for it.
 */

import SyncJob from '../models/SyncJob.js';
import User from '../models/User.js';
import { getToken, refreshSpecificToken } from '../utils/tokenManager.js';
import { withTokenRefresh, isOutlookAuthError, OUTLOOK_AUTH_MESSAGE } from '../utils/outlookAuthRetry.js';
import { listAllFolders, listFolderMessageMeta } from './outlookService.js';
import { runAccountSync } from './accountSync.js';
import notificationService from './notificationService.js';

const running = new Map(); // `${userId}:${email}` -> true while this process is working on it
const keyOf = (userId, email) => `${userId}:${String(email).toLowerCase()}`;
const EVENT = 'mail:syncAllStatus';

const toStatus = (job) => (job ? {
  email: job.email,
  status: job.status,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  progress: job.progress || {},
  summary: job.summary || null,
  error: job.error || '',
} : null);

/** The latest sync-all run of an account (or null if it never ran). */
export async function getSyncStatus(worxstreamUserId, email) {
  const job = await SyncJob.findOne({ worxstreamUserId: Number(worxstreamUserId), email: String(email).toLowerCase() }).lean();
  return toStatus(job);
}

/** Anything left "running" by a previous process is not running any more. Call once at startup. */
export async function markInterruptedSyncJobs() {
  await SyncJob.updateMany({ status: 'running' }, { $set: { status: 'interrupted', finishedAt: new Date() } });
}

/**
 * Start a sync-all for an account unless one is already running. Returns at once; the work continues in the
 * background and reports through `mail:syncAllStatus`.
 * @returns {Promise<{ started: boolean, status: object }>}
 */
export async function startAccountSync(worxstreamUserId, email) {
  const userId = Number(worxstreamUserId);
  const mail = String(email).toLowerCase();
  const key = keyOf(userId, mail);
  if (running.has(key)) return { started: false, status: await getSyncStatus(userId, mail) };

  const user = await User.findOne({ worxstreamUserId: userId });
  if (!user) throw new Error('User not found');
  if (!(await getToken(userId, mail, 'outlook'))) throw new Error(`Email account ${mail} is not connected or has expired.`);

  running.set(key, true);
  const job = await SyncJob.findOneAndUpdate(
    { worxstreamUserId: userId, email: mail },
    { $set: { status: 'running', startedAt: new Date(), finishedAt: null, progress: {}, summary: null, error: '' } },
    { upsert: true, new: true },
  );
  const publish = (doc) => notificationService.notifyUser(userId, EVENT, toStatus(doc));
  publish(job);

  // Graph calls with one automatic token refresh when Microsoft rejects the stored token.
  const graph = async (fn) => withTokenRefresh(fn, {
    accessToken: await getToken(userId, mail, 'outlook'),
    refresh: () => refreshSpecificToken(userId, mail, 'outlook'),
    getFreshToken: () => getToken(userId, mail, 'outlook'),
  });

  let lastPublish = 0;
  setImmediate(async () => {
    try {
      const summary = await runAccountSync({
        user,
        email: mail,
        listFolders: () => graph((t) => listAllFolders(t)),
        listMessages: (folderId, link) => graph((t) => listFolderMessageMeta(t, folderId, link)),
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastPublish < 1000 && progress.phase === 'scanning') return; // at most one update a second
          lastPublish = now;
          SyncJob.updateOne({ _id: job._id }, { $set: { progress } }).catch(() => {});
          notificationService.notifyUser(userId, EVENT, toStatus({ ...job.toObject(), status: 'running', progress }));
        },
      });
      const done = await SyncJob.findOneAndUpdate({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date(), summary, progress: {} } }, { new: true });
      console.log(`🔄 Sync all finished for ${mail}: ${summary.scanned} scanned, ${summary.updated} updated, ${summary.added} added, ${summary.removed} removed`);
      publish(done);
    } catch (error) {
      console.error('❌ Sync all failed:', error?.response?.status || error.message);
      const failed = await SyncJob.findOneAndUpdate(
        { _id: job._id },
        { $set: { status: 'failed', finishedAt: new Date(), error: isOutlookAuthError(error) ? OUTLOOK_AUTH_MESSAGE : 'The sync could not be completed. Try again in a few minutes.' } },
        { new: true },
      );
      publish(failed);
    } finally {
      running.delete(key);
    }
  });

  return { started: true, status: toStatus(job) };
}

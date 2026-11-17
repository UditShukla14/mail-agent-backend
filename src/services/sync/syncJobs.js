/**
 * Background "sync all" jobs: one per mail account at a time. A job runs on the server whether or not the page that
 * started it stays open; progress goes to every open page of the user, and the latest status is kept in Mongo so a page
 * opened later (or after a refresh) can ask for it.
 */

import SyncJob from '../models/SyncJob.js';
import User from '../models/User.js';
import { getToken, refreshSpecificToken } from '../utils/tokenManager.js';
import { withTokenRefresh, isOutlookAuthError, OUTLOOK_AUTH_MESSAGE } from '../utils/outlookAuthRetry.js';
import { listAllFolders, deltaFolderMessages, listFolderMessagesRange } from './outlookService.js';
import { runAccountSync } from './accountSync.js';
import { runCleanResync } from './cleanResync.js';
import SyncState from '../models/SyncState.js';
import EmailAccount from '../models/EmailAccount.js';
import notificationService from './notificationService.js';

const running = new Map(); // `${userId}:${email}` -> true while this process is working on it
const keyOf = (userId, email) => `${userId}:${String(email).toLowerCase()}`;
const EVENT = 'mail:syncAllStatus';

const toStatus = (job) => (job ? {
  email: job.email,
  kind: job.kind || 'sync',
  range: job.range?.since ? { since: job.range.since, until: job.range.until } : null,
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

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 5 * 365;
/** First full pass of a folder reads this many days back unless the account has a chosen range. */
const DEFAULT_FIRST_PASS_DAYS = Number(process.env.MAIL_SYNC_DEFAULT_DAYS) || 180;

/** Validates the date range of a clean-and-resync. Dates are "YYYY-MM-DD" (the whole day) or ISO timestamps. */
export function parseRange({ since, until } = {}, now = new Date()) {
  const start = since ? new Date(String(since).length <= 10 ? `${since}T00:00:00.000Z` : since) : null;
  const end = until ? new Date(String(until).length <= 10 ? `${until}T23:59:59.999Z` : until) : now;
  if (!start || Number.isNaN(start.getTime())) throw new Error('Choose a start date for the period to resync.');
  if (Number.isNaN(end.getTime())) throw new Error('The end date is not valid.');
  if (start > now) throw new Error('The start date cannot be in the future.');
  if (start > end) throw new Error('The start date must be before the end date.');
  if ((end - start) / DAY > MAX_RANGE_DAYS) throw new Error('Choose a period of 5 years or less.');
  return { since: start, until: end > now ? now : end };
}

/**
 * Start a background job for an account unless one is already running. Returns at once; the work continues on the
 * server and reports through `mail:syncAllStatus`.
 *  - kind 'sync': delta sync of every folder (Sync all).
 *  - kind 'cleanResync': rebuild the stored copy from Outlook for `range` (see cleanResync.js).
 * @returns {Promise<{ started: boolean, status: object }>}
 */
export async function startAccountSync(worxstreamUserId, email, { kind = 'sync', range } = {}) {
  const userId = Number(worxstreamUserId);
  const mail = String(email).toLowerCase();
  const key = keyOf(userId, mail);
  if (running.has(key)) return { started: false, status: await getSyncStatus(userId, mail) };
  const parsed = kind === 'cleanResync' ? parseRange(range) : null; // validate before anything is touched

  const user = await User.findOne({ worxstreamUserId: userId });
  if (!user) throw new Error('User not found');
  if (!(await getToken(userId, mail, 'outlook'))) throw new Error(`Email account ${mail} is not connected or has expired.`);

  running.set(key, true);
  const job = await SyncJob.findOneAndUpdate(
    { worxstreamUserId: userId, email: mail },
    { $set: { kind, range: parsed ? { since: parsed.since, until: parsed.until } : { since: null, until: null }, status: 'running', startedAt: new Date(), finishedAt: null, progress: {}, summary: null, error: '' } },
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
  const onProgress = (progress) => {
    const now = Date.now();
    if (now - lastPublish < 1000 && progress.phase === 'scanning') return; // at most one update a second
    lastPublish = now;
    SyncJob.updateOne({ _id: job._id }, { $set: { progress } }).catch(() => {});
    notificationService.notifyUser(userId, EVENT, toStatus({ ...job.toObject(), status: 'running', progress }));
  };

  setImmediate(async () => {
    try {
      let summary;
      if (kind === 'cleanResync') {
        summary = await runCleanResync({
          user,
          email: mail,
          since: parsed.since,
          until: parsed.until,
          listFolders: () => graph((t) => listAllFolders(t)),
          listRange: (folderId, opts) => graph((t) => listFolderMessagesRange(t, folderId, { ...opts, withBody: true })),
          clearAllState: () => SyncState.deleteMany({ email: mail }).then(() => {}),
          onProgress,
        });
        await EmailAccount.updateOne({ userId: user._id, email: mail }, { $set: { syncFrom: parsed.since, syncTo: parsed.until, lastSyncAt: new Date() } });
      } else {
        const account = await EmailAccount.findOne({ userId: user._id, email: mail }).lean();
        const since = account?.syncFrom || new Date(Date.now() - DEFAULT_FIRST_PASS_DAYS * DAY);
        summary = await runAccountSync({
          user,
          email: mail,
          since,
          listFolders: () => graph((t) => listAllFolders(t)),
          listDelta: (folderId, link, opts) => graph((t) => deltaFolderMessages(t, folderId, link, opts)),
          loadState: (folderId) => SyncState.findOne({ email: mail, folderId }).lean(),
          saveState: (folderId, deltaLink, sinceUsed) => SyncState.updateOne({ email: mail, folderId }, { $set: { deltaLink, since: sinceUsed } }, { upsert: true }).then(() => {}),
          clearState: (folderId) => SyncState.deleteOne({ email: mail, folderId }).then(() => {}),
          onProgress,
        });
        await EmailAccount.updateOne({ userId: user._id, email: mail }, { $set: { lastSyncAt: new Date() } });
      }
      const done = await SyncJob.findOneAndUpdate({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date(), summary, progress: {} } }, { new: true });
      console.log(`🔄 ${kind === 'cleanResync' ? 'Clean and resync' : 'Sync all'} finished for ${mail}: ${summary.scanned} scanned, ${summary.updated} updated, ${summary.added} added, ${summary.removed} removed`);
      publish(done);
    } catch (error) {
      console.error(`❌ ${kind} failed:`, error?.response?.status || error.message);
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

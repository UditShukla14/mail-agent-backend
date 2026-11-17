/**
 * "Clean and resync": rebuild the stored copy of ONE account from Outlook for a date range.
 *
 *  1. Read every folder (sub-folders too), with message bodies, for mail received between `since` and `until`, and
 *     write each message to Mongo with Outlook's current values (immutable id, folder, conversation, read state, flags,
 *     attachment flag, body).
 *  2. The AI fields (aiMeta, isProcessed) stay in the documents but their values are reset, so the messages are analysed
 *     again from scratch.
 *  3. Only when every folder was read completely: delete every other stored message of the account (older than the range,
 *     deleted in Outlook, stored under an old id) and forget the saved delta links.
 *
 * The new copy is built BEFORE anything is deleted, so a run that fails halfway leaves the old data as it was.
 */

import Email from '../models/email.js';

const MAX_IDS_FOR_CLEANUP = 100000;
const PAGE_PAUSE_MS = 150;

/**
 * @param {object} args
 * @param {{ _id: any }} args.user
 * @param {string} args.email
 * @param {Date} args.since
 * @param {Date} args.until
 * @param {() => Promise<Array<{ id: string, displayName: string, path?: string }>>} args.listFolders
 * @param {(folderId: string, opts: { since: Date, until: Date, nextLink: string|null }) => Promise<{ rows: object[], nextLink: string|null }>} args.listRange
 * @param {() => Promise<void>} args.clearAllState  forget the delta links of the account
 * @param {(p: object) => void} [args.onProgress]
 */
export async function runCleanResync({
  user,
  email,
  since,
  until,
  listFolders,
  listRange,
  clearAllState,
  onProgress = () => {},
  maxPagesPerFolder = 200,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const startedAt = Date.now();
  const folders = await listFolders();
  const seen = new Set();
  const summary = { folders: folders.length, foldersFailed: 0, scanned: 0, updated: 0, added: 0, removed: 0, since, until };

  for (let f = 0; f < folders.length; f++) {
    const folder = folders[f];
    const label = folder.path || folder.displayName;
    let link = null;
    let complete = false;
    try {
      for (let page = 0; page < maxPagesPerFolder; page++) {
        const { rows, nextLink } = await listRange(folder.id, { since, until, nextLink: link });
        for (const r of rows) seen.add(r.id);
        summary.scanned += rows.length;

        if (rows.length) {
          const ops = rows.map((r) => ({
            updateOne: {
              filter: { id: r.id, email },
              update: {
                $set: {
                  id: r.id, userId: user._id, email, folder: r.folder || folder.id,
                  from: r.from, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, preview: r.preview,
                  content: r.content ?? '',
                  timestamp: r.timestamp ? new Date(r.timestamp) : new Date(),
                  read: r.read, important: r.important, flagged: r.flagged,
                  conversationId: r.conversationId, hasAttachments: r.hasAttachments,
                  // the AI fields stay; their values start again
                  aiMeta: {},
                  isProcessed: false,
                  updatedAt: new Date(),
                },
              },
              upsert: true,
            },
          }));
          const out = await Email.bulkWrite(ops, { ordered: false });
          summary.updated += out.modifiedCount ?? 0;
          summary.added += out.upsertedCount ?? 0;
        }
        onProgress({ phase: 'scanning', folder: label, foldersDone: f, foldersTotal: folders.length, ...summary });
        if (!nextLink) {
          complete = true;
          break;
        }
        link = nextLink;
        await pause(PAGE_PAUSE_MS);
      }
    } catch (error) {
      summary.foldersFailed += 1;
      console.error(`⚠️ Resync of folder "${folder.displayName}" failed:`, error?.response?.status || error.message);
      continue;
    }
    if (!complete) summary.foldersFailed += 1; // hit the page cap: the folder is not fully read
    onProgress({ phase: 'scanning', folder: label, foldersDone: f + 1, foldersTotal: folders.length, ...summary });
  }

  // The clean: only after a complete read, so nothing is lost to a failed or partial run.
  // An empty result is never taken as "delete everything": it is more likely a glitch than an empty mailbox.
  if (summary.foldersFailed === 0 && seen.size > 0 && seen.size <= MAX_IDS_FOR_CLEANUP) {
    onProgress({ phase: 'cleaning', foldersDone: folders.length, foldersTotal: folders.length, ...summary });
    const res = await Email.deleteMany({
      userId: user._id,
      email,
      id: { $nin: [...seen] },
      createdAt: { $lt: new Date(startedAt - 5 * 60 * 1000) }, // mail that just arrived is not judged
    });
    summary.removed = res.deletedCount ?? 0;
    await clearAllState();
  } else {
    summary.skippedClean = true; // the new copy is in, the old rows were kept
    summary.skipReason = summary.foldersFailed > 0 ? 'some folders could not be read' : seen.size === 0 ? 'no mail was found in that period' : 'too many messages to clean in one go';
  }
  return summary;
}

/**
 * Full sync of one mail account with Outlook, meant to run as a background job.
 *
 * Phase 1: walk every folder (sub-folders too) and, page by page, bring the saved copy in line with Outlook: conversation
 *          id, read state, flags, attachment flag, subject, sender/recipients and the folder a message sits in (so moves
 *          are followed). Messages Outlook has but we do not are added for the newest `maxNewPerFolder` of each folder.
 * Phase 2: remove saved messages Outlook no longer has anywhere. Only when every folder was listed completely, and never
 *          messages saved in the last 5 minutes (the listing can lag behind mail that just arrived).
 *
 * Graph access is injected so the logic can be tested without Outlook.
 */

import Email from '../models/email.js';

const MAX_IDS_FOR_CLEANUP = 50000; // the id list goes into one query
const PAGE_PAUSE_MS = 150; // be polite to Graph; a mailbox of 10k messages is 100 calls

/**
 * @param {object} args
 * @param {{ _id: any }} args.user
 * @param {string} args.email
 * @param {() => Promise<Array<{ id: string, displayName: string, path?: string }>>} args.listFolders
 * @param {(folderId: string, nextLink: string|null) => Promise<{ rows: object[], nextLink: string|null }>} args.listMessages
 * @param {(p: object) => void} [args.onProgress]
 * @param {number} [args.maxPagesPerFolder]  100 messages per page
 * @param {number} [args.maxNewPerFolder]
 * @param {(ms: number) => Promise<void>} [args.pause]
 */
export async function runAccountSync({
  user,
  email,
  listFolders,
  listMessages,
  onProgress = () => {},
  maxPagesPerFolder = 100,
  maxNewPerFolder = 200,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const startedAt = Date.now();
  const folders = await listFolders();
  const seenAnywhere = new Set();
  const completeFolders = [];
  const summary = { folders: folders.length, foldersFailed: 0, scanned: 0, updated: 0, added: 0, removed: 0 };

  for (let f = 0; f < folders.length; f++) {
    const folder = folders[f];
    let link = null;
    let newBudget = maxNewPerFolder;
    let complete = false;
    try {
      for (let page = 0; page < maxPagesPerFolder; page++) {
        const { rows, nextLink } = await listMessages(folder.id, link);
        rows.forEach((r) => seenAnywhere.add(r.id));
        summary.scanned += rows.length;

        if (rows.length) {
          const ops = rows.map((r) => {
            const upsert = newBudget > 0; // rows come newest first; older ones are only updated if we already hold them
            if (upsert) newBudget -= 1;
            return {
              updateOne: {
                filter: { id: r.id, email },
                update: {
                  $set: {
                    id: r.id, userId: user._id, email, folder: folder.id,
                    from: r.from, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, preview: r.preview,
                    timestamp: r.timestamp ? new Date(r.timestamp) : new Date(),
                    read: r.read, important: r.important, flagged: r.flagged,
                    conversationId: r.conversationId, hasAttachments: r.hasAttachments,
                    updatedAt: new Date(),
                  },
                  ...(upsert ? { $setOnInsert: { isProcessed: false } } : {}),
                },
                upsert,
              },
            };
          });
          const res = await Email.bulkWrite(ops, { ordered: false });
          summary.updated += res.modifiedCount ?? 0;
          summary.added += res.upsertedCount ?? 0;
        }

        onProgress({ phase: 'scanning', folder: folder.path || folder.displayName, foldersDone: f, foldersTotal: folders.length, ...summary });
        if (!nextLink) {
          complete = true;
          break;
        }
        link = nextLink;
        await pause(PAGE_PAUSE_MS);
      }
    } catch (error) {
      summary.foldersFailed += 1;
      console.error(`⚠️ Sync of folder "${folder.displayName}" failed:`, error?.response?.status || error.message);
      continue; // the other folders still sync
    }
    if (complete) completeFolders.push(folder.id);
    onProgress({ phase: 'scanning', folder: folder.path || folder.displayName, foldersDone: f + 1, foldersTotal: folders.length, ...summary });
  }

  // Phase 2: only when nothing is uncertain.
  if (summary.foldersFailed === 0 && completeFolders.length === folders.length && seenAnywhere.size > 0 && seenAnywhere.size <= MAX_IDS_FOR_CLEANUP) {
    onProgress({ phase: 'cleaning', foldersDone: folders.length, foldersTotal: folders.length, ...summary });
    const res = await Email.deleteMany({
      userId: user._id,
      email,
      id: { $nin: [...seenAnywhere] },
      createdAt: { $lt: new Date(startedAt - 5 * 60 * 1000) },
    });
    summary.removed = res.deletedCount ?? 0;
  }
  return summary;
}

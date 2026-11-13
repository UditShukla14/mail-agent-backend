/**
 * Full sync of one mail account with Outlook, run as a background job, built on Microsoft's DELTA queries.
 *
 * Per folder: the first time (no saved delta link) it reads the folder from scratch and saves the delta link Outlook
 * returns; every later run asks only for what changed since (new, edited, read, flagged, moved, deleted) and updates
 * Mongo from that, which is far less work than listing the folder again. A link Outlook no longer accepts (410) simply
 * starts that folder over.
 *
 * Messages are matched by Outlook's id (immutable ids, see graphDefaults.js), so a message that moved folder is updated in
 * place, not deleted and re-added. AI fields are never touched here.
 *
 * Graph access and the delta state are injected so the logic can be tested without Outlook.
 */

import Email from '../models/email.js';

const MAX_IDS_FOR_CLEANUP = 50000; // the id list goes into one query
const PAGE_PAUSE_MS = 150; // be polite to Graph
const REMOVAL_CHUNK = 500;

/**
 * @param {object} args
 * @param {{ _id: any }} args.user
 * @param {string} args.email
 * @param {() => Promise<Array<{ id: string, displayName: string, path?: string }>>} args.listFolders
 * @param {(folderId: string, link: string|null, opts: { since?: Date }) => Promise<{ rows: object[], removed: string[], nextLink: string|null, deltaLink: string|null }>} args.listDelta
 * @param {(folderId: string) => Promise<{ deltaLink: string }|null>} args.loadState
 * @param {(folderId: string, deltaLink: string, since: Date|null) => Promise<void>} args.saveState
 * @param {(folderId: string) => Promise<void>} args.clearState
 * @param {Date} [args.since]  limits a folder's first full pass to mail received on or after this date
 * @param {(p: object) => void} [args.onProgress]
 */
export async function runAccountSync({
  user,
  email,
  listFolders,
  listDelta,
  loadState,
  saveState,
  clearState,
  since,
  onProgress = () => {},
  maxPagesPerFolder = 200,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const startedAt = Date.now();
  const folders = await listFolders();
  const seen = new Set();
  const fullFolders = []; // folders read from scratch this run (their stale rows are cleaned at the end)
  const removals = []; // { id, folder } reported deleted or moved out; applied last so a moved message is not lost
  const summary = { folders: folders.length, foldersFailed: 0, full: 0, incremental: 0, scanned: 0, updated: 0, added: 0, removed: 0 };

  for (let f = 0; f < folders.length; f++) {
    const folder = folders[f];
    const label = folder.path || folder.displayName;
    const state = await loadState(folder.id);
    let link = state?.deltaLink || null;
    let full = !link;
    let finalLink = null;
    let complete = false;
    try {
      for (let page = 0; page < maxPagesPerFolder; page++) {
        let res;
        try {
          res = await listDelta(folder.id, link, { since });
        } catch (error) {
          if (link && error?.response?.status === 410) {
            // The saved link expired: this folder starts over.
            await clearState(folder.id);
            link = null;
            full = true;
            continue;
          }
          throw error;
        }
        for (const r of res.rows) seen.add(r.id);
        summary.scanned += res.rows.length;
        for (const id of res.removed) removals.push({ id, folder: folder.id });

        if (res.rows.length) {
          const ops = res.rows.map((r) => ({
            updateOne: {
              filter: { id: r.id, email },
              update: {
                $set: {
                  id: r.id, userId: user._id, email, folder: r.folder || folder.id,
                  from: r.from, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, preview: r.preview,
                  timestamp: r.timestamp ? new Date(r.timestamp) : new Date(),
                  read: r.read, important: r.important, flagged: r.flagged,
                  conversationId: r.conversationId, hasAttachments: r.hasAttachments,
                  updatedAt: new Date(),
                },
                $setOnInsert: { isProcessed: false },
              },
              upsert: true,
            },
          }));
          const out = await Email.bulkWrite(ops, { ordered: false });
          summary.updated += out.modifiedCount ?? 0;
          summary.added += out.upsertedCount ?? 0;
        }

        onProgress({ phase: 'scanning', folder: label, foldersDone: f, foldersTotal: folders.length, ...summary });
        if (res.deltaLink) {
          finalLink = res.deltaLink;
          complete = true;
          break;
        }
        if (!res.nextLink) break; // Outlook ended without a delta link: do not trust this pass
        link = res.nextLink;
        await pause(PAGE_PAUSE_MS);
      }
    } catch (error) {
      summary.foldersFailed += 1;
      console.error(`⚠️ Sync of folder "${folder.displayName}" failed:`, error?.response?.status || error.message);
      continue; // the other folders still sync
    }
    if (complete && finalLink) {
      await saveState(folder.id, finalLink, full ? since ?? null : state?.since ?? null);
      summary[full ? 'full' : 'incremental'] += 1;
      if (full) fullFolders.push(folder.id);
    } else {
      summary.foldersFailed += 1; // no delta link: nothing saved, the next run reads this folder again
    }
    onProgress({ phase: 'scanning', folder: label, foldersDone: f + 1, foldersTotal: folders.length, ...summary });
  }

  onProgress({ phase: 'cleaning', foldersDone: folders.length, foldersTotal: folders.length, ...summary });

  // Deleted or moved out: delete only if the message is still recorded in THAT folder, so one that was moved (and already
  // re-recorded in its new folder above) stays.
  for (let i = 0; i < removals.length; i += REMOVAL_CHUNK) {
    const chunk = removals.slice(i, i + REMOVAL_CHUNK);
    const res = await Email.deleteMany({ email, $or: chunk.map((r) => ({ id: r.id, folder: r.folder })) });
    summary.removed += res.deletedCount ?? 0;
  }

  // A folder read from scratch also drops rows Outlook no longer has in it (from before delta tracking). Only when every
  // folder was read, never rows newer than 5 minutes (the listing can lag), and only within the period that was read.
  if (summary.foldersFailed === 0 && fullFolders.length > 0 && seen.size > 0 && seen.size <= MAX_IDS_FOR_CLEANUP) {
    const res = await Email.deleteMany({
      userId: user._id,
      email,
      folder: { $in: fullFolders },
      id: { $nin: [...seen] },
      createdAt: { $lt: new Date(startedAt - 5 * 60 * 1000) },
      ...(since ? { timestamp: { $gte: since } } : {}),
    });
    summary.removed += res.deletedCount ?? 0;
  }
  return summary;
}

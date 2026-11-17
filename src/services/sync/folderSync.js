/**
 * Keeping the Mongo copy of a folder equal to Outlook, and reading it back the way Outlook shows it: one row per
 * conversation (grouped by Outlook's own conversationId) with the number of messages in it.
 */

import Email from '../models/email.js';
import { getFolderThreadIds } from './outlookService.js';

/** Messages without a conversation id (not synced yet) stand alone, keyed by their own id. */
const THREAD_KEY = {
  $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$conversationId', ''] } }, 0] }, '$conversationId', '$id'],
};

/**
 * Save the messages Outlook returned for a folder. The conversation id and attachment flag are always overwritten with
 * Outlook's values, so the copy follows Outlook. A repeated save never resets enrichment (`isProcessed`).
 */
export async function saveOutlookMessages(user, email, folderId, messages) {
  const ops = (messages || [])
    .filter((m) => m && m.id)
    .map((m) => ({
      updateOne: {
        filter: { id: m.id, email },
        update: {
          $set: {
            id: m.id,
            userId: user._id,
            email,
            from: m.from || '',
            to: m.to || '',
            cc: m.cc || '',
            bcc: m.bcc || '',
            subject: m.subject || '(No Subject)',
            content: m.content || '',
            preview: m.preview || '',
            timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
            read: Boolean(m.read),
            folder: folderId,
            important: Boolean(m.important),
            flagged: Boolean(m.flagged),
            conversationId: m.conversationId || '',
            hasAttachments: Boolean(m.hasAttachments),
            updatedAt: new Date(),
          },
          $setOnInsert: { isProcessed: false },
        },
        upsert: true,
      },
    }));
  if (ops.length === 0) return 0;
  const res = await Email.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
}

function filterQuery(filters = {}) {
  const q = {};
  if (filters.category && filters.category !== 'All') q['aiMeta.category'] = filters.category;
  if (filters.priority && filters.priority !== 'All') q['aiMeta.priority'] = filters.priority;
  if (filters.sentiment && filters.sentiment !== 'All') q['aiMeta.sentiment'] = filters.sentiment;
  return q;
}

/**
 * One page of a folder as conversations, newest first. Each row is the newest message of its conversation with
 * `threadCount` (all messages of the conversation we hold, in every folder, so replies in Sent count) and
 * `threadUnread`. Paging is over conversations, so a conversation never shows up twice.
 *
 * @returns {Promise<{ messages: object[], hasMore: boolean }>}
 */
export async function getFolderThreads({ user, email, folderId, page = 1, pageSize = 20, filters = {} }) {
  const match = { userId: user._id, email, folder: folderId, ...filterQuery(filters) };
  const heads = await Email.aggregate(
    [
      { $match: match },
      { $project: { content: 0 } }, // the body is loaded when a message is opened
      { $sort: { timestamp: -1 } },
      { $group: { _id: THREAD_KEY, head: { $first: '$$ROOT' }, inFolder: { $sum: 1 }, unreadInFolder: { $sum: { $cond: ['$read', 0, 1] } } } },
      { $sort: { 'head.timestamp': -1 } },
      { $skip: (Math.max(page, 1) - 1) * pageSize },
      { $limit: pageSize + 1 },
    ],
    { allowDiskUse: true },
  );
  const hasMore = heads.length > pageSize;
  const pageHeads = heads.slice(0, pageSize);

  const ids = pageHeads.map((h) => h.head.conversationId).filter(Boolean);
  const totals = ids.length
    ? await Email.aggregate([
        { $match: { userId: user._id, email, conversationId: { $in: ids } } },
        { $group: { _id: '$conversationId', count: { $sum: 1 }, unread: { $sum: { $cond: ['$read', 0, 1] } } } },
      ])
    : [];
  const byConversation = new Map(totals.map((t) => [t._id, t]));

  const messages = pageHeads.map((h) => {
    const t = byConversation.get(h.head.conversationId);
    return {
      ...h.head,
      threadCount: Math.max(t?.count ?? 0, h.inFolder),
      threadUnread: Math.max(t?.unread ?? 0, h.unreadInFolder),
    };
  });
  return { messages, hasMore };
}

/**
 * Make the saved copy of a folder equal to Outlook's: walk the folder listing (ids and conversation ids only, 100 per
 * call), set every saved message's conversation id and attachment flag to Outlook's, and, once the whole folder has been
 * listed, drop saved messages Outlook no longer has in it (deleted or moved).
 *
 * @param {{ token: string, user: { _id: any }, email: string, folderId: string, maxPages?: number, list?: typeof getFolderThreadIds }} args
 * @returns {Promise<{ scanned: number, updated: number, removed: number, complete: boolean, missing: number }>}
 */
export async function syncConversationIds({ token, user, email, folderId, maxPages = 20, list = getFolderThreadIds }) {
  const startedAt = Date.now();
  const seen = new Set();
  let link = null;
  let scanned = 0;
  let updated = 0;
  let complete = false;

  for (let i = 0; i < maxPages; i++) {
    const { rows, nextLink } = await list(token, folderId, link);
    for (const r of rows) seen.add(r.id);
    scanned += rows.length;
    if (rows.length) {
      const res = await Email.bulkWrite(
        rows.map((r) => ({
          updateOne: {
            filter: { id: r.id, email },
            update: { $set: { conversationId: r.conversationId, hasAttachments: r.hasAttachments } },
          },
        })),
        { ordered: false },
      );
      updated += res.modifiedCount ?? 0;
    }
    if (!nextLink) {
      complete = true;
      break;
    }
    link = nextLink;
  }

  // Only a fully listed, non-empty folder can say what is gone. Messages saved in the last minutes are left alone
  // (the listing can lag behind mail that just arrived).
  let removed = 0;
  if (complete && seen.size > 0) {
    const res = await Email.deleteMany({
      userId: user._id,
      email,
      folder: folderId,
      id: { $nin: [...seen] },
      createdAt: { $lt: new Date(startedAt - 5 * 60 * 1000) },
    });
    removed = res.deletedCount ?? 0;
  }

  const missing = await Email.countDocuments({
    userId: user._id,
    email,
    folder: folderId,
    $or: [{ conversationId: { $exists: false } }, { conversationId: '' }],
  });
  return { scanned, updated, removed, complete, missing };
}

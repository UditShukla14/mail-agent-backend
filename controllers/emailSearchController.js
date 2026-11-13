import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { getToken } from '../utils/tokenManager.js';
import { getMessageById, listAllFolders, listAttachmentMeta, getConversationLive, getMessageUniqueText, buildKql, searchMessagesLive, wellKnownFolderIds } from '../services/outlookService.js';
import SyncJob from '../models/SyncJob.js';
import SyncState from '../models/SyncState.js';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const BODY_CHAR_LIMIT = 6000;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const truthy = (value) => value === true || value === 'true' || value === '1';

/** Reads from the stored mailbox only (no provider call): the list is what the mail page already synced. */
export function buildSearchQuery({ userId, accountEmails, params }) {
  const query = { userId, email: { $in: accountEmails } };

  if (params.email && accountEmails.includes(params.email)) query.email = params.email;
  if (params.folder && params.folder !== 'all') query.folder = params.folder;
  if (params.conversation_id) query.conversationId = String(params.conversation_id);
  if (truthy(params.has_attachments)) query.hasAttachments = true;
  if (params.category) query['aiMeta.category'] = params.category;
  if (params.priority) query['aiMeta.priority'] = params.priority;
  if (params.sentiment) query['aiMeta.sentiment'] = params.sentiment;
  if (truthy(params.unread)) query.read = false;
  if (truthy(params.important)) query.important = true;
  if (truthy(params.needs_action)) query['aiMeta.actionItems.0'] = { $exists: true };

  const since = params.since ? new Date(params.since) : null;
  const until = params.until ? new Date(params.until) : null;
  if ((since && !Number.isNaN(since.getTime())) || (until && !Number.isNaN(until.getTime()))) {
    query.timestamp = {};
    if (since && !Number.isNaN(since.getTime())) query.timestamp.$gte = since;
    if (until && !Number.isNaN(until.getTime())) query.timestamp.$lte = until;
  }

  const and = [];
  if (params.from) and.push({ from: { $regex: escapeRegex(params.from), $options: 'i' } });
  if (params.to) and.push({ $or: [{ to: { $regex: escapeRegex(params.to), $options: 'i' } }, { cc: { $regex: escapeRegex(params.to), $options: 'i' } }] });
  if (params.subject) and.push({ subject: { $regex: escapeRegex(params.subject), $options: 'i' } });
  if (params.q) {
    const rx = { $regex: escapeRegex(params.q), $options: 'i' };
    and.push({ $or: [{ subject: rx }, { from: rx }, { to: rx }, { preview: rx }, { 'aiMeta.summary': rx }] });
  }
  if (and.length) query.$and = and;
  return query;
}

export const clampLimit = (value) => Math.min(Math.max(parseInt(value, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

/** HTML or text body to plain text for model/agent use, capped. */
export function toPlainText(content) {
  const text = String(content || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return { text: text.slice(0, BODY_CHAR_LIMIT), truncated: text.length > BODY_CHAR_LIMIT };
}

async function loadScope(req) {
  const user = await User.findOne({ worxstreamUserId: Number(req.user.id) });
  if (!user) return null;
  const accounts = await EmailAccount.find({ userId: user._id });
  return { user, accountEmails: accounts.map((a) => a.email) };
}

const summarize = (doc) => ({
  /** Short handle (24 characters) that is easy to pass back exactly; the long provider id in `id` works too. */
  ref: String(doc._id),
  id: doc.id,
  email: doc.email,
  folder: doc.folder,
  from: doc.from,
  subject: doc.subject || '(No Subject)',
  timestamp: doc.timestamp ? new Date(doc.timestamp).toISOString() : null,
  read: Boolean(doc.read),
  important: Boolean(doc.important),
  flagged: Boolean(doc.flagged),
  conversationId: doc.conversationId || '',
  hasAttachments: Boolean(doc.hasAttachments),
  preview: String(doc.preview || '').slice(0, 200),
  aiMeta: doc.aiMeta
    ? {
        summary: doc.aiMeta.summary || '',
        category: doc.aiMeta.category || null,
        priority: doc.aiMeta.priority || null,
        sentiment: doc.aiMeta.sentiment || null,
        actionItems: doc.aiMeta.actionItems || [],
      }
    : null,
});


const isRef = (value) => /^[0-9a-f]{24}$/i.test(String(value || ''));

/**
 * One of the user's messages by its short `ref` or its provider `id`. The account address is only a hint to pick the
 * right one when it applies; it never hides a message the user owns (a model that names the wrong account still finds it).
 */
async function findOwnedEmail(scope, idOrRef, accountHint) {
  const base = { userId: scope.user._id, email: { $in: scope.accountEmails }, ...(isRef(idOrRef) ? { _id: idOrRef } : { id: idOrRef }) };
  if (accountHint && scope.accountEmails.includes(accountHint)) {
    const hinted = await Email.findOne({ ...base, email: accountHint }).lean();
    if (hinted) return hinted;
  }
  const doc = await Email.findOne(base).lean();
  if (!doc) console.warn(`📭 Email lookup found nothing (${isRef(idOrRef) ? 'ref' : 'id'} of ${String(idOrRef).length} chars, account hint: ${accountHint || 'none'})`);
  return doc;
}

const escapeSubject = (subject) => escapeRegex(String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim());

export const searchEmails = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope || scope.accountEmails.length === 0) {
      return res.json({ success: true, data: { emails: [], total: 0, page: 1, limit: DEFAULT_LIMIT } });
    }
    const limit = clampLimit(req.query.limit);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const query = buildSearchQuery({ userId: scope.user._id, accountEmails: scope.accountEmails, params: req.query });

    const [docs, total] = await Promise.all([
      Email.find(query).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Email.countDocuments(query),
    ]);
    res.json({ success: true, data: { emails: docs.map(summarize), total, page, limit } });
  } catch (error) {
    console.error('Error searching emails:', error.message);
    res.status(500).json({ success: false, error: 'Failed to search emails' });
  }
};

export const getEmailMessage = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope) return res.status(404).json({ success: false, error: 'User not found' });
    const doc = await findOwnedEmail(scope, req.params.id, req.query.email);
    if (!doc) return res.status(404).json({ success: false, error: 'Email not found. Use the ref (or id) exactly as search_mail returned it.' });

    let { text, truncated } = toPlainText(doc.content || doc.preview);
    // Outlook knows which part of the message is new (the rest is quoted history): prefer that when it is reachable.
    try {
      const token = await getToken(scope.user.worxstreamUserId, doc.email, 'outlook');
      const unique = token ? await getMessageUniqueText(token, doc.id) : null;
      if (unique) ({ text, truncated } = { text: unique.slice(0, BODY_CHAR_LIMIT), truncated: unique.length > BODY_CHAR_LIMIT });
    } catch {
      // the stored copy is the fallback
    }
    res.json({ success: true, data: { ...summarize(doc), to: doc.to || '', cc: doc.cc || '', body: text, bodyTruncated: truncated } });
  } catch (error) {
    console.error('Error reading email:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read email' });
  }
};

/**
 * Plain text of the NEW part of a message: cuts the quoted reply history ("From: … Sent: …", "On … wrote:",
 * "-----Original Message-----"), which is the earlier messages of the thread and is returned as messages of its own.
 */
export function latestMessageText(plain) {
  const text = String(plain || '');
  const cut = /(?:^|\n)\s*(?:From:\s[^\n]+\n\s*Sent:|-{3,}\s*Original Message\s*-{3,}|On\s[^\n]{5,160}\swrote:)/i.exec(text);
  return (cut && cut.index > 0 ? text.slice(0, cut.index) : text).trim();
}

const THREAD_MESSAGE_LIMIT = 25;
const THREAD_BODY_COUNT = 8; // the newest messages come with their text
const THREAD_BODY_CHARS = 3000;

/** The messages of one conversation, oldest first, each with its own new text (not the quoted history). */
export const getConversation = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope) return res.status(404).json({ success: false, error: 'User not found' });
    const base = { userId: scope.user._id, email: { $in: scope.accountEmails } };

    // The path may be a conversationId, or the short ref of any message in the thread (easier to pass back exactly).
    let conversationId = req.params.conversationId;
    let seed = null;
    if (isRef(conversationId)) {
      seed = await findOwnedEmail(scope, conversationId, req.query.email);
      if (!seed) return res.status(404).json({ success: false, error: 'Conversation not found. Use a conversationId or ref exactly as search_mail returned it.' });
      conversationId = seed.conversationId || '';
    }

    let docs = [];
    if (conversationId) {
      docs = await Email.find({ ...base, conversationId }).sort({ timestamp: -1 }).limit(THREAD_MESSAGE_LIMIT).lean();
    } else if (seed) {
      // Saved before conversation ids existed: the messages with the same subject (without Re:/Fwd:) stand in for the thread.
      docs = await Email.find({ ...base, subject: { $regex: `^\\s*((re|fw|fwd)\\s*:\\s*)*${escapeSubject(seed.subject)}\\s*$`, $options: 'i' } }).sort({ timestamp: -1 }).limit(THREAD_MESSAGE_LIMIT).lean();
      if (docs.length === 0) docs = [seed];
    }
    if (docs.length === 0) return res.status(404).json({ success: false, error: 'Conversation not found. Use a conversationId or ref exactly as search_mail returned it.' });

    // Preferred: the thread straight from Outlook (every folder, each message's own new text), so it does not depend
    // on what has been synced. The stored copy below is the fallback.
    const anchor = seed || docs[0];
    try {
      const token = anchor ? await getToken(scope.user.worxstreamUserId, anchor.email, 'outlook') : null;
      const liveId = conversationId || anchor?.conversationId;
      const live = token && liveId ? await getConversationLive(token, liveId) : [];
      if (live.length > 0) {
        const stored = await Email.find({ ...base, id: { $in: live.map((m) => m.id) } }, { _id: 1, id: 1, aiMeta: 1 }).lean();
        const byId = new Map(stored.map((d) => [d.id, d]));
        const newest = new Set(live.slice(-THREAD_BODY_COUNT).map((m) => m.id));
        const messages = live.map(({ text, ...m }) => {
          const known = byId.get(m.id);
          const body = text ?? null;
          return {
            ref: known ? String(known._id) : undefined,
            email: anchor.email,
            ...m,
            ...(known?.aiMeta ? { aiMeta: { summary: known.aiMeta.summary || '', category: known.aiMeta.category || null, priority: known.aiMeta.priority || null, sentiment: known.aiMeta.sentiment || null, actionItems: known.aiMeta.actionItems || [] } } : {}),
            ...(newest.has(m.id) && body ? { body: body.slice(0, THREAD_BODY_CHARS) } : {}),
          };
        });
        return res.json({ success: true, data: { conversationId: liveId, count: messages.length, order: 'oldest_first', source: 'outlook', messages } });
      }
    } catch (error) {
      console.warn('⚠️ Live conversation read failed, using the stored copy:', error?.response?.status || error.message);
    }

    // Text for the newest messages: the stored body, or fetched from Outlook when only the list data was synced.
    const withBodies = docs.slice(0, THREAD_BODY_COUNT);
    const texts = new Map();
    await Promise.all(withBodies.map(async (doc) => {
      let html = doc.content;
      if (!html) {
        const token = await getToken(scope.user.worxstreamUserId, doc.email, 'outlook');
        const live = token ? await getMessageById(token, doc.id, { attachments: 'none' }) : null;
        html = live?.content || doc.preview;
      }
      const { text } = toPlainText(html);
      texts.set(doc.id, latestMessageText(text).slice(0, THREAD_BODY_CHARS));
    }));

    const messages = docs
      .map((doc) => ({
        ...summarize(doc),
        to: doc.to || '',
        cc: doc.cc || '',
        ...(texts.has(doc.id) ? { body: texts.get(doc.id) } : {}),
      }))
      .reverse(); // oldest first reads like the conversation
    res.json({ success: true, data: { conversationId: conversationId || null, count: messages.length, order: 'oldest_first', messages } });
  } catch (error) {
    console.error('Error reading conversation:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read conversation' });
  }
};

/** The user's folders per connected account: Outlook's names and counts, which one is Inbox/Sent/Archive..., and how much of it is stored. */
export const listFolders = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope || scope.accountEmails.length === 0) return res.json({ success: true, data: [] });
    const emails = req.query.email && scope.accountEmails.includes(req.query.email) ? [req.query.email] : scope.accountEmails;

    const counts = await Email.aggregate([
      { $match: { userId: scope.user._id, email: { $in: emails } } },
      { $group: { _id: { email: '$email', folder: '$folder' }, total: { $sum: 1 }, unread: { $sum: { $cond: ['$read', 0, 1] } } } },
    ]);
    const stored = (email, folder) => counts.find((c) => c._id.email === email && c._id.folder === folder) || { total: 0, unread: 0 };

    const data = await Promise.all(emails.map(async (email) => {
      let live = [];
      let standard = {};
      try {
        const token = await getToken(scope.user.worxstreamUserId, email, 'outlook');
        if (token) [live, standard] = await Promise.all([listAllFolders(token), wellKnownFolderIds(token).catch(() => ({}))]);
      } catch {
        // names are a convenience: fall back to the folder ids we hold
      }
      const tag = new Map(Object.entries(standard).map(([name, id]) => [id, name]));
      const known = live.length
        ? live
        : [...new Set(counts.filter((c) => c._id.email === email).map((c) => c._id.folder))].map((id) => ({ id, displayName: id, path: id }));
      return {
        email,
        source: live.length ? 'outlook' : 'stored',
        folders: known.map((f) => ({
          id: f.id,
          name: f.displayName,
          path: f.path,
          ...(tag.has(f.id) ? { wellKnown: tag.get(f.id) } : {}),
          ...(f.totalItemCount != null ? { total: f.totalItemCount, unread: f.unreadItemCount } : {}),
          stored: stored(email, f.id).total,
          storedUnread: stored(email, f.id).unread,
        })),
      };
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing folders:', error.message);
    res.status(500).json({ success: false, error: 'Failed to list folders' });
  }
};

/**
 * Search the WHOLE mailbox on Outlook's side ($search): any folder, message bodies, mail that was never synced.
 * Ranked by relevance. Dates (`since`/`until`) are applied to the results.
 */
export const liveSearch = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope || scope.accountEmails.length === 0) return res.json({ success: true, data: { emails: [], total: 0, source: 'outlook' } });
    const kql = buildKql({ q: req.query.q, from: req.query.from, to: req.query.to, subject: req.query.subject, hasAttachments: truthy(req.query.has_attachments) });
    if (!kql) return res.status(400).json({ success: false, error: 'Give at least one of q, from, to, subject or has_attachments.' });
    const limit = clampLimit(req.query.limit);
    const emails = req.query.email && scope.accountEmails.includes(req.query.email) ? [req.query.email] : scope.accountEmails;
    const since = req.query.since ? new Date(req.query.since) : null;
    const until = req.query.until ? new Date(`${String(req.query.until).slice(0, 10)}T23:59:59.999Z`) : null;

    const perAccount = await Promise.all(emails.map(async (email) => {
      const token = await getToken(scope.user.worxstreamUserId, email, 'outlook');
      if (!token) return { email, error: 'connection expired' };
      try {
        return { email, rows: await searchMessagesLive(token, kql, { top: limit }) };
      } catch (error) {
        return { email, error: error?.response?.status === 401 ? 'connection expired' : 'search failed' };
      }
    }));

    let rows = perAccount.flatMap((r) => (r.rows || []).map((m) => ({ ...m, email: r.email })));
    if (since && !Number.isNaN(since.getTime())) rows = rows.filter((m) => new Date(m.timestamp) >= since);
    if (until && !Number.isNaN(until.getTime())) rows = rows.filter((m) => new Date(m.timestamp) <= until);
    rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    rows = rows.slice(0, limit);

    // Messages we also hold get their short ref, so the other tools can read them.
    const stored = await Email.find({ userId: scope.user._id, id: { $in: rows.map((m) => m.id) } }, { _id: 1, id: 1 }).lean();
    const refOf = new Map(stored.map((d) => [d.id, String(d._id)]));
    const emailsOut = rows.map((m) => ({
      ...(refOf.has(m.id) ? { ref: refOf.get(m.id) } : {}),
      id: m.id,
      email: m.email,
      folder: m.folder,
      from: m.from,
      to: m.to,
      subject: m.subject,
      timestamp: m.timestamp,
      read: m.read,
      important: m.important,
      flagged: m.flagged,
      conversationId: m.conversationId,
      hasAttachments: m.hasAttachments,
      preview: String(m.preview || '').slice(0, 200),
    }));
    const failed = perAccount.filter((r) => r.error).map((r) => ({ email: r.email, error: r.error }));
    res.json({ success: true, data: { emails: emailsOut, total: emailsOut.length, source: 'outlook', query: kql, ...(failed.length ? { accountsNotSearched: failed } : {}) } });
  } catch (error) {
    console.error('Error in live search:', error?.response?.status || error.message);
    res.status(500).json({ success: false, error: 'Failed to search the mailbox' });
  }
};

/** How fresh the stored copy of each account is: last sync, what is stored, the running job, push and delta state. */
export const syncStatus = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope || scope.accountEmails.length === 0) return res.json({ success: true, data: [] });
    const accounts = await EmailAccount.find({ userId: scope.user._id }).lean();
    const data = await Promise.all(accounts.map(async (a) => {
      const [stats, job, folders] = await Promise.all([
        Email.aggregate([
          { $match: { userId: scope.user._id, email: a.email } },
          { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: '$timestamp' }, newest: { $max: '$timestamp' }, analysed: { $sum: { $cond: ['$isProcessed', 1, 0] } } } },
        ]),
        SyncJob.findOne({ worxstreamUserId: scope.user.worxstreamUserId, email: a.email }).lean(),
        SyncState.countDocuments({ email: a.email }),
      ]);
      const s = stats[0] || { count: 0, oldest: null, newest: null, analysed: 0 };
      return {
        email: a.email,
        connectionExpired: Boolean(a.isExpired),
        stored: { messages: s.count, oldest: s.oldest, newest: s.newest, analysedByAI: s.analysed },
        lastSyncAt: a.lastSyncAt || null,
        syncedFrom: a.syncFrom || null,
        foldersWithDeltaState: folders,
        push: { active: Boolean(a.graphSubscriptionId && a.graphSubscriptionExpiresAt > new Date()), expiresAt: a.graphSubscriptionExpiresAt || null, watches: a.graphSubscriptionResource || null },
        lastJob: job ? { kind: job.kind || 'sync', status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, summary: job.summary || null, error: job.error || '' } : null,
      };
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error reading sync status:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read the sync status' });
  }
};

/** Names, types and sizes of a message's attachments (no file contents). */
export const listAttachments = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope) return res.status(404).json({ success: false, error: 'User not found' });
    const doc = await findOwnedEmail(scope, req.params.id, req.query.email);
    if (!doc) return res.status(404).json({ success: false, error: 'Email not found. Use the ref (or id) exactly as search_mail returned it.' });
    const token = await getToken(scope.user.worxstreamUserId, doc.email, 'outlook');
    if (!token) return res.status(409).json({ success: false, error: 'The mailbox connection has expired. Reconnect it in Mail settings.' });
    const attachments = (await listAttachmentMeta(token, doc.id)).filter((a) => !a.inline);
    res.json({ success: true, data: { id: doc.id, subject: doc.subject || '(No Subject)', attachments } });
  } catch (error) {
    console.error('Error listing attachments:', error?.response?.status || error.message);
    res.status(502).json({ success: false, error: 'Could not read the attachments from the mailbox' });
  }
};

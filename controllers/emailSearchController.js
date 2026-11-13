import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';
import { getToken } from '../utils/tokenManager.js';
import { getMessageById, listAllFolders, listAttachmentMeta } from '../services/outlookService.js';

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

    const query = { userId: scope.user._id, email: { $in: scope.accountEmails }, id: req.params.id };
    if (req.query.email && scope.accountEmails.includes(req.query.email)) query.email = req.query.email;
    const doc = await Email.findOne(query).lean();
    if (!doc) return res.status(404).json({ success: false, error: 'Email not found' });

    const { text, truncated } = toPlainText(doc.content || doc.preview);
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
    const query = { userId: scope.user._id, email: { $in: scope.accountEmails }, conversationId: req.params.conversationId };
    if (req.query.email && scope.accountEmails.includes(req.query.email)) query.email = req.query.email;
    const docs = await Email.find(query).sort({ timestamp: -1 }).limit(THREAD_MESSAGE_LIMIT).lean();
    if (docs.length === 0) return res.status(404).json({ success: false, error: 'Conversation not found' });

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
    res.json({ success: true, data: { conversationId: req.params.conversationId, count: messages.length, order: 'oldest_first', messages } });
  } catch (error) {
    console.error('Error reading conversation:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read conversation' });
  }
};

/** The user's folders per connected account (names from Outlook, counts from the stored mailbox). */
export const listFolders = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope || scope.accountEmails.length === 0) return res.json({ success: true, data: [] });
    const emails = req.query.email && scope.accountEmails.includes(req.query.email) ? [req.query.email] : scope.accountEmails;

    const counts = await Email.aggregate([
      { $match: { userId: scope.user._id, email: { $in: emails } } },
      { $group: { _id: { email: '$email', folder: '$folder' }, total: { $sum: 1 }, unread: { $sum: { $cond: ['$read', 0, 1] } } } },
    ]);
    const countOf = (email, folder) => counts.find((c) => c._id.email === email && c._id.folder === folder) || { total: 0, unread: 0 };

    const data = await Promise.all(emails.map(async (email) => {
      let names = [];
      try {
        const token = await getToken(scope.user.worxstreamUserId, email, 'outlook');
        if (token) names = await listAllFolders(token);
      } catch {
        // names are a convenience: fall back to the folder ids we hold
      }
      const known = names.length ? names : [...new Set(counts.filter((c) => c._id.email === email).map((c) => c._id.folder))].map((id) => ({ id, displayName: id, path: id }));
      return {
        email,
        folders: known.map((f) => ({ id: f.id, name: f.displayName, path: f.path, ...pick(countOf(email, f.id)) })),
      };
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing folders:', error.message);
    res.status(500).json({ success: false, error: 'Failed to list folders' });
  }
};
const pick = (c) => ({ stored: c.total, unread: c.unread });

/** Names, types and sizes of a message's attachments (no file contents). */
export const listAttachments = async (req, res) => {
  try {
    const scope = await loadScope(req);
    if (!scope) return res.status(404).json({ success: false, error: 'User not found' });
    const query = { userId: scope.user._id, email: { $in: scope.accountEmails }, id: req.params.id };
    if (req.query.email && scope.accountEmails.includes(req.query.email)) query.email = req.query.email;
    const doc = await Email.findOne(query).lean();
    if (!doc) return res.status(404).json({ success: false, error: 'Email not found' });
    const token = await getToken(scope.user.worxstreamUserId, doc.email, 'outlook');
    if (!token) return res.status(409).json({ success: false, error: 'The mailbox connection has expired. Reconnect it in Mail settings.' });
    const attachments = (await listAttachmentMeta(token, doc.id)).filter((a) => !a.inline);
    res.json({ success: true, data: { id: doc.id, subject: doc.subject || '(No Subject)', attachments } });
  } catch (error) {
    console.error('Error listing attachments:', error?.response?.status || error.message);
    res.status(502).json({ success: false, error: 'Could not read the attachments from the mailbox' });
  }
};

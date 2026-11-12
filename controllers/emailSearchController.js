import Email from '../models/email.js';
import User from '../models/User.js';
import EmailAccount from '../models/EmailAccount.js';

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
  if (params.q) {
    const rx = { $regex: escapeRegex(params.q), $options: 'i' };
    and.push({ $or: [{ subject: rx }, { from: rx }, { 'aiMeta.summary': rx }] });
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

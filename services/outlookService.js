import { retryTransient, isOutlookUnavailableError } from '../utils/transientRetry.js';
import axios from 'axios';
import { debug } from '../utils/logger.js';
import { installGraphDefaults } from './graphDefaults.js';

installGraphDefaults(); // immutable ids on every Graph call (see graphDefaults.js)

function looksLikeHtml(body) {
  return /<\/?[a-z][\s\S]*>/i.test(String(body || ''));
}

/** Graph expects `HTML` or `Text`. Prefer explicit contentType; else detect tags. */
function resolveGraphBodyContentType(contentType, body) {
  const explicit = String(contentType || '').trim().toLowerCase();
  if (explicit === 'html' || explicit === 'text/html') return 'HTML';
  if (explicit === 'text' || explicit === 'text/plain') return 'Text';
  return looksLikeHtml(body) ? 'HTML' : 'Text';
}

// 📤 Send email
async function sendEmail(accessToken, { to, subject = '', body, cc, bcc, contentType }) {
  try {
    const message = {
      subject,
      body: {
        contentType: resolveGraphBodyContentType(contentType, body),
        content: body
      },
      toRecipients: to
        ? to.split(',').map(addr => ({
            emailAddress: { address: addr.trim() }
          }))
        : [],
      ccRecipients: cc
        ? cc.split(',').map(addr => ({
            emailAddress: { address: addr.trim() }
          }))
        : [],
      bccRecipients: bcc
        ? bcc.split(',').map(addr => ({
            emailAddress: { address: addr.trim() }
          }))
        : []
    };

    await axios.post(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        message,
        saveToSentItems: true
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return { success: true };
  } catch (err) {
    console.error('❌ Failed to send email:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// 📧 Reply to email
async function replyToEmail(accessToken, { messageId, comment, toRecipients, ccRecipients, bccRecipients }) {
  try {
    debug(`📧 Replying to message ${messageId}`);
    
    const replyData = {
      comment: comment || '',
      toRecipients: toRecipients || [],
      ccRecipients: ccRecipients || [],
      bccRecipients: bccRecipients || []
    };

    await axios.post(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}/reply`,
      replyData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    debug(`✅ Reply sent successfully for message ${messageId}`);
    return { success: true };
  } catch (err) {
    console.error('❌ Failed to reply to email:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// 📧 Reply all to email
async function replyAllToEmail(accessToken, { messageId, comment, toRecipients, ccRecipients, bccRecipients }) {
  try {
    debug(`📧 Reply all to message ${messageId}`);
    
    const replyAllData = {
      comment: comment || '',
      toRecipients: toRecipients || [],
      ccRecipients: ccRecipients || [],
      bccRecipients: bccRecipients || []
    };

    await axios.post(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}/replyAll`,
      replyAllData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    debug(`✅ Reply all sent successfully for message ${messageId}`);
    return { success: true };
  } catch (err) {
    console.error('❌ Failed to reply all to email:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// get folders with count 
async function getMailFolders(accessToken) {
  try {
    // Every folder, paged (the plain call returns only the first 10 top-level folders); sub-folders as "Parent/Child".
    const all = await listAllFolders(accessToken);
    const folders = all.map((f) => ({ id: f.id, displayName: f.path, totalItemCount: f.totalItemCount, unreadItemCount: f.unreadItemCount }));

    debug(`📂 Retrieved ${folders.length} folders`);
    return folders;
  } catch (err) {
    console.error('❌ Failed to fetch folders:', err?.response?.status, JSON.stringify(err?.response?.data || err.message));
    // A rejected token or a Microsoft outage is reported to the caller (it can refresh, or tell the user);
    // other failures keep the old empty list.
    if (err?.response?.status === 401 || isOutlookUnavailableError(err)) throw err;
    return [];
  }
}

// get mail by id
const MESSAGE_SELECT = 'id,subject,from,toRecipients,ccRecipients,bccRecipients,body,receivedDateTime,isRead,importance,flag,conversationId,hasAttachments,parentFolderId';
// contentId only exists on file attachments, so it cannot be selected from the mixed list (that is a 400); it comes
// with the single-attachment fetch below.
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline';
/** Inline images are embedded in the body, so their bytes come with the message; anything bigger is left out. */
const INLINE_BYTES_LIMIT = 2 * 1024 * 1024;

const formatAddress = (r) => `${r?.emailAddress?.name || ''} <${r?.emailAddress?.address || ''}>`;
const escapeHtml = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * One message for the reading pane. A single small JSON call for the message plus one for the attachment list (run
 * together), instead of downloading the whole raw message with every attachment inside it. Real attachments come back
 * as metadata only (`contentBytes: ''`); fetch the bytes when the user downloads one (getAttachmentContent). Inline
 * images are fetched with the message so the body can show them.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {{ attachments?: 'inline' | 'meta' | 'none' }} [opts] 'meta' lists the attachments without downloading inline image bytes (the page then
 *   streams them with fetchInlineImages); 'none' skips the attachment calls (push notifications do not need them)
 */
async function getMessageById(accessToken, messageId, opts = {}) {
  try {
    const headers = { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="html"' };
    const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`;

    const messageReq = retryTransient(() => axios.get(base, { headers, params: { $select: MESSAGE_SELECT } }));
    const listReq = opts.attachments === 'none'
      ? Promise.resolve([])
      : retryTransient(() => axios.get(`${base}/attachments`, { headers, params: { $select: ATTACHMENT_SELECT } }))
          .then((r) => r.data.value || [])
          .catch((err) => {
            console.error('⚠️ Could not list attachments:', err?.response?.status || err.message);
            return [];
          });
    const [{ data: m }, attachmentList] = await Promise.all([messageReq, listReq]);

    const files = attachmentList.filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment');
    const attachments = await Promise.all(files.map(async (a) => {
      const out = {
        id: a.id,
        name: a.name || (a.contentId ? String(a.contentId) : 'attachment'),
        contentId: a.contentId || undefined,
        contentType: a.contentType,
        size: a.size,
        isInline: Boolean(a.isInline),
        contentBytes: '',
      };
      if (out.isInline && out.size <= INLINE_BYTES_LIMIT && opts.attachments !== 'meta') {
        try {
          const r = await retryTransient(() => axios.get(`${base}/attachments/${encodeURIComponent(a.id)}`, { headers }));
          out.contentBytes = r.data.contentBytes || '';
          out.contentId = r.data.contentId || out.contentId;
        } catch (err) {
          console.error('⚠️ Could not fetch inline image:', err?.response?.status || err.message);
        }
      }
      return out;
    }));

    const body = m.body || {};
    const content = body.contentType === 'text'
      ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(body.content || '')}</pre>`
      : body.content || '';

    return {
      id: m.id,
      from: formatAddress(m.from),
      to: (m.toRecipients || []).map(formatAddress).join(', '),
      cc: (m.ccRecipients || []).map(formatAddress).join(', '),
      bcc: (m.bccRecipients || []).map(formatAddress).join(', '),
      subject: m.subject || '',
      content,
      timestamp: m.receivedDateTime || new Date().toISOString(),
      read: Boolean(m.isRead),
      folder: m.parentFolderId || null,
      important: m.importance === 'high',
      flagged: m.flag?.flagStatus === 'flagged',
      conversationId: m.conversationId || '',
      hasAttachments: attachments.some((a) => !a.isInline),
      attachments,
    };
  } catch (err) {
    console.error('❌ Failed to fetch message:', err?.response?.status, err?.response?.data?.error?.message || err.message);
    return null;
  }
}

const THREAD_SELECT = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,flag,hasAttachments,parentFolderId,bodyPreview,uniqueBody';
const asText = { Prefer: 'outlook.body-content-type="text"' };
const squeeze = (t) => String(t || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

/** One Graph message as a thread entry. `uniqueBody` is Outlook's own "the part of this message that is new" (no quoted history). */
export function shapeThreadMessage(m) {
  const addr = (r) => `${r?.emailAddress?.name || ''} <${r?.emailAddress?.address || ''}>`;
  return {
    id: m.id,
    conversationId: m.conversationId || '',
    folder: m.parentFolderId || '',
    from: addr(m.from),
    to: (m.toRecipients || []).map(addr).join(', '),
    cc: (m.ccRecipients || []).map(addr).join(', '),
    subject: m.subject || '(No Subject)',
    timestamp: m.receivedDateTime || null,
    read: Boolean(m.isRead),
    important: m.importance === 'high',
    flagged: m.flag?.flagStatus === 'flagged',
    hasAttachments: Boolean(m.hasAttachments),
    preview: String(m.bodyPreview || '').slice(0, 200),
    /** null when Outlook has no unique body for it (then the caller falls back to the stored body). */
    text: m.uniqueBody?.content ? squeeze(m.uniqueBody.content) : null,
  };
}

/**
 * The whole conversation straight from Outlook, oldest first, in every folder (Sent, Archive, ...), each message with its
 * own new text. Not limited to what has been synced.
 */
export async function getConversationLive(accessToken, conversationId) {
  const id = String(conversationId || '').replace(/'/g, "''");
  const res = await retryTransient(() => axios.get('https://graph.microsoft.com/v1.0/me/messages', {
    headers: { Authorization: `Bearer ${accessToken}`, ...asText },
    params: { $filter: `conversationId eq '${id}'`, $select: THREAD_SELECT, $top: 25 },
  }));
  return (res.data.value || []).map(shapeThreadMessage).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/** The new text of one message (Outlook's uniqueBody, plain text), or null when it has none. */
export async function getMessageUniqueText(accessToken, messageId) {
  const res = await retryTransient(() => axios.get(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, ...asText },
    params: { $select: 'id,uniqueBody' },
  }));
  const content = res.data?.uniqueBody?.content;
  return content ? squeeze(content) : null;
}

/** One message's list fields (read state, flags, folder, conversation). Returns null when the message no longer exists. */
export async function getMessageMeta(accessToken, messageId) {
  try {
    const res = await retryTransient(() => axios.get(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { $select: META_SELECT },
    }));
    return mapGraphMessage(res.data, res.data.parentFolderId);
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/** What a message has attached: name, type and size only (no file bytes). */
export async function listAttachmentMeta(accessToken, messageId) {
  const res = await retryTransient(() => axios.get(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`,
    { headers: { Authorization: `Bearer ${accessToken}` }, params: { $select: 'id,name,contentType,size,isInline' } },
  ));
  return (res.data.value || []).map((a) => ({
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    inline: Boolean(a.isInline),
  }));
}

/**
 * Inline images of a message (the pictures inside the body: signature logos, screenshots), fetched AFTER the message is
 * shown. A long thread carries every message's signature images, and Outlook allows only a few requests at once per
 * mailbox, so they are fetched a few at a time and handed over one by one as they arrive.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {Array<{ id: string, isInline?: boolean, size?: number }>} attachments  from getMessageById(..., { attachments: 'meta' })
 * @param {{ concurrency?: number, max?: number, maxBytes?: number, onImage?: (img: { contentId: string, contentType: string, contentBytes: string }) => void }} [opts]
 * @returns {Promise<number>} how many images were delivered
 */
export async function fetchInlineImages(accessToken, messageId, attachments, { concurrency = 3, max = 24, maxBytes = 1.5 * 1024 * 1024, onImage = () => {}, http = axios } = {}) {
  const todo = (attachments || []).filter((a) => a.isInline && (a.size ?? 0) <= maxBytes).slice(0, max);
  const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  let next = 0;
  let delivered = 0;
  const worker = async () => {
    while (next < todo.length) {
      const a = todo[next++];
      try {
        const r = await retryTransient(() => http.get(`${base}/${encodeURIComponent(a.id)}`, { headers }));
        const img = { contentId: r.data.contentId || '', contentType: r.data.contentType || 'application/octet-stream', contentBytes: r.data.contentBytes || '' };
        if (img.contentId && img.contentBytes) {
          delivered += 1;
          onImage(img);
        }
      } catch (err) {
        console.warn('⚠️ Could not fetch an inline image:', err?.response?.status || err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return delivered;
}

/** The bytes of one attachment, fetched when the user downloads it. */
export async function getAttachmentContent(accessToken, messageId, attachmentId) {
  const res = await retryTransient(() => axios.get(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  ));
  const a = res.data;
  return { id: a.id, name: a.name, contentType: a.contentType, size: a.size, contentBytes: a.contentBytes || '' };
}

// get messages by folder
/** `opts.throwOnError`: surface Graph failures to the caller (sync needs to tell "nothing new" from "failed"); default keeps the old empty-list fallback. */
async function getMessagesByFolder(accessToken, folderId, nextLink = null, top = 20, opts = {}) {
  try {
    const url = nextLink
      ? nextLink
      : `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,body,receivedDateTime,isRead,importance,flag,conversationId,hasAttachments`;

    const res = await retryTransient(() => axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    }));

    const messages = res.data.value.map(msg => {
      const mappedMsg = {
        id: msg.id,
        from: `${msg.from?.emailAddress?.name || ''} <${msg.from?.emailAddress?.address || ''}>`,
        to: msg.toRecipients?.map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address || ''}>`).join(', ') || '',
        cc: msg.ccRecipients?.map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address || ''}>`).join(', ') || '',
        bcc: msg.bccRecipients?.map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address || ''}>`).join(', ') || '',
        subject: msg.subject || '(No Subject)',
        preview: msg.bodyPreview || '',
        content: msg.body?.content || '',
        timestamp: msg.receivedDateTime,
        read: msg.isRead || false,
        folder: folderId,
        important: msg.importance === "high",
        flagged: msg.flag?.flagStatus === "flagged",
        conversationId: msg.conversationId || '',
        hasAttachments: Boolean(msg.hasAttachments)
      };

      // Ensure all required fields are present
      if (!mappedMsg.id || !mappedMsg.from || !mappedMsg.timestamp) {
        console.error('❌ Message missing required fields:', mappedMsg);
        return null;
      }

      return mappedMsg;
    }).filter(Boolean); // Remove any null messages

    return {
      messages,
      nextLink: res.data['@odata.nextLink'] || null
    };
  } catch (err) {
    console.error('❌ Failed to fetch messages:', err?.response?.status, JSON.stringify(err?.response?.data || err.message));
    if (err.response?.data) {
      console.error('❌ Full error response:', err.response.data);
    }
    if (opts.throwOnError) throw err;
    return { messages: [], nextLink: null };
  }
}


// mark message as read
async function markMessageRead(accessToken, messageId) {
  try {
    return await axios.patch(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
      { isRead: true },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error("❌ Failed to mark as read:", err.response?.data || err.message);
    throw err;
  }
}

// mark message as important and/or flagged
async function markMessageImportant(accessToken, messageId, important = true) {
  try {
    const patchBody = {
      importance: important ? "high" : "normal"
    };

    return await axios.patch(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
      patchBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error("❌ Failed to update importance:", err.response?.data || err.message);
    throw err;
  }
}

// get attachments by message id
// get attachments by message id
async function getAttachmentsByMessageId(accessToken, messageId) {
  try {
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    debug(`📎 Raw attachments for message ${messageId}:`, res.data.value);

    const filtered = res.data.value
      .filter(att => att['@odata.type'] === '#microsoft.graph.fileAttachment');

    debug(`📎 Inline file attachments (filtered):`, filtered);

    const mapped = filtered.map(att => ({
      id: att.id,
      name: att.name,
      contentId: att.contentId,
      contentType: att.contentType,
      size: att.size,
      isInline: att.isInline,
      contentBytes: att.contentBytes,
    }));

    // Check for missing contentBytes
    mapped.forEach(att => {
      if (!att.contentBytes) {
        console.warn(`⚠️ Attachment ${att.name} is missing contentBytes!`);
      }
    });

    return mapped;
  } catch (err) {
    console.error("❌ Failed to fetch attachments:", err.response?.data || err.message);
    return [];
  }
}

/**
 * Every folder of the mailbox, sub-folders included (the plain folder list only returns the first top-level folders),
 * with item counts. `path` is "Parent/Child".
 * @returns {Promise<Array<{ id: string, displayName: string, path: string, totalItemCount: number, unreadItemCount: number }>>}
 */
export async function listAllFolders(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const out = [];
  const walk = async (url, parentPath) => {
    let next = url;
    while (next) {
      const res = await retryTransient(() => axios.get(next, { headers, params: next.includes('?') ? undefined : { $top: 100, $select: 'id,displayName,childFolderCount,totalItemCount,unreadItemCount' } }));
      for (const f of res.data.value || []) {
        const path = parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
        out.push({ id: f.id, displayName: f.displayName, path, totalItemCount: f.totalItemCount ?? 0, unreadItemCount: f.unreadItemCount ?? 0 });
        if (f.childFolderCount > 0) {
          await walk(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(f.id)}/childFolders`, path);
        }
      }
      next = res.data['@odata.nextLink'] || null;
    }
  };
  await walk('https://graph.microsoft.com/v1.0/me/mailFolders', '');
  return out;
}

const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'archive', 'junkemail', 'outbox'];

/**
 * Ids of the standard folders (Inbox, Sent Items, Drafts, Deleted Items, Archive, Junk, Outbox) in ONE $batch call.
 * Folders the mailbox does not have (for example no Archive) are left out.
 * @returns {Promise<Record<string, string>>} well-known name -> folder id
 */
export async function wellKnownFolderIds(accessToken) {
  const res = await retryTransient(() => axios.post('https://graph.microsoft.com/v1.0/$batch', {
    requests: WELL_KNOWN.map((name, i) => ({ id: String(i + 1), method: 'GET', url: `/me/mailFolders/${name}?$select=id` })),
  }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }));
  const out = {};
  for (const r of res.data.responses || []) {
    if (r.status === 200 && r.body?.id) out[WELL_KNOWN[Number(r.id) - 1]] = r.body.id;
  }
  return out;
}

/** Graph message -> the shape the stored mailbox uses (the body only when asked for). */
export function mapGraphMessage(msg, folderId) {
  const addr = (r) => `${r?.emailAddress?.name || ''} <${r?.emailAddress?.address || ''}>`;
  return {
    id: msg.id,
    from: addr(msg.from),
    to: (msg.toRecipients || []).map(addr).join(', '),
    cc: (msg.ccRecipients || []).map(addr).join(', '),
    bcc: (msg.bccRecipients || []).map(addr).join(', '),
    subject: msg.subject || '(No Subject)',
    preview: msg.bodyPreview || '',
    ...(msg.body ? { content: msg.body.content || '' } : {}),
    timestamp: msg.receivedDateTime,
    read: Boolean(msg.isRead),
    important: msg.importance === 'high',
    flagged: msg.flag?.flagStatus === 'flagged',
    conversationId: msg.conversationId || '',
    hasAttachments: Boolean(msg.hasAttachments),
    folder: msg.parentFolderId || folderId,
  };
}

const META_SELECT = 'id,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,receivedDateTime,isRead,importance,flag,conversationId,hasAttachments,parentFolderId';
const iso = (d) => new Date(d).toISOString();

/**
 * A page (100) of one folder's messages received between `since` and `until` (either may be omitted), newest first.
 * Uses the standard $filter on receivedDateTime. `withBody` adds the message body (needed for AI analysis).
 */
export async function listFolderMessagesRange(accessToken, folderId, { since, until, nextLink = null, withBody = false } = {}) {
  const url = nextLink || `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
  const filter = [since && `receivedDateTime ge ${iso(since)}`, until && `receivedDateTime le ${iso(until)}`].filter(Boolean).join(' and ');
  const res = await retryTransient(() => axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: nextLink ? undefined : {
      $top: 100,
      $orderby: 'receivedDateTime desc',
      $select: withBody ? `${META_SELECT},body` : META_SELECT,
      ...(filter ? { $filter: filter } : {}),
    },
  }));
  return { rows: (res.data.value || []).map((m) => mapGraphMessage(m, folderId)), nextLink: res.data['@odata.nextLink'] || null };
}

/**
 * One page of a folder's DELTA: what was created or changed (rows) and what was deleted or moved out (removed ids) since
 * the last sync. Follow `nextLink` until a page returns `deltaLink`; keep that link and pass it as `link` next time to get
 * only the changes since. A 410 answer means the saved link expired: start again without it. `since` limits a first
 * (full) pass to recent mail.
 */
export async function deltaFolderMessages(accessToken, folderId, link = null, { since } = {}) {
  const url = link || `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`;
  const res = await retryTransient(() => axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'odata.maxpagesize=100' },
    params: link ? undefined : { $select: META_SELECT, ...(since ? { $filter: `receivedDateTime ge ${iso(since)}` } : {}) },
  }));
  const rows = [];
  const removed = [];
  for (const m of res.data.value || []) {
    if (m['@removed']) removed.push(m.id);
    else rows.push(mapGraphMessage(m, folderId));
  }
  return { rows, removed, nextLink: res.data['@odata.nextLink'] || null, deltaLink: res.data['@odata.deltaLink'] || null };
}

/** Builds a $search (KQL) string from separate parts. Values are quoted and cleaned so they cannot change the query. */
export function buildKql({ q, from, to, subject, hasAttachments } = {}) {
  const clean = (v) => String(v).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const part = (key, v) => {
    const value = v ? clean(v) : '';
    if (!value) return '';
    return value.includes(' ') ? `${key}:"${value}"` : `${key}:${value}`;
  };
  return [
    q && clean(q) ? clean(q) : '',
    part('from', from),
    part('to', to),
    part('subject', subject),
    hasAttachments ? 'hasattachments:true' : '',
  ].filter(Boolean).join(' ');
}

/**
 * Searches the WHOLE mailbox on Outlook's side (any folder, message bodies, mail that was never synced) with $search.
 * Results are ranked by relevance; $search cannot be combined with $filter or $orderby, so dates are applied by the caller.
 */
export async function searchMessagesLive(accessToken, kql, { top = 25 } = {}) {
  if (!kql) return [];
  const res = await retryTransient(() => axios.get('https://graph.microsoft.com/v1.0/me/messages', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { $search: `"${kql.replace(/"/g, '\\"')}"`, $top: Math.min(Math.max(top, 1), 50), $select: META_SELECT },
  }));
  return (res.data.value || []).map((m) => mapGraphMessage(m, m.parentFolderId));
}

/**
 * One page (100) of a folder's messages with everything the list shows but not the body. Used by the full sync to
 * bring the saved copy back in line with Outlook (read state, flags, conversation id, subject, folder).
 */
export async function listFolderMessageMeta(accessToken, folderId, nextLink = null) {
  const url = nextLink || `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
  const res = await retryTransient(() => axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: nextLink ? undefined : {
      $top: 100,
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,receivedDateTime,isRead,importance,flag,conversationId,hasAttachments',
    },
  }));
  const addr = (r) => `${r?.emailAddress?.name || ''} <${r?.emailAddress?.address || ''}>`;
  return {
    rows: (res.data.value || []).map((m) => ({
      id: m.id,
      from: addr(m.from),
      to: (m.toRecipients || []).map(addr).join(', '),
      cc: (m.ccRecipients || []).map(addr).join(', '),
      bcc: (m.bccRecipients || []).map(addr).join(', '),
      subject: m.subject || '(No Subject)',
      preview: m.bodyPreview || '',
      timestamp: m.receivedDateTime,
      read: Boolean(m.isRead),
      important: m.importance === 'high',
      flagged: m.flag?.flagStatus === 'flagged',
      conversationId: m.conversationId || '',
      hasAttachments: Boolean(m.hasAttachments),
    })),
    nextLink: res.data['@odata.nextLink'] || null,
  };
}

/**
 * Light listing of a folder: only the ids and thread ids, 100 per page. Used to give conversation ids to messages that
 * were saved before threading existed (one Graph call per 100 messages instead of one per message).
 */
export async function getFolderThreadIds(accessToken, folderId, nextLink = null) {
  const url = nextLink || `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$top=100&$orderby=receivedDateTime desc&$select=id,conversationId,hasAttachments`;
  const res = await retryTransient(() => axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }));
  return {
    rows: (res.data.value || []).map((m) => ({ id: m.id, conversationId: m.conversationId || '', hasAttachments: Boolean(m.hasAttachments) })),
    nextLink: res.data['@odata.nextLink'] || null,
  };
}

/**
 * The messages of one conversation (Outlook thread), newest first. Summary fields only: the body of a message is
 * fetched when the user opens it. Sent replies and other folders are included because Graph filters the whole mailbox.
 */
export async function getConversationMessages(accessToken, conversationId) {
  const id = String(conversationId || '').replace(/'/g, "''");
  const res = await retryTransient(() => axios.get('https://graph.microsoft.com/v1.0/me/messages', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      $filter: `conversationId eq '${id}'`,
      $select: 'id,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,hasAttachments,parentFolderId,importance',
      $top: 50,
    },
  }));
  const addr = (r) => `${r?.emailAddress?.name || ''} <${r?.emailAddress?.address || ''}>`;
  return (res.data.value || [])
    .map((m) => ({
      id: m.id,
      from: addr(m.from),
      to: (m.toRecipients || []).map(addr).join(', '),
      subject: m.subject || '(No Subject)',
      preview: m.bodyPreview || '',
      timestamp: m.receivedDateTime,
      read: Boolean(m.isRead),
      hasAttachments: Boolean(m.hasAttachments),
      folder: m.parentFolderId || '',
      important: m.importance === 'high',
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export const deleteMessage = async (token, messageId) => {
  try {
    const response = await axios.delete(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.status === 204;
  } catch (error) {
    console.error('Error deleting message:', error);
    throw error;
  }
};

export { sendEmail, replyToEmail, replyAllToEmail, getMailFolders, getMessageById, getMessagesByFolder, markMessageRead, markMessageImportant, getAttachmentsByMessageId };

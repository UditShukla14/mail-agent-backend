import { retryTransient, isOutlookUnavailableError } from '../utils/transientRetry.js';
import axios from 'axios';
import { debug } from '../utils/logger.js';

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
    const res = await retryTransient(() => axios.get('https://graph.microsoft.com/v1.0/me/mailFolders', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }));

    const folders = res.data.value.map(folder => ({
      id: folder.id,
      displayName: folder.displayName,
      totalItemCount: folder.totalItemCount,
      unreadItemCount: folder.unreadItemCount
    }));

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
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,contentId';
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
 * @param {{ attachments?: 'inline' | 'none' }} [opts] 'none' skips the attachment calls (push notifications do not need them)
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
      if (out.isInline && out.size <= INLINE_BYTES_LIMIT) {
        try {
          const r = await retryTransient(() => axios.get(`${base}/attachments/${encodeURIComponent(a.id)}`, { headers }));
          out.contentBytes = r.data.contentBytes || '';
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

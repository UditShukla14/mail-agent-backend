import axios from 'axios';
import { simpleParser } from 'mailparser';
// 📤 Send email
async function sendEmail(accessToken, { to, subject = '', body, cc, bcc }) {
  try {
    const message = {
      subject,
      body: {
        contentType: 'Text',
        content: body
      },
      toRecipients: to
        ? [{ emailAddress: { address: to } }]
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


// get folders with count 
async function getMailFolders(accessToken) {
  try {
    const res = await axios.get('https://graph.microsoft.com/v1.0/me/mailFolders', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const folders = res.data.value.map(folder => ({
      id: folder.id,
      displayName: folder.displayName,
      totalItemCount: folder.totalItemCount,
      unreadItemCount: folder.unreadItemCount
    }));

    console.log(`📂 Retrieved ${folders.length} folders`);
    return folders;
  } catch (err) {
    console.error('❌ Failed to fetch folders:', err?.response?.data || err.message);
    return [];
  }
}

// get mail by id 
async function getMessageById(accessToken, messageId) {
  try {
    // Fetch raw MIME
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}/$value`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/octet-stream'
        },
        responseType: 'arraybuffer'
      }
    );

    // Parse MIME
    const parsed = await simpleParser(res.data);

    // Inline + regular attachments
    const attachments = parsed.attachments.map(att => ({
      id: att.cid || att.checksum || att.filename,
      name: att.filename,
      contentId: att.cid,
      contentType: att.contentType,
      size: att.size || att.content?.length,
      isInline: !!att.cid,
      contentBytes: att.content.toString('base64'),
    }));

    return {
      id: messageId,
      from: `${parsed.from?.text || ''}`,
      subject: parsed.subject || '',
      content: parsed.html || parsed.textAsHtml || '',
      timestamp: parsed.date?.toISOString() || new Date().toISOString(),
      read: true, // MIME doesn't expose isRead
      folder: null, // Not available in MIME
      important: false, // Not available in MIME
      flagged: false,   // Not available in MIME
      attachments
    };
  } catch (err) {
    console.error('❌ Failed to fetch or parse full email MIME:', err?.response?.data || err.message);
    return null;
  }
}


// get messages by folder
async function getMessagesByFolder(accessToken, folderId, nextLink = null, top = 20) {
  try {
    const url = nextLink
      ? nextLink
      : `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,bodyPreview,body,receivedDateTime,isRead,importance,flag,conversationId`;

    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const messages = res.data.value.map(msg => {
      const mappedMsg = {
        id: msg.id,
        from: `${msg.from?.emailAddress?.name || ''} <${msg.from?.emailAddress?.address || ''}>`,
        to: msg.toRecipients?.map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address || ''}>`).join(', ') || '',
        subject: msg.subject || '(No Subject)',
        preview: msg.bodyPreview || '',
        content: msg.body?.content || '',
        timestamp: msg.receivedDateTime,
        read: msg.isRead || false,
        folder: folderId,
        important: msg.importance === "high",
        flagged: msg.flag?.flagStatus === "flagged",
        conversationId: msg.conversationId
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
    console.error('❌ Failed to fetch messages:', err?.response?.data || err.message);
    if (err.response?.data) {
      console.error('❌ Full error response:', err.response.data);
    }
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

    console.log(`📎 Raw attachments for message ${messageId}:`, res.data.value);

    const filtered = res.data.value
      .filter(att => att['@odata.type'] === '#microsoft.graph.fileAttachment' && att.isInline);

    console.log(`📎 Inline file attachments (filtered):`, filtered);

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



export { sendEmail, getMailFolders, getMessageById, getMessagesByFolder, markMessageRead, markMessageImportant, getAttachmentsByMessageId };

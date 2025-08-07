import axios from 'axios';
import { google } from 'googleapis';
import { simpleParser } from 'mailparser';

// Initialize Gmail API client
const getGmailClient = (accessToken) => {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
};

// Get Gmail folders (labels)
async function getMailFolders(accessToken) {
  try {
    const gmail = getGmailClient(accessToken);
    const response = await gmail.users.labels.list({
      userId: 'me'
    });

    const folders = response.data.labels.map(label => ({
      id: label.id,
      displayName: label.name,
      totalItemCount: label.messagesTotal || 0,
      unreadItemCount: label.messagesUnread || 0
    }));

    console.log(`📂 Retrieved ${folders.length} Gmail labels`);
    return folders;
  } catch (err) {
    console.error('❌ Failed to fetch Gmail labels:', err?.response?.data || err.message);
    return [];
  }
}

// Get messages by folder (label)
async function getMessagesByFolder(accessToken, folderId, nextPageToken = null, maxResults = 20) {
  try {
    const gmail = getGmailClient(accessToken);
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [folderId],
      maxResults,
      pageToken: nextPageToken
    });

    const messages = await Promise.all(
      response.data.messages.map(async (message) => {
        const fullMessage = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        const headers = fullMessage.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const to = headers.find(h => h.name === 'To')?.value || '';
        const cc = headers.find(h => h.name === 'Cc')?.value || '';
        const bcc = headers.find(h => h.name === 'Bcc')?.value || '';
        
        // Get message body
        let content = '';
        if (fullMessage.data.payload.parts) {
          const textPart = fullMessage.data.payload.parts.find(
            part => part.mimeType === 'text/plain'
          );
          if (textPart) {
            content = Buffer.from(textPart.body.data, 'base64').toString();
          }
        } else if (fullMessage.data.payload.body.data) {
          content = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString();
        }

        return {
          id: message.id,
          from,
          to,
          cc,
          bcc,
          subject,
          content,
          preview: content.substring(0, 100),
          timestamp: new Date(parseInt(fullMessage.data.internalDate)),
          read: !fullMessage.data.labelIds.includes('UNREAD'),
          folder: folderId,
          important: fullMessage.data.labelIds.includes('IMPORTANT'),
          flagged: fullMessage.data.labelIds.includes('STARRED')
        };
      })
    );

    return {
      messages,
      nextLink: response.data.nextPageToken
    };
  } catch (err) {
    console.error('❌ Failed to fetch Gmail messages:', err?.response?.data || err.message);
    return { messages: [], nextLink: null };
  }
}

// Get message by ID
async function getMessageById(accessToken, messageId) {
  try {
    const gmail = getGmailClient(accessToken);
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const message = response.data;
    const headers = message.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const to = headers.find(h => h.name === 'To')?.value || '';
    const cc = headers.find(h => h.name === 'Cc')?.value || '';
    const bcc = headers.find(h => h.name === 'Bcc')?.value || '';

    // Get message body and attachments
    let content = '';
    const attachments = [];

    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain') {
          content = Buffer.from(part.body.data, 'base64').toString();
        } else if (part.filename) {
          attachments.push({
            id: part.body.attachmentId,
            name: part.filename,
            contentType: part.mimeType,
            size: part.body.size,
            isInline: part.headers.some(h => h.name === 'Content-Disposition' && h.value.includes('inline'))
          });
        }
      }
    } else if (message.payload.body.data) {
      content = Buffer.from(message.payload.body.data, 'base64').toString();
    }

    return {
      id: messageId,
      from,
      to,
      cc,
      bcc,
      subject,
      content,
      timestamp: new Date(parseInt(message.internalDate)),
      read: !message.labelIds.includes('UNREAD'),
      folder: message.labelIds[0], // Primary label
      important: message.labelIds.includes('IMPORTANT'),
      flagged: message.labelIds.includes('STARRED'),
      attachments
    };
  } catch (err) {
    console.error('❌ Failed to fetch Gmail message:', err?.response?.data || err.message);
    return null;
  }
}

// Mark message as read
async function markMessageRead(accessToken, messageId) {
  try {
    const gmail = getGmailClient(accessToken);
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD']
      }
    });
    return true;
  } catch (err) {
    console.error('❌ Failed to mark Gmail message as read:', err?.response?.data || err.message);
    throw err;
  }
}

// Mark message as important
async function markMessageImportant(accessToken, messageId, important = true) {
  try {
    const gmail = getGmailClient(accessToken);
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        [important ? 'addLabelIds' : 'removeLabelIds']: ['IMPORTANT']
      }
    });
    return true;
  } catch (err) {
    console.error('❌ Failed to update Gmail message importance:', err?.response?.data || err.message);
    throw err;
  }
}

// Send email
async function sendEmail(accessToken, { to, subject = '', body, cc, bcc }) {
  try {
    const gmail = getGmailClient(accessToken);
    
    // Create email message
    const message = [
      'Content-Type: text/plain; charset="UTF-8"\n',
      'MIME-Version: 1.0\n',
      `To: ${to}\n`,
      cc ? `Cc: ${cc}\n` : '',
      bcc ? `Bcc: ${bcc}\n` : '',
      `Subject: ${subject}\n\n`,
      body
    ].join('');

    // Encode message
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send message
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    return { success: true };
  } catch (err) {
    console.error('❌ Failed to send Gmail:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Delete message
async function deleteMessage(accessToken, messageId) {
  try {
    const gmail = getGmailClient(accessToken);
    await gmail.users.messages.trash({
      userId: 'me',
      id: messageId
    });
    return true;
  } catch (err) {
    console.error('❌ Failed to delete Gmail message:', err?.response?.data || err.message);
    throw err;
  }
}

export {
  getMailFolders,
  getMessagesByFolder,
  getMessageById,
  markMessageRead,
  markMessageImportant,
  sendEmail,
  deleteMessage
}; 
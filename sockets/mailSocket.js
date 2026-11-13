// sockets/mailSocket.js
import {
  getMailFolders,
  getMessagesByFolder,
  getConversationMessages,
  getAttachmentContent,
  fetchInlineImages,
  getFolderThreadIds,
  getMessageById,
  sendEmail,
  replyToEmail,
  replyAllToEmail,
  markMessageRead,
  markMessageImportant,
  deleteMessage
} from '../services/outlookService.js';

import { getToken, getUserTokens, refreshSpecificToken } from '../utils/tokenManager.js';
import { withTokenRefresh, isOutlookAuthError, OUTLOOK_AUTH_MESSAGE } from '../utils/outlookAuthRetry.js';
import { isOutlookUnavailableError, OUTLOOK_UNAVAILABLE_MESSAGE } from '../utils/transientRetry.js';

/** Message for the user when loading from Outlook failed, or the generic one. */
const outlookFailureMessage = (error, generic) =>
  isOutlookAuthError(error) ? OUTLOOK_AUTH_MESSAGE : isOutlookUnavailableError(error) ? OUTLOOK_UNAVAILABLE_MESSAGE : generic;
import User from '../models/User.js';
import Email from '../models/email.js';
import emailEnrichmentService from '../services/emailEnrichment.js';
import enrichmentQueueService from '../services/enrichmentQueueService.js';
import axios from 'axios';
import emailService from '../services/emailService.js';
import { saveOutlookMessages, getFolderThreads, syncConversationIds } from '../services/folderSync.js';
import { startAccountSync, getSyncStatus } from '../services/syncJobs.js';
import { ensureSubscriptionForAccount } from '../services/outlookSubscriptionService.js';
import { debug } from '../utils/logger.js';

// Inline images already fetched, so reopening a message shows its pictures at once (small, per process).
const INLINE_CACHE_MAX = 30;
const inlineImageCache = new Map(); // `${email}:${messageId}` -> images[]

/** Streams a message's inline images to the page as `mail:inlineImages` ({ messageId, images }), cached afterwards. */
async function streamInlineImages(socket, worxstreamUserId, email, messageId, attachments) {
  const inline = (attachments || []).filter((a) => a.isInline);
  if (inline.length === 0) return;
  const key = `${email}:${messageId}`;
  try {
    const cached = inlineImageCache.get(key);
    if (cached) return socket.emit('mail:inlineImages', { messageId, images: cached });
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return;
    const got = [];
    await fetchInlineImages(token, messageId, inline, {
      onImage: (img) => {
        got.push(img);
        socket.emit('mail:inlineImages', { messageId, images: [img] });
      },
    });
    if (got.length) {
      inlineImageCache.delete(key);
      inlineImageCache.set(key, got);
      if (inlineImageCache.size > INLINE_CACHE_MAX) inlineImageCache.delete(inlineImageCache.keys().next().value);
    }
  } catch (error) {
    console.warn('⚠️ Streaming inline images failed:', error?.response?.status || error.message);
  }
}

export const initMailSocket = (socket, io) => {

  const folderPaginationMap = new Map();
  
  // Folder list with one automatic token refresh when Microsoft rejects the stored token.
  const loadFolders = (userId, email, token) =>
    withTokenRefresh(getMailFolders, {
      accessToken: token,
      refresh: () => refreshSpecificToken(userId, email, 'outlook'),
      getFreshToken: () => getToken(userId, email, 'outlook'),
    });

  // Debounce mechanism to prevent rapid-fire requests
  const debounceMap = new Map();
  const DEBOUNCE_DELAY = 1000; // 1 second
  
  const debounce = (key, callback) => {
    if (debounceMap.has(key)) {
      clearTimeout(debounceMap.get(key));
    }
    debounceMap.set(key, setTimeout(() => {
      debounceMap.delete(key);
      callback();
    }, DEBOUNCE_DELAY));
  };

  // Every handler acts as the authenticated user: whatever worxstreamUserId the client sends in the payload is
  // replaced with the id verified at connection time, so one user cannot address another user's mailbox.
  const onAuthed = (event, handler) => {
    socket.on(event, (payload, ...rest) => {
      const userId = Number(socket.user?.id);
      if (!Number.isFinite(userId)) {
        socket.emit('mail:error', 'Not authenticated');
        return;
      }
      return handler({ ...(payload || {}), worxstreamUserId: userId }, ...rest);
    });
  };

  // Unified socket initialization - called when user logs into worXstream
  onAuthed('unified:init', async ({ worxstreamUserId, userInfo }) => {
    try {
      
      // Store worxstreamUserId on socket for unified access
      socket.worxstreamUserId = worxstreamUserId;
      
      // Store user info for future reference
      socket.userInfo = userInfo;
      
      // Register this socket with the email enrichment service
      emailEnrichmentService.registerSocket(socket);
      
      socket.emit('unified:connected', { status: 'connected', userId: worxstreamUserId });
    } catch (error) {
      console.error('❌ Error initializing unified socket:', error);
      socket.emit('unified:error', { message: 'Failed to initialize unified socket' });
    }
  });

  // Mail-specific initialization (for when user navigates to mail page)
  onAuthed('mail:init', async ({ worxstreamUserId, email }) => {
    // Only this account: keep its push-mail subscription alive while its owner is using mail.
    ensureSubscriptionForAccount(worxstreamUserId, email).catch(() => {});
    try {
      
      // Several sockets per user are fine (more than one tab or page); they are not disconnected here.

      // Store worxstreamUserId on socket for later use
      socket.worxstreamUserId = worxstreamUserId;
    
      // Use the authenticated user's ID instead of the passed worxstreamUserId
      const userId = worxstreamUserId;
    
      const token = await getToken(userId, email, 'outlook');
      if (!token) {
        // Check if user has any connected accounts
        const userTokens = await getUserTokens(userId);
        console.warn(`⚠️ No usable Outlook token for user ${userId} / ${email} (connected accounts: ${userTokens.map((t) => t.email).join(', ') || 'none'})`);
        if (userTokens.length === 0) {
          socket.emit('mail:error', 'No email accounts connected. Please connect your email account first.');
          return;
        } else {
          socket.emit('mail:error', `Email account ${email} not connected. Please connect this account or use a connected account.`);
          return;
        }
      }

      // Register this socket with the enrichment service for this user
      emailEnrichmentService.registerSocket(socket);

      const folders = await loadFolders(userId, email, token);
      socket.emit('mail:folders', folders);
      
    } catch (error) {
      console.error('❌ Error in mail:init:', error);
      socket.emit('mail:error', outlookFailureMessage(error, 'Failed to initialize mail service'));
    }
  });


  // New handler for enriching specific emails
  onAuthed('mail:enrichEmails', async ({ worxstreamUserId, email, messageIds, forceReanalyze = false }) => {
    try {
      debug('🔍 Enrichment request received:', { 
        worxstreamUserId, 
        email, 
        messageIds: messageIds.length, 
        forceReanalyze 
      });
      
      // Get the messages that need enrichment
      const messages = await Email.find({ id: { $in: messageIds } });
      
      
      if (messages.length === 0) {
        return;
      }

      let messagesNeedingEnrichment;
      
      if (forceReanalyze) {
        // Force re-enrichment: process all messages regardless of current AI metadata
        messagesNeedingEnrichment = messages;
        
        // Clear existing AI metadata for force re-enrichment
        await Email.updateMany(
          { id: { $in: messageIds } },
          { 
            $unset: { aiMeta: 1 },
            $set: { isProcessed: false, updatedAt: new Date() }
          }
        );
      } else {
        // Normal enrichment: only process messages without AI metadata
        messagesNeedingEnrichment = messages.filter(msg => !msg.aiMeta?.enrichedAt);
      }
      
      if (messagesNeedingEnrichment.length > 0) {
        // Pass the socket instance directly to the enrichment queue service
        // This ensures we use the same socket that made the request
        await enrichmentQueueService.addToQueue(messagesNeedingEnrichment, socket);
        
      } else {
      }
    } catch (error) {
      console.error('❌ Error in mail:enrichEmails:', error);
      socket.emit('mail:error', 'Failed to start enrichment process');
    }
  });

  // 📁 Get folders only (for when already initialized)
  onAuthed('mail:getFolders', async ({ worxstreamUserId, email }) => {
    // Only this account: keep its push-mail subscription alive while its owner is using mail.
    ensureSubscriptionForAccount(worxstreamUserId, email).catch(() => {});
    try {
      // Store worxstreamUserId on socket for later use
      socket.worxstreamUserId = worxstreamUserId;
    
      // Use the authenticated user's ID instead of the passed worxstreamUserId
      const userId = worxstreamUserId;
      
      // Check if the email has a valid token for this user
      const token = await getToken(userId, email, 'outlook');
      if (!token) {
        // Check if user has any connected accounts
        const userTokens = await getUserTokens(userId);
        console.warn(`⚠️ No usable Outlook token for user ${userId} / ${email} (connected accounts: ${userTokens.map((t) => t.email).join(', ') || 'none'})`);
        if (userTokens.length === 0) {
          socket.emit('mail:error', 'No email accounts connected. Please connect your email account first.');
          return;
        } else {
          socket.emit('mail:error', `Email account ${email} is not connected or has expired. Available accounts: ${userTokens.map(t => t.email).join(', ')}`);
          return;
        }
      }

      const folders = await loadFolders(userId, email, token);
      socket.emit('mail:folders', folders);
    } catch (error) {
      console.error('❌ Error in mail:getFolders:', error);
      socket.emit('mail:error', outlookFailureMessage(error, 'Failed to get folders'));
    }
  });

  // 🔄 Sync one folder with Outlook: pull its newest messages, then make the saved conversation ids (and the saved
  // list of messages) equal to what Outlook has, and tell the client what changed.
  const SYNC_PAGES = 3;
  const syncingFolders = new Set();
  onAuthed('mail:syncFolder', async ({ worxstreamUserId, email, folderId }) => {
    const lockKey = `${worxstreamUserId}:${email}:${folderId}`;
    if (!email || !folderId) return socket.emit('mail:error', 'email and folderId are required to sync a folder');
    if (syncingFolders.has(lockKey)) return; // already running; its result will arrive
    syncingFolders.add(lockKey);
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', `Email account ${email} is not connected or has expired.`);
      const user = await User.findOne({ worxstreamUserId });
      if (!user) return socket.emit('mail:error', 'User not found');

      const key = `${socket.id}-${folderId}`;
      folderPaginationMap.delete(key);
      let next = null;
      let fetched = 0;
      for (let page = 1; page <= SYNC_PAGES; page++) {
        const { messages: batch, nextLink } = await withTokenRefresh(
          (accessToken) => getMessagesByFolder(accessToken, folderId, next, 20, { throwOnError: true }),
          {
            accessToken: token,
            refresh: () => refreshSpecificToken(worxstreamUserId, email, 'outlook'),
            getFreshToken: () => getToken(worxstreamUserId, email, 'outlook'),
          },
        );
        if (page === 1 && nextLink) folderPaginationMap.set(key, nextLink); // "load more" continues after page 1
        await saveOutlookMessages(user, email, folderId, batch);
        fetched += batch.length;
        if (!nextLink) break;
        next = nextLink;
      }

      // Conversation ids and the folder's contents follow Outlook. A failure here does not undo the pull above.
      let threads = { updated: 0, removed: 0, missing: 0 };
      try {
        threads = await syncConversationIds({ token: (await getToken(worxstreamUserId, email, 'outlook')) || token, user, email, folderId });
      } catch (error) {
        console.error('⚠️ Conversation id sync failed:', error?.response?.status || error.message);
      }
      socket.emit('mail:folderSynced', {
        folderId,
        fetched,
        threadsUpdated: threads.updated,
        removed: threads.removed,
        missingThreadIds: threads.missing,
      });
    } catch (error) {
      console.error('❌ Error in mail:syncFolder:', error);
      socket.emit('mail:error', outlookFailureMessage(error, 'Failed to sync the folder'));
      socket.emit('mail:folderSynced', { folderId, fetched: 0, failed: true });
    } finally {
      syncingFolders.delete(lockKey);
    }
  });

  // 🔁 Sync the whole account with Outlook in the background (every folder; ids, flags, read state, moves, deletions).
  // The job runs on the server; the answer and every progress update arrive as `mail:syncAllStatus`.
  onAuthed('mail:syncAll', async ({ worxstreamUserId, email }) => {
    if (!email) return socket.emit('mail:error', 'email is required to sync an account');
    try {
      const { status } = await startAccountSync(worxstreamUserId, email);
      socket.emit('mail:syncAllStatus', status);
    } catch (error) {
      console.error('❌ Error in mail:syncAll:', error.message);
      socket.emit('mail:error', error.message || 'Failed to start the sync');
    }
  });

  // 🧹 Clean the stored copy of an account and rebuild it from Outlook for a date range (background job, same status
  // channel as sync-all). Destructive for the stored copy, so the client must send `confirm: true`.
  onAuthed('mail:cleanResync', async ({ worxstreamUserId, email, since, until, confirm }) => {
    if (!email) return socket.emit('mail:error', 'email is required');
    if (confirm !== true) return socket.emit('mail:error', 'Clean and resync needs to be confirmed.');
    try {
      const { status } = await startAccountSync(worxstreamUserId, email, { kind: 'cleanResync', range: { since, until } });
      socket.emit('mail:syncAllStatus', status);
    } catch (error) {
      console.error('❌ Error in mail:cleanResync:', error.message);
      socket.emit('mail:error', error.message || 'Failed to start the resync');
    }
  });

  // The latest sync-all status of an account (a page that opens while one is running picks it up from here).
  onAuthed('mail:getSyncAllStatus', async ({ worxstreamUserId, email }) => {
    if (!email) return;
    try {
      const status = await getSyncStatus(worxstreamUserId, email);
      if (status) socket.emit('mail:syncAllStatus', status);
    } catch (error) {
      console.error('❌ Error in mail:getSyncAllStatus:', error.message);
    }
  });

  // 📁 A page of a folder as conversations: one row per conversation (Outlook's conversationId), newest first.
  const FOLDER_PAGE_SIZE = 20;
  onAuthed('mail:getFolder', async ({ worxstreamUserId, email, folderId, page = 1, filters = {} }) => {
    const debounceKey = `getFolder:${worxstreamUserId}:${email}:${folderId}:${page}:${JSON.stringify(filters)}`;

    debounce(debounceKey, async () => {
      try {
        const userId = worxstreamUserId;
        const [token, user] = await Promise.all([getToken(userId, email, 'outlook'), User.findOne({ worxstreamUserId: userId })]);
        const key = `${socket.id}-${folderId}`;
        let messages = [];
        let hasMore = false;

        if (token && user) {
          // Page 1 starts from the newest page of Outlook again; a link kept from an earlier load would return page 2.
          if (page === 1) folderPaginationMap.delete(key);

          // One more page from Outlook into Mongo.
          const pull = async () => {
            const { messages: batch, nextLink } = await getMessagesByFolder(token, folderId, folderPaginationMap.get(key) || null);
            if (nextLink) folderPaginationMap.set(key, nextLink);
            else folderPaginationMap.delete(key);
            await saveOutlookMessages(user, email, folderId, batch);
          };

          // Page 1 always refreshes from Outlook (new mail). Later pages only go to Outlook when Mongo does not hold
          // enough conversations yet; pages are counted in conversations, so one Outlook page may add fewer than a page.
          if (page === 1) await pull();
          let result = await getFolderThreads({ user, email, folderId, page, pageSize: FOLDER_PAGE_SIZE, filters });
          for (let i = 0; i < 5 && result.messages.length < FOLDER_PAGE_SIZE && folderPaginationMap.has(key); i++) {
            await pull();
            result = await getFolderThreads({ user, email, folderId, page, pageSize: FOLDER_PAGE_SIZE, filters });
          }
          messages = result.messages;
          hasMore = result.hasMore || folderPaginationMap.has(key);
        }

        socket.emit('mail:folderMessages', {
          folderId,
          page,
          messages: messages.map((msg) => ({ ...msg, dbId: String(msg._id) })),
          nextLink: hasMore ? `page=${page + 1}` : null,
        });
      } catch (error) {
        console.error('❌ Error in mail:getFolder:', error);
        socket.emit('mail:error', 'Failed to process folder request');
      }
    });
  });

  // 📧 Full message
  onAuthed('mail:getMessage', async ({ worxstreamUserId, email, messageId }) => {
    try {
      // Use emailService to get message with AI metadata combined
      const emailService = await import('../services/emailService.js');
      
      const message = await emailService.default.getMessage(worxstreamUserId, email, messageId);

      if (message) {
        socket.emit('mail:message', message);
        // The pictures inside the body follow, a few at a time, so the text is never held back by them.
        streamInlineImages(socket, worxstreamUserId, email, messageId, message.attachments);
      } else {
        socket.emit('mail:error', 'Message not found');
      }
    } catch (error) {
      console.error('Failed to get message:', error);
      socket.emit('mail:error', error.message);
    }
  });

  // 🧵 The messages of a conversation (Outlook thread), newest first
  onAuthed('mail:getConversation', async ({ worxstreamUserId, email, conversationId }) => {
    if (!email || !conversationId) return socket.emit('mail:error', 'email and conversationId are required');
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', `Email account ${email} is not connected or has expired.`);
      const messages = await withTokenRefresh(
        (accessToken) => getConversationMessages(accessToken, conversationId),
        {
          accessToken: token,
          refresh: () => refreshSpecificToken(worxstreamUserId, email, 'outlook'),
          getFreshToken: () => getToken(worxstreamUserId, email, 'outlook'),
        },
      );
      socket.emit('mail:conversation', { conversationId, messages });
    } catch (error) {
      console.error('❌ Error in mail:getConversation:', error?.response?.data || error.message);
      socket.emit('mail:conversation', { conversationId, messages: [], failed: true });
    }
  });

  // 📥 The bytes of one attachment, requested when the user downloads it
  onAuthed('mail:getAttachment', async ({ worxstreamUserId, email, messageId, attachmentId }) => {
    if (!email || !messageId || !attachmentId) return socket.emit('mail:error', 'email, messageId and attachmentId are required');
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', 'Token not found');
      const attachment = await withTokenRefresh(
        (accessToken) => getAttachmentContent(accessToken, messageId, attachmentId),
        {
          accessToken: token,
          refresh: () => refreshSpecificToken(worxstreamUserId, email, 'outlook'),
          getFreshToken: () => getToken(worxstreamUserId, email, 'outlook'),
        },
      );
      socket.emit('mail:attachment', { messageId, attachmentId, ...attachment });
    } catch (error) {
      console.error('❌ Error in mail:getAttachment:', error?.response?.status || error.message);
      socket.emit('mail:attachment', { messageId, attachmentId, failed: true });
    }
  });

  // 📎 Get attachments separately
  onAuthed('mail:getAttachments', async ({ worxstreamUserId, email, messageId }) => {
    try {
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) return socket.emit('mail:error', 'Token not found');

      const { getAttachmentsByMessageId } = await import('../services/outlookService.js');
      const attachments = await getAttachmentsByMessageId(token, messageId);

      socket.emit('mail:attachments', { messageId, attachments });
    } catch (error) {
      console.error('Failed to get attachments:', error);
      socket.emit('mail:error', error.message);
    }
  });

  // 📤 Send email
  onAuthed('mail:send', async ({ worxstreamUserId, email, to, subject, body, cc, bcc, contentType }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return socket.emit('mail:error', 'Token not found');

    const result = await sendEmail(token, { to, subject, body, cc, bcc, contentType });
    socket.emit('mail:sent', result);
  });

  // 📧 Reply to email
  onAuthed('mail:reply', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      const result = await replyToEmail(token, { 
        messageId, 
        comment, 
        toRecipients, 
        ccRecipients, 
        bccRecipients 
      });

      if (result.success) {
        socket.emit('mail:replied', { messageId, success: true });
      } else {
        console.error(`❌ Failed to send reply for message ${messageId}:`, result.error);
        socket.emit('mail:error', `Failed to send reply: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error in mail:reply:', error);
      socket.emit('mail:error', 'Failed to send reply: ' + error.message);
    }
  });

  // 📧 Reply all to email
  onAuthed('mail:replyAll', async ({ worxstreamUserId, email, messageId, comment, toRecipients, ccRecipients, bccRecipients }) => {
    try {
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      const result = await replyAllToEmail(token, { 
        messageId, 
        comment, 
        toRecipients, 
        ccRecipients, 
        bccRecipients 
      });

      if (result.success) {
        socket.emit('mail:repliedAll', { messageId, success: true });
      } else {
        console.error(`❌ Failed to send reply all for message ${messageId}:`, result.error);
        socket.emit('mail:error', `Failed to send reply all: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error in mail:replyAll:', error);
      socket.emit('mail:error', 'Failed to send reply all: ' + error.message);
    }
  });

  // ✅ Mark as read
  onAuthed('mail:markRead', async ({ worxstreamUserId, email, messageId }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageRead(token, messageId);
      socket.emit('mail:markedRead', { messageId });
    } catch {
      socket.emit('mail:error', 'Failed to mark as read');
    }
  });

  // ⭐ Mark as important
  onAuthed('mail:markImportant', async ({ worxstreamUserId, email, messageId, flag }) => {
    const token = await getToken(worxstreamUserId, email, 'outlook');
    if (!token) return;

    try {
      await markMessageImportant(token, messageId, flag);
      socket.emit('mail:importantMarked', { messageId, flag });
    } catch {
      socket.emit('mail:error', 'Failed to update importance');
    }
  });

  // 🔄 Retry enrichment
  onAuthed('mail:retryEnrichment', async ({ worxstreamUserId, email, messageId }) => {
    try {
      const emailDoc = await Email.findOne({ id: messageId, email: email });
      if (!emailDoc) {
        console.error('❌ Email not found:', messageId);
        socket.emit('mail:error', 'Email not found');
        return;
      }

      // Reset enrichment status and force reprocessing
      await Email.findByIdAndUpdate(emailDoc._id, {
        'aiMeta.summary': 'Analyzing...',
        'aiMeta.error': null,
        'aiMeta.enrichedAt': null,
        isProcessed: false
      });

      // Get user to get worxstreamUserId
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error('❌ User not found:', worxstreamUserId);
        socket.emit('mail:error', 'User not found');
        return;
      }

      // Get fresh message content
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        socket.emit('mail:error', 'Token not found');
        return;
      }

      const message = await getMessageById(token, messageId);
      if (!message) {
        console.error('❌ Message not found:', messageId);
        socket.emit('mail:error', 'Message not found');
        return;
      }

      // Update email with fresh content
      const updatedEmail = await Email.findByIdAndUpdate(
        emailDoc._id,
        {
          $set: {
            ...message,
            userId: user._id,
            email: email,
            isProcessed: false
          }
        },
        { new: true }
      );

      // Start enrichment
      await emailEnrichmentService.enrichEmail(updatedEmail, true); // Pass true to force reprocessing
    } catch (error) {
      console.error('❌ Failed to retry enrichment:', error);
      socket.emit('mail:error', 'Failed to retry enrichment: ' + error.message);
    }
  });

  // 🗑️ Delete message
  onAuthed('mail:delete', async ({ worxstreamUserId, email, messageId }) => {
    try {
      
      const token = await getToken(worxstreamUserId, email, 'outlook');
      if (!token) {
        console.error('❌ Token not found for:', email);
        return socket.emit('mail:error', 'Token not found');
      }

      // Delete from Outlook
      const success = await deleteMessage(token, messageId);
      if (!success) {
        throw new Error('Failed to delete message from Outlook');
      }

      // Delete from our database and update counts
      await emailService.deleteMessage(worxstreamUserId, email, messageId);

      // Notify client of successful deletion
      socket.emit('mail:deleted', { messageId });
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('mail:error', 'Failed to delete message: ' + error.message);
    }
  });

  // 🏷️ Update email category
  onAuthed('mail:updateCategory', async ({ worxstreamUserId, email, messageId, category }) => {
    try {
      
      // Get user to verify they exist
      const user = await User.findOne({ worxstreamUserId });
      if (!user) {
        console.error('❌ User not found:', worxstreamUserId);
        return socket.emit('mail:error', 'User not found');
      }

      // Find the email document
      const emailDoc = await Email.findOne({ id: messageId, email: email });
      if (!emailDoc) {
        console.error('❌ Email not found:', messageId);
        return socket.emit('mail:error', 'Email not found');
      }

      // Update the category in the database
      const updatedEmail = await Email.findByIdAndUpdate(
        emailDoc._id,
        {
          $set: {
            'aiMeta.category': category,
            updatedAt: new Date()
          }
        },
        { new: true }
      );


      // Emit success event back to client
      socket.emit('mail:categoryUpdated', { 
        messageId, 
        category,
        aiMeta: updatedEmail.aiMeta 
      });

      // Emit analytics refresh event to update dashboard widgets
      socket.emit('mail:analyticsRefresh', {
        messageId,
        category,
        email: email,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error updating category:', error);
      socket.emit('mail:error', 'Failed to update category: ' + error.message);
    }
  });

  socket.on('disconnect', () => {
  });
};

// 🔁 Email fetch in date range
async function fetchEmailsInRange(token, startDate, endDate) {
  const startISO = new Date(startDate).toISOString();
  const endISO = new Date(endDate).toISOString();
  const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${startISO} and receivedDateTime le ${endISO}&$orderby=receivedDateTime desc&$top=50`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data.value.map(msg => ({
    id: msg.id,
    from: `${msg.from?.emailAddress?.name || ''} <${msg.from?.emailAddress?.address || ''}>`,
    subject: msg.subject || '(No Subject)',
    preview: msg.bodyPreview,
    content: msg.body?.content || '',
    timestamp: msg.receivedDateTime,
    read: msg.isRead,
    folder: 'Inbox',
    important: msg.importance === 'high',
    flagged: msg.flag?.flagStatus === 'flagged'
  }));
}

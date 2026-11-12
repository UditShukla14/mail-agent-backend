import Email from '../models/email.js';
import User from '../models/User.js';
import { getToken } from '../utils/tokenManager.js';
import { getMessageById } from './outlookService.js';
import enrichmentQueueService from './enrichmentQueueService.js';
import notificationService from './notificationService.js';
import {
  findAccountBySubscriptionId,
  verifyClientState,
  recreateSubscriptionForAccount
} from './outlookSubscriptionService.js';

function extractMessageId(notification) {
  if (notification.resourceData?.id) {
    return notification.resourceData.id;
  }

  const resource = notification.resource || '';
  const match = resource.match(/Messages\/([^/]+)$/i) || resource.match(/messages\/([^/]+)$/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function processCreatedMessage(account, messageId) {
  const worxstreamUserId = account.worxstreamUserId;
  if (!worxstreamUserId) {
    const user = await User.findById(account.userId);
    if (!user) {
      console.error(`❌ No user for EmailAccount ${account._id}`);
      return;
    }
    account.worxstreamUserId = user.worxstreamUserId;
    await account.save();
  }

  const accessToken = await getToken(account.worxstreamUserId, account.email, 'outlook');
  if (!accessToken) {
    console.error(`❌ No token to fetch webhook message for ${account.email}`);
    return;
  }

  const outlookMessage = await getMessageById(accessToken, messageId);
  if (!outlookMessage) {
    console.error(`❌ Could not fetch message ${messageId} for ${account.email}`);
    return;
  }

  const folderId = account.outlookInboxFolderId || 'inbox';
  const emailData = {
    id: outlookMessage.id,
    userId: account.userId,
    email: account.email,
    from: outlookMessage.from || '',
    to: outlookMessage.to || '',
    cc: outlookMessage.cc || '',
    bcc: outlookMessage.bcc || '',
    subject: outlookMessage.subject || '(No Subject)',
    content: outlookMessage.content || '',
    preview: (outlookMessage.content || '').replace(/<[^>]+>/g, '').slice(0, 200),
    timestamp: outlookMessage.timestamp ? new Date(outlookMessage.timestamp) : new Date(),
    read: outlookMessage.read || false,
    folder: folderId,
    important: outlookMessage.important || false,
    flagged: outlookMessage.flagged || false,
    isProcessed: false,
    updatedAt: new Date()
  };

  const saved = await Email.findOneAndUpdate(
    { id: emailData.id, email: account.email },
    { $set: emailData },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`📬 Saved inbound Outlook message ${saved.id} for ${account.email}`);

  try {
    await enrichmentQueueService.addToQueue([saved]);
  } catch (err) {
    console.error(`❌ Failed to enqueue enrichment for ${saved.id}:`, err.message);
  }

  notificationService.notifyNewMail(account.worxstreamUserId, account.email, saved);
}

async function processLifecycle(notification, account) {
  const event = notification.lifecycleEvent;
  console.log(`📡 Lifecycle event "${event}" for subscription ${notification.subscriptionId}`);

  if (event === 'reauthorizationRequired' || event === 'subscriptionRemoved') {
    try {
      await recreateSubscriptionForAccount(account);
    } catch (err) {
      console.error(
        `❌ Failed to recreate subscription after ${event} for ${account.email}:`,
        err?.response?.data || err.message
      );
    }
    return;
  }

  if (event === 'missed') {
    console.warn(`⚠️ Missed notifications for ${account.email} — client should sync inbox`);
  }
}

/**
 * Handle Graph change + lifecycle notifications asynchronously.
 */
export async function processOutlookNotifications(notifications) {
  for (const notification of notifications) {
    try {
      if (!verifyClientState(notification.clientState)) {
        console.warn('⚠️ Rejecting Outlook notification with invalid clientState');
        continue;
      }

      const account = await findAccountBySubscriptionId(notification.subscriptionId);
      if (!account) {
        console.warn(`⚠️ No EmailAccount for subscription ${notification.subscriptionId}`);
        continue;
      }

      if (notification.lifecycleEvent) {
        await processLifecycle(notification, account);
        continue;
      }

      if (notification.changeType === 'created') {
        const messageId = extractMessageId(notification);
        if (!messageId) {
          console.warn('⚠️ Outlook notification missing message id:', notification.resource);
          continue;
        }
        await processCreatedMessage(account, messageId);
      }
    } catch (err) {
      console.error('❌ Error processing Outlook notification:', err?.response?.data || err.message);
    }
  }
}

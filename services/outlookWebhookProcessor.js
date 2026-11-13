import User from '../models/User.js';
import { getToken } from '../utils/tokenManager.js';
import { getMessageById, getMessageMeta } from './outlookService.js';
import enrichmentQueueService from './enrichmentQueueService.js';
import notificationService from './notificationService.js';
import { applyMessageChange } from './messageChanges.js';
import { debug } from '../utils/logger.js';
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

async function processChange(account, changeType, messageId) {
  if (!account.worxstreamUserId) {
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
    console.error(`❌ No token to apply a ${changeType} notification for ${account.email}`);
    return;
  }

  await applyMessageChange({
    account,
    changeType,
    messageId,
    deps: {
      getMeta: (id) => getMessageMeta(accessToken, id),
      getFull: (id) => getMessageById(accessToken, id, { attachments: 'none' }),
      enqueueEnrichment: (docs) => enrichmentQueueService.addToQueue(docs),
      notifyNew: (doc) => notificationService.notifyNewMail(account.worxstreamUserId, account.email, doc),
      notify: (event, payload) => notificationService.notifyUser(account.worxstreamUserId, event, payload),
    },
  });
}

async function processLifecycle(notification, account) {
  const event = notification.lifecycleEvent;
  debug(`📡 Lifecycle event "${event}" for subscription ${notification.subscriptionId}`);

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
    console.warn(`⚠️ Missed notifications for ${account.email} — a Sync all will catch up`);
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

      if (['created', 'updated', 'deleted'].includes(notification.changeType)) {
        const messageId = extractMessageId(notification);
        if (!messageId) {
          console.warn('⚠️ Outlook notification missing message id:', notification.resource);
          continue;
        }
        await processChange(account, notification.changeType, messageId);
      }
    } catch (err) {
      console.error('❌ Error processing Outlook notification:', err?.response?.data || err.message);
    }
  }
}

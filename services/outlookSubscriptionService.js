import axios from 'axios';
import { timingSafeEqual } from 'crypto';
import EmailAccount from '../models/EmailAccount.js';
import User from '../models/User.js';
import Token from '../models/Token.js';
import { getToken } from '../utils/tokenManager.js';
import { debug } from '../utils/logger.js';

const GRAPH_SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
// Mail subscriptions max ~4230 minutes; keep a small buffer
const SUBSCRIPTION_LIFETIME_MS = 4200 * 60 * 1000;

function getClientState() {
  const state = process.env.OUTLOOK_WEBHOOK_CLIENT_STATE;
  if (!state) {
    throw new Error('OUTLOOK_WEBHOOK_CLIENT_STATE is not configured');
  }
  return state;
}

function getNotificationUrl() {
  const base = (process.env.PUBLIC_BASE_URL || 'https://mails.worxstream.ai').replace(/\/$/, '');
  return `${base}/webhooks/outlook/mail`;
}

function buildExpirationDateTime() {
  return new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
}

async function resolveInboxFolderId(accessToken) {
  const res = await axios.get('https://graph.microsoft.com/v1.0/me/mailFolders/inbox', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { $select: 'id,displayName' }
  });
  return res.data.id;
}

async function ensureEmailAccount(worxstreamUserId, email) {
  const numericUserId = Number(worxstreamUserId);
  const normalizedEmail = email.toLowerCase();

  // OAuth may connect before /account/accounts creates the User row
  let user = await User.findOne({ worxstreamUserId: numericUserId });
  if (!user) {
    try {
      user = await User.create({
        worxstreamUserId: numericUserId,
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0] || normalizedEmail,
        status: '1'
      });
    } catch (err) {
      user = await User.findOne({ worxstreamUserId: numericUserId });
      if (!user) {
        throw err;
      }
    }
  }

  let account = await EmailAccount.findOne({ userId: user._id, email: normalizedEmail });
  if (!account) {
    account = await EmailAccount.create({
      userId: user._id,
      email: normalizedEmail,
      provider: 'outlook',
      isActive: true,
      worxstreamUserId: numericUserId
    });
  } else if (account.worxstreamUserId !== numericUserId) {
    account.worxstreamUserId = numericUserId;
    await account.save();
  }

  return { user, account };
}

/**
 * Create (or replace) an Inbox message subscription for an Outlook account.
 */
export async function createMailSubscription(worxstreamUserId, email, accessToken = null) {
  const numericUserId = Number(worxstreamUserId);
  const normalizedEmail = email.toLowerCase();
  const token = accessToken || await getToken(numericUserId, normalizedEmail, 'outlook');

  if (!token) {
    throw new Error(`No valid Outlook token for ${normalizedEmail}`);
  }

  const { account } = await ensureEmailAccount(numericUserId, normalizedEmail);

  // Replace stale subscription if one exists
  if (account.graphSubscriptionId) {
    try {
      await deleteGraphSubscription(token, account.graphSubscriptionId);
    } catch (err) {
      console.warn(`⚠️ Could not delete old subscription ${account.graphSubscriptionId}:`, err.message);
    }
  }

  const inboxFolderId = await resolveInboxFolderId(token);
  const notificationUrl = getNotificationUrl();
  const expirationDateTime = buildExpirationDateTime();

  const payload = {
    changeType: 'created',
    notificationUrl,
    lifecycleNotificationUrl: notificationUrl,
    resource: "/me/mailFolders('inbox')/messages",
    expirationDateTime,
    clientState: getClientState()
  };

  debug(`📡 Creating Graph mail subscription for ${normalizedEmail} → ${notificationUrl}`);

  const res = await axios.post(GRAPH_SUBSCRIPTIONS_URL, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  account.graphSubscriptionId = res.data.id;
  account.graphSubscriptionExpiresAt = new Date(res.data.expirationDateTime);
  account.outlookInboxFolderId = inboxFolderId;
  account.worxstreamUserId = numericUserId;
  account.provider = 'outlook';
  account.isActive = true;
  await account.save();

  console.log(`✅ Graph subscription ${res.data.id} created for ${normalizedEmail}, expires ${res.data.expirationDateTime}`);
  return account;
}

export async function renewSubscription(worxstreamUserId, email, subscriptionId, accessToken = null) {
  const numericUserId = Number(worxstreamUserId);
  const normalizedEmail = email.toLowerCase();
  const token = accessToken || await getToken(numericUserId, normalizedEmail, 'outlook');

  if (!token) {
    throw new Error(`No valid Outlook token for ${normalizedEmail}`);
  }

  const expirationDateTime = buildExpirationDateTime();
  const res = await axios.patch(
    `${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`,
    { expirationDateTime },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  await EmailAccount.findOneAndUpdate(
    { graphSubscriptionId: subscriptionId },
    { graphSubscriptionExpiresAt: new Date(res.data.expirationDateTime) }
  );

  debug(`🔄 Renewed Graph subscription ${subscriptionId} until ${res.data.expirationDateTime}`);
  return res.data;
}

export async function deleteGraphSubscription(accessToken, subscriptionId) {
  if (!subscriptionId) return;
  try {
    await axios.delete(`${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    debug(`🗑️ Deleted Graph subscription ${subscriptionId}`);
  } catch (err) {
    // 404 means already gone
    if (err.response?.status !== 404) {
      throw err;
    }
  }
}

export async function deleteMailSubscriptionForAccount(worxstreamUserId, email) {
  const numericUserId = Number(worxstreamUserId);
  const normalizedEmail = email.toLowerCase();
  const user = await User.findOne({ worxstreamUserId: numericUserId });
  if (!user) return;

  const account = await EmailAccount.findOne({ userId: user._id, email: normalizedEmail, provider: 'outlook' });
  if (!account?.graphSubscriptionId) return;

  const token = await getToken(numericUserId, normalizedEmail, 'outlook');
  if (token) {
    try {
      await deleteGraphSubscription(token, account.graphSubscriptionId);
    } catch (err) {
      console.warn(`⚠️ Failed to delete Graph subscription on unlink for ${normalizedEmail}:`, err.message);
    }
  }

  account.graphSubscriptionId = null;
  account.graphSubscriptionExpiresAt = null;
  await account.save();
}

export async function findAccountBySubscriptionId(subscriptionId) {
  return EmailAccount.findOne({ graphSubscriptionId: subscriptionId });
}

/**
 * Create subscriptions for Outlook tokens that do not have one yet.
 */
export async function backfillMissingSubscriptions() {
  if (!process.env.OUTLOOK_WEBHOOK_CLIENT_STATE) {
    console.warn('⚠️ Skipping Outlook subscription backfill — OUTLOOK_WEBHOOK_CLIENT_STATE not set');
    return { created: 0, skipped: 0, failed: 0 };
  }

  const outlookTokens = await Token.find({ provider: 'outlook' });
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const tokenDoc of outlookTokens) {
    try {
      const user = await User.findOne({ worxstreamUserId: tokenDoc.worxstreamUserId });
      if (!user) {
        skipped += 1;
        continue;
      }

      const account = await EmailAccount.findOne({ userId: user._id, email: tokenDoc.email.toLowerCase() });
      const hasValidSub =
        account?.graphSubscriptionId &&
        account?.graphSubscriptionExpiresAt &&
        account.graphSubscriptionExpiresAt.getTime() > Date.now() + 60 * 60 * 1000;

      if (hasValidSub) {
        skipped += 1;
        continue;
      }

      await createMailSubscription(tokenDoc.worxstreamUserId, tokenDoc.email);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `❌ Backfill subscription failed for ${tokenDoc.email}:`,
        err?.response?.data || err.message
      );
    }
  }

  console.log(`📡 Outlook subscription backfill complete: created=${created} skipped=${skipped} failed=${failed}`);
  return { created, skipped, failed };
}

/**
 * Renew subscriptions expiring within the next 24 hours.
 */
export async function renewExpiringSubscriptions() {
  if (!process.env.OUTLOOK_WEBHOOK_CLIENT_STATE) {
    return;
  }

  const renewBefore = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const accounts = await EmailAccount.find({
    provider: 'outlook',
    graphSubscriptionId: { $ne: null },
    graphSubscriptionExpiresAt: { $lte: renewBefore }
  });


  for (const account of accounts) {
    try {
      const worxstreamUserId = account.worxstreamUserId;
      if (!worxstreamUserId) {
        const user = await User.findById(account.userId);
        if (!user) continue;
        account.worxstreamUserId = user.worxstreamUserId;
        await account.save();
      }

      await renewSubscription(account.worxstreamUserId, account.email, account.graphSubscriptionId);
    } catch (err) {
      console.error(
        `❌ Failed to renew subscription for ${account.email}:`,
        err?.response?.data || err.message
      );
      // Attempt recreate on hard failure
      try {
        await createMailSubscription(account.worxstreamUserId, account.email);
      } catch (recreateErr) {
        console.error(
          `❌ Failed to recreate subscription for ${account.email}:`,
          recreateErr?.response?.data || recreateErr.message
        );
      }
    }
  }
}

export async function recreateSubscriptionForAccount(account) {
  const worxstreamUserId = account.worxstreamUserId;
  if (!worxstreamUserId) {
    throw new Error('Account missing worxstreamUserId');
  }
  return createMailSubscription(worxstreamUserId, account.email);
}

export function verifyClientState(clientState) {
  try {
    const expected = Buffer.from(getClientState());
    const given = Buffer.from(String(clientState ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

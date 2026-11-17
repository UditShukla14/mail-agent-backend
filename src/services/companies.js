import mongoose from 'mongoose';
import User from '../models/User.js';
import { debug } from '../utils/logger.js';

/**
 * Remember which worXstream company a signed-in user belongs to (from /api/user-info). Raven is subscribed and billed per
 * company, and new mail is analysed in the background with no user token, so the company must already be stored.
 * A user in several companies keeps the company they already had while it is still one of theirs, otherwise the first.
 * Fire-and-forget: never slows or fails a request.
 */
export function rememberCompany(user) {
  const ids = Array.isArray(user?.companyIds) ? user.companyIds.map(String).filter(Boolean) : [];
  const userId = Number(user?.id);
  if (!ids.length || !Number.isFinite(userId) || mongoose.connection.readyState !== 1) return;
  User.updateOne({ worxstreamUserId: userId }, [
    { $set: { companyIds: ids, companyId: { $cond: [{ $in: ['$companyId', ids] }, '$companyId', ids[0]] } } },
  ]).catch((error) => debug(`Could not store company for user ${userId}: ${error.message}`));
}

/** The stored company of a mail user document (empty string when unknown). */
export const companyOf = (userDoc) => String(userDoc?.companyId || '').trim();

import mongoose from 'mongoose';
import User from '../models/User.js';
import { debug } from '../utils/logger.js';

/**
 * Remember which worXstream company a signed-in user belongs to (from /api/user-info). Raven is subscribed and billed per
 * company, and new mail is analysed in the background with no user token, so the company must already be stored.
 *
 * When the web app sends the company the person is working in (X-Company-Id / socket auth.companyId), that wins if it is
 * one of the user's own companies. Otherwise a user in several companies keeps the company they already had while it is
 * still one of theirs, otherwise the first. Fire-and-forget: never slows or fails a request.
 */
export function normalizePreferredCompanyId(preferred) {
  if (preferred == null) return '';
  const raw = Array.isArray(preferred) ? preferred[0] : preferred;
  return String(raw ?? '').trim();
}

/** Prefer the working company when it belongs to the user; otherwise empty (caller keeps/defaults). */
export function acceptedCompanyId(companyIds, preferred) {
  const ids = Array.isArray(companyIds) ? companyIds.map(String).filter(Boolean) : [];
  const want = normalizePreferredCompanyId(preferred);
  return want && ids.includes(want) ? want : '';
}

export function rememberCompany(user, preferred = '') {
  const ids = Array.isArray(user?.companyIds) ? user.companyIds.map(String).filter(Boolean) : [];
  const userId = Number(user?.id);
  if (!ids.length || !Number.isFinite(userId) || mongoose.connection.readyState !== 1) return;
  const want = acceptedCompanyId(ids, preferred);
  User.updateOne({ worxstreamUserId: userId }, [
    { $set: { companyIds: ids, companyId: want ? want : { $cond: [{ $in: ['$companyId', ids] }, '$companyId', ids[0]] } } },
  ]).catch((error) => debug(`Could not store company for user ${userId}: ${error.message}`));
}

/** The stored company of a mail user document (empty string when unknown). */
export const companyOf = (userDoc) => String(userDoc?.companyId || '').trim();

import crypto from 'crypto';
import { worxstreamApi } from '../services/worxstreamApi.js';

/**
 * Bearer-token verification against the worXstream API. This is the only source of the caller's identity:
 * client-supplied user info (X-User-Info header, socket query/payload) is never trusted.
 *
 * Successful verifications are cached briefly (keyed by a hash of the token) so a page that fires many
 * requests does not call worXstream for each one. Failures are not cached.
 */
const CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 60_000);
const CACHE_MAX = 2000;
const cache = new Map(); // tokenHash -> { user, expires }

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Dev-only identity used when worXstream is unreachable and NODE_ENV=development. */
export const DEV_USER = { id: 10000000021, email: 'dev@example.com', name: 'Development User' };

export const isDevFallbackAllowed = () => process.env.NODE_ENV === 'development';

/**
 * @param {string} token raw bearer token
 * @returns {Promise<{ user: object|null, reason?: 'invalid'|'unavailable' }>}
 */
export async function verifyBearerToken(token) {
  if (!token || typeof token !== 'string') return { user: null, reason: 'invalid' };

  const key = hash(token);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { user: hit.user };
  if (hit) cache.delete(key);

  const result = await worxstreamApi.verifyUserToken(token);
  if (result?.success && result.user && result.user.id != null) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { user: result.user, expires: Date.now() + CACHE_TTL_MS });
    return { user: result.user };
  }
  return { user: null, reason: classifyFailure(result?.status) };
}

/**
 * worXstream answered but did not accept the token (401/403, other 4xx, or a redirect to login) -> 'invalid'.
 * No answer, timeout, rate limit or a server error -> 'unavailable' (we could not tell).
 */
export function classifyFailure(status) {
  const code = Number(status);
  if (code >= 300 && code < 500 && code !== 408 && code !== 429) return 'invalid';
  return 'unavailable';
}

export const __clearAuthCacheForTests = () => cache.clear();

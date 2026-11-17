/**
 * Defaults for every Microsoft Graph call, installed once on axios.
 *
 * Immutable ids: by default a message's id CHANGES when it is moved to another folder, so ids we stored go stale and a
 * moved message looks like a deleted one plus a new one. With `Prefer: IdType="ImmutableId"` Graph returns ids that stay
 * the same for the life of the message. Graph also accepts older ids in requests, so turning this on does not break
 * messages stored earlier; clean-and-resync replaces the stored ids with immutable ones.
 * Set OUTLOOK_IMMUTABLE_IDS=false to switch it off.
 */

import axios from 'axios';

const IMMUTABLE = 'IdType="ImmutableId"';
let installed = false;

/** Adds one preference to an existing Prefer header value (several preferences share one header, comma separated). */
export function mergePrefer(existing, add) {
  const current = String(existing || '').trim();
  if (!current) return add;
  return current.toLowerCase().includes(add.toLowerCase()) ? current : `${current}, ${add}`;
}

export function installGraphDefaults({ immutableIds = process.env.OUTLOOK_IMMUTABLE_IDS !== 'false' } = {}) {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use((config) => {
    if (!immutableIds || !String(config.url || '').includes('graph.microsoft.com')) return config;
    const headers = config.headers;
    const existing = typeof headers?.get === 'function' ? headers.get('Prefer') : headers?.Prefer;
    const merged = mergePrefer(existing, IMMUTABLE);
    if (typeof headers?.set === 'function') headers.set('Prefer', merged);
    else config.headers = { ...(headers || {}), Prefer: merged };
    return config;
  });
}

export const OUTLOOK_UNAVAILABLE_ERROR = 'OUTLOOK_UNAVAILABLE';
export const OUTLOOK_UNAVAILABLE_MESSAGE = 'Outlook is not responding right now. Try again in a minute.';

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);

/** Microsoft answered with a temporary failure (overload, bad gateway, timeout) rather than rejecting the request. */
export const isTransientError = (err) =>
  TRANSIENT_STATUS.has(err?.response?.status) || TRANSIENT_CODES.has(err?.code);

export const isOutlookUnavailableError = (err) => err?.code === OUTLOOK_UNAVAILABLE_ERROR;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds from a Retry-After header, capped so a request never hangs for long. */
const retryAfterMs = (err, capMs) => {
  const seconds = Number(err?.response?.headers?.['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, capMs) : null;
};

/**
 * Runs `fn`, retrying temporary failures with a short backoff. Other errors are thrown at once. When the retries
 * run out, the last error is thrown tagged OUTLOOK_UNAVAILABLE.
 *
 * @param {() => Promise<any>} fn
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void>, capMs?: number }} [options]
 */
export async function retryTransient(fn, { delays = [400, 1200], sleep = defaultSleep, capMs = 5000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err)) throw err;
      lastError = err;
      if (attempt < delays.length) await sleep(retryAfterMs(err, capMs) ?? delays[attempt]);
    }
  }
  lastError.code = OUTLOOK_UNAVAILABLE_ERROR;
  throw lastError;
}

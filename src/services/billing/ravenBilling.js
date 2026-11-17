import { hubConfig, hubEnabled, billingExplicitlyOff } from '../../config/hub.js';
import { debug } from '../../utils/logger.js';

const ALLOWED_TTL_MS = 60_000;
const DENIED_TTL_MS = 30_000;
const ERROR_TTL_MS = 10_000;
const REPORT_ATTEMPTS = 3;
const PENDING_MAX = 1000;
const PENDING_RETRY_MS = 5 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raven's link to the AI apps hub (agent backend):
 *  - checkAccess(companyId): is Raven active for this company and does it have credit? (cached briefly)
 *  - reportUsage(call): tell the hub what a model call used, so it is priced and debited from the company's Raven wallet.
 *
 * Usage reports are retried, then kept in a small in-memory list and retried every few minutes, so a short hub outage
 * does not lose billable usage. The hub ignores a repeated message id, so retrying is always safe.
 */
export function createRavenBilling({ fetchImpl = (...a) => fetch(...a), sleepImpl = sleep, now = () => Date.now(), config = hubConfig, enabled = hubEnabled, explicitlyOff = billingExplicitlyOff } = {}) {
  const cache = new Map(); // companyId -> { result, expires }
  const pending = [];
  let timer = null;

  const call = async (path, init) => {
    const { baseUrl, serviceKey } = config();
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error || `Hub answered ${res.status}`), { status: res.status });
    return body.data;
  };

  /** @returns {Promise<{ allowed: boolean, reason: string, message: string, remaining_usd: number|null }>} */
  async function checkAccess(companyId) {
    if (!enabled()) {
      // Billing off on purpose (local development): everyone may use Raven. Otherwise a missing hub setting must not become free use.
      if (explicitlyOff()) return { allowed: true, reason: 'billing_off', message: '', remaining_usd: null };
      return { allowed: false, reason: 'billing_not_configured', message: 'Raven is not active yet. Add credits to start using Raven, or ask your administrator to activate it.', remaining_usd: null };
    }
    const id = String(companyId || '').trim();
    if (!id) return { allowed: false, reason: 'no_company', message: 'Raven could not tell which company this mailbox belongs to. Open Mail once while signed in, then try again.', remaining_usd: null };
    const hit = cache.get(id);
    if (hit && hit.expires > now()) return hit.result;
    let result;
    let ttl;
    try {
      result = await call(`/api/internal/apps/raven/access?company_id=${encodeURIComponent(id)}`, { method: 'GET' });
      ttl = result.allowed ? ALLOWED_TTL_MS : DENIED_TTL_MS;
    } catch (error) {
      console.error(`❌ Raven access check failed: ${error.message}`);
      result = { allowed: false, reason: 'billing_unavailable', message: 'Raven billing is temporarily unavailable. Try again in a moment.', remaining_usd: null };
      ttl = ERROR_TTL_MS;
    }
    cache.set(id, { result, expires: now() + ttl });
    return result;
  }

  /** Drop what we know about a company (e.g. after its credit is added). */
  const forget = (companyId) => cache.delete(String(companyId || '').trim());

  async function send(report) {
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
      try {
        const out = await call('/api/internal/apps/raven/usage', { method: 'POST', body: JSON.stringify(report) });
        debug(`💳 Raven usage reported (${report.message_id}) recorded=${out?.recorded}`);
        return true;
      } catch (error) {
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
          console.error(`❌ Raven usage report rejected (${error.status}): ${error.message}`);
          return true; // a request the hub will never accept: retrying cannot help
        }
        if (attempt < REPORT_ATTEMPTS) await sleepImpl(500 * 2 ** (attempt - 1));
      }
    }
    return false;
  }

  function schedulePending() {
    if (timer || pending.length === 0) return;
    timer = setTimeout(async () => {
      timer = null;
      const batch = pending.splice(0, pending.length);
      for (const report of batch) if (!(await send(report))) pending.push(report);
      schedulePending();
    }, PENDING_RETRY_MS);
    timer.unref?.();
  }

  /**
   * Report one model call. Never throws and never blocks the analysis.
   * @param {{ companyId: string, userId: string|number, model: string, messageId: string, usage: object, responseModel?: string, requestId?: string }} call
   */
  async function reportUsage({ companyId, userId, model, messageId, usage, responseModel = '', requestId = '' }) {
    if (!enabled() || !companyId || !messageId || !usage) return false;
    const report = {
      company_id: String(companyId),
      user_id: String(userId),
      model,
      response_model: responseModel,
      message_id: messageId,
      request_id: requestId,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      },
    };
    const ok = await send(report).catch(() => false);
    if (!ok) {
      if (pending.length < PENDING_MAX) pending.push(report);
      else console.error('❌ Raven usage report dropped: the retry list is full');
      schedulePending();
    }
    return ok;
  }

  return { checkAccess, reportUsage, forget, pendingCount: () => pending.length };
}

export const ravenBilling = createRavenBilling();

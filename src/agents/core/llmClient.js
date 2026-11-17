import { MODEL_FAMILY } from '../../config/anthropic.js';
import { debug } from '../../utils/logger.js';
import { AgentError } from './errors.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const RETIRED_FOR_MS = 6 * 60 * 60 * 1000; // a model that answered 404 is skipped for 6 hours
const MAX_RETRY_WAIT_MS = 10_000;

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Anthropic Messages client with a model FAMILY:
 *  - 404 (model retired / unknown)        -> skip that model for a while and use the next one immediately
 *  - 429 / 5xx / 529 / timeouts / network -> retry the same model briefly, then use the next one
 *  - 401 / 403 / other 4xx                -> configuration or request problem: fail at once (another model will not help)
 * Concurrency is capped so a burst of new mail cannot flood the API.
 */
export function createLlmClient({
  models = MODEL_FAMILY,
  apiKey = () => process.env.ANTHROPIC_API_KEY,
  fetchImpl = (...args) => fetch(...args),
  sleep = defaultSleep,
  now = () => Date.now(),
  attemptsPerModel = 2,
  maxConcurrent = 3,
  timeoutMs = 60_000,
} = {}) {
  const retiredUntil = new Map();
  let active = 0;
  const waiting = [];

  const acquire = () =>
    new Promise((resolve) => {
      if (active < maxConcurrent) {
        active += 1;
        resolve();
      } else waiting.push(resolve);
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const usable = (skip) => {
    const ready = models.filter((m) => !skip.includes(m) && (retiredUntil.get(m) ?? 0) <= now());
    // Everything is marked retired: try them all anyway rather than fail without asking.
    return ready.length ? ready : models.filter((m) => !skip.includes(m));
  };

  async function requestOnce(model, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ ...body, model }),
        signal: controller.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON error body */
      }
      return { status: res.status, ok: res.ok, json, retryAfter: Number(res.headers?.get?.('retry-after')) || 0 };
    } catch (error) {
      return { status: 0, ok: false, json: null, networkError: error, retryAfter: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {object} request Messages API body without `model` (system, messages, tools, tool_choice, max_tokens, ...)
   * @param {{ skipModels?: string[] }} [options] models not to use (e.g. the one that just produced unusable output)
   * @returns {Promise<{ message: object, model: string, usage: object, fellBack: boolean }>}
   */
  async function call(request, { skipModels = [] } = {}) {
    if (!apiKey()) throw new AgentError('ANTHROPIC_API_KEY is not set', 'LLM_REJECTED');
    const candidates = usable(skipModels);
    if (candidates.length === 0) throw new AgentError('No model available to try', 'LLM_UNAVAILABLE');

    await acquire();
    try {
      let lastProblem = 'unknown error';
      for (const [index, model] of candidates.entries()) {
        for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
          const res = await requestOnce(model, request);
          if (res.ok && res.json) {
            if (index > 0) console.warn(`⚠️ Mail analysis used fallback model ${model} (earlier models failed: ${lastProblem})`);
            return { message: res.json, model, usage: res.json.usage || {}, fellBack: index > 0 };
          }

          const detail = res.json?.error?.message || res.networkError?.message || `HTTP ${res.status}`;
          lastProblem = `${model}: ${res.status || 'network'} ${detail}`;

          if (res.status === 404 || (res.status === 400 && /model/i.test(detail))) {
            retiredUntil.set(model, now() + RETIRED_FOR_MS);
            console.warn(`⚠️ Model ${model} is not available (${detail}); using the next model in the family`);
            break; // next model
          }
          if (res.status === 401 || res.status === 403 || (res.status >= 400 && res.status < 500 && !TRANSIENT.has(res.status))) {
            throw new AgentError(`Anthropic rejected the request (${res.status}): ${detail}`, 'LLM_REJECTED');
          }
          // Transient: wait a little and retry this model, then move on.
          if (attempt < attemptsPerModel) {
            const wait = Math.min(res.retryAfter ? res.retryAfter * 1000 : 1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
            debug(`⏳ ${lastProblem}; retrying in ${wait}ms`);
            await sleep(wait);
          }
        }
      }
      throw new AgentError(`All models failed (${lastProblem})`, 'LLM_UNAVAILABLE');
    } finally {
      release();
    }
  }

  return { call, models };
}

/** Shared client used by the agents. */
export const llm = createLlmClient();

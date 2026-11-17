/**
 * Agents of the mail service. Each agent is a folder with:
 *   definition.js  name, purpose, limits, working rules and guardrail statements
 *   guardrails.js  the checks enforced in code (input before the model sees it, output before it is stored)
 *   index.js       prompt/tool construction and the entry point
 * Shared plumbing (model family fallback, the run loop, errors) lives in core/.
 */
export { analyzeEmail, ravenAgent } from './raven/index.js';
export { AgentError } from './core/errors.js';

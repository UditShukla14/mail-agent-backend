/** Failure of an agent run. `code` tells callers what to do about it. */
export class AgentError extends Error {
  /**
   * @param {string} message
   * @param {'NO_CONTEXT'|'BLOCKED_INPUT'|'INVALID_OUTPUT'|'LLM_UNAVAILABLE'|'LLM_REJECTED'|'NOT_ENTITLED'} code
   */
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

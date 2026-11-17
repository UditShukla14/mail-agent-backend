import { llm } from './llmClient.js';
import { AgentError } from './errors.js';
import { debug } from '../../utils/logger.js';

/**
 * Run one agent turn.
 *
 *   input guardrails  -> request (cached system + untrusted data) -> model call (forced tool = structured output)
 *   -> output guardrails -> result
 *
 * An agent is a plain object (see agents/raven/definition.js):
 *   { key, name, limits, guardrails: { input(raw), output(raw, ctx) }, buildRequest(input) -> { request, toolName, ctx } }
 *
 * If a model answers but the answer fails the output guardrails, the same request is retried ONCE on a different
 * model of the family before giving up, so one confused answer does not become an error for the user.
 *
 * `onCall({ model, responseModel, messageId, usage })` is invoked for every model call (used for billing).
 *
 * @returns {Promise<{ result: object, meta: { agent: string, model: string, fellBack: boolean, usage: object, repaired: boolean } }>}
 */
export async function runAgent(agent, rawInput, { client = llm, onCall = null } = {}) {
  const input = agent.guardrails.input(rawInput); // throws AgentError(BLOCKED_INPUT / NO_CONTEXT)
  const { request, toolName, ctx } = agent.buildRequest(input);
  const body = { ...request, tool_choice: { type: 'tool', name: toolName } };

  let skipModels = [];
  let lastError = null;
  for (let pass = 0; pass <= (agent.limits.maxOutputRepairs ?? 1); pass++) {
    const { message, model, usage, fellBack } = await client.call(body, { skipModels });
    // Every model call costs money, including one whose answer is then rejected: report it before validating.
    try {
      onCall?.({ model, responseModel: message.model || '', messageId: message.id || '', usage });
    } catch (error) {
      debug(`🤖 onCall hook failed: ${error.message}`);
    }
    const toolUse = (message.content || []).find((block) => block.type === 'tool_use' && block.name === toolName);
    try {
      if (!toolUse) throw new AgentError('The model did not return the structured result', 'INVALID_OUTPUT');
      const result = agent.guardrails.output(toolUse.input, ctx);
      debug(
        `🤖 ${agent.name} ${model} in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} ` +
          `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`,
      );
      return { result, meta: { agent: agent.key, model, fellBack, usage, repaired: pass > 0 } };
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'INVALID_OUTPUT') throw error;
      lastError = error;
      skipModels = [...skipModels, model];
      debug(`🤖 ${agent.name}: ${model} gave unusable output (${error.message}); trying another model`);
    }
  }
  throw lastError;
}

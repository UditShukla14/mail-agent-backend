import { raven } from './definition.js';
import { guardInput, guardOutput, PRIORITIES, SENTIMENTS } from './guardrails.js';
import { runAgent } from '../core/runAgent.js';

const TOOL_NAME = 'record_analysis';
const EPHEMERAL = { type: 'ephemeral' };

/** Static part of the system prompt: identical for every email, so it is cached. */
export function rulesPrompt() {
  return [
    `You are ${raven.name}, an assistant that ${raven.description}`,
    `Reply only by calling ${TOOL_NAME}.`,
    'RULES\n' + raven.rules.map((r) => `- ${r}`).join('\n'),
    'SAFETY\n' + raven.guardrails.prompt.map((r) => `- ${r}`).join('\n'),
  ].join('\n\n');
}

/** Per-account part: the account's own categories. Cached too, so it is paid once per account, not per email. */
export function categoriesPrompt(categories) {
  const list = categories.map((c) => `- ${c.name} (${c.label}): ${c.description}`).join('\n');
  return `<categories>\n${list}\n</categories>`;
}

export function analysisTool(categories) {
  const { limits } = raven;
  return {
    name: TOOL_NAME,
    description: 'Record the analysis of the email.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: `2-3 sentences, at most ${limits.summaryMaxChars} characters` },
        category: { type: 'string', enum: categories.map((c) => c.name), description: 'Internal category name' },
        priority: { type: 'string', enum: PRIORITIES },
        sentiment: { type: 'string', enum: SENTIMENTS },
        actionItems: { type: 'array', items: { type: 'string' }, maxItems: limits.maxActionItems },
      },
      required: ['summary', 'category', 'priority', 'sentiment', 'actionItems'],
    },
  };
}

export function emailMessage({ subject, from, to, body }) {
  return `<email>\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\n\n${body}\n</email>`;
}

const agent = {
  ...raven,
  guardrails: { ...raven.guardrails, input: guardInput, output: guardOutput },
  buildRequest(input) {
    return {
      toolName: TOOL_NAME,
      ctx: { categories: input.categories },
      request: {
        max_tokens: raven.limits.maxTokens,
        system: [
          { type: 'text', text: rulesPrompt() },
          { type: 'text', text: categoriesPrompt(input.categories), cache_control: EPHEMERAL },
        ],
        tools: [analysisTool(input.categories)],
        messages: [{ role: 'user', content: emailMessage(input) }],
      },
    };
  },
};

export { agent as ravenAgent };

/**
 * Analyse one stored email against its account's categories.
 * @returns {Promise<{ result: { summary, category, priority, sentiment, actionItems }, meta: object }>}
 */
export const analyzeEmail = (email, categories, options) => runAgent(agent, { email, categories }, options);

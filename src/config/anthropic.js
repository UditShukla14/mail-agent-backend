// Anthropic configuration.
//
// Models are a FAMILY, tried in order: if one is retired (404), overloaded or erroring, the next one is used, so a
// single expiring model never stops mail analysis. Cheapest first.
//
//   ANTHROPIC_MODELS=claude-haiku-4-5,claude-haiku-5-5,claude-sonnet-5-5   (comma separated, optional)
//   ANTHROPIC_MODEL=claude-haiku-4-5                                        (legacy single model: tried first)
export const DEFAULT_MODEL_FAMILY = ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'];

const unique = (list) => [...new Set(list)];

export function parseModelFamily(env = process.env) {
  const listed = (env.ANTHROPIC_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  if (listed.length) return unique(listed);
  const single = (env.ANTHROPIC_MODEL || '').trim();
  return single ? unique([single, ...DEFAULT_MODEL_FAMILY]) : [...DEFAULT_MODEL_FAMILY];
}

export const MODEL_FAMILY = parseModelFamily();
/** The preferred (first) model, for logs. */
export const ANTHROPIC_MODEL = MODEL_FAMILY[0];

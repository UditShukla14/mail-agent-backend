import { htmlToPlainText } from '../../utils/plainText.js';
import { AgentError } from '../core/errors.js';
import { raven } from './definition.js';

const { limits } = raven;
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const SENTIMENTS = ['positive', 'negative', 'neutral'];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (value, max) => String(value ?? '').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Tags we use to fence the email in the prompt: an email must not be able to close or fake them. */
const FENCE_TAGS = /<\/?\s*(email|categories|instructions|system|rules)[^>]*>/gi;

/** Cut quoted reply history ("On ... wrote:", Original Message, "> " lines): it is old text that costs tokens. */
export function stripQuotedHistory(text) {
  const lines = text.split('\n').filter((line) => !/^\s*>/.test(line));
  const joined = lines.join('\n');
  const marker = /^(On .{5,200}wrote:|-{2,}\s*Original Message\s*-{2,}|_{10,}|From:\s.+\n\s*Sent:\s)/im.exec(joined);
  // Only cut when something real comes before it, so a forwarded mail that starts with "From:" is not emptied.
  return marker && marker.index > 200 ? joined.slice(0, marker.index).trim() : joined.trim();
}

/** Input guardrail: bound the size, drop markup and history, and make the content unable to break out of its fence. */
export function guardInput(raw) {
  const email = raw?.email;
  const categories = raw?.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new AgentError('No categories defined yet. Please create categories first before processing emails.', 'NO_CONTEXT');
  }
  if (!email || (!email.content && !email.preview && !email.subject)) {
    throw new AgentError('The email has no content to analyse', 'BLOCKED_INPUT');
  }

  const { text } = htmlToPlainText(email.content || email.preview || '', limits.maxBodyChars * 3);
  const body = stripQuotedHistory(text).replace(FENCE_TAGS, '').slice(0, limits.maxBodyChars);

  return {
    subject: clean(email.subject, limits.maxSubjectChars).replace(FENCE_TAGS, '') || '(No Subject)',
    from: clean(email.from, limits.maxAddressChars).replace(FENCE_TAGS, ''),
    to: clean(email.to, limits.maxAddressChars).replace(FENCE_TAGS, ''),
    body,
    categories: categories.map((c) => ({
      name: String(c.name),
      label: String(c.label ?? c.name),
      description: clean(c.description, 300),
    })),
  };
}

const luhn = (digits) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** Output guardrail: secrets the model copied into free text are removed before anything is stored or shown. */
export function redactSecrets(text) {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[number removed]' : m;
    })
    .replace(/\b(password|passcode|passwd|pin|otp|one[- ]time (?:code|password)|verification code|security code)\b(\s*(?:is|:|=)\s*)(\S+)/gi, '$1$2[removed]')
    .replace(/\b(sk|pk|api|key|token)[-_][A-Za-z0-9_-]{16,}\b/gi, '[key removed]');
}

/**
 * Output guardrail: the answer must be exactly the shape the app stores. A near miss is repaired (case, label for
 * name); anything else is rejected so the runner can try another model instead of saving bad data.
 */
export function guardOutput(raw, { categories }) {
  const reject = (why) => new AgentError(`Unusable analysis: ${why}`, 'INVALID_OUTPUT');
  if (!raw || typeof raw !== 'object') throw reject('not an object');

  const summary = redactSecrets(clean(raw.summary, limits.summaryMaxChars * 2)).slice(0, limits.summaryMaxChars);
  if (summary.length < 5) throw reject('empty summary');

  const wanted = String(raw.category ?? '').trim();
  const category =
    categories.find((c) => c.name === wanted) ??
    categories.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) ??
    categories.find((c) => c.label.toLowerCase() === wanted.toLowerCase());
  if (!category) throw reject(`category "${wanted}" is not one of: ${categories.map((c) => c.name).join(', ')}`);

  const priority = String(raw.priority ?? '').toLowerCase().trim();
  if (!PRIORITIES.includes(priority)) throw reject(`priority "${raw.priority}"`);
  const sentiment = String(raw.sentiment ?? '').toLowerCase().trim();
  if (!SENTIMENTS.includes(sentiment)) throw reject(`sentiment "${raw.sentiment}"`);

  const items = Array.isArray(raw.actionItems) ? raw.actionItems : [];
  const actionItems = [...new Set(items.map((i) => redactSecrets(clean(i, limits.actionItemMaxChars))).filter((i) => i.length > 2))].slice(
    0,
    limits.maxActionItems,
  );

  return { summary, category: category.name, priority, sentiment, actionItems };
}

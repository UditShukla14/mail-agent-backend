// A message preview without newsletter boilerplate ("View in Browser" and its usual variants). The same narrow rule the
// web page uses for the list, so what the agent and the AI read matches what the user sees.
const VIEW_IN_BROWSER_TEXT =
  /(?:\b(?:click|tap)\s+here\s+to\s+)?\b(?:view|read|open|see)\s+(?:this\s+|the\s+|your\s+)?(?:email|e-mail|message|newsletter|mail)?\s*(?:in|on)\s+(?:your\s+|a\s+|the\s+)?(?:web\s+)?browser\b[:.!]?|\bview\s+(?:it\s+)?online\b[:.!]?/gi;

/** Drops "View in Browser" from a preview; keeps the original if nothing else would be left. */
export function cleanPreview(preview) {
  const text = String(preview || '');
  if (!text) return text;
  const cleaned = text.replace(VIEW_IN_BROWSER_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || text;
}

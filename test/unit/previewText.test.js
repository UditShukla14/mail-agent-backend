import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPreview } from '../utils/previewText.js';

describe('cleanPreview', () => {
  it('drops "View in Browser" in its usual wordings', () => {
    assert.equal(cleanPreview('13 November 2026 View in Browser Hello, Two stories this week'), '13 November 2026 Hello, Two stories this week');
    assert.equal(cleanPreview('Click here to view in your web browser. Welcome back'), 'Welcome back');
    assert.equal(cleanPreview('View online | Weekly digest'), '| Weekly digest');
  });
  it('keeps a preview that would otherwise be empty, and leaves normal text alone', () => {
    assert.equal(cleanPreview('View in Browser'), 'View in Browser');
    assert.equal(cleanPreview('Please review the browser compatibility report'), 'Please review the browser compatibility report');
    assert.equal(cleanPreview(''), '');
    assert.equal(cleanPreview(undefined), '');
  });
});

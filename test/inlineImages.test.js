import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedInlineImages } from '../utils/inlineImages.js';

test('cid references become inline image data', () => {
  const html = '<p>Hi</p><img src="cid:logo@1"><img src="cid:logo@1">';
  const out = embedInlineImages(html, [{ contentId: 'logo@1', contentType: 'image/png', contentBytes: 'AAAA' }]);
  assert.equal(out.match(/data:image\/png;base64,AAAA/g).length, 2);
  assert.doesNotMatch(out, /cid:/);
});

test('an image whose data is missing is replaced by a note instead of a broken image', () => {
  const out = embedInlineImages('<img src="cid:gone">', []);
  assert.match(out, /Inline image not available/);
  assert.doesNotMatch(out, /<img/);
});

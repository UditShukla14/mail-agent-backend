import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchInlineImages } from '../services/outlookService.js';

const att = (id, over = {}) => ({ id, isInline: true, size: 1000, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('fetchInlineImages', () => {
  it('fetches only a few at a time, hands each image over as it arrives, and skips what it should', async () => {
    let active = 0;
    let peak = 0;
    const requested = [];
    const http = {
      get: async (url) => {
        const id = decodeURIComponent(url.split('/').pop());
        requested.push(id);
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
        if (id === 'bad') throw new Error('boom');
        return { data: { contentId: `${id}@cid`, contentType: 'image/png', contentBytes: 'AAAA' } };
      },
    };
    const got = [];
    const attachments = [att('a'), att('b'), att('bad'), att('c'), att('big', { size: 5_000_000 }), att('file', { isInline: false }), att('d'), att('e')];
    const n = await fetchInlineImages('t', 'm1', attachments, { http, concurrency: 3, onImage: (i) => got.push(i.contentId) });
    assert.ok(peak <= 3, `at most 3 at once, saw ${peak}`);
    assert.deepEqual(got.sort(), ['a@cid', 'b@cid', 'c@cid', 'd@cid', 'e@cid']);
    assert.equal(n, 5); // the failed one is skipped without stopping the rest
    assert.ok(!requested.includes('big') && !requested.includes('file')); // too large / not inline: never requested
  });

  it('stops at the cap', async () => {
    const http = { get: async () => ({ data: { contentId: 'x', contentType: 'image/png', contentBytes: 'AA' } }) };
    const n = await fetchInlineImages('t', 'm', Array.from({ length: 40 }, (_, i) => att(`i${i}`)), { http, max: 10 });
    assert.equal(n, 10);
  });
});

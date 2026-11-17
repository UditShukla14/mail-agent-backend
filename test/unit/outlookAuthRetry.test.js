import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTokenRefresh, isOutlookAuthError, OUTLOOK_AUTH_ERROR } from '../utils/outlookAuthRetry.js';

const unauthorized = () => Object.assign(new Error('401'), { response: { status: 401 } });

describe('withTokenRefresh', () => {
  it('returns the result when the token works', async () => {
    const out = await withTokenRefresh(async (t) => `ok:${t}`, { accessToken: 'a', refresh: async () => assert.fail(), getFreshToken: async () => 'b' });
    assert.equal(out, 'ok:a');
  });

  it('refreshes once and retries when Microsoft rejects the token', async () => {
    const used = [];
    const out = await withTokenRefresh(
      async (t) => { used.push(t); if (t === 'old') throw unauthorized(); return 'folders'; },
      { accessToken: 'old', refresh: async () => true, getFreshToken: async () => 'new' },
    );
    assert.equal(out, 'folders');
    assert.deepEqual(used, ['old', 'new']);
  });

  it('reports an expired connection when the refresh fails', async () => {
    await assert.rejects(
      withTokenRefresh(async () => { throw unauthorized(); }, { accessToken: 'old', refresh: async () => false, getFreshToken: async () => null }),
      (e) => e.code === OUTLOOK_AUTH_ERROR && /expired/.test(e.message),
    );
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await assert.rejects(
      withTokenRefresh(async () => { calls += 1; throw new Error('boom'); }, { accessToken: 'a', refresh: async () => assert.fail(), getFreshToken: async () => 'b' }),
      /boom/,
    );
    assert.equal(calls, 1);
    assert.equal(isOutlookAuthError(new Error('x')), false);
  });
});

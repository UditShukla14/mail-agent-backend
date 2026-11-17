import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retryTransient, isTransientError, OUTLOOK_UNAVAILABLE_ERROR } from '../utils/transientRetry.js';

const http = (status, headers) => Object.assign(new Error(String(status)), { response: { status, headers } });
const noSleep = async () => {};

describe('retryTransient', () => {
  it('retries a 502 and returns the later success', async () => {
    let calls = 0;
    const out = await retryTransient(async () => { calls += 1; if (calls < 3) throw http(502); return 'ok'; }, { sleep: noSleep });
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the retries and tags the error as Outlook unavailable', async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(async () => { calls += 1; throw http(502); }, { sleep: noSleep }),
      (e) => e.code === OUTLOOK_UNAVAILABLE_ERROR,
    );
    assert.equal(calls, 3);
  });

  it('does not retry a 401 or other client errors', async () => {
    let calls = 0;
    await assert.rejects(retryTransient(async () => { calls += 1; throw http(401); }, { sleep: noSleep }), /401/);
    assert.equal(calls, 1);
    assert.equal(isTransientError(http(404)), false);
  });

  it('honours Retry-After but caps it', async () => {
    const waits = [];
    await assert.rejects(
      retryTransient(async () => { throw http(429, { 'retry-after': '120' }); }, { sleep: async (ms) => { waits.push(ms); }, capMs: 5000 }),
    );
    assert.deepEqual(waits, [5000, 5000]);
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
const { worxstreamApi } = await import('../services/worxstreamApi.js');
const { authenticateUser } = await import('../middleware/auth.js');
const { __clearAuthCacheForTests } = await import('../utils/authVerify.js');

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const run = async (headers) => {
  const req = { headers };
  const res = makeRes();
  let nexted = false;
  await authenticateUser(req, res, () => { nexted = true; });
  return { req, res, nexted };
};

describe('authenticateUser', () => {
  beforeEach(() => __clearAuthCacheForTests());

  it('rejects a request without a bearer token', async () => {
    const { res, nexted } = await run({});
    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
  });

  it('ignores X-User-Info and rejects an invalid token', async () => {
    worxstreamApi.verifyUserToken = async () => ({ success: false, error: 'HTTP 401', status: 401 });
    const { res, nexted } = await run({
      authorization: 'Bearer forged',
      'x-user-info': JSON.stringify({ id: 42, email: 'victim@example.com' }),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
  });

  it('uses the verified user, not the one in X-User-Info', async () => {
    worxstreamApi.verifyUserToken = async () => ({ success: true, user: { id: 7, email: 'real@example.com' } });
    const { req, nexted } = await run({
      authorization: 'Bearer good',
      'x-user-info': JSON.stringify({ id: 42, email: 'victim@example.com' }),
    });
    assert.equal(nexted, true);
    assert.equal(req.user.id, 7);
  });

  it('returns 503 when worXstream cannot be reached (production)', async () => {
    worxstreamApi.verifyUserToken = async () => ({ success: false, error: 'Request timeout', status: 408 });
    const { res, nexted } = await run({ authorization: 'Bearer anything' });
    assert.equal(res.statusCode, 503);
    assert.equal(nexted, false);
  });

  it('caches a successful verification briefly', async () => {
    let calls = 0;
    worxstreamApi.verifyUserToken = async () => { calls += 1; return { success: true, user: { id: 9 } }; };
    await run({ authorization: 'Bearer cached' });
    await run({ authorization: 'Bearer cached' });
    assert.equal(calls, 1);
  });
});

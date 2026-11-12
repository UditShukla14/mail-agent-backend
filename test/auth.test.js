import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
const { worxstreamApi } = await import('../services/worxstreamApi.js');
const { authenticateUser } = await import('../middleware/auth.js');
const { __clearAuthCacheForTests, classifyFailure } = await import('../utils/authVerify.js');

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

describe('classifyFailure', () => {
  it('treats a rejected or redirected token as invalid', () => {
    for (const status of [302, 401, 403, 404, 419, 422]) assert.equal(classifyFailure(status), 'invalid');
  });
  it('treats no answer, timeouts, rate limits and server errors as unavailable', () => {
    for (const status of [undefined, 408, 429, 500, 502, 503]) assert.equal(classifyFailure(status), 'unavailable');
  });
});

describe('extractUserFromUserInfo', () => {
  let extract;
  it('accepts every /api/user-info shape the Sign and Chat servers accept', async () => {
    ({ extractUserFromUserInfo: extract } = await import('../services/worxstreamApi.js'));
    assert.equal(extract({ success: true, data: { user: { id: 7 } } }).id, 7);
    assert.equal(extract({ success: true, user: { id: 8 } }).id, 8);
    assert.equal(extract({ id: 9, email: 'a@b.c' }).id, 9);
    assert.equal(extract({ data: { id: 10, email: 'a@b.c' } }).id, 10);
  });
  it('rejects bodies without a user id', async () => {
    const { extractUserFromUserInfo } = await import('../services/worxstreamApi.js');
    assert.equal(extractUserFromUserInfo(null), null);
    assert.equal(extractUserFromUserInfo('<html>login</html>'), null);
    assert.equal(extractUserFromUserInfo({ success: true, data: { user: {} } }), null);
  });
});

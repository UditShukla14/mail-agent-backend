import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRavenBilling } from '../../src/services/billing/ravenBilling.js';
import { extractCompanyIds } from '../../src/services/worxstreamApi.js';
import { analyzeEmail } from '../../src/agents/raven/index.js';

const reply = (status, data) => ({ ok: status < 300, status, json: async () => ({ success: status < 300, data, error: data?.error }) });
const cfg = () => ({ baseUrl: 'http://hub', serviceKey: 'k' });
const make = (fetchImpl, extra = {}) => createRavenBilling({ fetchImpl, config: cfg, enabled: () => true, sleepImpl: async () => {}, ...extra });
const call = { companyId: 'c1', userId: 7, model: 'claude-haiku-4-5', messageId: 'msg_1', usage: { input_tokens: 1000, output_tokens: 100 } };

describe('Raven billing: access', () => {
  test('billing explicitly switched off (RAVEN_BILLING=off) allows everything', async () => {
    const b = createRavenBilling({ enabled: () => false, explicitlyOff: () => true });
    assert.equal((await b.checkAccess('c1')).allowed, true);
  });
  test('a hub that is not configured does NOT mean free use: Raven stays off with a message', async () => {
    const b = createRavenBilling({ enabled: () => false, explicitlyOff: () => false });
    const r = await b.checkAccess('c1');
    assert.deepEqual([r.allowed, r.reason], [false, 'billing_not_configured']);
    assert.match(r.message, /Add credits to start using Raven/);
  });
  test('a company that cannot be identified is blocked with an explanation', async () => {
    const r = await make(async () => reply(200, {})).checkAccess('');
    assert.equal(r.allowed, false);
    assert.match(r.message, /company/);
  });
  test('asks the hub and caches the answer briefly', async () => {
    let calls = 0;
    const b = make(async (url, init) => {
      calls += 1;
      assert.match(url, /\/api\/internal\/apps\/raven\/access\?company_id=c1$/);
      assert.equal(init.headers['x-service-key'], 'k');
      return reply(200, { allowed: true, reason: 'ok', message: '', remaining_usd: 12 });
    });
    assert.equal((await b.checkAccess('c1')).remaining_usd, 12);
    await b.checkAccess('c1');
    assert.equal(calls, 1);
  });
  test('a denial is passed on with its reason', async () => {
    const r = await make(async () => reply(200, { allowed: false, reason: 'exhausted', message: 'Raven credit is used up.', remaining_usd: 0 })).checkAccess('c1');
    assert.deepEqual([r.allowed, r.reason], [false, 'exhausted']);
  });
  test('an unreachable hub blocks (billing must not be skipped) but only briefly', async () => {
    let t = 0;
    let down = true;
    const b = make(async () => (down ? Promise.reject(new Error('ECONNREFUSED')) : reply(200, { allowed: true, reason: 'ok', message: '', remaining_usd: null })), { now: () => t });
    assert.equal((await b.checkAccess('c1')).reason, 'billing_unavailable');
    down = false;
    t += 11_000; // past the short error cache
    assert.equal((await b.checkAccess('c1')).allowed, true);
  });
});

describe('Raven billing: usage', () => {
  test('reports tokens with the company, user, model and message id', async () => {
    let sent;
    const b = make(async (_u, init) => { sent = JSON.parse(init.body); return reply(200, { recorded: true }); });
    assert.equal(await b.reportUsage(call), true);
    assert.deepEqual(sent, { company_id: 'c1', user_id: '7', model: 'claude-haiku-4-5', response_model: '', message_id: 'msg_1', request_id: '', usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  });
  test('a transient failure is retried', async () => {
    let n = 0;
    const b = make(async () => (++n < 3 ? reply(503, { error: 'busy' }) : reply(200, { recorded: true })));
    assert.equal(await b.reportUsage(call), true);
    assert.equal(n, 3);
  });
  test('after the retries it is kept to try again later, never thrown', async () => {
    const b = make(async () => reply(503, { error: 'down' }));
    assert.equal(await b.reportUsage(call), false);
    assert.equal(b.pendingCount(), 1);
  });
  test('a report the hub will never accept is dropped, not retried forever', async () => {
    const b = make(async () => reply(400, { error: 'bad' }));
    assert.equal(await b.reportUsage(call), true);
    assert.equal(b.pendingCount(), 0);
  });
  test('nothing is sent when billing is off or the call has no id', async () => {
    let n = 0;
    const off = createRavenBilling({ enabled: () => false, explicitlyOff: () => true, fetchImpl: async () => { n++; return reply(200, {}); } });
    assert.equal(await off.reportUsage(call), false);
    assert.equal(await make(async () => { n++; return reply(200, {}); }).reportUsage({ ...call, messageId: '' }), false);
    assert.equal(n, 0);
  });
});

describe('company ids from user-info', () => {
  test('reads companyRoles keys and values and userRelations', () => {
    const ids = extractCompanyIds({ data: { user: { id: 1, userRelations: [{ company_id: 30 }] }, companyRoles: { 12: { companyId: 12 }, '15': {} } } });
    assert.deepEqual(ids.sort(), ['12', '15', '30']);
  });
  test('no company information gives an empty list', () => assert.deepEqual(extractCompanyIds({ user: { id: 1 } }), []));
});

describe('agent billing hook', () => {
  const categories = [{ name: 'billing', label: 'Billing', description: 'Invoices' }];
  const email = { subject: 's', from: 'a@b.c', content: 'pay now' };
  const ok = { summary: 'Asks for payment now.', category: 'billing', priority: 'high', sentiment: 'neutral', actionItems: [] };
  test('every model call is reported, including one whose answer is rejected', async () => {
    const answers = [{ ...ok, category: 'nope' }, ok];
    const client = { call: async () => ({ message: { id: `msg_${answers.length}`, model: 'm', content: [{ type: 'tool_use', name: 'record_analysis', input: answers.shift() }] }, model: 'm', usage: { input_tokens: 10, output_tokens: 5 }, fellBack: false }) };
    const seen = [];
    await analyzeEmail(email, categories, { client, onCall: (c) => seen.push(c.messageId) });
    assert.deepEqual(seen, ['msg_2', 'msg_1']);
  });
});

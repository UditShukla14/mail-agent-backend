import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClient } from '../../src/agents/core/llmClient.js';
import { parseModelFamily, DEFAULT_MODEL_FAMILY } from '../../src/config/anthropic.js';

const reply = (status, json, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: (k) => headers[k.toLowerCase()] } });
const okBody = { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } };

/** A fake Anthropic: answers by model name from a script. */
function fakeApi(script) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    const step = script[model]?.shift() ?? script[model]?.[0];
    return typeof step === 'function' ? step() : step;
  };
  return { fetchImpl, calls };
}
const client = (api, extra = {}) =>
  createLlmClient({ models: ['m1', 'm2', 'm3'], apiKey: () => 'k', fetchImpl: api.fetchImpl, sleep: async () => {}, attemptsPerModel: 2, ...extra });

describe('parseModelFamily', () => {
  test('defaults to the built-in family', () => assert.deepEqual(parseModelFamily({}), DEFAULT_MODEL_FAMILY));
  test('ANTHROPIC_MODELS wins and is de-duplicated', () => assert.deepEqual(parseModelFamily({ ANTHROPIC_MODELS: 'a, b ,a' }), ['a', 'b']));
  test('legacy ANTHROPIC_MODEL is tried first, then the family', () => {
    const family = parseModelFamily({ ANTHROPIC_MODEL: 'old-model' });
    assert.equal(family[0], 'old-model');
    assert.ok(DEFAULT_MODEL_FAMILY.every((m) => family.includes(m)));
  });
});

describe('model family client', () => {
  test('a retired model (404) moves straight to the next and is remembered', async () => {
    const api = fakeApi({ m1: [reply(404, { error: { message: 'model: m1' } })], m2: [reply(200, okBody), reply(200, okBody)] });
    const c = client(api);
    const first = await c.call({});
    assert.equal(first.model, 'm2');
    assert.equal(first.fellBack, true);
    await c.call({});
    assert.deepEqual(api.calls, ['m1', 'm2', 'm2']); // m1 is not asked again
  });

  test('overload (529) is retried once, then the next model answers', async () => {
    const api = fakeApi({ m1: [reply(529, { error: { message: 'overloaded' } })], m2: [reply(200, okBody)] });
    const out = await client(api).call({});
    assert.equal(out.model, 'm2');
    assert.deepEqual(api.calls, ['m1', 'm1', 'm2']);
  });

  test('a transient error that clears is answered by the same model', async () => {
    const api = fakeApi({ m1: [reply(500, {}), reply(200, okBody)] });
    const out = await client(api).call({});
    assert.equal(out.model, 'm1');
    assert.equal(out.fellBack, false);
  });

  test('an auth error fails at once without trying other models', async () => {
    const api = fakeApi({ m1: [reply(401, { error: { message: 'bad key' } })] });
    await assert.rejects(client(api).call({}), (e) => e.code === 'LLM_REJECTED');
    assert.deepEqual(api.calls, ['m1']);
  });

  test('every model failing is reported as unavailable', async () => {
    const down = [reply(503, {})];
    const api = fakeApi({ m1: down, m2: down, m3: down });
    await assert.rejects(client(api).call({}), (e) => e.code === 'LLM_UNAVAILABLE');
  });

  test('a network error counts as transient', async () => {
    const api = fakeApi({ m1: [() => { throw new Error('socket hang up'); }], m2: [reply(200, okBody)] });
    assert.equal((await client(api).call({})).model, 'm2');
  });

  test('skipModels excludes a model that gave unusable output', async () => {
    const api = fakeApi({ m2: [reply(200, okBody)] });
    assert.equal((await client(api).call({}, { skipModels: ['m1'] })).model, 'm2');
  });
});

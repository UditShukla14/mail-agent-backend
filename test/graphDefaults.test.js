import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import http from 'node:http';
import { mergePrefer, installGraphDefaults } from '../services/graphDefaults.js';

describe('mergePrefer', () => {
  it('adds a preference without losing the ones already asked for', () => {
    assert.equal(mergePrefer('', 'IdType="ImmutableId"'), 'IdType="ImmutableId"');
    assert.equal(mergePrefer('outlook.body-content-type="text"', 'IdType="ImmutableId"'), 'outlook.body-content-type="text", IdType="ImmutableId"');
    assert.equal(mergePrefer('IdType="ImmutableId"', 'IdType="ImmutableId"'), 'IdType="ImmutableId"');
  });
});

describe('installGraphDefaults', () => {
  it('sets the immutable-id preference on Graph calls only', async () => {
    installGraphDefaults({ immutableIds: true });
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.headers.prefer || ''); res.end('{}'); });
    await new Promise((r) => server.listen(0, r));
    try {
      // a non-Graph URL is left alone
      await axios.get(`http://127.0.0.1:${server.address().port}/x`, { headers: { Prefer: 'odata.maxpagesize=100' } });
      assert.deepEqual(seen, ['odata.maxpagesize=100']);
      // a Graph URL is rewritten before it is sent: check the request config through the interceptor chain
      const cfg = await axios.interceptors.request.handlers.filter(Boolean).reduce(
        (p, h) => p.then((c) => h.fulfilled(c)),
        Promise.resolve({ url: 'https://graph.microsoft.com/v1.0/me/messages', headers: new axios.AxiosHeaders({ Prefer: 'odata.maxpagesize=100' }) }),
      );
      assert.equal(cfg.headers.get('Prefer'), 'odata.maxpagesize=100, IdType="ImmutableId"');
    } finally {
      server.close();
    }
  });
});

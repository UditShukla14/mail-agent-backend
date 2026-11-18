import test from 'node:test';
import assert from 'node:assert/strict';
import { publishNotification, newMailEvent } from '../../src/services/notificationHub.js';

test('newMailEvent builds a mail.new event with an idempotency key', () => {
  const e = newMailEvent({ companyId: '7', worxstreamUserId: 42, email: 'a@b.c', message: { id: 'm1', from: { name: 'Ann' }, subject: 'Hi' } });
  assert.equal(e.type, 'mail.new');
  assert.equal(e.title, 'Ann');
  assert.equal(e.idempotencyKey, 'mail:m1');
});

test('publishNotification does nothing when not configured', async () => {
  delete process.env.NOTIFICATION_API_URL;
  assert.equal(await publishNotification({ companyId: '1', userId: '2' }, { fetchImpl: () => { throw new Error('called'); } }), false);
});

test('publishNotification posts with the service key and never throws', async () => {
  process.env.NOTIFICATION_API_URL = 'http://n.test/';
  process.env.NOTIFICATION_SERVICE_KEY = 'k';
  let seen;
  assert.equal(await publishNotification({ companyId: '1', userId: '2' }, { fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true }; } }), true);
  assert.equal(seen.u, 'http://n.test/v1/events');
  assert.equal(seen.o.headers['X-Service-Key'], 'k');
  assert.equal(await publishNotification({ companyId: '1', userId: '2' }, { fetchImpl: async () => { throw new Error('down'); } }), false);
});

// Real-MongoDB check of the agent-facing mail endpoints (in-memory), called with fake req/res.
//   npm i --no-save mongodb-memory-server && node test/integration/mail-api.integration.mjs
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);

const mongod = await MongoMemoryServer.create();
const mongoose = (await imp('node_modules/mongoose/index.js')).default;
await mongoose.connect(mongod.getUri('mail_test'));
const Email = (await imp('models/email.js')).default;
const User = (await imp('models/User.js')).default;
const EmailAccount = (await imp('models/EmailAccount.js')).default;
const api = await imp('controllers/emailSearchController.js');

const kevin = await User.create({ worxstreamUserId: 16, email: 'udit@alphaparktech.com', name: 'Udit' });
const other = await User.create({ worxstreamUserId: 64, email: 'someone@else.com', name: 'Else' });
await EmailAccount.create({ userId: kevin._id, email: 'udit@alphaparktech.com', provider: 'outlook' });
const at = (mins) => new Date(Date.now() - mins * 60000);
const row = (id, mins, over = {}) => ({ id, userId: kevin._id, email: 'udit@alphaparktech.com', from: 'Kevin Lee <kevin@rxo.com>', to: 'udit@alphaparktech.com', subject: 'Order 4471', timestamp: at(mins), folder: 'inbox', read: true, conversationId: 'c1', content: '<p>x</p>', preview: 'x', ...over });
await Email.insertMany([
  row('k1', 300, { content: '<p>Please confirm the pickup window.</p>' }),
  row('k2', 200, { from: 'Udit <udit@alphaparktech.com>', to: 'kevin@rxo.com', folder: 'sent', content: '<p>Thursday works.</p>' }),
  row('k3', 10, { read: false, hasAttachments: true, content: '<p>Great, booked.</p><div id="divRplyFwdMsg"><b>From:</b> Udit<br><b>Sent:</b> Thursday<br><b>To:</b> Kevin<br><b>Subject:</b> Re</div><p>Thursday works.</p>' }),
  { ...row('z1', 5, { conversationId: 'cz' }), userId: other._id, email: 'someone@else.com', subject: 'Secret' }, // someone else's mail
]);

const call = async (handler, userId, { params = {}, query = {} } = {}) => {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, ...b }; return this; } };
  await handler({ user: { id: userId }, params, query }, res);
  return out;
};

// the thread: oldest first, with each message's own text only
let r = await call(api.getConversation, 16, { params: { conversationId: 'c1' } });
assert.equal(r.success, true);
assert.deepEqual(r.data.messages.map((m) => m.id), ['k1', 'k2', 'k3']);
assert.equal(r.data.messages[2].body, 'Great, booked.'); // quoted history cut
assert.equal(r.data.messages[0].body, 'Please confirm the pickup window.');
assert.equal(r.data.messages[2].hasAttachments, true);

// another user's thread is invisible, and a thread that does not exist is a 404
assert.equal((await call(api.getConversation, 16, { params: { conversationId: 'cz' } })).code, 404);
assert.equal((await call(api.getConversation, 64, { params: { conversationId: 'c1' } })).code, 404);
assert.equal((await call(api.getConversation, 999, { params: { conversationId: 'c1' } })).code, 404);

// search finds the person by sender and by recipient, and reports the thread id
r = await call(api.searchEmails, 16, { query: { from: 'kevin', q: 'rxo' } });
assert.equal(r.data.total, 2); // k1, k3 (k2 is from me)
r = await call(api.searchEmails, 16, { query: { to: 'kevin' } });
assert.equal(r.data.emails[0].id, 'k2');
assert.equal(r.data.emails[0].conversationId, 'c1');
r = await call(api.searchEmails, 16, { query: { has_attachments: 'true' } });
assert.deepEqual(r.data.emails.map((e) => e.id), ['k3']);

// folders: with no Outlook connection the stored folders are still listed, with counts
r = await call(api.listFolders, 16);
const folders = r.data[0].folders;
assert.deepEqual(folders.map((f) => [f.id, f.stored, f.unread]).sort(), [['inbox', 2, 1], ['sent', 1, 0]]);
assert.deepEqual((await call(api.listFolders, 64)).data, []); // no account connected: nothing to list

// attachments need the mailbox connection: without one it says so instead of failing
r = await call(api.listAttachments, 16, { params: { id: 'k3' } });
assert.equal(r.code, 409);
assert.equal((await call(api.listAttachments, 64, { params: { id: 'k3' } })).code, 404);

console.log('mail-api integration: ok');
await mongoose.disconnect();
await mongod.stop();

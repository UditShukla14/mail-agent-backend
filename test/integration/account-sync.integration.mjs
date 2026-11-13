// Real-MongoDB check of the delta-based account sync and the clean-and-resync (in-memory Mongo, fake Outlook).
//   npm i --no-save mongodb-memory-server && node test/integration/account-sync.integration.mjs
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);

const mongod = await MongoMemoryServer.create();
const mongoose = (await imp('node_modules/mongoose/index.js')).default;
await mongoose.connect(mongod.getUri('mail_test'));
const Email = (await imp('models/email.js')).default;
const { runAccountSync } = await imp('services/accountSync.js');
const { runCleanResync } = await imp('services/cleanResync.js');
await Email.init();

const user = { _id: new mongoose.Types.ObjectId() };
const email = 'me@x.com';
const old = new Date(Date.now() - 3600_000);
const noPause = async () => {};
const doc = (id, folder, over = {}) => ({ id, email, userId: user._id, folder, from: 'A <a@x.com>', subject: 'old subject', timestamp: old, read: false, conversationId: '', createdAt: old, updatedAt: old, aiMeta: { summary: 'old summary', category: 'x' }, isProcessed: true, ...over });
const row = (id, folder, over = {}) => ({ id, folder, from: 'B <b@x.com>', to: 'Me <me@x.com>', cc: '', bcc: '', subject: 'new subject', preview: 'p', content: '<p>body</p>', timestamp: new Date().toISOString(), read: true, important: false, flagged: false, conversationId: 'c1', hasAttachments: false, ...over });
const folders = [{ id: 'inbox', displayName: 'Inbox' }, { id: 'archive', displayName: 'Archive' }];

// an in-memory delta state store
const store = new Map();
const state = {
  loadState: async (f) => (store.has(f) ? { deltaLink: store.get(f).deltaLink, since: store.get(f).since } : null),
  saveState: async (f, deltaLink, since) => { store.set(f, { deltaLink, since }); },
  clearState: async (f) => { store.delete(f); },
};
const run = (listDelta, extra = {}) => runAccountSync({ user, email, listFolders: async () => folders, listDelta, pause: noPause, ...state, ...extra });

// ================= first run: full read of each folder, delta links saved =================
await Email.collection.insertMany([
  doc('a1', 'inbox'), doc('a2', 'inbox'),
  doc('m1', 'inbox'), // moved to Archive in Outlook
  doc('gone', 'inbox'), // deleted in Outlook
  doc('justArrived', 'inbox', { createdAt: new Date(), updatedAt: new Date() }),
  doc('other', 'inbox', { email: 'someone@else.com' }),
]);
const calls = [];
const first = {
  inbox: [{ rows: [row('a1', 'inbox', { flagged: true }), row('a2', 'inbox'), row('n1', 'inbox', { conversationId: 'c7' })], removed: [], nextLink: 'inbox-p2', deltaLink: null },
          { rows: [row('justArrived', 'inbox', { conversationId: 'c2' })], removed: [], nextLink: null, deltaLink: 'INBOX-DL1' }],
  archive: [{ rows: [row('m1', 'archive', { conversationId: 'c5' })], removed: [], nextLink: null, deltaLink: 'ARCHIVE-DL1' }],
};
let res = await run(async (folderId, link) => { calls.push([folderId, link]); return first[folderId][link ? 1 : 0]; });
assert.deepEqual([res.full, res.incremental, res.foldersFailed], [2, 0, 0]);
assert.deepEqual(calls, [['inbox', null], ['inbox', 'inbox-p2'], ['archive', null]]);
assert.deepEqual([...store.entries()].map(([f, s]) => [f, s.deltaLink]), [['inbox', 'INBOX-DL1'], ['archive', 'ARCHIVE-DL1']]);
const a1 = await Email.findOne({ id: 'a1' });
assert.deepEqual([a1.flagged, a1.read, a1.subject, a1.conversationId], [true, true, 'new subject', 'c1']);
assert.equal(a1.aiMeta.summary, 'old summary'); // Sync all never touches the AI values
assert.deepEqual([(await Email.findOne({ id: 'm1' })).folder, (await Email.findOne({ id: 'm1' })).conversationId], ['archive', 'c5']); // the move is followed
assert.equal((await Email.findOne({ id: 'n1' })).isProcessed, false); // new message
assert.equal(await Email.countDocuments({ id: 'gone' }), 0); // deleted in Outlook, found by the full read
assert.equal(await Email.countDocuments({ id: 'justArrived' }), 1); // too new to judge
assert.equal(await Email.countDocuments({ id: 'other' }), 1); // another account is untouched
assert.equal(res.added, 1);

// ================= later run: only the changes =================
await Email.collection.insertOne(doc('m2', 'inbox')); // will be moved to Archive
await Email.collection.insertOne(doc('stale', 'inbox')); // not mentioned by delta: must stay (delta is the authority now)
calls.length = 0;
const second = {
  'INBOX-DL1': { rows: [row('a1', 'inbox', { read: false })], removed: ['a2', 'm2'], nextLink: null, deltaLink: 'INBOX-DL2' },
  'ARCHIVE-DL1': { rows: [row('m2', 'archive')], removed: [], nextLink: null, deltaLink: 'ARCHIVE-DL2' },
};
res = await run(async (folderId, link) => { calls.push([folderId, link]); return second[link]; });
assert.deepEqual([res.full, res.incremental], [0, 2]);
assert.deepEqual(calls, [['inbox', 'INBOX-DL1'], ['archive', 'ARCHIVE-DL1']]); // started from the saved links
assert.equal(await Email.countDocuments({ id: 'a2' }), 0); // reported deleted
assert.equal((await Email.findOne({ id: 'm2' })).folder, 'archive'); // reported removed from inbox AND added to archive: moved, not lost
assert.equal((await Email.findOne({ id: 'a1' })).read, false);
assert.equal(await Email.countDocuments({ id: 'stale' }), 1);
assert.equal(store.get('inbox').deltaLink, 'INBOX-DL2');

// ================= an expired link starts that folder over =================
let attempts = 0;
res = await run(async (folderId, link) => {
  if (folderId === 'archive') return { rows: [], removed: [], nextLink: null, deltaLink: 'ARCHIVE-DL3' };
  attempts += 1;
  if (link) { const e = new Error('gone'); e.response = { status: 410 }; throw e; }
  return { rows: [row('a1', 'inbox')], removed: [], nextLink: null, deltaLink: 'INBOX-FRESH' };
});
assert.equal(attempts, 2);
assert.equal(store.get('inbox').deltaLink, 'INBOX-FRESH');
assert.equal(res.foldersFailed, 0);

// ================= a failing folder: the rest syncs, nothing is cleaned =================
store.clear();
await Email.collection.insertOne(doc('stale2', 'inbox'));
res = await run(async (folderId) => {
  if (folderId === 'archive') throw new Error('boom');
  return { rows: [row('a1', 'inbox')], removed: [], nextLink: null, deltaLink: 'X' };
});
assert.equal(res.foldersFailed, 1);
assert.equal(await Email.countDocuments({ id: 'stale2' }), 1); // a full read that did not finish everywhere deletes nothing
assert.equal(store.has('archive'), false);

// ================= clean and resync: a date range, AI values reset, everything else removed =================
await Email.updateOne({ id: 'a1' }, { $set: { aiMeta: { summary: 'keep me?', category: 'finance' }, isProcessed: true } });
const rangeRows = {
  inbox: [{ rows: [row('r1', 'inbox', { content: '<p>r1</p>' }), row('a1', 'inbox', { subject: 'fresh' })], nextLink: 'inbox-p2' }, { rows: [row('r2', 'inbox')], nextLink: null }],
  archive: [{ rows: [row('m2', 'archive')], nextLink: null }],
};
let cleared = 0;
const seenRange = [];
const sinceD = new Date(Date.now() - 30 * 86400000);
const untilD = new Date();
res = await runCleanResync({
  user, email, since: sinceD, until: untilD, listFolders: async () => folders, pause: noPause, clearAllState: async () => { cleared += 1; store.clear(); },
  listRange: async (folderId, opts) => { seenRange.push([folderId, opts.since === sinceD, opts.until === untilD]); return rangeRows[folderId][opts.nextLink ? 1 : 0]; },
});
assert.ok(seenRange.every(([, s, u]) => s && u)); // the chosen period went to every listing
assert.equal(res.foldersFailed, 0);
const a1b = await Email.findOne({ id: 'a1' }).lean();
assert.equal(a1b.subject, 'fresh');
assert.equal(a1b.content, '<p>body</p>'); // the body is stored again
assert.equal(a1b.isProcessed, false); // AI values start again...
assert.equal(a1b.aiMeta.summary, undefined);
assert.equal(a1b.aiMeta.category, undefined);
assert.ok('aiMeta' in a1b); // ...but the AI field itself is still there
assert.deepEqual((await Email.find({ email }).lean()).map((d) => d.id).sort(), ['a1', 'justArrived', 'm2', 'n1', 'r1', 'r2']); // only the period, plus mail stored in the last 5 minutes (n1 was just synced), which is never judged
assert.equal(await Email.countDocuments({ id: 'other' }), 1);
assert.ok(res.removed >= 1); // what the period did not contain is gone
assert.equal(cleared, 1);
assert.equal(store.size, 0); // delta links forgotten

// ================= a failed resync keeps the old data; an empty one deletes nothing =================
const before = await Email.countDocuments({ email });
res = await runCleanResync({ user, email, since: sinceD, until: untilD, listFolders: async () => folders, pause: noPause, clearAllState: async () => assert.fail('must not clear'), listRange: async (f) => { if (f === 'archive') throw new Error('boom'); return { rows: [row('zz', 'inbox')], nextLink: null }; } });
assert.equal(res.skippedClean, true);
assert.equal(res.skipReason, 'some folders could not be read');
assert.equal(await Email.countDocuments({ email }), before + 1); // the new copy of 'zz' is in, nothing was deleted
res = await runCleanResync({ user, email, since: sinceD, until: untilD, listFolders: async () => folders, pause: noPause, clearAllState: async () => assert.fail('must not clear'), listRange: async () => ({ rows: [], nextLink: null }) });
assert.equal(res.skipReason, 'no mail was found in that period');
assert.equal(await Email.countDocuments({ email }), before + 1);

console.log('account-sync integration: ok');
await mongoose.disconnect();
await mongod.stop();

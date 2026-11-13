// Real-MongoDB check of the full account sync (in-memory). Not part of `npm test`:
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
await Email.init();

const user = { _id: new mongoose.Types.ObjectId() };
const email = 'me@x.com';
const old = new Date(Date.now() - 3600_000);
const doc = (id, folder, over = {}) => ({ id, email, userId: user._id, folder, from: 'A <a@x.com>', subject: 'old subject', timestamp: old, read: false, conversationId: '', createdAt: old, updatedAt: old, ...over });
await Email.collection.insertMany([
  doc('a1', 'inbox'), doc('a2', 'inbox'),
  doc('m1', 'inbox'), // moved to Archive in Outlook
  doc('gone', 'inbox'), // deleted in Outlook
  doc('justArrived', 'inbox', { createdAt: new Date(), updatedAt: new Date() }),
  doc('other', 'inbox', { email: 'someone@else.com' }), // another account: never touched
]);

const row = (id, over = {}) => ({ id, from: 'B <b@x.com>', to: 'Me <me@x.com>', cc: '', bcc: '', subject: 'new subject', preview: 'p', timestamp: new Date().toISOString(), read: true, important: false, flagged: false, conversationId: 'c1', hasAttachments: false, ...over });
const folders = [{ id: 'inbox', displayName: 'Inbox' }, { id: 'archive', displayName: 'Archive' }, { id: 'sub', displayName: 'Projects', path: 'Archive/Projects' }];
const messages = {
  inbox: [[row('a1', { flagged: true, hasAttachments: true }), row('a2'), row('n1', { conversationId: 'c7' }), row('justArrived', { conversationId: 'c2' })]],
  archive: [[row('m1', { conversationId: 'c5' })]],
  sub: [[]],
};
const lister = (failFolder) => async (folderId, link) => {
  if (folderId === failFolder) throw new Error('boom');
  const pages = messages[folderId];
  const i = link ? Number(link) : 0;
  return { rows: pages[i], nextLink: i + 1 < pages.length ? String(i + 1) : null };
};
const noPause = async () => {};

// ---- a failed folder: everything else syncs, nothing is deleted ----
let progress = [];
let res = await runAccountSync({ user, email, listFolders: async () => folders, listMessages: lister('sub'), pause: noPause, onProgress: (p) => progress.push(p) });
assert.equal(res.foldersFailed, 1);
assert.equal(res.added, 1); // the healthy folders still synced (n1 is new)
assert.equal(res.removed, 0);
assert.equal(await Email.countDocuments({ id: 'gone' }), 1);
assert.ok(progress.length > 0 && progress.at(-1).foldersTotal === 3);

// ---- a clean run ----
res = await runAccountSync({ user, email, listFolders: async () => folders, listMessages: lister(null), pause: noPause });
assert.equal(res.foldersFailed, 0);
const a1 = await Email.findOne({ id: 'a1' });
assert.deepEqual([a1.read, a1.flagged, a1.conversationId, a1.hasAttachments, a1.subject], [true, true, 'c1', true, 'new subject']);
assert.equal((await Email.findOne({ id: 'a2' })).conversationId, 'c1');
const m1 = await Email.findOne({ id: 'm1' });
assert.deepEqual([m1.folder, m1.conversationId], ['archive', 'c5']); // the move is followed, not deleted
const n1 = await Email.findOne({ id: 'n1' });
assert.equal(n1.folder, 'inbox'); // a message we did not hold is added
assert.equal(n1.isProcessed, false);
assert.equal(res.added, 0); // already added by the first run
assert.equal(await Email.countDocuments({ id: 'gone' }), 0); // deleted in Outlook
assert.equal(res.removed, 1);
assert.equal(await Email.countDocuments({ id: 'justArrived' }), 1); // too new to judge
assert.equal(await Email.countDocuments({ id: 'other' }), 1); // other account untouched

// ---- the budget for adding new messages ----
await Email.deleteOne({ id: 'n1' });
messages.inbox = [[row('n1'), row('n2'), row('a1')]];
res = await runAccountSync({ user, email, listFolders: async () => [folders[0]], listMessages: lister(null), pause: noPause, maxNewPerFolder: 1 });
assert.equal(res.added, 1);
assert.equal(await Email.countDocuments({ id: 'n2' }), 0);

// ---- a listing with nothing in it never deletes ----
messages.inbox = [[]]; messages.archive = [[]];
const before = await Email.countDocuments({ email });
res = await runAccountSync({ user, email, listFolders: async () => folders.slice(0, 2), listMessages: lister(null), pause: noPause });
assert.equal(res.removed, 0);
assert.equal(await Email.countDocuments({ email }), before);

console.log('account-sync integration: ok');
await mongoose.disconnect();
await mongod.stop();

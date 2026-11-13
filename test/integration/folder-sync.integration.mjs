// Real-MongoDB check of conversation grouping and folder sync (in-memory). Not part of `npm test`:
//   npm i --no-save mongodb-memory-server && node test/integration/folder-sync.integration.mjs
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);

const mongod = await MongoMemoryServer.create();
const mongoose = (await imp('node_modules/mongoose/index.js')).default;
await mongoose.connect(mongod.getUri('mail_test'));

const Email = (await imp('models/email.js')).default;
const { saveOutlookMessages, getFolderThreads, syncConversationIds } = await imp('services/folderSync.js');
await Email.init();

const user = { _id: new mongoose.Types.ObjectId() };
const email = 'me@x.com';
const at = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const msg = (id, conversationId, mins, over = {}) => ({ id, conversationId, timestamp: at(mins), from: 'A <a@x.com>', subject: 's', read: true, ...over });

// ---- saving follows Outlook, and a repeat does not reset enrichment ----
await saveOutlookMessages(user, email, 'inbox', [msg('a3', 'c1', 10, { read: false }), msg('a2', 'c1', 100), msg('a1', 'c1', 900), msg('b1', 'c2', 50), msg('legacy', '', 30)]);
await saveOutlookMessages(user, email, 'sent', [msg('s1', 'c1', 60)]); // my reply, in another folder
await Email.updateOne({ id: 'a3', email }, { $set: { isProcessed: true } });
await saveOutlookMessages(user, email, 'inbox', [msg('a3', 'c1', 10, { read: false })]);
assert.equal((await Email.findOne({ id: 'a3' })).isProcessed, true);

// ---- the list: one row per conversation, newest first, counts include other folders ----
let page = await getFolderThreads({ user, email, folderId: 'inbox', page: 1, pageSize: 20 });
assert.deepEqual(page.messages.map((m) => m.id), ['a3', 'legacy', 'b1']); // c1 shown once, by its newest message
assert.equal(page.messages[0].threadCount, 4); // a3, a2, a1 + the reply in Sent
assert.equal(page.messages[0].threadUnread, 1);
assert.equal(page.messages[1].threadCount, 1); // no conversation id: stands alone
assert.equal(page.hasMore, false);
assert.equal(page.messages[0].content, undefined); // bodies are not sent with the list

// ---- paging is over conversations ----
const p1 = await getFolderThreads({ user, email, folderId: 'inbox', page: 1, pageSize: 2 });
const p2 = await getFolderThreads({ user, email, folderId: 'inbox', page: 2, pageSize: 2 });
assert.deepEqual([p1.messages.length, p1.hasMore, p2.messages.map((m) => m.id), p2.hasMore], [2, true, ['b1'], false]);

// ---- sync: the saved ids become Outlook's ----
await Email.updateOne({ id: 'a2', email }, { $set: { conversationId: '' } }); // lost its id
await Email.updateOne({ id: 'a1', email }, { $set: { conversationId: 'stale' } }); // wrong id
const listing = [
  { rows: [{ id: 'a3', conversationId: 'c1', hasAttachments: true }, { id: 'a2', conversationId: 'c1', hasAttachments: false }], nextLink: 'next' },
  { rows: [{ id: 'a1', conversationId: 'c1', hasAttachments: false }, { id: 'b1', conversationId: 'c2', hasAttachments: false }, { id: 'legacy', conversationId: 'c3', hasAttachments: false }], nextLink: null },
];
let call = 0;
const res = await syncConversationIds({ token: 't', user, email, folderId: 'inbox', list: async () => listing[call++] });
assert.equal(res.complete, true);
assert.equal(res.scanned, 5);
assert.equal((await Email.findOne({ id: 'a2' })).conversationId, 'c1');
assert.equal((await Email.findOne({ id: 'a1' })).conversationId, 'c1'); // corrected
assert.equal((await Email.findOne({ id: 'a3' })).hasAttachments, true);
assert.equal(res.missing, 0);
page = await getFolderThreads({ user, email, folderId: 'inbox', page: 1, pageSize: 20 });
assert.equal(page.messages.length, 3); // c1, c2, c3: the thread is whole now
assert.equal(page.messages.find((m) => m.conversationId === 'c1').threadCount, 4);

// ---- a message Outlook no longer has in the folder is dropped, but only when it is not brand new ----
await Email.collection.insertOne({ id: 'gone', email, userId: user._id, folder: 'inbox', from: 'x', timestamp: new Date(), conversationId: 'c9', createdAt: new Date(Date.now() - 3600_000), updatedAt: new Date() });
await Email.collection.insertOne({ id: 'justArrived', email, userId: user._id, folder: 'inbox', from: 'x', timestamp: new Date(), conversationId: 'c8', createdAt: new Date(), updatedAt: new Date() });
call = 0;
const res2 = await syncConversationIds({ token: 't', user, email, folderId: 'inbox', list: async () => listing[call++] });
assert.equal(res2.removed, 1);
assert.equal(await Email.countDocuments({ id: 'gone' }), 0);
assert.equal(await Email.countDocuments({ id: 'justArrived' }), 1);
assert.equal(await Email.countDocuments({ id: 's1' }), 1); // other folders are never touched

// ---- nothing is deleted from an empty or incomplete listing ----
await Email.collection.insertOne({ id: 'keep', email, userId: user._id, folder: 'inbox', from: 'x', timestamp: new Date(), createdAt: new Date(Date.now() - 3600_000), updatedAt: new Date() });
const empty = await syncConversationIds({ token: 't', user, email, folderId: 'inbox', list: async () => ({ rows: [], nextLink: null }) });
assert.equal(empty.removed, 0);
const partial = await syncConversationIds({ token: 't', user, email, folderId: 'inbox', maxPages: 1, list: async () => ({ rows: [{ id: 'a3', conversationId: 'c1', hasAttachments: false }], nextLink: 'more' }) });
assert.equal(partial.complete, false);
assert.equal(partial.removed, 0);
assert.equal(await Email.countDocuments({ id: 'keep' }), 1);

console.log('folder-sync integration: ok');
await mongoose.disconnect();
await mongod.stop();

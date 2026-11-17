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

const Email = (await imp('src/models/email.js')).default;
const { saveOutlookMessages, getFolderThreads } = await imp('src/services/sync/folderSync.js');
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

console.log('folder-sync integration: ok');
await mongoose.disconnect();
await mongod.stop();

// Real-MongoDB check of push-notification handling (in-memory Mongo, fake Outlook).
//   npm i --no-save mongodb-memory-server && node test/integration/message-changes.integration.mjs
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const mongod = await MongoMemoryServer.create();
const mongoose = (await imp('node_modules/mongoose/index.js')).default;
await mongoose.connect(mongod.getUri('mail_test'));
const Email = (await imp('models/email.js')).default;
const { applyMessageChange } = await imp('services/messageChanges.js');
await Email.init();

const account = { _id: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), email: 'me@x.com', worxstreamUserId: 16, outlookInboxFolderId: 'inbox-id' };
const events = [];
const enq = [];
let remote = new Map(); // what Outlook "has": id -> message
const deps = {
  getMeta: async (id) => remote.get(id) || null,
  getFull: async (id) => remote.get(id) || null,
  enqueueEnrichment: async (docs) => { enq.push(...docs.map((d) => d.id)); },
  notifyNew: (doc) => events.push(['mail:new', doc.id, doc.folder]),
  notify: (event, payload) => events.push([event, payload.messageId]),
};
const msg = (id, over = {}) => ({ id, from: 'K <k@rxo.com>', to: 'me@x.com', cc: '', bcc: '', subject: 's', content: '<p>hello</p>', timestamp: new Date().toISOString(), read: false, important: false, flagged: false, conversationId: 'c1', hasAttachments: false, folder: 'inbox-id', ...over });
const apply = (changeType, id) => applyMessageChange({ account, changeType, messageId: id, deps });

// created in the Inbox: saved, analysed, announced; the same notification again changes nothing
remote.set('m1', msg('m1'));
assert.equal((await apply('created', 'm1')).action, 'created');
assert.deepEqual(enq, ['m1']);
assert.deepEqual(events, [['mail:new', 'm1', 'inbox-id']]);
assert.equal((await apply('created', 'm1')).action, 'duplicate');
assert.equal(enq.length, 1);
assert.equal(events.length, 1);

// created in Sent: kept and announced for the open list, but not analysed
remote.set('s1', msg('s1', { folder: 'sent-id', read: true }));
await apply('created', 's1');
assert.deepEqual(enq, ['m1']);
assert.deepEqual(events.at(-1), ['mail:new', 's1', 'sent-id']);

// updated: read in Outlook -> the page is told, flags follow; an unknown message is left for the next sync
events.length = 0;
remote.set('m1', msg('m1', { read: true, flagged: true, important: true }));
assert.equal((await apply('updated', 'm1')).action, 'updated');
const m1 = await Email.findOne({ id: 'm1' }).lean();
assert.deepEqual([m1.read, m1.flagged, m1.important], [true, true, true]);
assert.deepEqual(events, [['mail:markedRead', 'm1'], ['mail:importantMarked', 'm1']]);

// a MOVE arrives as "deleted" from the old folder: the message still exists, so it follows to its new folder
events.length = 0;
remote.set('m1', msg('m1', { read: true, folder: 'archive-id' }));
assert.equal((await apply('deleted', 'm1')).action, 'moved');
assert.equal((await Email.findOne({ id: 'm1' })).folder, 'archive-id');
assert.deepEqual(events, []); // nothing was deleted, nothing to announce

// really deleted: gone from Outlook -> removed, the page is told
remote.delete('m1');
assert.equal((await apply('deleted', 'm1')).action, 'deleted');
assert.equal(await Email.countDocuments({ id: 'm1' }), 0);
assert.deepEqual(events, [['mail:deleted', 'm1']]);
assert.equal((await apply('deleted', 'm1')).action, 'unknown'); // a repeat is harmless

// an update for a message that no longer exists is treated as deleted
remote.set('x1', msg('x1'));
await apply('created', 'x1');
remote.delete('x1');
assert.equal((await apply('updated', 'x1')).action, 'deleted');

console.log('message-changes integration: ok');
await mongoose.disconnect();
await mongod.stop();

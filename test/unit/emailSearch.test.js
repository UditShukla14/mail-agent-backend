import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery, clampLimit, toPlainText, latestMessageText } from '../controllers/emailSearchController.js';

const base = { userId: 'u1', accountEmails: ['a@x.com', 'b@x.com'] };

describe('buildSearchQuery', () => {
  it('always scopes to the user and their own accounts', () => {
    const q = buildSearchQuery({ ...base, params: {} });
    assert.equal(q.userId, 'u1');
    assert.deepEqual(q.email, { $in: ['a@x.com', 'b@x.com'] });
  });

  it('ignores an email that is not one of the user\'s accounts', () => {
    const q = buildSearchQuery({ ...base, params: { email: 'victim@else.com' } });
    assert.deepEqual(q.email, { $in: ['a@x.com', 'b@x.com'] });
  });

  it('narrows to an own account', () => {
    assert.equal(buildSearchQuery({ ...base, params: { email: 'b@x.com' } }).email, 'b@x.com');
  });

  it('maps filters and escapes regex input', () => {
    const q = buildSearchQuery({ ...base, params: { priority: 'urgent', unread: 'true', from: 'a.b(c', q: 'x+y' } });
    assert.equal(q['aiMeta.priority'], 'urgent');
    assert.equal(q.read, false);
    assert.equal(q.$and[0].from.$regex, 'a\\.b\\(c');
    assert.equal(q.$and[1].$or[0].subject.$regex, 'x\\+y');
  });

  it('ignores invalid dates', () => {
    const q = buildSearchQuery({ ...base, params: { since: 'not-a-date' } });
    assert.equal(q.timestamp, undefined);
  });
});

describe('helpers', () => {
  it('clamps the limit', () => {
    assert.equal(clampLimit(undefined), 10);
    assert.equal(clampLimit('500'), 25);
    assert.equal(clampLimit('0'), 10);
  });

  it('turns HTML into capped plain text', () => {
    const { text, truncated } = toPlainText('<style>x{}</style><p>Hello&nbsp;<b>team</b></p><script>bad()</script>');
    assert.equal(text, 'Hello team');
    assert.equal(truncated, false);
    assert.equal(toPlainText('a'.repeat(7000)).truncated, true);
  });
});

describe('search filters for conversations', () => {
  it('filters by recipient, subject, attachments and conversation', () => {
    const q = buildSearchQuery({ ...base, params: { to: 'kevin', subject: 'Order 4471', has_attachments: 'true', conversation_id: 'c1' } });
    assert.equal(q.conversationId, 'c1');
    assert.equal(q.hasAttachments, true);
    assert.equal(q.$and[0].$or[0].to.$regex, 'kevin');
    assert.equal(q.$and[1].subject.$regex, 'Order 4471');
  });

  it('free text also looks at the recipients and the preview', () => {
    const q = buildSearchQuery({ ...base, params: { q: 'rxo' } });
    const keys = q.$and[0].$or.map((c) => Object.keys(c)[0]);
    assert.deepEqual(keys, ['subject', 'from', 'to', 'preview', 'aiMeta.summary']);
  });
});

describe('latestMessageText', () => {
  it('keeps the new text and drops the quoted history', () => {
    const outlook = 'Confirmed for Friday.\n\nFrom: Rahul <r@x.com>\nSent: Thursday 10:58\nTo: me\nSubject: Re: call\nCan we do 11:00?';
    assert.equal(latestMessageText(outlook), 'Confirmed for Friday.');
    assert.equal(latestMessageText('Sounds good.\n\nOn Tue, Nov 12, 2026 at 3:04 PM Priya <p@x.com> wrote:\n> Can we meet?'), 'Sounds good.');
    assert.equal(latestMessageText('Thanks\n-----Original Message-----\nFrom: a'), 'Thanks');
  });
  it('leaves a message without history alone, and one that starts with a header whole', () => {
    assert.equal(latestMessageText('Just a note'), 'Just a note');
    assert.match(latestMessageText('From: a\nSent: b\nbody'), /From: a/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKql, mapGraphMessage } from '../services/outlookService.js';
import { parseRange } from '../services/syncJobs.js';

describe('buildKql', () => {
  it('builds a $search string from separate parts', () => {
    assert.equal(buildKql({ from: 'kevin', q: 'rxo', hasAttachments: true }), 'rxo from:kevin hasattachments:true');
    assert.equal(buildKql({ subject: 'order 4471', to: 'udit@x.com' }), 'to:udit@x.com subject:"order 4471"');
    assert.equal(buildKql({}), '');
  });
  it('cannot be bent by quotes or backslashes in the input', () => {
    assert.equal(buildKql({ from: 'a" OR from:b\\' }), 'from:"a OR from:b"');
  });
});

describe('mapGraphMessage', () => {
  const m = {
    id: 'AAk=', subject: 'Re: Quote', bodyPreview: 'hi', receivedDateTime: '2026-11-12T14:13:00Z', isRead: true, importance: 'high',
    flag: { flagStatus: 'flagged' }, conversationId: 'c1', hasAttachments: true, parentFolderId: 'f2',
    from: { emailAddress: { name: 'Kevin', address: 'k@rxo.com' } },
    toRecipients: [{ emailAddress: { name: 'Udit', address: 'u@x.com' } }],
  };
  it('maps the fields the stored mailbox uses and the folder it is really in', () => {
    const r = mapGraphMessage(m, 'f1');
    assert.deepEqual([r.id, r.from, r.to, r.folder, r.conversationId], ['AAk=', 'Kevin <k@rxo.com>', 'Udit <u@x.com>', 'f2', 'c1']);
    assert.deepEqual([r.read, r.important, r.flagged, r.hasAttachments], [true, true, true, true]);
    assert.equal('content' in r, false); // no body unless it was requested
  });
  it('keeps the body when one was requested, and falls back to the listed folder', () => {
    const r = mapGraphMessage({ ...m, parentFolderId: undefined, body: { content: '<p>x</p>' } }, 'f1');
    assert.equal(r.content, '<p>x</p>');
    assert.equal(r.folder, 'f1');
  });
});

describe('parseRange (the period of a clean and resync)', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  it('takes whole days and never reaches into the future', () => {
    const r = parseRange({ since: '2026-10-01', until: '2026-12-31' }, now);
    assert.equal(r.since.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(r.until.toISOString(), now.toISOString()); // capped at now
    assert.equal(parseRange({ since: '2026-11-01' }, now).until.toISOString(), now.toISOString()); // end defaults to now
    assert.equal(parseRange({ since: '2026-11-01', until: '2026-11-05' }, now).until.toISOString(), '2026-11-05T23:59:59.999Z');
  });
  it('refuses a missing, backwards, future or huge period', () => {
    assert.throws(() => parseRange({}, now), /start date/);
    assert.throws(() => parseRange({ since: '2026-11-10', until: '2026-11-01' }, now), /before the end/);
    assert.throws(() => parseRange({ since: '2026-12-01' }, now), /future/);
    assert.throws(() => parseRange({ since: '2015-01-01' }, now), /5 years/);
    assert.throws(() => parseRange({ since: 'nonsense' }, now), /start date/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shapeThreadMessage } from '../services/outlookService.js';

describe('shapeThreadMessage', () => {
  it('maps a Graph message and uses uniqueBody (the new text only) as its text', () => {
    const m = shapeThreadMessage({
      id: 'm1', conversationId: 'c1', subject: 'Re: Quote API', parentFolderId: 'inbox-id',
      from: { emailAddress: { name: 'Kevin Sullivan', address: 'kevin@rxo.com' } },
      toRecipients: [{ emailAddress: { name: 'Udit', address: 'udit@alphaparktech.com' } }],
      receivedDateTime: '2026-11-12T14:13:00Z', isRead: false, importance: 'high', flag: { flagStatus: 'flagged' }, hasAttachments: true,
      bodyPreview: 'x'.repeat(300),
      uniqueBody: { contentType: 'text', content: 'Please re-attempt the Quote API.\r\n\r\n\r\n\r\nThanks,  Kevin' },
    });
    assert.deepEqual([m.id, m.conversationId, m.folder, m.from, m.to], ['m1', 'c1', 'inbox-id', 'Kevin Sullivan <kevin@rxo.com>', 'Udit <udit@alphaparktech.com>']);
    assert.deepEqual([m.read, m.important, m.flagged, m.hasAttachments], [false, true, true, true]);
    assert.equal(m.preview.length, 200);
    assert.equal(m.text, 'Please re-attempt the Quote API.\n\nThanks, Kevin');
  });

  it('has no text when Outlook gives no unique body, so the caller can fall back to the stored copy', () => {
    assert.equal(shapeThreadMessage({ id: 'm2', uniqueBody: null }).text, null);
    assert.equal(shapeThreadMessage({ id: 'm3' }).subject, '(No Subject)');
  });
});

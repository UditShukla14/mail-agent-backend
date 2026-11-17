import test from 'node:test';
import assert from 'node:assert/strict';
import calendarService from '../services/calendarService.js';

test('timed Outlook events are returned as UTC', () => {
  const e = calendarService.transformOutlookEvent({
    id: '1', subject: 'Standup', start: { dateTime: '2026-11-14T09:00:00.0000000' }, end: { dateTime: '2026-11-14T09:30:00.0000000' },
    isAllDay: false, attendees: [{ emailAddress: { address: 'a@b.c', name: 'A' }, status: { response: 'none' } }]
  }, 'me@x.com');
  assert.equal(e.startTime, '2026-11-14T09:00:00.000Z');
  assert.equal(e.status, 'confirmed');
  assert.equal(e.attendees[0].responseStatus, 'needsAction');
});

test('all-day holiday events keep plain dates and are flagged', () => {
  const e = calendarService.transformOutlookEvent({
    id: '2', subject: 'Diwali', start: { dateTime: '2026-11-08T00:00:00.0000000' }, end: { dateTime: '2026-11-09T00:00:00.0000000' }, isAllDay: true
  }, 'me@x.com', { calendarName: 'India holidays', isHoliday: true });
  assert.equal(e.startTime, '2026-11-08');
  assert.equal(e.endTime, '2026-11-09');
  assert.equal(e.isHoliday, true);
});

test('cancelled and tentative status mapping', () => {
  const base = { id: '3', subject: 'x', start: { dateTime: '2026-11-14T09:00:00' }, end: { dateTime: '2026-11-14T10:00:00' } };
  assert.equal(calendarService.transformOutlookEvent({ ...base, isCancelled: true }, 'e').status, 'cancelled');
  assert.equal(calendarService.transformOutlookEvent({ ...base, showAs: 'tentative' }, 'e').status, 'tentative');
});

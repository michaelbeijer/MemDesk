// The calendar's dates, views, items and request policy. Run in a time
// zone with summer time, so that the week the clocks change in is tested
// for real.

process.env.TZ = 'Europe/Amsterdam';

const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../src/lib/calendar-logic.js');

const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();

// ── Request policy ───────────────────────────────────────────────────

test('reads the calendar list, events, task lists and tasks; writes one event or task, its own fields only', () => {
  const ok = (s, p, m = 'GET', body) => cal.isAllowedRequest(s, m, p, body);
  assert.ok(ok('calendar', 'users/me/calendarList'));
  assert.ok(ok('calendar', `calendars/${encodeURIComponent('sam@example.com')}/events`));
  assert.ok(ok('calendar', `calendars/${encodeURIComponent('en.uk#holiday@group.v.calendar.google.com')}/events`));
  assert.ok(ok('tasks', 'users/@me/lists'));
  assert.ok(ok('tasks', 'lists/MDEyMzQ1Njc4OTAxMjM0NTY3ODk6MDow/tasks'));

  // Writes: one event or task, added, changed or deleted.
  const when = { start: { dateTime: '2026-10-05T14:30:00+02:00', timeZone: 'Europe/Amsterdam' }, end: { date: '2026-10-06', dateTime: null } };
  assert.ok(ok('calendar', 'calendars/primary/events', 'POST', { summary: 'Dentist', location: 'Town', ...when }));
  assert.ok(ok('calendar', 'calendars/primary/events/abc_20261005T090000Z', 'PATCH', { summary: 'Dentist' }));
  assert.ok(ok('calendar', 'calendars/primary/events/abc', 'DELETE'));
  assert.ok(ok('tasks', 'lists/abc/tasks', 'POST', { title: 'Pay', due: '2026-10-05T00:00:00.000Z' }));
  assert.ok(ok('tasks', 'lists/abc/tasks/t1', 'PATCH', { status: 'needsAction', completed: null }));
  assert.ok(ok('tasks', 'lists/abc/tasks/t1', 'DELETE'));

  // Nothing but those fields: no guests (who would get invitations), no
  // reminders; repeat rules only as Google's own kinds of line; no body
  // where none belongs.
  assert.ok(!ok('calendar', 'calendars/primary/events', 'POST', { summary: 'x', attendees: [{ email: 'a@b.c' }] }), 'no guests');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PATCH', { reminders: { useDefault: false } }), 'no reminders');
  assert.ok(ok('calendar', 'calendars/primary/events/abc', 'PATCH', { recurrence: ['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20261014'] }));
  assert.ok(ok('calendar', 'calendars/primary/events/abc', 'PATCH', { recurrence: [] }), 'no longer repeating');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PATCH', { recurrence: 'RRULE:FREQ=DAILY' }), 'a list of lines');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PATCH', { recurrence: ['X-THING:1'] }), 'only rule lines');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PATCH', { recurrence: ['RRULE:FREQ=DAILY' + String.fromCharCode(10) + 'ATTENDEE:a@b.c'] }), 'one line each');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PATCH', { start: { dateTime: 'x', foo: 1 } }));
  assert.ok(!ok('calendar', 'calendars/primary/events', 'POST'), 'a body is needed');
  assert.ok(!ok('calendar', 'calendars/primary/events', 'POST', ['summary']));
  assert.ok(!ok('tasks', 'lists/abc/tasks/t1', 'PATCH', { title: 'x', parent: 'y' }));
  assert.ok(!ok('tasks', 'lists/abc/tasks/t1', 'DELETE', { title: 'x' }));

  assert.ok(!ok('calendar', 'users/me/calendarList', 'POST', {}), 'no new calendars');
  assert.ok(!ok('calendar', 'calendars/primary', 'DELETE'), 'never a calendar');
  assert.ok(!ok('calendar', 'calendars/primary/events', 'DELETE'), 'never every event');
  assert.ok(!ok('tasks', 'lists/abc', 'DELETE'), 'never a list');
  assert.ok(!ok('tasks', 'lists/abc/tasks', 'PATCH', { title: 'x' }));
  assert.ok(!ok('calendar', 'calendars/primary/events/abc', 'PUT', { summary: 'x' }), 'no replacing wholesale');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc/move', 'POST', { summary: 'x' }));
  assert.ok(!ok('calendar', 'calendars/primary/acl'), 'not sharing settings');
  assert.ok(!ok('calendar', 'calendars/primary/acl', 'POST', {}));
  assert.ok(ok('calendar', 'calendars/primary/events/abc'), 'one event read on its own: a series, for its rule');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc/instances'), 'nothing under it');
  assert.ok(!ok('calendar', 'users/me/settings'));
  assert.ok(!ok('tasks', 'lists/abc/tasks/clear'));
  assert.ok(!ok('gmail', 'profile'), 'not another service');
  assert.ok(!ok('toString', 'users/me/calendarList'));
  assert.ok(!ok('calendar', 'calendars/a/b/events'), 'one segment only');
  assert.ok(!ok('calendar', 'calendars/../events'), 'no dot segments');
  assert.ok(!ok('calendar', 'calendars/%2e%2E/events'), 'not even encoded');
  assert.ok(!ok('calendar', 'calendars/a%2Fb/events'), 'no encoded slash');
  assert.ok(!ok('calendar', 'calendars/sam@example.com/events'), 'ids arrive encoded');
});

test('builds URLs on the right host, with repeated values', () => {
  assert.equal(cal.buildUrl('calendar', 'users/me/calendarList', { maxResults: 250, empty: '', none: null }),
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250');
  assert.equal(cal.buildUrl('tasks', 'users/@me/lists', { a: ['x', 'y z'] }),
    'https://tasks.googleapis.com/tasks/v1/users/@me/lists?a=x&a=y%20z');
});

test('asks to read the calendar list, change events and tasks, and the address - nothing about calendars themselves', () => {
  assert.deepEqual(cal.SCOPES, [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
  ]);
  assert.ok(!cal.SCOPES.includes('https://www.googleapis.com/auth/calendar'), 'not the whole of Calendar (sharing, calendars)');
});

// ── Dates ────────────────────────────────────────────────────────────

test('day keys are local dates', () => {
  assert.equal(cal.dateKey(new Date(2026, 9, 2, 23, 59)), '2026-10-02');
  assert.equal(cal.dateKey(new Date(2026, 9, 3, 0, 0)), '2026-10-03');
  assert.equal(cal.addDays('2026-10-02', 3), '2026-10-05');
  assert.equal(cal.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(cal.addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(cal.addDays('2026-12-31', 1), '2027-01-01');
  assert.ok(cal.isKey('2026-10-02'));
  assert.ok(!cal.isKey('2026-10-2'));
  assert.ok(!cal.isKey(undefined));
});

test('days are days across a clock change', () => {
  // Clocks go back on 25 October 2026 in Amsterdam: a 25-hour day.
  assert.equal(cal.addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(cal.daysBetween('2026-10-19', '2026-10-26'), 7);
  assert.equal(cal.daysBetween('2026-03-23', '2026-03-30'), 7);
  assert.deepEqual(cal.days('2026-10-24', '2026-10-27'), ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('weeks start on Monday and are numbered the ISO way', () => {
  assert.equal(cal.weekday('2026-09-28'), 0);
  assert.equal(cal.weekday('2026-10-04'), 6);
  assert.equal(cal.weekStart('2026-10-02'), '2026-09-28');
  assert.equal(cal.weekStart('2026-10-04'), '2026-09-28');
  assert.equal(cal.weekStart('2026-09-28'), '2026-09-28');
  assert.equal(cal.isoWeek('2026-10-02'), 40);
  assert.equal(cal.isoWeek('2026-01-01'), 1);   // a Thursday
  assert.equal(cal.isoWeek('2027-01-01'), 53);  // a Friday: still 2026's week 53
  assert.equal(cal.isoWeek('2026-12-28'), 53);
  assert.equal(cal.isoWeek('2025-12-29'), 1);   // Monday of 2026's week 1
  assert.equal(cal.isoWeek('2026-10-26'), 44);
});

test('months move by month, keeping the day where it fits', () => {
  assert.equal(cal.monthStart('2026-10-17'), '2026-10-01');
  assert.equal(cal.addMonths('2026-10-17', 1), '2026-11-17');
  assert.equal(cal.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(cal.addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(cal.addMonths('2026-01-15', -1), '2025-12-15');
});

// ── Views ────────────────────────────────────────────────────────────

test('each view knows its range and its step', () => {
  assert.deepEqual(cal.viewRange('week', '2026-10-02'), { start: '2026-09-28', end: '2026-10-05' });
  // October 2026 starts on a Thursday and ends on a Saturday: five weeks.
  assert.deepEqual(cal.viewRange('month', '2026-10-02'), { start: '2026-09-28', end: '2026-11-02' });
  // March 2026 starts on a Sunday: six weeks.
  assert.deepEqual(cal.viewRange('month', '2026-03-10'), { start: '2026-02-23', end: '2026-04-06' });
  assert.deepEqual(cal.viewRange('agenda', '2026-10-02'), { start: '2026-10-02', end: '2026-10-30' });

  assert.equal(cal.step('week', '2026-10-02', 1), '2026-10-09');
  assert.equal(cal.step('week', '2026-10-02', -1), '2026-09-25');
  assert.equal(cal.step('month', '2026-10-02', 1), '2026-11-02');
  assert.equal(cal.step('agenda', '2026-10-02', 1), '2026-10-30');
});

test('the small month is whole weeks', () => {
  const rows = cal.monthWeeks('2026-10-02');
  assert.equal(rows.length, 5);
  assert.ok(rows.every(r => r.length === 7));
  assert.equal(rows[0][0], '2026-09-28');
  assert.equal(rows[4][6], '2026-11-01');
});

test('titles say where you are', () => {
  assert.equal(cal.title('week', '2026-10-02', '2026-10-02'), 'Week 40 · 28 Sep – 4 Oct');
  assert.equal(cal.title('week', '2026-10-07', '2026-10-02'), 'Week 41 · 5 – 11 Oct');
  assert.equal(cal.title('week', '2027-01-01', '2026-10-02'), 'Week 53 · 28 Dec 2026 – 3 Jan 2027');
  assert.equal(cal.title('week', '2025-10-01', '2026-10-02'), 'Week 40 · 29 Sep – 5 Oct 2025');
  assert.equal(cal.title('month', '2026-10-02', '2026-10-02'), 'October 2026');
  assert.equal(cal.title('agenda', '2026-10-02', '2026-10-02'), '2 – 29 Oct');
  assert.equal(cal.spanText('2026-10-02', '2026-10-02', '2026-10-02'), '2 Oct');
  assert.equal(cal.dayName('2026-10-04'), 'Sun');
});

// ── Sources ──────────────────────────────────────────────────────────

test('calendars and task lists become sources, main calendar first', () => {
  const list = cal.sources([
    { id: 'jobs@group.calendar.google.com', summary: 'Jobs', backgroundColor: '#16A765', selected: true },
    { id: 'sam@example.com', summary: 'sam@example.com', backgroundColor: '#9fc6e7', primary: true, selected: true },
    { id: 'hidden@group', summary: 'Hidden', hidden: true },
    { id: 'jen@example.com', summary: 'Jen', summaryOverride: 'Jen’s calendar', backgroundColor: 'red' },
    { id: 'off@group', summary: 'Off', selected: false, backgroundColor: '#ffad46' },
  ], [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: '' }, { title: 'no id' }]);

  assert.deepEqual(list.map(s => [s.kind, s.name, s.colour, s.on]), [
    ['calendar', 'sam', '#9fc6e7', true],
    ['calendar', 'Jobs', '#16a765', true],
    ['calendar', 'Jen’s calendar', '#1a73e8', true],
    ['calendar', 'Off', '#ffad46', false],
    ['tasks', 'My Tasks', undefined, true],
    ['tasks', 'Tasks', undefined, true],
  ]);
});

test('a switch flicked here wins over Google’s default', () => {
  const s = { id: 'x', on: false };
  assert.equal(cal.isOn(s, {}), false);
  assert.equal(cal.isOn(s, { x: true }), true);
  assert.equal(cal.isOn({ id: 'y', on: true }, { y: false }), false);
  assert.equal(cal.isOn({ id: 'y', on: true }, null), true);
  assert.equal(cal.isOn({ id: 'toString', on: true }, {}), true);
});

// ── Requests ─────────────────────────────────────────────────────────

test('one call per calendar and two per task list, all allowed', () => {
  const reqs = cal.rangeRequests({ start: '2026-09-28', end: '2026-10-05' },
    [{ id: 'sam@example.com' }, { id: 'en.uk#holiday@group.v.calendar.google.com' }], [{ id: 'L1' }]);
  assert.equal(reqs.length, 4);
  for (const [service, path] of reqs.concat(cal.sourceRequests())) assert.ok(cal.isAllowedRequest(service, 'GET', path), path);

  const [, path, q] = reqs[0];
  assert.equal(path, 'calendars/sam%40example.com/events');
  assert.equal(q.timeMin, new Date(2026, 8, 27).toISOString());
  assert.equal(q.timeMax, new Date(2026, 9, 6).toISOString());
  assert.equal(q.singleEvents, 'true');

  const open = reqs[2][2];
  const done = reqs[3][2];
  assert.equal(open.showCompleted, 'false');
  assert.equal(done.showHidden, 'true');
  assert.equal(done.dueMin, '2026-09-27T00:00:00.000Z');
  assert.equal(done.dueMax, '2026-10-06T00:00:00.000Z');
});

// ── Items ────────────────────────────────────────────────────────────

const CAL = { id: 'sam@example.com', colour: '#9fc6e7', name: 'sam' };
const LIST = { id: 'L1', name: 'My Tasks' };

test('a timed event covers its days, ending at midnight on the last', () => {
  const ev = cal.eventItem({
    id: 'e1', summary: ' Kestrel call ', htmlLink: 'https://www.google.com/calendar/event?eid=abc',
    start: { dateTime: local(2026, 9, 29, 9, 30) }, end: { dateTime: local(2026, 9, 29, 10, 0) },
  }, CAL);
  assert.equal(ev.title, 'Kestrel call');
  assert.equal(ev.first, '2026-09-29');
  assert.equal(ev.last, '2026-09-29');
  assert.equal(ev.allDay, false);
  assert.equal(ev.colour, '#9fc6e7');
  assert.equal(ev.id, 'sam@example.com|e1');

  const late = cal.eventItem({ id: 'e2', start: { dateTime: local(2026, 10, 1, 22) }, end: { dateTime: local(2026, 10, 2, 0) } }, CAL);
  assert.equal(late.last, '2026-10-01', 'ends at midnight: not on the next day');
  assert.equal(late.title, '(No title)');

  const over = cal.eventItem({ id: 'e3', start: { dateTime: local(2026, 10, 1, 22) }, end: { dateTime: local(2026, 10, 3, 2) } }, CAL);
  assert.equal(over.last, '2026-10-03');
});

test('an all-day event ends the day before its end date', () => {
  const one = cal.eventItem({ id: 'b', summary: 'Jen’s birthday', start: { date: '2026-10-04' }, end: { date: '2026-10-05' } }, CAL);
  assert.deepEqual([one.first, one.last, one.allDay], ['2026-10-04', '2026-10-04', true]);
  const trip = cal.eventItem({ id: 't', start: { date: '2026-09-30' }, end: { date: '2026-10-03' } }, CAL);
  assert.deepEqual([trip.first, trip.last], ['2026-09-30', '2026-10-02']);
  const odd = cal.eventItem({ id: 'o', start: { date: '2026-09-30' } }, CAL);
  assert.deepEqual([odd.first, odd.last], ['2026-09-30', '2026-09-30']);
});

test('cancelled events, working locations and nonsense are left out', () => {
  assert.equal(cal.eventItem({ id: 'c', status: 'cancelled', start: { date: '2026-10-01' } }, CAL), null);
  assert.equal(cal.eventItem({ id: 'w', eventType: 'workingLocation', start: { date: '2026-10-01' } }, CAL), null);
  assert.equal(cal.eventItem({ id: 'n', start: {} }, CAL), null);
  assert.equal(cal.eventItem({ id: 'n', start: { dateTime: 'soon' } }, CAL), null);
  assert.equal(cal.eventItem(null, CAL), null);
});

test('event colours and links are only ever safe values', () => {
  const tinted = cal.eventItem({ id: 'x', colorId: '11', start: { date: '2026-10-01' } }, CAL);
  assert.equal(tinted.colour, '#d50000');
  const bad = cal.eventItem({ id: 'y', htmlLink: 'javascript:alert(1)', start: { date: '2026-10-01' } }, CAL);
  assert.equal(bad.link, '');
  assert.equal(cal.safeColour('#ABCDEF'), '#abcdef');
  assert.equal(cal.safeColour('#abc; background:url(x)'), '');
  assert.equal(cal.safeLink('https://tasks.google.com/task/abc'), 'https://tasks.google.com/task/abc');
  assert.equal(cal.safeLink('http://example.com'), '');
});

test('a task keeps the date Google wrote, whatever the time zone', () => {
  const t = cal.taskItem({ id: 't1', title: 'Send invoice', due: '2026-09-28T00:00:00.000Z', status: 'needsAction' }, LIST);
  assert.equal(t.due, '2026-09-28');
  assert.equal(t.done, false);
  assert.equal(t.list, 'My Tasks');
  const done = cal.taskItem({ id: 't2', title: 'Proofread', status: 'completed', due: '2026-10-02T00:00:00.000Z' }, LIST);
  assert.equal(done.done, true);
  const undated = cal.taskItem({ id: 't3', title: 'Order toner' }, LIST);
  assert.equal(undated.due, '');
});

test('a task made from an email links to the email', () => {
  const t = cal.taskItem({
    id: 't1', title: 'Reply to Ingrid', webViewLink: 'https://tasks.google.com/task/t1',
    links: [{ type: 'email', description: 'Quote', link: 'https://mail.google.com/mail/#all/18f2a' }],
  }, LIST);
  assert.equal(t.email, true);
  assert.equal(t.link, 'https://mail.google.com/mail/#all/18f2a');
  const plain = cal.taskItem({ id: 't2', title: 'x', webViewLink: 'https://tasks.google.com/task/t2' }, LIST);
  assert.equal(plain.email, false);
  assert.equal(plain.link, 'https://tasks.google.com/task/t2');
  const odd = cal.taskItem({ id: 't3', title: 'x', links: [{ type: 'email', link: 'https://evil.example/' }] }, LIST);
  assert.equal(odd.email, false);
});

test('deleted and empty tasks are left out', () => {
  assert.equal(cal.taskItem({ id: 'd', title: 'x', deleted: true }, LIST), null);
  assert.equal(cal.taskItem({ id: 'e', title: '  ' }, LIST), null);
  assert.equal(cal.taskItem({ title: 'no id' }, LIST), null);
});

test('each day lists all-day events, then by time, then open and done tasks', () => {
  const items = [
    cal.taskItem({ id: 'done', title: 'Proofread', status: 'completed', due: '2026-10-02T00:00:00.000Z' }, LIST),
    cal.eventItem({ id: 'late', summary: 'Sangha', start: { dateTime: local(2026, 10, 2, 19, 30) }, end: { dateTime: local(2026, 10, 2, 21) } }, CAL),
    cal.taskItem({ id: 'open', title: 'Quote for Ingrid', due: '2026-10-02T00:00:00.000Z' }, LIST),
    cal.eventItem({ id: 'early', summary: 'Lumenra', start: { dateTime: local(2026, 10, 2, 14) }, end: { dateTime: local(2026, 10, 2, 15) } }, CAL),
    cal.eventItem({ id: 'trip', summary: 'Trip', start: { date: '2026-09-30' }, end: { date: '2026-10-04' } }, CAL),
    cal.eventItem({ id: 'night', summary: 'Night shift', start: { dateTime: local(2026, 10, 1, 22) }, end: { dateTime: local(2026, 10, 2, 6) } }, CAL),
    cal.taskItem({ id: 'out', title: 'Other week', due: '2026-10-09T00:00:00.000Z' }, LIST),
  ];
  const map = cal.byDay(items, cal.days('2026-09-28', '2026-10-05'));
  assert.deepEqual(map.get('2026-10-02').map(e => e.item.title + (e.cont ? ' …' : '')),
    ['Trip …', 'Night shift …', 'Lumenra', 'Sangha', 'Quote for Ingrid', 'Proofread']);
  assert.deepEqual(map.get('2026-09-30').map(e => [e.item.title, e.cont]), [['Trip', false]]);
  assert.deepEqual(map.get('2026-10-04').map(e => e.item.title), []);
  assert.equal([...map.values()].flat().filter(e => e.item.title === 'Other week').length, 0);
});

test('an event that started before the range shows from its first day', () => {
  const long = cal.eventItem({ id: 'l', summary: 'Conference', start: { date: '2026-09-20' }, end: { date: '2026-09-30' } }, CAL);
  const map = cal.byDay([long], cal.days('2026-09-28', '2026-10-05'));
  assert.deepEqual(map.get('2026-09-28').map(e => e.cont), [true]);
  assert.deepEqual(map.get('2026-09-29').map(e => e.cont), [true]);
  assert.deepEqual(map.get('2026-09-30'), []);
});

test('the tray holds open tasks with no date, and overdue ones', () => {
  const items = cal.uniqueById([
    cal.taskItem({ id: 'a', title: 'Renew the guild membership' }, LIST),
    cal.taskItem({ id: 'b', title: 'Late', due: '2026-09-20T00:00:00.000Z' }, LIST),
    cal.taskItem({ id: 'b', title: 'Late', due: '2026-09-20T00:00:00.000Z' }, LIST),
    cal.taskItem({ id: 'c', title: 'Earlier', due: '2026-09-01T00:00:00.000Z' }, LIST),
    cal.taskItem({ id: 'd', title: 'Done long ago', status: 'completed', due: '2026-09-01T00:00:00.000Z' }, LIST),
    cal.taskItem({ id: 'e', title: 'Today', due: '2026-10-02T00:00:00.000Z' }, LIST),
  ]);
  const t = cal.tray(items, '2026-10-02');
  assert.deepEqual(t.overdue.map(x => x.title), ['Earlier', 'Late']);
  assert.deepEqual(t.undated.map(x => x.title), ['Renew the guild membership']);
});

// ── Changes ──────────────────────────────────────────────────────────

const OWN = { id: 'sam@example.com', colour: '#9fc6e7', name: 'sam', writable: true };

test('which events can be changed here: on a calendar that may be, ordinary ones, organised by you or open to guests', () => {
  const ev = extra => cal.eventItem(Object.assign({ id: 'e', etag: '"7"', summary: 'x', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }, extra), OWN);
  assert.equal(ev({}).editable, true);
  assert.equal(ev({}).etag, '"7"');
  assert.equal(ev({}).eventId, 'e');
  assert.equal(ev({ organizer: { self: true } }).editable, true);
  assert.equal(ev({ organizer: { self: false } }).editable, false, 'someone else’s meeting');
  assert.equal(ev({ organizer: { self: false }, guestsCanModify: true }).editable, true);
  assert.equal(ev({ eventType: 'birthday' }).editable, false);
  assert.equal(ev({ eventType: 'outOfOffice' }).editable, false);
  assert.equal(cal.eventItem({ id: 'e', summary: 'x', start: { date: '2026-10-05' } }, CAL).editable, false, 'a calendar that may not be changed');
  assert.equal(ev({ recurringEventId: 'base' }).recurring, true);
  const sources = cal.sources([
    { id: 'a', accessRole: 'owner' }, { id: 'b', accessRole: 'writer' }, { id: 'c', accessRole: 'reader' }, { id: 'd', accessRole: 'freeBusyReader' },
  ], [{ id: 'L1', title: 'My Tasks' }]);
  assert.deepEqual(sources.map(s => [s.id, s.writable]), [['a', true], ['b', true], ['c', false], ['d', false], ['L1', true]]);
  assert.equal(cal.taskItem({ id: 't', title: 'x' }, LIST).editable, true);
  assert.equal(cal.taskItem({ id: 't', title: 'x' }, LIST).taskId, 't');
});

test('typed into the add box: a time makes it an event, and comes out of the title', () => {
  const q = cal.parseQuick;
  assert.deepEqual(q('Dentist 14:30'), { title: 'Dentist', start: '14:30', end: '15:30' });
  assert.deepEqual(q('Call Sam at 9.15-10:00'), { title: 'Call Sam', start: '09:15', end: '10:00' });
  assert.deepEqual(q('14:00 – 15:45 Planning'), { title: 'Planning', start: '14:00', end: '15:45' });
  assert.deepEqual(q('Lunch 12:00, Bram'), { title: 'Lunch, Bram', start: '12:00', end: '13:00' });
  assert.deepEqual(q('Late 23:30'), { title: 'Late', start: '23:30', end: '23:59' }, 'not past midnight');
  assert.deepEqual(q('Pay the invoice'), { title: 'Pay the invoice', start: '', end: '' });
  assert.deepEqual(q('Flight 25:00'), { title: 'Flight 25:00', start: '', end: '' }, 'not a time');
  assert.deepEqual(q('Back 10:00-9:00'), { title: 'Back', start: '10:00', end: '11:00' }, 'an end before the start is not believed');
  assert.equal(cal.normTime('9:5'), '');
  assert.equal(cal.normTime(' 7.05 '), '07:05');
});

test('an event for Google: local times with the day’s offset, all-day as dates, and what was wrong', () => {
  const tz = 'Europe/Amsterdam';
  const d = { title: ' Dentist ', day: '2026-10-05', endDay: '2026-10-05', start: '14:30', end: '15:30', where: '' };
  assert.deepEqual(cal.eventBody(d, tz).body, {
    summary: 'Dentist',
    start: { dateTime: '2026-10-05T14:30:00+02:00', timeZone: tz },
    end: { dateTime: '2026-10-05T15:30:00+02:00', timeZone: tz },
  });
  assert.equal(cal.eventBody(Object.assign({}, d, { day: '2026-11-05', endDay: '2026-11-05' }), tz).body.start.dateTime,
    '2026-11-05T14:30:00+01:00', 'winter time');
  // A change clears what no longer applies.
  const patch = cal.eventBody(Object.assign({}, d, { where: '' }), tz, { patch: true }).body;
  assert.equal(patch.location, '');
  assert.equal(patch.start.date, null);
  const allDay = cal.eventBody({ title: 'Trip', allDay: true, day: '2026-10-05', endDay: '2026-10-07' }, tz, { patch: true }).body;
  assert.deepEqual([allDay.start, allDay.end], [{ date: '2026-10-05', dateTime: null }, { date: '2026-10-08', dateTime: null }], 'the end date is the day after');
  assert.equal(cal.eventBody(Object.assign({}, d, { start: '15:30', end: '15:00' }), tz).error, 'It has to end after it starts.');
  assert.match(cal.eventBody(Object.assign({}, d, { start: 'noon' }), tz).error, /start time/);
  assert.equal(cal.eventBody(Object.assign({}, d, { title: ' ' }), tz).error, 'Give it a title.');
  assert.equal(cal.eventBody(Object.assign({}, d, { endDay: '2026-10-06', end: '09:00' }), tz).body.end.dateTime, '2026-10-06T09:00:00+02:00', 'over midnight');
  for (const body of [cal.eventBody(d, tz).body, patch, allDay]) assert.ok(cal.isAllowedRequest('calendar', 'PATCH', 'calendars/a/events/b', body));
});

test('a task for Google, ticked or not, with a day or none', () => {
  assert.deepEqual(cal.taskBody({ title: 'Pay', day: '2026-10-05' }).body, { title: 'Pay', due: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual(cal.taskBody({ title: 'Pay', day: '' }).body, { title: 'Pay' });
  assert.deepEqual(cal.taskBody({ title: 'Pay', day: '', done: true }, { patch: true }).body, { title: 'Pay', due: null, status: 'completed' });
  assert.deepEqual(cal.tickBody(false), { status: 'needsAction', completed: null });
  assert.equal(cal.taskBody({ title: '' }).error, 'Give it a title.');
  for (const body of [cal.taskBody({ title: 'Pay', day: '', done: false }, { patch: true }).body, cal.tickBody(true)]) {
    assert.ok(cal.isAllowedRequest('tasks', 'PATCH', 'lists/a/tasks/b', body));
  }
});

test('dragged to another day: an event keeps its times across a clock change, a task gets the day or none', () => {
  const tz = 'Europe/Amsterdam';
  const timed = cal.eventItem({ id: 'e', summary: 'Call', start: { dateTime: local(2026, 10, 23, 22, 0) }, end: { dateTime: local(2026, 10, 23, 23, 0) } }, OWN);
  assert.deepEqual(cal.moveBody(timed, '2026-10-23', '2026-10-26', tz), {
    start: { dateTime: '2026-10-26T22:00:00+01:00', timeZone: tz }, end: { dateTime: '2026-10-26T23:00:00+01:00', timeZone: tz },
  });
  const moved = cal.movedItem(timed, '2026-10-23', '2026-10-26');
  assert.equal(moved.first, '2026-10-26');
  assert.equal(new Date(moved.start).getHours(), 22, 'still at ten, though the clocks went back');
  const trip = cal.eventItem({ id: 't', summary: 'Trip', start: { date: '2026-10-05' }, end: { date: '2026-10-08' } }, OWN);
  // Dragged by its second day onto the Thursday: two days on.
  assert.deepEqual(cal.moveBody(trip, '2026-10-06', '2026-10-08', tz), { start: { date: '2026-10-07' }, end: { date: '2026-10-10' } });
  const task = cal.taskItem({ id: 'k', title: 'Pay', due: '2026-10-05T00:00:00.000Z' }, LIST);
  assert.deepEqual(cal.moveBody(task, '2026-10-05', '2026-10-09', tz), { due: '2026-10-09T00:00:00.000Z' });
  assert.deepEqual(cal.moveBody(task, '2026-10-05', '', tz), { due: null }, 'onto No date');
  assert.equal(cal.movedItem(task, '2026-10-05', '').due, '');
});

test('the editor starts from an item, or empty on a day', () => {
  const timed = cal.eventItem({ id: 'e', summary: 'Call', location: 'Meet', start: { dateTime: local(2026, 10, 5, 9, 30) }, end: { dateTime: local(2026, 10, 6, 0, 0) } }, OWN);
  assert.deepEqual(cal.draftOf(timed), { kind: 'event', title: 'Call', source: OWN.id, where: 'Meet', allDay: false, day: '2026-10-05', endDay: '2026-10-06', start: '09:30', end: '00:00' });
  const trip = cal.eventItem({ id: 't', start: { date: '2026-10-05' }, end: { date: '2026-10-08' } }, OWN);
  assert.deepEqual(cal.draftOf(trip), { kind: 'event', title: '', source: OWN.id, where: '', allDay: true, day: '2026-10-05', endDay: '2026-10-07', start: '', end: '' });
  assert.deepEqual(cal.draftOf(cal.taskItem({ id: 'k', title: 'Pay', status: 'completed' }, LIST)), { kind: 'task', title: 'Pay', source: 'L1', day: '', done: true });
  assert.equal(cal.newDraft('event', '2026-10-05', OWN.id).start, '09:00');
  assert.deepEqual(cal.newDraft('task', '2026-10-05', 'L1'), { kind: 'task', title: '', source: 'L1', day: '2026-10-05', done: false });
  assert.equal(cal.eventPath({ source: 'sam@example.com', eventId: 'a_20261005T090000Z' }), 'calendars/sam%40example.com/events/a_20261005T090000Z');
  assert.equal(cal.taskPath({ source: 'L1', taskId: 'k' }), 'lists/L1/tasks/k');
});

// ── Repeating ────────────────────────────────────────────────────────

test('Google’s repeat menu, for the day the event starts', () => {
  // Wednesday 7 October 2026, the first Wednesday of its month.
  assert.deepEqual(cal.repeatChoices('2026-10-07').map(c => [c.id, c.label, c.rule]), [
    ['none', 'Does not repeat', ''],
    ['daily', 'Daily', 'RRULE:FREQ=DAILY'],
    ['weekly', 'Weekly on Wednesday', 'RRULE:FREQ=WEEKLY;BYDAY=WE'],
    ['monthly', 'Monthly on the first Wednesday', 'RRULE:FREQ=MONTHLY;BYDAY=1WE'],
    ['yearly', 'Annually on 7 October', 'RRULE:FREQ=YEARLY'],
    ['weekdays', 'Every weekday (Monday to Friday)', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ]);
  assert.equal(cal.repeatChoices('2026-10-28')[3].label, 'Monthly on the fourth Wednesday');
  assert.equal(cal.repeatChoices('2026-10-29')[3].rule, 'RRULE:FREQ=MONTHLY;BYDAY=-1TH', 'a fifth Thursday is the last');
  assert.equal(cal.repeatChoices('2026-10-29')[3].label, 'Monthly on the last Thursday');
});

test('a rule from Google: one of the menu’s, a custom one, or one kept as it is', () => {
  const day = '2026-10-07';
  assert.deepEqual(cal.repeatOf([], day), { id: 'none', rule: '' });
  assert.equal(cal.repeatOf(['RRULE:FREQ=WEEKLY;BYDAY=WE'], day).id, 'weekly');
  assert.equal(cal.repeatOf(['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=WE'], day).id, 'weekly', 'the week’s first day does not matter');
  assert.equal(cal.repeatOf(['EXDATE;VALUE=DATE:20261014', 'RRULE:FREQ=WEEKLY;BYDAY=TH,TU,MO,FR,WE'], day).id, 'weekdays');
  assert.equal(cal.repeatOf(['RRULE:FREQ=MONTHLY;BYDAY=1WE'], day).id, 'monthly');

  const two = cal.repeatOf(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10'], day);
  assert.equal(two.id, 'custom');
  assert.deepEqual(two.custom, { every: 2, unit: 'week', days: ['MO', 'TH'], monthBy: 'date', ends: 'after', until: '2027-01-07', count: 10 });
  assert.equal(cal.describeRepeat(two, day), 'Every 2 weeks on Monday and Thursday, 10 times');
  const until = cal.repeatOf(['RRULE:FREQ=DAILY;UNTIL=20261201T225959Z'], day);
  assert.equal(cal.describeRepeat(until, day), 'Daily, until 1 Dec 2026');
  assert.equal(cal.repeatOf(['RRULE:FREQ=MONTHLY;BYMONTHDAY=7'], day).custom.monthBy, 'date');

  // More than the editor can hold: kept, and said so.
  for (const rule of ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU', 'RRULE:FREQ=YEARLY;BYMONTH=3', 'RRULE:FREQ=HOURLY', 'RRULE:FREQ=WEEKLY;BYDAY=1MO']) {
    const r = cal.repeatOf([rule], day);
    assert.deepEqual([r.id, r.rule], ['other', rule], rule);
    assert.equal(cal.describeRepeat(r, day), 'Repeats as set in Google Calendar');
    assert.equal(cal.ruleFor(r, day, false), rule, 'and sent back unchanged');
  }
});

test('the rule sent for what the editor holds, worked out for the day it starts', () => {
  assert.equal(cal.ruleFor({ id: 'none' }, '2026-10-07'), '');
  assert.equal(cal.ruleFor({ id: 'weekly' }, '2026-10-08'), 'RRULE:FREQ=WEEKLY;BYDAY=TH', 'moved to a Thursday: weekly on Thursday');
  const custom = { every: 3, unit: 'month', days: [], monthBy: 'weekday', ends: 'on', until: '2027-06-30', count: 5 };
  assert.equal(cal.ruleFor({ id: 'custom', custom }, '2026-10-07', false), 'RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=1WE;UNTIL=20270630T235959Z');
  assert.equal(cal.ruleFor({ id: 'custom', custom }, '2026-10-07', true), 'RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=1WE;UNTIL=20270630', 'all day: a date');
  assert.equal(cal.customRule({ every: 1, unit: 'week', days: [], ends: 'after', count: 0 }, '2026-10-07', false),
    'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=1', 'no day ticked: the day it starts; at least once');
  assert.equal(cal.customRule({ every: 0, unit: 'day', ends: 'never' }, '2026-10-07', false), 'RRULE:FREQ=DAILY');
  // Every rule the editor makes is one the policy lets through.
  for (const rule of [cal.ruleFor({ id: 'custom', custom }, '2026-10-07', false), ...cal.repeatChoices('2026-10-29').map(c => c.rule).filter(Boolean)]) {
    assert.ok(cal.isAllowedRequest('calendar', 'PATCH', 'calendars/a/events/b', { recurrence: [rule] }), rule);
    assert.ok(cal.parseRule(rule), `and one it can read back: ${rule}`);
  }
});

test('a new rule keeps the dates Google added or left out; no rule, no lines', () => {
  const lines = ['RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=Europe/Amsterdam:20261014T090000', 'RDATE;VALUE=DATE:20261016'];
  assert.deepEqual(cal.recurrenceWith(lines, 'RRULE:FREQ=DAILY'), ['RRULE:FREQ=DAILY', lines[1], lines[2]]);
  assert.deepEqual(cal.recurrenceWith(lines, ''), []);
  assert.deepEqual(cal.recurrenceWith(undefined, 'RRULE:FREQ=DAILY'), ['RRULE:FREQ=DAILY']);
  const body = cal.eventBody({ title: 'Stand-up', day: '2026-10-07', endDay: '2026-10-07', start: '09:00', end: '09:15' }, 'Europe/Amsterdam',
    { recurrence: cal.recurrenceWith(lines, 'RRULE:FREQ=DAILY') }).body;
  assert.equal(body.recurrence.length, 3);
  assert.equal(body.start.timeZone, 'Europe/Amsterdam', 'a repeating event needs its time zone, and has it');
  assert.equal('recurrence' in cal.eventBody({ title: 'x', day: '2026-10-07', start: '09:00', end: '10:00' }, '').body, false, 'not sent unless given');
});

test('a change made on one occurrence, for the whole series: from its first day, moved as far', () => {
  const draft = { kind: 'event', title: 'Stand-up', day: '2026-10-22', endDay: '2026-10-22', start: '09:30', end: '09:45', allDay: false };
  // Series from Wednesday 7 October; the occurrence on the 21st, moved to the 22nd.
  assert.deepEqual(cal.seriesDraft('2026-10-07', '2026-10-21', draft), Object.assign({}, draft, { day: '2026-10-08', endDay: '2026-10-08' }));
  const trip = Object.assign({}, draft, { allDay: true, day: '2026-10-21', endDay: '2026-10-23' });
  assert.deepEqual([cal.seriesDraft('2026-10-07', '2026-10-21', trip).day, cal.seriesDraft('2026-10-07', '2026-10-21', trip).endDay], ['2026-10-07', '2026-10-09']);
  assert.equal(cal.startDayOf({ start: { date: '2026-10-07' } }), '2026-10-07');
  assert.equal(cal.startDayOf({ start: { dateTime: local(2026, 10, 7, 9, 0) } }), '2026-10-07');
  const occurrence = cal.eventItem({ id: 'abc_20261021T070000Z', recurringEventId: 'abc', summary: 'Stand-up', start: { dateTime: local(2026, 10, 21, 9) }, end: { dateTime: local(2026, 10, 21, 9, 15) } }, OWN);
  assert.equal(occurrence.seriesId, 'abc');
  assert.equal(occurrence.recurring, true);
});

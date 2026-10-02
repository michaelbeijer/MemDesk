// The calendar's dates, views, items and request policy. Run in a time
// zone with summer time, so that the week the clocks change in is tested
// for real.

process.env.TZ = 'Europe/Amsterdam';

const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../src/lib/calendar-logic.js');

const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();

// ── Request policy ───────────────────────────────────────────────────

test('only reads the calendar list, events, task lists and tasks', () => {
  const ok = (s, p, m = 'GET') => cal.isAllowedRequest(s, m, p);
  assert.ok(ok('calendar', 'users/me/calendarList'));
  assert.ok(ok('calendar', `calendars/${encodeURIComponent('sam@example.com')}/events`));
  assert.ok(ok('calendar', `calendars/${encodeURIComponent('en.uk#holiday@group.v.calendar.google.com')}/events`));
  assert.ok(ok('tasks', 'users/@me/lists'));
  assert.ok(ok('tasks', 'lists/MDEyMzQ1Njc4OTAxMjM0NTY3ODk6MDow/tasks'));

  assert.ok(!ok('calendar', 'users/me/calendarList', 'POST'), 'no writes');
  assert.ok(!ok('calendar', 'calendars/primary/events', 'DELETE'));
  assert.ok(!ok('tasks', 'lists/abc/tasks', 'PATCH'));
  assert.ok(!ok('calendar', 'calendars/primary/acl'), 'not sharing settings');
  assert.ok(!ok('calendar', 'calendars/primary/events/abc'));
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

test('asks for read-only calendar and tasks access, and the address', () => {
  assert.deepEqual(cal.SCOPES, [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
  ]);
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

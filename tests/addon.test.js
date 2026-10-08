// The phone panel and the phone app's server side, end to end:
// addon/Code.gs as Apps Script would run it, against the fake Gmail the
// browser preview uses, driven like a phone.
// See tests/helpers/apps-script.js for what is checked along the way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Phone, loadAddon, plain } = require('./helpers/apps-script.js');

const live = (p, noteId) => plain(p.fake.box.notesWithId(noteId)).filter(n => !n.labels.includes('TRASH'));
const idOf = (p, noteId) => live(p, noteId)[0].id;
const html = (p, id) => p.fake.box.messageHtml(id);
const inserts = p => p.writes().filter(w => w.method === 'POST' && w.path === 'messages');
// The first message of the seeded thread whose subject contains `part`.
const mailAbout = (p, part) => {
  const threadId = p.fake.box.findThread(part);
  return { threadId, messageId: p.fake.box.thread(threadId).messages[0].id };
};
const threadLabels = (p, threadId) => plain(p.fake.box.threadLabelNames(threadId));

// ── The bundle ───────────────────────────────────────────────────────

test('Code.gs is built from the current sources', async () => {
  const { bundle } = await import('../tools/build-addon.mjs');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'addon', 'Code.gs'), 'utf8'), bundle(),
    'run node tools/build-addon.mjs');
});

test('the manifest names functions the bundle has, and asks for no more than it uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'addon', 'appsscript.json'), 'utf8'));
  const { addon } = loadAddon(new Phone().fake);
  const named = [
    manifest.addOns.common.homepageTrigger.runFunction,
    ...manifest.addOns.gmail.contextualTriggers.map(t => t.onTriggerFunction),
  ];
  for (const fn of named) assert.equal(typeof addon[fn], 'function', fn);
  assert.equal(manifest.addOns.common.universalActions, undefined, "nothing of the panel's on Gmail's add-on menu");
  assert.deepEqual(manifest.oauthScopes.sort(), [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.addons.current.message.metadata',
    'https://www.googleapis.com/auth/gmail.addons.execute',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/tasks',
  ]);
  assert.deepEqual(manifest.urlFetchWhitelist, [
    'https://gmail.googleapis.com/', 'https://www.googleapis.com/calendar/', 'https://tasks.googleapis.com/',
    // The licence, and only Lemon Squeezy's licence API.
    'https://api.lemonsqueezy.com/v1/licenses/',
  ]);
  // The advanced services are what switch the APIs on in the script's own
  // Cloud project; the calls themselves go through UrlFetchApp.
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices.map(s => s.serviceId).sort(), ['calendar', 'gmail', 'tasks']);
  // Settings that make Gmail demand a scope of their own. useLocaleFromApp
  // needs script.locale, and without it Gmail refuses to run the add-on
  // at all ("Run time error ... Required permissions: script.locale").
  const needs = { useLocaleFromApp: 'https://www.googleapis.com/auth/script.locale' };
  for (const [setting, scope] of Object.entries(needs)) {
    if (manifest.addOns.common[setting]) assert.ok(manifest.oauthScopes.includes(scope), `${setting} needs ${scope}`);
  }
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(typeof addon.btoa, 'function', 'the shims filled in what the runtime lacks');
  assert.equal(typeof addon.URL, 'function');
});

// ── The panel ────────────────────────────────────────────────────────

test('with no email open, the panel says to open one, and reads nothing', () => {
  const p = new Phone();
  p.openHome();
  assert.equal(p.card.name, 'home');
  assert.deepEqual(p.lines(), ['Open an email to put it on the board.']);
  assert.deepEqual(p.buttons(), []);
  assert.deepEqual(p.requests(), [], 'not even the labels');
});

test('an email on the board: its column, a button for each, and only the labels and its conversation read, in one round trip', () => {
  const p = new Phone();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  assert.equal(p.card.header.title, 'On the board: To do');
  assert.deepEqual(p.buttons(), ['[To do]', 'Doing', 'Waiting', 'Done', 'Take off the board']);
  assert.deepEqual(p.lines(), ['Done also archives it: out of the Inbox.']);
  assert.deepEqual(p.requests(), ['GET labels', `GET threads/${threadId}`]);
  assert.equal(p.log[1].query.format, 'minimal', 'labels only: no headers, no bodies');
  assert.equal(p.roundTrips(), 1, 'side by side');
});

test('one tap moves it: into that column only, out of the Inbox for Done, or off the board', () => {
  const p = new Phone();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  const before = p.log.length;
  p.press('Doing');
  assert.equal(p.toast, 'Moved to Doing.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board')), ['_Board/Doing']);
  assert.ok(threadLabels(p, threadId).includes('INBOX'));
  assert.deepEqual(p.requests().slice(before), ['GET labels', `POST threads/${threadId}/modify`], 'one change, on the whole conversation');
  assert.equal(p.card.header.title, 'On the board: Doing', 'the card says so at once');
  assert.deepEqual(p.buttons(), ['To do', '[Doing]', 'Waiting', 'Done', 'Take off the board']);

  p.press('Done');
  assert.equal(p.toast, 'Moved to Done and archived.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board') || n === 'INBOX'), ['_Board/Done']);

  p.press('Take off the board');
  assert.equal(p.toast, 'Taken off the board.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board') || n === 'INBOX'), [], 'off the board, and still archived');
  assert.equal(p.card.header.title, 'Not on the board');
  assert.deepEqual(p.buttons(), ['To do', 'Doing', 'Waiting', 'Done'], 'nothing to take off');

  p.openMessage(messageId);
  assert.equal(p.card.header.title, 'Not on the board', 'and that is what it shows next time');
});

test('an email not on the board can be put on it; one in two columns ends up in one', () => {
  const p = new Phone();
  const nda = mailAbout(p, '3,000-word NDA');
  p.openMessage(nda.messageId);
  assert.equal(p.card.header.title, 'Not on the board');
  assert.ok(!p.buttons().some(b => b.startsWith('[')), 'no column filled in');
  p.press('To do');
  assert.deepEqual(threadLabels(p, nda.threadId).filter(n => n.startsWith('_Board')), ['_Board/To do']);

  const drawing = mailAbout(p, 'Drawing labels');
  assert.deepEqual(threadLabels(p, drawing.threadId).filter(n => n.startsWith('_Board')), ['_Board/To do', '_Board/Waiting']);
  p.openMessage(drawing.messageId);
  assert.equal(p.card.header.title, 'On the board: To do', 'the first of its columns, as on the board');
  p.press('Waiting');
  assert.deepEqual(threadLabels(p, drawing.threadId).filter(n => n.startsWith('_Board')), ['_Board/Waiting']);
});

test('the column it is in can be pressed too: a Done email a reply brought back to the Inbox is archived again', () => {
  const p = new Phone();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  p.press('Done');
  p.fake.box.modify(threadId, { addLabelIds: ['INBOX'] });
  p.openMessage(messageId);
  assert.deepEqual(p.buttons(), ['To do', 'Doing', 'Waiting', '[Done]', 'Take off the board']);
  p.press('Done');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board') || n === 'INBOX'), ['_Board/Done']);
});

test('a note is an email like any other: the board, and nothing of the note read', () => {
  const p = new Phone();
  p.openMessage(idOf(p, 'launchchecklist0004'));
  assert.equal(p.card.header.title, 'Not on the board');
  assert.deepEqual(p.requests().map(r => r.split('/')[0]), ['GET labels', 'GET threads']);
});

test("Gmail's ids in decimal, or no conversation id: the same email, the same card", () => {
  const { threadId, messageId } = mailAbout(new Phone(), 'Quote request');
  const decimal = hex => BigInt(`0x${hex}`).toString();

  const p = new Phone();
  p.openMessage(`msg-f:${decimal(messageId)}`, { threadId: `thread-f:${decimal(threadId)}` });
  assert.equal(p.card.header.title, 'On the board: To do');
  assert.deepEqual(p.requests(), ['GET labels', `GET threads/${threadId}`]);

  const q = new Phone();
  q.openMessage(messageId, { threadId: '' });
  assert.equal(q.card.header.title, 'On the board: To do');
  assert.deepEqual(q.requests(), ['GET labels', `GET messages/${messageId}`, `GET threads/${threadId}`], 'the message says which conversation');
  assert.equal(q.roundTrips(), 2);

  const r = new Phone();
  r.openMessage(messageId, { threadId: 'thread-a:r-123' });
  assert.equal(r.card.header.title, 'On the board: To do', 'a conversation id the API does not take: the message says which');
  assert.match(r.logged.map(l => l[1]).join('\n'), /thread-a:r-123 could not be read/, 'and the log says so');
});

test('no board columns yet: the panel says how they are made, and makes nothing itself', () => {
  const p = new Phone({ search: '?fresh' });
  p.openMessage(p.fake.box.threadsInInbox()[0].messages[0].id);
  assert.equal(p.card.header.title, 'Not on the board');
  assert.deepEqual(p.buttons(), []);
  assert.match(p.lines()[0], /no columns yet/);
  assert.deepEqual(p.writes(), [], 'no labels made: not the board\'s, and not _Notes');
});

test('a failed move says so and changes nothing', () => {
  const p = new Phone({ search: '?fail=modify' });
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  p.press('Doing');
  assert.match(p.toast, /^Not done: Gmail answered 500/);
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board')), ['_Board/To do']);
  assert.equal(p.card.header.title, 'On the board: To do', 'the card as it was');
});

test('a column gone since the card was drawn changes nothing, rather than taking the email off the board', () => {
  const p = new Phone();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.openMessage(messageId);
  p.fake.route('PATCH', `labels/${plain(p.fake.box.labelByName('_Board/Doing')).id}`, null, { name: 'Elsewhere' });
  p.press('Doing');
  assert.equal(p.toast, 'Not done: That column is not on the board any more.');
  assert.deepEqual(threadLabels(p, threadId).filter(n => n.startsWith('_Board')), ['_Board/To do']);
  assert.deepEqual(p.writes(), []);
});

test('a trigger that fails shows what went wrong rather than nothing', () => {
  const p = new Phone();
  p.addon.ScriptApp.getOAuthToken = () => 'expired';
  p.openMessage(mailAbout(p, 'Quote request').messageId);
  assert.equal(p.card.name, 'error');
  assert.match(p.lines()[0], /permission/);
});

// ── The phone app's server side ──────────────────────────────────────

test('the app page: served by doGet, titled, sized for a phone, with the notes view inside', () => {
  const p = new Phone();
  const out = p.addon.doGet({}).output;
  assert.equal(out.title, 'MemDesk');
  assert.deepEqual(out.meta, [['viewport', 'width=device-width, initial-scale=1, viewport-fit=cover']]);
  assert.equal(out.favicon, 'https://raw.githubusercontent.com/michaelbeijer/MemDesk/main/icons/icon-192.png', 'our icon, not Apps Script\'s');
  assert.match(out.html, /^<!DOCTYPE html>/);
  // The modules are packed in base64url inside one loader script, in order,
  // each exactly its source file.
  const packed = JSON.parse(/var MODULES = (\[.*?\]);\n/.exec(out.html)[1]);
  const names = packed.map(m => m[0]);
  for (const f of ['src/content/notes.js', 'src/content/note-editor.js', 'addon/app/remote.js', 'addon/app/shell.js']) {
    const m = packed.find(x => x[0] === f);
    assert.ok(m, f);
    assert.equal(Buffer.from(m[1], 'base64url').toString('utf8'), fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), f);
    assert.match(m[1], /^[A-Za-z0-9_-]+$/, 'nothing but base64url');
  }
  assert.ok(names.indexOf('addon/app/remote.js') < names.indexOf('src/content/notes.js'), 'the store before the view');
  // Nothing a careless rewrite of the page could cut: no "//", "<!--" or
  // "</" anywhere in the scripts.
  for (const [, body] of out.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    for (const bad of ['//', '<!--', '</']) assert.ok(!body.includes(bad), `a script contains "${bad}"`);
  }
  assert.match(out.html, /<div id="boot"[^>]*>Loading/, 'something to see before the scripts run');
  const ping = p.addon.doGet({ parameter: { ping: '1' } }).output;
  assert.match(ping.html, new RegExp(`MemDesk ${require('../manifest.json').version}: the script runs, and its page is ${out.html.length} characters long`));
});

test('appList: every note once, newest first, with its folder; stale versions tidied; a search brings content', () => {
  const p = new Phone();
  const r = p.server('appList', '');
  assert.deepEqual(r.notes.map(n => n.title), [
    'Ideas for the October newsletter', 'Shopping list', 'Launch checklist', 'Kestrel glossary decisions', 'Rate schedule 2027 – draft',
  ]);
  assert.equal(r.label, '_Notes');
  assert.deepEqual(r.folders.map(f => f.path), ['Empty', 'Personal', 'Work', 'Work/Clients']);
  const byTitle = t => r.notes.find(n => n.title === t);
  assert.equal(r.folders.find(f => f.id === byTitle('Kestrel glossary decisions').folderId).path, 'Work/Clients');
  assert.equal(byTitle('Rate schedule 2027 – draft').folderId, '');
  assert.equal(byTitle('Shopping list').own, false);
  assert.deepEqual(r.docs, {});
  assert.equal(live(p, 'kestrelglossary0001').length, 1, 'the older live version went to Trash');
  assert.ok(!('parts' in r.notes[0]), 'no message parts sent to the page');

  const s = p.server('appList', 'kestrel');
  assert.deepEqual(s.notes.map(n => n.title), ['Launch checklist', 'Kestrel glossary decisions']);
  assert.deepEqual(Object.keys(s.docs).sort(), s.notes.map(n => n.messageId).sort());
  assert.match(JSON.stringify(s.docs), /Kestrel/);
});

test('the board in the app: Gmail only as the board uses it - reading, labelling, and nothing more', () => {
  const p = new Phone();
  const refused = (...args) => assert.throws(() => p.server('appBoardGmail', ...args), /not_allowed|never moved to Trash, Spam or the Inbox/, args.slice(0, 2).join(' '));
  const threadId = p.fake.box.findThread('Termbase export');

  // Reading: labels, a column's threads, one thread.
  assert.ok(p.server('appBoardGmail', 'GET', 'labels').labels.some(l => l.name === '_Board/Doing'));
  const doing = p.server('appBoardGmail', 'GET', 'labels').labels.find(l => l.name === '_Board/Doing');
  assert.ok(p.server('appBoardGmail', 'GET', 'threads', { labelIds: doing.id, maxResults: 100 }).threads.some(t => t.id === threadId));
  assert.equal(p.server('appBoardGmail', 'GET', `threads/${threadId}`, { format: 'metadata', metadataHeaders: ['Subject'] }).id, threadId);

  // Labelling: a move between columns, as the board sends it.
  const waiting = p.server('appBoardGmail', 'GET', 'labels').labels.find(l => l.name === '_Board/Waiting');
  p.server('appBoardGmail', 'POST', `threads/${threadId}/modify`, null, { addLabelIds: [waiting.id], removeLabelIds: [doing.id] });
  assert.deepEqual(plain(p.fake.box.threadLabelNames(threadId)).filter(n => n.startsWith('_Board')), ['_Board/Waiting']);

  // Nothing else: no sending, deleting, Trash, Spam or Inbox; no other labels' business.
  refused('POST', 'messages/send', null, { raw: 'x' });
  refused('POST', 'messages', null, { raw: 'x' });
  refused('DELETE', `threads/${threadId}`);
  refused('POST', `threads/${threadId}/trash`);
  refused('DELETE', `labels/${waiting.id}`);
  refused('PATCH', 'labels/INBOX', null, { name: 'Gone' });
  refused('GET', 'messages');
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['TRASH'], removeLabelIds: [] });
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['INBOX'], removeLabelIds: [] });
  refused('POST', `threads/${threadId}/modify`, null, { addLabelIds: ['SPAM'], removeLabelIds: [] });

  // A label is a name and nothing else.
  const made = p.server('appBoardGmail', 'POST', 'labels', null, { name: '_Board/Later', type: 'system', color: { textColor: '#000000' } });
  assert.equal(made.name, '_Board/Later');
  assert.throws(() => p.server('appBoardGmail', 'POST', 'labels', null, { name: ' ' }), /needs a name/);
  assert.equal(p.server('appBoardGmail', 'PATCH', `labels/${made.id}`, null, { name: '_Board/Someday' }).name, '_Board/Someday');
});

test('the board in the app: a board of cards in one round trip, reads only', () => {
  const p = new Phone();
  const ids = plain(p.server('appBoardGmail', 'GET', 'threads', { maxResults: 5 }).threads).map(t => t.id);
  const got = p.server('appBoardGmailMany', ids.map(id => ['GET', `threads/${id}`, { format: 'metadata' }]).concat([['GET', 'threads/ffffffffffffffff', {}]]));
  assert.deepEqual(got.slice(0, ids.length).map(t => t.id), ids);
  assert.equal(got[ids.length].error.status, 404, 'one missing thread is an answer, not a failure');
  assert.throws(() => p.server('appBoardGmailMany', [['POST', `threads/${ids[0]}/modify`, {}]]), /only reads/);
  assert.throws(() => p.server('appBoardGmailMany', [['GET', 'messages', {}]]), /not_allowed/);
});

test('the calendar in the app: Calendar and Tasks in one round trip, reads only', () => {
  const p = new Phone();
  const cal = require('../src/lib/calendar-logic.js');
  const [calendars, lists] = plain(p.server('appGoogleMany', cal.sourceRequests()));
  const sources = cal.sources(calendars.items, lists.items);
  assert.deepEqual(sources.map(s => s.name), ['test', 'Jobs', 'Family', 'Holidays in the United Kingdom', 'My Tasks', 'Admin']);

  const today = cal.dateKey(new Date());
  const range = cal.viewRange('week', today);
  const on = sources.filter(s => s.on);
  const reqs = cal.rangeRequests(range, on.filter(s => s.kind === 'calendar'), on.filter(s => s.kind === 'tasks'));
  const got = plain(p.server('appGoogleMany', reqs));
  assert.equal(got.length, reqs.length);
  assert.ok(got.every(r => !r.error));
  const titles = got.flatMap(r => r.items.map(x => x.summary || x.title));
  assert.ok(titles.includes('Lumenra glossary delivery'));
  assert.ok(titles.includes('Quote for Ingrid'));
  assert.ok(titles.includes('Proofread the IFU'), 'a task ticked in Google’s apps is hidden, and still read');
  assert.ok(!titles.includes('Bank holiday'), 'not from a calendar that is off');
  assert.ok(p.log.filter(l => l.service).every(l => l.method === 'GET'));

  // A calendar that is not there is one answer among the rest.
  const missing = plain(p.server('appGoogleMany', [['calendar', 'calendars/nope%40example.com/events', {}], ['tasks', 'users/@me/lists', {}]]));
  assert.equal(missing[0].error.status, 404);
  assert.equal(missing[1].items.length, 2);

  // Nothing but the four reads.
  assert.throws(() => p.server('appGoogleMany', [['calendar', 'calendars/primary/acl', {}]]), /not_allowed/);
  // One event on its own: a repeating event's series, for its rule.
  const [series] = plain(p.server('appGoogleMany', [['calendar', `calendars/${encodeURIComponent('test@example.com')}/events/standup`, {}]]));
  assert.deepEqual(series.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=SA']);
  assert.throws(() => p.server('appGoogleMany', [['calendar', 'calendars/primary/events/ev1/instances', {}]]), /not_allowed/);
  assert.throws(() => p.server('appGoogleMany', [['gmail', 'profile', {}]]), /not_allowed/);
  assert.throws(() => p.server('appGoogleMany', [['tasks', 'lists/abc/tasks/clear', {}]]), /not_allowed/);
});

test('the calendar in the app: not allowed yet comes with Google’s page that allows it', () => {
  const { AUTHORIZE_URL } = require('./helpers/apps-script.js');
  const p = new Phone();
  p.fake.denied.add('https://www.googleapis.com/auth/calendar.readonly');
  p.fake.denied.add('https://www.googleapis.com/auth/tasks');
  const got = plain(p.server('appGoogleMany', [['calendar', 'users/me/calendarList', {}], ['tasks', 'users/@me/lists', {}]]));
  for (const r of got) {
    assert.equal(r.error.code, 'calendar_scope');
    assert.equal(r.error.url, AUTHORIZE_URL);
  }
  assert.throws(() => p.server('allowCalendar'), /Authorization is required/, 'from the editor, Google asks');

  p.fake.denied.clear();
  assert.equal(p.server('allowCalendar'), true);
  const ok = plain(p.server('appGoogleMany', [['calendar', 'users/me/calendarList', {}]]));
  assert.equal(ok[0].items.length, 4);
});

test('the calendar in the app: Tasks not allowed says so, and the calendar still reads', () => {
  const { AUTHORIZE_URL } = require('./helpers/apps-script.js');
  const p = new Phone();
  p.fake.denied.add('https://www.googleapis.com/auth/tasks');
  const got = plain(p.server('appGoogleMany', [['tasks', 'lists/MTAxMjM0NTY3ODk/tasks', {}], ['calendar', 'users/me/calendarList', {}]]));
  assert.equal(got[0].error.code, 'calendar_scope');
  assert.equal(got[0].error.message, 'Not allowed for this app yet.');
  assert.equal(got[0].error.url, AUTHORIZE_URL);
  assert.equal(got[1].items.length, 4);
});

test('the calendar in the app: one change at a time, only what the calendar does, never over a newer version', () => {
  const { AUTHORIZE_URL } = require('./helpers/apps-script.js');
  const cal = require('../src/lib/calendar-logic.js');
  const p = new Phone();
  const fake = p.fake.calendar;
  const ME = 'test@example.com';
  const write = (...args) => plain(p.server('appGoogleWrite', ...args));
  const when = { start: { dateTime: '2026-10-05T14:30:00+01:00', timeZone: 'Europe/London' }, end: { dateTime: '2026-10-05T15:30:00+01:00', timeZone: 'Europe/London' } };

  // An event: added, changed with its version, refused with an old one, deleted.
  const made = write('calendar', 'POST', cal.eventsPath(ME), { summary: 'Dentist', ...when }, '').data;
  assert.equal(made.summary, 'Dentist');
  assert.ok(made.etag);
  const path = cal.eventPath({ source: ME, eventId: made.id });
  const changed = write('calendar', 'PATCH', path, { summary: 'Dentist, moved' }, made.etag).data;
  assert.equal(changed.summary, 'Dentist, moved');
  const stale = write('calendar', 'PATCH', path, { summary: 'Over the top' }, made.etag);
  assert.equal(stale.error.code, 'changed', 'changed in Google meanwhile');
  assert.equal(fake.events.find(e => e.id === made.id).summary, 'Dentist, moved', 'and not overwritten');
  assert.equal(write('calendar', 'DELETE', path, null, changed.etag).data, null);
  assert.equal(fake.events.find(e => e.id === made.id).status, 'cancelled');

  // A task: added, ticked, back, deleted.
  const LIST = fake.lists[0].id;
  const t = write('tasks', 'POST', cal.tasksPath(LIST), { title: 'Pay the invoice', due: '2026-10-05T00:00:00.000Z' }, '').data;
  const tpath = cal.taskPath({ source: LIST, taskId: t.id });
  assert.equal(write('tasks', 'PATCH', tpath, cal.tickBody(true), '').data.status, 'completed');
  assert.equal(write('tasks', 'PATCH', tpath, cal.tickBody(false), '').data.status, 'needsAction');
  write('tasks', 'DELETE', tpath, null, '');
  assert.equal(fake.tasks.find(x => x.id === t.id).deleted, true);

  // A calendar shared read-only: Google says no.
  const holiday = fake.events.find(e => e.summary === 'Bank holiday');
  const refused = write('calendar', 'PATCH', cal.eventPath({ source: holiday.calendarId, eventId: holiday.id }), { summary: 'x' }, holiday.etag);
  assert.equal(refused.error.status, 403);

  // Nothing but the calendar's own changes, checked here whatever the page says.
  assert.throws(() => p.server('appGoogleWrite', 'calendar', 'PATCH', path, { attendees: [{ email: 'a@b.c' }] }, ''), /not_allowed/);
  assert.throws(() => p.server('appGoogleWrite', 'calendar', 'GET', path, null, ''), /not_allowed/);
  assert.throws(() => p.server('appGoogleWrite', 'calendar', 'DELETE', `calendars/${encodeURIComponent(ME)}`, null, ''), /not_allowed/);
  assert.throws(() => p.server('appGoogleWrite', 'gmail', 'POST', 'messages/send', { raw: 'x' }, ''), /not_allowed/);
  assert.ok(p.log.filter(l => l.service && l.method !== 'GET').every(l => /^(calendars|lists)\//.test(l.path)), 'only events and tasks were written');

  // Allowed to read but not yet to change (a sign-in from before): the page that allows it.
  p.fake.denied.add('https://www.googleapis.com/auth/calendar.events');
  const notYet = write('calendar', 'POST', cal.eventsPath(ME), { summary: 'Later', ...when }, '');
  assert.equal(notYet.error.code, 'calendar_scope');
  assert.equal(notYet.error.url, AUTHORIZE_URL);
});

test('the board in the app: whose mailbox, the first column layout, and settings kept per account', () => {
  const p = new Phone();
  assert.equal(p.server('appAccount'), 'test@example.com');
  const cols = plain(p.server('appBoardColumns'));
  assert.deepEqual(cols.map(c => c.title), ['To do', 'Doing', 'Waiting', 'Done'], 'from the _Board labels, in the usual order');
  assert.ok(cols.every(c => c.label === `_Board/${c.title}` && c.labelId));
  assert.deepEqual(cols.map(c => c.archiveOnDrop), [false, false, false, true]);

  assert.deepEqual(plain(p.server('appPrefsGet', null)), {});
  p.server('appPrefsSet', { 'columns:test@example.com': [{ id: 'a', title: 'A', label: '_Board/A' }], 'card:test@example.com:123': { title: 'Mine' } });
  // Another phone (or computer) on the same account sees them.
  const other = new Phone({ fake: p.fake });
  assert.deepEqual(plain(other.server('appPrefsGet', ['card:test@example.com:123'])), { 'card:test@example.com:123': { title: 'Mine' } });
  other.server('appPrefsRemove', ['card:test@example.com:123']);
  assert.deepEqual(Object.keys(plain(p.server('appPrefsGet', null))), ['columns:test@example.com']);
  assert.throws(() => p.server('appPrefsSet', { big: 'x'.repeat(9000) }), /too much/);

  const fresh = new Phone({ search: '?fresh' });
  assert.equal(fresh.server('appBoardColumns'), null, 'no board labels yet: the usual columns, made as in Chrome');
});

test('appSave: the scratchpad saves under its fixed id, and only it can ask for one', () => {
  const p = new Phone();
  const first = p.server('appSave', '', { title: 'Scratchpad', doc: [{ type: 'p', runs: [{ text: 'Call the bank' }] }], noteId: 'scratchpad000000' }).note;
  assert.equal(first.key, 'n:scratchpad000000');
  const next = p.server('appSave', first.messageId, { title: 'Scratchpad', doc: [{ type: 'p', runs: [{ text: 'Call the bank today' }] }], noteId: 'scratchpad000000' }).note;
  assert.equal(next.key, 'n:scratchpad000000');
  const live = plain(p.fake.box.notesWithId('scratchpad000000')).filter(n => !n.labels.includes('TRASH'));
  assert.deepEqual(live.map(n => n.text), ['Call the bank today'], 'one live version');
  const other = p.server('appSave', '', { title: 'Sneaky', doc: [], noteId: 'aaaaaaaaaaaaaaaa' }).note;
  assert.notEqual(other.key, 'n:aaaaaaaaaaaaaaaa', 'any other id is ignored');
});

test('appSave: a note saved on another device meanwhile is not overwritten - nothing is written, and the page is told', () => {
  const phone = new Phone();
  const laptop = new Phone({ fake: phone.fake });
  const id = idOf(phone, 'launchchecklist0004');
  const doc = text => [{ type: 'p', runs: [{ text }] }];
  const saved = laptop.server('appSave', id, { title: 'Launch checklist', doc: doc('from the laptop') }).note;
  const r = phone.server('appSave', id, { title: 'Launch checklist', doc: doc('from the phone') });
  assert.equal(r.conflict.messageId, saved.messageId, 'the newer version, for the page to merge with');
  assert.equal(r.note, undefined);
  assert.equal(inserts(phone).length, 0, 'nothing written');
  assert.deepEqual(live(phone, 'launchchecklist0004').map(n => n.text), ['from the laptop']);
});

test('appBody, and appSave: a new note, a new version, an email turned into a note', () => {
  const p = new Phone();
  const launch = idOf(p, 'launchchecklist0004');
  const doc = p.server('appBody', launch);
  assert.equal(doc[0].type, 'h2');
  assert.equal(doc.find(b => b.type === 'check').runs[0].text, 'Proofread the IFU');

  const work = p.server('appList', '').folders.find(f => f.path === 'Work').id;
  const made = p.server('appSave', '', { title: 'From the phone', doc: [{ type: 'p', runs: [{ text: 'Hello', b: true }] }], folderId: work }).note;
  assert.equal(made.title, 'From the phone');
  assert.equal(made.folderId, work);
  assert.ok(made.own);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(made.messageId)), ['_Notes', '_Notes/Work']);
  assert.match(html(p, made.messageId), /<b>Hello<\/b>/);

  const next = p.server('appSave', made.messageId, { title: 'From the phone', doc: [{ type: 'p', runs: [{ text: 'Hello again' }] }], folderId: work }).note;
  assert.equal(next.noteId, made.noteId, 'the same note');
  assert.ok(plain(p.fake.box.messageLabelNames(made.messageId)).includes('TRASH'), 'the old version in Trash');

  const mail = p.fake.box.findMessageBySubject('Shopping list');
  const kept = p.server('appSave', mail, { title: 'Shopping list', doc: [{ type: 'p', runs: [{ text: 'Milk' }] }], folderId: '' }).note;
  assert.ok(kept.own);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), [], 'the email leaves the list, not for Trash');
});

test('appRetire and appRestore: Trash and back for a note; off and on the list for an email', () => {
  const p = new Phone();
  const rate = idOf(p, 'rateschedule00000003');
  p.server('appRetire', rate);
  assert.ok(plain(p.fake.box.messageLabelNames(rate)).includes('TRASH'));
  p.server('appRestore', rate, '');
  assert.deepEqual(plain(p.fake.box.messageLabelNames(rate)), ['_Notes']);

  const mail = p.fake.box.findMessageBySubject('Shopping list');
  const personal = p.server('appList', '').folders.find(f => f.path === 'Personal').id;
  p.server('appRetire', mail);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), []);
  p.server('appRestore', mail, personal);
  assert.deepEqual(plain(p.fake.box.messageLabelNames(mail)), ['_Notes', '_Notes/Personal']);

  const inbox = p.fake.box.threadsInInbox()[0].messages[0].id;
  assert.throws(() => p.server('appRetire', inbox) && p.addon.gkb.addonGmail.trashNote(inbox), /Only notes/);
  assert.ok(!plain(p.fake.box.messageLabelNames(inbox)).includes('TRASH'), 'an email is never sent to Trash');
});

test('appMove and the folder functions, with the extension\'s rules', () => {
  const p = new Phone();
  const folders = () => p.server('appList', '').folders;
  const idFor = path => folders().find(f => f.path === path).id;
  const rate = idOf(p, 'rateschedule00000003');
  p.server('appMove', rate, idFor('Personal'));
  assert.deepEqual(plain(p.fake.box.messageFolders(rate)), ['_Notes/Personal']);

  const made = p.server('appCreateFolder', idFor('Work'), 'Archive');
  assert.equal(made.folder.path, 'Work/Archive');
  assert.throws(() => p.server('appCreateFolder', idFor('Work'), 'archive'), /already a folder/);
  assert.throws(() => p.server('appCreateFolder', '', 'a/b'), /cannot contain/);

  const r = p.server('appRenameFolder', idFor('Work'), 'Jobs');
  assert.deepEqual(r.folders.map(f => f.path), ['Empty', 'Jobs', 'Jobs/Archive', 'Jobs/Clients', 'Personal'], 'the branch follows');

  assert.throws(() => p.server('appDeleteFolder', idFor('Jobs/Clients')), /^Error: not_allowed: only an empty notes folder/);
  const after = p.server('appDeleteFolder', idFor('Empty')).folders;
  assert.ok(!after.some(f => f.path === 'Empty'));
  const notNotes = plain(p.fake.box.labelByName('Invoices')).id;
  assert.throws(() => p.server('appDeleteFolder', notNotes), /not_allowed/, 'never a label outside the notes');
});

// ── Limits and failures ──────────────────────────────────────────────

test('it trashes only notes, never adds Trash, Spam or Inbox, and inserts only notes', () => {
  const p = new Phone();
  const g = p.addon.gkb.addonGmail;
  const mail = p.fake.box.threadsInInbox()[0].messages[0].id;
  assert.throws(() => g.trashNote(mail), /Only notes/);
  for (const label of ['TRASH', 'SPAM', 'INBOX']) {
    assert.throws(() => g.modifyLabels(mail, { addLabelIds: [label] }), /never moved/);
    assert.throws(() => g.modifyThread(p.fake.box.threadsInInbox()[0].id, { addLabelIds: [label] }), /never moved/);
  }
  assert.throws(() => g.insertNote({ raw: 'U3ViamVjdDogaGkNCg0KaGk', labelIds: [] }), /Only notes/);
  assert.throws(() => g.insertNote({ raw: 'x', labelIds: ['INBOX'] }), /Only notes/);
  assert.ok(!plain(p.fake.box.messageLabelNames(mail)).includes('TRASH'));
  assert.equal(p.writes().length, 0);
});

test('a fresh mailbox gets its _Notes label when the app first lists the notes', () => {
  const p = new Phone({ search: '?fresh' });
  assert.deepEqual(p.server('appList', '').notes, []);
  assert.ok(plain(p.fake.box.labelNames()).includes('_Notes'));
});

test('a failed save in the app says so, and leaves the note as it was', () => {
  const p = new Phone({ search: '?fail=insert' });
  const id = idOf(p, 'launchchecklist0004');
  assert.throws(() => p.server('appSave', id, { title: 'Launch checklist', doc: [{ type: 'p', runs: [{ text: 'kept' }] }] }), /Gmail answered 500/);
  assert.deepEqual(live(p, 'launchchecklist0004').map(n => n.id), [id]);
});

// ── The licence, kept by the script ──────────────────────────────────

// A phone whose script sells licences in the fake Lemon Squeezy's store.
function onSale() {
  const p = new Phone();
  p.addon.gkb.LICENCE_STORE_ID = p.fake.lemon.STORE;
  return p;
}
const lemonAsked = p => p.log.filter(l => l.service === 'lemon').map(l => [l.path, l.body]);
const keptLicence = p => JSON.parse(p.fake.userProperties.get('licence') || 'null');

test('the licence in preview: free, no trial kept, nothing asked of Lemon Squeezy', () => {
  const p = new Phone();
  assert.deepEqual(p.server('appLicence', 'status', ''), { view: { state: 'preview' } });
  assert.match(p.server('appLicence', 'enter', 'MD-GOOD-0001').error, /free while it is in preview/);
  assert.deepEqual(lemonAsked(p), []);
  assert.equal(keptLicence(p), null);
});

test('the licence on sale: a trial kept per account; a key activated without the Google token; a Supervertaler key checked only', () => {
  const p = onSale();
  assert.deepEqual(p.server('appLicence', 'status', ''), { view: { state: 'trial', daysLeft: 14 } });
  assert.ok(keptLicence(p).trialStart > 0, 'in the script’s properties');

  const out = p.server('appLicence', 'enter', 'MD-GOOD-0001');
  assert.equal(out.view.state, 'licensed');
  assert.equal(out.view.keyEnd, '0001');
  // The stand-in fails any request to Lemon Squeezy that carries the token.
  const asked = lemonAsked(p);
  assert.deepEqual(asked.map(a => a[0]), ['validate', 'activate']);
  assert.match(asked[1][1].instance_name, /^\S+ phone app, \d+ \w{3} \d{4}$/);
  assert.deepEqual(Object.keys(asked[1][1]).sort(), ['instance_name', 'license_key'], 'the key and a name, nothing else');
  assert.ok(!p.server('appPrefsGet', null).licence, 'not among the settings the page is given');

  // A Supervertaler licence in its place: the old activation given back,
  // and the new key only checked.
  const sv = p.server('appLicence', 'enter', 'SV-ACTIVE-0004');
  assert.equal(sv.view.kind, 'supervertaler');
  assert.deepEqual(lemonAsked(p).slice(2).map(a => a[0]), ['validate', 'deactivate']);
  assert.deepEqual(plain(p.fake.lemon.keys['SV-ACTIVE-0004'].instances), ['trados'], 'none of the buyer’s activations used');
  assert.deepEqual(plain(p.fake.lemon.keys['MD-GOOD-0001'].instances), [], 'the old one free again');

  assert.match(p.server('appLicence', 'enter', 'OTHER-STORE-0006').error, /not a licence key/);
  assert.match(p.server('appLicence', 'enter', 'MD-FULL-0002').error, /as many devices as it allows/);
  assert.equal(p.server('appLicence', 'status', '').view.kind, 'supervertaler', 'a key that will not do changes nothing');
  assert.throws(() => p.server('appLicence', 'wipe', ''), /not_allowed/);
});

test('the phone panel once the trial is over: a card that says where to enter a key, and nothing read or moved', () => {
  const p = onSale();
  const { threadId, messageId } = mailAbout(p, 'Quote request');
  p.server('appLicence', 'status', '');
  p.fake.userProperties.set('licence', JSON.stringify(Object.assign(keptLicence(p), { trialStart: Date.now() - 15 * 86400000 })));
  const before = p.log.length;
  p.openMessage(messageId);
  assert.equal(p.card.header.subtitle, 'A licence is needed');
  assert.match(p.lines()[0], /free trial has ended.*enter a licence key/);
  assert.deepEqual(p.log.slice(before), [], 'nothing read, not even Lemon Squeezy');
  const labels = threadLabels(p, threadId);
  // Pressed from a card drawn before the trial ended: refused.
  p.run({ functionName: 'onMoveThread', parameters: { threadId, columnId: 'x' } });
  assert.equal(p.toast, 'Not done: a licence is needed.');
  assert.deepEqual(threadLabels(p, threadId), labels);
  // With a licence, the board again.
  p.server('appLicence', 'enter', 'MD-GOOD-0001');
  p.openMessage(messageId);
  assert.equal(p.card.header.title, 'On the board: To do');
});

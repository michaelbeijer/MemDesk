// The board's and the notes' stores (src/content/store.js and
// notes-store.js) in Node, against the fake Gmail the browser preview uses
// (dev/mock-chrome.js), reached the way the extension reaches its worker.
// What a move does to someone's mail, and what a save does when another
// computer or phone saved first.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const ACCOUNT = 'test@example.com';
const FILES = [
  'src/shared/ns.js', 'src/lib/util.js', 'src/lib/notes-logic.js', 'src/lib/note-format.js',
  'src/lib/board-logic.js', 'src/lib/calendar-logic.js', 'dev/mock-chrome.js',
  'src/content/api.js', 'src/content/store.js', 'src/content/notes-store.js',
];

// A page of its own for each test: one Gmail tab, with its own fake mailbox.
function tab() {
  const ctx = {
    location: { search: '?latency=0', href: 'http://localhost/dev/preview.html?latency=0' },
    URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, structuredClone, console, setTimeout, clearTimeout,
    crypto, Event, EventTarget,
    CustomEvent: class extends Event { constructor(type, init) { super(type); this.detail = init && init.detail; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.gkb.hooks = { getAccount: () => ACCOUNT };
  const route = ctx.__mockChrome.route;
  const labelId = name => route('GET', 'labels').labels.find(l => l.name === name).id;
  const threadLabels = id => new Set(route('GET', `threads/${id}`, { format: 'minimal' }).messages.flatMap(m => m.labelIds));
  return { ns: ctx.gkb, box: ctx.__fakeGmail, route, labelId, threadLabels };
}

const later = () => new Promise(resolve => setTimeout(resolve, 5));
// What the page's code returns, in this file's own objects and arrays,
// for deepEqual.
const plain = x => JSON.parse(JSON.stringify(x));

// ── The board ────────────────────────────────────────────────────────

// Threads in the Inbox (and under `label`, if one is named), with or
// without mail not read yet.
function inboxThreads(t, unread, label) {
  const list = t.route('GET', 'threads', { labelIds: label ? [label, 'INBOX'] : ['INBOX'], maxResults: 100 }).threads || [];
  return list.map(x => x.id).filter(id => t.threadLabels(id).has('UNREAD') === unread);
}

// A label of the user's own - a client's - with a thread in the Inbox.
function clientThread(t) {
  for (const l of t.route('GET', 'labels').labels) {
    if (l.type !== 'user' || l.name.startsWith('_')) continue;
    const id = inboxThreads(t, false, l.id)[0] || inboxThreads(t, true, l.id)[0];
    if (id) return { label: l, id };
  }
  assert.fail('a client’s label with a thread in the Inbox');
}

test('a move never takes a label of the user’s own off an email, even one a column was pointed at', async () => {
  const t = tab();
  const { store, logic } = t.ns;
  const { label, id } = clientThread(t);
  const client = label.id;
  // A board from before columns had to be the board's own labels.
  const columns = [...logic.defaultColumns(), { id: 'client', title: 'Client', label: label.name }];
  await store.refreshLabels();

  await store.moveToColumn(id, columns, 'doing', 'test');
  let labels = t.threadLabels(id);
  assert.ok(labels.has(t.labelId('_Board/Doing')), 'on the board in Doing');
  assert.ok(labels.has(client), 'still filed under the client');

  await store.moveToColumn(id, columns, 'done', 'test');
  labels = t.threadLabels(id);
  assert.ok(labels.has(t.labelId('_Board/Done')) && !labels.has(t.labelId('_Board/Doing')), 'in Done, out of Doing');
  assert.ok(labels.has(client), 'still filed under the client after Done');

  await store.removeFromBoard(id, columns, 'test', ACCOUNT);
  labels = t.threadLabels(id);
  assert.ok(!labels.has(t.labelId('_Board/Done')), 'off the board');
  assert.ok(labels.has(client), 'and still filed under the client');
});

test('Done keeps mail not read yet in the Inbox, even a reply that came after the board was drawn', async () => {
  const t = tab();
  const { store, logic } = t.ns;
  const columns = logic.defaultColumns();
  await store.refreshLabels();
  const [read, other] = inboxThreads(t, false);
  assert.ok(other, 'two read threads in the Inbox');

  // Read: archived, as before.
  assert.deepEqual(plain(await store.moveToColumn(read, columns, 'done', 'test')), { keptInInbox: false });
  assert.ok(!t.threadLabels(read).has('INBOX'), 'archived');

  // Read when the board drew it; a reply came since.
  await store.loadBoard(ACCOUNT, columns);
  t.box.allMessages().filter(m => m.threadId === other).pop().labelIds.push('UNREAD');

  assert.deepEqual(plain(await store.moveToColumn(other, columns, 'done', 'test')), { keptInInbox: true });
  let labels = t.threadLabels(other);
  assert.ok(labels.has(t.labelId('_Board/Done')), 'the card is in Done');
  assert.ok(labels.has('INBOX'), 'the unread reply is still in the Inbox');

  await store.archive(other, 'test');
  labels = t.threadLabels(other);
  assert.ok(!labels.has('INBOX') && labels.has(t.labelId('_Board/Done')), '"Archive anyway" archives, and the card stays in Done');

  // A column that does not archive leaves the Inbox alone, read or not.
  const unread = inboxThreads(t, true)[0];
  assert.deepEqual(plain(await store.moveToColumn(unread, columns, 'doing', 'test')), { keptInInbox: false });
  assert.ok(t.threadLabels(unread).has('INBOX'));
});

// ── Notes ────────────────────────────────────────────────────────────

// Another computer saving `noteId`: its new version in, the one it had
// open to Trash, as notes-store.js save does there.
function savedElsewhere(t, root, note, body) {
  const raw = t.ns.notesLogic.buildNoteRaw({ noteId: note.noteId, title: note.title, body, account: ACCOUNT });
  const made = t.route('POST', 'messages', null, { raw, labelIds: [root] });
  if (note.messageId) t.route('POST', `messages/${note.messageId}/trash`);
  return made.id;
}

const liveVersions = (t, root, noteId) => (t.route('GET', 'messages', { labelIds: root, maxResults: 100 }).messages || [])
  .filter(m => t.ns.notesLogic.noteFromMessage(t.route('GET', `messages/${m.id}`, { format: 'metadata', metadataHeaders: ['X-Gkb-Note'] })).noteId === noteId)
  .map(m => m.id);

test('a save never sends to Trash a version another device saved first: it is told, and merges', async () => {
  const t = tab();
  const notes = t.ns.notesStore;
  const fmt = t.ns.noteFormat;
  const { notes: list } = await notes.list(ACCOUNT);
  const open = list.find(n => n.noteId === 'newsletterideas0002');
  const root = t.labelId('_Notes');

  await later();
  const theirs = savedElsewhere(t, root, open, 'Typed on the phone');
  await assert.rejects(
    notes.save(ACCOUNT, open, { title: open.title, doc: fmt.fromPlain('Typed here'), folderId: open.folderId }),
    err => err.code === 'conflict' && err.newer && err.newer.messageId === theirs && err.newer.folderId === '',
  );
  assert.deepEqual(plain(liveVersions(t, root, open.noteId)), [theirs], 'nothing written; the phone’s version is the note');

  // The view merges and saves again, on top of the newer version.
  await later();
  const newer = (await notes.list(ACCOUNT)).notes.find(n => n.noteId === open.noteId);
  const saved = await notes.save(ACCOUNT, newer, { title: open.title, doc: fmt.fromPlain('Typed on the phone\nTyped here') });
  assert.deepEqual(plain(liveVersions(t, root, open.noteId)), [saved.messageId]);

  // Saving again from here, with nothing new elsewhere, is no conflict.
  await later();
  const again = await notes.save(ACCOUNT, saved, { title: open.title, doc: fmt.fromPlain('Typed here, twice') });
  assert.deepEqual(plain(liveVersions(t, root, open.noteId)), [again.messageId]);
});

test('a first scratchpad never sends another computer’s to Trash', async () => {
  const t = tab();
  const notes = t.ns.notesStore;
  const { notesLogic, noteFormat: fmt } = t.ns;
  await notes.list(ACCOUNT);
  const root = t.labelId('_Notes');
  const theirs = savedElsewhere(t, root, { noteId: notesLogic.SCRATCHPAD_ID, title: notesLogic.SCRATCHPAD_TITLE }, 'From the laptop');

  await assert.rejects(
    notes.save(ACCOUNT, null, { title: '', doc: fmt.fromPlain('From the desktop'), noteId: notesLogic.SCRATCHPAD_ID }),
    err => err.code === 'conflict' && err.newer.messageId === theirs,
  );
  assert.deepEqual(plain(liveVersions(t, root, notesLogic.SCRATCHPAD_ID)), [theirs]);

  // A new note of any other kind has nothing to ask about.
  const made = await notes.save(ACCOUNT, null, { title: 'Brand new', doc: fmt.fromPlain('Hello') });
  assert.equal(made.own, true);
});

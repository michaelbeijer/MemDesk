// Order merging, label arithmetic for moves, column handling and thread
// summaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/lib/board-logic.js');

const COLUMNS = logic.defaultColumns();
const IDS = {
  '_Board/To do': 'Label_1',
  '_Board/Doing': 'Label_2',
  '_Board/Waiting': 'Label_3',
  '_Board/Done': 'Label_4',
};

// ── Order ────────────────────────────────────────────────────────────

test('saved order wins; unknown threads go on top, newest first', () => {
  const threads = [
    { id: 'a', ts: 100 },
    { id: 'b', ts: 200 },
    { id: 'c', ts: 300 },
    { id: 'new1', ts: 50 },
    { id: 'new2', ts: 999 },
  ];
  assert.deepEqual(logic.mergeOrder(['c', 'a', 'b'], threads), ['new2', 'new1', 'c', 'a', 'b']);
});

test('vanished ids are pruned and duplicates ignored', () => {
  const threads = [{ id: 'a', ts: 1 }, { id: 'b', ts: 2 }];
  assert.deepEqual(logic.mergeOrder(['gone', 'b', 'b', 'a', 'also-gone'], threads), ['b', 'a']);
});

test('no saved order means newest first', () => {
  const threads = [{ id: 'old', ts: 1 }, { id: 'mid', ts: 5 }, { id: 'young', ts: 9 }];
  assert.deepEqual(logic.mergeOrder(undefined, threads), ['young', 'mid', 'old']);
});

test('placeId moves within a list and inserts new ids', () => {
  assert.deepEqual(logic.placeId(['a', 'b', 'c', 'd'], 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(logic.placeId(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(logic.placeId(['a', 'b'], 'x', 1), ['a', 'x', 'b']);
  assert.deepEqual(logic.placeId(['a', 'b'], 'x', 99), ['a', 'b', 'x'], 'index is clamped');
  assert.deepEqual(logic.placeId(undefined, 'x', 0), ['x']);
});

test('pruneOrder keeps only current columns', () => {
  const lists = { todo: ['a'], doing: ['b'], gone: ['c'] };
  assert.deepEqual(logic.pruneOrder(lists, COLUMNS), { todo: ['a'], doing: ['b'], waiting: [], done: [] });
});

test('a thread in two columns is shown once, in the left-most', () => {
  const out = logic.assignColumns(COLUMNS, {
    todo: ['a', 'b'],
    doing: ['c'],
    waiting: ['b', 'd', 'c'],
    done: [],
  });
  assert.deepEqual(out, { todo: ['a', 'b'], doing: ['c'], waiting: ['d'], done: [] });
});

// ── Label arithmetic ─────────────────────────────────────────────────

test('a move adds the target label and strips the other column labels', () => {
  const diff = logic.moveLabelDiff(COLUMNS, 'doing', IDS);
  assert.deepEqual(diff.addLabelIds, ['Label_2']);
  assert.deepEqual(diff.removeLabelIds.sort(), ['Label_1', 'Label_3', 'Label_4']);
});

test('moving to an archiving column also removes INBOX', () => {
  const diff = logic.moveLabelDiff(COLUMNS, 'done', name => IDS[name]);
  assert.deepEqual(diff.addLabelIds, ['Label_4']);
  assert.deepEqual(diff.removeLabelIds.sort(), ['INBOX', 'Label_1', 'Label_2', 'Label_3']);
});

test('moving out of an archiving column does not touch INBOX', () => {
  const diff = logic.moveLabelDiff(COLUMNS, 'todo', new Map(Object.entries(IDS)));
  assert.equal(diff.removeLabelIds.includes('INBOX'), false);
  assert.equal(diff.addLabelIds.includes('INBOX'), false, 'nothing is ever un-archived behind your back');
});

test('column labels without an id yet are skipped, not sent as undefined', () => {
  const partial = { '_Board/To do': 'Label_1', '_Board/Doing': 'Label_2' };
  const diff = logic.moveLabelDiff(COLUMNS, 'todo', partial);
  assert.deepEqual(diff.removeLabelIds, ['Label_2']);
});

test('a move to an unknown column or unlabelled target throws', () => {
  assert.throws(() => logic.moveLabelDiff(COLUMNS, 'nope', IDS), /Unknown column/);
  assert.throws(() => logic.moveLabelDiff(COLUMNS, 'todo', {}), /No Gmail label id/);
});

test('removing from the board strips every column label and nothing else', () => {
  const diff = logic.removeLabelDiff(COLUMNS, IDS);
  assert.deepEqual(diff.addLabelIds, []);
  assert.deepEqual(diff.removeLabelIds.sort(), ['Label_1', 'Label_2', 'Label_3', 'Label_4']);
});

test('columnForLabels picks the left-most matching column', () => {
  assert.equal(logic.columnForLabels(COLUMNS, ['INBOX', 'Label_3', 'Label_2'], IDS).id, 'doing');
  assert.equal(logic.columnForLabels(COLUMNS, ['INBOX'], IDS), null);
});

// ── Columns ──────────────────────────────────────────────────────────

test('default columns', () => {
  assert.deepEqual(COLUMNS.map(c => [c.title, c.label, c.archiveOnDrop]), [
    ['To do', '_Board/To do', false],
    ['Doing', '_Board/Doing', false],
    ['Waiting', '_Board/Waiting', false],
    ['Done', '_Board/Done', true],
  ]);
  const copy = logic.defaultColumns();
  copy[0].title = 'mutated';
  assert.equal(logic.defaultColumns()[0].title, 'To do', 'defaults are copied, not shared');
});

test('stored columns are normalised, with defaults as the fallback', () => {
  assert.equal(logic.normaliseColumns(undefined).length, 4);
  assert.equal(logic.normaliseColumns([]).length, 4);
  assert.equal(logic.normaliseColumns([{ id: '', label: 'x' }, null]).length, 4);
  assert.deepEqual(logic.normaliseColumns([
    { id: 'a', title: ' Clients ', label: 'Work/Clients', archiveOnDrop: 1 },
    { id: 'a', title: 'Duplicate id', label: 'Dup' },
    { id: 'b', label: 'Work/Later' },
  ]), [
    { id: 'a', title: 'Clients', label: 'Work/Clients', archiveOnDrop: true, chime: true },
    { id: 'b', title: 'Later', label: 'Work/Later', archiveOnDrop: false, chime: false },
  ]);
});

test('Done chimes; a column saved before chimes existed chimes if it archives; a choice made is kept', () => {
  assert.deepEqual(COLUMNS.map(c => [c.title, c.chime]), [
    ['To do', false], ['Doing', false], ['Waiting', false], ['Done', true],
  ]);
  const cols = logic.normaliseColumns([
    { id: 'old-done', label: 'B/Done', archiveOnDrop: true },
    { id: 'old-doing', label: 'B/Doing', archiveOnDrop: false },
    { id: 'quiet-done', label: 'B/Quiet', archiveOnDrop: true, chime: false },
    { id: 'loud', label: 'B/Loud', archiveOnDrop: false, chime: true },
    { id: 'odd', label: 'B/Odd', archiveOnDrop: true, chime: 'yes' },
  ]);
  assert.deepEqual(cols.map(c => [c.id, c.chime]), [
    ['old-done', true], ['old-doing', false], ['quiet-done', false], ['loud', true], ['odd', true],
  ]);
});

test('column validation catches what Gmail would reject', () => {
  const ok = logic.defaultColumns();
  assert.equal(logic.validateColumns(ok), '');
  assert.match(logic.validateColumns([]), /at least one/);
  assert.match(logic.validateColumns([{ title: '', label: 'A' }]), /title/);
  assert.match(logic.validateColumns([{ title: 'A', label: '' }]), /label/);
  assert.match(logic.validateColumns([{ title: 'A', label: 'Inbox' }]), /system label/);
  assert.match(logic.validateColumns([{ title: 'A', label: 'Board//A' }]), /empty part/);
  assert.match(logic.validateColumns([{ title: 'A', label: 'X/' }]), /empty part/);
  assert.match(logic.validateColumns([
    { title: 'A', label: 'Board/Same' },
    { title: 'B', label: 'board/same' },
  ]), /Two columns/);
});

test('new column ids are unique', () => {
  const id = logic.newColumnId(COLUMNS);
  assert.match(id, /^c[0-9a-z]+$/);
  assert.equal(COLUMNS.some(c => c.id === id), false);
});

test('label ancestors, parents first', () => {
  assert.deepEqual(logic.labelAncestors('Board/To do'), ['Board']);
  assert.deepEqual(logic.labelAncestors('A/B/C'), ['A', 'A/B']);
  assert.deepEqual(logic.labelAncestors('Flat'), []);
});

test('empty search means the Inbox', () => {
  assert.equal(logic.searchQuery('  '), 'in:inbox');
  assert.equal(logic.searchQuery(undefined), 'in:inbox');
  assert.equal(logic.searchQuery(' from:anna '), 'from:anna');
});

// ── Thread summaries ─────────────────────────────────────────────────

function msg(from, subject, ts, labels = [], snippet = '') {
  return {
    internalDate: String(ts),
    labelIds: labels,
    snippet,
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] },
  };
}

test('summary: subject from the first message, sender and date from the latest', () => {
  const s = logic.summariseThread({
    id: 't1',
    historyId: '42',
    messages: [
      msg('Ingrid Vos <ingrid@halverson.example>', 'Quote request', 1000, ['INBOX']),
      msg('Me <ME@example.com>', 'Re: Quote request', 2000, ['SENT']),
      msg('Ingrid Vos <ingrid@halverson.example>', 'Re: Quote request', 3000, ['INBOX', 'UNREAD'],
        'We&#39;ll go ahead &amp; confirm'),
    ],
  }, 'me@example.com');
  assert.equal(s.subject, 'Quote request');
  assert.equal(s.from, 'Ingrid Vos');
  assert.equal(s.ts, 3000);
  assert.equal(s.count, 3);
  assert.equal(s.unread, true);
  assert.equal(s.starred, false);
  assert.equal(s.snippet, "We'll go ahead & confirm");
  assert.equal(s.historyId, '42');
});

test('summary: “me” when the account sent the latest message', () => {
  const s = logic.summariseThread({
    id: 't2',
    messages: [
      msg('Tomás <tomas@lumenra.example>', 'Glossary', 1000, ['INBOX', 'STARRED']),
      msg('Sam Test <test@example.com>', 'Re: Glossary', 2000, ['SENT']),
    ],
  }, 'Test@Example.com');
  assert.equal(s.from, 'me');
  assert.equal(s.starred, true);
});

test('summary: a trailing draft does not count as the latest message', () => {
  const s = logic.summariseThread({
    id: 't3',
    messages: [
      msg('Priya <priya@kestrel.example>', 'IFU files', 1000, ['INBOX'], 'From Priya'),
      msg('Me <test@example.com>', 'Re: IFU files', 5000, ['DRAFT'], 'my draft'),
    ],
  }, 'test@example.com');
  assert.equal(s.from, 'Priya');
  assert.equal(s.ts, 1000);
  assert.equal(s.count, 1);
  assert.equal(s.hasDraft, true);
  assert.equal(s.snippet, 'From Priya');
});

test('summary: blank subject and empty threads', () => {
  const s = logic.summariseThread({ id: 't4', messages: [msg('x@y.example', '  ', 1)] }, '');
  assert.equal(s.subject, '(no subject)');
  assert.equal(s.from, 'x');
  const empty = logic.summariseThread({ id: 't5', snippet: 'a &amp; b' }, '');
  assert.equal(empty.subject, '(no subject)');
  assert.equal(empty.snippet, 'a & b');
  assert.equal(empty.count, 0);
});

// ── Card edits ───────────────────────────────────────────────────────

test('card edit: trims, collapses whitespace and caps lengths', () => {
  const e = logic.normaliseCardEdit({
    title: '  Genpact   EN>NL \n ',
    note: '\r\n 4,200 words\r\n\r\n\r\n\r\ndue Fri  ',
    colour: 'green',
  }, 'PO2627669 | Genpact- Translation| EN to Dutch');
  assert.deepEqual(e, { title: 'Genpact EN>NL', note: '4,200 words\n\ndue Fri', colour: 'green' });

  const long = logic.normaliseCardEdit({ title: 'x'.repeat(500), note: 'y'.repeat(900) });
  assert.equal(long.title.length, logic.MAX_TITLE);
  assert.equal(long.note.length, logic.MAX_NOTE);
});

test('card edit: nothing that differs from the email is not an edit', () => {
  assert.equal(logic.normaliseCardEdit({ title: 'Quote request', note: ' ', colour: '' }, 'Quote request'), null);
  assert.equal(logic.normaliseCardEdit({ title: '  Quote request ' }, 'Quote request'), null, 'subject, padded');
  assert.equal(logic.normaliseCardEdit({}), null);
  assert.equal(logic.normaliseCardEdit(null), null);
  assert.equal(logic.normaliseCardEdit('a string'), null);
  // Keeping the subject but adding a colour stores just the colour.
  assert.deepEqual(logic.normaliseCardEdit({ title: 'Quote request', colour: 'red' }, 'Quote request'), { colour: 'red' });
});

test('card edit: unknown colours are dropped, known ones kept', () => {
  assert.equal(logic.normaliseCardEdit({ colour: 'chartreuse' }), null);
  assert.equal(logic.normaliseCardEdit({ colour: 'javascript:alert(1)' }), null);
  for (const c of logic.CARD_COLOURS) assert.deepEqual(logic.normaliseCardEdit({ colour: c }), { colour: c });
});

test('card edit: display title falls back to the subject', () => {
  const t = { subject: 'Termbase export won’t open' };
  assert.equal(logic.displayTitle(t, null), 'Termbase export won’t open');
  assert.equal(logic.displayTitle(t, { note: 'only a note' }), 'Termbase export won’t open');
  assert.equal(logic.displayTitle(t, { title: 'Termbase bug' }), 'Termbase bug');
  assert.equal(logic.displayTitle(null, null), '(no subject)');
});

test('card edits are read per account out of a storage.sync dump', () => {
  const all = {
    clientId: 'x.apps.googleusercontent.com',
    'columns:me@example.com': [],
    'card:me@example.com:18c2f': { title: 'Mine', colour: 'blue' },
    'card:me@example.com:18c30': { colour: 'not-a-colour' },
    'card:other@example.com:18c2f': { title: 'Someone else’s' },
    'card:me@example.com:': { title: 'no thread id' },
  };
  const edits = logic.cardEditsFrom(all, 'card:me@example.com:');
  assert.deepEqual([...edits.entries()], [['18c2f', { title: 'Mine', colour: 'blue' }]]);
});

test('a card’s storage key sits under its account’s prefix, case-insensitively', () => {
  const { KEYS } = require('../src/shared/ns.js');
  const key = KEYS.card('Michael@Example.com', '18c2f');
  assert.equal(key, 'card:michael@example.com:18c2f');
  assert.ok(key.startsWith(KEYS.cardPrefix('MICHAEL@example.com')));
  assert.equal(KEYS.card('a@b.example', 'x').startsWith(KEYS.cardPrefix('ab@b.example')), false);
});

// ── Column labels: renames and roots ─────────────────────────────────

test('new columns go under the parent the existing ones share', () => {
  assert.equal(logic.labelRoot(logic.defaultColumns()), '_Board');
  assert.equal(logic.labelRoot([{ label: 'Work/Board/To do' }, { label: 'Work/Board/Done' }]), 'Work/Board');
  assert.equal(logic.labelRoot([{ label: 'Board/To do' }, { label: '_Board/Done' }]), '_Board', 'mixed parents: the default');
  assert.equal(logic.labelRoot([{ label: 'Top level' }]), '_Board');
  assert.equal(logic.labelRoot([]), '_Board');
});

test('a column follows its label when Gmail renames it, by id', () => {
  const cols = [
    { id: 'todo', title: 'To do', label: 'Board/To do', labelId: 'Label_1', archiveOnDrop: false },
    { id: 'done', title: 'Done', label: 'Board/Done', archiveOnDrop: true },
    { id: 'gone', title: 'Gone', label: 'Board/Gone', labelId: 'Label_99', archiveOnDrop: false },
  ];
  const labels = [
    { id: 'Label_1', name: '_Board/To do' },
    { id: 'Label_2', name: 'board/done' },
  ];
  const { columns, changed } = logic.resolveColumnLabels(cols, labels);
  assert.equal(changed, true);
  assert.deepEqual(columns[0], { ...cols[0], label: '_Board/To do' }, 'renamed in Gmail: followed by id');
  assert.deepEqual(columns[1], { ...cols[1], label: 'board/done', labelId: 'Label_2' }, 'matched by name: id and Gmail’s spelling recorded');
  assert.deepEqual(columns[2], { id: 'gone', title: 'Gone', label: 'Board/Gone', archiveOnDrop: false }, 'stale id dropped');

  const again = logic.resolveColumnLabels(columns.slice(0, 2), labels);
  assert.equal(again.changed, false, 'nothing to save the second time');
});

test('normaliseColumns keeps a stored label id', () => {
  const [c] = logic.normaliseColumns([{ id: 'a', title: 'A', label: '_Board/A', labelId: 'Label_5' }, { id: 'b', label: 'x', labelId: 7 }]);
  assert.equal(c.labelId, 'Label_5');
  assert.equal('labelId' in logic.normaliseColumns([{ id: 'b', label: 'x', labelId: 7 }])[0], false);
});

// ── Waiting on them ──

test('waiting on them: the user wrote last, to someone else, and is not writing back', () => {
  const sent = (to, extra = {}) => ({
    labelIds: ['SENT'], internalDate: '3000', snippet: 'mine',
    payload: { headers: [{ name: 'From', value: 'Sam <test@example.com>' }, { name: 'Subject', value: 'Re: x' }, ...(to === null ? [] : [{ name: 'To', value: to }]), ...(extra.cc ? [{ name: 'Cc', value: extra.cc }] : [])] },
  });
  const theirs = msg('Priya <priya@kestrel.example>', 'x', 1000, ['INBOX']);
  const summary = messages => logic.summariseThread({ id: 't', messages }, 'test@example.com');
  assert.equal(summary([theirs, sent('Priya <priya@kestrel.example>')]).waiting, true);
  assert.equal(summary([theirs]).waiting, false, 'their move: not waiting');
  assert.equal(summary([theirs, sent('priya@kestrel.example'), msg('Me <test@example.com>', 'Re: x', 5000, ['DRAFT'])]).waiting, false, 'a reply being written: the ball is with the user');
  assert.equal(summary([sent('Sam <TEST@example.com>')]).waiting, false, 'a note to self waits on no one');
  assert.equal(summary([sent('Sam <test@example.com>', { cc: 'Bart <bart@example.org>' })]).waiting, true, 'copied to someone');
  assert.equal(summary([sent(null)]).waiting, true, 'Bcc only: someone else, unseen');
});

// ── Labels as colours ──

test('label colours: the conversation’s coloured labels of the user’s own, not the board’s, the notes’ or Gmail’s', () => {
  const blue = { backgroundColor: '#4a86e8', textColor: '#ffffff' };
  const labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system', color: blue },
    { id: 'L1', name: '{{Supervertaler}}', type: 'user', color: blue },
    { id: 'L2', name: 'Clients/Kestrel Medical', type: 'user', color: { backgroundColor: '#fad165', textColor: '#000000' } },
    { id: 'L3', name: 'Plain', type: 'user' },
    { id: 'L4', name: '_Board', type: 'user', color: blue },
    { id: 'L5', name: '_Board/Doing', type: 'user', color: blue },
    { id: 'L6', name: '_Notes/Work', type: 'user', color: blue },
    { id: 'L7', name: 'Admin', type: 'user', color: { backgroundColor: 'red; content: url(x)', textColor: '#000000' } },
    { id: 'L8', name: '.Tessa', type: 'user', color: { backgroundColor: '#b694e8', textColor: 'nonsense' } },
  ];
  const skip = ['_Board/Doing', '_Board', '_Notes'];
  const tags = logic.labelTags(['INBOX', 'L5', 'L2', 'L1', 'L3', 'L4', 'L6', 'L7', 'L1'], labels, skip);
  assert.deepEqual(tags.map(t => [t.name, t.short, t.background, t.text]), [
    ['{{Supervertaler}}', '{{Supervertaler}}', '#4a86e8', '#ffffff'],
    ['Clients/Kestrel Medical', 'Kestrel Medical', '#fad165', '#000000'],
  ].sort((a, b) => a[0].localeCompare(b[0])), 'by name; no colour, no board, no notes, no Gmail, no made-up colour');
  assert.equal(logic.labelTags(['L1', 'L2', 'L8'], labels, skip).length, logic.MAX_TAGS, 'at most two');
  assert.equal(logic.labelTags(['L8'], labels, skip)[0].text, '#000000', 'a text colour that is not one: black');
  assert.deepEqual(logic.labelTags(['L5', 'L4'], labels, skip), []);
  assert.deepEqual(logic.labelTags(['L1'], [], skip), [], 'labels not read yet: none');
});

// ── The layout in Gmail ──────────────────────────────────────────────

const util = require('../src/lib/util.js');
const notes = require('../src/lib/notes-logic.js');
const auth = require('../src/lib/auth.js');

const LAYOUT = logic.normaliseColumns([
  { id: 'todo', title: 'To do', label: '_Board/To do', labelId: 'Label_1', archiveOnDrop: false, chime: false },
  { id: 'inv', title: 'To invoice', label: '_Board/To invoice', archiveOnDrop: false, chime: false },
  { id: 'done', title: 'Done', label: '_Board/Done', labelId: 'Label_4', archiveOnDrop: true, chime: true },
]);

// A mailbox with messages under the board's label: { id, at, noteId, text }.
function layoutBox(messages) {
  const reads = [];
  const read = ([method, path, query]) => {
    reads.push(`${method} ${path}${query && query.format ? ` ${query.format}` : ''}`);
    assert.equal(method, 'GET', 'reading only reads');
    if (path === 'messages') return { messages: messages.map(m => ({ id: m.id })) };
    const m = messages.find(x => x.id === path.split('/')[1]);
    const headers = m.noteId ? [{ name: 'X-Gkb-Note', value: m.noteId }] : [{ name: 'Subject', value: 'mail' }];
    if (query.format === 'metadata') return { id: m.id, internalDate: String(m.at), payload: { headers } };
    return { id: m.id, internalDate: String(m.at), payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from(m.text, 'utf8').toString('base64url') } } };
  };
  return { reads, io: { read, readMany: list => list.map(read) } };
}

test('the layout: written as a note of ours under the board’s label, the versions it replaces then to Trash', () => {
  const done = [];
  const io = {
    insert: body => { done.push(['insert', body]); return { id: 'm3' }; },
    trash: id => { done.push(['trash', id]); return null; },
  };
  const out = util.runSync(logic.layoutWriteFlow({ rootLabelId: 'Label_0', columns: LAYOUT, replaces: ['m2', 'm1'], account: 'sam@example.com' }), io);
  assert.deepEqual(out, { id: 'm3', columns: LAYOUT });
  const [[op, body]] = done;
  assert.equal(op, 'insert');
  assert.deepEqual(body.labelIds, ['Label_0'], 'under the board’s label, and nothing else');
  assert.ok(notes.isNoteInsert(body), 'a note, as the worker and the script require');
  assert.ok(auth.isAllowedRequest('POST', 'messages', body));
  assert.equal(notes.noteIdOfRaw(body.raw), logic.LAYOUT_ID);
  assert.deepEqual(done.slice(1), [['trash', 'm2'], ['trash', 'm1']], 'then the versions it replaces');
  // What is in it: a line for whoever finds it in Gmail, and the columns.
  const text = logic.layoutText(LAYOUT);
  assert.match(text, /^The board’s columns, kept here/);
  assert.deepEqual(logic.layoutFromText(text), LAYOUT, 'titles, labels, ids, archive and chime, in order');
});

test('the layout read back: the newest of its versions, mail under the label ignored; the text read only when it is new', () => {
  const text = logic.layoutText(LAYOUT);
  const older = logic.layoutText(LAYOUT.slice(0, 2));
  const box = layoutBox([
    { id: 'mail', at: 900, text: '{"columns":[{"id":"x","label":"Mine"}]}' },
    { id: 'm1', at: 100, noteId: logic.LAYOUT_ID, text: older },
    { id: 'note', at: 800, noteId: 'abcdefabcdef12', text: older },
    { id: 'm2', at: 200, noteId: logic.LAYOUT_ID, text },
  ]);
  const found = util.runSync(logic.layoutReadFlow('Label_0', ''), box.io);
  assert.deepEqual(found, { id: 'm2', same: false, columns: LAYOUT, older: ['m1'] });
  assert.equal(box.reads.filter(r => / full$/.test(r)).length, 1, 'one version’s text read');

  box.reads.length = 0;
  assert.deepEqual(util.runSync(logic.layoutReadFlow('Label_0', 'm2'), box.io), { id: 'm2', same: true, columns: null, older: ['m1'] });
  assert.ok(!box.reads.some(r => / full$/.test(r)), 'the version already known is not read again');

  assert.equal(util.runSync(logic.layoutReadFlow('Label_0', ''), layoutBox([]).io), null, 'none yet');
  assert.equal(util.runSync(logic.layoutReadFlow('Label_0', ''), layoutBox([{ id: 'mail', at: 1, text: '{}' }]).io), null, 'only mail: none');
});

test('a layout that cannot be read is no layout - never the default columns in its place', () => {
  for (const junk of ['', 'no braces', '{ not json', '{"columns":[]}', '{"columns":[{"title":"No id or label"}]}', '{"v":1}']) {
    assert.equal(logic.layoutFromText(junk), null, junk);
  }
  const box = layoutBox([{ id: 'm1', at: 1, noteId: logic.LAYOUT_ID, text: 'garbled' }]);
  assert.deepEqual(util.runSync(logic.layoutReadFlow('Label_0', ''), box.io), { id: 'm1', same: false, columns: null, older: [] });
  assert.ok(logic.sameColumns(LAYOUT, logic.normaliseColumns(JSON.parse(JSON.stringify(LAYOUT)))));
  assert.ok(!logic.sameColumns(LAYOUT, LAYOUT.slice().reverse()), 'the order counts');
});

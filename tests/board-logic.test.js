// Order merging, label arithmetic for moves, column handling and thread
// summaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/lib/board-logic.js');

const COLUMNS = logic.defaultColumns();
const IDS = {
  'Board/To do': 'Label_1',
  'Board/Doing': 'Label_2',
  'Board/Waiting': 'Label_3',
  'Board/Done': 'Label_4',
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
  const partial = { 'Board/To do': 'Label_1', 'Board/Doing': 'Label_2' };
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
    ['To do', 'Board/To do', false],
    ['Doing', 'Board/Doing', false],
    ['Waiting', 'Board/Waiting', false],
    ['Done', 'Board/Done', true],
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
    { id: 'a', title: 'Clients', label: 'Work/Clients', archiveOnDrop: true },
    { id: 'b', title: 'Later', label: 'Work/Later', archiveOnDrop: false },
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

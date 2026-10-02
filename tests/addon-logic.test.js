// The phone panel's pure parts: the browser APIs it supplies to Apps
// Script, how a note is shown on a card, and what its controls change.

const test = require('node:test');
const assert = require('node:assert/strict');
const shims = require('../addon/src/shims.js');
const panel = require('../addon/src/panel-logic.js');
const fmt = require('../src/lib/note-format.js');

const B = (type, runs, extra = {}) => fmt.block(type, runs, extra);
const T = (text, marks = {}) => ({ text, ...marks });

// ── Shims ────────────────────────────────────────────────────────────

test('base64 shims agree with the real thing', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'Hello, world!', '\x00\xff\x80\x7f', Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('')]) {
    assert.equal(shims.btoa(s), Buffer.from(s, 'latin1').toString('base64'), JSON.stringify(s));
    assert.equal(shims.atob(shims.btoa(s)), s);
  }
  assert.equal(shims.atob('SGVs\nbG8='), 'Hello', 'line breaks and padding are fine');
  assert.throws(() => shims.btoa('é€'), /Latin-1/);
  assert.throws(() => shims.atob('@@@@'), /not base64/);
});

test('UTF-8 shims agree with the real thing, broken bytes included', () => {
  const text = 'Café naïve ✓ 日本語 🙂 — “quotes” ☐ ☑ \u0000 end';
  assert.deepEqual([...new shims.TextEncoder().encode(text)], [...new TextEncoder().encode(text)]);
  assert.equal(new shims.TextDecoder().decode(new TextEncoder().encode(text)), text);
  for (const bytes of [[0xff, 0x41], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xef, 0xbb, 0xbf, 0x41]]) {
    const u8 = new Uint8Array(bytes);
    assert.equal(new shims.TextDecoder('utf-8').decode(u8).replace(/�+/g, '?'),
      new TextDecoder('utf-8').decode(u8).replace(/�+/g, '?'), bytes.join(','));
  }
  assert.equal(new shims.TextEncoder().encode('\ud800x').length, 4, 'a lone surrogate becomes U+FFFD');
});

test('windows-1252, under the names mail uses for it', () => {
  const bytes = new Uint8Array([0x93, 0x43, 0x61, 0x66, 0xe9, 0x94, 0x20, 0x80, 0x35]);
  // As browsers decode them (WHATWG); Node's own decoder gives control
  // characters for 0x80-0x9F instead.
  for (const label of ['windows-1252', 'ISO-8859-1', 'us-ascii', 'latin1']) {
    assert.equal(new shims.TextDecoder(label).decode(bytes), '\u201cCaf\u00e9\u201d \u20ac5', label);
  }
  assert.throws(() => new shims.TextDecoder('koi8-r'), RangeError);
});

test('the URL shim reads links as a browser does', () => {
  const inputs = ['https://example.com', 'HTTP://Example.COM:80/a/B?x=1&y=2#Frag', 'https://example.com:443', 'https://example.com:8443/x',
    'https://user@example.com/p', 'https://example.com/caf\u00e9?q=na\u00efve', 'mailto:sam@example.com', 'https://sub.example.co.uk/a/b/', 'http://localhost:3000'];
  for (const s of inputs) {
    const ours = new shims.URL(s);
    const real = new URL(s);
    assert.equal(ours.href, real.href, s);
    assert.equal(ours.protocol, real.protocol, s);
  }
  for (const s of ['example.com', 'https://', 'https:///x', 'https://exa^mple.com']) assert.throws(() => new shims.URL(s), TypeError, s);
});

test('random values fill the array', () => {
  const a = shims.crypto.getRandomValues(new Uint8Array(32));
  assert.ok(a.every(x => Number.isInteger(x) && x >= 0 && x < 256));
  assert.ok(new Set(a).size > 4);
});

// ── Showing a note ───────────────────────────────────────────────────

test('a note as card items: text runs, bullets and numbers, a box per checklist item', () => {
  const doc = [
    B('h2', [T('Before Friday')]),
    B('p', [T('Deliver to '), T('Kestrel', { b: true }), T(' by '), T('noon', { i: true }), T(', see '), T('the portal', { href: 'https://example.com/p?a=1&b=2' })]),
    B('p', []),
    B('check', [T('Proofread')], { checked: true }),
    B('check', [T('Invoice <draft>')]),
    B('check', [T('PO number')], { level: 1 }),
    B('ol', [T('Zip')]), B('ol', [T('Upload')]), B('ol', [T('nested')], { level: 1 }), B('ol', [T('Done')]),
    B('ul', [T('bullet')]), B('ul', [T('gone', { s: true })], { level: 1 }),
    B('check', []),
  ];
  const { items, hidden } = panel.cardItems(doc);
  assert.equal(hidden, 0);
  assert.deepEqual(items, [
    { kind: 'text', html: '<b>Before Friday</b><br>Deliver to <b>Kestrel</b> by <i>noon</i>, see <a href="https://example.com/p?a=1&amp;b=2">the portal</a>' },
    { kind: 'check', index: 3, html: 'Proofread', checked: true },
    { kind: 'check', index: 4, html: 'Invoice &lt;draft&gt;', checked: false },
    { kind: 'check', index: 5, html: '  PO number', checked: false },
    { kind: 'text', html: '1. Zip<br>2. Upload<br>  1. nested<br>3. Done<br>• bullet<br>  • <s>gone</s>' },
    { kind: 'check', index: 12, html: '<font color="#5f6368">(empty)</font>', checked: false },
  ]);
});

test('a long note shows its start, and says how much is not shown', () => {
  const doc = Array.from({ length: 100 }, (_, i) => B('check', [T(`item ${i}`)]));
  const { items, hidden } = panel.cardItems(doc, { maxBlocks: 80 });
  assert.equal(items.length, 80);
  assert.equal(hidden, 20);
  assert.deepEqual(panel.cardItems([B('p', [])]).items, [], 'an empty note has nothing to show');
});

// ── Changing a note ──────────────────────────────────────────────────

test('ticks change only the boxes that were on the card', () => {
  const doc = [B('check', [T('a')]), B('p', [T('x')]), B('check', [T('b')], { checked: true }), B('check', [T('c')], { checked: true })];
  const out = panel.applyTicks(doc, [0, 2], new Set([0]));
  assert.deepEqual(out.map(b => b.checked), [true, false, false, true], 'c was not on the card and keeps its tick');
  assert.deepEqual(doc.map(b => b.checked), [false, false, true, true], 'the original is untouched');
  assert.deepEqual(panel.applyTicks(doc, [1, 99], new Set([1, 99])).map(b => b.checked), [false, false, true, true], 'not boxes, not there');
});

test('typed lines as checklist items, bullets or text', () => {
  const show = doc => doc.map(b => [b.type, b.level, b.checked, fmt.docText([b])]);
  assert.deepEqual(show(panel.linesToBlocks('\n milk\n\n- [x] eggs\n  [ ] flour (sub)\n☑ jam\n\n', 'check')), [
    ['check', 0, false, 'milk'], ['check', 0, true, 'eggs'], ['check', 1, false, 'flour (sub)'], ['check', 0, true, 'jam'],
  ]);
  assert.deepEqual(show(panel.linesToBlocks('one\n- two\n3. three', 'ul')), [['ul', 0, false, 'one'], ['ul', 0, false, 'two'], ['ul', 0, false, 'three']]);
  assert.deepEqual(show(panel.linesToBlocks('plain line\n\nanother', 'p')), [['p', 0, false, 'plain line'], ['p', 0, false, ''], ['p', 0, false, 'another']]);
  assert.deepEqual(show(panel.linesToBlocks('Call **Sam**\n- milk', 'p')), [['p', 0, false, 'Call Sam'], ['ul', 0, false, 'milk']], 'Markdown, as a paste reads it');
  assert.deepEqual(panel.linesToBlocks('  \n \n', 'check'), []);
});

test('appending replaces the empty lines a note ends with', () => {
  const doc = [B('p', [T('title line')]), B('p', []), B('p', [T(' ')])];
  const out = panel.appendBlocks(doc, [B('check', [T('new')])]);
  assert.deepEqual(out.map(b => [b.type, fmt.docText([b])]), [['p', 'title line'], ['check', 'new']]);
  assert.deepEqual(panel.appendBlocks(doc, []), fmt.normaliseDoc(doc), 'nothing to add changes nothing');
  assert.ok(panel.docsEqual(doc, fmt.normaliseDoc(doc)));
  assert.ok(!panel.docsEqual(doc, out));
});

// ── Folders, the list, ids ───────────────────────────────────────────

test('folder dropdown items and names', () => {
  const folders = [{ id: 'L1', path: 'Work' }, { id: 'L2', path: 'Work/Clients' }];
  assert.deepEqual(panel.folderOptions(folders, 'L2'), [
    { text: 'No folder', value: 'none', selected: false },
    { text: 'Work', value: 'L1', selected: false },
    { text: 'Work › Clients', value: 'L2', selected: true },
  ]);
  assert.equal(panel.folderOptions(folders, 'gone')[0].selected, true, 'an unknown folder selects the first item');
  assert.equal(panel.folderOptions(folders, '', { first: 'All notes', firstValue: 'all' })[0].text, 'All notes');
  assert.equal(panel.folderName('L2', folders), 'Work › Clients');
  assert.equal(panel.folderName('', folders), '');
  const now = new Date(2026, 9, 2, 12, 0).getTime();
  assert.equal(panel.noteSubtitle({ folderId: 'L1', updated: now - 3 * 3600e3 }, folders, now), 'Work · edited 3 h');
  assert.equal(panel.noteSubtitle({ folderId: '', updated: now - 120e3 }, folders, now), 'edited 2 min');
});

test('message ids: hexadecimal as they are, Gmail\'s decimal form converted', () => {
  assert.equal(panel.apiMessageId('19a0c0de100000'), '19a0c0de100000');
  assert.equal(panel.apiMessageId('msg-f:1849302938475610123'), BigInt('1849302938475610123').toString(16));
  assert.equal(panel.apiMessageId('1849302938475610123'), BigInt('1849302938475610123').toString(16));
  assert.equal(panel.apiMessageId('msg-a:r-1234'), 'msg-a:r-1234', 'anything else is left alone');
  assert.equal(panel.apiMessageId('1234567890123456'), '1234567890123456', 'sixteen digits can be hexadecimal');
  assert.equal(panel.apiMessageId(''), '');
});

// ── The board ────────────────────────────────────────────────────────

test('board columns come from the labels under _Board: the usual four in order, then the rest', () => {
  const labels = [
    { id: 'L9', name: '_Board/Someday' }, { id: 'L4', name: '_Board/Done' }, { id: 'L1', name: '_Board/To do' },
    { id: 'L3', name: '_Board/Waiting' }, { id: 'L2', name: '_Board/Doing' }, { id: 'L8', name: '_Board/Admin' },
    { id: 'L0', name: '_Board' }, { id: 'L7', name: '_Board/Doing/Sub' }, { id: 'X', name: 'Board/Old' }, { id: 'N', name: '_Notes/Work' },
  ];
  const cols = panel.boardColumns(labels);
  assert.deepEqual(cols.map(c => c.title), ['To do', 'Doing', 'Waiting', 'Done', 'Admin', 'Someday']);
  assert.deepEqual(cols.filter(c => c.archiveOnDrop).map(c => c.title), ['Done']);
  assert.deepEqual(panel.boardColumns(labels, 'Board').map(c => c.title), ['Old'], 'another parent label');
  assert.deepEqual(panel.boardColumns([]), []);
});

test('moves: one column only, Done out of the Inbox, off the board touches nothing else', () => {
  const cols = panel.boardColumns([{ id: 'L1', name: '_Board/To do' }, { id: 'L2', name: '_Board/Doing' }, { id: 'L4', name: '_Board/Done' }]);
  assert.equal(panel.currentColumn(cols, ['INBOX', 'L2', 'L1']).title, 'To do', 'the first, in board order');
  assert.equal(panel.currentColumn(cols, ['INBOX']), null);
  assert.deepEqual(panel.boardDiff(cols, 'L2'), { addLabelIds: ['L2'], removeLabelIds: ['L1', 'L4'] });
  assert.deepEqual(panel.boardDiff(cols, 'L4'), { addLabelIds: ['L4'], removeLabelIds: ['L1', 'L2', 'INBOX'] });
  assert.deepEqual(panel.boardDiff(cols, ''), { addLabelIds: [], removeLabelIds: ['L1', 'L2', 'L4'] });
  assert.deepEqual(panel.boardOptions(cols, 'L2').map(o => [o.text, o.value, o.selected]),
    [['Not on the board', 'none', false], ['To do', 'L1', false], ['Doing', 'L2', true], ['Done', 'L4', false]]);
  assert.equal(panel.boardOptions(cols, '')[0].selected, true);
});

// ── Search matches ───────────────────────────────────────────────────

test('matches are marked inside bold, italic and links, split where they cross a run', () => {
  const search = require('../src/lib/search-logic.js');
  const runs = [T('see the '), T('Kestrel', { b: true }), T(' port'), T('al now', { href: 'https://example.com/' })];
  const text = runs.map(r => r.text).join('');
  const html = panel.runsHtml(runs, search.findMatches(text, search.queryTerms('kestrel portal')));
  assert.equal(html, 'see the <b><font color="#e8710a"><b>Kestrel</b></font></b> <font color="#e8710a"><b>port</b></font>' +
    '<a href="https://example.com/"><font color="#e8710a"><b>al</b></font> now</a>');
  assert.equal(panel.runsHtml(runs), panel.runsHtml(runs, []), 'no matches, nothing marked');
  assert.equal(panel.highlight('Café <x>', search.findMatches('Café <x>', search.queryTerms('cafe'))),
    '<font color="#e8710a"><b>Café</b></font> &lt;x&gt;');
});

test('card items with search terms: marks in every kind of line, and a count over the whole note', () => {
  const search = require('../src/lib/search-logic.js');
  const doc = [B('h2', [T('Invoice plan')]), B('check', [T('Send the invoice')]), B('ul', [T('invoices, two')]), B('p', [T('invoice')])];
  const { items, hits } = panel.cardItems(doc, { terms: search.queryTerms('invoice'), maxBlocks: 3 });
  assert.equal(hits, 4, 'the hidden last line counts too');
  assert.deepEqual(items.map(i => i.html), [
    '<b><font color="#e8710a"><b>Invoice</b></font> plan</b>',
    'Send the <font color="#e8710a"><b>invoice</b></font>',
    '• <font color="#e8710a"><b>invoice</b></font>s, two',
  ]);
  assert.equal(panel.cardItems(doc).hits, 0);
});

test('a search result: marked title, up to two excerpts, a count', () => {
  const search = require('../src/lib/search-logic.js');
  const doc = fmt.fromPlain(`${'filler '.repeat(20)}the glossary is ready\n${'more '.repeat(30)}glossary two\n${'x '.repeat(40)}glossary three`);
  const r = panel.searchResult('Glossary notes', doc, search.queryTerms('glossary'));
  assert.equal(r.count, 4);
  assert.equal(r.titleHtml, '<font color="#e8710a"><b>Glossary</b></font> notes');
  assert.equal(r.excerpts.length, 2);
  assert.match(r.excerpts[0], /^….*the <font color="#e8710a"><b>glossary<\/b><\/font> is ready.*…$/);
  assert.equal(panel.matchCount(1), '1 match');
  assert.equal(panel.matchCount(3), '3 matches');
  assert.deepEqual(panel.searchResult('Untitled', doc, search.queryTerms('absent')), { titleHtml: 'Untitled', excerpts: [], count: 0 });
});

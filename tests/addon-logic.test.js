// The add-on's pure parts: the browser APIs it supplies to Apps Script,
// and the board as the phone panel reads and changes it.

const test = require('node:test');
const assert = require('node:assert/strict');
const shims = require('../addon/src/shims.js');
const panel = require('../addon/src/panel-logic.js');

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
});

// ── Ids ──────────────────────────────────────────────────────────────

test('ids: hexadecimal as they are, Gmail\'s decimal forms of messages and conversations converted', () => {
  const hex = n => BigInt(n).toString(16);
  assert.equal(panel.apiId('19a0c0de100000'), '19a0c0de100000');
  assert.equal(panel.apiId('msg-f:1849302938475610123'), hex('1849302938475610123'));
  assert.equal(panel.apiId('thread-f:1849302938475610123'), hex('1849302938475610123'));
  assert.equal(panel.apiId('thread-a:1849302938475610123'), hex('1849302938475610123'));
  assert.equal(panel.apiId('1849302938475610123'), hex('1849302938475610123'));
  assert.equal(panel.apiId('msg-a:r-1234'), 'msg-a:r-1234', 'anything else is left alone');
  assert.equal(panel.apiId('thread-a:r-1234'), 'thread-a:r-1234');
  assert.equal(panel.apiId('1234567890123456'), '1234567890123456', 'sixteen digits can be hexadecimal');
  assert.equal(panel.apiId(''), '');
  assert.equal(panel.apiId(undefined), '');
});

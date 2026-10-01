// Notes as inserted messages: building them, recognising them, reading
// them back (including notes that arrived as ordinary mail), and keeping
// only the newest version of each.

const test = require('node:test');
const assert = require('node:assert/strict');
const notes = require('../src/lib/notes-logic.js');

const ID = 'k3x9q2m8w1z7p4r6t0yb';
const at = new Date(Date.UTC(2026, 9, 1, 21, 30, 0));

const decode = raw => notes.base64UrlDecode(raw);
const headersOf = bin => bin.slice(0, bin.indexOf('\r\n\r\n'));
const utf8 = bin => new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));

function bodyOf(bin) {
  const b64 = bin.slice(bin.indexOf('\r\n\r\n') + 4).replace(/\s+/g, '');
  return utf8(atob(b64));
}

// ── Building ─────────────────────────────────────────────────────────

test('a note is a plain-text message to and from the account, marked as a note', () => {
  const raw = notes.buildNoteRaw({ noteId: ID, title: 'Kestrel glossary', body: 'line one\nline two', account: 'me@example.com', date: at });
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  const head = headersOf(decode(raw));
  assert.match(head, /^From: me@example\.com$/m);
  assert.match(head, /^To: me@example\.com$/m);
  assert.match(head, /^Subject: Kestrel glossary$/m);
  assert.match(head, /^Date: Thu, 01 Oct 2026 21:30:00 GMT$/m);
  assert.match(head, new RegExp(`^X-Gkb-Note: ${ID}$`, 'm'));
  assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.equal(bodyOf(decode(raw)), 'line one\r\nline two');
  assert.equal(notes.noteIdOfRaw(raw), ID);
});

test('non-ASCII titles and bodies survive the round trip', () => {
  const title = 'Café notes – naïve “quotes” ✓ and a rather long tail that needs folding over several words';
  const body = 'Ünïcödé body ✓\n日本語\n🙂';
  const bin = decode(notes.buildNoteRaw({ noteId: ID, title, body, account: 'me@example.com', date: at }));
  const subjectLines = headersOf(bin).split('\r\n');
  const start = subjectLines.findIndex(l => l.startsWith('Subject: '));
  const folded = [subjectLines[start]];
  for (let i = start + 1; /^\s/.test(subjectLines[i] || ''); i++) folded.push(subjectLines[i]);
  for (const line of folded) assert.ok(line.length <= 78, `header line too long: ${line.length}`);
  for (const word of folded.join(' ').match(/=\?[^?]+\?B\?[^?]*\?=/g)) assert.ok(word.length <= 75, word);
  assert.equal(notes.decodeHeaderText(folded.join('\r\n').replace(/^Subject: /, '')), title);
  assert.equal(utf8(atob(bin.slice(bin.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''))), body.replace(/\n/g, '\r\n'));
});

test('a title cannot smuggle in headers of its own', () => {
  const raw = notes.buildNoteRaw({ noteId: ID, title: 'hi\r\nBcc: victim@example.com\r\n\r\nX', body: '', account: 'me@example.com\r\nX-Evil: 1', date: at });
  const head = headersOf(decode(raw));
  assert.doesNotMatch(head, /^Bcc:/mi);
  assert.doesNotMatch(head, /^X-Evil:/mi);
  assert.match(head, /^Subject: hi Bcc: victim@example\.com X$/m);
});

test('an untitled note is filed under its first line', () => {
  assert.equal(notes.titleFor('', '\n\n  Call Priya about the IFU  \nmore'), 'Call Priya about the IFU');
  assert.equal(notes.titleFor('  Real   title ', 'body'), 'Real title');
  assert.equal(notes.titleFor('', ''), '');
  assert.match(headersOf(decode(notes.buildNoteRaw({ noteId: ID, title: '', body: '', account: 'a@b.example', date: at }))), /^Subject: Untitled note$/m);
});

test('note ids are lower-case alphanumerics the builder accepts', () => {
  const id = notes.newNoteId();
  assert.match(id, /^[a-z0-9]{20}$/);
  assert.notEqual(notes.newNoteId(), id);
  assert.throws(() => notes.buildNoteRaw({ noteId: 'bad id', title: 't', body: '', account: 'a@b.example' }));
});

// ── What the worker lets through ─────────────────────────────────────

test('only a note, under user labels, may be inserted', () => {
  const raw = notes.buildNoteRaw({ noteId: ID, title: 't', body: 'b', account: 'a@b.example', date: at });
  assert.equal(notes.isNoteInsert({ raw, labelIds: ['Label_7'] }), true);
  assert.equal(notes.isNoteInsert({ raw }), true);

  for (const l of ['INBOX', 'inbox', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD']) {
    assert.equal(notes.isNoteInsert({ raw, labelIds: ['Label_7', l] }), false, l);
  }
  const plain = notes.base64UrlEncode('From: a@b.example\r\nTo: c@d.example\r\nSubject: hi\r\n\r\nX-Gkb-Note: aaaaaaaaaaaaaaaa\r\n');
  assert.equal(notes.isNoteInsert({ raw: plain }), false, 'the marker must be a header, not body text');
  assert.equal(notes.isNoteInsert({ raw: notes.base64UrlEncode('X-Gkb-Note: short\r\n\r\n') }), false, 'malformed id');
  assert.equal(notes.isNoteInsert({ raw, threadId: 'abc' }), false, 'no extra fields');
  assert.equal(notes.isNoteInsert({ raw, labelIds: 'Label_7' }), false);
  assert.equal(notes.isNoteInsert({ raw: '***' }), false);
  assert.equal(notes.isNoteInsert(null), false);
  assert.equal(notes.isNoteInsert({}), false);
});

// ── Reading back ─────────────────────────────────────────────────────

const b64u = s => notes.base64UrlEncode(Array.from(new TextEncoder().encode(s), b => String.fromCharCode(b)).join(''));

test('a stored note reads back with its id, title, date and body', () => {
  const n = notes.noteFromMessage({
    id: 'm1', threadId: 't1', internalDate: '1759354200000', labelIds: ['Label_9'], snippet: 'a &amp; b',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 'Café' }, { name: 'X-Gkb-Note', value: ID }],
      body: { data: b64u('a & b\r\nsecond ✓\r\n') },
    },
  });
  assert.equal(n.own, true);
  assert.equal(n.noteId, ID);
  assert.equal(n.key, `n:${ID}`);
  assert.equal(n.title, 'Café');
  assert.equal(n.updated, 1759354200000);
  assert.equal(n.snippet, 'a & b');
  assert.equal(n.body, 'a & b\nsecond ✓');
});

test('metadata-only messages have no body yet; untitled ones get a placeholder', () => {
  const n = notes.noteFromMessage({ id: 'm2', internalDate: '5', payload: { headers: [{ name: 'Subject', value: '' }] } });
  assert.equal(n.body, null);
  assert.equal(n.title, 'Untitled note');
  assert.equal(n.own, false);
  assert.equal(n.key, 'm:m2');
});

test('mail that arrived as a note prefers text/plain, falls back to HTML, honours the charset', () => {
  const alt = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64u('plain ✓') } },
      { mimeType: 'text/html', body: { data: b64u('<b>html</b>') } },
    ],
  };
  assert.equal(notes.extractText(alt), 'plain ✓');

  const htmlOnly = {
    mimeType: 'multipart/mixed',
    parts: [{
      mimeType: 'text/html',
      body: { data: b64u('<html><head><style>p{color:red}</style></head><body><p>Shopping</p><ul><li>Milk &amp; eggs</li><li>Bread</li></ul>Line<br>break&nbsp;here<script>alert(1)</script></body></html>') },
    }],
  };
  assert.equal(notes.extractText(htmlOnly), 'Shopping\n\n• Milk & eggs\n• Bread\nLine\nbreak here');

  const latin1 = {
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }],
    body: { data: notes.base64UrlEncode('caf\xe9') },
  };
  assert.equal(notes.extractText(latin1), 'café');

  const bogus = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-nonsense' }], body: { data: b64u('fine') } };
  assert.equal(notes.extractText(bogus), 'fine');
});

test('only the newest version of each note is live; the rest are stale', () => {
  const v = (key, updated, messageId) => ({ key, updated, messageId });
  const { live, stale } = notes.dedupeNotes([
    v('n:a', 10, 'a1'), v('n:a', 30, 'a3'), v('n:b', 20, 'b1'), v('n:a', 20, 'a2'), v('m:x', 5, 'x'),
  ]);
  assert.deepEqual(live.map(n => n.messageId), ['a3', 'b1', 'x']);
  assert.deepEqual(stale.map(n => n.messageId).sort(), ['a1', 'a2']);
});

test('header text decoding handles B and Q words, and adjacent words join', () => {
  assert.equal(notes.decodeHeaderText('=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?Q?_na=C3=AFve?='), 'Café naïve');
  assert.equal(notes.decodeHeaderText('plain'), 'plain');
});

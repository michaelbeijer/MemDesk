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

test('a note is a plain-text message to the account, from a sender Gmail will not file under Sent', () => {
  const raw = notes.buildNoteRaw({ noteId: ID, title: 'Kestrel glossary', body: 'line one\nline two', account: 'me@example.com', date: at });
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  const head = headersOf(decode(raw));
  assert.match(head, /^From: "Notes" <notes@notes\.invalid>$/m);
  assert.doesNotMatch(head, /^From:.*me@example\.com/m, 'not from the account itself');
  assert.match(head, /^To: me@example\.com$/m);
  assert.match(head, /^Reply-To: me@example\.com$/m, 'a reply still reaches the account');
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

test('the scratchpad has a fixed id; no other id can be asked for', () => {
  assert.match(notes.SCRATCHPAD_ID, /^[a-z0-9]{12,40}$/);
  assert.equal(notes.noteIdFor(null, notes.SCRATCHPAD_ID), notes.SCRATCHPAD_ID, 'a first save of the scratchpad');
  assert.equal(notes.noteIdFor({ own: true, noteId: 'abcdefabcdef12' }, notes.SCRATCHPAD_ID), 'abcdefabcdef12', 'a note keeps its own');
  assert.equal(notes.noteIdFor({ own: true, noteId: notes.SCRATCHPAD_ID }, ''), notes.SCRATCHPAD_ID);
  const fresh = notes.noteIdFor(null, 'aaaaaaaaaaaaaaaa');
  assert.notEqual(fresh, 'aaaaaaaaaaaaaaaa', 'any other id asked for is ignored');
  assert.match(fresh, /^[a-z0-9]{12,40}$/);
  assert.notEqual(notes.noteIdFor({ own: false, noteId: '' }, ''), '', 'an email turned into a note gets a new id');
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

test('a formatted note is multipart: readable text first, the HTML record second', () => {
  const raw = notes.buildNoteRaw({
    noteId: ID, title: 'Shopping', body: '• bread\n☐ milk', html: '<div><ul><li>bread</li></ul><p>Café ✓</p></div>',
    account: 'me@example.com', date: at,
  });
  assert.equal(notes.noteIdOfRaw(raw), ID, 'still recognisably a note');
  assert.equal(notes.isNoteInsert({ raw, labelIds: ['Label_9'] }), true);
  const bin = decode(raw);
  const m = /^Content-Type: multipart\/alternative; boundary="([^"]+)"$/m.exec(headersOf(bin));
  assert.ok(m, 'multipart/alternative');
  const parts = bin.split(`--${m[1]}`).slice(1, -1);
  assert.equal(parts.length, 2);
  const partBody = p => utf8(atob(p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\s+/g, '')));
  assert.match(parts[0], /Content-Type: text\/plain; charset=UTF-8/);
  assert.equal(partBody(parts[0]), '• bread\r\n☐ milk');
  assert.match(parts[1], /Content-Type: text\/html; charset=UTF-8/);
  assert.equal(partBody(parts[1]), '<div><ul><li>bread</li></ul><p>Café ✓</p></div>');
  assert.ok(!bin.slice(bin.indexOf('\r\n\r\n')).includes(`${m[1]}x`), 'boundary only where it belongs');
});

test('messageParts gives both renderings, decoded', () => {
  const p = notes.messageParts({
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64u('• bread\r\n') } },
      { mimeType: 'text/html', body: { data: b64u('<ul><li>bread ✓</li></ul>') } },
    ],
  });
  assert.deepEqual(p, { plain: '• bread', html: '<ul><li>bread ✓</li></ul>' });
  assert.deepEqual(notes.messageParts({ mimeType: 'text/plain', body: { data: b64u('only text') } }), { plain: 'only text', html: '' });
});

// ── Folders ──────────────────────────────────────────────────────────

const LABELS = [
  { id: 'L1', name: '_Notes' },
  { id: 'L2', name: '_Notes/work' },
  { id: 'L3', name: '_Notes/Personal' },
  { id: 'L4', name: '_Notes/Work/Clients' },
  { id: 'L5', name: '_Notes/Personal/Recipes' },
  { id: 'L6', name: '_Notes/Orphan/Child' },
  { id: 'L7', name: '_Board/To do' },
  { id: 'L8', name: '_NotesExtra' },
  { id: 'L9', name: '_Notes/' },
];

test('folders: the labels under the notes label, in tree order', () => {
  const tree = notes.folderTree(LABELS, '_Notes');
  assert.deepEqual(tree.map(f => [f.path, f.title, f.depth]), [
    ['Orphan/Child', 'Child', 1],
    ['Personal', 'Personal', 0],
    ['Personal/Recipes', 'Recipes', 1],
    ['work', 'work', 0],
    ['Work/Clients', 'Clients', 1],
  ]);
  assert.equal(tree.find(f => f.title === 'Clients').parentPath, 'Work');
  assert.deepEqual(notes.folderTree([], '_Notes'), []);
});

test('folders: a note is in at most one, and a move keeps the notes label', () => {
  const tree = notes.folderTree(LABELS, '_Notes');
  assert.equal(notes.folderOf(['L1', 'L5'], tree), 'L5');
  assert.equal(notes.folderOf(['L1'], tree), '');
  assert.equal(notes.folderOf(['L1', 'L4', 'L3'], tree), 'L3', 'two by hand: the first in tree order');
  const diff = notes.moveFolderDiff('L1', tree, 'L2');
  assert.deepEqual(diff.addLabelIds, ['L1', 'L2']);
  assert.deepEqual(diff.removeLabelIds.sort(), ['L3', 'L4', 'L5', 'L6']);
  assert.deepEqual(notes.moveFolderDiff('L1', tree, ''), { addLabelIds: ['L1'], removeLabelIds: tree.map(f => f.id) });
});

test('folders: names are checked before Gmail sees them', () => {
  assert.equal(notes.validateFolderTitle('Recipes', ['Work']), '');
  assert.match(notes.validateFolderTitle('  ', []), /name/);
  assert.match(notes.validateFolderTitle('a/b', []), /subfolder/);
  assert.match(notes.validateFolderTitle('work', ['Work']), /already/);
  assert.match(notes.validateFolderTitle('x'.repeat(61), []), /under 60/);
});

test('folders: renaming takes the whole branch with it', () => {
  const tree = notes.folderTree(LABELS, '_Notes');
  const personal = tree.find(f => f.path === 'Personal');
  assert.deepEqual(notes.renamePlan(personal, ' Home ', tree), [
    { id: 'L3', name: '_Notes/Home' },
    { id: 'L5', name: '_Notes/Home/Recipes' },
  ]);
  const recipes = tree.find(f => f.path === 'Personal/Recipes');
  assert.deepEqual(notes.renamePlan(recipes, 'Cooking', tree), [{ id: 'L5', name: '_Notes/Personal/Cooking' }]);
});

test('folders: only an empty folder under the notes label, with nothing under it, may be deleted', () => {
  const recipes = { id: 'L5', name: '_Notes/Personal/Recipes' };
  assert.equal(notes.isDeletableFolder(recipes, '_Notes', LABELS, 0), true);
  assert.equal(notes.isDeletableFolder(recipes, '_Notes', LABELS, 1), false, 'a note still in it');
  assert.equal(notes.isDeletableFolder(recipes, '_Notes', LABELS, undefined), false, 'not checked: no');
  assert.equal(notes.isDeletableFolder({ id: 'L3', name: '_Notes/Personal' }, '_Notes', LABELS, 0), false, 'has a subfolder');
  assert.equal(notes.isDeletableFolder({ id: 'L1', name: '_Notes' }, '_Notes', LABELS, 0), false, 'not the notes label itself');
  assert.equal(notes.isDeletableFolder({ id: 'L9', name: '_Notes/' }, '_Notes', LABELS, 0), false);
  assert.equal(notes.isDeletableFolder({ id: 'L7', name: '_Board/To do' }, '_Notes', LABELS, 0), false, 'not a board column');
  assert.equal(notes.isDeletableFolder({ id: 'L8', name: '_NotesExtra' }, '_Notes', LABELS, 0), false);
  assert.equal(notes.isDeletableFolder(recipes, '', LABELS, 0), false, 'no root known: nothing');
});

// ── Pictures ─────────────────────────────────────────────────────────

const PIC = 'p1c7ur3s0m3th1ng0000';
// A tiny PNG, and pictures big enough to need folding and the limit.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const bigB64 = n => btoa('x'.repeat(n));

test('a picture is a message of its own, shaped like a note, with no label', () => {
  const raw = notes.buildPictureRaw({ pictureId: PIC, title: 'Kestrel “site” visit', type: 'image/png', data: PNG, account: 'me@example.com', date: at });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const bin = decode(raw);
  const head = headersOf(bin);
  assert.match(head, /^From: "Notes" <notes@notes\.invalid>$/m);
  assert.match(head, /^To: me@example\.com$/m);
  assert.match(head, new RegExp(`^X-Gkb-Note: ${PIC}$`, 'm'), 'note-shaped: the worker’s rules hold for it');
  assert.match(head, /^X-Gkb-Picture: 1$/m);
  assert.match(head, /^Content-Type: multipart\/mixed; boundary="gkb-/m);
  assert.equal(notes.decodeHeaderText(/^Subject: (.*(?:\r\n .*)*)/m.exec(head)[1]), 'Picture in “Kestrel “site” visit”');
  assert.match(bin, /Content-Type: image\/png; name="picture\.png"/);
  const said = /charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(bin)[1];
  assert.match(utf8(atob(said.replace(/\s+/g, ''))), /^A picture in one of your notes/, 'and says what it is');
  assert.equal(notes.noteIdOfRaw(raw), PIC);
  assert.equal(notes.isNoteInsert({ raw, labelIds: [] }), true);
  assert.equal(notes.isPictureRaw(raw), true);
  assert.deepEqual(notes.pictureOfRaw(raw), { type: 'image/png', data: PNG });
  const untitled = headersOf(decode(notes.buildPictureRaw({ pictureId: PIC, title: '', type: 'image/jpeg', data: PNG, account: 'me@example.com', date: at })));
  assert.match(untitled, /^Subject: Picture in a note$/m);
});

test('a big picture comes back byte for byte; one over the limit is refused', () => {
  const data = bigB64(600000);
  const raw = notes.buildPictureRaw({ pictureId: PIC, title: 'x', type: 'image/jpeg', data, account: 'me@example.com', date: at });
  assert.ok(decode(raw).split('\r\n').every(l => l.length <= 998), 'no line longer than mail allows');
  assert.deepEqual(notes.pictureOfRaw(raw), { type: 'image/jpeg', data });
  assert.equal(notes.isPictureRaw(raw), true, 'told from its start alone');
  assert.equal(notes.isPictureInsert({ raw, labelIds: [] }), true);
  assert.throws(() => notes.buildPictureRaw({ pictureId: PIC, title: 'x', type: 'image/jpeg', data: bigB64(notes.MAX_PICTURE + 3), account: 'me@example.com' }), /too big/);
  // The biggest a picture can be still passes the script's check.
  const most = bigB64(notes.MAX_PICTURE - 2);
  const rawMost = notes.buildPictureRaw({
    pictureId: PIC, title: 'A title of eighty characters, which is as long as one can be in the subject line',
    type: 'image/jpeg', data: most, account: 'someone.with.a.long.address@example.com', date: at,
  });
  assert.equal(notes.isPictureInsert({ raw: rawMost, labelIds: [] }), true);
});

test('only pictures of the kinds a browser shows, in base64, with a proper id', () => {
  const base = { pictureId: PIC, title: '', type: 'image/png', data: PNG, account: 'me@example.com' };
  assert.throws(() => notes.buildPictureRaw({ ...base, type: 'image/svg+xml' }), /kind of picture/, 'no SVG: it can carry script');
  assert.throws(() => notes.buildPictureRaw({ ...base, type: 'text/html' }), /kind of picture/);
  assert.throws(() => notes.buildPictureRaw({ ...base, data: '<script>' }), /base64/);
  assert.throws(() => notes.buildPictureRaw({ ...base, data: '' }), /base64/);
  assert.throws(() => notes.buildPictureRaw({ ...base, pictureId: 'Short' }), /id/);
});

test('what is not a picture of ours is not read as one, and not let in as one', () => {
  const note = notes.buildNoteRaw({ noteId: ID, title: 'A note', body: 'text', account: 'me@example.com', date: at });
  assert.equal(notes.isPictureRaw(note), false, 'a note is not a picture');
  assert.equal(notes.pictureOfRaw(note), null);
  assert.equal(notes.isPictureInsert({ raw: note, labelIds: [] }), false);
  const pic = notes.buildPictureRaw({ pictureId: PIC, title: '', type: 'image/png', data: PNG, account: 'me@example.com', date: at });
  assert.equal(notes.isPictureInsert({ raw: pic, labelIds: ['Label_1'] }), false, 'a picture carries no label');
  assert.equal(notes.isPictureInsert({ raw: pic, labelIds: ['INBOX'] }), false);
  assert.equal(notes.isPictureInsert({ raw: pic }), true);
  assert.equal(notes.isPictureInsert({ raw: pic, labelIds: [], extra: 1 }), false);
  // Mail claiming to be a picture, without a note id of ours: no.
  const forged = notes.base64UrlEncode(`From: a@example.com\r\nX-Gkb-Picture: 1\r\nContent-Type: image/png\r\n\r\n${PNG}`);
  assert.equal(notes.isPictureRaw(forged), false);
  assert.equal(notes.pictureOfRaw(forged), null);
  assert.equal(notes.pictureOfRaw('***'), null);
  assert.equal(notes.pictureOfRaw(''), null);
  // A picture part that is not in base64 is not read.
  const bin = decode(pic).replace(/(Content-Type: image\/png[^\r]*\r\n[^\r]*\r\n)Content-Transfer-Encoding: base64/, '$1Content-Transfer-Encoding: 8bit');
  assert.notEqual(bin, decode(pic));
  assert.equal(notes.pictureOfRaw(notes.base64UrlEncode(bin)), null);
});

test('pictures go to Trash and back only if they are pictures of ours, each once, side by side', () => {
  const meta = (id, headers, labelIds = []) => ({ id, labelIds, payload: { headers } });
  const pic = (id, labelIds) => meta(id, [{ name: 'X-Gkb-Note', value: `${id}0000000000000` }, { name: 'X-Gkb-Picture', value: '1' }], labelIds);
  const answers = {
    aaaaaaaa: pic('aaaaaaaa'),
    bbbbbbbb: meta('bbbbbbbb', [{ name: 'X-Gkb-Note', value: ID }]), // a note, not a picture
    cccccccc: pic('cccccccc', ['TRASH']), // in Trash already
    dddddddd: meta('dddddddd', [{ name: 'X-Gkb-Picture', value: '1' }]), // no note id: not ours
    eeeeeeee: { error: new Error('404') },
    ffffffff: pic('ffffffff'),
  };
  const run = (ids, op, failing = []) => {
    const f = notes.picturesFlow(ids, op);
    const asked = [];
    let step = f.next();
    while (!step.done) {
      const [what, arg] = step.value;
      asked.push([what, what === 'readMany' ? arg.map(r => r[1]) : arg]);
      if (what === 'readMany') {
        assert.ok(arg.every(r => r[0] === 'GET' && r[2].format === 'metadata' && r[2].metadataHeaders.includes('X-Gkb-Picture')));
        step = f.next(arg.map(r => answers[r[1].split('/')[1]]));
      } else {
        step = f.next(arg.map(id => (failing.includes(id) ? null : { id })));
      }
    }
    return { moved: step.value, asked };
  };
  const t = run(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff', 'aaaaaaaa', 'not valid!'], 'trash', ['ffffffff']);
  assert.deepEqual(t.asked, [
    ['readMany', ['messages/aaaaaaaa', 'messages/bbbbbbbb', 'messages/cccccccc', 'messages/dddddddd', 'messages/eeeeeeee', 'messages/ffffffff']],
    ['trash', ['aaaaaaaa', 'ffffffff']],
  ], 'one read each, then the pictures of ours not in Trash yet, together');
  assert.deepEqual(t.moved, ['aaaaaaaa'], 'one that failed is not counted');
  assert.deepEqual(run(['cccccccc', 'aaaaaaaa', 'bbbbbbbb'], 'untrash').asked.at(-1), ['untrash', ['cccccccc']], 'only from Trash');
  assert.deepEqual(run([], 'trash').asked, [], 'nothing to do: nothing asked');
  assert.deepEqual(run(['aaaaaaaa'], 'delete').asked, [], 'only trash and untrash');
});

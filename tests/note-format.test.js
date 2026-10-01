// Formatted notes: the block model, HTML out and back in, the plain-text
// rendering, and reading mail that was never written by the editor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../src/lib/note-format.js');

const B = (type, runs, extra = {}) => fmt.block(type, runs, extra);
const T = (text, marks = {}) => ({ text, ...marks });
const roundTrip = doc => fmt.parseHtml(fmt.toHtml(doc));

// ── Round trips ──────────────────────────────────────────────────────

const CASES = {
  'plain paragraphs and an empty line': [B('p', [T('one')]), B('p', []), B('p', [T('three')])],
  'headings': [B('h1', [T('Big')]), B('h2', [T('Middle')]), B('h3', [T('Small')]), B('p', [T('body')])],
  'marks, alone and together': [B('p', [T('plain '), T('bold', { b: true }), T(' '), T('it', { i: true }), T(' '),
    T('gone', { s: true }), T(' '), T('all', { b: true, i: true, s: true })])],
  'links with and without marks': [B('p', [T('see '), T('the site', { href: 'https://example.com/a?b=1&c=2' }),
    T(' or '), T('mail', { href: 'mailto:sam@example.com', b: true })])],
  'nested bullets, numbers and checks': [
    B('ul', [T('a')]), B('ul', [T('a.1')], { level: 1 }), B('ul', [T('a.1.1')], { level: 2 }),
    B('ul', [T('a.1.1.1')], { level: 3 }), B('ul', [T('b')]),
    B('ol', [T('first')]), B('ol', [T('nested')], { level: 1 }), B('ol', [T('second')]),
    B('check', [T('done')], { checked: true }), B('check', [T('todo')]), B('check', [T('sub')], { level: 1, checked: true }),
  ],
  'a list kind changing at the same level': [B('ul', [T('bullet')]), B('ol', [T('number')]), B('check', [T('box')])],
  'a nested list of another kind': [B('ol', [T('step')]), B('check', [T('sub-task')], { level: 1 }), B('ol', [T('next step')])],
  'empty list items': [B('ul', []), B('ol', []), B('check', [])],
  'characters HTML cares about': [B('p', [T('<script>alert("x")</script> & &amp; \' " > <')])],
  'spaces: doubled, leading, trailing, across tags': [
    B('p', [T('  two  spaces  ')]), B('p', [T('a '), T(' b', { b: true }), T(' c')]), B('p', [T(' ')]),
  ],
  'unicode': [B('p', [T('Café naïve ✓ 日本語 🙂 — “quotes” ☐ ☑')]), B('check', [T('☐ literal box inside the text')])],
};

for (const [name, doc] of Object.entries(CASES)) {
  test(`round trip: ${name}`, () => {
    assert.deepEqual(roundTrip(doc), fmt.normaliseDoc(doc));
  });
}

test('the HTML is safe whatever the text says', () => {
  const html = fmt.toHtml([B('p', [T('<img src=x onerror=alert(1)>', { href: 'javascript:alert(1)' })])]);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /href=/, 'an unsafe link is not a link');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the HTML is a properly nested list', () => {
  const html = fmt.toHtml([B('ul', [T('a')]), B('ul', [T('b')], { level: 1 }), B('p', [T('after')])]);
  assert.match(html, /<ul[^>]*><li[^>]*>a<ul[^>]*><li[^>]*>b<\/li><\/ul><\/li><\/ul><p/);
});

// ── The model ────────────────────────────────────────────────────────

test('normalising: neighbours merge, empties go, levels cannot jump', () => {
  const doc = fmt.normaliseDoc([
    { type: 'p', runs: [T('a'), T(''), T('b'), T('c', { b: true }), T('d', { b: true })] },
    { type: 'ul', level: 2, runs: [T('too deep')] },
    { type: 'ul', level: 7, runs: [T('way too deep')] },
    { type: 'nonsense', runs: [T('x')] },
    { type: 'p', level: 2, checked: true, runs: [] },
  ]);
  assert.deepEqual(doc[0].runs, [T('ab'), T('cd', { b: true })]);
  assert.equal(doc[1].level, 0, 'first list item is level 0');
  assert.equal(doc[2].level, 1, 'at most one deeper than the one before');
  assert.equal(doc[3].type, 'p');
  assert.deepEqual([doc[4].level, doc[4].checked], [0, false]);
  assert.deepEqual(fmt.normaliseDoc([]), fmt.emptyDoc());
  assert.deepEqual(fmt.normaliseDoc(null), fmt.emptyDoc());
});

test('links: web and mail only, bare domains and addresses completed', () => {
  assert.equal(fmt.safeHref('https://example.com/x'), 'https://example.com/x');
  assert.equal(fmt.safeHref('http://example.com'), 'http://example.com/');
  assert.equal(fmt.safeHref('example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(fmt.safeHref('www.example.co.uk'), 'https://www.example.co.uk/');
  assert.equal(fmt.safeHref('sam@example.com'), 'mailto:sam@example.com');
  assert.equal(fmt.safeHref('mailto:sam@example.com'), 'mailto:sam@example.com');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x',
    'not a link', 'foo', '', 'https://exa mple.com', '<https://example.com>']) {
    assert.equal(fmt.safeHref(bad), '', bad);
  }
});

test('docText, isEmpty', () => {
  const doc = [B('h1', [T('Title')]), B('ul', [T('a '), T('b', { b: true })])];
  assert.equal(fmt.docText(doc), 'Title\na b');
  assert.equal(fmt.isEmpty(doc), false);
  assert.equal(fmt.isEmpty([B('p', [T('  ')]), B('ul', [])]), true);
});

// ── Plain text ───────────────────────────────────────────────────────

test('the plain-text part reads like a note', () => {
  const plain = fmt.toPlain([
    B('h1', [T('Shopping')]),
    B('ul', [T('bread')]), B('ul', [T('rye')], { level: 1 }),
    B('ol', [T('one')]), B('ol', [T('two')]), B('ol', [T('two-a')], { level: 1 }), B('ol', [T('three')]),
    B('check', [T('milk')], { checked: true }), B('check', [T('eggs')]),
    B('p', [T('see '), T('the site', { href: 'https://example.com/' }), T(' and '), T('example.com', { href: 'https://example.com/' })]),
    B('ol', [T('restarts')]),
  ]);
  assert.equal(plain, [
    'Shopping', '• bread', '  • rye', '1. one', '2. two', '  1. two-a', '3. three',
    '☑ milk', '☐ eggs', 'see the site (https://example.com/) and example.com', '1. restarts',
  ].join('\n'));
});

test('plain text in: one block per line, list-looking lines become lists', () => {
  const doc = fmt.fromPlain('Title\n- one\n  - nested\n• two\n1. first\n☑ done\n☐ todo\n\n*not a list');
  assert.deepEqual(doc.map(b => [b.type, b.level, b.checked, fmt.docText([b])]), [
    ['p', 0, false, 'Title'], ['ul', 0, false, 'one'], ['ul', 1, false, 'nested'], ['ul', 0, false, 'two'],
    ['ol', 0, false, 'first'], ['check', 0, true, 'done'], ['check', 0, false, 'todo'],
    ['p', 0, false, ''], ['p', 0, false, '*not a list'],
  ]);
  assert.deepEqual(fmt.fromPlain(''), fmt.emptyDoc());
});

test('the plain-text part reads back as the same structure', () => {
  const doc = [B('ul', [T('a')]), B('ul', [T('b')], { level: 1 }), B('check', [T('c')], { checked: true }), B('ol', [T('d')])];
  assert.deepEqual(fmt.fromPlain(fmt.toPlain(doc)), fmt.normaliseDoc(doc));
});

// ── Mail that was never written by the editor ────────────────────────

test('Gmail-composed HTML: divs, brs, bold, lists and links come across', () => {
  const html = '<div dir="ltr"><div>Hi <b>there</b>,</div><div><br></div><div>Items:</div>' +
    '<ul><li>one</li><li><i>two</i></li></ul><div>See <a href="https://example.com">this</a>.<br>Next line</div></div>';
  const doc = fmt.parseHtml(html);
  assert.deepEqual(doc.map(b => [b.type, fmt.docText([b])]), [
    ['p', 'Hi there,'], ['p', ''], ['p', 'Items:'], ['ul', 'one'], ['ul', 'two'], ['p', 'See this.'], ['p', 'Next line'],
  ]);
  assert.deepEqual(doc[0].runs, [T('Hi '), T('there', { b: true }), T(',')]);
  assert.deepEqual(doc[5].runs[1], T('this', { href: 'https://example.com/' }));
});

test('Outlook-style spans, headings beyond h3, entities, and things that must not come across', () => {
  const html = '<html><head><style>p{color:red}</style><title>t</title></head><body>' +
    '<h4>Small heading</h4><p><span style="font-weight:700">bold</span> <span style="font-style: italic">it</span> ' +
    '<span style="text-decoration: line-through">gone</span> &rsquo;quote&rsquo; &amp;&nbsp;more</p>' +
    '<script>alert(1)</script><!-- a comment --><p>x<img src="y.png" alt="pic">z</p>' +
    '<p><a href="javascript:alert(1)">not a link</a></p></body></html>';
  const doc = fmt.parseHtml(html);
  assert.equal(doc[0].type, 'h3');
  assert.deepEqual(doc[1].runs, [T('bold', { b: true }), T(' '), T('it', { i: true }), T(' '), T('gone', { s: true }), T(' ’quote’ & more')]);
  assert.equal(fmt.docText([doc[2]]), 'xz');
  assert.deepEqual(doc[3].runs, [T('not a link')]);
  assert.ok(!fmt.docText(doc).includes('alert'));
  assert.ok(!fmt.docText(doc).includes('color'));
});

test('a list of check glyphs from elsewhere becomes a checklist', () => {
  const doc = fmt.parseHtml('<ul><li>☑ done</li><li>☐ todo</li></ul>');
  assert.deepEqual(doc.map(b => [b.type, b.checked, fmt.docText([b])]), [['check', true, 'done'], ['check', false, 'todo']]);
});

test('broken HTML does not break the reader', () => {
  for (const html of ['<b>unclosed', '</i>stray close', '<ul><li>no end', 'a < b > c', '<', '<<<>>>', '<a href="x', '<li>orphan</li>']) {
    const doc = fmt.parseHtml(html);
    assert.ok(Array.isArray(doc) && doc.length >= 1, html);
  }
  assert.equal(fmt.docText(fmt.parseHtml('a < b > c')), 'a < b > c');
  assert.equal(fmt.docText(fmt.parseHtml('<li>orphan</li>after')), 'orphan\nafter');
});

test('parts: HTML when there is some, otherwise plain text', () => {
  assert.equal(fmt.docFromParts({ plain: 'ignored', html: '<p><b>x</b></p>' })[0].runs[0].b, true);
  assert.equal(fmt.docText(fmt.docFromParts({ plain: 'line one\nline two', html: '  ' })), 'line one\nline two');
  assert.deepEqual(fmt.docFromParts({}), fmt.emptyDoc());
});

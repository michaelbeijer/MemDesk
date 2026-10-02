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
  const doc = fmt.parseHtml(html).filter(b => fmt.docText([b])); // without the space between paragraphs
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

// ── Pasting ──────────────────────────────────────────────────────────

// [type, level, checked, text with *bold* /italic/ ~struck~ marks]
const shape = doc => doc.map(b => [b.type, b.level, b.checked, b.runs.map(r =>
  `${r.b ? '*' : ''}${r.i ? '/' : ''}${r.s ? '~' : ''}${r.text}${r.s ? '~' : ''}${r.i ? '/' : ''}${r.b ? '*' : ''}${r.href ? `<${r.href}>` : ''}`).join('')]);

test('paste from Google Docs: the bold wrapper is not bold, spans say what is, lists nest', () => {
  const span = (style, text) => `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;${style}font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre-wrap;">${text}</span>`;
  const p = inner => `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${inner}</p>`;
  const html = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-4f1c2a7e-7fff-1b2c-9d3e-123456789abc">' +
    `<h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;">${span('font-weight:400;font-style:normal;', 'Rates')}</h2>` +
    p(span('font-weight:700;font-style:normal;', 'Bold') + span('font-weight:400;font-style:normal;', ', plain and ') + span('font-weight:400;font-style:italic;', 'italic')) +
    '<br>' +
    `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:disc;" aria-level="1">${p(span('font-weight:400;', 'first'))}</li>` +
    `<ul style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:circle;" aria-level="2">${p(span('font-weight:400;', 'nested'))}</li></ul></ul>` +
    `<ol style="margin-top:0;margin-bottom:0;"><li dir="ltr" aria-level="1">${p(span('', 'step'))}</li></ol>` +
    `<ul><li role="checkbox" aria-checked="true">${p(span('', 'ticked'))}</li><li role="checkbox" aria-checked="false">${p(span('', 'open'))}</li></ul>` +
    '</b><br class="Apple-interchange-newline">';
  assert.deepEqual(shape(fmt.pasteDoc({ html, text: 'ignored' })), [
    ['h2', 0, false, 'Rates'],
    ['p', 0, false, '*Bold*, plain and /italic/'],
    ['p', 0, false, ''],
    ['ul', 0, false, 'first'],
    ['ul', 1, false, 'nested'],
    ['ol', 0, false, 'step'],
    ['check', 0, true, 'ticked'],
    ['check', 0, false, 'open'],
  ]);
});

test('paste from Word: paragraphs are lines, mso-list paragraphs are lists, bullets or numbers', () => {
  const item = (level, list, marker, text) => `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'>` +
    `<![if !supportLists]><span style='font-family:Symbol;mso-fareast-font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>\n`;
  const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head>' +
    '<meta name=Generator content="Microsoft Word 15"><style><!-- p.MsoNormal {margin:0cm; font-size:11.0pt;} --></style>' +
    '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--></head>' +
    '<body lang=EN-GB style=\'tab-interval:36.0pt\'><!--StartFragment-->' +
    '<h1>Kestrel<o:p></o:p></h1>\n<p class=MsoNormal><b>Bold</b> and <i>italic</i> and <span style=\'color:red\'>red</span><o:p></o:p></p>\n' +
    '<p class=MsoNormal><o:p>&nbsp;</o:p></p>\n' +
    item(1, 'l0', '·', 'Apples') + item(2, 'l0', 'o', 'Green') + item(1, 'l1', '1.', 'First step') + item(1, 'l1', '2.', 'Second step') +
    item(2, 'l1', 'a.', 'detail') +
    '<p class=MsoNormal>After<o:p></o:p></p>\n<!--EndFragment--></body></html>';
  assert.deepEqual(shape(fmt.pasteDoc({ html })), [
    ['h1', 0, false, 'Kestrel'],
    ['p', 0, false, '*Bold* and /italic/ and red'],
    ['p', 0, false, ' '], // Word's empty line is an &nbsp;
    ['ul', 0, false, 'Apples'],
    ['ul', 1, false, 'Green'],
    ['ol', 0, false, 'First step'],
    ['ol', 0, false, 'Second step'],
    ['ol', 1, false, 'detail'],
    ['p', 0, false, 'After'],
  ]);
});

test('paste from Excel, or any table: a line per row, " | " between cells, heading cells bold', () => {
  const excel = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta name=ProgId content=Excel.Sheet>' +
    '<style>.xl65{font-weight:700;}</style></head><body link="#0563C1"><table border=0 cellpadding=0 cellspacing=0 width=128>' +
    '<!--StartFragment--><col width=64 span=2><tr height=20><td height=20 class=xl65 width=64>Term</td><td class=xl65 width=64>Rate</td></tr>\n' +
    '<tr height=20><td height=20>Proofreading</td><td align=right x:num>0.04</td></tr>\n<tr><td>Empty</td><td></td><td>third</td></tr>' +
    '<!--EndFragment--></table></body></html>';
  const doc = fmt.pasteDoc({ html: excel, text: 'Term\tRate\r\nProofreading\t0.04\r\n' });
  assert.deepEqual(fmt.docText(doc).split('\n'), ['Term | Rate', 'Proofreading | 0.04', 'Empty | | third']);
  assert.equal(fmt.hasFormatting(doc), false, 'nothing to format: it goes in as text');
  assert.deepEqual(shape(fmt.parseHtml('<table><thead><tr><th>Name</th><th>Note</th></tr></thead><tbody><tr><td><b>Sam</b></td><td>ok</td></tr></tbody></table>')), [
    ['p', 0, false, '*Name* | *Note*'],
    ['p', 0, false, '*Sam* | ok'],
  ]);
});

test('paste from a web page: space under paragraphs, task-list boxes, preformatted lines', () => {
  const html = '<meta charset="utf-8"><p style="box-sizing: border-box; margin: 0px 0px 16px; color: rgb(31, 35, 40);">Para <strong>one</strong></p>' +
    '<p style="margin-top: 0px; margin-bottom: 16px;">Para two</p>' +
    '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled="" checked=""> shipped</li>' +
    '<li class="task-list-item"><input type="checkbox" disabled> <em>waiting</em></li></ul>' +
    '<pre style="padding: 16px;"><code>\nif (x) {\n  y = 2;\n}\n</code></pre><p style="margin: 0">tight</p><p style="margin: 0">lines</p><h2>Heading</h2><p>last</p>';
  assert.deepEqual(shape(fmt.pasteDoc({ html })), [
    ['p', 0, false, 'Para *one*'],
    ['p', 0, false, ''],
    ['p', 0, false, 'Para two'],
    ['p', 0, false, ''],
    ['check', 0, true, 'shipped'],
    ['check', 0, false, '/waiting/'],
    ['p', 0, false, 'if (x) {'],
    ['p', 0, false, '  y = 2;'],
    ['p', 0, false, '}'],
    ['p', 0, false, 'tight'],
    ['p', 0, false, 'lines'],
    ['h2', 0, false, 'Heading'],
    ['p', 0, false, 'last'],
  ]);
});

test('a note of ours has no space between paragraphs, however its <p>s are styled', () => {
  assert.deepEqual(fmt.docText(fmt.parseHtml('<div data-gkb-note="1"><p>one</p><p>two</p></div>')), 'one\ntwo');
  assert.deepEqual(fmt.docText(fmt.parseHtml('<div><p>one</p><p>two</p></div>')), 'one\n\ntwo');
});

test('paste from a note: the blocks keep their kind, level and box', () => {
  const html = '<div class="blk" data-type="check" data-level="0" data-checked="1" style="color: rgb(31, 31, 31);">☐ not a glyph</div>' +
    '<div class="blk" data-type="ul" data-level="1"><b>sub</b></div><div class="blk" data-type="h3">Small</div><div class="blk" data-type="p"><br></div>' +
    '<div class="blk" data-type="ol" data-level="0">n</div>';
  assert.deepEqual(shape(fmt.pasteDoc({ html })), [
    ['check', 0, true, '☐ not a glyph'],
    ['ul', 1, false, '*sub*'],
    ['h3', 0, false, 'Small'],
    ['p', 0, false, ''],
    ['ol', 0, false, 'n'],
  ]);
});

test('Markdown: headings, marks, links, lists, checklists, quotes, code', () => {
  const md = [
    '# Title ##', '', 'Some **bold**, __also bold__, *it*, _it too_, ~~gone~~, `code *not italic*` and [a link](https://example.com/x "t").',
    'An autolink <https://example.org> and \\*escaped\\* stars, snake_case_name, 2 * 3 * 4, file_name.txt.',
    '', '', '', '## Two', '### Three', '#### Four', '#hashtag',
    '- one', '', '- two', '  - nested', '    - deeper', '1. first', '   1. sub (three spaces)', '2) second',
    '* [ ] todo', '- [x] done', '+ plus', '• bullet', '☑ ticked box', '☐ open box',
    '> quoted', '> > twice', '---', '```js', '  const x = 1;  ', '```', '***', 'end  ', '', '',
  ].join('\n');
  assert.deepEqual(shape(fmt.fromMarkdown(md)), [
    ['h1', 0, false, 'Title'],
    ['p', 0, false, 'Some *bold*, *also bold*, /it/, /it too/, ~gone~, code *not italic* and a link<https://example.com/x>.'],
    ['p', 0, false, 'An autolink https://example.org<https://example.org/> and *escaped* stars, snake_case_name, 2 * 3 * 4, file_name.txt.'],
    ['h2', 0, false, 'Two'],
    ['h3', 0, false, 'Three'],
    ['h3', 0, false, 'Four'],
    ['p', 0, false, '#hashtag'],
    ['ul', 0, false, 'one'],
    ['ul', 0, false, 'two'],
    ['ul', 1, false, 'nested'],
    ['ul', 2, false, 'deeper'],
    ['ol', 0, false, 'first'],
    ['ol', 1, false, 'sub (three spaces)'],
    ['ol', 0, false, 'second'],
    ['check', 0, false, 'todo'],
    ['check', 0, true, 'done'],
    ['ul', 0, false, 'plus'],
    ['ul', 0, false, 'bullet'],
    ['check', 0, true, 'ticked box'],
    ['check', 0, false, 'open box'],
    ['p', 0, false, 'quoted'],
    ['p', 0, false, 'twice'],
    ['p', 0, false, '  const x = 1;  '],
    ['p', 0, false, 'end'],
  ]);
});

test('Markdown: a table is a line per row, its heading row bold', () => {
  const md = '| Term | Meaning |\n|:-----|-------:|\n| **top** | above |\n| a \\| b | [c](example.com) |';
  assert.deepEqual(shape(fmt.fromMarkdown(md)), [
    ['p', 0, false, '*Term* | *Meaning*'],
    ['p', 0, false, '*top* | above'],
    ['p', 0, false, 'a | b | c<https://example.com/>'],
  ]);
});

test('Markdown: links only to the web or mail', () => {
  const [b] = fmt.fromMarkdown('[x](javascript:alert(1)) [y](mailto:sam@example.com) [z](data:text/html,hi)');
  assert.ok(b.runs.every(r => !r.href || /^(https?|mailto):/.test(r.href)));
  assert.equal(b.runs.find(r => r.text === 'y').href, 'mailto:sam@example.com');
  assert.ok(!b.runs.some(r => r.text === 'x' && r.href));
});

test('what counts as Markdown', () => {
  for (const s of ['**bold** word', 'a\n- item', '# Title', '| a | b |\n|---|---|', '1. step\n2. step', 'see [this](https://x.com)',
    'run `npm test`', '~~old~~ new', '> quote', '```\ncode\n```', '• one\n• two', '☐ box']) {
    assert.equal(fmt.looksLikeMarkdown(s), true, s);
  }
  for (const s of ['Just a sentence.', 'Price: 5 * 3 = 15', 'snake_case_name', 'mail a_b@c.com', '2026. A year', 'C:\\Users\\me', '#hashtag', '']) {
    assert.equal(fmt.looksLikeMarkdown(s), false, s);
  }
});

test('what a paste becomes', () => {
  // HTML with formatting wins.
  assert.equal(fmt.pasteDoc({ html: '<b>x</b>', text: '**y**' })[0].runs[0].text, 'x');
  // HTML that adds nothing (a code editor's coloured text) gives way to Markdown in the text.
  const vscode = '<div style="color: #cccccc;background-color: #1f1f1f;"><div><span style="color: #569cd6;">**bold**</span><span> text</span></div></div>';
  assert.deepEqual(shape(fmt.pasteDoc({ html: vscode, text: '**bold** text' })), [['p', 0, false, '*bold* text']]);
  // …but stays when the text is not Markdown either.
  assert.deepEqual(shape(fmt.pasteDoc({ html: '<p>a</p><p>b</p>', text: 'a\n\nb' })), [['p', 0, false, 'a'], ['p', 0, false, ''], ['p', 0, false, 'b']]);
  // Plain text is left to the editor.
  assert.equal(fmt.pasteDoc({ text: 'plain words\nsecond line' }), null);
  assert.equal(fmt.pasteDoc({ html: '  ', text: '' }), null);
  assert.equal(fmt.pasteDoc({}), null);
  // Empty lines at either end go.
  assert.deepEqual(shape(fmt.pasteDoc({ html: '<div><br></div><div><b>x</b></div><div><br></div><br>' })), [['p', 0, false, '*x*']]);
  // Nothing dangerous survives.
  const evil = fmt.pasteDoc({ html: '<b style="color:red">loud</b><img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">click</a>' });
  assert.deepEqual(shape(evil), [['p', 0, false, '*loud*click']]);
});

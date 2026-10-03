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

// A table block as [head, align, rows of cell texts with marks shown].
const grid = b => [b.head, b.align, b.rows.map(r => r.map(c => c.runs.map(x =>
  `${x.b ? '*' : ''}${x.i ? '/' : ''}${x.text}${x.i ? '/' : ''}${x.b ? '*' : ''}${x.href ? `<${x.href}>` : ''}`).join('')))];
const tableOf = doc => doc.find(b => b.type === 'table');

test('paste from Excel: a table, as wide as its widest row', () => {
  const excel = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta name=ProgId content=Excel.Sheet>' +
    '<style>.xl65{font-weight:700;}</style></head><body link="#0563C1"><table border=0 cellpadding=0 cellspacing=0 width=128>' +
    '<!--StartFragment--><col width=64 span=2><tr height=20><td height=20 class=xl65 width=64>Term</td><td class=xl65 width=64>Rate</td></tr>\n' +
    '<tr height=20><td height=20>Proofreading</td><td align=right x:num>0.04</td></tr>\n<tr><td>Empty</td><td></td><td>third</td></tr>' +
    '<!--EndFragment--></table></body></html>';
  const doc = fmt.pasteDoc({ html: excel, text: 'Term\tRate\r\nProofreading\t0.04\r\n' });
  assert.equal(doc.length, 1, 'just the table');
  assert.deepEqual(grid(fmt.normaliseDoc(doc)[0]), [false, ['', '', ''], [['Term', 'Rate', ''], ['Proofreading', '0.04', ''], ['Empty', '', 'third']]]);
  assert.equal(fmt.hasFormatting(doc), true);
  assert.equal(fmt.onlyTable(doc), doc[0]);
  assert.deepEqual(fmt.docText(doc).split('\n'), ['Term | Rate | ', 'Proofreading | 0.04 | ', 'Empty |  | third']);
});

test('paste a table from a web page, Google Sheets or Word: heading rows, alignment, marks, lines in cells', () => {
  // A heading row (<thead> or <th>), its cells plain; the rest keep their marks.
  const web = fmt.parseHtml('<table><thead><tr><th>Name</th><th style="text-align:right">Rate</th></tr></thead>' +
    '<tbody><tr><td><b>Sam</b></td><td style="text-align:right">0,08</td></tr><tr><td>Jo <a href="https://jo.example">site</a></td><td align="right">0,10</td></tr></tbody></table>');
  assert.deepEqual(grid(tableOf(web)), [true, ['', 'right'], [['Name', 'Rate'], ['*Sam*', '0,08'], ['Jo site<https://jo.example/>', '0,10']]]);
  // Google Sheets: bold and alignment as cell styles.
  const sheets = '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>' +
    '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" data-sheets-root="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody>' +
    '<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;">Language</td><td style="overflow:hidden;font-weight:bold;text-align:center;">Words</td></tr>' +
    '<tr style="height:21px;"><td style="overflow:hidden;">NL</td><td style="overflow:hidden;text-align:center;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:1200}">1200</td></tr></tbody></table>';
  assert.deepEqual(grid(tableOf(fmt.pasteDoc({ html: sheets }))), [false, ['', 'center'], [['*Language*', '*Words*'], ['NL', '1200']]]);
  // Word: paragraphs inside cells are lines; a row label in <th> is bold.
  const word = '<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0><tr><td width=200 valign=top><p class=MsoNormal>Source<o:p></o:p></p></td>' +
    '<td valign=top><p class=MsoNormal>Line one<o:p></o:p></p><p class=MsoNormal>Line <b>two</b><o:p></o:p></p></td></tr>' +
    '<tr><th>Label</th><td>x<br>y</td></tr></table>';
  assert.deepEqual(grid(tableOf(fmt.parseHtml(word))), [false, ['', ''], [['Source', 'Line one\nLine *two*'], ['*Label*', 'x\ny']]]);
  // A cell spanning columns keeps the next ones in place; a table in a cell is its text.
  const span = fmt.parseHtml('<table><tr><td colspan="2">wide</td><td>c</td></tr><tr><td>a</td><td>b</td><td><table><tr><td>in</td><td>ner</td></tr><tr><td>x</td></tr></table></td></tr></table>');
  assert.deepEqual(grid(tableOf(span))[2], [['wide', '', 'c'], ['a', 'b', 'in ner\nx']]);
  // Text around a table stays around it.
  assert.deepEqual(fmt.parseHtml('<p>before</p><table><tr><td>1</td></tr></table><p>after</p>').map(b => b.type), ['p', 'table', 'p']);
  // An empty table is no table.
  assert.deepEqual(fmt.parseHtml('<p>x</p><table><tr></tr></table>').map(b => b.type), ['p']);
});

test('tables: HTML out and back, plain text out and back, Markdown in', () => {
  const t = fmt.table([
    [{ runs: [T('Term')] }, { runs: [T('Rate')] }],
    [{ runs: [T('proof', { b: true }), T('reading')] }, { runs: [T('0,04')] }],
    [{ runs: [T('two'), T('\nlines')] }, { runs: [T('a | b'), T(' link', { href: 'https://example.com/' })] }],
  ], { head: true, align: ['', 'right'] });
  const doc = [B('p', [T('Rates')]), t, B('p', [T('end')])];
  const html = fmt.toHtml(doc);
  assert.match(html, /<table data-gkb-table="1"[^>]*><thead><tr><th style="[^"]*">Term<\/th><th style="[^"]*text-align:right">Rate<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /two<br>lines/);
  assert.deepEqual(grid(tableOf(roundTrip(doc))), grid(fmt.normaliseDoc([t])[0]));
  assert.deepEqual(roundTrip(doc).map(b => b.type), ['p', 'table', 'p']);

  assert.equal(fmt.toPlain(doc), 'Rates\nTerm | Rate\nproofreading | 0,04\ntwo lines | a | b link (https://example.com/)\nend');
  // Plain text written as a Markdown table reads as one; one | line alone is just a line.
  const back = tableOf(fmt.fromPlain('| Term | Rate |\n| --- | ---: |\n| proofreading | 0,04 |\n| a \\| b | c |'));
  assert.deepEqual(grid(back), [true, ['', 'right'], [['Term', 'Rate'], ['proofreading', '0,04'], ['a | b', 'c']]]);
  assert.deepEqual(fmt.fromPlain('| not a table |').map(b => b.type), ['p']);

  const md = 'Rates:\n\n| Language | Words | Due |\n|:---|:---:|---:|\n| **NL** | 1200 | Fri<br>noon |\n| DE | | Mon |\n\nDone.';
  assert.equal(fmt.looksLikeMarkdown(md), true);
  const mdDoc = fmt.pasteDoc({ text: md });
  assert.deepEqual(mdDoc.map(b => b.type), ['p', 'p', 'table', 'p', 'p']);
  assert.deepEqual(grid(tableOf(mdDoc)), [true, ['', 'center', 'right'], [['Language', 'Words', 'Due'], ['*NL*', '1200', 'Fri\nnoon'], ['DE', '', 'Mon']]]);
});

test('tables: normalised - ragged rows padded, limits kept, a line after one, never empty', () => {
  const doc = fmt.normaliseDoc([{ type: 'table', rows: [[{ runs: [T('a')] }], [{ runs: [T('b')] }, { runs: [T('c')] }, 'junk']], head: 1, align: ['right', 'bogus'] }]);
  assert.deepEqual(doc.map(b => b.type), ['table', 'p'], 'a line to type after it');
  assert.deepEqual(grid(doc[0]), [true, ['right', '', ''], [['a', '', ''], ['b', 'c', '']]]);
  const huge = fmt.normaliseDoc([fmt.table(Array.from({ length: fmt.MAX_ROWS + 5 }, () => Array.from({ length: 40 }, () => ({ runs: [T('x')] }))))]);
  assert.equal(huge[0].rows.length, fmt.MAX_ROWS);
  assert.equal(huge[0].rows[0].length, fmt.MAX_COLS);
  assert.deepEqual(grid(fmt.normaliseDoc([{ type: 'table', rows: [] }])[0])[2], [['']]);
  assert.equal(fmt.isEmpty(fmt.normaliseDoc([fmt.table()])), false, 'an empty table is still something');
  assert.equal(fmt.isEmpty(fmt.emptyDoc()), true);
});

test('tables merge as whole blocks', () => {
  const t = text => fmt.table([[{ runs: [T(text)] }]]);
  const r = fmt.mergeDocs([P('a'), t('x')], [P('a, mine'), t('x')], [P('a'), t('x, theirs')]);
  assert.deepEqual(r.doc.map(b => (b.type === 'table' ? `[${b.rows[0][0].runs[0].text}]` : b.runs.map(x => x.text).join(''))), ['a, mine', '[x, theirs]', '']);
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

test('Markdown: a table is a table, its |---| line making the first row its heading row', () => {
  const md = '| Term | Meaning |\n|:-----|-------:|\n| **top** | above |\n| a \\| b | [c](example.com) |';
  const doc = fmt.fromMarkdown(md);
  assert.deepEqual(doc.map(b => b.type), ['table', 'p']);
  assert.deepEqual(grid(doc[0]), [true, ['', 'right'], [['Term', 'Meaning'], ['*top*', 'above'], ['a | b', 'c<https://example.com/>']]]);
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

// ── Merging two edits of one note ────────────────────────────────────

const P = text => B('p', text ? [T(text)] : []);
const texts = doc => doc.map(b => b.runs.map(r => r.text).join(''));
const merge = (base, mine, theirs) => fmt.mergeDocs(base.map(P), mine.map(P), theirs.map(P));

test('merge: one side changed, or neither, or both the same way', () => {
  assert.deepEqual(texts(merge(['a', 'b'], ['a', 'b'], ['a', 'b']).doc), ['a', 'b']);
  assert.deepEqual(texts(merge(['a', 'b'], ['a', 'b'], ['a', 'B', 'c']).doc), ['a', 'B', 'c'], 'theirs only');
  assert.deepEqual(texts(merge(['a', 'b'], ['x', 'a', 'b'], ['a', 'b']).doc), ['x', 'a', 'b'], 'mine only');
  const same = merge(['a'], ['a', 'z'], ['a', 'z']);
  assert.deepEqual(texts(same.doc), ['a', 'z'], 'not twice');
  assert.equal(same.clean, true);
});

test('merge: changes in different places both stay', () => {
  // A line jotted at the top on the phone; the last line edited on the computer.
  const r = merge(['milk', 'eggs', 'call Sam'], ['bread', 'milk', 'eggs', 'call Sam'], ['milk', 'eggs', 'call Sam at 3']);
  assert.deepEqual(texts(r.doc), ['bread', 'milk', 'eggs', 'call Sam at 3']);
  assert.equal(r.clean, true);
  // A line added under a paragraph on one side, the paragraph changed on the other.
  assert.deepEqual(texts(merge(['a', 'b'], ['a', 'b', 'c'], ['a', 'B']).doc), ['a', 'B', 'c']);
  assert.deepEqual(texts(merge(['a', 'b'], ['a', 'B'], ['a', 'z', 'b']).doc), ['a', 'z', 'B']);
  // Deletions on either side are kept as deletions.
  assert.deepEqual(texts(merge(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], ['a', 'b', 'c', 'D']).doc), ['a', 'c', 'D']);
});

test('merge: the same paragraph changed on both sides keeps both versions', () => {
  const r = merge(['intro', 'plan', 'end'], ['intro', 'plan: Monday', 'end'], ['intro', 'plan: Tuesday', 'end']);
  assert.deepEqual(texts(r.doc), ['intro', 'plan: Tuesday', 'plan: Monday', 'end']);
  assert.equal(r.clean, false);
  // A scratchpad started on two devices at once: both texts.
  assert.deepEqual(texts(merge([''], ['from the phone'], ['from the computer', 'second line']).doc),
    ['from the computer', 'second line', 'from the phone']);
});

test('merge: formatting counts as a change, and the map says where each of my blocks went', () => {
  const base = [P('title'), P('body')];
  const mine = [P('new first'), P('title'), B('p', [T('body', { b: true })])];
  const theirs = [P('title'), P('body'), P('added on the computer')];
  const r = fmt.mergeDocs(base, mine, theirs);
  assert.deepEqual(r.doc.map(b => b.runs.map(x => (x.b ? `*${x.text}*` : x.text)).join('')), ['new first', 'title', '*body*', 'added on the computer']);
  assert.deepEqual(r.map, [0, 1, 2]);
  // A block of mine they rewrote: the cursor goes to their version.
  const moved = merge(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(moved.map, [0, 1, 2]);
  const gone = merge(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(texts(gone.doc), ['a', 'c']);
  assert.deepEqual(gone.map, [0, 1, 1], 'a deleted block sends the cursor to the next one');
});

test('merge: long notes and empty ones', () => {
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const mine = long.slice(); mine.splice(10, 0, 'mine');
  const theirs = long.slice(); theirs[2990] = 'theirs';
  const r = merge(long, mine, theirs);
  assert.equal(r.doc.length, 3001);
  assert.equal(texts(r.doc)[10], 'mine');
  assert.equal(texts(r.doc)[2991], 'theirs');
  assert.deepEqual(texts(merge([], [], []).doc), ['']);
  assert.equal(fmt.sameDoc([P('a')], [P('a')]), true);
  assert.equal(fmt.sameDoc([P('a')], [P('b')]), false);
});

test('merge: whatever either side wrote is in the result (random edits)', () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const edit = (doc, tag) => {
    const out = doc.slice();
    for (let e = rnd(4); e >= 0; e--) {
      const at = rnd(out.length + 1);
      const op = rnd(3);
      if (op === 0) out.splice(at, 0, `${tag}${rnd(1000)}`);
      else if (op === 1 && out.length) out.splice(Math.min(at, out.length - 1), 1);
      else if (out.length) out[Math.min(at, out.length - 1)] += tag;
    }
    return out;
  };
  for (let round = 0; round < 400; round++) {
    const base = Array.from({ length: rnd(8) }, (_, i) => `b${i}`);
    const mine = edit(base, 'm');
    const theirs = edit(base, 't');
    const r = merge(base, mine, theirs);
    const got = texts(r.doc);
    for (const line of mine) if (!base.includes(line)) assert.ok(got.includes(line), `mine: ${line} in ${JSON.stringify({ base, mine, theirs, got })}`);
    for (const line of theirs) if (!base.includes(line)) assert.ok(got.includes(line), `theirs: ${line} in ${JSON.stringify({ base, mine, theirs, got })}`);
    assert.equal(r.map.length, Math.max(1, mine.length), "an empty note is one empty paragraph");
    for (const at of r.map) assert.ok(at >= 0 && at < r.doc.length);
  }
});

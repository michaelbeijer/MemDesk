// Search highlighting: the words in a Gmail query, where they occur in a
// note, and the excerpts around them.

const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../src/lib/search-logic.js');

const words = q => search.queryTerms(q).map(t => t.words.join(' '));
const spans = (text, q) => search.findMatches(text, search.queryTerms(q)).map(m => text.slice(m.start, m.end));

// ── Query terms ──────────────────────────────────────────────────────

test('plain words and quoted phrases are terms; operators, exclusions and keywords are not', () => {
  assert.deepEqual(words('glossary "stent coating" from:priya before:2026/09/01 -draft OR Kestrel'),
    ['glossary', 'stent coating', 'Kestrel']);
  assert.deepEqual(words('subject:invoice subject:(rate schedule) label:_notes-work is:starred'), ['invoice', 'rate', 'schedule']);
  assert.deepEqual(words('(coffee OR tea) AND cake'), ['coffee', 'tea', 'cake']);
  assert.deepEqual(words('a i x 日 the'), ['日', 'the'], 'one-letter Latin words are noise; CJK characters are not');
  assert.deepEqual(words('Glossary glossary GLOSSARY'), ['Glossary'], 'no duplicates');
  assert.deepEqual(words(''), []);
  assert.deepEqual(words('from:sam has:attachment'), [], 'nothing to highlight');
});

// ── Matching ─────────────────────────────────────────────────────────

test('case and accents are ignored, either way round', () => {
  assert.deepEqual(spans('Meet at the Café. CAFE at noon. café again', 'cafe'), ['Café', 'CAFE', 'café']);
  assert.deepEqual(spans('a naive plan', 'naïve'), ['naive']);
  assert.deepEqual(spans('Übersetzung und uber', 'uber'), ['Über', 'uber']);
});

test('a term matches anywhere, inside a word or a number too', () => {
  assert.deepEqual(spans('glossary, glossaries and the Kestrel gloss', 'gloss'), ['gloss', 'gloss', 'gloss']);
  assert.deepEqual(spans('termbase hygiene', 'base'), ['base']);
  assert.deepEqual(spans('e-mail and email', 'mail'), ['mail', 'mail']);
  assert.deepEqual(spans('Account number: 65060796', '0796'), ['0796']);
});

// ── Searching the text itself ────────────────────────────────────────

test('plainTerms: only a query of words and phrases is answered from the text', () => {
  const plain = q => { const t = search.plainTerms(q); return t && t.map(x => x.words.join(' ')); };
  assert.deepEqual(plain('0796'), ['0796']);
  assert.deepEqual(plain('stent "rate schedule"'), ['stent', 'rate schedule']);
  assert.deepEqual(plain('café 日本'), ['café', '日本']);
  for (const q of ['from:priya stent', '-draft stent', 'coffee OR tea', 'tea AND cake', '(coffee tea)', '{a b}', '+exact',
    'subject:invoice', 'is:starred', '"unclosed', '', '   ', 'a']) {
    assert.equal(search.plainTerms(q), null, q);
  }
});

test('hasAll: every word somewhere, in any order, inside words too', () => {
  const t = search.plainTerms('0796 starling');
  assert.equal(search.hasAll('Starling Bank\nAccount number: 65060796', t), true);
  assert.equal(search.hasAll('Account number: 65060796', t), false, 'one word missing');
  assert.equal(search.hasAll('', t), false);
  assert.equal(search.hasAll('anything', null), false);
  assert.equal(search.hasAll('anything', []), false);
});

test('phrases match across any run of spaces, line breaks included', () => {
  assert.deepEqual(spans('stent  coating\nand stent\ncoating, not stent-coating', '"stent coating"'), ['stent  coating', 'stent\ncoating']);
});

test('offsets are right after characters that fold to something else', () => {
  const text = 'ﬁne straße İstanbul 🙂 café';
  const m = search.findMatches(text, search.queryTerms('cafe'));
  assert.equal(text.slice(m[0].start, m[0].end), 'café');
  assert.deepEqual(spans('İstanbul', 'istanbul'), ['İstanbul']);
});

test('overlapping matches merge into one', () => {
  assert.deepEqual(search.findMatches('stent coating', search.queryTerms('"stent coating" coat')), [{ start: 0, end: 13 }]);
});

test('regex characters in a query are just characters', () => {
  assert.deepEqual(spans('price (net) is $5.00 or $5x00', '$5.00'), ['5.00']);
  assert.doesNotThrow(() => search.findMatches('a', search.queryTerms('[(*+?')));
});

// ── Excerpts ─────────────────────────────────────────────────────────

test('excerpts: context around matches, cut on spaces, with offsets to mark', () => {
  const text = `${'lorem '.repeat(20)}the stent coating glossary is ready ${'ipsum '.repeat(20)}and a second glossary note at the end`;
  const terms = search.queryTerms('glossary');
  const ex = search.excerpts(text, search.findMatches(text, terms), { context: 20 });
  assert.equal(ex.length, 2);
  for (const e of ex) {
    for (const m of e.marks) assert.equal(e.text.slice(m.start, m.end).toLowerCase(), 'glossary');
    assert.match(e.text, /^(lorem|ipsum|the|and) /, 'starts on a whole word');
    assert.match(e.text, / (lorem|ipsum|ready|end)$/, 'ends on a whole word');
  }
  assert.deepEqual([ex[0].cutBefore, ex[0].cutAfter, ex[1].cutBefore, ex[1].cutAfter], [true, true, true, false],
    'the second runs to the end of the text');
});

test('excerpts: close matches share one, and there are at most `max`', () => {
  const text = 'cat dog cat dog cat ' + 'x '.repeat(200) + 'cat ' + 'y '.repeat(200) + 'cat ' + 'z '.repeat(200) + 'cat';
  const ex = search.excerpts(text, search.findMatches(text, search.queryTerms('cat')), { context: 30, max: 3 });
  assert.equal(ex.length, 3);
  assert.equal(ex[0].marks.length, 3, 'the three close together are one excerpt');
});

test('excerpts: line breaks become spaces, offsets unchanged', () => {
  const text = 'first line\nsecond glossary line\nthird';
  const [e] = search.excerpts(text, search.findMatches(text, search.queryTerms('glossary')));
  assert.equal(e.text, 'first line second glossary line third');
  assert.equal(e.text.slice(e.marks[0].start, e.marks[0].end), 'glossary');
  assert.equal(e.cutBefore, false);
  assert.equal(e.cutAfter, false);
});

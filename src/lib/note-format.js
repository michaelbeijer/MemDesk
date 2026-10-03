// ─────────────────────────────────────────────────────────────────────
// Note formatting (pure)
//
// A formatted note is a list of blocks - paragraphs, three heading
// sizes, bulleted, numbered and check lists nested up to three deep, and
// tables - each holding runs of text that may be bold, italic, struck
// through or a link (a table, rows of cells of them). That is the whole
// model; nothing outside it survives a save.
//
// It is stored in the note's message twice. The HTML part is the real
// record: Gmail shows it (on the phone too), and this file reads it back
// with a small tokenizer of its own rather than the browser's HTML
// parser, which is a Trusted Types sink on Gmail's page and would accept
// far more than the model can hold. The plain-text part is a readable
// rendering - bullets, ☐ and ☑ - for Gmail's previews and for any mail
// client that shows text.
//
// Mail that arrived as a note (written in Gmail, say) goes through the
// same reader, so its bold, lists and links come across where they fit
// the model and everything else is reduced to text.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const util = (typeof module === 'object' && module.exports) ? require('./util.js') : ns.util;

  const TYPES = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'check', 'table']);
  const LISTS = new Set(['ul', 'ol', 'check']);
  const MAX_LEVEL = 3;
  // A table: at most this many columns and rows; a column is aligned
  // left (''), in the centre or to the right.
  const MAX_COLS = 26;
  const MAX_ROWS = 1000;
  const ALIGNS = new Set(['', 'center', 'right']);
  const BOX = '☐';     // ☐
  const TICKED = '☑';  // ☑
  const BULLET = '•';  // •

  // ── The model ────────────────────────────────────────────────────────

  function block(type = 'p', runs = [], { level = 0, checked = false } = {}) {
    return { type, level: LISTS.has(type) ? level : 0, checked: type === 'check' ? !!checked : false, runs };
  }

  // A table block: `rows` of cells, each cell { runs } - a line break
  // inside a cell is a "\n" in its text; `head`, whether the first row is
  // a heading row; `align`, each column's alignment.
  function table(rows = [[{ runs: [] }]], { head = false, align = [] } = {}) {
    return Object.assign(block('table'), { rows, head: !!head, align });
  }

  const emptyCell = () => ({ runs: [] });

  function emptyDoc() {
    return [block('p')];
  }

  const sameMarks = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && (a.href || '') === (b.href || '');

  function cleanRun(r) {
    const out = { text: String(r.text || '') };
    if (r.b) out.b = true;
    if (r.i) out.i = true;
    if (r.s) out.s = true;
    const href = r.href ? safeHref(r.href) : '';
    if (href) out.href = href;
    return out;
  }

  // Drops empty runs and joins neighbours that look the same, so two
  // documents that read alike compare alike.
  function normaliseRuns(runs) {
    const out = [];
    for (const r of runs || []) {
      if (!r || !r.text) continue;
      const last = out[out.length - 1];
      if (last && sameMarks(last, r)) last.text += r.text;
      else out.push(cleanRun(r));
    }
    return out;
  }

  // Every row as wide as the widest (and within the limits), every cell
  // tidy, at least one cell.
  function normaliseTable(b) {
    const src = (Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray).slice(0, MAX_ROWS);
    const widest = src.reduce((n, r) => Math.max(n, r.length), 0);
    const cols = Math.max(1, Math.min(MAX_COLS, widest));
    const rows = src.map(r => Array.from({ length: cols }, (_, k) => ({ runs: normaliseRuns(r[k] && r[k].runs) })));
    if (!rows.length) rows.push(Array.from({ length: cols }, emptyCell));
    const align = Array.from({ length: cols }, (_, k) => (b.align && ALIGNS.has(b.align[k]) ? b.align[k] : ''));
    return table(rows, { head: b.head, align });
  }

  // Unknown types become paragraphs; a list item may sit at most one level
  // deeper than the list item before it, which is what keeps the HTML a
  // properly nested list and the editor's indents meaningful. A table is
  // never last: a line follows it, somewhere to type after it.
  function normaliseDoc(doc) {
    const out = [];
    let prevLevel = -1;
    for (const b of Array.isArray(doc) ? doc : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'table') {
        out.push(normaliseTable(b));
        prevLevel = -1;
        continue;
      }
      const type = TYPES.has(b.type) ? b.type : 'p';
      let level = 0;
      if (LISTS.has(type)) {
        level = Math.max(0, Math.min(MAX_LEVEL, Number(b.level) || 0, prevLevel + 1));
        prevLevel = level;
      } else {
        prevLevel = -1;
      }
      out.push(block(type, normaliseRuns(b.runs), { level, checked: b.checked }));
    }
    if (out.length && out[out.length - 1].type === 'table') out.push(block('p'));
    return out.length ? out : emptyDoc();
  }

  const runsText = runs => runs.map(r => r.text).join('');
  // A table's text: a row a line, its cells between " | ".
  const tableText = b => b.rows.map(r => r.map(c => runsText(c.runs).replace(/\n/g, ' ')).join(' | ')).join('\n');
  const blockText = b => (b.type === 'table' ? tableText(b) : runsText(b.runs));

  function docText(doc) {
    return doc.map(blockText).join('\n');
  }

  // A table counts as something written, even with nothing in it yet.
  function isEmpty(doc) {
    return doc.every(b => b.type !== 'table' && !blockText(b).trim());
  }

  // ── Links ────────────────────────────────────────────────────────────

  // Web and mail links only. "example.com/x" gets https:// in front, a
  // bare address gets mailto:, and anything else - javascript:, data:,
  // file: - is not a link at all.
  function safeHref(url) {
    const s = String(url || '').trim();
    if (!s || /[\s<>"]/.test(s)) return '';
    if (/^mailto:/i.test(s)) return /^mailto:[^@\s]+@[^@\s]+$/i.test(s) ? s : '';
    if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(s)) return `mailto:${s}`;
    let candidate = s;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s)) return '';
      candidate = `https://${s}`;
    }
    try {
      const u = new URL(candidate);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  // ── HTML out ─────────────────────────────────────────────────────────

  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Spaces HTML would collapse - doubled, at either end of a block, or
  // meeting across a tag - are written as &nbsp; so they come back as
  // typed.
  function runsHtml(runs) {
    let out = '';
    let prevSpace = false;
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      let j = i;
      let inner = '';
      while (j < runs.length && (runs[j].href || '') === href) {
        const raw = runs[j].text;
        let t = escHtml(raw).replace(/ {2}/g, ' &nbsp;').replace(/\n/g, '<br>');
        if (prevSpace && t[0] === ' ') t = `&nbsp;${t.slice(1)}`;
        prevSpace = / $/.test(raw);
        if (runs[j].s) t = `<s>${t}</s>`;
        if (runs[j].i) t = `<i>${t}</i>`;
        if (runs[j].b) t = `<b>${t}</b>`;
        inner += t;
        j++;
      }
      out += href ? `<a href="${escHtml(href)}">${inner}</a>` : inner;
      i = j;
    }
    // Edge spaces of the whole block, after the tags are in place.
    return out.replace(/^((?:<[^>]+>)*) /, '$1&nbsp;').replace(/ ((?:<\/[^>]+>)*)$/, '&nbsp;$1');
  }

  const STYLE = {
    doc: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f1f1f',
    p: 'margin:0',
    h1: 'margin:14px 0 4px;font-size:22px;line-height:1.3;font-weight:bold',
    h2: 'margin:12px 0 2px;font-size:18px;line-height:1.3;font-weight:bold',
    h3: 'margin:10px 0 2px;font-size:15px;line-height:1.3;font-weight:bold',
    list: 'margin:0;padding-left:26px',
    check: 'margin:0;padding-left:4px;list-style:none',
    li: 'margin:1px 0',
    table: 'border-collapse:collapse;margin:6px 0',
    cell: 'border:1px solid #c4c7c5;padding:4px 8px;vertical-align:top;text-align:left',
    th: 'background:#f1f3f4;font-weight:bold',
  };

  // A table as Gmail and any mail client shows one, styled inline; the
  // heading row in <thead>, as <th>.
  function tableHtml(b) {
    const cell = (c, k, tag) => {
      const align = b.align[k] ? `;text-align:${b.align[k]}` : '';
      const style = `${STYLE.cell}${tag === 'th' ? `;${STYLE.th}` : ''}${align}`;
      return `<${tag} style="${style}">${runsHtml(c.runs) || '<br>'}</${tag}>`;
    };
    const row = (r, tag) => `<tr>${r.map((c, k) => cell(c, k, tag)).join('')}</tr>`;
    const body = b.rows.slice(b.head ? 1 : 0);
    return `<table data-gkb-table="1" style="${STYLE.table}">` +
      (b.head ? `<thead>${row(b.rows[0], 'th')}</thead>` : '') +
      (body.length ? `<tbody>${body.map(r => row(r, 'td')).join('')}</tbody>` : '') + '</table>';
  }

  function toHtml(docIn) {
    const doc = normaliseDoc(docIn);
    const stack = []; // open lists, one per level: { tag, check }
    let out = `<div data-gkb-note="1" style="${STYLE.doc}">`;
    const close = () => { out += `</li></${stack.pop().tag}>`; };

    for (const b of doc) {
      if (b.type === 'table') {
        while (stack.length) close();
        out += `${tableHtml(b)}\n`;
        continue;
      }
      const inner = runsHtml(b.runs);
      if (!LISTS.has(b.type)) {
        while (stack.length) close();
        out += `<${b.type} style="${STYLE[b.type]}">${inner || '<br>'}</${b.type}>\n`;
        continue;
      }
      const tag = b.type === 'ol' ? 'ol' : 'ul';
      const check = b.type === 'check';
      while (stack.length > b.level + 1) close();
      if (stack.length === b.level + 1) {
        const top = stack[stack.length - 1];
        if (top.tag !== tag || top.check !== check) close();
        else out += '</li>';
      }
      if (stack.length === b.level) {
        out += check ? `<ul data-check="1" style="${STYLE.check}">` : `<${tag} style="${STYLE.list}">`;
        stack.push({ tag, check });
      }
      const glyph = check ? `<span data-glyph="1">${b.checked ? TICKED : BOX}&nbsp;</span>` : '';
      out += `<li style="${STYLE.li}"${check ? ` data-checked="${b.checked ? 1 : 0}"` : ''}>${glyph}${inner || (check ? '' : '<br>')}`;
    }
    while (stack.length) close();
    return `${out}</div>`;
  }

  // ── Plain text out ───────────────────────────────────────────────────

  function runsPlain(runs) {
    let out = '';
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      let j = i;
      let text = '';
      while (j < runs.length && (runs[j].href || '') === href) text += runs[j++].text;
      const bare = href.replace(/^mailto:/, '');
      const same = s => s.trim().replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '');
      out += href && same(text) !== same(href) ? `${text} (${bare})` : text;
      i = j;
    }
    return out;
  }

  // A table as plain text: a row a line, " | " between its cells - what
  // Gmail's previews and a plain-text mail client show. (The HTML part is
  // the record; this only has to read well.)
  function tablePlain(b) {
    const cell = c => runsPlain(c.runs).replace(/\n/g, ' ').trim();
    return b.rows.map(r => r.map(cell).join(' | ')).join('\n');
  }

  function toPlain(docIn) {
    const doc = normaliseDoc(docIn);
    const counters = [0, 0, 0, 0];
    return doc.map(b => {
      if (b.type === 'table') {
        counters.fill(0);
        return tablePlain(b);
      }
      const text = runsPlain(b.runs);
      if (!LISTS.has(b.type)) {
        counters.fill(0);
        return text;
      }
      const pad = '  '.repeat(b.level);
      for (let l = b.level + 1; l < counters.length; l++) counters[l] = 0;
      if (b.type === 'ol') return `${pad}${++counters[b.level]}. ${text}`;
      counters[b.level] = 0;
      if (b.type === 'check') return `${pad}${b.checked ? TICKED : BOX} ${text}`;
      return `${pad}${BULLET} ${text}`;
    }).join('\n');
  }

  // ── Plain text in ────────────────────────────────────────────────────

  // A plain note (from before formatting existed, or plain mail) becomes
  // one block per line. Lines that already look like lists - "- ", "• ",
  // "1. ", "☐ " - become lists, indented two spaces a level.
  function fromPlain(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      // Two or more | a | b | lines, or one with a |---| line under it: a table.
      const t = pipeTable(lines, i, s => [{ text: s }]);
      if (t && (t.end - i > 1 || t.block.head)) {
        out.push(t.block);
        i = t.end - 1;
        continue;
      }
      const line = lines[i];
      const m = /^( *)(?:([-*•])|(\d{1,3})[.)]|([☐☑])) (.*)$/.exec(line);
      if (!m) { out.push(block('p', [{ text: line }])); continue; }
      const level = Math.floor(m[1].length / 2);
      if (m[4]) out.push(block('check', [{ text: m[5] }], { level, checked: m[4] === TICKED }));
      else out.push(block(m[3] ? 'ol' : 'ul', [{ text: m[5] }], { level }));
    }
    return normaliseDoc(out);
  }

  // ── Pipe tables (Markdown's, and the plain text above) ──────────────

  const PIPE_ROW = /^\s*\|.*\|\s*$/;
  const PIPE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const pipeCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

  // The table of | rows starting at lines[i], or null: { block, end }.
  // A |---| line under the first row makes it a heading row and gives the
  // columns' alignment; "<br>" in a cell is a line break.
  function pipeTable(lines, i, inline) {
    if (!PIPE_ROW.test(lines[i] || '') || PIPE_RULE.test(lines[i])) return null;
    const rows = [];
    let head = false;
    let align = [];
    let j = i;
    for (; j < lines.length && PIPE_ROW.test(lines[j]); j++) {
      if (PIPE_RULE.test(lines[j])) {
        if (rows.length === 1 && !head) {
          head = true;
          align = pipeCells(lines[j]).map(c => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : ''));
        }
        continue;
      }
      rows.push(pipeCells(lines[j]).map(c => ({ runs: inline(c.replace(/<br\s*\/?>/gi, '\n')) })));
    }
    return { block: table(rows, { head, align }), end: j };
  }

  // ── HTML in ──────────────────────────────────────────────────────────

  const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
  const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math', 'noscript', 'iframe', 'object', 'xml']);
  const PARA = new Set(['p', 'div', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'nav', 'table', 'tbody', 'thead', 'tfoot', 'center', 'dl', 'dt', 'dd', 'figure', 'figcaption',
    'form', 'fieldset', 'address', 'hr', 'body', 'html', 'caption']);
  // Tags that mark text, and the marks they stand for. span and font
  // carry theirs in a style attribute, if at all.
  const INLINE = {
    b: ['b'], strong: ['b'], i: ['i'], em: ['i'], cite: ['i'], s: ['s'], strike: ['s'], del: ['s'], span: [], font: [],
  };
  const HEADINGS = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };

  function attrsOf(s) {
    const out = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s || ''))) {
      out[m[1].toLowerCase()] = util.decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
    }
    return out;
  }

  // Bold, italic and strike-through written as inline styles, as Outlook
  // and pasted web text often do, count the same as the tags.
  function styleMarks(style) {
    const s = String(style || '').toLowerCase();
    const marks = [];
    if (/font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(s)) marks.push('b');
    if (/font-style\s*:\s*italic/.test(s)) marks.push('i');
    if (/text-decoration(-line)?\s*:[^;]*line-through/.test(s)) marks.push('s');
    return marks;
  }

  // Whether a browser would show space below a <p>: it does unless its
  // style says otherwise. Word and Outlook paragraphs (MsoNormal) are
  // lines, and so are the editor's own and Google Docs'.
  function paraGap(a) {
    if (/\bMso/.test(a.class || '')) return false;
    const style = String(a.style || '').toLowerCase();
    const zero = v => /^-?0(\.0+)?([a-z]+|%)?$/.test(v || '');
    const bottom = /(?:^|;)\s*margin-bottom\s*:\s*([^;!]+)/.exec(style);
    if (bottom) return !zero(bottom[1].trim());
    const all = /(?:^|;)\s*margin\s*:\s*([^;!]+)/.exec(style);
    if (all) {
      const v = all[1].trim().split(/\s+/);
      return !zero(v.length >= 3 ? v[2] : v[0]);
    }
    return true;
  }

  function parseHtml(html) {
    const blocks = [];
    const lists = [];         // open lists: { type, liOpen }
    const marks = { b: 0, i: 0, s: 0 };
    const hrefs = [];
    const inline = [];        // open inline tags: { name, marks } or { name, glyph: true }
    let skip = 0;
    let glyph = 0;
    let cur = null;
    // The open table, if any: { b, row, cell, thead, depth }. Its text goes
    // into its cells; a table inside a cell is read into that cell as text,
    // a row a line (depth counts those).
    let tbl = null;
    let pre = 0;              // inside <pre>: line breaks and spaces are text
    let para = null;          // the open <p>: { gap }
    let gap = false;          // a <p> just closed with space below it
    let ours = false;         // inside a note's own HTML, where paragraphs are lines

    const level = () => Math.max(0, lists.length - 1);
    const open = (type, extra) => {
      // The space a browser shows after a paragraph is an empty line in a
      // note - which has no space between paragraphs - except before a
      // heading, which has its own.
      if (gap) {
        gap = false;
        const last = blocks[blocks.length - 1];
        if (last && !HEADINGS[type] && last.runs.some(r => /\S/.test(r.text))) blocks.push(block('p'));
      }
      cur = block(type, [], extra);
      blocks.push(cur);
      return cur;
    };
    const end = () => { cur = null; };
    // Where text lands when no block is open: inside a list item, a
    // continuation of that item; otherwise a new paragraph.
    const context = () => {
      const top = lists[lists.length - 1];
      if (top && top.liOpen) return open(top.type, { level: level(), checked: false });
      return open('p');
    };
    const apply = (list, delta) => list.forEach(m => { marks[m] += delta; });
    const run = text => ({ text, b: marks.b > 0, i: marks.i > 0, s: marks.s > 0, href: hrefs.length ? hrefs[hrefs.length - 1] : '' });
    // Inside a table: the open cell's runs, or null between cells.
    const cellRuns = () => (tbl && tbl.cell ? tbl.cell.runs : null);
    // A line break in the open cell, unless it is empty or just had one.
    const cellBreak = () => {
      const runs = cellRuns();
      if (!runs || !runs.length) return;
      const last = runs[runs.length - 1];
      if (!/\n$/.test(last.text)) runs.push(run('\n'));
    };
    const rowsSeen = [];
    const closeCell = () => {
      if (!tbl || !tbl.cell) return;
      apply(tbl.cell.marks, -1);
      tbl.cell = null;
    };
    // The table done: empty rows gone, the heading row and the columns'
    // alignment worked out from the cells.
    const finishTable = () => {
      closeCell();
      const t = tbl;
      tbl = null;
      const rows = rowsSeen.filter(r => r.cells.length && t.b.rows.indexOf(r.cells) >= 0);
      rowsSeen.length = 0;
      t.b.rows = rows.map(r => r.cells);
      if (!rows.length) { blocks.splice(blocks.indexOf(t.b), 1); return; }
      const first = rows[0];
      t.b.head = first.thead || (first.th && first.cells.some(c => c.th) && rows.length > 1);
      const cols = Math.max(...rows.map(r => r.cells.length));
      t.b.align = Array.from({ length: cols }, (_, k) => {
        const seen = rows.slice(t.b.head ? 1 : 0).map(r => r.cells[k] && r.cells[k].align).filter(x => x !== undefined);
        return seen.length && seen.every(x => x === seen[0]) ? seen[0] : '';
      });
      // Bold that a heading cell is anyway, and a heading cell in a later
      // row (a row's label), written as bold.
      rows.forEach((r, i) => r.cells.forEach(c => {
        if (c.th && !(i === 0 && t.b.head)) c.runs.forEach(x => { x.b = true; });
      }));
    };

    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(String(html || '')))) {
      const [whole, closing, rawName, rawAttrs, selfClosing] = m;
      if (rawName === undefined) {
        if (whole[0] === '<' && whole.length > 1) continue; // comment, doctype, CDATA
        if (skip) continue;
        if (glyph) {
          // Word's list marker ("·", "1.", "a)"): not text, but it says
          // whether the list is bulleted or numbered.
          if (cur && cur.wordList) cur.marker += util.decodeEntities(whole);
          continue;
        }
        if (pre) {
          // Each line of preformatted text is a line of the note, its
          // spaces kept (as &nbsp;, which the tidying below leaves alone).
          let raw = util.decodeEntities(whole).replace(/\r\n?/g, '\n');
          if (pre.fresh) raw = raw.replace(/^\n/, '');
          pre.fresh = false;
          if (tbl) {
            if (cellRuns()) cellRuns().push(run(raw.replace(/\t/g, '    ')));
            continue;
          }
          raw.split('\n').forEach((line, k) => {
            if (k) {
              end();
              open('p').preLine = true;
            }
            if (!line) return;
            if (!cur) context();
            cur.runs.push({
              text: line.replace(/\t/g, '    ').replace(/ /g, '\u00a0'),
              b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,
              href: hrefs.length ? hrefs[hrefs.length - 1] : '',
            });
          });
          continue;
        }
        const text = util.decodeEntities(whole === '<' ? '<' : whole).replace(/[ \t\r\n\f]+/g, ' ');
        if (tbl) {
          // Between cells, only stray whitespace: nothing.
          const runs = cellRuns();
          if (runs && (runs.length || /[^ \t\r\n\f]/.test(text))) runs.push(run(text));
          continue;
        }
        if (!cur) {
          // Only HTML's own whitespace is nothing; an &nbsp; is a space someone typed.
          if (!/[^ \t\r\n\f]/.test(text)) continue;
          context();
        }
        cur.runs.push({
          text,
          b: marks.b > 0, i: marks.i > 0, s: marks.s > 0,
          href: hrefs.length ? hrefs[hrefs.length - 1] : '',
        });
        continue;
      }

      const name = rawName.toLowerCase();
      const isClose = closing === '/';
      if (SKIP.has(name)) {
        if (!selfClosing) skip = Math.max(0, skip + (isClose ? -1 : 1));
        continue;
      }
      if (skip) continue;
      const a = isClose ? {} : attrsOf(rawAttrs);

      if (name === 'br') {
        if (tbl) {
          const runs = cellRuns();
          if (runs) runs.push(run('\n'));
          continue;
        }
        if (cur) end();
        else { context(); end(); }
        continue;
      }

      // ── Tables ──
      if (name === 'table') {
        if (isClose) {
          if (tbl && tbl.depth) { tbl.depth--; cellBreak(); continue; }
          if (tbl) finishTable();
          continue;
        }
        if (tbl) { tbl.depth++; cellBreak(); continue; }
        end();
        tbl = { b: table([], {}), row: null, cell: null, thead: false, depth: 0, headRow: true };
        blocks.push(tbl.b);
        continue;
      }
      if (tbl && name === 'caption') {
        if (!selfClosing) skip = Math.max(0, skip + (isClose ? -1 : 1));
        continue;
      }
      if (tbl && (name === 'thead' || name === 'tbody' || name === 'tfoot' || name === 'colgroup' || name === 'col')) {
        if (name === 'thead' && !tbl.depth) tbl.thead = !isClose;
        continue;
      }
      if (tbl && name === 'tr') {
        if (tbl.depth) { cellBreak(); continue; }
        closeCell();
        tbl.row = null;
        if (!isClose) {
          tbl.row = { cells: [], th: true, thead: tbl.thead };
          tbl.b.rows.push(tbl.row.cells);
          rowsSeen.push(tbl.row);
        }
        continue;
      }
      if (tbl && (name === 'td' || name === 'th')) {
        if (tbl.depth) {
          if (!isClose && cellRuns() && cellRuns().length && !/[\n ]$/.test(cellRuns()[cellRuns().length - 1].text)) cellRuns().push(run(' '));
          continue;
        }
        closeCell();
        if (isClose || selfClosing) continue;
        if (!tbl.row) {
          tbl.row = { cells: [], th: true, thead: tbl.thead };
          tbl.b.rows.push(tbl.row.cells);
          rowsSeen.push(tbl.row);
        }
        if (name === 'td') tbl.row.th = false;
        const st = String(a.style || '').toLowerCase();
        const al = (/text-align\s*:\s*(center|right)/.exec(st) || [])[1] || (/^(center|right)$/i.test(a.align || '') ? a.align.toLowerCase() : '');
        // Bold, italic or struck through cell styles (Google Sheets) count
        // as marks - but a heading cell is bold anyway.
        const got = styleMarks(st).filter(x => !(name === 'th' && x === 'b'));
        apply(got, 1);
        tbl.cell = { runs: [], align: al, marks: got, th: name === 'th' };
        tbl.row.cells.push(tbl.cell);
        // A cell spanning columns keeps the columns after it in place.
        const span = Math.min(MAX_COLS, Math.max(1, parseInt(a.colspan, 10) || 1));
        for (let k = 1; k < span; k++) tbl.row.cells.push(emptyCell());
        continue;
      }
      if (tbl && !tbl.cell && !isClose && (HEADINGS[name] || PARA.has(name) || name === 'li' || name === 'ul' || name === 'ol')) continue;
      if (tbl && (HEADINGS[name] || name === 'li' || name === 'ul' || name === 'ol' || name === 'pre' || PARA.has(name))) {
        // Lines inside a cell: paragraphs, headings and list items each
        // start a new one; a list item keeps a bullet.
        cellBreak();
        if (name === 'li' && !isClose && cellRuns()) cellRuns().push(run('• '));
        continue;
      }

      if (HEADINGS[name]) {
        end();
        if (!isClose) open(HEADINGS[name]);
        continue;
      }
      if (name === 'ul' || name === 'ol') {
        end();
        if (isClose) lists.pop();
        else lists.push({ type: a['data-check'] ? 'check' : name, liOpen: false });
        continue;
      }
      if (name === 'li') {
        end();
        if (!lists.length) lists.push({ type: 'ul', liOpen: false, implied: true });
        const top = lists[lists.length - 1];
        top.liOpen = !isClose;
        if (!isClose) {
          open(top.type, { level: level(), checked: a['data-checked'] === '1' });
          // One of ours: its box is in the attribute, and a ☐ at the start
          // of its text is text.
          if (a['data-checked'] !== undefined) cur.ours = true;
          // A checklist item marked up for screen readers (Google Docs).
          else if (a['aria-checked'] === 'true' || a['aria-checked'] === 'false') {
            cur.type = 'check';
            cur.checked = a['aria-checked'] === 'true';
            cur.ours = true;
          }
        }
        else if (top.implied) lists.pop();
        continue;
      }
      // Stray row or cell tags outside a table: a line each.
      if (name === 'tr' || name === 'td' || name === 'th') { end(); continue; }
      if (name === 'pre') {
        end();
        if (isClose) {
          // The line break before </pre> ends the last line; it is not one more.
          const last = blocks[blocks.length - 1];
          if (last && last.preLine && !last.runs.length) blocks.pop();
          pre = 0;
        } else if (!selfClosing) {
          pre = { fresh: true };
        }
        continue;
      }
      // A ticked or empty box at the start of a line - a task list on a
      // web page (GitHub) - makes it a checklist item.
      if (name === 'input' && String(a.type || '').toLowerCase() === 'checkbox') {
        if (tbl) {
          if (cellRuns()) cellRuns().push(run('checked' in a ? `${TICKED} ` : `${BOX} `));
          continue;
        }
        if (!cur) context();
        if (!cur.runs.some(r => /\S/.test(r.text))) {
          cur.type = 'check';
          cur.checked = 'checked' in a;
          cur.ours = true;
        }
        continue;
      }
      if (name === 'div' && a['data-gkb-note'] !== undefined) ours = true;
      // A block copied out of a note's editor keeps its kind.
      if (name === 'div' && !isClose && TYPES.has(a['data-type']) && a['data-type'] !== 'table') {
        end();
        open(a['data-type'], { level: Number(a['data-level']) || 0, checked: a['data-checked'] === '1' });
        cur.ours = true;
        continue;
      }
      // Word writes a list as paragraphs styled "mso-list: l0 level1".
      if (name === 'p' && !isClose) {
        const wl = /mso-list\s*:\s*l\d+\s+level(\d)/i.exec(a.style || '');
        if (wl) {
          end();
          open('ul', { level: Number(wl[1]) - 1 });
          cur.wordList = true;
          cur.marker = '';
          continue;
        }
      }
      if (name === 'p') {
        if (para && para.gap) gap = true;
        para = null;
        if (!isClose) {
          const top = lists[lists.length - 1];
          para = { gap: !ours && !tbl && !(top && top.liOpen) && paraGap(a) };
        }
      }
      if (PARA.has(name)) {
        // Straight inside a list item that has no text yet (Google Docs
        // wraps every item in a <p>), the line goes on.
        if (cur && !cur.runs.length && !isClose) continue;
        end();
        continue;
      }
      if (name === 'a') {
        if (isClose) hrefs.pop();
        else if (!selfClosing) hrefs.push(safeHref(a.href));
        continue;
      }
      if (INLINE[name]) {
        if (selfClosing) continue;
        if (isClose) {
          // The innermost open tag of that name - mail is not always tidily nested.
          for (let k = inline.length - 1; k >= 0; k--) {
            if (inline[k].name !== name) continue;
            const [got] = inline.splice(k, 1);
            if (got.glyph) glyph = Math.max(0, glyph - 1);
            else apply(got.marks, -1);
            break;
          }
          continue;
        }
        const style = String(a.style || '').toLowerCase();
        if (a['data-glyph'] || /mso-list\s*:\s*ignore/.test(style)) {
          inline.push({ name, glyph: true });
          glyph++;
          continue;
        }
        let got = [...INLINE[name], ...styleMarks(style)];
        // Google Docs wraps a whole paste in <b style="font-weight:normal">.
        if (/font-weight\s*:\s*(normal|lighter|[1-5]00)\b/.test(style)) got = got.filter(x => x !== 'b');
        if (/font-style\s*:\s*normal/.test(style)) got = got.filter(x => x !== 'i');
        got = [...new Set(got)];
        inline.push({ name, marks: got });
        apply(got, 1);
        continue;
      }
      // Anything else (img, u, sup, code, …): its text is kept, the tag is not.
    }
    if (tbl) finishTable();
    for (const k of Object.keys(marks)) marks[k] = Math.max(0, marks[k]);

    // Tidy each block: collapse the whitespace HTML would collapse, then
    // turn the &nbsp;s that held deliberate spaces back into spaces. In a
    // cell, a line break counts as an end, and none is left at either end.
    const tidyRuns = runs => {
      if (!runs.length) return;
      runs[0].text = runs[0].text.replace(/^[ \n]+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \n]+$/, '');
      for (let i = 1; i < runs.length; i++) {
        if (/[ \n]$/.test(runs[i - 1].text)) runs[i].text = runs[i].text.replace(/^ +/, '');
      }
      for (const r of runs) r.text = r.text.replace(/ +\n/g, '\n').replace(/ /g, ' ');
    };
    for (const b of blocks) {
      if (b.type === 'table') {
        b.rows.forEach(r => r.forEach(c => tidyRuns(c.runs)));
        continue;
      }
      const runs = b.runs;
      tidyRuns(runs);
      if (b.wordList && /^\s*(\d+|[a-z]|[ivxlc]+)[.)]\s*$/i.test(b.marker || '')) b.type = 'ol';
      // A check box drawn as text (mail from elsewhere, or a list whose
      // markers were lost) still counts as a check box.
      if (LISTS.has(b.type) && runs.length && !b.ours) {
        const g = /^([☐☑]) ?/.exec(runs[0].text);
        if (g) {
          runs[0].text = runs[0].text.slice(g[0].length);
          if (b.type === 'ul') b.type = 'check';
          if (b.type === 'check') b.checked = g[1] === TICKED;
        }
      }
    }
    return normaliseDoc(blocks);
  }

  // ── Markdown in ──────────────────────────────────────────────────────
  //
  // Text copied from a chat assistant, a README or a Markdown editor
  // arrives as plain text full of **stars** and "- " lines. The common
  // part of Markdown becomes formatting; the rest stays as typed.

  function mdInline(src, marks = {}) {
    const out = [];
    const s = String(src || '');
    let buf = '';
    const flush = () => {
      if (buf) out.push({ text: buf, ...marks });
      buf = '';
    };
    const nested = (inner, extra) => {
      flush();
      out.push(...mdInline(inner, { ...marks, ...extra }));
    };
    for (let i = 0; i < s.length;) {
      const rest = s.slice(i);
      const prev = i ? s[i - 1] : '';
      let m;
      if ((m = /^\\([\\`*_{}[\]()#+\-.!~|>])/.exec(rest))) { buf += m[1]; i += m[0].length; continue; }
      if ((m = /^`([^`\n]+)`/.exec(rest))) { buf += m[1]; i += m[0].length; continue; }
      if ((m = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
        const href = safeHref(m[2]);
        nested(m[1], href ? { href } : {});
        i += m[0].length;
        continue;
      }
      if ((m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest))) {
        flush();
        const href = safeHref(m[1]);
        out.push({ text: m[1].replace(/^mailto:/, ''), ...marks, ...(href ? { href } : {}) });
        i += m[0].length;
        continue;
      }
      if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && !(m[1] === '__' && /[\p{L}\p{N}]/u.test(prev))) {
        nested(m[2], { b: true });
        i += m[0].length;
        continue;
      }
      if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { nested(m[1], { s: true }); i += m[0].length; continue; }
      if ((m = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest))) { nested(m[1], { i: true }); i += m[0].length; continue; }
      if (!/[\p{L}\p{N}_]/u.test(prev) && (m = /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u.exec(rest))) {
        nested(m[1], { i: true });
        i += m[0].length;
        continue;
      }
      buf += s[i];
      i++;
    }
    flush();
    return out;
  }

  // One line of Markdown: what kind of block it is, its indent and text.
  function mdLine(line) {
    const [, pad, s] = /^( *)(.*)$/.exec(line);
    const indent = pad.length;
    let x;
    if ((x = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(s))) return { type: ['h1', 'h2', 'h3'][Math.min(2, x[1].length - 1)], text: x[2] };
    if ((x = /^[-*+•]\s+\[([ xX])\]\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] !== ' ', text: x[2], indent };
    if ((x = /^([☐☑])\s+(.*)$/.exec(s))) return { type: 'check', checked: x[1] === TICKED, text: x[2], indent };
    if ((x = /^[-*+•]\s+(.*)$/.exec(s))) return { type: 'ul', text: x[1], indent };
    if ((x = /^\d{1,3}[.)]\s+(.*)$/.exec(s))) return { type: 'ol', text: x[1], indent };
    if ((x = /^>\s?(.*)$/.exec(s))) return { type: 'p', text: x[1].replace(/^(>\s?)+/, '') };
    return { type: 'p', text: s };
  }

  const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

  function fromMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const out = [];
    const indents = [];   // the indent of each open list level
    let fence = false;
    const last = () => out[out.length - 1];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) { out.push(block('p', [{ text: line }])); continue; }
      // | a | b | lines, with or without the |---| line under a heading row.
      const t = pipeTable(lines, i, mdInline);
      if (t) {
        indents.length = 0;
        out.push(t.block);
        i = t.end - 1;
        continue;
      }
      if (MD_RULE.test(line)) continue;
      // One empty line is a gap; more are not, and nor is one beside a
      // heading, which has space of its own.
      if (!line.trim()) {
        if (!out.length || !(fmtBlank(last()) || HEADINGS[last().type])) out.push(block('p'));
        continue;
      }
      const l = mdLine(line.replace(/\s+$/, ''));
      if (HEADINGS[l.type] && out.length && fmtBlank(last())) out.pop();
      if (LISTS.has(l.type)) {
        // A blank line between two items of a list is not a gap in it.
        if (out.length > 1 && fmtBlank(last()) && LISTS.has(out[out.length - 2].type)) out.pop();
        while (indents.length && l.indent < indents[indents.length - 1]) indents.pop();
        if (!indents.length || l.indent > indents[indents.length - 1]) indents.push(l.indent);
        out.push(block(l.type, mdInline(l.text), { level: indents.length - 1, checked: l.checked }));
        continue;
      }
      indents.length = 0;
      out.push(block(l.type, mdInline(l.text.trim())));
    }
    while (out.length > 1 && fmtBlank(last())) out.pop();
    while (out.length > 1 && fmtBlank(out[0])) out.shift();
    return normaliseDoc(out);
  }

  const fmtBlank = b => b.type === 'p' && !b.runs.some(r => r.text.trim());
  const isTable = b => b.type === 'table';

  // Whether plain text is worth reading as Markdown: a heading, list,
  // quote, table or code line, or bold, struck, linked or code text.
  function looksLikeMarkdown(text) {
    const s = String(text || '');
    return /^ {0,3}(#{1,6}\s+\S|[-*+•]\s+\S|[☐☑]\s+\S|\d{1,3}[.)]\s+\S|>\s|```)/m.test(s) ||
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(s) ||
      /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(s);
  }

  // ── Pasting ──────────────────────────────────────────────────────────

  // Whether a document has anything plain text would not: a heading, a
  // list, a mark or a link.
  function hasFormatting(doc) {
    return doc.some(b => b.type !== 'p' || b.runs.some(r => r.b || r.i || r.s || r.href));
  }

  // Whether a document is one table and nothing else (empty lines aside):
  // what a paste of cells from a spreadsheet is.
  function onlyTable(doc) {
    const kept = doc.filter(b => !fmtBlank(b));
    return kept.length === 1 && isTable(kept[0]) ? kept[0] : null;
  }

  // What a paste becomes: the clipboard's HTML, read like mail; or, when
  // that brings no formatting and the text is Markdown (from a chat
  // assistant, say), the Markdown read as formatting. Empty lines at
  // either end go. null means there is nothing to format: the text is
  // pasted as it is.
  function pasteDoc({ html, text } = {}) {
    let doc = html && /\S/.test(html) ? parseHtml(html) : null;
    if (doc && isEmpty(doc)) doc = null;
    if ((!doc || !hasFormatting(doc)) && looksLikeMarkdown(text)) doc = fromMarkdown(text);
    if (!doc) return null;
    // One cell copied on its own is its text, not a table of one.
    const one = onlyTable(doc);
    if (one && one.rows.length === 1 && one.rows[0].length === 1) {
      const runs = one.rows[0][0].runs;
      const lines = [[]];
      for (const r of runs) {
        r.text.split('\n').forEach((piece, k) => {
          if (k) lines.push([]);
          if (piece) lines[lines.length - 1].push({ ...r, text: piece });
        });
      }
      doc = normaliseDoc(lines.map(l => block('p', l)));
    }
    let i = 0;
    let j = doc.length;
    while (i < j && fmtBlank(doc[i])) i++;
    while (j > i && fmtBlank(doc[j - 1])) j--;
    return i < j ? doc.slice(i, j) : null;
  }

  // The note's content from its message parts: HTML when there is any,
  // the plain text otherwise.
  function docFromParts({ plain, html } = {}) {
    if (html && String(html).trim()) return parseHtml(html);
    return fromPlain(plain || '');
  }

  // ── Merging ──────────────────────────────────────────────────────────
  //
  // A note edited here while another computer or phone saved a newer
  // version of it: both sets of changes, block by block. `base` is the
  // version the edits here started from, `mine` the text here now, and
  // `theirs` the newer version. A stretch only one side changed takes
  // that side's blocks; a stretch both changed keeps theirs and then
  // whatever of mine they do not already have, so nothing typed on
  // either is lost - at worst a paragraph appears twice.

  const blockKey = b => JSON.stringify(b);
  const sameDoc = (a, b) => JSON.stringify(normaliseDoc(a)) === JSON.stringify(normaliseDoc(b));

  // The longest common subsequence of two lists of keys, as pairs of
  // indices [i in a, j in b], in order. The ends both lists share are
  // matched first, so the table only spans the stretch that differs.
  function commonPairs(a, b) {
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ea = a.length;
    let eb = b.length;
    while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const pairs = [];
    for (let i = 0; i < lo; i++) pairs.push([i, i]);
    const n = ea - lo;
    const m = eb - lo;
    // Too big a table to be worth it: no matches in the middle, which
    // only makes the merge keep more of both sides.
    if (n && m && n * m <= 4e6) {
      const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          len[i][j] = a[lo + i] === b[lo + j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[lo + i] === b[lo + j]) { pairs.push([lo + i, lo + j]); i++; j++; } else if (len[i + 1][j] >= len[i][j + 1]) i++; else j++;
      }
    }
    for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k]);
    return pairs;
  }

  // { doc, map, clean }: the merged blocks; for each of mine's blocks,
  // where it is in them (so a cursor can stay put); and whether no
  // stretch was changed on both sides.
  function mergeDocs(baseIn, mineIn, theirsIn) {
    const base = normaliseDoc(baseIn);
    const mine = normaliseDoc(mineIn);
    const theirs = normaliseDoc(theirsIn);
    const kb = base.map(blockKey);
    const km = mine.map(blockKey);
    const kt = theirs.map(blockKey);
    const toMine = new Map(commonPairs(kb, km));
    const toTheirs = new Map(commonPairs(kb, kt));
    // The blocks neither side touched, in order on all three.
    const anchors = [];
    let lastM = -1;
    let lastT = -1;
    for (let i = 0; i < kb.length; i++) {
      if (!toMine.has(i) || !toTheirs.has(i)) continue;
      const m = toMine.get(i);
      const t = toTheirs.get(i);
      if (m > lastM && t > lastT) { anchors.push(i); lastM = m; lastT = t; }
    }
    const out = [];
    const map = new Array(mine.length).fill(-1);
    let clean = true;
    const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    let b0 = 0;
    let m0 = 0;
    let t0 = 0;
    for (const a of anchors.concat([kb.length])) {
      const m1 = a < kb.length ? toMine.get(a) : km.length;
      const t1 = a < kb.length ? toTheirs.get(a) : kt.length;
      const B = kb.slice(b0, a);
      const M = km.slice(m0, m1);
      const T = kt.slice(t0, t1);
      const start = out.length;
      if (same(M, B) && !same(T, B)) {
        // Only they changed this stretch.
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) map[k] = Math.min(start + (k - m0), Math.max(start, out.length - 1));
      } else if (same(T, B) || same(M, T)) {
        // Only this side changed it, or both the same way.
        for (let k = m0; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
      } else if (B.length && M.length === B.length && T.length === B.length) {
        // As many blocks on each side: block by block, each side's change
        // where only it changed one, both where both changed the same one.
        for (let k = 0; k < B.length; k++) {
          const [b, mm, tt] = [B[k], M[k], T[k]];
          if (mm === b) { map[m0 + k] = out.length; out.push(theirs[t0 + k]); } else if (tt === b || tt === mm) { map[m0 + k] = out.length; out.push(mine[m0 + k]); } else {
            clean = false;
            out.push(theirs[t0 + k]);
            map[m0 + k] = out.length;
            out.push(mine[m0 + k]);
          }
        }
      } else if (B.length && (same(T.slice(0, B.length), B) || same(T.slice(T.length - B.length), B))) {
        // They only added before or after it, and this side changed it.
        const after = same(T.slice(0, B.length), B);
        if (!after) for (let k = t0; k < t1 - B.length; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
        if (after) for (let k = t0 + B.length; k < t1; k++) out.push(theirs[k]);
      } else if (B.length && (same(M.slice(0, B.length), B) || same(M.slice(M.length - B.length), B))) {
        // This side only added before or after it, and they changed it.
        const after = same(M.slice(0, B.length), B);
        if (!after) for (let k = m0; k < m1 - B.length; k++) { map[k] = out.length; out.push(mine[k]); }
        const theirsAt = out.length;
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        const kept = after ? [m0, m0 + B.length] : [m1 - B.length, m1];
        for (let k = kept[0]; k < kept[1]; k++) map[k] = Math.min(theirsAt + (k - kept[0]), Math.max(theirsAt, out.length - 1));
        if (after) for (let k = m0 + B.length; k < m1; k++) { map[k] = out.length; out.push(mine[k]); }
      } else {
        // Both changed it: theirs, then what of mine is new to it.
        clean = false;
        for (let k = t0; k < t1; k++) out.push(theirs[k]);
        for (let k = m0; k < m1; k++) {
          const there = T.indexOf(km[k]);
          if (there >= 0) map[k] = start + there;
          else { map[k] = out.length; out.push(mine[k]); }
        }
      }
      if (a < kb.length) { map[m1] = out.length; out.push(mine[m1]); }
      b0 = a + 1;
      m0 = m1 + 1;
      t0 = t1 + 1;
    }
    if (!out.length) out.push(block('p'));
    for (let k = 0; k < map.length; k++) map[k] = Math.max(0, Math.min(out.length - 1, map[k]));
    return { doc: out, map, clean };
  }

  const api = {
    TYPES, LISTS, MAX_LEVEL,
    block, emptyDoc, normaliseRuns, normaliseDoc, docText, isEmpty, safeHref,
    toHtml, toPlain, fromPlain, parseHtml, docFromParts, fromMarkdown, looksLikeMarkdown, hasFormatting, pasteDoc,
    mergeDocs, sameDoc, table, onlyTable, tableText, MAX_COLS, MAX_ROWS,
  };

  ns.noteFormat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

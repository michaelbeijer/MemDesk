// ─────────────────────────────────────────────────────────────────────
// The formatted note editor
//
// An editable area with a toolbar: text style (normal, three headings),
// bold, italic, strike-through, bulleted, numbered and check lists with
// three levels of nesting, tables, links, and clear formatting.
//
// The editable area is a flat column of blocks - one <div class="blk">
// per paragraph, heading or list item, its kind and indent in data
// attributes, bullets, numbers and boxes drawn by the stylesheet. Bold,
// italic, strike-through and links use the browser's own editing
// commands, which handle them well. Lists and headings do not use them:
// the browser's list commands nest elements in ways that are hard to read
// back, so blocks are restyled here directly instead. What is saved is
// never this markup: it is read back into the note-format model, which
// only knows what the toolbar can make.
//
// Pasted text keeps the formatting the model can hold - from Word, Google
// Docs, a web page, an email, Excel, or Markdown from a chat assistant -
// read by note-format's own reader, so a page copied from the web brings
// its bold and lists but never its styles, images or scripts. Ctrl+Shift+V
// pastes the text alone. Dropped text is not taken at all.
//
// A table is an island the text cannot run into: its block is not
// editable, each of its cells is, on its own, so typing, deleting and
// pasting can never break the grid. Tab moves from cell to cell (and
// adds a row at the end), the arrow keys leave a cell at its edges, and
// the table bar - shown while the cursor is in a cell - adds, removes,
// aligns and sorts. Cells copied from a spreadsheet and pasted into a
// cell fill the cells from there, as in a spreadsheet.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, openMenu, closeMenu } = ns.ui;
  const fmt = ns.noteFormat;
  const NEW_TABLE = { cols: 3, rows: 3 };

  const STYLES = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3']];
  const STYLE_LABEL = Object.fromEntries(STYLES);
  const HEADINGS = new Set(['h1', 'h2', 'h3']);
  const INDENT_PX = 24;

  // Typed at the start of a paragraph and followed by a space, these turn
  // it into a list or heading - the shortcuts most editors share.
  const AUTO = [
    [/^[-*•]$/, { type: 'ul' }],
    [/^1[.)]$/, { type: 'ol' }],
    [/^\[ ?\]$/, { type: 'check' }],
    [/^\[[xX]\]$/, { type: 'check', checked: true }],
    [/^#$/, { type: 'h1' }],
    [/^##$/, { type: 'h2' }],
    [/^###$/, { type: 'h3' }],
  ];

  // ── Model ↔ markup ───────────────────────────────────────────────────

  function setBlock(el, type, level = 0, checked = false) {
    el.dataset.type = type;
    if (fmt.LISTS.has(type)) el.dataset.level = String(level);
    else delete el.dataset.level;
    if (type === 'check') el.dataset.checked = checked ? '1' : '0';
    else delete el.dataset.checked;
  }

  function inlineNodes(runs) {
    const out = [];
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href || '';
      const group = [];
      let j = i;
      while (j < runs.length && (runs[j].href || '') === href) {
        let node = document.createTextNode(runs[j].text);
        for (const m of ['s', 'i', 'b']) {
          if (!runs[j][m]) continue;
          const w = document.createElement(m);
          w.appendChild(node);
          node = w;
        }
        group.push(node);
        j++;
      }
      if (href) out.push(h('a', { href, title: href }, group));
      else out.push(...group);
      i = j;
    }
    return out;
  }

  // Line breaks in a cell's text as <br>s; a cell ending in one gets a
  // second, or the browser would not show the empty line.
  function breakLines(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes('\n')) found.push(n);
    for (const n of found) {
      const parts = [];
      n.data.split('\n').forEach((piece, i) => {
        if (i) parts.push(document.createElement('br'));
        if (piece) parts.push(document.createTextNode(piece));
      });
      n.replaceWith(...parts);
    }
    if (el.lastChild && el.lastChild.nodeName === 'BR') el.appendChild(document.createElement('br'));
  }

  function fillCell(td, runs) {
    td.replaceChildren(...inlineNodes(runs || []));
    breakLines(td);
    if (!td.firstChild) td.appendChild(document.createElement('br'));
  }

  function cellEl(runs, align) {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    if (align) td.style.textAlign = align;
    fillCell(td, runs);
    return td;
  }

  function tableEl(b) {
    const el = document.createElement('div');
    el.className = 'blk';
    el.dataset.type = 'table';
    el.dataset.head = b.head ? '1' : '0';
    el.dataset.align = b.align.join(',');
    el.contentEditable = 'false';
    const body = document.createElement('tbody');
    for (const r of b.rows) {
      const tr = document.createElement('tr');
      r.forEach((c, k) => tr.appendChild(cellEl(c.runs, b.align[k])));
      body.appendChild(tr);
    }
    const t = document.createElement('table');
    t.appendChild(body);
    el.appendChild(t);
    return el;
  }

  function blockEl(b) {
    if (b.type === 'table') return tableEl(b);
    const el = document.createElement('div');
    el.className = 'blk';
    setBlock(el, b.type, b.level, b.checked);
    const kids = inlineNodes(b.runs);
    if (kids.length) el.append(...kids);
    else el.appendChild(document.createElement('br'));
    return el;
  }

  function styleMarks(style) {
    const s = String(style || '').toLowerCase();
    return {
      b: /font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(s),
      i: /font-style\s*:\s*italic/.test(s),
      s: /text-decoration(-line)?\s*:[^;]*line-through/.test(s),
    };
  }

  const NESTED_BLOCKS = new Set(['div', 'p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']);

  // The marks inside an element: those around it, and its own.
  function marksOf(el, tag, marks) {
    const m = { ...marks };
    if (tag === 'b' || tag === 'strong') m.b = true;
    else if (tag === 'i' || tag === 'em') m.i = true;
    else if (tag === 's' || tag === 'strike' || tag === 'del') m.s = true;
    else if (tag === 'a') {
      const href = fmt.safeHref(el.getAttribute('href'));
      if (href) m.href = href;
    } else if (tag === 'span' || tag === 'font') {
      const st = styleMarks(el.getAttribute('style'));
      if (st.b) m.b = true;
      if (st.i) m.i = true;
      if (st.s) m.s = true;
    }
    return m;
  }

  // A cell's runs: a <br>, or the start of a block the browser put in it,
  // is a line break; the ones it ends with are its placeholders.
  function readCell(td) {
    const runs = [];
    const nl = () => { if (runs.length && !/\n$/.test(runs[runs.length - 1].text)) runs.push({ text: '\n' }); };
    (function walk(node, marks) {
      for (const child of node.childNodes) {
        // The editor keeps spaces and line breaks as typed (pre-wrap), so
        // Chrome writes Enter in a cell as a line break in the text itself.
        if (child.nodeType === 3) {
          if (child.data) runs.push({ text: child.data.replace(/\u00a0/g, ' '), ...marks });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') { runs.push({ text: '\n' }); continue; }
        if (NESTED_BLOCKS.has(tag)) { nl(); walk(child, marks); nl(); continue; }
        walk(child, marksOf(child, tag, marks));
      }
    })(td, {});
    while (runs.length && /\n$/.test(runs[runs.length - 1].text)) {
      const last = runs[runs.length - 1];
      last.text = last.text.replace(/\n$/, '');
      if (!last.text) runs.pop();
    }
    return runs;
  }

  function readTable(el) {
    const t = el.querySelector('table');
    const rows = t ? [...t.rows].map(tr => [...tr.cells].map(td => ({ runs: readCell(td) }))) : [];
    return fmt.table(rows, { head: el.dataset.head === '1', align: String(el.dataset.align || '').split(',') });
  }

  // Reads one block element - and anything the browser may have left
  // inside it, such as a <br> or a nested <div> - into model blocks.
  function readBlock(el, out) {
    const type = fmt.TYPES.has(el.dataset.type) ? el.dataset.type : 'p';
    const level = Number(el.dataset.level) || 0;
    const first = out.length;
    let cur = fmt.block(type, [], { level, checked: el.dataset.checked === '1' });
    out.push(cur);
    const next = () => {
      cur = fmt.block(type, [], { level });
      out.push(cur);
    };
    (function walk(node, marks) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (child.data) cur.runs.push({ text: child.data.replace(/\u00a0/g, ' ').replace(/\n/g, ' '), ...marks });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') { next(); continue; }
        if (NESTED_BLOCKS.has(tag)) {
          if (cur.runs.length) next();
          walk(child, marks);
          next();
          continue;
        }
        walk(child, marksOf(child, tag, marks));
      }
    })(el, {});
    // A <br> or nested block at the very end leaves an empty block behind:
    // that is the browser's placeholder, not a new line.
    while (out.length - 1 > first && !out[out.length - 1].runs.some(r => r.text)) out.pop();
  }

  function readDoc(editor) {
    const blocks = [];
    for (const node of editor.childNodes) {
      if (node.nodeType === 1 && node.dataset.type === 'table') blocks.push(readTable(node));
      else if (node.nodeType === 1 && node.classList.contains('blk')) readBlock(node, blocks);
      else if (node.nodeType === 3 && node.data.trim()) blocks.push(fmt.block('p', [{ text: node.data.replace(/ /g, ' ') }]));
      else if (node.nodeType === 1 && node.tagName !== 'BR') readBlock(node, blocks);
    }
    return fmt.normaliseDoc(blocks);
  }

  // ── Selection ────────────────────────────────────────────────────────

  // `contents`: { shown, onToggle(shown) } where the host has room for
  // the note's headings beside it (the notes view, not the calendar's
  // tile): a button for them on the toolbar, and `outline` to place.
  function create({ root, onChange, contents = null }) {
    const els = {};
    let saved = null;     // the last selection inside the editor
    let editable = false;
    let plainNext = false; // Ctrl+Shift+V: the next paste is text alone
    let pasteUndo = [];    // how the text was before each formatted paste, latest last

    const selection = () => (root.getSelection ? root.getSelection() : document.getSelection());

    function range() {
      const sel = selection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      return els.editor.contains(r.startContainer) && els.editor.contains(r.endContainer) ? r : null;
    }

    function select(r) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    // Toolbar buttons do not take focus from the text, but the style menu
    // and the link field do; the selection they were opened on is put
    // back before the change is applied.
    function restore() {
      // The selection can still be in the text while the focus is not -
      // on the style button the menu handed it back to, say - and typing
      // would then go nowhere. Both are put back.
      const keep = range() || (saved && els.editor.contains(saved.startContainer) ? saved : null);
      // In a table, the cell is what takes typing.
      const host = (keep && cellOf(keep.startContainer)) || els.editor;
      if (root.activeElement !== host) host.focus({ preventScroll: true });
      if (keep) {
        try { select(keep.cloneRange ? keep.cloneRange() : keep); } catch { /* the text changed underneath */ }
      }
    }

    function blockOf(node) {
      let n = node;
      if (n === els.editor) return null;
      while (n && n.parentNode !== els.editor) n = n.parentNode;
      return n && n.nodeType === 1 ? n : null;
    }

    // ── Table cells ────────────────────────────────────────────────────

    function cellOf(node) {
      for (let n = node; n && n !== els.editor; n = n.parentNode) {
        if (n.nodeType === 1 && n.tagName === 'TD') return n;
      }
      return null;
    }
    const tableOf = td => td.closest('.blk[data-type="table"]');
    const aligns = el => {
      const cols = el.querySelector('tr') ? el.querySelector('tr').cells.length : 0;
      const a = String(el.dataset.align || '').split(',');
      return Array.from({ length: cols }, (_, k) => a[k] || '');
    };
    let lastCell = null; // the cell last typed in, for the table bar's menus

    // The cursor into an element: its start, or its end - before the <br>
    // that only holds an empty line open.
    function caretInto(el, atEnd) {
      const r = document.createRange();
      const kids = el.childNodes;
      if (!atEnd || !kids.length) r.setStart(el, 0);
      else if (kids[kids.length - 1].nodeName === 'BR') r.setStart(el, kids.length - 1);
      else { r.selectNodeContents(el); r.collapse(false); }
      r.collapse(true);
      select(r);
    }

    function focusCell(td, atEnd = false) {
      if (!td) return;
      td.focus({ preventScroll: true });
      caretInto(td, atEnd);
      lastCell = td;
      td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // Out of a table, above or below it: to the block there, or a new
    // empty line if there is none (or only another table).
    function leaveTable(el, below) {
      let target = below ? el.nextElementSibling : el.previousElementSibling;
      if (!target || target.dataset.type === 'table') {
        target = blockEl(fmt.block('p'));
        if (below) el.after(target); else el.before(target);
        changed();
      }
      els.editor.focus({ preventScroll: true });
      caretInto(target, !below);
    }

    // Whether the cursor is on the first (or last) line of an element:
    // its box against the element's first (or last) position.
    function onEdgeLine(el, r, last) {
      const at = r.getClientRects()[0];
      if (!at) return true;
      const probe = document.createRange();
      probe.selectNodeContents(el);
      probe.collapse(!last);
      const edge = probe.getClientRects()[0] || el.getBoundingClientRect();
      return Math.abs((last ? at.bottom - edge.bottom : at.top - edge.top)) < at.height / 2 + 1;
    }

    function caretAtEnd(r, el) {
      if (!r || !r.collapsed) return false;
      const post = document.createRange();
      post.selectNodeContents(el);
      post.setStart(r.endContainer, r.endOffset);
      return post.toString() === '';
    }

    function rangeBlocks(r) {
      const kids = [...els.editor.children];
      const edge = (container, offset, end) => {
        if (container === els.editor) return kids[Math.min(kids.length - 1, Math.max(0, offset - (end ? 1 : 0)))];
        return blockOf(container);
      };
      const a = edge(r.startContainer, r.startOffset, false);
      const b = edge(r.endContainer, r.endOffset, true);
      const i = kids.indexOf(a);
      const j = kids.indexOf(b);
      if (i < 0 || j < 0) return a ? [a] : [];
      return kids.slice(Math.min(i, j), Math.max(i, j) + 1);
    }

    function caretAtBlockStart(r, blk) {
      if (!r || !r.collapsed || !blk) return false;
      const pre = document.createRange();
      pre.selectNodeContents(blk);
      pre.setEnd(r.startContainer, r.startOffset);
      return pre.toString() === '';
    }

    function placeCaret(node, offset) {
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      select(r);
    }

    // ── Keeping the markup tidy ──────────────────────────────────────────

    // Each list item may be at most one level deeper than the one above.
    function fixLevels() {
      let prev = -1;
      for (const blk of els.editor.children) {
        if (fmt.LISTS.has(blk.dataset.type)) {
          const lvl = Math.max(0, Math.min(fmt.MAX_LEVEL, Number(blk.dataset.level) || 0, prev + 1));
          blk.dataset.level = String(lvl);
          prev = lvl;
        } else {
          prev = -1;
        }
      }
    }

    // The browser sometimes leaves text, a <br> or a plain <div> directly
    // in the editor (after select-all and delete, say), and wraps merged
    // text in <span style="font-size…"> when two blocks of different sizes
    // join. Both are put right here, keeping the caret where it was.
    function tidy() {
      const sel = selection();
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const keep = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
      let moved = false;

      for (const node of [...els.editor.childNodes]) {
        if (node.nodeType === 1 && node.classList.contains('blk') && node.dataset.type) continue;
        if (node.nodeType === 1 && /^(DIV|P|H1|H2|H3)$/.test(node.tagName)) {
          node.classList.add('blk');
          setBlock(node, /^H[123]$/.test(node.tagName) ? node.tagName.toLowerCase() : 'p');
          continue;
        }
        if (node.nodeType === 3 && !node.data.trim() && !(keep && (keep[0] === node || keep[2] === node))) {
          node.remove();
          continue;
        }
        const blk = blockEl(fmt.block('p'));
        blk.replaceChildren();
        els.editor.insertBefore(blk, node);
        if (node.nodeType === 1 && node.tagName === 'BR') {
          blk.appendChild(node);
        } else {
          // Gather this and any following inline neighbours into one block.
          let n = node;
          while (n && !(n.nodeType === 1 && (n.classList.contains('blk') || NESTED_BLOCKS.has(n.tagName.toLowerCase())))) {
            const following = n.nextSibling;
            blk.appendChild(n);
            n = following;
          }
        }
        moved = true;
      }

      for (const span of [...els.editor.querySelectorAll('span[style], font')]) {
        const st = styleMarks(span.getAttribute('style'));
        if (st.b || st.i || st.s) continue;
        span.replaceWith(...span.childNodes);
        moved = true;
      }
      for (const a of els.editor.querySelectorAll('a[href]')) {
        const href = fmt.safeHref(a.getAttribute('href'));
        if (!href) a.replaceWith(...a.childNodes);
        else if (a.title !== href) a.title = href;
      }
      if (!els.editor.children.length) {
        els.editor.appendChild(blockEl(fmt.block('p')));
        placeCaret(els.editor.firstChild, 0);
        moved = false;
      }
      // Somewhere to type after a table at the end.
      const lastBlk = els.editor.lastElementChild;
      if (lastBlk && lastBlk.dataset.type === 'table') els.editor.appendChild(blockEl(fmt.block('p')));
      if (moved && keep && keep[0].isConnected && keep[2].isConnected) {
        try {
          const back = document.createRange();
          back.setStart(keep[0], keep[1]);
          back.setEnd(keep[2], keep[3]);
          select(back);
        } catch { /* positions no longer valid */ }
      }
      fixLevels();
      updateEmpty();
    }

    function updateEmpty() {
      const kids = els.editor.children;
      const empty = kids.length <= 1 && (!kids[0] || (kids[0].dataset.type === 'p' && !kids[0].textContent));
      els.editor.dataset.empty = empty ? '1' : '0';
    }

    function changed() {
      pasteUndo = [];
      tidy();
      onChange();
      refreshToolbar();
      scheduleOutline();
    }

    // ── Commands ─────────────────────────────────────────────────────────

    function inline(cmd) {
      if (!editable) return;
      restore();
      document.execCommand(cmd);
      refreshToolbar();
    }

    // Applies a block type to every block the selection touches - or, if
    // they all have it already, turns them back into paragraphs.
    function blockType(type, { checked = false } = {}) {
      if (!editable) return;
      restore();
      const r = range();
      if (!r || cellOf(r.startContainer)) return; // a cell holds text, not lists or headings
      const blocks = rangeBlocks(r);
      const off = blocks.every(b => b.dataset.type === type) && type !== 'p';
      for (const b of blocks) {
        const was = b.dataset.type;
        const level = fmt.LISTS.has(was) ? Number(b.dataset.level) || 0 : 0;
        setBlock(b, off ? 'p' : type, level, type === 'check' && was === 'check' ? b.dataset.checked === '1' : checked);
      }
      changed();
    }

    function indent(delta) {
      if (!editable) return false;
      const r = range();
      if (!r || cellOf(r.startContainer)) return false;
      const blocks = rangeBlocks(r).filter(b => fmt.LISTS.has(b.dataset.type));
      if (!blocks.length) return false;
      for (const b of blocks) b.dataset.level = String(Math.max(0, Math.min(fmt.MAX_LEVEL, (Number(b.dataset.level) || 0) + delta)));
      changed();
      return true;
    }

    function toggleCheck(blk) {
      if (!editable || !blk || blk.dataset.type !== 'check') return;
      blk.dataset.checked = blk.dataset.checked === '1' ? '0' : '1';
      changed();
    }

    function clearFormatting() {
      if (!editable) return;
      restore();
      document.execCommand('removeFormat');
      document.execCommand('unlink');
      const r = range();
      if (r && !cellOf(r.startContainer)) for (const b of rangeBlocks(r)) if (b.dataset.type !== 'table') setBlock(b, 'p');
      changed();
    }

    function anchorAt(r) {
      let n = r && r.startContainer;
      while (n && n !== els.editor) {
        if (n.nodeType === 1 && n.tagName === 'A') return n;
        n = n.parentNode;
      }
      return null;
    }

    // ── Links ────────────────────────────────────────────────────────────

    function openLink() {
      if (!editable) return;
      const r = range() || saved;
      if (!r) return;
      saved = r.cloneRange();
      const a = anchorAt(r);
      els.linkInput.value = a ? a.getAttribute('href') : '';
      els.linkError.textContent = '';
      els.linkRemove.hidden = !a;
      els.linkbar.hidden = false;
      els.linkInput.focus();
      els.linkInput.select();
    }

    function closeLink({ refocus = true } = {}) {
      if (els.linkbar.hidden) return;
      els.linkbar.hidden = true;
      if (refocus) restore();
    }

    function applyLink() {
      const href = fmt.safeHref(els.linkInput.value);
      if (!href) {
        els.linkError.textContent = 'That is not a web or email address.';
        return;
      }
      closeLink();
      const r = range();
      if (!r) return;
      const a = anchorAt(r);
      if (r.collapsed && a) {
        a.setAttribute('href', href);
        a.title = href;
      } else if (r.collapsed) {
        // Nothing selected: the address itself becomes the link text.
        const text = href.replace(/^mailto:/, '');
        document.execCommand('insertText', false, text);
        const after = range();
        if (after) {
          const sel = document.createRange();
          sel.setStart(after.startContainer, Math.max(0, after.startOffset - text.length));
          sel.setEnd(after.startContainer, after.startOffset);
          select(sel);
          document.execCommand('createLink', false, href);
          const end = range();
          if (end) { end.collapse(false); select(end); }
        }
      } else {
        document.execCommand('createLink', false, href);
      }
      changed();
    }

    function removeLink() {
      closeLink();
      const r = range();
      const a = anchorAt(r);
      if (a) {
        const sel = document.createRange();
        sel.selectNodeContents(a);
        select(sel);
      }
      document.execCommand('unlink');
      changed();
    }

    // ── Tables ───────────────────────────────────────────────────────────

    // The cell being worked on: the one with the cursor, or - while one of
    // the table bar's menus has the focus - the one it was in.
    function cellNow() {
      const r = range();
      const td = r && cellOf(r.startContainer);
      if (td) return td;
      return lastCell && lastCell.isConnected && els.editor.contains(lastCell) ? lastCell : null;
    }

    // A change to a table's shape, which Ctrl+Z straight afterwards takes
    // back, as it does a formatted paste. `fn` gets the cell and its table
    // and returns the cell to go to next.
    function tableEdit(fn) {
      if (!editable) return;
      const td = cellNow();
      if (!td) return;
      const undo = pasteUndo;
      const before = snapshot();
      const next = fn(td, tableOf(td));
      changed();
      pasteUndo = [...undo.slice(-19), before];
      if (next) focusCell(next, true);
      refreshToolbar();
    }

    const rowsOf = el => el.querySelector('table').rows;
    function newRow(el) {
      const a = aligns(el);
      const tr = document.createElement('tr');
      for (const al of a) tr.appendChild(cellEl([], al));
      return tr;
    }
    const tbodyOf = el => el.querySelector('tbody') || el.querySelector('table');

    function addRow(below, { first = false } = {}) {
      tableEdit((td, el) => {
        if (rowsOf(el).length >= fmt.MAX_ROWS) return td;
        const tr = newRow(el);
        if (below) td.parentNode.after(tr);
        else td.parentNode.before(tr);
        return tr.cells[first ? 0 : td.cellIndex];
      });
    }

    function addColumn(right) {
      tableEdit((td, el) => {
        const rows = rowsOf(el);
        if (rows[0].cells.length >= fmt.MAX_COLS) return td;
        const k = td.cellIndex + (right ? 1 : 0);
        const a = aligns(el);
        a.splice(k, 0, '');
        for (const tr of rows) tr.insertBefore(cellEl([], ''), tr.cells[k] || null);
        el.dataset.align = a.join(',');
        return td.parentNode.cells[k];
      });
    }

    // The table gone: the cursor to the line after it.
    function removeTable(el) {
      let next = el.nextElementSibling;
      if (!next || next.dataset.type === 'table') {
        next = blockEl(fmt.block('p'));
        el.after(next);
      }
      el.remove();
      lastCell = null;
      els.editor.focus({ preventScroll: true });
      caretInto(next, false);
      return null;
    }

    function deleteRow() {
      tableEdit((td, el) => {
        if (rowsOf(el).length === 1) return removeTable(el);
        const tr = td.parentNode;
        const next = tr.nextElementSibling || tr.previousElementSibling;
        tr.remove();
        return next.cells[Math.min(td.cellIndex, next.cells.length - 1)];
      });
    }

    function deleteColumn() {
      tableEdit((td, el) => {
        const rows = rowsOf(el);
        if (rows[0].cells.length === 1) return removeTable(el);
        const k = td.cellIndex;
        const a = aligns(el);
        a.splice(k, 1);
        const tr = td.parentNode;
        for (const row of rows) row.cells[k].remove();
        el.dataset.align = a.join(',');
        return tr.cells[Math.min(k, tr.cells.length - 1)];
      });
    }

    function toggleHead() {
      tableEdit((td, el) => {
        el.dataset.head = el.dataset.head === '1' ? '0' : '1';
        return td;
      });
    }

    function alignColumn(value) {
      tableEdit((td, el) => {
        const k = td.cellIndex;
        const a = aligns(el);
        a[k] = value;
        el.dataset.align = a.join(',');
        for (const tr of rowsOf(el)) if (tr.cells[k]) tr.cells[k].style.textAlign = value;
        return td;
      });
    }

    // The rows in order of one column - numbers as numbers, empty cells
    // last - with a heading row staying on top.
    function sortRows(desc) {
      tableEdit((td, el) => {
        const k = td.cellIndex;
        const rows = [...rowsOf(el)];
        const head = el.dataset.head === '1' ? rows.shift() : null;
        const key = tr => (tr.cells[k] ? tr.cells[k].textContent.trim() : '');
        const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        rows.sort((x, y) => {
          const a = key(x);
          const b = key(y);
          if (!a !== !b) return a ? -1 : 1;
          return desc ? order.compare(b, a) : order.compare(a, b);
        });
        const body = tbodyOf(el);
        if (head) body.appendChild(head);
        for (const tr of rows) body.appendChild(tr);
        return td;
      });
    }

    // A new table where the cursor is: in place of an empty line, or after
    // the line it is on; three columns, a heading row and two more.
    function insertTable() {
      if (!editable) return;
      restore();
      const r = range();
      if (!r || cellOf(r.startContainer)) return;
      const blk = blockOf(r.startContainer) || els.editor.lastElementChild;
      if (!blk) return;
      const undo = pasteUndo;
      const before = snapshot();
      const rows = Array.from({ length: NEW_TABLE.rows }, () => Array.from({ length: NEW_TABLE.cols }, () => ({ runs: [] })));
      const el = tableEl(fmt.table(rows, { head: true, align: Array(NEW_TABLE.cols).fill('') }));
      if (blk.dataset.type === 'p' && !blk.textContent) blk.replaceWith(el);
      else blk.after(el);
      if (!el.nextElementSibling || el.nextElementSibling.dataset.type === 'table') el.after(blockEl(fmt.block('p')));
      changed();
      pasteUndo = [...undo.slice(-19), before];
      focusCell(el.querySelector('td'));
    }

    // Keys in a cell: Tab and Shift+Tab from cell to cell (Tab in the last
    // one adds a row), Enter a new line in the cell, the arrows out of it
    // at its edges, and nothing joining a cell to another.
    function cellKey(e, td, r, mod) {
      const el = tableOf(td);
      const cells = [...el.querySelectorAll('td')];
      const i = cells.indexOf(td);
      const tr = td.parentNode;
      const go = (cell, atEnd) => { e.preventDefault(); focusCell(cell, atEnd); return true; };
      const out = below => { e.preventDefault(); leaveTable(el, below); return true; };
      if (e.key === 'Tab' && !mod && !e.altKey) {
        if (e.shiftKey) return i > 0 ? go(cells[i - 1], true) : (e.preventDefault(), true);
        if (i < cells.length - 1) return go(cells[i + 1], true);
        e.preventDefault();
        addRow(true, { first: true });
        return true;
      }
      if (e.key === 'Enter' && !mod && !e.altKey && !e.isComposing) {
        e.preventDefault();
        document.execCommand('insertLineBreak');
        return true;
      }
      if (!mod && ((e.key === 'Backspace' && caretAtBlockStart(r, td)) || (e.key === 'Delete' && caretAtEnd(r, td)))) {
        e.preventDefault();
        return true;
      }
      if (!mod && !e.altKey && !e.shiftKey && r.collapsed) {
        const k = td.cellIndex;
        if (e.key === 'ArrowUp' && onEdgeLine(td, r, false)) {
          const up = tr.previousElementSibling;
          return up ? go(up.cells[Math.min(k, up.cells.length - 1)], true) : out(false);
        }
        if (e.key === 'ArrowDown' && onEdgeLine(td, r, true)) {
          const down = tr.nextElementSibling;
          return down ? go(down.cells[Math.min(k, down.cells.length - 1)], false) : out(true);
        }
        if (e.key === 'ArrowLeft' && caretAtBlockStart(r, td)) return i > 0 ? go(cells[i - 1], true) : out(false);
        if (e.key === 'ArrowRight' && caretAtEnd(r, td)) return i < cells.length - 1 ? go(cells[i + 1], false) : out(true);
      }
      // Lists and headings are not for cells.
      if (mod && e.shiftKey && /^Digit[789]$/.test(e.code)) { e.preventDefault(); return true; }
      return false;
    }

    // Keys on a line beside a table: the arrows into it, and Backspace or
    // Delete into it rather than through it.
    function besideTable(e, r, blk, mod) {
      if (mod || e.altKey || e.shiftKey || !r.collapsed) return false;
      const prev = blk.previousElementSibling;
      const next = blk.nextElementSibling;
      const into = (el, last) => {
        e.preventDefault();
        const cells = el.querySelectorAll('td');
        focusCell(last ? cells[cells.length - 1] : cells[0], last);
        return true;
      };
      if (next && next.dataset.type === 'table') {
        if ((e.key === 'ArrowDown' && onEdgeLine(blk, r, true)) || (e.key === 'ArrowRight' && caretAtEnd(r, blk))) return into(next, false);
        if (e.key === 'Delete' && caretAtEnd(r, blk)) {
          if (!blk.textContent && blk.previousElementSibling) { blk.remove(); changed(); }
          return into(next, false);
        }
      }
      if (prev && prev.dataset.type === 'table') {
        if (e.key === 'ArrowUp' && onEdgeLine(blk, r, false)) {
          // Up into the last row, at its start.
          e.preventDefault();
          const rows = prev.querySelector('table').rows;
          focusCell(rows[rows.length - 1].cells[0], true);
          return true;
        }
        if (e.key === 'ArrowLeft' && caretAtBlockStart(r, blk)) return into(prev, true);
        // An empty line after a table goes (unless it is the last); a line
        // with text keeps it, and the cursor goes into the table.
        if (e.key === 'Backspace' && blk.dataset.type === 'p' && caretAtBlockStart(r, blk)) {
          if (!blk.textContent && blk.nextElementSibling) { blk.remove(); changed(); }
          return into(prev, true);
        }
      }
      return false;
    }

    // A paste into a cell: cells - a table, or tab-separated text, as a
    // spreadsheet copies them - fill the cells from this one on, adding
    // rows and columns as needed; anything else goes in as text.
    function pasteInCell(doc, text) {
      const t = doc && fmt.onlyTable(doc);
      let grid = t ? t.rows.map(row => row.map(c => c.runs)) : null;
      if (!grid && /\t/.test(text || '')) {
        grid = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t').map(c => [{ text: c }]));
      }
      if (grid && (grid.length > 1 || grid[0].length > 1)) {
        tableEdit((td, el) => {
          const rows = rowsOf(el);
          const r0 = td.parentNode.rowIndex;
          const c0 = td.cellIndex;
          const wide = Math.min(fmt.MAX_COLS, c0 + Math.max(...grid.map(row => row.length)));
          while (rows[0].cells.length < wide) for (const tr of rows) tr.appendChild(cellEl([], ''));
          el.dataset.align = aligns(el).join(',');
          const tall = Math.min(fmt.MAX_ROWS, r0 + grid.length);
          while (rows.length < tall) tbodyOf(el).appendChild(newRow(el));
          let last = td;
          grid.forEach((row, i) => row.forEach((runs, j) => {
            const cell = rows[r0 + i] && rows[r0 + i].cells[c0 + j];
            if (!cell) return;
            fillCell(cell, runs);
            last = cell;
          }));
          return last;
        });
        return;
      }
      const one = grid ? grid[0][0].map(x => x.text).join('') : doc ? fmt.docText(doc) : String(text || '');
      String(one).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').forEach((line, i) => {
        if (i) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    }

    // ── Toolbar ──────────────────────────────────────────────────────────

    const buttons = {};
    const tbButton = (key, label, iconName, onClick, toggle = true) => {
      const b = h('button', {
        class: 'tb-btn', type: 'button', title: label, 'aria-label': label,
        'aria-pressed': toggle ? 'false' : null, dataset: { key: `fmt-${key}` },
        // Keeps the focus - and so the selection - in the text.
        onmousedown: e => e.preventDefault(),
        onclick: () => onClick(),
      }, icon(iconName, 20));
      buttons[key] = b;
      return b;
    };
    const sep = () => h('span', { class: 'tb-sep', 'aria-hidden': 'true' });

    els.styleLabel = h('span', { class: 'tb-style-label', text: 'Normal text' });
    els.style = h('button', {
      class: 'tb-style', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': 'Text style', title: 'Text style', dataset: { key: 'fmt-style' },
      onmousedown: e => e.preventDefault(),
      onclick: () => {
        if (!editable) return;
        const r = range();
        if (r) saved = r.cloneRange();
        const cur = currentType();
        openMenu(root, els.style, STYLES.map(([type, label]) => ({
          label, key: `style:${type}`, checked: cur === type,
          onSelect: () => blockType(type),
        })), { label: 'Text style' });
      },
    }, els.styleLabel, icon('caret', 18));

    els.toolbar = h('div', { class: 'ne-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
      els.style,
      sep(),
      tbButton('bold', 'Bold (Ctrl+B)', 'bold', () => inline('bold')),
      tbButton('italic', 'Italic (Ctrl+I)', 'italic', () => inline('italic')),
      tbButton('strike', 'Strike-through', 'strike', () => inline('strikeThrough')),
      sep(),
      tbButton('ul', 'Bulleted list (Ctrl+Shift+8)', 'bullets', () => blockType('ul')),
      tbButton('ol', 'Numbered list (Ctrl+Shift+7)', 'numbers', () => blockType('ol')),
      tbButton('check', 'Checklist (Ctrl+Shift+9)', 'checklist', () => blockType('check')),
      tbButton('outdent', 'Less indent (Shift+Tab)', 'outdent', () => { restore(); indent(-1); }, false),
      tbButton('indent', 'More indent (Tab)', 'indent', () => { restore(); indent(1); }, false),
      tbButton('table', 'Table', 'table', () => insertTable(), false),
      sep(),
      tbButton('link', 'Link (Ctrl+K)', 'link', () => openLink()),
      tbButton('clear', 'Clear formatting', 'clear', () => clearFormatting(), false));
    if (contents) {
      els.toolbar.append(h('span', { class: 'tb-sep tb-contents-sep', 'aria-hidden': 'true' }),
        tbButton('contents', 'Contents: the note’s headings, beside it', 'contents', () => toggleContents()));
    }

    els.linkInput = h('input', {
      class: 'text-input', type: 'text', placeholder: 'Web address or email', 'aria-label': 'Link address',
      spellcheck: 'false', dataset: { key: 'fmt-link-input' },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLink(); }
      },
    });
    els.linkError = h('span', { class: 'link-error', role: 'alert' });
    els.linkRemove = h('button', { class: 'btn btn-text', type: 'button', text: 'Remove link', dataset: { key: 'fmt-link-remove' }, onclick: removeLink });
    els.linkbar = h('div', { class: 'ne-linkbar', hidden: true },
      icon('link', 18), els.linkInput,
      h('button', { class: 'btn btn-tonal', type: 'button', text: 'Apply', dataset: { key: 'fmt-link-apply' }, onclick: applyLink }),
      els.linkRemove,
      h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: () => closeLink() }),
      els.linkError);

    // The table bar: under the toolbar while the cursor is in a cell.
    const keepFocus = e => e.preventDefault();
    const menuButton = (key, label, items) => {
      const b = h('button', {
        class: 'tb-text', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { key },
        onmousedown: keepFocus,
        onclick: () => { if (editable && cellNow()) openMenu(root, b, items(), { label }); },
      }, label, icon('caret', 18));
      return b;
    };
    els.tableHead = h('button', {
      class: 'tb-text', type: 'button', 'aria-pressed': 'false', title: 'The first row is a heading row',
      dataset: { key: 'table-head' }, onmousedown: keepFocus, onclick: () => toggleHead(),
    }, 'Heading row');
    els.tablebar = h('div', { class: 'ne-tablebar', role: 'toolbar', 'aria-label': 'Table', hidden: true },
      h('span', { class: 'tb-label' }, icon('table', 18)),
      menuButton('table-row', 'Row', () => [
        { label: 'Insert row above', key: 'row-above', onSelect: () => addRow(false) },
        { label: 'Insert row below', key: 'row-below', onSelect: () => addRow(true) },
        { separator: true },
        { label: 'Delete row', key: 'row-delete', danger: true, onSelect: () => deleteRow() },
      ]),
      menuButton('table-column', 'Column', () => [
        { label: 'Insert column left', key: 'col-left', onSelect: () => addColumn(false) },
        { label: 'Insert column right', key: 'col-right', onSelect: () => addColumn(true) },
        { separator: true },
        { label: 'Delete column', key: 'col-delete', danger: true, onSelect: () => deleteColumn() },
      ]),
      els.tableHead,
      sep(),
      tbButton('align-left', 'Align column left', 'alignLeft', () => alignColumn('')),
      tbButton('align-center', 'Centre column', 'alignCenter', () => alignColumn('center')),
      tbButton('align-right', 'Align column right', 'alignRight', () => alignColumn('right')),
      sep(),
      menuButton('table-sort', 'Sort', () => [
        { label: 'Sort by this column, A to Z', key: 'sort-asc', onSelect: () => sortRows(false) },
        { label: 'Sort by this column, Z to A', key: 'sort-desc', onSelect: () => sortRows(true) },
      ]),
      h('span', { class: 'spacer' }),
      tbButton('table-delete', 'Delete table', 'delete', () => deleteTable(), false));

    function deleteTable() {
      tableEdit((td, el) => removeTable(el));
    }

    function currentType() {
      const r = range() || saved;
      const blk = r && blockOf(r.startContainer);
      return blk ? blk.dataset.type || 'p' : 'p';
    }

    function refreshToolbar() {
      const r = range();
      if (!r) return;
      const type = currentType();
      els.styleLabel.textContent = STYLE_LABEL[type] || 'Normal text';
      for (const [key, cmd] of [['bold', 'bold'], ['italic', 'italic'], ['strike', 'strikeThrough']]) {
        let on = false;
        try { on = document.queryCommandState(cmd); } catch { /* not supported */ }
        buttons[key].setAttribute('aria-pressed', String(on));
      }
      for (const t of ['ul', 'ol', 'check']) buttons[t].setAttribute('aria-pressed', String(type === t));
      buttons.link.setAttribute('aria-pressed', String(!!anchorAt(r)));
      // In a cell: the table bar, and nothing that makes lists or headings.
      const td = cellOf(r.startContainer);
      if (td) lastCell = td;
      els.tablebar.hidden = !td || !editable;
      for (const k of ['ul', 'ol', 'check', 'outdent', 'indent', 'table']) buttons[k].disabled = !editable || !!td;
      els.style.disabled = !editable || !!td;
      if (td) {
        const el = tableOf(td);
        els.tableHead.setAttribute('aria-pressed', String(el.dataset.head === '1'));
        const a = aligns(el)[td.cellIndex] || '';
        buttons['align-left'].setAttribute('aria-pressed', String(a === ''));
        buttons['align-center'].setAttribute('aria-pressed', String(a === 'center'));
        buttons['align-right'].setAttribute('aria-pressed', String(a === 'right'));
      }
    }

    // ── The editable area ────────────────────────────────────────────────

    els.editor = h('div', {
      class: 'ne-body', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note',
      spellcheck: 'true', dataset: { key: 'note-body', empty: '1' },
    });

    els.editor.addEventListener('keydown', e => {
      if (!editable) return;
      const mod = e.ctrlKey || e.metaKey;
      const r = range();
      const blk = r && blockOf(r.startContainer);
      const td = r && cellOf(r.startContainer);
      if (td && cellKey(e, td, r, mod)) return;
      if (!td && blk && besideTable(e, r, blk, mod)) return;

      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && pasteUndo.length) {
        e.preventDefault();
        undoPaste();
        return;
      }
      if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'v') {
        // The paste event follows straight away, in this same task.
        plainNext = true;
        setTimeout(() => { plainNext = false; }, 0);
        return;
      }
      if (mod && !e.altKey && e.shiftKey && /^Digit[789]$/.test(e.code)) {
        e.preventDefault();
        blockType({ Digit7: 'ol', Digit8: 'ul', Digit9: 'check' }[e.code]);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'k') { e.preventDefault(); openLink(); return; }
        if (k === 'u') { e.preventDefault(); return; } // no underline in the model
        if (e.key === 'Enter' && blk && blk.dataset.type === 'check') { e.preventDefault(); toggleCheck(blk); return; }
      }
      if (e.key === 'Tab' && !mod && !e.altKey && blk && fmt.LISTS.has(blk.dataset.type)) {
        e.preventDefault();
        indent(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Enter' && !mod && !e.altKey && !e.isComposing) {
        // An empty list item ends the list; Shift+Enter is a new line like
        // any other, since the model has no line breaks inside a block.
        if (blk && fmt.LISTS.has(blk.dataset.type) && !blk.textContent) {
          e.preventDefault();
          const lvl = Number(blk.dataset.level) || 0;
          if (lvl > 0) blk.dataset.level = String(lvl - 1);
          else setBlock(blk, 'p');
          changed();
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          document.execCommand('insertParagraph');
          return;
        }
      }
      if (e.key === 'Backspace' && !mod && blk && blk.dataset.type !== 'p' && caretAtBlockStart(r, blk)) {
        // At the start of a list item or heading, Backspace undoes the
        // formatting before it starts joining lines.
        e.preventDefault();
        const lvl = Number(blk.dataset.level) || 0;
        if (fmt.LISTS.has(blk.dataset.type) && lvl > 0) blk.dataset.level = String(lvl - 1);
        else setBlock(blk, 'p');
        changed();
      }
    });

    els.editor.addEventListener('input', e => {
      if (e.inputType === 'insertText' && (e.data === ' ' || e.data === ' ')) autoformat();
      if (e.inputType === 'insertParagraph') {
        // The new block is a copy of the one it was split from: a ticked
        // box and a heading should not carry on into an empty new line.
        const r = range();
        const blk = r && blockOf(r.startContainer);
        if (blk && !blk.textContent) {
          if (blk.dataset.type === 'check') blk.dataset.checked = '0';
          if (/^h[123]$/.test(blk.dataset.type)) setBlock(blk, 'p');
        }
      }
      if (/^delete/.test(e.inputType) && els.editor.children.length === 1 && !els.editor.textContent) {
        // Everything deleted: the note starts again from normal text.
        setBlock(els.editor.firstElementChild, 'p');
      }
      changed();
    });

    function autoformat() {
      const r = range();
      if (!r || !r.collapsed) return;
      const blk = blockOf(r.startContainer);
      if (!blk || blk.dataset.type !== 'p') return;
      const pre = document.createRange();
      pre.selectNodeContents(blk);
      pre.setEnd(r.startContainer, r.startOffset);
      const m = /^(\S{1,3})[  ]$/.exec(pre.toString());
      const rule = m && AUTO.find(([re]) => re.test(m[1]));
      if (!rule) return;
      select(pre);
      document.execCommand('delete');
      setBlock(blk, rule[1].type, 0, !!rule[1].checked);
    }

    els.editor.addEventListener('paste', e => {
      e.preventDefault();
      if (!editable) return;
      const data = e.clipboardData;
      const text = (data && data.getData('text/plain')) || '';
      const plain = plainNext;
      plainNext = false;
      const doc = plain ? null : fmt.pasteDoc({ html: data && data.getData('text/html'), text });
      const at = range();
      if (at && cellOf(at.startContainer)) {
        pasteInCell(doc, text);
        revealCaret();
        return;
      }
      // Text with nothing to format goes in the way typing does, so the
      // browser's own undo takes it back: a single line as copied, spaces
      // and all; more than that as the HTML reads (a table's " | ", not
      // its tabs).
      const line = text.replace(/[\r\n]+$/, '');
      if (doc && fmt.hasFormatting(doc)) insertDoc(doc);
      else if (doc && !(doc.length === 1 && line && !/[\r\n\t]/.test(line))) insertPlain(fmt.docText(doc));
      else insertPlain(doc ? line : text);
      revealCaret();
    });
    els.editor.addEventListener('drop', e => {
      // Dropped HTML would bring its own markup; dropped files have nowhere to go.
      e.preventDefault();
    });

    function insertPlain(text) {
      const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => {
        if (i) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
    }

    // ── Formatted paste ──────────────────────────────────────────────────
    //
    // The blocks go in directly - the browser's editing commands would
    // nest and restyle them - with the text after the caret carried to
    // the end of what was pasted. The browser's undo does not know about
    // that, so Ctrl+Z straight afterwards puts back a copy taken first -
    // one paste at a time, until anything else changes the text.

    // Empty text and empty marks left behind by cutting a block in two;
    // also the <br> that holds an empty block open, put back later if
    // the block is still empty.
    function prune(el) {
      for (const n of [...el.childNodes]) {
        if (n.nodeType === 3) { if (!n.data) n.remove(); continue; }
        if (n.nodeType !== 1 || n.tagName === 'BR') { n.remove(); continue; }
        prune(n);
        if (!n.firstChild) n.remove();
      }
    }
    const holdOpen = el => { if (!el.firstChild) el.appendChild(document.createElement('br')); };

    function insertDoc(doc) {
      if (!range()) restore();
      if (!range()) return;
      const undo = pasteUndo;
      const before = snapshot();
      if (!range().collapsed) document.execCommand('delete');
      tidy();
      const r = range();
      if (!r) return;

      let node = r.startContainer;
      let offset = r.startOffset;
      if (node === els.editor) {
        const kids = els.editor.children;
        const k = Math.min(offset, kids.length - 1);
        node = kids[k];
        offset = k < offset ? node.childNodes.length : 0;
      }
      const blk = blockOf(node);
      if (!blk) return;

      // Cut the block at the caret.
      const cut = document.createRange();
      cut.setStart(node, offset);
      cut.setEnd(blk, blk.childNodes.length);
      const after = cut.extractContents();
      prune(after);
      prune(blk);

      const orig = { type: blk.dataset.type || 'p', level: Number(blk.dataset.level) || 0, checked: blk.dataset.checked === '1' };
      // Lists pasted into a list go in at its level.
      const base = fmt.LISTS.has(orig.type) ? orig.level : 0;
      const levelOf = b => (fmt.LISTS.has(b.type) ? Math.min(fmt.MAX_LEVEL, b.level + base) : 0);

      let last = blk;
      let i = 0;
      // The first line joins the text before the caret; on an empty line
      // it also brings its kind (a heading, a list item) with it.
      if (doc[0].type !== 'table' && (doc[0].type === 'p' || !blk.textContent)) {
        if (!blk.textContent && doc[0].type !== 'p') setBlock(blk, doc[0].type, levelOf(doc[0]), doc[0].checked);
        blk.append(...inlineNodes(doc[0].runs));
        i = 1;
      }
      for (; i < doc.length; i++) {
        const el = blockEl({ ...doc[i], level: levelOf(doc[i]) });
        last.after(el);
        last = el;
      }

      // The text after the caret follows the pasted text - on a line of
      // its own kind if the paste ended on a different kind of line.
      const kind = el => `${el.dataset.type}:${el.dataset.level || 0}`;
      let target = last;
      if (after.textContent && last !== blk && kind(last) !== `${orig.type}:${base}`) {
        target = blockEl(fmt.block(orig.type, [], orig));
        target.replaceChildren();
        last.after(target);
      }
      // Nothing goes into a pasted table: the cursor goes to a line after it.
      if (last.dataset.type === 'table' && target === last) {
        target = blockEl(fmt.block('p'));
        target.replaceChildren();
        last.after(target);
      }
      if (last.dataset.type !== 'table') prune(last);
      const at = target === last ? last.childNodes.length : 0;
      target.append(after);
      holdOpen(blk);
      if (last.dataset.type !== 'table') holdOpen(last);
      holdOpen(target);
      // A table pasted on an empty line takes its place.
      if (doc[0].type === 'table' && !blk.textContent && blk !== target) blk.remove();
      if (last.dataset.type === 'table') caretInto(target, false);
      else if (target === last) placeCaret(last, at);
      else placeCaret(last, last.firstChild.nodeName === 'BR' ? 0 : last.childNodes.length);

      changed();
      pasteUndo = [...undo.slice(-19), before];
    }

    // The editor's blocks, and the selection as text offsets within them.
    function snapshot() {
      const r = range();
      return {
        nodes: [...els.editor.childNodes].map(n => n.cloneNode(true)),
        start: r && where(r.startContainer, r.startOffset),
        end: r && where(r.endContainer, r.endOffset),
      };
    }

    function where(node, offset) {
      const kids = [...els.editor.childNodes];
      if (node === els.editor) {
        const k = Math.min(offset, kids.length - 1);
        return k < 0 ? null : { b: k, o: k < offset ? kids[k].textContent.length : 0 };
      }
      const blk = blockOf(node);
      if (!blk) return null;
      const pre = document.createRange();
      pre.selectNodeContents(blk);
      pre.setEnd(node, offset);
      return { b: kids.indexOf(blk), o: pre.toString().length };
    }

    function pointAt(p) {
      const blk = p && els.editor.childNodes[p.b];
      if (!blk) return null;
      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      let left = p.o;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (left <= n.data.length) return [n, left];
        left -= n.data.length;
      }
      return [blk, 0];
    }

    function undoPaste() {
      const rest = pasteUndo.slice(0, -1);
      const snap = pasteUndo[pasteUndo.length - 1];
      els.editor.replaceChildren(...snap.nodes);
      const a = pointAt(snap.start);
      const z = pointAt(snap.end);
      if (a && z) {
        const back = document.createRange();
        back.setStart(...a);
        back.setEnd(...z);
        select(back);
      }
      changed();
      pasteUndo = rest;
      revealCaret();
    }

    // Scrolls the editor, if it has to, to show the caret.
    function revealCaret() {
      const r = range();
      if (!r) return;
      let at = r.getBoundingClientRect();
      if (!at.height) {
        const blk = blockOf(r.startContainer);
        if (blk) at = blk.getBoundingClientRect();
      }
      const box = els.editor.getBoundingClientRect();
      if (at.bottom > box.bottom - 8) els.editor.scrollTop += at.bottom - box.bottom + 24;
      else if (at.top < box.top + 8) els.editor.scrollTop -= box.top - at.top + 24;
    }

    els.editor.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        window.open(a.href, '_blank', 'noopener');
        return;
      }
      // The box is drawn in the block's left padding, at its indent.
      const blk = e.target.closest && e.target.closest('.blk[data-type="check"]');
      if (blk && editable) {
        const x = e.clientX - blk.getBoundingClientRect().left;
        const at = (Number(blk.dataset.level) || 0) * INDENT_PX;
        if (x >= at && x < at + 26) toggleCheck(blk);
      }
    });

    const onSelection = () => {
      const r = range();
      if (!r) return;
      saved = r.cloneRange();
      refreshToolbar();
    };
    document.addEventListener('selectionchange', onSelection);

    // ── Search highlights ────────────────────────────────────────────────
    //
    // Painted with the CSS Custom Highlight API: ranges over the text,
    // coloured by the stylesheet, with nothing added to the markup - so a
    // highlight can never end up saved into the note.

    let matchRanges = [];
    const canHighlight = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

    // The editor's text with a line break between blocks, and where each
    // text node sits in it.
    function textIndex() {
      const parts = [];
      let text = '';
      els.editor.childNodes.forEach((blk, b) => {
        if (b) text += '\n';
        const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          parts.push({ node: n, start: text.length, end: text.length + n.data.length });
          text += n.data;
        }
      });
      return { text, parts };
    }

    function rangeFor(idx, start, end) {
      const a = idx.parts.find(p => start >= p.start && start < p.end);
      const b = idx.parts.find(p => end > p.start && end <= p.end);
      if (!a || !b) return null;
      const r = document.createRange();
      r.setStart(a.node, start - a.start);
      r.setEnd(b.node, end - b.start);
      return r;
    }

    function highlight(terms) {
      clearHighlights();
      if (!terms || !terms.length || !canHighlight()) return 0;
      const idx = textIndex();
      matchRanges = ns.searchLogic.findMatches(idx.text, terms).map(m => rangeFor(idx, m.start, m.end)).filter(Boolean);
      if (matchRanges.length) CSS.highlights.set('gkb-match', new Highlight(...matchRanges));
      return matchRanges.length;
    }

    // Marks one match as the current one and scrolls it into the middle
    // third of the editor if it is out of view.
    function showMatch(i) {
      const r = matchRanges[i];
      if (!r || !canHighlight()) return;
      CSS.highlights.set('gkb-match-current', new Highlight(r));
      const box = els.editor.getBoundingClientRect();
      const at = r.getBoundingClientRect();
      if (at.top < box.top + 24 || at.bottom > box.bottom - 24) {
        els.editor.scrollTop += at.top - box.top - box.height / 3;
      }
    }

    function clearHighlights() {
      matchRanges = [];
      if (!canHighlight()) return;
      CSS.highlights.delete('gkb-match');
      CSS.highlights.delete('gkb-match-current');
    }

    // ── Contents ─────────────────────────────────────────────────────────
    //
    // The note's headings, beside it, when the host has room and the
    // toolbar's button has them shown: each one goes to its heading, and
    // the one whose part is being read is marked as the text scrolls.
    // Drawn again a moment after the text changes, and only if the
    // headings did. Off, it costs nothing.

    let contentsShown = !!(contents && contents.shown);
    let outlineSig = null;
    let outlineTimer = 0;
    let outlineFrame = 0;
    els.outline = contents ? h('nav', {
      class: 'ne-outline', 'aria-label': 'Contents', hidden: !contentsShown, dataset: { key: 'note-contents' },
    }) : null;
    if (buttons.contents) buttons.contents.setAttribute('aria-pressed', String(contentsShown));

    // The headings with words in them, in order.
    const headings = () => [...els.editor.children].filter(el => HEADINGS.has(el.dataset.type) && el.textContent.trim());

    function drawOutline() {
      clearTimeout(outlineTimer);
      if (!els.outline || !contentsShown) return;
      const list = headings();
      const sig = list.map(el => `${el.dataset.type} ${el.textContent}`).join('\n');
      if (sig !== outlineSig) {
        outlineSig = sig;
        // The highest level there is sits at the left, so a note that
        // starts at Heading 2 is not indented for nothing.
        const top = Math.min(3, ...list.map(el => Number(el.dataset.type[1])));
        els.outline.replaceChildren(
          h('div', { class: 'ol-head', text: 'Contents' }),
          list.length ? h('div', { class: 'ol-list' }, list.map((el, i) => h('button', {
            class: 'ol-item', type: 'button', text: el.textContent.trim(), title: el.textContent.trim(),
            dataset: { key: `contents:${i}`, depth: String(Number(el.dataset.type[1]) - top) },
            onclick: () => goToHeading(i),
          }))) : h('p', {
            class: 'ol-empty',
            text: 'No headings yet. Make a line a heading with the text style menu, or start it with # and a space.',
          }));
      }
      markReading();
    }

    function scheduleOutline() {
      if (!els.outline || !contentsShown) return;
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(drawOutline, 250);
    }

    // The heading of the part at the top of the text: the last one above
    // it, or at the very end, the last of all.
    function markReading() {
      if (!els.outline || !contentsShown) return;
      const list = headings();
      const box = els.editor;
      let at = -1;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) at = list.length - 1;
      else {
        const line = box.scrollTop + 24;
        for (let i = 0; i < list.length && list[i].offsetTop <= line; i++) at = i;
      }
      els.outline.querySelectorAll('.ol-item').forEach((b, i) => {
        if (i === at) b.setAttribute('aria-current', 'location');
        else b.removeAttribute('aria-current');
      });
    }

    els.editor.addEventListener('scroll', () => {
      if (!contentsShown || outlineFrame) return;
      outlineFrame = requestAnimationFrame(() => { outlineFrame = 0; markReading(); });
    }, { passive: true });

    // To a heading: at the top of the text, with the cursor at its start.
    function goToHeading(i) {
      const el = headings()[i];
      if (!el) return;
      if (editable) {
        els.editor.focus({ preventScroll: true });
        placeCaret(el, 0);
      }
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      els.editor.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: still ? 'auto' : 'smooth' });
    }

    function setContentsShown(on) {
      if (!els.outline) return;
      contentsShown = !!on;
      els.outline.hidden = !contentsShown;
      buttons.contents.setAttribute('aria-pressed', String(contentsShown));
      outlineSig = null;
      if (contentsShown) drawOutline();
      else {
        clearTimeout(outlineTimer);
        els.outline.replaceChildren();
      }
    }

    function toggleContents() {
      setContentsShown(!contentsShown);
      if (contents.onToggle) contents.onToggle(contentsShown);
    }

    // ── API ──────────────────────────────────────────────────────────────

    function setDoc(doc) {
      pasteUndo = [];
      lastCell = null;
      els.editor.replaceChildren(...fmt.normaliseDoc(doc).map(blockEl));
      for (const td of els.editor.querySelectorAll('td')) td.contentEditable = editable ? 'true' : 'false';
      updateEmpty();
      drawOutline();
    }

    // New text under someone who may be typing - a newer version merged
    // in: the same text box, so the focus and a phone's keyboard stay,
    // and the cursor goes to where its block went (`map`, old block
    // index → new), as far along it as it was.
    function replaceDoc(doc, map) {
      const focused = root.activeElement === els.editor || els.editor.contains(root.activeElement);
      const r = focused ? range() : null;
      const at = r && [where(r.startContainer, r.startOffset), where(r.endContainer, r.endOffset)];
      setDoc(doc);
      if (!at || !at[0] || !at[1]) return;
      const kids = els.editor.childNodes;
      const moved = p => {
        const b = Math.max(0, Math.min(kids.length - 1, map && map[p.b] !== undefined ? map[p.b] : p.b));
        return { b, o: Math.min(p.o, kids[b] ? kids[b].textContent.length : 0) };
      };
      const a = pointAt(moved(at[0]));
      const z = pointAt(moved(at[1]));
      if (!a || !z) return;
      try {
        // In a table, the new cell takes the focus the old one had.
        const host = cellOf(a[0]) || els.editor;
        if (root.activeElement !== host) host.focus({ preventScroll: true });
        const back = document.createRange();
        back.setStart(...a);
        back.setEnd(...z);
        select(back);
      } catch { /* the cursor stays where the browser put it */ }
    }

    function setEditable(on, placeholder) {
      editable = !!on;
      els.editor.contentEditable = editable ? 'true' : 'false';
      els.editor.dataset.placeholder = placeholder || 'Write here…';
      els.editor.setAttribute('aria-disabled', String(!editable));
      for (const b of [...els.toolbar.querySelectorAll('button')]) b.disabled = !editable;
      // The contents only go somewhere in the text: they work regardless.
      if (buttons.contents) buttons.contents.disabled = false;
      for (const td of els.editor.querySelectorAll('td')) td.contentEditable = editable ? 'true' : 'false';
      if (!editable) els.tablebar.hidden = true;
    }

    function focus() {
      els.editor.focus();
      const first = els.editor.firstChild;
      if (first) placeCaret(first, 0);
    }

    function destroy() {
      clearTimeout(outlineTimer);
      cancelAnimationFrame(outlineFrame);
      document.removeEventListener('selectionchange', onSelection);
      clearHighlights();
      closeMenu(root);
    }

    return {
      element: els.editor,
      toolbar: els.toolbar,
      linkbar: els.linkbar,
      tablebar: els.tablebar,
      outline: els.outline,
      setContentsShown,
      setDoc,
      replaceDoc,
      getDoc: () => readDoc(els.editor),
      setEditable,
      focus,
      destroy,
      highlight,
      showMatch,
      clearHighlights,
      matchCount: () => matchRanges.length,
    };
  }

  ns.noteEditor = { create, readDoc };
})();

// ─────────────────────────────────────────────────────────────────────
// The formatted note editor
//
// An editable area with a toolbar: text style (normal, three headings),
// bold, italic, strike-through, bulleted, numbered and check lists with
// three levels of nesting, tables, boards, links, and clear formatting.
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
//
// A board is an island too: columns side by side, each a title over a
// list of cards, every title and card edited on its own like a cell.
// Enter adds the next card, Alt and the arrow keys move one (up, down,
// to the next column), a card's handle drags it anywhere on the board or
// opens its menu, and the board bar - shown while the cursor is in it -
// adds, moves and deletes cards and columns. It is saved as a table of
// one row, so Gmail shows it as columns of cards. A card shows its first
// line - its front - and under it how many more lines it holds, until the
// cursor goes into it: then the whole card is there to read and edit.
// Only the view folds; every line is saved.
//
// A picture is an island too: picked with the toolbar's button, pasted
// or dropped, it goes in between lines, made smaller and held in the
// page (src/content/pictures.js) until the note saves it. A click
// selects it: a handle on its corner drags it to any width, and buttons
// on it set a quarter, half, three quarters or all of the note's width,
// or delete it. Its width is a share of the note's, so it looks the same
// on a phone. Pictures already saved are read as they come into view.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, toast, openMenu, closeMenu } = ns.ui;
  const fmt = ns.noteFormat;
  const NEW_TABLE = { cols: 3, rows: 3 };
  const NEW_BOARD = ['To do', 'Doing', 'Done'];

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

  // A link's tooltip: where it goes, and that a click goes there.
  const linkTitle = href => `${href.replace(/^mailto:/, '')}\nClick to open it in a new tab`;

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
      if (href) out.push(h('a', { href, title: linkTitle(href) }, group));
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

  // A picture: a frame its width is set on, holding the picture once it
  // is read (watchPictures). The handle and the buttons are added while
  // it is selected, and are never part of what is saved or copied.
  function pictureEl(b) {
    const el = document.createElement('div');
    el.className = 'blk';
    el.dataset.type = 'picture';
    el.dataset.src = b.src;
    el.dataset.width = String(b.width || 0);
    el.contentEditable = 'false';
    const img = document.createElement('img');
    img.alt = 'Picture';
    img.draggable = false;
    const frame = document.createElement('div');
    frame.className = 'pic-frame';
    frame.appendChild(img);
    sizeFrame(frame, b.width);
    el.appendChild(frame);
    return el;
  }

  // Through the style API: a page's security policy may refuse a style
  // attribute, never this.
  function sizeFrame(frame, width) {
    if (width) frame.style.setProperty('width', `${width}%`);
    else frame.style.removeProperty('width');
  }

  // A board: a row of columns, each a title above its cards, a button
  // under them to add one, and one at the end to add a column. Each title
  // and each card's text is edited on its own, as a table's cells are.
  // The buttons and the cards' handles (kb-ui) hold no words of the note:
  // reading it back, copying it and searching it pass them by.
  function cardEl(runs) {
    const text = document.createElement('div');
    text.className = 'kb-text';
    text.dataset.gkbCard = '1';
    text.contentEditable = 'true';
    fillCell(text, runs);
    const card = h('div', { class: 'kb-card' }, text, h('button', {
      class: 'kb-grip kb-ui', type: 'button', tabindex: '-1', title: 'Drag to move the card, or click for its menu',
      'aria-label': 'Move or delete the card', 'aria-haspopup': 'menu', dataset: { key: 'board-grip' },
    }, icon('drag', 18)));
    // Folded from the first time it is drawn, to its first line: one
    // that wraps is measured once it is on the page (foldCards).
    markBack(card, backLines((runs || []).map(r => r.text).join('')));
    return card;
  }

  // How many lines with words a card has after its first: its back.
  function backLines(text) {
    const lines = text.split('\n');
    const first = lines.findIndex(l => l.trim());
    return first < 0 ? 0 : lines.slice(first + 1).filter(l => l.trim()).length;
  }

  // A card with a back folds (kb-folds, in the stylesheet) and says under
  // its front how many more lines there are (data-more); one without does
  // neither. Nothing is written that is so already: a board has thousands.
  function markBack(card, more) {
    if (card.classList.contains('kb-folds') !== !!more) card.classList.toggle('kb-folds', !!more);
    const label = more ? `${more} more ${more === 1 ? 'line' : 'lines'}` : '';
    if ((card.dataset.more || '') === label) return;
    if (label) card.dataset.more = label;
    else delete card.dataset.more;
  }

  function columnEl(c) {
    const title = document.createElement('div');
    title.className = 'kb-title';
    title.dataset.gkbTitle = '1';
    title.dataset.placeholder = 'Column name';
    title.contentEditable = 'true';
    title.replaceChildren(...inlineNodes(c.title || []));
    return h('div', { class: 'kb-col', dataset: { gkbColumn: '1' } },
      title,
      h('div', { class: 'kb-list' }, (c.cards || []).map(k => cardEl(k.runs))),
      h('button', { class: 'kb-add kb-ui', type: 'button', tabindex: '-1', dataset: { key: 'board-add-card', kb: 'add-card' } },
        icon('add', 18), 'Add a card'));
  }

  function boardEl(b) {
    const el = document.createElement('div');
    el.className = 'blk';
    el.dataset.type = 'board';
    el.contentEditable = 'false';
    el.appendChild(h('div', { class: 'kb-cols' }, b.columns.map(columnEl),
      h('button', {
        class: 'kb-add-col kb-ui', type: 'button', tabindex: '-1', title: 'Add a column', 'aria-label': 'Add a column',
        dataset: { key: 'board-add-column', kb: 'add-column' },
      }, icon('add', 20))));
    return el;
  }

  const isIslandEl = el => !!el && el.nodeType === 1 && (el.dataset.type === 'table' || el.dataset.type === 'board' || el.dataset.type === 'picture');

  function blockEl(b) {
    if (b.type === 'table') return tableEl(b);
    if (b.type === 'board') return boardEl(b);
    if (b.type === 'picture') return pictureEl(b);
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

  function readBoard(el) {
    return fmt.board([...el.querySelectorAll('[data-gkb-column]')].map(col => {
      const title = col.querySelector('[data-gkb-title]');
      return {
        title: title ? readCell(title).map(r => ({ ...r, text: r.text.replace(/\n/g, ' ') })) : [],
        cards: [...col.querySelectorAll('[data-gkb-card]')].map(t => ({ runs: readCell(t) })),
      };
    }));
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
      else if (node.nodeType === 1 && node.dataset.type === 'board') blocks.push(readBoard(node));
      else if (node.nodeType === 1 && node.dataset.type === 'picture') blocks.push(fmt.picture(node.dataset.src, Number(node.dataset.width) || 0));
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
  // `onPicture(src, { trashed })`: a picture has been read, to show.
  function create({ root, onChange, contents = null, onPicture = null }) {
    const els = {};
    let saved = null;     // the last selection inside the editor
    let editable = false;
    let plainNext = false; // Ctrl+Shift+V: the next paste is text alone
    let pasteUndo = [];    // how the text was before each formatted paste, latest last
    let selPic = null;     // the picture selected, if one is

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
      // In a table or a board, the cell or the card is what takes typing.
      const host = (keep && hostOf(keep.startContainer)) || els.editor;
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

    // Out of a table or a picture, above or below it: to the block there,
    // or a new empty line if there is none (or only another island).
    function leaveTable(el, below) {
      let target = below ? el.nextElementSibling : el.previousElementSibling;
      if (!target || isIslandEl(target)) {
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
        else if (a.title !== linkTitle(href)) a.title = linkTitle(href);
      }
      if (!els.editor.children.length) {
        els.editor.appendChild(blockEl(fmt.block('p')));
        placeCaret(els.editor.firstChild, 0);
        moved = false;
      }
      // Somewhere to type after a table or a picture at the end.
      if (isIslandEl(els.editor.lastElementChild)) els.editor.appendChild(blockEl(fmt.block('p')));
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
      watchPictures();
      watchCards();
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
      if (!r || hostOf(r.startContainer)) return; // a cell or a card holds text, not lists or headings
      // A table, a board or a picture the selection runs over stays what it is.
      const blocks = rangeBlocks(r).filter(b => !isIslandEl(b));
      if (!blocks.length) return;
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
      if (!r || hostOf(r.startContainer)) return false;
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
      if (r && !hostOf(r.startContainer)) for (const b of rangeBlocks(r)) if (!isIslandEl(b)) setBlock(b, 'p');
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
        a.title = linkTitle(href);
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

    // The table (or the board) gone: the cursor to the line after it.
    function removeTable(el) {
      let next = el.nextElementSibling;
      if (!next || isIslandEl(next)) {
        next = blockEl(fmt.block('p'));
        el.after(next);
      }
      el.remove();
      lastCell = null;
      lastText = null;
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

    // A new table or board where the cursor is: in place of an empty line,
    // or after the line it is on, with a line after it. Ctrl+Z straight
    // afterwards takes it back.
    function placeIsland(el) {
      if (!editable) return null;
      restore();
      const r = range();
      if (!r || hostOf(r.startContainer)) return null;
      const blk = blockOf(r.startContainer) || els.editor.lastElementChild;
      if (!blk) return null;
      const undo = pasteUndo;
      const before = snapshot();
      if (blk.dataset.type === 'p' && !blk.textContent) blk.replaceWith(el);
      else blk.after(el);
      if (!el.nextElementSibling || isIslandEl(el.nextElementSibling)) el.after(blockEl(fmt.block('p')));
      changed();
      pasteUndo = [...undo.slice(-19), before];
      return el;
    }

    // Three columns, a heading row and two more.
    function insertTable() {
      const rows = Array.from({ length: NEW_TABLE.rows }, () => Array.from({ length: NEW_TABLE.cols }, () => ({ runs: [] })));
      const el = placeIsland(tableEl(fmt.table(rows, { head: true, align: Array(NEW_TABLE.cols).fill('') })));
      if (el) focusCell(el.querySelector('td'));
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

    // Keys on a line beside a table, a board or a picture: the arrows into
    // it - into a table's cells or a board's cards, onto a picture,
    // selecting it - and Backspace or Delete into it rather than through
    // it. (A selected picture's own keys are in pictureKey.)
    function besideTable(e, r, blk, mod) {
      if (mod || e.altKey || e.shiftKey || !r.collapsed) return false;
      const prev = blk.previousElementSibling;
      const next = blk.nextElementSibling;
      const into = (el, last) => {
        e.preventDefault();
        if (el.dataset.type === 'picture') {
          selectPicture(el);
          return true;
        }
        if (el.dataset.type === 'board') {
          // From below, the foot of its first column.
          const first = el.querySelector('[data-gkb-column]');
          const texts = first ? first.querySelectorAll('[data-gkb-title], [data-gkb-card]') : [];
          focusText(last ? texts[texts.length - 1] : texts[0], last);
          return true;
        }
        const cells = el.querySelectorAll('td');
        focusCell(last ? cells[cells.length - 1] : cells[0], last);
        return true;
      };
      if (isIslandEl(next)) {
        if ((e.key === 'ArrowDown' && onEdgeLine(blk, r, true)) || (e.key === 'ArrowRight' && caretAtEnd(r, blk))) return into(next, false);
        if (e.key === 'Delete' && caretAtEnd(r, blk)) {
          if (!blk.textContent && blk.previousElementSibling) { blk.remove(); changed(); }
          return into(next, false);
        }
      }
      if (isIslandEl(prev)) {
        if (e.key === 'ArrowUp' && onEdgeLine(blk, r, false)) {
          if (prev.dataset.type !== 'table') return into(prev, true);
          // Up into the last row, at its start.
          e.preventDefault();
          const rows = prev.querySelector('table').rows;
          focusCell(rows[rows.length - 1].cells[0], true);
          return true;
        }
        if (e.key === 'ArrowLeft' && caretAtBlockStart(r, blk)) return into(prev, true);
        // An empty line after a table or a picture goes (unless it is the
        // last); a line with text keeps it, and the cursor goes into the
        // table, or the picture is selected.
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

    // ── Boards ───────────────────────────────────────────────────────────
    //
    // Like a table, an island whose titles and cards are each edited on
    // their own. Enter adds a card below (on an empty card it ends the
    // column, as on an empty list item, and the cursor goes below the
    // board); Shift+Enter is a new line in a card; Tab goes title to card
    // to card, column by column; the arrows leave a card at its edges.
    // Alt+arrow keys move a card - up and down, or into the next column -
    // and, in a title, the column. The board bar, a card's handle and the
    // buttons under each column do the rest. Each change to a board's
    // shape, Ctrl+Z straight afterwards takes back.

    // The title or card a node is in, if it is in one.
    function boardTextOf(node) {
      for (let n = node; n && n !== els.editor; n = n.parentNode) {
        if (n.nodeType === 1 && (n.dataset.gkbCard !== undefined || n.dataset.gkbTitle !== undefined)) return n;
      }
      return null;
    }
    // What takes the typing: a table's cell, or a board's title or card.
    function hostOf(node) {
      return cellOf(node) || boardTextOf(node);
    }
    const boardElOf = n => n.closest('.blk[data-type="board"]');
    const isTitle = t => t.dataset.gkbTitle !== undefined;
    const columnOfText = t => t.closest('[data-gkb-column]');
    const columnsOf = el => [...el.querySelectorAll('[data-gkb-column]')];
    // Every title and card, column by column: the order Tab goes in.
    const textsOf = el => [...el.querySelectorAll('[data-gkb-title], [data-gkb-card]')];
    const columnName = (col, k) => col.querySelector('[data-gkb-title]').textContent.trim() || `Column ${k + 1}`;
    let lastText = null; // the title or card last typed in, for the board bar's menus

    function focusText(t, atEnd = false) {
      if (!t) return;
      t.focus({ preventScroll: true });
      caretInto(t, atEnd);
      lastText = t;
      (isTitle(t) ? t : t.closest('.kb-card')).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // The title or card being worked on: the one with the cursor, or -
    // while one of the board bar's menus has the focus - the one it was in.
    function boardNow() {
      const r = range();
      const t = r && boardTextOf(r.startContainer);
      if (t) return t;
      return lastText && lastText.isConnected && els.editor.contains(lastText) ? lastText : null;
    }

    // Where the cursor is in a title or card, in characters, and back.
    function textOffset(t) {
      const r = range();
      if (!r || !t.contains(r.startContainer)) return null;
      const pre = document.createRange();
      pre.selectNodeContents(t);
      pre.setEnd(r.startContainer, r.startOffset);
      return pre.toString().length;
    }
    function caretAt(t, offset) {
      const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      let left = offset;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (left <= n.data.length) { placeCaret(n, left); return; }
        left -= n.data.length;
      }
      caretInto(t, true);
    }

    // A change to a board, about the title or card `t`: `fn` gets it and
    // its board and returns where the cursor goes next - [title or card,
    // at its end], or `t` itself to stay where it was in it (a card moved
    // goes on being typed in), or nothing.
    function boardEdit(t, fn) {
      if (!editable || !t || !t.isConnected) return;
      const undo = pasteUndo;
      const before = snapshot();
      const keep = textOffset(t);
      const next = fn(t, boardElOf(t));
      changed();
      pasteUndo = [...undo.slice(-19), before];
      if (next === t && t.isConnected) {
        t.focus({ preventScroll: true });
        if (keep === null) caretInto(t, true); else caretAt(t, keep);
        lastText = t;
        (isTitle(t) ? t : t.closest('.kb-card')).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else if (next) {
        focusText(next[0], next[1]);
      }
      refreshToolbar();
    }

    // A new card below or above a card - from a title, at the top of its
    // column - or (`foot`) at the foot of the column.
    function addCard(t, where) {
      boardEdit(t, x => {
        const list = columnOfText(x).querySelector('.kb-list');
        if (list.children.length >= fmt.MAX_CARDS) return x;
        const card = cardEl([]);
        if (where === 'foot') list.append(card);
        else if (isTitle(x)) list.prepend(card);
        else if (where === 'below') x.closest('.kb-card').after(card);
        else x.closest('.kb-card').before(card);
        return [card.firstChild, false];
      });
    }

    // A card up or down its column, or into the column beside it at the
    // same height; or, given a column's place, to the top of that column.
    // A move there is no room for is nothing, not a step for Ctrl+Z.
    function moveCard(t, dir) {
      const card = t.closest('.kb-card');
      if (dir === 'up' || dir === 'down') {
        const other = dir === 'up' ? card.previousElementSibling : card.nextElementSibling;
        if (other) boardEdit(t, x => { if (dir === 'up') other.before(card); else other.after(card); return x; });
        return;
      }
      const cols = columnsOf(boardElOf(t));
      const from = columnOfText(t);
      const to = cols[typeof dir === 'number' ? dir : cols.indexOf(from) + (dir === 'left' ? -1 : 1)];
      const list = to && to !== from && to.querySelector('.kb-list');
      if (!list || list.children.length >= fmt.MAX_CARDS) return;
      const at = typeof dir === 'number' ? 0 : [...card.parentNode.children].indexOf(card);
      boardEdit(t, x => { list.insertBefore(card, list.children[at] || null); return x; });
    }

    // The card gone, the cursor to the end of the one above it (or of the
    // column's title).
    function deleteCard(t) {
      boardEdit(t, (x, el) => {
        const all = textsOf(el);
        x.closest('.kb-card').remove();
        return [all[all.indexOf(x) - 1], true];
      });
    }

    // A new column, its title to be typed: left or right of this one, or
    // at the end.
    function addBoardColumn(t, where) {
      boardEdit(t, (x, el) => {
        if (columnsOf(el).length >= fmt.MAX_BOARD_COLS) return x;
        const col = columnEl({ title: [], cards: [] });
        const at = columnOfText(x);
        if (where === 'end') el.querySelector('.kb-add-col').before(col);
        else if (where === 'right') at.after(col);
        else at.before(col);
        return [col.querySelector('[data-gkb-title]'), false];
      });
    }

    function moveBoardColumn(t, delta) {
      const col = columnOfText(t);
      const other = delta < 0 ? col.previousElementSibling : col.nextElementSibling;
      if (!other || !other.matches('[data-gkb-column]')) return;
      boardEdit(t, x => { if (delta < 0) other.before(col); else other.after(col); return x; });
    }

    // A column gone with its cards, the cursor to the title of the one
    // that takes its place; the last one gone, the board goes.
    function deleteBoardColumn(t) {
      boardEdit(t, (x, el) => {
        const cols = columnsOf(el);
        if (cols.length === 1) return removeTable(el);
        const k = cols.indexOf(columnOfText(x));
        cols[k].remove();
        return [(cols[k + 1] || cols[k - 1]).querySelector('[data-gkb-title]'), true];
      });
    }

    function deleteBoard(t) {
      boardEdit(t, (x, el) => removeTable(el));
    }

    // To do, Doing and Done, the cursor in an empty card in To do.
    function insertBoard() {
      const el = placeIsland(boardEl(fmt.board(NEW_BOARD.map((title, k) => ({ title: [{ text: title }], cards: k ? [] : [{ runs: [] }] })))));
      if (el) focusText(el.querySelector('[data-gkb-card]'));
    }

    function cardItems(t) {
      const card = t.closest('.kb-card');
      const col = columnOfText(t);
      return [
        { label: 'Insert card above', key: 'card-above', onSelect: () => addCard(t, 'above') },
        { label: 'Insert card below', key: 'card-below', onSelect: () => addCard(t, 'below') },
        { separator: true },
        { label: 'Move up', icon: 'up', key: 'card-up', disabled: !card.previousElementSibling, onSelect: () => moveCard(t, 'up') },
        { label: 'Move down', icon: 'down', key: 'card-down', disabled: !card.nextElementSibling, onSelect: () => moveCard(t, 'down') },
        { separator: true },
        { heading: 'Move to' },
        ...columnsOf(boardElOf(t)).map((c, k) => ({
          label: columnName(c, k), checked: c === col, disabled: c === col, key: `card-to:${k}`, onSelect: () => moveCard(t, k),
        })),
        { separator: true },
        { label: 'Delete card', key: 'card-delete', danger: true, onSelect: () => deleteCard(t) },
      ];
    }

    function columnItems(t) {
      const cols = columnsOf(boardElOf(t));
      const k = cols.indexOf(columnOfText(t));
      const full = cols.length >= fmt.MAX_BOARD_COLS;
      return [
        { label: 'Insert column left', key: 'board-col-left', disabled: full, onSelect: () => addBoardColumn(t, 'left') },
        { label: 'Insert column right', key: 'board-col-right', disabled: full, onSelect: () => addBoardColumn(t, 'right') },
        { separator: true },
        { label: 'Move column left', icon: 'prev', key: 'board-col-move-left', disabled: k <= 0, onSelect: () => moveBoardColumn(t, -1) },
        { label: 'Move column right', icon: 'next', key: 'board-col-move-right', disabled: k >= cols.length - 1, onSelect: () => moveBoardColumn(t, 1) },
        { separator: true },
        { label: 'Delete column', key: 'board-col-delete', danger: true, onSelect: () => deleteBoardColumn(t) },
        { label: 'Delete board', key: 'delete-board', danger: true, onSelect: () => deleteBoard(t) },
      ];
    }

    // The buttons on a board: a card's handle (its menu, when it is
    // clicked rather than dragged), Add a card, and Add a column.
    function boardButton(b) {
      if (b.classList.contains('kb-grip')) {
        const t = b.closest('.kb-card').querySelector('[data-gkb-card]');
        lastText = t;
        openMenu(root, b, cardItems(t), { label: 'Card' });
        return;
      }
      const col = b.closest('[data-gkb-column]') || [...b.closest('.kb-cols').querySelectorAll('[data-gkb-column]')].pop();
      if (!col) return;
      if (b.dataset.kb === 'add-card') addCard(col.querySelector('[data-gkb-title]'), 'foot');
      else if (b.dataset.kb === 'add-column') addBoardColumn(col.querySelector('[data-gkb-title]'), 'end');
    }

    // ── Card fronts ──────────────────────────────────────────────────────
    //
    // A card folds to its front - its first line - while the cursor is
    // not in it, so a board of long cards still reads at a glance; the
    // stylesheet does the folding (:focus-within), this only measures how
    // tall the front is, since a long first line wraps. Measured when a
    // card is first seen, when it is left (its text may have changed) and
    // when its column's width changes. A card with a search match shows
    // whole, and nothing folds in a note that cannot be edited, as it could
    // not be opened there.
    //
    // The columns are watched, by their titles, rather than the cards: all
    // columns are as wide as each other, a title keeps its size when the
    // cards under it fold - so they can fold before the page is drawn,
    // where a card watched would report its own folding back as a loop, an
    // error on the page - and a board has 20 titles, not 20,000 cards.

    const seen = new WeakSet(); // cards measured, or put off until their column shows
    const widths = new WeakMap(); // each title watched, and its width
    // One range, moved from card to card: the browser keeps every range up
    // to date through every change to the page until it is collected, so a
    // range for each card made every edit on a big board slower by as many.
    const frontRange = document.createRange();
    const sizer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      const cards = [];
      for (const en of entries) {
        const title = en.target;
        if (!title.isConnected) {
          // A column deleted is let go of, and watched again if Undo brings it back.
          sizer.unobserve(title);
          widths.delete(title);
          continue;
        }
        const w = title.getBoundingClientRect().width;
        if (!w || w === widths.get(title)) continue;
        widths.set(title, w);
        const col = title.closest('[data-gkb-column]');
        if (col) cards.push(...col.querySelectorAll('[data-gkb-card]'));
      }
      foldSoon(cards);
    }) : null;
    const later = new Set(); // cards a screen or more away, measured once the page is drawn
    let laterTimer = 0;

    // A card's front: from its start to the first line break with words
    // before it - a <br>, a block the browser put in, or a line break typed
    // into the text itself (pre-wrap, see readCell) - set on frontRange if
    // words come after it too. False: the card is all front.
    function setFront(t) {
      const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let words = false;
      let set = false;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 1) {
          if (!set && words && (n.tagName === 'BR' || NESTED_BLOCKS.has(n.tagName.toLowerCase()))) {
            frontRange.setStart(t, 0);
            frontRange.setEndBefore(n);
            set = true;
          }
          continue;
        }
        if (set) {
          if (/\S/.test(n.data)) return true;
          continue;
        }
        const from = words ? 0 : n.data.search(/\S/);
        if (from < 0) continue;
        words = true;
        const end = n.data.indexOf('\n', from);
        if (end < 0) continue;
        frontRange.setStart(t, 0);
        frontRange.setEnd(n, end);
        set = true;
        if (/\S/.test(n.data.slice(end))) return true;
      }
      return false;
    }

    // Cards measured, then folded: every measurement first, then every
    // change, so a board of a thousand cards is laid out once, not once
    // a card. A front of one line needs nothing written (the stylesheet's
    // own height); one that wraps gets its rows, on the text.
    function foldCards(ts) {
      const found = [];
      let lh = 0; // a line, and the border and padding above the words: the same for every card
      let inset = 0;
      for (const t of ts) {
        const card = t.closest('.kb-card');
        const box = t.getBoundingClientRect();
        if (!card || !box.width) continue; // not on show: measured once it is
        const more = backLines(readCell(t).map(x => x.text).join(''));
        let rows = 1;
        if (more && setFront(t)) {
          // Down to the line the front's last words are on, by the middle
          // of their box: it is shorter than their line, and a blank line
          // above them has no box at all.
          if (!lh) {
            const cs = getComputedStyle(t);
            lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
            inset = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
          }
          const top = box.top + inset - t.scrollTop;
          let last = -Infinity;
          for (const q of frontRange.getClientRects()) if (q.width) last = Math.max(last, q.top + q.height / 2);
          if (last > top) rows = Math.floor((last - top) / lh) + 1;
        }
        found.push({ t, card, more, rows, scrolled: t.scrollTop > 0 });
      }
      for (const { t, card, more, rows, scrolled } of found) {
        markBack(card, more);
        const r = rows > 1 ? String(rows) : '';
        if (t.style.getPropertyValue('--kb-rows') !== r) {
          if (r) t.style.setProperty('--kb-rows', r);
          else t.style.removeProperty('--kb-rows');
        }
        if (scrolled) t.scrollTop = 0;
      }
    }

    // Cards measured: those on screen, or within a screen of it, at once -
    // before the page is drawn - and the rest just after it is, all
    // together: a big board then shows at once, and is laid out again only
    // once more (in batches, every batch moved the cards below it, and the
    // whole board was laid out and drawn again each time). One a long way
    // off folds to one row until then, unseen.
    function foldSoon(ts) {
      const vh = innerHeight;
      const vw = innerWidth;
      const now = [];
      for (const t of ts) {
        const b = t.getBoundingClientRect();
        if (b.bottom > -vh && b.top < 2 * vh && b.right > -vw && b.left < 2 * vw) now.push(t);
        else later.add(t);
      }
      foldCards(now);
      if (later.size && !laterTimer) laterTimer = setTimeout(foldLater);
    }

    function foldLater() {
      laterTimer = 0;
      const ts = [...later];
      later.clear();
      foldCards(ts);
    }

    // A new note, or the editor gone: nothing left over to measure.
    function stopLater() {
      clearTimeout(laterTimer);
      laterTimer = 0;
      later.clear();
    }

    // Cards not seen yet, measured now; a column not watched yet, watched
    // from its width now. A note not on the page yet (opening it) has no
    // width: its cards are measured as each column shows.
    function watchCards() {
      if (sizer) {
        for (const title of els.editor.querySelectorAll('[data-gkb-title]')) {
          if (widths.has(title)) continue;
          widths.set(title, title.getBoundingClientRect().width);
          sizer.observe(title);
        }
      }
      const fresh = [...els.editor.querySelectorAll('[data-gkb-card]')].filter(t => !seen.has(t));
      for (const t of fresh) seen.add(t);
      if (fresh.length) foldSoon(fresh);
    }

    // Keys in a title or a card.
    function boardKey(e, t, r, mod) {
      const el = boardElOf(t);
      const all = textsOf(el);
      const i = all.indexOf(t);
      const title = isTitle(t);
      const go = (x, atEnd) => { e.preventDefault(); focusText(x, atEnd); return true; };
      const out = below => { e.preventDefault(); leaveTable(el, below); return true; };
      const arrow = /^Arrow(Up|Down|Left|Right)$/.test(e.key);
      if (arrow && e.altKey && !mod && !e.shiftKey) {
        // Not the browser's Back and Forward, which are Alt+Left and Right.
        e.preventDefault();
        const dir = e.key.slice(5).toLowerCase();
        if (!title) moveCard(t, dir);
        else if (dir === 'left' || dir === 'right') moveBoardColumn(t, dir === 'left' ? -1 : 1);
        return true;
      }
      if (e.key === 'Tab' && !mod && !e.altKey) {
        if (e.shiftKey) return i > 0 ? go(all[i - 1], true) : out(false);
        return i < all.length - 1 ? go(all[i + 1], true) : out(true);
      }
      if (e.key === 'Enter' && !mod && !e.altKey && !e.isComposing) {
        e.preventDefault();
        if (title) {
          const first = columnOfText(t).querySelector('[data-gkb-card]');
          if (first) focusText(first, false);
          else addCard(t, 'below');
        } else if (e.shiftKey) {
          document.execCommand('insertLineBreak');
        } else if (!t.textContent) {
          boardEdit(t, (x, b) => {
            x.closest('.kb-card').remove();
            leaveTable(b, true);
          });
        } else {
          addCard(t, 'below');
        }
        return true;
      }
      // Nothing joins a card to another, or a title to anything; Backspace
      // in an empty card deletes it.
      if (!mod && e.key === 'Backspace' && caretAtBlockStart(r, t)) {
        e.preventDefault();
        if (!title && !t.textContent) deleteCard(t);
        return true;
      }
      if (!mod && e.key === 'Delete' && caretAtEnd(r, t)) {
        e.preventDefault();
        return true;
      }
      if (arrow && !mod && !e.altKey && !e.shiftKey && r.collapsed) {
        const next = all[i + 1];
        if (e.key === 'ArrowUp' && onEdgeLine(t, r, false)) return title ? out(false) : go(all[i - 1], true);
        if (e.key === 'ArrowDown' && onEdgeLine(t, r, true)) return next && !isTitle(next) ? go(next, false) : out(true);
        if (e.key === 'ArrowLeft' && caretAtBlockStart(r, t)) return i > 0 ? go(all[i - 1], true) : out(false);
        if (e.key === 'ArrowRight' && caretAtEnd(r, t)) return next ? go(next, false) : out(true);
      }
      // Lists and headings are not for boards.
      if (mod && e.shiftKey && /^Digit[789]$/.test(e.code)) { e.preventDefault(); return true; }
      return false;
    }

    // A paste into a title or a card: the text alone, its lines as lines
    // in a card and run together in a title.
    function pasteInBoard(doc, text, t) {
      const one = doc ? fmt.docText(doc) : String(text || '');
      const lines = String(one).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
      if (isTitle(t)) {
        document.execCommand('insertText', false, lines.join(' '));
        return;
      }
      lines.forEach((line, i) => {
        if (i) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    }

    // ── Dragging a card by its handle ──
    //
    // The card itself goes where the pointer is - into the column under
    // it (or the nearest), above the first card whose middle is below it -
    // so where it is, is where it lands; near their edges the board scrolls
    // sideways and the note up and down. Let go, it stays, and Ctrl+Z puts
    // it back; Escape or a lost pointer puts it back at once. A press that
    // does not move is a click, which opens the card's menu. Mouse, pen
    // and finger alike: the handle takes no scrolling.
    let drag = null; // { card, el, id, x0, y0, x, y, home, lifted, frame, before, undo, touch }

    function dragStart(e, grip) {
      if (!editable || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const card = grip.closest('.kb-card');
      drag = {
        card, el: boardElOf(card), id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        home: [card.parentNode, card.nextSibling], lifted: false, frame: 0, before: null, undo: null, touch: e.pointerType === 'touch',
      };
      document.addEventListener('pointermove', dragMove, true);
      document.addEventListener('pointerup', dragUp, true);
      document.addEventListener('pointercancel', dragCancel, true);
      document.addEventListener('keydown', dragKey, true);
    }

    function dragMove(e) {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      // The button let go where the page could not see it (outside the
      // window): the drag is over, not carried on by a hovering mouse.
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
        dragUp(e);
        return;
      }
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.lifted) {
        if (Math.abs(d.x - d.x0) + Math.abs(d.y - d.y0) < 6) return;
        // Lifted: from here on it is a drag, not a click.
        d.lifted = true;
        d.undo = pasteUndo;
        d.before = snapshot();
        closeMenu(root);
        d.card.classList.add('kb-dragging');
        d.el.classList.add('kb-dragging-in');
        try { d.el.setPointerCapture(d.id); } catch { /* the pointer went already */ }
      }
      e.preventDefault();
      if (!d.frame) d.frame = requestAnimationFrame(dragStep);
    }

    function dragStep() {
      const d = drag;
      if (!d) return;
      d.frame = 0;
      let col = null;
      let best = Infinity;
      for (const c of columnsOf(d.el)) {
        const r = c.getBoundingClientRect();
        const off = d.x < r.left ? r.left - d.x : d.x > r.right ? d.x - r.right : 0;
        if (off < best) { best = off; col = c; }
      }
      const list = col && col.querySelector('.kb-list');
      if (list && (list === d.card.parentNode || list.children.length < fmt.MAX_CARDS)) {
        let ref = null;
        for (const k of list.children) {
          if (k === d.card) continue;
          const r = k.getBoundingClientRect();
          if (d.y < r.top + r.height / 2) { ref = k; break; }
        }
        if (d.card.parentNode !== list || d.card.nextElementSibling !== ref) list.insertBefore(d.card, ref);
      }
      const speed = (p, lo, hi) => {
        const v = p < lo + 40 ? p - lo - 40 : p > hi - 40 ? p - hi + 40 : 0;
        return Math.max(-24, Math.min(24, Math.round(v / 3)));
      };
      const cols = d.el.querySelector('.kb-cols');
      const cr = cols.getBoundingClientRect();
      const er = els.editor.getBoundingClientRect();
      const was = [cols.scrollLeft, els.editor.scrollTop];
      cols.scrollLeft += speed(d.x, cr.left, cr.right);
      els.editor.scrollTop += speed(d.y, er.top, er.bottom);
      // Still scrolling: again next frame, with the pointer where it is.
      if (cols.scrollLeft !== was[0] || els.editor.scrollTop !== was[1]) d.frame = requestAnimationFrame(dragStep);
    }

    function endDrag() {
      const d = drag;
      drag = null;
      cancelAnimationFrame(d.frame);
      document.removeEventListener('pointermove', dragMove, true);
      document.removeEventListener('pointerup', dragUp, true);
      document.removeEventListener('pointercancel', dragCancel, true);
      document.removeEventListener('keydown', dragKey, true);
      d.card.classList.remove('kb-dragging');
      d.el.classList.remove('kb-dragging-in');
      try { d.el.releasePointerCapture(d.id); } catch { /* not held */ }
      return d;
    }

    function dragUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = endDrag();
      if (!d.lifted) return;
      if (d.card.parentNode !== d.home[0] || d.card.nextSibling !== d.home[1]) {
        changed();
        pasteUndo = [...d.undo.slice(-19), d.before];
      }
      // On a phone, no keyboard popping up for a card only moved.
      if (!d.touch && d.card.isConnected) focusText(d.card.querySelector('[data-gkb-card]'), true);
    }

    function dragCancel(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = endDrag();
      if (d.lifted && d.home[0].isConnected) d.home[0].insertBefore(d.card, d.home[1]);
    }

    function dragKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dragCancel();
    }

    // ── Pictures ─────────────────────────────────────────────────────────

    // Each picture is read once it is near the part of the note on show.
    // `watched`: the picture elements already seen to - a copy of one,
    // put back by Ctrl+Z, is a new element and is seen to afresh.
    let viewer = null;
    const watched = new WeakSet();

    function watchPictures() {
      for (const el of els.editor.querySelectorAll('.blk[data-type="picture"]')) {
        if (watched.has(el)) continue;
        watched.add(el);
        if (el.dataset.state === 'ready' && el.querySelector('img').getAttribute('src')) continue;
        el.dataset.state = 'loading';
        // One not saved yet is here already: shown at once.
        if (ns.pictures.isPending(el.dataset.src) || typeof IntersectionObserver !== 'function') { showPicture(el); continue; }
        if (!viewer) {
          viewer = new IntersectionObserver(entries => {
            for (const en of entries) {
              if (!en.isIntersecting) continue;
              viewer.unobserve(en.target);
              showPicture(en.target);
            }
          }, { root: els.editor, rootMargin: '600px 0px' });
        }
        viewer.observe(el);
      }
    }

    function showPicture(el) {
      const src = el.dataset.src;
      el.dataset.state = 'loading';
      ns.pictures.load(src).then(info => {
        el.querySelector('img').src = info.url;
        el.dataset.state = 'ready';
        if (onPicture) onPicture(src, info);
      }, err => {
        el.dataset.state = err.lost ? 'lost' : err.code === 'gone' ? 'gone' : 'error';
      });
    }

    // A change to a picture, or pictures put in: like a table's, Ctrl+Z
    // straight afterwards takes it back.
    function pictureEdit(fn) {
      if (!editable) return;
      const undo = pasteUndo;
      const before = snapshot();
      fn();
      changed();
      pasteUndo = [...undo.slice(-19), before];
    }

    // Selected: outlined, with its handle and buttons, and the cursor just
    // after it, so that typing carries on below it.
    function selectPicture(el) {
      if (!editable || !el || !el.isConnected) return;
      if (selPic !== el) {
        deselectPicture();
        selPic = el;
        el.classList.add('sel');
        el.querySelector('.pic-frame').append(pictureTools(el), pictureHandle(el));
      }
      const next = el.nextElementSibling;
      if (next && !isIslandEl(next)) {
        els.editor.focus({ preventScroll: true });
        caretInto(next, false);
      }
      refreshPictureTools();
    }

    function deselectPicture() {
      const el = selPic;
      selPic = null;
      if (!el) return;
      el.classList.remove('sel');
      for (const x of el.querySelectorAll('.pic-tools, .pic-handle')) x.remove();
    }

    const SIZES = [
      [25, '25%', 'A quarter of the note’s width'],
      [50, '50%', 'Half the note’s width'],
      [75, '75%', 'Three quarters of the note’s width'],
      [100, '100%', 'The note’s whole width'],
    ];

    function setPictureWidth(el, width) {
      el.dataset.width = String(width);
      sizeFrame(el.querySelector('.pic-frame'), width);
      refreshPictureTools();
    }

    function refreshPictureTools() {
      if (!selPic) return;
      const w = Number(selPic.dataset.width) || 0;
      for (const b of selPic.querySelectorAll('.pic-size')) b.setAttribute('aria-pressed', String(Number(b.dataset.width) === w));
    }

    function pictureTools(el) {
      const keep = e => e.preventDefault();
      return h('span', { class: 'pic-tools', role: 'toolbar', 'aria-label': 'Picture' },
        SIZES.map(([w, label, title]) => h('button', {
          class: 'pic-size', type: 'button', title, 'aria-pressed': 'false', dataset: { key: `picture-width:${w}`, width: String(w) },
          onmousedown: keep,
          onclick: e => {
            e.stopPropagation();
            if ((Number(el.dataset.width) || 0) !== w) pictureEdit(() => setPictureWidth(el, w));
          },
        }, label)),
        h('button', {
          class: 'pic-delete', type: 'button', title: 'Delete the picture (Ctrl+Z brings it back)', 'aria-label': 'Delete the picture',
          dataset: { key: 'picture-delete' }, onmousedown: keep,
          onclick: e => { e.stopPropagation(); removePicture(el); },
        }, icon('delete', 16)));
    }

    // Dragged, the corner sets the width as a share of the note's: from a
    // tenth of it to all of it.
    function pictureHandle(el) {
      const handle = h('span', { class: 'pic-handle', title: 'Drag to make it bigger or smaller', dataset: { key: 'picture-resize' } });
      handle.addEventListener('pointerdown', e => {
        if (!editable || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const frame = el.querySelector('.pic-frame');
        const full = el.clientWidth || 1;
        const startW = frame.getBoundingClientRect().width;
        const startX = e.clientX;
        const was = Number(el.dataset.width) || 0;
        let width = was;
        try { handle.setPointerCapture(e.pointerId); } catch { /* the pointer went already */ }
        const move = ev => {
          const px = Math.max(full / 10, Math.min(full, startW + ev.clientX - startX));
          width = Math.round((px / full) * 100);
          sizeFrame(frame, width);
        };
        const done = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', done);
          handle.removeEventListener('pointercancel', done);
          if (width !== was && el.isConnected) {
            sizeFrame(frame, was);
            pictureEdit(() => setPictureWidth(el, width));
          }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', done);
        handle.addEventListener('pointercancel', done);
      });
      return handle;
    }

    // The picture gone, the cursor to the line after it.
    function removePicture(el) {
      pictureEdit(() => {
        let next = el.nextElementSibling;
        if (!next || isIslandEl(next)) {
          next = blockEl(fmt.block('p'));
          el.after(next);
        }
        if (selPic === el) deselectPicture();
        el.remove();
        els.editor.focus({ preventScroll: true });
        caretInto(next, false);
      });
    }

    // Keys while a picture is selected: Backspace or Delete deletes it,
    // Ctrl+C and Ctrl+X copy and cut it (the browser does, once it is the
    // selection), the arrows leave it, Escape lets it go, and anything
    // typed goes in where the cursor is, just after it.
    function pictureKey(e, mod) {
      const el = selPic;
      if (!el.isConnected) { selPic = null; return false; }
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && (k === 'c' || k === 'x')) {
        deselectPicture();
        const r = document.createRange();
        r.selectNode(el);
        select(r);
        return true;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !mod && !e.altKey) {
        e.preventDefault();
        removePicture(el);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        deselectPicture();
        return true;
      }
      if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        deselectPicture();
        leaveTable(el, e.key === 'ArrowDown' || e.key === 'ArrowRight');
        return true;
      }
      if (!['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) deselectPicture();
      return false;
    }

    // Pictures from files - picked, pasted or dropped - each made smaller
    // and held in the page until the note is saved: after the block `at`,
    // or in its place if it is an empty line; at the end if it has gone.
    // In a table, after the table.
    async function insertPictures(files, at) {
      const list = [...files].filter(f => /^image\//i.test(f.type || ''));
      if (!editable || !list.length) return;
      const made = [];
      for (const f of list) {
        try {
          made.push(await ns.pictures.add(f));
        } catch (err) {
          toast(root, err.message, { kind: 'error' });
        }
      }
      if (!made.length || !editable) return;
      const blk = at && at.parentNode === els.editor ? at : els.editor.lastElementChild;
      pictureEdit(() => {
        let last = null;
        for (const p of made) {
          const el = pictureEl(fmt.picture(p.src));
          if (!last && blk && blk.dataset.type === 'p' && !blk.textContent) blk.replaceWith(el);
          else if (last || blk) (last || blk).after(el);
          else els.editor.appendChild(el);
          last = el;
        }
        let next = last.nextElementSibling;
        if (!next || isIslandEl(next)) {
          next = blockEl(fmt.block('p'));
          last.after(next);
        }
        if (els.editor.isConnected) {
          els.editor.focus({ preventScroll: true });
          caretInto(next, false);
        }
      });
      if (els.editor.isConnected) revealCaret();
    }

    const imageFiles = data => {
      if (!data) return [];
      const files = [...(data.files || [])];
      if (!files.length) for (const it of data.items || []) if (it.kind === 'file') files.push(it.getAsFile());
      return files.filter(f => f && /^image\//i.test(f.type || ''));
    };

    // The toolbar's Picture: the file picker (on a phone, the photos or
    // the camera), the pictures going in after the line the cursor is on.
    let pickAt = null;
    els.filePick = h('input', {
      type: 'file', accept: 'image/*', multiple: true, hidden: true, tabindex: '-1', dataset: { key: 'picture-file' },
      onchange: () => {
        const files = [...els.filePick.files];
        els.filePick.value = '';
        insertPictures(files, pickAt);
      },
    });

    function pickPicture() {
      if (!editable) return;
      restore();
      const r = range();
      pickAt = r ? blockOf(r.startContainer === els.editor ? els.editor.childNodes[Math.min(r.startOffset, els.editor.childNodes.length - 1)] : r.startContainer) : null;
      els.filePick.click();
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
      tbButton('board', 'Board: columns of cards', 'board', () => insertBoard(), false),
      tbButton('picture', 'Picture (or paste or drop one)', 'picture', () => pickPicture(), false),
      els.filePick,
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
    // `now`: what its menu is about - the cell, or the board's title or
    // card - which `items` gets.
    const menuButton = (key, label, items, now = cellNow) => {
      const b = h('button', {
        class: 'tb-text', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { key },
        onmousedown: keepFocus,
        onclick: () => {
          const at = editable && now();
          if (at) openMenu(root, b, items(at), { label });
        },
      }, label, icon('caret', 18));
      return b;
    };
    els.tableHead = h('button', {
      class: 'tb-text', type: 'button', 'aria-pressed': 'false', title: 'The first row is a heading row',
      dataset: { key: 'table-head' }, onmousedown: keepFocus, onclick: () => toggleHead(),
    }, 'Heading row');
    els.tablebar = h('div', { class: 'ne-tablebar', role: 'toolbar', 'aria-label': 'Table', hidden: true },
      h('span', { class: 'tb-label' }, icon('table', 18)),
      // Delete table is in both menus too, beneath Delete row and Delete
      // column, where anyone looking for it looks first.
      menuButton('table-row', 'Row', () => [
        { label: 'Insert row above', key: 'row-above', onSelect: () => addRow(false) },
        { label: 'Insert row below', key: 'row-below', onSelect: () => addRow(true) },
        { separator: true },
        { label: 'Delete row', key: 'row-delete', danger: true, onSelect: () => deleteRow() },
        { label: 'Delete table', key: 'delete-table', danger: true, onSelect: () => deleteTable() },
      ]),
      menuButton('table-column', 'Column', () => [
        { label: 'Insert column left', key: 'col-left', onSelect: () => addColumn(false) },
        { label: 'Insert column right', key: 'col-right', onSelect: () => addColumn(true) },
        { separator: true },
        { label: 'Delete column', key: 'col-delete', danger: true, onSelect: () => deleteColumn() },
        { label: 'Delete table', key: 'delete-table', danger: true, onSelect: () => deleteTable() },
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
      // In words: a bare bin here looked like the note's own Delete above it.
      h('button', {
        class: 'tb-text tb-danger', type: 'button', title: 'Delete the table (Ctrl+Z brings it back)',
        dataset: { key: 'fmt-table-delete' }, onmousedown: keepFocus,
        onclick: () => { if (editable && cellNow()) deleteTable(); },
      }, icon('delete', 18), 'Delete table'));

    function deleteTable() {
      tableEdit((td, el) => removeTable(el));
    }

    // The board bar: under the toolbar while the cursor is in a board.
    els.boardCard = menuButton('board-card', 'Card', t => cardItems(t), boardNow);
    els.boardbar = h('div', { class: 'ne-boardbar', role: 'toolbar', 'aria-label': 'Board', hidden: true },
      h('span', { class: 'tb-label', title: 'Enter adds a card; Alt and the arrow keys move one. Drag a card by its handle.' }, icon('board', 18)),
      els.boardCard,
      menuButton('board-column', 'Column', t => columnItems(t), boardNow),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'tb-text tb-danger', type: 'button', title: 'Delete the board (Ctrl+Z brings it back)',
        dataset: { key: 'fmt-board-delete' }, onmousedown: keepFocus,
        onclick: () => {
          const t = editable && boardNow();
          if (t) deleteBoard(t);
        },
      }, icon('delete', 18), 'Delete board'));

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
      // In a cell: the table bar, and nothing that makes lists or headings;
      // in a board, the board bar. Neither holds a table or a board.
      const td = cellOf(r.startContainer);
      const kt = !td && boardTextOf(r.startContainer);
      if (td) lastCell = td;
      if (kt) lastText = kt;
      els.tablebar.hidden = !td || !editable;
      els.boardbar.hidden = !kt || !editable;
      for (const k of ['ul', 'ol', 'check', 'outdent', 'indent', 'table', 'board']) buttons[k].disabled = !editable || !!td || !!kt;
      els.style.disabled = !editable || !!td || !!kt;
      // A title has no card to move or delete.
      if (kt) els.boardCard.disabled = isTitle(kt);
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
      // A selected picture's buttons take their own keys; Escape goes back
      // to the text.
      if (e.target.closest && e.target.closest('.pic-tools')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const el = selPic;
          deselectPicture();
          if (el && el.isConnected) leaveTable(el, true);
        }
        return;
      }
      if (selPic && pictureKey(e, mod)) return;
      const r = range();
      const blk = r && blockOf(r.startContainer);
      const td = r && cellOf(r.startContainer);
      if (td && cellKey(e, td, r, mod)) return;
      const kt = !td && r && boardTextOf(r.startContainer);
      if (kt && boardKey(e, kt, r, mod)) return;
      if (!td && !kt && blk && besideTable(e, r, blk, mod)) return;

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
      // A picture copied on its own - a screenshot, "Copy image". (Word
      // copies a picture of the text along with it: text comes first.)
      const files = text.trim() ? [] : imageFiles(data);
      if (files.length) {
        const at = range();
        insertPictures(files, at ? blockOf(at.startContainer) : null);
        return;
      }
      const doc = plain ? null : fmt.pasteDoc({ html: data && data.getData('text/html'), text });
      const at = range();
      if (at && cellOf(at.startContainer)) {
        pasteInCell(doc, text);
        revealCaret();
        return;
      }
      const kt = at && boardTextOf(at.startContainer);
      if (kt) {
        pasteInBoard(doc, text, kt);
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
    // Dropped pictures go in after the line they are dropped on. Dropped
    // HTML would bring its own markup, and other files have nowhere to go.
    els.editor.addEventListener('dragover', e => {
      if (!editable || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    els.editor.addEventListener('drop', e => {
      e.preventDefault();
      const files = imageFiles(e.dataTransfer);
      if (!editable || !files.length) return;
      const under = root.elementFromPoint ? root.elementFromPoint(e.clientX, e.clientY) : null;
      insertPictures(files, under && under !== els.editor && els.editor.contains(under) ? blockOf(under) : null);
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
      if (!fmt.isIsland(doc[0]) && (doc[0].type === 'p' || !blk.textContent)) {
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
      // Nothing goes into a pasted table or picture: the cursor goes to a
      // line after it.
      if (isIslandEl(last) && target === last) {
        target = blockEl(fmt.block('p'));
        target.replaceChildren();
        last.after(target);
      }
      if (!isIslandEl(last)) prune(last);
      const at = target === last ? last.childNodes.length : 0;
      target.append(after);
      holdOpen(blk);
      if (!isIslandEl(last)) holdOpen(last);
      holdOpen(target);
      // A table or a picture pasted on an empty line takes its place.
      if (fmt.isIsland(doc[0]) && !blk.textContent && blk !== target) blk.remove();
      if (isIslandEl(last)) caretInto(target, false);
      else if (target === last) placeCaret(last, at);
      else placeCaret(last, last.firstChild.nodeName === 'BR' ? 0 : last.childNodes.length);

      changed();
      pasteUndo = [...undo.slice(-19), before];
    }

    // The editor's blocks, and the selection as text offsets within them.
    // A selected picture is copied as it is when not selected.
    function snapshot() {
      const r = range();
      const copy = n => {
        const c = n.cloneNode(true);
        if (c.nodeType !== 1 || c.dataset.type !== 'picture') return c;
        c.classList.remove('sel');
        for (const x of c.querySelectorAll('.pic-tools, .pic-handle')) x.remove();
        return c;
      };
      return {
        nodes: [...els.editor.childNodes].map(copy),
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
      deselectPicture();
      els.editor.replaceChildren(...snap.nodes);
      const a = pointAt(snap.start);
      const z = pointAt(snap.end);
      if (a && z) {
        // In a table or a board, the new cell or card takes the focus.
        const host = hostOf(a[0]) || els.editor;
        if (root.activeElement !== host) host.focus({ preventScroll: true });
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

    // A board's buttons and handles keep the focus in the text, and a
    // handle pressed may be the start of a drag.
    els.editor.addEventListener('mousedown', e => {
      if (e.target.closest && e.target.closest('.kb-ui')) e.preventDefault();
      else if (e.target.classList && e.target.classList.contains('kb-card')) e.preventDefault(); // opened on the click
    });
    // A card left folds again, to its front as it now reads.
    els.editor.addEventListener('focusout', e => {
      if (e.target.dataset && e.target.dataset.gkbCard !== undefined) foldCards([e.target]);
    });
    // Where the last press was: a click that ends somewhere else was a
    // drag, selecting text, not a click on a link.
    let pressedAt = null;
    els.editor.addEventListener('pointerdown', e => {
      pressedAt = [e.clientX, e.clientY];
      const grip = e.target.closest && e.target.closest('.kb-grip');
      if (grip) dragStart(e, grip);
    });

    els.editor.addEventListener('click', e => {
      const ui = e.target.closest && e.target.closest('.kb-ui');
      if (ui) {
        if (editable) boardButton(ui);
        return;
      }
      // A click on a card but not its words - on "2 more lines" under a
      // folded one - opens it.
      if (e.target.classList && e.target.classList.contains('kb-card')) {
        if (editable) focusText(e.target.querySelector('[data-gkb-card]'), true);
        return;
      }
      const pic = e.target.closest && e.target.closest('.blk[data-type="picture"]');
      if (pic && e.target.closest('.pic-tools, .pic-handle')) return;
      if (pic && editable) {
        // One that could not be read: tried again.
        if (pic.dataset.state === 'error') showPicture(pic);
        selectPicture(pic);
        return;
      }
      if (selPic) deselectPicture();
      // A click on a link opens it in a new tab - while the note can be
      // edited too, and never in this one, which would leave the page.
      // Not when the click ended a drag over its words, or with Shift,
      // which selects: that is how its words are edited.
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) {
        e.preventDefault();
        const dragged = e.detail > 0 && pressedAt && Math.abs(e.clientX - pressedAt[0]) + Math.abs(e.clientY - pressedAt[1]) > 4;
        if (e.shiftKey || e.altKey || e.detail > 1 || dragged) return;
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

    // The middle button opens a link in a new tab too, as anywhere.
    els.editor.addEventListener('auxclick', e => {
      const a = e.button === 1 && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
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
        if (blk.nodeType === 1 && blk.dataset.type === 'picture') return; // its buttons are not the note's words
        // Nor are a board's.
        const words = blk.nodeType === 1 && blk.dataset.type === 'board'
          ? { acceptNode: n => (n.parentNode.closest('.kb-ui') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) } : null;
        const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT, words);
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
      // A match on the back of a card is no use folded away.
      for (const r of matchRanges) {
        const card = r.startContainer.parentElement && r.startContainer.parentElement.closest('.kb-card');
        if (card) card.classList.add('kb-hit');
      }
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
      for (const card of els.editor.querySelectorAll('.kb-card.kb-hit')) card.classList.remove('kb-hit');
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

    // Cells, titles and cards are each editable on their own, when the
    // note is.
    function syncEditable() {
      for (const x of els.editor.querySelectorAll('td, [data-gkb-title], [data-gkb-card]')) x.contentEditable = editable ? 'true' : 'false';
    }

    function setDoc(doc) {
      pasteUndo = [];
      lastCell = null;
      lastText = null;
      if (drag) endDrag();
      deselectPicture();
      if (sizer) sizer.disconnect(); // the columns going out are not watched any more
      stopLater();
      els.editor.replaceChildren(...fmt.normaliseDoc(doc).map(blockEl));
      syncEditable();
      updateEmpty();
      watchPictures();
      watchCards();
      drawOutline();
    }

    // Pictures saved: their "new-..." names, or the ids of another note's
    // pictures copied in, replaced by their own messages' ids (`map`:
    // { old: new }); one mapped to null, which could not be saved because
    // it is no longer there, is taken out. What shows does not change.
    function renamePictures(map) {
      const has = k => Object.prototype.hasOwnProperty.call(map || {}, k);
      let dropped = false;
      for (const el of [...els.editor.querySelectorAll('.blk[data-type="picture"]')]) {
        if (!has(el.dataset.src)) continue;
        if (map[el.dataset.src]) {
          el.dataset.src = map[el.dataset.src];
          continue;
        }
        if (selPic === el) deselectPicture();
        el.remove();
        dropped = true;
      }
      if (dropped) tidy();
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
        // In a table or a board, the new cell or card takes the focus the
        // old one had.
        const host = hostOf(a[0]) || els.editor;
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
      syncEditable();
      if (!editable) {
        els.tablebar.hidden = true;
        els.boardbar.hidden = true;
        if (drag) dragCancel();
        deselectPicture();
      }
    }

    function focus() {
      els.editor.focus();
      const first = els.editor.firstChild;
      if (first) placeCaret(first, 0);
    }

    function destroy() {
      if (drag) dragCancel();
      clearTimeout(outlineTimer);
      cancelAnimationFrame(outlineFrame);
      if (viewer) viewer.disconnect();
      if (sizer) sizer.disconnect();
      stopLater();
      document.removeEventListener('selectionchange', onSelection);
      clearHighlights();
      closeMenu(root);
    }

    return {
      element: els.editor,
      toolbar: els.toolbar,
      linkbar: els.linkbar,
      tablebar: els.tablebar,
      boardbar: els.boardbar,
      outline: els.outline,
      setContentsShown,
      setDoc,
      replaceDoc,
      renamePictures,
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

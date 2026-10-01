// ─────────────────────────────────────────────────────────────────────
// The formatted note editor
//
// An editable area with a toolbar: text style (normal, three headings),
// bold, italic, strike-through, bulleted, numbered and check lists with
// three levels of nesting, links, and clear formatting.
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
// Pasted and dropped text arrives as plain text, so a page copied from
// the web cannot bring its styles, images or scripts with it.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, openMenu, closeMenu } = ns.ui;
  const fmt = ns.noteFormat;

  const STYLES = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3']];
  const STYLE_LABEL = Object.fromEntries(STYLES);
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

  function blockEl(b) {
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
        const m = { ...marks };
        if (tag === 'b' || tag === 'strong') m.b = true;
        else if (tag === 'i' || tag === 'em') m.i = true;
        else if (tag === 's' || tag === 'strike' || tag === 'del') m.s = true;
        else if (tag === 'a') {
          const href = fmt.safeHref(child.getAttribute('href'));
          if (href) m.href = href;
        } else if (tag === 'span' || tag === 'font') {
          const st = styleMarks(child.getAttribute('style'));
          if (st.b) m.b = true;
          if (st.i) m.i = true;
          if (st.s) m.s = true;
        }
        walk(child, m);
      }
    })(el, {});
    // A <br> or nested block at the very end leaves an empty block behind:
    // that is the browser's placeholder, not a new line.
    while (out.length - 1 > first && !out[out.length - 1].runs.some(r => r.text)) out.pop();
  }

  function readDoc(editor) {
    const blocks = [];
    for (const node of editor.childNodes) {
      if (node.nodeType === 1 && node.classList.contains('blk')) readBlock(node, blocks);
      else if (node.nodeType === 3 && node.data.trim()) blocks.push(fmt.block('p', [{ text: node.data.replace(/ /g, ' ') }]));
      else if (node.nodeType === 1 && node.tagName !== 'BR') readBlock(node, blocks);
    }
    return fmt.normaliseDoc(blocks);
  }

  // ── Selection ────────────────────────────────────────────────────────

  function create({ root, onChange }) {
    const els = {};
    let saved = null;     // the last selection inside the editor
    let editable = false;

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
      if (root.activeElement !== els.editor) els.editor.focus({ preventScroll: true });
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
      tidy();
      onChange();
      refreshToolbar();
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
      if (!r) return;
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
      if (!r) return false;
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
      if (r) for (const b of rangeBlocks(r)) setBlock(b, 'p');
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
      sep(),
      tbButton('link', 'Link (Ctrl+K)', 'link', () => openLink()),
      tbButton('clear', 'Clear formatting', 'clear', () => clearFormatting(), false));

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
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      insertPlain(text);
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

    // ── API ──────────────────────────────────────────────────────────────

    function setDoc(doc) {
      els.editor.replaceChildren(...fmt.normaliseDoc(doc).map(blockEl));
      updateEmpty();
    }

    function setEditable(on, placeholder) {
      editable = !!on;
      els.editor.contentEditable = editable ? 'true' : 'false';
      els.editor.dataset.placeholder = placeholder || 'Write here…';
      els.editor.setAttribute('aria-disabled', String(!editable));
      for (const b of [...els.toolbar.querySelectorAll('button')]) b.disabled = !editable;
    }

    function focus() {
      els.editor.focus();
      const first = els.editor.firstChild;
      if (first) placeCaret(first, 0);
    }

    function destroy() {
      document.removeEventListener('selectionchange', onSelection);
      clearHighlights();
      closeMenu(root);
    }

    return {
      element: els.editor,
      toolbar: els.toolbar,
      linkbar: els.linkbar,
      setDoc,
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

// ─────────────────────────────────────────────────────────────────────
// The notes view
//
// The board's second tab: folders on the left, then the notes in the
// chosen folder, then the open note. Typing saves by itself a moment after
// you stop, and again on switching notes, switching tabs or closing;
// Ctrl+S saves at once. A note moves to another folder by dragging it onto
// one, or from the folder button above the text.
//
// The board owns the overlay, the header and the account panels (setup,
// connect); this file owns everything inside the body while the Notes tab
// is showing. Its element is built once and kept, so that a board redraw
// never pulls the text box out from under someone who is typing.
//
// The phone app (addon/app) runs this same view full-screen on a phone,
// with a different way to Gmail behind notesStore. A phone shows one pane
// at a time - the list, or the open note - so the element says which
// (data-view) and the note has a Back button, which only the phone's
// stylesheet shows.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, toast, openMenu } = ns.ui;
  const { util, notesLogic, notesStore, hooks, api } = ns;
  const fmt = ns.noteFormat;
  const searchLogic = ns.searchLogic;

  // How many search results get excerpts at once. Each needs the note's
  // full text, which is one more request the first time.
  const EXCERPT_LIMIT = 30;

  // Long enough not to save mid-sentence (each save is a new message and
  // a trashed old one), short enough that little is at risk.
  const AUTOSAVE_MS = 2500;
  const STALE_MS = 60 * 1000;

  const N = {
    ctx: null,          // { root, onStateError, onLoaded, closeBoard, barChanged }
    notes: [],          // live notes, newest first (metadata only)
    truncated: false,
    query: '',
    status: 'idle',     // idle | loading | ready | error
    error: '',
    loadedAt: 0,
    loading: null,
    current: null,      // the note being edited - see newCurrent()
    chain: Promise.resolve(), // saves and moves run one after another
    folders: [],        // notesLogic.folderTree(), from the last listing
    folder: '',         // the folder shown; '' for all notes
    folderEdit: null,   // { mode: 'new' | 'rename', parentId, folderId, value, error, busy }
    folded: new Set(),  // folders whose subfolders are folded away
    foldedRead: false,  // the saved set has been asked for
    dragKey: '',        // the note being dragged onto a folder
    terms: [],          // searchLogic.queryTerms() of the search that is showing
    hits: new Map(),    // `${messageId}|${terms}` → { count, excerpts }
    findIndex: 0,       // which match in the open note is the current one
  };

  let saveTimer = 0;
  let searchTimer = 0;
  let findTimer = 0;
  const els = {};

  // ── Setup ────────────────────────────────────────────────────────────

  function init(ctx) {
    N.ctx = ctx;
    N.view = '';
    // Closing the tab mid-sentence would lose the last few seconds of
    // typing; the browser's own "Leave site?" prompt is the only defence.
    window.addEventListener('beforeunload', e => {
      const c = N.current;
      if (c && (c.dirty || c.saving)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function element() {
    if (els.wrap) return els.wrap;

    els.search = h('input', {
      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes',
      dataset: { key: 'notes-search' },
      oninput: e => {
        N.query = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => load({ force: true }), 400);
      },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); load({ force: true }); }
      },
    });
    els.items = h('div', { class: 'notes-items', role: 'list', 'aria-label': 'Notes' });
    els.foot = h('div', { class: 'notes-foot' });
    els.scope = h('div', { class: 'notes-scope' });

    els.list = h('section', { class: 'notes-list', 'aria-label': 'Notes' },
      h('div', { class: 'notes-tools' },
        h('div', { class: 'search-box' }, icon('search', 18), els.search),
        h('button', {
          class: 'btn btn-tonal', type: 'button', dataset: { key: 'note-new' },
          title: 'New note', onclick: () => newNote(),
        }, icon('add', 18), 'New')),
      els.scope,
      els.items,
      els.foot);

    els.folderItems = h('div', { class: 'folder-items', role: 'list', 'aria-label': 'Folders' });
    // On a phone the tree folds away behind one button that says where
    // you are; only the phone's stylesheet shows it.
    els.foldersToggle = h('button', {
      class: 'folders-toggle', type: 'button', 'aria-expanded': 'false', dataset: { key: 'folders-toggle' },
      onclick: () => setFoldersOpen(els.wrap.dataset.folders !== 'open'),
    });
    els.foldersPane = h('section', { class: 'notes-folders', 'aria-label': 'Folders' },
      els.foldersToggle,
      h('div', { class: 'folders-head' },
        h('h2', { text: 'Folders' }),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'New folder', 'aria-label': 'New folder',
          dataset: { key: 'folder-new' }, onclick: () => startFolderEdit({ mode: 'new', parentId: '' }),
        }, icon('add', 20))),
      els.folderItems);

    els.editor = h('section', { class: 'note-editor', 'aria-label': 'Note' });
    els.wrap = h('div', { class: 'notes', dataset: { folders: 'closed' } }, els.foldersPane, els.list, els.editor);
    drawFolders();
    drawList();
    drawEditor();
    return els.wrap;
  }

  // ── Loading ──────────────────────────────────────────────────────────

  function isStale() {
    return N.status !== 'ready' || Date.now() - N.loadedAt > STALE_MS;
  }

  function load({ force = false } = {}) {
    if (N.loading) return N.loading;
    if (!force && !isStale()) return Promise.resolve();
    const query = N.query;
    if (!N.notes.length) N.status = 'loading';
    drawList();

    N.loading = (async () => {
      try {
        const folded = N.foldedRead ? null : readFolded();
        const r = await notesStore.list(hooks.getAccount(), query);
        if (folded) await folded;
        if (query !== N.query) return; // a newer search has started
        N.notes = r.notes;
        N.truncated = r.truncated;
        N.folders = r.folders || [];
        const terms = searchLogic.queryTerms(query);
        if (JSON.stringify(terms) !== JSON.stringify(N.terms)) N.findIndex = 0;
        N.terms = terms;
        // The folder shown was deleted or renamed away in Gmail.
        if (N.folder && !N.folders.some(f => f.id === N.folder)) N.folder = '';
        N.status = 'ready';
        N.error = '';
        N.loadedAt = Date.now();
        catchUpCurrent();
        N.ctx.onLoaded();
      } catch (err) {
        if (api.STATE_CODES.has(err.code)) {
          N.status = 'idle';
          N.ctx.onStateError(err);
          return;
        }
        N.status = N.notes.length ? 'ready' : 'error';
        N.error = err.message;
        if (N.notes.length) toast(N.ctx.root, `Couldn’t load notes: ${err.message}`, { kind: 'error' });
      } finally {
        N.loading = null;
        drawFolders();
        drawList();
        drawFoot();
        if (N.current) drawBar();
        applyHighlights();
        fetchHits();
        N.ctx.barChanged();
      }
    })();
    // The search box changed while this was in flight, and the load that
    // change asked for was turned away above: run it now.
    const p = N.loading;
    return p.then(() => (query !== N.query ? load({ force: true }) : undefined));
  }

  // The open note was saved on another computer since it was opened here:
  // show the newer text, unless there are edits here that would be lost.
  function catchUpCurrent() {
    const c = N.current;
    if (!c || !c.note || c.dirty || c.saving) return;
    const fresh = N.notes.find(n => n.key === c.key);
    if (fresh && fresh.messageId !== c.note.messageId) openNote(fresh, { force: true });
  }

  // ── The list ─────────────────────────────────────────────────────────

  function folderById(id) {
    return N.folders.find(f => f.id === id) || null;
  }

  // "Work › Clients"
  function folderLabel(id) {
    const f = folderById(id);
    return f ? f.path.split('/').join(' \u203a ') : '';
  }

  function visibleNotes() {
    return N.folder ? N.notes.filter(n => n.folderId === N.folder) : N.notes;
  }

  function drawList() {
    if (!els.items) return;
    const curKey = N.current && N.current.key;
    const shown = visibleNotes();
    const searching = !!N.query.trim();
    if (els.scope) {
      const where = N.folder ? folderLabel(N.folder) : 'All notes';
      els.scope.textContent = N.status === 'ready'
        ? `${where} \u00b7 ${shown.length} ${searching ? (shown.length === 1 ? 'match' : 'matches') : (shown.length === 1 ? 'note' : 'notes')}`
        : where;
    }
    if (els.search) els.search.placeholder = N.folder ? `Search in ${folderById(N.folder) ? folderById(N.folder).title : 'this folder'}` : 'Search notes';

    if (N.status === 'loading' && !N.notes.length) {
      els.items.replaceChildren(h('div', { class: 'notes-empty', text: 'Loading…' }));
      return;
    }
    if (N.status === 'error' && !N.notes.length) {
      els.items.replaceChildren(
        h('div', { class: 'notes-empty' },
          h('p', { text: `Couldn’t load notes: ${N.error}` }),
          h('button', { class: 'btn btn-text', type: 'button', text: 'Try again', onclick: () => load({ force: true }) })));
      return;
    }
    if (!shown.length) {
      let text = searching ? 'No notes match.' : 'No notes yet.';
      if (N.folder) text = searching ? 'No notes in this folder match.' : 'No notes in this folder yet.';
      els.items.replaceChildren(h('div', { class: 'notes-empty', text }));
      return;
    }

    els.items.replaceChildren(...shown.map(n => {
      const item = h('button', {
        class: 'note-item', type: 'button', role: 'listitem', draggable: 'true',
        'aria-current': n.key === curKey ? 'true' : null,
        dataset: { key: `note:${n.key}`, note: n.key },
        onclick: () => openNote(n),
      },
        h('span', { class: 'ni-top' },
          h('span', { class: 'ni-title' }, marked(n.title)),
          h('span', { class: 'date', text: util.relativeDate(n.updated), title: util.fullDate(n.updated) })),
        itemPreview(n),
        h('span', { class: 'ni-meta' },
          hitCount(n),
          !N.folder && n.folderId ? h('span', { class: 'ni-folder' }, icon('folder', 14), folderLabel(n.folderId)) : null,
          n.own ? null : h('span', { class: 'ni-mail', text: 'From an email' })));
      item.addEventListener('dragstart', e => {
        N.dragKey = n.key;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-gkb-note', n.key);
        els.wrap.classList.add('dragging-note');
      });
      item.addEventListener('dragend', () => {
        N.dragKey = '';
        els.wrap.classList.remove('dragging-note');
        for (const r of els.folderItems.querySelectorAll('.drop')) r.classList.remove('drop');
      });
      return item;
    }));
  }

  // ── Search results ───────────────────────────────────────────────────
  //
  // Gmail finds the notes; these show where the words are. Each result
  // gets excerpts around its matches once its text is in, with the words
  // marked. Until then - or if Gmail matched something the words do not
  // show, such as a stemmed form - it shows Gmail's own snippet.

  const termsKey = () => JSON.stringify(N.terms);

  // Text with the search words wrapped in <mark>, built from text nodes.
  function marked(text, marks) {
    const s = String(text || '');
    const m = marks || (N.terms.length ? searchLogic.findMatches(s, N.terms) : []);
    if (!m.length) return s;
    const out = [];
    let at = 0;
    for (const { start, end } of m) {
      if (start > at) out.push(s.slice(at, start));
      out.push(h('mark', { text: s.slice(start, end) }));
      at = end;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  }

  function itemPreview(n) {
    const hit = N.terms.length ? N.hits.get(`${n.messageId}|${termsKey()}`) : null;
    if (hit && hit.excerpts.length) {
      return h('span', { class: 'ni-excerpts' }, hit.excerpts.map(ex => h('span', { class: 'ni-excerpt' },
        ex.cutBefore ? '\u2026' : '', marked(ex.text, ex.marks), ex.cutAfter ? '\u2026' : '')));
    }
    return n.snippet ? h('span', { class: 'ni-snippet' }, marked(n.snippet)) : null;
  }

  function hitCount(n) {
    if (!N.terms.length) return null;
    const hit = N.hits.get(`${n.messageId}|${termsKey()}`);
    if (!hit) return null;
    return h('span', { class: 'ni-hits', text: `${hit.count} ${hit.count === 1 ? 'match' : 'matches'}` });
  }

  // Fetches the text of the results on show that have no excerpts yet,
  // a few at a time, redrawing the list as they come in.
  let hitsRun = 0;
  async function fetchHits() {
    if (!N.terms.length) return;
    const run = ++hitsRun;
    const key = termsKey();
    const terms = N.terms;
    const todo = visibleNotes().slice(0, EXCERPT_LIMIT).filter(n => !N.hits.has(`${n.messageId}|${key}`));
    let redraw = 0;
    await util.mapPool(todo, 4, async n => {
      if (run !== hitsRun) return;
      try {
        const doc = await notesStore.body(n);
        const text = fmt.docText(doc);
        const body = searchLogic.findMatches(text, terms);
        const title = searchLogic.findMatches(n.title, terms);
        N.hits.set(`${n.messageId}|${key}`, {
          count: body.length + title.length,
          excerpts: searchLogic.excerpts(text, body, { context: 45, max: 3 }),
        });
      } catch { /* the snippet stands in */ }
      if (run === hitsRun && !redraw) redraw = setTimeout(() => { redraw = 0; drawList(); }, 60);
    });
    if (run === hitsRun) drawList();
  }

  // ── Find in the open note ────────────────────────────────────────────

  function applyHighlights() {
    const c = N.current;
    if (!els.ed || !c || c.bodyState !== 'ready') { drawFind(); return; }
    const count = els.ed.highlight(N.terms);
    if (N.findIndex >= count) N.findIndex = 0;
    if (count) els.ed.showMatch(N.findIndex);
    drawFind();
  }

  function stepMatch(delta) {
    const count = els.ed ? els.ed.matchCount() : 0;
    if (!count) return;
    N.findIndex = (N.findIndex + delta + count) % count;
    els.ed.showMatch(N.findIndex);
    drawFind();
  }

  function clearSearch() {
    if (!els.search) return;
    els.search.value = '';
    N.query = '';
    clearTimeout(searchTimer);
    load({ force: true });
  }

  function drawFind() {
    if (!els.findSlot) return;
    const c = N.current;
    if (!N.terms.length || !c || !els.ed || c.bodyState !== 'ready') {
      els.findSlot.replaceChildren();
      return;
    }
    const count = els.ed.matchCount();
    const words = N.terms.map(t => t.words.join(' ')).join(', ');
    // A redraw replaces the arrow just pressed; focus goes to its successor
    // rather than falling out of the board, where F3 would not reach it.
    const active = N.ctx.root.activeElement;
    const refocus = active && els.findSlot.contains(active) ? active.dataset.key : '';
    els.findSlot.replaceChildren(h('div', { class: 'ne-find', role: 'search', 'aria-label': 'Matches in this note' },
      icon('search', 18),
      h('span', { class: 'find-words', text: words, title: words }),
      h('span', { class: 'find-pos', 'aria-live': 'polite', text: count ? `${N.findIndex + 1} of ${count}` : 'Not in the text' }),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Previous match (Shift+F3)', title: 'Previous match (Shift+F3)',
        disabled: count < 2, dataset: { key: 'find-prev' }, onclick: () => stepMatch(-1),
      }, icon('up', 18)),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Next match (F3)', title: 'Next match (F3)',
        disabled: count < 2, dataset: { key: 'find-next' }, onclick: () => stepMatch(1),
      }, icon('down', 18)),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Clear the search', title: 'Clear the search',
        dataset: { key: 'find-clear' }, onclick: clearSearch,
      }, icon('close', 18))));
    if (refocus) {
      const again = els.findSlot.querySelector(`[data-key="${refocus}"]`);
      if (again && !again.disabled) again.focus();
    }
  }

  // ── Folders ──────────────────────────────────────────────────────────

  function counts() {
    const out = new Map();
    for (const n of N.notes) out.set(n.folderId || '', (out.get(n.folderId || '') || 0) + 1);
    return out;
  }

  function setFoldersOpen(open) {
    if (!els.wrap) return;
    els.wrap.dataset.folders = open ? 'open' : 'closed';
    els.foldersToggle.setAttribute('aria-expanded', String(open));
  }

  // ── Folding ──────────────────────────────────────────────────────────
  //
  // A folder with subfolders has an arrow that folds them away, for a tree
  // that has grown long. Which ones are folded is remembered where the
  // host keeps such things (ctx.prefs), if it does: a nicety, so any
  // trouble with it just leaves every folder open.

  function hasSubfolders(f) {
    return N.folders.some(x => x.name.startsWith(`${f.name}/`));
  }

  // Inside a folded folder, at any depth.
  function isTucked(f) {
    return N.folders.some(x => N.folded.has(x.id) && f.name.startsWith(`${x.name}/`));
  }

  async function readFolded() {
    N.foldedRead = true;
    const prefs = N.ctx && N.ctx.prefs;
    if (!prefs) return;
    try {
      const ids = await prefs.get('foldedFolders');
      if (Array.isArray(ids)) N.folded = new Set(ids.filter(id => typeof id === 'string'));
    } catch (err) { /* every folder open */ }
  }

  function saveFolded() {
    const prefs = N.ctx && N.ctx.prefs;
    if (!prefs) return;
    // Only folders that are still there, so deleted ones do not pile up.
    const ids = [...N.folded].filter(id => folderById(id));
    try {
      Promise.resolve(prefs.set('foldedFolders', ids)).catch(() => {});
    } catch (err) { /* not remembered, that is all */ }
  }

  function setFolded(f, folded) {
    if (folded === N.folded.has(f.id)) return;
    if (folded) N.folded.add(f.id);
    else N.folded.delete(f.id);
    saveFolded();
    // The rows are drawn afresh: keep the keyboard where it was.
    const active = N.ctx.root.activeElement;
    const key = active && els.folderItems.contains(active) ? active.dataset.key : '';
    drawFolders();
    if (key) {
      const again = els.folderItems.querySelector(`[data-key="${key}"]`);
      if (again) again.focus();
    }
  }

  // Opens every folder above this one, and with self, this one too.
  function unfold(f, self) {
    let changed = false;
    for (const x of N.folders) {
      if (N.folded.has(x.id) && ((self && x.id === f.id) || f.name.startsWith(`${x.name}/`))) {
        N.folded.delete(x.id);
        changed = true;
      }
    }
    if (changed) saveFolded();
  }

  function selectFolder(id) {
    setFoldersOpen(false);
    if (N.folder === id) return;
    N.folder = id;
    drawFolders();
    drawList();
    fetchHits();
  }

  function drawFolders() {
    if (!els.folderItems) return;
    const tally = counts();
    const rows = [folderRow(null, N.notes.length)];
    const edit = N.folderEdit;
    if (edit && edit.mode === 'new' && !edit.parentId) rows.push(editRow(0));
    const current = N.folder ? folderById(N.folder) : null;
    N.folders.forEach((f, i) => {
      if (!isTucked(f)) {
        rows.push(edit && edit.mode === 'rename' && edit.folderId === f.id ? editRow(f.depth, f)
          : folderRow(f, tally.get(f.id) || 0, !!current && N.folded.has(f.id) && current.name.startsWith(`${f.name}/`)));
      }
      // A new subfolder's field goes after the whole branch it joins.
      const next = N.folders[i + 1];
      const branchEnds = !next || !next.name.startsWith(`${f.name}/`);
      if (edit && edit.mode === 'new' && edit.parentId) {
        const parent = folderById(edit.parentId);
        if (parent && (f.id === parent.id || f.name.startsWith(`${parent.name}/`)) && branchEnds) rows.push(editRow(parent.depth + 1));
      }
    });
    els.folderItems.replaceChildren(...rows);
    // Room for the arrows only once some folder has subfolders.
    els.folderItems.toggleAttribute('data-nested', N.folders.some(f => f.depth > 0));

    const shown = N.folder ? folderById(N.folder) : null;
    els.foldersToggle.replaceChildren(
      icon(shown ? 'folder' : 'notes', 20),
      h('span', { class: 'ft-label', text: shown ? folderLabel(shown.id) : 'All notes' }),
      h('span', { class: 'ft-count', text: N.status === 'ready' ? String(shown ? tally.get(shown.id) || 0 : N.notes.length) : '' }),
      icon('caret', 20));
  }

  // holdsCurrent: folded, with the folder being looked at somewhere inside.
  function folderRow(f, count, holdsCurrent = false) {
    const id = f ? f.id : '';
    const children = f ? hasSubfolders(f) : false;
    const folded = children && N.folded.has(id);
    const row = h('div', {
      class: 'folder-row', role: 'listitem', dataset: { folder: id || 'all' },
    },
      children ? h('button', {
        class: 'folder-twisty', type: 'button', 'aria-expanded': String(!folded),
        'aria-label': `${folded ? 'Show' : 'Hide'} the folders in ${f.title}`, title: folded ? 'Show subfolders' : 'Hide subfolders',
        dataset: { key: `folder-twisty:${id}` }, onclick: () => setFolded(f, !folded),
      }, icon('caret', 18)) : h('span', { class: 'folder-twisty', 'aria-hidden': 'true' }),
      h('button', {
        class: `folder-btn${holdsCurrent ? ' holds-current' : ''}`, type: 'button', 'aria-current': N.folder === id ? 'true' : null,
        dataset: { key: `folder:${id || 'all'}` }, title: f ? f.name : 'Every note, in any folder',
        onclick: () => selectFolder(id),
        // As in any tree: right opens a folder's subfolders, left folds them.
        onkeydown: e => {
          if (!children || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (e.key === 'ArrowRight' && folded) { e.preventDefault(); setFolded(f, false); }
          if (e.key === 'ArrowLeft' && !folded) { e.preventDefault(); setFolded(f, true); }
        },
      },
        icon(f ? 'folder' : 'notes', 18),
        h('span', { class: 'folder-title', text: f ? f.title : 'All notes' }),
        h('span', { class: 'folder-count', text: N.status === 'ready' ? String(count) : '' })),
      f ? h('button', {
        class: 'icon-btn folder-menu', type: 'button', 'aria-label': `More actions: ${f.title}`, title: 'More actions',
        'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { key: `folder-menu:${id}` },
        onclick: e => openMenu(N.ctx.root, e.currentTarget, [
          { label: 'Rename', icon: 'edit', key: 'folder-rename', onSelect: () => startFolderEdit({ mode: 'rename', folderId: id }) },
          { label: 'New subfolder', icon: 'add', key: 'folder-sub', onSelect: () => startFolderEdit({ mode: 'new', parentId: id }) },
          { separator: true },
          {
            label: count || children ? 'Delete (empty it first)' : 'Delete', icon: 'delete', danger: true, key: 'folder-delete',
            disabled: !!(count || children), onSelect: () => removeFolder(f),
          },
        ], { label: `Actions for ${f.title}` }),
      }, icon('more', 18)) : null);
    // Through the style API, not a style attribute: a page's security
    // policy may refuse inline style attributes, never this.
    row.style.setProperty('--depth', String(f ? f.depth : 0));

    // Dropping a note here files it here; on "All notes", takes it out of
    // its folder.
    row.addEventListener('dragover', e => {
      if (!N.dragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', e => {
      if (!N.dragKey) return;
      e.preventDefault();
      row.classList.remove('drop');
      const note = N.notes.find(n => n.key === N.dragKey);
      N.dragKey = '';
      if (note) moveNote(note, id);
    });
    return row;
  }

  function editRow(depth, folder) {
    const edit = N.folderEdit;
    const input = h('input', {
      class: 'text-input folder-input', type: 'text', value: edit.value, maxlength: String(notesLogic.FOLDER_NAME_MAX),
      placeholder: edit.mode === 'new' ? 'Folder name, then Enter' : '', 'aria-label': edit.mode === 'new' ? 'New folder name' : `Rename ${folder.title}`,
      disabled: !!edit.busy, dataset: { key: 'folder-input' },
      oninput: e => { edit.value = e.target.value; },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); commitFolderEdit(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelFolderEdit(); }
      },
      onblur: () => { if (!edit.busy && N.folderEdit === edit) setTimeout(() => { if (N.folderEdit === edit && !edit.busy) cancelFolderEdit(); }, 150); },
    });
    const row = h('div', { class: 'folder-row editing' },
      h('div', { class: 'folder-edit' }, icon('folder', 18), input),
      edit.error ? h('div', { class: 'folder-error', role: 'alert', text: edit.error }) : null);
    row.style.setProperty('--depth', String(depth));
    return row;
  }

  function startFolderEdit({ mode, parentId = '', folderId = '' }) {
    const f = folderById(folderId);
    // A new subfolder's field shows inside its parent, so that has to be open.
    const parent = mode === 'new' ? folderById(parentId) : null;
    if (parent) unfold(parent, true);
    N.folderEdit = { mode, parentId, folderId, value: mode === 'rename' && f ? f.title : '', error: '', busy: false };
    drawFolders();
    const input = els.folderItems.querySelector('[data-key="folder-input"]');
    if (input) { input.focus(); input.select(); }
  }

  function cancelFolderEdit() {
    if (!N.folderEdit) return;
    N.folderEdit = null;
    drawFolders();
  }

  async function commitFolderEdit() {
    const edit = N.folderEdit;
    if (!edit || edit.busy) return;
    const target = edit.mode === 'rename' ? folderById(edit.folderId) : null;
    const parent = edit.mode === 'new' ? folderById(edit.parentId) : null;
    const parentPath = target ? target.parentPath : parent ? parent.path : '';
    const siblings = N.folders.filter(f => f.parentPath === parentPath && f !== target).map(f => f.title);
    const problem = notesLogic.validateFolderTitle(edit.value, siblings);
    if (edit.mode === 'rename' && target && edit.value.trim() === target.title) { cancelFolderEdit(); return; }
    if (problem) {
      edit.error = problem;
      drawFolders();
      const input = els.folderItems.querySelector('[data-key="folder-input"]');
      if (input) input.focus();
      return;
    }
    edit.busy = true;
    drawFolders();
    try {
      if (edit.mode === 'new') {
        const made = await notesStore.createFolder(parent, edit.value);
        N.folders = notesStore.folders();
        if (made) N.folder = made.id;
        toast(N.ctx.root, `Folder “${edit.value.trim()}” created.`);
      } else {
        await notesStore.renameFolder(target, edit.value);
        N.folders = notesStore.folders();
      }
      N.folderEdit = null;
    } catch (err) {
      edit.busy = false;
      edit.error = `Couldn’t save: ${err.message}`;
      if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);
    }
    drawFolders();
    drawList();
    if (N.current) drawBar();
  }

  async function removeFolder(f) {
    try {
      await notesStore.deleteFolder(f);
      N.folders = notesStore.folders();
      if (N.folder === f.id) N.folder = '';
      toast(N.ctx.root, `Folder “${f.title}” deleted.`);
    } catch (err) {
      const msg = err.code === 'not_allowed' ? 'Only an empty folder can be deleted. Move its notes out first.' : err.message;
      toast(N.ctx.root, `Couldn’t delete “${f.title}”: ${msg}`, { kind: 'error' });
    }
    drawFolders();
    drawList();
  }

  // Runs after any save in progress, so the move lands on the newest
  // version rather than one about to be replaced.
  function moveNote(note, folderId) {
    const c = N.current && N.current.note === note ? N.current : null;
    if ((note.folderId || '') === (folderId || '')) return N.chain;
    N.chain = N.chain.then(async () => {
      const latest = c ? c.note : note;
      const was = latest.folderId || '';
      latest.folderId = folderId;
      if (c) c.folderId = folderId;
      drawFolders();
      drawList();
      if (c) drawBar();
      try {
        await notesStore.move(latest, folderId);
        toast(N.ctx.root, folderId ? `Moved to ${folderLabel(folderId)}.` : 'Taken out of its folder.');
      } catch (err) {
        latest.folderId = was;
        if (c) c.folderId = was;
        toast(N.ctx.root, `Couldn’t move “${latest.title}”: ${err.message}`, { kind: 'error' });
        if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);
      }
      drawFolders();
      drawList();
      if (N.current === c && c) drawBar();
    });
    return N.chain;
  }

  // The folder button above the note: where it is, and where it can go.
  function chooseFolder(anchor) {
    const c = N.current;
    if (!c) return;
    openMenu(N.ctx.root, anchor, [
      { heading: 'Move to' },
      { label: 'No folder', key: 'move-folder:none', checked: !c.folderId, onSelect: () => setCurrentFolder('') },
      ...N.folders.map(f => ({
        label: `${'\u2003'.repeat(f.depth)}${f.title}`, key: `move-folder:${f.id}`, checked: c.folderId === f.id,
        onSelect: () => setCurrentFolder(f.id),
      })),
    ], { label: 'Folder' });
  }

  function setCurrentFolder(id) {
    const c = N.current;
    if (!c) return;
    // Not saved yet: the folder is simply where the first save puts it.
    if (!c.note) {
      c.folderId = id;
      drawBar();
      return;
    }
    moveNote(c.note, id);
  }

  function drawFoot() {
    if (!els.foot) return;
    els.foot.textContent = N.truncated
      ? 'Showing the 100 most recent. Search to find older ones.'
      : `Kept in Gmail under “${notesStore.labelName()}”`;
  }

  // ── The editor ───────────────────────────────────────────────────────

  function newCurrent(note) {
    return {
      key: note ? note.key : `new:${Date.now()}`,
      note,                          // null until first saved
      title: note && note.title !== 'Untitled note' ? note.title : '',
      doc: note ? null : fmt.emptyDoc(),   // formatted content, once loaded
      bodyState: note ? 'loading' : 'ready', // loading | ready | error
      dirty: false,
      saving: false,
      error: '',
      savedAt: 0,
      // A new note starts in the folder being looked at.
      folderId: note ? note.folderId || '' : N.folder,
    };
  }

  function newNote() {
    flush();
    N.current = newCurrent(null);
    drawList();
    drawEditor();
    focusField('note-title');
  }

  function openNote(note, { force = false } = {}) {
    if (!force && N.current && N.current.key === note.key) return;
    flush();
    const c = newCurrent(note);
    N.current = c;
    N.findIndex = 0;
    drawList();
    drawEditor();
    notesStore.body(note).then(doc => {
      if (N.current !== c) return;
      c.doc = doc;
      c.bodyState = 'ready';
      drawEditor();
      applyHighlights();
    }, err => {
      if (N.current !== c) return;
      c.bodyState = 'error';
      c.error = err.message;
      if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);
      else drawEditor();
    });
  }

  function focusField(key) {
    if (key === 'note-body' && els.ed) { els.ed.focus(); return; }
    const el = els.editor && els.editor.querySelector(`[data-key="${key}"]`);
    if (el) el.focus();
  }

  // Which pane a phone shows: the list, or the open note.
  function setView() {
    const view = N.current ? 'note' : 'list';
    if (els.wrap) els.wrap.dataset.view = view;
    if (view !== N.view) {
      N.view = view;
      if (N.ctx && N.ctx.onViewChange) N.ctx.onViewChange(view);
    }
  }

  // Back to the list, once whatever is pending is saved. A save that
  // failed keeps the note open, with its error showing, rather than
  // leaving the edits behind.
  async function closeNote() {
    const c = N.current;
    if (!c) return;
    await flush();
    if (N.current !== c) return;
    if (c.dirty) {
      toast(N.ctx.root, 'Not saved yet, so the note stays open. Try again in a moment.', { kind: 'error' });
      return;
    }
    N.current = null;
    drawEditor();
    drawList();
  }

  function drawEditor() {
    if (!els.editor) return;
    setView();
    const c = N.current;
    if (!c) {
      if (els.ed) { els.ed.destroy(); els.ed = null; }
      els.editor.replaceChildren(h('div', { class: 'notes-intro' },
        h('span', { class: 'panel-icon' }, icon('note', 28)),
        h('h2', { text: 'Notes, kept in Gmail' }),
        h('p', {
          text: `Each note is saved as a message under “${notesStore.labelName()}”, out of your Inbox. ` +
            'Gmail’s search finds it, your phone shows it, and every earlier version waits in Gmail’s Trash for 30 days.',
        }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'New note', dataset: { key: 'note-new-intro' }, onclick: () => newNote() })));
      return;
    }

    els.bar = h('div', { class: 'ne-bar' });
    els.bannerSlot = h('div', { class: 'ne-banner-slot' });
    const title = h('input', {
      class: 'ne-title', type: 'text', placeholder: 'Title', 'aria-label': 'Title',
      value: c.title, maxlength: String(notesLogic.MAX_TITLE), dataset: { key: 'note-title' },
      disabled: c.bodyState !== 'ready',
      oninput: e => edited(c, { title: e.target.value }),
      onkeydown: e => {
        // Enter in the title carries on into the body, as in most editors.
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); focusField('note-body'); }
      },
    });
    // A fresh editor per note: its undo history belongs to that note.
    if (els.ed) els.ed.destroy();
    const ed = ns.noteEditor.create({ root: N.ctx.root, onChange: () => edited(c, { doc: ed.getDoc() }) });
    els.ed = ed;
    ed.setDoc(c.doc || fmt.emptyDoc());
    ed.setEditable(c.bodyState === 'ready',
      c.bodyState === 'loading' ? 'Loading…' : c.bodyState === 'error' ? 'Couldn’t load this note.' : 'Write here…');

    els.findSlot = h('div', { class: 'ne-find-slot' });
    els.editor.replaceChildren(els.bar, els.bannerSlot, els.findSlot, title, ed.toolbar, ed.linkbar, ed.element);
    drawBar();
    drawFind();
  }

  // The strip above the text: status, buttons, and the banner for an
  // emailed note. Redrawn on its own after a save - the first save of a
  // new note gains an "Open in Gmail", an emailed one loses its banner -
  // without touching the text boxes the user may still be typing in.
  function drawBar() {
    const c = N.current;
    if (!c || !els.bar) return;
    const foreign = !!(c.note && !c.note.own);
    els.status = h('span', { class: 'ne-status', 'aria-live': 'polite' });
    els.bar.replaceChildren(
      h('button', {
        class: 'icon-btn ne-back', type: 'button', 'aria-label': 'Back to the list', title: 'Back to the list',
        dataset: { key: 'note-back' }, onclick: () => closeNote(),
      }, icon('back')),
      els.status,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'ne-folder', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        title: 'Move to another folder', dataset: { key: 'note-folder' },
        onclick: e => chooseFolder(e.currentTarget),
      }, icon('folder', 18), h('span', { text: c.folderId ? folderLabel(c.folderId) || 'No folder' : 'No folder' }), icon('caret', 18)),
      c.note ? h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Open in Gmail', title: 'Open in Gmail',
        dataset: { key: 'note-open' }, onclick: () => openInGmail(c),
      }, icon('open')) : null,
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': foreign ? 'Take off the notes list' : 'Delete note',
        title: foreign ? 'Take off the notes list (the email stays)' : 'Delete (moves it to Gmail’s Trash)',
        dataset: { key: 'note-delete' }, onclick: () => deleteCurrent(),
      }, icon('delete')));
    els.bannerSlot.replaceChildren(foreign ? h('div', {
      class: 'ne-banner',
      text: `This one is an email filed under “${notesStore.labelName()}”. Editing it saves a new note in its place; ` +
        'the email itself stays in Gmail, just off this list.',
    }) : '');
    drawStatus();
  }

  function drawStatus() {
    const c = N.current;
    if (!els.status || !c) return;
    let text;
    if (c.saving) text = 'Saving…';
    else if (c.error && c.bodyState === 'ready') text = `Couldn’t save: ${c.error}`;
    else if (c.dirty) text = 'Unsaved changes';
    else if (c.savedAt) text = `Saved ${util.agoText(Date.now() - c.savedAt)}`;
    else if (c.note) text = `Last saved ${util.relativeDate(c.note.updated)}`;
    else text = 'New note';
    els.status.textContent = text;
    els.status.classList.toggle('error', !!(c.error && !c.saving && c.bodyState === 'ready'));
    els.status.title = c.note ? util.fullDate(c.note.updated) : '';
  }

  // ── Saving ───────────────────────────────────────────────────────────

  function edited(c, change) {
    Object.assign(c, change);
    c.dirty = true;
    c.error = '';
    drawStatus();
    if (change.doc && N.terms.length) {
      clearTimeout(findTimer);
      findTimer = setTimeout(applyHighlights, 300);
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(c), AUTOSAVE_MS);
  }

  // Saves are chained: each one retires the version the previous one
  // wrote, so two in flight at once would each leave a stray behind.
  function save(c) {
    N.chain = N.chain.then(async () => {
      if (!c.dirty) return;
      // An untouched new note is not worth a message.
      if (!c.note && !c.title.trim() && fmt.isEmpty(c.doc)) { c.dirty = false; return; }
      const snap = { title: c.title, doc: c.doc, folderId: c.folderId };
      const before = c.note;
      c.dirty = false;
      c.saving = true;
      drawStatus();
      try {
        const saved = await notesStore.save(hooks.getAccount(), before, snap);
        const oldKey = c.key;
        const wasOurs = !!(before && before.own);
        c.note = saved;
        c.key = saved.key;
        c.savedAt = Date.now();
        c.error = '';
        N.notes = [saved, ...N.notes.filter(n => n.key !== oldKey && n.key !== saved.key)];
        if (!wasOurs && N.current === c) drawBar();
      } catch (err) {
        c.dirty = true;
        c.error = err.message;
        if (api.STATE_CODES.has(err.code)) N.ctx.onStateError(err);
      } finally {
        c.saving = false;
        if (N.current === c) drawStatus();
        drawList();
      }
    });
    return N.chain;
  }

  // Whatever is pending, now. Called on Ctrl+S, on switching notes or
  // tabs, and when the board closes.
  function flush() {
    clearTimeout(saveTimer);
    const c = N.current;
    return c && c.dirty ? save(c) : N.chain;
  }

  // ── Other actions ────────────────────────────────────────────────────

  async function openInGmail(c) {
    await flush();
    if (!c.note || !c.note.threadId) return;
    N.ctx.closeBoard();
    hooks.openThread(c.note.threadId);
  }

  async function deleteCurrent() {
    const c = N.current;
    if (!c) return;
    clearTimeout(saveTimer);
    await N.chain;
    N.current = null;
    drawEditor();
    const note = c.note;
    if (!note) { drawList(); return; } // never saved: nothing in Gmail

    const at = N.notes.findIndex(n => n.key === note.key);
    N.notes = N.notes.filter(n => n.key !== note.key);
    drawList();
    try {
      await notesStore.retire(note);
      toast(N.ctx.root, note.own
        ? 'Note moved to Gmail’s Trash.'
        : `Taken off the notes list. The email stays in Gmail.`, {
        action: { label: 'Undo', onClick: () => undoDelete(note, at) },
        timeout: 8000,
      });
    } catch (err) {
      N.notes.splice(Math.max(0, at), 0, note);
      drawList();
      toast(N.ctx.root, `Couldn’t delete “${note.title}”: ${err.message}`, { kind: 'error' });
    }
  }

  async function undoDelete(note, at) {
    try {
      await notesStore.restore(note);
      N.notes.splice(Math.max(0, Math.min(at, N.notes.length)), 0, note);
      drawList();
      openNote(note, { force: true });
    } catch (err) {
      toast(N.ctx.root, `Couldn’t bring it back: ${err.message}. It is still in Gmail’s Trash.`, { kind: 'error' });
    }
  }

  // Ctrl+S (⌘S) saves now instead of Chrome's "Save page as".
  function handleKey(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flush();
      return true;
    }
    if (e.key === 'F3' && N.terms.length && els.ed) {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  // Called every few seconds while the board is open, for "Saved 5s ago".
  function tick() {
    drawStatus();
  }

  function focusDefault() {
    if (N.current) focusField(N.current.bodyState === 'ready' && N.current.title ? 'note-body' : 'note-title');
    else if (els.search) els.search.focus();
  }

  ns.notes = {
    init, element, load, isStale, flush, handleKey, tick, focusDefault, closeNote,
    isOpen: () => !!N.current,
    loadedAt: () => N.loadedAt,
    isLoading: () => !!N.loading,
  };
})();

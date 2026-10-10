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
// The scratchpad is the note that is open whenever no other one is: one
// note with a fixed id, shared by every computer and phone, there to type
// into the moment the notes appear. It is pinned at the top of the list,
// and cannot be renamed, moved or deleted. The calendar's week, in two
// rows, shows it too, in a tile of its own (scratchTile): a second editor
// on the same state, saved and merged by this file.
//
// The phone app (addon/app) runs this same view full-screen on a phone,
// with a different way to Gmail behind notesStore. A phone shows one
// thing at a time, and the element says which (data-view): "home", the
// search box and the scratchpad; "list", the notes in a folder or a
// search; or "note", a note full-screen. The note's Back button and the
// folder tree's button only show in the phone's stylesheet.
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

  const SCRATCH_KEY = `n:${notesLogic.SCRATCHPAD_ID}`;

  const N = {
    ctx: null,          // { root, onStateError, onLoaded, closeBoard, barChanged }
    notes: [],          // live notes, newest first (metadata only)
    truncated: false,
    query: '',
    status: 'idle',     // idle | loading | ready | error
    error: '',
    loadedAt: 0,
    loading: null,
    current: null,      // the note being edited - see newCurrent(); the scratchpad when no other is
    scratch: null,      // the scratchpad being edited, here or in the calendar's tile, open here or not
    scratchNote: null,  // the scratchpad's message, once listed (null: never saved yet)
    scratchKnown: false, // whether the listing has said if there is one
    browsing: false,    // a phone: the list is showing, rather than the scratchpad
    wantFocus: false,   // put the cursor in the scratchpad once it is ready
    chain: Promise.resolve(), // saves and moves run one after another
    folders: [],        // notesLogic.folderTree(), from the last listing
    folder: '',         // the folder shown; '' for all notes
    folderEdit: null,   // { mode: 'new' | 'rename', parentId, folderId, value, error, busy }
    folded: new Set(),  // folders whose subfolders are folded away
    foldedRead: false,  // the saved set (and `contents`) has been asked for
    contents: false,    // the note's headings shown beside it (the toolbar's Contents)
    panes: new Set(),   // on a computer, the columns folded to a rail: 'folders', 'list'
    dragKey: '',        // the note being dragged onto a folder
    terms: [],          // searchLogic.queryTerms() of the search that is showing
    hits: new Map(),    // `${messageId}|${terms}` → { count, excerpts }
    findIndex: 0,       // which match in the open note is the current one
  };

  let searchTimer = 0;
  let findTimer = 0;
  const els = {};
  // The calendar's scratchpad tile: its element, editor and status line,
  // the state it shows, and whether the notes' editor changed that since.
  const T = { el: null, body: null, status: null, ed: null, for: null, stale: false };

  // ── Setup ────────────────────────────────────────────────────────────

  function init(ctx) {
    N.ctx = ctx;
    N.view = '';
    // Closing the tab mid-sentence would lose the last few seconds of
    // typing; the browser's own "Leave site?" prompt is the only defence.
    window.addEventListener('beforeunload', e => {
      if ([N.current, N.scratch].some(c => c && (c.dirty || c.saving))) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // Account trouble goes to the board, which shows its panel in place of
  // the notes - but only while the notes are showing. The calendar works
  // without Gmail, and its scratchpad tile says what went wrong itself.
  function stateError(err) {
    if (els.wrap && els.wrap.isConnected) N.ctx.onStateError(err);
  }

  function element() {
    if (els.wrap) {
      // The scratchpad was typed into in the calendar's tile meanwhile.
      if (els.edStale) drawEditor();
      return els.wrap;
    }

    els.search = h('input', {
      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes',
      dataset: { key: 'notes-search' },
      oninput: e => {
        N.query = e.target.value;
        // On a phone, a search shows the list in place of the scratchpad.
        if (N.query.trim() && !N.browsing) { N.browsing = true; setView(); }
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
        }, icon('add', 18), 'New'),
        foldButton('list', 'Hide the list of notes')),
      els.scope,
      els.items,
      els.foot,
      listRail());

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
        }, icon('add', 20)),
        foldButton('folders', 'Hide the folders')),
      els.folderItems,
      h('div', { class: 'pane-rail' },
        h('button', {
          class: 'rail-open', type: 'button', title: 'Show the folders', 'aria-label': 'Show the folders',
          dataset: { key: 'unfold-folders' }, onclick: () => foldPane('folders', false),
        }, icon('paneOpen', 20), icon('folder', 20), h('span', { class: 'rail-label', text: 'Folders' }))));

    els.editor = h('section', { class: 'note-editor', 'aria-label': 'Note' });
    els.wrap = h('div', { class: 'notes', dataset: { folders: 'closed' } }, els.foldersPane, els.list, els.editor);
    drawPanes();
    if (!N.current) N.current = scratchState();
    drawFolders();
    drawList();
    drawEditor();
    // Text typed last time and not saved before the page went.
    const c = N.current;
    if (c && c.dirty) laterSave(c);
    return els.wrap;
  }

  // The scratchpad's state, made the first time anything wants it: from
  // the phone app's copy if there is one, or waiting for the list.
  function scratchState() {
    if (!N.scratch && !fromCopy()) pendingScratch();
    return N.scratch;
  }

  // The phone app's own copy (notesStore.cached): the list and the
  // scratchpad as they were when it last heard from Gmail, and any text
  // typed and not yet saved. The scratchpad takes typing at once; Gmail's
  // answer catches up with it after (catchUpCurrent, adoptNewer).
  function fromCopy() {
    const copy = notesStore.cached ? notesStore.cached() : null;
    if (!copy) return null;
    if (copy.notes) {
      N.notes = copy.notes;
      N.truncated = !!copy.truncated;
      N.folders = copy.folders || [];
      N.status = 'ready';
      N.loadedAt = 0; // still to be asked for
    }
    if (copy.scratch) {
      N.scratchNote = copy.scratch.note || null;
      N.scratchKnown = true;
    }
    const from = copy.draft || copy.scratch;
    if (!from) return null;
    const c = scratchCurrent(from.note || null);
    c.base = copy.draft ? copy.draft.base || fmt.emptyDoc() : from.doc || fmt.emptyDoc();
    c.doc = from.doc || fmt.emptyDoc();
    c.bodyState = 'ready';
    c.dirty = !!copy.draft;
    return c;
  }

  // What the phone app's first call found the scratchpad to be: in Gmail
  // already, perhaps newer than the copy it opened with.
  function scratchFound(note) {
    if (!note || !isNewer(note, N.scratchNote)) return;
    N.scratchNote = note;
    N.scratchKnown = true;
    catchUpCurrent();
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
        let scratch = r.notes.find(n => n.key === SCRATCH_KEY) || null;
        // Not among the newest hundred: ask Gmail for it by name, rather
        // than start a second one that would push the first into Trash.
        if (!scratch && !query && r.truncated) {
          const found = await notesStore.list(hooks.getAccount(), notesLogic.SCRATCHPAD_TITLE);
          scratch = found.notes.find(n => n.key === SCRATCH_KEY) || null;
          if (query !== N.query) return;
        }
        if (scratch || !query) {
          N.scratchNote = scratch;
          N.scratchKnown = true;
        }
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
        readyScratch();
        N.ctx.onLoaded();
      } catch (err) {
        const s = N.scratch;
        // The scratchpad was waiting for this list to say whether it exists.
        if (s && s.bodyState === 'loading' && !N.scratchKnown) {
          s.bodyState = 'error';
          s.error = err.message;
          if (s === N.current) drawEditor();
          drawTile();
        }
        if (api.STATE_CODES.has(err.code)) {
          N.status = 'idle';
          stateError(err);
          return;
        }
        N.status = N.notes.length ? 'ready' : 'error';
        N.error = err.message;
        if (N.notes.length && els.wrap && els.wrap.isConnected) toast(N.ctx.root, `Couldn’t load notes: ${err.message}`, { kind: 'error' });
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

  // Whether `fresh` is a later version than the one `note` is (or than
  // none at all). Gmail's own date for each message decides.
  const isNewer = (fresh, note) => !!fresh && (!note || (fresh.messageId !== note.messageId && fresh.updated > note.updated));

  // The open note was saved on another computer or phone since it was
  // opened here (or, for the scratchpad, started there): the newer text,
  // merged with whatever was typed here meanwhile. The scratchpad catches
  // up as well when another note is open, for the calendar's tile.
  function catchUpCurrent() {
    for (const c of new Set([N.current, N.scratch])) {
      if (!c) continue;
      const fresh = c.scratch ? N.scratchNote : c.note ? N.notes.find(n => n.key === c.key) : null;
      if (!isNewer(fresh, c.note)) continue;
      if (c.bodyState === 'ready') adoptNewer(c, fresh);
      else if (!c.dirty && !c.saving) {
        if (c === N.current) openNote(fresh, { force: true });
        else loadBody(scratchCurrent(fresh));
      }
    }
  }

  // Once the list has said whether there is a scratchpad: the one waiting
  // for that is shown, here or in the tile - its text read, or empty if
  // there is none yet.
  function readyScratch() {
    const s = N.scratch;
    if (!s || !N.scratchKnown) return;
    if (s === N.current) {
      if (s.bodyState !== 'ready') showScratch();
      return;
    }
    if (s.bodyState === 'ready' || (s.bodyState === 'loading' && s.note)) return; // ready, or being read
    if (N.scratchNote) loadBody(scratchCurrent(N.scratchNote));
    else {
      scratchCurrent(null);
      drawTile();
    }
  }

  // A newer version of a note being edited, taken in place: the edits
  // made here since `c.base` merged into it (noteFormat.mergeDocs), in
  // the same text box, so the cursor and a phone's keyboard stay put. It
  // waits for a save in flight, and the merged text is saved in turn.
  function adoptNewer(c, fresh) {
    N.chain = N.chain.then(async () => {
      if (!isNewer(fresh, c.note)) return;
      let theirs;
      try {
        theirs = await notesStore.body(fresh);
      } catch (err) {
        return; // the next listing tries again
      }
      if (!isNewer(fresh, c.note)) return;
      const base = c.base || fmt.emptyDoc();
      const mine = c.doc || base;
      const typed = c.dirty && !fmt.sameDoc(mine, base);
      const titled = !c.scratch && c.dirty && c.title !== c.baseTitle;
      const merged = typed ? fmt.mergeDocs(base, mine, theirs) : { doc: theirs, map: null };
      c.note = fresh;
      c.key = fresh.key;
      c.base = theirs;
      c.baseTitle = fresh.title;
      c.doc = merged.doc;
      c.savedAt = 0;
      c.error = '';
      if (!titled && !c.scratch) c.title = fresh.title !== 'Untitled note' ? fresh.title : '';
      if (!c.scratch) c.folderId = fresh.folderId || '';
      c.dirty = (typed && !fmt.sameDoc(merged.doc, theirs)) || titled;
      if (c.scratch) { N.scratchNote = fresh; N.scratchKnown = true; }
      if (N.current === c && els.ed) {
        els.ed.replaceDoc(merged.doc, merged.map);
        const input = els.editor.querySelector('[data-key="note-title"]');
        if (input && input.value !== c.title && N.ctx.root.activeElement !== input) input.value = c.title;
        applyHighlights();
      }
      if (T.ed && T.for === c) T.ed.replaceDoc(merged.doc, merged.map);
      if (typed) toast(N.ctx.root, 'Also changed on another device in the meantime: both changes are kept.');
      keepDraft(c);
      if (c.dirty) laterSave(c);
      if (N.current === c) drawBar();
      drawStatus();
      drawList();
    });
    return N.chain;
  }

  // A phone app keeps the scratchpad's unsaved text on the phone, so that
  // a page the phone closes mid-sentence loses nothing (notesStore.keepDraft).
  let draftTimer = 0;
  function keepDraft(c) {
    if (!c.scratch || !notesStore.keepDraft) return;
    clearTimeout(draftTimer);
    notesStore.keepDraft(c.dirty ? { note: c.note, base: c.base, doc: c.doc } : null);
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
      // Folded, the list's rail still says where you are.
      if (els.listLabel) els.listLabel.textContent = els.scope.textContent;
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
    // The scratchpad first: in "All notes", always, saved yet or not;
    // elsewhere, where it is listed (a search that finds it).
    const scratch = shown.find(n => n.key === SCRATCH_KEY) || (!N.folder && !searching && N.scratchKnown && !N.scratchNote ? 'new' : null);
    const rest = shown.filter(n => n.key !== SCRATCH_KEY);
    const pinned = scratch ? [scratchItem(scratch === 'new' ? null : scratch, curKey)] : [];
    if (!rest.length) {
      let text = searching ? 'No notes match.' : 'No notes yet.';
      if (N.folder) text = searching ? 'No notes in this folder match.' : 'No notes in this folder yet.';
      els.items.replaceChildren(...pinned, h('div', { class: 'notes-empty', text }));
      return;
    }

    els.items.replaceChildren(...pinned, ...rest.map(n => {
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

  // The scratchpad's entry: pinned, not draggable, and on a phone it goes
  // back to the scratchpad rather than opening it full-screen.
  function scratchItem(n, curKey) {
    return h('button', {
      class: 'note-item scratch-item', type: 'button', role: 'listitem',
      'aria-current': curKey === SCRATCH_KEY ? 'true' : null,
      dataset: { key: 'note:scratchpad', note: SCRATCH_KEY },
      onclick: () => {
        N.browsing = false;
        if (n) openNote(n);
        else showScratch();
        setView();
      },
    },
      h('span', { class: 'ni-top' },
        h('span', { class: 'ni-title' }, icon('edit', 16), h('span', {}, marked(notesLogic.SCRATCHPAD_TITLE))),
        n ? h('span', { class: 'date', text: util.relativeDate(n.updated), title: util.fullDate(n.updated) }) : null),
      n ? itemPreview(n) : h('span', { class: 'ni-snippet', text: 'Empty – write something down' }),
      n ? h('span', { class: 'ni-meta' }, hitCount(n)) : null);
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
    try {
      N.contents = (await prefs.get('noteContents')) === true;
      if (els.ed) els.ed.setContentsShown(N.contents);
    } catch (err) { /* no contents, as at first */ }
    try {
      const panes = await prefs.get('notePanes');
      if (Array.isArray(panes)) N.panes = new Set(panes.filter(p => p === 'folders' || p === 'list'));
      drawPanes();
    } catch (err) { /* every column shown, as at first */ }
  }

  // ── Room for the note ────────────────────────────────────────────────
  //
  // On a computer, the folders and the list of notes each fold to a slim
  // rail and back, for more room for the note: the rail says what is
  // folded there (the list's, which folder and how many notes), and opens
  // it again with a click; the list's also has New and Search. Remembered
  // on this computer, as the folded folders are. A phone shows one thing
  // at a time anyway: its stylesheet shows neither the buttons nor the
  // rails.

  function foldButton(pane, label) {
    return h('button', {
      class: 'icon-btn pane-fold', type: 'button', title: label, 'aria-label': label, 'aria-expanded': 'true',
      dataset: { key: `fold-${pane}` }, onclick: () => foldPane(pane, true),
    }, icon('paneClose', 20));
  }

  function listRail() {
    els.listLabel = h('span', { class: 'rail-label' });
    return h('div', { class: 'pane-rail' },
      h('button', {
        class: 'icon-btn', type: 'button', title: 'New note', 'aria-label': 'New note',
        dataset: { key: 'rail-new' }, onclick: () => newNote(),
      }, icon('add', 20)),
      h('button', {
        class: 'icon-btn', type: 'button', title: 'Search notes', 'aria-label': 'Search notes',
        dataset: { key: 'rail-search' }, onclick: () => { foldPane('list', false); els.search.focus(); },
      }, icon('search', 20)),
      h('button', {
        class: 'rail-open', type: 'button', title: 'Show the list of notes', 'aria-label': 'Show the list of notes',
        dataset: { key: 'unfold-list' }, onclick: () => foldPane('list', false),
      }, icon('paneOpen', 20), els.listLabel));
  }

  function drawPanes() {
    if (!els.wrap) return;
    for (const pane of ['folders', 'list']) {
      const folded = N.panes.has(pane);
      els.wrap.classList.toggle(`fold-${pane}`, folded);
      const btn = els.wrap.querySelector(`[data-key="fold-${pane}"]`);
      if (btn) btn.setAttribute('aria-expanded', String(!folded));
    }
  }

  function foldPane(pane, folded) {
    if (folded) N.panes.add(pane);
    else N.panes.delete(pane);
    drawPanes();
    // The button pressed has gone: the focus goes to the one that undoes it.
    const undo = els.wrap && els.wrap.querySelector(`[data-key="${folded ? 'unfold' : 'fold'}-${pane}"]`);
    if (undo) undo.focus();
    const prefs = N.ctx && N.ctx.prefs;
    if (!prefs) return;
    try {
      Promise.resolve(prefs.set('notePanes', [...N.panes])).catch(() => {});
    } catch (err) { /* not remembered, that is all */ }
  }

  // The toolbar's Contents, shown or not, remembered as the folded folders are.
  function saveContents(on) {
    N.contents = on;
    const prefs = N.ctx && N.ctx.prefs;
    if (!prefs) return;
    try {
      Promise.resolve(prefs.set('noteContents', on)).catch(() => {});
    } catch (err) { /* not remembered, that is all */ }
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
    // On a phone, choosing a folder - "All notes" too - shows its list.
    if (!N.browsing) { N.browsing = true; setView(); }
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
      // The version the edits here started from, for a merge.
      base: note ? null : fmt.emptyDoc(),
      baseTitle: note ? note.title : '',
    };
  }

  // The scratchpad, as the note being edited: its saved message, or null
  // when there is none yet. It keeps its name and stays out of folders.
  // There is one at a time: the newest made is N.scratch.
  function scratchCurrent(note) {
    N.scratch = Object.assign(newCurrent(note), {
      scratch: true, key: SCRATCH_KEY, title: notesLogic.SCRATCHPAD_TITLE, folderId: '',
    });
    return N.scratch;
  }

  // Before the list is in, nobody knows yet whether there is one.
  function pendingScratch() {
    return Object.assign(scratchCurrent(null), { doc: null, bodyState: 'loading' });
  }

  // Whenever no other note is open: the scratchpad - as it is, if it has
  // been read already (the calendar's tile may have edits in it), caught
  // up if there is a newer version.
  function showScratch() {
    const c = N.current;
    if (c && c.scratch && c.bodyState === 'ready') return;
    const s = N.scratch;
    if (s && s.bodyState === 'ready') {
      flush();
      N.current = s;
      N.findIndex = 0;
      drawList();
      drawEditor();
      applyHighlights();
      scratchReady();
      catchUpCurrent();
      return;
    }
    if (N.scratchNote) { openNote(N.scratchNote, { force: true }); return; }
    flush();
    N.current = N.scratchKnown ? scratchCurrent(null) : pendingScratch();
    drawList();
    drawEditor();
    scratchReady();
  }

  // The cursor goes into the scratchpad once it can take typing, if it
  // was asked for before then.
  function scratchReady() {
    const c = N.current;
    if (!N.wantFocus || !c || !c.scratch || c.bodyState !== 'ready') return;
    N.wantFocus = false;
    focusField('note-body');
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
    if (note.key === SCRATCH_KEY && N.scratch && N.scratch.bodyState === 'ready' && N.current !== N.scratch) {
      showScratch();
      return;
    }
    flush();
    const c = note.key === SCRATCH_KEY ? scratchCurrent(note) : newCurrent(note);
    N.current = c;
    N.findIndex = 0;
    drawList();
    drawEditor();
    loadBody(c);
  }

  // A note's text, read from Gmail. The scratchpad's goes to the
  // calendar's tile as well, whether or not it is open here.
  function loadBody(c) {
    const wanted = () => N.current === c || N.scratch === c;
    notesStore.body(c.note).then(doc => {
      if (!wanted()) return;
      c.doc = doc;
      c.base = doc;
      c.bodyState = 'ready';
      if (N.current === c) {
        drawEditor();
        applyHighlights();
        scratchReady();
      }
      if (N.scratch === c) drawTile();
    }, err => {
      if (!wanted()) return;
      c.bodyState = 'error';
      c.error = err.message;
      if (api.STATE_CODES.has(err.code)) stateError(err);
      if (N.current === c) drawEditor();
      if (N.scratch === c) drawTile();
    });
  }

  function focusField(key) {
    if (key === 'note-body' && els.ed) { els.ed.focus(); return; }
    const el = els.editor && els.editor.querySelector(`[data-key="${key}"]`);
    if (el) el.focus();
  }

  // What a phone shows: the scratchpad, the list, or a note.
  function setView() {
    const view = N.current && !N.current.scratch ? 'note' : N.browsing ? 'list' : 'home';
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
    if (!c || c.scratch) return;
    await flush();
    if (N.current !== c) return;
    if (c.dirty) {
      toast(N.ctx.root, 'Not saved yet, so the note stays open. Try again in a moment.', { kind: 'error' });
      return;
    }
    showScratch();
  }

  // A phone's Back: a note back to where it was opened from, and the list
  // back to the scratchpad, with the search and the folder cleared.
  async function back() {
    if (N.current && !N.current.scratch) return closeNote();
    if (!N.browsing) return;
    N.browsing = false;
    setFoldersOpen(false);
    if (N.folder) { N.folder = ''; drawFolders(); drawList(); }
    if (N.query) clearSearch();
    setView();
  }

  // How far from the scratchpad: 0 there, 1 in the list or a note opened
  // from the scratchpad, 2 in a note opened from the list.
  function depth() {
    const inNote = !!(N.current && !N.current.scratch);
    return (N.browsing ? 1 : 0) + (inNote ? 1 : 0);
  }

  function drawEditor() {
    if (!els.editor) return;
    setView();
    const c = N.current;
    if (!c) return;
    els.editor.classList.toggle('scratch', !!c.scratch);

    els.bar = h('div', { class: 'ne-bar' });
    els.bannerSlot = h('div', { class: 'ne-banner-slot' });
    const title = c.scratch ? h('h2', { class: 'ne-title scratch-title', dataset: { key: 'scratch-title' } },
      icon('edit', 22), h('span', { class: 'st-name', text: notesLogic.SCRATCHPAD_TITLE })) : h('input', {
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
    const ed = ns.noteEditor.create({
      root: N.ctx.root,
      onChange: () => {
        edited(c, { doc: ed.getDoc() });
        if (c === N.scratch) T.stale = true;
      },
      contents: { shown: N.contents, onToggle: saveContents },
    });
    els.ed = ed;
    els.edStale = false;
    ed.setDoc(c.doc || fmt.emptyDoc());
    ed.setEditable(c.bodyState === 'ready',
      c.bodyState === 'loading' ? 'Loading…' : c.bodyState === 'error' ? 'Couldn’t load this note.'
        : c.scratch ? `Jot anything down. It saves as you type, as a note in Gmail under “${notesStore.labelName()}”.` : 'Write here…');

    els.findSlot = h('div', { class: 'ne-find-slot' });
    els.editor.replaceChildren(els.bar, els.bannerSlot, els.findSlot, title, ed.toolbar, ed.linkbar, ed.tablebar,
      h('div', { class: 'ne-main' }, ed.element, ed.outline));
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
    // The scratchpad's status sits on its title line: there is nothing
    // else for a bar to hold.
    if (c.scratch) {
      els.bar.replaceChildren();
      els.bannerSlot.replaceChildren('');
      const line = els.editor.querySelector('.scratch-title');
      const old = line && line.querySelector('.ne-status');
      if (old) old.replaceWith(els.status);
      else if (line) line.append(els.status);
      drawStatus();
      return;
    }
    // (replaceChildren would show a null as the word "null": the missing
    // buttons are left out instead.)
    els.bar.replaceChildren(...[
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
      }, icon('delete'))].filter(Boolean));
    els.bannerSlot.replaceChildren(foreign ? h('div', {
      class: 'ne-banner',
      text: `This one is an email filed under “${notesStore.labelName()}”. Editing it saves a new note in its place; ` +
        'the email itself stays in Gmail, just off this list.',
    }) : '');
    drawStatus();
  }

  // The status line above the open note, and the one in the calendar's
  // scratchpad tile.
  function drawStatus() {
    if (els.status && N.current) statusInto(els.status, N.current);
    if (T.status && N.scratch) statusInto(T.status, N.scratch);
  }

  function statusInto(el, c) {
    let text;
    if (c.saving) text = 'Saving…';
    else if (c.error && c.bodyState === 'ready') text = `Couldn’t save: ${c.error}`;
    else if (c.dirty) text = 'Unsaved changes';
    else if (c.savedAt) text = `Saved ${util.agoText(Date.now() - c.savedAt)}`;
    else if (c.note) text = `Last saved ${util.relativeDate(c.note.updated)}`;
    else text = c.scratch ? '' : 'New note';
    el.textContent = text;
    el.classList.toggle('error', !!(c.error && !c.saving && c.bodyState === 'ready'));
    el.title = c.note ? util.fullDate(c.note.updated) : '';
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
    laterSave(c);
    if (c.scratch && notesStore.keepDraft) {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => keepDraft(c), 300);
    }
  }

  // A save a moment after the typing stops. Each note keeps its own timer:
  // the scratchpad, typed into in the calendar's tile, must not put off
  // the save of the note open here, or the other way round.
  function laterSave(c) {
    clearTimeout(c.timer);
    c.timer = setTimeout(() => save(c), AUTOSAVE_MS);
  }

  // Saves are chained: each one retires the version the previous one
  // wrote, so two in flight at once would each leave a stray behind.
  function save(c) {
    N.chain = N.chain.then(async () => {
      if (!c.dirty) return;
      // An untouched new note is not worth a message.
      if (!c.note && (c.scratch || !c.title.trim()) && fmt.isEmpty(c.doc)) { c.dirty = false; return; }
      const snap = { title: c.title, doc: c.doc, folderId: c.folderId, noteId: c.scratch ? notesLogic.SCRATCHPAD_ID : '' };
      // A scratchpad started here while another computer started one too.
      // Where the store checks for newer versions (the phone app), it says
      // so and the two are merged; otherwise the other's version is
      // retired, as any older version is.
      const before = c.note || (c.scratch && !notesStore.checksConflicts ? N.scratchNote : null);
      c.dirty = false;
      c.saving = true;
      drawStatus();
      let newer = null;
      try {
        const saved = await notesStore.save(hooks.getAccount(), before, snap);
        const oldKey = c.key;
        const wasOurs = !!(before && before.own);
        c.note = saved;
        c.key = saved.key;
        c.base = snap.doc;
        c.baseTitle = snap.title;
        c.savedAt = Date.now();
        c.conflicts = 0;
        if (c.scratch) { N.scratchNote = saved; N.scratchKnown = true; }
        c.error = '';
        N.notes = [saved, ...N.notes.filter(n => n.key !== oldKey && n.key !== saved.key)];
        // A first save is one more note: the counts by the folders change.
        if (!before) drawFolders();
        if (!wasOurs && N.current === c) drawBar();
        if (!c.dirty) keepDraft(c);
      } catch (err) {
        c.dirty = true;
        // Saved on another device since: merged, then saved again - unless
        // it keeps happening, which needs a person to look.
        if (err.code === 'conflict' && err.newer && (c.conflicts = (c.conflicts || 0) + 1) <= 3) newer = err.newer;
        else c.error = err.code === 'conflict' ? 'It keeps changing on another device. Try again in a moment.' : err.message;
        if (api.STATE_CODES.has(err.code)) stateError(err);
      } finally {
        c.saving = false;
        if (N.current === c || N.scratch === c) drawStatus();
        drawList();
      }
      if (newer) adoptNewer(c, newer);
    });
    return N.chain;
  }

  // Whatever is pending, now - in the open note and in the scratchpad,
  // which the calendar's tile may have changed. Called on Ctrl+S, on
  // switching notes or tabs, and when the board closes.
  function flush() {
    for (const c of new Set([N.current, N.scratch])) {
      if (!c) continue;
      clearTimeout(c.timer);
      if (c.dirty) save(c);
    }
    return N.chain;
  }

  // ── The calendar's scratchpad tile ───────────────────────────────────
  //
  // The eighth space in the calendar's week of two rows. The scratchpad
  // in an editor with no toolbar - its keys and typed lists still work -
  // editing N.scratch, so the saving, merging and drafts are the ones
  // above. The tile and the notes are never on screen together, so each
  // takes up what the other changed when it is shown (T.stale,
  // els.edStale). Built once and kept, like the notes' element: the
  // calendar moves it into each week it draws without rebuilding it, so
  // a redraw never takes the text box from under someone typing.

  function scratchTile() {
    if (!T.el) {
      T.status = h('span', { class: 'ne-status' });
      T.body = h('div', { class: 'scratch-tile-body' });
      T.el = h('section', {
        class: 'day scratch-tile', role: 'listitem', 'aria-label': notesLogic.SCRATCHPAD_TITLE,
        // Ctrl+S saves here too, rather than Chrome's "Save page as".
        onkeydown: e => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            flush();
          }
        },
      },
      h('header', { class: 'day-head' },
        icon('edit', 16), h('span', { class: 'dname', text: notesLogic.SCRATCHPAD_TITLE }), T.status),
      T.body);
    }
    scratchState();
    load(); // only if the list is more than a minute old: newer versions from elsewhere
    readyScratch();
    if (T.for !== N.scratch || T.stale || !T.ed) drawTile();
    drawStatus();
    return T.el;
  }

  function drawTile() {
    const s = N.scratch;
    if (!T.el || !s) return;
    if (T.ed) T.ed.destroy();
    const ed = ns.noteEditor.create({
      root: N.ctx.root,
      onChange: () => {
        edited(s, { doc: ed.getDoc() });
        if (s === N.current) els.edStale = true;
      },
    });
    T.ed = ed;
    T.for = s;
    T.stale = false;
    ed.setDoc(s.doc || fmt.emptyDoc());
    ed.setEditable(s.bodyState === 'ready',
      s.bodyState === 'loading' ? 'Loading…' : s.bodyState === 'error' ? `Couldn’t load the scratchpad: ${s.error}`
        : 'Jot anything down. It saves as you type.');
    T.body.replaceChildren(ed.linkbar, ed.tablebar, ed.element);
    drawStatus();
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
    if (!c || c.scratch) return;
    clearTimeout(c.timer);
    await N.chain;
    N.current = null;
    showScratch();
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

  // Typing goes straight into the scratchpad - or, with another note
  // open, into that.
  function focusDefault() {
    const c = N.current;
    if (c && c.scratch) {
      N.wantFocus = true;
      scratchReady();
    } else if (c) focusField(c.bodyState === 'ready' && c.title ? 'note-body' : 'note-title');
    else if (els.search) els.search.focus();
  }

  ns.notes = {
    init, element, load, isStale, flush, handleKey, tick, focusDefault, closeNote, back, depth, scratchFound, scratchTile,
    // A note other than the scratchpad.
    isOpen: () => !!(N.current && !N.current.scratch),
    loadedAt: () => N.loadedAt,
    isLoading: () => !!N.loading,
  };
})();

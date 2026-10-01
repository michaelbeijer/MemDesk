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
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, toast, openMenu } = ns.ui;
  const { util, notesLogic, notesStore, hooks, api } = ns;
  const fmt = ns.noteFormat;

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
    dragKey: '',        // the note being dragged onto a folder
  };

  let saveTimer = 0;
  let searchTimer = 0;
  const els = {};

  // ── Setup ────────────────────────────────────────────────────────────

  function init(ctx) {
    N.ctx = ctx;
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
    els.foldersPane = h('section', { class: 'notes-folders', 'aria-label': 'Folders' },
      h('div', { class: 'folders-head' },
        h('h2', { text: 'Folders' }),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'New folder', 'aria-label': 'New folder',
          dataset: { key: 'folder-new' }, onclick: () => startFolderEdit({ mode: 'new', parentId: '' }),
        }, icon('add', 20))),
      els.folderItems);

    els.editor = h('section', { class: 'note-editor', 'aria-label': 'Note' });
    els.wrap = h('div', { class: 'notes' }, els.foldersPane, els.list, els.editor);
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
        const r = await notesStore.list(hooks.getAccount(), query);
        if (query !== N.query) return; // a newer search has started
        N.notes = r.notes;
        N.truncated = r.truncated;
        N.folders = r.folders || [];
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
          h('span', { class: 'ni-title', text: n.title }),
          h('span', { class: 'date', text: util.relativeDate(n.updated), title: util.fullDate(n.updated) })),
        n.snippet ? h('span', { class: 'ni-snippet', text: n.snippet }) : null,
        h('span', { class: 'ni-meta' },
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

  // ── Folders ──────────────────────────────────────────────────────────

  function counts() {
    const out = new Map();
    for (const n of N.notes) out.set(n.folderId || '', (out.get(n.folderId || '') || 0) + 1);
    return out;
  }

  function selectFolder(id) {
    if (N.folder === id) return;
    N.folder = id;
    drawFolders();
    drawList();
  }

  function drawFolders() {
    if (!els.folderItems) return;
    const tally = counts();
    const rows = [folderRow(null, N.notes.length)];
    const edit = N.folderEdit;
    if (edit && edit.mode === 'new' && !edit.parentId) rows.push(editRow(0));
    N.folders.forEach((f, i) => {
      rows.push(edit && edit.mode === 'rename' && edit.folderId === f.id ? editRow(f.depth, f) : folderRow(f, tally.get(f.id) || 0));
      // A new subfolder's field goes after the whole branch it joins.
      const next = N.folders[i + 1];
      const branchEnds = !next || !next.name.startsWith(`${f.name}/`);
      if (edit && edit.mode === 'new' && edit.parentId) {
        const parent = folderById(edit.parentId);
        if (parent && (f.id === parent.id || f.name.startsWith(`${parent.name}/`)) && branchEnds) rows.push(editRow(parent.depth + 1));
      }
    });
    els.folderItems.replaceChildren(...rows);
  }

  function folderRow(f, count) {
    const id = f ? f.id : '';
    const children = f ? N.folders.some(x => x.name.startsWith(`${f.name}/`)) : false;
    const row = h('div', {
      class: 'folder-row', role: 'listitem', dataset: { folder: id || 'all' },
    },
      h('button', {
        class: 'folder-btn', type: 'button', 'aria-current': N.folder === id ? 'true' : null,
        dataset: { key: `folder:${id || 'all'}` }, title: f ? f.name : 'Every note, in any folder',
        onclick: () => selectFolder(id),
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
    drawList();
    drawEditor();
    notesStore.body(note).then(doc => {
      if (N.current !== c) return;
      c.doc = doc;
      c.bodyState = 'ready';
      drawEditor();
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

  function drawEditor() {
    if (!els.editor) return;
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

    els.editor.replaceChildren(els.bar, els.bannerSlot, title, ed.toolbar, ed.linkbar, ed.element);
    drawBar();
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
    init, element, load, isStale, flush, handleKey, tick, focusDefault,
    loadedAt: () => N.loadedAt,
    isLoading: () => !!N.loading,
  };
})();

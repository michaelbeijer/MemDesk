// ─────────────────────────────────────────────────────────────────────
// The notes view
//
// The board's second tab: a list of notes on the left, the open note on
// the right. Typing saves by itself a moment after you stop, and again on
// switching notes, switching tabs or closing; Ctrl+S saves at once.
//
// The board owns the overlay, the header and the account panels (setup,
// connect); this file owns everything inside the body while the Notes tab
// is showing. Its element is built once and kept, so that a board redraw
// never pulls the text box out from under someone who is typing.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, toast } = ns.ui;
  const { util, notesLogic, notesStore, hooks, api } = ns;

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
    chain: Promise.resolve(), // saves run one after another
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

    els.list = h('section', { class: 'notes-list', 'aria-label': 'All notes' },
      h('div', { class: 'notes-tools' },
        h('div', { class: 'search-box' }, icon('search', 18), els.search),
        h('button', {
          class: 'btn btn-tonal', type: 'button', dataset: { key: 'note-new' },
          title: 'New note', onclick: () => newNote(),
        }, icon('add', 18), 'New')),
      els.items,
      els.foot);

    els.editor = h('section', { class: 'note-editor', 'aria-label': 'Note' });
    els.wrap = h('div', { class: 'notes' }, els.list, els.editor);
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
        drawList();
        drawFoot();
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

  function drawList() {
    if (!els.items) return;
    const curKey = N.current && N.current.key;

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
    if (!N.notes.length) {
      els.items.replaceChildren(h('div', {
        class: 'notes-empty', text: N.query.trim() ? 'No notes match.' : 'No notes yet.',
      }));
      return;
    }

    els.items.replaceChildren(...N.notes.map(n => h('button', {
      class: 'note-item', type: 'button', role: 'listitem',
      'aria-current': n.key === curKey ? 'true' : null,
      dataset: { key: `note:${n.key}`, note: n.key },
      onclick: () => openNote(n),
    },
      h('span', { class: 'ni-top' },
        h('span', { class: 'ni-title', text: n.title }),
        h('span', { class: 'date', text: util.relativeDate(n.updated), title: util.fullDate(n.updated) })),
      n.snippet ? h('span', { class: 'ni-snippet', text: n.snippet }) : null,
      n.own ? null : h('span', { class: 'ni-mail', text: 'From an email' }))));
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
      body: '',
      bodyState: note ? 'loading' : 'ready', // loading | ready | error
      dirty: false,
      saving: false,
      error: '',
      savedAt: 0,
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
    notesStore.body(note).then(text => {
      if (N.current !== c) return;
      c.body = text;
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
    const el = els.editor && els.editor.querySelector(`[data-key="${key}"]`);
    if (el) el.focus();
  }

  function drawEditor() {
    if (!els.editor) return;
    const c = N.current;
    if (!c) {
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
    const body = h('textarea', {
      class: 'ne-body', 'aria-label': 'Note', value: c.body, maxlength: String(notesLogic.MAX_BODY),
      placeholder: c.bodyState === 'loading' ? 'Loading…' : c.bodyState === 'error' ? 'Couldn’t load this note.' : 'Write here…',
      disabled: c.bodyState !== 'ready', dataset: { key: 'note-body' },
      oninput: e => edited(c, { body: e.target.value }),
    });

    els.editor.replaceChildren(els.bar, els.bannerSlot, title, body);
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
      if (!c.note && !c.title.trim() && !c.body.trim()) { c.dirty = false; return; }
      const snap = { title: c.title, body: c.body };
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

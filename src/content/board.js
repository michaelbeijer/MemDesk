// ─────────────────────────────────────────────────────────────────────
// The board
//
// A full-viewport overlay over Gmail. Columns are Gmail labels, cards are
// threads, and every change is a threads.modify applied optimistically:
// the card moves at once, and moves back with a toast if Gmail refuses.
// Dragging is the quick way to move things, but every action is also on
// the card's "⋯" menu, so nothing needs a mouse.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, logo, mountShadow, toast, openMenu, closeMenu, isMenuOpen } = ns.ui;
  const { util, logic, store, hooks, api, APP_NAME, HOST_IDS, KEYS } = ns;

  // States with a panel of their own, shown whichever tab is open: they
  // are about the account, not about the board or the notes.
  const PANEL_STATES = new Set(['no_account', 'not_configured', 'auth_required', 'account_mismatch']);

  // Opening the board re-reads Gmail if what is on screen is older than
  // this. Short enough that a label added on the phone shows up; long
  // enough that flicking the board open and shut costs nothing.
  const STALE_MS = 60 * 1000;

  const DRAG_TYPE = 'application/x-gkb-thread';

  // ── State ────────────────────────────────────────────────────────────

  const S = {
    mounted: false,
    open: false,
    view: 'board',    // board | notes - the overlay's two tabs
    viewLoaded: false,
    account: '',
    columns: [],
    lists: {},        // column id → thread ids, in display order
    truncated: {},    // column id → true when Gmail had more than 100
    loadedAt: 0,
    loading: null,    // promise of the refresh in progress
    status: 'idle',   // idle | loading | ready | error | no_account | not_configured | auth_required | account_mismatch
    statusMessage: '',
    search: null,     // { colId, query, ids, loading, error, seq }
    drawer: null,     // { draft, error, saving }
    edits: new Map(), // thread id → { title?, note?, colour? } (see logic.normaliseCardEdit)
    editor: null,     // { id, subject, draft, error, saving }
    drag: null,       // { id, fromCol, card, placeholder }
    mutations: 0,     // local moves made; a refresh that spans one is stale
    renderDeferred: false,
    returnFocus: null,
    ticker: 0,
  };

  let root = null;
  const els = {};

  // ── Mounting ─────────────────────────────────────────────────────────

  function mount() {
    if (S.mounted) return;
    ({ root } = mountShadow(HOST_IDS.board, ns.styles.board));

    els.account = h('span', { class: 'account' });
    els.updated = h('span', { class: 'updated' });
    els.refresh = h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Refresh', title: 'Refresh',
      onclick: () => (S.view === 'notes' ? ns.notes.load({ force: true }) : refresh()),
    }, icon('refresh'));
    els.settings = h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Column settings', title: 'Column settings',
      dataset: { key: 'settings' }, onclick: openDrawer,
    }, icon('tune'));
    els.close = h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Close board', title: 'Close (Esc)',
      onclick: close,
    }, icon('close'));

    const tab = (view, label, iconName) => h('button', {
      class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.view === view),
      dataset: { key: `view:${view}`, view }, onclick: () => switchView(view),
    }, icon(iconName, 18), label);
    els.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'View' },
      tab('board', 'Board', 'board'), tab('notes', 'Notes', 'note'));

    const bar = h('header', { class: 'bar' },
      h('h1', { class: 'brand' },
        h('span', { class: 'logo' }, logo(26)),
        h('span', { text: APP_NAME })),
      els.tabs,
      els.account,
      h('div', { class: 'spacer' }),
      els.updated, els.refresh, els.settings, els.close);

    els.body = h('main', { class: 'body' });
    els.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    els.drawerLayer = h('div', { class: 'drawer-layer' });
    els.editorLayer = h('div', { class: 'editor-layer' });

    els.overlay = h('div', {
      class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${APP_NAME} board`,
      tabindex: '-1', hidden: true, onkeydown: onOverlayKey,
    }, bar, els.body, els.live, els.drawerLayer, els.editorLayer);

    root.appendChild(els.overlay);
    S.mounted = true;

    ns.notes.init({
      root,
      // Account trouble found by the notes gets the same panel as the board's.
      onStateError: err => {
        S.status = err.code;
        S.statusMessage = err.message;
        render();
      },
      onLoaded: () => {
        if (!PANEL_STATES.has(S.status)) return;
        S.status = 'idle';
        render();
      },
      closeBoard: close,
      barChanged: updateBar,
      // Which folders are folded, on this computer, for this account.
      prefs: {
        async get(name) {
          const key = KEYS.pref(hooks.getAccount(), name);
          return (await chrome.storage.local.get(key))[key];
        },
        set: (name, value) => chrome.storage.local.set({ [KEYS.pref(hooks.getAccount(), name)]: value }),
      },
    });

    // A move made from the dock (or another tab) makes what the board last
    // loaded wrong; the board's own moves are already reflected on screen.
    store.bus.addEventListener('thread-changed', e => {
      if (e.detail && e.detail.source === 'board') return;
      S.loadedAt = 0;
      if (S.open && S.view === 'board') refresh();
    });
  }

  // ── Open / close ─────────────────────────────────────────────────────

  async function open({ view } = {}) {
    mount();
    if (S.open) {
      if (view) switchView(view);
      return;
    }
    S.open = true;
    S.returnFocus = deepActiveElement();
    els.overlay.hidden = false;
    els.close.focus();
    document.addEventListener('keydown', onDocumentKey, true);
    S.ticker = setInterval(updateBar, 5000);

    // The tab last used, unless the caller asked for one.
    if (!S.viewLoaded) {
      S.viewLoaded = true;
      try {
        const got = await chrome.storage.local.get(KEYS.view);
        if (got[KEYS.view] === 'notes') S.view = 'notes';
      } catch { /* extension reloaded; handled just below */ }
    }
    if (view) S.view = view;

    S.account = hooks.getAccount();
    if (!S.account) {
      S.status = 'no_account';
      render();
      return;
    }
    try {
      if (!S.columns.length) S.columns = await store.loadColumns(S.account);
    } catch {
      // chrome.storage throws once the extension has been reloaded under
      // this tab; nothing else will work until Gmail is reloaded either.
      S.status = 'error';
      S.statusMessage = 'The extension was updated. Reload this Gmail tab.';
      render();
      return;
    }
    if (S.view === 'notes') showNotes();
    else showBoard();
  }

  function showBoard() {
    const stale = S.status !== 'ready' || Date.now() - S.loadedAt > STALE_MS;
    // Skeleton columns while a first (or retried) load runs, rather than
    // leaving an old "Connect Gmail" panel up after the user has connected.
    if (S.status !== 'ready') S.status = 'loading';
    render();
    if (stale) refresh();
  }

  // An account panel left over from earlier is retried rather than shown
  // again; if the trouble is still there, the notes' own load says so.
  function showNotes() {
    if (PANEL_STATES.has(S.status)) S.status = 'idle';
    render();
    ns.notes.load();
    ns.notes.focusDefault();
  }

  function switchView(view) {
    if (view === S.view || !S.open) return;
    if (S.view === 'notes') ns.notes.flush();
    closeMenu(root);
    S.search = null;
    S.view = view;
    chrome.storage.local.set({ [KEYS.view]: view }).catch(() => {});
    if (view === 'notes') showNotes();
    else showBoard();
  }

  // The dock's two buttons: open on that tab, switch to it, or - when it
  // is already showing - close.
  function toggleView(view) {
    if (S.open && S.view === view) close();
    else if (S.open) switchView(view);
    else open({ view });
  }

  function close() {
    if (!S.open) return;
    // Whatever was typed in the last second or two is saved on the way out.
    ns.notes.flush();
    closeMenu(root);
    S.open = false;
    S.search = null;
    S.drawer = null;
    S.editor = null;
    renderDrawer();
    renderEditor();
    els.overlay.hidden = true;
    // "Columns saved" means nothing once the board is gone; errors stay
    // until read or timed out, since they may explain a card that moved back.
    for (const t of root.querySelectorAll('.toast:not(.toast-error)')) t.remove();
    clearInterval(S.ticker);
    document.removeEventListener('keydown', onDocumentKey, true);
    const back = S.returnFocus;
    S.returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  function toggle() {
    if (S.open) close();
    else open();
  }

  // document.activeElement stops at a shadow host - the dock's, when the
  // board was opened from its button - and a host cannot take focus back.
  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  // Esc peels back one layer at a time: card editor or drawer, then
  // search, then board. Open menus handle their own Esc before it gets here.
  function onOverlayKey(e) {
    if (S.view === 'notes' && !S.editor && ns.notes.handleKey(e)) return;
    if (e.key === 'Escape') {
      if (isMenuOpen(root)) return;
      e.preventDefault();
      if (S.editor) closeEditor();
      else if (S.drawer) closeDrawer();
      else if (S.search) closeSearch();
      else close();
      return;
    }
    if (e.key === 'Tab') trapFocus(e);
  }

  // If focus has escaped to Gmail's page (a click on its edge, say), Esc
  // should still close the board rather than reach Gmail.
  function onDocumentKey(e) {
    // F3 steps through search matches wherever the focus has wandered.
    if (e.key === 'F3' && S.open && S.view === 'notes' && !e.composedPath().includes(els.overlay)) {
      ns.notes.handleKey(e);
      return;
    }
    if (e.key !== 'Escape' || !S.open) return;
    if (e.composedPath().includes(els.overlay)) return;
    if (isMenuOpen(root)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  // A modal that lets Tab wander into the page behind it is not modal.
  function trapFocus(e) {
    const scope = S.editor ? els.editorLayer : S.drawer ? els.drawerLayer : els.overlay;
    const focusable = [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')]
      .filter(el => el.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = root.activeElement;
    if (e.shiftKey && (active === first || !scope.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !scope.contains(active))) { e.preventDefault(); first.focus(); }
  }

  // ── Loading ──────────────────────────────────────────────────────────

  function refresh() {
    if (!S.mounted) return Promise.resolve();
    if (S.loading) return S.loading;
    if (!S.account) S.account = hooks.getAccount();
    if (!S.account) {
      S.status = 'no_account';
      render();
      return Promise.resolve();
    }

    const startedAt = S.mutations;
    let overtaken = false;

    S.loading = (async () => {
      updateBar();
      try {
        S.columns = await store.loadColumns(S.account);
        const [board, saved, edits] = await Promise.all([
          store.loadBoard(S.account, S.columns),
          store.loadOrder(S.account),
          store.loadCardEdits(S.account),
        ]);
        S.edits = edits;
        // Label names as Gmail has them now; a column follows a rename.
        S.columns = board.columns;
        // A card moved while the lists were in flight: what came back may
        // predate that move and would snap the card back. Throw it away and
        // ask again; loadBoard waits for the move to land first.
        if (S.mutations !== startedAt) {
          overtaken = true;
          return;
        }
        const lists = {};
        for (const col of S.columns) {
          const threads = (board.lists[col.id] || []).map(id => ({ id, ts: (store.thread(id) || {}).ts }));
          lists[col.id] = logic.mergeOrder(saved[col.id], threads);
        }
        S.lists = lists;
        S.truncated = board.truncated;
        S.loadedAt = Date.now();
        S.status = 'ready';
        S.statusMessage = '';
        // Saved directly, not via persistOrder: this prunes vanished ids
        // and is not a local move.
        store.saveOrder(S.account, S.lists, S.columns).catch(() => {});
      } catch (err) {
        handleError(err, 'Couldn’t load the board');
      } finally {
        S.loading = null;
        if (!overtaken) {
          render();
          if (S.search && S.search.ids === null) runSearch();
        }
      }
    })();
    const p = S.loading;
    return p.then(() => (overtaken ? refresh() : undefined));
  }

  // The three account states get a panel of their own; anything else is
  // a toast over whatever was already on screen.
  function handleError(err, prefix) {
    if (api.STATE_CODES.has(err.code)) {
      S.status = err.code;
      S.statusMessage = err.message;
      S.search = null;
      return;
    }
    if (S.status !== 'ready') {
      S.status = 'error';
      S.statusMessage = err.message;
      return;
    }
    toast(root, `${prefix}: ${err.message}`, { kind: 'error' });
  }

  // Every local change to the lists goes through here, which is also what
  // marks an in-flight refresh as overtaken.
  function persistOrder() {
    S.mutations++;
    store.saveOrder(S.account, S.lists, S.columns).catch(() => {});
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function updateBar() {
    if (!S.mounted) return;
    els.account.textContent = S.account || 'Account not detected';
    els.account.title = S.account ? `Gmail account: ${S.account}` : '';
    // The refresh button and "updated …" speak for whichever tab is open.
    const notes = S.view === 'notes';
    const loading = notes ? ns.notes.isLoading() : !!S.loading;
    const loadedAt = notes ? ns.notes.loadedAt() : S.loadedAt;
    els.updated.textContent = loading ? 'Updating…'
      : loadedAt ? `updated ${util.agoText(Date.now() - loadedAt)}` : '';
    els.refresh.classList.toggle('spinning', loading);
    els.refresh.disabled = loading || !S.account;
    els.settings.hidden = notes;
    els.settings.disabled = S.status !== 'ready';
    for (const t of els.tabs.children) t.setAttribute('aria-selected', String(t.dataset.view === S.view));
    if (notes) ns.notes.tick();
  }

  function render() {
    if (!S.mounted) return;
    // Rebuilding the columns mid-drag would pull the card out from under
    // the pointer. Whatever changed is drawn once the drag ends.
    if (S.drag) { S.renderDeferred = true; return; }

    updateBar();
    closeMenu(root);

    const key = focusKey();
    const scroll = captureScroll();
    // The notes view hands back the same element every time; putting it
    // back would blur the text box mid-sentence, so it is left in place.
    const next = renderBody();
    if (els.body.firstChild !== next || els.body.childNodes.length !== 1) els.body.replaceChildren(next);
    restoreScroll(scroll);
    restoreFocus(key, els.body);
    // The focused card may be gone (removed, or moved off a column that
    // re-rendered). Keep focus in the dialog rather than dropping it on
    // Gmail's page, where the next key press would be Gmail's.
    if (key && S.open && !els.overlay.contains(root.activeElement)) els.overlay.focus();
  }

  function focusKey() {
    const a = root.activeElement;
    return a && a.dataset ? a.dataset.key || '' : '';
  }

  function restoreFocus(key, scope) {
    if (!key) return;
    const el = [...scope.querySelectorAll('[data-key]')].find(x => x.dataset.key === key);
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch { /* not a text input */ }
    }
  }

  function captureScroll() {
    const out = { left: 0, lists: {} };
    const cols = els.body.querySelector('.columns');
    if (!cols) return out;
    out.left = cols.scrollLeft;
    for (const sec of cols.querySelectorAll('.column')) {
      const list = sec.querySelector('.list');
      if (list) out.lists[sec.dataset.col] = list.scrollTop;
    }
    return out;
  }

  function restoreScroll(s) {
    const cols = els.body.querySelector('.columns');
    if (!cols) return;
    cols.scrollLeft = s.left;
    for (const sec of cols.querySelectorAll('.column')) {
      const list = sec.querySelector('.list');
      if (list && s.lists[sec.dataset.col]) list.scrollTop = s.lists[sec.dataset.col];
    }
  }

  function renderBody() {
    if (S.view === 'notes' && !PANEL_STATES.has(S.status)) return ns.notes.element();
    switch (S.status) {
      case 'no_account':
        return panel('board', 'Which account is this?',
          `${APP_NAME} couldn’t tell which Google account this Gmail tab belongs to, so it doesn’t know whose board to show. Reloading Gmail usually sorts it out.`,
          []);
      case 'not_configured':
        return panel('tune', 'Finish setting up',
          'Add your OAuth client ID on the setup page. It is a one-off and takes a couple of minutes.',
          [button('Open setup', 'primary', () => api.openOptions().catch(err => toast(root, err.message, { kind: 'error' })))]);
      case 'auth_required':
        return panel('board', 'Connect Gmail',
          `Allow ${APP_NAME} to read and label mail in ${S.account}. Google will ask you to confirm.`,
          [button('Connect Gmail', 'primary', connect)]);
      case 'account_mismatch':
        return panel('board', 'That was a different account',
          `${S.statusMessage} The board only ever acts on the mailbox open in this tab. Connect again and choose ${S.account}.`,
          [button('Connect again', 'primary', connect)]);
      case 'error':
        return panel('refresh', 'Couldn’t load the board', S.statusMessage,
          [button('Try again', 'primary', () => refresh())]);
      default:
        return renderColumns();
    }
  }

  function panel(iconName, title, text, actions) {
    return h('div', { class: 'panel', role: 'region', 'aria-label': title },
      h('span', { class: 'panel-icon' }, icon(iconName, 28)),
      h('h2', { text: title }),
      h('p', { text }),
      actions.length ? h('div', { class: 'actions' }, actions) : null);
  }

  function button(label, kind, onClick) {
    return h('button', {
      class: ['btn', `btn-${kind}`], type: 'button', text: label,
      onclick: e => onClick(e.currentTarget),
    });
  }

  async function connect(btn) {
    if (btn) btn.disabled = true;
    try {
      await api.connect();
      if (S.view === 'notes') {
        S.status = 'idle';
        render();
        await ns.notes.load({ force: true });
        return;
      }
      S.status = 'loading';
      render();
      await refresh();
    } catch (err) {
      if (err.code === 'account_mismatch' || err.code === 'not_configured') {
        S.status = err.code;
        S.statusMessage = err.message;
        render();
      } else {
        toast(root, `Couldn’t connect: ${err.message}`, { kind: 'error' });
      }
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  function renderColumns() {
    const skeleton = S.status !== 'ready';
    const wrap = h('div', { class: 'columns' });
    for (const col of S.columns) wrap.appendChild(renderColumn(col, skeleton));
    wrap.addEventListener('dragover', onDragOver);
    wrap.addEventListener('drop', onDrop);
    return wrap;
  }

  function renderColumn(col, skeleton) {
    const ids = S.lists[col.id] || [];
    const searching = !!(S.search && S.search.colId === col.id);

    const list = h('div', {
      class: 'list', role: 'list', 'aria-label': `${col.title}: threads`,
      'data-empty': 'Drag threads here, or use + to find one',
    });
    if (skeleton) {
      for (let i = 0; i < 3; i++) list.appendChild(h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
    } else {
      for (const id of ids) {
        const card = renderCard(id, col);
        if (card) list.appendChild(card);
      }
    }

    const count = S.truncated[col.id] ? `${ids.length}+` : String(ids.length);
    const head = h('div', { class: 'col-head' },
      h('h2', { class: 'col-title', text: col.title, title: `Gmail label: ${col.label}` }),
      skeleton ? null : h('span', { class: 'col-count', text: count, 'aria-label': `${count} threads` }),
      col.archiveOnDrop ? h('span', {
        class: 'col-flag', text: 'Archives',
        title: 'Moving a thread here also archives it (takes it out of the Inbox)',
      }) : null,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'icon-btn', type: 'button',
        'aria-label': `Find a thread to add to ${col.title}`, title: 'Add from Gmail',
        'aria-expanded': String(searching), disabled: skeleton,
        dataset: { key: `add:${col.id}`, action: 'add' },
        onclick: () => toggleSearch(col.id),
      }, icon(searching ? 'close' : 'add')));

    return h('section', { class: 'column', 'aria-label': col.title, dataset: { col: col.id } },
      head,
      S.truncated[col.id] ? h('div', { class: 'col-note', text: 'Showing the first 100 threads' }) : null,
      searching ? renderSearch(col) : null,
      list);
  }

  // A card shows the user's own title and note when it has them. The
  // email's subject stays one hover away, so a renamed card can always be
  // matched to the mail behind it.
  function renderCard(id, col) {
    const t = store.thread(id);
    if (!t) return null;
    const date = util.relativeDate(t.ts);
    const edit = S.edits.get(id) || null;
    const title = logic.displayTitle(t, edit);

    const main = h('button', {
      class: 'card-main', type: 'button', dataset: { key: `card:${id}` },
      title: edit && edit.title
        ? `Email subject: ${t.subject}\nOpen in Gmail (Ctrl-click for a new tab)`
        : 'Open in Gmail (Ctrl-click for a new tab)',
      onclick: e => openThread(id, e),
      onauxclick: e => { if (e.button === 1) { e.preventDefault(); openThread(id, { ctrlKey: true }); } },
    },
      h('span', { class: 'card-top' },
        t.unread ? h('span', { class: 'dot', title: 'Unread' }) : null,
        t.unread ? h('span', { class: 'sr-only', text: 'Unread. ' }) : null,
        h('span', { class: 'from', text: t.from }),
        h('span', { class: 'date', text: date, title: util.fullDate(t.ts) })),
      h('span', { class: 'subject-row' },
        h('span', { class: 'subject', text: title }),
        t.hasDraft ? h('span', { class: 'draft', text: 'Draft' }) : null,
        t.starred ? h('span', { class: 'star', title: 'Starred', 'aria-label': 'Starred' }, icon('star', 16)) : null,
        t.count > 1 ? h('span', { class: 'count', text: String(t.count), title: `${t.count} messages` }) : null),
      edit && edit.note
        ? h('span', { class: 'card-note' }, h('span', { class: 'sr-only', text: 'Note: ' }), edit.note)
        : t.snippet ? h('span', { class: 'snippet', text: t.snippet }) : null);

    const more = h('button', {
      class: 'icon-btn card-menu', type: 'button',
      'aria-label': `More actions: ${title}`, title: 'More actions',
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      dataset: { key: `menu:${id}` },
      onclick: e => openCardMenu(e.currentTarget, id, col.id),
    }, icon('more', 20));

    const card = h('div', {
      class: ['card', t.unread && 'unread'], role: 'listitem', draggable: 'true',
      dataset: edit && edit.colour ? { id, colour: edit.colour } : { id },
    }, main, more);
    card.addEventListener('dragstart', e => onDragStart(e, id, col.id, card));
    card.addEventListener('dragend', onDragEnd);
    return card;
  }

  function announce(msg) {
    els.live.textContent = msg;
  }

  // ── Card actions ─────────────────────────────────────────────────────

  function openThread(id, e) {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      window.open(hooks.threadUrl(id), '_blank', 'noopener');
      return;
    }
    close();
    hooks.openThread(id);
  }

  function columnOf(id) {
    return S.columns.find(c => (S.lists[c.id] || []).includes(id)) || null;
  }

  function cardTitle(id) {
    return logic.displayTitle(store.thread(id), S.edits.get(id));
  }

  function openCardMenu(anchor, id, colId) {
    const list = S.lists[colId] || [];
    const at = list.indexOf(id);
    openMenu(root, anchor, [
      { label: 'Open in Gmail', icon: 'open', key: 'open', onSelect: () => openThread(id) },
      { label: 'Edit card…', icon: 'edit', key: 'edit', onSelect: () => openEditor(id) },
      { separator: true },
      // Reordering is a drag otherwise; these keep it within reach of the
      // keyboard. Focus returns to this card's menu button afterwards, so
      // repeated presses keep moving the same card.
      { label: 'Move up', icon: 'up', key: 'up', disabled: at <= 0, onSelect: () => moveThread(id, colId, colId, at - 1) },
      { label: 'Move down', icon: 'down', key: 'down', disabled: at < 0 || at >= list.length - 1, onSelect: () => moveThread(id, colId, colId, at + 1) },
      { separator: true },
      { heading: 'Move to' },
      ...S.columns.map(c => ({
        label: c.title,
        checked: c.id === colId,
        disabled: c.id === colId,
        key: `move:${c.id}`,
        onSelect: () => moveThread(id, colId, c.id, 0),
      })),
      { separator: true },
      { label: 'Remove from board', icon: 'remove', danger: true, key: 'remove', onSelect: () => removeThread(id) },
    ], { label: `Actions for ${cardTitle(id)}` });
  }

  // Optimistic: the card moves now, and only this card moves back if
  // Gmail refuses - other moves made in the meantime are left alone.
  async function moveThread(id, fromCol, toCol, index) {
    const from = S.lists[fromCol] || [];
    const originalIndex = from.indexOf(id);

    if (fromCol === toCol) {
      S.lists[toCol] = logic.placeId(from, id, index);
      persistOrder();
      render();
      return;
    }

    const target = S.columns.find(c => c.id === toCol);
    S.lists[fromCol] = from.filter(x => x !== id);
    S.lists[toCol] = logic.placeId(S.lists[toCol], id, index);
    persistOrder();
    render();
    announce(`Moved to ${target.title}${target.archiveOnDrop ? ' and archived' : ''}.`);

    try {
      await store.moveToColumn(id, S.columns, toCol, 'board');
    } catch (err) {
      S.lists[toCol] = (S.lists[toCol] || []).filter(x => x !== id);
      if (S.lists[fromCol]) S.lists[fromCol] = logic.placeId(S.lists[fromCol], id, Math.max(0, originalIndex));
      persistOrder();
      render();
      failToast('move', id, err);
    }
  }

  async function removeThread(id) {
    const col = columnOf(id);
    if (!col) return;
    const originalIndex = S.lists[col.id].indexOf(id);
    S.lists[col.id] = S.lists[col.id].filter(x => x !== id);
    persistOrder();
    render();
    announce('Removed from the board.');
    try {
      await store.removeFromBoard(id, S.columns, 'board', S.account);
      S.edits.delete(id);
    } catch (err) {
      S.lists[col.id] = logic.placeId(S.lists[col.id], id, originalIndex);
      persistOrder();
      render();
      failToast('remove', id, err);
    }
  }

  function failToast(verb, id, err) {
    const opts = { kind: 'error' };
    if (err.code === 'auth_required') opts.action = { label: 'Connect', onClick: () => connect() };
    toast(root, `Couldn’t ${verb} “${store.thread(id) ? cardTitle(id) : 'that thread'}”: ${err.message}`, opts);
  }

  // ── Drag and drop ────────────────────────────────────────────────────

  function onDragStart(e, id, colId, card) {
    closeMenu(root);
    const placeholder = h('div', { class: 'placeholder', 'aria-hidden': 'true' });
    placeholder.style.height = `${card.offsetHeight}px`;
    S.drag = { id, fromCol: colId, card, placeholder };
    e.dataTransfer.effectAllowed = 'move';
    // A private type, so dropping a card on Gmail's compose box does not
    // paste a thread id into an email.
    e.dataTransfer.setData(DRAG_TYPE, id);
    card.classList.add('lifting');
    // Hide the card only after the browser has captured it as the drag
    // image; hiding it synchronously cancels the drag in Chrome.
    setTimeout(() => {
      if (!S.drag || S.drag.card !== card) return;
      card.parentNode.insertBefore(placeholder, card);
      card.classList.add('dragging');
    }, 0);
  }

  function dropIndex(list, y) {
    const cards = [...list.querySelectorAll(':scope > .card:not(.dragging)')];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  }

  function onDragOver(e) {
    if (!S.drag) return;
    const section = e.target.closest && e.target.closest('.column');
    const ph = S.drag.placeholder;
    if (!section) {
      ph.remove();
      markTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const list = section.querySelector('.list');
    const idx = dropIndex(list, e.clientY);
    const cards = [...list.querySelectorAll(':scope > .card:not(.dragging)')];
    const ref = cards[idx] || null;
    if (ref) {
      if (ref.previousElementSibling !== ph) list.insertBefore(ph, ref);
    } else if (list.lastElementChild !== ph) {
      list.appendChild(ph);
    }
    markTarget(section);
  }

  function onDrop(e) {
    if (!S.drag) return;
    const section = e.target.closest && e.target.closest('.column');
    if (!section) return;
    e.preventDefault();
    const idx = dropIndex(section.querySelector('.list'), e.clientY);
    const { id, fromCol } = S.drag;
    endDrag(false);
    moveThread(id, fromCol, section.dataset.col, idx);
  }

  function onDragEnd() {
    if (S.drag) endDrag(true);
  }

  function endDrag(cancelled) {
    const d = S.drag;
    S.drag = null;
    d.placeholder.remove();
    d.card.classList.remove('dragging', 'lifting');
    markTarget(null);
    if (cancelled || S.renderDeferred) {
      S.renderDeferred = false;
      render();
    }
  }

  function markTarget(section) {
    for (const s of els.body.querySelectorAll('.column.drop-target')) {
      if (s !== section) s.classList.remove('drop-target');
    }
    if (section) section.classList.add('drop-target');
  }

  // ── Column search ("+") ──────────────────────────────────────────────

  let searchTimer = 0;

  function toggleSearch(colId) {
    if (S.search && S.search.colId === colId) {
      closeSearch();
      return;
    }
    S.search = { colId, query: '', ids: null, loading: false, error: '', seq: 0 };
    render();
    const input = els.body.querySelector('.search input');
    if (input) input.focus();
    runSearch();
  }

  function closeSearch() {
    if (!S.search) return;
    const colId = S.search.colId;
    S.search = null;
    clearTimeout(searchTimer);
    render();
    restoreFocus(`add:${colId}`, els.body);
  }

  function renderSearch(col) {
    const s = S.search;
    const input = h('input', {
      type: 'search',
      placeholder: 'Search mail, e.g. from:anna is:unread',
      'aria-label': `Search Gmail for a thread to add to ${col.title}`,
      value: s.query,
      dataset: { key: `search:${col.id}` },
      oninput: e => {
        s.query = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 450);
      },
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
      },
    });
    els.results = h('div', { class: 'results', role: 'list', 'aria-label': 'Search results', 'aria-busy': String(s.loading) });
    fillResults(true);
    return h('div', { class: 'search', role: 'search' },
      h('div', { class: 'search-box' }, icon('search', 18), input),
      h('div', { class: 'search-hint', text: 'Gmail search syntax. Leave it empty to list your Inbox.' }),
      els.results);
  }

  async function runSearch() {
    const s = S.search;
    if (!s) return;
    const seq = ++s.seq;
    s.loading = true;
    fillResults();
    try {
      const ids = await store.search(s.query, S.account);
      if (S.search !== s || seq !== s.seq) return;
      s.ids = ids;
      s.error = '';
    } catch (err) {
      if (S.search !== s || seq !== s.seq) return;
      if (api.STATE_CODES.has(err.code)) {
        handleError(err);
        render();
        return;
      }
      s.ids = [];
      s.error = err.message;
    }
    s.loading = false;
    fillResults();
  }

  // `building` is true while the panel is being created and is not yet in
  // the document; otherwise a detached box means an async search finished
  // after its panel was closed, and there is nothing to fill.
  function fillResults(building = false) {
    const s = S.search;
    const box = els.results;
    if (!s || !box || (!building && !box.isConnected)) return;
    box.setAttribute('aria-busy', String(s.loading));

    if (s.ids === null || (s.loading && !s.ids.length)) {
      box.replaceChildren(h('div', { class: 'results-empty', text: 'Searching…' }));
      return;
    }
    if (s.error) {
      box.replaceChildren(h('div', { class: 'results-empty', text: `Search failed: ${s.error}` }));
      return;
    }
    if (!s.ids.length) {
      box.replaceChildren(h('div', { class: 'results-empty', text: 'No threads match.' }));
      return;
    }

    const target = S.columns.find(c => c.id === s.colId);
    box.replaceChildren(...s.ids.map(id => {
      const t = store.thread(id);
      const where = columnOf(id);
      const here = where && where.id === s.colId;
      return h('button', {
        class: 'result', type: 'button', role: 'listitem', disabled: here,
        dataset: { key: `result:${id}`, id },
        title: here ? '' : `Add to ${target ? target.title : 'this column'}`,
        onclick: () => addFromSearch(id, s.colId),
      },
        h('span', { class: 'r-top' },
          h('span', { class: 'from', text: t.from }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'date', text: util.relativeDate(t.ts) })),
        h('span', { class: 'r-subject', text: logic.displayTitle(t, S.edits.get(id)) }),
        where ? h('span', { class: 'r-where', text: here ? 'Already in this column' : `In ${where.title} · moves here` }) : null);
    }));
  }

  async function addFromSearch(id, colId) {
    const where = columnOf(id);
    if (where && where.id === colId) return;
    if (where) {
      moveThread(id, where.id, colId, 0);
      return;
    }
    const target = S.columns.find(c => c.id === colId);
    S.lists[colId] = logic.placeId(S.lists[colId], id, 0);
    persistOrder();
    render();
    announce(`Added to ${target.title}.`);
    try {
      await store.moveToColumn(id, S.columns, colId, 'board');
    } catch (err) {
      S.lists[colId] = (S.lists[colId] || []).filter(x => x !== id);
      persistOrder();
      render();
      failToast('add', id, err);
    }
  }

  // ── Column settings ──────────────────────────────────────────────────

  function openDrawer() {
    if (S.status !== 'ready') return;
    closeMenu(root);
    S.drawer = {
      draft: S.columns.map(c => ({ ...c, origLabel: c.label, isNew: false, labelTouched: true })),
      error: '',
      saving: false,
    };
    renderDrawer('title:0');
  }

  function closeDrawer() {
    if (!S.drawer) return;
    S.drawer = null;
    renderDrawer();
    if (S.open) els.settings.focus();
  }

  function renderDrawer(focus) {
    const d = S.drawer;
    if (!d) {
      els.drawerLayer.replaceChildren();
      return;
    }
    const key = focus || focusKey();

    const drawer = h('aside', {
      class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gkb-drawer-title',
    },
      h('div', { class: 'drawer-head' },
        h('h2', { id: 'gkb-drawer-title', text: 'Columns' }),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Close column settings', onclick: closeDrawer,
        }, icon('close'))),
      h('p', {
        class: 'drawer-intro',
        text: 'Each column is a Gmail label. Renaming a label here renames it in Gmail, so the mail filed under it stays put.',
      }),
      h('div', { class: 'drawer-body' },
        d.draft.map((c, i) => renderDraftRow(c, i)),
        h('button', {
          class: 'add-col', type: 'button', dataset: { key: 'add-col' }, onclick: addDraftColumn,
        }, '+ Add column')),
      h('div', { class: 'form-error', role: 'alert', text: d.error }),
      h('div', { class: 'drawer-foot' },
        h('span', {
          class: 'note',
          text: 'Removing a column only takes it off the board. Its Gmail label, and the mail in it, are left untouched.',
        }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: closeDrawer }),
        h('button', {
          class: 'btn btn-primary', type: 'button', disabled: d.saving, dataset: { key: 'save' },
          text: d.saving ? 'Saving…' : 'Save', onclick: saveDrawer,
        })));

    els.drawerLayer.replaceChildren(h('div', { class: 'scrim', onclick: closeDrawer }), drawer);
    restoreFocus(key, els.drawerLayer);
  }

  function renderDraftRow(c, i) {
    const n = S.drawer.draft.length;
    const rowTitle = h('span', { class: 'row-title', text: c.title || 'New column' });
    const help = h('span', { class: 'field-help' });
    const setHelp = () => {
      help.textContent = c.isNew
        ? 'Created in Gmail when you save.'
        : c.label.trim() !== c.origLabel ? `Renames “${c.origLabel}” in Gmail when you save.` : '';
    };
    setHelp();

    const labelInput = h('input', {
      class: 'text-input', type: 'text', value: c.label, spellcheck: 'false',
      dataset: { key: `label:${i}` },
      oninput: e => { c.label = e.target.value; c.labelTouched = true; setHelp(); },
    });
    const titleInput = h('input', {
      class: 'text-input', type: 'text', value: c.title,
      dataset: { key: `title:${i}` },
      oninput: e => {
        c.title = e.target.value;
        rowTitle.textContent = c.title || 'New column';
        // A new column's label follows its title until edited by hand.
        if (c.isNew && !c.labelTouched) {
          c.label = `${c.root}/${c.title.trim()}`;
          labelInput.value = c.label;
        }
      },
    });

    return h('div', { class: 'col-row', dataset: { row: String(i) } },
      h('div', { class: 'row-head' },
        h('span', { class: 'row-num', text: String(i + 1) }),
        rowTitle,
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${c.title || 'column'} up`, title: 'Move up (further left on the board)',
          disabled: i === 0, dataset: { key: `up:${i}` }, onclick: () => moveDraft(i, -1),
        }, icon('up', 18)),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${c.title || 'column'} down`, title: 'Move down (further right on the board)',
          disabled: i === n - 1, dataset: { key: `down:${i}` }, onclick: () => moveDraft(i, 1),
        }, icon('down', 18)),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Remove ${c.title || 'column'} from the board`,
          title: 'Remove from board (keeps the Gmail label)', dataset: { key: `remove:${i}` },
          onclick: () => removeDraft(i),
        }, icon('close', 18))),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Title' }),
        titleInput),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: 'Gmail label' }),
        labelInput,
        help),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: !!c.archiveOnDrop, dataset: { key: `archive:${i}` },
          onchange: e => { c.archiveOnDrop = e.target.checked; },
        }),
        'Archive threads moved here (take them out of the Inbox)'));
  }

  function moveDraft(i, delta) {
    const d = S.drawer.draft;
    const j = i + delta;
    if (j < 0 || j >= d.length) return;
    [d[i], d[j]] = [d[j], d[i]];
    // Keep focus on the same arrow, now on the row's new position, so
    // repeated presses keep moving the same column.
    const key = delta < 0 ? (j === 0 ? `down:${j}` : `up:${j}`) : (j === d.length - 1 ? `up:${j}` : `down:${j}`);
    renderDrawer(key);
  }

  function removeDraft(i) {
    S.drawer.draft.splice(i, 1);
    const n = S.drawer.draft.length;
    renderDrawer(n ? `title:${Math.min(i, n - 1)}` : 'add-col');
  }

  function addDraftColumn() {
    const d = S.drawer.draft;
    // Under whatever parent the columns already share ("_Board", or one
    // the user moved them to), not a hard-coded one.
    const root = logic.labelRoot(S.columns);
    d.push({
      id: logic.newColumnId(d),
      title: 'New column',
      label: `${root}/New column`,
      root,
      archiveOnDrop: false,
      origLabel: '',
      isNew: true,
      labelTouched: false,
    });
    renderDrawer(`title:${d.length - 1}`);
    const input = [...els.drawerLayer.querySelectorAll('[data-key]')].find(x => x.dataset.key === `title:${d.length - 1}`);
    if (input) input.select();
  }

  async function saveDrawer() {
    const d = S.drawer;
    const tidy = s => String(s || '').split('/').map(p => p.trim()).join('/');
    const cols = d.draft.map(c => ({
      id: c.id,
      title: String(c.title || '').trim(),
      label: tidy(c.label),
      archiveOnDrop: !!c.archiveOnDrop,
    }));

    const problem = logic.validateColumns(cols);
    if (problem) {
      d.error = problem;
      renderDrawer();
      return;
    }

    d.saving = true;
    d.error = '';
    renderDrawer('save');
    const notes = [];

    try {
      // Label renames first, persisting after each one. If a later step
      // fails, the saved layout still matches what Gmail now has, instead
      // of pointing at a label name that no longer exists.
      let persisted = S.columns.map(c => ({ ...c }));
      for (let i = 0; i < d.draft.length; i++) {
        const row = d.draft[i];
        const next = cols[i];
        if (row.isNew || !row.origLabel || row.origLabel === next.label) continue;
        const result = await store.renameLabel(row.origLabel, next.label);
        if (result === 'repointed') notes.push(`“${next.title}” now uses the existing label “${next.label}”.`);
        persisted = persisted.map(c => (c.id === next.id ? { ...c, label: next.label } : c));
        await store.saveColumns(S.account, persisted);
        S.columns = persisted;
      }

      await store.ensureLabels(cols.map(c => c.label), { fresh: true });
      await store.saveColumns(S.account, cols);
      S.columns = cols;
      S.drawer = null;
      renderDrawer();
      els.settings.focus();
      toast(root, ['Columns saved.', ...notes].join(' '));
      S.loadedAt = 0;
      await refresh();
    } catch (err) {
      if (api.STATE_CODES.has(err.code)) {
        S.drawer = null;
        renderDrawer();
        handleError(err);
        render();
        return;
      }
      d.saving = false;
      d.error = `Couldn’t save: ${err.message}`;
      renderDrawer();
    }
  }

  // ── Card editor ──────────────────────────────────────────────────────
  //
  // The user's own title, note and colour for one card. None of it reaches
  // Gmail: the record lives in storage.sync, and the email - its subject,
  // its labels, what correspondents see - is exactly as it was.

  const COLOUR_NAMES = {
    red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green',
    blue: 'Blue', purple: 'Purple', grey: 'Grey',
  };

  function openEditor(id) {
    const t = store.thread(id);
    if (!t || S.status !== 'ready') return;
    closeMenu(root);
    const edit = S.edits.get(id) || {};
    S.editor = {
      id,
      subject: t.subject,
      // Pre-filled with the subject rather than left blank, because the
      // usual edit is trimming a long subject down, not starting afresh.
      draft: { title: edit.title || t.subject, note: edit.note || '', colour: edit.colour || '' },
      error: '',
      saving: false,
    };
    renderEditor('edit-title');
    const input = els.editorLayer.querySelector('[data-key="edit-title"]');
    if (input) input.select();
  }

  function closeEditor() {
    if (!S.editor) return;
    const id = S.editor.id;
    S.editor = null;
    renderEditor();
    if (S.open) restoreFocus(`menu:${id}`, els.body);
  }

  function renderEditor(focus) {
    const ed = S.editor;
    if (!ed) {
      els.editorLayer.replaceChildren();
      return;
    }
    const key = focus || focusKey();
    const d = ed.draft;

    const reset = h('button', {
      class: 'link-btn', type: 'button', text: 'Use the email subject', dataset: { key: 'edit-reset' },
      onclick: () => {
        d.title = ed.subject;
        titleInput.value = ed.subject;
        syncReset();
        titleInput.focus();
      },
    });
    const syncReset = () => {
      const v = d.title.trim();
      reset.hidden = !v || v === ed.subject.trim();
    };

    const titleInput = h('input', {
      class: 'text-input', type: 'text', value: d.title, maxlength: String(logic.MAX_TITLE),
      placeholder: ed.subject, 'aria-describedby': 'gkb-edit-subject', dataset: { key: 'edit-title' },
      oninput: e => { d.title = e.target.value; syncReset(); },
      onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveEditor(); } },
    });
    syncReset();

    const noteInput = h('textarea', {
      class: ['text-input', 'text-area'], rows: '3', maxlength: String(logic.MAX_NOTE), value: d.note,
      placeholder: 'Optional. Shown on the card in place of the email preview.',
      dataset: { key: 'edit-note' },
      oninput: e => { d.note = e.target.value; },
      // Enter is a new line in a note; Ctrl+Enter saves, as in Gmail's compose.
      onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); } },
    });

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-labelledby': 'gkb-edit-colour' },
      ['', ...logic.CARD_COLOURS].map(c => {
        const name = c ? COLOUR_NAMES[c] : 'No colour';
        return h('label', { class: 'swatch', title: name, dataset: { colour: c || 'none' } },
          h('input', {
            type: 'radio', name: 'gkb-card-colour', value: c, checked: d.colour === c, 'aria-label': name,
            dataset: { key: `edit-colour:${c || 'none'}` },
            onchange: () => { d.colour = c; },
          }),
          h('span', { class: 'swatch-dot', 'aria-hidden': 'true' }));
      }));

    const dialog = h('div', {
      class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gkb-edit-heading',
    },
      h('div', { class: 'dialog-head' },
        h('h2', { id: 'gkb-edit-heading', text: 'Edit card' }),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Close without saving', onclick: closeEditor,
        }, icon('close'))),
      h('div', { class: 'dialog-body' },
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'gkb-edit-title', text: 'Title on the board' }),
          Object.assign(titleInput, { id: 'gkb-edit-title' }),
          h('div', { class: 'help-row', id: 'gkb-edit-subject' },
            h('span', {}, 'Email subject: ', h('span', { class: 'subject-ref', text: ed.subject })),
            reset)),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'gkb-edit-note', text: 'Note' }),
          Object.assign(noteInput, { id: 'gkb-edit-note' })),
        h('div', { class: 'field' },
          h('span', { class: 'field-label', id: 'gkb-edit-colour', text: 'Colour' }),
          swatches)),
      h('div', { class: 'form-error', role: 'alert', text: ed.error }),
      h('div', { class: 'dialog-foot' },
        h('span', {
          class: 'note',
          text: 'Only the board changes. The email itself, and what others see, stay as they are.',
        }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: closeEditor }),
        h('button', {
          class: 'btn btn-primary', type: 'button', disabled: ed.saving, dataset: { key: 'edit-save' },
          text: 'Save', onclick: saveEditor,
        })));

    els.editorLayer.replaceChildren(h('div', { class: 'scrim', onclick: closeEditor }), dialog);
    restoreFocus(key, els.editorLayer);
  }

  async function saveEditor() {
    const ed = S.editor;
    if (!ed || ed.saving) return;
    const edit = logic.normaliseCardEdit(ed.draft, ed.subject);
    ed.saving = true;
    const save = els.editorLayer.querySelector('[data-key="edit-save"]');
    if (save) save.disabled = true;

    try {
      await store.saveCardEdit(S.account, ed.id, edit);
    } catch (err) {
      if (S.editor !== ed) return;
      ed.saving = false;
      ed.error = `Couldn’t save: ${err.message}`;
      renderEditor('edit-save');
      return;
    }

    if (edit) S.edits.set(ed.id, edit);
    else S.edits.delete(ed.id);
    if (S.editor === ed) S.editor = null;
    renderEditor();
    render();
    restoreFocus(`menu:${ed.id}`, els.body);
    announce(edit ? 'Card updated.' : 'Card back to showing the email.');
  }

  // ── External changes ─────────────────────────────────────────────────

  // Columns edited in another tab or on another computer (storage.sync).
  // This tab's own saves echo back here too; those are already on screen.
  function columnsChanged(next) {
    if (next && JSON.stringify(next) === JSON.stringify(S.columns)) return;
    S.loadedAt = 0;
    if (S.open && !S.drawer && S.view === 'board') refresh();
  }

  // Card edits saved in another tab, or synced from another computer.
  // This tab's own saves echo back here as well; those are already drawn,
  // and redrawing for them would close a menu opened in the meantime.
  function cardEditsChanged(changes, prefix) {
    let changed = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const next = logic.normaliseCardEdit(change && change.newValue);
      if (JSON.stringify(next) === JSON.stringify(S.edits.get(id) || null)) continue;
      if (next) S.edits.set(id, next);
      else S.edits.delete(id);
      changed = true;
    }
    if (changed && S.open && S.status === 'ready' && S.view === 'board') render();
  }

  ns.board = {
    open, close, toggle, toggleView, columnsChanged, cardEditsChanged,
    isOpen: () => S.open,
  };
})();

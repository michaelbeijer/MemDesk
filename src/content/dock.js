// ─────────────────────────────────────────────────────────────────────
// The dock
//
// Two small pills in a corner of Gmail: one opens the board, the other
// appears only while a conversation is open and says whether it is on
// the board. Filing the thread you are reading is the most common thing
// a board gets used for, and it should not mean opening the board.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, mountShadow, toast, openMenu, closeMenu, isMenuOpen } = ns.ui;
  const { store, hooks, api, APP_NAME, HOST_IDS } = ns;

  const S = {
    threadId: '',
    column: null,   // the column the open thread is in, or null
    columns: [],
    seq: 0,         // discards lookups overtaken by a newer thread
  };

  let root = null;
  const els = {};

  // ── Mounting ─────────────────────────────────────────────────────────

  function mount() {
    ({ root } = mountShadow(HOST_IDS.dock, ns.styles.dock));

    els.board = h('button', {
      class: 'pill', type: 'button', title: `Open the ${APP_NAME} board`,
      dataset: { action: 'toggle-board' },
      onclick: () => ns.board.toggle(),
    }, icon('board', 20), h('span', { class: 'pill-label', text: 'Board' }));

    els.thread = h('button', {
      class: 'pill', type: 'button', hidden: true,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      dataset: { action: 'thread-menu' },
      onclick: toggleThreadMenu,
    });

    els.dock = h('div', { class: 'dock', role: 'group', 'aria-label': APP_NAME }, els.board, els.thread);
    root.appendChild(els.dock);
  }

  async function init() {
    mount();
    try {
      setPosition(await store.loadDockPosition());
    } catch { /* extension reloaded under us; leave the default */ }

    hooks.watchOpenThread(onThreadChange);

    store.bus.addEventListener('thread-changed', e => {
      if (e.detail && e.detail.threadId === S.threadId && e.detail.source !== 'dock') lookup();
    });
    document.addEventListener('visibilitychange', () => {
      // Labels may have changed on the phone while the tab was hidden.
      if (document.visibilityState === 'visible' && S.threadId) lookup();
    });
  }

  function setPosition(pos) {
    if (!els.dock) return;
    els.dock.hidden = pos === 'hidden';
    els.dock.classList.toggle('right', pos === 'right');
    if (pos === 'hidden') closeMenu(root);
  }

  // ── Open thread ──────────────────────────────────────────────────────

  function onThreadChange(id) {
    S.threadId = id;
    S.column = null;
    closeMenu(root);
    renderPill();
    if (id) lookup();
  }

  async function columns() {
    if (!S.columns.length) S.columns = await store.loadColumns(hooks.getAccount());
    return S.columns;
  }

  // Failures are silent on purpose: this runs on every conversation
  // opened, and a toast each time Gmail is not yet connected would be
  // noise. The pill falls back to "Add to board", and acting on it
  // surfaces the real problem with a way to fix it.
  async function lookup() {
    const id = S.threadId;
    const seq = ++S.seq;
    if (!id || !hooks.getAccount()) return;
    let col = null;
    try {
      col = await store.threadColumn(id, await columns());
    } catch { col = null; }
    if (seq !== S.seq) return;
    S.column = col;
    renderPill();
  }

  function renderPill() {
    const b = els.thread;
    if (!S.threadId) {
      b.hidden = true;
      return;
    }
    const on = !!S.column;
    const caret = icon('caret', 20);
    caret.classList.add('caret');
    b.hidden = false;
    b.classList.toggle('on', on);
    b.replaceChildren(
      icon(on ? 'board' : 'add', 20),
      h('span', { class: 'pill-label', text: on ? `On board: ${S.column.title}` : 'Add to board' }),
      caret);
    b.setAttribute('aria-label', on
      ? `On the board in ${S.column.title}. Change column`
      : 'Add this conversation to the board');
  }

  async function toggleThreadMenu() {
    if (isMenuOpen(root)) {
      closeMenu(root);
      return;
    }
    let cols;
    try {
      cols = await columns();
    } catch (err) {
      fail(err);
      return;
    }
    const current = S.column;
    const items = [{ heading: current ? 'Move to' : 'Add to' }];
    for (const c of cols) {
      items.push({
        label: c.title,
        checked: current ? current.id === c.id : undefined,
        disabled: !!current && current.id === c.id,
        key: `col:${c.id}`,
        onSelect: () => moveOpenThread(c),
      });
    }
    if (current) {
      items.push({ separator: true }, {
        label: 'Remove from board', icon: 'remove', danger: true, key: 'remove',
        onSelect: removeOpenThread,
      });
    }
    openMenu(root, els.thread, items, { label: 'Board column', placement: 'above' });
  }

  async function moveOpenThread(col) {
    const id = S.threadId;
    const was = S.column;
    S.seq++; // a lookup still in flight predates this and must not win
    S.column = col;
    renderPill();
    try {
      await store.moveToColumn(id, await columns(), col.id, 'dock');
      toast(root, `${was ? 'Moved' : 'Added'} to ${col.title}${col.archiveOnDrop ? ' and archived' : ''}.`);
    } catch (err) {
      if (S.threadId === id) {
        S.column = was;
        renderPill();
      }
      fail(err);
    }
  }

  async function removeOpenThread() {
    const id = S.threadId;
    const was = S.column;
    S.seq++;
    S.column = null;
    renderPill();
    try {
      await store.removeFromBoard(id, await columns(), 'dock', hooks.getAccount());
      toast(root, 'Removed from the board.');
    } catch (err) {
      if (S.threadId === id) {
        S.column = was;
        renderPill();
      }
      fail(err);
    }
  }

  function fail(err) {
    if (err.code === 'not_configured') {
      toast(root, 'Finish setup first: add your OAuth client ID.', {
        kind: 'error',
        action: { label: 'Open setup', onClick: () => api.openOptions().catch(() => {}) },
      });
    } else if (err.code === 'auth_required') {
      toast(root, 'Gmail isn’t connected in this browser yet.', {
        kind: 'error',
        action: {
          label: 'Connect',
          onClick: async () => {
            try {
              await api.connect();
              toast(root, 'Connected.');
              lookup();
            } catch (e) {
              toast(root, `Couldn’t connect: ${e.message}`, { kind: 'error' });
            }
          },
        },
      });
    } else {
      toast(root, `Couldn’t update the board: ${err.message}`, { kind: 'error' });
    }
  }

  function columnsChanged() {
    S.columns = [];
    if (S.threadId) lookup();
  }

  ns.dock = { init, setPosition, columnsChanged };
})();

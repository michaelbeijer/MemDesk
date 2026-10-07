// ─────────────────────────────────────────────────────────────────────
// The dock
//
// The buttons in Gmail: one opens the board, one the notes, one the
// calendar, and a fourth appears only while a conversation is open and
// says whether it is on the board. Filing the thread you are reading is
// the most common thing a board gets used for, and it should not mean
// opening the board. They sit in Gmail's top bar, or float in a bottom
// corner (see "Where it sits").
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, mountShadow, toast, openMenu, closeMenu, isMenuOpen, chime } = ns.ui;
  const { store, hooks, api, APP_NAME, HOST_IDS } = ns;

  const S = {
    threadId: '',
    column: null,   // the column the open thread is in, or null
    columns: [],
    seq: 0,         // discards lookups overtaken by a newer thread
    place: 'top',   // as chosen: 'top' (Gmail's bar), 'left', 'right' or 'hidden'
    inBar: false,   // in Gmail's bar now, rather than floating
    noRoom: null,   // when the bar had no room for them: the search box's width then, without them
  };

  // `root`: the floating layer, on top of everything - the buttons when
  // they float, and their menus and messages always.
  let root = null;
  let bar = null;   // { host, root }: their place in Gmail's bar, made when first needed
  const els = {};

  // ── Mounting ─────────────────────────────────────────────────────────

  function mount() {
    ({ root } = mountShadow(HOST_IDS.dock, ns.styles.dock));

    els.board = h('button', {
      class: 'pill', type: 'button', title: `Open the ${APP_NAME} board`,
      dataset: { action: 'toggle-board' },
      onclick: () => ns.board.toggleView('board'),
    }, icon('board', 20), h('span', { class: 'pill-label', text: 'Board' }));

    els.notes = h('button', {
      class: ['pill', 'pill-compact'], type: 'button', title: `Open ${APP_NAME} notes`,
      dataset: { action: 'toggle-notes' },
      onclick: () => ns.board.toggleView('notes'),
    }, icon('note', 20), h('span', { class: 'pill-label', text: 'Notes' }));

    els.calendar = h('button', {
      class: ['pill', 'pill-compact'], type: 'button', title: `Open the ${APP_NAME} calendar`,
      dataset: { action: 'toggle-calendar' },
      onclick: () => ns.board.toggleView('calendar'),
    }, icon('calendar', 20), h('span', { class: 'pill-label', text: 'Calendar' }));

    els.thread = h('button', {
      class: 'pill', type: 'button', hidden: true,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      dataset: { action: 'thread-menu' },
      onclick: toggleThreadMenu,
    });

    els.dock = h('div', { class: 'dock', role: 'group', 'aria-label': APP_NAME }, els.board, els.notes, els.calendar, els.thread);
    root.appendChild(els.dock);
  }

  async function init() {
    mount();
    let chosen = 'top';
    try {
      chosen = await store.loadDockPlace();
    } catch { /* extension reloaded under us; leave the default */ }
    setPlace(chosen);
    watchBar();

    hooks.watchOpenThread(onThreadChange);

    store.bus.addEventListener('thread-changed', e => {
      if (e.detail && e.detail.threadId === S.threadId && e.detail.source !== 'dock') lookup();
    });
    document.addEventListener('visibilitychange', () => {
      // Labels may have changed on the phone while the tab was hidden.
      if (document.visibilityState === 'visible' && S.threadId) lookup();
    });
  }

  // ── Where it sits ────────────────────────────────────────────────────
  //
  // By default in Gmail's top bar, between the search box and Gmail's own
  // icons: part of the bar, so that nothing of Gmail's can slide under the
  // buttons, as it can under buttons floating in a corner. The bar is
  // found by what has stayed put in Gmail for years - the banner and its
  // search form - and the buttons go back in whenever Gmail draws the bar
  // afresh. With less room they are icons only. With too little, or no
  // bar to be found, they float in the bottom left corner, as they do
  // when that corner (or the right) is chosen on the setup page. Menus and
  // messages open on the floating layer whichever it is: in the bar they
  // would be in Gmail's lower layers, under the mail.

  // How wide Gmail's search box stays beside the buttons with their words;
  // failing that, beside their icons; failing that, they float.
  const ROOM_WORDS = 400;
  const ROOM_ICONS = 240;
  // Gmail may draw its bar after this starts, or afresh later.
  const RECHECK_MS = 2000;

  function setPlace(place) {
    S.place = ['top', 'left', 'right', 'hidden'].includes(place) ? place : 'top';
    S.noRoom = null;
    placeDock();
  }

  function placeDock() {
    if (!els.dock) return;
    els.dock.hidden = S.place === 'hidden';
    if (S.place === 'hidden') closeMenu(root);
    let slot = S.place === 'top' ? hooks.topBarSlot() : null;
    let short = null; // the search form, when there was no room beside it
    if (slot) {
      if (!bar) {
        bar = mountShadow(HOST_IDS.bar, ns.styles.dock);
        bar.host.classList.add('gkb-bar');
      }
      if (bar.host.previousElementSibling !== slot.after) slot.after.after(bar.host);
      if (els.dock.parentNode !== bar.root) bar.root.appendChild(els.dock);
      els.dock.classList.add('top');
      els.dock.classList.remove('compact');
      const room = () => slot.form.getBoundingClientRect().width;
      if (room() < ROOM_WORDS) els.dock.classList.add('compact');
      if (room() < ROOM_ICONS) {
        short = slot.form;
        slot = null;
      }
    }
    if (!slot) {
      if (els.dock.parentNode !== root) root.appendChild(els.dock);
      els.dock.classList.remove('top', 'compact');
      if (bar && bar.host.isConnected) bar.host.remove();
    }
    els.dock.classList.toggle('right', !slot && S.place === 'right');
    S.inBar = !!slot;
    S.noRoom = short ? short.getBoundingClientRect().width : null;
  }

  // Looked at again when the window changes size (the room may have), and
  // every couple of seconds while the buttons belong in the bar but are
  // not in it: Gmail had not drawn it yet, or has drawn it afresh - or had
  // not yet given its search box its width, when there seemed to be no
  // room. That is tried again only once the box has grown, so a bar with
  // truly no room is not tried, and given up, over and over. The look is
  // a query or two; the buttons only move when they must.
  function watchBar() {
    let frame = 0;
    window.addEventListener('resize', () => {
      if (S.place !== 'top') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        S.noRoom = null;
        placeDock();
      });
    });
    setInterval(() => {
      if (S.place !== 'top') return;
      if (S.inBar) {
        if (!bar.host.isConnected) placeDock();
        return;
      }
      const slot = hooks.topBarSlot();
      if (slot && (S.noRoom === null || slot.form.getBoundingClientRect().width > S.noRoom + 40)) placeDock();
    }, RECHECK_MS);
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
      if (S.inBar) placeDock();
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
    if (S.inBar) placeDock();
  }

  async function toggleThreadMenu() {
    if (isMenuOpen(root)) {
      closeMenu(root);
      return;
    }
    // Once the trial or the licence is over, the board's licence screen
    // instead of the menu.
    const licence = ns.board.licence ? await ns.board.licence() : null;
    if (licence && licence.state === 'expired') {
      ns.board.open();
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
    openMenu(root, els.thread, items, { label: 'Board column', placement: S.inBar ? 'below' : 'above' });
  }

  async function moveOpenThread(col) {
    const id = S.threadId;
    const was = S.column;
    S.seq++; // a lookup still in flight predates this and must not win
    S.column = col;
    renderPill();
    if (col.chime) chime();
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

  ns.dock = { init, setPlace, columnsChanged };
})();

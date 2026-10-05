// ─────────────────────────────────────────────────────────────────────
// The phone app
//
// The extension's board, Notes and Calendar, full-screen, as the app
// itself: the same tabs, columns, cards, notes, search, editor, autosave
// and calendar, with the board's styles and a phone layout on top. On a
// phone the board shows one column at a time, swiped sideways; the notes
// open on the Scratchpad, under the search box; a folder or a search
// shows the list instead, and a note opens full-screen; the calendar is
// the week as two columns of days, swiped to the next week. A first visit opens on the
// notes; after that, on whichever tab was used last.
//
// A phone leaves pages without closing them, so whatever is pending is
// saved whenever the page is hidden; and Android's back gesture steps
// back through the notes - a note to the list, the list to the
// Scratchpad - through google.script.history.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { mountShadow } = ns.ui;

  // How long opening took, for finding out what is slow (the logo's menu,
  // under Advanced): from this page's start, which comes after Google's
  // own page around it.
  const marks = { code: performance.now() };
  const mark = name => { if (!(name in marks)) marks[name] = performance.now(); };
  const secs = ms => `${(ms / 1000).toFixed(1)} s`;
  function timingText() {
    const parts = [`page and code ${secs(marks.code)}`];
    if ('ready' in marks) parts.push(`ready to type ${secs(marks.ready)}`);
    if ('checked' in marks) parts.push(`checked with Gmail ${secs(marks.checked)}`);
    if ('listed' in marks) parts.push(`list up to date ${secs(marks.listed)}`);
    return `Opened in ${secs(marks.ready || marks.code)}: ${parts.join(', ')}.`;
  }

  const PHONE = `
:host { position: fixed !important; inset: 0 !important; }
.overlay { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }

@media (max-width: 760px) {
  /* The header: the mark, the three tabs, refresh and the column
     settings; gone while a note has the whole screen. On a small phone
     only the open tab says its name. */
  .bar { height: 56px; padding: 0 4px 0 12px; gap: 2px; }
  .brand-btn > span:not(.logo), .account, .updated { display: none; }
  .tabs { margin-left: 10px; min-width: 0; }
  .tab { padding: 0 12px 0 10px; }
  :host([data-view="note"]) .bar { display: none; }

  /* The board: one column to a screen, swiped sideways. Cards move with
     their ⋯ menu, since a finger cannot drag them. */
  .columns { scroll-snap-type: x mandatory; gap: 10px; padding: 4px 16px 12px; scroll-padding: 0 16px; }
  .column { flex: 0 0 calc(100vw - 44px); min-width: 0; max-width: none; scroll-snap-align: center; }

  .notes { flex-direction: column; gap: 0; padding: 0; }
  .notes[data-view="note"] .notes-folders, .notes[data-view="note"] .notes-list { display: none; }
  .notes[data-view="list"] .note-editor { display: none; }

  /* Home: the search box, and the scratchpad filling the rest. */
  .notes[data-view="home"] .notes-list { flex: none; }
  .notes[data-view="home"] .notes-scope, .notes[data-view="home"] .notes-items, .notes[data-view="home"] .notes-foot { display: none; }
  .notes[data-view="home"] .note-editor { margin: 0 12px 12px; border-radius: 22px; min-height: 0; }
  .notes[data-view="home"] .ne-title { padding: 14px 18px 6px; }
  .notes[data-view="home"] .ne-toolbar { margin: 0 10px; }
  .notes[data-view="home"] .ne-body { padding: 10px 18px 20vh; }
  .notes[data-view="home"] .ne-body[data-empty="1"]::before { left: 18px; right: 18px; }

  /* Folders: the tree, folded away behind a button that says where you
     are; open, it is the same tree as on a computer, nesting and all. */
  .notes-folders { flex: none; background: none; border-radius: 0; padding: 2px 12px 4px; }
  .folders-toggle {
    display: flex; align-items: center; gap: 10px; width: 100%; height: 46px; padding: 0 10px 0 14px;
    border-radius: 14px; background: var(--col); color: var(--fg); font-size: 15px; text-align: left;
  }
  .folders-toggle .icon { color: var(--fg-2); flex: none; }
  .ft-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ft-count { color: var(--fg-3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .notes[data-folders="open"] .folders-toggle { border-radius: 14px 14px 0 0; }
  .notes[data-folders="open"] .folders-toggle .icon:last-child { transform: rotate(180deg); }
  .notes:not([data-folders="open"]) .folders-head, .notes:not([data-folders="open"]) .folder-items { display: none; }
  .folders-head { background: var(--col); padding: 0 6px 0 16px; }
  .folder-items { flex: none; max-height: 55vh; background: var(--col); border-radius: 0 0 14px 14px; padding: 2px 8px 10px; }
  .folder-btn { height: 44px; }
  .folder-twisty { width: 34px; height: 44px; margin-right: 0; }
  .folder-items[data-nested] .folder-edit { padding-left: 44px; }
  .folder-items[data-nested] .folder-error { padding-left: 70px; }
  /* No hover on a phone: each folder's ⋯ is always there, next to its count. */
  .folder-menu { opacity: 1; right: 4px; }
  .folder-row .folder-count, .folder-row:hover .folder-count, .folder-row:focus-within .folder-count { visibility: visible; margin-right: 34px; }

  .notes-list { flex: 1; border-radius: 0; background: none; }
  .notes-tools { padding: 4px 12px 8px; }
  .notes-items { padding: 0 4px 12px; }
  .note-item { padding: 12px; }

  /* min-height: 0, or a long note grows past the screen, cut off, with
     nothing to scroll: its text box scrolls only if the editor stops at
     the screen's foot. */
  .note-editor { flex: 1; min-height: 0; border-radius: 0; box-shadow: none; }
  .ne-back { display: inline-flex; margin-right: 2px; }
  .ne-bar { padding: 6px 6px 0 4px; }
  .ne-title { padding: 6px 16px 4px; font-size: 22px; }
  .ne-toolbar { margin: 0 8px; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
  .ne-linkbar { margin: 4px 8px 0; }
  .ne-tablebar { margin: 4px 8px 0; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
  .ne-tablebar .spacer { display: none; }
  .ne-banner { margin: 4px 12px 0; }
  .ne-find { margin: 4px 12px 0; }
  .ne-body { padding: 10px 16px 40vh; font-size: 16px; }
  .ne-body[data-empty="1"]::before { left: 16px; }
}
@media (max-width: 480px) {
  .tab[aria-selected="false"] { gap: 0; padding: 0 10px; font-size: 0; }
}
`;

  // Apps Script's history, if there is one, used so that nothing it does -
  // or fails to do - can stop the app: the back gesture is a nicety.
  function historyApi() {
    const api = typeof google !== 'undefined' && google.script && google.script.history;
    if (!api) return null;
    const safe = fn => (...args) => {
      try { return api[fn](...args); } catch (err) { console.warn(`google.script.history.${fn}: ${err.message}`); return undefined; }
    };
    return { push: safe('push'), replace: safe('replace'), setChangeHandler: safe('setChangeHandler') };
  }

  const wide = () => !!(window.matchMedia && window.matchMedia('(min-width: 761px)').matches);

  function start() {
    // Without all its parts the app cannot work: the loader's list of
    // what did not load stays on the screen instead.
    if (window.__partsFailed && window.__partsFailed.length) return;
    const { host, root } = mountShadow('gkb-app-host', ns.styles.board + PHONE);
    const history = historyApi();
    // How many steps in from the Scratchpad the history holds, and whether
    // the back gesture is being followed right now.
    let depth = 0;
    let stepping = false;

    // Which folders are folded, which calendars show, on this phone. The
    // page is only ever opened by its owner, so there is no account to
    // key them by. The 'supermail.' prefix is the app's old name, kept so
    // prefs saved before the rename still count.
    const prefs = {
      get(name) {
        try { return JSON.parse(localStorage.getItem(`supermail.${name}`) || 'null'); } catch (err) { return null; }
      },
      set(name, value) {
        try { localStorage.setItem(`supermail.${name}`, JSON.stringify(value)); } catch (err) { /* storage off: not remembered */ }
      },
    };

    ns.boardFrame = {
      root,
      view: 'notes',
      timings: timingText,
      // On a computer, typing goes straight into the Scratchpad. (A phone
      // would only pop its keyboard up over it, so there it waits for a tap.)
      focus: wide(),
      // The script's own access covers the calendar: nothing to connect.
      calendar: { prefs, connect: null },
      notes: {
        prefs,
        // Each step in goes on the history, so the back gesture can undo it;
        // a step out taken in the app itself rewrites the top entry instead,
        // since nothing here can take an entry off.
        onViewChange(view) {
          host.dataset.view = view;
          const d = ns.notes.depth();
          if (history && !stepping) {
            if (d > depth) for (let i = depth + 1; i <= d; i++) history.push({ depth: i }, {}, '');
            else if (d < depth) history.replace({ depth: d }, {}, '');
          }
          depth = d;
        },
      },
    };

    if (history) {
      history.setChangeHandler(async e => {
        const target = (e && e.state && Number(e.state.depth)) || 0;
        stepping = true;
        try {
          while (ns.notes.depth() > target) {
            const before = ns.notes.depth();
            await ns.notes.back();
            if (ns.notes.depth() >= before) break; // an unsaved edit kept the note open
          }
        } finally {
          stepping = false;
        }
        // Not as far back as the gesture went: those steps go back on.
        depth = ns.notes.depth();
        for (let i = target + 1; i <= depth; i++) history.push({ depth: i }, {}, '');
      });
    }

    // A phone switches away without closing the page.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') ns.notes.flush();
      else if (ns.board.view() === 'notes') { if (ns.notes.isStale()) ns.notes.load(); }
      else if (ns.board.view() === 'calendar') { if (ns.calendar.isStale()) ns.calendar.load(); }
      else ns.board.refreshIfStale();
    });
    window.addEventListener('pagehide', () => ns.notes.flush());

    // One call to the script, sent before anything else (remote.js). With
    // the phone's copy of the notes, the app opens on that at once and the
    // call catches it up; without one (a first visit), it waits for it.
    const remote = ns.appRemote;
    const begun = remote.start();
    const show = () => {
      ns.board.open();
      const boot = document.getElementById('boot');
      if (boot) boot.remove();
      mark('ready');
    };
    const caughtUp = r => {
      mark('checked');
      if (r.otherAccount && window.__bootFailed) {
        window.__bootFailed('This phone had notes from another Google account, now cleared. Close the app and open it again.');
        return;
      }
      ns.notes.scratchFound(r.scratch);
    };
    let polls = 0;
    const listed = () => {
      if (ns.notes.loadedAt()) mark('listed');
      else if (++polls < 300) setTimeout(listed, 200);
    };
    listed();
    if (remote.hasCopy()) {
      show();
      // Offline, or the script unreachable: the copy carries on, and the
      // notes' own loading says what is wrong.
      return begun.then(caughtUp, err => console.warn(`The first call failed: ${err.message}`));
    }
    return begun.then(r => {
      show();
      caughtUp(r);
    }, err => {
      if (window.__bootFailed) window.__bootFailed(`Gmail could not be reached: ${err.message}`);
    });
  }

  function run() {
    try {
      start();
    } catch (err) {
      console.error(err);
      if (window.__bootFailed) window.__bootFailed(err.message, err.stack);
    }
  }

  ns.phoneApp = { start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

// ─────────────────────────────────────────────────────────────────────
// The phone app
//
// The extension's Notes view, full-screen: the same list, folders,
// search with the words marked, formatting editor, autosave and find,
// with the board's styles and a phone layout on top - one pane at a time,
// the list or the open note, the folder tree folded away behind a button.
//
// A phone leaves pages without closing them, so whatever is pending is
// saved whenever the page is hidden; and Android's back gesture goes from
// a note back to the list, through google.script.history.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, logo, mountShadow, toast } = ns.ui;

  const PHONE = `
:host { position: fixed !important; inset: 0 !important; }
.overlay { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.app-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px 20px; flex: none; }
.app-logo { display: flex; margin-right: 4px; }
.app-title { flex: 1; font-size: 20px; color: var(--fg); }

@media (max-width: 760px) {
  .app[data-view="note"] .app-head { display: none; }
  .notes { flex-direction: column; gap: 0; padding: 0; }
  .notes[data-view="note"] .notes-folders, .notes[data-view="note"] .notes-list { display: none; }
  .notes[data-view="list"] .note-editor { display: none; }

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

  .note-editor { flex: 1; border-radius: 0; box-shadow: none; }
  .ne-back { display: inline-flex; margin-right: 2px; }
  .ne-bar { padding: 6px 6px 0 4px; }
  .ne-title { padding: 6px 16px 4px; font-size: 22px; }
  .ne-toolbar { margin: 0 8px; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
  .ne-linkbar { margin: 4px 8px 0; }
  .ne-banner { margin: 4px 12px 0; }
  .ne-find { margin: 4px 12px 0; }
  .ne-body { padding: 10px 16px 40vh; font-size: 16px; }
  .ne-body[data-empty="1"]::before { left: 16px; }
  .notes-intro { display: none; }
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

  function start() {
    const { root } = mountShadow('gkb-app-host', ns.styles.board + PHONE);
    const history = historyApi();
    let noteOnHistory = false;

    const head = h('header', { class: 'app-head' },
      h('span', { class: 'app-logo' }, logo(28)),
      h('span', { class: 'app-title', text: 'Notes' }),
      h('button', {
        class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh', dataset: { key: 'app-refresh' },
        onclick: () => ns.notes.load({ force: true }),
      }, icon('refresh')));
    const app = h('div', { class: 'overlay app', dataset: { view: 'list' } }, head);

    ns.notes.init({
      root,
      onStateError: err => toast(root, err.message, { kind: 'error' }),
      onLoaded() {},
      closeBoard() {},
      barChanged() {},
      // Which folders are folded, on this phone. The page is only ever
      // opened by its owner, so there is no account to key it by.
      prefs: {
        get(name) {
          try { return JSON.parse(localStorage.getItem(`supermail.${name}`) || 'null'); } catch (err) { return null; }
        },
        set(name, value) {
          try { localStorage.setItem(`supermail.${name}`, JSON.stringify(value)); } catch (err) { /* storage off: not remembered */ }
        },
      },
      onViewChange(view) {
        app.dataset.view = view;
        if (!history) return;
        // A note on the history, so Android's back gesture closes it.
        if (view === 'note') {
          history.push({ note: 1 }, {}, '');
          noteOnHistory = true;
        } else if (noteOnHistory) {
          history.replace({}, {}, '');
          noteOnHistory = false;
        }
      },
    });
    app.appendChild(ns.notes.element());
    root.appendChild(app);
    const boot = document.getElementById('boot');
    if (boot) boot.remove();

    if (history) {
      history.setChangeHandler(e => {
        if (e && e.state && e.state.note) return;
        if (!ns.notes.isOpen()) return;
        ns.notes.closeNote().then(() => {
          // Not closed (an unsaved edit): back on the history it goes.
          if (ns.notes.isOpen()) history.push({ note: 1 }, {}, '');
        });
      });
    }

    // Ctrl+S and F3, for a keyboard.
    root.addEventListener('keydown', e => ns.notes.handleKey(e));
    // "Saved 5s ago".
    setInterval(() => ns.notes.tick(), 5000);
    // A phone switches away without closing the page.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') ns.notes.flush();
      else if (ns.notes.isStale()) ns.notes.load();
    });
    window.addEventListener('pagehide', () => ns.notes.flush());

    ns.notes.load();
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

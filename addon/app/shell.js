// ─────────────────────────────────────────────────────────────────────
// The phone app
//
// The extension's Notes view, full-screen: the same list, folders,
// search with the words marked, formatting editor, autosave and find,
// with the board's styles and a phone layout on top - one pane at a time,
// the list or the open note, folders as a row of chips.
//
// A phone leaves pages without closing them, so whatever is pending is
// saved whenever the page is hidden; and Android's back gesture goes from
// a note back to the list, through google.script.history.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, mountShadow, toast } = ns.ui;

  const PHONE = `
:host { position: fixed !important; inset: 0 !important; }
.overlay { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.app-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px 20px; flex: none; }
.app-title { flex: 1; font-size: 20px; color: var(--fg); }

@media (max-width: 760px) {
  .app[data-view="note"] .app-head { display: none; }
  .notes { flex-direction: column; gap: 0; padding: 0; }
  .notes[data-view="note"] .notes-folders, .notes[data-view="note"] .notes-list { display: none; }
  .notes[data-view="list"] .note-editor { display: none; }

  /* Folders: a row of chips above the list. */
  .notes-folders { flex: none; flex-direction: row; align-items: center; gap: 4px; padding: 2px 8px 6px; background: none; border-radius: 0; overflow-x: auto; scrollbar-width: none; }
  .folders-head { order: 2; padding: 0; }
  .folders-head h2 { display: none; }
  .folder-items { flex: none; flex-direction: row; gap: 6px; padding: 0; overflow: visible; }
  .folder-row { flex: none; padding-left: 0; }
  .folder-btn { height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid var(--border-strong); white-space: nowrap; }
  .folder-btn[aria-current="true"] { border-color: transparent; }
  .folder-title { overflow: visible; }
  .folder-count, .folder-btn .icon { display: none; }
  .folder-menu { display: none; position: static; opacity: 1; }
  .folder-row:has(.folder-btn[aria-current="true"]) .folder-menu { display: inline-flex; background: none; color: var(--fg-2); }
  .folder-row.editing { flex: 0 0 82vw; }

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

  function start() {
    const { root } = mountShadow('gkb-app-host', ns.styles.board + PHONE);
    const history = typeof google !== 'undefined' && google.script && google.script.history;

    const head = h('header', { class: 'app-head' },
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
      onViewChange(view) {
        app.dataset.view = view;
        // A note on the history, so Android's back gesture closes it.
        if (view === 'note' && history) history.push({ note: 1 }, {}, '');
        if (view === 'list' && history) history.replace({}, {}, '');
      },
    });
    app.appendChild(ns.notes.element());
    root.appendChild(app);

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

  ns.phoneApp = { start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

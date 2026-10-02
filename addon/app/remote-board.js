// ─────────────────────────────────────────────────────────────────────
// The phone app's first column layout
//
// The board keeps its column layout in its synced settings, which here
// are the app's own. Until it has one, the extension's default columns
// would bring back "_Board/Waiting" as a fresh, empty label for someone
// whose column is "_Board/Waiting on others"; so the first layout is
// the board's labels as Gmail has them - as the phone panel reads them.
// With no board labels at all, the usual columns, made as in Chrome.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = globalThis.gkb;
  const { store, logic, KEYS } = ns;
  const saved = store.loadColumns;

  store.loadColumns = async account => {
    const key = KEYS.columns(account);
    if ((await chrome.storage.sync.get(key))[key]) return saved(account);
    const fromLabels = await ns.appRemote.call('appBoardColumns');
    return logic.normaliseColumns(fromLabels || undefined);
  };
})();

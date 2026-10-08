// ─────────────────────────────────────────────────────────────────────
// The phone app's column layout
//
// The board's layout is Gmail's (store.loadColumns), the same as the
// extension's. The app's own copy, in its settings, is never the first
// layout put into Gmail: it may be one from before the layout was shared,
// older than the one in Chrome - so until Gmail has one, the app goes on
// with its copy, and the first comes from the extension or from saving
// the columns here.
//
// With no copy either, the extension's default columns would bring back
// "_Board/Waiting" as a fresh, empty label for someone whose column is
// "_Board/Waiting on others"; so the first columns are the board's labels
// as Gmail has them - as the phone panel reads them. With no board labels
// at all, the usual columns, made as in Chrome.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = globalThis.gkb;
  const { store, logic, KEYS } = ns;
  const saved = store.loadColumns;

  store.loadColumns = (account, options = {}) => saved(account, {
    firstWrite: false,
    fallback: async () => logic.normaliseColumns((await ns.appRemote.firstColumns()) || undefined),
    ...options,
  });
})();

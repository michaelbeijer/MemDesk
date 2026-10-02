// ─────────────────────────────────────────────────────────────────────
// Content-script entry point
//
// Last in the manifest's list, so every module above has registered on
// the shared namespace by the time this runs.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { KEYS } = ns;

  // Gmail embeds itself in iframes for some panels; only the top-level
  // page gets a board.
  if (window.top !== window) return;

  ns.dock.init();

  // Tells the service worker this tab is Gmail, so the toolbar button can
  // find it later without the "tabs" permission.
  ns.api.hello();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ns.api.hello();
  });

  // From the toolbar button and the keyboard shortcut, via the worker.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'toggle-board') return false;
    if (msg.open) ns.board.open();
    else ns.board.toggle();
    // Answering matters: an unanswered message rejects in the worker,
    // which would read as "not a Gmail tab" and open another one.
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes[KEYS.dockPosition]) ns.dock.setPosition(changes[KEYS.dockPosition].newValue);
    const account = ns.hooks.getAccount();
    if (account && changes[KEYS.columns(account)]) {
      ns.board.columnsChanged(changes[KEYS.columns(account)].newValue);
      ns.dock.columnsChanged();
    }
    const prefix = account && KEYS.cardPrefix(account);
    if (prefix && Object.keys(changes).some(k => k.startsWith(prefix))) {
      ns.board.cardEditsChanged(changes, prefix);
    }
  });
})();

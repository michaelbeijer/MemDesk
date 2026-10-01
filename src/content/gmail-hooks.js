// ─────────────────────────────────────────────────────────────────────
// Gmail page hooks
//
// Every assumption about Gmail's own page lives in this one file: how to
// tell which account a tab belongs to, how to open a thread, and how to
// tell which thread is open. None of it is a documented interface. Gmail
// changes its markup without notice, so each hook fails quietly - the
// worst case is that a convenience disappears, never that the board
// breaks - and the README lists them as the known fragile points.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const util = ns.util;

  // ── Account ──────────────────────────────────────────────────────────

  // The title is the most stable signal: it has carried the account
  // address for well over a decade. The avatar's aria-label is the
  // fallback for the moment during load before the title is set.
  function getAccount() {
    const fromTitle = util.accountFromTitle(document.title);
    if (fromTitle) return fromTitle;
    const avatar = document.querySelector('a[aria-label^="Google Account"]');
    return avatar ? util.accountFromAriaLabel(avatar.getAttribute('aria-label')) : '';
  }

  function getAccountIndex() {
    return util.accountIndexFromPath(location.pathname);
  }

  // ── Opening threads ──────────────────────────────────────────────────

  // API thread ids are the legacy hex ids, and Gmail still accepts them in
  // the hash and redirects to its newer opaque ids. "#all/" rather than
  // "#inbox/" because a board thread may well be archived.
  function openThread(threadId) {
    location.hash = '#all/' + encodeURIComponent(threadId);
  }

  function threadUrl(threadId) {
    return `${location.origin}/mail/u/${getAccountIndex()}/#all/${encodeURIComponent(threadId)}`;
  }

  // ── Currently open thread ────────────────────────────────────────────

  function isVisible(el) {
    return !!(el && el.getClientRects().length);
  }

  // Gmail renders the open conversation's subject as an h2 carrying
  // data-legacy-thread-id. It also keeps previously opened conversations
  // in the DOM, hidden, which is why only a visible one counts. List rows
  // can carry the same attribute, so the bare-attribute fallback is only
  // trusted when the URL looks like a single conversation.
  function getOpenThreadId() {
    for (const el of document.querySelectorAll('h2[data-legacy-thread-id]')) {
      if (isVisible(el)) return el.getAttribute('data-legacy-thread-id') || '';
    }
    if (/#[^?]*\/[A-Za-z0-9]{16,}$/.test(location.hash)) {
      for (const el of document.querySelectorAll('[role="main"] [data-legacy-thread-id]')) {
        if (isVisible(el)) return el.getAttribute('data-legacy-thread-id') || '';
      }
    }
    return '';
  }

  // Polls once a second while the tab is visible. Gmail is a single-page
  // app with no event for "a conversation opened", and a MutationObserver
  // on its whole tree costs far more than one querySelectorAll a second.
  function watchOpenThread(onChange) {
    let current = null;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      let id = '';
      try { id = getOpenThreadId(); } catch { id = ''; }
      if (id !== current) {
        current = id;
        onChange(id);
      }
    };
    check();
    const timer = setInterval(check, 1000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }

  ns.hooks = { getAccount, getAccountIndex, openThread, threadUrl, getOpenThreadId, watchOpenThread };
})();

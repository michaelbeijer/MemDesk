// ─────────────────────────────────────────────────────────────────────
// Messaging to the service worker
//
// The content script has no token and no network access to the Gmail
// API of its own; every call is a message to the background worker,
// which answers {ok:true,data} or {ok:false,error:{code,message}}. This
// file turns the failure half of that into thrown ApiErrors so the UI
// code can use ordinary try/catch.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  class ApiError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  // Codes the board answers with a panel of its own instead of a toast.
  const STATE_CODES = new Set(['not_configured', 'auth_required', 'account_mismatch']);

  async function send(msg) {
    let res;
    try {
      res = await chrome.runtime.sendMessage(msg);
    } catch (err) {
      // Reloading or updating the extension orphans the content scripts
      // already running in open tabs; they can no longer reach the worker.
      throw new ApiError('extension_reloaded', 'The extension was updated. Reload this Gmail tab.');
    }
    if (!res) throw new ApiError('no_response', 'No reply from the extension.');
    if (!res.ok) {
      const e = res.error || {};
      throw new ApiError(e.code || 'unknown', e.message || 'Something went wrong.');
    }
    return res.data;
  }

  function gmail(method, path, query, body) {
    return send({ type: 'gmail', account: ns.hooks.getAccount(), method, path, query, body });
  }

  function connect() {
    return send({ type: 'connect', account: ns.hooks.getAccount() });
  }

  function openOptions() {
    return send({ type: 'open-options' });
  }

  function hello() {
    return send({ type: 'hello' }).catch(() => {});
  }

  ns.api = { ApiError, STATE_CODES, gmail, connect, openOptions, hello };
})();

// ─────────────────────────────────────────────────────────────────────
// Options page
//
// Shows the two values Google Cloud needs (extension ID and redirect URI),
// stores the OAuth client ID, and can run one interactive sign-in to
// prove the whole chain works before going anywhere near Gmail.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const { APP_NAME, KEYS } = globalThis.gkb;
  // A store build carries its publisher's OAuth client; a copy from the
  // repository does not, and its user brings their own.
  const BUILT_IN = !!String(globalThis.gkb.BUILT_IN_CLIENT_ID || '').trim();
  const $ = id => document.getElementById(id);

  // Client IDs look like "1234567890-abc123.apps.googleusercontent.com".
  // Anything else is almost certainly the client secret or a project id
  // pasted into the wrong box, which is worth saying before auth fails
  // with a far less helpful message.
  const CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

  // ── Branding ─────────────────────────────────────────────────────────

  document.title = `${APP_NAME} – Setup`;
  $('app-name').textContent = APP_NAME;
  for (const el of document.querySelectorAll('[data-app-name]')) el.textContent = APP_NAME;

  // ── Identifiers ──────────────────────────────────────────────────────

  $('ext-id').textContent = chrome.runtime.id;
  $('redirect-uri').textContent = chrome.identity.getRedirectURL();

  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = $(btn.dataset.copy).textContent;
      try {
        await navigator.clipboard.writeText(text);
        flash(btn, 'Copied');
      } catch {
        // Clipboard access can be refused; selecting the text is the
        // next best thing.
        const range = document.createRange();
        range.selectNodeContents($(btn.dataset.copy));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        flash(btn, 'Press Ctrl+C');
      }
    });
  }

  function flash(btn, text) {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = old; }, 1600);
  }

  // ── Client ID ────────────────────────────────────────────────────────

  function setStatus(el, text, kind = '') {
    el.textContent = text;
    el.className = `status ${kind}`.trim();
  }

  chrome.storage.sync.get(KEYS.clientId).then(got => {
    const own = got[KEYS.clientId] || '';
    $('client-id').value = own;
    if (BUILT_IN) {
      // One button; your own project only for those who want one (and
      // open already for anyone who has saved one).
      $('connect-card').hidden = false;
      $('own-project').open = !!own;
      if (!own) setStatus($('client-status'), 'Not needed: this copy has one built in. Save one only to use your own project.', 'muted');
    } else {
      $('own-project').classList.add('plain');
      if (!own) setStatus($('client-status'), 'No client ID saved yet.', 'muted');
    }
  });

  $('client-form').addEventListener('submit', async e => {
    e.preventDefault();
    const value = $('client-id').value.trim();
    const status = $('client-status');
    if (!value) {
      await chrome.storage.sync.remove(KEYS.clientId);
      setStatus(status, 'Client ID removed.', 'muted');
      return;
    }
    await chrome.storage.sync.set({ [KEYS.clientId]: value });
    if (CLIENT_ID_RE.test(value)) {
      setStatus(status, 'Saved. Use “Test connection” to check it.', 'ok');
    } else {
      setStatus(status, 'Saved, but that does not look like a client ID (it should end in .apps.googleusercontent.com).', 'warn');
    }
  });

  // ── Connect, and Test connection ─────────────────────────────────────
  //
  // The same thing twice: Google's sign-in, then the mailbox's address
  // read back from Gmail. It sends nothing and changes nothing.

  $('connect').addEventListener('click', () => connect($('connect'), $('connect-status'), () => { $('connect-next').hidden = false; }));
  $('test').addEventListener('click', () => connect($('test'), $('test-status')));

  async function connect(btn, status, onConnected) {
    btn.disabled = true;
    setStatus(status, 'Waiting for Google…', 'muted');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'connect', account: '' });
      if (res && res.ok) {
        setStatus(status, `Connected as ${res.data.email}`, 'ok');
        if (onConnected) onConnected();
      } else {
        const err = (res && res.error) || {};
        const text = err.code === 'not_configured'
          ? 'Save a client ID first.'
          : `Not connected: ${err.message || 'no reply from the extension'}`;
        setStatus(status, text, 'error');
      }
    } catch (err) {
      setStatus(status, `Not connected: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ── Dock position ────────────────────────────────────────────────────

  chrome.storage.sync.get(KEYS.dockPosition).then(got => {
    const v = got[KEYS.dockPosition] || 'left';
    const input = document.querySelector(`input[name="dock"][value="${v}"]`);
    if (input) input.checked = true;
  });

  for (const input of document.querySelectorAll('input[name="dock"]')) {
    input.addEventListener('change', () => {
      if (input.checked) chrome.storage.sync.set({ [KEYS.dockPosition]: input.value });
    });
  }

  // ── Shortcut ─────────────────────────────────────────────────────────

  chrome.commands.getAll().then(cmds => {
    const cmd = cmds.find(c => c.name === 'toggle-board');
    $('shortcut').textContent = (cmd && cmd.shortcut) || 'not set';
  });

  // chrome:// pages cannot be linked to, only opened through the API.
  $('shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
})();

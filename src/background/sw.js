// ─────────────────────────────────────────────────────────────────────
// Background service worker: OAuth and the Gmail API proxy
//
// Content scripts never see a token. They send {type:'gmail', …} messages
// (or {type:'google', …} for the calendar) and this worker attaches the
// bearer token, makes the call, and returns plain JSON. That keeps the
// token out of the Gmail page entirely, and gives one place to enforce
// what the extension is allowed to ask for.
//
// Tokens come from the implicit grant via launchWebAuthFlow and are kept
// in chrome.storage.session: memory-only, gone when the browser closes,
// and not readable by content scripts at the default access level.
// ─────────────────────────────────────────────────────────────────────

importScripts('/src/shared/ns.js', '/src/lib/util.js', '/src/lib/notes-logic.js', '/src/lib/auth.js', '/src/lib/calendar-logic.js');

const { KEYS } = self.gkb;
const notesLogic = self.gkb.notesLogic;
const auth = self.gkb.auth;
const calendarLogic = self.gkb.calendarLogic;

// After a silent renewal fails, further silent attempts for the same
// account are skipped for a minute. Without this, every thread opened
// while signed out would spin up a hidden auth page and wait the full
// eight-second timeout before the board could say "Connect Gmail".
const SILENT_BACKOFF_MS = 60 * 1000;

const GMAIL_HOME = 'https://mail.google.com/mail/';

// ── Errors ───────────────────────────────────────────────────────────

class ProxyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function errorPayload(err) {
  if (err instanceof ProxyError) return { code: err.code, message: err.message };
  return { code: 'internal', message: (err && err.message) || String(err) };
}

// ── Two sign-ins ─────────────────────────────────────────────────────
//
// Gmail's, for the board and the notes, and the calendar's, for Google
// Calendar and Google Tasks. They are kept apart so that the board and
// the notes never need a new "Allow" from someone who has not opened the
// Calendar tab, and so that trouble with one never stops the other. Each
// has its own token and its own error codes; the calendar's never put the
// board's "Connect Gmail" panel up.

const KINDS = {
  gmail: {
    scope: auth.SCOPE,
    storageKey: KEYS.token,
    verify: verifyGmailToken,
    authCode: 'auth_required',
    mismatchCode: 'account_mismatch',
    signedOut: 'Gmail is not connected in this browser yet.',
  },
  calendar: {
    scope: calendarLogic.SCOPES,
    storageKey: KEYS.calendarToken,
    verify: verifyCalendarToken,
    authCode: 'calendar_auth_required',
    mismatchCode: 'calendar_mismatch',
    signedOut: 'Google Calendar is not connected in this browser yet.',
  },
};

// ── Token cache ──────────────────────────────────────────────────────

const memoryTokens = new Map();   // kind|account → { accessToken, expiresAt }
const inflight = new Map();       // kind|account|mode → Promise<token>
const silentFailedAt = new Map(); // kind|account → ms

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

async function readCachedToken(account, kind = 'gmail') {
  const now = Date.now();
  const mem = memoryTokens.get(`${kind}|${account}`);
  if (mem && mem.expiresAt > now) return mem.accessToken;

  // The worker is torn down after ~30s idle, taking the Map with it.
  // Session storage outlives the worker but not the browser session.
  const key = KINDS[kind].storageKey(account);
  const got = await chrome.storage.session.get(key);
  const rec = got[key];
  if (rec && rec.accessToken && rec.expiresAt > now) {
    memoryTokens.set(`${kind}|${account}`, rec);
    return rec.accessToken;
  }
  return '';
}

async function storeToken(account, accessToken, expiresAt, kind = 'gmail') {
  const rec = { accessToken, expiresAt };
  memoryTokens.set(`${kind}|${account}`, rec);
  await chrome.storage.session.set({ [KINDS[kind].storageKey(account)]: rec });
}

async function dropToken(account, kind = 'gmail') {
  memoryTokens.delete(`${kind}|${account}`);
  await chrome.storage.session.remove(KINDS[kind].storageKey(account));
}

// ── Auth flow ────────────────────────────────────────────────────────

// The user's own client, if they saved one on the setup page; otherwise
// the one built into a store build (empty in a copy from the repository).
async function getClientId() {
  const got = await chrome.storage.sync.get(KEYS.clientId);
  return String(got[KEYS.clientId] || '').trim() || String(globalThis.gkb.BUILT_IN_CLIENT_ID || '').trim();
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Runs one launchWebAuthFlow and returns { accessToken, expiresAt }.
// `account` is used as login_hint; when empty (the options page's test
// button) Google shows its account chooser instead.
async function runAuthFlow(account, interactive, kind = 'gmail') {
  const k = KINDS[kind];
  const clientId = await getClientId();
  if (!clientId) {
    throw new ProxyError('not_configured', 'Add your OAuth client ID on the setup page first.');
  }

  const state = randomState();
  const url = auth.buildAuthUrl({
    clientId,
    redirectUri: chrome.identity.getRedirectURL(),
    loginHint: account,
    silent: !interactive,
    state,
    scope: k.scope,
  });

  const opts = interactive
    ? { url, interactive: true }
    // abortOnLoadForNonInteractive:false lets Google's prompt=none page
    // bounce through its own redirects before Chrome gives up on it.
    : { url, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 };

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow(opts);
  } catch (err) {
    throw new ProxyError(k.authCode, (err && err.message) || 'Sign-in did not complete.');
  }

  const parsed = auth.parseAuthResponse(redirect);
  if (parsed.error) {
    throw new ProxyError(k.authCode, parsed.errorDescription || parsed.error);
  }
  if (parsed.state !== state) {
    throw new ProxyError(k.authCode, 'Sign-in response did not match the request.');
  }
  return { accessToken: parsed.accessToken, expiresAt: auth.tokenExpiry(parsed.expiresIn) };
}

// A token is only trusted once Google itself confirms whose account it
// opens. login_hint is a hint, not a constraint: someone signed in to
// two Google accounts can pick the other one in the chooser, and acting
// on the wrong mailbox would be far worse than an error.
function checkAccount(actual, expected, code, what) {
  if (expected && normEmail(actual) !== normEmail(expected)) {
    throw new ProxyError(code, `Google signed in as ${normEmail(actual)}, but this Gmail tab is ${normEmail(expected)}.${what}`);
  }
  return normEmail(actual);
}

async function verifyGmailToken(accessToken, expected) {
  const res = await fetch(auth.buildApiUrl('profile'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await httpError(res);
  const profile = await res.json();
  return checkAccount(profile.emailAddress, expected, 'account_mismatch', '');
}

// The calendar's token cannot read Gmail; it says whose it is through
// the "email" permission it asks for alongside.
async function verifyCalendarToken(accessToken, expected) {
  const res = await fetch(calendarLogic.USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await httpError(res);
  const info = await res.json();
  return checkAccount(info.email, expected, 'calendar_mismatch', ' The calendar shown is always the one of the account open in this tab.');
}

// Returns a verified token for `account`, renewing silently if allowed.
async function getToken(account, { interactive = false, kind = 'gmail' } = {}) {
  const k = KINDS[kind];
  const acct = normEmail(account);
  if (!interactive && acct) {
    const cached = await readCachedToken(acct, kind);
    if (cached) return { accessToken: cached, email: acct };
    const failedAt = silentFailedAt.get(`${kind}|${acct}`) || 0;
    if (Date.now() - failedAt < SILENT_BACKOFF_MS) {
      throw new ProxyError(k.authCode, k.signedOut);
    }
  }

  // A board refresh fires several API calls at once. Without sharing the
  // in-flight promise each would launch its own auth flow.
  const key = `${kind}|${acct}|${interactive ? 'i' : 's'}`;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let flow;
    try {
      flow = await runAuthFlow(acct, interactive, kind);
    } catch (err) {
      if (!interactive && acct && err.code === k.authCode) silentFailedAt.set(`${kind}|${acct}`, Date.now());
      throw err;
    }
    const email = await k.verify(flow.accessToken, acct);
    await storeToken(email, flow.accessToken, flow.expiresAt, kind);
    silentFailedAt.delete(`${kind}|${email}`);
    return { accessToken: flow.accessToken, email };
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// ── Gmail proxy ──────────────────────────────────────────────────────

async function httpError(res) {
  let message = `${res.status} ${res.statusText || ''}`.trim();
  try {
    const json = await res.json();
    if (json && json.error && json.error.message) message = json.error.message;
  } catch { /* body was not JSON; the status line will do */ }
  return new ProxyError(`http_${res.status}`, message);
}

async function gmailFetch(accessToken, { method, path, query, body }) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
  if (body !== undefined && body !== null && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(auth.buildApiUrl(path, query), init);
}

async function handleGmail(msg) {
  const method = String(msg.method || 'GET').toUpperCase();
  const path = String(msg.path || '');
  const account = normEmail(msg.account);

  // Policy before anything else, so a refused request never costs a
  // token renewal.
  if (!auth.isAllowedRequest(method, path, msg.body)) {
    throw new ProxyError('not_allowed', `${method} ${path} is not something this extension does.`);
  }
  if (!account) {
    throw new ProxyError('auth_required', 'Could not tell which Gmail account this tab belongs to.');
  }

  // Trash is for notes only. The request cannot prove that, so the
  // message's own headers are read first: no note header, no trash.
  const checkId = auth.noteCheckId(method, path);
  if (checkId) {
    const meta = await callGmail(account, {
      method: 'GET', path: `messages/${checkId}`,
      query: { format: 'metadata', metadataHeaders: [notesLogic.NOTE_HEADER] },
    });
    if (!notesLogic.noteFromMessage(meta).own) {
      throw new ProxyError('not_allowed', 'Only notes can be moved to Trash from here.');
    }
  }

  // Label deletion is for empty notes folders. The label's own counts and
  // the full label list are read here, and the notes label's name comes
  // from this extension's storage - none of it from the request.
  const labelId = auth.folderDeleteId(method, path);
  if (labelId) {
    const [label, all, inside, stored] = await Promise.all([
      callGmail(account, { method: 'GET', path: `labels/${labelId}` }),
      callGmail(account, { method: 'GET', path: 'labels' }),
      callGmail(account, { method: 'GET', path: 'messages', query: { labelIds: labelId, maxResults: 1 } }),
      chrome.storage.sync.get(KEYS.notes(account)),
    ]);
    const root = (stored[KEYS.notes(account)] || {}).label || notesLogic.DEFAULT_LABEL;
    const live = ((inside && inside.messages) || []).length;
    if (!notesLogic.isDeletableFolder(label, root, (all && all.labels) || [], live)) {
      throw new ProxyError('not_allowed', 'Only an empty notes folder can be deleted from here.');
    }
  }

  return callGmail(account, { method, path, query: msg.query, body: msg.body });
}

async function callGmail(account, req) {
  let { accessToken } = await getToken(account);
  let res = await gmailFetch(accessToken, req);

  // A 401 means the token was revoked or expired early. One silent retry
  // with a fresh token covers that; a second 401 is a real problem.
  if (res.status === 401) {
    await dropToken(account);
    ({ accessToken } = await getToken(account));
    res = await gmailFetch(accessToken, req);
    if (res.status === 401) {
      await dropToken(account);
      throw new ProxyError('auth_required', 'Gmail rejected the sign-in. Connect again.');
    }
  }

  if (!res.ok) throw await httpError(res);
  if (res.status === 204) return null;
  return res.json();
}

// ── Calendar and Tasks proxy ─────────────────────────────────────────
//
// Read-only, with the calendar's own token: the calendar list, a
// calendar's events, the task lists and a list's tasks - nothing else
// (calendarLogic.isAllowedRequest), and the token could not change
// anything if it tried.

async function handleGoogle(msg) {
  const service = String(msg.service || '');
  const path = String(msg.path || '');
  const account = normEmail(msg.account);
  if (!calendarLogic.isAllowedRequest(service, 'GET', path)) {
    throw new ProxyError('not_allowed', `GET ${service} ${path} is not something this extension does.`);
  }
  if (!account) {
    throw new ProxyError('calendar_auth_required', 'Could not tell which Google account this tab belongs to.');
  }
  const url = calendarLogic.buildUrl(service, path, msg.query);
  const send = token => fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  let { accessToken } = await getToken(account, { kind: 'calendar' });
  let res = await send(accessToken);
  if (res.status === 401) {
    await dropToken(account, 'calendar');
    ({ accessToken } = await getToken(account, { kind: 'calendar' }));
    res = await send(accessToken);
    if (res.status === 401) {
      await dropToken(account, 'calendar');
      throw new ProxyError('calendar_auth_required', 'Google rejected the sign-in. Connect again.');
    }
  }
  if (!res.ok) {
    const err = await httpError(res);
    // Google's consent screen lets people untick Calendar or Tasks.
    if (res.status === 403 && /insufficient.*scope/i.test(err.message)) {
      throw new ProxyError('calendar_scope', 'It was not allowed when you connected. Connect again, and tick it on Google’s page.');
    }
    throw err;
  }
  return res.json();
}

async function handleConnect(msg) {
  const account = normEmail(msg.account);
  const kind = msg.kind === 'calendar' ? 'calendar' : 'gmail';
  if (account) {
    await dropToken(account, kind);
    silentFailedAt.delete(`${kind}|${account}`);
  }
  const { email } = await getToken(account, { interactive: true, kind });
  return { email };
}

// ── Gmail tab registry ───────────────────────────────────────────────
//
// The toolbar button and the shortcut need to find a Gmail tab, but
// reading tab URLs would need the "tabs" permission (shown to the user as
// "read your browsing history"). Instead each Gmail content script checks
// in, and the worker remembers which tabs did.

async function rememberGmailTab(tab) {
  if (!tab || tab.id === undefined) return;
  const got = await chrome.storage.session.get(KEYS.gmailTabs);
  const tabs = (got[KEYS.gmailTabs] || []).filter(t => t.id !== tab.id);
  tabs.unshift({ id: tab.id, windowId: tab.windowId, seen: Date.now() });
  await chrome.storage.session.set({ [KEYS.gmailTabs]: tabs.slice(0, 20) });
}

async function knownGmailTabs() {
  const got = await chrome.storage.session.get(KEYS.gmailTabs);
  return got[KEYS.gmailTabs] || [];
}

// If the active tab is Gmail (its content script answers), toggle the
// board there. Otherwise bring the most recently used Gmail tab forward
// and open the board in it, or open Gmail if there is none.
async function toggleBoard(tab) {
  if (tab && tab.id !== undefined) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-board' });
      return;
    } catch { /* no content script in that tab: not Gmail, or not reloaded */ }
  }

  for (const known of await knownGmailTabs()) {
    try {
      const t = await chrome.tabs.get(known.id);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      await chrome.tabs.sendMessage(t.id, { type: 'toggle-board', open: true });
      return;
    } catch { /* tab closed or navigated away; try the next one */ }
  }

  await chrome.tabs.create({ url: GMAIL_HOME });
}

// ── Wiring ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages and content scripts can reach
  // onMessage (there is no externally_connectable), but say so explicitly.
  if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return false;

  const reply = promise => {
    promise.then(
      data => sendResponse({ ok: true, data: data === undefined ? null : data }),
      err => sendResponse({ ok: false, error: errorPayload(err) })
    );
    return true; // keep the channel open for the async reply
  };

  switch (msg.type) {
    case 'gmail': return reply(handleGmail(msg));
    case 'google': return reply(handleGoogle(msg));
    case 'connect': return reply(handleConnect(msg));
    case 'open-options': return reply(chrome.runtime.openOptionsPage());
    case 'hello': return reply(rememberGmailTab(sender.tab));
    default:
      sendResponse({ ok: false, error: { code: 'unknown_message', message: String(msg.type) } });
      return false;
  }
});

chrome.action.onClicked.addListener(tab => { toggleBoard(tab); });

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-board') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  toggleBoard(tab);
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// ─────────────────────────────────────────────────────────────────────
// OAuth and request policy (pure)
//
// The service worker does the actual launchWebAuthFlow and fetch calls;
// this file holds the parts worth testing without a browser: building the
// authorisation URL, reading the token back out of the redirect fragment,
// and deciding which Gmail API calls the proxy will make at all.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const notes = (typeof module === 'object' && module.exports) ? require('./notes-logic.js') : ns.notesLogic;

  const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';

  // Google access tokens last an hour. Treating them as expired five
  // minutes early means a token is never handed out moments before it
  // dies halfway through a board refresh.
  const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

  // ── Authorisation URL ────────────────────────────────────────────────

  // include_granted_scopes is deliberately false. Google treats every
  // OAuth client in a Cloud project as one app, and this one shares a
  // project with the dashboard, which holds a gmail.metadata grant. With
  // incremental auth switched on, that grant would be folded into this
  // token - and the Gmail API applies metadata-scope restrictions to any
  // token carrying gmail.metadata, even alongside gmail.modify. The visible
  // symptom would be "Metadata scope does not support 'q' parameter" the
  // first time the column search ran. Asking for exactly one scope avoids
  // that whole class of surprise.
  function buildAuthUrl({ clientId, redirectUri, loginHint, silent, state }) {
    const p = new URLSearchParams();
    p.set('client_id', clientId);
    p.set('response_type', 'token');
    p.set('redirect_uri', redirectUri);
    p.set('scope', SCOPE);
    p.set('include_granted_scopes', 'false');
    if (loginHint) p.set('login_hint', loginHint);
    if (silent) p.set('prompt', 'none');
    if (state) p.set('state', state);
    return `${AUTH_ENDPOINT}?${p.toString()}`;
  }

  // ── Redirect parsing ─────────────────────────────────────────────────

  // The implicit grant returns everything in the fragment:
  //   https://<id>.chromiumapp.org/#access_token=…&expires_in=3599&…
  // Errors can arrive in either the fragment or the query string depending
  // on how early Google rejected the request, so both are read.
  function parseAuthResponse(redirectUrl) {
    const out = { accessToken: '', expiresIn: 0, error: '', errorDescription: '', scope: '', state: '' };
    if (!redirectUrl) return { ...out, error: 'no_redirect' };

    let url;
    try { url = new URL(redirectUrl); } catch { return { ...out, error: 'bad_redirect' }; }

    const frag = new URLSearchParams(url.hash.replace(/^#/, ''));
    const query = url.searchParams;
    const pick = k => frag.get(k) || query.get(k) || '';

    out.accessToken = frag.get('access_token') || '';
    out.expiresIn = Number(frag.get('expires_in') || 0) || 0;
    out.error = pick('error');
    out.errorDescription = pick('error_description');
    out.scope = frag.get('scope') || '';
    out.state = pick('state');
    if (!out.accessToken && !out.error) out.error = 'no_token';
    return out;
  }

  // Absolute expiry with the safety margin applied. A missing expires_in
  // is treated as Google's usual hour rather than as "never".
  function tokenExpiry(expiresIn, now = Date.now()) {
    const secs = Number(expiresIn) > 0 ? Number(expiresIn) : 3600;
    return now + secs * 1000 - EXPIRY_MARGIN_MS;
  }

  // ── Request policy ───────────────────────────────────────────────────
  //
  // gmail.modify would let a token send mail and move things to Trash.
  // This code never sends, and only ever trashes its own notes, so the
  // proxy refuses anything outside this short list. A bug in the content
  // script - or anything that ever managed to talk to it - cannot reach
  // further than the board and the notes do.

  const ALLOWED = [
    ['GET', /^profile$/],
    ['GET', /^labels$/],
    ['POST', /^labels$/],
    ['GET', /^labels\/[A-Za-z0-9_-]+$/],
    ['PATCH', /^labels\/[A-Za-z0-9_-]+$/],
    ['DELETE', /^labels\/[A-Za-z0-9_-]+$/],          // an empty notes folder only - see folderDeleteId
    ['GET', /^threads$/],
    ['GET', /^threads\/[A-Za-z0-9]+$/],
    ['POST', /^threads\/[A-Za-z0-9]+\/modify$/],
    // Notes.
    ['GET', /^messages$/],
    ['GET', /^messages\/[A-Za-z0-9]+$/],
    ['POST', /^messages$/],                          // insert - a note, checked below
    ['POST', /^messages\/[A-Za-z0-9]+\/modify$/],
    ['POST', /^messages\/[A-Za-z0-9]+\/trash$/],     // a note only - see noteCheckId
    ['POST', /^messages\/[A-Za-z0-9]+\/untrash$/],
  ];

  // Labels that would turn a "move" into deleting or reporting mail.
  const FORBIDDEN_ADD = new Set(['TRASH', 'SPAM']);

  function isAllowedRequest(method, path, body) {
    const m = String(method || 'GET').toUpperCase();
    const p = String(path || '');
    if (!ALLOWED.some(([am, re]) => am === m && re.test(p))) return false;
    if (/\/modify$/.test(p) && body && Array.isArray(body.addLabelIds) &&
        body.addLabelIds.some(id => FORBIDDEN_ADD.has(String(id).toUpperCase()))) {
      return false;
    }
    // messages.insert never sends, but it can put anything into the
    // mailbox. Only a note, filed under user labels, gets through.
    if (m === 'POST' && p === 'messages' && !notes.isNoteInsert(body)) return false;
    return true;
  }

  // Moving to Trash is allowed for notes and nothing else. Whether a
  // message is a note is a fact about the message, not the request, so
  // the worker reads its headers first; this names the message to check.
  function noteCheckId(method, path) {
    if (String(method || '').toUpperCase() !== 'POST') return '';
    const m = /^messages\/([A-Za-z0-9]+)\/trash$/.exec(String(path || ''));
    return m ? m[1] : '';
  }

  // Deleting a label is allowed for an empty notes folder and nothing
  // else; like trash, that is checked against the label itself.
  function folderDeleteId(method, path) {
    if (String(method || '').toUpperCase() !== 'DELETE') return '';
    const m = /^labels\/([A-Za-z0-9_-]+)$/.exec(String(path || ''));
    return m ? m[1] : '';
  }

  // Query values may be arrays (metadataHeaders=Subject&metadataHeaders=From).
  function buildApiUrl(path, query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach(x => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    return API_BASE + path + (s ? `?${s}` : '');
  }

  const api = {
    AUTH_ENDPOINT, SCOPE, API_BASE, EXPIRY_MARGIN_MS,
    buildAuthUrl, parseAuthResponse, tokenExpiry, isAllowedRequest, noteCheckId, folderDeleteId, buildApiUrl,
  };

  ns.auth = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

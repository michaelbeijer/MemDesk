// Auth URL building, redirect parsing and the proxy's request policy.

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/lib/auth.js');

const BASE = {
  clientId: '123-abc.apps.googleusercontent.com',
  redirectUri: 'https://lfeogecmdohgofbifobhkolapmjikdih.chromiumapp.org/',
};

function params(url) {
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, auth.AUTH_ENDPOINT);
  return u.searchParams;
}

// ── buildAuthUrl ─────────────────────────────────────────────────────

test('auth URL carries the implicit-grant parameters', () => {
  const p = params(auth.buildAuthUrl({ ...BASE, loginHint: 'anna@example.com', state: 's1' }));
  assert.equal(p.get('client_id'), BASE.clientId);
  assert.equal(p.get('response_type'), 'token');
  assert.equal(p.get('redirect_uri'), BASE.redirectUri);
  assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(p.get('login_hint'), 'anna@example.com');
  assert.equal(p.get('state'), 's1');
  assert.equal(p.has('prompt'), false, 'interactive requests let Google decide what to show');
});

test('silent renewal asks for prompt=none', () => {
  const p = params(auth.buildAuthUrl({ ...BASE, loginHint: 'anna@example.com', silent: true }));
  assert.equal(p.get('prompt'), 'none');
});

test('no login_hint when the account is unknown (options page test)', () => {
  const p = params(auth.buildAuthUrl({ ...BASE, loginHint: '' }));
  assert.equal(p.has('login_hint'), false);
});

test('previously granted scopes are not folded in', () => {
  // A gmail.metadata grant from a sibling client would switch on Gmail's
  // metadata-scope restrictions (no q= search) for this token.
  const p = params(auth.buildAuthUrl(BASE));
  assert.equal(p.get('include_granted_scopes'), 'false');
  assert.equal(p.getAll('scope').length, 1);
});

// ── parseAuthResponse ────────────────────────────────────────────────

test('reads a successful token from the fragment', () => {
  const r = auth.parseAuthResponse(
    `${BASE.redirectUri}#state=s1&access_token=ya29.abc&token_type=Bearer&expires_in=3599` +
    '&scope=https://www.googleapis.com/auth/gmail.modify'
  );
  assert.equal(r.accessToken, 'ya29.abc');
  assert.equal(r.expiresIn, 3599);
  assert.equal(r.state, 's1');
  assert.equal(r.error, '');
  assert.match(r.scope, /gmail\.modify/);
});

test('reads an error from the fragment', () => {
  const r = auth.parseAuthResponse(`${BASE.redirectUri}#error=interaction_required&state=s1`);
  assert.equal(r.accessToken, '');
  assert.equal(r.error, 'interaction_required');
  assert.equal(r.state, 's1');
});

test('reads an error from the query string', () => {
  const r = auth.parseAuthResponse(`${BASE.redirectUri}?error=access_denied&error_description=Nope`);
  assert.equal(r.error, 'access_denied');
  assert.equal(r.errorDescription, 'Nope');
});

test('a redirect with neither token nor error is an error', () => {
  assert.equal(auth.parseAuthResponse(BASE.redirectUri).error, 'no_token');
  assert.equal(auth.parseAuthResponse('').error, 'no_redirect');
  assert.equal(auth.parseAuthResponse(undefined).error, 'no_redirect');
  assert.equal(auth.parseAuthResponse('not a url').error, 'bad_redirect');
});

test('expiry keeps a five-minute margin', () => {
  const now = 1_000_000;
  assert.equal(auth.tokenExpiry(3600, now), now + 3600_000 - 300_000);
  assert.equal(auth.tokenExpiry(undefined, now), now + 3600_000 - 300_000, 'missing expires_in means an hour');
  assert.equal(auth.tokenExpiry('0', now), now + 3600_000 - 300_000);
});

// ── Request policy ───────────────────────────────────────────────────

test('the board’s own calls are allowed', () => {
  const ok = [
    ['GET', 'profile'],
    ['GET', 'labels'],
    ['POST', 'labels'],
    ['PATCH', 'labels/Label_12345'],
    ['GET', 'threads'],
    ['GET', 'threads/18c2f7a0b1d2e3f4'],
    ['POST', 'threads/18c2f7a0b1d2e3f4/modify'],
    ['get', 'threads'],
  ];
  for (const [m, p] of ok) assert.equal(auth.isAllowedRequest(m, p), true, `${m} ${p}`);
});

test('sending, deleting and anything else is refused', () => {
  const refused = [
    ['POST', 'messages/send'],
    ['POST', 'drafts/send'],
    ['POST', 'drafts'],
    ['DELETE', 'threads/18c2f7a0b1d2e3f4'],
    ['DELETE', 'labels/Label_1'],
    ['POST', 'threads/18c2f7a0b1d2e3f4/trash'],
    ['POST', 'messages/batchDelete'],
    ['POST', 'messages/import'],
    ['GET', 'messages/abc'],
    ['GET', 'threads/../messages/send'],
    ['GET', '/threads'],
    ['GET', ''],
    ['PUT', 'labels/Label_1'],
    ['POST', 'settings/forwardingAddresses'],
  ];
  for (const [m, p] of refused) assert.equal(auth.isAllowedRequest(m, p), false, `${m} ${p}`);
});

test('modify may not add TRASH or SPAM', () => {
  const p = 'threads/18c2f7a0b1d2e3f4/modify';
  assert.equal(auth.isAllowedRequest('POST', p, { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] }), true);
  assert.equal(auth.isAllowedRequest('POST', p, { addLabelIds: ['TRASH'] }), false);
  assert.equal(auth.isAllowedRequest('POST', p, { addLabelIds: ['spam'] }), false);
  assert.equal(auth.isAllowedRequest('POST', p, { removeLabelIds: ['TRASH'] }), true, 'removing is harmless');
});

test('API URLs repeat array parameters and skip empty ones', () => {
  const url = auth.buildApiUrl('threads/abc', {
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'Date'],
    q: '',
    pageToken: undefined,
  });
  const u = new URL(url);
  assert.equal(u.pathname, '/gmail/v1/users/me/threads/abc');
  assert.deepEqual(u.searchParams.getAll('metadataHeaders'), ['Subject', 'From', 'Date']);
  assert.equal(u.searchParams.has('q'), false);
  assert.equal(auth.buildApiUrl('labels'), 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
});

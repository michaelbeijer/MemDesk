// The licence's rules (src/lib/licence-logic.js): the trial, a key of the
// app's own store or Supervertaler's, the checks, and what may be sent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { APP_NAME } = require('../src/shared/ns.js');
const lic = require('../src/lib/licence-logic.js');

const DAY = 24 * 60 * 60 * 1000;
const STORE = 4242;
const SV = lic.SUPERVERTALER_STORE_ID;
const T0 = Date.UTC(2026, 9, 4, 12);

// Lemon Squeezy's replies, as its licence API sends them.
const reply = o => lic.parseReply(JSON.stringify(Object.assign({
  valid: true, error: null,
  license_key: { id: 1, status: 'active', key: 'x', expires_at: null },
  instance: null,
  meta: { store_id: STORE, variant_name: 'Yearly' },
}, o)));
const svReply = o => reply(Object.assign({ meta: { store_id: SV, variant_name: 'Supervertaler for Trados' } }, o));

// Runs enterKey to its end, answering each request with the next reply.
function enter(rec, key, answers, now = T0) {
  const asked = [];
  const replies = [];
  for (;;) {
    const step = lic.enterKey(rec, key, STORE, replies, 'App in Chrome, 4 Oct 2026', now);
    if (!step.ask) return Object.assign(step, { asked });
    asked.push(step.ask);
    replies.push(answers.shift());
  }
}

test('in preview: no trial, nothing to enter, nothing asked', () => {
  const { rec, changed } = lic.settle(undefined, 0, T0);
  assert.equal(changed, false);
  assert.equal(rec.trialStart, 0, 'the trial waits for the sale');
  assert.equal(lic.stateOf(rec, 0, T0), 'preview');
  assert.deepEqual(lic.view(rec, 0, T0), { state: 'preview' });
  assert.match(lic.enterKey(rec, 'KEY', 0, [], 'name', T0).error, /free while it is in preview/);
  assert.equal(lic.dueForCheck(Object.assign({}, rec, { key: 'K' }), 0, T0), false);
});

test('a trial of fourteen days starts the first time it is looked at, and then ends', () => {
  const { rec, changed } = lic.settle(undefined, STORE, T0);
  assert.equal(changed, true);
  assert.equal(rec.trialStart, T0);
  assert.deepEqual(lic.view(rec, STORE, T0), { state: 'trial', daysLeft: 14 });
  assert.equal(lic.view(rec, STORE, T0 + 13.5 * DAY).daysLeft, 1, 'the last day still counts');
  assert.equal(lic.stateOf(rec, STORE, T0 + 14 * DAY - 1), 'trial');
  assert.equal(lic.stateOf(rec, STORE, T0 + 14 * DAY), 'expired');
  // Looked at again, it is the same trial.
  const again = lic.settle(rec, STORE, T0 + 5 * DAY);
  assert.equal(again.changed, false);
  assert.equal(again.rec.trialStart, T0);
});

test('a key of the app’s own: looked up, then activated, with the key and a name only', () => {
  const { rec } = lic.settle(undefined, STORE, T0);
  const out = enter(rec, '  KEY-1  ', [reply({ license_key: { status: 'inactive' } }), reply({ activated: true, valid: undefined, instance: { id: 'inst-1' } })]);
  assert.deepEqual(out.asked, [
    ['validate', { license_key: 'KEY-1' }],
    ['activate', { license_key: 'KEY-1', instance_name: 'App in Chrome, 4 Oct 2026' }],
  ]);
  for (const [action, fields] of out.asked) assert.ok(lic.isAllowedRequest(action, fields), action);
  assert.equal(out.rec.key, 'KEY-1');
  assert.equal(out.rec.kind, 'memdesk');
  assert.equal(out.rec.instance, 'inst-1');
  assert.equal(out.rec.active, true);
  assert.equal(out.rec.trialStart, T0, 'the trial’s start is kept');
  assert.equal(lic.stateOf(out.rec, STORE, T0), 'licensed');
  const v = lic.view(out.rec, STORE, T0);
  assert.equal(v.keyEnd, 'EY-1');
  assert.ok(!JSON.stringify(v).includes('KEY-1'), 'the views are never given the key');
});

test('a Supervertaler licence counts while it is in force - looked up only, never activated', () => {
  const { rec } = lic.settle(undefined, STORE, T0);
  const out = enter(rec, 'SV-KEY', [svReply()]);
  assert.deepEqual(out.asked, [['validate', { license_key: 'SV-KEY' }]], 'none of the buyer’s activations used');
  assert.equal(out.rec.kind, 'supervertaler');
  assert.equal(out.rec.instance, '');
  assert.equal(lic.stateOf(out.rec, STORE, T0), 'licensed');
  // Bought but never activated in Supervertaler: in force all the same.
  assert.equal(enter(rec, 'SV-NEW', [svReply({ license_key: { status: 'inactive' } })]).rec.active, true);
  assert.match(enter(rec, 'SV-OLD', [svReply({ valid: false, license_key: { status: 'expired' } })]).error, /no longer in force/);
  assert.match(enter(rec, 'SV-OFF', [svReply({ valid: false, license_key: { status: 'disabled' } })]).error, /disabled/);
});

test('a key that will not do says why, and changes nothing', () => {
  const { rec } = lic.settle(undefined, STORE, T0);
  const notFound = lic.parseReply(JSON.stringify({ valid: false, error: 'license_key not found.', license_key: null, meta: null }));
  assert.equal(enter(rec, 'NOPE', [notFound]).error, 'That licence key was not found.');
  assert.match(enter(rec, 'OTHER', [reply({ meta: { store_id: 99 } })]).error, /not a licence key for .+, or for Supervertaler/);
  assert.match(enter(rec, 'GONE', [reply({ valid: false, license_key: { status: 'expired' } })]).error, /expired/);
  const full = lic.parseReply(JSON.stringify({ activated: false, error: 'This license key has reached the activation limit.', license_key: { status: 'active' }, meta: { store_id: STORE } }));
  assert.match(enter(rec, 'FULL', [reply(), full]).error, /as many devices as it allows/);
  assert.match(enter(rec, 'X', [lic.parseReply('<html>Bad gateway</html>')]).error, /could not be checked/);
  assert.match(enter(rec, '   ', []).error, /Enter a licence key/);
});

test('checks: every twelve hours; only a reply that says it is in force renews the thirty days', () => {
  const { rec } = lic.settle(undefined, STORE, T0);
  const keyed = enter(rec, 'KEY-1', [reply(), reply({ activated: true, instance: { id: 'inst-1' } })]).rec;
  assert.equal(lic.dueForCheck(keyed, STORE, T0 + 11 * 3600e3), false);
  assert.equal(lic.dueForCheck(keyed, STORE, T0 + 12 * 3600e3), true);
  assert.deepEqual(lic.checkRequest(keyed), ['validate', { license_key: 'KEY-1', instance_id: 'inst-1' }]);

  // No answer, or one that cannot be read: only when it was tried changes.
  const offline = lic.afterCheck(keyed, 'KEY-1', null, STORE, T0 + DAY);
  assert.deepEqual([offline.active, offline.checked, offline.tried], [true, T0, T0 + DAY]);
  assert.equal(lic.dueForCheck(offline, STORE, T0 + DAY + 3600e3), false, 'not asked again at once');
  const garbled = lic.afterCheck(keyed, 'KEY-1', lic.parseReply('{"oops":1}'), STORE, T0 + DAY);
  assert.equal(garbled.checked, T0);
  // Thirty days without a word: no longer licensed, until one comes.
  assert.equal(lic.stateOf(offline, STORE, T0 + 29 * DAY), 'licensed');
  assert.equal(lic.stateOf(offline, STORE, T0 + 30 * DAY), 'expired');
  assert.equal(lic.view(offline, STORE, T0 + 30 * DAY).why, 'unchecked');
  const back = lic.afterCheck(offline, 'KEY-1', reply(), STORE, T0 + 31 * DAY);
  assert.equal(lic.stateOf(back, STORE, T0 + 31 * DAY), 'licensed');

  // Refunded or run out: at once, and the thirty days are not renewed.
  const refunded = lic.afterCheck(keyed, 'KEY-1', reply({ valid: false, license_key: { status: 'disabled' } }), STORE, T0 + DAY);
  assert.deepEqual([refunded.active, refunded.checked, lic.stateOf(refunded, STORE, T0 + DAY)], [false, T0, 'expired']);
  assert.equal(lic.view(refunded, STORE, T0 + DAY).why, 'disabled');
  // A key that turns out to be another store's is not a licence.
  const moved = lic.afterCheck(keyed, 'KEY-1', reply({ meta: { store_id: 7 } }), STORE, T0 + DAY);
  assert.equal(lic.view(moved, STORE, T0 + DAY).why, 'not-ours');
  // A reply about a key that has been changed meanwhile is not applied.
  assert.equal(lic.afterCheck(keyed, 'OLD-KEY', reply({ valid: false }), STORE, T0 + DAY), keyed);
  // A Supervertaler key is checked without an activation of its own.
  const sv = enter(rec, 'SV', [svReply()]).rec;
  assert.deepEqual(lic.checkRequest(sv), ['validate', { license_key: 'SV' }]);
});

test('removing it gives the activation back, and keeps the trial’s start', () => {
  const { rec } = lic.settle(undefined, STORE, T0);
  const keyed = enter(rec, 'KEY-1', [reply(), reply({ activated: true, instance: { id: 'inst-1' } })]).rec;
  assert.deepEqual(lic.removeRequest(keyed), ['deactivate', { license_key: 'KEY-1', instance_id: 'inst-1' }]);
  assert.equal(lic.removeRequest(enter(rec, 'SV', [svReply()]).rec), null, 'a Supervertaler key has nothing to give back');
  const gone = lic.withoutKey(keyed);
  assert.deepEqual([gone.key, gone.instance, gone.trialStart], ['', '', T0]);
  assert.equal(lic.stateOf(gone, STORE, T0 + 20 * DAY), 'expired', 'no new trial');
});

test('only these three requests, with only these fields, ever go to Lemon Squeezy', () => {
  assert.equal(lic.urlOf('validate'), 'https://api.lemonsqueezy.com/v1/licenses/validate');
  assert.equal(lic.formBody({ license_key: 'A B&C', instance_name: 'x' }), 'license_key=A%20B%26C&instance_name=x');
  const ok = [
    ['validate', { license_key: 'K' }], ['validate', { license_key: 'K', instance_id: 'I' }],
    ['activate', { license_key: 'K', instance_name: 'N' }], ['deactivate', { license_key: 'K', instance_id: 'I' }],
  ];
  for (const [a, f] of ok) assert.equal(lic.isAllowedRequest(a, f), true, `${a} ${JSON.stringify(f)}`);
  const refused = [
    ['validate', {}], ['activate', { license_key: 'K' }], ['deactivate', { license_key: 'K' }],
    ['validate', { license_key: 'K', email: 'me@example.com' }], ['activate', { license_key: 'K', instance_name: 'N', token: 'ya29' }],
    ['orders', { license_key: 'K' }], ['__proto__', { license_key: 'K' }], ['validate', { license_key: 'K'.repeat(201) }],
    ['validate', { license_key: 5 }], ['validate', null],
  ];
  for (const [a, f] of refused) assert.equal(lic.isAllowedRequest(a, f), false, `${a} ${JSON.stringify(f)}`);
});

test('the name of an activation says where and since when, and nothing about the person', () => {
  assert.equal(lic.activationName('in Chrome', T0), `${APP_NAME} in Chrome, 4 Oct 2026`);
});

// ── The flows, as the worker and the phone app's script run them ──

// A surface: its record, a Lemon Squeezy that answers from a list (or
// cannot be reached), and the clock.
function surface({ stored, answers = [], unreachable = false, now = T0, storeId = STORE } = {}) {
  const s = { stored, saves: 0, asked: [], now };
  s.env = { storeId, where: 'in Chrome', now: () => s.now };
  s.io = {
    load: () => s.stored,
    save: rec => { s.stored = JSON.parse(JSON.stringify(rec)); s.saves++; },
    ask: req => { s.asked.push(req); return unreachable ? { unreachable: true } : answers.shift(); },
  };
  s.run = (action, key) => lic.runSync(lic.flow(action, s.env, key), s.io);
  return s;
}

test('status: the trial starts and is kept; a check only when one is due; peek never asks', () => {
  const s = surface();
  assert.deepEqual(s.run('status'), { view: { state: 'trial', daysLeft: 14 } });
  assert.equal(s.stored.trialStart, T0);
  assert.equal(s.saves, 1);
  s.run('status');
  assert.equal(s.saves, 1, 'nothing new to keep');
  assert.deepEqual(surface({ storeId: 0 }).run('status'), { view: { state: 'preview' } });

  const k = surface({ answers: [reply(), reply({ activated: true, instance: { id: 'i1' } })] });
  assert.equal(k.run('enter', 'KEY-1').view.state, 'licensed');
  k.now = T0 + 13 * 3600e3;
  assert.equal(k.run('peek').view.state, 'licensed');
  assert.equal(k.asked.length, 2, 'peek asks nothing');
  k.io.ask = req => { k.asked.push(req); return reply({ valid: false, license_key: { status: 'disabled' } }); };
  assert.deepEqual(k.run('status').view.why, 'disabled', 'a due check, and its answer');
  assert.equal(k.asked.length, 3);
});

test('enter: unreachable says so and keeps what was; a new key gives the old one’s activation back', () => {
  const off = surface({ unreachable: true });
  const out = off.run('enter', 'KEY-1');
  assert.match(out.error, /could not be reached/);
  assert.equal(out.view.state, 'trial');
  assert.equal(off.stored.key, '');

  const s = surface({ answers: [reply(), reply({ activated: true, instance: { id: 'i1' } })] });
  s.run('enter', 'KEY-1');
  s.io.ask = req => { s.asked.push(req); return req[0] === 'deactivate' ? lic.parseReply('{"deactivated":true}') : svReply(); };
  assert.equal(s.run('enter', 'SV').view.kind, 'supervertaler');
  assert.deepEqual(s.asked.at(-1), ['deactivate', { license_key: 'KEY-1', instance_id: 'i1' }]);
  assert.equal(s.stored.trialStart, T0);
});

test('a check that comes back after another key was entered does not undo it', () => {
  const s = surface({ answers: [reply(), reply({ activated: true, instance: { id: 'i1' } })] });
  s.run('enter', 'KEY-1');
  s.now = T0 + DAY;
  // Meanwhile, in another tab, a Supervertaler key took its place.
  s.io.ask = req => {
    s.asked.push(req);
    s.stored = Object.assign({}, s.stored, { key: 'SV', kind: 'supervertaler', instance: '' });
    return reply({ valid: false, license_key: { status: 'disabled' } });
  };
  s.run('status');
  assert.deepEqual([s.stored.key, s.stored.active], ['SV', true], 'the answer about the old key is not applied');
});

test('remove: given back, gone from here, and the trial is not started again', () => {
  const s = surface({ answers: [reply(), reply({ activated: true, instance: { id: 'i1' } })] });
  s.run('enter', 'KEY-1');
  s.now = T0 + 20 * DAY;
  s.io.ask = req => { s.asked.push(req); return { unreachable: true }; };
  const out = s.run('remove');
  assert.deepEqual(s.asked.at(-1), ['deactivate', { license_key: 'KEY-1', instance_id: 'i1' }]);
  assert.equal(out.view.state, 'expired', 'given back or not, it is gone from here');
  assert.equal(s.stored.key, '');
  assert.equal(lic.flow('format-disk', s.env), null, 'nothing else can be asked for');
});

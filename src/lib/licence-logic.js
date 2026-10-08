// ─────────────────────────────────────────────────────────────────────
// The licence: a free trial, then a licence key, checked with Lemon Squeezy
//
// Pure rules, shared by the extension's background worker (which keeps
// the licence in Chrome's synced storage and asks Lemon Squeezy), the
// phone app's script (which keeps it in the script's user properties and
// asks through UrlFetchApp), the dev preview's stand-in and the tests.
//
// - A trial of TRIAL_DAYS starts the first time the licence is looked at.
// - A key from the app's own store is activated once, and checked every
//   CHECK_HOURS after that. A key from Supervertaler's store is a licence
//   too, while it is in force: it is only checked, never activated, so it
//   uses up none of the buyer's activations.
// - As in Supervertaler's own code: a reply that cannot be read changes
//   nothing, only one that says the licence is in force renews the
//   OFFLINE_DAYS it may go unconfirmed, and a key from any other store is
//   not a licence.
// - Lemon Squeezy is sent the key and, to activate it, a name for the
//   activation - nothing else, and never a Google sign-in.
//
// While the store's ID (ns.LICENCE_STORE_ID) is 0, the app is in preview:
// free, with no trial, and nothing is asked of Lemon Squeezy at all.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  const TRIAL_DAYS = 14;
  const OFFLINE_DAYS = 30;
  const CHECK_HOURS = 12;
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  // The store that sells Supervertaler's licences.
  const SUPERVERTALER_STORE_ID = 307062;

  const API = 'https://api.lemonsqueezy.com/v1/licenses/';
  // What may be asked, and with what: nothing more ever leaves.
  const FIELDS = {
    activate: { license_key: true, instance_name: true },
    validate: { license_key: true, instance_id: false },
    deactivate: { license_key: true, instance_id: true },
  };
  const KEY_MAX = 200;

  function isAllowedRequest(action, fields) {
    const want = Object.prototype.hasOwnProperty.call(FIELDS, action) ? FIELDS[action] : null;
    if (!want || !fields || typeof fields !== 'object') return false;
    for (const [k, v] of Object.entries(fields)) {
      if (!Object.prototype.hasOwnProperty.call(want, k) || typeof v !== 'string' || !v || v.length > KEY_MAX) return false;
    }
    return Object.keys(want).every(k => !want[k] || typeof fields[k] === 'string');
  }

  const urlOf = action => API + action;

  function formBody(fields) {
    return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  // Lemon Squeezy's reply: { valid | activated | deactivated, error,
  // license_key: { status }, instance: { id }, meta: { store_id,
  // variant_name } }. "Understood" means it carried a licence and its
  // status, as every real reply about an existing key does; anything else
  // is no answer at all.
  function parseReply(text) {
    let r = null;
    try { r = JSON.parse(String(text)); } catch (err) { r = null; }
    if (!r || typeof r !== 'object') return { understood: false, error: '' };
    const lk = r.license_key && typeof r.license_key === 'object' ? r.license_key : null;
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const inst = r.instance && typeof r.instance === 'object' ? r.instance : {};
    return {
      understood: !!(lk && typeof lk.status === 'string' && lk.status),
      valid: r.valid === true,
      activated: r.activated === true,
      status: lk && typeof lk.status === 'string' ? lk.status : '',
      storeId: Number(meta.store_id) || 0,
      variant: typeof meta.variant_name === 'string' ? meta.variant_name : '',
      instanceId: typeof inst.id === 'string' ? inst.id : '',
      error: typeof r.error === 'string' ? r.error : '',
    };
  }

  // ── The record ──
  //
  // { trialStart, key, kind ('memdesk' | 'supervertaler'), instance,
  //   active, status, variant, checked, tried } - times in ms.
  // `checked`: when Lemon Squeezy last said it was in force; `tried`: when
  // it was last asked, whatever came back, so that checks are spaced out.

  const EMPTY = { key: '', kind: '', instance: '', active: false, status: '', variant: '', checked: 0, tried: 0 };

  // The record as kept, made whole; with a trial started now if there was
  // none and the app is not in preview. `changed`: it needs keeping.
  function settle(stored, storeId, now) {
    const rec = Object.assign({ trialStart: 0 }, EMPTY, stored && typeof stored === 'object' ? stored : {});
    let changed = false;
    if (storeId && !(rec.trialStart > 0)) {
      rec.trialStart = now;
      changed = true;
    }
    return { rec, changed };
  }

  function stateOf(rec, storeId, now) {
    if (!storeId) return 'preview';
    if (rec.key) return rec.active && now - rec.checked < OFFLINE_DAYS * DAY ? 'licensed' : 'expired';
    return now < rec.trialStart + TRIAL_DAYS * DAY ? 'trial' : 'expired';
  }

  // What the views are told; never the key itself, only its end.
  function view(rec, storeId, now) {
    const state = stateOf(rec, storeId, now);
    const out = { state };
    if (state === 'trial') out.daysLeft = Math.max(1, Math.ceil((rec.trialStart + TRIAL_DAYS * DAY - now) / DAY));
    if (rec.key && storeId) {
      Object.assign(out, {
        kind: rec.kind, status: rec.status, variant: rec.variant, keyEnd: rec.key.slice(-4),
        checked: rec.checked,
        // Why it is not in force: Lemon Squeezy said so, or it has not
        // been able to say anything for too long.
        why: rec.active ? (state === 'expired' ? 'unchecked' : '')
          : rec.status === 'not-ours' || rec.status === 'expired' || rec.status === 'disabled' ? rec.status : 'inactive',
      });
    }
    return out;
  }

  function dueForCheck(rec, storeId, now) {
    return !!(storeId && rec.key && now - Math.max(rec.tried || 0, rec.checked || 0) >= CHECK_HOURS * HOUR);
  }

  // Which store a key is from, by Lemon Squeezy's reply.
  function kindOf(reply, storeId) {
    if (storeId && reply.storeId === storeId) return 'memdesk';
    if (reply.storeId === SUPERVERTALER_STORE_ID) return 'supervertaler';
    return '';
  }

  // In force: one of the app's own keys activated and active; a Supervertaler one
  // valid and not expired or disabled (bought but never activated counts).
  function inForce(kind, reply) {
    if (kind === 'memdesk') return reply.valid && reply.status === 'active';
    if (kind === 'supervertaler') return reply.valid && reply.status !== 'expired' && reply.status !== 'disabled';
    return false;
  }

  // ── Entering a key ──
  //
  // One request at a time: called with the replies so far, it says what
  // to ask next ({ ask: [action, fields] }) or how it ended ({ rec } or
  // { error }). First the key is looked up, which says whose it is; one of
  // the app's own is then activated, one of Supervertaler's taken as it is.
  function enterKey(rec, key, storeId, replies, name, now) {
    const k = String(key || '').trim();
    const app = ns.APP_NAME || 'It';
    if (!storeId) return { error: `${app} is free while it is in preview: there is no licence to enter yet.` };
    if (!k || k.length > KEY_MAX) return { error: 'Enter a licence key.' };
    if (!replies.length) return { ask: ['validate', { license_key: k }] };
    const first = replies[0];
    if (!first.understood) return { error: first.error ? sentence(first.error) : 'That key could not be checked. Try again in a moment.' };
    const kind = kindOf(first, storeId);
    if (!kind) return { error: `That is not a licence key for ${app}, or for Supervertaler.` };
    if (kind === 'supervertaler') {
      if (!inForce(kind, first)) return { error: `That Supervertaler licence is ${first.status === 'disabled' ? 'disabled' : 'no longer in force'}.` };
      return { rec: keyed(rec, k, kind, '', first, now) };
    }
    if (first.status === 'expired' || first.status === 'disabled') return { error: `That licence is ${first.status}.` };
    if (replies.length === 1) return { ask: ['activate', { license_key: k, instance_name: name }] };
    const second = replies[1];
    if (!second.activated || !second.instanceId) {
      return { error: second.error ? sentence(second.error) : 'That key could not be activated. Try again in a moment.' };
    }
    return { rec: keyed(rec, k, kind, second.instanceId, Object.assign({}, second, { valid: true }), now) };
  }

  function keyed(rec, key, kind, instance, reply, now) {
    return Object.assign({}, rec, {
      key, kind, instance, active: inForce(kind, reply), status: reply.status,
      variant: reply.variant, checked: now, tried: now,
    });
  }

  // Lemon Squeezy's own words, as a sentence: "license_key not found." →
  // "That licence key was not found."
  function sentence(text) {
    const t = String(text).trim();
    if (/license_key not found/i.test(t)) return 'That licence key was not found.';
    if (/activation limit/i.test(t)) return 'That licence key is already in use on as many devices as it allows. Remove it from one of them first.';
    return /[.!?]$/.test(t) ? t : `${t}.`;
  }

  // ── Checking it ──

  function checkRequest(rec) {
    const fields = { license_key: rec.key };
    if (rec.kind === 'memdesk' && rec.instance) fields.instance_id = rec.instance;
    return ['validate', fields];
  }

  // A check's reply, applied to the record it was about - not to one whose
  // key has changed meanwhile. Unreadable or no reply: only `tried`.
  function afterCheck(rec, key, reply, storeId, now) {
    if (rec.key !== key) return rec;
    if (!reply || !reply.understood) return Object.assign({}, rec, { tried: now });
    const kind = kindOf(reply, storeId);
    if (kind !== rec.kind) return Object.assign({}, rec, { active: false, status: 'not-ours', tried: now });
    const active = inForce(kind, reply);
    return Object.assign({}, rec, {
      active, status: reply.status, variant: reply.variant || rec.variant,
      tried: now, checked: active ? now : rec.checked,
    });
  }

  // ── Removing it ──
  //
  // An activation of the app's own key is given back; whether that worked or not,
  // the key goes from here. The trial's start stays.
  function removeRequest(rec) {
    return rec.kind === 'memdesk' && rec.instance ? ['deactivate', { license_key: rec.key, instance_id: rec.instance }] : null;
  }

  function withoutKey(rec) {
    return Object.assign({}, rec, EMPTY);
  }

  // The name an activation goes by in Lemon Squeezy, for the buyer to know
  // it again: where it is, and since when.
  function activationName(where, now) {
    const d = new Date(now);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${ns.APP_NAME || 'App'} ${where}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // ── What each surface does, once ──
  //
  // The steps of each action, written once for the worker (where storage
  // and the network answer later) and the phone app's script (where they
  // answer at once). A flow says what it needs - ['load'], ['save', rec]
  // or ['ask', [action, fields]] - and gets the answer back; runAsync and
  // runSync do what it says with the surface's own `io`. io.ask answers
  // with parseReply's result, or { unreachable: true } when Lemon Squeezy
  // could not be reached at all. Before saving, a flow reads the record
  // again and applies its change to that, so a change made elsewhere
  // meanwhile (a key entered in another tab, or on another phone) stands.
  //
  // `env`: { storeId, where (for the activation's name), now() }.
  // Every flow ends with { view } and, if it did not do what was asked,
  // { error } in words for the person.

  const UNREACHABLE = 'Lemon Squeezy, which looks after the licences, could not be reached. Check the connection and try again.';

  function* loadFlow(env) {
    const { rec, changed } = settle(yield ['load'], env.storeId, env.now());
    if (changed) yield ['save', rec];
    return rec;
  }

  // 'status': a check if one is due; 'peek': none (the phone panel, which
  // must not wait); 'check': one now, asked for.
  function* statusFlow(env, mode) {
    let rec = yield* loadFlow(env);
    const check = mode === 'check' ? !!(env.storeId && rec.key) : mode === 'status' && dueForCheck(rec, env.storeId, env.now());
    let error = '';
    if (check) {
      const key = rec.key;
      const reply = yield ['ask', checkRequest(rec)];
      if (reply && reply.unreachable && mode === 'check') error = UNREACHABLE;
      rec = yield* loadFlow(env);
      const next = afterCheck(rec, key, reply && reply.understood ? reply : null, env.storeId, env.now());
      if (next !== rec) {
        rec = next;
        yield ['save', rec];
      }
    }
    return error ? { view: view(rec, env.storeId, env.now()), error } : { view: view(rec, env.storeId, env.now()) };
  }

  function* enterFlow(env, key) {
    const rec = yield* loadFlow(env);
    const replies = [];
    for (;;) {
      const step = enterKey(rec, key, env.storeId, replies, activationName(env.where, env.now()), env.now());
      if (step.error) return { view: view(rec, env.storeId, env.now()), error: step.error };
      if (step.rec) {
        const fresh = yield* loadFlow(env);
        const next = Object.assign({}, step.rec, { trialStart: fresh.trialStart });
        yield ['save', next];
        // The key it takes the place of gives its activation back, if it can.
        const giveBack = fresh.key && fresh.key !== next.key ? removeRequest(fresh) : null;
        if (giveBack) yield ['ask', giveBack];
        return { view: view(next, env.storeId, env.now()) };
      }
      const reply = yield ['ask', step.ask];
      if (!reply || reply.unreachable) return { view: view(rec, env.storeId, env.now()), error: UNREACHABLE };
      replies.push(reply);
    }
  }

  function* removeFlow(env) {
    const rec = yield* loadFlow(env);
    const giveBack = removeRequest(rec);
    if (giveBack) yield ['ask', giveBack];
    const fresh = yield* loadFlow(env);
    const next = fresh.key === rec.key ? withoutKey(fresh) : fresh;
    yield ['save', next];
    return { view: view(next, env.storeId, env.now()) };
  }

  // The flow for an action from a view, or null for one there is not.
  function flow(action, env, key) {
    switch (action) {
      case 'status': case 'peek': case 'check': return statusFlow(env, action);
      case 'enter': return enterFlow(env, key);
      case 'remove': return removeFlow(env);
      default: return null;
    }
  }

  // The runners are util's (shared with the board's layout), looked up
  // when used: util loads before this everywhere, but not always first.
  const util = () => ns.util || require('./util.js');
  const runAsync = (f, io) => util().runAsync(f, io);
  const runSync = (f, io) => util().runSync(f, io);

  const api = {
    TRIAL_DAYS, OFFLINE_DAYS, CHECK_HOURS, SUPERVERTALER_STORE_ID, API,
    isAllowedRequest, urlOf, formBody, parseReply,
    settle, stateOf, view, dueForCheck, kindOf, enterKey, checkRequest, afterCheck, removeRequest, withoutKey, activationName,
    flow, runAsync, runSync,
  };
  ns.licenceLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

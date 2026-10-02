// ─────────────────────────────────────────────────────────────────────
// Calendar data
//
// Google Calendar's events and Google Tasks' tasks, read through the
// background worker with the calendar's own sign-in (or, in the phone
// app, through its script). Two kinds of read: the sources - which
// calendars and task lists there are - kept for ten minutes, and what is
// on in a range of days, for the sources that are switched on.
//
// Trouble with the sign-in is thrown, for the view's panel; trouble with
// one service (Tasks not allowed, say) comes back with the rest, so a
// calendar still shows when the tasks cannot.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const cal = ns.calendarLogic;

  const SOURCES_MS = 10 * 60 * 1000;

  // Codes that are about the sign-in, not about one calendar or list.
  const SIGN_IN = new Set(['not_configured', 'calendar_auth_required', 'calendar_mismatch', 'extension_reloaded']);

  const S = {
    account: '',
    sources: null,   // calendarLogic.sources()
    errors: {},      // service → error, from the last sources read
    at: 0,
  };

  function throwSignIn(results) {
    const bad = results.find(r => r && r.error && SIGN_IN.has(r.error.code));
    if (bad) throw bad.error;
  }

  async function loadSources(account, { force = false } = {}) {
    if (S.account !== account) {
      S.account = account;
      S.sources = null;
    }
    if (!force && S.sources && Date.now() - S.at < SOURCES_MS) return { sources: S.sources, errors: S.errors };
    const [calendars, lists] = await ns.api.googleMany(cal.sourceRequests());
    throwSignIn([calendars, lists]);
    const errors = {};
    if (calendars.error) errors.calendar = calendars.error;
    if (lists.error) errors.tasks = lists.error;
    // A service that failed this time keeps the sources it had.
    const kept = kind => (S.sources || []).filter(s => s.kind === kind);
    const fresh = cal.sources(calendars.error ? [] : calendars.items, lists.error ? [] : lists.items);
    S.sources = [
      ...(calendars.error ? kept('calendar') : fresh.filter(s => s.kind === 'calendar')),
      ...(lists.error ? kept('tasks') : fresh.filter(s => s.kind === 'tasks')),
    ];
    S.errors = errors;
    S.at = Date.now();
    return { sources: S.sources, errors };
  }

  // What is on from range.start up to range.end, from the given sources.
  async function loadRange(range, sources) {
    const calendars = sources.filter(s => s.kind === 'calendar');
    const lists = sources.filter(s => s.kind === 'tasks');
    const results = await ns.api.googleMany(cal.rangeRequests(range, calendars, lists));
    throwSignIn(results);

    const items = [];
    const errors = {};
    let i = 0;
    for (const c of calendars) {
      const r = results[i++];
      if (r.error) { errors.calendar = errors.calendar || r.error; continue; }
      for (const ev of r.items || []) {
        const item = cal.eventItem(ev, c);
        if (item) items.push(item);
      }
    }
    for (const l of lists) {
      for (let pass = 0; pass < 2; pass++) {
        const r = results[i++];
        if (r.error) { errors.tasks = errors.tasks || r.error; continue; }
        for (const t of r.items || []) {
          const item = cal.taskItem(t, l);
          if (item) items.push(item);
        }
      }
    }
    return { items: cal.uniqueById(items), errors };
  }

  function forget() {
    S.sources = null;
    S.at = 0;
  }

  ns.calendarStore = { loadSources, loadRange, forget, SIGN_IN };
})();

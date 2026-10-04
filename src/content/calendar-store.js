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

  // ── Changes ──────────────────────────────────────────────────────────
  //
  // One event or task at a time, through the worker (or the app's script),
  // which lets through only these. An event goes with the version it was
  // read at, so one changed in Google meanwhile is refused ("changed")
  // rather than overwritten - or deleted unseen.

  const write = (service, method, path, body, etag) => ns.api.googleWrite(service, method, path, body, etag);

  function tick(item, done) {
    return write('tasks', 'PATCH', cal.taskPath(item), cal.tickBody(done));
  }

  function move(item, fromDay, toDay, timeZone) {
    const body = cal.moveBody(item, fromDay, toDay, timeZone);
    return item.kind === 'task'
      ? write('tasks', 'PATCH', cal.taskPath(item), body)
      : write('calendar', 'PATCH', cal.eventPath(item), body, item.etag);
  }

  // What the editor holds: a change to `item`, or a new one when there is
  // none. A draft that will not do is refused here, before Google is asked.
  // `recurrence`: an event's rule lines, when they are to be set.
  function save(item, draft, timeZone, recurrence) {
    const made = draft.kind === 'task' ? cal.taskBody(draft, { patch: !!item })
      : cal.eventBody(draft, timeZone, { patch: !!item, recurrence });
    if (made.error) return Promise.reject(Object.assign(new Error(made.error), { code: 'invalid' }));
    if (draft.kind === 'task') {
      return item ? write('tasks', 'PATCH', cal.taskPath(item), made.body) : write('tasks', 'POST', cal.tasksPath(draft.source), made.body);
    }
    return item ? write('calendar', 'PATCH', cal.eventPath(item), made.body, item.etag)
      : write('calendar', 'POST', cal.eventsPath(draft.source), made.body);
  }

  // One event (one occurrence of a repeating one) or one task - never more.
  function remove(item) {
    return item.kind === 'task'
      ? write('tasks', 'DELETE', cal.taskPath(item))
      : write('calendar', 'DELETE', cal.eventPath(item), undefined, item.etag);
  }

  // ── A repeating event's series ──
  //
  // An occurrence names its series; Google's event for the series holds
  // the rule, the first day and the version. A change or a delete for all
  // events goes to the series, at that version.

  const seriesPath = (item, series) => cal.eventPath({ source: item.source, eventId: series ? series.id : item.seriesId });

  async function series(item) {
    const [r] = await ns.api.googleMany([['calendar', seriesPath(item), {}]]);
    if (!r || r.error) throw (r && r.error) || new Error('Google did not answer.');
    return r;
  }

  // The occurrence's draft, for the whole series, with `rule` ('' to stop
  // it repeating) in place of the series' own.
  function saveSeries(s, item, draft, rule, timeZone) {
    const d = cal.seriesDraft(cal.startDayOf(s), item.first, draft);
    const made = cal.eventBody(d, timeZone, { patch: true, recurrence: cal.recurrenceWith(s.recurrence, rule) });
    if (made.error) return Promise.reject(Object.assign(new Error(made.error), { code: 'invalid' }));
    return write('calendar', 'PATCH', seriesPath(item, s), made.body, s.etag);
  }

  function removeSeries(s, item) {
    return write('calendar', 'DELETE', seriesPath(item, s), undefined, s.etag);
  }

  ns.calendarStore = { loadSources, loadRange, forget, tick, move, save, remove, series, saveSeries, removeSeries, SIGN_IN };
})();

// ─────────────────────────────────────────────────────────────────────
// Calendar logic (pure)
//
// The Calendar tab shows Google Calendar's events and Google Tasks'
// tasks side by side, day by day. This file holds the parts that need no
// browser: dates as "YYYY-MM-DD" keys in local time, the ranges each
// view shows, turning the two APIs' answers into one kind of day item,
// and which requests to Google are allowed at all.
//
// It is read-only for now. The second sign-in asks for read-only access to
// Calendar and Tasks, and the request policy below only lets GETs through:
// the calendar list, a calendar's events, the task lists and a list's
// tasks.
//
// Loaded by the content scripts, the service worker, the phone app's
// script and Node's tests.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // ── Google, and what may be asked of it ──────────────────────────────

  // The second sign-in, separate from Gmail's, so that the board and the
  // notes never stop working for someone who has not allowed the calendar.
  // "email" lets the worker check whose calendar it is.
  const SCOPES = [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks.readonly',
  ];

  const BASES = {
    calendar: 'https://www.googleapis.com/calendar/v3/',
    tasks: 'https://tasks.googleapis.com/tasks/v1/',
  };

  const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

  // One path segment: an id, encoded with encodeURIComponent. Never one
  // that the URL parser would read as "." or "..", encoded or not.
  function isSegment(s) {
    if (!/^[A-Za-z0-9%._~-]+$/.test(s)) return false;
    let plain;
    try { plain = decodeURIComponent(s); } catch { return false; }
    return !/^\.+$/.test(plain) && !plain.includes('/');
  }

  const ALLOWED = {
    calendar: [
      p => p === 'users/me/calendarList',
      p => { const m = /^calendars\/([^/]+)\/events$/.exec(p); return !!m && isSegment(m[1]); },
    ],
    tasks: [
      p => p === 'users/@me/lists',
      p => { const m = /^lists\/([^/]+)\/tasks$/.exec(p); return !!m && isSegment(m[1]); },
    ],
  };

  function isAllowedRequest(service, method, path) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    const rules = Object.prototype.hasOwnProperty.call(ALLOWED, service) ? ALLOWED[service] : null;
    return !!rules && rules.some(ok => ok(String(path || '')));
  }

  // Query values may be arrays, as for Gmail.
  function buildUrl(service, path, query) {
    const parts = [];
    for (const key of Object.keys(query || {})) {
      const v = query[key];
      if (v === undefined || v === null || v === '') continue;
      for (const one of [].concat(v)) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(one)}`);
    }
    return BASES[service] + path + (parts.length ? `?${parts.join('&')}` : '');
  }

  // ── Dates ────────────────────────────────────────────────────────────
  //
  // A day is a "YYYY-MM-DD" string in local time: it sorts and compares as
  // text, and survives storage and messages unchanged. Weeks start on
  // Monday and are numbered as ISO 8601 numbers them.

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                       'August', 'September', 'October', 'November', 'December'];

  // How far the agenda looks ahead, and how far one step moves it.
  const AGENDA_DAYS = 28;

  const pad = n => String(n).padStart(2, '0');

  function dateKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }

  function isKey(key) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ''));
  }

  function fromKey(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  // Whole days from a to b. Rounded, because a day with a clock change
  // in it is an hour longer or shorter than 24.
  function daysBetween(a, b) {
    return Math.round((fromKey(b) - fromKey(a)) / 86400000);
  }

  // 0 for Monday … 6 for Sunday.
  function weekday(key) {
    return (fromKey(key).getDay() + 6) % 7;
  }

  function weekStart(key) {
    return addDays(key, -weekday(key));
  }

  // The ISO week: the one with the year's first Thursday in it is week 1.
  function isoWeek(key) {
    const thursday = addDays(weekStart(key), 3);
    const firstThursday = addDays(weekStart(`${thursday.slice(0, 4)}-01-04`), 3);
    return 1 + daysBetween(firstThursday, thursday) / 7;
  }

  function monthStart(key) {
    return `${String(key).slice(0, 7)}-01`;
  }

  // The same day n months on, or the month's last day if it is shorter.
  function addMonths(key, n) {
    const [y, m, d] = String(key).split('-').map(Number);
    const first = new Date(y, m - 1 + n, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return dateKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
  }

  // The days from start up to, not including, end.
  function days(start, end) {
    const out = [];
    for (let k = start; k < end; k = addDays(k, 1)) out.push(k);
    return out;
  }

  // ── Views ────────────────────────────────────────────────────────────

  const VIEWS = ['week', 'month', 'agenda'];

  // What a view shows around the day in focus: the week it is in; its
  // month, as whole weeks; or, for the agenda, four weeks from that day.
  // end is the day after the last.
  function viewRange(view, anchor) {
    if (view === 'month') {
      const first = monthStart(anchor);
      const last = addDays(addMonths(first, 1), -1);
      return { start: weekStart(first), end: addDays(weekStart(last), 7) };
    }
    if (view === 'agenda') return { start: anchor, end: addDays(anchor, AGENDA_DAYS) };
    const start = weekStart(anchor);
    return { start, end: addDays(start, 7) };
  }

  function step(view, anchor, dir) {
    if (view === 'month') return addMonths(anchor, dir);
    if (view === 'agenda') return addDays(anchor, dir * AGENDA_DAYS);
    return addDays(anchor, dir * 7);
  }

  // The month as rows of seven days, for the small calendar.
  function monthWeeks(anchor) {
    const { start, end } = viewRange('month', anchor);
    const all = days(start, end);
    const rows = [];
    for (let i = 0; i < all.length; i += 7) rows.push(all.slice(i, i + 7));
    return rows;
  }

  // "28 Sep – 4 Oct", "5 – 11 Oct", with the year when it is not this one.
  function spanText(first, last, today) {
    const [y1, m1, d1] = first.split('-').map(Number);
    const [y2, m2, d2] = last.split('-').map(Number);
    const thisYear = Number(String(today).slice(0, 4));
    const year = y => (y !== thisYear ? ` ${y}` : '');
    if (first === last) return `${d1} ${MONTHS[m1 - 1]}${year(y1)}`;
    if (y1 !== y2) return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
    if (m1 === m2) return `${d1} – ${d2} ${MONTHS[m2 - 1]}${year(y2)}`;
    return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}${year(y2)}`;
  }

  function title(view, anchor, today) {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${MONTHS_LONG[m - 1]} ${y}`;
    }
    const { start, end } = viewRange(view, anchor);
    const span = spanText(start, addDays(end, -1), today);
    return view === 'week' ? `Week ${isoWeek(anchor)} · ${span}` : span;
  }

  function monthName(key) {
    const [y, m] = key.split('-').map(Number);
    return { long: MONTHS_LONG[m - 1], short: MONTHS[m - 1], year: y };
  }

  function dayName(key) {
    return DAY_NAMES[weekday(key)];
  }

  // ── Sources ──────────────────────────────────────────────────────────

  function safeColour(c) {
    return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : '';
  }

  // Only plain https links are ever put on the page.
  function safeLink(url) {
    return /^https:\/\/[^\s]+$/i.test(String(url || '')) ? String(url) : '';
  }

  // A calendar from calendarList. Google's own "show in the list" choice
  // (selected) decides whether it is on until someone says otherwise here;
  // calendars hidden from Google's list are left out. The main calendar
  // is usually named after the address, of which the name part will do.
  function calendarSource(c) {
    if (!c || !c.id || c.hidden) return null;
    let name = String(c.summaryOverride || c.summary || c.id).trim();
    if (c.primary && name.includes('@')) name = name.split('@')[0];
    return {
      kind: 'calendar', id: String(c.id), name,
      colour: safeColour(c.backgroundColor) || '#1a73e8',
      primary: !!c.primary, on: c.selected !== false,
    };
  }

  function listSource(l) {
    if (!l || !l.id) return null;
    return { kind: 'tasks', id: String(l.id), name: String(l.title || '').trim() || 'Tasks', on: true };
  }

  // The main calendar first, then the rest as Google lists them, then
  // the task lists.
  function sources(calendarItems, listItems) {
    const cals = (calendarItems || []).map(calendarSource).filter(Boolean);
    cals.sort((a, b) => Number(b.primary) - Number(a.primary));
    return cals.concat((listItems || []).map(listSource).filter(Boolean));
  }

  // The switch someone flicked here wins over Google's default.
  function isOn(source, overrides) {
    const o = overrides && Object.prototype.hasOwnProperty.call(overrides, source.id) ? overrides[source.id] : undefined;
    return typeof o === 'boolean' ? o : source.on;
  }

  // ── Requests ─────────────────────────────────────────────────────────

  const CALENDAR_LIST_FIELDS = 'items(id,summary,summaryOverride,backgroundColor,selected,hidden,primary,accessRole)';
  const EVENT_FIELDS = 'items(id,status,summary,start,end,htmlLink,colorId,eventType,location),nextPageToken';

  function sourceRequests() {
    return [
      ['calendar', 'users/me/calendarList', { minAccessRole: 'reader', maxResults: 250, fields: CALENDAR_LIST_FIELDS }],
      ['tasks', 'users/@me/lists', { maxResults: 100 }],
    ];
  }

  // For each calendar, its events in the range (a day either side, for
  // calendars in another time zone; the days are sorted out here). For
  // each task list, its open tasks - dated or not, for the "No date" tray
  // and anything overdue - and the ones done within the range. Google's
  // own apps hide a task when it is ticked, hence showHidden.
  function rangeRequests(range, calendars, lists) {
    const from = addDays(range.start, -1);
    const to = addDays(range.end, 1);
    const out = [];
    for (const c of calendars) {
      out.push(['calendar', `calendars/${encodeURIComponent(c.id)}/events`, {
        timeMin: fromKey(from).toISOString(), timeMax: fromKey(to).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: 2500, fields: EVENT_FIELDS,
      }]);
    }
    for (const l of lists) {
      const path = `lists/${encodeURIComponent(l.id)}/tasks`;
      out.push(['tasks', path, { showCompleted: 'false', maxResults: 100 }]);
      out.push(['tasks', path, {
        showCompleted: 'true', showHidden: 'true', maxResults: 100,
        dueMin: `${from}T00:00:00.000Z`, dueMax: `${to}T00:00:00.000Z`,
      }]);
    }
    return out;
  }

  // ── Items ────────────────────────────────────────────────────────────

  // Google Calendar's own event colours, by colorId.
  const EVENT_COLOURS = {
    1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
    7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
  };

  // An event, on every day it covers (first to last, both included).
  // Working-location entries ("Home", "Office") are left out: they are
  // on every day and say nothing a glance needs.
  function eventItem(ev, cal) {
    if (!ev || ev.status === 'cancelled' || ev.eventType === 'workingLocation') return null;
    const s = ev.start || {};
    const e = ev.end || {};
    const base = {
      kind: 'event', id: `${cal.id}|${ev.id}`, source: cal.id,
      title: String(ev.summary || '').trim() || '(No title)',
      colour: EVENT_COLOURS[ev.colorId] || cal.colour,
      link: safeLink(ev.htmlLink), where: String(ev.location || '').trim(),
    };
    if (isKey(s.date)) {
      const last = isKey(e.date) ? addDays(e.date, -1) : s.date;
      return Object.assign(base, { allDay: true, first: s.date, last: last < s.date ? s.date : last, start: 0, end: 0 });
    }
    const start = Date.parse(s.dateTime);
    if (!isFinite(start)) return null;
    const endMs = Date.parse(e.dateTime);
    const end = isFinite(endMs) && endMs > start ? endMs : start;
    // An event ending at midnight does not spill into the next day.
    return Object.assign(base, {
      allDay: false, start, end, first: dateKey(start), last: dateKey(Math.max(start, end - 1)),
    });
  }

  // A task, on its due day. Google keeps only the date of a due date (the
  // time is always midnight UTC), so the date is read as written, not
  // moved into the local time zone. A task made from an email in Gmail
  // links back to it.
  function taskItem(t, list) {
    if (!t || !t.id || t.deleted) return null;
    const title = String(t.title || '').trim();
    if (!title) return null;
    const due = /^\d{4}-\d{2}-\d{2}/.test(String(t.due || '')) ? String(t.due).slice(0, 10) : '';
    const mail = (t.links || []).find(l => l && l.type === 'email' && /^https:\/\/mail\.google\.com\//.test(String(l.link || '')));
    return {
      kind: 'task', id: `${list.id}|${t.id}`, source: list.id, title, due,
      done: t.status === 'completed', email: !!mail,
      link: safeLink(mail ? mail.link : t.webViewLink), list: list.name,
    };
  }

  // Tasks arrive twice when one is both open and due in the range.
  function uniqueById(items) {
    const seen = new Set();
    return items.filter(x => !seen.has(x.id) && seen.add(x.id));
  }

  // All-day first, then by time, then the tasks: open before done.
  function compareItems(a, b) {
    const rank = x => (x.kind === 'event' ? (x.allDay ? 0 : 1) : (x.done ? 3 : 2));
    return rank(a) - rank(b) || (a.start || 0) - (b.start || 0) || a.title.localeCompare(b.title);
  }

  // Day key → what is on it, each entry { item, cont }: cont when a
  // timed event started on an earlier day.
  function byDay(items, dayKeys) {
    const out = new Map(dayKeys.map(k => [k, []]));
    if (!dayKeys.length) return out;
    const first = dayKeys[0];
    const last = dayKeys[dayKeys.length - 1];
    for (const item of items) {
      if (item.kind === 'task') {
        if (item.due && out.has(item.due)) out.get(item.due).push({ item, cont: false });
        continue;
      }
      if (item.last < first || item.first > last) continue;
      const from = item.first < first ? first : item.first;
      const to = item.last > last ? last : item.last;
      for (let k = from; k <= to; k = addDays(k, 1)) {
        if (out.has(k)) out.get(k).push({ item, cont: k !== item.first });
      }
    }
    for (const list of out.values()) list.sort((a, b) => compareItems(a.item, b.item));
    return out;
  }

  // What waits under the week: open tasks with no date, and open tasks
  // whose day has gone by.
  function tray(items, today) {
    const open = items.filter(x => x.kind === 'task' && !x.done);
    return {
      overdue: open.filter(x => x.due && x.due < today).sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title)),
      undated: open.filter(x => !x.due),
    };
  }

  const api = {
    SCOPES, BASES, USERINFO_URL, VIEWS, AGENDA_DAYS, DAY_NAMES, MONTHS, MONTHS_LONG, EVENT_COLOURS,
    isAllowedRequest, buildUrl,
    dateKey, isKey, fromKey, addDays, daysBetween, weekday, weekStart, isoWeek, monthStart, addMonths, days,
    viewRange, step, monthWeeks, spanText, title, monthName, dayName,
    safeColour, safeLink, calendarSource, listSource, sources, isOn,
    sourceRequests, rangeRequests, eventItem, taskItem, uniqueById, compareItems, byDay, tray,
  };

  ns.calendarLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

// ─────────────────────────────────────────────────────────────────────
// Calendar logic (pure)
//
// The Calendar tab shows Google Calendar's events and Google Tasks'
// tasks side by side, day by day. This file holds the parts that need no
// browser: dates as "YYYY-MM-DD" keys in local time, the ranges each
// view shows, turning the two APIs' answers into one kind of day item,
// and which requests to Google are allowed at all.
//
// It reads and writes, both ways: the second sign-in asks to read the
// list of calendars and to change events and tasks, and the request
// policy below lets through only what the calendar does - reading the
// calendar list, a calendar's events, the task lists and a list's tasks;
// and adding, changing and deleting one event or one task, with only the
// fields the calendar edits.
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
  // "email" lets the worker check whose calendar it is. Reading the list
  // of calendars needs calendar.readonly; calendar.events changes events,
  // and nothing else about a calendar (not its sharing, not the calendar
  // itself).
  const SCOPES = [
    'email',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
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

  // A path of the given shape, each {} one segment.
  const shaped = (p, re) => { const m = re.exec(p); return !!m && m.slice(1).every(isSegment); };
  const EVENTS = /^calendars\/([^/]+)\/events$/;
  const EVENT = /^calendars\/([^/]+)\/events\/([^/]+)$/;
  const TASKS = /^lists\/([^/]+)\/tasks$/;
  const TASK = /^lists\/([^/]+)\/tasks\/([^/]+)$/;

  // What may be asked, by service and method: reads of the four lists;
  // one event or task added (POST to the list), changed (PATCH) or
  // deleted (DELETE). Nothing else - no calendar, list or sharing.
  const ALLOWED = {
    calendar: {
      // One event read on its own: a repeating event's series, for its rule.
      GET: [p => p === 'users/me/calendarList', p => shaped(p, EVENTS), p => shaped(p, EVENT)],
      POST: [p => shaped(p, EVENTS)],
      PATCH: [p => shaped(p, EVENT)],
      DELETE: [p => shaped(p, EVENT)],
    },
    tasks: {
      GET: [p => p === 'users/@me/lists', p => shaped(p, TASKS)],
      POST: [p => shaped(p, TASKS)],
      PATCH: [p => shaped(p, TASK)],
      DELETE: [p => shaped(p, TASK)],
    },
  };

  // The fields the calendar sets, and nothing else: no attendees (who would be
  // sent invitations), no reminders, no sharing. How an event repeats is a
  // list of rule lines, each one of the four kinds Google knows.
  const EVENT_KEYS = ['summary', 'location', 'start', 'end', 'recurrence'];
  const isRuleLines = v => Array.isArray(v) && v.length <= 20 &&
    v.every(l => typeof l === 'string' && /^(RRULE|EXRULE|RDATE|EXDATE)[:;][^\r\n]{1,1000}$/.test(l));
  const TIME_KEYS = ['date', 'dateTime', 'timeZone'];
  const TASK_KEYS = ['title', 'due', 'status', 'completed'];

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
  const onlyKeys = (o, keys) => isPlain(o) && Object.keys(o).every(k => keys.includes(k));

  function isAllowedBody(service, body) {
    if (service === 'tasks') return onlyKeys(body, TASK_KEYS);
    return onlyKeys(body, EVENT_KEYS) && ['start', 'end'].every(k => !own(body, k) || onlyKeys(body[k], TIME_KEYS)) &&
      (!own(body, 'recurrence') || isRuleLines(body.recurrence));
  }

  function isAllowedRequest(service, method, path, body) {
    const m = String(method || 'GET').toUpperCase();
    const rules = own(ALLOWED, service) && own(ALLOWED[service], m) ? ALLOWED[service][m] : null;
    if (!rules || !rules.some(ok => ok(String(path || '')))) return false;
    if (m === 'POST' || m === 'PATCH') return isAllowedBody(service, body);
    return body === undefined || body === null;
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
      // Holidays, birthdays and calendars shared read-only stay read-only.
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    };
  }

  function listSource(l) {
    if (!l || !l.id) return null;
    return { kind: 'tasks', id: String(l.id), name: String(l.title || '').trim() || 'Tasks', on: true, writable: true };
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
  const EVENT_FIELDS = 'items(id,etag,status,summary,start,end,htmlLink,colorId,eventType,location,' +
    'organizer(self),guestsCanModify,recurringEventId),nextPageToken';

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
      kind: 'event', id: `${cal.id}|${ev.id}`, source: cal.id, eventId: String(ev.id), etag: String(ev.etag || ''),
      title: String(ev.summary || '').trim() || '(No title)',
      colour: EVENT_COLOURS[ev.colorId] || cal.colour,
      link: safeLink(ev.htmlLink), where: String(ev.location || '').trim(),
      // Changed here only on a calendar that may be changed, and only an
      // ordinary event: not a birthday or an out-of-office, and not one
      // someone else organises unless they let guests change it.
      editable: !!cal.writable && (!ev.eventType || ev.eventType === 'default') &&
        (!ev.organizer || ev.organizer.self === true || ev.guestsCanModify === true),
      // One occurrence of a repeating event: a change is to this one only.
      recurring: !!ev.recurringEventId,
      seriesId: String(ev.recurringEventId || ''),
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
      kind: 'task', id: `${list.id}|${t.id}`, source: list.id, taskId: String(t.id), title, due,
      done: t.status === 'completed', email: !!mail,
      link: safeLink(mail ? mail.link : t.webViewLink), list: list.name, editable: true,
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

  // ── Changes ──────────────────────────────────────────────────────────
  //
  // What the calendar sends to Google to add, change or move one event or
  // one task, built here so that Node's tests can check them. A time is
  // local time on the 24-hour clock, sent with the offset that day has and
  // the browser's time zone, so Google keeps the event where it was put.

  // "09:30" from "9:30" or "9.30"; '' for anything that is not a time.
  function normTime(s) {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
    return `${pad(Number(m[1]))}:${m[2]}`;
  }

  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const clock = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

  // What was typed into the add box: "Dentist 14:30", "Call Sam at
  // 9.15-10:00". The time (or the two) comes out, and what is left is the
  // title. With no end, an hour, but not past midnight.
  function parseQuick(text) {
    const s = String(text || '');
    const re = /(^|\s)(?:at\s+)?(\d{1,2}[:.]\d{2})(?:\s*[-–]\s*(\d{1,2}[:.]\d{2}))?(?=$|[\s,;!?])/i;
    const m = re.exec(s);
    const start = m ? normTime(m[2]) : '';
    if (!start) return { title: s.trim(), start: '', end: '' };
    let end = m[3] ? normTime(m[3]) : '';
    if (!end || minutes(end) <= minutes(start)) end = clock(Math.min(minutes(start) + 60, 23 * 60 + 59));
    const title = (s.slice(0, m.index) + m[1] + s.slice(m.index + m[0].length))
      .replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/[\s,;]+$/, '').trim();
    return { title, start, end };
  }

  // "2026-10-05T14:30:00+01:00": a day and a time here, as Google wants it.
  function localStamp(day, time) {
    const [y, mo, d] = day.split('-').map(Number);
    const at = new Date(y, mo - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
    const off = -at.getTimezoneOffset();
    const a = Math.abs(off);
    return `${day}T${time}:00${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  const clockOf = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // An event or a task as the editor starts it: an existing one, or a new
  // one on `day` in `source` (a calendar's or a list's id).
  function draftOf(item) {
    if (item.kind === 'task') return { kind: 'task', title: item.title, source: item.source, day: item.due || '', done: !!item.done };
    return {
      kind: 'event', title: item.title === '(No title)' ? '' : item.title, source: item.source, where: item.where || '',
      allDay: !!item.allDay, day: item.first,
      endDay: item.allDay ? item.last : dateKey(item.end),
      start: item.allDay ? '' : clockOf(item.start), end: item.allDay ? '' : clockOf(item.end),
    };
  }

  function newDraft(kind, day, source) {
    return kind === 'task'
      ? { kind, title: '', source, day, done: false }
      : { kind, title: '', source, where: '', allDay: false, day, endDay: day, start: '09:00', end: '10:00' };
  }

  // An event, for Google: { body } or { error } to show. A change clears
  // what no longer applies (an all-day event's dateTime, a timed one's
  // date) with nulls; a new one leaves it out. `recurrence`, when given,
  // is the event's rule lines (recurrenceWith).
  function eventBody(d, timeZone, { patch = false, recurrence } = {}) {
    const title = String(d.title || '').trim();
    if (!title) return { error: 'Give it a title.' };
    if (!isKey(d.day)) return { error: 'Choose a day.' };
    const body = { summary: title, location: String(d.where || '').trim() };
    if (!patch && !body.location) delete body.location;
    if (recurrence !== undefined) body.recurrence = recurrence;
    const endDay = isKey(d.endDay) && d.endDay >= d.day ? d.endDay : d.day;
    if (d.allDay) {
      body.start = { date: d.day };
      body.end = { date: addDays(endDay, 1) };
      if (patch) { body.start.dateTime = null; body.end.dateTime = null; }
      return { body };
    }
    const start = normTime(d.start);
    const end = normTime(d.end);
    if (!start) return { error: 'The start time is hours and minutes, as 09:30.' };
    if (!end) return { error: 'The end time is hours and minutes, as 10:30.' };
    const a = localStamp(d.day, start);
    const b = localStamp(endDay, end);
    if (Date.parse(b) <= Date.parse(a)) return { error: 'It has to end after it starts.' };
    body.start = { dateTime: a };
    body.end = { dateTime: b };
    if (timeZone) { body.start.timeZone = timeZone; body.end.timeZone = timeZone; }
    if (patch) { body.start.date = null; body.end.date = null; }
    return { body };
  }

  // A task, for Google: done or not goes in with a change, not a new one.
  function taskBody(d, { patch = false } = {}) {
    const title = String(d.title || '').trim();
    if (!title) return { error: 'Give it a title.' };
    const body = { title, due: isKey(d.day) ? `${d.day}T00:00:00.000Z` : null };
    if (!patch && !body.due) delete body.due;
    if (patch) Object.assign(body, tickBody(!!d.done));
    return { body };
  }

  // Ticked, or not: Google stamps the time it was done itself.
  function tickBody(done) {
    return done ? { status: 'completed' } : { status: 'needsAction', completed: null };
  }

  // Where a timed event goes when it moves: dragged to another day it
  // keeps its times; dropped at a time of day (`startMin`, minutes after
  // midnight on `toDay`) it starts then. Either way it keeps its length.
  function movedTimes(item, fromDay, toDay, startMin) {
    if (typeof startMin === 'number') {
      const [y, mo, d] = toDay.split('-').map(Number);
      const start = new Date(y, mo - 1, d, 0, startMin).getTime();
      return { start, end: start + (item.end - item.start) };
    }
    const delta = daysBetween(fromDay, toDay);
    const shift = ms => { const x = new Date(ms); x.setDate(x.getDate() + delta); return x.getTime(); };
    return { start: shift(item.start), end: shift(item.end) };
  }

  const stampOf = (ms, timeZone) => {
    const t = { dateTime: localStamp(dateKey(ms), clockOf(ms)) };
    if (timeZone) t.timeZone = timeZone;
    return t;
  };

  // Dragged from one day to another (a task to '' for no day): an event
  // keeps its times and length - or, dropped at a time of day, starts
  // then - and a task gets the new day.
  function moveBody(item, fromDay, toDay, timeZone, startMin) {
    if (item.kind === 'task') return { due: toDay ? `${toDay}T00:00:00.000Z` : null };
    const delta = daysBetween(fromDay, toDay);
    if (item.allDay) return { start: { date: addDays(item.first, delta) }, end: { date: addDays(item.last, delta + 1) } };
    const t = movedTimes(item, fromDay, toDay, startMin);
    return { start: stampOf(t.start, timeZone), end: stampOf(t.end, timeZone) };
  }

  // The same move on the item on screen, until Google's answer is in.
  function movedItem(item, fromDay, toDay, startMin) {
    if (item.kind === 'task') return Object.assign({}, item, { due: toDay || '' });
    if (item.allDay) {
      const delta = daysBetween(fromDay, toDay);
      return Object.assign({}, item, { first: addDays(item.first, delta), last: addDays(item.last, delta) });
    }
    const t = movedTimes(item, fromDay, toDay, startMin);
    return Object.assign({}, item, t, { first: dateKey(t.start), last: dateKey(Math.max(t.start, t.end - 1)) });
  }

  // Its bottom edge dragged: a new end, the start kept.
  function resizeBody(item, endMs, timeZone) {
    return { end: stampOf(endMs, timeZone) };
  }

  // ── The day by the hour ──
  //
  // A day's timed events, placed in the week's hour grid: from and to, in
  // minutes after midnight on that day (one that runs past midnight is
  // cut at the day's edges), and side by side where they overlap - `col`
  // of `cols` in their cluster of overlapping events.
  function dayLayout(entries, day) {
    const [y, mo, d] = day.split('-').map(Number);
    const dayStart = new Date(y, mo - 1, d).getTime();
    const dayEnd = new Date(y, mo - 1, d + 1).getTime();
    const minuteOf = ms => { const x = new Date(ms); return x.getHours() * 60 + x.getMinutes(); };
    const placed = entries
      .filter(e => e.item.kind === 'event' && !e.item.allDay && e.item.end > dayStart && e.item.start < dayEnd)
      .map(e => {
        const from = e.item.start <= dayStart ? 0 : minuteOf(e.item.start);
        const to = e.item.end >= dayEnd ? 1440 : minuteOf(e.item.end);
        return { item: e.item, cont: e.cont, from, to: Math.max(to, from + 1), col: 0, cols: 1 };
      })
      .sort((a, b) => a.from - b.from || b.to - a.to);
    // Clusters of events that overlap one another, each laid out in columns.
    let cluster = [];
    let ends = [];
    let reach = -1;
    const close = () => {
      for (const p of cluster) p.cols = ends.length;
      cluster = [];
      ends = [];
    };
    for (const p of placed) {
      if (p.from >= reach) close();
      let col = ends.findIndex(end => end <= p.from);
      if (col < 0) { col = ends.length; ends.push(p.to); } else ends[col] = p.to;
      p.col = col;
      cluster.push(p);
      reach = Math.max(reach, p.to);
    }
    close();
    return placed;
  }

  // ── Repeating ────────────────────────────────────────────────────────
  //
  // How an event repeats is Google's: one RRULE line, with any EXDATE or
  // RDATE lines beside it, which are kept as they are. The editor offers
  // Google's own menu - daily, weekly on the day, monthly on its weekday,
  // annually, every weekday - and a custom rule. A rule it cannot show is
  // kept untouched, unless another is chosen.

  const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
  const FREQS = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
  const WORKDAYS = 'MO,TU,WE,TH,FR';

  // Which of its weekday in its month a day is: 1 to 4, or -1 for a fifth,
  // which Google calls the last.
  const nthOf = day => { const n = Math.ceil(Number(day.slice(8)) / 7); return n > 4 ? -1 : n; };

  // Google's menu, for an event starting on `day`.
  function repeatChoices(day) {
    const wd = weekday(day);
    const nth = nthOf(day);
    return [
      { id: 'none', label: 'Does not repeat', rule: '' },
      { id: 'daily', label: 'Daily', rule: 'RRULE:FREQ=DAILY' },
      { id: 'weekly', label: `Weekly on ${WEEKDAY_NAMES[wd]}`, rule: `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[wd]}` },
      { id: 'monthly', label: `Monthly on the ${ORDINALS[nth]} ${WEEKDAY_NAMES[wd]}`, rule: `RRULE:FREQ=MONTHLY;BYDAY=${nth}${WEEKDAY_CODES[wd]}` },
      { id: 'yearly', label: `Annually on ${Number(day.slice(8))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]}`, rule: 'RRULE:FREQ=YEARLY' },
      { id: 'weekdays', label: 'Every weekday (Monday to Friday)', rule: `RRULE:FREQ=WEEKLY;BYDAY=${WORKDAYS}` },
    ];
  }

  // An RRULE line as its parts, or null for one with parts the editor does
  // not know - which is then kept as it is.
  function parseRule(line) {
    const m = /^RRULE:(.+)$/.exec(String(line || ''));
    if (!m) return null;
    const p = {};
    for (const kv of m[1].split(';')) {
      const [k, v, more] = kv.split('=');
      if (more !== undefined || !v || !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST'].includes(k)) return null;
      p[k] = v;
    }
    if (!FREQS[p.FREQ]) return null;
    const rule = { freq: p.FREQ, interval: 1, byday: [], bymonthday: 0, count: 0, until: '' };
    if (p.INTERVAL) {
      if (!/^\d{1,3}$/.test(p.INTERVAL) || Number(p.INTERVAL) < 1) return null;
      rule.interval = Number(p.INTERVAL);
    }
    if (p.BYDAY) {
      rule.byday = p.BYDAY.split(',');
      if (!rule.byday.every(d => /^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/.test(d))) return null;
    }
    if (p.BYMONTHDAY) {
      if (!/^\d{1,2}$/.test(p.BYMONTHDAY) || Number(p.BYMONTHDAY) < 1 || Number(p.BYMONTHDAY) > 31) return null;
      rule.bymonthday = Number(p.BYMONTHDAY);
    }
    if (p.COUNT) {
      if (!/^\d{1,3}$/.test(p.COUNT) || Number(p.COUNT) < 1) return null;
      rule.count = Number(p.COUNT);
    }
    if (p.UNTIL) {
      const u = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(p.UNTIL);
      if (!u) return null;
      rule.until = `${u[1]}-${u[2]}-${u[3]}`;
    }
    return rule;
  }

  // The editor's own form of a rule: every `every` `unit`s; on `days` of a
  // week; a month by its date or by its weekday; ending never, `on` a day,
  // or `after` so many times.
  function customFor(day) {
    return { every: 1, unit: 'week', days: [WEEKDAY_CODES[weekday(day)]], monthBy: 'date', ends: 'never', until: addMonths(day, 3), count: 10 };
  }

  // A parsed rule as the editor's form, or null if the form cannot hold it.
  function customOf(rule, day) {
    if (!rule) return null;
    const c = Object.assign(customFor(day), { every: rule.interval, unit: FREQS[rule.freq] });
    const plain = rule.byday.filter(d => /^[A-Z]{2}$/.test(d));
    if (rule.freq === 'WEEKLY') {
      if (plain.length !== rule.byday.length || rule.bymonthday) return null;
      if (plain.length) c.days = WEEKDAY_CODES.filter(d => plain.includes(d));
    } else if (rule.freq === 'MONTHLY') {
      if (rule.byday.length > 1 || (rule.byday.length && plain.length) || (rule.byday.length && rule.bymonthday)) return null;
      c.monthBy = rule.byday.length ? 'weekday' : 'date';
    } else if (rule.byday.length || rule.bymonthday) {
      return null;
    }
    if (rule.count) Object.assign(c, { ends: 'after', count: rule.count });
    else if (rule.until) Object.assign(c, { ends: 'on', until: rule.until });
    return c;
  }

  // The editor's form as an RRULE line, for an event starting on `day`. An
  // end date is the day itself for an all-day event, and the end of that
  // day in UTC for a timed one, as Google wants it.
  function customRule(c, day, allDay) {
    const freq = Object.keys(FREQS).find(k => FREQS[k] === c.unit) || 'WEEKLY';
    const parts = [`FREQ=${freq}`];
    const every = Math.max(1, Math.min(999, Math.round(Number(c.every) || 1)));
    if (every > 1) parts.push(`INTERVAL=${every}`);
    if (freq === 'WEEKLY') {
      const days = WEEKDAY_CODES.filter(d => (c.days || []).includes(d));
      parts.push(`BYDAY=${(days.length ? days : [WEEKDAY_CODES[weekday(day)]]).join(',')}`);
    }
    if (freq === 'MONTHLY' && c.monthBy === 'weekday') parts.push(`BYDAY=${nthOf(day)}${WEEKDAY_CODES[weekday(day)]}`);
    if (c.ends === 'after') parts.push(`COUNT=${Math.max(1, Math.min(999, Math.round(Number(c.count) || 1)))}`);
    if (c.ends === 'on' && isKey(c.until)) {
      const ymd = c.until.replace(/-/g, '');
      parts.push(`UNTIL=${allDay ? ymd : `${ymd}T235959Z`}`);
    }
    return `RRULE:${parts.join(';')}`;
  }

  // How an event repeats, from its recurrence lines and its first day:
  // { id } - a choice from the menu, 'custom' with its form, 'other' for a
  // rule kept as it is - and the rule line itself.
  function repeatOf(lines, day) {
    const rule = (lines || []).find(l => /^RRULE:/.test(l)) || '';
    if (!rule) return { id: 'none', rule: '' };
    const parsed = parseRule(rule);
    if (!parsed) return { id: 'other', rule };
    const same = (a, b) => a && b && a.freq === b.freq && a.interval === b.interval && a.count === b.count &&
      a.until === b.until && a.bymonthday === b.bymonthday && a.byday.slice().sort().join() === b.byday.slice().sort().join();
    const preset = repeatChoices(day).find(c => c.rule && same(parseRule(c.rule), parsed));
    if (preset) return { id: preset.id, rule };
    const custom = customOf(parsed, day);
    return custom ? { id: 'custom', rule, custom } : { id: 'other', rule };
  }

  // The rule line for what the editor holds, for an event starting on
  // `day`: a choice from the menu (worked out for that day), the custom
  // form, or the rule kept as it was.
  function ruleFor(repeat, day, allDay) {
    if (!repeat || repeat.id === 'none') return '';
    if (repeat.id === 'custom') return customRule(repeat.custom || customFor(day), day, allDay);
    if (repeat.id === 'other') return repeat.rule || '';
    const c = repeatChoices(day).find(x => x.id === repeat.id);
    return c ? c.rule : '';
  }

  // The recurrence lines with a new rule: the other lines (dates left out
  // or added) kept; none at all once it no longer repeats.
  function recurrenceWith(lines, rule) {
    if (!rule) return [];
    return [rule].concat((lines || []).filter(l => !/^RRULE:/.test(l)));
  }

  const listOf = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '');

  // In words, as the editor shows it: "Every 2 weeks on Monday and
  // Thursday, 10 times".
  function describeRepeat(repeat, day) {
    if (!repeat || repeat.id === 'none') return 'Does not repeat';
    if (repeat.id !== 'custom' && repeat.id !== 'other') {
      const c = repeatChoices(day).find(x => x.id === repeat.id);
      return c ? c.label : '';
    }
    const c = repeat.id === 'custom' ? repeat.custom : null;
    if (!c) return 'Repeats as set in Google Calendar';
    const unit = c.every > 1 ? `Every ${c.every} ${c.unit}s` : `${{ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Annually' }[c.unit]}`;
    let on = '';
    if (c.unit === 'week') on = ` on ${listOf(WEEKDAY_CODES.filter(d => c.days.includes(d)).map(d => WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(d)]))}`;
    if (c.unit === 'month') on = c.monthBy === 'weekday' ? ` on the ${ORDINALS[nthOf(day)]} ${WEEKDAY_NAMES[weekday(day)]}` : ` on day ${Number(day.slice(8))}`;
    const end = c.ends === 'after' ? `, ${c.count} time${c.count === 1 ? '' : 's'}`
      : c.ends === 'on' && isKey(c.until) ? `, until ${Number(c.until.slice(8))} ${MONTHS[Number(c.until.slice(5, 7)) - 1]} ${c.until.slice(0, 4)}` : '';
    return unit + on + end;
  }

  // A change made on one occurrence, for the whole series: the series still
  // starts on its first day, moved by as many days as the occurrence was,
  // with the occurrence's new times, length, title and place.
  function seriesDraft(seriesStartDay, occurrenceDay, d) {
    const day = addDays(seriesStartDay, daysBetween(occurrenceDay, d.day));
    const span = Math.max(0, daysBetween(d.day, isKey(d.endDay) ? d.endDay : d.day));
    return Object.assign({}, d, { day, endDay: addDays(day, span) });
  }

  // The first day of a series, from Google's event for it.
  function startDayOf(ev) {
    const s = (ev && ev.start) || {};
    return isKey(s.date) ? s.date : isFinite(Date.parse(s.dateTime)) ? dateKey(Date.parse(s.dateTime)) : '';
  }

  const eventsPath = calendarId => `calendars/${encodeURIComponent(calendarId)}/events`;
  const eventPath = item => `${eventsPath(item.source)}/${encodeURIComponent(item.eventId)}`;
  const tasksPath = listId => `lists/${encodeURIComponent(listId)}/tasks`;
  const taskPath = item => `${tasksPath(item.source)}/${encodeURIComponent(item.taskId)}`;

  const api = {
    SCOPES, BASES, USERINFO_URL, VIEWS, AGENDA_DAYS, DAY_NAMES, MONTHS, MONTHS_LONG, EVENT_COLOURS,
    isAllowedRequest, buildUrl,
    normTime, parseQuick, localStamp, draftOf, newDraft, eventBody, taskBody, tickBody, moveBody, movedItem, resizeBody, dayLayout,
    WEEKDAY_CODES, WEEKDAY_NAMES, repeatChoices, parseRule, customFor, customOf, customRule, repeatOf, ruleFor,
    recurrenceWith, describeRepeat, seriesDraft, startDayOf,
    eventsPath, eventPath, tasksPath, taskPath,
    dateKey, isKey, fromKey, addDays, daysBetween, weekday, weekStart, isoWeek, monthStart, addMonths, days,
    viewRange, step, monthWeeks, spanText, title, monthName, dayName,
    safeColour, safeLink, calendarSource, listSource, sources, isOn,
    sourceRequests, rangeRequests, eventItem, taskItem, uniqueById, compareItems, byDay, tray,
  };

  ns.calendarLogic = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

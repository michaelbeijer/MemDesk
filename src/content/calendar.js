// ─────────────────────────────────────────────────────────────────────
// The calendar view
//
// The board's third tab: Google Calendar's events with Google Tasks'
// tasks among them, day by day, changed here and in Google alike.
//
// On a computer there are three views - Week (by the hour, as in Google
// Calendar, or two rows: Monday to Thursday above Friday to Sunday and
// the scratchpad, at the click of a button beside the views), Month and
// Agenda (four weeks as one list) - beside a small month, the calendars
// and task lists to show or hide, and the tasks with no date. Narrow, as
// on a phone, it is always the week: two columns of days with the month
// as the eighth tile, the sources as a row of chips above, and the tasks
// with no date below. A swipe goes to the next or previous week, and a
// button turns the order of the days from down-then-across to
// across-then-down.
//
// Keys, as in Google Calendar: t today, j / n next, k / p previous,
// w / m / a for the views.
//
// The board owns the overlay, the header and the account panels; this
// file owns the body while the Calendar tab is showing. Its element is
// built once and kept, like the notes'.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});
  const { h, icon, toast } = ns.ui;
  const { calendarStore: store, hooks, APP_NAME } = ns;
  const cal = ns.calendarLogic;

  const STALE_MS = 60 * 1000;
  const NARROW_PX = 720;
  // A month cell shows this many, then "+2 more".
  const MONTH_ROWS = 4;
  const SWIPE_PX = 60;
  // The week by the hour: a drag moves in quarter hours, a click adds at
  // the half hour, and the hours open at seven in the morning.
  const STEP_MIN = 15;
  const CLICK_MIN = 30;
  const FIRST_HOUR = 7;

  const C = {
    ctx: null,          // { root, onStateError, onLoaded, barChanged, prefs, connect }
    view: 'week',       // the view chosen on a wide screen
    order: 'down',      // narrow: the days down then across, or 'across' then down
    layout: 'columns',  // wide, the week: by the hour in seven columns, or two 'rows'
    zone2: '',          // by the hour: a second time zone beside your own, or none
    hoursTop: null,     // how far the hours were scrolled, kept across redraws
    anchor: '',         // the day in focus
    today: '',
    narrow: false,
    sources: [],
    overrides: {},      // source id → shown or not, where flicked here
    prefsRead: false,
    status: 'idle',     // idle | loading | ready | error | signin | mismatch
    error: '',
    errors: {},         // service → error, for the note above the days
    shown: null,        // { key, range, items, fetched: Set, errors, at } on screen
    cache: new Map(),   // range key → the same
    loading: null,
    loadedAt: 0,
    seq: 0,
    recheck: false,     // Allow was pressed: read everything again on return
    writes: Promise.resolve(), // changes go to Google one after another
    pending: 0,         // changes on their way: a read started before one lands is not shown
    later: new Map(),   // key → { timer, hides }: done on screen, sent to Google once its Undo has passed
    drag: null,         // { item, from, timed, grab, startMin }: what is being dragged, and from which day ('' for no day)
    edit: null,         // the editor, while it is open
  };

  const els = {};
  let timeFormat = null;

  // ── Setup ────────────────────────────────────────────────────────────

  function init(ctx) {
    C.ctx = ctx;
    C.today = cal.dateKey(new Date());
    C.anchor = C.today;
    // Back from Google's permission page (opened by Allow): read again.
    window.addEventListener('focus', () => { if (C.recheck) load(); });
  }

  function element() {
    if (els.wrap) return els.wrap;

    const nav = (dir, label, name) => h('button', {
      class: 'icon-btn', type: 'button', title: label, 'aria-label': label,
      dataset: { key: `cal-${name}` }, onclick: () => go(cal.step(view(), C.anchor, dir)),
    }, icon(name, 20));

    els.title = h('h2', { class: 'cal-title', 'aria-live': 'polite' });
    els.views = h('div', { class: 'cal-views', role: 'tablist', 'aria-label': 'Calendar view' },
      cal.VIEWS.map(v => h('button', {
        class: 'seg', type: 'button', role: 'tab', dataset: { key: `cal-view:${v}`, view: v },
        text: v[0].toUpperCase() + v.slice(1), onclick: () => setView(v),
      })));
    els.head = h('div', { class: 'cal-head' },
      h('div', { class: 'cal-nav' },
        h('button', {
          class: 'btn btn-outline cal-today', type: 'button', text: 'Today', dataset: { key: 'cal-today' },
          title: 'Today (T)', onclick: () => go(cal.dateKey(new Date())),
        }),
        nav(-1, 'Previous', 'prev'),
        nav(1, 'Next', 'next'),
        // Narrow only: which way the days run in the two columns.
        els.order = h('button', {
          class: 'icon-btn cal-order', type: 'button', dataset: { key: 'cal-order' }, onclick: toggleOrder,
        })),
      els.title,
      // Wide, in the week: seven columns or two rows.
      els.layout = h('button', {
        class: 'icon-btn cal-layout', type: 'button', dataset: { key: 'cal-layout' }, onclick: toggleLayout,
      }),
      els.views);

    els.note = h('div', { class: 'cal-note', role: 'status' });
    els.mini = h('div', { class: 'cal-mini' });
    els.sources = h('div', { class: 'cal-sources', role: 'group', 'aria-label': 'Calendars and task lists' });
    // A task dragged here loses its day.
    els.tray = h('section', { class: 'cal-tray', 'aria-label': 'Tasks without a day', dataset: { drop: '' } });
    els.main = h('section', { class: 'cal-main' });
    els.main.addEventListener('touchstart', onTouchStart, { passive: true });
    els.main.addEventListener('touchend', onTouchEnd, { passive: true });

    els.wrap = h('div', { class: 'cal' },
      els.head,
      els.note,
      h('div', { class: 'cal-body' },
        h('aside', { class: 'cal-side' }, els.mini, els.sources, els.tray),
        els.main));

    // Dragging an event or a task to another day (or a task to No date).
    els.wrap.addEventListener('dragover', onDragOver);
    els.wrap.addEventListener('drop', onDrop);
    els.wrap.addEventListener('dragend', endDrag);

    // Narrow or wide is about the space the view has, not the screen.
    // Going narrow can change the view (to the week), and so the days.
    new ResizeObserver(entries => {
      const narrow = entries[0].contentRect.width < NARROW_PX;
      if (narrow === C.narrow) return;
      const before = rangeKey(range());
      C.narrow = narrow;
      if (rangeKey(range()) !== before && (C.status === 'ready' || C.status === 'loading')) load();
      else draw();
    }).observe(els.wrap);

    draw();
    return els.wrap;
  }

  // A narrow view is always the week.
  function view() {
    return C.narrow ? 'week' : C.view;
  }

  function range() {
    return cal.viewRange(view(), C.anchor);
  }

  async function readPrefs() {
    if (C.prefsRead) return;
    C.prefsRead = true;
    try {
      const names = ['calendarView', 'calendarSources', 'calendarOrder', 'calendarWeekLayout', 'calendarZone2'];
      const [v, o, order, layout, zone2] = await Promise.all(names.map(n => C.ctx.prefs.get(n)));
      if (cal.VIEWS.includes(v)) C.view = v;
      if (o && typeof o === 'object') C.overrides = o;
      if (order === 'across' || order === 'down') C.order = order;
      if (layout === 'rows' || layout === 'columns') C.layout = layout;
      if (isZone(zone2)) C.zone2 = zone2;
    } catch { /* storage gone (extension reloaded); defaults will do */ }
  }

  function savePref(name, value) {
    Promise.resolve().then(() => C.ctx.prefs.set(name, value)).catch(() => {});
  }

  // ── Loading ──────────────────────────────────────────────────────────

  const isOn = s => cal.isOn(s, C.overrides);
  const onSources = () => C.sources.filter(isOn);
  const rangeKey = r => `${r.start}|${r.end}`;

  // What is on screen covers the range and every source that is on.
  function covers(entry) {
    return !!entry && onSources().every(s => entry.fetched.has(s.id));
  }

  function isStale() {
    const entry = C.cache.get(rangeKey(range()));
    return C.recheck || C.status !== 'ready' || !covers(entry) || Date.now() - entry.at > STALE_MS;
  }

  // Shows whatever is cached for the range at once, then reads Google
  // if that is missing, old or short of a source that has been switched
  // on. A newer load (the next week, tapped quickly) overtakes this one.
  function load({ force = false } = {}) {
    if (!els.wrap) element();
    // The view chosen last time decides which days to read.
    if (!C.prefsRead) return readPrefs().then(() => load({ force }));
    // Permission may have been given since: nothing cached counts.
    if (C.recheck) {
      C.recheck = false;
      force = true;
      C.cache.clear();
      store.forget();
    }
    const r = range();
    const key = rangeKey(r);
    const cached = C.cache.get(key);
    if (cached) {
      C.shown = cached;
      if (C.status === 'idle') C.status = 'ready';
    }
    draw();
    if (!force && !isStale()) return Promise.resolve();

    const seq = ++C.seq;
    if (!C.shown || C.shown.key !== key) C.shown = null;
    if (!C.shown && C.status !== 'signin' && C.status !== 'mismatch') C.status = 'loading';
    draw();

    const run = (async () => {
      try {
        const account = hooks.getAccount();
        const got = await store.loadSources(account, { force });
        C.sources = got.sources;
        const wanted = onSources();
        const result = await store.loadRange(r, wanted);
        if (seq !== C.seq) return;
        // Read before a change landed: the read that follows it is the one to show.
        if (C.pending) return;
        const entry = {
          key, range: r, items: result.items, at: Date.now(),
          fetched: new Set(wanted.map(s => s.id)),
          errors: Object.assign({}, got.errors, result.errors),
        };
        C.cache.set(key, entry);
        C.shown = entry;
        C.errors = entry.errors;
        C.status = 'ready';
        C.error = '';
        C.loadedAt = Date.now();
        if (C.ctx.onLoaded) C.ctx.onLoaded();
      } catch (err) {
        if (seq !== C.seq) return;
        if (err.code === 'calendar_auth_required') C.status = 'signin';
        else if (err.code === 'calendar_mismatch') { C.status = 'mismatch'; C.error = err.message; }
        else if (err.code === 'not_configured') {
          // No client ID at all: the board's setup panel says what to do.
          C.status = 'idle';
          C.ctx.onStateError(err);
        } else if (C.shown) {
          C.status = 'ready';
          toast(C.ctx.root, `Couldn’t load the calendar: ${err.message}`, { kind: 'error' });
        } else {
          C.status = 'error';
          C.error = err.message;
        }
      } finally {
        if (C.loading === run) C.loading = null;
        draw();
        C.ctx.barChanged();
      }
    })();
    C.loading = run;
    C.ctx.barChanged();
    return run;
  }

  async function connect(btn) {
    if (btn) btn.disabled = true;
    try {
      await C.ctx.connect();
      C.status = 'loading';
      store.forget();
      await load({ force: true });
    } catch (err) {
      if (err.code === 'calendar_mismatch') {
        C.status = 'mismatch';
        C.error = err.message;
        draw();
      } else if (err.code === 'not_configured') {
        C.ctx.onStateError(err);
      } else {
        toast(C.ctx.root, `Couldn’t connect: ${err.message}`, { kind: 'error' });
      }
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  // ── Moving about ─────────────────────────────────────────────────────

  function go(anchor) {
    if (!cal.isKey(anchor)) return;
    C.anchor = anchor;
    C.today = cal.dateKey(new Date());
    load();
  }

  // In two columns, the days run down then across (Monday to Thursday on
  // the left), or across then down (Monday beside Tuesday).
  function toggleOrder() {
    C.order = C.order === 'across' ? 'down' : 'across';
    savePref('calendarOrder', C.order);
    draw();
  }

  // On a computer, the week by the hour, or as two rows: Monday to
  // Thursday above, Friday to Sunday below.
  function toggleLayout() {
    C.layout = C.layout === 'rows' ? 'columns' : 'rows';
    savePref('calendarWeekLayout', C.layout);
    draw();
  }

  function setView(v) {
    if (!cal.VIEWS.includes(v)) return;
    C.view = v;
    savePref('calendarView', v);
    load();
  }

  function toggleSource(s) {
    C.overrides = Object.assign({}, C.overrides, { [s.id]: !isOn(s) });
    savePref('calendarSources', C.overrides);
    // Switched off: just hidden. Switched on and not read yet: read now.
    if (covers(C.shown)) draw();
    else load();
  }

  let touch = null;
  function onTouchStart(e) {
    if (!C.narrow || e.touches.length !== 1) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchEnd(e) {
    if (!touch || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) go(cal.step('week', C.anchor, dx < 0 ? 1 : -1));
  }

  // ── Drawing ──────────────────────────────────────────────────────────

  // Through the style API, not a style attribute: a page's security
  // policy may refuse inline style attributes, never this.
  function tint(el, name, value) {
    if (value) el.style.setProperty(name, value);
    return el;
  }

  function draw() {
    if (!els.wrap) return;
    // Redrawing replaces the chips and the small month; whichever of them
    // had the focus gets it back, or the next key would go to Gmail.
    const active = C.ctx.root.activeElement;
    const key = active && els.wrap.contains(active) && active.dataset ? active.dataset.key || '' : '';
    paint();
    if (key && !els.wrap.contains(C.ctx.root.activeElement)) {
      const again = [...els.wrap.querySelectorAll('[data-key]')].find(x => x.dataset.key === key && x.getClientRects().length);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function paint() {
    const v = view();
    els.wrap.dataset.narrow = String(C.narrow);
    els.wrap.dataset.view = v;
    els.wrap.dataset.order = C.order;
    const across = C.order === 'across';
    els.order.replaceChildren(icon(across ? 'rows' : 'columns', 20));
    els.order.title = across ? 'Days run across, then down. Tap for down, then across.' : 'Days run down, then across. Tap for across, then down.';
    els.order.setAttribute('aria-label', els.order.title);
    els.wrap.dataset.layout = C.layout;
    const rows = C.layout === 'rows';
    els.layout.replaceChildren(icon(rows ? 'rows' : 'columns', 20));
    els.layout.title = rows
      ? 'The week in two rows, Monday to Thursday above Friday to Sunday. Click for the week by the hour.'
      : 'The week by the hour. Click for two rows, Monday to Thursday above Friday to Sunday.';
    els.layout.setAttribute('aria-label', els.layout.title);
    els.title.textContent = cal.title(v, C.anchor, C.today);
    for (const b of els.views.children) b.setAttribute('aria-selected', String(b.dataset.view === v));
    const panel = statusPanel();
    els.wrap.classList.toggle('cal-panel', !!panel);
    drawNote();
    drawMini();
    drawSources();
    drawTray();
    if (panel) els.main.replaceChildren(panel);
    else if (v === 'month') els.main.replaceChildren(drawMonth());
    else if (v === 'agenda') els.main.replaceChildren(drawAgenda());
    else {
      const week = drawWeek();
      // Already showing: left in place (see drawWeek).
      if (els.main.firstChild !== week || els.main.childNodes.length !== 1) els.main.replaceChildren(week);
      // By the hour: where it was scrolled to, or seven in the morning
      // (and a little before, so that its hour shows).
      if (isHours()) {
        const body = week.querySelector('.grid-body');
        week.scrollTop = C.hoursTop !== null ? C.hoursTop : body ? body.offsetHeight / 24 * (FIRST_HOUR - 0.25) : 0;
      }
    }
  }

  // What is on, from the sources that are on, by day - less anything
  // deleted here that is still waiting out its Undo.
  function visibleItems() {
    if (!C.shown) return [];
    const on = new Set(onSources().map(s => s.id));
    const waiting = [...C.later.values()].filter(l => l.hides);
    return C.shown.items.filter(x => on.has(x.source) && !waiting.some(l => l.hides(x)));
  }

  function statusPanel() {
    switch (C.status) {
      case 'signin':
        return panel('calendar', 'Connect Google Calendar',
          `See your Google Calendar and Google Tasks here, beside the board and the notes. ${APP_NAME} only reads them. Google will ask you to allow it.`,
          C.ctx.connect ? [button('Connect Google Calendar', 'primary', connect)] : []);
      case 'mismatch':
        return panel('calendar', 'That was a different account', `${C.error} Connect again and choose ${hooks.getAccount()}.`,
          C.ctx.connect ? [button('Connect again', 'primary', connect)] : []);
      case 'error':
        return panel('refresh', 'Couldn’t load the calendar', C.error,
          [button('Try again', 'primary', () => load({ force: true }))]);
      default:
        return null;
    }
  }

  function panel(iconName, title, text, actions) {
    return h('div', { class: 'panel', role: 'region', 'aria-label': title },
      h('span', { class: 'panel-icon' }, icon(iconName, 28)),
      h('h2', { text: title }),
      h('p', {}, linked(text)),
      actions.length ? h('div', { class: 'actions' }, actions) : null);
  }

  function button(label, kind, onClick) {
    return h('button', {
      class: ['btn', `btn-${kind}`], type: 'button', text: label,
      onclick: e => onClick(e.currentTarget),
    });
  }

  // Google's messages carry the link that fixes them ("enable it by
  // visiting https://console…"): make it one.
  function linked(text) {
    const out = [];
    let last = 0;
    const re = /https:\/\/[^\s<>"]+[^\s<>".,)]/g;
    let m;
    while ((m = re.exec(String(text)))) {
      out.push(text.slice(last, m.index), h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
      last = m.index + m[0].length;
    }
    out.push(String(text).slice(last));
    return out;
  }

  // A line above the days for a service that could not be read. Not
  // allowed is one line for both, with the way to allow it: in Chrome,
  // connecting again; in the phone app, Google's page for the script.
  function drawNote() {
    const lines = [];
    if (!statusPanel()) {
      const name = service => (service === 'tasks' ? 'Google Tasks' : 'Google Calendar');
      const errors = Object.entries(C.errors || {});
      const denied = errors.filter(([, err]) => err.code === 'calendar_scope');
      if (denied.length) {
        const url = (denied.find(([, err]) => err.allowUrl) || [])[1];
        const fix = C.ctx.connect ? button('Connect again', 'text', connect)
          : url ? h('a', {
            class: 'btn btn-text', href: url.allowUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Allow',
            dataset: { key: 'cal-allow' }, onclick: () => { C.recheck = true; },
          })
          : h('span', { text: ' In the script editor, run allowCalendar once.' });
        lines.push(h('p', {},
          h('strong', { text: denied.map(([service]) => name(service)).join(' and ') }),
          ` ${denied.length > 1 ? 'need' : 'needs'} your permission. `, fix));
      }
      for (const [service, err] of errors) {
        if (err.code === 'calendar_scope') continue;
        lines.push(h('p', {}, h('strong', { text: `${name(service)}: ` }), linked(err.message || String(err))));
      }
    }
    els.note.replaceChildren(...lines);
    els.note.hidden = !lines.length;
  }

  function drawSources() {
    const list = C.sources;
    els.sources.hidden = !list.length || !!statusPanel();
    els.sources.replaceChildren(...list.map(s => tint(h('button', {
      class: ['src', `src-${s.kind}`], type: 'button', 'aria-pressed': String(isOn(s)),
      title: `${isOn(s) ? 'Hide' : 'Show'} ${s.name}`, dataset: { key: `cal-src:${s.id}` },
      onclick: () => toggleSource(s),
    }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('span', { class: 'src-name', text: s.name })), '--src', s.colour)));
  }

  // Overdue tasks already on a day on screen are not listed twice.
  function drawTray() {
    const panelUp = !!statusPanel();
    const r = range();
    const t = cal.tray(visibleItems(), C.today);
    t.overdue = t.overdue.filter(x => x.due < r.start || x.due >= r.end);
    const group = (label, list) => (list.length ? [
      h('h3', {}, label, h('span', { class: 'count', text: ` · ${list.length}` })),
      h('div', { class: 'cal-items' }, list.map(x => itemEl({ item: x, cont: false }, { due: label === 'Overdue' }))),
    ] : []);
    const kids = [...group('Overdue', t.overdue), ...group('No date', t.undated)];
    els.tray.replaceChildren(...kids);
    els.tray.hidden = panelUp || !kids.length;
  }

  function drawMini() {
    els.mini.replaceChildren(miniMonth());
  }

  // The small month: the month in focus, the days on screen marked; a
  // tap on a day goes there.
  function miniMonth() {
    const r = range();
    const m = cal.monthName(C.anchor);
    const rows = cal.monthWeeks(C.anchor);
    const month = C.anchor.slice(0, 7);
    return h('div', { class: 'mini' },
      h('div', { class: 'mini-head', text: `${m.long}${m.year !== Number(C.today.slice(0, 4)) ? ` ${m.year}` : ''}` }),
      h('div', { class: 'mini-grid', role: 'grid', 'aria-label': `${m.long} ${m.year}` },
        cal.DAY_NAMES.map(d => h('span', { class: 'mini-dow', text: d[0], 'aria-hidden': 'true' })),
        rows.flat().map(k => h('button', {
          class: ['mini-day', k.slice(0, 7) !== month && 'other', k === C.today && 'today',
            k >= r.start && k < r.end && 'shown'],
          type: 'button', text: String(Number(k.slice(8))), 'aria-label': longDate(k),
          dataset: { key: `cal-mini:${k}` }, onclick: () => go(k),
        }))));
  }

  function longDate(k) {
    const m = cal.monthName(k);
    return `${cal.dayName(k)} ${Number(k.slice(8))} ${m.long} ${m.year}`;
  }

  function dayHead(k) {
    return h('header', { class: 'day-head' },
      h('span', { class: 'dname', text: cal.dayName(k) }),
      h('span', { class: 'dnum', text: String(Number(k.slice(8))) }),
      k === C.today ? h('span', { class: 'badge', text: 'today' }) : null,
      addButton(k));
  }

  // The + on a day: a new event or task on it, if there is anywhere to
  // put one.
  function addButton(k) {
    if (!canChange() || !writable().length) return null;
    const label = `Add to ${longDate(k)}`;
    return h('button', {
      class: 'icon-btn day-add', type: 'button', title: label, 'aria-label': label,
      dataset: { key: `cal-add:${k}` }, onclick: () => openEditor(null, k),
    }, icon('add', 18));
  }

  function dayClasses(k, base) {
    const wd = cal.weekday(k);
    return [base, k === C.today && 'today', wd >= 5 && 'weekend', wd === 6 && 'sunday', k < C.today && 'past'];
  }

  // The week is one element, kept: its days are drawn afresh each time,
  // but the scratchpad tile in the two rows' eighth space is only ever
  // moved in or out, never taken out and put back - that would take the
  // cursor out of it whenever the week was redrawn mid-sentence.
  function drawWeek() {
    const r = range();
    const keys = cal.days(r.start, r.end);
    const byDay = cal.byDay(visibleItems(), keys);
    const loading = C.status === 'loading' && !C.shown;
    const tile = !C.narrow && C.layout === 'rows' && ns.notes ? ns.notes.scratchTile() : null;
    if (!els.week) {
      els.week = h('div', { role: 'list' });
      els.week.addEventListener('scroll', () => {
        if (els.week.classList.contains('hours')) C.hoursTop = els.week.scrollTop;
      }, { passive: true });
    }
    const week = els.week;
    const hours = isHours();
    week.className = ['cal-week', hours && 'hours', loading && 'loading'].filter(Boolean).join(' ');
    for (const kid of [...week.children]) if (kid !== tile) kid.remove();
    if (hours) {
      week.append(...drawHours(keys, byDay));
      return week;
    }
    const days = keys.map(k => h('section', { class: dayClasses(k, 'day'), role: 'listitem', 'aria-label': longDate(k), dataset: { day: k, drop: k } },
      dayHead(k),
      h('div', { class: 'cal-items' }, byDay.get(k).map(e => itemEl(e)))));
    // The eighth tile, in the two columns of a narrow screen.
    days.push(h('div', { class: 'day mini-tile', 'aria-hidden': C.narrow ? null : 'true' }, miniMonth()));
    if (tile && tile.parentNode === week) days.forEach(d => week.insertBefore(d, tile));
    else week.append(...days, ...(tile ? [tile] : []));
    return week;
  }

  // ── The week by the hour ──
  //
  // On a computer, as in Google Calendar: seven columns beside the hours,
  // each day's all-day events and tasks along the top, its other events
  // placed by the hour, side by side where they overlap. The hours scroll
  // under the days' heads. An event can be dragged to another time (in
  // quarter hours) or day, and its bottom edge up or down to change when
  // it ends; a click on an empty half hour adds one there.

  const isHours = () => !C.narrow && view() === 'week' && C.layout === 'columns';

  const pad2 = n => String(n).padStart(2, '0');
  const clock = min => `${pad2(Math.floor(min / 60) % 24)}:${pad2(min % 60)}`;
  const minuteOf = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
  const dayStart = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  function setVars(el, vars) {
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, String(value));
    return el;
  }

  function drawHours(keys, byDay) {
    // All-day events and tasks: a row tall enough for the busiest day,
    // up to four; more than that scroll within their day.
    const untimed = k => byDay.get(k).filter(e => e.item.kind !== 'event' || e.item.allDay);
    const rows = Math.min(4, Math.max(1, ...keys.map(k => untimed(k).length)));
    setVars(els.week, { '--allday-rows': rows });
    els.week.dataset.zones = C.zone2 ? '2' : '1';
    const now = minuteOf(Date.now());
    const days = keys.map(k => h('section', {
      class: dayClasses(k, 'day'), role: 'listitem', 'aria-label': longDate(k), dataset: { day: k, drop: k },
    },
    dayHead(k),
    h('div', { class: 'cal-items grid-allday' }, untimed(k).map(e => itemEl(e))),
    hoursBody(k, byDay.get(k), k === C.today ? now : -1)));
    return [hoursColumn(keys), ...days];
  }

  function hoursBody(k, entries, now) {
    const body = h('div', { class: 'grid-body', onclick: e => clickHour(e, k) });
    for (const p of cal.dayLayout(entries, k)) body.append(...timedEls(p, k));
    if (now >= 0) body.append(setVars(h('div', { class: 'now-line', 'aria-hidden': 'true' }), { '--from': now }));
    return body;
  }

  // An event in the hours, and for one that ends that day and can be
  // changed here, the edge that drags its end.
  function timedEls(p, k) {
    const { item } = p;
    const place = { '--from': p.from, '--to': p.to, '--col': p.col, '--cols': p.cols };
    const el = setVars(itemEl({ item, cont: p.cont }, { hours: p }), place);
    if (!item.editable || !canChange() || cal.dateKey(item.end - 1) !== k) return [el];
    const edge = h('span', {
      class: 'grid-resize', title: `Drag to change when “${item.title}” ends`, 'aria-hidden': 'true',
      onpointerdown: e => startResize(e, p, k, el),
      onclick: () => openEditor(item),
    });
    return [el, setVars(edge, place)];
  }

  // The hours down the side, in your own time zone, and beside them in a
  // second one if chosen. Its hours are worked out for today, or for the
  // week's first day: in a week where one of the two puts its clocks
  // forward or back and the other does not, they are an hour out on the
  // days before the change.
  function hoursColumn(keys) {
    const base = keys.includes(C.today) ? C.today : keys[0];
    const [y, m, d] = base.split('-').map(Number);
    const at = hr => new Date(y, m - 1, d, hr);
    const here = timeZone();
    const zones = C.zone2 ? [C.zone2, here] : [here];
    const label = z => `${z === here ? 'Your time zone' : 'Second time zone'}: ${zoneName(z)} (${zoneShort(z, at(12))})`;
    const corner = h('div', { class: 'grid-corner' },
      h('button', {
        class: 'grid-zones', type: 'button', dataset: { key: 'cal-zones' }, onclick: openZones,
        title: `${zones.map(label).join('\n')}\nClick to ${C.zone2 ? 'change or remove the second' : 'add a second'} time zone.`,
        'aria-label': C.zone2 ? 'Time zones' : 'Add a second time zone',
      },
      zones.map(z => h('span', { class: z === here ? 'own' : 'other', text: zoneShort(z, at(12)) })),
      C.zone2 ? null : icon('add', 14)));
    const hours = [];
    for (let hr = 0; hr < 24; hr++) {
      hours.push(h('div', { class: 'grid-hour' }, hr ? zones.map(z => h('span', {
        class: z === here ? 'own' : 'other', text: z === here ? clock(hr * 60) : zoneClock(z, at(hr)),
      })) : null));
    }
    return h('div', { class: 'grid-times' }, corner, h('div', { class: 'grid-hours', 'aria-hidden': 'true' }, hours));
  }

  const zoneFormats = new Map();
  function zoneFormat(z, options) {
    const key = `${z}|${JSON.stringify(options)}`;
    if (!zoneFormats.has(key)) zoneFormats.set(key, new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: z || undefined }, options)));
    return zoneFormats.get(key);
  }

  function isZone(z) {
    if (typeof z !== 'string' || !z) return false;
    try { zoneFormat(z, {}); return true; } catch { return false; }
  }

  // "GMT+2", "GMT+5:30", "GMT".
  function zoneShort(z, when) {
    try {
      const part = zoneFormat(z, { timeZoneName: 'shortOffset' }).formatToParts(when).find(x => x.type === 'timeZoneName');
      return part ? part.value : z;
    } catch { return z; }
  }

  const zoneName = z => String(z).replace(/_/g, ' ');
  const zoneClock = (z, when) => zoneFormat(z, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when);

  function zoneList() {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Europe/London', 'Europe/Amsterdam', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']; }
  }

  // The second time zone: chosen from all of them, or none.
  function openZones() {
    if (!C.ctx.dialog) return;
    const here = timeZone();
    const now = new Date();
    const select = h('select', { class: 'text-input', id: 'gkb-cal-zone2', dataset: { key: 'cal-zone2' } },
      h('option', { value: '', text: 'None' }),
      zoneList().filter(z => z !== here).map(z => h('option', {
        value: z, text: `${zoneName(z)} (${zoneShort(z, now)})`, selected: z === C.zone2,
      })));
    const done = () => {
      C.zone2 = isZone(select.value) ? select.value : '';
      savePref('calendarZone2', C.zone2);
      C.ctx.dialog.close();
      draw();
    };
    C.ctx.dialog.show(h('div', { class: 'dialog cal-zones', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gkb-cal-zones-heading' },
      h('div', { class: 'dialog-head' },
        h('h2', { id: 'gkb-cal-zones-heading', text: 'Time zones' }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => C.ctx.dialog.close() }, icon('close'))),
      h('div', { class: 'dialog-body' },
        h('p', { class: 'note', text: `The hours are in your own time zone, ${zoneName(here)} (${zoneShort(here, now)}), as set on this ${C.ctx.connect ? 'computer' : 'device'}. A second one shows beside them.` }),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'gkb-cal-zone2', text: 'Second time zone' }),
          select)),
      h('div', { class: 'dialog-foot' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: () => C.ctx.dialog.close() }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Done', dataset: { key: 'cal-zones-done' }, onclick: done }))),
    { onClose: () => focusKey('cal-zones') });
    select.focus();
  }

  // Where in the day a point on the hours is, in minutes after midnight;
  // and that to the nearest `step` (or the one before, with `floor`),
  // between `lo` and `hi`.
  function minuteAt(body, y) {
    const r = body.getBoundingClientRect();
    return (y - r.top) / (r.height / 1440);
  }
  const snap = (min, step, lo, hi, floor = false) =>
    Math.min(hi, Math.max(lo, (floor ? Math.floor(min / step) : Math.round(min / step)) * step));

  // A click on an empty half hour: a new event there, an hour long.
  function clickHour(e, k) {
    if (e.target !== e.currentTarget || !canChange() || !writable('calendar').length) return;
    openEditor(null, k, snap(minuteAt(e.currentTarget, e.clientY), CLICK_MIN, 0, 1440 - CLICK_MIN, true));
  }

  // The bottom edge of an event, dragged: where it ends, in quarter hours,
  // not before a quarter hour after it starts. Followed on the window, so
  // that it ends wherever the button is let go - even if the days are
  // redrawn meanwhile. A button let go unseen (outside the window) ends
  // it with nothing changed, not at the next click.
  function startResize(e, p, k, el) {
    if (e.button) return;
    e.preventDefault();
    e.stopPropagation();
    const body = e.currentTarget.parentNode;
    const edge = e.currentTarget;
    try { edge.setPointerCapture(e.pointerId); } catch { /* the window still hears it */ }
    let to = p.to;
    const time = el.querySelector('.time');
    const move = ev => {
      if (!(ev.buttons & 1)) { finish({ type: 'pointercancel' }); return; }
      const min = snap(minuteAt(body, ev.clientY), STEP_MIN, p.from + STEP_MIN, 1440);
      if (min === to) return;
      to = min;
      setVars(el, { '--to': to });
      setVars(edge, { '--to': to });
      if (time) time.textContent = `${timeText(p.item.start)} – ${clock(to)}`;
    };
    const finish = ev => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      el.classList.remove('resizing');
      if (ev.type !== 'pointerup' || to === p.to) {
        if (to !== p.to) draw();
        return;
      }
      swallowClick();
      resizeItem(p.item, dayStart(k) + to * 60000);
    };
    el.classList.add('resizing');
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  }

  // The click that ends a drag of an edge is not a click on what is under it.
  function swallowClick() {
    const stop = e => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  }

  function drawMonth() {
    const r = range();
    const keys = cal.days(r.start, r.end);
    const byDay = cal.byDay(visibleItems(), keys);
    const month = C.anchor.slice(0, 7);
    return h('div', { class: 'cal-month' },
      h('div', { class: 'month-dows', 'aria-hidden': 'true' }, cal.DAY_NAMES.map(d => h('span', { text: d }))),
      tint(h('div', { class: 'month-grid' },
        keys.map(k => {
          const all = byDay.get(k);
          const more = all.length - MONTH_ROWS;
          return h('section', { class: [...dayClasses(k, 'mcell'), k.slice(0, 7) !== month && 'other'], 'aria-label': longDate(k), dataset: { drop: k } },
            h('div', { class: 'mhead' },
              h('button', {
                class: 'mday', type: 'button', text: String(Number(k.slice(8))), title: `Week of ${longDate(k)}`,
                dataset: { key: `cal-day:${k}` }, onclick: () => openWeek(k),
              }),
              addButton(k)),
            h('div', { class: 'cal-items' }, all.slice(0, more > 0 ? MONTH_ROWS - 1 : MONTH_ROWS).map(e => itemEl(e, { compact: true })),
              more > 0 ? h('button', { class: 'more', type: 'button', text: `+${more + 1} more`, onclick: () => openWeek(k) }) : null));
        })), '--rows', String(keys.length / 7)));
  }

  function openWeek(k) {
    C.anchor = k;
    setView('week');
  }

  function drawAgenda() {
    const r = range();
    const keys = cal.days(r.start, r.end);
    const byDay = cal.byDay(visibleItems(), keys);
    const days = keys.filter(k => byDay.get(k).length || k === C.today);
    if (C.status === 'loading' && !C.shown) return h('div', { class: 'cal-agenda loading' });
    if (!days.length) return h('div', { class: 'cal-agenda' }, h('p', { class: 'empty', text: 'Nothing on in these four weeks.' }));
    return h('div', { class: 'cal-agenda' }, days.map(k => {
      const m = cal.monthName(k);
      return h('section', { class: dayClasses(k, 'aday'), 'aria-label': longDate(k) },
        h('div', { class: 'aday-date' },
          h('span', { class: 'dnum', text: String(Number(k.slice(8))) }),
          h('span', { class: 'dname' }, h('span', { text: cal.dayName(k) }), h('span', { class: 'mon', text: m.short }))),
        h('div', { class: 'cal-items' }, byDay.get(k).length
          ? byDay.get(k).map(e => itemEl(e, { agenda: true }))
          : h('p', { class: 'empty', text: 'Nothing on today.' })));
    }));
  }

  function timeText(ms) {
    // The 24-hour clock, two digits for the hour, whatever the browser's
    // language would have chosen: "09:30", "19:30".
    if (!timeFormat) timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return timeFormat.format(new Date(ms));
  }

  function whenText(item, cont) {
    if (item.allDay) return item.first === item.last ? 'All day' : `${shortDate(item.first)} – ${shortDate(item.last)}`;
    const span = `${timeText(item.start)} – ${timeText(item.end)}`;
    return item.first === item.last ? span : `${shortDate(item.first)} ${timeText(item.start)} – ${shortDate(item.last)} ${timeText(item.end)}`;
  }

  function shortDate(k) {
    return `${Number(k.slice(8))} ${cal.monthName(k).short}`;
  }

  // An event or a task, as a link to where it lives in Google. One that
  // can be changed here opens the editor on a plain click instead (Ctrl,
  // Shift or the middle button still open it in Google), can be dragged
  // to another day (or time), and a task's box ticks it. `hours`: its
  // place in the week by the hour, from and to in minutes.
  function itemEl({ item, cont }, { compact = false, agenda = false, due = false, hours = null } = {}) {
    const editable = !!item.editable && canChange();
    const tag = item.link || editable ? 'a' : 'div';
    const link = item.link ? { href: item.link, target: '_blank', rel: 'noopener noreferrer' } : editable ? { href: '#', role: 'button' } : {};
    const edit = editable ? {
      dataset: { key: `cal-item:${item.id}` },
      onclick: e => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openEditor(item);
      },
    } : {};
    // In the hours, a piece carried over from the day before moves by days only.
    const drag = editable ? { draggable: 'true', ondragstart: e => startDrag(e, item, !!hours && !cont) } : {};
    if (item.kind === 'event') {
      const tip = [item.title, whenText(item, cont), item.where].filter(Boolean).join('\n');
      // In the hours: its title, then from and to - or, in half an hour
      // or less, one line with when it starts.
      if (hours) {
        const short = hours.to - hours.from <= 30;
        const when = cont ? `until ${timeText(item.end)}` : short ? timeText(item.start) : `${timeText(item.start)} – ${timeText(item.end)}`;
        return tint(h(tag, Object.assign({
          class: ['item', 'ev', 'timed', short && 'short'], title: tip,
        }, link, edit, drag),
        h('span', { class: 't', text: item.title }),
        h('span', { class: 'time', text: when })), '--c', item.colour);
      }
      const time = item.allDay ? (agenda ? 'All day' : '') : cont ? (agenda ? 'until ' + timeText(item.end) : '…') : timeText(item.start);
      return tint(h(tag, Object.assign({
        class: ['item', 'ev', item.allDay && 'all-day', compact && 'compact'], title: tip,
      }, link, edit, drag),
      time ? h('span', { class: 'time', text: time }) : null,
      h('span', { class: 't', text: item.title })), '--c', item.colour);
    }
    const tip = [item.title, item.list && `Google Tasks · ${item.list}`, due && item.due && `Due ${shortDate(item.due)}`,
      item.email && 'Opens the email'].filter(Boolean).join('\n');
    const words = [
      h('span', { class: 't', text: item.title }),
      due && item.due ? h('span', { class: 'due', text: shortDate(item.due) }) : null,
      item.email ? h('span', { class: 'mail', title: 'From an email' }, icon('mail', 14)) : null,
    ];
    if (!editable) {
      return h(tag, Object.assign({ class: ['item', 'task', item.done && 'done', compact && 'compact'], title: tip }, link),
        h('span', { class: 'box', 'aria-label': item.done ? 'Done' : 'To do', role: 'img' }, item.done ? icon('check', 12) : null),
        ...words);
    }
    // The box ticks it; the rest opens it.
    return h('div', Object.assign({ class: ['item', 'task', item.done && 'done', compact && 'compact'] }, drag),
      h('button', {
        class: 'box', type: 'button', role: 'checkbox', 'aria-checked': String(!!item.done), 'aria-label': `Done: ${item.title}`,
        title: item.done ? 'Done. Click to undo.' : 'Click when done', dataset: { key: `cal-tick:${item.id}` },
        onclick: () => tickTask(item),
      }, item.done ? icon('check', 12) : null),
      h(tag, Object.assign({ class: 'task-link', title: tip }, link, edit), ...words));
  }

  // ── Changing things ──────────────────────────────────────────────────
  //
  // Both ways: an event or a task is edited here, a task's box ticks it,
  // anything dragged to another day moves there, the + on a day adds one,
  // and the editor deletes. Each change goes to Google after the one
  // before it (C.writes), shows at once, and the days are read again once
  // the last has landed, so that what stays on screen is Google's own.

  const canChange = () => !!(ns.api && ns.api.googleWrite && C.ctx && C.ctx.dialog);

  // Calendars and lists that can take a new event or task: the ones
  // showing, or if none of those can, any.
  function writable(kind) {
    const all = C.sources.filter(s => s.writable && (!kind || s.kind === kind));
    const on = all.filter(isOn);
    return on.length ? on : all;
  }

  const sourceName = id => (C.sources.find(s => s.id === id) || {}).name || '';

  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
  }

  // A change names the version of the event it was made to. One made
  // here a moment ago - dragged twice, say, before Google's answer was
  // read back - names the version that change made, and nobody else's.
  const ours = new Map(); // a version we changed → the version it became
  function fresh(item) {
    let etag = item.etag;
    for (let hops = 0; etag && ours.has(etag) && hops < 50; hops++) etag = ours.get(etag);
    return etag === item.etag ? item : Object.assign({}, item, { etag });
  }
  const versioned = (item, send) => async () => {
    const it = fresh(item);
    const res = await send(it);
    if (it.kind === 'event' && it.etag && res && res.etag) ours.set(it.etag, res.etag);
    return res;
  };

  // A change Google never answers would hold every read back (C.pending),
  // and the calendar would stop moving: after this long it counts as
  // failed, and the days are read again to show whether it happened.
  const CHANGE_MS = 30000;
  function inTime(run) {
    let timer = 0;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error('Google took too long to answer. It may have been done all the same: the calendar is read again'), { code: 'timeout' })), CHANGE_MS);
    });
    return Promise.race([Promise.resolve().then(run), late]).finally(() => clearTimeout(timer));
  }

  // One change to Google, after any before it; the days are read again
  // once the last has landed. A failure is a toast, unless `quiet` (the
  // editor shows its own). Resolves to the error, or null.
  function change(run, what, { quiet = false } = {}) {
    C.pending++;
    const done = C.writes.then(() => inTime(run)).then(() => null, err => err || new Error('It did not work.'));
    C.writes = done.then(err => {
      C.pending--;
      if (err && !quiet) failed(err, what);
      if (C.pending) return undefined;
      ours.clear();
      C.cache.clear();
      return load({ force: true });
    }).catch(() => {});
    return done;
  }

  function failed(err, what) {
    if (err.code === 'calendar_scope') {
      const allow = C.ctx.connect ? { label: 'Connect again', onClick: () => connect() }
        : err.allowUrl ? { label: 'Allow', onClick: () => { C.recheck = true; window.open(err.allowUrl, '_blank', 'noopener'); } }
          : null;
      toast(C.ctx.root, `${what}: changing your calendar needs your permission first.`, { kind: 'error', action: allow, timeout: 15000 });
      return;
    }
    const why = err.code === 'changed' ? 'it was changed in Google meanwhile, so here is the latest' : err.message;
    toast(C.ctx.root, `${what}: ${why}.`, { kind: 'error' });
  }

  // The change on screen at once, in every range read, until Google's own
  // version replaces it; `next` null takes the item off.
  function showChanged(id, next) {
    for (const entry of new Set([...C.cache.values(), C.shown].filter(Boolean))) {
      entry.items = entry.items.flatMap(x => (x.id !== id ? [x] : next ? [next] : []));
    }
    draw();
  }

  function tickTask(item) {
    const done = !item.done;
    showChanged(item.id, Object.assign({}, item, { done }));
    change(() => store.tick(item, done), `Couldn’t ${done ? 'tick off' : 'untick'} “${item.title}”`);
  }

  function focusKey(key) {
    const el = key && [...els.wrap.querySelectorAll('[data-key]')].find(x => x.dataset.key === key && x.getClientRects().length);
    if (el) el.focus({ preventScroll: true });
  }

  // ── Dragging to another day, or time ──
  //
  // `timed`: an event in the hours, which dropped in the hours starts
  // where its top is let go - `grab` is how far down it was held.

  function startDrag(e, item, timed = false) {
    const from = e.currentTarget.closest('[data-drop]');
    if (!from) { e.preventDefault(); return; }
    const grab = timed ? e.clientY - e.currentTarget.getBoundingClientRect().top : 0;
    C.drag = { item, from: from.dataset.drop, timed, grab, startMin: timed ? minuteOf(item.start) : -1 };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.title);
    e.currentTarget.classList.add('dragging');
  }

  // A day it is not already on, or in the hours a time it does not
  // already start at; or No date, for a task. { el, day, at, body }, `at`
  // in minutes or null for the day alone.
  function dropTarget(e) {
    const d = C.drag;
    if (!d) return null;
    const t = e.target && e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!t || !els.wrap.contains(t)) return null;
    if (!t.dataset.drop && d.item.kind !== 'task') return null;
    const body = d.timed ? e.target.closest('.grid-body') : null;
    const at = body ? snap(minuteAt(body, e.clientY - d.grab), STEP_MIN, 0, 1440 - STEP_MIN) : null;
    if (t.dataset.drop === d.from && (at === null || at === d.startMin)) return null;
    return { el: t, day: t.dataset.drop, at, body };
  }

  // A day is outlined; a time, shown where the event would go.
  function markDrop(t) {
    const day = t && t.at === null ? t.el : null;
    for (const x of els.wrap.querySelectorAll('.drop-here')) if (x !== day) x.classList.remove('drop-here');
    if (day) day.classList.add('drop-here');
    if (!t || t.at === null) {
      if (els.ghost) els.ghost.remove();
      return;
    }
    const length = Math.round((C.drag.item.end - C.drag.item.start) / 60000);
    if (!els.ghost) els.ghost = h('div', { class: 'drop-ghost', 'aria-hidden': 'true' });
    els.ghost.textContent = `${clock(t.at)} – ${clock((t.at + length) % 1440)}`;
    setVars(els.ghost, { '--from': t.at, '--to': Math.min(1440, t.at + Math.max(length, STEP_MIN)) });
    if (els.ghost.parentNode !== t.body) t.body.append(els.ghost);
  }

  function onDragOver(e) {
    const t = dropTarget(e);
    markDrop(t);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function onDrop(e) {
    const t = dropTarget(e);
    const d = C.drag;
    endDrag();
    if (!t || !d) return;
    e.preventDefault();
    moveItem(d.item, d.from, t.day, t.at);
  }

  function endDrag() {
    C.drag = null;
    markDrop(null);
    for (const x of els.wrap.querySelectorAll('.dragging')) x.classList.remove('dragging');
  }

  // `at`: minutes after midnight, dropped in the hours; else null.
  function moveItem(item, from, to, at = null) {
    const startMin = at === null ? undefined : at;
    showChanged(item.id, cal.movedItem(item, from, to, startMin));
    change(versioned(item, it => store.move(it, from, to, timeZone(), startMin)),
      `Couldn’t move “${item.title}” to ${to ? longDate(to) : 'No date'}${at === null ? '' : ` at ${clock(at)}`}`);
  }

  // Its bottom edge dragged in the hours: a new end, the start kept.
  function resizeItem(item, end) {
    showChanged(item.id, Object.assign({}, item, { end, last: cal.dateKey(end - 1) }));
    change(versioned(item, it => store.resize(it, end, timeZone())), `Couldn’t change when “${item.title}” ends`);
  }

  // ── Done after an Undo ──
  //
  // Deleting - one event, one task, or every event in a series - and a
  // series stopped repeating (which takes its other events away) only ever
  // follow a confirmation in the editor. The screen shows it at once, but
  // Google is only asked once the Undo has had its time: a tab closed
  // before then changes nothing at all.

  const UNDO_MS = 8000;

  // `hides`: the items that go from the screen meanwhile.
  function later(key, { message, hides, run, what }) {
    const timer = setTimeout(() => {
      if (!C.later.has(key)) return;
      C.later.delete(key);
      if (hides) {
        for (const entry of new Set([...C.cache.values(), C.shown].filter(Boolean))) entry.items = entry.items.filter(x => !hides(x));
        draw();
      }
      change(run, what);
    }, UNDO_MS + 500); // after the Undo is gone, never while it shows
    C.later.set(key, { timer, hides });
    draw();
    toast(C.ctx.root, message, {
      timeout: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          clearTimeout(timer);
          C.later.delete(key);
          draw();
        },
      },
    });
  }

  function deleteLater(item) {
    later(`delete:${item.id}`, {
      message: `Deleted “${item.title}”.`,
      hides: x => x.id === item.id,
      run: versioned(item, it => store.remove(it)),
      what: `Couldn’t delete “${item.title}”`,
    });
  }

  function deleteSeriesLater(series, item) {
    later(`series:${item.source}|${series.id}`, {
      message: `Deleted every event in “${item.title}”.`,
      hides: x => x.source === item.source && (x.seriesId === series.id || x.eventId === series.id),
      run: () => store.removeSeries(series, item),
      what: `Couldn’t delete the events in “${item.title}”`,
    });
  }

  function stopLater(series, item, draft) {
    later(`stop:${item.source}|${series.id}`, {
      message: `“${item.title}” will stop repeating.`,
      run: () => store.saveSeries(series, item, draft, '', timeZone()),
      what: `Couldn’t stop “${item.title}” repeating`,
    });
  }

  // ── The editor ──
  //
  // One dialog for an event or a task, new or not, in the board's dialog
  // layer. New, it starts on the day whose + was pressed (or, clicked in
  // the hours, as an event an hour long from `at`, minutes); typing
  // "Dentist 14:30" makes it an event at that time, "Pay the invoice" a
  // task, until Event or Task is chosen by hand. An event can repeat, as
  // Google's own menu offers; one occurrence of a series asks, on saving
  // or deleting, whether that is for this event or for all of them.

  function openEditor(item, day, at = null) {
    if (!canChange() || (item && !item.editable)) return;
    const cals = writable('calendar');
    const lists = writable('tasks');
    if (!item && !cals.length && !lists.length) return;
    const start = item ? cal.draftOf(item) : null;
    const defaultCal = (cals.find(c => c.primary) || cals[0] || {}).id || '';
    const ed = {
      item, isNew: !item, kindChosen: false, timesTouched: false, saving: false, confirming: false, scope: false, error: '',
      kind: item ? item.kind : cals.length ? 'event' : 'task',
      title: start ? start.title : '',
      event: start && start.kind === 'event' ? start : cal.newDraft('event', day || C.today, defaultCal),
      task: start && start.kind === 'task' ? start : cal.newDraft('task', day || '', (lists[0] || {}).id || ''),
      // How it repeats: as chosen here, and as it was.
      repeat: { id: 'none', rule: '' }, repeatAt: null, repeatTouched: false,
      // An occurrence's series, read from Google: { state, event, error }.
      series: null,
      back: item ? `cal-item:${item.id}` : `cal-add:${day}`,
    };
    if (!item && at !== null && cals.length) {
      const end = at + 60;
      Object.assign(ed.event, { allDay: false, start: clock(at), end: clock(end % 1440), endDay: end >= 1440 ? cal.addDays(day, 1) : day });
      Object.assign(ed, { kind: 'event', kindChosen: true, timesTouched: true });
    }
    C.edit = ed;
    if (item && item.recurring && item.seriesId) {
      ed.series = { state: 'loading' };
      store.series(item).then(ev => {
        if (C.edit !== ed) return;
        ed.series = { state: 'ready', event: ev };
        ed.repeatAt = cal.repeatOf(ev.recurrence, cal.startDayOf(ev));
        if (!ed.repeatTouched) ed.repeat = copyRepeat(ed.repeatAt);
        ed.sync();
      }, err => {
        if (C.edit !== ed) return;
        ed.series = { state: 'error', error: err.message };
        ed.sync();
      });
    }
    C.ctx.dialog.show(editorEl(ed, cals, lists), {
      onClose: () => {
        if (C.edit === ed) C.edit = null;
        focusKey(ed.back);
      },
    });
    const title = C.ctx.root.querySelector('[data-key="cal-edit-title"]');
    if (title) { title.focus(); title.select(); }
  }

  const copyRepeat = r => Object.assign({}, r, r.custom ? { custom: Object.assign({}, r.custom, { days: r.custom.days.slice() }) } : {});

  // The day a rule is worked out for: the event's own, or for an
  // occurrence, its series' first day, moved as far as the occurrence was.
  function repeatDay(ed) {
    const s = ed.series && ed.series.state === 'ready' ? ed.series.event : null;
    return s ? cal.seriesDraft(cal.startDayOf(s), ed.item.first, ed.event).day : ed.event.day;
  }

  const UNITS = [['day', 'days'], ['week', 'weeks'], ['month', 'months'], ['year', 'years']];

  function editorEl(ed, cals, lists) {
    const ev = ed.event;
    const tk = ed.task;
    const id = name => `gkb-cal-${name}`;
    const onEnter = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveEdit(ed); } };
    const input = (name, props) => h('input', Object.assign({ class: 'text-input', type: 'text', id: id(name), onkeydown: onEnter }, props));
    const field = (name, label, ...controls) => h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id(name), text: label }), ...controls);
    const pick = (name, list, value, set) => (list.length > 1 && ed.isNew
      ? h('select', { class: 'text-input', id: id(name), onchange: e => set(e.target.value) },
        list.map(s => h('option', { value: s.id, selected: s.id === value, text: s.name })))
      : h('div', { class: 'cal-edit-where', id: id(name), text: sourceName(value) }));
    const recurring = !!(ed.item && ed.item.recurring);

    const els2 = {};
    const sync = () => {
      for (const b of els2.kinds ? els2.kinds.children : []) b.setAttribute('aria-pressed', String(b.dataset.kind === ed.kind));
      els2.event.hidden = ed.kind !== 'event';
      els2.task.hidden = ed.kind !== 'task';
      for (const t of [els2.startTime, els2.endTime]) t.hidden = ev.allDay;
      syncRepeat();
      els2.error.textContent = ed.error;
      // Busy, not disabled: a disabled button drops the focus out of the
      // dialog, and Esc would then close the whole board.
      els2.save.setAttribute('aria-disabled', String(ed.saving));
      els2.save.textContent = ed.saving ? 'Saving…' : ed.isNew ? 'Add' : 'Save';
      const seriesReady = !!(ed.series && ed.series.state === 'ready');
      for (const b of [els2.scopeAll, els2.deleteAll]) if (b) b.setAttribute('aria-disabled', String(!seriesReady));
      if (els2.scopeOne) els2.scopeOne.hidden = !!ed.ruleChanged;
      if (els2.scopeText) {
        els2.scopeText.textContent = ed.stopping
          ? 'It will stop repeating: the other events in the series go from Google Calendar too, once Undo has passed.'
          : ed.ruleChanged ? 'A change to how it repeats is for all events in the series.'
            : 'Save this change for this event only, or for all events in the series?';
      }
      els2.confirm.hidden = !ed.confirming;
      if (els2.scope) els2.scope.hidden = !ed.scope;
      els2.foot.hidden = ed.confirming || ed.scope;
    };
    ed.sync = sync;

    // New, and both kinds possible: Event or Task, chosen by what is typed
    // until chosen by hand.
    els2.kinds = ed.isNew && cals.length && lists.length ? h('div', { class: 'cal-edit-kinds', role: 'group', 'aria-label': 'Add an event or a task' },
      ['event', 'task'].map(k => h('button', {
        class: 'seg', type: 'button', dataset: { kind: k, key: `cal-edit-kind:${k}` }, text: k === 'event' ? 'Event' : 'Task',
        onclick: () => { ed.kind = k; ed.kindChosen = true; sync(); },
      }))) : null;

    const titleInput = input('title', {
      value: ed.title, maxlength: '1000', dataset: { key: 'cal-edit-title' },
      placeholder: ed.isNew ? 'Dentist 14:30, or Pay the invoice' : '',
      oninput: e => {
        ed.title = e.target.value;
        if (!ed.isNew) return;
        const q = cal.parseQuick(ed.title);
        if (!ed.kindChosen && els2.kinds) ed.kind = q.start ? 'event' : 'task';
        if (q.start && !ed.timesTouched) {
          ev.start = q.start;
          ev.end = q.end;
          ev.allDay = false;
          els2.startTime.value = q.start;
          els2.endTime.value = q.end;
          els2.allDay.checked = false;
        }
        sync();
      },
    });

    // An event: where it goes, all day or when, how it repeats, and where.
    const timeInput = (name, key) => input(name, {
      class: 'text-input cal-time', value: ev[key], maxlength: '5', inputmode: 'numeric', placeholder: key === 'start' ? '09:30' : '10:30',
      'aria-label': key === 'start' ? 'Start time' : 'End time', dataset: { key: `cal-edit-${name}` },
      oninput: e => { ev[key] = e.target.value; ed.timesTouched = true; },
    });
    const dateInput = (name, get, set, label) => h('input', {
      class: 'text-input cal-date', type: 'date', id: id(name), value: get(), 'aria-label': label, dataset: { key: `cal-edit-${name}` },
      onchange: e => set(e.target.value), onkeydown: onEnter,
    });
    els2.startTime = timeInput('start-time', 'start');
    els2.endTime = timeInput('end-time', 'end');
    els2.allDay = h('input', {
      type: 'checkbox', id: id('all-day'), checked: !!ev.allDay, dataset: { key: 'cal-edit-all-day' },
      onchange: e => { ev.allDay = e.target.checked; sync(); },
    });

    // How it repeats: Google's menu for the day it starts, and Custom.
    const touch = () => { ed.repeatTouched = true; };
    els2.repeat = h('select', {
      class: 'text-input', id: id('repeat'), dataset: { key: 'cal-edit-repeat' },
      onchange: e => {
        touch();
        const v = e.target.value;
        ed.repeat = v === 'other' ? copyRepeat(ed.repeatAt) : { id: v, rule: '', custom: v === 'custom' ? (ed.repeat.custom || cal.customFor(repeatDay(ed))) : undefined };
        sync();
      },
    });
    const c = () => ed.repeat.custom;
    els2.every = h('input', {
      class: 'text-input cal-every', type: 'number', min: '1', max: '999', id: id('every'), 'aria-label': 'Repeat every', dataset: { key: 'cal-edit-every' },
      oninput: e => { touch(); c().every = Math.max(1, Number(e.target.value) || 1); sync(); },
    });
    els2.unit = h('select', {
      class: 'text-input', 'aria-label': 'Unit', dataset: { key: 'cal-edit-unit' },
      onchange: e => { touch(); c().unit = e.target.value; sync(); },
    });
    els2.days = h('div', { class: 'cal-days', role: 'group', 'aria-label': 'On' },
      cal.WEEKDAY_CODES.map((code, i) => h('button', {
        type: 'button', class: 'cal-day-pick', text: cal.WEEKDAY_NAMES[i][0], title: cal.WEEKDAY_NAMES[i],
        'aria-label': cal.WEEKDAY_NAMES[i], dataset: { code, key: `cal-edit-day:${code}` },
        onclick: () => {
          touch();
          const days = c().days;
          c().days = days.includes(code) ? days.filter(d => d !== code) : days.concat(code);
          sync();
        },
      })));
    els2.monthBy = h('select', {
      class: 'text-input', 'aria-label': 'Which day of the month', dataset: { key: 'cal-edit-month-by' },
      onchange: e => { touch(); c().monthBy = e.target.value; },
    });
    const endsRadio = (value, label, ...more) => h('label', { class: 'cal-edit-check' },
      h('input', {
        type: 'radio', name: 'gkb-cal-ends', value, dataset: { key: `cal-edit-ends:${value}` },
        onchange: () => { touch(); c().ends = value; sync(); },
      }), label, ...more);
    els2.until = h('input', {
      class: 'text-input cal-date', type: 'date', 'aria-label': 'Ends on', dataset: { key: 'cal-edit-until' },
      onchange: e => { touch(); c().until = e.target.value; },
    });
    els2.count = h('input', {
      class: 'text-input cal-every', type: 'number', min: '1', max: '999', 'aria-label': 'Ends after so many times', dataset: { key: 'cal-edit-count' },
      oninput: e => { touch(); c().count = Math.max(1, Number(e.target.value) || 1); },
    });
    els2.ends = h('div', { class: 'cal-ends', role: 'radiogroup', 'aria-label': 'Ends' },
      endsRadio('never', 'Never'),
      endsRadio('on', 'On', els2.until),
      endsRadio('after', 'After', els2.count, ' times'));
    els2.custom = h('div', { class: 'cal-repeat-custom' },
      h('div', { class: 'cal-edit-row' }, h('span', { text: 'Every' }), els2.every, els2.unit),
      els2.days, els2.monthBy,
      h('span', { class: 'field-label', text: 'Ends' }), els2.ends);
    els2.repeatNote = h('p', { class: 'note' });

    const syncRepeat = () => {
      const day = repeatDay(ed);
      const loading = !!(ed.series && ed.series.state === 'loading');
      const broken = !!(ed.series && ed.series.state === 'error');
      const options = cal.repeatChoices(day).map(o => [o.id, o.label]).concat([['custom', 'Custom…']]);
      if (ed.repeat.id === 'other' || (ed.repeatAt && ed.repeatAt.id === 'other')) options.push(['other', 'As set in Google Calendar']);
      if (els2.repeat.dataset.day !== day || els2.repeat.options.length !== options.length) {
        els2.repeat.replaceChildren(...options.map(([v, label]) => h('option', { value: v, text: label })));
        els2.repeat.dataset.day = day;
      }
      els2.repeat.value = ed.repeat.id;
      els2.repeat.disabled = loading;
      els2.repeatField.hidden = broken;
      els2.repeatNote.hidden = !(loading || broken);
      els2.repeatNote.textContent = loading ? 'Reading how it repeats…'
        : broken ? `It repeats, but the series could not be read (${ed.series.error}): a change here is to this event only.` : '';
      const cu = ed.repeat.id === 'custom' ? ed.repeat.custom : null;
      els2.custom.hidden = !cu;
      if (!cu) return;
      if (C.ctx.root.activeElement !== els2.every) els2.every.value = String(cu.every);
      els2.unit.replaceChildren(...UNITS.map(([v, plural]) => h('option', { value: v, text: cu.every > 1 ? plural : v })));
      els2.unit.value = cu.unit;
      els2.days.hidden = cu.unit !== 'week';
      for (const b of els2.days.children) b.setAttribute('aria-pressed', String(cu.days.includes(b.dataset.code)));
      els2.monthBy.hidden = cu.unit !== 'month';
      els2.monthBy.replaceChildren(
        h('option', { value: 'date', text: `On day ${Number(day.slice(8))}` }),
        h('option', { value: 'weekday', text: cal.repeatChoices(day)[3].label.replace(/^Monthly on /, 'On ') }));
      els2.monthBy.value = cu.monthBy;
      for (const r of els2.ends.querySelectorAll('input[type="radio"]')) r.checked = r.value === cu.ends;
      els2.until.value = cu.until;
      els2.until.disabled = cu.ends !== 'on';
      if (C.ctx.root.activeElement !== els2.count) els2.count.value = String(cu.count);
      els2.count.disabled = cu.ends !== 'after';
    };

    els2.repeatField = field('repeat', 'Repeats', els2.repeat, els2.custom);
    els2.event = h('div', { class: 'cal-edit-part' },
      field('calendar', 'Calendar', pick('calendar', cals, ev.source, v => { ev.source = v; })),
      h('label', { class: 'cal-edit-check' }, els2.allDay, 'All day'),
      field('start-day', 'Starts', h('div', { class: 'cal-edit-row' },
        dateInput('start-day', () => ev.day, v => { ev.day = v; if (!ev.endDay || ev.endDay < v) { ev.endDay = v; els2.endDay.value = v; } sync(); }, 'Start day'),
        els2.startTime)),
      field('end-day', 'Ends', h('div', { class: 'cal-edit-row' },
        els2.endDay = dateInput('end-day', () => ev.endDay, v => { ev.endDay = v; }, 'End day'),
        els2.endTime)),
      els2.repeatField,
      els2.repeatNote,
      field('where', 'Where', input('where', { value: ev.where || '', maxlength: '500', dataset: { key: 'cal-edit-where' }, oninput: e => { ev.where = e.target.value; } })));

    // A task: its list, its day (or none), and done.
    els2.task = h('div', { class: 'cal-edit-part' },
      field('list', 'List', pick('list', lists, tk.source, v => { tk.source = v; })),
      field('task-day', 'Day', h('div', { class: 'cal-edit-row' },
        els2.taskDay = dateInput('task-day', () => tk.day, v => { tk.day = v; }, 'Day'),
        h('button', {
          class: 'link-btn', type: 'button', text: 'No date', dataset: { key: 'cal-edit-no-date' },
          onclick: () => { tk.day = ''; els2.taskDay.value = ''; },
        }))),
      ed.isNew ? null : h('label', { class: 'cal-edit-check' }, h('input', {
        type: 'checkbox', checked: !!tk.done, dataset: { key: 'cal-edit-done' }, onchange: e => { tk.done = e.target.checked; },
      }), 'Done'));

    els2.error = h('div', { class: 'form-error', role: 'alert' });
    els2.save = h('button', { class: 'btn btn-primary', type: 'button', dataset: { key: 'cal-edit-save' }, onclick: () => saveEdit(ed) });
    const where = ed.item ? sourceName(ed.item.source) : '';
    const google = ed.item && ed.item.kind === 'task' ? 'Google Tasks' : 'Google Calendar';
    els2.foot = h('div', { class: 'dialog-foot' },
      ed.item ? h('button', {
        class: 'btn btn-text danger', type: 'button', text: 'Delete', dataset: { key: 'cal-edit-delete' },
        onclick: () => { ed.confirming = true; ed.error = ''; sync(); focusIn('cal-edit-delete-yes'); },
      }) : null,
      ed.item && ed.item.link ? h('a', {
        class: 'btn btn-text', href: ed.item.link, target: '_blank', rel: 'noopener noreferrer', text: `Open in ${google}`,
      }) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-text', type: 'button', text: 'Cancel', onclick: () => C.ctx.dialog.close() }),
      els2.save);

    // An occurrence: this event, or all events in the series?
    const seriesReady = () => !!(ed.series && ed.series.state === 'ready');
    if (recurring) {
      els2.scopeText = h('span', { class: 'note' });
      els2.scopeOne = h('button', {
        class: 'btn btn-text', type: 'button', text: 'This event', dataset: { key: 'cal-edit-scope-one' },
        onclick: () => saveEdit(ed, 'one'),
      });
      els2.scopeAll = h('button', {
        class: 'btn btn-primary', type: 'button', text: 'All events', dataset: { key: 'cal-edit-scope-all' },
        onclick: () => { if (seriesReady()) saveEdit(ed, 'all'); },
      });
      els2.scope = h('div', { class: 'dialog-foot cal-edit-confirm', role: 'alert' },
        els2.scopeText,
        h('button', {
          class: 'btn btn-text', type: 'button', text: 'Back', dataset: { key: 'cal-edit-scope-no' },
          onclick: () => { ed.scope = false; ed.ruleChanged = false; ed.stopping = false; sync(); focusIn('cal-edit-save'); },
        }),
        els2.scopeOne, els2.scopeAll);
    }

    // Deleting asks first, naming what and where; an occurrence, whether
    // it is this event or every event in the series.
    els2.deleteAll = recurring ? h('button', {
      class: 'btn btn-danger', type: 'button', text: 'All events', dataset: { key: 'cal-edit-delete-all' },
      onclick: () => { if (!seriesReady()) return; const it = ed.item; const s = ed.series.event; C.ctx.dialog.close(); deleteSeriesLater(s, it); },
    }) : null;
    els2.confirm = h('div', { class: 'dialog-foot cal-edit-confirm', role: 'alert' },
      h('span', {
        class: 'note',
        text: !ed.item ? '' : recurring
          ? `Delete “${ed.item.title}”${where ? ` from ${where}` : ''}: this event only, or every event in the series? It goes from ${google} too, once Undo has passed.`
          : `Delete “${ed.item.title}”${where ? ` from ${where}` : ''}? It goes from ${google} too, once Undo has passed.`,
      }),
      h('button', {
        class: 'btn btn-text', type: 'button', text: 'Keep it', dataset: { key: 'cal-edit-delete-no' },
        onclick: () => { ed.confirming = false; sync(); focusIn('cal-edit-delete'); },
      }),
      h('button', {
        class: recurring ? 'btn btn-text danger' : 'btn btn-danger', type: 'button', text: recurring ? 'This event' : 'Delete',
        dataset: { key: 'cal-edit-delete-yes' },
        onclick: () => { const it = ed.item; C.ctx.dialog.close(); deleteLater(it); },
      }),
      els2.deleteAll);

    const heading = ed.isNew ? 'Add' : ed.item.kind === 'task' ? 'Task' : 'Event';
    const dialog = h('div', { class: 'dialog cal-edit', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id('heading') },
      h('div', { class: 'dialog-head' },
        h('h2', { id: id('heading'), text: heading }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close without saving', onclick: () => C.ctx.dialog.close() }, icon('close'))),
      h('div', { class: 'dialog-body' },
        els2.kinds,
        field('title', 'Title', titleInput),
        els2.event,
        els2.task),
      els2.error,
      els2.foot,
      els2.scope,
      els2.confirm);
    sync();
    return dialog;
  }

  function focusIn(key) {
    const el = C.ctx.root.querySelector(`[data-key="${key}"]`);
    if (el) el.focus();
  }

  // `scope`, for an occurrence of a series: 'one' or 'all', as chosen in
  // the row Save brings up.
  async function saveEdit(ed, scope = '') {
    if (ed.saving || ed.confirming || (ed.scope && !scope)) return;
    const draft = Object.assign({}, ed.kind === 'event' ? ed.event : ed.task);
    let title = ed.title;
    // "Dentist 14:30": the time went into the times, not the title.
    if (ed.isNew && ed.kind === 'event') {
      const q = cal.parseQuick(title);
      if (q.start) title = q.title;
    }
    draft.title = title;
    const isEvent = draft.kind === 'event';
    const tz = timeZone();
    const series = ed.series && ed.series.state === 'ready' ? ed.series.event : null;
    const rule = isEvent ? cal.ruleFor(ed.repeat, repeatDay(ed), draft.allDay) : '';
    // Checked here first: what will not do never leaves the page.
    const made = !isEvent ? cal.taskBody(draft, { patch: !ed.isNew })
      : cal.eventBody(scope === 'all' && series ? cal.seriesDraft(cal.startDayOf(series), ed.item.first, draft) : draft, tz, { patch: !ed.isNew });
    if (made.error) {
      ed.error = made.error;
      ed.scope = false;
      ed.sync();
      return;
    }
    // An occurrence: which, first. A new rule can only be for all of them.
    if (ed.item && ed.item.recurring && !scope) {
      ed.ruleChanged = !!(series && ed.repeatTouched && rule !== cal.ruleFor(ed.repeatAt, repeatDay(ed), draft.allDay));
      ed.stopping = ed.ruleChanged && !rule;
      ed.scope = true;
      ed.error = '';
      ed.sync();
      focusIn(ed.ruleChanged || !series ? 'cal-edit-scope-all' : 'cal-edit-scope-one');
      return;
    }
    if (scope === 'all' && !series) return;
    // Every event in a series bar the first gone: like a delete, after an Undo.
    if (scope === 'all' && !rule) {
      const item = ed.item;
      C.ctx.dialog.close();
      stopLater(series, item, draft);
      return;
    }
    let run;
    if (scope === 'all') run = () => store.saveSeries(series, ed.item, draft, rule, tz);
    else if (scope === 'one') run = versioned(ed.item, it => store.save(it, draft, tz));
    else if (ed.isNew) run = () => store.save(null, draft, tz, rule ? [rule] : undefined);
    // An event that did not repeat: from now on it does, if a rule was chosen.
    else run = versioned(ed.item, it => store.save(it, draft, tz, isEvent && rule ? cal.recurrenceWith([], rule) : undefined));
    ed.saving = true;
    ed.error = '';
    ed.sync();
    const what = ed.isNew ? `Couldn’t add “${title.trim()}”` : `Couldn’t save “${ed.item.title}”`;
    const err = await change(run, what, { quiet: true });
    if (C.edit !== ed) return; // closed meanwhile; the change stands
    ed.saving = false;
    if (!err) {
      C.ctx.dialog.close();
      return;
    }
    ed.scope = false;
    if (err.code === 'calendar_scope') failed(err, what);
    ed.error = err.code === 'changed' ? 'This was changed in Google meanwhile, so nothing was saved. Close this and open it again to see the latest.'
      : err.code === 'calendar_scope' ? 'Changing your calendar needs your permission first: see the message at the bottom.'
        : `${what}: ${err.message}`;
    ed.sync();
  }

  // ── Keys ─────────────────────────────────────────────────────────────

  function handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return false;
    const t = e.composedPath()[0];
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
    if (C.status === 'signin' || C.status === 'mismatch') return false;
    const k = e.key.toLowerCase();
    const act = {
      t: () => go(cal.dateKey(new Date())),
      j: () => go(cal.step(view(), C.anchor, 1)),
      n: () => go(cal.step(view(), C.anchor, 1)),
      k: () => go(cal.step(view(), C.anchor, -1)),
      p: () => go(cal.step(view(), C.anchor, -1)),
      w: () => setView('week'),
      m: () => setView('month'),
      a: () => setView('agenda'),
    }[k];
    if (!act) return false;
    e.preventDefault();
    act();
    return true;
  }

  // Every few seconds while open: the line for now moves down the hours,
  // and past midnight, today moves on.
  function tick() {
    const now = cal.dateKey(new Date());
    const line = els.week && els.week.querySelector('.now-line');
    if (line) setVars(line, { '--from': minuteOf(Date.now()) });
    if (now === C.today) return;
    if (C.anchor === C.today) C.anchor = now;
    C.today = now;
    load();
  }

  ns.calendar = {
    init, element, load, isStale, handleKey, tick,
    loadedAt: () => C.loadedAt,
    isLoading: () => !!C.loading,
  };
})();

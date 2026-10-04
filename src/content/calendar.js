// ─────────────────────────────────────────────────────────────────────
// The calendar view
//
// The board's third tab: Google Calendar's events with Google Tasks'
// tasks among them, day by day. Read-only for now: an event opens in
// Google Calendar, a task in Google Tasks (or, made from an email, the
// email itself).
//
// On a computer there are three views - Week (seven columns, or two rows:
// Monday to Thursday above Friday to Sunday, at the click of a button
// beside the views), Month and Agenda (four weeks as one list) - beside a
// small month, the calendars and task lists to show or hide, and the
// tasks with no date. Narrow, as
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

  const C = {
    ctx: null,          // { root, onStateError, onLoaded, barChanged, prefs, connect }
    view: 'week',       // the view chosen on a wide screen
    order: 'down',      // narrow: the days down then across, or 'across' then down
    layout: 'columns',  // wide, the week: seven columns, or two 'rows'
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
    els.tray = h('section', { class: 'cal-tray', 'aria-label': 'Tasks without a day' });
    els.main = h('section', { class: 'cal-main' });
    els.main.addEventListener('touchstart', onTouchStart, { passive: true });
    els.main.addEventListener('touchend', onTouchEnd, { passive: true });

    els.wrap = h('div', { class: 'cal' },
      els.head,
      els.note,
      h('div', { class: 'cal-body' },
        h('aside', { class: 'cal-side' }, els.mini, els.sources, els.tray),
        els.main));

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
      const names = ['calendarView', 'calendarSources', 'calendarOrder', 'calendarWeekLayout'];
      const [v, o, order, layout] = await Promise.all(names.map(n => C.ctx.prefs.get(n)));
      if (cal.VIEWS.includes(v)) C.view = v;
      if (o && typeof o === 'object') C.overrides = o;
      if (order === 'across' || order === 'down') C.order = order;
      if (layout === 'rows' || layout === 'columns') C.layout = layout;
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

  // On a computer, the week as seven columns, or as two rows: Monday to
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
      ? 'The week in two rows, Monday to Thursday above Friday to Sunday. Click for seven columns.'
      : 'The week in seven columns. Click for two rows, Monday to Thursday above Friday to Sunday.';
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
    else els.main.replaceChildren(drawWeek());
  }

  // What is on, from the sources that are on, by day.
  function visibleItems() {
    if (!C.shown) return [];
    const on = new Set(onSources().map(s => s.id));
    return C.shown.items.filter(x => on.has(x.source));
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
      k === C.today ? h('span', { class: 'badge', text: 'today' }) : null);
  }

  function dayClasses(k, base) {
    const wd = cal.weekday(k);
    return [base, k === C.today && 'today', wd >= 5 && 'weekend', wd === 6 && 'sunday', k < C.today && 'past'];
  }

  function drawWeek() {
    const r = range();
    const keys = cal.days(r.start, r.end);
    const byDay = cal.byDay(visibleItems(), keys);
    const loading = C.status === 'loading' && !C.shown;
    return h('div', { class: ['cal-week', loading && 'loading'], role: 'list' },
      keys.map(k => h('section', { class: dayClasses(k, 'day'), role: 'listitem', 'aria-label': longDate(k), dataset: { day: k } },
        dayHead(k),
        h('div', { class: 'cal-items' }, byDay.get(k).map(e => itemEl(e))))),
      // The eighth tile, in the two columns of a narrow screen.
      h('div', { class: 'day mini-tile', 'aria-hidden': C.narrow ? null : 'true' }, miniMonth()));
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
          return h('section', { class: [...dayClasses(k, 'mcell'), k.slice(0, 7) !== month && 'other'], 'aria-label': longDate(k) },
            h('button', {
              class: 'mday', type: 'button', text: String(Number(k.slice(8))), title: `Week of ${longDate(k)}`,
              dataset: { key: `cal-day:${k}` }, onclick: () => openWeek(k),
            }),
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
    if (!timeFormat) timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
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

  // An event or a task, as a link to where it lives in Google.
  function itemEl({ item, cont }, { compact = false, agenda = false, due = false } = {}) {
    const tag = item.link ? 'a' : 'div';
    const link = item.link ? { href: item.link, target: '_blank', rel: 'noopener noreferrer' } : {};
    if (item.kind === 'event') {
      const time = item.allDay ? (agenda ? 'All day' : '') : cont ? (agenda ? 'until ' + timeText(item.end) : '…') : timeText(item.start);
      const tip = [item.title, whenText(item, cont), item.where].filter(Boolean).join('\n');
      return tint(h(tag, Object.assign({
        class: ['item', 'ev', item.allDay && 'all-day', compact && 'compact'], title: tip,
      }, link),
      time ? h('span', { class: 'time', text: time }) : null,
      h('span', { class: 't', text: item.title })), '--c', item.colour);
    }
    const tip = [item.title, item.list && `Google Tasks · ${item.list}`, due && item.due && `Due ${shortDate(item.due)}`,
      item.email && 'Opens the email'].filter(Boolean).join('\n');
    return h(tag, Object.assign({ class: ['item', 'task', item.done && 'done', compact && 'compact'], title: tip }, link),
      h('span', { class: 'box', 'aria-label': item.done ? 'Done' : 'To do', role: 'img' }, item.done ? icon('check', 12) : null),
      h('span', { class: 't', text: item.title }),
      due && item.due ? h('span', { class: 'due', text: shortDate(item.due) }) : null,
      item.email ? h('span', { class: 'mail', title: 'From an email' }, icon('mail', 14)) : null);
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

  // Every few seconds while open: past midnight, today moves on.
  function tick() {
    const now = cal.dateKey(new Date());
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

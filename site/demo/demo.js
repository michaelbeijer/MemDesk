// ─────────────────────────────────────────────────────────────────────
// The website's demo, on a computer: MemDesk in a made-up Gmail
//
// The page is the dev preview (dev/preview.html) - the extension's real
// content scripts, with the fake Gmail, Calendar and Tasks of
// dev/mock-chrome.js - as tools/build-site.mjs puts it together. This
// puts the demo's bar where the preview's developer bar was, opens the
// board, and makes links that would leave for Google say so instead. The
// phone demo's page loads it too, for the links (run.js).
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Where a link to Google would have gone, in words.
  function whereTo(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return ''; }
    if (u.hostname === 'mail.google.com') return 'the email in Gmail';
    if (u.hostname === 'tasks.google.com') return 'Google Tasks';
    if (u.hostname === 'calendar.google.com' || (u.hostname === 'www.google.com' && u.pathname.startsWith('/calendar'))) return 'Google Calendar';
    if (u.hostname === 'script.google.com') return 'Google’s permission page';
    if (/(^|\.)google\.com$/.test(u.hostname)) return 'Google';
    return '';
  }

  let noteTimer = 0;
  function say(text) {
    let note = document.querySelector('.demo-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'demo-note';
      note.setAttribute('role', 'status');
      document.body.append(note);
    }
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.remove(), 4500);
  }
  const instead = where => say(`In MemDesk this opens ${where}. In the demo there is no Google to go to: everything here is made up.`);

  // Last, after MemDesk's own handlers: a link it opened something else
  // for (the editor, say) has had its default prevented already.
  function guard(e) {
    if (e.defaultPrevented) return;
    const a = e.composedPath().find(n => n instanceof Element && n.closest && n.matches('a[href]'));
    const where = a && whereTo(a.href);
    if (!where) return;
    e.preventDefault();
    instead(where);
  }
  window.addEventListener('click', guard);
  window.addEventListener('auxclick', guard);
  const open = window.open.bind(window);
  window.open = (url, ...rest) => {
    const where = whereTo(url);
    if (!where) return open(url, ...rest);
    instead(where);
    return null;
  };

  // The phone's page has no fake Gmail of its own to dress.
  if (!window.__mockChrome) return;

  // The demo is free, whether licences are on sale or not (the fake
  // worker reads this each time it is asked).
  window.gkb.LICENCE_STORE_ID = 0;

  document.title = 'MemDesk demo';
  const bar = document.querySelector('.demobar');
  const devbar = document.querySelector('.devbar');
  if (devbar) devbar.remove();
  if (bar) {
    document.body.prepend(bar);
    // MemDesk covers the page, as it covers Gmail: here it starts below
    // the bar, so that the bar stays in sight. Its parts live in shadow
    // roots of their own, made as they are first needed.
    new ResizeObserver(() => document.documentElement.style.setProperty('--demo-bar', `${bar.offsetHeight}px`)).observe(bar);
    const fit = () => {
      for (const host of document.querySelectorAll('body > [id]')) {
        const root = host.shadowRoot;
        if (!root || root.querySelector('style[data-demo]')) continue;
        const style = document.createElement('style');
        style.dataset.demo = '';
        style.textContent = '.overlay { top: var(--demo-bar, 0px) !important; }';
        root.append(style);
      }
    };
    new MutationObserver(fit).observe(document.body, { childList: true });
    fit();
  }

  // The week as two rows, Monday to Thursday above Friday to Sunday, with
  // the Scratchpad beside them: the view Google Calendar has nothing like,
  // so the demo's week opens on it. The button beside Week turns it back
  // into the week by the hour, as in MemDesk itself.
  chrome.storage.local.set({ [window.gkb.KEYS.pref(window.__mockChrome.account, 'calendarWeekLayout')]: 'rows' });

  // Open on the board, once the content scripts are in.
  const start = () => setTimeout(() => window.__mockChrome.dispatchToTab({ type: 'toggle-board' }), 300);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();

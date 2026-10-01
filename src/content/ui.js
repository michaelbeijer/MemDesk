// ─────────────────────────────────────────────────────────────────────
// DOM toolkit for the injected UI
//
// Gmail enforces Trusted Types on its page, under which innerHTML and
// friends throw. Chromium currently exempts a content script's isolated
// world from that policy, but nothing promises it always will - and mail
// subjects are untrusted text regardless. So every node here is built
// with createElement / createElementNS and filled with textContent. All
// of it lives in shadow roots so Gmail's stylesheet and ours never meet.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // ── Elements ─────────────────────────────────────────────────────────

  // Properties that must be set as properties, not attributes, to take
  // effect after first render (an input's value, a checkbox's state).
  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden']);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number'
        ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  }

  // ── Icons ────────────────────────────────────────────────────────────
  //
  // Material Symbols paths (Apache 2.0), plus the board glyph drawn to
  // match the toolbar icon.

  const bar = (x, y, w, ht) =>
    `M${x + 1} ${y}h${w - 2}a1 1 0 0 1 1 1v${ht - 2}a1 1 0 0 1-1 1h-${w - 2}a1 1 0 0 1-1-1v-${ht - 2}a1 1 0 0 1 1-1z`;

  const ICONS = {
    board: bar(3, 4, 5, 16) + bar(9.5, 4, 5, 10) + bar(16, 4, 5, 13),
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
    down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    caret: 'M7 10l5 5 5-5z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    arrow: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
    remove: 'M19 13H5v-2h14v2z',
    note: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    // Formatting toolbar.
    bold: 'M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z',
    italic: 'M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z',
    strike: 'M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z',
    bullets: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z',
    numbers: 'M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z',
    checklist: 'M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11 2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 19z',
    indent: 'M3 21h18v-2H3v2zM3 8v8l4-4-4-4zm8 9h10v-2H11v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z',
    outdent: 'M11 17h10v-2H11v2zm-8-5 4 4V8l-4 4zm0 9h18v-2H3v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z',
    link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
    clear: 'M3.27 5 2 6.27l6.97 6.97L6.5 19h3l1.57-3.66L16.73 21 18 19.73 3.55 5.27 3.27 5zM6 5v.18L8.82 8h2.4l-.72 1.68 2.1 2.1L14.21 8H20V5H6z',
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name, size = 20) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name] || '');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  // ── Shadow hosts ─────────────────────────────────────────────────────

  function adoptStyles(root, cssText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch { /* older engine or a hostile CSP: fall through */ }
    const style = document.createElement('style');
    style.textContent = cssText;
    root.appendChild(style);
  }

  function mountShadow(id, cssText) {
    // A previous injection (extension reloaded without reloading Gmail)
    // leaves an orphaned host behind; replace it rather than stack a second.
    const stale = document.getElementById(id);
    if (stale) stale.remove();

    const host = document.createElement('div');
    host.id = id;
    const root = host.attachShadow({ mode: 'open' });
    adoptStyles(root, cssText);

    // Key events from inside a shadow root reach Gmail retargeted to the
    // host, which is not an input - so typing "c" in our search box would
    // open Gmail's Compose. Our own handlers inside the root run first;
    // stopping propagation here keeps Gmail's shortcuts out of it.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      host.addEventListener(type, e => e.stopPropagation());
    }

    (document.body || document.documentElement).appendChild(host);
    return { host, root };
  }

  // ── Toasts ───────────────────────────────────────────────────────────

  function toastLayer(root) {
    let layer = root.querySelector('.toasts');
    if (!layer) {
      layer = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      root.appendChild(layer);
    }
    return layer;
  }

  function toast(root, message, { kind = 'info', action = null, timeout } = {}) {
    const layer = toastLayer(root);
    const close = () => el.remove();
    const el = h('div', { class: ['toast', kind === 'error' && 'toast-error'] },
      h('span', { class: 'toast-text', text: message }),
      action && h('button', {
        class: 'toast-action', type: 'button', text: action.label,
        onclick: () => { close(); action.onClick(); },
      }),
      h('button', { class: 'toast-close icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: close },
        icon('close', 18))
    );
    layer.appendChild(el);
    // Errors stay a little longer: they usually need reading, not glancing.
    setTimeout(close, timeout || (kind === 'error' ? 9000 : 5000));
    return el;
  }

  // ── Menus ────────────────────────────────────────────────────────────
  //
  // items: { label, onSelect, icon?, checked?, disabled?, danger? }
  //      | { heading } | { separator: true }

  const openMenus = new WeakMap(); // root → close function

  function closeMenu(root) {
    const close = openMenus.get(root);
    if (close) close();
  }

  function isMenuOpen(root) {
    return openMenus.has(root);
  }

  function openMenu(root, anchor, items, { label = 'Actions', placement = 'below' } = {}) {
    closeMenu(root);

    const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
    for (const it of items) {
      if (it.separator) { menu.appendChild(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
      if (it.heading) { menu.appendChild(h('div', { class: 'menu-heading', 'aria-hidden': 'true', text: it.heading })); continue; }
      const role = it.checked === undefined ? 'menuitem' : 'menuitemradio';
      menu.appendChild(h('button', {
        class: ['menu-item', it.danger && 'danger'],
        type: 'button',
        role,
        'aria-checked': it.checked === undefined ? null : String(!!it.checked),
        disabled: !!it.disabled,
        dataset: it.key ? { key: it.key } : undefined,
        onclick: () => { close(); it.onSelect(); },
      },
        h('span', { class: 'menu-icon' }, it.checked ? icon('check', 18) : (it.icon ? icon(it.icon, 18) : null)),
        h('span', { class: 'menu-label', text: it.label })
      ));
    }

    root.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');

    // Fixed positioning against the anchor, flipped or nudged so the menu
    // never runs off the viewport edge.
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    if (r.right - mw > 8 && left + mw > window.innerWidth - 8) left = r.right - mw;
    left = Math.max(8, left);
    let top = placement === 'above' ? r.top - mh - 6 : r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    if (top < 8) top = 8;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    const buttons = () => [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const onKey = e => {
      const list = buttons();
      const i = list.indexOf(root.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0] && list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1] && list[list.length - 1].focus(); }
      else if (e.key === 'Tab') { close(); }
    };
    // Clicks anywhere else - in our root or on Gmail itself - dismiss it.
    const onPointer = e => {
      if (!e.composedPath().includes(menu) && !e.composedPath().includes(anchor)) close();
    };

    // If the menu held focus, it goes back to the anchor - on Esc, on
    // choosing an item (before the action runs, so an action that
    // re-renders can find the anchor again by its data-key), and when a
    // re-render closes the menu from underneath.
    function close() {
      if (openMenus.get(root) !== close) return;
      const hadFocus = menu.contains(root.activeElement);
      openMenus.delete(root);
      menu.remove();
      if (hadFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
      anchor.setAttribute('aria-expanded', 'false');
      menu.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    }

    menu.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    openMenus.set(root, close);

    const first = buttons()[0];
    if (first) first.focus();
    return close;
  }

  ns.ui = { h, append, icon, mountShadow, toast, openMenu, closeMenu, isMenuOpen };
})();

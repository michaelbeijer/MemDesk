// ─────────────────────────────────────────────────────────────────────
// Styles for the injected UI
//
// Plain strings, adopted into each shadow root. The look borrows Gmail's
// own vocabulary - Google Sans, its blue, its elevation shadows, pill
// buttons - so the board reads as part of Gmail rather than something
// bolted on. Dark mode follows the operating system, as asked; Gmail's
// own theme setting is not visible to a content script without scraping.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const ns = (globalThis.gkb = globalThis.gkb || {});

  // ── Shared ───────────────────────────────────────────────────────────

  const BASE = `
:host {
  all: initial !important;
  /* A positioned host with a z-index is its own stacking context, so
     menus and toasts inside it can layer over the board with small
     numbers instead of competing with Gmail's. */
  position: relative !important;
  z-index: 2147483000 !important;

  --bg: #f6f8fc;
  --bar: #f6f8fc;
  --col: #e9eef6;
  --surface: #ffffff;
  --menu: #ffffff;
  --fg: #1f1f1f;
  --fg-2: #444746;
  --fg-3: #5e6062;
  --accent: #0b57d0;
  --on-accent: #ffffff;
  --accent-soft: #d3e3fd;
  --on-accent-soft: #041e49;
  --border: #e1e3e1;
  --border-strong: #c4c7c5;
  --hover: rgba(68, 71, 70, .08);
  --press: rgba(68, 71, 70, .14);
  --focus: #0b57d0;
  --danger: #b3261e;
  --star: #e8a400;
  --inverse: #303030;
  --on-inverse: #f2f2f2;
  --inverse-accent: #a8c7fa;
  --scrim: rgba(32, 33, 36, .4);
  --shadow-1: 0 1px 2px rgba(60, 64, 67, .2), 0 1px 3px 1px rgba(60, 64, 67, .1);
  --shadow-2: 0 1px 2px rgba(60, 64, 67, .3), 0 2px 6px 2px rgba(60, 64, 67, .15);
  --shadow-3: 0 4px 8px 3px rgba(60, 64, 67, .15), 0 1px 3px rgba(60, 64, 67, .3);
  --font: "Google Sans", Roboto, Arial, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :host {
    --bg: #131314;
    --bar: #131314;
    --col: #1e1f20;
    --surface: #2a2b2d;
    --menu: #2d2e30;
    --fg: #e3e3e3;
    --fg-2: #c4c7c5;
    --fg-3: #a2a5a3;
    --accent: #a8c7fa;
    --on-accent: #062e6f;
    --accent-soft: #004a77;
    --on-accent-soft: #c2e7ff;
    --border: #3a3b3d;
    --border-strong: #5c5e60;
    --hover: rgba(227, 227, 227, .08);
    --press: rgba(227, 227, 227, .14);
    --focus: #a8c7fa;
    --danger: #f2b8b5;
    --star: #fdd663;
    --inverse: #e3e3e3;
    --on-inverse: #1f1f1f;
    --inverse-accent: #0b57d0;
    --scrim: rgba(0, 0, 0, .55);
    --shadow-1: 0 1px 2px rgba(0, 0, 0, .5), 0 1px 3px 1px rgba(0, 0, 0, .25);
    --shadow-2: 0 1px 3px rgba(0, 0, 0, .6), 0 2px 8px 2px rgba(0, 0, 0, .3);
    --shadow-3: 0 4px 10px 3px rgba(0, 0, 0, .45), 0 1px 3px rgba(0, 0, 0, .6);
  }
}

*, *::before, *::after { box-sizing: border-box; }

/* Author display rules (.pill, .overlay…) would otherwise beat the
   browser's own [hidden] { display: none }. */
[hidden] { display: none !important; }

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  margin: 0;
  padding: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
button:disabled { cursor: default; }

:focus { outline: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.icon { display: block; flex: none; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--fg-2);
  flex: none;
}
.icon-btn:hover { background: var(--hover); color: var(--fg); }
.icon-btn:active { background: var(--press); }
.icon-btn:disabled { opacity: .4; background: none; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 18px;
  border-radius: 18px;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: .01em;
  white-space: nowrap;
}
.btn-primary { background: var(--accent); color: var(--on-accent); }
.btn-primary:hover { box-shadow: var(--shadow-1); }
.btn-tonal { background: var(--accent-soft); color: var(--on-accent-soft); }
.btn-text { color: var(--accent); padding: 0 12px; }
.btn-text:hover, .btn-tonal:hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.btn:disabled { opacity: .5; box-shadow: none; }

/* ── Menus ── */

.menu {
  position: fixed;
  z-index: 20;
  min-width: 208px;
  max-width: 320px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 8px 0;
  background: var(--menu);
  color: var(--fg);
  border-radius: 8px;
  box-shadow: var(--shadow-3);
  font-family: var(--font);
  font-size: 14px;
  line-height: 20px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 36px;
  padding: 6px 20px 6px 12px;
  text-align: left;
}
.menu-item:hover { background: var(--hover); }
.menu-item:focus-visible { background: var(--hover); outline: 2px solid var(--focus); outline-offset: -2px; }
.menu-item:disabled { opacity: .45; background: none; }
.menu-item.danger { color: var(--danger); }
.menu-icon { width: 18px; height: 18px; display: inline-flex; color: var(--fg-2); flex: none; }
.menu-item.danger .menu-icon { color: var(--danger); }
.menu-item[aria-checked="true"] .menu-icon { color: var(--accent); }
.menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-heading {
  padding: 8px 20px 4px 42px;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-3);
}
.menu-sep { height: 1px; margin: 8px 0; background: var(--border); }

/* ── Toasts ── */

.toasts {
  position: fixed;
  z-index: 30;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  font-family: var(--font);
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  max-width: min(600px, calc(100vw - 32px));
  padding: 6px 6px 6px 16px;
  border-radius: 8px;
  background: var(--inverse);
  color: var(--on-inverse);
  box-shadow: var(--shadow-3);
  font-size: 14px;
  line-height: 20px;
  animation: toast-in .18s ease-out;
}
.toast-error { border-left: 4px solid #f28b82; padding-left: 12px; }
.toast-text { flex: 1; padding-right: 8px; }
.toast-action {
  height: 36px;
  padding: 0 12px;
  border-radius: 18px;
  color: var(--inverse-accent);
  font-weight: 500;
  white-space: nowrap;
}
.toast-action:hover { background: rgba(128, 128, 128, .16); }
.toast-close { color: inherit; opacity: .8; }
.toast-close:hover { background: rgba(128, 128, 128, .16); color: inherit; }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

  // ── Board ────────────────────────────────────────────────────────────

  const BOARD = `
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.overlay[hidden] { display: none; }

.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 64px;
  padding: 0 12px 0 20px;
  flex: none;
  background: var(--bar);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 22px;
  font-weight: 400;
  color: var(--fg);
  white-space: nowrap;
}
.brand .logo { color: var(--accent); }
.brand .dim { color: var(--fg-3); }
.account {
  margin-left: 14px;
  padding: 4px 12px;
  border-radius: 14px;
  background: var(--hover);
  color: var(--fg-2);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.spacer { flex: 1; }
.updated { color: var(--fg-3); font-size: 12px; white-space: nowrap; margin-right: 2px; }
.spinning .icon { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.body { flex: 1; display: flex; min-height: 0; }

.columns {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 4px 20px 20px;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 0;
}
.column {
  flex: 1 0 280px;
  min-width: 280px;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--col);
  border-radius: 16px;
  transition: box-shadow .12s;
}
.column.drop-target { box-shadow: inset 0 0 0 2px var(--accent); }
.col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 6px 6px 16px;
  flex: none;
}
.col-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-count {
  flex: none;
  min-width: 22px;
  padding: 0 7px;
  border-radius: 11px;
  background: var(--surface);
  color: var(--fg-2);
  font-size: 12px;
  line-height: 22px;
  text-align: center;
}
.col-flag {
  flex: none;
  padding: 0 8px;
  border-radius: 11px;
  border: 1px solid var(--border-strong);
  color: var(--fg-3);
  font-size: 11px;
  line-height: 20px;
}
.col-head .spacer { min-width: 4px; }
.col-note { padding: 0 16px 6px; font-size: 12px; color: var(--fg-3); flex: none; }

.list {
  flex: 1;
  min-height: 72px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 8px 12px;
  scrollbar-width: thin;
}
.list:empty::after {
  content: attr(data-empty);
  display: block;
  margin: 2px 0;
  padding: 22px 12px;
  border: 1.5px dashed var(--border-strong);
  border-radius: 12px;
  color: var(--fg-3);
  font-size: 13px;
  text-align: center;
}

/* ── Cards ── */

.card {
  position: relative;
  flex: none;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: var(--shadow-1);
  cursor: grab;
  transition: box-shadow .15s;
}
.card:hover { box-shadow: var(--shadow-2); }
.card.dragging { display: none; }
.card.lifting { opacity: .5; }
.card-main {
  display: block;
  width: 100%;
  padding: 10px 14px 12px;
  border-radius: 12px;
  text-align: left;
  cursor: inherit;
}
.card-main:focus-visible { outline-offset: -2px; }
.card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  font-size: 13px;
  color: var(--fg-2);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.from { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.date { flex: none; font-size: 12px; color: var(--fg-3); }
.card:hover .date, .card:focus-within .date { visibility: hidden; }
.subject-row { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
.subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: var(--fg);
}
.unread .from, .unread .subject { font-weight: 700; color: var(--fg); }
.star { color: var(--star); display: inline-flex; flex: none; }
.count {
  flex: none;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--hover);
  color: var(--fg-2);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}
.draft { flex: none; color: var(--danger); font-size: 12px; }
.snippet {
  margin-top: 3px;
  font-size: 13px;
  line-height: 18px;
  color: var(--fg-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.card-menu {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 32px;
  height: 32px;
  opacity: 0;
  background: var(--surface);
}
.card-menu:hover { background: var(--hover); }
.card:hover .card-menu, .card:focus-within .card-menu, .card-menu[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .card-menu { opacity: 1; } .card .date { visibility: visible; } }

.placeholder {
  flex: none;
  border-radius: 12px;
  border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.skeleton {
  flex: none;
  height: 92px;
  border-radius: 12px;
  background: var(--surface);
  opacity: .55;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: .3; } }

/* ── Column search ── */

.search {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 55%;
  min-height: 0;
  margin: 0 8px 8px;
  padding: 8px;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-2);
}
.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 2px 0 12px;
  border-radius: 20px;
  background: var(--col);
  color: var(--fg-2);
  flex: none;
}
.search-box:focus-within { outline: 2px solid var(--focus); }
.search-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
}
.search-box input::placeholder { color: var(--fg-3); }
.search-box input:focus-visible { outline: none; }
.search-hint { padding: 0 8px; font-size: 12px; color: var(--fg-3); flex: none; }
.results { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin; }
.result {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  text-align: left;
}
.result:hover:not(:disabled) { background: var(--hover); }
.result:disabled { opacity: .55; }
.r-top { display: flex; gap: 6px; font-size: 12px; color: var(--fg-2); }
.r-top .from { font-weight: 500; }
.r-subject {
  display: block;
  font-size: 13px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r-where { display: block; font-size: 12px; color: var(--accent); margin-top: 1px; }
.result:disabled .r-where { color: var(--fg-3); }
.results-empty { padding: 12px 8px; font-size: 13px; color: var(--fg-3); text-align: center; }

/* ── Status panels ── */

.panel {
  margin: auto;
  width: min(460px, calc(100vw - 48px));
  padding: 36px 32px 32px;
  border-radius: 28px;
  background: var(--surface);
  box-shadow: var(--shadow-1);
  text-align: center;
}
.panel .panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--on-accent-soft);
}
.panel h2 { margin: 16px 0 8px; font-size: 22px; font-weight: 400; color: var(--fg); }
.panel p { margin: 0 0 20px; color: var(--fg-2); line-height: 1.5; }
.panel .actions { display: flex; gap: 8px; justify-content: center; }

/* ── Column settings drawer ── */

.scrim { position: fixed; inset: 0; z-index: 5; background: var(--scrim); }
.drawer {
  position: fixed;
  z-index: 6;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 100vw);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-3);
  font-family: var(--font);
  font-size: 14px;
  animation: drawer-in .18s ease-out;
}
@keyframes drawer-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 4px 24px; flex: none; }
.drawer-head h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 400; }
.drawer-intro { margin: 0; padding: 0 24px 12px; color: var(--fg-2); font-size: 13px; line-height: 1.5; flex: none; }
.drawer-body { flex: 1; overflow-y: auto; padding: 4px 24px 16px; }
.col-row {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
  padding: 12px 12px 10px 14px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
}
.row-head { display: flex; align-items: center; gap: 2px; }
.row-head .row-num {
  width: 22px;
  height: 22px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--col);
  color: var(--fg-2);
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  flex: none;
}
.row-head .row-title { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field { display: grid; gap: 4px; }
.field-label { font-size: 12px; color: var(--fg-2); }
.text-input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 14px;
}
.text-input:focus-visible { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }
.field-help { font-size: 12px; color: var(--fg-3); }
.check { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--fg-2); cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.add-col { width: 100%; height: 44px; border-radius: 16px; border: 1.5px dashed var(--border-strong); color: var(--accent); font-weight: 500; }
.add-col:hover { background: var(--hover); }
.drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px 16px 24px;
  border-top: 1px solid var(--border);
  flex: none;
}
.drawer-foot .note { flex: 1; font-size: 12px; color: var(--fg-3); line-height: 1.45; }
.form-error { color: var(--danger); font-size: 13px; padding: 0 24px 8px; flex: none; }
.form-error:empty { display: none; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`;

  // ── Dock ─────────────────────────────────────────────────────────────

  const DOCK = `
:host { z-index: 2147482999 !important; }

.dock {
  position: fixed;
  left: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
.dock.right { left: auto; right: 72px; }
.dock[hidden] { display: none; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 16px 0 12px;
  border-radius: 20px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-2);
  font-weight: 500;
  white-space: nowrap;
  max-width: 320px;
}
.pill:hover { box-shadow: var(--shadow-3); background-image: linear-gradient(var(--hover), var(--hover)); }
.pill .icon { color: var(--accent); }
.pill.on { background-color: var(--accent-soft); color: var(--on-accent-soft); }
.pill.on .icon { color: inherit; }
.pill .pill-label { overflow: hidden; text-overflow: ellipsis; }
.pill .caret { margin: 0 -6px 0 -2px; color: inherit; }
.pill.busy { opacity: .7; }
`;

  ns.styles = { board: BASE + BOARD, dock: BASE + DOCK };
})();

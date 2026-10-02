#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The README's pictures, and the Chrome Web Store's
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tools/readme-shots.mjs
//
// Screenshots of the real code - the board and notes in the dev preview,
// the phone app as Code.gs serves it - running against the preview's fake
// mailbox in its tidy "showcase" mode, then framed in a browser window and
// phones: the README's in images/, the store's screenshots and tile in
// store/. Every name and address in them is invented. Raw shots go to
// $SCREENS_DIR (default /tmp/readme-shots).
// ─────────────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { REPO, loadPlaywright, findChromium } from '../tests/e2e/lib.mjs';
import { appHtml } from './build-addon.mjs';

const require = createRequire(import.meta.url);
const { Phone } = require('../tests/helpers/apps-script.js');
const { chromium } = await loadPlaywright();

export const RAW = process.env.SCREENS_DIR || join(tmpdir(), 'readme-shots');
mkdirSync(RAW, { recursive: true });
const PREVIEW = pathToFileURL(join(REPO, 'dev', 'preview.html')).href + '?showcase&latency=0';
const APP = join(RAW, 'app-page.html');
writeFileSync(APP, appHtml());

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const shot = (page, name) => page.screenshot({ path: join(RAW, `${name}.png`), animations: 'disabled' });
const backgrounds = {};
// The colour at the top of a phone shot, for the status bar drawn above it.
const phoneShot = async (page, name) => {
  backgrounds[name] = await page.evaluate(() => getComputedStyle(document.querySelector('#gkb-app-host').shadowRoot.querySelector('.overlay')).backgroundColor);
  await shot(page, name);
};
const pause = ms => new Promise(r => setTimeout(r, ms));

// ── A computer: Gmail with the board and the notes ───────────────────

async function desktop(colorScheme, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme });
  const page = await ctx.newPage();
  await page.goto(PREVIEW);
  // The preview's yellow developer bar is not part of Gmail.
  await page.addStyleTag({ content: '.devbar { display: none !important; }' });
  await page.locator('[data-action="toggle-board"]').waitFor();
  return page;
}

{
  // An email open in Gmail, with its place on the board below it: a smaller
  // window, so the button and its menu are not lost in the page.
  const page = await desktop('light', { width: 1100, height: 640 });
  await page.evaluate(() => document.getElementById('dev-toggle-thread').click());
  const pill = page.locator('[data-action="thread-menu"]');
  for (let i = 0; i < 50 && !/On board/.test(await pill.innerText()); i++) await pause(100);
  await pill.click();
  await page.locator('.menu').waitFor();
  await page.mouse.move(0, 0);
  await shot(page, 'gmail-dock');
  await page.context().close();
}

{
  const page = await desktop('light');

  await page.locator('[data-action="toggle-board"]').click();
  await page.locator('.card').first().waitFor();
  await pause(300);
  await page.mouse.move(0, 0);
  await shot(page, 'board');

  await page.locator('[data-key="view:notes"]').click();
  await page.locator('.note-item').first().waitFor();
  // Nothing else open: the scratchpad.
  await page.locator('.note-editor.scratch .ne-body[contenteditable="true"]').waitFor();
  await page.locator('.note-editor.scratch .ne-body').evaluate(el => el.blur());
  await pause(300);
  await page.mouse.move(0, 0);
  await shot(page, 'notes-scratch');
  await page.locator('.note-item', { hasText: 'This week' }).click();
  await page.locator('.ne-body .blk').first().waitFor();
  await pause(300);
  await page.mouse.move(0, 0);
  await shot(page, 'notes');

  await page.locator('[data-key="notes-search"]').fill('termbase');
  await page.locator('[data-key="notes-search"]').press('Enter');
  await page.locator('.note-item', { hasText: 'Glossary to-dos' }).waitFor();
  await page.locator('.note-item', { hasText: 'Glossary to-dos' }).click();
  await page.locator('.ne-body .blk').first().waitFor();
  await pause(500);
  await page.mouse.move(0, 0);
  await shot(page, 'notes-search');
  await page.context().close();
}

{
  const page = await desktop('dark');
  await page.locator('[data-action="toggle-board"]').click();
  await page.locator('.card').first().waitFor();
  await pause(300);
  await page.mouse.move(0, 0);
  await shot(page, 'board-dark');
  await page.context().close();
}

// ── A phone: the notes app ───────────────────────────────────────────

function installGoogle() {
  function runner(success, failure) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return fn => runner(fn, failure);
        if (name === 'withFailureHandler') return fn => runner(success, fn);
        return (...args) => window.__gas(String(name), args).then(
          res => success && success(res),
          err => failure && failure(new Error(String(err.message))));
      },
    });
  }
  window.google = { script: { run: runner(null, null), history: { push() {}, replace() {}, setChangeHandler() {} } } };
}

async function phone(colorScheme) {
  const fake = new Phone({ search: '?showcase' });
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 860 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme,
  });
  const page = await ctx.newPage();
  await page.exposeFunction('__gas', (fn, args) => fake.server(fn, ...args));
  await page.addInitScript(installGoogle);
  await page.goto(pathToFileURL(APP).href);
  await page.locator('#gkb-app-host >> .note-editor.scratch .ne-body[contenteditable="true"]').waitFor();
  return page;
}
const q = (page, sel) => page.locator(`#gkb-app-host >> ${sel}`);

{
  // It opens on the scratchpad.
  const page = await phone('light');
  await pause(300);
  await phoneShot(page, 'phone-home');
  await q(page, '[data-key="folders-toggle"]').tap();
  await pause(200);
  await phoneShot(page, 'phone-folders');
  await q(page, '[data-key="folder:all"]').tap();
  await q(page, '.note-item').filter({ hasText: 'This week' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  await pause(300);
  await phoneShot(page, 'phone-note');
  // And the board, one column to a screen.
  await q(page, '[data-key="note-back"]').tap();
  await q(page, '[data-key="view:board"]').tap();
  await q(page, '.card .subject').first().waitFor();
  await pause(400);
  await phoneShot(page, 'phone-board');
  await page.context().close();
}

{
  const page = await phone('dark');
  await q(page, '[data-key="notes-search"]').fill('termbase');
  await q(page, '[data-key="notes-search"]').press('Enter');
  await q(page, '.note-item').filter({ hasText: 'October newsletter' }).waitFor();
  await pause(600);
  await phoneShot(page, 'phone-search-dark');
  await q(page, '.note-item').filter({ hasText: 'October newsletter' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  await pause(500);
  await phoneShot(page, 'phone-note-dark');
  await page.context().close();
}

writeFileSync(join(RAW, 'backgrounds.json'), JSON.stringify(backgrounds, null, 2));

// ── Framed: a browser window, phones, a violet backdrop ──────────────
//
// Laid out as a page and photographed, at twice the size they show at.

const OUT = join(REPO, 'images');
mkdirSync(OUT, { recursive: true });
const ICON = readFileSync(join(REPO, 'icons', 'icon.svg'), 'utf8').replace(/width="128" height="128"/, 'width="100%" height="100%"');

const glyph = (d, size = 16, color = 'currentColor') =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="${color}" d="${d}"/></svg>`;
const G = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  fwd: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  reload: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  lock: 'M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM9 8V6a3 3 0 0 1 6 0v2H9z',
  mail: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  wifi: 'M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.24 4.24 0 0 0-6 0zm-4-4 2 2a7.07 7.07 0 0 1 10 0l2-2C15.14 9.14 8.87 9.14 5 13z',
  signal: 'M2 22h20V2z',
  battery: 'M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z',
};

// A Chrome window around a computer screenshot.
function browserWindow(img, { width, dark = false, title = 'Inbox – sam@example.com', url = 'mail.google.com/mail/u/0/#inbox', style = '' }) {
  return `<div class="win${dark ? ' dark' : ''}" style="width:${width}px;${style}">
    <div class="tabs"><div class="tab">${glyph(G.mail, 15)}<span>${title}</span><b>×</b></div><span class="plus">+</span>
      <div class="ctrl"><i class="min"></i><i class="max"></i><i class="x">×</i></div></div>
    <div class="toolbar">${glyph(G.back, 18)}${glyph(G.fwd, 18)}${glyph(G.reload, 18)}
      <div class="omni">${glyph(G.lock, 13)}<span>${url}</span>${glyph(G.star, 16)}</div>
      <span class="ext">${ICON}</span><span class="avatar">S</span></div>
    <img src="${img}.png" alt="">
  </div>`;
}

// A phone around a phone screenshot, with a status bar in the page's colour.
const backdrop = JSON.parse(readFileSync(join(RAW, 'backgrounds.json'), 'utf8'));
function phoneFrame(img, { width, style = '' }) {
  const bg = backdrop[img] || '#fff';
  const dark = /19, 19, 20/.test(bg);
  return `<div class="phone" style="width:${width}px;${style}">
    <div class="screen" style="background:${bg};color:${dark ? '#e3e3e3' : '#1f1f1f'}">
      <div class="status"><span>9:41</span><i class="cam"></i><span class="sys">${glyph(G.wifi, 13)}${glyph(G.signal, 12)}${glyph(G.battery, 13)}</span></div>
      <img src="${img}.png" alt="">
    </div>
  </div>`;
}

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: Roboto, Arial, sans-serif; }
.canvas { position: relative; overflow: hidden; }
.win { border-radius: 12px; overflow: hidden; background: #fff; position: relative;
  box-shadow: 0 40px 90px -20px rgba(30, 10, 80, .55), 0 0 0 1px rgba(20, 10, 60, .12); }
.win > img { display: block; width: 100%; }
.tabs { height: 40px; background: #dfe1e5; display: flex; align-items: flex-end; padding: 0 10px; gap: 6px; color: #3c4043; }
.tab { height: 32px; width: 250px; background: #fff; border-radius: 10px 10px 0 0; padding: 0 12px; display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
.tab span { flex: 1; white-space: nowrap; overflow: hidden; }
.tab b { font-weight: 400; color: #5f6368; }
.plus { align-self: center; color: #5f6368; font-size: 18px; padding: 0 4px; }
.ctrl { margin-left: auto; align-self: stretch; display: flex; align-items: center; gap: 26px; padding: 0 8px; color: #3c4043; }
.ctrl i { display: block; font-style: normal; }
.ctrl .min { width: 11px; height: 1px; background: currentColor; }
.ctrl .max { width: 10px; height: 10px; border: 1px solid currentColor; }
.ctrl .x { font-size: 17px; line-height: 1; }
.toolbar { height: 40px; background: #fff; display: flex; align-items: center; gap: 14px; padding: 0 12px; color: #5f6368; border-bottom: 1px solid #e8eaed; }
.omni { flex: 1; height: 30px; border-radius: 15px; background: #f1f3f4; display: flex; align-items: center; gap: 10px; padding: 0 14px; font-size: 13.5px; color: #202124; }
.omni span { flex: 1; }
.ext { width: 18px; height: 18px; display: block; }
.ext svg { display: block; }
.avatar { width: 24px; height: 24px; border-radius: 50%; background: #7b5cd6; color: #fff; display: grid; place-items: center; font-size: 12px; }
.win.dark .tabs { background: #202124; color: #e8eaed; }
.win.dark .tab { background: #35363a; }
.win.dark .ctrl, .win.dark .plus, .win.dark .tab b { color: #bdc1c6; }
.win.dark .toolbar { background: #35363a; color: #bdc1c6; border-color: #202124; }
.win.dark .omni { background: #202124; color: #e8eaed; }
.phone { position: relative; padding: 10px; background: #0d0d10; border-radius: 46px;
  box-shadow: 0 40px 80px -20px rgba(30, 10, 80, .6), inset 0 0 0 2px #2b2b30, 0 0 0 1px rgba(255,255,255,.08); }
.screen { border-radius: 37px; overflow: hidden; position: relative; }
.screen img { display: block; width: 100%; }
.status { height: 30px; display: flex; align-items: center; justify-content: space-between; padding: 2px 26px 0; font-size: 13px; font-weight: 500; }
.status .sys { display: flex; gap: 4px; align-items: center; }
.cam { width: 11px; height: 11px; border-radius: 50%; background: #050505; box-shadow: 0 0 0 2px rgba(0,0,0,.25); }
.violet { background:
  radial-gradient(1200px 500px at 85% -10%, rgba(196, 181, 253, .45), transparent 60%),
  radial-gradient(900px 600px at 0% 110%, rgba(99, 102, 241, .45), transparent 60%),
  linear-gradient(135deg, #2e1065 0%, #4c1d95 45%, #6d28d9 100%); }
.soft { background:
  radial-gradient(700px 400px at 10% 0%, rgba(196, 181, 253, .55), transparent 70%),
  radial-gradient(800px 500px at 100% 100%, rgba(165, 180, 252, .5), transparent 70%),
  linear-gradient(160deg, #f5f3ff, #ede9fe 55%, #e0e7ff); }
.dots::before { content: ''; position: absolute; inset: 0; opacity: .18;
  background-image: radial-gradient(rgba(255,255,255,.9) 1px, transparent 1.4px); background-size: 22px 22px; }
.soft.dots::before { background-image: radial-gradient(rgba(76, 29, 149, .5) 1px, transparent 1.4px); opacity: .12; }
`;

const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1200, height: 800 } });
async function compose(name, width, height, body) {
  const file = join(RAW, `compose-${name}.html`);
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div class="canvas ${body.cls}" style="width:${width}px;height:${height}px">${body.html}</div>`);
  await page.setViewportSize({ width, height });
  await page.goto(pathToFileURL(file).href);
  await page.waitForLoadState('load');
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
}
// A PNG's size, from its header.
const pngSize = name => { const b = readFileSync(join(RAW, `${name}.png`)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const framed = (name, width) => Math.round(width * pngSize(name).h / pngSize(name).w + 80);
const at = (html, left, top) => `<div style="position:absolute;left:${left}px;top:${top}px">${html}</div>`;

// The top of the README: Gmail with the board, the phone app in front.
await compose('hero', 1200, 660, { cls: 'violet dots', html:
  at(browserWindow('board', { width: 900 }), 64, 64) +
  at(phoneFrame('phone-home', { width: 252 }), 892, 128) });

// One window each, on the soft backdrop.
const single = (img, opts = {}) => ({ cls: 'soft dots', html: at(browserWindow(img, { width: 1088, ...opts }), 56, 56) });
await compose('board', 1200, framed('board', 1088) + 112, {
  cls: 'soft dots',
  // Light and dark, split down a diagonal: it follows Chrome's setting.
  html: at(browserWindow('board', { width: 1088 }), 56, 56) +
    at(browserWindow('board-dark', { width: 1088, dark: true, style: 'clip-path: polygon(64% 0, 100% 0, 100% 100%, 46% 100%)' }), 56, 56),
});
await compose('gmail', 1200, framed('gmail-dock', 1088) + 112, single('gmail-dock', { title: 'Termbase export won’t open', url: 'mail.google.com/mail/u/0/#inbox/18f2a3b4c5d6e025' }));
await compose('notes', 1200, framed('notes', 1088) + 112, single('notes'));
await compose('search', 1200, framed('notes-search', 1088) + 112, single('notes-search'));

// The scratchpad: open in Chrome whenever no other note is, and what the
// phone opens on.
await compose('scratchpad', 1200, 760, { cls: 'soft dots', html:
  at(browserWindow('notes-scratch', { width: 900 }), 56, 56) +
  at(phoneFrame('phone-home', { width: 262 }), 884, 104) });

// The phone app: the folders, a note, and search in the dark.
await compose('phone', 1200, 760, { cls: 'violet dots', html:
  at(phoneFrame('phone-board', { width: 300 }), 90, 70) +
  at(phoneFrame('phone-home', { width: 300 }), 450, 30) +
  at(phoneFrame('phone-search-dark', { width: 300 }), 810, 70) });

// ── The Chrome Web Store: 1280×800 screenshots, and the small tile ────
//
// JPEG, since the store takes no transparency.

const STORE = join(REPO, 'store');
mkdirSync(STORE, { recursive: true });
// The store wants these at exactly their size: one pixel per pixel.
const storePage = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1280, height: 800 } });
async function storeShot(name, width, height, cls, html) {
  const file = join(RAW, `store-${name}.html`);
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${CSS}
.caption { position: absolute; left: 0; right: 0; top: 26px; text-align: center; font: 500 27px/1.2 Roboto, Arial, sans-serif; color: #2e1065; }
.violet .caption { color: #fff; }</style><div class="canvas ${cls}" style="width:${width}px;height:${height}px">${html}</div>`);
  await storePage.setViewportSize({ width, height });
  await storePage.goto(pathToFileURL(file).href);
  await storePage.waitForLoadState('load');
  await storePage.screenshot({ path: join(STORE, `${name}.jpg`), type: 'jpeg', quality: 92 });
}
const caption = text => `<div class="caption">${text}</div>`;
const APP_NAME = /APP_NAME = '([^']+)'/.exec(readFileSync(join(REPO, 'src', 'shared', 'ns.js'), 'utf8'))[1];
const storeWindow = (img, opts = {}) => at(browserWindow(img, { width: 980, ...opts }), 150, 84);
await storeShot('screenshot-1', 1280, 800, 'violet dots', caption('A Kanban board and a notebook, inside Gmail') +
  at(browserWindow('board', { width: 930 }), 60, 92) + at(phoneFrame('phone-home', { width: 240 }), 950, 150));
await storeShot('screenshot-2', 1280, 800, 'soft dots', caption('Every card is an email: drag it to the next column') + storeWindow('board'));
await storeShot('screenshot-3', 1280, 800, 'soft dots', caption('Notes in your own mailbox, with folders and a Scratchpad') + storeWindow('notes-scratch'));
await storeShot('screenshot-4', 1280, 800, 'soft dots', caption('Search shows you where the words are') + storeWindow('notes-search'));
await storeShot('screenshot-5', 1280, 800, 'soft dots', caption('File the email you are reading, without leaving it') +
  storeWindow('gmail-dock', { title: 'Termbase export won’t open', url: 'mail.google.com/mail/u/0/#inbox/18f2a3b4c5d6e025' }));
await storeShot('promo-small', 440, 280, 'violet dots', `
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;font-family:Roboto,Arial,sans-serif">
    <div style="width:92px;height:92px">${ICON}</div>
    <div style="font-size:38px;font-weight:500;letter-spacing:.2px">${APP_NAME}</div>
    <div style="font-size:16px;opacity:.92">A Kanban board and a notebook, inside Gmail</div>
  </div>`);

await browser.close();
console.log(`Raw screenshots in ${RAW}; framed ones in images/, the store's in store/`);

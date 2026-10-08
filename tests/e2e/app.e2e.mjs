#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Browser check (c): the phone app, on a phone-sized screen
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tests/e2e/app.e2e.mjs
//
// The page addon/Code.gs serves (built by tools/build-addon.mjs) runs in
// Chromium at a phone's size, with touch. Its google.script.run reaches
// the very same Code.gs, run in Node by the Apps Script stand-in, which
// talks to the preview's fake Gmail - so a tap on the phone goes through
// the real client, the real server code and a mailbox that is checked
// after each step.
// ─────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { REPO, loadPlaywright, findChromium, screensDir, runner, until, watchErrors } from './lib.mjs';
import { appHtml } from '../../tools/build-addon.mjs';

const require = createRequire(import.meta.url);
const { Phone, plain, AUTHORIZE_URL } = require('../helpers/apps-script.js');

const { chromium } = await loadPlaywright();
const SCREENS = screensDir();
const errors = [];
const r = runner('app');

const PAGE = join(screensDir(), 'app-page.html');
writeFileSync(PAGE, appHtml());

// The page as Apps Script may deliver it: HTML comments and anything that
// looks like a "//" comment cut out of the text, and the scripts taken
// out of the page and run afterwards by a loader that swallows errors.
// The phone app came up blank in Apps Script until it could survive this.
function roughly(html) {
  const scripts = [];
  const page = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script>([\s\S]*?)<\/script>/g, (_, code) => { scripts.push(code.replace(/\/\/[^\n]*/g, '')); return ''; });
  const loader = `<script>(${function load(list) {
    document.addEventListener('DOMContentLoaded', () => {
      for (const code of list) { try { (0, eval)(code); } catch (err) { console.warn(`swallowed: ${err.message}`); } }
    });
  }})(${JSON.stringify(scripts)});</script>`;
  return page.replace('</body>', () => `${loader}</body>`);
}
const ROUGH = join(screensDir(), 'app-page-rough.html');
writeFileSync(ROUGH, roughly(appHtml()));

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

// google.script.run and google.script.history, as Apps Script provides
// them in the page - the calls go to window.__gas, wired to Node below.
function installGoogle() {
  window.__history = [];
  function runner(success, failure) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return fn => runner(fn, failure);
        if (name === 'withFailureHandler') return fn => runner(success, fn);
        return (...args) => {
          window.__calls = (window.__calls || 0) + 1;
          window.__gas(String(name), args).then(
            res => { window.__calls--; if (success) success(res); },
            err => { window.__calls--; if (failure) failure(new Error(String(err.message).replace(/^Error: /, ''))); });
        };
      },
    });
  }
  window.google = {
    script: {
      run: runner(null, null),
      history: {
        push(state) { window.__history.push(state); },
        replace(state) { window.__history[window.__history.length - 1] = state; },
        setChangeHandler(fn) { window.__historyHandler = fn; },
      },
    },
  };
}

// Apps Script's history refusing every call: the app must start anyway.
function breakHistory() {
  const no = () => { throw new Error('history is not available here'); };
  window.google.script.history = { push: no, replace: no, setChangeHandler: no };
}

async function openApp({ search = '', colorScheme = 'light', brokenHistory = false, file = PAGE, phone: given = null } = {}) {
  // Another phone on the same mailbox, or a mailbox of its own.
  const phone = given ? new Phone({ fake: given.fake }) : new Phone({ search });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme,
  });
  const page = await ctx.newPage();
  watchErrors(page, errors);
  await page.exposeFunction('__gas', (fn, args) => phone.server(fn, ...args));
  await page.addInitScript(installGoogle);
  if (brokenHistory) await page.addInitScript(breakHistory);
  await page.goto(pathToFileURL(file).href);
  return { phone, page };
}

const host = '#gkb-app-host';
const q = (page, sel) => page.locator(`${host} >> ${sel}`);
const visible = (page, sel) => q(page, sel).first().isVisible();
const settled = page => until(async () => (await page.evaluate(() => window.__calls || 0)) === 0, 'server calls settled', 8000);
// The notes listed, the pinned scratchpad aside.
const titles = page => q(page, '.note-item:not(.scratch-item) .ni-title').allInnerTexts();
const view = page => page.evaluate(() => document.querySelector('#gkb-app-host').shadowRoot.querySelector('.notes').dataset.view);
const scratchReady = page => q(page, '.note-editor.scratch .ne-body[contenteditable="true"]').waitFor();
const SCRATCH = 'scratchpad000000';
const live = (phone, noteId) => plain(phone.fake.box.notesWithId(noteId)).filter(n => !n.labels.includes('TRASH'));

const { phone, page } = await openApp();

// Opens the folder tree and picks a folder in it.
async function pickFolder(p, title) {
  await q(p, '[data-key="folders-toggle"]').tap();
  await q(p, '.folder-btn').filter({ has: p.locator('.folder-title').filter({ hasText: new RegExp(`^${title}$`) }) }).first().tap();
}
const toggleText = async p => (await q(p, '[data-key="folders-toggle"]').innerText()).replace(/\s+/g, ' ').trim();

await r.step('it opens on the scratchpad, under the search box, ready to type into - and no list', async () => {
  await scratchReady(page);
  assert.equal(await view(page), 'home');
  assert.equal(await visible(page, '[data-key="notes-search"]'), true);
  assert.equal(await visible(page, '[data-key="note-new"]'), true);
  assert.equal(await q(page, '[data-key="scratch-title"] .st-name').innerText(), 'Scratchpad');
  assert.equal(await visible(page, '.notes-items'), false, 'the notes stay out of the way');
  assert.equal(await visible(page, '.folder-items'), false, 'the tree is folded away');
  assert.equal(await visible(page, '[data-key="note-delete"]'), false, 'nothing to delete or move it with');
  assert.equal(await visible(page, '[data-key="note-folder"]'), false);
  await until(async () => (await toggleText(page)) === 'All notes 5', 'says where you are');
  await page.screenshot({ path: join(SCREENS, 'app-home.png'), animations: 'disabled' });

  await q(page, '.ne-body').tap();
  await page.keyboard.type('Ring the garage about the tyres');
  await until(async () => /^Saved/.test(await q(page, '.scratch-title .ne-status').innerText()), 'saved by itself', 10000);
  await settled(page);
  const saved = live(phone, SCRATCH);
  assert.equal(saved.length, 1, 'one note, under the fixed id');
  assert.equal(saved[0].text, 'Ring the garage about the tyres');
  assert.equal(saved[0].subject, 'Scratchpad');
  assert.deepEqual(saved[0].labels, ['_Notes'], 'in no folder, and not in the Inbox');
  await until(async () => (await toggleText(page)) === 'All notes 6', 'counted');
  assert.deepEqual(await page.evaluate(() => window.__history), [], 'nothing on the history yet');
});

await r.step('the list: a folder - "All notes" too - shows it, with the scratchpad pinned on top', async () => {
  await pickFolder(page, 'All notes');
  assert.equal(await view(page), 'list');
  assert.equal(await visible(page, '.note-editor'), false, 'one pane at a time');
  assert.equal((await titles(page)).length, 5);
  assert.equal((await titles(page))[0], 'Ideas for the October newsletter');
  assert.match(await q(page, '.note-item').first().innerText(), /^Scratchpad[\s\S]*Ring the garage/, 'pinned first');
  assert.deepEqual(await page.evaluate(() => window.__history), [{ depth: 1 }], 'on the history, for the back gesture');
  await page.screenshot({ path: join(SCREENS, 'app-list.png'), animations: 'disabled' });
  // The back gesture: to the scratchpad.
  await page.evaluate(() => window.__historyHandler({ state: {} }));
  await until(async () => (await view(page)) === 'home', 'home again');
  // And tapping the pinned scratchpad does the same.
  await pickFolder(page, 'All notes');
  await q(page, '.scratch-item').tap();
  assert.equal(await view(page), 'home');
  await pickFolder(page, 'All notes');
});

await r.step('the folder tree: nested as on a computer, with counts and a ⋯ menu; picking one folds it away', async () => {
  await q(page, '[data-key="folders-toggle"]').tap();
  assert.equal(await q(page, '[data-key="folders-toggle"]').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await q(page, '.folder-row .folder-title').allInnerTexts(), ['All notes', 'Empty', 'Personal', 'Work', 'Clients']);
  const depth = await q(page, '.folder-row').evaluateAll(rows => rows.map(r => getComputedStyle(r).getPropertyValue('--depth').trim()));
  assert.deepEqual(depth, ['0', '0', '0', '0', '1'], 'Clients sits inside Work');
  const indent = await q(page, '.folder-row').evaluateAll(rows => rows.map(r => parseFloat(getComputedStyle(r).paddingLeft)));
  assert.ok(indent[4] > indent[3], 'and is drawn indented');
  assert.equal(await visible(page, '[data-key^="folder-menu:"]'), true, 'the ⋯ menu shows without hovering');
  await page.screenshot({ path: join(SCREENS, 'app-folders.png'), animations: 'disabled' });
  await q(page, '.folder-btn').filter({ has: page.locator('.folder-title').filter({ hasText: /^Clients$/ }) }).tap();
  assert.equal(await visible(page, '.folder-items'), false, 'folded away again');
  assert.equal(await toggleText(page), 'Work › Clients 1');
  assert.deepEqual(await titles(page), ['Kestrel glossary decisions']);
  await pickFolder(page, 'All notes');
  assert.equal(await visible(page, '.folder-items'), false);
  assert.equal((await titles(page)).length, 5);
});

await r.step('a folder with subfolders folds them away with its arrow, and the phone remembers it', async () => {
  const folderBtn = (p, name) => q(p, '.folder-btn').filter({ has: p.locator('.folder-title').filter({ hasText: new RegExp(`^${name}$`) }) });
  const workId = await q(page, '.folder-row').filter({ has: page.locator('.folder-title').filter({ hasText: /^Work$/ }) }).getAttribute('data-folder');
  const twisty = p => q(p, `[data-key="folder-twisty:${workId}"]`);
  await q(page, '[data-key="folders-toggle"]').tap();
  assert.equal(await q(page, 'button.folder-twisty').count(), 1, 'only Work has subfolders');
  const box = await twisty(page).boundingBox();
  assert.ok(box.width >= 34 && box.height >= 44, `big enough for a thumb (${box.width}×${box.height})`);
  await twisty(page).tap();
  assert.deepEqual(await q(page, '.folder-row .folder-title').allInnerTexts(), ['All notes', 'Empty', 'Personal', 'Work']);
  assert.equal(await visible(page, '.folder-items'), true, 'folding a folder leaves the tree open');
  await page.screenshot({ path: join(SCREENS, 'app-folders-folded.png'), animations: 'disabled' });

  // Opened again later: still folded.
  await page.reload();
  await scratchReady(page);
  await q(page, '[data-key="folders-toggle"]').tap();
  assert.deepEqual(await q(page, '.folder-row .folder-title').allInnerTexts(), ['All notes', 'Empty', 'Personal', 'Work'], 'remembered');
  assert.equal(await twisty(page).getAttribute('aria-expanded'), 'false');
  await twisty(page).tap();
  assert.ok((await q(page, '.folder-row .folder-title').allInnerTexts()).includes('Clients'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('supermail.foldedFolders'))), []);
  await folderBtn(page, 'All notes').tap();
  assert.equal(await visible(page, '.folder-items'), false);
});

await r.step('tapping a note opens it full-screen; Back returns to the list', async () => {
  await q(page, '.note-item', ).filter({ hasText: 'Launch checklist' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  await until(async () => (await q(page, '.ne-title').inputValue()) === 'Launch checklist', 'title in');
  assert.equal(await visible(page, '.notes-list'), false);
  assert.equal(await visible(page, '.bar'), false, 'the note has the whole screen');
  assert.equal(await visible(page, '[data-key="note-back"]'), true);
  assert.equal(await q(page, '.ne-body .blk[data-type="check"][data-checked="1"]').count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__history), [{ depth: 1 }, { depth: 2 }], 'on the history, for the back gesture');
  await page.screenshot({ path: join(SCREENS, 'app-note.png'), animations: 'disabled' });
  await q(page, '[data-key="note-back"]').tap();
  await q(page, '.notes-list').waitFor();
  assert.equal(await view(page), 'list', 'back to the list it was opened from');
  assert.equal(await visible(page, '.note-editor'), false);
});

await r.step('editing: typing and formatting save by themselves, as a new version', async () => {
  await q(page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  const before = live(phone, 'launchchecklist0004')[0].id;
  await q(page, '.ne-body .blk').last().tap();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await q(page, '[data-key="fmt-bold"]').tap();
  await page.keyboard.type('Typed on the phone');
  await until(async () => /^Saved/.test(await q(page, '.ne-status').innerText()), 'saved by itself', 10000);
  await settled(page);
  const [now] = live(phone, 'launchchecklist0004');
  assert.notEqual(now.id, before);
  assert.match(phone.fake.box.messageHtml(now.id), /<b>Typed on the phone<\/b>/);
  assert.match(phone.fake.box.messageHtml(now.id), /<a href="https:\/\/example\.com\/portal">the portal<\/a>/, 'the rest kept');
  assert.ok(plain(phone.fake.box.messageLabelNames(before)).includes('TRASH'));
});

await r.step('no Contents on a phone: no room beside the text for the headings', async () => {
  assert.equal(await q(page, '[data-key="fmt-bold"]').first().isVisible(), true, 'the toolbar is there');
  assert.equal(await q(page, '[data-key="fmt-contents"]').first().isVisible(), false);
  assert.equal(await q(page, '[data-key="note-contents"]').first().isVisible(), false);
});

await r.step('a long note opened from the list stops at the foot of the screen, and a finger scrolls it', async () => {
  const d = await openApp();
  await scratchReady(d.page);
  await q(d.page, '[data-key="folders-toggle"]').tap();
  await q(d.page, '[data-key="folder:all"]').tap();
  await q(d.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  const body = q(d.page, '.notes[data-view="note"] .ne-body');
  await body.locator('.blk').first().waitFor();
  await body.locator('.blk').last().tap();
  await d.page.keyboard.press('End');
  for (let i = 1; i <= 60; i++) {
    await d.page.keyboard.press('Enter');
    await d.page.keyboard.insertText(`Line ${i} of a long note`);
  }
  await body.evaluate(e => { e.blur(); e.scrollTop = 0; });
  const size = await body.evaluate(e => ({ shown: e.clientHeight, all: e.scrollHeight, foot: e.getBoundingClientRect().bottom }));
  assert.ok(size.all > size.shown * 1.5, `longer than the screen: ${JSON.stringify(size)}`);
  assert.ok(size.foot <= d.page.viewportSize().height + 1, `its text box ends at the screen’s foot, not below it: ${JSON.stringify(size)}`);
  // A finger's swipe up, as Android sends it.
  const cdp = await d.page.context().newCDPSession(d.page);
  const box = await body.boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height * 0.7);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 30 * i }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(async () => (await body.evaluate(e => e.scrollTop)) > 100, 'scrolled down');
  await d.page.close();
});

await r.step('ticking a box by tapping it; the back gesture saves and closes', async () => {
  const box = q(page, '.ne-body .blk[data-type="check"]').filter({ hasText: 'Send the invoice' });
  const at = await box.boundingBox();
  await page.touchscreen.tap(at.x + 10, at.y + at.height / 2);
  assert.equal(await box.getAttribute('data-checked'), '1');
  // The gesture lands on the list's entry.
  await page.evaluate(() => window.__historyHandler({ state: { depth: 1 } }));
  await until(async () => (await view(page)) === 'list', 'back on the list');
  await settled(page);
  assert.match(live(phone, 'launchchecklist0004')[0].text, /☑ Send the invoice/, 'saved on the way out, without waiting');
});

await r.step('search marks the words in the results, and in the note with a find bar', async () => {
  await q(page, '[data-key="notes-search"]').fill('kestrel');
  await until(async () => (await titles(page)).length === 2, 'two results');
  await until(async () => (await q(page, '.ni-excerpt mark').count()) > 0, 'excerpts marked');
  assert.deepEqual(await q(page, '.ni-hits').allInnerTexts(), ['1 match', '1 match']);
  await page.screenshot({ path: join(SCREENS, 'app-search.png'), animations: 'disabled' });
  await q(page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(page, '.ne-find').waitFor();
  assert.match(await q(page, '.ne-find').innerText(), /1 of 1/);
  await q(page, '[data-key="note-back"]').tap();
  await q(page, '[data-key="notes-search"]').fill('');
  await until(async () => (await titles(page)).length === 5, 'all notes again');
});

await r.step('a new note in the folder being looked at', async () => {
  await pickFolder(page, 'Work');
  assert.deepEqual(await titles(page), ['Ideas for the October newsletter']);
  await q(page, '[data-key="note-new"]').tap();
  await q(page, '[data-key="note-title"]').fill('Written on the train');
  await q(page, '[data-key="note-title"]').press('Enter');
  await page.keyboard.type('- milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('eggs');
  await q(page, '[data-key="note-back"]').tap();
  await q(page, '.notes-list').waitFor();
  await settled(page);
  const id = phone.fake.box.findMessageBySubject('Written on the train');
  assert.ok(id, 'saved');
  assert.deepEqual(plain(phone.fake.box.messageLabelNames(id)), ['_Notes', '_Notes/Work']);
  assert.equal(phone.fake.box.messageText(id), '• milk\n• eggs');
  assert.deepEqual(await titles(page), ['Written on the train', 'Ideas for the October newsletter']);
});

await r.step('a note opened from the scratchpad goes back to it; another phone finds the same scratchpad', async () => {
  await page.evaluate(() => window.__historyHandler({ state: {} }));
  await until(async () => (await view(page)) === 'home', 'home');
  assert.equal(await q(page, '[data-key="notes-search"]').inputValue(), '', 'the search cleared');
  await q(page, '[data-key="note-new"]').tap();
  assert.equal(await view(page), 'note');
  await page.evaluate(() => window.__historyHandler({ state: {} }));
  await until(async () => (await view(page)) === 'home', 'straight back to the scratchpad');
  await scratchReady(page);
  assert.match(await q(page, '.note-editor.scratch .ne-body').innerText(), /Ring the garage/);

  const other = await openApp({ phone });
  await scratchReady(other.page);
  assert.match(await q(other.page, '.ne-body').innerText(), /Ring the garage about the tyres/, 'the same note');
  await q(other.page, '.ne-body').tap();
  await other.page.keyboard.press('End');
  await other.page.keyboard.type(', and the MOT');
  await until(async () => /^Saved/.test(await q(other.page, '.scratch-title .ne-status').innerText()), 'saved', 10000);
  await settled(other.page);
  assert.equal(live(phone, SCRATCH).length, 1, 'still one scratchpad, its old version in Trash');
  assert.equal(live(phone, SCRATCH)[0].text, 'Ring the garage about the tyres, and the MOT');
  await other.page.context().close();
});

await r.step('switching away from the app saves at once', async () => {
  await pickFolder(page, 'All notes');
  await q(page, '.note-item').filter({ hasText: 'Written on the train' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  await q(page, '.ne-body .blk').last().tap();
  await page.keyboard.press('End');
  await page.keyboard.type(' and bread');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settled(page);
  await until(async () => /bread/.test(phone.fake.box.messageText(phone.fake.box.findMessageBySubject('Written on the train'))), 'saved on hide', 3000);
});

await r.step('a table on the phone: from the toolbar, filled cell by cell with Tab, sideways when wide, saved as a table', async () => {
  const t = await openApp();
  await scratchReady(t.page);
  await q(t.page, '[data-key="note-new"]').tap();
  await q(t.page, '[data-key="note-title"]').fill('Quote for Ingrid');
  await q(t.page, '[data-key="note-title"]').press('Enter');
  await t.page.keyboard.type('Quote:');
  await t.page.keyboard.press('Enter');
  await q(t.page, '[data-key="fmt-table"]').scrollIntoViewIfNeeded();
  await q(t.page, '[data-key="fmt-table"]').tap();
  await q(t.page, '.ne-tablebar').waitFor();
  for (const k of ['Language pair', 'Tab', 'Words', 'Tab', 'Rate', 'Tab', 'Dutch to English', 'Tab', '14,200', 'Tab', '0,09',
    'Tab', 'German to English', 'Tab', '3,500', 'Tab', 'Rechtsschutzversicherungsgesellschaften']) {
    if (k === 'Tab') await t.page.keyboard.press(k);
    else await t.page.keyboard.type(k);
  }
  const sizes = await q(t.page, '.ne-body .blk[data-type="table"]').evaluate(el => [el.scrollWidth, el.clientWidth]);
  assert.ok(sizes[0] > sizes[1], `a long word makes it scroll sideways, not squeeze: ${sizes}`);
  await t.page.screenshot({ path: join(SCREENS, 'app-table.png'), animations: 'disabled' });
  await until(async () => /^Saved/.test(await q(t.page, '.ne-status').first().innerText()), 'saved', 10000);
  await settled(t.page);
  const box = t.phone.fake.box;
  assert.match(box.messageText(box.findMessageBySubject('Quote for Ingrid')),
    /Quote:\nLanguage pair \| Words \| Rate\nDutch to English \| 14,200 \| 0,09\nGerman to English \| 3,500 \| Rechtsschutzversicherungsgesellschaften/);
  await t.page.context().close();
});

// ── Opening fast: the phone's own copy ──

// One phone, kept between visits (its browser storage stays), on the same
// mailbox. `hold`: the script answers nothing until let go, as Apps Script
// taking its time. `saves: false`: saves never get through, as a page the
// phone closes before they could.
async function visit(ctx, { hold = false, saves = true } = {}) {
  const p = await ctx.newPage();
  watchErrors(p, errors);
  const at = new Phone({ fake: phone.fake });
  let release;
  const gate = new Promise(res => { release = res; });
  if (!hold) release();
  const calls = [];
  await p.exposeFunction('__gas', async (fn, args) => {
    calls.push(fn);
    if (fn === 'appSave' && !saves) await new Promise(() => {});
    await gate;
    return at.server(fn, ...args);
  });
  await p.addInitScript(installGoogle);
  await p.goto(pathToFileURL(PAGE).href);
  return { page: p, release, calls };
}
const phoneContext = () => browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const scratchText = p => q(p, '.note-editor.scratch .ne-body').innerText();
const savedScratch = p => until(async () => /^Saved/.test(await q(p, '.scratch-title .ne-status').innerText()), 'saved', 10000);
const keep = await phoneContext();

await r.step('a first visit asks the script once, not four times, before the scratchpad can be typed in', async () => {
  const v = await visit(keep);
  await scratchReady(v.page);
  assert.equal(v.calls[0], 'appStart');
  for (const fn of ['appAccount', 'appPrefsGet', 'appBoardColumns']) assert.equal(v.calls.includes(fn), false, fn);
  await settled(v.page);
  await v.page.close();
});

await r.step('the next visit opens on the phone’s copy at once, typing and all, before the script has answered', async () => {
  const v = await visit(keep, { hold: true });
  await scratchReady(v.page);
  assert.match(await scratchText(v.page), /Ring the garage about the tyres, and the MOT/);
  assert.equal(await v.page.locator('#boot').count(), 0, 'no loading line');
  assert.ok(v.calls.includes('appStart'), 'the check is under way');
  // The tab, the columns and the settings came from the copy too.
  for (const fn of ['appAccount', 'appPrefsGet', 'appBoardColumns']) assert.equal(v.calls.includes(fn), false, fn);
  v.release();
  await settled(v.page);
  assert.equal(v.calls.includes('appBody'), false, 'still current: the text did not have to come again');
  // The timings are under Advanced in the logo's menu, not shown to everyone.
  await q(v.page, '[data-key="about"]').tap();
  assert.match(await q(v.page, '.menu').innerText(), /MemDesk \d+\.\d+\.\d+[\s\S]*memdesk\.app[\s\S]*Privacy[\s\S]*Advanced: startup timings/);
  assert.equal(await q(v.page, '.toast').count(), 0, 'nothing shown yet');
  await q(v.page, '[data-key="about:timings"]').tap();
  await until(async () => /Opened in \d+\.\d s: .*ready to type \d+\.\d s, checked with Gmail \d+\.\d s/.test(await q(v.page, '.toast').innerText()), 'the timing, under Advanced');
  await v.page.close();
});

await r.step('changed on another device while this phone was away, and typed into before it heard: both kept', async () => {
  const desk = await openApp({ phone });
  await scratchReady(desk.page);
  await q(desk.page, '.ne-body').tap();
  await desk.page.keyboard.press('Control+End');
  await desk.page.keyboard.type(', and the oil');
  await savedScratch(desk.page);
  await settled(desk.page);
  await desk.page.context().close();

  const v = await visit(keep, { hold: true });
  await scratchReady(v.page);
  assert.doesNotMatch(await scratchText(v.page), /the oil/, 'the copy is older');
  await q(v.page, '.ne-body').tap();
  await v.page.keyboard.press('Control+Home');
  await v.page.keyboard.type('Buy stamps');
  await v.page.keyboard.press('Enter');
  v.release();
  await until(async () => /Buy stamps\s+Ring the garage about the tyres, and the MOT, and the oil/.test(await scratchText(v.page)), 'merged on screen');
  await until(async () => /both changes are kept/.test(await q(v.page, '.toast').innerText()), 'and said so');
  // The cursor stayed where it was: typing carries on in place.
  await v.page.keyboard.type('Then ');
  await savedScratch(v.page);
  await settled(v.page);
  assert.equal(live(phone, SCRATCH).length, 1, 'one scratchpad');
  assert.equal(live(phone, SCRATCH)[0].text, 'Buy stamps\nThen Ring the garage about the tyres, and the MOT, and the oil');
  await v.page.close();
});

await r.step('text typed and not yet saved survives the phone closing the page', async () => {
  const v = await visit(keep, { saves: false });
  await scratchReady(v.page);
  await q(v.page, '.ne-body').tap();
  await v.page.keyboard.press('Control+End');
  await v.page.keyboard.type(' - and post the parcel');
  await v.page.waitForTimeout(500);
  await v.page.close();
  assert.doesNotMatch(live(phone, SCRATCH)[0].text, /parcel/, 'never reached Gmail');

  const w = await visit(keep, { hold: true });
  await scratchReady(w.page);
  assert.match(await scratchText(w.page), /and the oil - and post the parcel$/, 'there at once');
  w.release();
  await savedScratch(w.page);
  await settled(w.page);
  assert.match(live(phone, SCRATCH)[0].text, /and the oil - and post the parcel$/, 'and saved');
  assert.equal(live(phone, SCRATCH).length, 1);
  await w.page.close();
});

await r.step('a save that would overwrite a newer version from another phone merges with it instead', async () => {
  const a = await openApp({ phone });
  const b = await openApp({ phone });
  await scratchReady(a.page);
  await scratchReady(b.page);
  await q(a.page, '.ne-body').tap();
  await a.page.keyboard.press('Control+End');
  await a.page.keyboard.press('Enter');
  await a.page.keyboard.type('From phone A');
  await savedScratch(a.page);
  await settled(a.page);
  // B still has the version before A's, and saves on top of it.
  await q(b.page, '.ne-body').tap();
  await b.page.keyboard.press('Control+Home');
  await b.page.keyboard.type('From phone B');
  await b.page.keyboard.press('Enter');
  await until(async () => /^From phone B[\s\S]*From phone A$/.test(await scratchText(b.page)), 'merged on B');
  await savedScratch(b.page);
  await settled(b.page);
  assert.equal(live(phone, SCRATCH).length, 1);
  assert.match(live(phone, SCRATCH)[0].text, /^From phone B\n[\s\S]*\nFrom phone A$/);
  await a.page.context().close();
  await b.page.context().close();
  await keep.close();
});

// ── The board ──

const column = (p, title) => q(p, 'section.column').filter({ has: p.locator('.col-title').filter({ hasText: new RegExp(`^${title}$`) }) });
const cardTitles = (p, title) => column(p, title).locator('.card .subject').allInnerTexts();
const boardLabels = id => plain(phone.fake.box.threadLabelNames(id)).filter(n => n.startsWith('_Board'));

await r.step('the board tab: the _Board labels as columns, one to a screen, swiped sideways', async () => {
  // A note has the whole screen, tabs and all: back to the Scratchpad first.
  await page.evaluate(() => window.__historyHandler({ state: {} }));
  await until(async () => (await view(page)) === 'home', 'home');
  await q(page, '[data-key="view:board"]').tap();
  await q(page, '.card .subject').first().waitFor(); // real cards, not the placeholders shown while loading
  assert.deepEqual((await q(page, '.col-head .col-title').allInnerTexts()), ['To do', 'Doing', 'Waiting', 'Done']);
  assert.equal((await cardTitles(page, 'To do')).length, 6);
  assert.ok((await cardTitles(page, 'Doing')).includes('Termbase export won’t open'));
  const width = (await column(page, 'To do').boundingBox()).width;
  assert.ok(Math.abs(width - (412 - 44)) < 2, `a column is a screen wide (${width})`);
  assert.match(await q(page, '.columns').evaluate(el => getComputedStyle(el).scrollSnapType), /x/);
  assert.equal(await visible(page, '[data-key="view:notes"]'), true, 'the tabs, to get back to the notes');
  assert.equal(await visible(page, '.account'), false, 'no room for the address on a phone');
  await page.screenshot({ path: join(SCREENS, 'app-board.png'), animations: 'disabled' });
});

await r.step('a card moves with its ⋯ menu, and Gmail’s labels follow', async () => {
  const id = phone.fake.box.findThread('Termbase export');
  assert.deepEqual(boardLabels(id), ['_Board/Doing']);
  await q(page, `[data-key="menu:${id}"]`).tap();
  const waiting = await column(page, 'Waiting').getAttribute('data-col');
  await q(page, `.menu [data-key="move:${waiting}"]`).tap();
  await until(async () => (await cardTitles(page, 'Waiting')).includes('Termbase export won’t open'), 'moved on screen');
  await until(async () => JSON.stringify(boardLabels(id)) === '["_Board/Waiting"]', 'and in Gmail');
  assert.ok(!(await cardTitles(page, 'Doing')).includes('Termbase export won’t open'));
});

await r.step('an email goes on the board from a column’s + search', async () => {
  const todo = await column(page, 'To do').getAttribute('data-col');
  await q(page, `[data-key="add:${todo}"]`).tap();
  await q(page, `[data-key="search:${todo}"]`).fill('NDA');
  await q(page, `[data-key="search:${todo}"]`).press('Enter');
  const id = phone.fake.box.findThread('3,000-word NDA');
  await q(page, `[data-key="result:${id}"]`).tap();
  await until(async () => (await cardTitles(page, 'To do')).includes('Can you take a 3,000-word NDA this week?'), 'added');
  await until(async () => JSON.stringify(boardLabels(id)) === '["_Board/To do"]', 'labelled in Gmail');
});

await r.step('a card’s own title is kept by the script, for every phone and computer the app is opened on', async () => {
  const id = phone.fake.box.findThread('Termbase export');
  await q(page, `[data-key="menu:${id}"]`).tap();
  await q(page, '.menu [data-key="edit"]').tap();
  await q(page, '[data-key="edit-title"]').fill('Call Hendrik about the .tbx');
  await q(page, '[data-key="edit-save"]').tap();
  await until(async () => (await cardTitles(page, 'Waiting')).includes('Call Hendrik about the .tbx'), 'renamed');
  await settled(page);
  assert.deepEqual(JSON.parse(phone.fake.userProperties.get(`gkb.card:test@example.com:${id}`)).title, 'Call Hendrik about the .tbx');

  const other = await openApp({ phone });
  await scratchReady(other.page);
  await q(other.page, '[data-key="view:board"]').tap();
  await until(async () => (await cardTitles(other.page, 'Waiting')).includes('Call Hendrik about the .tbx'), 'on the other phone too');
  await other.page.context().close();
});

await r.step('the columns are Gmail’s layout, as in the extension: a column made there shows here; one saved here is saved there', async () => {
  const { phone: p2, page: pg } = await openApp();
  const root = plain(p2.fake.box.labelByName('_Board')).id;
  const msg = id => p2.fake.box.allMessages().find(m => m.id === id);
  // The extension saves its layout: To invoice added, Done renamed.
  const first = p2.server('appSaveLayout', root, [
    { id: 'todo', title: 'To do', label: '_Board/To do', archiveOnDrop: false, chime: false },
    { id: 'doing', title: 'Doing', label: '_Board/Doing', archiveOnDrop: false, chime: false },
    { id: 'inv', title: 'To invoice', label: '_Board/To invoice', archiveOnDrop: false, chime: false },
    { id: 'done', title: 'Finished', label: '_Board/Done', archiveOnDrop: true, chime: true },
  ], []);
  await scratchReady(pg);
  await q(pg, '[data-key="view:board"]').tap();
  const heads = () => q(pg, '.col-head .col-title').allInnerTexts();
  await until(async () => JSON.stringify(await heads()) === JSON.stringify(['To do', 'Doing', 'To invoice', 'Finished']), 'Gmail’s columns, not the labels’', 8000);
  await until(() => !!p2.fake.box.labelByName('_Board/To invoice'), 'its label made in Gmail', 8000);

  // Saved here: a new version in Gmail, the old one in Trash.
  await q(pg, '[data-key="settings"]').tap();
  await q(pg, '[data-key="title:2"]').fill('Invoicing');
  await q(pg, '[data-key="save"]').tap();
  await until(async () => (await heads()).includes('Invoicing'), 'renamed here', 8000);
  await settled(pg);
  assert.deepEqual(plain(p2.server('appLayout', root, '').columns).map(c => c.title), ['To do', 'Doing', 'Invoicing', 'Finished'], 'and in Gmail');
  assert.ok(msg(first.id).labelIds.includes('TRASH'), 'the old one in Trash');
  await pg.context().close();
});

await r.step('tapping a card opens the conversation in Gmail; the app remembers the board tab', async () => {
  await page.evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(url); return null; }; });
  const id = phone.fake.box.findThread('3,000-word NDA');
  await q(page, `[data-key="card:${id}"]`).tap();
  assert.deepEqual(await page.evaluate(() => window.__opened), [`https://mail.google.com/mail/?authuser=test%40example.com#all/${id}`]);
  await page.reload();
  await q(page, '.card .subject').first().waitFor();
  assert.equal(await q(page, '[data-key="view:board"]').getAttribute('aria-selected'), 'true');
  await q(page, '[data-key="view:notes"]').tap();
  await scratchReady(page);
});

// A finger dragged sideways across the calendar's days.
async function swipe(p, dx) {
  await p.evaluate(d => {
    const main = document.querySelector('#gkb-app-host').shadowRoot.querySelector('.cal-main');
    const box = main.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + 120;
    const at = cx => new Touch({ identifier: 1, target: main, clientX: cx, clientY: y });
    main.dispatchEvent(new TouchEvent('touchstart', { touches: [at(x)], changedTouches: [at(x)], bubbles: true }));
    main.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [at(x + d)], bubbles: true }));
  }, dx);
}
const calTitle = p => q(p, '.cal-title').innerText();
const weekText = p => q(p, '.cal-week').innerText();

await r.step('the calendar tab: the week as two columns of days, the month as the eighth tile', async () => {
  await q(page, '[data-key="view:calendar"]').tap();
  await q(page, '.cal .ev').first().waitFor();
  assert.equal(await q(page, '.cal').getAttribute('data-narrow'), 'true');
  assert.match(await calTitle(page), /^W\d+ \d+( [A-Z][a-z]{2})? – \d+ [A-Z][a-z]{2}/, 'the week’s number, short, and its days');
  assert.equal(await q(page, '.cal-title').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, 'all of it, on a phone');
  assert.equal(await q(page, '.today-num').innerText(), String(new Date().getDate()), 'Today: a calendar with today’s date in it');
  assert.equal(await q(page, '[data-key="cal-today"]').getAttribute('aria-label'), 'Today');
  assert.equal(await visible(page, '.cal-views'), false, 'the computer’s views are not the phone’s');
  const days = q(page, '.cal-week > .day:not(.mini-tile)');
  assert.equal(await days.count(), 7);
  const [mon, tue, fri] = await Promise.all([0, 1, 4].map(i => days.nth(i).boundingBox()));
  assert.ok(tue.y > mon.y && Math.abs(tue.x - mon.x) < 2, 'Tuesday under Monday');
  assert.ok(Math.abs(fri.y - mon.y) < 2 && fri.x > mon.x, 'Friday beside Monday');
  assert.equal(await visible(page, '.mini-tile'), true);
  const text = await weekText(page);
  for (const t of ['Lumenra glossary delivery', 'Quote for Ingrid', 'Grandma’s birthday']) assert.ok(text.includes(t), t);
  assert.ok(!text.includes('Working from home'));
  assert.match(await q(page, '.cal-tray').innerText(), /Renew the guild membership/);
  // Three tabs and the refresh button fit the bar.
  const refresh = await q(page, '.bar [aria-label="Refresh"]').boundingBox();
  assert.ok(refresh.x + refresh.width <= 412, 'the bar fits the screen');
  // Only reads went to the script's Google, all of them allowed ones.
  const reads = phone.log.filter(l => l.service);
  assert.ok(reads.length >= 6 && reads.every(l => l.method === 'GET'));
  await page.screenshot({ path: join(SCREENS, 'app-calendar.png'), animations: 'disabled' });
});

await r.step('a chip hides a calendar, the phone remembers it; a swipe goes to the next week, Today back', async () => {
  await q(page, '.src').filter({ hasText: 'Family' }).tap();
  await until(async () => !(await weekText(page)).includes('Pub quiz'), 'Family hidden');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('supermail.calendarSources'))['c_family@group.calendar.google.com']), false);
  const thisWeek = await calTitle(page);
  await swipe(page, -160);
  await until(async () => (await weekText(page)).includes('Planning call with Grace'), 'the next week');
  assert.notEqual(await calTitle(page), thisWeek);
  await swipe(page, 20); // too short to count
  await swipe(page, 160);
  await until(async () => (await calTitle(page)) === thisWeek, 'and back');
  await swipe(page, -160);
  await until(async () => (await calTitle(page)) !== thisWeek, 'on again');
  await q(page, '[data-key="cal-today"]').tap();
  await until(async () => (await calTitle(page)) === thisWeek, 'Today');
  await q(page, '.src').filter({ hasText: 'Family' }).tap();
  await until(async () => (await weekText(page)).includes('Pub quiz'), 'Family back');
  await q(page, '[data-key="view:notes"]').tap();
  await scratchReady(page);
});

await r.step('the days can run across, then down, instead; the phone remembers', async () => {
  await q(page, '[data-key="view:calendar"]').tap();
  await q(page, '.cal .ev').first().waitFor();
  const days = q(page, '.cal-week > .day:not(.mini-tile)');
  const box = i => days.nth(i).boundingBox();
  const btn = q(page, '[data-key="cal-order"]');
  const b = await btn.boundingBox();
  assert.ok(b && b.x + b.width <= 412, 'the button fits the header');
  assert.match(await btn.getAttribute('title'), /down, then across\. Tap for across/);
  await btn.tap();
  await until(async () => (await q(page, '.cal').getAttribute('data-order')) === 'across', 'across');
  const [mon, tue, wed] = [await box(0), await box(1), await box(2)];
  assert.ok(Math.abs(tue.y - mon.y) < 2 && tue.x > mon.x, 'Tuesday beside Monday');
  assert.ok(wed.y > mon.y && Math.abs(wed.x - mon.x) < 2, 'Wednesday under Monday');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('supermail.calendarOrder'))), 'across');
  await page.screenshot({ path: join(SCREENS, 'app-calendar-across.png'), animations: 'disabled' });
  await page.reload();
  await scratchReady(page).catch(() => {});
  await q(page, '[data-key="view:calendar"]').tap();
  await q(page, '.cal .ev').first().waitFor();
  assert.equal(await q(page, '.cal').getAttribute('data-order'), 'across', 'kept after a reload');
  await q(page, '[data-key="cal-order"]').tap();
  await until(async () => (await q(page, '.cal').getAttribute('data-order')) === 'down', 'down again');
  await q(page, '[data-key="view:notes"]').tap();
  await scratchReady(page);
});

await r.step('the month: a grid of days with what is on them; a swipe for the next; a tap on a day opens its week; remembered', async () => {
  await q(page, '[data-key="view:calendar"]').tap();
  await q(page, '.cal .ev').first().waitFor();
  const toggle = q(page, '[data-key="cal-phone-view"]');
  const b = await toggle.boundingBox();
  assert.ok(b && b.x + b.width <= 412, 'the button fits the header');
  await toggle.tap();
  await q(page, '.phone-month').waitFor();
  const grid = await q(page, '.phone-month .month-grid').boundingBox();
  assert.ok(grid.x >= 0 && grid.x + grid.width <= 412, 'the whole month across the screen');
  const title = await calTitle(page);
  assert.match(title, /^[A-Z][a-z]+ \d{4}$/);
  assert.match(await q(page, '.phone-month').innerText(), /Lumenra glossary delivery/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('supermail.calendarPhoneView'))), 'month');
  await page.screenshot({ path: join(SCREENS, 'app-calendar-month.png'), animations: 'disabled' });
  await swipe(page, -160);
  await until(async () => (await calTitle(page)) !== title, 'the next month');
  await swipe(page, 160);
  await until(async () => (await calTitle(page)) === title, 'and back');
  await page.reload();
  await scratchReady(page).catch(() => {});
  await q(page, '[data-key="view:calendar"]').tap();
  await q(page, '.phone-month').waitFor();
  const today = q(page, '.phone-month .mcell.today');
  await today.tap();
  await q(page, '.cal-week .day.today').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('supermail.calendarPhoneView'))), 'week');
  await q(page, '[data-key="view:notes"]').tap();
  await scratchReady(page);
});

await r.step('not allowed yet: one line, an Allow button to Google’s page, and the week once it is allowed', async () => {
  const d = await openApp();
  await scratchReady(d.page);
  d.phone.fake.denied.add('https://www.googleapis.com/auth/calendar.readonly');
  d.phone.fake.denied.add('https://www.googleapis.com/auth/tasks');
  await d.page.context().route('https://script.google.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Allowed</p>' }));
  await q(d.page, '[data-key="view:calendar"]').tap();
  const note = q(d.page, '.cal-note');
  await until(async () => /Google Calendar and Google Tasks need your permission/.test(await note.innerText()), 'the note');
  const allow = q(d.page, '[data-key="cal-allow"]');
  assert.equal(await allow.getAttribute('href'), AUTHORIZE_URL);
  assert.equal(await allow.getAttribute('target'), '_blank');
  const [popup] = await Promise.all([d.page.waitForEvent('popup'), allow.tap()]);
  await popup.close();
  // Allowed on Google's page; back in the app, it reads again by itself.
  d.phone.fake.denied.clear();
  await d.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await q(d.page, '.cal .ev').first().waitFor();
  assert.equal(await q(d.page, '.cal-note').isVisible(), false);
  await d.page.context().close();
});

await r.step('on the phone, too: a task’s box ticks it off and an event is changed, through the script', async () => {
  const d = await openApp();
  await scratchReady(d.page);
  await q(d.page, '[data-key="view:calendar"]').tap();
  await q(d.page, '.cal .ev').first().waitFor();
  const fake = d.phone.fake.calendar;
  await q(d.page, '.cal-week .task').filter({ hasText: 'Send invoice 2026-131' }).locator('button.box').tap();
  await until(async () => fake.tasks.find(t => t.title === 'Send invoice 2026-131').status === 'completed', 'ticked off in Google Tasks');
  const before = fake.events.find(e => e.summary === 'Lumenra glossary delivery').etag;
  await q(d.page, '.cal-week a.ev').filter({ hasText: 'Lumenra glossary delivery' }).tap();
  await q(d.page, '[data-key="cal-edit-title"]').fill('Lumenra glossary, final');
  await d.page.screenshot({ path: join(SCREENS, 'app-calendar-edit.png'), animations: 'disabled' });
  await q(d.page, '[data-key="cal-edit-save"]').tap();
  await until(async () => fake.events.some(e => e.summary === 'Lumenra glossary, final'), 'changed in Google Calendar');
  await until(async () => (await weekText(d.page)).includes('Lumenra glossary, final'), 'on screen');
  const changes = d.phone.log.filter(l => l.service && l.method !== 'GET');
  assert.deepEqual(changes.map(l => l.method), ['PATCH', 'PATCH']);
  assert.ok(changes.every(l => /^(lists|calendars)\//.test(l.path)), 'only a task and an event');
  assert.ok(fake.events.find(e => e.summary === 'Lumenra glossary, final').etag !== before);
  await d.page.context().close();
});

await r.step('nothing on the page but the app once it has started; a broken history does not stop it', async () => {
  assert.equal(await page.locator('#boot').count(), 0, 'the loading line is gone');
  const b = await openApp({ brokenHistory: true });
  await scratchReady(b.page);
  await pickFolder(b.page, 'All notes');
  await q(b.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(b.page, '.ne-body .blk').first().waitFor();
  await q(b.page, '[data-key="note-back"]').tap();
  await q(b.page, '.notes-list').waitFor();
  await b.page.context().close();
});

await r.step('delivered the rough way Apps Script may deliver it, it still starts and works', async () => {
  const rough = await openApp({ file: ROUGH });
  await scratchReady(rough.page);
  await pickFolder(rough.page, 'All notes');
  assert.equal((await titles(rough.page)).length, 5);
  await q(rough.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(rough.page, '.ne-body .blk').first().waitFor();
  assert.equal(await rough.page.locator('#boot').count(), 0);
  await rough.page.context().close();
});

await r.step('an error while starting is shown on the page, not a blank screen', async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true });
  const p = await ctx.newPage();
  await p.addInitScript(() => { Object.defineProperty(window, 'google', { get() { throw new Error('no google.script here'); } }); });
  await p.goto(pathToFileURL(PAGE).href);
  await until(async () => /could not start[\s\S]*no google\.script here/.test(await p.locator('#boot').innerText()), 'the error shown');
  await ctx.close();
});

await r.step('a part that fails to load is named on the page', async () => {
  const broken = appHtml().replace(/(\["addon\/app\/remote\.js",")[A-Za-z0-9_-]+"/, (_, head) => `${head}${Buffer.from('this is { not code').toString('base64url')}"`);
  const file = join(screensDir(), 'app-page-broken.html');
  writeFileSync(file, broken);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true });
  const p = await ctx.newPage();
  await p.addInitScript(installGoogle);
  await p.goto(pathToFileURL(file).href);
  await until(async () => /Parts that did not load: addon\/app\/remote\.js: Unexpected/.test(await p.locator('#boot').innerText()), 'the part named');
  await ctx.close();
});

await r.step('dark mode', async () => {
  const dark = await openApp({ colorScheme: 'dark' });
  await scratchReady(dark.page);
  await dark.page.screenshot({ path: join(SCREENS, 'app-home-dark.png'), animations: 'disabled' });
  await pickFolder(dark.page, 'All notes');
  await q(dark.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(dark.page, '.ne-body .blk').first().waitFor();
  await dark.page.screenshot({ path: join(SCREENS, 'app-note-dark.png'), animations: 'disabled' });
  await dark.page.context().close();
});

await r.step('the licence: free in preview; on sale, the trial in the logo’s menu; once it is over, the licence screen, until a key', async () => {
  const d = await openApp();
  await scratchReady(d.page);
  const menuText = async () => {
    await q(d.page, '[data-key="about"]').tap();
    const text = await q(d.page, '.menu').innerText();
    await d.page.keyboard.press('Escape');
    return text;
  };
  await until(async () => /Licence: free while in preview/.test(await menuText()), 'free in preview');

  d.phone.addon.gkb.LICENCE_STORE_ID = d.phone.fake.lemon.STORE;
  await d.page.reload();
  await scratchReady(d.page);
  await until(async () => /Licence: trial, 14 days left/.test(await menuText()), 'the trial, in the menu');
  assert.equal(await visible(d.page, '.licence-chip'), false, 'no room in the phone’s bar: the menu says it');

  const kept = JSON.parse(d.phone.fake.userProperties.get('licence'));
  d.phone.fake.userProperties.set('licence', JSON.stringify(Object.assign(kept, { trialStart: Date.now() - 15 * 86400000 })));
  await d.page.reload();
  await q(d.page, '.licence-panel').waitFor();
  assert.match(await q(d.page, '.licence-panel').innerText(), /Your free trial has ended/);
  assert.equal(await visible(d.page, '.note-editor.scratch'), false, 'not the Scratchpad');
  await d.page.screenshot({ path: join(SCREENS, 'app-licence-ended.png'), animations: 'disabled' });
  await q(d.page, '[data-key="licence-key"]').fill('MD-GOOD-0001');
  await q(d.page, '[data-key="licence-enter"]').tap();
  await scratchReady(d.page);
  const asked = d.phone.log.filter(l => l.service === 'lemon');
  assert.deepEqual(asked.map(l => l.path), ['validate', 'activate']);
  assert.match(asked[1].body.instance_name, /phone app/);
  await until(async () => /Licence: licensed/.test(await menuText()), 'licensed');
  await d.page.close();
});

await r.step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
const passed = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(passed ? 0 : 1);

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
const { Phone, plain } = require('../helpers/apps-script.js');

const { chromium } = await loadPlaywright();
const SCREENS = screensDir();
const errors = [];
const r = runner('app');

const PAGE = join(screensDir(), 'app-page.html');
writeFileSync(PAGE, appHtml());

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

async function openApp({ search = '', colorScheme = 'light', brokenHistory = false } = {}) {
  const phone = new Phone({ search });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme,
  });
  const page = await ctx.newPage();
  watchErrors(page, errors);
  await page.exposeFunction('__gas', (fn, args) => phone.server(fn, ...args));
  await page.addInitScript(installGoogle);
  if (brokenHistory) await page.addInitScript(breakHistory);
  await page.goto(pathToFileURL(PAGE).href);
  return { phone, page };
}

const host = '#gkb-app-host';
const q = (page, sel) => page.locator(`${host} >> ${sel}`);
const visible = (page, sel) => q(page, sel).first().isVisible();
const settled = page => until(async () => (await page.evaluate(() => window.__calls || 0)) === 0, 'server calls settled', 8000);
const titles = page => q(page, '.note-item .ni-title').allInnerTexts();
const live = (phone, noteId) => plain(phone.fake.box.notesWithId(noteId)).filter(n => !n.labels.includes('TRASH'));

const { phone, page } = await openApp();

await r.step('the list: every note, newest first, folders as chips', async () => {
  await q(page, '.note-item').first().waitFor();
  assert.deepEqual(await titles(page), [
    'Ideas for the October newsletter', 'Shopping list', 'Launch checklist', 'Kestrel glossary decisions', 'Rate schedule 2027 – draft',
  ]);
  assert.deepEqual(await q(page, '.folder-row .folder-title').allInnerTexts(), ['All notes', 'Empty', 'Personal', 'Work', 'Clients']);
  assert.equal(await visible(page, '.note-editor'), false, 'one pane at a time');
  const box = await q(page, '.folder-btn').first().boundingBox();
  assert.ok(box.height <= 36, 'chips, not rows');
  await page.screenshot({ path: join(SCREENS, 'app-list.png'), animations: 'disabled' });
});

await r.step('tapping a note opens it full-screen; Back returns to the list', async () => {
  await q(page, '.note-item', ).filter({ hasText: 'Launch checklist' }).tap();
  await q(page, '.ne-body .blk').first().waitFor();
  await until(async () => (await q(page, '.ne-title').inputValue()) === 'Launch checklist', 'title in');
  assert.equal(await visible(page, '.notes-list'), false);
  assert.equal(await visible(page, '.app-head'), false, 'the note has the whole screen');
  assert.equal(await visible(page, '[data-key="note-back"]'), true);
  assert.equal(await q(page, '.ne-body .blk[data-type="check"][data-checked="1"]').count(), 1);
  assert.deepEqual(await page.evaluate(() => window.__history), [{ note: 1 }], 'on the history, for the back gesture');
  await page.screenshot({ path: join(SCREENS, 'app-note.png'), animations: 'disabled' });
  await q(page, '[data-key="note-back"]').tap();
  await q(page, '.notes-list').waitFor();
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

await r.step('ticking a box by tapping it; the back gesture saves and closes', async () => {
  const box = q(page, '.ne-body .blk[data-type="check"]').filter({ hasText: 'Send the invoice' });
  const at = await box.boundingBox();
  await page.touchscreen.tap(at.x + 10, at.y + at.height / 2);
  assert.equal(await box.getAttribute('data-checked'), '1');
  await page.evaluate(() => window.__historyHandler({ state: {} }));
  await q(page, '.notes-list').waitFor();
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
  await q(page, '.folder-btn').filter({ hasText: /^Work/ }).tap();
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

await r.step('switching away from the app saves at once', async () => {
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

await r.step('nothing on the page but the app once it has started; a broken history does not stop it', async () => {
  assert.equal(await page.locator('#boot').count(), 0, 'the loading line is gone');
  const b = await openApp({ brokenHistory: true });
  await q(b.page, '.note-item').first().waitFor();
  await q(b.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(b.page, '.ne-body .blk').first().waitFor();
  await q(b.page, '[data-key="note-back"]').tap();
  await q(b.page, '.notes-list').waitFor();
  await b.page.context().close();
});

await r.step('an error while starting is shown on the page, not a blank screen', async () => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true });
  const p = await ctx.newPage();
  await p.addInitScript(() => { Object.defineProperty(window, 'google', { get() { throw new Error('no google.script here'); } }); });
  await p.goto(pathToFileURL(PAGE).href);
  await until(async () => /could not start: .*no google\.script here/.test(await p.locator('#boot').innerText()), 'the error shown');
  await ctx.close();
});

await r.step('dark mode', async () => {
  const dark = await openApp({ colorScheme: 'dark' });
  await q(dark.page, '.note-item').first().waitFor();
  await q(dark.page, '.note-item').filter({ hasText: 'Launch checklist' }).tap();
  await q(dark.page, '.ne-body .blk').first().waitFor();
  await dark.page.screenshot({ path: join(SCREENS, 'app-note-dark.png'), animations: 'disabled' });
  await dark.page.context().close();
});

await r.step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
const passed = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(passed ? 0 : 1);

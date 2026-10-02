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

await r.step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
const passed = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(passed ? 0 : 1);

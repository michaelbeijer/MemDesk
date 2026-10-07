#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Browser check (a): the real content scripts against the fake Gmail
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tests/e2e/preview.e2e.mjs
//
// Drives dev/preview.html the way a person would - open the board, drag
// cards, use the menus, search, edit columns, use the dock - and checks
// the fake mailbox's labels after each step, not just the DOM. The page
// enforces Trusted Types, so any innerHTML-style call fails it too.
// ─────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPO, loadPlaywright, findChromium, screensDir, runner, until, watchErrors } from './lib.mjs';

const { chromium } = await loadPlaywright();
const SCREENS = screensDir();
const PREVIEW = pathToFileURL(join(REPO, 'dev', 'preview.html')).href;
const errors = [];
const r = runner('preview');

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

async function openPage(query = '', { colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watchErrors(page, errors, query ? `[${query}] ` : '');
  await page.goto(PREVIEW + (query ? `?${query}` : ''));
  await page.locator('[data-action="toggle-board"]').waitFor();
  return page;
}

// ── Helpers that read state out of the page ──────────────────────────

const ids = (page, col) =>
  page.locator(`section[data-col="${col}"] .card`).evaluateAll(els => els.map(e => e.dataset.id));
const labelsOf = (page, id) => page.evaluate(i => window.__fakeGmail.threadLabelNames(i), id);
const findThread = (page, subject) => page.evaluate(s => window.__fakeGmail.findThread(s), subject);
const modifyCalls = page => page.evaluate(() => window.__mockChrome.log.filter(l => /\/modify$/.test(l.path || '')).length);
const overlayVisible = page => page.locator('.overlay').isVisible();

async function openBoard(page) {
  await page.locator('[data-action="toggle-board"]').click();
  await page.locator('.overlay').waitFor({ state: 'visible' });
  await page.locator('.card').first().waitFor();
}

async function drag(page, sourceId, targetLocator, position) {
  await page.locator(`.card[data-id="${sourceId}"]`).dragTo(targetLocator, position ? { targetPosition: position } : {});
}

async function waitForLabels(page, id, { has = [], lacks = [] }, what) {
  await until(async () => {
    const names = await labelsOf(page, id);
    return has.every(n => names.includes(n)) && lacks.every(n => !names.includes(n));
  }, what);
}

// ── The main run ─────────────────────────────────────────────────────

const page = await openPage();
let deadlineId;
let ifuOrder;

try {
  await r.step('the preview really enforces Trusted Types', async () => {
    // If this ever passed silently, every other step would prove nothing
    // about innerHTML-style calls.
    const before = errors.length;
    const threw = await page.evaluate(() => {
      try { document.createElement('div').innerHTML = '<b>x</b>'; return false; } catch { return true; }
    });
    assert.equal(threw, true);
    // Chrome also logs that deliberate violation; it is not a real error.
    await until(() => errors.length > before, 'Trusted Types violation logged');
    const own = errors.splice(before);
    assert.ok(own.every(e => /TrustedHTML/.test(e)), own.join('\n'));
  });

  await r.step('board opens from the dock with every column filled', async () => {
    await openBoard(page);
    assert.equal((await ids(page, 'todo')).length, 6);
    assert.equal((await ids(page, 'doing')).length, 3);
    assert.equal((await ids(page, 'waiting')).length, 2, 'the two-column thread is shown once');
    assert.equal((await ids(page, 'done')).length, 3);
    const dup = await findThread(page, 'Drawing labels');
    assert.ok((await ids(page, 'todo')).includes(dup), 'thread with two column labels sits in the left-most');
    assert.match(await page.locator('.brand').innerText(), /MemDesk/);
    assert.equal(await page.locator('.tab[aria-selected="true"]').innerText(), 'Board');
    assert.equal(await page.locator('.account').innerText(), 'test@example.com');
    // Entities decoded, not shown raw.
    const ingrid = await findThread(page, 'Quote request');
    const snippet = await page.locator(`.card[data-id="${ingrid}"] .snippet`).innerText();
    assert.ok(!/&\w+;|&#/.test(snippet), snippet);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SCREENS, 'board-light.png'), animations: 'disabled' });
  });

  await r.step('newest first, unread and starred styling, message count', async () => {
    const todo = await ids(page, 'todo');
    assert.equal(todo[0], await findThread(page, 'birth certificate'), 'newest thread on top');
    const olivia = page.locator(`.card[data-id="${todo[0]}"]`);
    assert.ok(await olivia.evaluate(e => e.classList.contains('unread')));
    assert.equal(await olivia.locator('.star').count(), 1);
    const ingrid = page.locator(`.card[data-id="${await findThread(page, 'Quote request')}"]`);
    assert.equal(await ingrid.locator('.count').innerText(), '3');
    assert.equal(await page.locator(`.card[data-id="${await findThread(page, 'Updated IFU')}"] .from`).innerText(), 'me');
  });

  await r.step('dragging a card to another column relabels the thread in Gmail', async () => {
    deadlineId = await findThread(page, 'Deadline moved');
    const before = await modifyCalls(page);
    await drag(page, deadlineId, page.locator('section[data-col="doing"] .card').first(), { x: 60, y: 6 });
    await page.locator(`section[data-col="doing"] .card[data-id="${deadlineId}"]`).waitFor();
    assert.equal((await ids(page, 'doing'))[0], deadlineId, 'dropped at the top, where the placeholder was');
    await waitForLabels(page, deadlineId, { has: ['_Board/Doing', 'INBOX'], lacks: ['_Board/To do'] }, 'labels after drag');
    assert.equal(await modifyCalls(page), before + 1);
  });

  await r.step('reordering within a column is saved locally and does not touch Gmail', async () => {
    const before = await ids(page, 'doing');
    const last = before[before.length - 1];
    const calls = await modifyCalls(page);
    await drag(page, last, page.locator('section[data-col="doing"] .card').first(), { x: 60, y: 6 });
    await until(async () => (await ids(page, 'doing'))[0] === last, 'last card moved to the top');
    const stored = await page.evaluate(() => window.chrome.storage.local.dump()['order:test@example.com']);
    assert.equal(stored.doing[0], last);
    assert.deepEqual(stored.doing.slice().sort(), before.slice().sort());
    await page.waitForTimeout(300);
    assert.equal(await modifyCalls(page), calls, 'no API call for a reorder');
    ifuOrder = stored.doing;
  });

  await r.step('the card “⋯” menu moves a thread without dragging', async () => {
    const id = await findThread(page, 'Proofreading feedback');
    const card = page.locator(`.card[data-id="${id}"]`);
    await card.hover();
    await card.locator('.card-menu').click();
    const menu = page.locator('.menu[role="menu"]');
    await menu.waitFor();
    assert.ok(await menu.locator('[data-key="move:todo"]').isDisabled(), 'current column is disabled');
    assert.equal(await menu.locator('[data-key="move:todo"]').getAttribute('aria-checked'), 'true');
    await page.screenshot({ path: join(SCREENS, 'card-menu.png'), animations: 'disabled' });
    await menu.locator('[data-key="move:waiting"]').click();
    await page.locator(`section[data-col="waiting"] .card[data-id="${id}"]`).waitFor();
    await waitForLabels(page, id, { has: ['_Board/Waiting'], lacks: ['_Board/To do'] }, 'labels after menu move');
  });

  await r.step('the menu’s keyboard: arrows move, Esc closes and returns focus', async () => {
    const id = (await ids(page, 'todo'))[0];
    const btn = page.locator(`.card[data-id="${id}"] .card-menu`);
    await btn.focus();
    await page.keyboard.press('Enter');
    await page.locator('.menu').waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await page.locator('.menu').waitFor({ state: 'detached' });
    assert.ok(await overlayVisible(page), 'Esc in a menu closes only the menu');
    assert.equal(await page.evaluate(() => document.getElementById('gkb-board-host').shadowRoot.activeElement.dataset.key), `menu:${id}`);
  });

  await r.step('the “⋯” menu also reorders within a column, by keyboard', async () => {
    const before = await ids(page, 'todo');
    const second = before[1];
    const calls = await modifyCalls(page);
    await page.locator(`.card[data-id="${second}"] .card-menu`).focus();
    await page.keyboard.press('Enter');
    await page.locator('.menu [data-key="up"]').waitFor();
    assert.ok(await page.locator('.menu [data-key="up"]').isEnabled());
    await page.locator('.menu [data-key="up"]').press('Enter');
    await until(async () => (await ids(page, 'todo'))[0] === second, 'card moved up');
    assert.equal(await page.evaluate(() => document.getElementById('gkb-board-host').shadowRoot.activeElement.dataset.key),
      `menu:${second}`, 'focus stays on the moved card');
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('.menu [data-key="up"]').isDisabled(), 'already at the top');
    await page.keyboard.press('Escape');
    assert.equal(await modifyCalls(page), calls);
  });

  await r.step('moving to Done archives (removes INBOX)', async () => {
    const id = await findThread(page, 'Office action');
    await drag(page, id, page.locator('section[data-col="done"] .list'));
    await page.locator(`section[data-col="done"] .card[data-id="${id}"]`).waitFor();
    await waitForLabels(page, id, { has: ['_Board/Done'], lacks: ['INBOX', '_Board/Doing'] }, 'archived on drop');
  });

  await r.step('column “+” searches Gmail and adds a result', async () => {
    await page.locator('[data-key="add:waiting"]').click();
    const results = page.locator('.search .result');
    await results.first().waitFor();
    assert.ok(await results.count() > 5, 'empty query lists the Inbox');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SCREENS, 'search-panel.png'), animations: 'disabled' });
    const input = page.locator('.search input');
    assert.ok(await input.evaluate(e => e.getRootNode().activeElement === e), 'search box has focus');
    await input.fill('Coffee');
    await input.press('Enter');
    await until(async () => (await results.count()) === 1, 'one result for "Coffee"');
    const id = await findThread(page, 'Coffee next week');
    await results.first().click();
    await page.locator(`section[data-col="waiting"] .card[data-id="${id}"]`).waitFor();
    assert.equal((await ids(page, 'waiting'))[0], id, 'added at the top');
    await waitForLabels(page, id, { has: ['_Board/Waiting', 'INBOX'] }, 'labels after search-add');
    await until(async () => results.first().isDisabled(), 'result now marked as already here');
  });

  await r.step('Esc closes the search before it closes the board', async () => {
    await page.locator('.search input').press('Escape');
    await page.locator('.search').waitFor({ state: 'detached' });
    assert.ok(await overlayVisible(page));
  });

  let waitingLabelId;
  await r.step('column settings: rename title and label, add a column', async () => {
    waitingLabelId = await page.evaluate(() => window.__fakeGmail.labelByName('_Board/Waiting').id);
    await page.locator('[data-key="settings"]').click();
    const drawer = page.locator('.drawer');
    await drawer.waitFor();
    await page.screenshot({ path: join(SCREENS, 'column-settings.png'), animations: 'disabled' });
    await drawer.locator('[data-key="title:2"]').fill('Waiting on others');
    await drawer.locator('[data-key="label:2"]').fill('_Board/Waiting on others');
    await drawer.locator('[data-key="add-col"]').click();
    await drawer.locator('[data-key="title:4"]').fill('Later');
    assert.equal(await drawer.locator('[data-key="label:4"]').inputValue(), '_Board/Later', 'new label follows the title');
    await drawer.locator('[data-key="save"]').click();
    await drawer.waitFor({ state: 'detached' });
    await until(async () => (await page.locator('section.column').count()) === 5, 'five columns');
    await until(async () => (await page.locator('section[data-col="waiting"] .col-title').innerText()) === 'Waiting on others', 'renamed title');
    const renamed = await page.evaluate(() => window.__fakeGmail.labelByName('_Board/Waiting on others'));
    assert.ok(renamed, 'label renamed in Gmail');
    assert.equal(renamed.id, waitingLabelId, 'renamed in place via labels.patch, same id');
    assert.equal(await page.evaluate(() => !!window.__fakeGmail.labelByName('_Board/Waiting')), false);
    assert.ok(await page.evaluate(() => !!window.__fakeGmail.labelByName('_Board/Later')), 'new label created');
    await until(async () => (await ids(page, 'waiting')).length === 4, 'mail stayed attached to the renamed label');
  });

  await r.step('column settings: reorder with the arrows, then remove a column', async () => {
    await page.locator('[data-key="settings"]').click();
    const drawer = page.locator('.drawer');
    await drawer.waitFor();
    await drawer.locator('[data-key="down:0"]').click();
    assert.equal(await drawer.locator('[data-key="title:1"]').inputValue(), 'To do');
    assert.match(await drawer.locator('.drawer-foot .note').innerText(), /label.*left untouched/i);
    await drawer.locator('[data-key="remove:4"]').click();
    await drawer.locator('[data-key="save"]').click();
    await drawer.waitFor({ state: 'detached' });
    await until(async () => (await page.locator('section.column').count()) === 4, 'back to four columns');
    const order = await page.locator('section.column').evaluateAll(els => els.map(e => e.dataset.col));
    assert.deepEqual(order, ['doing', 'todo', 'waiting', 'done']);
    assert.ok(await page.evaluate(() => !!window.__fakeGmail.labelByName('_Board/Later')), 'removed column keeps its Gmail label');
    const stored = await page.evaluate(() => window.chrome.storage.sync.dump()['columns:test@example.com']);
    assert.deepEqual(stored.map(c => c.title), ['Doing', 'To do', 'Waiting on others', 'Done']);
  });

  await r.step('saved order survives a refresh', async () => {
    await page.locator('button[aria-label="Refresh"]').click();
    await page.waitForTimeout(600);
    const doing = await ids(page, 'doing');
    assert.deepEqual(doing.filter(id => ifuOrder.includes(id)), ifuOrder.filter(id => doing.includes(id)));
  });

  // ── Card edits ──

  const editKey = id => `card:test@example.com:${id}`;
  const syncDump = () => page.evaluate(() => chrome.storage.sync.dump());
  const apiCalls = () => page.evaluate(() => window.__mockChrome.log.length);
  const emailSubject = id => page.evaluate(i => window.__fakeGmail.header(window.__fakeGmail.thread(i).messages[0], 'Subject'), id);
  const shadowFocusKey = () => page.evaluate(() => {
    const a = document.getElementById('gkb-board-host').shadowRoot.activeElement;
    return a && a.dataset ? a.dataset.key : '';
  });
  async function openEditor(id) {
    await page.locator(`.card[data-id="${id}"]`).hover();
    await page.locator(`.card[data-id="${id}"] .card-menu`).click();
    await page.locator('.menu [data-key="edit"]').click();
    await page.locator('.dialog').waitFor();
  }

  let quoteId;
  let quoteSubject;
  await r.step('Edit card: own title, note and colour, without a single Gmail call', async () => {
    quoteId = await findThread(page, 'Quote request');
    quoteSubject = await emailSubject(quoteId);
    const before = await apiCalls();

    await openEditor(quoteId);
    const title = page.locator('.dialog [data-key="edit-title"]');
    assert.equal(await title.inputValue(), quoteSubject, 'pre-filled with the subject');
    assert.equal(await shadowFocusKey(), 'edit-title', 'title has focus');
    assert.ok(await page.locator('.dialog [data-key="edit-reset"]').isHidden(), 'no reset while it is the subject');

    await title.fill('Kestrel patent quote');
    assert.ok(await page.locator('.dialog [data-key="edit-reset"]').isVisible(), 'reset offered once changed');
    await page.locator('.dialog [data-key="edit-note"]').fill('14,200 words\nDue Friday');
    await page.locator('.dialog .swatch[data-colour="green"]').click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SCREENS, 'card-edit.png'), animations: 'disabled' });
    await page.locator('.dialog [data-key="edit-save"]').click();
    await page.locator('.dialog').waitFor({ state: 'detached' });

    const card = page.locator(`.card[data-id="${quoteId}"]`);
    assert.equal(await card.locator('.subject').innerText(), 'Kestrel patent quote');
    // "Note: " is for screen readers only.
    assert.equal(await card.locator('.card-note').textContent(), 'Note: 14,200 words\nDue Friday');
    assert.equal(await card.locator('.snippet').count(), 0, 'the note replaces the preview');
    assert.equal(await card.getAttribute('data-colour'), 'green');
    assert.match(await card.locator('.card-main').getAttribute('title'), new RegExp(`Email subject: ${quoteSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(await shadowFocusKey(), `menu:${quoteId}`, 'focus back on the card');

    assert.deepEqual((await syncDump())[editKey(quoteId)],
      { title: 'Kestrel patent quote', note: '14,200 words\nDue Friday', colour: 'green' });
    assert.equal(await emailSubject(quoteId), quoteSubject, 'the email is untouched');
    assert.equal(await apiCalls(), before, 'no Gmail API call at all');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SCREENS, 'card-edited.png'), animations: 'disabled' });
  });

  await r.step('edits survive a refresh; Esc cancels; Enter saves', async () => {
    await page.locator('button[aria-label="Refresh"]').click();
    await page.waitForTimeout(600);
    const card = page.locator(`.card[data-id="${quoteId}"]`);
    assert.equal(await card.locator('.subject').innerText(), 'Kestrel patent quote');

    await openEditor(quoteId);
    await page.locator('.dialog [data-key="edit-title"]').fill('Something I will not keep');
    await page.keyboard.press('Escape');
    await page.locator('.dialog').waitFor({ state: 'detached' });
    assert.ok(await overlayVisible(page), 'Esc closed only the editor');
    assert.equal(await card.locator('.subject').innerText(), 'Kestrel patent quote');

    await openEditor(quoteId);
    await page.locator('.dialog [data-key="edit-title"]').fill('Kestrel quote');
    await page.keyboard.press('Enter');
    await page.locator('.dialog').waitFor({ state: 'detached' });
    assert.equal(await card.locator('.subject').innerText(), 'Kestrel quote');
    assert.equal((await syncDump())[editKey(quoteId)].title, 'Kestrel quote');
  });

  await r.step('putting everything back deletes the record', async () => {
    await openEditor(quoteId);
    await page.locator('.dialog [data-key="edit-reset"]').click();
    assert.equal(await page.locator('.dialog [data-key="edit-title"]').inputValue(), quoteSubject);
    await page.locator('.dialog [data-key="edit-note"]').fill('');
    await page.locator('.dialog .swatch[data-colour="none"]').click();
    await page.locator('.dialog [data-key="edit-save"]').click();
    await page.locator('.dialog').waitFor({ state: 'detached' });
    const card = page.locator(`.card[data-id="${quoteId}"]`);
    assert.equal(await card.locator('.subject').innerText(), quoteSubject);
    assert.equal(await card.locator('.snippet').count(), 1, 'the preview is back');
    assert.equal(await card.getAttribute('data-colour'), null);
    assert.equal(editKey(quoteId) in (await syncDump()), false);
  });

  await r.step('an edit synced from another computer shows up without a refresh', async () => {
    const id = await findThread(page, 'Deadline moved');
    await page.evaluate(([k, v]) => chrome.storage.sync.set({ [k]: v }), [editKey(id), { title: 'From the laptop', colour: 'orange' }]);
    const card = page.locator(`.card[data-id="${id}"]`);
    await until(async () => (await card.locator('.subject').innerText()) === 'From the laptop', 'synced edit drawn');
    assert.equal(await card.getAttribute('data-colour'), 'orange');
    await page.evaluate(k => chrome.storage.sync.remove(k), editKey(id));
    await until(async () => (await card.locator('.subject').innerText()) === 'Deadline moved to Thursday 10:00', 'synced removal drawn');
  });

  await r.step('removing a card from the board forgets its edit', async () => {
    const id = await findThread(page, 'Coffee next week');
    await openEditor(id);
    await page.locator('.dialog .swatch[data-colour="red"]').click();
    await page.locator('.dialog [data-key="edit-save"]').click();
    await page.locator('.dialog').waitFor({ state: 'detached' });
    assert.deepEqual((await syncDump())[editKey(id)], { colour: 'red' });

    await page.locator(`.card[data-id="${id}"]`).hover();
    await page.locator(`.card[data-id="${id}"] .card-menu`).click();
    await page.locator('.menu [data-key="remove"]').click();
    await page.locator(`.card[data-id="${id}"]`).waitFor({ state: 'detached' });
    await until(async () => !(editKey(id) in (await syncDump())), 'edit deleted with the card');
  });

  await r.step('Esc closes the board', async () => {
    await page.locator('.overlay').press('Escape');
    await page.locator('.overlay').waitFor({ state: 'hidden' });
  });

  await r.step('dock pill follows the open thread and changes its column', async () => {
    const id = await findThread(page, 'Termbase export');
    await page.locator('#dev-toggle-thread').click();
    const pill = page.locator('[data-action="thread-menu"]');
    await until(async () => /On board: Doing/.test(await pill.innerText()), 'pill shows Doing');
    await pill.click();
    const menu = page.locator('.menu');
    await menu.waitFor();
    await page.screenshot({ path: join(SCREENS, 'dock-pill.png'), animations: 'disabled' });
    await menu.locator('[data-key="col:todo"]').click();
    await until(async () => /On board: To do/.test(await pill.innerText()), 'pill shows To do');
    await waitForLabels(page, id, { has: ['_Board/To do'], lacks: ['_Board/Doing'] }, 'labels after dock move');
  });

  await r.step('dock: remove from board, add again, Esc closes its menu', async () => {
    const id = await findThread(page, 'Termbase export');
    const pill = page.locator('[data-action="thread-menu"]');
    await pill.click();
    await page.locator('.menu [data-key="remove"]').click();
    await until(async () => /Add to board/.test(await pill.innerText()), 'pill says Add to board');
    await waitForLabels(page, id, { lacks: ['_Board/To do', '_Board/Doing', '_Board/Waiting on others', '_Board/Done'] }, 'removed');
    await pill.click();
    await page.locator('.menu').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.menu').waitFor({ state: 'detached' });
    await pill.click();
    await page.locator('.menu [data-key="col:waiting"]').click();
    await until(async () => /On board: Waiting on others/.test(await pill.innerText()), 'added back');
    await page.locator('#dev-toggle-thread').click();
    await until(async () => !(await pill.isVisible()), 'pill hides with no open thread');
  });

  await r.step('the buttons sit in Gmail’s top bar, between the search box and Gmail’s icons; their menu opens below, on top; back when Gmail redraws the bar', async () => {
    const p = await openPage();
    // Where the dock's floating layer is, and where the buttons are now.
    const where = () => p.evaluate(() => {
      const bar = document.getElementById('gkb-bar-host');
      const inBar = !!(bar && bar.isConnected);
      const dock = (inBar ? bar.shadowRoot : document.getElementById('gkb-dock-host').shadowRoot).querySelector('.dock');
      const b = dock.getBoundingClientRect();
      return {
        inBar, compact: dock.classList.contains('compact'), right: dock.classList.contains('right'), hidden: dock.hidden,
        before: inBar && !!bar.previousElementSibling.querySelector('form[role="search"]'),
        after: inBar && bar.nextElementSibling.classList.contains('top-icons'),
        inHeader: inBar && !!bar.closest('header#gb'),
        top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right2: Math.round(b.right),
      };
    });
    await p.locator('[data-action="toggle-board"]').waitFor();
    await until(async () => (await where()).inBar, 'in the bar');
    const w = await where();
    assert.deepEqual([w.before, w.after, w.inHeader, w.compact], [true, true, true, false], 'after the search box, before Gmail’s icons, with their words');
    const header = await p.locator('header#gb').boundingBox();
    assert.ok(w.top >= header.y && w.bottom <= header.y + header.height, 'within the bar');
    assert.equal(await p.locator('[data-action="toggle-board"]').innerText(), 'Board');

    // The open email's button joins them; its menu opens below it, on the
    // floating layer, above the mail.
    await p.locator('#dev-toggle-thread').click();
    const pill = p.locator('[data-action="thread-menu"]');
    await until(async () => /On board: Doing/.test(await pill.innerText()), 'the email’s button');
    await pill.click();
    const menu = p.locator('.menu');
    await menu.waitFor();
    assert.ok((await menu.boundingBox()).y >= (await pill.boundingBox()).y + (await pill.boundingBox()).height, 'below it');
    assert.equal(await p.evaluate(() => !!document.getElementById('gkb-dock-host').shadowRoot.querySelector('.menu')), true, 'on the floating layer');
    await p.screenshot({ path: join(SCREENS, 'preview-top-bar.png'), animations: 'disabled' });
    await p.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });

    // Gmail draws its bar afresh: the buttons go back in.
    await p.evaluate(() => document.getElementById('gkb-bar-host').remove());
    await until(async () => (await where()).inBar, 'back in the bar', 6000);

    // Less room: icons only, with names for a screen reader; too little: the corner.
    await p.setViewportSize({ width: 1100, height: 900 });
    await until(async () => (await where()).compact, 'icons only');
    assert.equal(await p.locator('[data-action="toggle-board"]').getAttribute('title'), 'Open the MemDesk board'.replace('MemDesk', await p.evaluate(() => window.gkb.APP_NAME)));
    await p.setViewportSize({ width: 900, height: 900 });
    await until(async () => !(await where()).inBar, 'floating');
    let f = await where();
    assert.ok(f.left === 16 && Math.abs(f.bottom - (900 - 16)) <= 1, `bottom left: ${JSON.stringify(f)}`);
    await p.setViewportSize({ width: 1440, height: 900 });
    await until(async () => (await where()).inBar && !(await where()).compact, 'in the bar again, with room');

    // Gmail still laying its bar out: no room for a moment. Once the search
    // box has its width, the buttons go in - without a resize.
    await p.evaluate(() => { document.getElementById('gkb-bar-host').remove(); document.querySelector('.searchbar').style.maxWidth = '100px'; });
    await until(async () => !(await where()).inBar, 'no room yet: floating', 6000);
    await p.waitForTimeout(2500);
    assert.equal((await where()).inBar, false, 'not tried again while there is still no room');
    await p.evaluate(() => { document.querySelector('.searchbar').style.maxWidth = ''; });
    await until(async () => (await where()).inBar, 'in the bar once there is room', 6000);

    // No bar at all (Gmail changed it): the corner.
    await p.evaluate(() => document.querySelector('header#gb').remove());
    await until(async () => !(await where()).inBar, 'floating without a bar', 6000);
    f = await where();
    assert.ok(f.left === 16, 'bottom left');
    await p.context().close();

    // As chosen on the setup page.
    const q = await openPage();
    await q.locator('[data-action="toggle-board"]').waitFor();
    for (const [place, check] of [
      ['right', s => !s.inBar && s.right && s.right2 > 1200],
      ['left', s => !s.inBar && !s.right && s.left === 16],
      ['hidden', s => s.hidden],
      ['top', s => s.inBar && !s.hidden],
    ]) {
      await q.evaluate(v => chrome.storage.sync.set({ dockPlace: v }), place);
      await until(async () => check(await q.evaluate(() => {
        const bar = document.getElementById('gkb-bar-host');
        const inBar = !!(bar && bar.isConnected);
        const dock = (inBar ? bar.shadowRoot : document.getElementById('gkb-dock-host').shadowRoot).querySelector('.dock');
        const b = dock.getBoundingClientRect();
        return { inBar, hidden: dock.hidden, right: dock.classList.contains('right'), left: Math.round(b.left), right2: Math.round(b.right) };
      })), place);
    }
    await q.context().close();
  });

  await r.step('“Waiting on them” where the user wrote last, a click moving it to Waiting; Gmail’s label colours on the cards, a colour set by hand winning', async () => {
    const p = await openPage();
    await openBoard(p);
    const card = id => p.locator(`.card[data-id="${id}"]`);
    const [proofing, glossary, ifu, invoice, po, quote, remittance] = await Promise.all([
      'Proofreading feedback', 'Glossary for the stent', 'Updated IFU files', 'Invoice 2026-131', 'PO 88213', 'Quote request', 'Remittance advice',
    ].map(s => findThread(p, s)));
    // The user wrote last: in To do and Doing, the mark; in Waiting and Done, none.
    assert.equal(await card(proofing).locator('.card-wait').count(), 1);
    assert.equal(await card(glossary).locator('.card-wait').count(), 1);
    for (const id of [ifu, invoice, po]) assert.equal(await card(id).locator('.card-wait').count(), 0, 'already waiting, or done');
    assert.equal(await card(quote).locator('.card-wait').count(), 0, 'their move');
    assert.equal(await p.locator('.card-wait').count(), 2);
    assert.match(await card(proofing).locator('.card-wait').getAttribute('title'), /ball is in their court/);
    // A click: to the top of Waiting, and its label in Gmail with it.
    await card(proofing).locator('.card-wait').click();
    await until(async () => (await ids(p, 'waiting'))[0] === proofing, 'moved to Waiting');
    await waitForLabels(p, proofing, { has: ['_Board/Waiting'], lacks: ['_Board/To do'] }, 'labelled Waiting in Gmail');
    assert.equal(await card(proofing).locator('.card-wait').count(), 0, 'no mark in Waiting');

    // Gmail's label colours: a tag in the label's colour, and the stripe.
    const tag = card(quote).locator('.label-tag');
    assert.deepEqual(await tag.allInnerTexts(), ['Clients']);
    assert.equal(await tag.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(74, 134, 232)');
    assert.equal(await card(quote).getAttribute('data-tinted'), '');
    assert.equal(await card(quote).evaluate(e => getComputedStyle(e, '::before').backgroundColor), 'rgb(74, 134, 232)');
    assert.deepEqual(await card(invoice).locator('.label-tag').allInnerTexts(), ['Clients', 'Invoices']);
    assert.ok(!(await p.locator('.label-tag').allInnerTexts()).some(t => /_Board|To do|Doing|Waiting|Done/.test(t)), 'never the board’s own labels, green as they are in Gmail');
    // A colour set by hand wins; the tags stay.
    await p.evaluate(id => chrome.storage.sync.set({ [`card:test@example.com:${id}`]: { colour: 'red' } }), remittance);
    await until(async () => (await card(remittance).getAttribute('data-colour')) === 'red', 'red by hand');
    assert.equal(await card(remittance).getAttribute('data-tinted'), null);
    assert.deepEqual(await card(remittance).locator('.label-tag').allInnerTexts(), ['Invoices']);
    await p.screenshot({ path: join(SCREENS, 'preview-waiting-and-colours.png'), animations: 'disabled' });
    await p.context().close();
  });

  await r.step('clicking a card opens the thread in Gmail and closes the board', async () => {
    await openBoard(page);
    const id = (await ids(page, 'done'))[0];
    await page.locator(`.card[data-id="${id}"] .card-main`).click();
    await page.locator('.overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => location.hash), `#all/${id}`);
    await until(async () => /On board: Done/.test(await page.locator('[data-action="thread-menu"]').innerText()), 'dock sees the opened thread');
    await page.locator('#dev-toggle-thread').click();
  });

  await r.step('the toggle message (shortcut / toolbar button) opens and closes the board', async () => {
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press('Alt+Shift+KeyK');
    await page.locator('.overlay').waitFor({ state: 'visible' });
    await page.locator('#dev-shortcut').evaluate(b => b.click());
    await page.locator('.overlay').waitFor({ state: 'hidden' });
  });

  await r.step('dark mode follows prefers-color-scheme', async () => {
    const dark = await openPage('', { colorScheme: 'dark' });
    await openBoard(dark);
    const bg = await dark.locator('.overlay').evaluate(e => getComputedStyle(e).backgroundColor);
    assert.equal(bg, 'rgb(19, 19, 20)');
    await dark.mouse.move(0, 0);
    await dark.screenshot({ path: join(SCREENS, 'board-dark.png'), animations: 'disabled' });

    // The edited card and the editor, in dark mode.
    const id = await findThread(dark, 'Quote request');
    await dark.evaluate(([k, v]) => chrome.storage.sync.set({ [k]: v }),
      [`card:test@example.com:${id}`, { title: 'Kestrel patent quote', note: '14,200 words\nDue Friday', colour: 'purple' }]);
    await until(async () => (await dark.locator(`.card[data-id="${id}"] .subject`).innerText()) === 'Kestrel patent quote', 'dark: edit shown');
    await dark.locator(`.card[data-id="${id}"]`).hover();
    await dark.locator(`.card[data-id="${id}"] .card-menu`).click();
    await dark.locator('.menu [data-key="edit"]').click();
    await dark.locator('.dialog').waitFor();
    await dark.mouse.move(0, 0);
    await dark.screenshot({ path: join(SCREENS, 'card-edit-dark.png'), animations: 'disabled' });
    await dark.context().close();
  });

  // ── Notes ──

  const np = await openPage();
  const gm = (fn, ...a) => np.evaluate(([f, args]) => window.__fakeGmail[f](...args), [fn, a]);
  const live = noteId => gm('notesWithId', noteId).then(list => list.filter(n => !n.labels.includes('TRASH')));
  // The notes listed, the pinned scratchpad aside.
  const noteTitles = () => np.locator('.note-item:not(.scratch-item) .ni-title').allInnerTexts();
  const noteStatus = () => np.locator('.ne-status').innerText();
  const savedSoon = () => until(async () => /^Saved/.test(await noteStatus()), 'note saved', 8000);
  const bodyOf = p => p.locator('[data-key="note-body"]');
  const bodyReady = (p, re, what) => until(async () =>
    (await bodyOf(p).getAttribute('contenteditable')) === 'true' && re.test(await bodyOf(p).innerText()), what);
  const blocks = p => p.locator('.ne-body .blk').evaluateAll(els =>
    els.map(e => [e.dataset.type, Number(e.dataset.level || 0), e.dataset.checked || '', e.textContent]));
  // A table in the editor, as rows of cell texts.
  const tableGrid = (p, n = 0) => p.locator('.ne-body .blk[data-type="table"]').nth(n).evaluate(el =>
    [...el.querySelectorAll('tr')].map(tr => [...tr.cells].map(td => td.innerText.replace(/\n$/, ''))));
  const focused = (p, key) => p.evaluate(k => {
    const a = document.getElementById('gkb-board-host').shadowRoot.activeElement;
    return !!a && a.dataset.key === k;
  }, key);
  // Selects the first occurrence of some text in the editor, as a person
  // dragging over it would.
  const selectText = (p, text) => p.evaluate(t => {
    const ed = document.getElementById('gkb-board-host').shadowRoot.querySelector('[data-key="note-body"]');
    ed.focus();
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    }
    return false;
  }, text);
  // Replaces the whole note with these lines, typed.
  async function typeLines(p, lines) {
    await bodyOf(p).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.press('Delete');
    for (let i = 0; i < lines.length; i++) {
      if (i) await p.keyboard.press('Enter');
      await p.keyboard.type(lines[i]);
    }
  }

  await r.step('Notes tab: newest first, one entry per note, a stale version tidied into Trash', async () => {
    await openBoard(np);
    await np.locator('[data-key="view:notes"]').click();
    await np.locator('.note-item').first().waitFor();
    assert.equal(await np.locator('.tab[aria-selected="true"]').innerText(), 'Notes');
    assert.deepEqual(await noteTitles(), ['Ideas for the October newsletter', 'Shopping list', 'Launch checklist',
      'Kestrel glossary decisions', 'Rate schedule 2027 – draft']);
    // Nothing else open: the scratchpad, pinned on top, with the cursor in it.
    await np.locator('.note-editor.scratch .ne-body[contenteditable="true"]').waitFor();
    assert.equal(await np.locator('[data-key="scratch-title"] .st-name').innerText(), 'Scratchpad');
    assert.match(await np.locator('.note-item').first().innerText(), /^Scratchpad\s+Empty/);
    await until(() => np.evaluate(() => document.querySelector('#gkb-board-host').shadowRoot.activeElement?.classList.contains('ne-body')),
      'typing goes straight into it');
    assert.match(await np.locator('.notes-foot').innerText(), /_Notes/);
    assert.ok(await np.locator('[data-key="settings"]').isHidden(), 'column settings hidden on the notes tab');
    await until(async () => (await live('kestrelglossary0001')).length === 1, 'older version of the Kestrel note trashed');
    assert.match((await live('kestrelglossary0001'))[0].text, /decimal commas/, 'and it was the older one');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-intro.png'), animations: 'disabled' });
  });

  await r.step('the scratchpad: typed into, it saves as one note of its own; it comes back when nothing else is open', async () => {
    await np.keyboard.type('Ring the printer about toner');
    await until(async () => /^Saved/.test(await np.locator('.scratch-title .ne-status').innerText()), 'saved by itself', 10000);
    const saved = (await gm('notesWithId', 'scratchpad000000')).filter(n => !n.labels.includes('TRASH'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].subject, 'Scratchpad');
    assert.equal(saved[0].text, 'Ring the printer about toner');
    assert.deepEqual(saved[0].labels, ['_Notes'], 'in no folder, not in the Inbox');
    assert.match(await np.locator('.note-item').first().innerText(), /^Scratchpad[\s\S]*Ring the printer/, 'still pinned first');
    for (const key of ['note-delete', 'note-folder', 'note-title']) assert.equal(await np.locator(`[data-key="${key}"]`).count(), 0, `no ${key}`);
    // Another note, then back.
    await np.locator('.note-item[data-note="n:rateschedule00000003"]').click();
    await bodyReady(np, /Per-word rates/, 'the other note');
    assert.equal(await np.locator('.note-editor.scratch').count(), 0);
    await np.locator('.scratch-item').click();
    await bodyReady(np, /Ring the printer about toner/, 'the scratchpad again');
    assert.equal(await np.locator('.scratch-item').getAttribute('aria-current'), 'true');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-scratchpad.png'), animations: 'disabled' });
  });

  await r.step('editing a note saves a new version, formatted, and trashes the old one', async () => {
    await np.locator('.note-item[data-note="n:newsletterideas0002"]').click();
    await bodyReady(np, /termbase hygiene/, 'body loaded');
    await typeLines(np, ['Tips on termbase hygiene', 'A short piece on patent claim punctuation', 'NEW LINE ✓']);
    assert.equal(await noteStatus(), 'Unsaved changes');
    await savedSoon();
    const versions = await gm('notesWithId', 'newsletterideas0002');
    const current = versions.filter(n => !n.labels.includes('TRASH'));
    assert.equal(current.length, 1, 'one live version');
    assert.equal(current[0].text, 'Tips on termbase hygiene\nA short piece on patent claim punctuation\nNEW LINE ✓');
    assert.match(await gm('messageHtml', current[0].id), /<p[^>]*>NEW LINE ✓<\/p>/, 'with its HTML part');
    assert.deepEqual(current[0].labels, ['_Notes', '_Notes/Work'], 'not in the Inbox, not unread, still in its folder');
    assert.ok(versions.some(n => n.labels.includes('TRASH')), 'the old version is in Trash');
    assert.equal((await noteTitles())[0], 'Ideas for the October newsletter');
  });

  await r.step('a new note in Unicode, saved at once with Ctrl+S', async () => {
    await np.locator('[data-key="note-new"]').click();
    const title = np.locator('[data-key="note-title"]');
    assert.ok(await focused(np, 'note-title'), 'title has focus');
    await title.fill('Café meeting – naïve ✓');
    await title.press('Enter');
    assert.ok(await focused(np, 'note-body'), 'Enter moves to the body');
    await np.keyboard.type('Line one');
    await np.keyboard.press('Enter');
    await np.keyboard.type('Line two 日本');
    await np.keyboard.press('Control+s');
    await until(async () => /^Saved/.test(await noteStatus()), 'saved straight away', 2000);
    const id = await gm('findMessageBySubject', 'Café meeting – naïve ✓');
    assert.ok(id, 'stored under its title');
    assert.deepEqual(await gm('messageLabelNames', id), ['_Notes']);
    assert.match(await gm('messageHeader', id, 'X-Gkb-Note'), /^[a-z0-9]{20}$/);
    assert.equal(await gm('messageText', id), 'Line one\nLine two 日本');
    assert.equal((await noteTitles())[0], 'Café meeting – naïve ✓');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes.png'), animations: 'disabled' });
  });

  await r.step('search finds notes by their text', async () => {
    const search = np.locator('[data-key="notes-search"]');
    await search.fill('stroopwafels');
    await until(async () => JSON.stringify(await noteTitles()) === JSON.stringify(['Shopping list']), 'one hit');
    await search.fill('nothing-matches-this');
    await until(async () => (await np.locator('.notes-empty').innerText()) === 'No notes match.', 'no hits');
    await search.fill('');
    await until(async () => (await noteTitles()).length === 6, 'all six back');
  });

  await r.step('a search typed while another is still loading is not lost', async () => {
    // Slow enough that the first search is still out when the second starts.
    const p = await openPage('latency=500');
    await p.locator('[data-action="toggle-notes"]').click();
    await p.locator('.note-item').first().waitFor({ timeout: 15000 });
    const search = p.locator('[data-key="notes-search"]');
    await search.fill('newsletter');
    await p.waitForTimeout(700); // past the 400 ms pause: that search is now running
    await search.fill('rate schedule');
    await until(async () => JSON.stringify(await p.locator('.note-item:not(.scratch-item) .ni-title').allInnerTexts()) ===
      JSON.stringify(['Rate schedule 2027 – draft']), 'the later search wins', 15000);
    await p.context().close();
  });

  await r.step('search results mark the words, with excerpts and a count per note', async () => {
    const search = np.locator('[data-key="notes-search"]');
    await search.fill('coating');
    await until(async () => JSON.stringify(await noteTitles()) === JSON.stringify(['Kestrel glossary decisions']), 'one hit');
    await until(async () => (await np.locator('.note-item .ni-hits').count()) === 1, 'excerpts in');
    assert.equal(await np.locator('.note-item .ni-hits').innerText(), '3 matches');
    assert.deepEqual(await np.locator('.note-item .ni-excerpt mark').allInnerTexts(), ['coating', 'coating', 'coating']);

    await search.fill('kestrel');
    await until(async () => (await noteTitles()).length === 2, 'two hits');
    await until(async () => (await np.locator('.note-item .ni-hits').count()) === 2, 'excerpts in');
    assert.equal(await np.locator('.note-item', { hasText: 'Kestrel glossary' }).locator('.ni-title mark').innerText(), 'Kestrel',
      'matches in titles are marked too');
    assert.ok((await np.locator('.note-item', { hasText: 'Launch checklist' }).locator('.ni-excerpt').innerText()).includes('Deliver to Kestrel'));

    await search.fill('cafe');
    await until(async () => (await np.locator('.note-item .ni-title mark').allInnerTexts()).includes('Café'), 'accents ignored');
  });

  await r.step('the open note highlights every match; F3 and the arrows step through them', async () => {
    const search = np.locator('[data-key="notes-search"]');
    await search.fill('coating');
    await until(async () => JSON.stringify(await noteTitles()) === JSON.stringify(['Kestrel glossary decisions']), 'one hit');
    await np.locator('.note-item', { hasText: 'Kestrel glossary' }).click();
    await bodyReady(np, /decimal commas/, 'loaded');
    const pos = () => np.locator('.ne-find .find-pos').innerText();
    const highlights = () => np.evaluate(() => ({
      all: CSS.highlights.has('gkb-match') ? CSS.highlights.get('gkb-match').size : 0,
      current: CSS.highlights.has('gkb-match-current') ? [...CSS.highlights.get('gkb-match-current')][0].toString() : '',
    }));
    await until(async () => (await pos()) === '1 of 3', 'first of three');
    assert.deepEqual(await highlights(), { all: 3, current: 'coating' });
    assert.equal(await np.locator('.ne-body mark').count(), 0, 'nothing added to the text itself');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-search.png'), animations: 'disabled' });

    await np.locator('[data-key="find-next"]').click();
    assert.equal(await pos(), '2 of 3');
    await np.keyboard.press('F3');
    assert.equal(await pos(), '3 of 3');
    await np.keyboard.press('F3');
    assert.equal(await pos(), '1 of 3', 'wraps round');
    await np.keyboard.press('Shift+F3');
    assert.equal(await pos(), '3 of 3');

    // Typing keeps the highlights up to date.
    await bodyOf(np).click();
    await np.keyboard.press('Control+End');
    await np.keyboard.type(' and more coating');
    await until(async () => (await highlights()).all === 4, 'the new match is highlighted');

    await np.locator('[data-key="find-clear"]').click();
    await until(async () => (await noteTitles()).length > 1, 'search cleared');
    assert.equal(await search.inputValue(), '');
    assert.equal(await np.locator('.ne-find').count(), 0);
    assert.deepEqual(await highlights(), { all: 0, current: '' });
    await savedSoon();
  });

  await r.step('an emailed note keeps its list, and editing it makes it a note of ours', async () => {
    const origId = await gm('findMessageBySubject', 'Shopping list');
    await np.locator(`.note-item[data-note="m:${origId}"]`).click();
    assert.ok(await np.locator('.ne-banner').isVisible(), 'explains what will happen');
    await bodyReady(np, /Stroopwafels/, 'loaded');
    assert.deepEqual(await blocks(np), [['p', 0, '', 'For the weekend'], ['ul', 0, '', 'Espresso beans'], ['ul', 0, '', 'Stroopwafels']]);
    await np.locator('.ne-body .blk[data-type="ul"]').last().click();
    await np.keyboard.press('End');
    await np.keyboard.press('Enter');
    await np.keyboard.type('Milk');
    assert.deepEqual((await blocks(np)).at(-1), ['ul', 0, '', 'Milk'], 'Enter carries the list on');
    await np.keyboard.press('Control+s');
    await savedSoon();
    const orig = await gm('messageLabelNames', origId);
    assert.ok(!orig.includes('_Notes') && !orig.includes('TRASH'), `original email kept, off the list: ${orig}`);
    const now = await gm('findMessageBySubject', 'Shopping list');
    assert.notEqual(now, origId);
    assert.match(await gm('messageHeader', now, 'X-Gkb-Note'), /^[a-z0-9]{20}$/);
    assert.equal(await gm('messageText', now), 'For the weekend\n• Espresso beans\n• Stroopwafels\n• Milk');
    assert.equal((await noteTitles()).filter(t => t === 'Shopping list').length, 1);
    assert.equal(await np.locator('.ne-banner').count(), 0, 'now ours: no banner');
  });

  await r.step('delete moves a note to Trash, and Undo brings it back', async () => {
    await np.locator('.note-item[data-note="n:rateschedule00000003"]').click();
    await bodyReady(np, /rush surcharge/, 'loaded');
    await np.locator('[data-key="note-delete"]').click();
    await until(async () => !(await noteTitles()).includes('Rate schedule 2027 – draft'), 'gone from the list');
    await until(async () => (await live('rateschedule00000003')).length === 0, 'in Trash');
    await np.locator('.toast-action', { hasText: 'Undo' }).click();
    await until(async () => (await noteTitles()).includes('Rate schedule 2027 – draft'), 'back in the list');
    assert.equal((await live('rateschedule00000003')).length, 1, 'out of Trash');
  });

  // ── Formatting ──

  await r.step('a formatted note opens with its headings, marks, link and nested checklist', async () => {
    await np.locator('.note-item[data-note="n:launchchecklist0004"]').click();
    await bodyReady(np, /Proofread the IFU/, 'loaded');
    assert.deepEqual(await blocks(np), [
      ['h2', 0, '', 'Before Friday'],
      ['p', 0, '', 'Deliver to Kestrel by noon, see the portal.'],
      ['check', 0, '1', 'Proofread the IFU'],
      ['check', 0, '0', 'Send the invoice'],
      ['check', 1, '0', 'Check the PO number'],
      ['ol', 0, '', 'Zip the files'],
      ['ol', 0, '', 'Upload'],
      ['p', 0, '', '~~not struck~~ and **not bold**'],
    ]);
    assert.equal(await np.locator('.ne-body b').innerText(), 'Kestrel');
    assert.equal(await np.locator('.ne-body i').innerText(), 'noon');
    assert.equal(await np.locator('.ne-body a').getAttribute('href'), 'https://example.com/portal');
    assert.equal(await np.locator('.ne-body a').getAttribute('title'), 'https://example.com/portal');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-format.png'), animations: 'disabled' });
  });

  await r.step('ticking a box and saving keeps every bit of the formatting', async () => {
    await np.locator('.ne-body .blk[data-type="check"]', { hasText: 'Send the invoice' }).click({ position: { x: 10, y: 12 } });
    assert.equal(await np.locator('.ne-body .blk[data-type="check"]', { hasText: 'Send the invoice' }).getAttribute('data-checked'), '1');
    assert.equal(await noteStatus(), 'Unsaved changes');
    await np.keyboard.press('Control+s');
    await savedSoon();
    const [cur] = await live('launchchecklist0004');
    const html = await gm('messageHtml', cur.id);
    assert.match(html, /data-checked="1"><span data-glyph="1">☑&nbsp;<\/span>Send the invoice/);
    assert.match(html, /<h2[^>]*>Before Friday<\/h2>/);
    assert.match(html, /<b>Kestrel<\/b>/);
    assert.match(html, /<a href="https:\/\/example\.com\/portal">the portal<\/a>/);
    assert.match(html, /<ol[^>]*><li[^>]*>Zip the files<\/li><li[^>]*>Upload<\/li><\/ol>/);
    assert.equal(cur.text, [
      'Before Friday', 'Deliver to Kestrel by noon, see the portal (https://example.com/portal).',
      '☑ Proofread the IFU', '☑ Send the invoice', '  ☐ Check the PO number', '1. Zip the files', '2. Upload',
      '~~not struck~~ and **not bold**',
    ].join('\n'), 'and the plain-text part reads cleanly');
  });

  await r.step('bold, italic and strike-through from the toolbar and the keyboard', async () => {
    await np.locator('[data-key="note-new"]').click();
    await np.locator('[data-key="note-title"]').fill('Formatting test');
    await np.locator('[data-key="note-title"]').press('Enter');
    await np.keyboard.type('plain bold italic gone');
    assert.ok(await selectText(np, 'bold'));
    await np.locator('[data-key="fmt-bold"]').click();
    assert.equal(await np.locator('.ne-body b').innerText(), 'bold');
    assert.equal(await np.locator('[data-key="fmt-bold"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await selectText(np, 'italic'));
    await np.keyboard.press('Control+i');
    assert.ok(await selectText(np, 'gone'));
    await np.locator('[data-key="fmt-strike"]').click();
    await np.keyboard.press('Control+s');
    await savedSoon();
    const html = await gm('messageHtml', await gm('findMessageBySubject', 'Formatting test'));
    assert.match(html, /plain <b>bold<\/b> <i>italic<\/i> <s>gone<\/s>/);
  });

  await r.step('lists by typing: bullets, Tab nesting, numbers, checkboxes; Enter on an empty item ends a list', async () => {
    await bodyOf(np).focus();
    await np.keyboard.press('Control+End');
    // The caret sits at the end of the struck-through word, so what comes
    // next would be struck through too - until the button is pressed again.
    assert.equal(await np.locator('[data-key="fmt-strike"]').getAttribute('aria-pressed'), 'true');
    await np.locator('[data-key="fmt-strike"]').click();
    assert.equal(await np.locator('[data-key="fmt-strike"]').getAttribute('aria-pressed'), 'false');
    await np.keyboard.press('Enter');
    await np.keyboard.type('- one');
    assert.equal(await np.locator('[data-key="fmt-ul"]').getAttribute('aria-pressed'), 'true');
    await np.keyboard.press('Enter');
    await np.keyboard.press('Tab');
    await np.keyboard.type('nested');
    await np.keyboard.press('Enter');
    await np.keyboard.press('Shift+Tab');
    await np.keyboard.type('two');
    await np.keyboard.press('Enter');
    await np.keyboard.press('Enter');
    await np.keyboard.type('1. first');
    await np.keyboard.press('Enter');
    await np.keyboard.type('second');
    await np.keyboard.press('Enter');
    await np.keyboard.press('Enter');
    await np.keyboard.type('[] task');
    await np.keyboard.press('Enter');
    await np.keyboard.press('Enter');
    await np.keyboard.type('[x] done');
    assert.deepEqual((await blocks(np)).slice(1), [
      ['ul', 0, '', 'one'], ['ul', 1, '', 'nested'], ['ul', 0, '', 'two'],
      ['ol', 0, '', 'first'], ['ol', 0, '', 'second'], ['check', 0, '0', 'task'], ['check', 0, '1', 'done'],
    ]);
    await np.keyboard.press('Control+s');
    await savedSoon();
    const id = await gm('findMessageBySubject', 'Formatting test');
    assert.equal(await gm('messageText', id),
      'plain bold italic gone\n• one\n  • nested\n• two\n1. first\n2. second\n☐ task\n☑ done');
    assert.doesNotMatch(await gm('messageHtml', id), /<s>one<\/s>/, 'strike-through stayed off');
  });

  await r.step('headings from the style menu, links with Ctrl+K, and unsafe links refused', async () => {
    await np.keyboard.press('Enter');
    await np.keyboard.press('Enter');
    await np.keyboard.type('Heading here');
    await np.locator('[data-key="fmt-style"]').click();
    await np.locator('.menu [data-key="style:h1"]').click();
    assert.deepEqual((await blocks(np)).at(-1), ['h1', 0, '', 'Heading here']);
    assert.equal(await np.locator('.tb-style-label').innerText(), 'Heading 1');
    await np.keyboard.press('End');
    await np.keyboard.press('Enter');
    await np.keyboard.type('see example');
    assert.deepEqual((await blocks(np)).at(-1), ['p', 0, '', 'see example'], 'a heading does not carry on');

    assert.ok(await selectText(np, 'example'));
    await np.keyboard.press('Control+k');
    const input = np.locator('[data-key="fmt-link-input"]');
    assert.ok(await focused(np, 'fmt-link-input'), 'the link field takes focus');
    await input.fill('javascript:alert(1)');
    await input.press('Enter');
    assert.equal(await np.locator('.link-error').innerText(), 'That is not a web or email address.');
    await input.fill('example.com');
    await input.press('Enter');
    assert.equal(await np.locator('.ne-body a', { hasText: 'example' }).getAttribute('href'), 'https://example.com/');
    await np.keyboard.press('Control+s');
    await savedSoon();
    const html = await gm('messageHtml', await gm('findMessageBySubject', 'Formatting test'));
    assert.match(html, /<h1[^>]*>Heading here<\/h1>/);
    assert.match(html, /see <a href="https:\/\/example\.com\/">example<\/a>/);
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-format-new.png'), animations: 'disabled' });
  });

  // A paste as an application puts it on the clipboard: raw HTML, which
  // the browser's own clipboard API would tidy first.
  const pasteData = (p, data) => p.evaluate(d => {
    const ed = document.getElementById('gkb-board-host').shadowRoot.querySelector('[data-key="note-body"]');
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(d)) dt.setData(type, value);
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  // The real clipboard and the real keys.
  const clipboardText = (p, text) => p.evaluate(t => navigator.clipboard.writeText(t), text);
  await np.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await r.step('pasting HTML keeps bold, links and nested lists - and nothing else', async () => {
    await np.locator('[data-key="note-new"]').click();
    await np.locator('[data-key="note-title"]').fill('Paste test');
    await np.locator('[data-key="note-title"]').press('Enter');
    await pasteData(np, {
      'text/html': '<meta charset="utf-8"><p style="margin: 0px 0px 16px; color: rgb(200, 0, 0); font-size: 30px;">Para with ' +
        '<b style="color:red">loud</b> and <a href="https://example.com/x" style="color: blue">a link</a></p>' +
        '<ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul>' +
        '<img src="x" onerror="window.__pwned = 1"><script>window.__pwned = 2</script><a href="javascript:window.__pwned = 3">no link</a>',
      'text/plain': 'Para with loud and a link\n\none\ntwo\ndeep',
    });
    assert.deepEqual(await blocks(np), [
      ['p', 0, '', 'Para with loud and a link'], ['p', 0, '', ''],
      ['ul', 0, '', 'one'], ['ul', 0, '', 'two'], ['ul', 1, '', 'deep'], ['p', 0, '', 'no link'],
    ]);
    assert.equal(await np.locator('.ne-body b', { hasText: 'loud' }).count(), 1);
    assert.equal(await np.locator('.ne-body [style], .ne-body img, .ne-body script').count(), 0, 'no styles, images or scripts');
    assert.equal(await np.locator('.ne-body a', { hasText: 'a link' }).getAttribute('href'), 'https://example.com/x');
    assert.equal(await np.locator('.ne-body a').count(), 1, 'the javascript: link is text');
    assert.equal(await np.evaluate(() => window.__pwned), undefined);
    await np.keyboard.type('!');
    assert.equal((await blocks(np)).at(-1)[3], 'no link!', 'the caret ends after what was pasted');
    await np.keyboard.press('Control+s');
    await savedSoon();
    const html = await gm('messageHtml', await gm('findMessageBySubject', 'Paste test'));
    assert.match(html, /Para with <b>loud<\/b> and <a href="https:\/\/example\.com\/x">a link<\/a>/);
    assert.match(html, /<li[^>]*>two<ul[^>]*><li[^>]*>deep<\/li><\/ul><\/li><\/ul>/);
  });

  await r.step('pasting in the middle of a line: the rest follows; Ctrl+Z takes the paste back', async () => {
    await typeLines(np, ['before after']);
    assert.ok(await selectText(np, 'after'));
    await np.keyboard.press('ArrowLeft');
    await pasteData(np, { 'text/html': '<ul><li>x</li><li><i>y</i></li></ul>', 'text/plain': 'x\ny' });
    assert.deepEqual(await blocks(np), [['p', 0, '', 'before '], ['ul', 0, '', 'x'], ['ul', 0, '', 'y'], ['p', 0, '', 'after']]);
    await pasteData(np, { 'text/html': '<b>bold</b> words', 'text/plain': 'bold words' });
    assert.deepEqual((await blocks(np)).slice(2), [['ul', 0, '', 'ybold words'], ['p', 0, '', 'after']], 'one line joins the line it lands in');
    await np.keyboard.press('Control+z');
    assert.deepEqual((await blocks(np)).slice(2), [['ul', 0, '', 'y'], ['p', 0, '', 'after']]);
    await np.keyboard.press('Control+z');
    assert.deepEqual(await blocks(np), [['p', 0, '', 'before after']], 'and the one before it');
    await np.keyboard.type('X');
    assert.deepEqual(await blocks(np), [['p', 0, '', 'before Xafter']], 'with the caret back where it was');
    // A pasted list lands at the level of the list item it is pasted into.
    await typeLines(np, ['- item', '']);
    await np.keyboard.press('Tab');
    await pasteData(np, { 'text/html': '<ul><li>a<ul><li>b</li></ul></li></ul>', 'text/plain': 'a\nb' });
    assert.deepEqual(await blocks(np), [['ul', 0, '', 'item'], ['ul', 1, '', 'a'], ['ul', 2, '', 'b']]);
  });

  await r.step('Markdown becomes formatting, a table a table; Ctrl+Shift+V pastes the text as it is', async () => {
    const md = '## Positions\n\nUse **top, bottom, above, front** and *never* ~~left~~.\n\n' +
      '| Term | Meaning |\n|---|---|\n| **top** | above |\n| front | before |\n\n- [ ] check the PO\n- [x] proofread\n  1. twice';
    await typeLines(np, ['']);
    await clipboardText(np, md);
    await np.keyboard.press('Control+v');
    assert.deepEqual(await blocks(np), [
      ['h2', 0, '', 'Positions'], ['p', 0, '', 'Use top, bottom, above, front and never left.'], ['p', 0, '', ''],
      ['table', 0, '', 'TermMeaningtopabovefrontbefore'], ['p', 0, '', ''],
      ['check', 0, '0', 'check the PO'], ['check', 0, '1', 'proofread'], ['ol', 1, '', 'twice'],
    ]);
    assert.deepEqual(await tableGrid(np), [['Term', 'Meaning'], ['top', 'above'], ['front', 'before']]);
    assert.equal(await np.locator('.ne-body .blk[data-type="table"]').getAttribute('data-head'), '1', 'the |---| line made a heading row');
    assert.deepEqual(await np.locator('.ne-body b').allInnerTexts(), ['top, bottom, above, front', 'top']);
    assert.equal(await np.locator('.ne-body i').innerText(), 'never');
    assert.equal(await np.locator('.ne-body s').innerText(), 'left');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-paste-markdown.png'), animations: 'disabled' });

    await typeLines(np, ['']);
    await np.keyboard.press('Control+Shift+v');
    const plain = await blocks(np);
    assert.ok(plain.every(b => b[0] === 'p'), `nothing formatted: ${JSON.stringify(plain)}`);
    assert.deepEqual(plain.slice(0, 3).map(b => b[3]), ['## Positions', '', 'Use **top, bottom, above, front** and *never* ~~left~~.']);
    assert.equal(await np.locator('.ne-body b').count(), 0);
  });

  await r.step('a spreadsheet pastes as a table, the cursor after it; one cell and a plain line go in as typed', async () => {
    await typeLines(np, ['']);
    await pasteData(np, {
      'text/html': '<html><head><style>.xl65{font-weight:700}</style></head><body><table><!--StartFragment--><tr><td class=xl65>Term</td><td class=xl65>Rate</td></tr>' +
        '<tr><td>Proofreading</td><td x:num>0.04</td></tr><!--EndFragment--></table></body></html>',
      'text/plain': 'Term\tRate\r\nProofreading\t0.04\r\n',
    });
    assert.deepEqual((await blocks(np)).map(b => b[0]), ['table', 'p'], 'in place of the empty line, a line after it');
    assert.deepEqual(await tableGrid(np), [['Term', 'Rate'], ['Proofreading', '0.04']]);
    await np.keyboard.press('Control+b');
    await pasteData(np, { 'text/plain': ' bold like the typing' });
    assert.equal(await np.locator('.ne-body b').textContent(), ' bold like the typing');
    // One cell, copied: its text, no line break after it, and its spaces as copied.
    await pasteData(np, {
      'text/html': '<table><tr><td> cell </td></tr></table>',
      'text/plain': ' cell \r\n',
    });
    assert.equal((await blocks(np)).at(-1)[3], ' bold like the typing cell ');
    assert.equal(await np.locator('.ne-body .blk[data-type="table"]').count(), 1);
  });

  // ── Tables ──

  const cellText = text => np.locator('.ne-body td', { hasText: new RegExp(`^${text}$`) });
  const inCell = () => np.evaluate(() => {
    const a = document.getElementById('gkb-board-host').shadowRoot.activeElement;
    return a && a.tagName === 'TD' ? [a.parentNode.rowIndex, a.cellIndex] : null;
  });
  const keys = async list => {
    for (const k of list) {
      if (/^(Tab|Enter|Shift\+Tab)$/.test(k)) await np.keyboard.press(k);
      else await np.keyboard.type(k);
    }
  };

  await r.step('a table from the toolbar: Tab goes cell to cell and adds a row at the end, Enter a line in a cell; it saves as a table', async () => {
    await np.locator('[data-key="note-new"]').click();
    await np.locator('[data-key="note-title"]').fill('Rates table');
    await np.locator('[data-key="note-title"]').press('Enter');
    await np.keyboard.type('Rates for October:');
    await np.keyboard.press('Enter');
    assert.equal(await np.locator('.ne-tablebar').isHidden(), true, 'no table bar outside a table');
    await np.locator('[data-key="fmt-table"]').click();
    assert.deepEqual(await inCell(), [0, 0], 'the cursor in the first cell');
    assert.deepEqual(await blocks(np).then(b => b.map(x => x[0])), ['p', 'table', 'p'], 'in place of the empty line, a line after it');
    await until(() => np.locator('.ne-tablebar').isVisible(), 'the table bar');
    assert.equal(await np.locator('[data-key="fmt-ul"]').isDisabled(), true, 'no lists in a cell');
    await keys(['Language', 'Tab', 'Rate', 'Tab', 'Notes', 'Tab', 'NL', 'Tab', '0,08', 'Tab', 'per word', 'Enter', 'min. 50', 'Tab',
      'DE', 'Tab', '0,10', 'Tab', 'Shift+Tab', 'Tab', 'Tab']);
    assert.deepEqual(await inCell(), [3, 0], 'Tab in the last cell: a new row, its first cell');
    await keys(['FR', 'Tab', '0,09']);
    assert.deepEqual(await tableGrid(np), [['Language', 'Rate', 'Notes'], ['NL', '0,08', 'per word\nmin. 50'], ['DE', '0,10', ''], ['FR', '0,09', '']]);
    await np.keyboard.press('Control+s');
    await savedSoon();
    const html = await gm('messageHtml', await gm('findMessageBySubject', 'Rates table'));
    assert.match(html, /<p[^>]*>Rates for October:<\/p>\n<table data-gkb-table="1"[^>]*><thead><tr><th[^>]*>Language<\/th><th[^>]*>Rate<\/th><th[^>]*>Notes<\/th><\/tr><\/thead><tbody>/);
    assert.match(html, /per word<br>min\. 50/);
    const text = await gm('messageText', await gm('findMessageBySubject', 'Rates table'));
    assert.match(text, /Rates for October:\nLanguage \| Rate \| Notes\nNL \| 0,08 \| per word min\. 50\nDE \| 0,10 \| \nFR \| 0,09 \| /, 'plain text: a row a line');
  });

  await r.step('the table bar: rows and columns in and out, alignment, sorting, the heading row; Ctrl+Z takes a change back', async () => {
    await cellText('DE').click();
    await np.locator('[data-key="table-row"]').click();
    await np.locator('[data-key="row-above"]').click();
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'NL', '', 'DE', 'FR']);
    assert.deepEqual(await inCell(), [2, 0]);
    await np.keyboard.press('Control+z');
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'NL', 'DE', 'FR'], 'undone');
    await cellText('Rate').click();
    await np.locator('[data-key="table-column"]').click();
    await np.locator('[data-key="col-right"]').click();
    assert.deepEqual((await tableGrid(np))[0], ['Language', 'Rate', '', 'Notes']);
    assert.deepEqual(await inCell(), [0, 2], 'in the new column');
    await np.keyboard.type('Due');
    await np.locator('[data-key="fmt-align-right"]').click();
    assert.equal(await np.locator('[data-key="fmt-align-right"]').getAttribute('aria-pressed'), 'true');
    await cellText('NL').click();
    await np.locator('[data-key="table-sort"]').click();
    await np.locator('[data-key="sort-asc"]').click();
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'DE', 'FR', 'NL'], 'the heading row stays on top');
    await np.locator('[data-key="table-sort"]').click();
    await np.locator('[data-key="sort-desc"]').click();
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'NL', 'FR', 'DE']);
    await np.locator('[data-key="table-head"]').click();
    assert.equal(await np.locator('.ne-body .blk[data-type="table"]').getAttribute('data-head'), '0');
    await np.locator('[data-key="table-head"]').click();
    await cellText('FR').click();
    await np.locator('[data-key="table-row"]').click();
    await np.locator('[data-key="row-delete"]').click();
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'NL', 'DE']);
    await np.keyboard.press('Control+s');
    await savedSoon();
    const html = await gm('messageHtml', await gm('findMessageBySubject', 'Rates table'));
    assert.match(html, /<th[^>]*text-align:right">Due<\/th>/, 'the column aligned right');
    assert.match(html, /<tr><td[^>]*>NL<\/td>[\s\S]*<tr><td[^>]*>DE<\/td>/);
    assert.doesNotMatch(html, />FR</);
  });

  await r.step('the arrows lead in and out of a table, Backspace into it rather than through it, and nothing joins two cells', async () => {
    await np.locator('.ne-body tr').last().locator('td').first().click();
    await np.keyboard.press('ArrowDown');
    await until(async () => (await inCell()) === null, 'out below the table');
    await until(() => np.locator('.ne-tablebar').isHidden(), 'the table bar gone');
    await np.keyboard.type('After the table');
    await np.keyboard.press('Home');
    await np.keyboard.press('ArrowUp');
    assert.deepEqual(await inCell(), [2, 0], 'up into the last row');
    await np.locator('.ne-body .blk', { hasText: 'After the table' }).click();
    await np.keyboard.press('Home');
    await np.keyboard.press('Backspace');
    assert.ok(await inCell(), 'into the table');
    assert.equal(await np.locator('.ne-body .blk[data-type="table"]').count(), 1, 'the table untouched');
    await cellText('DE').click();
    await np.keyboard.press('Home');
    await np.keyboard.press('Backspace');
    assert.deepEqual((await tableGrid(np)).map(r => r[0]), ['Language', 'NL', 'DE'], 'a cell is not joined to the one before');
    await np.locator('.ne-body .blk', { hasText: 'Rates for October:' }).click();
    await np.keyboard.press('End');
    await np.keyboard.press('ArrowDown');
    assert.deepEqual(await inCell(), [0, 0], 'down into the first cell');
  });

  await r.step('cells copied from a spreadsheet, pasted into a cell, fill the table from there, adding rows and columns', async () => {
    await cellText('Notes').click();
    await clipboardText(np, 'a\tb\nc\td\ne\tf');
    await np.keyboard.press('Control+v');
    const grid = await tableGrid(np);
    assert.deepEqual(grid.map(r => r.slice(3)), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
    assert.equal(grid[0].length, 5, 'a column added');
    // Text with no tabs in it goes into the cell as typed.
    await cellText('b').click();
    await np.keyboard.press('End');
    await clipboardText(np, ' and more');
    await np.keyboard.press('Control+v');
    assert.equal((await tableGrid(np))[0][4], 'b and more');
    await np.keyboard.press('Control+s');
    await savedSoon();
    // Opened again, from what Gmail has.
    await np.locator('.note-item', { hasText: 'Launch checklist' }).click();
    await np.locator('.note-item', { has: np.locator('.ni-title', { hasText: /^Rates table$/ }) }).click();
    await np.locator('.ne-body td').first().waitFor();
    assert.deepEqual((await tableGrid(np))[0], ['Language', 'Rate', 'Due', 'a', 'b and more']);
    assert.equal(await np.locator('.ne-body .blk[data-type="table"]').getAttribute('data-head'), '1');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-table.png'), animations: 'disabled' });
  });

  // ── Folders ──

  const folderId = name => np.locator('.folder-row', { has: np.locator('.folder-title', { hasText: new RegExp(`^${name}$`) }) })
    .first().getAttribute('data-folder');
  const folderTitles = () => np.locator('.folder-row .folder-title').allInnerTexts();
  const folderCount = async name => Number(await np.locator('.folder-row', { has: np.locator('.folder-title', { hasText: new RegExp(`^${name}$`) }) })
    .first().locator('.folder-count').textContent()); // textContent: hovering a row hides its count
  const openFolderMenu = async name => {
    const row = np.locator('.folder-row', { has: np.locator('.folder-title', { hasText: new RegExp(`^${name}$`) }) }).first();
    await row.hover();
    await row.locator('.folder-menu').click();
    await np.locator('.menu').waitFor();
  };

  await r.step('folders: a tree with counts; choosing one shows just its notes', async () => {
    assert.deepEqual(await folderTitles(), ['All notes', 'Empty', 'Personal', 'Work', 'Clients']);
    assert.equal(await folderCount('Work'), 1);
    assert.equal(await folderCount('Clients'), 1);
    assert.equal(await folderCount('Empty'), 0);
    assert.equal(await np.locator('.folder-row[data-folder]').evaluateAll(rows =>
      rows.map(r => getComputedStyle(r).getPropertyValue('--depth').trim()).join()), '0,0,0,0,1', 'Clients sits under Work');
    await np.locator('.folder-btn', { hasText: /^Work/ }).click();
    assert.deepEqual(await noteTitles(), ['Ideas for the October newsletter']);
    assert.equal(await np.locator('.notes-scope').innerText(), 'Work · 1 note');
    assert.equal(await np.locator('[data-key="notes-search"]').getAttribute('placeholder'), 'Search in Work');
    await np.locator('.folder-btn', { hasText: /^Clients/ }).click();
    assert.deepEqual(await noteTitles(), ['Kestrel glossary decisions']);
    assert.equal(await np.locator('.notes-scope').innerText(), 'Work › Clients · 1 note');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-folders.png'), animations: 'disabled' });
    await np.locator('[data-key="folder:all"]').click();
    assert.equal(await np.locator('.note-item', { hasText: 'Kestrel glossary' }).locator('.ni-folder').innerText(), 'Work › Clients',
      'in All notes, each note says where it lives');
  });

  await r.step('folders: drag a note onto one, or move it from the folder button above the text', async () => {
    const cafe = await gm('findMessageBySubject', 'Café meeting – naïve ✓');
    await np.locator('.note-item', { hasText: 'Café meeting' }).dragTo(np.locator('.folder-row', { hasText: 'Personal' }));
    await until(async () => JSON.stringify(await gm('messageFolders', cafe)) === '["_Notes/Personal"]', 'dragged into Personal');
    assert.ok((await gm('messageLabelNames', cafe)).includes('_Notes'), 'still a note');
    assert.equal(await folderCount('Personal'), 1);

    await np.locator('.note-item[data-note="n:rateschedule00000003"]').click();
    await bodyReady(np, /rush surcharge/, 'loaded');
    assert.equal(await np.locator('[data-key="note-folder"]').innerText(), 'No folder');
    await np.locator('[data-key="note-folder"]').click();
    await np.locator(`.menu [data-key="move-folder:${await folderId('Work')}"]`).click();
    await until(async () => (await np.locator('[data-key="note-folder"]').innerText()) === 'Work', 'button shows the folder');
    const [rate] = await live('rateschedule00000003');
    await until(async () => JSON.stringify(await gm('messageFolders', rate.id)) === '["_Notes/Work"]', 'moved to Work');
    await np.locator('[data-key="note-folder"]').click();
    await np.locator('.menu [data-key="move-folder:none"]').click();
    await until(async () => (await gm('messageFolders', rate.id)).length === 0, 'out of its folder again');
  });

  await r.step('folders: a new note starts in the folder being looked at', async () => {
    await np.locator('.folder-btn', { hasText: /^Personal/ }).click();
    await np.locator('[data-key="note-new"]').click();
    assert.equal(await np.locator('[data-key="note-folder"]').innerText(), 'Personal');
    await np.locator('[data-key="note-title"]').fill('Personal note');
    await np.locator('[data-key="note-title"]').press('Enter');
    await np.keyboard.type('Only for me');
    await np.keyboard.press('Control+s');
    await savedSoon();
    const id = await gm('findMessageBySubject', 'Personal note');
    assert.deepEqual(await gm('messageLabelNames', id), ['_Notes', '_Notes/Personal']);
    assert.deepEqual(await noteTitles(), ['Personal note', 'Café meeting – naïve ✓']);
  });

  await r.step('folders: create, nest, rename with the branch, and delete only when empty', async () => {
    await np.locator('[data-key="folder-new"]').click();
    const input = np.locator('[data-key="folder-input"]');
    await input.fill('a/b');
    await input.press('Enter');
    assert.match(await np.locator('.folder-error').innerText(), /subfolder/);
    await input.fill('Recipes');
    await input.press('Enter');
    await until(async () => (await folderTitles()).includes('Recipes'), 'created');
    assert.ok(await np.evaluate(() => !!window.__fakeGmail.labelByName('_Notes/Recipes')));
    assert.equal(await np.locator('.folder-btn[aria-current="true"] .folder-title').innerText(), 'Recipes', 'and opened');

    await openFolderMenu('Recipes');
    await np.locator('.menu [data-key="folder-sub"]').click();
    await np.locator('[data-key="folder-input"]').fill('Desserts');
    await np.locator('[data-key="folder-input"]').press('Enter');
    await until(async () => np.evaluate(() => !!window.__fakeGmail.labelByName('_Notes/Recipes/Desserts')), 'subfolder created');

    await openFolderMenu('Recipes');
    await np.locator('.menu [data-key="folder-rename"]').click();
    assert.equal(await np.locator('[data-key="folder-input"]').inputValue(), 'Recipes');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-folder-edit.png'), animations: 'disabled' });
    await np.locator('[data-key="folder-input"]').fill('Cooking');
    await np.locator('[data-key="folder-input"]').press('Enter');
    await until(async () => (await folderTitles()).includes('Cooking'), 'renamed');
    const names = await np.evaluate(() => window.__fakeGmail.labelNames());
    assert.ok(names.includes('_Notes/Cooking') && names.includes('_Notes/Cooking/Desserts'), 'its subfolder came along');
    assert.ok(!names.some(n => n.startsWith('_Notes/Recipes')), 'nothing left under the old name');

    await openFolderMenu('Work');
    assert.ok(await np.locator('.menu [data-key="folder-delete"]').isDisabled(), 'a folder with notes cannot be deleted');
    await np.keyboard.press('Escape');
    // Even asked directly, the worker refuses a folder that still has notes.
    const refused = await np.evaluate(id => chrome.runtime.sendMessage({ type: 'gmail', account: 'test@example.com', method: 'DELETE', path: `labels/${id}` }),
      await folderId('Personal'));
    assert.equal(refused.error.code, 'not_allowed');

    await openFolderMenu('Empty');
    await np.locator('.menu [data-key="folder-delete"]').click();
    await until(async () => !(await folderTitles()).includes('Empty'), 'deleted');
    assert.equal(await np.evaluate(() => !!window.__fakeGmail.labelByName('_Notes/Empty')), false);
    await np.locator('[data-key="folder:all"]').click();
  });

  await r.step('folders: one with subfolders folds them away, by its arrow or the arrow keys, and stays folded', async () => {
    const twisty = async name => np.locator(`[data-key="folder-twisty:${await folderId(name)}"]`);
    const folderBtn = name => np.locator('.folder-btn', { has: np.locator('.folder-title', { hasText: new RegExp(`^${name}$`) }) });
    const iconX = async name => (await folderBtn(name).locator('.icon').boundingBox()).x;
    assert.deepEqual(await folderTitles(), ['All notes', 'Cooking', 'Desserts', 'Personal', 'Work', 'Clients']);
    assert.equal(await np.locator('button.folder-twisty').count(), 2, 'an arrow only where there are subfolders');
    assert.equal(await iconX('Personal'), await iconX('Work'), 'with or without one, the folders line up');
    assert.equal(await iconX('All notes'), await iconX('Work'));
    assert.ok(await iconX('Clients') > await iconX('Work'), 'and a subfolder is still drawn inside');

    const work = await twisty('Work');
    assert.equal(await work.getAttribute('aria-expanded'), 'true');
    await work.click();
    assert.deepEqual(await folderTitles(), ['All notes', 'Cooking', 'Desserts', 'Personal', 'Work'], 'Clients folded away');
    assert.equal(await (await twisty('Work')).getAttribute('aria-expanded'), 'false');
    assert.equal(await (await twisty('Work')).getAttribute('aria-label'), 'Show the folders in Work');
    const key = 'pref:test@example.com:foldedFolders';
    await until(async () => JSON.stringify(await np.evaluate(k => window.chrome.storage.local.dump()[k], key)) === JSON.stringify([await folderId('Work')]),
      'remembered on this computer');
    await np.mouse.move(0, 0);
    await np.screenshot({ path: join(SCREENS, 'notes-folders-folded.png'), animations: 'disabled' });
    await (await twisty('Work')).click();
    assert.ok((await folderTitles()).includes('Clients'), 'and back');

    // The keyboard: left folds, right opens, and the focus stays put.
    await folderBtn('Cooking').focus();
    await np.keyboard.press('ArrowLeft');
    assert.ok(!(await folderTitles()).includes('Desserts'));
    assert.equal(await np.evaluate(() => document.querySelector('#gkb-board-host').shadowRoot.activeElement.dataset.key), `folder:${await folderId('Cooking')}`);
    await np.keyboard.press('ArrowRight');
    assert.ok((await folderTitles()).includes('Desserts'));

    // Folded with the folder being looked at inside: the folded one says so.
    await folderBtn('Clients').click();
    await (await twisty('Work')).click();
    assert.equal(await folderBtn('Work').getAttribute('class'), 'folder-btn holds-current');
    assert.equal(await np.locator('.notes-scope').innerText(), 'Work › Clients · 1 note', 'still looking at it');
    await (await twisty('Work')).click();

    // A new subfolder in a folded folder opens it, to show where it goes.
    await (await twisty('Cooking')).click();
    assert.ok(!(await folderTitles()).includes('Desserts'));
    await openFolderMenu('Cooking');
    await np.locator('.menu [data-key="folder-sub"]').click();
    assert.ok((await folderTitles()).includes('Desserts'), 'opened');
    assert.equal(await np.locator('[data-key="folder-input"]').count(), 1);
    await np.locator('[data-key="folder-input"]').press('Escape');
    await np.locator('[data-key="folder:all"]').click();
    await until(async () => JSON.stringify(await np.evaluate(k => window.chrome.storage.local.dump()[k], key)) === '[]', 'nothing folded now');
  });

  await r.step('a plain note from before formatting opens with its lists; closing saves it, formatted', async () => {
    await np.locator('.note-item[data-note="n:kestrelglossary0001"]').click();
    await bodyReady(np, /decimal commas/, 'loaded');
    assert.deepEqual((await blocks(np)).map(b => b[0]), ['p', 'p', 'ul', 'ul', 'ul'], 'its "- " lines are a list');
    await typeLines(np, ['Closing test']);
    await np.keyboard.press('Escape');
    await np.locator('.overlay').waitFor({ state: 'hidden' });
    await until(async () => (await live('kestrelglossary0001')).map(n => n.text).join() === 'Closing test', 'saved on close');
    assert.match(await gm('messageHtml', (await live('kestrelglossary0001'))[0].id), /<p[^>]*>Closing test<\/p>/);
    await np.locator('[data-action="toggle-notes"]').click();
    await np.locator('.overlay').waitFor({ state: 'visible' });
    assert.equal(await np.locator('.tab[aria-selected="true"]').innerText(), 'Notes', 'the board reopens on Notes');
    // The overlay covers the dock while open; the dock's Board button is
    // for when it is closed, and opens the board on its own tab.
    await np.keyboard.press('Escape');
    await np.locator('.overlay').waitFor({ state: 'hidden' });
    await np.locator('[data-action="toggle-board"]').click();
    await np.locator('section[data-col="todo"] .card').first().waitFor();
    assert.equal(await np.locator('.tab[aria-selected="true"]').innerText(), 'Board');
    await np.context().close();
  });

  await r.step('a failed save says so and keeps the text', async () => {
    const p = await openPage('fail=insert');
    await p.locator('[data-action="toggle-notes"]').click();
    await p.locator('.note-item').first().waitFor();
    await p.locator('[data-key="note-new"]').click();
    await p.locator('[data-key="note-title"]').fill('Will not save');
    await p.locator('[data-key="note-title"]').press('Control+s');
    await until(async () => /^Couldn’t save: Backend Error/.test(await p.locator('.ne-status').innerText()), 'error shown');
    assert.equal(await p.locator('[data-key="note-title"]').inputValue(), 'Will not save');
    await p.context().close();
  });

  await r.step('a fresh mailbox gets its _Notes label', async () => {
    const p = await openPage('fresh');
    await p.locator('[data-action="toggle-notes"]').click();
    await p.locator('.notes-empty', { hasText: 'No notes yet.' }).waitFor();
    assert.ok(await p.evaluate(() => !!window.__fakeGmail.labelByName('_Notes')));
    await p.context().close();
  });

  await r.step('notes in dark mode', async () => {
    const p = await openPage('', { colorScheme: 'dark' });
    await p.locator('[data-action="toggle-notes"]').click();
    await p.locator('.note-item[data-note="n:launchchecklist0004"]').click();
    await bodyReady(p, /Proofread the IFU/, 'loaded');
    await p.mouse.move(0, 0);
    await p.screenshot({ path: join(SCREENS, 'notes-dark.png'), animations: 'disabled' });
    await p.context().close();
  });

  await r.step('auth_required shows Connect Gmail, which then loads the board', async () => {
    const p = await openPage('state=auth_required');
    await p.locator('[data-action="toggle-board"]').click();
    const btn = p.locator('.panel button', { hasText: 'Connect Gmail' });
    await btn.waitFor();
    await p.screenshot({ path: join(SCREENS, 'state-connect.png'), animations: 'disabled' });
    await btn.click();
    await p.locator('.card').first().waitFor();
    await p.context().close();
  });

  await r.step('not_configured shows Open setup', async () => {
    const p = await openPage('state=not_configured');
    await p.locator('[data-action="toggle-board"]').click();
    const btn = p.locator('.panel button', { hasText: 'Open setup' });
    await btn.waitFor();
    await btn.click();
    await p.locator('.options-note').waitFor();
    await p.context().close();
  });

  await r.step('a failed move reverts the card and explains why', async () => {
    const p = await openPage('fail=modify');
    await openBoard(p);
    const id = await findThread(p, 'Deadline moved');
    await drag(p, id, p.locator('section[data-col="doing"] .list'));
    const toast = p.locator('.toast-error');
    await toast.waitFor();
    assert.match(await toast.innerText(), /Couldn’t move “Deadline moved to Thursday 10:00”: Backend Error/);
    await until(async () => (await ids(p, 'todo')).includes(id), 'card back in To do');
    assert.deepEqual(await labelsOf(p, id), ['INBOX', 'STARRED', '_Board/To do']);
    await p.screenshot({ path: join(SCREENS, 'error-toast.png'), animations: 'disabled' });
    await p.context().close();
  });

  await r.step('a move made while a refresh is in flight is not undone by it', async () => {
    const p = await openPage('latency=400');
    await openBoard(p);
    const id = await findThread(p, 'Deadline moved');
    await p.locator('button[aria-label="Refresh"]').click();
    await p.waitForTimeout(450); // labels.list done, threads.list calls in flight
    await drag(p, id, p.locator('section[data-col="waiting"] .list'));
    // The first refresh returns pre-move lists; the card must stay put
    // through that and the refresh that replaces it.
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      assert.ok((await ids(p, 'waiting')).includes(id), 'card snapped back during refresh');
      await p.waitForTimeout(100);
    }
    await waitForLabels(p, id, { has: ['_Board/Waiting'], lacks: ['_Board/To do'] }, 'labels after racing move');
    await until(async () => !(await p.locator('.spinning').count()), 'refresh settled', 8000);
    assert.ok((await ids(p, 'waiting')).includes(id));
    await p.context().close();
  });

  await r.step('a fresh mailbox gets its labels created, parents first', async () => {
    const p = await openPage('fresh');
    await p.locator('[data-action="toggle-board"]').click();
    await until(async () => (await p.locator('.list:empty').count()) === 4, 'four empty columns');
    const names = await p.evaluate(() => window.__fakeGmail.labelNames());
    for (const n of ['_Board', '_Board/To do', '_Board/Doing', '_Board/Waiting', '_Board/Done']) assert.ok(names.includes(n), n);
    await p.context().close();
  });

  await r.step('a column with more than a page says so', async () => {
    const p = await openPage('page=3');
    await openBoard(p);
    assert.equal(await p.locator('section[data-col="todo"] .col-note').innerText(), 'Showing the first 100 threads');
    assert.equal(await p.locator('section[data-col="todo"] .col-count').innerText(), '3+');
    await p.context().close();
  });

  // ── The calendar ─────────────────────────────────────────────────────

  const openCalendar = async p => {
    await p.locator('[data-action="toggle-calendar"]').click();
    await p.locator('.cal .ev').first().waitFor();
  };
  const weekText = p => p.locator('.cal-week').innerText();
  const calTitle = p => p.locator('.cal-title').innerText();

  await r.step('calendar: the week from Google Calendar and Google Tasks, beside the sources and the tasks with no date', async () => {
    const p = await openPage();
    await openCalendar(p);
    assert.equal(await p.locator('.tab[aria-selected="true"]').innerText(), 'Calendar');
    assert.match(await calTitle(p), /^Week \d+ · /);
    const days = p.locator('.cal-week > .day:not(.mini-tile)');
    assert.equal(await days.count(), 7);
    const ys = await days.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(ys).size, 1, 'seven columns side by side');
    assert.equal(await p.locator('.mini-tile').isVisible(), false, 'the small month is in the sidebar instead');
    assert.equal(await p.locator('.cal-week .day.today .badge').textContent(), 'today', 'named, for a screen reader; by the hour, its date is ringed');

    const text = await weekText(p);
    for (const t of ['Kestrel Medical: kick-off call', 'Lumenra glossary delivery', 'Grandma’s birthday', 'Quote for Ingrid', 'Proofread the IFU']) {
      assert.ok(text.includes(t), t);
    }
    for (const t of ['Working from home', 'Cancelled: weekly sync', 'Old and deleted']) assert.ok(!text.includes(t), `not ${t}`);
    assert.equal(await p.locator('.task.done').filter({ hasText: 'Proofread the IFU' }).count(), 1);
    const kickOff = p.locator('.cal-week .ev').filter({ hasText: 'Kestrel Medical: kick-off call' });
    assert.equal(await kickOff.locator('.time').innerText(), '09:30 – 10:15', 'the 24-hour clock, whatever the browser’s language');

    // Each links to where it lives in Google, in a tab of its own (Ctrl-click;
    // a plain click opens the editor). A task's box is a button of its own.
    const quote = p.locator('.cal-week .task').filter({ hasText: 'Quote for Ingrid' }).locator('a.task-link');
    assert.equal(await quote.getAttribute('href'), 'https://mail.google.com/mail/#all/quote-request');
    assert.equal(await quote.getAttribute('target'), '_blank');
    assert.equal(await quote.locator('.mail').count(), 1, 'made from an email');
    assert.match(await p.locator('.cal-week a.ev').first().getAttribute('href'), /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);

    assert.deepEqual(await p.locator('.cal-sources .src-name').allInnerTexts(),
      ['test', 'Jobs', 'Family', 'Holidays in the United Kingdom', 'My Tasks', 'Admin']);
    assert.equal(await p.locator('.src').filter({ hasText: 'Holidays' }).getAttribute('aria-pressed'), 'false', 'off, as in Google');
    const tray = await p.locator('.cal-tray').innerText();
    for (const t of ['Overdue', 'Back up the TMs', 'No date', 'Renew the guild membership', 'Order printer toner']) assert.ok(tray.includes(t), t);

    // Reads only, and only of the four kinds.
    const calls = await p.evaluate(() => window.__mockChrome.log.filter(l => l.type === 'google'));
    assert.ok(calls.length >= 6);
    assert.ok(calls.every(c => /^(users\/me\/calendarList|calendars\/[^/]+\/events|users\/@me\/lists|lists\/[^/]+\/tasks)$/.test(c.path)), 'reads only');
    assert.ok(!calls.some(c => c.path.includes('holiday')), 'a calendar that is off is not read');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-week.png'), animations: 'disabled' });
    await p.context().close();
  });

  await r.step('calendar: Month and Agenda, the keys, and the small month', async () => {
    const p = await openPage();
    await openCalendar(p);
    const thisWeek = await calTitle(p);
    await p.locator('[data-key="cal-view:month"]').click();
    await p.locator('.cal-month').waitFor();
    assert.equal((await p.locator('.mcell').count()) % 7, 0);
    assert.match(await calTitle(p), /^[A-Z][a-z]+ \d{4}$/);
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-month.png'), animations: 'disabled' });

    await p.keyboard.press('a');
    await p.locator('.cal-agenda .aday').first().waitFor();
    await until(async () => (await p.locator('.cal-agenda').innerText()).includes('Planning call with Grace'), 'next week in the agenda');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-agenda.png'), animations: 'disabled' });

    await p.keyboard.press('w');
    await p.locator('.cal-week').waitFor();
    assert.equal(await calTitle(p), thisWeek);
    await p.keyboard.press('j');
    await until(async () => (await weekText(p)).includes('Planning call with Grace'), 'the next week');
    assert.notEqual(await calTitle(p), thisWeek);
    await p.keyboard.press('t');
    await until(async () => (await calTitle(p)) === thisWeek, 'back to today');

    // A day in the small month goes to its week.
    const next = await p.evaluate(() => window.__fakeCalendar.day(8));
    await p.locator(`[data-key="cal-mini:${next}"]`).first().click();
    await until(async () => (await weekText(p)).includes('MedTech translators’ conference'), 'that week');
    const pref = await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarView'))['pref:test@example.com:calendarView']);
    assert.equal(pref, 'week', 'the view is remembered');
    await p.context().close();
  });

  await r.step('calendar: it opens on the view used last time, and reads that view’s days', async () => {
    const p = await openPage();
    await p.evaluate(() => chrome.storage.local.set({ 'pref:test@example.com:calendarView': 'month' }));
    await p.locator('[data-action="toggle-calendar"]').click();
    await p.locator('.cal-month .ev').first().waitFor();
    assert.equal(await p.locator('[data-key="cal-view:month"]').getAttribute('aria-selected'), 'true');
    const [wanted, asked] = await p.evaluate(() => {
      const cal = window.gkb.calendarLogic;
      const { start } = cal.viewRange('month', cal.dateKey(new Date()));
      const events = window.__mockChrome.log.filter(l => l.type === 'google' && /\/events$/.test(l.path));
      return [cal.fromKey(cal.addDays(start, -1)).toISOString(), events.map(l => l.query.timeMin)];
    });
    assert.ok(asked.length && asked.every(t => t === wanted), 'the month’s days, not the week’s');
    await p.context().close();
  });

  await r.step('calendar: a source shows or hides with a click, and it is remembered', async () => {
    const p = await openPage();
    await openCalendar(p);
    await p.locator('.src').filter({ hasText: 'Family' }).click();
    await until(async () => !(await weekText(p)).includes('Pub quiz'), 'Family hidden');
    assert.equal(await p.locator('.src').filter({ hasText: 'Family' }).getAttribute('aria-pressed'), 'false');
    await p.locator('.src').filter({ hasText: 'My Tasks' }).click();
    await until(async () => !(await weekText(p)).includes('Quote for Ingrid'), 'My Tasks hidden');
    assert.ok(!(await p.locator('.cal-tray').innerText()).includes('Renew the guild membership'));

    // Switched on: read now, as it was not before.
    await p.locator('.src').filter({ hasText: 'Holidays' }).click();
    await until(async () => (await p.evaluate(() => window.__mockChrome.log.some(l => l.type === 'google' && l.path.includes('holiday')))), 'read');
    await p.keyboard.press('j');
    await p.keyboard.press('j');
    await until(async () => (await weekText(p)).includes('Bank holiday'), 'the holiday, two weeks on');

    const saved = await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarSources'))['pref:test@example.com:calendarSources']);
    assert.equal(saved['c_family@group.calendar.google.com'], false);
    assert.equal(saved['en.uk#holiday@group.v.calendar.google.com'], true);
    await p.context().close();
  });

  await r.step('calendar: connecting it is a step of its own, and the board never needed it', async () => {
    const p = await openPage('calendar=signin');
    await openBoard(p);
    await p.locator('[data-key="view:calendar"]').click();
    await p.locator('.panel', { hasText: 'Connect Google Calendar' }).waitFor();
    assert.match(await p.locator('.panel').innerText(), /only reads them/);
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-connect.png'), animations: 'disabled' });
    await p.locator('.panel .btn-primary').click();
    await p.locator('.cal .ev').first().waitFor();
    // The board's own sign-in was never touched.
    await p.locator('[data-key="view:board"]').click();
    await p.locator('.card').first().waitFor();
    await p.context().close();
  });

  await r.step('calendar: Tasks not allowed says so, with a way to fix it, and the events still show', async () => {
    const p = await openPage('calendar=notasks');
    await openCalendar(p);
    await until(async () => /Google Tasks needs your permission/.test(await p.locator('.cal-note').innerText()), 'the note');
    assert.equal(await p.locator('.cal-note .btn').innerText(), 'Connect again');
    assert.ok((await weekText(p)).includes('Lumenra glossary delivery'));
    await p.context().close();
  });

  await r.step('calendar: narrow, it is the phone’s week, two columns of days; and in dark mode', async () => {
    const p = await openPage('', { colorScheme: 'dark' });
    await openCalendar(p);
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-dark.png'), animations: 'disabled' });
    await p.setViewportSize({ width: 560, height: 900 });
    await until(async () => (await p.locator('.cal').getAttribute('data-narrow')) === 'true', 'narrow');
    assert.equal(await p.locator('.mini-tile').isVisible(), true);
    assert.equal(await p.locator('.cal-views').isVisible(), false);
    const days = p.locator('.cal-week > .day:not(.mini-tile)');
    const [mon, tue, fri] = await Promise.all([0, 1, 4].map(i => days.nth(i).boundingBox()));
    assert.ok(tue.y > mon.y && Math.abs(tue.x - mon.x) < 2, 'Tuesday under Monday');
    assert.ok(Math.abs(fri.y - mon.y) < 2 && fri.x > mon.x, 'Friday beside Monday');
    assert.match(await calTitle(p), /^W\d+ \d+/, 'the week’s number, short, ahead of its days');
    assert.equal(await p.locator('.cal-title').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, 'all of it');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-narrow.png'), animations: 'disabled' });

    // The month: a grid of days, a line for each thing on them; a tap on a
    // day opens its week. Narrow and wide each keep their own view.
    const toggle = p.locator('[data-key="cal-phone-view"]');
    assert.equal(await toggle.getAttribute('aria-label'), 'Show the month');
    await toggle.click();
    await p.locator('.phone-month').waitFor();
    const thursday = await p.evaluate(() => window.__fakeCalendar.day(3));
    const [y, m] = thursday.split('-').map(Number);
    const monthTitle = `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
    if (thursday.slice(0, 7) === (await p.evaluate(() => window.__fakeCalendar.day(0))).slice(0, 7)) assert.equal(await calTitle(p), monthTitle);
    assert.equal(await toggle.getAttribute('aria-label'), 'Show the week');
    assert.equal(await p.locator('[data-key="cal-order"]').isVisible(), false, 'the order of the days is the week’s');
    const cells = p.locator('.phone-month .mcell');
    assert.equal((await cells.count()) % 7, 0);
    const cell = p.locator(`.phone-month .mcell[data-day="${thursday}"]`);
    await until(async () => /Lumenra glossary delivery/.test(await cell.innerText()), 'the month’s days read');
    assert.match(await cell.getAttribute('aria-label'), /Lumenra glossary delivery/, 'named in full, for a screen reader');
    assert.equal(await p.locator('.phone-month .mcell.today').count(), 1);
    assert.equal(await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarPhoneView'))['pref:test@example.com:calendarPhoneView']), 'month', 'remembered');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-narrow-month.png'), animations: 'disabled' });
    await p.locator('[data-key="cal-next"]').click();
    await until(async () => (await calTitle(p)) !== monthTitle, 'the next month');
    await p.locator('[data-key="cal-prev"]').click();
    await cell.click();
    await p.locator('.cal-week').waitFor();
    assert.ok(await p.locator(`.cal-week > .day[data-day="${thursday}"]`).count(), 'that day’s week');
    assert.equal(await toggle.getAttribute('aria-label'), 'Show the month');
    // The week's small month opens the month too.
    await p.locator('.mini-tile [data-key="cal-mini-month"]').click();
    await p.locator('.phone-month').waitFor();
    // Wide again: the computer's view, as it was.
    await p.setViewportSize({ width: 1440, height: 900 });
    await until(async () => (await p.locator('.cal').getAttribute('data-narrow')) === 'false', 'wide');
    await p.locator('.cal-week.hours').waitFor();
    assert.equal(await toggle.isVisible(), false);
    await p.context().close();
  });

  // ── The calendar, both ways ──

  const fakeEvent = (p, title) => p.evaluate(t => {
    const e = window.__fakeCalendar.events.find(x => x.summary === t);
    return e ? JSON.parse(JSON.stringify(e)) : null;
  }, title);
  const fakeTask = (p, title) => p.evaluate(t => {
    const x = window.__fakeCalendar.tasks.find(y => y.title === t);
    return x ? JSON.parse(JSON.stringify(x)) : null;
  }, title);
  // Every change the calendar sent, in order.
  const sentChanges = p => p.evaluate(() => window.__mockChrome.log
    .filter(l => l.type === 'google' && l.method && l.method !== 'GET')
    .map(l => ({ method: l.method, path: l.path, body: l.body || null, etag: l.etag || '' })));
  const weekDay = (p, i) => p.locator('.cal-week > .day[data-day]').nth(i);
  const dayKey = (p, offset) => p.evaluate(o => window.__fakeCalendar.day(o), offset);
  const editor = p => p.locator('.cal-edit');
  // Google's own pages, opened from the calendar, answered here.
  const noGoogle = p => p.context().route(/^https:\/\/(www\.google\.com|tasks\.google\.com|mail\.google\.com)\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));

  await r.step('calendar: an event opened here is changed here, in Google, with the version it was read at', async () => {
    const p = await openPage();
    await openCalendar(p);
    const before = await fakeEvent(p, 'Lumenra glossary delivery');
    await p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }).click();
    await editor(p).waitFor();
    assert.equal(await editor(p).locator('h2').innerText(), 'Event');
    assert.equal(await editor(p).locator('#gkb-cal-calendar').innerText(), 'Jobs', 'which calendar, not changeable here');
    assert.equal(await p.locator('[data-key="cal-edit-start-time"]').inputValue(), '14:00', 'the 24-hour clock');
    await p.locator('[data-key="cal-edit-title"]').fill('Lumenra glossary: final delivery');
    await p.locator('[data-key="cal-edit-start-time"]').fill('15:30');
    await p.locator('[data-key="cal-edit-end-time"]').fill('16.15');
    await p.locator('[data-key="cal-edit-where"]').fill('By email');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-edit.png'), animations: 'disabled' });
    await p.locator('[data-key="cal-edit-save"]').click();
    await editor(p).waitFor({ state: 'detached' });

    const after = await fakeEvent(p, 'Lumenra glossary: final delivery');
    const thursday = await dayKey(p, 3);
    assert.ok(after.start.dateTime.startsWith(`${thursday}T15:30:00`), after.start.dateTime);
    assert.ok(after.end.dateTime.startsWith(`${thursday}T16:15:00`), after.end.dateTime);
    assert.equal(after.location, 'By email');
    const [sent] = (await sentChanges(p)).slice(-1);
    assert.equal(sent.method, 'PATCH');
    assert.equal(sent.etag, before.etag, 'the version it was read at');
    assert.deepEqual(Object.keys(sent.body).sort(), ['end', 'location', 'start', 'summary'], 'nothing but what the editor edits');
    await until(async () => /Lumenra glossary: final delivery\s+15:30 – 16:15/.test(await weekDay(p, 3).innerText()), 'on screen as Google has it');
    await p.context().close();
  });

  await r.step('calendar: someone else’s meeting and a read-only calendar are not changed here: they open in Google', async () => {
    const p = await openPage();
    await noGoogle(p);
    await openCalendar(p);
    const quiz = p.locator('.cal-week a.ev', { hasText: 'Pub quiz' });
    assert.equal(await quiz.getAttribute('draggable'), null, 'not draggable');
    const [tab] = await Promise.all([p.context().waitForEvent('page'), quiz.click()]);
    assert.match(tab.url(), /^https:\/\/www\.google\.com\/calendar\/event/);
    await tab.close();
    assert.equal(await editor(p).count(), 0, 'no editor');
    // Holidays, shared read-only.
    await p.locator('.src').filter({ hasText: 'Holidays' }).click();
    await p.keyboard.press('j');
    await p.keyboard.press('j');
    const holiday = p.locator('.cal-week .ev', { hasText: 'Bank holiday' });
    await holiday.waitFor();
    assert.equal(await holiday.getAttribute('draggable'), null);
    // Ctrl-click on one that can be changed still opens it in Google.
    await p.keyboard.press('t');
    const call = p.locator('.cal-week a.ev', { hasText: 'Call Bram about the office action' });
    await call.waitFor();
    const [tab2] = await Promise.all([p.context().waitForEvent('page'), call.click({ modifiers: ['Control'] })]);
    await tab2.close();
    assert.equal(await editor(p).count(), 0);
    assert.deepEqual(await sentChanges(p), [], 'nothing was changed');
    await p.context().close();
  });

  await r.step('calendar: a task’s box ticks it off in Google Tasks, and back', async () => {
    const p = await openPage();
    await openCalendar(p);
    const box = () => p.locator('.cal-week .task', { hasText: 'Send invoice 2026-131' }).locator('button.box');
    assert.equal(await box().getAttribute('aria-checked'), 'false');
    await box().click();
    assert.equal(await box().getAttribute('aria-checked'), 'true', 'at once');
    await until(async () => (await fakeTask(p, 'Send invoice 2026-131')).status === 'completed', 'ticked off in Google Tasks');
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    await box().click();
    await until(async () => {
      const t = await fakeTask(p, 'Send invoice 2026-131');
      return t.status === 'needsAction' && !t.completed;
    }, 'not done again');
    assert.deepEqual((await sentChanges(p)).map(c => [c.method, Object.keys(c.body).sort().join()]),
      [['PATCH', 'status'], ['PATCH', 'completed,status']]);
    await p.context().close();
  });

  await r.step('calendar: dragged to another day’s head - an event keeps its time, a task gets the day, or none in the tray', async () => {
    const p = await openPage();
    await openCalendar(p);
    const [monday, tuesday, wednesday, friday] = await Promise.all([0, 1, 2, 4].map(o => dayKey(p, o)));
    await p.locator('.cal-week a.ev', { hasText: 'Kestrel Medical: kick-off call' }).dragTo(weekDay(p, 4).locator('.day-head'));
    await until(async () => (await fakeEvent(p, 'Kestrel Medical: kick-off call')).start.dateTime.startsWith(`${friday}T09:30`), 'Friday, still 09:30');
    assert.ok((await fakeEvent(p, 'Kestrel Medical: kick-off call')).end.dateTime.startsWith(`${friday}T10:15`));
    await until(async () => (await weekDay(p, 4).innerText()).includes('Kestrel Medical'), 'on Friday');
    assert.ok(!(await weekDay(p, 1).innerText()).includes('Kestrel Medical'), 'not Tuesday');

    const tray = p.locator('.cal-tray');
    await tray.locator('.task', { hasText: 'Order printer toner' }).dragTo(weekDay(p, 2));
    await until(async () => (await fakeTask(p, 'Order printer toner')).due === `${wednesday}T00:00:00.000Z`, 'a day of its own');
    await until(async () => (await weekDay(p, 2).innerText()).includes('Order printer toner'), 'on Wednesday');
    await weekDay(p, 2).locator('.task', { hasText: 'Order printer toner' }).dragTo(tray);
    await until(async () => !(await fakeTask(p, 'Order printer toner')).due, 'no day again');
    await until(async () => (await tray.innerText()).includes('Order printer toner'), 'back in the tray');

    // An event has a day, always: it does not go to No date.
    const before = (await sentChanges(p)).length;
    await weekDay(p, 2).locator('a.ev', { hasText: 'Call Bram' }).dragTo(tray);
    assert.equal((await sentChanges(p)).length, before, 'nothing sent');

    // Twice, before Google's answer to the first is read back: the second
    // names the version the first made, so no false "changed meanwhile".
    await weekDay(p, 2).locator('a.ev', { hasText: 'Call Bram' }).dragTo(weekDay(p, 0).locator('.day-head'));
    await weekDay(p, 0).locator('a.ev', { hasText: 'Call Bram' }).dragTo(weekDay(p, 1).locator('.day-head'));
    await until(async () => (await fakeEvent(p, 'Call Bram about the office action')).start.dateTime.startsWith(`${tuesday}T11:00`), 'Tuesday');
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    assert.equal(await p.locator('.toast-error').count(), 0, 'no error');
    assert.ok((await weekDay(p, 1).innerText()).includes('Call Bram'));
    assert.ok(!(await weekDay(p, 0).innerText()).includes('Call Bram'), `not ${monday}`);
    await p.context().close();
  });

  // ── The week by the hour ──

  // Where a time of day is on a day's hours, on the page; and where an
  // event is on them, in minutes after midnight. The hours on screen run
  // from and to the week's data-span, in minutes.
  const spanOf = async p => (await p.locator('.cal-week').getAttribute('data-span')).split('-').map(Number);
  const hourPoint = async (p, i, minutes, dx = 0.5) => {
    const [from, to] = await spanOf(p);
    const box = await weekDay(p, i).locator('.grid-body').boundingBox();
    const at = { x: box.x + box.width * dx, y: box.y + box.height * (minutes - from) / (to - from) };
    const view = p.viewportSize();
    assert.ok(at.y > 0 && at.y < view.height, `${minutes} minutes is on screen`);
    return at;
  };
  const minutesOf = (p, el) => el.evaluate(e => {
    const [from, to] = e.closest('.cal-week').dataset.span.split('-').map(Number);
    const body = e.closest('.grid-body').getBoundingClientRect();
    const b = e.getBoundingClientRect();
    const m = y => Math.round(from + (y - body.top) / body.height * (to - from));
    return { from: m(b.top), to: m(b.bottom), left: Math.round(b.left), width: Math.round(b.width) };
  });
  const night = p => p.locator('[data-key="cal-night"]');

  await r.step('calendar: by the hour - events where they happen, all-day ones and tasks above, the line for now, and a second time zone', async () => {
    const p = await openPage();
    await openCalendar(p);
    assert.equal(await p.locator('.cal-week.hours').count(), 1, 'wide, the week is by the hour');
    const week = p.locator('.cal-week');
    // The day, seven to ten, filling the space: nothing to scroll.
    assert.deepEqual(await spanOf(p), [420, 1320]);
    assert.equal(await p.locator('.grid-hour').count(), 15);
    assert.equal(await p.locator('.grid-hour .own').first().textContent(), '07:00');
    assert.ok(await week.evaluate(e => e.scrollHeight <= e.clientHeight + 1), 'no scrolling');
    const bottom = await weekDay(p, 0).locator('.grid-body').evaluate(e => e.getBoundingClientRect().bottom);
    assert.ok(Math.abs(bottom - (await week.boundingBox()).y - (await week.boundingBox()).height) < 4, 'down to the bottom of the view');

    const kickOff = await minutesOf(p, weekDay(p, 1).locator('a.ev', { hasText: 'Kestrel Medical' }));
    assert.ok(Math.abs(kickOff.from - 570) <= 2 && Math.abs(kickOff.to - 615) <= 3, `09:30 to 10:15: ${JSON.stringify(kickOff)}`);
    assert.equal(await weekDay(p, 6).locator('.grid-allday', { hasText: 'Grandma’s birthday' }).count(), 1, 'all day: above the hours');
    assert.equal(await weekDay(p, 4).locator('.grid-allday .task', { hasText: 'Quote for Ingrid' }).count(), 1, 'a task: above the hours');
    assert.equal(await p.locator('.grid-body .task, .grid-body .all-day').count(), 0, 'neither in the hours');
    assert.equal(await p.locator('.now-line').count(), 1);
    assert.equal(await p.locator('.day.today .now-line').count(), 1, 'the line for now, today only');

    // The moon: all 24 hours, opened a little before seven, the night
    // shaded; remembered; and back.
    assert.equal(await night(p).getAttribute('aria-pressed'), 'false');
    await night(p).click();
    await until(async () => (await p.locator('.grid-hour').count()) === 24, 'all 24 hours');
    assert.equal(await night(p).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await spanOf(p), [0, 1440]);
    assert.ok(await week.evaluate(e => e.scrollTop > 0 && e.scrollHeight > e.clientHeight), 'they scroll, opened past the night');
    assert.equal(await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarNight'))['pref:test@example.com:calendarNight']), true, 'remembered');
    // Held at the top while the hours scroll.
    await week.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const head = await weekDay(p, 0).locator('.day-head').boundingBox();
    const weekBox = await week.boundingBox();
    assert.ok(Math.abs(head.y - weekBox.y) < 3, 'the days’ heads stay put');
    assert.ok((await p.locator('.grid-corner').boundingBox()).y - weekBox.y < 3);
    await night(p).click();
    await until(async () => (await p.locator('.grid-hour').count()) === 15, 'the day again');
    assert.equal(await week.evaluate(e => e.scrollTop), 0);

    // A second time zone, beside your own.
    const zones = p.locator('[data-key="cal-zones"]');
    assert.equal(await zones.getAttribute('aria-label'), 'Add a second time zone');
    await zones.click();
    await p.locator('.cal-zones').waitFor();
    await p.locator('[data-key="cal-zone2"]').selectOption('America/New_York');
    await p.locator('[data-key="cal-zones-done"]').click();
    await until(async () => (await p.locator('.grid-zones span').count()) === 2, 'two time zones');
    // New York's hour and offset on the day the hours are worked out for:
    // today, in this week.
    const want = await p.evaluate(() => {
      const now = new Date();
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
      const f = o => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'America/New_York' }, o));
      return [f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at),
        f({ timeZoneName: 'shortOffset' }).formatToParts(at).find(x => x.type === 'timeZoneName').value];
    });
    assert.match(want[1], /^GMT-[45]$/);
    const nine = await p.locator('.grid-hour').nth(2).evaluate(e => [...e.children].map(x => x.textContent));
    assert.deepEqual(nine, [want[0], '09:00'], 'the second time zone’s hour beside your own');
    assert.equal(await p.locator('.grid-zones .other').innerText(), want[1]);
    assert.equal(await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarZone2'))['pref:test@example.com:calendarZone2']), 'America/New_York', 'remembered');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-hours.png'), animations: 'disabled' });
    await zones.click();
    await p.locator('[data-key="cal-zone2"]').selectOption('');
    await p.locator('[data-key="cal-zones-done"]').click();
    await until(async () => (await p.locator('.grid-zones span').count()) === 1, 'one again');
    assert.equal(await p.locator('.cal-zones').count(), 0);
    await p.context().close();

    // A time zone that is no such thing is not used.
    const q = await openPage();
    await q.evaluate(() => chrome.storage.local.set({ 'pref:test@example.com:calendarZone2': 'Mars/Olympus_Mons' }));
    await openCalendar(q);
    assert.equal(await q.locator('.grid-zones span').count(), 1);

    // Something on in the night: the hours widen to show it, and it alone.
    await weekDay(q, 2).locator('.day-add').click();
    await editor(q).waitFor();
    await q.keyboard.type('Early ferry 05:30');
    await q.keyboard.press('Enter');
    await until(async () => (await spanOf(q))[0] === 300, 'from five');
    assert.equal(await q.locator('.grid-hour .own').first().textContent(), '05:00');
    assert.equal((await spanOf(q))[1], 1320, 'still to ten at night');
    const ferry = await minutesOf(q, q.locator('.cal-week a.ev', { hasText: 'Early ferry' }));
    assert.ok(Math.abs(ferry.from - 330) <= 3, JSON.stringify(ferry));
    assert.equal(await q.locator('.cal-week').evaluate(e => e.scrollTop), 0, 'from its top');
    await q.context().close();
  });

  await r.step('calendar: by the hour - dragged to another time, in quarter hours, an event keeps its length; overlapping ones go side by side', async () => {
    const p = await openPage();
    await openCalendar(p);
    const [tuesday, thursday] = await Promise.all([1, 3].map(o => dayKey(p, o)));
    const kickOff = () => p.locator('.cal-week a.ev', { hasText: 'Kestrel Medical: kick-off call' });
    // Held 6px down from its top, let go 6px below 15:00 on Thursday.
    const from = await kickOff().boundingBox();
    const to = await hourPoint(p, 3, 15 * 60);
    await p.mouse.move(from.x + 20, from.y + 6);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y + 10, { steps: 4 });
    await p.mouse.move(to.x, to.y + 6, { steps: 2 });
    const ghost = p.locator('.drop-ghost');
    await ghost.waitFor();
    assert.equal(await ghost.innerText(), '15:00 – 15:45', 'where it would go, shown while dragging');
    await p.mouse.up();
    await until(async () => (await fakeEvent(p, 'Kestrel Medical: kick-off call')).start.dateTime.startsWith(`${thursday}T15:00`), 'Thursday at 15:00');
    assert.ok((await fakeEvent(p, 'Kestrel Medical: kick-off call')).end.dateTime.startsWith(`${thursday}T15:45`), 'still three quarters of an hour');
    assert.equal(await ghost.count(), 0);
    const sent = (await sentChanges(p)).at(-1);
    assert.deepEqual([sent.method, Object.keys(sent.body).sort().join(), !!sent.etag], ['PATCH', 'end,start', true], 'its times only, at the version read');

    // The same day, later: to the nearest quarter hour.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    const now = await kickOff().boundingBox();
    const later = await hourPoint(p, 3, 16 * 60 + 20);
    await p.mouse.move(now.x + 20, now.y + 6);
    await p.mouse.down();
    await p.mouse.move(later.x, later.y + 10, { steps: 4 });
    await p.mouse.move(later.x, later.y + 6, { steps: 2 });
    await p.mouse.up();
    await until(async () => (await fakeEvent(p, 'Kestrel Medical: kick-off call')).start.dateTime.startsWith(`${thursday}T16:15`), '16:15, not 16:20');
    assert.ok(!(await weekDay(p, 1).innerText()).includes('Kestrel Medical'), `not on ${tuesday}`);

    // Let go where it already is: nothing is sent.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    const count = (await sentChanges(p)).length;
    const here = await kickOff().boundingBox();
    await p.mouse.move(here.x + 20, here.y + 6);
    await p.mouse.down();
    await p.mouse.move(here.x + 24, here.y + 9, { steps: 3 });
    await p.mouse.move(here.x + 20, here.y + 7, { steps: 2 });
    await p.mouse.up();
    await p.waitForTimeout(300);
    assert.equal((await sentChanges(p)).length, count, 'nothing sent');

    // Lumenra's delivery is 14:00 to 15:00 that day: dropped at 14:30,
    // the two share the hour, side by side.
    const lumenra = p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' });
    const k = await kickOff().boundingBox();
    const half = await hourPoint(p, 3, 14 * 60 + 30);
    await p.mouse.move(k.x + 20, k.y + 6);
    await p.mouse.down();
    await p.mouse.move(half.x, half.y + 10, { steps: 4 });
    await p.mouse.move(half.x, half.y + 6, { steps: 2 });
    await p.mouse.up();
    await until(async () => (await fakeEvent(p, 'Kestrel Medical: kick-off call')).start.dateTime.startsWith(`${thursday}T14:30`), '14:30');
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    const [a, b] = [await minutesOf(p, lumenra), await minutesOf(p, kickOff())];
    assert.ok(b.left >= a.left + a.width - 2, `side by side: ${JSON.stringify([a, b])}`);
    assert.ok(Math.abs(a.width - b.width) < 3, 'half each');
    assert.equal(await p.locator('.toast-error').count(), 0, 'no error');
    await p.context().close();
  });

  await r.step('calendar: by the hour - an event’s bottom edge changes when it ends; a click on an empty half hour adds one there', async () => {
    const p = await openPage();
    await openCalendar(p);
    const [monday, thursday, friday] = await Promise.all([0, 3, 4].map(o => dayKey(p, o)));
    const edge = p.locator('.grid-resize[title*="Lumenra glossary delivery"]');
    const was = await fakeEvent(p, 'Lumenra glossary delivery');
    const e = await edge.boundingBox();
    const end = await hourPoint(p, 3, 16 * 60 + 30);
    await p.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
    await p.mouse.down();
    await p.mouse.move(end.x, end.y - 20, { steps: 4 });
    await p.mouse.move(end.x, end.y + 3, { steps: 2 });
    assert.equal(await p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }).locator('.time').innerText(), '14:00 – 16:30', 'the new end, shown while dragging');
    await p.mouse.up();
    await until(async () => (await fakeEvent(p, 'Lumenra glossary delivery')).end.dateTime.startsWith(`${thursday}T16:30`), 'ends at 16:30');
    assert.deepEqual((await fakeEvent(p, 'Lumenra glossary delivery')).start, was.start, 'still starts at 14:00');
    const sent = (await sentChanges(p)).at(-1);
    assert.deepEqual([sent.method, Object.keys(sent.body).join(), !!sent.etag], ['PATCH', 'end', true], 'its end only, at the version read');
    assert.equal(await editor(p).count(), 0, 'letting go of the edge opens nothing');
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    const span = await minutesOf(p, p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }));
    assert.ok(Math.abs(span.to - 990) <= 3, `to 16:30 on screen: ${JSON.stringify(span)}`);

    // Not before a quarter of an hour after it starts.
    const e2 = await edge.boundingBox();
    const up = await hourPoint(p, 3, 13 * 60);
    await p.mouse.move(e2.x + e2.width / 2, e2.y + e2.height / 2);
    await p.mouse.down();
    await p.mouse.move(up.x, up.y, { steps: 6 });
    await p.mouse.up();
    await until(async () => (await fakeEvent(p, 'Lumenra glossary delivery')).end.dateTime.startsWith(`${thursday}T14:15`), 'a quarter of an hour, at least');

    // The button let go where the page never heard it (outside the
    // window): nothing changes, then or at the next click.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    const sentBefore = (await sentChanges(p)).length;
    const lost = await edge.evaluate((el, y) => {
      const r = el.getBoundingClientRect();
      const at = (type, clientY, buttons) => ({ bubbles: true, cancelable: true, pointerId: 7, button: type === 'pointerdown' ? 0 : -1, buttons, clientX: r.left + 10, clientY });
      el.dispatchEvent(new PointerEvent('pointerdown', at('pointerdown', r.top + 2, 1)));
      window.dispatchEvent(new PointerEvent('pointermove', at('pointermove', y, 1)));
      const during = el.parentNode.querySelector('.timed.resizing') ? 'resizing' : '';
      window.dispatchEvent(new PointerEvent('pointermove', at('pointermove', y + 40, 0)));
      window.dispatchEvent(new PointerEvent('pointerup', at('pointerup', y + 40, 0)));
      return [during, document.querySelectorAll('.timed.resizing').length];
    }, (await hourPoint(p, 3, 18 * 60)).y);
    assert.deepEqual(lost, ['resizing', 0], 'it stopped when the button was found let go');
    await p.waitForTimeout(300);
    assert.equal((await sentChanges(p)).length, sentBefore, 'nothing sent');
    assert.equal(await p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }).evaluate(e => e.style.getPropertyValue('--to')), '855', 'still to 14:15 on screen');

    // Someone else's meeting: no edge, and it does not move.
    assert.equal(await p.locator('.grid-resize[title*="Pub quiz"]').count(), 0);
    assert.equal(await p.locator('.cal-week .ev', { hasText: 'Pub quiz' }).getAttribute('draggable'), null);

    // A click on an empty half hour: a new event there, an hour long.
    const at = await hourPoint(p, 0, 13 * 60 + 10, 0.3);
    await p.mouse.click(at.x, at.y);
    await editor(p).waitFor();
    assert.equal(await p.locator('[data-key="cal-edit-kind:event"]').getAttribute('aria-pressed'), 'true', 'an event');
    assert.equal(await p.locator('[data-key="cal-edit-start-time"]').inputValue(), '13:00');
    assert.equal(await p.locator('[data-key="cal-edit-end-time"]').inputValue(), '14:00');
    assert.equal(await p.locator('[data-key="cal-edit-start-day"]').inputValue(), monday);
    await p.keyboard.type('Translation review');
    await p.keyboard.press('Enter');
    await until(async () => !!(await fakeEvent(p, 'Translation review')), 'added');
    const added = await fakeEvent(p, 'Translation review');
    assert.ok(added.start.dateTime.startsWith(`${monday}T13:00`) && added.end.dateTime.startsWith(`${monday}T14:00`), JSON.stringify(added));
    await until(async () => (await weekDay(p, 0).locator('.grid-body').innerText()).includes('Translation review'), 'in the hours');

    // Late in the evening, with the night shown, it ends the next day.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    await night(p).click();
    await until(async () => (await spanOf(p))[1] === 1440, 'the night shown');
    await p.locator('.cal-week').evaluate(w => { w.scrollTop = w.scrollHeight; });
    const late = await hourPoint(p, 4, 23 * 60 + 40, 0.3);
    await p.mouse.click(late.x, late.y);
    await editor(p).waitFor();
    assert.equal(await p.locator('[data-key="cal-edit-start-time"]').inputValue(), '23:30');
    assert.equal(await p.locator('[data-key="cal-edit-end-time"]').inputValue(), '00:30');
    assert.equal(await p.locator('[data-key="cal-edit-end-day"]').inputValue(), await dayKey(p, 5));
    assert.equal(await p.locator('[data-key="cal-edit-start-day"]').inputValue(), friday);
    await p.keyboard.press('Escape');
    await until(async () => (await editor(p).count()) === 0, 'closed');
    assert.equal(await p.locator('.overlay').isVisible(), true, 'the board stays open');
    await p.context().close();
  });

  await r.step('calendar: by the hour - a move or a new end that fails says so, and Google’s own times come back; the hours keep their place', async () => {
    const p = await openPage('calendar=failwrite');
    await openCalendar(p);
    const lumenra = () => p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' });
    const before = await minutesOf(p, lumenra());
    const was = await fakeEvent(p, 'Lumenra glossary delivery');
    const e = await p.locator('.grid-resize[title*="Lumenra glossary delivery"]').boundingBox();
    const end = await hourPoint(p, 3, 17 * 60);
    await p.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
    await p.mouse.down();
    await p.mouse.move(end.x, end.y, { steps: 5 });
    await p.mouse.up();
    await until(async () => /Couldn’t change when “Lumenra glossary delivery” ends: Backend Error/.test(await p.locator('.toast-error').innerText().catch(() => '')), 'it says so');
    await until(async () => Math.abs((await minutesOf(p, lumenra())).to - before.to) <= 2, 'back to 15:00');
    assert.deepEqual(await fakeEvent(p, 'Lumenra glossary delivery'), was, 'unchanged in Google');

    const from = await lumenra().boundingBox();
    const to = await hourPoint(p, 2, 10 * 60);
    await p.mouse.move(from.x + 20, from.y + 6);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y + 10, { steps: 4 });
    await p.mouse.move(to.x, to.y + 6, { steps: 2 });
    await p.mouse.up();
    await until(async () => (await p.locator('.toast-error', { hasText: 'Couldn’t move “Lumenra glossary delivery”' }).count()) > 0, 'it says so');
    assert.match(await p.locator('.toast-error', { hasText: 'Couldn’t move' }).innerText(), / at 10:00: Backend Error/);
    await until(async () => (await weekDay(p, 3).innerText()).includes('Lumenra glossary delivery'), 'back on Thursday');

    // Scrolled, the hours stay where they are through a redraw, and
    // through the month and back.
    await night(p).click();
    await until(async () => (await spanOf(p))[0] === 0, 'the night shown');
    const week = p.locator('.cal-week');
    await week.evaluate(w => { w.scrollTop = 200; });
    await p.waitForTimeout(100);
    await p.locator('.src', { hasText: 'Family' }).click();
    await p.locator('.src', { hasText: 'Family' }).click();
    assert.equal(await week.evaluate(w => w.scrollTop), 200, 'after a redraw');
    await p.keyboard.press('m');
    await p.locator('.cal-month').waitFor();
    await p.keyboard.press('w');
    await p.locator('.cal-week.hours').waitFor();
    assert.equal(await week.evaluate(w => w.scrollTop), 200, 'after the month');
    await p.context().close();
  });

  await r.step('calendar: the + on a day adds there - a time makes an event, no time a task', async () => {
    const p = await openPage();
    await openCalendar(p);
    const [monday, wednesday, saturday, sunday] = await Promise.all([0, 2, 5, 6].map(o => dayKey(p, o)));
    const me = await p.evaluate(() => window.__mockChrome.account);

    await weekDay(p, 2).locator('.day-add').click();
    await editor(p).waitFor();
    await p.keyboard.type('Hygienist 14:30');
    assert.equal(await p.locator('[data-key="cal-edit-kind:event"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await p.locator('[data-key="cal-edit-start-time"]').inputValue(), '14:30');
    assert.equal(await p.locator('[data-key="cal-edit-end-time"]').inputValue(), '15:30');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-add.png'), animations: 'disabled' });
    await p.keyboard.press('Enter');
    await until(async () => !!(await fakeEvent(p, 'Hygienist')), 'added, the time out of the title');
    const dentist = await fakeEvent(p, 'Hygienist');
    assert.equal(dentist.calendarId, me, 'in the main calendar');
    assert.ok(dentist.start.dateTime.startsWith(`${wednesday}T14:30`));
    await until(async () => /Hygienist\s+14:30/.test(await weekDay(p, 2).innerText()), 'on Wednesday');

    await weekDay(p, 5).locator('.day-add').click();
    await p.keyboard.type('Pay the invoice');
    assert.equal(await p.locator('[data-key="cal-edit-kind:task"]').getAttribute('aria-pressed'), 'true');
    await p.keyboard.press('Enter');
    await until(async () => (await fakeTask(p, 'Pay the invoice') || {}).due === `${saturday}T00:00:00.000Z`, 'a task on Saturday');
    assert.equal((await fakeTask(p, 'Pay the invoice')).list, await p.evaluate(() => window.__fakeCalendar.lists[0].id));

    // Chosen by hand: an all-day event.
    await weekDay(p, 6).locator('.day-add').click();
    await p.keyboard.type('Pack for the trip');
    await p.locator('[data-key="cal-edit-kind:event"]').click();
    await p.locator('[data-key="cal-edit-all-day"]').check();
    assert.equal(await p.locator('[data-key="cal-edit-start-time"]').isVisible(), false, 'no times');
    await p.locator('[data-key="cal-edit-save"]').click();
    await until(async () => !!(await fakeEvent(p, 'Pack for the trip')), 'added');
    const pack = await fakeEvent(p, 'Pack for the trip');
    assert.deepEqual([pack.start.date, pack.end.date], [sunday, await dayKey(p, 7)]);

    // What will not do never leaves the page.
    const before = (await sentChanges(p)).length;
    await weekDay(p, 0).locator('.day-add').click();
    await p.keyboard.type('Call 10:00');
    await p.locator('[data-key="cal-edit-end-time"]').fill('09:00');
    await p.keyboard.press('Enter');
    assert.equal(await editor(p).locator('.form-error').innerText(), 'It has to end after it starts.');
    await p.locator('[data-key="cal-edit-title"]').fill('');
    await p.keyboard.press('Enter');
    assert.equal(await editor(p).locator('.form-error').innerText(), 'Give it a title.');
    await p.keyboard.press('Escape');
    await editor(p).waitFor({ state: 'detached' });
    assert.equal((await sentChanges(p)).length, before, 'nothing sent');
    assert.ok(!(await weekDay(p, 0).innerText()).includes('Call'), `nothing on ${monday}`);
    await p.context().close();
  });

  await r.step('calendar: deleting asks first, waits out its Undo, and names the version it saw', async () => {
    const p = await openPage();
    await openCalendar(p);
    const title = 'Call Bram about the office action';
    const before = await fakeEvent(p, title);
    const call = () => p.locator('.cal-week a.ev', { hasText: title });

    // Asked, and kept.
    await call().click();
    await p.locator('[data-key="cal-edit-delete"]').click();
    const confirm = editor(p).locator('.cal-edit-confirm');
    assert.match(await confirm.innerText(), /Delete “Call Bram about the office action” from Jobs\?/);
    assert.equal(await p.locator('[data-key="cal-edit-save"]').isVisible(), false, 'nothing else to press meanwhile');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-delete.png'), animations: 'disabled' });
    await p.locator('[data-key="cal-edit-delete-no"]').click();
    assert.equal(await confirm.isVisible(), false);
    await p.keyboard.press('Escape');
    assert.equal(await call().count(), 1);

    // Deleted, then undone: Google never hears of it.
    await call().click();
    await p.locator('[data-key="cal-edit-delete"]').click();
    await p.locator('[data-key="cal-edit-delete-yes"]').click();
    assert.equal(await call().count(), 0, 'gone from the screen at once');
    const toastEl = p.locator('.toast', { hasText: 'Deleted “Call Bram about the office action”.' });
    await toastEl.locator('.toast-action').click();
    assert.equal(await call().count(), 1, 'back');
    await p.waitForTimeout(9500);
    assert.deepEqual(await sentChanges(p), [], 'nothing sent');
    assert.equal((await fakeEvent(p, title)).status, 'confirmed');

    // Deleted, and left: once the Undo has passed, Google is asked - for
    // that one event, at the version it was seen at.
    await call().click();
    await p.locator('[data-key="cal-edit-delete"]').click();
    await p.locator('[data-key="cal-edit-delete-yes"]').click();
    await p.waitForTimeout(4000);
    assert.deepEqual(await sentChanges(p), [], 'not yet: the Undo is still showing');
    await until(async () => (await fakeEvent(p, title)).status === 'cancelled', 'deleted in Google', 12000);
    assert.deepEqual(await sentChanges(p), [{
      method: 'DELETE', path: `calendars/${encodeURIComponent(before.calendarId)}/events/${before.id}`, body: null, etag: before.etag,
    }]);
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    assert.equal(await call().count(), 0, 'and stays gone');
    assert.ok((await fakeEvent(p, 'Lumenra glossary delivery')).status !== 'cancelled', 'nothing else');
    await p.context().close();
  });

  await r.step('calendar: something changed in Google meanwhile is neither deleted nor overwritten', async () => {
    const p = await openPage();
    await openCalendar(p);
    // Changed by someone else while it was open here.
    const changeInGoogle = (t, summary) => p.evaluate(([title, s]) => {
      const fc = window.__fakeCalendar;
      const e = fc.events.find(x => x.summary === title);
      fc.route('calendar', `calendars/${encodeURIComponent(e.calendarId)}/events/${e.id}`, {}, 'PATCH', { summary: s }, e.etag);
    }, [t, summary]);

    await p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }).click();
    await p.locator('[data-key="cal-edit-title"]').fill('Mine');
    await changeInGoogle('Lumenra glossary delivery', 'Lumenra, moved by Bram');
    await p.locator('[data-key="cal-edit-save"]').click();
    await until(async () => /changed in Google meanwhile, so nothing was saved/.test(await editor(p).locator('.form-error').innerText()), 'it says so');
    assert.equal((await fakeEvent(p, 'Lumenra, moved by Bram')).summary, 'Lumenra, moved by Bram', 'theirs stands');
    assert.equal(await fakeEvent(p, 'Mine'), null);
    await p.keyboard.press('Escape');
    await editor(p).waitFor({ state: 'detached' });
    assert.equal(await overlayVisible(p), true, 'Esc closed the editor, not the board');

    await until(async () => (await weekText(p)).includes('Lumenra, moved by Bram'), 'the latest on screen');
    await p.locator('.cal-week a.ev', { hasText: 'Kestrel Medical: kick-off call' }).click();
    await p.locator('[data-key="cal-edit-delete"]').click();
    await p.locator('[data-key="cal-edit-delete-yes"]').click();
    await changeInGoogle('Kestrel Medical: kick-off call', 'Kestrel Medical: kick-off call, new link');
    await until(async () => /Couldn’t delete “Kestrel Medical: kick-off call”: it was changed in Google meanwhile/.test(
      await p.locator('.toast-error').innerText().catch(() => '')), 'not deleted, and it says so', 12000);
    assert.equal((await fakeEvent(p, 'Kestrel Medical: kick-off call, new link')).status, 'confirmed');
    await until(async () => (await weekText(p)).includes('Kestrel Medical: kick-off call, new link'), 'back on screen');
    await p.context().close();
  });

  await r.step('calendar: a change that fails, or is not allowed yet, says so, and Google’s own version comes back', async () => {
    const p = await openPage('calendar=failwrite');
    await openCalendar(p);
    const box = () => p.locator('.cal-week .task', { hasText: 'Send invoice 2026-131' }).locator('button.box');
    await box().click();
    await until(async () => /Couldn’t tick off “Send invoice 2026-131”: Backend Error/.test(await p.locator('.toast-error').innerText().catch(() => '')), 'it says so');
    await until(async () => (await box().getAttribute('aria-checked')) === 'false', 'not ticked after all');
    assert.equal((await fakeTask(p, 'Send invoice 2026-131')).status, 'needsAction');
    await p.context().close();

    const q = await openPage('calendar=readonly');
    await openCalendar(q);
    await q.locator('.cal-week .task', { hasText: 'Send invoice 2026-131' }).locator('button.box').click();
    const err = q.locator('.toast-error', { hasText: 'changing your calendar needs your permission first' });
    await err.waitFor();
    assert.equal(await err.locator('.toast-action').innerText(), 'Connect again');
    await q.context().close();
  });

  await r.step('calendar: a change Google never answers gives up after half a minute, says so, and the calendar carries on', async () => {
    const p = await openPage('calendar=hangwrite');
    await openCalendar(p);
    const box = () => p.locator('.cal-week .task', { hasText: 'Send invoice 2026-131' }).locator('button.box');
    const reads = () => p.evaluate(() => window.__mockChrome.log.filter(l => l.type === 'google' && !l.method).length);
    await box().click();
    const before = await reads();
    await until(async () => /Google took too long to answer/.test(await p.locator('.toast-error').innerText().catch(() => '')), 'it gives up and says so', 40000);
    await until(async () => (await box().getAttribute('aria-checked')) === 'false', 'read again, and not ticked', 10000);
    assert.ok((await reads()) > before, 'the calendar reads Google again');
    await p.context().close();
  });

  // ── Repeating events ──

  const fakeById = (p, id) => p.evaluate(i => {
    const e = window.__fakeCalendar.events.find(x => x.id === i);
    return e ? JSON.parse(JSON.stringify(e)) : null;
  }, id);
  const standUp = p => p.locator('.cal-week a.ev', { hasText: 'Stand-up' });
  const repeatSelect = p => p.locator('[data-key="cal-edit-repeat"]');

  await r.step('calendar: a new event or one that did not repeat is set to repeat - from Google’s menu or a custom rule', async () => {
    const p = await openPage();
    await openCalendar(p);
    const friday = await dayKey(p, 4);
    await weekDay(p, 4).locator('.day-add').click();
    await p.keyboard.type('Gym 18:00');
    const options = await repeatSelect(p).locator('option').allInnerTexts();
    assert.deepEqual(options, ['Does not repeat', 'Daily', 'Weekly on Friday', 'Monthly on the ' + options[3].split('the ')[1], options[4],
      'Every weekday (Monday to Friday)', 'Custom…']);
    assert.match(options[3], /^Monthly on the (first|second|third|fourth|last) Friday$/);
    await repeatSelect(p).selectOption('weekly');
    await p.locator('[data-key="cal-edit-save"]').click();
    await until(async () => !!(await fakeEvent(p, 'Gym')), 'added');
    const gym = await fakeEvent(p, 'Gym');
    assert.deepEqual(gym.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=FR']);
    assert.ok(gym.start.dateTime.startsWith(`${friday}T18:00`) && gym.start.timeZone, 'with its time zone, as a repeating event needs');

    // Custom: every two weeks on Monday and Thursday, five times.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    await p.locator('.cal-week a.ev', { hasText: 'Lumenra glossary delivery' }).click();
    assert.equal(await repeatSelect(p).inputValue(), 'none');
    await repeatSelect(p).selectOption('custom');
    await p.locator('[data-key="cal-edit-every"]').fill('2');
    for (const d of ['TH', 'MO']) await p.locator(`[data-key="cal-edit-day:${d}"]`).click(); // Thursday was ticked: off, Monday on
    await p.locator('[data-key="cal-edit-day:TH"]').click();
    await p.locator('[data-key="cal-edit-ends:after"]').check();
    await p.locator('[data-key="cal-edit-count"]').fill('5');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-repeat.png'), animations: 'disabled' });
    await p.locator('[data-key="cal-edit-save"]').click();
    await editor(p).waitFor({ state: 'detached' });
    await until(async () => (await fakeEvent(p, 'Lumenra glossary delivery')).recurrence, 'it repeats');
    assert.deepEqual((await fakeEvent(p, 'Lumenra glossary delivery')).recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5']);
    await p.context().close();
  });

  await r.step('calendar: an occurrence of a series - this event, or all events, from the series’ first day', async () => {
    const p = await openPage();
    await openCalendar(p);
    const saturday = await dayKey(p, 5);
    const series = await fakeById(p, 'standup');
    const occurrence = (await p.evaluate(() => window.__fakeCalendar.events.filter(x => x.recurringEventId === 'standup').map(x => x.id)));

    // This event: the occurrence alone, at its own version.
    await standUp(p).click();
    await until(async () => (await repeatSelect(p).inputValue()) === 'weekly', 'the series’ rule, read');
    assert.equal(await repeatSelect(p).locator('option:checked').innerText(), 'Weekly on Saturday');
    await p.locator('[data-key="cal-edit-title"]').fill('Stand-up, short one');
    await p.locator('[data-key="cal-edit-save"]').click();
    const row = editor(p).locator('.cal-edit-confirm').filter({ hasText: 'for this event only, or for all events' });
    await row.waitFor();
    assert.equal(await p.locator('[data-key="cal-edit-scope-one"]').isVisible(), true);
    await p.locator('[data-key="cal-edit-scope-one"]').click();
    await editor(p).waitFor({ state: 'detached' });
    await until(async () => (await fakeById(p, occurrence[0])).summary === 'Stand-up, short one', 'this one');
    assert.equal((await fakeById(p, occurrence[1])).summary, 'Stand-up', 'not next week’s');
    assert.equal((await fakeById(p, 'standup')).summary, 'Stand-up', 'nor the series');
    let [sent] = (await sentChanges(p)).slice(-1);
    assert.equal(sent.path, `calendars/${encodeURIComponent(series.calendarId)}/events/${occurrence[0]}`);
    assert.ok(!('recurrence' in sent.body), 'an occurrence has no rule of its own');

    // All events, from next week's: the series moves to 09:30 from its first day.
    await p.keyboard.press('j');
    await standUp(p).waitFor();
    await standUp(p).click();
    await until(async () => (await repeatSelect(p).inputValue()) === 'weekly', 'read');
    await p.locator('[data-key="cal-edit-title"]').fill('Team stand-up');
    await p.locator('[data-key="cal-edit-start-time"]').fill('09:30');
    await p.locator('[data-key="cal-edit-end-time"]').fill('09:45');
    await p.locator('[data-key="cal-edit-save"]').click();
    await p.locator('[data-key="cal-edit-scope-all"]').click();
    await editor(p).waitFor({ state: 'detached' });
    await until(async () => (await fakeById(p, 'standup')).summary === 'Team stand-up', 'the series');
    const after = await fakeById(p, 'standup');
    assert.ok(after.start.dateTime.startsWith(`${saturday}T09:30`), `from its first day: ${after.start.dateTime}`);
    assert.deepEqual(after.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=SA'], 'the rule kept');
    [sent] = (await sentChanges(p)).slice(-1);
    assert.equal(sent.path, `calendars/${encodeURIComponent(series.calendarId)}/events/standup`);
    assert.equal(sent.etag, series.etag, 'at the version it was read at');
    await p.context().close();
  });

  await r.step('calendar: a new rule is for all events; stopping a series waits out an Undo', async () => {
    const p = await openPage();
    await openCalendar(p);
    await standUp(p).click();
    await until(async () => (await repeatSelect(p).inputValue()) === 'weekly', 'read');
    await repeatSelect(p).selectOption('daily');
    await p.locator('[data-key="cal-edit-save"]').click();
    await until(async () => /how it repeats is for all events/.test(await editor(p).locator('.cal-edit-confirm').first().innerText()), 'it says so');
    assert.equal(await p.locator('[data-key="cal-edit-scope-one"]').isVisible(), false, 'not for one event');
    await p.locator('[data-key="cal-edit-scope-all"]').click();
    await until(async () => JSON.stringify((await fakeById(p, 'standup')).recurrence) === '["RRULE:FREQ=DAILY"]', 'daily now');

    // Stop it repeating: asked, then an Undo, then Google.
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'read back');
    await standUp(p).first().click();
    await until(async () => (await repeatSelect(p).inputValue()) === 'daily', 'read');
    await repeatSelect(p).selectOption('none');
    await p.locator('[data-key="cal-edit-save"]').click();
    await until(async () => /It will stop repeating: the other events in the series go/.test(await editor(p).locator('.cal-edit-confirm').first().innerText()), 'warned');
    const before = (await sentChanges(p)).length;
    await p.locator('[data-key="cal-edit-scope-all"]').click();
    await p.locator('.toast', { hasText: 'will stop repeating' }).locator('.toast-action').click();
    await p.waitForTimeout(9500);
    assert.equal((await sentChanges(p)).length, before, 'undone: nothing sent');
    await standUp(p).first().click();
    await until(async () => (await repeatSelect(p).inputValue()) === 'daily', 'read');
    await repeatSelect(p).selectOption('none');
    await p.locator('[data-key="cal-edit-save"]').click();
    await p.locator('[data-key="cal-edit-scope-all"]').click();
    await until(async () => !(await fakeById(p, 'standup')).recurrence, 'no longer repeating', 13000);
    await p.context().close();
  });

  await r.step('calendar: deleting an occurrence - this event, or the whole series, after its Undo', async () => {
    const p = await openPage();
    await openCalendar(p);
    const series = await fakeById(p, 'standup');
    await standUp(p).click();
    await p.locator('[data-key="cal-edit-delete"]').click();
    assert.match(await editor(p).locator('.cal-edit-confirm').last().innerText(), /this event only, or every event in the series\?/);
    await until(async () => (await p.locator('[data-key="cal-edit-delete-all"]').getAttribute('aria-disabled')) === 'false', 'the series read');
    await p.locator('[data-key="cal-edit-delete-all"]').click();
    assert.equal(await standUp(p).count(), 0, 'gone from the screen at once');
    await p.keyboard.press('j');
    await p.locator('.cal-week .day[data-day]').first().waitFor();
    assert.equal(await standUp(p).count(), 0, 'next week’s too');
    await until(async () => (await fakeById(p, 'standup')).status === 'cancelled', 'the series deleted in Google', 13000);
    const [sent] = (await sentChanges(p)).slice(-1);
    assert.deepEqual(sent, { method: 'DELETE', path: `calendars/${encodeURIComponent(series.calendarId)}/events/standup`, body: null, etag: series.etag });
    await p.context().close();

    // A series that cannot be read: this event only, and it says so.
    const q = await openPage();
    await openCalendar(q);
    await q.evaluate(() => { const f = window.__fakeCalendar; f.events.splice(f.events.findIndex(x => x.id === 'standup'), 1); });
    await standUp(q).click();
    await until(async () => /the series could not be read/.test(await editor(q).innerText()), 'it says so');
    await q.locator('[data-key="cal-edit-save"]').click();
    assert.equal(await q.locator('[data-key="cal-edit-scope-all"]').getAttribute('aria-disabled'), 'true');
    await q.locator('[data-key="cal-edit-scope-one"]').click();
    await editor(q).waitFor({ state: 'detached' });
    await q.context().close();
  });

  await r.step('calendar: the week as two rows, Monday to Thursday above Friday to Sunday, remembered; wide and in the week only', async () => {
    const p = await openPage();
    await openCalendar(p);
    const btn = p.locator('[data-key="cal-layout"]');
    assert.match(await btn.getAttribute('title'), /^The week by the hour/);
    await btn.click();
    await until(async () => (await p.locator('.cal').getAttribute('data-layout')) === 'rows', 'two rows');
    const at = await p.locator('.cal-week > .day[data-day]').evaluateAll(els => els.map(e => {
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height) };
    }));
    assert.equal(new Set(at.slice(0, 4).map(b => b.y)).size, 1, 'Monday to Thursday in one row');
    assert.equal(new Set(at.slice(4).map(b => b.y)).size, 1, 'Friday to Sunday in another');
    assert.ok(at[4].y > at[0].y + at[0].h - 1, 'below it');
    assert.deepEqual(at.slice(4).map(b => b.x), at.slice(0, 3).map(b => b.x), 'Friday under Monday, and so on');
    assert.ok(Math.abs(at[4].h - at[0].h) < 2, 'the two rows equally tall');
    assert.match(await btn.getAttribute('title'), /^The week in two rows/);
    assert.ok((await weekText(p)).includes('Lumenra glossary delivery'), 'the same days, the same things on them');
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-rows.png'), animations: 'disabled' });
    const saved = await p.evaluate(async () => (await chrome.storage.local.get('pref:test@example.com:calendarWeekLayout'))['pref:test@example.com:calendarWeekLayout']);
    assert.equal(saved, 'rows', 'remembered');

    await p.locator('[data-key="cal-view:month"]').click();
    await p.locator('.cal-month').waitFor();
    assert.equal(await btn.isVisible(), false, 'not in the month');
    await p.locator('[data-key="cal-view:week"]').click();
    await p.locator('.cal-week').waitFor();
    await p.setViewportSize({ width: 560, height: 900 });
    await until(async () => (await p.locator('.cal').getAttribute('data-narrow')) === 'true', 'narrow');
    assert.equal(await btn.isVisible(), false, 'narrow, it is the phone’s week');
    assert.equal(await p.locator('.scratch-tile').count(), 0, 'with the small month as its eighth tile, not the scratchpad');
    const days = p.locator('.cal-week > .day:not(.mini-tile)');
    const [mon, tue] = await Promise.all([0, 1].map(i => days.nth(i).boundingBox()));
    assert.ok(tue.y > mon.y && Math.abs(tue.x - mon.x) < 2, 'Tuesday under Monday, as on a phone');
    await p.context().close();

    const q = await openPage();
    await q.evaluate(() => chrome.storage.local.set({ 'pref:test@example.com:calendarWeekLayout': 'rows' }));
    await openCalendar(q);
    assert.equal(await q.locator('.cal').getAttribute('data-layout'), 'rows', 'opened again, still two rows');
    await q.context().close();
  });

  await r.step('calendar: the scratchpad in the eighth space is the same note as in Notes, both ways; a redraw keeps the cursor', async () => {
    const p = await openPage();
    const scratchLive = () => p.evaluate(() => window.__fakeGmail.notesWithId('scratchpad000000').filter(n => !n.labels.includes('TRASH')));
    await p.evaluate(() => chrome.storage.local.set({ 'pref:test@example.com:calendarWeekLayout': 'rows' }));
    await openCalendar(p);
    const tile = p.locator('.cal-week > .scratch-tile');
    const tileBody = tile.locator('.ne-body');
    await tile.locator('.ne-body[contenteditable="true"]').waitFor();
    assert.equal(await tile.locator('.dname').innerText(), 'Scratchpad');
    const days = p.locator('.cal-week > .day[data-day]');
    const [thu, sun, box] = await Promise.all([days.nth(3).boundingBox(), days.nth(6).boundingBox(), tile.boundingBox()]);
    assert.ok(Math.abs(box.x - thu.x) < 2 && Math.abs(box.y - sun.y) < 2, 'under Thursday, beside Sunday');
    assert.equal(await tile.locator('.ne-toolbar').count(), 0, 'no toolbar');

    // Typed into, it saves by itself, as the scratchpad.
    await tileBody.click();
    await p.keyboard.type('Ring the dentist');
    await until(async () => /^Saved/.test(await tile.locator('.ne-status').innerText()), 'saved by itself', 10000);
    assert.deepEqual((await scratchLive()).map(n => [n.subject, n.text]), [['Scratchpad', 'Ring the dentist']]);

    // The week redrawn mid-sentence: the cursor stays where it was.
    await p.keyboard.type(' on Monday');
    await p.evaluate(() => window.gkb.calendar.load({ force: true }));
    await until(async () => !(await p.evaluate(() => window.gkb.calendar.isLoading())), 'redrawn');
    await p.keyboard.type(' at 9');
    assert.equal(await tileBody.innerText(), 'Ring the dentist on Monday at 9');
    await p.keyboard.press('Control+s');
    await until(async () => (await scratchLive()).some(n => n.text.endsWith('at 9')), 'Ctrl+S saves at once', 2000);

    // The same note in the Notes tab, and typed there, back in the tile.
    await p.locator('[data-key="view:notes"]').click();
    const notesBody = p.locator('.note-editor.scratch .ne-body');
    await until(async () => (await notesBody.innerText()) === 'Ring the dentist on Monday at 9', 'in the notes');
    await notesBody.click();
    await p.keyboard.press('Control+End');
    await p.keyboard.press('Enter');
    await p.keyboard.type('Buy stamps');
    await p.locator('[data-key="view:calendar"]').click();
    await until(async () => /at 9\nBuy stamps$/.test(await tileBody.innerText()), 'in the tile');
    // A save inserts the new version, then moves the old one to Trash.
    await until(async () => {
      const now = await scratchLive();
      return now.length === 1 && now[0].text.endsWith('Buy stamps');
    }, 'saved on leaving the tab, as one live version');

    // With another note open in Notes, the tile still edits the scratchpad,
    // and the other note stays open as it was.
    await p.locator('[data-key="view:notes"]').click();
    await p.locator('.note-item[data-note="n:rateschedule00000003"]').click();
    await bodyReady(p, /Per-word rates/, 'the other note');
    const rate = await p.evaluate(() => window.__fakeGmail.notesWithId('rateschedule00000003').filter(n => !n.labels.includes('TRASH')));
    await p.locator('[data-key="view:calendar"]').click();
    await tileBody.click();
    await p.keyboard.press('Control+End');
    await p.keyboard.type(' and the vet');
    await p.keyboard.press('Control+s');
    await until(async () => (await scratchLive()).some(n => n.text.endsWith('and the vet')), 'saved');
    await p.locator('[data-key="view:notes"]').click();
    await bodyReady(p, /Per-word rates/, 'the other note, still open');
    assert.deepEqual(await p.evaluate(() => window.__fakeGmail.notesWithId('rateschedule00000003').filter(n => !n.labels.includes('TRASH'))), rate, 'untouched');
    await p.locator('.scratch-item').click();
    await bodyReady(p, /Buy stamps and the vet$/, 'the scratchpad, with the tile’s line');
    await p.locator('[data-key="view:calendar"]').click();
    await tileBody.waitFor();
    await p.mouse.move(0, 0);
    await p.screenshot({ path: join(SCREENS, 'preview-calendar-scratchpad.png'), animations: 'disabled' });
    await p.context().close();
  });

  await r.step('calendar: without Gmail connected, the tile says so, and the calendar stays', async () => {
    const p = await openPage('state=auth_required');
    await p.evaluate(() => chrome.storage.local.set({ 'pref:test@example.com:calendarWeekLayout': 'rows' }));
    await openCalendar(p);
    const tile = p.locator('.cal-week > .scratch-tile');
    await until(async () => /Couldn’t load the scratchpad/.test(await tile.locator('.ne-body').getAttribute('data-placeholder') || ''), 'the tile says why');
    assert.equal(await tile.locator('.ne-body').getAttribute('contenteditable'), 'false');
    assert.equal(await p.locator('.panel').count(), 0, 'no Connect Gmail panel over the calendar');
    assert.ok((await weekText(p)).includes('Lumenra glossary delivery'));
    await p.context().close();
  });

  await r.step('the logo: a menu with the version, the website, the privacy page and the licence; the timings are the phone app’s', async () => {
    const p = await openPage();
    await p.context().route('https://memdesk.app/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>memdesk.app</title>' }));
    await openBoard(p);
    await p.locator('[data-key="about"]').click();
    const menu = p.locator('.menu');
    await menu.waitFor();
    const version = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;
    assert.equal(await menu.locator('.menu-heading').innerText(), `MemDesk ${version}`);
    assert.deepEqual((await menu.locator('.menu-label').allInnerTexts()).slice(0, 2), ['memdesk.app', 'Privacy']);
    assert.match((await menu.locator('.menu-label').allInnerTexts())[2], /^Licence/, 'and the licence (see below)');
    assert.equal(await p.locator('[data-key="about:timings"]').count(), 0, 'no timings in Gmail');
    const [tab] = await Promise.all([p.context().waitForEvent('page'), p.locator('[data-key="about:Privacy"]').click()]);
    await tab.waitForLoadState();
    assert.equal(tab.url(), 'https://memdesk.app/privacy/');
    assert.equal(await menu.count(), 0, 'the menu closes');
    await p.context().close();
  });

  // ── The licence ──

  // Licences on sale, in the fake Lemon Squeezy's store; and the licence as kept.
  const onSale = p => p.evaluate(() => { window.gkb.LICENCE_STORE_ID = window.__fakeLemon.STORE; });
  const kept = p => p.evaluate(async () => (await chrome.storage.sync.get('licence')).licence || null);
  const keep = (p, changes) => p.evaluate(async c => {
    const { licence } = await chrome.storage.sync.get('licence');
    await chrome.storage.sync.set({ licence: Object.assign({}, licence, c) });
  }, changes);
  const lemonAsked = p => p.evaluate(() => window.__fakeLemon.log.map(l => l.action));
  const reopen = async p => {
    await p.keyboard.press('Escape');
    await p.locator('[data-action="toggle-board"]').click();
    await p.locator('.overlay').waitFor({ state: 'visible' });
  };
  const aboutLicence = async p => {
    await p.locator('[data-key="about"]').click();
    const text = await p.locator('[data-key="about:licence"]').innerText();
    await p.keyboard.press('Escape');
    return text;
  };

  await r.step('licence: in preview it is free - the logo’s menu says so, nothing shows, nothing is asked or kept', async () => {
    const p = await openPage();
    await openBoard(p);
    await until(async () => (await aboutLicence(p)) === 'Licence: free while in preview', 'the menu says so');
    assert.equal(await p.locator('.licence-chip').isVisible(), false);
    await p.locator('[data-key="about"]').click();
    await p.locator('[data-key="about:licence"]').click();
    await p.locator('.licence-dialog').waitFor();
    assert.match(await p.locator('.licence-dialog').innerText(), /Free while in preview[\s\S]*nothing to enter/);
    assert.equal(await p.locator('.licence-dialog [data-key="licence-key"]').count(), 0, 'no key to enter');
    await p.keyboard.press('Escape');
    assert.deepEqual(await lemonAsked(p), []);
    assert.equal(await kept(p), null, 'no trial kept: it starts when licences go on sale');
    await p.context().close();
  });

  await r.step('licence: on sale - the trial’s chip; once it is over, the licence screen for all three tabs; a wrong key says why, a good one brings them back', async () => {
    const p = await openPage();
    await onSale(p);
    await openBoard(p);
    const chip = p.locator('.licence-chip');
    await until(async () => (await chip.isVisible()) && (await chip.innerText()) === 'Trial: 14 days left', 'the trial’s chip');
    assert.ok((await kept(p)).trialStart > 0);
    assert.equal(await aboutLicence(p), 'Licence: trial, 14 days left');
    assert.deepEqual(await lemonAsked(p), [], 'a trial asks nothing');

    await keep(p, { trialStart: Date.now() - 15 * 86400000 });
    await reopen(p);
    const panel = p.locator('.licence-panel');
    await panel.waitFor();
    assert.match(await panel.innerText(), /Your free trial has ended[\s\S]*still in Gmail, untouched[\s\S]*Supervertaler licence works too/);
    assert.equal(await p.locator('.card').count(), 0, 'no board');
    for (const tab of ['notes', 'calendar', 'board']) {
      await p.locator(`[data-key="view:${tab}"]`).click();
      assert.equal(await panel.isVisible(), true, `and no ${tab}`);
    }
    assert.equal(await chip.isVisible(), false);
    await p.screenshot({ path: join(SCREENS, 'preview-licence-ended.png'), animations: 'disabled' });

    const input = p.locator('[data-key="licence-key"]');
    const error = p.locator('.licence-error');
    for (const [key, why] of [['NOPE-0000', /not found/], ['OTHER-STORE-0006', /not a licence key/], ['MD-REFUNDED-0003', /disabled/], ['SV-EXPIRED-0005', /no longer in force/], ['MD-FULL-0002', /as many devices as it allows/]]) {
      await input.fill(key);
      await input.press('Enter');
      await until(async () => why.test(await error.innerText()), `${key}: ${why}`);
    }
    assert.equal(await panel.isVisible(), true, 'still the licence screen');
    // Lemon Squeezy out of reach: says so, and keeps what was.
    await p.evaluate(() => { window.__fakeLemon.offline = true; });
    await input.fill('MD-GOOD-0001');
    await p.locator('[data-key="licence-enter"]').click();
    await until(async () => /could not be reached/.test(await error.innerText()), 'unreachable');
    await p.evaluate(() => { window.__fakeLemon.offline = false; });
    await p.locator('[data-key="licence-enter"]').click();
    await p.locator('.card').first().waitFor();
    assert.equal(await panel.count(), 0, 'the board is back');
    assert.equal(await aboutLicence(p), 'Licence: licensed');
    const rec = await kept(p);
    assert.deepEqual([rec.key, rec.kind, !!rec.instance], ['MD-GOOD-0001', 'memdesk', true]);
    const log = await p.evaluate(() => window.__fakeLemon.log);
    assert.match(log.at(-1).fields.instance_name, /^\S+ in Chrome, \d+ \w{3} \d{4}$/);
    for (const l of log) assert.deepEqual(Object.keys(l.fields).filter(k => !['license_key', 'instance_name', 'instance_id'].includes(k)), [], 'nothing but the key and the activation');
    await p.context().close();
  });

  await r.step('licence: a Supervertaler licence works; the email’s board menu waits for a licence too; taking it off', async () => {
    const p = await openPage();
    await onSale(p);
    await openBoard(p);
    await p.locator('.licence-chip').waitFor();
    await keep(p, { trialStart: Date.now() - 15 * 86400000 });
    await p.keyboard.press('Escape');
    // Gmail with an email open: its board menu opens the licence screen instead.
    await p.locator('#dev-toggle-thread').click();
    const pill = p.locator('[data-action="thread-menu"]');
    await pill.waitFor();
    await pill.click();
    await p.locator('.licence-panel').waitFor();
    assert.equal(await p.locator('[role="menu"]').count(), 0, 'no columns to move it to');

    await p.locator('[data-key="licence-key"]').fill('SV-ACTIVE-0004');
    await p.locator('[data-key="licence-enter"]').click();
    await p.locator('.card').first().waitFor();
    assert.equal(await aboutLicence(p), 'Licence: with Supervertaler');
    assert.deepEqual(await lemonAsked(p), ['validate'], 'checked, never activated');
    // From the menu: the licence, and taking it off this computer.
    await p.locator('[data-key="about"]').click();
    await p.locator('[data-key="about:licence"]').click();
    await p.locator('.licence-dialog').waitFor();
    assert.match(await p.locator('.licence-dialog').innerText(), /Licensed[\s\S]*Supervertaler licence, the key ending 0004/);
    await p.locator('[data-key="licence-remove"]').click();
    await p.locator('[data-key="licence-remove-yes"]').click();
    await p.locator('.licence-panel').waitFor();
    assert.equal((await kept(p)).key, '');
    await p.keyboard.press('Escape');
    await p.context().close();
  });

  await r.step('licence: checked twice a day; unreachable for a month, it asks to be checked again', async () => {
    const p = await openPage();
    await onSale(p);
    await openBoard(p);
    await p.locator('.licence-chip').waitFor();
    await p.locator('.licence-chip').click();
    await p.locator('.licence-dialog [data-key="licence-key"]').fill('MD-GOOD-0001');
    await p.locator('.licence-dialog [data-key="licence-enter"]').click();
    await until(async () => (await p.locator('.licence-dialog').count()) === 0, 'licensed, the dialog closes');
    await p.locator('.toast', { hasText: 'Licensed. Thank you!' }).waitFor();
    assert.equal(await p.locator('.licence-chip').isVisible(), false);
    const asked = (await lemonAsked(p)).length;
    await reopen(p);
    await p.waitForTimeout(300);
    assert.equal((await lemonAsked(p)).length, asked, 'not asked again within twelve hours');
    // Thirteen hours on, with Lemon Squeezy out of reach: still licensed.
    await keep(p, { checked: Date.now() - 13 * 3600e3, tried: Date.now() - 13 * 3600e3 });
    await p.evaluate(() => { window.__fakeLemon.offline = true; });
    await reopen(p);
    await until(async () => (await lemonAsked(p)).length === asked + 1, 'asked');
    assert.equal(await p.locator('.licence-panel').count(), 0, 'still licensed');
    // A month without a word: the licence screen, with Check again.
    await keep(p, { checked: Date.now() - 31 * 86400000, tried: Date.now() - 13 * 3600e3 });
    await reopen(p);
    const panel = p.locator('.licence-panel');
    await panel.waitFor();
    assert.match(await panel.innerText(), /needs checking/);
    await p.locator('[data-key="licence-check"]').click();
    await until(async () => /could not be reached/.test(await p.locator('.licence-error').innerText()), 'says so');
    await p.evaluate(() => { window.__fakeLemon.offline = false; });
    await p.locator('[data-key="licence-check"]').click();
    await p.locator('.card').first().waitFor();
    // Refunded: at the next check, the licence screen.
    await p.evaluate(() => { window.__fakeLemon.keys['MD-GOOD-0001'].status = 'disabled'; });
    await keep(p, { tried: Date.now() - 13 * 3600e3, checked: Date.now() - 13 * 3600e3 });
    await reopen(p);
    await panel.waitFor();
    assert.match(await panel.innerText(), /switched off/);
    await p.context().close();
  });

  await r.step('no console errors anywhere', async () => {
    assert.deepEqual(errors, []);
  });
} catch {
  // The runner has already printed the failing step.
} finally {
  await browser.close();
}

const ok = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(ok ? 0 : 1);

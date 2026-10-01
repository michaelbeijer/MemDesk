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
    assert.match(await page.locator('.brand').innerText(), /Supermail\s*·\s*Board/);
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
    await waitForLabels(page, deadlineId, { has: ['Board/Doing', 'INBOX'], lacks: ['Board/To do'] }, 'labels after drag');
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
    await waitForLabels(page, id, { has: ['Board/Waiting'], lacks: ['Board/To do'] }, 'labels after menu move');
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
    await waitForLabels(page, id, { has: ['Board/Done'], lacks: ['INBOX', 'Board/Doing'] }, 'archived on drop');
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
    await waitForLabels(page, id, { has: ['Board/Waiting', 'INBOX'] }, 'labels after search-add');
    await until(async () => results.first().isDisabled(), 'result now marked as already here');
  });

  await r.step('Esc closes the search before it closes the board', async () => {
    await page.locator('.search input').press('Escape');
    await page.locator('.search').waitFor({ state: 'detached' });
    assert.ok(await overlayVisible(page));
  });

  let waitingLabelId;
  await r.step('column settings: rename title and label, add a column', async () => {
    waitingLabelId = await page.evaluate(() => window.__fakeGmail.labelByName('Board/Waiting').id);
    await page.locator('[data-key="settings"]').click();
    const drawer = page.locator('.drawer');
    await drawer.waitFor();
    await page.screenshot({ path: join(SCREENS, 'column-settings.png'), animations: 'disabled' });
    await drawer.locator('[data-key="title:2"]').fill('Waiting on others');
    await drawer.locator('[data-key="label:2"]').fill('Board/Waiting on others');
    await drawer.locator('[data-key="add-col"]').click();
    await drawer.locator('[data-key="title:4"]').fill('Later');
    assert.equal(await drawer.locator('[data-key="label:4"]').inputValue(), 'Board/Later', 'new label follows the title');
    await drawer.locator('[data-key="save"]').click();
    await drawer.waitFor({ state: 'detached' });
    await until(async () => (await page.locator('section.column').count()) === 5, 'five columns');
    await until(async () => (await page.locator('section[data-col="waiting"] .col-title').innerText()) === 'Waiting on others', 'renamed title');
    const renamed = await page.evaluate(() => window.__fakeGmail.labelByName('Board/Waiting on others'));
    assert.ok(renamed, 'label renamed in Gmail');
    assert.equal(renamed.id, waitingLabelId, 'renamed in place via labels.patch, same id');
    assert.equal(await page.evaluate(() => !!window.__fakeGmail.labelByName('Board/Waiting')), false);
    assert.ok(await page.evaluate(() => !!window.__fakeGmail.labelByName('Board/Later')), 'new label created');
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
    assert.ok(await page.evaluate(() => !!window.__fakeGmail.labelByName('Board/Later')), 'removed column keeps its Gmail label');
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
    await waitForLabels(page, id, { has: ['Board/To do'], lacks: ['Board/Doing'] }, 'labels after dock move');
  });

  await r.step('dock: remove from board, add again, Esc closes its menu', async () => {
    const id = await findThread(page, 'Termbase export');
    const pill = page.locator('[data-action="thread-menu"]');
    await pill.click();
    await page.locator('.menu [data-key="remove"]').click();
    await until(async () => /Add to board/.test(await pill.innerText()), 'pill says Add to board');
    await waitForLabels(page, id, { lacks: ['Board/To do', 'Board/Doing', 'Board/Waiting on others', 'Board/Done'] }, 'removed');
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
    assert.deepEqual(await labelsOf(p, id), ['Board/To do', 'INBOX', 'STARRED']);
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
    await waitForLabels(p, id, { has: ['Board/Waiting'], lacks: ['Board/To do'] }, 'labels after racing move');
    await until(async () => !(await p.locator('.spinning').count()), 'refresh settled', 8000);
    assert.ok((await ids(p, 'waiting')).includes(id));
    await p.context().close();
  });

  await r.step('a fresh mailbox gets its labels created, parents first', async () => {
    const p = await openPage('fresh');
    await p.locator('[data-action="toggle-board"]').click();
    await until(async () => (await p.locator('.list:empty').count()) === 4, 'four empty columns');
    const names = await p.evaluate(() => window.__fakeGmail.labelNames());
    for (const n of ['Board', 'Board/To do', 'Board/Doing', 'Board/Waiting', 'Board/Done']) assert.ok(names.includes(n), n);
    await p.context().close();
  });

  await r.step('a column with more than a page says so', async () => {
    const p = await openPage('page=3');
    await openBoard(p);
    assert.equal(await p.locator('section[data-col="todo"] .col-note').innerText(), 'Showing the first 100 threads');
    assert.equal(await p.locator('section[data-col="todo"] .col-count').innerText(), '3+');
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

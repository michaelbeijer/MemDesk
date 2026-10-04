#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Browser check (d): the website's demo, built and served
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tests/e2e/demo.e2e.mjs
//
// Builds memdesk.app with tools/build-site.mjs, serves it over HTTP as
// GitHub Pages would, and tries the demo the way a visitor would: on a
// computer, MemDesk in a made-up Gmail; on a phone, the phone app, with
// its script running beside it in the page. Links that would leave for
// Google must say so instead, and a reload must start afresh.
// ─────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, loadPlaywright, findChromium, screensDir, runner, until, watchErrors, serveFolder } from './lib.mjs';

const { chromium } = await loadPlaywright();
const SCREENS = screensDir();
const SITE = mkdtempSync(join(tmpdir(), 'demo-site-'));
execFileSync(process.execPath, [join(REPO, 'tools', 'build-site.mjs'), `--out=${SITE}`]);
const site = await serveFolder(SITE);
const errors = [];
const r = runner('demo');

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

async function computer(path = '/demo/', viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watchErrors(page, errors, '[computer] ');
  await page.goto(site.url + path);
  return page;
}

async function phone(path = '/demo/phone/', { viewport = { width: 1440, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  watchErrors(page, errors, '[phone] ');
  await page.goto(site.url + path);
  return page;
}

// The phone app, inside the phone page's frame.
const app = page => page.frameLocator('.phone iframe');
const inApp = (page, sel) => app(page).locator(`#gkb-app-host >> ${sel}`);
const appFrame = page => page.frames().find(f => f.url().endsWith('/demo/phone/app.html'));
const scratch = page => inApp(page, '.note-editor.scratch .ne-body[contenteditable="true"]');

try {
  await r.step('on a computer: MemDesk opens on the board, in a made-up Gmail, below the demo’s bar', async () => {
    const p = await computer();
    await p.locator('.overlay').waitFor({ state: 'visible' });
    await p.locator('.card').first().waitFor();
    assert.equal(await p.title(), 'MemDesk demo');
    assert.equal(await p.locator('.devbar').count(), 0, 'not the developer’s bar');
    assert.equal(await p.evaluate(() => document.body.firstElementChild.className), 'demobar');
    const bar = await p.locator('.demobar').boundingBox();
    const overlay = await p.locator('.overlay').boundingBox();
    assert.equal(bar.y, 0);
    assert.ok(Math.abs(overlay.y - bar.height) <= 1, 'the board starts below the bar, which stays in sight');
    assert.match(await p.locator('.demobar').innerText(), /made-up mail.*nothing leaves this page/s);
    assert.equal(await p.locator('.demo-switch a[aria-current="page"]').innerText(), 'Computer');
    assert.equal(await p.locator('.account').first().innerText().catch(() => ''), 'sam@example.com');
    assert.ok((await p.locator('.card').count()) >= 8, 'a board full of made-up mail');
    await p.screenshot({ path: join(SCREENS, 'demo-computer.png'), animations: 'disabled' });
    // Free, whatever the store: no trial's chip, and the menu says so.
    assert.equal(await p.locator('.licence-chip').isVisible(), false);
    await p.locator('[data-key="about"]').click();
    await until(async () => (await p.locator('[data-key="about:licence"]').innerText()) === 'Licence: free while in preview', 'free');
    await p.keyboard.press('Escape');

    // The notes and the week, all there.
    await p.locator('.tab', { hasText: 'Notes' }).click();
    await p.locator('.note-item').first().waitFor();
    await p.locator('.tab', { hasText: 'Calendar' }).click();
    await p.locator('.cal .ev').first().waitFor();
    assert.equal(await p.locator('.cal-week.hours').count(), 1, 'the week by the hour');
    await p.context().close();
  });

  await r.step('on a computer: a link that would leave for Google says so instead, and opens nothing', async () => {
    const p = await computer();
    await p.locator('.overlay').waitFor({ state: 'visible' });
    await p.locator('.tab', { hasText: 'Calendar' }).click();
    await p.locator('.cal .ev').first().waitFor();
    const pages = () => p.context().pages().length;

    // Someone else's meeting opens in Google Calendar, in MemDesk.
    await p.locator('.cal-week .ev', { hasText: 'Pub quiz' }).click();
    await until(async () => /opens Google Calendar/.test(await p.locator('.demo-note').innerText().catch(() => '')), 'it says so');
    assert.equal(pages(), 1, 'no tab opened');

    // One of your own opens the editor, as it does in MemDesk; with Ctrl,
    // Google Calendar - not here.
    const kickOff = p.locator('.cal-week a.ev', { hasText: 'Kestrel Medical' });
    await kickOff.click({ modifiers: ['Control'] });
    await p.waitForTimeout(300);
    assert.equal(pages(), 1, 'no tab opened');
    assert.equal(await p.locator('.cal-edit').count(), 0);
    await kickOff.click();
    await p.locator('.cal-edit').waitFor();
    await p.keyboard.press('Escape');
    await until(async () => (await p.locator('.cal-edit').count()) === 0, 'closed');

    // And whatever MemDesk opens with window.open.
    assert.equal(await p.evaluate(() => window.open('https://mail.google.com/mail/#all/abc', '_blank')), null);
    assert.match(await p.locator('.demo-note').innerText(), /opens the email in Gmail/);
    assert.equal(pages(), 1);
    await p.context().close();
  });

  await r.step('on a phone, /demo/ is the phone app’s demo - unless the computer’s was asked for', async () => {
    const p = await phone('/demo/', { viewport: { width: 390, height: 800 }, mobile: true });
    await p.waitForURL(/\/demo\/phone\/$/);
    await scratch(p).waitFor();
    // Full screen, under a bar of one line.
    const frame = await p.locator('.phone iframe').boundingBox();
    const bar = await p.locator('.demobar').boundingBox();
    assert.ok(frame.width >= 389 && bar.height < 52, `the app fills the phone: ${JSON.stringify({ frame, bar })}`);
    await p.screenshot({ path: join(SCREENS, 'demo-phone-small.png'), animations: 'disabled' });
    await p.locator('.demo-switch a', { hasText: 'Computer' }).click();
    await p.waitForURL(/\/demo\/\?computer$/);
    await p.locator('.overlay').waitFor({ state: 'visible' });
    assert.equal(await p.locator('.demo-switch a[aria-current="page"]').innerText(), 'Computer');
    await p.context().close();
  });

  await r.step('the phone demo: the real app, its script beside it in the page, the Scratchpad saved, the board and the week', async () => {
    const p = await phone();
    await scratch(p).waitFor();
    assert.equal(await p.locator('.demo-switch a[aria-current="page"]').innerText(), 'Phone');
    assert.match(await p.locator('.side').innerText(), /The phone app/);
    // The script is Code.gs itself, in a hidden frame of the app's page.
    assert.equal(await appFrame(p).evaluate(() => {
      const server = document.querySelector('iframe[src="server.html"]');
      return !!server && server.hidden && typeof server.contentWindow.appStart === 'function';
    }), true);

    await scratch(p).click();
    await p.keyboard.press('Control+End');
    await p.keyboard.type(' Ring the garage');
    await until(async () => /^Saved/.test(await inApp(p, '.scratch-title .ne-status').innerText()), 'saved, through the script', 10000);
    await p.screenshot({ path: join(SCREENS, 'demo-phone.png'), animations: 'disabled' });

    await inApp(p, '[data-key="view:board"]').click();
    await inApp(p, '.card .subject').first().waitFor();
    await inApp(p, '[data-key="view:calendar"]').click();
    await inApp(p, '.cal .ev').first().waitFor();

    // Links to Google say so here too.
    assert.equal(await appFrame(p).evaluate(() => window.open('https://mail.google.com/mail/#all/abc', '_blank')), null);
    assert.match(await app(p).locator('.demo-note').innerText(), /opens the email in Gmail/);
    assert.equal(p.context().pages().length, 1);

    // A reload starts afresh: nothing typed is kept.
    await p.reload();
    await scratch(p).waitFor();
    await p.waitForTimeout(500);
    assert.doesNotMatch(await scratch(p).innerText(), /Ring the garage/);
    await p.context().close();
  });

  await r.step('no console errors anywhere', async () => {
    assert.deepEqual(errors, []);
  });
} catch {
  // The runner has already printed the failing step.
} finally {
  await browser.close();
  await site.close();
}

const ok = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(ok ? 0 : 1);

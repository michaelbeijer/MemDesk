#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Browser check (b): the real unpacked extension in Chromium
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tests/e2e/extension.e2e.mjs
//
// Loads this folder with --load-extension, then checks what the preview
// cannot: the service worker registers, the ID matches the one derived
// from the manifest key, the options page renders cleanly, the proxy
// refuses calls outside its allow-list, and the content scripts inject
// into a mail.google.com page and talk to the real worker. mail.google.com
// is served by a Playwright route, so no network or Google account is
// involved.
//
// The stand-in page sends Gmail's Trusted Types header for realism, but
// Chromium does not extend a page's Trusted Types policy into a content
// script's isolated world, so this check cannot catch an innerHTML. The
// preview check can: there the same files run in the page's main world
// under Trusted Types.
//
// Tries new headless first; if the worker never appears, re-runs itself
// under xvfb-run with a headed browser.
// ─────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO, loadPlaywright, findChromium, screensDir, runner, until, watchErrors } from './lib.mjs';

const { chromium } = await loadPlaywright();
const SCREENS = screensDir();
const HEADED = process.env.E2E_HEADED === '1';

const manifest = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8'));
const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const EXPECTED_ID = [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

// A stand-in for Gmail's page: the title Gmail uses, an open conversation
// subject carrying data-legacy-thread-id, and Gmail's Trusted Types rule.
const FAKE_GMAIL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Inbox (3) - test@example.com - Gmail</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f8fc; margin: 0">
  <div role="main" style="margin: 80px 260px; background: #fff; border-radius: 16px; padding: 24px">
    <h2 data-legacy-thread-id="18f2a3b4c5d6e000">A conversation</h2>
    <p>Stand-in for mail.google.com, served by a Playwright route.</p>
  </div>
</body></html>`;

async function launch(userDataDir, extension = REPO) {
  return chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    // Playwright adds --disable-extensions by default.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
    ],
  });
}

const profile = mkdtempSync(join(tmpdir(), 'ext-profile-'));
const errors = [];
const r = runner(`extension (${HEADED ? 'headed, xvfb' : 'new headless'})`);
let ctx;
let sw;

try {
  ctx = await launch(profile);
  sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
} catch (err) {
  console.log(`launch failed: ${err.message}`);
}

if (!sw) {
  if (ctx) await ctx.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  if (!HEADED && existsSync('/usr/bin/xvfb-run')) {
    console.log('No service worker in new headless; retrying headed under xvfb-run…');
    const res = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: { ...process.env, E2E_HEADED: '1' },
    });
    process.exit(res.status ?? 1);
  }
  console.log('The extension service worker never registered.');
  process.exit(1);
}

try {
  await r.step('service worker registers', async () => {
    assert.match(sw.url(), /^chrome-extension:\/\/[a-p]{32}\/src\/background\/sw\.js$/);
  });

  await r.step(`extension ID matches the manifest key (${EXPECTED_ID})`, async () => {
    assert.equal(new URL(sw.url()).host, EXPECTED_ID);
    assert.equal(await sw.evaluate(() => chrome.runtime.id), EXPECTED_ID);
    assert.equal(await sw.evaluate(() => chrome.identity.getRedirectURL()), `https://${EXPECTED_ID}.chromiumapp.org/`);
  });

  const OPTIONS = `chrome-extension://${EXPECTED_ID}/src/options/options.html`;

  await r.step('first install opens the setup page', async () => {
    await until(() => ctx.pages().some(p => p.url() === OPTIONS), 'options tab opened by onInstalled', 8000);
  });

  let options;
  await r.step('options page renders without console errors', async () => {
    options = await ctx.newPage();
    watchErrors(options, errors, '[options] ');
    await options.goto(OPTIONS);
    await options.locator('#ext-id').waitFor();
    assert.equal(await options.title(), 'Supermail – Setup');
    assert.equal(await options.locator('#app-name').innerText(), 'Supermail');
    assert.equal(await options.locator('#ext-id').innerText(), EXPECTED_ID);
    assert.equal(await options.locator('#redirect-uri').innerText(), `https://${EXPECTED_ID}.chromiumapp.org/`);
    assert.equal(await options.locator('#shortcut').innerText(), 'Alt+Shift+K');
    assert.equal(await options.locator('input[name="dock"]:checked').getAttribute('value'), 'left');
    await options.screenshot({ path: join(SCREENS, 'options.png'), fullPage: true, animations: 'disabled' });
  });

  await r.step('“Test connection” without a client ID says what to do', async () => {
    await options.locator('#test').click();
    await until(async () => (await options.locator('#test-status').innerText()) === 'Save a client ID first.', 'status text');
  });

  await r.step('the proxy refuses sending, deleting and non-note inserts before asking for a token', async () => {
    const ask = msg => options.evaluate(m => chrome.runtime.sendMessage(m), msg);
    const send = await ask({ type: 'gmail', account: 'test@example.com', method: 'POST', path: 'messages/send', body: {} });
    assert.equal(send.ok, false);
    assert.equal(send.error.code, 'not_allowed');
    const del = await ask({ type: 'gmail', account: 'test@example.com', method: 'DELETE', path: 'threads/18f2a3b4c5d6e000' });
    assert.equal(del.error.code, 'not_allowed');
    const trash = await ask({
      type: 'gmail', account: 'test@example.com', method: 'POST',
      path: 'threads/18f2a3b4c5d6e000/modify', body: { addLabelIds: ['TRASH'] },
    });
    assert.equal(trash.error.code, 'not_allowed');
    // messages.insert only takes a note: ordinary mail is refused outright.
    const raw = Buffer.from('From: bank@example.com\r\nSubject: Verify your account\r\n\r\nclick here').toString('base64url');
    const insert = await ask({ type: 'gmail', account: 'test@example.com', method: 'POST', path: 'messages', body: { raw, labelIds: ['Label_1'] } });
    assert.equal(insert.error.code, 'not_allowed');
    // Trashing a message gets past the request check to the header check,
    // which needs a token - so here it stops at the missing client ID.
    const noteTrash = await ask({ type: 'gmail', account: 'test@example.com', method: 'POST', path: 'messages/18f2a3b4c5d6e000/trash' });
    assert.equal(noteTrash.error.code, 'not_configured');
    const labels = await ask({ type: 'gmail', account: 'test@example.com', method: 'GET', path: 'labels' });
    assert.equal(labels.error.code, 'not_configured', 'an allowed call gets as far as the missing client ID');
  });

  let gmail;
  await r.step('content scripts inject into Gmail and reach the worker', async () => {
    await ctx.route('https://mail.google.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types 'none'" },
      body: FAKE_GMAIL,
    }));
    gmail = await ctx.newPage();
    watchErrors(gmail, errors, '[gmail] ');
    await gmail.goto('https://mail.google.com/mail/u/0/#inbox');
    const boardBtn = gmail.locator('[data-action="toggle-board"]');
    await boardBtn.waitFor({ timeout: 10000 });
    const pill = gmail.locator('[data-action="thread-menu"]');
    await until(async () => /Add to board/.test(await pill.innerText()), 'thread pill for the open conversation');
    await boardBtn.click();
    await gmail.locator('.panel', { hasText: 'Finish setting up' }).waitFor();
    assert.match(await gmail.locator('.brand').innerText(), /Supermail/);
    assert.equal(await gmail.locator('.tab[aria-selected="true"]').innerText(), 'Board');
    assert.equal(await gmail.locator('.account').innerText(), 'test@example.com');
    // Styles were adopted inside the shadow root, not leaked to the page.
    assert.equal(await gmail.locator('.overlay').evaluate(e => getComputedStyle(e).position), 'fixed');
    assert.equal(await gmail.evaluate(() => document.adoptedStyleSheets.length), 0);
    await gmail.screenshot({ path: join(SCREENS, 'extension-gmail-setup-panel.png'), animations: 'disabled' });
  });

  await r.step('the Gmail tab checked in, and the toolbar action toggles its board', async () => {
    const tabs = await until(() => sw.evaluate(async () => (await chrome.storage.session.get('gmailTabs')).gmailTabs), 'tab registry');
    assert.ok(tabs.length >= 1);
    await sw.evaluate(id => toggleBoard({ id }), tabs[0].id);
    await gmail.locator('.overlay').waitFor({ state: 'hidden' });
    await sw.evaluate(id => toggleBoard({ id }), tabs[0].id);
    await gmail.locator('.overlay').waitFor({ state: 'visible' });
    await gmail.keyboard.press('Escape');
    await gmail.locator('.overlay').waitFor({ state: 'hidden' });
  });

  await r.step('client ID and dock position save to storage.sync', async () => {
    await options.bringToFront();
    await options.locator('#client-id').fill('123456789012-abcdef.apps.googleusercontent.com');
    await options.locator('#client-form button[type="submit"]').click();
    await until(async () => /^Saved\./.test(await options.locator('#client-status').innerText()), 'saved status');
    await options.locator('input[name="dock"][value="right"]').check();
    const stored = await until(async () => {
      const s = await sw.evaluate(() => chrome.storage.sync.get(null));
      return s.dockPosition === 'right' && s;
    }, 'sync storage');
    assert.equal(stored.clientId, '123456789012-abcdef.apps.googleusercontent.com');
    await until(() => gmail.locator('.dock').evaluate(e => e.classList.contains('right')), 'dock moved right live');
    await options.reload();
    assert.equal(await options.locator('#client-id').inputValue(), '123456789012-abcdef.apps.googleusercontent.com');
  });

  await r.step('the store build: one “Connect Gmail” button, your own project tucked away', async () => {
    const { build } = await import('../../tools/package-extension.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'ext-store-'));
    const prof = mkdtempSync(join(tmpdir(), 'ext-store-profile-'));
    for (const { name, data } of build({ clientId: '123456789012-storebuild.apps.googleusercontent.com' }).entries) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), data);
    }
    const store = await launch(prof, dir);
    try {
      let worker = store.serviceWorkers()[0] || await store.waitForEvent('serviceworker', { timeout: 15000 });
      const id = new URL(worker.url()).host;
      assert.notEqual(id, EXPECTED_ID, 'no key: an ID of its own');
      const page = await store.newPage();
      watchErrors(page, errors, '[store options] ');
      await page.goto(`chrome-extension://${id}/src/options/options.html`);
      await page.locator('#connect').waitFor();
      assert.equal(await page.locator('#connect-card').isVisible(), true);
      assert.equal(await page.locator('#own-project').evaluate(d => d.open), false, 'your own project, folded away');
      assert.equal(await page.locator('#client-id').isVisible(), false);
      assert.match(await page.locator('#connect-card').innerText(), /Go to Supermail/);
      await page.screenshot({ path: join(SCREENS, 'options-store.png'), fullPage: true, animations: 'disabled' });
    } finally {
      await store.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      rmSync(prof, { recursive: true, force: true });
    }
  });

  await r.step('no console errors on the options page or in Gmail', async () => {
    assert.deepEqual(errors, []);
  });
} catch {
  // The runner has already printed the failing step.
} finally {
  await ctx.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}

const ok = r.summary();
console.log(`screenshots: ${SCREENS}`);
process.exit(ok ? 0 : 1);

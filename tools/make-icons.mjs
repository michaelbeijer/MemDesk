#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The icon at every size it is used
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node tools/make-icons.mjs
//
// Renders icons/icon.svg (drawn by tools/icon-svg.py) with Chromium to
// icons/icon-{16,32,48,128}.png for Chrome's toolbar, extensions page and
// web store, and icons/icon-192.png for the Gmail add-on's logo and the
// phone app's favicon, which Android also uses for the home-screen icon.
// ─────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, loadPlaywright, findChromium } from '../tests/e2e/lib.mjs';

export const SIZES = [16, 32, 48, 128, 192];

const svg = readFileSync(join(REPO, 'icons', 'icon.svg'), 'utf8');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${
    svg.replace('width="128" height="128"', `width="${size}" height="${size}"`)}`);
  await page.screenshot({ path: join(REPO, 'icons', `icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log(`Wrote icons/icon-{${SIZES.join(',')}}.png`);

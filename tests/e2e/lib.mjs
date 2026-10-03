// ─────────────────────────────────────────────────────────────────────
// Shared plumbing for the browser checks
//
// playwright-core is deliberately not a dependency of this repo (the
// extension has none). Point PLAYWRIGHT_CORE at an install anywhere, or
// `npm i --no-save playwright-core` here; node_modules/ is gitignored.
// The browser is found via CHROMIUM_PATH, then /opt/pw-browsers, then
// Playwright's own cache.
// ─────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_CORE;
  if (dir) {
    const entry = existsSync(join(dir, 'index.mjs')) ? join(dir, 'index.mjs')
      : join(dir, 'node_modules', 'playwright-core', 'index.mjs');
    return import(pathToFileURL(entry).href);
  }
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core, ' +
      'or run `npm i --no-save playwright-core` in the repo.');
  }
}

// Full Chromium, not chrome-headless-shell: only the full build can load
// unpacked extensions, and left to itself Playwright runs headless on the
// shell. So the full build is looked for where Playwright installs it -
// /opt/pw-browsers, PLAYWRIGHT_BROWSERS_PATH, or its own folder on
// Windows - newest first.
const CHROMIUM_EXES = [['chrome-linux', 'chrome'], ['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']];

export function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = ['/opt/pw-browsers', process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const dirs = readdirSync(root).filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      for (const parts of CHROMIUM_EXES) {
        const exe = join(root, d, ...parts);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return undefined; // let Playwright use its own download
}

export function screensDir() {
  const dir = process.env.SCREENS_DIR || join(tmpdir(), 'board-screens');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── A very small runner ──────────────────────────────────────────────
//
// Steps run in order and stop at the first failure, because each one
// builds on the state the last one left behind.

export function runner(name) {
  const results = [];
  return {
    async step(title, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ title, ok: true });
        console.log(`  ✓ ${title} (${Date.now() - t0}ms)`);
      } catch (err) {
        results.push({ title, ok: false });
        console.log(`  ✗ ${title}\n    ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n    ')}`);
        throw err;
      }
    },
    summary() {
      const passed = results.filter(r => r.ok).length;
      console.log(`\n${name}: ${passed}/${results.length} steps passed`);
      return passed === results.length;
    },
  };
}

// Polls fn (run in Node) until it returns truthy.
export async function until(fn, message, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) { last = err; }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
}

// Collects console errors and uncaught exceptions from a page.
export function watchErrors(page, sink, label = '') {
  page.on('console', msg => {
    if (msg.type() === 'error') sink.push(`${label}console: ${msg.text()}`);
  });
  page.on('pageerror', err => sink.push(`${label}pageerror: ${err.message}`));
}

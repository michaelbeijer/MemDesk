#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Builds addon/Code.gs: the phone panel and the phone app as one file to
// paste into the Apps Script editor.
//
//   node tools/build-addon.mjs           write addon/Code.gs
//   node tools/build-addon.mjs --check   exit 1 if it is out of date
//
// It is the shared note code (the same files the extension loads) and
// the panel's own, one after the other - no transpiling, no minifying,
// so what runs in Apps Script reads like the sources it came from. The
// phone app's page goes in as one string: addon/app/index.html with the
// extension's Notes view and editor (APP_FILES) packed into it - see
// LOADER - which doGet serves.
// ─────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'addon', 'Code.gs');
const VERSION = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;

export const FILES = [
  'addon/src/shims.js',
  'src/shared/ns.js',
  'src/lib/util.js',
  'src/lib/notes-logic.js',
  'src/lib/note-format.js',
  'src/lib/board-logic.js',
  'src/lib/search-logic.js',
  'addon/src/panel-logic.js',
  'addon/src/gmail.js',
  'addon/src/store.js',
  'addon/src/cards.js',
  'addon/src/app-server.js',
  'addon/src/triggers.js',
];

// The phone app's page: the extension's own Notes view and editor, with
// a store that reaches Gmail through this script, and a phone layout.
// remote.js comes before notes.js, which picks up the store as it loads.
export const APP_FILES = [
  'src/shared/ns.js',
  'src/lib/util.js',
  'src/lib/notes-logic.js',
  'src/lib/note-format.js',
  'src/lib/search-logic.js',
  'src/content/ui.js',
  'src/content/styles.js',
  'src/content/note-editor.js',
  'addon/app/remote.js',
  'src/content/notes.js',
  'addon/app/shell.js',
];

// The page's code goes in as one small script with every module inside
// it in base64url - letters, digits, "-" and "_" only - which it decodes
// and runs, in order, one at a time. Apps Script does not serve inline
// scripts as they are: its loader takes them out of the page and runs
// them itself, and an app made of many plain scripts did not survive
// that. Base64 survives anything done to text, and running the modules
// here names any that fails, instead of leaving a blank page. The
// loader itself has no "//", "<!--" or "</" in it, nothing a careless
// rewrite of the page could cut.
const LOADER = `<script>
(function () {
  var MODULES = __MODULES__;
  var SOURCE = String.fromCharCode(10, 47, 47) + '# sourceURL=app/';
  function decode(text) {
    var bin = atob(text.replace(/-/g, '+').replace(/_/g, String.fromCharCode(47)));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function run(name, code) {
    try {
      (0, eval)(code + SOURCE + name);
    } catch (err) {
      if (!(err instanceof EvalError)) throw err;
      var el = document.createElement('script');
      el.text = code + SOURCE + name;
      document.head.appendChild(el);
    }
  }
  var failed = [];
  for (var i = 0; i < MODULES.length; i++) {
    try {
      run(MODULES[i][0], decode(MODULES[i][1]));
    } catch (err) {
      failed.push(MODULES[i][0] + ': ' + err.message);
    }
  }
  if (failed.length) {
    window.__partsFailed = failed;
    if (window.__bootFailed) window.__bootFailed('Parts that did not load: ' + failed.join('; '));
  }
})();
</script>`;

export function appHtml() {
  const modules = APP_FILES.map(f => [f, Buffer.from(readFileSync(join(REPO, f), 'utf8'), 'utf8').toString('base64url')]);
  const loader = LOADER.replace('__MODULES__', () => JSON.stringify(modules));
  for (const bad of ['//', '<!--', '</s']) {
    const body = loader.slice('<script>'.length, -'</script>'.length);
    if (body.includes(bad)) throw new Error(`the app's loader contains "${bad}"`);
  }
  return readFileSync(join(REPO, 'addon', 'app', 'index.html'), 'utf8').replace('<!-- scripts -->', () => loader);
}

const HEADER = `// The phone panel and phone app ${VERSION}: a Gmail add-on and a web app, in Apps Script.
//
// Paste this whole file over Code.gs in the Apps Script editor, and
// addon/appsscript.json over appsscript.json. The setup steps are in the
// README, under "The phone panel".
//
// Built by tools/build-addon.mjs from the files listed below; change
// those and rebuild rather than editing this copy.
//   ${FILES.join('\n//   ')}

// The notes label, and the label the board's column labels are under.
// Change them only if you renamed _Notes or _Board in Gmail.
var SUPERMAIL_NOTES_LABEL = '_Notes';
var SUPERMAIL_BOARD_LABEL = '_Board';

// The phone app's icon, in the browser tab and on the home screen.
var SUPERMAIL_ICON_URL = 'https://raw.githubusercontent.com/michaelbeijer/Supermail/main/icons/icon-192.png';

var SUPERMAIL_VERSION = '${VERSION}';

// Apps Script has a global object but may not name it globalThis.
var globalThis = typeof globalThis !== 'undefined' ? globalThis : this;
`;

export function bundle() {
  const parts = FILES.map(f => `\n// ════ ${f} ${'═'.repeat(Math.max(4, 64 - f.length))}\n\n${readFileSync(join(REPO, f), 'utf8').trimEnd()}\n`);
  // In short lines, which the Apps Script editor copes with far better
  // than one line of a quarter of a megabyte.
  const html = appHtml();
  const lines = [];
  for (let i = 0; i < html.length; i += 1000) lines.push(JSON.stringify(html.slice(i, i + 1000)));
  const page = `\n// ════ the phone app's page (addon/app, built) ${'═'.repeat(20)}\n\nvar SUPERMAIL_APP_HTML = [\n${lines.join(',\n')},\n].join('');\n`;
  return `${HEADER}${parts.join('')}${page}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fresh = bundle();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (current !== fresh) {
      console.error('addon/Code.gs is out of date: run node tools/build-addon.mjs');
      process.exit(1);
    }
    console.log('addon/Code.gs is up to date.');
  } else {
    writeFileSync(OUT, fresh);
    console.log(`Wrote addon/Code.gs (${fresh.split('\n').length} lines).`);
  }
}

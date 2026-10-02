#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Builds addon/Code.gs: the phone panel as one file to paste into the
// Apps Script editor.
//
//   node tools/build-addon.mjs           write addon/Code.gs
//   node tools/build-addon.mjs --check   exit 1 if it is out of date
//
// It is the shared note code (the same files the extension loads) and
// the panel's own, one after the other - no transpiling, no minifying,
// so what runs in Apps Script reads like the sources it came from.
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
  'addon/src/panel-logic.js',
  'addon/src/gmail.js',
  'addon/src/store.js',
  'addon/src/cards.js',
  'addon/src/triggers.js',
];

const HEADER = `// The phone panel ${VERSION}: a Google Workspace add-on for Gmail.
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

// Apps Script has a global object but may not name it globalThis.
var globalThis = typeof globalThis !== 'undefined' ? globalThis : this;
`;

export function bundle() {
  const parts = FILES.map(f => `\n// ════ ${f} ${'═'.repeat(Math.max(4, 64 - f.length))}\n\n${readFileSync(join(REPO, f), 'utf8').trimEnd()}\n`);
  return `${HEADER}${parts.join('')}`;
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

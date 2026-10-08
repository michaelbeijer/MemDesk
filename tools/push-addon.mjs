#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Puts the phone app's script into the owner's Apps Script project
//
//   node tools/push-addon.mjs [--ref=origin/main] [--force]
//
// Instead of pasting addon/Code.gs and addon/appsscript.json by hand, with
// Google's clasp: `npm i -g @google/clasp`, the Apps Script API switched on
// at script.google.com/home/usersettings, and `clasp login` once. Which
// project is in dist/clasp/push/.clasp.json - {"scriptId": "…", "rootDir": ""}
// - kept out of the repository (dist/ is ignored), as it is the owner's.
//
// It pushes what `--ref` holds (origin/main by default: what is released),
// never the working tree. clasp push leaves the project holding exactly
// the files pushed, so it first reads what the project holds and stops if
// there is anything besides Code and appsscript.json, rather than delete
// it; and afterwards reads it back to check Google has what was pushed.
// If the project has it already, nothing is pushed, unless --force.
// The phone app's test deployment (@HEAD, its /dev address) and the Gmail
// panel's test install run the new code at once; a versioned deployment
// would need a new version as well.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUSH = join(REPO, 'dist', 'clasp', 'push');
const FILES = { 'Code.gs': 'addon/Code.gs', 'appsscript.json': 'addon/appsscript.json' };
// What the project may hold besides: clasp names a server file .js on the way down.
const KNOWN = new Set(['Code.js', 'Code.gs', 'appsscript.json']);

const fail = msg => { console.error(`push-addon: ${msg}`); process.exit(1); };
const same = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
// Google may lay the manifest out its own way: compared as what it says.
const sameJson = (a, b) => {
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return false; }
};

// clasp is a .cmd on Windows, so it goes through the shell; its arguments
// here are fixed words and the script's id, never anything typed.
function clasp(args, cwd) {
  const r = spawnSync('clasp', args, { cwd, shell: true, encoding: 'utf8' });
  if (r.status !== 0) fail(`clasp ${args[0]} failed:\n${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

// The project as Google has it, in a folder of its own: { name: text }.
function remoteFiles(scriptId) {
  const dir = mkdtempSync(join(tmpdir(), 'push-addon-'));
  try {
    clasp(['clone', scriptId], dir);
    const out = {};
    for (const name of readdirSync(dir)) if (name !== '.clasp.json') out[name] = readFileSync(join(dir, name), 'utf8');
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ref = (process.argv.find(a => a.startsWith('--ref=')) || '--ref=origin/main').slice('--ref='.length);
const force = process.argv.includes('--force');
if (!existsSync(join(PUSH, '.clasp.json'))) fail(`no ${join(PUSH, '.clasp.json')}: say which project, as {"scriptId": "…", "rootDir": ""}.`);
const { scriptId } = JSON.parse(readFileSync(join(PUSH, '.clasp.json'), 'utf8'));
if (!/^[\w-]{20,}$/.test(String(scriptId || ''))) fail('the script id in .clasp.json does not look like one.');

if (ref.startsWith('origin/')) execFileSync('git', ['fetch', '-q', 'origin'], { cwd: REPO });
const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: REPO, encoding: 'utf8' }).trim();
const files = {};
for (const [name, path] of Object.entries(FILES)) {
  files[name] = execFileSync('git', ['show', `${ref}:${path}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const version = (/APP_VERSION = '([\d.]+)'/.exec(files['Code.gs']) || [])[1] || '?';

const before = remoteFiles(scriptId);
const strange = Object.keys(before).filter(name => !KNOWN.has(name));
if (strange.length) fail(`the project also holds ${strange.join(', ')}, which a push would delete. Nothing was pushed.`);
const code = before['Code.js'] || before['Code.gs'] || '';
if (!force && same(code, files['Code.gs']) && sameJson(before['appsscript.json'] || '', files['appsscript.json'])) {
  console.log(`The project already has ${version} (${ref} ${sha}): nothing to push.`);
  process.exit(0);
}

// Only the two files in the folder clasp pushes from.
for (const name of readdirSync(PUSH)) if (name !== '.clasp.json') rmSync(join(PUSH, name), { recursive: true, force: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(PUSH, name), text);
clasp(['push', '--force'], PUSH);

const after = remoteFiles(scriptId);
if (!same(after['Code.js'] || after['Code.gs'] || '', files['Code.gs'])) fail('Google’s copy of Code differs from what was pushed.');
if (!sameJson(after['appsscript.json'] || '', files['appsscript.json'])) fail('Google’s appsscript.json differs from what was pushed.');
console.log(`Pushed ${version} (${ref} ${sha}) to the Apps Script project, and read it back.`);

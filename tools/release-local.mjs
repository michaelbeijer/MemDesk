#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The extension for the owner's own Chrome: the zip, and the folder
//
//   node tools/release-local.mjs [--ref=origin/main] [--to=<folder>]
//
// Makes the update package from `--ref` (origin/main by default: what is
// released) - the zip, in dist/ and the Downloads folder - and unpacks it
// into one folder, dist/<app name> unless --to says otherwise, which
// Chrome loads unpacked once. After that, a new version is the extension's
// reload button in chrome://extensions, and nothing to unzip or drag. Its
// id comes from the manifest's key, not the folder, so its settings stay.
//
// The folder is emptied first, so a file a release dropped goes too - but
// only if it is empty, or holds this extension (a manifest with the same
// key): never some other folder named by mistake.
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = /APP_NAME = '([^']+)'/.exec(readFileSync(join(REPO, 'src', 'shared', 'ns.js'), 'utf8'))[1];
const fail = msg => { console.error(`release-local: ${msg}`); process.exit(1); };
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);

const ref = arg('ref') || 'origin/main';
const target = resolve(arg('to') || join(REPO, 'dist', APP_NAME));
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (ref.startsWith('origin/')) git('fetch', '-q', 'origin');
const manifest = JSON.parse(git('show', `${ref}:manifest.json`));
const version = manifest.version;
const sha = git('rev-parse', '--short', ref).trim();

// The zip, as ever: in dist/ and in Downloads.
mkdirSync(join(REPO, 'dist'), { recursive: true });
const zip = join(REPO, 'dist', `${APP_NAME}-${version}.zip`);
git('archive', '--format=zip', `--prefix=${APP_NAME}/`, '-o', zip, ref);
const downloads = join(homedir(), 'Downloads');
if (existsSync(downloads)) copyFileSync(zip, join(downloads, `${APP_NAME}-${version}.zip`));

// The folder Chrome loads: emptied, if it is this extension's, and filled.
if (existsSync(target)) {
  const inside = readdirSync(target);
  if (inside.length) {
    let key = '';
    try { key = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).key; } catch { /* not ours */ }
    if (!key || key !== manifest.key) fail(`${target} holds something other than this extension: nothing was changed there.`);
    for (const name of inside) rmSync(join(target, name), { recursive: true, force: true });
  }
} else {
  mkdirSync(target, { recursive: true });
}
// Windows' own tar reads zips and takes Windows paths; Git's would not.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', zip, '-C', target, '--strip-components=1']);

const now = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version;
if (now !== version) fail(`${target} has ${now} after unpacking, not ${version}.`);
console.log(`${APP_NAME} ${version} (${ref} ${sha}):
  zip       ${zip}${existsSync(downloads) ? `\n            ${join(downloads, `${APP_NAME}-${version}.zip`)}` : ''}
  unpacked  ${target}
Reload it in chrome://extensions, then reload the Gmail tabs.`);

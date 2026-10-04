// Checks on the source itself: the hard constraints that a unit test of
// behaviour would not notice being broken.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function files(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(rel, exts));
    else if (exts.some(e => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

const manifest = JSON.parse(read('manifest.json'));

test('no HTML-string sinks anywhere Gmail’s Trusted Types would apply', () => {
  // Matches use, not mentions: comments explaining why innerHTML is
  // avoided are fine.
  const SINK = /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|new\s+DOMParser\b|createContextualFragment\s*\(/;
  for (const f of [...files('src', ['.js', '.html']), ...files('dev', ['.js', '.html'])]) {
    read(f).split('\n').forEach((line, i) => {
      assert.doesNotMatch(line, SINK, `${f}:${i + 1}`);
    });
  }
});

test('the display name lives only in the documented rename spots', () => {
  const NAME = manifest.name;
  const allowed = new Set(['manifest.json', 'README.md', path.join('src', 'shared', 'ns.js'), path.join('addon', 'appsscript.json')]);
  const candidates = [
    ...files('src', ['.js', '.html', '.css']),
    ...files('dev', ['.js', '.html']),
    ...files('tools', ['.mjs', '.js']),
    ...files('addon', ['.js', '.json']),
    'manifest.json', 'README.md', 'package.json',
  ];
  for (const f of candidates) {
    if (!fs.existsSync(path.join(ROOT, f)) || allowed.has(f)) continue;
    // The repository's address is where it lives, not what it is called.
    const text = read(f).replace(/(github\.com|raw\.githubusercontent\.com)\/michaelbeijer\/MemDesk/g, '');
    assert.equal(text.includes(NAME), false, `${f} mentions “${NAME}”; use APP_NAME instead`);
  }
  assert.equal(manifest.action.default_title, NAME);
  assert.equal(JSON.parse(read('addon/appsscript.json')).addOns.common.name, NAME, 'the phone panel has the same name');
  assert.match(read('src/shared/ns.js'), new RegExp(`APP_NAME = '${NAME}'`));
  assert.match(read('README.md'), new RegExp(`^(# |<h1[^>]*>)${NAME}\\b`, 'm'));
});

test('internal identifiers stay brand-free', () => {
  const name = manifest.name.toLowerCase();
  const ns = read('src/shared/ns.js');
  for (const key of ['gkb', 'columns:', 'order:', 'token:', 'gkb-board-host', 'gkb-dock-host']) {
    assert.ok(ns.includes(key), key);
    assert.equal(key.toLowerCase().includes(name), false, key);
  }
});

test('the preview loads exactly the manifest’s content scripts, in order', () => {
  const html = read('dev/preview.html');
  const scripts = [...html.matchAll(/<script src="\.\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, manifest.content_scripts[0].js);
});

test('manifest: version, permissions and a key whose ID the README reports', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.22.0');
  assert.ok(read('README.md').includes(`badge/version-${manifest.version}-`), 'the README\'s version badge is current');
  assert.deepEqual(manifest.permissions.sort(), ['identity', 'storage']);
  // Gmail; and Calendar, Tasks and the address check for the calendar.
  assert.deepEqual(manifest.host_permissions, ['https://gmail.googleapis.com/*', 'https://www.googleapis.com/*', 'https://tasks.googleapis.com/*']);
  assert.equal(manifest.commands['toggle-board'].suggested_key.default, 'Alt+Shift+K');
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.icons[size])), manifest.icons[size]);
  }

  const der = Buffer.from(manifest.key, 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.ok(read('README.md').includes(id), `README should state the extension ID ${id}`);
  assert.ok(read('README.md').includes(`https://${id}.chromiumapp.org/`));
});

test('one icon everywhere: the PNGs, the add-on, the phone app and the in-app mark all come from icons/icon.svg', () => {
  const svg = read('icons/icon.svg');
  for (const size of [16, 32, 48, 128, 192]) assert.ok(fs.existsSync(path.join(ROOT, 'icons', `icon-${size}.png`)), `icon-${size}.png`);
  const RAW = 'https://raw.githubusercontent.com/michaelbeijer/MemDesk/main/';
  const logoUrl = JSON.parse(read('addon/appsscript.json')).addOns.common.logoUrl;
  assert.ok(logoUrl.startsWith(RAW) && fs.existsSync(path.join(ROOT, logoUrl.slice(RAW.length))), logoUrl);
  const favicon = /var MEMDESK_ICON_URL = '([^']+)'/.exec(read('addon/Code.gs'))[1];
  assert.ok(favicon.startsWith(RAW) && fs.existsSync(path.join(ROOT, favicon.slice(RAW.length))), favicon);
  // The mark drawn inside the app is the icon's own drawing.
  const ui = read('src/content/ui.js');
  assert.equal(/letters: '([^']+)'/.exec(ui)[1], /<path fill="#fff" d="([^"]+)"/.exec(svg)[1]);
  const [dark, light] = [...svg.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map(m => m[1]);
  assert.match(ui, new RegExp(`colours: \\['${dark}', '${light}'\\]`));
});

test('no private key material in the repo', () => {
  for (const f of files('.', ['.pem', '.key', '.crx'])) {
    assert.fail(`${f} should not be committed`);
  }
  assert.match(read('.gitignore'), /^\*\.pem$/m);
});

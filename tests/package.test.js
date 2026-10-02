// The Chrome Web Store build: what goes in, and the two changes made to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const CLIENT = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

// Reads a zip's files back through its central directory.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const data = buf.subarray(local + 30 + buf.readUInt16LE(local + 26), local + 30 + buf.readUInt16LE(local + 26) + size);
    files.set(name, zlib.inflateRawSync(data));
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

test('the repository copy has no client built in: forks bring their own', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'src/shared/ns.js'), 'utf8'), /const BUILT_IN_CLIENT_ID = '';/);
});

test('the store build: the extension and nothing else, with the client built in and no key', async () => {
  const pkg = await import('../tools/package-extension.mjs');
  assert.throws(() => pkg.build({ clientId: '' }), /client ID is needed/);
  assert.throws(() => pkg.build({ clientId: 'GOCSPX-a-client-secret' }), /client ID is needed/);

  const { zip } = pkg.build({ clientId: CLIENT });
  const files = unzip(zip);
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.key, undefined, 'the store gives it its own ID');
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'))).version);
  assert.match(files.get('src/shared/ns.js').toString(), new RegExp(`const BUILT_IN_CLIENT_ID = '${CLIENT.replace(/\./g, '\\.')}';`));

  // Everything the manifest loads is there...
  const needed = [
    manifest.background.service_worker, manifest.options_ui.page,
    ...manifest.content_scripts.flatMap(c => c.js),
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ];
  for (const f of needed) assert.ok(files.has(f), f);
  // ...and nothing that is only for development.
  for (const name of files.keys()) assert.doesNotMatch(name, /^(dev|tests|tools|addon|images|dist)\//, name);
  // The files are the repository's, byte for byte, but for those two.
  for (const [name, data] of files) {
    if (name === 'manifest.json' || name === 'src/shared/ns.js') continue;
    assert.ok(data.equals(fs.readFileSync(path.join(ROOT, name))), name);
  }
});

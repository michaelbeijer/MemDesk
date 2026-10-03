#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// The Chrome Web Store build
//
//   node tools/package-extension.mjs --client-id=1234567890-abc.apps.googleusercontent.com
//
// Writes dist/memdesk-<version>.zip, ready to upload: the extension's
// own files (manifest, src/, the icons, the licence) and nothing else,
// with two changes from the repository's copy -
//
//   - the publisher's OAuth client written into src/shared/ns.js, so a
//     user just clicks "Connect Gmail" (see BUILT_IN_CLIENT_ID there);
//   - no "key" in the manifest: the store gives the item an ID of its own.
//
// The client ID can also come from MEMDESK_CLIENT_ID. No other tools
// needed: the zip is written here, with Node's own deflate.
// ─────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(REPO, dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(REPO, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

// What goes in: what the manifest loads, and the licence.
export function storeFiles() {
  return [
    'manifest.json',
    'LICENSE',
    ...walk('src').filter(f => /\.(js|html|css)$/.test(f)),
    ...walk('icons').filter(f => f.endsWith('.png')),
  ];
}

export function storeManifest(text) {
  const m = JSON.parse(text);
  delete m.key;
  return `${JSON.stringify(m, null, 2)}\n`;
}

export function withClientId(source, clientId) {
  const out = source.replace(/const BUILT_IN_CLIENT_ID = '';/, () => `const BUILT_IN_CLIENT_ID = '${clientId}';`);
  if (out === source) throw new Error('src/shared/ns.js has no empty BUILT_IN_CLIENT_ID to fill in');
  return out;
}

// ── A plain zip writer ───────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Buffer }]. A fixed date, so the same files
// always make the same zip.
export function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export function build({ clientId }) {
  if (!CLIENT_ID_RE.test(String(clientId || ''))) {
    throw new Error('A client ID is needed, like 1234567890-abc123.apps.googleusercontent.com (--client-id=… or MEMDESK_CLIENT_ID).');
  }
  const entries = storeFiles().map(name => {
    let data = readFileSync(join(REPO, ...name.split('/')));
    if (name === 'manifest.json') data = Buffer.from(storeManifest(data.toString('utf8')));
    if (name === 'src/shared/ns.js') data = Buffer.from(withClientId(data.toString('utf8'), clientId));
    return { name, data };
  });
  const version = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;
  return { version, entries, zip: zip(entries) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find(a => a.startsWith('--client-id='));
  const clientId = arg ? arg.slice('--client-id='.length) : process.env.MEMDESK_CLIENT_ID;
  try {
    const { version, entries, zip: data } = build({ clientId });
    const out = join(REPO, 'dist', `memdesk-${version}.zip`);
    mkdirSync(join(REPO, 'dist'), { recursive: true });
    writeFileSync(out, data);
    console.log(`Wrote ${relative(REPO, out).split(sep).join('/')} (${entries.length} files, ${Math.round(data.length / 1024)} KB).`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

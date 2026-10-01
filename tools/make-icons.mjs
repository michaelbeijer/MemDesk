#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Toolbar and store icons, drawn from code
//
//   node tools/make-icons.mjs
//
// Writes icons/icon-{16,32,48,128}.png: a rounded blue square with three
// white column bars of different heights - a board at a glance. There is
// no image library on hand, so this is a minimal PNG encoder (zlib from
// Node, CRC32 by table) and an 8×8 supersampled rasteriser, which is all
// a few rounded rectangles need.
//
// Geometry is set per size rather than scaled, so the bars land on whole
// pixels at 16px and 32px, where a half-pixel edge turns into mush.
// ─────────────────────────────────────────────────────────────────────

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// pad: margin inside the square; bw: bar width; gap: space between bars.
const SIZES = {
  16: { pad: 3, bw: 2, gap: 2 },
  32: { pad: 7, bw: 4, gap: 3 },
  48: { pad: 10, bw: 6, gap: 5 },
  128: { pad: 27, bw: 18, gap: 10 },
};

const TOP = [0x35, 0x78, 0xe9];    // gradient, top
const BOTTOM = [0x1c, 0x53, 0xc4]; // gradient, bottom
const BAR = [0xff, 0xff, 0xff];

// ── Shapes ───────────────────────────────────────────────────────────

// Is (x, y) inside a rectangle with corner radius r?
function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function draw(size) {
  const { pad, bw, gap } = SIZES[size];
  const inner = size - 2 * pad;
  const heights = [inner, Math.round(inner * 0.58), Math.round(inner * 0.8)];
  const bars = heights.map((ht, i) => ({ x: pad + i * (bw + gap), y: pad, w: bw, h: ht }));
  const corner = size * 0.22;
  const barR = Math.max(0.6, bw * 0.3);

  const SS = 8;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRoundRect(fx, fy, 0, 0, size, size, corner)) continue;
          bg++;
          if (bars.some(b => inRoundRect(fx, fy, b.x, b.y, b.w, b.h, barR))) fg++;
        }
      }
      const n = SS * SS;
      const t = y / (size - 1);
      const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
      const mix = bg ? fg / bg : 0;
      const rgb = base.map((c, i) => Math.round(c + (BAR[i] - c) * mix));
      const o = (y * size + x) * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = Math.round((bg / n) * 255);
    }
  }
  return px;
}

// ── PNG encoding ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with filter type 0 (none). The images are
  // tiny; smarter filtering would save a few hundred bytes at most.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Main ─────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
for (const size of Object.keys(SIZES).map(Number)) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, draw(size)));
  console.log(`wrote ${file}`);
}

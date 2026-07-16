#!/usr/bin/env node
// Generates build/icon.png (512×512): the app icon electron-builder converts
// per-platform (.ico for Windows, .icns for mac, as-is for Linux). Pure Node —
// a tiny PNG encoder over zlib — so the icon is reproducible from source and
// no binary asset has to be hand-maintained. Design: terminal prompt chevron
// and block cursor in the phosphor accent on the app's dark background.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");

const SIZE = 512;
const RADIUS = 92; // rounded-corner radius of the tile
const BG = [7, 14, 10, 255]; // near styles.css --bg (phosphor theme)
const ACC = [49, 224, 140, 255]; // styles.css --acc (phosphor theme)
const EDGE = [24, 82, 54, 255]; // dim accent for the border ring

/** Signed inside-test for the tile's rounded rect, inset by `inset` px. */
function insideTile(x, y, inset) {
  const lo = inset;
  const hi = SIZE - 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const r = Math.max(0, RADIUS - inset);
  const cx = x < lo + r ? lo + r : x > hi - r ? hi - r : x;
  const cy = y < lo + r ? lo + r : y > hi - r ? hi - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Distance from point p to segment a→b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Glyph geometry: chevron ❯ left of center, block cursor ▮ right of it.
const STROKE = 27; // half-width of the chevron strokes
const CHEV = [
  [152, 158, 262, 256],
  [262, 256, 152, 354],
];
const CURSOR = { x0: 316, x1: 396, y0: 214, y1: 356 };

function pixel(x, y) {
  if (!insideTile(x, y, 0)) return [0, 0, 0, 0];
  if (!insideTile(x, y, 7)) return EDGE; // border ring
  for (const [ax, ay, bx, by] of CHEV) {
    if (segDist(x, y, ax, ay, bx, by) <= STROKE) return ACC;
  }
  if (x >= CURSOR.x0 && x <= CURSOR.x1 && y >= CURSOR.y0 && y <= CURSOR.y1) return ACC;
  return BG;
}

// --- minimal PNG encoder (RGBA8, filter 0) ---------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let off = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
      raw[off++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng());
console.log(`Wrote ${out}`);

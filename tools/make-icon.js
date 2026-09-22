'use strict';
/**
 * Generate the app icons with no image dependencies:
 *
 *   build/icon.png        512x512, used by electron-builder for installers
 *   src/assets/icon.png   256x256, shipped in the app (window icon, Linux tray)
 *   src/assets/tray.ico   16/20/24/32/48/64, shipped in the app (Windows tray)
 *
 * Only src/** is packed into the application, so anything the running app
 * needs must live under src/assets — build/ never ships.
 *
 * Run with: node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Rounded-rectangle coverage, anti-aliased by 3x3 supersampling. */
function roundedRectCoverage(x, y, left, top, right, bottom, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      if (px < left || px > right || py < top || py > bottom) continue;
      const cx = Math.min(Math.max(px, left + radius), right - radius);
      const cy = Math.min(Math.max(py, top + radius), bottom - radius);
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 9;
}

/** Render the icon at any square size; geometry is defined on a 512 grid. */
function build(SIZE) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  const s = SIZE / 512;

  // Two rounded bars — the two lines — over a dark rounded tile.
  // Small sizes drop the tile inset so the mark fills the 16px cell.
  const inset = SIZE >= 64 ? 26 * s : 0;
  const tile = { left: inset, top: inset, right: SIZE - inset, bottom: SIZE - inset, radius: 104 * s };
  const barA = { left: 126 * s, top: 138 * s, right: 236 * s, bottom: 374 * s, radius: 55 * s };
  const barB = { left: 276 * s, top: 138 * s, right: 386 * s, bottom: 374 * s, radius: 55 * s };

  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;                                   // filter: none
    for (let x = 0; x < SIZE; x++) {
      const i = rowStart + 1 + x * 4;

      const tileA = roundedRectCoverage(x, y, tile.left, tile.top, tile.right, tile.bottom, tile.radius);
      const aCov = roundedRectCoverage(x, y, barA.left, barA.top, barA.right, barA.bottom, barA.radius);
      const bCov = roundedRectCoverage(x, y, barB.left, barB.top, barB.right, barB.bottom, barB.radius);

      // Background tile
      let r = 0x1a, g = 0x1f, b = 0x29;
      // Blue bar (line 1), vertical gradient
      if (aCov > 0) {
        const t = (y - barA.top) / (barA.bottom - barA.top);
        const [br, bg, bb] = [0x4c + t * 0x20, 0x8d - t * 0x10, 0xff - t * 0x30];
        r = r * (1 - aCov) + br * aCov;
        g = g * (1 - aCov) + bg * aCov;
        b = b * (1 - aCov) + bb * aCov;
      }
      // Green bar (line 2)
      if (bCov > 0) {
        const t = (y - barB.top) / (barB.bottom - barB.top);
        const [gr, gg, gb] = [0x2f + t * 0x20, 0xbf - t * 0x18, 0x71 + t * 0x10];
        r = r * (1 - bCov) + gr * bCov;
        g = g * (1 - bCov) + gg * bCov;
        b = b * (1 - bCov) + gb * bCov;
      }

      raw[i] = Math.round(r);
      raw[i + 1] = Math.round(g);
      raw[i + 2] = Math.round(b);
      raw[i + 3] = Math.round(tileA * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ICO container holding PNG-compressed images (supported since Vista, and
 * what Windows itself uses for large icon sizes).
 */
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, png: build(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                   // reserved
  header.writeUInt16LE(1, 2);                   // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;          // width  (0 means 256)
    entry[1] = size >= 256 ? 0 : size;          // height
    entry[2] = 0;                               // palette
    entry[3] = 0;                               // reserved
    entry.writeUInt16LE(1, 4);                  // colour planes
    entry.writeUInt16LE(32, 6);                 // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const root = path.join(__dirname, '..');
const outputs = [
  [path.join(root, 'build', 'icon.png'), build(512)],
  [path.join(root, 'src', 'assets', 'icon.png'), build(256)],
  [path.join(root, 'src', 'assets', 'tray.ico'), buildIco([16, 20, 24, 32, 48, 64])],
];
for (const [file, data] of outputs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`wrote ${path.relative(root, file)} (${data.length} bytes)`);
}

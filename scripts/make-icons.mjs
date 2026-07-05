/**
 * Regenerates public/icons/*.png — run `node scripts/make-icons.mjs` after
 * changing colors/geometry. Zero-dep PNG writer (zlib + hand-rolled chunks)
 * so the repo needs no image toolchain. All shapes are axis-aligned rects:
 * no anti-aliasing needed, output is deterministic.
 *
 * Design: app background #101418, barbell glyph — plates in --cleared green
 * #4ADE9C, bar in --text #E8EDF2. Glyph fits the maskable safe zone (inner
 * 80% circle), so the same art serves purpose:any and purpose:maskable.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BG = [0x10, 0x14, 0x18, 255];    // --bg
const PLATE = [0x4a, 0xde, 0x9c, 255]; // --cleared
const BAR = [0xe8, 0xed, 0xf2, 255];   // --text

/* ---- minimal PNG encoder ---- */
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
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---- glyph ---- */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const rects = []; // [x0, x1, y0, y1, color] as fractions of size
  const bar = 0.026, cy = 0.5;
  rects.push([0.15, 0.85, cy - bar, cy + bar, BAR]);                 // bar
  for (const [x0, x1, hh] of [
    [0.26, 0.325, 0.17], [0.675, 0.74, 0.17],                        // inner plates
    [0.20, 0.25, 0.125], [0.75, 0.80, 0.125]                         // outer plates
  ]) rects.push([x0, x1, cy - hh, cy + hh, PLATE]);

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x + 0.5) / size, fy = (y + 0.5) / size;
    let c = BG;
    for (const [x0, x1, y0, y1, col] of rects)
      if (fx >= x0 && fx < x1 && fy >= y0 && fy < y1) c = col;
    px.set(c, (y * size + x) * 4);
  }
  return png(size, px);
}

mkdirSync(OUT, { recursive: true });
for (const [file, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(OUT, file), draw(size));
  console.log(`wrote public/icons/${file} (${size}x${size})`);
}

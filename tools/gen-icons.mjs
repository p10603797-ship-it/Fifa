/* global console, process, URL, Buffer */
/**
 * [PLT-01] Deterministic app icons: the DotKick mark (an ember dot with a small chalk dot kicked off it) on ink,
 * rendered in code (4x4 supersampled coverage, no randomness, no fonts) and encoded as PNG with node:zlib.
 * Same code -> same pixels -> same bytes, so the files in public/icons never change unless this script does.
 *
 *   node tools/gen-icons.mjs           write public/icons/*.png
 *   node tools/gen-icons.mjs --check   exit 1 if public/icons differs from what this script renders
 *
 * Icons (manifest.webmanifest and index.html reference these names):
 *   icon-192.png, icon-512.png       purpose "any"
 *   icon-maskable-512.png            purpose "maskable" (mark inside the 80 % safe circle)
 *   apple-touch-icon-180.png         iOS Home Screen (opaque; iOS rounds the corners)
 *   icon-32.png                      small favicon
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** Dot design system colours (src/ui/tokens.css): ink background, ember mark, chalk ball. */
export const ICON_COLOURS = {
  ink: [0x07, 0x07, 0x0d],
  ember: [0xff, 0x6b, 0x35],
  chalk: [0xf4, 0xf1, 0xec],
};

/** Mark geometry in unit icon space (0..1), before the per-icon scale about the centre. */
export const MARK = {
  dot: { x: 0.45, y: 0.53, r: 0.27 },
  ball: { x: 0.735, y: 0.295, r: 0.075 },
};

/** Every icon this script writes: file name, pixel size, mark scale about the centre. */
export const ICONS = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'icon-maskable-512.png', size: 512, scale: 0.8 },
  { name: 'apple-touch-icon-180.png', size: 180, scale: 0.9 },
  { name: 'icon-32.png', size: 32, scale: 1.1 },
];

const SS = 4; // supersamples per axis

/** Coverage (0..1) of a disc at pixel (px, py) of a size x size image, 4x4 supersampled. Pure. */
function discCoverage(px, py, size, cx, cy, r) {
  let hit = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const u = (px + (sx + 0.5) / SS) / size - cx;
      const v = (py + (sy + 0.5) / SS) / size - cy;
      if (u * u + v * v <= r * r) hit++;
    }
  }
  return hit / (SS * SS);
}

function scaled(d, scale) {
  return { x: 0.5 + (d.x - 0.5) * scale, y: 0.5 + (d.y - 0.5) * scale, r: d.r * scale };
}

/** Render an opaque RGB image (Uint8Array, row-major, 3 bytes per pixel). Pure and deterministic. */
export function renderIcon(size, scale = 1) {
  const out = new Uint8Array(size * size * 3);
  const dot = scaled(MARK.dot, scale);
  const ball = scaled(MARK.ball, scale);
  const { ink, ember, chalk } = ICON_COLOURS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = discCoverage(x, y, size, dot.x, dot.y, dot.r);
      const b = discCoverage(x, y, size, ball.x, ball.y, ball.r);
      const o = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        let v = ink[c] + (ember[c] - ink[c]) * a;
        v = v + (chalk[c] - v) * b;
        out[o + c] = Math.round(v);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (PNG chunks). Pure. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode an RGB image as a PNG (8-bit truecolour, no interlace, filter 0, zlib level 9). Deterministic. */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Render and encode every icon: [{ name, size, png }]. */
export function generateIcons() {
  return ICONS.map((i) => ({ name: i.name, size: i.size, png: encodePng(i.size, i.size, renderIcon(i.size, i.scale)) }));
}

/** Write the icons into `dir` (or only compare with `check`). Returns the names that differ / were written. */
export function writeIcons(dir, check = false) {
  const changed = [];
  if (!check) mkdirSync(dir, { recursive: true });
  for (const icon of generateIcons()) {
    const p = join(dir, icon.name);
    const same = existsSync(p) && Buffer.compare(readFileSync(p), icon.png) === 0;
    if (!same) {
      changed.push(icon.name);
      if (!check) writeFileSync(p, icon.png);
    }
  }
  return changed;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const dir = join(root, 'public', 'icons');
  const check = process.argv.includes('--check');
  const changed = writeIcons(dir, check);
  if (check) {
    if (changed.length > 0) {
      console.error(`gen-icons: FAIL ${changed.join(', ')} differ from the generator (run node tools/gen-icons.mjs)`);
      process.exit(1);
    }
    console.log('gen-icons: icons are up to date');
  } else {
    console.log(changed.length > 0 ? `gen-icons: wrote ${changed.join(', ')}` : 'gen-icons: icons already up to date');
  }
}

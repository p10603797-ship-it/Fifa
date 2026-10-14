/**
 * [GFX-08] A tiny deterministic vector rasteriser for the kit atlas (helper of src/render/kits.ts).
 *
 * Why not a 2D canvas: the atlas must look the same in every browser, must not depend on fonts, and its pixels are
 * unit-tested in Node (no DOM there). Everything here works on plain typed arrays:
 *  - Img: straight-alpha RGBA8, rows top to bottom (canvas order).
 *  - Mask: float coverage 0..1.
 *  - fillShape: exact-area anti-aliased polygon coverage (signed-area accumulation, the font-rs method); a shape is a
 *    list of closed contours, holes by opposite winding (nonzero rule, saturating).
 *  - strokeLines: round-capped thick polylines from a distance field (digits), with an optional outline ring.
 *  - blendMask: source-over compositing of a colour through a mask (sRGB space, like canvas / SVG).
 *  - buildMips: box-filtered mip chain in linear light with alpha weighting; with every atlas tile aligned to 32 px,
 *    levels 1..5 never mix two tiles, so there is no colour bleeding between kits at a distance.
 * Runs at match setup only (never per frame); allocation is fine but large buffers are reused.
 */

import type { Rgb } from '../../contracts/data';
import { LINEAR_TO_SRGB8, SRGB_TO_LINEAR, chB, chG, chR } from './colour';

/** Straight-alpha RGBA8 image, rows top to bottom. */
export interface Img { w: number; h: number; data: Uint8Array }
/** Coverage mask 0..1, rows top to bottom. */
export interface Mask { w: number; h: number; a: Float32Array }
/** A closed contour as a flat list [x0, y0, x1, y1, ...]. */
export type Contour = readonly number[];
/** One filled shape: outer contour(s) plus holes with opposite winding. */
export type Shape = readonly Contour[];

export function createImg(w: number, h: number): Img {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

export function createMask(w: number, h: number): Mask {
  return { w, h, a: new Float32Array(w * h) };
}

/** Fill a rectangle (integer pixel bounds, clipped) with an opaque or translucent colour (replaces the pixels). */
export function fillRect(img: Img, x: number, y: number, w: number, h: number, rgb: Rgb, alpha = 255): void {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(img.w, (x + w) | 0), y1 = Math.min(img.h, (y + h) | 0);
  const r = chR(rgb), g = chG(rgb), b = chB(rgb);
  const d = img.data;
  for (let yy = y0; yy < y1; yy++) {
    let o = (yy * img.w + x0) * 4;
    for (let xx = x0; xx < x1; xx++, o += 4) {
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = alpha;
    }
  }
}

/** Copy a w x h block between images (clipped to both). */
export function copyRect(src: Img, sx: number, sy: number, w: number, h: number, dst: Img, dx: number, dy: number): void {
  for (let j = 0; j < h; j++) {
    const ys = sy + j, yd = dy + j;
    if (ys < 0 || ys >= src.h || yd < 0 || yd >= dst.h) continue;
    let x0 = 0, x1 = w;
    if (sx + x0 < 0) x0 = -sx;
    if (dx + x0 < 0) x0 = Math.max(x0, -dx);
    if (sx + x1 > src.w) x1 = src.w - sx;
    if (dx + x1 > dst.w) x1 = Math.min(x1, dst.w - dx);
    if (x1 <= x0) continue;
    const so = (ys * src.w + sx + x0) * 4;
    dst.data.set(src.data.subarray(so, so + (x1 - x0) * 4), (yd * dst.w + dx + x0) * 4);
  }
}

// ---------------------------------------------------------------- polygon coverage (signed-area accumulation)

let accBuf = new Float64Array(0);

function accLine(acc: Float64Array, stride: number, w: number, h: number, px0: number, py0: number, px1: number, py1: number): void {
  if (py0 === py1) return;
  let dir = 1;
  let x0 = px0, y0 = py0, x1 = px1, y1 = py1;
  if (y0 > y1) {
    dir = -1;
    x0 = px1; y0 = py1; x1 = px0; y1 = py0;
  }
  if (y1 <= 0 || y0 >= h) return;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) x -= y0 * dxdy;
  const yStart = y0 < 0 ? 0 : Math.floor(y0);
  const yEnd = Math.min(h, Math.ceil(y1));
  for (let y = yStart; y < yEnd; y++) {
    const ls = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    let xa = x < xnext ? x : xnext;
    let xb = x < xnext ? xnext : x;
    // Clip horizontally: everything left of the image counts at column 0, right of it is dropped.
    if (xa < 0) xa = 0; else if (xa > w) xa = w;
    if (xb < 0) xb = 0; else if (xb > w) xb = w;
    const xaF = Math.floor(xa);
    const xai = xaF;
    const xbC = Math.ceil(xb);
    const xbi = xbC;
    if (xbi <= xai + 1) {
      const xmf = 0.5 * (xa + xb) - xaF;
      acc[ls + xai] += d - d * xmf;
      acc[ls + xai + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const xaf = xa - xaF;
      const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
      const xbf = xb - xbC + 1;
      const am = 0.5 * s * xbf * xbf;
      acc[ls + xai] += d * a0;
      if (xbi === xai + 2) {
        acc[ls + xai + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - xaf);
        acc[ls + xai + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbi - 1; xi++) acc[ls + xi] += d * s;
        const a2 = a1 + (xbi - xai - 3) * s;
        acc[ls + xbi - 1] += d * (1 - a2 - am);
      }
      acc[ls + xbi] += d * am;
    }
    x = xnext;
  }
}

/**
 * Fill one shape into the mask (coverage merged with max, so separate shapes union). Point (x, y) of the shape maps
 * to mask pixel coordinates (ox + x * sx, oy + y * sy); pixel (i, j) covers [i, i+1] x [j, j+1].
 */
export function fillShape(m: Mask, shape: Shape, ox: number, oy: number, sx: number, sy: number): void {
  const w = m.w, h = m.h, stride = w + 2;
  const n = stride * h;
  if (accBuf.length < n) accBuf = new Float64Array(n);
  const acc = accBuf;
  acc.fill(0, 0, n);
  for (let c = 0; c < shape.length; c++) {
    const pts = shape[c]!;
    const k = pts.length >> 1;
    if (k < 3) continue;
    for (let i = 0; i < k; i++) {
      const j = i + 1 === k ? 0 : i + 1;
      accLine(acc, stride, w, h, ox + pts[2 * i]! * sx, oy + pts[2 * i + 1]! * sy, ox + pts[2 * j]! * sx, oy + pts[2 * j + 1]! * sy);
    }
  }
  const a = m.a;
  for (let y = 0; y < h; y++) {
    let s = 0;
    const ls = y * stride, lm = y * w;
    for (let x = 0; x < w; x++) {
      s += acc[ls + x]!;
      const cov = s < 0 ? (s < -1 ? 1 : -s) : s > 1 ? 1 : s;
      if (cov > 1e-6 && cov > a[lm + x]!) a[lm + x] = cov; // float residue of cancelled edges stays 0
    }
  }
}

/** Fill several shapes (union). */
export function fillShapes(m: Mask, shapes: readonly Shape[], ox: number, oy: number, sx: number, sy: number): void {
  for (let i = 0; i < shapes.length; i++) fillShape(m, shapes[i]!, ox, oy, sx, sy);
}

// ---------------------------------------------------------------- strokes (distance field)

let distBuf = new Float64Array(0);

/**
 * Stroke polylines (each a flat [x0, y0, x1, y1, ...], open; repeat the first point to close) with round caps and
 * joins: coverage = clamp(radius - distance + 0.5). Point (x, y) maps to (ox + x * s, oy + y * s) pixels; radius in
 * pixels. When `outline` is given, it receives the coverage of the stroke widened by outlineR pixels (the ring is
 * outline minus fill). Coverage merges with max.
 */
export function strokeLines(fill: Mask, lines: readonly (readonly number[])[], ox: number, oy: number, s: number, radius: number,
  outline?: Mask, outlineR = 0): void {
  const w = fill.w, h = fill.h;
  const reach = radius + outlineR + 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l]!;
    for (let i = 0; i < p.length; i += 2) {
      const x = ox + p[i]! * s, y = oy + p[i + 1]! * s;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const rx0 = Math.max(0, Math.floor(minX - reach)), rx1 = Math.min(w, Math.ceil(maxX + reach));
  const ry0 = Math.max(0, Math.floor(minY - reach)), ry1 = Math.min(h, Math.ceil(maxY + reach));
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  if (distBuf.length < rw * rh) distBuf = new Float64Array(rw * rh);
  const dist = distBuf;
  dist.fill(Infinity, 0, rw * rh);
  // Squared distance to the nearest segment, visiting only the pixels near each segment.
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l]!;
    const single = p.length === 2;
    for (let i = single ? 0 : 2; i < p.length; i += 2) {
      const ax = ox + p[single ? 0 : i - 2]! * s, ay = oy + p[single ? 1 : i - 1]! * s;
      const bx = ox + p[i]! * s, by = oy + p[i + 1]! * s;
      const ex = bx - ax, ey = by - ay;
      const len2 = ex * ex + ey * ey;
      const sx0 = Math.max(rx0, Math.floor(Math.min(ax, bx) - reach)), sx1 = Math.min(rx1, Math.ceil(Math.max(ax, bx) + reach));
      const sy0 = Math.max(ry0, Math.floor(Math.min(ay, by) - reach)), sy1 = Math.min(ry1, Math.ceil(Math.max(ay, by) + reach));
      for (let py = sy0; py < sy1; py++) {
        const cy = py + 0.5;
        const row = (py - ry0) * rw - rx0;
        for (let px = sx0; px < sx1; px++) {
          const cx = px + 0.5;
          let t = len2 > 0 ? ((cx - ax) * ex + (cy - ay) * ey) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const dx = cx - (ax + ex * t), dy = cy - (ay + ey * t);
          const d2 = dx * dx + dy * dy;
          if (d2 < dist[row + px]!) dist[row + px] = d2;
        }
      }
    }
  }
  for (let py = ry0; py < ry1; py++) {
    for (let px = rx0; px < rx1; px++) {
      const d2 = dist[(py - ry0) * rw + px - rx0]!;
      if (d2 === Infinity) continue;
      const d = Math.sqrt(d2);
      const o = py * w + px;
      let c = radius - d + 0.5;
      c = c < 0 ? 0 : c > 1 ? 1 : c;
      if (c > fill.a[o]!) fill.a[o] = c;
      if (outline) {
        let co = radius + outlineR - d + 0.5;
        co = co < 0 ? 0 : co > 1 ? 1 : co;
        if (co > outline.a[o]!) outline.a[o] = co;
      }
    }
  }
}

// ---------------------------------------------------------------- compositing

/**
 * Composite `rgb` through mask m onto img with the mask's top-left at (x, y): source-over, straight alpha, in sRGB
 * space. Mask pixels outside the image are skipped.
 */
export function blendMask(img: Img, x: number, y: number, m: Mask, rgb: Rgb, opacity = 1): void {
  const r = chR(rgb), g = chG(rgb), b = chB(rgb);
  const d = img.data;
  for (let j = 0; j < m.h; j++) {
    const yy = y + j;
    if (yy < 0 || yy >= img.h) continue;
    for (let i = 0; i < m.w; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= img.w) continue;
      const as = m.a[j * m.w + i]! * opacity;
      if (as <= 0) continue;
      const o = (yy * img.w + xx) * 4;
      const ad = d[o + 3]! / 255;
      const ao = as + ad * (1 - as);
      if (ao <= 0) continue;
      const kd = (ad * (1 - as)) / ao, ks = as / ao;
      d[o] = Math.round(r * ks + d[o]! * kd);
      d[o + 1] = Math.round(g * ks + d[o + 1]! * kd);
      d[o + 2] = Math.round(b * ks + d[o + 2]! * kd);
      d[o + 3] = Math.round(ao * 255);
    }
  }
}

/** Composite a per-pixel coverage function of the image region (x, y, w, h); cov(px, py) in region pixels. */
export function blendFn(img: Img, x: number, y: number, w: number, h: number, rgb: Rgb, cov: (px: number, py: number) => number): void {
  const r = chR(rgb), g = chG(rgb), b = chB(rgb);
  const d = img.data;
  for (let j = 0; j < h; j++) {
    const yy = y + j;
    if (yy < 0 || yy >= img.h) continue;
    for (let i = 0; i < w; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= img.w) continue;
      let as = cov(i, j);
      if (!(as > 0)) continue;
      if (as > 1) as = 1;
      const o = (yy * img.w + xx) * 4;
      const ad = d[o + 3]! / 255;
      const ao = as + ad * (1 - as);
      const kd = (ad * (1 - as)) / ao, ks = as / ao;
      d[o] = Math.round(r * ks + d[o]! * kd);
      d[o + 1] = Math.round(g * ks + d[o + 1]! * kd);
      d[o + 2] = Math.round(b * ks + d[o + 2]! * kd);
      d[o + 3] = Math.round(ao * 255);
    }
  }
}

/**
 * Coverage of the "on" part of a square wave over the interval [a, b] (any units): the wave is on for
 * t in [phase + k * period, phase + (k + duty) * period). Exact box-filtered value in 0..1.
 */
export function squareWaveCoverage(a: number, b: number, period: number, phase: number, duty: number): number {
  if (b <= a) return 0;
  return (waveIntegral(b, period, phase, duty) - waveIntegral(a, period, phase, duty)) / (b - a);
}

/** Integral of the square wave from phase to t (see squareWaveCoverage). */
function waveIntegral(t: number, period: number, phase: number, duty: number): number {
  const u = (t - phase) / period;
  const k = Math.floor(u);
  const f = u - k;
  return (k * duty + (f < duty ? f : duty)) * period;
}

// ---------------------------------------------------------------- mip chain

/** One mip level in GL order (row 0 = bottom, v = 0), RGBA8. */
export interface MipLevel { data: Uint8Array; width: number; height: number }

/** Allocate `levels` GL-order level buffers for a w x h image (level i is (w >> i) x (h >> i)). */
export function createMipLevels(w: number, h: number, levels: number): MipLevel[] {
  const out: MipLevel[] = [];
  for (let i = 0; i < levels; i++) {
    const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
    out.push({ data: new Uint8Array(lw * lh * 4), width: lw, height: lh });
  }
  return out;
}

/** Linear light of an sRGB byte scaled to 0..4095 (integer), for the opaque fast path of the mip filter. */
const LIN12: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(SRGB_TO_LINEAR[i]! * 4095);
  return t;
})();

function flipInto(src: Uint8Array, w: number, h: number, dst: Uint8Array): void {
  const row = w * 4;
  for (let y = 0; y < h; y++) dst.set(src.subarray(y * row, y * row + row), (h - 1 - y) * row);
}

/**
 * Fill `levels` (from createMipLevels) from a top-down image: level 0 is the image flipped to GL order; each further
 * level is a 2x2 box filter of the previous one in linear light, colour weighted by alpha (no dark fringes around
 * transparent cells). With even level heights the 2x2 blocks are the same in either row order. Deterministic.
 * premultipliedLinear: the data is linear premultiplied coverage (glyph masks), so all four channels are plainly
 * averaged (no sRGB conversion, no alpha weighting).
 */
export function buildMips(img: Img, levels: MipLevel[], premultipliedLinear = false): void {
  flipInto(img.data, img.w, img.h, levels[0]!.data);
  const L = SRGB_TO_LINEAR, E = LINEAR_TO_SRGB8, L12 = LIN12;
  for (let lv = 1; lv < levels.length; lv++) {
    const srcL = levels[lv - 1]!, dstL = levels[lv]!;
    const src = srcL.data, dst = dstL.data;
    const w = srcL.width, h = srcL.height, nw = dstL.width, nh = dstL.height;
    if (premultipliedLinear) {
      for (let y = 0; y < nh; y++) {
        const y0 = Math.min(h - 1, 2 * y), y1 = Math.min(h - 1, 2 * y + 1);
        for (let x = 0; x < nw; x++) {
          const x0 = Math.min(w - 1, 2 * x), x1 = Math.min(w - 1, 2 * x + 1);
          const o00 = (y0 * w + x0) * 4, o01 = (y0 * w + x1) * 4, o10 = (y1 * w + x0) * 4, o11 = (y1 * w + x1) * 4;
          const o = (y * nw + x) * 4;
          for (let c = 0; c < 4; c++) dst[o + c] = (src[o00 + c]! + src[o01 + c]! + src[o10 + c]! + src[o11 + c]! + 2) >> 2;
        }
      }
      continue;
    }
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(h - 1, 2 * y), y1 = Math.min(h - 1, 2 * y + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, 2 * x), x1 = Math.min(w - 1, 2 * x + 1);
        const o00 = (y0 * w + x0) * 4, o01 = (y0 * w + x1) * 4, o10 = (y1 * w + x0) * 4, o11 = (y1 * w + x1) * 4;
        const a00 = src[o00 + 3]!, a01 = src[o01 + 3]!, a10 = src[o10 + 3]!, a11 = src[o11 + 3]!;
        const as = a00 + a01 + a10 + a11;
        const o = (y * nw + x) * 4;
        if (as === 1020) {
          dst[o] = E[(L12[src[o00]!]! + L12[src[o01]!]! + L12[src[o10]!]! + L12[src[o11]!]! + 2) >> 2]!;
          dst[o + 1] = E[(L12[src[o00 + 1]!]! + L12[src[o01 + 1]!]! + L12[src[o10 + 1]!]! + L12[src[o11 + 1]!]! + 2) >> 2]!;
          dst[o + 2] = E[(L12[src[o00 + 2]!]! + L12[src[o01 + 2]!]! + L12[src[o10 + 2]!]! + L12[src[o11 + 2]!]! + 2) >> 2]!;
          dst[o + 3] = 255;
          continue;
        }
        if (as === 0) {
          dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const v = (L[src[o00 + c]!]! * a00 + L[src[o01 + c]!]! * a01 + L[src[o10 + c]!]! * a10 + L[src[o11 + c]!]! * a11) / as;
          dst[o + c] = E[Math.round(v * 4095)]!;
        }
        dst[o + 3] = Math.round(as / 4);
      }
    }
  }
}

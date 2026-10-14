/**
 * [GFX-08] Club crests from Crest data (helper of src/render/kits.ts): geometric shield shapes, colour layouts and
 * emblems built as polygons in a 100 x 100 box (y down). One geometry feeds two outputs:
 *  - SVG markup (crestSvg) for menus and the HUD: crisp at any size, no canvas needed;
 *  - the kit atlas rasteriser (crest cells and the chest badge).
 * Crest.shape 0..5: shield, circle, diamond, hexagon, square, chevron. Crest.layout 0..3: plain field, vertical
 * halves, horizontal band, diagonal sash. Crest.emblem 0..9: star, bolt, wave, ring, triangle, arrow, bars, sun,
 * dots, gem (src/data/clubs.ts CREST_SHAPES / CREST_LAYOUTS / CREST_EMBLEMS). Out-of-range ids wrap; bad colours
 * clamp. All shapes are original geometric marks.
 */

import type { Crest, Rgb } from '../../contracts/data';
import { cssHex } from './colour';
import type { Contour, Shape } from './raster';

/** One colour layer: shapes filled in order (each shape: outer contour + holes with opposite winding). */
export interface CrestLayer { rgb: Rgb; shapes: Shape[] }

const LOCAL_TUNING = { // TUNING-CR (crest look; menus/HUD/atlas only, no gameplay effect)
  /** Width of the outer rim in the secondary colour (crest units of 100). */
  rimWidth: 6,
  /** Emblem radius on a plain field (crest units). */
  emblemRadius: 25,
  /** Roundel (behind the emblem on split layouts): outer radius, inner radius, emblem radius (crest units). */
  roundelOuter: 27,
  roundelInner: 22.5,
  roundelEmblem: 16,
  /** Half width of the horizontal band / diagonal sash layouts (crest units). */
  bandHalf: 12,
} as const;

function circle(cx: number, cy: number, r: number, n: number, reverse = false): number[] {
  const p: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((reverse ? -i : i) / n) * Math.PI * 2;
    p.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return p;
}

function quad(out: number[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, n: number): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
}

/** Convex outline of crest shape id (0..5) in the 100 x 100 box. */
export function crestOutline(shape: number): number[] {
  switch (((shape % 6) + 6) % 6) {
    case 0: { // shield
      const p = [10, 7, 90, 7, 90, 44];
      quad(p, 90, 44, 90, 78, 50, 95, 10);
      quad(p, 50, 95, 10, 78, 10, 44, 10);
      p.length -= 2; // last point repeats the start of the left edge
      return p;
    }
    case 1: return circle(50, 50, 46, 48);
    case 2: return [50, 3, 97, 50, 50, 97, 3, 50];
    case 3: {
      const p: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = ((-90 + 60 * i) * Math.PI) / 180;
        p.push(50 + 48 * Math.cos(a), 50 + 48 * Math.sin(a));
      }
      return p;
    }
    case 4: { // rounded square
      const p: number[] = [];
      const r = 14, a = 6, b = 94;
      const corners = [[b - r, a + r, -90], [b - r, b - r, 0], [a + r, b - r, 90], [a + r, a + r, 180]] as const;
      for (const [cx, cy, start] of corners) {
        for (let i = 0; i <= 6; i++) {
          const t = ((start + (90 * i) / 6) * Math.PI) / 180;
          p.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
        }
      }
      return p;
    }
    default: return [8, 8, 92, 8, 92, 58, 50, 94, 8, 58]; // chevron pennant
  }
}

function signedArea(p: readonly number[]): number {
  let s = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!;
  }
  return s / 2;
}

/** Offset a convex polygon inward by d (mitred corners). */
export function insetConvex(p: readonly number[], d: number): number[] {
  const n = p.length >> 1;
  const sign = signedArea(p) > 0 ? 1 : -1;
  const nx: number[] = [], ny: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = p[2 * j]! - p[2 * i]!, ey = p[2 * j + 1]! - p[2 * i + 1]!;
    const l = Math.sqrt(ex * ex + ey * ey) || 1;
    // Inward normal: for positive (y-down clockwise-looking) area the interior is to the left of (ex, ey) rotated.
    nx.push((-ey / l) * sign);
    ny.push((ex / l) * sign);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n; // edge ending at vertex i
    const k = 1 + nx[a]! * nx[i]! + ny[a]! * ny[i]!;
    const m = k > 0.2 ? d / k : d / 0.2;
    out.push(p[2 * i]! + (nx[a]! + nx[i]!) * m, p[2 * i + 1]! + (ny[a]! + ny[i]!) * m);
  }
  return out;
}

/** Sutherland-Hodgman: clip polygon `subject` by convex polygon `clip`. */
export function clipConvex(subject: readonly number[], clip: readonly number[]): number[] {
  const sign = signedArea(clip) > 0 ? 1 : -1;
  let out: number[] = subject.slice();
  const n = clip.length >> 1;
  for (let e = 0; e < n && out.length >= 6; e++) {
    const ax = clip[2 * e]!, ay = clip[2 * e + 1]!;
    const bx = clip[(2 * e + 2) % clip.length]!, by = clip[(2 * e + 3) % clip.length]!;
    const side = (x: number, y: number): number => sign * ((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    const inp = out;
    out = [];
    const m = inp.length >> 1;
    for (let i = 0; i < m; i++) {
      const px = inp[2 * i]!, py = inp[2 * i + 1]!;
      const qx = inp[(2 * i + 2) % inp.length]!, qy = inp[(2 * i + 3) % inp.length]!;
      const sp = side(px, py), sq = side(qx, qy);
      if (sp >= 0) out.push(px, py);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push(px + (qx - px) * t, py + (qy - py) * t);
      }
    }
  }
  return out.length >= 6 ? out : [];
}

/** Emblem id (0..9) as shapes in unit coordinates (radius about 1, y down). */
export function emblemShapes(emblem: number): Shape[] {
  switch (((emblem % 10) + 10) % 10) {
    case 0: { // star
      const p: number[] = [];
      for (let k = 0; k < 10; k++) {
        const a = ((-90 + 36 * k) * Math.PI) / 180;
        const r = k % 2 === 0 ? 1 : 0.42;
        p.push(r * Math.cos(a), r * Math.sin(a) + 0.06);
      }
      return [[p]];
    }
    case 1: return [[[0.22, -1, -0.62, 0.14, -0.06, 0.14, -0.24, 1, 0.62, -0.17, 0.06, -0.17]]]; // bolt
    case 2: { // wave: two wavy bands
      const shapes: Shape[] = [];
      for (const yc of [-0.32, 0.36]) {
        const top: number[] = [], bot: number[] = [];
        for (let i = 0; i <= 14; i++) {
          const x = -0.95 + (1.9 * i) / 14;
          const y = yc + 0.17 * Math.sin(x * Math.PI * 1.15) - 0.13;
          top.push(x, y);
          bot.unshift(x, y + 0.27); // inserts the (x, y) pair at the front: the lower edge runs back right to left
        }
        shapes.push([top.concat(bot)]);
      }
      return shapes;
    }
    case 3: return [[circle(0, 0, 0.95, 40), circle(0, 0, 0.55, 32, true)]]; // ring
    case 4: return [[[0, -0.95, 0.93, 0.72, -0.93, 0.72]]]; // triangle
    case 5: return [[[0, -1, 0.78, -0.1, 0.3, -0.1, 0.3, 1, -0.3, 1, -0.3, -0.1, -0.78, -0.1]]]; // arrow
    case 6: return [-0.6, 0, 0.6].map((cx): Shape => [[cx - 0.2, -0.85, cx + 0.2, -0.85, cx + 0.2, 0.85, cx - 0.2, 0.85]]); // bars
    case 7: { // sun
      const shapes: Shape[] = [[circle(0, 0, 0.46, 32)]];
      for (let k = 0; k < 8; k++) {
        const a = (k * 45 * Math.PI) / 180, h = (13 * Math.PI) / 180;
        shapes.push([[0.6 * Math.cos(a - h), 0.6 * Math.sin(a - h), Math.cos(a), Math.sin(a), 0.6 * Math.cos(a + h), 0.6 * Math.sin(a + h)]]);
      }
      return shapes;
    }
    case 8: return [[0, -0.48], [-0.5, 0.4], [0.5, 0.4]].map(([x, y]): Shape => [circle(x!, y!, 0.33, 24)]); // dots
    default: return [[[-0.62, -0.36, -0.3, -0.78, 0.3, -0.78, 0.62, -0.36, 0, 0.92]]]; // gem
  }
}

function transformShapes(shapes: readonly Shape[], cx: number, cy: number, r: number): Shape[] {
  return shapes.map((s) => s.map((c): Contour => c.map((v, i) => (i % 2 === 0 ? cx + v * r : cy + v * r))));
}

function safeRgb(c: number): Rgb {
  return Number.isFinite(c) ? Math.max(0, Math.min(0xffffff, Math.round(c))) : 0;
}

/** The crest as colour layers (bottom first) in the 100 x 100 box. Pure. */
export function crestLayers(crest: Crest): CrestLayer[] {
  const primary = safeRgb(crest.primary), secondary = safeRgb(crest.secondary);
  const shapeId = Number.isFinite(crest.shape) ? Math.trunc(crest.shape) : 0;
  const layout = Number.isFinite(crest.layout) ? (((Math.trunc(crest.layout) % 4) + 4) % 4) : 0;
  const emblem = Number.isFinite(crest.emblem) ? Math.trunc(crest.emblem) : 0;
  const outer = crestOutline(shapeId);
  const field = insetConvex(outer, LOCAL_TUNING.rimWidth);
  const layers: CrestLayer[] = [
    { rgb: secondary, shapes: [[outer]] },
    { rgb: primary, shapes: [[field]] },
  ];
  const T = LOCAL_TUNING;
  let region: number[] | null = null;
  if (layout === 1) region = [50, -10, 110, -10, 110, 110, 50, 110];
  else if (layout === 2) region = [-10, 50 - T.bandHalf, 110, 50 - T.bandHalf, 110, 50 + T.bandHalf, -10, 50 + T.bandHalf];
  else if (layout === 3) {
    const h = T.bandHalf * Math.SQRT2; // band |x - y| <= h around the top-left to bottom-right diagonal
    region = [-20, -20 + h, -20 + h, -20, 120 + h, 120, 120, 120 + h];
  }
  const sm = ((shapeId % 6) + 6) % 6;
  const cy = sm === 0 || sm === 5 ? 46 : 50;
  if (region) {
    const clipped = clipConvex(region, outer); // spills over the rim (same colour): no AA seam on the field edge
    if (clipped.length >= 6) layers.push({ rgb: secondary, shapes: [[clipped]] });
    layers.push({ rgb: secondary, shapes: [[circle(50, cy, T.roundelOuter, 40)]] });
    layers.push({ rgb: primary, shapes: [[circle(50, cy, T.roundelInner, 40)]] });
    layers.push({ rgb: secondary, shapes: transformShapes(emblemShapes(emblem), 50, cy, T.roundelEmblem) });
  } else {
    layers.push({ rgb: secondary, shapes: transformShapes(emblemShapes(emblem), 50, cy, T.emblemRadius) });
  }
  return layers;
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** SVG path data of one shape (nonzero fill). */
export function shapePath(shape: Shape): string {
  let d = '';
  for (const c of shape) {
    for (let i = 0; i < c.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${fmt(c[i]!)} ${fmt(c[i + 1]!)}`;
    d += 'Z';
  }
  return d;
}

/** Standalone SVG markup of a crest, `size` CSS px square. Pure. */
export function crestSvg(crest: Crest, size = 64): string {
  let body = '';
  for (const layer of crestLayers(crest)) {
    for (const s of layer.shapes) body += `<path fill="${cssHex(layer.rgb)}" d="${shapePath(s)}"/>`;
  }
  const px = Math.max(1, Math.round(size));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}">${body}</svg>`;
}

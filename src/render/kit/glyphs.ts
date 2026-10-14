/**
 * [GFX-08] Shirt-number digits drawn from code (helper of src/render/kits.ts): a bold, rounded geometric sans built
 * from thick stroke centrelines (no font needed, identical in every browser). Units are em: a digit's outer box
 * (stroke included) is DIGIT_W wide and 1 tall, y down.
 */

import { createMask, strokeLines, type Mask } from './raster';

/** Stroke width (em). Bold: about 18% of the height. */
export const DIGIT_STROKE = 0.18;
/** Outer width of one digit (em). */
export const DIGIT_W = 0.62;
/** Gap between two digits (em). */
export const DIGIT_GAP = 0.1;

const H = DIGIT_STROKE / 2;
const X0 = H, X1 = DIGIT_W - H, Y0 = H, Y1 = 1 - H;
const CX = (X0 + X1) / 2;
const RX = (X1 - X0) / 2;

/** Points of an elliptical arc (degrees, y down: 90 = bottom, 270 = top) appended to out. */
function arc(out: number[], cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, steps: number): number[] {
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}

function closed(p: number[]): number[] {
  p.push(p[0]!, p[1]!);
  return p;
}

function d0(): number[][] {
  const p: number[] = [];
  arc(p, CX, Y0 + RX, RX, RX, 180, 360, 10);
  arc(p, CX, Y1 - RX, RX, RX, 0, 180, 10);
  return [closed(p)];
}

function d1(): number[][] {
  const sx = CX + 0.05;
  return [[sx, Y0, sx, Y1], [sx, Y0, X0 + 0.02, Y0 + 0.2]];
}

function d2(): number[][] {
  const r = RX;
  const p = arc([], CX, Y0 + r, r, r * 1.02, 195, 380, 12);
  p.push(X0, Y1, X1, Y1);
  return [p];
}

function d3(): number[][] {
  const top = arc([], CX, 0.295, RX * 0.94, 0.205, 200, 450, 14);
  const bot = arc([], CX, 0.69, RX, 0.22, 270, 520, 14);
  return [top, bot, [CX - 0.09, 0.495, CX, 0.495]];
}

function d4(): number[][] {
  const sx = X1 - 0.1;
  return [[sx, Y1, sx, Y0, X0, 0.665, X1, 0.665]];
}

function d5(): number[][] {
  const p: number[] = [X1 - 0.02, Y0, X0 + 0.04, Y0, X0 + 0.02, 0.45];
  arc(p, CX, 0.665, RX, 0.245, 222, 510, 16);
  return [p];
}

function d6(): number[][] {
  const loop = closed(arc([], CX, 0.665, RX, 0.245, 0, 350, 18));
  const stem = arc([], X1, 0.64, X1 - X0, 0.55, 180, 252, 8);
  return [loop, stem];
}

function rot180(lines: number[][]): number[][] {
  const out: number[][] = [];
  for (const l of lines) {
    const q: number[] = [];
    for (let i = 0; i < l.length; i += 2) q.push(DIGIT_W - l[i]!, 1 - l[i + 1]!);
    out.push(q);
  }
  return out;
}

function d7(): number[][] {
  return [[X0, Y0, X1, Y0, X0 + 0.12, Y1]];
}

function d8(): number[][] {
  const top = closed(arc([], CX, 0.285, RX * 0.88, 0.195, 0, 350, 16));
  const bot = closed(arc([], CX, 0.69, RX, 0.22, 0, 350, 16));
  return [top, bot];
}

/** Stroke centrelines of the digits 0..9 (em units, y down, outer box DIGIT_W x 1). */
export const DIGIT_STROKES: readonly (readonly (readonly number[])[])[] = [
  d0(), d1(), d2(), d3(), d4(), d5(), d6(), d7(), d8(), rot180(d6()),
];

/** Width in em of the number's digits laid out side by side. */
export function numberWidthEm(n: number): number {
  const digits = n >= 10 ? 2 : 1;
  return digits * DIGIT_W + (digits - 1) * DIGIT_GAP;
}


/** Centre-line polylines of the number placed with its box's top-left at (0, 0), em units. Clamped to 0..99. */
export function numberLines(n: number): (readonly number[])[] {
  const v = Math.max(0, Math.min(99, Math.round(n)));
  const digits = v >= 10 ? [Math.floor(v / 10), v % 10] : [v];
  const out: (readonly number[])[] = [];
  for (let k = 0; k < digits.length; k++) {
    const dx = k * (DIGIT_W + DIGIT_GAP);
    const src = DIGIT_STROKES[digits[k]!]!;
    for (const l of src) {
      const q: number[] = [];
      for (let i = 0; i < l.length; i += 2) q.push(l[i]! + dx, l[i + 1]!);
      out.push(q);
    }
  }
  return out;
}

/** Rendered number: fill and outline coverage masks of equal size (outline includes the fill area). */
export interface NumberMasks { fill: Mask; outline: Mask; w: number; h: number }

/**
 * Render number n with digits heightPx tall and an outline ring outlinePx wide into fresh masks sized to fit
 * (the digits' box sits outlinePx + 1 px from the mask's edges).
 */
export function renderNumber(n: number, heightPx: number, outlinePx: number): NumberMasks {
  const pad = outlinePx + 1;
  const w = Math.ceil(numberWidthEm(n) * heightPx + 2 * pad);
  const h = Math.ceil(heightPx + 2 * pad);
  const fill = createMask(w, h), outline = createMask(w, h);
  strokeLines(fill, numberLines(n), pad, pad, heightPx, (DIGIT_STROKE * heightPx) / 2, outline, outlinePx);
  return { fill, outline, w, h };
}

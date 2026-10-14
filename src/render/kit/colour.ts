/**
 * [GFX-08] Colour maths for kits (helper of src/render/kits.ts): sRGB <-> linear <-> CIE L*a*b* / LCh, CIE76 and
 * CIEDE2000 colour differences, WCAG luminance / contrast, gamut-safe Lab -> sRGB. Pure functions; render-side only
 * (Math.* transcendental functions are fine here, nothing feeds the sim). Called at match setup and from menus,
 * never per frame, so small result objects are allowed.
 */

import type { Rgb } from '../../contracts/data';

/** CIE L*a*b* (D65 white): L 0..100, a / b roughly -128..128. */
export interface Lab { L: number; a: number; b: number }
/** Cylindrical L*a*b*: lightness, chroma, hue in degrees [0, 360). */
export interface Lch { L: number; C: number; h: number }

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const LAB_EPS = 216 / 24389;
const LAB_K = 24389 / 27;
const DEG = Math.PI / 180;

export function chR(c: Rgb): number { return (c >>> 16) & 255; }
export function chG(c: Rgb): number { return (c >>> 8) & 255; }
export function chB(c: Rgb): number { return c & 255; }

/** Pack 8-bit channels (rounded, clamped) into 0xRRGGBB. */
export function packRgb(r: number, g: number, b: number): Rgb {
  const R = r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
  const G = g <= 0 ? 0 : g >= 255 ? 255 : Math.round(g);
  const B = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
  return (R << 16) | (G << 8) | B;
}

/** sRGB 8-bit channel -> linear light 0..1 (table). */
export const SRGB_TO_LINEAR: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** Linear light 0..1 -> sRGB 0..255 (unrounded). */
export function linearToSrgb(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
}

/** 4096-entry table linear (index = round(v * 4095)) -> sRGB byte; used by the mipmap filter. */
export const LINEAR_TO_SRGB8: Uint8Array = (() => {
  const t = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) t[i] = Math.round(linearToSrgb(i / 4095));
  return t;
})();

/** WCAG 2.x relative luminance 0..1. */
export function luminance(c: Rgb): number {
  return 0.2126 * SRGB_TO_LINEAR[chR(c)]! + 0.7152 * SRGB_TO_LINEAR[chG(c)]! + 0.0722 * SRGB_TO_LINEAR[chB(c)]!;
}

/** WCAG contrast ratio 1..21 (4.5 = AA text). Symmetric. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : (LAB_K * t + 16) / 116;
}

/** CIE L*a*b* of an 0xRRGGBB colour. */
export function rgbToLab(c: Rgb): Lab {
  const r = SRGB_TO_LINEAR[chR(c)]!, g = SRGB_TO_LINEAR[chG(c)]!, b = SRGB_TO_LINEAR[chB(c)]!;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** Linear RGB (unclamped) of a Lab colour, written to out[0..2]. */
function labToLinear(lab: Lab, out: number[]): void {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const fx3 = fx * fx * fx, fz3 = fz * fz * fz;
  const xr = fx3 > LAB_EPS ? fx3 : (116 * fx - 16) / LAB_K;
  const yr = lab.L > LAB_K * LAB_EPS ? fy * fy * fy : lab.L / LAB_K;
  const zr = fz3 > LAB_EPS ? fz3 : (116 * fz - 16) / LAB_K;
  const X = xr * XN, Y = yr * YN, Z = zr * ZN;
  out[0] = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  out[1] = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  out[2] = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
}

const LIN3 = [0, 0, 0];

/** True when the Lab colour maps inside the sRGB gamut (small tolerance). */
export function labInGamut(lab: Lab): boolean {
  labToLinear(lab, LIN3);
  const e = 1e-4;
  return LIN3[0]! >= -e && LIN3[0]! <= 1 + e && LIN3[1]! >= -e && LIN3[1]! <= 1 + e && LIN3[2]! >= -e && LIN3[2]! <= 1 + e;
}

/** Lab -> 0xRRGGBB with channels clamped (use lchToRgb for hue-preserving gamut mapping). */
export function labToRgb(lab: Lab): Rgb {
  labToLinear(lab, LIN3);
  return packRgb(linearToSrgb(LIN3[0]!), linearToSrgb(LIN3[1]!), linearToSrgb(LIN3[2]!));
}

export function labToLch(lab: Lab): Lch {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let h = C < 1e-9 ? 0 : Math.atan2(lab.b, lab.a) / DEG;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

export function lchToLab(l: Lch): Lab {
  return { L: l.L, a: l.C * Math.cos(l.h * DEG), b: l.C * Math.sin(l.h * DEG) };
}

/**
 * LCh -> 0xRRGGBB keeping lightness and hue: when the colour is outside sRGB the chroma is reduced (binary search)
 * until it fits. L is clamped to 0..100.
 */
export function lchToRgb(l: Lch): Rgb {
  const L = l.L < 0 ? 0 : l.L > 100 ? 100 : l.L;
  const c = { L, C: l.C < 0 ? 0 : l.C, h: l.h };
  if (labInGamut(lchToLab(c))) return labToRgb(lchToLab(c));
  let lo = 0, hi = c.C;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    c.C = mid;
    if (labInGamut(lchToLab(c))) lo = mid; else hi = mid;
  }
  c.C = lo;
  return labToRgb(lchToLab(c));
}

/** CIE76 colour difference (Euclidean in Lab). */
export function deltaE76Lab(p: Lab, q: Lab): number {
  const dl = p.L - q.L, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

const POW25_7 = 6103515625; // 25^7

/** CIEDE2000 colour difference between two Lab colours (kL = kC = kH = 1). ~1 just noticeable; black/white = 100. */
export function deltaE2000Lab(p: Lab, q: Lab): number {
  const C1 = Math.sqrt(p.a * p.a + p.b * p.b);
  const C2 = Math.sqrt(q.a * q.a + q.b * q.b);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + POW25_7)));
  const a1 = (1 + G) * p.a, a2 = (1 + G) * q.a;
  const C1p = Math.sqrt(a1 * a1 + p.b * p.b);
  const C2p = Math.sqrt(a2 * a2 + q.b * q.b);
  let h1 = a1 === 0 && p.b === 0 ? 0 : Math.atan2(p.b, a1) / DEG;
  if (h1 < 0) h1 += 360;
  let h2 = a2 === 0 && q.b === 0 ? 0 : Math.atan2(q.b, a2) / DEG;
  if (h2 < 0) h2 += 360;
  const dL = q.L - p.L;
  const dC = C2p - C1p;
  const cProd = C1p * C2p;
  let dh = 0;
  if (cProd !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cProd) * Math.sin((dh / 2) * DEG);
  const Lbp = (p.L + q.L) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (cProd === 0) hbp = h1 + h2;
  else if (Math.abs(h1 - h2) <= 180) hbp = (h1 + h2) / 2;
  else if (h1 + h2 < 360) hbp = (h1 + h2 + 360) / 2;
  else hbp = (h1 + h2 - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * DEG) + 0.24 * Math.cos(2 * hbp * DEG)
    + 0.32 * Math.cos((3 * hbp + 6) * DEG) - 0.2 * Math.cos((4 * hbp - 63) * DEG);
  const dTheta = 30 * Math.exp(-((hbp - 275) / 25) * ((hbp - 275) / 25));
  const Cbp7 = Math.pow(Cbp, 7);
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
  const l50 = (Lbp - 50) * (Lbp - 50);
  const SL = 1 + (0.015 * l50) / Math.sqrt(20 + l50);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;
  const tL = dL / SL, tC = dC / SC, tH = dH / SH;
  const s = tL * tL + tC * tC + tH * tH + RT * tC * tH;
  return Math.sqrt(s > 0 ? s : 0);
}

/** Small cache of Lab values per colour (kits use a few dozen colours). */
const LAB_CACHE_KEYS = new Int32Array(64).fill(-1);
const LAB_CACHE: Lab[] = [];
let labCacheNext = 0;

/** rgbToLab with a tiny round-robin cache. The returned object must be treated as read-only. */
export function labOf(c: Rgb): Lab {
  const key = c & 0xffffff;
  for (let i = 0; i < LAB_CACHE.length; i++) if (LAB_CACHE_KEYS[i] === key) return LAB_CACHE[i]!;
  const lab = rgbToLab(key);
  const slot = labCacheNext;
  labCacheNext = (labCacheNext + 1) % LAB_CACHE_KEYS.length;
  LAB_CACHE_KEYS[slot] = key;
  LAB_CACHE[slot] = lab;
  return lab;
}

/** CIEDE2000 between two 0xRRGGBB colours. */
export function deltaE2000(a: Rgb, b: Rgb): number {
  return deltaE2000Lab(labOf(a), labOf(b));
}

/** CIE76 between two 0xRRGGBB colours. */
export function deltaE76(a: Rgb, b: Rgb): number {
  return deltaE76Lab(labOf(a), labOf(b));
}

/** Mix two colours in sRGB: t = 0 gives a, t = 1 gives b. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return packRgb(chR(a) + (chR(b) - chR(a)) * t, chG(a) + (chG(b) - chG(a)) * t, chB(a) + (chB(b) - chB(a)) * t);
}

/** CSS hex string "#rrggbb". */
export function cssHex(c: Rgb): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
}

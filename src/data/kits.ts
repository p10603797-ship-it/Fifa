/**
 * [DAT-03] Kit designs and colours: home, away, keeper and alternate keeper kits for every club.
 * Spec: BRIEF §8 Look ("Kits: home, away and keeper kits with a colour and a pattern (plain, stripes, hoops, halves,
 * sash)"; bold kit colours, clear numbers, strong contrast with the grass), §15 (seeded generator, committed output),
 * §2 (everything invented: no real kits).
 *
 * Used by tools/gen-data.ts (DAT-01), which commits the output, so this runs at generation time only (never per
 * tick). The in-game clash check between two clubs is GFX-08's (src/render/kits.ts); the helpers here
 * (kitContrast, contrastRatio, ...) measure the designs for the generator and the tests.
 *
 * Design rules (all checked by `validateClubKits`):
 * - Home kits: club index -> a fixed design table of 20 (primary colour, pattern) pairs, each pattern used 4 times and
 *   no pair repeated, so no two of the 20 clubs share a home kit. The RNG picks the second colour, shorts, socks and
 *   number colour.
 * - Colours come from a bold named palette with no grass-like greens (`isGrassLike`). Every palette colour is "dark"
 *   (white numbers read on it) or "light" (black numbers read on it); a pattern only mixes colours of the same tone,
 *   so the number reaches WCAG contrast >= 4.5:1 on every colour it is printed over.
 * - Away kits take the opposite tone (light vs dark) and keep a set perceptual and luminance distance from home.
 * - Keeper kits use a separate bright palette (fluo yellow, fuchsia, electric aqua) whose colours sit away from every
 *   outfield colour, and stay clear of the club's own home and away kits; keeper2 (plain) differs strongly from
 *   keeper. Both come from that palette whenever the club's kits allow (fluo orange / electric violet otherwise), so
 *   every fixture has a keeper pairing that clashes with neither outfield kit nor the other keeper.
 * - A screen rejects looks that read as famous real kits (`iconicKitMatch`), e.g. red-and-black stripes.
 *
 * Deterministic: `generateKits` consumes exactly KIT_RNG_DRAWS draws per call whatever it picks (each choice scans a
 * deterministic candidate list from a drawn start, never a rejection loop that draws again), and uses only + - * /
 * and Math.round/floor/trunc/sqrt plus src/sim/core/dmath.ts dpow, so every engine produces identical data.
 *
 * Use (tools/gen-data.ts): `const { home, away, keeper, keeper2 } = generateKits(rng, clubIndex)` for club indices
 * 0..19, then `validateClubKits(...)` must return [] (it does for every seed the tests sweep).
 */
import type { Kit, Rgb } from '../contracts/data';
import { KitPattern } from '../contracts/enums';
import type { RngState } from '../contracts/state';
import { dpow } from '../sim/core/dmath';
import { rngFloat } from '../sim/core/rng';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: kit generation; generation-time only — re-run `npm run gen:data` after a change)
  /** Minimum WCAG contrast ratio of the shirt number against every shirt colour it is printed over (AA text). */
  numberMinContrast: 4.5,
  /** Minimum CIE76 deltaE between the two colours of a pattern, so the pattern is visible. */
  patternMinDeltaE: 30,
  /** Minimum CIE76 deltaE between a club's home and away shirts (pattern-blended). */
  awayMinDeltaE: 50,
  /** Minimum WCAG luminance ratio between home and away shirts (pattern-blended): light vs dark. */
  awayMinLuminanceRatio: 2.5,
  /** A light away shirt (pattern-blended) has at least this WCAG relative luminance; a dark one at most the max. */
  awayLightMinLuminance: 0.5,
  awayDarkMaxLuminance: 0.12,
  /** Minimum CIE76 deltaE between a keeper shirt and each of the club's outfield shirts (pattern-blended). */
  keeperMinDeltaE: 45,
  /** Minimum CIE76 deltaE between a keeper shirt colour and each single outfield shirt colour (shirt, pattern colour). */
  keeperColourMinDeltaE: 35,
  /** Minimum CIE76 deltaE between a club's two keeper shirts. */
  keeperPairMinDeltaE: 60,
  /** Every KEEPER_PALETTE colour is at least this CIE76 deltaE from every outfield palette colour (checked by tests). */
  keeperSafeMinDeltaE: 38,
  /** A colour closer than this CIE76 deltaE to any grass tone counts as grass-like. */
  grassMinDeltaE: 45,
  /** A colour closer than this "redmean" distance (0..1, GFX-08's clash metric) to any grass tone counts as grass-like. */
  grassMinRedmean: 0.26,
  /** HSV hue band (degrees) treated as green, for colours with at least this HSV saturation and value. */
  grassHueMin: 70,
  grassHueMax: 170,
  grassMinSaturation: 0.25,
  grassMinValue: 0.15,
  /** Grass tones to keep away from: render/kits.ts GRASS_RGB and render/pitch.ts GRASS_LIGHT / GRASS_DARK. */
  grassTones: [0x4a9440, 0x4f9a3f, 0x438a35] as readonly Rgb[],
  /** Share of the shirt area showing shirt2, per KitPattern, for the blended shirt (a PLAIN kit's shirt2 is only
   *  collar/cuff trim, ignored). */
  patternCoverage: [0, 0.5, 0.5, 0.5, 0.3] as readonly number[],
  /** Keeper tonal patterns: second colour = shirt mixed toward white (+t) or black (-t) in sRGB; first step that is
   *  visible (keeperTonalMinDeltaE) and keeps the number readable wins, else the keeper kit is plain. */
  keeperTonalLight: [0.35, -0.2, 0.55, -0.3] as readonly number[],
  keeperTonalDark: [-0.4, 0.25, -0.6] as readonly number[],
  keeperTonalMinDeltaE: 15,
  /** Number colour choice: chance of the best-contrast candidate (else the runner-up, if it also passes). */
  numberBestChance: 0.65,
} as const;

// ---------------------------------------------------------------- colour maths (pure)

/** sRGB 8-bit channel -> linear light, precomputed with deterministic dpow. */
const SRGB_TO_LINEAR: readonly number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t.push(v <= 0.04045 ? v / 12.92 : dpow((v + 0.055) / 1.055, 2.4));
  }
  return t;
})();

function chR(c: Rgb): number { return (c >>> 16) & 255; }
function chG(c: Rgb): number { return (c >>> 8) & 255; }
function chB(c: Rgb): number { return c & 255; }

function linearToSrgb8(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * dpow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function packRgb(r: number, g: number, b: number): Rgb {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/** True when `c` is an integer 0x000000..0xffffff. */
export function isRgb(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c <= 0xffffff;
}

/** WCAG 2.x relative luminance of 0xRRGGBB, 0..1. */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * SRGB_TO_LINEAR[chR(c)]! + 0.7152 * SRGB_TO_LINEAR[chG(c)]! + 0.0722 * SRGB_TO_LINEAR[chB(c)]!;
}

function ratioOfLuminances(la: number, lb: number): number {
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** WCAG contrast ratio between two colours, 1..21 (4.5 = AA body text, 3 = AA large text). Symmetric. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  return ratioOfLuminances(relativeLuminance(a), relativeLuminance(b));
}

/** CIE L*a*b* colour (D65 white): L 0..100, a/b roughly -128..128. */
export interface Lab { L: number; a: number; b: number }

const LAB_EPS = 216 / 24389;
const LAB_K = 24389 / 27;

function labF(t: number): number {
  return t > LAB_EPS ? dpow(t, 1 / 3) : (LAB_K * t + 16) / 116;
}

function labFromLinear(r: number, g: number, b: number): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE L*a*b* of 0xRRGGBB. */
export function rgbToLab(c: Rgb): Lab {
  return labFromLinear(SRGB_TO_LINEAR[chR(c)]!, SRGB_TO_LINEAR[chG(c)]!, SRGB_TO_LINEAR[chB(c)]!);
}

function labDelta(p: Lab, q: Lab): number {
  const dl = p.L - q.L, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** CIE76 colour difference (deltaE) between two colours: ~2 just noticeable, ~50 clearly different colours. */
export function deltaE(a: Rgb, b: Rgb): number {
  return labDelta(rgbToLab(a), rgbToLab(b));
}

/** "Redmean" distance normalised to 0..1 (the metric GFX-08's clash check uses). */
export function redmeanDistance(a: Rgb, b: Rgb): number {
  const r1 = chR(a), g1 = chG(a), b1 = chB(a);
  const r2 = chR(b), g2 = chG(b), b2 = chB(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 764.8339663572415;
}

/** HSV hue in degrees [0, 360), saturation and value in [0, 1]. */
export function rgbToHsv(c: Rgb): { h: number; s: number; v: number } {
  const r = chR(c) / 255, g = chG(c) / 255, b = chB(c) / 255;
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * ((g - b) / d);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

/** Mix two colours in sRGB: t = 0 gives a, t = 1 gives b. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return packRgb(
    Math.round(chR(a) + (chR(b) - chR(a)) * t),
    Math.round(chG(a) + (chG(b) - chG(a)) * t),
    Math.round(chB(a) + (chB(b) - chB(a)) * t),
  );
}

/**
 * True when a colour would blend into the pitch: close to a grass tone (CIE76 or GFX-08's redmean metric) or a
 * saturated green hue. Shirts must never be grass-like (BRIEF §8 "strong contrast with the grass").
 */
export function isGrassLike(c: Rgb): boolean {
  const tones = LOCAL_TUNING.grassTones;
  for (let i = 0; i < tones.length; i++) {
    if (deltaE(c, tones[i]!) < LOCAL_TUNING.grassMinDeltaE) return true;
    if (redmeanDistance(c, tones[i]!) < LOCAL_TUNING.grassMinRedmean) return true;
  }
  const hsv = rgbToHsv(c);
  return hsv.h >= LOCAL_TUNING.grassHueMin && hsv.h <= LOCAL_TUNING.grassHueMax
    && hsv.s >= LOCAL_TUNING.grassMinSaturation && hsv.v >= LOCAL_TUNING.grassMinValue;
}

// ---------------------------------------------------------------- palette

/** Colour family used by the real-kit screen. */
export type ColourGroup =
  | 'red' | 'blue' | 'sky' | 'purple' | 'pink' | 'orange' | 'yellow' | 'black' | 'white' | 'grey';

export interface PaletteColour {
  name: string;
  rgb: Rgb;
  group: ColourGroup;
  /** 1 = dark (white numbers read on it), 0 = light (black numbers read on it). */
  dark: 0 | 1;
  /** CIE L*a*b* of rgb (precomputed). */
  lab: Lab;
}

function pc(name: string, rgb: Rgb, group: ColourGroup, dark: 0 | 1): PaletteColour {
  return { name, rgb, group, dark, lab: rgbToLab(rgb) };
}

/** Outfield colours: shirts, pattern colours, trims, shorts and socks. No greens (BRIEF §8: contrast with the grass). */
export const OUTFIELD_PALETTE: readonly PaletteColour[] = [
  pc('red', 0xd7263d, 'red', 1),
  pc('claret', 0x7b1e3c, 'red', 1),
  pc('navy', 0x14213d, 'blue', 1),
  pc('royal blue', 0x1f4fd1, 'blue', 1),
  pc('purple', 0x5b2a86, 'purple', 1),
  pc('magenta', 0xd81b7c, 'pink', 1),
  pc('burnt orange', 0xc4501b, 'orange', 1),
  pc('black', 0x141414, 'black', 1),
  pc('sky blue', 0x5ec8f2, 'sky', 0),
  pc('yellow', 0xffd23f, 'yellow', 0),
  pc('gold', 0xf2a900, 'yellow', 0),
  pc('orange', 0xff7f11, 'orange', 0),
  pc('coral', 0xff6b5b, 'orange', 0),
  pc('pink', 0xff5fa2, 'pink', 0),
  pc('lilac', 0xb79ced, 'purple', 0),
  pc('white', 0xf6f6f2, 'white', 0),
  pc('silver', 0xc9ccd1, 'grey', 0),
  pc('cream', 0xf3e9c6, 'white', 0),
];

/**
 * Keeper colours: bright and unusual. Each sits at least keeperSafeMinDeltaE from every outfield palette colour, and
 * the three are pairwise >= keeperPairMinDeltaE apart, so when both of a club's keeper kits come from here any
 * fixture has a keeper pairing that clashes with neither outfield kit nor the other keeper.
 */
export const KEEPER_PALETTE: readonly PaletteColour[] = [
  pc('fluo yellow', 0xe4ff1a, 'yellow', 0),
  pc('fuchsia', 0xff3df2, 'pink', 0),
  pc('electric aqua', 0x22ffee, 'sky', 0),
];

/** Fallback keeper colours, used only when a club's own kits rule out the KEEPER_PALETTE colours. */
export const KEEPER_EXTRA_PALETTE: readonly PaletteColour[] = [
  pc('fluo orange', 0xff6a00, 'orange', 0),
  pc('electric violet', 0x8a2be2, 'purple', 1),
];

/** Shirt number colours (pure white and near-black first: the most readable). */
export const NUMBER_COLOURS: readonly Rgb[] = [0xffffff, 0x111111, 0x14213d, 0xffd23f, 0xf3e9c6];

const ALL_COLOURS: readonly PaletteColour[] = OUTFIELD_PALETTE.concat(KEEPER_PALETTE, KEEPER_EXTRA_PALETTE);

function byName(name: string): PaletteColour {
  for (let i = 0; i < OUTFIELD_PALETTE.length; i++) if (OUTFIELD_PALETTE[i]!.name === name) return OUTFIELD_PALETTE[i]!;
  throw new Error(`kits: unknown palette colour "${name}"`);
}

const WHITE = byName('white');
const BLACK = byName('black');
const NAVY = byName('navy');

/** One home design: primary colour and pattern. Index = club index (mod 20). Each pattern 4 times; no pair twice. */
export interface HomeDesign {
  primary: PaletteColour;
  pattern: KitPattern;
}

function hd(name: string, pattern: KitPattern): HomeDesign {
  return { primary: byName(name), pattern };
}

export const HOME_DESIGNS: readonly HomeDesign[] = [
  hd('red', KitPattern.PLAIN),
  hd('navy', KitPattern.STRIPES),
  hd('sky blue', KitPattern.HOOPS),
  hd('yellow', KitPattern.HALVES),
  hd('royal blue', KitPattern.SASH),
  hd('orange', KitPattern.PLAIN),
  hd('black', KitPattern.STRIPES),
  hd('purple', KitPattern.HOOPS),
  hd('claret', KitPattern.HALVES),
  hd('white', KitPattern.SASH),
  hd('royal blue', KitPattern.PLAIN),
  hd('pink', KitPattern.STRIPES),
  hd('red', KitPattern.HOOPS),
  hd('lilac', KitPattern.HALVES),
  hd('purple', KitPattern.SASH),
  hd('sky blue', KitPattern.PLAIN),
  hd('burnt orange', KitPattern.STRIPES),
  hd('orange', KitPattern.HOOPS),
  hd('navy', KitPattern.HALVES),
  hd('yellow', KitPattern.SASH),
];

const PATTERN_NAMES = ['plain', 'stripes', 'hoops', 'halves', 'sash'] as const;
const PATTERN_COUNT = 5;

// ---------------------------------------------------------------- kit measures (pure)

function coverage(pattern: KitPattern): number {
  return LOCAL_TUNING.patternCoverage[pattern] ?? 0;
}

/** Linear-light mean of the shirt as seen from a distance (shirt2 weighted by the pattern's coverage). */
function shirtLinear(kit: Kit): [number, number, number] {
  const w = coverage(kit.pattern);
  const a = kit.shirt, b = kit.shirt2;
  return [
    SRGB_TO_LINEAR[chR(a)]! * (1 - w) + SRGB_TO_LINEAR[chR(b)]! * w,
    SRGB_TO_LINEAR[chG(a)]! * (1 - w) + SRGB_TO_LINEAR[chG(b)]! * w,
    SRGB_TO_LINEAR[chB(a)]! * (1 - w) + SRGB_TO_LINEAR[chB(b)]! * w,
  ];
}

/** The shirt's average colour from a distance (pattern-blended in linear light), as 0xRRGGBB. */
export function kitShirtBlend(kit: Kit): Rgb {
  const l = shirtLinear(kit);
  return packRgb(linearToSrgb8(l[0]), linearToSrgb8(l[1]), linearToSrgb8(l[2]));
}

/** L*a*b* of the pattern-blended shirt. */
export function kitShirtLab(kit: Kit): Lab {
  const l = shirtLinear(kit);
  return labFromLinear(l[0], l[1], l[2]);
}

/** WCAG relative luminance of the pattern-blended shirt. */
export function kitShirtLuminance(kit: Kit): number {
  const l = shirtLinear(kit);
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}

/**
 * How different two kits look on the pitch: CIE76 deltaE between their pattern-blended shirts (the dominant area
 * seen from the broadcast camera). 0 = identical; < ~30 risks a clash; >= 50 clearly different. Symmetric.
 */
export function kitContrast(a: Kit, b: Kit): number {
  return labDelta(kitShirtLab(a), kitShirtLab(b));
}

/** WCAG luminance ratio between two kits' pattern-blended shirts (light vs dark), 1..21. Symmetric. */
export function kitLuminanceRatio(a: Kit, b: Kit): number {
  return ratioOfLuminances(kitShirtLuminance(a), kitShirtLuminance(b));
}

/** Lowest WCAG contrast of `number` against the shirt colours it is printed over (both colours of a pattern). */
function numberContrastOn(number: Rgb, shirt: Rgb, shirt2: Rgb, pattern: KitPattern): number {
  const c1 = contrastRatio(number, shirt);
  if (pattern === KitPattern.PLAIN) return c1;
  const c2 = contrastRatio(number, shirt2);
  return c1 < c2 ? c1 : c2;
}

/**
 * Readability of the shirt number: the lowest WCAG contrast ratio between the number colour and every shirt colour it
 * can sit on (shirt, plus shirt2 for patterned kits; a plain kit's shirt2 is only collar/cuff trim).
 */
export function numberContrast(kit: Kit): number {
  return numberContrastOn(kit.number, kit.shirt, kit.shirt2, kit.pattern);
}

/** Nearest named colour (outfield + keeper palettes) by CIE76. */
export function nearestPaletteColour(c: Rgb): PaletteColour {
  const lab = rgbToLab(c);
  let best = ALL_COLOURS[0]!;
  let bestD = Infinity;
  for (let i = 0; i < ALL_COLOURS.length; i++) {
    const d = labDelta(lab, ALL_COLOURS[i]!.lab);
    if (d < bestD) { bestD = d; best = ALL_COLOURS[i]!; }
  }
  return best;
}

/** Plain-language description, e.g. "navy and royal blue stripes, white shorts". */
export function describeKit(kit: Kit): string {
  const a = nearestPaletteColour(kit.shirt).name;
  const s = nearestPaletteColour(kit.shorts).name;
  if (kit.pattern === KitPattern.PLAIN) return `${a}, ${s} shorts`;
  const b = nearestPaletteColour(kit.shirt2).name;
  const p = PATTERN_NAMES[kit.pattern] ?? 'pattern';
  return a === b ? `${a} tonal ${p}, ${s} shorts` : `${a} and ${b} ${p}, ${s} shorts`;
}

// ---------------------------------------------------------------- real-kit screen

interface IconicRule {
  pattern: KitPattern;
  /** Shirt colour groups (unordered pair); for PLAIN the pair is shirt + shorts. */
  a: ColourGroup;
  b: ColourGroup;
  /** What it would resemble (kept generic: the reason, not a club list in the data). */
  why: string;
}

/**
 * Famous real-kit looks the generator must not produce (BRIEF §2: no real kits). Patterned rules compare the two
 * shirt colours; PLAIN rules compare shirt and shorts. Colours are classified by their nearest palette colour.
 */
export const ICONIC_KIT_RULES: readonly IconicRule[] = [
  { pattern: KitPattern.STRIPES, a: 'red', b: 'white', why: 'famous red-and-white striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'black', b: 'white', why: 'famous black-and-white striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'red', b: 'black', why: 'famous red-and-black striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'blue', b: 'black', why: 'famous blue-and-black striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'blue', b: 'red', why: 'famous blue-and-claret/red striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'blue', b: 'white', why: 'famous blue-and-white striped club kits' },
  { pattern: KitPattern.STRIPES, a: 'sky', b: 'white', why: 'famous sky-blue-and-white striped kits' },
  { pattern: KitPattern.STRIPES, a: 'yellow', b: 'black', why: 'famous yellow-and-black striped club kits' },
  { pattern: KitPattern.HOOPS, a: 'blue', b: 'white', why: 'famous blue-and-white hooped club kits' },
  { pattern: KitPattern.HOOPS, a: 'red', b: 'black', why: 'famous red-and-black hooped club kits' },
  { pattern: KitPattern.HOOPS, a: 'black', b: 'white', why: 'famous black-and-white hooped kits' },
  { pattern: KitPattern.HALVES, a: 'blue', b: 'white', why: 'famous blue-and-white halved club kits' },
  { pattern: KitPattern.HALVES, a: 'blue', b: 'red', why: 'famous red-and-blue halved club kits' },
  { pattern: KitPattern.SASH, a: 'red', b: 'white', why: 'famous white kits with a red sash' },
  { pattern: KitPattern.SASH, a: 'black', b: 'white', why: 'famous black/white sash kits' },
  { pattern: KitPattern.PLAIN, a: 'red', b: 'white', why: 'famous red shirt, white shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'red', b: 'red', why: 'famous all-red club kits' },
  { pattern: KitPattern.PLAIN, a: 'blue', b: 'white', why: 'famous blue shirt, white shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'sky', b: 'white', why: 'famous sky-blue shirt, white shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'white', b: 'white', why: 'famous all-white club kits' },
  { pattern: KitPattern.PLAIN, a: 'white', b: 'black', why: 'famous white shirt, black shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'white', b: 'blue', why: 'famous white shirt, navy shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'orange', b: 'white', why: 'famous orange shirt, white shorts kits' },
  { pattern: KitPattern.PLAIN, a: 'orange', b: 'orange', why: 'famous all-orange kits' },
  { pattern: KitPattern.PLAIN, a: 'yellow', b: 'blue', why: 'famous yellow shirt, blue shorts kits' },
];

function groupsMatch(x: ColourGroup, y: ColourGroup, a: ColourGroup, b: ColourGroup, ordered: boolean): boolean {
  return (x === a && y === b) || (!ordered && x === b && y === a);
}

/** The famous real-kit look this kit resembles, or null when it is clear. */
export function iconicKitMatch(kit: Kit): string | null {
  const g1 = nearestPaletteColour(kit.shirt).group;
  const plain = kit.pattern === KitPattern.PLAIN;
  const g2 = plain ? nearestPaletteColour(kit.shorts).group : nearestPaletteColour(kit.shirt2).group;
  for (let i = 0; i < ICONIC_KIT_RULES.length; i++) {
    const r = ICONIC_KIT_RULES[i]!;
    // PLAIN rules are ordered (shirt, shorts); pattern rules are an unordered colour pair.
    if (r.pattern === kit.pattern && groupsMatch(g1, g2, r.a, r.b, plain)) return r.why;
  }
  return null;
}

// ---------------------------------------------------------------- validation

/** The four kits of a club (contracts/data.ts Club.home/away/keeper/keeper2). */
export interface ClubKits {
  home: Kit;
  away: Kit;
  keeper: Kit;
  keeper2: Kit;
}

const KIT_KEYS = ['home', 'away', 'keeper', 'keeper2'] as const;

/** Every rule violation of one kit (empty when valid). */
export function validateKit(kit: Kit, label = 'kit'): string[] {
  const out: string[] = [];
  const cols: [string, number][] = [
    ['shirt', kit.shirt], ['shirt2', kit.shirt2], ['shorts', kit.shorts], ['socks', kit.socks], ['number', kit.number],
  ];
  for (const [k, v] of cols) if (!isRgb(v)) out.push(`${label}.${k} ${v} is not a 0xRRGGBB colour`);
  if (!Number.isInteger(kit.pattern) || kit.pattern < 0 || kit.pattern >= PATTERN_COUNT) {
    out.push(`${label}.pattern ${kit.pattern} is not a KitPattern`);
  }
  if (out.length > 0) return out;
  const nc = numberContrast(kit);
  if (nc < LOCAL_TUNING.numberMinContrast) out.push(`${label} number contrast ${nc.toFixed(2)} < ${LOCAL_TUNING.numberMinContrast}`);
  if (isGrassLike(kit.shirt)) out.push(`${label}.shirt is grass-like`);
  if (kit.pattern !== KitPattern.PLAIN) {
    if (isGrassLike(kit.shirt2)) out.push(`${label}.shirt2 is grass-like`);
    // Keeper tonal patterns are deliberately subtle; validateClubKits applies patternMinDeltaE to outfield kits.
    const pd = deltaE(kit.shirt, kit.shirt2);
    if (pd < LOCAL_TUNING.keeperTonalMinDeltaE) out.push(`${label} pattern colours too close (deltaE ${pd.toFixed(1)})`);
  }
  if (isGrassLike(kit.shorts)) out.push(`${label}.shorts is grass-like`);
  if (isGrassLike(kit.socks)) out.push(`${label}.socks is grass-like`);
  const ic = iconicKitMatch(kit);
  if (ic !== null) out.push(`${label} resembles ${ic}`);
  return out;
}

/** The shirt colours a club's outfield players show (shirt, plus shirt2 of a patterned kit) for home and away. */
function outfieldShirtColours(home: Kit, away: Kit): Rgb[] {
  const out: Rgb[] = [home.shirt, away.shirt];
  if (home.pattern !== KitPattern.PLAIN) out.push(home.shirt2);
  if (away.pattern !== KitPattern.PLAIN) out.push(away.shirt2);
  return out;
}

/** Keeper shirt colour far enough (CIE76) from every single outfield shirt colour of the club. */
function keeperColourClear(shirt: Rgb, outfield: readonly Rgb[]): boolean {
  for (let i = 0; i < outfield.length; i++) {
    if (deltaE(shirt, outfield[i]!) < LOCAL_TUNING.keeperColourMinDeltaE) return false;
  }
  return true;
}

/** Every rule violation of a club's kit set (empty when valid). Used by the tests and by tools/gen-data.ts. */
export function validateClubKits(kits: ClubKits): string[] {
  const out: string[] = [];
  for (const k of KIT_KEYS) out.push(...validateKit(kits[k], k));
  if (out.length > 0) return out;
  const { home, away, keeper, keeper2 } = kits;
  for (const k of ['home', 'away'] as const) {
    if (kits[k].pattern !== KitPattern.PLAIN && deltaE(kits[k].shirt, kits[k].shirt2) < LOCAL_TUNING.patternMinDeltaE) {
      out.push(`${k} pattern colours too close`);
    }
  }
  const ha = kitContrast(home, away);
  if (ha < LOCAL_TUNING.awayMinDeltaE) out.push(`home/away deltaE ${ha.toFixed(1)} < ${LOCAL_TUNING.awayMinDeltaE}`);
  const hl = kitLuminanceRatio(home, away);
  if (hl < LOCAL_TUNING.awayMinLuminanceRatio) out.push(`home/away luminance ratio ${hl.toFixed(2)} < ${LOCAL_TUNING.awayMinLuminanceRatio}`);
  const lightAway = kitShirtLuminance(away) > kitShirtLuminance(home);
  if (!awayToneOk(away, lightAway ? 1 : 0)) out.push(`away shirt is a mid tone (luminance ${kitShirtLuminance(away).toFixed(3)})`);
  for (const k of ['keeper', 'keeper2'] as const) {
    for (const o of ['home', 'away'] as const) {
      const d = kitContrast(kits[k], kits[o]);
      if (d < LOCAL_TUNING.keeperMinDeltaE) out.push(`${k}/${o} deltaE ${d.toFixed(1)} < ${LOCAL_TUNING.keeperMinDeltaE}`);
    }
  }
  const outfield = outfieldShirtColours(home, away);
  for (const k of ['keeper', 'keeper2'] as const) {
    if (!keeperColourClear(kits[k].shirt, outfield)) out.push(`${k} shirt colour too close to an outfield shirt colour`);
  }
  const kk = kitContrast(keeper, keeper2);
  if (kk < LOCAL_TUNING.keeperPairMinDeltaE) out.push(`keeper/keeper2 deltaE ${kk.toFixed(1)} < ${LOCAL_TUNING.keeperPairMinDeltaE}`);
  return out;
}

/** Thresholds the generator guarantees (read-only view of the LOCAL_TUNING block, for tests and tools). */
export const KIT_RULES = LOCAL_TUNING;

// ---------------------------------------------------------------- generator

/** Either the sim's sfc32 state (src/sim/core/rng.ts) or a function returning uniform floats in [0, 1) or uint32s
 *  (the same convention as playerGen's GenRng, so tools/gen-data.ts can pass one RNG to both). */
export type KitRng = RngState | (() => number);

/** Draws consumed by one generateKits call, whatever it picks (15 used, one spare so a later rule needs no reshuffle). */
export const KIT_RNG_DRAWS = 16;

const INV_2_32 = 1 / 4294967296;

function drawUniforms(rng: KitRng): number[] {
  const u: number[] = [];
  for (let i = 0; i < KIT_RNG_DRAWS; i++) {
    if (typeof rng !== 'function') { u.push(rngFloat(rng)); continue; }
    const v = rng();
    if (v >= 0 && v < 1) u.push(v);
    else if (Number.isInteger(v) && v >= 1 && v < 4294967296) u.push(v * INV_2_32);
    else throw new Error(`kits: rng returned ${v}; expected a float in [0, 1) or a uint32`);
  }
  return u;
}

/** Draw slots (indices into the uniforms of one call). */
const U_HOME_SECOND = 0, U_HOME_SHORTS = 1, U_HOME_SOCKS = 2, U_HOME_NUMBER = 3;
const U_AWAY_PRIMARY = 4, U_AWAY_SECOND = 5, U_AWAY_SHORTS = 6, U_AWAY_SOCKS = 7, U_AWAY_NUMBER = 8;
const U_GK1 = 9, U_GK2 = 10, U_GK1_SHORTS = 11, U_GK2_SHORTS = 12, U_GK1_NUMBER = 13, U_GK2_NUMBER = 14;

/** Index in [0, n) from a uniform. */
function slot(u: number, n: number): number {
  const i = Math.floor(u * n);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** First non-null `build(item)`, scanning items cyclically from the uniform's slot (deterministic, no extra draws). */
function findCyclic<T, R>(items: readonly T[], u: number, build: (item: T) => R | null): R | null {
  const n = items.length;
  if (n === 0) return null;
  const start = slot(u, n);
  for (let k = 0; k < n; k++) {
    const r = build(items[(start + k) % n]!);
    if (r !== null) return r;
  }
  return null;
}

/** First item accepted by `ok`, scanning cyclically from the uniform's slot. */
function pickCyclic<T>(items: readonly T[], u: number, ok: (item: T) => boolean): T | null {
  return findCyclic(items, u, (it) => (ok(it) ? it : null));
}

/** Number colour: the best- or second-best-contrast candidate that passes the minimum; null if none passes. */
function pickNumber(shirt: Rgb, shirt2: Rgb, pattern: KitPattern, u: number): Rgb | null {
  let best = -1, bestC = 0, second = -1, secondC = 0;
  for (let i = 0; i < NUMBER_COLOURS.length; i++) {
    const c = numberContrastOn(NUMBER_COLOURS[i]!, shirt, shirt2, pattern);
    if (c < LOCAL_TUNING.numberMinContrast) continue;
    if (c > bestC) { second = best; secondC = bestC; best = i; bestC = c; }
    else if (c > secondC) { second = i; secondC = c; }
  }
  if (best < 0) return null;
  return NUMBER_COLOURS[second >= 0 && u >= LOCAL_TUNING.numberBestChance ? second : best]!;
}

function canNumber(shirt: Rgb, shirt2: Rgb, pattern: KitPattern): boolean {
  return pickNumber(shirt, shirt2, pattern, 0) !== null;
}

function makeKit(shirt: Rgb, shirt2: Rgb, pattern: KitPattern, shorts: Rgb, socks: Rgb, number: Rgb): Kit {
  return { shirt, shirt2, pattern, shorts, socks, number };
}

/** Second shirt colour: a same-tone colour for patterns (keeps the number readable), any contrasting trim for plain. */
function secondCandidates(primary: PaletteColour, pattern: KitPattern): PaletteColour[] {
  const out: PaletteColour[] = [];
  for (let i = 0; i < OUTFIELD_PALETTE.length; i++) {
    const c = OUTFIELD_PALETTE[i]!;
    if (c === primary) continue;
    if (pattern !== KitPattern.PLAIN && c.dark !== primary.dark) continue;
    if (labDelta(c.lab, primary.lab) < LOCAL_TUNING.patternMinDeltaE) continue;
    out.push(c);
  }
  return out;
}

/** Builds an outfield kit around a fixed primary and pattern. `shirtOk` filters the (primary, second) pair. */
function buildOutfield(
  primary: PaletteColour, pattern: KitPattern, u: readonly number[],
  uSecond: number, uShorts: number, uSocks: number, uNumber: number,
  shirtOk: (probe: Kit) => boolean,
): Kit | null {
  const probe = makeKit(primary.rgb, primary.rgb, pattern, primary.rgb, primary.rgb, 0);
  const second = pickCyclic(secondCandidates(primary, pattern), u[uSecond]!, (c) => {
    probe.shirt2 = c.rgb;
    if (pattern !== KitPattern.PLAIN && iconicKitMatch(probe) !== null) return false;
    if (!canNumber(primary.rgb, c.rgb, pattern)) return false;
    return shirtOk(probe);
  });
  if (second === null) return null;
  probe.shirt2 = second.rgb;
  // Shorts: the primary, the second colour, or a neutral; never a real-kit look.
  const shortsOptions: PaletteColour[] = [primary, second, WHITE, BLACK, NAVY];
  const shorts = pickCyclic(shortsOptions, u[uShorts]!, (c) => {
    probe.shorts = c.rgb;
    return iconicKitMatch(probe) === null;
  });
  if (shorts === null) return null;
  probe.shorts = shorts.rgb;
  const socksOptions: PaletteColour[] = [primary, shorts, second];
  const socks = socksOptions[slot(u[uSocks]!, socksOptions.length)]!;
  const number = pickNumber(primary.rgb, second.rgb, pattern, u[uNumber]!);
  if (number === null) return null;
  return makeKit(primary.rgb, second.rgb, pattern, shorts.rgb, socks.rgb, number);
}

function homeKit(design: HomeDesign, u: readonly number[]): Kit {
  const kit = buildOutfield(design.primary, design.pattern, u, U_HOME_SECOND, U_HOME_SHORTS, U_HOME_SOCKS, U_HOME_NUMBER,
    (probe) => !isGrassLike(probe.shirt2) || design.pattern === KitPattern.PLAIN);
  if (kit === null) throw new Error(`kits: no valid home kit for ${design.primary.name} ${PATTERN_NAMES[design.pattern]}`);
  return kit;
}

/** Away pattern: plain on even club indices, otherwise cycling the four patterns, skipping the home pattern. */
export function awayPattern(clubIndex: number, homePattern: KitPattern): KitPattern {
  if (clubIndex % 2 === 0) return KitPattern.PLAIN;
  let p = 1 + ((clubIndex >> 1) % 4);
  if (p === homePattern) p = 1 + ((p + 1) % 4);
  return p as KitPattern;
}

/** An away shirt is clearly light (dark home) or clearly dark (light home), not a mid tone. */
function awayToneOk(away: Kit, homeDark: 0 | 1): boolean {
  const l = kitShirtLuminance(away);
  return homeDark ? l >= LOCAL_TUNING.awayLightMinLuminance : l <= LOCAL_TUNING.awayDarkMaxLuminance;
}

function awayKit(home: Kit, homeDark: 0 | 1, pattern: KitPattern, u: readonly number[]): Kit {
  const homeLab = kitShirtLab(home);
  const homeLum = kitShirtLuminance(home);
  const farFromHome = (k: Kit): boolean => labDelta(kitShirtLab(k), homeLab) >= LOCAL_TUNING.awayMinDeltaE
    && ratioOfLuminances(kitShirtLuminance(k), homeLum) >= LOCAL_TUNING.awayMinLuminanceRatio
    && awayToneOk(k, homeDark);
  const primaries: PaletteColour[] = [];
  for (let i = 0; i < OUTFIELD_PALETTE.length; i++) {
    const c = OUTFIELD_PALETTE[i]!;
    if (c.dark === homeDark) continue;
    const probe = makeKit(c.rgb, c.rgb, KitPattern.PLAIN, c.rgb, c.rgb, 0);
    if (farFromHome(probe)) primaries.push(c);
  }
  const built = findCyclic(primaries, u[U_AWAY_PRIMARY]!, (p) =>
    buildOutfield(p, pattern, u, U_AWAY_SECOND, U_AWAY_SHORTS, U_AWAY_SOCKS, U_AWAY_NUMBER,
      (probe) => (pattern === KitPattern.PLAIN || !isGrassLike(probe.shirt2)) && farFromHome(probe)));
  if (built !== null) return built;
  // Fallback (not reached with the shipped palette; the tests sweep many seeds): the same search with a plain kit.
  const plain = findCyclic(primaries, u[U_AWAY_PRIMARY]!, (p) =>
    buildOutfield(p, KitPattern.PLAIN, u, U_AWAY_SECOND, U_AWAY_SHORTS, U_AWAY_SOCKS, U_AWAY_NUMBER, farFromHome));
  if (plain === null) throw new Error('kits: no away kit contrasts with the home kit');
  return plain;
}

/** Keeper pattern: plain on most clubs, a tonal pattern on every third club (cycling stripes, hoops, sash, halves). */
export function keeperPattern(clubIndex: number): KitPattern {
  if (clubIndex % 3 !== 2) return KitPattern.PLAIN;
  const cycle = [KitPattern.STRIPES, KitPattern.HOOPS, KitPattern.SASH, KitPattern.HALVES];
  return cycle[((clubIndex - 2) / 3) % 4]!;
}

/** A keeper kit in colour `c`: tonal pattern if requested and readable, else plain with a neutral trim. */
function keeperKit(c: PaletteColour, pattern: KitPattern, uShorts: number, uNumber: number): Kit | null {
  let p = KitPattern.PLAIN;
  let second = c.dark ? WHITE.rgb : BLACK.rgb; // plain: collar/cuff trim
  if (pattern !== KitPattern.PLAIN) {
    const steps = c.dark ? LOCAL_TUNING.keeperTonalDark : LOCAL_TUNING.keeperTonalLight;
    for (let i = 0; i < steps.length; i++) {
      const t = steps[i]!;
      const tone = t >= 0 ? mixRgb(c.rgb, 0xffffff, t) : mixRgb(c.rgb, 0x000000, -t);
      if (deltaE(c.rgb, tone) >= LOCAL_TUNING.keeperTonalMinDeltaE && canNumber(c.rgb, tone, pattern)) {
        p = pattern;
        second = tone;
        break;
      }
    }
  }
  const number = pickNumber(c.rgb, second, p, uNumber);
  if (number === null) return null;
  const kit = makeKit(c.rgb, second, p, c.rgb, c.rgb, number);
  const shortsOptions: Rgb[] = [c.rgb, BLACK.rgb, NAVY.rgb, WHITE.rgb];
  const shorts = pickCyclic(shortsOptions, uShorts, (s) => {
    kit.shorts = s;
    return iconicKitMatch(kit) === null;
  });
  if (shorts === null) return null;
  kit.shorts = shorts;
  return kit;
}

/**
 * Generate a club's kits: home (from the HOME_DESIGNS slot of `clubIndex`), away (opposite tone), keeper and keeper2.
 * Consumes exactly KIT_RNG_DRAWS draws. Club indices >= 20 reuse the design table (mod 20); a non-finite index acts as 0.
 */
export function generateKits(rng: KitRng, clubIndex: number): ClubKits {
  const u = drawUniforms(rng);
  const n = HOME_DESIGNS.length;
  const idxRaw = Number.isFinite(clubIndex) ? Math.trunc(clubIndex) : 0;
  const idx = ((idxRaw % n) + n) % n;
  const design = HOME_DESIGNS[idx]!;

  const home = homeKit(design, u);
  const away = awayKit(home, design.primary.dark, awayPattern(idx, design.pattern), u);

  const homeLab = kitShirtLab(home);
  const awayLab = kitShirtLab(away);
  const outfield = outfieldShirtColours(home, away);
  const fits = (k: Kit | null): k is Kit => k !== null && !isGrassLike(k.shirt) && iconicKitMatch(k) === null
    && labDelta(kitShirtLab(k), homeLab) >= LOCAL_TUNING.keeperMinDeltaE
    && labDelta(kitShirtLab(k), awayLab) >= LOCAL_TUNING.keeperMinDeltaE
    && keeperColourClear(k.shirt, outfield);

  // Keeper: the KEEPER_PALETTE first (the RNG picks the starting colour), the extra colours only if none fits.
  const build1 = (c: PaletteColour): Kit | null => {
    const k = keeperKit(c, keeperPattern(idx), u[U_GK1_SHORTS]!, u[U_GK1_NUMBER]!);
    return fits(k) ? k : null;
  };
  const keeper = findCyclic(KEEPER_PALETTE, u[U_GK1]!, build1) ?? findCyclic(KEEPER_EXTRA_PALETTE, u[U_GK1]!, build1);
  if (keeper === null) throw new Error(`kits: no keeper colour fits club ${idx}`);
  const keeperLab = kitShirtLab(keeper);

  // keeper2: plain, strongly different from keeper (keeper-vs-keeper clashes), still away from both outfield kits.
  // Same preference order; black or white only if nothing else fits (not reached with the shipped palette).
  const build2 = (c: PaletteColour): Kit | null => {
    const k = keeperKit(c, KitPattern.PLAIN, u[U_GK2_SHORTS]!, u[U_GK2_NUMBER]!);
    return fits(k) && labDelta(kitShirtLab(k), keeperLab) >= LOCAL_TUNING.keeperPairMinDeltaE ? k : null;
  };
  const keeper2 = findCyclic(KEEPER_PALETTE, u[U_GK2]!, build2) ?? findCyclic(KEEPER_EXTRA_PALETTE, u[U_GK2]!, build2)
    ?? findCyclic([BLACK, WHITE], 0, build2);
  if (keeper2 === null) throw new Error(`kits: no keeper2 colour fits club ${idx}`);

  return { home, away, keeper, keeper2 };
}

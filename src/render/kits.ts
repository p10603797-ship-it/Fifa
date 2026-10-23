/**
 * [GFX-08] Kits, shirt numbers, crests, the kit texture atlas and the automatic clash check (BRIEF section 8 "Look":
 * "An automatic clash check picks kits by colour distance, including against the grass and the other keeper";
 * bold kit colours, clear numbers, strong contrast with the grass; section 13: one generated texture atlas;
 * section 12: high-contrast kits). Not a RenderModule: a library used by players/model.ts (GFX-07), menus (UIX-03)
 * and the HUD.
 *
 * CLASH CHECK (resolveKits / resolveMatchKits) - perceptual distances in CIE L*a*b*: colourDistance = CIEDE2000 / 100
 * (black vs white = 1). A shirt is a two-colour mix (pattern coverage of shirt2: stripes / hoops / halves 50 %,
 * sash 30 %, plain 0 %); two shirts clash when the earth mover's distance between their mixes is below
 * T.shirtClash, or when one colour covers at least half of both (e.g. plain red vs red-and-gold halves). Order:
 *  1. home keeps its requested kit unless it blends into the grass and its other kit does not;
 *  2. away: requested kit, else its other kit, else a built-in fallback kit, else the best-scoring candidate;
 *  3. shorts: when the shorts clash (and only then) the away side borrows its other kit's shorts if they are clear;
 *  4. high contrast (Settings > Accessibility): shirts go plain, chroma is boosted and the two shirts are pushed at
 *     least T.hcLightnessGap apart in L*, numbers become pure white / near-black with a heavy outline;
 *  5. keepers: every pair from [keeper, keeper2, fallbacks] per side is tried in preference order (both first
 *     choice, then the away keeper changes, then the home keeper, then both); a pair must be clear of both outfield
 *     shirts, the grass and each other.
 * MatchKits holds the resolved Kit copies (never the shared club data) plus what changed and the final distances.
 *
 * ATLAS (createKitAtlas / drawKitAtlas / createKitSet): one fixed 1024 x 1024 RGBA atlas, rasterised in code
 * (src/render/kit/raster.ts; identical in every browser, unit-tested in Node, no fonts), with a 6-level mip chain
 * filtered per tile in linear light (tiles aligned to 32 px: no colour bleeding between kits at a distance).
 * Variants v = team * 2 + (keeper ? 1 : 0). Layout (pixels, top-down):
 *   y 0..767     shirts: 128 x 64 tiles, 8 per row, 3 rows per variant: tile 0 plain, tiles 1..23 the team's squad
 *                numbers baked in (big on the back, small on the chest, crest badge on the left chest).
 *   y 768..831   64 x 64 cells: shorts v0..3 (x 0..255), socks v0..3 (x 256..511), crest home / away (x 512, 576),
 *                opaque white (x 640; for parts that only use the per-instance colour).
 *   y 832..1023  64 x 32 number cells (transparent background, outlined number): 24 per variant, cell 0 blank.
 * SHIRT UV CONVENTION (cylindrical, matches three.js CylinderGeometry for a player facing +x, right hand +z):
 *   u 0 = right side seam, 0.25 = chest centre, 0.5 = left side, 0.75 = back centre; v 0 = waist, v 1 = neck.
 *   A box torso maps its front face to u 0.125..0.375 and its back face to u 0.625..0.875.
 * PER-INSTANCE UV: applyKitUv(material) makes the map lookup uv' = aKitUv.xy + uv * aKitUv.zw, where aKitUv is an
 * InstancedBufferAttribute (KIT_UV_ATTRIBUTE, itemSize 4; createKitUvAttribute). Fill it with atlas.shirtUv(...)
 * etc. (no allocation; safe per frame, e.g. after a substitution).
 *
 * KitSet usage sketch (a renderer whose torsos sample the full atlas; the shipped players/model.ts uses the glyph
 * atlas below instead):
 *   const kitSet = createKitSet();                        // once (allocates the atlas and the DataTexture)
 *   torsoMat.map = kitSet.texture; applyKitUv(torsoMat);  // torsoGeo.setAttribute(KIT_UV_ATTRIBUTE, createKitUvAttribute(22))
 *   setMatch: const kits = kitSet.setMatch(state, clubs, ctx.settings.accessibility.highContrastKits);
 *             per slot: kitSet.atlas.shirtUv(team, isKeeper, state.attrs[i].shirt, uvAttr.array, i * 4)
 *             colours: kits.outfield[t].shorts / socks, sleeveColour(kit, left)
 *   onSettings: if (kitSet.setHighContrast(s.accessibility.highContrastKits)) re-apply colours.
 *   warmUp: renderer.initTexture(kitSet.texture).   dispose: kitSet.dispose().
 * NUMBER GLYPHS for shaders that print the number themselves (players/model.ts as built by GFX-07 draws the kit
 * pattern procedurally and takes a NumberAtlas): createKitNumberAtlas() -> { texture, glyphRect } with the same
 * generated digits, premultiplied white fill / black outline, 1.2 : 1 cells, manual mips;
 * players/model.ts uses it as its default number atlas and wears resolveMatchKits(state, clubs, highContrast).
 * Menus / HUD: crestDataUrl(club) (SVG data URL, cached), crestSvg(crest, size); kitDataUrl(kit, number) / kitSvg
 * (shirt, shorts, socks preview); resolveKits(home, away, slots) and shirtsClash(a, b) for the kit picker
 * (MatchKits.slot vs .requested says when the clash check changed a kit).
 */

import { DataTexture, InstancedBufferAttribute, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Material } from 'three';
import type { Club, Crest, Kit, Rgb } from '../contracts/data';
import { KitPattern, KitSlot } from '../contracts/enums';
import type { ReadonlySimState } from '../contracts/state';
import { contrastRatio, cssHex, deltaE2000, labOf, labToLch, lchToRgb, luminance, type Lch } from './kit/colour';
import { crestLayers, crestSvg as crestSvgMarkup } from './kit/crest';
import { numberLines, numberWidthEm, renderNumber, type NumberMasks } from './kit/glyphs';
import {
  blendFn, blendMask, buildMips, copyRect, createImg, createMask, createMipLevels, fillRect, fillShapes, squareWaveCoverage,
  strokeLines, type Img, type MipLevel,
} from './kit/raster';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: render only, kit clash check, high contrast, atlas look)
  /** Two outfield shirts clash below this earth mover's distance between their colour mixes (CIEDE2000 / 100). */
  shirtClash: 0.25,
  /** Two colours count as "the same colour" below this distance (shared-colour rule and shorts). */
  sameColour: 0.12,
  /** Shirts sharing one colour over more than this share of both shirts clash, whatever the overall distance
   *  (50/50 patterns sharing a colour clash: plain red vs red-and-gold halves). */
  sharedShareClash: 0.45,
  /** A shirt blends into the grass below this mean distance to the nearest grass tone. */
  grassClash: 0.28,
  /** Shorts clash below this distance (triggers borrowing the other kit's shorts). */
  shortsClash: 0.15,
  /** A keeper shirt clashes with an outfield shirt / the other keeper below these distances. */
  keeperClash: 0.22,
  keeperPairClash: 0.22,
  /** Share of the shirt showing shirt2, per KitPattern (PLAIN, STRIPES, HOOPS, HALVES, SASH). */
  patternCoverage: [0, 0.5, 0.5, 0.5, 0.3] as readonly number[],
  /** Minimum WCAG contrast of the number against the shirt colours it sits on (else white / near-black is used). */
  numberMinContrast: 3,
  /** High contrast: chroma multiplier and addition (colours with chroma below hcNeutralChroma stay neutral). */
  hcChromaMul: 1.3,
  hcChromaAdd: 8,
  hcNeutralChroma: 8,
  /** High contrast: minimum L* gap between the two outfield shirts, and the L* range they are kept in. */
  hcLightnessGap: 40,
  hcLightMin: 12,
  hcLightMax: 96,
  /** Atlas: shirt stripes around the body, hoops down the shirt, sash half width (px of a 128 x 64 tile). */
  stripesAround: 6,
  hoopsDown: 4,
  sashHalfWidth: 8,
  /** Atlas: collar band height and V-neck depth (px). */
  collarPx: 3,
  vNeckPx: 6,
  /** Atlas: back number height and outline, chest number height and outline, number-cell digits (px). */
  backNumberPx: 30,
  backOutlinePx: 2,
  chestNumberPx: 13,
  chestOutlinePx: 1.2,
  cellNumberPx: 24,
  cellOutlinePx: 2,
  /** High contrast: heavier outlines (px). */
  hcBackOutlinePx: 3,
  hcCellOutlinePx: 3,
  /** Atlas: chest badge size (px). */
  badgePx: 10,
} as const;
const T = LOCAL_TUNING;

/** Mid grass colour used for the grass clash test. */
export const GRASS_RGB: Rgb = 0x4a9440;
/** Grass tones the kits are checked against: GRASS_RGB and the pitch mowing stripes (render/pitch.ts GRASS_LIGHT / GRASS_DARK). */
export const GRASS_TONES: readonly Rgb[] = [GRASS_RGB, 0x4f9a3f, 0x438a35];
/** Normalised colour distance below which two outfield shirts clash (see LOCAL_TUNING.shirtClash). */
export const CLASH_THRESHOLD = T.shirtClash;

// ---------------------------------------------------------------- colour distance

/** Perceptual distance between two 0xRRGGBB colours: CIEDE2000 / 100 (0 identical, black vs white 1). Pure. */
export function colourDistance(a: Rgb, b: Rgb): number {
  return deltaE2000(a & 0xffffff, b & 0xffffff) / 100;
}

/** Share of the shirt showing shirt2 for a pattern (0 for PLAIN, whose shirt2 is only trim). */
export function patternCoverage(pattern: KitPattern): number {
  return T.patternCoverage[pattern] ?? 0;
}

/**
 * Earth mover's distance between two two-colour mixes (colours a1/a2 with shares 1-wa / wa, b1/b2 with 1-wb / wb),
 * ground distance = colourDistance. Pure.
 */
export function mixDistance(a1: Rgb, a2: Rgb, wa: number, b1: Rgb, b2: Rgb, wb: number): number {
  const A1 = 1 - wa, A2 = wa, B1 = 1 - wb;
  const c11 = colourDistance(a1, b1), c12 = colourDistance(a1, b2), c21 = colourDistance(a2, b1), c22 = colourDistance(a2, b2);
  const lo = Math.max(0, B1 - A2), hi = Math.min(A1, B1);
  const cost = (t: number): number => t * c11 + (A1 - t) * c12 + (B1 - t) * c21 + (A2 - B1 + t) * c22;
  return Math.min(cost(lo), cost(hi));
}

/** Share of colour that two mixes have in common (colours closer than T.sameColour), 0..1. Pure. */
export function sharedShare(a1: Rgb, a2: Rgb, wa: number, b1: Rgb, b2: Rgb, wb: number): number {
  const A = [1 - wa, wa], B = [1 - wb, wb];
  const ca = [a1, a2], cb = [b1, b2];
  let s = 0;
  const usedA = [0, 0], usedB = [0, 0];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      if (A[i]! <= 0 || B[j]! <= 0) continue;
      if (colourDistance(ca[i]!, cb[j]!) >= T.sameColour) continue;
      const m = Math.min(A[i]! - usedA[i]!, B[j]! - usedB[j]!);
      if (m <= 0) continue;
      usedA[i]! += m; usedB[j]! += m; s += m;
    }
  }
  return s > 1 ? 1 : s;
}

/** Distance between two shirts (pattern-aware earth mover's distance). Pure. */
export function shirtDistance(a: Kit, b: Kit): number {
  return mixDistance(a.shirt, a.shirt2, patternCoverage(a.pattern), b.shirt, b.shirt2, patternCoverage(b.pattern));
}

/** Clash score of two shirts: >= 1 clear, < 1 clash (min of the distance and shared-colour margins). Pure. */
export function shirtScore(a: Kit, b: Kit, threshold: number = T.shirtClash): number {
  const wa = patternCoverage(a.pattern), wb = patternCoverage(b.pattern);
  const d = mixDistance(a.shirt, a.shirt2, wa, b.shirt, b.shirt2, wb) / threshold;
  const shared = sharedShare(a.shirt, a.shirt2, wa, b.shirt, b.shirt2, wb);
  const s = (1 - shared) / (1 - T.sharedShareClash);
  return d < s ? d : s;
}

/** True when two kits' shirts clash (too close overall, or sharing a dominant colour). Pure. */
export function shirtsClash(a: Kit, b: Kit): boolean {
  return shirtScore(a, b) < 1;
}

/** Mean distance of a shirt to the nearest grass tone (0..1). Pure. */
export function grassDistance(k: Kit): number {
  const w = patternCoverage(k.pattern);
  let best = Infinity;
  for (let i = 0; i < GRASS_TONES.length; i++) {
    const g = GRASS_TONES[i]!;
    const d = (1 - w) * colourDistance(k.shirt, g) + w * colourDistance(k.shirt2, g);
    if (d < best) best = d;
  }
  return best;
}

/** Grass score: >= 1 clear of the grass. Pure. */
export function grassScore(k: Kit): number {
  const w = patternCoverage(k.pattern);
  let shared = 0;
  for (let i = 0; i < GRASS_TONES.length; i++) {
    const g = GRASS_TONES[i]!;
    shared = Math.max(shared, sharedShare(k.shirt, k.shirt2, w, g, g, 0));
  }
  const s = (1 - shared) / (1 - T.sharedShareClash);
  const d = grassDistance(k) / T.grassClash;
  return d < s ? d : s;
}

// ---------------------------------------------------------------- kits

export function clubById(clubs: readonly Club[], id: number): Club | null {
  const direct = clubs[id];
  if (direct && direct.id === id) return direct;
  for (let i = 0; i < clubs.length; i++) if (clubs[i]!.id === id) return clubs[i]!;
  return clubs[id] ?? null;
}

function kit(shirt: Rgb, shirt2: Rgb, shorts: Rgb, socks: Rgb, number: Rgb): Kit {
  return { shirt, shirt2, pattern: KitPattern.PLAIN, shorts, socks, number };
}

/** Built-in outfield kits used when both of a club's kits clash (or no club data). Plain, bold, mutually distinct. */
export const FALLBACK_OUTFIELD: readonly Kit[] = [
  kit(0xf6f6f2, 0x14213d, 0x14213d, 0xf6f6f2, 0x14213d), // white
  kit(0x141414, 0xf6f6f2, 0x141414, 0x141414, 0xffffff), // black
  kit(0xd7263d, 0xffffff, 0xffffff, 0xd7263d, 0xffffff), // red
  kit(0x1f4fd1, 0xffffff, 0xffffff, 0x1f4fd1, 0xffffff), // royal blue
  kit(0xffd23f, 0x14213d, 0x14213d, 0xffd23f, 0x14213d), // yellow
  kit(0x5b2a86, 0xffffff, 0x5b2a86, 0x5b2a86, 0xffffff), // purple
  kit(0xff7f11, 0x141414, 0x141414, 0xff7f11, 0x141414), // orange
  kit(0x5ec8f2, 0x14213d, 0x14213d, 0x5ec8f2, 0x14213d), // sky blue
];

/** Built-in keeper kits (bright, unusual) used when both of a club's keeper kits clash. */
export const FALLBACK_KEEPER: readonly Kit[] = [
  kit(0xe4ff1a, 0x141414, 0x141414, 0xe4ff1a, 0x111111), // fluo yellow
  kit(0x22ffee, 0x141414, 0x141414, 0x22ffee, 0x111111), // electric aqua
  kit(0xff3df2, 0x141414, 0x141414, 0xff3df2, 0x111111), // fuchsia
  kit(0xff6a00, 0x141414, 0x141414, 0xff6a00, 0x111111), // fluo orange
  kit(0x8a2be2, 0xffffff, 0x141414, 0x8a2be2, 0xffffff), // electric violet
  kit(0x141414, 0x8a8f98, 0x141414, 0x141414, 0xffffff), // black
  kit(0x8a8f98, 0x141414, 0x141414, 0x8a8f98, 0x111111), // grey
];

function safeColour(c: unknown, fallback: Rgb): Rgb {
  return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(0xffffff, Math.round(c))) : fallback;
}

/** Number colour readable on every shirt colour it sits on: the kit's own if contrast allows, else white / near-black. */
function readableNumber(number: Rgb, shirt: Rgb, shirt2: Rgb, pattern: KitPattern): Rgb {
  const worst = (c: Rgb): number => (pattern === KitPattern.PLAIN ? contrastRatio(c, shirt) : Math.min(contrastRatio(c, shirt), contrastRatio(c, shirt2)));
  if (worst(number) >= T.numberMinContrast) return number;
  return worst(0xffffff) >= worst(0x111111) ? 0xffffff : 0x111111;
}

/** A sanitised copy of a kit (finite 24-bit colours, valid pattern, readable number). Pure. */
export function sanitizeKit(k: Kit | null | undefined, fallback: Kit = FALLBACK_OUTFIELD[0]!): Kit {
  const src = k ?? fallback;
  const shirt = safeColour(src.shirt, fallback.shirt);
  const shirt2 = safeColour(src.shirt2, fallback.shirt2);
  const p = src.pattern;
  const pattern: KitPattern = p === KitPattern.STRIPES || p === KitPattern.HOOPS || p === KitPattern.HALVES || p === KitPattern.SASH ? p : KitPattern.PLAIN;
  return {
    shirt, shirt2, pattern,
    shorts: safeColour(src.shorts, fallback.shorts),
    socks: safeColour(src.socks, fallback.socks),
    number: readableNumber(safeColour(src.number, 0xffffff), shirt, shirt2, pattern),
  };
}

/** Sleeve colour: shirt colour, except halves (the left sleeve takes the left half's shirt2). Pure. */
export function sleeveColour(k: Kit, left: boolean): Rgb {
  return k.pattern === KitPattern.HALVES && left ? k.shirt2 : k.shirt;
}

export interface KitReport {
  /** Outfield shirt clash score (>= 1 clear) and distance. */
  shirtScore: number;
  shirtDistance: number;
  /** Shorts distance. */
  shortsDistance: number;
  /** Grass score per outfield kit (>= 1 clear). */
  grassScore: [number, number];
  /** Worst keeper score per team against both outfield shirts and the grass (>= 1 clear). */
  keeperScore: [number, number];
  /** Keeper vs keeper score (>= 1 clear). */
  keeperPairScore: number;
  /** Every check passed. */
  clean: boolean;
}

export interface MatchKits {
  /** Outfield kit per team (0 home, 1 away) after the clash check. */
  outfield: [Kit, Kit];
  /** Keeper kit per team after the clash check. */
  keeper: [Kit, Kit];
  /** Kit slot actually used per team (may differ from the requested one after a clash). */
  slot: [KitSlot, KitSlot];
  /** Kit slot requested per team (sanitised: HOME or AWAY). */
  requested: [KitSlot, KitSlot];
  /** The outfield kit is a built-in fallback (both club kits clashed, or no club). */
  fallback: [boolean, boolean];
  /** The outfield shorts (and socks) were borrowed from the club's other kit to avoid a shorts clash. */
  shortsSwapped: [boolean, boolean];
  /** Keeper kit used: 0 keeper, 1 keeper2, 2+ built-in fallback. */
  keeperChoice: [number, number];
  /** High-contrast kits applied. */
  highContrast: boolean;
  /** Final distances (for the kit picker, diagnostics and tests). */
  report: KitReport;
}

function sanitizeSlot(slot: number, def: KitSlot): KitSlot {
  return slot === KitSlot.HOME ? KitSlot.HOME : slot === KitSlot.AWAY ? KitSlot.AWAY : def;
}

function clubKit(c: Club | null, slot: KitSlot): Kit | null {
  if (!c) return null;
  return slot === KitSlot.AWAY ? (c.away ?? null) : (c.home ?? null);
}

// ---------------------------------------------------------------- high contrast

function boost(c: Rgb): Lch {
  const l = labToLch(labOf(c));
  if (l.C >= T.hcNeutralChroma) l.C = l.C * T.hcChromaMul + T.hcChromaAdd;
  return l;
}

function boostRgb(c: Rgb): Rgb {
  return lchToRgb(boost(c));
}

function hcNumber(shirt: Rgb): Rgb {
  return contrastRatio(0xffffff, shirt) >= contrastRatio(0x0a0a0a, shirt) ? 0xffffff : 0x0a0a0a;
}

/** High-contrast versions of the two outfield kits: plain shirts, boosted chroma, L* pushed apart. Pure. */
export function highContrastOutfield(home: Kit, away: Kit): [Kit, Kit] {
  const lh = boost(home.shirt), la = boost(away.shirt);
  const homeLighter = lh.L > la.L || (lh.L === la.L && luminance(home.shirt) >= luminance(away.shirt));
  const up = homeLighter ? lh : la, down = homeLighter ? la : lh;
  if (up.L - down.L < T.hcLightnessGap) {
    const mid = (up.L + down.L) / 2;
    up.L = mid + T.hcLightnessGap / 2;
    down.L = mid - T.hcLightnessGap / 2;
    if (up.L > T.hcLightMax) { down.L -= up.L - T.hcLightMax; up.L = T.hcLightMax; }
    if (down.L < T.hcLightMin) { up.L += T.hcLightMin - down.L; down.L = T.hcLightMin; }
  }
  const make = (k: Kit, l: Lch): Kit => {
    const shirt = lchToRgb(l);
    return {
      shirt, shirt2: boostRgb(k.shirt2), pattern: KitPattern.PLAIN, shorts: boostRgb(k.shorts), socks: boostRgb(k.socks),
      number: hcNumber(shirt),
    };
  };
  // A shirt pushed toward the grass lightness keeps moving away from the other shirt until it is clear of the grass.
  const upKit = homeLighter ? home : away, downKit = homeLighter ? away : home;
  for (let i = 0; i < 16 && down.L > T.hcLightMin && grassScore(make(downKit, down)) < 1; i++) down.L = Math.max(T.hcLightMin, down.L - 4);
  for (let i = 0; i < 16 && up.L < T.hcLightMax && grassScore(make(upKit, up)) < 1; i++) up.L = Math.min(T.hcLightMax, up.L + 4);
  return [make(home, lh), make(away, la)];
}

/** High-contrast keeper kit: plain, boosted chroma, pure white / near-black number. Pure. */
export function highContrastKeeper(k: Kit): Kit {
  const shirt = boostRgb(k.shirt);
  return { shirt, shirt2: boostRgb(k.shirt2), pattern: KitPattern.PLAIN, shorts: boostRgb(k.shorts), socks: boostRgb(k.socks), number: hcNumber(shirt) };
}

// ---------------------------------------------------------------- resolution

function keeperScoreVs(k: Kit, home: Kit, away: Kit): number {
  return Math.min(shirtScore(k, home, T.keeperClash), shirtScore(k, away, T.keeperClash), grassScore(k));
}

/**
 * The clash check for two clubs and requested kit slots (menus call this directly; resolveMatchKits wraps it).
 * Missing clubs use the built-in kits. Pure; allocates the result.
 */
export function resolveKits(homeClub: Club | null, awayClub: Club | null, homeSlot: number, awaySlot: number, highContrast = false): MatchKits {
  const reqH = sanitizeSlot(homeSlot, KitSlot.HOME);
  const reqA = sanitizeSlot(awaySlot, KitSlot.AWAY);
  const other = (s: KitSlot): KitSlot => (s === KitSlot.AWAY ? KitSlot.HOME : KitSlot.AWAY);

  // 1. Home: requested kit unless it blends into the grass and the other one does not.
  const hReqKit = clubKit(homeClub, reqH), hOthKit = clubKit(homeClub, other(reqH));
  let home: Kit, homeSlotUsed = reqH, homeFallback = false;
  if (hReqKit) {
    home = sanitizeKit(hReqKit);
    if (grassScore(home) < 1 && hOthKit) {
      const alt = sanitizeKit(hOthKit);
      if (grassScore(alt) > grassScore(home)) { home = alt; homeSlotUsed = other(reqH); }
    }
    if (grassScore(home) < 1) {
      for (let i = 0; i < FALLBACK_OUTFIELD.length; i++) {
        if (grassScore(FALLBACK_OUTFIELD[i]!) >= 1) { home = sanitizeKit(FALLBACK_OUTFIELD[i]!); homeFallback = true; homeSlotUsed = reqH; break; }
      }
    }
  } else {
    home = sanitizeKit(FALLBACK_OUTFIELD[2]!); // no club data: red
    homeFallback = true;
  }

  // 2. Away: requested, other, fallbacks; first clear candidate wins, else the best score.
  const awayCands: { k: Kit; slot: KitSlot; fb: boolean }[] = [];
  const aReq = clubKit(awayClub, reqA), aOth = clubKit(awayClub, other(reqA));
  if (aReq) awayCands.push({ k: sanitizeKit(aReq), slot: reqA, fb: false });
  if (aOth) awayCands.push({ k: sanitizeKit(aOth), slot: other(reqA), fb: false });
  for (let i = 0; i < FALLBACK_OUTFIELD.length; i++) awayCands.push({ k: sanitizeKit(FALLBACK_OUTFIELD[i]!), slot: reqA, fb: true });
  if (!aReq) { // no club: start from the blue fallback so a default match reads red vs blue
    const blue = awayCands.findIndex((c) => c.k.shirt === 0x1f4fd1);
    if (blue > 0) awayCands.unshift(awayCands.splice(blue, 1)[0]!);
  }
  let best = awayCands[0]!, bestScore = -Infinity;
  for (let i = 0; i < awayCands.length; i++) {
    const c = awayCands[i]!;
    const s = Math.min(shirtScore(c.k, home), grassScore(c.k));
    if (s >= 1) { best = c; break; }
    if (s > bestScore) { best = c; bestScore = s; }
  }
  let away = best.k;
  const awaySlotUsed = best.slot;
  const awayFallback = best.fb;

  // 3. Shorts: the away side borrows its other kit's shorts (and socks) when its own clash with the home shorts.
  let shortsSwapped = false;
  if (!awayFallback && colourDistance(away.shorts, home.shorts) < T.shortsClash) {
    const otherKit = clubKit(awayClub, other(awaySlotUsed));
    if (otherKit) {
      const o = sanitizeKit(otherKit);
      if (colourDistance(o.shorts, home.shorts) >= T.shortsClash && colourDistance(o.shorts, away.shorts) >= T.sameColour) {
        away = { ...away, shorts: o.shorts, socks: o.socks };
        shortsSwapped = true;
      }
    }
  }

  // 4. High contrast.
  if (highContrast) [home, away] = highContrastOutfield(home, away);

  // 5. Keepers: try pairs in preference order.
  const kc = (c: Club | null): Kit[] => {
    const list: Kit[] = [];
    list.push(sanitizeKit(c?.keeper ?? FALLBACK_KEEPER[0]!, FALLBACK_KEEPER[0]!));
    list.push(sanitizeKit(c?.keeper2 ?? FALLBACK_KEEPER[1]!, FALLBACK_KEEPER[1]!));
    for (let i = 0; i < FALLBACK_KEEPER.length; i++) list.push(sanitizeKit(FALLBACK_KEEPER[i]!));
    return highContrast ? list.map(highContrastKeeper) : list;
  };
  const hk = kc(homeClub), ak = kc(awayClub);
  const hs = hk.map((k) => keeperScoreVs(k, home, away));
  const as = ak.map((k) => keeperScoreVs(k, home, away));
  let bi = 0, bj = 0, bScore = -Infinity, found = false;
  // Preference: rank sum, then the away keeper changes before the home keeper.
  for (let sum = 0; sum <= hk.length + ak.length - 2 && !found; sum++) {
    for (let i = 0; i <= sum && !found; i++) {
      const j = sum - i;
      if (i >= hk.length || j >= ak.length) continue;
      const s = Math.min(hs[i]!, as[j]!, shirtScore(hk[i]!, ak[j]!, T.keeperPairClash));
      if (s >= 1) { bi = i; bj = j; bScore = s; found = true; }
      else if (s > bScore) { bi = i; bj = j; bScore = s; }
    }
  }
  const homeKeeper = hk[bi]!, awayKeeper = ak[bj]!;

  const report: KitReport = {
    shirtScore: shirtScore(home, away),
    shirtDistance: shirtDistance(home, away),
    shortsDistance: colourDistance(home.shorts, away.shorts),
    grassScore: [grassScore(home), grassScore(away)],
    keeperScore: [keeperScoreVs(homeKeeper, home, away), keeperScoreVs(awayKeeper, home, away)],
    keeperPairScore: shirtScore(homeKeeper, awayKeeper, T.keeperPairClash),
    clean: false,
  };
  report.clean = report.shirtScore >= 1 && report.grassScore[0] >= 1 && report.grassScore[1] >= 1
    && report.keeperScore[0] >= 1 && report.keeperScore[1] >= 1 && report.keeperPairScore >= 1;
  return {
    outfield: [home, away],
    keeper: [homeKeeper, awayKeeper],
    slot: [homeSlotUsed, awaySlotUsed],
    requested: [reqH, reqA],
    fallback: [homeFallback, awayFallback],
    shortsSwapped: [false, shortsSwapped],
    keeperChoice: [bi, bj],
    highContrast,
    report,
  };
}

/** Resolve the kits for a match: requested slots from state.teams[t].kit, then the clash check. */
export function resolveMatchKits(state: ReadonlySimState, clubs: readonly Club[], highContrast = false): MatchKits {
  const homeClub = clubById(clubs, state.teams[0]!.clubIdx);
  const awayClub = clubById(clubs, state.teams[1]!.clubIdx);
  return resolveKits(homeClub, awayClub, state.teams[0]!.kit, state.teams[1]!.kit, highContrast);
}

// ---------------------------------------------------------------- shirt numbers

/** Most numbered shirt tiles per team in the atlas (more numbers fall back to the plain tile). */
export const MAX_ATLAS_NUMBERS = 23;

/**
 * Shirt numbers per team for the atlas: the match squads (state.squads), the players on the pitch (attrs.shirt) and,
 * when the state has no squads, the club squads. Valid numbers 1..99, unique, in squad order, at most
 * MAX_ATLAS_NUMBERS each.
 */
export function matchShirtNumbers(state: ReadonlySimState, clubs: readonly Club[]): [number[], number[]] {
  const out: [number[], number[]] = [[], []];
  const add = (t: number, n: unknown): void => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99) return;
    const list = out[t]!;
    if (list.length < MAX_ATLAS_NUMBERS && list.indexOf(n) < 0) list.push(n);
  };
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < state.players.length; i++) {
      if (state.players[i]!.team === t && state.players[i]!.active === 1) add(t, state.attrs[i]?.shirt);
    }
    const squad = state.squads?.[t];
    if (squad && squad.length > 0) for (let i = 0; i < squad.length; i++) add(t, squad[i]?.shirt);
    else {
      const club = clubById(clubs, state.teams[t]!.clubIdx);
      if (club?.squad) for (let i = 0; i < club.squad.length; i++) add(t, club.squad[i]?.shirt);
    }
  }
  return out;
}

// ---------------------------------------------------------------- atlas

export const KIT_ATLAS_W = 1024;
export const KIT_ATLAS_H = 1024;
/** Mip levels uploaded (1024 -> 32): every tile keeps at least 2 x 1 texels and never mixes with a neighbour. */
export const KIT_ATLAS_LEVELS = 6;
export const SHIRT_TILE_W = 128;
export const SHIRT_TILE_H = 64;
const SHIRTS_PER_ROW = KIT_ATLAS_W / SHIRT_TILE_W;
const SHIRT_ROWS_PER_VARIANT = 3;
const TILES_PER_VARIANT = SHIRTS_PER_ROW * SHIRT_ROWS_PER_VARIANT; // 24
const MISC_Y = 4 * SHIRT_ROWS_PER_VARIANT * SHIRT_TILE_H; // 768
const CELL = 64;
const NUM_CELL_W = 64, NUM_CELL_H = 32;
const NUM_Y = MISC_Y + CELL; // 832
const NUM_PER_ROW = KIT_ATLAS_W / NUM_CELL_W; // 16
const WHITE_X = 640;

/** Pixel rectangles (top-down) of the atlas regions. Pure. */
export function shirtTileRect(variant: number, tile: number): { x: number; y: number; w: number; h: number } {
  const row = variant * SHIRT_ROWS_PER_VARIANT + Math.floor(tile / SHIRTS_PER_ROW);
  return { x: (tile % SHIRTS_PER_ROW) * SHIRT_TILE_W, y: row * SHIRT_TILE_H, w: SHIRT_TILE_W, h: SHIRT_TILE_H };
}
export function numberCellRect(variant: number, cell: number): { x: number; y: number; w: number; h: number } {
  const c = variant * TILES_PER_VARIANT + cell;
  return { x: (c % NUM_PER_ROW) * NUM_CELL_W, y: NUM_Y + Math.floor(c / NUM_PER_ROW) * NUM_CELL_H, w: NUM_CELL_W, h: NUM_CELL_H };
}

export interface KitAtlas {
  readonly width: number;
  readonly height: number;
  /** Working image (top-down rows). */
  readonly image: Img;
  /** Mip levels in GL order (row 0 = v 0); levels[0] is the full atlas. Upload with createKitTexture. */
  readonly mips: MipLevel[];
  /** Kits last drawn (null before the first draw). */
  kits: MatchKits | null;
  /** Numbers baked per team (index = tile - 1). */
  numbers: [number[], number[]];
  /** Increments on every draw. */
  version: number;
  /** Internal lookup [variant * 100 + shirt number] -> shirt tile / number cell (0 = plain / blank). */
  readonly tileOf: Int16Array;
  /** Shirt tile UV rect (u0, v0, du, dv) for a player into out[o..o+3]: numbered tile, or the plain one. No allocation. */
  shirtUv(team: number, keeper: boolean | number, shirtNumber: number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  /** Plain shirt tile (no number). */
  plainShirtUv(team: number, keeper: boolean | number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  shortsUv(team: number, keeper: boolean | number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  socksUv(team: number, keeper: boolean | number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  /** Transparent number cell (number plate quads); unknown numbers give the blank cell. */
  numberUv(team: number, keeper: boolean | number, shirtNumber: number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  crestUv(team: number, out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
  /** Opaque white cell: parts that only use the per-instance colour while sharing the atlas material. */
  whiteUv(out: ArrayLike<number> & { [i: number]: number }, o?: number): void;
}

type UvOut = ArrayLike<number> & { [i: number]: number };

function writeRect(out: UvOut, o: number, x: number, y: number, w: number, h: number, insetU: number, insetV: number): void {
  out[o] = (x + insetU) / KIT_ATLAS_W;
  out[o + 1] = 1 - (y + h - insetV) / KIT_ATLAS_H;
  out[o + 2] = (w - 2 * insetU) / KIT_ATLAS_W;
  out[o + 3] = (h - 2 * insetV) / KIT_ATLAS_H;
}

/** Allocate an empty atlas (fixed size; redraw with drawKitAtlas). */
export function createKitAtlas(): KitAtlas {
  const tileOf = new Int16Array(4 * 100); // [variant * 100 + number] -> tile (0 = plain)
  const variant = (team: number, keeper: boolean | number): number => (team === 1 ? 2 : 0) + (keeper ? 1 : 0);
  const atlas: KitAtlas = {
    width: KIT_ATLAS_W,
    height: KIT_ATLAS_H,
    image: createImg(KIT_ATLAS_W, KIT_ATLAS_H),
    mips: createMipLevels(KIT_ATLAS_W, KIT_ATLAS_H, KIT_ATLAS_LEVELS),
    kits: null,
    numbers: [[], []],
    version: 0,
    tileOf,
    shirtUv(team, keeper, n, out, o = 0) {
      const v = variant(team, keeper);
      const tile = n >= 1 && n <= 99 ? tileOf[v * 100 + (n | 0)]! : 0;
      const row = v * SHIRT_ROWS_PER_VARIANT + ((tile / SHIRTS_PER_ROW) | 0);
      writeRect(out, o, (tile % SHIRTS_PER_ROW) * SHIRT_TILE_W, row * SHIRT_TILE_H, SHIRT_TILE_W, SHIRT_TILE_H, 0, 0.5);
    },
    plainShirtUv(team, keeper, out, o = 0) {
      const v = variant(team, keeper);
      writeRect(out, o, 0, v * SHIRT_ROWS_PER_VARIANT * SHIRT_TILE_H, SHIRT_TILE_W, SHIRT_TILE_H, 0, 0.5);
    },
    shortsUv(team, keeper, out, o = 0) {
      writeRect(out, o, variant(team, keeper) * CELL, MISC_Y, CELL, CELL, 0.5, 0.5);
    },
    socksUv(team, keeper, out, o = 0) {
      writeRect(out, o, 4 * CELL + variant(team, keeper) * CELL, MISC_Y, CELL, CELL, 0.5, 0.5);
    },
    numberUv(team, keeper, n, out, o = 0) {
      const v = variant(team, keeper);
      const cell = n >= 1 && n <= 99 ? tileOf[v * 100 + (n | 0)]! : 0;
      const c = v * TILES_PER_VARIANT + cell;
      writeRect(out, o, (c % NUM_PER_ROW) * NUM_CELL_W, NUM_Y + ((c / NUM_PER_ROW) | 0) * NUM_CELL_H, NUM_CELL_W, NUM_CELL_H, 0.5, 0.5);
    },
    crestUv(team, out, o = 0) {
      writeRect(out, o, 8 * CELL + (team === 1 ? CELL : 0), MISC_Y, CELL, CELL, 0.5, 0.5);
    },
    whiteUv(out, o = 0) {
      writeRect(out, o, WHITE_X, MISC_Y, CELL, CELL, 4, 4);
    },
  };
  return atlas;
}

function trimColour(base: Rgb, k: Kit): Rgb {
  if (colourDistance(k.shirt2, base) >= T.shortsClash) return k.shirt2;
  if (colourDistance(k.shirt, base) >= T.shortsClash) return k.shirt;
  return k.number;
}

function outlineFor(number: Rgb): Rgb {
  return luminance(number) > 0.35 ? 0x111111 : 0xf6f6f2;
}

/** Draw the plain (number-free) shirt tile of a kit at (x, y). */
function drawShirtBase(img: Img, x: number, y: number, k: Kit, crest: Crest | null): void {
  const W = SHIRT_TILE_W, H = SHIRT_TILE_H;
  fillRect(img, x, y, W, H, k.shirt);
  const c2 = k.shirt2;
  switch (k.pattern) {
    case KitPattern.STRIPES: {
      const P = W / T.stripesAround;
      blendFn(img, x, y, W, H, c2, (px) => squareWaveCoverage(px, px + 1, P, W / 4 - 0.75 * P, 0.5));
      break;
    }
    case KitPattern.HOOPS: {
      const P = H / T.hoopsDown;
      blendFn(img, x, y, W, H, c2, (_px, py) => squareWaveCoverage(py, py + 1, P, P / 2, 0.5));
      break;
    }
    case KitPattern.HALVES:
      blendFn(img, x, y, W, H, c2, (px) => squareWaveCoverage(px, px + 1, W, W / 4, 0.5));
      break;
    case KitPattern.SASH: {
      const hw = T.sashHalfWidth;
      blendFn(img, x, y, W, H, c2, (px, py) => {
        const cx = px + 0.5, cy = py + 0.5;
        const d = cx < W / 2 ? Math.abs(cx + cy - W / 2) / Math.SQRT2 : Math.abs(cx - cy - W / 2) / Math.SQRT2;
        return hw - d + 0.5;
      });
      break;
    }
    default: break;
  }
  // Collar band and a V-neck at the chest centre in the trim colour.
  const trim = colourDistance(c2, k.shirt) >= T.sameColour ? c2 : k.number;
  fillRect(img, x, y, W, T.collarPx, trim);
  const v = createMask(W, H);
  const cx = W / 4;
  strokeLines(v, [[cx - T.vNeckPx, 0, cx, T.vNeckPx, cx + T.vNeckPx, 0]], 0, 0, 1, 1.2);
  blendMask(img, x, y, v, trim);
  // Crest badge on the left chest (viewer's right on the front panel).
  if (crest) {
    const s = T.badgePx;
    const bx = Math.round(W * 0.34), by = 10;
    for (const layer of crestLayers(crest)) {
      const m = createMask(s, s);
      fillShapes(m, layer.shapes, 0, 0, s / 100, s / 100);
      blendMask(img, x + bx, y + by, m, layer.rgb);
    }
  }
}

function blendNumber(img: Img, cx: number, cy: number, m: NumberMasks, fill: Rgb): void {
  const x = Math.round(cx - m.w / 2), y = Math.round(cy - m.h / 2);
  blendMask(img, x, y, m.outline, outlineFor(fill));
  blendMask(img, x, y, m.fill, fill);
}

/**
 * Redraw the atlas for a match's resolved kits, shirt numbers per team and crests (null = no crest). Rebuilds the
 * mip chain; upload with updateKitTexture. Runs at match setup (tens of ms); allocates small temporaries.
 */
export function drawKitAtlas(atlas: KitAtlas, kits: MatchKits, numbers: readonly (readonly number[])[], crests: readonly (Crest | null)[] = [null, null]): void {
  const img = atlas.image;
  img.data.fill(0);
  const tileOf = atlas.tileOf;
  tileOf.fill(0);
  const hc = kits.highContrast;
  const nums: [number[], number[]] = [[], []];
  for (let t = 0; t < 2; t++) {
    const src = numbers[t] ?? [];
    for (let i = 0; i < src.length && nums[t]!.length < MAX_ATLAS_NUMBERS; i++) {
      const n = src[i]!;
      if (Number.isInteger(n) && n >= 1 && n <= 99 && nums[t]!.indexOf(n) < 0) nums[t]!.push(n);
    }
  }
  // Number masks per team at three sizes (shared by both kit variants).
  const backOutline = hc ? T.hcBackOutlinePx : T.backOutlinePx;
  const cellOutline = hc ? T.hcCellOutlinePx : T.cellOutlinePx;
  for (let t = 0; t < 2; t++) {
    const crest = crests[t] ?? null;
    const list = nums[t]!;
    const back = list.map((n) => renderNumber(n, T.backNumberPx, backOutline));
    const chest = list.map((n) => renderNumber(n, T.chestNumberPx, T.chestOutlinePx));
    const cell = list.map((n) => renderNumber(n, T.cellNumberPx, cellOutline));
    for (let kp = 0; kp < 2; kp++) {
      const v = t * 2 + kp;
      const k = kp === 1 ? kits.keeper[t]! : kits.outfield[t]!;
      const base = shirtTileRect(v, 0);
      drawShirtBase(img, base.x, base.y, k, crest);
      for (let tile = 1; tile < TILES_PER_VARIANT; tile++) {
        const r = shirtTileRect(v, tile);
        copyRect(img, base.x, base.y, SHIRT_TILE_W, SHIRT_TILE_H, img, r.x, r.y);
        const idx = tile - 1;
        if (idx >= list.length) continue;
        blendNumber(img, r.x + SHIRT_TILE_W * 0.75, r.y + 30, back[idx]!, k.number);
        blendNumber(img, r.x + SHIRT_TILE_W * 0.25, r.y + 33, chest[idx]!, k.number);
        tileOf[v * 100 + list[idx]!] = tile;
        const c = numberCellRect(v, tile);
        blendNumber(img, c.x + NUM_CELL_W / 2, c.y + NUM_CELL_H / 2, cell[idx]!, k.number);
      }
      // Shorts: side stripes in the trim colour (u 0 = right side seam, u 0.5 = left side).
      const sx = v * CELL;
      fillRect(img, sx, MISC_Y, CELL, CELL, k.shorts);
      const st = trimColour(k.shorts, k);
      fillRect(img, sx, MISC_Y, 2, CELL, st);
      fillRect(img, sx + CELL - 2, MISC_Y, 2, CELL, st);
      fillRect(img, sx + CELL / 2 - 2, MISC_Y, 4, CELL, st);
      // Socks: turnover band near the top.
      const kx = 4 * CELL + v * CELL;
      fillRect(img, kx, MISC_Y, CELL, CELL, k.socks);
      fillRect(img, kx, MISC_Y + 4, CELL, 8, trimColour(k.socks, k));
    }
    if (crest) {
      const cx = 8 * CELL + t * CELL;
      for (const layer of crestLayers(crest)) {
        const m = createMask(CELL, CELL);
        fillShapes(m, layer.shapes, 2, 2, (CELL - 4) / 100, (CELL - 4) / 100);
        blendMask(img, cx, MISC_Y, m, layer.rgb);
      }
    }
  }
  fillRect(img, WHITE_X, MISC_Y, CELL, CELL, 0xffffff);
  buildMips(img, atlas.mips);
  atlas.kits = kits;
  atlas.numbers = nums;
  atlas.version++;
}

// ---------------------------------------------------------------- three.js glue

/** Name of the per-instance UV rect attribute (vec4: u0, v0, du, dv) read by applyKitUv materials. */
export const KIT_UV_ATTRIBUTE = 'aKitUv';

/** A DataTexture over the atlas mip chain (sRGB, trilinear, manual mips). Re-upload with updateKitTexture. */
export function createKitTexture(atlas: KitAtlas, anisotropy = 4): DataTexture {
  const l0 = atlas.mips[0]!;
  const tex = new DataTexture(l0.data, l0.width, l0.height, RGBAFormat, UnsignedByteType);
  tex.name = 'kit-atlas';
  tex.mipmaps = atlas.mips;
  tex.generateMipmaps = false;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Mark the texture for re-upload after drawKitAtlas (same size: the GPU storage is reused). */
export function updateKitTexture(tex: DataTexture): void {
  tex.needsUpdate = true;
}

/**
 * Make a built-in material (Lambert / Basic / ...) sample its map through the per-instance rect attribute
 * KIT_UV_ATTRIBUTE: uv' = aKitUv.xy + uv * aKitUv.zw. The geometry must carry that attribute (createKitUvAttribute).
 */
export function applyKitUv(material: Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 ${KIT_UV_ATTRIBUTE};`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = ${KIT_UV_ATTRIBUTE}.xy + vMapUv * ${KIT_UV_ATTRIBUTE}.zw;\n#endif`);
  };
  material.customProgramCacheKey = () => 'dk-kit-uv';
  material.needsUpdate = true;
}

/** Per-instance UV rect attribute for `count` instances (initialised to the full atlas). */
export function createKitUvAttribute(count: number): InstancedBufferAttribute {
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { a[i * 4 + 2] = 1; a[i * 4 + 3] = 1; }
  return new InstancedBufferAttribute(a, 4);
}

// ---------------------------------------------------------------- number glyph atlas (players/model.ts NumberAtlas)

/** Glyph grid of the number atlas: cell n (1..99) at column n % 10, row floor(n / 10) (cell 0 unused). */
export const NUMBER_ATLAS_COLS = 10;
/** Glyph cell size (px): 1.2 : 1, the aspect of the players' back number panel (players/parts.ts NUMBER_PANEL). */
export const NUMBER_GLYPH_W = 96;
export const NUMBER_GLYPH_H = 80;
/** Mip levels (960 x 800 -> 60 x 50): cells are multiples of 16 px, so no level mixes two glyphs. */
export const NUMBER_ATLAS_LEVELS = 5;
const GLYPH_DIGITS = 0.72; // digit height / cell height
const GLYPH_OUTLINE = 0.08; // outline width / digit height

/**
 * Shirt-number glyphs 1..99 for shaders that print the number themselves (players/model.ts NumberAtlas: pass it to
 * PlayerModelModule.setNumberAtlas). Linear premultiplied coverage: RGB = white fill coverage, A = fill + outline
 * coverage (outline black), i.e. colour = shirt * (1 - a) + outlineColour * (a - r) + numberColour * r.
 */
export interface KitNumberAtlas {
  readonly texture: DataTexture;
  readonly width: number;
  readonly height: number;
  readonly mips: MipLevel[];
  /** UV rect (u0, v0, u1, v1; v up, v0 = bottom edge) of number n into out[o..o+3]; false when n is not 1..99. */
  glyphRect(n: number, out: Float32Array | number[], o: number): boolean;
}

/** Draw the 99 glyph cells (premultiplied white fill / black outline coverage) into a top-down image. */
export function drawNumberGlyphs(img: Img): void {
  img.data.fill(0);
  const hPx = Math.round(NUMBER_GLYPH_H * GLYPH_DIGITS);
  const oPx = hPx * GLYPH_OUTLINE;
  const d = img.data;
  for (let n = 1; n <= 99; n++) {
    const m = renderNumber(n, hPx, oPx);
    const cx = (n % NUMBER_ATLAS_COLS) * NUMBER_GLYPH_W + NUMBER_GLYPH_W / 2;
    const cy = Math.floor(n / NUMBER_ATLAS_COLS) * NUMBER_GLYPH_H + NUMBER_GLYPH_H / 2;
    const x0 = Math.round(cx - m.w / 2), y0 = Math.round(cy - m.h / 2);
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        const a = m.outline.a[j * m.w + i]!;
        if (a <= 0) continue;
        const f = m.fill.a[j * m.w + i]!;
        const o = ((y0 + j) * img.w + x0 + i) * 4;
        const fv = Math.round(f * 255);
        d[o] = fv; d[o + 1] = fv; d[o + 2] = fv;
        d[o + 3] = Math.max(fv, Math.round(a * 255));
      }
    }
  }
}

/** Build the number glyph atlas and its texture (once per renderer; about 1 MB with mips). */
export function createKitNumberAtlas(anisotropy = 4): KitNumberAtlas {
  const w = NUMBER_ATLAS_COLS * NUMBER_GLYPH_W, h = NUMBER_ATLAS_COLS * NUMBER_GLYPH_H;
  const img = createImg(w, h);
  drawNumberGlyphs(img);
  const mips = createMipLevels(w, h, NUMBER_ATLAS_LEVELS);
  buildMips(img, mips, true);
  const l0 = mips[0]!;
  const texture = new DataTexture(l0.data, w, h, RGBAFormat, UnsignedByteType);
  texture.name = 'kit-numbers';
  texture.mipmaps = mips;
  texture.generateMipmaps = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.premultiplyAlpha = false; // the data is already premultiplied
  texture.flipY = false;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return {
    texture, width: w, height: h, mips,
    glyphRect(n, out, o) {
      if (!(n >= 1 && n <= 99) || n !== Math.floor(n)) return false;
      const col = n % NUMBER_ATLAS_COLS, row = Math.floor(n / NUMBER_ATLAS_COLS);
      out[o] = col / NUMBER_ATLAS_COLS;
      out[o + 1] = 1 - (row + 1) / NUMBER_ATLAS_COLS;
      out[o + 2] = (col + 1) / NUMBER_ATLAS_COLS;
      out[o + 3] = 1 - row / NUMBER_ATLAS_COLS;
      return true;
    },
  };
}

// ---------------------------------------------------------------- crests for menus / HUD

const crestUrlCache = new Map<string, string>();

function crestKey(c: Crest): string {
  return `${c.shape}|${c.primary}|${c.secondary}|${c.emblem}|${c.layout}`;
}

/** SVG markup of a crest (`size` CSS px square). */
export function crestSvg(crest: Crest, size = 64): string {
  return crestSvgMarkup(crest, size);
}

/** Crest of a club as an SVG data URL for <img src> (menus, HUD). Cached per crest design. */
export function crestDataUrl(club: Pick<Club, 'crest'>): string {
  const key = crestKey(club.crest);
  let url = crestUrlCache.get(key);
  if (url === undefined) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(crestSvgMarkup(club.crest, 128))}`;
    if (crestUrlCache.size > 256) crestUrlCache.clear();
    crestUrlCache.set(key, url);
  }
  return url;
}

// ---------------------------------------------------------------- kit previews for menus

const SHIRT_PATH = 'M31 6L42 3Q50 11 58 3L69 6L93 21L85 40L74 34L74 84L26 84L26 34L15 40L7 21Z';

function fmt2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** SVG path data of a number's digit strokes, digits `h` units tall, centred on (cx, cy). */
function numberPath(n: number, cx: number, cy: number, h: number): string {
  const x0 = cx - (numberWidthEm(n) * h) / 2, y0 = cy - h / 2;
  let d = '';
  for (const l of numberLines(n)) {
    for (let i = 0; i < l.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${fmt2(x0 + l[i]! * h)} ${fmt2(y0 + l[i + 1]! * h)}`;
  }
  return d;
}

/**
 * SVG markup of a kit preview (shirt with its pattern and collar, shorts, socks; optional number on the chest) for
 * the kit picker: 100 x 120 view box, `size` CSS px tall. Same pattern rules and digits as the atlas. Pure.
 */
export function kitSvg(kitIn: Kit, size = 96, shirtNumber = 0): string {
  const k = sanitizeKit(kitIn);
  const c = cssHex;
  const id = `k${(k.shirt ^ (k.shirt2 << 1) ^ (k.pattern << 7)) >>> 0}`;
  let pat = '';
  switch (k.pattern) {
    case KitPattern.STRIPES:
      for (const x of [15, 35, 55, 75]) pat += `<rect x="${x}" y="0" width="10" height="90" fill="${c(k.shirt2)}"/>`;
      break;
    case KitPattern.HOOPS:
      for (const y of [16, 36, 56, 76]) pat += `<rect x="0" y="${y}" width="100" height="10" fill="${c(k.shirt2)}"/>`;
      break;
    case KitPattern.HALVES:
      pat = `<rect x="50" y="0" width="50" height="90" fill="${c(k.shirt2)}"/>`;
      break;
    case KitPattern.SASH:
      pat = `<path d="M74 0L26 92" stroke="${c(k.shirt2)}" stroke-width="16"/>`;
      break;
    default: break;
  }
  const trim = colourDistance(k.shirt2, k.shirt) >= T.sameColour ? k.shirt2 : k.number;
  let num = '';
  if (shirtNumber >= 1 && shirtNumber <= 99) {
    const d = numberPath(Math.round(shirtNumber), 50, 52, 24);
    num = `<path d="${d}" fill="none" stroke="${c(outlineFor(k.number))}" stroke-width="${fmt2(24 * 0.18 + 3)}" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="${d}" fill="none" stroke="${c(k.number)}" stroke-width="${fmt2(24 * 0.18)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const px = Math.max(1, Math.round(size));
  const w = Math.round((px * 100) / 120);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" width="${w}" height="${px}">`
    + `<defs><clipPath id="${id}"><path d="${SHIRT_PATH}"/></clipPath></defs>`
    + `<rect x="27" y="83" width="21" height="17" fill="${c(k.shorts)}"/><rect x="52" y="83" width="21" height="17" fill="${c(k.shorts)}"/>`
    + `<rect x="30" y="100" width="15" height="17" rx="2" fill="${c(k.socks)}"/><rect x="55" y="100" width="15" height="17" rx="2" fill="${c(k.socks)}"/>`
    + `<rect x="30" y="100" width="15" height="4" fill="${c(trimColour(k.socks, k))}"/><rect x="55" y="100" width="15" height="4" fill="${c(trimColour(k.socks, k))}"/>`
    + `<g clip-path="url(#${id})"><rect x="0" y="0" width="100" height="90" fill="${c(k.shirt)}"/>${pat}`
    + `<path d="M42 3Q50 11 58 3" fill="none" stroke="${c(trim)}" stroke-width="5"/></g>`
    + `<path d="${SHIRT_PATH}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5" stroke-linejoin="round"/>`
    + `${num}</svg>`;
}

const kitUrlCache = new Map<string, string>();

/** Kit preview as an SVG data URL for <img src> (kit picker). Cached per design and number. */
export function kitDataUrl(kit: Kit, shirtNumber = 0): string {
  const key = `${kit.shirt}|${kit.shirt2}|${kit.pattern}|${kit.shorts}|${kit.socks}|${kit.number}|${shirtNumber}`;
  let url = kitUrlCache.get(key);
  if (url === undefined) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(kitSvg(kit, 120, shirtNumber))}`;
    if (kitUrlCache.size > 256) kitUrlCache.clear();
    kitUrlCache.set(key, url);
  }
  return url;
}

// ---------------------------------------------------------------- convenience: one kit set per renderer

export interface KitSet {
  readonly atlas: KitAtlas;
  /** Stable texture object (same GPU storage across matches). */
  readonly texture: DataTexture;
  /** Kits of the current match (null before setMatch). */
  readonly kits: MatchKits | null;
  /** Resolve the kits for the match, draw the atlas and flag the texture for upload. */
  setMatch(state: ReadonlySimState, clubs: readonly Club[], highContrast: boolean): MatchKits;
  /** Switch high-contrast kits; returns true when the kits changed (re-read kits, colours and UVs). */
  setHighContrast(on: boolean): boolean;
  dispose(): void;
}

export function createKitSet(anisotropy = 4): KitSet {
  const atlas = createKitAtlas();
  const texture = createKitTexture(atlas, anisotropy);
  let kits: MatchKits | null = null;
  let last: { home: Club | null; away: Club | null; hs: number; as: number; numbers: [number[], number[]] } | null = null;
  const draw = (hc: boolean): MatchKits => {
    const l = last!;
    kits = resolveKits(l.home, l.away, l.hs, l.as, hc);
    drawKitAtlas(atlas, kits, l.numbers, [l.home?.crest ?? null, l.away?.crest ?? null]);
    updateKitTexture(texture);
    return kits;
  };
  return {
    atlas,
    texture,
    get kits() { return kits; },
    setMatch(state, clubs, highContrast) {
      last = {
        home: clubById(clubs, state.teams[0]!.clubIdx),
        away: clubById(clubs, state.teams[1]!.clubIdx),
        hs: state.teams[0]!.kit,
        as: state.teams[1]!.kit,
        numbers: matchShirtNumbers(state, clubs),
      };
      return draw(highContrast);
    },
    setHighContrast(on) {
      if (!last || !kits || kits.highContrast === on) return false;
      draw(on);
      return true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

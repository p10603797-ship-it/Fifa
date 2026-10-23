/**
 * [GFX-03] Pitch: grass with mowing stripes, subtle wear, white line markings and the surrounding run-off grass
 * (section 8 "Look": "Pitch with mowing stripes and lines"; section 13 budgets: Lambert, one light + ambient).
 *
 * ONE draw call, 2 triangles: a single plane (half extents PITCH_QX x PITCH_QZ, past the advertising boards) with a
 * MeshLambertMaterial whose fragment stage is extended (onBeforeCompile) to compute the grass colour procedurally.
 * It stays a Lambert material, so GFX-05's sun + ambient (day / floodlit night) light it like everything else.
 *  - Mowing stripes: bands across x, STRIPE_WIDTH wide, the centre stripe straddling the halfway line so each goal
 *    line falls on a stripe boundary. Soft edges (never sharper than one pixel) and band-limited contrast (fades
 *    out when a stripe gets only a few pixels wide: no moire toward the horizon of low cameras).
 *  - Grass detail and wear: one small generated RGBA data texture (DETAIL_SIZE^2, 256 KB + mips) over the plane:
 *    R = wear (goalmouths, goal line between the posts, penalty spots, centre), G = large-scale mottling,
 *    B = fine tileable grain, sampled a second time at LOCAL_TUNING.grainRepeat.
 *  - Line markings: analytic signed distances to every marking of PITCH_MARKS (contracts/constants dimensions:
 *    105 x 68, centre circle 9.15, penalty areas 40.32 x 16.5, goal areas 18.32 x 5.5, spots at 11 m, penalty arcs,
 *    corner arcs r = 1, line width 0.12). The GLSL is generated from that one table (buildLineGlsl) and
 *    lineCoverage() is its exact TypeScript twin, used by the tests. Lines lie inside the area they bound (outer
 *    edge on the boundary). Anti-aliased from screen-space derivatives and never thinner than
 *    LOCAL_TUNING.lineMinPx render pixels: a line whose true width is below that is drawn at the minimum width with
 *    reduced opacity, so the far touchline neither breaks up nor shimmers while the camera pans. Overlapping
 *    markings merge by maximum coverage (no brighter junctions where lines meet).
 * Why not merged line geometry or a baked texture: geometry without MSAA aliases (stair-steps crawl as the camera
 * slides) and needs per-vertex widening; a baked texture blurs the far lines into faint, mip-dependent smudges.
 * The analytic version is crisp at every distance and adds no draw calls (~200 ALU ops per pitch fragment).
 *
 * drawQuarterPitch() draws the same stripes and markings into a 2D canvas (reference drawing for UI previews and
 * tests); the 3D pitch does not use it.
 */

import {
  Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshLambertMaterial, NoColorSpace, PlaneGeometry,
  RGBAFormat, RepeatWrapping, UnsignedByteType, Vector2, type IUniform, type WebGLProgramParametersWithUniforms,
} from 'three';
import {
  CENTRE_CIRCLE_RADIUS, CORNER_ARC_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, LINE_WIDTH,
  PENALTY_ARC_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST,
} from '../contracts/constants';
import { QualityTier } from '../contracts/enums';
import type { RenderContext, RenderFrame, RenderModule } from './types';

/**
 * Visual knobs of the pitch (render only, no gameplay effect). Kept local by TUN-2 (not gameplay; could become
 * a T_PITCH block in contracts/tuning.ts if the lead wants them there).
 */
const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: pitch look, render only)
  /** Minimum on-screen width of every line marking, render-target pixels (section 13: no sub-pixel shimmer). */
  lineMinPx: 2,
  /** Opacity of a line widened to lineMinPx whose true width tends to 0 px; lerps to 1 at its true width (0..1). */
  lineMinAlpha: 0.6,
  /** Fraction of line opacity lost on fully worn grass (scuffed paint in the goalmouth), 0..1. */
  lineWear: 0.2,
  /** Half-width of the soft blend between two mowing stripes, m (never below one pixel). */
  stripeSoft: 0.15,
  /** Stripe contrast fades out as a stripe shrinks from stripeFadePx[1] to stripeFadePx[0] pixels wide. */
  stripeFadePx: [3, 10] as readonly [number, number],
  /** Run-off brightness relative to the playing surface beyond the outer edge of the touch and goal lines, 0..1. */
  runoffShade: 0.93,
  /** Width of the run-off shade ramp outside the lines, m. */
  runoffRamp: 0.8,
  /** Mix toward WEAR_COLOUR on fully worn grass, 0..1 ("subtle wear"). */
  wearStrength: 0.45,
  /** +- relative brightness of the large-scale mottling (G) and the fine grain (B). */
  mottle: 0.05,
  grain: 0.06,
  /** The fine grain repeats this many times across the plane (period 2 * PITCH_QX / grainRepeat m along x). */
  grainRepeat: 8,
  /** Anisotropic filtering per resolved tier [PERFORMANCE, BALANCED, QUALITY] (capped by the GPU). */
  anisotropy: [1, 4, 8] as readonly number[],
} as const;
export const PITCH_TUNING = LOCAL_TUNING;

/** Plane half extents (m): the grass reaches past the advertising boards (BOARD_X 58, BOARD_Z 40). */
export const PITCH_QX = 60;
export const PITCH_QZ = 42;
/**
 * Mowing stripe width along x (m): 21 stripes over the 105 m pitch, the centre stripe straddling the halfway
 * line, so each goal line falls on a stripe boundary (2.5 + 10 * 5 = 52.5).
 */
export const STRIPE_WIDTH = 5;
/** Light / dark stripe colours (sRGB). data/kits.ts lists them as grass tones for the kit clash check. */
export const GRASS_LIGHT = '#4f9a3f';
export const GRASS_DARK = '#438a35';
/** Line paint (sRGB): off-white, readable against both stripes. */
export const LINE_COLOUR = '#f2f4ec';
/** Worn, dry grass (sRGB): olive, still greener than red so worn grass reads as grass, not as mud. */
export const WEAR_COLOUR = '#9fa660';
/** Centre and penalty spot radius (m): 22 cm marks. */
export const SPOT_RADIUS = 0.11;
/** Wear / detail texture size (texels per side). */
export const DETAIL_SIZE = 256;

// ---------------------------------------------------------------- markings (one table, quarter coordinates)

/**
 * A straight marking in the quarter x >= 0, z >= 0 (the markings are symmetric about both axes): the axis-aligned
 * rectangle at its true width. `across` is the axis across the line; `pin` the edge that stays put when the line is
 * widened to the minimum pixel width (the boundary it marks; the line grows into the area it bounds). An edge at
 * exactly 0 is a mirror fold, not an end: the halfway line (x in [0, L/2], pinned on the fold) is centred on x = 0.
 */
export interface RectMark {
  kind: 'rect';
  name: string;
  x0: number; x1: number; z0: number; z1: number;
  across: 'x' | 'z';
  pin: 'min' | 'max';
}
/** A ring of width w whose OUTER radius r is pinned; only its part with x <= clipX and z <= clipZ is drawn. */
export interface RingMark {
  kind: 'ring';
  name: string;
  cx: number; cz: number;
  r: number; w: number;
  clipX: number; clipZ: number;
}
/** A filled spot of radius r (grows outward when widened). */
export interface DiscMark {
  kind: 'disc';
  name: string;
  cx: number; cz: number;
  r: number;
}
export type PitchMark = RectMark | RingMark | DiscMark;

const L = LINE_WIDTH;
/** Penalty-area front edge, goal-area front edge, penalty spot (x of the +x goal). */
const PA_X = HALF_LENGTH - PENALTY_AREA_DEPTH;
const GA_X = HALF_LENGTH - GOAL_AREA_DEPTH;
const PS_X = HALF_LENGTH - PENALTY_SPOT_DIST;

/** Every marking of the pitch, in the quarter x >= 0, z >= 0 (mirrored to the other three). */
export const PITCH_MARKS: readonly PitchMark[] = [
  { kind: 'rect', name: 'touchline', x0: 0, x1: HALF_LENGTH, z0: HALF_WIDTH - L, z1: HALF_WIDTH, across: 'z', pin: 'max' },
  { kind: 'rect', name: 'goal line', x0: HALF_LENGTH - L, x1: HALF_LENGTH, z0: 0, z1: HALF_WIDTH, across: 'x', pin: 'max' },
  { kind: 'rect', name: 'halfway line', x0: 0, x1: L / 2, z0: 0, z1: HALF_WIDTH, across: 'x', pin: 'min' },
  { kind: 'rect', name: 'penalty area front', x0: PA_X, x1: PA_X + L, z0: 0, z1: PENALTY_AREA_HALF_WIDTH, across: 'x', pin: 'min' },
  {
    kind: 'rect', name: 'penalty area side', x0: PA_X, x1: HALF_LENGTH,
    z0: PENALTY_AREA_HALF_WIDTH - L, z1: PENALTY_AREA_HALF_WIDTH, across: 'z', pin: 'max',
  },
  { kind: 'rect', name: 'goal area front', x0: GA_X, x1: GA_X + L, z0: 0, z1: GOAL_AREA_HALF_WIDTH, across: 'x', pin: 'min' },
  {
    kind: 'rect', name: 'goal area side', x0: GA_X, x1: HALF_LENGTH,
    z0: GOAL_AREA_HALF_WIDTH - L, z1: GOAL_AREA_HALF_WIDTH, across: 'z', pin: 'max',
  },
  { kind: 'ring', name: 'centre circle', cx: 0, cz: 0, r: CENTRE_CIRCLE_RADIUS, w: L, clipX: Infinity, clipZ: Infinity },
  // Outside the penalty area only; the clip reaches half a line into the front line so the two merge seamlessly.
  { kind: 'ring', name: 'penalty arc', cx: PS_X, cz: 0, r: PENALTY_ARC_RADIUS, w: L, clipX: PA_X + L / 2, clipZ: Infinity },
  { kind: 'ring', name: 'corner arc', cx: HALF_LENGTH, cz: HALF_WIDTH, r: CORNER_ARC_RADIUS, w: L, clipX: HALF_LENGTH, clipZ: HALF_WIDTH },
  { kind: 'disc', name: 'centre spot', cx: 0, cz: 0, r: SPOT_RADIUS },
  { kind: 'disc', name: 'penalty spot', cx: PS_X, cz: 0, r: SPOT_RADIUS },
];

/** Sentinel distance (px) for "no end here" (mirror folds, unclipped rings). */
const FAR_PX = 1e4;

/** Screen-space Jacobian of the world ground position: metres per render pixel along screen x and y. */
export interface ScreenJacobian {
  /** dX/dsx, dZ/dsx */
  xdx: number; zdx: number;
  /** dX/dsy, dZ/dsy */
  xdy: number; zdy: number;
}

export interface LineLook {
  lineMinPx: number;
  lineMinAlpha: number;
}

// The GLSL helpers below mirror these four functions exactly (dkFade, dkBand, dkBandC, dkDisc).
function fadeOf(k: number, look: LineLook): number {
  return look.lineMinAlpha + (1 - look.lineMinAlpha) * k;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** Band pinned on one edge: d = inward distance from the pinned edge (m), w0 = true width, alongPx = px inside the ends. */
function band(d: number, w0: number, mpp: number, alongPx: number, look: LineLook): number {
  const w = Math.max(w0, look.lineMinPx * mpp);
  const s = Math.min(Math.min(d, w - d) / mpp, alongPx);
  return clamp01(s + 0.5) * fadeOf(w0 / w, look);
}
/** Band centred on a fold: d = distance from the centre line (m), w0 = full true width. */
function bandC(d: number, w0: number, mpp: number, alongPx: number, look: LineLook): number {
  const w = Math.max(w0, look.lineMinPx * mpp);
  const s = Math.min((0.5 * w - d) / mpp, alongPx);
  return clamp01(s + 0.5) * fadeOf(w0 / w, look);
}
function disc(r: number, r0: number, mpp: number, look: LineLook): number {
  const rr = Math.max(r0, 0.5 * look.lineMinPx * mpp);
  return clamp01((rr - r) / mpp + 0.5) * fadeOf(r0 / rr, look);
}

/** Distance (px) inside the ends [a0, a1] of a straight marking; an end at 0 is a fold. */
function alongPx(a: number, a0: number, a1: number, mpp: number): number {
  return (a0 === 0 ? a1 - a : Math.min(a - a0, a1 - a)) / mpp;
}

/**
 * Line coverage (0..1, opacity of the paint) at world point (x, z) for a pixel footprint j. Exact TypeScript twin of
 * the generated GLSL (same table, same formulas, same order). Pure.
 */
export function lineCoverage(
  x: number, z: number, j: ScreenJacobian, marks: readonly PitchMark[] = PITCH_MARKS, look: LineLook = LOCAL_TUNING,
): number {
  const sgx = x < 0 ? -1 : 1, sgz = z < 0 ? -1 : 1;
  const qx = Math.abs(x), qz = Math.abs(z);
  const mppX = Math.max(Math.sqrt(j.xdx * j.xdx + j.xdy * j.xdy), 1e-5);
  const mppZ = Math.max(Math.sqrt(j.zdx * j.zdx + j.zdy * j.zdy), 1e-5);
  let cov = 0;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    let c: number;
    if (m.kind === 'rect') {
      if (m.across === 'x') {
        const al = alongPx(qz, m.z0, m.z1, mppZ);
        if (m.pin === 'max') c = band(m.x1 - qx, m.x1 - m.x0, mppX, al, look);
        else if (m.x0 === 0) c = bandC(qx, 2 * m.x1, mppX, al, look);
        else c = band(qx - m.x0, m.x1 - m.x0, mppX, al, look);
      } else {
        const al = alongPx(qx, m.x0, m.x1, mppX);
        if (m.pin === 'max') c = band(m.z1 - qz, m.z1 - m.z0, mppZ, al, look);
        else if (m.z0 === 0) c = bandC(qz, 2 * m.z1, mppZ, al, look);
        else c = band(qz - m.z0, m.z1 - m.z0, mppZ, al, look);
      }
    } else {
      const rx = qx - m.cx, rz = qz - m.cz;
      const rl = Math.sqrt(rx * rx + rz * rz);
      const inv = 1 / Math.max(rl, 1e-6);
      const nx = sgx * rx * inv, nz = sgz * rz * inv;
      const a = nx * j.xdx + nz * j.zdx, b = nx * j.xdy + nz * j.zdy;
      const mppR = Math.max(Math.sqrt(a * a + b * b), 1e-5);
      if (m.kind === 'disc') {
        c = disc(rl, m.r, mppR, look);
      } else {
        let clip = FAR_PX;
        if (Number.isFinite(m.clipX)) clip = Math.min(clip, (m.clipX - qx) / mppX);
        if (Number.isFinite(m.clipZ)) clip = Math.min(clip, (m.clipZ - qz) / mppZ);
        c = band(m.r - rl, m.w, mppR, clip, look);
      }
    }
    if (c > cov) cov = c;
  }
  return cov;
}

/** Mowing-stripe darkness at world x (0 = light stripe, 1 = dark, 0.5 = blended), for a pixel footprint mppX. Pure. */
export function stripeDarkness(x: number, mppX: number, look: { stripeSoft: number; stripeFadePx: readonly number[] } = LOCAL_TUNING): number {
  const su = (Math.abs(x) + 0.5 * STRIPE_WIDTH) / STRIPE_WIDTH;
  const fr = su - Math.floor(su);
  const e = (0.5 - Math.abs(fr - 0.5)) * STRIPE_WIDTH;
  const parity = Math.floor(su) % 2;
  let dark = 0.5 + (parity - 0.5) * smoothstep(0, Math.max(look.stripeSoft, mppX), e);
  dark = 0.5 + (dark - 0.5) * smoothstep(look.stripeFadePx[0]!, look.stripeFadePx[1]!, STRIPE_WIDTH / Math.max(mppX, 1e-5));
  return dark;
}

function smoothstep(e0: number, e1: number, v: number): number {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** GLSL float literal. */
function glf(n: number): string {
  return Number.isFinite(n) ? n.toFixed(5) : FAR_PX.toFixed(1);
}

/** GLSL "px inside the ends" for a straight marking (mirrors alongPx). */
function alongGlsl(a: string, a0: number, a1: number, mpp: string): string {
  return a0 === 0 ? `(${glf(a1)} - ${a}) / ${mpp}` : `min(${a} - ${glf(a0)}, ${glf(a1)} - ${a}) / ${mpp}`;
}

/**
 * GLSL statements accumulating line coverage into `dkCov` (float) from the folded position `dkQ`, the sign
 * vector `dkSg`, the derivatives `dkJx` / `dkJy` and the footprints `dkMx` / `dkMz` (all declared by the caller).
 * Generated from the marking table so the shader and lineCoverage() cannot disagree on geometry.
 */
export function buildLineGlsl(marks: readonly PitchMark[] = PITCH_MARKS): string {
  const out: string[] = [];
  for (const m of marks) {
    out.push(`// ${m.name}`);
    if (m.kind === 'rect') {
      if (m.across === 'x') {
        const al = alongGlsl('dkQ.y', m.z0, m.z1, 'dkMz');
        if (m.pin === 'max') out.push(`dkCov = max(dkCov, dkBand(${glf(m.x1)} - dkQ.x, ${glf(m.x1 - m.x0)}, dkMx, ${al}));`);
        else if (m.x0 === 0) out.push(`dkCov = max(dkCov, dkBandC(dkQ.x, ${glf(2 * m.x1)}, dkMx, ${al}));`);
        else out.push(`dkCov = max(dkCov, dkBand(dkQ.x - ${glf(m.x0)}, ${glf(m.x1 - m.x0)}, dkMx, ${al}));`);
      } else {
        const al = alongGlsl('dkQ.x', m.x0, m.x1, 'dkMx');
        if (m.pin === 'max') out.push(`dkCov = max(dkCov, dkBand(${glf(m.z1)} - dkQ.y, ${glf(m.z1 - m.z0)}, dkMz, ${al}));`);
        else if (m.z0 === 0) out.push(`dkCov = max(dkCov, dkBandC(dkQ.y, ${glf(2 * m.z1)}, dkMz, ${al}));`);
        else out.push(`dkCov = max(dkCov, dkBand(dkQ.y - ${glf(m.z0)}, ${glf(m.z1 - m.z0)}, dkMz, ${al}));`);
      }
      continue;
    }
    out.push(`dkR = dkQ - vec2(${glf(m.cx)}, ${glf(m.cz)});`);
    out.push('dkRl = length(dkR);');
    out.push('dkN = dkSg * dkR / max(dkRl, 1e-6);');
    out.push('dkMr = max(length(vec2(dot(dkN, dkJx), dot(dkN, dkJy))), 1e-5);');
    if (m.kind === 'disc') {
      out.push(`dkCov = max(dkCov, dkDisc(dkRl, ${glf(m.r)}, dkMr));`);
    } else {
      const clips: string[] = [];
      if (Number.isFinite(m.clipX)) clips.push(`(${glf(m.clipX)} - dkQ.x) / dkMx`);
      if (Number.isFinite(m.clipZ)) clips.push(`(${glf(m.clipZ)} - dkQ.y) / dkMz`);
      const clip = clips.length === 0 ? glf(FAR_PX) : clips.length === 1 ? clips[0]! : `min(${clips[0]}, ${clips[1]})`;
      out.push(`dkCov = max(dkCov, dkBand(${glf(m.r)} - dkRl, ${glf(m.w)}, dkMr, ${clip}));`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- shader

/** Declarations added to the Lambert fragment shader (after <common>). */
const FRAG_PARS = /* glsl */ `
varying vec2 vDkPitch;
uniform sampler2D uDkDetail;
uniform vec2 uDkTexScale;
uniform float uDkGrainRepeat;
uniform vec3 uDkGrassLight;
uniform vec3 uDkGrassDark;
uniform vec3 uDkLineColour;
uniform vec3 uDkWearColour;
uniform float uDkLineMinPx;
uniform float uDkLineMinAlpha;
uniform float uDkLineWear;
uniform float uDkStripeSoft;
uniform vec2 uDkStripeFadePx;
uniform vec2 uDkRunoff;
uniform float uDkWearStrength;
uniform float uDkMottle;
uniform float uDkGrain;
float dkFade(float k) { return uDkLineMinAlpha + (1.0 - uDkLineMinAlpha) * k; }
float dkBand(float d, float w0, float mpp, float alongPx) {
  float w = max(w0, uDkLineMinPx * mpp);
  float s = min(min(d, w - d) / mpp, alongPx);
  return clamp(s + 0.5, 0.0, 1.0) * dkFade(w0 / w);
}
float dkBandC(float d, float w0, float mpp, float alongPx) {
  float w = max(w0, uDkLineMinPx * mpp);
  float s = min((0.5 * w - d) / mpp, alongPx);
  return clamp(s + 0.5, 0.0, 1.0) * dkFade(w0 / w);
}
float dkDisc(float r, float r0, float mpp) {
  float rr = max(r0, 0.5 * uDkLineMinPx * mpp);
  return clamp((rr - r) / mpp + 0.5, 0.0, 1.0) * dkFade(r0 / rr);
}
`;

/** Replaces <map_fragment>: the procedural grass colour multiplies diffuseColor (white). */
function fragMain(): string {
  const S = glf(STRIPE_WIDTH);
  return /* glsl */ `
{
  vec2 dkP = vDkPitch;
  vec2 dkSg = vec2(dkP.x < 0.0 ? -1.0 : 1.0, dkP.y < 0.0 ? -1.0 : 1.0);
  vec2 dkQ = abs(dkP);
  vec2 dkJx = dFdx(dkP);
  vec2 dkJy = dFdy(dkP);
  float dkMx = max(length(vec2(dkJx.x, dkJy.x)), 1e-5);
  float dkMz = max(length(vec2(dkJx.y, dkJy.y)), 1e-5);
  vec2 dkUv = dkP * uDkTexScale + 0.5;
  vec4 dkT0 = texture2D(uDkDetail, dkUv);
  vec4 dkT1 = texture2D(uDkDetail, dkUv * uDkGrainRepeat);
  // Mowing stripes (stripeDarkness).
  float dkSu = (dkQ.x + 0.5 * ${S}) / ${S};
  float dkE = (0.5 - abs(fract(dkSu) - 0.5)) * ${S};
  float dkDark = mix(0.5, mod(floor(dkSu), 2.0), smoothstep(0.0, max(uDkStripeSoft, dkMx), dkE));
  dkDark = mix(0.5, dkDark, smoothstep(uDkStripeFadePx.x, uDkStripeFadePx.y, ${S} / dkMx));
  vec3 dkGrass = mix(uDkGrassLight, uDkGrassDark, dkDark);
  // Run-off: slightly darker beyond the outer edge of the touch and goal lines.
  float dkOut = smoothstep(0.0, uDkRunoff.y, max(dkQ.x - ${glf(HALF_LENGTH)}, dkQ.y - ${glf(HALF_WIDTH)}));
  dkGrass *= mix(1.0, uDkRunoff.x, dkOut);
  // Mottling and grain, then wear.
  dkGrass *= 1.0 + (dkT0.g - 0.5) * 2.0 * uDkMottle + (dkT1.b - 0.5) * 2.0 * uDkGrain;
  // Wear (R) broken up by the fine grain into patches: worn turf, not a smooth stain.
  float dkWear = clamp(dkT0.r * (0.4 + 1.2 * dkT1.b), 0.0, 1.0);
  dkGrass = mix(dkGrass, uDkWearColour * (0.85 + 0.3 * dkT1.b), dkWear * uDkWearStrength);
  // Line markings (generated from PITCH_MARKS).
  float dkCov = 0.0;
  vec2 dkR; float dkRl; vec2 dkN; float dkMr;
${buildLineGlsl().split('\n').map((l) => `  ${l}`).join('\n')}
  dkCov *= 1.0 - dkWear * uDkLineWear;
  diffuseColor.rgb *= mix(dkGrass, uDkLineColour, dkCov);
}
`;
}

/** Shader anchors the pitch material patches (three.js Lambert); checked by the unit tests against the installed three. */
export const PITCH_SHADER_ANCHORS = {
  vertexPars: '#include <common>',
  vertexMain: '#include <begin_vertex>',
  fragmentPars: '#include <common>',
  fragmentMain: '#include <map_fragment>',
} as const;

export interface PitchUniforms {
  [name: string]: IUniform;
  uDkDetail: IUniform<DataTexture | null>;
  uDkTexScale: IUniform<Vector2>;
  uDkGrainRepeat: IUniform<number>;
  uDkGrassLight: IUniform<Color>;
  uDkGrassDark: IUniform<Color>;
  uDkLineColour: IUniform<Color>;
  uDkWearColour: IUniform<Color>;
  uDkLineMinPx: IUniform<number>;
  uDkLineMinAlpha: IUniform<number>;
  uDkLineWear: IUniform<number>;
  uDkStripeSoft: IUniform<number>;
  uDkStripeFadePx: IUniform<Vector2>;
  uDkRunoff: IUniform<Vector2>;
  uDkWearStrength: IUniform<number>;
  uDkMottle: IUniform<number>;
  uDkGrain: IUniform<number>;
}

export function createPitchUniforms(detail: DataTexture | null): PitchUniforms {
  const t = LOCAL_TUNING;
  return {
    uDkDetail: { value: detail },
    uDkTexScale: { value: new Vector2(1 / (2 * PITCH_QX), 1 / (2 * PITCH_QZ)) },
    uDkGrainRepeat: { value: t.grainRepeat },
    uDkGrassLight: { value: new Color(GRASS_LIGHT) },
    uDkGrassDark: { value: new Color(GRASS_DARK) },
    uDkLineColour: { value: new Color(LINE_COLOUR) },
    uDkWearColour: { value: new Color(WEAR_COLOUR) },
    uDkLineMinPx: { value: t.lineMinPx },
    uDkLineMinAlpha: { value: t.lineMinAlpha },
    uDkLineWear: { value: t.lineWear },
    uDkStripeSoft: { value: t.stripeSoft },
    uDkStripeFadePx: { value: new Vector2(t.stripeFadePx[0], t.stripeFadePx[1]) },
    uDkRunoff: { value: new Vector2(t.runoffShade, t.runoffRamp) },
    uDkWearStrength: { value: t.wearStrength },
    uDkMottle: { value: t.mottle },
    uDkGrain: { value: t.grain },
  };
}

/** Patch the three.js Lambert shaders in place (onBeforeCompile body). Throws if an anchor is missing. */
export function patchPitchShader(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, IUniform> }, uniforms: PitchUniforms): void {
  const a = PITCH_SHADER_ANCHORS;
  for (const [src, anchor] of [[shader.vertexShader, a.vertexPars], [shader.vertexShader, a.vertexMain],
    [shader.fragmentShader, a.fragmentPars], [shader.fragmentShader, a.fragmentMain]] as const) {
    if (!src.includes(anchor)) throw new Error(`[pitch] shader anchor missing: ${anchor}`);
  }
  shader.vertexShader = shader.vertexShader
    .replace(a.vertexPars, `${a.vertexPars}\nvarying vec2 vDkPitch;`)
    .replace(a.vertexMain, `${a.vertexMain}\nvDkPitch = (modelMatrix * vec4(transformed, 1.0)).xz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace(a.fragmentPars, `${a.fragmentPars}\n${FRAG_PARS}`)
    .replace(a.fragmentMain, fragMain());
  for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k]!;
}

/** The pitch material: Lambert (lit by GFX-05) with the procedural grass + lines fragment stage. */
export function createPitchMaterial(uniforms: PitchUniforms): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ color: 0xffffff });
  mat.name = 'pitch';
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => patchPitchShader(shader, uniforms);
  mat.customProgramCacheKey = () => 'dk-pitch-1';
  // [QF-4] The onBeforeCompile uniforms, visible to scene walks (texture memory, context-restore rebuild).
  mat.userData.uniforms = uniforms;
  return mat;
}

// ---------------------------------------------------------------- wear and grass detail (generated, deterministic)

/** One wear blob (m): centre at |x| = ax (mirrored to both goals), z; radii rx, rz; peak amount a. */
export interface WearSpot { ax: number; z: number; rx: number; rz: number; a: number }

/** Where grass wears: goalmouths (keeper's area, goal line between the posts), penalty spots, the centre. */
export const WEAR_SPOTS: readonly WearSpot[] = [
  { ax: HALF_LENGTH - 2.2, z: 0, rx: 2.6, rz: 3.4, a: 1.0 },
  { ax: HALF_LENGTH - 0.6, z: 0, rx: 0.9, rz: 3.3, a: 0.7 },
  { ax: HALF_LENGTH - GOAL_AREA_DEPTH / 2, z: 0, rx: 4.5, rz: 7.5, a: 0.3 },
  { ax: PS_X, z: 0, rx: 1.2, rz: 1.2, a: 0.65 },
  { ax: 0, z: 0, rx: 1.6, rz: 1.6, a: 0.4 },
  { ax: 0, z: 0, rx: 6.0, rz: 4.5, a: 0.12 },
];

/** Integer hash of a lattice point -> [0, 1). Pure, deterministic. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrap(i: number, n: number): number {
  const r = i % n;
  return r < 0 ? r + n : r;
}

/** Smooth value noise in [0, 1) at lattice coordinates (u, v); period > 0 makes it tile every `period` cells. */
export function valueNoise(u: number, v: number, seed: number, period = 0): number {
  const iu = Math.floor(u), iv = Math.floor(v);
  const fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  let i0 = iu, i1 = iu + 1, j0 = iv, j1 = iv + 1;
  if (period > 0) {
    i0 = wrap(i0, period); i1 = wrap(i1, period); j0 = wrap(j0, period); j1 = wrap(j1, period);
  }
  const a = hash2(i0, j0, seed), b = hash2(i1, j0, seed), c = hash2(i0, j1, seed), d = hash2(i1, j1, seed);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/** Smooth wear field (0..~1.3) before break-up: sum of WEAR_SPOTS Gaussians. Pure. */
export function wearBase(x: number, z: number): number {
  const ax = Math.abs(x);
  let w = 0;
  for (let i = 0; i < WEAR_SPOTS.length; i++) {
    const s = WEAR_SPOTS[i]!;
    const dx = (ax - s.ax) / s.rx, dz = (z - s.z) / s.rz;
    w += s.a * Math.exp(-(dx * dx + dz * dz));
  }
  return w;
}

/** Wear amount 0..1 at world (x, z): the smooth field broken up by noise into patches. Pure. */
export function wearAt(x: number, z: number): number {
  const base = wearBase(x, z);
  if (base < 0.02) return 0;
  const n = 0.5 * valueNoise(x * 0.45, z * 0.45, 11) + 0.3 * valueNoise(x * 1.1, z * 1.1, 12) + 0.2 * valueNoise(x * 2.6, z * 2.6, 13);
  return clamp01(base * (0.35 + 1.3 * n) - 0.12);
}

/**
 * The detail texture (RGBA8, size x size, row 0 at z = -PITCH_QZ, column 0 at x = -PITCH_QX): R wear, G large-scale
 * mottling, B fine grain (tiles with the texture), A 255. Deterministic. Pure.
 */
export function generateGrassDetail(size = DETAIL_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const p1 = size / 4, p2 = size / 2;
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size - 0.5) * 2 * PITCH_QZ;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * 2 * PITCH_QX;
      const o = (j * size + i) * 4;
      const mottle = 0.5 * valueNoise(x * 0.12, z * 0.12, 21) + 0.3 * valueNoise(x * 0.27, z * 0.27, 22)
        + 0.2 * valueNoise(x * 0.6, z * 0.6, 23);
      const grain = 0.5 * valueNoise(i / 4, j / 4, 31, p1) + 0.3 * valueNoise(i / 2, j / 2, 32, p2) + 0.2 * hash2(i, j, 33);
      data[o] = Math.round(wearAt(x, z) * 255);
      data[o + 1] = Math.round(clamp01(mottle) * 255);
      data[o + 2] = Math.round(clamp01(grain) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

function createDetailTexture(): DataTexture {
  const tex = new DataTexture(generateGrassDetail(DETAIL_SIZE), DETAIL_SIZE, DETAIL_SIZE, RGBAFormat, UnsignedByteType);
  tex.name = 'pitch-detail';
  tex.colorSpace = NoColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Anisotropy for a resolved tier, capped by the GPU maximum. Pure. */
export function anisotropyFor(tier: QualityTier, maxAniso: number): number {
  const idx = tier === QualityTier.PERFORMANCE ? 0 : tier === QualityTier.QUALITY ? 2 : 1;
  return Math.max(1, Math.min(LOCAL_TUNING.anisotropy[idx]!, maxAniso));
}

// ---------------------------------------------------------------- 2D reference drawing

/**
 * Draw the quarter pitch (x >= 0, z >= 0, out to PITCH_QX x PITCH_QZ) into a 2D canvas context of size w x h
 * (x right = +x, y down = +z): stripes and every marking of PITCH_MARKS at true size. Reference drawing for UI
 * previews and tests; the 3D pitch computes the same thing in its shader.
 */
export function drawQuarterPitch(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.save();
  g.scale(w / PITCH_QX, h / PITCH_QZ);
  g.fillStyle = GRASS_LIGHT;
  g.fillRect(0, 0, STRIPE_WIDTH / 2, PITCH_QZ);
  for (let i = 0; STRIPE_WIDTH / 2 + i * STRIPE_WIDTH < PITCH_QX; i++) {
    g.fillStyle = i % 2 === 0 ? GRASS_DARK : GRASS_LIGHT;
    g.fillRect(STRIPE_WIDTH / 2 + i * STRIPE_WIDTH, 0, STRIPE_WIDTH, PITCH_QZ);
  }
  g.fillStyle = LINE_COLOUR;
  for (const m of PITCH_MARKS) {
    if (m.kind === 'rect') {
      g.fillRect(m.x0, m.z0, m.x1 - m.x0, m.z1 - m.z0);
    } else if (m.kind === 'disc') {
      g.beginPath();
      g.arc(m.cx, m.cz, m.r, 0, Math.PI * 2);
      g.fill();
    } else {
      g.save();
      g.beginPath();
      g.rect(0, 0, Math.min(m.clipX, PITCH_QX), Math.min(m.clipZ, PITCH_QZ));
      g.clip();
      g.beginPath();
      g.arc(m.cx, m.cz, m.r, 0, Math.PI * 2);
      g.moveTo(m.cx + m.r - m.w, m.cz);
      g.arc(m.cx, m.cz, m.r - m.w, 0, Math.PI * 2, true);
      g.fill();
      g.restore();
    }
  }
  g.restore();
}

// ---------------------------------------------------------------- module

export interface PitchModule extends RenderModule {
  readonly mesh: Mesh;
  readonly material: MeshLambertMaterial;
  /** Wear / grass detail texture (R wear, G mottling, B grain). */
  readonly detail: DataTexture;
  readonly uniforms: PitchUniforms;
}

export function createPitch(ctx: RenderContext): PitchModule {
  const geo = new PlaneGeometry(PITCH_QX * 2, PITCH_QZ * 2, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.deleteAttribute('uv');
  const detail = createDetailTexture();
  const uniforms = createPitchUniforms(detail);
  const mat = createPitchMaterial(uniforms);
  const mesh = new Mesh(geo, mat);
  mesh.name = 'pitch';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.visible = false;
  ctx.scene.add(mesh);

  function applyQuality(tier: QualityTier): void {
    const maxAniso = ctx.renderer ? ctx.renderer.capabilities.getMaxAnisotropy() : 1;
    const a = anisotropyFor(tier, maxAniso);
    if (a !== detail.anisotropy) {
      detail.anisotropy = a;
      detail.needsUpdate = true;
    }
  }
  applyQuality(ctx.tier);

  return {
    mesh,
    material: mat,
    detail,
    uniforms,
    setMatch() { mesh.visible = true; },
    update(_f: RenderFrame) { /* static */ },
    setQuality(tier: QualityTier) { applyQuality(tier); },
    warmUp() { if (ctx.renderer) ctx.renderer.initTexture(detail); },
    clearMatch() { mesh.visible = false; },
    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      detail.dispose();
    },
  };
}

/**
 * [GFX-04] Goals and nets with ripple (section 8 "Look": "goals with nets that ripple"; section 13 budgets).
 * Geometry follows contracts/constants and matches sim/ball/contact.ts: inside of the posts at z = +-GOAL_HALF_WIDTH,
 * underside of the bar at GOAL_HEIGHT, POST_RADIUS cylinders standing on the goal line (back of the post on the
 * line), net box GOAL_DEPTH deep (back, roof, two sides; open at the mouth).
 *
 * DRAW CALLS: 2 for both goals (budget 6).
 *  - `frame`: one InstancedMesh of a unit cylinder (Lambert, per-instance colour): per goal two posts and the bar
 *    (white, POST_RADIUS) plus the back support frame (8 thin grey tubes: rear ground bar, two rear uprights, rear
 *    top bar, two roof side bars, two ground side bars). 22 instances. Casts a shadow only at tiers with a shadow map.
 *  - `net`: one Mesh / ShaderMaterial (unlit, transparent, two-sided, no depth write) holding a soft ground shadow
 *    under each net (drawn first in the index order) and the four net sheets of both goals as vertex grids. The net
 *    pattern is procedural in the fragment shader (anti-aliased square mesh that converges to its average coverage
 *    with distance, so there is no moire and it reads as a translucent white box from the broadcast camera and as
 *    cords in a close-up). Grid density follows getTierParams().netDetail (GOAL_TUNING.netStep).
 *
 * RIPPLE (vertex shader, no CPU cost per vertex): up to RIPPLE_SLOTS ripples, each a centre, an age (s) and a signed
 * amplitude (m, + = outward from the goal box) in uniforms. Displacement along the sheet normal is
 * rippleDisplacement(distance, age, amp) x the vertex pin weight (0 on every sheet edge: the net is tied to the
 * posts, bar, back frame and ground): a fast bulge where the ball hits plus a damped ring wave, cut smoothly to
 * exactly 0 at GOAL_TUNING.rippleDuration (~1.1 s). A pending ripple has a negative age (no displacement yet).
 * Triggers:
 *  - NET event (ball entered the net volume, a = end, c = speed, x/y/z = ball): the impact point is predicted from
 *    the ball position and velocity (predictNetImpact: first sheet on the ball's path, hit after at most
 *    impactDelayMax) and an outward ripple scaled by speed is scheduled there.
 *  - The interpolated ball crossing into a net volume (what the NET event reports) when no entry was seen for that
 *    goal recently: replays (GFX-16) show the ripple without sim events. Live, the event always comes first.
 *  - The interpolated ball touching a sheet with an approach speed (side netting or roof from outside: inward
 *    ripple; inside contacts after the entry window: outward). Per-sheet hysteresis + cooldown; apparent speeds
 *    above teleportSpeed (restarts, replay jumps) are ignored.
 * POST event (a = end, b = 0 post / 1 bar, c = impact speed): the goal frame shakes (rotation about the goal line on
 * the ground; the bar and the front of the net move with it; the back frame stays put) for wobbleDuration, and a small
 * ripple at the hit point shivers the net.
 * Time advances with FrameInfo.dtMs and stops while paused.
 *
 * DEBUG: window.__dotkickGoals (GoalsDebug): closeUp(end) overrides ctx.camera's pose and FOV after the cameras ran
 * (goal close-up for e2e screenshots), snapshot() reports ripples, sway, detail and draw-call counts.
 * No allocation in update() or in hot onEvents() code (V8 sampling heap profiler: tests/unit/gfx-04-alloc-probe.ts);
 * doubles cross calls only through typed-array registers. Rare paths (a net entry, a POST) allocate a few hundred bytes
 * while V8 still interprets them.
 */

import {
  BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, InstancedMesh, Matrix4, Mesh,
  MeshDepthMaterial, MeshLambertMaterial, ShaderMaterial, Vector2, Vector3, Vector4,
} from 'three';
import {
  BALL_RADIUS, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, POST_RADIUS,
} from '../contracts/constants';
import { QualityTier } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import { getTierParams } from './quality';
import { createInterpState, type RenderContext, type RenderFrame, type RenderModule } from './types';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: render only)
  // ---- net look
  /** Drawn net mesh cell size, m. */
  netCell: 0.15,
  /** Drawn cord width, m. */
  netCord: 0.024,
  /** Alpha of a cord (fully covered pixel). */
  netCordAlpha: 0.95,
  /** Alpha between the cords (a faint fill so the box reads from far away). */
  netHaze: 0.06,
  /** Displaced (stretched) net draws this much more opaque at a displacement of stretchRef m (ripple reads from afar). */
  netStretchAlpha: 1.2,
  stretchRef: 0.25,
  /** Net colour by day / at night (sRGB hex). */
  netColourDay: 0xffffff,
  netColourNight: 0xdfe5ee,
  /** Vertex spacing of the net grid per TierParams.netDetail (0 coarse, 1 medium, 2 full), m. */
  netStep: [0.46, 0.26, 0.16] as readonly number[],
  /** The ripple fades to 0 within this distance of a sheet edge (tied to the frame / ground), m. */
  pinDist: 0.45,
  /** Ground shadow under each net: alpha at the centre, margin around the footprint (m), height above the grass (m). */
  shadowAlpha: 0.2,
  shadowMargin: 0.2,
  shadowY: 0.012,
  // ---- ripple shape (shared by the shader and rippleDisplacement)
  /** Displacement is exactly 0 from this age on, s. */
  rippleDuration: 1.1,
  /** The envelope starts its smooth cut at this age, s. */
  rippleFadeStart: 0.7,
  /** Time to the peak of the bulge, s. */
  bulgeRise: 0.09,
  /** Gaussian radius of the bulge, m. */
  bulgeRadius: 0.6,
  /** Ring wave speed (m/s), wavelength (m), decay time (s), distance falloff (m), ramp behind the front (m). */
  waveSpeed: 4.5,
  waveLength: 1.15,
  waveDecay: 0.35,
  waveFalloff: 2.5,
  waveFront: 0.35,
  /** Ring amplitude relative to the bulge. */
  waveShare: 0.4,
  // ---- ripple triggers
  /** Bulge per m/s of ball speed, m/(m/s); capped at netMaxAmp (m). */
  netGain: 0.016,
  netMaxAmp: 0.45,
  /** Slower balls do not ripple the net, m/s. */
  netMinSpeed: 1.5,
  /** Longest wait from the goal mouth to the predicted impact, s. */
  impactDelayMax: 0.12,
  /** Extra distance counted as touching a sheet (interpolated positions), m. */
  contactSlop: 0.05,
  /** Minimum time between two contact ripples on one sheet, s. */
  contactCooldown: 0.3,
  /** A second entry into the same goal within this time is the same one (event + interpolation), s. */
  entryWindow: 0.6,
  /** Apparent ball speeds above this are teleports (restarts, replay start): no contacts or entries, m/s. */
  teleportSpeed: 45,
  /** [QF-7R] warmUp(): frames of shots into each net (plus a post hit each) run off screen while loading. */
  warmUpFrames: 1200,
  // ---- frame
  /** Back support tube radius, m. */
  supportRadius: 0.025,
  /** Posts and bar / back support colours (sRGB hex). */
  frameColour: 0xf7f7f3,
  supportColour: 0xb4bcc6,
  /** Radial segments of the frame cylinder. */
  frameSegments: 12,
  // ---- frame shake (POST)
  /** Sway at bar height per m/s of impact speed for a post / bar hit, m/(m/s); capped at wobbleMax (m). */
  wobbleGainPost: 0.0025,
  wobbleGainBar: 0.0035,
  wobbleMax: 0.08,
  /** Shake frequency (Hz), decay time (s), total duration (s; exactly 0 after). */
  wobbleHz: 5.5,
  wobbleDecay: 0.22,
  wobbleDuration: 1.0,
  /** Net shiver from a frame hit: ripple amplitude per m/s, cap (m). */
  postRippleGain: 0.004,
  postRippleMax: 0.08,
  // ---- debug close-up
  closeUpDist: 13,
  closeUpAngleDeg: 40,
  closeUpEyeY: 3.2,
  closeUpLookY: 1.1,
  /** Close-up vertical field of view, deg (fixed, so the picture does not depend on the broadcast camera's widening). */
  closeUpFovDeg: 26,
} as const;

/** Tuning (read-only) for tests and tools. */
export const GOAL_TUNING = LOCAL_TUNING;

/** Concurrent ripples (shader uniforms). */
export const RIPPLE_SLOTS = 4;
/** Instances in the frame mesh: per goal 2 posts + bar + 8 support tubes. */
export const FRAME_INSTANCES = 22;
/** Sheet ids (predictNetImpact, contact detection). */
export const SHEET_BACK = 0;
export const SHEET_ROOF = 1;
export const SHEET_SIDE_POS = 2;
export const SHEET_SIDE_NEG = 3;

/** End-relative net box (u = end * x grows into the goal). */
const GL = HALF_LENGTH;
const GB = HALF_LENGTH + GOAL_DEPTH;
const GW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;
const R = BALL_RADIUS;
/** Whole ball over the goal line (sim/ball/contact.ts NET_FRONT). */
const NET_FRONT = GL + R;
const INF = 1e9;
const WAVE_K = (2 * Math.PI) / LOCAL_TUNING.waveLength;
const WOBBLE_W = 2 * Math.PI * LOCAL_TUNING.wobbleHz;

export interface GoalsSnapshot {
  time: number;
  ripples: { x: number; y: number; z: number; age: number; amp: number }[];
  /** Frame sway at bar height for the goal at -x and +x, m. */
  sway: [number, number];
  netDetail: number;
  netVertices: number;
  netTriangles: number;
  frameInstances: number;
  /** Goal meshes drawn (each one draw call). */
  drawCalls: number;
}

/** Debug hook (window.__dotkickGoals). */
export interface GoalsDebug {
  /** Goal close-up: end -1 / +1 (0 = off). Overrides ctx.camera's pose after the cameras ran. */
  closeUp(end: number, angleDeg?: number, dist?: number, eyeY?: number): void;
  snapshot(): GoalsSnapshot;
}

declare global {
  interface Window {
    __dotkickGoals?: GoalsDebug;
  }
}

export interface GoalsModule extends RenderModule {
  readonly frame: InstancedMesh;
  readonly net: Mesh;
  /** Net shader uniforms (ripple slots, sway) for tests and tools. */
  readonly uniforms: NetUniforms;
  readonly debug: GoalsDebug;
}

export interface NetUniforms {
  [name: string]: { value: unknown };
  /** xyz = ripple centre (m), w = age (s; <= 0 pending). */
  uRip: { value: Vector4[] };
  /** Signed amplitude per slot, m (0 = free). */
  uAmp: { value: Vector4 };
  /** Frame sway at bar height for the goal at -x (x) and +x (y), m. */
  uSway: { value: Vector2 };
  uColour: { value: Color };
}

// ============================================================ pure maths (mirrored in the shader)

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth01(v: number): number {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
}

/** Ripple envelope: 1 until rippleFadeStart, smooth cut to exactly 0 at rippleDuration; 0 for age <= 0. */
export function rippleEnvelope(age: number): number {
  const T = LOCAL_TUNING;
  if (!(age > 0) || age >= T.rippleDuration) return 0;
  return 1 - smooth01((age - T.rippleFadeStart) / (T.rippleDuration - T.rippleFadeStart));
}

/**
 * Net displacement (m, along the sheet normal, before the pin weight) at distance r (m) from a ripple centre, age s
 * after the impact, for amplitude amp (m). Bulge (Gaussian, rises in bulgeRise then decays) plus a ring wave behind
 * a front moving at waveSpeed, decaying with time and distance. |result| <= |amp| * (1 + waveShare); exactly 0 for
 * age <= 0 and age >= rippleDuration. The vertex shader evaluates the same formula.
 */
export function rippleDisplacement(r: number, age: number, amp: number): number {
  const T = LOCAL_TUNING;
  const env = rippleEnvelope(age);
  if (env === 0 || amp === 0) return 0;
  const q = age / T.bulgeRise;
  const bulge = Math.exp(-(r * r) / (T.bulgeRadius * T.bulgeRadius)) * q * Math.exp(1 - q);
  const lag = T.waveSpeed * age - r;
  let wave = 0;
  if (lag > 0) {
    wave = Math.sin(WAVE_K * lag) * Math.exp(-age / T.waveDecay) * Math.exp(-r / T.waveFalloff) * clamp01(lag / T.waveFront);
  }
  return amp * env * (bulge + T.waveShare * wave);
}

/** Upper bound of |rippleDisplacement(r, age, amp)| over every r (decays monotonically after the bulge peak). */
export function rippleBound(age: number, amp: number): number {
  const T = LOCAL_TUNING;
  const env = rippleEnvelope(age);
  if (env === 0) return 0;
  const q = age / T.bulgeRise;
  return Math.abs(amp) * env * (q * Math.exp(1 - q) + T.waveShare * Math.exp(-age / T.waveDecay));
}

/** Pin weight of a net vertex at distance d (m) from the nearest sheet edge: 0 on the edge, 1 from pinDist in. */
export function netPinWeight(d: number): number {
  return smooth01(d / LOCAL_TUNING.pinDist);
}

/** wobbleSway(ages[k], amps[k]) into out[k]: the per-frame form (no double crosses a call boundary). */
function swayCore(ages: Float64Array, amps: Float64Array, out: Float64Array, k: number): void {
  const T = LOCAL_TUNING;
  const age = ages[k]!, amp = amps[k]!;
  if (!(age > 0) || age >= T.wobbleDuration || amp === 0) { out[k] = 0; return; }
  let c = (age - 0.7 * T.wobbleDuration) / (0.3 * T.wobbleDuration);
  c = c < 0 ? 0 : c > 1 ? 1 : c;
  const cut = 1 - c * c * (3 - 2 * c);
  out[k] = amp * Math.sin(WOBBLE_W * age) * Math.exp(-age / T.wobbleDecay) * cut;
}

const WOB_AGE = new Float64Array(1);
const WOB_AMP = new Float64Array(1);
const WOB_OUT = new Float64Array(1);

/** Frame sway at bar height (m) `age` s after a hit of amplitude amp (m): damped sine, exactly 0 after wobbleDuration. */
export function wobbleSway(age: number, amp: number): number {
  WOB_AGE[0] = age;
  WOB_AMP[0] = amp;
  swayCore(WOB_AGE, WOB_AMP, WOB_OUT, 0);
  return WOB_OUT[0]!;
}

/** wobbleAmplitude(bar, io[i]) into io[j]: the per-frame form (no double crosses a call boundary). */
function wobbleAmpCore(bar: number, io: Float64Array, i: number, j: number): void {
  const T = LOCAL_TUNING;
  const sp = io[i]!;
  const g = bar === 1 ? T.wobbleGainBar : T.wobbleGainPost;
  const a = g * (sp > 0 ? sp : 0);
  io[j] = a > T.wobbleMax ? T.wobbleMax : a;
}

const WAMP_IO = new Float64Array(2);

/** Sway amplitude (m) for a POST event: bar = 1 for the crossbar. */
export function wobbleAmplitude(bar: number, impactSpeed: number): number {
  WAMP_IO[0] = impactSpeed;
  wobbleAmpCore(bar, WAMP_IO, 0, 1);
  return WAMP_IO[1]!;
}

/** netRippleAmplitude(io[i]) into io[j]: the per-frame form (no double crosses a call boundary). */
function rippleAmpCore(io: Float64Array, i: number, j: number): void {
  const T = LOCAL_TUNING;
  const speed = io[i]!;
  if (!(speed >= T.netMinSpeed)) { io[j] = 0; return; }
  const a = speed * T.netGain;
  io[j] = a > T.netMaxAmp ? T.netMaxAmp : a;
}

const AMP_IO = new Float64Array(2);

/** Outward ripple amplitude (m) for a ball meeting the net at `speed` m/s (0 below netMinSpeed). */
export function netRippleAmplitude(speed: number): number {
  AMP_IO[0] = speed;
  rippleAmpCore(AMP_IO, 0, 1);
  return AMP_IO[1]!;
}

export interface NetImpact {
  /** Ball centre where it meets the net, projected onto the sheet (m, world). */
  x: number;
  y: number;
  z: number;
  /** Time to the impact along the straight path, s (0 if not moving into a sheet). */
  t: number;
  /** SHEET_* id. */
  sheet: number;
}

/** A fresh NetImpact (preallocate once). */
export function createNetImpact(): NetImpact {
  return { x: 0, y: 0, z: 0, t: 0, sheet: SHEET_BACK };
}

/** predictNetImpact with p = io[0..2], v = io[3..5]: the per-frame form (no double crosses a call boundary). */
function impactCore(end: number, io: Float64Array, out: NetImpact): void {
  const px = io[0]!, py = io[1]!, pz = io[2]!, vx = io[3]!, vy = io[4]!, vz = io[5]!;
  const e = end < 0 ? -1 : 1;
  const u = e * px;
  const du = e * vx;
  let t = INF;
  let sheet = SHEET_BACK;
  if (du > 1e-6) { const tb = (GB - R - u) / du; if (tb < t) { t = tb; sheet = SHEET_BACK; } }
  if (vy > 1e-6) { const tr = (GH - R - py) / vy; if (tr < t) { t = tr; sheet = SHEET_ROOF; } }
  if (vz > 1e-6) { const tp = (GW - R - pz) / vz; if (tp < t) { t = tp; sheet = SHEET_SIDE_POS; } }
  if (vz < -1e-6) { const tn = (-GW + R - pz) / vz; if (tn < t) { t = tn; sheet = SHEET_SIDE_NEG; } }
  if (t >= INF) { t = 0; sheet = SHEET_BACK; }
  if (t < 0) t = 0;
  let cu = u + du * t;
  let cy = py + vy * t;
  let cz = pz + vz * t;
  if (cy < R) cy = R;
  cu = cu < GL ? GL : cu > GB ? GB : cu;
  cy = cy > GH ? GH : cy;
  cz = cz < -GW ? -GW : cz > GW ? GW : cz;
  if (sheet === SHEET_BACK) cu = GB;
  else if (sheet === SHEET_ROOF) cy = GH;
  else cz = sheet === SHEET_SIDE_POS ? GW : -GW;
  out.x = e * cu;
  out.y = cy;
  out.z = cz;
  out.t = t;
  out.sheet = sheet;
}

const IMPACT_IO = new Float64Array(6);

/**
 * Where a ball inside (or entering) the net of `end` at p moving with v meets the net: the first sheet its straight
 * path reaches (the ball surface touching it), projected onto that sheet and clamped into it. A ball that would hit
 * the ground first rolls on (y >= BALL_RADIUS). A ball not moving into any sheet hits the back at its own height.
 * Writes and returns `out`. Pure, no allocation.
 */
export function predictNetImpact(
  end: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, out: NetImpact,
): NetImpact {
  const io = IMPACT_IO;
  io[0] = px; io[1] = py; io[2] = pz; io[3] = vx; io[4] = vy; io[5] = vz;
  impactCore(end, io, out);
  return out;
}

// ============================================================ frame instances

/** Instance matrix storage: float32 for the InstancedMesh, float64 for exact maths (tests, goalFrameMatrices). */
export type MatrixArray = Float32Array | Float64Array;

/**
 * Tube registers / table rows (doubles travel through typed arrays: V8 boxes doubles passed to a call it does not
 * inline, which would allocate every frame). Row layout: A (x, y, z), B (x, y, z), radius, extA, extB, leanA, leanB
 * (x shift of the A / B end per unit of frame lean; 0 for the fixed back frame).
 */
const TUBE_STRIDE = 11;
const TUBE_IO = new Float64Array(TUBE_STRIDE);
/** Current frame lean (x shift per metre of height) for tubeCore. */
const LEAN = new Float64Array(1);

/**
 * Write the matrix of a unit cylinder (radius 1, height 1, centred, along y) for the tube in row `o` of `src` (with
 * the ends shifted by LEAN[0] x leanA / leanB along x) into arr at instance i (column-major, as
 * InstancedMesh.instanceMatrix). Orthogonal columns (no shear), so three.js transforms the normals correctly.
 */
function tubeCore(arr: MatrixArray, i: number, src: Float64Array, o: number): void {
  const lean = LEAN[0]!;
  const ax = src[o]! + lean * src[o + 9]!, ay = src[o + 1]!, az = src[o + 2]!;
  const bx = src[o + 3]! + lean * src[o + 10]!, by = src[o + 4]!, bz = src[o + 5]!;
  const radius = src[o + 6]!, extA = src[o + 7]!, extB = src[o + 8]!;
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l > 1e-9) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 1; dz = 0; }
  // e1 = normalize(d x ref), ref = +z unless d is close to z (then +x); e3 = e1 x d.
  let e1x: number, e1y: number, e1z: number;
  if (dz * dz < 0.81) { e1x = dy; e1y = -dx; e1z = 0; } else { e1x = 0; e1y = dz; e1z = -dy; }
  const el = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
  e1x /= el; e1y /= el; e1z /= el;
  const e3x = e1y * dz - e1z * dy, e3y = e1z * dx - e1x * dz, e3z = e1x * dy - e1y * dx;
  const len = l + extA + extB;
  const shift = (extB - extA) / 2;
  const m = i * 16;
  arr[m] = e1x * radius; arr[m + 1] = e1y * radius; arr[m + 2] = e1z * radius; arr[m + 3] = 0;
  arr[m + 4] = dx * len; arr[m + 5] = dy * len; arr[m + 6] = dz * len; arr[m + 7] = 0;
  arr[m + 8] = e3x * radius; arr[m + 9] = e3y * radius; arr[m + 10] = e3z * radius; arr[m + 11] = 0;
  arr[m + 12] = (ax + bx) / 2 + dx * shift; arr[m + 13] = (ay + by) / 2 + dy * shift; arr[m + 14] = (az + bz) / 2 + dz * shift;
  arr[m + 15] = 1;
}

/**
 * Write the matrix of a unit cylinder (radius 1, height 1, centred, along y) stretched from A to B with `radius` and
 * extended by extA / extB beyond the ends, into arr at instance i (column-major, as InstancedMesh.instanceMatrix).
 * Orthogonal columns (no shear), so three.js transforms the normals correctly.
 */
export function writeTube(
  arr: MatrixArray, i: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  radius: number, extA = 0, extB = 0,
): void {
  const t = TUBE_IO;
  t[0] = ax; t[1] = ay; t[2] = az; t[3] = bx; t[4] = by; t[5] = bz; t[6] = radius; t[7] = extA; t[8] = extB;
  t[9] = 0; t[10] = 0;
  LEAN[0] = 0;
  tubeCore(arr, i, t, 0);
}

/**
 * Rest geometry of every frame tube (FRAME_INSTANCES rows of TUBE_STRIDE), in instance order: [post -z, post +z, bar]
 * for the goal at -x, then the goal at +x (0..5), then 8 support tubes per goal (-x goal 6..13, +x goal 14..21):
 * rear ground bar, two rear uprights, rear top bar, two roof side bars (front end on the bar: leans with the frame),
 * two ground side bars.
 */
const FRAME_TABLE: Float64Array = (() => {
  const t = new Float64Array(FRAME_INSTANCES * TUBE_STRIDE);
  const pr = POST_RADIUS;
  const sr = LOCAL_TUNING.supportRadius;
  const postH = GH + 2 * pr;
  const barY = GH + pr;
  const xAxis = GL - pr;
  const zPost = GW + pr;
  const zSup = GW + sr;
  const uBack = GB + sr;
  const topY = GH + sr;
  const row = (i: number, v: readonly number[]): void => { for (let k = 0; k < TUBE_STRIDE; k++) t[i * TUBE_STRIDE + k] = v[k]!; };
  for (let k = 0; k < 2; k++) {
    const e = k === 0 ? -1 : 1;
    const base = k * 3;
    const xp = e * xAxis;
    // Posts: from the ground to the top of the bar (the top leans with the frame).
    row(base, [xp, 0, -zPost, xp, postH, -zPost, pr, 0, 0, 0, postH]);
    row(base + 1, [xp, 0, zPost, xp, postH, zPost, pr, 0, 0, 0, postH]);
    // Bar: between the outer faces of the posts.
    row(base + 2, [xp, barY, -zPost, xp, barY, zPost, pr, pr, pr, barY, barY]);
    const s = 6 + k * 8;
    const xb = e * uBack;
    const xf = e * xAxis;
    // Rear ground bar, rear uprights, rear top bar.
    row(s, [xb, sr, -zSup, xb, sr, zSup, sr, sr, sr, 0, 0]);
    row(s + 1, [xb, 0, -zSup, xb, topY, -zSup, sr, 0, sr, 0, 0]);
    row(s + 2, [xb, 0, zSup, xb, topY, zSup, sr, 0, sr, 0, 0]);
    row(s + 3, [xb, topY, -zSup, xb, topY, zSup, sr, sr, sr, 0, 0]);
    // Roof side bars (front end on the bar, moves with the sway) and ground side bars.
    row(s + 4, [xf, topY, -zSup, xb, topY, -zSup, sr, 0, 0, topY, 0]);
    row(s + 5, [xf, topY, zSup, xb, topY, zSup, sr, 0, 0, topY, 0]);
    row(s + 6, [xf, sr, -zSup, xb, sr, -zSup, sr, 0, 0, 0, 0]);
    row(s + 7, [xf, sr, zSup, xb, sr, zSup, sr, 0, 0, 0, 0]);
  }
  return t;
})();

/** Goal (0 = -x, 1 = +x) of frame instance i. */
function frameGoal(i: number): number {
  return i < 3 ? 0 : i < 6 ? 1 : i < 14 ? 0 : 1;
}

/** writeGoalFrame with the sways in `sway` ([-x goal, +x goal]); the per-frame form (no double crosses a call). */
function frameCore(arr: MatrixArray, sway: Float64Array): void {
  for (let i = 0; i < FRAME_INSTANCES; i++) {
    const k = frameGoal(i);
    // World x shift per metre of height (rotation about the goal line), + = into the goal.
    LEAN[0] = ((k === 0 ? -1 : 1) * sway[k]!) / GH;
    tubeCore(arr, i, FRAME_TABLE, i * TUBE_STRIDE);
  }
}

const SWAY_IO = new Float64Array(2);

/**
 * All FRAME_INSTANCES frame matrices into arr (16 floats each). Order: [post -z, post +z, bar] for the goal at -x,
 * then the goal at +x (indices 0..5, as goalFrameMatrices), then 8 support tubes per goal (-x goal 6..13, +x goal
 * 14..21). swayNeg / swayPos: frame sway at bar height (m, + = into the goal) for the goal at -x / +x; the frame
 * rotates about the goal line on the ground, so the bar and the front ends of the roof side bars move with it and
 * the rest of the back frame stays put.
 */
export function writeGoalFrame(arr: MatrixArray, swayNeg: number, swayPos: number): void {
  SWAY_IO[0] = swayNeg;
  SWAY_IO[1] = swayPos;
  frameCore(arr, SWAY_IO);
}

/** Instance transforms for the goal frame at rest: [post -z, post +z, bar] for the goal at -x, then the goal at +x. */
export function goalFrameMatrices(): Matrix4[] {
  const arr = new Float64Array(FRAME_INSTANCES * 16);
  writeGoalFrame(arr, 0, 0);
  const out: Matrix4[] = [];
  for (let i = 0; i < 6; i++) out.push(new Matrix4().fromArray(arr, i * 16));
  return out;
}

// ============================================================ net geometry

/** Net sheet grid sizes for a vertex spacing (m): [segments along, segments across] for back, roof, side. */
export function netGridSegments(step: number): { back: [number, number]; roof: [number, number]; side: [number, number] } {
  const n = (len: number): number => Math.max(2, Math.ceil(len / step - 1e-9));
  return {
    back: [n(2 * GW), n(GH)],
    roof: [n(2 * GW), n(GOAL_DEPTH)],
    side: [n(GOAL_DEPTH), n(GH)],
  };
}

/**
 * Both nets in one geometry: per goal a ground shadow quad (first in the index order, aPin = -1, aGrid = -1..1
 * across it), then back, roof and the two sides as vertex grids with `position` (rest), `normal` (outward from the
 * goal box), `aGrid` (metres along the sheet, for the cord pattern) and `aPin` (netPinWeight of the distance to the
 * nearest sheet edge). Built at setup / tier changes only.
 */
export function createNetGeometry(step: number): BufferGeometry {
  const seg = netGridSegments(step);
  const sheetVerts = (s: [number, number]): number => (s[0] + 1) * (s[1] + 1);
  const sheetTris = (s: [number, number]): number => s[0] * s[1] * 2;
  const perGoalV = 4 + sheetVerts(seg.back) + sheetVerts(seg.roof) + 2 * sheetVerts(seg.side);
  const perGoalT = 2 + sheetTris(seg.back) + sheetTris(seg.roof) + 2 * sheetTris(seg.side);
  const nv = 2 * perGoalV;
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const grid = new Float32Array(nv * 2);
  const pin = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(2 * perGoalT * 3) : new Uint16Array(2 * perGoalT * 3);
  let v = 0;
  let t = 0;
  const T = LOCAL_TUNING;

  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, g0: number, g1: number, p: number): void => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
    grid[v * 2] = g0; grid[v * 2 + 1] = g1;
    pin[v] = p;
    v++;
  };
  /** Sheet: origin O, axis A (unit, length la, na segments), axis B (unit, length lb, nb segments), normal N. */
  const sheet = (
    ox: number, oy: number, oz: number, ax: number, ay: number, az: number, la: number, na: number,
    bx: number, by: number, bz: number, lb: number, nb: number, nx: number, ny: number, nz: number,
  ): void => {
    const first = v;
    for (let j = 0; j <= nb; j++) {
      const sb = (lb * j) / nb;
      for (let i = 0; i <= na; i++) {
        const sa = (la * i) / na;
        const d = Math.min(sa, la - sa, sb, lb - sb);
        vert(ox + ax * sa + bx * sb, oy + ay * sa + by * sb, oz + az * sa + bz * sb, nx, ny, nz, sa, sb, netPinWeight(d));
      }
    }
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const a = first + j * (na + 1) + i;
        const b = a + 1;
        const c = a + na + 1;
        const d = c + 1;
        idx[t++] = a; idx[t++] = b; idx[t++] = d;
        idx[t++] = a; idx[t++] = d; idx[t++] = c;
      }
    }
  };

  // Ground shadows first (drawn under the net in the same draw call).
  for (let k = 0; k < 2; k++) {
    const e = k === 0 ? -1 : 1;
    const m = T.shadowMargin;
    const x0 = e * (GL - m * 0.5), x1 = e * (GB + m);
    const first = v;
    vert(x0, T.shadowY, -GW - m, 0, 1, 0, -1, -1, -1);
    vert(x1, T.shadowY, -GW - m, 0, 1, 0, 1, -1, -1);
    vert(x1, T.shadowY, GW + m, 0, 1, 0, 1, 1, -1);
    vert(x0, T.shadowY, GW + m, 0, 1, 0, -1, 1, -1);
    idx[t++] = first; idx[t++] = first + 1; idx[t++] = first + 2;
    idx[t++] = first; idx[t++] = first + 2; idx[t++] = first + 3;
  }
  for (let k = 0; k < 2; k++) {
    const e = k === 0 ? -1 : 1;
    // Back: z from -GW to GW, y up.
    sheet(e * GB, 0, -GW, 0, 0, 1, 2 * GW, seg.back[0], 0, 1, 0, GH, seg.back[1], e, 0, 0);
    // Roof: z from -GW to GW, u from GL to GB.
    sheet(e * GL, GH, -GW, 0, 0, 1, 2 * GW, seg.roof[0], e, 0, 0, GOAL_DEPTH, seg.roof[1], 0, 1, 0);
    // Sides: u from GL to GB, y up.
    sheet(e * GL, 0, GW, e, 0, 0, GOAL_DEPTH, seg.side[0], 0, 1, 0, GH, seg.side[1], 0, 0, 1);
    sheet(e * GL, 0, -GW, e, 0, 0, GOAL_DEPTH, seg.side[0], 0, 1, 0, GH, seg.side[1], 0, 0, -1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
  geo.setAttribute('aGrid', new BufferAttribute(grid, 2));
  geo.setAttribute('aPin', new BufferAttribute(pin, 1));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

// ============================================================ net shader

function f(n: number): string {
  const s = String(n);
  return s.indexOf('.') >= 0 || s.indexOf('e') >= 0 ? s : `${s}.0`;
}

/** Vertex shader: ripple displacement along the normal x pin weight, plus the frame sway near the goal mouth. */
export function netVertexShader(): string {
  const T = LOCAL_TUNING;
  return /* glsl */ `
attribute vec2 aGrid;
attribute float aPin;
uniform vec4 uRip[${RIPPLE_SLOTS}];
uniform vec4 uAmp;
uniform vec2 uSway;
varying vec2 vGrid;
varying float vPin;
varying float vDisp;
varying float vShade;

float ripple(vec3 p, vec4 rip, float amp) {
  float s = rip.w;
  if (amp == 0.0 || s <= 0.0 || s >= ${f(T.rippleDuration)}) return 0.0;
  float r = distance(p, rip.xyz);
  float env = 1.0 - smoothstep(${f(T.rippleFadeStart)}, ${f(T.rippleDuration)}, s);
  float q = s / ${f(T.bulgeRise)};
  float bulge = exp(-(r * r) / ${f(T.bulgeRadius * T.bulgeRadius)}) * q * exp(1.0 - q);
  float lag = ${f(T.waveSpeed)} * s - r;
  float wave = 0.0;
  if (lag > 0.0) {
    wave = sin(${f(WAVE_K)} * lag) * exp(-s / ${f(T.waveDecay)}) * exp(-r / ${f(T.waveFalloff)})
      * clamp(lag / ${f(T.waveFront)}, 0.0, 1.0);
  }
  return amp * env * (bulge + ${f(T.waveShare)} * wave);
}

void main() {
  vec3 p = position;
  float d = 0.0;
  if (aPin > 0.0) {
    d = ripple(p, uRip[0], uAmp.x) + ripple(p, uRip[1], uAmp.y) + ripple(p, uRip[2], uAmp.z) + ripple(p, uRip[3], uAmp.w);
    d *= aPin;
  }
  vec3 q = p + normal * d;
  if (aPin >= 0.0) {
    float e = p.x < 0.0 ? -1.0 : 1.0;
    float front = clamp(1.0 - (abs(p.x) - ${f(GL)}) / ${f(GOAL_DEPTH)}, 0.0, 1.0);
    float sway = e < 0.0 ? uSway.x : uSway.y;
    q.x += e * sway * (p.y / ${f(GH)}) * front;
  }
  vGrid = aGrid;
  vPin = aPin;
  vDisp = d;
  // Fixed per-sheet shade (no lights): roof brightest, sides, then the back, so the box reads in 3D.
  vShade = 0.8 + 0.2 * max(normal.y, 0.0) + 0.1 * abs(normal.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
}
`;
}

/** Fragment shader: anti-aliased cord grid (converges to its mean coverage with distance) or the ground shadow. */
export function netFragmentShader(): string {
  const T = LOCAL_TUNING;
  return /* glsl */ `
uniform vec3 uColour;
varying vec2 vGrid;
varying float vPin;
varying float vDisp;
varying float vShade;

float netCover(vec2 uv, float lw) {
  vec4 dd = vec4(dFdx(uv), dFdy(uv));
  vec2 deriv = max(vec2(length(dd.xz), length(dd.yw)), vec2(1e-5));
  vec2 target = vec2(lw);
  vec2 drawW = clamp(target, deriv, vec2(0.5));
  vec2 aa = deriv * 1.5;
  vec2 g2 = abs(fract(uv + 0.5) - 0.5) * 2.0;
  vec2 g = 1.0 - smoothstep(drawW - aa, drawW + aa, g2);
  g *= clamp(target / drawW, 0.0, 1.0);
  g = mix(g, target, clamp(deriv * 2.0 - 1.0, 0.0, 1.0));
  return mix(g.x, 1.0, g.y);
}

void main() {
  if (vPin < -0.5) {
    vec2 a = abs(vGrid);
    float fade = (1.0 - smoothstep(0.55, 1.0, a.x)) * (1.0 - smoothstep(0.75, 1.0, a.y));
    gl_FragColor = vec4(0.0, 0.0, 0.0, ${f(T.shadowAlpha)} * fade);
  } else {
    float cover = netCover(vGrid * ${f(1 / T.netCell)}, ${f(T.netCord / T.netCell)});
    float alpha = mix(${f(T.netHaze)}, ${f(T.netCordAlpha)}, cover);
    alpha = min(1.0, alpha * (1.0 + ${f(T.netStretchAlpha)} * clamp(abs(vDisp) / ${f(T.stretchRef)}, 0.0, 1.0)));
    gl_FragColor = vec4(uColour * vShade, alpha);
  }
  #include <colorspace_fragment>
}
`;
}

// ============================================================ module

/** Contact-detection state per goal and sheet: 1 while touching (re-armed after separating). */
const SHEETS = 4;

export function createGoals(ctx: RenderContext): GoalsModule {
  const T = LOCAL_TUNING;

  // ---- frame
  const cyl = new CylinderGeometry(1, 1, 1, T.frameSegments, 1);
  const frameMat = new MeshLambertMaterial({ color: 0xffffff });
  const frame = new InstancedMesh(cyl, frameMat, FRAME_INSTANCES);
  const frameArr = frame.instanceMatrix.array as Float32Array;
  writeGoalFrame(frameArr, 0, 0);
  const tmpColour = new Color();
  for (let i = 0; i < FRAME_INSTANCES; i++) {
    tmpColour.setHex(i < 6 ? T.frameColour : T.supportColour);
    frame.setColorAt(i, tmpColour);
  }
  frame.instanceMatrix.needsUpdate = true;
  if (frame.instanceColor) frame.instanceColor.needsUpdate = true;
  frame.computeBoundingSphere();
  frame.frustumCulled = false; // both goals, a few cm of sway
  frame.name = 'goal-frames';
  // [QF-7R] Its own shadow depth material (instanced with per-instance colour): sharing three.js's default with the
  // players (instanced, no colour) and the ball (not instanced) re-derived the depth program three times per frame.
  const frameDepth = new MeshDepthMaterial();
  frame.customDepthMaterial = frameDepth;
  frame.visible = false;

  // ---- net
  const uRip: Vector4[] = [];
  for (let i = 0; i < RIPPLE_SLOTS; i++) uRip.push(new Vector4(0, 0, 0, 0));
  const uniforms: NetUniforms = {
    uRip: { value: uRip },
    uAmp: { value: new Vector4(0, 0, 0, 0) },
    uSway: { value: new Vector2(0, 0) },
    uColour: { value: new Color(T.netColourDay) },
  };
  const netMat = new ShaderMaterial({
    name: 'goal-net',
    uniforms,
    vertexShader: netVertexShader(),
    fragmentShader: netFragmentShader(),
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  let netDetail = detailFor(ctx.tier);
  let netGeo = createNetGeometry(T.netStep[netDetail]!);
  const net = new Mesh(netGeo, netMat);
  net.name = 'goal-nets';
  net.renderOrder = 2;
  net.frustumCulled = false; // both goals in one mesh; the vertex shader moves vertices
  net.visible = false;

  ctx.scene.add(frame);
  ctx.scene.add(net);

  // ---- state (preallocated)
  /** Ripple slots: x, y, z, age (s), amp (m) per slot. */
  const rip = new Float64Array(RIPPLE_SLOTS * 5);
  /** Wobble per goal (k = 0 for -x): age (s), amplitude (m). */
  const wobAge = new Float64Array(2);
  const wobAmp = new Float64Array(2);
  const sway = new Float64Array(2);
  let frameDirty = false;
  /** Time of the last entry per goal (s), -INF = none. */
  const lastEntry = new Float64Array(2);
  /** Contact state per goal and sheet: touching flag and last contact time. */
  const touching = new Uint8Array(2 * SHEETS);
  const lastContact = new Float64Array(2 * SHEETS);
  /**
   * Per-frame doubles: module time (s), last interpolated ball centre, last apparent ball velocity. In a typed array
   * because a closure variable holding a double is boxed again on every assignment (per-frame garbage).
   */
  const V = new Float64Array(7);
  const V_TIME = 0, V_LX = 1, V_LY = 2, V_LZ = 3, V_PVX = 4, V_PVY = 5, V_PVZ = 6;
  let hasLast = false;
  /**
   * Call registers (doubles never cross a call boundary; V8 boxes them at a call it does not inline):
   * D: detect() ball centre and apparent velocity. E: entry() ball p (0..2), v (3..5), speed (6); amplitude scratch
   * (7). Q: addRipple() centre (0..2), signed amplitude (3), delay (4). H: postHit() speed (0), point (1..3), amplitude scratch (4).
   */
  const D = new Float64Array(6);
  const E = new Float64Array(8);
  const Q = new Float64Array(5);
  const H = new Float64Array(5);
  const impact = createNetImpact();
  // Debug close-up.
  let closeEnd = 0;
  let closeAngle: number = T.closeUpAngleDeg;
  let closeDist: number = T.closeUpDist;
  let closeEyeY: number = T.closeUpEyeY;
  const camTarget = new Vector3();

  function detailFor(tier: QualityTier): number {
    const d = getTierParams(tier).netDetail;
    return d <= 0 ? 0 : d >= 2 ? 2 : 1;
  }

  function resetState(): void {
    rip.fill(0);
    wobAge.fill(0);
    wobAmp.fill(0);
    sway.fill(0);
    lastEntry.fill(-INF);
    touching.fill(0);
    lastContact.fill(-INF);
    V.fill(0);
    hasLast = false;
    frameCore(frameArr, sway);
    frame.instanceMatrix.needsUpdate = true;
    frameDirty = false;
    writeUniforms();
  }

  function writeUniforms(): void {
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      const o = i * 5;
      const u = uRip[i]!;
      u.x = rip[o]!; u.y = rip[o + 1]!; u.z = rip[o + 2]!; u.w = rip[o + 3]!;
    }
    const amp = uniforms.uAmp.value;
    amp.x = rip[4]!; amp.y = rip[9]!; amp.z = rip[14]!; amp.w = rip[19]!;
    const sw = uniforms.uSway.value;
    sw.x = sway[0]!; sw.y = sway[1]!;
  }

  /** Start a ripple at Q (centre, signed amplitude, delay s). Replaces a free or the oldest slot. */
  function addRipple(): void {
    const x = Q[0]!, y = Q[1]!, z = Q[2]!, amp = Q[3]!, delay = Q[4]!;
    if (amp === 0 || !(x - x === 0 && y - y === 0 && z - z === 0 && amp - amp === 0 && delay - delay === 0)) return;
    let slot = -1;
    let oldest = -INF;
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      const o = i * 5;
      if (rip[o + 4] === 0) { slot = i; break; }
      if (rip[o + 3]! > oldest) { oldest = rip[o + 3]!; slot = i; }
    }
    const o = slot * 5;
    rip[o] = x; rip[o + 1] = y; rip[o + 2] = z; rip[o + 3] = delay > 0 ? -delay : 0; rip[o + 4] = amp;
  }

  /** The ball entered the net of `end` (E: position, velocity, speed in m/s). */
  function entry(end: number): void {
    const k = end < 0 ? 0 : 1;
    lastEntry[k] = V[V_TIME]!;
    rippleAmpCore(E, 6, 7);
    if (E[7] === 0) return;
    impactCore(end, E, impact);
    Q[0] = impact.x; Q[1] = impact.y; Q[2] = impact.z; Q[3] = E[7]!;
    Q[4] = impact.t < T.impactDelayMax ? impact.t : T.impactDelayMax;
    addRipple();
  }

  /** POST event on the goal of `end` (bar = 1 for the crossbar; H: impact speed, hit point). */
  function postHit(end: number, bar: number): void {
    const k = end < 0 ? 0 : 1;
    const speed = H[0]!;
    wobbleAmpCore(bar, H, 0, 4);
    const a = H[4]!;
    // A new hit restarts the shake unless the current one is still stronger.
    const remaining = wobAmp[k]! * Math.exp(-wobAge[k]! / T.wobbleDecay) * (wobAge[k]! < T.wobbleDuration ? 1 : 0);
    if (a > remaining) { wobAge[k] = 0; wobAmp[k] = a; }
    let ra = speed * T.postRippleGain;
    if (ra > T.postRippleMax) ra = T.postRippleMax;
    if (ra > 0) {
      Q[0] = H[1]!; Q[1] = H[2]!; Q[2] = H[3]!; Q[3] = ra; Q[4] = 0;
      addRipple();
    }
  }

  /** Interpolated-ball detection from the D registers (ball, apparent velocity): entries (replays), sheet contacts. */
  function detect(): void {
    const bx = D[0]!, by = D[1]!, bz = D[2]!, vx = D[3]!, vy = D[4]!, vz = D[5]!;
    const time = V[V_TIME]!, pvx = V[V_PVX]!, pvy = V[V_PVY]!, pvz = V[V_PVZ]!;
    const slop = T.contactSlop;
    const near = R + slop;
    for (let k = 0; k < 2; k++) {
      const e = k === 0 ? -1 : 1;
      const u = e * bx;
      if (u < GL - 1 || u > GB + 1 || bz > GW + 1 || bz < -GW - 1 || by > GH + 1) {
        for (let s = 0; s < SHEETS; s++) touching[k * SHEETS + s] = 0;
        continue;
      }
      const inside = u > GL && u < GB && by < GH && bz < GW && bz > -GW;
      // Entry into the net volume (whole ball over the line, inside the mouth).
      const u0 = e * V[V_LX]!;
      if (u0 <= NET_FRONT && u > NET_FRONT && inside && time - lastEntry[k]! >= T.entryWindow) {
        E[0] = bx; E[1] = by; E[2] = bz; E[3] = vx; E[4] = vy; E[5] = vz; E[6] = Math.sqrt(vx * vx + vy * vy + vz * vz);
        entry(e);
      }
      const inEntry = time - lastEntry[k]! < T.entryWindow;
      const du = e * vx;
      const pdu = e * pvx;
      for (let s = 0; s < SHEETS; s++) {
        // Signed distance outward from the sheet, whether the ball faces the sheet, normal velocity (outward).
        let d: number, inRect: boolean, vn: number, pvn: number, cx: number, cy: number, cz: number;
        if (s === SHEET_BACK) {
          d = u - GB; inRect = bz >= -GW && bz <= GW && by <= GH; vn = du; pvn = pdu;
          cx = e * GB; cy = by; cz = bz;
        } else if (s === SHEET_ROOF) {
          d = by - GH; inRect = u >= GL && u <= GB && bz >= -GW && bz <= GW; vn = vy; pvn = pvy;
          cx = bx; cy = GH; cz = bz;
        } else if (s === SHEET_SIDE_POS) {
          d = bz - GW; inRect = u >= GL && u <= GB && by <= GH; vn = vz; pvn = pvz;
          cx = bx; cy = by; cz = GW;
        } else {
          d = -GW - bz; inRect = u >= GL && u <= GB && by <= GH; vn = -vz; pvn = -pvz;
          cx = bx; cy = by; cz = -GW;
        }
        const ti = k * SHEETS + s;
        const ad = d < 0 ? -d : d;
        if (!inRect || ad > near + slop) { touching[ti] = 0; continue; }
        if (touching[ti] === 1 || ad > near) continue;
        touching[ti] = 1;
        const fromInside = d < 0;
        if (fromInside && inEntry) continue; // the entry ripple stands for this impact
        if (time - lastContact[ti]! < T.contactCooldown) continue;
        // Approach speed toward the sheet (this frame or the one before: the bounce may already be in).
        let ap = fromInside ? vn : -vn;
        const pap = fromInside ? pvn : -pvn;
        if (pap > ap) ap = pap;
        E[6] = ap;
        rippleAmpCore(E, 6, 7);
        const amp = E[7]!;
        if (amp === 0) continue;
        lastContact[ti] = time;
        cy = cy < 0 ? 0 : cy > GH ? GH : cy;
        cz = cz < -GW ? -GW : cz > GW ? GW : cz;
        Q[0] = cx; Q[1] = cy; Q[2] = cz; Q[3] = fromInside ? amp : -amp; Q[4] = 0;
        addRipple();
      }
    }
  }

  function applyCloseUp(): void {
    if (closeEnd === 0) return;
    const e = closeEnd;
    const a = (closeAngle * Math.PI) / 180;
    // Looking into the goal from the pitch side, turned by the angle toward +z (the broadcast side).
    const tx = e * (GL + GOAL_DEPTH * 0.4);
    const cam = ctx.camera;
    cam.position.set(tx - e * Math.cos(a) * closeDist, closeEyeY, Math.sin(a) * closeDist);
    camTarget.set(tx, T.closeUpLookY, 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(camTarget);
    cam.updateMatrixWorld(true);
    if (cam.fov !== T.closeUpFovDeg) {
      // Debug only. The cameras rewrite the FOV every frame it differs from theirs, so this never sticks.
      cam.fov = T.closeUpFovDeg;
      cam.updateProjectionMatrix();
    }
  }

  const debug: GoalsDebug = {
    closeUp(end: number, angleDeg?: number, dist?: number, eyeY?: number): void {
      closeEnd = end < 0 ? -1 : end > 0 ? 1 : 0;
      closeAngle = angleDeg ?? T.closeUpAngleDeg;
      closeDist = dist !== undefined && dist > 1 ? dist : T.closeUpDist;
      closeEyeY = eyeY ?? T.closeUpEyeY;
    },
    snapshot(): GoalsSnapshot {
      const ripples: GoalsSnapshot['ripples'] = [];
      for (let i = 0; i < RIPPLE_SLOTS; i++) {
        const o = i * 5;
        if (rip[o + 4] !== 0) ripples.push({ x: rip[o]!, y: rip[o + 1]!, z: rip[o + 2]!, age: rip[o + 3]!, amp: rip[o + 4]! });
      }
      const idx = netGeo.getIndex();
      return {
        time: V[V_TIME]!,
        ripples,
        sway: [sway[0]!, sway[1]!],
        netDetail,
        netVertices: netGeo.getAttribute('position').count,
        netTriangles: idx ? idx.count / 3 : 0,
        frameInstances: frame.count,
        drawCalls: (frame.visible ? 1 : 0) + (net.visible ? 1 : 0),
      };
    },
  };
  if (typeof window !== 'undefined') window.__dotkickGoals = debug;

  function applyLook(): void {
    uniforms.uColour.value.setHex(ctx.night ? T.netColourNight : T.netColourDay);
    frame.castShadow = getTierParams(ctx.tier).shadowMap;
  }

  resetState();
  applyLook();

  const mod: GoalsModule = {
    frame,
    net,
    uniforms,
    debug,
    setMatch(_state: ReadonlySimState) {
      resetState();
      applyLook();
      frame.visible = true;
      net.visible = true;
    },

    update(fr: RenderFrame) {
      let dt = fr.frame.paused ? 0 : fr.frame.dtMs / 1000;
      if (!(dt > 0)) dt = 0;
      else if (dt > 0.25) dt = 0.25;
      const it = fr.interp;
      const bx = it.ballX, by = it.ballY, bz = it.ballZ;
      if (dt > 0) {
        V[V_TIME] = V[V_TIME]! + dt;
        // Ripples age; finished ones free their slot.
        for (let i = 0; i < RIPPLE_SLOTS; i++) {
          const o = i * 5;
          if (rip[o + 4] === 0) continue;
          const age = rip[o + 3]! + dt;
          if (age >= T.rippleDuration) { rip[o + 3] = 0; rip[o + 4] = 0; } else rip[o + 3] = age;
        }
        for (let k = 0; k < 2; k++) {
          if (wobAmp[k] === 0) continue;
          const age = wobAge[k]! + dt;
          if (age >= T.wobbleDuration) { wobAge[k] = 0; wobAmp[k] = 0; sway[k] = 0; } else {
            wobAge[k] = age;
            // swayCore(wobAge, wobAmp, sway, k) written out [QF-7R]: a wobble is rare, so a helper never leaves V8's
            // baseline tier and boxes every double it computes (garbage every wobbling frame).
            const amp = wobAmp[k]!;
            if (!(age > 0) || amp === 0) sway[k] = 0;
            else {
              let c = (age - 0.7 * T.wobbleDuration) / (0.3 * T.wobbleDuration);
              c = c < 0 ? 0 : c > 1 ? 1 : c;
              const cut = 1 - c * c * (3 - 2 * c);
              sway[k] = amp * Math.sin(WOBBLE_W * age) * Math.exp(-age / T.wobbleDecay) * cut;
            }
          }
          frameDirty = true;
        }
        if (Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz)) {
          if (hasLast) {
            const vx = (bx - V[V_LX]!) / dt, vy = (by - V[V_LY]!) / dt, vz = (bz - V[V_LZ]!) / dt;
            const sp2 = vx * vx + vy * vy + vz * vz;
            if (sp2 <= T.teleportSpeed * T.teleportSpeed) {
              D[0] = bx; D[1] = by; D[2] = bz; D[3] = vx; D[4] = vy; D[5] = vz;
              detect();
              V[V_PVX] = vx; V[V_PVY] = vy; V[V_PVZ] = vz;
            } else {
              V[V_PVX] = 0; V[V_PVY] = 0; V[V_PVZ] = 0;
              touching.fill(0);
            }
          }
          V[V_LX] = bx; V[V_LY] = by; V[V_LZ] = bz;
          hasLast = true;
        }
      }
      if (frameDirty) {
        frameCore(frameArr, sway);
        frame.instanceMatrix.needsUpdate = true;
        frameDirty = false;
      }
      writeUniforms();
      if (closeEnd !== 0) applyCloseUp();
    },

    onEvents(events: EventBuffer, state: ReadonlySimState) {
      for (let i = 0; i < events.count; i++) {
        const ev = events.get(i);
        if (ev.type === EventType.NET) {
          const end = ev.a < 0 ? -1 : 1;
          const k = end < 0 ? 0 : 1;
          if (V[V_TIME]! - lastEntry[k]! < T.entryWindow && lastEntry[k]! > -INF) continue;
          const b = state.ball;
          E[0] = ev.x; E[1] = ev.y; E[2] = ev.z; E[3] = b.vx; E[4] = b.vy; E[5] = b.vz; E[6] = ev.c;
          entry(end);
        } else if (ev.type === EventType.POST) {
          H[0] = ev.c; H[1] = ev.x; H[2] = ev.y; H[3] = ev.z;
          postHit(ev.a < 0 ? -1 : 1, ev.b);
        }
      }
    },

    warmUp() {
      // Programs compile with the scene (index.ts); nothing to upload (the net pattern is procedural).
      // [QF-7R] The event-time paths (a ball entering a net: impact prediction, ripple; a post or bar hit: wobble, the
      // frame matrices; contacts with every sheet) run a few times a match, so V8 would leave them unoptimised: the first
      // goal or post hit then hitches and boxes every double it computes (measured: kilobytes of garbage per goal).
      // Run them through the real update() and the event handlers here, off screen while loading (a few ms), then
      // clear: shots into both nets from a spread of heights and angles, each with a post / bar hit.
      const wasFrame = frame.visible, wasNet = net.visible;
      const it = createInterpState();
      const fr: RenderFrame = {
        prev: null as unknown as ReadonlySimState, curr: null as unknown as ReadonlySimState, alpha: 1,
        frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: it,
      };
      for (let i = 0; i < T.warmUpFrames; i++) {
        const k = i % 60;
        const shot = (i / 60) | 0;
        const end = (shot & 1) === 0 ? 1 : -1;
        // 40 frames of flight from 20 m out into the net (back, roof or a side sheet), then 20 still frames.
        const u = k < 40 ? k / 40 : 1;
        it.ballX = end * (GL - 20 + (20 + GOAL_DEPTH * 0.9) * u);
        it.ballY = R + (0.2 + (shot % 5) * 0.45) * u;
        it.ballZ = (((shot % 7) - 3) * 0.9) * u;
        if (k === 0) hasLast = false; // a new shot: a teleport, no contact from the last one
        if (k === 20) {
          H[0] = 12.5 + (shot % 4); H[1] = end * GL; H[2] = (shot & 2) === 0 ? GH : 1.25; H[3] = (shot & 2) === 0 ? 0.5 : GW;
          postHit(end, (shot & 2) === 0 ? 1 : 0);
        }
        fr.frame.frame = i;
        mod.update(fr);
      }
      // NET events (entry from the event) and post / bar hits directly, as often as a JIT tier-up needs.
      for (let i = 0; i < T.warmUpFrames; i++) {
        const end = (i & 1) === 0 ? 1 : -1;
        const k = end < 0 ? 0 : 1;
        lastEntry[k] = -INF;
        // Every branch of the impact prediction: moving into the back / roof / either side or into none, already past
        // a sheet, below the ball radius, clamped at each edge (a branch first met in play would deoptimise it).
        E[0] = end * (GL + (i % 13) * 0.21); E[1] = 0.05 + (i % 6) * 0.5; E[2] = ((i % 9) - 4) * 0.95;
        E[3] = end * ((i % 4) === 3 ? -2.5 : (i % 4) === 2 ? 0 : 12.5 + (i % 11));
        E[4] = ((i % 5) - 2) * 1.5; E[5] = (i % 7) - 3; E[6] = 14.5 + (i % 11);
        entry(end);
        H[0] = 8.5 + (i % 13); H[1] = end * GL; H[2] = (i & 2) === 0 ? GH : 0.75 + (i % 4) * 0.4; H[3] = (i & 2) === 0 ? 1.5 : GW;
        postHit(end, (i & 2) === 0 ? 1 : 0);
        V[V_TIME] = V[V_TIME]! + 1 / 60;
      }
      resetState();
      frame.visible = wasFrame;
      net.visible = wasNet;
    },

    setQuality(tier: QualityTier) {
      frame.castShadow = getTierParams(tier).shadowMap;
      const d = detailFor(tier);
      if (d === netDetail) return;
      netDetail = d;
      const old = netGeo;
      netGeo = createNetGeometry(T.netStep[d]!);
      net.geometry = netGeo;
      old.dispose();
    },

    clearMatch() {
      frame.visible = false;
      net.visible = false;
      closeEnd = 0;
      resetState();
    },

    dispose() {
      ctx.scene.remove(frame);
      ctx.scene.remove(net);
      cyl.dispose(); frameMat.dispose(); frame.dispose(); frameDepth.dispose();
      netGeo.dispose(); netMat.dispose();
      if (typeof window !== 'undefined' && window.__dotkickGoals === debug) delete window.__dotkickGoals;
    },
  };
  return mod;
}

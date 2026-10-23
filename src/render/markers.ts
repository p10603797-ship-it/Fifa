/**
 * [GFX-13] On-pitch aids (section 8 "Look"): a marker above each controlled player (one colour per human: P1 ember
 * #FF6B35, P2 cyan #35D0FF), a ring under the intended receiver, a faint marker on the next switch target
 * (ctrl.nextSwitch), a landing marker for high balls, edge-of-screen arrows for an off-screen ball, a power bar near
 * the controlled player while a kick charges, and colour-blind-safe variants (settings.accessibility
 * .colourBlindMarkers; section 12: shapes, not only colours).
 *
 * WHAT IS DRAWN (planAids decides from the sim state; nothing here feeds back)
 * - Overhead marker per human: P1 an ember chevron (a notched arrowhead pointing down at the head), P2 a cyan
 *   diamond. The shapes always differ; colour-blind mode adds "1" / "2" labels beside them and draws P2's ground
 *   ring dashed. Billboards facing the camera, ~0.8 m wide, clamped to 20..40 CSS px on screen, with an
 *   ink drop shadow for contrast over any kit / grass / crowd.
 * - Ground ring under each controlled player (human colour).
 * - Receiver ring (ball.passTarget while our pass is loose and our team touched last, for sides with a human): a
 *   larger ring with four outward ticks in the passing human's colour, gently pulsing. Never on a sent-off slot.
 * - Next switch target (ctrl.nextSwitch): the human's shape, smaller and faint, above that player's head.
 * - Power bar (ctrl.powerBtn != 0): a framed bar under the controlled player's feet filled to ctrl.power; hidden the
 *   moment the button is released (powerBtn = 0), so it can never stick full.
 * - Landing marker for high balls: SIM-01 predictBall on the loose ball (read-only; it copies the ball into its own
 *   scratch) gives the landing sample (landIndex) and the apex; a white target (ring + dot + four ticks) shows while
 *   the predicted apex is >= LOCAL_TUNING.highBallApex and the ball has not landed; it shrinks as the landing nears.
 *   Prediction runs only when the flight changes (kick, touch, bounce, phase, rewind, or the ball strays from the
 *   predicted path), not per frame. Shots in flight get no marker.
 * - Off-screen ball arrow: when the ball centre projects outside the viewport (or behind the camera) the arrow sits
 *   on the screen edge (inset), points toward the ball, and stays above the touch-control zones on the bottom edge
 *   (GFX-14 touchZones). A white arrow (with a small ball behind it) inside a round ink badge, so it reads over the
 *   crowd, boards, sky or grass. Drawn in the 3D overlay (no DOM), constant ~30 CSS px.
 * Aids show in play and restart phases (aidsActive); not in goal, celebration, replay or breaks.
 *
 * DRAW CALLS: 2 — one depth-tested ground batch (rings, landing target) and one always-on-top overlay batch (overhead
 * markers, labels, power bars, arrow); both double-sided in a single pass (forceSinglePass: three.js would otherwise
 * draw a transparent double-sided mesh twice). Both are QuadBatch meshes: preallocated vertex buffers rewritten each frame
 * (positions + RGBA vertex colours, static quad index buffer), unlit, hidden when empty. No allocation in update().
 */

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Mesh, MeshBasicMaterial, Sphere, Vector3,
} from 'three';
import { MAX_HUMANS, NUM_SLOTS, TICK_HZ } from '../contracts/constants';
import { ControllerKind, MatchPhase } from '../contracts/enums';
import type { ReadonlySimState } from '../contracts/state';
import { createBallPrediction, MAX_PREDICT_TICKS, type BallPrediction } from '../contracts/systems';
import { predictBall } from '../sim/ball/flight';
import { touchZones, type TouchZones } from './camera/broadcast';
import { drawnOffsetsOf } from './players/drawn';
import type { InterpState, RenderContext, RenderFrame, RenderModule } from './types';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: GFX-13 on-pitch aids, render only)
  /** Ground decal height above the grass (m), above the blob shadows (0.02). */
  groundY: 0.03,
  /** Controlled-player ring radii (m). */
  ringInner: 0.62,
  ringOuter: 0.8,
  /** Colour-blind P2 ring: eight dashes (robust at broadcast distance, unlike thin double bands), radii (m). */
  dashInner: 0.6,
  dashOuter: 0.84,
  /** Ground ring opacity (0..1). */
  ringAlpha: 0.9,
  /** Receiver ring radii (m), outward tick length (m) and half width (m), opacity. */
  receiverInner: 0.9,
  receiverOuter: 1.05,
  receiverTick: 0.2,
  receiverTickHalfW: 0.05,
  receiverAlpha: 0.85,
  /** Receiver ring pulse: amplitude (fraction of the radius) and rate (Hz). */
  receiverPulse: 0.07,
  receiverPulseHz: 1.6,
  /** Landing target: ring radius long before landing and at landing (m), ring width (m), shrink lead time (s). */
  landRadiusFar: 1.7,
  landRadiusNear: 0.7,
  landWidth: 0.16,
  landShrinkS: 1.2,
  /** Landing target centre dot radius (m), outward tick length (m) and half width (m), opacity. */
  landDot: 0.15,
  landTick: 0.32,
  landTickHalfW: 0.045,
  landAlpha: 0.88,
  /** Opacity of the dark under-ring that keeps the white target readable on light stripes and lines. */
  landOutlineAlpha: 0.35,
  /** High ball: a loose ball whose predicted apex (ball-centre height, m) reaches this gets a landing marker. */
  highBallApex: 2.0,
  /** The ball must be at least this high (m), or rising faster than airMinVy (m/s), to look for a landing. */
  airMinY: 0.3,
  airMinVy: 0.5,
  /** Prediction horizon (ticks, <= MAX_PREDICT_TICKS = 3 s). */
  predictTicks: 180,
  /** Re-predict this often (ticks) while no landing was found within the horizon. */
  predictRefreshTicks: 20,
  /** Re-predict when the ball strays this far (m) from the predicted path. */
  predictTolerance: 0.3,
  /** Overhead marker: preferred width (m) and on-screen clamp (CSS px). */
  markerWorld: 0.8,
  markerMinPx: 20,
  markerMaxPx: 40,
  /** Next-switch marker: size relative to the human's marker, opacity. */
  switchScale: 0.75,
  switchAlpha: 0.6,
  /** Colour-blind label: glyph scale (marker units) and offset right of the marker (marker units). */
  labelScale: 1.25,
  labelOffsetU: 0.56,
  labelOffsetV: 0.1,
  /** Power bar (marker units): width, height, frame border, drop below the feet. */
  barW: 1.5,
  barH: 0.22,
  barBorder: 0.06,
  barDrop: 1.15,
  /** Off-screen arrow size (CSS px) and inset of its centre from the screen edges (CSS px). */
  arrowPx: 30,
  arrowInset: 30,
  /** Opacity of the ink badge behind the off-screen arrow (reads over crowd, boards, sky or grass). */
  arrowBadgeAlpha: 0.72,
  /**
   * [QF-7R skeptic] Loading-screen passes through the off-screen ball arrow (edge maths, lift above the touch zones,
   * draw): past V8's ~400-call optimisation threshold (render/warmScript.ts WARM_TUNING.poseCalls is the same idea).
   */
  arrowWarmCalls: 450,
  /** View depth (m) at which screen-space overlays are placed (in front of the near plane). */
  overlayDepth: 10,
  /** Drop shadow offset (CSS px) and opacity of overlay shapes. */
  shadowPx: 2,
  shadowAlpha: 0.55,
} as const;
export const MARKER_TUNING = LOCAL_TUNING;

/** Human marker colours, indexed by human (0 = P1 ember, 1 = P2 cyan). */
export const HUMAN_COLOURS: readonly number[] = [0xff6b35, 0x35d0ff];
/** Overhead marker tip height above the grass for a 180 cm player (m); scales with height. */
export const MARKER_Y = 2.25;

/** Overhead marker shapes. */
export const MarkerShape = { CHEVRON: 0, DIAMOND: 1 } as const;
/** Shape per human: P1 chevron, P2 diamond (shapes, not only colours: section 12). */
export const HUMAN_SHAPES: readonly number[] = [MarkerShape.CHEVRON, MarkerShape.DIAMOND];

// ============================================================ plan (pure, testable without WebGL)

/** Phases that show on-pitch aids: play and restart phases (not goal, celebration, replay, breaks, pre/post match). */
export function aidsActive(phase: MatchPhase): boolean {
  return phase === MatchPhase.IN_PLAY || phase === MatchPhase.KICK_OFF || phase === MatchPhase.THROW_IN
    || phase === MatchPhase.GOAL_KICK || phase === MatchPhase.CORNER || phase === MatchPhase.FREE_KICK
    || phase === MatchPhase.PENALTY || phase === MatchPhase.SHOOT_OUT;
}

export interface HumanAid {
  /** Controlled slot (on the pitch), -1 = no marker. */
  slot: number;
  /** Faint next-switch target, -1 = none. */
  next: number;
  /** Power bar fill 0..1 while a button charges, -1 = hidden. */
  power: number;
}

export interface AidPlan {
  /** The phase shows aids. */
  active: boolean;
  /** Per human (MAX_HUMANS). */
  humans: HumanAid[];
  /** Receiver ring slot, -1 = none. */
  receiver: number;
  /** Human whose colour the receiver ring takes (-1 when none). */
  receiverHuman: number;
}

export function createAidPlan(): AidPlan {
  const humans: HumanAid[] = [];
  for (let h = 0; h < MAX_HUMANS; h++) humans.push({ slot: -1, next: -1, power: -1 });
  return { active: false, humans, receiver: -1, receiverHuman: -1 };
}

/** A whole-number slot on the pitch (active, so never a sent-off or substituted-out slot). */
function onPitch(s: ReadonlySimState, slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && Math.floor(slot) === slot && s.players[slot]!.active === 1;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0; // NaN -> 0
}

/**
 * Decide which aids show for state `s` (no allocation). Humans are ctrl[0..MAX_HUMANS) of kind HUMAN; markers only
 * on active slots; the faint next-switch marker only on an active teammate who is neither the controlled player nor
 * the other human's; the power bar only while ctrl.powerBtn != 0; the receiver ring only while the pass is loose,
 * our team touched last and a human plays that side (colour: the human whose ctrl.receiver is the target, else the
 * first human on the side).
 */
export function planAids(s: ReadonlySimState, out: AidPlan): AidPlan {
  out.active = aidsActive(s.match.phase);
  out.receiver = -1;
  out.receiverHuman = -1;
  for (let h = 0; h < MAX_HUMANS; h++) {
    const a = out.humans[h]!;
    a.slot = -1; a.next = -1; a.power = -1;
    const c = s.ctrl[h];
    if (!out.active || !c || c.kind !== ControllerKind.HUMAN || !onPitch(s, c.slot)) continue;
    a.slot = c.slot;
    if (c.powerBtn !== 0) a.power = clamp01(c.power);
    const nx = c.nextSwitch;
    if (nx !== c.slot && onPitch(s, nx) && s.players[nx]!.team === s.players[c.slot]!.team) a.next = nx;
  }
  if (!out.active) return out;
  for (let h = 0; h < MAX_HUMANS; h++) {
    const a = out.humans[h]!;
    if (a.next < 0) continue;
    for (let o = 0; o < MAX_HUMANS; o++) if (o !== h && out.humans[o]!.slot === a.next) a.next = -1;
  }
  const b = s.ball;
  const t = b.passTarget;
  if (b.owner < 0 && b.heldBy < 0 && b.inNet === 0 && onPitch(s, t)) {
    const team = s.players[t]!.team;
    if (b.lastTouchTeam === team) {
      let hum = -1;
      for (let h = 0; h < MAX_HUMANS; h++) {
        const c = s.ctrl[h];
        if (!c || c.kind !== ControllerKind.HUMAN) continue;
        const side = c.side === 0 || c.side === 1 ? c.side : onPitch(s, c.slot) ? s.players[c.slot]!.team : -1;
        if (side !== team) continue;
        if (hum < 0 || c.receiver === t) hum = h;
      }
      if (hum >= 0) { out.receiver = t; out.receiverHuman = hum; }
    }
  }
  return out;
}

// ============================================================ landing marker (SIM-01 predictBall, read-only)

export interface LandingTracker {
  /** A high-ball landing marker shows this frame. */
  show: boolean;
  /** Predicted landing point (m) and the tick the ball gets there (sample landIndex). */
  x: number;
  z: number;
  landTick: number;
  /** Predicted apex of the flight (ball-centre height, m). */
  apex: number;
  /** Target ring radius drawn last frame (m; landingRadius of the seconds left). */
  radius: number;
  /** Prediction cache. */
  readonly pred: BallPrediction;
  valid: boolean;
  found: boolean;
  fromTick: number;
  kick: number;
  touched: number;
  bounces: number;
  phase: number;
  /** Ball position and velocity the prediction started from (a rewrite within the same tick re-predicts). */
  x0: number;
  y0: number;
  z0: number;
  vx0: number;
  vy0: number;
  vz0: number;
  /** predictBall calls made (diagnostics, tests). */
  predictions: number;
}

export function createLandingTracker(): LandingTracker {
  return {
    show: false, x: 0, z: 0, landTick: -1, apex: 0, radius: 0, pred: createBallPrediction(), valid: false, found: false,
    fromTick: -1, kick: -1, touched: -1, bounces: -1, phase: -1, x0: 0, y0: 0, z0: 0, vx0: 0, vy0: 0, vz0: 0,
    predictions: 0,
  };
}

export function resetLandingTracker(t: LandingTracker): void {
  t.show = false;
  t.valid = false;
  t.found = false;
}

const PREDICT_TICKS = LOCAL_TUNING.predictTicks < MAX_PREDICT_TICKS ? LOCAL_TUNING.predictTicks : MAX_PREDICT_TICKS;

/**
 * Update the landing marker for state `s`. A loose (no owner, not in hands, not in the net), airborne ball that is
 * not a shot is predicted with SIM-01 predictBall (the sim's own physics, bit for bit); the marker shows at sample
 * landIndex while the predicted apex is high (>= highBallApex) and the landing tick is still ahead. Re-predicts
 * only when the flight changes. Returns t.show.
 */
export function updateLanding(t: LandingTracker, s: ReadonlySimState): boolean {
  const b = s.ball;
  const tick = s.tick;
  const eligible = aidsActive(s.match.phase) && b.owner < 0 && b.heldBy < 0 && b.inNet === 0 && b.shotBy < 0
    && (b.y >= LOCAL_TUNING.airMinY || b.vy > LOCAL_TUNING.airMinVy);
  if (!eligible) {
    t.show = false;
    t.valid = false;
    return false;
  }
  const p = t.pred;
  let need = !t.valid || tick < t.fromTick || b.lastKickTick !== t.kick || b.touchedTick !== t.touched
    || b.bounces !== t.bounces || s.match.phase !== t.phase;
  if (!need) {
    const k = tick - t.fromTick - 1;
    if (k >= p.count) need = true;
    else if (k >= 0) {
      const dx = b.x - p.x[k]!, dy = b.y - p.y[k]!, dz = b.z - p.z[k]!;
      const tol = LOCAL_TUNING.predictTolerance;
      if (!(dx * dx + dy * dy + dz * dz <= tol * tol)) need = true;
    } else if (b.x !== t.x0 || b.y !== t.y0 || b.z !== t.z0 || b.vx !== t.vx0 || b.vy !== t.vy0 || b.vz !== t.vz0) {
      need = true; // same tick, different ball (state rewritten)
    }
    if (!t.found && tick - t.fromTick >= LOCAL_TUNING.predictRefreshTicks) need = true;
  }
  if (need) {
    predictBall(b, PREDICT_TICKS, p);
    t.predictions++;
    t.valid = true;
    t.fromTick = tick;
    t.kick = b.lastKickTick;
    t.touched = b.touchedTick;
    t.bounces = b.bounces;
    t.phase = s.match.phase;
    t.x0 = b.x; t.y0 = b.y; t.z0 = b.z; t.vx0 = b.vx; t.vy0 = b.vy; t.vz0 = b.vz;
    const li = p.landIndex;
    t.found = li >= 0;
    if (t.found) {
      let apex = b.y;
      for (let i = 0; i <= li; i++) if (p.y[i]! > apex) apex = p.y[i]!;
      t.apex = apex;
      t.x = p.x[li]!;
      t.z = p.z[li]!;
      t.landTick = tick + li + 1;
    } else {
      t.apex = 0;
      t.landTick = -1;
    }
  }
  t.show = t.found && t.apex >= LOCAL_TUNING.highBallApex && tick < t.landTick
    && Number.isFinite(t.x) && Number.isFinite(t.z);
  return t.show;
}

/** Landing ring radius (m) with `secondsLeft` until the ball lands: shrinks from landRadiusFar to landRadiusNear. */
export function landingRadius(secondsLeft: number): number {
  const k = clamp01(secondsLeft / LOCAL_TUNING.landShrinkS);
  return LOCAL_TUNING.landRadiusNear + (LOCAL_TUNING.landRadiusFar - LOCAL_TUNING.landRadiusNear) * k;
}

// ============================================================ off-screen arrow maths

export interface EdgeArrow {
  /** The target is off screen (or behind the camera): draw the arrow. */
  show: boolean;
  /** Arrow centre, CSS px (y down). */
  x: number;
  y: number;
  /** Unit direction toward the target in screen space (y down). */
  dx: number;
  dy: number;
}

export function createEdgeArrow(): EdgeArrow {
  return { show: false, x: 0, y: 0, dx: 1, dy: 0 };
}

/**
 * Arrow maths registers (per-frame callers write these instead of passing doubles, which V8 would box at a
 * non-inlined call): view-space target, near plane, viewport w x h (CSS px), inset (px).
 */
const EA = new Float64Array(7);
const EA_VX = 0, EA_VY = 1, EA_VZ = 2, EA_NEAR = 3, EA_W = 4, EA_H = 5, EA_INSET = 6;

/** edgeArrow on the EA registers (no allocation). */
function edgeArrowCore(pe: ArrayLike<number>, out: EdgeArrow): boolean {
  out.show = false;
  const vx = EA[EA_VX]!, vy = EA[EA_VY]!, vz = EA[EA_VZ]!, w = EA[EA_W]!, h = EA[EA_H]!, inset = EA[EA_INSET]!;
  if (!(w > 0 && h > 0) || !(vx - vx === 0 && vy - vy === 0 && vz - vz === 0)) return false;
  const cx = w * 0.5;
  const cy = h * 0.5;
  let dx: number, dy: number;
  if (vz > -EA[EA_NEAR]!) {
    dx = vx;
    dy = -vy;
    if (dx * dx + dy * dy < 1e-12) { dx = 0; dy = 1; }
  } else {
    const clx = pe[0]! * vx + pe[4]! * vy + pe[8]! * vz + pe[12]!;
    const cly = pe[1]! * vx + pe[5]! * vy + pe[9]! * vz + pe[13]!;
    const clw = pe[3]! * vx + pe[7]! * vy + pe[11]! * vz + pe[15]!;
    if (!(clw > 0)) return false;
    const sx = (clx / clw + 1) * 0.5 * w;
    const sy = (1 - cly / clw) * 0.5 * h;
    if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) return false;
    dx = sx - cx;
    dy = sy - cy;
  }
  const l = Math.sqrt(dx * dx + dy * dy);
  if (!(l > 0 && l - l === 0)) return false;
  dx /= l;
  dy /= l;
  const hw = cx - inset > 1 ? cx - inset : 1;
  const hh = cy - inset > 1 ? cy - inset : 1;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  // Distance along the ray to the inset rectangle (the nearer of the two edge crossings).
  let t = ax > 1e-9 ? hw / ax : -1;
  if (ay > 1e-9) {
    const ty = hh / ay;
    if (t < 0 || ty < t) t = ty;
  }
  out.x = cx + dx * t;
  out.y = cy + dy * t;
  out.dx = dx;
  out.dy = dy;
  out.show = true;
  return true;
}

/**
 * Edge arrow for a target at view-space (vx, vy, vz) (the camera looks down -z). In front of the near plane the
 * target is projected with the camera projection matrix elements `pe` (column-major) to CSS px over w x h; it is
 * off screen when the projected centre is outside the viewport. Behind the camera the direction comes from the
 * view-plane offset (vx, -vy), straight behind points down. The arrow centre is where the ray from the screen centre
 * toward the target meets the rectangle inset by `inset` px. Pure; returns out.show.
 */
export function edgeArrow(
  vx: number, vy: number, vz: number, near: number, pe: ArrayLike<number>, w: number, h: number, inset: number,
  out: EdgeArrow,
): boolean {
  EA[EA_VX] = vx; EA[EA_VY] = vy; EA[EA_VZ] = vz; EA[EA_NEAR] = near; EA[EA_W] = w; EA[EA_H] = h; EA[EA_INSET] = inset;
  return edgeArrowCore(pe, out);
}

/** Largest share of the screen height a touch zone may claim from the bottom edge. */
const ZONE_MAX_FRAC = 0.45;

/** liftArrowAboveZones on the EA registers (w, h, inset). */
function liftCore(a: EdgeArrow, zones: Readonly<TouchZones>): void {
  if (!a.show) return;
  const w = EA[EA_W]!, h = EA[EA_H]!;
  // Bottom-corner boxes: the button cluster (bottom right, bottom left when mirrored) and the stick rest zone.
  const inCluster = zones.mirror ? a.x < zones.clusterW : a.x > w - zones.clusterW;
  const inStick = zones.mirror ? a.x > w - zones.stickW : a.x < zones.stickW;
  let zh = 0;
  if (inCluster && zones.clusterH > zh) zh = zones.clusterH;
  if (inStick && zones.stickH > zh) zh = zones.stickH;
  if (zh > h * ZONE_MAX_FRAC) zh = h * ZONE_MAX_FRAC;
  if (!(zh > 0)) return;
  const maxY = h - EA[EA_INSET]! - zh;
  if (a.y > maxY) a.y = maxY;
}

/**
 * Keep an edge arrow clear of the touch controls: on the bottom edge inside the button-cluster or stick zone boxes
 * (GFX-14 touchZones, from the touch settings) the arrow rises to sit above the zone. No-op when hidden or clear.
 */
export function liftArrowAboveZones(a: EdgeArrow, w: number, h: number, inset: number, zones: Readonly<TouchZones>): void {
  EA[EA_W] = w; EA[EA_H] = h; EA[EA_INSET] = inset;
  liftCore(a, zones);
}

/** World metres per CSS px at view depth `depth` (m) for projection element [5] `pe5` and viewport height viewH (CSS px). */
export function metresPerPx(depth: number, pe5: number, viewH: number): number {
  return (2 * depth) / (pe5 * (viewH > 1 ? viewH : 1));
}

/** Overhead marker unit (m): `worldSize` metres, clamped to minPx..maxPx CSS px on screen at view depth `depth`. */
export function markerUnit(depth: number, pe5: number, viewH: number, worldSize: number, minPx: number, maxPx: number): number {
  const mpp = metresPerPx(depth, pe5, viewH);
  let px = worldSize / mpp;
  if (px < minPx) px = minPx;
  else if (px > maxPx) px = maxPx;
  return px * mpp;
}

// ============================================================ quad batch (one draw call, rewritten per frame)

/**
 * Preallocated dynamic quad list: positions (float32 x3) and linear RGBA vertex colours (uint8 normalised), with a
 * static index buffer (two triangles per quad). Write corner(0..3) then commit(r, g, b, a) per quad between
 * begin() and end(). Triangles are quads with a repeated corner. Full buffers are re-uploaded on end() (small).
 */
export class QuadBatch {
  readonly maxQuads: number;
  readonly geometry: BufferGeometry;
  readonly position: Float32Array;
  readonly colour: Uint8Array;
  /** Quads written since begin(). */
  quads = 0;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;

  constructor(maxQuads: number) {
    this.maxQuads = maxQuads;
    this.position = new Float32Array(maxQuads * 12);
    this.colour = new Uint8Array(maxQuads * 16);
    const index = new Uint16Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4, i = q * 6;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 3;
    }
    this.geometry = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.position, 3);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.colour, 4, true);
    this.colAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry.setDrawRange(0, 0);
  }

  begin(): void {
    this.quads = 0;
  }

  /** Corner k (0..3, in winding order) of the next quad. */
  corner(k: number, x: number, y: number, z: number): void {
    if (this.quads >= this.maxQuads) return;
    const o = (this.quads * 4 + k) * 3;
    this.position[o] = x; this.position[o + 1] = y; this.position[o + 2] = z;
  }

  /** Finish the next quad with a linear colour (bytes) and alpha byte. False when the batch is full. */
  commit(r: number, g: number, b: number, a: number): boolean {
    if (this.quads >= this.maxQuads) return false;
    let o = this.quads * 16;
    const c = this.colour;
    for (let k = 0; k < 4; k++, o += 4) { c[o] = r; c[o + 1] = g; c[o + 2] = b; c[o + 3] = a; }
    this.quads++;
    return true;
  }

  end(): void {
    this.geometry.setDrawRange(0, this.quads * 6);
    if (this.quads > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

// ============================================================ shapes and drawing helpers

const SEGS = 32;
const CS = new Float64Array(SEGS + 1);
const SN = new Float64Array(SEGS + 1);
for (let i = 0; i <= SEGS; i++) {
  CS[i] = Math.cos((i / SEGS) * 2 * Math.PI);
  SN[i] = Math.sin((i / SEGS) * 2 * Math.PI);
}

/** Axis-aligned rectangle as one quad of a 2D shape list. */
function rect(u0: number, v0: number, u1: number, v1: number): number[] {
  return [u0, v0, u1, v0, u1, v1, u0, v1];
}

/** 2D shapes in marker units (8 floats per quad, (u, v) corners; u right, v up). Tip at the origin for markers. */
export const SHAPE_CHEVRON = new Float32Array([
  0, 0, 0.5, 0.62, 0, 0.42, 0, 0.42,
  0, 0, 0, 0.42, -0.5, 0.62, -0.5, 0.62,
]);
export const SHAPE_DIAMOND = new Float32Array([0, 0, 0.42, 0.4, 0, 0.8, -0.42, 0.4]);
/** Arrow pointing +u, centred on the origin, with a small ball behind it. */
export const SHAPE_ARROW = new Float32Array((() => {
  const a = [0.5, 0, -0.3, 0.42, -0.1, 0, -0.1, 0, 0.5, 0, -0.1, 0, -0.3, -0.42, -0.3, -0.42];
  const bx = -0.6, r = 0.17;
  for (let i = 0; i < SEGS; i += 2) {
    a.push(bx, 0, bx + CS[i]! * r, SN[i]! * r, bx + CS[i + 2]! * r, SN[i + 2]! * r, bx, 0);
  }
  return a;
})());
/**
 * Round ink badge behind the off-screen arrow (arrow units): a disc of radius 0.8 around the arrow's bounding-box
 * centre (-0.135, 0), so the white arrow and its ball sit inside a dark rim on any background.
 */
export const SHAPE_BADGE = new Float32Array((() => {
  const a: number[] = [];
  const cx = -0.135, r = 0.8;
  for (let i = 0; i < SEGS; i += 2) {
    a.push(cx, 0, cx + CS[i]! * r, SN[i]! * r, cx + CS[i + 1]! * r, SN[i + 1]! * r, cx + CS[i + 2]! * r, SN[i + 2]! * r);
  }
  return a;
})());
/** "1" and "2" glyphs (box 0.34 x 0.5, origin bottom left), seven-segment style strokes. */
export const GLYPH_1 = new Float32Array([...rect(0.13, 0, 0.22, 0.5), ...rect(0.04, 0.4, 0.13, 0.5), ...rect(0.04, 0, 0.31, 0.08)]);
export const GLYPH_2 = new Float32Array([
  ...rect(0, 0.42, 0.34, 0.5), ...rect(0.25, 0.25, 0.34, 0.5), ...rect(0, 0.21, 0.34, 0.29),
  ...rect(0, 0, 0.09, 0.29), ...rect(0, 0, 0.34, 0.08),
]);
const MARKER_SHAPES: readonly Float32Array[] = [SHAPE_CHEVRON, SHAPE_DIAMOND];
const GLYPHS: readonly Float32Array[] = [GLYPH_1, GLYPH_2];

/** Colour ids into COL (linear bytes). */
const C_P1 = 0, C_WHITE = 2, C_INK = 3;
const COL = new Uint8Array(12);
(() => {
  const c = new Color();
  const hex = [HUMAN_COLOURS[0]!, HUMAN_COLOURS[1]!, 0xffffff, 0x07070d];
  for (let i = 0; i < 4; i++) {
    c.setHex(hex[i]!); // working (linear) colour space: vertex colours are linear
    COL[i * 3] = Math.round(c.r * 255); COL[i * 3 + 1] = Math.round(c.g * 255); COL[i * 3 + 2] = Math.round(c.b * 255);
  }
})();

/**
 * Drawing registers. Per-frame helpers take only small integers and objects; doubles travel through this array
 * (V8 boxes doubles passed to a call it does not inline, which would allocate every frame).
 */
const RG = new Float64Array(32);
/** Camera basis (right, up; world) and projection facts, written once per frame. */
const RX = 0, RY = 1, RZ = 2, UX = 3, UY = 4, UZ = 5, PE5 = 6, VIEW_H = 7, NEAR = 8;
/** Billboard: anchor, unit (m per marker unit), offsets (m), rotation (cos, sin), alpha. */
const B_AX = 9, B_AY = 10, B_AZ = 11, B_UNIT = 12, B_OU = 13, B_OV = 14, B_CS = 15, B_SN = 16, B_ALPHA = 17;
/** Billboard rectangle bounds (marker units). */
const B_U0 = 18, B_V0 = 19, B_U1 = 20, B_V1 = 21;
/** Ground: centre, radii (or tick start / end), tick half width, alpha. */
const G_X = 22, G_Z = 23, G_R0 = 24, G_R1 = 25, G_HW = 26, G_ALPHA = 27;
/** Per-anchor scratch: view depth, metres per px, marker unit. */
const DEPTH = 28, MPP = 29, UNIT = 30;

function alphaByte(a: number): number {
  return a > 0 ? (a < 1 ? Math.round(a * 255) : 255) : 0;
}

/**
 * Draw a 2D shape as a camera-facing billboard (RG billboard registers): corner (u, v) goes to
 * anchor + R * (ou + (u cs - v sn) * unit) + U * (ov + (u sn + v cs) * unit).
 */
function billboard(bt: QuadBatch, shape: Float32Array, ci: number): void {
  const ax = RG[B_AX]!, ay = RG[B_AY]!, az = RG[B_AZ]!, unit = RG[B_UNIT]!, ou = RG[B_OU]!, ov = RG[B_OV]!;
  const cs = RG[B_CS]!, sn = RG[B_SN]!;
  const rx = RG[RX]!, ry = RG[RY]!, rz = RG[RZ]!, ux = RG[UX]!, uy = RG[UY]!, uz = RG[UZ]!;
  const r = COL[ci * 3]!, g = COL[ci * 3 + 1]!, b = COL[ci * 3 + 2]!, a = alphaByte(RG[B_ALPHA]!);
  const P = bt.position;
  const n = shape.length >> 3;
  for (let q = 0; q < n; q++) {
    if (bt.quads >= bt.maxQuads) return;
    const o = q * 8;
    let w = bt.quads * 12;
    for (let k = 0; k < 4; k++, w += 3) {
      const u = shape[o + k * 2]!, v = shape[o + k * 2 + 1]!;
      const lu = ou + (u * cs - v * sn) * unit;
      const lv = ov + (u * sn + v * cs) * unit;
      P[w] = ax + rx * lu + ux * lv; P[w + 1] = ay + ry * lu + uy * lv; P[w + 2] = az + rz * lu + uz * lv;
    }
    bt.commit(r, g, b, a);
  }
}

/** Camera-facing rectangle (RG B_U0..B_V1 in marker units) at the billboard anchor, no rotation or offset. */
function billboardRect(bt: QuadBatch, ci: number): void {
  if (bt.quads >= bt.maxQuads) return;
  const ax = RG[B_AX]!, ay = RG[B_AY]!, az = RG[B_AZ]!, unit = RG[B_UNIT]!;
  const rx = RG[RX]!, ry = RG[RY]!, rz = RG[RZ]!, ux = RG[UX]!, uy = RG[UY]!, uz = RG[UZ]!;
  const us0 = RG[B_U0]! * unit, us1 = RG[B_U1]! * unit, vs0 = RG[B_V0]! * unit, vs1 = RG[B_V1]! * unit;
  const P = bt.position;
  const w = bt.quads * 12;
  P[w] = ax + rx * us0 + ux * vs0; P[w + 1] = ay + ry * us0 + uy * vs0; P[w + 2] = az + rz * us0 + uz * vs0;
  P[w + 3] = ax + rx * us1 + ux * vs0; P[w + 4] = ay + ry * us1 + uy * vs0; P[w + 5] = az + rz * us1 + uz * vs0;
  P[w + 6] = ax + rx * us1 + ux * vs1; P[w + 7] = ay + ry * us1 + uy * vs1; P[w + 8] = az + rz * us1 + uz * vs1;
  P[w + 9] = ax + rx * us0 + ux * vs1; P[w + 10] = ay + ry * us0 + uy * vs1; P[w + 11] = az + rz * us0 + uz * vs1;
  bt.commit(COL[ci * 3]!, COL[ci * 3 + 1]!, COL[ci * 3 + 2]!, alphaByte(RG[B_ALPHA]!));
}

/**
 * Flat ring on the ground (y = groundY) from RG G_X, G_Z, G_R0..G_R1, G_ALPHA: `step` table segments per quad,
 * every other quad skipped when dashed.
 */
function groundRing(bt: QuadBatch, step: number, dashed: boolean, ci: number): void {
  const y = LOCAL_TUNING.groundY;
  const x = RG[G_X]!, z = RG[G_Z]!, r0 = RG[G_R0]!, r1 = RG[G_R1]!;
  const r = COL[ci * 3]!, g = COL[ci * 3 + 1]!, b = COL[ci * 3 + 2]!, a = alphaByte(RG[G_ALPHA]!);
  const P = bt.position;
  let n = 0;
  for (let i = 0; i < SEGS; i += step, n++) {
    if (dashed && (n & 1) === 1) continue;
    if (bt.quads >= bt.maxQuads) return;
    const j = i + step;
    const w = bt.quads * 12;
    P[w] = x + CS[i]! * r0; P[w + 1] = y; P[w + 2] = z + SN[i]! * r0;
    P[w + 3] = x + CS[i]! * r1; P[w + 4] = y; P[w + 5] = z + SN[i]! * r1;
    P[w + 6] = x + CS[j]! * r1; P[w + 7] = y; P[w + 8] = z + SN[j]! * r1;
    P[w + 9] = x + CS[j]! * r0; P[w + 10] = y; P[w + 11] = z + SN[j]! * r0;
    bt.commit(r, g, b, a);
  }
}

/** Radial tick on the ground at table angle index k, from radius G_R0 to G_R1, half width G_HW (RG registers). */
function groundTick(bt: QuadBatch, k: number, ci: number): void {
  if (bt.quads >= bt.maxQuads) return;
  const y = LOCAL_TUNING.groundY;
  const x = RG[G_X]!, z = RG[G_Z]!, ra = RG[G_R0]!, rb = RG[G_R1]!, hw = RG[G_HW]!;
  const dx = CS[k]!, dz = SN[k]!, px = -dz * hw, pz = dx * hw;
  const P = bt.position;
  const w = bt.quads * 12;
  P[w] = x + dx * ra - px; P[w + 1] = y; P[w + 2] = z + dz * ra - pz;
  P[w + 3] = x + dx * rb - px; P[w + 4] = y; P[w + 5] = z + dz * rb - pz;
  P[w + 6] = x + dx * rb + px; P[w + 7] = y; P[w + 8] = z + dz * rb + pz;
  P[w + 9] = x + dx * ra + px; P[w + 10] = y; P[w + 11] = z + dz * ra + pz;
  bt.commit(COL[ci * 3]!, COL[ci * 3 + 1]!, COL[ci * 3 + 2]!, alphaByte(RG[G_ALPHA]!));
}

/**
 * Size facts for an anchor (RG B_AX..B_AZ) seen through the camera (mi = matrixWorldInverse elements): view depth,
 * metres per CSS px, and the overhead marker unit (markerWorld clamped to markerMinPx..markerMaxPx). False when the
 * anchor is not in front of the near plane.
 */
function anchorScale(mi: ArrayLike<number>): boolean {
  const ax = RG[B_AX]!, ay = RG[B_AY]!, az = RG[B_AZ]!;
  const depth = -(mi[2]! * ax + mi[6]! * ay + mi[10]! * az + mi[14]!);
  if (!(depth > RG[NEAR]!)) return false;
  const vh = RG[VIEW_H]!;
  const mpp = (2 * depth) / (RG[PE5]! * (vh > 1 ? vh : 1));
  let px = LOCAL_TUNING.markerWorld / mpp;
  if (px < LOCAL_TUNING.markerMinPx) px = LOCAL_TUNING.markerMinPx;
  else if (px > LOCAL_TUNING.markerMaxPx) px = LOCAL_TUNING.markerMaxPx;
  RG[DEPTH] = depth;
  RG[MPP] = mpp;
  RG[UNIT] = px * mpp;
  return true;
}

// ============================================================ module

export interface MarkersModule extends RenderModule {
  /** Overlay batch: overhead markers, labels, power bars and the off-screen arrow (drawn on top). Alias of overlay. */
  readonly cones: Mesh;
  /** Ground batch: player rings, receiver ring, landing target (depth tested). Alias of ground. */
  readonly rings: Mesh;
  readonly overlay: Mesh;
  readonly ground: Mesh;
  /** Aids decided for the last frame (diagnostics, tests). */
  readonly plan: Readonly<AidPlan>;
  readonly landing: Readonly<LandingTracker>;
  readonly arrow: Readonly<EdgeArrow>;
}

/** Ground batch capacity (quads): two player rings, receiver ring + ticks, landing target with outline (~200 used). */
const GROUND_QUADS = 320;
/** Overlay batch capacity (quads): two humans' markers, labels, faint markers and bars, plus the arrow. */
const OVERLAY_QUADS = 192;

export function createMarkers(ctx: RenderContext): MarkersModule {
  const groundBatch = new QuadBatch(GROUND_QUADS);
  const groundMat = new MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, depthTest: true, side: DoubleSide, forceSinglePass: true,
    fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const ground = new Mesh(groundBatch.geometry, groundMat);
  ground.name = 'aids-ground';
  ground.frustumCulled = false;
  ground.renderOrder = 2;
  ground.visible = false;

  const overlayBatch = new QuadBatch(OVERLAY_QUADS);
  const overlayMat = new MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, depthTest: false, side: DoubleSide, forceSinglePass: true,
    fog: false, toneMapped: false,
  });
  const overlay = new Mesh(overlayBatch.geometry, overlayMat);
  overlay.name = 'aids-overlay';
  overlay.frustumCulled = false;
  overlay.renderOrder = 10;
  overlay.visible = false;

  ctx.scene.add(ground);
  ctx.scene.add(overlay);

  const plan = createAidPlan();
  /** [QF-4] Render-only offsets the player model drew each player with (foot lock, set-piece stance). */
  const drawn = drawnOffsetsOf(ctx);
  const landing = createLandingTracker();
  const arrow = createEdgeArrow();
  const zones: TouchZones = { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false };
  let zonesFor: unknown = null;
  let shown = false;

  /** Overhead marker of human h above `slot` (faint = the next-switch marker), with an ink drop shadow. */
  function drawHead(s: ReadonlySimState, it: InterpState, mi: ArrayLike<number>, h: number, slot: number, faint: boolean,
    label: boolean): void {
    const hcm = s.attrs[slot]!.height;
    RG[B_AX] = it.x[slot]! + drawn[slot * 2]!;
    RG[B_AY] = MARKER_Y * (hcm > 100 && hcm < 230 ? hcm / 180 : 1);
    RG[B_AZ] = it.z[slot]! + drawn[slot * 2 + 1]!;
    if (!anchorScale(mi)) return;
    const unit = RG[UNIT]! * (faint ? LOCAL_TUNING.switchScale : 1);
    const alpha = faint ? LOCAL_TUNING.switchAlpha : 1;
    const sh = LOCAL_TUNING.shadowPx * RG[MPP]!;
    const shape = MARKER_SHAPES[HUMAN_SHAPES[h]!]!;
    RG[B_UNIT] = unit; RG[B_CS] = 1; RG[B_SN] = 0;
    RG[B_OU] = sh; RG[B_OV] = -sh; RG[B_ALPHA] = LOCAL_TUNING.shadowAlpha * alpha;
    billboard(overlayBatch, shape, C_INK);
    RG[B_OU] = 0; RG[B_OV] = 0; RG[B_ALPHA] = alpha;
    billboard(overlayBatch, shape, C_P1 + h);
    if (label) {
      const g = GLYPHS[h]!;
      const ou = LOCAL_TUNING.labelOffsetU * unit, ov = LOCAL_TUNING.labelOffsetV * unit;
      RG[B_UNIT] = unit * LOCAL_TUNING.labelScale;
      RG[B_OU] = ou + sh; RG[B_OV] = ov - sh; RG[B_ALPHA] = LOCAL_TUNING.shadowAlpha * alpha;
      billboard(overlayBatch, g, C_INK);
      RG[B_OU] = ou; RG[B_OV] = ov; RG[B_ALPHA] = alpha;
      billboard(overlayBatch, g, C_P1 + h);
    }
  }

  /** Power bar of human h under the controlled player's feet: white frame, ink background, fill in his colour. */
  function drawPower(it: InterpState, mi: ArrayLike<number>, h: number, slot: number): void {
    RG[B_AX] = it.x[slot]! + drawn[slot * 2]!;
    RG[B_AY] = 0;
    RG[B_AZ] = it.z[slot]! + drawn[slot * 2 + 1]!;
    if (!anchorScale(mi)) return;
    const power = plan.humans[h]!.power;
    const hw = LOCAL_TUNING.barW / 2, hh = LOCAL_TUNING.barH / 2, bd = LOCAL_TUNING.barBorder, v = -LOCAL_TUNING.barDrop;
    RG[B_UNIT] = RG[UNIT]!;
    RG[B_U0] = -hw - bd; RG[B_V0] = v - hh - bd; RG[B_U1] = hw + bd; RG[B_V1] = v + hh + bd; RG[B_ALPHA] = 0.9;
    billboardRect(overlayBatch, C_WHITE);
    RG[B_U0] = -hw; RG[B_V0] = v - hh; RG[B_U1] = hw; RG[B_V1] = v + hh; RG[B_ALPHA] = 0.8;
    billboardRect(overlayBatch, C_INK);
    if (power > 0) {
      RG[B_U1] = -hw + 2 * hw * power; RG[B_ALPHA] = 1;
      billboardRect(overlayBatch, C_P1 + h);
    }
  }

  /** Off-screen arrow at the arrow's screen point (CSS px), placed overlayDepth in front of the camera. */
  function drawArrow(mw: ArrayLike<number>, pe: ArrayLike<number>): void {
    const near = RG[NEAR]!, w = EA[EA_W]!, h = EA[EA_H]!;
    const D = LOCAL_TUNING.overlayDepth > near * 2 ? LOCAL_TUNING.overlayDepth : near * 2;
    const nx = (arrow.x / w) * 2 - 1;
    const ny = 1 - (arrow.y / h) * 2;
    const vx = ((nx + pe[8]!) * D) / pe[0]!;
    const vy = ((ny + pe[9]!) * D) / pe[5]!;
    const vz = -D;
    RG[B_AX] = mw[0]! * vx + mw[4]! * vy + mw[8]! * vz + mw[12]!;
    RG[B_AY] = mw[1]! * vx + mw[5]! * vy + mw[9]! * vz + mw[13]!;
    RG[B_AZ] = mw[2]! * vx + mw[6]! * vy + mw[10]! * vz + mw[14]!;
    const mpp = (2 * D) / (pe[5]! * h);
    // Screen direction (y down) -> camera plane (v up). Ink badge first, then the white arrow inside it.
    RG[B_UNIT] = LOCAL_TUNING.arrowPx * mpp; RG[B_CS] = arrow.dx; RG[B_SN] = -arrow.dy;
    RG[B_OU] = 0; RG[B_OV] = 0; RG[B_ALPHA] = LOCAL_TUNING.arrowBadgeAlpha;
    billboard(overlayBatch, SHAPE_BADGE, C_INK);
    RG[B_ALPHA] = 1;
    billboard(overlayBatch, SHAPE_ARROW, C_WHITE);
  }

  /**
   * Off-screen ball arrow from the EA registers, when the ball is out of view. [QF-7R skeptic] A function of its own,
   * called every frame, so the per-frame overlay code always has feedback for this call and the out-of-view branch
   * can be warmed on the loading screen (warmUp below).
   */
  function drawEdgeArrow(mw: ArrayLike<number>, pe: ArrayLike<number>): void {
    if (edgeArrowCore(pe, arrow)) {
      if (zonesFor !== ctx.settings) { zonesFor = ctx.settings; touchZones(ctx.settings, zones); }
      liftCore(arrow, zones);
      drawArrow(mw, pe);
    }
  }

  function hide(): void {
    groundBatch.begin(); groundBatch.end();
    overlayBatch.begin(); overlayBatch.end();
    ground.visible = false;
    overlay.visible = false;
  }

  function drawGround(f: RenderFrame, cb: boolean): void {
    const s = f.curr;
    const it = f.interp;
    groundBatch.begin();
    // Landing target (first: later quads draw over earlier ones).
    if (landing.show) {
      // landingRadius(seconds left), inline (no double crossing a call boundary per frame).
      const left = (landing.landTick - (s.tick - 1 + f.alpha)) / TICK_HZ / LOCAL_TUNING.landShrinkS;
      const kl = left > 0 ? (left < 1 ? left : 1) : 0;
      const r = LOCAL_TUNING.landRadiusNear + (LOCAL_TUNING.landRadiusFar - LOCAL_TUNING.landRadiusNear) * kl;
      landing.radius = r;
      const lw = LOCAL_TUNING.landWidth;
      RG[G_X] = landing.x; RG[G_Z] = landing.z;
      RG[G_R0] = r - lw * 1.6; RG[G_R1] = r + lw * 0.6; RG[G_ALPHA] = LOCAL_TUNING.landOutlineAlpha;
      groundRing(groundBatch, 1, false, C_INK);
      RG[G_R0] = r - lw; RG[G_R1] = r; RG[G_ALPHA] = LOCAL_TUNING.landAlpha;
      groundRing(groundBatch, 1, false, C_WHITE);
      RG[G_R0] = 0; RG[G_R1] = LOCAL_TUNING.landDot; RG[G_ALPHA] = LOCAL_TUNING.landAlpha;
      groundRing(groundBatch, 2, false, C_WHITE);
      RG[G_R0] = r + 0.06; RG[G_R1] = r + 0.06 + LOCAL_TUNING.landTick; RG[G_HW] = LOCAL_TUNING.landTickHalfW;
      RG[G_ALPHA] = LOCAL_TUNING.landAlpha;
      for (let k = 0; k < SEGS; k += SEGS / 4) groundTick(groundBatch, k, C_WHITE);
    }
    // Receiver ring with four outward ticks, gently pulsing.
    if (plan.receiver >= 0) {
      const t = plan.receiver;
      const ph = (f.frame.nowMs / 1000) * LOCAL_TUNING.receiverPulseHz * 2 * Math.PI;
      const k = 1 + LOCAL_TUNING.receiverPulse * Math.sin(ph - ph === 0 ? ph : 0);
      const ci = C_P1 + plan.receiverHuman;
      const r1 = LOCAL_TUNING.receiverOuter * k;
      RG[G_X] = it.x[t]! + drawn[t * 2]!; RG[G_Z] = it.z[t]! + drawn[t * 2 + 1]!;
      RG[G_R0] = LOCAL_TUNING.receiverInner * k; RG[G_R1] = r1; RG[G_ALPHA] = LOCAL_TUNING.receiverAlpha;
      groundRing(groundBatch, 1, false, ci);
      RG[G_R0] = r1 - 0.02; RG[G_R1] = r1 + LOCAL_TUNING.receiverTick; RG[G_HW] = LOCAL_TUNING.receiverTickHalfW;
      RG[G_ALPHA] = LOCAL_TUNING.receiverAlpha;
      for (let q = SEGS / 8; q < SEGS; q += SEGS / 4) groundTick(groundBatch, q, ci);
    }
    // Controlled players' rings (colour-blind: P2's ring is dashed).
    for (let h = 0; h < MAX_HUMANS; h++) {
      const slot = plan.humans[h]!.slot;
      if (slot < 0) continue;
      RG[G_X] = it.x[slot]! + drawn[slot * 2]!; RG[G_Z] = it.z[slot]! + drawn[slot * 2 + 1]!;
      if (cb && HUMAN_SHAPES[h] === MarkerShape.DIAMOND) {
        RG[G_R0] = LOCAL_TUNING.dashInner; RG[G_R1] = LOCAL_TUNING.dashOuter; RG[G_ALPHA] = LOCAL_TUNING.ringAlpha;
        groundRing(groundBatch, 2, true, C_P1 + h);
      } else {
        RG[G_R0] = LOCAL_TUNING.ringInner; RG[G_R1] = LOCAL_TUNING.ringOuter; RG[G_ALPHA] = LOCAL_TUNING.ringAlpha;
        groundRing(groundBatch, 1, false, C_P1 + h);
      }
    }
    groundBatch.end();
    ground.visible = groundBatch.quads > 0;
  }

  function drawOverlay(f: RenderFrame, cb: boolean): void {
    const s = f.curr;
    const it = f.interp;
    overlayBatch.begin();
    arrow.show = false;
    if (plan.active) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      const mw = cam.matrixWorld.elements;
      const mi = cam.matrixWorldInverse.elements;
      const pe = cam.projectionMatrix.elements;
      RG[RX] = mw[0]!; RG[RY] = mw[1]!; RG[RZ] = mw[2]!;
      RG[UX] = mw[4]!; RG[UY] = mw[5]!; RG[UZ] = mw[6]!;
      RG[PE5] = pe[5]!; RG[VIEW_H] = ctx.size.cssH; RG[NEAR] = cam.near;
      // Faint next-switch markers first, then power bars, then the controlled players' markers on top.
      for (let h = 0; h < MAX_HUMANS; h++) {
        const a = plan.humans[h]!;
        if (a.next >= 0) drawHead(s, it, mi, h, a.next, true, false);
      }
      for (let h = 0; h < MAX_HUMANS; h++) {
        const a = plan.humans[h]!;
        if (a.slot >= 0 && a.power >= 0) drawPower(it, mi, h, a.slot);
      }
      for (let h = 0; h < MAX_HUMANS; h++) {
        const a = plan.humans[h]!;
        if (a.slot >= 0) drawHead(s, it, mi, h, a.slot, false, cb);
      }
      // Off-screen ball arrow.
      const bx = it.ballX, by = it.ballY, bz = it.ballZ;
      EA[EA_VX] = mi[0]! * bx + mi[4]! * by + mi[8]! * bz + mi[12]!;
      EA[EA_VY] = mi[1]! * bx + mi[5]! * by + mi[9]! * bz + mi[13]!;
      EA[EA_VZ] = mi[2]! * bx + mi[6]! * by + mi[10]! * bz + mi[14]!;
      EA[EA_NEAR] = cam.near; EA[EA_W] = ctx.size.cssW; EA[EA_H] = ctx.size.cssH; EA[EA_INSET] = LOCAL_TUNING.arrowInset;
      drawEdgeArrow(mw, pe);
    }
    overlayBatch.end();
    overlay.visible = overlayBatch.quads > 0;
  }

  return {
    cones: overlay,
    rings: ground,
    overlay,
    ground,
    plan,
    landing,
    arrow,
    /**
     * [QF-7R skeptic] The off-screen ball arrow is drawn only while the ball is out of view: rare with the broadcast
     * camera the JIT warm-up script drives, frequent with the CLOSE camera (long balls, goal kicks). Unwarmed, its code
     * ran in V8's interpreter in steady play, a heap number per double operation (CLOSE camera: 3.8 B and 163
     * allocations per 1000 frames; tests/perf/qf-7r-camera-alloc.test.ts). Here every branch of the arrow path runs
     * arrowWarmCalls times on targets all round the camera (in front off each edge, behind it, both touch-zone sides),
     * into the overlay batch, which is then emptied; the registers and the arrow are restored (no trace:
     * tests/unit/qf-7r-warm.test.ts).
     */
    warmUp() {
      const cam = ctx.camera;
      const mw = cam.matrixWorld.elements;
      const pe = cam.projectionMatrix.elements;
      const saveRG = RG.slice();
      const saveEA = EA.slice();
      const ax = arrow.x, ay = arrow.y, adx = arrow.dx, ady = arrow.dy, ashow = arrow.show;
      const saveFor = zonesFor;
      const zw = zones.clusterW, zh = zones.clusterH, sw = zones.stickW, sh = zones.stickH, zm = zones.mirror;
      const w = ctx.size.cssW, h = ctx.size.cssH;
      const wz: TouchZones = { clusterW: w * 0.3, clusterH: h * 0.3, stickW: w * 0.3, stickH: h * 0.2, mirror: false };
      RG[NEAR] = cam.near;
      const n = LOCAL_TUNING.arrowWarmCalls;
      for (let i = 0; i < n; i++) {
        const a = i * 2.399963; // golden angle: directions all round
        const r = 30 + (i % 7) * 12;
        EA[EA_VX] = r * Math.cos(a); EA[EA_VY] = 0.6 * r * Math.sin(a);
        EA[EA_VZ] = (i & 3) === 0 ? 15 : (i & 3) === 1 ? -2 : -25; // behind, beside the near plane, in front
        EA[EA_NEAR] = cam.near; EA[EA_W] = w; EA[EA_H] = h; EA[EA_INSET] = LOCAL_TUNING.arrowInset;
        overlayBatch.begin();
        arrow.show = false;
        drawEdgeArrow(mw, pe); // the live path (live touch zones)
        if (arrow.show) { // and both touch-zone sides
          wz.mirror = (i & 4) !== 0;
          liftCore(arrow, wz);
        }
      }
      overlayBatch.begin();
      overlayBatch.end();
      RG.set(saveRG);
      EA.set(saveEA);
      arrow.x = ax; arrow.y = ay; arrow.dx = adx; arrow.dy = ady; arrow.show = ashow;
      zonesFor = saveFor;
      zones.clusterW = zw; zones.clusterH = zh; zones.stickW = sw; zones.stickH = sh; zones.mirror = zm;
    },
    setMatch() {
      shown = true;
      resetLandingTracker(landing);
      arrow.show = false;
      // Visible for the loading compile pass (index.ts warmUp compiles visible objects); update() hides empty batches.
      ground.visible = true;
      overlay.visible = true;
    },
    update(f: RenderFrame) {
      if (!shown) { hide(); return; }
      planAids(f.curr, plan);
      if (plan.active) updateLanding(landing, f.curr);
      else landing.show = false;
      const cb = ctx.settings.accessibility?.colourBlindMarkers === true;
      drawGround(f, cb);
      drawOverlay(f, cb);
    },
    clearMatch() {
      shown = false;
      resetLandingTracker(landing);
      arrow.show = false;
      hide();
    },
    dispose() {
      ctx.scene.remove(ground, overlay);
      groundBatch.dispose(); overlayBatch.dispose();
      groundMat.dispose(); overlayMat.dispose();
    },
  };
}

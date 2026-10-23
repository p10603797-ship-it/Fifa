/**
 * [GFX-09] Animation: locomotion clips (idle, jog, sprint, turn lean, strafe, jockey, shield, keeper ready). Section 8
 * "Look": run cycles advance with distance travelled so feet do not slide (`cycle` is the distance-driven stride
 * phase in radians: the mapper adds 2 PI * distance / strideLengthFor(anim, speed) every frame); poses blend (GFX-12).
 * Pose layout: contracts/render.ts PoseIdx (model faces +x, +z to the player's right).
 *
 * GAIT: one procedural gait drives every clip. A cycle (2 PI) is two steps: the right foot touches down at cycle 0,
 * the left half a cycle later (a quarter cycle when side-shuffling). While a foot is planted its toe point moves
 * backward in model space by exactly stride * cycle / (2 PI) per radian, i.e. at minus the body speed, so with the
 * mapper's distance-driven cycle the foot is still in the world (no sliding); late in the stance the heel lifts and
 * the foot rolls over the toe. Legs are placed with IK (poseMath.legIK / plantToe) against the GFX-07 skeleton.
 * Swing feet follow a Hermite arc whose end velocities match the stance (no jerk at touchdown / toe-off) and stay
 * low near both ends, so in the flight phases the lowest foot stays inside the model's ground snap (fk.ts
 * GROUND_SNAP_MAX) and the body never pops. Stance geometry depends on speed only, so JOG and SPRINT at the same speed
 * plant identically and cross-fade cleanly; they differ in the upper body (lean, arm swing) and knee lift.
 *
 * CLIP PARAMETERS (PoseFn: out, t, cycle, speed, side, foot):
 *  - IDLE: t = breathing phase (0..1, wraps); feet planted, gentle breathing sway.
 *  - JOG / SPRINT: cycle, speed (m/s). Stride length / arm swing / lean scale with speed.
 *  - TURN_LEAN: jog/sprint gait (foot 1 = sprint style) rolled into the turn: side = yaw rate (rad/s, + = turning
 *    right); lean = atan(speed * yawRate / g), clamped (turnLeanAngle).
 *  - STRAFE, JOCKEY, SHIELD, KEEPER_READY: directional gaits; t = movement direction relative to the facing as a
 *    fraction of a turn (0 forward, 0.25 right, 0.5 back, 0.75 left). SHIELD: side -1/+1 = arm out to that side.
 * Breathing on the directional clips is a mapper layer (applyBreath).
 *
 * Allocation-free: module scratch only; parameter sets are built once at load.
 */

import { AnimId, PoseIdx, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';
import { clamp, HEEL_X, lerp, PELVIS_Y, placeSwingFootS, plantToeS, PSA, PTA, TAU, TOE_X, wrap01 } from './poseMath';

const P = PoseIdx;

const LOCAL_TUNING = { // TUNING-CR (render-only animation constants)
  /** Run cadence (steps per second) = cadenceBase + cadencePerMs * speed (m/s). */
  cadenceBase: 1.75,
  cadencePerMs: 0.34,
  /** Shortest stride per cycle (m), so a nearly still player never spins the cycle. */
  minStride: 0.5,
  /** Shuffle (strafe / jockey / shield / keeper) cadence base and slope (steps/s). */
  shuffleCadenceBase: 3.2,
  shuffleCadencePerMs: 0.55,
  shuffleMinStride: 0.4,
  /** Gravity used for the turn lean (m/s^2) and the largest lean (rad). */
  gravity: 9.81,
  maxTurnLean: 0.38,
  /** Idle breathing amplitudes: pelvis sway (m), chest (rad). */
  breathSway: 0.012,
  breathChest: 0.025,
} as const;

/** Exposed for tests / tools. */
export const LOCOMOTION_TUNING = LOCAL_TUNING;

// ============================================================ stride

/** Run stride length (m per cycle of two steps) at speed (m/s). Used by the mapper for the distance-driven cycle. */
export function strideLength(speed: number): number {
  const v = speed > 0 ? (speed < 12 ? speed : 12) : 0;
  const s = (2 * v) / (LOCAL_TUNING.cadenceBase + LOCAL_TUNING.cadencePerMs * v);
  return s > LOCAL_TUNING.minStride ? s : LOCAL_TUNING.minStride;
}

/** Shuffle stride (strafe, jockey, shield, keeper ready), m per cycle. */
export function shuffleStrideLength(speed: number): number {
  const v = speed > 0 ? (speed < 12 ? speed : 12) : 0;
  const s = (2 * v) / (LOCAL_TUNING.shuffleCadenceBase + LOCAL_TUNING.shuffleCadencePerMs * v);
  return s > LOCAL_TUNING.shuffleMinStride ? s : LOCAL_TUNING.shuffleMinStride;
}

/** Stride length the cycle of clip `anim` must advance with (m per 2 PI). Locomotion clips only; others use the run. */
export function strideLengthFor(anim: AnimId, speed: number): number {
  return anim === AnimId.STRAFE || anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY
    ? shuffleStrideLength(speed) : strideLength(speed);
}

/** Lean angle (rad, + = right) for a turn at `speed` (m/s) with yaw rate `yawRate` (rad/s, + = turning right). */
export function turnLeanAngle(speed: number, yawRate: number): number {
  const a = Math.atan((speed * yawRate) / LOCAL_TUNING.gravity);
  return clamp(a, -LOCAL_TUNING.maxTurnLean, LOCAL_TUNING.maxTurnLean);
}

// ============================================================ gait

/**
 * Gait parameter set (numbers as functions of speed are evaluated in gaitParams). Built once per style.
 */
interface GaitStyle {
  shuffle: number;
  /** Feet half spacing at rest / at speed (m). */
  baseRest: number;
  baseMove: number;
  /** Pelvis height above the standing pelvis at rest (m, <= 0) and the extra drop at full run. */
  crouchRest: number;
  crouchRun: number;
  /** Swing height of the lowest sole point at a run (m) and its growth with speed. */
  swingH: number;
  /** Max heel lift at toe-off (rad). */
  heelLift: number;
  /** Heel lift through the whole stance (rad): crouched styles stand on the balls of the feet. */
  ballLift: number;
  /** Mid-stance toe position ahead of the hips (m) at rest / moving. */
  centreRest: number;
  centreMove: number;
}

const RUN: GaitStyle = {
  shuffle: 0, baseRest: 0.115, baseMove: 0.085, crouchRest: -0.015, crouchRun: -0.09, swingH: 0.3, heelLift: 0.9, ballLift: 0,
  centreRest: 0.15, centreMove: 0.05,
};
const STRAFE_STYLE: GaitStyle = {
  shuffle: 1, baseRest: 0.13, baseMove: 0.15, crouchRest: -0.04, crouchRun: -0.1, swingH: 0.14, heelLift: 0.6, ballLift: 0.05,
  centreRest: 0.15, centreMove: 0.12,
};
const JOCKEY_STYLE: GaitStyle = {
  shuffle: 1, baseRest: 0.19, baseMove: 0.19, crouchRest: -0.17, crouchRun: -0.06, swingH: 0.1, heelLift: 0.5, ballLift: 0.18,
  centreRest: 0.15, centreMove: 0.13,
};
const SHIELD_STYLE: GaitStyle = {
  shuffle: 1, baseRest: 0.21, baseMove: 0.2, crouchRest: -0.12, crouchRun: -0.05, swingH: 0.09, heelLift: 0.5, ballLift: 0.12,
  centreRest: 0.14, centreMove: 0.12,
};
const KEEPER_STYLE: GaitStyle = {
  shuffle: 1, baseRest: 0.2, baseMove: 0.19, crouchRest: -0.2, crouchRun: -0.05, swingH: 0.09, heelLift: 0.5, ballLift: 0.2,
  centreRest: 0.16, centreMove: 0.13,
};

/** Gait values of the current call (gaitParams): duty, stride, travel, base, pelvis drop, swing height, heel lift,
 *  left-foot phase offset, stance centre, ball-of-foot lift. */
const G = new Float64Array(11);
const G_DUTY = 0, G_STRIDE = 1, G_TRAVEL = 2, G_BASE = 3, G_DROP = 4, G_SWING = 5, G_HEEL = 6, G_OFFSET = 7, G_CENTRE = 8;
const G_BALL = 9, G_TANGENT = 10;

/** Run duty factor (fraction of the cycle a foot is planted) at speed. */
export function runDuty(speed: number): number {
  const v = speed > 0 ? speed : 0;
  if (v <= 1.6) return 0.56;
  if (v <= 4) return lerp(0.56, 0.34, (v - 1.6) / 2.4);
  return Math.max(0.27, 0.34 - 0.012 * (v - 4));
}

// Internal calls hand doubles over in module scratch (V8 boxes doubles passed to calls it does not inline; zero
// allocation per frame). Each function owns its block.
/** gaitParams: speed, forward, sideways, sprint style. */
const GPA = new Float64Array(4);
/** footAt: leg phase. */
const FAU = new Float64Array(1);
/** gaitLegs: cycle, dirX, dirZ, bob. */
const GLA = new Float64Array(4);
/** runPose: cycle, speed, sprint. */
const RPA = new Float64Array(3);
/** arms: cycle, amp, elbow, elbowAmp, roll, offset. */
const ARA = new Float64Array(6);
/** shuffleLegs: t, cycle, speed. */
const SLA = new Float64Array(3);
/** leanInto: t, speed, k. */
const LIA = new Float64Array(3);
/** applyTurnLeanS: lean. applyBreathS: phase, weight. */
export const TLA = new Float64Array(1);
export const BRA = new Float64Array(2);
/** strideLengthForS: speed in, stride out. */
export const SLEN = new Float64Array(2);

/** Pose-function parameters of the allocation-free entry points (LOCOMOTION_IMPLS): t, cycle, speed, side, foot. */
export const PP = new Float64Array(5);
/** A pose function reading its parameters from PP (allocation-free form of PoseFn). */
export type PoseImpl = (out: Pose) => void;

/**
 * [QF-7R] Smoothsteps in the per-frame pose path are written out (`q = (x - a) / (b - a)`, clamp, `q * q * (3 - 2 * q)`)
 * rather than called through a helper: V8 inlines a call only while the caller's inlining budget lasts, and a call it
 * does not inline boxes its double arguments and result (16 B each, every player, every frame: measured in the strafe
 * and shuffle poses). The same goes for the finite-number guard (fin).
 *
 * Gait speed smoothsteps (ss(a, b, v) = smoothstep of v between edges a and b) for gaitParams: in GC[0]
 * the speed v, out GC[1..9] = ss(0, 1.2, v), ss(0.5, 4, v), ss(4, 8, v), ss(6.5, 10, v), ss(1.6, 5, v),
 * ss(0.2, 1.2, v), ss(0.5, 3, v), ss(0.3, 1.5, v), ss(2, 4.5, v).
 */
const GC = new Float64Array(10);
const GC_V = 0, GC_0_12 = 1, GC_05_4 = 2, GC_4_8 = 3, GC_65_10 = 4, GC_16_5 = 5, GC_02_12 = 6, GC_05_3 = 7, GC_03_15 = 8,
  GC_2_45 = 9;
function gaitCurvesS(): void {
  const v = GC[GC_V]!;
  let q = (v - 0) / (1.2 - 0); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_0_12] = q * q * (3 - 2 * q);
  q = (v - 0.5) / (4 - 0.5); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_05_4] = q * q * (3 - 2 * q);
  q = (v - 4) / (8 - 4); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_4_8] = q * q * (3 - 2 * q);
  q = (v - 6.5) / (10 - 6.5); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_65_10] = q * q * (3 - 2 * q);
  q = (v - 1.6) / (5 - 1.6); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_16_5] = q * q * (3 - 2 * q);
  q = (v - 0.2) / (1.2 - 0.2); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_02_12] = q * q * (3 - 2 * q);
  q = (v - 0.5) / (3 - 0.5); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_05_3] = q * q * (3 - 2 * q);
  q = (v - 0.3) / (1.5 - 0.3); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_03_15] = q * q * (3 - 2 * q);
  q = (v - 2) / (4.5 - 2); q = q < 0 ? 0 : q > 1 ? 1 : q; GC[GC_2_45] = q * q * (3 - 2 * q);
}

function gaitParams(st: GaitStyle): void {
  const speed = GPA[0]!, forward = GPA[1]!, sideways = GPA[2]!, sprintStyle = GPA[3]!;
  const v = speed > 0 ? (speed < 12 ? speed : 12) : 0;
  GC[GC_V] = v;
  gaitCurvesS();
  const move = GC[GC_0_12]!;
  if (st.shuffle === 1) {
    G[G_DUTY] = 0.6;
    const sl = (2 * v) / (LOCAL_TUNING.shuffleCadenceBase + LOCAL_TUNING.shuffleCadencePerMs * v);
    G[G_STRIDE] = sl > LOCAL_TUNING.shuffleMinStride ? sl : LOCAL_TUNING.shuffleMinStride;
    G[G_OFFSET] = 0.5 - 0.27 * sideways; // gallop-like side shuffle: the leading foot lands first, feet never cross
    G[G_DROP] = st.crouchRest + st.crouchRun * GC[GC_05_4]!;
    G[G_SWING] = st.swingH * move * (0.6 + 0.1 * v);
  } else {
    G[G_DUTY] = v <= 1.6 ? 0.56 : v <= 4 ? 0.56 + (0.34 - 0.56) * ((v - 1.6) / 2.4) : Math.max(0.27, 0.34 - 0.012 * (v - 4));
    const sl = (2 * v) / (LOCAL_TUNING.cadenceBase + LOCAL_TUNING.cadencePerMs * v);
    G[G_STRIDE] = sl > LOCAL_TUNING.minStride ? sl : LOCAL_TUNING.minStride;
    G[G_OFFSET] = 0.5;
    G[G_DROP] = st.crouchRest + (st.crouchRun - st.crouchRest) * GC[GC_0_12]! - 0.04 * GC[GC_4_8]! - 0.03 * GC[GC_65_10]!;
    const h = v < 1.6 ? 0.1 * (v / 1.6) : 0.1 + (st.swingH - 0.1) * GC[GC_16_5]! + 0.012 * (v > 5 ? v - 5 : 0);
    G[G_SWING] = h * (1 + 0.15 * sprintStyle) * move;
  }
  // Stance travel = duty * stride exactly: the planted toe moves back at the body speed (no sliding).
  G[G_TRAVEL] = G[G_DUTY]! * G[G_STRIDE]!;
  G[G_BASE] = st.baseRest + (st.baseMove - st.baseRest) * move;
  G[G_HEEL] = st.heelLift * GC[GC_02_12]!;
  // A crouched pelvis puts the feet further forward so the shins stay near vertical (ankles in range).
  const deep = -G[G_DROP]! - 0.06;
  // Walking steps sit under the hips; running ones land a little further ahead (centreMove).
  const centre = st.shuffle === 1
    ? st.centreRest + (st.centreMove - st.centreRest) * GC[GC_05_3]!
    : st.centreRest * (1 - GC[GC_03_15]!) + st.centreMove * GC[GC_2_45]!;
  G[G_CENTRE] = centre + (deep > 0 ? deep * 1.1 : 0);
  G[G_BALL] = st.ballLift;
  // Swing end tangents (fraction of the stance velocity): a smaller pull-back at speed keeps the feet in reach.
  G[G_TANGENT] = 0.55 - 0.3 * GC[GC_4_8]!;
  // The heel rolls up only when stepping forward (a backward or side step leaves the foot flat / on its ball).
  if (forward < 1) G[G_HEEL] = G[G_HEEL]! * (forward > 0 ? forward : 0);
  if (G[G_HEEL]! < st.ballLift) G[G_HEEL] = st.ballLift;
}

/** Per-foot placement scratch: toe x, z offset along the motion, lowest-sole height, pitch, planted (1/0). */
const F = new Float64Array(5);

/**
 * Foot placement for a leg at its own phase FAU[0] (0..1, 0 = touchdown) along the motion axis: F[0] = position
 * along the motion (m, relative to the stance centre), F[2] = lowest sole height (m), F[3] = foot pitch, F[4] = planted.
 */
function footAt(): void {
  const u = FAU[0]!;
  const duty = G[G_DUTY]!, travel = G[G_TRAVEL]!, heel = G[G_HEEL]!, H = G[G_SWING]!;
  if (u < duty) {
    const s = u / duty; // stance progress
    F[0] = travel * (0.5 - s);
    F[2] = 0;
    let roll = (s - 0.55) / (1 - 0.55); // ss(0.55, 1, s) written out (no double crosses a call)
    roll = roll < 0 ? 0 : roll > 1 ? 1 : roll;
    roll = roll * roll * (3 - 2 * roll);
    const ball = G[G_BALL]!;
    F[3] = -(ball + (heel - ball) * roll * roll);
    F[4] = 1;
    return;
  }
  const s = (u - duty) / (1 - duty); // swing progress
  // Hermite from the toe-off point (-travel/2) to the touchdown point (+travel/2). End tangents follow the stance
  // velocity (scaled) so the foot leaves and arrives nearly still in the world.
  const p0 = -0.5 * travel, p1 = 0.5 * travel;
  const m = -travel * ((1 - duty) / duty) * G[G_TANGENT]!;
  const s2 = s * s, s3 = s2 * s;
  F[0] = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m;
  const sn = Math.sin(Math.PI * s);
  F[2] = H * sn * sn * sn * sn;
  const ball = G[G_BALL]!;
  let up = H * 8;
  up = up > 1 ? 1 : up;
  up = up * up * (3 - 2 * up);
  F[3] = -heel * (1 - s) * (1 - s) - ball * s * s + 0.28 * sn * s * up;
  F[4] = 0;
}

/**
 * Legs of a gait: pelvis height, pelvis yaw, both feet by IK. GLA = cycle, unit motion direction (x, z) in model
 * space, pelvis bob. Writes ROOT_Y, ROOT_YAW, hips, knees, ankles. Reads G (gaitParams first).
 */
function gaitLegs(out: Pose): void {
  const cycle = GLA[0]!, dirX = GLA[1]!, dirZ = GLA[2]!, bob = GLA[3]!;
  let u = cycle / TAU;
  u -= Math.floor(u);
  if (u >= 1) u = 0;
  const duty = G[G_DUTY]!;
  const travel = G[G_TRAVEL]!;
  // Pelvis: highest over each mid-stance (two bobs per cycle), where the planted leg is under the body; lower at
  // touchdown / toe-off where the leg reaches out (keeps knees and ankles in a natural range at any stride).
  const midR = duty * 0.5;
  out[P.ROOT_Y] = G[G_DROP]! + bob * travel * Math.cos(TAU * 2 * (u - midR)) * 0.5;
  out[P.ROOT_YAW] = 0;
  const base = G[G_BASE]!;
  const span = BODY_TOE_HEEL;
  for (let leg = 0; leg < 2; leg++) {
    const side = leg === 0 ? 1 : -1; // right first: touchdown at u = 0
    let lu = u;
    if (leg === 1) { lu = u - G[G_OFFSET]!; lu -= Math.floor(lu); if (lu >= 1) lu = 0; }
    FAU[0] = lu;
    footAt();
    const along = F[0]!;
    const pitch = F[3]!;
    // Feet move along the motion direction; the stance centre sits ahead of the hips along +x (toe ahead of ankle).
    const tx = G[G_CENTRE]! + along * dirX;
    const tz = side * base + along * dirZ;
    if (F[4] === 1) {
      const drop = span * Math.sin(pitch);
      PTA[0] = tx; PTA[1] = drop > 0 ? F[2]! + drop : F[2]!; PTA[2] = tz; PTA[3] = pitch;
      plantToeS(out, side);
    } else {
      PSA[0] = tx; PSA[1] = F[2]!; PSA[2] = tz; PSA[3] = pitch;
      placeSwingFootS(out, side);
    }
  }
}

/** Boot length toe to heel (m): the heel drops below the toe by this * sin(pitch) when the toes point up. */
const BODY_TOE_HEEL = TOE_X - HEEL_X;

/** Finite number or a default (pose functions accept garbage input and still write a valid pose). */
function fin(x: number, d: number): number {
  return x === x && x < 1e6 && x > -1e6 ? x : d;
}

/**
 * Stance progress (0 = touchdown .. 1 = toe-off) of leg `side` (-1 left / +1 right) for a locomotion clip at the
 * given cycle, speed (m/s) and movement direction (fraction of a turn; 0 for JOG / SPRINT), or -1 while that foot is
 * swinging. For tests and effects (footsteps); mirrors the gait the pose functions use.
 */
export function footPhase(anim: AnimId, cycle: number, speed: number, dir: number, side: number): number {
  const st = anim === AnimId.STRAFE ? STRAFE_STYLE : anim === AnimId.JOCKEY ? JOCKEY_STYLE : anim === AnimId.SHIELD ? SHIELD_STYLE
    : anim === AnimId.KEEPER_READY ? KEEPER_STYLE : RUN;
  const a = TAU * fin(dir, 0);
  GPA[0] = fin(speed, 0); GPA[3] = 0;
  if (st === RUN) { GPA[1] = 1; GPA[2] = 0; } else { GPA[1] = Math.cos(a); GPA[2] = Math.sin(a); }
  gaitParams(st);
  const u = wrap01(fin(cycle, 0) / TAU);
  const lu = side > 0 ? u : wrap01(u - G[G_OFFSET]!);
  const duty = G[G_DUTY]!;
  return lu < duty ? lu / duty : -1;
}

/** Stride length the cycle of clip `anim` must advance with: speed in SLEN[0], stride out in SLEN[1]. */
export function strideLengthForS(anim: AnimId): void {
  let v = SLEN[0]!;
  v = v > 0 ? (v < 12 ? v : 12) : 0;
  let s: number;
  if (anim === AnimId.STRAFE || anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY) {
    s = (2 * v) / (LOCAL_TUNING.shuffleCadenceBase + LOCAL_TUNING.shuffleCadencePerMs * v);
    if (s < LOCAL_TUNING.shuffleMinStride) s = LOCAL_TUNING.shuffleMinStride;
  } else {
    s = (2 * v) / (LOCAL_TUNING.cadenceBase + LOCAL_TUNING.cadencePerMs * v);
    if (s < LOCAL_TUNING.minStride) s = LOCAL_TUNING.minStride;
  }
  SLEN[1] = s;
}

// ============================================================ upper body helpers

/** Arm swing (ARA: cycle, amp, elbow, elbowAmp, roll, offset): right arm forward when the left leg is forward. */
function arms(out: Pose): void {
  const c = Math.cos(ARA[0]!);
  const amp = ARA[1]!, elbow = ARA[2]!, elbowAmp = ARA[3]!, roll = ARA[4]!, offset = ARA[5]!;
  out[P.SHOULDER_R_PITCH] = offset - amp * c;
  out[P.SHOULDER_L_PITCH] = offset + amp * c;
  out[P.ELBOW_R] = elbow + elbowAmp * (c < 0 ? -c : 0);
  out[P.ELBOW_L] = elbow + elbowAmp * (c > 0 ? c : 0);
  out[P.SHOULDER_R_ROLL] = roll;
  out[P.SHOULDER_L_ROLL] = roll;
}

/** Clear the upper-body channels and root offsets the gait does not set. */
function clearUpper(out: Pose): void {
  out[P.ROOT_PITCH] = 0; out[P.ROOT_ROLL] = 0; out[P.ROOT_FWD] = 0; out[P.ROOT_SIDE] = 0;
  out[P.SPINE_PITCH] = 0; out[P.SPINE_YAW] = 0; out[P.SPINE_ROLL] = 0; out[P.HEAD_PITCH] = 0; out[P.HEAD_YAW] = 0;
}

// ============================================================ clips

/** Write the neutral standing pose (all joints 0). */
export const neutralPose: PoseFn = (out: Pose) => {
  out.fill(0);
};

/** Idle: feet planted shoulder-width, soft knees, breathing sway (PP[0] = breathing phase 0..1). */
function idleI(out: Pose): void {
  out.fill(0);
  const t0 = PP[0]!;
  const t = t0 === t0 && t0 < 1e6 && t0 > -1e6 ? t0 : 0; // fin(PP[0], 0) written out (no double crosses a call)
  const b = Math.sin(TAU * t);
  out[P.ROOT_Y] = -0.02 + 0.004 * b;
  out[P.ROOT_SIDE] = LOCAL_TUNING.breathSway * b;
  PTA[0] = 0.16; PTA[1] = 0; PTA[2] = 0.125; PTA[3] = 0;
  plantToeS(out, 1);
  PTA[0] = 0.19; PTA[1] = 0; PTA[2] = -0.125; PTA[3] = 0;
  plantToeS(out, -1);
  out[P.SPINE_PITCH] = 0.02 + LOCAL_TUNING.breathChest * 0.5 * (1 + b);
  out[P.SPINE_ROLL] = -0.6 * out[P.ROOT_SIDE]!;
  out[P.HEAD_PITCH] = -0.02 - 0.5 * LOCAL_TUNING.breathChest * b;
  out[P.HEAD_YAW] = 0.08 * Math.sin(TAU * t + 1.3);
  out[P.SHOULDER_L_ROLL] = 0.06 + 0.03 * b;
  out[P.SHOULDER_R_ROLL] = 0.06 + 0.03 * b;
  out[P.SHOULDER_L_PITCH] = 0.04;
  out[P.SHOULDER_R_PITCH] = 0.04;
  out[P.ELBOW_L] = 0.18;
  out[P.ELBOW_R] = 0.18;
}

/** Run gait + upper body (RPA: cycle, speed, sprint 0..1 blending the jog / sprint upper body and knee lift). */
function runPose(out: Pose): void {
  clearUpper(out);
  // fin() and ss() written out (no double crosses a call: see ss).
  const c0 = RPA[0]!, s0 = RPA[1]!;
  const cycle = c0 === c0 && c0 < 1e6 && c0 > -1e6 ? c0 : 0;
  const sp = s0 === s0 && s0 < 1e6 && s0 > -1e6 ? s0 : 0;
  const v = sp > 0 ? sp : 0;
  const sprint = RPA[2]!;
  GPA[0] = v; GPA[1] = 1; GPA[2] = 0; GPA[3] = sprint;
  gaitParams(RUN);
  let q = (v - 2) / (5 - 2); q = q < 0 ? 0 : q > 1 ? 1 : q;
  GLA[0] = cycle; GLA[1] = 1; GLA[2] = 0; GLA[3] = 0.05 * (q * q * (3 - 2 * q));
  gaitLegs(out);
  q = (v - 1.5) / (4 - 1.5); q = q < 0 ? 0 : q > 1 ? 1 : q;
  const run = q * q * (3 - 2 * q);
  // Pelvis twist with the stride, shoulders counter-rotate.
  q = (v - 0.2) / (1.5 - 0.2); q = q < 0 ? 0 : q > 1 ? 1 : q;
  const twist = (0.05 + 0.04 * run) * Math.sin(cycle) * (q * q * (3 - 2 * q));
  out[P.SPINE_YAW] = -twist * 1.6;
  q = (v - 4) / (8 - 4); q = q < 0 ? 0 : q > 1 ? 1 : q;
  const lean = 0.04 + 0.1 * run + 0.012 * v + 0.1 * sprint * (q * q * (3 - 2 * q));
  out[P.SPINE_PITCH] = lean;
  out[P.HEAD_PITCH] = -lean * 0.75;
  q = (v - 0.1) / (1.2 - 0.1); q = q < 0 ? 0 : q > 1 ? 1 : q;
  let amp = (0.25 + 0.45 * run + 0.03 * v) * (1 + 0.3 * sprint) * (q * q * (3 - 2 * q));
  if (amp > 1.1) amp = 1.1;
  ARA[0] = cycle; ARA[1] = amp; ARA[2] = 0.25 + (1.1 + 0.15 * sprint) * run; ARA[3] = 0.25 * run;
  ARA[4] = 0.1 + 0.04 * run; ARA[5] = -0.05 * run;
  arms(out);
}

function jogI(out: Pose): void {
  RPA[0] = PP[1]!; RPA[1] = PP[2]!; RPA[2] = 0;
  runPose(out);
}

function sprintI(out: Pose): void {
  RPA[0] = PP[1]!; RPA[1] = PP[2]!; RPA[2] = 1;
  runPose(out);
}

/** Roll into a turn: lean = turnLeanAngle(speed, side as yaw rate). Applied after IK so the legs lean with the body. */
export function applyTurnLean(out: Pose, lean: number): void {
  TLA[0] = lean;
  applyTurnLeanS(out);
}

/**
 * applyTurnLean with the lean in TLA[0] (allocation-free internal form). [INT-C] The roll pivots at the feet, not at the
 * pelvis: ROOT_ROLL turns the whole body about the root, which swung the planted feet sideways by pelvis height x
 * sin(lean) and made them slide whenever the lean changed (the yaw rate it follows moves all the time in live play);
 * the root now shifts into the turn by the same amount, so the feet stay where they are and the body leans over them.
 */
export function applyTurnLeanS(out: Pose): void {
  const lean = TLA[0]!;
  out[P.ROOT_SIDE] = out[P.ROOT_SIDE]! + (PELVIS_Y + out[P.ROOT_Y]!) * Math.sin(lean);
  out[P.ROOT_ROLL] = out[P.ROOT_ROLL]! + lean;
  out[P.SPINE_ROLL] = out[P.SPINE_ROLL]! - lean * 0.25; // head and shoulders stay a little more upright
  out[P.HEAD_YAW] = out[P.HEAD_YAW]! - lean * 0.6; // look into the turn
}

function turnLeanI(out: Pose): void {
  const s0 = PP[2]!, y0 = PP[3]!; // fin() written out (no double crosses a call)
  const speed = s0 === s0 && s0 < 1e6 && s0 > -1e6 ? s0 : 0, yaw = y0 === y0 && y0 < 1e6 && y0 > -1e6 ? y0 : 0;
  RPA[0] = PP[1]!; RPA[1] = speed; RPA[2] = PP[4] === 1 ? 1 : 0;
  runPose(out);
  let lean = Math.atan((speed * yaw) / LOCAL_TUNING.gravity);
  lean = lean < -LOCAL_TUNING.maxTurnLean ? -LOCAL_TUNING.maxTurnLean : lean > LOCAL_TUNING.maxTurnLean ? LOCAL_TUNING.maxTurnLean : lean;
  TLA[0] = lean;
  applyTurnLeanS(out);
}

/** Directional shuffle legs (SLA: t = motion direction as a fraction of a turn, cycle, speed). */
function shuffleLegs(out: Pose, st: GaitStyle): void {
  const a = TAU * SLA[0]!;
  const dx = Math.cos(a), dz = Math.sin(a);
  GPA[0] = SLA[2]!; GPA[1] = dx; GPA[2] = dz; GPA[3] = 0;
  gaitParams(st);
  GLA[0] = SLA[1]!; GLA[1] = dx; GLA[2] = dz; GLA[3] = 0.03;
  gaitLegs(out);
}

/** Lean slightly toward the motion (LIA: t, speed, k): forward pitch / side roll, scaled by speed. */
function leanInto(out: Pose): void {
  const a = TAU * LIA[0]!;
  // ss(0.3, 3, speed) written out: [QF-7R] a non-inlined call boxes its double argument and result (V8).
  let q = (LIA[1]! - 0.3) / (3 - 0.3);
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const m = q * q * (3 - 2 * q) * LIA[2]!;
  out[P.SPINE_PITCH] = out[P.SPINE_PITCH]! + 0.12 * m * Math.cos(a);
  out[P.SPINE_ROLL] = out[P.SPINE_ROLL]! + 0.12 * m * Math.sin(a);
}

/** Read and sanitise PP for the directional clips: SLA = t, cycle, speed; LIA = t, speed. */
function shuffleArgs(k: number): void {
  const t0 = PP[0]!, c0 = PP[1]!, s0 = PP[2]!; // fin() written out (no double crosses a call)
  const t = t0 === t0 && t0 < 1e6 && t0 > -1e6 ? t0 : 0;
  const cycle = c0 === c0 && c0 < 1e6 && c0 > -1e6 ? c0 : 0;
  const speed = s0 === s0 && s0 < 1e6 && s0 > -1e6 ? s0 : 0;
  SLA[0] = t; SLA[1] = cycle; SLA[2] = speed;
  LIA[0] = t; LIA[1] = speed; LIA[2] = k;
}

/** Strafe: sideways / backward steps, upright jog posture, arms swinging lightly. */
function strafeI(out: Pose): void {
  clearUpper(out);
  shuffleArgs(1);
  shuffleLegs(out, STRAFE_STYLE);
  out[P.SPINE_PITCH] = 0.08;
  out[P.HEAD_PITCH] = -0.06;
  leanInto(out);
  let q = (SLA[2]! - 0.2) / (2 - 0.2); // ss(0.2, 2, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const m = q * q * (3 - 2 * q);
  ARA[0] = SLA[1]!; ARA[1] = 0.25 * m; ARA[2] = 0.4 + 0.6 * m; ARA[3] = 0.1; ARA[4] = 0.18; ARA[5] = 0;
  arms(out);
}

/** Jockey: low, side-on crouch, arms out low for balance, quick small steps (any direction). */
function jockeyI(out: Pose): void {
  clearUpper(out);
  shuffleArgs(0.6);
  shuffleLegs(out, JOCKEY_STYLE);
  out[P.SPINE_PITCH] = 0.32;
  out[P.SPINE_YAW] = -0.18;
  out[P.HEAD_PITCH] = -0.3;
  out[P.HEAD_YAW] = 0.15;
  leanInto(out);
  let q = (SLA[2]! - 0.2) / (1.5 - 0.2); // ss(0.2, 1.5, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const s = 0.06 * Math.sin(SLA[1]!) * (q * q * (3 - 2 * q));
  out[P.SHOULDER_L_PITCH] = 0.25 + s;
  out[P.SHOULDER_R_PITCH] = 0.25 - s;
  out[P.SHOULDER_L_ROLL] = 0.5;
  out[P.SHOULDER_R_ROLL] = 0.5;
  out[P.ELBOW_L] = 0.7;
  out[P.ELBOW_R] = 0.7;
}

/** Shield: wide, low stance, back leaning into the opponent, arm out on PP[3] side (-1 left / +1 right). */
function shieldI(out: Pose): void {
  clearUpper(out);
  shuffleArgs(0.4);
  shuffleLegs(out, SHIELD_STYLE);
  const sd = PP[3]! < 0 ? -1 : 1;
  out[P.SPINE_PITCH] = 0.22;
  out[P.SPINE_ROLL] = 0.12 * sd;
  out[P.SPINE_YAW] = 0.1 * sd;
  out[P.HEAD_PITCH] = -0.18;
  out[P.HEAD_YAW] = 0.25 * sd;
  leanInto(out);
  // The arm on the opponent's side goes out and back (fending him off); the other stays low and bent.
  const out1 = sd > 0 ? P.SHOULDER_R_ROLL : P.SHOULDER_L_ROLL;
  const out1p = sd > 0 ? P.SHOULDER_R_PITCH : P.SHOULDER_L_PITCH;
  const out1e = sd > 0 ? P.ELBOW_R : P.ELBOW_L;
  const in1 = sd > 0 ? P.SHOULDER_L_ROLL : P.SHOULDER_R_ROLL;
  const in1p = sd > 0 ? P.SHOULDER_L_PITCH : P.SHOULDER_R_PITCH;
  const in1e = sd > 0 ? P.ELBOW_L : P.ELBOW_R;
  let q = (SLA[2]! - 0.2) / (1.5 - 0.2); // ss(0.2, 1.5, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const wob = 0.06 * Math.sin(SLA[1]! * 2) * (q * q * (3 - 2 * q));
  out[out1] = 1.15 + wob;
  out[out1p] = -0.25;
  out[out1e] = 0.55;
  out[in1] = 0.35;
  out[in1p] = 0.2;
  out[in1e] = 0.9;
}

/** Keeper ready: crouched on the balls of the feet, hands up in front, shuffling in any direction. */
function keeperI(out: Pose): void {
  clearUpper(out);
  shuffleArgs(0.5);
  shuffleLegs(out, KEEPER_STYLE);
  out[P.SPINE_PITCH] = 0.34;
  out[P.HEAD_PITCH] = -0.32;
  leanInto(out);
  let q = (SLA[2]! - 0.2) / (1.5 - 0.2); // ss(0.2, 1.5, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const s = 0.05 * Math.sin(SLA[1]!) * (q * q * (3 - 2 * q));
  out[P.SHOULDER_L_PITCH] = 0.85 + s;
  out[P.SHOULDER_R_PITCH] = 0.85 - s;
  out[P.SHOULDER_L_ROLL] = 0.42;
  out[P.SHOULDER_R_ROLL] = 0.42;
  out[P.ELBOW_L] = 1.15;
  out[P.ELBOW_R] = 1.15;
}

/**
 * Breathing layer for standing clips (mapper): phase 0..1, weight 0..1 (fades out with speed). Chest rise and a tiny
 * head nod; feet untouched.
 */
export function applyBreath(out: Pose, phase: number, weight: number): void {
  BRA[0] = phase; BRA[1] = weight;
  applyBreathS(out);
}

/** applyBreath with phase / weight in BRA (allocation-free internal form). */
export function applyBreathS(out: Pose): void {
  const weight = BRA[1]!;
  if (weight <= 0) return;
  const b = Math.sin(TAU * BRA[0]!) * weight;
  out[P.SPINE_PITCH] = out[P.SPINE_PITCH]! + LOCAL_TUNING.breathChest * 0.5 * b;
  out[P.HEAD_PITCH] = out[P.HEAD_PITCH]! - LOCAL_TUNING.breathChest * 0.4 * b;
  out[P.SHOULDER_L_ROLL] = out[P.SHOULDER_L_ROLL]! + 0.02 * b;
  out[P.SHOULDER_R_ROLL] = out[P.SHOULDER_R_ROLL]! + 0.02 * b;
}

/** Wrap an allocation-free PoseImpl as a contract PoseFn. */
export function poseFnOf(impl: PoseImpl): PoseFn {
  return (out: Pose, t: number, cycle: number, speed: number, side: number, foot: number): void => {
    PP[0] = t; PP[1] = cycle; PP[2] = speed; PP[3] = side; PP[4] = foot;
    impl(out);
  };
}

/** Allocation-free entry points (parameters in PP) by AnimId. */
export const LOCOMOTION_IMPLS: Partial<Record<AnimId, PoseImpl>> = {
  [AnimId.IDLE]: idleI,
  [AnimId.JOG]: jogI,
  [AnimId.SPRINT]: sprintI,
  [AnimId.TURN_LEAN]: turnLeanI,
  [AnimId.STRAFE]: strafeI,
  [AnimId.JOCKEY]: jockeyI,
  [AnimId.SHIELD]: shieldI,
  [AnimId.KEEPER_READY]: keeperI,
};

/** Idle: t = breathing phase. */
export const idlePose: PoseFn = poseFnOf(idleI);
export const jogPose: PoseFn = poseFnOf(jogI);
export const sprintPose: PoseFn = poseFnOf(sprintI);
/** Turn lean: side = yaw rate (rad/s, + = right), foot 1 = sprint style. */
export const turnLeanPose: PoseFn = poseFnOf(turnLeanI);
export const strafePose: PoseFn = poseFnOf(strafeI);
export const jockeyPose: PoseFn = poseFnOf(jockeyI);
/** Shield: side = arm side. */
export const shieldPose: PoseFn = poseFnOf(shieldI);
export const keeperReadyPose: PoseFn = poseFnOf(keeperI);

export const LOCOMOTION_POSES: PoseTable = {
  [AnimId.IDLE]: idlePose,
  [AnimId.JOG]: jogPose,
  [AnimId.SPRINT]: sprintPose,
  [AnimId.TURN_LEAN]: turnLeanPose,
  [AnimId.STRAFE]: strafePose,
  [AnimId.JOCKEY]: jockeyPose,
  [AnimId.SHIELD]: shieldPose,
  [AnimId.KEEPER_READY]: keeperReadyPose,
};

/** Clips of this table whose cycle is distance-driven (the mapper advances the stride phase for them). */
export function isLocomotion(anim: AnimId): boolean {
  return anim === AnimId.IDLE || anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.TURN_LEAN
    || anim === AnimId.STRAFE || anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY;
}

/** Lower-body channels (pelvis offsets / roll / pitch and legs): what a locomotion layer owns under upper-body clips. */
export const LOWER_BODY: readonly number[] = [
  P.ROOT_Y, P.ROOT_PITCH, P.ROOT_ROLL, P.ROOT_FWD, P.ROOT_SIDE,
  P.HIP_L_PITCH, P.HIP_L_ROLL, P.KNEE_L, P.ANKLE_L, P.HIP_R_PITCH, P.HIP_R_ROLL, P.KNEE_R, P.ANKLE_R,
];

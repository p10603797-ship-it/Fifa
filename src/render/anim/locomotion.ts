/**
 * [GFX-09] Animation: locomotion clips (idle, jog, sprint, turn lean, strafe, jockey, shield, keeper ready). Section 8
 * "Look": run cycles advance with distance travelled so feet do not slide (`cycle` is the distance-driven stride
 * phase in radians: the mapper adds 2 PI * distance / strideLengthFor(anim, speed) every frame); poses blend (GFX-12).
 * Pose layout: contracts/render.ts PoseIdx (model faces +x, +z to the player's right).
 *
 * GAIT: a cycle (2 PI) is two steps: the right foot touches down at cycle 0, the left half a cycle later (a quarter
 * cycle when side-shuffling). While a foot is planted its toe point moves backward in model space by exactly
 * stride * cycle / (2 PI) per radian, i.e. at minus the body speed, so with the mapper's distance-driven cycle the foot
 * is still in the world (no sliding); late in the stance the heel lifts and the foot rolls over the toe. Legs are
 * placed with IK (poseMath.legIK / plantToe) against the GFX-07 skeleton.
 *  - The directional clips (strafe, jockey, shield, keeper ready) use gaitLegs: swing feet on a low Hermite arc whose
 *    end velocities match the stance, staying inside the model's ground snap (fk.ts GROUND_SNAP_MAX).
 *  - [LOOK] JOG / SPRINT / TURN_LEAN use the run gait (runPose, see its comment): forefoot touchdown a little ahead of
 *    the hips, heel recovery and knee drive in the swing, a bounce with a real flight phase (the pose reports its
 *    clearance in GAIT_AIR so the model's snap keeps it), pelvis rotation and drop with counter-rotating shoulders, a
 *    whole-body lean that grows with speed and acceleration, arms pumping front to back. Stance geometry depends on
 *    speed (and the mapper's acceleration) only, so JOG and SPRINT at the same speed plant identically and cross-fade
 *    cleanly; the sprint style differs in knee drive, heel recovery, lean, bounce and arm drive.
 *
 * RUN INPUTS (RUN_IN, set by the mapper per slot, 0 otherwise): smoothed acceleration, turn lean applied before the
 * leg IK, motion direction off the facing (the planted feet travel along it).
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

import { AnimId, POSE_SIZE, PoseIdx, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';
import {
  ANKLE_Y, clamp, FPA, HEEL_X, HIP_Z, IKT, LEG_MAX, legIKS, lerp, PELVIS_Y, placeSwingFootS, plantToeS, PSA, PTA, setFootPitchS, SHIN,
  TAU, THIGH, TOE_X, wrap01,
} from './poseMath';

const P = PoseIdx;

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: render-only animation constants)
  /** Run cadence (steps per second) = cadenceBase + cadencePerMs * speed (m/s). */
  cadenceBase: 1.75,
  cadencePerMs: 0.34,
  /** Shortest stride per cycle (m), so a nearly still player never spins the cycle. */
  minStride: 0.5,
  /** Shuffle (strafe / jockey / shield / keeper) cadence base and slope (steps/s). */
  shuffleCadenceBase: 3.2,
  shuffleCadencePerMs: 0.55,
  shuffleMinStride: 0.4,
  /** [REPAIR] The keeper's shortest shuffle stride (m): small creeping steps with the feet nearly level. */
  keeperMinStride: 0.24,
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

/** Shuffle stride (strafe, jockey, shield, keeper ready), m per cycle. [REPAIR] The keeper creeps with a shorter
 *  shortest stride (keeperMinStride). */
export function shuffleStrideLength(speed: number, minStride: number = LOCAL_TUNING.shuffleMinStride): number {
  const v = speed > 0 ? (speed < 12 ? speed : 12) : 0;
  const s = (2 * v) / (LOCAL_TUNING.shuffleCadenceBase + LOCAL_TUNING.shuffleCadencePerMs * v);
  return s > minStride ? s : minStride;
}

/** Stride length the cycle of clip `anim` must advance with (m per 2 PI). Locomotion clips only; others use the run. */
export function strideLengthFor(anim: AnimId, speed: number): number {
  if (anim === AnimId.KEEPER_READY) return shuffleStrideLength(speed, LOCAL_TUNING.keeperMinStride);
  return anim === AnimId.STRAFE || anim === AnimId.JOCKEY || anim === AnimId.SHIELD ? shuffleStrideLength(speed) : strideLength(speed);
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
  /** Shortest stride (m per cycle) of a shuffle style. */
  minStride: number;
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
  shuffle: 0, minStride: LOCAL_TUNING.minStride,
  baseRest: 0.115, baseMove: 0.085, crouchRest: -0.015, crouchRun: -0.09, swingH: 0.3, heelLift: 0.9, ballLift: 0,
  centreRest: 0.15, centreMove: 0.05,
};
const STRAFE_STYLE: GaitStyle = {
  shuffle: 1, minStride: LOCAL_TUNING.shuffleMinStride,
  baseRest: 0.13, baseMove: 0.15, crouchRest: -0.04, crouchRun: -0.1, swingH: 0.14, heelLift: 0.6, ballLift: 0.05,
  centreRest: 0.15, centreMove: 0.12,
};
const JOCKEY_STYLE: GaitStyle = {
  shuffle: 1, minStride: LOCAL_TUNING.shuffleMinStride,
  baseRest: 0.19, baseMove: 0.19, crouchRest: -0.17, crouchRun: -0.06, swingH: 0.1, heelLift: 0.5, ballLift: 0.18,
  centreRest: 0.15, centreMove: 0.13,
};
const SHIELD_STYLE: GaitStyle = {
  shuffle: 1, minStride: LOCAL_TUNING.shuffleMinStride,
  baseRest: 0.21, baseMove: 0.2, crouchRest: -0.12, crouchRun: -0.05, swingH: 0.09, heelLift: 0.5, ballLift: 0.12,
  centreRest: 0.14, centreMove: 0.12,
};
const KEEPER_STYLE: GaitStyle = {
  shuffle: 1, minStride: LOCAL_TUNING.keeperMinStride,
  baseRest: 0.2, baseMove: 0.19, crouchRest: -0.2, crouchRun: -0.05, swingH: 0.09, heelLift: 0.5, ballLift: 0.2,
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
/** runPose: cycle, speed, sprint, turn lean. */
const RPA = new Float64Array(4);
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
    G[G_STRIDE] = sl > st.minStride ? sl : st.minStride;
    G[G_OFFSET] = 0.5 - 0.27 * sideways; // gallop-like side shuffle: the leading foot lands first, feet never cross
    G[G_DROP] = st.crouchRest + st.crouchRun * GC[GC_05_4]!;
    // [REPAIR] The swing height reaches its working value by 0.2 m/s (it scaled with ss(0, 1.2, v): a keeper
    // creeping at 0.2 m/s lifted his boot 4 mm and read as gliding); it still goes to 0 as the player stops.
    let q = v / 0.2; q = q > 1 ? 1 : q; q = q * q * (3 - 2 * q);
    G[G_SWING] = st.swingH * q * (0.6 + 0.1 * v);
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
  // [REPAIR] A shuffle step leaves and lands with the boot still in the world (tangent 1: the swing starts and ends at
  // the stance velocity); 0.55 let the boot skate forward along the grass at either end of every side step.
  G[G_TANGENT] = st.shuffle === 1 ? 1 : 0.55 - 0.3 * GC[GC_4_8]!;
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
  // [REPAIR] Shuffle steps lift off and set down briskly (sin^2; sin^4 kept the boot within a few mm of the grass for
  // the first and last fifth of the swing, where it read as a slide).
  F[2] = G[G_TANGENT]! >= 1 ? H * sn * sn : H * sn * sn * sn * sn;
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
  let air = 9;
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
    if (F[2]! < air) air = F[2]!;
  }
  // [REPAIR] The side gallop (G_OFFSET < 0.5) has a short flight with both feet up: report it like the run does, so
  // the model's ground snap keeps it instead of pulling the lower swing boot down onto the grass (where it slid).
  GAIT_AIR[0] = air > 0 && air < 9 ? air : 0;
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
    const mn = anim === AnimId.KEEPER_READY ? LOCAL_TUNING.keeperMinStride : LOCAL_TUNING.shuffleMinStride;
    if (s < mn) s = mn;
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

/**
 * [LOOK] Run gait (JOG, SPRINT, TURN_LEAN; the walk at low speed is the same gait). Real running mechanics, stylised:
 *  - STANCE: the toe point is planted (it moves back at exactly the body speed: no sliding) from a forefoot-ish
 *    touchdown a little ahead of the hips (runShape.tdToe, closer under the body while accelerating), the heel settles,
 *    then rolls up to a pointed toe-off (toPitch) far behind the hips.
 *  - SWING: the ankle follows a spline through two knee keys converted to ankle points by planar FK from the mean hip:
 *    heel recovery (thigh near vertical, knee folded: in a sprint the heel comes up toward the glutes) and knee drive
 *    (thigh up in front, shin under the knee), from the toe-off point to the touchdown point with end velocities that
 *    follow the stance. The foot dorsiflexes in the air ("toes up") and comes down onto the forefoot.
 *  - PELVIS: lowest just after touchdown / through mid-stance, highest in the flight phase (a run is a bounce, a walk
 *    an inverted pendulum: the walk keeps its own small bob). A reach guard lowers it where a leg would otherwise
 *    straighten past the soft IK range (no planted foot can be pulled off its spot); it covers the swing ankle too, so
 *    it eases off smoothly as a foot leaves the grass. Pelvis yaw follows the swinging
 *    leg, the hip on the swing side drops a little in stance; shoulders counter-rotate and the head stays steady.
 *  - LEAN: the whole body inclines from the feet (root pitch carries the pelvis and trunk; a little spine flexion on
 *    top), more with speed, the sprint style and acceleration (RUN_IN[0]), back on braking. A turn lean (RUN_IN[1],
 *    TURN_LEAN's own) rolls the body over the feet BEFORE the legs are solved, so the feet stay planted and the inside
 *    leg flexes. The feet travel along the motion direction (RUN_IN[2]): running a little off the facing does not drag
 *    the planted boot sideways.
 *  - ARMS: swing front to back opposite the legs, elbows about 85-95 degrees in a jog, closing in front and opening
 *    behind in a sprint, hands at the side of the body (never across the midline).
 * Stance placement depends on speed (and acceleration) only, never on the jog / sprint style, so JOG and SPRINT at the
 * same speed plant identically and cross-fade without moving a planted boot.
 * GAIT_AIR: the lowest sole height the pose means to have (> 0 only while both feet are off the grass). The mapper hands
 * it to the model, whose ground snap keeps that clearance instead of pulling a flight phase down to the grass.
 */
const RUN_SHAPE = {
  /** Swing knee keys [thigh angle from vertical (rad, + forward), knee flexion (rad)]: heel recovery and knee drive. */
  recWalk: [-0.08, 0.85], recJog: [0.0, 1.32], recSprint: [0.06, 2.12],
  drvWalk: [0.36, 0.62], drvJog: [0.74, 1.22], drvSprint: [1.12, 1.42],
  /** Swing progress of the recovery and drive keys (walk -> run). */
  s1Walk: 0.38, s1Run: 0.34, s2Walk: 0.74, s2Run: 0.7,
  /** Toe point at touchdown ahead of the hips (m): base + share of the stance travel, walk and run. */
  tdWalkBase: 0.1, tdWalkTravel: 0.45, tdRunBase: 0.24, tdRunTravel: 0.25,
  /** Acceleration (m/s^2 smoothed, mapper) at which the accelerating / braking posture is full. */
  accFull: 4, brakeFull: 5,
} as const;

/** Run inputs the mapper sets for the slot it is posing (0 for plain PoseFn calls): [0] smoothed acceleration along
 *  the motion (m/s^2), [1] turn lean (rad, + = right) applied before the leg IK, [2] motion direction off the facing
 *  (rad, + = right). */
export const RUN_IN = new Float64Array(3);
/** Lowest sole height (m, model space) the last locomotion pose means to have: > 0 only in a flight phase. */
export const GAIT_AIR = new Float64Array(1);
/**
 * [REPAIR] Planted-toe correction per leg (0 right, 1 left; m along the motion, 0 for plain PoseFn calls), set by the
 * mapper for the slot it poses. The stance line (toe = tdToe - T * lu / D) plants a boot exactly only at a steady
 * speed: while the speed changes inside one stance (a start from rest crosses the walk -> run blend, where the duty
 * factor and the touchdown point change fast) it moved the planted toe by up to 15 cm. The mapper integrates where the
 * planted toe really is (latched at touchdown, moved back by the distance travelled) and hands the difference here:
 * added in full in the stance, faded out over the first part of the swing (no pop at toe-off), 0 again at touchdown.
 * [REPAIR 2] RUN_PLANT[2..3]: the same for the lateral position (m, + = the model's +z), used when a run starts from a
 * standing clip: the boot the run has planted stays where it stood (it is wider apart in the idle stance).
 */
export const RUN_PLANT = new Float64Array(4);
const PLANT_MAX = 0.3;
const PLANT_Z_MAX = 0.1;
/** [REPAIR] Lowest mid-swing sole height of the run gait (m, at full step). */
const SWING_CLEAR = 0.035;

/** runTdS scratch: in [0] speed (m/s), [1] smoothed acceleration (m/s^2), [2] stance travel T (m); out [3] the
 *  touchdown toe ahead of the hips (m), [4] walk -> run factor r. Shared by runPose and runPlantRefS. */
const RTD = new Float64Array(5);
function runTdS(): void {
  const v = RTD[0]!, acc = RTD[1]!, T = RTD[2]!;
  let q = (v - 1.6) / 2; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const r = q * q * (3 - 2 * q);
  q = acc / RUN_SHAPE.accFull; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const accP = q * q * (3 - 2 * q);
  q = -acc / RUN_SHAPE.brakeFull; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const accN = q * q * (3 - 2 * q) * r;
  const tdW = RUN_SHAPE.tdWalkBase + RUN_SHAPE.tdWalkTravel * T;
  RTD[3] = tdW + (RUN_SHAPE.tdRunBase + RUN_SHAPE.tdRunTravel * T - tdW) * r - 0.07 * accP * r + 0.05 * accN;
  RTD[4] = r;
}

/**
 * [REPAIR] The run's stance line for the mapper's planted-toe tracking (RUN_PLANT). In: RPF[0] cycle (rad), RPF[1]
 * speed (m/s), RPF[2] smoothed acceleration (m/s^2). Out per leg (right, left): RPF[3..4] the toe along the motion the
 * stance line gives (extended past toe-off into the swing), RPF[5..6] the leg phase (0 = touchdown), RPF[7] the duty,
 * RPF[8] the feet half spacing (m).
 */
export const RPF = new Float64Array(9);
export function runPlantRefS(): void {
  const c0 = RPF[0]!, s0 = RPF[1]!, a0 = RPF[2]!;
  const cycle = c0 === c0 && c0 < 1e6 && c0 > -1e6 ? c0 : 0;
  const sp = s0 === s0 && s0 < 1e6 && s0 > -1e6 ? s0 : 0;
  const v = sp > 0 ? (sp < 12 ? sp : 12) : 0;
  GPA[0] = v; GPA[1] = 1; GPA[2] = 0; GPA[3] = 0;
  gaitParams(RUN);
  const D = G[G_DUTY]!, T = G[G_TRAVEL]!;
  RTD[0] = v; RTD[1] = a0 === a0 && a0 < 1e3 && a0 > -1e3 ? a0 : 0; RTD[2] = T;
  runTdS();
  let u = cycle / TAU;
  u -= Math.floor(u);
  if (u >= 1) u = 0;
  for (let leg = 0; leg < 2; leg++) {
    let lu = u;
    if (leg === 1) { lu = u - 0.5; lu -= Math.floor(lu); if (lu >= 1) lu = 0; }
    RPF[3 + leg] = RTD[3]! - (T * lu) / D;
    RPF[5 + leg] = lu;
  }
  RPF[7] = D;
  RPF[8] = G[G_BASE]!;
}

/** Run legs scratch: per leg (0 right, 1 left) planted flag, toe / ankle along the motion, height, pitch, lowest sole,
 *  ankle along / up, leg phase, the share of the planted-toe correction still applied (1 in the stance). */
const RL = new Float64Array(18);
const RL_STRIDE = 9, RL_PLANT = 0, RL_X = 1, RL_Y = 2, RL_P = 3, RL_LOW = 4, RL_AX = 5, RL_AY = 6, RL_U = 7, RL_W = 8;

/** Run gait + upper body (RPA: cycle, speed, sprint 0..1 blending the jog / sprint style, turn lean before the IK). */
function runPose(out: Pose): void {
  clearUpper(out);
  GAIT_AIR[0] = 0;
  // fin() and ss() written out (no double crosses a call).
  const c0 = RPA[0]!, s0 = RPA[1]!, l0 = RPA[3]!;
  const cycle = c0 === c0 && c0 < 1e6 && c0 > -1e6 ? c0 : 0;
  const sp = s0 === s0 && s0 < 1e6 && s0 > -1e6 ? s0 : 0;
  let leanTurn = l0 === l0 && l0 < 1e6 && l0 > -1e6 ? l0 : 0;
  leanTurn = leanTurn < -0.6 ? -0.6 : leanTurn > 0.6 ? 0.6 : leanTurn;
  const v = sp > 0 ? (sp < 12 ? sp : 12) : 0;
  const sprint = RPA[2]!;
  GPA[0] = v; GPA[1] = 1; GPA[2] = 0; GPA[3] = 0;
  gaitParams(RUN);
  const D = G[G_DUTY]!, T = G[G_TRAVEL]!, base = G[G_BASE]!;
  const move = GC[GC_0_12]!;
  let u = cycle / TAU;
  u -= Math.floor(u);
  if (u >= 1) u = 0;
  // Speed factors: r = walk -> run, f = run -> top speed.
  let q = (v - 1.6) / 2; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const r = q * q * (3 - 2 * q);
  // Planted-toe corrections (mapper, RUN_PLANT): right, left.
  let pl0 = RUN_PLANT[0]!, pl1 = RUN_PLANT[1]!;
  pl0 = pl0 === pl0 ? (pl0 < -PLANT_MAX ? -PLANT_MAX : pl0 > PLANT_MAX ? PLANT_MAX : pl0) : 0;
  pl1 = pl1 === pl1 ? (pl1 < -PLANT_MAX ? -PLANT_MAX : pl1 > PLANT_MAX ? PLANT_MAX : pl1) : 0;
  let pz0 = RUN_PLANT[2]!, pz1 = RUN_PLANT[3]!;
  pz0 = pz0 === pz0 ? (pz0 < -PLANT_Z_MAX ? -PLANT_Z_MAX : pz0 > PLANT_Z_MAX ? PLANT_Z_MAX : pz0) : 0;
  pz1 = pz1 === pz1 ? (pz1 < -PLANT_Z_MAX ? -PLANT_Z_MAX : pz1 > PLANT_Z_MAX ? PLANT_Z_MAX : pz1) : 0;
  q = (v - 4) / 4.5; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const f = q * q * (3 - 2 * q);
  q = (v - 0.1) / 1.1; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const armMove = q * q * (3 - 2 * q);
  // Acceleration (mapper): accelerating 0..1, braking 0..1.
  const a0 = RUN_IN[0]!;
  const acc = a0 === a0 && a0 < 1e3 && a0 > -1e3 ? a0 : 0;
  q = acc / RUN_SHAPE.accFull; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const accP = q * q * (3 - 2 * q);
  q = -acc / RUN_SHAPE.brakeFull; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const accN = q * q * (3 - 2 * q) * r;
  // Athletic drive: 0 relaxed jog .. 1 full sprint (style, top speed and acceleration).
  let drive = sprint * (0.6 + 0.4 * f) + 0.35 * f * (1 - sprint) + 0.35 * accP * r;
  drive = drive < 0 ? 0 : drive > 1 ? 1 : drive;
  // Motion direction off the facing: the feet travel along it.
  const o0 = RUN_IN[2]!;
  let off = o0 === o0 && o0 < 10 && o0 > -10 ? o0 : 0;
  off = off < -0.9 ? -0.9 : off > 0.9 ? 0.9 : off;
  const dX = Math.cos(off), dZ = Math.sin(off);

  // ---- stance geometry (speed and acceleration only: identical for the jog and the sprint style)
  RTD[0] = v; RTD[1] = acc; RTD[2] = T;
  runTdS();
  const tdToe = RTD[3]!;
  q = (v - 0.2) / 1; q = q < 0 ? 0 : q > 1 ? 1 : q;
  const toPitch = -(0.85 + 0.4 * r) * (q * q * (3 - 2 * q));
  const tdPitch = -(0.06 + 0.16 * f) * r;
  const msPitch = -0.04 * f * r;
  // ---- pelvis: mean height and bob (lowest through the stance, highest in flight; a walk is highest mid-stance)
  const A = (0.022 + 0.008 * drive) * r * move;
  const Aw = 0.012 * (1 - r) * move;
  // [REPAIR] Half the drive / acceleration share of the drop (the accelerating live run sat low with bent knees all
  // through the cycle); the reach guard below still keeps the stance leg off full extension.
  const mean = -0.012 - 0.03 * r - 0.005 * drive - 0.01 * accP * r;
  let phi = 2 * u; phi -= Math.floor(phi);
  const bob = -A * Math.cos(TAU * (phi - D * (0.6 + 0.5 * f))) + Aw * Math.cos(TAU * (phi - D));
  const hipMean = PELVIS_Y + mean;
  // ---- pelvis rotation (yaw toward the swinging leg) and drop (swing side), turn lean
  const cyc = Math.cos(TAU * (u + 0.02));
  const yawP = (0.045 + 0.035 * r + 0.03 * drive) * move;
  const dropR = 0.045 * r * move;
  const dropC = Math.cos(TAU * (u - D * 0.45));
  const roll = -dropR * dropC + leanTurn;
  const sinRoll = Math.sin(roll);

  // ---- swing keys -> ankle points (planar FK from the mean hip, along the motion)
  const s1 = RUN_SHAPE.s1Walk + (RUN_SHAPE.s1Run - RUN_SHAPE.s1Walk) * r;
  const s2 = RUN_SHAPE.s2Walk + (RUN_SHAPE.s2Run - RUN_SHAPE.s2Walk) * r;
  const jd = drive * (0.4 + 0.6 * r);
  let th = RUN_SHAPE.recWalk[0] + (RUN_SHAPE.recJog[0] - RUN_SHAPE.recWalk[0]) * r;
  let kn = RUN_SHAPE.recWalk[1] + (RUN_SHAPE.recJog[1] - RUN_SHAPE.recWalk[1]) * r;
  th += (RUN_SHAPE.recSprint[0] - th) * jd; kn += (RUN_SHAPE.recSprint[1] - kn) * jd;
  let x1 = THIGH * Math.sin(th) + SHIN * Math.sin(th - kn);
  let y1 = hipMean - THIGH * Math.cos(th) - SHIN * Math.cos(th - kn);
  th = RUN_SHAPE.drvWalk[0] + (RUN_SHAPE.drvJog[0] - RUN_SHAPE.drvWalk[0]) * r;
  kn = RUN_SHAPE.drvWalk[1] + (RUN_SHAPE.drvJog[1] - RUN_SHAPE.drvWalk[1]) * r;
  th += (RUN_SHAPE.drvSprint[0] - th) * jd; kn += (RUN_SHAPE.drvSprint[1] - kn) * jd;
  let x2 = THIGH * Math.sin(th) + SHIN * Math.sin(th - kn);
  let y2 = hipMean - THIGH * Math.cos(th) - SHIN * Math.cos(th - kn);
  // Toe-off and touchdown ankles (toe point on the grass at the stance ends' pitch).
  const toToe = tdToe - T;
  let cp = Math.cos(toPitch), sn = Math.sin(toPitch);
  const x0 = toToe - (TOE_X * cp + ANKLE_Y * sn), y0 = -(TOE_X * sn - ANKLE_Y * cp);
  cp = Math.cos(tdPitch); sn = Math.sin(tdPitch);
  const x3 = tdToe - (TOE_X * cp + ANKLE_Y * sn), y3 = -(TOE_X * sn - ANKLE_Y * cp);
  // A slow walk lifts the foot less: pull the keys toward the chord.
  x1 = x0 + (x3 - x0) * s1 + (x1 - x0 - (x3 - x0) * s1) * move;
  y1 = y0 + (y3 - y0) * s1 + (y1 - y0 - (y3 - y0) * s1) * move;
  x2 = x0 + (x3 - x0) * s2 + (x2 - x0 - (x3 - x0) * s2) * move;
  y2 = y0 + (y3 - y0) * s2 + (y2 - y0 - (y3 - y0) * s2) * move;
  // Spline tangents (m per unit of swing progress): the ends follow the stance (foot leaving / arriving backward).
  const vSt = (T * (1 - D)) / D;
  const m0x = -0.25 * vSt, m0y = 0.25 + 0.7 * r;
  const m3x = -0.15 * vSt, m3y = -(0.2 + 0.45 * r);
  // Interior tangents: monotone (harmonic mean of the chord slopes, flat at a local extreme), so the foot does not
  // overshoot the touchdown point forward (no reaching, straight-legged landing) nor dip between the keys.
  let d0 = (x1 - x0) / s1, d1 = (x2 - x1) / (s2 - s1), d2 = (x3 - x2) / (1 - s2);
  const m1x = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1), m2x = d1 * d2 <= 0 ? 0 : (2 * d1 * d2) / (d1 + d2);
  d0 = (y1 - y0) / s1; d1 = (y2 - y1) / (s2 - s1); d2 = (y3 - y2) / (1 - s2);
  const m1y = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1), m2y = d1 * d2 <= 0 ? 0 : (2 * d1 * d2) / (d1 + d2);

  // ---- both feet: planted toe or swing ankle (along the motion, heights absolute)
  for (let leg = 0; leg < 2; leg++) {
    let lu = u;
    if (leg === 1) { lu = u - 0.5; lu -= Math.floor(lu); if (lu >= 1) lu = 0; }
    const o = leg * RL_STRIDE;
    RL[o + RL_U] = lu;
    if (lu < D) {
      const s = lu / D;
      let e = s / 0.35; e = e > 1 ? 1 : e; e = e * e * (3 - 2 * e);
      let rl = (s - 0.35) / 0.65; rl = rl < 0 ? 0 : rl > 1 ? 1 : rl; rl = rl * rl * (3 - 2 * rl);
      const p = tdPitch + (msPitch - tdPitch) * e + (toPitch - msPitch) * rl * Math.sqrt(rl);
      const tx = tdToe - T * s + (leg === 0 ? pl0 : pl1);
      cp = Math.cos(p); sn = Math.sin(p);
      RL[o + RL_PLANT] = 1; RL[o + RL_X] = tx; RL[o + RL_Y] = 0; RL[o + RL_P] = p; RL[o + RL_LOW] = 0; RL[o + RL_W] = 1;
      RL[o + RL_AX] = tx - (TOE_X * cp + ANKLE_Y * sn); RL[o + RL_AY] = -(TOE_X * sn - ANKLE_Y * cp);
    } else {
      const s = (lu - D) / (1 - D);
      let xa: number, ya: number, xb: number, yb: number, ma: number, na: number, mb: number, nb: number, t0: number, t1: number;
      if (s < s1) { xa = x0; ya = y0; xb = x1; yb = y1; ma = m0x; na = m0y; mb = m1x; nb = m1y; t0 = 0; t1 = s1; }
      else if (s < s2) { xa = x1; ya = y1; xb = x2; yb = y2; ma = m1x; na = m1y; mb = m2x; nb = m2y; t0 = s1; t1 = s2; }
      else { xa = x2; ya = y2; xb = x3; yb = y3; ma = m2x; na = m2y; mb = m3x; nb = m3y; t0 = s2; t1 = 1; }
      const h = t1 - t0;
      const w = (s - t0) / h, w2 = w * w, w3 = w2 * w;
      const h00 = 2 * w3 - 3 * w2 + 1, h10 = w3 - 2 * w2 + w, h01 = -2 * w3 + 3 * w2, h11 = w3 - w2;
      // The planted-toe correction carried into the swing fades out by 40 % of it (continuous at toe-off).
      let wl = s / 0.4; wl = wl > 1 ? 1 : wl; wl = 1 - wl * wl * (3 - 2 * wl);
      RL[o + RL_PLANT] = 0; RL[o + RL_W] = wl;
      RL[o + RL_AX] = h00 * xa + h10 * h * ma + h01 * xb + h11 * h * mb + (leg === 0 ? pl0 : pl1) * wl;
      RL[o + RL_AY] = h00 * ya + h10 * h * na + h01 * yb + h11 * h * nb;
      RL[o + RL_X] = s; // swing progress (pitch below)
    }
  }

  // ---- pelvis height: the bob, lowered where a planted leg would straighten past the soft IK range
  let rootY = mean + bob;
  const rsEst = (PELVIS_Y + rootY) * Math.sin(leanTurn);
  const lMax = LEG_MAX * 0.955;
  // Both legs: a swing ankle must be reachable too, and the guard eases off as the foot leaves the grass (no pop).
  for (let leg = 0; leg < 2; leg++) {
    const o = leg * RL_STRIDE;
    const side = leg === 0 ? 1 : -1;
    const ax = RL[o + RL_AX]! * dX;
    const dz = side * base + RL[o + RL_AX]! * dZ + (leg === 0 ? pz0 : pz1) * RL[o + RL_W]! - rsEst - side * HIP_Z;
    let rem = lMax * lMax - ax * ax - dz * dz;
    rem = rem > 0 ? Math.sqrt(rem) : 0;
    const yMax = RL[o + RL_AY]! + rem - PELVIS_Y + side * HIP_Z * sinRoll;
    // Smooth minimum (continuous slope) of the wanted height and the reachable one.
    let dd = rootY - yMax;
    rootY = 0.5 * (rootY + yMax - Math.sqrt(dd * dd + 0.0002));
    // The toe-off and touchdown ankles are the farthest reaches of a step: their constraint fades in over a window
    // around those instants, so the pelvis eases down into them instead of dipping in a V.
    const lu = RL[o + RL_U]!;
    for (let k = 0; k < 2; k++) {
      let du = k === 0 ? lu - D : lu;
      du -= Math.floor(du + 0.5);
      if (du > 0.15 || du < -0.15) continue;
      const xe = k === 0 ? x0 + (leg === 0 ? pl0 : pl1) : x3, ye = k === 0 ? y0 : y3;
      const ex = xe * dX, ez = side * base + xe * dZ + (k === 0 ? (leg === 0 ? pz0 : pz1) : 0) - rsEst - side * HIP_Z;
      rem = lMax * lMax - ex * ex - ez * ez;
      rem = rem > 0 ? Math.sqrt(rem) : 0;
      const yv = ye + rem - PELVIS_Y + side * HIP_Z * sinRoll + 6 * du * du;
      dd = rootY - yv;
      rootY = 0.5 * (rootY + yv - Math.sqrt(dd * dd + 0.0002));
    }
  }
  // ---- body lean (whole body from the feet; spine flexion on top), root channels
  const leanB = 0.03 + 0.06 * r + 0.03 * f + 0.08 * sprint * r + 0.12 * accP - 0.1 * accN;
  out[P.ROOT_Y] = rootY;
  out[P.ROOT_PITCH] = 0.6 * leanB;
  out[P.ROOT_ROLL] = roll;
  out[P.ROOT_YAW] = yawP * cyc;
  out[P.ROOT_SIDE] = (PELVIS_Y + rootY) * Math.sin(leanTurn);

  // ---- legs by IK
  let air = 9;
  for (let leg = 0; leg < 2; leg++) {
    const o = leg * RL_STRIDE;
    const side = leg === 0 ? 1 : -1;
    if (RL[o + RL_PLANT] === 1) {
      const tx = RL[o + RL_X]!;
      PTA[0] = tx * dX; PTA[1] = 0; PTA[2] = side * base + tx * dZ + (leg === 0 ? pz0 : pz1); PTA[3] = RL[o + RL_P]!;
      plantToeS(out, side);
      air = 0;
      continue;
    }
    const s = RL[o + RL_X]!;
    const al = RL[o + RL_AX]!;
    let ay = RL[o + RL_AY]!;
    const ax = al * dX, az = side * base + al * dZ + (leg === 0 ? pz0 : pz1) * RL[o + RL_W]!;
    // Shin angle from vertical (+ forward) of the planar two-bone solution for this ankle: the foot pitch is set
    // relative to it (toes up in the air), blended from the toe-off pitch and into the touchdown pitch.
    const hy = PELVIS_Y + rootY - side * HIP_Z * sinRoll;
    const ddy = ay - hy;
    let L = Math.sqrt(ax * ax + ddy * ddy) / (THIGH + SHIN);
    L = L > 1 ? 1 : L;
    const shin = Math.atan2(ax, -ddy) - Math.acos(L);
    // [REPAIR] The toe-off pitch lets go by 15 % of the swing (it was held to about 20 %, and the boot trailed
    // pointed behind the runner as the heel came up); the foot dorsiflexes more through the heel recovery.
    let e = (0.15 - s) / 0.15; e = e < 0 ? 0 : e > 1 ? 1 : e; const wA = e * e * (3 - 2 * e);
    e = (s - s2) / (1 - s2); e = e < 0 ? 0 : e > 1 ? 1 : e; const wB = e * e * (3 - 2 * e);
    e = (s - s1) / (s2 - s1); e = e < 0 ? 0 : e > 1 ? 1 : e; e = e * e * (3 - 2 * e);
    const rel = (0.14 + 0.24 * drive) + (0.1 - 0.02 * drive) * e;
    const p = wA * toPitch + wB * tdPitch + (1 - wA - wB) * (shin + rel);
    cp = Math.cos(p); sn = Math.sin(p);
    const tl = TOE_X * sn - ANKLE_Y * cp, hl = HEEL_X * sn - ANKLE_Y * cp;
    let low = ay + (tl < hl ? tl : hl);
    // [REPAIR] Mid-swing clearance: the walk -> slow-jog swing (below about 2 m/s) brushed the toe along the grass
    // (it read as a scuffing, sliding boot). Lift the swing foot softly to at least SWING_CLEAR * move mid-swing
    // (nothing at toe-off and touchdown, so the stance ends are unchanged).
    const wc = 4 * s * (1 - s);
    const dl = SWING_CLEAR * move * wc - low;
    const lift = 0.5 * (dl + Math.sqrt(dl * dl + 0.00004)) * wc;
    ay += lift; low += lift;
    if (low < 0) { ay -= low; low = 0; }
    if (low < air) air = low;
    IKT[0] = ax; IKT[1] = ay; IKT[2] = az;
    legIKS(out, side);
    FPA[0] = p;
    setFootPitchS(out, side);
  }
  GAIT_AIR[0] = air < 9 ? air : 0;

  // ---- trunk, head: shoulders counter-rotate, the head stays steady
  const S = (0.04 + 0.05 * r + 0.03 * drive) * move;
  out[P.SPINE_YAW] = -(yawP + S) * cyc;
  out[P.SPINE_ROLL] = dropR * dropC * 0.85 - leanTurn * 0.25;
  out[P.SPINE_PITCH] = 0.4 * leanB + 0.025 * r * Math.cos(TAU * (phi - D));
  out[P.HEAD_PITCH] = 0.04 + 0.3 * leanB - out[P.ROOT_PITCH]! - out[P.SPINE_PITCH]!;
  out[P.HEAD_YAW] = 0.9 * S * cyc - leanTurn * 0.6;
  // ---- arms: front to back opposite the legs (left arm forward as the right foot lands), elbows bent
  const ca = Math.cos(TAU * u - 0.25);
  let amp = ((0.2 + 0.24 * r + 0.08 * f) * (1 - drive) + (0.25 + 0.42 * r + 0.18 * f) * drive + 0.1 * accP) * armMove;
  if (amp > 1.15) amp = 1.15;
  // [REPAIR] Forward swing a little lower and less closed (the sprinting fist reached the collar and read as crossing
  // the body from a 3/4 front view), the back drive a little longer.
  const mid = (0.03 + 0.06 * drive) * r;
  out[P.SHOULDER_L_PITCH] = mid + amp * ca;
  out[P.SHOULDER_R_PITCH] = mid - amp * ca;
  const eb = 0.3 * (1 - r) + (1.42 + 0.08 * drive) * r;
  const ea = (0.1 - 0.02 * drive) * r + 0.08 * (1 - r);
  out[P.ELBOW_L] = eb + ea * ca;
  out[P.ELBOW_R] = eb - ea * ca;
  // A touch more abduction as an arm comes forward keeps the hand on its own side of the chest (never across).
  out[P.SHOULDER_L_ROLL] = 0.075 + 0.06 * ca;
  out[P.SHOULDER_R_ROLL] = 0.075 - 0.06 * ca;
}

function jogI(out: Pose): void {
  RPA[0] = PP[1]!; RPA[1] = PP[2]!; RPA[2] = 0; RPA[3] = RUN_IN[1]!;
  runPose(out);
}

function sprintI(out: Pose): void {
  RPA[0] = PP[1]!; RPA[1] = PP[2]!; RPA[2] = 1; RPA[3] = RUN_IN[1]!;
  runPose(out);
}

/** Roll into a turn: lean = turnLeanAngle(speed, side as yaw rate). Applied after IK (layer for non-run clips). */
export function applyTurnLean(out: Pose, lean: number): void {
  TLA[0] = lean;
  applyTurnLeanS(out);
}

/**
 * applyTurnLean with the lean in TLA[0] (allocation-free internal form): the lean layer of the clips that are not the
 * run gait (strafe, jockey, shield, keeper ready). [INT-C] The roll pivots at the feet, not at the pelvis: ROOT_ROLL
 * turns the whole body about the root, which swung the planted feet sideways by pelvis height x sin(lean) and made them
 * slide whenever the lean changed; the root shifts into the turn by the same amount, so the feet stay where they are.
 * The run gait (JOG / SPRINT / TURN_LEAN) leans before its leg IK instead (RUN_IN[1]).
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
  let lean = Math.atan((speed * yaw) / LOCAL_TUNING.gravity);
  lean = lean < -LOCAL_TUNING.maxTurnLean ? -LOCAL_TUNING.maxTurnLean : lean > LOCAL_TUNING.maxTurnLean ? LOCAL_TUNING.maxTurnLean : lean;
  RPA[0] = PP[1]!; RPA[1] = speed; RPA[2] = PP[4] === 1 ? 1 : 0; RPA[3] = lean + RUN_IN[1]!;
  runPose(out);
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

/** [REPAIR] Keeper set position at rest (keeperI): toe ahead of the hips (m), feet half spacing (m), pelvis drop
 *  (m), foot pitch (rad, - = heel up: weight on the forefoot). Arms: shoulder pitch / roll, elbow (rad). */
const KEEPER_SET = { toeX: 0.26, halfWidth: 0.245, drop: -0.17, pitch: -0.2, shPitch: 0.42, shRoll: 0.1, elbow: 1.3 } as const;
/** keeperI scratch: the moving (shuffle) legs while blending into the set position at rest. */
const KEEPER_MOVE = new Float32Array(POSE_SIZE);

/**
 * Keeper ready: crouched on the balls of the feet, hands up in front, shuffling in any direction. [REPAIR] At rest the
 * keeper stands in a square set position (feet parallel, wider than the shoulders, heels up, knees bent over the feet,
 * both hands level in front of the waist with the elbows a little out); the shuffle takes over as he starts moving
 * (by about 0.6 m/s, before the feet have travelled a stride). The rest pose used to be a frozen frame of the shuffle:
 * one foot ahead of the other, knees in, and the hands out wide at chest height.
 */
function keeperI(out: Pose): void {
  clearUpper(out);
  shuffleArgs(0.5);
  shuffleLegs(out, KEEPER_STYLE);
  // [REPAIR] Handed over to the shuffle by 0.12 m/s (it was 0.6): a part-blended set position keeps its boots still
  // in the body frame, so a keeper creeping at 0.2 m/s glided on them for metres without a step. The keeper's shorter
  // creeping stride (KEEPER_MIN_STRIDE) keeps the shuffle's slow frames close to the set position, so the hand-over
  // moves the boots only a few cm.
  let q = (SLA[2]! - 0.02) / (0.12 - 0.02); // ss(0.02, 0.12, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const mv = q * q * (3 - 2 * q);
  if (mv < 1) {
    for (let k = 0; k < LOWER_BODY.length; k++) { const c = LOWER_BODY[k]!; KEEPER_MOVE[c] = out[c]!; }
    out[P.ROOT_Y] = KEEPER_SET.drop; out[P.ROOT_SIDE] = 0; out[P.ROOT_ROLL] = 0; out[P.ROOT_YAW] = 0;
    out[P.ROOT_PITCH] = 0; out[P.ROOT_FWD] = 0;
    PTA[0] = KEEPER_SET.toeX; PTA[1] = 0; PTA[2] = KEEPER_SET.halfWidth; PTA[3] = KEEPER_SET.pitch;
    plantToeS(out, 1);
    PTA[0] = KEEPER_SET.toeX; PTA[1] = 0; PTA[2] = -KEEPER_SET.halfWidth; PTA[3] = KEEPER_SET.pitch;
    plantToeS(out, -1);
    for (let k = 0; k < LOWER_BODY.length; k++) {
      const c = LOWER_BODY[k]!;
      out[c] = out[c]! + (KEEPER_MOVE[c]! - out[c]!) * mv;
    }
    GAIT_AIR[0] = GAIT_AIR[0]! * mv; // the set feet are on the grass
  }
  out[P.SPINE_PITCH] = 0.34;
  out[P.HEAD_PITCH] = -0.32;
  leanInto(out);
  q = (SLA[2]! - 0.2) / (1.5 - 0.2); // ss(0.2, 1.5, speed) written out (no double crosses a call)
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  const s = 0.05 * Math.sin(SLA[1]!) * (q * q * (3 - 2 * q));
  // Hands level in front of the waist at rest, a little higher and wider while shuffling (the old carriage).
  const shP = KEEPER_SET.shPitch + (0.85 - KEEPER_SET.shPitch) * mv;
  const shR = KEEPER_SET.shRoll + (0.42 - KEEPER_SET.shRoll) * mv;
  const el = KEEPER_SET.elbow + (1.15 - KEEPER_SET.elbow) * mv;
  out[P.SHOULDER_L_PITCH] = shP + s;
  out[P.SHOULDER_R_PITCH] = shP - s;
  out[P.SHOULDER_L_ROLL] = shR;
  out[P.SHOULDER_R_ROLL] = shR;
  out[P.ELBOW_L] = el;
  out[P.ELBOW_R] = el;
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

/** Lower-body channels (pelvis offsets / roll / pitch / yaw and legs): what a locomotion layer owns under upper-body
 *  clips. [LOOK] Pelvis yaw too: the run's legs are solved for its rotating pelvis. */
export const LOWER_BODY: readonly number[] = [
  P.ROOT_Y, P.ROOT_PITCH, P.ROOT_ROLL, P.ROOT_YAW, P.ROOT_FWD, P.ROOT_SIDE,
  P.HIP_L_PITCH, P.HIP_L_ROLL, P.KNEE_L, P.ANKLE_L, P.HIP_R_PITCH, P.HIP_R_ROLL, P.KNEE_R, P.ANKLE_R,
];

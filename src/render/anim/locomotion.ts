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
import { clamp, lerp, placeSwingFoot, plantToe, smooth01, smoothRange, TAU, toeHeightForLowest, wrap01 } from './poseMath';

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

function gaitParams(st: GaitStyle, speed: number, forward: number, sideways: number, sprintStyle: number): void {
  const v = speed > 0 ? (speed < 12 ? speed : 12) : 0;
  const move = smoothRange(0, 1.2, v);
  if (st.shuffle === 1) {
    G[G_DUTY] = 0.6;
    G[G_STRIDE] = shuffleStrideLength(v);
    G[G_OFFSET] = 0.5 - 0.27 * sideways; // gallop-like side shuffle: the leading foot lands first, feet never cross
    G[G_DROP] = st.crouchRest + st.crouchRun * smoothRange(0.5, 4, v);
    G[G_SWING] = st.swingH * move * (0.6 + 0.1 * v);
  } else {
    G[G_DUTY] = runDuty(v);
    G[G_STRIDE] = strideLength(v);
    G[G_OFFSET] = 0.5;
    G[G_DROP] = st.crouchRest + (st.crouchRun - st.crouchRest) * smoothRange(0, 1.2, v) - 0.04 * smoothRange(4, 8, v)
      - 0.03 * smoothRange(6.5, 10, v);
    const h = v < 1.6 ? 0.1 * (v / 1.6) : lerp(0.1, st.swingH, smoothRange(1.6, 5, v)) + 0.012 * Math.max(0, v - 5);
    G[G_SWING] = h * (1 + 0.15 * sprintStyle) * move;
  }
  // Stance travel = duty * stride exactly: the planted toe moves back at the body speed (no sliding).
  G[G_TRAVEL] = G[G_DUTY]! * G[G_STRIDE]!;
  G[G_BASE] = lerp(st.baseRest, st.baseMove, move);
  G[G_HEEL] = st.heelLift * smoothRange(0.2, 1.2, v);
  // A crouched pelvis puts the feet further forward so the shins stay near vertical (ankles in range).
  const deep = -G[G_DROP]! - 0.06;
  // Walking steps sit under the hips; running ones land a little further ahead (centreMove).
  const centre = st.shuffle === 1
    ? lerp(st.centreRest, st.centreMove, smoothRange(0.5, 3, v))
    : lerp(st.centreRest, 0, smoothRange(0.3, 1.5, v)) + st.centreMove * smoothRange(2, 4.5, v);
  G[G_CENTRE] = centre + (deep > 0 ? deep * 1.1 : 0);
  G[G_BALL] = st.ballLift;
  // Swing end tangents (fraction of the stance velocity): a smaller pull-back at speed keeps the feet in reach.
  G[G_TANGENT] = lerp(0.55, 0.25, smoothRange(4, 8, v));
  // The heel rolls up only when stepping forward (a backward or side step leaves the foot flat / on its ball).
  if (forward < 1) G[G_HEEL] = G[G_HEEL]! * (forward > 0 ? forward : 0);
  if (G[G_HEEL]! < st.ballLift) G[G_HEEL] = st.ballLift;
}

/** Per-foot placement scratch: toe x, z offset along the motion, lowest-sole height, pitch, planted (1/0). */
const F = new Float64Array(5);

/**
 * Foot placement for a leg at its own phase u (0..1, 0 = touchdown) along the motion axis: F[0] = position along
 * the motion (m, relative to the stance centre), F[2] = lowest sole height (m), F[3] = foot pitch, F[4] = planted.
 */
function footAt(u: number): void {
  const duty = G[G_DUTY]!, travel = G[G_TRAVEL]!, heel = G[G_HEEL]!, H = G[G_SWING]!;
  if (u < duty) {
    const s = u / duty; // stance progress
    F[0] = travel * (0.5 - s);
    F[2] = 0;
    const roll = smoothRange(0.55, 1, s);
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
  F[3] = -heel * (1 - s) * (1 - s) - ball * s * s + 0.28 * sn * s * smooth01(H * 8);
  F[4] = 0;
}

/**
 * Legs of a gait: pelvis height, pelvis yaw, both feet by IK. dirX/dirZ = unit motion direction in model space.
 * Writes ROOT_Y, ROOT_YAW, hips, knees, ankles. Reads G (gaitParams first).
 */
function gaitLegs(out: Pose, cycle: number, dirX: number, dirZ: number, bob: number): void {
  const u = wrap01(cycle / TAU);
  const duty = G[G_DUTY]!;
  const travel = G[G_TRAVEL]!;
  // Pelvis: highest over each mid-stance (two bobs per cycle), where the planted leg is under the body; lower at
  // touchdown / toe-off where the leg reaches out (keeps knees and ankles in a natural range at any stride).
  const midR = duty * 0.5;
  out[P.ROOT_Y] = G[G_DROP]! + bob * travel * Math.cos(TAU * 2 * (u - midR)) * 0.5;
  out[P.ROOT_YAW] = 0;
  const base = G[G_BASE]!;
  for (let leg = 0; leg < 2; leg++) {
    const side = leg === 0 ? 1 : -1; // right first: touchdown at u = 0
    const lu = leg === 0 ? u : wrap01(u - G[G_OFFSET]!);
    footAt(lu);
    const along = F[0]!;
    const pitch = F[3]!;
    // Feet move along the motion direction; the stance centre sits ahead of the hips along +x (toe ahead of ankle).
    const tx = G[G_CENTRE]! + along * dirX;
    const tz = side * base + along * dirZ;
    if (F[4] === 1) plantToe(out, side, tx, toeHeightForLowest(F[2]!, pitch), tz, pitch);
    else placeSwingFoot(out, side, tx, F[2]!, tz, pitch);
  }
}

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
  if (st === RUN) gaitParams(RUN, fin(speed, 0), 1, 0, 0);
  else gaitParams(st, fin(speed, 0), Math.cos(a), Math.sin(a), 0);
  const u = wrap01(fin(cycle, 0) / TAU);
  const lu = side > 0 ? u : wrap01(u - G[G_OFFSET]!);
  const duty = G[G_DUTY]!;
  return lu < duty ? lu / duty : -1;
}

// ============================================================ upper body helpers

/** Arm swing: right arm forward when the left leg is forward (cycle PI). */
function arms(out: Pose, cycle: number, amp: number, elbow: number, elbowAmp: number, roll: number, offset: number): void {
  const c = Math.cos(cycle);
  out[P.SHOULDER_R_PITCH] = offset - amp * c;
  out[P.SHOULDER_L_PITCH] = offset + amp * c;
  out[P.ELBOW_R] = elbow + elbowAmp * Math.max(0, -c);
  out[P.ELBOW_L] = elbow + elbowAmp * Math.max(0, c);
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

/** Idle: feet planted shoulder-width, soft knees, breathing sway (t = breathing phase 0..1). */
export const idlePose: PoseFn = (out, t) => {
  out.fill(0);
  t = fin(t, 0);
  const b = Math.sin(TAU * t);
  out[P.ROOT_Y] = -0.02 + 0.004 * b;
  out[P.ROOT_SIDE] = LOCAL_TUNING.breathSway * Math.sin(TAU * t);
  plantToe(out, 1, 0.16, 0, 0.125, 0);
  plantToe(out, -1, 0.19, 0, -0.125, 0);
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
};

/** Run gait + upper body. sprint 0..1 blends the jog / sprint upper body and knee lift. */
function runPose(out: Pose, cycle: number, speed: number, sprint: number): void {
  clearUpper(out);
  cycle = fin(cycle, 0);
  const v = fin(speed, 0) > 0 ? fin(speed, 0) : 0;
  gaitParams(RUN, v, 1, 0, sprint);
  gaitLegs(out, cycle, 1, 0, 0.05 * smoothRange(2, 5, v));
  const run = smoothRange(1.5, 4, v);
  // Pelvis twist with the stride, shoulders counter-rotate.
  const twist = (0.05 + 0.04 * run) * Math.sin(cycle) * smoothRange(0.2, 1.5, v);
  out[P.SPINE_YAW] = -twist * 1.6;
  const lean = 0.04 + 0.1 * run + 0.012 * v + 0.1 * sprint * smoothRange(4, 8, v);
  out[P.SPINE_PITCH] = lean;
  out[P.HEAD_PITCH] = -lean * 0.75;
  let amp = (0.25 + 0.45 * run + 0.03 * v) * (1 + 0.3 * sprint) * smoothRange(0.1, 1.2, v);
  if (amp > 1.1) amp = 1.1;
  const elbow = lerp(0.25, 1.35 + 0.15 * sprint, run);
  arms(out, cycle, amp, elbow, 0.25 * run, 0.1 + 0.04 * run, -0.05 * run);
}

export const jogPose: PoseFn = (out, _t, cycle, speed) => {
  runPose(out, cycle, speed, 0);
};

export const sprintPose: PoseFn = (out, _t, cycle, speed) => {
  runPose(out, cycle, speed, 1);
};

/** Roll into a turn: lean = turnLeanAngle(speed, side as yaw rate). Applied after IK so the legs lean with the body. */
export function applyTurnLean(out: Pose, lean: number): void {
  out[P.ROOT_ROLL] = out[P.ROOT_ROLL]! + lean;
  out[P.SPINE_ROLL] = out[P.SPINE_ROLL]! - lean * 0.25; // head and shoulders stay a little more upright
  out[P.HEAD_YAW] = out[P.HEAD_YAW]! - lean * 0.6; // look into the turn
}

export const turnLeanPose: PoseFn = (out, _t, cycle, speed, side, foot) => {
  runPose(out, cycle, speed, foot === 1 ? 1 : 0);
  applyTurnLean(out, turnLeanAngle(fin(speed, 0), fin(side, 0)));
};

/** Directional shuffle legs: t = motion direction (fraction of a turn). Returns nothing; reads/writes `out`. */
function shuffleLegs(out: Pose, st: GaitStyle, t: number, cycle: number, speed: number): void {
  t = fin(t, 0); cycle = fin(cycle, 0); speed = fin(speed, 0);
  const a = TAU * t;
  const dx = Math.cos(a), dz = Math.sin(a);
  gaitParams(st, speed, dx, dz, 0);
  gaitLegs(out, cycle, dx, dz, 0.03);
}

/** Lean slightly toward the motion (forward pitch / side roll), scaled by speed. */
function leanInto(out: Pose, t: number, speed: number, k: number): void {
  const a = TAU * t;
  const m = smoothRange(0.3, 3, speed) * k;
  out[P.SPINE_PITCH] = out[P.SPINE_PITCH]! + 0.12 * m * Math.cos(a);
  out[P.SPINE_ROLL] = out[P.SPINE_ROLL]! + 0.12 * m * Math.sin(a);
}

/** Strafe: sideways / backward steps, upright jog posture, arms swinging lightly. */
export const strafePose: PoseFn = (out, t, cycle, speed) => {
  clearUpper(out);
  t = fin(t, 0); cycle = fin(cycle, 0); speed = fin(speed, 0);
  shuffleLegs(out, STRAFE_STYLE, t, cycle, speed);
  out[P.SPINE_PITCH] = 0.08;
  out[P.HEAD_PITCH] = -0.06;
  leanInto(out, t, speed, 1);
  const m = smoothRange(0.2, 2, speed);
  arms(out, cycle, 0.25 * m, 0.4 + 0.6 * m, 0.1, 0.18, 0);
};

/** Jockey: low, side-on crouch, arms out low for balance, quick small steps (any direction). */
export const jockeyPose: PoseFn = (out, t, cycle, speed) => {
  clearUpper(out);
  t = fin(t, 0); cycle = fin(cycle, 0); speed = fin(speed, 0);
  shuffleLegs(out, JOCKEY_STYLE, t, cycle, speed);
  out[P.SPINE_PITCH] = 0.32;
  out[P.SPINE_YAW] = -0.18;
  out[P.HEAD_PITCH] = -0.3;
  out[P.HEAD_YAW] = 0.15;
  leanInto(out, t, speed, 0.6);
  const s = 0.06 * Math.sin(cycle) * smoothRange(0.2, 1.5, speed);
  out[P.SHOULDER_L_PITCH] = 0.25 + s;
  out[P.SHOULDER_R_PITCH] = 0.25 - s;
  out[P.SHOULDER_L_ROLL] = 0.5;
  out[P.SHOULDER_R_ROLL] = 0.5;
  out[P.ELBOW_L] = 0.7;
  out[P.ELBOW_R] = 0.7;
};

/** Shield: wide, low stance, back leaning into the opponent, arm out on `side` (-1 left / +1 right). */
export const shieldPose: PoseFn = (out, t, cycle, speed, side) => {
  clearUpper(out);
  t = fin(t, 0); cycle = fin(cycle, 0); speed = fin(speed, 0);
  shuffleLegs(out, SHIELD_STYLE, t, cycle, speed);
  const sd = side < 0 ? -1 : 1;
  out[P.SPINE_PITCH] = 0.22;
  out[P.SPINE_ROLL] = 0.12 * sd;
  out[P.SPINE_YAW] = 0.1 * sd;
  out[P.HEAD_PITCH] = -0.18;
  out[P.HEAD_YAW] = 0.25 * sd;
  leanInto(out, t, speed, 0.4);
  // The arm on the opponent's side goes out and back (fending him off); the other stays low and bent.
  const out1 = sd > 0 ? P.SHOULDER_R_ROLL : P.SHOULDER_L_ROLL;
  const out1p = sd > 0 ? P.SHOULDER_R_PITCH : P.SHOULDER_L_PITCH;
  const out1e = sd > 0 ? P.ELBOW_R : P.ELBOW_L;
  const in1 = sd > 0 ? P.SHOULDER_L_ROLL : P.SHOULDER_R_ROLL;
  const in1p = sd > 0 ? P.SHOULDER_L_PITCH : P.SHOULDER_R_PITCH;
  const in1e = sd > 0 ? P.ELBOW_L : P.ELBOW_R;
  const wob = 0.06 * Math.sin(cycle * 2) * smoothRange(0.2, 1.5, speed);
  out[out1] = 1.15 + wob;
  out[out1p] = -0.25;
  out[out1e] = 0.55;
  out[in1] = 0.35;
  out[in1p] = 0.2;
  out[in1e] = 0.9;
};

/** Keeper ready: crouched on the balls of the feet, hands up in front, shuffling in any direction. */
export const keeperReadyPose: PoseFn = (out, t, cycle, speed) => {
  clearUpper(out);
  t = fin(t, 0); cycle = fin(cycle, 0); speed = fin(speed, 0);
  shuffleLegs(out, KEEPER_STYLE, t, cycle, speed);
  out[P.SPINE_PITCH] = 0.34;
  out[P.HEAD_PITCH] = -0.32;
  leanInto(out, t, speed, 0.5);
  const s = 0.05 * Math.sin(cycle) * smoothRange(0.2, 1.5, speed);
  out[P.SHOULDER_L_PITCH] = 0.85 + s;
  out[P.SHOULDER_R_PITCH] = 0.85 - s;
  out[P.SHOULDER_L_ROLL] = 0.42;
  out[P.SHOULDER_R_ROLL] = 0.42;
  out[P.ELBOW_L] = 1.15;
  out[P.ELBOW_R] = 1.15;
};

/**
 * Breathing layer for standing clips (mapper): phase 0..1, weight 0..1 (fades out with speed). Chest rise and a tiny
 * head nod; feet untouched.
 */
export function applyBreath(out: Pose, phase: number, weight: number): void {
  if (weight <= 0) return;
  const b = Math.sin(TAU * phase) * weight;
  out[P.SPINE_PITCH] = out[P.SPINE_PITCH]! + LOCAL_TUNING.breathChest * 0.5 * b;
  out[P.HEAD_PITCH] = out[P.HEAD_PITCH]! - LOCAL_TUNING.breathChest * 0.4 * b;
  out[P.SHOULDER_L_ROLL] = out[P.SHOULDER_L_ROLL]! + 0.02 * b;
  out[P.SHOULDER_R_ROLL] = out[P.SHOULDER_R_ROLL]! + 0.02 * b;
}

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

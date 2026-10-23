/**
 * [GFX-07] Player skeleton and forward kinematics (helper of src/render/players/model.ts). Pure maths: no Three.js,
 * no DOM, no allocation per call. Animation agents (GFX-09..12) use it in Node tests to measure where a pose puts
 * the feet and hands ("the FK helper from GFX-07"): solvePoseFK + groundLift, or footPoint / handPoint.
 *
 * MODEL SPACE (contracts/render.ts): the player stands at the origin facing +x, +y up, +z is his right; the ground
 * is y = 0; distances are metres of the reference body (180 cm). World = T(x, 0, z) * R(facing) * S(height / 180)
 * * model, so every model-space length, including the ROOT_* offsets, scales with the player's height.
 *
 * JOINT FRAMES: each joint is an affine frame of 12 numbers [c0 | c1 | c2 | t] (column-major 3x4: the images of the
 * local x, y, z axes, then the origin). Limbs hang along their local -y; the torso and head rise along local +y; a
 * boot points along its local +x. Rotation order per joint (applied to child points right to left):
 *   ROOT     = T(ROOT_FWD, pelvisY + ROOT_Y, ROOT_SIDE) Ry(ROOT_YAW) Rx(ROOT_ROLL) Rz(-ROOT_PITCH)
 *   SPINE    = ROOT  T(0, spineY, 0) Ry(SPINE_YAW) Rx(SPINE_ROLL) Rz(-SPINE_PITCH)
 *   HEAD     = SPINE T(0, neckY, 0) Ry(HEAD_YAW) Rz(-HEAD_PITCH)          (pivot at the neck base)
 *   SHOULDER = SPINE T(0, shoulderY, -/+shoulderZ) Rz(SHOULDER_PITCH) Rx(-/+(SHOULDER_ROLL + armRestRoll))
 *   ELBOW    = SHOULDER T(0, -upperArm, 0) Rz(ELBOW)
 *   HIP      = ROOT  T(0, 0, -/+hipZ) Rz(HIP_PITCH) Rx(-/+HIP_ROLL)
 *   KNEE     = HIP   T(0, -thigh, 0) Rz(-KNEE)
 *   ANKLE    = KNEE  T(0, -shin, 0) Rz(ANKLE)
 * (-/+ = left / right.) Sign meanings, as in contracts/render.ts: pitch + moves the far end of a segment toward +x
 * (limbs swing forward, the trunk and head lean forward / nod down); ROOT_ROLL / SPINE_ROLL + lean toward the right;
 * yaw + turns left; shoulder / hip roll + moves the limb away from the body; KNEE + bends the shin backward; ELBOW +
 * bends the forearm forward; ANKLE + lifts the toes (dorsiflexion), - points them. A zero pose stands upright with
 * the soles on the ground, arms hanging just clear of the body (armRestRoll). Non-finite pose values read as 0.
 *
 * GROUND: groundSkeleton() keeps every body part above the grass (never sinks) and plants small floats when the pose
 * is not airborne (ROOT_Y <= 0 and the lowest point is less than LOCAL_TUNING.groundSnapMax above the ground).
 *
 * PERFORMANCE: the per-frame entry points (solvePoseFK, groundSkeleton, placeSkeleton, writeJointMatrix) pass only
 * integers and typed arrays between functions, so V8 never boxes a double at a call boundary (zero allocation per
 * frame, tests/perf/gfx-07-alloc.test.ts). Helpers taking plain numbers (postRot*, framePoint, groundLift,
 * placeSkeletonAt, footPoint...) are for tests and tools.
 */

import { POSE_SIZE, PoseIdx } from '../../contracts/render';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: render only)
  /** A grounded pose (ROOT_Y <= 0) whose lowest point floats less than this is planted on the grass (m, model). */
  groundSnapMax: 0.06,
} as const;

/** Snap distance the model uses (m, model space). */
export const GROUND_SNAP_MAX = LOCAL_TUNING.groundSnapMax;

/** Reference body (metres, 180 cm player). The geometry in parts.ts is built against the same numbers. */
export const BODY = {
  /** Total height, sole to crown. */
  height: 1.8,
  /** Hip joint height above the ground in the zero pose. */
  pelvisY: 0.94,
  /** Hip joints sideways from the pelvis centre. */
  hipZ: 0.095,
  thigh: 0.43,
  shin: 0.43,
  /** Ankle joint above the sole (pelvisY - thigh - shin). */
  ankleY: 0.08,
  /**
   * Spine pivot above the hip joints. 0: the trunk bends about the hip line, 5 cm above the shirt hem, so a lean
   * barely slides the hem over the (rigid) shorts.
   */
  spineY: 0,
  /** Neck base above the spine pivot. */
  neckY: 0.535,
  /** Shoulder joints above the spine pivot and sideways from the centre line. */
  shoulderY: 0.475,
  shoulderZ: 0.235,
  upperArm: 0.29,
  foreArm: 0.25,
  /** Hand length below the wrist (end of the forearm). */
  hand: 0.1,
  /** Head centre above the neck base and its half extents (front-back, up-down, side-side). */
  headY: 0.2,
  headRX: 0.112,
  headRY: 0.125,
  headRZ: 0.1,
  /** Boot: toe and heel along the foot (+x) from the ankle joint, sole below the ankle joint. */
  toeX: 0.2,
  heelX: -0.07,
  /** Arms hang this far out from the body in the zero pose (rad), so hands clear the hips. */
  armRestRoll: 0.08,
} as const;

/** Joint indices into a frame block (JOINT_COUNT frames of FRAME_SIZE numbers). */
export const Joint = {
  ROOT: 0,
  SPINE: 1,
  HEAD: 2,
  SHOULDER_L: 3,
  ELBOW_L: 4,
  SHOULDER_R: 5,
  ELBOW_R: 6,
  HIP_L: 7,
  KNEE_L: 8,
  ANKLE_L: 9,
  HIP_R: 10,
  KNEE_R: 11,
  ANKLE_R: 12,
} as const;

export const JOINT_COUNT = 13;
/** Numbers per joint frame: c0 (3), c1 (3), c2 (3), t (3). */
export const FRAME_SIZE = 12;
/** Numbers per player (all joints). */
export const SKELETON_SIZE = JOINT_COUNT * FRAME_SIZE;

/** A block of joint frames for one player (model or world space). */
export function createSkeleton(): Float64Array {
  return new Float64Array(SKELETON_SIZE);
}

// ============================================================ affine frame operations (tests / tools)

export function setIdentity(F: Float64Array, o: number): void {
  F[o] = 1; F[o + 1] = 0; F[o + 2] = 0;
  F[o + 3] = 0; F[o + 4] = 1; F[o + 5] = 0;
  F[o + 6] = 0; F[o + 7] = 0; F[o + 8] = 1;
  F[o + 9] = 0; F[o + 10] = 0; F[o + 11] = 0;
}

export function copyFrame(F: Float64Array, o: number, G: Float64Array, p: number): void {
  for (let k = 0; k < FRAME_SIZE; k++) F[o + k] = G[p + k]!;
}

/** F = F * T(x, y, z). */
export function postTranslate(F: Float64Array, o: number, x: number, y: number, z: number): void {
  F[o + 9] = F[o + 9]! + F[o]! * x + F[o + 3]! * y + F[o + 6]! * z;
  F[o + 10] = F[o + 10]! + F[o + 1]! * x + F[o + 4]! * y + F[o + 7]! * z;
  F[o + 11] = F[o + 11]! + F[o + 2]! * x + F[o + 5]! * y + F[o + 8]! * z;
}

/** F = F * Rx(a) (right-hand rule about local x). */
export function postRotX(F: Float64Array, o: number, a: number): void {
  ARG[0] = a;
  rotX(F, o, ARG_ANGLE);
}

/** F = F * Ry(a). */
export function postRotY(F: Float64Array, o: number, a: number): void {
  ARG[0] = a;
  rotY(F, o, ARG_ANGLE);
}

/** F = F * Rz(a). */
export function postRotZ(F: Float64Array, o: number, a: number): void {
  ARG[0] = a;
  rotZ(F, o, ARG_ANGLE);
}

/** Point (x, y, z) of joint j's local space -> parent space of the block, written to out[0..2]. */
export function framePoint(F: Float64Array, j: number, x: number, y: number, z: number, out: Float64Array | number[]): void {
  const o = j * FRAME_SIZE;
  out[0] = F[o]! * x + F[o + 3]! * y + F[o + 6]! * z + F[o + 9]!;
  out[1] = F[o + 1]! * x + F[o + 4]! * y + F[o + 7]! * z + F[o + 10]!;
  out[2] = F[o + 2]! * x + F[o + 5]! * y + F[o + 8]! * z + F[o + 11]!;
}

// ============================================================ per-frame internals (integer arguments only)

/**
 * Angle table: the sanitised pose (indices 0..POSE_SIZE-1) followed by derived angles (signed for the chain), and
 * one slot for the postRot* helpers. Module scratch: solvePoseFK fills it, the rot helpers read it.
 */
const A = new Float64Array(POSE_SIZE + 12);
const D_SH_L_ROLL = POSE_SIZE;
const D_SH_R_ROLL = POSE_SIZE + 1;
const D_HIP_L_ROLL = POSE_SIZE + 2;
const D_HIP_R_ROLL = POSE_SIZE + 3;
const D_KNEE_L = POSE_SIZE + 4;
const D_KNEE_R = POSE_SIZE + 5;
const D_ROOT_PITCH = POSE_SIZE + 6;
const D_SPINE_PITCH = POSE_SIZE + 7;
const D_HEAD_PITCH = POSE_SIZE + 8;
/** Separate table for the postRot* test helpers (so they never disturb a solve in progress). */
const ARG = new Float64Array(1);
const ARG_ANGLE = -1;

/** F = F * Rx(angle k). */
function rotX(F: Float64Array, o: number, k: number): void {
  const a = k === ARG_ANGLE ? ARG[0]! : A[k]!;
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a);
  let y = F[o + 3]!, z = F[o + 6]!;
  F[o + 3] = y * c + z * s; F[o + 6] = z * c - y * s;
  y = F[o + 4]!; z = F[o + 7]!;
  F[o + 4] = y * c + z * s; F[o + 7] = z * c - y * s;
  y = F[o + 5]!; z = F[o + 8]!;
  F[o + 5] = y * c + z * s; F[o + 8] = z * c - y * s;
}

/** F = F * Ry(angle k). */
function rotY(F: Float64Array, o: number, k: number): void {
  const a = k === ARG_ANGLE ? ARG[0]! : A[k]!;
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a);
  let x = F[o]!, z = F[o + 6]!;
  F[o] = x * c - z * s; F[o + 6] = x * s + z * c;
  x = F[o + 1]!; z = F[o + 7]!;
  F[o + 1] = x * c - z * s; F[o + 7] = x * s + z * c;
  x = F[o + 2]!; z = F[o + 8]!;
  F[o + 2] = x * c - z * s; F[o + 8] = x * s + z * c;
}

/** F = F * Rz(angle k). */
function rotZ(F: Float64Array, o: number, k: number): void {
  const a = k === ARG_ANGLE ? ARG[0]! : A[k]!;
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a);
  let x = F[o]!, y = F[o + 3]!;
  F[o] = x * c + y * s; F[o + 3] = y * c - x * s;
  x = F[o + 1]!; y = F[o + 4]!;
  F[o + 1] = x * c + y * s; F[o + 4] = y * c - x * s;
  x = F[o + 2]!; y = F[o + 5]!;
  F[o + 2] = x * c + y * s; F[o + 5] = y * c - x * s;
}

/** Joint offsets in the parent's local space (JOINT_COUNT x 3). */
const OFFSET = new Float64Array(JOINT_COUNT * 3);
function setOffset(j: number, x: number, y: number, z: number): void {
  OFFSET[j * 3] = x; OFFSET[j * 3 + 1] = y; OFFSET[j * 3 + 2] = z;
}
setOffset(Joint.SPINE, 0, BODY.spineY, 0);
setOffset(Joint.HEAD, 0, BODY.neckY, 0);
setOffset(Joint.SHOULDER_L, 0, BODY.shoulderY, -BODY.shoulderZ);
setOffset(Joint.SHOULDER_R, 0, BODY.shoulderY, BODY.shoulderZ);
setOffset(Joint.ELBOW_L, 0, -BODY.upperArm, 0);
setOffset(Joint.ELBOW_R, 0, -BODY.upperArm, 0);
setOffset(Joint.HIP_L, 0, 0, -BODY.hipZ);
setOffset(Joint.HIP_R, 0, 0, BODY.hipZ);
setOffset(Joint.KNEE_L, 0, -BODY.thigh, 0);
setOffset(Joint.KNEE_R, 0, -BODY.thigh, 0);
setOffset(Joint.ANKLE_L, 0, -BODY.shin, 0);
setOffset(Joint.ANKLE_R, 0, -BODY.shin, 0);

/** Frame j = frame parent * T(OFFSET[j]). Returns j's offset into F. */
function child(F: Float64Array, j: number, parent: number): number {
  const o = j * FRAME_SIZE, p = parent * FRAME_SIZE;
  for (let k = 0; k < FRAME_SIZE; k++) F[o + k] = F[p + k]!;
  const x = OFFSET[j * 3]!, y = OFFSET[j * 3 + 1]!, z = OFFSET[j * 3 + 2]!;
  F[o + 9] = F[o + 9]! + F[o]! * x + F[o + 3]! * y + F[o + 6]! * z;
  F[o + 10] = F[o + 10]! + F[o + 1]! * x + F[o + 4]! * y + F[o + 7]! * z;
  F[o + 11] = F[o + 11]! + F[o + 2]! * x + F[o + 5]! * y + F[o + 8]! * z;
  return o;
}

// ============================================================ forward kinematics

/**
 * Model-space joint frames of the reference body for `pose` (see the header for the chain). Non-finite pose values
 * read as 0. No ground handling (see groundSkeleton / groundLift). No allocation.
 */
export function solvePoseFK(pose: ArrayLike<number>, out: Float64Array): void {
  const P = PoseIdx;
  for (let k = 0; k < POSE_SIZE; k++) {
    const v = pose[k]!;
    A[k] = v === v && v < 1e4 && v > -1e4 ? v : 0;
  }
  A[D_SH_L_ROLL] = A[P.SHOULDER_L_ROLL]! + BODY.armRestRoll;
  A[D_SH_R_ROLL] = -(A[P.SHOULDER_R_ROLL]! + BODY.armRestRoll);
  A[D_HIP_L_ROLL] = A[P.HIP_L_ROLL]!;
  A[D_HIP_R_ROLL] = -A[P.HIP_R_ROLL]!;
  A[D_KNEE_L] = -A[P.KNEE_L]!;
  A[D_KNEE_R] = -A[P.KNEE_R]!;
  A[D_ROOT_PITCH] = -A[P.ROOT_PITCH]!;
  A[D_SPINE_PITCH] = -A[P.SPINE_PITCH]!;
  A[D_HEAD_PITCH] = -A[P.HEAD_PITCH]!;

  setIdentity(out, 0);
  out[9] = A[P.ROOT_FWD]!;
  out[10] = BODY.pelvisY + A[P.ROOT_Y]!;
  out[11] = A[P.ROOT_SIDE]!;
  rotY(out, 0, P.ROOT_YAW);
  rotX(out, 0, P.ROOT_ROLL);
  rotZ(out, 0, D_ROOT_PITCH);

  let o = child(out, Joint.SPINE, Joint.ROOT);
  rotY(out, o, P.SPINE_YAW);
  rotX(out, o, P.SPINE_ROLL);
  rotZ(out, o, D_SPINE_PITCH);

  o = child(out, Joint.HEAD, Joint.SPINE);
  rotY(out, o, P.HEAD_YAW);
  rotZ(out, o, D_HEAD_PITCH);

  o = child(out, Joint.SHOULDER_L, Joint.SPINE);
  rotZ(out, o, P.SHOULDER_L_PITCH);
  rotX(out, o, D_SH_L_ROLL);
  o = child(out, Joint.ELBOW_L, Joint.SHOULDER_L);
  rotZ(out, o, P.ELBOW_L);

  o = child(out, Joint.SHOULDER_R, Joint.SPINE);
  rotZ(out, o, P.SHOULDER_R_PITCH);
  rotX(out, o, D_SH_R_ROLL);
  o = child(out, Joint.ELBOW_R, Joint.SHOULDER_R);
  rotZ(out, o, P.ELBOW_R);

  o = child(out, Joint.HIP_L, Joint.ROOT);
  rotZ(out, o, P.HIP_L_PITCH);
  rotX(out, o, D_HIP_L_ROLL);
  o = child(out, Joint.KNEE_L, Joint.HIP_L);
  rotZ(out, o, D_KNEE_L);
  o = child(out, Joint.ANKLE_L, Joint.KNEE_L);
  rotZ(out, o, P.ANKLE_L);

  o = child(out, Joint.HIP_R, Joint.ROOT);
  rotZ(out, o, P.HIP_R_PITCH);
  rotX(out, o, D_HIP_R_ROLL);
  o = child(out, Joint.KNEE_R, Joint.HIP_R);
  rotZ(out, o, D_KNEE_R);
  o = child(out, Joint.ANKLE_R, Joint.KNEE_R);
  rotZ(out, o, P.ANKLE_R);
}

// ============================================================ ground contact

/**
 * Points that must stay above the grass: joint, local x, y, z, radius (m). Soles (toe and heel of each boot), knees,
 * elbows, hand tips, head, pelvis and two spheres along the torso.
 */
export const CONTACT_POINTS: Readonly<Float64Array> = Float64Array.from([
  Joint.ANKLE_L, BODY.toeX, -BODY.ankleY, 0, 0,
  Joint.ANKLE_L, BODY.heelX, -BODY.ankleY, 0, 0,
  Joint.ANKLE_R, BODY.toeX, -BODY.ankleY, 0, 0,
  Joint.ANKLE_R, BODY.heelX, -BODY.ankleY, 0, 0,
  Joint.KNEE_L, 0, 0, 0, 0.06,
  Joint.KNEE_R, 0, 0, 0, 0.06,
  Joint.ELBOW_L, 0, 0, 0, 0.045,
  Joint.ELBOW_R, 0, 0, 0, 0.045,
  Joint.ELBOW_L, 0, -(BODY.foreArm + BODY.hand), 0, 0.02,
  Joint.ELBOW_R, 0, -(BODY.foreArm + BODY.hand), 0, 0.02,
  Joint.HEAD, 0, BODY.headY, 0, BODY.headRY,
  Joint.ROOT, 0, -0.02, 0, 0.12,
  Joint.SPINE, 0, 0.1, 0, 0.12,
  Joint.SPINE, 0, 0.38, 0, 0.13,
]);
const CONTACT_STRIDE = 5;

/** Ground scratch: [0] lowest point, [1] lift, [2] snap distance in use. */
const GROUND = new Float64Array(3);

/** Lowest point of F into GROUND[0]. */
function lowestInto(F: Float64Array): void {
  let low = Infinity;
  const cp = CONTACT_POINTS;
  for (let i = 0; i < cp.length; i += CONTACT_STRIDE) {
    const o = (cp[i]! | 0) * FRAME_SIZE;
    const y = F[o + 1]! * cp[i + 1]! + F[o + 4]! * cp[i + 2]! + F[o + 7]! * cp[i + 3]! + F[o + 10]! - cp[i + 4]!;
    if (y < low) low = y;
  }
  GROUND[0] = low;
}

/** Lift for F and the pose into GROUND[1] (snap distance from GROUND[2]). */
function liftInto(F: Float64Array, pose: ArrayLike<number>): void {
  lowestInto(F);
  const low = GROUND[0]!;
  let lift = 0;
  if (!(low === low) || low === Infinity || (low > -1e-9 && low < 1e-9)) lift = 0; // on the grass (rounding)
  else if (low < 0) lift = -low;
  else {
    const ry = pose[PoseIdx.ROOT_Y]!;
    const grounded = !(ry === ry && ry < 1e4 && ry > -1e4) || ry <= 0;
    if (grounded && low < GROUND[2]!) lift = -low;
  }
  GROUND[1] = lift;
}

/** Add GROUND[1] to the origin of every joint. */
function applyLift(F: Float64Array): void {
  const dy = GROUND[1]!;
  if (dy === 0) return;
  for (let j = 0; j < JOINT_COUNT; j++) F[j * FRAME_SIZE + 10] = F[j * FRAME_SIZE + 10]! + dy;
}

/**
 * Per-frame ground correction of a solved skeleton (what the model draws): lifts the body when any part would be
 * below the grass; pulls it onto the grass when the pose is grounded (ROOT_Y <= 0) and floats less than
 * GROUND_SNAP_MAX. Deliberate airborne poses (jumps, dives with ROOT_Y > 0, or floating more) are left alone.
 */
export function groundSkeleton(F: Float64Array, pose: ArrayLike<number>): void {
  GROUND[2] = GROUND_SNAP_MAX;
  liftInto(F, pose);
  applyLift(F);
}

/** Lowest point of the body (m, model space): min over CONTACT_POINTS of y - radius. (Tests / tools.) */
export function lowestPoint(F: Float64Array): number {
  lowestInto(F);
  return GROUND[0]!;
}

/** The vertical correction groundSkeleton would apply, with a given snap distance (m). (Tests / tools.) */
export function groundLift(F: Float64Array, pose: ArrayLike<number>, snapMax: number = GROUND_SNAP_MAX): number {
  GROUND[2] = snapMax;
  liftInto(F, pose);
  return GROUND[1]!;
}

/** Add dy to the origin of every joint. (Tests / tools.) */
export function liftSkeleton(F: Float64Array, dy: number): void {
  GROUND[1] = dy;
  applyLift(F);
}

// ============================================================ world placement

/** Placement parameters for placeSkeleton: x, z, facing x, facing z, scale. */
export const PLACE_SIZE = 5;

/**
 * World frames from model frames: W = T(x, 0, z) * R(facing) * S(scale) with place = [x, z, fx, fz, scale]. (fx, fz)
 * is the facing (normalised here; model +x goes there, model +z, the right hand, goes to (-fz, 0, fx)); a degenerate
 * facing reads as +x. `out` may not alias `model`. No allocation.
 */
export function placeSkeleton(model: Float64Array, out: Float64Array, place: Float64Array): void {
  const x = place[0]!, z = place[1]!, scale = place[4]!;
  let fx = place[2]!, fz = place[3]!;
  const l = Math.sqrt(fx * fx + fz * fz);
  if (l > 1e-6) { fx /= l; fz /= l; } else { fx = 1; fz = 0; }
  for (let j = 0; j < JOINT_COUNT; j++) {
    const o = j * FRAME_SIZE;
    for (let b = o; b < o + 9; b += 3) {
      const ax = model[b]!, ay = model[b + 1]!, az = model[b + 2]!;
      out[b] = (fx * ax - fz * az) * scale;
      out[b + 1] = ay * scale;
      out[b + 2] = (fz * ax + fx * az) * scale;
    }
    const tx = model[o + 9]!, ty = model[o + 10]!, tz = model[o + 11]!;
    out[o + 9] = x + (fx * tx - fz * tz) * scale;
    out[o + 10] = ty * scale;
    out[o + 11] = z + (fz * tx + fx * tz) * scale;
  }
}

const PLACE_ARGS = new Float64Array(PLACE_SIZE);

/** placeSkeleton with plain numbers. (Tests / tools.) */
export function placeSkeletonAt(model: Float64Array, out: Float64Array, x: number, z: number, fx: number, fz: number, scale: number): void {
  PLACE_ARGS[0] = x; PLACE_ARGS[1] = z; PLACE_ARGS[2] = fx; PLACE_ARGS[3] = fz; PLACE_ARGS[4] = scale;
  placeSkeleton(model, out, PLACE_ARGS);
}

/** Joint frame j -> column-major 4x4 matrix at arr[i * 16]. */
export function writeJointMatrix(F: Float64Array, j: number, arr: Float32Array, i: number): void {
  const o = j * FRAME_SIZE, m = i * 16;
  arr[m] = F[o]!; arr[m + 1] = F[o + 1]!; arr[m + 2] = F[o + 2]!; arr[m + 3] = 0;
  arr[m + 4] = F[o + 3]!; arr[m + 5] = F[o + 4]!; arr[m + 6] = F[o + 5]!; arr[m + 7] = 0;
  arr[m + 8] = F[o + 6]!; arr[m + 9] = F[o + 7]!; arr[m + 10] = F[o + 8]!; arr[m + 11] = 0;
  arr[m + 12] = F[o + 9]!; arr[m + 13] = F[o + 10]!; arr[m + 14] = F[o + 11]!; arr[m + 15] = 1;
}

/** A zero matrix (instance collapsed to a point: nothing is drawn) at arr[i * 16]. */
export function writeHiddenMatrix(arr: Float32Array, i: number): void {
  arr.fill(0, i * 16, i * 16 + 16);
}

// ============================================================ convenience for animation tests

const fkScratch = createSkeleton();

/**
 * Model-space position of a foot point after solvePoseFK + ground correction (what the model draws, before height
 * scaling and world placement). side -1 left, +1 right; which 0 = ankle joint, 1 = toe (sole), 2 = heel (sole).
 * Writes out[0..2]. snapMax as the model uses it by default (pass 0 to see the raw FK with only the never-sink rule).
 */
export function footPoint(pose: ArrayLike<number>, side: number, which: number, out: Float64Array | number[], snapMax: number = GROUND_SNAP_MAX): void {
  solvePoseFK(pose, fkScratch);
  liftSkeleton(fkScratch, groundLift(fkScratch, pose, snapMax));
  const j = side < 0 ? Joint.ANKLE_L : Joint.ANKLE_R;
  if (which === 1) framePoint(fkScratch, j, BODY.toeX, -BODY.ankleY, 0, out);
  else if (which === 2) framePoint(fkScratch, j, BODY.heelX, -BODY.ankleY, 0, out);
  else framePoint(fkScratch, j, 0, 0, 0, out);
}

/** Model-space position of the hand tip (side -1 left, +1 right) after solvePoseFK + ground correction. */
export function handPoint(pose: ArrayLike<number>, side: number, out: Float64Array | number[], snapMax: number = GROUND_SNAP_MAX): void {
  solvePoseFK(pose, fkScratch);
  liftSkeleton(fkScratch, groundLift(fkScratch, pose, snapMax));
  framePoint(fkScratch, side < 0 ? Joint.ELBOW_L : Joint.ELBOW_R, 0, -(BODY.foreArm + BODY.hand), 0, out);
}

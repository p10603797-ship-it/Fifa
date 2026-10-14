/**
 * [GFX-09..12 shared helper] Pose maths for the animation modules (locomotion.ts, actions.ts, contact.ts,
 * mapper.ts). Render side: Math.* is allowed (animation never feeds back into the sim, ARCHITECTURE rule 3).
 *
 *  - Joint limits (POSE_MIN / POSE_MAX) every clip stays inside (tests check them).
 *  - Mirroring (left / right) for sided clips.
 *  - Leg IK against the GFX-07 skeleton (src/render/players/fk.ts BODY and joint chain): legIK puts an ankle at a
 *    model-space point, compensating whatever ROOT_* values the pose already holds; plantToe puts the toe point at a
 *    model-space point with a given foot pitch (heel lift / toes up). Used for planted feet (locomotion, support legs).
 *  - Keyframed clips (createClip / evalClip): full-pose keys at normalised times, monotone cubic (PCHIP)
 *    interpolation per channel so extremes sit exactly on keys (a kicking foot's max reach is the contact key), and
 *    optional IK channels per leg (ankle target x, y, z and foot pitch) solved after the joint channels.
 *
 * Model space (contracts/render.ts): the player faces +x, +y up, +z to his right; the ground is y = 0.
 * Everything here is allocation-free per call (module scratch only); clips are built once at module load.
 */

import { POSE_SIZE, PoseIdx, type Pose } from '../../contracts/render';
import { BODY } from '../players/fk';

const P = PoseIdx;
export const TAU = Math.PI * 2;

// ============================================================ joint limits

/** Lower / upper joint limits per PoseIdx (radians, metres for ROOT_Y / ROOT_FWD / ROOT_SIDE). */
export const POSE_MIN = new Float32Array(POSE_SIZE);
export const POSE_MAX = new Float32Array(POSE_SIZE);
function lim(i: number, lo: number, hi: number): void {
  POSE_MIN[i] = lo;
  POSE_MAX[i] = hi;
}
lim(P.ROOT_Y, -0.9, 1.0);
lim(P.ROOT_PITCH, -1.7, 1.7);
lim(P.ROOT_ROLL, -1.75, 1.75);
lim(P.ROOT_YAW, -Math.PI, Math.PI);
lim(P.ROOT_FWD, -1.6, 1.6);
lim(P.ROOT_SIDE, -1.6, 1.6);
lim(P.SPINE_PITCH, -0.7, 1.25);
lim(P.SPINE_YAW, -0.9, 0.9);
lim(P.SPINE_ROLL, -0.7, 0.7);
lim(P.HEAD_PITCH, -0.9, 0.9);
lim(P.HEAD_YAW, -1.3, 1.3);
lim(P.SHOULDER_L_PITCH, -1.3, 3.25);
lim(P.SHOULDER_L_ROLL, -0.45, 3.1);
lim(P.ELBOW_L, 0, 2.6);
lim(P.SHOULDER_R_PITCH, -1.3, 3.25);
lim(P.SHOULDER_R_ROLL, -0.45, 3.1);
lim(P.ELBOW_R, 0, 2.6);
lim(P.HIP_L_PITCH, -1.1, 2.1);
lim(P.HIP_L_ROLL, -0.7, 1.1);
lim(P.KNEE_L, 0, 2.65);
lim(P.ANKLE_L, -1.1, 0.7);
lim(P.HIP_R_PITCH, -1.1, 2.1);
lim(P.HIP_R_ROLL, -0.7, 1.1);
lim(P.KNEE_R, 0, 2.65);
lim(P.ANKLE_R, -1.1, 0.7);

/** Clamp every channel of `out` into the joint limits (non-finite values become 0). */
export function clampPose(out: Pose): void {
  for (let i = 0; i < POSE_SIZE; i++) {
    const v = out[i]!;
    if (!(v === v)) { out[i] = 0; continue; }
    const lo = POSE_MIN[i]!, hi = POSE_MAX[i]!;
    out[i] = v < lo ? lo : v > hi ? hi : v;
  }
}

// ============================================================ scalar helpers

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep of x clamped to [0, 1]. */
export function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Smoothstep of x between edges a and b. */
export function smoothRange(a: number, b: number, x: number): number {
  return smooth01((x - a) / (b - a));
}

/** x modulo 1 into [0, 1). */
export function wrap01(x: number): number {
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;
}

/** Angle into [-PI, PI]. */
export function wrapPi(a: number): number {
  if (a >= -Math.PI && a <= Math.PI) return a;
  const w = a - TAU * Math.floor((a + Math.PI) / TAU);
  return w;
}

/** A "bump" 0 -> 1 -> 0 over [a, b] (sin^2 shaped), 0 outside. */
export function bump(a: number, b: number, x: number): number {
  if (x <= a || x >= b) return 0;
  const s = Math.sin(((x - a) / (b - a)) * Math.PI);
  return s * s;
}

// ============================================================ mirroring

/** Left/right channel pairs swapped by mirrorPose. */
const MIRROR_PAIRS = [
  P.SHOULDER_L_PITCH, P.SHOULDER_R_PITCH,
  P.SHOULDER_L_ROLL, P.SHOULDER_R_ROLL,
  P.ELBOW_L, P.ELBOW_R,
  P.HIP_L_PITCH, P.HIP_R_PITCH,
  P.HIP_L_ROLL, P.HIP_R_ROLL,
  P.KNEE_L, P.KNEE_R,
  P.ANKLE_L, P.ANKLE_R,
] as const;
/** Lateral channels negated by mirrorPose (roll toward the right, yaw left, offset right). */
const MIRROR_NEG = [P.ROOT_ROLL, P.ROOT_YAW, P.ROOT_SIDE, P.SPINE_YAW, P.SPINE_ROLL, P.HEAD_YAW] as const;

/** Mirror a pose left <-> right in place (swap paired limbs, negate lateral channels). */
export function mirrorPose(out: Pose): void {
  for (let k = 0; k < MIRROR_PAIRS.length; k += 2) {
    const a = MIRROR_PAIRS[k]!, b = MIRROR_PAIRS[k + 1]!;
    const v = out[a]!;
    out[a] = out[b]!;
    out[b] = v;
  }
  for (let k = 0; k < MIRROR_NEG.length; k++) {
    const i = MIRROR_NEG[k]!;
    out[i] = -out[i]!;
  }
}

/** out = a + (b - a) * w per channel (a, b, out may alias). */
export function lerpPose(out: Pose, a: ArrayLike<number>, b: ArrayLike<number>, w: number): void {
  for (let i = 0; i < POSE_SIZE; i++) {
    const x = a[i]!;
    out[i] = x + (b[i]! - x) * w;
  }
}

// ============================================================ leg IK

/** Leg segment lengths of the reference body (fk.ts BODY). */
export const THIGH = BODY.thigh;
export const SHIN = BODY.shin;
/** Longest hip -> ankle distance IK uses (a hair under a straight leg so the knee direction stays defined). */
export const LEG_MAX = (BODY.thigh + BODY.shin) * 0.9995;

/**
 * IK diagnostics of the last legIK call: [0] reach ratio (hip-ankle distance / straight leg, before clamping),
 * [1] 1 when the target was out of reach (clamped), [2..4] ankle target in model space.
 */
export const IK_INFO = new Float64Array(5);

/**
 * Put the ankle of leg `side` (-1 left, +1 right) at model-space point (ax, ay, az): writes HIP_*_PITCH, HIP_*_ROLL
 * and KNEE_* of `out`. The ROOT_* channels already in `out` (offsets, yaw, roll, pitch) are taken into account, so
 * call it after setting them. The knee always bends forward (KNEE >= 0). Out-of-reach targets straighten the leg
 * toward the target (IK_INFO[1] = 1).
 */
export function legIK(out: Pose, side: number, ax: number, ay: number, az: number): void {
  IK_INFO[2] = ax; IK_INFO[3] = ay; IK_INFO[4] = az;
  // Into the root frame: R = Ry(yaw) Rx(roll) Rz(-pitch); local = R^T (A - O) = Rz(pitch) Rx(-roll) Ry(-yaw) (A - O).
  let x = ax - out[P.ROOT_FWD]!;
  let y = ay - (BODY.pelvisY + out[P.ROOT_Y]!);
  let z = az - out[P.ROOT_SIDE]!;
  const yaw = out[P.ROOT_YAW]!, roll = out[P.ROOT_ROLL]!, pitch = out[P.ROOT_PITCH]!;
  if (yaw !== 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = c * x - s * z, nz = s * x + c * z; // Ry(-yaw)
    x = nx; z = nz;
  }
  if (roll !== 0) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const ny = c * y + s * z, nz = -s * y + c * z; // Rx(-roll)
    y = ny; z = nz;
  }
  if (pitch !== 0) {
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const nx = c * x - s * y, ny = s * x + c * y; // Rz(pitch)
    x = nx; y = ny;
  }
  const left = side < 0;
  z -= left ? -BODY.hipZ : BODY.hipZ;
  let L = Math.sqrt(x * x + y * y + z * z);
  IK_INFO[0] = L / (THIGH + SHIN);
  IK_INFO[1] = 0;
  const lMin = 0.12;
  if (L > LEG_MAX || L < lMin) {
    IK_INFO[1] = L > LEG_MAX ? 1 : 0;
    const want = L > LEG_MAX ? LEG_MAX : lMin;
    if (L < 1e-6) { x = 0; y = -want; z = 0; } else { const k = want / L; x *= k; y *= k; z *= k; }
    L = want;
  }
  const ck = (L * L - THIGH * THIGH - SHIN * SHIN) / (2 * THIGH * SHIN);
  const knee = Math.acos(ck < -1 ? -1 : ck > 1 ? 1 : ck);
  const vx = -SHIN * Math.sin(knee);
  const vy = -(THIGH + SHIN * Math.cos(knee));
  let sr = z / vy;
  sr = sr < -1 ? -1 : sr > 1 ? 1 : sr;
  const rD = Math.asin(sr);
  const hp = wrapPi(Math.atan2(y, x) - Math.atan2(vy * Math.cos(rD), vx));
  if (left) {
    out[P.HIP_L_PITCH] = hp;
    out[P.HIP_L_ROLL] = rD;
    out[P.KNEE_L] = knee;
  } else {
    out[P.HIP_R_PITCH] = hp;
    out[P.HIP_R_ROLL] = -rD;
    out[P.KNEE_R] = knee;
  }
}

/**
 * Set ANKLE_* of leg `side` so the foot's forward axis has world pitch `pitch` (+ toes up, - toes down / heel
 * lifted; 0 = flat), given the root and leg angles already in `out` (call after legIK). Exact for the pitch of the
 * boot's axis including root roll / pitch and hip roll.
 */
export function setFootPitch(out: Pose, side: number, pitch: number): void {
  const left = side < 0;
  const hp = left ? out[P.HIP_L_PITCH]! : out[P.HIP_R_PITCH]!;
  const rD = left ? out[P.HIP_L_ROLL]! : -out[P.HIP_R_ROLL]!;
  const knee = left ? out[P.KNEE_L]! : out[P.KNEE_R]!;
  const rp = out[P.ROOT_PITCH]!, rr = out[P.ROOT_ROLL]!;
  // Second row of the root rotation Ry(yaw) Rx(roll) Rz(-pitch) (world y of each root axis).
  const cr = Math.cos(rr);
  const r0 = -cr * Math.sin(rp), r1 = cr * Math.cos(rp), r2 = -Math.sin(rr);
  const chp = Math.cos(hp), shp = Math.sin(hp), crd = Math.cos(rD), srd = Math.sin(rD);
  // A = Rz(hp) Rx(rD) e_x, B = Rz(hp) Rx(rD) e_y; foot axis = cos(q) A + sin(q) B with q = ANKLE - KNEE.
  const a1 = r0 * chp + r1 * shp;
  const b1 = -r0 * shp * crd + r1 * chp * crd + r2 * srd;
  const R = Math.sqrt(a1 * a1 + b1 * b1);
  const q0 = pitch + rp - hp; // small-angle guess (picks the forward-pointing solution)
  let q = q0;
  if (R > 1e-6) {
    const sp = Math.sin(pitch) / R;
    const d = Math.atan2(b1, a1);
    const ac = Math.acos(sp < -1 ? -1 : sp > 1 ? 1 : sp);
    const qa = d + ac, qb = d - ac;
    q = Math.abs(wrapPi(qa - q0)) < Math.abs(wrapPi(qb - q0)) ? qa : qb;
    q = q0 + wrapPi(q - q0);
  }
  const ankle = q + knee;
  if (left) out[P.ANKLE_L] = clamp(ankle, POSE_MIN[P.ANKLE_L]!, POSE_MAX[P.ANKLE_L]!);
  else out[P.ANKLE_R] = clamp(ankle, POSE_MIN[P.ANKLE_R]!, POSE_MAX[P.ANKLE_R]!);
}

/** Ankle position for a toe point and foot pitch (sagittal plane, foot pointing +x): written to ANKLE_AT[0..1]. */
export const ANKLE_AT = new Float64Array(2);
export function ankleFromToe(toeX: number, toeY: number, pitch: number): void {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  // toe = ankle + Rz(pitch) (toeX, -ankleY)
  ANKLE_AT[0] = toeX - (BODY.toeX * c + BODY.ankleY * s);
  ANKLE_AT[1] = toeY - (BODY.toeX * s - BODY.ankleY * c);
}

/**
 * Plant the toe point (front of the sole) of leg `side` at model-space (toeX, toeY, toeZ) with foot pitch `pitch`
 * (0 = flat sole, - = heel lifted while the toe stays put): leg IK + ankle. ROOT_* must already be set.
 */
export function plantToe(out: Pose, side: number, toeX: number, toeY: number, toeZ: number, pitch: number): void {
  ankleFromToe(toeX, toeY, pitch);
  legIK(out, side, ANKLE_AT[0]!, ANKLE_AT[1]!, toeZ);
  setFootPitch(out, side, pitch);
}

/** Height of the lowest sole point (toe or heel) above the toe for a foot pitch: toe y for a lowest point h. */
export function toeHeightForLowest(h: number, pitch: number): number {
  // heel - toe = Rz(pitch) (heelX - toeX, 0): heel is lower than the toe when pitch > 0.
  const drop = (BODY.toeX - BODY.heelX) * Math.sin(pitch);
  return drop > 0 ? h + drop : h;
}

// ============================================================ keyframed clips

/** IK channels per leg in a clip key: ankle x, y, z (model space) and foot pitch. */
export const IK_CH = 4;
/** Per key: POSE_SIZE joint channels, then left-leg IK (4), then right-leg IK (4). */
export const KEY_SIZE = POSE_SIZE + 2 * IK_CH;
const IKL = POSE_SIZE;
const IKR = POSE_SIZE + IK_CH;

/** A keyframed clip: keys at normalised times with PCHIP tangents (built once). */
export interface Clip {
  readonly n: number;
  readonly times: Float32Array;
  /** n * KEY_SIZE values. */
  readonly values: Float32Array;
  /** n * KEY_SIZE PCHIP tangents (d value / d t). */
  readonly tangents: Float32Array;
  /** 1 when the left / right leg is driven by IK channels. */
  readonly ikLeft: number;
  readonly ikRight: number;
  /** Phase of the contact key (-1 when the clip has none). */
  readonly contact: number;
  /** Number of loops of the key sequence over t in [0, 1] (1 = play once). */
  readonly repeat: number;
}

/** A key as authored: time, joint values by PoseIdx name, optional IK targets [x, y, z, pitch] per leg. */
export interface KeySpec {
  t: number;
  pose?: Partial<Record<keyof typeof PoseIdx, number>>;
  ikL?: readonly [number, number, number, number];
  ikR?: readonly [number, number, number, number];
}

export interface ClipOptions {
  /** Time of the contact key (must match a key time), or -1. */
  contact?: number;
  repeat?: number;
}

/**
 * Build a clip (module load only). Channels missing from a key are 0 (joints) or, for IK legs, every key must give
 * the target. Times must start at 0, end at 1 and increase.
 */
export function createClip(keys: readonly KeySpec[], opts: ClipOptions = {}): Clip {
  const n = keys.length;
  const times = new Float32Array(n);
  const values = new Float32Array(n * KEY_SIZE);
  let ikLeft = 0, ikRight = 0;
  for (let k = 0; k < n; k++) {
    if (keys[k]!.ikL) ikLeft = 1;
    if (keys[k]!.ikR) ikRight = 1;
  }
  for (let k = 0; k < n; k++) {
    const key = keys[k]!;
    times[k] = key.t;
    if (k > 0 && !(key.t > keys[k - 1]!.t)) throw new Error('clip key times must increase');
    const o = k * KEY_SIZE;
    if (key.pose) {
      for (const name of Object.keys(key.pose) as (keyof typeof PoseIdx)[]) values[o + PoseIdx[name]] = key.pose[name]!;
    }
    if (ikLeft) {
      if (!key.ikL) throw new Error('every key of an IK clip needs ikL');
      for (let c = 0; c < IK_CH; c++) values[o + IKL + c] = key.ikL[c]!;
    }
    if (ikRight) {
      if (!key.ikR) throw new Error('every key of an IK clip needs ikR');
      for (let c = 0; c < IK_CH; c++) values[o + IKR + c] = key.ikR[c]!;
    }
  }
  if (times[0] !== 0 || Math.abs(times[n - 1]! - 1) > 1e-6) throw new Error('clip keys must span t = 0..1');
  const tangents = new Float32Array(n * KEY_SIZE);
  for (let ch = 0; ch < KEY_SIZE; ch++) pchipTangents(times, values, ch, tangents);
  const contact = opts.contact ?? -1;
  if (contact >= 0) {
    let found = false;
    for (let k = 0; k < n; k++) if (Math.abs(times[k]! - contact) < 1e-6) found = true;
    if (!found) throw new Error('contact must be a key time');
  }
  return { n, times, values, tangents, ikLeft, ikRight, contact, repeat: opts.repeat ?? 1 };
}

/** Fritsch-Carlson monotone tangents for one channel. */
function pchipTangents(times: Float32Array, values: Float32Array, ch: number, out: Float32Array): void {
  const n = times.length;
  if (n < 2) return;
  for (let k = 0; k < n; k++) {
    const v = values[k * KEY_SIZE + ch]!;
    let m: number;
    if (k === 0 || k === n - 1) {
      m = 0; // clips start and end at rest
    } else {
      const d0 = (v - values[(k - 1) * KEY_SIZE + ch]!) / (times[k]! - times[k - 1]!);
      const d1 = (values[(k + 1) * KEY_SIZE + ch]! - v) / (times[k + 1]! - times[k]!);
      if (d0 * d1 <= 0) m = 0;
      else {
        const h0 = times[k]! - times[k - 1]!, h1 = times[k + 1]! - times[k]!;
        const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        m = (w1 + w2) / (w1 / d0 + w2 / d1);
      }
    }
    out[k * KEY_SIZE + ch] = m;
  }
}

/** Interpolated key channels of the last evalClip (KEY_SIZE values). */
const KEY_OUT = new Float64Array(KEY_SIZE);

/**
 * Evaluate a clip at phase t (0..1; looped `repeat` times) into `out`: joint channels, then IK legs (ankle target +
 * foot pitch). Allocation-free.
 */
export function evalClip(clip: Clip, t: number, out: Pose): void {
  let u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (clip.repeat > 1) {
    u *= clip.repeat;
    u = u >= clip.repeat ? 1 : wrap01(u);
  }
  const times = clip.times, n = clip.n;
  let k = 0;
  while (k < n - 2 && u > times[k + 1]!) k++;
  const t0 = times[k]!, t1 = times[k + 1]!;
  const h = t1 - t0;
  let s = h > 0 ? (u - t0) / h : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const o0 = k * KEY_SIZE, o1 = (k + 1) * KEY_SIZE;
  const V = clip.values, M = clip.tangents;
  for (let c = 0; c < KEY_SIZE; c++) {
    KEY_OUT[c] = h00 * V[o0 + c]! + h10 * h * M[o0 + c]! + h01 * V[o1 + c]! + h11 * h * M[o1 + c]!;
  }
  for (let c = 0; c < POSE_SIZE; c++) out[c] = KEY_OUT[c]!;
  if (clip.ikLeft) {
    legIK(out, -1, KEY_OUT[IKL]!, KEY_OUT[IKL + 1]!, KEY_OUT[IKL + 2]!);
    setFootPitch(out, -1, KEY_OUT[IKL + 3]!);
  }
  if (clip.ikRight) {
    legIK(out, 1, KEY_OUT[IKR]!, KEY_OUT[IKR + 1]!, KEY_OUT[IKR + 2]!);
    setFootPitch(out, 1, KEY_OUT[IKR + 3]!);
  }
}

/** Standing ankle height above the ground for a flat foot (m). */
export const ANKLE_Y = BODY.ankleY;
/** Toe point ahead of the ankle along the foot (m). */
export const TOE_X = BODY.toeX;
/** Standing pelvis (hip joint) height (m). */
export const PELVIS_Y = BODY.pelvisY;
/** Hip joint lateral offset (m). */
export const HIP_Z = BODY.hipZ;

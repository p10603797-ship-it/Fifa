/**
 * [SIM-04] Locomotion: 360-degree analogue movement with acceleration, deceleration and a turn rate that
 * tightens at low speed; sprint (heavier touches, wider turns); jockey/strafe movement facing a look target;
 * shielding speed; stamina drain and recovery and its effect on speed/accel (section 6 "Players").
 * Top speed 7.0-9.6 m/s from pace attributes; jog ~60%. Consumes the movement intent written by the
 * resolver / AI (moveMode, ix/iz, tgtX/tgtZ/tgtSpeed, wantSprint, lookAt) and writes x, z, vx, vz, fx, fz,
 * sprinting, jockeying, shielding, stamina. Players never pass the advertising boards (BOARD_X / BOARD_Z) and
 * never enter a goal frame / net box (the keeper may stand on his line).
 *
 * Model (per active player, slot order, allocation-free):
 *  - Desired velocity from the intent:
 *      DIRECT  stick (ix, iz): |i| * jog speed (jog = jogFraction * top); wantSprint -> top speed (full at
 *              |i| >= sprintStickFull).
 *      ARRIVE  arrival steering to (tgtX, tgtZ): speed = min(tgtSpeed, top, gain * e, sqrt(2 * aBrake * e)) with
 *              e = distance - arriveSettle * arriveStop. The profile is continuous and reaches zero inside
 *              arriveStop, so players brake into the spot without overshoot and follow slowly moving targets
 *              smoothly (no stop-go); a standing player inside arriveStop stays put (no micro-steps).
 *              Speeds above jog need tgtSpeed > jog (wantSprint is not required).
 *              Targets inside a goal box are moved to its face; paths through a goal box detour round a corner.
 *      STOP    brake at T_PLAYER.decel (facing kept, or turned to the look target).
 *      LOCKED  an action owns the motion: its handler sets vx/vz (and fx/fz); locomotion only integrates them with
 *              lockedFriction deceleration (re-set vx/vz every tick for a constant speed), plus boards / goal frames.
 *  - The velocity heading turns toward the desired direction at most turnRate * DT per tick (turnRateSlow at
 *    standstill .. turnRateFast at the player's top speed, +-agilityTurnScale by agility, * sprintTurnMul when
 *    sprinting); the target speed drops with the remaining turn angle ((1 + cos) / 2) so hard turns brake first
 *    instead of orbiting. A standing player turns his body as he sets off (the speed is gated by the facing,
 *    so he never sets off backwards at speed); slow moves (< pivotSpeed) shuffle without the gate.
 *  - Speed rises at attrs.accel (x highSpeedAccelMul above jog speed) and falls at T_PLAYER.decel.
 *  - Facing turns toward the movement direction (facingTurnMul x turn rate). lookAt = 1 (jockey / strafe / shield /
 *    contain): face (lookX, lookZ) with jockeyTurnMul better turning; moving sideways/backward is capped at
 *    jockeySpeedFraction of jog (of top with wantSprint), forward up to jockeyForwardFraction. An AI ARRIVE intent
 *    whose arrival speed is far above that cap (lookBreakRatio, hysteresis lookResumeRatio, never for keepers)
 *    turns and runs instead. act SHIELD caps speed at shieldSpeedFraction of jog.
 *  - Stamina: drains while sprinting (staminaDrainSprint) or jogging (staminaDrainJog), recovers otherwise, all
 *    scaled by the stamina attribute; below staminaLowThreshold speed and acceleration fall linearly to
 *    staminaFloorMul (staminaFactor, also used for accuracy by SIM-06/08/11).
 * ticksToReach: closed-form estimate fitted to this model (turn time with braking and sideways drift for a moving
 * player, two-phase acceleration or braking to the speed cap, cruise); within 15% of the simulated time.
 */
import {
  BOARD_X, BOARD_Z, DT, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, POST_RADIUS, TICK_HZ,
} from '../../contracts/constants';
import { ActionKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { T_PLAYER } from '../../contracts/tuning';
import { MoveMode, type PlayerAttrs, type PlayerState, type SimState } from '../../contracts/state';
import { PI } from '../core/dmath';
import { createV2, rotateToward2, type V2 } from '../core/vec';

export const LOCAL_TUNING = { // TUNING-CR (SIM-04): move into T_PLAYER
  /** Weight of the acceleration attribute in top speed (rest is sprintSpeed), 0..1. */
  topSpeedAccelWeight: 0.15,
  /** Acceleration multiplier above jog speed (sprint build-up), unitless. */
  highSpeedAccelMul: 0.6,
  /** Stick magnitude at which a sprint reaches top speed, 0..1. */
  sprintStickFull: 0.6,
  /** Stick magnitude below which the stick counts as released, 0..1. */
  stickDead: 0.02,
  /** Below this speed a player counts as standing (heading snaps to the wanted direction), m/s. */
  moveEps: 0.05,
  /** Desired speed at and above which the turn/facing speed gate applies in full (slower moves shuffle), m/s. */
  pivotSpeed: 2.0,
  /** Facing turn rate as a multiple of the movement turn rate. */
  facingTurnMul: 1.5,
  /** Deceleration while LOCKED (an action owns the motion), m/s^2. */
  lockedFriction: 6.0,
  /** Arrival braking deceleration as a fraction of T_PLAYER.decel (<= 0.5 keeps the profile trackable). */
  arriveDecelFrac: 0.45,
  /** The arrival speed profile reaches zero at this fraction of arriveStop from the target. */
  arriveSettle: 0.5,
  /** Minimum gain of the linear arrival ramp (speed per metre of distance), 1/s. */
  arriveMinGain: 3.0,
  /** Inside arriveStop a desired arrival speed below this is treated as stopped, m/s. */
  arriveSnapSpeed: 0.05,
  /** Jockey/strafe forward speed (toward the look target) as a fraction of jog (top with sprint). */
  jockeyForwardFraction: 0.8,
  /** AI ARRIVE with lookAt: run normally (stop jockeying) above this x the jockey speed cap ... */
  lookBreakRatio: 1.5,
  /** ... and only resume jockeying below this x the cap (hysteresis on last tick's jockeying flag). */
  lookResumeRatio: 1.1,
  /** Extra clearance round goal-box corners for the ARRIVE detour, m. */
  goalDetourMargin: 0.35,
  /** Stamina attribute scales drain by 1 -+ this (99: less drain, faster recovery; 1: the opposite). */
  staminaAttrScale: 0.4,
  /** Moving faster than this fraction of jog speed counts as jogging (staminaDrainJog). */
  jogDrainMinFrac: 0.75,
  /** Stamina rates are per real second at this half length; other half lengths scale them by this / halfMinutes so
   *  a match tires players the same whatever its length [INT-A: 4-minute halves emptied every player's stamina by
   *  half-time, so the second half was played at the stamina floor], min. */
  staminaRefHalfMinutes: 4,
  /** ticksToReach: distance at which a point counts as reached (= the ARRIVE stop distance), m. */
  reachRadius: T_PLAYER.arriveStop,
  /** ticksToReach: cos of the angle below which a moving player's turn is modelled. */
  ttrTurnCos: 0.985,
  /** ticksToReach turn model (fitted to the simulation): turning speed = speed * (A + B * cos). */
  ttrTurnSpeedA: 0.9,
  ttrTurnSpeedB: 0.05,
  /** ... speed after the turn = speed * (A + B * cos) + accel * turn time * ttrTurnAccel. */
  ttrTurnEndA: 0.95,
  ttrTurnEndB: 0.16,
  ttrTurnAccel: 1.0,
  /** ... progress lost to heading away early in the turn, per unit (1 - cos). */
  ttrTurnBack: 0.15,
  /** ... share of the arc's sideways drift left to cover after the turn. */
  ttrTurnSide: 0.5,
} as const;

const LT = LOCAL_TUNING;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)
const HEAD = createV2();
const FACE = createV2();
const PT = createV2();
/**
 * Argument block for the per-tick helpers. V8 boxes a double passed to (or returned from) a call it does not
 * inline, so the hot helpers take their numbers through this typed array instead of parameters.
 */
const ARG = new Float64Array(8);

/**
 * rotateToward2 for unit vectors (fx, fz) -> (tx, tz) from ARG[0..3] by at most ARG[4] rad, into o. Same contract
 * (snaps exactly onto the target when within the step, never overshoots); small steps use Taylor sin/cos
 * (deterministic, |error| < 1e-7 up to 0.8 rad) instead of dmath.
 */
function turnToward(o: V2): void {
  const fx = ARG[0]!, fz = ARG[1]!, tx = ARG[2]!, tz = ARG[3]!, ang = ARG[4]!;
  if (!(ang > 0)) { o.x = fx; o.z = fz; return; }
  if (ang > 0.8) { rotateToward2(o, fx, fz, tx, tz, ang); return; }
  const a2 = ang * ang;
  const c = 1 - (a2 / 2) * (1 - (a2 / 12) * (1 - (a2 / 30) * (1 - a2 / 56)));
  if (fx * tx + fz * tz >= c) { o.x = tx; o.z = tz; return; }
  const sn0 = ang * (1 - (a2 / 6) * (1 - (a2 / 20) * (1 - (a2 / 42) * (1 - a2 / 72))));
  const sn = fx * tz - fz * tx >= 0 ? sn0 : -sn0;
  const rx = fx * c - fz * sn;
  const rz = fx * sn + fz * c;
  const rl = Math.sqrt(rx * rx + rz * rz);
  o.x = rx / rl;
  o.z = rz / rl;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
/** Attribute 1..99 -> 0..1. */
function attr01(v: number): number { return clamp01((v - 1) / 98); }
/**
 * acos for estimates: Abramowitz-Stegun 4.4.45 (|error| < 7e-5 rad), deterministic (+, *, sqrt only) and ~15x
 * cheaper than dmath.dacos. Input clamped to [-1, 1].
 */
function acosFast(x: number): number {
  const ax = x < 0 ? (x < -1 ? 1 : -x) : (x > 1 ? 1 : x);
  const r = Math.sqrt(1 - ax) * (1.5707288 + ax * (-0.2121144 + ax * (0.0742610 - 0.0187293 * ax)));
  return x < 0 ? PI - r : r;
}

// ---------------------------------------------------------------- attribute formulas

/** Top sprint speed m/s from attributes (sprintSpeed mostly, acceleration a little). */
export function topSpeedFor(a: Readonly<PlayerAttrs>): number {
  const t = (1 - LT.topSpeedAccelWeight) * attr01(a.sprintSpeed) + LT.topSpeedAccelWeight * attr01(a.acceleration);
  return T_PLAYER.topSpeedMin + (T_PLAYER.topSpeedMax - T_PLAYER.topSpeedMin) * t;
}
/** Acceleration m/s^2 from attributes. */
export function accelFor(a: Readonly<PlayerAttrs>): number {
  const t = attr01(a.acceleration);
  return T_PLAYER.accelMin + (T_PLAYER.accelMax - T_PLAYER.accelMin) * t;
}
/** Multiplier (<= 1) on speed/accel/accuracy from current stamina. */
export function staminaFactor(p: Readonly<PlayerState>): number {
  const thr = T_PLAYER.staminaLowThreshold;
  const st = p.stamina;
  if (!(st < thr)) return 1;
  const f = st > 0 ? st / thr : 0;
  return T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * f;
}
/** Player's top speed from attrs (falls back to the minimum for an unset attrs block), m/s. */
function baseTop(a: Readonly<PlayerAttrs>): number { return a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin; }
function baseAccel(a: Readonly<PlayerAttrs>): number { return a.accel > 0 ? a.accel : T_PLAYER.accelMin; }

/** Current max speed for a slot given sprint state and stamina (m/s). */
export function maxSpeed(s: SimState, slot: number, sprint: boolean): number {
  const top = baseTop(s.attrs[slot]!) * staminaFactor(s.players[slot]!);
  return sprint ? top : top * T_PLAYER.jogFraction;
}

/**
 * Movement turn rate (rad/s) at `speed` m/s: turnRateSlow at standstill to turnRateFast at the player's top speed,
 * scaled +-agilityTurnScale by agility and by sprintTurnMul when sprinting. Pure.
 */
export function turnRateFor(a: Readonly<PlayerAttrs>, speed: number, sprinting: boolean): number {
  const f = clamp01(speed / baseTop(a));
  let w = T_PLAYER.turnRateSlow + (T_PLAYER.turnRateFast - T_PLAYER.turnRateSlow) * f;
  w *= 1 + T_PLAYER.agilityTurnScale * (2 * attr01(a.agility) - 1);
  return sprinting ? w * T_PLAYER.sprintTurnMul : w;
}

// ---------------------------------------------------------------- obstacles: boards and goal boxes

/** Half extent (|z|) of a goal box for a player centre: outside of the posts plus the body radius. */
const GOAL_BOX_SIDE = GOAL_HALF_WIDTH + POST_RADIUS + T_PLAYER.bodyRadius;
/** Back face (mirrored x) of a goal box for a player centre. */
const GOAL_BOX_BACK = HALF_LENGTH + GOAL_DEPTH + T_PLAYER.bodyRadius;
/** Front face (mirrored x): keepers may stand on the line, everyone else keeps the body out of the mouth. */
const GOAL_BOX_FRONT = HALF_LENGTH - T_PLAYER.bodyRadius;
/** Board limits for a player centre. */
const BOARD_LIM_X = BOARD_X - T_PLAYER.bodyRadius;
const BOARD_LIM_Z = BOARD_Z - T_PLAYER.bodyRadius;
function goalBoxFront(isKeeper: number): number {
  return isKeeper === 1 ? HALF_LENGTH : GOAL_BOX_FRONT;
}

/**
 * Exit face for a point (ax, z) inside the (mirrored) goal box that came from (pax, pz):
 * 0 front, 1 back, 2 +z side, 3 -z side. The face crossed last on the way in; if the previous point was inside
 * too, the face of least penetration.
 */
function goalExitFace(ax: number, z: number, pax: number, pz: number, front: number): number {
  let face = -1;
  let bestT = -1;
  if (pax <= front) { const t = (front - pax) / (ax - pax); if (t > bestT) { bestT = t; face = 0; } }
  if (pax >= GOAL_BOX_BACK) { const t = (pax - GOAL_BOX_BACK) / (pax - ax); if (t > bestT) { bestT = t; face = 1; } }
  if (pz >= GOAL_BOX_SIDE) { const t = (pz - GOAL_BOX_SIDE) / (pz - z); if (t > bestT) { bestT = t; face = 2; } }
  if (pz <= -GOAL_BOX_SIDE && (-GOAL_BOX_SIDE - pz) / (z - pz) > bestT) face = 3;
  if (face >= 0) return face;
  let pen = ax - front;
  face = 0;
  if (GOAL_BOX_BACK - ax < pen) { pen = GOAL_BOX_BACK - ax; face = 1; }
  if (GOAL_BOX_SIDE - z < pen) { pen = GOAL_BOX_SIDE - z; face = 2; }
  if (z + GOAL_BOX_SIDE < pen) face = 3;
  return face;
}

/**
 * Move (x, z) = ARG[0..1] out of both goal boxes (entering from (fromX, fromZ) = ARG[2..3]) and inside the boards;
 * result in PT. Returns a bit mask of blocked axes (1 = x, 2 = z) with the sign of the blocked motion in bits
 * 4 (x+) / 8 (z+).
 */
function confinePoint(isKeeper: number): number {
  let x = ARG[0]!;
  let z = ARG[1]!;
  const fromX = ARG[2]!;
  const fromZ = ARG[3]!;
  let blocked = 0;
  const front = goalBoxFront(isKeeper);
  for (let e = -1; e <= 1; e += 2) {
    const ax = e * x;
    if (ax <= front || ax >= GOAL_BOX_BACK || z <= -GOAL_BOX_SIDE || z >= GOAL_BOX_SIDE) continue;
    const face = goalExitFace(ax, z, e * fromX, fromZ, front);
    if (face === 0) { x = e * front; blocked |= e > 0 ? 1 | 4 : 1; }
    else if (face === 1) { x = e * GOAL_BOX_BACK; blocked |= e > 0 ? 1 : 1 | 4; }
    else if (face === 2) { z = GOAL_BOX_SIDE; blocked |= 2; }
    else { z = -GOAL_BOX_SIDE; blocked |= 2 | 8; }
  }
  const bx = BOARD_LIM_X;
  const bz = BOARD_LIM_Z;
  if (x > bx) { x = bx; blocked |= 1 | 4; } else if (x < -bx) { x = -bx; blocked |= 1; }
  if (z > bz) { z = bz; blocked |= 2 | 8; } else if (z < -bz) { z = -bz; blocked |= 2; }
  PT.x = x;
  PT.z = z;
  return blocked;
}

/**
 * Keep a player inside the boards and out of both goal frames / nets after he moved from (prevX, prevZ);
 * velocity into a blocking face is removed. SIM-05 may call this after its separation pass.
 */
export function confinePlayer(s: SimState, slot: number, prevX: number, prevZ: number): void {
  const p = s.players[slot]!;
  ARG[2] = prevX;
  ARG[3] = prevZ;
  confineMoved(p);
}

/** confinePlayer with the previous position in ARG[2..3]. */
function confineMoved(p: PlayerState): void {
  ARG[0] = p.x;
  ARG[1] = p.z;
  const b = confinePoint(p.isKeeper);
  if (b === 0) return;
  p.x = PT.x;
  p.z = PT.z;
  if ((b & 1) !== 0) { if ((b & 4) !== 0 ? p.vx > 0 : p.vx < 0) p.vx = 0; }
  if ((b & 2) !== 0) { if ((b & 8) !== 0 ? p.vz > 0 : p.vz < 0) p.vz = 0; }
}

/** True if the open segment (x0,z0)-(x1,z1) passes through the open box [xa,xb] x [za,zb] (Liang-Barsky). */
function segmentHitsBox(x0: number, z0: number, x1: number, z1: number, xa: number, xb: number, za: number, zb: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;
  if (dx === 0) { if (x0 <= xa || x0 >= xb) return false; } else {
    let ta = (xa - x0) / dx;
    let tb = (xb - x0) / dx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (dz === 0) { if (z0 <= za || z0 >= zb) return false; } else {
    let ta = (za - z0) / dz;
    let tb = (zb - z0) / dz;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  return t1 - t0 > 1e-9;
}

/**
 * ARRIVE detour: if the straight path from the player (px, pz) = ARG[0..1] to (tx, tz) = ARG[2..3] crosses a goal
 * box, write into PT the box corner (with margin) that gives the shortest visible path round it and return 1;
 * else return 0.
 */
function goalDetour(isKeeper: number): number {
  const px = ARG[0]!, pz = ARG[1]!, tx = ARG[2]!, tz = ARG[3]!;
  const front = goalBoxFront(isKeeper);
  for (let e = -1; e <= 1; e += 2) {
    const ax0 = e * px;
    const ax1 = e * tx;
    // Quick reject: both ends in front of the box, or on the same far side of it.
    if (ax0 <= front && ax1 <= front) continue;
    if (!segmentHitsBox(ax0, pz, ax1, tz, front, GOAL_BOX_BACK, -GOAL_BOX_SIDE, GOAL_BOX_SIDE)) continue;
    const m = LT.goalDetourMargin;
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (let c = 0; c < 4; c++) {
      const cx = (c & 1) === 0 ? front - m : GOAL_BOX_BACK + m;
      const cz = (c & 2) === 0 ? GOAL_BOX_SIDE + m : -GOAL_BOX_SIDE - m;
      if (segmentHitsBox(ax0, pz, cx, cz, front, GOAL_BOX_BACK, -GOAL_BOX_SIDE, GOAL_BOX_SIDE)) continue;
      const d0x = cx - ax0, d0z = cz - pz, d1x = ax1 - cx, d1z = tz - cz;
      const len = Math.sqrt(d0x * d0x + d0z * d0z) + Math.sqrt(d1x * d1x + d1z * d1z);
      if (len < best) { best = len; bx = cx; bz = cz; }
    }
    if (best < Infinity) {
      PT.x = e * bx;
      PT.z = bz;
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- arrival-time estimate

/**
 * Seconds to cover `dist` m from speed v0 (along the path): accel a1 up to vj, a1 * highSpeedAccelMul to vmax,
 * or braking at T_PLAYER.decel down to vmax when faster; then cruise.
 */
function runTime(dist: number, v0: number, vj: number, vmax: number, a1: number): number {
  let v = v0 > 0 ? v0 : 0;
  let d = dist;
  let t = 0;
  if (v > vmax) {
    const dec = T_PLAYER.decel;
    const need = (v * v - vmax * vmax) / (2 * dec);
    if (d <= need) return (v - Math.sqrt(v * v - 2 * dec * d)) / dec;
    t = (v - vmax) / dec;
    d -= need;
    v = vmax;
  }
  for (let phase = 0; phase < 2; phase++) {
    const v1 = phase === 0 ? (vj < vmax ? vj : vmax) : vmax;
    const a = phase === 0 ? a1 : a1 * LT.highSpeedAccelMul;
    if (v >= v1 || a <= 0) continue;
    const need = (v1 * v1 - v * v) / (2 * a);
    if (d <= need) return t + (Math.sqrt(v * v + 2 * a * d) - v) / a;
    t += (v1 - v) / a;
    d -= need;
    v = v1;
  }
  return t + d / vmax;
}

/**
 * Estimated ticks for `slot` to reach (x, z) moving at up to `speedCap` m/s (sprinting when the cap is above jog),
 * from its current position, velocity and facing: pivot or turn time (braking in the turn), acceleration in two
 * phases and cruise. A point within reachRadius is 0. A player whose action locks his movement (moveMode LOCKED)
 * adds the action's remaining ticks. Monotonic in distance along any direction; pure and allocation-free.
 */
export function ticksToReachAtSpeed(s: SimState, slot: number, x: number, z: number, speedCap: number): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const dx = x - p.x;
  const dz = z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  let lockT = 0;
  if (p.moveMode === MoveMode.LOCKED && p.act !== ActionKind.NONE && p.actDur > p.actT) lockT = p.actDur - p.actT;
  if (!(d > LT.reachRadius)) return lockT;
  const sf = staminaFactor(p);
  const top = baseTop(a) * sf;
  const vmax = speedCap < top ? speedCap : top;
  if (!(vmax > 0)) return 1e9;
  const vj = top * T_PLAYER.jogFraction;
  const sprint = vmax > vj * 1.0001;
  const acc = baseAccel(a) * sf;
  const ux = dx / d;
  const uz = dz / d;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  let dist = d - LT.reachRadius;
  let t = 0;
  let v0 = 0;
  // A standing player pivots while he accelerates (the facing gate never binds at sprint acceleration), so
  // only a moving player's turn costs time.
  if (sp >= LT.moveEps) {
    const c = (p.vx * ux + p.vz * uz) / sp;
    if (c >= LT.ttrTurnCos) {
      v0 = sp * c;
    } else {
      // Turn at the rate of a (partly braked) turning speed; the speed after the turn and the progress made
      // along the target direction meanwhile (negative for a U-turn: the run starts heading away).
      const ang = acosFast(c);
      const vTurn = sp * (LT.ttrTurnSpeedA + LT.ttrTurnSpeedB * c);
      const tt = ang / turnRateFor(a, vTurn, sprint);
      t += tt;
      const sinA = Math.sqrt((1 - c) * (1 + c));
      const path = vTurn * tt / ang;
      // Along-target progress and sideways drift of the turning arc; the run then covers the remaining offset.
      const prog = path * (sinA - LT.ttrTurnBack * (1 - c) * ang);
      const side = path * (1 - c) * LT.ttrTurnSide;
      const rest = dist > prog ? dist - prog : 0;
      dist = Math.sqrt(rest * rest + side * side);
      let vEnd = sp * (LT.ttrTurnEndA + LT.ttrTurnEndB * c) + acc * tt * LT.ttrTurnAccel;
      const vHi = sp > vmax ? sp : vmax;
      if (vEnd > vHi) vEnd = vHi; // above the cap: runTime brakes it down
      v0 = vEnd;
    }
  }
  if (dist > 0) t += runTime(dist, v0, vj, vmax, acc);
  return lockT + Math.ceil(t * TICK_HZ);
}

/**
 * Estimated ticks for `slot` to reach (x, z) from its current position and velocity at full sprint,
 * including turning and acceleration. Used by loose-ball chasing, receivers, keepers and AI. Pure.
 */
export function ticksToReach(s: SimState, slot: number, x: number, z: number): number {
  return ticksToReachAtSpeed(s, slot, x, z, Infinity);
}

// ---------------------------------------------------------------- the tick

function movePlayer(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  // Helpers are inlined by hand in this function: V8 boxes doubles returned from calls it does not inline.
  const st0 = Number.isFinite(p.stamina) ? p.stamina : 1;
  const thr = T_PLAYER.staminaLowThreshold;
  const sf = st0 < thr ? T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * (st0 > 0 ? st0 / thr : 0) : 1;
  const top0 = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  const top = top0 * sf;
  const jog = top * T_PLAYER.jogFraction;
  const acc = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sf;
  let agi = (a.agility - 1) / 98;
  agi = agi < 0 ? 0 : agi > 1 ? 1 : agi;
  const turnAgi = 1 + T_PLAYER.agilityTurnScale * (2 * agi - 1);
  const prevX = p.x;
  const prevZ = p.z;
  let vx = p.vx;
  let vz = p.vz;
  const sp = Math.sqrt(vx * vx + vz * vz);
  // Facing (repair a degenerate one).
  let fx = p.fx;
  let fz = p.fz;
  let fl = Number.isFinite(fx) && Number.isFinite(fz) ? Math.sqrt(fx * fx + fz * fz) : 0;
  if (!(fl > 1e-9)) { fx = p.team === 0 ? 1 : -1; fz = 0; fl = 1; }
  fx /= fl;
  fz /= fl;

  const shield = p.act === ActionKind.SHIELD ? 1 : 0;
  let jockey = 0;
  let sprintEff = 0;
  let dsp = 0;

  if (p.moveMode === MoveMode.LOCKED) {
    // Friction only: the action owns the motion and the facing.
    if (sp > 0) {
      const ns = sp - LT.lockedFriction * DT;
      if (ns > 0) { vx *= ns / sp; vz *= ns / sp; } else { vx = 0; vz = 0; }
    }
  } else {
    // ---- desired direction (ux, uz) and speed dsp
    let ux = 0;
    let uz = 0;
    const mode = p.moveMode;
    if (mode === MoveMode.DIRECT) {
      const ix = Number.isFinite(p.ix) ? p.ix : 0;
      const iz = Number.isFinite(p.iz) ? p.iz : 0;
      let mag = Math.sqrt(ix * ix + iz * iz);
      if (mag > LT.stickDead) {
        ux = ix / mag;
        uz = iz / mag;
        if (mag > 1) mag = 1;
        if (p.wantSprint === 1) {
          const f = mag / LT.sprintStickFull;
          dsp = top * (f < 1 ? f : 1);
        } else dsp = jog * mag;
      }
    } else if (mode === MoveMode.ARRIVE) {
      const cap0 = Number.isFinite(p.tgtSpeed) ? p.tgtSpeed : 0;
      const cap = cap0 < top ? cap0 : top;
      ARG[0] = Number.isFinite(p.tgtX) ? p.tgtX : p.x;
      ARG[1] = Number.isFinite(p.tgtZ) ? p.tgtZ : p.z;
      ARG[2] = p.x;
      ARG[3] = p.z;
      confinePoint(p.isKeeper);
      const tx = PT.x;
      const tz = PT.z;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const e = d - LT.arriveSettle * T_PLAYER.arriveStop;
      if (cap > 0 && e > 0) {
        const gain = cap / T_PLAYER.arriveRadius;
        const k = gain > LT.arriveMinGain ? gain : LT.arriveMinGain;
        const vb = Math.sqrt(2 * LT.arriveDecelFrac * T_PLAYER.decel * e);
        dsp = k * e;
        if (vb < dsp) dsp = vb;
        if (cap < dsp) dsp = cap;
        // Arrived: finish the stop, and a standing player stays put while the target is within arriveStop
        // (no micro-steps for a target that wobbles or drifts a few centimetres).
        if (d <= T_PLAYER.arriveStop && (dsp < LT.arriveSnapSpeed || sp < LT.moveEps)) dsp = 0;
        if (dsp > 0) {
          ARG[0] = p.x; ARG[1] = p.z; ARG[2] = tx; ARG[3] = tz;
          if (goalDetour(p.isKeeper) === 1) {
            const cx = PT.x - p.x;
            const cz = PT.z - p.z;
            const cl = Math.sqrt(cx * cx + cz * cz);
            if (cl > 1e-6) { ux = cx / cl; uz = cz / cl; } else { ux = dx / d; uz = dz / d; }
          } else {
            ux = dx / d;
            uz = dz / d;
          }
        }
      }
    }
    // STOP: dsp = 0 (brake).

    // ---- look target (jockey / strafe / shield / contain)
    let lx = fx;
    let lz = fz;
    let look = 0;
    if (p.lookAt === 1) {
      look = 1;
      const ox = Number.isFinite(p.lookX) ? p.lookX - p.x : 0;
      const oz = Number.isFinite(p.lookZ) ? p.lookZ - p.z : 0;
      const ol = Math.sqrt(ox * ox + oz * oz);
      if (ol > 0.01) { lx = ox / ol; lz = oz / ol; }
    }

    // ---- speed caps
    if (shield === 1) {
      const capS = jog * T_PLAYER.shieldSpeedFraction;
      if (dsp > capS) dsp = capS;
    } else if (look === 1) {
      jockey = 1;
      if (dsp > 0) {
        // Cap by the move direction relative to the look direction (sideways/backward slowest).
        const c = ux * lx + uz * lz;
        const fr = c > 0
          ? T_PLAYER.jockeySpeedFraction + (LT.jockeyForwardFraction - T_PLAYER.jockeySpeedFraction) * c
          : T_PLAYER.jockeySpeedFraction;
        const capJ = (p.wantSprint === 1 ? top : jog) * fr;
        if (mode === MoveMode.ARRIVE && p.isKeeper !== 1 &&
          dsp > capJ * (p.jockeying === 1 ? LT.lookBreakRatio : LT.lookResumeRatio)) {
          jockey = 0; // far from an AI target: turn and run, face play again once close
        } else if (dsp > capJ) dsp = capJ;
      }
    }
    sprintEff = dsp > jog * 1.000001 ? 1 : 0;

    // ---- heading and facing
    // turnRateFor(a, sp, sprintEff), inlined.
    const spf = sp < top0 ? sp / top0 : 1;
    let w = (T_PLAYER.turnRateSlow + (T_PLAYER.turnRateFast - T_PLAYER.turnRateSlow) * spf) * turnAgi;
    if (sprintEff === 1) w *= T_PLAYER.sprintTurnMul;
    if (jockey === 1) w *= T_PLAYER.jockeyTurnMul;
    const lookFacing = jockey === 1 || (shield === 1 && look === 1);
    let ts = 0;
    if (dsp > 0) {
      let keep = 1;
      if (sp < LT.moveEps) {
        HEAD.x = ux;
        HEAD.z = uz;
      } else {
        ARG[0] = vx / sp; ARG[1] = vz / sp; ARG[2] = ux; ARG[3] = uz; ARG[4] = w * DT;
        turnToward(HEAD);
        keep = 0.5 * (1 + HEAD.x * ux + HEAD.z * uz);
      }
      if (!lookFacing) {
        ARG[0] = fx; ARG[1] = fz; ARG[2] = HEAD.x; ARG[3] = HEAD.z; ARG[4] = w * LT.facingTurnMul * DT;
        turnToward(FACE);
        const kf = 0.5 * (1 + FACE.x * HEAD.x + FACE.z * HEAD.z);
        if (kf < keep) keep = kf;
      }
      // Slow moves shuffle without pivoting first.
      const pv = dsp / LT.pivotSpeed;
      keep = 1 + (keep - 1) * (pv < 1 ? pv : 1);
      ts = dsp * keep;
    } else {
      if (sp > 0) { HEAD.x = vx / sp; HEAD.z = vz / sp; } else { HEAD.x = fx; HEAD.z = fz; }
      if (!lookFacing) {
        if (sp >= LT.moveEps) {
          ARG[0] = fx; ARG[1] = fz; ARG[2] = HEAD.x; ARG[3] = HEAD.z; ARG[4] = w * LT.facingTurnMul * DT;
          turnToward(FACE);
        } else { FACE.x = fx; FACE.z = fz; }
      }
    }
    if (lookFacing) {
      ARG[0] = fx; ARG[1] = fz; ARG[2] = lx; ARG[3] = lz; ARG[4] = w * LT.facingTurnMul * DT;
      turnToward(FACE);
    }
    fx = FACE.x;
    fz = FACE.z;

    // ---- speed
    let ns: number;
    if (ts > sp) {
      const aa = sp >= jog ? acc * LT.highSpeedAccelMul : acc;
      ns = sp + aa * DT;
      if (ns > ts) ns = ts;
    } else {
      ns = sp - T_PLAYER.decel * DT;
      if (ns < ts) ns = ts;
    }
    if (ns < 1e-9) ns = 0;
    vx = HEAD.x * ns;
    vz = HEAD.z * ns;
  }

  // ---- integrate and confine
  p.vx = vx;
  p.vz = vz;
  p.x = prevX + vx * DT;
  p.z = prevZ + vz * DT;
  ARG[2] = prevX;
  ARG[3] = prevZ;
  confineMoved(p);
  p.fx = fx;
  p.fz = fz;
  const spOut = Math.sqrt(p.vx * p.vx + p.vz * p.vz);

  // ---- effective flags
  p.sprinting = sprintEff === 1 && jockey === 0 && shield === 0 && spOut > 0.5 ? 1 : 0;
  p.jockeying = jockey;
  p.shielding = shield;

  // ---- stamina
  let t = (a.stamina - 1) / 98;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let st = st0;
  const hm = s.config.halfMinutes;
  const rate = DT * LT.staminaRefHalfMinutes / (hm >= 2 && hm <= 10 ? hm : LT.staminaRefHalfMinutes);
  // Sprint effort drains from the first step (the sprinting flag waits for 0.5 m/s), as does running above jog.
  if ((sprintEff === 1 && jockey === 0 && shield === 0 && spOut > 0) || spOut > jog * 1.02) {
    st -= T_PLAYER.staminaDrainSprint * (1 + LT.staminaAttrScale * (1 - 2 * t)) * rate;
  } else if (spOut > jog * LT.jogDrainMinFrac) {
    st -= T_PLAYER.staminaDrainJog * (1 + LT.staminaAttrScale * (1 - 2 * t)) * rate;
  } else {
    st += T_PLAYER.staminaRecover * (1 + LT.staminaAttrScale * (2 * t - 1)) * rate;
  }
  p.stamina = st < 0 ? 0 : st > 1 ? 1 : st;
}

export function locomotionTick(s: SimState, ev: EventSink): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (s.players[i]!.active !== 1) continue;
    movePlayer(s, i);
  }
}

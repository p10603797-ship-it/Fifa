/**
 * [GKP-02] Saves: reaction delay, dive reach and dive speed from attributes (T_GK); results are catch, parry
 * (away from danger when good), tip over, or beaten. A save is decided by whether the keeper physically reaches
 * the ball (dive kinematics vs predicted ball path), never by a dice roll that ignores where the shot went.
 * keeperSaveDecision starts GK_DIVE / sets up a save for incoming shots (keepers are always AI for saves);
 * keeperContacts resolves contact in the contact phase (first priority). Emits SAVE, KEEPER_HANDS.
 * Never dives after the ball has passed; never stays stuck in a dive. Target: 65-78% of on-target shots saved.
 *
 * HOW IT WORKS
 *  Decision (teamAiTick, IN_PLAY): a loose ball moving toward the keeper's goal is predicted with the sim's own
 *  ball physics (SIM-02 ballStepTick, which is what SIM-01 predictBall runs; memoised while the ball flies
 *  untouched). It is a threat only if the prediction crosses the goal line inside the mouth (a teammate's pass meant
 *  for him never is: SIM-07 receives it). Until the reaction delay has passed (gkReflexes -> T_GK.reactWorst ..
 *  reactBest ticks after the last touch, + LOCAL_TUNING.screenTicks per player screening the sight line) he only
 *  plants his feet (GK_CATCH ready stance on his spot, body only, so positioning cannot move him early). Then he
 *  plans against every predicted sample until the ball would be over the line:
 *   - STAND: a sample within his standing reach (the standing capsule + a short step) -> GK_CATCH, he steps into
 *     the line and takes it standing.
 *   - DIVE: a sample his hands can reach in time -> GK_CATCH tracking toward it until the latest tick that still
 *     gets the hands there (commitSlackTicks), then GK_DIVE toward that point (the nearest reachable sample).
 *   - nothing reachable -> he moves toward the ball's path (GK_CATCH, re-planning every tick) and, close to the
 *     ball's arrival, makes a despairing GK_DIVE toward the closest approach timed to full stretch (beaten).
 *  Never a new save action once the ball is planeBackReach behind his plane (it has passed him). [QF-11 skeptic] While
 *  such a ball is still on its way into the mouth at threat speed (passedHim) he stays put (a running GK_CATCH is kept,
 *  an idle keeper plants), so SIM-07 never gives him a first touch on it from behind.
 *  [QF-11 skeptic] Gather: an idle AI keeper (not human-controlled) whose hands a loose ball he may handle (canHandle)
 *  reaches within T_GK.gatherReach in his goal area catches it (keeperPickUp) when it is slow enough and he has reacted
 *  to it; otherwise the reflex body block (if eligible) or nothing (a catch or nothing: never a parry of a harmless
 *  ball). A set catch (not the planted stance) is kept up to T_GK.catchKeepTicks after the threat flickers off while
 *  the ball still comes at him, and no tip over is made from closer to the line than T_GK.tipBarFront (a parry).
 *  Dive kinematics (saveKinematics.ts): load (diveWindupTicks, arms extend), then the hip accelerates along the
 *  dive line to keeperDiveSpeed(gkDiving) (diveAccelTicks) and flies on for the planned travel, hands beyond the
 *  hip; touch distance from the start = hip travel + hand offset + handRadius + BALL_RADIUS <= keeperMaxReach
 *  (T_GK.reachWorst..reachBest); reach height diveTop. Then the arms stay out for diveStretchTicks, he lies on the
 *  ground (diveGround*) and gets up (getUp*): one GK_DIVE action with a fixed actDur, so a dive always ends.
 *  Contact (contactsTick, first priority): the keeper's volume (dive: feet->hands capsule; GK_CATCH: arms around
 *  the body axis; idle / rushing keeper: body only, for goal-bound fast balls) is tested against the ball's swept
 *  segment of this tick. Hands (ball and keeper inside his own area, not a deliberate foot pass from a teammate)
 *  catch when the ball is slow enough (T_GK.catchSpeed scaled by gkHandling, stretch and height) and GKP-05
 *  canHandle agrees (keeperPickUp -> GK_HOLD); otherwise tip over (high, near the bar) or parry (good keepers wide
 *  and away, poor keepers back into the middle; small deterministic s.rng noise). No hands (outside the area,
 *  back-pass, unready keeper, the legs of a dive): body block (deflection, never on into the goal). The ball is
 *  played from the contact point, so a save on the tick it crossed the line undoes that crossing; a ball wholly over
 *  the line before the contact point stays a goal. Missing the volume = beaten. SAVE only for balls that were going
 *  in (or shots on target).
 *
 * ACTION FIELDS
 *  GK_DIVE:  actX/actZ = dive start position; actDirX/actDirZ = unit dive direction; actPower = target distance as a
 *            fraction of his max reach (0..1, "dive power"; hip travel and hand offset follow from it);
 *            actCurve = hand height (m); actA = height class 0 low / 1 mid / 2 high; actB = side -1 left / +1 right
 *            of the keeper's facing; actContact = tick of full extension; actDone = 1 after a ball contact;
 *            actKick = result (GK_PARRY / GK_TIP / DEFLECTION; NONE = no contact yet).
 *  GK_CATCH: actX/actZ = spot he steps to; actCurve = expected ball height; actA = 0 tracking toward a save spot
 *            (a dive may follow), 1 set to take the ball standing, 2 feet planted before he has reacted (ready stance,
 *            body only); actDone / actKick as above (a caught ball goes to GK_HOLD).
 */
// Re-export the handlers FIRST: see saveKinematics.ts (import-cycle safety with actions/registry).
export { catchHandler, diveHandler } from './saveKinematics';
import {
  armExt, CAP_TOL, createKeeperKin, depthOf, diveHandOffset, diveTargetDist, diveTop, diveTravelFor, flightTicks,
  getUpTicks, heightM, hipTravel, keeperMaxReach, keeperReactTicks, kinDiveTicks, kinDiveTop, kinStandReach,
  loadKeeperKin, LOCAL_TUNING, NEVER, STAND_AXIS_LOW, standAxisTop, standTop, xOfDepth,
} from './saveKinematics';
// actions/dispatch (-> registry) before keeper/handling so the registry never meets a half-evaluated handler module.
import { beginAction, endAction } from '../actions/dispatch';
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, NUM_SLOTS,
  PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
} from '../../contracts/constants';
import { ActionKind, CrossKind, KickKind, MatchPhase, SaveKind, isFootPassKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { createBallState, MoveMode, type BallState, type PlayerAttrs, type SimState } from '../../contracts/state';
import { createKickLaunch, MAX_PREDICT_TICKS } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_BALL, T_GK, T_LEVEL } from '../../contracts/tuning';
import { ballStepTick } from '../ball/contact';
import { attr, clamp, clamp01, dcos, dsin, lerp } from '../core/dmath';
import { applyKick, ballTouchedThisTick } from '../core/kick';
import { isHumanSlot } from '../core/query';
import { rngRange } from '../core/rng';
import { canHandle, keeperPickUp } from './handling';

export { keeperDiveSpeed, keeperDiveTicks, keeperMaxReach, keeperReactTicks } from './saveKinematics';

const L = LOCAL_TUNING;
const EPS = 1e-9;

// ---------------------------------------- scratch (module level, reused: no per-tick allocation)

const SCRATCH_BALL = createBallState();
const SIM_BALL = createBallState();
const LAUNCH = createKickLaunch();
const KIN = createKeeperKin();

/** Result of the last threat evaluation / plan. */
const PLAN = {
  /** Index of the first predicted sample with the whole ball over the goal line (-1 none). */
  g: -1,
  /** 0 none, 1 stand, 2 dive, 3 hopeless dive, 4 track (move toward the ball's path, nothing reachable yet). */
  kind: 0,
  /** Chosen sample, its distance from the keeper and the ticks until it arrives / the hands need. */
  i: -1,
  d: 0,
  arrive: 0,
  need: 0,
  x: 0, y: 0, z: 0,
};
const PLAN_NONE = 0;
const PLAN_STAND = 1;
const PLAN_DIVE = 2;
const PLAN_HOPELESS = 3;
const PLAN_TRACK = 4;
/** GK_CATCH actA: tracking toward a save spot (a dive may follow) / set to take it standing / planted, not reacted. */
const CATCH_TRACK = 0;
const CATCH_STAND = 1;
const CATCH_PLANTED = 2;

/** Segment-segment closest points. */
const SEG = { s: 0, t: 0, d2: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };
/** Keeper contact volume: capsule A -> B with radius r; kind 0 none, 1 dive, 2 stand, 3 body, 4 gather (reflex = 1:
 *  a reflex body block applies when the gather cannot catch). */
const VOL = { kind: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 0, reflex: 0 };
const VOL_NONE = 0;
const VOL_DIVE = 1;
const VOL_STAND = 2;
const VOL_BODY = 3;
/** [QF-11 skeptic] Idle AI keeper gathering a loose ball he may handle (hands; a catch or nothing). */
const VOL_GATHER = 4;

// ---------------------------------------------------------------- geometry helpers

/** Inside (or on the lines of) the area team defends, with slack metres; includes the goal mouth behind the line. */
function inOwnArea(dir: number, x: number, z: number, slack: number): boolean {
  const u = depthOf(dir, x);
  return u <= PENALTY_AREA_DEPTH + slack && u >= -GOAL_DEPTH &&
    z <= PENALTY_AREA_HALF_WIDTH + slack && z >= -PENALTY_AREA_HALF_WIDTH - slack;
}

/** A deliberate pass from a teammate's foot is the last touch (back-pass rule: no hands). */
function teammateFootPass(s: SimState, team: number): boolean {
  const b = s.ball;
  return b.lastKickTeam === team && b.lastTouchTeam === team && b.lastTouch === b.lastKickBy &&
    isFootPassKind(b.lastKickKind);
}

/** Closest points between segments P1Q1 and P2Q2 (Ericson, RTCD 5.1.9) into SEG. */
function segSeg(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number,
): void {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > EPS ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  SEG.s = s; SEG.t = t;
  SEG.ax = p1x + d1x * s; SEG.ay = p1y + d1y * s; SEG.az = p1z + d1z * s;
  SEG.bx = p2x + d2x * t; SEG.by = p2y + d2y * t; SEG.bz = p2z + d2z * t;
  const dx = SEG.ax - SEG.bx, dy = SEG.ay - SEG.by, dz = SEG.az - SEG.bz;
  SEG.d2 = dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------- prediction

function copyBall(d: BallState, b: Readonly<BallState>): void {
  d.x = b.x; d.y = b.y; d.z = b.z; d.vx = b.vx; d.vy = b.vy; d.vz = b.vz; d.sx = b.sx; d.sy = b.sy; d.sz = b.sz;
  d.px = b.px; d.py = b.py; d.pz = b.pz; d.grounded = b.grounded; d.bounces = b.bounces;
  d.owner = b.owner; d.ownerT = b.ownerT; d.heldBy = b.heldBy;
  d.lastTouch = b.lastTouch; d.lastTouchTeam = b.lastTouchTeam; d.lastTouchTick = b.lastTouchTick;
  d.touchedTick = b.touchedTick; d.lastKickBy = b.lastKickBy; d.lastKickTeam = b.lastKickTeam;
  d.lastKickKind = b.lastKickKind; d.lastKickTick = b.lastKickTick;
  d.passTarget = b.passTarget; d.passX = b.passX; d.passZ = b.passZ;
  d.shotBy = b.shotBy; d.shotTick = b.shotTick; d.shotOnTarget = b.shotOnTarget; d.inNet = b.inNet; d.idleT = b.idleT;
  d.cross = b.cross; d.crossX = b.crossX; d.crossZ = b.crossZ; d.crossEnd = b.crossEnd;
}

/*
 * Prediction: SIM-02 ballStepTick on a copy of the ball, tick by tick (exactly what SIM-01 predictBall does, and a
 * free ball then follows it bit for bit), storing position, velocity, spin, grounded and inNet per sample. Samples
 * are memoised across ticks: while the ball flies untouched, the current ball equals a stored sample in every field
 * the ball physics reads and in lastTouchTick, so the stored tail IS the fresh prediction (same function of the same
 * state) and only its end needs extending. Anything else (a touch, a deflection, another match, a restart) fails
 * the exact comparison and the path is recomputed. The memo never feeds state, so determinism is unaffected; it
 * turns a ~100-tick prediction per tick into an O(1) check plus one new sample.
 */
const PX = new Float64Array(MAX_PREDICT_TICKS);
const PY = new Float64Array(MAX_PREDICT_TICKS);
const PZ = new Float64Array(MAX_PREDICT_TICKS);
const PVX = new Float64Array(MAX_PREDICT_TICKS);
const PVY = new Float64Array(MAX_PREDICT_TICKS);
const PVZ = new Float64Array(MAX_PREDICT_TICKS);
const PSX = new Float64Array(MAX_PREDICT_TICKS);
const PSY = new Float64Array(MAX_PREDICT_TICKS);
const PSZ = new Float64Array(MAX_PREDICT_TICKS);
const PG = new Float64Array(MAX_PREDICT_TICKS);
const PN = new Float64Array(MAX_PREDICT_TICKS);
/** Memo bookkeeping: valid samples, the tick they are "now" for, the lastTouchTick they were made with. */
const MEMO = { n: 0, tick: 0, touch: -2, valid: 0 };

function storeSample(i: number, b: Readonly<BallState>): void {
  PX[i] = b.x; PY[i] = b.y; PZ[i] = b.z; PVX[i] = b.vx; PVY[i] = b.vy; PVZ[i] = b.vz;
  PSX[i] = b.sx; PSY[i] = b.sy; PSZ[i] = b.sz;
  PG[i] = b.grounded; PN[i] = b.inNet;
}

function sampleIs(i: number, b: Readonly<BallState>): boolean {
  return PX[i] === b.x && PY[i] === b.y && PZ[i] === b.z && PVX[i] === b.vx && PVY[i] === b.vy && PVZ[i] === b.vz &&
    PSX[i] === b.sx && PSY[i] === b.sy && PSZ[i] === b.sz && PG[i] === b.grounded && PN[i] === b.inNet;
}

function shiftSamples(k: number, n: number): void {
  PX.copyWithin(0, k, n); PY.copyWithin(0, k, n); PZ.copyWithin(0, k, n);
  PVX.copyWithin(0, k, n); PVY.copyWithin(0, k, n); PVZ.copyWithin(0, k, n);
  PSX.copyWithin(0, k, n); PSY.copyWithin(0, k, n); PSZ.copyWithin(0, k, n);
  PG.copyWithin(0, k, n); PN.copyWithin(0, k, n);
}

/**
 * Predict up to n ticks of the free ball b into PX/PY/PZ (sample i = after i + 1 ticks); returns the sample count.
 * memo = 1 for the live ball at tick `tick` (may reuse the previous ticks' samples), 0 for a hypothetical ball.
 * stopDir != 0: stop after the first sample with the whole ball over the goal line of the team attacking toward
 * stopDir (nothing after it is ever used), so a shot costs the ticks until it reaches the line, not the horizon.
 */
function predict(b: Readonly<BallState>, n: number, tick: number, memo: number, stopDir: number): number {
  if (n > MAX_PREDICT_TICKS) n = MAX_PREDICT_TICKS;
  let have = 0;
  if (memo === 1 && MEMO.valid === 1 && b.lastTouchTick === MEMO.touch) {
    const k = tick - MEMO.tick;
    if (k > 0 && k <= MEMO.n && sampleIs(k - 1, b)) { shiftSamples(k, MEMO.n); have = MEMO.n - k; }
  }
  if (have === 0) {
    copyBall(SIM_BALL, b);
    SIM_BALL.heldBy = -1;
    SIM_BALL.owner = -1;
  }
  // SIM_BALL holds the state of sample have - 1 (or the start state): extend from there.
  let done = stopDir !== 0 && have > 0 && depthOf(stopDir, PX[have - 1]!) < -BALL_RADIUS;
  while (!done && have < n) {
    ballStepTick(SIM_BALL, null);
    storeSample(have, SIM_BALL);
    have++;
    if (stopDir !== 0 && depthOf(stopDir, SIM_BALL.x) < -BALL_RADIUS) done = true;
  }
  MEMO.valid = memo;
  MEMO.n = have;
  MEMO.tick = tick;
  MEMO.touch = b.lastTouchTick;
  return n < have ? n : have;
}

/**
 * Index of the first predicted sample in [start, count) with the whole ball over the goal line team defends, when
 * it crosses inside the goal mouth (between the posts, under the bar, + margin); -1 if it never does or crosses
 * outside the mouth.
 */
function goalSample(dir: number, margin: number, start: number, count: number): number {
  for (let i = start; i < count; i++) {
    const u = depthOf(dir, PX[i]!);
    if (u > -BALL_RADIUS) continue;
    const z = PZ[i]!;
    const y = PY[i]!;
    // Interpolate the crossing of the line plane between the previous sample and this one.
    let cz = z;
    let cy = y;
    if (i > 0) {
      const u0 = depthOf(dir, PX[i - 1]!);
      const du = u0 - u;
      if (du > EPS && u0 > -BALL_RADIUS) {
        const f = (u0 + BALL_RADIUS) / du;
        cz = PZ[i - 1]! + (z - PZ[i - 1]!) * f;
        cy = PY[i - 1]! + (y - PY[i - 1]!) * f;
      }
    }
    if (cz > GOAL_HALF_WIDTH + margin || cz < -GOAL_HALF_WIDTH - margin || cy > GOAL_HEIGHT + margin) return -1;
    return i;
  }
  return -1;
}

/** [QF-11 skeptic] Is the free ball moving toward keeper k (closing on him faster than threatMinSpeed)? */
function ballComing(s: SimState, k: number): boolean {
  const b = s.ball;
  if (b.heldBy >= 0 || b.owner >= 0) return false;
  const p = s.players[k]!;
  const dx = p.x - b.x, dz = p.z - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return d > EPS && (b.vx * dx + b.vz * dz) / d >= L.threatMinSpeed;
}

/**
 * [QF-11 skeptic] Has the free ball got past keeper k (behind his plane by more than planeBackReach, not yet wholly
 * over the line) on its way into the goal mouth at threat speed?
 */
function passedHim(s: SimState, team: number, k: number): boolean {
  const b = s.ball;
  if (b.heldBy >= 0 || b.owner >= 0) return false;
  const dir = s.teams[team]!.dir;
  const u = depthOf(dir, b.x);
  const vg = -dir * b.vx;
  if (!(vg >= L.threatMinSpeed) || u < -BALL_RADIUS) return false;
  if (u >= depthOf(dir, s.players[k]!.x) - L.planeBackReach) return false;
  const zl = b.z + (b.vz * (u > 0 ? u : 0)) / vg;
  return zl <= GOAL_HALF_WIDTH + L.mouthMargin && zl >= -GOAL_HALF_WIDTH - L.mouthMargin &&
    b.y <= GOAL_HEIGHT + L.mouthMargin;
}

/** Prediction horizon (ticks) for a ball at depth u moving toward the goal at vg m/s. */
function horizonTicks(u: number, vg: number): number {
  const n = Math.ceil(((u > 0 ? u : 0) / vg) * 60 * L.predictTimeMul) + L.predictExtraTicks;
  return n > MAX_PREDICT_TICKS ? MAX_PREDICT_TICKS : n;
}

/**
 * Is the free ball a threat to team's goal (predicted to go in, not a teammate's pass meant for him, not behind
 * the keeper)? Fills the prediction samples and PLAN.g.
 */
function evaluateThreat(s: SimState, team: number, k: number): boolean {
  const b = s.ball;
  PLAN.g = -1;
  if (b.heldBy >= 0 || b.owner >= 0) return false;
  const dir = s.teams[team]!.dir;
  const u = depthOf(dir, b.x);
  const vg = -dir * b.vx;
  if (vg < L.threatMinSpeed || u > L.threatMaxDist || u < -BALL_RADIUS) return false;
  // A teammate's deliberate pass meant for him is received (SIM-07), not saved; any other teammate kick heading in
  // (a miscued clearance) is stopped like a shot, with the body only (no hands: back-pass rule, see keeperContact).
  if (b.passTarget === k && teammateFootPass(s, team)) return false;
  const p = s.players[k]!;
  if (u < depthOf(dir, p.x) - L.planeBackReach) return false; // passed him: never (re)start a save
  const zl = b.z + (b.vz * u) / vg;
  if (zl > GOAL_HALF_WIDTH + L.threatLateralMargin || zl < -GOAL_HALF_WIDTH - L.threatLateralMargin) return false;
  const count = predict(b, horizonTicks(u, vg), s.tick, 1, dir);
  PLAN.g = goalSample(dir, L.mouthMargin, 0, count);
  return PLAN.g >= 0;
}

// ---------------------------------------------------------------- reaction

function screenTicks(s: SimState, k: number): number {
  const b = s.ball;
  const p = s.players[k]!;
  let ox = b.x;
  let oz = b.z;
  const lt = b.lastTouch;
  if (lt >= 0 && lt < NUM_SLOTS && lt !== k) { const q = s.players[lt]!; ox = q.x; oz = q.z; }
  const sx = p.x - ox, sz = p.z - oz;
  const l2 = sx * sx + sz * sz;
  if (l2 < 1) return 0;
  const r2 = L.screenRadius * L.screenRadius;
  let n = 0;
  for (let i = 0; i < NUM_SLOTS && n < L.screenMax; i++) {
    if (i === k || i === lt) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const t = ((q.x - ox) * sx + (q.z - oz) * sz) / l2;
    if (t < 0.15 || t > 0.9) continue;
    const cx = ox + sx * t - q.x, cz = oz + sz * t - q.z;
    if (cx * cx + cz * cz <= r2) n++;
  }
  return n * L.screenTicks;
}

/**
 * [QF-2] Level part of keeper k's reaction delay (T_LEVEL.keeperReactTicks of his team's CPU level; 0 for a side
 * without an active CPU brain and for a bad level), ticks.
 */
function levelReactTicks(s: SimState, k: number): number {
  const t = s.teams[s.players[k]!.team];
  if (!t || t.cpu.active !== 1) return 0;
  const lv = t.cpu.level;
  const v = lv >= 0 && lv < T_LEVEL.keeperReactTicks.length && (lv | 0) === lv ? T_LEVEL.keeperReactTicks[lv]! : 0;
  return v === v ? v : 0;
}

/** [QF-2] Keeper k's save reaction delay: gkReflexes (keeperReactTicks) + his team's CPU level part, >= 0, ticks. */
export function keeperReactionTicks(s: SimState, k: number): number {
  const t = keeperReactTicks(s.attrs[k]!) + levelReactTicks(s, k);
  return t > 0 ? t : 0;
}

/** Has keeper k had time to react to the ball's current flight (since its last touch)? */
function reacted(s: SimState, k: number): boolean {
  const lt = s.ball.lastTouchTick;
  const elapsed = lt >= 0 ? s.tick - lt : NEVER;
  const base = keeperReactionTicks(s, k);
  if (elapsed < base) return false;
  if (elapsed >= base + L.screenMax * L.screenTicks) return true;
  return elapsed >= base + screenTicks(s, k);
}

// ---------------------------------------------------------------- planning

/** Choose how keeper k meets the predicted ball (samples up to PLAN.g). Fills PLAN. */
function planIntercept(s: SimState, team: number, k: number): void {
  const p = s.players[k]!;
  const a = s.attrs[k]!;
  const kin = loadKeeperKin(a, KIN);
  const reach = kin.reach;
  const axTop = standAxisTop(a);
  const hopeTop = kin.h * L.diveTopNearMul + L.hopelessHeightSlack;
  let standI = -1, standD = NEVER;
  let diveI = -1, diveD = NEVER;
  let hopeI = -1, hopeD = NEVER;
  const end = PLAN.g;
  for (let i = 0; i < end; i++) {
    const x = PX[i]!, y = PY[i]!, z = PZ[i]!;
    const dx = x - p.x, dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const t = i + 1;
    // Standing: 3D distance to the standing capsule axis (same shape as the contact volume) within arms + step.
    const dy = y > axTop ? y - axTop : y < STAND_AXIS_LOW ? STAND_AXIS_LOW - y : 0;
    const ds = dy > 0 ? Math.sqrt(d * d + dy * dy) : d;
    if (ds < standD - EPS && ds <= kinStandReach(kin, t)) { standI = i; standD = ds; }
    if (d <= reach && d < diveD - EPS && y <= kinDiveTop(kin, d) && kinDiveTicks(kin, d) <= t) { diveI = i; diveD = d; }
    if (y <= hopeTop && d < hopeD - EPS) { hopeI = i; hopeD = d; }
  }
  let i: number;
  if (standI >= 0) { PLAN.kind = PLAN_STAND; i = standI; PLAN.d = standD; }
  else if (diveI >= 0) { PLAN.kind = PLAN_DIVE; i = diveI; PLAN.d = diveD; }
  else if (hopeI >= 0 && hopeD <= reach * L.hopelessReachMul && hopeI + 1 <= L.hopelessMaxTicks) {
    PLAN.kind = PLAN_HOPELESS; i = hopeI; PLAN.d = hopeD;
  } else if (hopeI >= 0) {
    PLAN.kind = PLAN_TRACK; i = hopeI; PLAN.d = hopeD;
  } else { PLAN.kind = PLAN_NONE; PLAN.i = -1; return; }
  PLAN.i = i;
  PLAN.arrive = i + 1;
  // Hopeless: time the despairing dive so full stretch coincides with the ball's arrival.
  PLAN.need = PLAN.kind === PLAN_DIVE ? kinDiveTicks(kin, PLAN.d)
    : PLAN.kind === PLAN_HOPELESS ? kinDiveTicks(kin, reach) : 1;
  PLAN.x = PX[i]!; PLAN.y = PY[i]!; PLAN.z = PZ[i]!;
}

// ---------------------------------------------------------------- action starts

/** Set or update GK_CATCH (mode = CATCH_*) toward (x, z) for a ball arriving in `arrive` ticks at height y. */
function setCatch(
  s: SimState, team: number, k: number, x: number, y: number, z: number, arrive: number, mode: number,
): void {
  const p = s.players[k]!;
  const dir = s.teams[team]!.dir;
  if (p.act !== ActionKind.GK_CATCH) {
    beginAction(p, ActionKind.GK_CATCH, arrive + L.catchPostTicks, -1);
    p.actKick = KickKind.NONE;
    p.actSlot = -1;
  } else {
    p.actDur = p.actT + arrive + L.catchPostTicks;
  }
  let tx = x;
  if (depthOf(dir, tx) < L.minDepth + 0.15) tx = xOfDepth(dir, L.minDepth + 0.15);
  p.actX = tx;
  p.actZ = z;
  p.actCurve = y;
  p.actA = mode;
  p.actB = 0;
}

function startDiveInternal(s: SimState, k: number, tx: number, ty: number, tz: number): void {
  const p = s.players[k]!;
  const a = s.attrs[k]!;
  let dx = tx - p.x, dz = tz - p.z;
  let d = Math.sqrt(dx * dx + dz * dz);
  // Facing right vector (facing +x, right is +z): (-fz, fx).
  const rx = -p.fz, rz = p.fx;
  if (d < 1e-3) { dx = rx; dz = rz; d = Math.sqrt(dx * dx + dz * dz); if (d < 1e-6) { dx = 0; dz = 1; d = 1; } }
  const ux = dx / d, uz = dz / d;
  const reach = keeperMaxReach(a);
  const target = d < reach ? d : reach;
  const fly = flightTicks(a, diveTravelFor(a, target));
  const full = L.diveWindupTicks + (fly > 0 ? fly : 1);
  // Hand point height: the ball centre may touch up to CAP_TOL above it, so the top of the reach stays diveTop.
  const top = diveTop(a, target) - CAP_TOL;
  const ty2 = clamp(ty, BALL_RADIUS, top > BALL_RADIUS ? top : BALL_RADIUS);
  const cls = ty2 < L.lowMax ? 0 : ty2 < L.midMax ? 1 : 2;
  const ground = cls === 0 ? L.diveGroundLow : cls === 1 ? L.diveGroundMid : L.diveGroundHigh;
  beginAction(p, ActionKind.GK_DIVE, full + L.diveStretchTicks + ground + getUpTicks(a), full);
  p.actX = p.x;
  p.actZ = p.z;
  p.actDirX = ux;
  p.actDirZ = uz;
  p.actPower = reach > EPS ? target / reach : 0;
  p.actCurve = ty2;
  p.actA = cls;
  p.actB = ux * rx + uz * rz >= 0 ? 1 : -1;
  p.actKick = KickKind.NONE;
  p.actSlot = -1;
  p.moveMode = MoveMode.LOCKED;
  p.vx = 0; p.vz = 0; p.ix = 0; p.iz = 0;
  p.lookAt = 0;
  p.wantSprint = 0;
}

/**
 * Start a dive of keeper `slot` toward the point (tx, ty, tz) now (penalties, GKP-06; one-on-ones, GKP-03). The
 * keeper must be active, unstunned and free or in GK_CATCH / GK_RUSH (which are ended first). Physics decides the save.
 * Returns 1 if started.
 */
export function startKeeperDive(s: SimState, slot: number, tx: number, ty: number, tz: number): number {
  if (slot < 0 || slot >= NUM_SLOTS) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.isKeeper !== 1 || p.stunT > 0) return 0;
  if (!isFiniteNum(tx) || !isFiniteNum(ty) || !isFiniteNum(tz)) return 0;
  if (p.act === ActionKind.GK_CATCH || p.act === ActionKind.GK_RUSH) endAction(s, slot, 1);
  if (p.act !== ActionKind.NONE) return 0;
  startDiveInternal(s, slot, tx, ty, tz);
  return 1;
}

function isFiniteNum(v: number): boolean {
  return v - v === 0;
}

// ---------------------------------------------------------------- decision

export function keeperSaveDecision(s: SimState, team: number, ev: EventSink): void {
  const k = s.teams[team]!.keeperSlot;
  if (k < 0 || k >= NUM_SLOTS) return;
  const p = s.players[k]!;
  if (p.active !== 1 || p.isKeeper !== 1 || p.stunT > 0) return;
  const act = p.act;
  if (act !== ActionKind.NONE && act !== ActionKind.GK_CATCH && act !== ActionKind.GK_RUSH) return;
  if (act === ActionKind.GK_CATCH && p.actDone === 1) return; // played the ball: let the window run out
  if (!evaluateThreat(s, team, k)) {
    // [QF-11 skeptic] A fast ball already past him into the goal: he stays put (the running GK_CATCH, or a planted
    // stance) until it is in or away, so SIM-07 never gives him a first touch on it from behind (a shot that had beaten
    // him went in off his heavy touch as an own goal, the scorer lost).
    if (passedHim(s, team, k)) {
      if (act === ActionKind.GK_CATCH) { if (p.actDur < p.actT + 2) p.actDur = p.actT + 2; }
      else if (act === ActionKind.NONE) setCatch(s, team, k, p.x, s.ball.y, p.z, 1, CATCH_PLANTED);
      return;
    }
    if (act === ActionKind.GK_CATCH) {
      // [QF-11 skeptic] A flicker of the prediction (a slow ball at the edge of reaching his line) does not end a set
      // catch at once while the ball still comes at him: GKP-03 took the keeper back into its rush 3 ticks later and
      // GKP-02 out again (a start / abort flip-flop). actB counts the ticks without a threat (setCatch resets it).
      if (p.actA !== CATCH_PLANTED && p.actB < T_GK.catchKeepTicks && ballComing(s, k)) {
        p.actB++;
        if (p.actDur < p.actT + 2) p.actDur = p.actT + 2;
        return;
      }
      endAction(s, k, 1);
    }
    return;
  }
  if (!reacted(s, k)) {
    // Not reacted yet: he plants his feet where he is (body only, no reaching arms) so positioning cannot move him
    // early; an earlier plan (a deflection restarts the reaction) keeps its spot.
    if (act === ActionKind.NONE) setCatch(s, team, k, p.x, s.ball.y, p.z, L.setHoldTicks, CATCH_PLANTED);
    else if (act === ActionKind.GK_CATCH && p.actDur < p.actT + L.setHoldTicks + L.catchPostTicks) {
      p.actDur = p.actT + L.setHoldTicks + L.catchPostTicks;
    }
    return;
  }
  planIntercept(s, team, k);
  if (PLAN.kind === PLAN_NONE) {
    if (act === ActionKind.GK_CATCH) endAction(s, k, 1);
    return;
  }
  if (act === ActionKind.GK_RUSH) endAction(s, k, 1);
  if (PLAN.kind === PLAN_STAND) {
    setCatch(s, team, k, PLAN.x, PLAN.y, PLAN.z, PLAN.arrive, CATCH_STAND);
    return;
  }
  const commit = PLAN.kind !== PLAN_TRACK && PLAN.arrive - PLAN.need <= L.commitSlackTicks;
  if (!commit) {
    setCatch(s, team, k, PLAN.x, PLAN.y, PLAN.z, PLAN.arrive, CATCH_TRACK);
    return;
  }
  if (p.act !== ActionKind.NONE) endAction(s, k, 1);
  startDiveInternal(s, k, PLAN.x, PLAN.y, PLAN.z);
}

// ---------------------------------------------------------------- contacts

/** Is the ball live for keeper contacts in this phase? */
function contactsLive(s: SimState): boolean {
  const ph = s.match.phase;
  if (ph === MatchPhase.IN_PLAY || ph === MatchPhase.SHOOT_OUT) return true;
  if (RESTART_PHASES.includes(ph)) return s.match.restart.taken === 1;
  return false;
}

/** Unready keeper: is a fast ball coming at his goal (straight-line check, reaching the line)
 * so his body may block it? */
function reflexEligible(s: SimState, team: number): boolean {
  const b = s.ball;
  const dir = s.teams[team]!.dir;
  const vg = -dir * b.vx;
  if (vg < L.reflexMinSpeed) return false;
  if (teammateFootPass(s, team)) return false;
  const u = depthOf(dir, b.x);
  const t = (u > 0 ? u : 0) / vg;
  if (t > L.reflexHorizon) return false;
  // A rolling ball that stops short of the goal is gathered (first touch / collect), not blocked.
  const rolling = b.y <= BALL_RADIUS + 0.02 && b.vy < 0.5 && b.vy > -0.5;
  if (rolling && (b.vx * b.vx + b.vz * b.vz) < 2 * T_BALL.rollDecel * u) return false;
  const zl = b.z + b.vz * t;
  if (zl > GOAL_HALF_WIDTH + L.reflexMouthMargin || zl < -GOAL_HALF_WIDTH - L.reflexMouthMargin) return false;
  const yl = b.y + b.vy * t - 0.5 * T_BALL.gravity * t * t;
  return yl <= GOAL_HEIGHT + L.reflexMouthMargin;
}

/** Build keeper k's contact volume into VOL for this tick. */
function buildVolume(s: SimState, team: number, k: number): void {
  const p = s.players[k]!;
  const a = s.attrs[k]!;
  VOL.kind = VOL_NONE; VOL.reflex = 0;
  const act = p.act;
  if (act === ActionKind.GK_DIVE) {
    if (p.actDone === 1 || p.actT > p.actContact + L.diveStretchTicks) return;
    const ty = p.actCurve;
    const hip = clamp(lerp(L.hipStand, ty, L.hipBlend), L.hipMin, L.hipMax);
    const ext = diveHandOffset(a, diveTargetDist(a, p.actPower)) * armExt(p.actT);
    const feetY = hip - 0.5 > 0.15 ? hip - 0.5 : 0.15;
    VOL.kind = VOL_DIVE;
    VOL.ax = p.x - p.actDirX * L.legLength; VOL.ay = feetY; VOL.az = p.z - p.actDirZ * L.legLength;
    VOL.bx = p.x + p.actDirX * ext; VOL.by = ty; VOL.bz = p.z + p.actDirZ * ext;
    VOL.r = L.handRadius;
    return;
  }
  if (act === ActionKind.GK_CATCH && p.actA === CATCH_PLANTED) {
    if (p.actDone === 1) return;
    const h = heightM(a);
    VOL.kind = VOL_BODY;
    VOL.ax = p.x; VOL.ay = 0.3; VOL.az = p.z;
    VOL.bx = p.x; VOL.by = h - 0.3; VOL.bz = p.z;
    VOL.r = L.bodyRadius;
    return;
  }
  if (act === ActionKind.GK_CATCH) {
    if (p.actDone === 1) return;
    VOL.kind = VOL_STAND;
    VOL.ax = p.x; VOL.ay = STAND_AXIS_LOW; VOL.az = p.z;
    VOL.bx = p.x; VOL.by = standAxisTop(a); VOL.bz = p.z;
    VOL.r = L.standArm;
    return;
  }
  if (act === ActionKind.NONE || act === ActionKind.GK_RUSH) {
    const reflex = reflexEligible(s, team);
    // [QF-11 skeptic] Gather: an idle AI keeper takes a loose ball that reaches his hands into them (a post rebound,
    // a dropping ball, a cross or a shot going wide along his line) instead of leaving it to SIM-07's outfield first
    // touch, which settles it along his run (back to his line) and put it in his own net (2 own goals in 30
    // matches). A ball he cannot catch falls back to the reflex body block (keeperContact).
    if (act === ActionKind.NONE && inGatherZone(s, team) && !isHumanSlot(s, k) && canHandle(s, k)) {
      const top = standTop(a) - T_GK.gatherReach - BALL_RADIUS;
      VOL.kind = VOL_GATHER;
      VOL.ax = p.x; VOL.ay = STAND_AXIS_LOW; VOL.az = p.z;
      VOL.bx = p.x; VOL.by = top > STAND_AXIS_LOW ? top : STAND_AXIS_LOW; VOL.bz = p.z;
      VOL.r = T_GK.gatherReach;
      VOL.reflex = reflex ? 1 : 0;
      return;
    }
    if (reflex) bodyVolume(s, k);
  }
}

/**
 * [QF-11 skeptic] The gather is for his goal area (GOAL_AREA_DEPTH x GOAL_AREA_HALF_WIDTH, lines included), where an
 * outfield-style first touch back toward his line can put the ball in his own net; elsewhere in the box the ball is
 * received / claimed as before.
 */
function inGatherZone(s: SimState, team: number): boolean {
  const b = s.ball;
  const u = depthOf(s.teams[team]!.dir, b.x);
  return u <= GOAL_AREA_DEPTH + BALL_RADIUS && b.z <= GOAL_AREA_HALF_WIDTH + BALL_RADIUS &&
    b.z >= -GOAL_AREA_HALF_WIDTH - BALL_RADIUS;
}

/** Keeper k's body-only volume (unready keeper / reflex block). */
function bodyVolume(s: SimState, k: number): void {
  const p = s.players[k]!;
  const h = heightM(s.attrs[k]!);
  VOL.kind = VOL_BODY;
  VOL.ax = p.x; VOL.ay = 0.3; VOL.az = p.z;
  VOL.bx = p.x; VOL.by = h - 0.3; VOL.bz = p.z;
  VOL.r = L.bodyRadius;
}

/**
 * [QF-11 skeptic] Does the gather volume in VOL take this tick's ball into keeper k's hands (reach, inside the area,
 * slow enough to catch at that height, canHandle, reacted)? Leaves the closest points in SEG.
 */
function gatherCatches(s: SimState, team: number, k: number): boolean {
  const b = s.ball;
  segSeg(b.px, b.py, b.pz, b.x, b.y, b.z, VOL.ax, VOL.ay, VOL.az, VOL.bx, VOL.by, VOL.bz);
  const rr = VOL.r + BALL_RADIUS;
  if (SEG.d2 > rr * rr) return false;
  const p = s.players[k]!;
  const dir = s.teams[team]!.dir;
  if (depthOf(dir, SEG.ax) < -BALL_RADIUS) return false;
  if (!inOwnArea(dir, SEG.ax, SEG.az, BALL_RADIUS) || !inOwnArea(dir, p.x, p.z, L.standArm) || teammateFootPass(s, team)) {
    return false;
  }
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  // He has to have seen it coming (GKP-02's reaction delay, the level part included: a slow keeper stays slow).
  return sp <= catchLimit(s.attrs[k]!, 0, SEG.ay) && canHandle(s, k) && reacted(s, k);
}

/** Hands catch limit of a keeper with attributes a at dive stretch 0..1 and contact height cy, m/s. */
function catchLimit(a: Readonly<PlayerAttrs>, stretch: number, cy: number): number {
  let limit = T_GK.catchSpeed * attr(a.gkHandling, L.catchMulWorst, L.catchMulBest) * (1 - L.stretchCatchPenalty * stretch);
  if (cy > L.headHeight) limit *= 1 - L.highCatchPenalty;
  return limit;
}

/** Was the ball (at the contact point, with its current velocity) going into team's goal? */
function wasOnTarget(s: SimState, team: number, cx: number, cy: number, cz: number): boolean {
  const b = s.ball;
  if (b.shotBy >= 0 && b.shotOnTarget === 1 && s.players[b.shotBy]!.team !== team) return true;
  const dir = s.teams[team]!.dir;
  const vg = -dir * b.vx;
  if (vg <= 0) return false;
  // Crossed the line inside the mouth this very tick (before the contact point was found in front of it).
  if (depthOf(dir, b.x) < -BALL_RADIUS) {
    return b.z <= GOAL_HALF_WIDTH && b.z >= -GOAL_HALF_WIDTH && b.y <= GOAL_HEIGHT;
  }
  // This tick's decision predicted from the start of the tick: if sample 0 is the ball now, the rest is its future.
  if (MEMO.valid === 1 && MEMO.tick === s.tick && MEMO.n > 1 && MEMO.touch === b.lastTouchTick && sampleIs(0, b)) {
    return goalSample(dir, 0, 1, MEMO.n) >= 0;
  }
  copyBall(SCRATCH_BALL, b);
  SCRATCH_BALL.x = cx; SCRATCH_BALL.y = cy; SCRATCH_BALL.z = cz;
  SCRATCH_BALL.px = cx; SCRATCH_BALL.py = cy; SCRATCH_BALL.pz = cz;
  SCRATCH_BALL.heldBy = -1; SCRATCH_BALL.owner = -1;
  if (cy > BALL_RADIUS + 1e-6) SCRATCH_BALL.grounded = 0;
  const count = predict(SCRATCH_BALL, horizonTicks(depthOf(dir, cx), vg), s.tick, 0, dir);
  return goalSample(dir, 0, 0, count) >= 0;
}

/** Undo a goal-line crossing recorded this tick at team's end when the keeper stopped the ball in front of it. */
function undoCrossing(s: SimState, team: number): void {
  const b = s.ball;
  const end = -s.teams[team]!.dir;
  if (b.cross !== CrossKind.NONE && b.crossEnd === end) {
    b.cross = CrossKind.NONE;
    b.crossX = 0; b.crossZ = 0; b.crossEnd = 0;
  }
  if (b.inNet === end) b.inNet = 0;
}

function placeBall(s: SimState, x: number, y: number, z: number): void {
  const b = s.ball;
  b.x = x;
  b.y = y < BALL_RADIUS ? BALL_RADIUS : y;
  b.z = z;
}

function launch(s: SimState, k: number, vx: number, vy: number, vz: number, kind: KickKind, ev: EventSink): void {
  const b = s.ball;
  LAUNCH.vx = vx; LAUNCH.vy = vy; LAUNCH.vz = vz;
  LAUNCH.sx = 0; LAUNCH.sy = 0; LAUNCH.sz = 0;
  LAUNCH.kind = kind;
  LAUNCH.target = -1;
  LAUNCH.tx = b.x + vx; LAUNCH.tz = b.z + vz;
  LAUNCH.onTarget = 0;
  applyKick(s, k, LAUNCH, 0, ev);
  b.grounded = b.y > BALL_RADIUS + 1e-6 || vy > 0.5 ? 0 : b.grounded;
}

/** Parry quality 0..1 (handling + reflexes, worse at full stretch) with a little deterministic noise. */
function parry(s: SimState, team: number, k: number, stretch: number, sp: number, cz: number, ev: EventSink): void {
  const a = s.attrs[k]!;
  const p = s.players[k]!;
  const dir = s.teams[team]!.dir;
  const b = s.ball;
  const skill = clamp01(((a.gkHandling + a.gkReflexes) * 0.5 - 1) / 98);
  const q = clamp01(skill * (1 - L.parryStretchPenalty * stretch));
  let ang = lerp(L.parryAnglePoor, L.parryAngleGood, q) + rngRange(s.rng, -L.parryNoise, L.parryNoise);
  if (ang < 0.05) ang = 0.05; else if (ang > 1.35) ang = 1.35;
  let side: number;
  if (cz > L.parryCentreBand) side = 1;
  else if (cz < -L.parryCentreBand) side = -1;
  else if (p.act === ActionKind.GK_DIVE && (p.actDirZ > 1e-3 || p.actDirZ < -1e-3)) side = p.actDirZ > 0 ? 1 : -1;
  else side = b.vz >= 0 ? 1 : -1;
  let speed = sp * lerp(L.parryRestPoor, L.parryRestGood, q);
  if (speed < L.parryMinSpeed) speed = L.parryMinSpeed;
  const hx = dir * dcos(ang);
  const hz = side * dsin(ang);
  const vy = lerp(L.parryLiftPoor, L.parryLiftGood, q) + (b.y > L.headHeight ? L.parryHighLift : 0);
  launch(s, k, hx * speed, vy, hz * speed, KickKind.GK_PARRY, ev);
}

function tipOver(s: SimState, team: number, k: number, ev: EventSink): void {
  const b = s.ball;
  const dir = s.teams[team]!.dir;
  const vg = -dir * b.vx;
  let g = vg * L.tipGoalwardFrac;
  if (g < L.tipGoalwardMin) g = L.tipGoalwardMin;
  const u = depthOf(dir, b.x);
  const t = ((u > 0 ? u : 0) + 0.3) / g;
  let vy = (L.tipClearHeight - b.y + 0.5 * T_BALL.gravity * t * t) / t;
  if (vy > L.tipMaxLift) vy = L.tipMaxLift; else if (vy < 1) vy = 1;
  launch(s, k, -dir * g, vy, b.vz * 0.5, KickKind.GK_TIP, ev);
}

function block(
  s: SimState, team: number, vx: number, vy: number, vz: number, nx: number, ny: number, nz: number, k: number,
  ev: EventSink,
): void {
  const dir = s.teams[team]!.dir;
  let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nl < 1e-6) { nx = dir; ny = 0; nz = 0; nl = 1; }
  nx /= nl; ny /= nl; nz /= nl;
  const vn = vx * nx + vy * ny + vz * nz;
  let ox: number, oy: number, oz: number;
  if (vn < 0) {
    const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    const r = -vn * L.blockRestitution;
    ox = tx * L.blockTangential + nx * r; oy = ty * L.blockTangential + ny * r; oz = tz * L.blockTangential + nz * r;
  } else {
    ox = vx * L.blockTangential; oy = vy * L.blockTangential; oz = vz * L.blockTangential;
  }
  const goalward = -dir * ox;
  if (goalward > 0) ox = dir * goalward * L.blockGoalwardKeep; // bounce back out, never on into the goal
  launch(s, k, ox, oy, oz, KickKind.DEFLECTION, ev);
}

/** Try keeper k's contact with the ball this tick. Returns 1 if he touched it. */
function keeperContact(s: SimState, team: number, ev: EventSink): number {
  const k = s.teams[team]!.keeperSlot;
  if (k < 0 || k >= NUM_SLOTS) return 0;
  const p = s.players[k]!;
  if (p.active !== 1 || p.isKeeper !== 1) return 0;
  const b = s.ball;
  if (b.lastTouch === k && b.lastTouchTick >= 0 && s.tick - b.lastTouchTick < L.recontactTicks) return 0;
  buildVolume(s, team, k);
  if (VOL.kind === VOL_GATHER && !gatherCatches(s, team, k)) {
    // [QF-11 skeptic] A gather is a catch or nothing: else the reflex body block (a fast ball at goal) or no contact.
    if (VOL.reflex !== 1) return 0;
    bodyVolume(s, k);
  }
  if (VOL.kind === VOL_NONE) return 0;
  segSeg(b.px, b.py, b.pz, b.x, b.y, b.z, VOL.ax, VOL.ay, VOL.az, VOL.bx, VOL.by, VOL.bz);
  const rr = VOL.r + BALL_RADIUS;
  if (SEG.d2 > rr * rr) return 0;
  const dir = s.teams[team]!.dir;
  const cx = SEG.ax, cy = SEG.ay, cz = SEG.az;
  if (depthOf(dir, cx) < -BALL_RADIUS) return 0; // whole ball already over the line: the goal stands
  const vx = b.vx, vy = b.vy, vz = b.vz;
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const a = s.attrs[k]!;
  const isDive = VOL.kind === VOL_DIVE;
  const hands = VOL.kind !== VOL_BODY && (!isDive || SEG.t >= L.handsFrom) &&
    inOwnArea(dir, cx, cz, BALL_RADIUS) && inOwnArea(dir, p.x, p.z, L.standArm) && !teammateFootPass(s, team);
  const onTarget = wasOnTarget(s, team, cx, cy, cz);
  let stretch = 0;
  if (isDive) {
    // How far out he is: hip travel + hand offset as a fraction of his max reach.
    const td = diveTargetDist(a, p.actPower);
    const out = hipTravel(a, p.actT, diveTravelFor(a, td)) + diveHandOffset(a, td);
    stretch = clamp01(out / (keeperMaxReach(a) - CAP_TOL));
  }
  const nx = cx - SEG.bx, ny = cy - SEG.by, nz = cz - SEG.bz;
  // From here on the ball is played at the contact point.
  undoCrossing(s, team);
  placeBall(s, cx, cy, cz);
  let kind: SaveKind;
  if (hands) {
    if (sp <= catchLimit(a, stretch, cy) && canHandle(s, k)) {
      b.vx = 0; b.vy = 0; b.vz = 0; b.sx = 0; b.sy = 0; b.sz = 0;
      if (p.act === ActionKind.GK_DIVE || p.act === ActionKind.GK_CATCH) endAction(s, k, 1);
      keeperPickUp(s, k, ev);
      if (b.heldBy === k) {
        if (onTarget) ev.emit(EventType.SAVE, k, SaveKind.CATCH, sp, 0, cx, cy, cz);
        return 1;
      }
      // Pick-up refused: the ball drops off his hands (parry). Restore the incoming velocity first.
      b.vx = vx; b.vy = vy; b.vz = vz;
    }
    const u = depthOf(dir, cx);
    // [QF-11 skeptic] Not under the bar's footprint: a ball tipped up from closer than tipBarFront to the line meets the
    // underside of the bar and drops in (12 of 70 test tips at the line went in as own goals); he pushes it out.
    if (cy >= GOAL_HEIGHT - L.tipBand && u <= L.tipMaxDepth && sp >= L.tipMinSpeed && -dir * vx > 0 &&
      u >= T_GK.tipBarFront) {
      tipOver(s, team, k, ev);
      kind = SaveKind.TIP_OVER;
    } else {
      parry(s, team, k, stretch, sp, cz, ev);
      kind = SaveKind.PARRY;
    }
  } else {
    block(s, team, vx, vy, vz, nx, ny, nz, k, ev);
    kind = SaveKind.BLOCK;
  }
  if (p.act === ActionKind.GK_DIVE || p.act === ActionKind.GK_CATCH) {
    p.actDone = 1;
    p.actKick = kind === SaveKind.TIP_OVER ? KickKind.GK_TIP
      : kind === SaveKind.PARRY ? KickKind.GK_PARRY : KickKind.DEFLECTION;
  }
  if (onTarget) ev.emit(EventType.SAVE, k, kind, sp, 0, cx, cy, cz);
  return 1;
}

export function keeperContacts(s: SimState, ev: EventSink): void {
  if (!contactsLive(s)) return;
  const b = s.ball;
  if (ballTouchedThisTick(s) || b.heldBy >= 0 || b.owner >= 0) return;
  if (keeperContact(s, 0, ev) === 1) return;
  keeperContact(s, 1, ev);
}

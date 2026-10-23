/**
 * [SIM-08] Ground, driven and dinked passes: targeting, power, error. Also owns the generic KICK action
 * handler (wind-up, power charging while p.actCharging, contact, recovery) used by every foot kick; at contact
 * it calls KICK_SOLVERS[p.actKick] (sim/actions/registry.ts) and applies the launch via core/kick.ts applyKick.
 * Section 6 "Passing": hold time fills a power bar; target blends stick direction, the distance that power
 * implies, and how open each receiver is. Assistance: Assisted (default), Semi, Manual. Error grows with weak
 * attributes, body facing away, pressure, full sprint, weaker foot and extreme power. The intended receiver
 * (ball.passTarget) moves to collect on his own until the user steers him.
 *
 * KICK ACTION (kickHandler, every ActionKind.KICK: passes, lobs, crosses, through balls, clearances, skill touches).
 * The starter sets actContact (wind-up ticks) and actDur (wind-up + contact + recovery); the handler:
 *  - wind-up (actT < actContact) and charging (actT >= actContact while p.actCharging; SIM-15 raises p.actPower from
 *    the hold time): movement slowed (DIRECT stick magnitude capped at LT.windupMoveScale, ARRIVE speed at that x jog,
 *    no sprint). SIM-06 holds the owned ball on the kicking spot meanwhile. A held charge waits at most
 *    T_PASS.powerFillTicks + LT.chargeWaitExtraTicks past the planned contact, then is released here (no stuck
 *    power bar even if the button never comes up).
 *  - dispossessed (someone else owns / holds the ball) at any time before contact: whiff at once and recover.
 *  - [QF-10] released charge: the first tick after the power bar is released the contact moves to
 *    T_PASS.releaseStrikeTicks after it (kickCommon.ts releaseStrike; not for a first-time kick of a ball arriving).
 *  - contact (first tick with actT >= actContact and not charging): the phase must be live for him (IN_PLAY; a restart
 *    phase as its taker or once taken; the shoot-out kicker), the ball untouched by anyone else this tick and in reach
 *    of his foot ([QF-10] kickCommon.ts footCanStrike: within LT.reachRadius of his body, at most LT.reachHeight high
 *    and within T_KICK.spotReach of his kicking spot, also for his own ball). His own ball out of reach (a touch
 *    ahead, still dropping, behind him) delays the contact up to LT.ownReachWaitTicks while SIM-06 holds it onto the
 *    kicking spot; a loose ball still arriving (first-time kicks) up to LT.contactGraceTicks; a restart taker's dead
 *    ball not at his kicking spot: he side-steps round it first (kickCommon.ts lineUpOnDeadBall). Then
 *    KICK_SOLVERS[actKick] fills the launch and core/kick.ts applyKick plays it (KICK event, possession / pass-target /
 *    restart bookkeeping). Anything else is a whiff. Either way actContact moves to the actual contact tick and actDur
 *    keeps the planned recovery after it (actDone = 1). Pass and go
 *    (ReqFlag.PASS_AND_GO on a pass): team.passGoSlot = passer, team.passGoT = LT.passGoTicks (TAI-03 makes the run).
 *  - recovery: MoveMode.LOCKED for LT.contactLockTicks from the contact (follow-through; SIM-04 applies its locked
 *    friction), then STOP for a tick (the resolver / AI write the intent again) and the stick cap ramps back to 1.
 *
 * PASS ACTION FIELDS (startPass): actKick = kind; actPower / actCharging from the request; actDirX/Z = unit request
 * direction (0, 0 = facing); actSlot = explicit receiver (validated teammate) or -1; actX/actZ = explicit target point
 * when actB bit 2 is set; actCurve = request curl (unused by ground passes); actA = ReqFlag bits; actB = AssistLevel
 * (bits 0..1) | hasTarget << 2. Contact tick = T_PASS.windup, duration windup + contact + recovery. A pass starts only
 * when the player is free, the phase is live for him and the ball is his, at his feet, or arriving within the wind-up
 * (+ LT.startArriveTicks) on a path within LT.startArriveLane of him.
 *
 * SOLVER (solveGroundPass, at contact; reads the action fields, draws s.rng for error only):
 *  - Receiver: actSlot (gesture / receiver lock / set piece), else selectReceiver (Assisted / Semi; none with an
 *    explicit point or Manual). With a receiver the target is his predicted position when the ball arrives (his
 *    velocity extrapolated over the travel time: secant iterations on that fixed point, LT.leadIters, capped at
 *    LT.leadMaxSec, kept LT.pitchMargin inside the lines): a moving receiver is led. A lead pass arrives at least
 *    LT.leadArriveMargin faster than he runs away from the ball, so it catches him.
 *  - Speed: ground / kick-off = SIM-01 groundPassSpeed(distance, assisted arrival speed lerp(arriveMin, arriveMax,
 *    power)); Semi blends LT.semiPowerBlend of the power-only speed lerp(groundMin, groundMax, power) into it; Manual
 *    uses the power-only speed and the request direction only. Clamped to T_PASS.groundMin..groundMax. Driven =
 *    the ground speed x T_PASS.drivenMul (range x drivenMul too): faster and flat. Dinked = launched at
 *    T_PASS.dinkedAngle (+ LT.dinkAngleOffsets when a bounce would meet the target: see solveDink) with the speed found
 *    by bisection over an open-field model of the sim's ball physics (SIM-01 air steps for every flight, SIM-02's
 *    bounce rule at its substep timing, the roll model in closed form; see dinkTrial) so the ball first reaches the
 *    target with lerp(dinkArriveMin, dinkArriveMax, power) m/s: it lifts over a defender's legs, bounces and rolls on.
 *  - No receiver: Assisted / Semi pass into space along the request direction over the power-implied distance;
 *    Manual at the power-only speed. A teammate within LT.laneReceiverWidth of that line (before the ball stops)
 *    becomes the pass target so he still collects it.
 *  - Error: kickErrorAim rotates the launch direction. launch.target = receiver (-1 none) and tx/tz = the intended
 *    reception point drive ball.passTarget / passX / passZ (TAI-14 RECEIVE, SIM-16 auto-switching, SIM-15 receiver).
 *
 * RECEIVER SELECTION (selectReceiver, pure): teammates (not the passer, active, LT.minReceiverDist..T_PASS.maxRange
 * away) inside the cone of half-angle T_PASS.coneHalfAngle x (LT.assistedConeMul | LT.semiConeMul) around the stick
 * (facing when the stick is idle), each at his position LT.selectLeadMax-capped ahead along his run. Score =
 * alignment (1 on the stick line .. 0 at the cone edge) x alignWeight(Semi) + fit to the power-implied distance
 * (lerp(groundDistMin, groundDistMax, power); lofted: loftedDistMin..T_PASS.maxRange) x distWeight + openness x
 * T_PASS.opennessWeight + forward progress x progressWeight. Openness = 1 - laneWeight x (worst opponent near the
 * passing lane; x loftLaneMul when lofted) - markWeight x (closest marker within markRadius). Highest score wins
 * (ties: lower slot). Manual returns -1.
 *
 * ERROR (kickErrorAim / kickError): sigma = T_PASS.errorMax x (minErrorFrac + (1 - minErrorFrac) x (1 - accuracy)^2)
 * x (1 + facingErrorMul x (1 - cos(facing, aim)) / 2) x (1 + pressureErrorMul x pressureOn) x (1 + sprintErrorMul x
 * sprint fraction above jog when sprinting) x weak foot (1 + (T_PASS.weakFootErrorMul - 1) x (5 - weakFoot) / 4 when
 * the weaker foot plays it) x (1 + powerErrorMul above powerKnee) x (1 + staminaErrorMul x low-stamina fraction),
 * capped at errorCapMul x errorMax; error = sigma x rngGauss (four draws, always). Pass accuracy = shortPassing up to
 * LT.shortRange, longPassing from LT.longRange (blended between). Foot used: the side of the body the ball is on
 * (beyond LT.footSideBand), else the preferred foot unless the pass turns sharply (sine > LT.weakTurnSin) toward the
 * preferred foot's side.
 *
 * Determinism / cost: plain arithmetic, Math.sqrt and dmath (dcos/dsin/dlog/dexp), s.rng only in the solver, slot-order
 * scans with strict tie breaks, module scratch only (no per-tick allocation). Per tick per kicker: a few flops of
 * movement capping. At contact: O(11 x 11) receiver scoring, a few closed-form roll solves; a dinked pass adds model
 * trials (bisections of <= LT.dinkIters + 2 per launch angle, at most LT.dinkMaxTrials + one bisection + nudges; each
 * trial <= LT.dinkMaxTicks / 3 three-tick air steps: p50 ~32, max ~54 trials per solve).
 */
// Re-export the registry-facing shells FIRST: see passHooks.ts (import-cycle safety with actions/registry).
export { kickHandler, solveGroundPass } from './passHooks';
import { bindPassImpl } from './passHooks';
import { beginAction, isFree } from '../actions/dispatch';
import { KICK_SOLVERS } from '../actions/registry';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ } from '../../contracts/constants';
import { ActionKind, AssistLevel, Foot, KickKind, MatchPhase, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { createBallState, MoveMode, type BallState, type PlayerState, type SimState } from '../../contracts/state';
import { createKickLaunch, ReqFlag, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_BALL, T_PASS, T_PLAYER, T_PASS_KICK, T_BALL_CONTACT, T_KICK } from '../../contracts/tuning';
import { MAX_SUBSTEPS } from '../ball/contact';
import { ballAirStep, groundPassSpeed, groundRollTime } from '../ball/flight';
import { dcos, dexp, dlog, dsin } from '../core/dmath';
import { applyKick, ballTouchedThisTick } from '../core/kick';
import { pressureOn } from '../core/query';
import { rngGauss } from '../core/rng';
import { staminaFactor } from '../players/locomotion';
import { footCanStrike, isDeadBallTaker, lineUpOnDeadBall, noteCharging, releaseStrike } from './kickCommon';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_PASS_KICK. */
export const LOCAL_TUNING = T_PASS_KICK;


const LT = T_PASS_KICK;

/** [QF-10] Model trials run by the current solveDink (bounded by LT.dinkMaxTrials). */
let dinkTrials = 0;

// Hot-path copies of imported constants (module-level locals: no import-binding lookups per tick).
const NS = NUM_SLOTS;
const PPT = PLAYERS_PER_TEAM;
const HZ = TICK_HZ;
const LIM_X = HALF_LENGTH - LT.pitchMargin;
const LIM_Z = HALF_WIDTH - LT.pitchMargin;
const REACH2 = LT.reachRadius * LT.reachRadius;
const REACH_H = LT.reachHeight;
const MOVE_CAP = LT.windupMoveScale;
const LOCK_T = LT.contactLockTicks;
const CHARGE_WAIT = T_PASS.powerFillTicks + LT.chargeWaitExtraTicks;
const JOG_FRAC = T_PLAYER.jogFraction;
const ROLL_A = T_BALL.rollDecel;
const ROLL_C = T_BALL.rollDamping;
const DINK_COS = dcos(T_PASS.dinkedAngle);
const DINK_SIN = dsin(T_PASS.dinkedAngle);
/** [QF-10] Dinked launch angle candidates (T_PASS.dinkedAngle + offset, rad; see solveDink). */
const DINK_ANGLES = LT.dinkAngleOffsets.length;
const DINK_ANGLE_COS = new Float64Array(DINK_ANGLES);
const DINK_ANGLE_SIN = new Float64Array(DINK_ANGLES);
for (let k = 0; k < DINK_ANGLES; k++) {
  DINK_ANGLE_COS[k] = dcos(T_PASS.dinkedAngle + LT.dinkAngleOffsets[k]!);
  DINK_ANGLE_SIN[k] = dsin(T_PASS.dinkedAngle + LT.dinkAngleOffsets[k]!);
}
const COS_CONE_ASSISTED = dcos(T_PASS.coneHalfAngle * LT.assistedConeMul);
const COS_CONE_SEMI = dcos(T_PASS.coneHalfAngle * LT.semiConeMul);
const DEFAULT_REC = T_PASS.contact + T_PASS.recovery;
/** A target closer to the ball than this gives no usable aim, m. */
const AIM_MIN_DIST = 0.25;
/** Lead fixed point tolerance, s. */
const LEAD_TOL = 1e-3;
/** First-flight integration step of the dinked model: 3 ticks (the midpoint integrator is exact for gravity and
 *  second order in the tiny drag term; the landing is interpolated inside the step), and the step cap. */
const DINK_DT = 3 / TICK_HZ;
const DINK_FLIGHT_STEPS = Math.ceil(LT.dinkMaxTicks / 3);
/** SIM-02: ground impacts slower than this (vertical, m/s) grip only partly. */
const FULL_GRIP = T_BALL_CONTACT.fullGripImpactSpeed;

/** 1 for restart phases (index = MatchPhase). */
const RESTART_PHASE = new Uint8Array(MatchPhase.POST_MATCH + 1);
for (const ph of RESTART_PHASES) RESTART_PHASE[ph] = 1;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

const LAUNCH = createKickLaunch();
/** Scratch ball for the dinked-pass model's first flight. */
const DINK = createBallState();
/** Solver scratch (numbers handed between helpers; V8 boxes doubles passed to / returned from non-inlined calls). */
const F = new Float64Array(26);
/** Target point (x, z), its distance from the ball and the travel time of the last speed solve (s). */
const F_TX = 0, F_TZ = 1, F_D = 2, F_T = 3;
/** Unit aim (x, z). */
const F_UX = 4, F_UZ = 5;
/** Last dinked trial: time the target distance was reached (s, -1 never) and the time of the accepted speed. */
const F_TRIAL_T = 6, F_OK_T = 7;
/** Lane receiver meeting point. */
const F_LX = 8, F_LZ = 9;
/** Lead: receiver position and velocity, the travel-time ratio of the real kick to the ground model, and the arrival
 *  speed floor (the receiver's speed away from the ball along the aim + LT.leadArriveMargin; 0 = none). */
const F_QX = 10, F_QZ = 11, F_QVX = 12, F_QVZ = 13, F_RATIO = 14, F_AMIN = 15;
/** [QF-10] Dinked launch angle in trial (cos, sin), the last trial's bounce margin (s: time from the target to the
 *  nearest bounce), the accepted speed's margin, and the chosen launch angle (cos, sin). */
const F_CA = 16, F_SA = 17, F_TRIAL_M = 18, F_OK_M = 19, F_DCA = 20, F_DSA = 21;
/** [QF-10] Arrival speed of the last trial and of the accepted speed, m/s. */
const F_TRIAL_V = 22, F_OK_V = 23;

// ---------------------------------------------------------------- small helpers

function validSlot(i: number): boolean { return i >= 0 && i < NS && (i | 0) === i; }
function fin(v: number): number { return v === v && v < Infinity && v > -Infinity ? v : 0; }
function clamp01(v: number): number { return v > 0 ? (v < 1 ? v : 1) : 0; }
function clampX(x: number): number { return x < -LIM_X ? -LIM_X : x > LIM_X ? LIM_X : x; }
function clampZ(z: number): number { return z < -LIM_Z ? -LIM_Z : z > LIM_Z ? LIM_Z : z; }
/** Attribute 1..99 -> 0..1. */
function attr01(v: number): number { return clamp01((fin(v) - 1) / 98); }

/** True for the kick kinds this module starts and solves. */
export function isPassKind(k: KickKind): boolean {
  return k === KickKind.GROUND_PASS || k === KickKind.DRIVEN_PASS || k === KickKind.DINKED_PASS || k === KickKind.KICK_OFF;
}

/** Active teammate of slot (not slot himself). */
function isTeammate(s: SimState, slot: number, j: number): boolean {
  if (!validSlot(j) || j === slot) return false;
  const q = s.players[j]!;
  return q.active === 1 && q.team === s.players[slot]!.team;
}

/** May `slot` play the ball in the current phase? IN_PLAY; a restart phase as its taker or once taken; the shoot-out kicker. */
function liveFor(s: SimState, slot: number): boolean {
  const m = s.match;
  const ph = m.phase;
  if (ph === MatchPhase.IN_PLAY) return true;
  if (ph >= 0 && ph < RESTART_PHASE.length && RESTART_PHASE[ph] === 1) return m.restart.taken === 1 || m.restart.taker === slot;
  if (ph === MatchPhase.SHOOT_OUT) return m.shootout.kicker === slot;
  return false;
}

/** The ball is his to kick now: not held / owned by anyone else, low, and his own or within reach of his body. */
export function ballInReach(s: SimState, slot: number): boolean {
  if (!validSlot(slot)) return false;
  const b = s.ball;
  if (b.heldBy >= 0) return false;
  if (b.owner >= 0 && b.owner !== slot) return false;
  if (!(b.y <= REACH_H)) return false;
  if (b.owner === slot) return true;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  return dx * dx + dz * dz <= REACH2;
}

/**
 * A loose, low ball whose path relative to the (moving) player enters a circle of radius `lane` around him within
 * `ticks` ticks (straight-line relative motion; fine over the short horizons used here).
 */
function ballArriving(s: SimState, slot: number, ticks: number, lane: number): boolean {
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return false;
  if (!(b.y <= LT.startArriveHeight)) return false;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
  const rv2 = rvx * rvx + rvz * rvz;
  if (!(rv2 > 1e-9)) return false;
  const t = -(dx * rvx + dz * rvz) / rv2;
  if (!(t >= 0)) return false;
  const mx = dx + rvx * t, mz = dz + rvz * t;
  const miss2 = mx * mx + mz * mz;
  const l2 = lane * lane;
  if (!(miss2 <= l2)) return false;
  const tin = t - Math.sqrt((l2 - miss2) / rv2);
  return tin * HZ <= ticks;
}

/** Roll distance of a ground ball launched at v0 until it stops (SIM-02 roll model), m. */
function rollStopDist(v0: number): number {
  if (!(v0 > 0)) return 0;
  if (!(ROLL_C > 0)) return v0 * v0 / (2 * ROLL_A);
  return v0 / ROLL_C - (ROLL_A / (ROLL_C * ROLL_C)) * dlog((ROLL_A + ROLL_C * v0) / ROLL_A);
}

// ---------------------------------------------------------------- starter

/** Start a GROUND_PASS / DRIVEN_PASS / DINKED_PASS (also KICK_OFF). Returns 1 if started. */
export function startPass(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot) || !isPassKind(kind)) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !liveFor(s, slot)) return 0;
  const b = s.ball;
  if (b.heldBy >= 0) return 0;
  if (b.owner >= 0 && b.owner !== slot) return 0;
  if (b.owner !== slot && !ballInReach(s, slot) &&
      !ballArriving(s, slot, T_PASS.windup + LT.startArriveTicks, LT.startArriveLane)) return 0;
  beginAction(p, ActionKind.KICK, T_PASS.windup + DEFAULT_REC, T_PASS.windup);
  p.actKick = kind;
  p.actSkill = SkillMove.NONE;
  p.actPower = clamp01(fin(req.power));
  p.actCharging = req.charging === 1 ? 1 : 0;
  let dx = fin(req.dirX), dz = fin(req.dirZ);
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }
  p.actDirX = dx;
  p.actDirZ = dz;
  p.actSlot = isTeammate(s, slot, req.targetSlot) ? req.targetSlot : -1;
  const ht = req.hasTarget === 1 ? 1 : 0;
  p.actX = ht === 1 ? clampX(fin(req.targetX)) : 0;
  p.actZ = ht === 1 ? clampZ(fin(req.targetZ)) : 0;
  const c = fin(req.curve);
  p.actCurve = c < -1 ? -1 : c > 1 ? 1 : c;
  p.actA = fin(req.flags) & 0xff;
  const a = req.assist;
  p.actB = (a === AssistLevel.SEMI || a === AssistLevel.MANUAL ? a : AssistLevel.ASSISTED) + ht * 4;
  return 1;
}

// ---------------------------------------------------------------- receiver selection

/**
 * Choose the intended receiver for a pass from slot: blends direction (dirX, dirZ; 0,0 = facing), the distance
 * implied by power (0..1), openness and assistance. lofted = 1 for aerial passes. Returns a slot or -1. Pure.
 */
export function selectReceiver(s: SimState, slot: number, dirX: number, dirZ: number, power: number, assist: number, lofted: number): number {
  if (!validSlot(slot) || assist === AssistLevel.MANUAL) return -1;
  const p = s.players[slot]!;
  let ux = fin(dirX), uz = fin(dirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > 1e-6)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  ux /= ul; uz /= ul;
  const pw = clamp01(fin(power));
  const loft = lofted === 1;
  const dPow = loft ? LT.loftedDistMin + (T_PASS.maxRange - LT.loftedDistMin) * pw : LT.groundDistMin + (LT.groundDistMax - LT.groundDistMin) * pw;
  const semi = assist === AssistLevel.SEMI;
  const cosCone = semi ? COS_CONE_SEMI : COS_CONE_ASSISTED;
  const wAlign = semi ? LT.alignWeightSemi : LT.alignWeight;
  const tol = LT.distTol + LT.distTolFrac * dPow;
  const dir = s.teams[p.team]!.dir;
  const first = p.team === 0 ? 0 : PPT;
  const oFirst = p.team === 0 ? PPT : 0;
  const px = p.x, pz = p.z;
  const minD = LT.minReceiverDist;
  const maxD = T_PASS.maxRange;
  let best = -1;
  let bestScore = -1e18;
  for (let i = first; i < first + PPT; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    // Where he will be shortly (along his run), kept on the pitch.
    const d0x = q.x - px, d0z = q.z - pz;
    let lt = Math.sqrt(d0x * d0x + d0z * d0z) / LT.selectRefSpeed;
    if (lt > LT.selectLeadMax) lt = LT.selectLeadMax;
    const qx = clampX(q.x + fin(q.vx) * lt);
    const qz = clampZ(q.z + fin(q.vz) * lt);
    const dx = qx - px, dz = qz - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!(d >= minD) || d > maxD) continue;
    const c = (dx * ux + dz * uz) / d;
    if (!(c >= cosCone)) continue;
    const align = (c - cosCone) / (1 - cosCone);
    const e = (d - dPow) / tol;
    const fit = 1 / (1 + e * e);
    // Openness: opponents near the lane (passer -> receiver) and near the receiver.
    let lane = 0;
    let mark = 0;
    for (let j = oFirst; j < oFirst + PPT; j++) {
      const o = s.players[j]!;
      if (o.active !== 1) continue;
      const ox = o.x - px, oz = o.z - pz;
      const along = (ox * dx + oz * dz) / d;
      if (along > 0 && along < d) {
        let perp = (ox * dz - oz * dx) / d;
        if (perp < 0) perp = -perp;
        const w = LT.laneWidth + LT.laneWidthGrow * along;
        if (perp < w) {
          const r = 1 - perp / w;
          if (r > lane) lane = r;
        }
      }
      const mx = o.x - qx, mz = o.z - qz;
      const md = Math.sqrt(mx * mx + mz * mz);
      if (md < LT.markRadius) {
        const r = 1 - md / LT.markRadius;
        if (r > mark) mark = r;
      }
    }
    if (loft) lane *= LT.loftLaneMul;
    const open = clamp01(1 - LT.laneWeight * lane - LT.markWeight * mark);
    let prog = dir * dx / LT.progressNorm;
    if (prog > 1) prog = 1; else if (prog < -1) prog = -1;
    const score = wAlign * align + LT.distWeight * fit + T_PASS.opennessWeight * open + LT.progressWeight * prog;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- error

/** Weaker foot plays a kick by slot toward unit-ish aim (ax, az)? (Side of the ball, else a sharp turn rule.) */
function weakFootUsed(s: SimState, slot: number, ax: number, az: number): boolean {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  let fx = fin(p.fx), fz = fin(p.fz);
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-6)) return false;
  fx /= fl; fz /= fl;
  const b = s.ball;
  // Right of the facing is (-fz, fx).
  const lat = (b.x - p.x) * (0 - fz) + (b.z - p.z) * fx;
  const prefRight = a.foot !== Foot.LEFT;
  let right: boolean;
  if (lat > LT.footSideBand) right = true;
  else if (lat < -LT.footSideBand) right = false;
  else {
    const al = Math.sqrt(ax * ax + az * az);
    const turn = al > 1e-6 ? (fx * az - fz * ax) / al : 0; // sine of the turn, + = to his right
    right = prefRight ? !(turn > LT.weakTurnSin) : turn < -LT.weakTurnSin;
  }
  return right !== prefRight;
}

/**
 * Angular error (radians, signed, uses s.rng: always four draws for a valid slot) for a kick by slot toward the aim
 * direction (aimX, aimZ), given power 0..1 and baseAccuracy 0..1 (1 = perfect technique for this kick, e.g. a passing
 * attribute / 99). See the header for the factors.
 */
export function kickErrorAim(s: SimState, slot: number, power: number, baseAccuracy: number, aimX: number, aimZ: number): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const inv = 1 - clamp01(fin(baseAccuracy));
  let sigma = T_PASS.errorMax * (LT.minErrorFrac + (1 - LT.minErrorFrac) * inv * inv);
  const ax = fin(aimX), az = fin(aimZ);
  const al = Math.sqrt(ax * ax + az * az);
  const fx = fin(p.fx), fz = fin(p.fz);
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (al > 1e-6 && fl > 1e-6) {
    let c = (fx * ax + fz * az) / (fl * al);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    sigma *= 1 + LT.facingErrorMul * (1 - c) * 0.5;
  }
  sigma *= 1 + LT.pressureErrorMul * pressureOn(s, slot);
  if (p.sprinting === 1) {
    const sp = Math.sqrt(fin(p.vx) * fin(p.vx) + fin(p.vz) * fin(p.vz));
    const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
    const jog = top * JOG_FRAC;
    if (top > jog) sigma *= 1 + LT.sprintErrorMul * clamp01((sp - jog) / (top - jog));
  }
  if (weakFootUsed(s, slot, ax, az)) {
    let wf = fin(a.weakFoot);
    if (wf < 1) wf = 1; else if (wf > 5) wf = 5;
    sigma *= 1 + (T_PASS.weakFootErrorMul - 1) * (5 - wf) / 4;
  }
  const pw = clamp01(fin(power));
  if (pw > LT.powerKnee) sigma *= 1 + LT.powerErrorMul * (pw - LT.powerKnee) / (1 - LT.powerKnee);
  const floor = T_PLAYER.staminaFloorMul;
  if (floor < 1) sigma *= 1 + LT.staminaErrorMul * clamp01((1 - staminaFactor(p)) / (1 - floor));
  const cap = T_PASS.errorMax * LT.errorCapMul;
  if (sigma > cap) sigma = cap;
  return sigma * rngGauss(s.rng);
}

/**
 * Angular error (radians, signed, uses s.rng) for a kick by slot given difficulty factors. The aim is the action's
 * request direction (p.actDirX/Z; facing when unset). Solvers that know their final direction use kickErrorAim.
 */
export function kickError(s: SimState, slot: number, power: number, baseAccuracy: number): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  let ax = fin(p.actDirX), az = fin(p.actDirZ);
  if (!(ax * ax + az * az > 1e-12)) { ax = fin(p.fx); az = fin(p.fz); }
  return kickErrorAim(s, slot, power, baseAccuracy, ax, az);
}

/** Passing accuracy 0..1 of slot over `dist` m (shortPassing -> longPassing with range). */
export function passAccuracy(s: SimState, slot: number, dist: number): number {
  const a = s.attrs[slot]!;
  const w = clamp01((dist - LT.shortRange) / (LT.longRange - LT.shortRange));
  return attr01(a.shortPassing + (a.longPassing - a.shortPassing) * w);
}

// ---------------------------------------------------------------- speed models

/** Power-only launch speed of a pass kind (m/s): ground / kick-off, driven (x drivenMul), dinked. */
function powerSpeed(kind: KickKind, power: number): number {
  if (kind === KickKind.DINKED_PASS) return LT.dinkPowerSpeedMin + (LT.dinkPowerSpeedMax - LT.dinkPowerSpeedMin) * power;
  const v = T_PASS.groundMin + (T_PASS.groundMax - T_PASS.groundMin) * power;
  return kind === KickKind.DRIVEN_PASS ? v * T_PASS.drivenMul : v;
}

/**
 * Ground / driven / kick-off launch speed to cover F[F_D] metres (assist: Assisted = arrival-speed solve, Semi =
 * blended with the power-only speed, Manual = power only), clamped to the kind's range. Writes the travel time (s,
 * LT.leadMaxSec if it never gets there) into F[F_T]. Returns the speed.
 */
function groundSpeed(kind: KickKind, power: number, assist: number): number {
  const D = F[F_D]!;
  const pv = T_PASS.groundMin + (T_PASS.groundMax - T_PASS.groundMin) * power;
  let v: number;
  if (assist === AssistLevel.MANUAL) v = pv;
  else {
    let arrive = LT.arriveMin + (LT.arriveMax - LT.arriveMin) * power;
    if (arrive < F[F_AMIN]!) arrive = F[F_AMIN]!;
    v = groundPassSpeed(D, arrive);
    if (assist === AssistLevel.SEMI) v += (pv - v) * LT.semiPowerBlend;
  }
  if (v < T_PASS.groundMin) v = T_PASS.groundMin;
  if (v > T_PASS.groundMax) v = T_PASS.groundMax;
  if (kind === KickKind.DRIVEN_PASS) v *= T_PASS.drivenMul;
  let t = groundRollTime(v, D);
  if (!(t >= 0) || t > LT.leadMaxSec) t = LT.leadMaxSec;
  F[F_T] = t;
  return v;
}

/**
 * One dinked trial at launch speed v from height y0: 1 if the ball first reaches F[F_D] metres along the aim with at
 * least `arrive` m/s of horizontal speed; F[F_TRIAL_T] = the time it gets there (s; -1 if it does not), F[F_TRIAL_V]
 * its speed there, F[F_TRIAL_M] the time from there to the nearest bounce (s). Open-field model of the sim's own
 * physics for a spinless ball launched at the angle F_CA / F_SA: every flight integrates SIM-01 ballAirStep (gravity +
 * drag, as SIM-02 does in the air) in 3-tick steps; each ground impact applies SIM-02's rule (restitution,
 * bounceFriction scaled by grip below fullGripImpactSpeed, rolling below rollThresholdVy) at the end of the SIM-02
 * substep in which the ball went below the ground ([QF-10]: the hops stay in step with the sim's); the roll uses the
 * SIM-02 roll model in closed form (SIM-01 groundRollTime). A spinless ball never speeds up horizontally, so a trial
 * fails as soon as it is slower than `arrive`. Tests check the model against ballStepTick.
 */
function dinkTrial(y0: number, v: number, arrive: number): number {
  dinkTrials++;
  const d = DINK;
  const D = F[F_D]!;
  const G = T_BALL.gravity;
  d.x = 0; d.y = y0 < BALL_RADIUS ? BALL_RADIUS : y0; d.z = 0;
  d.vx = v * F[F_CA]!; d.vy = v * F[F_SA]!; d.vz = 0;
  d.sx = 0; d.sy = 0; d.sz = 0;
  F[F_TRIAL_T] = -1;
  F[F_TRIAL_M] = 0;
  F[F_TRIAL_V] = 0;
  let t = 0;
  /** Time of the last ground impact (s; -1e9 none yet). */
  let tb = -1e9;
  // 1. Flights (3-tick steps of the sim's air physics, SIM-01 ballAirStep: gravity + quadratic drag on the whole
  //    velocity) and ground impacts (SIM-02's rule: friction scaled by grip, restitution, rolling below the threshold).
  let steps = 0;
  let rolling = false;
  while (steps < DINK_FLIGHT_STEPS) {
    steps++;
    const px = d.x, py = d.y, pvx = d.vx, pvy = d.vy;
    ballAirStep(d, DINK_DT);
    // Landing inside this step: interpolate to the ground contact (y = BALL_RADIUS).
    let f = 1;
    const down = d.y <= BALL_RADIUS && d.vy < 0;
    if (down && py > d.y) f = (py - BALL_RADIUS) / (py - d.y);
    if (f < 0) f = 0;
    const lx = px + (d.x - px) * f;
    if (lx >= D) {
      const g = lx > px ? (D - px) / (lx - px) * f : f;
      const ta = t + DINK_DT * g;
      F[F_TRIAL_T] = ta;
      // Margin: time from the target to the nearest ground impact (the last one, or the landing of this flight, from
      // the height and vertical speed there).
      const ya = py + (d.y - py) * g, vya = pvy + (d.vy - pvy) * g;
      const h = ya - BALL_RADIUS;
      const tl = (vya + Math.sqrt(vya * vya + 2 * G * (h > 0 ? h : 0))) / G;
      F[F_TRIAL_M] = tl < ta - tb ? tl : ta - tb;
      const va = pvx + (d.vx - pvx) * g;
      F[F_TRIAL_V] = va;
      return va >= arrive ? 1 : 0;
    }
    if (!down) {
      t += DINK_DT;
      if (d.vx < arrive) return 0; // a spinless ball never speeds up horizontally
      continue;
    }
    // Ground impact. SIM-02 applies it at the end of the substep in which the ball went below the ground (the tick's
    // substeps: SIM-02 ballSubsteps from the speed), with the vertical speed of that moment: emulated here, so the hops
    // stay in step with the sim's (the plain landing point drifts ~0.3 m behind it by the fourth bounce).
    const tl = t + DINK_DT * f;
    const vh = pvx + (d.vx - pvx) * f;
    const vl = -(pvy + (d.vy - pvy) * f);
    const tk = Math.floor(tl * HZ + 1e-9) / HZ;
    let nsub = Math.ceil(Math.sqrt(vh * vh + vl * vl) / (HZ * T_BALL.maxStep));
    if (nsub < 1) nsub = 1; else if (nsub > MAX_SUBSTEPS) nsub = MAX_SUBSTEPS;
    const hs = 1 / (HZ * nsub);
    let te = tk + Math.ceil((tl - tk) / hs - 1e-9) * hs;
    if (te < tl) te = tl;
    t = te;
    tb = t;
    const vi = vl + G * (te - tl);
    const grip = vi >= FULL_GRIP ? 1 : vi / FULL_GRIP;
    d.x = lx + vh * (te - tl); d.y = BALL_RADIUS;
    d.vx = vh * (1 - T_BALL.bounceFriction * grip);
    if (d.vx < arrive) return 0;
    const vy = vi * T_BALL.restitution;
    if (vy < T_BALL.rollThresholdVy) { rolling = true; break; }
    d.vy = vy;
  }
  if (!rolling) return 0;
  // 2. Roll (SIM-02 roll model in closed form).
  const rem = D - d.x;
  if (!(rem > 0)) { F[F_TRIAL_T] = t; F[F_TRIAL_V] = d.vx; return 1; }
  const tr = groundRollTime(d.vx, rem);
  if (!(tr >= 0)) return 0;
  F[F_TRIAL_T] = t + tr;
  F[F_TRIAL_M] = tr; // the last (small) bounce was tr before the target
  const va = rollSpeedAfter(d.vx, tr);
  F[F_TRIAL_V] = va;
  return va >= arrive ? 1 : 0;
}

/** Speed of a ground ball t seconds after rolling off at v0 (SIM-02 roll model), m/s. */
function rollSpeedAfter(v0: number, t: number): number {
  if (!(ROLL_C > 0)) { const v = v0 - ROLL_A * t; return v > 0 ? v : 0; }
  const k = ROLL_A / ROLL_C;
  const v = (v0 + k) * dexp(-ROLL_C * t) - k;
  return v > 0 ? v : 0;
}

/**
 * Dinked launch speed (m/s) at the angle in F_CA / F_SA so the ball first reaches F[F_D] m along the aim with `arrive`
 * m/s (bisection over dinkTrial, LT.dinkIters, inside a bracket around the ground-pass speed for the same distance,
 * dinkBracketLo..Hi x it, widened to dinkSpeedMin..Max when it does not hold). F[F_T] = its arrival time (s;
 * LT.leadMaxSec when out of reach), F[F_OK_M] = its bounce margin (s).
 */
function solveDinkAt(y0: number, arrive: number): number {
  const vg = groundPassSpeed(F[F_D]!, arrive);
  let lo: number = vg * LT.dinkBracketLo;
  let hi: number = vg * LT.dinkBracketHi;
  if (lo < LT.dinkSpeedMin) lo = LT.dinkSpeedMin;
  if (hi > LT.dinkSpeedMax) hi = LT.dinkSpeedMax;
  if (!(hi > lo)) { lo = LT.dinkSpeedMin; hi = LT.dinkSpeedMax; }
  F[F_OK_M] = 0;
  F[F_OK_V] = 1e9;
  if (dinkTrial(y0, hi, arrive) === 0) {
    lo = hi;
    hi = LT.dinkSpeedMax;
    if (lo >= hi || dinkTrial(y0, hi, arrive) === 0) {
      const t = F[F_TRIAL_T]!;
      F[F_T] = t >= 0 && t < LT.leadMaxSec ? t : LT.leadMaxSec;
      return hi;
    }
  }
  F[F_OK_T] = F[F_TRIAL_T]!;
  F[F_OK_M] = F[F_TRIAL_M]!; F[F_OK_V] = F[F_TRIAL_V]!;
  if (dinkTrial(y0, lo, arrive) === 1) {
    if (lo <= LT.dinkSpeedMin) { F[F_T] = F[F_TRIAL_T]!; F[F_OK_M] = F[F_TRIAL_M]!; F[F_OK_V] = F[F_TRIAL_V]!; return lo; }
    hi = lo;
    F[F_OK_T] = F[F_TRIAL_T]!;
    F[F_OK_M] = F[F_TRIAL_M]!; F[F_OK_V] = F[F_TRIAL_V]!;
    lo = LT.dinkSpeedMin;
  }
  for (let it = 0; it < LT.dinkIters; it++) {
    const mid = 0.5 * (lo + hi);
    if (dinkTrial(y0, mid, arrive) === 1) { hi = mid; F[F_OK_T] = F[F_TRIAL_T]!; F[F_OK_M] = F[F_TRIAL_M]!; F[F_OK_V] = F[F_TRIAL_V]!; } else lo = mid;
  }
  let t = F[F_OK_T]!;
  if (!(t >= 0) || t > LT.leadMaxSec) t = LT.leadMaxSec;
  F[F_T] = t;
  return hi;
}

/**
 * [QF-10] Dinked launch: speed and angle (F_DCA / F_DSA) so the ball first reaches the target with `arrive` m/s.
 * The arrival speed jumps at every bounce (by T_BALL.bounceFriction), so a speed found right where a bounce meets the
 * target arrives too fast or too slow in the sim's ticks: the angles T_PASS.dinkedAngle + DINK_ANGLE_OFF[k] are tried
 * in order and the first whose solution reaches the target at least LT.dinkBounceMargin away from a bounce is used
 * (else the one with the largest margin). F[F_T] = its arrival time.
 */
function solveDink(y0: number, arrive: number, full: number): number {
  let bestV = 0, bestE = 1e18, bestT = 0, bestC = DINK_COS, bestS = DINK_SIN;
  dinkTrials = 0;
  const nA = full === 1 ? DINK_ANGLES : 1;
  for (let k = 0; k < nA && dinkTrials < LT.dinkMaxTrials; k++) {
    F[F_CA] = DINK_ANGLE_COS[k]!;
    F[F_SA] = DINK_ANGLE_SIN[k]!;
    const v = solveDinkAt(y0, arrive);
    const t0 = F[F_T]!;
    let e = F[F_OK_V]! - arrive;
    if (e < 0) e = -e;
    if (F[F_OK_M]! >= LT.dinkBounceMargin) {
      if (e < bestE) { bestE = e; bestV = v; bestT = t0; bestC = F[F_CA]!; bestS = F[F_SA]!; }
    } else {
      // A bounce at the target: nudge the speed down / up until the ball reaches the target dinkBounceMargin clear of
      // it (just after the bounce, a little slower than planned, or just before it, a little faster).
      for (let sg = -1; sg <= 1 && full === 1; sg += 2) {
        for (let j = 1; j <= LT.dinkNudgeSteps; j++) {
          let vn = v * (1 + sg * j * LT.dinkNudge);
          if (vn < LT.dinkSpeedMin) vn = LT.dinkSpeedMin; else if (vn > LT.dinkSpeedMax) vn = LT.dinkSpeedMax;
          dinkTrial(y0, vn, arrive);
          if (!(F[F_TRIAL_M]! >= LT.dinkBounceMargin) || !(F[F_TRIAL_T]! >= 0)) continue;
          let en = F[F_TRIAL_V]! - arrive;
          if (en < 0) en = -en;
          if (en < bestE) {
            bestE = en; bestV = vn; bestC = F[F_CA]!; bestS = F[F_SA]!;
            bestT = F[F_TRIAL_T]! < LT.leadMaxSec ? F[F_TRIAL_T]! : LT.leadMaxSec;
          }
          break;
        }
      }
      if (bestE >= 1e17) { bestE = 1e17; bestV = v; bestT = t0; bestC = F[F_CA]!; bestS = F[F_SA]!; } // nothing clear
    }
    if (bestE <= LT.dinkArriveTol) break;
  }
  F[F_T] = bestT;
  F[F_DCA] = bestC;
  F[F_DSA] = bestS;
  return bestV;
}

/** Unit aim (F_UX, F_UZ) and distance F_D from the ball to the target (F_TX, F_TZ); false if on top of it. */
function aimAtTarget(b: Readonly<BallState>): boolean {
  const dx = F[F_TX]! - b.x, dz = F[F_TZ]! - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  F[F_D] = d;
  if (!(d > AIM_MIN_DIST)) return false;
  F[F_UX] = dx / d;
  F[F_UZ] = dz / d;
  return true;
}

/** Launch speed for the current target (F_D, F_UX/UZ) of kind; F[F_T] = travel time. */
function speedForTarget(s: SimState, kind: KickKind, power: number, assist: number, full = 1): number {
  if (kind !== KickKind.DINKED_PASS) return groundSpeed(kind, power, assist);
  const pv = powerSpeed(kind, power);
  if (assist === AssistLevel.MANUAL) {
    F[F_T] = LT.leadMaxSec;
    F[F_DCA] = DINK_COS;
    F[F_DSA] = DINK_SIN;
    return pv;
  }
  let arrive = LT.dinkArriveMin + (LT.dinkArriveMax - LT.dinkArriveMin) * power;
  if (arrive < F[F_AMIN]!) arrive = F[F_AMIN]!;
  let v = solveDink(s.ball.y, arrive, full);
  if (assist === AssistLevel.SEMI) v += (pv - v) * LT.semiPowerBlend;
  return v;
}

/**
 * Lead evaluation at look-ahead T (s): target = the receiver's position after T (F_QX/QZ + F_QVX/QVZ x T, on the
 * pitch), aim and distance from the ball, the arrival-speed floor, and the ground model's travel time for kind
 * (F[F_T]). Returns that travel time x F[F_RATIO] (0 when the target is on the ball).
 */
function leadEval(s: SimState, T: number, kind: KickKind, power: number, assist: number): number {
  let vx = F[F_QVX]!, vz = F[F_QVZ]!;
  // [QF-2] His run stops leadLineMargin inside the lines (see LT.leadLineMargin): the lead time is capped where it gets
  // there, and a receiver who has pulled up is not running away from the ball.
  let te = T;
  const qx = F[F_QX]!, qz = F[F_QZ]!;
  const mx = HALF_LENGTH - LT.leadLineMargin, mz = HALF_WIDTH - LT.leadLineMargin;
  if (vx > 1e-6 && qx + vx * te > mx) te = qx < mx ? (mx - qx) / vx : 0;
  else if (vx < -1e-6 && qx + vx * te < -mx) te = qx > -mx ? (-mx - qx) / vx : 0;
  if (vz > 1e-6 && qz + vz * te > mz) te = qz < mz ? (mz - qz) / vz : 0;
  else if (vz < -1e-6 && qz + vz * te < -mz) te = qz > -mz ? (-mz - qz) / vz : 0;
  if (te < T) { vx = 0; vz = 0; }
  F[F_TX] = clampX(qx + F[F_QVX]! * te);
  F[F_TZ] = clampZ(qz + F[F_QVZ]! * te);
  F[F_AMIN] = 0;
  if (!aimAtTarget(s.ball)) { F[F_T] = 0; return 0; }
  const away = vx * F[F_UX]! + vz * F[F_UZ]!;
  F[F_AMIN] = away > 0 ? away + LT.leadArriveMargin : 0;
  groundSpeed(kind, power, assist);
  return F[F_T]! * F[F_RATIO]!;
}

/**
 * Look-ahead T (s, 0..LT.leadMaxSec) with T = travel time to the receiver's position after T: secant iterations
 * (LT.leadIters) on g(T) = leadEval(T) - T. Leaves F (target, aim, distance, arrival floor, travel time) as evaluated
 * at the returned T.
 */
function leadSolve(s: SimState, kind: KickKind, power: number, assist: number): number {
  let t0 = 0;
  let g0 = leadEval(s, t0, kind, power, assist);
  if (!(g0 > LEAD_TOL)) return t0;
  let t1 = g0 < LT.leadMaxSec ? g0 : LT.leadMaxSec;
  let g1 = leadEval(s, t1, kind, power, assist) - t1;
  for (let it = 0; it < LT.leadIters; it++) {
    if (g1 < LEAD_TOL && g1 > -LEAD_TOL) break;
    const dg = g1 - g0;
    let t2 = dg !== 0 ? t1 - g1 * (t1 - t0) / dg : t1 + g1;
    if (!(t2 > 0)) t2 = 0;
    if (t2 > LT.leadMaxSec) t2 = LT.leadMaxSec;
    if (t2 === t1) break;
    t0 = t1; g0 = g1;
    t1 = t2;
    g1 = leadEval(s, t1, kind, power, assist) - t1;
  }
  return t1;
}

/**
 * Teammate of slot nearest the ball along the unit line (ux, uz) from the ball, within LT.laneReceiverWidth of it and
 * at most maxAlong ahead (min 1 m). Writes his meeting point on the line to F_LX / F_LZ. -1 if none.
 */
function laneReceiver(s: SimState, slot: number, ux: number, uz: number, maxAlong: number): number {
  const b = s.ball;
  const p = s.players[slot]!;
  const first = p.team === 0 ? 0 : PPT;
  let best = -1;
  let bestAlong = 1e18;
  for (let i = first; i < first + PPT; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - b.x, dz = q.z - b.z;
    const along = dx * ux + dz * uz;
    if (!(along >= 1) || along > maxAlong) continue;
    let perp = dx * uz - dz * ux;
    if (perp < 0) perp = -perp;
    if (perp > LT.laneReceiverWidth) continue;
    if (along < bestAlong) { bestAlong = along; best = i; }
  }
  if (best >= 0) {
    F[F_LX] = clampX(b.x + ux * bestAlong);
    F[F_LZ] = clampZ(b.z + uz * bestAlong);
  }
  return best;
}

// ---------------------------------------------------------------- solver

function solvePass(s: SimState, slot: number, out: KickLaunch): number {
  out.vx = 0; out.vy = 0; out.vz = 0; out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = KickKind.GROUND_PASS; out.target = -1; out.tx = 0; out.tz = 0; out.onTarget = 0;
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  F[F_AMIN] = 0;
  F[F_DCA] = DINK_COS; // dinked launch angle (solveDink may pick another, see there)
  F[F_DSA] = DINK_SIN;
  const kind = isPassKind(p.actKick) ? p.actKick : KickKind.GROUND_PASS;
  const meta = fin(p.actB) | 0;
  let assist = meta & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  const hasTarget = (meta >> 2) & 1;
  let power = clamp01(fin(p.actPower));
  if (power < LT.minPower) power = LT.minPower;
  const dinked = kind === KickKind.DINKED_PASS;
  // Request direction (facing, then the attack direction, when unset).
  let ux = fin(p.actDirX), uz = fin(p.actDirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > 1e-6)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  ux /= ul; uz /= ul;
  // Receiver.
  let r = -1;
  if (isTeammate(s, slot, p.actSlot)) r = p.actSlot;
  else if (hasTarget === 0 && assist !== AssistLevel.MANUAL) r = selectReceiver(s, slot, ux, uz, power, assist, dinked ? 1 : 0);
  let v: number;
  let aimed = false;
  if (assist !== AssistLevel.MANUAL && (r >= 0 || hasTarget === 1)) {
    if (r >= 0) {
      // Lead the receiver: his position when the ball gets there (secant on the travel-time fixed point).
      const q = s.players[r]!;
      F[F_QX] = q.x; F[F_QZ] = q.z; F[F_QVX] = fin(q.vx); F[F_QVZ] = fin(q.vz);
      F[F_RATIO] = 1;
      const modelKind = dinked ? KickKind.GROUND_PASS : kind;
      leadSolve(s, modelKind, power, assist);
      aimed = F[F_D]! > AIM_MIN_DIST;
      if (aimed && dinked && F[F_QVX]! * F[F_QVX]! + F[F_QVZ]! * F[F_QVZ]! > LT.dinkReleadSpeed * LT.dinkReleadSpeed) {
        // A moving receiver: re-lead with the dinked flight's own travel time (as a ratio to the ground model's).
        const tg = F[F_T]!;
        speedForTarget(s, kind, power, assist, 0); // travel time only: one angle, no nudges
        if (tg > 0) F[F_RATIO] = F[F_T]! / tg;
        leadSolve(s, modelKind, power, assist);
        aimed = F[F_D]! > AIM_MIN_DIST;
      }
    } else {
      F[F_TX] = clampX(p.actX);
      F[F_TZ] = clampZ(p.actZ);
      aimed = aimAtTarget(b);
    }
  }
  if (aimed) {
    v = speedForTarget(s, kind, power, assist);
    if (r < 0) r = laneReceiver(s, slot, F[F_UX]!, F[F_UZ]!, F[F_D]! + LT.laneReceiverWidth);
  } else {
    // Along the request direction: Assisted / Semi over the power-implied distance, Manual at the power-only speed.
    F[F_UX] = ux;
    F[F_UZ] = uz;
    if (assist === AssistLevel.MANUAL) {
      v = powerSpeed(kind, power);
      F[F_D] = rollStopDist(dinked ? v * DINK_COS : v);
    } else {
      F[F_D] = dinked ? LT.loftedDistMin + (T_PASS.maxRange - LT.loftedDistMin) * power
        : LT.groundDistMin + (LT.groundDistMax - LT.groundDistMin) * power;
      v = speedForTarget(s, kind, power, assist);
    }
    F[F_TX] = clampX(b.x + ux * F[F_D]!);
    F[F_TZ] = clampZ(b.z + uz * F[F_D]!);
    if (r >= 0) {
      // Explicit receiver with Manual aim: his meeting point on the line.
      const q = s.players[r]!;
      let along = (q.x - b.x) * ux + (q.z - b.z) * uz;
      if (along < 0) along = 0;
      F[F_TX] = clampX(b.x + ux * along);
      F[F_TZ] = clampZ(b.z + uz * along);
    } else {
      // How far the ball runs (a dinked ball: its roll after landing, from the power-implied / stop distance).
      const run = rollStopDist(dinked ? v * F[F_DCA]! : v);
      r = laneReceiver(s, slot, ux, uz, run > F[F_D]! ? run : F[F_D]!);
      if (r >= 0) { F[F_TX] = F[F_LX]!; F[F_TZ] = F[F_LZ]!; }
    }
  }
  if (!(v > 0)) v = T_PASS.groundMin;
  const vmax = T_BALL.maxSpeed;
  if (v > vmax) v = vmax;
  // Error: rotate the aim.
  const ax0 = F[F_UX]!, az0 = F[F_UZ]!;
  const err = kickErrorAim(s, slot, power, passAccuracy(s, slot, F[F_D]!), ax0, az0);
  const ce = dcos(err), se = dsin(err);
  const ax = ax0 * ce - az0 * se;
  const az = ax0 * se + az0 * ce;
  if (dinked) {
    const vh = v * F[F_DCA]!;
    out.vx = ax * vh; out.vy = v * F[F_DSA]!; out.vz = az * vh;
  } else {
    out.vx = ax * v; out.vz = az * v;
  }
  out.kind = kind;
  out.target = r;
  out.tx = F[F_TX]!;
  out.tz = F[F_TZ]!;
  return 1;
}

// ---------------------------------------------------------------- KICK action handler

/**
 * Contact done (kicked or whiffed) at the current tick: actContact = now, the planned recovery follows. While the
 * contact waits past its tick (waitContact) actDur - actT keeps the planned recovery, before it actDur - actContact.
 */
function finishContact(p: PlayerState): void {
  let rec = p.actDur - (p.actT > p.actContact ? p.actT : p.actContact);
  if (!(rec >= 1)) rec = DEFAULT_REC;
  p.actDone = 1;
  p.actCharging = 0;
  p.actContact = p.actT;
  p.actDur = p.actT + rec;
}

/**
 * Movement while kicking: slowed during the wind-up / charge (stick capped, no sprint), LOCKED for LOCK_T ticks from
 * the contact, then STOP for one tick (the resolver / AI write the intent again) and a cap ramping back to 1.
 */
function kickMove(s: SimState, p: PlayerState): void {
  let cap: number = MOVE_CAP;
  if (p.actDone === 1 && p.actContact >= 0) {
    const since = p.actT - p.actContact;
    if (since < LOCK_T) {
      p.moveMode = MoveMode.LOCKED;
      p.wantSprint = 0;
      return;
    }
    if (p.moveMode === MoveMode.LOCKED) {
      p.moveMode = MoveMode.STOP;
      p.wantSprint = 0;
      return;
    }
    const span = p.actDur - p.actContact - LOCK_T;
    const f = span > 0 ? (since - LOCK_T) / span : 1;
    cap = MOVE_CAP + (1 - MOVE_CAP) * (f < 0 ? 0 : f > 1 ? 1 : f);
  }
  p.wantSprint = 0;
  const mode = p.moveMode;
  if (mode === MoveMode.DIRECT) {
    const ix = p.ix, iz = p.iz;
    const m2 = ix * ix + iz * iz;
    if (m2 > cap * cap) {
      const k = cap / Math.sqrt(m2);
      p.ix = ix * k;
      p.iz = iz * k;
    }
  } else if (mode === MoveMode.ARRIVE) {
    const top = s.attrs[p.slot]!.topSpeed;
    const lim = cap * (top > 0 ? top : T_PLAYER.topSpeedMin) * JOG_FRAC;
    if (p.tgtSpeed > lim) p.tgtSpeed = lim;
  }
}

/** Play the ball: solver -> sanitised launch -> applyKick. Whiff when the solver cannot make the kick. */
function contact(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const k = p.actKick;
  const solver = k >= 0 && k < KICK_SOLVERS.length ? KICK_SOLVERS[k] : null;
  const l = LAUNCH;
  l.vx = 0; l.vy = 0; l.vz = 0; l.sx = 0; l.sy = 0; l.sz = 0; l.kind = k; l.target = -1; l.tx = 0; l.tz = 0; l.onTarget = 0;
  if (!solver || solver(s, slot, l) !== 1) { finishContact(p); return; }
  const vx = fin(l.vx), vy = fin(l.vy), vz = fin(l.vz);
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(sp > 0)) { finishContact(p); return; }
  const m = T_BALL.maxSpeed;
  const ks = sp > m ? m / sp : 1;
  l.vx = vx * ks; l.vy = vy * ks; l.vz = vz * ks;
  l.sx = fin(l.sx); l.sy = fin(l.sy); l.sz = fin(l.sz);
  l.tx = fin(l.tx); l.tz = fin(l.tz);
  if (!validSlot(l.target)) l.target = -1;
  if (!(l.kind > KickKind.NONE && l.kind <= KickKind.GK_RELEASE)) l.kind = k;
  applyKick(s, slot, l, clamp01(fin(p.actPower)), ev);
  if (isPassKind(k) && k !== KickKind.KICK_OFF && (p.actA & ReqFlag.PASS_AND_GO) !== 0) {
    const t = s.teams[p.team]!;
    t.passGoSlot = slot;
    t.passGoT = LT.passGoTicks;
  }
  finishContact(p);
}

function kickUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (p.actDone !== 0 || p.actContact < 0) { kickMove(s, p); return; }
  const b = s.ball;
  // Dispossessed (someone else owns or holds the ball): no kick to make.
  if ((b.owner >= 0 && b.owner !== slot) || (b.heldBy >= 0 && b.heldBy !== slot)) {
    finishContact(p);
    kickMove(s, p);
    return;
  }
  // [QF-10] A restart taker kicking the dead ball lines up behind it along his kick first (kickCommon.ts).
  const taker = isDeadBallTaker(s, slot);
  if (p.actCharging === 1) {
    noteCharging(s, slot);
    if (taker) lineUpOnDeadBall(s, slot);
    if (p.actT < p.actContact || p.actT - p.actContact < CHARGE_WAIT) { kickMove(s, p); return; }
    p.actCharging = 0; // backstop: the power bar never stays stuck
  }
  // [QF-10] A released power bar strikes T_PASS.releaseStrikeTicks later (kickCommon.ts).
  releaseStrike(s, slot);
  if (p.actT < p.actContact) {
    if (taker) lineUpOnDeadBall(s, slot);
    kickMove(s, p);
    return;
  }
  const waited = p.actT - p.actContact;
  if (!liveFor(s, slot) || (ballTouchedThisTick(s) && b.lastTouch !== slot)) {
    finishContact(p);
    kickMove(s, p);
    return;
  }
  // [QF-10] The dead ball not at his kicking spot yet: keep lining up (the contact moves on a tick at a time).
  if (taker && p.actT < T_KICK.takerLineUpMaxTicks && lineUpOnDeadBall(s, slot) === 0) {
    p.actContact = p.actT + 1;
    p.actDur += 1;
    kickMove(s, p);
    return;
  }
  if (!footCanStrike(s, slot, LT.reachRadius, REACH_H)) {
    // Grace: his own ball until SIM-06 has it back on the kicking spot (a sprint touch ahead, a ball dropping from a
    // chest trap or behind him) for up to LT.ownReachWaitTicks, or a loose ball still arriving (first time) for up to
    // LT.contactGraceTicks. The planned recovery is kept after the late contact (actDur moves on with the wait).
    if (!taker) {
      if (b.owner === slot ? waited < LT.ownReachWaitTicks
        : waited < LT.contactGraceTicks && ballArriving(s, slot, LT.contactGraceTicks - waited, LT.reachRadius)) {
        p.actDur += 1;
        kickMove(s, p);
        return;
      }
    }
    // A taker who could not line up in time still takes the restart when the ball is near him; anyone else whiffs.
    if (!taker || !ballInReach(s, slot)) {
      finishContact(p); // whiff
      kickMove(s, p);
      return;
    }
  }
  contact(s, slot, ev);
  kickMove(s, p);
}

function kickEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

bindPassImpl({ update: kickUpdate, end: kickEnd, solveGroundPass: solvePass });

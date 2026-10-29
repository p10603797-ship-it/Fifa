/**
 * [SIM-11] Shooting: power, aim assist, error model, all shot types (normal, finesse, chip, power shot, low
 * driven, first-time; free-kick shots and penalties). Hold time sets power; the stick aims relative to the goal;
 * assisted aim biases toward the inside of the posts and away from the keeper. Error from finishing and
 * long-shot attributes, power above 80%, balance (angle between run and shot), pressure, weaker foot and ball
 * height at contact. A fake shot (SIM-13) cancels the wind-up into a touch. Owns the SHOT action handler.
 *
 * STARTING (startShot). Kinds: SHOT_NORMAL, SHOT_FINESSE, SHOT_CHIP, SHOT_POWER, SHOT_LOW_DRIVEN (also SHOT_NORMAL with
 * ReqFlag.LOW), FREE_KICK_SHOT, PENALTY. A shot starts when the player is free (isFree), the phase is live for him
 * (IN_PLAY; a restart phase as its taker or once taken; the shoot-out kicker), nobody holds the ball in his hands or
 * owns it but him, and the ball is his, in his reach (LT.reachRadius, at most LT.reachHeight high) or a low loose ball
 * arriving on a path within LT.startArriveLane of him within the wind-up + LT.startArriveTicks (first-time ground shots;
 * volleys and headers are SIM-12). Action fields: actKick = kind; actPower / actCharging from the request; actDirX/Z =
 * unit request (stick) direction (0, 0 = none); actX/actZ = explicit target point when actB bit 2 is set (set pieces,
 * gestures); actCurve = request curl -1..1 (+ = bends to the right of the travel direction, InputFrame.curve
 * convention); actA = ReqFlag bits; actB = AssistLevel (bits 0..1) | hasTarget << 2; actSlot = -1. Contact tick =
 * T_SHOT.windup (T_SHOT.powerShotWindup for SHOT_POWER), duration = wind-up + T_SHOT.contact + T_SHOT.recovery.
 *
 * SHOT ACTION (shotHandler; same timing model as SIM-08's KICK handler):
 *  - wind-up (actT < actContact) and charging (actT >= actContact while actCharging; SIM-15 raises actPower from the
 *    hold): movement slowed (DIRECT stick capped at LT.windupMoveScale, ARRIVE speed at that x jog, no sprint); SIM-06
 *    holds the owned ball on the kicking spot. A charge waits at most T_PASS.powerFillTicks + LT.chargeWaitExtraTicks
 *    past the planned contact, then is released here (no stuck power bar).
 *  - low driven (markLowDriven, called by the SIM-15 resolver for a second SHOOT press during the power-up): actKick
 *    becomes SHOT_LOW_DRIVEN with the power held so far (a power shot's longer wind-up shrinks to T_SHOT.windup).
 *  - dispossessed before contact (someone else owns / holds the ball): whiff at once, recover.
 *  - [QF-10] released charge: the first tick after the power bar is released the contact moves to
 *    T_PASS.releaseStrikeTicks after it (kickCommon.ts releaseStrike; not for a first-time shot of a ball arriving).
 *  - contact (first tick with actT >= actContact, not charging): the phase must be live for him, the ball untouched by
 *    anyone else this tick and in reach of his foot ([QF-10] kickCommon.ts footCanStrike: LT.reachRadius, LT.reachHeight
 *    and the kicking spot, also for his own ball). A loose ball still arriving (first-time shot: on a path within
 *    LT.startArriveLane, the same window startShot accepted) may delay the contact up to LT.contactGraceTicks, his own
 *    ball out of reach up to LT.ownReachWaitTicks (the planned recovery follows the late contact); a restart taker's
 *    dead ball not at his kicking spot: he side-steps round it first (kickCommon.ts lineUpOnDeadBall). Then
 *    solveShot fills the launch and core/kick.ts applyKick plays it (KICK + SHOT events, ball.shotBy / shotOnTarget,
 *    restart.taken). Anything else is a whiff. actContact moves to the actual contact tick and the planned recovery
 *    follows it (actDone = 1). Recovery: MoveMode.LOCKED for LT.contactLockTicks (follow-through), STOP for a tick, then
 *    the stick cap ramps back to 1.
 *  - interrupted (SIM-13 startFake turns the wind-up into a FAKE, tackles, phase changes): end() only releases a
 *    LOCKED movement; the ball and the power bar are left to their owners (no kick happens).
 *
 * AIM (shotAimPoint / at contact). The aimed goal: an explicit target within LT.goalTargetDepth of a goal line ->
 * that goal; in the shoot-out the goal at the ball's end; else the team's attacked goal (team.dir). Assist strength A:
 * Assisted 1, Semi LT.semiAssist, Manual 0, x LT.powerShotAssistMul for a power shot (least assistance).
 *  - Manual aim zM: the explicit target's z, else the stick ray (facing when the stick is idle) from the ball onto the
 *    goal line (|z| <= LT.rayMaxZ; a ray that never reaches the line aims LT.rayMaxZ wide on its side).
 *  - Assisted aim zA: the explicit target, else the stick ray when it meets the line within LT.captureMargin of the
 *    mouth (beyond: the post on that side), else (idle stick) the side with more room beside the keeper (far post
 *    without a keeper); then (not for explicit targets) moved out of the keeper's cover (his position projected from
 *    the ball onto the goal line +- LT.keeperCover x the projection ratio) by at most LT.keeperShiftMax; clamped to
 *    T_SHOT.assistInset inside the posts.
 *  - z = zM + (zA - zM) x A. Height by kind and power: LT.<kind>YLo..YHi (low driven LT.lowDrivenY).
 *
 * SOLVER (solveShot, at contact; reads the action fields, draws s.rng for error only: always two rngGauss).
 *  - Speed: lerp(T_SHOT.speedMin, speedMax, power) (finesse x T_SHOT.finesseSpeedMul; power shot up to
 *    T_SHOT.powerShotMax from LT.powerShotMinSpeed; low driven from LT.lowDrivenMinSpeed; free kick LT.fkSpeedMin..Max,
 *    x LT.fkDrivenMul with ReqFlag.DRIVEN) x lerp(LT.shotPowerMulMin, 1, shotPower attribute).
 *  - Spin: finesse curl T_SHOT.finesseSpin x curve attribute (LT.curveMulMin..Max), bending back toward the goal centre
 *    (inside the far post; a centre aim curls the natural way of the kicking foot), or along a request curl; chip
 *    backspin T_SHOT.chipBackspin; free kick curl = actCurve x LT.fkCurlSpin, dip = topspin LT.fkDipBase + LT.fkDipSpan x
 *    restart.side (RUL-05's dip -1..1, read while he is the FREE_KICK taker); other kinds curl actCurve x
 *    LT.normalCurlSpin.
 *  - Error (shotErrorSigma): sigma = errorMin + (errorMax - errorMin) x LT.errBaseShare x (1 - accuracy)^LT.errExp with
 *    accuracy = finishing (inside LT.finishRange of the goal) .. longShots (beyond LT.longRange) (finesse blends curve,
 *    free kick longShots + curve, penalty finishing + composure), x the kind's multiplier x power above
 *    T_SHOT.errorPowerKnee x balance (run vs shot direction, x speed fraction) x facing x pressure (eased by composure) x
 *    weaker foot x ball height at contact x incoming ball speed (first time) x low stamina, clamped to
 *    T_SHOT.errorMin..errorMax (rad). The aim direction turns by sigma x gauss; the height moves by sigma x
 *    LT.vertErrMul x gauss x distance, plus LT.overhitRise x (power above the knee)^2 (over-hit shots rise).
 *  - Trajectory: the launch (elevation + azimuth at the fixed speed; a chip: azimuth + speed at the elevation
 *    lerp(LT.chipAngleMin, chipAngleMax, power), Semi / Manual blend toward the power-only chip speed) is solved by
 *    iterating SIM-01 ballAirStep flights (secant on the height, rotation on the lateral miss) so the ball passes the
 *    aim point after error with its spin; [QF-13] its elevation is at most T_SHOT.maxAimedElevation (a soft shot that
 *    cannot carry that far lower lands short and bounces on). A low driven shot's rise is capped (peak
 *    LT.lowDrivenMaxPeak). An Assisted /
 *    Semi free kick that would hit the wall (height at the wall below LT.fkWallClearY within the wall's width) gets more
 *    topspin (LT.fkWallDipStep, up to LT.fkWallDipSteps times) to dip over it.
 *  - launch.onTarget = 1 when the solved flight crosses the goal line inside the mouth (centre within the posts and
 *    under the bar by a ball radius); tx/tz = the intended aim point; target = -1.
 *
 * Determinism / cost: plain arithmetic, Math.sqrt and dmath (dsin / dcos / dpow), s.rng only in the solver, module
 * scratch only (no per-tick allocation). Per tick per shooter: a few flops of movement capping. At contact: up to ~20
 * air flights of at most LT.maxFlightTicks steps (typically 3-6 flights of 40-90 steps; ~0.05 ms per solve in Node).
 *
 * Helper module: shotHooks.ts (import-cycle-safe shells of shotHandler / solveShot, re-exported first below).
 */
// Re-export the registry-facing shells FIRST: see shotHooks.ts (import-cycle safety with actions/registry).
export { shotHandler, solveShot } from './shotHooks';
import { bindShotImpl } from './shotHooks';
import { beginAction, isFree } from '../actions/dispatch';
import { BALL_RADIUS, DT, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS, TICK_HZ } from '../../contracts/constants';
import { ActionKind, AssistLevel, Foot, KickKind, MatchPhase, RestartKind, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { createBallState, MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { createKickLaunch, ReqFlag, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_BALL, T_FEEL, T_FEEL2, T_PASS, T_PLAYER, T_SHOT, T_SHOT_KICK } from '../../contracts/tuning';
import { ballAirStep, curlSpinY, launchSpin } from '../ball/flight';
import { dcos, dpow, dsin } from '../core/dmath';
import { applyKick, ballTouchedThisTick } from '../core/kick';
import { isHumanSlot, pressureOn } from '../core/query';
import { rngGauss } from '../core/rng';
import { staminaFactor } from '../players/locomotion';
import {
  approachDeadBall, footCanStrike, isDeadBallTaker, lineUpOnDeadBall, noteCharging, ownLaunchBlocked, releaseStrike,
  turnKickWait, turnToKick,
} from './kickCommon';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_SHOT_KICK. */
export const LOCAL_TUNING = T_SHOT_KICK;


const LT = T_SHOT_KICK;

// Hot-path copies of imported constants (module-level locals: no import-binding lookups per tick).
const NS = NUM_SLOTS;
const HZ = TICK_HZ;
const TDT = DT;
const R = BALL_RADIUS;
const HL = HALF_LENGTH;
const GHW = GOAL_HALF_WIDTH;
const GRAV = T_BALL.gravity;
const REACH2 = LT.reachRadius * LT.reachRadius;
const REACH_H = LT.reachHeight;
const MOVE_CAP = LT.windupMoveScale;
const LOCK_T = LT.contactLockTicks;
const CHARGE_WAIT = T_PASS.powerFillTicks + LT.chargeWaitExtraTicks;
const JOG_FRAC = T_PLAYER.jogFraction;
const DEFAULT_REC = T_SHOT.contact + T_SHOT.recovery;
/** Assisted aims stay this far from the goal centre at most (assistInset inside the posts), m. */
const ASSIST_Z = GHW - T_SHOT.assistInset;
/** On target: the ball centre crosses within the posts and under the bar by a ball radius, m. */
const POST_IN = GHW - R;
const BAR_IN = GOAL_HEIGHT - R;
const KNEE = T_SHOT.errorPowerKnee;

/** 1 for restart phases (index = MatchPhase). */
const RESTART_PHASE = new Uint8Array(MatchPhase.POST_MATCH + 1);
for (const ph of RESTART_PHASES) RESTART_PHASE[ph] = 1;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

const LAUNCH = createKickLaunch();
/** Scratch ball for the trajectory model (origin at the ball). */
const FLY = createBallState();
/** Scratch spin vector (SIM-01 launchSpin output). */
const SPIN = { x: 0, y: 0, z: 0 };
/** Solver scratch (doubles handed between helpers without boxing). */
const F = new Float64Array(40);
// aim (aimInto): goal-line x, height, z, end (-1/+1), assist strength, origin x/z
const A_X = 0, A_Y = 1, A_Z = 2, A_END = 3, A_STR = 4, A_BX = 5, A_BZ = 6;
// keeper projection (keeperProj): projected z on the goal line, cover half-width
const K_Z = 7, K_C = 8;
// trajectory: unit n (ball -> aim point), distance, target height, launch height, speed, elevation, azimuth (cos, sin
// relative to n), curl sy, backspin
const T_NX = 9, T_NZ = 10, T_D = 11, T_TY = 12, T_Y0 = 13, T_V = 14, T_TH = 15, T_CA = 16, T_SA = 17, T_CURL = 18, T_BACK = 19;
// flight measurement (flyAlong): lateral offset (right of n), height, time (s), distance reached along n
const M_LAT = 20, M_Y = 21, M_T = 22, M_ALONG = 23;
// final launch components
const L_VX = 24, L_VY = 25, L_VZ = 26, L_DX = 27, L_DZ = 28;

// ---------------------------------------------------------------- small helpers

function validSlot(i: number): boolean { return i >= 0 && i < NS && (i | 0) === i; }
function fin(v: number): number { return v === v && v < Infinity && v > -Infinity ? v : 0; }
function clamp01(v: number): number { return v > 0 ? (v < 1 ? v : 1) : 0; }
/** Attribute 1..99 -> 0..1. */
function attr01(v: number): number { return clamp01((fin(v) - 1) / 98); }

/** True for the kick kinds this module starts and solves. */
export function isShotKind(k: KickKind): boolean {
  return (k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN) || k === KickKind.FREE_KICK_SHOT || k === KickKind.PENALTY ||
    k === KickKind.SHOT_TRIVELA;
}

/** Wind-up ticks (contact tick) of a shot kind. */
export function shotWindup(k: KickKind): number {
  return k === KickKind.SHOT_POWER ? T_SHOT.powerShotWindup : T_SHOT.windup;
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

/** The ball is his to strike now: not held / owned by anyone else, low, and his own or within reach of his body. */
function ballInReach(s: SimState, slot: number): boolean {
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

// ---------------------------------------------------------------- starter

/** Start a shot of `kind` (SHOT_*, FREE_KICK_SHOT, PENALTY). Returns 1 if started, 0 if refused. */
export function startShot(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot)) return 0;
  const flags = fin(req.flags) & 0xff;
  let k = kind;
  if (k === KickKind.SHOT_NORMAL && (flags & ReqFlag.LOW) !== 0) k = KickKind.SHOT_LOW_DRIVEN;
  if (!isShotKind(k)) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !liveFor(s, slot)) return 0;
  const b = s.ball;
  if (b.heldBy >= 0) return 0;
  if (b.owner >= 0 && b.owner !== slot) return 0;
  const w = shotWindup(k);
  if (b.owner !== slot && !ballInReach(s, slot) && !ballArriving(s, slot, w + LT.startArriveTicks, LT.startArriveLane)) return 0;
  beginAction(p, ActionKind.SHOT, w + DEFAULT_REC, w);
  p.actKick = k;
  p.actSkill = SkillMove.NONE;
  p.actPower = clamp01(fin(req.power));
  p.actCharging = req.charging === 1 ? 1 : 0;
  let dx = fin(req.dirX), dz = fin(req.dirZ);
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }
  p.actDirX = dx;
  p.actDirZ = dz;
  p.actSlot = -1;
  const ht = req.hasTarget === 1 ? 1 : 0;
  const tx = fin(req.targetX), tz = fin(req.targetZ);
  p.actX = ht === 1 ? (tx < -100 ? -100 : tx > 100 ? 100 : tx) : 0;
  p.actZ = ht === 1 ? (tz < -100 ? -100 : tz > 100 ? 100 : tz) : 0;
  const c = fin(req.curve);
  p.actCurve = c < -1 ? -1 : c > 1 ? 1 : c;
  p.actA = k === KickKind.SHOT_LOW_DRIVEN ? flags | ReqFlag.LOW : flags;
  const a = req.assist;
  p.actB = (a === AssistLevel.SEMI || a === AssistLevel.MANUAL ? a : AssistLevel.ASSISTED) + ht * 4;
  return 1;
}

/**
 * Second SHOOT press during the power-up (SIM-15 resolver): the running open-play shot (SHOT_NORMAL .. SHOT_LOW_DRIVEN,
 * before its contact) becomes SHOT_LOW_DRIVEN with the power charged so far. A power shot's longer wind-up shrinks to
 * T_SHOT.windup (never earlier than now). Charging is left to the resolver. Returns 1 if the shot is (now) low driven.
 */
export function markLowDriven(s: SimState, slot: number): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.act !== ActionKind.SHOT || p.actDone !== 0) return 0;
  const k = p.actKick;
  if (!(k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN)) return 0;
  p.actA = (p.actA | ReqFlag.LOW) & 0xff;
  if (k === KickKind.SHOT_LOW_DRIVEN) return 1;
  p.actKick = KickKind.SHOT_LOW_DRIVEN;
  const w = T_SHOT.windup;
  if (p.actContact > w) {
    let rec = p.actDur - p.actContact;
    if (!(rec >= 1)) rec = DEFAULT_REC;
    const c = p.actT > w ? p.actT : w;
    if (c < p.actContact) {
      p.actContact = c;
      p.actDur = c + rec;
    }
  }
  return 1;
}

// ---------------------------------------------------------------- aim

/** Assist strength 0..1 for an AssistLevel and kind. */
function assistStrength(assist: number, kind: KickKind): number {
  const a = assist === AssistLevel.MANUAL ? 0 : assist === AssistLevel.SEMI ? LT.semiAssist : 1;
  return kind === KickKind.SHOT_POWER ? a * LT.powerShotAssistMul : a;
}

/**
 * The defending keeper of the goal at (gx, end) seen from the origin (bx, bz): his position projected along the line
 * from the origin onto the goal line (F[K_Z]) and his cover there (F[K_C]). 0 when there is no such keeper in front.
 */
function keeperProj(s: SimState, team: number, bx: number, bz: number, gx: number, end: number): number {
  const k = s.teams[team === 0 ? 1 : 0]!.keeperSlot;
  if (!validSlot(k)) return 0;
  const q = s.players[k]!;
  if (q.active !== 1) return 0;
  if ((gx - q.x) * end < -1) return 0; // behind his goal line
  const ahead = (q.x - bx) * end;
  if (!(ahead > LT.keeperMinAhead)) return 0;
  const ratio = ((gx - bx) * end) / ahead;
  if (!(ratio >= 1)) return 0;
  F[K_Z] = bz + (q.z - bz) * ratio;
  let c = LT.keeperCover * ratio;
  if (c > GHW) c = GHW;
  F[K_C] = c;
  return 1;
}

/** Height of the aim at the goal line for kind and power (0..1), m. */
function aimHeight(kind: KickKind, power: number): number {
  switch (kind) {
    case KickKind.SHOT_FINESSE: return LT.finesseYLo + (LT.finesseYHi - LT.finesseYLo) * power;
    case KickKind.SHOT_CHIP: return LT.chipYLo + (LT.chipYHi - LT.chipYLo) * power;
    case KickKind.SHOT_POWER: return LT.powerYLo + (LT.powerYHi - LT.powerYLo) * power;
    case KickKind.SHOT_LOW_DRIVEN: return LT.lowDrivenY;
    case KickKind.FREE_KICK_SHOT: return LT.fkYLo + (LT.fkYHi - LT.fkYLo) * power;
    case KickKind.PENALTY: return LT.penaltyYLo + (LT.penaltyYHi - LT.penaltyYLo) * power;
    default: return LT.normalYLo + (LT.normalYHi - LT.normalYLo) * power;
  }
}

/**
 * [FEEL-2] The human-controlled shooter's own shot calibration (T_FEEL2.human*, D-034 / D-036) applies in open play
 * only: penalties, shoot-outs and free kicks (struck in their restart phase) keep the calibrated values.
 */
function humanOpenPlay(s: SimState, slot: number): boolean {
  return s.match.phase === MatchPhase.IN_PLAY && isHumanSlot(s, slot);
}

/**
 * Aim of a shot of `kind` by slot (see the header): writes F[A_X] (goal-line x), F[A_Y] (height), F[A_Z], F[A_END],
 * F[A_STR] (assist strength) and the origin F[A_BX] / F[A_BZ]. Pure (no RNG).
 */
function aimInto(
  s: SimState, slot: number, kind: KickKind, dirX: number, dirZ: number, hasT: number, tx: number, tz: number,
  power: number, assist: number,
): void {
  const p = s.players[slot]!;
  const b = s.ball;
  let bx = b.x, bz = b.z;
  const ox = b.x - p.x, oz = b.z - p.z;
  if (b.owner !== slot && ox * ox + oz * oz > LT.aimBallNear * LT.aimBallNear) { bx = p.x; bz = p.z; }
  const tX = fin(tx);
  const near = HL - LT.goalTargetDepth;
  const explicit = hasT === 1 && (tX >= near || tX <= -near);
  let end: number;
  if (explicit) end = tX > 0 ? 1 : -1;
  else if (s.match.phase === MatchPhase.SHOOT_OUT) end = b.x >= 0 ? 1 : -1;
  else end = s.teams[p.team]!.dir >= 0 ? 1 : -1;
  const gx = end * HL;
  const A = assistStrength(assist, kind);
  // Goal-centre direction from the origin.
  let gcx = gx - bx, gcz = 0 - bz;
  const gcl = Math.sqrt(gcx * gcx + gcz * gcz);
  if (gcl > 1e-6) { gcx /= gcl; gcz /= gcl; } else { gcx = end; gcz = 0; }
  // Stick direction, else the facing, else the goal centre.
  let ux = fin(dirX), uz = fin(dirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  const hasDir = ul > 1e-6;
  if (!hasDir) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = gcx; uz = gcz; }
  // The ray from the origin onto the goal line.
  let zRay: number;
  if (ux * end > LT.rayMinAlong && (gx - bx) * end > 0) {
    zRay = bz + uz * (gx - bx) / ux;
    if (zRay > LT.rayMaxZ) zRay = LT.rayMaxZ; else if (zRay < -LT.rayMaxZ) zRay = -LT.rayMaxZ;
  } else {
    const cross = gcx * uz - gcz * ux;
    zRay = (cross >= 0 ? end : -end) * LT.rayMaxZ;
  }
  let zM: number, zA: number;
  // [FEEL-2] A human's finesse is the placed shot: its assisted aim may go nearer the post (T_FEEL2.finesseInset) and a
  // stick toward a corner places it there (finesseSnapFrom); his trivela likewise at trivelaInset (trivelaSnapFrom).
  // A placed shot goes where it is placed: the raw stick ray is not blended back in (a stick pushed right into the
  // corner sent the finesse wide). Explicit targets, set pieces and the CPU's shots are unchanged (D-034, D-036).
  const human = !explicit && humanOpenPlay(s, slot);
  const placed = human && kind === KickKind.SHOT_FINESSE;
  const placedT = human && kind === KickKind.SHOT_TRIVELA;
  const zLim = placed ? GHW - T_FEEL2.finesseInset : placedT ? GHW - T_FEEL2.trivelaInset : ASSIST_Z;
  let snapped = false;
  if (explicit) {
    zM = fin(tz);
    if (zM > LT.rayMaxZ) zM = LT.rayMaxZ; else if (zM < -LT.rayMaxZ) zM = -LT.rayMaxZ;
    zA = zM;
  } else {
    zM = zRay;
    const kp = keeperProj(s, p.team, bx, bz, gx, end);
    const cap = GHW + LT.captureMargin;
    if (hasDir) {
      zA = zRay <= cap && zRay >= -cap ? zRay : zRay > 0 ? GHW : -GHW;
      const snap = placed ? T_FEEL2.finesseSnapFrom : placedT ? T_FEEL2.trivelaSnapFrom : -1;
      if (snap > 0 && (zA >= snap || zA <= -snap)) { zA = zA > 0 ? zLim : -zLim; snapped = true; }
    } else if (kp === 1) {
      const kz = F[K_Z]!;
      zA = zLim - kz >= kz + zLim ? zLim : -zLim; // the side with more room
    } else zA = bz > 0 ? -zLim : zLim; // far post
    if (zA > zLim) zA = zLim; else if (zA < -zLim) zA = -zLim;
    if (kp === 1) {
      // Out of the keeper's cover (toward the side the aim is on), by at most keeperShiftMax.
      const kz = F[K_Z]!, kc = F[K_C]!;
      const d = zA - kz;
      if (d < kc && d > -kc) {
        const side = d > 0 ? 1 : d < 0 ? -1 : zLim - kz >= kz + zLim ? 1 : -1;
        let shift = kz + side * kc - zA;
        if (shift > LT.keeperShiftMax) shift = LT.keeperShiftMax; else if (shift < -LT.keeperShiftMax) shift = -LT.keeperShiftMax;
        zA += shift;
      }
    }
  }
  if (zA > zLim) zA = zLim; else if (zA < -zLim) zA = -zLim;
  F[A_X] = gx;
  F[A_Z] = snapped ? zA : zM + (zA - zM) * A;
  F[A_Y] = aimHeight(kind, clamp01(power));
  F[A_END] = end;
  F[A_STR] = A;
  F[A_BX] = bx;
  F[A_BZ] = bz;
}

/**
 * Aim point on the goal mouth (z across the mouth, y height) for a shot by slot toward stick direction (dirX, dirZ)
 * (pitch space; 0, 0 = idle stick) at power 0..1 and AssistLevel `assist`; out.x = the aimed goal line. The kind is the
 * player's running shot (SHOT_NORMAL when he has none). Pure: no RNG, no state change. Error is applied at contact.
 */
export function shotAimPoint(s: SimState, slot: number, dirX: number, dirZ: number, power: number, assist: number, out: { x: number; y: number; z: number }): void {
  if (!validSlot(slot)) { out.x = 0; out.y = 0; out.z = 0; return; }
  const p = s.players[slot]!;
  const kind = p.act === ActionKind.SHOT && isShotKind(p.actKick) ? p.actKick : KickKind.SHOT_NORMAL;
  aimInto(s, slot, kind, dirX, dirZ, 0, 0, 0, fin(power), assist);
  out.x = F[A_X]!;
  out.y = F[A_Y]!;
  out.z = F[A_Z]!;
}

// ---------------------------------------------------------------- speed, spin, error

/** Launch speed (m/s) of a shot of kind by slot at power 0..1 with ReqFlag bits `flags`. Pure. */
export function shotSpeedFor(s: SimState, slot: number, kind: KickKind, power: number, flags: number): number {
  if (!validSlot(slot)) return 0;
  const pw = clamp01(fin(power));
  const m = LT.shotPowerMulMin + (1 - LT.shotPowerMulMin) * attr01(s.attrs[slot]!.shotPower);
  const lo = T_SHOT.speedMin, hi = T_SHOT.speedMax;
  let v: number;
  switch (kind) {
    // [FEEL-2] A human's finesse / trivela (T_FEEL2.human*, D-034); the CPU's keep the calibrated pace.
    case KickKind.SHOT_FINESSE: v = (lo + (hi - lo) * pw) * (humanOpenPlay(s, slot) ? T_FEEL2.humanFinesseSpeedMul : T_SHOT.finesseSpeedMul); break;
    case KickKind.SHOT_TRIVELA: v = (lo + (hi - lo) * pw) * (humanOpenPlay(s, slot) ? T_FEEL2.humanTrivelaSpeedMul : T_FEEL.trivelaSpeedMul); break;
    case KickKind.SHOT_CHIP: v = (lo + (hi - lo) * pw) * T_SHOT.chipSpeedMul; break;
    case KickKind.SHOT_POWER: v = LT.powerShotMinSpeed + (T_SHOT.powerShotMax - LT.powerShotMinSpeed) * pw; break;
    case KickKind.SHOT_LOW_DRIVEN: v = LT.lowDrivenMinSpeed + (hi - LT.lowDrivenMinSpeed) * pw; break;
    case KickKind.FREE_KICK_SHOT:
      v = LT.fkSpeedMin + (LT.fkSpeedMax - LT.fkSpeedMin) * pw;
      if ((fin(flags) & ReqFlag.DRIVEN) !== 0) v *= LT.fkDrivenMul;
      break;
    default: v = lo + (hi - lo) * pw;
  }
  v *= m;
  return v > T_BALL.maxSpeed ? T_BALL.maxSpeed : v;
}

/** Weaker foot strikes a ball by slot toward (ax, az)? (Side of the ball, else the sharp-turn rule; see LT.) */
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

/** Accuracy attribute 0..1 of slot for a shot of kind from `dist` m (goal centre). */
function shotAccuracy(s: SimState, slot: number, kind: KickKind, dist: number): number {
  const a = s.attrs[slot]!;
  const w = clamp01((dist - LT.finishRange) / (LT.longRange - LT.finishRange));
  let v = fin(a.finishing) + (fin(a.longShots) - fin(a.finishing)) * w;
  if (kind === KickKind.SHOT_FINESSE || kind === KickKind.SHOT_TRIVELA) v += (fin(a.curve) - v) * LT.finesseCurveWeight;
  else if (kind === KickKind.FREE_KICK_SHOT) v = fin(a.longShots) + (fin(a.curve) - fin(a.longShots)) * LT.fkCurveWeight;
  else if (kind === KickKind.PENALTY) v = fin(a.finishing) + (fin(a.composure) - fin(a.finishing)) * LT.penaltyComposureWeight;
  return attr01(v);
}

function kindErrMul(kind: KickKind, human: boolean, inv: number): number {
  switch (kind) {
    case KickKind.SHOT_FINESSE: return LT.errMulFinesse;
    // [FEEL-2] A human's trivela errs more the poorer his accuracy (inv = 1 - accuracy: about a normal shot's error for
    // a top finisher, far more for a poor one), his power shot more (T_FEEL2, D-034 / D-036); the CPU's keep the
    // calibrated error.
    case KickKind.SHOT_TRIVELA: return human ? T_FEEL2.humanTrivelaErrMul + T_FEEL2.humanTrivelaErrSlope * clamp01(inv) : T_FEEL.trivelaErrMul;
    case KickKind.SHOT_CHIP: return LT.errMulChip;
    case KickKind.SHOT_POWER: return human ? T_FEEL2.humanPowerErrMul : LT.errMulPower;
    case KickKind.SHOT_LOW_DRIVEN: return LT.errMulLowDriven;
    case KickKind.PENALTY: return LT.errMulPenalty;
    case KickKind.FREE_KICK_SHOT: return LT.errMulFreeKick;
    default: return LT.errMulNormal;
  }
}

/**
 * Angular error sigma (rad, T_SHOT.errorMin..errorMax) of a shot of kind by slot at power 0..1 along horizontal
 * direction (dirX, dirZ) from `dist` m (ball to the goal centre). Pure (no RNG): see the header for the factors.
 */
export function shotErrorSigma(s: SimState, slot: number, kind: KickKind, power: number, dirX: number, dirZ: number, dist: number): number {
  if (!validSlot(slot)) return T_SHOT.errorMax;
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const b = s.ball;
  const inv = 1 - shotAccuracy(s, slot, kind, fin(dist));
  let sigma = T_SHOT.errorMin + (T_SHOT.errorMax - T_SHOT.errorMin) * LT.errBaseShare * dpow(clamp01(inv), LT.errExp);
  sigma *= kindErrMul(kind, humanOpenPlay(s, slot), inv);
  const pw = clamp01(fin(power));
  if (pw > KNEE) sigma *= 1 + LT.powerErrMul * (pw - KNEE) / (1 - KNEE);
  const ax = fin(dirX), az = fin(dirZ);
  const al = Math.sqrt(ax * ax + az * az);
  if (al > 1e-6) {
    // Balance: run direction vs shot direction, scaled by the speed fraction.
    const vx = fin(p.vx), vz = fin(p.vz);
    const sp = Math.sqrt(vx * vx + vz * vz);
    if (sp > 1e-3) {
      const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
      let c = (vx * ax + vz * az) / (sp * al);
      if (c > 1) c = 1; else if (c < -1) c = -1;
      sigma *= 1 + LT.balanceErrMul * clamp01(sp / top) * (1 - c) * 0.5;
    }
    const fx = fin(p.fx), fz = fin(p.fz);
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-6) {
      let c = (fx * ax + fz * az) / (fl * al);
      if (c > 1) c = 1; else if (c < -1) c = -1;
      sigma *= 1 + LT.facingErrMul * (1 - c) * 0.5;
    }
  }
  sigma *= 1 + LT.pressureErrMul * pressureOn(s, slot) * (1 - LT.composureRelief * attr01(a.composure));
  if (weakFootUsed(s, slot, ax, az)) {
    let wf = fin(a.weakFoot);
    if (wf < 1) wf = 1; else if (wf > 5) wf = 5;
    sigma *= 1 + (LT.weakFootErrMul - 1) * (5 - wf) / 4;
  }
  sigma *= 1 + LT.heightErrMul * clamp01((fin(b.y) - LT.heightErrFrom) / LT.heightErrSpan);
  if (b.owner !== slot) {
    const rx = fin(b.vx) - fin(p.vx), ry = fin(b.vy), rz = fin(b.vz) - fin(p.vz);
    const rel = Math.sqrt(rx * rx + ry * ry + rz * rz);
    sigma *= 1 + LT.firstTimeErrMul * clamp01((rel - LT.firstTimeErrFrom) / LT.firstTimeErrSpan);
  }
  const floor = T_PLAYER.staminaFloorMul;
  if (floor < 1) sigma *= 1 + LT.staminaErrMul * clamp01((1 - staminaFactor(p)) / (1 - floor));
  if (!(sigma >= T_SHOT.errorMin)) sigma = T_SHOT.errorMin;
  if (sigma > T_SHOT.errorMax) sigma = T_SHOT.errorMax;
  return sigma;
}

// ---------------------------------------------------------------- trajectory model

/**
 * Set FLY (origin at the ball) from the launch in F: speed T_V, elevation T_TH, azimuth (T_CA, T_SA) relative to
 * (T_NX, T_NZ), curl T_CURL, backspin T_BACK, launch height T_Y0. Stores the components in L_*.
 */
function setLaunchFromAngles(): void {
  const v = F[T_V]!, th = F[T_TH]!;
  const ct = dcos(th), st = dsin(th);
  const nx = F[T_NX]!, nz = F[T_NZ]!, ca = F[T_CA]!, sa = F[T_SA]!;
  const dx = nx * ca - nz * sa;
  const dz = nx * sa + nz * ca;
  const vh = v * ct;
  F[L_VX] = vh * dx;
  F[L_VY] = v * st;
  F[L_VZ] = vh * dz;
  F[L_DX] = dx;
  F[L_DZ] = dz;
}

/** Put the launch L_* (with the spin from T_CURL / T_BACK about L_DX / L_DZ, SIM-01 launchSpin) on FLY at the origin. */
function loadFly(): void {
  launchSpin(F[L_DX]!, F[L_DZ]!, F[T_CURL]!, F[T_BACK]!, SPIN);
  FLY.x = 0; FLY.y = F[T_Y0]!; FLY.z = 0;
  FLY.vx = F[L_VX]!; FLY.vy = F[L_VY]!; FLY.vz = F[L_VZ]!;
  FLY.sx = SPIN.x; FLY.sy = SPIN.y; FLY.sz = SPIN.z;
}

/**
 * Fly FLY (loaded by loadFly) with SIM-01's air physics in tick steps (no ground: the model passes through it) until it
 * has gone `dist` m along (T_NX, T_NZ). Writes M_LAT (offset to the right of n), M_Y (height) and M_T (s) there,
 * interpolated inside the last step, and M_ALONG. Returns 1 if reached within LT.maxFlightTicks.
 */
function flyAlong(dist: number): number {
  const nx = F[T_NX]!, nz = F[T_NZ]!;
  let pa = 0, pl = 0, py = FLY.y;
  const n = LT.maxFlightTicks;
  for (let i = 0; i < n; i++) {
    ballAirStep(FLY, TDT);
    const a = FLY.x * nx + FLY.z * nz;
    const l = FLY.z * nx - FLY.x * nz;
    if (a >= dist) {
      const f = a > pa ? (dist - pa) / (a - pa) : 1;
      F[M_LAT] = pl + (l - pl) * f;
      F[M_Y] = py + (FLY.y - py) * f;
      F[M_T] = (i + f) * TDT;
      F[M_ALONG] = dist;
      return 1;
    }
    pa = a; pl = l; py = FLY.y;
    if (py < -50) break;
  }
  F[M_LAT] = pl;
  F[M_Y] = py;
  F[M_T] = n * TDT;
  F[M_ALONG] = pa;
  return 0;
}

/** Rotate the azimuth (T_CA, T_SA) to cancel a lateral miss M_LAT at distance d. */
function correctAzimuth(d: number): void {
  const lat = F[M_LAT]!;
  const l = Math.sqrt(d * d + lat * lat);
  if (!(l > 1e-9)) return;
  const cd = d / l, sd = (0 - lat) / l;
  const ca = F[T_CA]!, sa = F[T_SA]!;
  const nca = ca * cd - sa * sd;
  const nsa = sa * cd + ca * sd;
  const nl = Math.sqrt(nca * nca + nsa * nsa);
  F[T_CA] = nca / nl;
  F[T_SA] = nsa / nl;
}

/**
 * Elevation + azimuth at the fixed speed T_V so the flight passes the aim point (T_D along n, height T_TY): secant on
 * the height, rotation on the lateral miss, at most LT.solveIters flights. The last flight measured (M_*) is the one of
 * the final launch (L_*). Returns 1 if that flight reached the aim distance.
 */
function solveAimed(): number {
  const D = F[T_D]!, ty = F[T_TY]!;
  const y0 = F[T_Y0]!;
  const v = F[T_V]!;
  const t0 = v > 1e-3 ? D / v : 1;
  let th = (ty - y0 + 0.5 * GRAV * t0 * t0) / (D > 0.1 ? D : 0.1);
  if (th < LT.minElevation) th = LT.minElevation; else if (th > LT.maxElevation) th = LT.maxElevation;
  let prevTh = 0, prevY = 0, havePrev = false;
  let reached: number;
  for (let it = 0; ; it++) {
    F[T_TH] = th;
    setLaunchFromAngles();
    loadFly();
    reached = flyAlong(D);
    const ey = ty - F[M_Y]!;
    const el = F[M_LAT]!;
    if (it >= LT.solveIters - 1) break;
    if (reached === 1 && ey < LT.solveTol && ey > -LT.solveTol && el < LT.solveTol && el > -LT.solveTol) break;
    if (reached === 1) correctAzimuth(D);
    let nth: number;
    const y = F[M_Y]!;
    if (reached === 1 && havePrev && y !== prevY) nth = th + ey * (th - prevTh) / (y - prevY);
    else if (reached === 1) { const c = dcos(th); nth = th + ey * c * c / (D > 0.1 ? D : 0.1); } else nth = th + 0.1;
    if (nth > th + 0.3) nth = th + 0.3; else if (nth < th - 0.3) nth = th - 0.3;
    if (nth < LT.minElevation) nth = LT.minElevation; else if (nth > LT.maxElevation) nth = LT.maxElevation;
    if (reached === 1) { prevTh = th; prevY = y; havePrev = true; }
    if (nth === th) break;
    th = nth;
  }
  return reached;
}

/**
 * Chip: speed + azimuth at the fixed elevation T_TH so the flight passes the aim point (secant on the speed). Leaves
 * T_V set; the last flight measured is the final launch's. Returns 1 if it reached the aim distance.
 */
function solveChipSpeed(): number {
  const D = F[T_D]!, ty = F[T_TY]!, y0 = F[T_Y0]!;
  const th = F[T_TH]!;
  const ct = dcos(th), st = dsin(th);
  const vmax = T_BALL.maxSpeed;
  const vmin = LT.chipSolveMinSpeed;
  const den = D * st / ct - (ty - y0);
  let v = den > 0.1 ? Math.sqrt(GRAV * D * D / (2 * ct * ct * den)) : vmax;
  if (v < vmin) v = vmin; else if (v > vmax) v = vmax;
  let prevV = 0, prevY = 0, havePrev = false;
  let reached: number;
  for (let it = 0; ; it++) {
    F[T_V] = v;
    setLaunchFromAngles();
    loadFly();
    reached = flyAlong(D);
    const y = F[M_Y]!;
    const ey = ty - y;
    const el = F[M_LAT]!;
    if (it >= LT.solveIters - 1) break;
    if (reached === 1 && ey < LT.solveTol && ey > -LT.solveTol && el < LT.solveTol && el > -LT.solveTol) break;
    let nv: number;
    if (reached !== 1) nv = v * 1.3;
    else {
      correctAzimuth(D);
      if (havePrev && y !== prevY) nv = v + ey * (v - prevV) / (y - prevY);
      else {
        // drag-free dy/dv at fixed distance: g D^2 / (v^3 cos^2)
        const dydv = GRAV * D * D / (v * v * v * ct * ct);
        nv = dydv > 1e-6 ? v + ey / dydv : v * 1.2;
      }
      prevV = v; prevY = y; havePrev = true;
    }
    if (nv > v * 2) nv = v * 2; else if (nv < v * 0.5) nv = v * 0.5;
    if (nv < vmin) nv = vmin; else if (nv > vmax) nv = vmax;
    if (nv === v) break;
    v = nv;
  }
  return reached;
}

// ---------------------------------------------------------------- solver

/** Curl (sy) and backspin of a shot into F[T_CURL] / F[T_BACK]; zAim / dxEnd = aim z and the x sign of travel. */
function spinInto(s: SimState, slot: number, kind: KickKind, curve: number, flags: number, zAim: number, ux: number): void {
  const a = s.attrs[slot]!;
  const cm = LT.curveMulMin + (LT.curveMulMax - LT.curveMulMin) * attr01(a.curve);
  const cv = fin(curve);
  const hasCurve = cv >= LT.curveDead || cv <= -LT.curveDead;
  let right = 0; // curl toward the right of travel, rad/s
  let back = 0;
  switch (kind) {
    case KickKind.SHOT_FINESSE: {
      const mag = (humanOpenPlay(s, slot) ? T_FEEL2.humanFinesseSpin : T_SHOT.finesseSpin) * cm;
      if (hasCurve) {
        const ac = cv < 0 ? -cv : cv;
        right = (cv > 0 ? 1 : -1) * mag * (LT.finesseSwipeMin + (1 - LT.finesseSwipeMin) * (ac < 1 ? ac : 1));
      } else if (zAim > LT.finesseCentreBand || zAim < -LT.finesseCentreBand) {
        // Bend back toward the goal centre (z acceleration sign = -sign(zAim); the right vector's z is ux).
        right = ((zAim > 0 ? -1 : 1) * (ux >= 0 ? 1 : -1)) * mag;
      } else {
        right = (a.foot === Foot.LEFT ? 1 : -1) * mag; // inside of the foot: a right-footer curls it left
      }
      break;
    }
    case KickKind.SHOT_TRIVELA: {
      // [FEEL-1] Outside of the foot: always the other way to a finesse shot from the same spot. Off-centre aim: it
      // starts inside the post and bends OUT into the corner (the finesse starts outside and bends back in); central:
      // the outside of his foot's way (a right-footer bends it right). A request curl (curved swipe) sets the side.
      const mag = (humanOpenPlay(s, slot) ? T_FEEL2.humanTrivelaSpin : T_FEEL.trivelaSpin) * cm;
      if (hasCurve) right = (cv > 0 ? 1 : -1) * mag;
      else if (zAim > LT.finesseCentreBand || zAim < -LT.finesseCentreBand) right = ((zAim > 0 ? 1 : -1) * (ux >= 0 ? 1 : -1)) * mag;
      else right = (a.foot === Foot.LEFT ? -1 : 1) * mag;
      break;
    }
    case KickKind.SHOT_CHIP:
      back = T_SHOT.chipBackspin;
      break;
    case KickKind.FREE_KICK_SHOT: {
      const r = s.match.restart;
      let dip = r.kind === RestartKind.FREE_KICK && r.taker === slot ? fin(r.side) : 0;
      if (dip > 1) dip = 1; else if (dip < -1) dip = -1;
      right = cv * LT.fkCurlSpin * cm;
      back = 0 - (LT.fkDipBase + LT.fkDipSpan * dip);
      if ((fin(flags) & ReqFlag.DRIVEN) !== 0) { right *= LT.fkDrivenCurlMul; back = 0; }
      break;
    }
    default:
      if (hasCurve) right = cv * LT.normalCurlSpin * cm;
      else if (kind === KickKind.SHOT_NORMAL || kind === KickKind.SHOT_LOW_DRIVEN) {
        // [FEEL-1] A natural slight curl off the instep: back toward the goal centre from an off-centre aim, else the
        // kicking foot's way (the solver aims with it, so it bends in rather than missing).
        const mag = (kind === KickKind.SHOT_NORMAL ? T_FEEL.normalNaturalSpin : T_FEEL.lowDrivenNaturalSpin) * cm;
        if (zAim > LT.finesseCentreBand || zAim < -LT.finesseCentreBand) right = ((zAim > 0 ? -1 : 1) * (ux >= 0 ? 1 : -1)) * mag;
        else right = (a.foot === Foot.LEFT ? 1 : -1) * mag;
      }
  }
  F[T_CURL] = curlSpinY(right); // SIM-01 convention: positive sy curls LEFT of the travel direction
  F[T_BACK] = back;
}

/** Assisted free kick over the wall: more topspin until the flight clears it (see LT.fkWall*). */
function wallAssist(s: SimState, slot: number): void {
  const r = s.match.restart;
  if (!(r.kind === RestartKind.FREE_KICK && r.taker === slot && r.wallCount > 0)) return;
  const nx = F[T_NX]!, nz = F[T_NZ]!;
  const wx = fin(r.wallX) - F[A_BX]!, wz = fin(r.wallZ) - F[A_BZ]!;
  const wa = wx * nx + wz * nz;
  const wl = wz * nx - wx * nz;
  if (!(wa > 1) || !(wa < F[T_D]! - 1)) return;
  const half = 0.5 * r.wallCount * LT.wallMemberWidth + LT.fkWallHalfExtra;
  for (let i = 0; ; i++) {
    loadFly();
    if (flyAlong(wa) !== 1) return;
    const d = F[M_LAT]! - wl;
    if (F[M_Y]! >= LT.fkWallClearY || d > half || d < -half) return;
    if (i >= LT.fkWallDipSteps) return;
    F[T_BACK] = F[T_BACK]! - LT.fkWallDipStep;
    solveAimed();
  }
}

function solveShotImpl(s: SimState, slot: number, out: KickLaunch): number {
  out.vx = 0; out.vy = 0; out.vz = 0; out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = KickKind.SHOT_NORMAL; out.target = -1; out.tx = 0; out.tz = 0; out.onTarget = 0;
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  const kind = isShotKind(p.actKick) ? p.actKick : KickKind.SHOT_NORMAL;
  const meta = fin(p.actB) | 0;
  let assist = meta & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  const hasT = (meta >> 2) & 1;
  const flags = fin(p.actA) | 0;
  let power = clamp01(fin(p.actPower));
  if (power < LT.minPower) power = LT.minPower;
  aimInto(s, slot, kind, p.actDirX, p.actDirZ, hasT, p.actX, p.actZ, power, assist);
  const gx = F[A_X]!, end = F[A_END]!, A = F[A_STR]!;
  const aimZ = F[A_Z]!, aimY = F[A_Y]!;
  const bx = fin(b.x), bz = fin(b.z);
  const y0 = b.y > R ? fin(b.y) : R;
  // Error: rotate the direction to the aim point, move its height.
  let ux = gx - bx, uz = aimZ - bz;
  const d0 = Math.sqrt(ux * ux + uz * uz);
  if (d0 > 1e-6) { ux /= d0; uz /= d0; } else { ux = end; uz = 0; }
  const dGoal = Math.sqrt((gx - bx) * (gx - bx) + bz * bz);
  const sigma = shotErrorSigma(s, slot, kind, power, ux, uz, dGoal);
  const g1 = rngGauss(s.rng);
  const g2 = rngGauss(s.rng);
  const eh = sigma * g1;
  const ce = dcos(eh), se = dsin(eh);
  const ex = ux * ce - uz * se;
  const ez = ux * se + uz * ce;
  let px: number, pz: number;
  let onLine = 0;
  if (ex * end > LT.rayMinAlong && (gx - bx) * end > 0.3) {
    px = gx;
    pz = bz + ez * (gx - bx) / ex;
    if (pz > LT.rayMaxZ) pz = LT.rayMaxZ; else if (pz < -LT.rayMaxZ) pz = -LT.rayMaxZ;
    onLine = 1;
  } else {
    const dd = d0 > 1 ? d0 : 1;
    px = bx + ex * dd;
    pz = bz + ez * dd;
  }
  let nx = px - bx, nz = pz - bz;
  let D = Math.sqrt(nx * nx + nz * nz);
  if (D > 1e-6) { nx /= D; nz /= D; } else { nx = end; nz = 0; D = 1e-6; }
  let ty = aimY + sigma * LT.vertErrMul * g2 * D;
  if (kind !== KickKind.SHOT_LOW_DRIVEN && power > KNEE) {
    const k = (power - KNEE) / (1 - KNEE);
    ty += LT.overhitRise * k * k;
  }
  if (ty < R) ty = R; else if (ty > LT.maxAimY) ty = LT.maxAimY;
  F[T_NX] = nx; F[T_NZ] = nz; F[T_D] = D; F[T_TY] = ty; F[T_Y0] = y0;
  F[T_CA] = 1; F[T_SA] = 0;
  spinInto(s, slot, kind, p.actCurve, flags, aimZ, nx);
  let v = shotSpeedFor(s, slot, kind, power, flags);
  if (kind === KickKind.SHOT_CHIP) {
    F[T_TH] = LT.chipAngleMin + (LT.chipAngleMax - LT.chipAngleMin) * power;
    if (A > 0) {
      solveChipSpeed();
      v = v + (F[T_V]! - v) * A;
    }
    F[T_V] = v;
    setLaunchFromAngles();
  } else {
    F[T_V] = v;
    solveAimed();
    if (kind === KickKind.FREE_KICK_SHOT && A > 0) wallAssist(s, slot);
    if (kind === KickKind.SHOT_LOW_DRIVEN) {
      const rise = LT.lowDrivenMaxPeak - y0;
      const cap = rise > 0 ? Math.sqrt(2 * GRAV * rise) : 0;
      const vy = F[L_VY]!;
      if (vy > cap) {
        const vh2 = v * v - cap * cap;
        const vh = vh2 > 0 ? Math.sqrt(vh2) : 0;
        F[L_VX] = vh * F[L_DX]!;
        F[L_VZ] = vh * F[L_DZ]!;
        F[L_VY] = cap;
      }
    }
  }
  // Final flight of the launch actually played: on target if it crosses the goal line inside the mouth.
  loadFly();
  const reached = flyAlong(D);
  if (onLine === 1 && reached === 1) {
    const zc = pz + F[M_LAT]! * nx;
    if (zc < POST_IN && zc > -POST_IN && F[M_Y]! < BAR_IN) out.onTarget = 1;
  }
  launchSpin(F[L_DX]!, F[L_DZ]!, F[T_CURL]!, F[T_BACK]!, SPIN);
  out.vx = F[L_VX]!;
  out.vy = F[L_VY]!;
  out.vz = F[L_VZ]!;
  out.sx = SPIN.x;
  out.sy = SPIN.y;
  out.sz = SPIN.z;
  out.kind = kind;
  out.target = -1;
  out.tx = gx;
  out.tz = aimZ;
  return 1;
}

// ---------------------------------------------------------------- SHOT action handler

/**
 * Contact done (struck or whiffed) at the current tick: actContact = now, the planned recovery follows. While the
 * contact waits past its tick actDur - actT keeps the planned recovery, before it actDur - actContact.
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
 * Movement while shooting: slowed during the wind-up / charge (stick capped, no sprint), LOCKED for LOCK_T ticks from
 * the contact, then STOP for one tick (the resolver / AI write the intent again) and a cap ramping back to 1.
 */
function shotMove(s: SimState, p: PlayerState): void {
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

/** Strike the ball: solver -> sanitised launch -> applyKick. Whiff when the solver cannot make the shot. */
function contact(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const k = p.actKick;
  const l = LAUNCH;
  if (solveShotImpl(s, slot, l) !== 1) { finishContact(p); return; }
  const vx = fin(l.vx), vy = fin(l.vy), vz = fin(l.vz);
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(sp > 0)) { finishContact(p); return; }
  const m = T_BALL.maxSpeed;
  const ks = sp > m ? m / sp : 1;
  l.vx = vx * ks; l.vy = vy * ks; l.vz = vz * ks;
  l.sx = fin(l.sx); l.sy = fin(l.sy); l.sz = fin(l.sz);
  l.tx = fin(l.tx); l.tz = fin(l.tz);
  l.target = -1;
  if (!isShotKind(l.kind)) l.kind = isShotKind(k) ? k : KickKind.SHOT_NORMAL;
  l.onTarget = l.onTarget === 1 ? 1 : 0;
  applyKick(s, slot, l, clamp01(fin(p.actPower)), ev);
  finishContact(p);
}

function shotUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (p.actDone !== 0 || p.actContact < 0) { shotMove(s, p); return; }
  const b = s.ball;
  // Dispossessed (someone else owns or holds the ball): no shot to strike.
  if ((b.owner >= 0 && b.owner !== slot) || (b.heldBy >= 0 && b.heldBy !== slot)) {
    finishContact(p);
    shotMove(s, p);
    return;
  }
  // [QF-10] A restart taker kicking the dead ball lines up behind it along his kick first (kickCommon.ts).
  const taker = isDeadBallTaker(s, slot);
  // [FIN-K] His own ball behind him for the kick: turn toward the kick (turn-and-kick), it comes round his body.
  const blocked = ownLaunchBlocked(s, slot);
  if (blocked) turnToKick(s, slot);
  if (p.actCharging === 1) {
    noteCharging(s, slot);
    if (taker) { approachDeadBall(s, slot); lineUpOnDeadBall(s, slot); }
    if (p.actT < p.actContact || p.actT - p.actContact < CHARGE_WAIT) { shotMove(s, p); return; }
    p.actCharging = 0; // backstop: the power bar never stays stuck
  }
  // [QF-10] A released power bar strikes T_PASS.releaseStrikeTicks later (kickCommon.ts).
  releaseStrike(s, slot);
  if (p.actT < p.actContact) {
    if (taker) { approachDeadBall(s, slot); lineUpOnDeadBall(s, slot); }
    shotMove(s, p);
    return;
  }
  const waited = p.actT - p.actContact;
  if (!liveFor(s, slot) || (ballTouchedThisTick(s) && b.lastTouch !== slot)) {
    finishContact(p);
    shotMove(s, p);
    return;
  }
  // [FIN-K] The dead ball not at his kicking spot: strike now from his current approach (kickCommon approachDeadBall),
  // never a re-line-up after the planned contact (that froze him in the kick pose for 6-14 ticks).
  if (taker) approachDeadBall(s, slot);
  if (blocked) {
    // [FIN-K] Never launched through his body: the contact waits while he turns and SIM-06 brings the ball round.
    if (turnKickWait(s, slot) === 0) finishContact(p); // dropped at the cap (the turn takes ~10-25 ticks)
    shotMove(s, p);
    return;
  }
  if (!footCanStrike(s, slot, LT.reachRadius, REACH_H)) {
    // Grace: his own ball until SIM-06 has it back on the kicking spot for up to LT.ownReachWaitTicks, or a loose ball
    // still arriving (first time) for up to LT.contactGraceTicks. The planned recovery is kept after the late contact.
    if (!taker) {
      if (b.owner === slot ? waited < LT.ownReachWaitTicks
        : waited < LT.contactGraceTicks && ballArriving(s, slot, LT.contactGraceTicks - waited, LT.startArriveLane)) {
        p.actDur += 1;
        shotMove(s, p);
        return;
      }
    }
    // A taker who could not line up in time still takes the restart when the ball is near him; anyone else whiffs.
    if (!taker || !ballInReach(s, slot)) {
      finishContact(p); // whiff
      shotMove(s, p);
      return;
    }
  }
  contact(s, slot, ev);
  shotMove(s, p);
}

function shotEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

bindShotImpl({ update: shotUpdate, end: shotEnd, solveShot: solveShotImpl });

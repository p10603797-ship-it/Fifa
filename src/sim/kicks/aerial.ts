/**
 * [SIM-12] Headers, volleys and aerial duels. When a human presses pass/lob/shoot while the ball is in the air
 * near the controlled player (or a teammate is under a cross), start HEADER or VOLLEY; aerialContacts resolves
 * jumps and contests between players (heading, height, strength, timing). Emits AERIAL.
 *
 * HOW IT WORKS
 *  Chance (aerialChance, pure): the loose ball's path is predicted with the sim's own physics (SIM-02 ballStepTick,
 *  as SIM-01 predictBall; memoised: the window slides along the free flight) for LT.horizon ticks. Sample i (the ball
 *  after i + 1 ticks) is playable as a HEADER when its centre height is inside the header window (LT.headerMinY ..
 *  min(LT.headerMaxY, the player's head reach at that lead time: standing head + the jump he can get up in time +
 *  LT.headReachV)), as a VOLLEY inside the volley window (LT.volleyMinY .. LT.volleyMaxY), and the player can get his
 *  body to it in time (an inline mirror of SIM-04 ticksToReach to the point LT.headLean / LT.footFwd short of the
 *  ball, less a reach slack). The sample to play is the first COMFORTABLE one (a header without a near-max leap or a
 *  deep stoop, a volley below LT.volleyComfortY), else the earliest playable one: 1 = header, 2 = volley, 0 = none
 *  (also 0 when nothing is playable within LT.chanceTicks). The player who touched the ball last cannot play it again
 *  for LT.retouchTicks.
 *  Start (startHeader / startVolley, or the AI in aerialContacts): plans against that sample. Action fields:
 *    actKick  HEADER_SHOT / HEADER_PASS / VOLLEY_SHOT / VOLLEY_PASS
 *    actPower 0..1 (a held button keeps charging until the contact window opens)
 *    actDirX/actDirZ aim direction (unit; 0,0 = automatic aim)    actSlot explicit receiver (-1 = auto)
 *    actX/actZ planned contact spot (ball position at the planned contact)
 *    actCurve planned head-centre height (HEADER; above the standing head by >= LT.minJump = a jump of that height
 *             peaking at actContact, or as high as he can get by then when the press was late) / foot height (VOLLEY)
 *    actA     flags: 1 = clearance, 2 = AI-started, bits 2..3 = AssistLevel
 *    actB     flight id = ball.lastTouchTick at the start; any later touch by anyone aborts the attempt
 *    actContact planned contact tick (relative); contact window [actContact - LT.earlyTicks, actContact + LT.lateTicks]
 *  Handler (HEADER / VOLLEY, every tick): run to the spot with SIM-04 ARRIVE steering at the time-to-go speed
 *  (meeting the ball on the move; holding, facing the ball, once there), cut the power charge when the window opens,
 *  abort when the flight is no longer the planned one (touched, owned, held, play stopped), miss when the window has
 *  passed; recovery after contact / miss waits for the landing of a jump. The actual contact is resolved in the
 *  contact phase (aerialContacts), not in the handler.
 *  Contact (aerialContacts, contact phase after GKP keeper contacts, so keepers keep priority; skipped when the ball
 *  was already touched this tick): every player in HEADER / VOLLEY on this flight with an open window whose head
 *  ellipsoid (LT.headReachH x LT.headReachV around the head centre, which follows the jump) or foot zone (LT.footReachH
 *  around the foot point, ball inside the volley band) meets the ball's swept segment of this tick reaches it; then
 *  everyone on the flight within the duel margins (LT.duelMarginH / V beyond those zones) challenges for it. A lone
 *  contestant wins outright; several are scored (heading or volley skill, strength, height + leap, jump timing, how
 *  cleanly the ball meets him, + small s.rng noise) and the best wins. The ball is played from the contact point
 *  (a line crossing later in this tick's segment is undone; a ball already wholly over a line is not played), AERIAL
 *  is emitted and the winner's solver launches it through applyKick. Every other attempt on that flight ends (no
 *  double contact); an opponent beaten in the air (jumping, within LT.duelBodyDist of the winner) stumbles with a
 *  strength-dependent chance (SIM-14 knockDown).
 *  AI (aerialContacts, after contacts): per team at most one attempt per flight. AI-driven (team AI or CPU brain)
 *  outfield players (each team looks every LT.aiScanEvery ticks, staggered) start an attempt when the sample they would
 *  play is at most LT.aiLeadTicks away (waiting up to LT.aiComfortWait more for a comfortable one): attackers
 *  shoot inside the shooting zone (crosses aimed at them), defenders head / volley clear near their goal, high balls
 *  (above the chest-trap height, or contested) are headed on to a teammate; everything else is left to SIM-07 first
 *  touch. The pass target of a teammate's pass has priority; other teammates leave it alone. AI jump timing gets a
 *  small s.rng error that shrinks with heading.
 *  Solvers (solveHeader / solveVolley): header shots 10-20 m/s and volley shots 20-30 m/s at the goal mouth (assisted
 *  aim like SIM-11: stick ray onto the goal line clamped inside the posts, or away from the keeper; Manual is
 *  unclamped), with an elevation solved through the real drag model so the ball crosses the line at the aimed height;
 *  passes land on the chosen receiver (SIM-01 solveLaunchSpin from the contact height); clearances go high and long
 *  away from goal. Error (s.rng) grows with weak heading / finishing / passing, pressure, balance (redirect angle),
 *  awkward height, fast incoming balls, power above the knee, low stamina and (volleys) the weaker foot.
 *
 * Determinism: dmath trig only, s.rng only, slot-order loops, module scratch (no per-tick allocation).
 */
// Re-export the registry-facing shells FIRST: see aerialHooks.ts (import-cycle safety with actions/registry).
export { headerHandler, solveHeader, solveVolley, volleyHandler } from './aerialHooks';
import { bindAerialImpl } from './aerialHooks';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import {
  BALL_RADIUS, DT, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_HALF_WIDTH, TICK_HZ,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, CrossKind, KickKind, MatchPhase } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { createBallState, MoveMode, type BallState, type SimState } from '../../contracts/state';
import { createKickLaunch, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { T_BALL, T_PASS, T_PLAYER, T_SHOT, T_TACKLE, T_TOUCH } from '../../contracts/tuning';
import { ballStepTick } from '../ball/contact';
import { ballAirStep, copyBallState, createLaunchSolution, solveLaunchSpin } from '../ball/flight';
import { clamp01, datan2, dcos, dsin, lerp, PI } from '../core/dmath';
import { applyKick, ballTouchedThisTick } from '../core/kick';
import { pressureOn } from '../core/query';
import { rngChance, rngGauss, rngRange } from '../core/rng';
import { knockDown } from '../defend/tackle';
import { staminaFactor } from '../players/locomotion';

// Hot-path copies of imported constants: module-level locals, so loops never go through import bindings (which
// test-time module transforms turn into getter calls).
const HL = HALF_LENGTH;
const HW = HALF_WIDTH;
const BR = BALL_RADIUS;
const NS = NUM_SLOTS;
const GHW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;
const PAHW = PENALTY_AREA_HALF_WIDTH;
const HZ = TICK_HZ;
const TDT = DT;
const TOP_MIN = T_PLAYER.topSpeedMin;
const ACC_MIN = T_PLAYER.accelMin;
const ARRIVE_STOP = T_PLAYER.arriveStop;
const JOG_FRAC = T_PLAYER.jogFraction;
const ST_FLOOR = T_PLAYER.staminaFloorMul;
const ST_LOW = T_PLAYER.staminaLowThreshold;
const T_DECEL = T_PLAYER.decel;
const T_TURN_SLOW = T_PLAYER.turnRateSlow;
const T_TURN_FAST = T_PLAYER.turnRateFast;
const T_AGI_TURN = T_PLAYER.agilityTurnScale;
const T_SPRINT_TURN = T_PLAYER.sprintTurnMul;

const LOCAL_TUNING = {
  // ---- windows: ball-centre height at contact, m [BRIEF / SIM-12 brief]
  headerMinY: 1.2,
  headerMaxY: 2.6,
  volleyMinY: 0.4,
  volleyMaxY: 1.2,
  // ---- body geometry
  /** Standing head-centre height as a fraction of body height. */
  headFrac: 0.93,
  /** Lowest head-centre height of a stooping header, m. */
  stoopMinHead: 1.0,
  /** Jump height range (m) from the leap rating (heading x jumpHeadingW + agility x the rest). */
  jumpMin: 0.3,
  jumpMax: 0.65,
  jumpHeadingW: 0.6,
  /** Planned jumps below this height are standing / stooping headers, m. */
  minJump: 0.06,
  /** Head centre ahead of the body centre (along the facing), m. */
  headLean: 0.1,
  /** Header contact ellipsoid around the head centre (for the ball centre): horizontal / vertical radius, m. */
  headReachH: 0.5,
  headReachV: 0.3,
  /** Volley: foot point ahead of the body centre, m; horizontal contact radius around it, m; band slack, m. */
  footFwd: 0.45,
  footReachH: 0.5,
  footBandSlack: 0.12,
  /** Reachability: the body must get within this of the lean / foot point (part of the contact radius), m. */
  headSlack: 0.25,
  footSlack: 0.3,
  /** Reachability: extra ticks tolerated on the reach estimate. */
  reachTickSlack: 1,
  /** Reach estimate: mirror of SIM-04 ticksToReach's fitted model (locomotion LOCAL_TUNING moveEps, ttrTurnCos,
   *  ttrTurnSpeedA/B, ttrTurnEndA/B, ttrTurnAccel, ttrTurnBack, ttrTurnSide, highSpeedAccelMul); keep in step. */
  reachMoveEps: 0.05,
  reachTurnCos: 0.985,
  reachTurnSpeedA: 0.9,
  reachTurnSpeedB: 0.05,
  reachTurnEndA: 0.95,
  reachTurnEndB: 0.16,
  reachTurnAccel: 1.0,
  reachTurnBack: 0.15,
  reachTurnSide: 0.5,
  reachHighSpeedAccelMul: 0.6,
  /** Reachability shortcut: a player slower than standSpeed (m/s) surely covers 0.5 x cautiousAccelFrac x accel x t^2
   *  in t seconds. */
  standSpeed: 0.5,
  cautiousAccelFrac: 0.5,
  /** Preferred contact: a header at most this fraction of the max jump above the standing head; a volley at most
   *  volleyComfortY high (m). Earlier, less comfortable chances are taken only when no comfortable one is reachable. */
  comfortJumpFrac: 0.6,
  volleyComfortY: 0.95,
  /** ... and a header no lower than this below the standing head (a stooping header is not comfortable), m. */
  stoopComfort: 0.3,
  // ---- planning and timing
  /** Prediction horizon for planning, ticks (1.2 s); aerialChance needs a playable sample within chanceTicks
   *  (0.8 s). */
  horizon: 72,
  chanceTicks: 48,
  /** The memoised prediction slides on when the ball matches one of its first predictSlide samples. */
  predictSlide: 4,
  /** Contact window around the planned contact tick: early / late, ticks. */
  earlyTicks: 3,
  lateTicks: 4,
  /** Recovery after a header / volley contact, ticks (a jump also waits for the landing + landSettle). */
  headerRecovery: 14,
  volleyRecovery: 16,
  landSettle: 4,
  /** Recovery after a missed window, ticks (after the landing for a jump). */
  missRecovery: 10,
  /** Recovery after an aborted attempt (someone else played the ball), ticks (after the landing for a jump). */
  abortRecovery: 6,
  /** The last toucher cannot start an aerial on the ball for this many ticks. */
  retouchTicks: 20,
  /** Approach: speed = hurry x distance left / time to go (arrive a touch early), at least approachMinSpeed m/s;
   *  ARRIVE aimed approachOvershoot m beyond the point (no arrival braking) until within approachNear m of it, then
   *  onto it; within approachEps m: hold. */
  approachHurry: 1.15,
  approachMinSpeed: 1.0,
  approachOvershoot: 4,
  approachNear: 0.6,
  approachEps: 0.05,
  // ---- AI starts
  /** AI starts an attempt when the contact is at most this many ticks ahead. */
  aiLeadTicks: 40,
  /** AI waits for a comfortable chance at most this many ticks beyond aiLeadTicks before taking an earlier one. */
  aiComfortWait: 24,
  /** Each team looks for AI attempts every this many ticks (staggered by team). */
  aiScanEvery: 3,
  /** AI candidates: within ball travel over aiLeadTicks + this of the ball, m. */
  aiScanRadius: 6,
  /** Max jump-timing error of an AI attempt at heading 1 (0 at 99), ticks. */
  aiTimingErrMax: 3,
  /** Shooting zone for AI aerial shots: within this of the goal line and of the centre line (|z|), m. */
  aiShotRange: 16,
  aiShotHalfWidth: 11,
  /** AI defenders head clear within this of their own goal line, m; volley clear inside their area (depth), m. */
  aiClearDepth: 35,
  aiVolleyClearDepth: 18,
  /** An opponent within this of the spot makes a trappable ball a contested header, m. */
  contestRadius: 2.5,
  /** AI header pass / clear power. */
  aiPassPower: 0.5,
  aiClearPower: 0.85,
  aiShotPower: 0.75,
  // ---- launch: header shot
  headerShotMin: 12,
  headerShotMax: 18.5,
  /** Share of power (rest: heading) in the header shot speed. */
  shotPowerW: 0.6,
  /** Incoming ball speed redirected into a header shot, fraction. */
  headerRedirect: 0.08,
  headerShotFloor: 10,
  headerShotCap: 20,
  // ---- launch: volley shot
  volleyShotMin: 21,
  volleyShotMax: 29,
  volleyShotFloor: 20,
  volleyShotCap: 30,
  // ---- launch: passes and clearances
  /** Header / volley pass distance range implied by power, m. */
  headerPassMinDist: 4,
  headerPassMaxDist: 26,
  volleyPassMinDist: 8,
  volleyPassMaxDist: 35,
  /** Launch speed caps (beyond: the ball falls short), m/s. */
  headerPassMaxSpeed: 16,
  volleyPassMaxSpeed: 22,
  /** Launch angle (rad) for short (5 m) .. long (25 m) header passes; volley passes. */
  headerPassAngleNear: 0.55,
  headerPassAngleFar: 0.3,
  volleyPassAngle: 0.28,
  /** Receiver lead: expected ball speed to the receiver, m/s; max lead time, s. */
  passLeadSpeed: 12,
  passLeadMax: 1.5,
  /** Receiver cone half-angle by assist (Assisted uses T_PASS.coneHalfAngle), rad; AI cone. */
  semiCone: 0.45,
  aiCone: 1.1,
  /** Receiver choice: weight of openness (nearest opponent, capped at opennessCap m) and distance mismatch. */
  opennessCap: 6,
  opennessW: 0.35,
  distMismatchScale: 20,
  /** Receiver choice: bonus for a receiver further up the pitch (x unit progress toward the attacked goal). */
  progressW: 0.1,
  /** Clearance speed range (m/s) and angle (rad): header, volley. */
  headerClearMin: 13,
  headerClearMax: 19,
  headerClearAngle: 0.6,
  volleyClearMin: 18,
  volleyClearMax: 26,
  volleyClearAngle: 0.45,
  // ---- aim
  /** Header aim height at the goal line: soft (power 0) .. firm (power 1), m. */
  headerAimHighY: 1.4,
  headerAimLowY: 0.35,
  /** Volley aim height at the goal line: power 0 .. power 1, m. */
  volleyAimLowY: 0.6,
  volleyAimHighY: 1.5,
  /** Semi-assisted inset from the post, m (Assisted: T_SHOT.assistInset; Manual: none). */
  semiInset: 0.3,
  /** Stick counts as pointing at the goal plane above this goalward component. */
  stickGoalward: 0.15,
  /** Manual shot with the stick away from goal: aim this far along the stick, m. */
  manualAwayDist: 20,
  /** Elevation solver: angle range (rad), iterations, max integration steps, speed raise factor and tries. */
  aimThetaMin: -0.6,
  aimThetaMax: 0.55,
  aimIters: 14,
  aimMaxSteps: 240,
  aimRaise: 1.12,
  aimRaiseTries: 6,
  /** On-target check horizon, ticks. */
  onTargetTicks: 150,
  // ---- error model (angular, rad)
  headerErrMin: 0.025,
  headerErrMax: 0.15,
  volleyErrMin: 0.03,
  volleyErrMax: 0.17,
  headerPassErrMin: 0.03,
  headerPassErrMax: 0.12,
  volleyPassErrMin: 0.03,
  volleyPassErrMax: 0.14,
  /** Multipliers: (1 + k x factor). */
  pressureErr: 0.6,
  balanceErr: 0.5,
  awkwardErr: 0.6,
  powerErr: 1.5,
  staminaErr: 0.5,
  /** Vertical error as a fraction of the horizontal error. */
  pitchErrFrac: 0.6,
  /** Fast incoming ball: awkwardness from this speed over this span, m/s. */
  fastBallFrom: 16,
  fastBallSpan: 14,
  /** Volley height above which the volley gets awkward (over volleyHighSpan), m. */
  volleyHighFrom: 0.9,
  volleyHighSpan: 0.4,
  // ---- duel
  wSkill: 0.3,
  wStrength: 0.2,
  wHeight: 0.25,
  wTiming: 0.15,
  wClose: 0.06,
  duelNoise: 0.06,
  /** When someone reaches the ball, players whose head / foot zone is within these extra margins of it (m)
   *  challenge for it too (horizontal / vertical). */
  duelMarginH: 0.45,
  duelMarginV: 0.3,
  /** Jump timing quality falls to 0 this many ticks off the peak. */
  timingScale: 8,
  /** Height + leap rating: head reach (standing head + max jump) from reachRef over reachSpan, m. */
  reachRef: 1.9,
  reachSpan: 0.7,
  /** Losers within this of the winner (jumping opponents) may stumble, m. */
  duelBodyDist: 1.4,
  /** Stumble chance = base + (winner strength - loser strength) / 98 x strScale, clamped to [min, max]. */
  stumbleBase: 0.5,
  stumbleStrScale: 0.8,
  stumbleMin: 0.15,
  stumbleMax: 0.85,
} as const; // TUNING-CR

/** SIM-12 tuning (read-only; tests and render use it). */
export const AERIAL_TUNING = LOCAL_TUNING;
const LT = LOCAL_TUNING;

/** actA flag bits. */
const F_CLEAR = 1;
const F_AI = 2;
const ASSIST_SHIFT = 2;
const G = T_BALL.gravity;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

/**
 * Prediction cache (pure derived data): sample k (the ball after k + 1 ticks from the ball state in PRED_KEY) lives at
 * index predBase + k, predLen valid samples, with the full kinematics so a later ball state can be matched to a
 * sample: a free ball in the sim IS the prediction bit for bit (SIM-02 ballStepTick), so while it flies untouched the
 * window just slides on and one new sample is integrated per tick. Any mismatch rebuilds it from scratch.
 */
const PCAP = 2 * LOCAL_TUNING.horizon + 8;
const QX = new Float64Array(PCAP);
const QY = new Float64Array(PCAP);
const QZ = new Float64Array(PCAP);
const QVX = new Float64Array(PCAP);
const QVY = new Float64Array(PCAP);
const QVZ = new Float64Array(PCAP);
const QSX = new Float64Array(PCAP);
const QSY = new Float64Array(PCAP);
const QSZ = new Float64Array(PCAP);
const QG = new Float64Array(PCAP);
const QB = new Float64Array(PCAP);
const QN = new Float64Array(PCAP);
const PRED_KEY = createBallState();
const TAIL = createBallState();
let predOk = 0;
let predBase = 0;
let predLen = 0;
/** Full prediction rebuilds so far (diagnostics for tests; never read by the sim). */
let predRebuilds = 0;
/** Comfort flag of the last sampleKind (a boolean: no boxing). */
let sampleComfy = false;
/** Elevation solver flight and on-target check balls. */
const FLY = createBallState();
const SIMB = createBallState();
const SOL = createLaunchSolution();
const LAUNCH = createKickLaunch();
/** Result of findAerial. */
const FIND = { idx: -1, header: 0, x: 0, y: 0, z: 0 };
/** Best AI candidate of a team. */
const BEST = { slot: -1, prio: 9, idx: 0, header: 0, x: 0, y: 0, z: 0, kind: 0, flags: 0, power: 0, dirX: 0, dirZ: 0 };
/** AI decision output. */
const AI = { kind: 0, flags: 0, power: 0, dirX: 0, dirZ: 0 };
/** Aim point at the goal line. */
const AIM = { x: 0, y: 0, z: 0 };
/** Contest candidates (slot, segment parameter, closeness). */
const CAND = new Int32Array(NS);
const CAND_T = new Float64Array(NS);
const CAND_Q = new Float64Array(NS);
/**
 * Scratch results of the geometry helpers, hit tests and the elevation solver (a typed array: storing doubles here
 * never boxes them, unlike returning them from calls or writing module-level lets in V8).
 */
const R = new Float64Array(8);
/** Standing head-centre height, max jump height, planned jump height, current jump height, head-centre height (m). */
const R_STAND = 0;
const R_MAXJ = 1;
const R_PLANJ = 2;
const R_JUMP = 3;
const R_HEADY = 4;
/** Hit test: segment parameter of the closest point, normalised distance (0..1). */
const R_HIT_T = 5;
const R_HIT_D = 6;
/** Speed actually used by the last elevation solve, m/s. */
const R_AIMV = 7;

// ---------------------------------------------------------------- small helpers

function attr01(v: number): number { return clamp01((v - 1) / 98); }
function absf(v: number): number { return v < 0 ? -v : v; }

/** R_STAND: standing head-centre height (attrs.height is cm; an unset block counts as 1.80 m); R_MAXJ: max jump. */
function bodyGeo(s: SimState, slot: number): void {
  const a = s.attrs[slot]!;
  const h = a.height;
  R[R_STAND] = (h > 100 && h < 250 ? h / 100 : 1.8) * LT.headFrac;
  let r = (LT.jumpHeadingW * a.heading + (1 - LT.jumpHeadingW) * a.agility - 1) / 98;
  if (!(r > 0)) r = 0;
  else if (r > 1) r = 1;
  R[R_MAXJ] = LT.jumpMin + (LT.jumpMax - LT.jumpMin) * r;
}

/** Ticks from take-off to the peak of a jump of height h. */
function upTicks(h: number): number {
  return h > 0 ? Math.round(Math.sqrt(2 * h / G) * HZ) : 0;
}

/** bodyGeo + R_PLANJ: planned jump height of a HEADER action (0 = standing / stooping header, or no header). */
function planJump(s: SimState, slot: number): void {
  bodyGeo(s, slot);
  const p = s.players[slot]!;
  const j = p.actCurve - R[R_STAND]!;
  const mj = R[R_MAXJ]!;
  R[R_PLANJ] = p.act === ActionKind.HEADER && j >= LT.minJump ? (j < mj ? j : mj) : 0;
}

function takeoffTick(contact: number, up: number): number {
  const t = contact - up;
  return t > 0 ? t : 0;
}

/** Tick (relative to the action start) of the landing of a HEADER jump; actContact when there is no jump. */
function landTick(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  planJump(s, slot);
  const j = R[R_PLANJ]!;
  if (j <= 0) return p.actContact;
  const up = upTicks(j);
  return takeoffTick(p.actContact, up) + 2 * up;
}

/** Tick (relative) of the jump peak, or actContact for standing headers and volleys. */
function peakTick(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  planJump(s, slot);
  const j = R[R_PLANJ]!;
  if (j <= 0) return p.actContact;
  const up = upTicks(j);
  return takeoffTick(p.actContact, up) + up;
}

/** planJump + R_JUMP (current jump height) and R_HEADY (head-centre height, following the jump / stoop). */
function headInto(s: SimState, slot: number): void {
  planJump(s, slot);
  const p = s.players[slot]!;
  const stand = R[R_STAND]!;
  const j = R[R_PLANJ]!;
  if (j > 0) {
    const up = upTicks(j);
    const t0 = takeoffTick(p.actContact, up);
    let y = 0;
    if (p.actT >= t0) {
      const dt = (p.actT - t0 - up) * TDT;
      y = j - 0.5 * G * dt * dt;
      if (y < 0) y = 0;
    }
    R[R_JUMP] = y;
    R[R_HEADY] = stand + y;
    return;
  }
  R[R_JUMP] = 0;
  if (p.act !== ActionKind.HEADER) { R[R_HEADY] = stand; return; }
  // Standing / stooping header: the head goes to the planned height by the contact tick.
  let f = p.actContact > 0 ? p.actT / p.actContact : 1;
  if (f > 1) f = 1;
  else if (f < 0) f = 0;
  R[R_HEADY] = stand + (p.actCurve - stand) * f;
}

/** Current jump height (m >= 0) of a player in a HEADER action (0 otherwise). For render and tests. Pure. */
export function aerialJumpHeight(s: SimState, slot: number): number {
  headInto(s, slot);
  return R[R_JUMP]!;
}

/** Current head-centre height (m) of a player: follows the jump / stoop of a HEADER action. Pure. */
export function aerialHeadY(s: SimState, slot: number): number {
  headInto(s, slot);
  return R[R_HEADY]!;
}

/** True if a team AI or the CPU brain drives this slot (never a human). */
function aiDriven(s: SimState, slot: number): boolean {
  const c = s.players[slot]!.ctrl;
  if (c < 0) return true;
  const ctl = s.ctrl[c];
  return ctl !== undefined && ctl.kind === ControllerKind.CPU;
}

function isAerialAct(a: ActionKind): boolean { return a === ActionKind.HEADER || a === ActionKind.VOLLEY; }

// ---------------------------------------------------------------- prediction

function sameBall(a: Readonly<BallState>, b: Readonly<BallState>): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.vx === b.vx && a.vy === b.vy && a.vz === b.vz &&
    a.sx === b.sx && a.sy === b.sy && a.sz === b.sz && a.grounded === b.grounded && a.bounces === b.bounces &&
    a.heldBy === b.heldBy && a.inNet === b.inNet && a.owner === b.owner;
}

function storeSample(i: number, b: Readonly<BallState>): void {
  QX[i] = b.x; QY[i] = b.y; QZ[i] = b.z;
  QVX[i] = b.vx; QVY[i] = b.vy; QVZ[i] = b.vz;
  QSX[i] = b.sx; QSY[i] = b.sy; QSZ[i] = b.sz;
  QG[i] = b.grounded; QB[i] = b.bounces; QN[i] = b.inNet;
}

function sampleIs(i: number, b: Readonly<BallState>): boolean {
  return QX[i] === b.x && QY[i] === b.y && QZ[i] === b.z && QVX[i] === b.vx && QVY[i] === b.vy && QVZ[i] === b.vz &&
    QSX[i] === b.sx && QSY[i] === b.sy && QSZ[i] === b.sz && QG[i] === b.grounded && QB[i] === b.bounces &&
    QN[i] === b.inNet;
}

/** Integrate TAIL on until the window holds LT.horizon samples. */
function extendPrediction(): void {
  while (predLen < LT.horizon) {
    ballStepTick(TAIL, null);
    storeSample(predBase + predLen, TAIL);
    predLen++;
  }
}

/** Predict the current ball LT.horizon ticks ahead into the window (memoised along the free flight; pure). */
function ensurePrediction(b: Readonly<BallState>): void {
  if (predOk === 1) {
    if (sameBall(PRED_KEY, b)) return;
    for (let j = 0; j < LT.predictSlide && j < predLen; j++) {
      if (!sampleIs(predBase + j, b) || b.owner !== PRED_KEY.owner || b.heldBy !== PRED_KEY.heldBy) continue;
      predBase += j + 1;
      predLen -= j + 1;
      if (predBase + LT.horizon > PCAP) {
        // Compact: move the live window to the front.
        for (let k = 0; k < predLen; k++) {
          const i = predBase + k;
          QX[k] = QX[i]!; QY[k] = QY[i]!; QZ[k] = QZ[i]!;
          QVX[k] = QVX[i]!; QVY[k] = QVY[i]!; QVZ[k] = QVZ[i]!;
          QSX[k] = QSX[i]!; QSY[k] = QSY[i]!; QSZ[k] = QSZ[i]!;
          QG[k] = QG[i]!; QB[k] = QB[i]!; QN[k] = QN[i]!;
        }
        predBase = 0;
      }
      copyBallState(PRED_KEY, b);
      extendPrediction();
      return;
    }
  }
  copyBallState(PRED_KEY, b);
  copyBallState(TAIL, b);
  predBase = 0;
  predLen = 0;
  extendPrediction();
  predOk = 1;
  predRebuilds++;
}

/** Number of full prediction rebuilds so far (diagnostics: the memo must slide along a free flight). */
export function aerialPredictionRebuilds(): number { return predRebuilds; }

/** Ball loose, in flight, in play, not in a net, and not just played by `slot`. */
function aerialBall(s: SimState, slot: number): boolean {
  const b = s.ball;
  if (s.match.phase !== MatchPhase.IN_PLAY) return false;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return false;
  if (b.grounded === 1) return false;
  if (b.lastTouch === slot && s.tick - b.lastTouchTick < LT.retouchTicks) return false;
  return true;
}

/** Per-call constants of findAerial (typed array: the per-sample helpers take no double arguments). */
const FA = new Float64Array(11);
const FA_STAND = 0;
const FA_MJ = 1;
const FA_VJ = 2;
const FA_TUP = 3;
const FA_PREF_TOP = 4;
const FA_PREF_LOW = 5;
const FA_TOP = 6;
const FA_ACC = 7;
const FA_SP0 = 8;
const FA_TX = 9;
const FA_TZ = 10;

/**
 * Window test of predicted sample i for slot (findAerial constants in FA): 1 = header, 2 = volley, 0 = neither;
 * -1 = the ball is out of play from here on. Sets the comfort flag sampleComfy.
 */
function sampleKind(i: number, mode: number): number {
  const k = predBase + i;
  const x = QX[k]!;
  const z = QZ[k]!;
  if (x > HL + BR || x < -HL - BR || z > HW + BR || z < -HW - BR) return -1;
  const y = QY[k]!;
  if ((mode & 1) !== 0 && y >= LT.headerMinY) {
    const t = (i + 1) * TDT;
    const mj = FA[FA_MJ]!;
    const vj = FA[FA_VJ]!;
    let hi = FA[FA_STAND]! + (t >= FA[FA_TUP]! ? mj : vj * t - 0.5 * G * t * t) + LT.headReachV;
    if (hi > LT.headerMaxY) hi = LT.headerMaxY;
    if (y <= hi) {
      sampleComfy = y <= FA[FA_PREF_TOP]! && y >= FA[FA_PREF_LOW]!;
      return 1;
    }
  }
  if ((mode & 2) !== 0 && y >= LT.volleyMinY && y <= LT.volleyMaxY) {
    sampleComfy = y <= LT.volleyComfortY;
    return 2;
  }
  return 0;
}

/**
 * Can slot get his body to predicted sample i in time for a header (kind 1) or volley (2)? Trivially yes from
 * (nearly) standing at a cautious acceleration; no when even the current speed plus full acceleration (capped at
 * top speed) falls short; otherwise the reach estimate (reachTicks) decides.
 */
function sampleReachable(s: SimState, slot: number, i: number, kind: number): boolean {
  const p = s.players[slot]!;
  const k = predBase + i;
  const dx = QX[k]! - p.x;
  const dz = QZ[k]! - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const need = d - (kind === 1 ? LT.headLean + LT.headSlack : LT.footFwd + LT.footSlack);
  if (need <= 0) return true;
  const t = (i + 1) * TDT;
  const sp0 = FA[FA_SP0]!;
  const acc = FA[FA_ACC]!;
  if (sp0 < LT.standSpeed && need <= 0.5 * LT.cautiousAccelFrac * acc * t * t) return true;
  let dmax = sp0 * t + 0.5 * acc * t * t;
  const vt = FA[FA_TOP]! * t;
  if (dmax > vt) dmax = vt;
  if (need > dmax + ARRIVE_STOP) return false;
  FA[FA_TX] = p.x + dx / d * need;
  FA[FA_TZ] = p.z + dz / d * need;
  return reachTicks(s, slot) <= i + 1 + LT.reachTickSlack;
}

/**
 * Ticks for slot to reach (FA_TX, FA_TZ) at full sprint: SIM-04 ticksToReach's model (pivot or braking turn, two-phase
 * acceleration, cruise; stamina), mirrored inline so the hot scan makes no calls with double arguments (V8 boxes
 * those). A calibration test keeps it in step with SIM-04 ticksToReach. Mirrored constants: LT.reach*.
 */
function reachTicks(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const dx = FA[FA_TX]! - p.x;
  const dz = FA[FA_TZ]! - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > ARRIVE_STOP)) return 0;
  const st = p.stamina;
  const sf = st < ST_LOW ? ST_FLOOR + (1 - ST_FLOOR) * (st > 0 ? st / ST_LOW : 0) : 1;
  const vmax = (a.topSpeed > 0 ? a.topSpeed : TOP_MIN) * sf;
  const vj = vmax * JOG_FRAC;
  const acc = (a.accel > 0 ? a.accel : ACC_MIN) * sf;
  const ux = dx / d;
  const uz = dz / d;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  let dist = d - ARRIVE_STOP;
  let t = 0;
  let v = 0;
  if (sp >= LT.reachMoveEps) {
    const c = (p.vx * ux + p.vz * uz) / sp;
    if (c >= LT.reachTurnCos) {
      v = sp * c;
    } else {
      // acos (Abramowitz-Stegun 4.4.45, as SIM-04), turn at the braked turning speed, progress and drift of the arc.
      const ac = c < 0 ? (c < -1 ? 1 : -c) : c;
      const r = Math.sqrt(1 - ac) * (1.5707288 + ac * (-0.2121144 + ac * (0.0742610 - 0.0187293 * ac)));
      const ang = c < 0 ? PI - r : r;
      const vTurn = sp * (LT.reachTurnSpeedA + LT.reachTurnSpeedB * c);
      let agi = (a.agility - 1) / 98;
      agi = agi < 0 ? 0 : agi > 1 ? 1 : agi;
      let f = vTurn / (a.topSpeed > 0 ? a.topSpeed : TOP_MIN);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const w = (T_TURN_SLOW + (T_TURN_FAST - T_TURN_SLOW) * f) * (1 + T_AGI_TURN * (2 * agi - 1)) * T_SPRINT_TURN;
      const tt = ang / w;
      t += tt;
      const sinA = Math.sqrt((1 - c) * (1 + c));
      const path = vTurn * tt / ang;
      const prog = path * (sinA - LT.reachTurnBack * (1 - c) * ang);
      const side = path * (1 - c) * LT.reachTurnSide;
      const rest = dist > prog ? dist - prog : 0;
      dist = Math.sqrt(rest * rest + side * side);
      let vEnd = sp * (LT.reachTurnEndA + LT.reachTurnEndB * c) + acc * tt * LT.reachTurnAccel;
      const vHi = sp > vmax ? sp : vmax;
      if (vEnd > vHi) vEnd = vHi;
      v = vEnd;
    }
  }
  if (dist > 0) {
    // Run: braking down to vmax when faster, accel to jog, accel x highSpeedAccelMul to vmax, cruise.
    let rd = dist;
    let done = false;
    if (v > vmax) {
      const need = (v * v - vmax * vmax) / (2 * T_DECEL);
      if (rd <= need) { t += (v - Math.sqrt(v * v - 2 * T_DECEL * rd)) / T_DECEL; done = true; }
      else { t += (v - vmax) / T_DECEL; rd -= need; v = vmax; }
    }
    for (let phase = 0; phase < 2 && !done; phase++) {
      const v1 = phase === 0 ? (vj < vmax ? vj : vmax) : vmax;
      const aa = phase === 0 ? acc : acc * LT.reachHighSpeedAccelMul;
      if (v >= v1 || aa <= 0) continue;
      const need = (v1 * v1 - v * v) / (2 * aa);
      if (rd <= need) { t += (Math.sqrt(v * v + 2 * aa * rd) - v) / aa; done = true; }
      else { t += (v1 - v) / aa; rd -= need; v = v1; }
    }
    if (!done) t += rd / vmax;
  }
  return Math.ceil(t * HZ);
}

/** The reach estimate of the aerial search: ticks for slot to reach (x, z) at full sprint. Tests / tools. Pure. */
export function aerialReachTicks(s: SimState, slot: number, x: number, z: number): number {
  FA[FA_TX] = x;
  FA[FA_TZ] = z;
  return reachTicks(s, slot);
}

function setFind(i: number, kind: number): void {
  const k = predBase + i;
  FIND.idx = i;
  FIND.header = kind === 1 ? 1 : 0;
  FIND.x = QX[k]!;
  FIND.y = QY[k]!;
  FIND.z = QZ[k]!;
}

/**
 * The predicted sample `slot` should play: among the samples he can head (mode bit 1) or volley (bit 2) in time,
 * the first COMFORTABLE one up to comfortLimit (header: the ball at most LT.comfortJumpFrac of his max jump above his
 * standing head and not below a deep stoop; volley: at most LT.volleyComfortY high), else the earliest playable one;
 * nothing at all when no sample up to firstLimit is playable. Comfortable samples are tried first, so the reach
 * estimate usually runs once or twice. Needs ensurePrediction first. Writes FIND (FIND.idx: the contact is
 * after idx + 1 ticks); false if nothing is playable.
 */
function findAerial(s: SimState, slot: number, mode: number, firstLimit: number, comfortLimit: number): boolean {
  const p = s.players[slot]!;
  bodyGeo(s, slot);
  const stand = R[R_STAND]!;
  const mj = R[R_MAXJ]!;
  const vj = Math.sqrt(2 * G * mj);
  const a = s.attrs[slot]!;
  FA[FA_STAND] = stand;
  FA[FA_MJ] = mj;
  FA[FA_VJ] = vj;
  FA[FA_TUP] = vj / G;
  FA[FA_PREF_TOP] = stand + LT.comfortJumpFrac * mj;
  FA[FA_PREF_LOW] = stand - LT.stoopComfort;
  FA[FA_TOP] = a.topSpeed > 0 ? a.topSpeed : TOP_MIN;
  FA[FA_ACC] = a.accel > 0 ? a.accel : ACC_MIN;
  FA[FA_SP0] = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const n = predLen;
  // Pass 1: the first comfortable playable sample.
  let c = -1;
  let cKind = 0;
  const n1 = comfortLimit + 1 < n ? comfortLimit + 1 : n;
  for (let i = 0; i < n1; i++) {
    const kind = sampleKind(i, mode);
    if (kind < 0) break;
    if (kind === 0 || !sampleComfy || !sampleReachable(s, slot, i, kind)) continue;
    c = i;
    cKind = kind;
    break;
  }
  if (c >= 0 && c <= firstLimit) { setFind(c, cKind); return true; }
  // Pass 2: the earliest playable sample up to firstLimit (before c): the fallback, or proof that something is
  // playable soon enough when the comfortable one comes later.
  const n2 = firstLimit + 1 < n ? firstLimit + 1 : n;
  for (let i = 0; i < n2; i++) {
    const kind = sampleKind(i, mode);
    if (kind < 0) break;
    if (kind === 0 || !sampleReachable(s, slot, i, kind)) continue;
    if (c >= 0) setFind(c, cKind);
    else setFind(i, kind);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- chance and starts

/**
 * True if the ball is a sensible header (h) or volley (v) chance for slot in the next few ticks. Pure.
 * Returns 1 = header, 2 = volley, 0 = none (the sample he would play decides; see findAerial).
 */
export function aerialChance(s: SimState, slot: number): number {
  if (slot < 0 || slot >= NS) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || !aerialBall(s, slot)) return 0;
  ensurePrediction(s.ball);
  if (!findAerial(s, slot, 3, LT.chanceTicks, LT.horizon)) return 0;
  return FIND.header === 1 ? 1 : 2;
}

/**
 * Planned contact spot (ball position at the contact) of the aerial chance `slot` would play now, into out; returns
 * 1 = header, 2 = volley, 0 = none (out untouched). For receiver movement under a high ball (SIM-15 meetPoint, TAI
 * receivers): walk to this spot instead of the ball's ground track. Pure.
 */
export function aerialSpot(s: SimState, slot: number, out: { x: number; z: number }): number {
  const c = aerialChance(s, slot);
  if (c === 0) return 0;
  out.x = FIND.x;
  out.z = FIND.z;
  return c;
}

/**
 * Begin a HEADER / VOLLEY attempt against the FIND sample (contact after idx + 1 ticks, shifted by timingErr for
 * the AI jump timing). Writes every action field the handler and solvers read.
 */
function beginAerial(
  s: SimState, slot: number, act: ActionKind, kind: KickKind, power: number, dirX: number, dirZ: number,
  target: number, flags: number, timingErr: number,
): void {
  const p = s.players[slot]!;
  const lead = FIND.idx + 1;
  let contact = lead + timingErr;
  if (contact < 1) contact = 1;
  let planned = FIND.y;
  let dur: number;
  if (act === ActionKind.HEADER) {
    bodyGeo(s, slot);
    const stand = R[R_STAND]!;
    const need = FIND.y - stand;
    if (need < LT.minJump) {
      planned = FIND.y > LT.stoopMinHead ? FIND.y : LT.stoopMinHead;
      if (planned >= stand + LT.minJump) planned = stand;
      dur = contact + LT.lateTicks + LT.missRecovery;
    } else {
      const mj = R[R_MAXJ]!;
      let j = need < mj ? need : mj;
      if (upTicks(j) > lead) {
        // Late press: take off now with the speed that meets the ball at its arrival (as high as he can).
        const t = lead * TDT;
        const v = (need + 0.5 * G * t * t) / t;
        const j2 = v * v / (2 * G);
        j = j2 < mj ? j2 : mj;
      }
      if (j < LT.minJump) j = LT.minJump;
      planned = stand + j;
      const up = upTicks(j);
      const land = takeoffTick(contact, up) + 2 * up;
      const winEnd = contact + LT.lateTicks;
      dur = (land > winEnd ? land : winEnd) + LT.missRecovery;
    }
  } else {
    dur = contact + LT.lateTicks + LT.missRecovery;
  }
  beginAction(p, act, dur, contact);
  p.actKick = kind;
  p.actPower = clamp01(power);
  p.actDirX = dirX;
  p.actDirZ = dirZ;
  p.actSlot = target;
  p.actX = FIND.x;
  p.actZ = FIND.z;
  p.actCurve = planned;
  p.actA = flags;
  p.actB = s.ball.lastTouchTick;
  p.lookAt = 0;
}

/** Shared validation + planning of a human / CPU-brain request (extra = actA flag bits, e.g. F_CLEAR). */
function startAerial(
  s: SimState, slot: number, act: ActionKind, kind: KickKind, req: ActionRequest, extra: number,
): number {
  if (slot < 0 || slot >= NS) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !aerialBall(s, slot)) return 0;
  ensurePrediction(s.ball);
  if (!findAerial(s, slot, act === ActionKind.HEADER ? 1 : 2, LT.horizon, LT.horizon)) return 0;
  let dx = req.dirX;
  let dz = req.dirZ;
  if (req.hasTarget === 1) {
    dx = req.targetX - p.x;
    dz = req.targetZ - p.z;
  }
  let l = Math.sqrt(dx * dx + dz * dz);
  if (!(l > 1e-6) || !(l < Infinity)) { dx = 0; dz = 0; l = 0; }
  if (l > 0) { dx /= l; dz /= l; }
  let assist = req.assist;
  if (!(assist >= AssistLevel.ASSISTED && assist <= AssistLevel.MANUAL)) assist = AssistLevel.ASSISTED;
  const target = req.targetSlot >= 0 && req.targetSlot < NS ? req.targetSlot : -1;
  const power = req.power === req.power ? req.power : 0.5;
  beginAerial(s, slot, act, kind, power, dx, dz, target, ((assist & 3) << ASSIST_SHIFT) | extra, 0);
  return 1;
}

/** Start a HEADER (HEADER_SHOT / HEADER_PASS) under a dropping ball. Returns 1 if started. */
export function startHeader(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (kind !== KickKind.HEADER_SHOT && kind !== KickKind.HEADER_PASS) return 0;
  return startAerial(s, slot, ActionKind.HEADER, kind, req, 0);
}

/** Start a VOLLEY (VOLLEY_SHOT / VOLLEY_PASS) of a ball in the volley window. Returns 1 if started. */
export function startVolley(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (kind !== KickKind.VOLLEY_SHOT && kind !== KickKind.VOLLEY_PASS) return 0;
  return startAerial(s, slot, ActionKind.VOLLEY, kind, req, 0);
}

/**
 * Start a headed or volleyed CLEARANCE (HEADER_PASS / VOLLEY_PASS with the clearance flag: high and long, away from
 * goal), whichever the ball offers (aerialChance). For SIM-14 startClearance when the ball to clear is in the air.
 * Returns 1 if started.
 */
export function startAerialClearance(s: SimState, slot: number, req: ActionRequest, ev: EventSink): number {
  const c = aerialChance(s, slot);
  if (c === 1) return startAerial(s, slot, ActionKind.HEADER, KickKind.HEADER_PASS, req, F_CLEAR);
  if (c === 2) return startAerial(s, slot, ActionKind.VOLLEY, KickKind.VOLLEY_PASS, req, F_CLEAR);
  return 0;
}

// ---------------------------------------------------------------- handler

/** End the attempt without a contact (miss or abort): recovery after the landing of a jump. */
function finishAttempt(s: SimState, slot: number, abort: boolean): void {
  const p = s.players[slot]!;
  p.actDone = 1;
  p.actCharging = 0;
  const land = landTick(s, slot);
  const base = land > p.actT ? land : p.actT;
  const d = base + (abort ? LT.abortRecovery : LT.missRecovery);
  if (d < p.actDur) p.actDur = d;
  if (p.actDur < p.actT) p.actDur = p.actT;
}

/** The attempt made contact: recovery (after the landing of a jump). */
function contactDone(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.actDone = 1;
  p.actCharging = 0;
  let d = p.actT + (p.act === ActionKind.HEADER ? LT.headerRecovery : LT.volleyRecovery);
  const land = landTick(s, slot) + LT.landSettle;
  if (land > d) d = land;
  p.actDur = d;
}

function settle(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.moveMode = MoveMode.STOP;
  p.wantSprint = 0;
  p.lookAt = 0;
  p.ix = 0;
  p.iz = 0;
}

/**
 * Approach: run at the time-to-go speed (distance left / ticks to the contact x LT.approachHurry) toward the point
 * LT.headLean / LT.footFwd short of the spot. SIM-04 ARRIVE is aimed LT.approachOvershoot beyond that point while
 * the player is more than LT.approachNear from it, so its arrival braking does not slow the run (he meets the ball on
 * the move); near it ARRIVE settles him onto it; on it he holds, facing the ball.
 */
function approach(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const off = p.act === ActionKind.HEADER ? LT.headLean : LT.footFwd;
  const dx = p.actX - p.x;
  const dz = p.actZ - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const need = d - off;
  p.moveMode = MoveMode.ARRIVE;
  if (!(need > LT.approachEps)) {
    p.tgtX = p.x;
    p.tgtZ = p.z;
    p.tgtSpeed = 0;
    p.wantSprint = 0;
    p.lookAt = 1;
    p.lookX = b.x;
    p.lookZ = b.z;
    return;
  }
  const a = s.attrs[slot]!;
  // SIM-04 staminaFactor, inlined (no double crosses a call).
  const st = p.stamina;
  const sf = st < ST_LOW ? ST_FLOOR + (1 - ST_FLOOR) * (st > 0 ? st / ST_LOW : 0) : 1;
  const top = (a.topSpeed > 0 ? a.topSpeed : TOP_MIN) * sf;
  let go = p.actContact - p.actT;
  if (go < 1) go = 1;
  let sp = LT.approachHurry * need / (go * TDT);
  if (sp < LT.approachMinSpeed && need > LT.approachNear) sp = LT.approachMinSpeed;
  if (sp > top) sp = top;
  const ux = dx / d;
  const uz = dz / d;
  // Far: overshoot the ARRIVE target so its braking does not slow the run. Near: settle onto the point.
  const over = need > LT.approachNear ? LT.approachOvershoot : 0;
  p.tgtX = p.x + ux * (need + over);
  p.tgtZ = p.z + uz * (need + over);
  p.tgtSpeed = sp;
  p.wantSprint = sp > top * JOG_FRAC ? 1 : 0;
  p.lookAt = 0;
}

function aerialUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  if (p.actDone === 0) {
    if (b.lastTouchTick !== p.actB || b.owner >= 0 || b.heldBy >= 0 || s.match.phase !== MatchPhase.IN_PLAY) {
      finishAttempt(s, slot, true);
    } else if (p.actT > p.actContact + LT.lateTicks) {
      finishAttempt(s, slot, false);
    }
  }
  // The power bar stops filling when the window opens: the ball does not wait.
  if (p.actCharging === 1 && (p.actDone === 1 || p.actT >= p.actContact - LT.earlyTicks)) p.actCharging = 0;
  if (p.actDone === 0) approach(s, slot);
  else settle(s, slot);
}

function aerialEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  p.wantSprint = 0;
  p.lookAt = 0;
  if (p.moveMode === MoveMode.ARRIVE || p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

// ---------------------------------------------------------------- contact tests

/**
 * Header: does the ball's swept segment this tick pass inside the head ellipsoid grown by (mh, mv) m? Sets R_HIT_T
 * (segment parameter of the closest point) and R_HIT_D (normalised distance 0..1) when it does.
 */
function headerHit(s: SimState, slot: number, mh: number, mv: number): boolean {
  const p = s.players[slot]!;
  const b = s.ball;
  let fx = p.fx;
  let fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-9) { fx /= fl; fz /= fl; } else { fx = 0; fz = 0; }
  const rh = LT.headReachH + mh;
  const k = rh / (LT.headReachV + mv);
  const hx = p.x + fx * LT.headLean;
  headInto(s, slot);
  const hy = R[R_HEADY]! * k;
  const hz = p.z + fz * LT.headLean;
  const ax = b.px;
  const ay = b.py * k;
  const az = b.pz;
  const dx = b.x - ax;
  const dy = b.y * k - ay;
  const dz = b.z - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (l2 > 0) {
    t = ((hx - ax) * dx + (hy - ay) * dy + (hz - az) * dz) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const cx = ax + dx * t - hx;
  const cy = ay + dy * t - hy;
  const cz = az + dz * t - hz;
  const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (!(d <= rh)) return false;
  R[R_HIT_T] = t;
  R[R_HIT_D] = d / rh;
  return true;
}

/**
 * Volley: does the ball's segment pass inside the foot zone grown by mh (the ball inside the volley band grown by
 * mv)? Sets R_HIT_T and R_HIT_D (normalised horizontal distance 0..1) when it does.
 */
function volleyHit(s: SimState, slot: number, mh: number, mv: number): boolean {
  const p = s.players[slot]!;
  const b = s.ball;
  let fx = p.fx;
  let fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-9) { fx /= fl; fz /= fl; } else { fx = 0; fz = 0; }
  const footX = p.x + fx * LT.footFwd;
  const footZ = p.z + fz * LT.footFwd;
  const ax = b.px;
  const az = b.pz;
  const dx = b.x - ax;
  const dz = b.z - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > 0) {
    t = ((footX - ax) * dx + (footZ - az) * dz) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const cx = ax + dx * t - footX;
  const cz = az + dz * t - footZ;
  const d = Math.sqrt(cx * cx + cz * cz);
  const rh = LT.footReachH + mh;
  if (!(d <= rh)) return false;
  const y = b.py + (b.y - b.py) * t;
  const slack = LT.footBandSlack + mv;
  if (y < LT.volleyMinY - slack || y > LT.volleyMaxY + slack) return false;
  R[R_HIT_T] = t;
  R[R_HIT_D] = d / rh;
  return true;
}

/** An open attempt of slot on this flight whose contact window includes this tick. */
function windowOpen(s: SimState, slot: number, flight: number): boolean {
  const p = s.players[slot]!;
  if (p.active !== 1 || p.actDone !== 0 || !isAerialAct(p.act) || p.actB !== flight) return false;
  return p.actT >= p.actContact - LT.earlyTicks && p.actT <= p.actContact + LT.lateTicks;
}

/** Duel score of a contestant (no noise). */
function duelScore(s: SimState, slot: number, close: number): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const header = p.act === ActionKind.HEADER;
  const skill = header ? attr01(a.heading) : attr01((a.finishing + a.ballControl) * 0.5);
  bodyGeo(s, slot);
  const reach = header ? clamp01((R[R_STAND]! + R[R_MAXJ]! - LT.reachRef) / LT.reachSpan) : 0.5;
  const off = p.actT - peakTick(s, slot);
  const timing = clamp01(1 - absf(off) / LT.timingScale);
  return LT.wSkill * skill + LT.wStrength * attr01(a.strength) + LT.wHeight * reach + LT.wTiming * timing +
    LT.wClose * close;
}

/** Put a beaten jumper on his heels (SIM-14 knockDown; same effect via the dispatcher while SIM-14 is a stub). */
function stumble(s: SimState, slot: number, ev: EventSink): void {
  knockDown(s, slot, ActionKind.STUMBLE, ev);
  const p = s.players[slot]!;
  if (p.act === ActionKind.HEADER || p.act === ActionKind.VOLLEY) {
    endAction(s, slot, 1);
    beginAction(p, ActionKind.STUMBLE, T_TACKLE.stumbleTicks, -1);
  }
}

/** Resolve this tick's header / volley contacts (at most one). */
function resolveContacts(s: SimState, ev: EventSink): void {
  const b = s.ball;
  const flight = b.lastTouchTick;
  // Does anyone reach the ball this tick?
  let any = false;
  for (let slot = 0; slot < NS && !any; slot++) {
    if (!windowOpen(s, slot, flight)) continue;
    any = s.players[slot]!.act === ActionKind.HEADER ? headerHit(s, slot, 0, 0) : volleyHit(s, slot, 0, 0);
  }
  // Everyone challenging for it (within the duel margins) contests it; two or more challengers make a 50-50 duel
  // even when their bodies keep both just short of a clean contact.
  let n = 0;
  for (let slot = 0; slot < NS; slot++) {
    if (!windowOpen(s, slot, flight)) continue;
    const p = s.players[slot]!;
    const hit = p.act === ActionKind.HEADER ? headerHit(s, slot, LT.duelMarginH, LT.duelMarginV) :
      volleyHit(s, slot, LT.duelMarginH, LT.duelMarginV);
    if (!hit) continue;
    CAND[n] = slot;
    CAND_T[n] = R[R_HIT_T]!;
    CAND_Q[n] = 1 - R[R_HIT_D]!;
    n++;
  }
  if (n === 0 || (!any && n < 2)) return;
  let w = 0;
  if (n > 1) {
    let best = -1e9;
    for (let i = 0; i < n; i++) {
      const sc = duelScore(s, CAND[i]!, CAND_Q[i]!) + LT.duelNoise * rngGauss(s.rng);
      if (sc > best) { best = sc; w = i; }
    }
  }
  const winner = CAND[w]!;
  const t = CAND_T[w]!;
  const cx = b.px + (b.x - b.px) * t;
  const cy = b.py + (b.y - b.py) * t;
  const cz = b.pz + (b.z - b.pz) * t;
  if (b.cross !== CrossKind.NONE) {
    // The ball is played before the line: undo this tick's crossing; wholly over already: out of play, no contact.
    if (cx > HL + BR || cx < -HL - BR || cz > HW + BR ||
      cz < -HW - BR) return;
    b.cross = CrossKind.NONE;
    b.crossX = 0;
    b.crossZ = 0;
    b.crossEnd = 0;
  }
  const wp = s.players[winner]!;
  const header = wp.act === ActionKind.HEADER;
  b.x = cx;
  b.y = cy > BR ? cy : BR;
  b.z = cz;
  const ok = header ? solveHeaderImpl(s, winner, LAUNCH) : solveVolleyImpl(s, winner, LAUNCH);
  if (ok === 1) {
    ev.emit(EventType.AERIAL, winner, header ? 1 : 0, 0, 0, b.x, b.y, b.z);
    applyKick(s, winner, LAUNCH, wp.actPower, ev);
    if (b.y > BR + 1e-6) b.grounded = 0;
    contactDone(s, winner);
  } else {
    finishAttempt(s, winner, false);
  }
  // Every other attempt on this flight is over (no double contact); jumping opponents beside the winner may stumble.
  for (let k = 0; k < NS; k++) {
    if (k === winner) continue;
    const q = s.players[k]!;
    if (q.active !== 1 || q.actDone !== 0 || !isAerialAct(q.act) || q.actB !== flight) continue;
    let jumping = false;
    if (q.act === ActionKind.HEADER) { headInto(s, k); jumping = R[R_JUMP]! > 0; }
    const dx = q.x - wp.x;
    const dz = q.z - wp.z;
    const beaten = ok === 1 && q.team !== wp.team && jumping && dx * dx + dz * dz <= LT.duelBodyDist * LT.duelBodyDist;
    finishAttempt(s, k, true);
    if (beaten) {
      const sw = s.attrs[winner]!.strength;
      const sl = s.attrs[k]!.strength;
      let ch = LT.stumbleBase + (sw - sl) / 98 * LT.stumbleStrScale;
      if (ch < LT.stumbleMin) ch = LT.stumbleMin;
      else if (ch > LT.stumbleMax) ch = LT.stumbleMax;
      if (rngChance(s.rng, ch)) stumble(s, k, ev);
    }
  }
}

// ---------------------------------------------------------------- AI attempts

/** True if a player of `team` already has an open attempt on this flight. */
function teamAttempting(s: SimState, team: number, flight: number): boolean {
  const first = team === 0 ? 0 : NS / 2;
  for (let i = first; i < first + NS / 2; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && isAerialAct(p.act) && p.actDone === 0 && p.actB === flight) return true;
  }
  return false;
}

/** An opponent of slot's team within LT.contestRadius of (x, z). */
function contested(s: SimState, slot: number, x: number, z: number): boolean {
  const team = s.players[slot]!.team;
  const r2 = LT.contestRadius * LT.contestRadius;
  for (let i = 0; i < NS; i++) {
    const q = s.players[i]!;
    if (q.active !== 1 || q.team === team) continue;
    const dx = q.x - x;
    const dz = q.z - z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

/** AI decision for the FIND chance of slot: fills AI (kind NONE = leave it to first touch). */
function aiChoose(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const dir = s.teams[p.team]!.dir;
  const toAttack = HL - dir * p.x;
  const toOwn = HL + dir * p.x;
  const az = absf(p.z);
  const ours = b.lastTouchTeam === p.team;
  const inShoot = toAttack <= LT.aiShotRange && az <= LT.aiShotHalfWidth;
  AI.kind = KickKind.NONE;
  AI.flags = F_AI;
  AI.power = LT.aiPassPower;
  AI.dirX = 0;
  AI.dirZ = 0;
  if (FIND.header === 1) {
    if (inShoot) {
      AI.kind = KickKind.HEADER_SHOT;
      AI.power = LT.aiShotPower;
    } else if (!ours && toOwn <= LT.aiClearDepth) {
      AI.kind = KickKind.HEADER_PASS;
      AI.flags |= F_CLEAR;
      AI.power = LT.aiClearPower;
    } else if (contested(s, slot, FIND.x, FIND.z) || (FIND.y > T_TOUCH.trapHeight && !ours)) {
      // [INT-A head tennis] Our own uncontested ball is left to drop to chest / feet (SIM-07 first touch) instead of
      // being headed on into another aerial ball; an opponent's high ball or any contested one is still headed.
      AI.kind = KickKind.HEADER_PASS;
    }
  } else if (inShoot) {
    AI.kind = KickKind.VOLLEY_SHOT;
    AI.power = LT.aiShotPower;
  } else if (!ours && toOwn <= LT.aiVolleyClearDepth && az <= PAHW) {
    AI.kind = KickKind.VOLLEY_PASS;
    AI.flags |= F_CLEAR;
    AI.power = LT.aiClearPower;
  }
  if (AI.kind === KickKind.HEADER_PASS || AI.kind === KickKind.VOLLEY_PASS) {
    if ((AI.flags & F_CLEAR) !== 0) {
      // Away from goal and toward the near touchline.
      const side = b.z >= 0 ? 1 : -1;
      const l = Math.sqrt(1 + 0.36);
      AI.dirX = dir / l;
      AI.dirZ = side * 0.6 / l;
    } else {
      AI.dirX = dir;
      AI.dirZ = 0;
    }
  }
}

/** AI-driven players attack aerial balls that reach them (one attempt per team per flight). */
function aiStarts(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (b.grounded === 1 || b.inNet !== 0 || b.owner >= 0 || b.heldBy >= 0) return;
  const hs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  const range = hs * (LT.aiLeadTicks + 1) * TDT + LT.aiScanRadius;
  const r2 = range * range;
  const flight = b.lastTouchTick;
  const pt = b.passTarget;
  const ptTeam = pt >= 0 && pt < NS ? s.players[pt]!.team : -1;
  let predicted = false;
  for (let team = 0; team < 2; team++) {
    // Staggered: each team looks every LT.aiScanEvery ticks (a tick or two later is never too late), at all its
    // players at once so the best placed one (pass target / chaser first, then the earliest contact) is chosen.
    if ((s.tick + team) % LT.aiScanEvery !== 0) continue;
    if (teamAttempting(s, team, flight)) continue;
    BEST.slot = -1;
    BEST.prio = 9;
    const first = team === 0 ? 0 : NS / 2;
    for (let slot = first; slot < first + NS / 2; slot++) {
      const p = s.players[slot]!;
      if (p.isKeeper === 1 || !isFree(p) || !aiDriven(s, slot)) continue;
      if (b.lastTouch === slot && s.tick - b.lastTouchTick < LT.retouchTicks) continue;
      // A teammate's pass to someone else: leave it to him.
      if (ptTeam === team && pt !== slot && b.lastTouchTeam === team) continue;
      const dx = b.x - p.x;
      const dz = b.z - p.z;
      if (dx * dx + dz * dz > r2) continue;
      if (!predicted) { ensurePrediction(b); predicted = true; }
      if (!findAerial(s, slot, 3, LT.aiLeadTicks, LT.aiLeadTicks + LT.aiComfortWait)) continue;
      if (FIND.idx > LT.aiLeadTicks) continue;
      aiChoose(s, slot);
      if (AI.kind === KickKind.NONE) continue;
      const prio = slot === pt || slot === s.teams[team]!.chaser ? 0 : 1;
      if (prio > BEST.prio || (prio === BEST.prio && FIND.idx >= BEST.idx)) continue;
      BEST.slot = slot;
      BEST.prio = prio;
      BEST.idx = FIND.idx;
      BEST.header = FIND.header;
      BEST.x = FIND.x;
      BEST.y = FIND.y;
      BEST.z = FIND.z;
      BEST.kind = AI.kind;
      BEST.flags = AI.flags;
      BEST.power = AI.power;
      BEST.dirX = AI.dirX;
      BEST.dirZ = AI.dirZ;
    }
    if (BEST.slot < 0) continue;
    const slot = BEST.slot;
    FIND.idx = BEST.idx;
    FIND.header = BEST.header;
    FIND.x = BEST.x;
    FIND.y = BEST.y;
    FIND.z = BEST.z;
    const errMax = LT.aiTimingErrMax * (1 - attr01(s.attrs[slot]!.heading));
    const err = Math.round(rngRange(s.rng, -1, 1) * errMax);
    const act = BEST.header === 1 ? ActionKind.HEADER : ActionKind.VOLLEY;
    beginAerial(s, slot, act, BEST.kind, BEST.power, BEST.dirX, BEST.dirZ, -1,
      BEST.flags | (AssistLevel.ASSISTED << ASSIST_SHIFT), err);
  }
}

/** Contact phase: header / volley contests (keepers have priority: GKP runs first), then AI attempts. */
export function aerialContacts(s: SimState, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0) return;
  if (ballTouchedThisTick(s)) return;
  if (b.inNet === 0) resolveContacts(s, ev);
  if (!ballTouchedThisTick(s)) aiStarts(s, ev);
}

// ---------------------------------------------------------------- solvers

/** Receiver for an aerial pass from (cx, cz) toward (dirX, dirZ) (unit), power 0..1, cone half-angle; -1 none. */
function pickReceiver(
  s: SimState, slot: number, cx: number, cz: number, dirX: number, dirZ: number, power: number, cone: number,
  minD: number, maxD: number,
): number {
  const p = s.players[slot]!;
  const want = lerp(minD, maxD, power);
  const cosMax = dcos(cone);
  const dir = s.teams[p.team]!.dir;
  const first = p.team === 0 ? 0 : NS / 2;
  const oFirst = p.team === 0 ? NS / 2 : 0;
  let best = -1;
  let bestScore = -1e9;
  for (let i = first; i < first + NS / 2; i++) {
    const q = s.players[i]!;
    if (i === slot || q.active !== 1 || q.isKeeper === 1) continue;
    const dx = q.x - cx;
    const dz = q.z - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < minD * 0.75 || d > maxD * 1.1) continue;
    const c = (dx * dirX + dz * dirZ) / d;
    if (c < cosMax) continue;
    let open: number = LT.opennessCap;
    for (let o = oFirst; o < oFirst + NS / 2; o++) {
      const r = s.players[o]!;
      if (r.active !== 1) continue;
      const ox = r.x - q.x;
      const oz = r.z - q.z;
      const od = Math.sqrt(ox * ox + oz * oz);
      if (od < open) open = od;
    }
    const score = c - absf(d - want) / LT.distMismatchScale + LT.opennessW * open / LT.opennessCap +
      LT.progressW * dir * dx / (d + 1);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Angular error (rad, 1 sigma-ish) of an aerial strike by slot toward (ux, uz). */
function aerialError(
  s: SimState, slot: number, base: number, power: number, ux: number, uz: number, header: boolean, shot: boolean,
): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const b = s.ball;
  let e = base * (1 + LT.pressureErr * pressureOn(s, slot));
  // Balance: a header redirect (straight back is easy), a volley across the body.
  let c: number;
  if (header) {
    const vl = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    c = vl > 1e-6 ? -(b.vx * ux + b.vz * uz) / vl : 1;
  } else {
    const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
    c = fl > 1e-6 ? (p.fx * ux + p.fz * uz) / fl : 1;
  }
  e *= 1 + LT.balanceErr * (1 - c) * 0.5;
  // Awkward contact: fast incoming ball, a stooping header or a high volley.
  const vin = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  let awk = clamp01((vin - LT.fastBallFrom) / LT.fastBallSpan) * 0.5;
  if (header) {
    bodyGeo(s, slot);
    const stand = R[R_STAND]!;
    if (b.y < stand) awk += clamp01((stand - b.y) / 0.5) * 0.4;
  } else {
    awk += clamp01((b.y - LT.volleyHighFrom) / LT.volleyHighSpan) * 0.5;
    // Weaker foot: the side of the body the ball arrives on.
    const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
    if (fl > 1e-6) {
      const right = (p.fx * (b.z - p.z) - p.fz * (b.x - p.x)) / fl >= 0;
      const weak = right ? a.foot === 1 : a.foot === 0;
      if (weak) {
        const wf = a.weakFoot >= 1 && a.weakFoot <= 5 ? a.weakFoot : 3;
        e *= lerp(T_PASS.weakFootErrorMul, 1, (wf - 1) / 4);
      }
    }
  }
  e *= 1 + LT.awkwardErr * awk;
  const knee = T_SHOT.errorPowerKnee;
  if (shot && power > knee) e *= 1 + LT.powerErr * (power - knee) / (1 - knee);
  const sf = staminaFactor(p);
  e *= 1 + LT.staminaErr * (1 - sf) / (1 - ST_FLOOR);
  return e;
}

/** Elevation solver parameters (typed array: the hot calls below take no double arguments, which V8 would box). */
const AP = new Float64Array(4);
const AP_Y0 = 0;
const AP_DIST = 1;
const AP_V = 2;
const AP_TY = 3;

/**
 * Does a spin-free ball launched from height AP_Y0 at elevation th and speed AP_V pass AP_DIST metres away at or
 * above AP_TY (through the real drag model)? Never gets there: false.
 */
function clears(th: number): boolean {
  const v = AP[AP_V]!;
  const dist = AP[AP_DIST]!;
  FLY.x = 0; FLY.y = AP[AP_Y0]!; FLY.z = 0;
  FLY.vx = v * dcos(th); FLY.vy = v * dsin(th); FLY.vz = 0;
  FLY.sx = 0; FLY.sy = 0; FLY.sz = 0;
  for (let k = 0; k < LT.aimMaxSteps; k++) {
    const px = FLY.x;
    const py = FLY.y;
    ballAirStep(FLY, TDT);
    if (FLY.x >= dist) {
      const dx = FLY.x - px;
      const f = dx > 0 ? (dist - px) / dx : 1;
      return py + (FLY.y - py) * f >= AP[AP_TY]!;
    }
  }
  return false;
}

/**
 * Elevation (rad) that makes a ball from height y0 at speed `speed` (raised up to `cap` if it cannot get there
 * otherwise) pass `dist` metres away at height ty, through the real drag model. Speed used -> R[R_AIMV].
 */
function aimElevation(y0: number, dist: number, ty: number, speed: number, cap: number): number {
  let v = speed;
  const lo0 = LT.aimThetaMin;
  const hi0 = LT.aimThetaMax;
  if (dist < 1) {
    R[R_AIMV] = v;
    let th = datan2(ty - y0, dist > 0.3 ? dist : 0.3);
    if (th < lo0) th = lo0;
    else if (th > hi0) th = hi0;
    return th;
  }
  AP[AP_Y0] = y0;
  AP[AP_DIST] = dist;
  AP[AP_TY] = ty;
  AP[AP_V] = v;
  let ok = clears(hi0);
  for (let r = 0; !ok && v < cap && r < LT.aimRaiseTries; r++) {
    v = v * LT.aimRaise;
    if (v > cap) v = cap;
    AP[AP_V] = v;
    ok = clears(hi0);
  }
  R[R_AIMV] = v;
  if (!ok) return hi0;
  let lo: number = lo0;
  let hi: number = hi0;
  if (clears(lo)) return lo;
  for (let it = 0; it < LT.aimIters; it++) {
    const mid = 0.5 * (lo + hi);
    if (clears(mid)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/** Would a ball launched from the current ball position with out's velocity / spin enter the goal at x = end * 52.5? */
function onTargetCheck(s: SimState, end: number, out: KickLaunch): number {
  const b = s.ball;
  copyBallState(SIMB, b);
  SIMB.vx = out.vx; SIMB.vy = out.vy; SIMB.vz = out.vz;
  SIMB.sx = out.sx; SIMB.sy = out.sy; SIMB.sz = out.sz;
  SIMB.owner = -1; SIMB.heldBy = -1; SIMB.inNet = 0; SIMB.bounces = 0;
  SIMB.grounded = SIMB.y > BR + 1e-6 || out.vy > 0.5 ? 0 : SIMB.grounded;
  for (let k = 0; k < LT.onTargetTicks; k++) {
    const px = SIMB.x;
    const py = SIMB.y;
    const pz = SIMB.z;
    ballStepTick(SIMB, null);
    if (SIMB.inNet === end) return 1;
    const u0 = end * px;
    const u1 = end * SIMB.x;
    if (u0 < HL && u1 >= HL) {
      const f = (HL - u0) / (u1 - u0);
      const zc = pz + (SIMB.z - pz) * f;
      const yc = py + (SIMB.y - py) * f;
      return zc < GHW && zc > -GHW && yc < GH ? 1 : 0;
    }
    if (SIMB.z > HW + 1 || SIMB.z < -HW - 1) return 0;
  }
  return 0;
}

/** Aim point on the goal line for an aerial shot by slot (assist level, stick dirX/dirZ; 0,0 = auto) into AIM. */
function aerialAim(s: SimState, slot: number, assist: number, dirX: number, dirZ: number, aimY: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const dir = s.teams[p.team]!.dir;
  const gx = dir * HL;
  const inset = assist === AssistLevel.MANUAL ? 0 : assist === AssistLevel.SEMI ? LT.semiInset : T_SHOT.assistInset;
  const lim = GHW - inset;
  AIM.x = gx;
  AIM.y = aimY;
  const stick = dirX !== 0 || dirZ !== 0;
  if (!stick) {
    // Automatic: the side away from the keeper (centred keeper: back across the flight of the ball).
    const k = s.teams[p.team === 0 ? 1 : 0]!.keeperSlot;
    const kz = k >= 0 && k < NS && s.players[k]!.active === 1 ? s.players[k]!.z : 0;
    let side: number;
    if (kz > 0.05) side = -1;
    else if (kz < -0.05) side = 1;
    else side = b.vz > 0 ? -1 : 1;
    AIM.z = side * (GHW - (assist === AssistLevel.MANUAL ? T_SHOT.assistInset : inset));
    return;
  }
  const goalward = dirX * dir;
  if (goalward > LT.stickGoalward) {
    // The stick ray onto the goal line.
    let z = b.z + (gx - b.x) * dirZ / dirX;
    if (assist !== AssistLevel.MANUAL) {
      if (z > lim) z = lim;
      else if (z < -lim) z = -lim;
    } else if (z > HW) z = HW;
    else if (z < -HW) z = -HW;
    AIM.z = z;
    return;
  }
  if (assist === AssistLevel.MANUAL) {
    // Manual, stick away from goal: the ball goes where the stick says.
    AIM.x = b.x + dirX * LT.manualAwayDist;
    AIM.z = b.z + dirZ * LT.manualAwayDist;
    return;
  }
  AIM.z = dirZ > 0.05 ? lim : dirZ < -0.05 ? -lim : 0;
}

/** Launch toward a landing point (tx, tz) from the ball at angle `angle`, speed capped; returns the speed used. */
function launchToPoint(s: SimState, tx: number, tz: number, angle: number, cap: number, out: KickLaunch): number {
  const b = s.ball;
  const v = solveLaunchSpin(tx - b.x, tz - b.z, angle, b.y, 0, 0, SOL);
  let f = 1;
  if (v > cap) f = cap / v;
  out.vx = SOL.vx * f;
  out.vy = SOL.vy * f;
  out.vz = SOL.vz * f;
  return v * f;
}

/** Rotate out's horizontal velocity by yaw (rad). */
function yawOut(out: KickLaunch, yaw: number): void {
  const c = dcos(yaw);
  const sn = dsin(yaw);
  const vx = out.vx;
  const vz = out.vz;
  out.vx = vx * c - vz * sn;
  out.vz = vx * sn + vz * c;
}

/** Shared solver: header (header = true) or volley of p.actKick. */
function solveAerial(s: SimState, slot: number, out: KickLaunch, header: boolean): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const b = s.ball;
  out.vx = 0; out.vy = 0; out.vz = 0;
  out.sx = 0; out.sy = 0; out.sz = 0;
  out.target = -1;
  out.tx = b.x; out.tz = b.z;
  out.onTarget = 0;
  if (!(b.x - b.x === 0 && b.y - b.y === 0 && b.z - b.z === 0)) return 0;
  const shotKind = header ? KickKind.HEADER_SHOT : KickKind.VOLLEY_SHOT;
  const shot = p.actKick === shotKind;
  out.kind = shot ? shotKind : header ? KickKind.HEADER_PASS : KickKind.VOLLEY_PASS;
  const power = clamp01(p.actPower === p.actPower ? p.actPower : 0.5);
  let assist = (p.actA >> ASSIST_SHIFT) & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  let dirX = p.actDirX;
  let dirZ = p.actDirZ;
  const dl = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (dl > 1e-6 && dl < Infinity) { dirX /= dl; dirZ /= dl; } else { dirX = 0; dirZ = 0; }
  const team = p.team;
  const tdir = s.teams[team]!.dir;
  const vin = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);

  if (shot) {
    const skill = header ? attr01(a.heading) : attr01(a.shotPower);
    const aimY = header ? lerp(LT.headerAimHighY, LT.headerAimLowY, power) :
      lerp(LT.volleyAimLowY, LT.volleyAimHighY, power);
    aerialAim(s, slot, assist, dirX, dirZ, aimY);
    const mix = LT.shotPowerW * power + (1 - LT.shotPowerW) * skill;
    let v: number;
    let floor: number;
    let cap: number;
    if (header) {
      v = lerp(LT.headerShotMin, LT.headerShotMax, mix) + LT.headerRedirect * vin;
      floor = LT.headerShotFloor;
      cap = LT.headerShotCap;
    } else {
      v = lerp(LT.volleyShotMin, LT.volleyShotMax, mix);
      floor = LT.volleyShotFloor;
      cap = LT.volleyShotCap;
    }
    if (v < floor) v = floor;
    if (v > cap) v = cap;
    const dx = AIM.x - b.x;
    const dz = AIM.z - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    let ux = tdir;
    let uz = 0;
    if (d > 1e-6) { ux = dx / d; uz = dz / d; }
    const th0 = aimElevation(b.y, d, AIM.y, v, cap);
    v = R[R_AIMV]!;
    const fin = header ? attr01(a.heading) : attr01((a.finishing + a.shotPower) * 0.5);
    const base = header ? lerp(LT.headerErrMax, LT.headerErrMin, fin) : lerp(LT.volleyErrMax, LT.volleyErrMin, fin);
    const err = aerialError(s, slot, base, power, ux, uz, header, true);
    const yaw = err * rngGauss(s.rng);
    const pitch = err * LT.pitchErrFrac * rngGauss(s.rng);
    const th = th0 + pitch;
    const vh = v * dcos(th);
    out.vx = vh * ux;
    out.vz = vh * uz;
    out.vy = v * dsin(th);
    yawOut(out, yaw);
    out.tx = AIM.x;
    out.tz = AIM.z;
    out.onTarget = onTargetCheck(s, tdir, out);
    return 1;
  }

  // Pass, flick-on or clearance.
  const minD = header ? LT.headerPassMinDist : LT.volleyPassMinDist;
  const maxD = header ? LT.headerPassMaxDist : LT.volleyPassMaxDist;
  const ai = (p.actA & F_AI) !== 0;
  let clear = (p.actA & F_CLEAR) !== 0;
  if (dirX === 0 && dirZ === 0) {
    const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
    if (ai || !(fl > 1e-6)) { dirX = tdir; dirZ = 0; } else { dirX = p.fx / fl; dirZ = p.fz / fl; }
  }
  let recv = -1;
  if (!clear) {
    const t = p.actSlot;
    if (t >= 0 && t < NS && t !== slot && s.players[t]!.active === 1 && s.players[t]!.team === team) {
      recv = t;
    } else if (ai || assist !== AssistLevel.MANUAL) {
      const cone = ai ? LT.aiCone : assist === AssistLevel.SEMI ? LT.semiCone : T_PASS.coneHalfAngle;
      recv = pickReceiver(s, slot, b.x, b.z, dirX, dirZ, power, cone, minD, maxD);
    }
    // No one to find in the own half: put it away.
    if (recv < 0 && tdir * b.x < 0) clear = true;
  }
  const pskill = header ? attr01(a.heading) : attr01((a.shortPassing + a.ballControl) * 0.5);
  const pbase = header ? lerp(LT.headerPassErrMax, LT.headerPassErrMin, pskill) :
    lerp(LT.volleyPassErrMax, LT.volleyPassErrMin, pskill);
  if (clear) {
    // Never toward the own goal.
    if (dirX * tdir < 0) dirX = -dirX;
    if (absf(dirX) < 0.3) {
      dirX = tdir * 0.3;
      const l = Math.sqrt(dirX * dirX + dirZ * dirZ);
      dirX /= l;
      dirZ /= l;
    }
    const mix = 0.5 * power + 0.5 * pskill;
    const v = header ? lerp(LT.headerClearMin, LT.headerClearMax, mix) : lerp(LT.volleyClearMin, LT.volleyClearMax, mix);
    const th = header ? LT.headerClearAngle : LT.volleyClearAngle;
    const vh = v * dcos(th);
    out.vx = vh * dirX;
    out.vz = vh * dirZ;
    out.vy = v * dsin(th);
    const err = aerialError(s, slot, pbase, power, dirX, dirZ, header, false);
    yawOut(out, err * rngGauss(s.rng));
    out.tx = b.x + dirX * v * 1.6;
    out.tz = b.z + dirZ * v * 1.6;
    return 1;
  }
  let tx: number;
  let tz: number;
  if (recv >= 0) {
    const q = s.players[recv]!;
    const dx = q.x - b.x;
    const dz = q.z - b.z;
    let lead = Math.sqrt(dx * dx + dz * dz) / LT.passLeadSpeed;
    if (lead > LT.passLeadMax) lead = LT.passLeadMax;
    tx = q.x + q.vx * lead;
    tz = q.z + q.vz * lead;
    out.target = recv;
  } else {
    const dist = lerp(minD, maxD, power);
    tx = b.x + dirX * dist;
    tz = b.z + dirZ * dist;
  }
  if (tx > HL) tx = HL;
  else if (tx < -HL) tx = -HL;
  if (tz > HW) tz = HW;
  else if (tz < -HW) tz = -HW;
  const dx = tx - b.x;
  const dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const ang = header ? lerp(LT.headerPassAngleNear, LT.headerPassAngleFar, clamp01((d - 5) / 20)) : LT.volleyPassAngle;
  launchToPoint(s, tx, tz, ang, header ? LT.headerPassMaxSpeed : LT.volleyPassMaxSpeed, out);
  let ux = dirX;
  let uz = dirZ;
  if (d > 1e-6) { ux = dx / d; uz = dz / d; }
  const err = aerialError(s, slot, pbase, power, ux, uz, header, false);
  yawOut(out, err * rngGauss(s.rng));
  out.tx = tx;
  out.tz = tz;
  return 1;
}

function solveHeaderImpl(s: SimState, slot: number, out: KickLaunch): number { return solveAerial(s, slot, out, true); }
function solveVolleyImpl(s: SimState, slot: number, out: KickLaunch): number { return solveAerial(s, slot, out, false); }

bindAerialImpl({ update: aerialUpdate, end: aerialEnd, solveHeader: solveHeaderImpl, solveVolley: solveVolleyImpl });

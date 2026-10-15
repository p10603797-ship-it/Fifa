/**
 * [TAI-07] Loose-ball assignment and arrival steering. assignChaser: exactly one player per team chases a free
 * ball (ball.owner === -1), chosen by arrival time (SIM-04 ticksToReach / SIM-01 predictBall interception point)
 * and re-evaluated with hysteresis (T_AI.chaserHysteresisTicks, chaserMinTicks) — never two teammates, never
 * nobody (team.chaser, CHASE_LOOSE job). A human-controlled player near the ball counts as his team's chaser.
 * executeJobs: converts every job-driven player's final job target into a movement intent (MoveMode.ARRIVE
 * with tgtSpeed; sprint when far/urgent; face the ball when holding position) without overriding players whose
 * action locks movement (moveMode LOCKED); calls jobs.finalizeJobT. Arrival behaviour must stop players on a
 * spot (no orbiting or jitter), including when the target moves slowly.
 *
 * Chaser selection (assignChaser, IN_PLAY only; team.chaser = -1 whenever the ball is owned or held):
 *  1. One ball prediction per tick (predictBall, LOCAL_TUNING.chasePredictTicks samples), cached in module scratch
 *     and shared by both teams (keyed on tick + every ball field, so it can never be stale).
 *  2. Interception per candidate: the FIRST playable sample (ball centre <= chaseReachHeight) the player can reach
 *     in time: busy + ticksToReach(sample) <= sample tick, and not before p.noTouchT. "busy" = remaining ticks of a
 *     movement-locking action / stun that ticksToReach does not already count. A straight-line lower bound skips
 *     hopeless samples and a Lipschitz skip bounds the ticksToReach calls (<= chaseMaxEvals per player). No sample
 *     reachable -> the last sample at max(horizon, arrival). No prediction (count 0) -> the ball's position.
 *     Score = interception tick (+ a sub-tick tie-break on the player's own arrival time).
 *  3. Candidates: active outfield players; controlled players (human or CPU brain, p.ctrl >= 0), with a bias of
 *     controlledBiasTicks while he is going for the ball (moving toward the interception point, or on it) — [QF-11
 *     skeptic] but a CPU-controlled player still in his brain's reaction delay whose run does not take him there
 *     (reactionLeft) is later by the delay's remaining ticks and makes no near claim, so a teammate goes; the
 *     keeper only when GKP says he is going (act GK_RUSH) or he is controlled. [INT-A] A keeper on a USER rush
 *     (GKP-03 RushMode USER_HOLD / USER_TIMED: a human holds keeper-rush) counts as a controlled candidate: a held
 *     rush button sent him 60 m upfield after a ball while, as the claiming chaser, no outfield teammate chased it
 *     (fuzz ball-untouched watchdog).
 *  4. Claims that bypass hysteresis, in order: the keeper in an AI GK_RUSH (GKP-03 keeps it in his come-out zone) or
 *     [QF-2] in a GKP-02 save (GK_CATCH / GK_DIVE) on the opponents' loose ball;
 *     the intended receiver of our own pass
 *     (ball.passTarget, ball.lastKickTeam === team — TAI-14 gives him RECEIVE, so nobody else may chase) while the
 *     pass is intact (ball.lastTouchTeam === team: an opponent's deflection ends it), he is not down (busy <=
 *     chaserHysteresisTicks) and the claim was not already lost for this pass (another candidate took the chase
 *     after the kick); a controlled player within controlledNearDist of a playable ball who can intercept within
 *     controlledNearTicks.
 *  5. Hysteresis: keep the current chaser unless the best is faster by chaserHysteresisTicks AND the current one held
 *     it >= chaserMinTicks (or is incapacitated: busy > chaserHysteresisTicks). A controlled best claims at once
 *     (gain >= 0 after his bias) from an AI chaser. An invalid current chaser (sent off, keeper no longer rushing,
 *     switched to another team...) is replaced at once. No candidate at all -> the keeper (or any active
 *     teammate), so the chaser is always valid while the ball is loose.
 *  6. A job-driven chaser gets CHASE_LOOSE at the interception point (clamped inside the boards) at top speed.
 *     Controlled / keeper chasers get no job (their controller / GKP moves them).
 *
 * Steering (executeJobs, arrive):
 *  - ARRIVE at the job target with the job's speed cap (tgtSpeed, clamped to [0, top]; NaN -> jog). The cap is the
 *    module's request and is always honoured: a module asks for a sprint with a cap above jog speed (CHASE_LOOSE uses
 *    top speed). SIM-04 does the arrival profile (slowing into the target).
 *  - Sprint flag (wantSprint) when the cap is above jog and the player is far: urgent jobs (CHASE_LOOSE, PRESS,
 *    RECOVER, RUN_IN_BEHIND, RECEIVE) beyond sprintDistUrgent, other jobs beyond sprintDistCalm (hysteresis: keep
 *    sprinting down to half the distance).
 *  - Dead zone (positional jobs; not CHASE_LOOSE / RECEIVE / SET_PIECE, which must reach their point exactly): a
 *    player at rest (speed <= restSpeed, not moving in) within deadZone of his target holds (MoveMode.STOP) instead
 *    of creeping, so a jiggling target never causes micro-movement; a moving player keeps following (smooth pursuit
 *    of moving targets). A target occupied by another body (centre within occupiedRadius) makes a nearby player
 *    hold short of it instead of running in place against him.
 *  - Positional jobs face the ball (lookAt) within faceBallDist and while holding; ball jobs face their run (and
 *    the ball once on the spot).
 *  - Players whose action locks movement (moveMode LOCKED or a non-moving ActionKind) are left alone; finalizeJobT
 *    runs for every job-driven player. Outside IN_PLAY executeJobs clears team.chaser.
 * Determinism: no Math.sin/cos/atan2..., no Map/Set, slot-order loops, allocation-free per tick. Module scratch is
 * either a pure cache (the prediction) or rebuilt every call (per-slot interception results).
 */
import {
  BOARD_X, BOARD_Z, CPU_CONTROLLER_BASE, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ, teamFirstSlot,
} from '../contracts/constants';
import { ActionKind, AiJob, MatchPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import { createBallState, MoveMode, type BallState, type PlayerState, type SimState } from '../contracts/state';
import { createBallPrediction, MAX_PREDICT_TICKS } from '../contracts/systems';
import { T_AI, T_PLAYER } from '../contracts/tuning';
import { predictBall } from '../sim/ball/flight';
import { ticksToReach } from '../sim/players/locomotion';
import { assignJob, finalizeJobT, isJobDriven } from './jobs';

export const LOCAL_TUNING = {
  /** Ball prediction horizon for loose-ball interception, ticks (<= MAX_PREDICT_TICKS = 180). */
  chasePredictTicks: 120,
  /** Highest ball-centre height a chaser can play (feet, chest, head), m; higher samples are flown over. */
  chaseReachHeight: 2.0,
  /** Lower-bound slack: ticksToReach may count a point as reached from up to this far away, m. */
  chaseReachSlack: 1.2,
  /** Safety factor (>= 1) on the Lipschitz sample skip after a failed ticksToReach (larger = fewer skips). */
  chaseSkipSafety: 2.0,
  /** Max ticksToReach evaluations per player per tick (budget guard; the end-of-horizon fallback follows). */
  chaseMaxEvals: 24,
  /**
   * Arrival-time bias of a controlled (human / CPU brain) player going for the ball (moving toward the interception
   * point at >= controlledApproachSpeed, or within controlledNearDist of it): he claims the chase within this, ticks.
   */
  controlledBiasTicks: 18,
  /** Speed toward the interception point that counts as going for it, m/s. */
  controlledApproachSpeed: 1.0,
  /** A controlled player this close to a playable ball is the chaser outright, m ... */
  controlledNearDist: 3.0,
  /** ... provided he can intercept it within this many ticks (not a ball he has just struck away). */
  controlledNearTicks: 60,
  /** Dead zone: a player at rest this close to a positional target holds instead of creeping, m. */
  deadZone: 0.5,
  /** At or below this speed a player counts as at rest, m/s. */
  restSpeed: 0.15,
  /** Velocity toward the target above which a slow player counts as moving in (keeps arriving), m/s. */
  approachSpeed: 0.05,
  /** Urgent jobs sprint beyond this distance from the target (keep sprinting down to half of it), m. */
  sprintDistUrgent: 3.0,
  /** Other jobs that request more than jog speed sprint beyond this distance (down to half of it), m. */
  sprintDistCalm: 6.0,
  /** Positional jobs face the ball within this distance of their target, m. */
  faceBallDist: 3.0,
  /** Ball jobs (chase, receive) face the ball within this distance of their target, m. */
  ballJobFaceDist: 0.5,
  /** A target counts as occupied when another player's centre is within this distance of it, m. */
  occupiedRadius: 0.7,
  /** Hold short of an occupied target from this distance, m (+ occupiedHoldExtra when already at rest). */
  occupiedStopDist: 1.5,
  occupiedHoldExtra: 0.5,
  /** [QF-2] A body whose centre is within blockedDist of a positional player and within acos(blockedCos) of his way
   *  to the target blocks it: he does not turn to face the ball (SIM-05 then slides him round it), m / cos. */
  blockedDist: 1.0,
  blockedCos: 0.5,
  /** [INT-A trailing] A ball job chasing a loose ball that rolls away from him (faster than overshootMinSpeed m/s)
   *  aims overshootSec x ball speed (at least overshootMin: more than his braking distance at top speed; at most
   *  overshootMax m) beyond his target along the ball's path, so SIM-04's arrival braking does not leave him trailing
   *  1-2 m behind it. m/s, s, m, m. */
  overshootMinSpeed: T_AI.chaseOvershootMinSpeed, // (contracts/tuning.ts T_AI.chaseOvershoot* since QF-2)
  overshootSec: T_AI.chaseOvershootSec,
  overshootMin: T_AI.chaseOvershootMin,
  overshootMax: T_AI.chaseOvershootMax,
} as const; // TUNING-CR

const LT = LOCAL_TUNING;

/** Board limits for movement targets (player centres keep a body radius off the boards; SIM-04 confines too). */
const TGT_MAX_X = BOARD_X - T_PLAYER.bodyRadius;
const TGT_MAX_Z = BOARD_Z - T_PLAYER.bodyRadius;
const BIG = 1e9;

// ---------------------------------------------------------------- action / job tables (built once at load)

const N_ACTIONS = ActionKind.SHIELD + 1;
/** 1 = the action owns the player's movement (executeJobs / arrive leave him alone). */
const NON_MOVING = new Uint8Array(N_ACTIONS);
/** 1 = the player cannot chase until the action ends (non-moving actions + stumble). */
const BUSY_ACT = new Uint8Array(N_ACTIONS);
for (const k of [
  ActionKind.KICK, ActionKind.SHOT, ActionKind.HEADER, ActionKind.VOLLEY, ActionKind.STAND_TACKLE,
  ActionKind.HARD_TACKLE, ActionKind.SLIDE_TACKLE, ActionKind.SHOULDER, ActionKind.PUSH_PULL, ActionKind.FALLEN,
  ActionKind.GET_UP, ActionKind.GK_DIVE, ActionKind.GK_THROW, ActionKind.GK_KICK, ActionKind.GK_PUNCH,
  ActionKind.GK_CATCH, ActionKind.THROW_IN, ActionKind.SET_PIECE, ActionKind.CELEBRATE, ActionKind.DEJECTED,
  ActionKind.WALL_JUMP,
]) { NON_MOVING[k] = 1; BUSY_ACT[k] = 1; }
BUSY_ACT[ActionKind.STUMBLE] = 1;

const N_JOBS = AiJob.CELEBRATE + 1;
/** Urgent jobs: sprint from sprintDistUrgent. */
const URGENT = new Uint8Array(N_JOBS);
for (const j of [AiJob.CHASE_LOOSE, AiJob.PRESS, AiJob.RECOVER, AiJob.RUN_IN_BEHIND, AiJob.RECEIVE]) URGENT[j] = 1;
/** Ball jobs: the target is on the ball's path (face the run, not the ball, until on the spot). */
const BALL_JOB = new Uint8Array(N_JOBS);
BALL_JOB[AiJob.CHASE_LOOSE] = 1;
BALL_JOB[AiJob.RECEIVE] = 1;
/**
 * Exact jobs: no dead zone and no occupied-target hold — the ball jobs, and scripted set-piece positions (walls,
 * kick-off halves, penalty-area exclusion must be reached exactly; SIM-04's own arrival stop settles them).
 */
const EXACT_JOB = new Uint8Array(N_JOBS);
EXACT_JOB[AiJob.CHASE_LOOSE] = 1;
EXACT_JOB[AiJob.RECEIVE] = 1;
EXACT_JOB[AiJob.SET_PIECE] = 1;
/** Positional jobs that face the ball near / on their spot (players face play). */
const FACE_BALL = new Uint8Array(N_JOBS);
for (const j of [
  AiJob.HOLD_SHAPE, AiJob.SUPPORT, AiJob.RUN_IN_BEHIND, AiJob.OVERLAP, AiJob.LATE_RUN, AiJob.MARK, AiJob.TRACK_RUNNER,
  AiJob.COVER, AiJob.RECOVER, AiJob.PRESS, AiJob.SET_PIECE,
]) FACE_BALL[j] = 1;

// ---------------------------------------------------------------- module scratch

/** Ball prediction shared by both teams' assignChaser in a tick (pure cache, see ensurePrediction). */
const PRED = createBallPrediction();
/** Cumulative horizontal path length of the prediction from the ball's position to sample i, m. */
const CUM = new Float64Array(MAX_PREDICT_TICKS);
/** Snapshot of the ball the cached prediction was made from (cache key with predTick / predRef). */
const PRED_BALL = createBallState();
let predTick = -1;
let predRef: BallState | null = null;

/** Per-slot interception results of the latest evaluation (rebuilt every call; never read across ticks). */
const IX = new Float64Array(NUM_SLOTS);
const IZ = new Float64Array(NUM_SLOTS);
/** Ball arrival tick at the interception point (ticks from now). */
const IT = new Float64Array(NUM_SLOTS);
/** Player's own arrival ticks at that point (incl. busy). */
const IP = new Float64Array(NUM_SLOTS);
/** 1 = a reachable sample was found within the horizon. */
const IF = new Uint8Array(NUM_SLOTS);
/** Candidate score (biased) of the latest assignChaser; valid when OK[slot] = 1. */
const SCORE = new Float64Array(NUM_SLOTS);
const OK = new Uint8Array(NUM_SLOTS);

// ---------------------------------------------------------------- small helpers

function clampTo(v: number, lim: number): number { return v > lim ? lim : v < -lim ? -lim : v; }
function finiteOr(v: number, d: number): number { return Number.isFinite(v) ? v : d; }

/** True if the player's movement is owned by his action (moveMode LOCKED or a non-moving action). */
export function isMovementLocked(p: Readonly<PlayerState>): boolean {
  if (p.moveMode === MoveMode.LOCKED) return true;
  const a = p.act;
  return a > 0 && a < N_ACTIONS && NON_MOVING[a] === 1;
}

/** Ticks before the player can start moving to the ball (locking action or stun remaining). */
export function busyTicks(p: Readonly<PlayerState>): number {
  let b = p.stunT > 0 ? p.stunT : 0;
  const a = p.act;
  if (a > 0 && a < N_ACTIONS && BUSY_ACT[a] === 1) {
    const r = p.actDur - p.actT;
    if (r > b) b = r;
  }
  return b;
}

/** Remaining action ticks SIM-04 ticksToReach already adds (its documented LOCKED rule). */
function lockCountedByReach(p: Readonly<PlayerState>): number {
  if (p.moveMode === MoveMode.LOCKED && p.act !== ActionKind.NONE && p.actDur > p.actT) return p.actDur - p.actT;
  return 0;
}

function sameBall(a: Readonly<BallState>, b: Readonly<BallState>): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.vx === b.vx && a.vy === b.vy && a.vz === b.vz &&
    a.sx === b.sx && a.sy === b.sy && a.sz === b.sz && a.px === b.px && a.py === b.py && a.pz === b.pz &&
    a.grounded === b.grounded && a.bounces === b.bounces && a.owner === b.owner && a.ownerT === b.ownerT &&
    a.heldBy === b.heldBy && a.lastTouch === b.lastTouch && a.lastTouchTeam === b.lastTouchTeam &&
    a.lastTouchTick === b.lastTouchTick && a.touchedTick === b.touchedTick && a.lastKickBy === b.lastKickBy &&
    a.lastKickTeam === b.lastKickTeam && a.lastKickKind === b.lastKickKind && a.lastKickTick === b.lastKickTick &&
    a.passTarget === b.passTarget && a.passX === b.passX && a.passZ === b.passZ && a.shotBy === b.shotBy &&
    a.shotTick === b.shotTick && a.shotOnTarget === b.shotOnTarget && a.inNet === b.inNet && a.idleT === b.idleT &&
    a.cross === b.cross && a.crossX === b.crossX && a.crossZ === b.crossZ && a.crossEnd === b.crossEnd;
}

function snapBall(d: BallState, b: Readonly<BallState>): void {
  d.x = b.x; d.y = b.y; d.z = b.z; d.vx = b.vx; d.vy = b.vy; d.vz = b.vz; d.sx = b.sx; d.sy = b.sy; d.sz = b.sz;
  d.px = b.px; d.py = b.py; d.pz = b.pz; d.grounded = b.grounded; d.bounces = b.bounces; d.owner = b.owner;
  d.ownerT = b.ownerT; d.heldBy = b.heldBy; d.lastTouch = b.lastTouch; d.lastTouchTeam = b.lastTouchTeam;
  d.lastTouchTick = b.lastTouchTick; d.touchedTick = b.touchedTick; d.lastKickBy = b.lastKickBy;
  d.lastKickTeam = b.lastKickTeam; d.lastKickKind = b.lastKickKind; d.lastKickTick = b.lastKickTick;
  d.passTarget = b.passTarget; d.passX = b.passX; d.passZ = b.passZ; d.shotBy = b.shotBy; d.shotTick = b.shotTick;
  d.shotOnTarget = b.shotOnTarget; d.inNet = b.inNet; d.idleT = b.idleT; d.cross = b.cross; d.crossX = b.crossX;
  d.crossZ = b.crossZ; d.crossEnd = b.crossEnd;
}

/**
 * Make PRED the prediction of s.ball for this tick. A pure cache: recomputed unless the same ball object, the same
 * tick and every ball field are unchanged, so interleaved simulations can never read each other's prediction.
 */
function ensurePrediction(s: SimState): void {
  const b = s.ball;
  if (predRef === b && predTick === s.tick && sameBall(PRED_BALL, b)) return;
  predictBall(b, LT.chasePredictTicks, PRED);
  let n = PRED.count;
  if (!(n > 0)) n = 0;
  if (n > MAX_PREDICT_TICKS) n = MAX_PREDICT_TICKS;
  PRED.count = n;
  let px = b.x, pz = b.z, acc = 0;
  for (let i = 0; i < n; i++) {
    const x = PRED.x[i]!, z = PRED.z[i]!;
    const dx = x - px, dz = z - pz;
    acc += Math.sqrt(dx * dx + dz * dz);
    CUM[i] = acc;
    px = x; pz = z;
  }
  snapBall(PRED_BALL, b);
  predRef = b;
  predTick = s.tick;
}

/**
 * Earliest interception of the predicted ball by `slot` (prediction must be current). Writes IX/IZ/IT/IP/IF[slot].
 * Returns the ball arrival tick IT. [QF-2] `slack` (ticks, default 0): a sample counts as reached when he gets there
 * at most this many ticks after the ball (negative: that many ticks before it); see estimateInterceptSlack.
 */
function evalIntercept(s: SimState, slot: number, slack = 0): number {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const counted = lockCountedByReach(p);
  const own = busyTicks(p);
  const extra = own > counted ? own - counted : 0;
  const busy = own > counted ? own : counted;
  const earliest = busy > p.noTouchT ? busy : p.noTouchT;
  const top = a.topSpeed > 1 ? a.topSpeed : 1;
  const L = TICK_HZ / top;
  const K = L * LT.chaseSkipSafety;
  const n = PRED.count;
  const xs = PRED.x, ys = PRED.y, zs = PRED.z;
  if (n === 0) {
    const b = s.ball;
    const tt = extra + ticksToReach(s, slot, b.x, b.z);
    IX[slot] = b.x; IZ[slot] = b.z; IP[slot] = tt; IT[slot] = tt > earliest ? tt : earliest; IF[slot] = 1;
    return IT[slot]!;
  }
  let i = 0;
  let evals = 0;
  let found = -1;
  let foundTT = 0;
  while (i < n) {
    const tick = i + 1;
    if (tick < earliest) { i = Math.ceil(earliest) - 1; continue; }
    if (ys[i]! > LT.chaseReachHeight) { i++; continue; }
    const dx = xs[i]! - p.x, dz = zs[i]! - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const lb = busy + (d > LT.chaseReachSlack ? (d - LT.chaseReachSlack) * L : 0);
    if (lb > tick + slack) { i++; continue; }
    if (evals >= LT.chaseMaxEvals) break;
    evals++;
    const tt = extra + ticksToReach(s, slot, xs[i]!, zs[i]!);
    if (tt <= tick + slack) { found = i; foundTT = tt; break; }
    // Lipschitz skip: tt(j) >= tt - K * |P_j - P_i| >= tt - K * (CUM[j] - CUM[i]); skip while that exceeds j + 1
    // (+ slack).
    const ci = CUM[i]!;
    let j = i + 1;
    while (j < n && tt - K * (CUM[j]! - ci) > j + 1 + slack) j++;
    i = j;
  }
  if (found >= 0) {
    IX[slot] = xs[found]!; IZ[slot] = zs[found]!; IT[slot] = found + 1; IP[slot] = foundTT; IF[slot] = 1;
  } else {
    const last = n - 1;
    const tt = extra + ticksToReach(s, slot, xs[last]!, zs[last]!);
    IX[slot] = xs[last]!; IZ[slot] = zs[last]!; IP[slot] = tt; IF[slot] = 0;
    let t = tt > n + 1 ? tt : n + 1;
    if (t < earliest) t = earliest;
    IT[slot] = t;
  }
  return IT[slot]!;
}

// ---------------------------------------------------------------- public helpers

/** Result of estimateIntercept. */
export interface InterceptEstimate {
  /** Interception point (ball position at that tick), pitch metres. */
  x: number;
  z: number;
  /** Ticks from now until the ball is there (the interception tick). */
  ballT: number;
  /** Ticks the player needs to get there (incl. a locking action / stun). */
  playerT: number;
  /** 1 = reachable within the prediction horizon; 0 = fallback to the end of the predicted path. */
  inHorizon: number;
}

export function createInterceptEstimate(): InterceptEstimate {
  return { x: 0, z: 0, ballT: 0, playerT: 0, inHorizon: 0 };
}

/**
 * Earliest point where `slot` can intercept the free ball (same model as assignChaser: first playable predicted
 * sample he reaches in time). Pure apart from the shared per-tick prediction cache; allocation-free.
 * Useful for CPU brains (TAI-11), keepers (GKP-03) and switching (SIM-16). Returns out.ballT.
 */
export function estimateIntercept(s: SimState, slot: number, out: InterceptEstimate): number {
  ensurePrediction(s);
  evalIntercept(s, slot);
  out.x = IX[slot]!; out.z = IZ[slot]!; out.ballT = IT[slot]!; out.playerT = IP[slot]!; out.inHorizon = IF[slot]!;
  return out.ballT;
}

/**
 * [QF-2] estimateIntercept with an arrival slack: the first playable sample `slot` reaches at most `slack` ticks after
 * the ball is there (slack > 0: a near miss counts as reached; slack < 0: he must be there that many ticks early).
 * The first reachable sample of a long or bouncing flight is a knife edge (a man who makes the first-bounce window by
 * one tick is 25 ticks away, by one tick too few 140), so a decision with a start and a keep side (GKP-03 come-out)
 * judges the two sides with different slacks: hysteresis instead of a start / abort flip-flop. slack 0 is exactly
 * estimateIntercept. Returns out.ballT.
 */
export function estimateInterceptSlack(s: SimState, slot: number, slack: number, out: InterceptEstimate): number {
  ensurePrediction(s);
  evalIntercept(s, slot, slack === slack ? slack : 0);
  out.x = IX[slot]!; out.z = IZ[slot]!; out.ballT = IT[slot]!; out.playerT = IP[slot]!; out.inHorizon = IF[slot]!;
  return out.ballT;
}

// ---------------------------------------------------------------- chaser

function clearChaser(s: SimState, team: number): void {
  const t = s.teams[team]!;
  t.chaser = -1;
  t.chaserT = 0;
}

/**
 * [INT-A] First GKP-03 RushMode of a user rush (USER_HOLD 2, USER_TIMED 3; AI_BALL 0 and AI_ONE_ON_ONE 1 are the
 * brain's). Mirrored, not imported: keeper/sweeper.ts imports this module. int-a-gameplay pins the value.
 */
export const RUSH_USER_MODE_MIN = 2;

/** True if `p` is a keeper on a user-ordered rush (GK_RUSH in a user RushMode). */
function userRush(p: Readonly<PlayerState>): boolean {
  return p.isKeeper === 1 && p.act === ActionKind.GK_RUSH && p.actA >= RUSH_USER_MODE_MIN;
}

/**
 * Keeper of `team` if active and (by GKP) committed to the ball: an AI GK_RUSH (a user rush is a candidate), or [QF-2]
 * a GKP-02 save (GK_CATCH, incl. the planted stance, or GK_DIVE) on a loose ball the opponents touched last — his
 * shot to save, so no outfielder chases it (glitch "keeper fights a defender for the same ball": the controlled
 * defender beside a planted keeper, as the chaser, ran out and trapped the shot in front of him).
 */
function rushingKeeper(s: SimState, team: number, first: number, end: number): number {
  const k = s.teams[team]!.keeperSlot;
  if (k < first || k >= end) return -1;
  const p = s.players[k]!;
  if (p.active !== 1) return -1;
  if (p.act === ActionKind.GK_RUSH) return p.actA < RUSH_USER_MODE_MIN ? k : -1;
  if ((p.act === ActionKind.GK_CATCH || p.act === ActionKind.GK_DIVE) && s.ball.lastTouchTeam !== team && p.ctrl < 0) return k;
  return -1;
}

/**
 * Intended receiver of our own pass still on its way (TAI-14 gives him RECEIVE), or -1. Needs candidate flags OK[]
 * of this call. The claim (which bypasses arrival time and hysteresis) holds only while:
 *  - the pass is intact: our team kicked it AND touched it last (an opponent's deflection ends it, as in TAI-14's
 *    assistedReceiver; ball.passTarget itself survives recordTouch);
 *  - the receiver can play it: active and not down (busyTicks <= chaserHysteresisTicks, the same incapacitation
 *    rule as for any chaser), so a fallen receiver is replaced at once;
 *  - it was not already lost for this pass: once another candidate took the chase after the kick (receiver down,
 *    deflection), arrival time + hysteresis decide until the next kick (no flip back when the receiver gets up).
 *    The current chaser was assigned chaserT + 1 ticks ago (this call has not counted the current tick yet), the
 *    pass was kicked s.tick - lastKickTick ticks ago, and the AI runs before kicks within a tick.
 */
function ownReceiver(s: SimState, team: number, first: number, end: number): number {
  const b = s.ball;
  const r = b.passTarget;
  if (r < first || r >= end || (r | 0) !== r || b.lastKickTeam !== team || b.lastTouchTeam !== team) return -1;
  const p = s.players[r]!;
  if (p.active !== 1 || busyTicks(p) > T_AI.chaserHysteresisTicks) return -1;
  const t = s.teams[team]!;
  const cur = t.chaser;
  if (cur !== r && cur >= first && cur < end && OK[cur] === 1 && t.chaserT < s.tick - 1 - b.lastKickTick) return -1;
  return r;
}

/**
 * [QF-11 skeptic] Ticks a CPU-controlled player of `team` will still keep his old run (his brain's reaction delay:
 * TAI-11 branch 2 runs before the loose-ball chase, branch 6) when that run does not take him to the interception point
 * (x, z): he cannot start for the ball before then, so he is that much later. 0 for a human / AI-driven player, after
 * the delay, or when his run already approaches the point (controlledApproachSpeed) or he is on it (within
 * T_AI.chaserReactNearDist and not running away). Without it a Beginner's 80-tick delay left the chase to a controlled
 * player running the other way for up to 1.3 s (10 times a short match): nobody went for the ball.
 */
function reactionLeft(s: SimState, team: number, p: Readonly<PlayerState>, x: number, z: number): number {
  if (p.ctrl < CPU_CONTROLLER_BASE) return 0;
  const brain = s.teams[team]!.cpu;
  const r = brain.reactT;
  // A delay that ends within the chaser hysteresis cannot leave the ball unchased longer than the hysteresis allows
  // anyway (Professional and above): only the long delays of the low levels count.
  if (brain.active !== 1 || !(r > T_AI.chaserHysteresisTicks)) return 0;
  // Our own pass in flight: TAI-11 branch 1 has no reaction delay (SIM-15 moves the receiver).
  const b = s.ball;
  const pt = b.passTarget;
  if (pt >= 0 && pt < NUM_SLOTS && (pt | 0) === pt && b.lastTouchTeam === team && s.players[pt]!.team === team &&
    s.players[pt]!.active === 1) return 0;
  const dx = x - p.x, dz = z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const approach = d > 1e-6 ? (p.vx * dx + p.vz * dz) / d : 0;
  if (approach >= LT.controlledApproachSpeed) return 0;
  if (d <= T_AI.chaserReactNearDist && approach > -LT.controlledApproachSpeed) return 0;
  return r;
}

/** True if a controlled player is going for the interception point (moving toward it, or already on it). */
function goingFor(p: Readonly<PlayerState>, x: number, z: number): boolean {
  const dx = x - p.x, dz = z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= LT.controlledNearDist) return true;
  return (p.vx * dx + p.vz * dz) / d >= LT.controlledApproachSpeed;
}

/** Fallback chaser when nobody is a candidate: the keeper, else the first active teammate, else -1. */
function fallbackChaser(s: SimState, team: number, first: number, end: number): number {
  const k = s.teams[team]!.keeperSlot;
  if (k >= first && k < end && s.players[k]!.active === 1) return k;
  for (let i = first; i < end; i++) if (s.players[i]!.active === 1) return i;
  return -1;
}

export function assignChaser(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  const b = s.ball;
  if (s.match.phase !== MatchPhase.IN_PLAY || b.owner !== -1 || b.heldBy !== -1) { clearChaser(s, team); return; }
  ensurePrediction(s);
  const first = teamFirstSlot(team);
  const end = first + PLAYERS_PER_TEAM;

  // ---- candidates
  let best = -1;
  let bestScore = BIG;
  let near = -1;
  let nearD = BIG;
  for (let i = first; i < end; i++) {
    OK[i] = 0;
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const controlled = p.ctrl >= 0 || userRush(p);
    if (p.isKeeper === 1 && !controlled) continue;
    evalIntercept(s, i);
    let sc = IT[i]! + 0.001 * (IP[i]! < 999 ? IP[i]! : 999);
    if (controlled) {
      // [QF-11 skeptic] A CPU-controlled player still keeping his old run arrives later (and claims nothing).
      const late = reactionLeft(s, team, p, IX[i]!, IZ[i]!);
      if (late > 0) sc += late;
      else if (goingFor(p, IX[i]!, IZ[i]!)) sc -= LT.controlledBiasTicks;
      const dx = b.x - p.x, dz = b.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (late === 0 && d <= LT.controlledNearDist && b.y <= LT.chaseReachHeight && IT[i]! <= LT.controlledNearTicks &&
        d < nearD) {
        near = i;
        nearD = d;
      }
    }
    SCORE[i] = sc;
    OK[i] = 1;
    if (sc < bestScore) { bestScore = sc; best = i; }
  }

  // ---- claims, then hysteresis
  let pick = rushingKeeper(s, team, first, end);
  if (pick < 0) pick = ownReceiver(s, team, first, end);
  if (pick < 0) pick = near;
  if (pick < 0) {
    const cur = t.chaser;
    const curOk = cur >= first && cur < end && OK[cur] === 1;
    if (best < 0) pick = curOk ? cur : fallbackChaser(s, team, first, end);
    else if (!curOk) pick = best;
    else if (best === cur) pick = cur;
    else {
      const bestCtl = s.players[best]!.ctrl >= 0 || userRush(s.players[best]!);
      const curCtl = s.players[cur]!.ctrl >= 0 || userRush(s.players[cur]!);
      const claim = bestCtl && !curCtl;
      const gain = SCORE[cur]! - bestScore;
      const need = claim ? 0 : T_AI.chaserHysteresisTicks;
      const mayLeave = claim || t.chaserT >= T_AI.chaserMinTicks || busyTicks(s.players[cur]!) > T_AI.chaserHysteresisTicks;
      pick = gain >= need && mayLeave ? best : cur;
    }
  }

  if (pick !== t.chaser) { t.chaser = pick; t.chaserT = 0; } else if (t.chaserT < 1e9) t.chaserT++;

  // ---- job for an AI chaser
  if (pick >= 0 && isJobDriven(s, pick)) {
    if (OK[pick] !== 1) evalIntercept(s, pick);
    const top = s.attrs[pick]!.topSpeed;
    assignJob(s, pick, AiJob.CHASE_LOOSE, clampTo(finiteOr(IX[pick]!, b.x), TGT_MAX_X),
      clampTo(finiteOr(IZ[pick]!, b.z), TGT_MAX_Z), top > 0 ? top : T_PLAYER.topSpeedMin, -1);
  }
}

// ---------------------------------------------------------------- steering

/** True if another active player's centre is within occupiedRadius of (x, z). */
function targetOccupied(s: SimState, slot: number, x: number, z: number): boolean {
  const r2 = LT.occupiedRadius * LT.occupiedRadius;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - x, dz = q.z - z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

/** Turn the player's final job into a movement intent. */
function steerJob(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const job = p.job;
  const b = s.ball;
  const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  const jog = top * T_PLAYER.jogFraction;
  let tx = clampTo(finiteOr(p.tgtX, p.x), TGT_MAX_X);
  let tz = clampTo(finiteOr(p.tgtZ, p.z), TGT_MAX_Z);
  if (BALL_JOB[job] === 1 && b.owner < 0 && b.heldBy < 0) {
    const bv = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (bv > LT.overshootMinSpeed && (b.x - p.x) * b.vx + (b.z - p.z) * b.vz > 0) {
      let o = bv * LT.overshootSec;
      if (o < LT.overshootMin) o = LT.overshootMin;
      if (o > LT.overshootMax) o = LT.overshootMax;
      tx = clampTo(tx + (b.vx / bv) * o, TGT_MAX_X);
      tz = clampTo(tz + (b.vz / bv) * o, TGT_MAX_Z);
    }
  }
  let req = p.tgtSpeed;
  if (!Number.isFinite(req)) req = jog;
  if (req < 0) req = 0;
  if (req > top) req = top;
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const ballJob = BALL_JOB[job] === 1;
  const face = FACE_BALL[job] === 1 ? 1 : 0;
  p.tgtX = tx;
  p.tgtZ = tz;
  p.lookX = b.x;
  p.lookZ = b.z;

  if (EXACT_JOB[job] !== 1) {
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    const atRest = sp <= LT.restSpeed && (d > 1e-9 ? (p.vx * dx + p.vz * dz) / d : 0) <= LT.approachSpeed;
    let hold = atRest && d <= LT.deadZone;
    if (!hold && d <= LT.occupiedStopDist + (atRest ? LT.occupiedHoldExtra : 0) && targetOccupied(s, slot, tx, tz)) {
      hold = true;
    }
    if (hold) {
      p.moveMode = MoveMode.STOP;
      p.tgtSpeed = req < jog ? req : jog;
      p.wantSprint = 0;
      p.lookAt = face;
      return;
    }
  }

  const urgent = URGENT[job] === 1;
  const sd = urgent ? LT.sprintDistUrgent : LT.sprintDistCalm;
  const sprint = req > jog * 1.0001 && (d > sd || (p.wantSprint === 1 && d > sd * 0.5));
  p.moveMode = MoveMode.ARRIVE;
  p.tgtSpeed = req;
  p.wantSprint = sprint ? 1 : 0;
  // [QF-2] Not while a body blocks the way: SIM-05's slide-around ignores a player holding a facing, so a marker 2-3 m
  // from his spot pushed into the man standing on his line for ever (glitch "run in place against each other").
  p.lookAt = ballJob ? (d <= LT.ballJobFaceDist ? 1 : 0)
    : (face === 1 && d <= LT.faceBallDist && !pathBlocked(s, slot, dx, dz, d) ? 1 : 0);
}

/**
 * [QF-2] True if another active player's body touches `slot` on his way to the target (centre within blockedDist and
 * within acos(blockedCos) of the direction (dx, dz) / d).
 */
function pathBlocked(s: SimState, slot: number, dx: number, dz: number, d: number): boolean {
  if (!(d > 1e-6)) return false;
  const p = s.players[slot]!;
  const ux = dx / d, uz = dz / d;
  const r2max = LT.blockedDist * LT.blockedDist;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const rx = q.x - p.x, rz = q.z - p.z;
    const r2 = rx * rx + rz * rz;
    if (r2 > r2max || r2 < 1e-12) continue;
    if (rx * ux + rz * uz >= LT.blockedCos * Math.sqrt(r2)) return true;
  }
  return false;
}

export function executeJobs(s: SimState, team: number, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) clearChaser(s, team);
  const first = teamFirstSlot(team);
  const end = first + PLAYERS_PER_TEAM;
  for (let i = first; i < end; i++) {
    if (!isJobDriven(s, i)) continue;
    const p = s.players[i]!;
    if (p.job > AiJob.NONE && p.job < N_JOBS && !isMovementLocked(p)) steerJob(s, i);
    finalizeJobT(s, i);
  }
}

/**
 * Set slot to arrive at (x, z) with speed cap (m/s), facing the ball when close.
 * Plain arrival intent (no dead zone, so keepers can position precisely): ARRIVE at the target clamped inside the
 * boards, tgtSpeed = speed clamped to [0, top] (NaN -> jog), wantSprint when the cap is above jog speed, lookAt the
 * ball within faceBallDist. No-op for an inactive player or one whose action owns his movement.
 */
export function arrive(s: SimState, slot: number, x: number, z: number, speed: number): void {
  if (!(slot >= 0 && slot < NUM_SLOTS)) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || isMovementLocked(p)) return;
  const a = s.attrs[slot]!;
  const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  const jog = top * T_PLAYER.jogFraction;
  const tx = clampTo(finiteOr(x, p.x), TGT_MAX_X);
  const tz = clampTo(finiteOr(z, p.z), TGT_MAX_Z);
  let sp = Number.isFinite(speed) ? speed : jog;
  if (sp < 0) sp = 0;
  if (sp > top) sp = top;
  const dx = tx - p.x, dz = tz - p.z;
  p.moveMode = MoveMode.ARRIVE;
  p.tgtX = tx;
  p.tgtZ = tz;
  p.tgtSpeed = sp;
  p.wantSprint = sp > jog * 1.0001 ? 1 : 0;
  p.lookAt = dx * dx + dz * dz <= LT.faceBallDist * LT.faceBallDist ? 1 : 0;
  p.lookX = s.ball.x;
  p.lookZ = s.ball.z;
}

/** Exposed for tests and tuning tools (read-only). */
export const STEER_TUNING = LOCAL_TUNING;

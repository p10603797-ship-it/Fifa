/**
 * [TAI-11] CPU defending: picks which defender to control (via gesture TAP on a teammate or SWITCH), jockeys
 * (SHIELD hold), contains (PASS hold), times tackles after a reaction delay (TAI-12 tackleTimingTicks,
 * brain.tackleCd), calls the second defender (MOD_R hold), rushes the keeper when sensible, occasionally fouls.
 * Writes only the CPU InputFrame.
 *
 * cpuThink (lead) calls cpuDefend for a CPU-driven team every IN_PLAY tick its team does not own the ball: an opponent
 * carrier at his feet, the ball in the opponent keeper's hands, AND every loose ball (also our own pass in flight).
 * Everything is expressed as the frame a human could produce (stick, held buttons, one-tick presses, a pitch tap);
 * SIM-15 resolves it exactly like a human frame and SIM-16 does the switching. Never reads human inputs.
 *
 * Per call (controller c = CPU_CONTROLLER_BASE + team, its player p = ctrl.slot from last tick):
 *  0. Brain upkeep: tackleCd counts down; the situation key (ball owner / keeper in hands / -1 loose) is compared with
 *     brain.seenOwner and a change starts the reaction delay brain.reactT = levelParams(level).reactionTicks (same
 *     semantics as TAI-08, so the two modules share these fields).
 *  1. Our pass in flight: neutral stick so SIM-15 moves the receiver (SIM-16 already switched to him) to meet the
 *     ball; SPRINT held when an opponent can contest the reception. A ball rolling away from the receiver (ahead of him,
 *     moving away: overhit, or past his meeting point) is run onto with the stick at full speed + SPRINT (an arrival
 *     into a target that moves away would leave him trailing it). No reaction delay (it is our own pass).
 *  2. Reaction delay running (reactT > 0): keep the current run (stick along his velocity), no buttons.
 *  3. Opponent carrier at his feet (the main case):
 *     - Player choice (every switchEvalTicks, staggered by team, only when SIM-16's lock-out is over and the current
 *       defender is not already engaged goal-side): score = SIM-04 ticksToReach to the guard point + busy ticks +
 *       notGoalSidePenalty. The best-placed defender beats the current one by switchMarginTicks (more at noisy levels)
 *       -> MOD_L press when SIM-16's next-switch marker is (about) as good, else a gesture TAP on him (gSlot).
 *     - Approach goal-side with the stick: the guard point is standoff (by pressIntensity) goal-side of the carrier
 *       (on the line to the centre of our goal), led by his velocity (look-ahead capped by lookAheadTicks). Not yet
 *       goal-side: a recovery point deeper and to his side of the carrier, sprinting. Arrival ramp near the point.
 *     - Contain (PASS held) when he dribbles at speed (containSpeed) and we are goal-side within containDist.
 *     - Jockey (SHIELD held) when goal-side within jockeyDist (~3 m); sprint jockey when he is quick.
 *     - Second defender (MOD_R held) while he is in our final third (secondDefDist from our goal line).
 *     - Keeper rush (THROUGH held) on a clear one-on-one close to goal (no outfield cover in the channel, keeper free;
 *       an AI come-out already running is left alone).
 *     - Standing tackle (SHOOT press, one tick, MOD_R released so it is not a hard tackle) only when SIM-15 would make
 *       it a STAND_TACKLE or SHOULDER (never from behind), the player is free, brain.tackleCd is 0, and the ball is
 *       exposed: in the carrier's skill vulnerable window (SIM-13), in his first-touch window, away from his feet
 *       between touches (exposeDist), or while he turns. Timing: the exposure must be at least tackleTimingTicks old
 *       (TAI-12: 14 at Beginner .. 3 at Legend) and the ball within reach; a careful CPU also predicts that the ball is
 *       still exposed and in reach at the contact tick; a noisy one (decisionNoise, one draw per exposure window)
 *       lunges anyway. Rarely (decisionNoise x rashLungeChance per rashBucketTicks) a CPU lunges at a carrier whose
 *       ball is at his feet. Mistimed tackles are what make fouls: nothing scripts a card.
 *     - Slide (LOB press) only when goal-side, the ball loose-ish (between touches, beyond standing reach but within
 *       slide reach) in our half, one draw per window; from behind only for a carrier through on goal in our third
 *       with a tiny chance (slideBehindChance x decisionNoise).
 *  4. Ball in the opponent keeper's hands: drift back toward the home position (TAI-01 p.homeX/homeZ).
 *  5. Opponent pass in flight: intercept in the lane (TAI-07 estimateIntercept) when we get there clearly before the
 *     receiver, else stand goal-side of the reception point (ball.passX/Z).
 *  6. Other loose balls: when the controlled player is the team's chaser (TAI-07 team.chaser, or no other valid
 *     AI-driven chaser) he goes for it: the stick on the interception point (the ball itself when close) at full speed,
 *     no arrival ramp into a moving ball, sprinting when far — the team AI never moves a controlled player, so without
 *     this nobody would chase. When another AI-driven teammate is the chaser he covers goal-side of the ball instead
 *     (exactly one chaser per team). In our own third with an opponent close, a
 *     ball about to reach him (SIM-15 ballEta <= clearEtaTicks) or a header / volley chance is cleared (SHOOT, which
 *     SIM-15 turns into a clearance in the own third).
 * Decision noise draws are a stateless integer hash of (match seed, team, carrier, decision window): deterministic,
 * one draw per window (no per-tick re-rolls) and the shared sim RNG stream is left untouched.
 *
 * Brain fields written: tackleCd, reactT, seenOwner (nothing else in the state). Frame fields written: mx, mz,
 * buttons, gesture, gSlot, gx, gz.
 * Determinism / cost: + - * / sqrt and Math.imul only; slot-order loops; module scratch rewritten every call; no
 * allocation. Per call O(11) plus, on a switch evaluation tick, 10 SIM-04 ticksToReach estimates.
 */
import {
  CPU_CONTROLLER_BASE, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PITCH_LENGTH, PLAYERS_PER_TEAM, TICK_HZ, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, ControllerKind, GestureKind, MatchPhase, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, type InputFrame } from '../../contracts/input';
import type { ControllerState, CpuBrainState, PlayerState, SimState } from '../../contracts/state';
import type { LevelParams } from '../../contracts/systems';
import { T_PLAYER, T_SKILL, T_TACKLE, T_TOUCH } from '../../contracts/tuning';
import { isFree } from '../../sim/actions/dispatch';
import { tackleKind } from '../../sim/control/resolveActions';
import { ballEta, controlContext, Ctx } from '../../sim/control/resolveShared';
import { aerialChance } from '../../sim/kicks/aerial';
import { inSkillVulnerableWindow } from '../../sim/kicks/skills';
import { ticksToReach } from '../../sim/players/locomotion';
import { createInterceptEstimate, estimateIntercept } from '../steer';
import { levelParams } from './levels';

export const LOCAL_TUNING = {
  // ---- approach and jockey
  /** Guard point distance goal-side of the carrier at pressIntensity 0 / 1, m. */
  standoffLow: 2.4,
  standoffHigh: 1.6,
  /** Goal-side: cos(carrier->defender, carrier->own goal centre) at or above this (mirrors SIM-15 goalSideCos). */
  goalSideCos: 0.3,
  /** From behind: that cosine at or below this (mirrors SIM-15 chaseCos). */
  behindCos: -0.2,
  /** Guard-point lead: carrier velocity x min(distance / leadRefSpeed, lookAheadTicks x leadLookAheadFrac / 60), s. */
  leadRefSpeed: 8.0,
  leadLookAheadFrac: 0.5,
  /** Not goal-side: recovery point this much deeper than the guard point and this far to his side of the carrier, m. */
  recoverDepth: 2.5,
  recoverSide: 1.5,
  /** Stick magnitude ramps from 0 at the target to full at this distance (arrival), m. */
  arriveDist: 2.0,
  /** Sprint toward a target farther than this, m. */
  sprintDist: 6.0,
  /** SPRINT is only held with at least this stick magnitude (an idle stick + SPRINT means "press" in SIM-15), 0..1. */
  sprintMinStick: 0.3,
  /** Jockey (SHIELD held) when goal-side within this distance of the carrier, m; keep it up to jockeyKeepDist. */
  jockeyDist: 3.0,
  jockeyKeepDist: 3.6,
  /** Sprint jockey when the carrier is faster than this fraction of the defender's jog speed. */
  sprintJockeyFrac: 0.9,
  // ---- contain
  /** Contain (PASS held) when the carrier dribbles faster than this (keep down to containKeepSpeed), m/s ... */
  containSpeed: 6.0,
  containKeepSpeed: 5.0,
  /** ... and the defender is within this distance and not behind him (cos >= behindCos), m. */
  containDist: 8.0,
  // ---- second defender
  /** Call the second defender (MOD_R held) while the carrier is within this distance of our goal line (final third),
   *  keep calling up to secondDefKeepDist, m. */
  secondDefDist: PITCH_LENGTH / 3,
  secondDefKeepDist: PITCH_LENGTH / 3 + 4,
  // ---- keeper rush
  /** One-on-one: carrier within this distance of our goal centre to start the rush (keep holding up to rushKeepDist), m. */
  rushStartDist: 14,
  rushKeepDist: 20,
  /** ... with |z| at most this (not at a tight angle), m ... */
  rushMaxAbsZ: 12,
  /** ... not running away from goal faster than this, m/s ... */
  rushAwaySpeed: 0.5,
  /** ... and no outfield teammate in the channel to goal: lateral offset below coverChannel + along x coverWiden, m. */
  coverChannel: 2.0,
  coverWiden: 0.15,
  // ---- player choice (switching)
  /** Evaluate the best-placed defender every this many ticks (staggered by team). */
  switchEvalTicks: 6,
  /** Switch when the best beats the current defender by this many ticks (x (1 + decisionNoise x switchNoiseMul)). */
  switchMarginTicks: 15,
  switchNoiseMul: 2,
  /** Use MOD_L (SIM-16's choice) when its marked next switch is within this of the best score, ticks. */
  switchFineTicks: 8,
  /** Penalty for a candidate who is not goal-side of the carrier, ticks. */
  notGoalSidePenalty: 30,
  /** Goal-side for the choice: at least this much nearer our goal line than the carrier, m. */
  goalSideMargin: 0.5,
  /** The current defender is engaged (never switched away) goal-side within this distance of the carrier, m. */
  engagedDist: 4.5,
  // ---- tackles
  /** The ball is exposed between touches when farther than this from the carrier's centre, m. */
  exposeDist: 0.7,
  /** A careful tackle wants the predicted ball at least this fraction of exposeDist from the carrier at contact. */
  exposeAtContactFrac: 0.8,
  /** Turning: the carrier moves faster than this, m/s ... */
  turnMinSpeed: 1.5,
  /** ... with cos(velocity, facing) below this. */
  turnCos: 0.6,
  /** Standing tackle: ball within standReach + this of the defender now, m. */
  tackleApproach: 0.4,
  /** Rash lunge at a carrier with the ball at his feet: chance per rashBucketTicks = decisionNoise x this. */
  rashLungeChance: 0.5,
  rashBucketTicks: 30,
  /** Slide: ball between standReach and slideReach x slideReachFrac of the defender, m (fraction). */
  slideReachFrac: 0.85,
  /** Slide only when the ball is in our half: carrier within this distance of our goal line, m. */
  slideZoneDist: HALF_LENGTH,
  /** Goal-side slide (urgent: carrier quicker than our jog, or in our final third): chance per exposure window. */
  slideChance: 0.15,
  /** From behind: carrier through on goal within this distance of our goal centre; chance x decisionNoise per window. */
  slideBehindDist: 25,
  slideBehindChance: 0.2,
  // ---- loose balls
  /** Clear (SHOOT in our own third) a ball reaching him within this many ticks (<= SIM-16 aboutToReceive), ticks ... */
  clearEtaTicks: 15,
  /** ... with an opponent within this distance of him or of the ball, m. */
  clearPressureDist: 6.0,
  /** Own third: progress (-1 own goal line .. +1) below this (mirrors SIM-15 ownThirdProgress). */
  ownThirdProgress: -1 / 3,
  /** Intercept an opponent pass when we reach the lane this many ticks before the receiver, ticks. */
  interceptMarginTicks: 4,
  /** Our pass in flight: hold SPRINT when an opponent is within this distance of the reception point, m. */
  contestDist: 8.0,
  /** Our pass rolling away from its receiver (ahead of him, faster than this): he runs onto it with the stick, m/s ... */
  trailMinSpeed: 1.5,
  /** ... aiming this far ahead along the ball's velocity, s. */
  trailLeadSec: 0.15,
  /** Loose-ball chase: sprint when the interception point is farther than this, m ... */
  chaseSprintDist: 3.0,
  /** ... aim at the ball itself within this distance of it, m ... */
  chaseBallDist: 1.5,
  /** ... full stick (no arrival ramp) unless he reaches the interception point this many ticks before the ball (then
   *  he arrives and waits: no orbiting a landing spot), or the close ball is slower than chaseSlowBall or coming to
   *  him; a slowed approach keeps at least chaseMinStick (above the stick dead zone) until within chaseHoldDist.
   *  ticks / m/s / 0..1 / m. */
  chaseEarlyTicks: 8,
  chaseSlowBall: 1.0,
  chaseMinStick: 0.4,
  chaseHoldDist: 0.4,
  /** Loose ball another teammate chases (team.chaser): the controlled player covers this far goal-side of it, m. */
  looseCoverDist: 7.0,
  /** Reaction delay: keep running along the current velocity when faster than this, m/s. */
  momentumMinSpeed: 0.3,
} as const; // TUNING-CR

const L = LOCAL_TUNING;
const BIG = 1e9;
const EPS = 1e-6;
/** Target clamp: never behind our own goal line; a little room past the touchlines. */
const TGT_X = HALF_LENGTH - 0.3;
const TGT_Z = HALF_WIDTH + 0.5;
const POS_MAX = 1023;

// ---------------------------------------------------------------- module scratch (rewritten every call)

const IE = createInterceptEstimate();
const IE2 = createInterceptEstimate();
/** Switch scores per slot (valid for the team evaluated in the current call). */
const SCORE = new Float64Array(NUM_SLOTS);
/** Stick being built: unit direction and magnitude 0..1; buttons; sprint wish. */
let stX = 0;
let stZ = 0;
let stM = 0;
let btn = 0;
let wantSprint = 0;
/** Exposure of the carrier's ball (exposure()): 1/0, age in ticks, window key, 1 = skill / first-touch window. */
let expOn = 0;
let expAge = 0;
let expKey = 0;
let expSkill = 0;
/** Goal-side unit of the latest carrier evaluation (defendCarrier): from the carrier toward our goal centre. */
let gX = 0;
let gZ = 0;

// ---------------------------------------------------------------- small helpers

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot);
}

/** Deterministic hash of three integers -> [0, 1). One "draw" per decision window, no RNG stream use. */
export function noise01(a: number, b: number, c: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15) ^ (b | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Point the stick at (tx, tz) from p with the arrival ramp; sprint when far. Targets are clamped to the pitch. */
function steerTo(p: Readonly<PlayerState>, tx0: number, tz0: number, sprintFar: number): void {
  const tx = tx0 < -TGT_X ? -TGT_X : tx0 > TGT_X ? TGT_X : tx0;
  const tz = tz0 < -TGT_Z ? -TGT_Z : tz0 > TGT_Z ? TGT_Z : tz0;
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > EPS)) { stX = 0; stZ = 0; stM = 0; return; }
  stX = dx / d;
  stZ = dz / d;
  stM = d >= L.arriveDist ? 1 : d / L.arriveDist;
  if (sprintFar === 1 && d > L.sprintDist) wantSprint = 1;
}

/** Keep the current run (reaction delay): stick along the velocity, magnitude by speed over jog. */
function momentum(s: SimState, p: Readonly<PlayerState>): void {
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (!(sp > L.momentumMinSpeed)) return;
  const jog = s.attrs[p.slot]!.topSpeed * T_PLAYER.jogFraction;
  stX = p.vx / sp;
  stZ = p.vz / sp;
  stM = jog > EPS && sp < jog ? sp / jog : 1;
  if (p.sprinting === 1) wantSprint = 1;
}

/** Write the built stick and buttons into the frame (radial magnitude <= AXIS_SCALE). */
function flush(out: InputFrame): void {
  let m = stM;
  if (!(m > 0) || !(stX === stX) || !(stZ === stZ)) m = 0;
  if (m > 1) m = 1;
  out.mx = Math.trunc(stX * m * AXIS_SCALE);
  out.mz = Math.trunc(stZ * m * AXIS_SCALE);
  if (wantSprint === 1 && m >= L.sprintMinStick) btn |= Btn.SPRINT;
  out.buttons |= btn;
}

function quantPos(v: number): number {
  const q = Math.round(v * GESTURE_POS_SCALE);
  return q < -POS_MAX ? -POS_MAX : q > POS_MAX ? POS_MAX : q;
}

/** Busy ticks ticksToReach does not count: stun and the rest of an action that does not lock movement. */
function busyTicks(p: Readonly<PlayerState>): number {
  let t = p.stunT > 0 ? p.stunT : 0;
  if (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD && p.moveMode !== 3 /* MoveMode.LOCKED */) {
    const r = p.actDur - p.actT;
    if (r > 0) t += r;
  }
  return t;
}

/** Nearest active opponent of `team` to (x, z): distance (BIG if none). */
function nearestOpponentDist(s: SimState, team: number, x: number, z: number): number {
  const first = teamFirstSlot(team === 0 ? 1 : 0);
  let best = BIG * BIG;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - x, dz = q.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best >= BIG * BIG ? BIG : Math.sqrt(best);
}

// ---------------------------------------------------------------- brain upkeep

/** Countdowns and the reaction delay on a situation change (ball owner / keeper in hands / loose = -1). */
function tickBrain(s: SimState, brain: CpuBrainState, lv: LevelParams): void {
  if (brain.tackleCd > 0) brain.tackleCd = brain.tackleCd > 1 ? brain.tackleCd - 1 : 0;
  else brain.tackleCd = 0;
  const b = s.ball;
  const key = b.heldBy >= 0 ? b.heldBy : b.owner >= 0 ? b.owner : -1;
  if (key !== brain.seenOwner) {
    brain.seenOwner = key;
    brain.reactT = lv.reactionTicks > 0 ? lv.reactionTicks : 0;
  } else if (brain.reactT > 0) {
    brain.reactT = brain.reactT > 1 ? brain.reactT - 1 : 0;
  } else {
    brain.reactT = 0;
  }
}

// ---------------------------------------------------------------- exposure of the carrier's ball

/**
 * Is the carrier's ball exposed now? Sets expOn, expAge (ticks since the exposure began), expKey (decision window id)
 * and expSkill (skill / first-touch window).
 */
function exposure(s: SimState, q: Readonly<PlayerState>): void {
  expOn = 0; expAge = 0; expKey = 0; expSkill = 0;
  if (inSkillVulnerableWindow(s, q.slot)) {
    const k = q.act === ActionKind.FAKE ? SkillMove.FAKE_SHOT : q.actSkill;
    const vs = k > 0 && k < T_SKILL.vulnStart.length ? T_SKILL.vulnStart[k]! : 0;
    expOn = 1; expSkill = 1;
    expAge = q.actT - vs;
    expKey = s.tick - q.actT;
    return;
  }
  if (q.act === ActionKind.FIRST_TOUCH) {
    expOn = 1; expSkill = 1;
    expAge = q.actT;
    expKey = s.tick - q.actT;
    return;
  }
  const b = s.ball;
  const dx = b.x - q.x, dz = b.z - q.z;
  const away = dx * dx + dz * dz > L.exposeDist * L.exposeDist;
  let turning = false;
  const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
  // A shielding carrier strafes facing the opponent on purpose (SIM-05): that is not a turn.
  if (qs > L.turnMinSpeed && q.act !== ActionKind.SHIELD) turning = (q.vx * q.fx + q.vz * q.fz) / qs < L.turnCos;
  if (!away && !turning) return;
  expOn = 1;
  const lt = q.lastTouchTick >= 0 ? q.lastTouchTick : (b.lastTouchTick >= 0 ? b.lastTouchTick : s.tick - 1000);
  expAge = s.tick - lt;
  expKey = lt;
}

/**
 * Careful timing: at mid-contact of a standing tackle (wind-up + half the contact window) the ball (linear) is within
 * standReach of the defender (keeping his velocity) and still exposed (skill window open, or away from the carrier).
 */
function wellTimed(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>): boolean {
  const ct = T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1);
  const t = ct / TICK_HZ;
  const b = s.ball;
  const bx = b.x + b.vx * t, bz = b.z + b.vz * t;
  const px = p.x + p.vx * t, pz = p.z + p.vz * t;
  const dx = bx - px, dz = bz - pz;
  if (dx * dx + dz * dz > T_TACKLE.standReach * T_TACKLE.standReach) return false;
  if (expSkill === 1) {
    if (q.act === ActionKind.FIRST_TOUCH) return q.actT + ct < (q.actDur > 0 ? q.actDur : T_TOUCH.firstTouchTicks);
    const k = q.act === ActionKind.FAKE ? SkillMove.FAKE_SHOT : q.actSkill;
    return k > 0 && k < T_SKILL.vulnEnd.length && q.actT + ct < T_SKILL.vulnEnd[k]!;
  }
  const qx = q.x + q.vx * t, qz = q.z + q.vz * t;
  const ex = bx - qx, ez = bz - qz;
  const lim = L.exposeDist * L.exposeAtContactFrac;
  return ex * ex + ez * ez >= lim * lim;
}

// ---------------------------------------------------------------- player choice

/**
 * Player choice against carrier q (guard point tx/tz): scores every candidate (SCORE) and, when the best-placed one
 * beats the current defender by the margin, switches: MOD_L press when SIM-16's next-switch marker is (about) as good,
 * else a gesture TAP on him. Returns the slot that moves this tick: the new player for MOD_L (SIM-16 applies it before
 * movement), else `cur` (a TAP is resolved after movement).
 */
function chooseDefender(
  s: SimState, team: number, ci: number, ctl: ControllerState, lv: LevelParams, cur: number, q: Readonly<PlayerState>,
  tx: number, tz: number, out: InputFrame,
): number {
  const dir = s.teams[team]!.dir;
  const qDepth = -dir * q.x; // larger = nearer our goal line
  const first = teamFirstSlot(team);
  let best = -1;
  let bestScore = BIG;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    SCORE[i] = BIG;
    const c = s.players[i]!;
    if (c.active !== 1 || c.isKeeper === 1) continue;
    if (c.ctrl >= 0 && c.ctrl !== ci) continue;
    let sc = ticksToReach(s, i, tx, tz) + busyTicks(c);
    if (-dir * c.x < qDepth + L.goalSideMargin) sc += L.notGoalSidePenalty;
    SCORE[i] = sc;
    if (sc < bestScore) { bestScore = sc; best = i; }
  }
  if (best < 0 || best === cur) return cur;
  const margin = L.switchMarginTicks * (1 + lv.decisionNoise * L.switchNoiseMul);
  if (!(bestScore + margin < SCORE[cur]!)) return cur;
  const ns = ctl.nextSwitch;
  if (validSlot(ns) && ns !== cur && s.players[ns]!.team === team && SCORE[ns]! <= bestScore + L.switchFineTicks) {
    btn |= Btn.MOD_L;
    return ns;
  }
  const t = s.players[best]!;
  out.gesture = GestureKind.TAP;
  out.gSlot = best;
  out.gx = quantPos(t.x);
  out.gz = quantPos(t.z);
  return cur;
}

// ---------------------------------------------------------------- keeper rush

/**
 * Through on goal: carrier within maxDist of our goal centre, not at a tight angle, not running away from goal, and no
 * outfield teammate covering the channel between him and the goal.
 */
export function throughOnGoal(s: SimState, team: number, q: Readonly<PlayerState>, maxDist: number): boolean {
  const dir = s.teams[team]!.dir;
  const gx = -dir * HALF_LENGTH - q.x, gz = -q.z;
  const dGoal = Math.sqrt(gx * gx + gz * gz);
  if (dGoal > maxDist || !(dGoal > EPS)) return false;
  if (q.z > L.rushMaxAbsZ || q.z < -L.rushMaxAbsZ) return false;
  const ux = gx / dGoal, uz = gz / dGoal;
  if (q.vx * ux + q.vz * uz < -L.rushAwaySpeed) return false;
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const c = s.players[i]!;
    if (c.active !== 1 || c.isKeeper === 1) continue;
    const rx = c.x - q.x, rz = c.z - q.z;
    const along = rx * ux + rz * uz;
    if (along <= 0 || along >= dGoal) continue;
    const lat = rx * uz - rz * ux;
    const ch = L.coverChannel + along * L.coverWiden;
    if (lat <= ch && lat >= -ch) return false;
  }
  return true;
}

function keeperRush(s: SimState, team: number, ctl: ControllerState, q: Readonly<PlayerState>): void {
  const k = s.teams[team]!.keeperSlot;
  if (!validSlot(k)) return;
  const kp = s.players[k]!;
  if (kp.active !== 1 || kp.team !== team) return;
  const holding = (ctl.buttons & Btn.THROUGH) !== 0;
  if (holding) {
    if ((kp.act === ActionKind.GK_RUSH || isFree(kp)) && throughOnGoal(s, team, q, L.rushKeepDist)) btn |= Btn.THROUGH;
    return;
  }
  // Start only from a free keeper: an AI come-out already running (GKP-03) is left alone.
  if (isFree(kp) && throughOnGoal(s, team, q, L.rushStartDist)) btn |= Btn.THROUGH;
}

// ---------------------------------------------------------------- the carrier

function defendCarrier(
  s: SimState, team: number, ci: number, ctl: ControllerState, brain: CpuBrainState, lv: LevelParams,
  p0: PlayerState, carrier: number, out: InputFrame,
): void {
  const q = s.players[carrier]!;
  const dir = s.teams[team]!.dir;
  // Unit from the carrier toward the centre of our goal.
  let gx = -dir * HALF_LENGTH - q.x, gz = -q.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > EPS) { gx /= gl; gz /= gl; } else { gx = -dir; gz = 0; }
  gX = gx; gZ = gz;
  const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
  const standoff = L.standoffLow + (L.standoffHigh - L.standoffLow) * (lv.pressIntensity < 0 ? 0 : lv.pressIntensity > 1 ? 1 : lv.pressIntensity);

  // Guard point for player choice: from the current player's distance.
  let d0x = p0.x - q.x, d0z = p0.z - q.z;
  let d0 = Math.sqrt(d0x * d0x + d0z * d0z);
  const leadCap = (lv.lookAheadTicks * L.leadLookAheadFrac) / TICK_HZ;
  let lead = d0 / L.leadRefSpeed;
  if (lead > leadCap) lead = leadCap;
  const guardX = q.x + q.vx * lead + gx * standoff;
  const guardZ = q.z + q.vz * lead + gz * standoff;

  let slot = p0.slot;
  let switched = false;
  const cos0 = d0 > EPS ? (d0x * gx + d0z * gz) / d0 : 1;
  const engaged = cos0 >= L.goalSideCos && d0 <= L.engagedDist;
  if (!engaged && ctl.switchLockT === 0 && brain.reactT === 0 && (s.tick + team * 3) % L.switchEvalTicks === 0) {
    const mover = chooseDefender(s, team, ci, ctl, lv, slot, q, guardX, guardZ, out);
    if (mover !== slot) { slot = mover; switched = true; }
    else if (out.gesture !== GestureKind.NONE) switched = true;
  }
  const p = s.players[slot]!;
  if (slot !== p0.slot) {
    d0x = p.x - q.x; d0z = p.z - q.z;
    d0 = Math.sqrt(d0x * d0x + d0z * d0z);
    lead = d0 / L.leadRefSpeed;
    if (lead > leadCap) lead = leadCap;
  }
  const d = d0;
  const cosG = d > EPS ? (d0x * gx + d0z * gz) / d : 1;
  const goalSide = cosG >= L.goalSideCos;

  // Approach: the guard point when goal-side, blending continuously (no target jump at the boundary) into the
  // recovery point (deeper, to his side of the carrier) as he gets behind; sprinting while recovering.
  const lx = q.x + q.vx * lead, lz = q.z + q.vz * lead;
  let w = (L.goalSideCos - cosG) / (L.goalSideCos - L.behindCos);
  w = w < 0 ? 0 : w > 1 ? 1 : w;
  const side = d0x * -gz + d0z * gx >= 0 ? 1 : -1;
  const depth = standoff + L.recoverDepth * w;
  const off = L.recoverSide * w * side;
  steerTo(p, lx + gx * depth - gz * off, lz + gz * depth + gx * off, 1);
  if (w > 0) wantSprint = 1;

  // Contain / jockey.
  const jogP = s.attrs[slot]!.topSpeed * T_PLAYER.jogFraction;
  const wasContain = (ctl.buttons & Btn.PASS) !== 0;
  const wasJockey = (ctl.buttons & Btn.SHIELD) !== 0;
  if (cosG > L.behindCos && d <= L.containDist && qs >= (wasContain ? L.containKeepSpeed : L.containSpeed)) {
    btn |= Btn.PASS;
    wantSprint = 0;
  } else if (goalSide && d <= (wasJockey ? L.jockeyKeepDist : L.jockeyDist)) {
    btn |= Btn.SHIELD;
    wantSprint = qs > L.sprintJockeyFrac * jogP ? 1 : 0;
  }

  // Second defender in our final third.
  const goalLineDist = HALF_LENGTH + dir * q.x;
  if (goalLineDist <= ((ctl.buttons & Btn.MOD_R) !== 0 ? L.secondDefKeepDist : L.secondDefDist)) btn |= Btn.MOD_R;

  keeperRush(s, team, ctl, q);

  if (switched || brain.tackleCd > 0 || !isFree(p) || p.isKeeper === 1) return;
  if (controlContext(s, slot) !== Ctx.DEFENCE) return;
  const b = s.ball;
  const bx = b.x - p.x, bz = b.z - p.z;
  const dBall = Math.sqrt(bx * bx + bz * bz);
  const seed = s.config.seed | 0;
  const who = team * 64 + carrier;

  // Standing tackle / shoulder (never from behind: that would be a push or pull).
  const kind = tackleKind(s, p, carrier);
  if (kind === ActionKind.STAND_TACKLE || kind === ActionKind.SHOULDER) {
    exposure(s, q);
    if (expOn === 1) {
      if (expAge >= lv.tackleTimingTicks && dBall <= T_TACKLE.standReach + L.tackleApproach) {
        const rash = noise01(seed, who, expKey * 4 + 1) < lv.decisionNoise;
        if (rash || wellTimed(s, p, q)) { pressTackle(brain, lv); return; }
      }
    } else if (dBall <= T_TACKLE.standReach && goalSide) {
      const bucket = Math.floor(s.tick / L.rashBucketTicks);
      if (noise01(seed, who, bucket * 4 + 2) < lv.decisionNoise * L.rashLungeChance) { pressTackle(brain, lv); return; }
    }
  }

  // Slide: goal-side, the ball loose-ish (between touches), beyond standing reach, in our half and urgent (a quick
  // carrier or our final third), one draw per window; from behind only for a carrier through on goal, rarely.
  if (goalLineDist > L.slideZoneDist) return;
  exposure(s, q);
  if (expOn !== 1 || expSkill === 1 || expAge < lv.tackleTimingTicks) return;
  if (!(dBall > T_TACKLE.standReach && dBall <= T_TACKLE.slideReach * L.slideReachFrac)) return;
  const u = noise01(seed, who, expKey * 4 + 3);
  if (goalSide) {
    // The ball must be on our side of him (nearer to us than he is): never slide through the carrier to reach it.
    if (dBall < d && (qs > jogP || goalLineDist <= L.secondDefDist) && u < L.slideChance) pressSlide(brain, lv);
  } else if (cosG <= L.behindCos && throughOnGoal(s, team, q, L.slideBehindDist)) {
    if (u < L.slideBehindChance * lv.decisionNoise) pressSlide(brain, lv);
  }
}

function pressTackle(brain: CpuBrainState, lv: LevelParams): void {
  btn |= Btn.SHOOT;
  btn &= ~Btn.MOD_R; // R1 + Circle would be a hard tackle
  brain.tackleCd = T_TACKLE.standWindup + T_TACKLE.standContactTicks + T_TACKLE.standRecovery + lv.reactionTicks;
}

function pressSlide(brain: CpuBrainState, lv: LevelParams): void {
  btn |= Btn.LOB;
  brain.tackleCd = T_TACKLE.slideWindup + T_TACKLE.slideContactTicks + T_TACKLE.slideRecovery + lv.reactionTicks;
}

// ---------------------------------------------------------------- loose balls

/** SHOOT on a ball about to reach him in our own third with an opponent close (SIM-15 makes it a clearance). */
function maybeClear(s: SimState, team: number, brain: CpuBrainState, lv: LevelParams, p: Readonly<PlayerState>): void {
  if (brain.tackleCd > 0 || !isFree(p) || p.isKeeper === 1) return;
  if ((s.teams[team]!.dir * p.x) / HALF_LENGTH >= L.ownThirdProgress) return;
  const eta = ballEta(s, p.slot);
  const arriving = eta >= 0 && eta <= L.clearEtaTicks;
  if (!arriving && !(aerialChance(s, p.slot) > 0)) return;
  const b = s.ball;
  if (nearestOpponentDist(s, team, p.x, p.z) > L.clearPressureDist && nearestOpponentDist(s, team, b.x, b.z) > L.clearPressureDist) return;
  btn |= Btn.SHOOT;
  brain.tackleCd = lv.reactionTicks + T_TACKLE.standWindup;
}

/**
 * Our pass in flight: let SIM-15 move the receiver (idle stick: he meets the ball); sprint if an opponent can contest
 * the reception. When the ball is rolling away from him (it is ahead of him and moving away: overhit, or it slipped
 * past his meeting point) he runs onto it with the stick at full speed, sprinting, like a human chasing his pass.
 */
function ownPass(s: SimState, team: number, p: Readonly<PlayerState>): void {
  const b = s.ball;
  if (p.slot === b.passTarget) {
    const bv2 = b.vx * b.vx + b.vz * b.vz;
    if (bv2 > L.trailMinSpeed * L.trailMinSpeed && (b.x - p.x) * b.vx + (b.z - p.z) * b.vz > 0) {
      steerTo(p, b.x + b.vx * L.trailLeadSec, b.z + b.vz * L.trailLeadSec, 0);
      stM = 1;
      wantSprint = 1;
      return;
    }
  }
  if (nearestOpponentDist(s, team, b.passX, b.passZ) <= L.contestDist) {
    btn |= Btn.SPRINT; // idle stick + SPRINT: the receiver meets the ball at top speed
  }
}

function opponentPass(s: SimState, team: number, p: Readonly<PlayerState>): void {
  const b = s.ball;
  estimateIntercept(s, p.slot, IE);
  const recvT = estimateIntercept(s, b.passTarget, IE2);
  if (IE.inHorizon === 1 && IE.ballT + L.interceptMarginTicks <= recvT) {
    steerTo(p, IE.x, IE.z, 0);
    wantSprint = 1;
    return;
  }
  // Contest: goal-side of the reception point.
  const dir = s.teams[team]!.dir;
  let gx = -dir * HALF_LENGTH - b.passX, gz = -b.passZ;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > EPS) { gx /= gl; gz /= gl; } else { gx = -dir; gz = 0; }
  steerTo(p, b.passX + gx * L.standoffLow, b.passZ + gz * L.standoffLow, 1);
}

/**
 * Go for a loose ball (he is the team's chaser): the stick on the interception point (on the ball itself when close).
 * Full speed while the ball would otherwise get there first or roll away from him (an arrival ramp into a moving
 * target leaves him trailing it); he arrives and waits when he is early at the point, and walks onto a slow ball.
 * Sprints when the point is far.
 */
function chaseLoose(s: SimState, p: Readonly<PlayerState>): void {
  const b = s.ball;
  const bx = b.x - p.x, bz = b.z - p.z;
  const d2 = bx * bx + bz * bz;
  let tx: number, tz: number, rush: boolean;
  if (d2 <= L.chaseBallDist * L.chaseBallDist) {
    tx = b.x; tz = b.z;
    rush = b.vx * b.vx + b.vz * b.vz >= L.chaseSlowBall * L.chaseSlowBall && bx * b.vx + bz * b.vz > 0;
  } else {
    estimateIntercept(s, p.slot, IE);
    tx = IE.x; tz = IE.z;
    rush = IE.ballT - IE.playerT <= L.chaseEarlyTicks;
  }
  steerTo(p, tx, tz, 0);
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (stM > 0) {
    if (rush) stM = 1;
    else if (stM < L.chaseMinStick && d > L.chaseHoldDist) stM = L.chaseMinStick;
  }
  if (d > L.chaseSprintDist) wantSprint = 1;
}

/** A loose ball a teammate chases (team.chaser): cover goal-side of it instead of a second chase. */
function coverLoose(s: SimState, team: number, p: Readonly<PlayerState>): void {
  const b = s.ball;
  const dir = s.teams[team]!.dir;
  let gx = -dir * HALF_LENGTH - b.x, gz = -b.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > EPS) { gx /= gl; gz /= gl; } else { gx = -dir; gz = 0; }
  const c = gl < L.looseCoverDist ? gl * 0.5 : L.looseCoverDist;
  steerTo(p, b.x + gx * c, b.z + gz * c, 1);
}

/** True when the team's loose-ball chaser (TAI-07, last tick) is another active, AI-driven teammate. */
function otherChaser(s: SimState, team: number, slot: number): boolean {
  const ch = s.teams[team]!.chaser;
  if (!validSlot(ch) || ch === slot) return false;
  const c = s.players[ch]!;
  return c.active === 1 && c.team === team && c.ctrl < 0;
}

// ---------------------------------------------------------------- entry

export function cpuDefend(s: SimState, team: number, out: InputFrame, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY || (team !== 0 && team !== 1)) return;
  const brain = s.teams[team]!.cpu;
  const ci = CPU_CONTROLLER_BASE + team;
  const ctl = s.ctrl[ci];
  if (!ctl || ctl.kind !== ControllerKind.CPU || ctl.side !== team) return;
  const lv = levelParams(brain.level);
  tickBrain(s, brain, lv);
  stX = 0; stZ = 0; stM = 0; btn = 0; wantSprint = 0;
  const slot = ctl.slot;
  if (!validSlot(slot)) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== team || p.isKeeper === 1) return;
  const b = s.ball;
  if (b.inNet !== 0) return;
  const loose = b.owner < 0 && b.heldBy < 0;

  // 1. Our own pass in flight: neutral stick (SIM-15 receiver auto-collect), no reaction delay.
  if (loose && validSlot(b.passTarget) && b.lastTouchTeam === team && s.players[b.passTarget]!.team === team &&
      s.players[b.passTarget]!.active === 1) {
    ownPass(s, team, p);
    flush(out);
    return;
  }
  // 2. Reaction delay after a change of situation: keep the current run.
  if (brain.reactT > 0) {
    momentum(s, p);
    flush(out);
    return;
  }
  if (!loose) {
    if (b.heldBy >= 0) {
      // 4. Ball in the opponent keeper's hands: drift back toward the home position.
      if (validSlot(b.heldBy) && s.players[b.heldBy]!.team !== team) steerTo(p, p.homeX, p.homeZ, 0);
    } else if (validSlot(b.owner) && s.players[b.owner]!.team !== team) {
      defendCarrier(s, team, ci, ctl, brain, lv, p, b.owner, out);
    }
    flush(out);
    return;
  }
  // 5. Opponent pass in flight / 6. other loose balls.
  if (validSlot(b.passTarget) && b.lastTouchTeam !== team && s.players[b.passTarget]!.team !== team &&
      s.players[b.passTarget]!.active === 1) {
    opponentPass(s, team, p);
  } else if (otherChaser(s, team, slot)) {
    coverLoose(s, team, p);
  } else {
    chaseLoose(s, p);
  }
  maybeClear(s, team, brain, lv, p);
  flush(out);
}

/** Debug / tests: the switch score of each slot from the latest evaluation (BIG = not a candidate). */
export function debugSwitchScore(slot: number): number { return validSlot(slot) ? SCORE[slot]! : BIG; }
/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const DEFEND_TUNING = LOCAL_TUNING;
/** Goal-side unit of the latest carrier evaluation (tests). */
export function debugGoalSideUnit(o: { x: number; z: number }): void { o.x = gX; o.z = gZ; }

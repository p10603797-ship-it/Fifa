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
 *     into a target that moves away would leave him trailing it). No reaction delay (it is our own pass). [QF-13
 *     skeptic] When the trap would settle the ball at a touchline / goal line, the stick turns into the pitch on the
 *     tick SIM-07 takes the ball (receiveTurn; also branch 6), so the trap does not settle it over the line.
 *  2. Reaction delay running (reactT > 0): keep the current run (stick along his velocity), no buttons.
 *  3. Opponent carrier at his feet (the main case):
 *     - Player choice (every switchEvalTicks, staggered by team, only when SIM-16's lock-out is over and the current
 *       defender is not already engaged goal-side, nor committed to a tackle / header / kick that will still play the
 *       ball, committedToBall): score = SIM-04 ticksToReach to the guard point + busy ticks +
 *       notGoalSidePenalty. The best-placed defender beats the current one by switchMarginTicks (more at noisy levels)
 *       -> MOD_L press when SIM-16's next-switch marker is (about) as good, else a gesture TAP on him (gSlot).
 *     - Approach goal-side with the stick: the guard point is standoff (by pressIntensity) goal-side of the carrier
 *       (on the line to the centre of our goal), led by his velocity (look-ahead capped by lookAheadTicks). Not yet
 *       goal-side: a recovery point deeper and to his side of the carrier, sprinting. Arrival ramp near the point.
 *       [QF-14] Patience: once the carrier has had the ball T_LEVEL.patienceTicks, no lead and a standoff of at most
 *       T_LEVEL.patienceStandoff: he holds his ground instead of backing off at the carrier's speed (a close-control
 *       dribbler is never exposed, so he was escorted into the six-yard box).
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
 *       [QF-13] In our own penalty area no rash lunges or slides from Professional up (T_LEVEL.boxRashMul /
 *       boxSlideMul); [QF-13 skeptic] a careful tackle there also needs the ball clear of the carrier's body at contact
 *       (boxClear: out of body contact, his body off the line to the ball), so a miss is no penalty.
 *       [QF-14] Once the patience is over, a carrier who never exposes the ball is challenged too: standing on it
 *       (T_CPU.defendStill*) or [QF-14 skeptic] walking it into the defender (T_CPU.defendHeld*: on the ball 3 s, slow,
 *       the ball presented ball-first), with the box care above.
 *       [QF-16] The block (blockPlan, T_CPU.defendBlock*): a human walking diagonally or across the defender kept the
 *       ball past every level (the patience point lay on the carrier -> goal line, the ball went by beside the carrier's
 *       body and body contact pinned the defender alongside). A carrier walking (slower than defendBlockWalkSpeed) on
 *       the ball T_LEVEL.blockTicks is met in the ball's path (reached round his body, tracked with his velocity), where the defender holds his ground
 *       (T_LEVEL.blockRetreat) and pokes at a ball within defendBlockPokeDist presented ball-first from where the
 *       wind-up and lunge take him (lungePresented). A shielding carrier is not blocked (SIM-05 holds him off a
 *       challenger he backs into). Rash lunges never go at a shielding carrier or at a ball his body hides (they
 *       were fouls nobody could win the ball with). [QF-16 third attempt] A human carrier is blocked at a jog as well
 *       (defendBlockJogSpeed); the poke wants the ball first by defendBlockPokeMargin. SIM-05's brace and SIM-06's
 *       under-the-feet steal (sim/players) take the ball from a walker who runs it into the blocking defender.
 *       [QF-16 skeptic] Against a human carrier only (the bot game is bit-identical): the jog block reaches every jog
 *       (defendBlockJogSpeed 6); blocking a jogger he runs instead of jockeying when a sprint jockey is too slow; a
 *       shielder is held at the guard point (defendBlockShieldCos0); no poke at a ball already at his feet
 *       (defendBlockFeetDist: SIM-06 gives it to him); careful tackles while blocking want the ball first
 *       (lungePresented), and rash tackles want it not hidden behind his body (ballHidden).
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
import { T_AI, T_CPU, T_DRIBBLE, T_LEVEL, T_PLAYER, T_SKILL, T_TACKLE, T_TOUCH } from '../../contracts/tuning';
import { isFree } from '../../sim/actions/dispatch';
import { tackleKind } from '../../sim/control/resolveActions';
import { LOCAL_TUNING as TACKLE_LT } from '../../sim/defend/tackle';
import { ballEta, controlContext, Ctx } from '../../sim/control/resolveShared';
import { aerialChance } from '../../sim/kicks/aerial';
import { inSkillVulnerableWindow } from '../../sim/kicks/skills';
import { inPenaltyArea } from '../../sim/pitch/geometry';
import { comeOutWanted } from '../../sim/keeper/sweeperHooks';
import { LOCAL_TUNING as FIRST_TOUCH_LT, trapLead } from '../../sim/players/firstTouch';
import { LOCAL_TUNING as LOCO_LT, ticksToReach } from '../../sim/players/locomotion';
import { createInterceptEstimate, estimateIntercept } from '../steer';
import { composureNoiseMul, levelParams, levelValue } from './levels';

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
  rashLungeChance: T_CPU.defendRashLungeChance,
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
  /** [QF-2] Our keeper's ball (TAI-07 chaser: his rush or save): ahead of it within this of its path, step off it, m. */
  keeperLaneClear: T_CPU.defendKeeperLaneClear,
  /** Reaction delay: keep running along the current velocity when faster than this, m/s. */
  momentumMinSpeed: 0.3,
  /** [QF-11] ... but within this of a touchline / goal line only along it (a low level's long delay ran him off), m. */
  momentumEdgeMargin: T_CPU.defendMomentumEdgeMargin,
  /** [QF-11 skeptic] ... or his braking distance toward it + this, whichever is more, m. */
  momentumBrakeSlack: T_CPU.defendMomentumBrakeSlack,
  /** [QF-13 skeptic] Box care: a careful tackle in our area keeps this clear of the carrier's body (boxClear), m. */
  boxClearMargin: T_CPU.defendBoxClearMargin,
  /** ... and the carrier at least two body radii + this from the tackler at contact, m. */
  boxBodyGap: T_CPU.defendBoxBodyGap,
  /** [QF-14 resume] Patience with a carrier standing on the ball (T_CPU.defendStill*): ticks since his last touch (+ the
   *  level's tackleTimingTicks) and the speed under which he and the ball count as standing, m/s. */
  stillTouchTicks: T_CPU.defendStillTouchTicks,
  stillSpeed: T_CPU.defendStillSpeed,
  /** [QF-14 skeptic] ... and walking the ball into him (T_CPU.defendHeldSpeed): under this speed, the ball presented, m/s. */
  heldSpeed: T_CPU.defendHeldSpeed,
  /** ... once he has had the ball this long (ball.ownerT), ticks. */
  heldTicks: T_CPU.defendHeldTicks,
  // ---- [QF-16] the block (blockPlan): a walking (or long-dribbling) carrier is met in the ball's path
  /** A carrier slower than blockWalkSpeed is blocked once he has had the ball T_LEVEL.blockTicks, m/s. */
  blockWalkSpeed: T_CPU.defendBlockWalkSpeed,
  blockJogSpeed: T_CPU.defendBlockJogSpeed,
  /** Guard point this far beyond the ball on the hold direction, m; tracked with a correction of blockGain per second. */
  blockDist: T_CPU.defendBlockDist,
  blockGain: T_CPU.defendBlockGain,
  /** Hold direction: the carrier -> ball line (when the ball is more than blockPathMinOffset from his centre, m), at
   *  most acos(blockPathCos) off the ball -> goal direction. */
  blockPathMinOffset: T_CPU.defendBlockPathMinOffset,
  blockPathCos: T_CPU.defendBlockPathCos,
  /** Rounding: until he is blockRoundAhead ahead of the carrier's centre along the hold direction (over blockRoundSpan),
   *  the guard point moves two body radii + blockRoundGap to his side. m. */
  blockRoundAhead: T_CPU.defendBlockRoundAhead,
  blockRoundSpan: T_CPU.defendBlockRoundSpan,
  blockRoundGap: T_CPU.defendBlockRoundGap,
  /** Holding the ground: in the ball's line (within blockAlign of it, ahead of the ball over blockHoldSpan) or in front
   *  of the carrier's body (within blockAlignBody of his line). m. */
  blockAlign: T_CPU.defendBlockAlign,
  blockHoldSpan: T_CPU.defendBlockHoldSpan,
  blockAlignBody: T_CPU.defendBlockAlignBody,
  /** [QF-16 skeptic] A human shielding carrier: the ground held from this cosine to the goal side (full at 1), 0..1. */
  blockShieldCos0: T_CPU.defendBlockShieldCos0,

  /** The poke: the ball within blockPokeDist of him (m), his rounding at most blockPokeMaxRound (0..1). */
  blockPokeDist: T_CPU.defendBlockPokeDist,
  blockPokeMaxRound: T_CPU.defendBlockPokeMaxRound,
  /** ... and the ball presented ball-first by blockPokeMargin (m). */
  blockPokeMargin: T_CPU.defendBlockPokeMargin,
  /** [QF-16 skeptic] A human carrier's ball nearer than this to the blocking defender is left to SIM-06 (no poke), m. */
  blockFeetDist: T_CPU.defendBlockFeetDist,
  /** [QF-13 skeptic] Reception near a line (receiveTurn): when the clean settle would end less than this inside a line,
   *  the stick's component toward it becomes receiveInward into the pitch. m, 0..1. */
  receiveSettleMargin: T_CPU.defendReceiveSettleMargin,
  receiveInward: T_CPU.defendReceiveInward,
} as const; // TUNING-CR

const L = LOCAL_TUNING;
/** [QF-13 skeptic] brain.seenOwner while our own pass is in flight to a teammate (tickBrain): the same situation as a
 *  loose ball (-1), but an opponent taking it is a turnover. */
const OUR_PASS = -2;
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
/** [QF-16] Debug (tests / tools): the latest carrier evaluation's block (1 = blocking) and, per team, the reason of its
 *  latest challenge (CH_* below). Written only, never read by the AI. */
export const DEFEND_DEBUG = { hold: 0, why0: 0, why1: 0 };
/** DEFEND_DEBUG challenge reasons: careful tackle on an exposed ball, rash (noisy) one, still carrier, held carrier,
 *  block poke, rash lunge at his feet, slide goal-side, slide from behind. */
export const CH_CAREFUL = 1, CH_RASH = 2, CH_STILL = 3, CH_HELD = 4, CH_POKE = 5, CH_LUNGE = 6, CH_SLIDE = 7, CH_SLIDE_BEHIND = 8;

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
  // [QF-11] Near a line he keeps the run along it, never over it (Beginner's 80-tick delay sent defenders 1.5 m off
  // the pitch, 13 times in 6 short matches); running straight at it, he lets the stick go and slows. [QF-11 skeptic]
  // "Near" is at least his braking distance toward the line (T_PLAYER.decel) + momentumBrakeSlack: a fixed 2 m let a
  // sprinter (9 m/s, 4 m to stop) run 2.3 m off the pitch.
  let dx = p.vx, dz = p.vz;
  const brake = 0.5 / T_PLAYER.decel;
  const ez = dz * dz * brake + L.momentumBrakeSlack, ex = dx * dx * brake + L.momentumBrakeSlack;
  const zl = HALF_WIDTH - (ez > L.momentumEdgeMargin ? ez : L.momentumEdgeMargin);
  const xl = HALF_LENGTH - (ex > L.momentumEdgeMargin ? ex : L.momentumEdgeMargin);
  if ((p.z > zl && dz > 0) || (p.z < -zl && dz < 0)) dz = 0;
  if ((p.x > xl && dx > 0) || (p.x < -xl && dx < 0)) dx = 0;
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (!(dl > L.momentumMinSpeed)) return;
  stX = dx / dl;
  stZ = dz / dl;
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

/**
 * [QF-11] His tackle / header / kick is still going to play the ball (same rule as SIM-16 switching.ts committedToBall):
 * the CPU never hands control to another defender meanwhile (it switched away from its own man mid-tackle or mid-header
 * 2-3 times per 4 matches, so the action was finished by an AI-driven body and the new man stood still).
 */
export function committedToBall(p: Readonly<PlayerState>): boolean {
  const a = p.act;
  if (p.actDone !== 0) return false;
  return a === ActionKind.KICK || a === ActionKind.SHOT || a === ActionKind.HEADER || a === ActionKind.VOLLEY ||
    (a >= ActionKind.STAND_TACKLE && a <= ActionKind.PUSH_PULL);
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

/**
 * Countdowns and the reaction delay on a situation change (ball owner / keeper in hands / loose = -1). [QF-13] Every
 * owner change of an opponent's passing chain re-armed the delay, so Beginner's controlled defender (80 ticks) kept
 * his old run, often standing, for up to 29 s with gaps under 0.25 s. Now a change re-arms it only when no delay is
 * running and the defender has been awake for T_AI.reactRearmGapFrac x the level's delay since the last one ran out
 * (that awake time is counted as a negative reactT; the readers only act on reactT > 0), or when the previous
 * situation was our own ball (the turnover itself, which also ends the carrier module's leftover delay). [QF-13
 * skeptic] An opponent taking our pass in flight (seen as OUR_PASS while it flies) is a turnover too: the delay armed
 * when the pass left the foot ran down in flight (branch 1 ignores it) and the interception found it spent, so a
 * Beginner defender reacted to an intercepted pass after 46-58 of his 80 ticks, and at once in 1 of 10.
 */
function tickBrain(s: SimState, team: number, brain: CpuBrainState, lv: LevelParams): void {
  if (brain.tackleCd > 0) brain.tackleCd = brain.tackleCd > 1 ? brain.tackleCd - 1 : 0;
  else brain.tackleCd = 0;
  const b = s.ball;
  const key = b.heldBy >= 0 ? b.heldBy : b.owner >= 0 ? b.owner : -1;
  const delay = lv.reactionTicks > 0 ? lv.reactionTicks : 0;
  const seen = brain.seenOwner === OUR_PASS ? -1 : brain.seenOwner;
  if (key !== seen) {
    const prev = brain.seenOwner;
    const ours = validSlot(prev) && s.players[prev]!.team === team;
    // [QF-13 skeptic] An opponent taking our pass in flight (an interception) is a turnover too.
    // [QF-13 skeptic, second run] Only where T_LEVEL.interceptRearm says so (below Professional: the long delays the
    // defect was about); Professional and up keep the first pass's chain rule (the section 7 bands' reference).
    const intercepted = prev === OUR_PASS && validSlot(key) && s.players[key]!.team !== team &&
      levelValue(s, team, T_LEVEL.interceptRearm) > 0;
    // Our own pass leaving the passer's foot starts the delay as any change (branch 1 ignores it while the pass flies)
    // and is remembered as OUR_PASS while it is in flight.
    brain.seenOwner = ours && key === -1 && ownPassInFlight(s, team) ? OUR_PASS : key;
    if (ours || intercepted || brain.reactT === 0 || !(brain.reactT === brain.reactT)) {
      brain.reactT = delay;
      return;
    }
  } else if (brain.seenOwner === OUR_PASS && !ownPassInFlight(s, team)) {
    // The pass is over while the ball is still loose (deflected, overrun, dead): a plain loose ball, whose delay (armed
    // when the pass left the foot) now holds his run; a pick-up by an opponent follows the chain rule above.
    brain.seenOwner = -1;
  }
  if (brain.reactT > 0) {
    if (brain.reactT > 1) {
      brain.reactT = brain.reactT - 1;
    } else {
      // The delay runs out: awake for at least the re-arm gap before an owner change counts again.
      const gap = Math.round(delay * T_AI.reactRearmGapFrac);
      brain.reactT = gap > 0 ? -gap : 0;
    }
  } else if (brain.reactT < 0) {
    brain.reactT = brain.reactT < -1 ? brain.reactT + 1 : 0;
  } else {
    brain.reactT = 0;
  }
}


/** Our own pass in flight to an active teammate (branch 1 of cpuDefend). Pure. */
function ownPassInFlight(s: SimState, team: number): boolean {
  const b = s.ball;
  return b.owner < 0 && b.heldBy < 0 && validSlot(b.passTarget) && b.lastTouchTeam === team &&
    s.players[b.passTarget]!.team === team && s.players[b.passTarget]!.active === 1;
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

/** [QF-14] The carrier (not a keeper) has had the ball the defending team's T_LEVEL.patienceTicks (0 = never). */
function patienceOver(s: SimState, team: number, q: Readonly<PlayerState>): boolean {
  const pt = levelValue(s, team, T_LEVEL.patienceTicks);
  return pt > 0 && q.isKeeper !== 1 && s.ball.ownerT >= pt;
}

/**
 * [QF-13 skeptic] In our own penalty area a careful tackle also wants the ball clear of the carrier's body at contact
 * (the positions wellTimed predicts): the carrier further from the tackler than body contact (two body radii +
 * boxBodyGap) and his body (bodyRadius + boxClearMargin) off the line from the tackler to the ball or beyond the ball,
 * never across it. SIM-14 makes a tackle that meets the body before the ball a foul, here a penalty: the careful
 * tackles of the top levels (no rash ones in the box) conceded 1.6-2.0 penalties a match at Legend, 0.75 at World Class
 * (Professional 0.38), nearly half of Legend's goals; now about 0.4 at Legend. Pure.
 */
function boxClear(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>): boolean {
  const t = (T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1)) / TICK_HZ;
  const b = s.ball;
  const px = p.x + p.vx * t, pz = p.z + p.vz * t;
  let ux = b.x + b.vx * t - px, uz = b.z + b.vz * t - pz;
  const lb = Math.sqrt(ux * ux + uz * uz);
  if (!(lb > EPS)) return false;
  ux /= lb; uz /= lb;
  const vx = q.x + q.vx * t - px, vz = q.z + q.vz * t - pz;
  const along = vx * ux + vz * uz;
  const lat = vx * uz - vz * ux;
  const alat = lat < 0 ? -lat : lat;
  const rv = T_PLAYER.bodyRadius + L.boxClearMargin;
  // Not within body contact of him either (SIM-14 bodyInZone: a missed tackle with his body that close is a foul).
  const gap = 2 * T_PLAYER.bodyRadius + L.boxBodyGap;
  if (vx * vx + vz * vz < gap * gap) return false;
  if (along > 0 && along - rv < lb && alat < rv) return false;
  // Clear: beyond the ball (by the margin) or off the line to it.
  return along - lb > L.boxClearMargin || alat >= rv;
}

/**
 * [QF-14 skeptic] The carrier's ball is presented to defender p: now and at mid-contact of a standing tackle (positions
 * predicted linearly, as wellTimed: a dribbled ball being pulled back to his feet is not) the ball is within standReach
 * of him and the carrier's body does not lie between them (SIM-14 bodyBlocksBall: his near edge beyond the ball less
 * ballFirstMargin, or off the line by more than bodyRadius + blockLateral), so the challenge meets the ball first. Pure.
 */
function ballPresented(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>, margin = 0): boolean {
  return ballFirstAt(s, p, q, 0, margin) &&
    ballFirstAt(s, p, q, (T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1)) / TICK_HZ, margin);
}

/**
 * [QF-16] ballPresented for a challenge from where the tackler will be: SIM-14's stand tackle turns his run onto the
 * ball and keeps windupSpeedKeep of the speed along it per wind-up tick, then lunges at standLungeSpeed (or that speed
 * if faster), so his sideways speed is gone at the contact. Ball-first (the carrier's body not between him and the
 * ball, by margin) now, at the first contact tick and at mid-contact, the carrier and the ball moving on linearly. Pure.
 */
function lungePresented(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>, margin: number): boolean {
  if (!ballFirstAt(s, p, q, 0, margin)) return false;
  const b = s.ball;
  let ux = b.x - p.x, uz = b.z - p.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > EPS)) return false;
  ux /= ul; uz /= ul;
  let along = p.vx * ux + p.vz * uz;
  if (!(along > 0)) along = 0;
  // Wind-up: along x keep^i per tick (i = 1..windup); contact: the lunge.
  let dw = 0, sp = along;
  for (let i = 0; i < T_TACKLE.standWindup; i++) { sp *= TACKLE_LT.windupSpeedKeep; dw += sp; }
  dw /= TICK_HZ;
  const lunge = sp > TACKLE_LT.standLungeSpeed ? sp : TACKLE_LT.standLungeSpeed;
  const t1 = T_TACKLE.standWindup / TICK_HZ;
  if (!ballFirstFrom(s, p.x + ux * dw, p.z + uz * dw, q, t1, margin)) return false;
  const t2 = (T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1)) / TICK_HZ;
  const d2 = dw + lunge * (t2 - t1);
  return ballFirstFrom(s, p.x + ux * d2, p.z + uz * d2, q, t2, margin);
}

/** ballFirstAt for a tackler at (px, pz) at t seconds ahead, the carrier and the ball linear. Pure. */
function ballFirstFrom(s: SimState, px: number, pz: number, q: Readonly<PlayerState>, t: number, margin: number): boolean {
  const b = s.ball;
  let ux = b.x + b.vx * t - px, uz = b.z + b.vz * t - pz;
  const lb = Math.sqrt(ux * ux + uz * uz);
  if (!(lb > EPS) || lb > T_TACKLE.standReach) return false;
  ux /= lb; uz /= lb;
  let vx = q.x + q.vx * t - px, vz = q.z + q.vz * t - pz;
  // Bodies do not pass through each other (SIM-05): a carrier walking into him stops at body contact.
  const vl = Math.sqrt(vx * vx + vz * vz), touch = 2 * T_PLAYER.bodyRadius;
  if (vl < touch && vl > EPS) { vx *= touch / vl; vz *= touch / vl; }
  const along = vx * ux + vz * uz;
  const lat = vx * uz - vz * ux;
  const rv = T_PLAYER.bodyRadius;
  return !(along > 0) || along - rv > lb - TACKLE_LT.ballFirstMargin + margin ||
    (lat < 0 ? -lat : lat) > rv + TACKLE_LT.blockLateral + margin;
}

/** [QF-16 skeptic] The carrier's body hides the ball from p now (ballFirstAt's body test, at any range). Pure. */
function ballHidden(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>): boolean {
  const b = s.ball;
  let ux = b.x - p.x, uz = b.z - p.z;
  const lb = Math.sqrt(ux * ux + uz * uz);
  if (!(lb > EPS)) return false;
  ux /= lb; uz /= lb;
  const vx = q.x - p.x, vz = q.z - p.z;
  const along = vx * ux + vz * uz;
  const lat = vx * uz - vz * ux;
  const rv = T_PLAYER.bodyRadius;
  return along > 0 && along - rv <= lb - TACKLE_LT.ballFirstMargin && (lat < 0 ? -lat : lat) <= rv + TACKLE_LT.blockLateral;
}

/** ballPresented at t seconds ahead (linear). Pure. */
function ballFirstAt(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>, t: number, margin: number): boolean {
  const b = s.ball;
  const px = p.x + p.vx * t, pz = p.z + p.vz * t;
  let ux = b.x + b.vx * t - px, uz = b.z + b.vz * t - pz;
  const lb = Math.sqrt(ux * ux + uz * uz);
  if (!(lb > EPS) || lb > T_TACKLE.standReach) return false;
  ux /= lb; uz /= lb;
  const vx = q.x + q.vx * t - px, vz = q.z + q.vz * t - pz;
  const along = vx * ux + vz * uz;
  const lat = vx * uz - vz * ux;
  const rv = T_PLAYER.bodyRadius;
  return !(along > 0) || along - rv > lb - TACKLE_LT.ballFirstMargin + margin ||
    (lat < 0 ? -lat : lat) > rv + TACKLE_LT.blockLateral + margin;
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
  // Start only from a free keeper: an AI come-out already running (GKP-03) is left alone. [QF-2] And only when GKP-03
  // agrees there is a come-out to make: a held rush right after GKP-03 aborted its own one-on-one made the keeper
  // start / stop / start on consecutive ticks.
  if (isFree(kp) && throughOnGoal(s, team, q, L.rushStartDist) && comeOutWanted(s, team)) btn |= Btn.THROUGH;
}

// ---------------------------------------------------------------- the carrier

/** [QF-16] blockPlan output: guard point, hold direction (unit), rounding 0..1, hold strength 0..1. */
const BLK = { tx: 0, tz: 0, ax: 0, az: 0, k: 0, h: 0 };

/**
 * [QF-16] The block against carrier q (defendCarrier decides when): the hold direction h runs along the carrier ->
 * ball line (the ball's path; a walking carrier keeps the ball 0.4-0.5 m ahead of him) but at most acos(blockPathCos)
 * off the ball -> goal direction; the guard point is blockDist beyond the ball on it, so the ball comes at the defender
 * and the carrier's body is behind it (SIM-14 ball-first). While defender p is not yet blockRoundAhead ahead of the
 * carrier's centre along h (k 1 -> 0 over blockRoundSpan) the point moves to his side by two body radii +
 * blockRoundGap: he goes round the carrier instead of into him. Hold strength BLK.h: in the ball's line (within
 * blockAlign of it and ahead of the ball, over blockHoldSpan) or in front of the carrier's body (within blockAlignBody
 * of his line), x (1 - k); holding before he is there let the carrier push him along beside the ball. False (no
 * block) when the ball is not on our goal's side of the carrier. Fills BLK. Pure.
 */
function blockPlan(s: SimState, dir: number, p: Readonly<PlayerState>, q: Readonly<PlayerState>, gx: number, gz: number): boolean {
  const b = s.ball;
  const ox = b.x - q.x, oz = b.z - q.z;
  if (ox * gx + oz * gz <= 0) return false;
  let hx = -dir * HALF_LENGTH - b.x, hz = -b.z;
  const hl = Math.sqrt(hx * hx + hz * hz);
  if (hl > EPS) { hx /= hl; hz /= hl; } else { hx = gx; hz = gz; }
  const ol = Math.sqrt(ox * ox + oz * oz);
  if (ol > L.blockPathMinOffset) {
    const ux = ox / ol, uz = oz / ol;
    const c = ux * hx + uz * hz;
    if (c >= L.blockPathCos) { hx = ux; hz = uz; } else {
      let nx = ux - c * hx, nz = uz - c * hz;
      const nl = Math.sqrt(nx * nx + nz * nz);
      if (nl > EPS) { nx /= nl; nz /= nl; } else { nx = -hz; nz = hx; }
      const sa = Math.sqrt(1 - L.blockPathCos * L.blockPathCos);
      hx = hx * L.blockPathCos + nx * sa; hz = hz * L.blockPathCos + nz * sa;
    }
  }
  const nx = -hz, nz = hx;
  const ahead = (p.x - q.x) * hx + (p.z - q.z) * hz;
  const lat = (p.x - b.x) * nx + (p.z - b.z) * nz;
  let k = (L.blockRoundAhead - ahead) / L.blockRoundSpan;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  const o = k * (2 * T_PLAYER.bodyRadius + L.blockRoundGap) * (lat >= 0 ? 1 : -1);
  BLK.tx = b.x + hx * L.blockDist + nx * o;
  BLK.tz = b.z + hz * L.blockDist + nz * o;
  BLK.ax = hx; BLK.az = hz; BLK.k = k;
  const al = lat < 0 ? -lat : lat;
  let a = 1 - al / L.blockAlign;
  let f = ((p.x - b.x) * hx + (p.z - b.z) * hz) / L.blockHoldSpan;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  a = a < 0 ? 0 : a * f;
  const lq = (p.x - q.x) * nx + (p.z - q.z) * nz;
  let aq = 1 - (lq < 0 ? -lq : lq) / L.blockAlignBody;
  if (aq < 0) aq = 0;
  BLK.h = (1 - k) * (a > aq ? a : aq);
  return true;
}

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
  let standoff = L.standoffLow + (L.standoffHigh - L.standoffLow) * (lv.pressIntensity < 0 ? 0 : lv.pressIntensity > 1 ? 1 : lv.pressIntensity);
  // [QF-14] Patience: once the carrier has had the ball T_LEVEL.patienceTicks (0 = off) the engaged defender stops
  // backing off at the carrier's speed: his guard point is T_LEVEL.patienceStandoff goal-side of where the carrier is
  // (no velocity lead). A close-control dribbler is never exposed (exposeDist), so the CPU used to jockey him, backing
  // off, from the halfway line into the six-yard box (27 s, soak seed 1 #0) without a tackle; held up, he must turn (an
  // exposure), pass or shoot.
  const patient = patienceOver(s, team, q);
  if (patient) {
    const hold = levelValue(s, team, T_LEVEL.patienceStandoff);
    if (standoff > hold) standoff = hold;
  }

  // Guard point for player choice: from the current player's distance.
  let d0x = p0.x - q.x, d0z = p0.z - q.z;
  let d0 = Math.sqrt(d0x * d0x + d0z * d0z);
  const leadCap = (lv.lookAheadTicks * L.leadLookAheadFrac) / TICK_HZ;
  let lead = d0 / L.leadRefSpeed;
  if (patient) lead = 0; else if (lead > leadCap) lead = leadCap;
  const guardX = q.x + q.vx * lead + gx * standoff;
  const guardZ = q.z + q.vz * lead + gz * standoff;

  let slot = p0.slot;
  let switched = false;
  const cos0 = d0 > EPS ? (d0x * gx + d0z * gz) / d0 : 1;
  const engaged = cos0 >= L.goalSideCos && d0 <= L.engagedDist;
  if (!engaged && ctl.switchLockT === 0 && !(brain.reactT > 0) && (s.tick + team * 3) % L.switchEvalTicks === 0 &&
    !committedToBall(p0)) {
    const mover = chooseDefender(s, team, ci, ctl, lv, slot, q, guardX, guardZ, out);
    if (mover !== slot) { slot = mover; switched = true; }
    else if (out.gesture !== GestureKind.NONE) switched = true;
  }
  const p = s.players[slot]!;
  if (slot !== p0.slot) {
    d0x = p.x - q.x; d0z = p.z - q.z;
    d0 = Math.sqrt(d0x * d0x + d0z * d0z);
    lead = d0 / L.leadRefSpeed;
    if (patient) lead = 0; else if (lead > leadCap) lead = leadCap;
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
  let tgx = lx + gx * depth - gz * off, tgz = lz + gz * depth + gx * off;
  // [QF-16] The block (blockPlan, T_CPU.defendBlock*): a carrier walking the ball at or past him (slower than
  // blockWalkSpeed) once he has had it the level's T_LEVEL.blockTicks: the guard point in the ball's path, reached round
  // his body, tracked with his velocity, the ground held. Not a dribbler: blocking the bot carriers' 3-6 m/s dribbles
  // took the top levels' attacking edge (Legend v World Class 67 -> 51% over 100) and, in our last 35 m only, gave
  // goals away (2.87 -> 3.25 a match at Professional: the defender in the path is beaten by the cut inside).
  // [QF-16 third attempt] A human carrier is blocked at a jog too (blockJogSpeed): jogging diagonally past the defender
  // he kept the ball at every level (pinned alongside, the QF-14 escort at a human's hands).
  const humanQ = q.ctrl >= 0 && q.ctrl < CPU_CONTROLLER_BASE;
  const blockT = patient && qs < (humanQ ? L.blockJogSpeed : L.blockWalkSpeed) &&
    s.ball.ownerT >= levelValue(s, team, T_LEVEL.blockTicks);
  // A shielding carrier is not blocked (the ball is behind the man): SIM-05 holds a shielder off a challenger he backs
  // into (shieldDriveSpeed).
  let hold = blockT && q.shielding !== 1 && blockPlan(s, dir, p, q, gx, gz);
  if (hold) { tgx = BLK.tx; tgz = BLK.tz; }
  else if (blockT && humanQ && q.shielding === 1) {
    // [QF-16 skeptic] ... but a human shielder is not let through either: the guard point as before, in front of him the
    // ground held (no challenge: the ball is behind the man). The guard point alone (patienceStandoff goal-side of the
    // carrier) walked the defender back at the shielder's pace, so SIM-05's hold never came into it: a human
    // shielding forward walked a Legend defender from the edge of his area back to the goal line (7 of 8 kept).
    hold = true;
    BLK.tx = tgx; BLK.tz = tgz; BLK.ax = gx; BLK.az = gz; BLK.k = 0;
    const f = (cosG - L.blockShieldCos0) / (1 - L.blockShieldCos0);
    BLK.h = f < 0 ? 0 : f > 1 ? 1 : f;
  }
  DEFEND_DEBUG.hold = hold ? 1 : 0;
  steerTo(p, tgx, tgz, 1);
  if (w > 0 && !hold) wantSprint = 1;

  // Contain / jockey.
  const jogP = s.attrs[slot]!.topSpeed * T_PLAYER.jogFraction;
  const topP = s.attrs[slot]!.topSpeed;
  let holdV = -1;
  if (hold) {
    // [QF-16] Track the guard point: the carrier's velocity plus a correction toward it (blockGain per second, at most
    // his top speed).
    let cx = (tgx - p.x) * L.blockGain, cz = (tgz - p.z) * L.blockGain;
    const cm = Math.sqrt(cx * cx + cz * cz);
    if (cm > topP) { cx *= topP / cm; cz *= topP / cm; }
    let fx = q.vx, fz = q.vz;
    // In front of him (BLK.k 0) he holds the ground: of the carrier's speed toward our goal (and of the correction that
    // way) he gives up only the level's blockRetreat share; sideways he steps across in full. Rounding him (k 1): all.
    const r0 = levelValue(s, team, T_LEVEL.blockRetreat);
    const keep = (1 - r0) * BLK.h;
    const va = fx * BLK.ax + fz * BLK.az, ca = cx * BLK.ax + cz * BLK.az;
    if (va > 0) { fx -= keep * va * BLK.ax; fz -= keep * va * BLK.az; }
    if (ca > 0) { cx -= keep * ca * BLK.ax; cz -= keep * ca * BLK.az; }
    const vx = fx + cx, vz = fz + cz;
    holdV = Math.sqrt(vx * vx + vz * vz);
    if (holdV > EPS) { stX = vx / holdV; stZ = vz / holdV; stM = 1; } else { stX = 0; stZ = 0; stM = 0; holdV = 0; }
  }
  const wasContain = (ctl.buttons & Btn.PASS) !== 0;
  const wasJockey = (ctl.buttons & Btn.SHIELD) !== 0;
  if (cosG > L.behindCos && d <= L.containDist && qs >= (wasContain ? L.containKeepSpeed : L.containSpeed)) {
    btn |= Btn.PASS;
    wantSprint = 0;
  } else if (goalSide && d <= (wasJockey ? L.jockeyKeepDist : L.jockeyDist)) {
    btn |= Btn.SHIELD;
    wantSprint = qs > L.sprintJockeyFrac * jogP ? 1 : 0;
  }
  if (holdV >= 0) {
    // SIM-04: a jockeying (or auto-jockeying) player is capped at jockeySpeedFraction of jog, of top with SPRINT.
    const capNo = jogP * T_PLAYER.jockeySpeedFraction;
    if (holdV > capNo) {
      wantSprint = 1;
      stM = topP > EPS ? holdV / topP * LOCO_LT.sprintStickFull : 1;
      if (stM > 1) stM = 1;
      if (stM < L.sprintMinStick) stM = L.sprintMinStick;
      // [QF-16 skeptic] Faster than even a sprint jockey goes sideways (jockeySpeedFraction of top): run, not jockey.
      // Jockeying (facing the carrier) capped him at 0.55 x top, 5.1 m/s, so a human jogging diagonally at full stick
      // (5.5 m/s) outran the block alongside him and kept the ball 3-4 of 8 at Legend, 29-36 m in 10 s. A jogging
      // human carrier only (faster than blockWalkSpeed): a walker, and every bot carrier (blocked at a walk only), a
      // sprint jockey keeps up with, so the walking blocks and the bot game are unchanged.
      if (humanQ && qs >= L.blockWalkSpeed && holdV > topP * T_PLAYER.jockeySpeedFraction) btn &= ~Btn.SHIELD;
    } else {
      wantSprint = 0;
      stM = jogP > EPS ? holdV / jogP : 0;
    }
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
  // [QF-11] A nervous defender lunges more, a calm one less (T_AI.composureNoise*).
  let noisy = lv.decisionNoise * composureNoiseMul(s.attrs[slot]!.composure, brain.level);
  // [QF-13] In our own penalty area a foul is a penalty: no rash lunges, no slides from Professional up
  // (T_LEVEL.boxRashMul / boxSlideMul).
  const inBox = inPenaltyArea(q.x, q.z, -dir);
  if (inBox) noisy *= levelValue(s, team, T_LEVEL.boxRashMul);

  // Standing tackle / shoulder (never from behind: that would be a push or pull).
  const kind = tackleKind(s, p, carrier);
  if (kind === ActionKind.STAND_TACKLE || kind === ActionKind.SHOULDER) {
    exposure(s, q);
    if (expOn === 1) {
      if (expAge >= lv.tackleTimingTicks && dBall <= T_TACKLE.standReach + L.tackleApproach) {
        // [QF-16 skeptic] A rash tackle at a human carrier still wants the ball not hidden behind his body (ballHidden,
        // as the rash lunge below wants it ball-first): a Semi-Pro defender hacked a human strafing across him 8-9 times
        // in 8 scenes with no ball won. Bot carriers unchanged.
        const rash = noise01(seed, who, expKey * 4 + 1) < noisy && (!humanQ || !ballHidden(s, p, q));
        // [QF-13 skeptic] In our own area a careful tackle also wants the ball clear of the carrier's body (boxClear), at
        // the levels whose quick careful tackles gave away the penalties (T_LEVEL.boxBodyClear: World Class, Legend).
        const careful = !inBox || !(levelValue(s, team, T_LEVEL.boxBodyClear) > 0) || boxClear(s, p, q);
        // [QF-16 skeptic] Blocking a human carrier (holdV >= 0), a careful tackle also wants the ball first by
        // blockPokeMargin from where the wind-up and lunge take him (lungePresented), as the poke does: a human strafing
        // across the defender (MOD_L, 3 m/s, the ball on his far side) is blocked since the jog block, and the careful
        // tackle on his touches went through his body (6-7 fouls in 8 scenes at World Class / Legend; 0-2 before).
        // Bot carriers (blocked at a walk only) keep the old careful tackle: the bot game is unchanged.
        const first = holdV < 0 || !humanQ || lungePresented(s, p, q, L.blockPokeMargin);
        if (rash || (wellTimed(s, p, q) && careful && first)) { why(team, rash ? CH_RASH : CH_CAREFUL); pressTackle(brain, lv); return; }
      }
    } else if (dBall <= T_TACKLE.standReach && goalSide) {
      // [QF-14 resume] Patience with a carrier standing on the ball: he never exposes it (no touch, no turn), so a
      // noise-free defender (Legend: no rash lunge) held his ground in front of him for ever. Standing still in no
      // action (not shielding, not winding up or charging a kick), untouched for stillTouchTicks + the level's tackle
      // timing: the challenge. [QF-14 skeptic] Walking the ball into him is no better: on the ball heldTicks, slower
      // than heldSpeed, between touches (tackle timing) with the ball presented to him (ball-first, now and at
      // contact): the same challenge. And in our own area with the same box care as a careful tackle
      // (T_LEVEL.boxBodyClear: the still challenge at a carrier stood in the box gave World Class / Legend penalties
      // away, 2 in 12).
      if (patient && q.shielding !== 1 && q.act === ActionKind.NONE && q.lastTouchTick >= 0) {
        const age = s.tick - q.lastTouchTick;
        const still = qs < L.stillSpeed && b.vx * b.vx + b.vz * b.vz < L.stillSpeed * L.stillSpeed &&
          age >= L.stillTouchTicks + lv.tackleTimingTicks;
        // [QF-16] The held challenge is for a carrier who is not blocked; a blocked one is poked: the ball within
        // blockPokeDist, the defender round the carrier (rounding at most blockPokeMaxRound) and the ball presented
        // ball-first by blockPokeMargin from where the wind-up and lunge take him (lungePresented), in our area only with
        // the carrier's body clear.
        const held = holdV < 0 && qs < L.heldSpeed && b.ownerT >= L.heldTicks && ballPresented(s, p, q);
        // [QF-16 skeptic] Not at a human carrier's ball already at his feet (blockFeetDist): SIM-06 gives it to him.
        const poke = holdV >= 0 && BLK.k <= L.blockPokeMaxRound && dBall <= L.blockPokeDist &&
          !(humanQ && dBall < L.blockFeetDist) &&
          lungePresented(s, p, q, L.blockPokeMargin) && (!inBox || boxClear(s, p, q));
        if ((still || ((held || poke) && age >= lv.tackleTimingTicks)) &&
          (!inBox || !(levelValue(s, team, T_LEVEL.boxBodyClear) > 0) || boxClear(s, p, q))) {
          why(team, still ? CH_STILL : held ? CH_HELD : CH_POKE);
          pressTackle(brain, lv);
          return;
        }
      }
      const bucket = Math.floor(s.tick / L.rashBucketTicks);
      // [QF-16] Never into a shielding carrier's back, nor at a ball his body hides from us (not ball-first now): a
      // lunge nobody could win the ball with is a foul (a carrier shielding for 10 s was fouled 2-7 times and never
      // robbed at every level up to World Class; a strafer in front of a Professional defender 9 times in 80 s).
      if (noise01(seed, who, bucket * 4 + 2) < noisy * L.rashLungeChance && q.shielding !== 1 && ballFirstAt(s, p, q, 0, 0)) {
        why(team, CH_LUNGE); pressTackle(brain, lv); return;
      }
    }
  }

  // Slide: goal-side, the ball loose-ish (between touches), beyond standing reach, in our half and urgent (a quick
  // carrier or our final third), one draw per window; from behind only for a carrier through on goal, rarely.
  if (goalLineDist > L.slideZoneDist) return;
  exposure(s, q);
  if (expOn !== 1 || expSkill === 1 || expAge < lv.tackleTimingTicks) return;
  if (!(dBall > T_TACKLE.standReach && dBall <= T_TACKLE.slideReach * L.slideReachFrac)) return;
  const u = noise01(seed, who, expKey * 4 + 3);
  const slideMul = inBox ? levelValue(s, team, T_LEVEL.boxSlideMul) : 1;
  if (goalSide) {
    // The ball must be on our side of him (nearer to us than he is): never slide through the carrier to reach it.
    if (dBall < d && (qs > jogP || goalLineDist <= L.secondDefDist) && u < L.slideChance * slideMul) { why(team, CH_SLIDE); pressSlide(brain, lv); }
  } else if (cosG <= L.behindCos && throughOnGoal(s, team, q, L.slideBehindDist)) {
    if (u < L.slideBehindChance * noisy * slideMul) { why(team, CH_SLIDE_BEHIND); pressSlide(brain, lv); }
  }
}

function why(team: number, r: number): void { if (team === 0) DEFEND_DEBUG.why0 = r; else DEFEND_DEBUG.why1 = r; }

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
  // [QF-2] A teammate already going up for this flight plays it: a second attempt sent two teammates into the same
  // header (SIM-16 had switched the CPU away from the player it pressed for, ~10 times a match).
  if (mateOnFlight(s, team, p.slot)) return;
  const eta = ballEta(s, p.slot);
  const arriving = eta >= 0 && eta <= L.clearEtaTicks;
  if (!arriving && !(aerialChance(s, p.slot) > 0)) return;
  const b = s.ball;
  if (nearestOpponentDist(s, team, p.x, p.z) > L.clearPressureDist && nearestOpponentDist(s, team, b.x, b.z) > L.clearPressureDist) return;
  btn |= Btn.SHOOT;
  brain.tackleCd = lv.reactionTicks + T_TACKLE.standWindup;
}

/** [QF-2] A teammate of `slot` has an open header / volley attempt (SIM-12, actDone 0) on the ball's current flight. */
function mateOnFlight(s: SimState, team: number, slot: number): boolean {
  const flight = s.ball.lastTouchTick;
  const first = team === 0 ? 0 : PLAYERS_PER_TEAM;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active === 1 && (q.act === ActionKind.HEADER || q.act === ActionKind.VOLLEY) && q.actDone === 0 && q.actB === flight) {
      return true;
    }
  }
  return false;
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
      receiveTurn(s, p);
      return;
    }
  }
  if (nearestOpponentDist(s, team, b.passX, b.passZ) <= L.contestDist) {
    btn |= Btn.SPRINT; // idle stick + SPRINT: the receiver meets the ball at top speed
  }
  if (p.slot === b.passTarget) receiveTurn(s, p);
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
  lineBrake(p);
  receiveTurn(s, p);
}

/**
 * [QF-13 skeptic] Receiving near a touchline / goal line (SIM-07 takes the ball this tick or the next: a moving ball at
 * most trap height coming within his reach, he free to take it) when SIM-07's clean settle (in the stick direction, or
 * the ball's with the stick released, at the trap lead ahead of where his carry takes him) would end less than
 * receiveSettleMargin inside the line: the stick's component toward it becomes receiveInward into the pitch (the rest
 * kept) and SPRINT is let go, so the trap keeps the ball in play. The receiver of an overhit pass sprinted onto it at the
 * line with the stick on the ball, or met it there with the stick released (SIM-15's meeting point on the line), and
 * trapped it over the line: 1.4 throw-ins a match, 18% of all (Professional).
 */
function receiveTurn(s: SimState, p: Readonly<PlayerState>): void {
  const b = s.ball;
  // Only a reception SIM-07 makes: a moving ball he is free to take (a turn that is not followed by the touch slows his
  // chase, the ball gets away and he turns back after it: a stick flip-flop every tick).
  // Feet, or thigh / chest up to trap height (SIM-07's reach is shorter there), at the ball's height after this tick.
  const y = b.y + b.vy / TICK_HZ;
  const reach = y <= T_DRIBBLE.controlHeight ? T_TOUCH.receiveRadius : T_TOUCH.receiveRadius * FIRST_TOUCH_LT.chestReachMul;
  if (y > T_TOUCH.trapHeight || !isFree(p) || p.noTouchT > 0) return;
  if (b.vx * b.vx + b.vz * b.vz <= FIRST_TOUCH_LT.minTrapSpeed * FIRST_TOUCH_LT.minTrapSpeed) return;
  if (b.lastKickBy === p.slot && s.tick - b.lastKickTick < FIRST_TOUCH_LT.selfKickTicks) return;
  const bv = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  let sx: number, sz: number;
  const free = stM > 0 ? 0 : 1;
  if (free === 0) { sx = stX * stM; sz = stZ * stM; } else if (bv > EPS) { sx = b.vx / bv; sz = b.vz / bv; } else return;
  // [QF-13 skeptic] Only when the trap would end at the line: SIM-07's clean settle leaves the ball trapLead ahead
  // (along the stick) of where he is when the FIRST_TOUCH window ends (his carry taken at his present velocity, an upper
  // bound: the window slows him). When that point is less than receiveSettleMargin inside a line, the stick's component
  // toward it becomes receiveInward into the pitch (a heavy touch goes his way, bent by the incoming ball, so the turn
  // is a firm one). Turning every reception within 3 m of a line whose stick had any component toward it also turned
  // receptions that would have stayed in, the attacking ones inside (goals 3.72 against 3.61 now, 150-match soak).
  const lead = trapLead(s, p.slot);
  const tw = T_TOUCH.firstTouchTicks / TICK_HZ;
  const cx = p.x + p.vx * tw, cz = p.z + p.vz * tw;
  const limX = HALF_LENGTH - L.receiveSettleMargin, limZ = HALF_WIDTH - L.receiveSettleMargin;
  let turned = 0;
  if (cz + sz * lead > limZ) { sz = -L.receiveInward; turned = 1; }
  else if (cz + sz * lead < -limZ) { sz = L.receiveInward; turned = 1; }
  if (cx + sx * lead > limX) { sx = -L.receiveInward; turned = 1; }
  else if (cx + sx * lead < -limX) { sx = L.receiveInward; turned = 1; }
  if (turned === 0) return;
  const m = Math.sqrt(sx * sx + sz * sz);
  if (!(m > EPS)) return;
  const ux = sx / m, uz = sz / m;
  // SIM-07 must take the ball with the turned stick (after the tick's movement, the stick the settle direction) this
  // tick or the next: the ball's segment of that tick within his reach of where he will be, his velocity
  // changed toward the turned stick by at most T_PLAYER.decel a tick. A turn that is not followed by the touch slows
  // his chase, the ball gets away and he turns back after it: a stick flip-flop every tick.
  const jog = s.attrs[p.slot]!.topSpeed * T_PLAYER.jogFraction;
  const cap = T_PLAYER.decel / TICK_HZ;
  let vx = p.vx, vz = p.vz, px = p.x, pz = p.z, ok = 0;
  for (let k = 0; k < 2 && ok === 0; k++) {
    let dvx = ux * jog - vx, dvz = uz * jog - vz;
    const dv = Math.sqrt(dvx * dvx + dvz * dvz);
    if (dv > cap) { dvx *= cap / dv; dvz *= cap / dv; }
    vx += dvx; vz += dvz;
    px += vx / TICK_HZ; pz += vz / TICK_HZ;
    const qx = b.x + b.vx * k / TICK_HZ - px, qz = b.z + b.vz * k / TICK_HZ - pz;
    let t = bv > EPS ? -(qx * b.vx + qz * b.vz) / (bv * bv) : 0;
    if (t < 0) t = 0; else if (t > 1 / TICK_HZ) t = 1 / TICK_HZ;
    const cx = qx + b.vx * t, cz = qz + b.vz * t;
    if (cx * cx + cz * cz <= reach * reach) ok = 1;
  }
  if (ok === 0) return;
  stX = ux; stZ = uz; stM = 1;
  wantSprint = 0;
  btn &= ~Btn.SPRINT;
}

/**
 * [QF-13] A chase at full stick (no arrival ramp into a moving ball) ran on over the touchline: within his braking
 * distance of a touchline / goal line (v^2 / (2 x T_PLAYER.decel) + momentumBrakeSlack, as momentum()) and running at
 * it, the stick's component toward it is let go (a CPU defender chasing a high ball to the line stood 2.3 m off the
 * pitch, seed 33 #16).
 */
function lineBrake(p: Readonly<PlayerState>): void {
  if (!(stM > 0)) return;
  const brake = 0.5 / T_PLAYER.decel;
  const ez = p.vz * p.vz * brake + L.momentumBrakeSlack, ex = p.vx * p.vx * brake + L.momentumBrakeSlack;
  let sx = stX * stM, sz = stZ * stM;
  if ((p.z > HALF_WIDTH - ez && p.vz > 0 && sz > 0) || (p.z < -HALF_WIDTH + ez && p.vz < 0 && sz < 0)) sz = 0;
  if ((p.x > HALF_LENGTH - ex && p.vx > 0 && sx > 0) || (p.x < -HALF_LENGTH + ex && p.vx < 0 && sx < 0)) sx = 0;
  const m = Math.sqrt(sx * sx + sz * sz);
  if (m > EPS) { stX = sx / m; stZ = sz / m; stM = m < 1 ? m : 1; } else { stX = 0; stZ = 0; stM = 0; wantSprint = 0; }
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

/** [QF-2] True when our keeper is the loose-ball chaser (TAI-07: his rush or his save on their ball). */
function keepersBall(s: SimState, team: number): boolean {
  const ch = s.teams[team]!.chaser;
  return validSlot(ch) && ch === s.teams[team]!.keeperSlot && s.players[ch]!.active === 1 && s.players[ch]!.ctrl < 0;
}

/**
 * [QF-2] The keeper takes this ball: stay out of its way. Ahead of the ball on its path and within keeperLaneClear m of
 * the line, step sideways off it; otherwise hold (coverLoose would put him halfway between the ball and the goal, on
 * the shot's path, where SIM-07 lets the controlled player trap it in front of his keeper).
 */
function clearKeeperLane(s: SimState, p: Readonly<PlayerState>): void {
  const b = s.ball;
  const v = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  stX = 0; stZ = 0; stM = 0;
  if (!(v > EPS)) return;
  const ux = b.vx / v, uz = b.vz / v;
  const rx = p.x - b.x, rz = p.z - b.z;
  if (rx * ux + rz * uz <= 0) return;
  const off = rx * -uz + rz * ux;
  const ao = off < 0 ? -off : off;
  if (ao >= L.keeperLaneClear) return;
  const side = off < 0 ? -1 : 1;
  steerTo(p, p.x - uz * side * (L.keeperLaneClear - ao + 0.5), p.z + ux * side * (L.keeperLaneClear - ao + 0.5), 0);
  stM = 1;
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
  tickBrain(s, team, brain, lv);
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
  } else if (keepersBall(s, team)) {
    clearKeeperLane(s, p);
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

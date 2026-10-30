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
 *     - [FEEL-2] The duel with a HUMAN carrier (D-033, D-035; bot carriers unchanged): goal-side within duelEngageDist
 *       of a human coming at our goal, each side step (a change of his lateral velocity by duelStepDelta, never a steady
 *       diagonal) is one deterministic draw (noise01, state in brain p1..p3): sold (T_FEEL2.duelSoldChance by level x
 *       the dribbler's dribbling / agility) he is wrong-footed for duelSoldTicks (goes the wrong way, no challenge, no
 *       chase), else he reads it for duelReadTicks (sprint-jockeys to where the ball crosses his line, stepping in by
 *       level) and may make the read tackle on the unexposed ball (D-038: never as the last man within the DOGSO
 *       distance; the window belongs to the defender who drew it, a cover defender the CPU switches to starts fresh).
 *       Against a human every standing challenge is
 *       never from behind (duelMaxBehind); in the duel also never with the bodies meeting by mid-contact nor at a
 *       reckless closing speed (unless the ball is well clear), and no slide. Level or ahead and alongside a human
 *       running at pace, Professional up make the shoulder challenge (never from behind, never in our own area, never
 *       at a carrier through on goal; a cooldown after it).
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
  CPU_CONTROLLER_BASE, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, ControllerKind, GestureKind, MatchPhase, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, type InputFrame } from '../../contracts/input';
import type { ControllerState, CpuBrainState, PlayerState, SimState } from '../../contracts/state';
import type { LevelParams } from '../../contracts/systems';
import {
  T_AI, T_DRIBBLE, T_LEVEL, T_PLAYER, T_SKILL, T_TACKLE, T_TOUCH, T_DEFENDING, T_TACKLE_PLAY, T_FIRST_TOUCH, T_LOCOMOTION,
  T_FEEL2, T_FOUL_CALL,
} from '../../contracts/tuning';
import { isFree } from '../../sim/actions/dispatch';
import { tackleKind } from '../../sim/control/resolveActions';
import { ballEta, controlContext, Ctx } from '../../sim/control/resolveShared';
import { aerialChance } from '../../sim/kicks/aerial';
import { inSkillVulnerableWindow } from '../../sim/kicks/skills';
import { inPenaltyArea } from '../../sim/pitch/geometry';
import { comeOutWanted } from '../../sim/keeper/sweeperHooks';
import { trapLead } from '../../sim/players/firstTouch';
import { ticksToReach } from '../../sim/players/locomotion';
import { createInterceptEstimate, estimateIntercept } from '../steer';
import { composureNoiseMul, levelParams, levelValue, teamLevel } from './levels';


const L = T_DEFENDING;
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
/** Stick being built: unit direction (ST[0], ST[1]) and magnitude 0..1 (ST[2]); buttons; sprint wish.
 *  [FIN-P2] A typed array, not module lets: V8 boxes every double stored into a module-level variable (a new heap number
 *  per store, in every tier), ~10 per CPU defender per tick. */
const ST = new Float64Array(3);
let btn = 0;
let wantSprint = 0;
/** Exposure of the carrier's ball (exposure()): 1/0, age in ticks, window key, 1 = skill / first-touch window. */
let expOn = 0;
let expAge = 0;
let expKey = 0;
let expSkill = 0;
/** Goal-side unit of the latest carrier evaluation (defendCarrier): from the carrier toward our goal centre. */
const G_UNIT = new Float64Array(2); // [FIN-P2] x, z (a typed array: see ST)
/** [QF-16] Debug (tests / tools): the latest carrier evaluation's block (1 = blocking) and, per team, the reason of its
 *  latest challenge (CH_* below). Written only, never read by the AI. */
export const DEFEND_DEBUG = { hold: 0, why0: 0, why1: 0 };
/** DEFEND_DEBUG challenge reasons: careful tackle on an exposed ball, rash (noisy) one, still carrier, held carrier,
 *  block poke, rash lunge at his feet, slide goal-side, slide from behind. */
export const CH_CAREFUL = 1, CH_RASH = 2, CH_STILL = 3, CH_HELD = 4, CH_POKE = 5, CH_LUNGE = 6, CH_SLIDE = 7, CH_SLIDE_BEHIND = 8;
/** [FEEL-2] Shoulder challenge level with a human dribbler; read tackle on a human dribbler's side step. */
export const CH_SHOULDER = 9, CH_READ = 10;
/** [FEEL-2] The duel with a human dribbler this tick (duelState): 0 none, DUEL_SOLD, DUEL_READ; DUEL_DEBUG mirrors it
 *  per team for tests and probes (debug only, never read by the sim). */
export const DUEL_SOLD = 1, DUEL_READ = 2;
export const DUEL_DEBUG = { st0: 0, st1: 0, moves0: 0, moves1: 0, sl0: -1, sl1: -1 };
let duelSt = 0, duelDir = 0, duelEng = 0;
/** [FEEL-2 round 2] brain.p3 packing of the duel window: until x DUEL_UNTIL_MUL + slot x 2 + side (slot < 32). */
const DUEL_UNTIL_MUL = 64, DUEL_SLOT_MASK = 31;

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
  if (!(d > EPS)) { ST[0] = 0; ST[1] = 0; ST[2] = 0; return; }
  ST[0] = dx / d;
  ST[1] = dz / d;
  ST[2] = d >= L.arriveDist ? 1 : d / L.arriveDist;
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
  ST[0] = dx / dl;
  ST[1] = dz / dl;
  ST[2] = jog > EPS && sp < jog ? sp / jog : 1;
  if (p.sprinting === 1) wantSprint = 1;
}

/** Write the built stick and buttons into the frame (radial magnitude <= AXIS_SCALE). */
function flush(out: InputFrame): void {
  let m = ST[2]!;
  if (!(m > 0) || !(ST[0]! === ST[0]!) || !(ST[1]! === ST[1]!)) m = 0;
  if (m > 1) m = 1;
  out.mx = Math.trunc(ST[0]! * m * AXIS_SCALE);
  out.mz = Math.trunc(ST[1]! * m * AXIS_SCALE);
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
  for (let i = 0; i < T_TACKLE.standWindup; i++) { sp *= T_TACKLE_PLAY.windupSpeedKeep; dw += sp; }
  dw /= TICK_HZ;
  const lunge = sp > T_TACKLE_PLAY.standLungeSpeed ? sp : T_TACKLE_PLAY.standLungeSpeed;
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
  return !(along > 0) || along - rv > lb - T_TACKLE_PLAY.ballFirstMargin + margin ||
    (lat < 0 ? -lat : lat) > rv + T_TACKLE_PLAY.blockLateral + margin;
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
  return along > 0 && along - rv <= lb - T_TACKLE_PLAY.ballFirstMargin && (lat < 0 ? -lat : lat) <= rv + T_TACKLE_PLAY.blockLateral;
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
  return !(along > 0) || along - rv > lb - T_TACKLE_PLAY.ballFirstMargin + margin ||
    (lat < 0 ? -lat : lat) > rv + T_TACKLE_PLAY.blockLateral + margin;
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
 * outfield teammate covering the channel between him and the goal ([FEEL-2 round 2] other than `except`: with the
 * challenger himself left out, "he is the last man", a foul by him would deny an obvious goal-scoring chance).
 */
export function throughOnGoal(s: SimState, team: number, q: Readonly<PlayerState>, maxDist: number, except = -1): boolean {
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
    if (c.active !== 1 || c.isKeeper === 1 || i === except) continue;
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

/**
 * [FEEL-2] The duel with a HUMAN carrier q coming at our goal (unit g): one deterministic draw per side step decides
 * whether the defender is sold or reads it (D-033, D-035). State in the defending brain while it defends in open play
 * (carrier.ts resets p1..p3 on any gap, setpieces.ts per restart): p1 = tick of the last engaged call (-1 once disengaged
 * with no window open; a gap re-initialises, and nothing is written until he engages),
 * p2 = the carrier's lateral velocity reference (m/s across g; follows a steady run at duelLatTrack per tick, so a
 * constant diagonal is no move), p3 = the open window: +(until x 64 + slot x 2 + side) sold, -(...) read, 0 none
 * (side bit 1 = the step went +n, n = (-gz, gx); slot = the defender who faced the step). A move is the lateral velocity
 * changing by duelStepDelta from the reference while engaged (goal-side within duelEngageDist, the carrier approaching
 * at duelApproachSpeed); none is looked for while a window is open, and a window is void once the ball has changed hands
 * since it opened, or once the team's controlled defender is not the one who drew it ([FEEL-2 round 2, D-038] a cover
 * defender the CPU switches to inherited "sold" for a step he never faced: no challenge right next to the dribbler).
 * Sets duelSt (0, DUEL_SOLD, DUEL_READ) and duelDir (+1 / -1).
 */
function duelState(
  s: SimState, team: number, brain: CpuBrainState, slot: number, q: Readonly<PlayerState>, gx: number, gz: number,
  cosG: number, d: number,
): void {
  const F = T_FEEL2;
  duelSt = 0; duelDir = 0;
  duelEng = cosG >= F.duelGoalSideCos && d <= F.duelEngageDist && q.vx * gx + q.vz * gz >= F.duelApproachSpeed ? 1 : 0;
  const t = s.tick;
  const latV = q.vx * -gz + q.vz * gx;
  if (brain.p1 !== t - 1) {
    // Fresh (a gap, or p1 left by carrier.ts / setpieces.ts): nothing to track until he engages.
    if (duelEng === 0) return;
    brain.p2 = latV; brain.p3 = 0;
  }
  brain.p1 = t;
  const w = brain.p3;
  if (w !== 0) {
    const aw = w < 0 ? -w : w;
    const until = Math.floor(aw / DUEL_UNTIL_MUL);
    const opened = until - (w > 0 ? F.duelSoldTicks : F.duelReadTicks);
    if (t < until && t - s.ball.ownerT <= opened && ((aw >> 1) & DUEL_SLOT_MASK) === slot) {
      duelSt = w > 0 ? DUEL_SOLD : DUEL_READ;
      duelDir = (aw & 1) === 1 ? 1 : -1;
      // Sold: wrong-footed whichever way he goes on (a second step back is no rescue), until he is past or the window
      // closes. Read: a new step in the window is a new move.
      if (w > 0) {
        if (latV > F.duelStepDelta * 0.5) duelDir = 1; else if (latV < -F.duelStepDelta * 0.5) duelDir = -1;
        brain.p2 = latV;
        return;
      }
      // Read: over once he is beaten (well behind the ball's line).
      if (cosG < F.duelGoalSideCos - 0.5) { brain.p3 = 0; duelSt = 0; duelDir = 0; }
    } else {
      brain.p3 = 0;
    }
  }
  const dl = latV - brain.p2;
  if (duelEng === 0) { brain.p1 = -1; return; } // disengaged, no window: the next engagement starts fresh
  if (!(dl >= F.duelStepDelta || dl <= -F.duelStepDelta)) { brain.p2 += dl * F.duelLatTrack; return; }
  brain.p2 = latV;
  const a = s.attrs[q.slot]!;
  let k = 1 + F.duelSkillSlope * ((a.dribbling + a.agility) * 0.5 - F.duelSkillRef) / 50;
  if (!(k >= F.duelSkillMin)) k = F.duelSkillMin; else if (k > F.duelSkillMax) k = F.duelSkillMax;
  const sold = noise01(s.config.seed | 0, team * 64 + q.slot + 4096, t) < levelValue(s, team, F.duelSoldChance) * k;
  duelSt = sold ? DUEL_SOLD : DUEL_READ;
  duelDir = dl > 0 ? 1 : -1;
  const until = t + (sold ? F.duelSoldTicks : F.duelReadTicks);
  brain.p3 = (sold ? 1 : -1) * (until * DUEL_UNTIL_MUL + slot * 2 + (duelDir > 0 ? 1 : 0));
  if (team === 0) DUEL_DEBUG.moves0++; else DUEL_DEBUG.moves1++;
}

/** [FEEL-2] lungeContact scratch: [0] ball distance from him at mid-contact, [1] closing speed at the contact, [2] RUL-09
 *  fromBehind there, [3] the nearest the two bodies come (centres) from now to mid-contact, [4] their distance at
 *  mid-contact. */
const LC = new Float64Array(5);

/**
 * [FEEL-2] A standing tackle started now, predicted at mid-contact (as lungePresented: the wind-up keeps
 * windupSpeedKeep of his speed along the line to the ball per tick, then the lunge at standLungeSpeed or that speed;
 * the carrier and the ball move on linearly): LC[0] the ball's distance from him, LC[1] the closing speed (his lunge v
 * the carrier's velocity along the line between them: RUL-09 calls any challenge above 4.675 m/s reckless, ball first or
 * not, and a defender's lunge at a dribbler running at him closes at lunge + run), LC[2] fromBehind (the carrier's
 * facing = his run when moving). Pure apart from LC.
 */
function lungeContact(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>): void {
  LC[0] = 1e9; LC[1] = 1e9; LC[2] = 1; LC[3] = 0; LC[4] = 0;
  const b = s.ball;
  let ux = b.x - p.x, uz = b.z - p.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > EPS)) return;
  ux /= ul; uz /= ul;
  let along = p.vx * ux + p.vz * uz;
  if (!(along > 0)) along = 0;
  let dw = 0, sp = along;
  for (let i = 0; i < T_TACKLE.standWindup; i++) { sp *= T_TACKLE_PLAY.windupSpeedKeep; dw += sp; }
  dw /= TICK_HZ;
  const lunge = sp > T_TACKLE_PLAY.standLungeSpeed ? sp : T_TACKLE_PLAY.standLungeSpeed;
  const t1 = T_TACKLE.standWindup / TICK_HZ;
  const t2 = (T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1)) / TICK_HZ;
  const d2 = dw + lunge * (t2 - t1);
  const px = p.x + ux * d2, pz = p.z + uz * d2;
  const bx = b.x + b.vx * t2 - px, bz = b.z + b.vz * t2 - pz;
  LC[0] = Math.sqrt(bx * bx + bz * bz);
  const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
  const fx = qs > 0.5 ? q.vx / qs : q.fx, fz = qs > 0.5 ? q.vz / qs : q.fz;
  // The bodies may meet anywhere from now to mid-contact: the worst closing speed and fromBehind over the line between
  // them now, at the first contact tick and at mid-contact.
  let worst = -1e9, fb = -1e9, near = 1e9, sep2 = 0;
  for (let k = 0; k < 3; k++) {
    const tk = k === 0 ? 0 : k === 1 ? t1 : t2;
    const dk = k === 0 ? 0 : k === 1 ? dw : d2;
    let cx = q.x + q.vx * tk - (p.x + ux * dk), cz = q.z + q.vz * tk - (p.z + uz * dk);
    const cl = Math.sqrt(cx * cx + cz * cz);
    if (cl < near) near = cl;
    if (k === 2) sep2 = cl;
    if (!(cl > EPS)) continue;
    cx /= cl; cz /= cl;
    const c = (ux * lunge - q.vx) * cx + (uz * lunge - q.vz) * cz;
    if (c > worst) worst = c;
    const f = cx * fx + cz * fz;
    if (f > fb) fb = f;
  }
  if (worst > -1e9) { LC[1] = worst; LC[2] = fb; }
  LC[3] = near;
  LC[4] = sep2;
}

/** [FEEL-2] A standing challenge on a human carrier now (lungeContact): not from behind him (fromBehind at most
 *  duelMaxBehind); in a duel also not with the bodies meeting by mid-contact, nor at a reckless closing speed unless the
 *  ball is well clear of his body. */
function safeOnHuman(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>, duel: boolean): boolean {
  lungeContact(s, p, q);
  // Never through his back. In a duel (coming at him) also never with the bodies meeting by mid-contact (SIM-14 counts
  // centres within 2 radii + bodyMargin as a contact, the ball first or not), and at a reckless closing speed only for a
  // ball well clear of his body (the bodies still duelClearSep apart at mid-contact: the ball is won before they meet).
  if (!(LC[2]! <= T_FEEL2.duelMaxBehind)) return false;
  return !duel || (LC[3]! >= 2 * T_PLAYER.bodyRadius + T_TACKLE_PLAY.bodyMargin + T_FEEL2.duelBodyGap &&
    (LC[1]! <= T_FEEL2.duelMaxClosing || LC[4]! >= T_FEEL2.duelClearSep));
}

/**
 * [FEEL-2] Read tackle on a human dribbler's side step (duelState DUEL_READ): the ball at mid-contact within reachFrac x
 * standReach, and safe (safeOnHuman). Pure apart from LC.
 */
function readTackleOk(s: SimState, p: Readonly<PlayerState>, q: Readonly<PlayerState>, reachFrac: number): boolean {
  return safeOnHuman(s, p, q, true) && LC[0]! <= T_TACKLE.standReach * reachFrac;
}

/**
 * [FEEL-2] Shoulder challenge on a human carrier now: at the contact (shoulderWindup + half the window, both moving on
 * linearly) the defender is level or ahead (RUL-09 fromBehind at most shoulderMaxBehind) and closes at most
 * shoulderMaxClosing. Pure.
 */
function shoulderOk(p: Readonly<PlayerState>, q: Readonly<PlayerState>): boolean {
  const t = (T_TACKLE_PLAY.shoulderWindup + (T_TACKLE_PLAY.shoulderContactTicks >> 1)) / TICK_HZ;
  let ux = q.x + q.vx * t - (p.x + p.vx * t), uz = q.z + q.vz * t - (p.z + p.vz * t);
  const l = Math.sqrt(ux * ux + uz * uz);
  if (!(l > EPS)) return false;
  ux /= l; uz /= l;
  const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
  const fx = qs > 0.5 ? q.vx / qs : q.fx, fz = qs > 0.5 ? q.vz / qs : q.fz;
  if (ux * fx + uz * fz > T_FEEL2.shoulderMaxBehind) return false;
  return (p.vx - q.vx) * ux + (p.vz - q.vz) * uz <= T_FEEL2.shoulderMaxClosing;
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
  G_UNIT[0] = gx; G_UNIT[1] = gz;
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
  // [FEEL-2] The duel with a human dribbler (duelState, D-035): sold by his side step, the defender leans the wrong way
  // (no challenge); reading it, he goes for where the ball crosses his line and may make the read tackle.
  if (humanQ && !hold && s.match.phase === MatchPhase.IN_PLAY) duelState(s, team, brain, slot, q, gx, gz, cosG, d);
  else { duelSt = 0; duelEng = 0; }
  // The duel context (coming at him, or a side step being played out): every challenge on the human is made safe there.
  const duelCtx = duelSt !== 0 || duelEng === 1;
  if (team === 0) { DUEL_DEBUG.st0 = duelSt; DUEL_DEBUG.sl0 = slot; } else { DUEL_DEBUG.st1 = duelSt; DUEL_DEBUG.sl1 = slot; }
  if (duelSt !== 0) {
    const b0 = s.ball;
    const nx = -gz, nz = gx;
    let along = (p.x - b0.x) * gx + (p.z - b0.z) * gz;
    if (along < 0) along = 0;
    if (duelSt === DUEL_SOLD) {
      // Wrong-footed: he goes the wrong way to duelSoldLean beyond the ball's line on the far side from the dribbler's
      // step (already further that way: he stays planted there), the ground held along g; he does not chase after him.
      const lean = levelValue(s, team, T_FEEL2.duelSoldLean);
      const pl = (p.x - b0.x) * nx + (p.z - b0.z) * nz;
      const tl = pl * -duelDir > lean ? pl : -duelDir * lean;
      steerTo(p, b0.x + gx * along + nx * tl, b0.z + gz * along + nz * tl, 0);
    } else if (goalSide) {
      // Reading: he steps in toward the ball's line (duelReadStepIn of his distance from it along g, by level).
      along *= 1 - levelValue(s, team, T_FEEL2.duelReadStepIn);
      const app = q.vx * gx + q.vz * gz;
      let tm = app > EPS ? along / app : T_FEEL2.duelReadLeadMax;
      if (tm > T_FEEL2.duelReadLeadMax) tm = T_FEEL2.duelReadLeadMax;
      const latV = q.vx * nx + q.vz * nz;
      steerTo(p, b0.x + gx * along + nx * latV * tm, b0.z + gz * along + nz * latV * tm, 0);
    }
  }

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
    if (holdV > EPS) { ST[0] = vx / holdV; ST[1] = vz / holdV; ST[2] = 1; } else { ST[0] = 0; ST[1] = 0; ST[2] = 0; holdV = 0; }
  }
  const wasContain = (ctl.buttons & Btn.PASS) !== 0;
  const wasJockey = (ctl.buttons & Btn.SHIELD) !== 0;
  if (duelSt === DUEL_SOLD || (duelSt === DUEL_READ && goalSide)) {
    // [FEEL-2] Jockey (SIM-04, facing him) to the duel target, sprint-jockeying (0.55 x top sideways) when reading;
    // never the contain arrive.
    btn |= Btn.SHIELD;
    wantSprint = duelSt === DUEL_READ ? 1 : 0;
  } else if (cosG > L.behindCos && d <= L.containDist && qs >= (wasContain ? L.containKeepSpeed : L.containSpeed)) {
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
      ST[2] = topP > EPS ? holdV / topP * T_LOCOMOTION.sprintStickFull : 1;
      if (ST[2]! > 1) ST[2] = 1;
      if (ST[2]! < L.sprintMinStick) ST[2] = L.sprintMinStick;
      // [QF-16 skeptic] Faster than even a sprint jockey goes sideways (jockeySpeedFraction of top): run, not jockey.
      // Jockeying (facing the carrier) capped him at 0.55 x top, 5.1 m/s, so a human jogging diagonally at full stick
      // (5.5 m/s) outran the block alongside him and kept the ball 3-4 of 8 at Legend, 29-36 m in 10 s. A jogging
      // human carrier only (faster than blockWalkSpeed): a walker, and every bot carrier (blocked at a walk only), a
      // sprint jockey keeps up with, so the walking blocks and the bot game are unchanged.
      if (humanQ && qs >= L.blockWalkSpeed && holdV > topP * T_PLAYER.jockeySpeedFraction) btn &= ~Btn.SHIELD;
    } else {
      wantSprint = 0;
      ST[2] = jogP > EPS ? holdV / jogP : 0;
    }
  }

  // Second defender in our final third.
  const goalLineDist = HALF_LENGTH + dir * q.x;
  if (goalLineDist <= ((ctl.buttons & Btn.MOD_R) !== 0 ? L.secondDefKeepDist : L.secondDefDist)) btn |= Btn.MOD_R;

  keeperRush(s, team, ctl, q);

  if (switched || brain.tackleCd > 0 || !isFree(p) || p.isKeeper === 1) return;
  if (controlContext(s, slot) !== Ctx.DEFENCE) return;
  // [FEEL-2] Sold by the side step: off balance, no challenge of any kind until the window closes.
  if (duelSt === DUEL_SOLD) return;
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
  // [FEEL-2] Reading a human dribbler's side step: the read tackle on his (unexposed) ball as it passes, ball-first and
  // never at a reckless closing speed (readTackleOk); in our own area with the box care of a careful tackle.
  // [FEEL-2 round 2] Not as the last man within dogsoMaxGoalDist (a foul would be a straight red: Legend 4 reds in 72
  // scenes 28 m out on the skeptics' grid); he keeps reading the step instead (D-038).
  if (duelSt === DUEL_READ && kind === ActionKind.STAND_TACKLE &&
    readTackleOk(s, p, q, levelValue(s, team, T_FEEL2.duelReadReach)) && lungePresented(s, p, q, L.blockPokeMargin) &&
    (!inBox || boxClear(s, p, q)) && !throughOnGoal(s, team, q, T_FOUL_CALL.dogsoMaxGoalDist, slot)) {
    why(team, CH_READ); pressTackle(brain, lv); return;
  }
  // [FEEL-2] Level (or ahead) and alongside a human dribbler, the shoulder challenge (no exposed ball needed; SIM-14 makes
  // it a strength duel), one draw per shoulderWindow ticks by level (T_FEEL2.shoulderChance); never from behind or at a
  // reckless closing speed (shoulderOk), not in our own area from shoulderNoBoxFrom up, nor at a carrier through on goal
  // (a foul would be a red card); then no challenge for shoulderCooldown ticks.
  if (kind === ActionKind.SHOULDER && humanQ && d <= T_FEEL2.shoulderDist && qs >= T_FEEL2.shoulderMinSpeed &&
    !(inBox && teamLevel(s, team) >= T_FEEL2.shoulderNoBoxFrom) &&
    noise01(seed, who, Math.floor(s.tick / T_FEEL2.shoulderWindow) * 4 + 3) < levelValue(s, team, T_FEEL2.shoulderChance) &&
    shoulderOk(p, q) && !throughOnGoal(s, team, q, T_FOUL_CALL.dogsoMaxGoalDist)) {
    why(team, CH_SHOULDER);
    btn |= Btn.SHOOT;
    btn &= ~Btn.MOD_R;
    brain.tackleCd = T_FEEL2.shoulderCooldown;
    return;
  }
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
        // [FEEL-2] In the duel with a human carrier the careful tackle wants the ball first (lungePresented) too, not only
        // while blocking: one that met his body first was a foul (straight jogs at a Legend centre-back: 12 fouls in 72).
        const first = (holdV < 0 && !duelCtx) || !humanQ || lungePresented(s, p, q, L.blockPokeMargin);
        // [FEEL-2] Against a human carrier never from behind, and in the duel never at a reckless closing speed nor with
        // the bodies meeting (safeOnHuman): a lunge at a dribbler running at him was a yellow card even when it won the
        // ball first; he lets him run into him instead (SIM-06).
        if ((rash || (wellTimed(s, p, q) && careful && first)) && (!humanQ || safeOnHuman(s, p, q, duelCtx))) { why(team, rash ? CH_RASH : CH_CAREFUL); pressTackle(brain, lv); return; }
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
          (!inBox || !(levelValue(s, team, T_LEVEL.boxBodyClear) > 0) || boxClear(s, p, q)) && (!humanQ || safeOnHuman(s, p, q, duelCtx))) {
          why(team, still ? CH_STILL : held ? CH_HELD : CH_POKE);
          pressTackle(brain, lv);
          return;
        }
      }
      const bucket = Math.floor(s.tick / L.rashBucketTicks);
      // [QF-16] Never into a shielding carrier's back, nor at a ball his body hides from us (not ball-first now): a
      // lunge nobody could win the ball with is a foul (a carrier shielding for 10 s was fouled 2-7 times and never
      // robbed at every level up to World Class; a strafer in front of a Professional defender 9 times in 80 s).
      if (noise01(seed, who, bucket * 4 + 2) < noisy * L.rashLungeChance && q.shielding !== 1 && ballFirstAt(s, p, q, 0, 0) &&
        (!humanQ || safeOnHuman(s, p, q, duelCtx))) {
        why(team, CH_LUNGE); pressTackle(brain, lv); return;
      }
    }
  }

  // Slide: goal-side, the ball loose-ish (between touches), beyond standing reach, in our half and urgent (a quick
  // carrier or our final third), one draw per window; from behind only for a carrier through on goal, rarely.
  // [FEEL-2] Not in a duel with a human dribbler: the read is a standing challenge (or none).
  if (goalLineDist > L.slideZoneDist || duelSt !== 0) return;
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
      ST[2] = 1;
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
  if (ST[2]! > 0) {
    if (rush) ST[2] = 1;
    else if (ST[2]! < L.chaseMinStick && d > L.chaseHoldDist) ST[2] = L.chaseMinStick;
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
  const reach = y <= T_DRIBBLE.controlHeight ? T_TOUCH.receiveRadius : T_TOUCH.receiveRadius * T_FIRST_TOUCH.chestReachMul;
  if (y > T_TOUCH.trapHeight || !isFree(p) || p.noTouchT > 0) return;
  if (b.vx * b.vx + b.vz * b.vz <= T_FIRST_TOUCH.minTrapSpeed * T_FIRST_TOUCH.minTrapSpeed) return;
  if (b.lastKickBy === p.slot && s.tick - b.lastKickTick < T_FIRST_TOUCH.selfKickTicks) return;
  const bv = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  let sx: number, sz: number;
  const free = ST[2]! > 0 ? 0 : 1;
  if (free === 0) { sx = ST[0]! * ST[2]!; sz = ST[1]! * ST[2]!; } else if (bv > EPS) { sx = b.vx / bv; sz = b.vz / bv; } else return;
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
  ST[0] = ux; ST[1] = uz; ST[2] = 1;
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
  if (!(ST[2]! > 0)) return;
  const brake = 0.5 / T_PLAYER.decel;
  const ez = p.vz * p.vz * brake + L.momentumBrakeSlack, ex = p.vx * p.vx * brake + L.momentumBrakeSlack;
  let sx = ST[0]! * ST[2]!, sz = ST[1]! * ST[2]!;
  if ((p.z > HALF_WIDTH - ez && p.vz > 0 && sz > 0) || (p.z < -HALF_WIDTH + ez && p.vz < 0 && sz < 0)) sz = 0;
  if ((p.x > HALF_LENGTH - ex && p.vx > 0 && sx > 0) || (p.x < -HALF_LENGTH + ex && p.vx < 0 && sx < 0)) sx = 0;
  const m = Math.sqrt(sx * sx + sz * sz);
  if (m > EPS) { ST[0] = sx / m; ST[1] = sz / m; ST[2] = m < 1 ? m : 1; } else { ST[0] = 0; ST[1] = 0; ST[2] = 0; wantSprint = 0; }
}

/** A loose ball a teammate chases (team.chaser): cover goal-side of it instead of a second chase. */
function coverLoose(s: SimState, team: number, p: Readonly<PlayerState>): void {
  const b = s.ball;
  const dir = s.teams[team]!.dir;
  let gx = -dir * HALF_LENGTH - b.x, gz = -b.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > EPS) { gx /= gl; gz /= gl; } else { gx = -dir; gz = 0; }
  const c = gl < L.looseCoverDist ? gl * L.looseCoverFrac : L.looseCoverDist;
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
  ST[0] = 0; ST[1] = 0; ST[2] = 0;
  if (!(v > EPS)) return;
  const ux = b.vx / v, uz = b.vz / v;
  const rx = p.x - b.x, rz = p.z - b.z;
  if (rx * ux + rz * uz <= 0) return;
  const off = rx * -uz + rz * ux;
  const ao = off < 0 ? -off : off;
  if (ao >= L.keeperLaneClear) return;
  const side = off < 0 ? -1 : 1;
  steerTo(p, p.x - uz * side * (L.keeperLaneClear - ao + L.keeperLaneMargin), p.z + ux * side * (L.keeperLaneClear - ao + L.keeperLaneMargin), 0);
  ST[2] = 1;
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
  ST[0] = 0; ST[1] = 0; ST[2] = 0; btn = 0; wantSprint = 0;
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
/** [TUN-1] Old name of contracts/tuning.ts T_DEFENDING (read-only; tests import it). */
export const DEFEND_TUNING = T_DEFENDING;
/** Goal-side unit of the latest carrier evaluation (tests). */
export function debugGoalSideUnit(o: { x: number; z: number }): void { o.x = G_UNIT[0]!; o.z = G_UNIT[1]!; }

/**
 * [SIM-14] Tackles: standing (timed lunge with reach and recovery ticks; success from timing, angle and
 * attributes; mistimed = miss, stumble or foul), hard tackle, slide (long reach, long recovery, high foul risk
 * from behind), shoulder challenge alongside, push/pull when chasing, contextual clearance, interceptions when a
 * pass crosses a defender's reach. Every challenge that contacts an opponent is recorded in
 * s.match.challenges (pushChallenge) for RUL-09 to classify. Emits TACKLE, INTERCEPT.
 *
 * ACTIONS (startTackle; the handlers live behind the import-cycle-safe shells of tackleHooks.ts). Every tackle is
 * wind-up -> contact window -> recovery (beginAction with actContact = wind-up, actDur = wind-up + window + recovery):
 *   STAND_TACKLE  T_TACKLE.standWindup / standContactTicks / standRecovery, reach standReach from the body centre (ball
 *                 inside the frontal cone standConeHalf of the lunge, or within closeRadius anywhere). Movement LOCKED:
 *                 the wind-up keeps windupSpeedKeep of his speed per tick, the window lunges at >= standLungeSpeed;
 *                 the lunge direction homes toward the ball by lungeTurnPerTick until the contact.
 *   HARD_TACKLE   as STAND with reach x hardReachMul, lunge x hardLungeMul, recovery x hardRecoveryMul, hardBonus win
 *                 chance, harder pokes (ball driven through) and a STUMBLE for the victim of a ball-first body contact.
 *   SLIDE_TACKLE  slideWindup / slideContactTicks / slideRecovery. The slide speed v0 = clamp(his speed along the slide,
 *                 slideMinSpeed, slideMaxSpeed), reached by the end of the wind-up, decays linearly to 0 over
 *                 slideGlideTicks from the contact (LOCKED, no homing once on the ground). The foot zone is the
 *                 segment from his centre to slideFootReach ahead, slideFootRadius wide; with the glide that is about
 *                 T_TACKLE.slideReach at a sprint. A slide
 *                 always plays a loose ball its feet reach (never left under him). Quick get-up (quickGetUp, the
 *                 human's second X): the recovery after the window shrinks to T_TACKLE.slideGetUpQuick.
 *   SHOULDER      shoulderWindup / shoulderContactTicks / shoulderRecovery, not locked (he keeps running alongside).
 *                 Bodies within T_TACKLE.shoulderReach -> one strength duel (shoulderStrengthSpan); the loser is
 *                 bumped sideways (shoulderPush). A won duel against the carrier knocks him off the ball (short
 *                 STUMBLE, dispossessed) and frees the tackler at once so SIM-06 can give him the ball.
 *   PUSH_PULL     pushWindup / pushContactTicks / pushRecovery, not locked. While the carrier is within
 *                 T_TACKLE.pushPullReach in the window he is slowed (pullKeep of his velocity kept per tick, the puller
 *                 pullSelfKeep); one balance duel on the first contact (pushBalanceBase + strength / pushStrengthSpan)
 *                 may knock him off the ball (short STUMBLE).
 * A tackle starts when the player is free and the ball is live (IN_PLAY, or a restart already taken), never against a
 * ball in a keeper's hands or owned by his own team; SHOULDER / PUSH_PULL need an opponent target (the carrier).
 *
 * CONTACT (tackleContacts, contact phase, slot order, one ball contact per tick): for a foot tackle in its window,
 * not yet resolved, on a live low ball (ballHeight; slides slideBallHeight), not owned by a teammate:
 *   - ball in the foot zone and not shielded by the victim's body (the near edge of the carrier's body lies before the
 *     ball on the line from the tackler, within blockLateral of it) -> ONE s.rng roll against winChance:
 *       loose ball: looseChance (a slide: always); carrier's ball: baseChance + attrWeight x (tackle skill - resistance)
 *       + exposureWeight x (exposure - 0.5) + hardBonus / slideBonus, then x reach edge (1 - edgeReachPenalty x
 *       (d / reach)^2) x angle (front frontMul, side sideMul, behind behindMul, linear in the facing dot) x shieldMul
 *       when SIM-05 shieldBlocks x skillProtectMul when he is in a SIM-13 skill outside its vulnerable window,
 *       clamped to minChance..maxChance. Tackle skill = standingTackle (slide: slidingTackle); resistance = dribbling,
 *       ballControl, strength (resistDribbling / resistControl / resistStrength). Exposure (timing): 1 in the skill's
 *       vulnerable window, firstTouchExposure in his first-touch window, kickWindupExposure in a kick wind-up, else how
 *       far the ball is from his feet between touches (exposureNear..exposureFar).
 *     Won (TACKLE c=1): the carrier is dispossessed (noTouchT = T_DRIBBLE.dispossessedNoTouch); stand / hard keep the
 *     ball with keepChance (by standingTackle; hard x hardKeepMul; never a slide, never a ball faster than
 *     keepMaxBallSpeed relative to him): takePossession, the ball cushioned onto settleAhead in front of him, and the
 *     tackle ends at once (he dribbles away; SIM-06 runs later this tick). Otherwise the ball is poked loose
 *     (applyKick TACKLE_POKE: not a pass, no offside snapshot) in a spread around the lunge (standPokeSpread /
 *     hardPokeSpread / slidePokeSpread) at pokeSpeed lo..hi of the kind. Three draws per resolution, always.
 *     Lost: with the carrier's body in the zone it is a body contact (below); otherwise he is beaten: stand / hard
 *     tacklers STUMBLE for beatenStumbleTicks (TACKLE c=0).
 *   - else the victim's body in the zone first -> body contact without the ball: ChallengeRecord ballFirst 0, TACKLE c=0,
 *     the tackle is spent. RUL-09 decides the foul (and knocks the victim down).
 *   - After the resolution, a body contact later in the window is still recorded once (ballFirst 1 after a won ball:
 *     a hard tackle or slide then puts the victim on his heels, STUMBLE).
 *   - Window over without a resolution: a whiff (TACKLE c=0, b = target or -1). One TACKLE event per attempt.
 * Challenge records (pushChallenge): fromBehind = dot(unit(victim - tackler), victim facing) (1 behind, 0 side, -1
 * front), closingSpeed = max(0, relative velocity along that line), kind, ballFirst, position = the victim's.
 *
 * DOWN STATES (knockDown): STUMBLE (T_TACKLE.stumbleTicks; he can still move slowly: intent capped at
 * stumbleMoveScale, no sprint) and FALLEN (T_TACKLE.fallTicks LOCKED on friction) -> GET_UP (getUpTicks, LOCKED).
 * knockDown interrupts the current action (endAction(..., 1)); a STUMBLE never downgrades FALLEN / GET_UP. p.stunT =
 * ticks until he is up (counted down by these handlers; any other stunT is counted down in tackleContacts so it can
 * never stick). SIM-06 releases the ball of a stunned owner.
 * Ball stuck under a down player (glitch list): a loose slow ball (downBallSpeed) inside the lying body (a capsule
 * downBodyHalf either side of his centre along his facing, downBodyRadius wide) of a slider on the ground, a FALLEN or
 * a GET_UP player squirts out sideways at squirtSpeed (DEFLECTION, recordTouch on him) at once.
 * Keeper fights a defender (glitch list, with GKP-03): an outfield player leaves a loose ball to his own keeper while
 * the keeper is in a GK_RUSH / GK_CATCH / GK_DIVE / GK_PUNCH within keeperPriorityDist of it (tackles and interceptions;
 * [QF-13 skeptic] his body in a fresh shot's path still blocks it: the shot went through him into the net).
 *
 * CLEARANCE: startClearance starts SIM-08's KICK action with KickKind.CLEARANCE (no charging): his own ball, a loose
 * ball in reach (contact before it leaves reach), or a low ball arriving within clearMaxLeadTicks on a path within
 * clearLane (contact timed to the arrival; SIM-08's grace covers small errors). A ball in the air he can only meet
 * with his head or a volley goes to SIM-12 startAerialClearance. solveClearance: long and high (clearAngle, speed
 * clearSpeedMin..Max by power and kicking quality), upfield (the request direction / his facing when it points
 * forward enough, else straight up the pitch), toward the near touchline (clearTouchlineZ, clearUpfield ahead) when an
 * opponent is within clearPressureDist; never less forward than clearMinForward; aim and speed error from quality and
 * pressure (two rngGauss calls, always).
 *
 * INTERCEPTIONS (interceptContacts): an untouched opponent pass (the SIM-07 definition: isFootPassKind, nobody has
 * touched it since the kick) at or below interceptMaxHeight and faster than interceptMinSpeed (slower balls are SIM-06
 * pick-ups) that ENTERS the reach (T_TACKLE.interceptReach) of a free outfield opponent of the passer this tick
 * (swept: the ball's segment this tick against his position; outside his reach the tick before), in the order the
 * ball reaches them, gets one s.rng roll each: chance = lerp(interceptChanceMin, Max, interceptions / agility blend)
 * x ball speed (1 up to interceptEasySpeed .. interceptHardMul at interceptHardSpeed) x distance of the pass line from
 * him (1 inside interceptCoreFrac of the reach .. interceptEdgeMul at the edge) x height (1 up to interceptLowHeight
 * .. interceptHighMul at the max) x facing (1 ball in front .. interceptBehindMul from behind). (No "reactions"
 * attribute exists: agility stands in for it.) Success:
 * the ball moves back to the contact point on its own path; slow enough relative to him (lerp(interceptControlSpeedLo,
 * Hi, ballControl)) -> controlled (takePossession, cushioned to his feet), else blocked (DEFLECTION off him). A ball
 * whose path runs through his body (interceptBodyBlock x body radius) on any tick cannot slip past even when the roll
 * failed: trapped below bodyControlFrac of that speed, else blocked. Both emit INTERCEPT (a = interceptor, b =
 * passer). The passing team never intercepts its own pass (receptions are SIM-07's). [QF-13 skeptic] Header passes
 * count as passes here, and a body stops a pass up to shotBlockHeight (the roll stays below interceptMaxHeight).
 *
 * Determinism / cost: plain arithmetic, Math.sqrt and dmath, s.rng only, slot-order loops with strict tie breaks, module
 * scratch only. Per tick O(22) plus O(11) when a pass is in flight; a tackle resolution is O(1).
 */
// Re-export the registry-facing shells FIRST: see tackleHooks.ts (import-cycle safety with actions/registry).
export {
  fallenHandler, getUpHandler, hardTackleHandler, pushPullHandler, shoulderHandler, slideTackleHandler, solveClearance,
  standTackleHandler, stumbleHandler,
} from './tackleHooks';
import { bindTackleImpl } from './tackleHooks';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ } from '../../contracts/constants';
import { ActionKind, ChallengeKind, CrossKind, KickKind, MatchPhase, isFootPassKind, isShotKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import {
  MAX_CHALLENGES, MoveMode, createChallengeRecord, type ChallengeRecord, type PlayerState, type SimState,
} from '../../contracts/state';
import { createKickLaunch, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { T_BALL, T_DRIBBLE, T_PLAYER, T_TACKLE } from '../../contracts/tuning';
import { RESTART_PHASES } from '../../contracts/transitions';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import { clamp01, dcos, dsin, lerp } from '../core/dmath';
import { applyKick, ballTouchedThisTick, takePossession } from '../core/kick';
import { pressureOn } from '../core/query';
import { rngFloat, rngGauss } from '../core/rng';
import { createV2, rotateToward2 } from '../core/vec';
import { aerialChance, startAerialClearance } from '../kicks/aerial';
import { inSkillVulnerableWindow } from '../kicks/skills';
import { bodyRadiusOf, shieldBlocks } from '../players/bodies';

/** TUNING-CR (SIM-14): proposed additions to T_TACKLE (units in the comments). */
export const LOCAL_TUNING = { // TUNING-CR
  // ---- standing / hard tackle movement
  /** Lunge speed along the tackle direction in the contact window (his own speed if faster), m/s. */
  standLungeSpeed: 3.2,
  /** Hard tackle lunge speed multiplier. */
  hardLungeMul: 1.25,
  /** Max turn of the lunge direction toward the ball per tick until the contact, rad. */
  lungeTurnPerTick: 0.12,
  /** Wind-up: fraction of his speed along the lunge kept per tick (plants the standing foot). */
  windupSpeedKeep: 0.9,
  /** Aim at the ball (start, homing) when it is within this distance, m; else straight ahead / at the target. */
  aimRange: 8,
  /** Faster than this he aims a tackle with nothing to aim at along his run (else his facing), m/s. */
  movingSpeed: 0.5,
  // ---- foot zones
  /** Standing / hard tackle: ball within this half-angle of the lunge direction (beyond closeRadius), rad. */
  standConeHalf: 1.3,
  /** ... or within this distance of his centre in any direction, m. */
  closeRadius: 0.6,
  /** Max ball height for a standing / hard tackle, m. */
  ballHeight: 0.7,
  /** Max ball height for a slide, m. */
  slideBallHeight: 0.5,
  /** Standing / hard tackle: the victim's body counts as hit within this fraction of the reach (body edge), m/m ... */
  bodyReachFrac: 0.75,
  /** ... inside this frontal cos (dot of lunge direction and direction to him). */
  bodyConeCos: 0.2,
  /** Bodies closer than radii + this always count as a contact, m. */
  bodyMargin: 0.15,
  /** Body first: the carrier's body edge lies at least this much before the ball along the tackler's line, m ... */
  ballFirstMargin: 0.15,
  /** ... and his centre within his radius + this of that line, m. */
  blockLateral: 0.25,
  // ---- success model
  /** [QF-14] was 0.5: a front standing tackle at a close ball won about 30% (22% of all tackles), every lost one with the
   *  carrier's body in the zone a foul; 0.7: 28% of all tackles, fouls 13.5 -> 12.8 a match (docs/TUNING.md QF-14). */
  baseChance: 0.7,
  /** Weight of (tackle skill - resistance), both 0..1. */
  attrWeight: 0.55,
  /** Resistance = weights x (dribbling, ballControl, strength) (attr 1..99 -> 0..1). */
  resistDribbling: 0.6,
  resistControl: 0.25,
  resistStrength: 0.15,
  /** Weight of (exposure - 0.5). */
  exposureWeight: 0.3,
  /** Ball-to-carrier distance for exposure 0 and 1 between touches, m. */
  exposureNear: 0.35,
  exposureFar: 1.2,
  /** Exposure in the carrier's first-touch window and in a kick wind-up, 0..1. */
  firstTouchExposure: 0.8,
  kickWindupExposure: 0.6,
  /** Chance multiplier while the carrier is in a skill move outside its vulnerable window. */
  skillProtectMul: 0.15,
  /** Chance x (1 - this x (d / reach)^2). */
  edgeReachPenalty: 0.35,
  /** Angle multipliers: from the front (facing dot -1), the side (0), behind (+1); linear between. */
  frontMul: 1.0,
  sideMul: 0.9,
  behindMul: 0.45,
  /** Chance multiplier when the carrier shields the ball from him (SIM-05 shieldBlocks). */
  shieldMul: 0.25,
  hardBonus: 0.08,
  slideBonus: 0.05,
  minChance: 0.03,
  maxChance: 0.95,
  /** Standing / hard tackle on a loose ball in reach. */
  looseChance: 0.92,
  // ---- outcome of a won tackle
  /** Chance a standing tackle keeps the ball (standingTackle 1 .. 99). */
  keepChanceLo: 0.3,
  keepChanceHi: 0.75,
  hardKeepMul: 0.5,
  /** The ball cannot be kept faster than this relative to him, m/s. */
  keepMaxBallSpeed: 7,
  /** Kept / intercepted ball: settles this far ahead of him ... m */
  settleAhead: 0.5,
  /** ... over this time, s; along his run when faster than settleRunSpeed (m/s), else toward the ball. */
  settleTime: 0.25,
  settleRunSpeed: 1,
  /** Ball speed giving a KICK event power of 1 for pokes / deflections, m/s. */
  kickPowerRef: 20,
  /** Poke spread (half-angle around the lunge direction), rad. */
  standPokeSpread: 1.4,
  hardPokeSpread: 0.7,
  slidePokeSpread: 1.0,
  /** Poke speed ranges, m/s. */
  standPokeLo: 3.5,
  standPokeHi: 6.5,
  hardPokeLo: 6.0,
  hardPokeHi: 10.0,
  slidePokeLo: 6.0,
  slidePokeHi: 10.0,
  /** Share of the tackler's velocity added to a poke. */
  pokeCarry: 0.3,
  /** Beaten standing / hard tackler stumbles this long, ticks. */
  beatenStumbleTicks: 20,
  /** Victim of a shoulder / push / ball-first hard or slide body contact stumbles this long, ticks. */
  shortStumbleTicks: 16,
  // ---- slide
  slideMinSpeed: 5.0,
  slideMaxSpeed: 8.6,
  /** The slide speed decays linearly to 0 over this many ticks from the contact start. */
  slideGlideTicks: 26,
  /** Foot segment length from his centre and its half-width, m. */
  slideFootReach: 1.2,
  slideFootRadius: 0.5,
  /** Victim body hit when his centre is within his radius + this of the foot segment, m. */
  slideBodyMargin: 0.2,
  // ---- shoulder
  shoulderWindup: 3,
  shoulderContactTicks: 10,
  shoulderRecovery: 8,
  /** Duel: 0.5 + (strength diff) / span (+ sprintBonus when he sprints, - shieldPenalty vs a shielding carrier). */
  shoulderStrengthSpan: 80,
  shoulderSprintBonus: 0.05,
  shoulderShieldPenalty: 0.1,
  shoulderMinChance: 0.1,
  shoulderMaxChance: 0.9,
  /** Sideways bump given to the duel loser, m/s. */
  shoulderPush: 1.6,
  // ---- push / pull
  pushWindup: 2,
  pushContactTicks: 14,
  pushRecovery: 10,
  /** Carrier / puller velocity kept per tick while in contact. */
  pullKeep: 0.95,
  pullSelfKeep: 0.98,
  /** Balance duel: base + (strength diff) / span, clamped. */
  pushBalanceBase: 0.2,
  pushStrengthSpan: 150,
  pushMinChance: 0.05,
  pushMaxChance: 0.5,
  // ---- down states
  /** STUMBLE: max |DIRECT stick| / ARRIVE speed as a fraction of jog. */
  stumbleMoveScale: 0.35,
  /** Share of his speed kept when he starts to stumble. */
  stumbleSpeedKeep: 0.6,
  /** Quick get-up from FALLEN allowed after this many ticks on the ground. */
  fallQuickMinTicks: 20,
  // ---- ball stuck under a down player
  downBallSpeed: 1.5,
  downBallHeight: 0.3,
  downBodyHalf: 0.8,
  downBodyRadius: 0.45,
  squirtSpeed: 2.5,
  // ---- keeper priority
  keeperPriorityDist: 2.5,
  // ---- clearance
  clearWindup: 8,
  clearMinWindup: 3,
  clearRecovery: 14,
  /** Accept a ball arriving within this many ticks, on a path within clearLane of him (inside SIM-08's reach). */
  clearMaxLeadTicks: 40,
  clearLane: 1.1,
  /** In reach now: within this horizontal distance and height (SIM-08 reachRadius / reachHeight), m. */
  clearReachRadius: 1.2,
  clearReachHeight: 0.8,
  clearMinPower: 0.6,
  clearSpeedMin: 19,
  clearSpeedMax: 27,
  /** Launch elevation, rad (~34 deg). */
  clearAngle: 0.6,
  /** Opponent within this distance = under pressure (toward the touchline), m. */
  clearPressureDist: 4,
  /** Pressured target: |z| and distance upfield, m. */
  clearTouchlineZ: 31,
  clearUpfield: 28,
  /** Minimum forward component (cos to the attack direction); an aim error may not leave this x clearErrForwardFrac. */
  clearMinForward: 0.4,
  clearErrForwardFrac: 0.5,
  /** Pressured from the centre (|z| below this, m): the side he faces. */
  clearCentreBand: 0.5,
  /** Kicking quality weights (the rest: shotPower) and the speed share that does not depend on quality. */
  clearQualityLong: 0.5,
  clearQualityStrength: 0.3,
  clearPowerFloor: 0.6,
  /** Planned landing point: no-drag range x this. */
  clearRangeDragFrac: 0.75,
  /** Aim error sigma at best / worst quality, rad; speed error sigma, fraction. */
  clearErrBase: 0.05,
  clearErrMax: 0.2,
  clearSpeedErr: 0.06,
  clearSpeedErrCap: 0.2,
  // ---- interceptions
  interceptMaxHeight: 1.0,
  interceptMinSpeed: 6,
  interceptChanceMin: 0.25,
  interceptChanceMax: 0.9,
  /** Weight of interceptions in the blend (rest agility, standing in for reactions). */
  interceptAttrW: 0.65,
  interceptEasySpeed: 8,
  interceptHardSpeed: 26,
  interceptHardMul: 0.35,
  interceptEdgeMul: 0.45,
  interceptHighMul: 0.6,
  /** Full distance factor inside this fraction of the reach; full height factor up to this height, m. */
  interceptCoreFrac: 0.5,
  interceptLowHeight: 0.5,
  interceptBehindMul: 0.6,
  interceptMaxChance: 0.97,
  /** Max ball speed relative to him for a controlled interception (ballControl 1 .. 99), m/s. */
  interceptControlSpeedLo: 10,
  interceptControlSpeedHi: 16,
  /** Block: normal restitution and kept tangential share (relative to him). */
  blockRestitution: 0.3,
  blockTangentKeep: 0.5,
  /** A path within this fraction of his body radius cannot slip past him ... */
  interceptBodyBlock: 0.8,
  /** ... and he traps it (instead of a block) below this share of his controlled-interception speed. */
  bodyControlFrac: 0.6,
  /** [QF-9] A fresh shot is blocked by an outfield opponent's body up to this ball height (torso), m; his reach-entry
   *  roll (a stretched leg) only up to interceptMaxHeight. */
  shotBlockHeight: 1.8,
} as const;

const L = LOCAL_TUNING;
const T = T_TACKLE;
const NS = NUM_SLOTS;
const DTS = 1 / TICK_HZ;

// action flag bits (p.actA of a tackle)
const F_EMIT = 1;
const F_BODY = 2;
const F_WON = 4;
const F_QUICK = 8;

// ---------------------------------------------------------------- module scratch (never retained across calls)

const REC: ChallengeRecord = createChallengeRecord();
const LAUNCH: KickLaunch = createKickLaunch();
const V = createV2();
const CAND_SLOT = new Int32Array(PLAYERS_PER_TEAM);
const CAND_T = new Float64Array(PLAYERS_PER_TEAM);
const CAND_D = new Float64Array(PLAYERS_PER_TEAM);
const CAND_F = new Uint8Array(PLAYERS_PER_TEAM);
/** Scratch numbers handed between helpers: [0] distance, [1] param, [2] x, [3] z. */
const G = new Float64Array(4);
/** segDist inputs: segment a (0, 1) - b (2, 3), point (4, 5). */
const S = new Float64Array(6);

// ---------------------------------------------------------------- small helpers

function validSlot(i: number): boolean { return i >= 0 && i < NS && (i | 0) === i; }
function fin(v: number): number { return v === v && v < Infinity && v > -Infinity ? v : 0; }
function attr01(v: number): number { return clamp01((fin(v) - 1) / 98); }
function clampN(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

function isTackleKind(k: ActionKind): boolean { return k >= ActionKind.STAND_TACKLE && k <= ActionKind.PUSH_PULL; }
function isFootTackle(k: ActionKind): boolean { return k >= ActionKind.STAND_TACKLE && k <= ActionKind.SLIDE_TACKLE; }
function isDown(k: ActionKind): boolean { return k === ActionKind.STUMBLE || k === ActionKind.FALLEN || k === ActionKind.GET_UP; }

function windupOf(k: ActionKind): number {
  if (k === ActionKind.SLIDE_TACKLE) return T.slideWindup;
  if (k === ActionKind.SHOULDER) return L.shoulderWindup;
  if (k === ActionKind.PUSH_PULL) return L.pushWindup;
  return T.standWindup;
}
/** Contact window length of a tackle kind, ticks. */
export function contactTicksOf(k: ActionKind): number {
  if (k === ActionKind.SLIDE_TACKLE) return T.slideContactTicks;
  if (k === ActionKind.SHOULDER) return L.shoulderContactTicks;
  if (k === ActionKind.PUSH_PULL) return L.pushContactTicks;
  return T.standContactTicks;
}
function recoveryOf(k: ActionKind): number {
  if (k === ActionKind.SLIDE_TACKLE) return T.slideRecovery;
  if (k === ActionKind.SHOULDER) return L.shoulderRecovery;
  if (k === ActionKind.PUSH_PULL) return L.pushRecovery;
  if (k === ActionKind.HARD_TACKLE) return Math.round(T.standRecovery * T.hardRecoveryMul);
  return T.standRecovery;
}
function challengeKindOf(k: ActionKind): ChallengeKind {
  if (k === ActionKind.HARD_TACKLE) return ChallengeKind.HARD;
  if (k === ActionKind.SLIDE_TACKLE) return ChallengeKind.SLIDE;
  if (k === ActionKind.SHOULDER) return ChallengeKind.SHOULDER;
  if (k === ActionKind.PUSH_PULL) return ChallengeKind.PUSH_PULL;
  return ChallengeKind.STAND;
}
/** Standing / hard tackle reach from the body centre, m. */
export function standReachOf(k: ActionKind): number {
  return k === ActionKind.HARD_TACKLE ? T.standReach * T.hardReachMul : T.standReach;
}

/** Live ball for contacts: IN_PLAY, or a restart phase once the restart has been taken. */
function liveBall(s: SimState): boolean {
  const m = s.match;
  if (m.phase === MatchPhase.IN_PLAY) return true;
  for (let i = 0; i < RESTART_PHASES.length; i++) if (RESTART_PHASES[i] === m.phase) return m.restart.taken === 1;
  return false;
}

/** The ball can be played at all: not in hands, not in a net, not over a line this tick. */
function ballPlayable(s: SimState): boolean {
  const b = s.ball;
  return b.heldBy < 0 && b.inNet === 0 && b.cross === CrossKind.NONE;
}

/** Active opponent carrier of `team` (feet, not hands), or -1. */
function oppCarrier(s: SimState, team: number): number {
  const b = s.ball;
  if (b.heldBy >= 0 || !validSlot(b.owner)) return -1;
  const q = s.players[b.owner]!;
  return q.active === 1 && q.team !== team ? b.owner : -1;
}

/** His own keeper is busy claiming this loose ball close to it: an outfield player leaves it to him. */
function keeperClaims(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.isKeeper === 1) return false;
  const k = s.teams[p.team]!.keeperSlot;
  if (!validSlot(k) || k === slot) return false;
  const g = s.players[k]!;
  if (g.active !== 1) return false;
  const a = g.act;
  if (a !== ActionKind.GK_RUSH && a !== ActionKind.GK_CATCH && a !== ActionKind.GK_DIVE && a !== ActionKind.GK_PUNCH) return false;
  const b = s.ball;
  const dx = b.x - g.x, dz = b.z - g.z;
  return dx * dx + dz * dz <= L.keeperPriorityDist * L.keeperPriorityDist;
}

/**
 * Distance from point S[4..5] to segment S[0..1]-S[2..3] into G[0], the segment parameter into G[1], the closest point
 * into G[2..3]. Inputs and outputs cross through Float64Arrays: doubles passed to a call V8 does not inline are boxed.
 */
function segDist(): void {
  const ax = S[0]!, az = S[1]!, px = S[4]!, pz = S[5]!;
  const dx = S[2]! - ax, dz = S[3]! - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > 1e-12) {
    t = ((px - ax) * dx + (pz - az) * dz) / l2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const cx = ax + dx * t, cz = az + dz * t;
  const ex = px - cx, ez = pz - cz;
  G[0] = Math.sqrt(ex * ex + ez * ez);
  G[1] = t;
  G[2] = cx;
  G[3] = cz;
}

function topSpeedOf(s: SimState, slot: number): number {
  const v = s.attrs[slot]!.topSpeed;
  return v > 0 ? v : T_PLAYER.topSpeedMin;
}

/** Turn p.actDir toward the ball (or the target) by at most maxTurn. */
function homeDir(s: SimState, p: PlayerState, maxTurn: number): void {
  const b = s.ball;
  let tx = 0, tz = 0;
  const bx = b.x - p.x, bz = b.z - p.z;
  if (b.heldBy < 0 && bx * bx + bz * bz <= L.aimRange * L.aimRange) { tx = bx; tz = bz; } else if (validSlot(p.actSlot)) {
    const q = s.players[p.actSlot]!;
    tx = q.x - p.x; tz = q.z - p.z;
  }
  if (tx * tx + tz * tz < 1e-6) return;
  rotateToward2(V, p.actDirX, p.actDirZ, tx, tz, maxTurn);
  p.actDirX = V.x;
  p.actDirZ = V.z;
}

// ---------------------------------------------------------------- challenge records

/** Append a challenge for RUL-09 (drops if the queue is full). */
export function pushChallenge(s: SimState, rec: Readonly<ChallengeRecord>): void {
  if (!validSlot(rec.tackler) || !validSlot(rec.victim)) return;
  const q = s.match.challenges;
  const n = q.length < MAX_CHALLENGES ? q.length : MAX_CHALLENGES;
  for (let i = 0; i < n; i++) {
    const c = q[i]!;
    if (c.active === 1) continue;
    c.active = 1;
    c.tackler = rec.tackler;
    c.victim = rec.victim;
    c.kind = rec.kind >= ChallengeKind.STAND && rec.kind <= ChallengeKind.KEEPER ? rec.kind : ChallengeKind.STAND;
    c.ballFirst = rec.ballFirst === 1 ? 1 : 0;
    c.fromBehind = clampN(fin(rec.fromBehind), -1, 1);
    const cs = fin(rec.closingSpeed);
    c.closingSpeed = cs > 0 ? cs : 0;
    c.x = fin(rec.x);
    c.z = fin(rec.z);
    c.tick = fin(rec.tick);
    return;
  }
}

/** Build and queue the record of tackler t's body contact on victim v. */
function recordChallenge(s: SimState, t: number, v: number, kind: ChallengeKind, ballFirst: number): void {
  const p = s.players[t]!, q = s.players[v]!;
  let ux = q.x - p.x, uz = q.z - p.z;
  let l = Math.sqrt(ux * ux + uz * uz);
  if (l < 1e-6) { ux = p.actDirX; uz = p.actDirZ; l = Math.sqrt(ux * ux + uz * uz); }
  if (l < 1e-6) { ux = p.fx; uz = p.fz; l = Math.sqrt(ux * ux + uz * uz); }
  if (l < 1e-6) { ux = 1; uz = 0; l = 1; }
  ux /= l; uz /= l;
  REC.active = 1;
  REC.tackler = t;
  REC.victim = v;
  REC.kind = kind;
  REC.ballFirst = ballFirst;
  REC.fromBehind = ux * q.fx + uz * q.fz;
  const cl = (p.vx - q.vx) * ux + (p.vz - q.vz) * uz;
  REC.closingSpeed = cl > 0 ? cl : 0;
  REC.x = q.x;
  REC.z = q.z;
  REC.tick = s.tick;
  pushChallenge(s, REC);
}

// ---------------------------------------------------------------- down states

/** Down `slot` as STUMBLE or FALLEN for `ticks` (FALLEN is followed by GET_UP). Respects severity. */
function downFor(s: SimState, slot: number, kind: ActionKind, ticks: number): void {
  if (!validSlot(slot)) return;
  const p = s.players[slot]!;
  if (p.active !== 1) return;
  const cur = p.act;
  if (kind === ActionKind.STUMBLE) {
    if (cur === ActionKind.FALLEN || cur === ActionKind.GET_UP) return;
    if (cur === ActionKind.STUMBLE && p.actDur - p.actT >= ticks) return;
  } else if (cur === ActionKind.FALLEN) {
    return;
  }
  endAction(s, slot, 1);
  beginAction(p, kind, ticks, -1);
  if (kind === ActionKind.FALLEN) {
    p.moveMode = MoveMode.LOCKED;
    p.stunT = ticks + T.getUpTicks;
  } else {
    p.vx *= L.stumbleSpeedKeep;
    p.vz *= L.stumbleSpeedKeep;
    p.stunT = ticks;
  }
  p.wantSprint = 0;
}

/** Put a player into STUMBLE or FALLEN (interrupting any action). */
export function knockDown(s: SimState, slot: number, kind: ActionKind, ev: EventSink): void {
  if (kind === ActionKind.STUMBLE) downFor(s, slot, kind, T.stumbleTicks);
  else if (kind === ActionKind.FALLEN || kind === ActionKind.GET_UP) downFor(s, slot, ActionKind.FALLEN, T.fallTicks);
}

/**
 * Quick get-up (the human's second slide press): a slide's recovery after its contact window shrinks to
 * T_TACKLE.slideGetUpQuick; a FALLEN player (at least fallQuickMinTicks down) starts getting up now. Once per action.
 * Returns 1 if applied.
 */
export function quickGetUp(s: SimState, slot: number): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || (p.actA & F_QUICK) !== 0) return 0;
  if (p.act === ActionKind.SLIDE_TACKLE) {
    const d = p.actContact + T.slideContactTicks + T.slideGetUpQuick;
    if (d >= p.actDur) return 0;
    p.actDur = d > p.actT + 1 ? d : p.actT + 1;
    p.actA |= F_QUICK;
    return 1;
  }
  if (p.act === ActionKind.FALLEN) {
    if (p.actT < L.fallQuickMinTicks || p.actT + 1 >= p.actDur) return 0;
    p.actDur = p.actT + 1;
    p.actA |= F_QUICK;
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------- starters

/** Start STAND_TACKLE, HARD_TACKLE, SLIDE_TACKLE, SHOULDER or PUSH_PULL against targetSlot (-1 = ball carrier). */
export function startTackle(s: SimState, slot: number, kind: ActionKind, targetSlot: number, ev: EventSink): number {
  if (!validSlot(slot) || !isTackleKind(kind)) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !liveBall(s)) return 0;
  const b = s.ball;
  if (b.heldBy >= 0) return 0;
  let v: number;
  if (validSlot(targetSlot) && targetSlot !== slot) {
    const q = s.players[targetSlot]!;
    if (q.active !== 1 || q.team === p.team) return 0;
    v = targetSlot;
  } else {
    if (validSlot(b.owner) && s.players[b.owner]!.team === p.team) return 0;
    v = oppCarrier(s, p.team);
  }
  if ((kind === ActionKind.SHOULDER || kind === ActionKind.PUSH_PULL) && v < 0) return 0;
  const w = windupOf(kind);
  beginAction(p, kind, w + contactTicksOf(kind) + recoveryOf(kind), w);
  p.actKick = KickKind.NONE;
  p.actPower = 0;
  p.actSlot = v;
  p.actA = 0;
  p.actB = 0;
  p.actCurve = 0;
  p.actX = p.x;
  p.actZ = p.z;
  // Direction: at the ball (predicted at mid-contact) when near, else at the target, else ahead.
  let dx = 0, dz = 0;
  const lead = (w + (contactTicksOf(kind) >> 1)) * DTS;
  const bx = b.x + b.vx * lead - p.x, bz = b.z + b.vz * lead - p.z;
  if (isFootTackle(kind) && bx * bx + bz * bz <= L.aimRange * L.aimRange) { dx = bx; dz = bz; } else if (v >= 0) {
    const q = s.players[v]!;
    dx = q.x - p.x; dz = q.z - p.z;
  }
  let dl = Math.sqrt(dx * dx + dz * dz);
  if (dl < 1e-6) {
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (sp > L.movingSpeed) { dx = p.vx; dz = p.vz; } else { dx = p.fx; dz = p.fz; }
    dl = Math.sqrt(dx * dx + dz * dz);
    if (dl < 1e-6) { dx = 1; dz = 0; dl = 1; }
  }
  p.actDirX = dx / dl;
  p.actDirZ = dz / dl;
  const along = p.vx * p.actDirX + p.vz * p.actDirZ;
  if (kind === ActionKind.SLIDE_TACKLE) p.actB = clampN(along, L.slideMinSpeed, L.slideMaxSpeed);
  else if (kind === ActionKind.HARD_TACKLE) p.actB = L.standLungeSpeed * L.hardLungeMul;
  else p.actB = L.standLungeSpeed;
  return 1;
}

/** Ticks until a loose low ball comes within `lane` of the (moving) player, or -1 beyond maxTicks / not coming. */
function arrivalTicks(s: SimState, slot: number, maxTicks: number, lane: number): number {
  const b = s.ball;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  if (dx * dx + dz * dz <= lane * lane) return 0;
  const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
  const rv2 = rvx * rvx + rvz * rvz;
  if (!(rv2 > 1e-9)) return -1;
  const t = -(dx * rvx + dz * rvz) / rv2;
  if (!(t > 0)) return -1;
  const mx = dx + rvx * t, mz = dz + rvz * t;
  const miss2 = mx * mx + mz * mz;
  if (!(miss2 <= lane * lane)) return -1;
  const tin = t - Math.sqrt((lane * lane - miss2) / rv2);
  const ticks = Math.ceil(tin * TICK_HZ);
  return ticks <= maxTicks ? (ticks > 0 ? ticks : 0) : -1;
}

/** Ticks until a ball in reach leaves the reach circle (relative motion), large when it stays. */
function exitTicks(s: SimState, slot: number, r: number): number {
  const b = s.ball;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
  const a = rvx * rvx + rvz * rvz;
  if (!(a > 1e-9)) return 1000;
  const bq = dx * rvx + dz * rvz;
  const c = dx * dx + dz * dz - r * r;
  const disc = bq * bq - a * c;
  if (!(disc >= 0)) return 0;
  const t = (-bq + Math.sqrt(disc)) / a;
  return t > 0 ? Math.floor(t * TICK_HZ) : 0;
}

/** Start a clearance (KickKind.CLEARANCE) — first-time when the ball arrives. */
export function startClearance(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot) || kind !== KickKind.CLEARANCE) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !liveBall(s)) return 0;
  const b = s.ball;
  if (b.heldBy >= 0 || b.inNet !== 0) return 0;
  if (b.owner >= 0 && b.owner !== slot) return 0;
  let contact: number;
  if (b.owner === slot) {
    contact = L.clearWindup;
  } else {
    const dx = b.x - p.x, dz = b.z - p.z;
    const low = b.y <= L.clearReachHeight;
    if (low && dx * dx + dz * dz <= L.clearReachRadius * L.clearReachRadius) {
      const ex = exitTicks(s, slot, L.clearReachRadius) - 1;
      contact = clampN(ex, L.clearMinWindup, L.clearWindup);
    } else {
      const eta = low ? arrivalTicks(s, slot, L.clearMaxLeadTicks, L.clearLane) : -1;
      if (eta < 0) return aerialChance(s, slot) > 0 ? startAerialClearance(s, slot, req, ev) : 0;
      contact = eta > L.clearMinWindup ? eta : L.clearMinWindup;
    }
  }
  beginAction(p, ActionKind.KICK, contact + L.clearRecovery, contact);
  p.actKick = KickKind.CLEARANCE;
  const pw = clamp01(fin(req.power));
  p.actPower = pw > L.clearMinPower ? pw : L.clearMinPower;
  p.actCharging = 0;
  let dx = fin(req.dirX), dz = fin(req.dirZ);
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }
  p.actDirX = dx;
  p.actDirZ = dz;
  p.actSlot = -1;
  p.actX = 0;
  p.actZ = 0;
  p.actCurve = 0;
  p.actA = fin(req.flags) & 0xff;
  p.actB = 0;
  return 1;
}

/** Nearest active opponent distance of slot, m (large when none). */
function nearestOppDist(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const first = p.team === 0 ? PLAYERS_PER_TEAM : 0;
  let best = 1e9;
  for (let j = first; j < first + PLAYERS_PER_TEAM; j++) {
    const q = s.players[j]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** KickSolver for CLEARANCE: long and high away from goal, toward the touchline under pressure. */
function solveClear(s: SimState, slot: number, out: KickLaunch): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir >= 0 ? 1 : -1;
  const near = nearestOppDist(s, slot);
  const pressured = near <= L.clearPressureDist;
  let ax = dir, az = 0;
  const rx = p.actDirX, rz = p.actDirZ;
  const hasReq = rx * rx + rz * rz > 0.25;
  if (hasReq && rx * dir >= L.clearMinForward) { ax = rx; az = rz; } else if (pressured) {
    let side = p.z > L.clearCentreBand ? 1 : p.z < -L.clearCentreBand ? -1 : (p.fz < 0 ? -1 : 1);
    if (hasReq && rz * side < 0 && rz !== 0) side = -side;
    ax = dir * L.clearUpfield;
    az = side * L.clearTouchlineZ - p.z;
  } else if (p.fx * dir >= L.clearMinForward) {
    ax = dir + p.fx; az = p.fz;
  }
  let al = Math.sqrt(ax * ax + az * az);
  if (al < 1e-9) { ax = dir; az = 0; al = 1; }
  ax /= al; az /= al;
  if (ax * dir < L.clearMinForward) {
    const sz = az < 0 ? -1 : 1;
    ax = dir * L.clearMinForward;
    az = sz * Math.sqrt(1 - L.clearMinForward * L.clearMinForward);
  }
  const a = s.attrs[slot]!;
  const q = clamp01(L.clearQualityLong * attr01(a.longPassing) + L.clearQualityStrength * attr01(a.strength) +
    (1 - L.clearQualityLong - L.clearQualityStrength) * attr01(a.shotPower));
  const power = clampN(fin(p.actPower), L.clearMinPower, 1);
  let speed = lerp(L.clearSpeedMin, L.clearSpeedMax, power * (L.clearPowerFloor + (1 - L.clearPowerFloor) * q));
  const pressure = pressureOn(s, slot);
  const sigma = lerp(L.clearErrMax, L.clearErrBase, q) * (1 + pressure);
  const ang = rngGauss(s.rng) * sigma;
  const se = rngGauss(s.rng) * L.clearSpeedErr;
  const c = dcos(ang), sn = dsin(ang);
  let ux = ax * c - az * sn, uz = ax * sn + az * c;
  if (ux * dir < L.clearMinForward * L.clearErrForwardFrac) { ux = ax; uz = az; } // an error never turns it back
  speed *= clampN(1 + se, 1 - L.clearSpeedErrCap, 1 + L.clearSpeedErrCap);
  const h = speed * dcos(L.clearAngle);
  const vy = speed * dsin(L.clearAngle);
  out.vx = ux * h;
  out.vz = uz * h;
  out.vy = vy;
  out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = KickKind.CLEARANCE;
  out.target = -1;
  const range = h * (2 * vy / T_BALL.gravity) * L.clearRangeDragFrac;
  out.tx = clampN(p.x + ux * range, -HALF_LENGTH, HALF_LENGTH);
  out.tz = clampN(p.z + uz * range, -HALF_WIDTH, HALF_WIDTH);
  out.onTarget = 0;
  return 1;
}

// ---------------------------------------------------------------- tackle contact model

/** Is the ball in the foot zone of tackler p (kind k)? Distance (stand) / segment distance (slide) into G[0]. */
function ballInZone(s: SimState, p: PlayerState, k: ActionKind): boolean {
  const b = s.ball;
  const dx = b.x - p.x, dz = b.z - p.z;
  if (k === ActionKind.SLIDE_TACKLE) {
    if (!(b.y <= L.slideBallHeight)) return false;
    S[0] = p.x; S[1] = p.z; S[2] = p.x + p.actDirX * L.slideFootReach; S[3] = p.z + p.actDirZ * L.slideFootReach;
    S[4] = b.x; S[5] = b.z;
    segDist();
    const d = G[0]!;
    G[0] = Math.sqrt(dx * dx + dz * dz);
    return d <= L.slideFootRadius;
  }
  if (!(b.y <= L.ballHeight)) return false;
  const d = Math.sqrt(dx * dx + dz * dz);
  G[0] = d;
  const reach = standReachOf(k);
  if (d > reach) return false;
  if (d <= L.closeRadius) return true;
  const cos = (dx * p.actDirX + dz * p.actDirZ) / d;
  return cos >= dcos(L.standConeHalf);
}

/** Is victim v's body in the contact zone of tackler p (kind k)? */
function bodyInZone(s: SimState, p: PlayerState, k: ActionKind, v: number): boolean {
  const q = s.players[v]!;
  const rv = bodyRadiusOf(s, v);
  const dx = q.x - p.x, dz = q.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= bodyRadiusOf(s, p.slot) + rv + L.bodyMargin) return true;
  if (k === ActionKind.SLIDE_TACKLE) {
    S[0] = p.x; S[1] = p.z; S[2] = p.x + p.actDirX * L.slideFootReach; S[3] = p.z + p.actDirZ * L.slideFootReach;
    S[4] = q.x; S[5] = q.z;
    segDist();
    return G[0]! <= rv + L.slideBodyMargin;
  }
  if (d - rv > standReachOf(k) * L.bodyReachFrac) return false;
  return d > 1e-6 && (dx * p.actDirX + dz * p.actDirZ) / d >= L.bodyConeCos;
}

/** The carrier's body lies between tackler p and the ball (he would hit the man first). */
function bodyBlocksBall(s: SimState, p: PlayerState, v: number): boolean {
  const b = s.ball, q = s.players[v]!;
  let ux = b.x - p.x, uz = b.z - p.z;
  const lb = Math.sqrt(ux * ux + uz * uz);
  if (lb < 1e-6) return false;
  ux /= lb; uz /= lb;
  const vx = q.x - p.x, vz = q.z - p.z;
  const along = vx * ux + vz * uz;
  const rv = bodyRadiusOf(s, v);
  if (!(along > 0) || along - rv > lb - L.ballFirstMargin) return false;
  const lat = vx * uz - vz * ux;
  return (lat < 0 ? -lat : lat) <= rv + L.blockLateral;
}

/** How exposed the carrier's ball is (timing), 0..1; -1 = protected by a skill move outside its window. */
function exposureOf(s: SimState, v: number): number {
  const q = s.players[v]!;
  if (q.act === ActionKind.SKILL || q.act === ActionKind.FAKE) return inSkillVulnerableWindow(s, v) ? 1 : -1;
  if (q.act === ActionKind.FIRST_TOUCH) return L.firstTouchExposure;
  if ((q.act === ActionKind.KICK || q.act === ActionKind.SHOT) && q.actDone === 0) return L.kickWindupExposure;
  const b = s.ball;
  const dx = b.x - q.x, dz = b.z - q.z;
  const e = Math.sqrt(dx * dx + dz * dz);
  return clamp01((e - L.exposureNear) / (L.exposureFar - L.exposureNear));
}

/** Chance that tackler t (kind k, ball at distance d) wins the ball from carrier v (-1 = loose ball). Pure. */
export function winChance(s: SimState, t: number, k: ActionKind, v: number, d: number): number {
  if (!validSlot(t)) return 0;
  if (!validSlot(v)) return k === ActionKind.SLIDE_TACKLE ? 1 : L.looseChance;
  const at = s.attrs[t]!, av = s.attrs[v]!;
  const skill = attr01(k === ActionKind.SLIDE_TACKLE ? at.slidingTackle : at.standingTackle);
  const resist = L.resistDribbling * attr01(av.dribbling) + L.resistControl * attr01(av.ballControl) +
    L.resistStrength * attr01(av.strength);
  const ex = exposureOf(s, v);
  let c = L.baseChance + L.attrWeight * (skill - resist) + L.exposureWeight * ((ex < 0 ? 0 : ex) - 0.5);
  if (k === ActionKind.HARD_TACKLE) c += L.hardBonus;
  else if (k === ActionKind.SLIDE_TACKLE) c += L.slideBonus;
  const reach = k === ActionKind.SLIDE_TACKLE ? T.slideReach : standReachOf(k);
  const f = clamp01(fin(d) / reach);
  c *= 1 - L.edgeReachPenalty * f * f;
  const p = s.players[t]!, q = s.players[v]!;
  let ux = q.x - p.x, uz = q.z - p.z;
  const l = Math.sqrt(ux * ux + uz * uz);
  if (l > 1e-6) { ux /= l; uz /= l; } else { ux = p.actDirX; uz = p.actDirZ; }
  const fb = clampN(ux * q.fx + uz * q.fz, -1, 1);
  c *= fb >= 0 ? lerp(L.sideMul, L.behindMul, fb) : lerp(L.sideMul, L.frontMul, -fb);
  if (shieldBlocks(s, v, t)) c *= L.shieldMul;
  if (ex < 0) c *= L.skillProtectMul;
  return clampN(c, L.minChance, L.maxChance);
}

/** Settle the ball (just taken by slot) onto a spot settleAhead in front of him over settleTime. */
function cushion(s: SimState, slot: number, dirX: number, dirZ: number): void {
  const b = s.ball, p = s.players[slot]!;
  let fx = dirX, fz = dirZ;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (sp > L.settleRunSpeed) { fx = p.vx / sp; fz = p.vz / sp; }
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-6) { fx = p.fx; fz = p.fz; } else { fx /= fl; fz /= fl; }
  const tx = p.x + fx * L.settleAhead, tz = p.z + fz * L.settleAhead;
  let rx = (tx - b.x) / L.settleTime, rz = (tz - b.z) / L.settleTime;
  const rl = Math.sqrt(rx * rx + rz * rz);
  if (rl > L.keepMaxBallSpeed) { rx *= L.keepMaxBallSpeed / rl; rz *= L.keepMaxBallSpeed / rl; }
  b.vx = p.vx + rx;
  b.vz = p.vz + rz;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
}

/** Launch the ball from slot with a contact kick of kind (poke / deflection / squirt) via applyKick. */
function contactKick(s: SimState, slot: number, vx: number, vy: number, vz: number, kind: KickKind, ev: EventSink): void {
  const l = LAUNCH;
  l.vx = fin(vx); l.vy = fin(vy); l.vz = fin(vz);
  l.sx = 0; l.sy = 0; l.sz = 0;
  l.kind = kind;
  l.target = -1;
  l.tx = s.ball.x; l.tz = s.ball.z;
  l.onTarget = 0;
  applyKick(s, slot, l, clamp01(Math.sqrt(vx * vx + vz * vz) / L.kickPowerRef), ev);
}

/** Tackler i wins the ball (from carrier v, -1 = loose). Three s.rng draws, always. */
function winBall(s: SimState, i: number, k: ActionKind, v: number, body: boolean, ev: EventSink): void {
  const p = s.players[i]!, b = s.ball;
  const u1 = rngFloat(s.rng), u2 = rngFloat(s.rng), u3 = rngFloat(s.rng);
  if (v >= 0) {
    const q = s.players[v]!;
    if (q.noTouchT < T_DRIBBLE.dispossessedNoTouch) q.noTouchT = T_DRIBBLE.dispossessedNoTouch;
  }
  p.actA |= F_WON | F_EMIT;
  p.actDone = 1;
  if (v >= 0) p.actSlot = v;
  ev.emit(EventType.TACKLE, i, v, 1, challengeKindOf(k), b.x, b.y, b.z);
  if (body && v >= 0) victimContact(s, i, k, v, 1);
  let keep = 0;
  if (k === ActionKind.STAND_TACKLE || k === ActionKind.HARD_TACKLE) {
    keep = lerp(L.keepChanceLo, L.keepChanceHi, attr01(s.attrs[i]!.standingTackle));
    if (k === ActionKind.HARD_TACKLE) keep *= L.hardKeepMul;
  }
  const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
  if (u1 < keep && rvx * rvx + rvz * rvz <= L.keepMaxBallSpeed * L.keepMaxBallSpeed && b.y <= T_DRIBBLE.controlHeight) {
    takePossession(s, i, ev);
    cushion(s, i, p.actDirX, p.actDirZ);
    endAction(s, i, 0); // he comes away with the ball: free to dribble (SIM-06 runs later this tick)
    return;
  }
  const spread = k === ActionKind.SLIDE_TACKLE ? L.slidePokeSpread : k === ActionKind.HARD_TACKLE ? L.hardPokeSpread : L.standPokeSpread;
  const lo = k === ActionKind.SLIDE_TACKLE ? L.slidePokeLo : k === ActionKind.HARD_TACKLE ? L.hardPokeLo : L.standPokeLo;
  const hi = k === ActionKind.SLIDE_TACKLE ? L.slidePokeHi : k === ActionKind.HARD_TACKLE ? L.hardPokeHi : L.standPokeHi;
  const ang = (u2 * 2 - 1) * spread;
  const c = dcos(ang), sn = dsin(ang);
  const dx = p.actDirX * c - p.actDirZ * sn, dz = p.actDirX * sn + p.actDirZ * c;
  const sp = lerp(lo, hi, u3);
  contactKick(s, i, dx * sp + p.vx * L.pokeCarry, 0, dz * sp + p.vz * L.pokeCarry, KickKind.TACKLE_POKE, ev);
}

/** Record tackler i's body contact on victim v once (+ the victim's stumble after a ball-first hard / slide). */
function victimContact(s: SimState, i: number, k: ActionKind, v: number, ballFirst: number): void {
  const p = s.players[i]!;
  if ((p.actA & F_BODY) !== 0) return;
  p.actA |= F_BODY;
  p.actSlot = v;
  recordChallenge(s, i, v, challengeKindOf(k), ballFirst);
  if (ballFirst === 1 && (k === ActionKind.SLIDE_TACKLE || k === ActionKind.HARD_TACKLE)) {
    downFor(s, v, ActionKind.STUMBLE, L.shortStumbleTicks);
  }
}

/** Foot tackle (stand / hard / slide) contact for tackler i this tick (inside the window). */
function footContact(s: SimState, i: number, ev: EventSink): void {
  const p = s.players[i]!;
  const k = p.act;
  const b = s.ball;
  if (p.actDone === 1) {
    // Resolved: a body contact later in the window still counts (once).
    const v = p.actSlot;
    if ((p.actA & F_BODY) === 0 && validSlot(v) && s.players[v]!.active === 1 && s.players[v]!.team !== p.team &&
        bodyInZone(s, p, k, v)) {
      victimContact(s, i, k, v, (p.actA & F_WON) !== 0 ? 1 : 0);
    }
    return;
  }
  const carrier = oppCarrier(s, p.team);
  let v = carrier;
  if (v < 0 && validSlot(p.actSlot) && s.players[p.actSlot]!.active === 1 && s.players[p.actSlot]!.team !== p.team) v = p.actSlot;
  const ownBall = validSlot(b.owner) && s.players[b.owner]!.team === p.team;
  const ballOk = ballPlayable(s) && !ownBall && !ballTouchedThisTick(s) && (carrier >= 0 || !keeperClaims(s, i));
  const body = v >= 0 && bodyInZone(s, p, k, v);
  if (ballOk && ballInZone(s, p, k)) {
    const d = G[0]!;
    if (!(body && carrier >= 0 && bodyBlocksBall(s, p, carrier))) {
      const chance = winChance(s, i, k, carrier, d);
      const roll = rngFloat(s.rng);
      if (roll < chance) { winBall(s, i, k, carrier, body && v === carrier, ev); return; }
      p.actDone = 1;
      p.actA |= F_EMIT;
      if (carrier >= 0) p.actSlot = carrier;
      ev.emit(EventType.TACKLE, i, carrier, 0, challengeKindOf(k), b.x, b.y, b.z);
      if (body) { victimContact(s, i, k, v, 0); return; }
      if (k !== ActionKind.SLIDE_TACKLE && carrier >= 0) downFor(s, i, ActionKind.STUMBLE, L.beatenStumbleTicks);
      return;
    }
  }
  if (body) {
    p.actDone = 1;
    p.actA |= F_EMIT;
    ev.emit(EventType.TACKLE, i, v, 0, challengeKindOf(k), s.players[v]!.x, 0, s.players[v]!.z);
    victimContact(s, i, k, v, 0);
  }
}

/** Shoulder challenge contact for i this tick (inside the window, unresolved). */
function shoulderContact(s: SimState, i: number, ev: EventSink): void {
  const p = s.players[i]!;
  if (p.actDone === 1) return;
  let v = p.actSlot;
  if (!validSlot(v) || s.players[v]!.active !== 1 || s.players[v]!.team === p.team) v = oppCarrier(s, p.team);
  if (v < 0) return;
  const q = s.players[v]!;
  let nx = q.x - p.x, nz = q.z - p.z;
  const d = Math.sqrt(nx * nx + nz * nz);
  if (d > T.shoulderReach) return;
  if (d > 1e-6) { nx /= d; nz /= d; } else { nx = -p.fz; nz = p.fx; }
  let c = 0.5 + (fin(s.attrs[i]!.strength) - fin(s.attrs[v]!.strength)) / L.shoulderStrengthSpan;
  if (p.sprinting === 1) c += L.shoulderSprintBonus;
  if (q.shielding === 1 || q.act === ActionKind.SHIELD) c -= L.shoulderShieldPenalty;
  c = clampN(c, L.shoulderMinChance, L.shoulderMaxChance);
  const won = rngFloat(s.rng) < c;
  p.actDone = 1;
  p.actSlot = v;
  p.actA |= F_EMIT | F_BODY | (won ? F_WON : 0);
  recordChallenge(s, i, v, ChallengeKind.SHOULDER, 0);
  ev.emit(EventType.BODY_CONTACT, i, 1);
  const hadBall = s.ball.owner === v && s.ball.heldBy < 0;
  ev.emit(EventType.TACKLE, i, v, won ? 1 : 0, ChallengeKind.SHOULDER, q.x, 0, q.z);
  if (won) {
    q.vx += nx * L.shoulderPush;
    q.vz += nz * L.shoulderPush;
    if (hadBall) {
      if (q.noTouchT < T_DRIBBLE.dispossessedNoTouch) q.noTouchT = T_DRIBBLE.dispossessedNoTouch;
      downFor(s, v, ActionKind.STUMBLE, L.shortStumbleTicks);
      endAction(s, i, 0); // free to take the ball (SIM-06 runs later this tick)
    }
  } else {
    p.vx -= nx * L.shoulderPush;
    p.vz -= nz * L.shoulderPush;
  }
}

/** Push / pull contact for i this tick (inside the window). */
function pushContact(s: SimState, i: number, ev: EventSink): void {
  const p = s.players[i]!;
  let v = p.actSlot;
  if (!validSlot(v) || s.players[v]!.active !== 1 || s.players[v]!.team === p.team) v = oppCarrier(s, p.team);
  if (v < 0) return;
  const q = s.players[v]!;
  const dx = q.x - p.x, dz = q.z - p.z;
  if (dx * dx + dz * dz > T.pushPullReach * T.pushPullReach) return;
  if (isDown(q.act)) return;
  q.vx *= L.pullKeep; q.vz *= L.pullKeep;
  p.vx *= L.pullSelfKeep; p.vz *= L.pullSelfKeep;
  if (p.actDone === 1) return;
  p.actDone = 1;
  p.actSlot = v;
  const c = clampN(L.pushBalanceBase + (fin(s.attrs[i]!.strength) - fin(s.attrs[v]!.strength)) / L.pushStrengthSpan,
    L.pushMinChance, L.pushMaxChance);
  const won = rngFloat(s.rng) < c;
  p.actA |= F_EMIT | F_BODY | (won ? F_WON : 0);
  recordChallenge(s, i, v, ChallengeKind.PUSH_PULL, 0);
  ev.emit(EventType.BODY_CONTACT, i, 1);
  const hadBall = s.ball.owner === v && s.ball.heldBy < 0;
  ev.emit(EventType.TACKLE, i, v, won && hadBall ? 1 : 0, ChallengeKind.PUSH_PULL, q.x, 0, q.z);
  if (won && hadBall) {
    if (q.noTouchT < T_DRIBBLE.dispossessedNoTouch) q.noTouchT = T_DRIBBLE.dispossessedNoTouch;
    downFor(s, v, ActionKind.STUMBLE, L.shortStumbleTicks);
  }
}

/** A loose slow ball lying inside a down player's body squirts out sideways. */
function unstickBall(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (b.owner >= 0 || !ballPlayable(s) || ballTouchedThisTick(s) || !liveBall(s)) return;
  if (!(b.y <= L.downBallHeight) || b.vx * b.vx + b.vz * b.vz > L.downBallSpeed * L.downBallSpeed) return;
  for (let i = 0; i < NS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const a = p.act;
    const lying = a === ActionKind.FALLEN || a === ActionKind.GET_UP || (a === ActionKind.SLIDE_TACKLE && p.actT >= p.actContact);
    if (!lying) continue;
    let fx = a === ActionKind.SLIDE_TACKLE ? p.actDirX : p.fx, fz = a === ActionKind.SLIDE_TACKLE ? p.actDirZ : p.fz;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl < 1e-6) { fx = 1; fz = 0; } else { fx /= fl; fz /= fl; }
    const h = L.downBodyHalf;
    S[0] = p.x - fx * h; S[1] = p.z - fz * h; S[2] = p.x + fx * h; S[3] = p.z + fz * h; S[4] = b.x; S[5] = b.z;
    segDist();
    if (G[0]! > L.downBodyRadius) continue;
    let nx = b.x - G[2]!, nz = b.z - G[3]!;
    const nl = Math.sqrt(nx * nx + nz * nz);
    if (nl < 1e-3) { nx = -fz; nz = fx; } else { nx /= nl; nz /= nl; }
    contactKick(s, i, nx * L.squirtSpeed, 0, nz * L.squirtSpeed, KickKind.DEFLECTION, ev);
    return;
  }
}

/** Contact phase: tackles in their contact window touching ball / opponent. */
export function tackleContacts(s: SimState, ev: EventSink): void {
  const live = liveBall(s);
  for (let i = 0; i < NS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const k = p.act;
    if (!isTackleKind(k)) {
      if (p.stunT > 0 && !isDown(k)) p.stunT--; // never a stuck stun outside the down states
      continue;
    }
    const start = p.actContact;
    const end = start + contactTicksOf(k);
    if (p.actT < start) continue;
    if (p.actT >= end) {
      if ((p.actA & F_EMIT) === 0) {
        p.actA |= F_EMIT;
        p.actDone = 1;
        ev.emit(EventType.TACKLE, i, validSlot(p.actSlot) ? p.actSlot : -1, 0, challengeKindOf(k), p.x, 0, p.z);
      }
      continue;
    }
    if (!live) continue;
    if (k === ActionKind.SHOULDER) shoulderContact(s, i, ev);
    else if (k === ActionKind.PUSH_PULL) pushContact(s, i, ev);
    else footContact(s, i, ev);
  }
  unstickBall(s, ev);
}

// ---------------------------------------------------------------- interceptions

/** Untouched pass (SIM-07 definition): a pass kind that nobody has touched since the kick. */
function untouchedPass(s: SimState): boolean {
  const b = s.ball;
  // [QF-13 skeptic] A header pass too (isFootPassKind leaves it out): a flick-on dropping at 7-14 m/s passed straight
  // through opponents' legs, 2.6 times a match (Professional), with no interception roll and no body contact.
  return (isFootPassKind(b.lastKickKind) || b.lastKickKind === KickKind.HEADER_PASS) && b.lastTouch === b.lastKickBy &&
    b.lastTouchTick === b.lastKickTick && validSlot(b.lastKickBy);
}

/** Chance that j intercepts the pass whose path passes d from him at speed sp, height y. Pure. */
export function interceptChance(s: SimState, j: number, d: number, sp: number, y: number): number {
  if (!validSlot(j)) return 0;
  const a = s.attrs[j]!, q = s.players[j]!, b = s.ball;
  const skill = L.interceptAttrW * attr01(a.interceptions) + (1 - L.interceptAttrW) * attr01(a.agility);
  let c = lerp(L.interceptChanceMin, L.interceptChanceMax, skill);
  c *= sp <= L.interceptEasySpeed ? 1 : lerp(1, L.interceptHardMul, clamp01((sp - L.interceptEasySpeed) / (L.interceptHardSpeed - L.interceptEasySpeed)));
  const reach = T.interceptReach;
  const core = L.interceptCoreFrac * reach;
  c *= d <= core ? 1 : lerp(1, L.interceptEdgeMul, clamp01((d - core) / (reach - core)));
  const low = L.interceptLowHeight;
  c *= y <= low ? 1 : lerp(1, L.interceptHighMul, clamp01((y - low) / (L.interceptMaxHeight - low)));
  const bl = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  if (bl > 1e-6) {
    const comes = -(b.vx * q.fx + b.vz * q.fz) / bl; // 1 = ball coming at his face, -1 = from behind
    c *= comes >= 0 ? 1 : lerp(1, L.interceptBehindMul, -comes);
  }
  return clampN(c, 0, L.interceptMaxChance);
}

/** Ball off j's body / feet (blocked): DEFLECTION, loose. */
function blockBall(s: SimState, j: number, ev: EventSink): void {
  const b = s.ball, q = s.players[j]!;
  const rvx = b.vx - q.vx, rvz = b.vz - q.vz;
  const rel = Math.sqrt(rvx * rvx + rvz * rvz);
  let nx = b.x - q.x, nz = b.z - q.z;
  let nl = Math.sqrt(nx * nx + nz * nz);
  if (nl < 1e-6 || rvx * nx + rvz * nz >= 0) { nx = -rvx; nz = -rvz; nl = rel; } // head on
  if (nl < 1e-9) { nx = q.fx; nz = q.fz; nl = 1; }
  nx /= nl; nz /= nl;
  const vn = rvx * nx + rvz * nz;
  const tx = rvx - vn * nx, tz = rvz - vn * nz;
  const ox = tx * L.blockTangentKeep - vn * L.blockRestitution * nx;
  const oz = tz * L.blockTangentKeep - vn * L.blockRestitution * nz;
  contactKick(s, j, q.vx + ox, b.vy > 0 ? 0 : b.vy, q.vz + oz, KickKind.DEFLECTION, ev);
}

/**
 * [QF-9] A shot nobody has touched since it was struck (shotBy is cleared by any other touch). Its outfield opponents
 * block it here (body in the path on any tick; a reach entry rolls interceptChance), never by a SIM-07 first touch.
 */
export function isFreshShot(s: SimState): boolean {
  const b = s.ball;
  return validSlot(b.shotBy) && b.shotBy === b.lastKickBy && isShotKind(b.lastKickKind) && b.lastTouch === b.lastKickBy &&
    b.lastTouchTick === b.lastKickTick;
}

/**
 * [QF-9 skeptic] A busy outfield opponent whose body still stops a fresh shot: anyone upright in an action (a tackle in
 * its wind-up, glide or recovery, a stumble, getting up, a header / kick / volley wind-up, a first touch, a shield) or
 * stunned. Not a man lying FALLEN (his body is no upright circle), a wall member (RUL-05 WALL_JUMP blocks free kicks
 * itself), nor set-piece / celebration states. A shot struck while a tackle came in passed straight through the
 * tackler's body (isFree only).
 */
function shotBodyBlocks(q: PlayerState): boolean {
  const a = q.act;
  return a === ActionKind.NONE || (a >= ActionKind.KICK && a <= ActionKind.STUMBLE) || a === ActionKind.GET_UP ||
    a === ActionKind.SHIELD;
}

/**
 * Contact phase: defenders intercepting passes that cross their reach, and [QF-9] blocking fresh shots: a shot used to
 * pass straight through every outfield defender who was not the controlled player, the chaser or the pass target (only
 * passes were intercepted here, and SIM-07 let only those three "receive" a shot, at any speed).
 */
export function interceptContacts(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (b.owner >= 0 || !ballPlayable(s) || ballTouchedThisTick(s) || !liveBall(s)) return;
  const shot = untouchedPass(s) ? 0 : isFreshShot(s) ? 1 : 0;
  if (shot === 0 && !untouchedPass(s)) return;
  const maxH = shot === 1 ? L.shotBlockHeight : L.interceptMaxHeight;
  const sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  if (!(sp >= L.interceptMinSpeed)) return;
  const passTeam = b.lastKickTeam;
  if (passTeam !== 0 && passTeam !== 1) return;
  const first = passTeam === 0 ? PLAYERS_PER_TEAM : 0;
  const reach = T.interceptReach;
  let n = 0;
  for (let j = first; j < first + PLAYERS_PER_TEAM; j++) {
    const q = s.players[j]!;
    if (q.active !== 1 || q.isKeeper === 1 || q.team === passTeam) continue;
    // [QF-9 skeptic] Free (and allowed to touch): intercepts / blocks. Busy (a tackle, its recovery, a stumble, a
    // header or kick wind-up, stunned): his body still stops a fresh shot (shotBodyBlocks), nothing else.
    const free = isFree(q) && q.noTouchT <= 0 ? 1 : 0;
    if (free === 0 && (shot === 0 || !shotBodyBlocks(q))) continue;
    S[0] = b.px; S[1] = b.pz; S[2] = b.x; S[3] = b.z; S[4] = q.x; S[5] = q.z;
    segDist();
    const d = G[0]!, t = G[1]!;
    if (d > reach) continue;
    // Entry edge: outside his reach at the start of the tick (both positions one tick back) -> one roll. A path through
    // his body is a contact on any tick (it cannot slip past him).
    const qx0 = q.x - q.vx * DTS, qz0 = q.z - q.vz * DTS;
    const ex = b.px - qx0, ez = b.pz - qz0;
    const entry = ex * ex + ez * ez > reach * reach ? 1 : 0;
    const body = d <= bodyRadiusOf(s, j) * L.interceptBodyBlock ? 1 : 0;
    if ((entry === 0 || free === 0) && body === 0) continue;
    const yAt = b.py + (b.y - b.py) * t;
    // [QF-13 skeptic] His body stops a pass up to torso height too (shotBlockHeight): a lofted pass went through an
    // opponent's chest / head about once a match.
    if (!(yAt <= (body === 1 ? L.shotBlockHeight : maxH))) continue;
    // Above interceptMaxHeight (a shot at his chest): only his body stops it, no stretched-leg roll; nor for a busy
    // man.
    let roll = free === 1 && entry === 1 && yAt <= L.interceptMaxHeight ? 1 : 0;
    // His keeper claiming the ball (glitch list: keeper fights a defender) calls off a pass interception and his
    // stretched leg, never his body in a shot's path: [QF-13 skeptic] a volley went through a defender's chest into the
    // net while his keeper dived for it behind him (seed 801 #4).
    if (keeperClaims(s, j)) {
      if (shot === 0) continue;
      roll = 0;
    }
    if (roll === 0 && body === 0) continue;
    // insertion by path order (ties: lower slot first, already in slot order)
    let k = n;
    while (k > 0 && CAND_T[k - 1]! > t) {
      CAND_T[k] = CAND_T[k - 1]!; CAND_D[k] = CAND_D[k - 1]!; CAND_SLOT[k] = CAND_SLOT[k - 1]!; CAND_F[k] = CAND_F[k - 1]!;
      k--;
    }
    // The chance reads how far from him the pass runs (its line), not where it first touches his reach.
    const miss = ((q.x - b.x) * b.vz - (q.z - b.z) * b.vx) / sp;
    CAND_T[k] = t; CAND_D[k] = miss < 0 ? -miss : miss; CAND_SLOT[k] = j; CAND_F[k] = roll + 2 * body;
    n++;
  }
  const passer = b.lastKickBy;
  for (let c = 0; c < n; c++) {
    const j = CAND_SLOT[c]!;
    const q = s.players[j]!;
    const t = CAND_T[c]!, d = CAND_D[c]!, f = CAND_F[c]!;
    const yAt = b.py + (b.y - b.py) * t;
    const won = (f & 1) !== 0 && rngFloat(s.rng) < interceptChance(s, j, d, sp, yAt);
    if (!won && (f & 2) === 0) continue;
    // Back to the contact point on its own path.
    b.x = b.px + (b.x - b.px) * t;
    b.z = b.pz + (b.z - b.pz) * t;
    b.y = yAt;
    const rvx = b.vx - q.vx, rvz = b.vz - q.vz;
    let ctrl = lerp(L.interceptControlSpeedLo, L.interceptControlSpeedHi, attr01(s.attrs[j]!.ballControl));
    if (!won) ctrl *= L.bodyControlFrac; // straight at him: he traps it only when it is gentle
    // A busy man (tackle, stumble, ...) never traps it: it comes off his body.
    if (isFree(q) && q.noTouchT <= 0 && rvx * rvx + rvz * rvz <= ctrl * ctrl) {
      takePossession(s, j, ev);
      let fx = b.x - q.x, fz = b.z - q.z;
      const fl = Math.sqrt(fx * fx + fz * fz);
      if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = q.fx; fz = q.fz; }
      cushion(s, j, fx, fz);
    } else {
      blockBall(s, j, ev);
    }
    ev.emit(EventType.INTERCEPT, j, passer, 0, 0, b.x, b.y, b.z);
    return;
  }
}

// ---------------------------------------------------------------- action handlers

function lungeMove(s: SimState, p: PlayerState): void {
  p.moveMode = MoveMode.LOCKED;
  p.wantSprint = 0;
  const end = p.actContact + contactTicksOf(p.act);
  if (p.actDone !== 0 || p.actT >= end) return; // recovery: locked friction
  if (p.actT <= p.actContact) homeDir(s, p, L.lungeTurnPerTick);
  const dx = p.actDirX, dz = p.actDirZ;
  const along = p.vx * dx + p.vz * dz;
  let sp: number;
  if (p.actT < p.actContact) sp = along > 0 ? along * L.windupSpeedKeep : 0;
  else { sp = p.actB; if (along > sp) sp = along; }
  const top = topSpeedOf(s, p.slot);
  if (sp > top) sp = top;
  p.vx = dx * sp;
  p.vz = dz * sp;
  p.fx = dx;
  p.fz = dz;
}

function slideMove(s: SimState, p: PlayerState): void {
  p.moveMode = MoveMode.LOCKED;
  p.wantSprint = 0;
  let sp: number;
  if (p.actT < p.actContact) {
    // Going down: his speed along the slide ramps to v0 by the contact.
    homeDir(s, p, L.lungeTurnPerTick);
    let along = p.vx * p.actDirX + p.vz * p.actDirZ;
    if (along < 0) along = 0;
    sp = along + (p.actB - along) * (p.actContact > 0 ? p.actT / p.actContact : 1);
  } else {
    const g = p.actT - p.actContact;
    if (g >= L.slideGlideTicks) return; // on the ground: locked friction
    sp = p.actB * (1 - g / L.slideGlideTicks);
  }
  p.vx = p.actDirX * sp;
  p.vz = p.actDirZ * sp;
  p.fx = p.actDirX;
  p.fz = p.actDirZ;
}

function capIntent(s: SimState, p: PlayerState, scale: number): void {
  p.wantSprint = 0;
  if (p.moveMode === MoveMode.DIRECT) {
    const m2 = p.ix * p.ix + p.iz * p.iz;
    if (m2 > scale * scale) { const k = scale / Math.sqrt(m2); p.ix *= k; p.iz *= k; }
  } else if (p.moveMode === MoveMode.ARRIVE) {
    const lim = scale * topSpeedOf(s, p.slot) * T_PLAYER.jogFraction;
    if (p.tgtSpeed > lim) p.tgtSpeed = lim;
  }
}

function tackleUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  switch (p.act) {
    case ActionKind.STAND_TACKLE:
    case ActionKind.HARD_TACKLE:
      lungeMove(s, p);
      return;
    case ActionKind.SLIDE_TACKLE:
      slideMove(s, p);
      return;
    case ActionKind.SHOULDER:
    case ActionKind.PUSH_PULL:
      if (p.actT >= p.actContact + contactTicksOf(p.act)) p.wantSprint = 0;
      return;
    case ActionKind.STUMBLE: {
      const r = p.actDur - p.actT;
      p.stunT = r > 0 ? r : 0;
      capIntent(s, p, L.stumbleMoveScale);
      return;
    }
    case ActionKind.FALLEN: {
      p.moveMode = MoveMode.LOCKED;
      p.wantSprint = 0;
      if (p.actT >= p.actDur) {
        beginAction(p, ActionKind.GET_UP, T.getUpTicks, -1);
        p.moveMode = MoveMode.LOCKED;
        p.stunT = T.getUpTicks;
        return;
      }
      p.stunT = p.actDur - p.actT + T.getUpTicks;
      return;
    }
    case ActionKind.GET_UP: {
      p.moveMode = MoveMode.LOCKED;
      p.wantSprint = 0;
      const r = p.actDur - p.actT;
      p.stunT = r > 0 ? r : 0;
      return;
    }
    default:
      return;
  }
}

function tackleEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  if (isDown(p.act)) p.stunT = 0;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

bindTackleImpl({ update: tackleUpdate, end: tackleEnd, solveClearance: solveClear });

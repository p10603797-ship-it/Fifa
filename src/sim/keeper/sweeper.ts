/**
 * [GKP-03] Coming out: rushes for through balls and one-on-ones, claims or punches crosses in the goal area,
 * smothers loose balls. Also executes the user's keeper-rush hold (resolver starts GK_RUSH). Never fights a
 * defender for the same ball. Handlers GK_RUSH and GK_PUNCH.
 *
 * HOW IT WORKS
 *  keeperComeOut (teamAiTick, after GKP-02 keeperSaveDecision, IN_PLAY, AI-driven keepers only) is the brain: it
 *  starts a come-out from a free keeper and re-assesses an AI rush every tick (start thresholds stricter than keep
 *  thresholds, so it never flip-flops); the GK_RUSH / GK_PUNCH handlers are the body (movement and ball contacts in
 *  actionsTick, so the keeper's claim comes before any header / first touch of the same tick).
 *   - Loose / through ball (race): the keeper's interception (TAI-07 estimateIntercept: the first playable predicted
 *     sample he reaches with SIM-04 ticksToReach, the same model the loose-ball chaser uses) must lie in the come-out
 *     zone (T_GK.rushDistance from his line, zoneHalfWidth, zoneMaxDist from the goal centre) and he must get there
 *     oppStartMargin ticks before the fastest opponent and mateStartMargin ticks before every outfield teammate
 *     (never fight a defender: a defender who gets there first, or about as soon, keeps the ball). Players whose
 *     straight-line lower bound to the ball's path cannot matter are pruned before their estimate. Our own pass in
 *     flight to a teammate (incl. a back-pass to him) is never contested. A rushing keeper is TAI-07's chaser, so no
 *     outfield teammate chases with him. Abort when a teammate will be there mateAbortMargin ticks earlier, an
 *     opponent oppAbortMargin ticks earlier (then a one-on-one may take over), or the point leaves the zone.
 *   - One-on-one: an opponent has the ball (or wins the race to it) inside oneOnOneDepth / oneOnOneHalfWidth, not at
 *     a tight angle (|z| <= GOAL_HALF_WIDTH + depth * oneOnOneBearing; GKP-01 covers the near post there), not
 *     running away from goal, and no outfield teammate engages him (within coverDist) or covers the goal (goal-side
 *     inside coverChannel of the attacker-goal line within coverRange). The keeper advances to the narrowing spot on
 *     the goal-centre -> ball line (narrowBase + narrowFrac x the ball's distance from the goal centre, at least
 *     narrowGapMin short of the ball, at most narrowMaxDepth out: he comes out early, then holds his ground), facing
 *     the ball when close, and goes down at the ball (smother) when it is within smotherStartDist.
 *   - Crosses (claim): a loose airborne ball, not an opponent's shot, whose predicted path (SIM-01 predictBall) is not
 *     goal-bound (those are GKP-02's saves) and comes through the claim zone (claimZoneDepth x claimZoneHalfWidth)
 *     above claimMinY (above heads) but within his reach (height x claimArmsUpMul + a jump from gkDiving) at a sample
 *     he can get under in time -> GK_PUNCH planned at that sample, unless a teammate already goes up for the same
 *     flight earlier (SIM-12 HEADER / VOLLEY with actB = flight id). Lower balls are loose balls (race above).
 *  startKeeperRush (resolver: THROUGH / KEEPER_RUSH held in defence, or a tap on the own keeper): GK_RUSH in a user
 *   mode. USER_HOLD (a controller of his team holds THROUGH at the start) lasts while any controller of his team holds
 *   THROUGH (at least userMinTicks); USER_TIMED (gesture) lasts userTimedTicks. The keeper sprints at the ball
 *   (interception point when loose, the ball at the carrier's feet when owned) and plays it like an AI rush; release
 *   ends the rush and GKP-01 positioning takes him back toward his line (a human-controlled keeper gets his stick
 *   back).
 *   Refused when the ball is in anyone's hands or our team has it, or the keeper is busy; an AI rush is upgraded (and
 *   the brain hands an AI rush to a held THROUGH while the opponents have the ball, since the resolver only starts
 *   a rush from a free keeper).
 *  GK_RUSH handler (RUN phase): ends when play stops, the ball is held, our team has it, a user rush is released /
 *   timed out, or a human takes over an AI keeper. Ball contacts (one per tick, the ball's swept path this tick
 *   against his reach):
 *    - collect: a loose ball within collectReach of his body axis and below his reach -> GKP-05 keeperPickUp when he
 *      may handle it (canHandle: inside his area, back-pass rule) and it is slow enough (T_GK.catchSpeed x gkHandling);
 *      otherwise a low ball with an opponent within clearPressureDist is cleared first time (CLEARANCE via applyKick,
 *      long and toward the near touchline) or blocked when too fast; an unpressured low ball he may not handle is
 *      left to SIM-06 to take at his feet (the rush ends within its control radius).
 *    - smother: the ball low and within smotherStartDist, owned by an opponent or loose with an opponent within
 *      smotherContestDist, and not behind the attacker's body -> SMOTHER phase.
 *   Movement: ARRIVE at the run target at top speed (sprint when far, facing the ball when close): AI ball / user
 *   loose: his interception point; one-on-one: the narrowing spot; user vs a carrier: the ball (led slightly). Targets
 *   stay minDepth in front of his goal line and inside the boards.
 *  SMOTHER phase: a homing lunge on the ground (hip moves toward the ball at smotherLungeSpeed, at most
 *   smotherLungeMax from the lunge start, never behind his line; movement LOCKED, positions placed directly like a
 *   GKP-02 dive) with the hands smotherHandReach beyond the hip. In the contact window (after smotherWindupTicks, for
 *   smotherWindowTicks) the ball's swept path within smotherHandRadius of the hip-hands segment is won: the carrier
 *   loses it (releasePossession, noTouchT = T_DRIBBLE.dispossessedNoTouch, TACKLE c=1 d=KEEPER); keeperPickUp inside
 *   his area, else the ball squirts away from goal (DEFLECTION at smotherBlockSpeed, faster balls keep a share of their
 *   speed). A missed window with the carrier's body against him records a KEEPER challenge (ballFirst 0) for RUL-09
 *   via SIM-14 pushChallenge (TACKLE c=0). After the window (won and pushed away, or missed) he is on the ground: a
 *   GKP-02 low dive along the lunge with no hip travel (startKeeperDive): TAI-07 then stops counting him as the
 *   chaser (an outfielder takes the loose ball), GKP-02 does not plan a new save from the ground, his lying body still
 *   blocks, and the dive always ends with a get-up. (Fallback if the dive is refused: GK_RUSH DOWN phase until
 *   smotherDownTicks + smotherGetUpTicks after the window.)
 *  GK_PUNCH handler: run to the claim spot (ARRIVE, sprint) until take-off (actContact - takeoffTicks), then a leap
 *   (LOCKED) toward the spot timed to meet the ball at the contact (at most claimLeapMaxFrac of his top speed; the
 *   plan assumes claimLeapPlanFrac), then landing on friction (claimLandVelKeep of the leap kept). Contact window
 *   [actContact - claimEarlyTicks, actContact + claimLateTicks]: the ball's swept path within claimArmRadius of his
 *   vertical reach segment (claimLowY .. reach top). Catch (keeperPickUp -> GK_HOLD) when
 *   uncontested (no opponent within contestRadius of the ball), slow enough (catch limit, less above headHeight),
 *   canHandle, and an s.rng draw under the gkHandling catch chance; otherwise punch it (GK_PUNCH via applyKick) away
 *   from goal toward the side the ball travels, at punchSpeed (strength / handling) with punchLift. Any other touch of
 *   the flight before take-off cancels the claim; in the air he lands. Always ends (fixed actDur).
 *  SAVE events only for opponents' shots on target (SaveKind CATCH / PUNCH / BLOCK); crosses and through balls
 *  emit KEEPER_HANDS / KICK through GKP-05 and kick.ts.
 *
 * ACTION FIELDS
 *  GK_RUSH:  actA = RushMode (AI_BALL, AI_ONE_ON_ONE, USER_HOLD, USER_TIMED); actB = RushPhase (RUN, SMOTHER, DOWN);
 *            actX/actZ = RUN: run target, SMOTHER/DOWN: hip position at the lunge start; actDirX/actDirZ = unit run
 *            direction (RUN) / lunge direction (SMOTHER, DOWN); actSlot = attacker confronted (one-on-one, smother
 *            victim), -1 none; actContact = first tick (relative) of the smother contact window, -1 while running;
 *            actCurve = actT when the lunge started; actPower = actT when the current mode began (user durations);
 *            actDone = 1 ball played / 2 smother missed; actKick = KickKind he played it with (NONE when caught).
 *  GK_PUNCH: actX/actZ = claim spot; actCurve = planned ball-centre height at contact (m); actContact = planned
 *            contact tick (relative); actB = flight id (ball.lastTouchTick at the start); actA = 0 on the ground
 *            (approach) / 1 airborne (from actContact - takeoffTicks); actDirX/actDirZ = unit leap direction, then the
 *            punch direction; actPower = leap speed (m/s); actDone = 1 played / 2 missed or cancelled in the air;
 *            actKick = GK_PUNCH when punched.
 *
 * Determinism: dmath trig only, s.rng only (one draw per uncontested catchable claim), slot-order loops, module
 * scratch only (no per-tick allocation; hot helpers pass doubles through Float64Array scratch so V8 never boxes them).
 * Cost: nothing unless a loose ball is within prefilterDepth of his line or an opponent has it near the area; then
 * one keeper interception estimate plus pruned estimates for the few players who could matter, or one 90-tick
 * prediction for an airborne ball (tests/perf/gkp-03-budget.test.ts: < 0.05 ms per keeper per tick).
 *
 * IMPORT CYCLE: actions/registry reads this module's handlers while building its tables and this module imports
 * actions/dispatch (-> registry). The registry-facing handlers are shells from sweeperHooks.ts (no runtime imports),
 * re-exported FIRST below; the implementation is bound at the end of this file.
 */
// Re-export the handler shells FIRST (import-cycle safety with actions/registry; see sweeperHooks.ts).
export { comeOutWanted, punchHandler, rushHandler } from './sweeperHooks';
import { bindSweeperImpl } from './sweeperHooks';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import {
  BALL_RADIUS, BOARD_X, BOARD_Z, DT, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, NUM_CONTROLLERS, NUM_SLOTS,
  PLAYERS_PER_TEAM, TICK_HZ, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, ChallengeKind, ControllerKind, KickKind, MatchPhase, SaveKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { Btn } from '../../contracts/input';
import { createChallengeRecord, MoveMode, type PlayerAttrs, type SimState } from '../../contracts/state';
import { createBallPrediction, createKickLaunch } from '../../contracts/systems';
import { T_BALL, T_DRIBBLE, T_GK, T_PLAYER } from '../../contracts/tuning';
import { createInterceptEstimate, estimateIntercept, estimateInterceptSlack } from '../../ai/steer';
import { predictBall } from '../ball/flight';
import { applyKick, ballTouchedThisTick, releasePossession } from '../core/kick';
import { attr, clamp01, dcos, dsin } from '../core/dmath';
import { isHumanSlot } from '../core/query';
import { rngFloat } from '../core/rng';
import { pushChallenge } from '../defend/tackle';
import { ticksToReach } from '../players/locomotion';
import { canHandle, keeperPickUp } from './handling';
import { startKeeperDive } from './saves';
import { heightM } from './saveKinematics';

export const LOCAL_TUNING = { // TUNING-CR (GKP-03): move into T_GK
  // ---- loose balls / through balls (race)
  /** Pre-filter: a loose ball farther than this from his goal line is ignored ... m ... */
  prefilterDepth: 45,
  /** ... unless its speed toward his line brings it within T_GK.rushDistance within this time, s. */
  prefilterSeconds: 2.5,
  /** Come-out zone: interception point within T_GK.rushDistance of his line, |z| <= zoneHalfWidth and at most
   *  zoneMaxDist from his goal centre, m. */
  zoneHalfWidth: 22,
  zoneMaxDist: 24,
  /** An AI rush continues while the point stays inside the zone grown by this, m. */
  zoneKeepSlack: 4,
  /** [QF-2] A rush starts only for an interception point at least this far in front of his goal line, m. */
  startMinDepth: 2,
  /** [QF-2 skeptic] Hysteresis on the interception estimates (see race): a rush under way keeps a point he reaches up
   *  to this many ticks after the ball ... */
  keepReachSlack: 6,
  /** ... and a rush starts only when no outfield teammate reaches the ball up to this many ticks after it in a window
   *  more than mateNearMissJump ticks earlier than the one he makes in time (a discontinuity of his estimate, not
   *  the smooth drift of a ball rolling away from him, which the start / abort margins already cover), ticks. */
  mateNearMissSlack: 6,
  mateNearMissJump: 15,
  /** [QF-2 skeptic] Loose-ball one-on-one: starts when the opponent beats every outfield teammate to the ball by this
   *  many ticks, and is kept until a teammate beats the opponent by oneOnOneMateKeep ticks, ticks. */
  oneOnOneMateStart: 3,
  oneOnOneMateKeep: 4,
  /** [QF-2] No AI come-out starts for an opponent's shot (on target: GKP-02 saves it from his set position; off
   *  target: it is going out) faster than this: rushing at a 17 m/s long shot started, aborted and restarted the rush
   *  on consecutive ticks as the defenders' interception estimates on the fast ball jumped, m/s. A weak shot rolling
   *  in is still walked out to. */
  shotRushMaxSpeed: 10,
  /** Start a rush only when he reaches the ball at least this many ticks before the fastest opponent ... */
  oppStartMargin: 3,
  /** ... and abort it when an opponent will be there this many ticks before him. */
  oppAbortMargin: 8,
  /** Never fight a defender: start only when every outfield teammate needs at least this many ticks more ... */
  mateStartMargin: 10,
  /** ... and abort when a teammate will be there this many ticks before him. */
  mateAbortMargin: 4,
  /** Path lower bound: a player reaches a point within this distance of it (ticksToReach / chase reach), m. */
  raceReachSlack: 1.2,
  // ---- one-on-ones
  /** Attacker (ball) at most this far from the goal line to start / keep a one-on-one, m. */
  oneOnOneDepth: 20,
  oneOnOneDepthKeep: 24,
  /** ... and |z| at most this, m. */
  oneOnOneHalfWidth: 16,
  oneOnOneHalfWidthKeep: 19,
  /** ... and at least this far in front of the goal line (a ball on the line is GKP-01's near post), m. */
  oneOnOneMinDepth: 0.5,
  /** Tight angle limit: |z| <= GOAL_HALF_WIDTH + depth * this (m per m of depth). */
  oneOnOneBearing: 1.3,
  /** An attacker moving away from goal faster than this is no one-on-one (start only), m/s. */
  oneOnOneRetreatSpeed: 1.0,
  /** A teammate within this distance of the attacker engages him (start / keep), m. */
  coverDist: 3.0,
  coverDistKeep: 2.0,
  /** A teammate goal-side of the attacker within this lateral distance of the attacker-goal line ... (start / keep),
   *  m ... */
  coverChannel: 3.0,
  coverChannelKeep: 2.0,
  /** ... and within this distance of him covers the goal, m. */
  coverRange: 12,
  /** Narrowing spot on the goal-centre -> ball line, narrowBase + narrowFrac x (ball distance) from the goal centre
   *  (he comes out early and then holds his ground instead of backing off), m and fraction ... */
  narrowBase: 3.0,
  narrowFrac: 0.2,
  /** ... at least narrowGapMin short of the ball, m ... */
  narrowGapMin: 1.0,
  /** ... and never further than this from his goal line, m. */
  narrowMaxDepth: 9,
  /** Face the ball (set, shuffling) within this distance of the run target, m. */
  faceDist: 3,
  /** Sprint flag when the run target is farther than this, m. */
  sprintDist: 2,
  /** User rush at a carrier: aim this far ahead along the ball's velocity, s. */
  userLeadSeconds: 0.15,
  // ---- smother (going down at the ball)
  /** Go down when the low ball is within this distance of his centre, m. */
  smotherStartDist: 2.0,
  /** Highest ball centre he smothers (a lying keeper), m. */
  smotherMaxY: 0.6,
  /** A loose ball counts as contested when an opponent is within this distance of it, m. */
  smotherContestDist: 2.5,
  /** Ball beyond the attacker's body: no smother when the attacker is nearer him than the ball by more than this, m. */
  smotherBehindSlack: 0.3,
  /** Lunge timing: wind-up ticks, contact window ticks, ticks on the ground after the window, get-up ticks. */
  smotherWindupTicks: 4,
  smotherWindowTicks: 8,
  smotherDownTicks: 22,
  smotherGetUpTicks: 18,
  /** Hip speed and max hip travel of the lunge, m/s and m. */
  smotherLungeSpeed: 6,
  smotherLungeMax: 1.6,
  /** Hands beyond the hip, and their contact radius (+ BALL_RADIUS), m. */
  smotherHandReach: 0.8,
  smotherHandRadius: 0.3,
  /** Body contact with the attacker: his centre within this of the hip-hands segment, m. */
  smotherBodyContact: 0.75,
  /** On the ground after the window: a GKP-02 low dive toward a point this far along the lunge (no hip travel), m. */
  smotherDownReach: 0.6,
  /** Speed of a smothered ball he may not hold, squirting away from goal (min), m/s; lift m/s; share of a fast
   *  ball's speed kept. */
  smotherBlockSpeed: 5,
  smotherBlockLift: 1,
  smotherBlockKeep: 0.35,
  // ---- collecting / clearing during a rush
  /** A loose ball within this horizontal distance of his body axis is played, m. */
  collectReach: 1.0,
  /** Highest ball centre he plays with his feet, m. */
  footTop: 0.7,
  /** A low ball he may not handle is cleared when an opponent is within this distance of it, m ... */
  clearPressureDist: 8,
  /** ... otherwise left to SIM-06 to take at his feet when slower than this (its pickUpMaxSpeed), m/s. */
  feetPickUpMaxSpeed: 6,
  /** First-time clearance speed at gkKicking 1 / 99, m/s; elevation, rad; sideways share toward the near touchline. */
  clearSpeedWorst: 18,
  clearSpeedBest: 25,
  clearAngle: 0.55,
  clearSide: 0.6,
  /** Incoming speed above which a ball he may not catch is blocked instead of cleared, m/s. */
  clearMaxIncoming: 14,
  /** Ticks he cannot touch the ball again after clearing / blocking it. */
  playNoTouchTicks: 12,
  /** No new contact within this many ticks of his own last touch. */
  recontactTicks: 12,
  /** Catch limit = T_GK.catchSpeed x this at gkHandling 1 / 99; cut by highCatchPenalty above headHeight (m). */
  catchMulWorst: 0.9,
  catchMulBest: 1.4,
  highCatchPenalty: 0.15,
  headHeight: 1.9,
  // ---- crosses (claim / punch)
  /** Prediction horizon for claims, ticks. */
  claimHorizon: 90,
  /** Claim zone: depth from his line and |z|, m (the goal area and a little beyond). */
  claimZoneDepth: 9,
  claimZoneHalfWidth: 11.5,
  /** Claim samples at least this far in front of his line, m. */
  claimMinDepth: 0.5,
  /** Lowest ball centre he goes up for (above heads; lower balls are loose balls), m. */
  claimMinY: 1.9,
  /** Ball speed below which an airborne ball is no cross, m/s. */
  claimMinSpeed: 4,
  /** Reach top = height x claimArmsUpMul + jump (gkDiving 1 / 99), m. */
  claimArmsUpMul: 1.24,
  claimJumpWorst: 0.3,
  claimJumpBest: 0.6,
  /** Lowest point of the claim reach segment, m. */
  claimLowY: 1.0,
  /** Hands reach this far from his body axis (contact radius + BALL_RADIUS), m; the plan assumes claimPlanReach. */
  claimArmRadius: 0.55,
  claimPlanReach: 0.45,
  /** Take-off this many ticks before the planned contact (he leaps toward the claim spot at up to claimLeapMaxFrac
   *  of his top speed; the plan assumes claimLeapPlanFrac); window early / late ticks; landing ticks. */
  takeoffTicks: 12,
  claimLeapMaxFrac: 1.0,
  claimLeapPlanFrac: 0.75,
  /** Share of his leap velocity kept on landing after the contact (or a miss), unitless. */
  claimLandVelKeep: 0.4,
  claimEarlyTicks: 3,
  claimLateTicks: 3,
  claimLandTicks: 18,
  /** A claim is contested (punch) when an opponent is within this horizontal distance of the ball, m. */
  contestRadius: 1.8,
  /** Catch chance of an uncontested catchable claim at gkHandling 1 / 99. */
  claimCatchWorst: 0.55,
  claimCatchBest: 0.97,
  /** Punch speed at (strength + gkHandling) / 2 = 1 / 99, m/s; angle off the outward axis, rad; lift, m/s. */
  punchSpeedWorst: 11,
  punchSpeedBest: 17,
  punchAngle: 0.55,
  punchLift: 5,
  // ---- user rush
  /** A held rush lasts at least this many ticks; a gesture (tap) rush this many. */
  userMinTicks: 12,
  userTimedTicks: 90,
  // ---- limits
  /** Max ticks of one GK_RUSH (a held rush restarts from the resolver). */
  rushMaxTicks: 300,
  /** Run targets / the lunge stay at least this far in front of his goal line, m. */
  minDepth: 0.3,
} as const;

const L = LOCAL_TUNING;
const EPS = 1e-9;

/** GK_RUSH actA. */
export const RushMode = { AI_BALL: 0, AI_ONE_ON_ONE: 1, USER_HOLD: 2, USER_TIMED: 3 } as const;
/** GK_RUSH actB. */
export const RushPhase = { RUN: 0, SMOTHER: 1, DOWN: 2 } as const;

const M_BALL = RushMode.AI_BALL;
const M_1V1 = RushMode.AI_ONE_ON_ONE;
const M_HOLD = RushMode.USER_HOLD;
const M_TIMED = RushMode.USER_TIMED;
const P_RUN = RushPhase.RUN;
const P_SMOTHER = RushPhase.SMOTHER;
const P_DOWN = RushPhase.DOWN;

/** Decisions of assess(). */
const DEC_NONE = 0;
const DEC_BALL = 1;
const DEC_1V1 = 2;
const DEC_CLAIM = 3;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

const EST = createInterceptEstimate();
/** [QF-2] Second estimate scratch (a teammate's near-miss estimate in race). */
const EST2 = createInterceptEstimate();
const PRED = createBallPrediction();
const LAUNCH = createKickLaunch();
const REC = createChallengeRecord();
/** Decision output of assess(): run target (same shape as TGT: narrowingSpot writes both) and attacker slot. */
const DEC = { x: 0, z: 0 };
let decSlot = -1;
/** Race result: keeper's interception tick / point, fastest teammate and opponent ticks, fastest opponent. */
const RACE = { kT: 0, kX: 0, kZ: 0, mateT: 0, oppT: 0, opp: -1, oppX: 0, oppZ: 0 };
/** Claim plan: sample index and ball position. */
const CLAIM = { i: -1, x: 0, y: 0, z: 0 };
/** Segment-segment closest points. */
const SEG = { d2: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };
/** Run target. */
const TGT = { x: 0, z: 0 };
/**
 * Numbers for the hot helpers. V8 boxes a double passed to (or returned from) a call it does not inline (a heap
 * number per call), so the per-tick helpers take and return their doubles through this array (indices below).
 */
const F = new Float64Array(24);
/** distPointSeg: point P, segment A-B in; distance out. */
const F_PX = 0, F_PZ = 1, F_AX = 2, F_AZ = 3, F_BX = 4, F_BZ = 5, F_DIST = 6;
/** Threat point (ball / interception) for oneOnOne and narrowing. */
const F_TX = 7, F_TZ = 8;
/** clampTarget input / narrowing output. */
const F_CX = 9, F_CZ = 10;
/** nearestOpponentWithin query point and radius. */
const F_QX = 11, F_QZ = 12, F_QR = 13;
/** Keeper reach top / catch limit results; catch-limit height input. */
const F_TOP = 14, F_LIM = 15, F_LIMY = 16;
/** segSeg inputs: P1 Q1 (the ball's path) and P2 Q2 (the keeper's reach segment). */
const SEGIN = new Float64Array(12);
/** Smother attacker found by smotherWanted(). */
let smotherVictim = -1;

// ---------------------------------------------------------------- small helpers

/** Metres in front of the goal line a team (attack direction dir) defends. */
function depthOf(dir: number, x: number): number { return dir * x + HALF_LENGTH; }
function xOfDepth(dir: number, u: number): number { return dir * (u - HALF_LENGTH); }
function absf(v: number): number { return v < 0 ? -v : v; }
function isFiniteNum(v: number): boolean { return v - v === 0; }

function validSlot(slot: number): boolean { return slot >= 0 && slot < NUM_SLOTS; }

/** Top speed of a slot, m/s. */
function topOf(a: Readonly<PlayerAttrs>): number { return a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin; }

/** Highest ball centre the keeper reaches with his hands (arms up + jump), m, into F[F_TOP]. */
function claimTopF(a: Readonly<PlayerAttrs>): void {
  F[F_TOP] = heightM(a) * L.claimArmsUpMul + attr(a.gkDiving, L.claimJumpWorst, L.claimJumpBest);
}

/** Fastest ball (m/s) the keeper catches at ball-centre height F[F_LIMY], into F[F_LIM]. */
function catchLimitF(a: Readonly<PlayerAttrs>): void {
  const lim = T_GK.catchSpeed * attr(a.gkHandling, L.catchMulWorst, L.catchMulBest);
  F[F_LIM] = F[F_LIMY]! > L.headHeight ? lim * (1 - L.highCatchPenalty) : lim;
}

/** Highest ball centre the keeper reaches with his hands (arms up + jump), m. */
export function keeperClaimTop(a: Readonly<PlayerAttrs>): number {
  claimTopF(a);
  return F[F_TOP]!;
}

/** Fastest ball (m/s) the keeper catches at ball-centre height y. */
export function keeperCatchLimit(a: Readonly<PlayerAttrs>, y: number): number {
  F[F_LIMY] = y;
  catchLimitF(a);
  return F[F_LIM]!;
}

/** Any controller of the team (human or CPU brain) holding THROUGH / KEEPER_RUSH this tick. */
export function keeperRushHeld(s: SimState, team: number): boolean {
  for (let c = 0; c < NUM_CONTROLLERS; c++) {
    const ctl = s.ctrl[c];
    if (!ctl || ctl.kind === ControllerKind.NONE || ctl.side !== team) continue;
    if ((ctl.buttons & Btn.THROUGH) !== 0) return true;
  }
  return false;
}

/** [QF-2] An opponent's shot (on target or not) is the ball's last kick. */
function opponentShot(s: SimState, team: number): boolean {
  const b = s.ball;
  return validSlot(b.shotBy) && s.players[b.shotBy]!.team !== team;
}

/** An opponent's shot on target is in flight (SAVE events). */
function onTargetShot(s: SimState, team: number): boolean {
  const b = s.ball;
  return validSlot(b.shotBy) && b.shotOnTarget === 1 && s.players[b.shotBy]!.team !== team;
}

/** Distance from P (F_PX, F_PZ) to the segment A-B (F_AX..F_BZ) on the ground plane, into F[F_DIST]. */
function distPointSeg(): void {
  const px = F[F_PX]!, pz = F[F_PZ]!, ax = F[F_AX]!, az = F[F_AZ]!;
  const dx = F[F_BX]! - ax, dz = F[F_BZ]! - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > EPS ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  F[F_DIST] = Math.sqrt(cx * cx + cz * cz);
}

/**
 * Closest points between segments P1Q1 and P2Q2 (SEGIN[0..5], SEGIN[6..11]; Ericson, RTCD 5.1.9) into SEG (a on the
 * first, b on the second).
 */
function segSeg(): void {
  const p1x = SEGIN[0]!, p1y = SEGIN[1]!, p1z = SEGIN[2]!, q1x = SEGIN[3]!, q1y = SEGIN[4]!, q1z = SEGIN[5]!;
  const p2x = SEGIN[6]!, p2y = SEGIN[7]!, p2z = SEGIN[8]!, q2x = SEGIN[9]!, q2y = SEGIN[10]!, q2z = SEGIN[11]!;
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) {
    // Both degenerate: the start points.
  } else if (a <= EPS) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp01(-c / a);
    } else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - bb * bb;
      s = den > EPS ? clamp01((bb * f - c * e) / den) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((bb - c) / a); }
    }
  }
  SEG.ax = p1x + d1x * s; SEG.ay = p1y + d1y * s; SEG.az = p1z + d1z * s;
  SEG.bx = p2x + d2x * t; SEG.by = p2y + d2y * t; SEG.bz = p2z + d2z * t;
  const dx = SEG.ax - SEG.bx, dy = SEG.ay - SEG.by, dz = SEG.az - SEG.bz;
  SEG.d2 = dx * dx + dy * dy + dz * dz;
}

/** SEGIN[0..5] = the ball's straight path this tick (position -> position + velocity x DT). */
function ballPathIn(s: SimState): void {
  const b = s.ball;
  SEGIN[0] = b.x; SEGIN[1] = b.y; SEGIN[2] = b.z;
  SEGIN[3] = b.x + b.vx * DT; SEGIN[4] = b.y + b.vy * DT; SEGIN[5] = b.z + b.vz * DT;
}

/** Clamp the run target (F_CX, F_CZ) in front of the goal line (minDepth) and inside the boards into TGT. */
function clampTarget(dir: number): void {
  const x = F[F_CX]!, z = F[F_CZ]!;
  let tx = isFiniteNum(x) ? x : 0;
  let tz = isFiniteNum(z) ? z : 0;
  if (depthOf(dir, tx) < L.minDepth) tx = xOfDepth(dir, L.minDepth);
  const mx = BOARD_X - T_PLAYER.bodyRadius, mz = BOARD_Z - T_PLAYER.bodyRadius;
  if (tx > mx) tx = mx; else if (tx < -mx) tx = -mx;
  if (tz > mz) tz = mz; else if (tz < -mz) tz = -mz;
  TGT.x = tx;
  TGT.z = tz;
}

/**
 * Narrowing spot against a ball at (bx, bz) for a keeper defending the goal of a team attacking toward dir: on the
 * goal-centre -> ball line, narrowBase + narrowFrac x (ball distance) from the goal centre, at least narrowGapMin
 * short of the ball, at most narrowMaxDepth out and minDepth in front of the line. Pure; writes out.
 */
export function narrowingSpot(dir: number, bx: number, bz: number, out: { x: number; z: number }): void {
  F[F_TX] = bx; F[F_TZ] = bz;
  narrowCore(dir);
  out.x = F[F_CX]!;
  out.z = F[F_CZ]!;
}

/** narrowingSpot for the threat point (F_TX, F_TZ), into (F_CX, F_CZ). */
function narrowCore(dir: number): void {
  const bx = F[F_TX]!, bz = F[F_TZ]!;
  const gx = -dir * HALF_LENGTH;
  let vx = bx - gx, vz = bz;
  let d = Math.sqrt(vx * vx + vz * vz);
  if (!(d > EPS)) { vx = dir; vz = 0; d = 1; }
  let r = L.narrowBase + L.narrowFrac * d;
  if (r > d - L.narrowGapMin) r = d - L.narrowGapMin;
  if (r < L.minDepth) r = L.minDepth;
  let x = gx + (vx / d) * r;
  let z = (vz / d) * r;
  const u = depthOf(dir, x);
  if (u > L.narrowMaxDepth) {
    const f = (L.narrowMaxDepth) / u;
    x = gx + (x - gx) * f;
    z *= f;
  }
  F[F_CX] = isFiniteNum(x) ? x : xOfDepth(dir, L.minDepth);
  F[F_CZ] = isFiniteNum(z) ? z : 0;
}

// ---------------------------------------------------------------- assessment (AI brain)

/**
 * One-on-one test against attacker att with the ball (or his interception point) at (F_TX, F_TZ). keep = 1 uses the
 * looser keep thresholds. Fills DEC (narrowing spot) and decSlot on success.
 */
function oneOnOne(s: SimState, team: number, k: number, att: number, keep: number): boolean {
  if (!validSlot(att)) return false;
  const tx = F[F_TX]!, tz = F[F_TZ]!;
  const q = s.players[att]!;
  if (q.active !== 1 || q.team === team) return false;
  const dir = s.teams[team]!.dir;
  const u = depthOf(dir, tx);
  if (!(u >= L.oneOnOneMinDepth) || u > (keep === 1 ? L.oneOnOneDepthKeep : L.oneOnOneDepth)) return false;
  const az = absf(tz);
  if (az > (keep === 1 ? L.oneOnOneHalfWidthKeep : L.oneOnOneHalfWidth)) return false;
  if (az > GOAL_HALF_WIDTH + u * L.oneOnOneBearing) return false;
  const gx = -dir * HALF_LENGTH;
  if (keep === 0) {
    const ex = gx - q.x, ez = -q.z;
    const el = Math.sqrt(ex * ex + ez * ez);
    if (el > EPS && (q.vx * ex + q.vz * ez) / el < -L.oneOnOneRetreatSpeed) return false;
  }
  const covD = keep === 1 ? L.coverDistKeep : L.coverDist;
  const chan = keep === 1 ? L.coverChannelKeep : L.coverChannel;
  const qu = depthOf(dir, q.x);
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === k) continue;
    const m = s.players[i]!;
    if (m.active !== 1 || m.isKeeper === 1) continue;
    const dx = m.x - q.x, dz = m.z - q.z;
    const dm = Math.sqrt(dx * dx + dz * dz);
    if (dm <= covD) return false;
    if (dm <= L.coverRange && depthOf(dir, m.x) < qu) {
      F[F_PX] = m.x; F[F_PZ] = m.z; F[F_AX] = tx; F[F_AZ] = tz; F[F_BX] = gx; F[F_BZ] = 0;
      distPointSeg();
      if (F[F_DIST]! <= chan) return false;
    }
  }
  decSlot = att;
  narrowCore(dir);
  DEC.x = F[F_CX]!;
  DEC.z = F[F_CZ]!;
  return true;
}

/**
 * Race for a loose ball: keeper's interception (RACE.kT/kX/kZ), and the fastest teammate / opponent among those
 * whose path lower bound is below their cut-off (others cannot matter). Returns false when the keeper cannot reach
 * a playable sample within the horizon.
 */
function race(s: SimState, team: number, k: number, keep: number): boolean {
  // [QF-2] Hysteresis on the knife-edge interception estimates (TAI-07 estimateInterceptSlack): a rush under way that
  // loses its point (he no longer makes any sample in time) keeps the first one he reaches up to keepReachSlack ticks
  // late, and a start needs every outfield teammate who would reach the ball up to mateNearMissSlack ticks late to be
  // slower than him (an abort needs a teammate really there first). One estimate flipping between the first-bounce
  // window and the end of the horizon tick to tick started and aborted the rush on alternate ticks (and swapped
  // TAI-07's chaser between him and the defender).
  estimateIntercept(s, k, EST);
  if (keep === 1 && EST.inHorizon !== 1) estimateInterceptSlack(s, k, L.keepReachSlack, EST);
  // [QF-2] A rush already under way keeps its point when the interception slips just past the prediction horizon (a
  // ball rolling slowly toward the byline): requiring it in the horizon for both start and keep made the rush start and
  // abort on alternate ticks (and TAI-07's chaser flip between him and an outfielder).
  if (!isFiniteNum(EST.ballT) || (EST.inHorizon !== 1 && keep === 0)) return false;
  const kT = EST.ballT;
  RACE.kT = kT; RACE.kX = EST.x; RACE.kZ = EST.z;
  RACE.mateT = 1e9; RACE.oppT = 1e9; RACE.opp = -1; RACE.oppX = 0; RACE.oppZ = 0;
  const b = s.ball;
  const ax = b.x, az = b.z, bx = EST.x, bz = EST.z;
  const mateSlack = keep === 1 ? 0 : L.mateNearMissSlack;
  const mateCut = keep === 1 ? kT - L.mateAbortMargin : kT + L.mateStartMargin;
  // Opponents up to the keeper's own tick + start margin matter (and, when he loses, for a one-on-one).
  const oppCut = keep === 1 ? kT : kT + L.oppStartMargin;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === k) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const mate = q.team === team;
    if (mate && q.isKeeper === 1) continue;
    const cut = mate ? mateCut + mateSlack : oppCut;
    // Lower bound of his ticks to the ball's path between the ball and the keeper's point: cannot matter -> skip.
    F[F_PX] = q.x; F[F_PZ] = q.z; F[F_AX] = ax; F[F_AZ] = az; F[F_BX] = bx; F[F_BZ] = bz;
    distPointSeg();
    const gap = F[F_DIST]! - L.raceReachSlack;
    if (gap > 0 && (gap / topOf(s.attrs[i]!)) * TICK_HZ >= cut) continue;
    estimateIntercept(s, i, EST);
    let t = EST.ballT;
    if (mateSlack > 0 && mate) {
      // [QF-2] A near miss of a much earlier window (the first bounce he makes or misses by a tick) counts at a start.
      estimateInterceptSlack(s, i, mateSlack, EST2);
      if (t - EST2.ballT > L.mateNearMissJump) t = EST2.ballT;
    }
    if (!isFiniteNum(t)) continue;
    if (mate) {
      if (t < RACE.mateT) RACE.mateT = t;
    } else if (t < RACE.oppT) {
      RACE.oppT = t; RACE.opp = i; RACE.oppX = EST.x; RACE.oppZ = EST.z;
    }
  }
  return true;
}

/** Keeper's interception point (RACE.kX, RACE.kZ) inside the come-out zone (grown by slack). */
function inZone(dir: number, slack: number): boolean {
  const z = RACE.kZ;
  const u = depthOf(dir, RACE.kX);
  if (!(u >= L.minDepth) || u > T_GK.rushDistance + slack) return false;
  if (absf(z) > L.zoneHalfWidth + slack) return false;
  return Math.sqrt(u * u + z * z) <= L.zoneMaxDist + slack;
}

/**
 * Plan a claim of the airborne loose ball (first predicted sample in the claim zone, above claimMinY and within his
 * reach, that he can get under in time; never a goal-bound flight; never before a teammate's own attempt on the same
 * flight). Fills CLAIM.
 */
function claimPlan(s: SimState, team: number, k: number): boolean {
  const b = s.ball;
  if (b.grounded === 1) return false;
  // An opponent's shot (a chip, a looping header) is GKP-02's save, never a claim.
  if (validSlot(b.shotBy) && s.players[b.shotBy]!.team !== team) return false;
  const sp2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (!(sp2 >= L.claimMinSpeed * L.claimMinSpeed)) return false;
  // Apex below the claim height: never high enough.
  const apex = b.vy > 0 ? b.y + (b.vy * b.vy) / (2 * T_BALL.gravity) : b.y;
  if (!(apex >= L.claimMinY)) return false;
  const dir = s.teams[team]!.dir;
  // Outside the claim zone and moving away from it: no cross for him (skips the prediction).
  const bu = depthOf(dir, b.x);
  if (bu > L.claimZoneDepth || absf(b.z) > L.claimZoneHalfWidth) {
    // (velocity . (zone centre - ball)) in (depth, z) coordinates; the depth velocity is dir * vx.
    if (dir * b.vx * (L.claimZoneDepth * 0.5 - bu) - b.vz * b.z <= 0) return false;
  }
  const p = s.players[k]!;
  const a = s.attrs[k]!;
  claimTopF(a);
  const top = F[F_TOP]!;
  const speed = topOf(a);
  predictBall(b, L.claimHorizon, PRED);
  const n = PRED.count;
  let found = -1;
  for (let i = 0; i < n; i++) {
    const x = PRED.x[i]!, y = PRED.y[i]!, z = PRED.z[i]!;
    const u = depthOf(dir, x);
    if (u < -BALL_RADIUS) {
      // Over his goal line: goal-bound flights are GKP-02's saves; anything else is out of play.
      if (absf(z) < GOAL_HALF_WIDTH && y < GOAL_HEIGHT) return false;
      break;
    }
    if (absf(x) > HALF_LENGTH + BALL_RADIUS || absf(z) > HALF_WIDTH + BALL_RADIUS) break;
    if (found >= 0) continue;
    if (u < L.claimMinDepth || u > L.claimZoneDepth || absf(z) > L.claimZoneHalfWidth) continue;
    if (y < L.claimMinY || y > top) continue;
    // On the ground until take-off, then a leap of up to claimLeapPlanFrac x top speed to the spot.
    const dx = x - p.x, dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const air = i + 1 < L.takeoffTicks ? i + 1 : L.takeoffTicks;
    const need = d - L.claimPlanReach - speed * L.claimLeapPlanFrac * air * DT;
    if (need > 0) {
      const ground = i + 1 - air;
      if (ground <= 0 || (need - T_PLAYER.arriveStop) / speed * TICK_HZ > ground) continue;
      if (ticksToReach(s, k, p.x + (dx / d) * need, p.z + (dz / d) * need) > ground) continue;
    }
    found = i;
    CLAIM.x = x; CLAIM.y = y; CLAIM.z = z;
  }
  if (found < 0) return false;
  // Never fight a defender: a teammate already going up for this flight before the keeper keeps it.
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === k) continue;
    const m = s.players[i]!;
    if (m.active !== 1 || (m.act !== ActionKind.HEADER && m.act !== ActionKind.VOLLEY)) continue;
    if (m.actB !== b.lastTouchTick) continue;
    if (m.actContact - m.actT <= found + 1) return false;
  }
  CLAIM.i = found;
  return true;
}

/**
 * The come-out decision for keeper k. keep = 1: an AI rush is in progress (looser thresholds; no new claim).
 * Returns DEC_NONE / DEC_BALL / DEC_1V1 / DEC_CLAIM and fills DEC / decSlot (or CLAIM).
 */
function assess(s: SimState, team: number, k: number, keep: number): number {
  const b = s.ball;
  if (b.heldBy >= 0 || b.inNet !== 0) return DEC_NONE;
  const dir = s.teams[team]!.dir;
  if (b.owner >= 0) {
    if (!validSlot(b.owner) || s.players[b.owner]!.team === team) return DEC_NONE;
    F[F_TX] = b.x; F[F_TZ] = b.z;
    return oneOnOne(s, team, k, b.owner, keep) ? DEC_1V1 : DEC_NONE;
  }
  // Our own pass in flight to a teammate (a back-pass to him included) is the receiver's ball.
  const pt = b.passTarget;
  if (b.lastKickTeam === team && b.lastTouchTeam === team && validSlot(pt) && s.players[pt]!.team === team) {
    return DEC_NONE;
  }
  const u = depthOf(dir, b.x);
  const vg = -dir * b.vx;
  if (u > L.prefilterDepth && !(vg > 0 && u - vg * L.prefilterSeconds <= T_GK.rushDistance)) return DEC_NONE;
  if (keep === 0 && claimPlan(s, team, k)) return DEC_CLAIM;
  if (keep === 0 && opponentShot(s, team) && b.vx * b.vx + b.vz * b.vz > L.shotRushMaxSpeed * L.shotRushMaxSpeed) return DEC_NONE;
  if (!race(s, team, k, keep)) return DEC_NONE;
  const kT = RACE.kT;
  // [QF-2] A start also needs the point startMinDepth in front of his line (a ball he can only meet on the line as it
  // rolls out is GKP-01's: such starts aborted the next tick, over and over).
  if (inZone(dir, keep === 1 ? L.zoneKeepSlack : 0) && (keep === 1 || depthOf(dir, RACE.kX) >= L.startMinDepth)) {
    const ok = keep === 1
      ? !(RACE.mateT + L.mateAbortMargin < kT) && !(RACE.oppT + L.oppAbortMargin < kT)
      : kT + L.mateStartMargin <= RACE.mateT && kT + L.oppStartMargin <= RACE.oppT;
    if (ok) {
      decSlot = -1; DEC.x = RACE.kX; DEC.z = RACE.kZ;
      return DEC_BALL;
    }
  }
  // An opponent wins the race to the loose ball ahead of every teammate: a one-on-one at his interception point.
  // [QF-2] With hysteresis against the nearest teammate: a start needs the opponent there oneOnOneMateStart ticks
  // first, a one-on-one under way ends only when a teammate is there oneOnOneMateKeep ticks first (an opponent and a
  // covering defender converging on a pass within a tick of each other flipped it every other tick).
  const mateEdge = keep === 1 ? L.oneOnOneMateKeep : -L.oneOnOneMateStart;
  if (RACE.opp >= 0 && RACE.oppT < kT && RACE.oppT < RACE.mateT + mateEdge) {
    F[F_TX] = RACE.oppX; F[F_TZ] = RACE.oppZ;
    if (oneOnOne(s, team, k, RACE.opp, keep)) return DEC_1V1;
  }
  return DEC_NONE;
}

// ---------------------------------------------------------------- starts

function beginRush(s: SimState, slot: number, mode: number, tx: number, tz: number, att: number): void {
  const p = s.players[slot]!;
  beginAction(p, ActionKind.GK_RUSH, L.rushMaxTicks, -1);
  p.actA = mode;
  p.actB = P_RUN;
  p.actX = tx; p.actZ = tz;
  p.actDirX = 0; p.actDirZ = 0;
  p.actSlot = att;
  p.actCurve = 0;
  p.actPower = 0;
  p.actKick = KickKind.NONE;
}

function beginClaim(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const contact = CLAIM.i + 1;
  beginAction(p, ActionKind.GK_PUNCH, contact + L.claimLateTicks + L.claimLandTicks, contact);
  p.actX = CLAIM.x; p.actZ = CLAIM.z;
  p.actCurve = CLAIM.y;
  p.actA = 0;
  p.actB = s.ball.lastTouchTick;
  p.actDirX = 0; p.actDirZ = 0;
  p.actSlot = -1;
  p.actPower = 0;
  p.actKick = KickKind.NONE;
}

/**
 * Keeper come-out brain for team's keeper (keeper pipeline, after the save decision): start a rush / one-on-one /
 * claim from a free AI keeper, re-assess an AI rush in progress (switch between ball and one-on-one, or abort so
 * GKP-01 positioning takes him back). User rushes and committed actions (smother, claims) are left to the handlers.
 */
export function keeperComeOut(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team];
  if (!t) return;
  const k = t.keeperSlot;
  if (!validSlot(k)) return;
  const p = s.players[k]!;
  if (p.active !== 1 || p.isKeeper !== 1) return;
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const act = p.act;
  if (act === ActionKind.GK_RUSH) {
    if (p.actB !== P_RUN) return;
    if (p.actA !== M_BALL && p.actA !== M_1V1) return;
    if (isHumanSlot(s, k)) { endAction(s, k, 1); return; }
    // The user's rush hold takes over an AI rush (the resolver only starts a rush from a free keeper). Only while the
    // opponents have the ball: then THROUGH can mean nothing but "rush the keeper" for his team.
    const o = s.ball.owner;
    if (validSlot(o) && s.players[o]!.team !== team && s.ball.heldBy < 0 && keeperRushHeld(s, team)) {
      p.actA = M_HOLD;
      p.actPower = p.actT;
      return;
    }
    const d = assess(s, team, k, 1);
    if (d === DEC_BALL) {
      if (p.actA !== M_BALL) { p.actA = M_BALL; p.actPower = p.actT; }
      p.actSlot = -1;
    } else if (d === DEC_1V1) {
      if (p.actA !== M_1V1) { p.actA = M_1V1; p.actPower = p.actT; }
      p.actSlot = decSlot;
    } else {
      endAction(s, k, 1);
    }
    return;
  }
  if (act !== ActionKind.NONE || p.stunT > 0) return;
  if (isHumanSlot(s, k)) return;
  const d = assess(s, team, k, 0);
  if (d === DEC_BALL) beginRush(s, k, M_BALL, DEC.x, DEC.z, -1);
  else if (d === DEC_1V1) beginRush(s, k, M_1V1, DEC.x, DEC.z, decSlot);
  else if (d === DEC_CLAIM) beginClaim(s, k);
}

/**
 * [QF-2] True when GKP-03 itself would start a come-out (a race for a loose ball or a one-on-one) for team's free AI
 * keeper now. TAI-11's CPU brain asks before it holds keeper-rush, so it never restarts (as a held user rush) a
 * come-out GKP-03 has just aborted: the two used to alternate on consecutive ticks. Pure (module scratch only).
 */
function comeOutWantedImpl(s: SimState, team: number): boolean {
  const t = s.teams[team];
  if (!t || s.match.phase !== MatchPhase.IN_PLAY) return false;
  const k = t.keeperSlot;
  if (!validSlot(k)) return false;
  const p = s.players[k]!;
  if (p.active !== 1 || p.isKeeper !== 1 || !isFree(p) || p.stunT > 0) return false;
  const d = assess(s, team, k, 0);
  return d === DEC_BALL || d === DEC_1V1;
}

/** Start a rush (user hold or AI). Returns 1 if started. */
export function startKeeperRush(s: SimState, slot: number, ev: EventSink): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.isKeeper !== 1 || p.stunT > 0) return 0;
  if (s.match.phase !== MatchPhase.IN_PLAY) return 0;
  const b = s.ball;
  if (b.heldBy >= 0 || b.inNet !== 0) return 0;
  if (b.owner >= 0 && (!validSlot(b.owner) || s.players[b.owner]!.team === p.team)) return 0;
  const mode = keeperRushHeld(s, p.team) ? M_HOLD : M_TIMED;
  if (p.act === ActionKind.GK_RUSH) {
    // Already out: the user's rush takes over an AI rush (a committed smother just carries on).
    if (p.actA !== mode && p.actB === P_RUN) { p.actA = mode; p.actPower = p.actT; }
    return 1;
  }
  if (!isFree(p)) return 0;
  beginRush(s, slot, mode, b.x, b.z, b.owner);
  return 1;
}

// ---------------------------------------------------------------- ball contacts

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
  applyKick(s, k, LAUNCH, 1, ev);
  if (b.y > BALL_RADIUS + 1e-6 || vy > 0.5) b.grounded = 0;
}

/** First-time clearance: long and high, away from goal toward the nearer touchline. */
function clearance(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  const dir = s.teams[p.team]!.dir;
  const b = s.ball;
  const side = b.z > 0 ? 1 : b.z < 0 ? -1 : (p.fz >= 0 ? 1 : -1);
  let hx = dir, hz = side * L.clearSide;
  const hl = Math.sqrt(hx * hx + hz * hz);
  hx /= hl; hz /= hl;
  const sp = attr(s.attrs[k]!.gkKicking, L.clearSpeedWorst, L.clearSpeedBest);
  const c = dcos(L.clearAngle), sn = dsin(L.clearAngle);
  launch(s, k, hx * sp * c, sp * sn, hz * sp * c, KickKind.CLEARANCE, ev);
}

/** Ball off the keeper's body / hands away from goal (DEFLECTION). (ux, uz) = his push direction. */
function blockAway(s: SimState, k: number, ux: number, uz: number, ev: EventSink): void {
  const p = s.players[k]!;
  const dir = s.teams[p.team]!.dir;
  const b = s.ball;
  const sp0 = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  let sp = sp0 * L.smotherBlockKeep;
  if (sp < L.smotherBlockSpeed) sp = L.smotherBlockSpeed;
  // Away from goal, sideways along his push / the ball's lateral side.
  const side = uz > 0.1 ? 1 : uz < -0.1 ? -1 : (b.z >= p.z ? 1 : -1);
  let hx = dir + ux * 0.5, hz = side * 0.7 + uz * 0.5;
  if (dir * hx < 0.3) hx = dir * 0.3;
  const hl = Math.sqrt(hx * hx + hz * hz);
  hx /= hl; hz /= hl;
  launch(s, k, hx * sp, L.smotherBlockLift, hz * sp, KickKind.DEFLECTION, ev);
}

/**
 * Rush contact with a loose ball passing within collectReach of his body this tick: hands (keeperPickUp), first-time
 * clearance / block under pressure, or leave an unpressured ball to SIM-06 at his feet. Returns 1 if the rush is over
 * (the action was ended or replaced).
 */
function tryCollect(s: SimState, k: number, ev: EventSink): number {
  const b = s.ball;
  const p = s.players[k]!;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return 0;
  if (ballTouchedThisTick(s) || p.noTouchT > 0) return 0;
  if (b.lastTouch === k && b.lastTouchTick >= 0 && s.tick - b.lastTouchTick < L.recontactTicks) return 0;
  // Closest approach of this tick's ball path to his body axis.
  const x0 = b.x, y0 = b.y, z0 = b.z;
  const dx = b.vx * DT, dy = b.vy * DT, dz = b.vz * DT;
  const l2 = dx * dx + dz * dz;
  let tt = l2 > EPS ? ((p.x - x0) * dx + (p.z - z0) * dz) / l2 : 0;
  if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
  const cx = x0 + dx * tt, cy = y0 + dy * tt, cz = z0 + dz * tt;
  const hx = cx - p.x, hz = cz - p.z;
  const dh = Math.sqrt(hx * hx + hz * hz);
  if (!(dh <= L.collectReach)) return 0;
  const a = s.attrs[k]!;
  claimTopF(a);
  if (cy > F[F_TOP]!) return 0;
  const team = p.team;
  const vx = b.vx, vy = b.vy, vz = b.vz;
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  F[F_LIMY] = cy;
  catchLimitF(a);
  if (sp <= F[F_LIM]! && canHandle(s, k)) {
    const shot = onTargetShot(s, team);
    const px = b.x, py = b.y, pz = b.z;
    placeBall(s, cx, cy, cz);
    keeperPickUp(s, k, ev);
    if (b.heldBy === k) {
      if (shot) ev.emit(EventType.SAVE, k, SaveKind.CATCH, sp, 0, cx, cy, cz);
      return 1;
    }
    b.x = px; b.y = py; b.z = pz;
    b.vx = vx; b.vy = vy; b.vz = vz;
  }
  if (cy > L.footTop) return 0;
  F[F_QX] = cx; F[F_QZ] = cz; F[F_QR] = L.clearPressureDist;
  const pressured = nearestOpponentWithin(s, team) >= 0;
  if (!pressured && sp <= L.feetPickUpMaxSpeed) {
    // Nobody near: let SIM-06 give him the ball at his feet once it is within control range.
    if (dh <= T_DRIBBLE.controlRadius * 0.9 && cy <= T_DRIBBLE.controlHeight) {
      endAction(s, k, 0);
      return 1;
    }
    return 0;
  }
  const shot = onTargetShot(s, team);
  placeBall(s, cx, cy, cz);
  if (sp <= L.clearMaxIncoming) {
    clearance(s, k, ev);
    p.actKick = KickKind.CLEARANCE;
  } else {
    blockAway(s, k, -hx / (dh > EPS ? dh : 1), -hz / (dh > EPS ? dh : 1), ev);
    p.actKick = KickKind.DEFLECTION;
    if (shot) ev.emit(EventType.SAVE, k, SaveKind.BLOCK, sp, 0, cx, cy, cz);
  }
  p.actDone = 1;
  p.noTouchT = L.playNoTouchTicks;
  endAction(s, k, 0);
  return 1;
}

/** Nearest active opponent of team to (F_QX, F_QZ) within F_QR (ties: lower slot), or -1. */
function nearestOpponentWithin(s: SimState, team: number): number {
  const x = F[F_QX]!, z = F[F_QZ]!, r = F[F_QR]!;
  const r2 = r * r;
  let best = 1e18;
  let who = -1;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const q = s.players[i]!;
    if (q.active !== 1 || q.team === team) continue;
    const dx = q.x - x, dz = q.z - z;
    const d = dx * dx + dz * dz;
    if (d <= r2 && d < best) { best = d; who = i; }
  }
  return who;
}

/** Should the running keeper go down at the ball now? Sets smotherVictim. */
function smotherWanted(s: SimState, k: number): boolean {
  const b = s.ball;
  const p = s.players[k]!;
  smotherVictim = -1;
  if (b.heldBy >= 0 || b.inNet !== 0 || b.y > L.smotherMaxY) return false;
  if (ballTouchedThisTick(s) || p.noTouchT > 0) return false;
  const dx = b.x - p.x, dz = b.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d <= L.smotherStartDist)) return false;
  let att: number;
  if (b.owner >= 0) {
    if (!validSlot(b.owner) || s.players[b.owner]!.team === p.team) return false;
    att = b.owner;
  } else {
    F[F_QX] = b.x; F[F_QZ] = b.z; F[F_QR] = L.smotherContestDist;
    att = nearestOpponentWithin(s, p.team);
    if (att < 0) return false;
  }
  const q = s.players[att]!;
  const ax = q.x - p.x, az = q.z - p.z;
  if (Math.sqrt(ax * ax + az * az) + L.smotherBehindSlack < d) return false; // the ball is beyond his body
  smotherVictim = att;
  return true;
}

function startSmother(s: SimState, k: number): void {
  const p = s.players[k]!;
  const b = s.ball;
  const lead = L.smotherWindupTicks * DT;
  let ux = b.x + b.vx * lead - p.x, uz = b.z + b.vz * lead - p.z;
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > EPS)) { ux = p.fx; uz = p.fz; ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > EPS)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  p.actB = P_SMOTHER;
  p.actCurve = p.actT;
  p.actContact = p.actT + L.smotherWindupTicks;
  p.actX = p.x; p.actZ = p.z;
  p.actDirX = ux / ul; p.actDirZ = uz / ul;
  p.actSlot = smotherVictim;
  p.actDone = 0;
  p.actDur = p.actContact + L.smotherWindowTicks + L.smotherDownTicks + L.smotherGetUpTicks;
  p.moveMode = MoveMode.LOCKED;
  p.vx = 0; p.vz = 0; p.ix = 0; p.iz = 0;
  p.lookAt = 0;
  p.wantSprint = 0;
  p.fx = p.actDirX; p.fz = p.actDirZ;
}

/** The smother won the ball (closest point (cx, cy, cz) of its path): hands inside the area, else push it away. */
function smotherWin(s: SimState, k: number, cx: number, cy: number, cz: number, ev: EventSink): void {
  const p = s.players[k]!;
  const team = p.team;
  const b = s.ball;
  const victim = validSlot(b.owner) && s.players[b.owner]!.team !== team ? b.owner : -1;
  const shot = onTargetShot(s, team);
  if (b.owner >= 0) releasePossession(s, ev);
  if (victim >= 0) {
    const v = s.players[victim]!;
    if (v.noTouchT < T_DRIBBLE.dispossessedNoTouch) v.noTouchT = T_DRIBBLE.dispossessedNoTouch;
  }
  const vx = b.vx, vy = b.vy, vz = b.vz;
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  placeBall(s, cx, cy, cz);
  F[F_LIMY] = cy;
  catchLimitF(s.attrs[k]!);
  if (sp <= F[F_LIM]! && canHandle(s, k)) {
    keeperPickUp(s, k, ev);
    if (b.heldBy === k) {
      if (victim >= 0) ev.emit(EventType.TACKLE, k, victim, 1, ChallengeKind.KEEPER, cx, cy, cz);
      if (shot) ev.emit(EventType.SAVE, k, SaveKind.CATCH, sp, 0, cx, cy, cz);
      return;
    }
    b.vx = vx; b.vy = vy; b.vz = vz;
  }
  blockAway(s, k, p.actDirX, p.actDirZ, ev);
  if (victim >= 0) ev.emit(EventType.TACKLE, k, victim, 1, ChallengeKind.KEEPER, cx, cy, cz);
  if (shot) ev.emit(EventType.SAVE, k, SaveKind.BLOCK, sp, 0, cx, cy, cz);
  p.actDone = 1;
  p.actKick = KickKind.DEFLECTION;
  p.noTouchT = L.playNoTouchTicks;
  goDown(s, k);
}

/**
 * After the contact window he is on the ground: a GKP-02 low dive along the lunge with no hip travel (TAI-07 then
 * stops counting him as the chaser, GKP-02 does not re-plan a save from the ground, his lying body still blocks, and
 * the dive always ends with a get-up). Falls back to the GK_RUSH DOWN phase if the dive is refused.
 */
function goDown(s: SimState, k: number): void {
  const p = s.players[k]!;
  const tx = p.x + p.actDirX * L.smotherDownReach, tz = p.z + p.actDirZ * L.smotherDownReach;
  if (startKeeperDive(s, k, tx, BALL_RADIUS, tz) === 1) return;
  if (p.act === ActionKind.GK_RUSH) p.actB = P_DOWN;
}

/** Missed smother: body contact with the attacker is a KEEPER challenge for RUL-09 (ball not played first). */
function smotherMiss(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  p.actDone = 2;
  const v = p.actSlot;
  if (validSlot(v)) bodyChallenge(s, k, v, ev);
  goDown(s, k);
}

/** Record a KEEPER challenge (ball not played first) when attacker v's body is against the lunging keeper. */
function bodyChallenge(s: SimState, k: number, v: number, ev: EventSink): void {
  const p = s.players[k]!;
  const q = s.players[v]!;
  if (q.active !== 1 || q.team === p.team) return;
  const hx = p.x + p.actDirX * L.smotherHandReach, hz = p.z + p.actDirZ * L.smotherHandReach;
  F[F_PX] = q.x; F[F_PZ] = q.z; F[F_AX] = p.x; F[F_AZ] = p.z; F[F_BX] = hx; F[F_BZ] = hz;
  distPointSeg();
  if (F[F_DIST]! > L.smotherBodyContact) return;
  REC.active = 1;
  REC.tackler = k;
  REC.victim = v;
  REC.kind = ChallengeKind.KEEPER;
  REC.ballFirst = 0;
  REC.fromBehind = p.actDirX * q.fx + p.actDirZ * q.fz;
  const cl = L.smotherLungeSpeed - (q.vx * p.actDirX + q.vz * p.actDirZ);
  REC.closingSpeed = cl > 0 ? cl : 0;
  REC.x = q.x; REC.z = q.z;
  REC.tick = s.tick;
  pushChallenge(s, REC);
  ev.emit(EventType.TACKLE, k, v, 0, ChallengeKind.KEEPER, q.x, 0, q.z);
}

/** SMOTHER / DOWN phases: homing lunge on the ground, the contact window, then down and up. */
function smotherTick(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  const b = s.ball;
  const dir = s.teams[p.team]!.dir;
  const windowEnd = p.actContact + L.smotherWindowTicks;
  if (p.actB === P_SMOTHER && p.actDone === 0 && p.actT <= windowEnd) {
    // Hip homes on the ball (hands on it) at the lunge speed, within lungeMax of the lunge start.
    let ux = b.x - p.x, uz = b.z - p.z;
    const ul = Math.sqrt(ux * ux + uz * uz);
    if (ul > 0.05) { ux /= ul; uz /= ul; p.actDirX = ux; p.actDirZ = uz; } else { ux = p.actDirX; uz = p.actDirZ; }
    let want = ul - L.smotherHandReach * 0.5;
    if (want < 0) want = 0;
    const stepMax = L.smotherLungeSpeed * DT;
    if (want > stepMax) want = stepMax;
    let nx = p.x + ux * want, nz = p.z + uz * want;
    const ox = nx - p.actX, oz = nz - p.actZ;
    const od = Math.sqrt(ox * ox + oz * oz);
    if (od > L.smotherLungeMax) {
      nx = p.actX + (ox / od) * L.smotherLungeMax;
      nz = p.actZ + (oz / od) * L.smotherLungeMax;
    }
    if (depthOf(dir, nx) < L.minDepth) nx = xOfDepth(dir, L.minDepth);
    const mx = BOARD_X - T_PLAYER.bodyRadius, mz = BOARD_Z - T_PLAYER.bodyRadius;
    if (nx > mx) nx = mx; else if (nx < -mx) nx = -mx;
    if (nz > mz) nz = mz; else if (nz < -mz) nz = -mz;
    if (isFiniteNum(nx) && isFiniteNum(nz)) { p.x = nx; p.z = nz; }
  }
  p.vx = 0; p.vz = 0; p.ix = 0; p.iz = 0;
  p.moveMode = MoveMode.LOCKED;
  p.lookAt = 0;
  p.wantSprint = 0;
  p.fx = p.actDirX; p.fz = p.actDirZ;
  if (p.actB !== P_SMOTHER || p.actDone !== 0) return;
  if (p.actT >= p.actContact && p.actT <= windowEnd && b.heldBy < 0 && b.inNet === 0 && !ballTouchedThisTick(s) &&
    !(b.lastTouch === k && s.tick - b.lastTouchTick < L.recontactTicks)) {
    const hx = p.x + p.actDirX * L.smotherHandReach, hz = p.z + p.actDirZ * L.smotherHandReach;
    const yc = b.y < L.smotherMaxY ? (b.y > BALL_RADIUS ? b.y : BALL_RADIUS) : L.smotherMaxY;
    ballPathIn(s);
    SEGIN[6] = p.x; SEGIN[7] = yc; SEGIN[8] = p.z; SEGIN[9] = hx; SEGIN[10] = yc; SEGIN[11] = hz;
    segSeg();
    const r = L.smotherHandRadius + BALL_RADIUS;
    if (SEG.d2 <= r * r && SEG.ay <= L.smotherMaxY + L.smotherHandRadius) {
      smotherWin(s, k, SEG.ax, SEG.ay, SEG.az, ev);
      return;
    }
  }
  if (p.actT >= windowEnd) smotherMiss(s, k, ev);
}

// ---------------------------------------------------------------- GK_RUSH handler

/** Run target for the RUN phase into TGT (pitch coords, clamped). */
function runTarget(s: SimState, k: number): void {
  const p = s.players[k]!;
  const b = s.ball;
  const dir = s.teams[p.team]!.dir;
  if (p.actA === M_1V1) {
    F[F_TX] = b.x; F[F_TZ] = b.z;
    narrowCore(dir);
  } else if (b.owner >= 0) {
    const lead = L.userLeadSeconds;
    F[F_CX] = b.x + b.vx * lead; F[F_CZ] = b.z + b.vz * lead;
  } else {
    estimateIntercept(s, k, EST);
    const ok = isFiniteNum(EST.x) && isFiniteNum(EST.z);
    F[F_CX] = ok ? EST.x : b.x; F[F_CZ] = ok ? EST.z : b.z;
  }
  clampTarget(dir);
}

function rushUpdate(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  if (s.match.phase !== MatchPhase.IN_PLAY || p.isKeeper !== 1) { endAction(s, k, 1); return; }
  if (p.actB === P_SMOTHER || p.actB === P_DOWN) { smotherTick(s, k, ev); return; }
  const b = s.ball;
  const team = p.team;
  if (b.heldBy >= 0 || b.inNet !== 0 || (b.owner >= 0 && (!validSlot(b.owner) || s.players[b.owner]!.team === team))) {
    endAction(s, k, 0);
    return;
  }
  const mode = p.actA;
  if (mode === M_HOLD || mode === M_TIMED) {
    const since = p.actT - p.actPower;
    if (mode === M_HOLD ? since >= L.userMinTicks && !keeperRushHeld(s, team) : since >= L.userTimedTicks) {
      endAction(s, k, 0);
      return;
    }
  } else if (isHumanSlot(s, k)) {
    endAction(s, k, 1);
    return;
  }
  if (b.owner < 0 && tryCollect(s, k, ev) === 1) return;
  if (smotherWanted(s, k)) {
    startSmother(s, k);
    smotherTick(s, k, ev);
    return;
  }
  runTarget(s, k);
  const a = s.attrs[k]!;
  const dx = TGT.x - p.x, dz = TGT.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const bx = b.x - p.x, bz = b.z - p.z;
  const db = Math.sqrt(bx * bx + bz * bz);
  p.actX = TGT.x; p.actZ = TGT.z;
  if (d > EPS) { p.actDirX = dx / d; p.actDirZ = dz / d; } else { p.actDirX = 0; p.actDirZ = 0; }
  p.moveMode = MoveMode.ARRIVE;
  p.tgtX = TGT.x;
  p.tgtZ = TGT.z;
  p.tgtSpeed = topOf(a);
  p.wantSprint = d > L.sprintDist ? 1 : 0;
  // Face the ball when set close to it (shuffle); run facing the run otherwise (a keeper's lookAt caps his speed).
  p.lookAt = (mode === M_1V1 && d <= L.faceDist) || db <= L.smotherStartDist ? 1 : 0;
  p.lookX = b.x;
  p.lookZ = b.z;
}

function settle(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.lookAt = 0;
  p.wantSprint = 0;
  p.ix = 0; p.iz = 0;
  if (p.moveMode === MoveMode.LOCKED || p.moveMode === MoveMode.ARRIVE) p.moveMode = MoveMode.STOP;
}

function rushEnd(s: SimState, slot: number, interrupted: number): void {
  settle(s, slot);
}

// ---------------------------------------------------------------- GK_PUNCH handler

/** Punch the ball away from goal, toward the side it travels (or lies on). */
function punch(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  const dir = s.teams[p.team]!.dir;
  const b = s.ball;
  const side = b.vz > 1 ? 1 : b.vz < -1 ? -1 : b.z >= 0 ? 1 : -1;
  const hx = dir * dcos(L.punchAngle), hz = side * dsin(L.punchAngle);
  const a = s.attrs[k]!;
  const sp = attr((a.strength + a.gkHandling) * 0.5, L.punchSpeedWorst, L.punchSpeedBest);
  p.actDirX = hx; p.actDirZ = hz;
  launch(s, k, hx * sp, L.punchLift, hz * sp, KickKind.GK_PUNCH, ev);
}

/** Claim contact at the closest point (cx, cy, cz): catch when uncontested, slow enough and held, else punch. */
function claimContact(s: SimState, k: number, cx: number, cy: number, cz: number, ev: EventSink): void {
  const p = s.players[k]!;
  const team = p.team;
  p.vx *= L.claimLandVelKeep; p.vz *= L.claimLandVelKeep;
  const b = s.ball;
  const a = s.attrs[k]!;
  const shot = onTargetShot(s, team);
  const vx = b.vx, vy = b.vy, vz = b.vz;
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  placeBall(s, cx, cy, cz);
  F[F_QX] = cx; F[F_QZ] = cz; F[F_QR] = L.contestRadius;
  const contested = nearestOpponentWithin(s, team) >= 0;
  F[F_LIMY] = cy;
  catchLimitF(a);
  if (!contested && sp <= F[F_LIM]! && canHandle(s, k) &&
    rngFloat(s.rng) < attr(a.gkHandling, L.claimCatchWorst, L.claimCatchBest)) {
    keeperPickUp(s, k, ev);
    if (b.heldBy === k) {
      if (shot) ev.emit(EventType.SAVE, k, SaveKind.CATCH, sp, 0, cx, cy, cz);
      return;
    }
    b.vx = vx; b.vy = vy; b.vz = vz;
  }
  punch(s, k, ev);
  p.actDone = 1;
  p.actKick = KickKind.GK_PUNCH;
  p.noTouchT = L.playNoTouchTicks;
  if (shot) ev.emit(EventType.SAVE, k, SaveKind.PUNCH, sp, 0, cx, cy, cz);
}

function punchUpdate(s: SimState, k: number, ev: EventSink): void {
  const p = s.players[k]!;
  if (s.match.phase !== MatchPhase.IN_PLAY || p.isKeeper !== 1) { endAction(s, k, 1); return; }
  const b = s.ball;
  const takeoff = p.actContact - L.takeoffTicks;
  const windowEnd = p.actContact + L.claimLateTicks;
  if (p.actDone === 0) {
    const flight = b.owner < 0 && b.heldBy < 0 && b.inNet === 0 && b.lastTouchTick === p.actB;
    if (!flight) {
      if (p.actT < takeoff) { endAction(s, k, 1); return; }
      p.actDone = 2;
      const land = p.actT + L.claimLandTicks;
      if (land < p.actDur) p.actDur = land;
    }
  }
  if (p.actT < takeoff && p.actDone === 0) {
    const dx = p.actX - p.x, dz = p.actZ - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    p.moveMode = MoveMode.ARRIVE;
    p.tgtX = p.actX;
    p.tgtZ = p.actZ;
    p.tgtSpeed = topOf(s.attrs[k]!);
    p.wantSprint = d > L.sprintDist ? 1 : 0;
    p.lookAt = d <= 1 ? 1 : 0;
    p.lookX = b.x;
    p.lookZ = b.z;
  } else {
    // In the air: at take-off he leaps toward the claim spot to meet the ball at the planned contact; the leap
    // speed is kept until the contact (or the end of the window), then only locomotion friction (landing).
    p.moveMode = MoveMode.LOCKED;
    p.ix = 0; p.iz = 0;
    p.lookAt = 0;
    p.wantSprint = 0;
    if (p.actA === 0) {
      p.actA = 1;
      const left = p.actContact - p.actT > 1 ? p.actContact - p.actT : 1;
      const dx = p.actX - p.x, dz = p.actZ - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      let v = d / (left * DT);
      const cap = topOf(s.attrs[k]!) * L.claimLeapMaxFrac;
      if (v > cap) v = cap;
      if (d > 0.05 && isFiniteNum(v)) { p.actDirX = dx / d; p.actDirZ = dz / d; p.actPower = v; } else {
        p.actDirX = 0; p.actDirZ = 0; p.actPower = 0;
      }
    }
    if (p.actDone === 0 && p.actT <= p.actContact) { p.vx = p.actDirX * p.actPower; p.vz = p.actDirZ * p.actPower; }
    const fx = b.x - p.x, fz = b.z - p.z;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 0.05 && p.actDone === 0) { p.fx = fx / fl; p.fz = fz / fl; }
  }
  if (p.actDone !== 0) return;
  if (p.actT >= p.actContact - L.claimEarlyTicks && p.actT <= windowEnd && !ballTouchedThisTick(s)) {
    claimTopF(s.attrs[k]!);
    ballPathIn(s);
    SEGIN[6] = p.x; SEGIN[7] = L.claimLowY; SEGIN[8] = p.z; SEGIN[9] = p.x; SEGIN[10] = F[F_TOP]!; SEGIN[11] = p.z;
    segSeg();
    const r = L.claimArmRadius + BALL_RADIUS;
    if (SEG.d2 <= r * r) {
      claimContact(s, k, SEG.ax, SEG.ay, SEG.az, ev);
      return;
    }
  }
  if (p.actT > windowEnd) {
    p.actDone = 2;
    p.vx *= L.claimLandVelKeep; p.vz *= L.claimLandVelKeep;
  }
}

function punchEnd(s: SimState, slot: number, interrupted: number): void {
  settle(s, slot);
}

bindSweeperImpl({ rushUpdate, rushEnd, punchUpdate, punchEnd, comeOutWanted: comeOutWantedImpl });

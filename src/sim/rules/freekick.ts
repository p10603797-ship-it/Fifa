/**
 * [RUL-05] Free kicks and walls - direct free kicks at the foul spot; wall of 2-5 by distance and angle placed 9.15 m away; aim, curl/dip, shoot/finesse/chip, ground pass, lob/cross, choose taker (SPRINT); defending - wall jump (THROUGH), wall charge (PASS), move wall (SHIELD/SPRINT). WALL_JUMP handler.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 *
 * Implementation notes (RUL-05):
 *  - Setup (RUL-11 awardRestart calls it after filling s.match.restart): the ball rests on the foul spot, clamped
 *    LOCAL_TUNING.spotInset inside the touch and goal lines (never on a line) and, for the attackers, out of the
 *    opponents' goal area (onto its 5.5 m line, as RUL-11 does). Wall: freeKickWallCount = 0 (no wall) unless the ball
 *    is within wallMaxDist of the attacked goal centre and the goal mouth subtends at least wallMinAngle; then by
 *    the equivalent central distance f = goal width / mouth angle: 5 up to ~20 m, 4 to ~26 m, 3 to ~31 m, else 2
 *    (an angle makes f longer than the distance: fewer men). The wall stands RESTART_DISTANCE + wallDistExtra from the
 *    ball on a line perpendicular to the ball -> wall-centre direction: its outer edge lines up (from the ball) with a
 *    point wallPostCover outside the near post and it extends inward toward the goal centre (|ball z| < wallCentralZ:
 *    centred on the ball-goal line). A free kick less than 9.15 m from the goal line puts the wall on the goal line
 *    between the posts (RUL-11's goal-line exception); one whose wall would end within wallLineGap of the goal line
 *    gets no wall. Members: the wallCount nearest active outfield defenders to the wall centre (never the keeper;
 *    players who are down only if needed), ordered along p = (-uz, ux) (u = ball -> wall centre; TAI-13's slot order),
 *    neighbours spaced by their body-contact distance (SIM-05 bodyRadiusOf) + wallGap so bodies never overlap.
 *    restart.wall / wallCount / wallX / wallZ hold them. Taker: the best free-kick taker (curve + shotPower + longShots
 *    with a wall, shortPassing + longPassing + crossing otherwise) among active outfield players (the keeper only for a
 *    free kick in his own penalty area); down players avoided. Aim: the goal centre with a wall or within aimGoalMaxDist,
 *    else aimPassDist toward the goal.
 *  - Tick (RUL-01 calls it after RUL-11 restartTick): a member who becomes invalid (sent off, substituted into goal)
 *    re-picks the wall (keeping its sideways shift); at ready (restart.t = restartSetupTicks, hidden by the restart
 *    camera cut like RUL-11's legalisation) members snap onto their slots, afterwards they slide at most wallSlideStep
 *    per tick toward them (members further than the wall's half width + wallHoldExtra from the centre are left to
 *    TAI-13's walk) and face the ball. The waiting taker lines up behind the ball along the aim (lineUpStep per tick,
 *    inside RUL-11's reach); restart.aimPower mirrors the power bar while he charges; a side without a human takes the
 *    kick by Default cpuGraceTicks after T_RULES.cpuRestartDelay past ready (retried every cpuRetryTicks) if its CPU
 *    brain (TAI-13) has not, so RUL-11's 4 s CPU watchdog never fires. In the tick the kick is struck (restart.taken,
 *    ball.lastKickTick = tick) every free wall member starts WALL_JUMP BRACE and every ARMED member starts its CHARGE.
 *  - Input (SETPIECE_INPUT[FREE_KICK]; SIM-15 routes every controller's frame here during FREE_KICK), once ready:
 *    taking side, the controller holding the taker while he waits:
 *      SPRINT press = choose the taker: the next of the takerChoices best takers (cycling, wraps); the new taker and the
 *        old one swap places (the new one onto RUL-11's taker spot, in SET_PIECE; SIM-16 hands him the controller).
 *      Left stick (|stick| >= aimStickMin) aims by direction from the ball: a ray that meets the attacked goal line
 *        within GOAL_HALF_WIDTH + aimGoalSlack aims there (restart.aimX/aimZ on the goal line; only from within
 *        aimGoalMaxDist of the goal), otherwise the aim is the pitch point aimPassDist along it. The stick at rest keeps
 *        the aim.
 *      Right stick (beyond T_INPUT.stickIdle) changes the curl (restart.aimCurve, -1..1; positive bends toward the
 *        kicker's right, the InputFrame.curve convention) by its component across the aim at curlRate per second, and
 *        the dip (restart.side, -1..1: positive = topspin / dips sooner, negative = floats) by its component along the
 *        aim at dipRate; released, both keep their value. A non-zero frame.curve sets the curl directly (CPU, touch).
 *      SHOOT = SIM-11 startShot(FREE_KICK_SHOT), R1 + SHOOT = SHOT_FINESSE, L1 + SHOOT = SHOT_CHIP (L1 + R1 + SHOOT =
 *        FREE_KICK_SHOT with ReqFlag.DRIVEN); req.dir toward the aim, req.hasTarget = 1 with the aim point when it is on
 *        the goal line, req.curve = restart.aimCurve; power from the hold (charging: the resolver fills the bar) or the
 *        frame's explicit power. PASS = SIM-08 GROUND_PASS along the aim (R1: DRIVEN_PASS; L1: ReqFlag.PASS_AND_GO).
 *        LOB = SIM-09: a CROSS when its landing (the aim point, or for a goal aim the point of the aim ray lobLandDepth
 *        off the goal line) is in the attacked box (L1: LOFTED, L1 + R1: LOW_CROSS), else LOB_PASS along the aim (L1:
 *        HIGH_LOB, L1 + R1: DRIVEN_LOB). THROUGH = SIM-10 THROUGH_GROUND along the aim (L1: THROUGH_LOBBED).
 *      Touch: TAP / DOUBLE_TAP a teammate or a spot (like corners: in the attacked box (+crossAreaExtra for teammates) a
 *        CROSS, LOFTED on a double tap; else a GROUND_PASS up to tapGroundMax, a LOB_PASS beyond or on a double tap); a
 *        TAP flagged ON_GOAL = SHOT_CHIP there. SWIPE / CURVED_SWIPE / BACK_FORTH_SWIPE flagged FROM_BALL: toward the
 *        goal mouth (and within swipeShotMaxDist of the goal) = FREE_KICK_SHOT with power = gPower (a faster swipe is
 *        harder and higher), curl = gCurve, BACK_FORTH adds ReqFlag.DRIVEN; otherwise a cross like a corner swipe (the
 *        gesture point in the box, else the swipe ray's point in the box nearest the penalty spot; height band from
 *        gPower) or, when the ray misses the box, a GROUND_PASS / LOB_PASS along it by gPower. Every kick carries
 *        ReqFlag.SET_PIECE (+ GESTURE / CPU); each kick request first calls RUL-11 prepareTakerKick.
 *    defending side (any of its controllers), with a wall:
 *      THROUGH = wall jump: every free (or ARMED) member starts WALL_JUMP JUMP (jumpCrouchTicks crouch, jumpAirTicks
 *        in the air peaking at g * T^2 / 8 ~ 0.35 m, jumpLandTicks landing); WALL event per member.
 *      PASS = wall charge: free members go ARMED (braced, LOCKED) and CHARGE at the kick: chargeSpeed toward the ball
 *        spot for chargeTicks (stopping chargeStopDist from it); WALL event per member when the charge starts.
 *      SHIELD held / SPRINT held = move the wall sideways along +p / -p (the defenders' left / right as they face the
 *        ball) at wallMoveSpeed, around the ball (distance kept), at most wallMoveMax from its default centre.
 *      The controller's own player, when not in the wall, walks with the stick (never sprints: SPRINT moves the wall).
 *    Any other controller (a second human on the taking side) moves its free controlled player with the stick.
 *  - WALL_JUMP action (wallJumpHandler, ActionKind.WALL_JUMP): actA = WallMode (BRACE 0, JUMP 1, CHARGE 2, ARMED 3);
 *    actB = the current jump lift, m (render); actContact = take-off tick for a jump, else -1; actX/actZ = his wall slot
 *    (CHARGE: the ball spot he runs at); actDirX = the tick the free kick was struck (-1 before). The action keeps
 *    working in the IN_PLAY that follows the strike: RUL-01 clears restart.kind there, but the rest of the record
 *    (wall, taker, taken) stays until the next restart is awarded, which clears the wall (wallRecord). BRACE / JUMP /
 *    ARMED are MoveMode.LOCKED and still facing the ball; CHARGE is LOCKED with the velocity set every tick. ARMED
 *    waits (its budget extended) until the kick; BRACE lasts at most braceMaxTicks and ends as soon as the ball is past
 *    him (wallPassMargin), no longer approaching him, owned, held, in a net or touched by anyone but the taker / the
 *    wall, or his human pushes the stick beyond breakStick. A jump that lands while the struck ball is still coming at
 *    him turns into BRACE for the rest of that window.
 *    Blocking (each tick of a member's action once the kick is struck, before ballTick): the ball's path this tick (a
 *    copy stepped by SIM-02 ballStepTick, exactly the sim's) is swept against every member's body: a vertical cylinder
 *    of radius wallBlockRadius (neighbours' cylinders overlap: no ball-sized gaps) from his lift to lift + height
 *    (attrs.height). The earliest contact deflects the ball off him: placed at the contact point, the velocity relative
 *    to him reflected about the contact normal (horizontal; tilted up near the top of his head) with blockRestitution,
 *    the tangential part kept at 1 - blockFriction, spin x blockSpinKeep, through core/kick applyKick(KickKind.
 *    DEFLECTION) (KICK event; the shot in flight is cleared). Only while the ball is live from this free kick (last
 *    touched by the taker's kick of the strike tick or a wall deflection since), faster than blockMinSpeed. A jumping
 *    wall blocks higher balls and lets low ones through under it; a standing wall stops anything up to head height.
 *  - Default (RUL-11 calls it at the human timeout; also the CPU fallback): with a wall a FREE_KICK_SHOT over the wall
 *    to the inside of the post it covers (defaultPostInset), curling back in, power by distance; in the crossing zone a
 *    CROSS to the best header in the box (else the penalty-spot area); otherwise a pass to the best open teammate
 *    (GROUND_PASS up to tapGroundMax, LOB_PASS beyond); every failed start falls through to the next choice and finally
 *    a GROUND_PASS straight ahead, so a stub kick module never leaves the restart to the safety nets.
 *  - previewFlight(s, out, f?): the flight of the kick the taker would play now (the current aim and power, or the
 *    swipe in f for touch's in-progress gesture), for TCH-06 / GFX-13: the starter + the registry's KickSolver run on a
 *    private scratch copy of the state (fixed RNG seed, so the preview is steady), then SIM-01 predictBall from the
 *    launched ball: exactly the sim's flight for the same launch. While his kick winds up / charges, the live action.
 *    Falls back to an estimated launch when the kick module refuses (stub). Never touches `s`.
 * Restart fields used: wall / wallCount / wallX / wallZ; aimX / aimZ (aim point); aimCurve (curl -1..1); aimPower (power
 * bar mirror / last explicit power, 0..1); side = dip -1..1 (FREE_KICK only; SIM-11 may read it while restart.taker
 * strikes a FREE_KICK_SHOT: contract CR).
 * Per tick: O(5) wall upkeep, O(1) input, O(5) blocking (one ball step) during the ~0.75 s after the kick; taker /
 * wall choice O(11 x 11) only at setup / re-pick / SPRINT. Allocation-free (module scratch; doubles cross hot calls in
 * scratch, not as arguments, so V8 does not box them; no trig per tick). The preview's scratch state is cloned once,
 * then refreshed with FND-03 copyState (whose generic copy boxes doubles: the preview's only allocation).
 *
 * Helper module: freekickHooks.ts (import-cycle-safe WALL_JUMP handler shell, re-exported first below).
 */
// Re-export the handler shell FIRST (import-cycle safety with actions/registry; see freekickHooks.ts).
export { wallJumpHandler } from './freekickHooks';
import { bindWallJumpImpl } from './freekickHooks';
import {
  BALL_RADIUS, CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, DT, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH,
  HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM,
  RESTART_DISTANCE, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, GestureFlag, UNIT_SCALE, type InputFrame } from '../../contracts/input';
import { MoveMode, createBallState, type PlayerState, type SimState } from '../../contracts/state';
import {
  ReqFlag, createActionRequest, createKickLaunch, type ActionRequest, type BallPrediction, type KickLaunch,
} from '../../contracts/systems';
import { T_BALL, T_INPUT, T_PASS, T_PLAYER, T_RULES, T_SHOT } from '../../contracts/tuning';
import { beginAction, endAction } from '../actions/dispatch';
import { KICK_SOLVERS } from '../actions/registry';
import { ballStepTick } from '../ball/contact';
import {
  copyBallState, createLaunchSolution, curlSpinY, groundPassSpeed, launchSpin, predictBall, solveLaunchSpin,
} from '../ball/flight';
import { cloneState, copyState } from '../core/clone';
import { datan2, dcos, dsin } from '../core/dmath';
import { NULL_SINK } from '../core/events';
import { applyKick, ballTouchedThisTick, releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import type { V3 } from '../core/vec';
import { startLob } from '../kicks/lob';
import { startPass } from '../kicks/pass';
import { startShot } from '../kicks/shot';
import { startThrough } from '../kicks/through';
import { bodyRadiusOf } from '../players/bodies';
import { COMMON_TUNING, restartLookPoint } from './restartCommon';
import { LOCAL_TUNING as RESTART_TUNING, isValidTaker, prepareTakerKick, restartTakerSpot } from './restart';

/** TUNING-CR (RUL-05): proposed T_FREEKICK block (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  // ---------------------------------------------------------------- spot
  /** The ball rests at least this far inside the touch and goal lines, m (centre; > BALL_RADIUS: never on a line). */
  spotInset: 0.25,
  // ---------------------------------------------------------------- wall size and placement
  /** No wall beyond this distance from the attacked goal centre, m. */
  wallMaxDist: 35,
  /** No wall when the goal mouth subtends less than this from the ball, rad (tight angles: a cross). */
  wallMinAngle: 0.12,
  /** Wall count by the equivalent central distance f = GOAL_WIDTH / mouth angle (m; ~ the distance for a central
   *  kick, longer at an angle): 5 below wallEquiv5, 4 below wallEquiv4, 3 below wallEquiv3, else 2. */
  wallEquiv5: 20.5,
  wallEquiv4: 26.5,
  wallEquiv3: 31.5,
  /** The wall line stands this much beyond RESTART_DISTANCE from the ball, m. */
  wallDistExtra: 0.1,
  /** Members never closer to the ball than RESTART_DISTANCE + this, m. */
  wallDistSlack: 0.02,
  /** Gap between neighbouring members' bodies (SIM-05 contact distance + this), m. */
  wallGap: 0.02,
  /** The outer edge of the wall lines up with a point this far outside the near post, m. */
  wallPostCover: 0.4,
  /** |ball z| below this: the wall is centred on the ball-goal line, m. */
  wallCentralZ: 1.0,
  /** Goal-line wall (free kick closer than 9.15 m): members this far in front of the goal line, m (RUL-11's inset). */
  wallGoalLineInset: 0.45,
  /** Goal-line wall members stay this far inside the posts, m. */
  wallPostInside: 0.05,
  /** A normal wall whose centre would be closer than this to the goal line is not formed, m. */
  wallLineGap: 0.9,
  /** Members stay this far inside the touch and goal lines, m. */
  wallPitchMargin: 0.5,
  /** Members within (half the wall width + this) of the centre are slid into their slots; further ones walk (TAI-13), m. */
  wallHoldExtra: 2.0,
  /** Slide toward the slot per tick, m/tick (4.8 m/s). */
  wallSlideStep: 0.08,
  /** Sideways wall move (SHIELD / SPRINT): speed m/s and max shift of the centre from its default, m (arc). */
  wallMoveSpeed: 2.5,
  wallMoveMax: 3.0,
  // ---------------------------------------------------------------- wall actions
  /** Jump: crouch, airborne and landing ticks (0.7 s in all; airborne 0.53 s -> peak lift g T^2 / 8 = 0.35 m). */
  jumpCrouchTicks: 4,
  jumpAirTicks: 32,
  jumpLandTicks: 6,
  /** Braced wall after the kick: at most this long, ticks. */
  braceMaxTicks: 45,
  /** ARMED (charge ready) budget, extended while the kick is pending, ticks. */
  armedWaitTicks: 60,
  /** Charge: speed m/s for this many ticks, stopping this far from the ball spot, m. */
  chargeSpeed: 4.0,
  chargeTicks: 24,
  chargeStopDist: 3.0,
  /** A human pushing his braced wall member's stick beyond this (0..1) breaks him out of the wall. */
  breakStick: 0.5,
  // ---------------------------------------------------------------- blocking
  /** Body cylinder radius for the ball, m (>= half the member spacing minus BALL_RADIUS: no gaps). */
  wallBlockRadius: 0.33,
  /** Member height clamp (attrs.height / 100), m. */
  heightMin: 1.6,
  heightMax: 2.1,
  /** A contact this close below the top of the head tilts the normal upward, m. */
  topCapBand: 0.15,
  /** Normal restitution off a body, tangential speed lost, spin kept (fractions). */
  blockRestitution: 0.35,
  blockFriction: 0.4,
  blockSpinKeep: 0.3,
  /** Slower balls are left to SIM-06 / SIM-07, m/s. */
  blockMinSpeed: 3.0,
  /** BRACE ends once the ball is this far past him along the kick line, m. */
  wallPassMargin: 1.0,
  // ---------------------------------------------------------------- taker
  /** "Choose the taker" cycles through this many best takers. */
  takerChoices: 3,
  /** The waiting taker slides toward his spot behind the ball along the aim at most this far per tick, m/tick. */
  lineUpStep: 0.05,
  // ---------------------------------------------------------------- aim
  /** Left stick magnitude (0..1) from which the stick aims. */
  aimStickMin: 0.5,
  /** The stick may aim this far outside a post on the goal line (curlers), m. */
  aimGoalSlack: 2.0,
  /** The stick / default aim goes on the goal line only from within this distance of the goal centre, m (further
   *  out: a pitch point). */
  aimGoalMaxDist: 40,
  /** Pitch aim point this far along the stick, m; kept this far inside the lines, m. */
  aimPassDist: 20,
  aimPitchMargin: 1.0,
  /** Right stick: curl and dip change per second at full deflection (1/s). */
  curlRate: 1.6,
  dipRate: 1.6,
  // ---------------------------------------------------------------- kicks
  /** LOB toward a goal aim lands this far off the goal line, m. */
  lobLandDepth: 9,
  /** A teammate this far beyond the 16.5 m line (inside the box width) still gets a cross, m. */
  crossAreaExtra: 5,
  /** Taps closer than this to the ball are ignored, m; a tap within tapGroundMax is a ground pass, beyond a lob, m. */
  tapMinDist: 2,
  tapGroundMax: 28,
  /** Swipes toward the goal mouth are shots within this distance of the goal centre, m. */
  swipeShotMaxDist: 40,
  /** Swipe height bands (gPower / 127): ground cross below groundCrossMax, low cross below lowCrossMax, LOFTED from
   *  highCrossMin; a swipe along a line that misses the box is a ground pass below swipeGroundMax, else a lob. */
  groundCrossMax: 0.2,
  lowCrossMax: 0.45,
  highCrossMin: 0.8,
  swipeGroundMax: 0.35,
  /** Ground passes are sized for this arrival speed (SIM-01 groundPassSpeed), m/s; lowest power 0..1. */
  shortArrive: 5,
  shortPowerMin: 0.15,
  /** Lob power = clamp(d / lobPowerRange, lobPowerMin, 1); cross power = clamp(d / crossPowerRange, min, max). */
  lobPowerRange: 70,
  lobPowerMin: 0.45,
  crossPowerRange: 45,
  crossPowerMin: 0.45,
  crossPowerMax: 0.9,
  // ---------------------------------------------------------------- default
  /** Default shot: inset from the covered post, m; curl = clamp(defaultCurlBase + defaultCurlAttr x (curve - 60) / 40,
   *  0.3, 0.85); power = clamp(defaultPowerBase + (distance - 18) x defaultPowerPerM, defaultPowerMin, defaultPowerMax). */
  defaultPostInset: 0.6,
  defaultCurlBase: 0.55,
  defaultCurlAttr: 0.25,
  defaultPowerBase: 0.58,
  defaultPowerPerM: 0.012,
  defaultPowerMin: 0.5,
  defaultPowerMax: 0.78,
  /** Default pass targets between these distances, m; score = openness (capped, m) x openWeight + forward progress x
   *  progressWeight - (distance beyond passLongFrom) x passLongPenalty. */
  passMinDist: 6,
  passMaxDist: 45,
  openCap: 10,
  openWeight: 1.0,
  progressWeight: 0.12,
  passLongFrom: 25,
  passLongPenalty: 0.3,
  /** Default cross: aerial score = heading + heightWeight x (height - 180 cm) + crossOpenWeight x openness (capped). */
  heightWeight: 0.5,
  crossOpenCap: 3,
  crossOpenWeight: 4,
  /** Default forward pass power with nobody to aim at, 0..1. */
  forwardPower: 0.6,
  /** CPU fallback: Default this many ticks after T_RULES.cpuRestartDelay past ready (1.25 s) ... */
  cpuGraceTicks: 75,
  /** ... retried every this many ticks while the kick has not started, ticks. */
  cpuRetryTicks: 30,
  // ---------------------------------------------------------------- preview
  /** Preview horizon, ticks (the first second of flight). */
  previewTicks: 60,
  /** Preview power when none is known yet (pad user before pressing), 0..1. */
  previewPower: 0.65,
  /** Fallback launch (kick module refused): shot elevation and chip extra, rad. */
  previewShotAngle: 0.2,
  previewChipAngle: 0.45,
} as const;

const LT = LOCAL_TUNING;

/** Normal wall distance from the ball (its centre), m, and the sideways move per tick / its limit as rotations
 *  around the ball at that distance (cos / sin computed once at load: no trig per tick). */
const WALL_DIST = RESTART_DISTANCE + LT.wallDistExtra;
const MOVE_COS = dcos((LT.wallMoveSpeed * DT) / WALL_DIST);
const MOVE_SIN = dsin((LT.wallMoveSpeed * DT) / WALL_DIST);
const MOVE_MAX_COS = dcos(LT.wallMoveMax / WALL_DIST);
const MOVE_MAX_SIN = dsin(LT.wallMoveMax / WALL_DIST);

/** WALL_JUMP sub-states (p.actA). */
export const WallMode = { BRACE: 0, JUMP: 1, CHARGE: 2, ARMED: 3 } as const;

const MAX_WALL = 5;

// ---------------------------------------------------------------- module scratch (no allocation per tick)

const REQ = createActionRequest();
const PT = { x: 0, z: 0 };
const PT2 = { x: 0, z: 0 };
const LOOK = { x: 0, z: 0 };
/** Aim direction handed to setAimDir. */
const AIM_DIR = { x: 1, z: 0 };
/** Wall slots of the current wall (computeSlots). */
const SLOT_X = new Float64Array(MAX_WALL);
const SLOT_Z = new Float64Array(MAX_WALL);
const OFF = new Float64Array(MAX_WALL);
/** Wall-pick marks (pickWall). */
const PICKED = new Uint8Array(NUM_SLOTS);
/** Taker ranking (rankTakers): slots by score, count in RANK_N[0]. */
const RANK = new Int32Array(PLAYERS_PER_TEAM);
const RANK_S = new Float64Array(PLAYERS_PER_TEAM);
const RANK_N = new Int32Array(1);
/** One-tick ball prediction for blocking, and the key of the ball it was computed for. */
const NEXT = createBallState();
const BLOCK_KEY = new Float64Array(7);
/** Hit time of the latest swept test (hitTime), -1 = none; the test's inputs (see hitTime). */
const HIT = new Float64Array(1);
const SWEEP = new Float64Array(11);
const LAUNCH = createKickLaunch();
/** Preview scratch (previewFlight). */
let SCR: SimState | null = null;
const PREV_REQ = createActionRequest();
const PREV_LAUNCH = createKickLaunch();
const PB = createBallState();
const SOL = createLaunchSolution();
const SPIN: V3 = { x: 0, y: 0, z: 0 };
const PREVIEW_SEED = { a: 0x9e3779b9, b: 0x243f6a88, c: 0xb7e15162, d: 0x3c6ef372 };

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, d: number): number {
  return v - v === 0 ? v : d;
}

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function attackDir(s: SimState, team: number): number {
  return s.teams[team === 1 ? 1 : 0]!.dir;
}

function isDown(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.STUMBLE || p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP || p.stunT > 0;
}

/** Waiting states of the taker in which a new kick may start. */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE;
}

function isKickAct(a: ActionKind): boolean {
  return a === ActionKind.KICK || a === ActionKind.SHOT;
}

/** The FREE_KICK phase with its free-kick restart record. */
function fkPhase(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.FREE_KICK && m.restart.kind === RestartKind.FREE_KICK;
}

/** An untaken free kick in the FREE_KICK phase. */
function fkLive(s: SimState): boolean {
  return fkPhase(s) && s.match.restart.taken === 0;
}

/**
 * The restart record still describes the current free kick's wall: during the free kick, or in the open play that
 * follows its strike (RUL-01 clears restart.kind on IN_PLAY but keeps the rest of the record; every other restart
 * clears the wall when it is awarded, so a wall with kind NONE and taken = 1 is the last free kick's).
 */
function wallRecord(s: SimState): boolean {
  const r = s.match.restart;
  if (!(r.wallCount > 0)) return false;
  if (r.kind === RestartKind.FREE_KICK) return true;
  return r.kind === RestartKind.NONE && r.taken === 1 && s.match.phase === MatchPhase.IN_PLAY;
}

function isShotKind(k: KickKind): boolean {
  return k === KickKind.FREE_KICK_SHOT || (k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN);
}

function isLobKind(k: KickKind): boolean {
  return k === KickKind.LOB_PASS || k === KickKind.HIGH_LOB || k === KickKind.DRIVEN_LOB || k === KickKind.CROSS ||
    k === KickKind.GROUND_CROSS || k === KickKind.LOW_CROSS;
}

function isThroughKind(k: KickKind): boolean {
  return k === KickKind.THROUGH_GROUND || k === KickKind.THROUGH_LOBBED || k === KickKind.THROUGH_DINKED;
}

/** Ball at rest on the ground at (x, z); possession and hands released (not a contact). */
function placeBall(s: SimState, x: number, z: number, ev: EventSink): void {
  const b = s.ball;
  if (b.owner >= 0) releasePossession(s, ev);
  b.owner = -1;
  b.ownerT = 0;
  b.heldBy = -1;
  b.x = x; b.y = BALL_RADIUS; b.z = z;
  b.px = x; b.py = BALL_RADIUS; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1;
  b.bounces = 0;
  b.inNet = 0;
}

/** Inside the goal area of `end` (+-1). */
function inGoalArea(x: number, z: number, end: number): boolean {
  const ex = end * x;
  return ex >= HALF_LENGTH - GOAL_AREA_DEPTH && ex <= HALF_LENGTH && z >= -GOAL_AREA_HALF_WIDTH && z <= GOAL_AREA_HALF_WIDTH;
}

/** Inside the penalty area of `end` (+-1), extended `extra` m beyond its 16.5 m line. */
function inArea(x: number, z: number, end: number, extra: number): boolean {
  const u = HALF_LENGTH - end * x;
  return u >= 0 && u <= PENALTY_AREA_DEPTH + extra && z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH;
}

/** Nearest active opponent of `team` to (x, z), m (1e9 when none). */
function openness(s: SimState, team: number, x: number, z: number): number {
  const first = teamFirstSlot(other(team));
  let best = 1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - x, dz = q.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best >= 1e18 ? 1e9 : Math.sqrt(best);
}

/** Power 0..1 of a ground pass over `d` metres. */
export function freeKickShortPower(d: number): number {
  const v = clamp(groundPassSpeed(d, LT.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
  return clamp((v - T_PASS.groundMin) / (T_PASS.groundMax - T_PASS.groundMin), LT.shortPowerMin, 1);
}

function lobPower(d: number): number {
  return clamp(d / LT.lobPowerRange, LT.lobPowerMin, 1);
}

function crossPower(d: number): number {
  return clamp(d / LT.crossPowerRange, LT.crossPowerMin, LT.crossPowerMax);
}

// ---------------------------------------------------------------- wall size and geometry

/** Angle (rad) the mouth of the goal `team` attacks subtends seen from (x, z). */
export function goalMouthAngle(s: SimState, team: number, x: number, z: number): number {
  const u0 = HALF_LENGTH - attackDir(s, team) * x;
  const u = u0 > 0.01 ? u0 : 0.01;
  const az = z < 0 ? -z : z;
  return datan2(GOAL_HALF_WIDTH - az, u) - datan2(-GOAL_HALF_WIDTH - az, u);
}

/** Wall size for a free kick by `team` at (x, z): 0 (no wall) or 2..5 by distance and angle (see header). */
export function freeKickWallCount(s: SimState, team: number, x: number, z: number): number {
  if (!(x === x && z === z)) return 0;
  const u = HALF_LENGTH - attackDir(s, team) * x;
  if (u < 0) return 0;
  const d = Math.sqrt(u * u + z * z);
  if (!(d <= LT.wallMaxDist)) return 0;
  const a = goalMouthAngle(s, team, x, z);
  if (!(a >= LT.wallMinAngle)) return 0;
  const f = (2 * GOAL_HALF_WIDTH) / a;
  return f < LT.wallEquiv5 ? 5 : f < LT.wallEquiv4 ? 4 : f < LT.wallEquiv3 ? 3 : 2;
}

/** True when the current free kick's wall stands on the goal line (spot closer than 9.15 m to it). */
function isLineWall(s: SimState): boolean {
  const r = s.match.restart;
  return HALF_LENGTH - attackDir(s, r.team) * r.x < RESTART_DISTANCE;
}

/**
 * Default centre of the wall of the current free kick (count restart.wallCount), written to `out`. Returns 1 for a
 * normal wall, 2 for a goal-line wall, 0 when no wall can stand (count 0, or a wall that would end on the goal line).
 */
export function wallDefaultCentre(s: SimState, out: { x: number; z: number }): number {
  const r = s.match.restart;
  const n = r.wallCount;
  out.x = r.x;
  out.z = r.z;
  if (!(n > 0)) return 0;
  const dir = attackDir(s, r.team);
  const bx = r.x, bz = r.z;
  const gx = dir * HALF_LENGTH;
  const az = bz < 0 ? -bz : bz;
  const sn = bz < 0 ? -1 : 1;
  if (isLineWall(s)) {
    const half = (n - 1) * 0.5 * (2 * T_PLAYER.bodyRadius * 1.1 + LT.wallGap);
    const maxC = GOAL_HALF_WIDTH - LT.wallPostInside - half;
    out.x = dir * (HALF_LENGTH - LT.wallGoalLineInset);
    out.z = az < LT.wallCentralZ || maxC <= 0 ? 0 : sn * maxC;
    return 2;
  }
  const D = WALL_DIST;
  let gdx = gx - bx, gdz = -bz;
  let gl = Math.sqrt(gdx * gdx + gdz * gdz);
  if (gl < 1e-6) { gdx = dir; gdz = 0; gl = 1; }
  const ugx = gdx / gl, ugz = gdz / gl;
  let ux: number, uz: number;
  if (az < LT.wallCentralZ) {
    ux = ugx; uz = ugz;
  } else {
    let ox = gx - bx, oz = sn * (GOAL_HALF_WIDTH + LT.wallPostCover) - bz;
    const ol = Math.sqrt(ox * ox + oz * oz);
    ox /= ol; oz /= ol;
    const si = ox * ugz - oz * ugx >= 0 ? 1 : -1; // rotate from the outer edge toward the goal centre
    const halfW = (n - 1) * 0.5 * (2 * T_PLAYER.bodyRadius + LT.wallGap) + LT.wallBlockRadius;
    // Rotate by phi = atan(halfW / D): cos = D / h, sin = halfW / h (no trig per tick).
    const h = Math.sqrt(D * D + halfW * halfW);
    const c = D / h, sv = (si * halfW) / h;
    ux = ox * c - oz * sv;
    uz = ox * sv + oz * c;
  }
  out.x = bx + ux * D;
  out.z = bz + uz * D;
  if (dir * out.x > HALF_LENGTH - LT.wallLineGap) { out.x = bx; out.z = bz; return 0; }
  return 1;
}

/** Spacing between neighbouring members a and b: their body-contact distance + wallGap, m. */
function spacing(s: SimState, a: number, b: number): number {
  const ra = a >= 0 && a < NUM_SLOTS ? bodyRadiusOf(s, a) : T_PLAYER.bodyRadius;
  const rb = b >= 0 && b < NUM_SLOTS ? bodyRadiusOf(s, b) : T_PLAYER.bodyRadius;
  return ra + rb + LT.wallGap;
}

/** Unit wall-line direction p for the current wall into PT2 (goal-line wall: along z). */
function wallLineDir(s: SimState): void {
  const r = s.match.restart;
  if (isLineWall(s)) { PT2.x = 0; PT2.z = 1; return; }
  const dx = r.wallX - r.x, dz = r.wallZ - r.z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (!(dl > 1e-6)) { PT2.x = 0; PT2.z = 1; return; }
  PT2.x = -dz / dl;
  PT2.z = dx / dl;
}

/** Fill SLOT_X / SLOT_Z with every member's spot for the current wall (centre wallX / wallZ). Returns the count. */
function computeSlots(s: SimState): number {
  const r = s.match.restart;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  if (!(n > 0)) return 0;
  wallLineDir(s);
  const px = PT2.x, pz = PT2.z;
  const line = isLineWall(s);
  let acc = 0;
  OFF[0] = 0;
  for (let i = 1; i < n; i++) {
    acc += spacing(s, r.wall[i - 1]!, r.wall[i]!);
    OFF[i] = acc;
  }
  const half = acc * 0.5;
  const minD = RESTART_DISTANCE + LT.wallDistSlack;
  const zLimLine = GOAL_HALF_WIDTH - LT.wallPostInside;
  const mx = HALF_LENGTH - LT.wallPitchMargin, mz = HALF_WIDTH - LT.wallPitchMargin;
  for (let i = 0; i < n; i++) {
    const off = OFF[i]! - half;
    let x = r.wallX + px * off;
    let z = r.wallZ + pz * off;
    if (line) {
      z = clamp(z, -zLimLine, zLimLine);
    } else {
      const ex = x - r.x, ez = z - r.z;
      const el = Math.sqrt(ex * ex + ez * ez);
      if (el < minD && el > 1e-6) { x = r.x + (ex / el) * minD; z = r.z + (ez / el) * minD; }
    }
    SLOT_X[i] = clamp(x, -mx, mx);
    SLOT_Z[i] = clamp(z, -mz, mz);
  }
  return n;
}

/** Spot of wall member i (0..wallCount-1) of the current free kick, written to `out` (the ball spot if none). */
export function wallSlot(s: SimState, i: number, out: { x: number; z: number }): void {
  const n = computeSlots(s);
  if (i >= 0 && i < n) { out.x = SLOT_X[i]!; out.z = SLOT_Z[i]!; return; }
  out.x = s.match.restart.x;
  out.z = s.match.restart.z;
}

/** Index of `slot` in the current free-kick wall (also in the play right after its strike), -1 if not a member. */
export function wallIndexOf(s: SimState, slot: number): number {
  const r = s.match.restart;
  if (slot < 0 || !wallRecord(s)) return -1;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  for (let i = 0; i < n; i++) if (r.wall[i] === slot) return i;
  return -1;
}

/** True if `slot` stands in the current free-kick wall. */
export function isWallMember(s: SimState, slot: number): boolean {
  return wallIndexOf(s, slot) >= 0;
}

/**
 * The post side (world z sign, -1 / +1) the current wall covers, from its shadow on the goal line (seen from the ball,
 * the end members' bodies wallBlockRadius wide): the near post of an angled free kick (|z| >= wallCentralZ) while the
 * shadow contains it, else the one post the shadow contains. 0 for a central wall covering both posts or neither, or
 * no wall (GKP-06 stands on the other side).
 */
export function wallCoverSide(s: SimState): number {
  const r = s.match.restart;
  if (!wallRecord(s)) return 0;
  const n = computeSlots(s);
  if (n === 0) return 0;
  const R = LT.wallBlockRadius;
  let lo: number, hi: number;
  if (isLineWall(s)) {
    lo = SLOT_Z[0]! - R;
    hi = SLOT_Z[n - 1]! + R;
  } else {
    const dir = attackDir(s, r.team);
    const gx = dir * HALF_LENGTH;
    wallLineDir(s);
    const px = PT2.x, pz = PT2.z;
    // Slot 0 is the -p end of the wall, slot n-1 the +p end (computeSlots).
    const ax = SLOT_X[0]! - px * R - r.x, az = SLOT_Z[0]! - pz * R - r.z;
    const bx = SLOT_X[n - 1]! + px * R - r.x, bz = SLOT_Z[n - 1]! + pz * R - r.z;
    if (!(dir * ax > 1e-6) || !(dir * bx > 1e-6)) return 0;
    const za = r.z + ((gx - r.x) * az) / ax, zb = r.z + ((gx - r.x) * bz) / bx;
    lo = za < zb ? za : zb;
    hi = za < zb ? zb : za;
  }
  const pos = lo <= GOAL_HALF_WIDTH && hi >= GOAL_HALF_WIDTH;
  const neg = lo <= -GOAL_HALF_WIDTH && hi >= -GOAL_HALF_WIDTH;
  // The near post of an angled free kick, when the wall still covers it (it is built to; the SIM-05 body spacing can
  // make its shadow reach the far post too); else the one post it covers.
  const near = r.z >= LT.wallCentralZ ? 1 : r.z <= -LT.wallCentralZ ? -1 : 0;
  if ((near === 1 && pos) || (near === -1 && neg)) return near;
  return pos && !neg ? 1 : neg && !pos ? -1 : 0;
}

/** Jump lift (m) of a wall member at tick actT of his jump: crouch, then a ballistic hop. */
export function jumpLift(actT: number): number {
  return actT >= 0 && actT < JUMP_TICKS ? JUMP_LIFT[actT | 0]! : 0;
}

/** Lift of the jump's ballistic hop at action tick t (0 outside the airborne ticks), m. */
function hopLift(actT: number): number {
  const t = actT - LT.jumpCrouchTicks;
  if (!(t > 0) || t >= LT.jumpAirTicks) return 0;
  const g = T_BALL.gravity;
  const air = LT.jumpAirTicks * DT;
  const tau = t * DT;
  return 0.5 * g * air * tau - 0.5 * g * tau * tau;
}

/** jumpLift by action tick, tabulated once at load (a table read per tick: no double crossing a call). */
const JUMP_TICKS = LT.jumpCrouchTicks + LT.jumpAirTicks + LT.jumpLandTicks + 1;
const JUMP_LIFT = new Float64Array(JUMP_TICKS);
for (let t = 0; t < JUMP_TICKS; t++) JUMP_LIFT[t] = hopLift(t);

/** Current lift (m) of `slot` when he is jumping in a wall, else 0 (render, keeper). */
export function wallLift(s: SimState, slot: number): number {
  if (slot < 0 || slot >= NUM_SLOTS) return 0;
  const p = s.players[slot]!;
  return p.act === ActionKind.WALL_JUMP && p.actA === WallMode.JUMP ? jumpLift(p.actT) : 0;
}

/** Wall member's height for blocking, m (attrs.height clamped; 1.8 m when not finite). blockCheck inlines it. */
function memberHeight(s: SimState, slot: number): number {
  const h = s.attrs[slot]!.height;
  const hm = h - h === 0 ? h / 100 : 1.8;
  return hm < LT.heightMin ? LT.heightMin : hm > LT.heightMax ? LT.heightMax : hm;
}

/** Member `w` may stand in the wall of the current free kick (active outfield player of the defending side). */
function memberOk(s: SimState, w: number): boolean {
  if (!(w >= 0 && w < NUM_SLOTS)) return false;
  const r = s.match.restart;
  const p = s.players[w]!;
  return p.active === 1 && p.isKeeper === 0 && p.team === other(r.team === 1 ? 1 : 0);
}

function wallValid(s: SimState): boolean {
  const r = s.match.restart;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  for (let i = 0; i < n; i++) if (!memberOk(s, r.wall[i]!)) return false;
  return true;
}

/**
 * Choose the wall of the current free kick: restart.wallCount from freeKickWallCount, the default centre into
 * wallX / wallZ, members = the nearest active outfield defenders to it (players who are down only when needed), ordered
 * along the wall line. wallCount ends as the number actually found (0 = no wall).
 */
function pickWall(s: SimState): void {
  const r = s.match.restart;
  for (let i = 0; i < r.wall.length; i++) r.wall[i] = -1;
  const team = r.team === 1 ? 1 : 0;
  r.wallCount = freeKickWallCount(s, team, r.x, r.z);
  if (wallDefaultCentre(s, PT) === 0) { r.wallCount = 0; r.wallX = r.x; r.wallZ = r.z; return; }
  r.wallX = PT.x;
  r.wallZ = PT.z;
  const want = r.wallCount;
  const def = other(team);
  const first = teamFirstSlot(def);
  for (let i = 0; i < NUM_SLOTS; i++) PICKED[i] = 0;
  let count = 0;
  for (let pass = 0; pass < 2 && count < want; pass++) {
    while (count < want) {
      let best = -1;
      let bestD = 1e18;
      for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
        if (PICKED[slot] === 1 || !memberOk(s, slot)) continue;
        const p = s.players[slot]!;
        if (pass === 0 && isDown(p)) continue;
        const dx = p.x - r.wallX, dz = p.z - r.wallZ;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = slot; }
      }
      if (best < 0) break;
      PICKED[best] = 1;
      r.wall[count++] = best;
    }
  }
  r.wallCount = count;
  if (count === 0) { r.wallX = r.x; r.wallZ = r.z; return; }
  // Order along the wall line p (no crossing paths), ties by slot (insertion sort, n <= 5).
  wallLineDir(s);
  const px = PT2.x, pz = PT2.z;
  for (let i = 1; i < count; i++) {
    const w = r.wall[i]!;
    const kw = s.players[w]!.x * px + s.players[w]!.z * pz;
    let j = i - 1;
    while (j >= 0) {
      const v = r.wall[j]!;
      const kv = s.players[v]!.x * px + s.players[v]!.z * pz;
      if (kv < kw || (kv === kw && v < w)) break;
      r.wall[j + 1] = v;
      j--;
    }
    r.wall[j + 1] = w;
  }
}

/** Re-pick an invalid wall, keeping its sideways shift (the current centre) when it still stands. */
function repickWall(s: SimState): void {
  const r = s.match.restart;
  const cx = r.wallX, cz = r.wallZ;
  pickWall(s);
  if (r.wallCount > 0 && cx === cx && cz === cz) {
    const dx = cx - r.x, dz = cz - r.z;
    const minD = RESTART_DISTANCE;
    if (isLineWall(s) || dx * dx + dz * dz >= minD * minD) { r.wallX = cx; r.wallZ = cz; }
  }
}

/**
 * [QF-1] True when moving `slot` to (x, z) would put his body into another player's beyond half the overlap tolerance
 * (SIM-05 contact distance). A wall slot can be taken (the keeper's spot by a goal-line wall, a team-mate still on
 * his way): the ready snap is one teleport SIM-05 resolves, but re-snapping / sliding a member into it every tick after
 * held two bodies inside each other for seconds (overlap invariant); left alone, SIM-05 separates them and the member
 * slides in once the spot is clear.
 */
function bodyInTheWay(s: SimState, slot: number, x: number, z: number): boolean {
  const rs = bodyRadiusOf(s, slot);
  const slack = T_PLAYER.overlapTolerance * 0.5;
  for (let j = 0; j < NUM_SLOTS; j++) {
    if (j === slot) continue;
    const q = s.players[j]!;
    if (q.active !== 1) continue;
    const dx = q.x - x, dz = q.z - z;
    const min = rs + bodyRadiusOf(s, j) - slack;
    if (dx * dx + dz * dz < min * min) return true;
  }
  return false;
}

/** Members onto their slots: snapped at ready, else slid (wallSlideStep) when near the wall; facing the ball. */
function placeWall(s: SimState, snap: boolean): void {
  const r = s.match.restart;
  const n = computeSlots(s);
  if (n === 0) return;
  const half = (n - 1) * 0.5 * (2 * T_PLAYER.bodyRadius * 1.1 + LT.wallGap);
  const hold = half + LT.wallHoldExtra;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (!memberOk(s, w)) continue;
    const p = s.players[w]!;
    const armed = p.act === ActionKind.WALL_JUMP && p.actA === WallMode.ARMED;
    if ((p.act !== ActionKind.NONE && !armed) || p.stunT > 0) continue; // jumping, down: leave him
    const tx = SLOT_X[i]!, tz = SLOT_Z[i]!;
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (snap || d <= LT.wallSlideStep) {
      if (snap || !bodyInTheWay(s, w, tx, tz)) { p.x = tx; p.z = tz; p.vx = 0; p.vz = 0; }
    } else {
      const cx = p.x - r.wallX, cz = p.z - r.wallZ;
      if (cx * cx + cz * cz > hold * hold) continue; // still walking in (TAI-13)
      const nx = p.x + (dx / d) * LT.wallSlideStep, nz = p.z + (dz / d) * LT.wallSlideStep;
      if (!bodyInTheWay(s, w, nx, nz)) { p.x = nx; p.z = nz; }
    }
    const fx = r.x - p.x, fz = r.z - p.z;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-6) { p.fx = fx / fl; p.fz = fz / fl; }
  }
}

/**
 * Move the wall sideways by `sgn` (+1 = along +p, the defenders' left as they face the ball) for one tick at
 * wallMoveSpeed, keeping its distance from the ball, at most wallMoveMax from its default centre.
 */
function moveWall(s: SimState, sgn: number): void {
  const r = s.match.restart;
  if (wallDefaultCentre(s, PT) === 0) return;
  const step = LT.wallMoveSpeed * DT;
  if (isLineWall(s)) {
    const n = r.wallCount;
    const half = (n - 1) * 0.5 * (2 * T_PLAYER.bodyRadius * 1.1 + LT.wallGap);
    const lim = GOAL_HALF_WIDTH - LT.wallPostInside - half;
    const lo = lim > 0 ? -lim : 0, hi = lim > 0 ? lim : 0;
    r.wallX = PT.x;
    r.wallZ = clamp(clamp(r.wallZ + sgn * step, PT.z - LT.wallMoveMax, PT.z + LT.wallMoveMax), lo, hi);
    return;
  }
  // Rotate the current centre around the ball by one step (precomputed cos / sin: no trig per tick), at distance D.
  const ax = PT.x - r.x, az = PT.z - r.z; // default centre offset (length D)
  const D = Math.sqrt(ax * ax + az * az);
  if (!(D > 1e-6)) return;
  let cx = r.wallX - r.x, cz = r.wallZ - r.z;
  const cl = Math.sqrt(cx * cx + cz * cz);
  if (cl > 1e-6) { cx *= D / cl; cz *= D / cl; } else { cx = ax; cz = az; } // (NaN -> the default)
  const sv = sgn > 0 ? MOVE_SIN : -MOVE_SIN;
  const nx = cx * MOVE_COS - cz * sv, nz = cx * sv + cz * MOVE_COS;
  if (nx * ax + nz * az < D * D * MOVE_MAX_COS) {
    // Beyond wallMoveMax (arc) from the default: onto the limit on that side.
    const ms = ax * nz - az * nx >= 0 ? MOVE_MAX_SIN : -MOVE_MAX_SIN;
    r.wallX = r.x + ax * MOVE_MAX_COS - az * ms;
    r.wallZ = r.z + ax * ms + az * MOVE_MAX_COS;
    return;
  }
  r.wallX = r.x + nx;
  r.wallZ = r.z + nz;
}

// ---------------------------------------------------------------- taker

/** Free-kick taker score of `slot`: curve + shotPower + longShots for a shooting free kick, else passing. */
export function freeKickTakerScore(s: SimState, slot: number, shooting: boolean): number {
  const a = s.attrs[slot]!;
  return shooting ? a.curve + a.shotPower + a.longShots : a.shortPassing + a.longPassing + a.crossing;
}

/** Rank the takers of the current free kick into RANK (best first, ties lower slot), at most `max`. */
function rankTakers(s: SimState, max: number): void {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  const first = teamFirstSlot(team);
  const shooting = freeKickWallCount(s, team, r.x, r.z) > 0;
  const keeperOk = inArea(r.x, r.z, -dir, 0);
  let n = 0;
  for (let pass = 0; pass < 2 && n === 0; pass++) {
    for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
      const p = s.players[slot]!;
      if (p.active !== 1) continue;
      if (p.isKeeper === 1 && !keeperOk && pass === 0) continue;
      if (pass === 0 && isDown(p)) continue;
      const sc = freeKickTakerScore(s, slot, shooting);
      // insertion into the ranked list (descending score, ties lower slot first: slots arrive in order)
      let j = n < max ? n : max - 1;
      if (n >= max && !(sc > RANK_S[max - 1]!)) continue;
      while (j > 0 && sc > RANK_S[j - 1]!) {
        RANK[j] = RANK[j - 1]!;
        RANK_S[j] = RANK_S[j - 1]!;
        j--;
      }
      RANK[j] = slot;
      RANK_S[j] = sc;
      if (n < max) n++;
    }
  }
  RANK_N[0] = n;
}

/** Best free-kick taker for the current free kick (see header), -1 if the team has nobody active. */
export function pickFreeKickTaker(s: SimState): number {
  rankTakers(s, 1);
  return RANK_N[0]! > 0 ? RANK[0]! : -1;
}

/**
 * "Choose the taker" (SPRINT): the next of the takerChoices best takers after the current one (wrapping). The new
 * taker goes onto RUL-11's taker spot (SET_PIECE), the old one to where the new one stood. Returns the new taker or -1.
 */
export function cycleFreeKickTaker(s: SimState): number {
  if (!fkLive(s)) return -1;
  const r = s.match.restart;
  rankTakers(s, LT.takerChoices);
  const n = RANK_N[0]!;
  if (n < 2) return -1;
  const cur = r.taker;
  let idx = -1;
  for (let i = 0; i < n; i++) if (RANK[i] === cur) idx = i;
  const next = idx >= 0 ? RANK[(idx + 1) % n]! : RANK[0] !== cur ? RANK[0]! : RANK[1]!;
  if (next === cur || !isValidTaker(s, next)) return -1;
  const np = s.players[next]!;
  if (np.act !== ActionKind.NONE || np.stunT > 0) return -1;
  const ox = np.x, oz = np.z;
  r.taker = next;
  if (cur >= 0 && cur < NUM_SLOTS) {
    const op = s.players[cur]!;
    if (op.act === ActionKind.SET_PIECE) endAction(s, cur, 1);
    op.x = ox; op.z = oz; op.vx = 0; op.vz = 0;
  }
  restartTakerSpot(s, PT);
  restartLookPoint(s, LOOK);
  np.x = PT.x; np.z = PT.z; np.vx = 0; np.vz = 0;
  const fx = LOOK.x - np.x, fz = LOOK.z - np.z;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-6) { np.fx = fx / fl; np.fz = fz / fl; }
  beginAction(np, ActionKind.SET_PIECE, COMMON_TUNING.setPieceWaitTicks, -1);
  np.moveMode = MoveMode.LOCKED;
  return next;
}

// ---------------------------------------------------------------- aim

/** Aim on the attacked goal line? */
export function freeKickAimOnGoal(s: SimState): boolean {
  const r = s.match.restart;
  const gx = attackDir(s, r.team) * HALF_LENGTH;
  const d = r.aimX - gx;
  return d < 1e-6 && d > -1e-6;
}

/** Dip of the current free kick's aim (-1..1; positive = topspin, dips sooner). */
export function freeKickDip(s: SimState): number {
  const r = s.match.restart;
  return r.kind === RestartKind.FREE_KICK ? clamp(finiteOr(r.side, 0), -1, 1) : 0;
}

/**
 * Aim along the unit direction AIM_DIR from the ball: the goal line when the ray meets the mouth (ball within
 * aimGoalMaxDist of the goal centre), else a pitch point aimPassDist along it. (The direction is passed in module
 * scratch, not as arguments: doubles passed to a non-inlined call are boxed.)
 */
function setAimDir(s: SimState): void {
  const r = s.match.restart;
  const ux = AIM_DIR.x, uz = AIM_DIR.z;
  const dir = attackDir(s, r.team);
  const gx = dir * HALF_LENGTH;
  const gdx = gx - r.x;
  if (dir * ux > 1e-6 && gdx * gdx + r.z * r.z <= LT.aimGoalMaxDist * LT.aimGoalMaxDist) {
    const zHit = r.z + ((gx - r.x) / ux) * uz;
    const lim = GOAL_HALF_WIDTH + LT.aimGoalSlack;
    if (zHit >= -lim && zHit <= lim) { r.aimX = gx; r.aimZ = zHit; return; }
  }
  const mx = HALF_LENGTH - LT.aimPitchMargin, mz = HALF_WIDTH - LT.aimPitchMargin;
  r.aimX = clamp(r.x + ux * LT.aimPassDist, -mx, mx);
  r.aimZ = clamp(r.z + uz * LT.aimPassDist, -mz, mz);
}

/** Default aim: the goal centre with a wall (or within aimGoalMaxDist), else aimPassDist toward it. */
function defaultAim(s: SimState): void {
  const r = s.match.restart;
  const dir = attackDir(s, r.team);
  const gx = dir * HALF_LENGTH;
  const dx = gx - r.x, dz = -r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (r.wallCount > 0 || d <= LT.aimGoalMaxDist) { r.aimX = gx; r.aimZ = 0; return; }
  AIM_DIR.x = dx / d;
  AIM_DIR.z = dz / d;
  setAimDir(s);
}

/** Keep the aim finite, inside the pitch and off the ball (re-seeded when something else wrote it). */
function ensureAim(s: SimState): void {
  const r = s.match.restart;
  const dx = r.aimX - r.x, dz = r.aimZ - r.z;
  const md = COMMON_TUNING.aimMinDist;
  const inPitch = r.aimX >= -HALF_LENGTH && r.aimX <= HALF_LENGTH && r.aimZ >= -HALF_WIDTH && r.aimZ <= HALF_WIDTH;
  if (!(dx * dx + dz * dz > md * md) || !inPitch) defaultAim(s);
  if (!(r.aimCurve >= -1 && r.aimCurve <= 1)) r.aimCurve = 0;
  if (!(r.side >= -1 && r.side <= 1)) r.side = 0;
  if (!(r.aimPower >= 0 && r.aimPower <= 1)) r.aimPower = 0;
}

/** Unit direction from the ball to the aim into PT2 (toward the attacked goal when the aim is on the ball). */
function aimDir(s: SimState): void {
  const r = s.match.restart;
  const dx = r.aimX - r.x, dz = r.aimZ - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-6) { PT2.x = dx / d; PT2.z = dz / d; return; }
  PT2.x = attackDir(s, r.team);
  PT2.z = 0;
}

/** Left stick aims (direction from the ball). */
function aimFromStick(s: SimState, f: Readonly<InputFrame>): void {
  const mx = f.mx / AXIS_SCALE, mz = f.mz / AXIS_SCALE;
  if (!(mx === mx && mz === mz)) return;
  const m2 = mx * mx + mz * mz;
  if (!(m2 >= LT.aimStickMin * LT.aimStickMin)) return;
  const m = Math.sqrt(m2);
  AIM_DIR.x = mx / m;
  AIM_DIR.z = mz / m;
  setAimDir(s);
}

/** Right stick changes curl (across the aim) and dip (along it); frame.curve sets the curl directly. */
function curlFromRightStick(s: SimState, f: Readonly<InputFrame>): void {
  const r = s.match.restart;
  const ax = f.ax / AXIS_SCALE, az = f.az / AXIS_SCALE;
  const idle = T_INPUT.stickIdle;
  if (ax === ax && az === az && ax * ax + az * az > idle * idle) {
    aimDir(s);
    const ux = PT2.x, uz = PT2.z;
    const across = clamp(ax * -uz + az * ux, -1, 1);
    const along = clamp(ax * ux + az * uz, -1, 1);
    r.aimCurve = clamp(finiteOr(r.aimCurve, 0) + across * LT.curlRate * DT, -1, 1);
    r.side = clamp(finiteOr(r.side, 0) + along * LT.dipRate * DT, -1, 1);
  }
  const cv = f.curve;
  if (cv !== 0 && cv === cv) r.aimCurve = clamp(cv / AXIS_SCALE, -1, 1);
}

// ---------------------------------------------------------------- requests

function resetReq(req: ActionRequest, assist: AssistLevel, flags: number): void {
  req.power = 0;
  req.charging = 0;
  req.dirX = 0;
  req.dirZ = 0;
  req.targetSlot = -1;
  req.hasTarget = 0;
  req.targetX = 0;
  req.targetZ = 0;
  req.curve = 0;
  req.assist = assist;
  req.flags = ReqFlag.SET_PIECE | flags;
}

/** req.dir = unit direction from the ball to (x, z) (toward the attacked goal when the point is on the ball). */
function reqDirTo(s: SimState, req: ActionRequest, x: number, z: number): void {
  const r = s.match.restart;
  const dx = x - r.x, dz = z - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-6) { req.dirX = dx / d; req.dirZ = dz / d; return; }
  req.dirX = attackDir(s, r.team);
  req.dirZ = 0;
}

/** Explicit power from the frame (0 = none -> charging from the hold). */
function reqPowerFrom(req: ActionRequest, f: Readonly<InputFrame>): void {
  const pw = f.power;
  if (pw > 0 && pw === pw) {
    req.power = clamp(pw / UNIT_SCALE, 0, 1);
    req.charging = 0;
  } else {
    req.power = 0;
    req.charging = 1; // the resolver attaches the power bar to the pressed button (adoptCharge)
  }
}

function ctrlFlags(kind: ControllerKind): number {
  return kind === ControllerKind.CPU ? ReqFlag.CPU : 0;
}

/** Shot request at the current aim (kind by modifiers). Returns the kind. */
function fillShot(s: SimState, req: ActionRequest, modL: boolean, modR: boolean, assist: AssistLevel, flags: number): KickKind {
  const r = s.match.restart;
  const kind = modL && !modR ? KickKind.SHOT_CHIP : modR && !modL ? KickKind.SHOT_FINESSE : KickKind.FREE_KICK_SHOT;
  resetReq(req, assist, flags | (modL && modR ? ReqFlag.DRIVEN : 0));
  reqDirTo(s, req, r.aimX, r.aimZ);
  if (freeKickAimOnGoal(s)) { req.hasTarget = 1; req.targetX = r.aimX; req.targetZ = r.aimZ; }
  req.curve = clamp(finiteOr(r.aimCurve, 0), -1, 1);
  return kind;
}

/** Landing point of a LOB at the current aim into PT: the aim, or for a goal aim the aim ray lobLandDepth off the line. */
function lobLanding(s: SimState): void {
  const r = s.match.restart;
  if (!freeKickAimOnGoal(s)) { PT.x = r.aimX; PT.z = r.aimZ; return; }
  const dir = attackDir(s, r.team);
  const lx = dir * (HALF_LENGTH - LT.lobLandDepth);
  const dx = r.aimX - r.x;
  if (dir * (lx - r.x) > 1 && (dx > 1e-6 || dx < -1e-6)) {
    const t = (lx - r.x) / dx;
    PT.x = lx;
    PT.z = r.z + (r.aimZ - r.z) * t;
    return;
  }
  PT.x = dir * (HALF_LENGTH - PENALTY_SPOT_DIST);
  PT.z = 0;
}

/** LOB request at the current aim (cross into the box, else a lob along the aim). Returns the kind. */
function fillLob(s: SimState, req: ActionRequest, modL: boolean, modR: boolean, assist: AssistLevel, flags: number): KickKind {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  lobLanding(s);
  const lx = PT.x, lz = PT.z;
  if (inArea(lx, lz, attackDir(s, team), 0)) {
    const kind = modL && modR ? KickKind.LOW_CROSS : KickKind.CROSS;
    resetReq(req, assist, flags | (modL && !modR ? ReqFlag.LOFTED : 0));
    reqDirTo(s, req, lx, lz);
    req.hasTarget = 1;
    req.targetX = lx;
    req.targetZ = lz;
    req.curve = clamp(finiteOr(r.aimCurve, 0), -1, 1);
    return kind;
  }
  const kind = modL && modR ? KickKind.DRIVEN_LOB : modL ? KickKind.HIGH_LOB : KickKind.LOB_PASS;
  resetReq(req, assist, flags);
  reqDirTo(s, req, r.aimX, r.aimZ);
  req.curve = clamp(finiteOr(r.aimCurve, 0), -1, 1);
  return kind;
}

/**
 * Start the taker's kick of `kind` from `req` (filled): ends his SET_PIECE wait (RUL-11 prepareTakerKick), turns him
 * along the kick and calls the kick module's starter. Returns 1 if started (if refused, RUL-11 puts him back into
 * SET_PIECE next tick).
 */
function startKick(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (prepareTakerKick(s, slot) !== 1) return 0;
  const p = s.players[slot]!;
  const d = Math.sqrt(req.dirX * req.dirX + req.dirZ * req.dirZ);
  if (d > 1e-6) { p.fx = req.dirX / d; p.fz = req.dirZ / d; }
  let ok: number;
  if (isShotKind(kind)) ok = startShot(s, slot, kind, req, ev);
  else if (isLobKind(kind)) ok = startLob(s, slot, kind, req, ev);
  else if (isThroughKind(kind)) ok = startThrough(s, slot, kind, req, ev);
  else ok = startPass(s, slot, kind, req, ev);
  if (ok === 1 && req === REQ) s.match.restart.aimPower = req.charging === 1 ? 0 : req.power;
  return ok === 1 ? 1 : 0;
}

// ---------------------------------------------------------------- touch gestures

/**
 * Landing of a swipe from the ball along (ux, uz) into the attacked box, into PT: the ray's point inside the box nearest
 * the penalty spot. Returns 0 when the ray misses the box.
 */
function boxRayLanding(s: SimState, ux: number, uz: number): number {
  const r = s.match.restart;
  const e = attackDir(s, r.team);
  const xa = e * (HALF_LENGTH - (PENALTY_AREA_DEPTH - 0.5)), xb = e * (HALF_LENGTH - 1);
  const xlo = xa < xb ? xa : xb, xhi = xa < xb ? xb : xa;
  const wl = PENALTY_AREA_HALF_WIDTH - 0.5;
  let t0 = 0, t1 = 1e9;
  if (ux > 1e-9 || ux < -1e-9) {
    let ta = (xlo - r.x) / ux, tb = (xhi - r.x) / ux;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (r.x < xlo || r.x > xhi) {
    return 0;
  }
  if (uz > 1e-9 || uz < -1e-9) {
    let ta = (-wl - r.z) / uz, tb = (wl - r.z) / uz;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (r.z < -wl || r.z > wl) {
    return 0;
  }
  if (!(t0 <= t1)) return 0;
  const sx = e * (HALF_LENGTH - PENALTY_SPOT_DIST);
  const t = clamp((sx - r.x) * ux + (0 - r.z) * uz, t0, t1);
  PT.x = r.x + ux * t;
  PT.z = r.z + uz * t;
  return 1;
}

/**
 * Map a swipe from the ball (gesture fields of f) to a kick request in `req`. Returns the kind (NONE = ignored).
 * Pure with respect to the state; the aim it implies is left in PT (x, z).
 */
function swipeRequest(s: SimState, f: Readonly<InputFrame>, req: ActionRequest, assist: AssistLevel, flags: number): KickKind {
  if ((f.gFlags & GestureFlag.FROM_BALL) === 0) return KickKind.NONE;
  const g = f.gesture;
  if (g !== GestureKind.SWIPE && g !== GestureKind.CURVED_SWIPE && g !== GestureKind.BACK_FORTH_SWIPE) return KickKind.NONE;
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  let ux = f.gdx / AXIS_SCALE, uz = f.gdz / AXIS_SCALE;
  if (!(ux === ux && uz === uz)) return KickKind.NONE;
  let d = Math.sqrt(ux * ux + uz * uz);
  if (d < 1e-6) { aimDir(s); ux = PT2.x; uz = PT2.z; d = 1; }
  ux /= d; uz /= d;
  let h = f.gPower / UNIT_SCALE;
  h = h === h ? clamp(h, 0, 1) : 0;
  let cv = f.gCurve / AXIS_SCALE;
  cv = cv === cv ? clamp(cv, -1, 1) : 0;
  const gfl = ReqFlag.GESTURE | flags;
  // A shot: toward the goal mouth, close enough.
  const gx = dir * HALF_LENGTH;
  const gdx = gx - r.x, gdz = -r.z;
  const dGoal = Math.sqrt(gdx * gdx + gdz * gdz);
  if (dGoal <= LT.swipeShotMaxDist && dir * ux > 1e-6) {
    const zHit = r.z + ((gx - r.x) / ux) * uz;
    const lim = GOAL_HALF_WIDTH + LT.aimGoalSlack;
    if (zHit >= -lim && zHit <= lim) {
      resetReq(req, assist, gfl | (g === GestureKind.BACK_FORTH_SWIPE ? ReqFlag.DRIVEN : 0));
      req.dirX = ux;
      req.dirZ = uz;
      req.hasTarget = 1;
      req.targetX = gx;
      req.targetZ = zHit;
      req.power = h;
      req.curve = cv;
      PT.x = gx;
      PT.z = zHit;
      return KickKind.FREE_KICK_SHOT;
    }
  }
  // A cross into the box (gesture point there, else the ray through the box), height by speed.
  const px = f.gx / GESTURE_POS_SCALE, pz = f.gz / GESTURE_POS_SCALE;
  let landed: number;
  if (px === px && pz === pz && inArea(px, pz, dir, 0) && (px - r.x) * ux + (pz - r.z) * uz > 0) {
    PT.x = px; PT.z = pz; landed = 1;
  } else {
    landed = boxRayLanding(s, ux, uz);
  }
  if (landed === 1) {
    const kind = h < LT.groundCrossMax ? KickKind.GROUND_CROSS : h < LT.lowCrossMax ? KickKind.LOW_CROSS : KickKind.CROSS;
    resetReq(req, assist, gfl | (h >= LT.highCrossMin ? ReqFlag.LOFTED : 0));
    reqDirTo(s, req, PT.x, PT.z);
    req.hasTarget = 1;
    req.targetX = PT.x;
    req.targetZ = PT.z;
    req.power = h;
    req.curve = cv;
    return kind;
  }
  // A pass along the swipe.
  resetReq(req, assist, gfl);
  req.dirX = ux;
  req.dirZ = uz;
  req.power = h;
  req.curve = cv;
  const mx = HALF_LENGTH - LT.aimPitchMargin, mz = HALF_WIDTH - LT.aimPitchMargin;
  PT.x = clamp(r.x + ux * LT.aimPassDist, -mx, mx);
  PT.z = clamp(r.z + uz * LT.aimPassDist, -mz, mz);
  return h < LT.swipeGroundMax ? KickKind.GROUND_PASS : KickKind.LOB_PASS;
}

/** SWIPE from the ball by the taker's controller. Returns 1 if used, 0 if ignored. */
function swipeKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  const kind = swipeRequest(s, f, REQ, c.assist, ctrlFlags(c.kind));
  if (kind === KickKind.NONE) return 0;
  const r = s.match.restart;
  r.aimX = PT.x;
  r.aimZ = PT.z;
  r.aimCurve = REQ.curve;
  r.aimPower = REQ.power;
  startKick(s, slot, kind, REQ, ev);
  return 1;
}

/** TAP / DOUBLE_TAP by the taker's controller on a teammate, a spot, or the goal. Returns 1 if used. */
function tapKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  const flags = ReqFlag.GESTURE | ctrlFlags(c.kind);
  const dbl = f.gesture === GestureKind.DOUBLE_TAP;
  const g = f.gSlot;
  if (g === slot) return 0; // the taker himself (a tap on the ball)
  let target = -1;
  let tx: number, tz: number;
  if (g >= 0 && g < NUM_SLOTS && s.players[g]!.active === 1 && s.players[g]!.team === team) {
    target = g;
    tx = s.players[g]!.x;
    tz = s.players[g]!.z;
  } else {
    const gx = f.gx / GESTURE_POS_SCALE, gz = f.gz / GESTURE_POS_SCALE;
    if (!(gx === gx && gz === gz) || gx === Infinity || gx === -Infinity || gz === Infinity || gz === -Infinity) return 0;
    tx = clamp(gx, -HALF_LENGTH, HALF_LENGTH);
    tz = clamp(gz, -HALF_WIDTH, HALF_WIDTH);
  }
  const dx = tx - r.x, dz = tz - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < LT.tapMinDist) return 0;
  let kind: KickKind;
  if (target < 0 && (f.gFlags & GestureFlag.ON_GOAL) !== 0) {
    // Tap on the goal: chip shot there.
    resetReq(REQ, c.assist, flags);
    const gl = dir * HALF_LENGTH;
    const zt = clamp(tz, -GOAL_HALF_WIDTH, GOAL_HALF_WIDTH);
    reqDirTo(s, REQ, gl, zt);
    REQ.hasTarget = 1;
    REQ.targetX = gl;
    REQ.targetZ = zt;
    REQ.power = clamp(LT.defaultPowerBase, 0, 1);
    REQ.curve = clamp(finiteOr(r.aimCurve, 0), -1, 1);
    tx = gl;
    tz = zt;
    kind = KickKind.SHOT_CHIP;
  } else if (inArea(tx, tz, dir, target >= 0 ? LT.crossAreaExtra : 0)) {
    kind = KickKind.CROSS;
    resetReq(REQ, c.assist, flags | (dbl ? ReqFlag.LOFTED : 0));
    reqDirTo(s, REQ, tx, tz);
    REQ.targetSlot = target;
    REQ.hasTarget = 1;
    REQ.targetX = tx;
    REQ.targetZ = tz;
    REQ.power = crossPower(d);
  } else {
    kind = !dbl && d <= LT.tapGroundMax ? KickKind.GROUND_PASS : KickKind.LOB_PASS;
    resetReq(REQ, c.assist, flags);
    reqDirTo(s, REQ, tx, tz);
    REQ.targetSlot = target;
    if (target < 0) { REQ.hasTarget = 1; REQ.targetX = tx; REQ.targetZ = tz; }
    REQ.power = kind === KickKind.GROUND_PASS ? freeKickShortPower(d) : lobPower(d);
  }
  const pw = f.power;
  if (pw > 0 && pw === pw) REQ.power = clamp(pw / UNIT_SCALE, 0, 1);
  r.aimX = tx;
  r.aimZ = tz;
  startKick(s, slot, kind, REQ, ev);
  return 1;
}

// ---------------------------------------------------------------- input

/** A controller not holding the taker / not in the wall moves its free controlled player with the stick. */
function moveOffBall(s: SimState, c: Readonly<{ slot: number; side: number; buttons: number }>, f: Readonly<InputFrame>,
  allowSprint: boolean): void {
  const slot = c.slot;
  if (slot < 0 || slot >= NUM_SLOTS || slot === s.match.restart.taker) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== c.side || p.act !== ActionKind.NONE || p.stunT > 0) return;
  let mx = f.mx / AXIS_SCALE, mz = f.mz / AXIS_SCALE;
  if (!(mx === mx && mz === mz)) return;
  const m = Math.sqrt(mx * mx + mz * mz);
  if (m <= T_INPUT.stickIdle) return; // the resolver has already stopped a stale intent
  if (m > 1) { mx /= m; mz /= m; }
  p.moveMode = MoveMode.DIRECT;
  p.ix = mx;
  p.iz = mz;
  p.wantSprint = allowSprint && (c.buttons & Btn.SPRINT) !== 0 ? 1 : 0;
  p.lookAt = 0;
}

function attackInput(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel; buttons: number;
  prevButtons: number }>, t: number, f: Readonly<InputFrame>, ev: EventSink): void {
  const pressed = c.buttons & ~c.prevButtons;
  if ((pressed & Btn.SPRINT) !== 0 && cycleFreeKickTaker(s) >= 0) return;
  aimFromStick(s, f);
  curlFromRightStick(s, f);
  const g = f.gesture;
  if (g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) {
    if (tapKick(s, c, t, f, ev) === 1) return;
  } else if (g === GestureKind.SWIPE || g === GestureKind.CURVED_SWIPE || g === GestureKind.BACK_FORTH_SWIPE) {
    if (swipeKick(s, c, t, f, ev) === 1) return;
  }
  const modL = (c.buttons & Btn.MOD_L) !== 0;
  const modR = (c.buttons & Btn.MOD_R) !== 0;
  const fl = ctrlFlags(c.kind);
  const r = s.match.restart;
  if ((pressed & Btn.SHOOT) !== 0) {
    const kind = fillShot(s, REQ, modL, modR, c.assist, fl);
    reqPowerFrom(REQ, f);
    startKick(s, t, kind, REQ, ev);
  } else if ((pressed & Btn.PASS) !== 0) {
    resetReq(REQ, c.assist, fl | (modL && !modR ? ReqFlag.PASS_AND_GO : 0));
    reqPowerFrom(REQ, f);
    reqDirTo(s, REQ, r.aimX, r.aimZ);
    startKick(s, t, modR ? KickKind.DRIVEN_PASS : KickKind.GROUND_PASS, REQ, ev);
  } else if ((pressed & Btn.LOB) !== 0) {
    const kind = fillLob(s, REQ, modL, modR, c.assist, fl);
    reqPowerFrom(REQ, f);
    startKick(s, t, kind, REQ, ev);
  } else if ((pressed & Btn.THROUGH) !== 0) {
    resetReq(REQ, c.assist, fl);
    reqPowerFrom(REQ, f);
    reqDirTo(s, REQ, r.aimX, r.aimZ);
    startKick(s, t, modL ? KickKind.THROUGH_LOBBED : KickKind.THROUGH_GROUND, REQ, ev);
  }
}

/** Wall jump: every free / ARMED member jumps now. Returns the number of members that jumped. */
export function wallJump(s: SimState, ev: EventSink): number {
  if (!fkPhase(s)) return 0;
  const r = s.match.restart;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  let jumped = 0;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (!memberOk(s, w)) continue;
    const p = s.players[w]!;
    const armed = p.act === ActionKind.WALL_JUMP && p.actA === WallMode.ARMED;
    if ((p.act !== ActionKind.NONE && !armed) || p.stunT > 0) continue;
    beginAction(p, ActionKind.WALL_JUMP, LT.jumpCrouchTicks + LT.jumpAirTicks + LT.jumpLandTicks, LT.jumpCrouchTicks);
    p.actA = WallMode.JUMP;
    p.actB = 0;
    p.actKick = KickKind.NONE;
    p.actSlot = -1;
    p.actX = p.x;
    p.actZ = p.z;
    p.actDirX = s.match.restart.taken === 1 ? s.ball.lastKickTick : -1;
    p.actDirZ = 0;
    holdStill(s, p);
    ev.emit(EventType.WALL, w, WallMode.JUMP);
    jumped++;
  }
  return jumped;
}

/** Wall charge: every free member is ARMED (charges at the kick). Returns the number armed. */
export function wallArmCharge(s: SimState): number {
  if (!fkLive(s)) return 0;
  const r = s.match.restart;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  let armed = 0;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (!memberOk(s, w)) continue;
    const p = s.players[w]!;
    if (p.act !== ActionKind.NONE || p.stunT > 0) continue;
    beginAction(p, ActionKind.WALL_JUMP, LT.armedWaitTicks, -1);
    p.actA = WallMode.ARMED;
    p.actB = 0;
    p.actKick = KickKind.NONE;
    p.actSlot = -1;
    p.actX = p.x;
    p.actZ = p.z;
    p.actDirX = -1;
    p.actDirZ = 0;
    holdStill(s, p);
    armed++;
  }
  return armed;
}

function defendInput(s: SimState, c: Readonly<{ slot: number; side: number; buttons: number; prevButtons: number }>,
  f: Readonly<InputFrame>, ev: EventSink): void {
  const r = s.match.restart;
  if (r.wallCount > 0) {
    const pressed = c.buttons & ~c.prevButtons;
    if ((pressed & Btn.THROUGH) !== 0) wallJump(s, ev);
    else if ((pressed & Btn.PASS) !== 0) wallArmCharge(s);
    const l = (c.buttons & Btn.SHIELD) !== 0, rr = (c.buttons & Btn.SPRINT) !== 0;
    if (l !== rr) moveWall(s, l ? 1 : -1);
  }
  if (wallIndexOf(s, c.slot) < 0) moveOffBall(s, c, f, false);
}

// ---------------------------------------------------------------- WALL_JUMP action

/** Still, LOCKED, facing the ball spot. */
function holdStill(s: SimState, p: PlayerState): void {
  const r = s.match.restart;
  p.moveMode = MoveMode.LOCKED;
  p.vx = 0;
  p.vz = 0;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  const fx = r.x - p.x, fz = r.z - p.z;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-6) { p.fx = fx / fl; p.fz = fz / fl; }
}

function beginBrace(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  beginAction(p, ActionKind.WALL_JUMP, LT.braceMaxTicks, -1);
  p.actA = WallMode.BRACE;
  p.actB = 0;
  p.actKick = KickKind.NONE;
  p.actSlot = -1;
  p.actX = p.x;
  p.actZ = p.z;
  p.actDirX = s.ball.lastKickTick;
  p.actDirZ = 0;
  holdStill(s, p);
}

function beginCharge(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (p.act === ActionKind.WALL_JUMP && p.actA === WallMode.CHARGE) return;
  const r = s.match.restart;
  beginAction(p, ActionKind.WALL_JUMP, LT.chargeTicks, -1);
  p.actA = WallMode.CHARGE;
  p.actB = 0;
  p.actKick = KickKind.NONE;
  p.actSlot = -1;
  p.actX = r.x;
  p.actZ = r.z;
  p.actDirX = s.ball.lastKickTick;
  p.actDirZ = 0;
  ev.emit(EventType.WALL, slot, WallMode.CHARGE);
}

/** CHARGE: run at chargeSpeed toward the ball spot (LOCKED, velocity set every tick), stopping chargeStopDist from it. */
function chargeMove(p: PlayerState): void {
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  const dx = p.actX - p.x, dz = p.actZ - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > LT.chargeStopDist)) { p.vx = 0; p.vz = 0; return; }
  const ux = dx / d, uz = dz / d;
  p.vx = ux * LT.chargeSpeed;
  p.vz = uz * LT.chargeSpeed;
  p.fx = ux;
  p.fz = uz;
}

/**
 * The ball is live from this free kick, struck at tick strike = p.actDirX of wall member p: the taker's kick of that tick
 * (untouched since), or a wall deflection after it.
 */
function wallBallLive(s: SimState, p: Readonly<PlayerState>): boolean {
  const r = s.match.restart;
  const b = s.ball;
  const strike = p.actDirX;
  if (r.taken !== 1 || !(strike >= 0) || !wallRecord(s)) return false;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return false;
  const lt = b.lastTouch;
  if (lt < 0 || b.lastKickBy !== lt || b.lastTouchTick !== b.lastKickTick) return false;
  if (lt === r.taker) return b.lastKickTick === strike;
  return b.lastKickKind === KickKind.DEFLECTION && b.lastKickTick > strike && wallIndexOf(s, lt) >= 0;
}

/**
 * Swept test of the ball path (x0..x0 + dx over this tick) against a vertical cylinder at (cx, cz) of radius rr, for
 * ball-centre heights in [yLo, yHi]; inputs in SWEEP = [x0, y0, z0, dx, dy, dz, rr, cx, cz, yLo, yHi] (module scratch:
 * doubles passed to a non-inlined call are boxed). HIT[0] = earliest contact fraction 0..1, or -1.
 */
function hitTime(): void {
  const S = SWEEP;
  const x0 = S[0]!, y0 = S[1]!, z0 = S[2]!, dx = S[3]!, dy = S[4]!, dz = S[5]!, rr = S[6]!;
  const cx = S[7]!, cz = S[8]!, yLo = S[9]!, yHi = S[10]!;
  HIT[0] = -1;
  const ox = x0 - cx, oz = z0 - cz;
  const a = dx * dx + dz * dz;
  const bq = 2 * (ox * dx + oz * dz);
  const cq = ox * ox + oz * oz - rr * rr;
  let tIn: number, tOut: number;
  if (cq <= 0) {
    tIn = 0;
    if (a < 1e-12) tOut = 1;
    else {
      const disc = bq * bq - 4 * a * cq;
      tOut = (-bq + Math.sqrt(disc > 0 ? disc : 0)) / (2 * a);
    }
  } else {
    if (a < 1e-12) return;
    const disc = bq * bq - 4 * a * cq;
    if (!(disc >= 0)) return;
    const sq = Math.sqrt(disc);
    tIn = (-bq - sq) / (2 * a);
    tOut = (-bq + sq) / (2 * a);
  }
  if (!(tIn <= 1) || !(tOut >= 0)) return;
  if (tIn < 0) tIn = 0;
  if (tOut > 1) tOut = 1;
  const yIn = y0 + dy * tIn;
  if (yIn >= yLo && yIn <= yHi) { HIT[0] = tIn; return; }
  if (yIn > yHi) {
    if (!(dy < 0)) return;
    const tc = (yHi - y0) / dy;
    if (tc >= tIn && tc <= tOut) HIT[0] = tc;
    return;
  }
  if (!(dy > 0)) return;
  const tc = (yLo - y0) / dy;
  if (tc >= tIn && tc <= tOut) HIT[0] = tc;
}

/**
 * Deflect the ball off wall member `w` at fraction t of this tick's path (NEXT = the ball one tick on). Returns 1 if the
 * ball was played (it was moving into him), else 0.
 */
function deflect(s: SimState, w: number, t: number, ev: EventSink): number {
  const b = s.ball;
  const p = s.players[w]!;
  const cx = b.x + (NEXT.x - b.x) * t;
  let cy = b.y + (NEXT.y - b.y) * t;
  const cz = b.z + (NEXT.z - b.z) * t;
  const vx = b.vx + (NEXT.vx - b.vx) * t;
  const vy = b.vy + (NEXT.vy - b.vy) * t;
  const vz = b.vz + (NEXT.vz - b.vz) * t;
  const lift = p.actA === WallMode.JUMP ? jumpLift(p.actT) : 0;
  const top = lift + memberHeight(s, w);
  let nx = cx - p.x, nz = cz - p.z;
  let nl = Math.sqrt(nx * nx + nz * nz);
  if (nl < 1e-6) {
    nx = -vx; nz = -vz;
    nl = Math.sqrt(nx * nx + nz * nz);
    if (nl < 1e-6) { nx = 1; nz = 0; nl = 1; }
  }
  nx /= nl; nz /= nl;
  let ny = 0;
  const capFrom = top - LT.topCapBand;
  if (cy > capFrom) {
    const k = clamp((cy - capFrom) / (LT.topCapBand + BALL_RADIUS), 0, 1);
    nx *= 1 - k; nz *= 1 - k; ny = k;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= l; ny /= l; nz /= l;
  }
  const pvx = p.vx, pvz = p.vz;
  const rvx = vx - pvx, rvz = vz - pvz;
  const vn = rvx * nx + vy * ny + rvz * nz;
  if (!(vn < 0)) return 0;
  const tx = rvx - vn * nx, ty = vy - vn * ny, tz = rvz - vn * nz;
  const e = LT.blockRestitution, keep = 1 - LT.blockFriction;
  let ox = -e * vn * nx + keep * tx + pvx;
  let oy = -e * vn * ny + keep * ty;
  let oz = -e * vn * nz + keep * tz + pvz;
  const sp = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const vmax = T_BALL.maxSpeed;
  if (sp > vmax) { ox *= vmax / sp; oy *= vmax / sp; oz *= vmax / sp; }
  if (cy < BALL_RADIUS) cy = BALL_RADIUS;
  b.x = cx; b.y = cy; b.z = cz;
  const L = LAUNCH;
  L.vx = ox; L.vy = oy; L.vz = oz;
  L.sx = b.sx * LT.blockSpinKeep; L.sy = b.sy * LT.blockSpinKeep; L.sz = b.sz * LT.blockSpinKeep;
  L.kind = KickKind.DEFLECTION;
  L.target = -1;
  L.tx = cx;
  L.tz = cz;
  L.onTarget = 0;
  const vin = Math.sqrt(vx * vx + vy * vy + vz * vz);
  applyKick(s, w, L, clamp(vin / T_SHOT.powerShotMax, 0, 1), ev);
  if (oy > 0.5) b.grounded = 0;
  return 1;
}

/**
 * Wall blocking for this tick (once per tick and ball state; see header), run by wall member `p` (whose actDirX holds
 * the free kick's strike tick). Returns 1 if the ball was deflected.
 */
function blockCheck(s: SimState, p: Readonly<PlayerState>, ev: EventSink): number {
  if (ballTouchedThisTick(s) || !wallBallLive(s, p)) return 0;
  const b = s.ball;
  const sp2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (!(sp2 >= LT.blockMinSpeed * LT.blockMinSpeed)) return 0;
  const K = BLOCK_KEY;
  if (K[0] === s.tick && K[1] === b.x && K[2] === b.y && K[3] === b.z && K[4] === b.vx && K[5] === b.vy && K[6] === b.vz) {
    return 0; // already evaluated for this exact ball this tick (no contact)
  }
  K[0] = s.tick; K[1] = b.x; K[2] = b.y; K[3] = b.z; K[4] = b.vx; K[5] = b.vy; K[6] = b.vz;
  copyBallState(NEXT, b);
  ballStepTick(NEXT, null);
  const dx = NEXT.x - b.x, dy = NEXT.y - b.y, dz = NEXT.z - b.z;
  const r = s.match.restart;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  const S = SWEEP;
  S[0] = b.x; S[1] = b.y; S[2] = b.z; S[3] = dx; S[4] = dy; S[5] = dz; S[6] = LT.wallBlockRadius + BALL_RADIUS;
  let bestT = 2;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (!memberOk(s, w)) continue;
    const q = s.players[w]!;
    if (q.act !== ActionKind.WALL_JUMP) continue;
    const at = q.actT;
    const lift = q.actA === WallMode.JUMP && at >= 0 && at < JUMP_TICKS ? JUMP_LIFT[at | 0]! : 0;
    const ha = s.attrs[w]!.height; // memberHeight, inline
    let hm = ha - ha === 0 ? ha / 100 : 1.8;
    hm = hm < LT.heightMin ? LT.heightMin : hm > LT.heightMax ? LT.heightMax : hm;
    S[7] = q.x; S[8] = q.z; S[9] = lift - BALL_RADIUS; S[10] = lift + hm + BALL_RADIUS;
    hitTime();
    const t = HIT[0]!;
    if (t >= 0 && t < bestT) { bestT = t; best = w; }
  }
  if (best < 0) return 0;
  return deflect(s, best, bestT, ev);
}

/** BRACE is over: the ball passed him, no longer comes at him, is played by someone else, or his human breaks out. */
function braceDone(s: SimState, p: PlayerState): boolean {
  const r = s.match.restart;
  const b = s.ball;
  if (!wallBallLive(s, p)) return true;
  const ux0 = p.x - r.x, uz0 = p.z - r.z;
  const ul = Math.sqrt(ux0 * ux0 + uz0 * uz0);
  if (ul > 1e-6) {
    const proj = ((b.x - r.x) * ux0 + (b.z - r.z) * uz0) / ul;
    if (proj > ul + LT.wallPassMargin) return true;
  }
  if (b.vx * (p.x - b.x) + b.vz * (p.z - b.z) <= 0) return true;
  const ci = p.ctrl;
  if (ci >= 0 && ci < s.ctrl.length) {
    const c = s.ctrl[ci]!;
    if (c.kind === ControllerKind.HUMAN && c.mx * c.mx + c.mz * c.mz > LT.breakStick * LT.breakStick) return true;
  }
  return false;
}

function wallUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const r = s.match.restart;
  if (p.active !== 1 || wallIndexOf(s, slot) < 0) {
    p.actDur = p.actT; // the dispatcher ends the action after this update (the free kick and its play are over)
    return;
  }
  const mode = p.actA;
  if (mode === WallMode.ARMED) {
    if (r.taken === 0 && s.match.phase === MatchPhase.FREE_KICK) {
      holdStill(s, p);
      if (p.actT + 1 >= p.actDur) p.actDur = p.actT + LT.armedWaitTicks;
      return;
    }
    if (r.taken === 1 && s.ball.lastKickBy === r.taker && s.tick - s.ball.lastKickTick <= 1) {
      beginCharge(s, slot, ev);
      chargeMove(p);
      blockCheck(s, p, ev);
      return;
    }
    p.actDur = p.actT; // the free kick is gone
    return;
  }
  if (mode === WallMode.CHARGE) chargeMove(p);
  else holdStill(s, p);
  const at = p.actT;
  p.actB = mode === WallMode.JUMP && at >= 0 && at < JUMP_TICKS ? JUMP_LIFT[at | 0]! : 0;
  if (r.taken === 1) {
    blockCheck(s, p, ev);
    if (mode === WallMode.BRACE && braceDone(s, p)) p.actDur = p.actT;
    else if (mode === WallMode.JUMP && p.actT + 1 >= p.actDur && p.act === ActionKind.WALL_JUMP && !braceDone(s, p)) {
      // Landed before the ball got there: he stands braced for the rest of the brace window (never a hole in the wall).
      const left = LT.braceMaxTicks - (s.tick - p.actDirX);
      if (left > 0) {
        p.actA = WallMode.BRACE;
        p.actB = 0;
        p.actContact = -1;
        p.actDur = p.actT + left;
      }
    }
  } else if (mode === WallMode.BRACE || mode === WallMode.CHARGE || s.match.phase !== MatchPhase.FREE_KICK) {
    p.actDur = p.actT; // brace / charge exist only after the kick; an abandoned free kick ends the jump
  }
}

function wallEnd(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.actB = 0;
  p.lookAt = 0;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
}

/** In the tick the free kick is struck: free members brace, ARMED members charge. */
function onKickTaken(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (!(r.wallCount > 0) || s.ball.lastKickTick !== s.tick) return;
  const n = r.wallCount > MAX_WALL ? MAX_WALL : r.wallCount;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (!memberOk(s, w)) continue;
    const p = s.players[w]!;
    if (p.act === ActionKind.NONE && p.stunT <= 0) beginBrace(s, w);
    else if (p.act === ActionKind.WALL_JUMP && p.actA === WallMode.ARMED) beginCharge(s, w, ev);
    else if (p.act === ActionKind.WALL_JUMP) p.actDirX = s.tick; // jumping as it is struck
  }
}

// ---------------------------------------------------------------- Default

/** Default shot: over the wall to the inside of the post it covers, curling back in, power by distance. */
function defaultShot(s: SimState, t: number, ev: EventSink): number {
  const r = s.match.restart;
  const dir = attackDir(s, r.team);
  const gx = dir * HALF_LENGTH;
  let side = wallCoverSide(s);
  if (side === 0) side = r.z < 0 ? -1 : 1;
  const tz = side * (GOAL_HALF_WIDTH - LT.defaultPostInset);
  const dx = gx - r.x, dz = tz - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  // Positive curl bends toward n = (-uz, ux) (InputFrame convention): bend toward the goal centre.
  const nzComp = d > 1e-6 ? dx / d : dir;
  const bend = -tz; // the goal centre is toward -tz from the aim
  const sgn = nzComp * bend >= 0 ? 1 : -1;
  const curl = clamp(LT.defaultCurlBase + LT.defaultCurlAttr * (s.attrs[t]!.curve - 60) / 40, 0.3, 0.85);
  r.aimX = gx;
  r.aimZ = tz;
  r.aimCurve = sgn * curl;
  const dg = Math.sqrt((gx - r.x) * (gx - r.x) + r.z * r.z);
  const kind = fillShot(s, REQ, false, false, AssistLevel.ASSISTED, 0);
  REQ.power = clamp(LT.defaultPowerBase + (dg - 18) * LT.defaultPowerPerM, LT.defaultPowerMin, LT.defaultPowerMax);
  REQ.charging = 0;
  return startKick(s, t, kind, REQ, ev);
}

/** Default cross to the best header in the attacked box (else the penalty-spot area). */
function defaultCross(s: SimState, t: number, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  const first = teamFirstSlot(team);
  let best = -1;
  let bestScore = -1e18;
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (slot === t) continue;
    const q = s.players[slot]!;
    if (q.active !== 1 || q.isKeeper === 1 || !inArea(q.x, q.z, dir, 0)) continue;
    const a = s.attrs[slot]!;
    const open = openness(s, team, q.x, q.z);
    const sc = a.heading + LT.heightWeight * (a.height - 180) + LT.crossOpenWeight * (open < LT.crossOpenCap ? open : LT.crossOpenCap);
    if (sc > bestScore) { bestScore = sc; best = slot; }
  }
  let tx: number, tz: number;
  if (best >= 0) { tx = s.players[best]!.x; tz = s.players[best]!.z; } else { tx = dir * (HALF_LENGTH - PENALTY_SPOT_DIST); tz = 0; }
  resetReq(REQ, AssistLevel.ASSISTED, 0);
  reqDirTo(s, REQ, tx, tz);
  REQ.targetSlot = best;
  REQ.hasTarget = 1;
  REQ.targetX = tx;
  REQ.targetZ = tz;
  const d = Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z));
  REQ.power = crossPower(d);
  r.aimX = tx;
  r.aimZ = tz;
  return startKick(s, t, KickKind.CROSS, REQ, ev);
}

/** Best open teammate for the Default pass (openness, progress, length), -1 if none in range. */
function bestPassTarget(s: SimState, t: number): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  const first = teamFirstSlot(team);
  let best = -1;
  let bestScore = -1e18;
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (slot === t) continue;
    const q = s.players[slot]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const dx = q.x - r.x, dz = q.z - r.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < LT.passMinDist || d > LT.passMaxDist) continue;
    const open = openness(s, team, q.x, q.z);
    const sc = LT.openWeight * (open < LT.openCap ? open : LT.openCap) + LT.progressWeight * dir * dx -
      (d > LT.passLongFrom ? (d - LT.passLongFrom) * LT.passLongPenalty : 0);
    if (sc > bestScore) { bestScore = sc; best = slot; }
  }
  return best;
}

function defaultPass(s: SimState, t: number, ev: EventSink): number {
  const r = s.match.restart;
  const q = bestPassTarget(s, t);
  if (q < 0) return 0;
  const tx = s.players[q]!.x, tz = s.players[q]!.z;
  const d = Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z));
  r.aimX = tx;
  r.aimZ = tz;
  for (let k = 0; k < 2; k++) {
    const lob = k === 0 && d > LT.tapGroundMax;
    if (k === 1 && d <= LT.tapGroundMax) break;
    resetReq(REQ, AssistLevel.ASSISTED, 0);
    reqDirTo(s, REQ, tx, tz);
    REQ.targetSlot = q;
    REQ.power = lob ? lobPower(d) : freeKickShortPower(d);
    if (startKick(s, t, lob ? KickKind.LOB_PASS : KickKind.GROUND_PASS, REQ, ev) === 1) return 1;
  }
  return 0;
}

/** Last resort: a ground pass straight toward the attacked goal (SIM-08 picks a receiver in the cone). */
function defaultForward(s: SimState, t: number, ev: EventSink): number {
  const r = s.match.restart;
  resetReq(REQ, AssistLevel.ASSISTED, 0);
  reqDirTo(s, REQ, attackDir(s, r.team) * HALF_LENGTH, 0);
  REQ.power = LT.forwardPower;
  return startKick(s, t, KickKind.GROUND_PASS, REQ, ev);
}

/** Default kick (shared by freeKickDefault and the CPU fallback). Returns 1 if a kick started. */
function takeDefault(s: SimState, ev: EventSink): number {
  if (!fkLive(s)) return 0;
  const r = s.match.restart;
  let t = r.taker;
  if (!isValidTaker(s, t)) {
    t = pickFreeKickTaker(s);
    if (t < 0) return 0;
    r.taker = t;
  }
  if (!takerWaiting(s.players[t]!)) return 0; // already kicking (no double kick) or down: the safety nets take over
  ensureAim(s);
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  if (r.wallCount > 0 && defaultShot(s, t, ev) === 1) return 1;
  const u = HALF_LENGTH - dir * r.x;
  const az = r.z < 0 ? -r.z : r.z;
  if (u <= CROSS_ZONE_DEPTH && az >= CROSS_ZONE_MIN_Z && defaultCross(s, t, ev) === 1) return 1;
  if (defaultPass(s, t, ev) === 1) return 1;
  return defaultForward(s, t, ev);
}

// ---------------------------------------------------------------- per-tick upkeep

/** The waiting taker lines up behind the ball along the aim (within RUL-11's reach of the spot). */
function lineUp(s: SimState, p: PlayerState): void {
  const r = s.match.restart;
  restartLookPoint(s, LOOK);
  let ux = LOOK.x - r.x, uz = LOOK.z - r.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) return;
  ux /= ul; uz /= ul;
  const behind = RESTART_TUNING.takerBehind;
  const dx = r.x - ux * behind - p.x, dz = r.z - uz * behind - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const step = LT.lineUpStep;
  if (d <= step) { p.x += dx; p.z += dz; } else if (d > 1e-9) { p.x += (dx / d) * step; p.z += (dz / d) * step; }
  // Never closer to the ball than his spot (the slide follows the circle around it, not the chord).
  const bx = p.x - r.x, bz = p.z - r.z;
  const bd = Math.sqrt(bx * bx + bz * bz);
  if (bd > 1e-6 && bd < behind) { p.x = r.x + (bx / bd) * behind; p.z = r.z + (bz / bd) * behind; }
}

// ---------------------------------------------------------------- restart API

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function freeKickSetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.FREE_KICK) return;
  const team = r.team === 1 ? 1 : 0;
  const dir = attackDir(s, team);
  const mx = HALF_LENGTH - LT.spotInset, mz = HALF_WIDTH - LT.spotInset;
  let x = clamp(finiteOr(r.x, finiteOr(s.ball.x, 0)), -mx, mx);
  const z = clamp(finiteOr(r.z, finiteOr(s.ball.z, 0)), -mz, mz);
  if (inGoalArea(x, z, dir)) x = dir * (HALF_LENGTH - GOAL_AREA_DEPTH);
  r.x = x;
  r.z = z;
  placeBall(s, x, z, ev);
  pickWall(s);
  r.aimCurve = 0;
  r.aimPower = 0;
  r.side = 0;
  defaultAim(s);
  r.taker = pickFreeKickTaker(s);
}

/** Per tick while the phase is active. */
export function freeKickTick(s: SimState, ev: EventSink): void {
  if (!fkPhase(s)) return;
  const r = s.match.restart;
  if (r.taken === 1) { onKickTaken(s, ev); return; }
  ensureAim(s);
  if (r.wallCount > 0) {
    if (!wallValid(s)) repickWall(s);
    if (r.ready === 1 && r.wallCount > 0) placeWall(s, r.t === T_RULES.restartSetupTicks);
  }
  if (r.ready !== 1) return;
  const t = r.taker;
  if (!isValidTaker(s, t)) return; // RUL-11 re-picks
  const p = s.players[t]!;
  if (p.act === ActionKind.SET_PIECE) lineUp(s, p);
  else if (p.actCharging === 1 && isKickAct(p.act)) r.aimPower = clamp(p.actPower, 0, 1);
  // A side without a human: the CPU brain (TAI-13) normally takes it after cpuRestartDelay; fall back to the Default.
  if (!teamHasHuman(s, r.team)) {
    const waited = r.t - T_RULES.restartSetupTicks;
    const due = T_RULES.cpuRestartDelay + LT.cpuGraceTicks;
    if (waited >= due && (waited - due) % LT.cpuRetryTicks === 0) takeDefault(s, ev);
  }
}

/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function freeKickInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  if (!fkLive(s)) return;
  if (!(ctrlIdx >= 0 && ctrlIdx < s.ctrl.length)) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || (c.side !== 0 && c.side !== 1)) return;
  const r = s.match.restart;
  if (r.ready !== 1) return;
  if (c.side !== r.team) { defendInput(s, c, f, ev); return; }
  const t = r.taker;
  if (c.slot !== t) { moveOffBall(s, c, f, true); return; }
  if (!isValidTaker(s, t) || !takerWaiting(s.players[t]!)) return; // kicking already (power bar) or down
  attackInput(s, c, t, f, ev);
}

/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function freeKickDefault(s: SimState, ev: EventSink): void {
  takeDefault(s, ev);
}

// ---------------------------------------------------------------- preview (TCH-06 / GFX-13)

/** The private scratch copy of `s` for previews (cloned once, then copied in place). */
function scratchOf(s: SimState): SimState {
  if (SCR === null || SCR.config !== s.config || SCR.squads !== s.squads) SCR = cloneState(s);
  else copyState(SCR, s);
  const g = SCR.rng;
  g.a = PREVIEW_SEED.a; g.b = PREVIEW_SEED.b; g.c = PREVIEW_SEED.c; g.d = PREVIEW_SEED.d;
  return SCR;
}

/** Request for the preview (from a swipe in f, else the current aim) into PREV_REQ; returns the kind. */
function previewRequest(s: SimState, f: Readonly<InputFrame> | null | undefined): KickKind {
  const r = s.match.restart;
  if (f) {
    const k = swipeRequest(s, f, PREV_REQ, AssistLevel.ASSISTED, 0);
    if (k !== KickKind.NONE) { PREV_REQ.charging = 0; return k; }
  }
  const power = r.aimPower > 0 && r.aimPower <= 1 ? r.aimPower : LT.previewPower;
  const kind = freeKickAimOnGoal(s) ? fillShot(s, PREV_REQ, false, false, AssistLevel.ASSISTED, 0)
    : fillLob(s, PREV_REQ, false, false, AssistLevel.ASSISTED, 0);
  PREV_REQ.power = power;
  PREV_REQ.charging = 0;
  return kind;
}

/** Estimated launch when the kick module refuses (stub): toward the request's target / direction. */
function estimateLaunch(s: SimState, kind: KickKind, req: Readonly<ActionRequest>, out: KickLaunch): void {
  const b = s.ball;
  let ux = req.dirX, uz = req.dirZ;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = attackDir(s, s.match.restart.team); uz = 0; }
  const power = clamp(finiteOr(req.power, LT.previewPower), 0, 1);
  const curve = clamp(finiteOr(req.curve, 0), -1, 1);
  out.kind = kind;
  out.target = req.targetSlot;
  out.tx = req.hasTarget === 1 ? req.targetX : b.x + ux * LT.aimPassDist;
  out.tz = req.hasTarget === 1 ? req.targetZ : b.z + uz * LT.aimPassDist;
  out.onTarget = 0;
  if (isShotKind(kind)) {
    const mul = kind === KickKind.SHOT_FINESSE ? T_SHOT.finesseSpeedMul : kind === KickKind.SHOT_CHIP ? T_SHOT.chipSpeedMul : 1;
    const v = (T_SHOT.speedMin + (T_SHOT.speedMax - T_SHOT.speedMin) * power) * mul;
    const th = LT.previewShotAngle + (kind === KickKind.SHOT_CHIP ? LT.previewChipAngle : 0);
    const ch = dcos(th), sh = dsin(th);
    out.vx = ux * v * ch; out.vz = uz * v * ch; out.vy = v * sh;
    const back = kind === KickKind.SHOT_CHIP ? T_SHOT.chipBackspin : -freeKickDip(s) * T_SHOT.chipBackspin * 0.5;
    launchSpin(ux, uz, curlSpinY(curve * T_SHOT.finesseSpin), back, SPIN);
    out.sx = SPIN.x; out.sy = SPIN.y; out.sz = SPIN.z;
    return;
  }
  if (isLobKind(kind) && kind !== KickKind.GROUND_CROSS) {
    solveLaunchSpin(out.tx - b.x, out.tz - b.z, T_PASS.lobAngle, b.y, curlSpinY(curve * T_SHOT.finesseSpin * 0.5), 0, SOL);
    out.vx = SOL.vx; out.vy = SOL.vy; out.vz = SOL.vz; out.sx = SOL.sx; out.sy = SOL.sy; out.sz = SOL.sz;
    return;
  }
  const dx = out.tx - b.x, dz = out.tz - b.z;
  const v = clamp(groundPassSpeed(Math.sqrt(dx * dx + dz * dz), LT.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
  out.vx = ux * v; out.vz = uz * v; out.vy = 0; out.sx = 0; out.sy = 0; out.sz = 0;
}

/**
 * Predicted flight (first LOCAL_TUNING.previewTicks ticks, sample i = ball after i + 1 ticks from the strike) of the kick
 * the free-kick taker would play now: the swipe from the ball in `f` when given (touch, while dragging), else his
 * current aim / curl / dip and power (restart.aimPower, previewPower before a power is known); his kick in progress when
 * he is winding up or charging. Uses the kick module's starter and KickSolver on a private scratch copy (the state is
 * never touched), then SIM-01 predictBall: the same physics as the sim. Returns 1 (solver), 2 (estimated launch: the
 * kick module refused), or 0 (no free kick to preview; out.count = 0).
 */
export function previewFlight(s: SimState, out: BallPrediction, f?: Readonly<InputFrame> | null): number {
  out.count = 0;
  out.landIndex = -1;
  if (!fkPhase(s)) return 0;
  const r = s.match.restart;
  if (r.taken === 1) return 0;
  const t = r.taker;
  if (!isValidTaker(s, t)) return 0;
  const scr = scratchOf(s);
  const p = scr.players[t]!;
  const L = PREV_LAUNCH;
  let ok = 0;
  let kind: KickKind;
  if (isKickAct(p.act) && p.actDone === 0) {
    // His kick is winding up / charging: the live action as it stands.
    kind = p.actKick;
    const solver = KICK_SOLVERS[kind];
    if (solver && solver(scr, t, L) === 1) {
      ok = 1;
    } else {
      const sr = scr.match.restart;
      resetReq(PREV_REQ, AssistLevel.ASSISTED, 0);
      reqDirTo(scr, PREV_REQ, sr.aimX, sr.aimZ);
      PREV_REQ.hasTarget = 1;
      PREV_REQ.targetX = sr.aimX;
      PREV_REQ.targetZ = sr.aimZ;
      PREV_REQ.targetSlot = p.actSlot;
      PREV_REQ.power = p.actPower;
      PREV_REQ.curve = p.actCurve;
    }
  } else if (takerWaiting(p)) {
    kind = previewRequest(scr, f);
    if (kind === KickKind.NONE) return 0;
    if (startKick(scr, t, kind, PREV_REQ, NULL_SINK) === 1) {
      p.actCharging = 0;
      if (!(p.actPower > 0)) p.actPower = PREV_REQ.power;
      const solver = KICK_SOLVERS[p.actKick];
      if (solver && solver(scr, t, L) === 1) ok = 1;
    }
  } else {
    return 0;
  }
  if (ok === 0) {
    if (kind === KickKind.NONE) return 0;
    estimateLaunch(scr, kind, PREV_REQ, L);
    ok = 2;
  }
  copyBallState(PB, scr.ball);
  PB.owner = -1;
  PB.ownerT = 0;
  PB.heldBy = -1;
  PB.vx = L.vx; PB.vy = L.vy; PB.vz = L.vz;
  PB.sx = L.sx; PB.sy = L.sy; PB.sz = L.sz;
  PB.grounded = L.vy > 0.5 ? 0 : PB.grounded;
  PB.bounces = 0;
  PB.inNet = 0;
  predictBall(PB, LT.previewTicks, out);
  return ok;
}

bindWallJumpImpl({ update: wallUpdate, end: wallEnd });

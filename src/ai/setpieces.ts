/**
 * [TAI-13] Set-piece AI, attacking and defending: scripted positions for corners (incl. corner tactics), free
 * kicks (attackers, wall chosen by RUL-05), throw-ins, goal kicks, kick-offs and penalties (SET_PIECE jobs,
 * legal distances respected so RUL-11 rarely needs to teleport); cpuSetPiece fills the CPU's InputFrame to take
 * set pieces (aim, power hold, curl) and to defend them.
 *
 * Positions (setPiecePositions, every tick of a restart phase and of the shoot-out, for each team):
 *  - One pure layout pass (computeAll) fills a spot for every "candidate" of BOTH teams: active outfield players that
 *    are driven by team AI jobs or by a CPU brain (a CPU-controlled defender is steered to his spot by cpuSetPiece);
 *    never keepers (GKP-06), the restart taker, human-controlled players or the shoot-out kicker. setPiecePositions
 *    then gives each job-driven player of its team AiJob.SET_PIECE at his spot (jog; faster when far).
 *  - Scripted spots per kind come from small templates (metres from a goal line, lateral offset mirrored to the ball's
 *    side); players are matched to them greedily in priority order by a STABLE cost: distance from the player's
 *    formation slot (data/formations slotWorld) times the spot's weight minus a suitability score (heading for box
 *    spots, defenders for markers, ...), so assignments never flip-flop while players walk. Everybody left over holds
 *    his TAI-01 home (kick-off: where RUL-01 put him).
 *      kick-off   - stay where RUL-01 placed everyone (own half; the defending side outside the centre circle).
 *      throw-in   - four short options 5-15 m from the thrower (down the line, square, back, infield); defenders
 *                   man-mark the options goal-side; others hold.
 *      goal kick  - centre-backs split to the corners of the box, a pivot drops, full-backs wide, a target man and a
 *                   second forward on the halfway line (spread for short and long); two opponents press at the box
 *                   edge.
 *      corner     - attackers: penalty spot, far post, near post, edge of the box, a short option 5-10 m from the
 *                   taker, two tactic spots (team.cornerTactic: far post / edge of box / crowd the keeper / near post;
 *                   default a six-yard and a back-post runner) and two players staying back. Defenders: a man on the
 *                   near post, man-markers on the four most dangerous attackers in the box (goal-side), one up for
 *                   the counter, zonal players on the six-yard line, one at the edge of the box, the rest zonal.
 *      free kick  - zones: SHOOT (in range and angle), WIDE (crossing range) and DEEP. Wall members chosen by RUL-05
 *                   (restart.wall) walk to the wall and then hold where RUL-05 puts them; TAI-13 places the others:
 *                   SHOOT - a dummy taker beside the ball, two rebounders at the wall ends, three runners on the
 *                   defensive line, two staying back; defenders mark runners goal-side, hold a line, one up front.
 *                   WIDE - four runners on the defensive line (attackers in the box), edge of the box, a short option,
 *                   two back; defenders: near-post guard (close free kicks), markers, a zonal player, one up front.
 *                   DEEP - two short options; everybody else holds his shape.
 *      penalty    - both teams alternate along the edge of the penalty area outside the arc (rebounds), two attackers
 *                   and one defender further back; all outside the area and the arc.
 *      shoot-out  - every outfield player in the centre circle, the two teams side by side.
 *  - Legal by construction: every non-wall spot is projected into the legal region of RUL-11 (inside the pitch, own
 *    half at kick-offs, 9.15 m / 2 m discs for opponents, penalty-area exclusions, arc at penalties) with a margin
 *    (LOCAL_TUNING.legalMargin), then spots closer than minSpacing to another spot or to a player without a spot
 *    (taker, keepers, humans) are pushed apart and re-legalised, so nobody runs in place against another body.
 *    Walking there is routed too: a player inside a zone first steps out the way RUL-11 pushes him, and a straight walk
 *    that would cross the disc or the penalty area goes round it (routeTo), so RUL-11 never slides him along an edge.
 *
 * CPU (cpuSetPiece, CPU brains only; the frame is resolved like a human's and routed by SIM-15 to the restart kind's
 * input function or RUL-07 shootoutInput):
 *  - Taking side: nothing until restart.ready and restart.t - restartSetupTicks >= T_RULES.cpuRestartDelay (shoot-out:
 *    the kicker has stood on the spot that long), the taker waiting and held by this controller; a cross (corner, free
 *    kick in range) also waits up to maxArrivalWait ticks for minBoxArrivals box runners to reach their spots. Then
 *    one decision (seeded s.rng, level noise T_LEVEL.decisionNoise / executionError) and a short input program:
 *      kick-off   - PASS press.
 *      throw-in   - TAP the best open teammate 3.5-22 m away (gesture = exact target), DOUBLE_TAP one up to 30 m away,
 *                   else a long LOB throw down the line.
 *      goal kick  - like RUL-03's default (an open defender short, else the target man long; DIRECT / COUNTER styles
 *                   go long more often): TAP short, DOUBLE_TAP long. (Its own copy: importing sim/rules/goalkick
 *                   from ai/ would change the module evaluation order other modules' tests mock against.)
 *      corner     - sometimes PASS to the short option, else TAP the best header in the box (corner tactic's zone
 *                   first).
 *      free kick  - SHOOT zone: shot (stick aim at a corner, right stick ax/az + frame.curve curl around the wall,
 *                   SHOOT held for power) by distance, angle and the taker's quality, else a cross; WIDE: cross TAP (or a
 *                   short PASS); DEEP: TAP an open teammate (DOUBLE_TAP beyond tapGroundMax).
 *      penalty / shoot-out kick - stick aim inside a post (natural side bias, inset and level execution error),
 *                   SHOOT held for power.
 *    Button kicks: the stick is held on the aim for aimTicks (shots shotAimTicks; a corner cross steers RUL-04's aim
 *    reticle onto the target first), then the button (with modifiers) is held round(power * powerFillTicks) ticks and
 *    released (the resolver fills the power bar from the hold). If the restart is still not taken retryTicks after the
 *    input and the taker is waiting again, it decides again; a gesture decision is retried with the button equivalent
 *    (PASS / LOB + stick + hold). The CPU acts before the kind modules' own CPU fallbacks (cpuRestartDelay + 60 ticks)
 *    and long before RUL-11's 4 s CPU watchdog.
 *  - Defending side: the CPU-controlled player walks to his set-piece spot with the stick (sprinting when far, except
 *    at free kicks where SPRINT moves the wall; not a wall member, not at kick-offs and penalties); at a free kick with
 *    a wall, THROUGH (wall jump) when the taker's SHOT is wallJumpLeadTicks from contact (+ level timing jitter, drawn
 *    once per kick). Penalty and shoot-out keepers: the dive is GKP-06's (neutral frame). Moving him needs the kind
 *    module to apply an off-ball controller's stick during the restart (RUL-03 does: moveOffBall).
 *  - Brain fields used during restart phases (CpuBrainState; TAI-08..12 own them in open play): p0 = restart key
 *    (negative: -(1 + tick of award), shoot-out: per kick), p1 = step | attempt << 4 | flags << 8 (taking side) or
 *    wall-jump flags (defending side), p2 = buttons of the hold (defending: jump timing offset), p3 = curl -1..1,
 *    plan, planT (ticks in step), planSlot / planX / planZ (target), holdTicks. plan and holdTicks are back to NONE / 0
 *    as soon as the input is complete.
 *
 * Determinism: no Math.sin/cos/atan2 (dmath), no Map/Set, slot-order loops, RNG only at decisions. Per-tick paths are
 * allocation-free (module scratch: typed arrays and one point object; double results go through scratch, never
 * returned from helpers on the hot path). Cost: one layout pass is O(22 x 16) plus an O(22^2) spacing pass.
 */
import {
  BALL_RADIUS, CENTRE_CIRCLE_RADIUS, CPU_CONTROLLER_BASE, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS,
  PENALTY_ARC_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM,
  RESTART_DISTANCE, THROW_IN_DISTANCE, teamFirstSlot,
} from '../contracts/constants';
import {
  ActionKind, AiJob, Command, ControllerKind, Foot, GestureKind, MatchPhase, RestartKind, Role, TeamStyle,
} from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, type InputFrame } from '../contracts/input';
import { CpuPlan, type ControllerState, type CpuBrainState, type PlayerState, type SimState } from '../contracts/state';
import { T_LEVEL, T_PASS, T_PLAYER, T_RULES } from '../contracts/tuning';
import { slotWorld } from '../data/formations';
import { datan2, dcos, dsin } from '../sim/core/dmath';
import { rngFloat, rngGauss, rngRange } from '../sim/core/rng';
import { groundPassSpeed } from '../sim/ball/flight';
import { PHASE_KIND } from '../sim/rules/restartCommon';
import { assignJob, isJobDriven } from './jobs';

/** TUNING-CR (TAI-13): proposed T_SETPIECE block (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  // ---------------------------------------------------------------- positions
  /** Spots stay this far inside the 9.15 m / 2 m discs, the penalty-area exclusions and the arc, m. */
  legalMargin: 0.7,
  /** Spots stay this far inside the touch and goal lines, m. */
  pitchMargin: 0.45,
  /** Kick-off: spots stay this far inside their own half, m (RUL-01 puts the taker's partner 0.6 m behind the line). */
  halfMargin: 0.3,
  /** Minimum distance between two spots, and between a spot and a player without one (> two body radii), m. */
  minSpacing: 1.0,
  /** Routing: a straight walk that passes within routeClear m of an exclusion zone (disc, penalty area) detours via a
   *  point routeOut m beyond the zone's legal margin, so RUL-11 never has to push him along its edge, m. */
  routeClear: 0.4,
  routeOut: 0.5,
  /** Walk-in speed cap as a fraction of top speed; beyond farDist m from the spot farFrac (steer then sprints). */
  jogFrac: 0.6,
  farFrac: 0.85,
  farDist: 15,
  /** Matching cost = spot weight * metres (formation slot -> spot) - suitWeight * suitability (attribute points). */
  suitWeight: 0.6,
  /** Man-marking: distance goal-side of the attacker at corners / free kicks and at throw-ins, m. */
  markDist: 1.0,
  markDistThrow: 1.6,
  /** Most man-markers at corners / free kicks, and at throw-ins. */
  maxMarkers: 4,
  maxThrowMarkers: 3,
  /** Corner danger zone: attackers within this distance of the goal line and |z| <= markZoneHalfWidth are marked, m. */
  markZoneDepth: 19,
  markZoneHalfWidth: 21,
  /** Free kick: attackers within (defensive line + fkMarkExtra) of the goal line and |z| <= markZoneHalfWidth, m. */
  fkMarkExtra: 8,
  /** Wall: member spacing along the wall, m; a member within (half wall width + wallHoldExtra) of the wall centre holds
   *  where RUL-05 puts him (target = his position) instead of walking to TAI-13's slot, m. */
  wallSpacing: 0.7,
  wallHoldExtra: 1.5,
  /** Free-kick zones: SHOOT within fkShootMaxDist m of the goal centre and a goal-mouth angle >= fkShootMinAngle rad;
   *  WIDE within fkCrossDepth m of the goal line; DEEP otherwise. */
  fkShootMaxDist: 32,
  fkShootMinAngle: 0.16,
  fkCrossDepth: 40,
  /** Free-kick defensive line depth = clamp(fkLineFrac * ball distance from the goal line, fkLineMin, fkLineMax), m;
   *  attacking runners stand fkRunnerOnside m further out (onside). */
  fkLineFrac: 0.6,
  fkLineMin: 7,
  fkLineMax: 16.5,
  fkRunnerOnside: 0.4,
  /** Free-kick rebounders stand this far beyond each end of the wall, m. */
  fkReboundOut: 2.0,
  /** Deep free kick: the second short option goes 10 m back only when the ball is at least this far from the own goal
   *  line, else 10 m forward, m. */
  deepBackMinOwn: 30,
  /** Throw-in options: max |x| of a spot (inside the goal lines), m. */
  throwMaxX: 50.5,
  // ---------------------------------------------------------------- CPU taker
  /** Stick held on the aim before pressing (lets the aim settle), ticks; shots use shotAimTicks. */
  aimTicks: 8,
  shotAimTicks: 12,
  /** Retry the decision this long after the input if the taker is waiting again and the restart is not taken, ticks. */
  retryTicks: 45,
  /** Keep the stick on a shot's aim this long after releasing the button (wind-up), ticks. */
  postAimTicks: 14,
  /** Aim stick magnitude, axis units (<= AXIS_SCALE). */
  aimStick: 126,
  /** Corner crosses by button (RUL-04 moves its aim reticle with the stick at a speed): steer restart.aimX/aimZ onto
   *  the target, full stick from reticleSlow m, on target within reticleTol m; press then, or after reticleMaxAimTicks. */
  reticleSlow: 3,
  reticleTol: 0.6,
  reticleMaxAimTicks: 60,
  /** Decision noise scale: score noise = rngGauss * T_LEVEL.decisionNoise * noiseScale (score units ~ metres). */
  noiseScale: 6,
  /** Pass targets: openness cap m and weight, lane clearance cap m and weight, progress weight per m, distance penalty
   *  per m beyond passLongFrom m. */
  openCap: 10,
  openWeight: 1.0,
  laneCap: 6,
  laneWeight: 0.8,
  progressWeight: 0.12,
  passLongFrom: 18,
  passLongPenalty: 0.3,
  /** Throw-in targets range, m (TAP); beyond it up to throwLongMax m a DOUBLE_TAP long throw; with nobody to throw to,
   *  a long throw this far ahead and infield, m, at this power 0..1. */
  throwMinDist: 3.5,
  throwMaxDist: 22,
  throwLongMax: 30,
  throwLongAhead: 15,
  throwLongInfield: 9,
  throwLongPower: 0.7,
  /** Deep free kick: pass target range, m; a tap beyond tapGroundMax m is a DOUBLE_TAP (lofted). */
  fkPassMin: 6,
  fkPassMax: 45,
  tapGroundMax: 28,
  /** Long ball with nobody to aim at: this far ahead, m. */
  longAheadDist: 35,
  /** Goal kick short option: a defender gkShortMin-gkShortMax m away, nearest opponent >= gkOpenDist m and no opponent
   *  within gkLaneClear m of the lane (RUL-03's default rule). */
  gkShortMin: 5,
  gkShortMax: 35,
  gkOpenDist: 8,
  gkLaneClear: 4,
  /** Long kicks (goal kicks, deep free kicks): target man gkLongMin-gkLongMax m away; power = clamp(d /
   *  longPowerRange, longPowerMin, 1). */
  gkLongMin: 25,
  gkLongMax: 75,
  longPowerRange: 70,
  longPowerMin: 0.45,
  /** Ground pass power: the speed that arrives at shortArrive m/s (SIM-01 groundPassSpeed) on the T_PASS ground range,
   *  at least shortPowerMin (0..1). */
  shortArrive: 5,
  shortPowerMin: 0.15,
  /** A kick line back toward the own goal must pass this far outside a post, m. */
  ownGoalMargin: 2,
  /** DIRECT / COUNTER sides go long at goal kicks and deep free kicks with this probability. */
  directLongChance: 0.6,
  /** Short corner probability by TeamStyle (possession, counter, direct, high press, wing play). */
  shortCornerChance: [0.22, 0.1, 0.06, 0.12, 0.1] as readonly number[],
  /** Short option counts as open when the nearest opponent is at least this far, m. */
  shortOpenMin: 4,
  /** A player counts as arrived within this distance of his spot, m. */
  arriveTol: 3,
  /** Crosses (corners, free kicks in range): wait for at least minBoxArrivals box runners on their spots, at most
   *  maxArrivalWait ticks beyond cpuRestartDelay (kind modules' CPU fallbacks start at cpuRestartDelay + 60). */
  minBoxArrivals: 3,
  maxArrivalWait: 45,
  /** Wide free kick: probability of a short pass instead of a cross. */
  fkShortChance: 0.12,
  /** Cross targets: box depth from the goal line, m; openness cap m and weight; corner-tactic zone bonus. */
  boxDepth: 18.5,
  crossOpenCap: 3,
  crossOpenWeight: 4,
  tacticBonus: 30,
  /** Score noise scale for cross targets (attribute points per decisionNoise unit). */
  crossNoise: 20,
  /** Cross / zone tap: aim error sigma per executionError unit, m; zone point distance from the goal line, m. */
  zoneAimErr: 0.8,
  zoneDepth: 9,
  /** Button-fallback cross power = clamp(distance / crossPowerRange, crossPowerMin, crossPowerMax). */
  crossPowerRange: 45,
  crossPowerMin: 0.45,
  crossPowerMax: 0.9,
  /** Free-kick shot probability by distance to the goal centre (<= 20, <= 26, else), scaled by the goal-mouth angle
   *  (full from fkAngleFull rad, floor fkAngleFloor) and the taker's free-kick quality (+(q - 65) / 100). */
  fkShootChance: [0.85, 0.72, 0.5] as readonly number[],
  fkAngleFull: 0.25,
  fkAngleFloor: 0.4,
  /** Free-kick shot: chance to curl over the wall to the near post (else the keeper's side); inset from the post, m;
   *  aim error sigma per executionError unit, m. */
  fkWallSideChance: 0.55,
  fkPostInset: 0.6,
  fkAimErr: 0.3,
  /** Curl magnitude = clamp(fkCurlBase + fkCurlAttr * (curve - 60) / 40, fkCurlMin, fkCurlMax), 0..1. */
  fkCurlBase: 0.55,
  fkCurlAttr: 0.25,
  fkCurlMin: 0.3,
  fkCurlMax: 0.85,
  /** Free-kick shot power = clamp(fkPowerBase + (distance - 18) * fkPowerPerM, fkPowerMin, fkPowerMax), 0..1. */
  fkPowerBase: 0.58,
  fkPowerPerM: 0.012,
  fkPowerMin: 0.5,
  fkPowerMax: 0.78,
  /** Penalties: natural-side probability; inset from the post, m (uniform); aim error sigma per executionError, m;
   *  power range 0..1 (uniform). */
  penNaturalChance: 0.58,
  penInsetMin: 0.45,
  penInsetMax: 1.1,
  penAimErr: 0.25,
  penPowerMin: 0.64,
  penPowerMax: 0.86,
  /** Shoot-out: the ball counts as set on a penalty spot within this distance, m, and below this speed, m/s; the kicker
   *  within kickerNear m of it. */
  spotTolerance: 1.0,
  spotRestSpeed: 0.2,
  kickerNear: 2.5,
  // ---------------------------------------------------------------- CPU defending
  /** Controlled defender: stick off within stickArrive m of his spot; full stick from stickSlowDist m; min magnitude. */
  stickArrive: 0.35,
  stickSlowDist: 3,
  stickMinMag: 0.3,
  /** Wall jump: THROUGH when the taker's shot is this many ticks from contact; timing jitter sigma = decisionNoise *
   *  wallJumpJitter ticks (drawn once per free kick). */
  wallJumpLeadTicks: 2,
  wallJumpJitter: 10,
} as const;

const LT = LOCAL_TUNING;

/** Role of a set-piece spot (setPieceTarget result). */
export const SpotRole = {
  NONE: 0, HOLD: 1, WALL: 2, NEAR_POST: 3, FAR_POST: 4, PEN_SPOT: 5, EDGE: 6, SHORT: 7, BOX: 8, STAY_BACK: 9,
  SCREEN_KEEPER: 10, DUMMY: 11, REBOUND: 12, LINE: 13, THROW_OPTION: 14, SPLIT_CB: 15, PIVOT: 16, WIDE: 17, TARGET: 18,
  MARK: 19, ZONAL: 20, POST_GUARD: 21, COUNTER: 22, PRESS: 23, EDGE_GUARD: 24, ARC: 25, CIRCLE: 26, SHORT_BLOCK: 27,
} as const;

/** Free-kick zones (freeKickZone result). */
export const FkZone = { NONE: 0, SHOOT: 1, WIDE: 2, DEEP: 3 } as const;

// Suitability kinds.
const S_ANY = 0;
const S_AERIAL = 1;
const S_SHORT = 2;
const S_SHOOTER = 3;
const S_STAY = 4;
const S_MARKER = 5;
const S_CB = 6;
const S_PIVOT = 7;
const S_FULLBACK = 8;
const S_FORWARD = 9;
const N_SUIT = 10;

/** A spot template: role, suitability kind, distance from the reference goal line a (m), lateral z (m, mirrored to the
 *  ball's side where the layout says so) and the distance weight of the matching cost. */
interface Tpl { role: number; suit: number; a: number; z: number; wd: number }
const tpl = (role: number, suit: number, a: number, z: number, wd: number): Tpl => ({ role, suit, a, z, wd });
const R = SpotRole;

// Corners (attacked goal line; z mirrored to the corner's side).
const C_PEN = tpl(R.PEN_SPOT, S_AERIAL, 10.5, 0.5, 0.1);
const C_FAR = tpl(R.FAR_POST, S_AERIAL, 5.0, -4.5, 0.1);
const C_NEAR = tpl(R.NEAR_POST, S_AERIAL, 4.5, 2.8, 0.1);
const C_STAY1 = tpl(R.STAY_BACK, S_STAY, 54, -8, 0.2);
const C_EDGE = tpl(R.EDGE, S_SHOOTER, 18.5, -2.5, 0.2);
const C_SHORT = tpl(R.SHORT, S_SHORT, 4.5, 27, 0.2);
const C_STAY2 = tpl(R.STAY_BACK, S_STAY, 56, 9, 0.2);
/** Tactic spots X1, X2 per tactic index (0 default, 1 far post, 2 edge of box, 3 crowd the keeper, 4 near post). */
const C_X1: readonly Tpl[] = [
  tpl(R.BOX, S_AERIAL, 5.5, 0.8, 0.1), tpl(R.FAR_POST, S_AERIAL, 6.5, -6.5, 0.1), tpl(R.EDGE, S_SHOOTER, 17.5, 5.5, 0.2),
  tpl(R.SCREEN_KEEPER, S_AERIAL, 1.6, -0.6, 0.1), tpl(R.NEAR_POST, S_AERIAL, 6.0, 4.5, 0.1),
];
const C_X2: readonly Tpl[] = [
  tpl(R.BOX, S_AERIAL, 8.5, -7.5, 0.1), tpl(R.FAR_POST, S_AERIAL, 9.5, -9, 0.1), tpl(R.EDGE, S_SHOOTER, 20.5, -9, 0.2),
  tpl(R.SCREEN_KEEPER, S_AERIAL, 2.0, 1.6, 0.1), tpl(R.NEAR_POST, S_AERIAL, 8.0, 1.5, 0.1),
];
// Corner defence (own goal line = the attacked one).
const CD_POST = tpl(R.POST_GUARD, S_ANY, 0.7, 3.0, 0.4);
const CD_Z1 = tpl(R.ZONAL, S_AERIAL, 5.8, 1.0, 0.1);
const CD_Z2 = tpl(R.ZONAL, S_AERIAL, 6.0, -3.5, 0.1);
const CD_EDGE = tpl(R.EDGE_GUARD, S_ANY, 15.5, -1.0, 0.3);
const CD_COUNTER = tpl(R.COUNTER, S_FORWARD, 50, 0, 0.2);
const CD_Z3 = tpl(R.ZONAL, S_ANY, 10, 4, 0.2);
const CD_BLOCK = tpl(R.SHORT_BLOCK, S_ANY, 9.5, 24, 0.4);
const CD_Z4 = tpl(R.ZONAL, S_ANY, 12, -6, 0.2);
// Goal kicks (kicking team's own goal line; z mirrored to the ball's side).
const GK_SPLIT1 = tpl(R.SPLIT_CB, S_CB, 14, 17, 0.6);
const GK_SPLIT2 = tpl(R.SPLIT_CB, S_CB, 14, -17, 0.6);
const GK_PIVOT = tpl(R.PIVOT, S_PIVOT, 27, 0, 0.6);
const GK_WIDE1 = tpl(R.WIDE, S_FULLBACK, 32, 29, 0.6);
const GK_WIDE2 = tpl(R.WIDE, S_FULLBACK, 32, -29, 0.6);
const GK_TARGET = tpl(R.TARGET, S_FORWARD, 55, 6, 0.3);
const GK_TARGET2 = tpl(R.TARGET, S_FORWARD, 51, -9, 0.4);
const GK_PRESS1 = tpl(R.PRESS, S_FORWARD, 18.5, 10, 0.5);
const GK_PRESS2 = tpl(R.PRESS, S_FORWARD, 18.5, -10, 0.5);
// Penalties (attacked goal line; z not mirrored).
const PEN_ATT: readonly Tpl[] = [
  tpl(R.ARC, S_FORWARD, 17.3, 8.2, 0.3), tpl(R.ARC, S_FORWARD, 17.3, -10, 0.3), tpl(R.ARC, S_ANY, 17.3, 11.8, 0.3),
  tpl(R.ARC, S_ANY, 17.3, -13.6, 0.3), tpl(R.STAY_BACK, S_STAY, 56, -8, 0.2), tpl(R.STAY_BACK, S_STAY, 58, 8, 0.2),
];
const PEN_DEF: readonly Tpl[] = [
  tpl(R.ARC, S_MARKER, 17.3, -8.2, 0.3), tpl(R.ARC, S_MARKER, 17.3, 10, 0.3), tpl(R.ARC, S_MARKER, 17.3, -11.8, 0.3),
  tpl(R.ARC, S_MARKER, 17.3, 13.6, 0.3), tpl(R.COUNTER, S_FORWARD, 50, 0, 0.2),
];
// Free kicks: z offsets mirrored to the ball's side; depths are set at run time.
const FK_LINE_SHOOT_Z: readonly number[] = [7, -3, -9];
const FK_LINE_WIDE_Z: readonly number[] = [3, 0, -4, -8];
const T_FK_DUMMY = tpl(R.DUMMY, S_SHOOTER, 0, 0, 0.3);
const T_FK_REBOUND = tpl(R.REBOUND, S_ANY, 0, 0, 0.5);
const T_FK_LINE = tpl(R.LINE, S_AERIAL, 0, 0, 0.3);
const T_FK_EDGE = tpl(R.EDGE, S_SHOOTER, 0, 0, 0.3);
const T_FK_SHORT = tpl(R.SHORT, S_SHORT, 0, 0, 0.5);
const T_FK_STAY1 = tpl(R.STAY_BACK, S_STAY, 56, -8, 0.2);
const T_FK_STAY2 = tpl(R.STAY_BACK, S_STAY, 58, 8, 0.2);
const T_FK_ZONAL = tpl(R.ZONAL, S_ANY, 0, 0, 0.3);
const T_FK_POST = tpl(R.POST_GUARD, S_ANY, 0.7, 3, 0.4);
const T_FK_COUNTER = tpl(R.COUNTER, S_FORWARD, 50, 0, 0.2);
const T_DEEP_SHORT = tpl(R.SHORT, S_ANY, 0, 0, 1.0);
const T_THROW = tpl(R.THROW_OPTION, S_ANY, 0, 0, 1.0);

// ---------------------------------------------------------------- module scratch (no allocation per tick)

const SPOT_X = new Float64Array(NUM_SLOTS);
const SPOT_Z = new Float64Array(NUM_SLOTS);
/** SpotRole per slot, 0 = no spot. */
const SPOT_ROLE = new Int32Array(NUM_SLOTS);
/** 1 = spot is final (wall, shoot-out layout): not legalised or moved apart. */
const SPOT_FIXED = new Uint8Array(NUM_SLOTS);
/** Marked attacker per slot (job target slot), -1 none. */
const SPOT_TGT = new Int32Array(NUM_SLOTS);
/** 1 = gets a computed spot (job-driven or CPU-controlled active outfield player, not taker / wall / kicker). */
const CAND = new Uint8Array(NUM_SLOTS);
/** 1 = wall member of the current free kick. */
const WALLM = new Uint8Array(NUM_SLOTS);
/** 1 = attacker already man-marked. */
const MARKED = new Uint8Array(NUM_SLOTS);
/** Formation slot position per slot (stable matching reference). */
const BASE_X = new Float64Array(NUM_SLOTS);
const BASE_Z = new Float64Array(NUM_SLOTS);
/** Suitability per kind and slot: SUIT[kind * NUM_SLOTS + slot]. */
const SUIT = new Float64Array(N_SUIT * NUM_SLOTS);

const MAX_LIST = 16;
const L_X = new Float64Array(MAX_LIST);
const L_Z = new Float64Array(MAX_LIST);
const L_ROLE = new Int32Array(MAX_LIST);
const L_SUIT = new Int32Array(MAX_LIST);
const L_WD = new Float64Array(MAX_LIST);
let L_N = 0;

/** Point scratch for the legality helpers (doubles never cross a call boundary on the hot path). */
const PT = { x: 0, z: 0 };
const WORLD = { x: 0, z: 0 };

/** Layout context of the current restart (buildCtx). */
const C = {
  kind: RestartKind.NONE as number,
  att: 0,
  def: 1,
  /** Attack direction of the restart team. */
  dirA: 1,
  dir0: 1,
  dir1: -1,
  taker: -1,
  /** Ball spot and its side (sign of z, +1 when 0). */
  bx: 0,
  bz: 0,
  sb: 1,
  /** Exclusion disc centre and radius. */
  cx: 0,
  cz: 0,
  rad: 0,
  /** Penalty area end (+-1) excluded (opponents; everybody at a penalty), 0 = none. */
  paEnd: 0,
  /** Free kick near goal: end whose goal line between the posts is legal for defenders, 0 = none. */
  goalLineEnd: 0,
  /** Free kick: zone, ball distance from the attacked goal line, distance to the goal centre, cos of the goal-mouth
   *  angle, defensive line depth. */
  fkZone: 0,
  aB: 0,
  dGoal: 0,
  angleCos: 1,
  aLine: 0,
};

/** Unit ring for the legal-spot fallback search (built once at load with deterministic dmath). */
const RING_N = 16;
const RING_X = new Float64Array(RING_N);
const RING_Z = new Float64Array(RING_N);
for (let i = 0; i < RING_N; i++) {
  const a = (i * 2 * 3.141592653589793) / RING_N;
  RING_X[i] = dcos(a);
  RING_Z[i] = dsin(a);
}
const RING_EXTRA: readonly number[] = [0, 3, 8, 14, 22];
/** Pitch limits for spots, the legal margin, cos of the minimum goal-mouth angle for shooting free kicks. */
const LIM_X = HALF_LENGTH - LT.pitchMargin;
const LIM_Z = HALF_WIDTH - LT.pitchMargin;
const MARGIN = LT.legalMargin;
const FK_COS_MIN = dcos(LT.fkShootMinAngle);

// ---------------------------------------------------------------- small helpers

/** Decision-time clamp (per-tick paths clamp inline / through PT so no double crosses a call boundary). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp PT into the pitch limits for spots. */
function clampPt(): void {
  const x = PT.x, z = PT.z;
  PT.x = x < -LIM_X ? -LIM_X : x > LIM_X ? LIM_X : x;
  PT.z = z < -LIM_Z ? -LIM_Z : z > LIM_Z ? LIM_Z : z;
}

function isDefenderRole(r: Role): boolean {
  return r === Role.RB || r === Role.CB || r === Role.LB || r === Role.RWB || r === Role.LWB;
}

function isFullbackRole(r: Role): boolean {
  return r === Role.RB || r === Role.LB || r === Role.RWB || r === Role.LWB;
}

function isWideRole(r: Role): boolean {
  return isFullbackRole(r) || r === Role.RM || r === Role.LM || r === Role.RW || r === Role.LW;
}

function levelOf(b: CpuBrainState): number {
  const l = b.level;
  return l >= 0 && l <= 5 ? l : 3;
}

function isCpuController(s: SimState, ci: number): boolean {
  return ci >= CPU_CONTROLLER_BASE && ci < s.ctrl.length && s.ctrl[ci]!.kind === ControllerKind.CPU;
}

function dirOf(team: number): number {
  return team === 0 ? C.dir0 : C.dir1;
}

/** Waiting states of a taker in which a new kick input may start one. */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  return p.active === 1 && p.stunT <= 0 &&
    (p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE || p.act === ActionKind.THROW_IN);
}

/** RestartKind of a match phase (NONE outside restart phases). */
function phaseKind(phase: number): number {
  return phase >= 0 && phase < PHASE_KIND.length ? PHASE_KIND[phase]! : RestartKind.NONE;
}

// ---------------------------------------------------------------- layout context

function buildCtx(s: SimState, kind: number): void {
  const r = s.match.restart;
  const att = r.team === 1 ? 1 : 0;
  C.kind = kind;
  C.att = att;
  C.def = att === 0 ? 1 : 0;
  C.dir0 = s.teams[0]!.dir;
  C.dir1 = s.teams[1]!.dir;
  C.dirA = s.teams[att]!.dir;
  C.taker = r.kind === kind ? r.taker : -1;
  const fresh = r.kind === kind;
  C.bx = fresh ? r.x : s.ball.x;
  C.bz = fresh ? r.z : s.ball.z;
  if (!(C.bx === C.bx)) C.bx = 0;
  if (!(C.bz === C.bz)) C.bz = 0;
  C.sb = C.bz < 0 ? -1 : 1;
  C.cx = C.bx;
  C.cz = C.bz;
  C.rad = kind === RestartKind.THROW_IN ? THROW_IN_DISTANCE
    : kind === RestartKind.KICK_OFF ? CENTRE_CIRCLE_RADIUS
      : kind === RestartKind.PENALTY ? PENALTY_ARC_RADIUS : RESTART_DISTANCE;
  if (kind === RestartKind.KICK_OFF) { C.cx = 0; C.cz = 0; }
  C.paEnd = 0;
  C.goalLineEnd = 0;
  C.fkZone = FkZone.NONE;
  C.aB = HALF_LENGTH - C.dirA * C.bx;
  C.dGoal = Math.sqrt(C.aB * C.aB + C.bz * C.bz);
  C.angleCos = 1;
  C.aLine = 0;
  if (kind === RestartKind.GOAL_KICK) {
    C.paEnd = -C.dirA;
  } else if (kind === RestartKind.PENALTY) {
    C.paEnd = C.dirA;
    C.cx = C.dirA * (HALF_LENGTH - PENALTY_SPOT_DIST);
    C.cz = 0;
  } else if (kind === RestartKind.FREE_KICK) {
    const own = -C.dirA * C.bx; // > 0 deep in the kicking team's own half
    if (own >= HALF_LENGTH - PENALTY_AREA_DEPTH && C.bz >= -PENALTY_AREA_HALF_WIDTH && C.bz <= PENALTY_AREA_HALF_WIDTH) C.paEnd = -C.dirA;
    if (C.aB < RESTART_DISTANCE) C.goalLineEnd = C.dirA;
    // Angle subtended by the goal mouth, as its cosine (no atan per tick): posts at lateral +-GOAL_HALF_WIDTH.
    const aB = C.aB > 0.01 ? C.aB : 0.01;
    const l1 = GOAL_HALF_WIDTH - C.bz, l2 = -GOAL_HALF_WIDTH - C.bz;
    C.angleCos = (aB * aB + l1 * l2) / (Math.sqrt(aB * aB + l1 * l1) * Math.sqrt(aB * aB + l2 * l2));
    if (C.dGoal <= LT.fkShootMaxDist && C.angleCos <= FK_COS_MIN) C.fkZone = FkZone.SHOOT;
    else if (C.aB <= LT.fkCrossDepth) C.fkZone = FkZone.WIDE;
    else C.fkZone = FkZone.DEEP;
    const al = LT.fkLineFrac * C.aB;
    C.aLine = al < LT.fkLineMin ? LT.fkLineMin : al > LT.fkLineMax ? LT.fkLineMax : al;
  }
}

// ---------------------------------------------------------------- legality (on PT)

/** Is PT inside the penalty area of `end`, grown by the legal margin when withMargin = 1? */
function ptInAreaM(end: number, withMargin: number): boolean {
  const mg = withMargin === 1 ? MARGIN : 0;
  const ex = end * PT.x;
  const hw = PENALTY_AREA_HALF_WIDTH + mg;
  return ex >= HALF_LENGTH - PENALTY_AREA_DEPTH - mg && PT.z >= -hw && PT.z <= hw;
}

/** Is PT a legal spot (with the legal margin when withMargin = 1) for a player of `team` in the current restart (C)? */
function ptLegal(team: number, withMargin: number): boolean {
  const mg = withMargin === 1 ? MARGIN : 0;
  const x = PT.x, z = PT.z;
  const lim = LIM_X + 1e-6;
  const limZ = LIM_Z + 1e-6;
  if (x < -lim || x > lim || z < -limZ || z > limZ) return false;
  const opp = team !== C.att;
  const dx = x - C.cx, dz = z - C.cz;
  const rr = C.rad + mg;
  const inDisc = dx * dx + dz * dz < rr * rr;
  switch (C.kind) {
    case RestartKind.KICK_OFF:
      if (dirOf(team) * x > -LT.halfMargin + 1e-6) return false;
      return !(opp && inDisc);
    case RestartKind.PENALTY:
      return !inDisc && !ptInAreaM(C.paEnd, withMargin);
    case RestartKind.GOAL_KICK:
      return !opp || (!inDisc && !ptInAreaM(C.paEnd, withMargin));
    case RestartKind.FREE_KICK:
      if (!opp) return true;
      if (C.paEnd !== 0 && ptInAreaM(C.paEnd, withMargin)) return false;
      if (!inDisc) return true;
      return C.goalLineEnd !== 0 && x * C.goalLineEnd >= HALF_LENGTH - LT.pitchMargin - 0.1 &&
        z >= -GOAL_HALF_WIDTH && z <= GOAL_HALF_WIDTH;
    default: // THROW_IN, CORNER
      return !(opp && inDisc);
  }
}

/** Move PT to a legal spot near it for a player of `team` (projections, then a ring search around the ball). */
function legalizePt(team: number): void {
  const mg = MARGIN;
  const ox = PT.x === PT.x ? PT.x : 0;
  const oz = PT.z === PT.z ? PT.z : 0;
  PT.x = ox;
  PT.z = oz;
  clampPt();
  const opp = team !== C.att;
  const discOn = C.kind === RestartKind.PENALTY || opp;
  const areaOn = C.paEnd !== 0 && (C.kind === RestartKind.PENALTY || opp);
  for (let it = 0; it < 4; it++) {
    if (ptLegal(team, 1)) return;
    if (C.kind === RestartKind.KICK_OFF) {
      const d = dirOf(team);
      if (d * PT.x > -LT.halfMargin) PT.x = -d * (LT.halfMargin + 0.01);
    }
    if (discOn) {
      const dx = PT.x - C.cx, dz = PT.z - C.cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const rr = C.rad + mg + 0.01;
      if (d < rr) {
        let ux = -dirOf(team), uz = 0;
        if (d > 1e-6) { ux = dx / d; uz = dz / d; }
        PT.x = C.cx + ux * rr;
        PT.z = C.cz + uz * rr;
      }
    }
    if (areaOn && ptInAreaM(C.paEnd, 1)) {
      const frontX = C.paEnd * (HALF_LENGTH - PENALTY_AREA_DEPTH - mg - 0.01);
      const sideZ = (PT.z < 0 ? -1 : 1) * (PENALTY_AREA_HALF_WIDTH + mg + 0.01);
      const df = PT.x - frontX, ds = PT.z - sideZ;
      if (df * df <= ds * ds) PT.x = frontX; else PT.z = sideZ;
    }
    clampPt();
  }
  if (ptLegal(team, 1)) return;
  // Ring search around the exclusion centre: the legal point nearest the wanted one.
  let bestD = 1e18, bx = 0, bz = 0;
  for (let k = 0; k < RING_EXTRA.length && bestD >= 1e18; k++) {
    const rad = C.rad + mg + 0.05 + RING_EXTRA[k]!;
    for (let i = 0; i < RING_N; i++) {
      PT.x = C.cx + RING_X[i]! * rad;
      PT.z = C.cz + RING_Z[i]! * rad;
      clampPt();
      if (!ptLegal(team, 1)) continue;
      const dx = PT.x - ox, dz = PT.z - oz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bx = PT.x; bz = PT.z; }
    }
  }
  if (bestD < 1e18) { PT.x = bx; PT.z = bz; return; }
  if (C.kind === RestartKind.FREE_KICK && opp && C.goalLineEnd !== 0) {
    const gz = GOAL_HALF_WIDTH - 0.4;
    PT.x = C.goalLineEnd * LIM_X;
    PT.z = oz < -gz ? -gz : oz > gz ? gz : oz;
    return;
  }
  PT.x = -dirOf(team) * HALF_LENGTH * 0.5; // unreachable in practice: deep in his own half
  PT.z = oz;
  clampPt();
}

// ---------------------------------------------------------------- candidates, bases, suitability

function prepare(s: SimState): void {
  const r = s.match.restart;
  for (let i = 0; i < NUM_SLOTS; i++) {
    SPOT_ROLE[i] = 0;
    SPOT_FIXED[i] = 0;
    SPOT_TGT[i] = -1;
    CAND[i] = 0;
    WALLM[i] = 0;
  }
  if (C.kind === RestartKind.FREE_KICK && r.kind === RestartKind.FREE_KICK) {
    const n = r.wallCount < r.wall.length ? r.wallCount : r.wall.length;
    for (let i = 0; i < n; i++) {
      const w = r.wall[i]!;
      if (w >= 0 && w < NUM_SLOTS) WALLM[w] = 1;
    }
  }
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    if (p.active !== 1 || p.isKeeper === 1 || slot === C.taker) continue;
    if (p.ctrl >= 0 && !isCpuController(s, p.ctrl)) continue;
    if (WALLM[slot] === 1) continue;
    CAND[slot] = 1;
  }
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (CAND[slot] === 0) continue;
    const p = s.players[slot]!;
    const t = s.teams[p.team]!;
    slotWorld(t.formation, p.formIdx, t.dir, WORLD);
    BASE_X[slot] = WORLD.x;
    BASE_Z[slot] = WORLD.z;
    const a = s.attrs[slot]!;
    const role = p.role;
    const aerial = a.heading + 0.5 * (a.height - 180);
    const def = isDefenderRole(role);
    SUIT[S_ANY * NUM_SLOTS + slot] = 0;
    SUIT[S_AERIAL * NUM_SLOTS + slot] = aerial + (role === Role.CB || role === Role.ST || role === Role.CF ? 10 : 0);
    SUIT[S_SHORT * NUM_SLOTS + slot] = 0.5 * (a.shortPassing + a.dribbling) + (isWideRole(role) ? 8 : 0);
    SUIT[S_SHOOTER * NUM_SLOTS + slot] = 0.4 * (a.longShots + a.shotPower) + 0.2 * a.curve;
    SUIT[S_STAY * NUM_SLOTS + slot] = (def ? 25 : role === Role.CDM ? 15 : 0) + 0.3 * a.sprintSpeed - 0.4 * aerial;
    SUIT[S_MARKER * NUM_SLOTS + slot] = (def ? 20 : role === Role.CDM ? 10 : 0) + 0.4 * a.heading +
      0.3 * a.standingTackle + 0.3 * (a.height - 180);
    SUIT[S_CB * NUM_SLOTS + slot] = role === Role.CB ? 40 : def ? 20 : role === Role.CDM ? 12 : 0;
    SUIT[S_PIVOT * NUM_SLOTS + slot] = (role === Role.CDM ? 30 : role === Role.CM ? 22 : role === Role.CAM ? 10 : 0) +
      0.1 * a.shortPassing;
    SUIT[S_FULLBACK * NUM_SLOTS + slot] = isFullbackRole(role) ? 40 : isWideRole(role) ? 20 : 0;
    SUIT[S_FORWARD * NUM_SLOTS + slot] = (role === Role.ST || role === Role.CF ? 35
      : role === Role.RW || role === Role.LW || role === Role.CAM ? 18 : 0) + 0.2 * a.heading;
  }
}

// ---------------------------------------------------------------- spot lists and matching

/** Append template `t` at PT to the spot list. */
function pushSpot(t: Tpl): void {
  if (L_N >= MAX_LIST) return;
  L_X[L_N] = PT.x;
  L_Z[L_N] = PT.z;
  L_ROLE[L_N] = t.role;
  L_SUIT[L_N] = t.suit;
  L_WD[L_N] = t.wd;
  L_N++;
}

/** Template in the attacked-goal frame of the restart team (z mirrored to the ball's side when mirror = 1). */
function pushAtt(t: Tpl, mirror: number): void {
  PT.x = C.dirA * (HALF_LENGTH - t.a);
  PT.z = mirror === 1 ? C.sb * t.z : t.z;
  pushSpot(t);
}

/** Template in the restart team's own-goal frame (goal kicks), z mirrored to the ball's side. */
function pushOwn(t: Tpl): void {
  PT.x = -C.dirA * (HALF_LENGTH - t.a);
  PT.z = C.sb * t.z;
  pushSpot(t);
}

/** Give `slot` the spot at PT. */
function setSpot(slot: number, role: number, target: number): void {
  SPOT_X[slot] = PT.x;
  SPOT_Z[slot] = PT.z;
  SPOT_ROLE[slot] = role;
  SPOT_TGT[slot] = target;
}

/** Match the list to the candidates of `team` in priority order (stable cost), then clear the list. */
function assignList(team: number): void {
  const first = teamFirstSlot(team);
  for (let i = 0; i < L_N; i++) {
    const sx = L_X[i]!, sz = L_Z[i]!, wd = L_WD[i]!, sk = L_SUIT[i]! * NUM_SLOTS;
    let best = -1;
    let bestCost = 1e18;
    for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
      if (CAND[slot] === 0 || SPOT_ROLE[slot] !== 0) continue;
      const dx = BASE_X[slot]! - sx, dz = BASE_Z[slot]! - sz;
      const cost = wd * Math.sqrt(dx * dx + dz * dz) - LT.suitWeight * SUIT[sk + slot]!;
      if (cost < bestCost) { bestCost = cost; best = slot; }
    }
    if (best >= 0) {
      PT.x = sx;
      PT.z = sz;
      setSpot(best, L_ROLE[i]!, -1);
    }
  }
  L_N = 0;
}

/** Marking parameters (assignMarkers reads them; doubles never cross a call boundary on the per-tick path). */
const MK = { depth: 0, halfW: 0, dist: 0, wd: 0 };

/**
 * Man-mark up to maxN attackers of the restart team (most dangerous first) with defending candidates, goal-side by
 * MK.dist. mode 0: attackers within MK.depth of the goal line and |z| <= MK.halfW (threat: aerial, nearer goal first);
 * mode 1: the throw-in options (threat: nearer the ball first). An attacker's position is his spot when he has one.
 * Defenders are matched by MK.wd * distance (formation slot -> attacker) - marker suitability.
 */
function assignMarkers(s: SimState, maxN: number, mode: number): void {
  const depth = MK.depth, halfW = MK.halfW, dist = MK.dist, wd = MK.wd;
  const att = C.att;
  const firstA = teamFirstSlot(att);
  const firstD = teamFirstSlot(C.def);
  const gx = C.dirA * HALF_LENGTH; // the defended goal line
  for (let i = firstA; i < firstA + PLAYERS_PER_TEAM; i++) MARKED[i] = 0;
  for (let k = 0; k < maxN; k++) {
    let best = -1;
    let bestT = -1e18;
    let ax = 0, az = 0;
    for (let i = firstA; i < firstA + PLAYERS_PER_TEAM; i++) {
      if (MARKED[i] === 1 || i === C.taker) continue;
      const q = s.players[i]!;
      if (q.active !== 1 || q.isKeeper === 1) continue;
      const has = SPOT_ROLE[i] !== 0;
      const x = has ? SPOT_X[i]! : q.x;
      const z = has ? SPOT_Z[i]! : q.z;
      let th: number;
      if (mode === 1) {
        if (SPOT_ROLE[i] !== R.THROW_OPTION) continue;
        const dx = x - C.bx, dz = z - C.bz;
        th = -Math.sqrt(dx * dx + dz * dz);
      } else {
        const dg = HALF_LENGTH - C.dirA * x;
        if (dg > depth || z > halfW || z < -halfW) continue;
        const a = s.attrs[i]!;
        th = a.heading + 0.5 * (a.height - 180) - dg;
      }
      if (th > bestT) { bestT = th; best = i; ax = x; az = z; }
    }
    if (best < 0) return;
    MARKED[best] = 1;
    let ux = gx - ax, uz = -az;
    const ul = Math.sqrt(ux * ux + uz * uz);
    if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = C.dirA; uz = 0; }
    const mx = ax + ux * dist, mz = az + uz * dist;
    let bd = -1;
    let bc = 1e18;
    for (let j = firstD; j < firstD + PLAYERS_PER_TEAM; j++) {
      if (CAND[j] === 0 || SPOT_ROLE[j] !== 0) continue;
      const dx = BASE_X[j]! - ax, dz = BASE_Z[j]! - az;
      const cost = wd * Math.sqrt(dx * dx + dz * dz) - LT.suitWeight * SUIT[S_MARKER * NUM_SLOTS + j]!;
      if (cost < bc) { bc = cost; bd = j; }
    }
    if (bd < 0) return;
    PT.x = mx;
    PT.z = mz;
    setSpot(bd, R.MARK, best);
  }
}

// ---------------------------------------------------------------- layouts

function cornerTacticIndex(cmd: number): number {
  switch (cmd) {
    case Command.CORNER_FAR_POST: return 1;
    case Command.CORNER_EDGE_OF_BOX: return 2;
    case Command.CORNER_CROWD_KEEPER: return 3;
    case Command.CORNER_NEAR_POST: return 4;
    default: return 0;
  }
}

function layoutCorner(s: SimState): void {
  const ti = cornerTacticIndex(s.teams[C.att]!.cornerTactic);
  pushAtt(C_PEN, 1);
  pushAtt(C_FAR, 1);
  pushAtt(C_NEAR, 1);
  pushAtt(C_STAY1, 1);
  pushAtt(C_EDGE, 1);
  pushAtt(C_X1[ti]!, 1);
  pushAtt(C_SHORT, 1);
  pushAtt(C_X2[ti]!, 1);
  pushAtt(C_STAY2, 1);
  assignList(C.att);
  pushAtt(CD_POST, 1);
  assignList(C.def);
  MK.depth = LT.markZoneDepth;
  MK.halfW = LT.markZoneHalfWidth;
  MK.dist = LT.markDist;
  MK.wd = 0.1;
  assignMarkers(s, LT.maxMarkers, 0);
  pushAtt(CD_COUNTER, 1);
  pushAtt(CD_Z1, 1);
  pushAtt(CD_Z2, 1);
  pushAtt(CD_EDGE, 1);
  pushAtt(CD_Z3, 1);
  pushAtt(CD_BLOCK, 1);
  pushAtt(CD_Z4, 1);
  assignList(C.def);
}

/** Throw-in option at PT (x clamped inside the goal lines). */
function pushThrow(): void {
  const xl = LT.throwMaxX;
  const x = PT.x;
  PT.x = x < -xl ? -xl : x > xl ? xl : x;
  pushSpot(T_THROW);
}

function layoutThrowIn(s: SimState): void {
  const d = C.dirA;
  const sz = C.sb;
  PT.x = C.bx + d * 11;
  PT.z = sz * (HALF_WIDTH - 4);
  pushThrow();
  PT.x = C.bx + d * 1.5;
  PT.z = sz * (HALF_WIDTH - 9);
  pushThrow();
  PT.x = C.bx - d * 8;
  PT.z = sz * (HALF_WIDTH - 6);
  pushThrow();
  PT.x = C.bx + d * 5;
  PT.z = sz * (HALF_WIDTH - 13);
  pushThrow();
  assignList(C.att);
  MK.depth = 0;
  MK.halfW = 0;
  MK.dist = LT.markDistThrow;
  MK.wd = 1.0;
  assignMarkers(s, LT.maxThrowMarkers, 1);
}

function layoutGoalKick(): void {
  pushOwn(GK_SPLIT1);
  pushOwn(GK_SPLIT2);
  pushOwn(GK_PIVOT);
  pushOwn(GK_WIDE1);
  pushOwn(GK_WIDE2);
  pushOwn(GK_TARGET);
  pushOwn(GK_TARGET2);
  assignList(C.att);
  pushOwn(GK_PRESS1);
  pushOwn(GK_PRESS2);
  assignList(C.def);
}

function layoutPenalty(): void {
  for (let i = 0; i < PEN_ATT.length; i++) pushAtt(PEN_ATT[i]!, 0);
  assignList(C.att);
  for (let i = 0; i < PEN_DEF.length; i++) pushAtt(PEN_DEF[i]!, 0);
  assignList(C.def);
}

/** Template at PT: PT.x holds the depth (m from the attacked goal line), PT.z the lateral z (world). */
function pushDepth(t: Tpl): void {
  PT.x = C.dirA * (HALF_LENGTH - PT.x);
  pushSpot(t);
}

/** Template at PT, clamped into the pitch limits. */
function pushAt(t: Tpl): void {
  clampPt();
  pushSpot(t);
}

function layoutFreeKick(s: SimState): void {
  const r = s.match.restart;
  const d = C.dirA;
  const sb = C.sb;
  if (C.fkZone === FkZone.DEEP) {
    PT.x = C.bx + d * 1;
    PT.z = C.bz + (C.bz >= 0 ? -11 : 11);
    pushAt(T_DEEP_SHORT);
    // Back option, or (deep in the own half) a forward one: never back toward the own goal.
    const own = HALF_LENGTH + d * C.bx; // distance from the own goal line
    PT.x = C.bx + d * (own < LT.deepBackMinOwn ? 10 : -10);
    PT.z = C.bz * 0.8;
    pushAt(T_DEEP_SHORT);
    assignList(C.att);
    return;
  }
  const runA = C.aLine + LT.fkRunnerOnside;
  // Unit vector from the ball to the goal centre and its normal toward the ball's side.
  let kx = d * HALF_LENGTH - C.bx, kz = -C.bz;
  const kl = Math.sqrt(kx * kx + kz * kz);
  if (kl > 1e-6) { kx /= kl; kz /= kl; } else { kx = d; kz = 0; }
  let nx = -kz, nz = kx;
  if (nz * sb < 0) { nx = -nx; nz = -nz; }
  if (C.fkZone === FkZone.SHOOT) {
    PT.x = C.bx - kx * 0.9 + nx * 1.4;
    PT.z = C.bz - kz * 0.9 + nz * 1.4;
    pushAt(T_FK_DUMMY);
    // Rebounders beyond the ends of the wall (or of where it would stand).
    let wx = C.bx + kx * RESTART_DISTANCE, wz = C.bz + kz * RESTART_DISTANCE;
    let n = r.kind === RestartKind.FREE_KICK ? r.wallCount : 0;
    if (n > 0) { wx = r.wallX; wz = r.wallZ; } else n = 3;
    const hw = (n - 1) * 0.5 * LT.wallSpacing + LT.fkReboundOut;
    PT.x = wx + nx * hw;
    PT.z = wz + nz * hw;
    pushAt(T_FK_REBOUND);
    PT.x = wx - nx * hw;
    PT.z = wz - nz * hw;
    pushAt(T_FK_REBOUND);
    for (let i = 0; i < FK_LINE_SHOOT_Z.length; i++) {
      PT.x = runA;
      PT.z = sb * FK_LINE_SHOOT_Z[i]!;
      pushDepth(T_FK_LINE);
    }
  } else {
    for (let i = 0; i < FK_LINE_WIDE_Z.length; i++) {
      PT.x = runA;
      PT.z = sb * FK_LINE_WIDE_Z[i]!;
      pushDepth(T_FK_LINE);
    }
    PT.x = runA + 6 > 18 ? runA + 6 : 18;
    PT.z = -sb * 1;
    pushDepth(T_FK_EDGE);
    PT.x = C.bx - d * 3;
    PT.z = C.bz - sb * 7;
    pushAt(T_FK_SHORT);
  }
  pushAtt(T_FK_STAY1, 1);
  pushAtt(T_FK_STAY2, 1);
  assignList(C.att);
  if (C.fkZone === FkZone.WIDE && C.aB <= 28) {
    pushAtt(T_FK_POST, 1);
    assignList(C.def);
  }
  MK.depth = C.aLine + LT.fkMarkExtra;
  MK.halfW = LT.markZoneHalfWidth;
  MK.dist = LT.markDist;
  MK.wd = 0.1;
  assignMarkers(s, LT.maxMarkers, 0);
  PT.x = C.aLine - 0.5;
  PT.z = C.fkZone === FkZone.SHOOT ? 0 : sb * 1;
  pushDepth(T_FK_ZONAL);
  if (C.fkZone === FkZone.SHOOT) {
    PT.x = C.aLine - 0.5;
    PT.z = -sb * 6;
    pushDepth(T_FK_ZONAL);
  }
  pushAtt(T_FK_COUNTER, 1);
  assignList(C.def);
}

/** Wall members (job-driven or CPU-controlled) walk to a wall slot, then hold where RUL-05 places them. */
function layoutWall(s: SimState): void {
  const r = s.match.restart;
  if (C.kind !== RestartKind.FREE_KICK || r.kind !== RestartKind.FREE_KICK) return;
  const n = r.wallCount < r.wall.length ? r.wallCount : r.wall.length;
  if (n <= 0) return;
  let ux = r.wallX - C.bx, uz = r.wallZ - C.bz;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = C.dirA; uz = 0; }
  const px = -uz, pz = ux;
  const hold = (n - 1) * 0.5 * LT.wallSpacing + LT.wallHoldExtra;
  for (let i = 0; i < n; i++) {
    const w = r.wall[i]!;
    if (w < 0 || w >= NUM_SLOTS) continue;
    const p = s.players[w]!;
    if (p.active !== 1 || p.isKeeper === 1 || w === C.taker) continue;
    if (p.ctrl >= 0 && !isCpuController(s, p.ctrl)) continue;
    const dx = p.x - r.wallX, dz = p.z - r.wallZ;
    if (dx * dx + dz * dz <= hold * hold) {
      PT.x = p.x;
      PT.z = p.z;
    } else {
      const off = (i - (n - 1) * 0.5) * LT.wallSpacing;
      PT.x = r.wallX + px * off;
      PT.z = r.wallZ + pz * off;
    }
    setSpot(w, R.WALL, -1);
    SPOT_FIXED[w] = 1;
  }
}

/** Shoot-out: both teams' outfield players in the centre circle, side by side (two rows per team, by slot). */
function layoutShootout(s: SimState): void {
  const so = s.match.shootout;
  for (let i = 0; i < NUM_SLOTS; i++) {
    SPOT_ROLE[i] = 0;
    SPOT_FIXED[i] = 0;
    SPOT_TGT[i] = -1;
    CAND[i] = 0;
  }
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    if (p.active !== 1 || p.isKeeper === 1 || (so.active === 1 && slot === so.kicker)) continue;
    if (p.ctrl >= 0 && !isCpuController(s, p.ctrl)) continue;
    CAND[slot] = 1;
    const idx = slot - teamFirstSlot(p.team);
    const row = idx & 1;
    const j = idx >> 1;
    PT.x = row === 0 ? -1.1 : 1.1;
    PT.z = (p.team === 0 ? -1 : 1) * (1.0 + 1.3 * j);
    setSpot(slot, R.CIRCLE, -1);
    SPOT_FIXED[slot] = 1;
  }
}

/** Every candidate without a spot holds: his TAI-01 home, or where he stands (kick-off). */
function holdRest(s: SimState, current: boolean): void {
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (CAND[slot] === 0 || SPOT_ROLE[slot] !== 0) continue;
    const p = s.players[slot]!;
    const x = current ? p.x : p.homeX;
    const z = current ? p.z : p.homeZ;
    PT.x = x === x ? x : p.x;
    PT.z = z === z ? z : p.z;
    setSpot(slot, R.HOLD, -1);
  }
}

function legalizeSlot(s: SimState, slot: number): void {
  PT.x = SPOT_X[slot]!;
  PT.z = SPOT_Z[slot]!;
  legalizePt(s.players[slot]!.team);
  SPOT_X[slot] = PT.x;
  SPOT_Z[slot] = PT.z;
}

/** Push spots closer than minSpacing to an earlier spot / a fixed spot / a player without a spot apart. */
function separate(s: SimState): void {
  const sp = LT.minSpacing;
  const sp2 = sp * sp;
  for (let pass = 0; pass < 3; pass++) {
    let moved = 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      if (SPOT_ROLE[i] === 0 || SPOT_FIXED[i] === 1) continue;
      for (let j = 0; j < NUM_SLOTS; j++) {
        if (j === i) continue;
        let ox: number, oz: number;
        if (SPOT_ROLE[j] !== 0) {
          if (SPOT_FIXED[j] === 0 && j > i) continue;
          ox = SPOT_X[j]!;
          oz = SPOT_Z[j]!;
        } else {
          const q = s.players[j]!;
          if (q.active !== 1) continue;
          ox = q.x;
          oz = q.z;
        }
        const dx = SPOT_X[i]! - ox, dz = SPOT_Z[i]! - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= sp2) continue;
        const d = Math.sqrt(d2);
        let ux: number, uz: number;
        if (d > 1e-6) {
          ux = dx / d;
          uz = dz / d;
        } else { // same point: step sideways around the ball
          ux = -(SPOT_Z[i]! - C.bz);
          uz = SPOT_X[i]! - C.bx;
          const ul = Math.sqrt(ux * ux + uz * uz);
          if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = 0; uz = 1; }
          if ((i & 1) === 1) { ux = -ux; uz = -uz; }
        }
        SPOT_X[i] = ox + ux * (sp + 0.02);
        SPOT_Z[i] = oz + uz * (sp + 0.02);
        if (C.kind !== RestartKind.NONE) legalizeSlot(s, i);
        moved++;
      }
    }
    if (moved === 0) return;
  }
}

/**
 * Compute every candidate's set-piece spot for the current restart phase / shoot-out into module scratch. Pure
 * function of the state. Returns false when there is nothing to lay out (not a restart phase, restart taken).
 */
function computeAll(s: SimState): boolean {
  const m = s.match;
  if (m.phase === MatchPhase.SHOOT_OUT) {
    C.kind = RestartKind.NONE;
    C.bx = 0;
    C.bz = 0;
    layoutShootout(s);
    return true;
  }
  const kind = phaseKind(m.phase);
  if (kind === RestartKind.NONE) return false;
  if (m.restart.kind === kind && m.restart.taken === 1) return false;
  buildCtx(s, kind);
  prepare(s);
  L_N = 0;
  switch (kind) {
    case RestartKind.THROW_IN: layoutThrowIn(s); break;
    case RestartKind.GOAL_KICK: layoutGoalKick(); break;
    case RestartKind.CORNER: layoutCorner(s); break;
    case RestartKind.FREE_KICK: layoutFreeKick(s); break;
    case RestartKind.PENALTY: layoutPenalty(); break;
    default: break; // KICK_OFF: everybody holds where RUL-01 put him
  }
  holdRest(s, kind === RestartKind.KICK_OFF);
  layoutWall(s);
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (SPOT_ROLE[slot] !== 0 && SPOT_FIXED[slot] === 0) legalizeSlot(s, slot);
  }
  separate(s);
  return true;
}

// ---------------------------------------------------------------- routing round exclusion zones

/** Segment scratch for segHitsArea. */
const SEG = { x0: 0, z0: 0, x1: 0, z1: 0 };

/** Does the segment SEG enter the penalty area of `end` grown by routeClear? (Liang-Barsky clip.) */
function segHitsArea(end: number): boolean {
  const x0 = SEG.x0, z0 = SEG.z0, x1 = SEG.x1, z1 = SEG.z1;
  const u0 = end * x0, u1 = end * x1;
  const uMin = HALF_LENGTH - PENALTY_AREA_DEPTH - LT.routeClear;
  const hw = PENALTY_AREA_HALF_WIDTH + LT.routeClear;
  let t0 = 0, t1 = 1;
  const du = u1 - u0;
  if (du > -1e-12 && du < 1e-12) {
    if (u0 < uMin) return false;
  } else {
    const t = (uMin - u0) / du;
    if (du > 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
  }
  const dz = z1 - z0;
  if (dz > -1e-12 && dz < 1e-12) {
    if (z0 > hw || z0 < -hw) return false;
  } else {
    const ta = (hw - z0) / dz, tb = (-hw - z0) / dz;
    const lo = ta < tb ? ta : tb, hi = ta < tb ? tb : ta;
    if (lo > t0) t0 = lo;
    if (hi < t1) t1 = hi;
  }
  return t0 <= t1;
}

/**
 * Where `slot` heads for now on his way to his spot, into PT (computeAll must have run): standing in a zone he may not
 * be in, the nearest legal point (the way RUL-11 pushes him); a straight walk that would cross the 9.15 m / 2 m disc
 * or the penalty area, a detour point round it (re-evaluated every tick, so he walks round the edge); else the spot.
 */
function routeTo(s: SimState, slot: number): void {
  const sx = SPOT_X[slot]!, sz = SPOT_Z[slot]!;
  if (SPOT_FIXED[slot] === 1 || C.kind === RestartKind.NONE || C.kind === RestartKind.KICK_OFF) {
    PT.x = sx;
    PT.z = sz;
    return;
  }
  const p = s.players[slot]!;
  const team = p.team;
  const px = p.x, pz = p.z;
  PT.x = px;
  PT.z = pz;
  if (!ptLegal(team, 0)) {
    legalizePt(team);
    return;
  }
  const opp = team !== C.att;
  if (C.kind === RestartKind.PENALTY || opp) {
    const dx = sx - px, dz = sz - pz;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((C.cx - px) * dx + (C.cz - pz) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px + dx * t - C.cx, qz = pz + dz * t - C.cz;
    const q = Math.sqrt(qx * qx + qz * qz);
    if (q < C.rad + LT.routeClear) {
      let ux: number, uz: number;
      if (q > 1e-6) {
        ux = qx / q;
        uz = qz / q;
      } else {
        const l = Math.sqrt(l2);
        if (l > 1e-6) { ux = -dz / l; uz = dx / l; } else { ux = -dirOf(team); uz = 0; }
      }
      const rr = C.rad + MARGIN + LT.routeOut;
      PT.x = C.cx + ux * rr;
      PT.z = C.cz + uz * rr;
      clampPt();
      if (ptLegal(team, 0)) return;
    }
  }
  SEG.x0 = px;
  SEG.z0 = pz;
  SEG.x1 = sx;
  SEG.z1 = sz;
  if (C.paEnd !== 0 && (C.kind === RestartKind.PENALTY || opp) && segHitsArea(C.paEnd)) {
    const beside = pz > PENALTY_AREA_HALF_WIDTH || pz < -PENALTY_AREA_HALF_WIDTH;
    const side = beside ? (pz < 0 ? -1 : 1) : (sz < 0 ? -1 : 1);
    PT.x = C.paEnd * (HALF_LENGTH - PENALTY_AREA_DEPTH - MARGIN - LT.routeOut);
    PT.z = side * (PENALTY_AREA_HALF_WIDTH + MARGIN + LT.routeOut);
    clampPt();
    return;
  }
  PT.x = sx;
  PT.z = sz;
}

// ---------------------------------------------------------------- public: positions

export function setPiecePositions(s: SimState, team: number, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  if (!computeAll(s)) return;
  const first = teamFirstSlot(team);
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (SPOT_ROLE[slot] === 0 || !isJobDriven(s, slot)) continue;
    const p = s.players[slot]!;
    const a = s.attrs[slot]!;
    const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
    const dx = SPOT_X[slot]! - p.x, dz = SPOT_Z[slot]! - p.z;
    const far = dx * dx + dz * dz > LT.farDist * LT.farDist;
    routeTo(s, slot);
    assignJob(s, slot, AiJob.SET_PIECE, PT.x, PT.z, top * (far ? LT.farFrac : LT.jogFrac), SPOT_TGT[slot]!);
  }
}

/**
 * The set-piece spot of `slot` in the current restart / shoot-out, written to `out` (the target setPiecePositions gives
 * him; also computed for a CPU-controlled player). Returns its SpotRole, 0 when he gets none (taker, keeper, human,
 * not a restart phase).
 */
export function setPieceTarget(s: SimState, slot: number, out: { x: number; z: number }): number {
  if (!(slot >= 0 && slot < NUM_SLOTS) || !computeAll(s)) return SpotRole.NONE;
  const role = SPOT_ROLE[slot]!;
  if (role !== 0) { out.x = SPOT_X[slot]!; out.z = SPOT_Z[slot]!; }
  return role;
}

/** Zone of the current free kick (FkZone; NONE outside a FREE_KICK phase). */
export function freeKickZone(s: SimState): number {
  if (phaseKind(s.match.phase) !== RestartKind.FREE_KICK) return FkZone.NONE;
  buildCtx(s, RestartKind.FREE_KICK);
  return C.fkZone;
}

// ================================================================ CPU

const STEP_IDLE = 0;
const STEP_AIM = 1;
const STEP_HOLD = 2;
const STEP_TAP = 3;
const STEP_DTAP = 4;
const STEP_WAIT = 5;
const FLAG_KEEP_AIM = 1;
/** Defending flags (p1). */
const DF_JUMPED = 1;
const DF_OFFSET = 2;

function stepOf(b: CpuBrainState): number { return b.p1 & 15; }
function attemptOf(b: CpuBrainState): number { return (b.p1 >> 4) & 15; }
function flagsOf(b: CpuBrainState): number { return (b.p1 >> 8) & 255; }
function setP1(b: CpuBrainState, step: number, attempt: number, flags: number): void {
  b.p1 = (step & 15) | ((attempt & 15) << 4) | ((flags & 255) << 8);
}
function setStep(b: CpuBrainState, step: number): void {
  setP1(b, step, attemptOf(b), flagsOf(b));
  b.planT = 0;
}

function resetProgram(b: CpuBrainState, key: number): void {
  b.p0 = key;
  b.p1 = 0;
  b.p2 = 0;
  b.p3 = 0;
  b.plan = CpuPlan.NONE;
  b.planT = 0;
  b.planSlot = -1;
  b.planX = 0;
  b.planZ = 0;
  b.holdTicks = 0;
}

/** Key of the current restart: -(1 + tick it was awarded) (s.tick - restart.t is constant while it runs). */
function restartKey(s: SimState): number {
  return -(1 + (s.tick - s.match.restart.t));
}

function shootoutKey(s: SimState): number {
  const so = s.match.shootout;
  return -(2000000 + ((so.taken[0]! & 1023) * 1024 + (so.taken[1]! & 1023)) * 2 + (so.team === 1 ? 1 : 0));
}

function fillTicks(c: Readonly<ControllerState>): number {
  return c.fastPower === 1 ? T_PASS.powerFillTicksFast : T_PASS.powerFillTicks;
}

function holdFor(power: number, fill: number): number {
  const h = Math.round(clamp(power, 0, 1) * fill);
  return h < 1 ? 1 : h;
}

/** A button kick: aim the stick at (x, z), then hold `btn` for holdTicks ticks; curl -1..1 via the right stick. */
function planKick(b: CpuBrainState, plan: CpuPlan, btn: number, holdTicks: number, x: number, z: number, slot: number,
  curl: number, keepAim: boolean): void {
  b.plan = plan;
  b.p2 = btn;
  b.p3 = curl;
  b.holdTicks = holdTicks < 1 ? 1 : holdTicks;
  b.planX = x;
  b.planZ = z;
  b.planSlot = slot;
  setP1(b, STEP_AIM, attemptOf(b), keepAim ? FLAG_KEEP_AIM : 0);
  b.planT = 0;
}

/** An immediate press (no aim), held holdTicks ticks. */
function planPress(s: SimState, b: CpuBrainState, plan: CpuPlan, btn: number, holdTicks: number): void {
  planKick(b, plan, btn, holdTicks, s.ball.x, s.ball.z, -1, 0, false);
  setStep(b, STEP_HOLD);
}

/** A gesture tap on a teammate / point (exact target); a retried decision uses the button equivalent instead. */
function planTap(s: SimState, b: CpuBrainState, plan: CpuPlan, lofted: boolean, slot: number, x: number, z: number,
  fbBtn: number, fbHold: number): void {
  if (attemptOf(b) > 0) {
    planKick(b, plan, fbBtn, fbHold, x, z, slot, 0, false);
    return;
  }
  b.plan = plan;
  b.p2 = 0;
  b.p3 = 0;
  b.holdTicks = 0;
  b.planX = x;
  b.planZ = z;
  b.planSlot = slot;
  setP1(b, lofted ? STEP_DTAP : STEP_TAP, 0, 0);
  b.planT = 0;
}

function aimLength(b: CpuBrainState): number {
  return b.plan === CpuPlan.SHOOT ? LT.shotAimTicks : LT.aimTicks;
}

/** A corner cross by button: the stick drives RUL-04's aim reticle (a velocity), not a direction from the ball. */
function reticleAim(s: SimState, b: CpuBrainState): boolean {
  return s.match.phase === MatchPhase.CORNER && b.p2 === Btn.LOB;
}

/** Aiming finished: the stick has been held aimTicks (shots shotAimTicks), or the corner reticle is on target. */
function aimDone(s: SimState, b: CpuBrainState): boolean {
  if (reticleAim(s, b)) {
    const r = s.match.restart;
    const dx = b.planX - r.aimX, dz = b.planZ - r.aimZ;
    return dx * dx + dz * dz <= LT.reticleTol * LT.reticleTol || b.planT >= LT.reticleMaxAimTicks;
  }
  return b.planT >= aimLength(b);
}

/** Left stick on the aim (from the ball; corner crosses: steering the reticle), right stick + frame.curve for curl. */
function emitAim(s: SimState, b: CpuBrainState, out: InputFrame): void {
  if (reticleAim(s, b)) {
    const r = s.match.restart;
    const ex = b.planX - r.aimX, ez = b.planZ - r.aimZ;
    const e = Math.sqrt(ex * ex + ez * ez);
    if (e <= LT.reticleTol * 0.5) return;
    const m = e / LT.reticleSlow;
    const mag = (m < LT.stickMinMag ? LT.stickMinMag : m > 1 ? 1 : m) * LT.aimStick;
    out.mx = Math.round((ex / e) * mag);
    out.mz = Math.round((ez / e) * mag);
    return;
  }
  let dx = b.planX - s.ball.x, dz = b.planZ - s.ball.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return;
  dx /= d;
  dz /= d;
  out.mx = Math.round(dx * LT.aimStick);
  out.mz = Math.round(dz * LT.aimStick);
  const curl = b.p3 < -1 ? -1 : b.p3 > 1 ? 1 : b.p3;
  if (curl !== 0) {
    // Positive curl bends toward n = (-dz, dx): toward +z when kicking toward +x (contracts/input.ts curve).
    out.ax = Math.round(-dz * curl * LT.aimStick);
    out.az = Math.round(dx * curl * LT.aimStick);
    out.curve = Math.round(curl * AXIS_SCALE);
    out.buttons |= Btn.RS_HOLD;
  }
}

function quantPos(v: number): number {
  const q = Math.round(v * GESTURE_POS_SCALE);
  return q < -1023 ? -1023 : q > 1023 ? 1023 : q;
}

/** Run one tick of the input program into `out`. */
function runProgram(s: SimState, b: CpuBrainState, taker: Readonly<PlayerState>, out: InputFrame): void {
  const step = stepOf(b);
  switch (step) {
    case STEP_AIM:
      emitAim(s, b, out);
      b.planT++;
      if (aimDone(s, b)) setStep(b, STEP_HOLD);
      return;
    case STEP_HOLD:
      emitAim(s, b, out);
      out.buttons |= b.p2;
      b.planT++;
      if (b.planT >= b.holdTicks) {
        setStep(b, STEP_WAIT);
        b.plan = CpuPlan.NONE;
        b.holdTicks = 0;
      }
      return;
    case STEP_TAP:
    case STEP_DTAP:
      out.gesture = step === STEP_TAP ? GestureKind.TAP : GestureKind.DOUBLE_TAP;
      out.gSlot = b.planSlot;
      out.gx = quantPos(b.planX);
      out.gz = quantPos(b.planZ);
      setStep(b, STEP_WAIT);
      b.plan = CpuPlan.NONE;
      return;
    case STEP_WAIT: {
      b.planT++;
      if ((flagsOf(b) & FLAG_KEEP_AIM) !== 0 && b.planT <= LT.postAimTicks) emitAim(s, b, out);
      if (b.planT >= LT.retryTicks && takerWaiting(taker)) {
        const at = attemptOf(b);
        setP1(b, STEP_IDLE, at < 15 ? at + 1 : 15, 0);
        b.planT = 0;
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------- CPU decisions

/** Nearest active opponent of `team` to (x, z), m (1e9 when none). */
function openness(s: SimState, team: number, x: number, z: number): number {
  const opp = team === 0 ? 1 : 0;
  const first = teamFirstSlot(opp);
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

/** Closest approach of an active opponent of `team` to the segment (x0, z0) -> (x1, z1), m. */
function laneClearance(s: SimState, team: number, x0: number, z0: number, x1: number, z1: number): number {
  const opp = team === 0 ? 1 : 0;
  const first = teamFirstSlot(opp);
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz;
  let best = 1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    let t = l2 > 1e-9 ? ((q.x - x0) * dx + (q.z - z0) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + dx * t - q.x, cz = z0 + dz * t - q.z;
    const c = cx * cx + cz * cz;
    if (c < best) best = c;
  }
  return best >= 1e18 ? 1e9 : Math.sqrt(best);
}

/** Power 0..1 of a ground pass over `d` metres. */
function shortPower(d: number): number {
  const v = clamp(groundPassSpeed(d, LT.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
  return clamp((v - T_PASS.groundMin) / (T_PASS.groundMax - T_PASS.groundMin), LT.shortPowerMin, 1);
}

/** Power 0..1 of a long kick over `d` metres. */
function longPower(d: number): number {
  return clamp(d / LT.longPowerRange, LT.longPowerMin, 1);
}

/**
 * A kick line the AI may pick: one whose continuation passes the own goal line outside the posts by ownGoalMargin.
 * strict = 1 (goal kicks, deep in the own end): also forward or sideways only, or back on the ball's side moving away
 * from the goal (never back across the goal mouth), like RUL-03's default.
 */
function laneOk(s: SimState, team: number, x0: number, z0: number, dx: number, dz: number, strict: number): boolean {
  const dir = s.teams[team]!.dir;
  if (dir * dx >= 0) return true;
  if (strict === 1 && (z0 < 0 ? -dz : dz) <= 0) return false;
  const e = -dir;
  const t = (e * HALF_LENGTH - x0) / dx;
  const zHit = z0 + dz * t;
  const lim = GOAL_HALF_WIDTH + LT.ownGoalMargin;
  return zHit > lim || zHit < -lim;
}

/** Target-man tier of a role: forwards 3, attacking midfielders / wingers 2, other midfielders 1, the rest 0. */
function targetTier(role: Role): number {
  switch (role) {
    case Role.ST: case Role.CF: return 3;
    case Role.CAM: case Role.LW: case Role.RW: return 2;
    case Role.CM: case Role.CDM: case Role.LM: case Role.RM: return 1;
    default: return 0;
  }
}

/** Target man for a long kick from (x0, z0): forwards first, then best in the air, then the more open. -1 if none. */
function bestTargetMan(s: SimState, team: number, from: number, x0: number, z0: number, strict: number): number {
  const first = teamFirstSlot(team);
  const lim = HALF_LENGTH - 1, limZ = HALF_WIDTH - 1;
  let best = -1;
  let bestScore = -1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === from) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    if (q.x < -lim || q.x > lim || q.z < -limZ || q.z > limZ) continue;
    const dx = q.x - x0, dz = q.z - z0;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < LT.gkLongMin || d > LT.gkLongMax || !laneOk(s, team, x0, z0, dx, dz, strict)) continue;
    const a = s.attrs[i]!;
    const open = openness(s, team, q.x, q.z);
    const sc = 1000 * targetTier(q.role) + a.heading + 0.5 * (a.height - 180) + (open < 15 ? open : 15);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

/** Goal kick short option: an open defender with a clear lane (RUL-03's default rule), best scored. -1 if none. */
function openDefender(s: SimState, team: number, from: number, x0: number, z0: number, noise: number): number {
  const first = teamFirstSlot(team);
  const lim = HALF_LENGTH - 1, limZ = HALF_WIDTH - 1;
  let best = -1;
  let bestScore = -1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === from) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1 || !isDefenderRole(q.role)) continue;
    if (q.x < -lim || q.x > lim || q.z < -limZ || q.z > limZ) continue;
    const dx = q.x - x0, dz = q.z - z0;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < LT.gkShortMin || d > LT.gkShortMax || !laneOk(s, team, x0, z0, dx, dz, 1)) continue;
    const open = openness(s, team, q.x, q.z);
    const lane = laneClearance(s, team, x0, z0, q.x, q.z);
    if (open < LT.gkOpenDist || lane < LT.gkLaneClear) continue;
    const sc = (open < 15 ? open : 15) + 0.5 * (lane < 8 ? lane : 8) - 0.1 * d + rngGauss(s.rng) * noise * LT.noiseScale;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

/**
 * Best pass target of `team` from (x0, z0) for a set-piece kick by `from`: teammates (outfield; the keeper only when
 * nobody else qualifies) inside the pitch, minD..maxD away, line clear of the own goal; score = openness + lane
 * clearance + progress - long-distance penalty + level noise. -1 if none.
 */
function bestPassTarget(s: SimState, team: number, from: number, x0: number, z0: number, minD: number, maxD: number,
  noise: number, strict: number): number {
  const first = teamFirstSlot(team);
  const dir = s.teams[team]!.dir;
  const lim = HALF_LENGTH - 1, limZ = HALF_WIDTH - 1;
  for (let pass = 0; pass < 2; pass++) {
    let best = -1;
    let bestScore = -1e18;
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      if (i === from) continue;
      const q = s.players[i]!;
      if (q.active !== 1 || (pass === 0 && q.isKeeper === 1)) continue;
      if (q.x < -lim || q.x > lim || q.z < -limZ || q.z > limZ) continue;
      const dx = q.x - x0, dz = q.z - z0;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < minD || d > maxD) continue;
      if (!laneOk(s, team, x0, z0, dx, dz, strict)) continue;
      const open = openness(s, team, q.x, q.z);
      const lane = laneClearance(s, team, x0, z0, q.x, q.z);
      let sc = LT.openWeight * (open < LT.openCap ? open : LT.openCap) +
        LT.laneWeight * (lane < LT.laneCap ? lane : LT.laneCap) + LT.progressWeight * dir * dx;
      if (d > LT.passLongFrom) sc -= LT.passLongPenalty * (d - LT.passLongFrom);
      sc += rngGauss(s.rng) * noise * LT.noiseScale;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Best cross target of `team` (computeAll must have run): teammates in the box (or holding the preferred spot role),
 * by heading + openness + the tactic bonus + level noise. -1 if none.
 */
function crossTarget(s: SimState, team: number, taker: number, prefer: number, noise: number): number {
  const first = teamFirstSlot(team);
  const dir = s.teams[team]!.dir;
  let best = -1;
  let bestScore = -1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === taker) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const pref = prefer !== 0 && SPOT_ROLE[i] === prefer;
    const dg = HALF_LENGTH - dir * q.x;
    const wide = q.z < -PENALTY_AREA_HALF_WIDTH || q.z > PENALTY_AREA_HALF_WIDTH;
    const inBox = dg >= 0 && dg <= LT.boxDepth && !wide;
    // The tactic's runner also counts just outside the box (edge of the box), never one still on his way up.
    if (!inBox && !(pref && dg >= 0 && dg <= LT.boxDepth + 4 && !wide)) continue;
    const a = s.attrs[i]!;
    const open = openness(s, team, q.x, q.z);
    let sc = a.heading + 0.5 * (a.height - 180) + LT.crossOpenWeight * (open < LT.crossOpenCap ? open : LT.crossOpenCap);
    if (pref) sc += LT.tacticBonus;
    sc += rngGauss(s.rng) * noise * LT.crossNoise;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

function crossPower(d: number): number {
  return clamp(d / LT.crossPowerRange, LT.crossPowerMin, LT.crossPowerMax);
}

/** True if `slot` (with a computed spot) stands within arriveTol of it. */
function arrived(s: SimState, slot: number): boolean {
  if (SPOT_ROLE[slot] === 0) return false;
  const p = s.players[slot]!;
  const dx = p.x - SPOT_X[slot]!, dz = p.z - SPOT_Z[slot]!;
  return dx * dx + dz * dz <= LT.arriveTol * LT.arriveTol;
}

function isBoxRole(role: number): boolean {
  return role === R.NEAR_POST || role === R.FAR_POST || role === R.PEN_SPOT || role === R.BOX ||
    role === R.SCREEN_KEEPER || role === R.LINE;
}

/** Number of box runners of `team` on their spots (computeAll must have run). */
function boxArrivals(s: SimState, team: number): number {
  const first = teamFirstSlot(team);
  let n = 0;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (isBoxRole(SPOT_ROLE[i]!) && arrived(s, i)) n++;
  return n;
}

/** Runners in the box still on their way: hold a cross back a little (bounded, see maxArrivalWait). */
function waitForRunners(s: SimState, team: number, age: number): boolean {
  const r = s.match.restart;
  if (age >= T_RULES.cpuRestartDelay + LT.maxArrivalWait) return false;
  if (r.kind !== RestartKind.CORNER && r.kind !== RestartKind.FREE_KICK) return false;
  if (!computeAll(s)) return false;
  if (r.kind === RestartKind.FREE_KICK && C.fkZone === FkZone.DEEP) return false;
  return boxArrivals(s, team) < LT.minBoxArrivals;
}

function findRole(team: number, role: number): number {
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (SPOT_ROLE[i] === role) return i;
  return -1;
}

/** Cross into the box (corners, wide free kicks): TAP the chosen header, or a zone point when nobody is there. */
function planCross(s: SimState, team: number, b: CpuBrainState, taker: number, prefer: number, fill: number): void {
  const lvl = levelOf(b);
  const r = s.match.restart;
  const tgt = crossTarget(s, team, taker, prefer, T_LEVEL.decisionNoise[lvl]!);
  if (tgt >= 0) {
    const q = s.players[tgt]!;
    const dx = q.x - r.x, dz = q.z - r.z;
    planTap(s, b, CpuPlan.CROSS, false, tgt, q.x, q.z, Btn.LOB, holdFor(crossPower(Math.sqrt(dx * dx + dz * dz)), fill));
    return;
  }
  const dir = s.teams[team]!.dir;
  const err = LT.zoneAimErr * T_LEVEL.executionError[lvl]!;
  const zx = dir * (HALF_LENGTH - LT.zoneDepth) + rngGauss(s.rng) * err;
  const zz = -(r.z < 0 ? -1 : 1) * 1 + rngGauss(s.rng) * err;
  const dx = zx - r.x, dz = zz - r.z;
  planTap(s, b, CpuPlan.CROSS, false, -1, zx, zz, Btn.LOB, holdFor(crossPower(Math.sqrt(dx * dx + dz * dz)), fill));
}

/** Short pass (PASS + stick + hold for the distance) to `slot`. */
function planShort(s: SimState, b: CpuBrainState, slot: number, fill: number): void {
  const r = s.match.restart;
  const q = s.players[slot]!;
  const dx = q.x - r.x, dz = q.z - r.z;
  const h = holdFor(shortPower(Math.sqrt(dx * dx + dz * dz)), fill);
  planKick(b, CpuPlan.PASS, Btn.PASS, h < 2 ? 2 : h, q.x, q.z, slot, 0, false);
}

/** A pass to a teammate by gesture: TAP (ground) up to tapGroundMax, DOUBLE_TAP (lofted) beyond. */
function planPassTo(s: SimState, b: CpuBrainState, slot: number, fill: number, forceLong: boolean): void {
  const r = s.match.restart;
  const q = s.players[slot]!;
  const dx = q.x - r.x, dz = q.z - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const lob = forceLong || d > LT.tapGroundMax;
  planTap(s, b, lob ? CpuPlan.CLEAR : CpuPlan.PASS, lob, slot, q.x, q.z, lob ? Btn.LOB : Btn.PASS,
    holdFor(lob ? longPower(d) : shortPower(d), fill));
}

/** Long ball straight ahead (nobody to aim at). */
function planLongAhead(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  const dir = s.teams[team]!.dir;
  const x = clamp(r.x + dir * LT.longAheadDist, -(HALF_LENGTH - 2), HALF_LENGTH - 2);
  planKick(b, CpuPlan.CLEAR, Btn.LOB, holdFor(longPower(LT.longAheadDist), fill), x, r.z * 0.5, -1, 0, false);
}

function decideThrowIn(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  const lvl = levelOf(b);
  const tgt = bestPassTarget(s, team, r.taker, r.x, r.z, LT.throwMinDist, LT.throwMaxDist, T_LEVEL.decisionNoise[lvl]!, 0);
  if (tgt >= 0) {
    const q = s.players[tgt]!;
    const dx = q.x - r.x, dz = q.z - r.z;
    planTap(s, b, CpuPlan.PASS, false, tgt, q.x, q.z, Btn.PASS, holdFor(shortPower(Math.sqrt(dx * dx + dz * dz)), fill));
    return;
  }
  const far = bestPassTarget(s, team, r.taker, r.x, r.z, LT.throwMaxDist, LT.throwLongMax, T_LEVEL.decisionNoise[lvl]!, 0);
  if (far >= 0) {
    const q = s.players[far]!;
    const dx = q.x - r.x, dz = q.z - r.z;
    planTap(s, b, CpuPlan.CLEAR, true, far, q.x, q.z, Btn.LOB, holdFor(longPower(Math.sqrt(dx * dx + dz * dz)), fill));
    return;
  }
  const dir = s.teams[team]!.dir;
  const tx = clamp(r.x + dir * LT.throwLongAhead, -LT.throwMaxX, LT.throwMaxX);
  const tz = r.z - (r.z < 0 ? -1 : 1) * LT.throwLongInfield;
  planKick(b, CpuPlan.CLEAR, Btn.LOB, holdFor(LT.throwLongPower, fill), tx, tz, -1, 0, false);
}

function isLongStyle(style: TeamStyle): boolean {
  return style === TeamStyle.DIRECT || style === TeamStyle.COUNTER;
}

function decideGoalKick(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  const noise = T_LEVEL.decisionNoise[levelOf(b)]!;
  const short = openDefender(s, team, r.taker, r.x, r.z, noise);
  const long = bestTargetMan(s, team, r.taker, r.x, r.z, 1);
  const goLong = long >= 0 && (short < 0 || (isLongStyle(s.teams[team]!.style) && rngFloat(s.rng) < LT.directLongChance));
  if (goLong) { planPassTo(s, b, long, fill, true); return; }
  if (short >= 0) { planPassTo(s, b, short, fill, false); return; }
  const any = bestPassTarget(s, team, r.taker, r.x, r.z, LT.gkShortMin, LT.gkShortMax, noise, 1);
  if (any >= 0) planPassTo(s, b, any, fill, false);
  else planLongAhead(s, team, b, fill);
}

function decideCorner(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  computeAll(s);
  const t = s.teams[team]!;
  const sh = findRole(team, R.SHORT);
  if (sh >= 0 && arrived(s, sh)) {
    const q = s.players[sh]!;
    const chance = LT.shortCornerChance[t.style] ?? LT.shortCornerChance[0]!;
    if (openness(s, team, q.x, q.z) >= LT.shortOpenMin && rngFloat(s.rng) < chance) {
      planShort(s, b, sh, fill);
      return;
    }
  }
  const ti = cornerTacticIndex(t.cornerTactic);
  const prefer = ti === 1 ? R.FAR_POST : ti === 2 ? R.EDGE : ti === 3 ? R.SCREEN_KEEPER : ti === 4 ? R.NEAR_POST : 0;
  planCross(s, team, b, r.taker, prefer, fill);
}

/** Free-kick quality of a taker, attribute points. */
function fkQuality(s: SimState, slot: number): number {
  const a = s.attrs[slot]!;
  return (a.curve + a.longShots + a.shotPower) / 3;
}

function planFreeKickShot(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  const lvl = levelOf(b);
  const dir = s.teams[team]!.dir;
  const gx = dir * HALF_LENGTH;
  let near = r.z < 0 ? -1 : 1;
  if (r.z > -1.5 && r.z < 1.5) near = rngFloat(s.rng) < 0.5 ? -1 : 1;
  const wallSide = rngFloat(s.rng) < LT.fkWallSideChance;
  const side = wallSide ? near : -near;
  const tz = side * (GOAL_HALF_WIDTH - LT.fkPostInset) + rngGauss(s.rng) * LT.fkAimErr * T_LEVEL.executionError[lvl]!;
  const kx = gx - r.x, kz = tz - r.z;
  const kl = Math.sqrt(kx * kx + kz * kz);
  // Bend toward the goal centre round the wall (near post) or away from the keeper (far post): lateral world-z sign.
  const bendZ = wallSide ? -tz : tz;
  const nz = kl > 1e-6 ? kx / kl : dir; // z component of the curl normal (-kz, kx) / |k|
  let sign = nz * bendZ >= 0 ? 1 : -1;
  if (bendZ === 0) sign = 1;
  const curveAttr = s.attrs[r.taker]!.curve;
  const curl = clamp(LT.fkCurlBase + LT.fkCurlAttr * (curveAttr - 60) / 40, LT.fkCurlMin, LT.fkCurlMax);
  const power = clamp(LT.fkPowerBase + (C.dGoal - 18) * LT.fkPowerPerM, LT.fkPowerMin, LT.fkPowerMax);
  planKick(b, CpuPlan.SHOOT, Btn.SHOOT, holdFor(power, fill), gx, tz, -1, sign * curl, true);
}

function decideFreeKick(s: SimState, team: number, b: CpuBrainState, fill: number): void {
  const r = s.match.restart;
  const lvl = levelOf(b);
  computeAll(s);
  const zone = C.fkZone;
  if (zone === FkZone.SHOOT) {
    const dg = C.dGoal;
    let p = dg <= 20 ? LT.fkShootChance[0]! : dg <= 26 ? LT.fkShootChance[1]! : LT.fkShootChance[2]!;
    const aB = C.aB > 0.01 ? C.aB : 0.01;
    const angle = datan2(GOAL_HALF_WIDTH - C.bz, aB) - datan2(-GOAL_HALF_WIDTH - C.bz, aB);
    p *= clamp(angle / LT.fkAngleFull, LT.fkAngleFloor, 1);
    p += (fkQuality(s, r.taker) - 65) / 100;
    if (rngFloat(s.rng) < p) {
      planFreeKickShot(s, team, b, fill);
      return;
    }
  }
  if (zone === FkZone.SHOOT || zone === FkZone.WIDE) {
    const sh = findRole(team, R.SHORT);
    if (zone === FkZone.WIDE && sh >= 0 && arrived(s, sh) && rngFloat(s.rng) < LT.fkShortChance) {
      planShort(s, b, sh, fill);
      return;
    }
    planCross(s, team, b, r.taker, R.LINE, fill);
    return;
  }
  // DEEP: keep it, or go long (direct styles).
  if (isLongStyle(s.teams[team]!.style) && rngFloat(s.rng) < LT.directLongChance) {
    const l = bestTargetMan(s, team, r.taker, r.x, r.z, 0);
    if (l >= 0) {
      planPassTo(s, b, l, fill, true);
      return;
    }
  }
  const tgt = bestPassTarget(s, team, r.taker, r.x, r.z, LT.fkPassMin, LT.fkPassMax, T_LEVEL.decisionNoise[lvl]!, 0);
  if (tgt >= 0) planPassTo(s, b, tgt, fill, false);
  else planLongAhead(s, team, b, fill);
}

/** Penalty / shoot-out kick by `kicker` at the goal nearest the ball: inside a post, natural-side bias, level error. */
function planPenaltyKick(s: SimState, b: CpuBrainState, kicker: number, fill: number): void {
  const lvl = levelOf(b);
  const ball = s.ball;
  const kdx = ball.x >= 0 ? 1 : -1;
  const gx = kdx * HALF_LENGTH;
  // Facing +x a player's right is +z, so facing kdx his right is kdx * z; right-footers favour their left.
  const natural = s.attrs[kicker]!.foot === Foot.LEFT ? kdx : -kdx;
  const side = rngFloat(s.rng) < LT.penNaturalChance ? natural : -natural;
  const inset = rngRange(s.rng, LT.penInsetMin, LT.penInsetMax);
  const tz = side * (GOAL_HALF_WIDTH - inset) + rngGauss(s.rng) * LT.penAimErr * T_LEVEL.executionError[lvl]!;
  const power = rngRange(s.rng, LT.penPowerMin, LT.penPowerMax);
  planKick(b, CpuPlan.SHOOT, Btn.SHOOT, holdFor(power, fill), gx, tz, -1, 0, true);
}

function decideRestart(s: SimState, team: number, c: Readonly<ControllerState>, b: CpuBrainState): void {
  const r = s.match.restart;
  const fill = fillTicks(c);
  switch (r.kind) {
    case RestartKind.KICK_OFF: planPress(s, b, CpuPlan.PASS, Btn.PASS, 1); break;
    case RestartKind.THROW_IN: decideThrowIn(s, team, b, fill); break;
    case RestartKind.GOAL_KICK: decideGoalKick(s, team, b, fill); break;
    case RestartKind.CORNER: decideCorner(s, team, b, fill); break;
    case RestartKind.FREE_KICK: decideFreeKick(s, team, b, fill); break;
    case RestartKind.PENALTY: planPenaltyKick(s, b, r.taker, fill); break;
    default: break;
  }
}

// ---------------------------------------------------------------- CPU sides

function takeRestart(s: SimState, team: number, c: Readonly<ControllerState>, b: CpuBrainState, out: InputFrame): void {
  const r = s.match.restart;
  if (r.ready !== 1) return;
  const t = r.taker;
  if (!(t >= 0 && t < NUM_SLOTS)) return;
  const p = s.players[t]!;
  if (p.active !== 1 || p.team !== team) return;
  if (stepOf(b) === STEP_IDLE) {
    const age = r.t - T_RULES.restartSetupTicks;
    if (age < T_RULES.cpuRestartDelay) return;
    if (r.kind !== RestartKind.KICK_OFF && c.slot !== t) return; // switching hands him to this controller first
    if (!takerWaiting(p)) return;
    if (attemptOf(b) === 0 && waitForRunners(s, team, age)) return;
    decideRestart(s, team, c, b);
    if (stepOf(b) === STEP_IDLE) return;
  }
  runProgram(s, b, p, out);
}

/** Wall jump: THROUGH when the taker's free-kick shot is about to make contact (level timing jitter). */
function wallJump(s: SimState, b: CpuBrainState, out: InputFrame): void {
  const r = s.match.restart;
  if ((b.p1 & DF_JUMPED) !== 0) return;
  const t = r.taker;
  if (!(t >= 0 && t < NUM_SLOTS)) return;
  const p = s.players[t]!;
  if (p.act !== ActionKind.SHOT || p.actCharging === 1 || p.actContact < 0 || p.actDone === 1) return;
  if ((b.p1 & DF_OFFSET) === 0) {
    b.p2 = Math.round(rngGauss(s.rng) * T_LEVEL.decisionNoise[levelOf(b)]! * LT.wallJumpJitter);
    b.p1 |= DF_OFFSET;
  }
  const ticksToContact = p.actContact - (p.actT + 1);
  if (ticksToContact <= LT.wallJumpLeadTicks + b.p2) {
    out.buttons |= Btn.THROUGH;
    b.p1 |= DF_JUMPED;
  }
}

/** The defending CPU's controlled player walks to his set-piece spot with the stick. */
function steerControlled(s: SimState, team: number, c: Readonly<ControllerState>, out: InputFrame): void {
  const slot = c.slot;
  if (!(slot >= 0 && slot < NUM_SLOTS)) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== team || p.isKeeper === 1 || p.act !== ActionKind.NONE || p.stunT > 0) return;
  if (!computeAll(s)) return;
  const role = SPOT_ROLE[slot]!;
  if (role === R.NONE || role === R.WALL) return;
  routeTo(s, slot);
  const dx = PT.x - p.x, dz = PT.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= LT.stickArrive) return;
  const m = d / LT.stickSlowDist;
  const mag = (m < LT.stickMinMag ? LT.stickMinMag : m > 1 ? 1 : m) * LT.aimStick;
  out.mx = Math.round((dx / d) * mag);
  out.mz = Math.round((dz / d) * mag);
  // Hurry when far, like the job-driven players (not at free kicks: there SPRINT moves the defending wall, RUL-05).
  if (d > LT.farDist && C.kind !== RestartKind.FREE_KICK) out.buttons |= Btn.SPRINT;
}

function defendRestart(s: SimState, team: number, c: Readonly<ControllerState>, b: CpuBrainState, out: InputFrame): void {
  const r = s.match.restart;
  if (r.kind === RestartKind.PENALTY || r.kind === RestartKind.KICK_OFF) return; // keeper dive: GKP-06
  if (r.kind === RestartKind.FREE_KICK && r.ready === 1 && r.wallCount > 0) wallJump(s, b, out);
  steerControlled(s, team, c, out);
}

/** Ball set on a penalty spot, the kicker beside it, waiting and held by this controller. */
function shootoutReady(s: SimState, c: Readonly<ControllerState>, k: number): boolean {
  const b = s.ball;
  const sx = HALF_LENGTH - PENALTY_SPOT_DIST;
  const ax = b.x < 0 ? -b.x : b.x;
  const tol = LT.spotTolerance;
  if (ax < sx - tol || ax > sx + tol || b.z < -tol || b.z > tol) return false;
  if (b.y > BALL_RADIUS + 0.1 || b.heldBy >= 0) return false;
  const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (v2 > LT.spotRestSpeed * LT.spotRestSpeed) return false;
  const p = s.players[k]!;
  const dx = p.x - b.x, dz = p.z - b.z;
  if (dx * dx + dz * dz > LT.kickerNear * LT.kickerNear) return false;
  return c.slot === k && takerWaiting(p);
}

function shootoutCpu(s: SimState, team: number, c: Readonly<ControllerState>, b: CpuBrainState, out: InputFrame): void {
  const so = s.match.shootout;
  if (so.active !== 1) return;
  const key = shootoutKey(s);
  if (b.p0 !== key) resetProgram(b, key);
  if (so.team !== team) return; // keeper: GKP-06 chooses the dive
  const k = so.kicker;
  if (!(k >= 0 && k < NUM_SLOTS)) return;
  const p = s.players[k]!;
  if (p.active !== 1 || p.team !== team) return;
  if (stepOf(b) === STEP_IDLE) {
    if (!shootoutReady(s, c, k)) { b.planT = 0; return; }
    b.planT++;
    if (b.planT < T_RULES.cpuRestartDelay) return;
    planPenaltyKick(s, b, k, fillTicks(c));
  }
  runProgram(s, b, p, out);
}

export function cpuSetPiece(s: SimState, team: number, out: InputFrame, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  const ci = CPU_CONTROLLER_BASE + team;
  if (ci >= s.ctrl.length) return;
  const c = s.ctrl[ci]!;
  if (c.kind !== ControllerKind.CPU || c.side !== team) return;
  const b = s.teams[team]!.cpu;
  const phase = s.match.phase;
  if (phase === MatchPhase.SHOOT_OUT) {
    shootoutCpu(s, team, c, b, out);
    return;
  }
  const kind = phaseKind(phase);
  if (kind === RestartKind.NONE) return;
  const r = s.match.restart;
  if (r.kind !== kind || r.taken === 1) return;
  const key = restartKey(s);
  if (b.p0 !== key) resetProgram(b, key);
  if (r.team === team) takeRestart(s, team, c, b, out);
  else defendRestart(s, team, c, b, out);
}

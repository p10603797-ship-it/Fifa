/**
 * [RUL-02] Throw-ins - taker at the crossing point, opponents 2 m away, move along the line, short throw (PASS) or long throw (hold LOB); THROW_IN action handler; no offside from throw-ins; a goal cannot be scored direct from a throw-in.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 *
 * Flow (RUL-11 awardRestart -> throwInSetup; RUL-01 rulesTick -> RUL-11 restartTick -> throwInTick every tick):
 *  - Setup: taker = the nearest active outfield player of the throwing team to the spot, never the keeper (RUL-11
 *    pickRestartTaker; players who are down are avoided). He starts ActionKind.THROW_IN in sub-state APPROACH and
 *    walks to his spot just outside the touchline (RUL-11 restartTakerSpot) while the ball lies on the line.
 *  - The ball goes into his hands when he reaches the spot, or at the latest when the restart becomes ready (he is put
 *    on the spot at the restart camera cut, D-008, and RUL-11 legalizePositions runs again so every opponent is >= 2 m
 *    from the ball in his hands). Held ball: ball.owner = taker (never heldBy, that is keepers only), centre above his
 *    head (throwHandsHeight), zero velocity, re-set every tick (rulesTick runs after ball physics). The taker stands
 *    outside the touchline; the ball is held over the line, just inside SIM-03's out-of-play plane (releaseInside),
 *    so a kick from where it is held (the release, or RUL-11's forced safety-net kick) starts in play and the
 *    watchdog never sees a live ball out of play. RUL-11 leaves a ball the throw-in taker owns alone and re-places a
 *    ball anyone else got.
 *  - Input (the taker's controller, after restart.ready; any controller of the side if no controller drives him):
 *    left stick along the line moves him (max lineLeash m from the spot, he stays outside the line) and aims; PASS
 *    press -> short throw; LOB press starts the power bar (p.actCharging, p.actPower = hold / fill ticks), release ->
 *    long throw (auto-release chargeAutoReleaseTicks after full); pitch TAP on a teammate / spot -> throw there,
 *    DOUBLE_TAP -> long throw there. Target: SIM-08 selectReceiver by stick (validated; consulted when the throw is
 *    committed), else the best teammate in the stick cone (short range first, then up to longMaxDist), else a point
 *    along the stick (MANUAL assistance: always the stick direction); neutral stick -> the best open teammate. While
 *    waiting the taker faces his current target (restart.aimX/aimZ, aimPower = power; p.actSlot/actX/actZ = preview).
 *  - Default (RUL-11 timeout for humans, and the CPU fallback): short throw to the best open teammate (a long throw if
 *    nobody is within shortMaxDist). A side without a human throws by itself T_RULES.cpuRestartDelay + cpuGraceTicks
 *    after the taker holds the ball (before RUL-11's CPU timeout, so no watchdog), unless its CPU brain threw first.
 *  - The throw: wind-up (windupTicks), then applyKick(KickKind.THROW_IN) from the hands with a solved launch (speed
 *    8..18 m/s; short throws flat, long throws lofted; the first landing is the target, leading a moving receiver).
 *    ball.passTarget = the receiver. applyKick sets restart.taken; RUL-01 returns to IN_PLAY. The release point is
 *    over the line (never beyond SIM-03's out-of-play plane, so the watchdog never sees a live ball out of play) and
 *    every target lies inside the pitch, so every throw enters the field and the horizontal path (no spin) never
 *    turns back over the touchline. Afterwards the thrower steps back onto the pitch (RECOVER) before he is free
 *    again (glitch "players stay off the pitch after a throw-in").
 *  - Offside: none from a throw-in (RUL-08 never snapshots a THROW_IN kick). Goal direct from a throw-in: never
 *    counts; noGoalDirectFromThrow(s) is the rule (RUL-01 machine.ts applies the same check and gives a goal kick /
 *    corner instead).
 *  - Taker validity: re-picked whenever he is sent off, no longer on the team, or became the keeper; THROW_IN actions
 *    left on anyone else end (inactive players) or turn into RECOVER.
 *
 * THROW_IN action fields: p.actA = ThrowState sub-state (each sub-state starts with beginAction, so p.actT counts
 * ticks in it); p.actKick = THROW_IN; p.actB = ThrowFlag bits; p.actPower = long-throw power 0..1; p.actSlot = target
 * receiver (-1 = a point); p.actX/actZ = target point; p.actDirX/actDirZ = throw direction once committed;
 * p.actContact = release tick of the WINDUP; p.actDone = 1 once released. p.ix carries the stick along the line from
 * throwInInput to the handler for one tick (consumed). Movement is LOCKED (the handler sets vx/vz and facing).
 *
 * Helper module: throwinHooks.ts (import-cycle-safe handler shell, re-exported first below).
 * Deterministic and allocation-free per tick (module scratch only; slot-order loops).
 */
// Re-export the handler shell FIRST (import-cycle safety with actions/registry; see throwinHooks.ts).
export { throwInHandler } from './throwinHooks';
import { bindThrowInImpl } from './throwinHooks';
import { BALL_RADIUS, DT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { Btn, GESTURE_POS_SCALE, type InputFrame } from '../../contracts/input';
import { MoveMode, createBallState, type PlayerState, type SimState } from '../../contracts/state';
import { createKickLaunch } from '../../contracts/systems';
import { T_PASS, T_RULES } from '../../contracts/tuning';
import { beginAction, endAction } from '../actions/dispatch';
import { ballAirStep } from '../ball/flight';
import { dcos, dsin } from '../core/dmath';
import { applyKick, releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import { selectReceiver } from '../kicks/pass';
import { BALL_OUT_Z } from '../pitch/geometry';
import { isValidTaker, legalizePositions, pickRestartTaker, restartTakerSpot } from './restart';

/** TUNING-CR (RUL-02): proposed additions to T_RULES / a new T_THROW block (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Throw speed range, m/s (brief: 8-18). */
  speedMin: 8,
  speedMax: 18,
  /** Launch elevation of a short / long throw, rad. The speed is solved for the target; the elevation only changes
   *  when the speed hits its range (flatter for very short throws, up to maxRangeAngle for far ones). */
  shortAngle: 0.3,
  longAngle: 0.62,
  /** Elevation of the longest throw at speedMax (~29.5 m from a 2 m release with SIM-01 drag), rad; flattest
   *  elevation tried, rad. */
  maxRangeAngle: 0.72,
  minAngle: -1.0,
  /** A short throw (PASS) goes at most this far, m; the default turns a farther target into a long throw. */
  shortMaxDist: 22,
  /** Long throw (hold LOB): distance aimed at power 0 / 1 without a receiver, m; receivers up to longMaxDist, m. */
  longMinDist: 12,
  longMaxDist: 28,
  /** Short throw into space (no receiver in the stick direction), m. */
  shortFreeDist: 10,
  /** A throw lands at least this far from the ball, m. */
  minThrowDist: 3,
  /** Throw targets are kept this far inside the touchlines and goal lines, m. */
  targetMargin: 1,
  /** Receiver lead: fraction of (receiver velocity x flight time) added to his position, capped at leadMax m (a
   *  run to a set-piece spot is not a straight run; the receiver logic adjusts to ball.passX/passZ). */
  leadFactor: 0.6,
  leadMax: 5,
  /** Ball centre this far above the thrower's height (attrs.height), m, clamped to [handsMin, handsMax], m. */
  ballAboveHead: 0.15,
  handsMin: 1.7,
  handsMax: 2.3,
  /** Ball held this far behind the thrower's centre (along his facing) while waiting / at the end of the wind-up,
   *  m; released this far ahead of it along the throw, m. */
  holdBack: 0.1,
  windupBack: 0.3,
  releaseAhead: 0.15,
  /** The held ball and the release point stay at least this far inside the touchline out-of-play plane (SIM-03
   *  BALL_OUT_Z), m: over the line, never behind it. */
  releaseInside: 0.02,
  /** Wind-up ticks before the release, recovery ticks after it, extra recovery ticks at most while still off the
   *  pitch. */
  windupTicks: 12,
  recoveryTicks: 16,
  recoveryExtraMax: 40,
  /** After the throw the thrower steps onto the pitch: to this far inside the touchline, m, at this speed, m/s. */
  returnInset: 0.8,
  returnSpeed: 3.5,
  /** Moving along the line (left stick): max distance from the spot, m (brief: 3 m); speed, m/s; stick dead zone
   *  (0..1, also the "stick pushed" threshold for aiming). */
  lineLeash: 3,
  shuffleSpeed: 2.2,
  stickDead: 0.25,
  /** Before the ball is in his hands the taker walks to his spot: speed m/s, arrival gain 1/s; he takes the ball
   *  within pickupRadius m of the spot (at ready he is put there). */
  approachSpeed: 5,
  approachGain: 4,
  pickupRadius: 0.35,
  /** Thrower facing turn rate, rad/s; min component of his facing into the pitch (unit vector). */
  turnRate: 8,
  minInward: 0.35,
  /** Waiting budget of the THROW_IN action; extended whenever it is about to run out, ticks. */
  waitBudgetTicks: 60,
  /** Long throw: auto-release this many ticks after the power bar is full (never stuck full), ticks. */
  chargeAutoReleaseTicks: 24,
  /** A side without a human throws by itself T_RULES.cpuRestartDelay + this many ticks after its taker holds the
   *  ball (its CPU brain may throw earlier through its InputFrame), ticks. */
  cpuGraceTicks: 30,
  /** Receiver choice: ideal short-throw distance, m; openness cap, m; lane-clearance cap, m. */
  idealDist: 10,
  openCap: 8,
  laneCap: 3,
  /** Weights: openness, distance from the ideal (relative), progress toward the attacked goal (per progressScale
   *  m, capped at +-1), stick direction (cosine), lane clearance (short throws). */
  wOpen: 1,
  wDist: 0.6,
  wProg: 0.35,
  progressScale: 20,
  wDir: 1.2,
  wLane: 0.4,
  /** Power used to rank receivers when the default has nobody in short range, 0..1. */
  defaultLongPower: 0.5,
  /** Power passed to SIM-08 selectReceiver for a short throw, 0..1. */
  shortSelectPower: 0.35,
  /** Pitch tap: the teammate within this distance of the tapped point, m; taps this close to the ball are ignored. */
  tapRadius: 3,
  tapMinDist: 1.5,
  /** Throw solver: bisection iterations; flight integration cap, ticks. */
  solveIters: 18,
  flightMaxTicks: 360,
} as const;

/** Sub-states of the THROW_IN action (p.actA). */
export const ThrowState = {
  /** Walking to the spot behind the line; the ball lies on the line. */
  APPROACH: 0,
  /** Ball held above the head; may move along the line; waiting for the throw. */
  HOLD: 1,
  /** Long throw power filling while LOB is held (p.actCharging = 1, p.actPower 0..1). */
  CHARGE: 2,
  /** Throw committed: wind-up, ball released at p.actContact. */
  WINDUP: 3,
  /** Released (or the restart went away): stepping back onto the pitch, then free. */
  RECOVER: 4,
} as const;

/** p.actB bits of a THROW_IN action. */
export const ThrowFlag = {
  /** Long throw (lofted, power from the hold). */
  LONG: 1,
  /** The target follows the receiver (p.actSlot) until the release. */
  TRACK: 2,
} as const;

/** Launch solved by solveThrow. */
export interface ThrowSolution {
  /** |v| at release, m/s (speedMin..speedMax). */
  speed: number;
  /** Elevation above horizontal, rad. */
  angle: number;
  /** Air time to the first landing, s. */
  flightT: number;
  /** Horizontal distance to the first landing, m. */
  range: number;
  /** 1 if range is within a few cm of the requested distance. */
  reached: number;
}

export function createThrowSolution(): ThrowSolution {
  return { speed: 0, angle: 0, flightT: 0, range: 0, reached: 0 };
}

// ---------------------------------------------------------------- module scratch (no allocation per tick)

const SPOT = { x: 0, z: 0 };
const LAUNCH = createKickLaunch();
const SOL = createThrowSolution();
/** Scratch ball for the throw solver. */
const FLY = createBallState();
/** Last flyRange: [range m, flight time s, 1 = landed]. */
const LAND = new Float64Array(3);
/** Chosen target: receiver slot (-1 = a point), point, 1 = follow the receiver until the release. */
const PICK = { recv: -1, x: 0, z: 0, track: 0 };
/** Bit index of Btn.LOB in ControllerState.holdT. */
const BI_LOB = 31 - Math.clz32(Btn.LOB);
/** Cosine of the stick cone for receivers. */
const COS_CONE = dcos(T_PASS.coneHalfAngle);
/** Facing turn per tick (cos, sin of turnRate * DT). */
const COS_TURN = dcos(LOCAL_TUNING.turnRate * DT);
const SIN_TURN = dsin(LOCAL_TUNING.turnRate * DT);
/**
 * Per-tick inputs passed through module scratch rather than call arguments: V8 boxes doubles passed to (or returned
 * from) functions it does not inline, which would allocate every tick.
 *  TURN: facing direction wanted by turnToward; AIMPT: point faceInto looks at;
 *  SEL: bestReceiver inputs (stick cone on/off and unit direction, long throw, power 0..1, max distance m);
 *  AIM_IN: chooseTarget inputs (stick -1..1, long, power, AssistLevel, commit = 1 to consult SIM-08 selectReceiver).
 */
const TURN = { x: 0, z: 0 };
const AIMPT = { x: 0, z: 0 };
const SEL = { hasDir: 0, ux: 0, uz: 0, long: 0, power: 0, maxD: 0 };
const AIM_IN = { mx: 0, mz: 0, long: 0, power: 0, assist: 0, commit: 0 };

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, d: number): number {
  return v - v === 0 ? v : d;
}

function isDownAct(a: ActionKind): boolean {
  return a === ActionKind.STUMBLE || a === ActionKind.FALLEN || a === ActionKind.GET_UP;
}

/** A throw-in is pending: THROW_IN phase with its restart not yet taken. */
function pending(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.THROW_IN && m.restart.kind === RestartKind.THROW_IN && m.restart.taken === 0;
}

/** `slot` is the active taker of the pending throw-in. */
function isLive(s: SimState, slot: number): boolean {
  return pending(s) && s.match.restart.taker === slot && s.players[slot]!.active === 1;
}

/** Touchline side of the current throw-in (-1 / +1). */
function lineSide(s: SimState): number {
  return s.match.restart.z < 0 ? -1 : 1;
}

/** Height of the ball centre held above the thrower's head, m. */
export function throwHandsHeight(s: SimState, slot: number): number {
  const h = s.attrs[slot]!.height;
  const y = (h - h === 0 && h > 0 ? h / 100 : 1.8) + LOCAL_TUNING.ballAboveHead;
  return clamp(y, LOCAL_TUNING.handsMin, LOCAL_TUNING.handsMax);
}

/** A goal straight from a throw-in (the thrower's throw is the last touch) must not count. */
export function noGoalDirectFromThrow(s: SimState): boolean {
  const b = s.ball;
  return b.lastKickKind === KickKind.THROW_IN && b.lastKickBy >= 0 && b.lastKickBy === b.lastTouch &&
    b.lastKickTick === b.lastTouchTick;
}

function beginState(p: PlayerState, state: number, dur: number, contact: number): void {
  beginAction(p, ActionKind.THROW_IN, dur, contact);
  p.actA = state;
  p.actKick = KickKind.THROW_IN;
}

function extendWait(p: PlayerState): void {
  if (p.actT + 1 >= p.actDur) p.actDur = p.actT + LOCAL_TUNING.waitBudgetTicks;
}

function lockStill(p: PlayerState): void {
  p.moveMode = MoveMode.LOCKED;
  p.vx = 0;
  p.vz = 0;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
}

/** Rotate p's facing toward the direction TURN by at most turnRate * DT (exact when within reach). */
function turnToward(p: PlayerState): void {
  const tx = TURN.x, tz = TURN.z;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (!(tl > 1e-9)) return;
  const ux = tx / tl, uz = tz / tl;
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-9)) { p.fx = ux; p.fz = uz; return; }
  fx /= fl;
  fz /= fl;
  if (fx * ux + fz * uz >= COS_TURN) { p.fx = ux; p.fz = uz; return; }
  const sn = fx * uz - fz * ux >= 0 ? SIN_TURN : -SIN_TURN;
  const rx = fx * COS_TURN - fz * sn, rz = fx * sn + fz * COS_TURN;
  const rl = Math.sqrt(rx * rx + rz * rz);
  p.fx = rx / rl;
  p.fz = rz / rl;
}

/** Turn p toward AIMPT, keeping his facing into the pitch from touchline `side` (at least minInward). */
function faceInto(p: PlayerState, side: number): void {
  let ux = AIMPT.x - p.x;
  let uz = AIMPT.z - p.z;
  const l = Math.sqrt(ux * ux + uz * uz);
  if (l > 1e-6) { ux /= l; uz /= l; } else { ux = 0; uz = -side; }
  const mi = LOCAL_TUNING.minInward;
  if (-side * uz < mi) {
    const sx = ux < 0 ? -1 : 1;
    uz = -side * mi;
    ux = sx * Math.sqrt(1 - mi * mi);
  }
  TURN.x = ux;
  TURN.z = uz;
  turnToward(p);
  p.lookAt = 1;
  p.lookX = p.x + ux * 10;
  p.lookZ = p.z + uz * 10;
}

/**
 * Ball in the hands of `slot`, `back` m behind his centre along his facing, above his head, at rest - but never
 * beyond the out-of-play planes: the ball is held over the line, so a kick from where it is held (this module's
 * release, or RUL-11's forced safety-net kick) starts in play and the watchdog never sees a live ball out of play.
 */
function holdBall(s: SimState, slot: number): void {
  const T = LOCAL_TUNING;
  const p = s.players[slot]!;
  const b = s.ball;
  // Behind the head while waiting, further back through the wind-up.
  let back: number = T.holdBack;
  if (p.act === ActionKind.THROW_IN && p.actA === ThrowState.WINDUP && p.actContact > 0) {
    const f = p.actT >= p.actContact ? 1 : p.actT / p.actContact;
    back = T.holdBack + (T.windupBack - T.holdBack) * f;
  }
  const zMax = BALL_OUT_Z - T.releaseInside;
  const x = clamp(p.x - p.fx * back, -HALF_LENGTH, HALF_LENGTH);
  const z = clamp(p.z - p.fz * back, -zMax, zMax);
  const h = s.attrs[slot]!.height;
  let y = (h - h === 0 && h > 0 ? h / 100 : 1.8) + T.ballAboveHead;
  if (y < T.handsMin) y = T.handsMin; else if (y > T.handsMax) y = T.handsMax;
  b.x = x; b.y = y; b.z = z;
  b.px = x; b.py = y; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 0;
  b.bounces = 0;
  b.inNet = 0;
  if (b.owner !== slot) { b.owner = slot; b.ownerT = 0; }
  b.heldBy = -1;
}

/** A ball the thrower never threw goes back on the line at the spot (loose, at rest). Not a contact. */
function dropBall(s: SimState): void {
  const b = s.ball;
  const r = s.match.restart;
  b.owner = -1;
  b.ownerT = 0;
  b.heldBy = -1;
  const x = r.kind === RestartKind.THROW_IN ? clamp(finiteOr(r.x, 0), -HALF_LENGTH, HALF_LENGTH) : clamp(finiteOr(b.x, 0), -HALF_LENGTH, HALF_LENGTH);
  const z = r.kind === RestartKind.THROW_IN ? (r.z < 0 ? -1 : 1) * HALF_WIDTH : clamp(finiteOr(b.z, 0), -HALF_WIDTH, HALF_WIDTH);
  b.x = x; b.y = BALL_RADIUS; b.z = z;
  b.px = x; b.py = BALL_RADIUS; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1;
  b.bounces = 0;
  b.inNet = 0;
}

/** Keep the thrower on his line: just outside the touchline, within lineLeash of the spot and the pitch length. */
function pinToLine(s: SimState, p: PlayerState): void {
  restartTakerSpot(s, SPOT);
  const leash = LOCAL_TUNING.lineLeash;
  const lo = SPOT.x - leash > -HALF_LENGTH ? SPOT.x - leash : -HALF_LENGTH;
  const hi = SPOT.x + leash < HALF_LENGTH ? SPOT.x + leash : HALF_LENGTH;
  if (!(p.x >= lo)) { p.x = lo; if (p.vx < 0) p.vx = 0; } else if (p.x > hi) { p.x = hi; if (p.vx > 0) p.vx = 0; }
  p.z = SPOT.z;
  p.vz = 0;
}

// ---------------------------------------------------------------- receivers and targets

/** `q` may receive a throw from `taker`: an active outfield teammate on the pitch. */
function candidateOk(s: SimState, taker: number, q: number): boolean {
  if (q < 0 || q >= NUM_SLOTS || q === taker) return false;
  const o = s.players[q]!;
  if (o.active !== 1 || o.team !== s.players[taker]!.team || o.isKeeper === 1) return false;
  return o.x >= -HALF_LENGTH && o.x <= HALF_LENGTH && o.z >= -HALF_WIDTH && o.z <= HALF_WIDTH;
}

/**
 * Best receiver for a throw by `taker` (inputs in SEL): open (nearest opponent, capped at openCap), at a good
 * distance (idealDist, or the long-throw distance of SEL.power), progressing toward the attacked goal, with a clear
 * lane (short throws), and inside the stick cone when SEL.hasDir = 1. Only teammates between minThrowDist and
 * SEL.maxD from the ball. -1 if none. Pure; O(11 x 11).
 */
function bestReceiver(s: SimState, taker: number): number {
  const T = LOCAL_TUNING;
  const p = s.players[taker]!;
  const b = s.ball;
  const bx = b.x, bz = b.z;
  const dir = s.teams[p.team]!.dir;
  const long = SEL.long;
  const pw = SEL.power < 0 ? 0 : SEL.power > 1 ? 1 : SEL.power;
  const ideal = long === 1 ? T.longMinDist + (T.longMaxDist - T.longMinDist) * pw : T.idealDist;
  const maxD = SEL.maxD;
  const first = teamFirstSlot(p.team);
  const ofirst = teamFirstSlot(p.team === 0 ? 1 : 0);
  let best = -1;
  let bestS = -1e18;
  for (let q = first; q < first + PLAYERS_PER_TEAM; q++) {
    if (!candidateOk(s, taker, q)) continue;
    const o = s.players[q]!;
    const dx = o.x - bx, dz = o.z - bz;
    const l2 = dx * dx + dz * dz;
    const d = Math.sqrt(l2);
    if (d < T.minThrowDist || d > maxD) continue;
    let sc = 0;
    if (SEL.hasDir === 1) {
      const c = (dx * SEL.ux + dz * SEL.uz) / d;
      if (c < COS_CONE) continue;
      sc += T.wDir * c;
    }
    // Openness (nearest opponent to him) and lane clearance (nearest opponent to the segment ball -> him).
    let open2 = T.openCap * T.openCap;
    let lane2 = T.laneCap * T.laneCap;
    for (let i = ofirst; i < ofirst + PLAYERS_PER_TEAM; i++) {
      const e = s.players[i]!;
      if (e.active !== 1) continue;
      const ex = e.x - o.x, ez = e.z - o.z;
      const od = ex * ex + ez * ez;
      if (od < open2) open2 = od;
      if (long === 0) {
        let t = ((e.x - bx) * dx + (e.z - bz) * dz) / l2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const lx = e.x - (bx + dx * t), lz = e.z - (bz + dz * t);
        const ld = lx * lx + lz * lz;
        if (ld < lane2) lane2 = ld;
      }
    }
    const dd = d - ideal;
    let prog = (dir * dx) / T.progressScale;
    if (prog < -1) prog = -1; else if (prog > 1) prog = 1;
    sc += T.wOpen * (Math.sqrt(open2) / T.openCap);
    sc -= T.wDist * (dd < 0 ? -dd : dd) / ideal;
    sc += T.wProg * prog;
    if (long === 0) sc += T.wLane * (Math.sqrt(lane2) / T.laneCap);
    if (sc > bestS) { bestS = sc; best = q; }
  }
  return best;
}

/** Nearest outfield teammate on the pitch at any distance (last-resort default target), -1 if none. */
function nearestMate(s: SimState, taker: number): number {
  const first = teamFirstSlot(s.players[taker]!.team);
  const b = s.ball;
  let best = -1;
  let bestD = 1e18;
  for (let q = first; q < first + PLAYERS_PER_TEAM; q++) {
    if (!candidateOk(s, taker, q)) continue;
    const o = s.players[q]!;
    const dx = o.x - b.x, dz = o.z - b.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

/** PICK = a point straight into the pitch: shortFreeDist m from the ball, or the long distance of SEL.power. */
function pickStraightIn(s: SimState, long: number): void {
  const T = LOCAL_TUNING;
  const pw = SEL.power < 0 ? 0 : SEL.power > 1 ? 1 : SEL.power;
  const dist = long === 1 ? T.longMinDist + (T.longMaxDist - T.longMinDist) * pw : T.shortFreeDist;
  PICK.recv = -1;
  PICK.track = 0;
  PICK.x = s.ball.x;
  PICK.z = s.ball.z - lineSide(s) * dist;
}

/** Keep PICK inside the pitch (targetMargin) and at least minThrowDist from the ball, toward the pitch. */
function clampTarget(s: SimState): void {
  const T = LOCAL_TUNING;
  const b = s.ball;
  const side = lineSide(s);
  if (!(PICK.x - PICK.x === 0) || !(PICK.z - PICK.z === 0)) pickStraightIn(s, 0);
  const mx = HALF_LENGTH - T.targetMargin;
  const mz = HALF_WIDTH - T.targetMargin;
  PICK.x = clamp(PICK.x, -mx, mx);
  PICK.z = clamp(PICK.z, -mz, mz);
  const dx = PICK.x - b.x, dz = PICK.z - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= T.minThrowDist) return;
  let ux = 0;
  let uz = -side;
  if (d > 1e-6) { ux = dx / d; uz = dz / d; }
  if (-side * uz < T.minInward) {
    const sx = ux < 0 ? -1 : 1;
    uz = -side * T.minInward;
    ux = sx * Math.sqrt(1 - T.minInward * T.minInward);
  }
  PICK.x = clamp(b.x + ux * T.minThrowDist, -mx, mx);
  PICK.z = clamp(b.z + uz * T.minThrowDist, -mz, mz);
}

/**
 * Target for a throw by `taker` from AIM_IN (stick -1..1 pitch space, long, power, assistance): with the stick pushed,
 * SIM-08 selectReceiver in its direction (validated; consulted only when committing the throw, AIM_IN.commit = 1),
 * else the best receiver in the stick cone (short range first, then up to longMaxDist), else a point along the stick;
 * MANUAL aims along the stick at the receiver's distance. Neutral stick: the best open receiver (short range first),
 * else straight in. Fills PICK (clamped).
 */
function chooseTarget(s: SimState, taker: number): void {
  const T = LOCAL_TUNING;
  const b = s.ball;
  const long = AIM_IN.long;
  const mx = AIM_IN.mx, mz = AIM_IN.mz;
  const sl = Math.sqrt(mx * mx + mz * mz);
  PICK.recv = -1;
  PICK.track = 0;
  SEL.long = long;
  SEL.power = AIM_IN.power;
  SEL.maxD = long === 1 ? T.longMaxDist : T.shortMaxDist;
  if (sl > T.stickDead) {
    const ux = mx / sl, uz = mz / sl;
    SEL.hasDir = 1;
    SEL.ux = ux;
    SEL.uz = uz;
    let q = -1;
    if (AIM_IN.commit === 1) {
      q = selectReceiver(s, taker, ux, uz, long === 1 ? AIM_IN.power : T.shortSelectPower, AIM_IN.assist, long);
      if (!candidateOk(s, taker, q)) q = -1;
      else {
        const o = s.players[q]!;
        const dx = o.x - b.x, dz = o.z - b.z;
        const d2 = dx * dx + dz * dz;
        // [QF-1] A short throw (PASS) only goes to a receiver in short range (SEL.maxD = shortMaxDist): SIM-08 may
        // prefer a more open teammate 25 m away, which is a long throw (the stick at a team-mate 11 m away threw 25 m).
        if (d2 < T.minThrowDist * T.minThrowDist || d2 > SEL.maxD * SEL.maxD) q = -1;
      }
    }
    if (q < 0) q = bestReceiver(s, taker);
    if (q < 0 && long === 0) { SEL.maxD = T.longMaxDist; q = bestReceiver(s, taker); } // nobody near: farther
    if (q >= 0 && AIM_IN.assist !== AssistLevel.MANUAL) {
      PICK.recv = q;
      PICK.x = s.players[q]!.x;
      PICK.z = s.players[q]!.z;
      PICK.track = 1;
    } else {
      let dist: number;
      if (q >= 0) {
        const o = s.players[q]!;
        const dx = o.x - b.x, dz = o.z - b.z;
        dist = Math.sqrt(dx * dx + dz * dz);
      } else {
        const pw = AIM_IN.power < 0 ? 0 : AIM_IN.power > 1 ? 1 : AIM_IN.power;
        dist = long === 1 ? T.longMinDist + (T.longMaxDist - T.longMinDist) * pw : T.shortFreeDist;
      }
      PICK.recv = q;
      PICK.x = b.x + ux * dist;
      PICK.z = b.z + uz * dist;
    }
  } else {
    SEL.hasDir = 0;
    SEL.ux = 0;
    SEL.uz = 0;
    let q = bestReceiver(s, taker);
    if (q < 0 && long === 0) { SEL.maxD = T.longMaxDist; q = bestReceiver(s, taker); } // nobody near: farther
    if (q >= 0) {
      PICK.recv = q;
      PICK.x = s.players[q]!.x;
      PICK.z = s.players[q]!.z;
      PICK.track = 1;
    } else {
      pickStraightIn(s, long);
    }
  }
  clampTarget(s);
}

/** Default target: the best open receiver in short range, else in long range, else the nearest one, else straight
 *  in. Fills PICK (clamped); returns 1 for a long throw (beyond shortMaxDist). */
function defaultTarget(s: SimState, taker: number): number {
  const T = LOCAL_TUNING;
  SEL.hasDir = 0;
  SEL.ux = 0;
  SEL.uz = 0;
  SEL.long = 0;
  SEL.power = 0;
  SEL.maxD = T.shortMaxDist;
  let q = bestReceiver(s, taker);
  if (q < 0) {
    SEL.long = 1;
    SEL.power = T.defaultLongPower;
    SEL.maxD = T.longMaxDist;
    q = bestReceiver(s, taker);
  }
  if (q < 0) q = nearestMate(s, taker);
  if (q >= 0) {
    PICK.recv = q;
    PICK.x = s.players[q]!.x;
    PICK.z = s.players[q]!.z;
    PICK.track = 1;
  } else {
    pickStraightIn(s, 0);
  }
  clampTarget(s);
  const dx = PICK.x - s.ball.x, dz = PICK.z - s.ball.z;
  return dx * dx + dz * dz > T.shortMaxDist * T.shortMaxDist ? 1 : 0;
}

/** Distance from the ball to PICK, m (commit path only). */
function ballDistToPick(s: SimState): number {
  const dx = PICK.x - s.ball.x, dz = PICK.z - s.ball.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Long-throw power that matches a distance, 0..1. */
function longPowerFor(d: number): number {
  const T = LOCAL_TUNING;
  return clamp((d - T.longMinDist) / (T.longMaxDist - T.longMinDist), 0, 1);
}

/** Show PICK as the current aim (taker faces it; HUD reads restart.aimX/aimZ/aimPower). */
function setPreview(s: SimState, taker: number): void {
  const p = s.players[taker]!;
  const r = s.match.restart;
  p.actSlot = PICK.recv;
  p.actX = PICK.x;
  p.actZ = PICK.z;
  p.actB = (p.actA === ThrowState.CHARGE ? ThrowFlag.LONG : 0) | (PICK.track === 1 ? ThrowFlag.TRACK : 0);
  r.aimX = PICK.x;
  r.aimZ = PICK.z;
  r.aimPower = p.actA === ThrowState.CHARGE ? p.actPower : 0;
}

/** Commit the throw at PICK: wind-up now, release at windupTicks. */
function commitThrow(s: SimState, taker: number, long: number, power: number): void {
  const T = LOCAL_TUNING;
  const p = s.players[taker]!;
  const r = s.match.restart;
  clampTarget(s);
  beginState(p, ThrowState.WINDUP, T.windupTicks + 1 + T.recoveryTicks, T.windupTicks);
  p.actB = (long === 1 ? ThrowFlag.LONG : 0) | (PICK.track === 1 && PICK.recv >= 0 ? ThrowFlag.TRACK : 0);
  p.actPower = long === 1 ? clamp(finiteOr(power, 0), 0, 1) : 0;
  p.actSlot = PICK.recv;
  p.actX = PICK.x;
  p.actZ = PICK.z;
  const dx = PICK.x - p.x, dz = PICK.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  p.actDirX = d > 1e-6 ? dx / d : 0;
  p.actDirZ = d > 1e-6 ? dz / d : -lineSide(s);
  lockStill(p);
  r.aimX = PICK.x;
  r.aimZ = PICK.z;
  r.aimPower = p.actPower;
}

/** Commit the throw at the current preview (p.actSlot / actX / actZ). */
function commitPreview(s: SimState, taker: number, long: number, power: number): void {
  const p = s.players[taker]!;
  PICK.recv = candidateOk(s, taker, p.actSlot) ? p.actSlot : -1;
  PICK.track = PICK.recv >= 0 && (p.actB & ThrowFlag.TRACK) !== 0 ? 1 : 0;
  PICK.x = p.actX;
  PICK.z = p.actZ;
  commitThrow(s, taker, long, power);
}

/** Default throw (timeout / CPU): short throw to the best open teammate (long when he is far). */
function takeDefaultThrow(s: SimState, taker: number): void {
  const long = defaultTarget(s, taker);
  commitThrow(s, taker, long, long === 1 ? longPowerFor(ballDistToPick(s)) : 0);
}

// ---------------------------------------------------------------- throw solver

/** Fly the scratch ball from height y0 at speed v and elevation th until its first landing; LAND = [range, t, landed]. */
function flyRange(v: number, th: number, y0: number): void {
  const R = BALL_RADIUS;
  FLY.x = 0; FLY.y = y0; FLY.z = 0;
  FLY.vx = v * dcos(th); FLY.vy = v * dsin(th); FLY.vz = 0;
  FLY.sx = 0; FLY.sy = 0; FLY.sz = 0;
  let t = 0;
  const n = LOCAL_TUNING.flightMaxTicks;
  for (let i = 0; i < n; i++) {
    const px = FLY.x;
    const py = FLY.y;
    ballAirStep(FLY, DT);
    t += DT;
    if (FLY.y <= R && FLY.vy < 0) {
      const dy = py - FLY.y;
      let f = dy > 0 ? (py - R) / dy : 1;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      LAND[0] = px + (FLY.x - px) * f;
      LAND[1] = t - DT * (1 - f);
      LAND[2] = 1;
      return;
    }
  }
  LAND[0] = FLY.x;
  LAND[1] = t;
  LAND[2] = 0;
}

/** Elevation in [lo, hi] (range increasing) at speed v whose first landing is d m away. */
function bisectAngle(v: number, lo: number, hi: number, d: number, y0: number): number {
  for (let i = 0; i < LOCAL_TUNING.solveIters; i++) {
    const mid = 0.5 * (lo + hi);
    flyRange(v, mid, y0);
    if (LAND[0]! < d) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Speed in [lo, hi] at elevation th whose first landing is d m away. */
function bisectSpeed(lo: number, hi: number, th: number, d: number, y0: number): number {
  for (let i = 0; i < LOCAL_TUNING.solveIters; i++) {
    const mid = 0.5 * (lo + hi);
    flyRange(mid, th, y0);
    if (LAND[0]! < d) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Launch for a throw whose first landing is d m away (horizontal) from a release at height y0, with SIM-01 ball
 * physics (gravity + drag, no spin). Short (long = 0) throws start from shortAngle, long ones from longAngle; the speed
 * is solved within [speedMin, speedMax]; below the range the throw is flattened, above it raised up to maxRangeAngle
 * (beyond reach: the longest throw, reached = 0). Deterministic, bounded iterations, allocation-free.
 */
export function solveThrow(d: number, y0: number, long: number, out: ThrowSolution): void {
  const T = LOCAL_TUNING;
  const dist = d - d === 0 && d > 0 ? d : 0;
  const h = y0 - y0 === 0 && y0 > BALL_RADIUS ? y0 : BALL_RADIUS + 1e-3;
  const th0: number = long === 1 ? T.longAngle : T.shortAngle;
  let v: number = T.speedMin;
  let th: number = th0;
  let reach = 1;
  flyRange(T.speedMin, th0, h);
  if (LAND[0]! >= dist) {
    flyRange(T.speedMin, T.minAngle, h);
    if (LAND[0]! >= dist) th = T.minAngle;
    else th = bisectAngle(T.speedMin, T.minAngle, th0, dist, h);
  } else {
    flyRange(T.speedMax, th0, h);
    if (LAND[0]! >= dist) {
      v = bisectSpeed(T.speedMin, T.speedMax, th0, dist, h);
    } else {
      v = T.speedMax;
      flyRange(T.speedMax, T.maxRangeAngle, h);
      if (LAND[0]! >= dist) th = bisectAngle(T.speedMax, th0, T.maxRangeAngle, dist, h);
      else { th = T.maxRangeAngle; reach = 0; }
    }
  }
  flyRange(v, th, h);
  out.speed = v;
  out.angle = th;
  out.range = LAND[0]!;
  out.flightT = LAND[1]!;
  const err = out.range - dist;
  out.reached = reach === 1 && err < 0.05 && err > -0.05 ? 1 : 0;
}

// ---------------------------------------------------------------- the throw

/** Release the committed throw of `slot` now (WINDUP contact): applyKick(THROW_IN) from his hands. */
function releaseThrow(s: SimState, slot: number, ev: EventSink): void {
  const T = LOCAL_TUNING;
  const p = s.players[slot]!;
  const b = s.ball;
  const side = lineSide(s);
  const long = (p.actB & ThrowFlag.LONG) !== 0 ? 1 : 0;
  const recv = candidateOk(s, slot, p.actSlot) ? p.actSlot : -1;
  const track = recv >= 0 && (p.actB & ThrowFlag.TRACK) !== 0;
  PICK.recv = recv;
  PICK.track = track ? 1 : 0;
  PICK.x = track ? s.players[recv]!.x : p.actX;
  PICK.z = track ? s.players[recv]!.z : p.actZ;
  clampTarget(s);
  // Release point: the hands, a little ahead along the throw, and never beyond the out-of-play planes: the ball is
  // in play from the release (phase IN_PLAY at the end of this tick), so it must already be over the line, or the
  // watchdog would see a ball out of play that nobody gave.
  let ux = PICK.x - p.x;
  let uz = PICK.z - p.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul > 1e-6) { ux /= ul; uz /= ul; } else { ux = 0; uz = -side; }
  const zMax = BALL_OUT_Z - T.releaseInside;
  const rx = clamp(p.x + ux * T.releaseAhead, -HALF_LENGTH, HALF_LENGTH);
  const ry = throwHandsHeight(s, slot);
  const rz = clamp(p.z + uz * T.releaseAhead, -zMax, zMax);
  let dx = PICK.x - rx;
  let dz = PICK.z - rz;
  let d = Math.sqrt(dx * dx + dz * dz);
  solveThrow(d, ry, long, SOL);
  if (track) {
    const q = s.players[recv]!;
    const qv = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
    if (qv > 1e-6) {
      let lead = T.leadFactor * SOL.flightT * qv;
      if (lead > T.leadMax) lead = T.leadMax;
      PICK.x = q.x + (q.vx / qv) * lead;
      PICK.z = q.z + (q.vz / qv) * lead;
      clampTarget(s);
      dx = PICK.x - rx;
      dz = PICK.z - rz;
      d = Math.sqrt(dx * dx + dz * dz);
      solveThrow(d, ry, long, SOL);
    }
  }
  let hx = 0;
  let hz = -side;
  if (d > 1e-6) { hx = dx / d; hz = dz / d; }
  if (b.heldBy >= 0 || (b.owner >= 0 && b.owner !== slot)) releasePossession(s, ev);
  b.x = rx; b.y = ry; b.z = rz;
  b.px = rx; b.py = ry; b.pz = rz;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.inNet = 0;
  b.owner = slot;
  b.heldBy = -1;
  const ch = dcos(SOL.angle);
  const sh = dsin(SOL.angle);
  const L = LAUNCH;
  L.vx = hx * SOL.speed * ch;
  L.vy = SOL.speed * sh;
  L.vz = hz * SOL.speed * ch;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = KickKind.THROW_IN;
  L.target = recv;
  L.tx = PICK.x;
  L.tz = PICK.z;
  L.onTarget = 0;
  p.fx = hx;
  p.fz = hz;
  p.actDirX = hx;
  p.actDirZ = hz;
  const power = long === 1 ? p.actPower : (SOL.speed - T.speedMin) / (T.speedMax - T.speedMin);
  applyKick(s, slot, L, clamp(power, 0, 1), ev);
  p.actDone = 1;
  beginRecover(s, slot);
}

// ---------------------------------------------------------------- sub-state steps (handler)

/** Walk onto the pitch (RECOVER). Ends at once for a player already on it. */
function beginRecover(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  if (b.owner === slot && b.heldBy < 0 && p.act === ActionKind.THROW_IN && p.actA !== ThrowState.APPROACH) dropBall(s);
  beginState(p, ThrowState.RECOVER, LOCAL_TUNING.recoveryTicks, -1);
  p.actDone = 1;
  p.actCharging = 0;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  const az = p.z < 0 ? -p.z : p.z;
  if (az <= HALF_WIDTH - LOCAL_TUNING.returnInset) p.actDur = p.actT; // on the pitch already: free now
}

function recoverStep(s: SimState, p: PlayerState): void {
  const T = LOCAL_TUNING;
  const sz = p.z < 0 ? -1 : 1;
  const tz = sz * (HALF_WIDTH - T.returnInset);
  const ez = sz * (p.z - tz); // > 0 while beyond the target, i.e. off or on the edge of the pitch
  p.moveMode = MoveMode.LOCKED;
  p.vx = 0;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  if (ez > 1e-3) {
    const lim = ez / DT;
    p.vz = -sz * (T.returnSpeed < lim ? T.returnSpeed : lim);
    TURN.x = 0;
    TURN.z = -sz;
    turnToward(p);
  } else {
    p.vz = 0;
  }
  // Still off the pitch when the recovery runs out: keep walking in (bounded).
  if (sz * p.z > HALF_WIDTH && p.actT + 1 >= p.actDur && p.actT < T.recoveryTicks + T.recoveryExtraMax) p.actDur = p.actT + 2;
}

function approachStep(s: SimState, p: PlayerState): void {
  const T = LOCAL_TUNING;
  restartTakerSpot(s, SPOT);
  const dx = SPOT.x - p.x, dz = SPOT.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  if (d > 1e-3) {
    let sp: number = T.approachSpeed;
    const g = T.approachGain * d;
    if (g < sp) sp = g;
    const lim = d / DT;
    if (lim < sp) sp = lim;
    p.vx = (dx / d) * sp;
    p.vz = (dz / d) * sp;
    TURN.x = dx;
    TURN.z = dz;
    turnToward(p);
  } else {
    p.vx = 0;
    p.vz = 0;
  }
  extendWait(p);
}

function holdStep(s: SimState, p: PlayerState): void {
  const T = LOCAL_TUNING;
  const r = s.match.restart;
  restartTakerSpot(s, SPOT);
  const ix = p.ix;
  let vx = (ix - ix === 0 ? ix : 0) * T.shuffleSpeed;
  const lo = SPOT.x - T.lineLeash > -HALF_LENGTH ? SPOT.x - T.lineLeash : -HALF_LENGTH;
  const hi = SPOT.x + T.lineLeash < HALF_LENGTH ? SPOT.x + T.lineLeash : HALF_LENGTH;
  if (p.x + vx * DT > hi) vx = (hi - p.x) / DT;
  else if (p.x + vx * DT < lo) vx = (lo - p.x) / DT;
  p.moveMode = MoveMode.LOCKED;
  p.vx = vx;
  p.vz = 0;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  AIMPT.x = r.aimX;
  AIMPT.z = r.aimZ;
  faceInto(p, lineSide(s));
  extendWait(p);
}

function chargeStep(s: SimState, slot: number, p: PlayerState): void {
  const T = LOCAL_TUNING;
  const r = s.match.restart;
  lockStill(p);
  AIMPT.x = r.aimX;
  AIMPT.z = r.aimZ;
  faceInto(p, lineSide(s));
  if (p.actCharging !== 1) { commitPreview(s, slot, 1, p.actPower); return; } // the charge ended elsewhere
  const c = p.ctrl >= 0 && p.ctrl < s.ctrl.length ? s.ctrl[p.ctrl]! : null;
  const fill = c !== null && c.fastPower === 1 ? T_PASS.powerFillTicksFast : T_PASS.powerFillTicks;
  if (p.actT >= fill + T.chargeAutoReleaseTicks) { p.actPower = 1; commitPreview(s, slot, 1, 1); return; }
  extendWait(p);
}

function windupStep(s: SimState, slot: number, p: PlayerState, ev: EventSink): void {
  lockStill(p);
  AIMPT.x = p.actX;
  AIMPT.z = p.actZ;
  faceInto(p, lineSide(s));
  if (p.actDone === 0 && p.actT >= p.actContact) releaseThrow(s, slot, ev);
}

function handlerUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const st = p.actA;
  if (st === ThrowState.RECOVER) { recoverStep(s, p); return; }
  if (!isLive(s, slot)) {
    // The restart was taken by someone else / forced, the phase ended, or he is no longer the taker.
    beginRecover(s, slot);
    if (p.actDur > p.actT) recoverStep(s, p);
    return;
  }
  switch (st) {
    case ThrowState.APPROACH: approachStep(s, p); return;
    case ThrowState.HOLD: holdStep(s, p); return;
    case ThrowState.CHARGE: chargeStep(s, slot, p); return;
    case ThrowState.WINDUP: windupStep(s, slot, p, ev); return;
    default: beginRecover(s, slot); return;
  }
}

function handlerEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  // Interrupted while holding the ball (never thrown): it goes back on the line.
  if (b.owner === slot && b.heldBy < 0 && p.actDone === 0 &&
    (p.actA === ThrowState.HOLD || p.actA === ThrowState.CHARGE || p.actA === ThrowState.WINDUP)) dropBall(s);
  p.lookAt = 0;
  p.ix = 0;
  p.iz = 0;
  p.actCharging = 0;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

// ---------------------------------------------------------------- taker

/** Start the THROW_IN action (APPROACH) for `slot`. */
function beginApproach(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
  beginState(p, ThrowState.APPROACH, LOCAL_TUNING.waitBudgetTicks, -1);
  p.actB = 0;
  p.actPower = 0;
  p.actSlot = -1;
  p.actX = p.x;
  p.actZ = p.z;
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
}

/** Put the taker on his spot facing the pitch with the ball in his hands (HOLD). */
function takeBall(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const side = lineSide(s);
  restartTakerSpot(s, SPOT);
  p.x = SPOT.x;
  p.z = SPOT.z;
  p.vx = 0;
  p.vz = 0;
  p.fx = 0;
  p.fz = -side;
  beginState(p, ThrowState.HOLD, LOCAL_TUNING.waitBudgetTicks, -1);
  p.actB = 0;
  p.actPower = 0;
  p.actSlot = -1;
  p.actX = SPOT.x;
  p.actZ = SPOT.z - side * LOCAL_TUNING.shortFreeDist;
  lockStill(p);
  if (b.heldBy >= 0 || (b.owner >= 0 && b.owner !== slot)) releasePossession(s, ev);
  holdBall(s, slot);
}

/** Valid taker in his THROW_IN action with the ball in his hands (put there now if needed); -1 if nobody can. */
function ensureHolding(s: SimState, ev: EventSink): number {
  const r = s.match.restart;
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
  const t = r.taker;
  if (t < 0) return -1;
  const p = s.players[t]!;
  if (p.act !== ActionKind.THROW_IN || p.actA === ThrowState.RECOVER) {
    if (isDownAct(p.act) || p.stunT > 0) return -1;
    beginApproach(s, t);
  }
  if (p.actA === ThrowState.APPROACH) {
    takeBall(s, t, ev);
  } else if (p.actA === ThrowState.HOLD || p.actA === ThrowState.CHARGE) {
    const b = s.ball;
    if (b.heldBy >= 0 || (b.owner >= 0 && b.owner !== t)) releasePossession(s, ev);
    if (b.owner !== t) holdBall(s, t);
  }
  return t;
}

/** THROW_IN actions on anyone but `keep`: inactive players' end; the others step back onto the pitch. */
function clearStrayThrowers(s: SimState, keep: number): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const q = s.players[i]!;
    if (q.act !== ActionKind.THROW_IN) continue;
    if (q.active !== 1) { endAction(s, i, 1); continue; }
    if (i !== keep && q.actA !== ThrowState.RECOVER) beginRecover(s, i);
  }
}

// ---------------------------------------------------------------- restart API

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function throwInSetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.THROW_IN) return;
  r.side = r.z < 0 ? -1 : 1;
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
  clearStrayThrowers(s, r.taker);
  // Until he has a target the taker looks straight into the pitch.
  r.aimX = r.x;
  r.aimZ = r.z - r.side * LOCAL_TUNING.shortFreeDist;
  const t = r.taker;
  if (t < 0) return;
  const p = s.players[t]!;
  if (isDownAct(p.act) || p.stunT > 0) return; // starts once he is up (RUL-11 re-picks at ready if he is still down)
  if (p.act !== ActionKind.THROW_IN) beginApproach(s, t);
}

/** Per tick while the phase is active. */
export function throwInTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const r = m.restart;
  if (m.phase !== MatchPhase.THROW_IN || r.kind !== RestartKind.THROW_IN) return;
  if (r.taken === 1) { clearStrayThrowers(s, -1); return; }
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
  clearStrayThrowers(s, r.taker);
  const t = r.taker;
  if (t < 0) return;
  const p = s.players[t]!;
  if (p.act !== ActionKind.THROW_IN || p.actA === ThrowState.RECOVER) {
    if (isDownAct(p.act) || p.stunT > 0) return;
    beginApproach(s, t);
  }
  const T = LOCAL_TUNING;
  if (p.actA === ThrowState.APPROACH) {
    restartTakerSpot(s, SPOT);
    const dx = p.x - SPOT.x, dz = p.z - SPOT.z;
    if (r.ready !== 1 && dx * dx + dz * dz > T.pickupRadius * T.pickupRadius) return; // the ball waits on the line
    takeBall(s, t, ev);
    if (r.ready === 1) legalizePositions(s); // restart camera cut: opponents 2 m from the ball in his hands
  } else {
    pinToLine(s, p);
    const b = s.ball;
    if (b.heldBy >= 0 || (b.owner >= 0 && b.owner !== t)) releasePossession(s, ev);
    holdBall(s, t);
  }
  if (p.actA !== ThrowState.HOLD) return;
  // An AI-driven taker shows the default target.
  if (p.ctrl < 0) {
    defaultTarget(s, t);
    setPreview(s, t);
  }
  // A side without a human throws by itself (its CPU brain may have thrown earlier through its InputFrame).
  if (r.ready === 1 && !teamHasHuman(s, r.team) && p.actT >= T_RULES.cpuRestartDelay + T.cpuGraceTicks) {
    takeDefaultThrow(s, t);
  }
}

/** Throw at a pitch tap: the tapped teammate, or the nearest one to the point, or the point. 1 = thrown. */
function gestureThrow(s: SimState, taker: number, f: InputFrame): number {
  const T = LOCAL_TUNING;
  const b = s.ball;
  if (f.gSlot === taker) return 0;
  const gx = f.gx / GESTURE_POS_SCALE;
  const gz = f.gz / GESTURE_POS_SCALE;
  let q = candidateOk(s, taker, f.gSlot) ? f.gSlot : -1;
  if (q < 0 && gx - gx === 0 && gz - gz === 0) {
    const first = teamFirstSlot(s.players[taker]!.team);
    let bestD = T.tapRadius * T.tapRadius;
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      if (!candidateOk(s, taker, i)) continue;
      const o = s.players[i]!;
      const dx = o.x - gx, dz = o.z - gz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; q = i; }
    }
  }
  if (q >= 0) {
    PICK.recv = q;
    PICK.track = 1;
    PICK.x = s.players[q]!.x;
    PICK.z = s.players[q]!.z;
  } else {
    if (!(gx - gx === 0) || !(gz - gz === 0)) return 0;
    const dx = gx - b.x, dz = gz - b.z;
    if (dx * dx + dz * dz < T.tapMinDist * T.tapMinDist) return 0;
    PICK.recv = -1;
    PICK.track = 0;
    PICK.x = gx;
    PICK.z = gz;
  }
  clampTarget(s);
  const d = ballDistToPick(s);
  const long = f.gesture === GestureKind.DOUBLE_TAP || d > T.shortMaxDist ? 1 : 0;
  commitThrow(s, taker, long, long === 1 ? longPowerFor(d) : 0);
  return 1;
}

/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function throwInInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  const m = s.match;
  const r = m.restart;
  if (m.phase !== MatchPhase.THROW_IN || r.kind !== RestartKind.THROW_IN || r.taken === 1 || r.ready !== 1) return;
  if (ctrlIdx < 0 || ctrlIdx >= s.ctrl.length) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || c.side !== r.team) return;
  const t = r.taker;
  if (t < 0 || t >= NUM_SLOTS) return;
  const p = s.players[t]!;
  if (p.active !== 1 || p.act !== ActionKind.THROW_IN) return;
  if (p.ctrl >= 0 && p.ctrl !== ctrlIdx) return; // another controller drives the taker
  const st = p.actA;
  if ((st !== ThrowState.HOLD && st !== ThrowState.CHARGE) || s.ball.owner !== t) return;
  const T = LOCAL_TUNING;
  const pressed = c.buttons & ~c.prevButtons;
  const cmx = c.mx, cmz = c.mz;
  const mx = cmx - cmx === 0 ? cmx : 0;
  const mz = cmz - cmz === 0 ? cmz : 0;
  AIM_IN.mx = mx;
  AIM_IN.mz = mz;
  AIM_IN.assist = c.assist;
  AIM_IN.commit = 0;
  if (st === ThrowState.HOLD) {
    if ((f.gesture === GestureKind.TAP || f.gesture === GestureKind.DOUBLE_TAP) && gestureThrow(s, t, f) === 1) return;
    AIM_IN.long = 0;
    AIM_IN.power = 0;
    if ((pressed & Btn.PASS) !== 0) {
      AIM_IN.commit = 1;
      chooseTarget(s, t);
      commitThrow(s, t, 0, 0);
      return;
    }
    if ((pressed & Btn.LOB) === 0) {
      // Move along the line and aim.
      p.ix = mx > T.stickDead || mx < -T.stickDead ? mx : 0;
      p.iz = 0;
      chooseTarget(s, t);
      setPreview(s, t);
      return;
    }
    // LOB pressed: the power bar starts.
    beginState(p, ThrowState.CHARGE, T.waitBudgetTicks, -1);
    p.actCharging = 1;
    p.actPower = 0;
    lockStill(p);
  }
  // CHARGE: power from the hold; release (or auto-release after full) throws.
  const fill = c.fastPower === 1 ? T_PASS.powerFillTicksFast : T_PASS.powerFillTicks;
  if ((c.buttons & Btn.LOB) !== 0) {
    const h = c.holdT[BI_LOB]!;
    p.actPower = h >= fill ? 1 : h / fill;
    AIM_IN.long = 1;
    AIM_IN.power = p.actPower;
    if (h >= fill + T.chargeAutoReleaseTicks) {
      AIM_IN.commit = 1;
      chooseTarget(s, t);
      commitThrow(s, t, 1, p.actPower);
      return;
    }
    chooseTarget(s, t);
    setPreview(s, t);
    return;
  }
  AIM_IN.long = 1;
  AIM_IN.power = p.actPower;
  AIM_IN.commit = 1;
  chooseTarget(s, t);
  commitThrow(s, t, 1, p.actPower);
}

/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function throwInDefault(s: SimState, ev: EventSink): void {
  if (!pending(s)) return;
  const t = ensureHolding(s, ev);
  if (t < 0) return;
  const p = s.players[t]!;
  if (p.actA === ThrowState.CHARGE) { commitPreview(s, t, 1, p.actPower); return; }
  if (p.actA !== ThrowState.HOLD) return;
  takeDefaultThrow(s, t);
}

bindThrowInImpl({ update: handlerUpdate, end: handlerEnd });

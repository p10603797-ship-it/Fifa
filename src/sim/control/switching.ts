/**
 * [SIM-16] Player switching for every controller (humans and CPU brains): nearest effective defender by default
 * with a short lock-out (T_INPUT.switchLockTicks) so it never flip-flops; manual directional switch (right
 * stick flick) always available; auto-switch setting (Off, Air balls and loose balls, Auto); auto-switch to the
 * intended receiver of a pass and to the keeper when he gains the ball in hands; never lands on a sent-off,
 * substituted or inactive player; never switches away from the player about to receive. Writes ctrl.slot,
 * p.ctrl, ctrl.nextSwitch (faint marker) and emits SWITCH.
 *
 * Rules, in priority order (all deterministic, allocation-free, O(11 x samples) per controller per tick):
 *  1. Validity (ensureControlledPlayer, every tick): a live controller (HUMAN/CPU with side 0/1) always controls an
 *     active player of its side whose p.ctrl points back at it. Otherwise it re-picks (ownership target first, then
 *     the best effective outfield player, then anyone). Stale p.ctrl claims on other players are cleared. Two
 *     controllers of the same side never share a player (switchTo refuses a player another live controller holds).
 *  2. Ownership (forced, ignores the lock-out), IN_PLAY: keeper holding the ball in hands -> the keeper; our ball
 *     carrier -> the carrier; our pass in flight (ball.passTarget is our active player, our team touched last) ->
 *     the receiver at once (auto-switch AIR_AND_LOOSE / AUTO and every CPU) or on reception (OFF: the possession
 *     rule); never away from him while the ball travels. A keeper never stays human/CPU-controlled in open play
 *     without the ball (saves are keeper AI, D-009): control moves to the best outfield player once he has released
 *     it (OFF keeps him until his pass is received; a loose ball about to reach him keeps him too). Restart phases: the taking side controls restart.taker; the
 *     defending side of a PENALTY controls its keeper. SHOOT_OUT: kicking side -> shootout.kicker, other side ->
 *     shootout.keeper. With two controllers on a side the claimant is the one already on that player, else the one
 *     whose player struck the last kick, else the one whose player is nearest (lowest index on ties).
 *  3. Manual (defence context: IN_PLAY without our possession / our pass in flight, or the defending side of a
 *     non-penalty restart): RS_FLICK edge -> the outfield teammate most aligned with the flick direction from the
 *     current player (always available); MOD_L press edge (touch SWITCH tap) -> best effective defender excluding
 *     the current one, debounced for switchLockTicks after a previous manual switch. A manual switch also holds off
 *     auto-switching for switchLockTicks + LOCAL_TUNING.manualHoldTicks so auto never undoes the user's choice.
 *  4. Auto (IN_PLAY, lock-out expired, outfield candidates only, keeper never): AIR_AND_LOOSE when the ball is
 *     airborne or loose (within autoWindowTicks of the latest touch) and a teammate will clearly reach it first;
 *     AUTO additionally for an opponent's ground pass and when the current defender is beaten by the carrier.
 *     "Clearly" = the candidate's arrival beats the current player's by max(autoMarginTicks, autoMarginFrac *
 *     (current - ticks the ball spends out of reach before he meets it)) (hysteresis: the relative part grows with
 *     the time the ball is playable, not with a long flight's hang time); never away from a player about to reach
 *     the ball (aboutToReceiveTicks) or the loose ball is coming to [QF-9]; never while a shot is in flight;
 *     [QF-9] in AUTO, not while an opponent clearly gets there first and our current man is in the play
 *     (contestTicks, contestInPlayTicks: the carrier rule decides once he has it). A long ball is judged as soon as
 *     it is struck:
 *     the loose-ball look-ahead runs until the ball has been playable for looseHorizonTicks (up to airHorizonTicks
 *     of flight out of reach), so a 3-6 s high ball is decided in the window right after the strike.
 *  5. ctrl.nextSwitch = what a MOD_L press would pick now (-1 outside the defence context). Ties on arrival (common
 *     on a long ball: several teammates can be under it before it comes down) go to the one who gets to his meeting
 *     point soonest; the previous marker is kept while he is within markerTieTicks of that, so it never flickers.
 *
 * "Effective" arrival (eff, ticks): opponent carrier -> first sampled time t at which the player can stand on the
 * carrier's extrapolated path no later than the carrier (SIM-04 ticksToReach), minus goalSideBonusTicks when he is
 * goal-side; loose ball -> first sampled time he can reach the predicted ball below reachHeight (the air phase is
 * SIM-01 ballAirStep's integrator: drag, Magnus, spin decay; bounces and roll are a cheap SIM-02 copy); our
 * possession -> ticks to the ball. Busy players (stunned, in a tackle/fall/action) add their remaining action ticks.
 *
 * switchLockT encoding: switchTo sets switchLockTicks (auto blocked until it reaches 0); a manual switch sets
 * switchLockTicks + manualHoldTicks. A remaining value above manualHoldTicks therefore means "a manual switch less
 * than switchLockTicks ago" (MOD_L debounce). Needs manualHoldTicks >= switchLockTicks and
 * autoWindowTicks <= switchLockTicks + manualHoldTicks; the effective values are clamped to that at load.
 */
import {
  BALL_RADIUS, BOARD_X, BOARD_Z, CPU_CONTROLLER_BASE, DT, HALF_LENGTH, HALF_WIDTH, NUM_CONTROLLERS, NUM_SLOTS,
  PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AutoSwitch, ControllerKind, MatchPhase, RestartKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, type InputFrame } from '../../contracts/input';
import { MoveMode, type ControllerState, type PlayerState, type SimState } from '../../contracts/state';
import { T_BALL, T_DRIBBLE, T_INPUT, T_PLAYER, T_TOUCH } from '../../contracts/tuning';
import { DRAG_K, MAGNUS_K } from '../ball/flight';
import { CHEST_REACH_MUL } from '../players/firstTouchHooks';
import { ticksToReach } from '../players/locomotion';
import { Ctx, FACE_MASK, clearBuffer, controlContext } from './resolveShared';

// Imported double constants copied into module consts: hot loops then read plain locals (module-namespace getters
// in some loaders box doubles on every read).
const DT_S = DT;
const BALL_R = BALL_RADIUS;
const HALF_L = HALF_LENGTH;
const HALF_W = HALF_WIDTH;
const BOARD_XS = BOARD_X;
const BOARD_ZS = BOARD_Z;
/** SIM-01 air model (ballAirStep): drag and Magnus coefficients actually used by the sim, gravity, spin decay. */
const AIR_DRAG = DRAG_K;
const AIR_MAGNUS = MAGNUS_K;
const GRAVITY = T_BALL.gravity;
const SPIN_DECAY_AIR = T_BALL.spinDecayAir;

const LOCAL_TUNING = {
  /** Extra auto-switch hold after a MANUAL switch, on top of T_INPUT.switchLockTicks, ticks (>= switchLockTicks). */
  manualHoldTicks: 42,
  /** Spacing of carrier-path / loose-ball samples, ticks. */
  sampleStepTicks: 4,
  /** Spacing of loose-ball samples more than looseHorizonTicks ahead (after a long ball comes down), ticks. */
  sampleStepFarTicks: 8,
  /** Opponent carrier path look-ahead, ticks. */
  carrierHorizonTicks: 90,
  /** Loose-ball look-ahead, counted in ticks the ball is playable (at or below reachHeight), ticks. */
  looseHorizonTicks: 120,
  /**
   * Most ticks the loose-ball look-ahead follows the ball out of reach (above reachHeight) on top of
   * looseHorizonTicks, ticks. Covers the longest real flights (a 35 m/s clearance at 1 rad comes down after ~300).
   */
  airHorizonTicks: 360,
  /** Highest ball-centre height an outfield player can play (head plus a small jump), m. */
  reachHeight: 2.3,
  /** Carrier speed cap for path extrapolation, m/s. */
  carrierMaxSpeed: 10,
  /** Goal-side bonus subtracted from a defender's effective arrival, ticks. */
  goalSideBonusTicks: 20,
  /** A defender is goal-side when at least this much nearer his own goal line than the carrier, m. */
  goalSideMargin: 0.5,
  /** Auto-switch hysteresis: candidate must beat the current player by max(this, autoMarginFrac * current), ticks. */
  autoMarginTicks: 12,
  /** Relative part of the auto-switch hysteresis (fraction of the current player's arrival). */
  autoMarginFrac: 0.25,
  /**
   * Next-switch marker / MOD_L among teammates tied on arrival: the previous marker is kept while he gets to his
   * meeting point at most this much later than the best, ticks.
   */
  markerTieTicks: 6,
  /** Never auto-switch away from a player who reaches the loose ball within this many ticks. */
  aboutToReceiveTicks: 20,
  /**
   * [QF-9] ... nor from one the loose ball itself comes to within aboutToReceiveTicks: its path (relative to his run)
   * passes within SIM-07's receive reach of him (T_TOUCH.receiveRadius at the feet, x chestReachMul above that, up to
   * reachHeight for a header; a ball slower than receiveMinSpeed is a SIM-06 pick-up within T_DRIBBLE.controlRadius). EFF
   * counts the run to a sampled point (T_PLAYER.arriveStop), so a ball rolling past him 0.9 m away read as a chase: the
   * CPU switched away on that very tick and back once SIM-07 gave him the touch. m/s (mirrors SIM-07 minTrapSpeed).
   */
  receiveMinSpeed: 3,
  /**
   * [QF-9] Loose-ball auto-switching waits while an opponent reaches the ball more than this many ticks before our
   * best candidate (he will have it; the carrier rule decides then), ticks.
   */
  contestTicks: 2,
  /**
   * [QF-9 skeptic] ... and only while our current man can get to where the opponent meets the ball within this many
   * ticks from now (about 20 m from a standstill: he is in the play, so the carrier rule can come back to him once
   * the receiver has it). A man farther off is never the one control flips back to, so waiting only stranded control
   * on him. Counted from now, not from the opponent's arrival, so the decision does not change as the ball arrives
   * while he stands (AUTO; AIR_AND_LOOSE never waits: it has no carrier rule), ticks.
   */
  contestInPlayTicks: 180,
  /** [QF-9] The last kicker cannot touch his own kick for this many ticks (mirrors SIM-06 / SIM-07 selfKickTicks). */
  selfKickTicks: 12,
  /**
   * Loose / air-ball auto-switching acts only this long after the latest ball touch (a fresh situation), ticks.
   * Must be <= switchLockTicks + manualHoldTicks: then, once a manual hold expires, a loose-ball auto-switch needs a
   * ball touch that happened after the manual switch, so auto never undoes the user's choice in the same scramble.
   */
  autoWindowTicks: 60,
  /** The current defender is beaten when the carrier is this much nearer our goal line than him, m ... */
  beatenMargin: 1.0,
  /** ... and at least this far from him, m. */
  beatenDist: 1.5,
  /** Directional switch: cosine of the cone half-angle (60 deg), then the wide fallback cone (90 deg). */
  dirConeCos: 0.5,
  dirConeCosWide: 0,
  /** Directional score = (1 - cos) * dirAngleWeight + distance * dirDistWeight (m-equivalent, lower wins). */
  dirAngleWeight: 40,
  dirDistWeight: 0.5,
  /**
   * Reachability prune (pure optimisation; changes no result while ticksToReach stays physically plausible): a
   * sample farther than a player could possibly run in the time is skipped without calling ticksToReach. Bound over
   * time T (s), current speed v, his own attrs.topSpeed / attrs.accel (as SIM-04 reads them; stamina only lowers
   * them): min(v*T + accel*f*T^2/2, max(v, topSpeed)*f*T) + T_PLAYER.arriveStop + pruneSlack, f = pruneFactor
   * (generous on purpose: SIM-04 estimates include turning and a slower high-speed acceleration, so they are slower).
   */
  pruneFactor: 1.25,
  pruneSlack: 0.5,
} as const; // TUNING-CR

/** Effective manual hold and auto window, clamped so the switchLockT encoding holds for any tuning (see header). */
const MANUAL_HOLD = LOCAL_TUNING.manualHoldTicks > T_INPUT.switchLockTicks ? LOCAL_TUNING.manualHoldTicks : T_INPUT.switchLockTicks;
const MANUAL_LOCK = T_INPUT.switchLockTicks + MANUAL_HOLD;
const AUTO_WINDOW = LOCAL_TUNING.autoWindowTicks < MANUAL_LOCK ? LOCAL_TUNING.autoWindowTicks : MANUAL_LOCK;

/** "Effectively never" arrival, ticks (finite on purpose). */
const BIG = 1e9;

const MODE_BALL = 0;
const MODE_CARRIER = 1;
const MODE_LOOSE = 2;

// ---------------------------------------------------------------- module scratch (transient within one call)

const MAX_SAMPLES = 64;
/** Ticks integrated in one step while a loose ball is far above reach (numerical detail, not gameplay tuning). */
const AIR_LONG_STEP = 4;
/** Carrier-path samples. */
const CX = new Float64Array(MAX_SAMPLES);
const CY = new Float64Array(MAX_SAMPLES);
const CZ = new Float64Array(MAX_SAMPLES);
const CT = new Float64Array(MAX_SAMPLES);
/** Carrier samples are never out of reach. */
const CU = new Float64Array(MAX_SAMPLES);
/** Loose-ball samples (playable ones, plus the last simulated position). LU = ticks out of reach up to the sample. */
const LX = new Float64Array(MAX_SAMPLES);
const LY = new Float64Array(MAX_SAMPLES);
const LZ = new Float64Array(MAX_SAMPLES);
const LT = new Float64Array(MAX_SAMPLES);
const LU = new Float64Array(MAX_SAMPLES);
/**
 * Memo of the last loose-ball path: its inputs (x, y, z, vx, vy, vz, sx, sy, sz) and sample count. The path is a pure
 * function of these, so the same ball (other controllers this tick, a ball at rest) reuses LX..LU as they are.
 */
const LKEY = new Float64Array(9);
let lKeyValid = false;
let looseN = 0;
/** Samples computeEff reads (the carrier or the loose set) and their count. */
let SX = CX;
let SY = CY;
let SZ = CZ;
let ST = CT;
let SU = CU;
let nSamples = 0;
/** Effective arrival per slot for the side last passed to computeEff (BIG for inactive / other side). */
const EFF = new Float64Array(NUM_SLOTS);
/** Tie-break per slot: ticks to the point where he meets the ball / carrier (lower = there sooner, waiting). */
const TIE = new Float64Array(NUM_SLOTS);
/** Ticks the ball is out of reach before each slot's EFF (0 unless a loose ball is in the air). */
const AIR = new Float64Array(NUM_SLOTS);
/** [0] = time of the last sample computeEff used (its look-ahead end), ticks. A typed slot: no boxing per write. */
const EFF_END = new Float64Array(1);
/** Side EFF currently holds (-1 = unknown). */
let effSide = -1;
/** True only while one switchTick call runs: EFF may then be reused (positions do not change within the call). */
let effReuse = false;

// ---------------------------------------------------------------- small helpers

function isLive(ctl: ControllerState): boolean {
  return (ctl.kind === ControllerKind.HUMAN || ctl.kind === ControllerKind.CPU) && (ctl.side === 0 || ctl.side === 1);
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot);
}

/** Active player of `side`. */
function activeOf(s: SimState, slot: number, side: number): boolean {
  if (!validSlot(slot)) return false;
  const p = s.players[slot]!;
  return p.active === 1 && p.team === side;
}

/** True when another live controller (not c) really controls `slot`. */
function heldByOther(s: SimState, c: number, slot: number): boolean {
  const o = s.players[slot]!.ctrl;
  if (o < 0 || o === c || o >= NUM_CONTROLLERS) return false;
  const oc = s.ctrl[o]!;
  return isLive(oc) && oc.slot === slot;
}

/** Candidate for controller c: active, its side, not held by another controller, outfield unless allowKeeper. */
function eligible(s: SimState, c: number, slot: number, allowKeeper: boolean): boolean {
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== s.ctrl[c]!.side) return false;
  if (!allowKeeper && p.isKeeper === 1) return false;
  return !heldByOther(s, c, slot);
}

/** Effective auto-switch mode: CPU brains always use AUTO. */
function autoModeOf(ctl: ControllerState): AutoSwitch {
  return ctl.kind === ControllerKind.CPU ? AutoSwitch.AUTO : ctl.autoSwitch;
}

function isRestartPhase(phase: MatchPhase): boolean {
  return phase === MatchPhase.KICK_OFF || (phase >= MatchPhase.THROW_IN && phase <= MatchPhase.PENALTY);
}

/** RestartKind that belongs to a restart phase. */
function restartKindOf(phase: MatchPhase): RestartKind {
  return phase === MatchPhase.KICK_OFF ? RestartKind.KICK_OFF : ((phase - 1) as RestartKind);
}

/** Our pass is travelling to our (active) intended receiver and nobody else touched it since. */
function ourPassInFlight(s: SimState, side: number): boolean {
  const b = s.ball;
  return b.owner < 0 && b.heldBy < 0 && activeOf(s, b.passTarget, side) && b.lastTouchTeam === side;
}

/** Our team has the ball (at feet or in the keeper's hands) or our pass is on its way to a teammate. */
function attackContext(s: SimState, side: number): boolean {
  const b = s.ball;
  if (validSlot(b.heldBy) && s.players[b.heldBy]!.team === side) return true;
  if (validSlot(b.owner) && s.players[b.owner]!.team === side) return true;
  return ourPassInFlight(s, side);
}

/**
 * Ticks a player is still committed beyond what ticksToReach already counts: stun, and the remaining ticks of an
 * action that does not lock locomotion (SIM-04 ticksToReach adds them itself for moveMode LOCKED).
 */
function busyTicks(p: PlayerState): number {
  let t = p.stunT > 0 ? p.stunT : 0;
  if (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD && p.moveMode !== MoveMode.LOCKED) {
    const r = p.actDur - p.actT;
    if (r > 0) t += r;
  }
  return t;
}


// ---------------------------------------------------------------- arrival estimates

/** Samples of the opponent carrier's extrapolated path (linear, capped speed, clamped to the pitch). */
function buildCarrierSamples(s: SimState, carrier: number): void {
  const p = s.players[carrier]!;
  let vx = p.vx;
  let vz = p.vz;
  const sp = Math.sqrt(vx * vx + vz * vz);
  const cap = LOCAL_TUNING.carrierMaxSpeed;
  if (sp > cap) { vx = (vx / sp) * cap; vz = (vz / sp) * cap; }
  const step = LOCAL_TUNING.sampleStepTicks;
  const horizon = LOCAL_TUNING.carrierHorizonTicks;
  let n = 0;
  const px = p.x;
  const pz = p.z;
  for (let t = 0; t <= horizon && n < MAX_SAMPLES; t += step) {
    const sec = t * DT_S;
    let x = px + vx * sec;
    let z = pz + vz * sec;
    if (x < -HALF_L) x = -HALF_L; else if (x > HALF_L) x = HALF_L;
    if (z < -HALF_W) z = -HALF_W; else if (z > HALF_W) z = HALF_W;
    CX[n] = x;
    CY[n] = 0;
    CZ[n] = z;
    CT[n] = t;
    n++;
  }
  nSamples = n;
}

/**
 * Samples of a free ball's path. The air phase is SIM-01 ballAirStep's explicit midpoint rule inlined on locals (the
 * sim's drag, Magnus and spin decay; no object stores, so nothing is boxed): one step per tick, or AIR_LONG_STEP
 * ticks at once while the ball is so high it cannot come within reach meanwhile. Ground bounce, rolling resistance
 * and the boards are a cheap copy of SIM-02 (switching only needs who-gets-there-first, not centimetres). Only
 * playable samples (ball centre at or below reachHeight) are kept: every sampleStepTicks (sampleStepFarTicks beyond
 * looseHorizonTicks from now), plus the tick the ball comes back within reach; the last simulated position always
 * ends the set (computeEff's fallback reads it). The path runs until the ball has been playable for
 * looseHorizonTicks or out of reach for airHorizonTicks, so a long high ball is followed to where it comes down.
 * Memoised on the ball's kinematics (see LKEY).
 */
function buildLooseSamples(s: SimState): void {
  const b = s.ball;
  // Same inputs as last time? (Finite doubles: a - b === 0 exactly when a === b; NaN never matches.)
  const hit = lKeyValid && LKEY[0]! - b.x === 0 && LKEY[1]! - b.y === 0 && LKEY[2]! - b.z === 0 &&
    LKEY[3]! - b.vx === 0 && LKEY[4]! - b.vy === 0 && LKEY[5]! - b.vz === 0 && LKEY[6]! - b.sx === 0 &&
    LKEY[7]! - b.sy === 0 && LKEY[8]! - b.sz === 0;
  if (!hit) {
    LKEY[0] = b.x; LKEY[1] = b.y; LKEY[2] = b.z; LKEY[3] = b.vx; LKEY[4] = b.vy; LKEY[5] = b.vz;
    LKEY[6] = b.sx; LKEY[7] = b.sy; LKEY[8] = b.sz;
    lKeyValid = true;
    simulateLoose();
  }
  nSamples = looseN;
}

/** The loose-ball path from the inputs in LKEY into LX..LU and looseN (see buildLooseSamples). */
function simulateLoose(): void {
  let x = LKEY[0]!, y = LKEY[1]!, z = LKEY[2]!, vx = LKEY[3]!, vy = LKEY[4]!, vz = LKEY[5]!;
  let sx = LKEY[6]!, sy = LKEY[7]!, sz = LKEY[8]!;
  const R = BALL_R;
  const dt = DT_S;
  const k = AIR_DRAG;
  const m = AIR_MAGNUS;
  const g = GRAVITY;
  // Spin decay per step (second-order exp(-spinDecayAir * dt)) and at the half step, as SIM-01; the same for a
  // long step of AIR_LONG_STEP ticks.
  const kd = SPIN_DECAY_AIR * dt;
  const fSpin1 = kd >= 1 ? 0 : 1 - kd + 0.5 * kd * kd;
  const fSpinH1 = kd >= 1 ? 0 : 1 - 0.5 * kd + 0.125 * kd * kd;
  const dtL = AIR_LONG_STEP * dt;
  const kdL = SPIN_DECAY_AIR * dtL;
  const fSpinL = kdL >= 1 ? 0 : 1 - kdL + 0.5 * kdL * kdL;
  const fSpinHL = kdL >= 1 ? 0 : 1 - 0.5 * kdL + 0.125 * kdL * kdL;
  let rolling = y <= R + 1e-6 && vy <= 0;
  const rollVy = T_BALL.rollThresholdVy;
  const rest = T_BALL.restitution;
  const fric = 1 - T_BALL.bounceFriction;
  const restSpeed = T_BALL.restSpeed;
  const rollDecel = T_BALL.rollDecel;
  const rollDamp = T_BALL.rollDamping;
  const bx = BOARD_XS;
  const bz = BOARD_ZS;
  const reachH = LOCAL_TUNING.reachHeight;
  const step = LOCAL_TUNING.sampleStepTicks;
  const stepFar = LOCAL_TUNING.sampleStepFarTicks;
  const horizon = LOCAL_TUNING.looseHorizonTicks;
  const airCap = LOCAL_TUNING.airHorizonTicks;
  let n = 0;
  let air = 0;
  let wasOut = y > reachH;
  if (!wasOut) {
    LX[0] = x; LY[0] = y; LZ[0] = z; LT[0] = 0; LU[0] = 0;
    n = 1;
  }
  let t = 0;
  while (t - air < horizon && air < airCap && n < MAX_SAMPLES - 1) {
    let adv = 1;
    if (!rolling) {
      let sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // Far above reach: one long step of AIR_LONG_STEP ticks (no sample is needed while the ball is out of reach,
      // and the midpoint rule stays accurate). Taken only when |vy| T + aMax T^2 + 0.1 m (aMax = g + drag + Magnus,
      // twice the constant-acceleration drop) still leaves the ball above reachHeight.
      const aMax = g + k * sp * sp + m * Math.sqrt(sx * sx + sy * sy + sz * sz) * sp;
      const vyAbs = vy < 0 ? -vy : vy;
      if (y - reachH > vyAbs * dtL + aMax * dtL * dtL + 0.1) adv = AIR_LONG_STEP;
      const dt1 = adv === 1 ? dt : dtL;
      const h = 0.5 * dt1;
      const fSpin = adv === 1 ? fSpin1 : fSpinL;
      const fSpinH = adv === 1 ? fSpinH1 : fSpinHL;
      let ax = -k * sp * vx + m * (sy * vz - sz * vy);
      let ay = -g - k * sp * vy + m * (sz * vx - sx * vz);
      let az = -k * sp * vz + m * (sx * vy - sy * vx);
      const mx = vx + ax * h;
      const my = vy + ay * h;
      const mz = vz + az * h;
      const msx = sx * fSpinH;
      const msy = sy * fSpinH;
      const msz = sz * fSpinH;
      sp = Math.sqrt(mx * mx + my * my + mz * mz);
      ax = -k * sp * mx + m * (msy * mz - msz * my);
      ay = -g - k * sp * my + m * (msz * mx - msx * mz);
      az = -k * sp * mz + m * (msx * my - msy * mx);
      x += mx * dt1;
      y += my * dt1;
      z += mz * dt1;
      vx += ax * dt1;
      vy += ay * dt1;
      vz += az * dt1;
      sx *= fSpin;
      sy *= fSpin;
      sz *= fSpin;
      if (y <= R) {
        y = R;
        const vo = -vy * rest;
        vx *= fric;
        vz *= fric;
        if (vo < rollVy) {
          vy = 0;
          rolling = true;
        } else {
          vy = vo;
        }
      }
    } else {
      const sp = Math.sqrt(vx * vx + vz * vz);
      if (sp > 0) {
        let ns = sp - (rollDecel + rollDamp * sp) * dt;
        if (ns < restSpeed) ns = 0;
        const q = ns / sp;
        const nx = vx * q;
        const nz = vz * q;
        x += 0.5 * (vx + nx) * dt;
        z += 0.5 * (vz + nz) * dt;
        vx = nx;
        vz = nz;
      }
    }
    t += adv;
    if (x > bx) { x = bx; vx = 0; } else if (x < -bx) { x = -bx; vx = 0; }
    if (z > bz) { z = bz; vz = 0; } else if (z < -bz) { z = -bz; vz = 0; }
    if (y > reachH) {
      air += adv;
      wasOut = true;
      continue;
    }
    if (wasOut || t % (t <= horizon ? step : stepFar) === 0) {
      LX[n] = x; LY[n] = y; LZ[n] = z; LT[n] = t; LU[n] = air;
      n++;
    }
    wasOut = false;
  }
  if (n === 0 || LT[n - 1]! < t) {
    LX[n] = x; LY[n] = y; LZ[n] = z; LT[n] = t; LU[n] = air;
    n++;
  }
  looseN = n;
}

/**
 * Fill EFF (and TIE, AIR) for every slot of `side` (BIG for inactive players and the other side) for the current
 * situation and return the mode. Pure with respect to the state (writes module scratch only).
 */
function computeEff(s: SimState, side: number): number {
  const b = s.ball;
  let mode = MODE_LOOSE;
  let carrier = -1;
  if (validSlot(b.owner) || validSlot(b.heldBy)) {
    carrier = validSlot(b.owner) ? b.owner : b.heldBy;
    mode = s.players[carrier]!.team !== side ? MODE_CARRIER : MODE_BALL;
  }
  if (mode === MODE_CARRIER) {
    buildCarrierSamples(s, carrier);
    SX = CX; SY = CY; SZ = CZ; ST = CT; SU = CU;
  } else if (mode === MODE_LOOSE) {
    buildLooseSamples(s);
    SX = LX; SY = LY; SZ = LZ; ST = LT; SU = LU;
  } else {
    nSamples = 0;
  }
  effSide = side;
  EFF_END[0] = nSamples > 0 ? ST[nSamples - 1]! : 0;
  const dir = s.teams[side]!.dir;
  const carrierDepth = carrier >= 0 ? dir * s.players[carrier]!.x : 0;
  const reachH = mode === MODE_LOOSE ? LOCAL_TUNING.reachHeight : BIG;
  const pf = LOCAL_TUNING.pruneFactor;
  const topMin = T_PLAYER.topSpeedMin;
  const accMin = T_PLAYER.accelMin;
  const slack = T_PLAYER.arriveStop + LOCAL_TUNING.pruneSlack;
  for (let i = 0; i < NUM_SLOTS; i++) { EFF[i] = BIG; TIE[i] = BIG; AIR[i] = 0; }
  const first = teamFirstSlot(side);
  const end = first + PLAYERS_PER_TEAM;
  for (let i = first; i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const busy = busyTicks(p);
    if (mode === MODE_BALL) {
      EFF[i] = ticksToReach(s, i, b.x, b.z) + busy;
      TIE[i] = EFF[i]!;
      continue;
    }
    let eff = -1;
    let tie = 0;
    let air = 0;
    const px = p.x;
    const pz = p.z;
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    // His own top speed and acceleration as SIM-04 reads them (stamina only lowers them), padded by pruneFactor.
    const at = s.attrs[i]!;
    const top = at.topSpeed > 0 ? at.topSpeed : topMin;
    const vCap = (sp > top ? sp : top) * pf;
    const accHalf = 0.5 * (at.accel > 0 ? at.accel : accMin) * pf;
    for (let k = 0; k < nSamples; k++) {
      if (SY[k]! > reachH) continue;
      const t = ST[k]! - busy;
      if (t < 0) continue;
      const T = t * DT_S;
      const accRun = sp * T + accHalf * T * T;
      const capRun = vCap * T;
      const reach = (accRun < capRun ? accRun : capRun) + slack;
      const dx = SX[k]! - px;
      const dz = SZ[k]! - pz;
      if (dx * dx + dz * dz > reach * reach) continue; // cannot be there in time: skip the full estimate
      const ttr = ticksToReach(s, i, SX[k]!, SZ[k]!);
      if (ttr <= t) { eff = ST[k]!; tie = ttr + busy; air = SU[k]!; break; }
    }
    if (eff < 0) {
      const L = nSamples - 1;
      eff = ST[L]! + ticksToReach(s, i, SX[L]!, SZ[L]!) + busy;
      tie = eff;
      air = SU[L]!;
    }
    if (mode === MODE_CARRIER && dir * p.x < carrierDepth - LOCAL_TUNING.goalSideMargin) eff -= LOCAL_TUNING.goalSideBonusTicks;
    EFF[i] = eff;
    TIE[i] = tie;
    AIR[i] = air;
  }
  return mode;
}

/** [QF-9] Scratch copies of EFF / TIE / AIR while opponentArrival computes the other side's arrivals. */
const EFF_SAVE = new Float64Array(NUM_SLOTS);
const TIE_SAVE = new Float64Array(NUM_SLOTS);
const AIR_SAVE = new Float64Array(NUM_SLOTS);

/**
 * [QF-9] Earliest effective arrival (ticks) of `side`'s opponents at the loose ball (keeper included), from the same
 * model. EFF / TIE / AIR / EFF_END hold `side` again afterwards (call it only once EFF holds `side`).
 */
function opponentArrival(s: SimState, side: number): number {
  const end = EFF_END[0]!;
  for (let i = 0; i < NUM_SLOTS; i++) { EFF_SAVE[i] = EFF[i]!; TIE_SAVE[i] = TIE[i]!; AIR_SAVE[i] = AIR[i]!; }
  const other = side === 0 ? 1 : 0;
  computeEff(s, other);
  let best = BIG;
  const first = teamFirstSlot(other);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (EFF[i]! < best) best = EFF[i]!;
  for (let i = 0; i < NUM_SLOTS; i++) { EFF[i] = EFF_SAVE[i]!; TIE[i] = TIE_SAVE[i]!; AIR[i] = AIR_SAVE[i]!; }
  EFF_END[0] = end;
  effSide = side;
  return best;
}

/**
 * [QF-9 skeptic] Ticks (from now) for `slot` to get to the loose ball's predicted position at tick `at` (the first
 * sample at or after it, else the last): SIM-04 ticksToReach plus his busy ticks. Call right after computeEff /
 * opponentArrival for a loose ball (the samples are the loose path).
 */
function contestReach(s: SimState, slot: number, at: number): number {
  if (nSamples <= 0) return BIG;
  let k = 0;
  while (k < nSamples - 1 && ST[k]! < at) k++;
  return ticksToReach(s, slot, SX[k]!, SZ[k]!) + busyTicks(s.players[slot]!);
}

/** computeEff unless EFF already holds `side` for the switchTick call in progress. */
function effFor(s: SimState, side: number): void {
  if (effReuse && effSide === side) return;
  computeEff(s, side);
}

/**
 * Lowest EFF among c's eligible candidates, excluding `exclude`; ties on EFF go to the lower TIE (there sooner),
 * then the lower slot. `prefer` (or -1) is kept instead when he ties on EFF and is within markerTieTicks on TIE.
 * -1 if none.
 */
function pickBest(s: SimState, c: number, exclude: number, allowKeeper: boolean, prefer: number): number {
  const side = s.ctrl[c]!.side;
  const first = teamFirstSlot(side);
  const end = first + PLAYERS_PER_TEAM;
  let best = -1;
  let bestEff = BIG * 2;
  let bestTie = BIG * 2;
  for (let i = first; i < end; i++) {
    if (i === exclude || !eligible(s, c, i, allowKeeper)) continue;
    const e = EFF[i]!;
    const k = TIE[i]!;
    if (e < bestEff || (e === bestEff && k < bestTie)) { bestEff = e; bestTie = k; best = i; }
  }
  if (best >= 0 && prefer !== best && prefer >= first && prefer < end && prefer !== exclude &&
    EFF[prefer] === bestEff && TIE[prefer]! <= bestTie + LOCAL_TUNING.markerTieTicks && eligible(s, c, prefer, allowKeeper)) {
    return prefer;
  }
  return best;
}

/** Outfield teammate most aligned with (dirX, dirZ) from the current player (or the ball). -1 if none. */
function directionalTarget(s: SimState, c: number, dirX: number, dirZ: number): number {
  const ctl = s.ctrl[c]!;
  const cur = ctl.slot;
  const mag = Math.sqrt(dirX * dirX + dirZ * dirZ);
  const ux = dirX / mag;
  const uz = dirZ / mag;
  let ox = s.ball.x;
  let oz = s.ball.z;
  if (activeOf(s, cur, ctl.side)) { ox = s.players[cur]!.x; oz = s.players[cur]!.z; }
  const first = teamFirstSlot(ctl.side);
  const end = first + PLAYERS_PER_TEAM;
  for (let pass = 0; pass < 2; pass++) {
    const coneCos = pass === 0 ? LOCAL_TUNING.dirConeCos : LOCAL_TUNING.dirConeCosWide;
    let best = -1;
    let bestScore = BIG;
    for (let i = first; i < end; i++) {
      if (i === cur || !eligible(s, c, i, false)) continue;
      const p = s.players[i]!;
      const dx = p.x - ox;
      const dz = p.z - oz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const cos = d > 1e-3 ? (dx * ux + dz * uz) / d : 1;
      if (cos < coneCos) continue;
      const score = (1 - cos) * LOCAL_TUNING.dirAngleWeight + d * LOCAL_TUNING.dirDistWeight;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---------------------------------------------------------------- ownership

/**
 * Which controller of `side` should take `slot`: the one already on him, else the one whose player struck our last
 * kick (the passer), else the one whose player is nearest (lowest index on ties). -1 if the side has none.
 */
function claimant(s: SimState, side: number, slot: number): number {
  const p = s.players[slot]!;
  const o = p.ctrl;
  if (o >= 0 && o < NUM_CONTROLLERS) {
    const oc = s.ctrl[o]!;
    if (isLive(oc) && oc.side === side && oc.slot === slot) return o;
  }
  const b = s.ball;
  if (b.lastKickTeam === side && validSlot(b.lastKickBy)) {
    for (let k = 0; k < NUM_CONTROLLERS; k++) {
      const kc = s.ctrl[k]!;
      if (isLive(kc) && kc.side === side && kc.slot === b.lastKickBy) return k;
    }
  }
  let best = -1;
  let bestD = BIG * BIG;
  for (let k = 0; k < NUM_CONTROLLERS; k++) {
    const kc = s.ctrl[k]!;
    if (!isLive(kc) || kc.side !== side) continue;
    let d = BIG;
    if (validSlot(kc.slot)) {
      const q = s.players[kc.slot]!;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      d = dx * dx + dz * dz;
    }
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** `slot` if controller c is its claimant, else -1. */
function claimFor(s: SimState, c: number, slot: number): number {
  return claimant(s, s.ctrl[c]!.side, slot) === c ? slot : -1;
}

/**
 * IN_PLAY only: a keeper without the ball is handed back to the keeper AI; the controller moves to the best
 * outfield player. -1 when the rule does not apply (not a keeper, keeper has the ball, or a loose ball is about to
 * reach him: a ball dropped at his feet, a parry he will collect).
 */
function leaveKeeperTarget(s: SimState, c: number): number {
  const ctl = s.ctrl[c]!;
  const cur = ctl.slot;
  if (!activeOf(s, cur, ctl.side) || s.players[cur]!.isKeeper !== 1) return -1;
  const b = s.ball;
  if (b.owner === cur || b.heldBy === cur) return -1;
  effFor(s, ctl.side);
  // A loose ball about to reach him (a parry, a ball dropped at his feet) keeps him; a shot in flight is the keeper
  // AI's to save (D-009).
  if (b.owner < 0 && b.heldBy < 0 &&
    (EFF[cur]! <= LOCAL_TUNING.aboutToReceiveTicks || (b.shotBy < 0 && receiveSoon(s, cur)))) return -1;
  return pickBest(s, c, cur, false, -1);
}

/** The player controller c must control right now by the ownership rules, or -1 (free choice). */
function forcedTarget(s: SimState, c: number): number {
  const ctl = s.ctrl[c]!;
  const side = ctl.side;
  const m = s.match;
  const phase = m.phase;
  const b = s.ball;
  if (phase === MatchPhase.IN_PLAY) {
    if (validSlot(b.heldBy)) {
      if (activeOf(s, b.heldBy, side)) return claimFor(s, c, b.heldBy);
      return leaveKeeperTarget(s, c);
    }
    if (validSlot(b.owner)) {
      if (activeOf(s, b.owner, side)) return claimFor(s, c, b.owner);
      return leaveKeeperTarget(s, c);
    }
    if (ourPassInFlight(s, side)) {
      // Assisted switching: take the receiver as the pass is struck. OFF: stay on the passer until reception.
      if (autoModeOf(ctl) !== AutoSwitch.OFF) return claimFor(s, c, b.passTarget);
      return -1;
    }
    return leaveKeeperTarget(s, c);
  }
  if (isRestartPhase(phase)) {
    const r = m.restart;
    if (r.kind !== restartKindOf(phase)) return -1;
    if (r.team === side) return activeOf(s, r.taker, side) ? claimFor(s, c, r.taker) : -1;
    if (phase === MatchPhase.PENALTY) {
      const k = s.teams[side]!.keeperSlot;
      return activeOf(s, k, side) ? claimFor(s, c, k) : -1;
    }
    return -1;
  }
  if (phase === MatchPhase.SHOOT_OUT) {
    const so = m.shootout;
    const want = so.team === side ? so.kicker : so.keeper;
    return activeOf(s, want, side) ? claimFor(s, c, want) : -1;
  }
  return -1;
}

/** Hand a player back to the team AI: drop the human/CPU stick intent and any power charge. */
function resetToAi(p: PlayerState): void {
  if (p.moveMode !== MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  p.actCharging = 0;
}

// ---------------------------------------------------------------- public API

/**
 * Make sure controller c controls a valid active player of its side (called every tick by the resolver), and
 * apply the ownership rules (ball carrier, keeper in hands, receiver of our pass, restart taker, penalty and
 * shoot-out keeper/kicker). Idempotent within a tick.
 */
export function ensureControlledPlayer(s: SimState, c: number, ev: EventSink): void {
  const ctl = s.ctrl[c];
  if (!ctl) return;
  // Clear stale claims: only ctl.slot may point back at c.
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.ctrl === c && (i !== ctl.slot || p.active !== 1 || !isLive(ctl))) {
      p.ctrl = -1;
      resetToAi(p);
    }
  }
  if (!isLive(ctl)) {
    ctl.slot = -1;
    ctl.nextSwitch = -1;
    return;
  }
  const cur = ctl.slot;
  const valid = activeOf(s, cur, ctl.side) && s.players[cur]!.ctrl === c;
  if (!valid) {
    let pick = forcedTarget(s, c);
    if (pick < 0) {
      effFor(s, ctl.side);
      pick = pickBest(s, c, -1, false, -1);
      if (pick < 0) pick = pickBest(s, c, -1, true, -1);
    }
    if (pick >= 0) switchTo(s, c, pick, ev);
    if (ctl.slot !== pick || pick < 0 || s.players[pick]!.ctrl !== c) {
      // Nothing valid to control (or the pick was refused): hold nobody rather than an invalid player.
      if (validSlot(ctl.slot) && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
      ctl.slot = -1;
    }
    return;
  }
  const want = forcedTarget(s, c);
  if (want >= 0 && want !== cur) switchTo(s, c, want, ev);
}

/**
 * Switch controller c to slot (validates; clears the previous player's ctrl). Refuses players that are inactive,
 * on the other side, or held by another live controller. Resets the previous player's intent to AI, starts the
 * switch lock-out and emits SWITCH (a = old slot or -1, b = new slot, c = controller).
 */
export function switchTo(s: SimState, c: number, slot: number, ev: EventSink): void {
  const ctl = s.ctrl[c];
  if (!ctl || !isLive(ctl) || !validSlot(slot)) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== ctl.side || heldByOther(s, c, slot)) return;
  const old = ctl.slot;
  if (old === slot) {
    p.ctrl = c; // repair a released claim on the same player (e.g. a substitution kept the slot); no event
    return;
  }
  if (validSlot(old)) {
    const q = s.players[old]!;
    if (q.ctrl === c) {
      q.ctrl = -1;
      resetToAi(q);
    }
  }
  ctl.slot = slot;
  p.ctrl = c;
  ctl.switchLockT = T_INPUT.switchLockTicks;
  if (ctl.nextSwitch === slot) ctl.nextSwitch = -1; // recomputed by the next switchTick; never marks the controlled player
  ev.emit(EventType.SWITCH, old, slot, c);
}

/** Best switch target for controller c (manual L1 press / auto), or -1. dirX/dirZ != 0 for directional. Pure. */
export function bestSwitchTarget(s: SimState, c: number, dirX: number, dirZ: number): number {
  const ctl = s.ctrl[c];
  if (!ctl || !isLive(ctl)) return -1;
  if (dirX !== 0 || dirZ !== 0) {
    if (!(Math.abs(dirX) < BIG && Math.abs(dirZ) < BIG)) return -1;
    return directionalTarget(s, c, dirX, dirZ);
  }
  if (!effReuse) effSide = -1; // a direct call always recomputes (the state may have changed since)
  effFor(s, ctl.side);
  return pickBest(s, c, ctl.slot, false, ctl.nextSwitch);
}

/**
 * True when a manual switch (MOD_L press, RS flick, tapping a teammate) applies for controller c: IN_PLAY without
 * our possession or our pass in flight, or the defending side of a non-penalty restart. SIM-15 reads MOD_L as
 * "change player" exactly when this holds.
 */
export function canManualSwitch(s: SimState, c: number): boolean {
  const ctl = s.ctrl[c];
  if (!ctl || !isLive(ctl)) return false;
  const phase = s.match.phase;
  if (phase === MatchPhase.IN_PLAY) return !attackContext(s, ctl.side);
  if (isRestartPhase(phase) && phase !== MatchPhase.PENALTY) return s.match.restart.team !== ctl.side;
  return false;
}

/**
 * Manual switch to a chosen teammate (touch: tap a teammate when defending). Same rules as MOD_L: defence context
 * only, outfield, not held by the other human. Starts the manual hold-off. Returns true if control moved.
 */
export function manualSwitch(s: SimState, c: number, slot: number, ev: EventSink): boolean {
  if (!canManualSwitch(s, c) || !validSlot(slot)) return false;
  const ctl = s.ctrl[c]!;
  if (slot === ctl.slot || !eligible(s, c, slot, false)) return false;
  switchTo(s, c, slot, ev);
  if (ctl.slot !== slot) return false;
  ctl.switchLockT = MANUAL_LOCK;
  clearBuffer(ctl); // [QF-9] a buffered press was made for the player the user just left
  return true;
}

/**
 * [QF-9] An automatic switch: switchTo, and a press still buffered for the player control leaves is dropped (it was
 * meant for him: a CPU clearance press buffered for its defender while the ball arrived fired as a header SHOT by the
 * teammate auto-switched to on the next tick). Ownership switches (the receiver of our pass, the keeper with the ball)
 * keep it: a press made while our pass travels is the receiver's first-time play.
 */
function autoSwitchTo(s: SimState, c: number, slot: number, ev: EventSink): void {
  const ctl = s.ctrl[c]!;
  const old = ctl.slot;
  switchTo(s, c, slot, ev);
  if (ctl.slot !== old) clearBuffer(ctl);
}

/**
 * Release control of `slot` (sent off / substituted; RUL-10): clears p.ctrl and immediately gives the controller
 * that held him a valid player (the same slot again only if it is still valid, e.g. the fresh substitute).
 */
export function releasePlayer(s: SimState, slot: number, ev: EventSink): void {
  if (!validSlot(slot)) return;
  const p = s.players[slot]!;
  p.ctrl = -1;
  resetToAi(p);
  for (let k = 0; k < NUM_CONTROLLERS; k++) {
    const kc = s.ctrl[k]!;
    if (kc.nextSwitch === slot) kc.nextSwitch = -1;
    if (kc.slot === slot) ensureControlledPlayer(s, k, ev);
  }
}

/** Flick direction for controller c: the frame's aim stick, the CPU brain's frame, else the movement stick. */
function flickDir(s: SimState, c: number, f: Readonly<InputFrame> | null | undefined, out: Float64Array): void {
  const ctl = s.ctrl[c]!;
  let ax = 0;
  let az = 0;
  if (f) { ax = f.ax / AXIS_SCALE; az = f.az / AXIS_SCALE; }
  else if (ctl.kind === ControllerKind.CPU && c >= CPU_CONTROLLER_BASE) {
    const o = s.teams[c - CPU_CONTROLLER_BASE]!.cpu.out;
    ax = o.ax / AXIS_SCALE; az = o.az / AXIS_SCALE;
  }
  if (ax === 0 && az === 0) { ax = ctl.mx; az = ctl.mz; }
  if (!(ax * ax + az * az > 1e-6)) { ax = 0; az = 0; }
  out[0] = ax;
  out[1] = az;
}
const DIR = new Float64Array(2);

/**
 * [QF-9] True when the loose ball comes within SIM-07's (or, slower, SIM-06's) touch reach of `slot` within
 * aboutToReceiveTicks and he could take the touch then (not stunned, no action but a shield / first touch, his noTouchT
 * over by then). Closest approach of the ball to him on straight lines (his velocity and the ball's horizontal
 * velocity, both constant: rolling deceleration only shortens the ball's path, which still passes him), the ball's
 * height from its flight parabola (a grounded ball stays where it is). Pure, O(1).
 */
function receiveSoon(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.stunT > 0 || (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD && p.act !== ActionKind.FIRST_TOUCH)) return false;
  const horizon = LOCAL_TUNING.aboutToReceiveTicks;
  if (p.noTouchT >= horizon) return false;
  const b = s.ball;
  if (b.lastKickBy === slot && s.tick - b.lastKickTick < LOCAL_TUNING.selfKickTicks) return false; // his own kick
  const bv2 = b.vx * b.vx + b.vz * b.vz;
  const slow = b.grounded === 1 && bv2 < LOCAL_TUNING.receiveMinSpeed * LOCAL_TUNING.receiveMinSpeed;
  const ox = b.x - p.x, oz = b.z - p.z;
  const wx = b.vx - p.vx, wz = b.vz - p.vz;
  const w2 = wx * wx + wz * wz;
  const T = horizon * DT_S;
  // Only a ball still coming to him: one already in his reach and going away was not his to touch this tick (SIM-07
  // ran before this tick's switching), so it will not be the next.
  const along = ox * wx + oz * wz;
  if (!(along < 0) || w2 <= 1e-9) return false;
  let t = -along / w2;
  if (t > T) t = T;
  const cx = ox + wx * t, cz = oz + wz * t;
  let y = b.y;
  if (b.grounded !== 1) {
    y = b.y + b.vy * t - 0.5 * GRAVITY * t * t;
    if (y < BALL_R) y = BALL_R;
  }
  let r: number;
  if (slow) r = y <= T_DRIBBLE.controlHeight ? T_DRIBBLE.controlRadius : 0;
  // Above the chest (up to reachHeight): a header, within about the chest reach of him.
  else r = y <= T_DRIBBLE.controlHeight ? T_TOUCH.receiveRadius : y <= LOCAL_TUNING.reachHeight ? T_TOUCH.receiveRadius * CHEST_REACH_MUL : 0;
  return r > 0 && cx * cx + cz * cz <= r * r;
}

/**
 * [QF-9] The player is committed to playing the ball: a kick / shot / header / volley before its contact, or a
 * challenge before it has resolved (SIM-14 sets actDone when a tackle resolves or its window closes). Auto-switching
 * away from him handed the user another man while his header / clearance / tackle went on to play the ball 1-15 ticks
 * later (about one in three of the "switched away, then he touched it" cases of a bot-match scan).
 */
function committedToBall(p: PlayerState): boolean {
  const a = p.act;
  if (p.actDone !== 0) return false;
  return a === ActionKind.KICK || a === ActionKind.SHOT || a === ActionKind.HEADER || a === ActionKind.VOLLEY ||
    (a >= ActionKind.STAND_TACKLE && a <= ActionKind.PUSH_PULL);
}

/** Auto-switch rules for controller c (IN_PLAY, lock-out expired, defence context). EFF is computed here. */
function autoSwitchTick(s: SimState, c: number, ev: EventSink): void {
  const ctl = s.ctrl[c]!;
  const mode = autoModeOf(ctl);
  if (mode === AutoSwitch.OFF) return;
  const cur = ctl.slot;
  if (!activeOf(s, cur, ctl.side)) return;
  if (committedToBall(s.players[cur]!)) return; // [QF-9] his header / kick / tackle is about to play the ball
  const b = s.ball;
  const side = ctl.side;
  if (b.owner < 0 && b.heldBy < 0) {
    if (b.shotBy >= 0) return; // never re-assign during a shot in flight
    // Only a fresh loose / air ball: later in the same scramble the user (or a manual choice) stays in charge.
    if (!(b.lastTouchTick >= 0 && s.tick - b.lastTouchTick <= AUTO_WINDOW)) return;
    const airborne = b.grounded === 0 || b.y > BALL_R + 0.05;
    const oppPass = validSlot(b.passTarget) && s.players[b.passTarget]!.team !== side && b.lastTouchTeam !== side;
    if (!airborne && oppPass && mode !== AutoSwitch.AUTO) return; // an opponent's ground pass is not "loose"
    effFor(s, side);
    const effCur = EFF[cur]!;
    if (effCur <= LOCAL_TUNING.aboutToReceiveTicks) return; // never away from the player about to receive
    if (receiveSoon(s, cur)) return; // [QF-9] ... nor from the man the ball is rolling into
    const best = pickBest(s, c, cur, false, -1);
    if (best < 0) return;
    const eb = EFF[best]!;
    if (eb > EFF_END[0]!) return; // nobody of ours gets there within the look-ahead: no guess
    if (!(eb + autoMargin(effCur - AIR[cur]!) < effCur)) return;
    // [QF-9] An opponent gets there clearly first (an opponent's pass to its receiver): he will have it, and the
    // carrier rule decides then. Switching to our nearest chaser now flipped straight back to the goal-side man as soon
    // as the receiver controlled it and the lock-out ran out (16 of 35 flip-flops within 0.5 s in a 4-match scan).
    // [QF-9 skeptic] Only in AUTO (AIR_AND_LOOSE has no carrier rule to switch for him later: the human default mode
    // was left on a full-back 30 m away while the opponent's lofted pass came down next to our midfielder), and only
    // while the current man is in the play (contestInPlayTicks).
    if (mode === AutoSwitch.AUTO) {
      const opp = opponentArrival(s, side);
      if (opp + LOCAL_TUNING.contestTicks < eb && contestReach(s, cur, opp) <= LOCAL_TUNING.contestInPlayTicks) return;
    }
    autoSwitchTo(s, c, best, ev);
    return;
  }
  if (mode !== AutoSwitch.AUTO) return;
  const carrier = validSlot(b.owner) ? b.owner : b.heldBy;
  if (!validSlot(carrier) || s.players[carrier]!.team === side) return;
  const dir = s.teams[side]!.dir;
  const p = s.players[cur]!;
  const q = s.players[carrier]!;
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const beaten = dir * q.x < dir * p.x - LOCAL_TUNING.beatenMargin &&
    dx * dx + dz * dz > LOCAL_TUNING.beatenDist * LOCAL_TUNING.beatenDist;
  if (!beaten) return;
  effFor(s, side);
  const best = pickBest(s, c, cur, false, -1);
  if (best < 0) return;
  const effCur = EFF[cur]!;
  if (EFF[best]! + autoMargin(effCur) < effCur) autoSwitchTo(s, c, best, ev);
}

/**
 * Auto-switch hysteresis for a current player who meets the ball after `playable` ticks of it being playable
 * (his EFF minus the ticks the ball spends out of everyone's reach before then).
 */
function autoMargin(playable: number): number {
  const rel = LOCAL_TUNING.autoMarginFrac * playable;
  return rel > LOCAL_TUNING.autoMarginTicks ? rel : LOCAL_TUNING.autoMarginTicks;
}

/**
 * Per-tick switching logic (auto-switch, lock-out, next-switch marker). Called by the resolver after it has
 * updated ctrl.buttons / prevButtons / mx / mz for this tick. Pass the controller's frame as `f` so a right-stick
 * flick (Btn.RS_FLICK) switches toward f.ax / f.az; without it CPU brains use their own frame and humans the
 * movement stick.
 */
export function switchTick(s: SimState, c: number, ev: EventSink, f?: Readonly<InputFrame> | null): void {
  const ctl = s.ctrl[c];
  if (!ctl) return;
  if (ctl.switchLockT > 1) ctl.switchLockT -= 1;
  else ctl.switchLockT = 0;
  effSide = -1;
  effReuse = true;
  try {
    switchTickInner(s, c, ev, f);
  } finally {
    effReuse = false;
    effSide = -1;
  }
}

/**
 * [QF-3 QA-27] L1 pressed together with a face button on a loose ball that SIM-15 resolves as ours (controlContext
 * ATTACK: arriving at the controlled player, or he is nearer than the opponents) is the face button's L1 combo (chip,
 * pass and go, lobbed through, driven lob, power shot), not "change player": section 10, "a modifier combo resolves
 * when the face button is pressed, never when the modifier is". Touch sends every L1 combo in one frame. L1 alone
 * still switches; with an opponent on the ball (DEFENCE) L1 + face still switches.
 */
function modifierCombo(s: SimState, ctl: ControllerState, pressed: number): boolean {
  return (pressed & FACE_MASK) !== 0 && validSlot(ctl.slot) && controlContext(s, ctl.slot) === Ctx.ATTACK;
}

function switchTickInner(s: SimState, c: number, ev: EventSink, f: Readonly<InputFrame> | null | undefined): void {
  const ctl = s.ctrl[c]!;
  ensureControlledPlayer(s, c, ev);
  if (!isLive(ctl)) return;
  if (!canManualSwitch(s, c)) {
    ctl.nextSwitch = -1;
    return;
  }
  const pressed = ctl.buttons & ~ctl.prevButtons;
  let manual = -1;
  if ((pressed & Btn.RS_FLICK) !== 0) {
    flickDir(s, c, f, DIR);
    manual = bestSwitchTarget(s, c, DIR[0]!, DIR[1]!);
  } else if ((pressed & Btn.MOD_L) !== 0 && ctl.switchLockT <= MANUAL_HOLD && !modifierCombo(s, ctl, pressed)) {
    manual = bestSwitchTarget(s, c, 0, 0);
  }
  if (manual >= 0) manualSwitch(s, c, manual, ev);
  else if (ctl.switchLockT === 0 && s.match.phase === MatchPhase.IN_PLAY && (pressed & FACE_MASK) === 0) {
    // [QF-9] Never on a frame with a fresh face press: the press belongs to the player the user / CPU pressed it for
    // (SIM-15 resolves it after switching; a CPU clearance press for its defender in his own third became a 67 m
    // header SHOT by the teammate SIM-16 had just switched to). Auto-switching waits for the next frame.
    autoSwitchTick(s, c, ev);
  }
  ctl.nextSwitch = canManualSwitch(s, c) ? bestSwitchTarget(s, c, 0, 0) : -1;
}

/**
 * Debug / tests: the effective arrival (ticks) EFF computed for `side`, slot by slot, and the situation mode;
 * optionally the tie-break (ticks to the meeting point) and the ticks the ball is out of reach before EFF.
 */
export function debugSwitchEff(s: SimState, side: number, out: number[], tie?: number[], air?: number[]): number {
  const mode = computeEff(s, side);
  for (let i = 0; i < NUM_SLOTS; i++) {
    out[i] = EFF[i]!;
    if (tie) tie[i] = TIE[i]!;
    if (air) air[i] = AIR[i]!;
  }
  return mode;
}
/**
 * [QF-9 skeptic] Debug / tests, loose ball only: out[0] = the earliest arrival (ticks) of `side`'s opponents at the
 * ball, out[1] = ticks for `slot` to get to where the ball is then (the loose-ball contest of autoSwitchTick).
 */
export function debugSwitchContest(s: SimState, side: number, slot: number, out: number[]): void {
  computeEff(s, side);
  const opp = opponentArrival(s, side);
  out[0] = opp;
  out[1] = contestReach(s, slot, opp);
}
export const SWITCH_MODE = { BALL: MODE_BALL, CARRIER: MODE_CARRIER, LOOSE: MODE_LOOSE } as const;
/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const SWITCH_TUNING = LOCAL_TUNING;

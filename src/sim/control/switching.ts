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
 *     current) (hysteresis); never away from a player about to reach the ball (aboutToReceiveTicks); never while a
 *     shot is in flight.
 *  5. ctrl.nextSwitch = what a MOD_L press would pick now (-1 outside the defence context).
 *
 * "Effective" arrival (eff, ticks): opponent carrier -> first sampled time t at which the player can stand on the
 * carrier's extrapolated path no later than the carrier (SIM-04 ticksToReach), minus goalSideBonusTicks when he is
 * goal-side; loose ball -> first sampled time he can reach the predicted ball below reachHeight; our possession ->
 * ticks to the ball. Busy players (stunned, in a tackle/fall/action) add their remaining action ticks.
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
import { T_BALL, T_INPUT, T_PLAYER } from '../../contracts/tuning';
import { ticksToReach } from '../players/locomotion';

// Imported double constants copied into module consts: hot loops then read plain locals (module-namespace getters
// in some loaders box doubles on every read).
const DT_S = DT;
const BALL_R = BALL_RADIUS;
const HALF_L = HALF_LENGTH;
const HALF_W = HALF_WIDTH;
const BOARD_XS = BOARD_X;
const BOARD_ZS = BOARD_Z;

const LOCAL_TUNING = {
  /** Extra auto-switch hold after a MANUAL switch, on top of T_INPUT.switchLockTicks, ticks (>= switchLockTicks). */
  manualHoldTicks: 42,
  /** Spacing of carrier-path / loose-ball samples, ticks. */
  sampleStepTicks: 4,
  /** Opponent carrier path look-ahead, ticks. */
  carrierHorizonTicks: 90,
  /** Loose-ball look-ahead, ticks. */
  looseHorizonTicks: 120,
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
  /** Never auto-switch away from a player who reaches the loose ball within this many ticks. */
  aboutToReceiveTicks: 20,
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
   * time T (s), current speed v: min(v*T + accelMax*f*T^2/2, max(v, topSpeedMax)*f*T) + T_PLAYER.arriveStop +
   * pruneSlack, f = pruneFactor (generous on purpose: SIM-04 estimates include turning, so they are slower).
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
/** Carrier-path samples. */
const CX = new Float64Array(MAX_SAMPLES);
const CY = new Float64Array(MAX_SAMPLES);
const CZ = new Float64Array(MAX_SAMPLES);
const CT = new Float64Array(MAX_SAMPLES);
/** Loose-ball samples. */
const LX = new Float64Array(MAX_SAMPLES);
const LY = new Float64Array(MAX_SAMPLES);
const LZ = new Float64Array(MAX_SAMPLES);
const LT = new Float64Array(MAX_SAMPLES);
/** Samples computeEff reads (the carrier or the loose set) and their count. */
let SX = CX;
let SY = CY;
let SZ = CZ;
let ST = CT;
let nSamples = 0;
/** Effective arrival per slot for the side last passed to computeEff (BIG for inactive / other side). */
const EFF = new Float64Array(NUM_SLOTS);
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
 * Samples of a free ball's path. A deliberately cheap approximation of SIM-01/02 (gravity, quadratic drag, ground
 * bounce, rolling resistance, boards stop it): switching only needs who-gets-there-first, not centimetres.
 */
function buildLooseSamples(s: SimState): void {
  const b = s.ball;
  let x = b.x, y = b.y, z = b.z, vx = b.vx, vy = b.vy, vz = b.vz;
  const R = BALL_R;
  const dt = DT_S;
  let rolling = y <= R + 1e-6 && vy <= 0;
  const g = T_BALL.gravity;
  const k = T_BALL.dragK;
  const rollVy = T_BALL.rollThresholdVy;
  const rest = T_BALL.restitution;
  const fric = 1 - T_BALL.bounceFriction;
  const restSpeed = T_BALL.restSpeed;
  const rollDecel = T_BALL.rollDecel;
  const rollDamp = T_BALL.rollDamping;
  const bx = BOARD_XS;
  const bz = BOARD_ZS;
  const step = LOCAL_TUNING.sampleStepTicks;
  const horizon = LOCAL_TUNING.looseHorizonTicks;
  LX[0] = x; LY[0] = y; LZ[0] = z; LT[0] = 0;
  let n = 1;
  for (let t = 1; t <= horizon && n < MAX_SAMPLES; t++) {
    if (!rolling) {
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const d = k * sp * dt;
      vx -= d * vx;
      vz -= d * vz;
      vy -= g * dt + d * vy;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      if (y <= R) {
        y = R;
        if (-vy < rollVy) {
          vy = 0;
          rolling = true;
        } else {
          vy = -vy * rest;
          vx *= fric;
          vz *= fric;
        }
      }
    } else {
      const sp = Math.sqrt(vx * vx + vz * vz);
      if (sp > restSpeed) {
        const dec = (rollDecel + rollDamp * sp) * dt;
        const ns = sp > dec ? sp - dec : 0;
        vx *= ns / sp;
        vz *= ns / sp;
        x += vx * dt;
        z += vz * dt;
      } else {
        vx = 0;
        vz = 0;
      }
    }
    if (x > bx) { x = bx; vx = 0; } else if (x < -bx) { x = -bx; vx = 0; }
    if (z > bz) { z = bz; vz = 0; } else if (z < -bz) { z = -bz; vz = 0; }
    if (t % step === 0) {
      LX[n] = x; LY[n] = y; LZ[n] = z; LT[n] = t;
      n++;
    }
  }
  nSamples = n;
}

/**
 * Fill EFF for every slot of `side` (BIG for inactive players and the other side) for the current situation and
 * return the mode. Pure with respect to the state (writes module scratch only).
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
    SX = CX; SY = CY; SZ = CZ; ST = CT;
  } else if (mode === MODE_LOOSE) {
    buildLooseSamples(s);
    SX = LX; SY = LY; SZ = LZ; ST = LT;
  } else {
    nSamples = 0;
  }
  effSide = side;
  const dir = s.teams[side]!.dir;
  const carrierDepth = carrier >= 0 ? dir * s.players[carrier]!.x : 0;
  const reachH = mode === MODE_LOOSE ? LOCAL_TUNING.reachHeight : BIG;
  const pf = LOCAL_TUNING.pruneFactor;
  const topBound = T_PLAYER.topSpeedMax;
  const accHalf = 0.5 * T_PLAYER.accelMax * pf;
  const slack = T_PLAYER.arriveStop + LOCAL_TUNING.pruneSlack;
  for (let i = 0; i < NUM_SLOTS; i++) EFF[i] = BIG;
  const first = teamFirstSlot(side);
  const end = first + PLAYERS_PER_TEAM;
  for (let i = first; i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const busy = busyTicks(p);
    if (mode === MODE_BALL) {
      EFF[i] = ticksToReach(s, i, b.x, b.z) + busy;
      continue;
    }
    let eff = -1;
    const px = p.x;
    const pz = p.z;
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    const vCap = (sp > topBound ? sp : topBound) * pf;
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
      if (ticksToReach(s, i, SX[k]!, SZ[k]!) <= t) { eff = ST[k]!; break; }
    }
    if (eff < 0) {
      const L = nSamples - 1;
      eff = ST[L]! + ticksToReach(s, i, SX[L]!, SZ[L]!) + busy;
    }
    if (mode === MODE_CARRIER && dir * p.x < carrierDepth - LOCAL_TUNING.goalSideMargin) eff -= LOCAL_TUNING.goalSideBonusTicks;
    EFF[i] = eff;
  }
  return mode;
}

/** computeEff unless EFF already holds `side` for the switchTick call in progress. */
function effFor(s: SimState, side: number): void {
  if (effReuse && effSide === side) return;
  computeEff(s, side);
}

/** Lowest EFF among c's eligible candidates, excluding `exclude`; ties go to the lower slot. -1 if none. */
function pickBest(s: SimState, c: number, exclude: number, allowKeeper: boolean): number {
  const side = s.ctrl[c]!.side;
  const first = teamFirstSlot(side);
  const end = first + PLAYERS_PER_TEAM;
  let best = -1;
  let bestEff = BIG * 2;
  for (let i = first; i < end; i++) {
    if (i === exclude || !eligible(s, c, i, allowKeeper)) continue;
    const e = EFF[i]!;
    if (e < bestEff) { bestEff = e; best = i; }
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
  if (b.owner < 0 && b.heldBy < 0 && EFF[cur]! <= LOCAL_TUNING.aboutToReceiveTicks) return -1;
  return pickBest(s, c, cur, false);
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
      pick = pickBest(s, c, -1, false);
      if (pick < 0) pick = pickBest(s, c, -1, true);
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
  return pickBest(s, c, ctl.slot, false);
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
  return true;
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

/** Auto-switch rules for controller c (IN_PLAY, lock-out expired, defence context). EFF is computed here. */
function autoSwitchTick(s: SimState, c: number, ev: EventSink): void {
  const ctl = s.ctrl[c]!;
  const mode = autoModeOf(ctl);
  if (mode === AutoSwitch.OFF) return;
  const cur = ctl.slot;
  if (!activeOf(s, cur, ctl.side)) return;
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
    const best = pickBest(s, c, cur, false);
    if (best < 0) return;
    const eb = EFF[best]!;
    if (eb > LOCAL_TUNING.looseHorizonTicks) return; // nobody of ours gets there in time
    if (eb + autoMargin(effCur) < effCur) switchTo(s, c, best, ev);
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
  const best = pickBest(s, c, cur, false);
  if (best < 0) return;
  const effCur = EFF[cur]!;
  if (EFF[best]! + autoMargin(effCur) < effCur) switchTo(s, c, best, ev);
}

function autoMargin(effCur: number): number {
  const rel = LOCAL_TUNING.autoMarginFrac * effCur;
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
  } else if ((pressed & Btn.MOD_L) !== 0 && ctl.switchLockT <= MANUAL_HOLD) {
    manual = bestSwitchTarget(s, c, 0, 0);
  }
  if (manual >= 0) manualSwitch(s, c, manual, ev);
  else if (ctl.switchLockT === 0 && s.match.phase === MatchPhase.IN_PLAY) autoSwitchTick(s, c, ev);
  ctl.nextSwitch = canManualSwitch(s, c) ? bestSwitchTarget(s, c, 0, 0) : -1;
}

/** Debug / tests: the effective arrival (ticks) EFF computed for `side`, slot by slot, and the situation mode. */
export function debugSwitchEff(s: SimState, side: number, out: number[]): number {
  const mode = computeEff(s, side);
  for (let i = 0; i < NUM_SLOTS; i++) out[i] = EFF[i]!;
  return mode;
}
export const SWITCH_MODE = { BALL: MODE_BALL, CARRIER: MODE_CARRIER, LOOSE: MODE_LOOSE } as const;
/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const SWITCH_TUNING = LOCAL_TUNING;

/**
 * [RUL-06] Penalties in play - taker on the spot, keeper on the line, everyone else outside the area and arc; aim + shoot/finesse/chip; keeper moves along the line and dives (right stick); after the kick play continues (IN_PLAY).
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 *
 * Implementation notes (RUL-06):
 *  - Flow: RUL-09 awards PENALTY through RUL-11 awardRestart (spot = penalty mark of the end the team attacks, every
 *    action interrupted, RESTART_AWARDED + WHISTLE) which calls penaltySetup, then RUL-11 restartTick runs the setup
 *    delay (T_RULES.restartSetupTicks, camera cut): at ready it legalizes positions (everyone but the taker and the
 *    defending keeper outside the penalty area and the arc, the keeper on his line between the posts, the taker
 *    behind the ball) and puts the taker into SET_PIECE (waiting, facing restart.aimX/aimZ). When the taker plays the
 *    ball, core/kick applyKick marks restart.taken and RUL-01 returns to IN_PLAY in the same tick: the ball is live
 *    and rebounds (keeper parries, posts) are played on like any other loose ball. RUL-01 never ends a half during a
 *    PENALTY phase, and a shot in flight defers the period end afterwards.
 *  - Setup (penaltySetup): ball still on the penalty mark of the attacked end (team.dir), restart.x/z = the mark;
 *    taker = best penalty taker (pickPenaltyTaker: finishing + composure, shot power breaks ties, outfield players
 *    who are not down first, the keeper last); aim on the goal centre (restart.aimX = goal line, aimZ = 0); dive choice
 *    cleared (restart.side = 0, aimPower = 0). TAI-13 walks everybody else to legal spots during the setup delay,
 *    GKP-06 the defending keeper to his line centre; penaltyTick walks the taker to his spot (RUL-11
 *    restartTakerSpot) so RUL-11 rarely teleports anyone at ready.
 *  - Taker input (SETPIECE_INPUT[PENALTY]; SIM-15 routes every controller's frame here during PENALTY; SIM-16 gives
 *    the taking side's controller the taker), once restart.ready and while the taker waits (not yet kicking):
 *      left stick aims: restart.aimX/aimZ = where the stick's ray from the spot meets the goal line, |z| clamped to
 *      aimMaxZ inside the posts (a stick with less than aimMinForward of its length toward the goal aims at the corner
 *      on its side); the aim persists when the stick is released (the waiting taker faces it). SHOOT press ->
 *      SIM-11 startShot(PENALTY), R1 + SHOOT -> SHOT_FINESSE, L1 + SHOOT -> SHOT_CHIP, L1 + R1 + SHOOT -> SHOT_POWER;
 *      ReqFlag.SET_PIECE (+ CPU for CPU brains), req.dir = unit vector spot -> aim point, hasTarget = 1 at the aim point,
 *      curve from frame.curve, power from the frame's explicit power or charging = 1 (SIM-15 adoptCharge attaches the
 *      power bar to SHOOT: hold = power). Touch: SWIPE toward the goal = penalty along the swipe (gdx/gdz; the gesture
 *      point when the swipe carries no direction), gPower = power ("faster is harder to save and less accurate": SIM-11's
 *      error grows with power above T_SHOT.errorPowerKnee); CURVED_SWIPE = finesse with gCurve; BACK_FORTH_SWIPE = power
 *      shot; TAP / DOUBLE_TAP on the goal (GestureFlag.ON_GOAL) = chip at that point. A swipe away from the goal is
 *      ignored. The same controls as RUL-07's shoot-out kicks (same T_PENALTY values).
 *  - Keeper input (the defending side's HUMAN controller holding the defending keeper; SIM-16 hands him over at
 *    penalties), once ready and until the kick is struck (also while the taker winds up):
 *      left stick moves him along his line (|z| <= keeperMaxZ at keeperStickFrac of the stick, easing into the limit
 *      over keeperBrakeDist, facing the ball; penaltyTick clamps a keeper beyond keeperMaxZ). A right-stick flick
 *      (Btn.RS_FLICK edge + ax/az), a swipe (gdx/gdz) or a tap (gz) commits a dive direction, the latest choice before
 *      the kick wins. Storage (read by GKP-06 humanDiveChoice at the kick's contact tick; penaltyDiveChoice reads it):
 *        restart.side     = dive side in pitch z: -1 toward -z, +1 toward +z, 0 = none / stay in the middle;
 *        restart.aimPower = height class: 0 low, 1 mid, 2 high (DiveHeight; 0 when no choice was made).
 *      Flick / swipe: lateral share >= diveSideShare picks the side; the share along the attack direction (toward the
 *      goal line, "up" behind the keeper) >= diveHeightShare is high, toward the taker is low, else mid. Tap: the side
 *      of the keeper the tap lies on beyond diveTapBand (else the middle), mid height. CPU and team-AI keepers (frames
 *      from CPU brains are not applied to the keeper) dive by GKP-06's own choice. RUL-11 fillRestart clears the
 *      choice at every award, so a choice never carries over to the next penalty.
 *  - Tick (penaltyTick): aim kept on the goal line; before ready the taker walks to his spot; once ready the waiting
 *    taker turns toward his aim (faceGain per tick: SIM-04 does not turn a LOCKED player, so the SET_PIECE handler's
 *    lookAt alone never turns him) and a defending keeper not in an action is kept within |z| <= keeperMaxZ; a side with no human takes the kick by Default
 *    cpuGraceTicks after T_RULES.cpuRestartDelay past ready (retried every cpuRetryTicks) if its CPU brain (TAI-13)
 *    has not, so RUL-11's 4 s CPU watchdog never fires; a human side whose Default (RUL-11, at the 12 s timeout) did
 *    not start is retried every tick until RUL-11's forced kick is due. restart.aimPower is never used for the power
 *    bar here (it holds the dive height; the HUD reads ctrl.power).
 *  - Default (RUL-11 calls it at the human timeout; also the CPU fallback): keep the aim the taker set, else a corner
 *    chosen by s.rng (defaultInsetMin..Max inside a post); SIM-11 startShot(PENALTY) at defaultPower (no charging).
 *    Never while the taker is already kicking or down.
 *  - Exports beyond the stub: LOCAL_TUNING (= T_PENALTY), DiveHeight, PenaltyDiveChoice / createPenaltyDiveChoice,
 *    penaltyDiveChoice, penaltySpot, pickPenaltyTaker, penaltyKeeper, penaltyAimFromDir, penaltyDiveFromDir.
 *    No per-player choice tick is stored (no free state field; GKP-06 only needs the latest choice at contact).
 * Determinism: s.rng only in the Default aim. Per-tick work is O(1) (setup: O(11)); allocation-free (module scratch
 * V / PT / REQ; tests/perf/rul-06-budget.test.ts measures ~0.1 us and 0 bytes per tick).
 */
import {
  BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, GestureFlag, UNIT_SCALE, type InputFrame } from '../../contracts/input';
import { MoveMode, type ControllerState, type PlayerState, type SimState } from '../../contracts/state';
import { createActionRequest, ReqFlag } from '../../contracts/systems';
import { T_INPUT, T_PLAYER, T_RULES, T_PENALTY } from '../../contracts/tuning';
import { releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import { rngInt, rngRange } from '../core/rng';
import { startShot } from '../kicks/shot';
import { isValidTaker, prepareTakerKick, restartTakerSpot } from './restart';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_PENALTY. */
export const LOCAL_TUNING = T_PENALTY;

const LT = T_PENALTY;

/** Dive height classes stored in restart.aimPower (GKP-06 humanDiveChoice). */
export const DiveHeight = {
  LOW: 0,
  MID: 1,
  HIGH: 2,
} as const;

/** The human keeper's stored dive choice: dir = side in pitch z (-1, 0 = none / middle, +1), height = DiveHeight. */
export interface PenaltyDiveChoice { dir: number; height: number }

export function createPenaltyDiveChoice(): PenaltyDiveChoice {
  return { dir: 0, height: 0 };
}

// ---------------------------------------------------------------- module scratch (rewritten before every use)

const REQ = createActionRequest();
/** Direction / point under work (doubles cross calls through this object, never as arguments on per-tick paths). */
const V = { x: 0, z: 0 };
const PT = { x: 0, z: 0 };

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS;
}

/** A penalty is pending: PENALTY phase with its record, not yet taken. */
function penaltyLive(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.PENALTY && m.restart.kind === RestartKind.PENALTY && m.restart.taken === 0;
}

/** Attack direction of the penalty-taking team (+1: the goal at x = +52.5). */
function attackDir(s: SimState): number {
  return s.teams[s.match.restart.team === 1 ? 1 : 0]!.dir >= 0 ? 1 : -1;
}

function isDown(p: Readonly<PlayerState>): boolean {
  return p.stunT > 0 || p.act === ActionKind.STUMBLE || p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP;
}

/** Waiting states of the taker in which a new kick may start (never while kicking or down). */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  return p.active === 1 && p.stunT <= 0 && (p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE);
}

function isSwipe(g: number): boolean {
  return g === GestureKind.SWIPE || g === GestureKind.CURVED_SWIPE || g === GestureKind.BACK_FORTH_SWIPE;
}

/** Ball at rest on (x, z): possession, hands and net state cleared (a placement, not a touch). */
function placeBall(s: SimState, x: number, z: number, ev: EventSink): void {
  releasePossession(s, ev);
  const b = s.ball;
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

// ---------------------------------------------------------------- queries

/** Penalty mark of the end `team` attacks, into out. */
export function penaltySpot(s: SimState, team: number, out: { x: number; z: number }): void {
  const dir = s.teams[team === 1 ? 1 : 0]!.dir >= 0 ? 1 : -1;
  out.x = dir * (HALF_LENGTH - PENALTY_SPOT_DIST);
  out.z = 0;
}

/** The keeper defending the current penalty (the other team's keeperSlot when active and a keeper), -1 if none. */
export function penaltyKeeper(s: SimState): number {
  const def = s.match.restart.team === 1 ? 0 : 1;
  const k = s.teams[def]!.keeperSlot;
  if (!validSlot(k)) return -1;
  const p = s.players[k]!;
  return p.active === 1 && p.isKeeper === 1 && p.team === def ? k : -1;
}

/**
 * Best penalty taker of `team`: highest finishing + composure (shot power breaks ties, then the lower slot) among
 * active outfield players who are not down; then anyone active (down players, the keeper last). -1 if nobody.
 */
export function pickPenaltyTaker(s: SimState, team: number): number {
  const first = teamFirstSlot(team === 1 ? 1 : 0);
  for (let pass = 0; pass < 2; pass++) {
    let best = -1;
    let bestScore = -1e18;
    for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
      const p = s.players[slot]!;
      if (p.active !== 1) continue;
      if (pass === 0 && (p.isKeeper === 1 || isDown(p))) continue;
      const a = s.attrs[slot]!;
      const score = a.finishing + a.composure + a.shotPower / 1000 - (p.isKeeper === 1 ? 1000 : 0);
      if (score > bestScore) { bestScore = score; best = slot; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * The human keeper's stored dive choice for the current penalty (restart.side / restart.aimPower) into out. Returns 1
 * while a penalty is pending (PENALTY phase, not yet taken), else 0 (out still filled from the record).
 */
export function penaltyDiveChoice(s: SimState, out: PenaltyDiveChoice): number {
  const r = s.match.restart;
  out.dir = r.side > 0 ? 1 : r.side < 0 ? -1 : 0;
  const h = r.aimPower;
  out.height = h >= LT.aimHighFrom ? DiveHeight.HIGH : h >= LT.aimMidFrom ? DiveHeight.MID : DiveHeight.LOW;
  return penaltyLive(s) ? 1 : 0;
}

// ---------------------------------------------------------------- aim and dive from directions (V)

/** Aim along V (pitch space): restart.aimX/aimZ = where the ray from the spot meets the goal line. 1 if aimed. */
function aimAlongV(s: SimState): number {
  const r = s.match.restart;
  const end = attackDir(s);
  const d = Math.sqrt(V.x * V.x + V.z * V.z);
  if (!(d > 1e-6)) return 0;
  const fwd = (end * V.x) / d;
  const lat = V.z / d;
  let z: number;
  if (fwd > LT.aimMinForward) z = r.z + (lat / fwd) * (HALF_LENGTH - end * r.x);
  else z = lat > 0 ? LT.aimMaxZ : lat < 0 ? -LT.aimMaxZ : 0;
  r.aimX = end * HALF_LENGTH;
  r.aimZ = clamp(z, -LT.aimMaxZ, LT.aimMaxZ);
  return 1;
}

/** Dive choice from V (pitch space): restart.side / restart.aimPower. */
function diveAlongV(s: SimState): void {
  const d = Math.sqrt(V.x * V.x + V.z * V.z);
  if (!(d > 1e-6)) return;
  const r = s.match.restart;
  const lat = V.z / d;
  const lon = (attackDir(s) * V.x) / d;
  r.side = lat >= LT.diveSideShare ? 1 : lat <= -LT.diveSideShare ? -1 : 0;
  r.aimPower = lon >= LT.diveHeightShare ? DiveHeight.HIGH : lon <= -LT.diveHeightShare ? DiveHeight.LOW : DiveHeight.MID;
}

/** Aim the current penalty along the pitch-space direction (dx, dz) (as the stick / a swipe does). 1 if aimed. */
export function penaltyAimFromDir(s: SimState, dx: number, dz: number): number {
  V.x = dx;
  V.z = dz;
  return aimAlongV(s);
}

/** Store the dive choice of a flick / swipe along the pitch-space direction (dx, dz) (restart.side / aimPower). */
export function penaltyDiveFromDir(s: SimState, dx: number, dz: number): void {
  V.x = dx;
  V.z = dz;
  diveAlongV(s);
}

/** The aim point always lies on the attacked goal line inside the posts (re-seeded on the centre when foreign). */
function keepAimOnGoal(s: SimState): void {
  const r = s.match.restart;
  const gx = attackDir(s) * HALF_LENGTH;
  if (r.aimX !== gx || !(r.aimZ === r.aimZ)) { r.aimX = gx; r.aimZ = 0; }
  if (r.aimZ > LT.aimMaxZ) r.aimZ = LT.aimMaxZ;
  else if (r.aimZ < -LT.aimMaxZ) r.aimZ = -LT.aimMaxZ;
}

// ---------------------------------------------------------------- kicks

function resetReq(assist: AssistLevel, flags: number): void {
  REQ.power = 0;
  REQ.charging = 0;
  REQ.dirX = 0;
  REQ.dirZ = 0;
  REQ.targetSlot = -1;
  REQ.hasTarget = 0;
  REQ.targetX = 0;
  REQ.targetZ = 0;
  REQ.curve = 0;
  REQ.assist = assist;
  REQ.flags = ReqFlag.SET_PIECE | flags;
}

/**
 * Start the taker's shot of `kind` from REQ (power / charging / curve / flags set) at the current aim point: ends his
 * SET_PIECE wait (RUL-11 prepareTakerKick), turns him along the kick, calls SIM-11 startShot. 1 if started (if refused,
 * RUL-11 puts him back into SET_PIECE next tick).
 */
function startKick(s: SimState, t: number, kind: KickKind, ev: EventSink): number {
  const r = s.match.restart;
  keepAimOnGoal(s);
  const dx = r.aimX - r.x, dz = r.aimZ - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  REQ.dirX = d > 1e-6 ? dx / d : attackDir(s);
  REQ.dirZ = d > 1e-6 ? dz / d : 0;
  REQ.hasTarget = 1;
  REQ.targetX = r.aimX;
  REQ.targetZ = r.aimZ;
  REQ.targetSlot = -1;
  if (prepareTakerKick(s, t) !== 1) return 0;
  const p = s.players[t]!;
  p.fx = REQ.dirX;
  p.fz = REQ.dirZ;
  return startShot(s, t, kind, REQ, ev) === 1 ? 1 : 0;
}

function shotKindFor(buttons: number): KickKind {
  const l = (buttons & Btn.MOD_L) !== 0;
  const rr = (buttons & Btn.MOD_R) !== 0;
  if (l && rr) return KickKind.SHOT_POWER;
  if (rr) return KickKind.SHOT_FINESSE;
  if (l) return KickKind.SHOT_CHIP;
  return KickKind.PENALTY;
}

/** Default aim: keep an aim the taker set away from the centre, else a corner chosen by s.rng. */
function chooseDefaultAim(s: SimState): void {
  const r = s.match.restart;
  keepAimOnGoal(s);
  if (r.aimZ > 0.01 || r.aimZ < -0.01) return;
  const side = rngInt(s.rng, 2) === 0 ? -1 : 1;
  r.aimZ = side * (GOAL_HALF_WIDTH - rngRange(s.rng, LT.defaultInsetMin, LT.defaultInsetMax));
}

/** Default kick (human timeout / CPU fallback). 1 if the kick started. */
function takeDefault(s: SimState, ev: EventSink): number {
  if (!penaltyLive(s)) return 0;
  const r = s.match.restart;
  const t = r.taker;
  if (!isValidTaker(s, t) || !takerWaiting(s.players[t]!)) return 0; // RUL-11 re-picks; no double kick
  chooseDefaultAim(s);
  resetReq(AssistLevel.ASSISTED, 0);
  REQ.power = LT.defaultPower;
  return startKick(s, t, KickKind.PENALTY, ev);
}

// ---------------------------------------------------------------- input

function takerInput(s: SimState, c: ControllerState, f: Readonly<InputFrame>, ev: EventSink): void {
  const r = s.match.restart;
  const t = r.taker;
  if (!takerWaiting(s.players[t]!)) return; // kicking already (power bar) or down
  const cpu = c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0;
  const idle = T_INPUT.stickIdle;
  if (c.mx * c.mx + c.mz * c.mz > idle * idle) {
    V.x = c.mx;
    V.z = c.mz;
    aimAlongV(s);
  }
  const g = f.gesture;
  if (isSwipe(g)) {
    V.x = f.gdx;
    V.z = f.gdz;
    if (V.x === 0 && V.z === 0) {
      V.x = f.gx / GESTURE_POS_SCALE - r.x;
      V.z = f.gz / GESTURE_POS_SCALE - r.z;
    }
    if (attackDir(s) * V.x <= 0) return; // not toward the goal
    aimAlongV(s);
    resetReq(c.assist, ReqFlag.GESTURE | cpu);
    REQ.power = f.gPower > 0 ? clamp(f.gPower / UNIT_SCALE, 0, 1) : LT.gesturePower;
    if (g === GestureKind.CURVED_SWIPE) REQ.curve = clamp(f.gCurve / AXIS_SCALE, -1, 1);
    const kind = g === GestureKind.CURVED_SWIPE ? KickKind.SHOT_FINESSE
      : g === GestureKind.BACK_FORTH_SWIPE ? KickKind.SHOT_POWER : KickKind.PENALTY;
    startKick(s, t, kind, ev);
    return;
  }
  if ((g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) && (f.gFlags & GestureFlag.ON_GOAL) !== 0) {
    r.aimX = attackDir(s) * HALF_LENGTH;
    r.aimZ = clamp(f.gz / GESTURE_POS_SCALE, -LT.aimMaxZ, LT.aimMaxZ);
    resetReq(c.assist, ReqFlag.GESTURE | cpu);
    REQ.power = f.gPower > 0 ? clamp(f.gPower / UNIT_SCALE, 0, 1) : LT.chipTapPower;
    startKick(s, t, KickKind.SHOT_CHIP, ev);
    return;
  }
  const pressed = c.buttons & ~c.prevButtons;
  if ((pressed & Btn.SHOOT) === 0) return;
  resetReq(c.assist, cpu);
  if (f.power > 0) REQ.power = clamp(f.power / UNIT_SCALE, 0, 1);
  else REQ.charging = 1; // the resolver attaches the power bar to SHOOT (adoptCharge): hold = power
  REQ.curve = clamp(f.curve / AXIS_SCALE, -1, 1);
  startKick(s, t, shotKindFor(c.buttons), ev);
}

function keeperInput(s: SimState, c: ControllerState, f: Readonly<InputFrame>): void {
  const k = penaltyKeeper(s);
  if (k < 0 || c.slot !== k) return;
  const r = s.match.restart;
  const p = s.players[k]!;
  const pressed = c.buttons & ~c.prevButtons;
  const g = f.gesture;
  if ((pressed & Btn.RS_FLICK) !== 0) {
    V.x = f.ax;
    V.z = f.az;
    diveAlongV(s);
  } else if (isSwipe(g)) {
    V.x = f.gdx;
    V.z = f.gdz;
    diveAlongV(s);
  } else if (g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) {
    const gz = f.gz / GESTURE_POS_SCALE;
    r.side = gz > p.z + LT.diveTapBand ? 1 : gz < p.z - LT.diveTapBand ? -1 : 0;
    r.aimPower = DiveHeight.MID;
  }
  // Left stick: along his line only, facing the ball.
  if (p.active !== 1 || p.act !== ActionKind.NONE || p.stunT > 0) return;
  const idle = T_INPUT.stickIdle;
  if (c.mz * c.mz <= idle * idle) return; // the resolver has already stopped a stale stick intent
  let iz = c.mz * LT.keeperStickFrac;
  const room = iz > 0 ? LT.keeperMaxZ - p.z : LT.keeperMaxZ + p.z;
  iz *= clamp(room / LT.keeperBrakeDist, 0, 1); // ease into the limit
  p.moveMode = MoveMode.DIRECT;
  p.ix = 0;
  p.iz = iz;
  p.wantSprint = 0;
  p.lookAt = 1;
  p.lookX = r.x;
  p.lookZ = r.z;
}

// ---------------------------------------------------------------- tick helpers

/** Before ready: the waiting taker walks to his spot behind the ball (RUL-11 places him exactly at ready). */
function walkTaker(s: SimState): void {
  const t = s.match.restart.taker;
  if (!validSlot(t)) return;
  const p = s.players[t]!;
  if (p.active !== 1 || p.act !== ActionKind.NONE || p.stunT > 0) return;
  restartTakerSpot(s, PT);
  const dx = PT.x - p.x, dz = PT.z - p.z;
  const d2 = dx * dx + dz * dz;
  if (d2 <= LT.walkStop * LT.walkStop) {
    if (p.moveMode === MoveMode.ARRIVE) p.moveMode = MoveMode.STOP;
    return;
  }
  const a = s.attrs[t]!;
  const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  const far = d2 > LT.walkSprintDist * LT.walkSprintDist;
  p.moveMode = MoveMode.ARRIVE;
  p.tgtX = PT.x;
  p.tgtZ = PT.z;
  p.tgtSpeed = far ? top : top * T_PLAYER.jogFraction;
  p.wantSprint = far ? 1 : 0;
  p.lookAt = 0;
}

/** Ready, waiting: the taker (in SET_PIECE) turns toward his aim point, a fraction faceGain per tick (no trig). */
function faceAim(s: SimState): void {
  const r = s.match.restart;
  const t = r.taker;
  if (!validSlot(t)) return;
  const p = s.players[t]!;
  if (p.active !== 1 || p.act !== ActionKind.SET_PIECE) return;
  const dx = r.aimX - p.x, dz = r.aimZ - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > 1e-6)) return;
  const g = LT.faceGain;
  const fx = p.fx + (dx / d - p.fx) * g;
  const fz = p.fz + (dz / d - p.fz) * g;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-6)) return;
  p.fx = fx / fl;
  p.fz = fz / fl;
}

/** Ready, before the kick: the defending keeper (when not in an action) stays within |z| <= keeperMaxZ. */
function holdKeeper(s: SimState): void {
  const k = penaltyKeeper(s);
  if (k < 0) return;
  const p = s.players[k]!;
  if (p.act !== ActionKind.NONE) return;
  if (p.z > LT.keeperMaxZ) {
    p.z = LT.keeperMaxZ;
    if (p.vz > 0) p.vz = 0;
  } else if (p.z < -LT.keeperMaxZ) {
    p.z = -LT.keeperMaxZ;
    if (p.vz < 0) p.vz = 0;
  }
}

// ---------------------------------------------------------------- restart API

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function penaltySetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.PENALTY) return;
  const team = r.team === 1 ? 1 : 0;
  penaltySpot(s, team, PT);
  r.x = PT.x;
  r.z = PT.z;
  placeBall(s, PT.x, PT.z, ev);
  r.aimX = (s.teams[team]!.dir >= 0 ? 1 : -1) * HALF_LENGTH;
  r.aimZ = 0;
  r.aimPower = 0;
  r.aimCurve = 0;
  r.side = 0;
  r.taker = pickPenaltyTaker(s, team);
}

/** Per tick while the phase is active. */
export function penaltyTick(s: SimState, ev: EventSink): void {
  if (!penaltyLive(s)) return;
  const r = s.match.restart;
  keepAimOnGoal(s);
  if (r.ready !== 1) {
    walkTaker(s);
    return;
  }
  faceAim(s);
  holdKeeper(s);
  if (!teamHasHuman(s, r.team)) {
    // A side without a human: its CPU brain (TAI-13) normally kicks ~1 s after ready; fall back to the Default.
    const waited = r.t - T_RULES.restartSetupTicks;
    const due = T_RULES.cpuRestartDelay + LT.cpuGraceTicks;
    if (waited >= due && (waited - due) % LT.cpuRetryTicks === 0) takeDefault(s, ev);
  } else if (r.timeoutT < 0) {
    takeDefault(s, ev); // RUL-11's Default at the 12 s timeout did not start: retry until its forced kick is due
  }
}

/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function penaltyInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  if (!penaltyLive(s)) return;
  if (!(ctrlIdx >= 0 && ctrlIdx < s.ctrl.length)) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || (c.side !== 0 && c.side !== 1)) return;
  const r = s.match.restart;
  if (r.ready !== 1) return;
  if (c.side === r.team) {
    if (validSlot(r.taker) && c.slot === r.taker && isValidTaker(s, r.taker)) takerInput(s, c, f, ev);
    return;
  }
  if (c.kind === ControllerKind.HUMAN) keeperInput(s, c, f); // CPU / AI keepers: GKP-06 chooses the dive
}

/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function penaltyDefault(s: SimState, ev: EventSink): void {
  takeDefault(s, ev);
}

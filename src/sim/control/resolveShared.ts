/**
 * [SIM-15] Shared constants, scratch and pure helpers for action input resolution (resolve.ts and the
 * resolve*.ts helpers). Everything that must persist between ticks lives in SimState (s.ctrl[c] fields); module
 * scratch here is either constant or rewritten every tick before it is read (never carried across ticks).
 *
 * Controller field use (ControllerState, all [SIM-15]):
 *  - buttons / prevButtons / holdT / pressTick / releaseTick / mx / mz / stickIdleT: edge tracking (resolve.ts).
 *  - bufAction / bufArg / bufExpire: one buffered input (newest wins). bufAction % 16 = BufCode; the rest of
 *    bufAction and bufArg are radix-packed integers (exact doubles, < 2^53), see pack* below.
 *  - powerBtn: Btn bit of the button charging the power bar (0 = none); power: 0..1 HUD mirror.
 *  - seqA: bits 0..7 = SeqFlag bits; bits 8..12 = charging slot + 1 (0 = none); bits 13..27 = for PASS, LOB and
 *    THROUGH (5 bits each, in that order) the controlled slot + 1 at that button's latest press (0 = none), so a
 *    double tap never spans a change of controlled player (see isDoubleTap / recordPressSlots).
 *  - seqB: tick until which a timed second-defender call / gesture press stays active.
 *  - secondDef: called second defender (TAI-05 reads it); receiver: controlled receiver auto-collecting (-1 none).
 */
import { HALF_LENGTH, NUM_CONTROLLERS, NUM_SLOTS, TICK_HZ } from '../../contracts/constants';
import { ControllerKind, KickKind } from '../../contracts/enums';
import { Btn } from '../../contracts/input';
import type { ControllerState, PlayerState, SimState } from '../../contracts/state';
import { createActionRequest, ReqFlag, type ActionRequest } from '../../contracts/systems';
import { T_BALL, T_INPUT, T_PASS, T_PLAYER, T_SHOT } from '../../contracts/tuning';

export const LOCAL_TUNING = {
  /** A tapped kick (released before T_INPUT.tapTicks) of the ball at the kicker's feet that a second press can still
   *  convert (PASS,PASS dinked; LOB,LOB ground cross; THROUGH,THROUGH dinked; SHOOT then SHOOT low driven; a lob or
   *  shot faked by PASS) keeps charging, power frozen, until this many ticks after its press. Derived from
   *  T_INPUT.doubleTapTicks so the whole double-tap window converts (a second press at exactly doubleTapTicks is
   *  resolved before the grace ends on that tick), ticks. */
  tapGraceTicks: T_INPUT.doubleTapTicks,
  /** After releasing a held SHOOT, a second SHOOT press within this many ticks still makes a low driven shot. */
  lowDrivenGraceTicks: 4,
  /** A held button auto-releases its charge this many ticks after the bar is full (no stuck power bar), ticks. */
  chargeAfterFullTicks: 24,
  /** Max ticks a pass/shot press made while the ball travels to the player waits for it (first-time), ticks. */
  firstTimeWaitTicks: 120,
  /** A first-time press whose ball has arrived but whose player is busy (first touch) still fires within, ticks. */
  pendingBusyTicks: 16,
  /** Start a first-time kick when the ball is this many ticks beyond the kind's wind-up away, ticks. */
  firstTimeLeadTicks: 1,
  /** Max ball height for a first-time foot kick start (higher balls wait for the aerial window), m. */
  firstTimeMaxHeight: 0.8,
  /** The loose ball is "arriving" when its path passes within this distance of the player, m ... */
  receiveLane: 1.6,
  /** ... or within this distance for the intended receiver of our pass, m. */
  receiveLaneTarget: 5.0,
  /** Ball within this horizontal distance of the player counts as in reach, m. */
  reachRadius: 1.2,
  /** Slower loose balls are not "arriving", m/s. */
  arriveMinSpeed: 0.8,
  /** Loose ball: the player is the attacker if he is at most this much farther from it than the nearest opponent, m. */
  looseAttackMargin: 0.5,
  /** Own third: progress (-1 own goal line .. +1 opposition line) below which SHOOT on an arriving ball clears. */
  ownThirdProgress: -1 / 3,
  /** SHOOT clears a loose ball arriving within this many ticks (own third), ticks. */
  clearArriveTicks: 30,
  /** Header vs volley when aerialChance does not say (1 header / 2 volley): ball height threshold, m. */
  volleyMaxHeight: 1.2,
  /** The receiver auto-collecting a pass meets the ball's track at most this far ahead, s. */
  receiveLookAheadSec: 2,
  /** Sampling step along the ball track for the receiver's meeting point, s. */
  meetStepSec: 0.125,
  /** Contain (PASS held in defence): shadow distance goal-side of the carrier, m. */
  containDist: 2.0,
  /** Sprint held with the stick idle presses a carrier within this distance, m. */
  sprintPressDist: 10.0,
  /** Press target distance goal-side of the carrier, m. */
  pressDist: 1.0,
  /** Auto-jockey: stick moving without sprint within this distance of the carrier while goal-side, m. */
  autoJockeyDist: 5.0,
  /** Shield looks at the nearest opponent within this distance, m. */
  shieldLookDist: 8.0,
  /** Controlled sprint (MOD_R held with the ball): stick magnitude scale with sprint requested (0..1). */
  controlledSprintScale: 0.8,
  /** Stop ball / stop and face goal need the dribbler moving faster than this, m/s. */
  stopMinSpeed: 1.5,
  /** Stop ball fires when the stick was released at most this many ticks ago with SPRINT held, ticks. */
  stopReleaseWindow: 3,
  /** Stop and face goal needs MOD_L held this long with the stick released (a quicker L1+face is a combo), ticks. */
  stopHoldTicks: 5,
  /** A second defender called by a tap (or the double-tap gesture) keeps pressing this long, ticks. */
  secondDefTapTicks: 90,
  /** Gesture "tap the carrier": the controlled player presses him this long unless the stick moves, ticks. */
  gesturePressTicks: 90,
  /** Tackle choice: goal-side when cos(defender dir from carrier, carrier->own goal) >= this. */
  goalSideCos: 0.3,
  /** Tackle choice: chasing (push/pull) when that cosine <= this. */
  chaseCos: -0.2,
  /** Shoulder challenge: alongside within this distance, m ... */
  shoulderMaxDist: 1.6,
  /** ... with |sin| of the offset to the carrier's run at least this ... */
  shoulderSideMin: 0.7,
  /** ... both running the same way (cos of the velocities) at least this ... */
  shoulderParallelMin: 0.5,
  /** ... and the carrier faster than this, m/s. */
  shoulderMinSpeed: 2.0,
  /** Gesture tap more than this far ahead (attack direction) of the teammate = through ball into space, m. */
  tapThroughLead: 1.5,
  /** Gesture tap on space: the nearest teammate within this distance of the point is the target, m. */
  tapSpaceRadius: 12,
  /** Gesture pass power = distance / this, clamped to [gesturePassMinPower, 1], m. */
  gesturePassFullDist: 45,
  gesturePassMinPower: 0.2,
  /** Gesture shot power when the swipe carries none (0..1). */
  gestureShotDefaultPower: 0.6,
  /** A swipe is "toward goal" when cos(swipe, direction to the goal centre) >= this. */
  swipeGoalCos: 0.35,
  /** Crossing-zone double-tap within this distance of a post's cross spot crosses to that post, m. */
  crossPostRadius: 9,
  /** Cross spot depth off the goal line, m. */
  crossPostDepth: 5,
} as const; // TUNING-CR

export const LT = LOCAL_TUNING;

// ---------------------------------------------------------------- small enums (plain objects; no const enums)

/** Control context of the controlled player for button meaning. */
export const Ctx = {
  ATTACK: 0,
  DEFENCE: 1,
  /** Controlled keeper holding the ball in hands. */
  KEEPER: 2,
} as const;

/** Result of an attempt to turn an input into an action. */
export const Res = {
  /** Nothing to do (consumed or not applicable): clear any buffer. */
  DROP: -1,
  /** Could not act now: buffer for T_INPUT.bufferTicks. */
  RETRY: 0,
  STARTED: 1,
  /** Waiting for an incoming ball (first-time): buffer up to LT.firstTimeWaitTicks. */
  PENDING: 2,
} as const;

/** Buffered input kinds (ctrl.bufAction % 16). Face buttons are their tracked bit index + 1. */
export const BufCode = {
  NONE: 0,
  PASS: 1,
  SHOOT: 2,
  LOB: 3,
  THROUGH: 4,
  SKILL: 5,
  KNOCK_ON: 6,
  GESTURE: 7,
} as const;

/** ctrl.seqA flag bits. */
export const SeqFlag = {
  /** STOP_BALL fired during this SPRINT hold / stick release. */
  STOP_SPRINT: 1,
  /** STOP_FACE_GOAL fired during this MOD_L hold (also suppresses the trigger-run tap). */
  STOP_MODL: 2,
  /** Second defender called for a while (until seqB) by a MOD_R tap or the double-tap gesture. */
  SD_TIMED: 4,
  /** Gesture press on the carrier (until seqB); also calls the second defender. */
  GPRESS: 8,
} as const;

/** Tracked button bit indices. */
export const BI = { PASS: 0, SHOOT: 1, LOB: 2, THROUGH: 3, MOD_L: 4, MOD_R: 5, SHIELD: 6, SPRINT: 7 } as const;

export const FACE_MASK = Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH;
export const BTN_MASK = (1 << 11) - 1;

/** Press-record flag bits. */
export const PressFlag = { DOUBLE: 1, PENDING: 2 } as const;

// ---------------------------------------------------------------- scratch

/** pressTick of each tracked button BEFORE this tick's edge update, [c * 8 + bit] (rewritten every tick). */
export const PREV_PRESS = new Float64Array(NUM_CONTROLLERS * 8);
/** The one ActionRequest the resolver hands to starters (never retained by them). */
export const REQ: ActionRequest = createActionRequest();

// ---------------------------------------------------------------- buffer / packing

/** Unpacked face press record (scratch; valid until the next unpackPress). */
export const PR = { mods: 0, cls: 0, power: 0, curve: 0, flags: 0 };

/** mods: 1 = MOD_L, 2 = MOD_R held at the face press. power 0..127 explicit (0 = from hold). curve -127..127. */
export function packPress(mods: number, cls: number, power: number, curve: number, flags: number): number {
  return mods + 16 * (cls + 4 * (power + 128 * ((curve + 127) + 255 * flags)));
}

const PRESS_FLAG_UNIT = 16 * 4 * 128 * 255;

/** PressFlag bits of a packed press record. */
export function pressFlags(v: number): number { return Math.floor(v / PRESS_FLAG_UNIT); }

/** The packed press record with `flag` added. */
export function withPressFlag(v: number, flag: number): number {
  return (pressFlags(v) & flag) !== 0 ? v : v + flag * PRESS_FLAG_UNIT;
}

export function unpackPress(v: number): void {
  let r = v;
  PR.mods = r % 16; r = (r - PR.mods) / 16;
  PR.cls = r % 4; r = (r - PR.cls) / 4;
  PR.power = r % 128; r = (r - PR.power) / 128;
  const c = r % 255; r = (r - c) / 255;
  PR.curve = c - 127;
  PR.flags = r;
}

/** Unpacked gesture record (scratch). gx/gz in decimetres. */
export const GR = { kind: 0, gSlot: -1, gx: 0, gz: 0, gdx: 0, gdz: 0, gPower: 0, gCurve: 0, gFlags: 0, cls: 0 };

/** Pack a gesture into [bufAction, bufArg] (writes ctl.bufAction / bufArg). */
export function packGesture(ctl: ControllerState, g: typeof GR): void {
  ctl.bufAction = BufCode.GESTURE + 16 * ((g.gCurve + 128) + 256 * ((g.gFlags & 7) + 8 * (g.gPower + 128 * g.cls)));
  ctl.bufArg = g.kind + 8 * ((g.gSlot + 1) + 32 * ((g.gx + 1024) + 2048 * ((g.gz + 1024) + 2048 * ((g.gdx + 128) + 256 * (g.gdz + 128)))));
}

/** Unpack ctl's buffered gesture into GR (reads the fields directly: the packed values exceed the Smi range). */
export function unpackGesture(ctl: ControllerState): void {
  const bufAction = ctl.bufAction;
  const bufArg = ctl.bufArg;
  let a = (bufAction - (bufAction % 16)) / 16;
  let x = a % 256; GR.gCurve = x - 128; a = (a - x) / 256;
  x = a % 8; GR.gFlags = x; a = (a - x) / 8;
  x = a % 128; GR.gPower = x; a = (a - x) / 128;
  GR.cls = a;
  let r = bufArg;
  x = r % 8; GR.kind = x; r = (r - x) / 8;
  x = r % 32; GR.gSlot = x - 1; r = (r - x) / 32;
  x = r % 2048; GR.gx = x - 1024; r = (r - x) / 2048;
  x = r % 2048; GR.gz = x - 1024; r = (r - x) / 2048;
  x = r % 256; GR.gdx = x - 128; r = (r - x) / 256;
  GR.gdz = r - 128;
}

// ---------------------------------------------------------------- double taps

/** seqA layout (see the header): bits 0..7 SeqFlag, 8..12 charging slot + 1, 13.. per-button press slot + 1. */
const SEQ_CHARGE_SHIFT = 8;
const SEQ_SLOT_BITS = 31;
const SEQ_PRESS_SHIFT = 13;

/** seqA field index of the press-slot record for tracked face button bi (PASS 0, LOB 1, THROUGH 2), or -1. */
function pressField(bi: number): number {
  if (bi === BI.PASS) return 0;
  if (bi === BI.LOB) return 1;
  if (bi === BI.THROUGH) return 2;
  return -1;
}

/** Controlled slot recorded at the latest press of face button bi (-1 = none / not recorded for bi). */
export function pressSlotOf(ctl: ControllerState, bi: number): number {
  const j = pressField(bi);
  if (j < 0) return -1;
  return ((ctl.seqA >> (SEQ_PRESS_SHIFT + 5 * j)) & SEQ_SLOT_BITS) - 1;
}

/**
 * Record ctl.slot as the controlled player of this tick's presses of PASS / LOB / THROUGH (call once per tick after
 * the presses were resolved, in every phase). Read back by isDoubleTap on the next press of the same button.
 */
export function recordPressSlots(ctl: ControllerState, pressed: number): void {
  if ((pressed & (Btn.PASS | Btn.LOB | Btn.THROUGH)) === 0) return;
  const v = validSlot(ctl.slot) ? ctl.slot + 1 : 0;
  let a = ctl.seqA;
  for (let bi = 0; bi < 4; bi++) {
    const j = pressField(bi);
    if (j < 0 || (pressed & (1 << bi)) === 0) continue;
    const sh = SEQ_PRESS_SHIFT + 5 * j;
    a = (a & ~(SEQ_SLOT_BITS << sh)) | (v << sh);
  }
  ctl.seqA = a;
}

/**
 * True when this tick's press of tracked button bi is the second of a double tap: the previous press (pressTick before
 * this tick, PREV_PRESS) was a tap (released within T_INPUT.tapTicks), is at most T_INPUT.doubleTapTicks old and was
 * made for the same controlled player (a press for a newly controlled player, e.g. the receiver after an
 * auto-switch, is a fresh press). Only PASS, LOB and THROUGH have double taps (the second SHOOT is the low driven
 * conversion, handled while the shot charges), so any other button returns false.
 */
export function isDoubleTap(ctl: ControllerState, c: number, bi: number, tick: number): boolean {
  if (pressField(bi) < 0) return false;
  const prev = PREV_PRESS[c * 8 + bi]!;
  if (!(prev >= 0) || tick - prev > T_INPUT.doubleTapTicks) return false;
  const rel = ctl.releaseTick[bi]!;
  if (!(rel >= prev && rel - prev < T_INPUT.tapTicks)) return false;
  return validSlot(ctl.slot) && pressSlotOf(ctl, bi) === ctl.slot;
}

export function setBuffer(ctl: ControllerState, code: number, arg: number, expire: number): void {
  ctl.bufAction = code;
  ctl.bufArg = arg;
  ctl.bufExpire = expire;
}

export function clearBuffer(ctl: ControllerState): void {
  ctl.bufAction = 0;
  ctl.bufArg = 0;
  ctl.bufExpire = -1;
}

// ---------------------------------------------------------------- charge bookkeeping

export function chargeSlotOf(ctl: ControllerState): number {
  return ((ctl.seqA >> SEQ_CHARGE_SHIFT) & SEQ_SLOT_BITS) - 1;
}

export function setCharge(ctl: ControllerState, bit: number, slot: number): void {
  ctl.powerBtn = bit;
  ctl.seqA = (ctl.seqA & ~(SEQ_SLOT_BITS << SEQ_CHARGE_SHIFT)) | (((slot + 1) & SEQ_SLOT_BITS) << SEQ_CHARGE_SHIFT);
}

export function clearCharge(ctl: ControllerState): void {
  ctl.powerBtn = 0;
  ctl.seqA = ctl.seqA & ~(SEQ_SLOT_BITS << SEQ_CHARGE_SHIFT);
}

/** Power-bar fill time for this controller (fast power bar setting), ticks. */
export function fillTicks(ctl: ControllerState): number {
  return ctl.fastPower === 1 ? T_PASS.powerFillTicksFast : T_PASS.powerFillTicks;
}

export function bitIndex(bit: number): number {
  for (let i = 0; i < 11; i++) if (bit === 1 << i) return i;
  return -1;
}

// ---------------------------------------------------------------- request preparation

/**
 * Fill REQ for an input of tracked button `bi` (-1 = none, e.g. gestures/skills): assist, flags (+ CPU), stick
 * direction, power. Explicit power (0..127, > 0) wins with charging 0; else charging while the button is held
 * (power = hold time / fill); else the hold time of the last press. Returns REQ.
 */
export function prepReq(ctl: ControllerState, bi: number, explicit: number, curve: number, flags: number): ActionRequest {
  const r = REQ;
  r.power = 0; r.charging = 0; r.targetSlot = -1; r.hasTarget = 0; r.targetX = 0; r.targetZ = 0;
  r.assist = ctl.assist;
  r.flags = flags | (ctl.kind === ControllerKind.CPU ? ReqFlag.CPU : 0);
  r.curve = curve / 127;
  stickDirInto(ctl, r);
  if (explicit > 0) {
    r.power = explicit / 127;
  } else if (bi >= 0) {
    const fill = fillTicks(ctl);
    let ticks: number;
    if ((ctl.buttons & (1 << bi)) !== 0 && ctl.holdT[bi]! > 0) {
      r.charging = 1;
      ticks = ctl.holdT[bi]!;
    } else {
      ticks = ctl.releaseTick[bi]! - ctl.pressTick[bi]!;
    }
    // power = hold ticks / fill, at least one tick's worth, at most 1 (inline: no doubles across calls)
    r.power = ticks <= 1 ? 1 / fill : ticks >= fill ? 1 : ticks / fill;
  }
  return r;
}

/** Unit stick direction into (dirX, dirZ) of r, or 0,0 when the stick is released (= facing). */
export function stickDirInto(ctl: ControllerState, r: { dirX: number; dirZ: number }): void {
  const mx = ctl.mx, mz = ctl.mz;
  const m = Math.sqrt(mx * mx + mz * mz);
  if (ctl.stickIdleT > 0 || m < 1e-6) { r.dirX = 0; r.dirZ = 0; return; }
  r.dirX = mx / m;
  r.dirZ = mz / m;
}

// ---------------------------------------------------------------- context queries (pure)

export function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot);
}

/** Our pass is on its way to an active teammate (ball loose, our touch last). */
export function ourPassInFlight(s: SimState, team: number): boolean {
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0 || !validSlot(b.passTarget)) return false;
  const t = s.players[b.passTarget]!;
  return t.active === 1 && t.team === team && b.lastTouchTeam === team;
}

/** Opponent carrier at feet of team's opponent (not a keeper holding it), or -1. */
export function oppCarrier(s: SimState, team: number): number {
  const b = s.ball;
  if (b.heldBy >= 0 || !validSlot(b.owner)) return -1;
  return s.players[b.owner]!.team === team ? -1 : b.owner;
}

/**
 * Ticks until the loose ball reaches `slot` (0 = already in reach horizontally), or -1 if it is not arriving:
 * closest approach of the ball's ground track to the player within LT.receiveLane (LT.receiveLaneTarget for the
 * intended receiver of a teammate's pass), with rolling deceleration for a grounded ball. Pure, O(1).
 */
export function ballEta(s: SimState, slot: number): number {
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0) return -1;
  const p = s.players[slot]!;
  const dx = p.x - b.x, dz = p.z - b.z;
  const reach = LT.reachRadius;
  if (dx * dx + dz * dz <= reach * reach) return 0;
  const vx = b.vx, vz = b.vz;
  const v2 = vx * vx + vz * vz;
  if (v2 < LT.arriveMinSpeed * LT.arriveMinSpeed) return -1;
  const t = (dx * vx + dz * vz) / v2;
  if (!(t > 0)) return -1;
  const cx = b.x + vx * t - p.x, cz = b.z + vz * t - p.z;
  const target = b.passTarget === slot && b.lastTouchTeam === p.team;
  const lane = target ? LT.receiveLaneTarget : LT.receiveLane;
  if (cx * cx + cz * cz > lane * lane) return -1;
  let sec = t;
  if (b.grounded === 1) {
    const v = Math.sqrt(v2);
    const dist = v * t;
    const a = T_BALL.rollDecel + T_BALL.rollDamping * v;
    const disc = v * v - 2 * a * dist;
    if (disc <= 0) return -1; // stops short of him
    sec = (v - Math.sqrt(disc)) / a;
  }
  const eta = Math.ceil(sec * TICK_HZ);
  return eta > 0 ? eta : 0;
}

/** Meeting point written by meetPoint (scratch, read right after the call). */
export const MEET = { x: 0, z: 0 };

/**
 * Earliest point on the loose ball's ground track that `slot` can reach in time (at top speed when sprint = 1, else
 * jog speed; samples every LT.meetStepSec up to LT.receiveLookAheadSec, grounded balls decelerating) into MEET; the
 * last sample if none. Takes no double arguments (V8 boxes doubles across calls).
 */
export function meetPoint(s: SimState, slot: number, sprint: number): void {
  const b = s.ball;
  const p = s.players[slot]!;
  const top = s.attrs[slot]!.topSpeed;
  const speed = sprint === 1 ? top : top * T_PLAYER.jogFraction;
  const v = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  MEET.x = b.x;
  MEET.z = b.z;
  if (v < 0.5) return;
  const ux = b.vx / v, uz = b.vz / v;
  const a = b.grounded === 1 ? T_BALL.rollDecel + T_BALL.rollDamping * v : 0;
  const n = Math.floor(LT.receiveLookAheadSec / LT.meetStepSec);
  for (let k = 1; k <= n; k++) {
    const t = k * LT.meetStepSec;
    let d = v * t - 0.5 * a * t * t;
    if (a > 0 && t > v / a) d = (v * v) / (2 * a);
    MEET.x = b.x + ux * d;
    MEET.z = b.z + uz * d;
    const dx = MEET.x - p.x, dz = MEET.z - p.z;
    if (Math.sqrt(dx * dx + dz * dz) <= speed * t + LT.reachRadius) return;
  }
}

/** True while slot is the intended receiver of a teammate's pass in flight. */
export function isReceiver(s: SimState, slot: number): boolean {
  const b = s.ball;
  return b.owner < 0 && b.heldBy < 0 && b.passTarget === slot && b.lastTouchTeam === s.players[slot]!.team;
}

/**
 * Button context for the controlled player: KEEPER (holding the ball in hands), ATTACK (our ball, our pass in flight,
 * or a loose ball he is about to receive / is nearer to than the opponents), else DEFENCE. Pure.
 */
export function controlContext(s: SimState, slot: number): number {
  const b = s.ball;
  const p = s.players[slot]!;
  const team = p.team;
  if (b.heldBy >= 0) {
    if (b.heldBy === slot) return Ctx.KEEPER;
    return validSlot(b.heldBy) && s.players[b.heldBy]!.team === team ? Ctx.ATTACK : Ctx.DEFENCE;
  }
  if (b.owner >= 0) return validSlot(b.owner) && s.players[b.owner]!.team === team ? Ctx.ATTACK : Ctx.DEFENCE;
  if (ourPassInFlight(s, team)) return Ctx.ATTACK;
  if (ballEta(s, slot) >= 0) return Ctx.ATTACK;
  const dx = p.x - b.x, dz = p.z - b.z;
  const dSelf = Math.sqrt(dx * dx + dz * dz);
  // Nearest active opponent to the ball (inline: no doubles across calls).
  const first = team === 0 ? 11 : 0;
  let best = 1e18;
  for (let i = first; i < first + 11; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const qx = q.x - b.x, qz = q.z - b.z;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) best = d2;
  }
  const lim = dSelf - LT.looseAttackMargin;
  return lim <= 0 || lim * lim <= best ? Ctx.ATTACK : Ctx.DEFENCE;
}

/** Player in his own third (progress below LT.ownThirdProgress). */
export function inOwnThird(s: SimState, p: Readonly<PlayerState>): boolean {
  return (s.teams[p.team]!.dir * p.x) / HALF_LENGTH < LT.ownThirdProgress;
}

/** Player in his own half. */
export function inOwnHalf(s: SimState, p: Readonly<PlayerState>): boolean {
  return s.teams[p.team]!.dir * p.x < 0;
}

/** Wind-up ticks of a kick kind before contact (for first-time timing). */
export function windupOf(kind: KickKind): number {
  if (kind === KickKind.SHOT_POWER) return T_SHOT.powerShotWindup;
  if (kind >= KickKind.SHOT_NORMAL && kind <= KickKind.VOLLEY_PASS) return T_SHOT.windup;
  return T_PASS.windup;
}

export function isLobKind(k: KickKind): boolean { return k >= KickKind.LOB_PASS && k <= KickKind.LOW_CROSS; }

// ---------------------------------------------------------------- optional exports of other modules

export type SlotFn = (s: SimState, slot: number) => unknown;

/**
 * An export another module documents but may not have added yet (e.g. SIM-11 markLowDriven, SIM-14 quickGetUp).
 * Looked up by name at call time on the module namespace, so it starts working as soon as the export lands.
 */
export function optionalSlotFn(ns: unknown, name: string): SlotFn | null {
  // `in` first: a module namespace answers it like a property read, and test-runner module mocks (which throw on
  // a missing export) answer it without throwing.
  if (ns === null || typeof ns !== 'object' || !(name in ns)) return null;
  const v = (ns as Record<string, unknown>)[name];
  return typeof v === 'function' ? (v as SlotFn) : null;
}

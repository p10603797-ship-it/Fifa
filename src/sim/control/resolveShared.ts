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
import { HALF_LENGTH, HALF_WIDTH, NUM_CONTROLLERS, NUM_SLOTS, TICK_HZ } from '../../contracts/constants';
import { ControllerKind, KickKind } from '../../contracts/enums';
import { Btn } from '../../contracts/input';
import type { ControllerState, PlayerState, SimState } from '../../contracts/state';
import { createActionRequest, ReqFlag, type ActionRequest } from '../../contracts/systems';
import { T_BALL, T_INPUT, T_PASS, T_PLAYER, T_SHOT, T_TOUCH, T_RESOLVE } from '../../contracts/tuning';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_RESOLVE. */
export const LOCAL_TUNING = T_RESOLVE;


export const LT = T_RESOLVE;

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

/**
 * [QF-9 skeptic] First-time kick timing: ticks until the loose ball comes within LT.reachRadius of `slot` (the kick's
 * reach: where the foot meets it), with his own run along its track (a receiver stepping onto the pass closes the gap
 * faster); 0 = in reach now, -1 = not arriving (as ballEta: lane, rolling deceleration). ballEta counts to his centre
 * and ignores his run: for a receiver running onto the pass it read 10-13 ticks while the ball was 1-2 ticks from his
 * reach, so the first-time press fired late and the kick whiffed, or SIM-07 trapped the ball first. (ballEta keeps
 * timing the own-third clearance decision and TCH-04's CLEAR label: the clearance launches at once and its kick needs
 * the extra lead to line up.) Pure, O(1).
 */
export function ballReachEta(s: SimState, slot: number): number {
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0) return -1;
  const p = s.players[slot]!;
  const dx = p.x - b.x, dz = p.z - b.z;
  const reach = LT.reachRadius;
  if (dx * dx + dz * dz <= reach * reach) return 0;
  const vx = b.vx, vz = b.vz;
  const v2 = vx * vx + vz * vz;
  if (v2 < LT.arriveMinSpeed * LT.arriveMinSpeed) return -1;
  const v = Math.sqrt(v2);
  const ux = vx / v, uz = vz / v;
  const along = dx * ux + dz * uz; // his distance ahead of the ball along its track
  if (!(along > 0)) return -1;
  let lat = dx * uz - dz * ux;
  if (lat < 0) lat = -lat;
  const target = b.passTarget === slot && b.lastTouchTeam === p.team;
  const lane = target ? LT.receiveLaneTarget : LT.receiveLane;
  if (lat > lane) return -1;
  // Gap to close: to where the track enters his reach (to the closest approach when it passes outside it).
  const gap = lat < reach ? along - Math.sqrt(reach * reach - lat * lat) : along;
  const w = v - (p.vx * ux + p.vz * uz); // closing speed along the track (his run toward the ball adds)
  if (!(w > 0)) return -1;
  let sec = gap / w;
  if (b.grounded === 1) {
    const a = T_BALL.rollDecel + T_BALL.rollDamping * v;
    const disc = w * w - 2 * a * gap;
    if (disc <= 0) return -1; // stops short of him
    sec = (w - Math.sqrt(disc)) / a;
  }
  const eta = Math.ceil(sec * TICK_HZ);
  return eta > 0 ? eta : 0;
}

/** Meeting point written by meetPoint (scratch, read right after the call) and the run speed it planned (m/s). */
export const MEET = { x: 0, z: 0, speed: 0 };

/**
 * meetPoint scratch (doubles cross the helper call through a typed array, never as arguments): [0] t (s), [1..2] ball
 * x / z now, [3..4] unit track direction, [5] horizontal speed, [6] rolling deceleration (0 in the air), [7..8] player
 * x / z, [9] his planned speed, [10] the reach radius.
 */
const MT = new Float64Array(11);

/** MEET = the ball's track point at time MT[0]; 1 when the player gets within reach of it by then. */
function meetEval(): number {
  const t = MT[0]!, v = MT[5]!, a = MT[6]!;
  let d = v * t - 0.5 * a * t * t;
  if (a > 0 && t > v / a) d = (v * v) / (2 * a);
  MEET.x = MT[1]! + MT[3]! * d;
  MEET.z = MT[2]! + MT[4]! * d;
  const dx = MEET.x - MT[7]!, dz = MEET.z - MT[8]!;
  return Math.sqrt(dx * dx + dz * dz) <= MT[9]! * t + MT[10]! ? 1 : 0;
}

/**
 * Earliest point on the loose ball's ground track that `slot` can reach in time (at top speed when sprint = 1, else
 * jog speed or his current speed when faster; samples every LT.meetStepSec up to LT.receiveLookAheadSec, grounded balls
 * decelerating) into MEET; the last sample if none. [QF-9] A lofted ball's track is skipped where it is above
 * LT.meetMaxHeight (see below). [QF-13] Never beyond the pitch + T_TOUCH.meetPitchMargin (meetOnPitch). Takes no double
 * arguments (V8 boxes doubles across calls).
 */
export function meetPoint(s: SimState, slot: number, sprint: number): void {
  const b = s.ball;
  const p = s.players[slot]!;
  const top = s.attrs[slot]!.topSpeed;
  // [INT-A] Never plan slower than he is already running: a receiver sprinting onto a led pass keeps his pace
  // (planning at jog speed dropped him from 9 to 5.5 m/s and the pass ran past him).
  const cur = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const jog = top * T_PLAYER.jogFraction;
  const speed = sprint === 1 ? top : cur > jog ? (cur < top ? cur : top) : jog;
  MEET.speed = speed;
  const v = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  MEET.x = b.x;
  MEET.z = b.z;
  if (v < 0.5) return;
  const air = b.grounded !== 1;
  MT[1] = b.x; MT[2] = b.z; MT[3] = b.vx / v; MT[4] = b.vz / v; MT[5] = v;
  MT[6] = air ? 0 : T_BALL.rollDecel + T_BALL.rollDamping * v;
  MT[7] = p.x; MT[8] = p.z; MT[9] = speed; MT[10] = LT.reachRadius;
  // [QF-9] A lofted ball (lob, keeper throw, cross) is over his head between tUp and tDown (its flight parabola above
  // LT.meetMaxHeight; none when it stays below): no meeting point there (the ground-track point he could reach first was
  // 4-10 m under the ball, which landed behind him; LOB_PASS reached a teammate 2 times in 64). The exact crossing
  // points are candidates themselves, so the target does not jump with the sampling grid as the ball flies.
  let tUp = -1, tDown = -1;
  if (air) {
    const g = T_BALL.gravity;
    const disc = b.vy * b.vy + 2 * g * (b.y - LT.meetMaxHeight);
    if (disc > 0) {
      const r = Math.sqrt(disc);
      tDown = (b.vy + r) / g;
      tUp = (b.vy - r) / g; // < 0 when it is above head height already
    }
  }
  // [QF-9 skeptic] The samples sit on a grid of absolute match time (every meetStepSec of s.tick / TICK_HZ), not of
  // time from now: then they are the same points of the ball's track tick after tick, and the target stays put while
  // the ball comes (a grid from now moved the target on with the ball by 0.2 m a tick and threw it back by v x
  // meetStepSec every 7-8 ticks: an idle receiver of a 17-20 m/s pass shuffled to and fro in that sawtooth).
  const step = LT.meetStepSec;
  const now = s.tick / TICK_HZ;
  const phase = now - Math.floor(now / step) * step; // 0 <= phase < step
  const n = Math.floor(LT.receiveLookAheadSec / step);
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const tk = k * step - phase;
    for (let e = 0; e < 3; e++) {
      // e 0 / 1: the crossing up / down when it falls in (prev, tk]; e 2: the sample itself unless over his head.
      const t = e === 0 ? tUp : e === 1 ? tDown : tk;
      if (e < 2 && !(t > prev && t <= tk)) continue;
      if (e === 2 && tk > tUp && tk < tDown) continue;
      MT[0] = t;
      if (meetEval() === 1) { meetOnPitch(); return; }
    }
    prev = tk;
  }
  // None reachable within the look-ahead: the last sample (or the landing point when it is still over his head then).
  const tLast = n * step - phase;
  MT[0] = tDown > tLast ? tDown : tLast;
  meetEval();
  meetOnPitch();
}

/**
 * [QF-13] A meeting point beyond a touchline or goal line (the ball will be out there: an overhit lob's landing point)
 * moves back along the ball's track to where it leaves the pitch + T_TOUCH.meetPitchMargin; then it is clamped to that
 * box (a ball already outside it).
 */
function meetOnPitch(): void {
  const m = T_TOUCH.meetPitchMargin;
  const xl = HALF_LENGTH + m;
  const zl = HALF_WIDTH + m;
  if (MEET.x <= xl && MEET.x >= -xl && MEET.z <= zl && MEET.z >= -zl) return;
  const bx = MT[1]!, bz = MT[2]!, ux = MT[3]!, uz = MT[4]!;
  if (bx <= xl && bx >= -xl && bz <= zl && bz >= -zl) {
    let d = 1e9;
    if (ux > 1e-9) { const e = (xl - bx) / ux; if (e < d) d = e; } else if (ux < -1e-9) { const e = (-xl - bx) / ux; if (e < d) d = e; }
    if (uz > 1e-9) { const e = (zl - bz) / uz; if (e < d) d = e; } else if (uz < -1e-9) { const e = (-zl - bz) / uz; if (e < d) d = e; }
    if (d < 1e9) {
      MEET.x = bx + ux * d;
      MEET.z = bz + uz * d;
    }
  }
  if (MEET.x > xl) MEET.x = xl;
  else if (MEET.x < -xl) MEET.x = -xl;
  if (MEET.z > zl) MEET.z = zl;
  else if (MEET.z < -zl) MEET.z = -zl;
}

/** [QF-13] Clamp a receiver's target point to the pitch + T_TOUCH.meetPitchMargin (MEET is the in / out point). */
export function clampMeetTarget(): void {
  const m = T_TOUCH.meetPitchMargin;
  const xl = HALF_LENGTH + m;
  const zl = HALF_WIDTH + m;
  if (MEET.x > xl) MEET.x = xl;
  else if (MEET.x < -xl) MEET.x = -xl;
  if (MEET.z > zl) MEET.z = zl;
  else if (MEET.z < -zl) MEET.z = -zl;
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

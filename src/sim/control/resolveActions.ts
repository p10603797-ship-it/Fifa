/**
 * [SIM-15] Button -> action resolution for the controlled player (section 9 / 10 tables), power bar charging,
 * second-press conversions (double-tap lofted variants, low driven shot, fake, quick get-up) and the hold/tap
 * modifiers (trigger run, call for support, pick-up, second defender, keeper rush, stop ball, stop and face goal,
 * shield). Modifier combos are read at the FACE button press edge (packed into the press record), never when the
 * modifier is pressed. Called from resolve.ts; all persistent state lives in s.ctrl[c] (see resolveShared.ts).
 */
import { HALF_LENGTH } from '../../contracts/constants';
import { ActionKind, KickKind, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { Btn } from '../../contracts/input';
import type { ControllerState, PlayerState, SimState } from '../../contracts/state';
import { ReqFlag, type ActionRequest } from '../../contracts/systems';
import { T_INPUT } from '../../contracts/tuning';
import { endAction, isFree } from '../actions/dispatch';
import { applyShieldIntent, stopShield } from '../players/bodiesShield';
import { startPass } from '../kicks/pass';
import { startLob } from '../kicks/lob';
import { startThrough } from '../kicks/through';
import * as shotNs from '../kicks/shot';
import { startShot } from '../kicks/shot';
import { aerialChance, startHeader, startVolley } from '../kicks/aerial';
import { startFake, startSkill } from '../kicks/skills';
import * as tackleNs from '../defend/tackle';
import { startClearance, startTackle } from '../defend/tackle';
import { startKeeperRush } from '../keeper/sweeper';
import { canHandle, keeperPickUp, startKeeperRelease } from '../keeper/handling';
import { ticksToReach } from '../players/locomotion';
import { inCrossingZone } from '../pitch/geometry';
import { triggerRun } from '../../ai/runs';
import { callSupport } from '../../ai/support';
import { canManualSwitch } from './switching';
import {
  BI, Ctx, LT, PR, PressFlag, Res, SeqFlag, ballEta, ballReachEta, bitIndex, chargeSlotOf, clearCharge, controlContext,
  fillTicks, inOwnThird, isDoubleTap, isLobKind, isReceiver, oppCarrier, optionalSlotFn, prepReq, setCharge, stickDirInto,
  unpackPress, validSlot, windupOf,
} from './resolveShared';

/** "Not applicable" from the loose-ball special cases. */
const NA = -2;
/** ReqFlag bits chosen by kindFor (scratch). */
let kindFlags = 0;
const DIR = { dirX: 0, dirZ: 0 };

// ---------------------------------------------------------------- starters

/** Start any kick-type action of `kind` through its owner's starter. Returns 1 if started. */
export function startKick(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (kind >= KickKind.GROUND_PASS && kind <= KickKind.DINKED_PASS) return startPass(s, slot, kind, req, ev);
  if (isLobKind(kind)) return startLob(s, slot, kind, req, ev);
  if (kind >= KickKind.THROUGH_GROUND && kind <= KickKind.THROUGH_DINKED) return startThrough(s, slot, kind, req, ev);
  if (kind >= KickKind.SHOT_NORMAL && kind <= KickKind.SHOT_LOW_DRIVEN) return startShot(s, slot, kind, req, ev);
  if (kind === KickKind.HEADER_SHOT || kind === KickKind.HEADER_PASS) return startHeader(s, slot, kind, req, ev);
  if (kind === KickKind.VOLLEY_SHOT || kind === KickKind.VOLLEY_PASS) return startVolley(s, slot, kind, req, ev);
  if (kind === KickKind.CLEARANCE) return startClearance(s, slot, kind, req, ev);
  if ((kind >= KickKind.GK_THROW && kind <= KickKind.GK_DRIVEN_KICK) || kind === KickKind.GK_RELEASE) {
    return startKeeperRelease(s, slot, kind, req, ev);
  }
  return 0;
}

/**
 * Bookkeeping after a successful kick start: a held initiating button keeps charging (power bar), otherwise the
 * request's power is final. bi = tracked button that started it (-1 = none: gesture / conversion).
 */
export function afterStart(s: SimState, ctl: ControllerState, slot: number, bi: number, req: ActionRequest): void {
  const p = s.players[slot]!;
  if (p.act === ActionKind.NONE) return;
  p.actPower = req.power;
  if (req.charging === 1 && bi >= 0) {
    p.actCharging = 1;
    setCharge(ctl, 1 << bi, slot);
  } else {
    p.actCharging = 0;
    if (ctl.powerBtn !== 0) clearCharge(ctl);
  }
}

/** End a SHIELD hold (SIM-05 stopShield) so an action can start; true if the player is free now. */
export function prepareFree(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.act === ActionKind.SHIELD) stopShield(s, slot);
  return isFree(p);
}

function launch(s: SimState, ctl: ControllerState, slot: number, bi: number, kind: KickKind, flags: number, ev: EventSink): number {
  const noPower = kind === KickKind.GK_RELEASE;
  const req = prepReq(ctl, noPower ? -1 : bi, noPower ? 0 : PR.power, PR.curve, flags);
  if (startKick(s, slot, kind, req, ev) !== 1) return Res.RETRY;
  afterStart(s, ctl, slot, noPower ? -1 : bi, req);
  return Res.STARTED;
}

// ---------------------------------------------------------------- tables

/** Section 9/10 attack table: kick kind for face button bi with modifiers (1 = MOD_L, 2 = MOD_R) and double tap. */
export function attackKindFor(bi: number, mods: number, dbl: boolean): KickKind {
  const L = (mods & 1) !== 0;
  const R = (mods & 2) !== 0;
  kindFlags = 0;
  switch (bi) {
    case BI.PASS:
      if (R) { kindFlags = ReqFlag.DRIVEN | (L ? ReqFlag.PASS_AND_GO : 0); return KickKind.DRIVEN_PASS; }
      if (L) { kindFlags = ReqFlag.PASS_AND_GO; return KickKind.GROUND_PASS; }
      if (dbl) { kindFlags = ReqFlag.LOFTED; return KickKind.DINKED_PASS; }
      return KickKind.GROUND_PASS;
    case BI.LOB:
      if (R) { kindFlags = ReqFlag.DRIVEN; return KickKind.DRIVEN_LOB; }
      if (L) return KickKind.HIGH_LOB;
      if (dbl) return KickKind.GROUND_CROSS;
      return KickKind.LOB_PASS;
    case BI.THROUGH:
      if (L) return KickKind.THROUGH_LOBBED;
      if (dbl) { kindFlags = ReqFlag.LOFTED; return KickKind.THROUGH_DINKED; }
      if (R) { kindFlags = ReqFlag.DRIVEN; return KickKind.THROUGH_GROUND; }
      return KickKind.THROUGH_GROUND;
    case BI.SHOOT:
      if (L && R) return KickKind.SHOT_POWER;
      if (R) return KickKind.SHOT_FINESSE;
      if (L) return KickKind.SHOT_CHIP;
      return KickKind.SHOT_NORMAL;
    default:
      return KickKind.NONE;
  }
}

/**
 * Crossing-zone meaning of an attack kick (BRIEF section 9, PASS swipe right = MOD_R+PASS: "Driven ground pass; a low
 * cross in the crossing zone"): MOD_R+PASS (without MOD_L) by a player inside geometry.inCrossingZone for his
 * attacking direction is a LOW_CROSS (SIM-09 startLob) instead of a DRIVEN_PASS. Every other kind is returned as is
 * (LOB_PASS -> CROSS and DRIVEN_LOB -> LOW_CROSS in the zone are SIM-09's own conversions). Updates kindFlags.
 */
export function zoneKind(s: SimState, p: Readonly<PlayerState>, kind: KickKind, mods: number): KickKind {
  if (kind !== KickKind.DRIVEN_PASS || (mods & 1) !== 0) return kind;
  if (!inCrossingZone(p.x, p.z, s.teams[p.team]!.dir)) return kind;
  kindFlags = ReqFlag.DRIVEN;
  return KickKind.LOW_CROSS;
}

/** Goalkeeper-with-the-ball table (section 10; touch maps onto the same bits). */
export function keeperKindFor(bi: number, mods: number): KickKind {
  const R = (mods & 2) !== 0;
  switch (bi) {
    case BI.PASS: return R ? KickKind.GK_DRIVEN_THROW : KickKind.GK_THROW;
    case BI.SHOOT: return R ? KickKind.GK_DRIVEN_KICK : KickKind.GK_DROP_KICK;
    case BI.LOB: return R ? KickKind.GK_DRIVEN_KICK : KickKind.GK_DROP_KICK;
    case BI.THROUGH: return KickKind.GK_RELEASE;
    default: return KickKind.NONE;
  }
}

/** The double-tap version of an already started kick (PASS,PASS / LOB,LOB / THROUGH,THROUGH), or NONE. */
export function doubledKind(k: KickKind): KickKind {
  if (k === KickKind.GROUND_PASS) return KickKind.DINKED_PASS;
  if (k === KickKind.LOB_PASS || k === KickKind.CROSS) return KickKind.GROUND_CROSS;
  if (k === KickKind.THROUGH_GROUND) return KickKind.THROUGH_DINKED;
  return KickKind.NONE;
}

/**
 * Tackle by context (SHOOT in defence): standing when goal-side of the carrier, shoulder when running alongside,
 * push/pull when chasing from behind.
 */
export function tackleKind(s: SimState, p: Readonly<PlayerState>, carrier: number): ActionKind {
  if (!validSlot(carrier)) return ActionKind.STAND_TACKLE;
  const q = s.players[carrier]!;
  const ownGoalX = -s.teams[p.team]!.dir * HALF_LENGTH;
  let gx = ownGoalX - q.x, gz = -q.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > 1e-6) { gx /= gl; gz /= gl; }
  const dx = p.x - q.x, dz = p.z - q.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return ActionKind.STAND_TACKLE;
  const ux = dx / d, uz = dz / d;
  const gs = ux * gx + uz * gz;
  if (gs >= LT.goalSideCos) return ActionKind.STAND_TACKLE;
  const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
  if (qs > LT.shoulderMinSpeed && d <= LT.shoulderMaxDist) {
    const mx = q.vx / qs, mz = q.vz / qs;
    const side = Math.abs(mx * uz - mz * ux);
    const pv = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    const par = pv > 0.5 ? (p.vx * mx + p.vz * mz) / pv : 0;
    if (side >= LT.shoulderSideMin && par >= LT.shoulderParallelMin) return ActionKind.SHOULDER;
  }
  if (gs <= LT.chaseCos) return ActionKind.PUSH_PULL;
  return ActionKind.STAND_TACKLE;
}

// ---------------------------------------------------------------- face presses

/**
 * Loose-ball special cases shared by attack and defence: SHOOT on a ball arriving in the own third clears it;
 * PASS / LOB / SHOOT with a header or volley chance start SIM-12. Returns a Res or NA.
 */
function looseSpecial(s: SimState, ctl: ControllerState, slot: number, bi: number, cls: number, ev: EventSink): number {
  const p = s.players[slot]!;
  if (bi === BI.SHOOT && inOwnThird(s, p)) {
    const eta = ballEta(s, slot);
    if ((eta >= 0 && eta <= LT.clearArriveTicks) || aerialChance(s, slot) > 0) {
      if (!prepareFree(s, slot)) return Res.RETRY;
      return launch(s, ctl, slot, bi, KickKind.CLEARANCE, ReqFlag.FIRST_TIME, ev);
    }
  }
  if (bi === BI.THROUGH) return NA;
  const ac = aerialChance(s, slot);
  if (!(ac > 0)) return NA;
  const header = ac === 1 ? true : ac === 2 ? false : s.ball.y >= LT.volleyMaxHeight;
  const shot = bi === BI.SHOOT && cls === Ctx.ATTACK;
  const kind = header ? (shot ? KickKind.HEADER_SHOT : KickKind.HEADER_PASS) : (shot ? KickKind.VOLLEY_SHOT : KickKind.VOLLEY_PASS);
  if (!prepareFree(s, slot)) return Res.RETRY;
  return launch(s, ctl, slot, bi, kind, ReqFlag.FIRST_TIME, ev);
}

function attackFace(s: SimState, ctl: ControllerState, slot: number, bi: number, ev: EventSink): number {
  const b = s.ball;
  const kind = zoneKind(s, s.players[slot]!, attackKindFor(bi, PR.mods, (PR.flags & PressFlag.DOUBLE) !== 0), PR.mods);
  const flags = kindFlags;
  if (kind === KickKind.NONE) return Res.DROP;
  const pending = (PR.flags & PressFlag.PENDING) !== 0;
  if (b.owner === slot && b.heldBy < 0) {
    if (!prepareFree(s, slot)) return Res.RETRY;
    return launch(s, ctl, slot, bi, kind, flags, ev);
  }
  if (b.owner >= 0 || b.heldBy >= 0) return pending ? Res.DROP : Res.RETRY;
  // Loose ball: clearance / aerial, else a first-time kick when it arrives ([QF-9 skeptic] timed to its reach, with
  // his run: ballReachEta).
  const sp = looseSpecial(s, ctl, slot, bi, Ctx.ATTACK, ev);
  if (sp !== NA) return sp;
  const eta = ballReachEta(s, slot);
  if (eta < 0) {
    if (isReceiver(s, slot)) return Res.PENDING;
    return pending ? Res.DROP : Res.RETRY;
  }
  if (eta > windupOf(kind) + LT.firstTimeLeadTicks || b.y > LT.firstTimeMaxHeight) return Res.PENDING;
  if (!prepareFree(s, slot)) return Res.PENDING;
  const r = launch(s, ctl, slot, bi, kind, flags | ReqFlag.FIRST_TIME, ev);
  return r === Res.STARTED ? r : Res.PENDING;
}

function defenceFace(s: SimState, ctl: ControllerState, slot: number, bi: number, ev: EventSink): number {
  const b = s.ball;
  if (b.owner < 0 && b.heldBy < 0) {
    const sp = looseSpecial(s, ctl, slot, bi, Ctx.DEFENCE, ev);
    if (sp !== NA) return sp;
  }
  const p = s.players[slot]!;
  if (bi === BI.SHOOT) {
    if (!prepareFree(s, slot)) return Res.RETRY;
    const kind = (PR.mods & 2) !== 0 ? ActionKind.HARD_TACKLE : tackleKind(s, p, oppCarrier(s, p.team));
    return startTackle(s, slot, kind, -1, ev) === 1 ? Res.STARTED : Res.RETRY;
  }
  if (bi === BI.LOB) {
    if (!prepareFree(s, slot)) return Res.RETRY;
    return startTackle(s, slot, ActionKind.SLIDE_TACKLE, -1, ev) === 1 ? Res.STARTED : Res.RETRY;
  }
  // PASS (contain) and THROUGH (keeper rush) are holds: movement / modifierTick.
  return Res.DROP;
}

function keeperFace(s: SimState, ctl: ControllerState, slot: number, bi: number, ev: EventSink): number {
  const p = s.players[slot]!;
  if (p.stunT > 0 || p.active !== 1 || (p.act !== ActionKind.NONE && p.act !== ActionKind.GK_HOLD)) return Res.RETRY;
  const kind = keeperKindFor(bi, PR.mods);
  if (kind === KickKind.NONE) return Res.DROP;
  return launch(s, ctl, slot, bi, kind, 0, ev);
}

/**
 * Resolve a face button press (bi = tracked index of PASS/SHOOT/LOB/THROUGH) with its packed press record for
 * controller c's player. A retry (buffered press) is dropped when the context changed since the press.
 */
export function resolveFacePress(s: SimState, c: number, ctl: ControllerState, bi: number, packed: number, retry: boolean, ev: EventSink): number {
  const slot = ctl.slot;
  if (!validSlot(slot) || s.players[slot]!.active !== 1) return Res.DROP;
  unpackPress(packed);
  const cls = controlContext(s, slot);
  if (retry && cls !== PR.cls) return Res.DROP;
  if (cls === Ctx.KEEPER) return keeperFace(s, ctl, slot, bi, ev);
  if (cls === Ctx.ATTACK) return attackFace(s, ctl, slot, bi, ev);
  return defenceFace(s, ctl, slot, bi, ev);
}

/** Skill move edge (frame.skill or buffered): the dribbler only; direction from the stick (0,0 = facing). */
export function resolveSkill(s: SimState, ctl: ControllerState, skill: SkillMove, cls: number, retry: boolean, ev: EventSink): number {
  const slot = ctl.slot;
  if (!validSlot(slot) || skill <= SkillMove.NONE || skill > SkillMove.HARD_STOP) return Res.DROP;
  const cur = controlContext(s, slot);
  if (cur !== Ctx.ATTACK || (retry && cls !== cur)) return Res.DROP;
  if (s.ball.owner !== slot || s.ball.heldBy >= 0) return Res.RETRY;
  if (!prepareFree(s, slot)) return Res.RETRY;
  stickDirInto(ctl, DIR);
  return startSkill(s, slot, skill, DIR.dirX, DIR.dirZ, ev) === 1 ? Res.STARTED : Res.RETRY;
}

/** Knock-on: SPRINT held + right-stick flick toward (ax, az) (-127..127; 0,0 = stick direction). */
export function resolveKnockOn(s: SimState, ctl: ControllerState, ax: number, az: number, retry: boolean, ev: EventSink): number {
  const slot = ctl.slot;
  if (!validSlot(slot)) return Res.DROP;
  if (controlContext(s, slot) !== Ctx.ATTACK) return Res.DROP;
  if (s.ball.owner !== slot || s.ball.heldBy >= 0) return Res.RETRY;
  if (!prepareFree(s, slot)) return Res.RETRY;
  const m = Math.sqrt(ax * ax + az * az);
  if (m > 1e-6) { DIR.dirX = ax / m; DIR.dirZ = az / m; } else stickDirInto(ctl, DIR);
  return startSkill(s, slot, SkillMove.KNOCK_ON, DIR.dirX, DIR.dirZ, ev) === 1 ? Res.STARTED : Res.RETRY;
}

// ---------------------------------------------------------------- second presses on a running action

/** Re-start the controlled kick as `kind` with its current power (no charging). */
function restartKick(s: SimState, ctl: ControllerState, slot: number, kind: KickKind, flag: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const fill = fillTicks(ctl);
  const power = p.actPower > 1 / fill ? (p.actPower < 1 ? p.actPower : 1) : 1 / fill;
  const owner = s.ball.owner === slot;
  endAction(s, slot, 1);
  clearCharge(ctl);
  const req = prepReq(ctl, -1, 0, 0, flag | (owner ? 0 : ReqFlag.FIRST_TIME));
  req.power = power;
  if (startKick(s, slot, kind, req, ev) === 1) afterStart(s, ctl, slot, -1, req);
}

/**
 * Second presses that modify the controlled player's running action this tick: LOB while sliding/fallen = quick
 * get-up (SIM-14 quickGetUp); PASS during a shot or lob wind-up = fake (SIM-13); a second SHOOT during the shot's
 * power-up = low driven (SIM-11 markLowDriven); PASS,PASS / LOB,LOB / THROUGH,THROUGH within the double-tap window
 * while the first is still winding up = dinked pass / ground cross / dinked through ball. Returns the consumed
 * face bits.
 */
export function convertPresses(s: SimState, c: number, ctl: ControllerState, p: PlayerState, pressed: number, ev: EventSink): number {
  if (pressed === 0 || p.act === ActionKind.NONE) return 0;
  const slot = p.slot;
  let used = 0;
  if ((pressed & Btn.LOB) !== 0 &&
      (p.act === ActionKind.SLIDE_TACKLE || p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP)) {
    const fn = optionalSlotFn(tackleNs, 'quickGetUp');
    if (fn) fn(s, slot);
    used |= Btn.LOB;
  }
  if ((pressed & Btn.PASS) !== 0 && p.actDone === 0 &&
      (p.act === ActionKind.SHOT || (p.act === ActionKind.KICK && isLobKind(p.actKick)))) {
    if (startFake(s, slot, ev) === 1 && chargeSlotOf(ctl) === slot) clearCharge(ctl);
    used |= Btn.PASS;
  }
  const cb = ctl.powerBtn;
  if (cb !== 0 && (pressed & cb & ~used) !== 0 && chargeSlotOf(ctl) === slot && p.actDone === 0) {
    const bi = bitIndex(cb);
    if (cb === Btn.SHOOT && p.act === ActionKind.SHOT) {
      const fn = optionalSlotFn(shotNs, 'markLowDriven');
      if (fn) {
        fn(s, slot);
        if ((p.act as ActionKind) !== ActionKind.NONE) p.actCharging = 0;
        clearCharge(ctl);
      } else {
        restartKick(s, ctl, slot, KickKind.SHOT_LOW_DRIVEN, ReqFlag.LOW, ev);
      }
      used |= Btn.SHOOT;
    } else if (p.act === ActionKind.KICK && bi >= 0 && isDoubleTap(ctl, c, bi, s.tick)) {
      const nk = doubledKind(p.actKick);
      if (nk !== KickKind.NONE) {
        restartKick(s, ctl, slot, nk, nk === KickKind.GROUND_CROSS ? 0 : ReqFlag.LOFTED, ev);
        used |= cb;
      }
    }
  }
  return used;
}

// ---------------------------------------------------------------- power bar

function isKickAct(a: ActionKind): boolean { return a === ActionKind.KICK || a === ActionKind.SHOT; }

/**
 * A second press can still change this running foot kick: a shot (SHOOT again = low driven, PASS = fake), a kick with
 * a double-tap version (PASS,PASS / LOB,LOB / THROUGH,THROUGH) or a lob / cross (PASS = fake pass).
 */
function convertible(p: Readonly<PlayerState>): boolean {
  if (p.act === ActionKind.SHOT) return true;
  return p.act === ActionKind.KICK && (doubledKind(p.actKick) !== KickKind.NONE || isLobKind(p.actKick));
}

/**
 * Power bar: while the initiating button is held, p.actPower = hold ticks / fill ticks (fast power bar setting),
 * capped at 1, auto-released LT.chargeAfterFullTicks after full. On release charging ends, except (open play only;
 * set-piece kicks release at once) a tapped convertible kick of the ball at his feet keeps charging (power frozen)
 * until LT.tapGraceTicks (= T_INPUT.doubleTapTicks) after its press, and a held shot LT.lowDrivenGraceTicks after the
 * release, so a second press can still convert it. In open play a first-time foot kick (ball loose, arriving) stops
 * charging on the first tick its wind-up is done with the ball in his reach, so the contact meets the ball instead of
 * letting it roll past while the button is still held. A charge ended elsewhere (handler cap, interrupt) clears.
 */
export function chargeTick(s: SimState, ctl: ControllerState, grace: boolean): void {
  const cb = ctl.powerBtn;
  if (cb === 0) return;
  const slot = chargeSlotOf(ctl);
  const bi = bitIndex(cb);
  if (!validSlot(slot) || bi < 0 || bi >= 8) { clearCharge(ctl); return; }
  const p = s.players[slot]!;
  if (p.active !== 1 || p.act === ActionKind.NONE || p.actCharging !== 1) { clearCharge(ctl); return; }
  const b = s.ball;
  const atFeet = b.owner === slot && b.heldBy < 0;
  if (grace && isKickAct(p.act) && b.owner < 0 && b.heldBy < 0 && p.actT + 1 >= p.actContact &&
      b.y <= LT.firstTimeMaxHeight && ballEta(s, slot) === 0) {
    // Open play, first-time: wind-up done (actT + 1 this tick) and the ball in reach -> strike with this power.
    // (Set pieces: the dead ball sits in reach of the taker, whose bar fills as usual.)
    p.actCharging = 0;
    clearCharge(ctl);
    return;
  }
  const fill = fillTicks(ctl);
  if ((ctl.buttons & cb) !== 0) {
    const h = ctl.holdT[bi]!;
    if (h >= fill + LT.chargeAfterFullTicks) { p.actCharging = 0; clearCharge(ctl); return; }
    const v = h / fill;
    p.actPower = v >= 1 ? 1 : v;
    return;
  }
  const pressT = ctl.pressTick[bi]!;
  const relT = ctl.releaseTick[bi]!;
  let end = relT;
  if (grace && atFeet && convertible(p)) {
    if (relT - pressT < T_INPUT.tapTicks) end = pressT + LT.tapGraceTicks;
    else if (cb === Btn.SHOOT && p.act === ActionKind.SHOT) end = relT + LT.lowDrivenGraceTicks;
  }
  if (s.tick >= end) { p.actCharging = 0; clearCharge(ctl); }
}

/**
 * A set-piece / shoot-out module started a charging foot kick for this controller's player: attach the power bar to
 * the face button that is pressed this tick (or held with the latest press) so it fills and releases like play.
 */
export function adoptCharge(s: SimState, ctl: ControllerState): void {
  if (ctl.powerBtn !== 0 || !validSlot(ctl.slot)) return;
  const p = s.players[ctl.slot]!;
  if (p.actCharging !== 1 || !isKickAct(p.act)) return;
  const pressed = ctl.buttons & ~ctl.prevButtons;
  let best = -1;
  let bestT = -1;
  for (let bi = 0; bi < 4; bi++) {
    const bit = 1 << bi;
    if ((ctl.buttons & bit) === 0) continue;
    const t = (pressed & bit) !== 0 ? 1e15 : ctl.pressTick[bi]!;
    if (t > bestT) { bestT = t; best = bi; }
  }
  if (best >= 0) setCharge(ctl, 1 << best, ctl.slot);
}

// ---------------------------------------------------------------- holds and taps

function isTapRelease(ctl: ControllerState, bi: number): boolean {
  return ctl.releaseTick[bi]! - ctl.pressTick[bi]! < T_INPUT.tapTicks;
}

/** A face button was pressed at or after the press of modifier bi (the modifier was used in a combo). */
export function faceSince(ctl: ControllerState, bi: number): boolean {
  const t = ctl.pressTick[bi]!;
  for (let f = 0; f < 4; f++) if (ctl.pressTick[f]! >= t) return true;
  return false;
}

function ownPossession(s: SimState, team: number): boolean {
  const b = s.ball;
  const h = b.heldBy >= 0 ? b.heldBy : b.owner;
  return validSlot(h) && s.players[h]!.team === team;
}

/** Best teammate to help as second defender: fastest to the carrier (SIM-04 ticksToReach), not controlled, not keeper. */
export function bestHelper(s: SimState, team: number, exclude: number, carrier: number): number {
  const b = s.ball;
  const tx = validSlot(carrier) ? s.players[carrier]!.x : b.x;
  const tz = validSlot(carrier) ? s.players[carrier]!.z : b.z;
  const first = team === 0 ? 0 : 11;
  let best = -1;
  let bestT = 1e18;
  for (let i = first; i < first + 11; i++) {
    const q = s.players[i]!;
    if (i === exclude || q.active !== 1 || q.isKeeper === 1 || q.ctrl !== -1) continue;
    const t = ticksToReach(s, i, tx, tz);
    if (t < bestT) { bestT = t; best = i; }
  }
  return best;
}

function helperValid(s: SimState, slot: number, team: number, exclude: number): boolean {
  if (!validSlot(slot) || slot === exclude) return false;
  const q = s.players[slot]!;
  return q.active === 1 && q.team === team && q.isKeeper === 0 && q.ctrl === -1;
}

/**
 * Per-tick holds and taps for controller c's player p in context cls (IN_PLAY):
 *  - MOD_L tap (no face button during it, our ball, not a "change player" press) -> TAI-03 triggerRun;
 *  - MOD_R tap -> GKP-05 keeperPickUp for a keeper with the ball at his feet in his area, else TAI-02 callSupport;
 *  - defence: MOD_R held (or tapped: LT.secondDefTapTicks) -> ctrl.secondDef; THROUGH held -> GKP-03 keeper rush;
 *  - attack dribbler: stick released + SPRINT -> STOP_BALL; stick released + MOD_L held -> STOP_FACE_GOAL;
 *    SHIELD held -> SIM-05 applyShieldIntent (SHIELD action while held, stopped on release).
 */
export function modifierTick(s: SimState, c: number, ctl: ControllerState, p: PlayerState, cls: number, pressed: number, released: number, ev: EventSink): void {
  const slot = p.slot;
  const b = s.ball;
  const team = p.team;
  const tick = s.tick;
  const manual = canManualSwitch(s, c);
  const ourBall = ownPossession(s, team);

  // Taps.
  if ((released & Btn.MOD_L) !== 0 && !manual && ourBall && isTapRelease(ctl, BI.MOD_L) && !faceSince(ctl, BI.MOD_L) &&
      (ctl.seqA & SeqFlag.STOP_MODL) === 0) {
    triggerRun(s, team, ev);
  }
  if ((released & Btn.MOD_R) !== 0 && isTapRelease(ctl, BI.MOD_R) && !faceSince(ctl, BI.MOD_R)) {
    if (cls === Ctx.DEFENCE) {
      ctl.seqA |= SeqFlag.SD_TIMED;
      ctl.seqB = tick + LT.secondDefTapTicks;
    } else if (p.isKeeper === 1 && b.heldBy < 0 && (b.owner === slot || (b.owner < 0 && ballEta(s, slot) === 0)) && canHandle(s, slot)) {
      keeperPickUp(s, slot, ev);
    } else if (!manual && ourBall) {
      callSupport(s, team, ev);
    }
  }

  // Second defender.
  if (cls === Ctx.DEFENCE) {
    if ((ctl.seqA & (SeqFlag.SD_TIMED | SeqFlag.GPRESS)) !== 0 && tick > ctl.seqB) {
      ctl.seqA &= ~(SeqFlag.SD_TIMED | SeqFlag.GPRESS);
    }
    const active = (ctl.buttons & Btn.MOD_R) !== 0 || (ctl.seqA & (SeqFlag.SD_TIMED | SeqFlag.GPRESS)) !== 0;
    if (!active) ctl.secondDef = -1;
    else if (!helperValid(s, ctl.secondDef, team, slot)) ctl.secondDef = bestHelper(s, team, slot, oppCarrier(s, team));
    // Keeper rush on hold (press or hold of THROUGH / 2ND DEF swipe down).
    if ((ctl.buttons & Btn.THROUGH) !== 0) {
      const k = s.teams[team]!.keeperSlot;
      if (validSlot(k)) {
        const kp = s.players[k]!;
        if (kp.active === 1 && kp.team === team && kp.act !== ActionKind.GK_RUSH && isFree(kp)) startKeeperRush(s, k, ev);
      }
    }
  } else {
    ctl.secondDef = -1;
    ctl.seqA &= ~(SeqFlag.SD_TIMED | SeqFlag.GPRESS);
  }

  // Dribbler: stops and shield.
  const dribbling = cls === Ctx.ATTACK && b.owner === slot && b.heldBy < 0;
  const idle = ctl.stickIdleT > 0;
  if ((ctl.buttons & Btn.SPRINT) === 0 || !idle) ctl.seqA &= ~SeqFlag.STOP_SPRINT;
  if (dribbling) {
    const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if ((ctl.buttons & Btn.SPRINT) !== 0 && idle && (ctl.seqA & SeqFlag.STOP_SPRINT) === 0 && speed > LT.stopMinSpeed &&
        (ctl.stickIdleT <= LT.stopReleaseWindow || (pressed & Btn.SPRINT) !== 0)) {
      if (prepareFree(s, slot) && startSkill(s, slot, SkillMove.STOP_BALL, 0, 0, ev) === 1) ctl.seqA |= SeqFlag.STOP_SPRINT;
    }
    if (!manual && (ctl.buttons & Btn.MOD_L) !== 0 && idle && ctl.holdT[BI.MOD_L]! >= LT.stopHoldTicks &&
        (ctl.seqA & SeqFlag.STOP_MODL) === 0 && speed > LT.stopMinSpeed && !faceSince(ctl, BI.MOD_L)) {
      if (prepareFree(s, slot) && startSkill(s, slot, SkillMove.STOP_FACE_GOAL, 0, 0, ev) === 1) ctl.seqA |= SeqFlag.STOP_MODL;
    }
  }
  // Shield (SIM-05): held while dribbling starts / keeps the SHIELD action; release (or any other state) stops it.
  const shieldHeld = dribbling && (ctl.buttons & Btn.SHIELD) !== 0 ? 1 : 0;
  if (shieldHeld === 1 || p.act === ActionKind.SHIELD) applyShieldIntent(s, slot, shieldHeld, ev);
  if ((ctl.buttons & Btn.MOD_L) === 0) ctl.seqA &= ~SeqFlag.STOP_MODL;
}

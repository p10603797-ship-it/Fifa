/**
 * [SIM-15] Action input resolution: turns each controller's InputFrame (humans from the frames argument, CPU
 * brains from s.teams[t].cpu.out) into intents and actions for its controlled player, inside the sim so it
 * replays exactly. Tracks button edges / hold ticks / double-taps (s.ctrl[i].holdT, pressTick, releaseTick),
 * resolves modifier combos when the FACE button is pressed (never when the modifier is), buffers presses up to
 * T_INPUT.bufferTicks before the player can act, fills the power bar (p.actPower while p.actCharging; fast
 * power bar setting), maps context (attacking / defending / keeper in hands / aerial ball) to actions per the
 * section 9 and 10 tables, applies gestures (tap/double-tap/swipe targets), commands (tactics, subs, skip) and
 * routes restart phases to the set-piece input functions (SETPIECE_INPUT in sim/rules/restart.ts).
 * Calls SIM-16 switching for player changes. Never reads which device produced a frame.
 *
 * Per controller per tick (0..3; kind NONE skipped):
 *  1. Sanitise the frame (hostile values clamped; a missing frame is neutral, so nothing stays held), track
 *     edges: buttons/prevButtons, holdT[0..7], pressTick, releaseTick; stick mx/mz (radial, <= 1), stickIdleT.
 *  2. Commands: SKIP -> Btn.SKIP OR-ed into ctrl.buttons; SUBSTITUTE -> RUL-10 requestSub; QUICK_SUB is app-level;
 *     the rest -> TAI-14 applyCommand. With no HUMAN controller at all, humanFrames[0] buttons (+ SKIP) are still
 *     recorded into s.ctrl[0] so headless runs can skip cut-scenes.
 *  3. SIM-16 switchTick (ownership, manual MOD_L / RS-flick switching with the frame's aim, auto rules).
 *  4. Phase: IN_PLAY -> play (resolveActions/Move/Gesture); restart phases -> SETPIECE_INPUT[restart.kind] for
 *     both sides' controllers; SHOOT_OUT -> RUL-07 shootoutInput; cut-scenes -> nothing (charges released). Outside
 *     play the controlled player's stale stick intent is stopped first so he never keeps running.
 *  5. The controlled slot at this tick's PASS / LOB / THROUGH presses is recorded (a double tap needs both presses
 *     for the same player); ctrl.power / powerBtn mirror the power bar for the HUD.
 * Budget: O(controllers x 22) with small constants, allocation-free.
 */
import { CPU_CONTROLLER_BASE, MAX_HUMANS, NUM_SLOTS, SQUAD_SIZE } from '../../contracts/constants';
import { ActionKind, Command, ControllerKind, GestureKind, MatchPhase, RestartKind, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, createInputFrame, type InputFrame } from '../../contracts/input';
import { MoveMode, type ControllerState, type PlayerState, type SimState } from '../../contracts/state';
import { T_INPUT } from '../../contracts/tuning';
import { applyCommand } from '../../ai/tactics';
import { requestSub } from '../rules/subs';
import { SETPIECE_INPUT } from '../rules/restart';
import { shootoutInput } from '../rules/shootout';
import { canManualSwitch, switchTick } from './switching';
import { handToCpu } from './handoff';
import {
  adoptCharge, chargeTick, convertPresses, modifierTick, resolveFacePress, resolveKnockOn, resolveSkill,
} from './resolveActions';
import { moveTick } from './resolveMove';
import { resolveGesture } from './resolveGesture';
import {
  BTN_MASK, BufCode, Ctx, FACE_MASK, GR, LT, PREV_PRESS, PressFlag, Res, SeqFlag, chargeSlotOf, clearBuffer,
  clearCharge, controlContext, isDoubleTap, packGesture, packPress, pressFlags, recordPressSlots, setBuffer, unpackGesture,
  validSlot, withPressFlag,
} from './resolveShared';

/** Neutral frame for a missing human frame (never mutated). */
const NEUTRAL: InputFrame = createInputFrame();
/** Sanitised copy of the frame being resolved (rewritten for every controller every tick). */
const SF: InputFrame = createInputFrame();
const HOLD_CAP = 1_000_000;

// ---------------------------------------------------------------- frame sanitising

function axis(v: number): number {
  if (v > AXIS_SCALE) return AXIS_SCALE;
  if (v < -AXIS_SCALE) return -AXIS_SCALE;
  return v === v ? Math.trunc(v) : 0;
}

function intIn(v: number, lo: number, hi: number, dflt: number): number {
  if (!(v >= lo && v <= hi)) return dflt;
  return Math.trunc(v);
}

function sanitize(src: Readonly<InputFrame>): InputFrame {
  const f = SF;
  f.mx = axis(src.mx); f.mz = axis(src.mz); f.ax = axis(src.ax); f.az = axis(src.az);
  f.buttons = intIn(src.buttons, 0, 0x7fffffff, 0) & BTN_MASK;
  f.power = intIn(src.power, 0, 127, 0);
  f.curve = axis(src.curve);
  f.skill = intIn(src.skill, 0, SkillMove.HARD_STOP, SkillMove.NONE);
  f.cmd = intIn(src.cmd, 0, Command.HAND_TO_CPU, Command.NONE);
  f.cmdArg = intIn(src.cmdArg, -0x7fffffff, 0x7fffffff, 0);
  f.gesture = intIn(src.gesture, 0, GestureKind.BACK_FORTH_SWIPE, GestureKind.NONE);
  f.gx = intIn(src.gx, -1023, 1023, 0);
  f.gz = intIn(src.gz, -1023, 1023, 0);
  f.gSlot = intIn(src.gSlot, 0, NUM_SLOTS - 1, -1);
  f.gdx = axis(src.gdx); f.gdz = axis(src.gdz);
  f.gPower = intIn(src.gPower, 0, 127, 0);
  f.gCurve = axis(src.gCurve);
  f.gFlags = intIn(src.gFlags, 0, 0x7fffffff, 0) & 7;
  return f;
}

// ---------------------------------------------------------------- edges and commands

function trackEdges(s: SimState, c: number, ctl: ControllerState, f: Readonly<InputFrame>): void {
  const b = f.buttons;
  const prev = ctl.buttons;
  ctl.prevButtons = prev;
  ctl.buttons = b;
  for (let i = 0; i < 8; i++) {
    PREV_PRESS[c * 8 + i] = ctl.pressTick[i]!;
    const bit = 1 << i;
    if ((b & bit) !== 0) {
      if ((prev & bit) === 0) {
        ctl.holdT[i] = 1;
        ctl.pressTick[i] = s.tick;
      } else if (ctl.holdT[i]! < HOLD_CAP) {
        ctl.holdT[i] = ctl.holdT[i]! + 1;
      }
    } else {
      if ((prev & bit) !== 0) ctl.releaseTick[i] = s.tick;
      ctl.holdT[i] = 0;
    }
  }
  let mx = f.mx / AXIS_SCALE;
  let mz = f.mz / AXIS_SCALE;
  const m = Math.sqrt(mx * mx + mz * mz);
  if (m > 1) { mx /= m; mz /= m; }
  ctl.mx = mx;
  ctl.mz = mz;
  if (m < T_INPUT.stickIdle) ctl.stickIdleT = ctl.stickIdleT < HOLD_CAP ? ctl.stickIdleT + 1 : HOLD_CAP;
  else ctl.stickIdleT = 0;
}

function command(s: SimState, ctl: ControllerState, f: Readonly<InputFrame>, ev: EventSink): void {
  const cmd = f.cmd;
  if (cmd === Command.NONE || cmd === Command.QUICK_SUB) return;
  if (cmd === Command.SKIP) { ctl.buttons |= Btn.SKIP; return; }
  if (cmd === Command.SUBSTITUTE) {
    const out = f.cmdArg & 255;
    const inRoster = (f.cmdArg >> 8) & 255;
    if (out < NUM_SLOTS && inRoster < SQUAD_SIZE) requestSub(s, ctl.side, out, inRoster);
    return;
  }
  applyCommand(s, ctl.side, cmd, f.cmdArg, ev);
}

/** No HUMAN controller in the match: record humanFrames[0] buttons (+ SKIP) into ctrl[0] for cut-scene skips. */
function recordHeadless(s: SimState, f0: Readonly<InputFrame> | undefined): void {
  const ctl = s.ctrl[0];
  if (!ctl || ctl.kind !== ControllerKind.NONE) return;
  let b = 0;
  if (f0) {
    b = intIn(f0.buttons, 0, 0x7fffffff, 0) & BTN_MASK;
    if (f0.cmd === Command.SKIP) b |= Btn.SKIP;
  }
  ctl.prevButtons = ctl.buttons;
  ctl.buttons = b;
}

// ---------------------------------------------------------------- charge / power helpers

function releaseCharge(s: SimState, ctl: ControllerState): void {
  if (ctl.powerBtn === 0) return;
  const slot = chargeSlotOf(ctl);
  if (validSlot(slot)) {
    const p = s.players[slot]!;
    if (p.act !== ActionKind.NONE && p.actCharging === 1) p.actCharging = 0;
  }
  clearCharge(ctl);
}

function poweredAct(a: ActionKind): boolean {
  return a === ActionKind.KICK || a === ActionKind.SHOT || a === ActionKind.HEADER || a === ActionKind.VOLLEY ||
    a === ActionKind.GK_THROW || a === ActionKind.GK_KICK;
}

/** ctrl.power for the HUD: the charging player's bar, else the controlled player's running kick power, else 0. */
function mirrorPower(s: SimState, ctl: ControllerState): void {
  let slot = -1;
  if (ctl.powerBtn !== 0) {
    slot = chargeSlotOf(ctl);
  } else if (validSlot(ctl.slot)) {
    const q = s.players[ctl.slot]!;
    if (poweredAct(q.act) && q.actDone === 0) slot = ctl.slot;
  }
  if (!validSlot(slot)) { ctl.power = 0; return; }
  const v = s.players[slot]!.actPower;
  ctl.power = v > 0 ? (v < 1 ? v : 1) : 0;
}

// ---------------------------------------------------------------- buffer

function bufferResult(s: SimState, ctl: ControllerState, code: number, packed: number, r: number): void {
  if (r === Res.RETRY) setBuffer(ctl, code, packed, s.tick + T_INPUT.bufferTicks);
  else if (r === Res.PENDING) setBuffer(ctl, code, withPressFlag(packed, PressFlag.PENDING), s.tick + LT.firstTimeWaitTicks);
}

function retryBuffer(s: SimState, c: number, ctl: ControllerState, ev: EventSink): void {
  const code = ctl.bufAction % 16;
  if (code === BufCode.NONE) return;
  if (s.tick > ctl.bufExpire) { clearBuffer(ctl); return; }
  let r: number = Res.DROP;
  if (code >= BufCode.PASS && code <= BufCode.THROUGH) {
    const arg = ctl.bufArg;
    r = resolveFacePress(s, c, ctl, code - 1, arg, true, ev);
    const pending = (pressFlags(arg) & PressFlag.PENDING) !== 0;
    if (r === Res.PENDING && !pending) {
      ctl.bufArg = withPressFlag(arg, PressFlag.PENDING);
      ctl.bufExpire = s.tick + LT.firstTimeWaitTicks;
    } else if (r === Res.RETRY && pending) {
      const cap = s.tick + LT.pendingBusyTicks;
      if (ctl.bufExpire > cap) ctl.bufExpire = cap;
    }
  } else if (code === BufCode.SKILL) {
    const a = ctl.bufArg;
    r = resolveSkill(s, ctl, a % 16, (a - (a % 16)) / 16, true, ev);
  } else if (code === BufCode.KNOCK_ON) {
    const a = ctl.bufArg;
    r = resolveKnockOn(s, ctl, (a % 256) - 128, (a - (a % 256)) / 256 - 128, true, ev);
  } else if (code === BufCode.GESTURE) {
    unpackGesture(ctl);
    r = resolveGesture(s, c, ctl, true, ev);
  }
  if (r === Res.STARTED || r === Res.DROP) clearBuffer(ctl);
}

// ---------------------------------------------------------------- phases

function playTick(s: SimState, c: number, ctl: ControllerState, f: Readonly<InputFrame>, ev: EventSink): void {
  const slot = ctl.slot;
  if (!validSlot(slot) || s.players[slot]!.active !== 1) {
    clearBuffer(ctl);
    releaseCharge(s, ctl);
    ctl.secondDef = -1;
    ctl.receiver = -1;
    return;
  }
  const p = s.players[slot]!;
  const cls = controlContext(s, slot);
  const pressed = ctl.buttons & ~ctl.prevButtons;
  const released = ctl.prevButtons & ~ctl.buttons;
  const used = convertPresses(s, c, ctl, p, pressed & FACE_MASK, ev);
  chargeTick(s, ctl, true);
  moveTick(s, c, ctl, p, cls);

  const newFace = pressed & FACE_MASK & ~used;
  const skill = f.skill;
  const knock = (pressed & Btn.RS_FLICK) !== 0 && (ctl.buttons & Btn.SPRINT) !== 0 && cls === Ctx.ATTACK && !canManualSwitch(s, c);
  const gesture = f.gesture;
  if (newFace === 0 && skill === SkillMove.NONE && !knock && gesture === GestureKind.NONE) retryBuffer(s, c, ctl, ev);
  else clearBuffer(ctl);

  if (gesture !== GestureKind.NONE) {
    GR.kind = gesture; GR.gSlot = f.gSlot; GR.gx = f.gx; GR.gz = f.gz; GR.gdx = f.gdx; GR.gdz = f.gdz;
    GR.gPower = f.gPower; GR.gCurve = f.gCurve; GR.gFlags = f.gFlags; GR.cls = cls;
    const r = resolveGesture(s, c, ctl, false, ev);
    if (r === Res.RETRY) {
      packGesture(ctl, GR);
      ctl.bufExpire = s.tick + T_INPUT.bufferTicks;
    }
  }
  if (newFace !== 0) {
    // [FEEL-1] 4 = L2 (SHIELD) held: SHOOT -> trivela (resolved at the face press, like every combo).
    const mods = ((ctl.buttons & Btn.MOD_L) !== 0 ? 1 : 0) | ((ctl.buttons & Btn.MOD_R) !== 0 ? 2 : 0) |
      ((ctl.buttons & Btn.SHIELD) !== 0 ? 4 : 0);
    for (let bi = 0; bi < 4; bi++) {
      if ((newFace & (1 << bi)) === 0) continue;
      const dbl = isDoubleTap(ctl, c, bi, s.tick) ? PressFlag.DOUBLE : 0;
      const packed = packPress(mods, cls, f.power, f.curve, dbl);
      bufferResult(s, ctl, bi + 1, packed, resolveFacePress(s, c, ctl, bi, packed, false, ev));
    }
  }
  if (skill !== SkillMove.NONE) {
    if (resolveSkill(s, ctl, skill, cls, false, ev) === Res.RETRY) {
      setBuffer(ctl, BufCode.SKILL, skill + 16 * cls, s.tick + T_INPUT.bufferTicks);
    }
  }
  if (knock) {
    if (resolveKnockOn(s, ctl, f.ax, f.az, false, ev) === Res.RETRY) {
      setBuffer(ctl, BufCode.KNOCK_ON, (f.ax + 128) + 256 * (f.az + 128), s.tick + T_INPUT.bufferTicks);
    }
  }
  modifierTick(s, c, ctl, p, cls, pressed, released, ev);
}

function restartKindOf(phase: MatchPhase): RestartKind {
  switch (phase) {
    case MatchPhase.KICK_OFF: return RestartKind.KICK_OFF;
    case MatchPhase.THROW_IN: return RestartKind.THROW_IN;
    case MatchPhase.GOAL_KICK: return RestartKind.GOAL_KICK;
    case MatchPhase.CORNER: return RestartKind.CORNER;
    case MatchPhase.FREE_KICK: return RestartKind.FREE_KICK;
    case MatchPhase.PENALTY: return RestartKind.PENALTY;
    default: return RestartKind.NONE;
  }
}

/** Stop a stale stick intent (DIRECT) of a free player outside play; intents set by rules/actions are kept. */
function stopStaleIntent(p: PlayerState): void {
  if (p.act !== ActionKind.NONE || p.moveMode !== MoveMode.DIRECT) return;
  p.moveMode = MoveMode.STOP;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
}

function resolveOne(s: SimState, c: number, ctl: ControllerState, src: Readonly<InputFrame>, ev: EventSink): void {
  const f = sanitize(src);
  trackEdges(s, c, ctl, f);
  command(s, ctl, f, ev);
  const prevSlot = ctl.slot;
  switchTick(s, c, ev, f);
  if (ctl.slot !== prevSlot) {
    if (ctl.powerBtn !== 0 && chargeSlotOf(ctl) === prevSlot) releaseCharge(s, ctl);
    ctl.receiver = -1;
  }
  const phase = s.match.phase;
  if (phase === MatchPhase.IN_PLAY) {
    playTick(s, c, ctl, f, ev);
  } else {
    clearBuffer(ctl);
    ctl.secondDef = -1;
    ctl.receiver = -1;
    ctl.seqA &= ~(SeqFlag.SD_TIMED | SeqFlag.GPRESS | SeqFlag.STOP_SPRINT | SeqFlag.STOP_MODL);
    if (validSlot(ctl.slot)) stopStaleIntent(s.players[ctl.slot]!);
    const rk = restartKindOf(phase);
    if (rk !== RestartKind.NONE || phase === MatchPhase.SHOOT_OUT) {
      if (phase === MatchPhase.SHOOT_OUT) {
        shootoutInput(s, c, f, ev);
      } else {
        const k = s.match.restart.kind;
        const fn = SETPIECE_INPUT[k >= RestartKind.KICK_OFF && k <= RestartKind.PENALTY ? k : rk];
        if (fn) fn(s, c, f, ev);
      }
      adoptCharge(s, ctl);
      chargeTick(s, ctl, false);
    } else {
      releaseCharge(s, ctl);
    }
  }
  recordPressSlots(ctl, ctl.buttons & ~ctl.prevButtons);
  mirrorPower(s, ctl);
}

export function resolveControllers(s: SimState, humanFrames: readonly InputFrame[], ev: EventSink): void {
  let humans = 0;
  for (let c = 0; c < s.ctrl.length; c++) if (s.ctrl[c]!.kind === ControllerKind.HUMAN) humans++;
  if (humans === 0) recordHeadless(s, humanFrames[0]);
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.NONE || (ctl.side !== 0 && ctl.side !== 1)) continue;
    let f: Readonly<InputFrame> = NEUTRAL;
    if (c < MAX_HUMANS) {
      if (ctl.kind === ControllerKind.HUMAN) {
        const h = humanFrames[c];
        if (h && h.cmd === Command.HAND_TO_CPU) { handToCpu(s, c); continue; }
        if (h) f = h;
      }
    } else {
      const t = s.teams[c - CPU_CONTROLLER_BASE];
      if (t && t.cpu.active === 1) f = t.cpu.out;
    }
    resolveOne(s, c, ctl, f, ev);
  }
}

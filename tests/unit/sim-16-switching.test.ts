/**
 * SIM-16 player switching: ownership rules (carrier, receiver, keeper in hands, restarts, shoot-out), manual MOD_L
 * and directional RS-flick switching, auto-switch settings, lock-out timing, two humans on one side, determinism and
 * the glitch-list lines "Switching: flip-flops between two players; switches away from the player about to
 * receive; lands on a sent-off or substituted player".
 *
 * States come from initMatch (no step(): the pipeline modules are being built in parallel); each test tick emulates
 * the resolver's per-controller edge tracking (prevButtons/buttons/mx/mz) and calls switchTick, exactly as SIM-15
 * does inside resolveControllers.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import {
  ActionKind, AssistLevel, AutoSwitch, ControllerKind, KickKind, MatchPhase, RestartKind,
} from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import {
  createMatchConfig, MoveMode, type BallState, type ControllerConfig, type SimState,
} from '../../src/contracts/state';
import { T_INPUT } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import {
  bestSwitchTarget, canManualSwitch, debugSwitchEff, ensureControlledPlayer, manualSwitch, releasePlayer,
  SWITCH_MODE, SWITCH_TUNING, switchTick, switchTo,
} from '../../src/sim/control/switching';

// ---------------------------------------------------------------- helpers

interface HumanSpec { side: number; auto?: AutoSwitch; slot?: number }

const LOCK = T_INPUT.switchLockTicks;
const MANUAL_LOCK = T_INPUT.switchLockTicks + SWITCH_TUNING.manualHoldTicks;

function noHuman(): ControllerConfig {
  return { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };
}

/**
 * initMatch with the given humans (CPU brains on human-less sides), phase IN_PLAY by default, everyone parked far
 * from the test area (team 0 outfield on z = -32, team 1 on z = +32, keepers on their lines), ball still at the
 * centre, loose and untouched.
 */
function setup(humans: HumanSpec[], phase: MatchPhase = MatchPhase.IN_PLAY, seed = 11): SimState {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = [0, 1].map((i) => {
    const h = humans[i];
    return h
      ? { kind: ControllerKind.HUMAN, side: h.side, assist: AssistLevel.ASSISTED, autoSwitch: h.auto ?? AutoSwitch.AIR_AND_LOOSE, fastPower: 0 }
      : noHuman();
  });
  const s = initMatch(cfg);
  s.match.phase = phase;
  s.match.prevPhase = phase;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.vx = 0; p.vz = 0;
    p.fx = p.team === 0 ? 1 : -1; p.fz = 0;
    if (p.isKeeper === 1) { p.x = p.team === 0 ? -51 : 51; p.z = 0; } else {
      p.x = -40 + ((i % 11) - 1) * 9;
      p.z = p.team === 0 ? -32 : 32;
    }
  }
  const b = s.ball;
  b.x = 0; b.y = BALL_RADIUS; b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = -1; b.heldBy = -1; b.passTarget = -1; b.shotBy = -1;
  humans.forEach((h, i) => {
    if (h.slot === undefined) return;
    s.ctrl[i]!.slot = h.slot;
    s.players[h.slot]!.ctrl = i;
  });
  return s;
}

function place(s: SimState, slot: number, x: number, z: number, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = vx; p.vz = vz;
}

/** A loose ball (no owner, no pass target) last touched now by `touchTeam`. */
function loose(s: SimState, x: number, z: number, vx = 0, vz = 0, extra: Partial<BallState> = {}): void {
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = x; b.y = BALL_RADIUS; b.z = z; b.vx = vx; b.vy = 0; b.vz = vz; b.grounded = 1;
  b.passTarget = -1; b.shotBy = -1; b.lastTouch = -1; b.lastTouchTeam = 1; b.lastTouchTick = s.tick;
  b.lastKickBy = -1; b.lastKickTeam = -1;
  Object.assign(b, extra);
}

/** Give the ball to `slot` (at his feet). */
function own(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.owner = slot; b.heldBy = -1; b.x = p.x + 0.4 * p.fx; b.y = BALL_RADIUS; b.z = p.z + 0.4 * p.fz;
  b.vx = p.vx; b.vy = 0; b.vz = p.vz; b.grounded = 1; b.passTarget = -1; b.shotBy = -1;
  b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick;
}

/** Our pass from `from` to `to`, ball just struck at the passer moving toward the receiver at `speed`. */
function pass(s: SimState, from: number, to: number, speed: number): void {
  const a = s.players[from]!;
  const r = s.players[to]!;
  const dx = r.x - a.x, dz = r.z - a.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = a.x + (dx / d) * 0.6; b.y = BALL_RADIUS; b.z = a.z + (dz / d) * 0.6;
  b.vx = (dx / d) * speed; b.vy = 0; b.vz = (dz / d) * speed; b.grounded = 1;
  b.passTarget = to; b.passX = r.x; b.passZ = r.z; b.shotBy = -1;
  b.lastTouch = from; b.lastTouchTeam = a.team; b.lastTouchTick = s.tick;
  b.lastKickBy = from; b.lastKickTeam = a.team; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick;
}

/** Ball rolls on by its velocity for one tick (no physics needed for these tests). */
function roll(s: SimState): void {
  const b = s.ball;
  b.x += b.vx / 60; b.z += b.vz / 60;
}

const EV = createEventBuffer();
const FR: InputFrame[] = [createInputFrame(), createInputFrame()];

/** Consistency of the controller <-> player links (the invariant every tick must keep). */
function checkControl(s: SimState): void {
  const seen = new Array<number>(NUM_SLOTS).fill(-1);
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    const live = (ctl.kind === ControllerKind.HUMAN || ctl.kind === ControllerKind.CPU) && (ctl.side === 0 || ctl.side === 1);
    if (!live) {
      expect(ctl.slot, `dead controller ${c} holds a slot`).toBe(-1);
      continue;
    }
    if (ctl.slot < 0) continue;
    const p = s.players[ctl.slot]!;
    expect(p.active, `controller ${c} on inactive player ${ctl.slot}`).toBe(1);
    expect(p.team, `controller ${c} on the other side`).toBe(ctl.side);
    expect(p.ctrl, `player ${ctl.slot} does not point back at controller ${c}`).toBe(c);
    expect(seen[ctl.slot], `controllers ${seen[ctl.slot]} and ${c} share player ${ctl.slot}`).toBe(-1);
    seen[ctl.slot] = c;
    if (ctl.nextSwitch >= 0) {
      const n = s.players[ctl.nextSwitch]!;
      expect(n.active, `nextSwitch ${ctl.nextSwitch} inactive`).toBe(1);
      expect(n.team).toBe(ctl.side);
      expect(n.isKeeper, 'nextSwitch is a keeper').toBe(0);
      expect(ctl.nextSwitch).not.toBe(ctl.slot);
    }
  }
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.ctrl < 0) continue;
    expect(s.ctrl[p.ctrl]!.slot, `player ${i} claims controller ${p.ctrl}`).toBe(i);
  }
}

/**
 * One tick of switching for every controller, like the resolver: frames for humans (f0/f1), CPU brains from
 * teams[t].cpu.out (cpu0/cpu1). Returns this tick's events.
 */
function tick(s: SimState, f0?: Partial<InputFrame>, f1?: Partial<InputFrame>, cpu?: (Partial<InputFrame> | undefined)[]): SimEvent[] {
  s.tick++;
  EV.begin(s.tick);
  clearInputFrame(FR[0]!); clearInputFrame(FR[1]!);
  if (f0) Object.assign(FR[0]!, f0);
  if (f1) Object.assign(FR[1]!, f1);
  for (let t = 0; t < 2; t++) {
    const o = s.teams[t]!.cpu.out;
    clearInputFrame(o);
    const spec = cpu?.[t];
    if (spec) Object.assign(o, spec);
  }
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.NONE || ctl.side < 0) continue;
    const f = c < 2 ? FR[c]! : s.teams[c - 2]!.cpu.out;
    ctl.prevButtons = ctl.buttons;
    ctl.buttons = f.buttons;
    ctl.mx = f.mx / AXIS_SCALE;
    ctl.mz = f.mz / AXIS_SCALE;
    switchTick(s, c, EV, c < 2 ? f : undefined);
  }
  const out: SimEvent[] = [];
  for (let k = 0; k < EV.count; k++) out.push({ ...EV.get(k) });
  checkControl(s);
  return out;
}

function switchesOf(events: readonly SimEvent[], c: number): SimEvent[] {
  return events.filter((e) => e.type === EventType.SWITCH && e.c === c);
}

const L1 = { buttons: Btn.MOD_L };
const flick = (ax: number, az: number): Partial<InputFrame> => ({ buttons: Btn.RS_FLICK, ax, az });

/** Opponent (team 1) carrier `slot` at (x, z) running with (vx, vz): our defence context. */
function oppCarrier(s: SimState, slot: number, x: number, z: number, vx: number, vz: number): void {
  place(s, slot, x, z, vx, vz);
  s.players[slot]!.fx = vx === 0 && vz === 0 ? -1 : vx / Math.sqrt(vx * vx + vz * vz);
  s.players[slot]!.fz = vx === 0 && vz === 0 ? 0 : vz / Math.sqrt(vx * vx + vz * vz);
  own(s, slot);
}

const EFFS: number[] = new Array<number>(NUM_SLOTS).fill(0);
function effOf(s: SimState, side: number, slot: number): number {
  debugSwitchEff(s, side, EFFS);
  return EFFS[slot]!;
}

// ---------------------------------------------------------------- tests

describe('SIM-16 validity and switchTo', () => {
  it('a controller without a player gets the best outfield player (never the keeper) and SWITCH(-1 -> slot)', () => {
    const s = setup([{ side: 0 }]);
    loose(s, -47, 0); // nearest player is the keeper on his line
    place(s, 7, -38, 3);
    const ev = tick(s);
    expect(s.ctrl[0]!.slot).toBe(7);
    const sw = switchesOf(ev, 0);
    expect(sw).toHaveLength(1);
    expect([sw[0]!.a, sw[0]!.b, sw[0]!.c]).toEqual([-1, 7, 0]);
  });

  it('switchTo clears the previous player, resets his intent to AI (incl. a power charge) and starts the lock-out', () => {
    const s = setup([{ side: 0, slot: 5 }]);
    const p5 = s.players[5]!;
    p5.moveMode = MoveMode.DIRECT; p5.ix = 1; p5.iz = 0.5; p5.wantSprint = 1; p5.lookAt = 1; p5.actCharging = 1;
    EV.begin(s.tick);
    switchTo(s, 0, 7, EV);
    expect(s.ctrl[0]!.slot).toBe(7);
    expect(s.players[7]!.ctrl).toBe(0);
    expect(p5.ctrl).toBe(-1);
    expect([p5.moveMode, p5.ix, p5.iz, p5.wantSprint, p5.lookAt, p5.actCharging]).toEqual([MoveMode.STOP, 0, 0, 0, 0, 0]);
    expect(s.ctrl[0]!.switchLockT).toBe(LOCK);
    expect(EV.count).toBe(1);
    expect([EV.get(0).type, EV.get(0).a, EV.get(0).b, EV.get(0).c]).toEqual([EventType.SWITCH, 5, 7, 0]);
  });

  it('switchTo refuses inactive players, the other side, out-of-range slots and a player another controller holds', () => {
    const s = setup([{ side: 0, slot: 5 }, { side: 0, slot: 6 }]);
    s.players[8]!.active = 0;
    EV.begin(s.tick);
    switchTo(s, 0, 8, EV);
    switchTo(s, 0, 15, EV);
    switchTo(s, 0, -1, EV);
    switchTo(s, 0, 22, EV);
    switchTo(s, 0, 2.5, EV);
    switchTo(s, 0, 6, EV);
    expect(s.ctrl[0]!.slot).toBe(5);
    expect(s.ctrl[1]!.slot).toBe(6);
    expect(EV.count).toBe(0);
  });

  it('a controller that sits out never holds a player', () => {
    const s = setup([{ side: 0, slot: 5 }]);
    s.ctrl[0]!.kind = ControllerKind.NONE;
    s.ctrl[0]!.side = -1;
    EV.begin(s.tick);
    ensureControlledPlayer(s, 0, EV);
    expect(s.ctrl[0]!.slot).toBe(-1);
    expect(s.players[5]!.ctrl).toBe(-1);
  });

  it('stale p.ctrl claims (pointing at a controller that does not control them) are cleared', () => {
    const s = setup([{ side: 0, slot: 5 }]);
    s.players[9]!.ctrl = 0; // inconsistent leftover
    tick(s);
    expect(s.players[9]!.ctrl).toBe(-1);
    expect(s.ctrl[0]!.slot).toBe(5);
  });
});

describe('SIM-16 ownership rules', () => {
  it('possession follow: control moves to our carrier the tick he gains the ball (every setting, ignores the lock-out)', () => {
    for (const auto of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 5, auto }]);
      place(s, 5, -20, 0);
      place(s, 7, 0, 0);
      s.ctrl[0]!.switchLockT = 50;
      own(s, 7);
      const ev = tick(s);
      expect(s.ctrl[0]!.slot, `auto=${auto}`).toBe(7);
      expect(switchesOf(ev, 0).map((e) => [e.a, e.b])).toEqual([[5, 7]]);
      // In possession manual switching does not apply and there is no next-switch marker.
      tick(s, L1);
      expect(s.ctrl[0]!.slot).toBe(7);
      expect(s.ctrl[0]!.nextSwitch).toBe(-1);
    }
  });

  it('receiver: Assisted switching takes the intended receiver as the pass is struck', () => {
    const s = setup([{ side: 0, slot: 6 }]);
    place(s, 6, 0, 0);
    place(s, 9, 20, 0);
    place(s, 8, 8, 1);
    pass(s, 6, 9, 14);
    const ev = tick(s);
    expect(s.ctrl[0]!.slot).toBe(9);
    expect(switchesOf(ev, 0).map((e) => [e.a, e.b])).toEqual([[6, 9]]);
  });

  it('glitch "Switching: switches away from the player about to receive" — never while our pass travels to him', () => {
    for (const auto of [AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 6, auto }]);
      place(s, 6, 0, 0);
      place(s, 9, 22, 0);
      place(s, 8, 9, 0.8); // right on the ball's path, nearer to the ball the whole time
      place(s, 7, 5, -2);
      pass(s, 6, 9, 15);
      let switches = 0;
      for (let t = 0; t < 75; t++) {
        // Mash every switch input during the flight.
        const f = t % 3 === 0 ? L1 : t % 3 === 1 ? flick(0, 0) : flick(-127, 0);
        switches += switchesOf(tick(s, f), 0).length;
        expect(s.ctrl[0]!.slot, `t=${t}`).toBe(9);
        expect(s.ctrl[0]!.nextSwitch).toBe(-1);
        roll(s);
      }
      expect(switches).toBe(1);
    }
  });

  it('receiver with auto-switch OFF: the passer keeps control in flight; the receiver takes over on reception', () => {
    const s = setup([{ side: 0, slot: 6, auto: AutoSwitch.OFF }]);
    place(s, 6, 0, 0);
    place(s, 9, 20, 0);
    pass(s, 6, 9, 14);
    for (let t = 0; t < 40; t++) {
      tick(s);
      expect(s.ctrl[0]!.slot).toBe(6);
      roll(s);
    }
    own(s, 9);
    const ev = tick(s);
    expect(s.ctrl[0]!.slot).toBe(9);
    expect(switchesOf(ev, 0).map((e) => [e.a, e.b])).toEqual([[6, 9]]);
  });

  it('a pass deflected by an opponent is no longer "our pass": the receiver rule stops applying', () => {
    const s = setup([{ side: 0, slot: 6 }]);
    place(s, 6, 0, 0);
    place(s, 9, 24, 0);
    place(s, 8, 7, 0.3); // on the deflected ball's line, far ahead of the receiver
    pass(s, 6, 9, 14);
    s.ball.lastTouchTeam = 1; // deflection
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(8); // a loose ball now: the teammate who gets there first
    expect(canManualSwitch(s, 0)).toBe(true);
  });

  it('keeper in hands: the keeper takes control (so the human distributes), every setting', () => {
    for (const auto of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 7, auto }]);
      place(s, 0, -48, 2);
      place(s, 7, -30, 5);
      own(s, 0);
      s.ball.heldBy = 0;
      s.ctrl[0]!.switchLockT = 40;
      tick(s);
      expect(s.ctrl[0]!.slot).toBe(0);
    }
  });

  it('after the keeper releases the ball: receiver at the throw (Assisted) or on reception (OFF); never left on the keeper', () => {
    // Assisted: the throw's receiver at once.
    let s = setup([{ side: 0, slot: 0 }]);
    place(s, 0, -48, 2);
    place(s, 4, -30, 20);
    pass(s, 0, 4, 16);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(4);
    // OFF: the keeper keeps control while his pass travels, then the receiver.
    s = setup([{ side: 0, slot: 0, auto: AutoSwitch.OFF }]);
    place(s, 0, -48, 2);
    place(s, 4, -30, 20);
    pass(s, 0, 4, 16);
    for (let t = 0; t < 20; t++) { tick(s); expect(s.ctrl[0]!.slot).toBe(0); roll(s); }
    own(s, 4);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(4);
    // A punch / clearance with no receiver: control leaves the keeper for the best outfield player at once.
    for (const auto of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE]) {
      s = setup([{ side: 0, slot: 0, auto }]);
      place(s, 0, -48, 2);
      place(s, 3, -30, 4);
      loose(s, -40, 3, 12, 0, { lastTouchTeam: 0, lastTouch: 0, y: 3, vy: 8, grounded: 0 });
      tick(s);
      expect(s.ctrl[0]!.slot, `auto=${auto}`).not.toBe(0);
      expect(s.players[s.ctrl[0]!.slot]!.isKeeper).toBe(0);
    }
  });

  it('a keeper who drops the ball at his feet keeps control (no keeper -> outfield -> keeper flip-flop)', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 0, -46, 2);
    place(s, 3, -38, 6);
    own(s, 0);
    s.ball.heldBy = 0;
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(0);
    // GK_RELEASE: the ball drops loose right at his feet, then he takes it again.
    loose(s, -45.6, 2, 0, 0, { lastTouchTeam: 0, lastTouch: 0 });
    let n = 0;
    for (let t = 0; t < 5; t++) n += switchesOf(tick(s), 0).length;
    own(s, 0);
    for (let t = 0; t < 5; t++) n += switchesOf(tick(s), 0).length;
    expect(n).toBe(0);
    expect(s.ctrl[0]!.slot).toBe(0);
    // He plays it out: control leaves him.
    pass(s, 0, 3, 12);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(3);
  });

  it('an opponent keeper holding the ball is never taken; our controller defends', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 11, 48, 0);
    own(s, 11);
    s.ball.heldBy = 11;
    tick(s);
    expect(s.players[s.ctrl[0]!.slot]!.team).toBe(0);
    expect(canManualSwitch(s, 0)).toBe(true);
  });
});

describe('SIM-16 manual switching', () => {
  it('MOD_L picks the best effective defender: a goal-side defender beats a nearer chaser behind the carrier', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 20, 0);
    place(s, 7, -7, 0.5); // 3 m behind the carrier, chasing
    place(s, 3, -22, 1); // 12 m goal-side, in his path
    oppCarrier(s, 19, -10, 0, -5, 0);
    expect(canManualSwitch(s, 0)).toBe(true);
    tick(s);
    expect(s.ctrl[0]!.nextSwitch).toBe(3);
    const ev = tick(s, L1);
    expect(s.ctrl[0]!.slot).toBe(3);
    expect(switchesOf(ev, 0).map((e) => [e.a, e.b])).toEqual([[9, 3]]);
  });

  it('MOD_L excludes the current player and never picks the keeper, even when the keeper is nearest', () => {
    const s = setup([{ side: 0, slot: 2 }]);
    place(s, 0, -50, 0);
    place(s, 2, -38, 6);
    place(s, 4, -30, -10);
    oppCarrier(s, 19, -45, 1, -3, 0);
    tick(s, L1);
    expect(s.ctrl[0]!.slot).not.toBe(2);
    expect(s.ctrl[0]!.slot).not.toBe(0);
    expect(s.players[s.ctrl[0]!.slot]!.isKeeper).toBe(0);
  });

  it('directional RS flick picks the teammate most aligned with the flick from the current player', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 7, 0, 0);
    place(s, 8, 10, 0.5); // +x
    place(s, 6, 0.5, -10); // -z
    place(s, 5, -0.5, 12); // +z
    place(s, 9, -12, 0); // -x, farther
    oppCarrier(s, 19, -20, 10, 0, 0);
    // RS_FLICK is an edge: a neutral tick separates two flicks (as a real stick does).
    tick(s, flick(127, 0));
    expect(s.ctrl[0]!.slot).toBe(8);
    tick(s);
    tick(s, flick(-127, 0)); // from 8 toward -x: 7 (10 m) beats 9 (22 m)
    expect(s.ctrl[0]!.slot).toBe(7);
    tick(s);
    tick(s, flick(0, 127));
    expect(s.ctrl[0]!.slot).toBe(5);
    tick(s);
    tick(s, flick(0, -127)); // from 5 back toward -z: 7 is nearer on the line than 6
    expect(s.ctrl[0]!.slot).toBe(7);
    tick(s);
    tick(s, flick(10, -120));
    expect(s.ctrl[0]!.slot).toBe(6);
    // A flick bit stuck on for several frames switches once, not every tick.
    tick(s);
    let n = 0;
    for (let t = 0; t < 10; t++) n += switchesOf(tick(s, flick(127, 0)), 0).length;
    expect(n).toBe(1);
  });

  it('directional switch is always available: flicks on alternate ticks both switch (no debounce), MOD_L does not', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 7, 0, 0);
    place(s, 8, 10, 0);
    place(s, 9, -10, 0);
    oppCarrier(s, 19, -20, 10, 0, 0);
    const a = switchesOf(tick(s, flick(127, 0)), 0).length;
    tick(s);
    const b = switchesOf(tick(s, flick(-127, 0)), 0).length;
    expect([a, b]).toEqual([1, 1]);
    expect(s.ctrl[0]!.slot).toBe(7);
  });

  it('directional switch differs from MOD_L: it follows the flick, not the best defender', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 0, 0);
    place(s, 3, -22, 1);
    place(s, 8, 12, 0);
    oppCarrier(s, 19, -10, 0, -5, 0);
    tick(s);
    expect(s.ctrl[0]!.nextSwitch).toBe(3);
    tick(s, flick(127, 0));
    expect(s.ctrl[0]!.slot).toBe(8);
  });

  it('a flick without an aim direction falls back to the best defender; switching inputs are ignored in attack', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 20, 0);
    place(s, 3, -22, 1);
    oppCarrier(s, 19, -10, 0, -5, 0);
    tick(s, flick(0, 0));
    expect(s.ctrl[0]!.slot).toBe(3);
    own(s, 3); // our ball now
    place(s, 8, -20, 3);
    tick(s);
    for (let t = 0; t < 10; t++) {
      tick(s, t % 2 === 0 ? L1 : flick(127, 0));
      expect(s.ctrl[0]!.slot).toBe(3);
    }
  });

  it('manualSwitch (tap a teammate when defending): defence context only, outfield only, starts the manual hold', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 20, 0);
    place(s, 4, -15, -6);
    oppCarrier(s, 19, -10, 0, -5, 0);
    EV.begin(s.tick);
    expect(manualSwitch(s, 0, 0, EV)).toBe(false); // own keeper: that tap is a keeper rush, never a switch
    expect(manualSwitch(s, 0, 15, EV)).toBe(false); // opponent
    expect(manualSwitch(s, 0, 4, EV)).toBe(true);
    expect(s.ctrl[0]!.slot).toBe(4);
    expect(s.ctrl[0]!.switchLockT).toBe(MANUAL_LOCK);
    own(s, 4);
    expect(canManualSwitch(s, 0)).toBe(false);
    expect(manualSwitch(s, 0, 9, EV)).toBe(false);
  });
});

describe('SIM-16 lock-out timing', () => {
  function defenceScene(): SimState {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 20, 0);
    place(s, 7, -6, 3);
    place(s, 3, -22, 1);
    place(s, 4, -18, -8);
    oppCarrier(s, 19, -10, 0, -5, 0);
    return s;
  }

  it('MOD_L is debounced for switchLockTicks after a manual switch (a quick double press never flip-flops back)', () => {
    // Second press 17 ticks after the first switch: ignored.
    let s = defenceScene();
    let n = 0;
    for (let t = 1; t <= 30; t++) n += switchesOf(tick(s, t === 1 || t === 18 ? L1 : undefined), 0).length;
    expect(n).toBe(1);
    // Second press exactly switchLockTicks after: honoured.
    s = defenceScene();
    n = 0;
    for (let t = 1; t <= 30; t++) n += switchesOf(tick(s, t === 1 || t === 1 + LOCK ? L1 : undefined), 0).length;
    expect(n).toBe(2);
  });

  it('MOD_L right after an automatic or ownership switch is honoured (the user can always override auto)', () => {
    const s = defenceScene();
    EV.begin(s.tick);
    switchTo(s, 0, 4, EV); // as an auto switch would
    expect(s.ctrl[0]!.switchLockT).toBe(LOCK);
    const ev = tick(s, L1);
    expect(switchesOf(ev, 0)).toHaveLength(1);
  });

  it('auto-switch waits exactly switchLockTicks after any switch', () => {
    const s = setup([{ side: 0, slot: 5 }]);
    place(s, 5, -20, -10);
    place(s, 7, -25, 0);
    place(s, 8, 12, 3);
    own(s, 7);
    const first = tick(s); // tick 1: possession follow 5 -> 7, lock-out starts
    expect(switchesOf(first, 0)).toHaveLength(1);
    loose(s, 10, 2, 1, 0); // tick 2: the ball breaks loose by 8, far from 7
    let at = -1;
    for (let t = 2; t <= 40 && at < 0; t++) {
      if (switchesOf(tick(s), 0).length > 0) at = t;
      s.ball.lastTouchTick = s.tick; // keep the situation fresh
    }
    expect(s.ctrl[0]!.slot).toBe(8);
    expect(at).toBe(1 + LOCK);
  });

  it('auto-switch waits switchLockTicks + manualHoldTicks after a manual switch', () => {
    const s = defenceScene();
    tick(s, L1); // tick 1: manual switch
    const b = s.ctrl[0]!.slot;
    expect(s.ctrl[0]!.switchLockT).toBe(MANUAL_LOCK);
    const c = [2, 5, 6, 8].find((k) => k !== b)!;
    place(s, c, 30, 20);
    loose(s, 30.5, 20, 0, 0);
    let at = -1;
    for (let t = 2; t <= MANUAL_LOCK + 10 && at < 0; t++) {
      s.ball.lastTouchTick = s.tick; // a fresh touch each tick: only the lock-out holds auto back
      if (switchesOf(tick(s), 0).length > 0) at = t;
    }
    expect(s.ctrl[0]!.slot).toBe(c);
    expect(at).toBe(1 + MANUAL_LOCK);
  });
});

describe('SIM-16 auto-switch settings', () => {
  it('AIR_AND_LOOSE / AUTO: a loose ball goes to the teammate who clearly reaches it first; OFF never switches', () => {
    for (const auto of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 7, auto }]);
      place(s, 7, -15, 0);
      place(s, 8, 11, 3);
      loose(s, 10, 0, 1, 0);
      let n = 0;
      for (let t = 0; t < 40; t++) n += switchesOf(tick(s), 0).length;
      if (auto === AutoSwitch.OFF) {
        expect(s.ctrl[0]!.slot).toBe(7);
        expect(n).toBe(0);
        expect(s.ctrl[0]!.nextSwitch).toBe(8); // manual switching still offers him
      } else {
        expect(s.ctrl[0]!.slot, `auto=${auto}`).toBe(8);
        expect(n).toBe(1);
      }
    }
  });

  it('opponent ground pass: AIR_AND_LOOSE leaves it (not loose), AUTO switches; a lofted one is an air ball for both', () => {
    const run = (auto: AutoSwitch, lofted: boolean): number => {
      const s = setup([{ side: 0, slot: 7, auto }]);
      place(s, 7, -30, 12);
      place(s, 8, 2, 0.3); // standing in the passing lane
      place(s, 15, -6, 0);
      loose(s, 10, 0, -12, 0, { passTarget: 15, lastTouchTeam: 1, lastKickTeam: 1, lastKickBy: 19 });
      if (lofted) Object.assign(s.ball, { y: 1.5, vy: 6, grounded: 0 });
      tick(s);
      return s.ctrl[0]!.slot;
    };
    expect(run(AutoSwitch.AIR_AND_LOOSE, false)).toBe(7);
    expect(run(AutoSwitch.AUTO, false)).toBe(8);
    expect(run(AutoSwitch.AIR_AND_LOOSE, true)).not.toBe(7);
    expect(run(AutoSwitch.AUTO, true)).not.toBe(7);
    expect(run(AutoSwitch.OFF, true)).toBe(7);
  });

  it('never auto-switches during a shot in flight', () => {
    const s = setup([{ side: 0, slot: 7, auto: AutoSwitch.AUTO }]);
    place(s, 7, -10, 20);
    place(s, 3, -40, 1);
    loose(s, -30, 0, -25, 0, { shotBy: 19, lastTouchTeam: 1 });
    for (let t = 0; t < 20; t++) { tick(s); expect(s.ctrl[0]!.slot).toBe(7); }
    loose(s, -38, 1.5, 2, 0, { lastTouchTeam: 0 }); // parried out to 3: a loose ball again
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(3);
  });

  it('AUTO switches when the current defender is beaten; AIR_AND_LOOSE does not; not when he is still goal-side', () => {
    const run = (auto: AutoSwitch, curX: number): number => {
      const s = setup([{ side: 0, slot: 7, auto }]);
      place(s, 7, curX, 0);
      place(s, 3, -34, 2);
      oppCarrier(s, 19, -20, 0, -6, 0);
      for (let t = 0; t < 30; t++) tick(s);
      return s.ctrl[0]!.slot;
    };
    expect(run(AutoSwitch.AUTO, -14)).toBe(3); // carrier past him by 6 m
    expect(run(AutoSwitch.AIR_AND_LOOSE, -14)).toBe(7);
    expect(run(AutoSwitch.OFF, -14)).toBe(7);
    expect(run(AutoSwitch.AUTO, -24)).toBe(7); // still goal-side: not beaten
  });

  it('loose-ball auto-switching acts on a fresh situation only (within autoWindowTicks of the latest touch)', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 7, -15, 0);
    place(s, 8, 11, 3);
    loose(s, 10, 0);
    s.tick += SWITCH_TUNING.autoWindowTicks + 5; // touched long ago
    for (let t = 0; t < 20; t++) tick(s);
    expect(s.ctrl[0]!.slot).toBe(7);
    s.ball.lastTouchTick = s.tick; // touched again
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(8);
  });
});

describe('SIM-16 glitch regressions', () => {
  it('glitch "Switching: flip-flops between two players" — two equally placed teammates never ping-pong', () => {
    for (const auto of [AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 9, auto }]);
      place(s, 9, 35, 25);
      loose(s, 0, 0);
      let n = 0;
      for (let t = 0; t < 400; t++) {
        // The better of the two alternates every tick by a few centimetres.
        const j = t % 2 === 0 ? 0.3 : -0.3;
        place(s, 7, -4 + j, 0);
        place(s, 8, 4 + j, 0);
        s.ball.lastTouchTick = s.tick; // worst case: the situation stays "fresh" all the time
        n += switchesOf(tick(s), 0).length;
      }
      expect(n, `auto=${auto}`).toBeLessThanOrEqual(1);
    }
  });

  it('glitch "Switching: flip-flops between two players" — auto never undoes a manual choice in the same scramble', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 35, 25);
    place(s, 7, -2, 0);
    place(s, 8, 7, 0);
    loose(s, 0, 0);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(7); // auto: 7 clearly first
    for (let t = 0; t < 20; t++) tick(s);
    tick(s, L1);
    expect(s.ctrl[0]!.slot).toBe(8); // the user wants 8
    let n = 0;
    for (let t = 0; t < 400; t++) n += switchesOf(tick(s), 0).length;
    expect(n).toBe(0);
    expect(s.ctrl[0]!.slot).toBe(8);
  });

  it('glitch "Switching: flip-flops between two players" — two teammates converging on a rolling ball', () => {
    for (const auto of [AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const s = setup([{ side: 0, slot: 9, auto }]);
      place(s, 9, 35, 25);
      place(s, 7, -12, 0);
      place(s, 8, 12, 0.5);
      loose(s, 0, -6, 0, 2.5); // rolls across between them
      const seq: number[] = [];
      for (let t = 0; t < 240; t++) {
        // Both sprint at the ball; their speeds jitter by 5 % in opposite phase every tick.
        for (const [slot, sp] of [[7, t % 2 === 0 ? 6.3 : 6.0], [8, t % 2 === 0 ? 6.0 : 6.3]] as const) {
          const p = s.players[slot]!;
          const dx = s.ball.x - p.x, dz = s.ball.z - p.z, d = Math.sqrt(dx * dx + dz * dz);
          if (d > 0.5) place(s, slot, p.x + (dx / d) * sp / 60, p.z + (dz / d) * sp / 60, (dx / d) * sp, (dz / d) * sp);
        }
        roll(s);
        if (t % 20 === 0) s.ball.lastTouchTick = s.tick; // keep re-opening the auto window
        for (const e of switchesOf(tick(s), 0)) seq.push(e.b);
      }
      // At most one pick of the two, and never back and forth.
      expect(seq.length, `auto=${auto} seq=${seq.join(',')}`).toBeLessThanOrEqual(1);
    }
  });

  it('glitch "Switching: flip-flops between two players" — even with real swings, no A-B-A within a second', () => {
    const s = setup([{ side: 0, slot: 9, auto: AutoSwitch.AUTO }]);
    place(s, 9, 35, 25);
    loose(s, 0, 0, 2, 0.5);
    const at: number[] = [];
    const to: number[] = [];
    for (let t = 0; t < 300; t++) {
      // Teleporting teammates swap who is ahead of the ball every 10 ticks (a far bigger swing than real play).
      const ph = (t % 20) < 10 ? 1 : -1;
      place(s, 7, s.ball.x - 3 * ph, s.ball.z + 1);
      place(s, 8, s.ball.x + 3 * ph, s.ball.z - 1);
      roll(s);
      s.ball.lastTouchTick = s.tick;
      for (const e of switchesOf(tick(s), 0)) { at.push(s.tick); to.push(e.b); }
    }
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(LOCK);
    for (let i = 2; i < at.length; i++) {
      if (to[i] === to[i - 2]) expect(at[i]! - at[i - 2]!, 'A-B-A within a second').toBeGreaterThanOrEqual(60);
    }
  });

  it('glitch "Switching: switches away from the player about to receive" — a loose ball about to reach him', () => {
    const s = setup([{ side: 0, slot: 7, auto: AutoSwitch.AUTO }]);
    loose(s, 0, 0);
    place(s, 8, 0.1, 0.1); // at the ball: arrives "now"
    // Put 7 just close enough to be about to receive while 8 is clearly earlier.
    let found = false;
    for (let d = 0.3; d < 6 && !found; d += 0.05) {
      place(s, 7, -d, 0);
      const e7 = effOf(s, 0, 7);
      const e8 = effOf(s, 0, 8);
      if (e7 <= SWITCH_TUNING.aboutToReceiveTicks && e8 + SWITCH_TUNING.autoMarginTicks < e7) found = true;
    }
    expect(found).toBe(true);
    for (let t = 0; t < 30; t++) {
      s.ball.lastTouchTick = s.tick;
      tick(s);
      expect(s.ctrl[0]!.slot).toBe(7);
    }
    // Control: the same picture with 7 farther away does switch.
    place(s, 7, -8, 0);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(8);
  });

  it('glitch "Switching: lands on a sent-off player" — the controlled player is sent off', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 7, 0, 0);
    place(s, 8, 5, 0);
    oppCarrier(s, 19, -5, 0, -3, 0);
    tick(s);
    // RUL-10 sendOff: inactive and parked; whether or not it released p.ctrl, the next tick repairs control.
    const p7 = s.players[7]!;
    p7.active = 0; p7.x = 60; p7.z = 42;
    const ev = tick(s);
    expect(s.ctrl[0]!.slot).not.toBe(7);
    expect(s.players[s.ctrl[0]!.slot]!.active).toBe(1);
    expect(p7.ctrl).toBe(-1);
    expect(switchesOf(ev, 0).map((e) => e.a)).toEqual([7]);
  });

  it('glitch "Switching: lands on a sent-off player" — no switch path ever selects an inactive player', () => {
    const s = setup([{ side: 0, slot: 9, auto: AutoSwitch.AUTO }]);
    place(s, 9, 30, 0);
    place(s, 4, -30, -12);
    const off = s.players[8]!;
    place(s, 8, -10.5, 0.5); // the best-placed player of all... but sent off
    off.active = 0;
    oppCarrier(s, 19, -10, 0, -5, 0);
    tick(s);
    expect(s.ctrl[0]!.nextSwitch).not.toBe(8);
    expect(bestSwitchTarget(s, 0, 0, 0)).not.toBe(8);
    tick(s, L1);
    expect(s.ctrl[0]!.slot).not.toBe(8);
    // Flick straight at him from the current player.
    const cur = s.players[s.ctrl[0]!.slot]!;
    const dx = off.x - cur.x, dz = off.z - cur.z, l = Math.sqrt(dx * dx + dz * dz);
    tick(s);
    tick(s, flick(Math.round((dx / l) * 127), Math.round((dz / l) * 127)));
    expect(s.ctrl[0]!.slot).not.toBe(8);
    EV.begin(s.tick);
    switchTo(s, 0, 8, EV);
    expect(manualSwitch(s, 0, 8, EV)).toBe(false);
    expect(s.ctrl[0]!.slot).not.toBe(8);
    // Loose ball at his feet: auto never lands on him either.
    loose(s, -10.4, 0.4);
    for (let t = 0; t < 30; t++) { tick(s); expect(s.ctrl[0]!.slot).not.toBe(8); }
  });

  it('glitch "Switching: lands on a substituted player" — released control is re-validated at once', () => {
    // RUL-10 substitution: the slot keeps its position with a fresh player, control is released via releasePlayer.
    const s = setup([{ side: 0, slot: 7 }, { side: 1, slot: 15 }], MatchPhase.THROW_IN);
    const r = s.match.restart;
    r.kind = RestartKind.THROW_IN; r.team = 1; r.taker = 15;
    place(s, 7, -5, 30);
    place(s, 8, -2, 25);
    place(s, 15, -4, 34);
    own(s, 15);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(7);
    s.players[7]!.rosterIdx = 14; // fresh substitute in slot 7
    EV.begin(s.tick);
    releasePlayer(s, 7, EV);
    checkControl(s);
    expect(s.ctrl[0]!.slot).toBeGreaterThanOrEqual(0); // never a tick without a valid player
    expect(s.players[s.ctrl[0]!.slot]!.ctrl).toBe(0);
    // The substituted-off player of the taking side: the taker is released and the new taker is controlled.
    r.taker = 16;
    place(s, 16, -3, 34);
    EV.begin(s.tick);
    releasePlayer(s, 15, EV);
    checkControl(s);
    expect(s.ctrl[1]!.slot).toBe(16);
    // If RUL-10 only cleared p.ctrl, the next tick still repairs it.
    s.players[s.ctrl[0]!.slot]!.ctrl = -1;
    tick(s);
    expect(s.ctrl[0]!.slot).toBeGreaterThanOrEqual(0);
  });

  it('glitch "Switching: lands on a sent-off or substituted player" — releasePlayer on a sent-off player re-picks at once', () => {
    const s = setup([{ side: 0, slot: 7 }]);
    place(s, 7, 0, 0);
    place(s, 8, 4, 2);
    oppCarrier(s, 19, -5, 0, -3, 0);
    tick(s);
    s.players[7]!.active = 0;
    EV.begin(s.tick);
    releasePlayer(s, 7, EV);
    checkControl(s);
    expect(s.ctrl[0]!.slot).not.toBe(7);
    expect(s.ctrl[0]!.slot).toBeGreaterThanOrEqual(0);
  });
});

describe('SIM-16 two humans on the same side', () => {
  it('never control the same player: distinct picks, MOD_L and switchTo skip the other human\'s player', () => {
    const s = setup([{ side: 0 }, { side: 0 }]);
    loose(s, 0, 0);
    place(s, 7, -2, 0);
    place(s, 8, -5, 1);
    place(s, 6, -9, -3);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(7);
    expect(s.ctrl[1]!.slot).toBe(8);
    for (let t = 0; t < 40; t++) {
      tick(s, undefined, t % 4 === 0 ? L1 : undefined);
      expect(s.ctrl[1]!.slot).not.toBe(7);
    }
    EV.begin(s.tick);
    switchTo(s, 1, 7, EV);
    expect(s.ctrl[1]!.slot).not.toBe(7);
    expect(s.ctrl[0]!.slot).toBe(7);
  });

  it('possession and passes: no stealing; the passer\'s controller gets the receiver; the nearer human gets an interception', () => {
    const s = setup([{ side: 0, slot: 7 }, { side: 0, slot: 8 }]);
    place(s, 7, 0, 0);
    place(s, 8, -10, 10);
    place(s, 10, -12, 13); // close to P2's player
    place(s, 9, 2, -4); // close to P1's player
    own(s, 7);
    tick(s);
    expect([s.ctrl[0]!.slot, s.ctrl[1]!.slot]).toEqual([7, 8]);
    // P1 passes to 10, who is next to P2's player: P1 (the passer) takes the receiver.
    pass(s, 7, 10, 16);
    tick(s);
    expect([s.ctrl[0]!.slot, s.ctrl[1]!.slot]).toEqual([10, 8]);
    // An AI teammate (9) wins a loose ball after an opponent's touch: the human whose player is nearest takes him.
    place(s, 9, -9, 7);
    loose(s, -9, 7);
    s.ball.lastKickTeam = 1;
    own(s, 9);
    s.ball.lastKickTeam = 1;
    tick(s);
    expect([s.ctrl[0]!.slot, s.ctrl[1]!.slot]).toEqual([10, 9]);
  });

  it('a sent-off player of one human is never replaced by the other human\'s player', () => {
    const s = setup([{ side: 0, slot: 7 }, { side: 0, slot: 8 }]);
    place(s, 7, -3, 0);
    place(s, 8, -1, 0); // the best replacement, but P2 has him
    place(s, 6, -20, 5);
    oppCarrier(s, 19, -5, 0, -3, 0);
    s.players[7]!.active = 0;
    tick(s);
    expect(s.ctrl[1]!.slot).toBe(8);
    expect(s.ctrl[0]!.slot).not.toBe(8);
    expect(s.ctrl[0]!.slot).not.toBe(7);
  });
});

describe('SIM-16 restarts, shoot-out and cut-scenes', () => {
  it('restart: the taking side controls the taker; the defending side keeps its player and may switch manually', () => {
    const s = setup([{ side: 0, slot: 7 }, { side: 1, slot: 15 }], MatchPhase.CORNER);
    const r = s.match.restart;
    r.kind = RestartKind.CORNER; r.team = 0; r.taker = 10;
    place(s, 10, 52, 33);
    loose(s, 52, 33.5);
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(10);
    expect(s.ctrl[1]!.slot).toBe(15);
    expect(canManualSwitch(s, 0)).toBe(false);
    expect(canManualSwitch(s, 1)).toBe(true);
    expect(s.ctrl[0]!.nextSwitch).toBe(-1);
    expect(s.ctrl[1]!.nextSwitch).toBeGreaterThanOrEqual(0);
    tick(s, L1, L1);
    expect(s.ctrl[0]!.slot).toBe(10);
    expect(s.ctrl[1]!.slot).not.toBe(15);
  });

  it('penalty: the defending side controls its keeper (to choose the dive), the taking side its taker', () => {
    const s = setup([{ side: 0, slot: 7 }, { side: 1, slot: 15 }], MatchPhase.PENALTY);
    const r = s.match.restart;
    r.kind = RestartKind.PENALTY; r.team = 1; r.taker = 19;
    tick(s, L1);
    expect(s.ctrl[0]!.slot).toBe(s.teams[0]!.keeperSlot);
    expect(s.ctrl[1]!.slot).toBe(19);
    expect(canManualSwitch(s, 0)).toBe(false);
    // After the kick (IN_PLAY, shot in flight) the keeper goes back to the keeper AI.
    s.match.phase = MatchPhase.IN_PLAY;
    loose(s, -45, 1, -25, 0, { shotBy: 19, lastTouchTeam: 1 });
    place(s, 3, -30, 5);
    tick(s);
    expect(s.players[s.ctrl[0]!.slot]!.isKeeper).toBe(0);
  });

  it('a restart whose record does not match the phase forces nothing', () => {
    const s = setup([{ side: 0, slot: 7 }], MatchPhase.FREE_KICK);
    const r = s.match.restart;
    r.kind = RestartKind.NONE; r.team = 0; r.taker = 10;
    tick(s);
    expect(s.ctrl[0]!.slot).toBe(7);
  });

  it('shoot-out: the kicking side controls the kicker, the other side its keeper', () => {
    const s = setup([{ side: 0, slot: 7 }, { side: 1, slot: 15 }], MatchPhase.SHOOT_OUT);
    const so = s.match.shootout;
    so.active = 1; so.team = 0; so.kicker = 9; so.keeper = 11;
    tick(s);
    expect([s.ctrl[0]!.slot, s.ctrl[1]!.slot]).toEqual([9, 11]);
    so.team = 1; so.kicker = 20; so.keeper = 0;
    tick(s);
    expect([s.ctrl[0]!.slot, s.ctrl[1]!.slot]).toEqual([0, 20]);
  });

  it('cut-scenes: control stays valid, no switching, no marker', () => {
    for (const phase of [MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME]) {
      const s = setup([{ side: 0, slot: 7 }], phase);
      place(s, 8, 1, 0);
      loose(s, 0, 0);
      for (let t = 0; t < 30; t++) tick(s, t % 2 === 0 ? L1 : flick(127, 0));
      expect(s.ctrl[0]!.slot).toBe(7);
      expect(s.ctrl[0]!.nextSwitch).toBe(-1);
    }
  });
});

describe('SIM-16 CPU brains', () => {
  it('a CPU controller follows the carrier, uses AUTO whatever its setting, and switches via its own frame (MOD_L, flick)', () => {
    const s = setup([]);
    expect(s.ctrl[2]!.kind).toBe(ControllerKind.CPU);
    s.ctrl[2]!.autoSwitch = AutoSwitch.OFF; // ignored: CPU brains use AUTO
    place(s, 7, -14, 0);
    place(s, 3, -34, 2);
    place(s, 8, -10, 15);
    oppCarrier(s, 19, -20, 0, -6, 0);
    tick(s);
    tick(s);
    expect(s.ctrl[2]!.slot).toBe(3); // beaten-defender rule
    expect(s.ctrl[3]!.slot).toBe(19); // the other CPU follows its carrier
    for (let t = 0; t < 70; t++) tick(s);
    // Flick via cpu.out toward +z from 3: player 8.
    tick(s, undefined, undefined, [{ buttons: Btn.RS_FLICK, ax: 60, az: 110 }]);
    expect(s.ctrl[2]!.slot).toBe(8);
    for (let t = 0; t < 70; t++) tick(s);
    tick(s, undefined, undefined, [{ buttons: Btn.MOD_L }]);
    expect(s.ctrl[2]!.slot).not.toBe(8);
    own(s, 7);
    tick(s);
    expect(s.ctrl[2]!.slot).toBe(7);
  });
});

describe('SIM-16 next-switch marker', () => {
  it('nextSwitch is what MOD_L would pick, in defence only', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 9, 20, 0);
    place(s, 7, -7, 0.5);
    place(s, 3, -22, 1);
    place(s, 4, -15, -8);
    oppCarrier(s, 19, -10, 0, -5, 0);
    for (let t = 0; t < 5; t++) {
      tick(s);
      const marker = s.ctrl[0]!.nextSwitch;
      expect(marker).toBe(bestSwitchTarget(s, 0, 0, 0));
      tick(s, L1);
      expect(s.ctrl[0]!.slot).toBe(marker);
      for (let k = 0; k < LOCK; k++) tick(s);
    }
    own(s, s.ctrl[0]!.slot);
    tick(s);
    expect(s.ctrl[0]!.nextSwitch).toBe(-1);
  });

  it('arrival estimates by situation: carrier path with goal-side bonus, loose ball, our possession', () => {
    const s = setup([{ side: 0, slot: 9 }]);
    place(s, 7, -7, 0.5);
    place(s, 3, -22, 1);
    oppCarrier(s, 19, -10, 0, -5, 0);
    const out = new Array<number>(NUM_SLOTS).fill(0);
    expect(debugSwitchEff(s, 0, out)).toBe(SWITCH_MODE.CARRIER);
    expect(out[3]!).toBeLessThan(out[7]!);
    expect(out[15]!).toBeGreaterThanOrEqual(1e9); // other side
    s.players[4]!.active = 0;
    debugSwitchEff(s, 0, out);
    expect(out[4]!).toBeGreaterThanOrEqual(1e9);
    loose(s, -8, 0);
    expect(debugSwitchEff(s, 0, out)).toBe(SWITCH_MODE.LOOSE);
    expect(out[7]!).toBeLessThan(out[3]!);
    own(s, 3);
    expect(debugSwitchEff(s, 0, out)).toBe(SWITCH_MODE.BALL);
    // A stunned / tackling player is effectively later.
    loose(s, -8, 0);
    debugSwitchEff(s, 0, out);
    const before = out[7]!;
    s.players[7]!.stunT = 30;
    debugSwitchEff(s, 0, out);
    expect(out[7]!).toBeGreaterThan(before);
    s.players[7]!.stunT = 0;
    s.players[7]!.act = ActionKind.STUMBLE; s.players[7]!.actDur = 40; s.players[7]!.actT = 0;
    debugSwitchEff(s, 0, out);
    expect(out[7]!).toBeGreaterThan(before);
  });
});

describe('SIM-16 determinism', () => {
  /** A scripted 900-tick defence/attack sequence with moving players, ball phases and switch inputs. */
  function script(s: SimState, from: number, to: number, log: number[]): void {
    for (let t = from; t < to; t++) {
      const k = t % 300;
      // Players drift along deterministic paths.
      for (let i = 1; i < 11; i++) {
        const p = s.players[i]!;
        p.vx = ((i * 7 + t) % 13) / 13 - 0.5;
        p.vz = ((i * 5 + t) % 11) / 11 - 0.5;
        p.x = Math.max(-50, Math.min(50, p.x + p.vx * 0.5));
        p.z = Math.max(-33, Math.min(33, p.z + p.vz * 0.5));
      }
      if (k === 0) oppCarrier(s, 19, -5, 3, -5, 1);
      if (k > 0 && k < 100) { place(s, 19, s.players[19]!.x - 5 / 60, s.players[19]!.z, -5, 0); own(s, 19); }
      if (k === 100) loose(s, s.ball.x, s.ball.z, -6, 4, { y: 1, vy: 5, grounded: 0 });
      if (k > 100 && k < 160) roll(s);
      if (k === 160) own(s, (t / 300 | 0) % 2 === 0 ? 7 : 8);
      if (k === 200) pass(s, s.ball.owner >= 0 ? s.ball.owner : 7, 9, 14);
      if (k > 200 && k < 260) roll(s);
      if (k === 260) loose(s, s.ball.x, s.ball.z, 2, -1);
      const f = k % 37 === 0 ? L1 : k % 53 === 0 ? flick((t * 31) % 255 - 127, (t * 17) % 255 - 127) : undefined;
      const ev = tick(s, f);
      for (const e of ev) if (e.type === EventType.SWITCH) log.push(e.tick, e.a, e.b, e.c);
      log.push(s.ctrl[0]!.slot, s.ctrl[0]!.nextSwitch, s.ctrl[0]!.switchLockT, s.ctrl[3]!.slot);
    }
  }

  it('same seed and inputs give the same switches and state hash; a mid-run clone continues identically', () => {
    const a = setup([{ side: 0 }], MatchPhase.IN_PLAY, 5);
    const b = setup([{ side: 0 }], MatchPhase.IN_PLAY, 5);
    const la: number[] = [];
    const lb: number[] = [];
    script(a, 0, 450, la);
    script(b, 0, 450, lb);
    const c = cloneState(a);
    const lc: number[] = [];
    const la2: number[] = [];
    script(a, 450, 900, la2);
    script(c, 450, 900, lc);
    script(b, 450, 900, lb);
    expect(la).toEqual(lb.slice(0, la.length));
    expect(la2).toEqual(lc);
    expect(la.concat(la2)).toEqual(lb);
    expect(hashState(a)).toBe(hashState(b));
    expect(hashState(a)).toBe(hashState(c));
    expect(la.filter((_, i) => i % 4 === 0).length).toBeGreaterThan(100);
    // The script exercised switching for real.
    const switches = la.length + la2.length;
    expect(switches).toBeGreaterThan(0);
  });
});

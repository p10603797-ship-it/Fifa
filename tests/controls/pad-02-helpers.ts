/**
 * PAD-02 test helpers: mock Standard Gamepad objects, a rig that runs the real pad manager (PAD-01) + pad mapper
 * (PAD-02) on a fake animation-frame clock, and a "pad match" that feeds the mapper's frames into the real step()
 * pipeline (one sample per 60 Hz tick, 1 or 2 animation frames per tick).
 */
import { AssistLevel, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import type { SimEvent } from '../../src/contracts/events';
import { createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import type { Settings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { createPadManager, PadButton, type PadManager } from '../../src/input/pad/manager';
import { createPadSource, type PadInputSource, type PadSourceOptions } from '../../src/input/pad/mapper';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { makeScenario } from '../harness/scenario';

export { PadButton };

export interface MockButton { pressed: boolean; touched: boolean; value: number }

export interface MockPad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  timestamp: number;
  axes: number[];
  buttons: MockButton[];
}

export const STANDARD_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
export const GENERIC_ID = 'USB Gamepad (Vendor: 0079 Product: 0011)';

export function mockPad(index = 0, id = STANDARD_ID, mapping = 'standard', nButtons = 17): MockPad {
  return {
    id, index, connected: true, mapping, timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}

/** Set button b to analogue value v (pressed when v > 0.5, like a browser's digital threshold). */
export function setBtn(p: MockPad, b: number, v: number): void {
  p.buttons[b]!.value = v;
  p.buttons[b]!.pressed = v > 0.5;
  p.buttons[b]!.touched = v > 0;
}

export interface PadRig {
  list: (MockPad | null)[];
  pad: MockPad;
  mgr: PadManager;
  src: PadInputSource;
  /** Current fake time, ms. */
  now(): number;
  /** One animation frame: advance the clock by ms and poll through the source. */
  frame(ms?: number): void;
  /** Advance the clock without polling. */
  advance(ms: number): void;
  /** sample() into a fresh frame copy for `state`. */
  sample(state: SimState, projector?: CameraProjector | null, side?: number): InputFrame;
  /** Raw source sample into `out` (no copy). */
  sampleInto(out: InputFrame, ctx: InputSampleContext): void;
  press(b: number, v?: number): void;
  release(b: number): void;
  /** Left stick, screen space (x right, y down). */
  left(x: number, y: number): void;
  /** Right stick, screen space. */
  right(x: number, y: number): void;
}

export interface RigOptions extends Partial<Omit<PadSourceOptions, 'key' | 'manager' | 'now'>> {
  pad?: MockPad;
  /** Start time, ms. */
  t0?: number;
  /** Poll once before creating the source (the pad is already known to the manager). */
  prepoll?: boolean;
}

export function settingsWithRemaps(remaps: Record<string, number[]>): { get(): Readonly<Settings> } {
  const s = { controls: { pad: { familyOverride: 0, rumble: true, remaps } } } as unknown as Settings;
  return { get: () => s };
}

export function padRig(o: RigOptions = {}): PadRig {
  const pad = o.pad ?? mockPad(0);
  const list: (MockPad | null)[] = [pad, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  let t = o.t0 ?? 1000;
  if (o.prepoll !== false) mgr.poll(t);
  const src = createPadSource({
    key: 'pad:1', manager: mgr, now: () => t, onPause: o.onPause ?? (() => {}), settings: o.settings,
    rightStick: o.rightStick, sequences: o.sequences,
  });
  const rig: PadRig = {
    list, pad, mgr, src,
    now: () => t,
    frame(ms = 1000 / 120) {
      t += ms;
      src.pollFrame!(t);
    },
    advance(ms) {
      t += ms;
    },
    sample(state, projector = null, side = 0) {
      const f = createInputFrame();
      src.sample(f, { tick: state.tick + 1, human: 0, side, state, projector });
      return { ...f };
    },
    sampleInto(out, ctx) {
      src.sample(out, ctx);
    },
    press(b, v = 1) { setBtn(pad, b, v); },
    release(b) { setBtn(pad, b, 0); },
    left(x, y) { pad.axes[0] = x; pad.axes[1] = y; },
    right(x, y) { pad.axes[2] = x; pad.axes[3] = y; },
  };
  return rig;
}

// ---------------------------------------------------------------- scenes

export interface SceneOpts {
  slot?: number;
  x?: number;
  z?: number;
  vx?: number;
  vz?: number;
  /** 'feet' = the controlled player owns the ball (default), 'loose' = left where it is, 'none' = parked. */
  ball?: 'feet' | 'loose' | 'none';
  assist?: AssistLevel;
  seed?: number;
  phase?: MatchPhase;
  /** Skill stars of the controlled player (default 5: every move allowed). */
  skillMoves?: number;
}

/** A quiet IN_PLAY scene: P1 (side 0) controls `slot`, CPU brains off, everyone else parked away from the action. */
export function scene(o: SceneOpts = {}): SimState {
  const slot = o.slot ?? 9;
  const s = makeScenario({
    phase: o.phase ?? MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot, assist: o.assist ?? AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
    seed: o.seed ?? 7,
  });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE;
    ctl.side = -1;
    ctl.slot = -1;
    s.teams[c - 2]!.cpu.active = 0;
  }
  for (let i = 0; i < 22; i++) {
    if (i === slot) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    const k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; } else { p.x = team === 0 ? -44 : 44; p.z = -30 + k * 5.5; }
    p.vx = 0; p.vz = 0; p.fx = team === 0 ? 1 : -1; p.fz = 0;
  }
  const p = s.players[slot]!;
  p.x = o.x ?? 10; p.z = o.z ?? 0; p.vx = o.vx ?? 0; p.vz = o.vz ?? 0; p.fx = 1; p.fz = 0;
  s.attrs[slot]!.skillMoves = o.skillMoves ?? 5;
  const b = s.ball;
  const mode = o.ball ?? 'feet';
  if (mode === 'feet') {
    b.x = p.x + 0.5; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = p.vx; b.vy = 0; b.vz = p.vz;
    b.grounded = 1; b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = 0;
    b.passTarget = -1; b.shotBy = -1;
  } else if (mode === 'none') {
    b.owner = -1; b.heldBy = -1; b.x = -30; b.z = 30; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0; b.y = 0.11; b.grounded = 1;
  }
  return s;
}

// ---------------------------------------------------------------- pad match (mapper -> step)

/** Pad changes for animation frame `sub` (0..framesPerTick-1) before tick `tick` is simulated. */
export type PadScript = (tick: number, sub: number, rig: PadRig, s: SimState) => void;

export interface PadMatch {
  s: SimState;
  rig: PadRig;
  /** Every frame the mapper produced, in tick order (copies). */
  frames: InputFrame[];
  /** Every event the pipeline emitted (copies). */
  events: SimEvent[];
  /** Ticks the pipeline ran in this match (s.tick before each step + 1). */
  ticks: number[];
  /** Run n ticks: per tick `framesPerTick` animation frames (script, then poll), then one sample, then step(). */
  run(n: number, script?: PadScript, after?: (s: SimState, f: InputFrame) => void): void;
}

export interface PadMatchOptions extends RigOptions {
  /** Animation frames per 60 Hz tick (1 = 60 Hz display, 2 = 120 Hz ProMotion). Default 2. */
  framesPerTick?: number;
  projector?: CameraProjector | null;
}

function copyEvent(e: Readonly<SimEvent>): SimEvent {
  return { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
}

export function padMatch(s: SimState, o: PadMatchOptions = {}): PadMatch {
  const rig = padRig(o);
  const per = o.framesPerTick ?? 2;
  const dt = 1000 / 60 / per;
  const ev = createEventBuffer();
  const out = [createInputFrame(), createInputFrame()];
  const m: PadMatch = {
    s, rig, frames: [], events: [], ticks: [],
    run(n, script, after) {
      for (let i = 0; i < n; i++) {
        const tick = s.tick + 1;
        for (let sub = 0; sub < per; sub++) {
          if (script) script(tick, sub, rig, s);
          rig.frame(dt);
        }
        const ctl = s.ctrl[0]!;
        rig.sampleInto(out[0]!, { tick, human: 0, side: ctl.side, state: s, projector: o.projector ?? null });
        m.frames.push({ ...out[0]! });
        m.ticks.push(tick);
        step(s, out, ev);
        for (let k = 0; k < ev.count; k++) m.events.push(copyEvent(ev.get(k)));
        if (after) after(s, out[0]!);
      }
    },
  };
  return m;
}

/** Script: hold standard button b during ticks [from, to) (pressed at sub-frame 0 of `from`, released at sub 0 of `to`). */
export function holdDuring(b: number, from: number, to: number, value = 1): PadScript {
  return (tick, sub, rig) => {
    if (sub !== 0) return;
    if (tick === from) rig.press(b, value);
    if (tick === to) rig.release(b);
  };
}

/** Combine scripts (run in order). */
export function all(...scripts: PadScript[]): PadScript {
  return (tick, sub, rig, s) => { for (const f of scripts) f(tick, sub, rig, s); };
}

/** Script: a quick tap of b inside tick `at` (down on sub-frame 0, up on sub-frame 1: shorter than a tick). */
export function tapAt(b: number, at: number): PadScript {
  return (tick, sub, rig) => {
    if (tick !== at) return;
    if (sub === 0) rig.press(b);
    else rig.release(b);
  };
}

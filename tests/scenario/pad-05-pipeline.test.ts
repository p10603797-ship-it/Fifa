/**
 * PAD-05 through the real step() pipeline: right-stick samples at 120 Hz -> createRightStick (setContext from the live
 * state, applyTo once per tick like the pad mapper) -> InputFrame -> SIM-15 resolveControllers -> SIM-16 switching /
 * SIM-13 startSkill. SIM-13 is replaced by a recording fake (it is a separate assignment); switching is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ calls: [] as { slot: number; skill: number; dx: number; dz: number; tick: number }[] }));

vi.mock('../../src/sim/kicks/skills', async (orig) => {
  const o = (await orig()) as Record<string, unknown>;
  return {
    ...o,
    startSkill: (s: { tick: number }, slot: number, skill: number, dx: number, dz: number): number => {
      rec.calls.push({ slot, skill, dx, dz, tick: s.tick });
      return 1;
    },
  };
});

import { MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { writeAimAxes } from '../../src/input/axes';
import { createRightStick, type RightStickTracker } from '../../src/input/pad/rightStick';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

const TICK_MS = 1000 / 60;
const DEG = Math.PI / 180;
type Key = [t: number, deg: number, mag: number];

function lerp(keys: Key[], t: number): [number, number] {
  if (keys.length === 0 || t <= keys[0]![0]) return keys.length ? [keys[0]![1], keys[0]![2]] : [0, 0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
  }
  return [keys[keys.length - 1]![1], keys[keys.length - 1]![2]];
}

/** Absolute pitch angle (deg, 0 = +x, 90 = +z) path -> screen stick (broadcast camera: screen = pitch). */
function stickAt(keys: Key[], t: number): [number, number] {
  const [deg, mag] = lerp(keys, t);
  return [mag * Math.cos(deg * DEG), mag * Math.sin(deg * DEG)];
}

/**
 * Run `ticks` ticks; P1's right stick follows `right` (absolute pitch angles), the left stick `left`, buttons held
 * `buttons(tick)`. Two animation frames per tick feed the tracker; each tick samples it like the mapper does.
 */
function play(s: SimState, ticks: number, right: Key[], opts: { left?: Key[]; buttons?: (tick: number) => number } = {}) {
  const rs: RightStickTracker = createRightStick();
  let frameT = 0;
  const frames: InputFrame[] = [];
  const events = runTicks(s, ticks, (tick, st, out) => {
    const f = out[0]!;
    const held = opts.buttons ? opts.buttons(tick) : 0;
    const ctx: InputSampleContext = { tick: st.tick, human: 0, side: 0, state: st, projector: null };
    let rx = 0, ry = 0, lx = 0, ly = 0;
    for (let k = 0; k < 2; k++) {
      frameT += TICK_MS / 2;
      [rx, ry] = stickAt(right, frameT);
      if (opts.left) [lx, ly] = stickAt(opts.left, frameT);
      rs.updatePad({ rx, ry, lx, ly }, held, 5000 + frameT);
    }
    f.buttons = held;
    f.mx = Math.round(lx * 127);
    f.mz = Math.round(ly * 127);
    writeAimAxes(f, rx, ry, null);
    rs.setContext(ctx);
    rs.applyTo(f);
    frames.push({ ...f });
  });
  return { events, frames };
}

beforeEach(() => { rec.calls.length = 0; });

describe('PAD-05 directional switch in defence (right-stick flick -> SIM-16)', () => {
  function defence(): SimState {
    return makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 9 }],
      players: [
        { slot: 9, x: 25, z: 0, fx: -1, fz: 0 },
        { slot: 4, x: 22, z: -14 },
        { slot: 6, x: 22, z: 14 },
        { slot: 19, x: -10, z: 0, vx: -4 },
      ],
      ball: { x: -10.4, z: 0, owner: 19 },
    });
  }

  for (const [name, deg, want] of [['toward +z', 90, 6], ['toward -z', -90, 4]] as [string, number, number][]) {
    it(`a quick flick ${name} (stick back in the centre by the sample) switches to that teammate`, () => {
      const s = defence();
      // Out and back within ~25 ms, starting just after tick 2's first frame.
      const { events, frames } = play(s, 6, [[0, deg, 0], [20, deg, 0], [30, deg, 1], [40, deg, 1], [50, deg, 0]]);
      const fl = frames.filter((f) => (f.buttons & Btn.RS_FLICK) !== 0);
      expect(fl).toHaveLength(1);
      expect(frames.every((f) => f.skill === SkillMove.NONE)).toBe(true);
      const sw = findEvents(events, EventType.SWITCH, (e) => e.c === 0);
      expect(sw.map((e) => [e.a, e.b])).toEqual([[9, want]]);
      expect(s.ctrl[0]!.slot).toBe(want);
    });
  }

  it('a defending human holding the stick to a side gets no skill (only RS_HOLD), and no repeated switches', () => {
    const s = defence();
    const { events, frames } = play(s, 40, [[0, 90, 0], [20, 90, 0], [40, 90, 1], [600, 90, 1], [620, 90, 0]]);
    expect(frames.every((f) => f.skill === SkillMove.NONE)).toBe(true);
    expect(frames.filter((f) => (f.buttons & Btn.RS_HOLD) !== 0).length).toBeGreaterThan(20);
    expect(findEvents(events, EventType.SWITCH, (e) => e.c === 0)).toHaveLength(1);
    expect(rec.calls).toHaveLength(0);
  });
});

describe('PAD-05 skills in attack (pattern -> frame.skill -> SIM-15 -> startSkill)', () => {
  function attack(fx = 1, fz = 0): SimState {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 9 }],
      players: [{ slot: 9, x: 10, z: 0, vx: 0, vz: 0, fx, fz }],
      ball: { x: 10 + 0.5 * fx, z: 0.5 * fz, y: 0.11, vx: 0, vy: 0, vz: 0, owner: 9, lastTouch: 9, lastTouchTeam: 0 },
    });
    return s;
  }

  it('step-over: roll forward -> right (facing +x: forward = +x, right = +z) starts STEP_OVER once', () => {
    const s = attack();
    play(s, 30, [[0, 0, 0], [20, 0, 0], [50, 0, 1], [170, 90, 1], [260, 90, 1], [290, 90, 0]]);
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.STEP_OVER]);
    expect(rec.calls[0]!.slot).toBe(9);
  });

  it('body feint: flick to the player\'s left (facing -x: left = +z) starts BODY_FEINT once', () => {
    const s = attack(-1, 0);
    play(s, 20, [[0, 90, 0], [20, 90, 0], [40, 90, 1], [100, 90, 1], [130, 90, 0]]);
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.BODY_FEINT]);
  });

  it('roulette and heel flick each start once', () => {
    let s = attack();
    play(s, 30, [[0, 180, 0], [20, 180, 0], [50, 180, 1], [250, 0, 1], [280, 0, 0]]);
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.ROULETTE]);
    rec.calls.length = 0;
    s = attack();
    play(s, 30, [[0, 0, 0], [20, 0, 0], [50, 0, 1], [90, 0, 1], [120, 0, 0], [140, 180, 0], [170, 180, 1], [210, 180, 1], [240, 180, 0]]);
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.HEEL_FLICK]);
  });

  it('drag-back: L1 + R1 + left stick flicked backward starts DRAG_BACK', () => {
    const s = attack();
    play(s, 20, [], { left: [[0, 180, 0], [30, 180, 0], [50, 180, 1], [150, 180, 1], [170, 180, 0]], buttons: () => Btn.MOD_L | Btn.MOD_R });
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.DRAG_BACK]);
  });

  it('knock-on: R2 + a quick right-stick flick starts KNOCK_ON toward the flick, not a body feint', () => {
    const s = attack();
    play(s, 12, [[0, 90, 0], [20, 90, 0], [30, 90, 1], [40, 90, 1], [50, 90, 0]], { buttons: () => Btn.SPRINT });
    expect(rec.calls.map((c) => c.skill)).toEqual([SkillMove.KNOCK_ON]);
    expect(rec.calls[0]!.dx).toBeCloseTo(0, 6);
    expect(rec.calls[0]!.dz).toBeCloseTo(1, 6);
  });

  it('normal dribbling with the right stick resting or nudged below the threshold starts nothing', () => {
    const s = attack();
    const nudges: Key[] = [];
    for (let t = 0; t <= 1500; t += 60) nudges.push([t, (t * 7) % 360, 0.5]);
    play(s, 90, nudges, { left: [[0, 0, 0], [50, 0, 1], [1500, 0, 1]] });
    expect(rec.calls).toHaveLength(0);
  });
});

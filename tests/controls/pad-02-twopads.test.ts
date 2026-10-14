/**
 * PAD-02: two pads at once (BRIEF section 10 controller quality bar: "Two pads at once, each bound to a side at side
 * select"). Two mapper sources share one PAD-01 manager, as the DeviceRegistry builds them: each source's pollFrame
 * polls the shared manager (same timestamp: the manager polls once; different timestamps: the manager polls twice and
 * each source recovers the edges of the poll it did not read). Every quick tap reaches its own source exactly once,
 * nothing crosses over, and both humans drive their own players through the real step() pipeline.
 */
import { describe, expect, it } from 'vitest';
import { AssistLevel, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createPadManager } from '../../src/input/pad/manager';
import { createPadSource, type PadInputSource } from '../../src/input/pad/mapper';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { makeScenario } from '../harness/scenario';
import { mockPad, PadButton, setBtn, type MockPad } from './pad-02-helpers';

const TICK = 1000 / 60;

interface TwoPads {
  a: MockPad;
  b: MockPad;
  srcA: PadInputSource;
  srcB: PadInputSource;
  pauses: number[];
  /** Two animation frames per tick; `skewMs` > 0 polls B that much later than A in each frame. */
  tick(s: SimState, script?: (sub: number) => void, skewMs?: number): [InputFrame, InputFrame];
}

function twoPads(): TwoPads {
  const a = mockPad(0);
  const b = mockPad(1, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
  const list = [a, b, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  let t = 1000;
  mgr.poll(t);
  const pauses = [0, 0];
  const srcA = createPadSource({ key: 'pad:1', manager: mgr, now: () => t, onPause: () => { pauses[0]!++; } });
  const srcB = createPadSource({ key: 'pad:2', manager: mgr, now: () => t, onPause: () => { pauses[1]!++; } });
  const fa = createInputFrame();
  const fb = createInputFrame();
  return {
    a, b, srcA, srcB, pauses,
    tick(s, script, skewMs = 0) {
      for (let sub = 0; sub < 2; sub++) {
        if (script) script(sub);
        t += TICK / 2;
        srcA.pollFrame!(t);
        srcB.pollFrame!(t + skewMs);
      }
      t += skewMs;
      const tick = s.tick + 1;
      srcA.sample(fa, { tick, human: 0, side: 0, state: s, projector: null });
      srcB.sample(fb, { tick, human: 1, side: 1, state: s, projector: null });
      return [{ ...fa }, { ...fb }];
    },
  };
}

/** A quiet IN_PLAY match: P1 (side 0) controls slot 9, P2 (side 1) controls slot 20, CPU brains off, ball parked. */
function twoHumanScene(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [
      { side: 0, slot: 9, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF },
      { side: 1, slot: 20, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF },
    ],
    seed: 11,
  });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE;
    ctl.side = -1;
    ctl.slot = -1;
    s.teams[c - 2]!.cpu.active = 0;
  }
  const p1 = s.players[9]!;
  p1.x = 0; p1.z = -15; p1.vx = 0; p1.vz = 0;
  const p2 = s.players[20]!;
  p2.x = 0; p2.z = 15; p2.vx = 0; p2.vz = 0;
  const ball = s.ball;
  ball.owner = -1; ball.heldBy = -1; ball.x = -30; ball.z = 30; ball.px = ball.x; ball.pz = ball.z;
  ball.vx = 0; ball.vz = 0; ball.y = 0.11; ball.grounded = 1;
  return s;
}

/** Ticks on which `bit` goes from up to down in a frame stream. */
function pressTicks(frames: InputFrame[], bit: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const on = (frames[i]!.buttons & bit) !== 0;
    const was = i > 0 && (frames[i - 1]!.buttons & bit) !== 0;
    if (on && !was) out.push(i);
  }
  return out;
}

describe('PAD-02 two pads at once (one shared manager, one source per pad)', () => {
  for (const [label, skew] of [['polled at the same timestamp', 0], ['polled at different timestamps', 0.5]] as const) {
    it(`quick taps on both pads reach their own source exactly once, no crosstalk (${label})`, () => {
      const s = twoHumanScene();
      const r = twoPads();
      const fa: InputFrame[] = [];
      const fb: InputFrame[] = [];
      for (let i = 0; i < 24; i++) {
        const [x, y] = r.tick(s, (sub) => {
          // Pad A: two Cross taps shorter than a tick (ticks 3 and 4). Pad B: Circle tap at tick 3 (second frame
          // down, released at the first frame of tick 4), R2 held from tick 6 to 12, Options at tick 15.
          if (i === 3 || i === 4) setBtn(r.a, PadButton.SOUTH, sub === 0 ? 1 : 0);
          if (i === 3 && sub === 1) setBtn(r.b, PadButton.EAST, 1);
          if (i === 4 && sub === 0) setBtn(r.b, PadButton.EAST, 0);
          if (i === 6 && sub === 0) setBtn(r.b, PadButton.R2, 1);
          if (i === 12 && sub === 0) setBtn(r.b, PadButton.R2, 0);
          if (i === 15) setBtn(r.b, PadButton.START, sub === 0 ? 1 : 0);
        }, skew);
        fa.push(x);
        fb.push(y);
      }
      // Tap 1 is reported at sample 3; tap 2 (made while tap 1 is still the reported state) shows the release at
      // sample 4 and the press at sample 5: two separate presses, never merged.
      expect(pressTicks(fa, Btn.PASS)).toEqual([3, 5]);
      expect(fa.filter((f) => (f.buttons & Btn.PASS) !== 0)).toHaveLength(2);
      expect(pressTicks(fb, Btn.SHOOT)).toEqual([3]);
      expect(fb.filter((f) => (f.buttons & Btn.SHOOT) !== 0)).toHaveLength(1);
      expect(fb.map((f) => (f.buttons & Btn.SPRINT) !== 0 ? 1 : 0).join('')).toBe('000000111111000000000000');
      // Nothing from one pad shows up on the other.
      expect(fa.every((f) => (f.buttons & ~Btn.PASS) === 0)).toBe(true);
      expect(fb.every((f) => (f.buttons & Btn.PASS) === 0)).toBe(true);
      expect(r.pauses).toEqual([0, 1]);
    });
  }

  it('both humans drive their own player through step(): P1 runs +x and sprints, P2 runs -x at a jog', () => {
    const s = twoHumanScene();
    const r = twoPads();
    const ev = createEventBuffer();
    const p1 = s.players[9]!;
    const p2 = s.players[20]!;
    const x1 = p1.x, x2 = p2.x;
    let sprintSeen = 0;
    for (let i = 0; i < 60; i++) {
      const frames = r.tick(s, (sub) => {
        if (i === 1 && sub === 0) {
          r.a.axes[0] = 1; r.a.axes[1] = 0;
          setBtn(r.a, PadButton.R2, 1);
          r.b.axes[0] = -1; r.b.axes[1] = 0;
        }
      });
      step(s, frames, ev);
      if (p1.wantSprint === 1) sprintSeen++;
      expect(p2.wantSprint).toBe(0);
    }
    expect(s.ctrl[0]!.slot).toBe(9);
    expect(s.ctrl[1]!.slot).toBe(20);
    expect(sprintSeen).toBeGreaterThan(50);
    expect(p1.x - x1).toBeGreaterThan(3);
    expect(x2 - p2.x).toBeGreaterThan(2);
    // The sprinting P1 covered more ground than the jogging P2.
    expect(p1.x - x1).toBeGreaterThan(x2 - p2.x);
    expect(Math.abs(p1.z + 15)).toBeLessThan(0.5);
    expect(Math.abs(p2.z - 15)).toBeLessThan(0.5);
  });

  it('Input glitch: both players pausing at once: Options on both pads in the same poll pauses once (session releaseAll)', () => {
    // The session pauses on the first onPause and calls releaseAll() on every source (as session.pause() does)
    // before the second source has read the same manager poll: the second Options press was already held at
    // releaseAll, so it is suppressed until released (no pause-then-resume toggle).
    const s = twoHumanScene();
    const a = mockPad(0);
    const b = mockPad(1);
    const list = [a, b, null, null];
    const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
    let t = 1000;
    mgr.poll(t);
    const calls: string[] = [];
    const srcs: PadInputSource[] = [];
    const pause = (who: string) => (): void => {
      calls.push(who);
      for (const x of srcs) x.releaseAll();
    };
    srcs.push(createPadSource({ key: 'pad:1', manager: mgr, now: () => t, onPause: pause('A') }));
    srcs.push(createPadSource({ key: 'pad:2', manager: mgr, now: () => t, onPause: pause('B') }));
    const f = createInputFrame();
    const frame = (): void => {
      t += TICK / 2;
      for (const x of srcs) x.pollFrame!(t);
    };
    const sampleB = (): InputFrame => {
      srcs[1]!.sample(f, { tick: s.tick + 1, human: 1, side: 1, state: s, projector: null });
      return { ...f };
    };
    frame();
    // Both press Options (and B also Cross) between the same two polls.
    setBtn(a, PadButton.START, 1);
    setBtn(b, PadButton.START, 1);
    setBtn(b, PadButton.SOUTH, 1);
    frame();
    frame();
    expect(calls).toEqual(['A']);
    // B's Cross was held at the pause's releaseAll: it never reaches the sim while held.
    expect(sampleB().buttons & Btn.PASS).toBe(0);
    frame();
    expect(sampleB().buttons & Btn.PASS).toBe(0);
    // Released and pressed again: B's Options works (the session decides: resume), and so does Cross.
    setBtn(b, PadButton.START, 0);
    setBtn(b, PadButton.SOUTH, 0);
    frame();
    setBtn(b, PadButton.START, 1);
    setBtn(b, PadButton.SOUTH, 1);
    frame();
    expect(calls).toEqual(['A', 'B']);
    setBtn(b, PadButton.START, 0);
    frame();
    frame();
    // The second pause's releaseAll suppressed B's Cross again (it was held at that releaseAll too).
    expect(sampleB().buttons & Btn.PASS).toBe(0);
    setBtn(b, PadButton.SOUTH, 0);
    frame();
    setBtn(b, PadButton.SOUTH, 1);
    frame();
    expect(sampleB().buttons & Btn.PASS).toBe(Btn.PASS);
  });

  it('releaseAll before a source has ever read its pad: a button pressed at the poll before it is suppressed too', () => {
    const a = mockPad(0);
    const list = [a, null, null, null];
    const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
    let t = 1000;
    mgr.poll(t);
    const src = createPadSource({ key: 'pad:1', manager: mgr, now: () => t, onPause: () => {} });
    const s = twoHumanScene();
    const f = createInputFrame();
    setBtn(a, PadButton.R2, 1);
    t += TICK / 2;
    mgr.poll(t); // another consumer (menu input) polled; the source has not read this poll yet
    src.releaseAll(); // e.g. the session resets every source at kick-off
    // The first read is that same manager poll (sample() does not poll again within MAPPER_TUNING.fallbackPollMs).
    src.sample(f, { tick: s.tick + 1, human: 0, side: 0, state: s, projector: null });
    expect(f.buttons & Btn.SPRINT).toBe(0);
    for (let i = 0; i < 4; i++) {
      t += TICK / 2;
      src.pollFrame!(t);
      src.sample(f, { tick: s.tick + 1, human: 0, side: 0, state: s, projector: null });
      expect(f.buttons & Btn.SPRINT).toBe(0);
    }
    setBtn(a, PadButton.R2, 0);
    t += TICK / 2;
    src.pollFrame!(t);
    setBtn(a, PadButton.R2, 1);
    t += TICK / 2;
    src.pollFrame!(t);
    src.sample(f, { tick: s.tick + 1, human: 0, side: 0, state: s, projector: null });
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('releaseAll on one source (its human paused the pad) leaves the other pad untouched', () => {
    const s = twoHumanScene();
    const r = twoPads();
    let fr = r.tick(s, (sub) => { if (sub === 0) { setBtn(r.a, PadButton.R2, 1); setBtn(r.b, PadButton.R2, 1); } });
    expect(fr[0].buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    expect(fr[1].buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.srcA.releaseAll();
    fr = r.tick(s);
    expect(fr[0].buttons & Btn.SPRINT).toBe(0);
    expect(fr[1].buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });
});

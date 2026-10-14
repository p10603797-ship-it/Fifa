/**
 * PAD-02 unit tests: the pad mapper (src/input/pad/mapper.ts) with mock Standard Gamepad objects through the real
 * PAD-01 manager: button bits, analogue triggers, stick axes and camera rotation, PAD-05 right-stick integration,
 * PAD-04 D-pad sequences -> cmd, Options -> pause, edge latching (no lost quick taps between ticks), modifier order,
 * suppression (start, releaseAll, reconnect), remaps for non-standard pads, frame-stream determinism, no allocation.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { Command, MatchPhase, RestartKind, SkillMove } from '../../src/contracts/enums';
import { AXIS_SCALE, Btn, createInputFrame, type CameraProjector, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_PAD } from '../../src/contracts/tuning';
import { writeAimAxes, writeMoveAxes } from '../../src/input/axes';
import { PAD_TRIGGER_RELEASE, type PadSlot } from '../../src/input/pad/manager';
import type { RightStickTracker } from '../../src/input/pad/rightStick';
import {
  logicalToButtons, mapPadButtons, MAPPER_TUNING, PAD_ACTION_COUNT, PAD_STANDARD_INDEX, PadAction, resolvePadRemap,
  writePadSticks,
} from '../../src/input/pad/mapper';
import { createPadSequences, type PadSequences } from '../../src/input/pad/sequences';
import {
  GENERIC_ID, mockPad, PadButton, padRig, scene, setBtn, settingsWithRemaps, STANDARD_ID, type PadRig,
} from './pad-02-helpers';

const S = scene();
const TICK = 1000 / 60;

/** One 60 Hz tick at 120 Hz: two animation frames (pad changes in `a` before the first, `b` before the second). */
function tick120(r: PadRig, a?: () => void, b?: () => void): InputFrame {
  if (a) a();
  r.frame(TICK / 2);
  if (b) b();
  r.frame(TICK / 2);
  return r.sample(S);
}

function btns(f: InputFrame): number {
  return f.buttons & 0xff;
}

function rotProjector(rot: number): CameraProjector {
  return {
    screenToPitch: () => false,
    pitchToScreen: () => false,
    stickRotation: () => rot,
  };
}

/** The real PAD-04 recogniser, observed: the held D-pad bits the mapper feeds and the resets. */
function spySequences() {
  const real = createPadSequences();
  const calls: { held: number; t: number }[] = [];
  let resets = 0;
  const seq: PadSequences = {
    get pending() { return real.pending; },
    get pendingSinceMs() { return real.pendingSinceMs; },
    get windowMs() { return real.windowMs; },
    update: (e, t, c) => real.update(e, t, c),
    reset: () => { resets++; real.reset(); },
    getPending: (t) => real.getPending(t),
    remainingMs: (t) => real.remainingMs(t),
    updateHeld: (h, t) => { calls.push({ held: h, t }); return real.updateHeld(h, t); },
    updatePad: (sl, t) => real.updatePad(sl, t),
    setContext: (c) => real.setContext(c),
    applyTo: (o) => real.applyTo(o),
    dispose: () => real.dispose(),
  };
  return { seq, calls, resets: () => resets };
}

describe('PAD-02 button mapping (FC Classic positions)', () => {
  it('Cross/Circle/Square/Triangle/L1/R1/L2/R2 -> PASS/SHOOT/LOB/THROUGH/MOD_L/MOD_R/SHIELD/SPRINT', () => {
    const want = [Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH, Btn.MOD_L, Btn.MOD_R, Btn.SHIELD, Btn.SPRINT];
    for (let b = 0; b < 8; b++) {
      const r = padRig();
      r.frame();
      const f = tick120(r, () => r.press(b));
      expect(btns(f), `button ${b}`).toBe(want[b]);
      expect(mapPadButtons(r.mgr.find('pad:1')!)).toBe(want[b]);
    }
    expect(PAD_STANDARD_INDEX.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    expect(logicalToButtons(0xff)).toBe(0xff);
  });

  it('Create/View, L3, R3, the D-pad, Home (16) and Share (17) never set a button bit; Home/Share never pause', () => {
    const onPause = vi.fn();
    const pad = mockPad(0, STANDARD_ID, 'standard', 18);
    const r = padRig({ pad, onPause });
    r.frame();
    for (const b of [8, 10, 11, 12, 13, 14, 15, 16, 17]) {
      const f = tick120(r, () => r.press(b));
      expect(f.buttons, `button ${b}`).toBe(0);
      tick120(r, () => r.release(b));
    }
    expect(onPause).not.toHaveBeenCalled();
  });

  it('triggers are analogue: SHIELD / SPRINT engage past 0.3 (T_PAD.triggerThreshold) and release with hysteresis', () => {
    expect(T_PAD.triggerThreshold).toBe(0.3);
    const r = padRig();
    r.frame();
    let f = tick120(r, () => { r.press(PadButton.L2, 0.29); r.press(PadButton.R2, 0.29); });
    expect(f.buttons & (Btn.SHIELD | Btn.SPRINT)).toBe(0);
    f = tick120(r, () => r.press(PadButton.R2, 0.31));
    expect(f.buttons & (Btn.SHIELD | Btn.SPRINT)).toBe(Btn.SPRINT);
    f = tick120(r, () => r.press(PadButton.L2, 0.6));
    expect(f.buttons & (Btn.SHIELD | Btn.SPRINT)).toBe(Btn.SHIELD | Btn.SPRINT);
    // A trigger resting just under the threshold stays down (no chatter) until it falls to the release level.
    f = tick120(r, () => r.press(PadButton.R2, 0.28));
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    f = tick120(r, () => r.press(PadButton.R2, PAD_TRIGGER_RELEASE));
    expect(f.buttons & Btn.SPRINT).toBe(0);
  });
});

describe('PAD-02 sticks', () => {
  it('left stick -> mx/mz in pitch space: right = +x, up = -z, radial magnitude <= 127', () => {
    const r = padRig();
    r.frame();
    let f = tick120(r, () => r.left(1, 0));
    expect([f.mx, f.mz]).toEqual([AXIS_SCALE, 0]);
    f = tick120(r, () => r.left(0, -1));
    expect([f.mx, f.mz]).toEqual([0, -AXIS_SCALE]);
    f = tick120(r, () => r.left(0.9, 0.9));
    expect(f.mx).toBeGreaterThan(80);
    expect(f.mz).toBeGreaterThan(80);
    expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    f = tick120(r, () => r.left(0.1, 0.05)); // inside the 0.15 radial dead zone
    expect([f.mx, f.mz]).toEqual([0, 0]);
  });

  it('left and right sticks are rotated by projector.stickRotation()', () => {
    const r = padRig();
    r.frame();
    tick120(r, () => { r.left(1, 0); r.right(0, -1); });
    r.frame(TICK);
    const f = r.sample(S, rotProjector(Math.PI / 2));
    // (cos*sx - sin*sy, sin*sx + cos*sy): stick right -> +z; right stick up (0,-1) -> +x.
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(AXIS_SCALE);
    expect(f.ax).toBe(AXIS_SCALE);
    expect(f.az).toBe(0);
  });

  it('right stick -> ax/az; a flick reports RS_FLICK once with its direction, a held stick RS_HOLD (PAD-05)', () => {
    const r = padRig();
    r.frame();
    const frames: InputFrame[] = [];
    frames.push(tick120(r, () => r.right(1, 0)));
    for (let i = 0; i < 20; i++) frames.push(tick120(r));
    const flicks = frames.filter((f) => (f.buttons & Btn.RS_FLICK) !== 0);
    expect(flicks).toHaveLength(1);
    expect([flicks[0]!.ax, flicks[0]!.az]).toEqual([AXIS_SCALE, 0]);
    expect(frames.every((f) => f.ax === AXIS_SCALE)).toBe(true);
    expect((frames[frames.length - 1]!.buttons & Btn.RS_HOLD) !== 0).toBe(true);
    // A quick flick out and back between two samples still reports the flick with its direction.
    const g = tick120(r, () => r.right(0, 0));
    expect(g.buttons & (Btn.RS_FLICK | Btn.RS_HOLD)).toBe(0);
    tick120(r);
    const h = tick120(r, () => r.right(0, 1), () => r.right(0, 0));
    expect(h.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect([h.ax, h.az]).toEqual([0, AXIS_SCALE]);
  });

  it('a right-stick skill pattern sets frame.skill with its direction (step-over, dribbler facing +x)', () => {
    const s = scene();
    const r = padRig();
    r.frame();
    const frames: InputFrame[] = [];
    const path: [number, number][] = [[0.2, 0], [1, 0], [1, 0], [0.92, 0.38], [0.7, 0.7], [0.38, 0.92], [0, 1], [0, 1], [0, 0], [0, 0]];
    for (const [x, z] of path) {
      r.right(x, z);
      r.frame(TICK / 2);
      r.frame(TICK / 2);
      frames.push(r.sample(s));
    }
    const sk = frames.filter((f) => f.skill !== SkillMove.NONE);
    expect(sk.map((f) => f.skill)).toEqual([SkillMove.STEP_OVER]);
    expect([sk[0]!.ax, sk[0]!.az]).toEqual([0, AXIS_SCALE]);
  });

  it('drag-back: L1 + R1 held and the left stick flicked backward', () => {
    const s = scene();
    const r = padRig();
    r.frame();
    const frames: InputFrame[] = [];
    frames.push(tick120(r, () => { r.press(PadButton.L1); r.press(PadButton.R1); }));
    frames.push(tick120(r, () => r.left(-1, 0)));
    for (let i = 0; i < 4; i++) {
      r.frame(TICK / 2); r.frame(TICK / 2);
      frames.push(r.sample(s));
    }
    expect(frames.filter((f) => f.skill !== SkillMove.NONE).map((f) => f.skill)).toEqual([SkillMove.DRAG_BACK]);
  });
});

describe('PAD-02 D-pad sequences and pause', () => {
  it('D-pad: held bits reach the PAD-04 recogniser every poll (bit 0 up .. 3 right); its command lands in cmd once', () => {
    const spy = spySequences();
    const r = padRig({ sequences: spy.seq });
    r.frame();
    const held: number[] = [];
    for (const b of [PadButton.DPAD_UP, PadButton.DPAD_DOWN, PadButton.DPAD_LEFT, PadButton.DPAD_RIGHT]) {
      spy.calls.length = 0;
      r.press(b);
      r.frame();
      held.push(spy.calls.at(-1)!.held);
      r.release(b);
      r.frame();
      r.sample(S);
    }
    expect(held).toEqual([1, 2, 4, 8]);
    // Timestamps are the poll times (monotonic), so the recogniser can time its window.
    const ts = spy.calls.map((c) => c.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // Up, then up: offside trap, reported in exactly one frame with cmdArg 0.
    const r2 = padRig();
    r2.frame();
    const frames = [
      tick120(r2, () => r2.press(PadButton.DPAD_UP), () => r2.release(PadButton.DPAD_UP)),
      tick120(r2),
      tick120(r2, () => r2.press(PadButton.DPAD_UP)),
      tick120(r2),
      tick120(r2, () => r2.release(PadButton.DPAD_UP)),
    ];
    expect(frames.map((f) => f.cmd)).toEqual([Command.NONE, Command.NONE, Command.TACTIC_OFFSIDE_TRAP, Command.NONE, Command.NONE]);
    expect(frames[2]!.cmdArg).toBe(0);
    expect(frames.every((f) => f.buttons === 0)).toBe(true);
    // Right then left: tactical focus defending; down then down: quick sub.
    const seq = (a: number, b: number): Command => {
      const q = padRig();
      q.frame();
      tick120(q, () => q.press(a), () => q.release(a));
      return tick120(q, () => q.press(b), () => q.release(b)).cmd;
    };
    expect(seq(PadButton.DPAD_RIGHT, PadButton.DPAD_LEFT)).toBe(Command.FOCUS_DEFENDING);
    expect(seq(PadButton.DPAD_DOWN, PadButton.DPAD_DOWN)).toBe(Command.QUICK_SUB);
  });

  it('corner tactics only while the human\'s own team takes a corner (D-pad down, then up = far post)', () => {
    const corner = (team: number): Command[] => {
      const s = scene();
      s.match.phase = MatchPhase.CORNER;
      s.match.restart.kind = RestartKind.CORNER;
      s.match.restart.team = team;
      s.match.restart.taken = 0;
      const r = padRig();
      r.frame();
      r.sample(s);
      const out: Command[] = [];
      for (const b of [PadButton.DPAD_DOWN, PadButton.DPAD_UP]) {
        r.press(b); r.frame(); r.release(b); r.frame();
        out.push(r.sample(s).cmd);
      }
      return out;
    };
    expect(corner(0)).toEqual([Command.NONE, Command.CORNER_FAR_POST]);
    expect(corner(1)).toEqual([Command.NONE, Command.NONE]);
  });

  it('Options/Menu calls onPause once per press (held: once), never from a press held over releaseAll', () => {
    const onPause = vi.fn();
    const r = padRig({ onPause });
    r.frame();
    tick120(r, () => r.press(PadButton.START));
    tick120(r);
    tick120(r);
    expect(onPause).toHaveBeenCalledTimes(1);
    r.src.releaseAll();
    tick120(r);
    expect(onPause).toHaveBeenCalledTimes(1);
    tick120(r, () => r.release(PadButton.START), () => r.press(PadButton.START));
    expect(onPause).toHaveBeenCalledTimes(2);
  });

  it('onPause may call releaseAll() re-entrantly: a face button pressed in the same poll does not reach the sim', () => {
    let r: PadRig | null = null;
    r = padRig({ onPause: () => r!.src.releaseAll() });
    r.frame();
    const f = tick120(r, () => { r!.press(PadButton.START); r!.press(PadButton.SOUTH); });
    expect(f.buttons).toBe(0);
    const g = tick120(r);
    expect(g.buttons).toBe(0);
  });
});

describe('PAD-02 edges: no lost quick taps between ticks', () => {
  it('120 Hz: a tap shorter than a tick (down one frame, up the next) is reported for exactly one sample', () => {
    const r = padRig();
    r.frame();
    const f1 = tick120(r, () => r.press(PadButton.EAST), () => r.release(PadButton.EAST));
    const f2 = tick120(r);
    expect(btns(f1)).toBe(Btn.SHOOT);
    expect(btns(f2)).toBe(0);
  });

  it('a release and re-press between two samples is reported as release, then press (double tap never merged)', () => {
    const r = padRig();
    r.frame();
    const seq = [
      tick120(r, () => r.press(PadButton.SOUTH)),
      tick120(r, () => r.release(PadButton.SOUTH), () => r.press(PadButton.SOUTH)),
      tick120(r),
      tick120(r, () => r.release(PadButton.SOUTH)),
    ].map(btns);
    expect(seq).toEqual([Btn.PASS, 0, Btn.PASS, 0]);
  });

  it('two full taps between two samples (240 Hz polling) are both reported, in order', () => {
    const r = padRig();
    r.frame();
    for (const v of [1, 0, 1, 0]) {
      if (v) r.press(PadButton.NORTH); else r.release(PadButton.NORTH);
      r.frame(TICK / 4);
    }
    const out = [r.sample(S), (r.frame(TICK), r.sample(S)), (r.frame(TICK), r.sample(S)), (r.frame(TICK), r.sample(S))].map(btns);
    expect(out).toEqual([Btn.THROUGH, 0, Btn.THROUGH, 0]);
  });

  it('button mashing: at most two unreported presses per button are kept, so nothing fires long after the mashing stops', () => {
    const r = padRig();
    r.frame();
    // Four full taps inside one sample interval (faster than any human: 480 Hz polling) ...
    for (let k = 0; k < 4; k++) {
      r.press(PadButton.SOUTH);
      r.frame(TICK / 8);
      r.release(PadButton.SOUTH);
      r.frame(TICK / 8);
    }
    const out = [r.sample(S)];
    for (let k = 0; k < 5; k++) { r.frame(TICK); out.push(r.sample(S)); }
    // ... show as two presses back to back, then nothing: the backlog is bounded (no late pass from mashing).
    expect(out.map(btns)).toEqual([Btn.PASS, 0, Btn.PASS, 0, 0, 0]);
    // Realistic mashing (a full tap every 4 ticks for 2 s at 120 Hz) loses no press and ends with the last tap.
    const m = padRig();
    m.frame();
    const seen: number[] = [];
    for (let t = 0; t < 130; t++) {
      const tap = t < 120 && t % 4 === 0;
      seen.push(btns(tick120(m, tap ? () => m.press(PadButton.SOUTH) : undefined, tap ? () => m.release(PadButton.SOUTH) : undefined)));
    }
    let presses = 0;
    let last = -1;
    for (let t = 0; t < seen.length; t++) if (seen[t] && !(t > 0 && seen[t - 1])) { presses++; last = t; }
    expect(presses).toBe(30);
    expect(last).toBe(116);
  });

  it('a press seen only at a manager poll this source did not read is recovered (other poller, other timestamp)', () => {
    const r = padRig();
    r.frame();
    r.press(PadButton.WEST);
    r.mgr.poll(r.now() + 3); // e.g. menu input polling with its own timestamp
    r.release(PadButton.WEST);
    r.frame(TICK);
    expect(btns(r.sample(S))).toBe(Btn.LOB);
    r.frame(TICK);
    expect(btns(r.sample(S))).toBe(0);
  });

  it('sample() polls by itself when nobody called pollFrame (never within MAPPER_TUNING.fallbackPollMs of a poll)', () => {
    const r = padRig();
    r.frame();
    r.press(PadButton.SOUTH);
    r.advance(MAPPER_TUNING.fallbackPollMs / 2);
    const before = r.mgr.lastPollMs;
    expect(btns(r.sample(S))).toBe(0);
    expect(r.mgr.lastPollMs).toBe(before);
    r.advance(MAPPER_TUNING.fallbackPollMs);
    expect(btns(r.sample(S))).toBe(Btn.PASS);
    expect(r.mgr.lastPollMs).toBe(r.now());
  });

  it('120 Hz and 60 Hz displays give the same press/release sequence for the same pad timeline', () => {
    const run = (perTick: number): number[] => {
      const r = padRig();
      r.frame();
      const timeline: [number, number, number][] = [[20, PadButton.SOUTH, 1], [60, PadButton.SOUTH, 0], [100, PadButton.EAST, 1],
        [300, PadButton.EAST, 0], [340, PadButton.SOUTH, 1], [352, PadButton.SOUTH, 0], [400, PadButton.SOUTH, 1], [480, PadButton.SOUTH, 0]];
      const out: number[] = [];
      let t = 0;
      for (let k = 0; k < 40; k++) {
        for (let sub = 0; sub < perTick; sub++) {
          t += TICK / perTick;
          for (const [at, b, v] of timeline) if (at > t - TICK / perTick && at <= t) setBtn(r.pad, b, v);
          r.frame(TICK / perTick);
        }
        out.push(btns(r.sample(S)));
      }
      return out;
    };
    const edges = (xs: number[]) => xs.map((x, i) => x & ~(i > 0 ? xs[i - 1]! : 0)).filter((e) => e !== 0);
    expect(edges(run(2))).toEqual(edges(run(1)));
    expect(edges(run(2))).toEqual([Btn.PASS, Btn.SHOOT, Btn.PASS, Btn.PASS]);
  });
});

describe('PAD-02 modifier order (a combo resolves at the face press, never at the modifier press)', () => {
  it('R1 pressed one frame AFTER Circle inside the same tick is reported one sample later', () => {
    const r = padRig();
    r.frame();
    const f1 = tick120(r, () => r.press(PadButton.EAST), () => r.press(PadButton.R1));
    const f2 = tick120(r);
    expect(btns(f1)).toBe(Btn.SHOOT);
    expect(btns(f2)).toBe(Btn.SHOOT | Btn.MOD_R);
  });

  it('R1 pressed after a Circle re-press that still waits to be reported (release shown first) also waits for it', () => {
    const r = padRig();
    r.frame();
    expect(btns(tick120(r, () => r.press(PadButton.EAST)))).toBe(Btn.SHOOT);
    // Within one tick at 240 Hz: Circle released, re-pressed, then R1 pressed.
    r.release(PadButton.EAST); r.frame(TICK / 4);
    r.press(PadButton.EAST); r.frame(TICK / 4);
    r.press(PadButton.R1); r.frame(TICK / 4);
    r.frame(TICK / 4);
    const seq = [btns(r.sample(S)), btns(tick120(r)), btns(tick120(r))];
    expect(seq).toEqual([0, Btn.SHOOT, Btn.SHOOT | Btn.MOD_R]);
    // Same, but R1 only in the NEXT interval, before the re-press has been reported: still after it.
    const q = padRig();
    q.frame();
    tick120(q, () => q.press(PadButton.EAST));
    const a = tick120(q, () => q.release(PadButton.EAST), () => q.press(PadButton.EAST));
    const b = tick120(q, () => q.press(PadButton.R1));
    const c = tick120(q);
    expect([btns(a), btns(b), btns(c)]).toEqual([0, Btn.SHOOT, Btn.SHOOT | Btn.MOD_R]);
  });

  it('R1 pressed at the same poll as, or before, Circle is held at the Circle press (combo)', () => {
    let r = padRig();
    r.frame();
    expect(btns(tick120(r, () => { r.press(PadButton.EAST); r.press(PadButton.R1); }))).toBe(Btn.SHOOT | Btn.MOD_R);
    r = padRig();
    r.frame();
    expect(btns(tick120(r, () => r.press(PadButton.L1), () => r.press(PadButton.EAST)))).toBe(Btn.SHOOT | Btn.MOD_L);
  });
});

describe('PAD-02 suppression: start, releaseAll, disconnect', () => {
  it('a button already held before the source first sees the pad is ignored until released; a fresh press counts', () => {
    const pad = mockPad(0);
    setBtn(pad, PadButton.SOUTH, 1); // held from the menu that started the match
    const r = padRig({ pad, prepoll: true });
    r.frame();
    expect(btns(r.sample(S))).toBe(0);
    tick120(r, () => r.release(PadButton.SOUTH));
    expect(btns(tick120(r, () => r.press(PadButton.SOUTH)))).toBe(Btn.PASS);
    // A press made at the very poll the source first reads counts.
    const r2 = padRig({ prepoll: true });
    r2.press(PadButton.EAST);
    r2.frame();
    expect(btns(r2.sample(S))).toBe(Btn.SHOOT);
  });

  it('releaseAll drops latched taps and commands, suppresses held buttons until released, resets the right stick', () => {
    const spy = spySequences();
    const r = padRig({ sequences: spy.seq });
    r.frame();
    r.right(1, 0);
    r.press(PadButton.R2);
    r.frame();
    r.press(PadButton.WEST); r.frame(); r.release(PadButton.WEST); r.frame(); // a latched tap
    r.press(PadButton.DPAD_DOWN); r.frame(); r.release(PadButton.DPAD_DOWN); r.frame();
    r.press(PadButton.DPAD_DOWN); r.frame(); // a latched command (quick sub)
    const resets = spy.resets();
    r.src.releaseAll();
    expect(spy.resets()).toBe(resets + 1);
    r.frame();
    const f = r.sample(S);
    expect(f.buttons).toBe(0); // no tap, no SPRINT, no RS_FLICK / RS_HOLD (stick ignored until centred)
    expect(f.cmd).toBe(Command.NONE);
    expect(btns(tick120(r))).toBe(0);
    tick120(r, () => { r.release(PadButton.R2); r.release(PadButton.DPAD_DOWN); r.right(0, 0); });
    const g = tick120(r, () => { r.press(PadButton.R2); r.right(0, 1); });
    expect(g.buttons & (Btn.SPRINT | Btn.RS_FLICK)).toBe(Btn.SPRINT | Btn.RS_FLICK);
  });

  it('Input glitch: no stuck sprint or stick after a pad disconnect; a button held at the reconnect waits for a release', () => {
    const r = padRig();
    r.frame();
    let f = tick120(r, () => { r.left(-1, 0); r.press(PadButton.R2); });
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.list[0] = null;
    f = tick120(r);
    expect([f.buttons, f.mx, f.mz, f.ax, f.az]).toEqual([0, 0, 0, 0, 0]);
    const back = mockPad(2);
    setBtn(back, PadButton.R2, 1);
    back.axes[0] = 1;
    r.list[2] = back;
    r.frame(TICK); // reconnect poll (button already down: no edge)
    r.frame(TICK);
    f = r.sample(S);
    expect(f.mx).toBe(AXIS_SCALE);
    expect(f.buttons & Btn.SPRINT).toBe(0);
    setBtn(back, PadButton.R2, 0); r.frame(TICK); r.sample(S);
    setBtn(back, PadButton.R2, 1); r.frame(TICK);
    expect(r.sample(S).buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('dispose: neutral frames, no more polling of the pad', () => {
    const onPause = vi.fn();
    const r = padRig({ onPause });
    r.frame();
    r.src.dispose();
    r.press(PadButton.START);
    r.press(PadButton.SOUTH);
    r.frame();
    expect(r.sample(S).buttons).toBe(0);
    expect(onPause).not.toHaveBeenCalled();
  });
});

describe('PAD-02 remaps for non-standard pads (settings.controls.pad.remaps)', () => {
  // A generic pad whose face buttons are wired 1,2,0,3, shoulders 4/5, triggers on 6/7 as plain buttons, start 11.
  const REMAP = [1, 2, 0, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15];

  it('a non-standard pad is read through its saved remap (action -> raw button index)', () => {
    const pad = mockPad(0, GENERIC_ID, '', 20);
    const onPause = vi.fn();
    const r = padRig({ pad, onPause, settings: settingsWithRemaps({ [GENERIC_ID]: REMAP }) });
    r.frame();
    expect(btns(tick120(r, () => r.press(1), () => r.release(1)))).toBe(Btn.PASS);
    expect(btns(tick120(r, () => r.press(0), () => r.release(0)))).toBe(Btn.LOB);
    expect(btns(tick120(r, () => r.press(2), () => r.release(2)))).toBe(Btn.SHOOT);
    tick120(r, () => r.press(11), () => r.release(11));
    expect(onPause).toHaveBeenCalledTimes(1);
    tick120(r, () => r.press(9), () => r.release(9)); // standard Options position: not bound on this pad
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(r.src.remapped).toBe(true);
  });

  it('remapped SHIELD / SPRINT on raw indices past 15 keep the analogue threshold and hysteresis', () => {
    const pad = mockPad(0, GENERIC_ID, '', 24);
    const map = [...REMAP];
    map[PadAction.SPRINT] = 21;
    map[PadAction.SHIELD] = 20;
    const r = padRig({ pad, settings: settingsWithRemaps({ [GENERIC_ID]: map }) });
    r.frame();
    expect(btns(tick120(r, () => setBtn(pad, 21, 0.25)))).toBe(0);
    expect(btns(tick120(r, () => setBtn(pad, 21, 0.35)))).toBe(Btn.SPRINT);
    expect(btns(tick120(r, () => setBtn(pad, 21, 0.27)))).toBe(Btn.SPRINT);
    expect(btns(tick120(r, () => setBtn(pad, 21, 0.2)))).toBe(0);
    // A digital-only button (pressed with value 0) reads as fully pressed.
    expect(btns(tick120(r, () => { pad.buttons[20]!.pressed = true; pad.buttons[20]!.value = 0; }))).toBe(Btn.SHIELD);
  });

  it('a standard pad ignores remaps; a non-standard pad without one uses the standard positions; bad entries are unbound', () => {
    const r = padRig({ settings: settingsWithRemaps({ [STANDARD_ID]: REMAP }) });
    r.frame();
    expect(btns(tick120(r, () => r.press(0), () => r.release(0)))).toBe(Btn.PASS);
    expect(r.src.remapped).toBe(false);

    const g = padRig({ pad: mockPad(0, GENERIC_ID, ''), settings: settingsWithRemaps({}) });
    g.frame();
    expect(btns(tick120(g, () => g.press(0), () => g.release(0)))).toBe(Btn.PASS);

    const out = new Int16Array(PAD_ACTION_COUNT);
    expect(resolvePadRemap({ x: [1, -1, 2.5, 99, Number.NaN] as number[] }, 'x', false, out)).toBe(true);
    expect(Array.from(out)).toEqual([1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    expect(resolvePadRemap({}, 'constructor', false, out)).toBe(false);
    expect(Array.from(out)).toEqual(PAD_STANDARD_INDEX);
    expect(resolvePadRemap(null, 'x', false, out)).toBe(false);
    expect(resolvePadRemap({ x: 'nope' } as unknown as Record<string, number[]>, 'x', false, out)).toBe(false);
  });
});

describe('PAD-02 determinism of the frame stream', () => {
  /** A deterministic pseudo-random pad session (LCG): buttons, triggers, both sticks, D-pad. */
  function session(seed: number): InputFrame[] {
    let x = seed >>> 0;
    const rnd = (): number => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 4294967296;
    };
    const s = scene();
    const r = padRig();
    const out: InputFrame[] = [];
    for (let k = 0; k < 600; k++) {
      for (let sub = 0; sub < 2; sub++) {
        const b = Math.floor(rnd() * 16);
        if (rnd() < 0.3) setBtn(r.pad, b, r.pad.buttons[b]!.value > 0 ? 0 : (b === 6 || b === 7 ? 0.2 + rnd() * 0.8 : 1));
        if (rnd() < 0.2) r.left(rnd() * 2 - 1, rnd() * 2 - 1);
        if (rnd() < 0.2) r.right(rnd() * 2 - 1, rnd() * 2 - 1);
        r.frame(TICK / 2);
      }
      out.push(r.sample(s));
    }
    return out;
  }

  it('the same pad state sequence gives a bit-identical InputFrame stream (integers only)', () => {
    const a = session(12345);
    const b = session(12345);
    expect(b).toEqual(a);
    for (const f of a) for (const v of Object.values(f)) expect(Number.isInteger(v)).toBe(true);
    expect(a.some((f) => f.buttons !== 0)).toBe(true);
    expect(session(999)).not.toEqual(a);
  });
});

describe('PAD-02 allocation', () => {
  /**
   * Heap growth per animation frame (poll every frame, sample every second one) with gc exposed via v8 flags. The
   * clock steps in whole milliseconds: V8 boxes a non-integer double stored into a closure variable (here the test
   * clock, the manager's lastPollMs), an engine artefact JavaScriptCore does not have.
   */
  function bytesPerFrame(opts: { sticks: boolean; rightStick?: RightStickTracker }): number {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const s: SimState = scene();
    const r = padRig({ rightStick: opts.rightStick });
    const out = createInputFrame();
    const ctx = { tick: 1, human: 0, side: 0, state: s, projector: null };
    let k = 0;
    const loop = (n: number): void => {
      for (let i = 0; i < n; i++) {
        k++;
        const b = k % 16;
        const on = (k >> 4) % 2 === 0;
        r.pad.buttons[b]!.pressed = on; r.pad.buttons[b]!.value = on ? 1 : 0;
        if (opts.sticks) { r.pad.axes[0] = ((k % 7) - 3) / 3; r.pad.axes[2] = ((k % 11) - 5) / 5; r.pad.axes[3] = 0.5; }
        r.frame(8);
        if ((k & 1) === 0) r.sampleInto(out, ctx);
      }
    };
    loop(20000);
    // Best of three rounds: GC / JIT noise only ever adds bytes; a real per-frame allocation shows in every round.
    let best = Infinity;
    for (let round = 0; round < 3; round++) {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      const n = 40000;
      loop(n);
      const b = (process.memoryUsage().heapUsed - h0) / n;
      if (b < best) best = b;
    }
    return best;
  }

  it('pollFrame + sample allocate nothing per frame (buttons, D-pad, Options, sticks)', () => {
    // An object or array per frame would be >= 16 bytes per frame; allow GC/JIT noise below that.
    expect(bytesPerFrame({ sticks: false })).toBeLessThan(16);
    // Moving sticks: the mapper's own stick maths is inline; PAD-05's tracker (stubbed out here) keeps its stick
    // samples in closure variables, which V8 (not JavaScriptCore) boxes.
    expect(bytesPerFrame({ sticks: true, rightStick: noRightStick() })).toBeLessThan(16);
  }, 60_000);

  it('writePadSticks gives exactly the numbers of axes.ts writeMoveAxes / writeAimAxes', () => {
    const a = createInputFrame();
    const b = createInputFrame();
    const slot = { lx: 0, ly: 0, rx: 0, ry: 0 } as unknown as PadSlot;
    for (const rot of [0, 0.3, -Math.PI / 2, Math.PI]) {
      const proj = rotProjector(rot);
      for (let x = -1; x <= 1.001; x += 0.125) {
        for (let y = -1; y <= 1.001; y += 0.25) {
          slot.lx = x; slot.ly = y; slot.rx = -y * 0.7; slot.ry = x * 0.9;
          writePadSticks(a, slot, rot === 0 ? null : proj);
          writeMoveAxes(b, slot.lx, slot.ly, rot === 0 ? null : proj);
          writeAimAxes(b, slot.rx, slot.ry, rot === 0 ? null : proj);
          expect([a.mx, a.mz, a.ax, a.az]).toEqual([b.mx, b.mz, b.ax, b.az]);
        }
      }
    }
  });
});

function noRightStick(): RightStickTracker {
  return {
    skillDirX: 0, skillDirZ: 0, sector: -1,
    update() { /* none */ }, consume: () => 0, reset() { /* none */ }, setLeft() { /* none */ },
    updatePad() { /* none */ }, setFacing() { /* none */ }, setStickRotation() { /* none */ },
    setSkillsEnabled() { /* none */ }, setContext() { /* none */ }, consumeSkill: () => SkillMove.NONE,
    applyTo() { /* none */ },
  };
}

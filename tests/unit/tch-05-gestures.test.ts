/**
 * TCH-05 pitch gestures (BRIEF section 9 "Pitch gestures" and "Touch quality bar"; brief TCH-05): classification of
 * synthetic pointer paths (taps, double taps, straight / curved / back-and-forth swipes, slow drags ignored),
 * curvature sign, end velocity, the held-back single tap and the double-tap window, per-rule settings, fromBall,
 * cancel / releaseAll safety, multi-touch, the timer fallback, routing through the real pointer router next to the
 * stick and a button (glitch list: "button swipe read as a pitch gesture"; "stuck ... after pointercancel"), and a
 * no-allocation probe. Pure Node: controls are driven through the TouchControl interface with synthetic times.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GestureKind } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import {
  ClusterMode, createTouchIntentState, pushGestureEvent, SwipeDir, TOUCH_QUEUE_SIZE, TouchButtonId, TouchEdge,
  type TouchGestureEvent, type TouchIntentState,
} from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { createTouchButton } from '../../src/input/touch/button';
import {
  anyGestureOn, classifyPath, createPathClass, createPitchGestures, GESTURE_RULE_KIND, GESTURE_RULE_LABEL, GESTURE_RULES,
  GestureRule, gestureKindFor, isGestureKindOn, isGestureRuleOn, LOCAL_TUNING, pushPathSample, queueGesture, type GestureSettings,
  type PathClass, type PitchGestureControl, type PitchGestureOptions,
} from '../../src/input/touch/gestures';
import { createPointerRouter } from '../../src/input/touch/pointers';
import { createStick } from '../../src/input/touch/stick';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const W = 1180;
const DT = T_TOUCHUI.doubleTapMs;
const deg = Math.PI / 180;

interface S { x: number; y: number; t: number }

/** Uniform straight path, `steps` segments. */
function line(x0: number, y0: number, x1: number, y1: number, t0: number, dur: number, steps = 8): S[] {
  const out: S[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    out.push({ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, t: t0 + dur * f });
  }
  return out;
}

/** Circular arc (screen space, y down: increasing angle runs clockwise on screen). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, t0: number, dur: number, steps = 24): S[] {
  const out: S[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = a0 + (a1 - a0) * f;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), t: t0 + dur * f });
  }
  return out;
}

/** Concatenate path pieces (drops each later piece's first point, which repeats the previous end). */
function join(...parts: S[][]): S[] {
  const out: S[] = [...parts[0]!];
  for (let i = 1; i < parts.length; i++) out.push(...parts[i]!.slice(1));
  return out;
}

function rotate(path: S[], ang: number, ox: number, oy: number): S[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  return path.map((p) => ({ x: ox + (p.x - ox) * c - (p.y - oy) * s, y: oy + (p.x - ox) * s + (p.y - oy) * c, t: p.t }));
}

function mirrorY(path: S[], oy: number): S[] {
  return path.map((p) => ({ x: p.x, y: 2 * oy - p.y, t: p.t }));
}

function classify(path: S[]): PathClass {
  const out = createPathClass();
  classifyPath(path.map((p) => p.x), path.map((p) => p.y), path.map((p) => p.t), path.length, out);
  return out;
}

/** Exact signed-area curvature of a circular arc of angle th (radians), before clamping. */
const arcCurve = (th: number): number => (th - Math.sin(th)) / (8 * Math.sin(th / 2) ** 2) / LOCAL_TUNING.curveFullRatio;

interface Rig { st: TouchIntentState; g: PitchGestureControl; ev(): TouchGestureEvent[] }

function rig(over: Partial<PitchGestureOptions> = {}): Rig {
  const st = createTouchIntentState();
  const g = createPitchGestures({ state: st, zone: (x) => x >= W / 2, timers: false, ...over });
  return { st, g, ev: () => st.gestureEvents.slice(0, st.gestureEventCount).map((e) => ({ ...e })) };
}

/** Drive one pointer along a path: down at the first sample, moves, up at the last. */
function stroke(g: PitchGestureControl, id: number, path: S[]): void {
  g.down(id, path[0]!.x, path[0]!.y, path[0]!.t);
  for (let i = 1; i < path.length - 1; i++) g.move(id, path[i]!.x, path[i]!.y, path[i]!.t);
  const e = path[path.length - 1]!;
  g.up(id, e.x, e.y, e.t);
}

function tap(g: PitchGestureControl, id: number, x: number, y: number, t: number, dur = 80): void {
  g.down(id, x, y, t);
  g.up(id, x + 2, y + 1, t + dur);
}

function settingsWith(off: Partial<Record<GestureRule, boolean>>, gestures = true): GestureSettings {
  return { gestures, gestureEnabled: { ...off } };
}

function expectFinite(e: TouchGestureEvent): void {
  for (const k of ['sx', 'sy', 'ex', 'ey', 'vx', 'vy', 'curve', 'tMs'] as const) expect(Number.isFinite(e[k]), k).toBe(true);
  expect(Math.abs(e.curve)).toBeLessThanOrEqual(1);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------- classifyPath

describe('TCH-05 classifyPath: taps and non-gestures', () => {
  it('a short touch with travel <= tapMaxPt is a TAP (start = touch-down, end = lift)', () => {
    const c = classify([{ x: 800, y: 400, t: 0 }, { x: 803, y: 402, t: 80 }]);
    expect(c.kind).toBe(GestureKind.TAP);
    expect([c.sx, c.sy, c.ex, c.ey]).toEqual([800, 400, 803, 402]);
    expect([c.vx, c.vy, c.curve]).toEqual([0, 0, 0]);
  });

  it('a sloppy tap that wanders up to tapMaxPt within tapMaxMs is still a TAP', () => {
    const p: S[] = [{ x: 800, y: 400, t: 0 }];
    for (let i = 1; i <= 10; i++) p.push({ x: 800 + (i % 2 ? 9 : -9), y: 400 + (i % 3) * 3, t: i * 20 });
    p.push({ x: 800 + T_TOUCHUI.tapMaxPt, y: 400, t: T_TOUCHUI.tapMaxMs });
    expect(classify(p).kind).toBe(GestureKind.TAP);
  });

  it('a press longer than tapMaxMs without travel is nothing (long press)', () => {
    expect(classify([{ x: 800, y: 400, t: 0 }, { x: 801, y: 400, t: T_TOUCHUI.tapMaxMs + 1 }]).kind).toBe(GestureKind.NONE);
  });

  it('a quick wiggle between tapMaxPt and swipeMinPt is nothing', () => {
    expect(classify(line(800, 400, 825, 400, 0, 60)).kind).toBe(GestureKind.NONE);
  });

  it('slow drags are ignored: too slow on average, or longer than swipeMaxMs', () => {
    // 150 px in 600 ms = 0.25 px/ms < swipeMinSpeed.
    expect(classify(line(700, 400, 850, 400, 0, 600, 36)).kind).toBe(GestureKind.NONE);
    // 400 px (fast enough) but over 1.2 s.
    expect(classify(line(650, 300, 1050, 300, 0, 1200, 72)).kind).toBe(GestureKind.NONE);
    // The same 150 px in 150 ms is a swipe.
    expect(classify(line(700, 400, 850, 400, 0, 150, 9)).kind).toBe(GestureKind.SWIPE);
  });

  it('drag-and-hold: a fast stroke that rests longer than swipeRestMaxMs before lifting is ignored', () => {
    const fast = line(700, 400, 900, 400, 0, 120, 8);
    const held = join(fast, line(900, 400, 901, 400, 120, LOCAL_TUNING.swipeRestMaxMs + 60, 6));
    expect(classify(held).kind).toBe(GestureKind.NONE);
    const brief = join(fast, line(900, 400, 901, 400, 120, LOCAL_TUNING.swipeRestMaxMs - 40, 3));
    expect(classify(brief).kind).toBe(GestureKind.SWIPE);
  });
});

describe('TCH-05 classifyPath: swipes and velocity', () => {
  it('a straight swipe: SWIPE from touch-down to lift, end velocity in px/ms, curvature ~0', () => {
    const c = classify(line(700, 400, 900, 400, 1000, 120, 8));
    expect(c.kind).toBe(GestureKind.SWIPE);
    expect([c.sx, c.sy, c.ex, c.ey]).toEqual([700, 400, 900, 400]);
    expect(c.vx).toBeCloseTo(200 / 120, 3);
    expect(c.vy).toBeCloseTo(0, 6);
    expect(Math.abs(c.curve)).toBeLessThan(1e-9);
    expect(c.durMs).toBe(120);
    expect(c.strokes).toBe(1);
  });

  it('end velocity follows the direction of the swipe (any direction)', () => {
    for (let a = 0; a < 360; a += 30) {
      const ex = 800 + 150 * Math.cos(a * deg), ey = 400 + 150 * Math.sin(a * deg);
      const c = classify(line(800, 400, ex, ey, 0, 100, 6));
      expect(c.kind).toBe(GestureKind.SWIPE);
      expect(c.vx).toBeCloseTo(1.5 * Math.cos(a * deg), 3);
      expect(c.vy).toBeCloseTo(1.5 * Math.sin(a * deg), 3);
    }
  });

  it('end velocity is the release speed, not the mean: an accelerating flick reports more than its average', () => {
    const p: S[] = [];
    for (let t = 0; t <= 150; t += 10) p.push({ x: 700 + 0.01 * t * t, y: 400, t });
    const c = classify(p);
    expect(c.kind).toBe(GestureKind.SWIPE);
    const mean = 225 / 150;
    expect(c.vx).toBeGreaterThan(1.5 * mean);
    expect(c.vx).toBeLessThanOrEqual(3 + 1e-9); // true speed at release = 0.02 * 150
  });

  it('a lift reported a frame after the last move at the same spot does not dilute the end velocity', () => {
    const base = line(700, 400, 900, 400, 0, 120, 8);
    const lifted = [...base, { x: 900, y: 400, t: 136 }];
    expect(classify(lifted).vx).toBeCloseTo(classify(base).vx, 6);
  });

  it('identical timestamps (coalesced synthetic events) stay finite', () => {
    const c = classify(line(700, 400, 900, 450, 50, 0, 5));
    expect(c.kind).toBe(GestureKind.SWIPE);
    expect(Number.isFinite(c.vx) && Number.isFinite(c.vy)).toBe(true);
  });
});

describe('TCH-05 classifyPath: curvature', () => {
  it('a swipe bending clockwise on screen has positive curvature, the mirror image negative (curvature sign)', () => {
    // Over the top from left to right: heading right, turning down = clockwise on a y-down screen.
    const cw = arc(800, 500, 150, -120 * deg, -60 * deg, 0, 150);
    const c1 = classify(cw);
    expect(c1.kind).toBe(GestureKind.CURVED_SWIPE);
    expect(c1.curve).toBeGreaterThan(LOCAL_TUNING.curvedMin);
    expect(c1.curve).toBeCloseTo(arcCurve(60 * deg), 1);
    const c2 = classify(mirrorY(cw, 400));
    expect(c2.kind).toBe(GestureKind.CURVED_SWIPE);
    expect(c2.curve).toBeCloseTo(-c1.curve, 9);
  });

  it('the sign does not depend on the swipe direction (rotations of the same bend)', () => {
    const cw = arc(800, 500, 150, -120 * deg, -60 * deg, 0, 150);
    for (let a = 0; a < 360; a += 45) {
      const r = rotate(cw, a * deg, 800, 400);
      expect(classify(r).curve, `rot ${a}`).toBeGreaterThan(LOCAL_TUNING.curvedMin);
      expect(classify(mirrorY(r, 400)).curve, `rot ${a} mirrored`).toBeLessThan(-LOCAL_TUNING.curvedMin);
    }
  });

  it('curvature grows with the bend and saturates at 1', () => {
    let prev = -1;
    for (const th of [10, 25, 40, 60, 80, 100]) {
      const c = classify(arc(800, 500, 160, -90 * deg - (th / 2) * deg, -90 * deg + (th / 2) * deg, 0, 160));
      expect(c.curve, `${th} deg`).toBeGreaterThan(prev);
      prev = c.curve;
    }
    expect(classify(arc(800, 500, 100, -170 * deg, -10 * deg, 0, 200)).curve).toBe(1);
  });

  it('a slight natural thumb arc stays a plain SWIPE (with its small curvature reported)', () => {
    const c = classify(arc(800, 900, 600, -90 * deg - 12 * deg, -90 * deg + 12 * deg, 0, 150));
    expect(c.kind).toBe(GestureKind.SWIPE);
    expect(c.curve).toBeGreaterThan(0);
    expect(c.curve).toBeLessThan(LOCAL_TUNING.curvedMin);
  });

  it('a sharp 90 degree corner is a curved swipe, not a back-and-forth swipe', () => {
    const c = classify(join(line(700, 400, 800, 400, 0, 80, 5), line(800, 400, 800, 500, 80, 80, 5)));
    expect(c.kind).toBe(GestureKind.CURVED_SWIPE);
    expect(c.curve).toBeGreaterThan(0); // right then down = clockwise
  });
});

describe('TCH-05 classifyPath: back-and-forth swipes', () => {
  it('pull back then flick forward: BACK_FORTH_SWIPE along the forward stroke, velocity of that stroke', () => {
    const c = classify(join(line(800, 400, 760, 400, 0, 60, 4), line(760, 400, 900, 400, 60, 80, 6)));
    expect(c.kind).toBe(GestureKind.BACK_FORTH_SWIPE);
    expect(c.strokes).toBe(2);
    expect([c.sx, c.ex]).toEqual([760, 900]);
    expect(c.vx).toBeCloseTo(140 / 80, 3);
    expect(c.curve).toBe(0);
  });

  it('flick forward then back: the main (longest) stroke gives the direction', () => {
    const c = classify(join(line(800, 400, 920, 400, 0, 80, 6), line(920, 400, 880, 400, 80, 50, 4)));
    expect(c.kind).toBe(GestureKind.BACK_FORTH_SWIPE);
    expect([c.sx, c.ex]).toEqual([800, 920]);
    expect(c.vx).toBeGreaterThan(1);
  });

  it('a quick zigzag forth-back-forth (any angle) is one BACK_FORTH_SWIPE with three strokes', () => {
    const z = join(line(800, 400, 860, 400, 0, 50, 4), line(860, 400, 810, 400, 50, 50, 4), line(810, 400, 900, 400, 100, 60, 4));
    for (let a = 0; a < 360; a += 60) {
      const c = classify(rotate(z, a * deg, 800, 400));
      expect(c.kind, `rot ${a}`).toBe(GestureKind.BACK_FORTH_SWIPE);
      expect(c.strokes).toBe(3);
      expect(c.vx * Math.cos(a * deg) + c.vy * Math.sin(a * deg)).toBeGreaterThan(0);
    }
  });

  it('a small hook at the end of a swipe is not a reversal', () => {
    const c = classify(join(line(700, 400, 900, 400, 0, 120, 8), line(900, 400, 890, 400, 120, 16, 1)));
    expect(c.kind).toBe(GestureKind.SWIPE);
  });

  it('a slow back-and-forth (over swipeMaxMs) is ignored', () => {
    const c = classify(join(line(800, 400, 700, 400, 0, 400, 20), line(700, 400, 950, 400, 400, 400, 20)));
    expect(c.kind).toBe(GestureKind.NONE);
  });
});

describe('TCH-05 pushPathSample (fixed sample buffer)', () => {
  it('thins in place when full: keeps the touch-down point and the newest sample, times stay ordered', () => {
    const cap = 16;
    const xs = new Float64Array(cap), ys = new Float64Array(cap), ts = new Float64Array(cap);
    let n = 0;
    for (let i = 0; i < 1000; i++) {
      n = pushPathSample(xs, ys, ts, n, cap, i, -i, i * 2);
      expect(n).toBeLessThanOrEqual(cap);
      expect(xs[0]).toBe(0);
      expect(xs[n - 1]).toBe(i);
      for (let k = 1; k < n; k++) expect(ts[k]!).toBeGreaterThan(ts[k - 1]!);
    }
  });
});

describe('TCH-05 queueGesture (allocation-free pushGestureEvent)', () => {
  it('matches the contract helper exactly, including drop-oldest on overflow', () => {
    const a = createTouchIntentState(), b = createTouchIntentState();
    for (let i = 0; i < TOUCH_QUEUE_SIZE + 9; i++) {
      const g: TouchGestureEvent = {
        kind: (i % 5) + 1, sx: i + 0.5, sy: -i, ex: i * 2.25, ey: 3, vx: i / 7, vy: -i / 3, curve: (i % 3) / 3 - 0.5, tMs: i * 16.7, fromBall: i % 2 === 0,
      };
      queueGesture(a, g);
      pushGestureEvent(b, g);
      expect(a.gestureEventCount).toBe(b.gestureEventCount);
    }
    expect(a.gestureEventCount).toBe(TOUCH_QUEUE_SIZE);
    expect(a.gestureEvents).toEqual(b.gestureEvents);
    expect(a.gestureEvents[0]!.sx).toBe(9.5);
  });
});

// ---------------------------------------------------------------------------------------------------- the control

describe('TCH-05 control: swipes', () => {
  it('a swipe on the pitch pushes one SWIPE event (screen space) at lift', () => {
    const { g, ev } = rig();
    g.down(1, 700, 400, 1000);
    g.move(1, 760, 400, 1030);
    expect(ev()).toEqual([]); // nothing before the finger lifts
    g.move(1, 830, 400, 1060);
    g.up(1, 900, 400, 1090);
    const e = ev();
    expect(e).toHaveLength(1);
    expect(e[0]!.kind).toBe(GestureKind.SWIPE);
    expect([e[0]!.sx, e[0]!.sy, e[0]!.ex, e[0]!.ey]).toEqual([700, 400, 900, 400]);
    expect(e[0]!.vx).toBeGreaterThan(2);
    expect(e[0]!.tMs).toBe(1090);
    expect(e[0]!.fromBall).toBe(false);
    expect(g.active).toBe(0);
  });

  it('curved and back-and-forth swipes come out with their kinds and curvature', () => {
    const { g, ev } = rig();
    stroke(g, 1, arc(800, 500, 150, -120 * deg, -60 * deg, 0, 150));
    stroke(g, 2, join(line(800, 400, 760, 400, 500, 60, 4), line(760, 400, 900, 400, 560, 80, 6)));
    const e = ev();
    expect(e.map((x) => x.kind)).toEqual([GestureKind.CURVED_SWIPE, GestureKind.BACK_FORTH_SWIPE]);
    expect(e[0]!.curve).toBeGreaterThan(LOCAL_TUNING.curvedMin);
    expect(e[1]!.curve).toBe(0);
    expect(e[1]!.sx).toBe(760);
  });

  it('a slow drag on the pitch produces nothing', () => {
    const { g, ev } = rig();
    stroke(g, 1, line(700, 400, 900, 400, 0, 1500, 90));
    g.update(5000);
    expect(ev()).toEqual([]);
  });

  it('a flood of move events (more than the sample buffer) is still one clean SWIPE', () => {
    const { g, ev } = rig();
    stroke(g, 1, line(650, 300, 1050, 300, 0, 400, 2000));
    const e = ev();
    expect(e).toHaveLength(1);
    expect(e[0]!.kind).toBe(GestureKind.SWIPE);
    expect(e[0]!.sx).toBe(650);
    expect(e[0]!.ex).toBe(1050);
    expect(e[0]!.vx).toBeCloseTo(1, 2);
  });
});

describe('TCH-05 control: taps and double taps', () => {
  it('a single tap is held back for the double-tap window, then emitted as a TAP stamped with its lift time', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 1000, 80);
    expect(ev()).toEqual([]);
    expect(g.pendingTap).toBe(true);
    g.update(1000 + DT);
    expect(ev()).toEqual([]);
    g.update(1000 + DT + 1);
    const e = ev();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: GestureKind.TAP, sx: 800, sy: 400, ex: 802, ey: 401, vx: 0, vy: 0, curve: 0, tMs: 1080 });
    expect(g.pendingTap).toBe(false);
    g.update(5000);
    expect(ev()).toHaveLength(1);
  });

  it('a double tap emits exactly one DOUBLE_TAP (first tap = target, second tap = end) and no TAP', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 1000, 70);
    tap(g, 2, 810, 395, 1000 + 180, 70);
    g.update(9000);
    const e = ev();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: GestureKind.DOUBLE_TAP, sx: 800, sy: 400, ex: 812, ey: 396, tMs: 1250 });
  });

  it('the second tap may land up to doubleTapMs after the first touch-down (down to down), not later', () => {
    const a = rig();
    tap(a.g, 1, 800, 400, 0, 60);
    tap(a.g, 1, 800, 400, DT, 60);
    a.g.update(9000);
    expect(a.ev().map((e) => e.kind)).toEqual([GestureKind.DOUBLE_TAP]);
    const b = rig();
    tap(b.g, 1, 800, 400, 0, 60);
    tap(b.g, 1, 800, 400, DT + 1, 60);
    b.g.update(9000);
    expect(b.ev().map((e) => e.kind)).toEqual([GestureKind.TAP, GestureKind.TAP]);
  });

  it('a second tap too far from the first is a separate TAP (the first is emitted at once)', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 60);
    g.down(2, 800 + LOCAL_TUNING.doubleTapSlopPt + 5, 400, 120);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    g.up(2, 800 + LOCAL_TUNING.doubleTapSlopPt + 5, 400, 180);
    g.update(9000);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP, GestureKind.TAP]);
    expect(ev()[1]!.sx).toBe(800 + LOCAL_TUNING.doubleTapSlopPt + 5);
  });

  it('a second touch that turns into a swipe: TAP first, then the SWIPE', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 60);
    g.down(2, 805, 400, 150);
    expect(ev()).toEqual([]);
    g.move(2, 805 + T_TOUCHUI.tapMaxPt + 6, 400, 170);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    g.move(2, 900, 400, 200);
    g.up(2, 980, 400, 230);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP, GestureKind.SWIPE]);
  });

  it('a second touch that is held: the first tap is emitted once the hold passes tapMaxMs; the hold itself is nothing', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 60);
    g.down(2, 800, 400, 200);
    g.update(200 + T_TOUCHUI.tapMaxMs);
    expect(ev()).toEqual([]);
    g.update(200 + T_TOUCHUI.tapMaxMs + 1);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    g.up(2, 801, 400, 900);
    g.update(9000);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
  });

  it('a triple tap is a DOUBLE_TAP followed by a (held-back) TAP', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 50);
    tap(g, 1, 800, 400, 120, 50);
    tap(g, 1, 800, 400, 240, 50);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.DOUBLE_TAP]);
    g.update(240 + DT + 1);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.DOUBLE_TAP, GestureKind.TAP]);
  });

  it('a held-back tap is emitted before a later swipe of another finger (events stay in order)', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 50);
    stroke(g, 2, line(650, 250, 850, 250, 60, 100, 5));
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP, GestureKind.SWIPE]);
  });

  it('with every double-tap rule off, taps are emitted at lift and a double tap is two TAPs', () => {
    const touch = settingsWith({ [GestureRule.LOBBED]: false, [GestureRule.CROSS]: false, [GestureRule.SECOND_DEF]: false });
    const { g, ev } = rig({ settings: () => touch });
    tap(g, 1, 800, 400, 0, 60);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    expect(g.pendingTap).toBe(false);
    tap(g, 1, 800, 400, 100, 60);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP, GestureKind.TAP]);
  });

  it('cut-scenes (ClusterMode.HIDDEN): a tap is emitted at once, even with gestures switched off (any tap skips)', () => {
    const off = settingsWith({}, false);
    const { st, g, ev } = rig({ settings: () => off });
    st.mode = ClusterMode.HIDDEN;
    expect(g.hit(800, 400)).toBe(true);
    tap(g, 1, 800, 400, 0, 60);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    stroke(g, 2, line(700, 400, 900, 400, 100, 100, 5));
    expect(ev()).toHaveLength(1); // swipes still follow the settings
    st.mode = ClusterMode.ATTACK;
    expect(g.hit(800, 400)).toBe(false);
  });
});

describe('TCH-05 settings: master switch and per-rule toggles', () => {
  it('section 9 rule table: 14 unique keys, each with a kind and a label', () => {
    expect(GESTURE_RULES).toHaveLength(14);
    expect(new Set(GESTURE_RULES).size).toBe(14);
    for (const r of GESTURE_RULES) {
      expect(GESTURE_RULE_KIND[r]).toBeGreaterThan(GestureKind.NONE);
      expect(GESTURE_RULE_LABEL[r].length).toBeGreaterThan(5);
    }
    expect(GESTURE_RULE_KIND[GestureRule.CHIP]).toBe(GestureKind.TAP);
    expect(GESTURE_RULE_KIND[GestureRule.LOBBED]).toBe(GestureKind.DOUBLE_TAP);
    expect(GESTURE_RULE_KIND[GestureRule.FINESSE]).toBe(GestureKind.CURVED_SWIPE);
    expect(GESTURE_RULE_KIND[GestureRule.POWER]).toBe(GestureKind.BACK_FORTH_SWIPE);
    expect(GESTURE_RULE_KIND[GestureRule.SLIDE]).toBe(GestureKind.SWIPE);
  });

  it('defaults are all on (default settings, empty gestureEnabled, or no settings)', () => {
    const def = createDefaultSettings().controls.touch;
    for (const r of GESTURE_RULES) {
      expect(isGestureRuleOn(def, r)).toBe(true);
      expect(isGestureRuleOn(null, r)).toBe(true);
    }
    expect(anyGestureOn(def)).toBe(true);
    expect(isGestureRuleOn(settingsWith({}, false), GestureRule.SHOT)).toBe(false);
    expect(isGestureRuleOn(settingsWith({ [GestureRule.SHOT]: false }), GestureRule.SHOT)).toBe(false);
    expect(isGestureRuleOn(settingsWith({ [GestureRule.SHOT]: false }), GestureRule.SLIDE)).toBe(true);
  });

  it('gestureKindFor: fallbacks for curved / back-and-forth swipes, NONE when no rule can use a kind', () => {
    const noFinesse = settingsWith({ [GestureRule.FINESSE]: false });
    expect(gestureKindFor(GestureKind.CURVED_SWIPE, noFinesse)).toBe(GestureKind.SWIPE);
    const noPower = settingsWith({ [GestureRule.POWER]: false });
    expect(gestureKindFor(GestureKind.BACK_FORTH_SWIPE, noPower)).toBe(GestureKind.SWIPE);
    const noPlain = settingsWith({ [GestureRule.SHOT]: false, [GestureRule.SLIDE]: false, [GestureRule.CLEAR]: false });
    expect(gestureKindFor(GestureKind.SWIPE, noPlain)).toBe(GestureKind.NONE);
    expect(gestureKindFor(GestureKind.CURVED_SWIPE, noPlain)).toBe(GestureKind.CURVED_SWIPE);
    expect(gestureKindFor(GestureKind.CURVED_SWIPE, { ...noPlain, gestureEnabled: { ...noPlain.gestureEnabled, [GestureRule.FINESSE]: false } })).toBe(GestureKind.NONE);
    const noTaps = settingsWith({
      [GestureRule.PASS]: false, [GestureRule.THROUGH]: false, [GestureRule.CHIP]: false, [GestureRule.PRESS]: false,
      [GestureRule.KEEPER_RUSH]: false, [GestureRule.SWITCH]: false,
    });
    expect(isGestureKindOn(noTaps, GestureKind.TAP)).toBe(false);
    expect(gestureKindFor(GestureKind.TAP, noTaps)).toBe(GestureKind.NONE);
    expect(gestureKindFor(GestureKind.DOUBLE_TAP, noTaps)).toBe(GestureKind.DOUBLE_TAP);
    expect(gestureKindFor(GestureKind.NONE, null)).toBe(GestureKind.NONE);
  });

  it('master switch off (TouchSettings.gestures or enabled()): the pitch claims nothing and emits nothing', () => {
    const off = settingsWith({}, false);
    const a = rig({ settings: () => off });
    expect(a.g.hit(800, 400)).toBe(false);
    stroke(a.g, 1, line(700, 400, 900, 400, 0, 100, 5)); // even if routed anyway
    tap(a.g, 2, 800, 300, 200);
    a.g.update(9000);
    expect(a.ev()).toEqual([]);
    let on = true;
    const b = rig({ enabled: () => on });
    expect(b.g.hit(800, 400)).toBe(true);
    on = false;
    expect(b.g.hit(800, 400)).toBe(false);
    stroke(b.g, 1, line(700, 400, 900, 400, 0, 100, 5));
    expect(b.ev()).toEqual([]);
  });

  it('every rule off individually: nothing is claimed', () => {
    const all: Partial<Record<GestureRule, boolean>> = {};
    for (const r of GESTURE_RULES) all[r] = false;
    const { g } = rig({ settings: () => settingsWith(all) });
    expect(g.hit(800, 400)).toBe(false);
  });

  it('per rule: finesse off reports a curved swipe as SWIPE; power shot off reports back-and-forth as SWIPE along the main stroke', () => {
    const touch = settingsWith({ [GestureRule.FINESSE]: false, [GestureRule.POWER]: false });
    const { g, ev } = rig({ settings: () => touch });
    stroke(g, 1, arc(800, 500, 150, -120 * deg, -60 * deg, 0, 150));
    stroke(g, 2, join(line(800, 400, 760, 400, 500, 60, 4), line(760, 400, 900, 400, 560, 80, 6)));
    const e = ev();
    expect(e.map((x) => x.kind)).toEqual([GestureKind.SWIPE, GestureKind.SWIPE]);
    expect(e[0]!.curve).toBeGreaterThan(LOCAL_TUNING.curvedMin);
    expect([e[1]!.sx, e[1]!.ex]).toEqual([760, 900]);
  });

  it('per rule: with shot, slide tackle and clearance off a straight swipe is dropped but a curved one still counts', () => {
    const touch = settingsWith({ [GestureRule.SHOT]: false, [GestureRule.SLIDE]: false, [GestureRule.CLEAR]: false });
    const { g, ev } = rig({ settings: () => touch });
    stroke(g, 1, line(700, 400, 900, 400, 0, 100, 5));
    expect(ev()).toEqual([]);
    stroke(g, 2, arc(800, 500, 150, -120 * deg, -60 * deg, 300, 150));
    expect(ev().map((x) => x.kind)).toEqual([GestureKind.CURVED_SWIPE]);
  });

  it('settings are live: switching a rule off before the lift drops that gesture', () => {
    const touch = { gestures: true, gestureEnabled: {} as Record<string, boolean> };
    const { g, ev } = rig({ settings: () => touch });
    g.down(1, 700, 400, 0);
    g.move(1, 800, 400, 50);
    touch.gestures = false;
    g.up(1, 900, 400, 100);
    expect(ev()).toEqual([]);
  });
});

describe('TCH-05 zone, fromBall, multi-touch', () => {
  it('hit follows the zone and rejects non-finite points', () => {
    const { g } = rig();
    expect(g.hit(W / 2 + 10, 400)).toBe(true);
    expect(g.hit(W / 2 - 10, 400)).toBe(false);
    expect(g.hit(Number.NaN, 400)).toBe(false);
    expect(g.hit(800, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('touch-downs inside the system-gesture margins (top and bottom 24 pt of the window) are not claimed', () => {
    vi.stubGlobal('innerHeight', 820);
    const { g } = rig();
    const m = T_TOUCHUI.systemEdgeMargin;
    expect(g.hit(800, m - 1)).toBe(false);
    expect(g.hit(800, 820 - m + 1)).toBe(false);
    expect(g.hit(800, m)).toBe(true);
    expect(g.hit(800, 400)).toBe(true);
  });

  it('fromBall: set when the touch-down is within fromBallPt of the ball on screen', () => {
    let onScreen = true;
    const { g, ev } = rig({
      ballScreen: (out) => { out.x = 800; out.y = 400; return onScreen; },
    });
    stroke(g, 1, line(820, 410, 1000, 300, 0, 100, 5));
    stroke(g, 2, line(800 + LOCAL_TUNING.fromBallPt + 2, 400, 1000, 300, 300, 100, 5));
    onScreen = false;
    stroke(g, 3, line(800, 400, 1000, 300, 600, 100, 5));
    expect(ev().map((e) => e.fromBall)).toEqual([true, false, false]);
  });

  it('five pitch fingers at once are tracked independently; a sixth is ignored', () => {
    const { g, ev } = rig();
    for (let i = 0; i < 6; i++) g.down(10 + i, 650 + i * 60, 200 + i * 40, 0);
    expect(g.active).toBe(LOCAL_TUNING.pointers);
    for (let k = 1; k <= 4; k++) {
      for (let i = 0; i < 6; i++) g.move(10 + i, 650 + i * 60 + (i % 2 ? -k * 40 : k * 40), 200 + i * 40, k * 25);
    }
    for (let i = 0; i < 6; i++) g.up(10 + i, 650 + i * 60 + (i % 2 ? -200 : 200), 200 + i * 40, 125);
    const e = ev();
    expect(e).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(e[i]!.kind).toBe(GestureKind.SWIPE);
      expect(Math.sign(e[i]!.vx)).toBe(i % 2 ? -1 : 1);
    }
    expect(g.active).toBe(0);
  });

  it('non-finite input is ignored and time running backwards is clamped: events stay finite', () => {
    const { g, ev } = rig();
    g.down(1, Number.NaN, 400, 0);
    expect(g.active).toBe(0);
    g.down(1, 700, 400, 100);
    g.move(1, Number.NaN, 400, 110);
    g.move(1, 780, 400, 90); // time going backwards
    g.move(1, 860, 400, Number.NaN);
    g.up(1, Number.NaN, Number.NaN, 160);
    const e = ev();
    expect(e).toHaveLength(1);
    expect(e[0]!.kind).toBe(GestureKind.SWIPE);
    expect(e[0]!.ex).toBe(860);
    expectFinite(e[0]!);
  });
});

describe('TCH-05 cancel and releaseAll (glitch list: input after pointercancel)', () => {
  it('pointercancel mid-swipe emits nothing and frees the pointer', () => {
    const { g, ev } = rig();
    g.down(1, 700, 400, 0);
    g.move(1, 800, 400, 40);
    g.cancel(1, 60);
    expect(g.active).toBe(0);
    g.up(1, 900, 400, 80); // a late up for the cancelled pointer is ignored
    g.update(9000);
    expect(ev()).toEqual([]);
  });

  it('a cancelled second tap cancels the double tap: nothing at all is emitted', () => {
    const { g, ev } = rig();
    tap(g, 1, 800, 400, 0, 60);
    g.down(2, 802, 400, 120);
    g.cancel(2, 150);
    g.update(9000);
    expect(ev()).toEqual([]);
    expect(g.pendingTap).toBe(false);
  });

  it('cancelling an unrelated pointer leaves a held-back tap alone', () => {
    const { g, ev } = rig();
    g.down(5, 1000, 200, 0);
    tap(g, 1, 800, 400, 10, 60);
    g.cancel(5, 40);
    g.update(10 + DT + 1);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
  });

  it('releaseAll (blur, visibilitychange, pause) drops every pointer and a held-back tap', () => {
    const { g, ev } = rig();
    g.down(2, 700, 300, 0); // a swipe in progress
    tap(g, 1, 800, 400, 10, 60); // and a tap waiting for its double-tap window
    g.move(2, 800, 300, 120);
    expect(g.active).toBe(1);
    expect(g.pendingTap).toBe(true);
    g.releaseAll(130);
    expect(g.active).toBe(0);
    expect(g.pendingTap).toBe(false);
    g.up(2, 900, 300, 140);
    g.update(9000);
    expect(ev()).toEqual([]);
    // Works normally afterwards.
    stroke(g, 3, line(700, 400, 900, 400, 10_000, 100, 5));
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.SWIPE]);
  });
});

describe('TCH-05 timer fallback', () => {
  it('a held-back tap is emitted by a timer when the window closes, with no further events or update() calls', () => {
    vi.useFakeTimers();
    const { g, ev } = rig({ timers: true });
    tap(g, 1, 800, 400, 1000, 80);
    vi.advanceTimersByTime(DT - 80);
    expect(ev()).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    expect(ev()[0]!.tMs).toBe(1080);
  });

  it('with the timer, a double tap still emits only the DOUBLE_TAP; a held second touch releases the first tap', () => {
    vi.useFakeTimers();
    const a = rig({ timers: true });
    tap(a.g, 1, 800, 400, 0, 60);
    vi.advanceTimersByTime(100);
    tap(a.g, 1, 800, 400, 160, 60);
    vi.advanceTimersByTime(2000);
    expect(a.ev().map((e) => e.kind)).toEqual([GestureKind.DOUBLE_TAP]);
    const b = rig({ timers: true });
    tap(b.g, 1, 800, 400, 0, 60);
    vi.advanceTimersByTime(100);
    b.g.down(2, 800, 400, 160);
    vi.advanceTimersByTime(T_TOUCHUI.tapMaxMs + 2);
    expect(b.ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
    b.g.cancel(2, 600);
    vi.advanceTimersByTime(2000);
    expect(b.ev().map((e) => e.kind)).toEqual([GestureKind.TAP]);
  });

  it('releaseAll stops the timer (no tap after a pause)', () => {
    vi.useFakeTimers();
    const { g, ev } = rig({ timers: true });
    tap(g, 1, 800, 400, 0, 60);
    g.releaseAll(100);
    vi.advanceTimersByTime(2000);
    expect(ev()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- routing

describe('TCH-05 routing next to the stick and the buttons (pointer router, TCH-01/02/03)', () => {
  function routed() {
    const st = createTouchIntentState();
    const btn = createTouchButton({ state: st, id: TouchButtonId.SHOOT, geom: { cx: 1050, cy: 600, r: 38 } });
    const stick = createStick({ state: st, zone: (x) => x < W / 2 });
    const gestures = createPitchGestures({ state: st, zone: () => true, timers: false });
    const router = createPointerRouter([btn, stick, gestures]);
    const kinds = (): GestureKind[] => st.gestureEvents.slice(0, st.gestureEventCount).map((e) => e.kind);
    const buttonEdges = (): TouchEdge[] => st.buttonEvents.slice(0, st.buttonEventCount).map((e) => e.edge);
    return { st, btn, stick, gestures, router, kinds, buttonEdges };
  }

  it('glitch: a button swipe is never read as a pitch gesture', () => {
    const r = routed();
    expect(r.router.down(1, 1050, 600, 0)).toBe(0); // the button owns it
    for (let i = 1; i <= 6; i++) r.router.move(1, 1050 - i * 50, 600 - i * 30, i * 15);
    r.router.up(1, 750, 420, 100);
    r.gestures.update(9000);
    expect(r.kinds()).toEqual([]);
    const swipe = r.st.buttonEvents.slice(0, r.st.buttonEventCount).find((e) => e.edge === TouchEdge.SWIPE);
    expect(swipe?.dir).toBe(SwipeDir.LEFT);
  });

  it('a stick drag is never a pitch gesture, and a pitch swipe never moves the stick (even across the halves)', () => {
    const r = routed();
    expect(r.router.down(1, 300, 400, 0)).toBe(1); // stick
    for (let i = 1; i <= 5; i++) r.router.move(1, 300 + i * 60, 400, i * 15);
    r.router.up(1, 700, 400, 90);
    expect(r.kinds()).toEqual([]);
    expect(r.router.down(2, 900, 300, 200)).toBe(2); // pitch
    r.router.move(2, 700, 300, 230);
    expect(r.st.stickActive).toBe(false);
    r.router.move(2, 450, 300, 260); // into the stick half: still the gesture's pointer
    expect(r.st.stickActive).toBe(false);
    r.router.up(2, 300, 300, 290);
    expect(r.kinds()).toEqual([GestureKind.SWIPE]);
    expect(r.st.stickX).toBe(0);
    expect(r.st.stickY).toBe(0);
  });

  it('five simultaneous touches: stick + button + three pitch fingers all work independently', () => {
    const r = routed();
    r.router.down(1, 200, 400, 0); // stick
    r.router.down(2, 1050, 600, 0); // button
    r.router.down(3, 700, 200, 0);
    r.router.down(4, 800, 300, 0);
    r.router.down(5, 900, 400, 0);
    expect(r.router.active).toBe(5);
    expect(r.gestures.active).toBe(3);
    r.router.move(1, 260, 400, 20);
    expect(r.st.stickActive).toBe(true);
    expect(r.st.stickX).toBeGreaterThan(0.5);
    expect(r.st.held & (1 << TouchButtonId.SHOOT)).not.toBe(0);
    for (let k = 1; k <= 3; k++) {
      r.router.move(3, 700 + k * 60, 200, k * 25);
      r.router.move(4, 800, 300 + k * 50, k * 25);
    }
    r.router.up(3, 900, 200, 100);
    r.router.up(4, 800, 480, 100);
    r.router.up(5, 902, 401, 60); // a tap, held back
    expect(r.kinds()).toEqual([GestureKind.SWIPE, GestureKind.SWIPE]);
    r.gestures.update(1000);
    expect(r.kinds()).toEqual([GestureKind.SWIPE, GestureKind.SWIPE, GestureKind.TAP]);
    expect(r.st.stickActive).toBe(true); // the stick thumb is still down
    expect(r.st.held & (1 << TouchButtonId.SHOOT)).not.toBe(0);
    r.router.releaseAll(1100);
    expect(r.st.stickActive).toBe(false);
    expect(r.st.held).toBe(0);
    expect(r.gestures.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------- allocation

describe('TCH-05 no allocation per pointer event', () => {
  it('tap / double-tap / swipe / curved / back-and-forth / cancel cycles allocate nothing (child process with --expose-gc)', () => {
    // Fractional coordinates and times like a real browser. They are boxed once up front (a generic-elements array),
    // so the probe itself boxes nothing when it passes them in; each window starts after a full GC and the young
    // generation is large enough that no scavenge runs inside a window.
    const script = `
      import { createPitchGestures } from './src/input/touch/gestures.ts';
      import { createTouchIntentState } from './src/contracts/touch.ts';
      const st = createTouchIntentState();
      const g = createPitchGestures({ state: st, zone: () => true, timers: false,
        ballScreen: (o) => { o.x = 800.5; o.y = 400.25; return true; } });
      const B = ['generic']; for (let k = 1; k <= 4096; k++) B.push(k * 1.37 + 0.123);
      const v = (k) => B[1 + (k % 4096)];
      const TT = ['generic']; for (let k = 1; k <= 100000; k++) TT.push(k * 10.37);
      let ti = 1;
      const t = () => TT[ti++];
      const cycle = () => {
        if (ti > 99000) ti = 1;
        g.hit(v(600), v(300));
        g.down(1, v(600), v(300), t()); g.up(1, v(601), v(300), t()); g.down(2, v(602), v(301), t()); g.up(2, v(602), v(301), t());
        ti += 40;
        g.down(3, v(500), v(300), t());
        for (let k = 1; k <= 12; k++) g.move(3, v(500 + k * 12), v(300 - k * k), t());
        g.up(3, v(660), v(160), t()); ti += 40;
        g.down(4, v(600), v(300), t());
        for (let k = 1; k <= 4; k++) g.move(4, v(600 - k * 8), v(300), t());
        for (let k = 1; k <= 8; k++) g.move(4, v(568 + k * 14), v(300), t());
        g.up(4, v(680), v(300), t()); ti += 40;
        g.down(5, v(500), v(300), t()); g.move(5, v(530), v(300), t()); g.cancel(5, t());
        g.down(1, v(700), v(200), t()); g.up(1, v(700), v(200), t()); ti += 40; g.update(t());
        st.gestureEventCount = 0;
        return 46;
      };
      const run = (n) => { let ev = 0; for (let i = 0; i < n; i++) ev += cycle(); return ev; };
      run(8000);
      const w = [];
      for (let k = 0; k < 4; k++) {
        globalThis.gc();
        const h0 = process.memoryUsage().heapUsed;
        const ev = run(5000);
        w.push((process.memoryUsage().heapUsed - h0) / ev);
      }
      w.sort((a, b) => a - b);
      console.log(JSON.stringify({ bytesPerEvent: w[2], windows: w }));
    `;
    const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--expose-gc', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { bytesPerEvent, windows } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytesPerEvent: number; windows: number[] };
    expect(bytesPerEvent, JSON.stringify(windows)).toBeLessThan(0.5);
  });
});

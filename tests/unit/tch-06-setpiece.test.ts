/**
 * TCH-06: set-piece touch controls and flight preview (src/input/touch/setpiece.ts), unit level with synthetic pointer
 * sequences (no DOM): which restarts take a swipe from the ball, claiming (near the ball, SET_PIECE only, one swipe at a
 * time), the path classifier (taps, quick and slow swipes, curl, rest before the lift), the swipe -> InputFrame
 * conversion (same as the mapper's; power and curl monotonic), the dotted preview (ball dot at touch-down, the
 * predicted flight's point count, throttled to every 2nd frame, finger trail without a flight, cleared at the lift /
 * cancel / releaseAll / lost context) and the emitted gestures (fromBall swipes, taps at the ball).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GestureKind, MatchPhase } from '../../src/contracts/enums';
import {
  AXIS_SCALE, createInputFrame, GestureFlag, UNIT_SCALE, type CameraProjector, type InputFrame,
} from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import type { BallPrediction } from '../../src/contracts/systems';
import { ClusterMode, createTouchIntentState, type TouchIntentState } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { createPathClass, LOCAL_TUNING as GT, classifyPath } from '../../src/input/touch/gestures';
import { createTouchMapper, LOCAL_TUNING as MT } from '../../src/input/touch/mapper';
import {
  classifySetPiecePath, createSetPieceSwipe, LOCAL_TUNING, PreviewKind, setPieceSwipeFrame, setPieceSwipePhase,
  type PreviewFlightFn, type SetPieceSwipeControl, type SetPieceSwipeOptions,
} from '../../src/input/touch/setpiece';
import { makeScenario } from '../harness/scenario';

afterEach(() => { vi.useRealTimers(); });

// ------------------------------------------------------------------ fixtures

/** Top-down camera: 10 px per metre, centre spot at (600, 400). */
const K = 10, CX = 600, CY = 400;
const PROJ: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - CX) / K; out.z = (sy - CY) / K; return true; },
  pitchToScreen(x, y, z, out) { out.x = CX + x * K; out.y = CY + z * K - y * K; return true; },
  stickRotation: () => 0,
};
/** Ball of the free kick on screen. */
const BALL = { x: 900, y: 340 };

function restartState(phase: MatchPhase, taken = 0): SimState {
  return makeScenario({
    phase, humans: [{ side: 0, slot: 9 }], ball: { x: 30, y: 0.11, z: -6 },
    match: { restart: { team: 0, taken } as SimState['match']['restart'] },
  });
}

/** Fake RUL-05 previewFlight: a straight flight along the frame's gdx / gdz at 0.4 m per tick, rising 0.05 m per tick. */
function fakePreview(log: InputFrame[], count = 60): PreviewFlightFn {
  return (s: SimState, out: BallPrediction, f: Readonly<InputFrame>) => {
    log.push({ ...f });
    out.count = count;
    for (let i = 0; i < count; i++) {
      out.x[i] = s.ball.x + (i + 1) * 0.4 * (f.gdx / AXIS_SCALE);
      out.y[i] = 0.11 + (i + 1) * 0.05;
      out.z[i] = s.ball.z + (i + 1) * 0.4 * (f.gdz / AXIS_SCALE);
    }
    return count > 0 ? 1 : 0;
  };
}

interface Rig { st: TouchIntentState; c: SetPieceSwipeControl; s: SimState; log: InputFrame[] }

function rig(o: Partial<SetPieceSwipeOptions> & { s?: SimState | null; mode?: ClusterMode } = {}): Rig {
  const st = createTouchIntentState();
  st.mode = o.mode ?? ClusterMode.SET_PIECE;
  const s = o.s === undefined ? restartState(MatchPhase.FREE_KICK) : o.s;
  const log: InputFrame[] = [];
  const c = createSetPieceSwipe({
    state: st, timers: false,
    ballScreen: (out) => { out.x = BALL.x; out.y = BALL.y; return true; },
    getState: () => s, getProjector: () => PROJ, previewFlight: fakePreview(log),
    ...o,
  });
  return { st, c, s: s as SimState, log };
}

/** Drag from (x0, y0) by (dx, dy) in `steps` moves `dt` ms apart, optionally bowed sideways by `bow` px. */
function drag(c: SetPieceSwipeControl, id: number, t0: number, x0: number, y0: number, dx: number, dy: number, steps: number, dt: number, bow = 0): number {
  let t = t0;
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  for (let k = 1; k <= steps; k++) {
    t += dt;
    const f = k / steps;
    const b = Math.sin(f * Math.PI) * bow;
    c.move(id, x0 + dx * f + nx * b, y0 + dy * f + ny * b, t);
  }
  return t;
}

function paths(pts: readonly [number, number, number][]): [Float64Array, Float64Array, Float64Array, number] {
  return [Float64Array.from(pts.map((p) => p[0])), Float64Array.from(pts.map((p) => p[1])), Float64Array.from(pts.map((p) => p[2])), pts.length];
}

/** Straight path from (0,0) to (len, 0) over durMs with `n` samples, then optional rest samples at the end. */
function line(len: number, durMs: number, n = 12, rest = 0, restMs = 0): [number, number, number][] {
  const r: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) r.push([(len * i) / n, 0, (durMs * i) / n]);
  for (let i = 1; i <= rest; i++) r.push([len + (i % 2), 0, durMs + (restMs * i) / rest]);
  return r;
}

// ------------------------------------------------------------------ restarts and claiming

describe('TCH-06 which restarts take a swipe from the ball', () => {
  it('corners, free kicks, penalties and shoot-out kicks not yet taken; kick-off, throw-in, goal kick and open play never', () => {
    const yes = [MatchPhase.CORNER, MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.SHOOT_OUT];
    const no = [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.IN_PLAY, MatchPhase.CELEBRATION];
    for (const p of yes) {
      expect(setPieceSwipePhase(restartState(p)), MatchPhase[p]).toBe(true);
      expect(setPieceSwipePhase(restartState(p, 1)), `${MatchPhase[p]} taken`).toBe(false);
    }
    for (const p of no) expect(setPieceSwipePhase(restartState(p)), MatchPhase[p]).toBe(false);
    expect(setPieceSwipePhase(null)).toBe(false);
  });
});

describe('TCH-06 swipe-from-ball detection (claiming a touch)', () => {
  it('claims a touch-down within ballPt of the ball in SET_PIECE at a free kick; never farther away', () => {
    const { c } = rig();
    const r = LOCAL_TUNING.ballPt;
    expect(c.hit(BALL.x, BALL.y)).toBe(true);
    expect(c.hit(BALL.x + r * 0.7, BALL.y - r * 0.7)).toBe(true);
    expect(c.hit(BALL.x + r + 1, BALL.y)).toBe(false);
    expect(c.hit(BALL.x, BALL.y + r + 1)).toBe(false);
    expect(c.hit(Number.NaN, BALL.y)).toBe(false);
  });

  it('claims nothing outside SET_PIECE, at restarts played with buttons and taps, once taken, without state or when disabled', () => {
    for (const mode of [ClusterMode.ATTACK, ClusterMode.DEFENCE, ClusterMode.KEEPER, ClusterMode.HIDDEN]) {
      expect(rig({ mode }).c.hit(BALL.x, BALL.y), ClusterMode[mode]).toBe(false);
    }
    for (const p of [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK]) {
      expect(rig({ s: restartState(p) }).c.hit(BALL.x, BALL.y), MatchPhase[p]).toBe(false);
    }
    expect(rig({ s: restartState(MatchPhase.FREE_KICK, 1) }).c.hit(BALL.x, BALL.y)).toBe(false);
    expect(rig({ s: null }).c.hit(BALL.x, BALL.y)).toBe(false);
    expect(rig({ enabled: () => false }).c.hit(BALL.x, BALL.y)).toBe(false);
    expect(rig({ ballScreen: () => false }).c.hit(BALL.x, BALL.y)).toBe(false);
    // Corners and penalties claim.
    expect(rig({ s: restartState(MatchPhase.CORNER) }).c.hit(BALL.x, BALL.y)).toBe(true);
    expect(rig({ s: restartState(MatchPhase.PENALTY) }).c.hit(BALL.x, BALL.y)).toBe(true);
  });

  it('one set-piece swipe at a time: a second finger at the ball falls through and its events are ignored', () => {
    const { c, st } = rig();
    c.down(1, BALL.x, BALL.y, 1000);
    expect(c.active).toBe(true);
    expect(c.hit(BALL.x + 2, BALL.y)).toBe(false);
    c.down(2, BALL.x + 2, BALL.y, 1005);
    c.move(2, BALL.x + 300, BALL.y, 1050);
    c.up(2, BALL.x + 300, BALL.y, 1060);
    expect(st.gestureEventCount).toBe(0);
    expect(c.active).toBe(true);
    c.up(1, BALL.x, BALL.y, 1080);
    expect(c.active).toBe(false);
    expect(st.gestureEvents[0]!.kind).toBe(GestureKind.TAP);
  });
});

// ------------------------------------------------------------------ classification

describe('TCH-06 set-piece path classifier', () => {
  const cls = createPathClass();
  it('tap: within tapMaxPt, lifted within tapMaxMs; a long still press is nothing', () => {
    expect(classifySetPiecePath(...paths([[0, 0, 0], [3, 2, 60], [4, 2, 120]]), cls)).toBe(GestureKind.TAP);
    expect(classifySetPiecePath(...paths([[0, 0, 0], [3, 2, 60], [4, 2, T_TOUCHUI.tapMaxMs + 50]]), cls)).toBe(GestureKind.NONE);
    // Thinned samples: travel seen while tracking counts.
    expect(classifySetPiecePath(...paths([[0, 0, 0], [2, 0, 80]]), cls, 40 * 40)).toBe(GestureKind.NONE);
  });

  it('a quick swipe is exactly the pitch gestures\' swipe (TCH-05 classifyPath)', () => {
    const p = paths(line(200, 150));
    const ref = createPathClass();
    expect(classifySetPiecePath(...p, cls)).toBe(GestureKind.SWIPE);
    expect(classifyPath(p[0], p[1], p[2], p[3], ref)).toBe(GestureKind.SWIPE);
    expect([cls.ex, cls.ey, cls.vx, cls.vy, cls.curve]).toEqual([ref.ex, ref.ey, ref.vx, ref.vy, ref.curve]);
  });

  it('a slow swipe still counts at a set piece (speed sets power); dragged back onto the ball or too short = nothing', () => {
    const p = paths(line(200, GT.swipeMaxMs + 500));
    expect(classifySetPiecePath(...p, cls)).toBe(GestureKind.SWIPE);
    expect(cls.ex).toBe(200);
    expect(cls.vx).toBeGreaterThan(0);
    const back = paths([[0, 0, 0], [60, 0, 300], [120, 0, 600], [60, 0, 900], [5, 0, 1200]]);
    expect(classifySetPiecePath(...back, cls)).toBe(GestureKind.NONE);
    expect(classifySetPiecePath(...paths(line(GT.swipeMinPt - 6, 900)), cls)).toBe(GestureKind.NONE);
  });

  it('curved swipes: CURVED_SWIPE, curve sign follows the bend (clockwise on screen > 0), magnitude grows with the bow', () => {
    const arc = (bow: number, dur: number): [number, number, number][] => {
      const r: [number, number, number][] = [];
      for (let i = 0; i <= 16; i++) { const f = i / 16; r.push([200 * f, -bow * Math.sin(Math.PI * f), dur * f]); }
      return r;
    };
    const curves: number[] = [];
    for (const bow of [10, 25, 45, 70]) {
      for (const dur of [180, 1200]) {
        const k = classifySetPiecePath(...paths(arc(bow, dur)), cls);
        if (bow >= 45) expect(k, `bow ${bow} dur ${dur}`).toBe(GestureKind.CURVED_SWIPE);
        if (dur === 1200) curves.push(cls.curve);
      }
    }
    for (let i = 1; i < curves.length; i++) expect(curves[i]!).toBeGreaterThanOrEqual(curves[i - 1]!);
    expect(curves[curves.length - 1]!).toBeGreaterThan(0); // bowed up the screen going right = clockwise
    classifySetPiecePath(...paths(arc(-45, 1200)), cls);
    expect(cls.curve).toBeLessThan(0);
  });

  it('a finger resting before it lifts does not change the swipe', () => {
    const a = createPathClass(), b = createPathClass();
    classifySetPiecePath(...paths(line(200, 900)), a);
    classifySetPiecePath(...paths(line(200, 900, 12, 6, 400)), b);
    expect(b.kind).toBe(a.kind);
    expect([b.ex, b.vx, b.vy, b.curve]).toEqual([a.ex, a.vx, a.vy, a.curve]);
  });
});

// ------------------------------------------------------------------ conversion

describe('TCH-06 swipe -> InputFrame gesture fields (power / curve mapping)', () => {
  const swipe = (vx: number, curve = 0, kind: GestureKind = GestureKind.SWIPE) => {
    const c = createPathClass();
    c.kind = kind; c.sx = BALL.x; c.sy = BALL.y; c.ex = BALL.x + 200; c.ey = BALL.y - 20; c.vx = vx; c.vy = -vx / 10; c.curve = curve;
    return c;
  };

  it('gPower grows monotonically with swipe speed (floor gestureMinPower, full at gestureFullSpeed); direction and FROM_BALL', () => {
    const f = createInputFrame();
    let prev = 0;
    const seen: number[] = [];
    for (let v = 0; v <= 4; v += 0.1) {
      expect(setPieceSwipeFrame(swipe(v), PROJ, f)).toBe(true);
      expect(f.gPower).toBeGreaterThanOrEqual(prev);
      prev = f.gPower;
      seen.push(f.gPower);
      expect(f.gFlags).toBe(GestureFlag.FROM_BALL);
      expect(f.gesture).toBe(GestureKind.SWIPE);
      expect(f.gdx).toBeGreaterThan(120);
      expect(f.gdz).toBeLessThan(0);
      expect(f.gx).toBe(Math.round(((BALL.x + 200 - CX) / K) * 10));
    }
    expect(seen[0]).toBe(Math.round(MT.gestureMinPower * UNIT_SCALE));
    expect(seen[seen.length - 1]).toBe(UNIT_SCALE);
    expect(new Set(seen).size).toBeGreaterThan(15); // strictly rising between the floor and full power
  });

  it('gCurve grows monotonically with the curve and keeps its sign; not a swipe = false (frame cleared)', () => {
    const f = createInputFrame();
    let prev = -Infinity;
    for (let c = -1; c <= 1.0001; c += 0.05) {
      setPieceSwipeFrame(swipe(1.5, c, GestureKind.CURVED_SWIPE), PROJ, f);
      expect(f.gCurve).toBeGreaterThanOrEqual(prev);
      if (c > 0.02) expect(f.gCurve).toBeGreaterThan(0);
      if (c < -0.02) expect(f.gCurve).toBeLessThan(0);
      prev = f.gCurve;
    }
    expect(prev).toBe(AXIS_SCALE);
    const tap = swipe(0);
    tap.kind = GestureKind.TAP;
    expect(setPieceSwipeFrame(tap, PROJ, f)).toBe(false);
    expect(f.gesture).toBe(GestureKind.NONE);
  });

  it('equals what the mapper sends for the emitted gesture (the preview shows the kick the lift plays)', () => {
    const r = rig();
    r.c.down(1, BALL.x, BALL.y, 1000);
    const t = drag(r.c, 1, 1000, BALL.x, BALL.y, 220, -40, 10, 12, 18);
    r.c.update(t + 40); // catch up the throttled preview
    const previewFrame = r.log[r.log.length - 1]!;
    r.c.up(1, BALL.x + 220, BALL.y - 40, t + 41);
    expect(r.st.gestureEventCount).toBe(1);
    const m = createTouchMapper(r.st, { now: () => t + 50 });
    const out = createInputFrame();
    m.sample(out, { tick: 1, human: 0, side: 0, state: r.s, projector: PROJ });
    expect(out.gesture).toBe(previewFrame.gesture);
    expect([out.gx, out.gz, out.gdx, out.gdz, out.gPower, out.gCurve]).toEqual(
      [previewFrame.gx, previewFrame.gz, previewFrame.gdx, previewFrame.gdz, previewFrame.gPower, previewFrame.gCurve]);
    expect(out.gFlags & GestureFlag.FROM_BALL).toBe(GestureFlag.FROM_BALL);
  });
});

// ------------------------------------------------------------------ preview and lifecycle

describe('TCH-06 dotted flight preview', () => {
  it('touch-down shows the ball dot at once (pressed state); a swipe shows the flight: ball + one dot every previewStepTicks of previewTicks', () => {
    const { c, st, log } = rig();
    c.down(1, BALL.x + 5, BALL.y + 3, 1000);
    expect(st.previewCount).toBe(1);
    expect([st.previewX[0], st.previewY[0]]).toEqual([BALL.x, BALL.y]);
    expect(c.previewKind).toBe(PreviewKind.TRAIL);
    drag(c, 1, 1000, BALL.x + 5, BALL.y + 3, 200, 0, 6, 10);
    expect(c.previewKind).toBe(PreviewKind.FLIGHT);
    const dots = Math.floor(LOCAL_TUNING.previewTicks / LOCAL_TUNING.previewStepTicks);
    expect(st.previewCount).toBe(1 + dots);
    expect(st.previewCount).toBeLessThanOrEqual(st.previewX.length);
    // Dot d is the flight after d * step ticks, projected (x grows along the swipe, rises up the screen).
    const s = restartState(MatchPhase.FREE_KICK);
    const step = LOCAL_TUNING.previewStepTicks;
    const f = log[log.length - 1]!;
    for (let d = 1; d < st.previewCount; d++) {
      const i = d * step - 1;
      const x = s.ball.x + (i + 1) * 0.4 * (f.gdx / AXIS_SCALE), y = 0.11 + (i + 1) * 0.05, z = s.ball.z + (i + 1) * 0.4 * (f.gdz / AXIS_SCALE);
      expect(st.previewX[d]).toBeCloseTo(CX + x * K, 9);
      expect(st.previewY[d]).toBeCloseTo(CY + z * K - y * K, 9);
    }
    // The preview frame is a FROM_BALL swipe toward +x.
    expect(f.gFlags & GestureFlag.FROM_BALL).toBe(GestureFlag.FROM_BALL);
    expect(f.gdx).toBeGreaterThan(120);
  });

  it('preview point count: fewer flight samples or a projection that fails stop the dots there; no flight = finger trail', () => {
    let r = rig({ previewFlight: fakePreview([], 13) });
    r.c.down(1, BALL.x, BALL.y, 1000);
    drag(r.c, 1, 1000, BALL.x, BALL.y, 200, 0, 6, 10);
    expect(r.st.previewCount).toBe(1 + Math.floor(13 / LOCAL_TUNING.previewStepTicks));
    // A projector that cannot draw points higher than 1 m: the dots stop there.
    const low: CameraProjector = { ...PROJ, pitchToScreen: (x, y, z, o) => (y > 1 ? false : PROJ.pitchToScreen(x, y, z, o)) };
    r = rig({ getProjector: () => low });
    r.c.down(1, BALL.x, BALL.y, 1000);
    drag(r.c, 1, 1000, BALL.x, BALL.y, 200, 0, 6, 10);
    const below = Math.floor((1 - 0.11) / 0.05); // flight samples with y <= 1 m
    expect(r.st.previewCount).toBe(1 + Math.floor(below / LOCAL_TUNING.previewStepTicks));
    // previewFlight has nothing (a corner): trail dots every trailSpacingPt from the touch-down along the finger.
    r = rig({ s: restartState(MatchPhase.CORNER), previewFlight: () => 0 });
    r.c.down(1, BALL.x, BALL.y, 1000);
    const t = drag(r.c, 1, 1000, BALL.x, BALL.y, 160, 0, 8, 10);
    r.c.update(t + LOCAL_TUNING.previewEveryMs); // the throttle catches up with the last move
    expect(r.c.previewKind).toBe(PreviewKind.TRAIL);
    const sp = LOCAL_TUNING.trailSpacingPt;
    expect(r.st.previewCount).toBe(1 + 1 + Math.floor(160 / sp));
    for (let d = 2; d < r.st.previewCount; d++) expect(r.st.previewX[d]! - r.st.previewX[d - 1]!).toBeCloseTo(sp, 9);
    // No projector: trail as well.
    r = rig({ getProjector: () => null });
    r.c.down(1, BALL.x, BALL.y, 1000);
    drag(r.c, 1, 1000, BALL.x, BALL.y, 160, 0, 8, 10);
    expect(r.c.previewKind).toBe(PreviewKind.TRAIL);
    expect(r.log.length).toBe(0);
  });

  it('throttled to every 2nd frame: many moves or per-frame update() calls recompute at most once per previewEveryMs, and the last move is never left out', () => {
    const { c, log } = rig();
    c.down(1, BALL.x, BALL.y, 1000);
    // 60 moves 4 ms apart (240 ms): at most one flight per 30 ms.
    const t = drag(c, 1, 1000, BALL.x, BALL.y, 300, -30, 60, 4);
    expect(c.previewComputations).toBeLessThanOrEqual(Math.ceil(240 / LOCAL_TUNING.previewEveryMs) + 1);
    expect(c.previewComputations).toBeGreaterThanOrEqual(Math.floor(240 / LOCAL_TUNING.previewEveryMs) - 1);
    // Frames at 60 Hz with the finger resting: one refresh every 2nd frame.
    const before = c.previewComputations;
    for (let k = 1; k <= 12; k++) c.update(t + k * (1000 / 60));
    expect(c.previewComputations - before).toBe(6);
    // The last refresh saw the last move (the end point of the drag).
    const f = log[log.length - 1]!;
    expect(f.gx).toBe(Math.round(((BALL.x + 300 - CX) / K) * 10));
  });

  it('a timer refreshes the preview when no update() or move follows (camera motion, the throttled last move)', () => {
    vi.useFakeTimers();
    const { c, log } = createWithTimers();
    c.down(1, BALL.x, BALL.y, 0);
    c.move(1, BALL.x + 100, BALL.y, 10); // refreshed at once (first move)
    const n0 = log.length;
    c.move(1, BALL.x + 200, BALL.y, 20); // throttled
    expect(log.length).toBe(n0);
    vi.advanceTimersByTime(LOCAL_TUNING.previewEveryMs + 5);
    expect(log.length).toBe(n0 + 1);
    expect(log[log.length - 1]!.gx).toBe(Math.round(((BALL.x + 200 - CX) / K) * 10));
    c.up(1, BALL.x + 200, BALL.y, 60);
    vi.advanceTimersByTime(500);
    expect(log.length).toBe(n0 + 1); // no timer after the lift
  });
});

function createWithTimers(): { c: SetPieceSwipeControl; log: InputFrame[] } {
  const st = createTouchIntentState();
  st.mode = ClusterMode.SET_PIECE;
  const s = restartState(MatchPhase.FREE_KICK);
  const log: InputFrame[] = [];
  const c = createSetPieceSwipe({
    state: st, timers: true, ballScreen: (o) => { o.x = BALL.x; o.y = BALL.y; return true; },
    getState: () => s, getProjector: () => PROJ, previewFlight: fakePreview(log),
  });
  return { c, log };
}

describe('TCH-06 gestures and lifecycle', () => {
  it('the lift emits the swipe from the ball (fromBall, end velocity, curve) and clears the preview', () => {
    const { c, st } = rig();
    c.down(1, BALL.x, BALL.y, 1000);
    const t = drag(c, 1, 1000, BALL.x, BALL.y, 240, -20, 10, 15, 30);
    c.up(1, BALL.x + 240, BALL.y - 20, t + 5);
    expect(st.previewCount).toBe(0);
    expect(c.previewKind).toBe(PreviewKind.NONE);
    expect(st.gestureEventCount).toBe(1);
    const g = st.gestureEvents[0]!;
    expect([GestureKind.SWIPE, GestureKind.CURVED_SWIPE]).toContain(g.kind);
    expect(g.fromBall).toBe(true);
    expect([g.sx, g.sy]).toEqual([BALL.x, BALL.y]);
    expect(g.ex).toBeCloseTo(BALL.x + 240, 6);
    expect(g.vx).toBeGreaterThan(0.5);
    expect(g.curve).not.toBe(0);
  });

  it('taps at the ball pass through as TAP gestures from the ball (a teammate at the ball: short corner)', () => {
    const { c, st } = rig({ s: restartState(MatchPhase.CORNER) });
    c.down(1, BALL.x + 4, BALL.y, 1000);
    c.move(1, BALL.x + 7, BALL.y + 2, 1040);
    c.up(1, BALL.x + 7, BALL.y + 2, 1090);
    expect(st.gestureEventCount).toBe(1);
    expect(st.gestureEvents[0]!.kind).toBe(GestureKind.TAP);
    expect(st.gestureEvents[0]!.fromBall).toBe(true);
    expect(st.previewCount).toBe(0);
  });

  it('penalty: a swipe from the ball toward a corner of the goal is emitted (no flight from RUL-05: trail preview)', () => {
    const { c, st } = rig({ s: restartState(MatchPhase.PENALTY), previewFlight: () => 0 });
    c.down(1, BALL.x, BALL.y, 1000);
    const t = drag(c, 1, 1000, BALL.x, BALL.y, 150, -60, 8, 12);
    expect(c.previewKind).toBe(PreviewKind.TRAIL);
    c.up(1, BALL.x + 150, BALL.y - 60, t + 4);
    expect(st.gestureEvents[0]!.kind).toBe(GestureKind.SWIPE);
    expect(st.gestureEvents[0]!.fromBall).toBe(true);
  });

  it('glitch: stuck preview after pointercancel / releaseAll - both drop the swipe and the preview, no gesture', () => {
    for (const end of ['cancel', 'releaseAll'] as const) {
      const { c, st } = rig();
      c.down(1, BALL.x, BALL.y, 1000);
      const t = drag(c, 1, 1000, BALL.x, BALL.y, 200, 0, 6, 10);
      expect(st.previewCount).toBeGreaterThan(1);
      if (end === 'cancel') c.cancel(1, t + 5); else c.releaseAll(t + 5);
      expect(st.previewCount, end).toBe(0);
      expect(c.active, end).toBe(false);
      c.up(1, BALL.x + 200, BALL.y, t + 10); // a late lift does nothing
      c.update(t + 100);
      expect(st.gestureEventCount, end).toBe(0);
      expect(st.previewCount, end).toBe(0);
    }
  });

  it('context lost during the drag (mode swaps, restart taken): the preview goes at once and the lift plays nothing', () => {
    for (const lose of ['mode', 'taken'] as const) {
      const r = rig();
      r.c.down(1, BALL.x, BALL.y, 1000);
      const t = drag(r.c, 1, 1000, BALL.x, BALL.y, 200, 0, 6, 10);
      expect(r.st.previewCount).toBeGreaterThan(1);
      if (lose === 'mode') r.st.mode = ClusterMode.DEFENCE; else r.s.match.restart.taken = 1;
      r.c.update(t + 40);
      expect(r.st.previewCount, lose).toBe(0);
      expect(r.c.active, lose).toBe(false);
      r.c.up(1, BALL.x + 220, BALL.y, t + 50);
      expect(r.st.gestureEventCount, lose).toBe(0);
    }
  });

  it('non-finite pointer coordinates are ignored; a lift without coordinates ends at the last point', () => {
    const { c, st } = rig();
    c.down(1, Number.NaN, BALL.y, 1000);
    expect(c.active).toBe(false);
    c.down(1, BALL.x, BALL.y, 1000);
    const t = drag(c, 1, 1000, BALL.x, BALL.y, 200, 0, 6, 10);
    c.move(1, Number.POSITIVE_INFINITY, 0, t + 2);
    c.up(1, Number.NaN, Number.NaN, t + 4);
    expect(st.gestureEventCount).toBe(1);
    expect(st.gestureEvents[0]!.ex).toBeCloseTo(BALL.x + 200, 6);
    for (let i = 0; i < st.previewX.length; i++) expect(Number.isFinite(st.previewX[i]!)).toBe(true);
  });
});

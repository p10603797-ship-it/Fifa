/**
 * [FIN-P skeptic] The benchmark window is 90 s of match, also on a device that cannot run the sim in real time.
 *
 * BRIEF section 13 "Proving it": the benchmark is "a fixed-seed, 90-second bot-v-bot match through the worst cases" and
 * the proxy gate runs it under 4x CPU throttling. There the loop runs at most MAX_TICKS_PER_FRAME (3) ticks per ~270 ms
 * frame, so a window of 90 s of wall clock held ~1000 ticks (measured: 337 frames, 1011 ticks; ticks ~300-1300, 17 s of
 * match) and none of the corner (46 s), goal and net ripple (51 s) and replay (56 s) that
 * tests/perf/fin-p-bench-coverage.test.ts places in the 60 Hz window: the gate judged the quiet opening only. The window
 * now ends when both 90 s of play and 90 x 60 ticks have passed (benchHook benchWindowEnd); a device that keeps up
 * (the iPad run) ends at the same moment as before.
 *
 * startBench is driven here with a fake frame pump (requestAnimationFrame), a fake loop-stats object and a fake session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/contracts/app';
import { MAX_TICKS_PER_FRAME, TICK_HZ } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import { BENCH_DEFAULTS, benchWindowEnd, startBench, type BenchResult } from '../../src/platform/benchHook';

const g = globalThis as unknown as Record<string, unknown>;
const saved = { raf: g.requestAnimationFrame, window: g.window };

afterEach(() => {
  if (saved.raf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = saved.raf;
  if (saved.window === undefined) delete g.window; else g.window = saved.window;
});

/**
 * Play a bench run on a fake device whose frames take `frameMs` and run `ticksPerFrame` sim ticks of `simMs` each
 * (the loop's per-frame stats), until the bench finishes or `maxFrames` frames. Returns the result and the last tick.
 */
function play(frameMs: number, ticksPerFrame: number, simMs: number, maxFrames = 200_000, loopStats = true): { r: BenchResult | null; tick: number } {
  const state = { tick: 0, match: { phase: MatchPhase.IN_PLAY } };
  const stats = {
    simMsAvg: 0, simMsMax: 0, renderMsAvg: 0, renderMsMax: 0, sampleTicks: 0, sampleFrames: 0,
    reset(): void { this.simMsAvg = 0; this.simMsMax = 0; this.renderMsAvg = 0; this.renderMsMax = 0; this.sampleTicks = 0; this.sampleFrames = 0; },
  };
  const win: Record<string, unknown> = {
    ...(loopStats ? { __dotkickFrameStats: stats } : {}),
    __dotkickRendererStats: () => ({ drawCalls: 20, triangles: 46_756, resolutionScale: 1, qualityTier: 1 }),
    innerWidth: 1180, innerHeight: 820, devicePixelRatio: 2,
  };
  g.window = win;
  let pending: ((now: number) => void) | null = null;
  g.requestAnimationFrame = (cb: (now: number) => void): number => { pending = cb; return 1; };
  let started = false;
  const ctx = {
    session: {
      start: () => { started = true; },
      getState: () => (started ? state : null),
      get active() { return true; },
      paused: false,
    },
    diagnostics: { log: () => undefined },
  } as unknown as AppContext;
  let result: BenchResult | null = null;
  startBench(ctx, { panel: false, onDone: (r) => { result = r; } });
  let now = 1000;
  for (let f = 0; f < maxFrames && result === null && pending !== null; f++) {
    // The app loop's frame: ticks first (stats accumulate), then the bench hook's rAF callback reads them.
    for (let k = 0; k < ticksPerFrame; k++) {
      state.tick++;
      stats.sampleTicks++;
      stats.simMsAvg = simMs;
      if (simMs > stats.simMsMax) stats.simMsMax = simMs;
    }
    stats.sampleFrames++;
    stats.renderMsAvg = 5;
    stats.renderMsMax = 5;
    now += frameMs;
    const cb: (now: number) => void = pending;
    pending = null;
    cb(now);
  }
  return { r: result, tick: state.tick };
}

describe('fin-p: benchmark window (BRIEF section 13: a 90-second match through the worst cases)', () => {
  it('fin-p: the throttled proxy gate measures 90 s of match (5400 ticks), not 90 s of wall clock (was ~1000 ticks: no corner, goal or replay)', () => {
    // 4x CPU throttling in headless Chromium: ~270 ms frames, the loop's cap of 3 ticks each (measured 337 frames,
    // 1011 ticks in the old 90 s window).
    const { r } = play(270, MAX_TICKS_PER_FRAME, 1);
    expect(r).not.toBeNull();
    expect(r!.error).toBeUndefined();
    expect(r!.ticks!).toBeGreaterThanOrEqual(BENCH_DEFAULTS.seconds * TICK_HZ);
    expect(r!.ticks!).toBeLessThan(BENCH_DEFAULTS.seconds * TICK_HZ + MAX_TICKS_PER_FRAME + 1);
    expect(r!.seconds).toBeGreaterThan(400);
    expect(r!.proxyPass).toBe(true);
  });

  it('fin-p: a device that keeps up (60 Hz, one tick a frame) still measures exactly 90 s of play', () => {
    const { r } = play(1000 / 60, 1, 1);
    expect(r).not.toBeNull();
    expect(r!.error).toBeUndefined();
    expect(r!.seconds).toBeGreaterThanOrEqual(BENCH_DEFAULTS.seconds - 0.05);
    expect(r!.seconds).toBeLessThan(BENCH_DEFAULTS.seconds + 0.05);
    expect(r!.ticks).toBe(BENCH_DEFAULTS.seconds * TICK_HZ);
    expect(r!.pass).toBe(true);
  });

  it('fin-p: a device too slow to cover the match window ends the run with an error (it fails, never passes on a partial window)', () => {
    // One tick a second: after maxWindowStretch x 90 s only ~1000 ticks.
    const { r } = play(1000, 1, 1);
    expect(r).not.toBeNull();
    expect(r!.error).toMatch(/too slow/);
    expect(r!.proxyPass).toBe(false);
    expect(r!.seconds).toBeGreaterThanOrEqual(BENCH_DEFAULTS.seconds * BENCH_DEFAULTS.maxWindowStretch - 1);
  });

  it('fin-p: without the loop\'s stats (no tick count, no sim timing) the window is wall clock only, as before', () => {
    // QF-5's paused / hidden-page bench test drives startBench without window.__dotkickFrameStats.
    const { r } = play(270, MAX_TICKS_PER_FRAME, 1, 200_000, false);
    expect(r).not.toBeNull();
    expect(r!.error).toBeUndefined();
    expect(r!.seconds).toBeGreaterThanOrEqual(BENCH_DEFAULTS.seconds);
    expect(r!.seconds).toBeLessThan(BENCH_DEFAULTS.seconds + 0.3);
    expect(r!.simMsAvg).toBeNull();
  });

  it('fin-p: benchWindowEnd needs both the play time and the ticks', () => {
    const n = BENCH_DEFAULTS.seconds * TICK_HZ;
    expect(benchWindowEnd(90_000, 1011, 90)).toBe('open');
    expect(benchWindowEnd(89_999, n, 90)).toBe('open');
    expect(benchWindowEnd(90_000, n, 90)).toBe('done');
    expect(benchWindowEnd(90_000 * BENCH_DEFAULTS.maxWindowStretch, n - 1, 90)).toBe('cut');
  });
});

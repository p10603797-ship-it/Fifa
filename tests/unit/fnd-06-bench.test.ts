/**
 * FND-06: benchmark maths and hook (src/platform/benchHook.ts). The browser part runs in tools/bench.ts; here the
 * pure statistics, the budget checks and the URL hook are tested in Node.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext, MatchSetup } from '../../src/contracts/app';
import { ControllerKind, ModeId } from '../../src/contracts/enums';
import {
  BENCH_BUDGETS, benchSetup, computeBenchResult, formatBenchResult, maybeStartBench, type BenchSamples,
} from '../../src/platform/benchHook';

function samples(frameMs: number[], over: Partial<BenchSamples> = {}): BenchSamples {
  return {
    frameMs, frames: frameMs.length, drawCallsSum: 40 * frameMs.length, drawCallsMax: 45, trianglesSum: 1e5 * frameMs.length,
    trianglesMax: 150_000, renderSamples: frameMs.length, resolutionScale: 0.75, qualityTier: 2, simMsAvg: 1.2, simMsMax: 3.1,
    ticks: frameMs.length, renderMsAvg: 4, renderMsMax: 9, ...over,
  };
}

const ENV = { seed: 1, userAgent: 'test', screen: '1180x820@2' };

describe('FND-06 benchmark statistics', () => {
  it('a steady 60 fps run passes every budget', () => {
    const r = computeBenchResult(samples(new Array<number>(5400).fill(1000 / 60)), ENV);
    expect(r.avgFps).toBeCloseTo(60, 6);
    expect(r.low1Fps).toBeCloseTo(60, 6);
    expect(r.low01Fps).toBeCloseTo(60, 6);
    expect(r.longestFrameMs).toBeCloseTo(16.667, 2);
    expect(r.seconds).toBeCloseTo(90, 6);
    expect(r.pass).toBe(true);
    expect(r.proxyPass).toBe(true);
    expect(r.drawCallsAvg).toBe(40);
  });

  it('1% and 0.1% lows average the slowest frames; one long frame fails the longest-frame budget', () => {
    const t = new Array<number>(1000).fill(16);
    for (let i = 0; i < 10; i++) t[i * 100] = 40; // 1% of frames at 40 ms
    t[500] = 50; // replaces one of them: worst frame
    const r = computeBenchResult(samples(t), ENV);
    expect(r.longestFrameMs).toBe(50);
    expect(r.low01Fps).toBeCloseTo(1000 / 50, 6);
    expect(r.low1Fps).toBeCloseTo(1000 / ((50 + 9 * 40) / 10), 6);
    const longest = r.checks.find((c) => c.name === 'longest frame ms')!;
    expect(longest.pass).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.proxyPass).toBe(true); // fps-type budgets are not part of the proxy gate
  });

  it('the proxy gate fails on sim, draw-call or triangle budgets', () => {
    const ok = new Array<number>(100).fill(16);
    expect(computeBenchResult(samples(ok, { simMsAvg: BENCH_BUDGETS.simMsAvg + 0.1 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples(ok, { simMsMax: 4.5 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples(ok, { drawCallsMax: 81 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples(ok, { trianglesMax: 200_001 }), ENV).proxyPass).toBe(false);
    // Missing renderer stats or frame stats cannot pass.
    expect(computeBenchResult(samples(ok, { renderSamples: 0 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples(ok, { simMsAvg: null, simMsMax: null }), ENV).proxyPass).toBe(false);
  });

  it('no frames and errors fail cleanly', () => {
    const r = computeBenchResult(samples([]), { ...ENV, error: 'match did not load' });
    expect(r.frames).toBe(0);
    expect(r.avgFps).toBe(0);
    expect(r.pass).toBe(false);
    expect(r.proxyPass).toBe(false);
    expect(formatBenchResult(r)).toContain('ERROR match did not load');
  });

  it('the text report lists every budget with PASS / FAIL', () => {
    const r = computeBenchResult(samples(new Array<number>(600).fill(20)), ENV);
    const text = formatBenchResult(r);
    expect(text).toContain('FAIL average fps: 50.00 (>= 58)');
    expect(text).toContain('PASS draw calls (max): 45.00 (<= 80) [proxy gate]');
    expect(text).toContain('resolution scale 0.75, quality tier 2');
    // 8 checks: 3 fps-type, sim avg, sim p99 of the per-frame worst tick, sim worst, draw calls, triangles.
    expect(text.split('\n').filter((l) => /^(PASS|FAIL) /.test(l))).toHaveLength(8);
  });
});

describe('FND-06 bench hook', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { location: g.location, raf: g.requestAnimationFrame };
  afterEach(() => {
    if (saved.location === undefined) delete g.location; else g.location = saved.location;
    if (saved.raf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = saved.raf;
  });

  it('benchSetup is a fixed-seed bot-v-bot BENCH match', () => {
    const s = benchSetup(1234);
    expect(s.config.seed).toBe(1234);
    expect(s.config.mode).toBe(ModeId.BENCH);
    expect(s.config.humans.every((h) => h.kind === ControllerKind.NONE)).toBe(true);
    expect(s.bindings).toEqual([]);
    expect(s.config.replaySeconds).toBeGreaterThan(0);
  });

  it('maybeStartBench does nothing without ?bench=1', () => {
    delete g.location;
    expect(maybeStartBench({} as AppContext)).toBe(false);
    g.location = { search: '?foo=1' };
    expect(maybeStartBench({} as AppContext)).toBe(false);
  });

  it('maybeStartBench starts the bench match for ?bench=1', () => {
    g.location = { search: '?bench=1&benchSeconds=5&benchSeed=99' };
    g.requestAnimationFrame = () => 0;
    const started: MatchSetup[] = [];
    const ctx = { session: { start: (s: MatchSetup) => started.push(s), getState: () => null, active: false } } as unknown as AppContext;
    expect(maybeStartBench(ctx)).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]!.config.seed).toBe(99);
    expect(started[0]!.config.mode).toBe(ModeId.BENCH);
  });
});

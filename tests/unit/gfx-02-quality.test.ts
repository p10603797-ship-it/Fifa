/**
 * [GFX-02] Dynamic resolution and quality tiers: controller behaviour on synthetic frame-time series (bounds, grid,
 * hysteresis, cooldown, no oscillation), tier choice (startup test), tier adaptation (step down below 50 fps, AUTO
 * up/down), Low Power Mode detection, and the module wiring (request, work measurement, hooks, dispose).
 */
import {
  BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Scene, type WebGLRenderer,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameInfo } from '../../src/contracts/app';
import { QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { T_PERF } from '../../src/contracts/tuning';
import {
  QUALITY_TUNING as QT, TIER_PARAMS, autoTierState, createFrameSignal, createLowPowerDetector, createQuality,
  createResController, createTierAdapter, fixedScaleOf, getTierParams, initialScale, lowPowerStep, markMaterialsForRecompile,
  onLowPowerSuspected,
  pickTierFromSamples, pushFrameSample, resControllerStep, resQuiet, resScale, resetQualitySession, resolveTier,
  runStartupTest, sanitizeTier, scaleToSteps, signalHeadroom, signalSlow, tierAdapterStep,
  type FrameSignal, type QualityHooks, type ResController, type StartupProbe,
} from '../../src/render/quality';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const GRID = 1 / QT.resStep;
const onGrid = (s: number): boolean => Math.abs(s * GRID - Math.round(s * GRID)) < 1e-9;

/** Seeded LCG in [0, 1) (tests must be reproducible). */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

interface Trace { scales: number[]; times: number[]; changes: number }

/**
 * Drive a fresh controller (no quiet period) through `ms` of frames. `frame(scale, t)` returns [intervalMs, workMs]
 * for the next frame given the current scale (closed loop).
 */
function drive(c: ResController, ms: number, frame: (scale: number, t: number) => [number, number], sig: FrameSignal = createFrameSignal()): Trace {
  const tr: Trace = { scales: [resScale(c)], times: [0], changes: 0 };
  let t = 0;
  while (t < ms) {
    const [iv, wk] = frame(resScale(c), t);
    const dt = pushFrameSample(sig, iv, wk);
    t += iv;
    if (dt === 0) continue;
    const ch = resControllerStep(c, sig);
    if (ch !== 0) {
      tr.changes++;
      tr.scales.push(resScale(c));
      tr.times.push(c.t);
    }
  }
  return tr;
}

/** Direction reversals in a scale trace (up then down or down then up). */
function reversals(tr: Trace): number {
  let n = 0;
  for (let i = 2; i < tr.scales.length; i++) {
    const a = tr.scales[i - 1]! - tr.scales[i - 2]!;
    const b = tr.scales[i]! - tr.scales[i - 1]!;
    if (a * b < 0) n++;
  }
  return n;
}

const HZ60 = 1000 / 60;

describe('GFX-02 frame signal', () => {
  it('converges to the interval and work; drops the first frame; clamps hitches and hidden-page returns', () => {
    const s = createFrameSignal();
    expect(pushFrameSample(s, 0, 5)).toBe(0); // first frame of the loop: dtMs 0
    expect(pushFrameSample(s, Number.NaN, 5)).toBe(0);
    expect(s.samples).toBe(0);
    for (let i = 0; i < 120; i++) pushFrameSample(s, HZ60, 6);
    expect(s.intervalMs).toBeCloseTo(HZ60, 3);
    expect(s.workMs).toBeCloseTo(6, 3);
    expect(s.jitterMs).toBeLessThan(0.01);
    // One 90 ms hitch, or the 100 ms MAX_FRAME_MS clamp of a hidden-page return, counts as 50 ms and moves the
    // signal by a bounded amount.
    expect(pushFrameSample(s, 90, 40)).toBe(QT.sampleClampMs);
    expect(s.intervalMs).toBeLessThan(HZ60 + (QT.sampleClampMs - HZ60) * 0.2);
    expect(pushFrameSample(s, 100, 5)).toBe(QT.sampleClampMs);
    // Unknown work leaves the work signal alone.
    const w = s.workMs;
    pushFrameSample(s, HZ60, -1);
    expect(s.workMs).toBe(w);
  });

  it('smoothing time constant is in wall time: 60 Hz and 120 Hz follow a step change at the same rate', () => {
    const a = createFrameSignal(), b = createFrameSignal();
    for (let t = 0; t < 3000; t += HZ60) pushFrameSample(a, HZ60, 0);
    for (let t = 0; t < 3000; t += HZ60 / 2) pushFrameSample(b, HZ60 / 2, 0);
    // A 20 % slower frame from now on: after 500 ms both moved the same fraction of the way (1 - exp(-t / tau)).
    for (let t = 0; t < 500; t += HZ60 * 1.2) pushFrameSample(a, HZ60 * 1.2, 0);
    for (let t = 0; t < 500; t += HZ60 * 0.6) pushFrameSample(b, HZ60 * 0.6, 0);
    const fa = (a.intervalMs - HZ60) / (HZ60 * 0.2);
    const fb = (b.intervalMs - HZ60 / 2) / (HZ60 * 0.1);
    expect(Math.abs(fa - fb)).toBeLessThan(0.05);
    expect(Math.abs(fa - (1 - Math.exp(-500 / QT.smoothTauMs)))).toBeLessThan(0.08);
  });

  it('the mean interval is frame weighted: 1 missed frame in 12 reads 1000 / fps, not more', () => {
    const s = createFrameSignal();
    let lo = 1e9, hi = 0;
    for (let k = 0; k < 2400; k++) {
      pushFrameSample(s, k % 12 === 0 ? 2 * HZ60 : HZ60, 5);
      if (k > 600) { lo = Math.min(lo, s.intervalMs); hi = Math.max(hi, s.intervalMs); }
    }
    const mean = (11 * HZ60 + 2 * HZ60) / 12; // 55.4 fps
    expect(lo).toBeLessThan(mean);
    expect(hi).toBeGreaterThan(mean);
    expect((lo + hi) / 2).toBeCloseTo(mean, 0);
  });

  it('slow / headroom classification uses the T_PERF hysteresis band', () => {
    const s = createFrameSignal();
    s.samples = 100;
    s.intervalMs = HZ60; s.workMs = 8;
    expect(signalSlow(s)).toBe(false);
    expect(signalHeadroom(s)).toBe(true);
    s.workMs = 15; // between resUpMs and resDownMs: neither
    expect(signalSlow(s)).toBe(false);
    expect(signalHeadroom(s)).toBe(false);
    s.workMs = T_PERF.resDownMs + 0.1;
    expect(signalSlow(s)).toBe(true);
    s.workMs = 5; s.intervalMs = T_PERF.resDownMs + 0.1;
    expect(signalSlow(s)).toBe(true);
    expect(signalHeadroom(s)).toBe(false);
    s.workMs = -1; s.intervalMs = HZ60; // no work measurement on a 60 Hz display: no headroom visible
    expect(signalHeadroom(s)).toBe(false);
    s.intervalMs = HZ60 / 2; // 120 Hz display
    expect(signalHeadroom(s)).toBe(true);
  });
});

describe('GFX-02 dynamic resolution controller', () => {
  it('starts at 0.75; climbs to exactly 1.0 with headroom and falls to exactly 0.6 when slow, on the 0.05 grid', () => {
    expect(resScale(createResController())).toBe(T_PERF.resScaleInitial);
    const up = drive(createResController(), 60_000, () => [HZ60, 6]);
    expect(up.scales[up.scales.length - 1]).toBe(1);
    expect(up.changes).toBe(5);
    for (let i = 1; i < up.scales.length; i++) expect(up.scales[i]! - up.scales[i - 1]!).toBeCloseTo(0.05, 9);
    const down = drive(createResController(), 60_000, () => [33.3, 6]);
    expect(down.scales[down.scales.length - 1]).toBe(0.6);
    expect(down.changes).toBe(3);
    for (const s of [...up.scales, ...down.scales]) {
      expect(onGrid(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(T_PERF.resScaleMin);
      expect(s).toBeLessThanOrEqual(T_PERF.resScaleMax);
    }
  });

  it('bounds hold under extreme series (100 s at 5 fps, then 100 s of zero work)', () => {
    const c = createResController();
    const a = drive(c, 100_000, () => [99, 99]);
    const b = drive(c, 100_000, () => [HZ60 / 2, 0]);
    for (const s of [...a.scales, ...b.scales]) {
      expect(s).toBeGreaterThanOrEqual(0.6);
      expect(s).toBeLessThanOrEqual(1);
      expect(onGrid(s)).toBe(true);
    }
    expect(resScale(c)).toBe(1);
  });

  it('hysteresis: inside the band (vsync-locked, work between resUpMs and resDownMs) nothing changes', () => {
    const r = rng(7);
    const tr = drive(createResController(), 120_000, () => [HZ60 + (r() - 0.5) * 0.6, 14.5 + r() * 3.5]);
    expect(tr.changes).toBe(0);
    // A smoothed interval between the target and resDownMs (occasional missed frame) also holds still.
    const tr2 = drive(createResController(), 120_000, (_s, t) => [Math.floor(t / HZ60) % 12 === 0 ? 2 * HZ60 : HZ60, 9]);
    expect(tr2.changes).toBe(0);
  });

  it('cooldown: two changes are at least resCooldownMs apart (a failed probe reverts after resDownHoldMs)', () => {
    const r = rng(11);
    const tr = drive(createResController(), 300_000, (_s, t) => {
      const phase = Math.floor(t / 7000) % 3; // fast, slow, in-band, repeating
      return phase === 0 ? [HZ60, 5 + r()] : phase === 1 ? [30 + r() * 6, 8] : [HZ60, 16];
    });
    expect(tr.changes).toBeGreaterThan(5);
    for (let i = 2; i < tr.times.length; i++) {
      expect(tr.times[i]! - tr.times[i - 1]!).toBeGreaterThanOrEqual(QT.resDownHoldMs - 1e-6);
      const reverting = tr.scales[i]! < tr.scales[i - 1]! && tr.scales[i - 1]! > tr.scales[i - 2]!;
      if (!reverting) expect(tr.times[i]! - tr.times[i - 1]!).toBeGreaterThanOrEqual(QT.resCooldownMs - 1e-6);
    }
  });

  it('single hitches (a 100 ms or 50 ms frame every 2 s) never lower the resolution', () => {
    const c = createResController(1);
    const tr = drive(c, 120_000, (_s, t) => {
      const k = Math.floor(t / HZ60);
      return k % 120 === 0 ? [k % 240 === 0 ? 99 : 50, 30] : [HZ60, 7];
    });
    expect(tr.changes).toBe(0);
    expect(resScale(c)).toBe(1);
  });

  it('no oscillation against a GPU limit: settles on the highest sustainable scale, failed probes back off exponentially', () => {
    // GPU cost grows with pixel count; above 9.5 ms at scale^2 the display halves to 30 fps. CPU work is small.
    const gpuMs = (s: number): number => 12 * s * s; // 0.85 -> 8.67 ms ok, 0.9 -> 9.72 ms too slow
    const c = createResController();
    const tr = drive(c, 600_000, (s) => [gpuMs(s) > 9.5 ? 2 * HZ60 : HZ60, 5]);
    expect(resScale(c)).toBe(0.85);
    // Ten minutes: the climb (2 steps) plus a handful of failed probes, each reverted, ever further apart.
    // Probes 10, 18, 34, 66, 130, 240 s apart (back-off doubling to its 4 min cap): about 7 in ten minutes.
    expect(c.failedProbes).toBeGreaterThanOrEqual(4);
    expect(c.failedProbes).toBeLessThanOrEqual(8);
    expect(tr.changes).toBe(2 + 2 * c.failedProbes);
    const probeTimes: number[] = [];
    for (let i = 1; i < tr.scales.length; i++) if (tr.scales[i]! > 0.85 + 1e-9) probeTimes.push(tr.times[i]!);
    for (let i = 2; i < probeTimes.length; i++) {
      expect(probeTimes[i]! - probeTimes[i - 1]!).toBeGreaterThan(probeTimes[i - 1]! - probeTimes[i - 2]!);
    }
    // Time spent above the limit (dropping frames) stays a small fraction of the run.
    let over = 0;
    for (let i = 1; i < tr.scales.length; i++) {
      if (tr.scales[i]! > 0.85 + 1e-9) over += (tr.times[i + 1] ?? c.t) - tr.times[i]!;
    }
    expect(over / c.t).toBeLessThan(0.02);
  });

  it('no oscillation with noisy frame times around the thresholds (10 minutes, seeded noise)', () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const c = createResController();
      const tr = drive(c, 600_000, (s) => {
        const gpu = 11 * s * s + r() * 3; // sometimes over budget near the top
        const miss = gpu > 10.5 && r() < 0.6;
        return [miss ? 2 * HZ60 : HZ60 + (r() - 0.5), 4 + r() * 4];
      });
      // Marginal levels get probed ever more rarely: a handful of reversals in ten minutes, most of them early.
      expect(reversals(tr), `seed ${seed}`).toBeLessThanOrEqual(16);
      let late = 0;
      for (const t of tr.times) if (t > 300_000) late++;
      expect(late, `seed ${seed}`).toBeLessThanOrEqual(4);
    }
  });

  it('honours a fixed scale from settings: the controller never changes it', () => {
    const c = createResController(0.75, 0.9);
    expect(resScale(c)).toBe(0.9);
    const tr = drive(c, 60_000, () => [40, 30]);
    expect(tr.changes).toBe(0);
    expect(resScale(c)).toBe(0.9);
    expect(fixedScaleOf(0)).toBe(0);
    expect(fixedScaleOf(7)).toBe(1);
    expect(fixedScaleOf(0.3)).toBe(0.6);
    expect(fixedScaleOf(Number.NaN)).toBe(0);
    expect(initialScale(0)).toBe(0.75);
    expect(initialScale(0.83)).toBe(0.83);
  });

  it('quiet period: no decisions while observing (match start), then normal', () => {
    const c = createResController();
    resQuiet(c, QT.startGraceMs);
    const sig = createFrameSignal();
    const tr = drive(c, QT.startGraceMs - 50, () => [40, 10], sig);
    expect(tr.changes).toBe(0);
    const tr2 = drive(c, 3000, () => [40, 10], sig);
    expect(tr2.changes).toBeGreaterThan(0);
  });

  it('without a work measurement: never steps up on a 60 Hz display, does on 120 Hz', () => {
    expect(drive(createResController(), 60_000, () => [HZ60, -1]).changes).toBe(0);
    expect(drive(createResController(), 60_000, () => [HZ60 / 2, -1]).changes).toBe(5);
  });

  it('scaleToSteps keeps the grid exact (15 / 20 === 0.75, no float drift)', () => {
    expect(scaleToSteps(0.75) / GRID).toBe(0.75);
    expect(scaleToSteps(0.6) / GRID).toBe(0.6);
    expect(scaleToSteps(1.3) / GRID).toBe(1);
    expect(scaleToSteps(0.1) / GRID).toBe(0.6);
    expect(scaleToSteps(Number.NaN) / GRID).toBe(0.75);
  });
});

// ------------------------------------------------------------------ startup test / tier choice

function fakeProbe(costMs: (i: number) => number, frameGapMs = HZ60): StartupProbe & { clock: number; renders: number; abortAt: number } {
  const p = {
    clock: 0, renders: 0, abortAt: -1,
    now: () => p.clock,
    nextFrame: async () => { p.clock += frameGapMs; },
    renderOnce: () => { p.clock += costMs(p.renders); p.renders++; },
    aborted: () => p.abortAt >= 0 && p.renders >= p.abortAt,
  };
  return p;
}

describe('GFX-02 tier choice (startup test)', () => {
  it('pickTierFromSamples: thresholds, compile spikes dropped, too few samples inconclusive', () => {
    const pick = (v: number[], timedOut = false): ReturnType<typeof pickTierFromSamples> => pickTierFromSamples(v, v.length, timedOut);
    expect(pick([3, 3, 4, 3, 4, 3]).tier).toBe(QualityTier.QUALITY);
    expect(pick([8, 9, 8, 10, 9, 8]).tier).toBe(QualityTier.BALANCED);
    expect(pick([20, 25, 22, 30, 21, 19]).tier).toBe(QualityTier.PERFORMANCE);
    const few = pick([3, 3, 3, 3]);
    expect(few.conclusive).toBe(false);
    expect(few.tier).toBe(QualityTier.BALANCED);
    // The 2 s cap ended the test because every frame was very slow: that is conclusive (two frames at least).
    const slow = pick([900, 600], true);
    expect(slow.conclusive).toBe(true);
    expect(slow.tier).toBe(QualityTier.PERFORMANCE);
    expect(pick([2700], true).conclusive).toBe(false); // one frame proves nothing
    expect(pick([], true).conclusive).toBe(false);
    // Outliers do not move the median.
    expect(pick([3, 3, 3, 3, 3, 200, 200]).tier).toBe(QualityTier.QUALITY);
  });

  it('runStartupTest: warm-up draws are not measured; one measured frame per animation frame, capped at 2 s or testMaxSamples', async () => {
    const fast = fakeProbe((i) => (i < QT.testWarmupFrames ? 400 : 3)); // shader link on the first draws
    const r1 = await runStartupTest(fast);
    expect(fast.renders).toBe(QT.testWarmupFrames + QT.testMaxSamples);
    expect(r1.samples).toBe(QT.testMaxSamples);
    expect(r1.tier).toBe(QualityTier.QUALITY);
    expect(r1.conclusive).toBe(true);
    expect(r1.warmupMs).toBeGreaterThanOrEqual(800);
    const slow = fakeProbe(() => 150);
    const r2 = await runStartupTest(slow);
    expect(r2.elapsedMs - r2.warmupMs).toBeLessThanOrEqual(QT.testDurationMs + 200);
    expect(r2.samples).toBeLessThan(QT.testMaxSamples);
    expect(r2.tier).toBe(QualityTier.PERFORMANCE);
    expect(r2.conclusive).toBe(true);
    // A very slow first draw (seconds of shader compile) ends the warm-up but is never the verdict.
    const compile = fakeProbe((i) => (i === 0 ? 2700 : 3));
    const r3 = await runStartupTest(compile);
    expect(r3.tier).toBe(QualityTier.QUALITY);
    expect(r3.conclusive).toBe(true);
    expect(compile.renders).toBe(1 + QT.testMaxSamples);
  });

  it('runStartupTest: aborted or failing renders are inconclusive and never throw', async () => {
    const p = fakeProbe(() => 3);
    p.abortAt = 4;
    const r = await runStartupTest(p);
    expect(r.aborted).toBe(true);
    expect(r.conclusive).toBe(false);
    const bad = fakeProbe(() => 3);
    bad.renderOnce = () => { throw new Error('context lost'); };
    const r2 = await runStartupTest(bad);
    expect(r2.conclusive).toBe(false);
    expect(r2.tier).toBe(QualityTier.BALANCED);
  });
});

// ------------------------------------------------------------------ module harness

interface FakeRenderer {
  shadowMap: { enabled: boolean };
  domElement: { width: number; height: number };
  target: unknown;
  renders: number;
  compiles: number;
  reads: number;
  cost: number;
  fail: boolean;
  render(): void;
  getRenderTarget(): unknown;
  setRenderTarget(t: unknown): void;
  readRenderTargetPixels(): void;
  compile(): void;
}

function fakeRenderer(clock: { t: number }): FakeRenderer {
  const r: FakeRenderer = {
    shadowMap: { enabled: false },
    domElement: { width: 885, height: 615 },
    target: null, renders: 0, compiles: 0, reads: 0, cost: 3, fail: false,
    render() { if (r.fail) throw new Error('boom'); r.renders++; clock.t += r.cost; },
    getRenderTarget() { return r.target; },
    setRenderTarget(t) { r.target = t; },
    readRenderTargetPixels() { r.reads++; },
    compile() { r.compiles++; },
  };
  return r;
}

interface Harness {
  ctx: RenderContext;
  q: ReturnType<typeof createQuality>;
  clock: { t: number };
  renderer: FakeRenderer;
  scales: number[];
  tiers: QualityTier[];
  lowPower: number;
  hidden: boolean;
  /** One animation frame: rAF interval, then the frame's work until the end of renderer.render. */
  frame(intervalMs: number, workMs: number, paused?: boolean): void;
  /** Frames for `ms` of wall time. */
  run(ms: number, intervalMs: number | ((t: number) => number), workMs: number): void;
}

const state = initMatch(createMatchConfig());

function harness(settingsMut?: (s: Settings) => void, withRenderer = true): Harness {
  const settings = createDefaultSettings();
  settingsMut?.(settings);
  const clock = { t: 1000 };
  const renderer = fakeRenderer(clock);
  const ctx: RenderContext = {
    renderer: (withRenderer ? renderer : null) as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    settings,
    clubs: [],
    size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 },
    tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera },
    reducedMotion: false,
    night: false,
  };
  const fi: FrameInfo = { nowMs: 0, dtMs: 0, frame: 0, ticks: 1, paused: false };
  const f: RenderFrame = { prev: state, curr: state, alpha: 1, frame: fi, interp: createInterpState() };
  const h: Harness = {
    ctx, clock, renderer, scales: [], tiers: [], lowPower: 0, hidden: false,
    q: null as unknown as ReturnType<typeof createQuality>,
    frame(intervalMs, workMs, paused = false) {
      clock.t += intervalMs;
      fi.nowMs = clock.t;
      fi.dtMs = Math.min(intervalMs, 100);
      fi.frame++;
      fi.paused = paused;
      const start = clock.t;
      h.q.update(f);
      clock.t = start + workMs;
      const sc = ctx.scene as unknown as { onAfterRender: (...a: unknown[]) => void };
      sc.onAfterRender(ctx.renderer, ctx.scene, ctx.camera);
      clock.t = start;
    },
    run(ms, intervalMs, workMs) {
      let t = 0;
      while (t < ms) {
        const iv = typeof intervalMs === 'number' ? intervalMs : intervalMs(t);
        h.frame(iv, workMs);
        t += iv;
      }
    },
  };
  const hooks: QualityHooks = {
    setScale: (s) => { h.scales.push(s); ctx.size.scale = s; },
    setTier: (t) => { h.tiers.push(t); },
    lowPowerSuspected: () => { h.lowPower++; },
  };
  h.q = createQuality(ctx, hooks, { now: () => clock.t, nextFrame: async () => { clock.t += HZ60; }, hidden: () => h.hidden });
  return h;
}

describe('GFX-02 startup test inside the module (AUTO)', () => {
  beforeEach(() => resetQualitySession());
  afterEach(() => resetQualitySession());

  it('AUTO picks the tier during warmUp, broadcasts it, compiles, and reuses the result for the next match', async () => {
    const h = harness();
    expect(h.q.requested).toBe(QualityTier.AUTO);
    expect(h.q.tier).toBe(QualityTier.BALANCED); // until tested
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.renderer.renders).toBeGreaterThan(QT.testWarmupFrames + QT.testMinSamples);
    expect(h.renderer.reads).toBe(h.renderer.renders); // every measured frame waits for the GPU
    expect(h.renderer.target).toBe(null); // render target restored
    expect(h.q.startupTest?.conclusive).toBe(true);
    expect(h.q.tier).toBe(QualityTier.QUALITY); // 3 ms frames
    expect(h.tiers).toEqual([QualityTier.QUALITY]);
    expect(h.ctx.tier).toBe(QualityTier.QUALITY);
    expect(getTierParams()).toBe(TIER_PARAMS[QualityTier.QUALITY]);
    expect(h.renderer.shadowMap.enabled).toBe(true);
    expect(h.renderer.compiles).toBe(1);
    expect(resolveTier(QualityTier.AUTO)).toBe(QualityTier.QUALITY);
    // Next match: no new test.
    const renders = h.renderer.renders;
    h.q.clearMatch!();
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.renderer.renders).toBe(renders);
    // A new renderer (same page) starts at the tested tier.
    const h2 = harness();
    expect(h2.q.tier).toBe(QualityTier.QUALITY);
  });

  it('slow frames pick PERFORMANCE; the scale stays at the initial value; AUTO may still step up later', async () => {
    const h = harness();
    h.renderer.cost = 40;
    await h.q.warmUp!();
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(h.renderer.shadowMap.enabled).toBe(false);
    expect(h.q.scale).toBe(0.75);
    // The test's pick is not a failure of BALANCED: real play with lots of headroom adapts upward.
    expect(autoTierState().failedMask).toBe(0);
    h.q.setMatch!(state, []);
    h.run(26_000, HZ60, 4); // full resolution after ~12 s, then 10 s of headroom
    // Earned during play, applied on the next loading screen (no shader compile mid-match).
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(h.q.snapshot().pendingTier).toBe(QualityTier.BALANCED);
    const renders = h.renderer.renders, compiles = h.renderer.compiles;
    h.q.clearMatch!();
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.renderer.renders).toBe(renders); // no second startup test
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.renderer.compiles).toBe(compiles + 1);
    expect(h.tiers).toEqual([QualityTier.PERFORMANCE, QualityTier.BALANCED]);
    expect(autoTierState().pendingUp).toBe(QualityTier.AUTO);
  });

  it('no test for an explicit tier, a hidden page or without a renderer; a failing render keeps BALANCED', async () => {
    const e = harness((s) => { s.graphics.tier = QualityTier.PERFORMANCE; });
    await e.q.warmUp!();
    expect(e.renderer.renders).toBe(0);
    expect(e.q.tier).toBe(QualityTier.PERFORMANCE);
    const hid = harness();
    hid.hidden = true;
    await hid.q.warmUp!();
    expect(hid.renderer.renders).toBe(0);
    expect(hid.q.tier).toBe(QualityTier.BALANCED);
    const none = harness(undefined, false);
    await none.q.warmUp!();
    expect(none.q.tier).toBe(QualityTier.BALANCED);
    const bad = harness();
    bad.renderer.fail = true;
    await bad.q.warmUp!();
    expect(bad.q.tier).toBe(QualityTier.BALANCED);
    expect(bad.q.startupTest?.conclusive).toBe(false);
    expect(autoTierState().tested).toBe(false); // tried again on the next match
  });

  it('quitting during the test (clearMatch) aborts it without changing the tier', async () => {
    const h = harness();
    const p = h.q.warmUp!();
    h.q.clearMatch!();
    await p;
    expect(h.q.startupTest?.aborted).toBe(true);
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.tiers).toEqual([]);
  });

  it('the settings change to an explicit tier during the test wins over the pick', async () => {
    const h = harness();
    const p = h.q.warmUp!();
    h.q.request(QualityTier.PERFORMANCE);
    await p;
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(autoTierState().tier).toBe(QualityTier.QUALITY); // remembered for AUTO
    expect(h.q.request(QualityTier.AUTO)).toBe(QualityTier.QUALITY);
  });
});

describe('GFX-02 tier adaptation', () => {
  beforeEach(() => resetQualitySession());
  afterEach(() => resetQualitySession());

  it('QUALITY steps down to BALANCED when it cannot hold 50 fps (2 s), not on a short dip', () => {
    const h = harness((s) => { s.graphics.tier = QualityTier.QUALITY; });
    h.q.setMatch!(state, []);
    h.run(3000, HZ60, 6);
    h.run(1500, 25, 6); // 40 fps for 1.5 s: a dip
    h.run(3000, HZ60, 6);
    expect(h.q.tier).toBe(QualityTier.QUALITY);
    h.run(4000, 25, 6); // sustained 40 fps
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.tiers).toEqual([QualityTier.BALANCED]);
    expect(h.ctx.tier).toBe(QualityTier.BALANCED);
    expect(h.renderer.shadowMap.enabled).toBe(false);
    expect(h.q.requested).toBe(QualityTier.QUALITY); // the setting is not rewritten
    // A scale-only settings change re-requests QUALITY: stays stepped down.
    expect(h.q.request(QualityTier.QUALITY)).toBe(QualityTier.BALANCED);
    // Choosing another tier and QUALITY again retries it.
    h.q.request(QualityTier.BALANCED);
    expect(h.q.request(QualityTier.QUALITY)).toBe(QualityTier.QUALITY);
  });

  it('explicit PERFORMANCE and BALANCED never change, even at 20 fps', () => {
    for (const t of [QualityTier.PERFORMANCE, QualityTier.BALANCED]) {
      const h = harness((s) => { s.graphics.tier = t; });
      h.q.setMatch!(state, []);
      h.run(30_000, 50, 4);
      expect(h.q.tier).toBe(t);
      expect(h.tiers).toEqual([]);
      expect(h.q.scale).toBe(0.6); // the resolution still adapts
    }
  });

  it('AUTO: BALANCED steps to PERFORMANCE only once the resolution is at its floor; the failure is remembered', () => {
    const h = harness();
    h.q.setMatch!(state, []);
    h.run(2000, 25, 6);
    expect(h.q.tier).toBe(QualityTier.BALANCED); // still lowering the resolution first
    expect(h.q.scale).toBeGreaterThan(0.6);
    h.run(8000, 25, 6);
    expect(h.q.scale).toBe(0.6);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(autoTierState().tier).toBe(QualityTier.PERFORMANCE);
    expect(autoTierState().failedMask & (1 << QualityTier.BALANCED)).not.toBe(0);
    // Fast again: the resolution climbs, but AUTO never returns to the failed tier.
    h.run(120_000, HZ60, 5);
    expect(h.q.scale).toBe(1);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
  });

  /** Next match: clearMatch, setMatch, the loading screen's warmUp. */
  async function nextMatch(h: Harness): Promise<void> {
    h.q.clearMatch!();
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
  }

  it('AUTO steps up after sustained headroom at full resolution (on the next loading screen), and back down (once) if that tier fails', async () => {
    const h = harness();
    h.renderer.cost = 8; // the startup test picks BALANCED
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    h.run(60_000, HZ60, 5);
    expect(h.q.scale).toBe(1);
    // Regression (mid-match compile hitch): the earned step up waits for the loading screen.
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(autoTierState().pendingUp).toBe(QualityTier.QUALITY);
    h.run(60_000, HZ60, 5);
    expect(h.tiers).toEqual([]);
    await nextMatch(h);
    expect(h.q.tier).toBe(QualityTier.QUALITY);
    expect(h.renderer.shadowMap.enabled).toBe(true);
    expect(h.tiers).toEqual([QualityTier.QUALITY]);
    h.run(5000, 30, 6); // QUALITY too heavy here: steps down at once, mid-match
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.renderer.shadowMap.enabled).toBe(false);
    h.run(120_000, HZ60, 5);
    await nextMatch(h);
    expect(h.q.tier).toBe(QualityTier.BALANCED); // QUALITY failed: no flip-flop
    expect(autoTierState().pendingUp).toBe(QualityTier.AUTO);
    expect(h.tiers).toEqual([QualityTier.QUALITY, QualityTier.BALANCED]);
  });

  it('a step down while an earned step up waits cancels it', async () => {
    const h = harness();
    h.renderer.cost = 8;
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    h.run(60_000, HZ60, 5);
    expect(autoTierState().pendingUp).toBe(QualityTier.QUALITY);
    h.run(20_000, 25, 6); // 40 fps: the scale floors, then BALANCED steps down
    expect(h.q.scale).toBe(0.6);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(autoTierState().pendingUp).toBe(QualityTier.AUTO);
    expect(autoTierState().failedMask & (1 << QualityTier.BALANCED)).not.toBe(0);
    await nextMatch(h);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
  });

  it('an explicit tier ignores a waiting AUTO step up; back on AUTO it applies on the next loading screen', async () => {
    const h = harness();
    h.renderer.cost = 8;
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    h.run(60_000, HZ60, 5);
    expect(autoTierState().pendingUp).toBe(QualityTier.QUALITY);
    expect(h.q.request(QualityTier.PERFORMANCE)).toBe(QualityTier.PERFORMANCE);
    await nextMatch(h);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(h.q.request(QualityTier.AUTO)).toBe(QualityTier.BALANCED);
    await nextMatch(h);
    expect(h.q.tier).toBe(QualityTier.QUALITY);
  });

  it('tierAdapterStep in isolation: cooldown between tier changes and no change before enough samples', () => {
    const a = createTierAdapter();
    const s = createFrameSignal();
    for (let i = 0; i < 5; i++) pushFrameSample(s, 30, 5);
    s.dt = 3000; // one huge step with too few samples: no decision
    expect(tierAdapterStep(a, QualityTier.QUALITY, QualityTier.QUALITY, 0, s, false, false)).toBe(QualityTier.QUALITY);
    let t = QualityTier.QUALITY as QualityTier;
    let changedAt = -1;
    for (let k = 0; k < 400 && changedAt < 0; k++) {
      pushFrameSample(s, 30, 5);
      const n = tierAdapterStep(a, t, QualityTier.AUTO, 0, s, true, false);
      if (n !== t) { t = n; changedAt = a.t; }
    }
    expect(t).toBe(QualityTier.BALANCED);
    // Immediately slow again at BALANCED with the scale floored: waits for the cooldown.
    let next = -1;
    for (let k = 0; k < 400 && next < 0; k++) {
      pushFrameSample(s, 30, 5);
      const n = tierAdapterStep(a, t, QualityTier.AUTO, 1 << QualityTier.QUALITY, s, true, false);
      if (n !== t) { t = n; next = a.t; }
    }
    expect(t).toBe(QualityTier.PERFORMANCE);
    expect(next - changedAt).toBeGreaterThanOrEqual(QT.tierCooldownMs);
  });
});

describe('GFX-02 Low Power Mode detector', () => {
  beforeEach(() => resetQualitySession());
  afterEach(() => resetQualitySession());

  const LP = 1000 / 30;

  it('steady 30 fps with idle frame work fires once (hook + listeners), after the resolution floored', () => {
    const h = harness();
    const heard = vi.fn();
    const off = onLowPowerSuspected(heard);
    h.q.setMatch!(state, []);
    h.run(5000, LP, 5);
    expect(h.lowPower).toBe(0); // still lowering the resolution (could be the GPU)
    h.run(8000, LP, 5);
    expect(h.q.scale).toBe(0.6);
    expect(h.lowPower).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(h.q.lowPowerSuspected).toBe(true);
    h.run(30_000, LP, 5);
    h.q.setMatch!(state, []);
    h.run(30_000, LP, 5);
    expect(h.lowPower).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it('robust to occasional hitches; fires sooner with a fixed scale', () => {
    const h = harness((s) => { s.graphics.resolutionScale = 0.8; });
    h.q.setMatch!(state, []);
    h.run(QT.startGraceMs + 1000, LP, 5);
    let k = 0;
    h.run(QT.lowPowerHoldMs + 1500, () => (++k % 90 === 0 ? 60 : LP), 5);
    expect(h.lowPower).toBe(1);
    expect(h.q.scale).toBe(0.8);
  });

  it('does not fire with heavy work, jittery frames, at 60 fps, or when the hint was already shown', () => {
    const heavy = harness();
    heavy.q.setMatch!(state, []);
    heavy.run(30_000, LP, 22);
    expect(heavy.lowPower).toBe(0);
    const jitter = harness();
    jitter.q.setMatch!(state, []);
    let k = 0;
    jitter.run(30_000, () => (++k % 2 === 0 ? 2 * HZ60 : 3 * HZ60), 5);
    expect(jitter.lowPower).toBe(0);
    const smooth = harness();
    smooth.q.setMatch!(state, []);
    smooth.run(30_000, HZ60, 5);
    expect(smooth.lowPower).toBe(0);
    const shown = harness((s) => { s.lowPowerHintShown = true; });
    const heard = vi.fn();
    const off = onLowPowerSuspected(heard);
    shown.q.setMatch!(state, []);
    shown.run(30_000, LP, 5);
    expect(shown.q.lowPowerSuspected).toBe(true);
    expect(shown.lowPower).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it('regression: Low Power Mode does not cost AUTO its tier for the page; it climbs back once the mode is off', async () => {
    const h = harness();
    h.renderer.cost = 8; // the startup test picks BALANCED
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    h.run(15_000, LP, 5); // 30 fps cap: the scale floors, BALANCED steps down, then the detector fires
    expect(h.q.scale).toBe(0.6);
    expect(h.q.tier).toBe(QualityTier.PERFORMANCE);
    expect(h.lowPower).toBe(1);
    expect(autoTierState().failedMask).toBe(0); // the forced step down is forgiven
    h.run(60_000, LP, 5); // still capped: nothing earned, no flip-flop
    expect(autoTierState().pendingUp).toBe(QualityTier.AUTO);
    h.run(60_000, HZ60, 4); // the player turned Low Power Mode off
    expect(h.q.scale).toBe(1);
    expect(autoTierState().pendingUp).toBe(QualityTier.BALANCED);
    h.q.clearMatch!();
    h.q.setMatch!(state, []);
    await h.q.warmUp!();
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.tiers).toEqual([QualityTier.PERFORMANCE, QualityTier.BALANCED]);
  });

  it('lowPowerStep requires the settled flag and a work measurement', () => {
    const s = createFrameSignal();
    const d = createLowPowerDetector();
    for (let i = 0; i < 200; i++) {
      pushFrameSample(s, LP, 4);
      expect(lowPowerStep(d, s, false)).toBe(false);
    }
    const noWork = createFrameSignal();
    for (let i = 0; i < 200; i++) {
      pushFrameSample(noWork, LP, -1);
      expect(lowPowerStep(d, noWork, true)).toBe(false);
    }
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      pushFrameSample(s, LP, 4);
      if (lowPowerStep(d, s, true)) fired++;
    }
    expect(fired).toBe(1);
  });
});

describe('GFX-02 module wiring', () => {
  beforeEach(() => resetQualitySession());
  afterEach(() => resetQualitySession());

  it('request(): invalid tiers mean AUTO; a fixed scale applies; back to automatic restarts at 0.75', () => {
    expect(sanitizeTier(42)).toBe(QualityTier.AUTO);
    expect(sanitizeTier(-1)).toBe(QualityTier.AUTO);
    const h = harness((s) => { s.graphics.tier = 42 as QualityTier; s.graphics.resolutionScale = 7; });
    expect(h.q.requested).toBe(QualityTier.AUTO);
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(h.scales).toEqual([1]);
    const next = JSON.parse(JSON.stringify(h.ctx.settings)) as Settings;
    next.graphics.resolutionScale = 0;
    h.ctx.settings = next;
    expect(h.q.request(QualityTier.AUTO)).toBe(QualityTier.BALANCED);
    expect(h.q.scale).toBe(0.75);
    expect(h.scales).toEqual([1, 0.75]);
  });

  it('a dynamic scale is kept when the same tier is requested again (scale-only or unrelated settings changes)', () => {
    const h = harness((s) => { s.graphics.tier = QualityTier.BALANCED; });
    h.q.setMatch!(state, []);
    h.run(8000, 30, 6);
    expect(h.q.scale).toBeLessThan(0.75);
    const s = h.q.scale;
    expect(h.q.request(QualityTier.BALANCED)).toBe(QualityTier.BALANCED);
    expect(h.q.scale).toBe(s);
    // A different explicit tier keeps the scale too (the controller takes it from there).
    expect(h.q.request(QualityTier.QUALITY)).toBe(QualityTier.QUALITY);
    expect(h.q.scale).toBe(s);
    expect(h.renderer.shadowMap.enabled).toBe(true);
    expect(h.tiers).toEqual([]); // request() results are broadcast by index.ts, not through setTier
  });

  it('frame work is measured from the rAF timestamp to the end of renderer.render (chained onAfterRender)', () => {
    const h = harness();
    const prev = vi.fn();
    // Installed after the quality module: update() takes the hook back and chains it.
    (h.ctx.scene as unknown as { onAfterRender: unknown }).onAfterRender = prev;
    h.q.setMatch!(state, []);
    h.run(2000, HZ60, 7);
    expect(prev).toHaveBeenCalled();
    expect(h.q.snapshot().workMs).toBeCloseTo(7, 1);
    expect(h.q.snapshot().intervalMs).toBeCloseTo(HZ60, 1);
    // Renders outside a frame (startup test, other passes) do not count as frame work.
    const sc = h.ctx.scene as unknown as { onAfterRender: (...a: unknown[]) => void };
    h.clock.t += 500;
    sc.onAfterRender(h.ctx.renderer, h.ctx.scene, h.ctx.camera);
    h.run(200, HZ60, 7);
    expect(h.q.snapshot().workMs).toBeCloseTo(7, 1);
  });

  it('paused frames are ignored', () => {
    const h = harness();
    h.q.setMatch!(state, []);
    h.run(2000, HZ60, 5);
    const n = h.q.snapshot().samples;
    for (let i = 0; i < 300; i++) h.frame(80, 60, true);
    expect(h.q.snapshot().samples).toBe(n);
    expect(h.q.scale).toBe(0.75);
  });

  it('match start is observed only (loading hitches do not lower the resolution)', () => {
    const h = harness();
    h.q.setMatch!(state, []);
    h.run(QT.startGraceMs - 100, 60, 40);
    expect(h.q.scale).toBe(0.75);
  });

  it('a window resize restarts the holds; the module own scale changes do not', () => {
    const h = harness();
    h.q.setMatch!(state, []);
    h.run(QT.startGraceMs + 200, HZ60, 5);
    h.run(QT.resUpHoldMs - 300, HZ60, 5);
    h.ctx.size.cssW = 1024;
    h.q.resize!();
    h.run(500, HZ60, 5);
    expect(h.q.scale).toBe(0.75); // the hold restarted at the resize
    h.run(QT.resUpHoldMs, HZ60, 5);
    expect(h.q.scale).toBe(0.8);
    h.q.resize!(); // same size (index.ts calls resize() after our own setScale)
    h.run(QT.resUpHoldMs + 100, HZ60, 5);
    expect(h.q.scale).toBe(0.85);
  });

  it('regression: turning the shadow map on or off rebuilds material programs (three.js ignores the flag alone)', () => {
    const h = harness((s) => { s.graphics.tier = QualityTier.BALANCED; });
    const lambert = new MeshLambertMaterial();
    const basic = new MeshBasicMaterial();
    const geo = new BoxGeometry();
    const group = new Group();
    group.add(new Mesh(geo, [basic, lambert]));
    h.ctx.scene.add(new Mesh(geo, lambert), group);
    const v0 = lambert.version, b0 = basic.version;
    h.q.request(QualityTier.QUALITY); // off -> on
    expect(h.renderer.shadowMap.enabled).toBe(true);
    expect(lambert.version).toBeGreaterThan(v0);
    expect(basic.version).toBeGreaterThan(b0);
    const v1 = lambert.version;
    h.q.request(QualityTier.QUALITY); // unchanged: no rebuild
    expect(lambert.version).toBe(v1);
    h.q.request(QualityTier.PERFORMANCE); // on -> off
    expect(h.renderer.shadowMap.enabled).toBe(false);
    expect(lambert.version).toBeGreaterThan(v1);
    const v2 = lambert.version;
    h.q.request(QualityTier.BALANCED); // off -> off: no rebuild
    expect(lambert.version).toBe(v2);
    expect(markMaterialsForRecompile(h.ctx.scene)).toBe(3);
    // The mid-match step down from QUALITY takes the same path.
    h.q.request(QualityTier.QUALITY);
    h.q.setMatch!(state, []);
    const v3 = lambert.version;
    h.run(6000, 30, 6);
    expect(h.q.tier).toBe(QualityTier.BALANCED);
    expect(lambert.version).toBeGreaterThan(v3);
    geo.dispose();
  });

  it('dispose restores the scene hook and leaves the scene usable', () => {
    const h = harness();
    const before = Scene.prototype.onAfterRender;
    h.q.dispose();
    expect((h.ctx.scene as unknown as { onAfterRender: unknown }).onAfterRender).toBe(before);
  });

  it('getTierParams: QUALITY alone adds one shadow map and multisampling; densities increase with the tier', () => {
    const p = getTierParams(QualityTier.PERFORMANCE), b = getTierParams(QualityTier.BALANCED), q = getTierParams(QualityTier.QUALITY);
    expect([p.shadowMap, b.shadowMap, q.shadowMap]).toEqual([false, false, true]);
    expect([p.msaa, b.msaa, q.msaa]).toEqual([false, false, true]);
    expect(q.shadowMapSize).toBeGreaterThan(0);
    expect(p.crowdDensity).toBeLessThan(b.crowdDensity);
    expect(b.crowdDensity).toBeLessThan(q.crowdDensity);
    expect(p.netDetail).toBeLessThan(q.netDetail);
    expect(p.effectsScale).toBeLessThan(q.effectsScale);
    expect([p.anisotropy, b.anisotropy, q.anisotropy]).toEqual([1, 4, 8]);
    expect(getTierParams(QualityTier.AUTO)).toBe(b); // AUTO before the test
    expect(getTierParams(99 as QualityTier)).toBe(b);
    expect(Object.isFrozen(q)).toBe(true);
    for (const t of [QualityTier.PERFORMANCE, QualityTier.BALANCED, QualityTier.QUALITY]) expect(getTierParams(t).tier).toBe(t);
  });
});

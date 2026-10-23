/**
 * [FND-06] Benchmark mode (brief section 13 "Proving it"). maybeStartBench(ctx) is called by the app boot; with
 * `?bench=1` in the URL it starts a fixed-seed bot-v-bot match (mode BENCH, both sides CPU) and measures, after a
 * short warm-up, 90 s of play: per-frame times (rAF), sim ms per tick and render ms (the loop's
 * window.__dotkickFrameStats), draw calls and triangles (window.__dotkickRendererStats), resolution scale, quality
 * tier, device and browser. At the end it computes average fps, 1% and 0.1% lows and the longest frame, checks
 * them against the section 13 budgets, stores window.__benchResult, and shows a results panel with Copy Results.
 *
 * URL options: bench=1, benchSeconds=N (measurement length, default 90), benchSeed=N, benchWarmup=N (seconds).
 * startBench(ctx, opts) runs the same benchmark from code (Settings -> Diagnostics, PLT-05).
 * computeBenchResult / formatBenchResult are pure (unit-tested in Node).
 *
 * Sim timing: every rendered frame the hook drains the loop's stats (worst tick of that frame, sum and count of
 * ticks) and resets them, so it keeps a per-frame distribution. The headless proxy gate (4x CPU throttling) judges
 * the 99th percentile of the per-frame worst tick against the 4 ms budget, never counting the 2 slowest frames: one
 * GC, JIT or scheduling hitch decides a single maximum, so the max ("worst") is judged only in the full verdict (a
 * real device run), like the fps budgets. Frames with a tick over budget are counted and reported.
 *
 * [QF-5] Only play is measured: frames while the match is paused (rotate card, a system alert, the pause menu) and the
 * gap of a hidden page (rAF stops, the first frame back spans the whole absence) are not samples, and the window is
 * extended by that time, so a notification or a rotation during the run never turns into a 30-second "longest frame".
 */
import type { AppContext, MatchSetup } from '../contracts/app';
import { GAME_VERSION } from '../contracts/constants';
import { ControllerKind, Difficulty, MatchPhase, ModeId } from '../contracts/enums';
import type { RenderStats } from '../contracts/render';
import { createMatchConfig, type ControllerConfig } from '../contracts/state';

/** Section 13 budgets. */
export const BENCH_BUDGETS = {
  avgFps: 58,
  low1Fps: 50,
  longestFrameMs: 33,
  simMsAvg: 2.5,
  simMsMax: 4,
  drawCalls: 80,
  triangles: 200_000,
} as const;

export const BENCH_DEFAULTS = {
  seconds: 90,
  /**
   * [FIN-P] The bench match's seed: its 90 s window on a 60 Hz device holds a crowded penalty area, a corner (46 s), a goal
   * into the net (51 s, net ripple), its replay (56 s) and free kicks (BRIEF section 13 "Proving it"). Any sim change
   * reshapes the match: tests/perf/fin-p-bench-coverage.test.ts fails when this seed stops covering the cases (search
   * another: npx tsx tests/perf/sgn-04-bench-coverage.ts --search 100). Was 0xb3ac4 (no corner, goal or replay).
   */
  seed: 1,
  warmupSeconds: 5,
  /** ...and at least this many sim ticks before measuring (JIT warm-up on a throttled CPU). */
  warmupTicks: 300,
  /** Percentile of the per-frame worst sim tick judged by the proxy gate. */
  simPercentile: 0.99,
  /**
   * ...and at least this many of the slowest frames are always treated as hitches (a throttled headless run may
   * render only a few hundred frames, or a few dozen in a short run, where p99 alone would be the maximum).
   */
  simHitchFrames: 2,
  /** Give up if the match has not loaded after this long. */
  loadTimeoutSeconds: 60,
} as const;

export interface BenchCheck {
  name: string;
  value: number | null;
  limit: number;
  /** 'min': value must be >= limit; 'max': value must be <= limit. */
  kind: 'min' | 'max';
  pass: boolean;
  /** Enforced by the headless proxy gate (tools/bench.ts): sim, draw calls, triangles. */
  proxy: boolean;
}

export interface BenchResult {
  game: string;
  seed: number;
  /** Measured seconds and frames. */
  seconds: number;
  frames: number;
  avgFps: number;
  low1Fps: number;
  low01Fps: number;
  longestFrameMs: number;
  /** Sim (step incl. AI) per tick, ms; null when the loop exposes no frame stats. */
  simMsAvg: number | null;
  simMsMax: number | null;
  /**
   * 99th percentile of the worst tick per rendered frame, ms, never counting the simHitchFrames slowest frames (the
   * proxy gate's "worst" statistic).
   */
  simMsP99: number | null;
  /** Rendered frames whose worst tick exceeded the 4 ms budget. */
  simFramesOverBudget: number | null;
  ticks: number | null;
  renderMsAvg: number | null;
  renderMsMax: number | null;
  /** Renderer stats; null when no renderer stats hook is present. */
  drawCallsAvg: number | null;
  drawCallsMax: number | null;
  trianglesAvg: number | null;
  trianglesMax: number | null;
  resolutionScale: number | null;
  qualityTier: number | null;
  userAgent: string;
  screen: string;
  checks: BenchCheck[];
  /** Every check passed. */
  pass: boolean;
  /** The proxy-gate checks (sim, draw calls, triangles) passed. */
  proxyPass: boolean;
  error?: string;
}

/** Raw samples collected during the measurement window. */
export interface BenchSamples {
  /** Frame intervals, ms. */
  frameMs: ArrayLike<number>;
  frames: number;
  /** Sum / max / count of renderer stats samples (count 0 = no renderer stats). */
  drawCallsSum: number;
  drawCallsMax: number;
  trianglesSum: number;
  trianglesMax: number;
  renderSamples: number;
  resolutionScale: number | null;
  qualityTier: number | null;
  simMsAvg: number | null;
  simMsMax: number | null;
  /** Worst sim tick of each rendered frame that ran ticks, ms (absent: the gate falls back to simMsMax). */
  simFrameMaxMs?: ArrayLike<number>;
  /** Entries used in simFrameMaxMs. */
  simFrames?: number;
  ticks: number | null;
  renderMsAvg: number | null;
  renderMsMax: number | null;
}

export interface BenchEnv {
  seed: number;
  userAgent: string;
  screen: string;
  error?: string;
}

/** Average fps over the slowest `fraction` of frames (at least one frame). */
function lowFps(sortedDesc: readonly number[], fraction: number): number {
  if (sortedDesc.length === 0) return 0;
  const n = Math.max(1, Math.ceil(sortedDesc.length * fraction));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sortedDesc[i]!;
  return sum > 0 ? 1000 / (sum / n) : 0;
}

/**
 * Nearest-rank percentile (q in 0..1) of the first n values; null when n is 0. With `excludeTop` > 0 the rank is
 * also at most m - excludeTop (those slowest values never decide it), but never below the median. Pure.
 */
export function percentile(values: ArrayLike<number>, n: number, q: number, excludeTop = 0): number | null {
  const m = Math.min(n, values.length);
  if (m <= 0) return null;
  const sorted: number[] = [];
  for (let i = 0; i < m; i++) sorted.push(values[i]!);
  sorted.sort((a, b) => a - b);
  let rank = Math.min(m, Math.max(1, Math.ceil(q * m)));
  if (excludeTop > 0) rank = Math.max(Math.ceil(m / 2), Math.min(rank, m - excludeTop));
  return sorted[rank - 1]!;
}

function check(name: string, value: number | null, limit: number, kind: 'min' | 'max', proxy: boolean): BenchCheck {
  const pass = value !== null && Number.isFinite(value) && (kind === 'min' ? value >= limit : value <= limit);
  return { name, value, limit, kind, pass, proxy };
}

/** Compute fps statistics and budget checks from raw samples. Pure. */
export function computeBenchResult(samples: BenchSamples, env: BenchEnv): BenchResult {
  const n = Math.min(samples.frames, samples.frameMs.length);
  const times: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = samples.frameMs[i]!;
    times.push(t);
    total += t;
  }
  times.sort((a, b) => b - a);
  const avgFps = total > 0 ? (1000 * n) / total : 0;
  const rs = samples.renderSamples;
  const simFrames = samples.simFrameMaxMs ? Math.min(samples.simFrames ?? samples.simFrameMaxMs.length, samples.simFrameMaxMs.length) : 0;
  let simMsP99: number | null = null;
  let simFramesOverBudget: number | null = null;
  if (samples.simFrameMaxMs && simFrames > 0) {
    simMsP99 = percentile(samples.simFrameMaxMs, simFrames, BENCH_DEFAULTS.simPercentile, BENCH_DEFAULTS.simHitchFrames);
    simFramesOverBudget = 0;
    for (let i = 0; i < simFrames; i++) if (samples.simFrameMaxMs[i]! > BENCH_BUDGETS.simMsMax) simFramesOverBudget++;
  } else if (samples.simMsMax !== null) {
    simMsP99 = samples.simMsMax; // no distribution: judge the maximum (conservative, p99 <= max)
  }
  const r: BenchResult = {
    game: `DotKick ${GAME_VERSION}`,
    seed: env.seed,
    seconds: total / 1000,
    frames: n,
    avgFps,
    low1Fps: lowFps(times, 0.01),
    low01Fps: lowFps(times, 0.001),
    longestFrameMs: n > 0 ? times[0]! : 0,
    simMsAvg: samples.simMsAvg,
    simMsMax: samples.simMsMax,
    simMsP99,
    simFramesOverBudget,
    ticks: samples.ticks,
    renderMsAvg: samples.renderMsAvg,
    renderMsMax: samples.renderMsMax,
    drawCallsAvg: rs > 0 ? samples.drawCallsSum / rs : null,
    drawCallsMax: rs > 0 ? samples.drawCallsMax : null,
    trianglesAvg: rs > 0 ? samples.trianglesSum / rs : null,
    trianglesMax: rs > 0 ? samples.trianglesMax : null,
    resolutionScale: samples.resolutionScale,
    qualityTier: samples.qualityTier,
    userAgent: env.userAgent,
    screen: env.screen,
    checks: [],
    pass: false,
    proxyPass: false,
    ...(env.error ? { error: env.error } : {}),
  };
  r.checks = [
    check('average fps', n > 0 ? r.avgFps : null, BENCH_BUDGETS.avgFps, 'min', false),
    check('1% low fps', n > 0 ? r.low1Fps : null, BENCH_BUDGETS.low1Fps, 'min', false),
    check('longest frame ms', n > 0 ? r.longestFrameMs : null, BENCH_BUDGETS.longestFrameMs, 'max', false),
    check('sim + AI ms/tick avg', r.simMsAvg, BENCH_BUDGETS.simMsAvg, 'max', true),
    check('sim + AI ms/tick p99 of frame worst', r.simMsP99, BENCH_BUDGETS.simMsMax, 'max', true),
    check('sim + AI ms/tick worst', r.simMsMax, BENCH_BUDGETS.simMsMax, 'max', false),
    check('draw calls (max)', r.drawCallsMax, BENCH_BUDGETS.drawCalls, 'max', true),
    check('triangles (max)', r.trianglesMax, BENCH_BUDGETS.triangles, 'max', true),
  ];
  r.pass = !r.error && r.checks.every((c) => c.pass);
  r.proxyPass = !r.error && r.checks.every((c) => !c.proxy || c.pass);
  return r;
}

function fmt(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);
}

/** Plain-text report (what Copy Results copies). Pure. */
export function formatBenchResult(r: BenchResult): string {
  const lines = [
    `${r.game} benchmark - seed ${r.seed} - ${r.pass ? 'PASS' : 'FAIL'}`,
    `measured ${fmt(r.seconds, 1)} s, ${r.frames} frames${r.ticks !== null ? `, ${r.ticks} ticks` : ''}`,
    `fps avg ${fmt(r.avgFps, 1)}, 1% low ${fmt(r.low1Fps, 1)}, 0.1% low ${fmt(r.low01Fps, 1)}, longest frame ${fmt(r.longestFrameMs, 1)} ms`,
    `sim ms/tick avg ${fmt(r.simMsAvg, 3)} p99 ${fmt(r.simMsP99, 3)} worst ${fmt(r.simMsMax, 3)}` +
      `${r.simFramesOverBudget !== null ? ` (${r.simFramesOverBudget} frame(s) with a tick over ${BENCH_BUDGETS.simMsMax} ms)` : ''}` +
      `; render ms avg ${fmt(r.renderMsAvg, 2)} worst ${fmt(r.renderMsMax, 2)}`,
    `draw calls avg ${fmt(r.drawCallsAvg, 1)} max ${fmt(r.drawCallsMax, 0)}; triangles avg ${fmt(r.trianglesAvg, 0)} max ${fmt(r.trianglesMax, 0)}`,
    `resolution scale ${fmt(r.resolutionScale, 2)}, quality tier ${r.qualityTier ?? 'n/a'}, screen ${r.screen}`,
    `device ${r.userAgent}`,
  ];
  for (const c of r.checks) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${fmt(c.value, 2)} (${c.kind === 'min' ? '>=' : '<='} ${c.limit})${c.proxy ? ' [proxy gate]' : ''}`);
  }
  if (r.error) lines.push(`ERROR ${r.error}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- browser side

declare global {
  interface Window {
    /** Result of the last benchmark run (set when it finishes). */
    __benchResult?: BenchResult;
  }
}

/** Frame stats the app loop exposes (src/app/types.ts FrameStats; only the fields used here). */
interface LoopStatsView {
  simMsAvg: number;
  simMsMax: number;
  renderMsAvg: number;
  renderMsMax: number;
  sampleTicks: number;
  sampleFrames: number;
  reset(): void;
}

/** Running sim / render timing drained from the loop's stats once per rendered frame. */
interface TimingAcc {
  ticks: number;
  simSum: number;
  simMax: number;
  frames: number;
  renderSum: number;
  renderMax: number;
  /** Worst tick per frame (frames that ran ticks). */
  simFrameMaxMs: Float64Array;
  simFrames: number;
}

/** Fold the loop's stats since its last reset into `acc`, then reset them (one window per rendered frame). */
function drainLoopStats(ls: LoopStatsView, acc: TimingAcc): void {
  if (ls.sampleTicks > 0) {
    acc.ticks += ls.sampleTicks;
    acc.simSum += ls.simMsAvg * ls.sampleTicks;
    if (ls.simMsMax > acc.simMax) acc.simMax = ls.simMsMax;
    if (acc.simFrames < acc.simFrameMaxMs.length) acc.simFrameMaxMs[acc.simFrames++] = ls.simMsMax;
  }
  if (ls.sampleFrames > 0) {
    acc.frames += ls.sampleFrames;
    acc.renderSum += ls.renderMsAvg * ls.sampleFrames;
    if (ls.renderMsMax > acc.renderMax) acc.renderMax = ls.renderMsMax;
  }
  ls.reset();
}

export interface BenchOptions {
  seconds?: number;
  seed?: number;
  warmupSeconds?: number;
  /** Show the results panel (default true). */
  panel?: boolean;
  onDone?: (r: BenchResult) => void;
}

export interface BenchHandle {
  readonly running: boolean;
  /** Stop early and report what was measured. */
  stop(): void;
}

function cpu(): ControllerConfig {
  return { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 };
}

/** The fixed bench match: 2-minute halves (longer than the window), both sides CPU, World Class, replays on. */
export function benchSetup(seed: number): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed >>> 0;
  config.mode = ModeId.BENCH;
  config.homeClub = 0;
  config.awayClub = 1;
  config.halfMinutes = 2;
  config.difficulty = Difficulty.WORLD_CLASS;
  config.replaySeconds = 8;
  config.humans = [cpu(), cpu()];
  return { config, bindings: [] };
}

function loopStats(): LoopStatsView | null {
  const s = (window as unknown as { __dotkickFrameStats?: LoopStatsView }).__dotkickFrameStats;
  return s && typeof s.reset === 'function' ? s : null;
}

function rendererStats(): RenderStats | null {
  try {
    return window.__dotkickRendererStats?.() ?? null;
  } catch {
    return null;
  }
}

function showPanel(r: BenchResult): void {
  const text = formatBenchResult(r);
  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'bench-results');
  panel.style.cssText = 'position:fixed;left:16px;top:16px;max-width:calc(100vw - 32px);z-index:2147483000;' +
    'background:rgba(10,12,16,0.92);color:#f2f2f2;font:13px/1.45 ui-monospace,Menlo,monospace;padding:14px 16px;' +
    'border-radius:10px;white-space:pre-wrap;box-shadow:0 6px 30px rgba(0,0,0,0.5);';
  const pre = document.createElement('div');
  pre.textContent = text;
  const btn = document.createElement('button');
  btn.textContent = 'Copy Results';
  btn.setAttribute('data-testid', 'bench-copy');
  btn.style.cssText = 'margin-top:10px;min-height:60px;min-width:160px;font:inherit;font-weight:600;border-radius:8px;' +
    'border:0;background:#ff7a1a;color:#111;cursor:pointer;';
  btn.addEventListener('click', () => {
    const done = (ok: boolean): void => { btn.textContent = ok ? 'Copied' : 'Copy failed - select the text'; };
    const fallback = (): void => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok: boolean;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      done(ok);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  });
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = btn.style.cssText + 'margin-left:12px;background:#333;color:#eee;';
  close.addEventListener('click', () => panel.remove());
  panel.append(pre, btn, close);
  document.body.appendChild(panel);
}

/** Start the benchmark match and measurement. */
export function startBench(ctx: AppContext, opts: BenchOptions = {}): BenchHandle {
  const seconds = opts.seconds ?? BENCH_DEFAULTS.seconds;
  const seed = opts.seed ?? BENCH_DEFAULTS.seed;
  const warmupMs = (opts.warmupSeconds ?? BENCH_DEFAULTS.warmupSeconds) * 1000;
  const cap = Math.ceil(seconds * 240) + 1024; // frame slots for up to 240 Hz
  const frameMs = new Float64Array(cap);
  const samples: BenchSamples = {
    frameMs, frames: 0, drawCallsSum: 0, drawCallsMax: 0, trianglesSum: 0, trianglesMax: 0, renderSamples: 0,
    resolutionScale: null, qualityTier: null, simMsAvg: null, simMsMax: null, ticks: null, renderMsAvg: null, renderMsMax: null,
  };
  const timing: TimingAcc = {
    ticks: 0, simSum: 0, simMax: 0, frames: 0, renderSum: 0, renderMax: 0, simFrameMaxMs: new Float64Array(cap), simFrames: 0,
  };
  let stage: 'waiting' | 'warmup' | 'measuring' | 'done' = 'waiting';
  let t0 = performance.now();
  let stageStart = t0;
  let last = 0;
  let error: string | undefined;
  /** Time not measured (paused match, hidden page) inside the measurement window, ms. */
  let pausedMs = 0;
  /** The page was hidden since the last frame: the next frame interval spans the absence. */
  let wasHidden = false;
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') wasHidden = true;
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  const finish = (why?: string): void => {
    if (stage === 'done') return;
    stage = 'done';
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (why) error = why;
    const ls = loopStats();
    if (ls && samples.frames > 0) {
      drainLoopStats(ls, timing);
      // No ticks measured means no sim timing: null fails the proxy gate rather than passing it by default.
      if (timing.ticks > 0) {
        samples.simMsAvg = timing.simSum / timing.ticks;
        samples.simMsMax = timing.simMax;
        samples.simFrameMaxMs = timing.simFrameMaxMs;
        samples.simFrames = timing.simFrames;
        samples.ticks = timing.ticks;
      }
      if (timing.frames > 0) {
        samples.renderMsAvg = timing.renderSum / timing.frames;
        samples.renderMsMax = timing.renderMax;
      }
    }
    const result = computeBenchResult(samples, {
      seed,
      userAgent: navigator.userAgent,
      screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      ...(error ? { error } : {}),
    });
    window.__benchResult = result;
    try { ctx.diagnostics.log('bench', formatBenchResult(result)); } catch { /* diagnostics optional */ }
    if (opts.panel !== false) showPanel(result);
    opts.onDone?.(result);
  };

  const onFrame = (now: number): void => {
    if (stage === 'done') return;
    const state = ctx.session.getState();
    if (stage === 'waiting') {
      if (state) { stage = 'warmup'; stageStart = now; } else if (now - t0 > BENCH_DEFAULTS.loadTimeoutSeconds * 1000) {
        finish('match did not load');
        return;
      }
    } else if (stage === 'warmup') {
      // Warm up by time and by sim ticks (JIT), so a slow (throttled) device still measures warm code.
      if (now - stageStart >= warmupMs && state !== null && state.tick >= BENCH_DEFAULTS.warmupTicks) {
        stage = 'measuring';
        stageStart = now;
        last = now;
        loopStats()?.reset();
      }
    } else {
      const dt = now - last;
      last = now;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (ctx.session.paused || hidden || wasHidden) {
        // Not play: no sample, and the window waits for play to come back.
        wasHidden = hidden;
        pausedMs += dt;
        loopStats()?.reset();
        requestAnimationFrame(onFrame);
        return;
      }
      if (samples.frames < cap) frameMs[samples.frames++] = dt;
      const ls = loopStats();
      if (ls) drainLoopStats(ls, timing);
      const rs = rendererStats();
      if (rs) {
        samples.renderSamples++;
        samples.drawCallsSum += rs.drawCalls;
        if (rs.drawCalls > samples.drawCallsMax) samples.drawCallsMax = rs.drawCalls;
        samples.trianglesSum += rs.triangles;
        if (rs.triangles > samples.trianglesMax) samples.trianglesMax = rs.triangles;
        samples.resolutionScale = rs.resolutionScale;
        samples.qualityTier = rs.qualityTier;
      }
      const ended = !ctx.session.active || (state !== null && state.match.phase === MatchPhase.POST_MATCH);
      const played = now - stageStart - pausedMs;
      if (played >= seconds * 1000 || ended) {
        finish(ended && played < seconds * 1000 ? 'match ended before the measurement window' : undefined);
        return;
      }
    }
    requestAnimationFrame(onFrame);
  };

  t0 = performance.now();
  ctx.session.start(benchSetup(seed));
  requestAnimationFrame(onFrame);
  return {
    get running() { return stage !== 'done'; },
    stop() { finish('stopped early'); },
  };
}

/** Parse a positive number URL parameter. */
function param(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Called by the app boot: starts the benchmark when the URL has bench=1. Returns true if it started. */
export function maybeStartBench(ctx: AppContext): boolean {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  if (q.get('bench') !== '1') return false;
  const seconds = param(q, 'benchSeconds');
  const seed = param(q, 'benchSeed');
  const warmup = param(q, 'benchWarmup');
  startBench(ctx, {
    ...(seconds !== undefined && seconds > 0 ? { seconds } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(warmup !== undefined ? { warmupSeconds: warmup } : {}),
  });
  return true;
}

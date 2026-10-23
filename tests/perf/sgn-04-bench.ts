/**
 * [SGN-04] Final throttled proxy benchmark (BRIEF section 13 "Proving it", DoD 6) for one production build: the real
 * single-file app at iPad size (1180 x 820, DPR 1) under Chromium CDP CPU throttling, in two kinds of match:
 *  - `--mode cpu`: the benchmark match itself (?bench=1: fixed seed, CPU v CPU, World Class, replays on);
 *  - `--mode human`: Play now from the main menu (P1 on touch v CPU, default settings), driven by real CDP touch
 *    events: a thumb on the floating stick circling all the time, the big button held (sprint) and the three small
 *    cluster buttons tapped in turn (pass / through / shoot in attack, the defence meanings out of possession), so the
 *    touch layer, its DOM feedback and the human-controller path run every frame as on the iPad.
 * Per throttle rate it reports frame intervals (rAF) p50 / p95 / p99 / max, average and 1 % low fps, frames over
 * 33 / 50 ms, loop work (sim + render stage) and render stage percentiles, sim ticks per frame, draw calls and
 * triangles (max), resolution scale (min / max / steps) and tier, GC pauses from a CDP trace (minor / major, longest),
 * heap after a forced GC at the start and the end of the window (steady growth), and the phases seen.
 * `--long M`: first fast-forwards M minutes of a CPU v CPU match with 10-minute halves (every frame rendered through
 * the real loop, draw calls stubbed, as fast as the CPU allows), then measures: "after a 20-minute match" (BRIEF 13).
 * `--nodraw`: WebGL draw calls are no-ops (three.js still does all its JS and GL state work and counts the draw
 * calls); SwiftShader rasterises a frame in 100+ ms here, which hides the main thread (see qf-7r-browser-bench.ts).
 *
 *   npx vite build --outDir dist-e2e/sgn-04 --emptyOutDir && node tools/postbuild.mjs dist-e2e/sgn-04
 *   npx tsx tests/perf/sgn-04-bench.ts --dist dist-e2e/sgn-04 --mode cpu --throttle 4,6 --seconds 20 --nodraw
 *   npx tsx tests/perf/sgn-04-bench.ts --dist dist-e2e/sgn-04 --mode human --throttle 4,6 --seconds 20 --nodraw
 *   npx tsx tests/perf/sgn-04-bench.ts --dist dist-e2e/sgn-04 --mode cpu --throttle 1 --long 19 --seconds 20 --nodraw
 * Options: --warm S (seconds of play before the window, default 8), --seed N (cpu mode), --notrace (no CDP trace, so
 * no GC numbers: the trace's V8 categories cost main-thread time of their own), --timeline (main-thread ms per frame
 * by trace event and the input event dispatch times), --json out.json. In cpu mode the
 * benchmark hook's own result (the Copy Results statistics and its proxy verdict) is read after the window.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);

/** In-page recorder, one preallocated entry per animation frame while on (not itself measured). */
const RECORDER = `
(() => {
  const N = 200000;
  const q = {
    on: false, n: 0,
    t: new Float64Array(N), work: new Float32Array(N), render: new Float32Array(N), ticks: new Uint8Array(N),
    calls: new Uint16Array(N), tris: new Uint32Array(N), scale: new Float32Array(N), tier: new Uint8Array(N),
    phase: new Uint8Array(N), rk: new Uint8Array(N),
  };
  window.__sgn04 = q;
  const loop = (now) => {
    if (q.on && q.n < N) {
      const i = q.n++;
      q.t[i] = now;
      const fs = window.__dotkickFrameStats;
      if (fs) { q.work[i] = (fs.ticks > 0 ? fs.simMsLast * fs.ticks : 0) + fs.renderMsLast; q.render[i] = fs.renderMsLast; q.ticks[i] = fs.ticks; }
      const rs = window.__dotkickRendererStats ? window.__dotkickRendererStats() : null;
      if (rs) { q.calls[i] = rs.drawCalls; q.tris[i] = rs.triangles; q.scale[i] = rs.resolutionScale; q.tier[i] = rs.qualityTier; }
      const d = window.__dotkick, st = d && d.ctx.session.getState();
      q.phase[i] = st ? st.match.phase : 255;
      q.rk[i] = st ? st.match.restart.kind : 255;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
`;

const NODRAW = `
(() => {
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      if (C.prototype[m]) C.prototype[m] = function () {};
    }
  }
})();
`;

interface Rec { t: number[]; work: number[]; render: number[]; ticks: number[]; calls: number[]; tris: number[]; scale: number[]; tier: number[]; phase: number[]; rk: number[] }

const PHASES = ['pre', 'kickOff', 'inPlay', 'throwIn', 'goalKick', 'corner', 'freeKick', 'penalty', 'goal', 'celebration', 'replay', 'halfTime', 'fullTime', 'etBreak', 'shootOut', 'post'];
const r2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (s: number[], q: number): number => (s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!);

function summarize(w: Rec): Record<string, number | string> {
  const iv: number[] = [];
  for (let i = 1; i < w.t.length; i++) iv.push(w.t[i]! - w.t[i - 1]!);
  const ivs = iv.slice().sort((a, b) => a - b);
  const total = iv.reduce((a, b) => a + b, 0);
  // 1 % low: frames per second over the slowest 1 % of frame intervals (as benchHook's lowFps).
  const slow = ivs.slice(Math.max(0, ivs.length - Math.max(1, Math.round(ivs.length * 0.01))));
  const work = w.work.slice(1).sort((a, b) => a - b);
  const render = w.render.slice(1).sort((a, b) => a - b);
  const steps: string[] = [];
  for (let i = 1; i < w.scale.length; i++) if (w.scale[i] !== w.scale[i - 1] && steps.length < 40) steps.push(`${((w.t[i]! - w.t[0]!) / 1000).toFixed(1)}s:${w.scale[i]!.toFixed(2)}`);
  const seen = new Set<string>();
  for (let i = 0; i < w.phase.length; i++) seen.add(PHASES[w.phase[i]!] ?? String(w.phase[i]));
  return {
    frames: iv.length, seconds: r2(total / 1000), fps: r2((1000 * iv.length) / total),
    low1Fps: r2(1000 / (slow.reduce((a, b) => a + b, 0) / slow.length)),
    intervalP50: r2(pct(ivs, 0.5)), intervalP95: r2(pct(ivs, 0.95)), intervalP99: r2(pct(ivs, 0.99)), intervalMax: r2(ivs[ivs.length - 1] ?? NaN),
    over33: iv.filter((x) => x > 33.4).length, over50: iv.filter((x) => x > 50).length,
    workP50: r2(pct(work, 0.5)), workP95: r2(pct(work, 0.95)), workP99: r2(pct(work, 0.99)), workMax: r2(work[work.length - 1] ?? NaN),
    renderP50: r2(pct(render, 0.5)), renderP95: r2(pct(render, 0.95)), renderP99: r2(pct(render, 0.99)), renderMax: r2(render[render.length - 1] ?? NaN),
    ticksPerFrame: r2(w.ticks.reduce((a, b) => a + b, 0) / Math.max(1, w.ticks.length)),
    callsMax: Math.max(...w.calls), trisMax: Math.max(...w.tris),
    scaleMin: Math.min(...w.scale), scaleMax: Math.max(...w.scale), scaleSteps: steps.join(' '),
    tiers: [...new Set(w.tier)].join(','), phases: [...seen].join(','),
  };
}

type TraceEv = { name: string; ph: string; dur?: number; tid: number; ts: number; args?: { name?: string } };

function gcStats(events: TraceEv[]): Record<string, number> {
  let main: number | null = null;
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main = e.tid;
  let minor = 0, major = 0, minorMs = 0, majorMs = 0, maxMs = 0, over4 = 0;
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || (main !== null && e.tid !== main)) continue;
    const ms = e.dur / 1000;
    const isMinor = e.name === 'MinorGC' || e.name === 'V8.GCScavenger';
    const isMajor = e.name === 'MajorGC' || e.name === 'V8.GCFinalizeMC';
    if (!isMinor && !isMajor) continue;
    if (isMinor) { minor++; minorMs += ms; } else { major++; majorMs += ms; }
    if (ms > maxMs) maxMs = ms;
    if (ms > 4) over4++;
  }
  return { gcMinor: minor, gcMinorMs: r2(minorMs), gcMajor: major, gcMajorMs: r2(majorMs), gcMaxMs: r2(maxMs), gcOver4ms: over4 };
}

/**
 * Main-thread ms per frame by trace event name (nested events count in their parents too: RunTask holds everything,
 * EventDispatch an input event's handlers, FunctionCall a task's JS) and the longest input event dispatches.
 */
function mainThreadTime(events: TraceEv[], frames: number): Record<string, unknown> {
  let main: number | null = null;
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main = e.tid;
  const by = new Map<string, number>();
  const dispatch: number[] = [];
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || (main !== null && e.tid !== main)) continue;
    by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    if (e.name === 'EventDispatch') dispatch.push(e.dur / 1000);
  }
  dispatch.sort((a, b) => b - a);
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, r2(v / Math.max(1, frames))]);
  return { mainMsPerFrame: top, inputDispatches: dispatch.length, inputDispatchMaxMs: r2(dispatch[0] ?? 0), inputDispatchP95Ms: r2(pct(dispatch.slice().reverse(), 0.95)) };
}

async function startTrace(cdp: CDPSession): Promise<() => Promise<TraceEv[]>> {
  const events: TraceEv[] = [];
  cdp.on('Tracing.dataCollected', (d: { value: unknown[] }) => { for (const e of d.value) events.push(e as TraceEv); });
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc'] },
    transferMode: 'ReportEvents',
  } as never);
  return async () => {
    const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
    await cdp.send('Tracing.end');
    await done;
    return events;
  };
}

/** Heap after a full GC (MB). */
async function heapAfterGc(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const u = await cdp.send('Runtime.getHeapUsage') as { usedSize: number };
  return r2(u.usedSize / (1024 * 1024));
}

const MATCH_READY = `(() => { const d = window.__dotkick; return !!d && d.ctx.router.current === 'match' && !!d.app.session.loaded && d.ctx.session.getState() !== null; })()`;

/** Real CDP multi-touch: finger 1 on the stick, finger 2 on the cluster. */
class Fingers {
  private pts = new Map<number, { x: number; y: number }>();
  constructor(private readonly cdp: CDPSession) {}
  private list(): { id: number; x: number; y: number }[] { return [...this.pts.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })); }
  async down(id: number, x: number, y: number): Promise<void> { this.pts.set(id, { x, y }); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.list() }); }
  async move(id: number, x: number, y: number): Promise<void> { this.pts.set(id, { x, y }); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.list() }); }
  async up(id: number): Promise<void> { this.pts.delete(id); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: this.list() }); }
  async upAll(): Promise<void> { for (const id of [...this.pts.keys()]) await this.up(id); }
}

/** Human driver: runs until stop() resolves; returns counts of what it did. */
function driveHuman(page: Page, cdp: CDPSession, slots: { x: number; y: number }[]): { stop: () => Promise<Record<string, number>> } {
  const f = new Fingers(cdp);
  let on = true;
  const did = { moves: 0, taps: 0, holds: 0 };
  const sx = 250, sy = 560, R = 70; // stick origin (left half, clear of the bottom edge and the top-left corner)
  const run = (async (): Promise<void> => {
    await f.down(1, sx, sy);
    let a = 0, k = 0, held = false, holdUntil = 0, nextAct = Date.now() + 600;
    while (on) {
      a += 0.12;
      await f.move(1, sx + R * Math.cos(a), sy + R * 0.8 * Math.sin(a * 0.7));
      did.moves++;
      const now = Date.now();
      if (held && now >= holdUntil) { await f.up(2); held = false; }
      if (!held && now >= nextAct) {
        const s = slots[k++ % slots.length]!;
        if (k % slots.length === 0) { await f.down(2, s.x, s.y); held = true; holdUntil = now + 1200; did.holds++; } // BIG: hold = sprint
        else { await f.down(2, s.x, s.y); await page.waitForTimeout(60); await f.up(2); did.taps++; }
        nextAct = now + 1500;
      }
      await page.waitForTimeout(50);
    }
    await f.upAll();
  })();
  return { stop: async () => { on = false; await run; return did; } };
}

async function main(): Promise<void> {
  const mode = arg('mode', 'cpu');
  const seconds = Number(arg('seconds', '20'));
  const warm = Number(arg('warm', '8'));
  const longMin = Number(arg('long', '0'));
  const throttles = arg('throttle', '4').split(',').map(Number);
  const dist = resolve(ROOT, arg('dist', 'dist-e2e/sgn-04'));
  const s = await serveDir(dist);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const report: Record<string, unknown> = {};
  try {
    for (const rate of throttles) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
      await context.addInitScript(RECORDER);
      if (flag('nodraw')) await context.addInitScript(NODRAW);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const cdp = await context.newCDPSession(page);
      const t0 = Date.now();
      let driver: ReturnType<typeof driveHuman> | null = null;
      if (mode === 'cpu' && longMin <= 0) {
        // The hook's own window (5 s warm-up and 300 ticks, then benchSeconds of play) ends after ours: its result (the
        // Copy Results statistics: sim avg / p99 / worst, ticks over 4 ms) is read once our window is closed.
        const q = new URLSearchParams({ bench: '1', benchSeconds: String(warm + seconds), benchWarmup: '5' });
        if (arg('seed', '') !== '') q.set('benchSeed', arg('seed', ''));
        await page.goto(`${s.url}index.html?${q.toString()}`, { timeout: 180_000 });
        await page.waitForFunction(MATCH_READY, null, { timeout: 300_000, polling: 250 });
      } else {
        // Splash -> main menu -> Play now (P1 on touch v CPU), all by real touches.
        await page.goto(`${s.url}index.html`, { timeout: 180_000 });
        await page.waitForSelector('[data-testid="splash-start"]', { timeout: 120_000 });
        await page.touchscreen.tap(40, 410);
        await page.waitForFunction(`window.__dotkick && window.__dotkick.ctx.router.current === 'main'`, null, { timeout: 60_000 });
        const box = await page.getByTestId('main-kickoff').boundingBox();
        await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.waitForFunction(MATCH_READY, null, { timeout: 300_000, polling: 250 });
        if (longMin > 0) {
          // CPU v CPU, 10-minute halves; fast-forward longMin minutes of match time through the real loop (rendered).
          await page.evaluate(`(() => {
            const d = window.__dotkick, setup = d.ctx.session.getSetup();
            d.ctx.session.quit();
            const humans = setup.config.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
            d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, seed: 20261023, halfMinutes: 10, humans } });
          })()`);
          await page.waitForFunction(MATCH_READY, null, { timeout: 300_000, polling: 250 });
          const ff = await page.evaluate(`(() => {
            const d = window.__dotkick, target = ${longMin} * 3600, t0 = performance.now();
            d.app.loop.stop();
            let now = performance.now(), frames = 0;
            const st = () => d.ctx.session.getState();
            let lastTick = -1, still = 0, stalled = 0;
            while (st() && st().tick < target && frames < 400000) {
              now += 1000 / 30; d.app.loop.frame(now); frames++;
              const tk = st() ? st().tick : -1;
              if (tk === lastTick) { if (++still > 900) { stalled = 1; break; } } else { still = 0; lastTick = tk; }
            }
            d.app.loop.start();
            const s = st();
            return { frames, stalled, tick: s ? s.tick : -1, phase: s ? s.match.phase : -1, period: s ? s.match.period : -1, score: s ? s.teams[0].goals + '-' + s.teams[1].goals : '', ms: Math.round(performance.now() - t0) };
          })()`);
          console.error('fast-forward', JSON.stringify(ff));
          report[`x${rate}-fastForward`] = ff;
        }
      }
      const loadMs = Date.now() - t0;
      if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      if (mode === 'human') {
        const slots = await page.evaluate(`(() => [1, 2, 3, 0].map((n) => {
          const el = document.querySelector('.dk-tbtn[data-slot="' + n + '"]');
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }))()`) as { x: number; y: number }[];
        driver = driveHuman(page, cdp, slots);
      }
      await page.waitForTimeout(warm * 1000);
      const heap0 = await heapAfterGc(cdp);
      await page.evaluate('window.__sgn04.on = true');
      // --notrace: no CDP trace (no GC numbers); the trace's V8 categories cost main-thread time of their own.
      const stopTrace = flag('notrace') ? null : await startTrace(cdp);
      await page.waitForTimeout(seconds * 1000);
      await page.evaluate('window.__sgn04.on = false');
      const events = stopTrace ? await stopTrace() : [];
      const did = driver ? await driver.stop() : null;
      const heap1 = await heapAfterGc(cdp);
      const w = await page.evaluate(`(() => {
        const q = window.__sgn04, n = q.n, a = (k) => Array.from(q[k].slice(0, n));
        return { t: a('t'), work: a('work'), render: a('render'), ticks: a('ticks'), calls: a('calls'), tris: a('tris'), scale: a('scale'), tier: a('tier'), phase: a('phase'), rk: a('rk') };
      })()`) as Rec;
      let bench: Record<string, unknown> | null = null;
      if (mode === 'cpu' && longMin <= 0) {
        await page.waitForFunction('window.__benchResult !== undefined', null, { timeout: 300_000, polling: 500 });
        const b = await page.evaluate('window.__benchResult') as Record<string, number | string | null>;
        bench = { seconds: b.seconds, frames: b.frames, avgFps: b.avgFps, low1Fps: b.low1Fps, longestFrameMs: b.longestFrameMs, simMsAvg: b.simMsAvg,
          simMsP99: b.simMsP99, simMsMax: b.simMsMax, simFramesOverBudget: b.simFramesOverBudget, ticks: b.ticks, renderMsAvg: b.renderMsAvg,
          drawCallsMax: b.drawCallsMax, trianglesMax: b.trianglesMax, proxyPass: b.proxyPass, error: b.error ?? null };
      }
      // --tight N: after the window, N sim ticks back to back through the real loop (loop.frame at 60 Hz steps, no idle
      // time between frames): once with the renderer stubbed (sim alone, hot caches, as the Node tick probe runs) and
      // once rendering every frame; step() time per tick from the loop's own stats. Separates the sim's cost from the
      // effect of running it once per 16.7 ms frame between idle gaps (cold caches, clock ramp) in real play.
      const tightN = Number(arg('tight', '0'));
      const tight = tightN > 0 ? await page.evaluate(`(() => {
        const d = window.__dotkick, fs = window.__dotkickFrameStats, r = d.app.renderer, orig = r.render, out = {};
        d.app.loop.stop();
        let now = performance.now();
        for (const mode of ['simOnly', 'withRender']) {
          if (mode === 'simOnly') r.render = () => {}; else r.render = orig;
          fs.reset();
          const t0 = performance.now();
          let g = 0;
          while (fs.sampleTicks < ${tightN} && g++ < ${tightN} * 4) { now += 1000 / 60; d.app.loop.frame(now); }
          out[mode] = { ticks: fs.sampleTicks, simMsAvg: +fs.simMsAvg.toFixed(3), simMsMax: +fs.simMsMax.toFixed(2), renderMsAvg: +fs.renderMsAvg.toFixed(3), wallMs: Math.round(performance.now() - t0) };
        }
        r.render = orig;
        d.app.loop.start();
        return out;
      })()`) : null;
      const human = mode === 'human' ? await page.evaluate(`(() => { const s = window.__dotkick.ctx.session.getState(); return { ctrlSlot: s.ctrl[0].slot, score: s.teams[0].goals + '-' + s.teams[1].goals, tick: s.tick }; })()`) : null;
      const res = { mode, throttle: rate, nodraw: flag('nodraw'), loadMs, ...summarize(w), ...(stopTrace ? gcStats(events) : {}), ...(stopTrace && flag('timeline') ? mainThreadTime(events, w.t.length) : {}), heapStartMB: heap0, heapEndMB: heap1, heapGrowthMB: r2(heap1 - heap0), ...(did ? { input: did, human } : {}), ...(bench ? { bench } : {}), ...(tight ? { tight } : {}), errors: errors.slice(0, 5) };
      report[`x${rate}`] = res;
      console.log(JSON.stringify(res));
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
  const out = arg('json', '');
  if (out !== '') writeFileSync(resolve(ROOT, out), JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });

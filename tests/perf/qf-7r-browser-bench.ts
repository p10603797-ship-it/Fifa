/**
 * [QF-7R] Live-match measurement in Chromium (BRIEF section 13 "Proving it"; QA-38): the real app at iPad size runs a
 * CPU v CPU bench match (?bench=1, fixed seed) under CDP CPU throttling and reports, per throttle rate:
 *  - frame intervals (rAF) p50 / p95 / p99 / max, frames over 33 ms and 50 ms;
 *  - main-thread work per frame (the loop's sim + render + HUD time: window.__dotkickFrameStats) p50 / p95 / p99 / max;
 *  - garbage-collection pauses from a CDP trace (count, total, longest; minor and major);
 *  - draw calls and triangles (max), resolution scale and quality tier over time (dynamic resolution steps);
 *  - with --alloc: V8 sampling heap profile of the window attributed to source areas (needs --dev: the Vite dev server
 *    serves each module under its own URL; the single-file build has one script).
 * Software WebGL (SwiftShader) makes the GPU side slow here: frame intervals are GPU-bound and only comparable run to
 * run; main-thread work, GC and allocation are what this container measures well. The iPad numbers come from the
 * device benchmark (?bench=1 on the iPad).
 *
 *   npx vite build --outDir dist-e2e/qf-7r --emptyOutDir
 *   npx tsx tests/perf/qf-7r-browser-bench.ts --dist dist-e2e/qf-7r --throttle 1,4,6 --seconds 20 [--json out.json]
 *   npx tsx tests/perf/qf-7r-browser-bench.ts --dev --alloc --throttle 1 --seconds 20
 * Options: --dpr N (default 1), --warm S (seconds of play before measuring, default 8), --seed N, --scale-test (6x
 * throttling for --seconds, then 1x: the resolution steps down and back up), --first S (measure the first S seconds
 * after the match is shown instead of steady play: warm-up hitches), --cpu (CDP CPU profile: self time by area and
 * function), --lines <regex> (with --cpu: samples per source line of the functions matching file:function), --timeline
 * (main-thread ms per frame by trace event: script, style, layout, paint, GPU tasks), --events (a goal with its
 * celebration and replay, then half time, forced into the measured window: frame stats around each phase change).
 */
import { createServer as createHttp, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { serveDir } from '../../tools/bench';

interface Args { [k: string]: string | boolean }
function parse(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = parse(process.argv.slice(2));
const num = (k: string, d: number): number => (typeof args[k] === 'string' ? Number(args[k]) : d);

/** In-page recorder: one entry per animation frame while on (preallocated; the recorder itself is not measured). */
const RECORDER = `
(() => {
  const N = 200000;
  const q = {
    on: false, n: 0,
    t: new Float64Array(N), work: new Float32Array(N), sim: new Float32Array(N), render: new Float32Array(N), ticks: new Uint8Array(N),
    calls: new Uint16Array(N), tris: new Uint32Array(N), scale: new Float32Array(N), tier: new Uint8Array(N),
    phase: new Uint8Array(N),
  };
  window.__qf7r = q;
  const loop = (now) => {
    if (q.on && q.n < N) {
      const i = q.n++;
      q.t[i] = now;
      const fs = window.__dotkickFrameStats;
      if (fs) { q.work[i] = (fs.ticks > 0 ? fs.simMsLast * fs.ticks : 0) + fs.renderMsLast; q.sim[i] = fs.ticks > 0 ? fs.simMsLast : 0; q.render[i] = fs.renderMsLast; q.ticks[i] = fs.ticks; }
      const rs = window.__dotkickRendererStats ? window.__dotkickRendererStats() : null;
      if (rs) { q.calls[i] = rs.drawCalls; q.tris[i] = rs.triangles; q.scale[i] = rs.resolutionScale; q.tier[i] = rs.qualityTier; }
      const d = window.__dotkick, st = d && d.ctx.session.getState();
      q.phase[i] = st ? st.match.phase : 255;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
`;

/**
 * --nodraw: WebGL draw calls become no-ops (three.js still does all its JS work: state, uniforms, buffer uploads, the
 * draw-call count). Software WebGL rasterises a frame in ~200 ms here, which hides the main thread entirely; without the
 * raster the frame interval is the main thread's (sim, render modules, three.js submission, HUD, audio, input).
 */
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

interface Window { t: number[]; work: number[]; render: number[]; ticks: number[]; calls: number[]; tris: number[]; scale: number[]; tier: number[]; phase: number[] }

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function summarize(w: Window): Record<string, number | string> {
  const iv: number[] = [];
  for (let i = 1; i < w.t.length; i++) iv.push(w.t[i]! - w.t[i - 1]!);
  const ivs = iv.slice().sort((a, b) => a - b);
  const work = w.work.slice(1).sort((a, b) => a - b);
  const render = w.render.slice(1).sort((a, b) => a - b);
  let scaleChanges = 0;
  const steps: string[] = [];
  for (let i = 1; i < w.scale.length; i++) {
    if (w.scale[i] !== w.scale[i - 1]) { scaleChanges++; if (steps.length < 40) steps.push(`${((w.t[i]! - w.t[0]!) / 1000).toFixed(1)}s:${w.scale[i]!.toFixed(2)}`); }
  }
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  return {
    frames: iv.length,
    seconds: r2((w.t[w.t.length - 1]! - w.t[0]!) / 1000),
    fps: r2(iv.length / ((w.t[w.t.length - 1]! - w.t[0]!) / 1000)),
    intervalP50: r2(pct(ivs, 0.5)), intervalP95: r2(pct(ivs, 0.95)), intervalP99: r2(pct(ivs, 0.99)), intervalMax: r2(ivs[ivs.length - 1] ?? NaN),
    over33: iv.filter((x) => x > 33.4).length, over50: iv.filter((x) => x > 50).length,
    workP50: r2(pct(work, 0.5)), workP95: r2(pct(work, 0.95)), workP99: r2(pct(work, 0.99)), workMax: r2(work[work.length - 1] ?? NaN),
    // Renderer + HUD only (the loop's render stage: render modules, three.js submission, HUD), without the sim.
    renderP50: r2(pct(render, 0.5)), renderP95: r2(pct(render, 0.95)), renderP99: r2(pct(render, 0.99)), renderMax: r2(render[render.length - 1] ?? NaN),
    ticksPerFrame: r2(w.ticks.reduce((a, b) => a + b, 0) / Math.max(1, w.ticks.length)),
    callsMax: Math.max(...w.calls), trisMax: Math.max(...w.tris),
    scaleMin: Math.min(...w.scale), scaleMax: Math.max(...w.scale), scaleChanges, scaleSteps: steps.join(' '),
    tiers: [...new Set(w.tier)].join(','),
  };
}

/** Phases named in transition reports. */
const PHASE_NAMES: Record<number, string> = { 1: 'kickOff', 2: 'inPlay', 8: 'goal', 9: 'celebration', 10: 'replay', 11: 'halfTime' };

/**
 * --events: the frames around each phase change into a goal, celebration, replay, half time and the kick-off after
 * them (from 2 frames before to 30 frames after the change): longest frame interval, loop work and render stage.
 * Warm-up hitches show here (BRIEF section 13 "The first slide tackle or replay in a match must not hitch").
 */
function transitions(w: Window): Record<string, number | string>[] {
  const out: Record<string, number | string>[] = [];
  for (let i = 1; i < w.phase.length; i++) {
    const p = w.phase[i]!;
    if (p === w.phase[i - 1] || PHASE_NAMES[p] === undefined || p === 2) continue;
    let iv = 0, work = 0, render = 0;
    for (let k = Math.max(1, i - 2); k < Math.min(w.t.length, i + 30); k++) {
      iv = Math.max(iv, w.t[k]! - w.t[k - 1]!);
      work = Math.max(work, w.work[k]!);
      render = Math.max(render, w.render[k]!);
    }
    const r2 = (x: number): number => Math.round(x * 10) / 10;
    out.push({ at: r2((w.t[i]! - w.t[0]!) / 1000), into: PHASE_NAMES[p]!, maxIntervalMs: r2(iv), maxWorkMs: r2(work), maxRenderMs: r2(render) });
  }
  return out;
}

/**
 * --events: the longest main-thread tasks of the window, each with the trace events inside it summed by name (what a
 * hitch is made of: script, style recalculation, layout, paint, image decode, stylesheet parse...).
 */
function longTasks(events: { name: string; ph: string; dur?: number; tid: number; ts: number; args?: { data?: { functionName?: string; url?: string } } }[], mainTid: number | null): Record<string, unknown>[] {
  const main = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && (mainTid === null || e.tid === mainTid));
  const tasks = main.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur! - a.dur!).slice(0, 4);
  return tasks.map((t) => {
    const by: Record<string, number> = {};
    for (const e of main) {
      if (e === t || e.ts < t.ts || e.ts + e.dur! > t.ts + t.dur!) continue;
      let k = e.name;
      if (e.name === 'FunctionCall' || e.name === 'EventDispatch') { const d = e.args?.data; if (d?.functionName) k += ':' + d.functionName; }
      by[k] = (by[k] ?? 0) + e.dur! / 1000;
    }
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, Math.round(v * 10) / 10]);
    // With --cpu: the sampled functions (self time) inside the task.
    const fns: Record<string, number> = {};
    for (const smp of cpuSamples) if (smp.t >= t.ts && smp.t <= t.ts + t.dur!) fns[smp.fn] = (fns[smp.fn] ?? 0) + 1;
    const js = Object.entries(fns).sort((a, b) => b[1] - a[1]).slice(0, 16);
    return { ms: Math.round(t.dur! / 100) / 10, at: t.ts, top, ...(js.length > 0 ? { jsSamples: js } : {}) };
  });
}

/** In-page: put the ball into a net (a goal for team 0, as tests/e2e/qf-7r-hud.spec.ts does) or end the half. */
const POKE_GOAL = `(() => {
  const s = window.__dotkick.ctx.session.getState(), b = s.ball, e = s.teams[0].dir > 0 ? 1 : -1;
  b.owner = -1; b.heldBy = -1; b.x = e * 52.4; b.z = 2.6; b.y = 0.3; b.vx = e * 20; b.vy = 0; b.vz = 0;
  b.px = b.x; b.py = b.y; b.pz = b.z; b.grounded = 1; b.shotBy = -1; b.passTarget = -1;
  b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickTeam = 0; b.lastKickBy = 9;
})()`;
const POKE_HALF = `(() => { const m = window.__dotkick.ctx.session.getState().match; m.addedT = 0; m.periodT = m.periodLen; })()`;

/** GC pauses on the renderer main thread from trace events. */
function gcStats(events: { name: string; ph: string; dur?: number; tid: number; pid: number; ts: number; args?: unknown }[], mainTid: number | null): Record<string, number> {
  let minor = 0, major = 0, minorMs = 0, majorMs = 0, maxMs = 0;
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (mainTid !== null && e.tid !== mainTid) continue;
    const ms = e.dur / 1000;
    if (e.name === 'MinorGC' || e.name === 'V8.GCScavenger') { minor++; minorMs += ms; if (ms > maxMs) maxMs = ms; }
    else if (e.name === 'MajorGC' || e.name === 'V8.GCFinalizeMC') { major++; majorMs += ms; if (ms > maxMs) maxMs = ms; }
  }
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  return { gcMinor: minor, gcMinorMs: r2(minorMs), gcMajor: major, gcMajorMs: r2(majorMs), gcMaxMs: r2(maxMs) };
}

async function readWindow(page: Page): Promise<Window> {
  // Strings, not functions: tsx's helpers (__name) do not exist in the page.
  return page.evaluate(`(() => {
    const q = window.__qf7r, n = q.n;
    const a = (k) => Array.from(q[k].slice(0, n));
    return { t: a('t'), work: a('work'), render: a('render'), ticks: a('ticks'), calls: a('calls'), tris: a('tris'), scale: a('scale'), tier: a('tier'), phase: a('phase') };
  })()`) as Promise<Window>;
}

async function startTrace(cdp: CDPSession): Promise<() => Promise<{ events: unknown[] }>> {
  const events: unknown[] = [];
  cdp.on('Tracing.dataCollected', (d: { value: unknown[] }) => { for (const e of d.value) events.push(e); });
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'disabled-by-default-devtools.timeline'] },
    transferMode: 'ReportEvents',
  } as never);
  return async () => {
    const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
    await cdp.send('Tracing.end');
    await done;
    return { events };
  };
}

/**
 * Main-thread time by trace event name (complete events; nested events are counted in their parents too: RunTask holds
 * everything, FunctionCall the JS of a task, UpdateLayoutTree / Layout / Paint / PrePaint the DOM rendering steps).
 */
function mainThreadTime(events: { name: string; ph: string; dur?: number; tid: number }[], mainTid: number | null, frames: number): [string, number][] {
  const by = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || (mainTid !== null && e.tid !== mainTid)) continue;
    by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => [k, Math.round((v / Math.max(1, frames)) * 100) / 100]);
}

function mainThread(events: { name: string; ph: string; tid: number; pid: number; args?: { name?: string } }[]): number | null {
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') return e.tid;
  return null;
}

async function allocProfile(cdp: CDPSession): Promise<() => Promise<Record<string, number>>> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as never);
  return async () => {
    const { profile } = await cdp.send('HeapProfiler.stopSampling') as unknown as { profile: { head: Node } };
    type Node = { callFrame: { url: string; functionName: string; lineNumber: number }; selfSize: number; children: Node[] };
    const by: Record<string, number> = {};
    const walk = (nd: Node): void => {
      if (nd.selfSize > 0) {
        const u = nd.callFrame.url;
        const m = /\/src\/([a-z]+)\/(.*)\.ts/.exec(u);
        const area = m ? m[1]! : /three/.test(u) ? 'three' : u === '' ? '(native)' : 'other';
        by[area] = (by[area] ?? 0) + nd.selfSize;
        if ((m && ['render', 'ui', 'audio', 'input', 'app', 'platform'].includes(m[1]!)) || (!m && area === 'three')) {
          const k = m ? `${m[1]}/${m[2]}:${nd.callFrame.functionName}` : `three:${nd.callFrame.functionName}`;
          by['@' + k] = (by['@' + k] ?? 0) + nd.selfSize;
        }
      }
      for (const c of nd.children) walk(c);
    };
    walk(profile.head);
    return by;
  };
}

/** CPU profile of the window: self time per source area and the top functions of the presentation areas. */
/** --events with --cpu: the profile's samples as (time in trace clock, function) for the long-task breakdown. */
let cpuSamples: { t: number; fn: string }[] = [];

async function cpuProfile(cdp: CDPSession): Promise<() => Promise<{ areas: Record<string, number>; top: [string, number][]; totalMs: number }>> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  return async () => {
    type PNode = {
      id: number; callFrame: { url: string; functionName: string; lineNumber: number }; hitCount?: number; children?: number[];
      positionTicks?: { line: number; ticks: number }[];
    };
    const { profile } = await cdp.send('Profiler.stop') as unknown as { profile: { nodes: PNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] } };
    const self = new Map<number, number>();
    for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i]!, (self.get(profile.samples[i]!) ?? 0) + (profile.timeDeltas[i] ?? 0));
    const byId = new Map<number, PNode>();
    for (const nd of profile.nodes) byId.set(nd.id, nd);
    cpuSamples = [];
    let tUs = profile.startTime;
    for (let i = 0; i < profile.samples.length; i++) {
      tUs += profile.timeDeltas[i] ?? 0;
      const nd = byId.get(profile.samples[i]!);
      if (!nd) continue;
      const u = nd.callFrame.url;
      cpuSamples.push({ t: tUs, fn: u.slice(u.lastIndexOf('/') + 1).replace(/\?.*$/, '') + ':' + nd.callFrame.functionName });
    }
    const areas: Record<string, number> = {};
    const fns: Record<string, number> = {};
    for (const nd of profile.nodes) {
      const us = self.get(nd.id) ?? 0;
      if (us === 0) continue;
      const u = nd.callFrame.url;
      const m = /\/src\/([a-z]+)\/(.*)\.ts/.exec(u);
      const area = m ? m[1]! : /three/.test(u) ? 'three' : nd.callFrame.functionName === '(idle)' ? '(idle)' : nd.callFrame.functionName === '(garbage collector)' ? '(gc)' : u === '' ? '(native)' : 'other';
      areas[area] = (areas[area] ?? 0) + us / 1000;
      const k = (m ? `${m[1]}/${m[2]}` : area) + ':' + nd.callFrame.functionName;
      fns[k] = (fns[k] ?? 0) + us / 1000;
    }
    // --lines <regex>: sample counts per source line of the matching functions (where inside a hot function the time goes).
    if (typeof args.lines === 'string') {
      const re = new RegExp(args.lines);
      const lines: Record<string, number> = {};
      for (const nd of profile.nodes) {
        const u = nd.callFrame.url;
        const k = u.slice(u.lastIndexOf('/') + 1) + ':' + nd.callFrame.functionName;
        if (!re.test(k)) continue;
        for (const pt of nd.positionTicks ?? []) lines[`${k}@${pt.line}`] = (lines[`${k}@${pt.line}`] ?? 0) + pt.ticks;
      }
      console.error('lines', JSON.stringify(Object.entries(lines).sort((x, y) => y[1] - x[1]).slice(0, 30)));
    }
    // V8's reason a sampled function is not optimised (ProfileNode.deoptReason), for the presentation areas.
    const deopts: Record<string, string> = {};
    for (const nd of profile.nodes as (PNode & { deoptReason?: string })[]) {
      const m = /\/src\/(render|ui|audio|input|app|platform)\/(.*)\.ts/.exec(nd.callFrame.url);
      if (m && nd.deoptReason) deopts[`${m[1]}/${m[2]}:${nd.callFrame.functionName}`] = nd.deoptReason;
    }
    if (Object.keys(deopts).length > 0) console.error('deopts', JSON.stringify(deopts));
    const top = Object.entries(fns).filter(([k]) => /^(render|ui|audio|input|app|platform|three|\(native\))/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([k, v]) => [k, Math.round(v)] as [string, number]);
    for (const k of Object.keys(areas)) areas[k] = Math.round(areas[k]!);
    return { areas, top, totalMs: Math.round((profile.endTime - profile.startTime) / 1000) };
  };
}

async function main(): Promise<void> {
  const seconds = num('seconds', 20);
  const warm = num('warm', 8);
  const dpr = num('dpr', 1);
  const throttles = String(args.throttle ?? '4').split(',').map(Number);
  let url: string;
  let close: () => Promise<void>;
  if (args.dev) {
    const { createServer } = await import('vite');
    const alias = typeof args.three === 'string' ? { resolve: { alias: { three: resolve(String(args.three)) } } } : {};
    const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, fs: { strict: false } }, ...alias });
    await server.listen();
    url = server.resolvedUrls!.local[0]!;
    close = () => server.close();
  } else {
    const dist = resolve(ROOT, String(args.dist ?? 'dist-e2e/qf-7r'));
    const s: { server: Server; url: string } = await serveDir(dist);
    url = s.url + 'index.html';
    close = () => new Promise<void>((r) => s.server.close(() => r()));
  }
  void createHttp;
  const launchArgs = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
  if (typeof args['js-flags'] === 'string') launchArgs.push(`--js-flags=${args['js-flags']}`);
  const browser = await chromium.launch({ args: launchArgs });
  const report: Record<string, unknown> = {};
  try {
    for (const rate of throttles) {
      const context = await browser.newContext({ viewport: { width: num('width', 1180), height: num('height', 820) }, deviceScaleFactor: dpr, hasTouch: true });
      await context.addInitScript(RECORDER);
      if (args.nodraw) await context.addInitScript(NODRAW);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const cdp = await context.newCDPSession(page);
      const q = new URLSearchParams({ bench: '1', benchSeconds: '3600', benchWarmup: '0' });
      if (typeof args.seed === 'string') q.set('benchSeed', args.seed);
      await page.goto(`${url}${url.includes('?') ? '&' : '?'}${q.toString()}`, { timeout: 180_000 });
      if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const tLoad = Date.now();
      await page.waitForFunction(`(() => { const d = window.__dotkick; return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null; })()`,
        null, { timeout: 600_000, polling: 250 });
      const loadMs = Date.now() - tLoad;
      const first = num('first', 0);
      if (first <= 0) await page.waitForTimeout(warm * 1000);
      await page.evaluate('window.__qf7r.on = true');
      const stopTrace = await startTrace(cdp);
      const stopAlloc = args.alloc ? await allocProfile(cdp) : null;
      const stopCpu = args.cpu ? await cpuProfile(cdp) : null;
      const scaleTest = !!args['scale-test'];
      if (args.events) {
        // A goal (celebration, replay, kick-off), then half time (and the second-half kick-off), in the measured window.
        const inPlay = `(() => { const s = window.__dotkick.ctx.session.getState(); return !!s && s.match.phase === 2; })()`;
        await page.waitForTimeout(2000);
        await page.waitForFunction(inPlay, null, { timeout: 120_000, polling: 50 });
        await page.evaluate(POKE_GOAL);
        await page.waitForTimeout(3000);
        console.error('events: phase 3 s after the goal poke', await page.evaluate('window.__dotkick.ctx.session.getState().match.phase'));
        await page.waitForFunction(inPlay, null, { timeout: 180_000, polling: 100 });
        await page.waitForTimeout(2000);
        await page.evaluate(POKE_HALF);
        await page.waitForTimeout(3000);
        await page.waitForFunction(inPlay, null, { timeout: 180_000, polling: 100 });
        await page.waitForTimeout(2000);
      } else await page.waitForTimeout((first > 0 ? first : seconds) * 1000);
      if (scaleTest) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await page.waitForTimeout(seconds * 1000);
      }
      const alloc = stopAlloc ? await stopAlloc() : null;
      const cpu = stopCpu ? await stopCpu() : null;
      await page.evaluate('window.__qf7r.on = false');
      const { events } = await stopTrace();
      const ev = events as { name: string; ph: string; dur?: number; tid: number; pid: number; ts: number; args?: { name?: string } }[];
      const w = await readWindow(page);
      const sum = summarize(w);
      const gc = gcStats(ev, mainThread(ev));
      const res: Record<string, unknown> = { throttle: rate, loadMs, ...sum, ...gc, errors: errors.slice(0, 5) };
      if (args.events) res.transitions = transitions(w);
      if (args.events || first > 0) res.longTasks = longTasks(ev as never, mainThread(ev));
      // ms per frame on the main thread by trace event (what the frame interval is made of besides the loop's work).
      if (args.timeline) res.mainMsPerFrame = mainThreadTime(ev, mainThread(ev), Number(sum.frames) || 1);
      if (alloc) {
        const frames = Number(sum.frames) || 1;
        const areas: Record<string, number> = {};
        const sites: [string, number][] = [];
        for (const [k, v] of Object.entries(alloc)) {
          if (k.startsWith('@')) sites.push([k.slice(1), Math.round((v / frames) * 10) / 10]);
          else areas[k] = Math.round((v / frames) * 10) / 10;
        }
        res.allocBytesPerFrame = areas;
        res.allocTopSites = sites.sort((a, b) => b[1] - a[1]).slice(0, 25);
      }
      if (cpu) res.cpuMs = cpu;
      if (args.three) res.threeDiag = await page.evaluate('globalThis.__threeDiag || null');
      report[`x${rate}`] = res;
      console.log(JSON.stringify(res));
      await context.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  if (typeof args.json === 'string') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(ROOT, args.json), JSON.stringify(report, null, 2));
  }
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });

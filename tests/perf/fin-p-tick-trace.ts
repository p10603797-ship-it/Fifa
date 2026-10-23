/**
 * [FIN-P] Where do the slow ticks of the throttled proxy gate come from? (diagnostic, not a test). Opens the production
 * build at ?bench=1 exactly as tools/bench.ts does (headless Chromium, 1180 x 820 at DPR 2, touch, CDP CPU throttling),
 * and records every sim tick of the measured window: tick number, step() ms (the loop's own clock() pair, read through
 * a setter on window.__dotkickFrameStats.simMsLast), its end time and match phase. With --trace it also records a CDP
 * trace and attributes garbage collections (minor / major) and V8 compile / deopt work of the main thread to the ticks
 * they overlap; with --cpu a sampling CPU profile (100 us) whose samples inside slow ticks are summed per function.
 *
 *   npx tsx tests/perf/fin-p-tick-trace.ts --dist dist-e2e/fin-p [--throttle 4] [--seconds 40] [--seed N] [--trace]
 *                                          [--cpu] [--over 4] [--json out.json] [--nodraw]
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);

const RECORDER = `
(() => {
  const N = 200000;
  const q = { on: false, n: 0, heap: new Float64Array(N), bx: new Float64Array(N), tick: new Int32Array(N), ms: new Float64Array(N), end: new Float64Array(N), phase: new Uint8Array(N), frame: new Int32Array(N) };
  window.__finp = q;
  let hooked = false;
  const hook = () => {
    const fs = window.__dotkickFrameStats;
    if (fs && !hooked) {
      hooked = true;
      let v = fs.simMsLast;
      Object.defineProperty(fs, 'simMsLast', {
        configurable: true,
        get() { return v; },
        set(x) {
          v = x;
          if (q.on && q.n < N) {
            const i = q.n++;
            q.ms[i] = x; q.end[i] = performance.now(); q.heap[i] = performance.memory ? performance.memory.usedJSHeapSize : 0;
            const d = window.__dotkick, st = d && d.ctx.session.getState();
            q.tick[i] = st ? st.tick : -1; q.bx[i] = st ? st.ball.x : 0; q.phase[i] = st ? st.match.phase : 255; q.frame[i] = fs.frame;
          }
        },
      });
    }
    if (!hooked) setTimeout(hook, 50);
  };
  hook();
})();
`;

/** --calib N: a fixed synthetic workload (N iterations of float arithmetic over a 64 KB array) timed 3 times per frame,
 *  beside the game, so the environment's own noise (throttling, preemption) can be told from the sim's. */
const CALIB = (iters: number): string => `
(() => {
  const N = 200000, q = { on: false, n: 0, ms: new Float64Array(N) }, buf = new Float64Array(8192);
  window.__finpCal = q;
  const work = () => { let a = 0; for (let i = 0; i < ${iters}; i++) { const k = (i * 7) & 8191; buf[k] = buf[k] * 0.5 + i * 1e-3; a += buf[k]; } return a; };
  let sink = 0;
  const loop = () => {
    if (q.on) for (let r = 0; r < 3 && q.n < N; r++) { const t0 = performance.now(); sink += work(); q.ms[q.n++] = performance.now() - t0; }
    if (sink === 12345.678) console.log(sink);
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

type TraceEv = { name: string; ph: string; dur?: number; tid: number; pid: number; ts: number; args?: { name?: string; data?: { message?: string }; [k: string]: unknown } };
interface HeapNode { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: HeapNode[] }
interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; }
interface CpuProfile { nodes: CpuNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

const r2 = (x: number): number => Math.round(x * 100) / 100;

async function main(): Promise<void> {
  const throttle = Number(arg('throttle', '4'));
  const seconds = Number(arg('seconds', '40'));
  const over = Number(arg('over', '4'));
  const dist = resolve(ROOT, arg('dist', 'dist-e2e/fin-p'));
  const s = await serveDir(dist);
  const jsFlags = arg('jsflags', '');
  const launchArgs = ['--enable-precise-memory-info'];
  const extra = arg('chromeArgs', '');
  if (extra) launchArgs.push(...extra.split('|'));
  if (jsFlags) launchArgs.push(`--js-flags=${jsFlags}`, '--no-sandbox', '--no-zygote');
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  try {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
    await context.addInitScript(RECORDER);
    if (flag('nodraw')) await context.addInitScript(NODRAW);
    const calib = Number(arg('calib', '0'));
    if (calib > 0) await context.addInitScript(CALIB(calib));
    const page = await context.newPage();
    const cdp: CDPSession = await context.newCDPSession(page);
    const warm1x = Number(arg('warm1x', '0'));
    if (throttle > 1 && warm1x <= 0) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const q = new URLSearchParams({ bench: '1', benchSeconds: String(seconds + warm1x) });
    if (arg('seed', '') !== '') q.set('benchSeed', arg('seed', ''));
    await page.goto(`${s.url}index.html?${q.toString()}`, { timeout: 180_000 });
    // Same window as the hook: from its measurement start (5 s warm-up and 300 ticks) to __benchResult.
    await page.waitForFunction(`(() => { const d = window.__dotkick, st = d && d.ctx.session.getState(); return !!st && st.tick >= 300; })()`, null, { timeout: 300_000, polling: 100 });
    if (warm1x > 0) {
      // --warm1x S: S seconds of play unthrottled first (the JIT tiers up), then throttle and measure (the hook's own
      // result then mixes both; only this probe's window is throttled-only).
      await page.waitForTimeout(warm1x * 1000);
      if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      await page.waitForTimeout(2000);
    }
    const events: TraceEv[] = [];
    if (flag('trace')) {
      cdp.on('Tracing.dataCollected', (d: { value: unknown[] }) => { for (const e of d.value) events.push(e as TraceEv); });
      await cdp.send('Tracing.start', {
        traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile'] },
        transferMode: 'ReportEvents',
      } as never);
    }
    if (flag('cpu')) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
      await cdp.send('Profiler.start');
    }
    if (flag('alloc')) {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as never);
    }
    const cal0 = await page.evaluate(`(() => { const t = performance.now(); console.timeStamp('finp-cal'); return t; })()`) as number;
    await page.evaluate('window.__finp.on = true');
    if (calib > 0) await page.evaluate('window.__finpCal.on = true');
    await page.waitForFunction('window.__benchResult !== undefined', null, { timeout: (seconds + 400) * 1000, polling: 1000 });
    await page.evaluate('window.__finp.on = false');
    let cal: number[] = [];
    if (calib > 0) cal = await page.evaluate('(() => { const q = window.__finpCal; q.on = false; return Array.from(q.ms.slice(0, q.n)); })()') as number[];
    let heapTop: [string, number][] | null = null;
    if (flag('alloc')) {
      // --alloc: sampled allocation of the window by function (self bytes), and the ticks it spanned.
      const hp = (await cdp.send('HeapProfiler.stopSampling')) as { profile: { head: HeapNode } };
      const by = new Map<string, number>();
      const walk = (nd: HeapNode): void => {
        const k = `${nd.callFrame.functionName || '(anon)'}:${nd.callFrame.lineNumber}`;
        by.set(k, (by.get(k) ?? 0) + nd.selfSize);
        for (const c of nd.children) walk(c);
      };
      walk(hp.profile.head);
      heapTop = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    }
    let profile: CpuProfile | null = null;
    if (flag('cpu')) profile = ((await cdp.send('Profiler.stop')) as { profile: CpuProfile }).profile;
    if (flag('trace')) {
      const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
      await cdp.send('Tracing.end');
      await done;
    }
    const bench = await page.evaluate('window.__benchResult') as Record<string, unknown>;
    const w = await page.evaluate(`(() => { const q = window.__finp, n = q.n, a = (k) => Array.from(q[k].slice(0, n)); return { tick: a('tick'), ms: a('ms'), end: a('end'), phase: a('phase'), frame: a('frame'), heap: a('heap'), bx: a('bx') }; })()`) as
      { tick: number[]; ms: number[]; end: number[]; phase: number[]; frame: number[]; heap: number[]; bx: number[] };
    const n = w.tick.length;
    const sorted = w.ms.slice().sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
    const out: Record<string, unknown> = {
      bench: { simMsAvg: bench.simMsAvg, simMsP99: bench.simMsP99, simMsMax: bench.simMsMax, frames: bench.frames, ticks: bench.ticks, over: bench.simFramesOverBudget, proxyPass: bench.proxyPass },
      ticks: n, mean: r2(w.ms.reduce((a, b) => a + b, 0) / Math.max(1, n)), p50: r2(pct(0.5)), p90: r2(pct(0.9)), p99: r2(pct(0.99)), max: r2(pct(1)),
      overCount: w.ms.filter((x) => x > over).length,
    };
    // Main-thread GC / compile overlapping each tick.
    const gcIn = new Float64Array(n), compIn = new Float64Array(n);
    if (flag('trace')) {
      let main: number | null = null, mainPid: number | null = null;
      for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') { main = e.tid; mainPid = e.pid; }
      const cal = events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'finp-cal');
      const off = cal ? cal.ts / 1000 - cal0 : 0;
      const gcs: [number, number, string][] = [];
      const comp: [number, number, string][] = [];
      for (const e of events) {
        if (e.ph !== 'X' || typeof e.dur !== 'number' || e.tid !== main || e.pid !== mainPid) continue;
        const a = e.ts / 1000 - off, b = a + e.dur / 1000;
        if (e.name === 'MinorGC' || e.name === 'MajorGC' || e.name === 'V8.GCScavenger' || e.name === 'V8.GCFinalizeMC' || e.name === 'V8.GCIncrementalMarking' || e.name === 'V8.GC_MC_INCREMENTAL') gcs.push([a, b, e.name]);
        else if (/Compile|Deopt|Optimize|Parse|Sparkplug|Maglev/i.test(e.name)) comp.push([a, b, e.name]);
      }
      out.gcList = events.filter((e) => e.tid === main && e.pid === mainPid && e.ph === 'X' && (e.name === 'MinorGC' || e.name === 'MajorGC'))
        .map((e) => [r2(e.ts / 1000 - off), r2((e.dur ?? 0) / 1000), e.name, JSON.stringify(e.args ?? {}).slice(0, 300)]);
      out.jitList = events.filter((e) => e.tid === main && e.pid === mainPid && (e.ph === 'X' || e.ph === 'I' || e.ph === 'i') && /Deopt|Optimize|Maglev|Compile/i.test(e.name) && e.name !== 'V8.CompileCode')
        .map((e) => [r2(e.ts / 1000 - off), r2((e.dur ?? 0) / 1000), e.name, JSON.stringify(e.args ?? {}).slice(0, 400)]);
      const gcNames: Record<string, number> = {};
      for (const [a, b, nm] of gcs) gcNames[nm] = (gcNames[nm] ?? 0) + 1;
      const compNames: Record<string, number> = {};
      for (const [a, b, nm] of comp) compNames[nm] = r2((compNames[nm] ?? 0) + (b - a));
      for (let i = 0; i < n; i++) {
        const t1 = w.end[i]!, t0 = t1 - w.ms[i]!;
        for (const [a, b] of gcs) { const o = Math.min(b, t1) - Math.max(a, t0); if (o > 0) gcIn[i] += o; }
        for (const [a, b] of comp) { const o = Math.min(b, t1) - Math.max(a, t0); if (o > 0) compIn[i] += o; }
      }
      let slowGc = 0, slowComp = 0, slow = 0, gcTicks = 0;
      for (let i = 0; i < n; i++) {
        if (gcIn[i]! > 0) gcTicks++;
        if (w.ms[i]! > over) { slow++; if (gcIn[i]! > 0) slowGc++; if (compIn[i]! > 0.2) slowComp++; }
      }
      out.calibrated = !!cal;
      out.gcEvents = gcNames;
      out.compileMs = compNames;
      out.ticksWithGc = gcTicks;
      out.slowTicks = slow; out.slowWithGc = slowGc; out.slowWithCompile = slowComp;
      out.slowWithoutGcOrCompile = (() => { let k = 0; for (let i = 0; i < n; i++) if (w.ms[i]! > over && gcIn[i]! === 0 && compIn[i]! <= 0.2) k++; return k; })();
    }
    if (profile) {
      const byId = new Map<number, CpuNode>();
      for (const nd of profile.nodes) byId.set(nd.id, nd);
      // performance.now() of each sample: same monotonic clock as the trace; calibrate with the trace if present.
      let tsUs = profile.startTime;
      const allBy = new Map<string, number>(), slowBy = new Map<string, number>();
      let slowSamples = 0;
      const cal = events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'finp-cal');
      const off = cal ? cal.ts / 1000 - cal0 : null;
      // Tick windows sorted by start for a sweep.
      const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (w.end[a]! - w.ms[a]!) - (w.end[b]! - w.ms[b]!));
      let k = 0;
      for (let j = 0; j < profile.samples.length; j++) {
        tsUs += profile.timeDeltas[j]!;
        if (off === null) continue;
        const t = tsUs / 1000 - off;
        while (k < idx.length && w.end[idx[k]!]! < t) k++;
        if (k >= idx.length) break;
        const i = idx[k]!;
        if (t < w.end[i]! - w.ms[i]!) continue; // between ticks
        const nd = byId.get(profile.samples[j]!)!;
        const name = `${nd.callFrame.functionName || '(anon)'}:${nd.callFrame.lineNumber}`;
        allBy.set(name, (allBy.get(name) ?? 0) + 1);
        if (w.ms[i]! > over) { slowBy.set(name, (slowBy.get(name) ?? 0) + 1); slowSamples++; }
      }
      out.cpuTopAllTicks = [...allBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      out.cpuTopSlowTicks = [...slowBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      out.slowSamples = slowSamples;
    }
    if (heapTop) {
      let tot = 0;
      for (const [, v] of heapTop) tot += v;
      out.allocTopBytesPerTick = heapTop.map(([k, v]) => [k, Math.round(v / Math.max(1, n))]);
      out.allocTop50PerTick = Math.round(tot / Math.max(1, n));
    }
    // Slowest ticks with their tick numbers (compare with the Node stage probe: deterministic or noise?).
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => w.ms[b]! - w.ms[a]!);
    out.slowest = order.slice(0, 40).map((i) => `${w.tick[i]}:${r2(w.ms[i]!)}${gcIn[i]! > 0 ? `(gc ${r2(gcIn[i]!)})` : ''}${compIn[i]! > 0.2 ? `(jit ${r2(compIn[i]!)})` : ''} ph${w.phase[i]}`).join(' ');
    // Heap growth between consecutive tick ends inside one frame (the tick plus the loop's event consumers), no GC between.
    {
      const d: number[] = [];
      for (let i = 1; i < n; i++) if (w.frame[i] === w.frame[i - 1] && w.heap[i]! >= w.heap[i - 1]!) d.push(w.heap[i]! - w.heap[i - 1]!);
      d.sort((a, b) => a - b);
      out.heapPerTick = { samples: d.length, mean: Math.round(d.reduce((a, b) => a + b, 0) / Math.max(1, d.length)), p50: d[Math.floor(d.length / 2)] ?? 0, p90: d[Math.floor(d.length * 0.9)] ?? 0, max: d[d.length - 1] ?? 0 };
      let drops = 0;
      for (let i = 1; i < n; i++) if (w.heap[i]! < w.heap[i - 1]! - 200000) drops++;
      out.heapDrops = drops;
    }
    // Per-frame worst (the gate's statistic) and how many ticks a frame ran.
    const perFrame = new Map<number, number>();
    const perFrameN = new Map<number, number>();
    for (let i = 0; i < n; i++) { perFrame.set(w.frame[i]!, Math.max(perFrame.get(w.frame[i]!) ?? 0, w.ms[i]!)); perFrameN.set(w.frame[i]!, (perFrameN.get(w.frame[i]!) ?? 0) + 1); }
    const fw = [...perFrame.values()].sort((a, b) => a - b);
    out.frames = fw.length;
    out.ticksPerFrame = r2(n / Math.max(1, fw.length));
    out.frameWorstP99 = r2(fw[Math.max(Math.ceil(fw.length / 2), Math.min(Math.ceil(0.99 * fw.length), fw.length - 2)) - 1] ?? NaN);
    out.framesOver = fw.filter((x) => x > over).length;
    // Position of a tick inside its frame: first ticks after idle vs later ones.
    const pos: number[][] = [[], [], []];
    for (let i = 0, f = -1, p = 0; i < n; i++) { if (w.frame[i] !== f) { f = w.frame[i]!; p = 0; } else p++; if (p < 3) pos[p]!.push(w.ms[i]!); }
    out.meanByPosInFrame = pos.map((a) => r2(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)));
    if (cal.length > 0) {
      const cs = cal.slice().sort((a, b) => a - b);
      const cp = (p: number): number => cs[Math.min(cs.length - 1, Math.max(0, Math.ceil(p * cs.length) - 1))]!;
      out.calib = { n: cs.length, mean: r2(cs.reduce((a, b) => a + b, 0) / cs.length), p50: r2(cp(0.5)), p90: r2(cp(0.9)), p99: r2(cp(0.99)), max: r2(cp(1)), over4: cs.filter((x) => x > 4).length };
    }
    console.log(JSON.stringify(out, null, 1));
    const json = arg('json', '');
    if (json) writeFileSync(json, JSON.stringify({ out, w }, null, 0));
  } finally {
    await browser.close();
    s.server.close();
  }
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });

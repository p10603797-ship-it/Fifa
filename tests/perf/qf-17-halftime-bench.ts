/**
 * [QF-17] Half-time transition cost in Chromium (FIX-10): the router swap from the match screen to the half-time
 * overlay and back, measured in the real app (bench match, ?bench=1, fixed seed) under CDP CPU throttling with the
 * WebGL draw calls stubbed (software WebGL hides the main thread otherwise; see qf-7r-browser-bench.ts --nodraw).
 *
 * Two measurements per throttle rate:
 *  - swap: `--swaps` times router.go('half-time') then router.go('match') (the exact navigation the session makes at
 *    half time and at the second-half kick-off), each followed by a forced style + layout read, so the number is the
 *    main-thread script + style + layout the swap costs in its frame (the paint of the new layer is not included);
 *    median and max per direction, plus the next frame interval after each swap (includes paint and commit). Into
 *    half time is measured both ways: 'prepared' (AppRouter.prepare a few frames before, as the session does on the
 *    loading screen) and fresh (the fallback, e.g. after a pause at half time); on a tree without prepare both are
 *    the plain swap.
 *  - real: one real half time (the period clock is poked to its end) and the real second-half kick-off (Continue):
 *    longest frame interval within 10 frames of each change, as qf-7r-browser-bench.ts --events reports it.
 *
 *   npx vite build --outDir dist-e2e/qf-17 --emptyOutDir
 *   npx tsx tests/perf/qf-17-halftime-bench.ts --dist dist-e2e/qf-17 --throttle 1,4 [--swaps 12] [--seed N]
 *   npx tsx tests/perf/qf-17-halftime-bench.ts --dev --cpu   (Vite dev server; CPU profile of the swaps: self time by
 *                                                             source function, so the cost has readable names)
 *   --trace: a CDP trace of the real half time and kick-off: the longest main-thread tasks within 1.5 s of each screen
 *            change, each with the trace events inside it summed by name (script, style, layout, paint, GC...).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};

const NODRAW = `
(() => {
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      if (C.prototype[m]) C.prototype[m] = function () {};
    }
  }
  const q = { on: false, t: [], screen: [] };
  window.__qf17 = q;
  const loop = (now) => {
    if (q.on) {
      q.t.push(now);
      const d = window.__dotkick;
      const sc = d ? String(d.ctx.router.current) : '';
      // Trace anchor for --trace: the frame that first sees a new screen.
      if (q.screen.length > 0 && q.screen[q.screen.length - 1] !== sc) console.timeStamp('qf17:' + sc);
      q.screen.push(sc);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
`;

/** In-page: one timed navigation (script + forced style and layout) and the frame interval that follows it. */
const SWAP = `(async (to, prep) => {
  const ctx = window.__dotkick.ctx;
  // prep: the overlay is built ahead (as the session does on the loading screen) and styled over a few frames first.
  if (prep && typeof ctx.router.prepare === 'function') {
    ctx.router.prepare(to);
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r()));
  } else if (typeof ctx.router.discardPrepared === 'function') ctx.router.discardPrepared();
  await new Promise((r) => requestAnimationFrame(() => r()));
  if (window.__qf17cpu) console.profile(to);
  const t0 = performance.now();
  ctx.router.go(to);
  const t1 = performance.now();
  void getComputedStyle(document.body).color;
  void document.body.getBoundingClientRect();
  for (const el of document.querySelectorAll('#ui .screen')) void el.getBoundingClientRect();
  const t2 = performance.now();
  if (window.__qf17cpu) console.profileEnd(to);
  const f0 = await new Promise((r) => requestAnimationFrame((t) => r(t)));
  const f1 = await new Promise((r) => requestAnimationFrame((t) => r(t)));
  return { script: t1 - t0, total: t2 - t0, nextFrame: f1 - f0 };
})`;

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
}
const r1 = (x: number): number => Math.round(x * 10) / 10;

async function main(): Promise<void> {
  const throttles = arg('throttle', '4').split(',').map(Number);
  const swaps = Number(arg('swaps', '12'));
  let url: string;
  let close: () => Promise<void>;
  if (argv.includes('--dev')) {
    const { createServer } = await import('vite');
    const vs = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await vs.listen();
    url = vs.resolvedUrls!.local[0]!;
    close = () => vs.close();
  } else {
    const { server, url: u } = await serveDir(resolve(ROOT, arg('dist', 'dist-e2e/qf-17')));
    url = u;
    close = () => new Promise<void>((r) => server.close(() => r()));
  }
  const cpu = argv.includes('--cpu');
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const rate of throttles) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
      await context.addInitScript(NODRAW);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const q = new URLSearchParams({ bench: '1', benchSeconds: '3600', benchWarmup: '0', benchSeed: arg('seed', '12345') });
      await page.goto(`${url}${url.endsWith('/') ? '' : '/'}index.html?${q.toString()}`, { timeout: 180_000 });
      const cdp = await context.newCDPSession(page);
      if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.waitForFunction(`(() => { const d = window.__dotkick; return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null; })()`,
        null, { timeout: 600_000, polling: 250 });
      await page.waitForTimeout(3000);
      type PNode = { id: number; parent?: number; children?: number[]; callFrame: { url: string; functionName: string; lineNumber: number } };
      type Prof = { nodes: PNode[]; samples: number[]; timeDeltas: number[] };
      const profiles: Record<string, Prof[]> = { 'half-time': [], match: [] };
      if (cpu) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
        cdp.on('Profiler.consoleProfileFinished', (e) => { profiles[e.title ?? '']?.push(e.profile as unknown as Prof); });
        await page.evaluate('window.__qf17cpu = true');
      }
      const res: Record<string, Record<string, number[]>> = {
        'half-time': { script: [], total: [], nextFrame: [] }, 'half-time-prepared': { script: [], total: [], nextFrame: [] },
        match: { script: [], total: [], nextFrame: [] },
      };
      for (let i = 0; i < 2 * swaps; i++) {
        const prep = i % 2 === 1;
        for (const to of ['half-time', 'match'] as const) {
          const r = (await page.evaluate(`${SWAP}(${JSON.stringify(to)}, ${prep && to === 'half-time'})`)) as { script: number; total: number; nextFrame: number };
          const key = to === 'half-time' && prep ? 'half-time-prepared' : to;
          res[key]!.script!.push(r.script);
          res[key]!.total!.push(r.total);
          res[key]!.nextFrame!.push(r.nextFrame);
          await page.waitForTimeout(150);
        }
      }
      if (cpu) {
        await page.evaluate('window.__qf17cpu = false');
        for (const to of ['half-time', 'match']) {
          const self: Record<string, number> = {};
          const incl: Record<string, number> = {};
          let n = 0;
          for (const profile of profiles[to]!) {
            n++;
            const byId = new Map<number, PNode>();
            for (const nd of profile.nodes) byId.set(nd.id, nd);
            for (const nd of profile.nodes) for (const c of nd.children ?? []) { const ch = byId.get(c); if (ch) ch.parent = nd.id; }
            const key = (nd: PNode): string => {
              const u = nd.callFrame.url.replace(/\?.*$/, '');
              return `${u.slice(u.lastIndexOf('/') + 1)}:${nd.callFrame.functionName}:${nd.callFrame.lineNumber + 1}`;
            };
            for (let i = 0; i < profile.samples.length; i++) {
              let nd = byId.get(profile.samples[i]!);
              if (!nd || nd.callFrame.functionName === '(idle)') continue;
              const ms = (profile.timeDeltas[i] ?? 0) / 1000;
              self[key(nd)] = (self[key(nd)] ?? 0) + ms;
              const seen = new Set<string>();
              while (nd) { const k = key(nd); if (!seen.has(k)) { seen.add(k); incl[k] = (incl[k] ?? 0) + ms; } nd = nd.parent !== undefined ? byId.get(nd.parent) : undefined; }
            }
          }
          const top = (o: Record<string, number>): [string, number][] => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 28).map(([k, v]) => [k, r1(v / Math.max(1, n))]);
          console.error(`cpu into ${to}: ${n} swaps; ms per swap, self:`, JSON.stringify(top(self)));
          console.error(`cpu into ${to}: inclusive:`, JSON.stringify(top(incl)));
        }
      }
      // Real half time and second-half kick-off (the overlay built ahead again, as on the loading screen).
      await page.evaluate(`(() => { const r = window.__dotkick.ctx.router; if (typeof r.prepare === 'function') r.prepare('half-time'); })()`);
      await page.waitForTimeout(500);
      const inPlay = `(() => { const s = window.__dotkick.ctx.session.getState(); return !!s && s.match.phase === 2; })()`;
      await page.waitForFunction(inPlay, null, { timeout: 180_000, polling: 100 });
      type TEv = { name: string; ph: string; dur?: number; tid: number; ts: number; args?: { name?: string; data?: { functionName?: string } } };
      const tev: TEv[] = [];
      const tracing = argv.includes('--trace');
      if (tracing) {
        cdp.on('Tracing.dataCollected', (d: { value: unknown[] }) => { for (const e of d.value) tev.push(e as TEv); });
        await cdp.send('Tracing.start', {
          traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'disabled-by-default-devtools.timeline'] },
          transferMode: 'ReportEvents',
        } as never);
      }
      if (tracing && cpu) {
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Profiler.start');
      }
      await page.evaluate('window.__qf17.on = true');
      await page.evaluate(`(() => { const m = window.__dotkick.ctx.session.getState().match; m.addedT = 0; m.periodT = m.periodLen; })()`);
      await page.waitForFunction(`window.__dotkick.ctx.router.current === 'half-time'`, null, { timeout: 120_000, polling: 50 });
      await page.waitForTimeout(1500);
      await page.evaluate(`window.__dotkick.ctx.session.queueCommand(0, 15 /* Command.SKIP */, 0)`).catch(() => undefined);
      await page.waitForFunction(`window.__dotkick.ctx.router.current === 'match'`, null, { timeout: 120_000, polling: 50 });
      await page.waitForTimeout(1500);
      await page.evaluate('window.__qf17.on = false');
      const samples: { t: number; fn: string }[] = [];
      if (tracing && cpu) {
        const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Prof & { startTime: number } };
        const byId = new Map<number, PNode>();
        for (const nd of profile.nodes) byId.set(nd.id, nd);
        let tUs = profile.startTime;
        for (let i = 0; i < profile.samples.length; i++) {
          tUs += profile.timeDeltas[i] ?? 0;
          const nd = byId.get(profile.samples[i]!);
          if (!nd) continue;
          const u = nd.callFrame.url.replace(/\?.*$/, '');
          samples.push({ t: tUs, fn: `${u.slice(u.lastIndexOf('/') + 1)}:${nd.callFrame.functionName}` });
        }
      }
      if (tracing) {
        const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
        await cdp.send('Tracing.end');
        await done;
      }
      const w = (await page.evaluate('({ t: window.__qf17.t, screen: window.__qf17.screen, origin: performance.timeOrigin })')) as { t: number[]; screen: string[]; origin: number };
      if (tracing) {
        let mainTid: number | null = null;
        for (const e of tev) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mainTid = e.tid;
        const main = tev.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && (mainTid === null || e.tid === mainTid));
        // Anchors: the recorder's console.timeStamp in the first frame that saw each new screen (trace clock, us).
        const changes: { at: number; into: string }[] = [];
        for (const e of tev) {
          const msg = (e.args as { data?: { message?: string } } | undefined)?.data?.message;
          if (e.name === 'TimeStamp' && typeof msg === 'string' && msg.startsWith('qf17:')) changes.push({ at: e.ts / 1000, into: msg.slice(5) });
        }
        const offset = 0;
        for (const c of changes) {
          const t0 = (c.at - 300) * 1000;
          const t1 = (c.at + 1500) * 1000;
          const tasks = main.filter((e) => e.name === 'RunTask' && e.ts >= t0 && e.ts <= t1).sort((a, b) => b.dur! - a.dur!).slice(0, 3);
          const rep = tasks.map((t) => {
            const by: Record<string, number> = {};
            for (const e of main) {
              if (e === t || e.ts < t.ts || e.ts + e.dur! > t.ts + t.dur!) continue;
              let k = e.name;
              if (e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'TimerFire') { const fn = e.args?.data?.functionName; if (fn) k += ':' + fn; }
              by[k] = (by[k] ?? 0) + e.dur! / 1000;
            }
            const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${r1(v)}`);
            const fns: Record<string, number> = {};
            for (const smp of samples) if (smp.t >= t.ts && smp.t <= t.ts + t.dur!) fns[smp.fn] = (fns[smp.fn] ?? 0) + 0.1;
            const js = Object.entries(fns).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} ${r1(v)}`);
            return `${r1(t.dur! / 1000)} ms at ${r1(t.ts / 1000 - offset - c.at)} ms: ${top.join(', ')}${js.length ? `\n     js self ms: ${js.join(', ')}` : ''}`;
          });
          console.error(`trace into ${c.into}:\n  ${rep.join('\n  ')}`);
        }
      }
      const real: Record<string, number> = {};
      for (let i = 1; i < w.t.length; i++) {
        if (w.screen[i] === w.screen[i - 1]) continue;
        let iv = 0;
        for (let k = Math.max(1, i - 2); k < Math.min(w.t.length, i + 10); k++) iv = Math.max(iv, w.t[k]! - w.t[k - 1]!);
        real[`into ${w.screen[i]}`] = r1(iv);
      }
      let steady = 0;
      const ivs: number[] = [];
      for (let i = 1; i < w.t.length; i++) ivs.push(w.t[i]! - w.t[i - 1]!);
      steady = median(ivs);
      const out = {
        throttle: rate,
        swapIntoHalfTime: { scriptMed: r1(median(res['half-time']!.script!)), totalMed: r1(median(res['half-time']!.total!)), totalMax: r1(Math.max(...res['half-time']!.total!)), nextFrameMed: r1(median(res['half-time']!.nextFrame!)) },
        swapIntoHalfTimePrepared: res['half-time-prepared']!.total!.length ? { scriptMed: r1(median(res['half-time-prepared']!.script!)), totalMed: r1(median(res['half-time-prepared']!.total!)), totalMax: r1(Math.max(...res['half-time-prepared']!.total!)), nextFrameMed: r1(median(res['half-time-prepared']!.nextFrame!)) } : null,
        swapIntoMatch: { scriptMed: r1(median(res.match!.script!)), totalMed: r1(median(res.match!.total!)), totalMax: r1(Math.max(...res.match!.total!)), nextFrameMed: r1(median(res.match!.nextFrame!)) },
        realMaxIntervalMs: real,
        steadyIntervalMedMs: r1(steady),
        errors: errors.slice(0, 5),
      };
      console.log(JSON.stringify(out));
      await context.close();
    }
  } finally {
    await browser.close();
    await close();
  }
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });

/**
 * [FIN-P2] Sim + AI allocation per tick in headless Chromium, on a production build, in the benchmark match (diagnostic,
 * not a test). Opens `--dist` at ?bench=1 as tools/bench.ts does (1180 x 820, DPR 2, touch, optional CDP throttling),
 * waits until the match reaches tick `--from`, then samples V8's heap allocations (HeapProfiler sampling) for `--ticks`
 * ticks and prints bytes per tick allocated under the sim's step() (sim + AI) and elsewhere, with the top functions.
 * Function names need an unminified build: `npx vite build --minify false --outDir dist-e2e/<id>-nomin`; Rolldown
 * still turns every top-level const into a var there, as in the shipped (minified) build, so the code V8 sees is the
 * same apart from names.
 *
 *   npx tsx tests/perf/fin-p2-chrome-alloc.ts --dist dist-e2e/fin-p2-nomin [--from 300] [--ticks 1500] [--throttle 1]
 *                                             [--interval 32] [--top 30] [--json out.json]
 *                                             [--jsflags "--trace-deopt"] [--nosample]
 * With --jsflags the renderer's V8 flags are set and its stdout / stderr (e.g. --trace-deopt lines) are echoed between
 * the markers "@@window-start" and "@@window-end" (run with DEBUG=pw:browser to see them).
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const dist = arg('dist', 'dist');
const from = Number(arg('from', '300'));
const ticks = Number(arg('ticks', '1500'));
const throttle = Number(arg('throttle', '1'));
const interval = Number(arg('interval', '32'));
const top = Number(arg('top', '30'));

type Node = { id: number; callFrame: { functionName: string; lineNumber: number; url: string }; children: Node[] };

const { server, url } = await serveDir(dist);
const jsflags = arg('jsflags', '');
const browser = await chromium.launch({ headless: true, args: jsflags ? [`--js-flags=${jsflags}`, '--enable-logging=stderr', '--v=0'] : [] });
if (jsflags) console.log(`renderer V8 flags: ${jsflags}`);
const sample = !argv.includes('--nosample');
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(`${url}index.html?bench=1&benchSeconds=600`);
  const tickOf = (): Promise<number> => page.evaluate(() => {
    const d = (window as unknown as { __dotkick?: { ctx: { session: { getState(): { tick: number } | null } } } }).__dotkick;
    const st = d?.ctx.session.getState();
    return st ? st.tick : -1;
  });
  for (;;) {
    const t = await tickOf();
    if (t >= from) break;
    await page.waitForTimeout(t > from - 120 ? 20 : 250);
  }
  await cdp.send('HeapProfiler.enable');
  const t0 = await tickOf();
  await page.evaluate((t) => { console.log(`@@window-start ${t}`); }, t0);
  if (sample) {
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
    });
  }
  for (;;) {
    const t = await tickOf();
    if (t >= t0 + ticks) break;
    await page.waitForTimeout(100);
  }
  const t1 = await tickOf();
  await page.evaluate((t) => { console.log(`@@window-end ${t}`); }, t1);
  if (!sample) { await browser.close(); server.close(); process.exit(0); }
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: Node; samples: { size: number; nodeId: number }[] };
  };
  const n = t1 - t0;
  const fnOf = new Map<number, string>();
  const inStep = new Set<number>();
  const walk = (nd: Node, under: boolean): void => {
    const st = under || nd.callFrame.functionName === 'step';
    if (st) inStep.add(nd.id);
    fnOf.set(nd.id, `${nd.callFrame.functionName || '(anon)'}:${nd.callFrame.lineNumber + 1}`);
    for (const c of nd.children) walk(c, st);
  };
  walk(profile.head, false);
  let sim = 0;
  let other = 0;
  const bySim = new Map<string, number>();
  const byOther = new Map<string, number>();
  for (const smp of profile.samples) {
    const k = fnOf.get(smp.nodeId)!;
    if (inStep.has(smp.nodeId)) { sim += smp.size; bySim.set(k, (bySim.get(k) ?? 0) + smp.size); }
    else { other += smp.size; byOther.set(k, (byOther.get(k) ?? 0) + smp.size); }
  }
  const list = (m: Map<string, number>): { fn: string; bPerTick: number }[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, b]) => ({ fn, bPerTick: Math.round(b / n) }));
  const out = { dist, throttle, from: t0, ticks: n, simPerTick: Math.round(sim / n), otherPerTick: Math.round(other / n),
    sim: list(bySim), other: list(byOther).slice(0, 10) };
  console.log(`sim+AI ${out.simPerTick} B/tick, other ${out.otherPerTick} B/tick, ticks ${t0}..${t1}`);
  for (const r of out.sim) console.log(`${String(r.bPerTick).padStart(7)}  ${r.fn}`);
  console.log('other:');
  for (const r of out.other) console.log(`${String(r.bPerTick).padStart(7)}  ${r.fn}`);
  if (argv.includes('--json')) writeFileSync(arg('json', 'alloc.json'), JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  server.close();
}
process.exit(0);

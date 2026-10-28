/**
 * [FIN-P skeptic] Sim + AI allocation per tick in the benchmark match, as the shipped app runs it (diagnostic; the
 * regression test is tests/perf/fin-p-bench-alloc.test.ts). Production-build behaviour: __DEV_BUILD__ is false before
 * anything loads, so initMatch runs the sim warm-up once (sim/init.ts warmUpOnce) and settles every state's shapes
 * (core/clone.ts). Then benchSetup(seed) is played exactly as the bench plays it (no input, cut-scenes in full, the
 * loop's copyState(prev, curr) before every step), and V8's sampling heap profiler counts every allocation of `ticks`
 * ticks from tick `from` (the bench measures from tick ~300). Garbage made inside step() lands as scavenges inside the
 * proxy gate's timed ticks. Run with the exact-allocation flags (tests/perf/qf-7r-alloc-flags.ts):
 *
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --import tsx \
 *        tests/perf/fin-p-bench-alloc-probe.ts [from 300] [ticks 1500] [seed BENCH_DEFAULTS.seed]
 *
 * FINP_INTERVAL=N: sampling interval in bytes (default exact; a larger one for allocation-heavy runs, e.g. Maglev only).
 * FINP_DEV=1: a dev build instead (no warm-up, no settling); FINP_SETTLE=0 / 1 forces shape settling off / on.
 * Prints one JSON line: { stepPerTick (bytes allocated under step(), sim + AI), otherPerTick, sites: [{ site, bytes }] }.
 */
(globalThis as unknown as Record<string, unknown>).__DEV_BUILD__ = process.env.FINP_DEV === '1';
const { Session } = await import('node:inspector/promises');
const { EXACT_INTERVAL } = await import('./qf-7r-alloc-flags');
const { createInputFrame, clearInputFrame } = await import('../../src/contracts/input');
const { createSimState } = await import('../../src/contracts/state');
const { createEventBuffer } = await import('../../src/sim/core/events');
const { copyState, setShapeSettling } = await import('../../src/sim/core/clone');
if (process.env.FINP_SETTLE === '0') setShapeSettling(false);
if (process.env.FINP_SETTLE === '1') setShapeSettling(true);
const { initMatch } = await import('../../src/sim/init');
const { step } = await import('../../src/sim/step');
const { BENCH_DEFAULTS, benchSetup } = await import('../../src/platform/benchHook');

const from = Number(process.argv[2] ?? 300);
const ticks = Number(process.argv[3] ?? 1500);
const seed = Number(process.argv[4] ?? BENCH_DEFAULTS.seed);

const s = initMatch(benchSetup(seed).config);
const prev = createSimState(s.config, s.squads);
copyState(prev, s);
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
function tick(): void {
  copyState(prev, s);
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  step(s, frames, ev);
}
while (s.tick < from) tick();

const profiler = new Session();
profiler.connect();
await profiler.post('HeapProfiler.startSampling', {
  samplingInterval: Number(process.env.FINP_INTERVAL ?? EXACT_INTERVAL), includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
});
for (let i = 0; i < ticks; i++) tick();
type Node = { id: number; callFrame: { url: string; functionName: string; lineNumber: number }; children: Node[] };
const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
  head: Node; samples: { size: number; nodeId: number }[];
};
const site = new Map<number, string>();
const underStep = new Set<number>();
const index = (nd: Node, inStep: boolean): void => {
  const u = nd.callFrame.url;
  const st = inStep || (nd.callFrame.functionName === 'step' && /\/src\/sim\/step\.ts$/.test(u));
  if (st) underStep.add(nd.id);
  const m = /\/src\/(.*)$/.exec(u);
  site.set(nd.id, `${nd.callFrame.functionName || '(anon)'} ${m ? `src/${m[1]}` : u.replace(/^.*\/Fifa\//, '')}:${nd.callFrame.lineNumber + 1}`);
  for (const ch of nd.children) index(ch, st);
};
index(profile.head, false);
let inStep = 0;
let other = 0;
const bySite = new Map<string, number>();
for (const smp of profile.samples) {
  if (underStep.has(smp.nodeId)) {
    inStep += smp.size;
    const k = site.get(smp.nodeId)!;
    bySite.set(k, (bySite.get(k) ?? 0) + smp.size);
  } else other += smp.size;
}
const sites = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => ({ site: k, bytes: Math.round(b) }));
console.log(JSON.stringify({ stepPerTick: inStep / ticks, otherPerTick: other / ticks, tick: s.tick, phase: s.match.phase, sites }));
process.exit(0);

export {};

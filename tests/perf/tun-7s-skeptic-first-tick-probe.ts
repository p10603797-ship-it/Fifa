/**
 * [TUN-7S skeptic] Probe for tests/perf/tun-7s-skeptic-first-tick.test.ts, run in a fresh child process (fresh module
 * state, nothing compiled yet), as the app does it: on the loading screen initMatch and prev built like app/liveState.ts
 * cloneLiveState (createSimState + copyState(prev, curr)); then the first tick's copyState(prev, curr) and the first
 * hashState(curr) (replay recorder at tick 60 / net desync at tick 30), for two matches.
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --expose-gc --import tsx \
 *        tests/perf/tun-7s-skeptic-first-tick-probe.ts [root]
 * Prints one JSON line per match: { codegenInit, codegenTick, tickBytes, copyMs, hashMs, initMs } where codegen* count
 * `new Function` calls during loading (initMatch + prev) / during the first tick's copy + hash, and tickBytes is every
 * byte allocated by that first copy + hash under clone.ts / hash.ts / generated frames (exact sampling).
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from './qf-7r-alloc-flags';

const root = process.argv[2] ?? '../../';
const { createMatchConfig, createSimState } = await import(`${root}src/contracts/state.ts`) as typeof import('../../src/contracts/state');
const { copyState } = await import(`${root}src/sim/core/clone.ts`) as typeof import('../../src/sim/core/clone');
const { hashState } = await import(`${root}src/sim/core/hash.ts`) as typeof import('../../src/sim/core/hash');
const { initMatch } = await import(`${root}src/sim/init.ts`) as typeof import('../../src/sim/init');

// Count `new Function` (the generated copier / checker / hasher) by phase.
let codegen = 0;
const RealFunction = globalThis.Function;
globalThis.Function = new Proxy(RealFunction, {
  construct(target, args: unknown[]) { codegen++; return Reflect.construct(target, args) as object; },
  apply(target, self, args: unknown[]) { codegen++; return Reflect.apply(target, self, args) as unknown; },
});

const profiler = new Session();
profiler.connect();
for (let m = 0; m < 2; m++) {
  const c = createMatchConfig();
  c.seed = 20261023 + m;
  c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  codegen = 0;
  let t0 = performance.now();
  const curr = initMatch(c);
  const prev = createSimState(curr.config, curr.squads); // app/liveState.ts cloneLiveState, on the loading screen too
  copyState(prev, curr);
  const initMs = performance.now() - t0;
  const codegenInit = codegen;
  (globalThis as { gc?: () => void }).gc?.();
  codegen = 0;
  await profiler.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  t0 = performance.now();
  copyState(prev, curr);
  const copyMs = performance.now() - t0;
  t0 = performance.now();
  hashState(curr);
  const hashMs = performance.now() - t0;
  const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
    head: { id: number; callFrame: { url: string }; children: unknown[] }; samples: { size: number; nodeId: number }[];
  };
  // Only allocations under clone.ts / hash.ts / generated code frames count (the inspector's own replies do not).
  type N = { id: number; callFrame: { url: string; functionName: string }; children: N[] };
  const ours = new Set<number>();
  const walk = (n: N, inside: boolean): void => {
    const here = inside || /sim\/core\/(clone|hash)\.ts/.test(n.callFrame.url);
    if (here) ours.add(n.id);
    for (const ch of n.children) walk(ch, here);
  };
  walk(profile.head as unknown as N, false);
  let tickBytes = 0;
  for (const smp of profile.samples) if (ours.has(smp.nodeId)) tickBytes += smp.size;
  console.log(JSON.stringify({ match: m, codegenInit, codegenTick: codegen, tickBytes, copyMs, hashMs, initMs }));
}
process.exit(0);

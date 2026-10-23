/**
 * [FIN-A] SIM-01 zero-allocation probe (tests/unit/sim-01-perf.test.ts runs it in a child process). The in-process
 * heapUsed measurement inside a Vitest worker thread was load sensitive: V8 compiles optimised code on background
 * threads, so under CPU load the measured window ran more calls in the interpreter / baseline tiers, which box every
 * intermediate double ('solvers create no objects' read groundRollTime at 1472 B/call once under parallel load, about
 * 300 alone). Run with the QF-7R flags (tests/perf/qf-7r-alloc-flags.ts):
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --expose-gc --import tsx \
 *        tests/unit/fin-a-sim-01-alloc-probe.ts [warm] [calls]   (defaults 4000 1500)
 * --single-threaded compiles synchronously, so when a function is optimised depends only on what ran, never on the
 * machine's load; V8's sampling heap profiler at a 4-byte interval then counts every allocation of the measured window
 * exactly (objects collected by a minor GC included). Prints one JSON line { singleThreaded, cases: { name: bytesPerCall } }.
 */
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import { BALL_RADIUS } from '../../src/contracts/constants';
import { createLaunchSolution, groundPassSpeed, groundRollTime, solveLaunch, solveLaunchSpin } from '../../src/sim/ball/flight';
import { createV3 } from '../../src/sim/core/vec';

const warm = Number(process.argv[2] ?? 4000);
const calls = Number(process.argv[3] ?? 1500);

const v = createV3();
const sol = createLaunchSolution();
const sink = new Float64Array(1);

/** The 'solvers create no objects' cases of sim-01-perf.test.ts. */
const cases: [string, () => void][] = [
  ['solveLaunch', () => { sink[0] = solveLaunch(38, -9, 0.62, v); }],
  ['solveLaunchSpin curl+backspin', () => { sink[0] = solveLaunchSpin(28, 6, 0.45, BALL_RADIUS, -9, 4, sol); }],
  ['groundPassSpeed', () => { sink[0] = groundPassSpeed(21, 3); }],
  ['groundRollTime', () => { sink[0] = groundRollTime(14, 20); }],
];

const gc = (globalThis as { gc?: () => void }).gc;
const profiler = new Session();
profiler.connect();
async function bytesPerCall(fn: () => void): Promise<number> {
  for (let i = 0; i < warm; i++) fn(); // warm-up / JIT / inline caches (synchronous compiles: load independent)
  gc?.();
  await profiler.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < calls; i++) fn();
  const prof = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as { samples: { size: number }[] };
  let bytes = 0;
  for (const smp of prof.samples) bytes += smp.size;
  return bytes / calls;
}
// The first window also counts the lazy compilation of this measuring code and the inspector's bookkeeping: run an
// empty window first. The second one is the fixed cost every window carries (~1 B per call; left in, not subtracted).
const noop = (): void => { sink[0] = 0; };
await bytesPerCall(noop);
const out: Record<string, number> = { noop: await bytesPerCall(noop) };
for (const [name, fn] of cases) out[name] = await bytesPerCall(fn);
console.log(JSON.stringify({ singleThreaded: process.execArgv.includes('--single-threaded'), cases: out }));
process.exit(0);

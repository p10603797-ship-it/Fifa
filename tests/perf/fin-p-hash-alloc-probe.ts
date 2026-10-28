/**
 * [FIN-P skeptic] Child-process probe for tests/perf/fin-p-hash-alloc.test.ts: bytes one hashState of a live match
 * state allocates once the hasher is optimised (the app's replay recorder hashes every REPLAY_HASH_INTERVAL ticks of
 * every match, net desync checks every T_NET.hashInterval, the sim warm-up every T_WARMUP.hashEvery). Plays `ticks` of
 * a CPU v CPU match, hashes it `calls` times to warm up, then counts every allocation of `calls` more hashes
 * (run with the exact-allocation flags, tests/perf/qf-7r-alloc-flags.ts). Prints one JSON line { perHash, sites }.
 *
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --import tsx tests/perf/fin-p-hash-alloc-probe.ts [calls 300]
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from './qf-7r-alloc-flags';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { benchSetup } from '../../src/platform/benchHook';

const calls = Number(process.argv[2] ?? 300);
const s = initMatch(benchSetup(1).config);
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
for (let t = 0; t < 600; t++) { clearInputFrame(frames[0]!); clearInputFrame(frames[1]!); step(s, frames, ev); }
const sink = new Int32Array(1);
for (let i = 0; i < calls * 4; i++) sink[0] = hashState(s);
const profiler = new Session();
profiler.connect();
await profiler.post('HeapProfiler.startSampling', {
  samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
});
for (let i = 0; i < calls; i++) sink[0] = hashState(s);
type Node = { id: number; callFrame: { functionName: string; lineNumber: number }; children: Node[] };
const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as { head: Node; samples: { size: number; nodeId: number }[] };
const name = new Map<number, string>();
const index = (nd: Node): void => { name.set(nd.id, `${nd.callFrame.functionName || '(anon)'}:${nd.callFrame.lineNumber + 1}`); for (const c of nd.children) index(c); };
index(profile.head);
let total = 0;
const by = new Map<string, number>();
for (const smp of profile.samples) { total += smp.size; const k = name.get(smp.nodeId)!; by.set(k, (by.get(k) ?? 0) + smp.size); }
console.log(JSON.stringify({ perHash: total / calls, sites: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) }));
process.exit(0);

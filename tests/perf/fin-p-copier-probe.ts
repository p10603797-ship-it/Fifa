/**
 * [FIN-P] Child-process probe for tests/unit/fin-p-warmup.test.ts (run with the QF-7R exact-allocation flags,
 * tests/perf/qf-7r-alloc-flags.ts): bytes the state copier and hasher allocate in the first ticks of a match that follows
 * the sim warm-up, as the app runs them (the loop's copyState(prev, curr) before every tick, the replay recorder's
 * hashState). Plays warmUpSim, builds the match (initMatch, prev as app/liveState.ts cloneLiveState builds it), then
 * samples every allocation over `ticks` ticks and prints one JSON line { perTick, sites } for the allocations whose
 * frame is the generated copier / hasher code or src/sim/core/{clone,hash}.ts.
 *
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --import tsx tests/perf/fin-p-copier-probe.ts [ticks]
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from './qf-7r-alloc-flags';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createSimState } from '../../src/contracts/state';
import { copyState, setShapeSettling } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch, warmUpSim } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { benchSetup } from '../../src/platform/benchHook';

// The production behaviour (initMatch and the copier settle state shapes in production builds only).
setShapeSettling(true);

interface HeapNode { id: number; callFrame: { functionName: string; url: string }; children: HeapNode[] }

const ticks = Number(process.argv[2] ?? 120);
const config = benchSetup(1).config;
warmUpSim((c) => initMatch(c), config);
const s = initMatch(config);
const prev = createSimState(s.config, s.squads);
copyState(prev, s);
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
const sink = new Int32Array(1);
const session = new Session();
session.connect();
await session.post('HeapProfiler.startSampling', {
  samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
} as never);
for (let t = 0; t < ticks; t++) {
  copyState(prev, s);
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  step(s, frames, ev);
  if (s.tick % 8 === 0) sink[0] = hashState(s);
}
const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: HeapNode; samples: { nodeId: number; size: number }[] } };
const nodes = new Map<number, HeapNode>();
const index = (nd: HeapNode): void => { nodes.set(nd.id, nd); for (const c of nd.children) index(c); };
index(profile.head);
const by: Record<string, number> = {};
let bytes = 0;
for (const smp of profile.samples) {
  const nd = nodes.get(smp.nodeId);
  if (!nd) continue;
  const u = nd.callFrame.url, fn = nd.callFrame.functionName;
  const generated = !u.includes('/src/') && !u.includes('node:') && /^[a-z]+\d+$/.test(fn);
  if (!generated && !u.includes('/src/sim/core/clone.ts') && !u.includes('/src/sim/core/hash.ts')) continue;
  bytes += smp.size;
  const k = `${fn}${generated ? ' (generated)' : ''}`;
  by[k] = (by[k] ?? 0) + smp.size;
}
console.log(JSON.stringify({ perTick: bytes / ticks, sites: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
process.exit(0);

/**
 * [TUN-7S] QF-7S (c) probe: bytes the sim + AI allocate per tick in live play, by allocation site. Run in a child
 * process with the QF-7R exact-allocation flags (tests/perf/qf-7r-alloc-flags.ts):
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --invocation-count-for-turbofan=400 \
 *        --expose-gc --import tsx tests/perf/tun-7s-sim-alloc-probe.ts [warmTicks] [ticks] [seed] [difficulty] [half] [pre]
 * Steady state of a running app: first plays `pre` ticks of another match (default 30000: a whole 4-minute-half match),
 * so every hidden class has met its doubles (V8 generalises a field from small integer to double the first time one is
 * stored, which deoptimises the code that read it: a once-per-app-session cost, not per tick), then plays CPU v CPU from
 * kick-off with step() (neutral human frames; cut-scenes skipped by Btn.SKIP edges so the window is live play and
 * restarts), warms `warmTicks` ticks, samples every allocation over `ticks` ticks and prints one JSON line:
 * { bytesPerTick (src/sim + src/ai self allocation), otherPerTick, sites: [{ site, bytes }] }.
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from './qf-7r-alloc-flags';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn, clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CUTSCENE_PHASES } from '../../src/contracts/transitions';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const warm = Number(process.argv[2] ?? 6000);
const ticks = Number(process.argv[3] ?? 3000);
const seed = Number(process.argv[4] ?? 20261023);
const difficulty = Number(process.argv[5] ?? 3);
const half = Number(process.argv[6] ?? 4);
const pre = Number(process.argv[7] ?? 30000);

function match(seed0: number, diff: number): SimState {
  const c = createMatchConfig();
  c.seed = seed0;
  c.difficulty = diff;
  c.halfMinutes = half;
  c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  return initMatch(c);
}
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
const cut = CUTSCENE_PHASES as readonly number[];
function tick(st: SimState, strict: boolean): void {
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  if (cut.indexOf(st.match.phase) >= 0 && (st.tick & 15) === 0) frames[0]!.buttons = Btn.SKIP;
  step(st, frames, ev);
  if (strict && st.match.phase === MatchPhase.POST_MATCH) throw new Error('match ended inside the window: lower the tick counts');
}
const s0 = match(seed ^ 0x5a5a5a, (difficulty + 2) % 6);
for (let i = 0; i < pre && s0.match.phase !== MatchPhase.POST_MATCH; i++) tick(s0, false);
const s = match(seed, difficulty);
for (let i = 0; i < warm; i++) tick(s, true);
if (process.env.MARK) console.log('WINDOW START');
(globalThis as { gc?: () => void }).gc?.();

const profiler = new Session();
profiler.connect();
await profiler.post('HeapProfiler.startSampling', {
  samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
});
for (let i = 0; i < ticks; i++) tick(s, true);
type Node = { id: number; callFrame: { url: string; functionName: string; lineNumber: number }; children: Node[] };
const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
  head: Node; samples: { size: number; nodeId: number }[];
};
const site = new Map<number, string>();
const ours = new Set<number>();
const index = (nd: Node): void => {
  const u = nd.callFrame.url;
  const m = /\/src\/(sim|ai)\/(.*)$/.exec(u);
  if (m) ours.add(nd.id);
  site.set(nd.id, `${nd.callFrame.functionName || '(anon)'} ${m ? `src/${m[1]}/${m[2]}` : u.replace(/^.*\/Fifa\//, '')}:${nd.callFrame.lineNumber + 1}`);
  for (const ch of nd.children) index(ch);
};
index(profile.head);
let mine = 0;
let other = 0;
const bySite = new Map<string, number>();
/** Bytes by allocation size (12 / 16 = boxed doubles; anything else is an object, array or closure). */
const sizes: Record<string, number> = {};
for (const smp of profile.samples) {
  if (ours.has(smp.nodeId)) {
    mine += smp.size;
    sizes[smp.size] = (sizes[smp.size] ?? 0) + smp.size;
    const k = site.get(smp.nodeId)!;
    bySite.set(k, (bySite.get(k) ?? 0) + smp.size);
  } else other += smp.size;
}
const sites = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, b]) => ({ site: k, bytes: b }));
console.log(JSON.stringify({ bytesPerTick: mine / ticks, otherPerTick: other / ticks, tick: s.tick, phase: s.match.phase, sizes, sites }));
process.exit(0);

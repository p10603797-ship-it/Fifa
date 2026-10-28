/**
 * [FIN-P2] previewFlight allocation by function, on an esbuild bundle of the sim with __DEV_BUILD__ false (production
 * mode: warm-up and shape settling; top-level consts become vars, as in the shipped bundle). A ready free kick (home,
 * 21 m out, human v human) is previewed `n` times to warm up, then `n` times under V8's sampling heap profiler.
 * Prints one JSON line: { perCall, byFn: { [function]: bytes per call } }. Run with the exact-allocation flags
 * (tests/perf/qf-7r-alloc-flags.ts):
 *
 *   node --single-threaded --sampling-heap-profiler-suppress-randomness --import tsx tests/perf/fin-p2-preview-alloc-probe.ts [n 3000]
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EXACT_INTERVAL } from './qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(join(tmpdir(), 'fin-p2-preview-'));
const src = (f: string): string => JSON.stringify(join(ROOT, f));
writeFileSync(join(dir, 'entry.ts'), [
  `export { awardRestart } from ${src('src/sim/rules/restart')};`,
  `export { previewFlight } from ${src('src/sim/rules/freekick')};`,
  `export { step } from ${src('src/sim/step')};`,
  `export { initMatch } from ${src('src/sim/init')};`,
  `export { createMatchConfig } from ${src('src/contracts/state')};`,
  `export { createInputFrame } from ${src('src/contracts/input')};`,
  `export { createBallPrediction } from ${src('src/contracts/systems')};`,
  `export { createEventBuffer } from ${src('src/sim/core/events')};`,
].join('\n'));
await build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(dir, 'bundle.mjs'),
  logLevel: 'error', define: { __DEV_BUILD__: 'false' } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m: any = await import(pathToFileURL(join(dir, 'bundle.mjs')).href);
rmSync(dir, { recursive: true, force: true });

const n = Number(process.argv[2] ?? 3000);
const cfg = m.createMatchConfig();
cfg.humans[1] = { ...cfg.humans[0], kind: ControllerKind.HUMAN, side: 1 };
const ev = m.createEventBuffer();
const s = m.initMatch(cfg);
s.match.phase = MatchPhase.IN_PLAY;
ev.begin(0);
m.awardRestart(s, RestartKind.FREE_KICK, 0, 52.5 - 21, 3, ev);
const frames = [m.createInputFrame(), m.createInputFrame()];
for (let i = 0; i < 80 && s.match.restart.ready !== 1; i++) m.step(s, frames, ev);
if (s.match.restart.ready !== 1) throw new Error('free kick not ready');
s.match.restart.timeoutT = 1e9;
const pred = m.createBallPrediction();
for (let i = 0; i < n; i++) m.previewFlight(s, pred);
const ses = new Session();
ses.connect();
await ses.post('HeapProfiler.startSampling', {
  samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
});
for (let i = 0; i < n; i++) m.previewFlight(s, pred);
type Nd = { id: number; callFrame: { functionName: string }; children: Nd[] };
const prof = (await ses.post('HeapProfiler.stopSampling')).profile as unknown as { head: Nd; samples: { size: number; nodeId: number }[] };
const fn = new Map<number, string>();
const walk = (nd: Nd): void => { fn.set(nd.id, nd.callFrame.functionName || '(anon)'); for (const c of nd.children) walk(c); };
walk(prof.head);
const byFn: Record<string, number> = {};
let total = 0;
for (const smp of prof.samples) {
  total += smp.size;
  const k = fn.get(smp.nodeId)!;
  byFn[k] = (byFn[k] ?? 0) + smp.size / n;
}
console.log(JSON.stringify({ perCall: total / n, byFn }));
process.exit(0);

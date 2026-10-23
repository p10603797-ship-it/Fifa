/**
 * [QF-7R] Probe for tests/unit/qf-7r-live-state.test.ts, run in a child process:
 *   node --allow-natives-syntax --single-threaded --sampling-heap-profiler-suppress-randomness --expose-gc \
 *        --import tsx tests/unit/qf-7r-live-state-probe.ts [shapes]
 * Starts a real match through the app session (src/app/session.ts with its default initMatch and prev builder; the
 * router, renderer, HUD and audio are stand-ins), then reports for the runtime's prev and curr states:
 *  - shapes: per nested object (players, attrs, ball, match, teams, ctrl, rng...) whether prev has fast properties and
 *    the same hidden class as curr (V8 natives);
 *  - (not with `shapes`) bytes allocated by sim/core/clone.ts per copyState(prev, curr) over live CPU v CPU ticks (exact: every allocation
 *    sampled), and the same for a prev made by cloneState (the pre-QF-7R builder) for comparison.
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import type { AppContext, MatchSetup, Screen, ScreenId } from '../../src/contracts/app';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import { ANY_DEVICE } from '../../src/app/localInput';
import type { AppSession, MatchRuntime } from '../../src/app/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';

const nat = {
  fast: (0, eval)('(o) => %HasFastProperties(o)') as (o: object) => boolean,
  same: (0, eval)('(a, b) => %HaveSameMap(a, b)') as (a: object, b: object) => boolean,
};
const noop = (): void => {};
const fn = (): (() => void) => noop;

// ---- A session with the real sim defaults (initMatch, prev builder); everything else a stand-in.
const root = { appendChild: noop } as unknown as HTMLElement;
const focus = { attach: noop, detach: noop, handle: noop, focus: noop, onAction: fn };
const router = createRouter(root, () => ({ focus } as unknown as AppContext), {
  listen: false, createContainer: () => ({ remove: noop }) as unknown as HTMLElement,
});
for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
  router.register(id, (): Screen => ({ id, mount: noop, unmount: noop }));
}
router.go('main');
const hud = { mount: noop, setMatch: noop, update: noop, onEvents: noop, setVisible: noop, dispose: noop };
const audio = {
  unlock: noop, unlocked: true, setVolumes: noop, onEvents: noop, update: noop, playUi: noop,
  matchStart: noop, matchEnd: noop, setPaused: noop, suspend: noop, resume: noop,
};
const provider = {
  ready: () => true, take: noop, pump: noop, waiting: false, releaseAll: noop, dispose: noop,
  queueCommand: noop, sourceCount: 0, rebind: noop, devicesOf: () => [],
};
const session = createSession({
  router, renderer: createNullRenderer(), hud, audio,
  devices: { list: () => [], subscribe: fn, createSource: noop as never, lastActive: () => null },
  diagnostics: { log: noop, recent: () => [], debug: false, setDebug: noop, report: () => '' },
  clubs: CLUBS, getProjector: () => null,
  createLocalProvider: () => provider as never,
  yieldFrame: () => Promise.resolve(), newSeed: () => 20261023, now: () => 1000, onError: (e: unknown) => { throw e; },
} as never) as AppSession;
const config = createMatchConfig();
config.seed = 20261023;
config.humans = config.humans.map((h) => ({ ...h, kind: 0, side: -1 })); // CPU v CPU
session.start({ config, bindings: [{ human: 0, deviceIds: [ANY_DEVICE] }] } as MatchSetup);
for (let i = 0; i < 6 && !session.loaded; i++) await new Promise<void>((r) => setTimeout(r, 0));
const rt = session.runtime() as MatchRuntime | null;
if (!rt) throw new Error('match did not load');

// ---- Shapes: every nested object of prev against curr.
const shapes: Record<string, { fast: boolean; same: boolean }> = {};
const check = (name: string, a: unknown, b: unknown): void => {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || ArrayBuffer.isView(a)) return;
  if (Array.isArray(a)) {
    for (let i = 0; i < a.length; i++) check(`${name}[]`, a[i], (b as unknown[])[i]);
    return;
  }
  const prevFast = nat.fast(a), same = nat.same(a, b);
  const s = shapes[name] ?? (shapes[name] = { fast: true, same: true });
  s.fast &&= prevFast;
  s.same &&= same;
};
for (const k of Object.keys(rt.curr)) {
  if (k === 'config' || k === 'squads') continue;
  check(k, (rt.prev as unknown as Record<string, unknown>)[k], (rt.curr as unknown as Record<string, unknown>)[k]);
}

if (process.argv[2] === 'shapes') {
  console.log(JSON.stringify({ shapes, tick: rt.curr.tick }));
  process.exit(0);
}

// ---- copyState(prev, curr) allocation per tick over live play.
const profiler = new Session();
profiler.connect();
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
const copy = (prev: SimState, curr: SimState): void => copyState(prev, curr);
async function perCopy(prev: SimState, curr: SimState, ticks: number): Promise<number> {
  for (let i = 0; i < 1200; i++) { copy(prev, curr); step(curr, frames, ev); } // warm (optimised code)
  (globalThis as { gc?: () => void }).gc?.();
  await profiler.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < ticks; i++) { copy(prev, curr); step(curr, frames, ev); }
  type Node = { id: number; callFrame: { url: string }; children: Node[] };
  const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
    head: Node; samples: { size: number; nodeId: number }[];
  };
  const inClone = new Set<number>();
  const index = (nd: Node): void => {
    if (nd.callFrame.url.includes('/src/sim/core/clone.ts')) inClone.add(nd.id);
    for (const c of nd.children) index(c);
  };
  index(profile.head);
  let bytes = 0;
  for (const smp of profile.samples) if (inClone.has(smp.nodeId)) bytes += smp.size;
  return bytes / ticks;
}
const live = await perCopy(rt.prev, rt.curr, 400);
const cloned = await perCopy(cloneState(rt.curr), rt.curr, 200);
console.log(JSON.stringify({ shapes, copyBytesPerTick: live, cloneStatePrevCopyBytesPerTick: cloned, tick: rt.curr.tick }));
process.exit(0);

/**
 * [QF-7R] Allocation probe for the in-match HUD (src/ui/hud: scoreboard, toasts, radar, player info, power bar, hints)
 * in live play: run by tests/unit/qf-7r-hud-alloc.test.ts in a child process:
 *   node --allow-natives-syntax --single-threaded --sampling-heap-profiler-suppress-randomness \
 *        --invocation-count-for-turbofan=400 --expose-gc --import tsx tests/unit/qf-7r-hud-alloc-probe.ts [ticks]
 * Prints JSON { perFrame, top } where perFrame = bytes per frame allocated by code in src/ui/ (exact: every allocation
 * sampled, EXACT_INTERVAL), over a live human v CPU match (real sim, real events) at two HUD frames per tick.
 *
 * The DOM is a stand-in (Node has none) whose methods and canvas context are kept out of the optimiser: like the
 * browser's bindings they are never inlined into the HUD, so a fractional number the HUD passes them is boxed (a heap
 * allocation charged to the HUD), and a string the HUD builds is the HUD's. The stand-in itself allocates nothing per
 * call (its own allocation would be charged to this file anyway).
 */
import '../../tools/lib/env';
import { register } from 'node:module';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import { installFakeDom } from './qf-7r-fake-dom';
import type { AppContext, FrameInfo } from '../../src/contracts/app';
import { createInputFrame, type CameraProjector } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const TICKS = Number(process.argv[2] ?? 4000);
const nat = (0, eval)('(f) => %NeverOptimizeFunction(f)') as (f: unknown) => void;

// ---- DOM stand-in (methods out of the optimiser, like the browser's bindings).
const dom = installFakeDom({ neverOptimize: nat });
const noop = (): void => {};

// ---- The HUD in a live match. Asset imports (Vite `?url` fonts) load as empty URLs.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {' +
  ' if (/\\.(woff2?|png|svg|css)(\\?|$)/.test(url)) return { format: "module", source: "export default \'\';", shortCircuit: true };' +
  ' return next(url, ctx); }',
));
const { createHud } = await import('../../src/ui/hud/index');
const settings = createSettingsStore(createMemoryStorage());
const appCtx = {
  settings,
  session: { getSetup: () => null },
  devices: { list: () => [], lastActive: () => null },
  platform: { isTouch: false },
  audio: { playUi: noop },
} as unknown as AppContext;
const hud = createHud();
hud.mount(dom.root as unknown as HTMLElement, appCtx);
const cfg = createMatchConfig();
cfg.seed = 20261023;
let curr = initMatch(cfg);
let prev = cloneState(curr);
hud.setMatch(curr, CLUBS);
hud.setVisible(true);
const ev = createEventBuffer();
const frames = [createInputFrame(), createInputFrame()];
const info: FrameInfo = { nowMs: 0, dtMs: 1000 / 120, frame: 0, ticks: 1, paused: false };
const projector = {
  pitchToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean { out.x = 590 + x * 9; out.y = 410 + z * 5 - y * 9; return true; },
} as unknown as CameraProjector;
nat(projector.pitchToScreen);
const C = new Float64Array(1);
const K = new Int32Array(2); // [press the power button (0 / 1), HUD frames with P1's power bar charging]
const run = (n: number): void => {
  for (let k = 0; k < n; k++) {
    copyState(prev, curr);
    // With K[0]: the human holds the power button for 40 of every 200 ticks (the power bar over his player).
    frames[0]!.buttons = K[0] === 1 && (curr.tick % 200) < 40 ? 1 << 2 : 0;
    step(curr, frames, ev);
    if (ev.count > 0) hud.onEvents(ev, curr);
    for (let a = 1; a <= 2; a++) {
      info.frame++;
      C[0] = C[0]! + 1000 / 120;
      info.nowMs = C[0]!;
      info.ticks = a === 1 ? 1 : 0;
      hud.update(curr, info, projector);
      if (curr.ctrl[0]!.powerBtn !== 0) K[1]++;
    }
  }
};
nat(run);
const WARM = 3600;
const session = new Session();
session.connect();
type PNode = { id: number; callFrame: { url: string; functionName: string }; children: PNode[] };
/** Bytes allocated by src/ui/ code during run(TICKS), by site; and by the power bar. */
async function window(press: number): Promise<{ bytes: number; count: number; power: number; charging: number; by: Record<string, number> }> {
  K[0] = press;
  // Every situation of the window once (JIT feedback): the same fresh match, so a code path first taken in the window
  // (a toast kind, a set-piece hint) is warm when measured. Continuing the previous window's match instead warmed a
  // different stretch: whatever first ran in the measured window was charged with its tier-up (unoptimised double
  // arithmetic, lazy compilation, ~2.5 B per frame when FEEL-1 reshaped the match), not with a per-frame allocation.
  curr = initMatch(cfg);
  prev = cloneState(curr);
  hud.setMatch(curr, CLUBS);
  run(WARM + TICKS);
  curr = initMatch(cfg);
  prev = cloneState(curr);
  hud.setMatch(curr, CLUBS);
  run(WARM);
  (globalThis as { gc?: () => void }).gc?.();
  K[1] = 0;
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  run(TICKS);
  // The inspector typings omit `samples` (present with suppress-randomness) and a node's `id`: read the raw shape.
  const profile = (await session.post('HeapProfiler.stopSampling')).profile as unknown as {
    head: PNode; samples: { size: number; nodeId: number }[];
  };
  const where = new Map<number, string>();
  const index = (nd: PNode): void => {
    const u = nd.callFrame.url;
    const i = u.indexOf('/src/ui/');
    if (i >= 0) where.set(nd.id, u.slice(i + 8) + ':' + nd.callFrame.functionName);
    for (const c of nd.children) index(c);
  };
  index(profile.head);
  let bytes = 0, power = 0, count = 0;
  const by: Record<string, number> = {};
  for (const smp of profile.samples) {
    const w = where.get(smp.nodeId);
    if (w === undefined) continue;
    bytes += smp.size;
    if (!w.startsWith('hud/powerBar.ts')) count++; // every allocation is one sample (EXACT_INTERVAL)
    if (w.startsWith('hud/powerBar.ts')) power += smp.size;
    const key = `${w} (${smp.size} B)`;
    by[key] = (by[key] ?? 0) + smp.size;
  }
  return { bytes, count, power, charging: K[1]!, by };
}
const f = 2 * TICKS;
const top = (by: Record<string, number>): [string, number][] =>
  Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map((e) => [e[0], Math.round((e[1] / f) * 100) / 100]);
const steady = await window(0);
const charge = await window(1);
console.log(JSON.stringify({
  perFrame: steady.bytes / f,
  // Allocations (not bytes) per 1000 frames, the power bar aside: a periodic allocation shows by its rate whatever its
  // size (one 16-byte number per radar redraw = 167 per 1000 frames at 20 Hz on a 120 Hz display; 2.7 B per frame).
  allocsPerKFrame: (steady.count / f) * 1000,
  chargingAllocsPerKFrame: (charge.count / f) * 1000,
  chargingPerFrame: (charge.bytes - charge.power) / f,
  powerPerChargingFrame: charge.charging > 0 ? charge.power / charge.charging : -1,
  chargingFrames: charge.charging,
  top: top(steady.by), topCharging: top(charge.by),
}));
process.exit(0);

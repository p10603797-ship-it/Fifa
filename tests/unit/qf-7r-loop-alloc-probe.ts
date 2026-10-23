/**
 * [QF-7R] Allocation probe for the app's own per-frame work around the renderer: run by
 * tests/unit/qf-7r-loop-alloc.test.ts in a child process (--allow-natives-syntax + tests/perf/qf-7r-alloc-flags):
 *   node --allow-natives-syntax --single-threaded --sampling-heap-profiler-suppress-randomness \
 *        --invocation-count-for-turbofan=400 --expose-gc --import tsx tests/unit/qf-7r-loop-alloc-probe.ts [frames]
 * Prints JSON { <case>: bytes per frame }, exact (every allocation sampled: EXACT_INTERVAL).
 *  - loop60 / loop120: src/app/loop.ts + loopMath.ts on a fractional rAF clock at 60 Hz and at 120 Hz (alternating
 *    0 / 1 ticks per frame), presentation stand-ins that allocate nothing; bytes allocated by code in src/app/.
 *  - audio60: the same loop with the real audio engine (src/audio/engine.ts and its modules: crowd bed, sfx, whistles,
 *    voices, ui; a stand-in Web Audio context whose clock advances) in a live match, and boot's afterFrame work (the
 *    renderer's camera x to audio.setCameraX every frame); bytes allocated by code in src/app/ and src/audio/.
 * The driver and the stand-ins are kept out of the optimiser: the real renderer and HUD are far too large for V8 to
 * inline into the loop, so a number the loop passes them crosses a real call (boxed if it is a double), as in the
 * browser; and loop code is never inlined into the driver (an allocation is charged to the physical frame).
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import type { AudioEngine, FrameInfo, GameRenderer, HudPart } from '../../src/contracts/app';
import { MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type ReadonlySimState, type SimState } from '../../src/contracts/state';
import { createLoop, type GameLoop } from '../../src/app/loop';
import type { FrameStats, MatchRuntime } from '../../src/app/types';
import { createAudioEngine } from '../../src/audio/engine';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';

const FRAMES = Number(process.argv[2] ?? 20000);
const never = (f: unknown): void => { (0, eval)('(f) => %NeverOptimizeFunction(f)')(f); };

const cfg = createMatchConfig();
cfg.humans = cfg.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
const curr = initMatch(cfg);
curr.match.phase = MatchPhase.IN_PLAY;
const prev = cloneState(curr);
const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
const events = createEventBuffer();
const provider = {
  pump(_now: number) {}, ready(_t: number) { return true; }, take(_t: number, _out: InputFrame[], _s: SimState) {},
  releaseAll() {}, dispose() {},
};
const rt = { prev, curr, provider, frames, events, stats: { onTick(_s: ReadonlySimState, _e: unknown) {} } } as unknown as MatchRuntime;
const session = { runtime: () => rt, ticking: true, paused: false, afterTick(_r: MatchRuntime) {} };
const sink = new Float64Array(4);
const renderer = {
  render(_p: ReadonlySimState, c: ReadonlySimState, alpha: number, f: FrameInfo) { sink[0] = alpha + f.dtMs + c.tick; },
  onEvents() {},
} as unknown as GameRenderer;
const hud = { update(_s: ReadonlySimState, f: FrameInfo) { sink[1] = f.nowMs; }, onEvents() {} } as unknown as HudPart;
const fakeAudio = { update(_s: ReadonlySimState | null, dt: number) { sink[2] = dt; }, onEvents() {} } as unknown as AudioEngine;
const afterStats = (f: FrameInfo, st: Readonly<FrameStats>): void => { sink[3] = f.frame + st.busyMs; };
const router = { current: 'match', currentScreen: () => null };
// Clock: C[0] rAF time, C[1] the high-resolution clock, C[2] the broadcast camera's x.
const C = new Float64Array(3);
const step = (s: SimState): void => { s.tick++; }; // the loop's cost, not the sim's (QF-7S)
for (const fn of [renderer.render, renderer.onEvents, hud.update, hud.onEvents, fakeAudio.update, fakeAudio.onEvents, afterStats]) never(fn);

// ---- A stand-in Web Audio context (allocation-free once built: pooled sources) and window.
const param = (): Record<string, unknown> => {
  const p: Record<string, unknown> = { value: 0, defaultValue: 0 };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) p[m] = () => p;
  return p;
};
const node = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ connect() {}, disconnect() {}, ...extra });
const srcPool: Record<string, unknown>[] = [];
let srcNext = 0;
const ac = {
  state: 'suspended', currentTime: 0, sampleRate: 48000, destination: node(),
  createGain: () => node({ gain: param() }),
  createStereoPanner: () => node({ pan: param() }),
  createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
  createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param(), gain: param(), detune: param() }),
  createOscillator: () => node({ type: 'sine', frequency: param(), detune: param(), start() {}, stop() {}, onended: null }),
  createBuffer: (ch: number, len: number, sr: number) => {
    const data: Float32Array[] = [];
    for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c: number) => data[c] };
  },
  createBufferSource: () => srcPool[srcNext++ & 255],
  resume: () => { ac.state = 'running'; for (const fn of listeners) fn(); return Promise.resolve(); },
  suspend: () => Promise.resolve(),
  close: () => Promise.resolve(),
  addEventListener: (_t: string, fn: () => void) => { listeners.push(fn); },
  removeEventListener: () => {},
};
const listeners: (() => void)[] = [];
for (let i = 0; i < 256; i++) srcPool.push(node({ buffer: null, loop: false, loopStart: 0, loopEnd: 0, onended: null, playbackRate: param(), detune: param(), start() {}, stop() {} }));
(globalThis as Record<string, unknown>).window = { addEventListener() {}, removeEventListener() {} };
const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => ac as unknown as AudioContext, now: () => C[1]! });
await engine.unlock();
for (let i = 0; i < 8; i++) await Promise.resolve();
engine.services!.bank.flush();
engine.matchStart(curr);
// boot.ts afterFrame: the renderer's camera x to the audio engine every frame (the stand-in renderer's cameraX is
// kept out of the optimiser like the real one would be out of reach: it returns a fresh double each frame).
const cameraX = (): number => C[2]!;
never(cameraX);
const afterAudio = (f: FrameInfo, st: Readonly<FrameStats>): void => {
  sink[3] = f.frame + st.busyMs;
  engine.setCameraX(cameraX());
};

const deps = {
  session, renderer, hud, router: router as never, getProjector: () => null, onError: (e: unknown) => { throw e; },
  step: step as never, copyState: () => {}, now: () => C[1]!, raf: () => 1, caf: () => {},
};
const loopFake = createLoop({ ...deps, audio: fakeAudio, afterFrame: afterStats });
const loopAudio = createLoop({ ...deps, audio: engine, afterFrame: afterAudio });

const results: Record<string, number> = {};
const profiler = new Session();
profiler.connect();

async function measure(name: string, loop: GameLoop, hz: number, files: RegExp): Promise<void> {
  const driver = (n: number): void => {
    for (let i = 0; i < n; i++) {
      C[0] = C[0]! + 1000 / hz;
      C[1] = C[1]! + 0.01;
      C[2] = 10 * Math.sin(C[0]! / 3000);
      ac.currentTime += 1 / hz;
      loop.frame(C[0]!);
    }
  };
  never(driver);
  loop.start();
  driver(30000);
  (globalThis as { gc?: () => void }).gc?.();
  await profiler.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  driver(FRAMES);
  type Node = { id: number; callFrame: { url: string; functionName: string }; children: Node[] };
  // The inspector typings omit `samples` (present with suppress-randomness) and a node's `id`: read the raw shape.
  const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
    head: Node; samples: { size: number; nodeId: number }[];
  };
  loop.stop();
  const where = new Map<number, string>();
  const index = (nd: Node): void => {
    const u = nd.callFrame.url;
    const m = files.exec(u);
    if (m) where.set(nd.id, u.slice(m.index + 5) + ':' + nd.callFrame.functionName);
    for (const c of nd.children) index(c);
  };
  index(profile.head);
  let bytes = 0;
  const sites: Record<string, number> = {};
  for (const s of profile.samples) {
    const w = where.get(s.nodeId);
    if (w === undefined) continue;
    bytes += s.size;
    sites[`${w} (${s.size} B)`] = (sites[`${w} (${s.size} B)`] ?? 0) + 1 / FRAMES;
  }
  results[name] = bytes / FRAMES;
  if (process.env.SITES) console.error(name, JSON.stringify(sites));
}

C[0] = 1000.37;
await measure('loop60', loopFake, 60, /\/src\/app\//);
await measure('loop120', loopFake, 120, /\/src\/app\//);
await measure('audio60', loopAudio, 60, /\/src\/(app|audio)\//);
console.log(JSON.stringify(results));
process.exit(0);

/**
 * [QF-7R] Allocation probe for the in-match input paths with real analogue values (run by
 * tests/unit/qf-7r-input-alloc.test.ts in a child process with --allow-natives-syntax and tests/perf/qf-7r-alloc-flags):
 *   node --allow-natives-syntax --single-threaded --sampling-heap-profiler-suppress-randomness --expose-gc \
 *        --import tsx tests/unit/qf-7r-input-alloc-probe.ts [frames]
 * Prints JSON { <path>: bytes per animation frame allocated by code in src/input/ }.
 *
 * Measured with V8's sampling heap profiler and attributed by the allocating function's file, so the driver's own
 * arithmetic (a fractional clock, stick values) is not counted; the driver loop is kept out of the optimiser
 * (%NeverOptimizeFunction) so input code is never inlined into it (an allocation is attributed to the physical frame).
 *  - padSticks: a pad source (PAD-02 mapper + the real PAD-05 right-stick tracker + PAD-04 sequences) polled every
 *    frame at 120 Hz on a fractional clock, sampled every second frame, both sticks sweeping circles (analogue values,
 *    flicks and strokes through the tracker), buttons toggling, the controlled player facing a fractional direction.
 *  - padRotated: the same under a camera with a stick rotation (End to End camera).
 *  - keyboardPlay: the keyboard source with diagonal movement, right-stick keys and D-pad taps.
 */
import '../../tools/lib/env';
import { Session } from 'node:inspector/promises';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type CameraProjector, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { createKeyboardSource } from '../../src/input/keyboard';
import { createPadManager } from '../../src/input/pad/manager';
import { createPadSource } from '../../src/input/pad/mapper';
import { initMatch } from '../../src/sim/init';

const FRAMES = Number(process.argv[2] ?? 20000);
const never = (f: unknown): void => { (0, eval)('(f) => %NeverOptimizeFunction(f)')(f); };

const cfg = createMatchConfig();
cfg.humans = [
  { kind: ControllerKind.HUMAN, side: 0, assist: 0, autoSwitch: 0, fastPower: 0 },
  { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
];
const s = initMatch(cfg);
s.match.phase = MatchPhase.IN_PLAY;
s.ctrl[0]!.slot = 9;
s.players[9]!.ctrl = 0;
s.players[9]!.fx = 0.8; s.players[9]!.fz = 0.6;
s.ball.owner = 9;

/** Clock and stick values in typed arrays: the driver allocates as little as possible itself (and is not counted). */
const C = new Float64Array(4);

const results: Record<string, number> = {};
const sites: Record<string, number> = {};
const session = new Session();
session.connect();

type Path = { name: string; frame: (i: number) => void; driver: (n: number, from: number) => void; at: number };
const paths: Path[] = [];

/** Register a path: its per-frame step runs from a never-optimised driver (input code stays in its own frames). */
function path(name: string, frame: (i: number) => void): void {
  const driver = (n: number, from: number): void => { for (let i = 0; i < n; i++) frame(from + i); };
  never(driver);
  never(frame);
  paths.push({ name, frame, driver, at: 0 });
}

async function measure(p: Path): Promise<void> {
  (globalThis as { gc?: () => void }).gc?.();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  if (process.env.SITES) console.error('WINDOW-START ' + p.name);
  p.driver(FRAMES, p.at);
  p.at += FRAMES;
  if (process.env.SITES) console.error('WINDOW-END ' + p.name);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  let bytes = 0;
  const walk = (nd: { selfSize: number; callFrame: { url: string; functionName: string }; children: unknown[] }): void => {
    const u = nd.callFrame.url;
    if (nd.selfSize > 0 && u.includes('/src/input/')) {
      bytes += nd.selfSize;
      if (process.env.SITES) sites[p.name + ' ' + u.slice(u.indexOf('/src/input/') + 11) + ':' + nd.callFrame.functionName] = nd.selfSize / FRAMES;
    }
    for (const c of nd.children) walk(c as typeof nd);
  };
  walk(profile.head as never);
  results[p.name] = bytes / FRAMES;
}

// ---- pad
interface MockButton { pressed: boolean; touched: boolean; value: number }
function mockPad(): { id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[]; buttons: MockButton[] } {
  return {
    id: 'Probe pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}

function padPath(name: string, rot: number): void {
  const pad = mockPad();
  const list = [pad, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  C[0] = 1000.5;
  mgr.poll(C[0]);
  const src = createPadSource({ key: 'pad:1', manager: mgr, now: () => C[0]!, onPause: () => {} });
  const projector: CameraProjector | null = rot === 0 ? null : {
    screenToPitch: () => false, pitchToScreen: () => false, stickRotation: () => rot,
  };
  const out = createInputFrame();
  const ctx: { -readonly [K in keyof InputSampleContext]: InputSampleContext[K] } = { tick: 1, human: 0, side: 0, state: s, projector };
  path(name, (i) => {
    C[0] = C[0]! + 1000 / 120;
    // Left stick: a slow circle; right stick: strokes out and back (flicks, holds, rolls through sectors).
    const a = i * 0.013;
    pad.axes[0] = Math.cos(a) * 0.83; pad.axes[1] = Math.sin(a) * 0.83;
    const k = i % 90;
    const r = k < 30 ? 0 : k < 60 ? 0.95 : 0.2;
    pad.axes[2] = Math.cos(i * 0.05) * r; pad.axes[3] = Math.sin(i * 0.05) * r;
    const b = (i >> 3) % 16;
    if (b !== 9 && b !== 8) { // never Options / Share (pause, system)
      const on = ((i >> 7) & 1) === 0;
      pad.buttons[b]!.pressed = on; pad.buttons[b]!.value = on ? 1 : 0;
    }
    pad.timestamp = i;
    src.pollFrame!(C[0]!);
    if ((i & 1) === 0) { ctx.tick = i >> 1; src.sample(out, ctx); }
  });
}

// ---- keyboard
function keyboardPath(): void {
  const kt = new EventTarget();
  C[1] = 1000.5;
  const kb = createKeyboardSource({ onPause: () => {}, target: kt, doc: new EventTarget(), now: () => C[1]! });
  const out = createInputFrame();
  const ctx: { -readonly [K in keyof InputSampleContext]: InputSampleContext[K] } = { tick: 1, human: 0, side: 0, state: s, projector: null };
  const key = (type: string, code: string): void => {
    const e = new Event(type);
    Object.defineProperty(e, 'code', { value: code });
    kt.dispatchEvent(e);
  };
  for (const code of ['KeyD', 'KeyW']) key('keydown', code);
  path('keyboardPlay', (i) => {
    C[1] = C[1]! + 1000 / 120;
    // Right-stick keys (numpad) and a D-pad tap now and then: events are rare next to frames (not counted per frame).
    if (i % 240 === 0) key('keydown', 'Numpad6');
    if (i % 240 === 20) key('keyup', 'Numpad6');
    kb.pollFrame!(C[1]!);
    if ((i & 1) === 0) { ctx.tick = i >> 1; kb.sample(out, ctx); }
  });
}

// Several sources at once, as in a match with two humans: the shared code (tracker, mapper, axes) sees every source
// before the measurement (a second instance re-tiers the closures it shares with the first: warm-up, not steady play).
padPath('padSticks', 0);
padPath('padRotated', Math.PI / 2);
keyboardPath();
for (let round = 0; round < 3; round++) for (const p of paths) { p.driver(15000, p.at); p.at += 15000; }
for (const p of paths) await measure(p);

if (process.env.SITES) console.error(JSON.stringify(sites, null, 1));
console.log(JSON.stringify(results));
process.exit(0);

/**
 * [GFX-04] Allocation probe for the goals module (run by tests/unit/gfx-04-goals.test.ts in a child process):
 * node --import tsx tests/unit/gfx-04-alloc-probe.ts [n]
 * Uses the V8 sampling heap profiler (objects already collected included) and counts the allocations made under the
 * module's update() or onEvents() in src/render/goals.ts (any frame of the allocation's stack, inlined frames too).
 * Prints JSON { frames, impacts, events, rareEvents }:
 *  - frames: bytes per update() in steady play near the goal while a ripple and a frame shake run;
 *  - impacts: bytes per update() over cycles with a net entry and a side-netting contact;
 *  - events: bytes per onEvents() call with a NET + POST pair (hot, as in a long match: optimised code);
 *  - rareEvents: bytes per NET + POST pair when they come once every 72 frames, as in play. That code runs so rarely
 *    that V8 keeps it in the interpreter, where double arithmetic is boxed: a few hundred bytes per event.
 */
import { Session } from 'node:inspector';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { QualityTier } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { createGoals } from '../../src/render/goals';
import { fillInterp } from '../../src/render/index';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const n = Number(process.argv[2] ?? 30000);
const FILE = /src\/render\/goals\.ts$/;

// ---------------------------------------------------------------- allocation sampling (V8 sampling heap profiler)

const session = new Session();
session.connect();
function post<R>(method: string, params: object = {}): Promise<R> {
  return new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r as R))));
}
interface SampleNode { callFrame: { url: string; functionName: string }; selfSize: number; children: SampleNode[] }

/**
 * Bytes allocated under each of the functions `fns` of the files matching `file` (any frame of the allocation's stack,
 * inlined frames included) while f runs n times, after `warm` runs for the JIT. Sampling heap profiler, 32-byte mean
 * interval, objects collected by minor / major GCs included. Returns total bytes per function name.
 */
async function sample(f: (i: number) => void, file: RegExp, fns: readonly string[], warm = 20000): Promise<Record<string, number>> {
  for (let i = 0; i < warm; i++) f(i);
  await post('HeapProfiler.startSampling', {
    samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < n; i++) f(i);
  const { profile } = await post<{ profile: { head: SampleNode } }>('HeapProfiler.stopSampling');
  const out: Record<string, number> = {};
  for (const fn of fns) out[fn] = 0;
  const walk = (node: SampleNode, under: string): void => {
    const cf = node.callFrame;
    const here = under === '' && file.test(cf.url) && fns.includes(cf.functionName) ? cf.functionName : under;
    if (here !== '') out[here] = out[here]! + node.selfSize;
    for (const c of node.children) walk(c, here);
  };
  walk(profile.head, '');
  return out;
}

// ---------------------------------------------------------------- scene

const settings = createDefaultSettings();
const ctx: RenderContext = {
  renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
  settings, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
  cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
};
const s = initMatch(createMatchConfig());
const goals = createGoals(ctx);
goals.setMatch!(s, []);
const interp = createInterpState();
fillInterp(interp, s, s, 1);
const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };

const evs: SimEvent[] = [
  { type: EventType.NET, tick: 0, a: 1, b: 0, c: 24, d: 0, x: HALF_LENGTH + 0.2, y: 1.1, z: 0.5 },
  { type: EventType.POST, tick: 0, a: -1, b: 1, c: 18, d: 0, x: -HALF_LENGTH, y: 2.5, z: 1 },
];
const buf: EventBuffer = { count: 2, get: (i: number) => evs[i]!, begin() { /* fixed */ }, emit() { /* fixed */ } };
s.ball.vx = 24; s.ball.vy = 0.5; s.ball.vz = 1;

/**
 * One frame of a 1.2 s (72-frame) cycle: NET + POST events at the start (a ripple and a frame shake then run) and
 * the interpolated ball in front of the goal mouth, moving but never touching the net.
 */
function steady(i: number): void {
  const k = i % 72;
  interp.ballX = HALF_LENGTH - 3 + k * 0.03; interp.ballY = 0.4; interp.ballZ = 0.5 + k * 0.01;
  frame.frame.frame++;
  frame.frame.nowMs += 1000 / 60;
  if (k === 0) goals.onEvents!(buf, s);
  goals.update(frame);
}

/** A 72-frame cycle: the ball flies into the +x net (an entry), then rolls against the outside of the side netting. */
function impacts(i: number): void {
  const k = i % 72;
  if (k < 20) { interp.ballX = HALF_LENGTH - 1 + k * 0.15; interp.ballY = 1.1; interp.ballZ = 0.5; }
  else if (k < 50) { interp.ballX = HALF_LENGTH + 0.5 + (k - 20) * 0.03; interp.ballY = 0.4; interp.ballZ = GOAL_HALF_WIDTH + 0.6 - (k - 20) * 0.03; }
  else { interp.ballX = 0; interp.ballY = 0.11; interp.ballZ = 0; }
  frame.frame.frame++;
  frame.frame.nowMs += 1000 / 60;
  goals.update(frame);
}

function events(): void {
  goals.onEvents!(buf, s);
}

const FNS = ['update', 'onEvents'] as const;

void (async () => {
  const res: Record<string, number> = {};
  const st = await sample(steady, FILE, FNS);
  res.frames = st.update! / n;
  res.rareEvents = st.onEvents! / (n / 72);
  res.impacts = (await sample(impacts, FILE, FNS)).update! / n;
  res.events = (await sample(events, FILE, FNS)).onEvents! / n;
  session.disconnect();
  console.log(JSON.stringify(res));
})();

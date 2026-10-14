/**
 * [GFX-04] Allocation probe for the per-frame paths of the goals module (run by tests/unit/gfx-04-goals.test.ts in a
 * child process): node --expose-gc --import tsx tests/unit/gfx-04-alloc-probe.ts [n]
 * Prints JSON { frames, events }: bytes allocated per frame by update() while ripples and a frame shake run and the
 * ball moves through / against the net (contact detection), and per onEvents() call with a NET + POST pair. The
 * harness's own per-frame cost is measured without the module calls and subtracted. A boxed double alone is 12 bytes.
 */
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

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const n = Number(process.argv[2] ?? 50000);

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

let callModule = true;
/**
 * One frame of a 1.2 s cycle: events at the start (the shake and the ripple then run), the ball flies into the +x
 * net, then rolls along the outside of the side netting (contacts), then sits still.
 */
function one(i: number): void {
  const k = i % 72;
  if (k < 20) { interp.ballX = HALF_LENGTH - 1 + k * 0.15; interp.ballY = 1.1; interp.ballZ = 0.5; }
  else if (k < 50) { interp.ballX = HALF_LENGTH + 0.5 + (k - 20) * 0.03; interp.ballY = 0.4; interp.ballZ = GOAL_HALF_WIDTH + 0.6 - (k - 20) * 0.03; }
  else { interp.ballX = 0; interp.ballY = 0.11; interp.ballZ = 0; }
  frame.frame.frame++;
  frame.frame.nowMs += 1000 / 60;
  if (!callModule) return;
  if (k === 0) goals.onEvents!(buf, s);
  goals.update(frame);
}

function perCall(f: (i: number) => void): number {
  for (let i = 0; i < 20000; i++) f(i);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    gc!();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) f(i);
    const per = (process.memoryUsage().heapUsed - h0) / n;
    if (per < best) best = per;
  }
  return best;
}

let eventsOnly = false;
function ev(i: number): void {
  if (eventsOnly) goals.onEvents!(buf, s);
  frame.frame.frame = i;
}

const res: Record<string, number> = {};
callModule = false;
const base = perCall(one);
callModule = true;
res.frames = perCall(one) - base;
const evBase = perCall(ev);
eventsOnly = true;
res.events = perCall(ev) - evBase;
console.log(JSON.stringify(res));

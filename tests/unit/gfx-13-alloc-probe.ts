/**
 * [GFX-13] Allocation probe for the per-frame paths of the ball / blob shadows and on-pitch aids modules (run by
 * tests/unit/gfx-13-ball.test.ts in a child process): node --import tsx tests/unit/gfx-13-alloc-probe.ts [n]
 * Uses the V8 sampling heap profiler (objects already collected included) and counts the allocations made under the
 * modules' update() (src/render/ball.ts, src/render/markers.ts; any frame of the stack, inlined frames too).
 * Prints JSON { ball, markers, markersArrow }: bytes per update() frame. Every aid is on (two humans, receiver ring,
 * next-switch marker, power bar, landing target with a re-prediction per kick, colour-blind labels); the arrow case
 * keeps the ball off screen.
 */
import { Session } from 'node:inspector';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { createBall } from '../../src/render/ball';
import { fillInterp } from '../../src/render/index';
import { createMarkers } from '../../src/render/markers';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const n = Number(process.argv[2] ?? 30000);

// ---------------------------------------------------------------- allocation sampling (V8 sampling heap profiler)

const session = new Session();
session.connect();
function post<R>(method: string, params: object = {}): Promise<R> {
  return new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r as R))));
}
interface SampleNode { callFrame: { url: string; functionName: string }; selfSize: number; children: SampleNode[] }

/**
 * Bytes allocated per run of f under the function `fn` of the file matching `file` (any frame of the allocation's
 * stack, inlined frames included): f runs `warm` times for the JIT, then n times under the sampling heap profiler
 * (32-byte mean interval, objects collected by minor / major GCs included).
 */
async function bytesUnder(f: (i: number) => void, file: RegExp, fn: string, warm = 20000): Promise<number> {
  for (let i = 0; i < warm; i++) f(i);
  await post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < n; i++) f(i);
  const { profile } = await post<{ profile: { head: SampleNode } }>('HeapProfiler.stopSampling');
  let bytes = 0;
  const walk = (node: SampleNode, under: boolean): void => {
    const hit = under || (file.test(node.callFrame.url) && node.callFrame.functionName === fn);
    if (hit) bytes += node.selfSize;
    for (const c of node.children) walk(c, hit);
  };
  walk(profile.head, false);
  return bytes / n;
}

const settings = createDefaultSettings();
settings.accessibility.colourBlindMarkers = true;
const cam = new PerspectiveCamera(22, 1180 / 820, 2, 600);
cam.position.set(0, 24, 74);
cam.lookAt(0, 0, 0);
cam.updateMatrixWorld();
cam.updateProjectionMatrix();
const ctx: RenderContext = {
  renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: cam, settings, clubs: [],
  size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED, cameraSettings: { ...settings.camera },
  reducedMotion: false, night: false,
};

const s = initMatch(createMatchConfig());
s.match.phase = MatchPhase.IN_PLAY;
for (let i = 0; i < NUM_SLOTS; i++) {
  const p = s.players[i]!;
  p.active = 1; p.ctrl = -1;
  p.x = (i < 11 ? -1 : 1) * (4 + (i % 11) * 3); p.z = ((i % 5) - 2) * 6;
}
for (let c = 0; c < s.ctrl.length; c++) { const k = s.ctrl[c]!; k.kind = ControllerKind.NONE; k.slot = -1; }
const c0 = s.ctrl[0]!, c1 = s.ctrl[1]!;
c0.kind = ControllerKind.HUMAN; c0.side = 0; c0.slot = 9; c0.nextSwitch = 6; c0.powerBtn = 1; c0.power = 0.5; c0.receiver = 7;
c1.kind = ControllerKind.HUMAN; c1.side = 1; c1.slot = 20; c1.nextSwitch = 15;
const b = s.ball;
b.owner = -1; b.heldBy = -1; b.inNet = 0; b.shotBy = -1; b.passTarget = 7; b.lastTouchTeam = 0;

const ball = createBall(ctx);
const markers = createMarkers(ctx);
ball.setMatch!(s, []);
markers.setMatch!(s, []);
const interp = createInterpState();
const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };

/** One frame: a lofted ball flying over the halfway line (or far off screen), re-kicked every 2 s. */
let offScreen = false;
function step(i: number): void {
  const k = i % 120;
  b.x = offScreen ? 70 + k * 0.05 : -10 + k * 0.15; b.z = 3; b.y = k < 100 ? 0.5 + 8 * (k / 100) * (1 - k / 100) * 4 : BALL_RADIUS;
  b.vx = 9; b.vy = k < 50 ? 6 : -6; b.vz = 0; b.sx = 0; b.sy = 2; b.sz = 5;
  if (k === 0) { b.lastKickTick = s.tick; b.touchedTick = s.tick; }
  s.tick++;
  c0.power = (i % 60) / 60;
  fillInterp(interp, s, s, 1);
  frame.frame.frame++;
  frame.frame.nowMs += 1000 / 60;
  ball.update(frame); // ball + aids together, as in a real frame
  markers.update(frame);
}

/** Ball module alone: a ball rolling, then in the air. */
function ballFrame(i: number): void {
  const k = i % 120;
  interp.ballX = -10 + k * 0.15; interp.ballY = k < 60 ? BALL_RADIUS : 2 + (k % 7) * 0.3; interp.ballZ = 3;
  frame.frame.frame++;
  ball.update(frame);
}

const BALL_FILE = /src\/render\/ball\.ts$/;
const MARKERS_FILE = /src\/render\/markers\.ts$/;

void (async () => {
  const res: Record<string, number> = {};
  res.ball = await bytesUnder(ballFrame, BALL_FILE, 'update');
  res.markers = await bytesUnder(step, MARKERS_FILE, 'update');
  offScreen = true;
  res.markersArrow = await bytesUnder(step, MARKERS_FILE, 'update');
  session.disconnect();
  console.log(JSON.stringify(res));
})();

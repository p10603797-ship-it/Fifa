/**
 * [GFX-13] Allocation probe for the per-frame paths of the ball / blob shadows and on-pitch aids modules (run by
 * tests/unit/gfx-13-ball.test.ts in a child process): node --expose-gc --import tsx tests/unit/gfx-13-alloc-probe.ts [n]
 * Prints JSON { ball, markers, markersArrow }: bytes allocated per frame by the module calls (the harness's own
 * per-frame cost is measured without the module calls and subtracted). A boxed double alone is 12 bytes.
 * Every aid is on (two humans, receiver ring, next-switch marker, power bar, landing target with periodic
 * re-prediction, colour-blind labels); the arrow case keeps the ball off screen.
 */
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

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const n = Number(process.argv[2] ?? 50000);

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

/** One frame: a lofted ball flying over the halfway line (or far off screen), periodically re-kicked. */
let drawAids = true;
function step(i: number, offScreen: boolean): void {
  const k = i % 120;
  b.x = offScreen ? 70 + k * 0.05 : -10 + k * 0.15; b.z = 3; b.y = k < 100 ? 0.5 + 8 * (k / 100) * (1 - k / 100) * 4 : BALL_RADIUS;
  b.vx = 9; b.vy = k < 50 ? 6 : -6; b.vz = 0; b.sx = 0; b.sy = 2; b.sz = 5;
  if (k === 0) { b.lastKickTick = s.tick; b.touchedTick = s.tick; }
  s.tick++;
  c0.power = (i % 60) / 60;
  fillInterp(interp, s, s, 1);
  frame.frame.frame++;
  frame.frame.nowMs += 1000 / 60;
  if (!drawAids) return;
  ball.update(frame); // ball + aids together, as in a real frame
  markers.update(frame);
}

/** Bytes allocated per call of f: after a long warm-up (JIT code is heap-allocated too), the least of three rounds. */
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

function measure(offScreen: boolean): number {
  return perCall((i) => step(i, offScreen));
}

let drawBall = true;
/** Ball module alone (markers off): a ball rolling, then in the air. */
function ballFrame(i: number): void {
  const k = i % 120;
  interp.ballX = -10 + k * 0.15; interp.ballY = k < 60 ? BALL_RADIUS : 2 + (k % 7) * 0.3; interp.ballZ = 3;
  frame.frame.frame++;
  if (drawBall) ball.update(frame);
}

// Net bytes per frame: the module's frame minus the same harness frame without the module calls.
const res: Record<string, number> = {};
drawBall = false;
const ballBase = perCall(ballFrame);
drawBall = true;
res.ball = perCall(ballFrame) - ballBase;
drawAids = false;
const base = measure(false);
drawAids = true;
res.markers = measure(false) - base;
res.markersArrow = measure(true) - base;
console.log(JSON.stringify(res));

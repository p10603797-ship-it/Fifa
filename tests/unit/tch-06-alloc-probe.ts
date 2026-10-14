/**
 * [TCH-06] Allocation probe for the set-piece swipe (run by tests/unit/tch-06-alloc.test.ts in a child process, one
 * process per path so V8's inlining decisions for one path do not leak into the next):
 * node --expose-gc --import tsx tests/unit/tch-06-alloc-probe.ts <path> [n]
 * Prints JSON { <path>: bytes allocated per pointer event / frame }:
 *  - moves: a drag from the ball, one move per call, the throttled flight preview refreshed every few moves (a stub
 *    previewFlight that only writes numbers, so this measures setpiece.ts itself);
 *  - frames: the finger resting, update() every 1/60 s (preview refreshed every 2nd frame);
 *  - rul05: moves with the real RUL-05 previewFlight on a ready free kick (contract: allocation-free after first call);
 *  - gestures: a whole swipe (down, 12 moves, lift, emitted gesture) per 14 calls.
 */
import '../../tools/lib/env';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { CameraProjector, InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import type { BallPrediction } from '../../src/contracts/systems';
import { ClusterMode, createTouchIntentState } from '../../src/contracts/touch';
import { createSetPieceSwipe, type PreviewFlightFn } from '../../src/input/touch/setpiece';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const only = process.argv[2] ?? 'moves';
const n = Number(process.argv[3] ?? 20000);

const s: SimState = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 7 });
const ev = createEventBuffer();
ev.begin(s.tick);
awardRestart(s, RestartKind.FREE_KICK, 0, 28, -6, ev);
for (let i = 0; i < 80 && s.match.restart.ready !== 1; i++) runTicks(s, 1);
if (s.match.restart.ready !== 1) throw new Error('free kick not ready');

const proj: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - 600) / 10; out.z = (sy - 400) / 10; return true; },
  pitchToScreen(x, y, z, out) { out.x = 600 + x * 10; out.y = 400 + z * 10 - y * 10; return true; },
  stickRotation: () => 0,
};
const ball = { x: 0, y: 0 };
proj.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, ball);

const stub: PreviewFlightFn = (st: SimState, out: BallPrediction, f: Readonly<InputFrame>) => {
  out.count = 60;
  for (let i = 0; i < 60; i++) {
    out.x[i] = st.ball.x + (i + 1) * 0.004 * f.gdx;
    out.y[i] = 0.11 + (i + 1) * 0.05;
    out.z[i] = st.ball.z + (i + 1) * 0.004 * f.gdz;
  }
  return 1;
};

function control(real: boolean): ReturnType<typeof createSetPieceSwipe> & { st: ReturnType<typeof createTouchIntentState> } {
  const st = createTouchIntentState();
  st.mode = ClusterMode.SET_PIECE;
  const c = createSetPieceSwipe({
    state: st, timers: false, getState: () => s, getProjector: () => proj,
    ballScreen: (o) => proj.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o),
    previewFlight: real ? undefined : stub,
  });
  return Object.assign(c, { st });
}

function measure(fn: () => void, iters = n): number {
  for (let i = 0; i < Math.min(40000, iters * 2); i++) fn();
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    gc!();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < iters; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / iters;
    if (b < best) best = b;
  }
  return best;
}

const result: Record<string, number> = {};
let t = 1000;

// A drag that sweeps back and forth so every move changes the swipe (and the preview) without ending it.
function dragger(real: boolean): () => void {
  const c = control(real);
  t += 100;
  c.down(1, ball.x, ball.y, t);
  let k = 0;
  return () => {
    t += 6;
    const a = (k++ % 200) / 200;
    c.move(1, ball.x + 120 + 80 * a, ball.y - 30 + 60 * a, t);
  };
}
if (only === 'moves') result.moves = measure(dragger(false));

if (only === 'frames') {
  const c = control(false);
  t += 100;
  c.down(1, ball.x, ball.y, t);
  for (let k = 1; k <= 10; k++) c.move(1, ball.x + 20 * k, ball.y - 3 * k, t + 8 * k);
  t += 100;
  // 60 Hz in whole ms (16, 17, 17, ...) so the probe's own clock stays a small integer (no boxed double per call).
  let f = 0;
  result.frames = measure(() => { t += f++ % 3 === 0 ? 16 : 17; c.update(t); });
}

if (only === 'rul05') result.rul05 = measure(dragger(true), Math.floor(n / 4));

if (only === 'gestures') {
  const c = control(false);
  let k = 0;
  result.gestures = measure(() => {
    const p = k++ % 14;
    t += 8;
    if (p === 0) c.down(1, ball.x, ball.y, t);
    else if (p <= 12) c.move(1, ball.x + 18 * p, ball.y - 2 * p, t);
    else { c.up(1, ball.x + 216, ball.y - 24, t); c.st.gestureEventCount = 0; }
  });
}

console.log(JSON.stringify(result));

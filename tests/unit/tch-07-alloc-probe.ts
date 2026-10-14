/**
 * [TCH-07] Allocation probe for the touch mapper's per-tick path (run by tests/unit/tch-07-alloc.test.ts in a child
 * process): node --expose-gc --import tsx tests/unit/tch-07-alloc-probe.ts [n]
 * Prints JSON { <path>: bytes allocated per sample }: idle; stick pushed with strafe and SPRINT held; a busy cycle of
 * button presses (taps, a flicked and a held swipe, a double tap, skills) every 40 ticks; and one pitch gesture every
 * 40 ticks (event handling included).
 */
import '../../tools/lib/env';
import { GestureKind, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type CameraProjector, type InputSampleContext } from '../../src/contracts/input';
import {
  ClusterMode, createTouchIntentState, pushButtonEvent, SwipeDir, TouchButtonId as TB, TouchEdge as E, type TouchGestureEvent,
} from '../../src/contracts/touch';
import { queueGesture } from '../../src/input/touch/gestures';
import { createTouchMapper } from '../../src/input/touch/mapper';
import { makeScenario } from '../harness/scenario';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const n = Number(process.argv[2] ?? 20000);

const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }, { slot: 7, x: 20, z: 5 }], ball: { owner: 9, x: 10.4, z: 0 } });
const proj: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - 600) / 10; out.z = (sy - 400) / 10; return true; },
  pitchToScreen(x, y, z, out) { out.x = 600 + x * 10; out.y = 400 + z * 10 - y * 10; return true; },
  stickRotation: () => 0,
};
const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state: s, projector: proj };
const out = createInputFrame();
const st = createTouchIntentState();
let t = 1000;
const m = createTouchMapper(st, { now: () => t });
const g: TouchGestureEvent = { kind: GestureKind.TAP, sx: 800, sy: 450, ex: 800, ey: 450, vx: 0, vy: 0, curve: 0, tMs: 0, fromBall: false };

function measure(fn: () => void): number {
  for (let i = 0; i < 40000; i++) fn();
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    gc!();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

const result: Record<string, number> = {};
const A = ClusterMode.ATTACK;

result.idle = measure(() => { t += 17; m.sample(out, ctx); });

st.stickActive = true; st.stickX = 0.37; st.stickY = -0.81; st.stickStrafe = true;
pushButtonEvent(st, TB.SPRINT_SKILL, E.DOWN, SwipeDir.NONE, t, A);
result.held = measure(() => { t += 17; m.sample(out, ctx); });
pushButtonEvent(st, TB.SPRINT_SKILL, E.UP, SwipeDir.NONE, t, A);
st.stickActive = false; st.stickX = 0; st.stickY = 0; st.stickStrafe = false;
m.sample(out, ctx);

let k = 0;
result.busy = measure(() => {
  t += 17;
  const p = k++ % 40;
  if (p === 0) { pushButtonEvent(st, TB.PASS, E.DOWN, SwipeDir.NONE, t, A); }
  else if (p === 4) { pushButtonEvent(st, TB.PASS, E.UP, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.PASS, E.TAP, SwipeDir.NONE, t, A); }
  else if (p === 7) { pushButtonEvent(st, TB.PASS, E.DOWN, SwipeDir.NONE, t, A); }
  else if (p === 9) { pushButtonEvent(st, TB.PASS, E.UP, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.PASS, E.DOUBLE_TAP, SwipeDir.NONE, t, A); }
  else if (p === 12) { pushButtonEvent(st, TB.SHOOT, E.DOWN, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.SHOOT, E.SWIPE, SwipeDir.RIGHT, t, A); }
  else if (p === 13) { pushButtonEvent(st, TB.SHOOT, E.UP, SwipeDir.NONE, t, A); }
  else if (p === 20) { pushButtonEvent(st, TB.PASS, E.DOWN, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.PASS, E.SWIPE, SwipeDir.LEFT, t, A); }
  else if (p === 21) { pushButtonEvent(st, TB.PASS, E.UP, SwipeDir.NONE, t, A); }
  else if (p === 16) { pushButtonEvent(st, TB.THROUGH, E.DOWN, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.THROUGH, E.SWIPE, SwipeDir.UP, t, A); }
  else if (p === 26) { pushButtonEvent(st, TB.THROUGH, E.UP, SwipeDir.NONE, t, A); }
  else if (p === 28) { pushButtonEvent(st, TB.SPRINT_SKILL, E.DOWN, SwipeDir.NONE, t, A); pushButtonEvent(st, TB.SPRINT_SKILL, E.SWIPE, SwipeDir.DOWN, t, A); }
  else if (p === 30) { pushButtonEvent(st, TB.SPRINT_SKILL, E.UP, SwipeDir.NONE, t, A); }
  m.sample(out, ctx);
});

let q = 0;
result.gestures = measure(() => {
  t += 17;
  if (q++ % 40 === 0) { g.tMs = t; queueGesture(st, g); }
  m.sample(out, ctx);
});

console.log(JSON.stringify(result));

/**
 * TCH-06 x sim: a set-piece swipe drawn on the real touch controls (createSetPieceSwipe + the TCH-07 mapper) at a free
 * kick awarded by the real rules (RUL-11 awardRestart, RUL-05 free kick), stepped through the real pipeline:
 *  - the dotted preview shows the RUL-05 previewFlight of the swipe while dragging (flight kind, dots toward goal);
 *  - lifting the finger plays the swipe: the taker strikes a free-kick shot toward goal;
 *  - the preview equals the flight the lift plays (the preview frame is the frame the mapper sends).
 * No mocks: whatever RUL-05 / SIM-11 do is what the touch player gets.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame, GestureFlag, type CameraProjector, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createBallPrediction } from '../../src/contracts/systems';
import { ClusterMode, createTouchIntentState } from '../../src/contracts/touch';
import { T_RULES } from '../../src/contracts/tuning';
import { createTouchMapper } from '../../src/input/touch/mapper';
import { createSetPieceSwipe, PreviewKind } from '../../src/input/touch/setpiece';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { previewFlight } from '../../src/sim/rules/freekick';
import { makeScenario, runTicks } from '../harness/scenario';

const TICK = 1000 / 60;
/** Top-down camera: 10 px per metre, centre spot at (600, 400); height moves a point up the screen. */
const K = 10, CX = 600, CY = 400;
const PROJ: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - CX) / K; out.z = (sy - CY) / K; return true; },
  pitchToScreen(x, y, z, out) { out.x = CX + x * K; out.y = CY + z * K - y * K; return true; },
  stickRotation: () => 0,
};

/** P1 (home, attacking +x) has a free kick at (x, z), run until the restart is ready. */
function readyFreeKick(x: number, z: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 7 });
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, RestartKind.FREE_KICK, 0, x, z, ev);
  expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  for (let i = 0; i < T_RULES.restartSetupTicks + 10 && s.match.restart.ready !== 1; i++) runTicks(s, 1);
  expect(s.match.restart.ready).toBe(1);
  return s;
}

describe('TCH-06 x sim: free kick at goal on touch', () => {
  it('a swipe from the ball toward goal previews the RUL-05 flight while dragging and shoots at the lift', () => {
    const s = readyFreeKick(HALF_LENGTH - 24, -6);
    const st = createTouchIntentState();
    let clock = 0;
    const mapper = createTouchMapper(st, { now: () => clock });
    const sp = createSetPieceSwipe({
      state: st, timers: false, getState: () => s, getProjector: () => PROJ,
      ballScreen: (o) => PROJ.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o),
    });
    // One sample sets SET_PIECE from the restart (the taking side).
    const out = createInputFrame();
    mapper.sample(out, { tick: s.tick, human: 0, side: 0, state: s, projector: PROJ });
    expect(st.mode).toBe(ClusterMode.SET_PIECE);

    const ball = { x: 0, y: 0 };
    PROJ.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, ball);
    expect(sp.hit(ball.x + 3, ball.y + 2)).toBe(true);
    // Swipe toward the goal centre on screen, slightly curved, at ~1.6 px/ms.
    const goal = { x: 0, y: 0 };
    PROJ.pitchToScreen(HALF_LENGTH, 0, 0, goal);
    clock = 1000;
    sp.down(1, ball.x + 3, ball.y + 2, clock);
    expect(st.previewCount).toBe(1); // the ball dot: pressed state at touch-down
    const steps = 12;
    let sawFlight = false;
    for (let k = 1; k <= steps; k++) {
      clock += 8;
      const f = k / steps;
      const bend = Math.sin(f * Math.PI) * 8;
      sp.move(1, ball.x + (goal.x - ball.x) * 0.5 * f, ball.y + (goal.y - ball.y) * 0.5 * f - bend, clock);
      if (sp.previewKind === PreviewKind.FLIGHT) sawFlight = true;
    }
    // The finger rests on the end point: the throttled preview catches up with the last move (next due refresh).
    clock += 30;
    sp.update(clock);
    expect(sawFlight).toBe(true);
    expect(sp.previewKind).toBe(PreviewKind.FLIGHT);
    expect(st.previewCount).toBeGreaterThan(10);
    // The dots head toward the goal (screen x grows) from the ball point.
    expect(st.previewX[0]).toBeCloseTo(ball.x, 6);
    expect(st.previewX[st.previewCount - 1]!).toBeGreaterThan(st.previewX[1]! + 40);
    // The preview equals RUL-05's flight for the same frame the lift will send.
    const shown = { x: st.previewX.slice(0, st.previewCount), y: st.previewY.slice(0, st.previewCount) };

    clock += 8;
    sp.up(1, ball.x + (goal.x - ball.x) * 0.5, ball.y + (goal.y - ball.y) * 0.5, clock);
    expect(st.previewCount).toBe(0);
    expect(st.gestureEventCount).toBe(1);
    expect(st.gestureEvents[0]!.fromBall).toBe(true);

    // The lift goes through the mapper into the real pipeline: the taker strikes a free-kick shot.
    let sent: InputFrame | null = null;
    const pred = createBallPrediction();
    let predicted = 0;
    let kicked = -1;
    let kind: KickKind = KickKind.NONE;
    runTicks(s, 90, (tick, state, outs) => {
      clock += TICK;
      mapper.sample(outs[0]!, { tick, human: 0, side: 0, state, projector: PROJ });
      if (outs[0]!.gesture !== 0 && !sent) {
        sent = { ...outs[0]! };
        predicted = previewFlight(state, pred, outs[0]!);
      }
      if (kicked < 0 && state.match.restart.taken === 1) { kicked = tick; kind = state.ball.lastKickKind; }
    });
    expect(sent).not.toBeNull();
    expect(sent!.gFlags & GestureFlag.FROM_BALL).toBe(GestureFlag.FROM_BALL);
    expect(sent!.gdx).toBeGreaterThan(100); // toward +x
    expect(predicted).toBeGreaterThan(0);
    expect(kicked).toBeGreaterThan(0);
    expect(KickKind[kind]).toBe(KickKind[KickKind.FREE_KICK_SHOT]);
    // The dots shown before the lift are RUL-05's flight of the frame that was sent (projected, every 3rd tick).
    const P = { x: 0, y: 0 };
    for (let d = 1; d < Math.min(shown.x.length, 8); d++) {
      const i = d * 3 - 1;
      PROJ.pitchToScreen(pred.x[i]!, pred.y[i]!, pred.z[i]!, P);
      expect(shown.x[d]!).toBeCloseTo(P.x, 3);
      expect(shown.y[d]!).toBeCloseTo(P.y, 3);
    }
  });
});

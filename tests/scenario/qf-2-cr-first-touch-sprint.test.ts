/**
 * [QF-2] CR for QF-1 (src/sim/players/firstTouch.ts, SIM-07 clean settle): a sprinting receiver (9.1 m/s, ballControl
 * 71) meets a loose ball rolling the same way at 5.7 m/s and takes a CLEAN first touch; SIM-07 sets the ball rolling
 * at 14 m/s toward "where he will be when the FIRST_TOUCH window ends", but the window caps his movement (he slows
 * to ~8.3 m/s), so the ball he "controls" runs 2.6 m clear within 15 ticks, he loses it and it rolls 20 m into touch
 * (QA-12 scan: Professional bot match seed 0x5c4 #0, t 6117; the knock-on before it was fine). §6: "a dribbler guides
 * it with touches ahead of his feet ... further at a sprint", a clean touch never leaves the ball out of his reach.
 * The state is the tick before the touch (fixtures/qf-2-first-touch-sprint.state.json, serializeState).
 * Proposed fix: plan the settle point with the speed he will actually have under the FIRST_TOUCH movement cap (or
 * cap the settle ball speed near his own speed + the sprint touch lead).
 * Marked it.fails until QF-1 lands a fix (then drop .fails; re-capture the fixture if the state layout changes).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 CR (SIM-07): a clean first touch at a sprint keeps the ball within his reach', () => {
  it.fails('the sprinting receiver still has the ball at his feet when the FIRST_TOUCH window ends', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-first-touch-sprint.state.json', import.meta.url), 'utf8'));
    expect(s.ball.owner).toBe(-1);
    let touched = false;
    let worst = 0;
    runTicks(s, 16, undefined, {
      until: (st) => {
        const p = st.players[20]!;
        if (!touched && st.ball.owner === 20) touched = true;
        if (touched) worst = Math.max(worst, Math.hypot(st.ball.x - p.x, st.ball.z - p.z));
        return false;
      },
    });
    expect(touched).toBe(true);
    expect(worst).toBeLessThan(2);
  });
});

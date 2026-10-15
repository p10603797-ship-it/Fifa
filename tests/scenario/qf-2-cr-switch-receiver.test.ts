/**
 * [QF-2] CR for QF-3 / QF-1 (src/sim/control/switching.ts, SIM-16 rule 4 "never away from a player about to reach the
 * ball"): the CPU controller on the man a loose ground ball is rolling into (1.1 m away; it passes 0.9 m from him on
 * the next tick and SIM-07 gives him the touch) auto-switches to a teammate 8 m away on that very tick, then back to
 * him the tick after, when he has the ball. Seen in Professional bot matches about once every two matches.
 * The state is the tick before the switch, captured from a soak match (seed 1, match 3, t 22665) into
 * fixtures/qf-2-switch-receiver.state.json (serializeState). Likely cause: switching's reach estimate does not count a
 * ball that will pass within T_TOUCH.receiveRadius of him as "about to reach"; it should use SIM-07's receive reach.
 * Marked it.fails until the owner lands a fix (then drop .fails; re-capture the fixture if the state layout changes).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventType } from '../../src/contracts/events';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 CR (switching): never away from the player about to receive a loose ball', () => {
  it('the CPU controller stays on the man the loose ball rolls into', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-switch-receiver.state.json', import.meta.url), 'utf8'));
    expect(s.ctrl[2]!.slot).toBe(7);
    const away: number[] = [];
    runTicks(s, 2, undefined, {
      until: (_st, evs) => {
        for (const e of evs) if (e.type === EventType.SWITCH && e.c === 2 && e.a === 7) away.push(e.b);
        return false;
      },
    });
    expect(s.ball.owner).toBe(7);
    expect(away).toEqual([]);
  });
});

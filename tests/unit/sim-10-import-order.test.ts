/**
 * [SIM-10] kicks/through.ts imported FIRST (before the sim pipeline) must not break the action registry: the import
 * cycle through -> actions/dispatch -> actions/registry -> through could hand the registry an undefined through-ball
 * solver (no through ball would ever be struck). The registry-facing export is a shell from kicks/throughHooks.ts,
 * re-exported first and bound at the end of through.ts.
 */
import { solveThrough, startThrough } from '../../src/sim/kicks/through';
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { KICK_SOLVERS } from '../../src/sim/actions/registry';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { KICKER, MATE_A, place, quiet, req } from './sim-09-helpers';

describe('SIM-10 import order', () => {
  it('registry holds the real through-ball solver', () => {
    for (const k of [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED]) expect(KICK_SOLVERS[k]).toBe(solveThrough);
  });

  it('and it runs: a started through ball is struck at its contact tick toward the runner', () => {
    const s = quiet();
    place(s, MATE_A, 12, 6, 1, 0, 7, 0);
    expect(startThrough(s, KICKER, KickKind.THROUGH_GROUND, req({ dirX: 1 }), NULL_SINK)).toBe(1);
    const ev = createEventBuffer();
    let kicked = -1;
    for (let t = 0; t < 12 && kicked < 0; t++) {
      s.tick++;
      ev.begin(s.tick);
      actionsTick(s, ev);
      for (const e of ev.toArray()) if (e.type === EventType.KICK && e.a === KICKER) kicked = e.b;
    }
    expect(kicked).toBe(KickKind.THROUGH_GROUND);
    expect(s.ball.passTarget).toBe(MATE_A);
    expect(s.ball.vx).toBeGreaterThan(5);
  });
});

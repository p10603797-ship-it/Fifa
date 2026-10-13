/**
 * [SIM-08] kicks/pass.ts imported FIRST (before the sim pipeline) must not break the action registry: the import
 * cycle pass -> actions/dispatch -> actions/registry -> pass would hand the registry an undefined KICK handler (-> the
 * idle handler: no foot kick would ever reach its contact) and ground-pass solver. The registry-facing exports are
 * shells from kicks/passHooks.ts, re-exported first and bound at the end of pass.ts.
 */
import { kickHandler, solveGroundPass, startPass } from '../../src/sim/kicks/pass';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { ACTION_HANDLERS, KICK_SOLVERS } from '../../src/sim/actions/registry';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { MATE_A, PASSER, place, quiet, req } from './sim-08-helpers';

describe('SIM-08 import order', () => {
  it('registry holds the real KICK handler and the pass solver for every pass kind', () => {
    expect(ACTION_HANDLERS[ActionKind.KICK]).toBe(kickHandler);
    for (const k of [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS, KickKind.KICK_OFF]) {
      expect(KICK_SOLVERS[k]).toBe(solveGroundPass);
    }
  });

  it('and they run: a started pass is struck at its contact tick', () => {
    const s = quiet();
    place(s, MATE_A, 15, 0);
    expect(startPass(s, PASSER, KickKind.GROUND_PASS, req({ targetSlot: MATE_A }), NULL_SINK)).toBe(1);
    const ev = createEventBuffer();
    let kicked = false;
    for (let t = 0; t < 12 && !kicked; t++) {
      s.tick++;
      ev.begin(s.tick);
      actionsTick(s, ev);
      for (let i = 0; i < ev.count; i++) if (ev.get(i).type === EventType.KICK) kicked = true;
    }
    expect(kicked).toBe(true);
    expect(s.ball.passTarget).toBe(MATE_A);
  });
});

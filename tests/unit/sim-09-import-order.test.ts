/**
 * [SIM-09] kicks/lob.ts imported FIRST (before the sim pipeline) must not break the action registry: the import cycle
 * lob -> actions/dispatch -> actions/registry -> lob could hand the registry undefined lob / cross solvers (no lob or
 * cross would ever be struck). The registry-facing exports are shells from kicks/lobHooks.ts, re-exported first and
 * bound at the end of lob.ts.
 */
import { solveCross, solveLob, startLob } from '../../src/sim/kicks/lob';
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { KICK_SOLVERS } from '../../src/sim/actions/registry';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { KICKER, MATE_A, place, quiet, req } from './sim-09-helpers';

describe('SIM-09 import order', () => {
  it('registry holds the real lob and cross solvers', () => {
    for (const k of [KickKind.LOB_PASS, KickKind.HIGH_LOB, KickKind.DRIVEN_LOB, KickKind.GOAL_KICK]) expect(KICK_SOLVERS[k]).toBe(solveLob);
    for (const k of [KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS]) expect(KICK_SOLVERS[k]).toBe(solveCross);
  });

  it('and they run: a started lob and a started cross are struck at their contact tick', () => {
    for (const [kx, kz, kind] of [[0, 0, KickKind.LOB_PASS], [38, 26, KickKind.CROSS]] as const) {
      const s = quiet(1, kx, kz);
      place(s, MATE_A, kx + 20, kz > 0 ? 0 : 3);
      expect(startLob(s, KICKER, kind, req({ dirX: 1 }), NULL_SINK)).toBe(1);
      const ev = createEventBuffer();
      let kicked = -1;
      for (let t = 0; t < 12 && kicked < 0; t++) {
        s.tick++;
        ev.begin(s.tick);
        actionsTick(s, ev);
        for (const e of ev.toArray()) if (e.type === EventType.KICK && e.a === KICKER) kicked = e.b;
      }
      expect(kicked).toBe(kind);
      expect(s.ball.vy).toBeGreaterThan(1);
    }
  });
});

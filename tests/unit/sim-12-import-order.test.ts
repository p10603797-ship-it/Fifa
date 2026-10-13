/**
 * [SIM-12] kicks/aerial.ts imported FIRST (before the sim pipeline) must not break the action registry: the import
 * cycle aerial -> actions/dispatch -> actions/registry -> aerial would hand the registry undefined HEADER / VOLLEY
 * handlers (-> idle: nobody could ever head the ball). The registry-facing exports are shells from
 * kicks/aerialHooks.ts, re-exported first.
 */
import { headerHandler, solveHeader, solveVolley, volleyHandler } from '../../src/sim/kicks/aerial';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { ACTION_HANDLERS, KICK_SOLVERS } from '../../src/sim/actions/registry';
import { launchCross, place, pressOnChance, quietScene, runAerial } from '../scenario/sim-12-helpers';

describe('SIM-12 import order', () => {
  it('registry holds the real HEADER / VOLLEY handlers and solvers', () => {
    expect(ACTION_HANDLERS[ActionKind.HEADER]).toBe(headerHandler);
    expect(ACTION_HANDLERS[ActionKind.VOLLEY]).toBe(volleyHandler);
    expect(KICK_SOLVERS[KickKind.HEADER_SHOT]).toBe(solveHeader);
    expect(KICK_SOLVERS[KickKind.HEADER_PASS]).toBe(solveHeader);
    expect(KICK_SOLVERS[KickKind.VOLLEY_SHOT]).toBe(solveVolley);
    expect(KICK_SOLVERS[KickKind.VOLLEY_PASS]).toBe(solveVolley);
  });

  it('and they run: a header from a cross happens through the pipeline', () => {
    const s = quietScene({ human: 9, seed: 2 });
    place(s, 9, 41, 0);
    launchCross(s, 7, 36, -28, 42, 0, 0.5, 9);
    const r = runAerial(s, 180, pressOnChance(9, Btn.SHOOT, 20));
    expect(r.aerials.length).toBe(1);
    expect(r.events.some((e) => e.type === EventType.KICK && e.a === 9 && e.b === KickKind.HEADER_SHOT)).toBe(true);
  });
});

/**
 * [GKP-05] keeper/handling.ts imported FIRST (before the sim pipeline) must not break the action registry: the
 * import cycle handling -> actions/dispatch -> actions/registry -> handling used to hand the registry undefined
 * handlers (-> idle), and a keeper then held the ball forever and never released it (glitch "Keeper: holds the ball
 * forever"). The registry-facing exports are shells from keeper/handlingHooks.ts, re-exported first.
 */
import { gkKickHandler, holdHandler, solveKeeperRelease, throwHandler } from '../../src/sim/keeper/handling';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { ACTION_HANDLERS, KICK_SOLVERS } from '../../src/sim/actions/registry';
import { T_GK } from '../../src/contracts/tuning';
import { runTicks } from '../harness/scenario';
import { KEEPER, keeperHolding } from './gkp-05-helpers';

describe('GKP-05 import order (glitch: Keeper holds the ball forever when handling.ts is imported first)', () => {
  it('registry holds the real GK_HOLD / GK_THROW / GK_KICK handlers and the release solver', () => {
    expect(ACTION_HANDLERS[ActionKind.GK_HOLD]).toBe(holdHandler);
    expect(ACTION_HANDLERS[ActionKind.GK_THROW]).toBe(throwHandler);
    expect(ACTION_HANDLERS[ActionKind.GK_KICK]).toBe(gkKickHandler);
    for (const k of [KickKind.GK_THROW, KickKind.GK_DRIVEN_THROW, KickKind.GK_ROLL, KickKind.GK_DROP_KICK,
      KickKind.GK_DRIVEN_KICK, KickKind.GK_RELEASE]) {
      expect(KICK_SOLVERS[k]).toBe(solveKeeperRelease);
    }
  });

  it('and they run: a held ball is released within 6 s', () => {
    const { s } = keeperHolding();
    const pickup = s.tick;
    const ev = runTicks(s, T_GK.maxHoldTicks + 10);
    const hands = ev.find((e) => e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 0);
    expect(hands).toBeDefined();
    expect(hands!.tick - pickup).toBeLessThanOrEqual(T_GK.maxHoldTicks);
  });
});

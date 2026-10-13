/**
 * [GKP-03] keeper/sweeper.ts imported FIRST (before the sim pipeline) must not break the action registry: the cycle
 * sweeper -> actions/dispatch -> actions/registry -> sweeper would hand the registry undefined handlers (-> idle) and
 * a rushing keeper would never stop (he would stay out of his goal). The registry-facing handlers are shells from
 * keeper/sweeperHooks.ts, re-exported first, bound to the implementation when sweeper.ts finishes loading.
 */
import { punchHandler, rushHandler, startKeeperRush, LOCAL_TUNING as L } from '../../src/sim/keeper/sweeper';
import { describe, expect, it } from 'vitest';
import { ActionKind } from '../../src/contracts/enums';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { createEventBuffer } from '../../src/sim/core/events';
import { runTicks } from '../harness/scenario';
import { scene } from '../scenario/gkp-03-helpers';

describe('GKP-03 import order (a rushing keeper must always stop)', () => {
  it('registry holds the GK_RUSH / GK_PUNCH handlers', () => {
    expect(ACTION_HANDLERS[ActionKind.GK_RUSH]).toBe(rushHandler);
    expect(ACTION_HANDLERS[ActionKind.GK_PUNCH]).toBe(punchHandler);
  });

  it('and they run: a timed user rush ends by itself in the pipeline', () => {
    const sc = scene({ seed: 2 });
    sc.place(20, 40, 0);
    sc.owned(20);
    expect(startKeeperRush(sc.s, sc.keeper, createEventBuffer())).toBe(1);
    let ended = -1;
    runTicks(sc.s, L.userTimedTicks + 20, undefined, {
      until: (s) => { if (ended < 0 && s.players[sc.keeper]!.act !== ActionKind.GK_RUSH) ended = s.tick; return false; },
    });
    expect(ended).toBeGreaterThan(0);
  });
});

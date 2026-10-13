/**
 * [SIM-07] players/firstTouch.ts imported FIRST (before the sim pipeline) must not break the action registry: the
 * import cycle firstTouch -> actions/dispatch -> actions/registry -> firstTouch would otherwise hand the registry an
 * undefined FIRST_TOUCH handler (-> the idle handler), and a trapped receiver would never be slowed nor freed early
 * when the ball is poked away. The registry-facing export is the shell from players/firstTouchHooks.ts, re-exported
 * first and bound to the implementation at the end of firstTouch.ts.
 */
import { firstTouchHandler, receiveContacts } from '../../src/sim/players/firstTouch';
import { describe, expect, it } from 'vitest';
import { ActionKind } from '../../src/contracts/enums';
import { MoveMode } from '../../src/contracts/state';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { LOCAL_TUNING } from '../../src/sim/players/firstTouch';
import { baseState, contactTick, control, incoming, RECV } from './sim-07-helpers';
import { createEventBuffer } from '../../src/sim/core/events';
import { actionsTick } from '../../src/sim/actions/dispatch';

describe('SIM-07 import order (registry gets the real FIRST_TOUCH handler when firstTouch.ts is imported first)', () => {
  it('registry holds the handler, and it runs the implementation', () => {
    expect(typeof receiveContacts).toBe('function');
    expect(ACTION_HANDLERS[ActionKind.FIRST_TOUCH]).toBe(firstTouchHandler);
    const s = baseState(1);
    control(s, RECV);
    incoming(s, RECV, { speed: 8 });
    contactTick(s);
    const p = s.players[RECV]!;
    expect(p.act).toBe(ActionKind.FIRST_TOUCH);
    p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0;
    actionsTick(s, createEventBuffer());
    expect(p.ix).toBeCloseTo(LOCAL_TUNING.slowFraction, 9);
  });
});

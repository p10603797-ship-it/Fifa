/**
 * RUL-11: restart.ts is reached early by several importers (machine.ts, resolve.ts, watchdog.ts), and the action
 * registry reads setPieceHandler at module init through restart -> dispatch -> registry -> restart. Importing
 * restart.ts first must still register the real SET_PIECE handler and the real set-piece input functions.
 */
import { SETPIECE_INPUT, setPieceHandler } from '../../src/sim/rules/restart';
import { describe, expect, it } from 'vitest';
import { ActionKind, RestartKind } from '../../src/contracts/enums';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { setPieceHandler as leafHandler } from '../../src/sim/rules/restartCommon';
import { kickOffInput } from '../../src/sim/rules/machine';
import { throwInInput } from '../../src/sim/rules/throwin';
import { goalKickInput } from '../../src/sim/rules/goalkick';
import { cornerInput } from '../../src/sim/rules/corner';
import { freeKickInput } from '../../src/sim/rules/freekick';
import { penaltyInput } from '../../src/sim/rules/penalty';

describe('RUL-11 import order', () => {
  it('registry holds the real SET_PIECE handler when restart.ts is imported first', () => {
    const h = ACTION_HANDLERS[ActionKind.SET_PIECE]!;
    expect(h).toBe(setPieceHandler);
    expect(h).toBe(leafHandler);
    expect(typeof h.update).toBe('function');
    expect(typeof h.end).toBe('function');
  });

  it('SETPIECE_INPUT holds the kind modules\' input functions', () => {
    expect(SETPIECE_INPUT).toEqual([null, kickOffInput, throwInInput, goalKickInput, cornerInput, freeKickInput, penaltyInput]);
    expect(SETPIECE_INPUT.length).toBe(RestartKind.PENALTY + 1);
  });
});

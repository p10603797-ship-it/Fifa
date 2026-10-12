/**
 * RUL-01: the rules machine is reached first by the UI (scoreboard -> displayClock) and by stats, before the sim
 * pipeline. Importing it first must not break the action registry or the set-piece routing table (import cycle
 * machine -> rules -> dispatch -> registry -> machine).
 */
import { celebrateHandler, dejectedHandler, kickOffInput } from '../../src/sim/rules/machine';
import { describe, expect, it } from 'vitest';
import { ActionKind } from '../../src/contracts/enums';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { SETPIECE_INPUT } from '../../src/sim/rules/restart';

describe('RUL-01 import order', () => {
  it('registry holds the real CELEBRATE / DEJECTED handlers when machine.ts is imported first', () => {
    const c = ACTION_HANDLERS[ActionKind.CELEBRATE]!;
    const d = ACTION_HANDLERS[ActionKind.DEJECTED]!;
    expect(c).toBe(celebrateHandler);
    expect(d).toBe(dejectedHandler);
    expect(typeof c.update).toBe('function');
    expect(typeof c.end).toBe('function');
    expect(typeof d.update).toBe('function');
    expect(typeof d.end).toBe('function');
  });

  it('set-piece routing table holds kickOffInput', () => {
    expect(SETPIECE_INPUT[1]).toBe(kickOffInput);
  });
});

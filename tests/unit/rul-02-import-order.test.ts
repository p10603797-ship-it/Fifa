/**
 * RUL-02: rules/throwin.ts imported FIRST (before the sim pipeline) must not break the action registry or the set-piece
 * input table: the cycle throwin -> actions/dispatch -> actions/registry -> throwin would otherwise hand the registry an
 * undefined THROW_IN handler (-> idle) and a throw-in taker would hold the ball until the watchdog forced the restart.
 * The handler is a shell from rules/throwinHooks.ts, re-exported first; the implementation is bound at module end.
 */
import { throwInHandler, throwInInput } from '../../src/sim/rules/throwin';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { LOCAL_TUNING as RESTART_LT, SETPIECE_INPUT, awardRestart } from '../../src/sim/rules/restart';
import { throwInHandler as shell } from '../../src/sim/rules/throwinHooks';
import { createEventBuffer } from '../../src/sim/core/events';
import { makeScenario, runTicks } from '../harness/scenario';

describe('RUL-02 import order', () => {
  it('registry holds the real THROW_IN handler and SETPIECE_INPUT the real throw-in input', () => {
    expect(ACTION_HANDLERS[ActionKind.THROW_IN]).toBe(throwInHandler);
    expect(throwInHandler).toBe(shell);
    expect(typeof throwInHandler.update).toBe('function');
    expect(typeof throwInHandler.end).toBe('function');
    expect(SETPIECE_INPUT[RestartKind.THROW_IN]).toBe(throwInInput);
  });

  it('and they run: a CPU throw-in is thrown (no watchdog) when throwin.ts was imported first', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const ev = createEventBuffer();
    ev.begin(s.tick);
    awardRestart(s, RestartKind.THROW_IN, 0, 5, 34, ev);
    // [QF-10] the throw-in set-up is walked (D-008) and may wait up to setupExtendMaxTicks past restartSetupTicks.
    const out = runTicks(s, 260 + RESTART_LT.setupExtendMaxTicks);
    const kicks = out.filter((e) => e.type === EventType.KICK && e.b === KickKind.THROW_IN);
    expect(kicks).toHaveLength(1);
    expect(out.filter((e) => e.type === EventType.WATCHDOG && e.a === WatchdogReason.RESTART_BLOCKED)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

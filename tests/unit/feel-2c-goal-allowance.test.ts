/**
 * [FEEL-2C, D-039] Headless runner tick limit: each goal scored adds GOAL_ALLOWANCE_TICKS (its cut-scenes and the
 * kick-off after it run off the clock). Fuzz seed 3 #57's rematch (0-7, SKIP held so nothing was skipped) reached
 * POST_MATCH at t=22545, 225 ticks past the fixed defaultMaxTicks of 22320, and was reported unfinished.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, ModeId, PracticeKind } from '../../src/contracts/enums';
import { createMatchConfig, MAX_SHOOTOUT_KICKS } from '../../src/contracts/state';
import { T_RULES, T_SHOOTOUT } from '../../src/contracts/tuning';
import {
  GOAL_ALLOWANCE_MAX_GOALS, GOAL_ALLOWANCE_TICKS, goalAllowanceFor, runMatch, SHOOTOUT_KICK_ALLOWANCE_TICKS,
  shootoutKickAllowanceFor,
} from '../../tools/headless';

describe('FEEL-2C headless goal allowance', () => {
  it('is the goal sequence cap plus the kick-off phase cap', () => {
    expect(GOAL_ALLOWANCE_TICKS).toBe(T_RULES.goalSequenceMaxTicks + T_RULES.phaseMaxTicks[MatchPhase.KICK_OFF]!);
  });

  it('glitch long blow-out reported unfinished — the limit grows by the allowance per goal scored, and only when asked', () => {
    const config = createMatchConfig();
    config.seed = 57;
    // Two goals on the board from the first tick (the runner reads the score, not GOAL events).
    const inputs = (_t: number, s: { teams: { goals: number }[] }): void => { s.teams[0]!.goals = 2; };
    const plain = runMatch({ config, maxTicks: 100, checker: 'none', inputs });
    expect(plain.ticks).toBe(100);
    const allowed = runMatch({ config, maxTicks: 100, checker: 'none', inputs, goalAllowanceTicks: 50 });
    expect(allowed.ticks).toBe(200);
    const none = runMatch({ config, maxTicks: 100, checker: 'none', goalAllowanceTicks: 50 });
    expect(none.ticks).toBe(100);
  });

  it('glitch endless practice run — practice and Shoot-out mode get no allowance, and at most 16 goals count', () => {
    // A first cut credited every goal in practice too: Penalties practice scores every few seconds for ever, so the
    // limit ran ahead of the run (fuzz seed 11 #23 / #39 / #54 / #183 timed out; one ran 2.97 M ticks in-process).
    const match = createMatchConfig();
    expect(goalAllowanceFor(match)).toBe(GOAL_ALLOWANCE_TICKS);
    const practice = createMatchConfig();
    practice.mode = ModeId.PRACTICE;
    practice.practice = PracticeKind.PENALTIES;
    expect(goalAllowanceFor(practice)).toBe(0);
    const shootout = createMatchConfig();
    shootout.mode = ModeId.SHOOT_OUT;
    shootout.startPhase = MatchPhase.SHOOT_OUT;
    expect(goalAllowanceFor(shootout)).toBe(0);
    const inputs = (_t: number, s: { teams: { goals: number }[] }): void => { s.teams[0]!.goals = 500; };
    const capped = runMatch({ config: match, maxTicks: 100, checker: 'none', inputs, goalAllowanceTicks: 10 });
    expect(capped.ticks).toBe(100 + 10 * GOAL_ALLOWANCE_MAX_GOALS);
  });

  it('glitch idle shoot-out reported unfinished — every shoot-out kick taken adds the most one kick can take', () => {
    // Fuzz seed 11 #72 / #121: Shoot-out mode, both humans idle (each kick waits the 12 s timeout, no keeper dives, all
    // score), 16 kicks reached the fixed 16704-tick limit at kick 17; the shoot-out ends after 40 kicks each at most.
    expect(SHOOTOUT_KICK_ALLOWANCE_TICKS).toBe(T_RULES.restartSetupTicks + T_RULES.restartTimeoutTicks +
      T_SHOOTOUT.defaultGraceTicks + T_SHOOTOUT.flightMaxTicks + T_SHOOTOUT.resultTicks);
    const shootout = createMatchConfig();
    shootout.mode = ModeId.SHOOT_OUT;
    shootout.startPhase = MatchPhase.SHOOT_OUT;
    expect(shootoutKickAllowanceFor(shootout)).toBe(SHOOTOUT_KICK_ALLOWANCE_TICKS);
    const practice = createMatchConfig();
    practice.mode = ModeId.PRACTICE;
    expect(shootoutKickAllowanceFor(practice)).toBe(0);
    // Real shoot-out, both sides idle humans: it ends (POST_MATCH) with the kick allowance on, whatever its length.
    shootout.humans = [
      { kind: 1, side: 0, assist: 0, autoSwitch: 0, fastPower: 0 }, { kind: 1, side: 1, assist: 0, autoSwitch: 0, fastPower: 0 },
    ];
    shootout.seed = 3603434363;
    const r = runMatch({ config: shootout, maxTicks: 6000, checker: 'none', shootoutKickAllowanceTicks: SHOOTOUT_KICK_ALLOWANCE_TICKS });
    expect(r.finished).toBe(true);
    expect(r.ticks).toBeLessThanOrEqual(6000 + 2 * MAX_SHOOTOUT_KICKS * SHOOTOUT_KICK_ALLOWANCE_TICKS);
  });
});

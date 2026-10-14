/**
 * [QF-2] QA-19 difficulty ladder: a CPU side's keeper reacts to a shot T_LEVEL.keeperReactTicks later (Beginner) or
 * sooner (Legend) than his gkReflexes alone; Professional and a side without an active CPU brain (a human side) get
 * exactly the attribute delay, so the §7 bands (Professional) and human keepers are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { T_LEVEL } from '../../src/contracts/tuning';
import { keeperReactionTicks, keeperReactTicks } from '../../src/sim/keeper/saves';
import { makeScenario } from '../harness/scenario';

describe('QF-2 keeper reaction by CPU level', () => {
  it('is monotonic over the levels, zero at Professional, never negative', () => {
    const v = T_LEVEL.keeperReactTicks;
    expect(v.length).toBe(6);
    expect(v[Difficulty.PROFESSIONAL]).toBe(0);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeLessThan(v[i - 1]!);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    const k = s.teams[1]!.keeperSlot;
    const base = keeperReactTicks(s.attrs[k]!);
    s.teams[1]!.cpu.active = 1;
    for (let lv = 0; lv < 6; lv++) {
      s.teams[1]!.cpu.level = lv as Difficulty;
      expect(keeperReactionTicks(s, k), `level ${lv}`).toBe(Math.max(0, base + v[lv]!));
    }
    s.attrs[k]!.gkReflexes = 99;
    s.teams[1]!.cpu.level = Difficulty.LEGEND;
    expect(keeperReactionTicks(s, k)).toBeGreaterThanOrEqual(0);
  });

  it('a side without an active CPU brain (human) keeps the attribute delay whatever its level field says', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    const k = s.teams[0]!.keeperSlot;
    s.teams[0]!.cpu.active = 0;
    s.teams[0]!.cpu.level = Difficulty.BEGINNER;
    expect(keeperReactionTicks(s, k)).toBe(keeperReactTicks(s.attrs[k]!));
    s.teams[0]!.cpu.active = 1;
    expect(keeperReactionTicks(s, k)).toBe(keeperReactTicks(s.attrs[k]!) + T_LEVEL.keeperReactTicks[Difficulty.BEGINNER]!);
  });
});

/**
 * [QF-16] BRIEF section 15: every attribute must visibly change play. A CPU keeper's save reaction delay is his
 * gkReflexes delay (T_GK.reactWorst .. reactBest) plus his level's T_LEVEL.keeperReactTicks; Legend's -12 floored the
 * delay at 0 ticks for every keeper with gkReflexes 62 or more (every club keeper but a handful), so reflexes above 62
 * made no difference at Legend. Legend now scales the attribute delay (T_LEVEL.keeperReactScale) instead of flooring
 * it: the delay falls with every step of reflexes at every level, and Legend stays the quickest level.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, MatchPhase, Role } from '../../src/contracts/enums';
import { T_LEVEL } from '../../src/contracts/tuning';
import { CLUBS } from '../../src/data/clubs';
import { keeperReactionTicks, keeperReactTicks } from '../../src/sim/keeper/saves';
import { makeScenario } from '../harness/scenario';

function delays(level: Difficulty, reflexes: readonly number[]): number[] {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  const k = s.teams[1]!.keeperSlot;
  s.teams[1]!.cpu.active = 1;
  s.teams[1]!.cpu.level = level;
  return reflexes.map((r) => { s.attrs[k]!.gkReflexes = r; return keeperReactionTicks(s, k); });
}

describe('QF-16 keeper reflexes matter at every level', () => {
  it('reads the tables: Legend scales the attribute delay, the other levels add ticks', () => {
    expect(T_LEVEL.keeperReactScale.length).toBe(6);
    expect(T_LEVEL.keeperReactScale[Difficulty.PROFESSIONAL]).toBe(1);
    expect(T_LEVEL.keeperReactScale[Difficulty.LEGEND]!).toBeGreaterThan(0);
    expect(T_LEVEL.keeperReactScale[Difficulty.LEGEND]!).toBeLessThan(1);
  });

  it('glitch: attribute has no visible effect — a Legend keeper with gkReflexes 62 reacts later than one with 80 and one with 99', () => {
    const [d62, d80, d99] = delays(Difficulty.LEGEND, [62, 80, 99]);
    // Before: 0 / 0 / 0 ticks (floored).
    expect(d62!).toBeGreaterThan(d80!);
    expect(d80!).toBeGreaterThan(d99!);
    expect(d99!).toBeGreaterThan(0);
  });

  it('at every level the delay never rises with reflexes and differs across the club keepers\' range', () => {
    const keepers: number[] = [];
    for (const c of CLUBS) for (const p of c.squad) if (p.pos === Role.GK) keepers.push(p.gkReflexes);
    const lo = Math.min(...keepers), hi = Math.max(...keepers);
    const range: number[] = [];
    for (let r = 1; r <= 99; r++) range.push(r);
    for (let lv = Difficulty.BEGINNER; lv <= Difficulty.LEGEND; lv++) {
      const d = delays(lv, range);
      for (let i = 1; i < d.length; i++) expect(d[i]!, `level ${lv} reflexes ${i + 1}`).toBeLessThanOrEqual(d[i - 1]!);
      expect(d[lo - 1]!, `level ${lv}: ${lo} v ${hi}`).toBeGreaterThan(d[hi - 1]!);
    }
  });

  it('Legend stays the quickest level and Professional is the attribute delay alone', () => {
    const range = [40, 55, 62, 70, 80, 90, 99];
    const legend = delays(Difficulty.LEGEND, range), wc = delays(Difficulty.WORLD_CLASS, range);
    const pro = delays(Difficulty.PROFESSIONAL, range);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    for (let i = 0; i < range.length; i++) {
      expect(legend[i]!).toBeLessThanOrEqual(wc[i]!);
      s.attrs[0]!.gkReflexes = range[i]!;
      expect(pro[i]).toBe(keeperReactTicks(s.attrs[0]!));
    }
  });
});

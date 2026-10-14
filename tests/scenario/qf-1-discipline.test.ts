/**
 * [QF-1] QA-05 fouls, advantage and cards in real bot matches (fouls on, every invariant checked every tick): every
 * advantage that starts resolves (played on or brought back) within advantageTicks, never two at once, and every card
 * goes to the offender of a carded foul (shown at once or at the next stoppage after an advantage), exactly once.
 */
import { describe, expect, it } from 'vitest';
import { ChallengeOutcome } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { T_RULES } from '../../src/contracts/tuning';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

describe('QF-1 QA-05 advantage and cards in real matches', { timeout: 600_000 }, () => {
  it('glitch advantage that never resolves / card shown to the wrong player — 5 bot matches', () => {
    const problems: string[] = [];
    let fouls = 0, advantages = 0, cards = 0;
    for (let i = 0; i < 5; i++) {
      const config = soakConfig(i, 818, { halfMinutes: 3, cupShare: 0 });
      config.fouls = 1;
      let advStart = -1;
      const owed = new Map<number, number>(); // offender slot -> tick of his carded foul
      const r = runMatch({
        config, checker: 'all', fastCutscenes: true,
        onTick: (s, ev) => {
          for (let k = 0; k < ev.count; k++) {
            const e = ev.get(k);
            if (e.type === EventType.FOUL) {
              fouls++;
              if (e.c === ChallengeOutcome.FOUL_YELLOW || e.c === ChallengeOutcome.FOUL_RED) owed.set(e.a, s.tick);
            } else if (e.type === EventType.ADVANTAGE) {
              if (e.a === 1) {
                advantages++;
                if (advStart >= 0) problems.push(`m${i} t=${s.tick} a second advantage while one is open`);
                advStart = s.tick;
              } else {
                if (advStart < 0) problems.push(`m${i} t=${s.tick} advantage ended without one open`);
                advStart = -1;
              }
            } else if (e.type === EventType.CARD) {
              cards++;
              if (!owed.delete(e.a)) problems.push(`m${i} t=${s.tick} card to ${e.a} without a carded foul by him`);
            }
          }
          if (advStart >= 0 && s.tick - advStart > T_RULES.advantageTicks + 1) {
            problems.push(`m${i} t=${s.tick} advantage open since ${advStart}`);
            advStart = -1;
          }
        },
      });
      expect(r.exception).toBeUndefined();
      for (const [slot, t] of owed) problems.push(`m${i} carded foul by ${slot} at t=${t} never carded`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(fouls).toBeGreaterThan(20);
    expect(advantages).toBeGreaterThan(5);
    expect(cards).toBeGreaterThan(3);
  });
});

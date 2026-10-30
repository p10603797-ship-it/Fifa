/**
 * [FEEL-2 round 2] The side-step duel belongs to the defender who faced the step (D-038). The sold / read window lives in
 * the defending team's brain (p1..p3); in D-035 it was not tied to a slot, so when the CPU switched to a cover defender
 * mid-duel the new man inherited "sold" for a step he never faced: he leaned the wrong way and made no challenge right
 * next to the dribbler (the skeptics' full-team trace: slot 21 sold from t118 to t153 at 2.5 m, the dribbler past both).
 * Now the window stores the slot that drew it and is void for any other.
 *
 * Scenes: tests/scenario/feel-2-helpers.ts fullTeamSideSteps: both teams left in place (no parking), the central setups
 * (cb, box, mid), away / double / plus side steps from 4.5 m, R1 and sprint, three lateral offsets, seeds 31-32 (216
 * scenes a level). Runner: `npx vitest run tests/scenario/feel-2-duel-switch.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { fullTeamSideSteps } from './feel-2-helpers';

describe('FEEL-2 round 2: a cover defender never inherits a side step he did not face', () => {
  for (const lv of [Difficulty.AMATEUR, Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
    it(`${Difficulty[lv]}: no "sold" tick on a defender other than the one who drew it (full teams, no parking)`, () => {
      const g = fullTeamSideSteps(lv);
      console.log(`FEEL-2 full-team side steps ${Difficulty[lv]}: ${JSON.stringify(g)}`);
      expect(g.n).toBe(216);
      // The duel still happens (sold windows drawn and played out) ...
      expect(g.soldTicks).toBeGreaterThan(lv === Difficulty.LEGEND ? 0 : 1000);
      // ... but only ever on the defender who faced the step. Measured 0 / 0 / 0; D-035 (window not tied to a slot):
      // 2311 ticks in 120 scenes at Amateur, 995 in 57 at Professional, 1 at Legend.
      expect(g.inheritedSold).toBe(0);
      expect(g.inheritedScenes).toBe(0);
    }, 300_000);
  }
});

/**
 * [QF-13] Game management: a CPU side kept attacking at full tilt however far ahead it was, so mismatched clubs ran
 * up 5+ goal margins in 5.0% of 500 Professional soak matches (section 7 band: under 5%; 3.4% before QF-13's fixes
 * let more shots through). A CPU side on its default tactical focus that leads by T_AI.gameManageLead goals plays it as
 * DEFENDING (ai/cpu/levels effectiveFocus, read by every TAI-14 focus reader): 3.2% of the same 500. A human side's
 * focus is its own, and a focus the CPU side was given explicitly is kept.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, TacticalFocus, TeamStyle } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { effectiveFocus } from '../../src/ai/cpu/levels';
import { teamPressIntensity } from '../../src/ai/press';
import { makeScenario } from '../harness/scenario';

function scene(goals0: number, goals1: number, cpu1 = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 21 });
  s.teams[0]!.cpu.active = 1;
  s.teams[1]!.cpu.active = cpu1;
  s.teams[0]!.goals = goals0;
  s.teams[1]!.goals = goals1;
  for (const t of s.teams) { t.focus = TacticalFocus.DEFAULT; t.style = TeamStyle.WING_PLAY; }
  return s;
}

describe('QF-13: a CPU side well ahead manages the game', () => {
  it('effective focus: DEFENDING from a gameManageLead lead, the set focus otherwise', () => {
    const L = T_AI.gameManageLead;
    expect(L).toBeGreaterThanOrEqual(2);
    expect(effectiveFocus(scene(L, 0), 0)).toBe(TacticalFocus.DEFENDING);
    expect(effectiveFocus(scene(L + 2, 1), 0)).toBe(TacticalFocus.DEFENDING);
    expect(effectiveFocus(scene(L - 1, 0), 0)).toBe(TacticalFocus.DEFAULT); // not yet
    expect(effectiveFocus(scene(L, 0), 1)).toBe(TacticalFocus.DEFAULT); // the side behind keeps its focus
    expect(effectiveFocus(scene(0, L + 1, 0), 1)).toBe(TacticalFocus.DEFAULT); // a human side's focus is its own
    const s = scene(L + 1, 0);
    s.teams[0]!.focus = TacticalFocus.ATTACKING; // given explicitly (a test, a future CPU tactic): kept
    expect(effectiveFocus(s, 0)).toBe(TacticalFocus.ATTACKING);
  });

  it('the focus readers follow it: TAI-05 press intensity drops to the DEFENDING scale once three goals up', () => {
    const level = teamPressIntensity(scene(1, 1), 0);
    const ahead = teamPressIntensity(scene(T_AI.gameManageLead + 1, 1), 0);
    const asSet = scene(1, 1);
    asSet.teams[0]!.focus = TacticalFocus.DEFENDING;
    expect(ahead).toBeLessThan(level);
    expect(ahead).toBeCloseTo(teamPressIntensity(asSet, 0), 9);
  });
});

/**
 * [QF-6] CR for src/sim/rules/machine.ts (QF-1 area): online, the 30-tick hash exchange only repairs a divergence
 * while both sims keep ticking; the app stops at POST_MATCH. A SKIP edge on the second tick of FULL_TIME ends the match
 * at once, so a divergence in the last ~half second of play (a goal on one device only) reaches the two full-time
 * screens unrepaired; QF-6 now detects and reports it ('session:final'), but cannot repair it after the fact.
 * Proposed: FULL_TIME ignores skips until phaseT >= T_RULES.fullTimeMinTicks (new, 90 ticks = 1.5 s): enough for the
 * next hash (<= 30 ticks), the host's snapshot and the guest's hard-sync before POST_MATCH.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

describe('QF-6 CR: the final whistle needs a moment before it can be skipped', () => {
  it('a SKIP on the 2nd tick of FULL_TIME does not end the match before 90 ticks', () => {
    const cfg = createMatchConfig();
    cfg.halfMinutes = 0.05;
    cfg.seed = 3;
    const s = initMatch(cfg);
    const ev = createEventBuffer();
    const fr = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 40_000 && s.match.phase !== MatchPhase.FULL_TIME; i++) step(s, fr, ev);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    while (s.match.phaseT < 1) step(s, fr, ev);
    fr[0]!.buttons = Btn.SKIP; // controller 0's skip edge (no humans: headless fast-forward)
    step(s, fr, ev);
    fr[0]!.buttons = 0;
    for (let i = 0; i < 80 && s.match.phase === MatchPhase.FULL_TIME; i++) step(s, fr, ev);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
  });
});

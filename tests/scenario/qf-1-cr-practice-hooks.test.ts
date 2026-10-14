/**
 * [QF-1] CR for QF-5 / lead (src/app/**, src/modes/**, outside QF-1's area). The QF-1 charter moved MOD-04's practice
 * hooks into the sim: sim/init.ts initMatch calls rules/practice preparePracticeState, and sim/step.ts runs
 * rules/practice practiceRulesTick right after rulesTick (no-op outside set-piece practice). The old copies are still
 * live and now run a second time:
 *   - src/app/loop.ts stepWithModes = step + modes/practice practiceRulesTick (harmless: the sim already re-awarded, the
 *     copy sees its restart pending and returns 0); make the app loop's default a plain `step`.
 *   - src/app/session.ts prepareModeState calls modes/practice preparePracticeState after initMatch (returns 0); drop it.
 *   - src/modes/practice.ts: re-export practiceRestartKind / preparePracticeState / practiceRulesTick /
 *     practiceSpotWorld (= practiceSpotPoint) / practiceAttemptOver (= practiceAttemptDone) / practiceSide
 *     (= practiceTeam) from src/sim/rules/practice.ts instead of a second implementation (the sim copy also checks that a
 *     pending restart of the practice kind is AT the practice spot before keeping it).
 * Tests to refit with it (they fail now by design):
 *   - tests/unit/int-b-app.test.ts "corner practice through the plain sim step never sees a corner (the hook is what
 *     awards it)": the plain step now awards the corner (expect true for both).
 *   - tests/scenario/mod-04-practice.test.ts "your team against the opponent keeper only, no clock, invariants hold
 *     through the real pipeline": initMatch already took the opponent's outfield players off, so preparePracticeState
 *     returns 0 (check the layout instead of the count).
 *   - tests/scenario/mod-04-practice.test.ts "CORNERS / FREE_KICKS / PENALTIES: the same restart is awarded again after
 *     every attempt, at the chosen spot": the awards now happen inside `step`, so counting practiceRulesTick's return
 *     after it gives 0; count RESTART_AWARDED events (or phase entries) instead.
 */
import { describe, expect, it } from 'vitest';
import * as modes from '../../src/modes/practice';
import * as sim from '../../src/sim/rules/practice';

describe('QF-1 CR (QF-5 / lead) one implementation of the practice hooks, inside the sim', () => {
  it.fails('qf-1-cr: modes/practice re-exports the sim practice hooks instead of a second copy', () => {
    expect(modes.practiceRulesTick).toBe(sim.practiceRulesTick);
    expect(modes.preparePracticeState).toBe(sim.preparePracticeState);
    expect(modes.practiceRestartKind).toBe(sim.practiceRestartKind);
  });
});

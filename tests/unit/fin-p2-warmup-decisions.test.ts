/**
 * [FIN-P2] The loading-screen warm-up runs T_WARMUP.decisionRounds forced CPU decisions (sim/step.ts warmDecide) on a
 * scratch copy of its scratch match, so V8 has compiled the carrier's decision (scorePassOptions, throughBall, lobPass,
 * mateTimeAt, fillContext, runDribble, ...) with TurboFan before the match: they run only every few ticks in play and
 * were still in Maglev (slower, boxing doubles at calls) at the end of the old warm-up and through the bench window.
 * The rounds touch only scratch state: tests/perf/fin-p-prod-hash.ts (production mode, warm-up on) and
 * tools/hash-table.ts give the same table (28 runs IDENTICAL).
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { T_WARMUP } from '../../src/contracts/tuning';
import { benchSetup } from '../../src/platform/benchHook';
import { hashState } from '../../src/sim/core/hash';
import { initMatch, warmUpSim } from '../../src/sim/init';
import { warmUpDecisions } from '../../src/sim/step';

describe('FIN-P2 warm-up decision rounds', () => {
  it('the warm-up runs every forced CPU decision round and leaves the next match untouched', () => {
    const cfg = benchSetup(1).config;
    const before = hashState(initMatch(cfg));
    const d0 = warmUpDecisions();
    const ran = warmUpSim((c) => initMatch(c), cfg);
    expect(ran).toBeGreaterThan(T_WARMUP.openPlayTicks);
    expect(warmUpDecisions() - d0).toBe(T_WARMUP.decisionRounds);
    const s = initMatch(cfg);
    expect(s.match.phase).not.toBe(MatchPhase.POST_MATCH);
    expect(hashState(s)).toBe(before);
  }, 120_000);
});

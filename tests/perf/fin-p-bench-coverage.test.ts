/**
 * [FIN-P] The benchmark's fixed-seed match must run through the worst cases inside its measured window (BRIEF section 13
 * "Proving it": a crowded penalty area, a corner, a goal with net ripple, a replay). The bench is deterministic (the app
 * plays benchSetup(BENCH_DEFAULTS.seed) with no input), so the window is stepped headless here exactly as a 60 Hz device
 * plays it (tests/perf/sgn-04-bench-coverage.ts coverage()). Any sim or AI change reshapes the match: when this fails,
 * pick a new seed with `npx tsx tests/perf/sgn-04-bench-coverage.ts --search 100` and set BENCH_DEFAULTS.seed.
 */
import { describe, expect, it } from 'vitest';
import { BENCH_DEFAULTS } from '../../src/platform/benchHook';
import { coverage } from './sgn-04-bench-coverage';

describe('fin-p: benchmark seed coverage', () => {
  it('fin-p: the bench seed window holds a crowded box, a corner, a goal into the net and its replay', () => {
    const c = coverage(BENCH_DEFAULTS.seed);
    expect({ corner: c.corner, goal: c.goal, net: c.net, replay: c.replay, crowded: c.crowdedTicks > 0 }, c.phases)
      .toEqual({ corner: 1, goal: 1, net: 1, replay: 1, crowded: true });
    expect(c.ok).toBe(true);
  }, 120_000);

  it('fin-p: the old bench seed 0xb3ac4 misses the corner, goal and replay (why the seed changed)', () => {
    const c = coverage(0xb3ac4);
    expect(c.ok).toBe(false);
  }, 120_000);
});

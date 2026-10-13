/**
 * [GKP-04] Allocation probe for keeper distribution (run by tests/unit/gkp-04-alloc.test.ts in a child process):
 *   node --expose-gc --import tsx tests/unit/gkp-04-alloc-probe.ts [n]
 * Prints JSON { <path>: bytes allocated per call } for the per-tick paths: waiting, a full evaluation that keeps
 * holding, and a full evaluation that decides to release (planner only; the release itself is GKP-05's).
 */
import '../../tools/lib/env';
import { TeamStyle } from '../../src/contracts/enums';
import { createEventBuffer } from '../../src/sim/core/events';
import { createDistributionPlan, keeperDistributionAi, planDistribution } from '../../src/sim/keeper/distribution';
import { PICKUP, holdingScene, type Layout } from './gkp-04-helpers';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');

const MATES: Layout = {
  1: [-18, 26], 2: [-40, 8], 3: [-40, -8], 4: [-18, -26], 5: [-12, 20], 6: [-12, 8], 7: [-12, -8], 8: [-12, -20],
  9: [5, 8], 10: [5, -8],
};
const OPPS: Layout = {
  11: [50, 0], 12: [-17, 26], 13: [-39, 8], 14: [-39, -8], 15: [-17, -26], 16: [-11, 20], 17: [-11, 8], 18: [-11, -8],
  19: [-11, -20], 20: [10, 8], 21: [10, -8],
};

const n = Number(process.argv[2] ?? 20000);
const s = holdingScene({ style: TeamStyle.POSSESSION, mates: MATES, opps: OPPS });
const ev = createEventBuffer();
const plan = createDistributionPlan();
s.tick = PICKUP + 200;
ev.begin(s.tick);
planDistribution(s, 0, plan);
const wait = plan.wait;
if (!(wait > 10)) throw new Error('probe: unexpected wait');

/** Bytes per call: long warm-up (so JIT tiers / code objects are not counted), then the best of three passes. */
function measure(held: number, fn: () => void): number {
  s.tick = PICKUP + held;
  for (let i = 0; i < 40000; i++) fn();
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    gc!();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

const ai = (): void => keeperDistributionAi(s, 0, ev);
const planOnly = (): void => { planDistribution(s, 0, plan); };
const out: Record<string, number> = {};
// Waiting (before the wait ends): cheap early return.
out.waiting = measure(wait - 5, ai);
// Full evaluation on the wait tick that keeps holding (only a long option, possession team, before patience).
out.evaluateHold = measure(wait, ai);
if (s.players[0]!.act !== 17) throw new Error('probe: the keeper released during evaluateHold');
// Full evaluation at the deadline that decides to release (planner only, state untouched).
out.evaluateRelease = measure(150, planOnly);
if (plan.release !== 1) throw new Error('probe: no release decision at the deadline');
console.log(JSON.stringify(out));

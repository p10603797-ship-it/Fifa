/**
 * [SIM-10] Allocation: selectRunner allocates nothing; throughLeadPoint (CPU passing calls it during its evaluations)
 * allocates nothing beyond what its LT.leadSamples calls of SIM-04 ticksToReach allocate (V8 boxes the double target
 * arguments of that API, ~48 B a call; see the report); solveThrough (once per kick, at contact) stays small. Plus loose
 * cost guards. Measured with gc exposed via v8 flags; minimum over rounds (GC / JIT noise only ever adds bytes).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AssistLevel, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { LOCAL_TUNING as LT, selectRunner, solveThrough, startThrough, throughLeadPoint } from '../../src/sim/kicks/through';
import { ticksToReach } from '../../src/sim/players/locomotion';
import { KICKER, MATE_A, MATE_B, OPP_A, OPP_B, OPP_GK, place, quiet, req } from './sim-09-helpers';

const PT = { x: 0, z: 0 };
const OUT = createKickLaunch();

function scene(kind: KickKind): SimState {
  const s = quiet(1, 0, -5);
  place(s, MATE_A, 12, 6, 1, 0, 8, 0);
  place(s, MATE_B, 15, -10, 1, 0, 6, -1);
  place(s, OPP_A, 22, 2); place(s, OPP_B, 25, -8); place(s, OPP_GK, 51, 0);
  startThrough(s, KICKER, kind, req({ dirX: 1, power: 0.5 }), NULL_SINK);
  return s;
}

function bytesPer(fn: (i: number) => void, n: number): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn(i);
  let best = 1e9;
  for (let r = 0; r < 3; r++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn(i);
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

describe('SIM-10 allocation and cost', () => {
  it('selectRunner allocates nothing; throughLeadPoint nothing beyond its SIM-04 ticksToReach calls', () => {
    const s = scene(KickKind.THROUGH_GROUND);
    const sel = bytesPer(() => { selectRunner(s, KICKER, 1, 0, 0.5, AssistLevel.ASSISTED, 0); }, 10000);
    expect(sel, `selectRunner ${sel.toFixed(1)} B/call`).toBeLessThan(16);
    const q = s.players[MATE_A]!;
    const ttr = bytesPer((i) => {
      for (let k = 0; k < LT.leadSamples; k++) ticksToReach(s, MATE_A, q.x + 2 * k + (i & 1), q.z);
    }, 5000);
    for (const lofted of [0, 1]) {
      const lead = bytesPer(() => { throughLeadPoint(s, KICKER, MATE_A, 0.5, lofted, PT); }, 5000);
      console.log(`SIM-10 throughLeadPoint (lofted ${lofted}): ${lead.toFixed(1)} B/call; ${LT.leadSamples} x SIM-04 ticksToReach: ${ttr.toFixed(1)} B`);
      expect(lead, `${lead.toFixed(1)} B/call vs ticksToReach ${ttr.toFixed(1)} B`).toBeLessThan(ttr + 64);
    }
  }, 120_000);

  it('solveThrough allocates little per contact (it runs once per kick)', () => {
    const g = scene(KickKind.THROUGH_GROUND);
    const l = scene(KickKind.THROUGH_LOBBED);
    const b = bytesPer((i) => { solveThrough((i & 1) === 0 ? g : l, KICKER, OUT); }, 4000);
    console.log(`SIM-10 solveThrough: ${b.toFixed(1)} B/contact`);
    expect(b, `${b.toFixed(1)} B/call`).toBeLessThan(4096);
  }, 120_000);

  it('cost: throughLeadPoint stays cheap enough for CPU option scans', () => {
    const s = scene(KickKind.THROUGH_GROUND);
    for (let i = 0; i < 2000; i++) throughLeadPoint(s, KICKER, MATE_A, 0.5, i & 1, PT);
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) throughLeadPoint(s, KICKER, MATE_A, (i % 5) / 4, i & 1, PT);
    const us = (performance.now() - t0) * 1000 / 5000;
    const t1 = performance.now();
    for (let i = 0; i < 500; i++) solveThrough(s, KICKER, OUT);
    const sus = (performance.now() - t1) * 1000 / 500;
    console.log(`SIM-10 cost: throughLeadPoint ${us.toFixed(1)} us, solveThrough ${sus.toFixed(1)} us`);
    // Loose guards (shared, loaded test machine).
    expect(us).toBeLessThan(400);
    expect(sus).toBeLessThan(2000);
  }, 120_000);
});

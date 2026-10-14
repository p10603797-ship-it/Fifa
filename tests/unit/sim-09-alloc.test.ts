/**
 * [SIM-09] Allocation: crossTarget / groundCrossTarget / attackerNear (pure queries CPU passing may call every
 * evaluation) allocate nothing; the lob / cross solvers (once per kick, at contact; they call SIM-01 solveLaunchSpin and
 * SIM-08 kickErrorAim, whose double arguments V8 boxes) stay small. Plus a loose cost guard. Measured with gc exposed via
 * v8 flags; minimum over rounds (GC / JIT noise only ever adds bytes). The queries are called with literal arguments,
 * as the CPU does (a computed double argument is boxed at the call site).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { attackerNear, crossTarget, groundCrossTarget, solveCross, solveLob, startLob } from '../../src/sim/kicks/lob';
import { KICKER, MATE_A, MATE_B, place, quiet, req } from './sim-09-helpers';

const PT = { x: 0, z: 0 };
const OUT = createKickLaunch();

function sceneLob(): SimState {
  const s = quiet(1, 0, 0);
  place(s, MATE_A, 24, 6, 1, 0, 5, 1);
  startLob(s, KICKER, KickKind.LOB_PASS, req({ dirX: 1 }), NULL_SINK);
  return s;
}
function sceneCross(): SimState {
  const s = quiet(1, 37, 27, 0.45, -0.9);
  place(s, MATE_B, 42, 2);
  startLob(s, KICKER, KickKind.CROSS, req({ power: 0.5 }), NULL_SINK);
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

describe('SIM-09 allocation and cost', () => {
  it('crossTarget, groundCrossTarget and attackerNear allocate nothing', () => {
    const s = sceneCross();
    const b = bytesPer(() => {
      crossTarget(s, KICKER, 0.3, 1, 0, PT);
      crossTarget(s, KICKER, 0.9, 1, 0, PT);
      groundCrossTarget(s, KICKER, 0.7, 0.5, -0.5, PT);
      attackerNear(s, KICKER, 41, 0, 1);
    }, 20000);
    expect(b, `${b.toFixed(1)} B/call`).toBeLessThan(16);
  }, 120_000);

  it('the lob and cross solvers allocate little per contact (they run once per kick)', () => {
    const a = sceneLob();
    const c = sceneCross();
    const b = bytesPer((i) => {
      if ((i & 1) === 0) solveLob(a, KICKER, OUT); else solveCross(c, KICKER, OUT);
    }, 4000);
    console.log(`SIM-09 solveLob / solveCross: ${b.toFixed(1)} B/contact`);
    expect(b, `${b.toFixed(1)} B/call`).toBeLessThan(4096);
  }, 120_000);

  it('cost: crossTarget is cheap; a solve stays well under a tick budget', () => {
    const s = sceneCross();
    const a = sceneLob();
    for (let i = 0; i < 2000; i++) { crossTarget(s, KICKER, 0.5, 1, 0, PT); solveLob(a, KICKER, OUT); }
    let t0 = performance.now();
    for (let i = 0; i < 20000; i++) crossTarget(s, KICKER, (i % 10) / 10, 1, 0, PT);
    const ctUs = (performance.now() - t0) * 1000 / 20000;
    t0 = performance.now();
    for (let i = 0; i < 1000; i++) solveLob(a, KICKER, OUT);
    const lobUs = (performance.now() - t0) * 1000 / 1000;
    console.log(`SIM-09 cost: crossTarget ${ctUs.toFixed(2)} us, solveLob (led receiver) ${lobUs.toFixed(1)} us`);
    expect(ctUs).toBeLessThan(20);
    expect(lobUs).toBeLessThan(2000);
  }, 120_000);
});

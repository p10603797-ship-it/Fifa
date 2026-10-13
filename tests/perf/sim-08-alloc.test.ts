/**
 * [SIM-08] The KICK handler allocates nothing per tick (wind-up, charging wait, recovery: the movement cap and the
 * checks run every tick for every kicker), measured with gc exposed via v8 flags; a whole pass (start, wind-up,
 * contact with receiver selection, lead, solver and applyKick, recovery) stays small; and the per-pass cost of the
 * solver (ground and dinked) is bounded. Long warm-ups: the first runs measure JIT compilation, not the code.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { solveGroundPass, startPass } from '../../src/sim/kicks/pass';
import { giveBall, MATE_A, MATE_B, OPP_A, PASSER, place, quiet, req } from '../unit/sim-08-helpers';

function scene(): SimState {
  const s = quiet(3);
  place(s, MATE_A, 16, 5);
  s.players[MATE_A]!.vx = 4;
  place(s, MATE_B, 12, -8);
  place(s, OPP_A, 8, 2);
  return s;
}

const REQ_CHARGE = req({ power: 0.3, charging: 1, dirX: 1, dirZ: 0.2 });
const REQ_TAP = req({ power: 0.4, dirX: 1, dirZ: 0.2 });
const EV = createEventBuffer();

/**
 * n ticks of one charging kick that never reaches its contact: the wind-up and the charge wait at the contact tick
 * (actT is wound back inside the wait so the backstop never fires), with the resolver's full-stick intent each tick.
 */
function runCharging(s: SimState, n: number): void {
  const p = s.players[PASSER]!;
  if (p.act === ActionKind.NONE) startPass(s, PASSER, KickKind.GROUND_PASS, REQ_CHARGE, NULL_SINK);
  for (let i = 0; i < n; i++) {
    if (p.actT > 30) p.actT = 2;
    s.tick++;
    EV.begin(s.tick);
    p.ix = 1; p.iz = 0;
    actionsTick(s, EV);
  }
}

/** n complete passes (start, wind-up, contact, recovery). */
function runPasses(s: SimState, n: number, kind: KickKind): void {
  const p = s.players[PASSER]!;
  for (let k = 0; k < n; k++) {
    giveBall(s, PASSER);
    startPass(s, PASSER, kind, REQ_TAP, NULL_SINK);
    while (p.act !== ActionKind.NONE) {
      s.tick++;
      EV.begin(s.tick);
      actionsTick(s, EV);
    }
  }
}

function heapPerUnit(gc: () => void, f: () => void, units: number): number {
  gc();
  const h0 = process.memoryUsage().heapUsed;
  f();
  return (process.memoryUsage().heapUsed - h0) / units;
}

describe('SIM-08 allocation and cost', () => {
  it('the KICK handler allocates nothing per tick while winding up / charging', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const s = scene();
    runCharging(s, 40000);
    let bytes = 1e9;
    for (let r = 0; r < 3; r++) {
      const b = heapPerUnit(gc, () => runCharging(s, 20000), 20000);
      if (b < bytes) bytes = b;
    }
    console.log(`SIM-08 KICK handler: ${bytes.toFixed(2)} B/tick`);
    expect(bytes).toBeLessThan(2);
  }, 120_000);

  // Contact-time only: SIM-01's closed-form roll solvers (groundPassSpeed / groundRollTime, ~200 B per call: V8 boxes
  // their dmath intermediates) run a few times per lead solve, and the dinked model's hops / roll a few dozen times.
  // A pass every second or two makes this negligible.
  it('a whole pass allocates little (no per-tick garbage; contact-time numbers only)', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (const kind of [KickKind.GROUND_PASS, KickKind.DINKED_PASS]) {
      const s = scene();
      runPasses(s, 3000, kind);
      let bytes = 1e9;
      for (let r = 0; r < 3; r++) {
        const b = heapPerUnit(gc, () => runPasses(s, 2000, kind), 2000);
        if (b < bytes) bytes = b;
      }
      console.log(`SIM-08 whole ${KickKind[kind]}: ${bytes.toFixed(1)} B/pass`);
      expect(bytes).toBeLessThan(kind === KickKind.DINKED_PASS ? 16384 : 8192);
    }
  }, 120_000);

  it('solver cost per pass stays small (ground, and the dinked model search)', () => {
    const out = createKickLaunch();
    for (const kind of [KickKind.GROUND_PASS, KickKind.DINKED_PASS]) {
      const s = scene();
      startPass(s, PASSER, kind, REQ_TAP, NULL_SINK);
      for (let i = 0; i < 3000; i++) solveGroundPass(s, PASSER, out);
      const n = 2000;
      let best = 1e9;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) solveGroundPass(s, PASSER, out);
        const us = (performance.now() - t0) / n * 1000;
        if (us < best) best = us;
      }
      console.log(`SIM-08 solver ${KickKind[kind]}: ${best.toFixed(1)} us/pass`);
      // Loose guard against pathological regressions on a shared, often loaded test machine.
      expect(best).toBeLessThan(kind === KickKind.DINKED_PASS ? 2500 : 500);
    }
  }, 120_000);
});

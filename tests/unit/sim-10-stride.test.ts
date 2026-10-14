/**
 * [SIM-10] "Weighted so he meets it in stride": with the kick error switched off (SIM-08 kickErrorAim mocked to 0, so
 * only the lead / weight solve is measured), the ball flown with the sim's own physics (SIM-02 ballStepTick) meets a
 * runner who keeps running at full speed along his run (accelerating to top speed from his current speed, the model
 * SIM-04 ticksToReach uses) within 1 m, at a playable height, for ground, lobbed and dinked through balls, straight,
 * diagonal and standing starts. The real-error, full-pipeline version is tests/scenario/sim-10-pipeline.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/pass')>()),
  kickErrorAim: () => 0,
}));

import { KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_TOUCH } from '../../src/contracts/tuning';
import { maxSpeed } from '../../src/sim/players/locomotion';
import { fly, KICKER, launched, MATE_A, place, quiet, solveThroughKick } from './sim-09-helpers';

/**
 * Closest approach between the launched ball and the runner (kinematic: accelerating at his accel to his top speed
 * along the unit direction toward the lead point, then on along it), counting only ticks with the ball at or below
 * trap height. Returns [distance, tick, ball height there, runner speed there].
 */
function meet(s: SimState, slot: number, l: { vx: number; vy: number; vz: number; sx: number; sy: number; sz: number; tx: number; tz: number; kind: number; target: number; onTarget: number }): [number, number, number, number] {
  const q = s.players[slot]!;
  const top = maxSpeed(s, slot, true);
  const acc = s.attrs[slot]!.accel;
  let ux = l.tx - q.x, uz = l.tz - q.z;
  const ul = Math.hypot(ux, uz);
  ux /= ul; uz /= ul;
  let px = q.x, pz = q.z;
  let v = Math.max(0, q.vx * ux + q.vz * uz);
  const b = launched(s, l as never);
  let best: [number, number, number, number] = [Infinity, -1, 0, 0];
  fly(b, 300, (i, bb) => {
    v = Math.min(top, v + acc / 60);
    px += ux * v / 60; pz += uz * v / 60;
    const d = Math.hypot(bb.x - px, bb.z - pz);
    if (bb.y <= T_TOUCH.trapHeight && d < best[0]) best = [d, i, bb.y, v];
  });
  return best;
}

function scene(x: number, z: number, vx: number, vz: number): SimState {
  const s = quiet(1, 0, -5);
  const l = Math.hypot(vx, vz) || 1;
  place(s, MATE_A, x, z, vx / l || 1, vz / l, vx, vz);
  s.players[MATE_A]!.sprinting = 1;
  return s;
}

describe('SIM-10 in stride (solver timing vs the sim ball physics)', () => {
  const runs: [string, number, number, number, number][] = [
    ['straight at full speed', 14, 6, 9, 0],
    ['diagonal toward the touchline', 14, 6, 7.5, 4],
    ['diagonal inside', 14, 12, 7.5, -4],
    ['jogging', 12, 6, 4, 0],
    ['standing (led toward goal)', 12, 6, 0, 0],
  ];
  for (const kind of [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED]) {
    for (const [name, x, z, vx, vz] of runs) {
      it(`${KickKind[kind]}: ${name} - the runner meets it within 1 m without stopping`, () => {
        for (const pw of [0.2, 0.6, 1]) {
          const s = scene(x, z, vx, vz);
          const l = solveThroughKick(s, kind, { power: pw, dirX: 1, dirZ: 0.3 })!;
          expect(l.target).toBe(MATE_A);
          const [d, tick, h] = meet(s, MATE_A, l);
          expect(d, `power ${pw}: closest ${d.toFixed(2)} m at tick ${tick}`).toBeLessThan(1);
          expect(h).toBeLessThanOrEqual(T_TOUCH.trapHeight);
          // Met ahead of where he started, along his run (into space, not back to him).
          const q = s.players[MATE_A]!;
          expect((l.tx - q.x) * (vx || 1) + (l.tz - q.z) * vz).toBeGreaterThan(0);
        }
      });
    }
  }

  it('the KICKER is the passer in every run (sanity of the scene)', () => {
    const s = scene(14, 6, 9, 0);
    expect(s.ball.owner).toBe(KICKER);
  });
});

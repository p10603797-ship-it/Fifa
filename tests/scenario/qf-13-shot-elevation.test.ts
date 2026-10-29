/**
 * [QF-13] SIM-11 solver: a soft long shot that cannot carry to its aim point at a shot's usual elevation was solved
 * up the elevation range to 1.3 rad (74 degrees): a balloon straight up (CPU long shots cut to a tap by the quick-shot
 * rule: 25 of 363 Professional shots launched above 45 degrees, 72 above 30, in 20 matches). Every aimed kind (all but
 * the chip) now launches at most T_SHOT.maxAimedElevation; such a shot lands short and bounces on toward the goal.
 */
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import { T_SHOT } from '../../src/contracts/tuning';
import { type SimState } from '../../src/contracts/state';
import { type KickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { GX, launched, shootScene, skill, solveKind, SHOOTER } from '../unit/sim-11-helpers';

function elevation(vx: number, vy: number, vz: number): number { return Math.atan2(vy, Math.hypot(vx, vz)); }

/** Furthest progress toward the goal (x) of the launched ball alone, m. */
function progress(s: SimState, l: KickLaunch): number {
  const b = launched(s, l);
  const x0 = b.x;
  let maxX = b.x;
  for (let i = 0; i < 900; i++) { ballStepTick(b, null); if (b.x > maxX) maxX = b.x; }
  return maxX - x0;
}

describe('QF-13 SIM-11: no balloon shots', () => {
  it('glitch: long shot ballooned straight up — a tapped shot from 30-40 m launches at most maxAimedElevation and still heads for the goal', () => {
    expect(T_SHOT.maxAimedElevation).toBeLessThanOrEqual(0.7);
    let n = 0, worst = 0;
    for (const d of [30, 34, 38, 40]) {
      for (const z of [0, 8, -14]) {
        for (const kind of [KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE]) {
          for (const sk of [35, 60, 85]) {
            const s = shootScene(GX - d, z, 3);
            skill(s, SHOOTER, sk);
            const l = solveKind(s, kind, { power: 0, dirX: 1, dirZ: -z / d }, 11 + sk);
            expect(l).not.toBeNull();
            const e = elevation(l!.vx, l!.vy, l!.vz);
            if (e > worst) worst = e;
            expect(e, `d ${d} z ${z} kind ${kind} skill ${sk}`).toBeLessThanOrEqual(T_SHOT.maxAimedElevation + 1e-9);
            // It still goes toward the goal: forward, and on (in the air, then bouncing / rolling) most of the way.
            expect(l!.vx).toBeGreaterThan(8);
            // [FEEL-1] 24 -> 23: the finesse curls harder (T_SHOT.finesseSpin 9 -> 11), so a tapped skill-35 finesse from
            // 30 m wide (z -14) bends more and runs 23.7 m on, still well toward the goal.
            expect(progress(s, l!), `d ${d} z ${z} kind ${kind} skill ${sk}`).toBeGreaterThan(23);
            n++;
          }
        }
      }
    }
    expect(n).toBe(72);
    expect(worst).toBeGreaterThan(0.3); // the cap is what binds (the soft shot wants to climb)
  });

  it('a normal-power shot from the edge of the box is untouched by the cap (low, into the mouth)', () => {
    for (const z of [0, 5]) {
      const s = shootScene(GX - 17, z, 5);
      const l = solveKind(s, KickKind.SHOT_NORMAL, { power: 0.7, dirX: 1, dirZ: -z / 17 }, 9)!;
      expect(elevation(l.vx, l.vy, l.vz)).toBeLessThan(0.25);
      expect(l.onTarget).toBe(1);
    }
  });
});

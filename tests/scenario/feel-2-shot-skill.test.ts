/**
 * [FEEL-2] Shot types and the shooter's attributes (D-034, D-036): a poor shooter (finishing / long shots / curve /
 * shot power 40) sprays the trivela and the power shot wide more than a normal shot, and the finesse rewards a good
 * shooter (slot 9: finishing 95, curve 78) more than a normal shot does. Probe A of feel-2-shots.test.ts (five spots,
 * both corners, SHOOT 30 ticks, seeds 4-12). Runner: `npx tsx tests/scenario/feel-2-measure.ts shotpoor`.
 */
import { describe, expect, it } from 'vitest';
import { shotRate, type KShot } from './feel-2-helpers';

const SEEDS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const rateA = (st: KShot, shooter?: number): number => {
  const a = shotRate(st, SEEDS, shooter, true), b = shotRate(st, SEEDS, shooter, false);
  return (a.goals + b.goals) / (a.n + b.n);
};

describe('FEEL-2: shot types and the shooter', () => {
  it('a poor shooter (40) sprays the trivela and the power shot wide more than a normal shot (set keeper)', () => {
    const wide = (st: KShot): number => { const c = shotRate(st, SEEDS, 40, true); return c.off / c.n; };
    const n = wide('normal'), t = wide('trivela'), p = wide('power');
    console.log(`FEEL-2 poor shooter wide (n=180): normal ${(100 * n).toFixed(0)}%, trivela ${(100 * t).toFixed(0)}%, power ${(100 * p).toFixed(0)}%`);
    // Measured 15 / 26 / 38%; a top finisher's trivela errs like a normal shot (T_FEEL2.humanTrivelaErrMul 0.7 +
    // humanTrivelaErrSlope 1.0 x (1 - accuracy)).
    expect(t).toBeGreaterThan(n + 0.06);
    expect(p).toBeGreaterThan(n + 0.1);
  }, 600_000);

  it('the finesse rewards a good shooter: his gain over a poor one is larger than with a normal shot', () => {
    const gainF = rateA('finesse') - rateA('finesse', 40), gainN = rateA('normal') - rateA('normal', 40);
    console.log(`FEEL-2 good - poor shooter (probe A, both keepers): finesse ${(100 * gainF).toFixed(1)}, normal ${(100 * gainN).toFixed(1)} points`);
    expect(gainF).toBeGreaterThan(gainN + 0.06); // measured 31.9 v 18.3 points
  }, 600_000);
});

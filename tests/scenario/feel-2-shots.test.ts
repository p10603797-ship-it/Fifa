/**
 * [FEEL-2] Shot types for a human-controlled shooter against a real Professional keeper (D-034, D-036): the finesse is
 * the placed shot a good shooter scores most with, the power shot is about a normal shot's rate, the trivela about a
 * normal shot's +0..5 points for a good shooter (and a harder technique for a poor one: feel-2-shot-skill.test.ts);
 * each keeps its own flight; set pieces and the CPU keep the calibrated shots. Shooter slot 9 (finishing 95, curve 78).
 * Probe A: five spots 16-21 m out, aimed 0.66 / 1.26 m inside either post, SHOOT 30 ticks, seeds 4-12. Probe B (the
 * FEEL-2 skeptics' independent set): those spots plus (30, -10) and (41, 12), the stick 3.2 / 1.6 m off the centre,
 * SHOOT 22 / 36 ticks, seeds 71-73. Both with the keeper set on his line and caught off it (8.6 m out): 696 shots a
 * kind. Runner: `npx tsx tests/scenario/feel-2-measure.ts shot`.
 */
import { describe, expect, it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { T_FEEL, T_FEEL2, T_SHOT } from '../../src/contracts/tuning';
import { shotErrorSigma, shotSpeedFor } from '../../src/sim/kicks/shot';
import { makeScenario } from '../harness/scenario';
import { shotScenario } from './feel-1-helpers';
import { shotRate, shotRateB, type KShot, type ShotTally } from './feel-2-helpers';

const SEEDS_A = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const SEEDS_B = [71, 72, 73];
const CACHE = new Map<string, ShotTally[]>();
/** [A set, A off line, B set, B off line]. */
function cells(style: KShot): ShotTally[] {
  let c = CACHE.get(style);
  if (!c) {
    c = [shotRate(style, SEEDS_A, undefined, true), shotRate(style, SEEDS_A, undefined, false), shotRateB(style, SEEDS_B, undefined, true), shotRateB(style, SEEDS_B, undefined, false)];
    CACHE.set(style, c);
  }
  return c;
}
const rate = (cs: readonly ShotTally[]): number => cs.reduce((a, c) => a + c.goals, 0) / cs.reduce((a, c) => a + c.n, 0);

describe('FEEL-2: shot types against a Professional keeper (good shooter, both probes, both keeper situations)', () => {
  it('finesse best; power about normal; trivela normal +0..5 points', () => {
    const normal = rate(cells('normal')), finesse = rate(cells('finesse')), power = rate(cells('power')), trivela = rate(cells('trivela'));
    console.log(`FEEL-2 shot rates (n=696 each): normal ${(100 * normal).toFixed(1)}%, finesse ${(100 * finesse).toFixed(1)}%, power ${(100 * power).toFixed(1)}%, trivela ${(100 * trivela).toFixed(1)}%`);
    // Measured 39.2 / 52.0 / 41.2 / 42.0% (the first FEEL-2 commit on probe A alone: 41 / 47 / 45 / 28%).
    expect(finesse).toBeGreaterThanOrEqual(normal + 0.08);
    expect(finesse).toBeGreaterThan(power);
    expect(finesse).toBeGreaterThan(trivela);
    expect(Math.abs(power - normal)).toBeLessThanOrEqual(0.05);
    expect(trivela).toBeGreaterThanOrEqual(normal - 0.01);
    expect(trivela).toBeLessThanOrEqual(normal + 0.06);
  }, 600_000);

  it('the same order on probe B alone (the skeptics\' spots, aims and holds): finesse best, trivela not below normal', () => {
    const b = (st: KShot): number => rate(cells(st).slice(2));
    // Measured normal 37.5%, finesse 47.0%, power 37.2%, trivela 44.6% (the first FEEL-2 commit, skeptics' slot 9:
    // finesse 32.7 v normal 35.5, trivela 25.7%).
    expect(b('finesse')).toBeGreaterThan(b('normal') + 0.05);
    expect(b('trivela')).toBeGreaterThanOrEqual(b('normal'));
    expect(Math.abs(b('power') - b('normal'))).toBeLessThanOrEqual(0.06);
  }, 600_000);

  it('a stick right in the corner does not send the placed finesse wide (it is placed, not blended with the raw ray)', () => {
    const c = cells('finesse');
    const off = (c[0]!.off + c[2]!.off) / (c[0]!.n + c[2]!.n);
    expect(off).toBeLessThanOrEqual(0.03); // set keeper, both probes: measured 0 of 348 (first FEEL-2 commit 8-12% wide)
  }, 600_000);
});

describe('FEEL-2: each shot keeps its own flight', () => {
  it('finesse bends ~4.6 m, trivela ~3.5 m the other way, power ~30 m/s straight, normal a slight curl', () => {
    const f = shotScenario({ style: 'finesse', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const t = shotScenario({ style: 'trivela', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const p = shotScenario({ style: 'power', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const n = shotScenario({ style: 'normal', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    expect(f.kind).toBe(KickKind.SHOT_FINESSE);
    expect(t.kind).toBe(KickKind.SHOT_TRIVELA);
    expect(Math.abs(f.curve)).toBeGreaterThan(4.2); // measured 4.59
    expect(Math.abs(f.curve)).toBeLessThan(5.0);
    expect(Math.abs(t.curve)).toBeGreaterThan(3.2); // measured 3.48
    expect(Math.abs(t.curve)).toBeLessThan(3.9);
    expect(Math.sign(t.curve)).toBe(-Math.sign(f.curve));
    expect(p.speed).toBeGreaterThan(29); // 30.05
    expect(Math.abs(p.curve)).toBeLessThan(0.2);
    expect(Math.abs(n.curve)).toBeGreaterThan(0.6); // 1.06
    expect(Math.abs(n.curve)).toBeLessThan(1.5);
    // Speeds: finesse 23.4 < normal 24.1 < trivela 24.6 < power 30.0 m/s.
    expect(f.speed).toBeLessThan(n.speed);
    expect(t.speed).toBeLessThan(p.speed);
  });

  it('the CPU\'s shots keep the calibrated physics (the bot game is unchanged)', () => {
    const human = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: [{ side: 0, slot: 9 }] });
    const bot = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: 0 });
    expect(shotSpeedFor(human, 9, KickKind.SHOT_FINESSE, 0.7, 0) / shotSpeedFor(bot, 9, KickKind.SHOT_FINESSE, 0.7, 0))
      .toBeCloseTo(T_FEEL2.humanFinesseSpeedMul / T_SHOT.finesseSpeedMul, 6);
    expect(shotSpeedFor(human, 9, KickKind.SHOT_TRIVELA, 0.7, 0) / shotSpeedFor(bot, 9, KickKind.SHOT_TRIVELA, 0.7, 0))
      .toBeCloseTo(T_FEEL2.humanTrivelaSpeedMul / T_FEEL.trivelaSpeedMul, 6);
  });

  it('set pieces keep the calibrated shots: a human\'s free-kick finesse and penalty power shot are struck like the CPU\'s', () => {
    for (const phase of [MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.SHOOT_OUT]) {
      const human = makeScenario({ phase, seed: 1, humans: [{ side: 0, slot: 9 }] });
      const bot = makeScenario({ phase, seed: 1, humans: 0 });
      for (const k of [KickKind.SHOT_FINESSE, KickKind.SHOT_TRIVELA, KickKind.SHOT_POWER]) {
        expect(shotSpeedFor(human, 9, k, 0.7, 0), `phase ${phase} kind ${k}`).toBe(shotSpeedFor(bot, 9, k, 0.7, 0));
        expect(shotErrorSigma(human, 9, k, 0.7, 1, 0, 11), `phase ${phase} kind ${k}`).toBe(shotErrorSigma(bot, 9, k, 0.7, 1, 0, 11));
      }
    }
    // In open play the human's power shot errs T_FEEL2.humanPowerErrMul / 1.1 more (the control case).
    const h = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: [{ side: 0, slot: 9 }] });
    const b = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: 0 });
    expect(shotErrorSigma(h, 9, KickKind.SHOT_POWER, 0.7, 1, 0, 11)).toBeGreaterThan(shotErrorSigma(b, 9, KickKind.SHOT_POWER, 0.7, 1, 0, 11));
  });
});

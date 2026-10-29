/**
 * [FEEL-2] Shot types against a real Professional keeper (D-034): the finesse is the placed shot that a good shooter
 * scores most with, the power shot is about a normal shot's rate (not twice it), the trivela is a harder, lower-
 * percentage technique than the finesse that a poor shooter sprays wide more than a normal shot; each keeps its own
 * flight. Human shooter (slot 9: finishing 95, curve 78, shot power 90) from five spots 16-21 m out (both corners, 0.66
 * and 1.26 m inside the posts, SHOOT held 30 ticks, seeds 4-12), the keeper set on his line and caught off it (the
 * scenario's 8.6 m out): 180 shots a cell. Runner: `npx tsx tests/scenario/feel-2-measure.ts shot`.
 */
import { describe, expect, it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { T_FEEL2, T_SHOT } from '../../src/contracts/tuning';
import { shotSpeedFor } from '../../src/sim/kicks/shot';
import { makeScenario } from '../harness/scenario';
import { shotScenario } from './feel-1-helpers';
import { shotRate, type KShot } from './feel-2-helpers';

const SEEDS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
type Cell = { goals: number; off: number; n: number };
const CACHE = new Map<string, Cell>();
function cell(style: KShot, setKeeper: boolean, shooter?: number): Cell {
  const k = `${style}/${setKeeper ? 'set' : 'off'}/${shooter ?? 'good'}`;
  let c = CACHE.get(k);
  if (!c) { const r = shotRate(style, SEEDS, shooter, setKeeper); c = { goals: r.goals, off: r.off, n: r.n }; CACHE.set(k, c); }
  return c;
}
/** Scoring rate over both keeper situations (360 shots). */
function rate(style: KShot, shooter?: number): number {
  const a = cell(style, true, shooter), b = cell(style, false, shooter);
  return (a.goals + b.goals) / (a.n + b.n);
}

describe('FEEL-2: shot types against a Professional keeper', () => {
  it('a good shooter scores most with the finesse; the power shot is about a normal shot; the trivela is below the finesse', () => {
    const normal = rate('normal'), finesse = rate('finesse'), power = rate('power'), trivela = rate('trivela');
    console.log(`FEEL-2 shot rates (set + off-line keeper, n=360 each): normal ${(100 * normal).toFixed(0)}%, finesse ${(100 * finesse).toFixed(0)}%, power ${(100 * power).toFixed(0)}%, trivela ${(100 * trivela).toFixed(0)}%`);
    // Measured 41 / 47 / 45 / 28% (before FEEL-2: 41 / 26 / 54 / 23%; against the set keeper alone 26 / 0 / 52 / 8%,
    // now 26 / 41 / 39 / 17%).
    expect(finesse).toBeGreaterThanOrEqual(normal + 0.03);
    expect(finesse).toBeGreaterThanOrEqual(power);
    expect(Math.abs(power - normal)).toBeLessThanOrEqual(0.08);
    expect(trivela).toBeLessThanOrEqual(finesse - 0.1);
    expect(trivela).toBeGreaterThanOrEqual(normal - 0.18);
    expect(trivela).toBeLessThanOrEqual(normal + 0.05);
    // A set keeper is beaten by a finesse to the corner now (0 of 180 before FEEL-2).
    expect(cell('finesse', true).goals / 180).toBeGreaterThanOrEqual(0.3);
  }, 300_000);

  it('the finesse rewards a good shooter: his gain over a poor one (40) is larger than with a normal shot', () => {
    const gainF = rate('finesse') - rate('finesse', 40), gainN = rate('normal') - rate('normal', 40);
    expect(gainF).toBeGreaterThan(gainN + 0.03); // measured 25 v 18 points
  }, 300_000);

  it('a poor shooter (40) sprays the trivela and the power shot wide more than a normal shot', () => {
    const wide = (st: KShot): number => { const c = cell(st, true, 40); return c.off / c.n; };
    // Measured wide: normal 15%, trivela 22%, power 38% (set keeper, n=180).
    expect(wide('trivela')).toBeGreaterThan(wide('normal') + 0.03);
    expect(wide('power')).toBeGreaterThan(wide('trivela'));
  }, 300_000);
});

describe('FEEL-2: each shot keeps its own flight', () => {
  it('finesse bends ~4.7 m into the far corner, trivela ~3.6 m the other way, power ~30 m/s straight, normal a slight curl', () => {
    const f = shotScenario({ style: 'finesse', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const t = shotScenario({ style: 'trivela', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const p = shotScenario({ style: 'power', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    const n = shotScenario({ style: 'normal', x: 30, z: -8, aimZ: 2.5, hold: 20, seed: 3 });
    expect(f.kind).toBe(KickKind.SHOT_FINESSE);
    expect(t.kind).toBe(KickKind.SHOT_TRIVELA);
    expect(Math.abs(f.curve)).toBeGreaterThan(4.2); // measured 4.68
    expect(Math.abs(f.curve)).toBeLessThan(5.2);
    expect(Math.abs(t.curve)).toBeGreaterThan(3.2); // measured 3.61
    expect(Math.abs(t.curve)).toBeLessThan(4.0);
    expect(Math.sign(t.curve)).toBe(-Math.sign(f.curve));
    expect(p.speed).toBeGreaterThan(29); // 30.0
    expect(Math.abs(p.curve)).toBeLessThan(0.2);
    expect(Math.abs(n.curve)).toBeGreaterThan(0.6); // 1.06
    expect(Math.abs(n.curve)).toBeLessThan(1.5);
    // Speeds: normal 24.1 > trivela 22.9 > finesse 22.2 m/s.
    expect(f.speed).toBeLessThan(t.speed);
    expect(t.speed).toBeLessThan(n.speed);
  });

  it('the CPU\'s shots keep the calibrated physics (the bot game is unchanged): a CPU finesse is struck at T_SHOT.finesseSpeedMul', () => {
    const human = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: [{ side: 0, slot: 9 }] });
    const bot = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: 0 });
    const vh = shotSpeedFor(human, 9, KickKind.SHOT_FINESSE, 0.7, 0);
    const vb = shotSpeedFor(bot, 9, KickKind.SHOT_FINESSE, 0.7, 0);
    expect(vh / vb).toBeCloseTo(T_FEEL2.humanFinesseSpeedMul / T_SHOT.finesseSpeedMul, 6);
  });
});

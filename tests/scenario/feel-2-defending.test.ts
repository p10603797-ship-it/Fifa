/**
 * [FEEL-2] CPU defending against a human dribbler, the side-step duel (D-033, D-035): measured on the FEEL-2 skeptics'
 * multi-geometry grid (tests/scenario/feel-2-helpers.ts sideStepGrid: centre-backs, a full-back against a winger, the
 * edge of the box, midfield and the FEEL-1 skeptic's centre-back; three lateral offsets; steps from 4.5 and 7 m; R1 and
 * sprint; seeds 21-23: 972 scenes a level). Every side step is one deterministic draw: sold (wrong-footed, no
 * challenge) with T_FEEL2.duelSoldChance by level x the dribbler factor, else read (to where the ball crosses his line,
 * the read tackle only when safe). The numbers are the measured ones (deterministic) with margins. Runner:
 * `npx tsx tests/scenario/feel-2-measure.ts grid`.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { sideStepGrid, type GridSummary } from './feel-2-helpers';

const RATE: number[] = [];
const SUM: GridSummary[] = [];
function grid(lv: Difficulty): GridSummary {
  if (SUM[lv] === undefined) { SUM[lv] = sideStepGrid(lv); RATE[lv] = SUM[lv]!.beat / SUM[lv]!.n; }
  return SUM[lv]!;
}

describe('FEEL-2: a side step against a CPU defender scales with the difficulty (multi-geometry grid)', () => {
  // Measured (beaten): 81.3 / 89.8 / 80.5 / 53.2 / 41.8 / 38.7% (D-038 sold chances; D-035: 81.3 / 89.8 / 80.5 / 56.4 /
  // 39.9 / 37.2%; cc2c605: 67 / 61 / 48 / 47 / 43 / 46%; the first
  // FEEL-2 commit: 65 / 56 / 57 / 58 / 60 / 60% with escorts). Beginner sits under Amateur: his 100-tick reaction delay
  // keeps him out of the duel in most scenes (he stands, and a standing body still blocks some steps).
  const bands: [Difficulty, number, number][] = [
    [Difficulty.BEGINNER, 0.8, 1],
    [Difficulty.AMATEUR, 0.8, 1],
    [Difficulty.SEMI_PRO, 0.65, 0.9],
    [Difficulty.PROFESSIONAL, 0.5, 0.65],
    [Difficulty.WORLD_CLASS, 0.33, 0.55],
    [Difficulty.LEGEND, 0.3, 0.45],
  ];
  for (const [lv, lo, hi] of bands) {
    it(`level ${Difficulty[lv]}: beaten ${Math.round(lo * 100)}-${Math.round(hi * 100)}%; no fouls spike, escort, overlap or teleport`, () => {
      const g = grid(lv);
      expect(g.n).toBe(972);
      const beat = g.beat / g.n;
      console.log(`FEEL-2 grid ${Difficulty[lv]}: beaten ${(100 * beat).toFixed(1)}% ${JSON.stringify(g)}`);
      expect(beat).toBeGreaterThanOrEqual(lo);
      expect(beat).toBeLessThanOrEqual(hi);
      // Fouls 3 / 0 / 2 / 4 / 14 / 8 in 972 (D-035 3 / 0 / 2 / 2 / 14 / 8; cc2c605: 67 / 80 / 123 / 70 / 34 / 38; the first FEEL-2 commit up to 135,
      // with reds and penalties from the shoulder challenge). No penalty, at most 2 red cards (DOGSO on an empty pitch).
      expect(g.fouls).toBeLessThanOrEqual(20);
      expect(g.pens).toBe(0);
      expect(g.reds).toBeLessThanOrEqual(2);
      // Escorts over 1.5 s (defender alongside, not goal-side, the dribbler on the ball): 9 / 0 / 5 / 2 / 0 / 1 (cc2c605
      // 6-9; the first FEEL-2 commit 405-453 at Professional+).
      expect(g.escorts).toBeLessThanOrEqual(12);
      // SIM-05 bodies: the closest centres 0.703 m (cc2c605 the same 0.71); no jump faster than a sprint.
      expect(g.minSep).toBeGreaterThan(0.68);
      expect(g.maxJump).toBeLessThan(0.17);
    }, 300_000);
  }

  it('from Amateur up, the higher the level the less often the side step works', () => {
    for (const lv of [Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) grid(lv);
    expect(RATE[Difficulty.LEGEND]!).toBeLessThan(RATE[Difficulty.WORLD_CLASS]!);
    expect(RATE[Difficulty.WORLD_CLASS]!).toBeLessThan(RATE[Difficulty.PROFESSIONAL]!);
    expect(RATE[Difficulty.PROFESSIONAL]!).toBeLessThan(RATE[Difficulty.SEMI_PRO]!);
    expect(RATE[Difficulty.SEMI_PRO]!).toBeLessThan(RATE[Difficulty.AMATEUR]!);
  }, 600_000);
});

/**
 * [FEEL-2 round 2] A short side step (25 ticks of lateral stick, then straight on at goal), the FEEL-2 skeptics' round-2
 * shape, on the same grid (972 scenes a level): D-035's bands held only for a step held while the dribbler closed
 * (their own grid: Amateur 72%, Legend 24%). Legend's sold chance 0.04 -> 0.06 (World Class 0.12 -> 0.14, Professional
 * 0.3 -> 0.28) puts Legend in its band for both shapes. Beginner is left out of this row: his 100-tick reaction delay
 * keeps him standing, and a dribbler who steps for 0.4 s and then turns back at goal runs into him (64%).
 */
describe('FEEL-2 round 2: a short side step (25 ticks, then straight on)', () => {
  const SHORT: GridSummary[] = [];
  const short = (lv: Difficulty): GridSummary => (SHORT[lv] ??= sideStepGrid(lv, { stepTicks: 25 }));
  // Measured (beaten): Amateur 92.0, Semi-Pro 82.4, Professional 51.3, World Class 35.3, Legend 31.0% (D-035's
  // values: 92.0 / 82.3 / 54.2 / 32.7 / 28.2%).
  const bands: [Difficulty, number, number][] = [
    [Difficulty.AMATEUR, 0.8, 1],
    [Difficulty.PROFESSIONAL, 0.45, 0.65],
    [Difficulty.LEGEND, 0.29, 0.45],
  ];
  for (const [lv, lo, hi] of bands) {
    it(`level ${Difficulty[lv]}: beaten ${Math.round(lo * 100)}-${Math.round(hi * 100)}%, no fouls spike, no penalty`, () => {
      const g = short(lv);
      const beat = g.beat / g.n;
      console.log(`FEEL-2 short-step grid ${Difficulty[lv]}: beaten ${(100 * beat).toFixed(1)}% ${JSON.stringify(g)}`);
      expect(beat).toBeGreaterThanOrEqual(lo);
      expect(beat).toBeLessThanOrEqual(hi);
      expect(g.fouls).toBeLessThanOrEqual(20);
      expect(g.pens).toBe(0);
      expect(g.minSep).toBeGreaterThan(0.68);
      expect(g.maxJump).toBeLessThan(0.17);
    }, 300_000);
  }
});

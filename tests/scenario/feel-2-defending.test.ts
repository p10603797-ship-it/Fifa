/**
 * [FEEL-2] CPU defending against a human dribbler (D-033): the controlled CPU centre-back jockeys (holds the goal-side
 * line, mirrors lateral moves, never steps in), a side step sells him with a chance that falls with the difficulty and
 * rises with the dribbler's dribbling / agility, and a beaten defender at the top levels gets alongside for a shoulder
 * challenge. Scripted pad input through the real pipeline (tests/scenario/feel-2-helpers.ts vsDefender); the numbers
 * are the measured ones (deterministic) with margins. Runner: `SEEDS=8 npx tsx tests/scenario/feel-2-measure.ts def`.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CH_SHOULDER, DEFEND_DEBUG } from '../../src/ai/cpu/defending';
import { runMatch } from '../../tools/headless';
import { BODY_TOUCH, sideStepGrid, vsDefender } from './feel-2-helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('FEEL-2: a side step against a CPU centre-back scales with the difficulty', () => {
  // R1 and sprint, seeds 1-8, the defender 0 / 1.5 m off the dribbler's line either side, side steps of 0.4 and 0.8 of
  // the stick from 6 m: 96 scenes a level. Measured (beaten): 87.5 / 85.4 / 74.0 / 58.3 / 49.0 / 39.6%.
  const bands: [Difficulty, number, number][] = [
    [Difficulty.BEGINNER, 0.8, 1],
    [Difficulty.AMATEUR, 0.8, 1],
    [Difficulty.SEMI_PRO, 0.64, 0.84],
    [Difficulty.PROFESSIONAL, 0.5, 0.65],
    [Difficulty.WORLD_CLASS, 0.4, 0.58],
    [Difficulty.LEGEND, 0.3, 0.45],
  ];
  const rate: number[] = [];
  for (const [lv, lo, hi] of bands) {
    it(`level ${Difficulty[lv]}: beaten by the side step ${Math.round(lo * 100)}-${Math.round(hi * 100)}% of the time, no overlap, teleport or running in place`, () => {
      const r = sideStepGrid(lv, { seeds: SEEDS });
      expect(r.n).toBe(96);
      const beat = r.beat / r.n;
      rate[lv] = beat;
      expect(beat).toBeGreaterThanOrEqual(lo);
      expect(beat).toBeLessThanOrEqual(hi);
      // Glitch checks over the 96 scenes: bodies never overlap (SIM-05 keeps 2 radii), no jump faster than a sprint, no
      // free defender pushing his stick without moving, fouls no more than the FEEL-1 defender gave (23 in 576 scenes
      // over all six levels before FEEL-2; 17 now, Professional 7).
      expect(r.minSep).toBeGreaterThan(BODY_TOUCH - 0.02);
      expect(r.maxJump).toBeLessThan(0.17);
      expect(r.stuck).toBeLessThanOrEqual(5); // ticks in 96 scenes (Amateur 3; before FEEL-2 up to 3 too)
      expect(r.fouls).toBeLessThanOrEqual(8);
    });
  }
  it('the higher the level, the less often the side step works (Legend < World Class < Professional < Semi-Pro < Amateur)', () => {
    for (const [lv] of bands) if (rate[lv] === undefined) rate[lv] = sideStepGrid(lv, { seeds: SEEDS }).beat / 96;
    expect(rate[Difficulty.LEGEND]!).toBeLessThan(rate[Difficulty.WORLD_CLASS]!);
    expect(rate[Difficulty.WORLD_CLASS]!).toBeLessThan(rate[Difficulty.PROFESSIONAL]!);
    expect(rate[Difficulty.PROFESSIONAL]!).toBeLessThan(rate[Difficulty.SEMI_PRO]!);
    expect(rate[Difficulty.SEMI_PRO]!).toBeLessThan(rate[Difficulty.AMATEUR]!);
  });
});

describe('FEEL-2: the jockey is not a wall', () => {
  it('running straight at a Professional / World Class / Legend centre-back still loses the ball (R1, sprint, jog)', () => {
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      let n = 0, lost = 0;
      for (const style of ['r1', 'sprint', 'jog'] as const) for (const seed of [1, 2, 3, 4]) for (const lat of [-0.5, 0, 0.5]) {
        const r = vsDefender({ style, level, seed, lat, weave: 0 });
        n++;
        expect(r.res, `${Difficulty[level]} ${style} seed ${seed} lat ${lat}`).not.toBe('beat');
        if (r.res === 'lost') lost++;
      }
      expect(lost / n).toBeGreaterThanOrEqual(0.9); // measured 92 / 100 / 94% (the rest are fouls for the dribbler)
    }
  });

  it('a skilled dribbler (dribbling / control / agility 90) beats the jockey far more often than a poor one (35)', () => {
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      const good = sideStepGrid(level, { seeds: SEEDS, skill: 90 }).beat / 96;
      const poor = sideStepGrid(level, { seeds: SEEDS, skill: 35 }).beat / 96;
      // Measured Professional 57 v 30%, Legend 57 v 24%.
      expect(good - poor, Difficulty[level]).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('no orbiting or jitter: running straight at him, the defender reverses his lateral run at most once (settling onto the line)', () => {
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) for (const style of ['r1', 'sprint'] as const) {
      for (const seed of [1, 2, 3]) for (const lat of [-1, 0, 1]) {
        expect(vsDefender({ style, level, seed, lat, weave: 0 }).flips).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('FEEL-2: bot v bot untouched', () => {
  it('the jockey and the shoulder challenge are for human carriers only: no CPU shoulder challenge (CH_SHOULDER) in two bot matches', () => {
    let shoulders = 0;
    for (const seed of [11, 12]) {
      const config = createMatchConfig();
      config.seed = seed;
      config.halfMinutes = 2;
      config.difficulty = Difficulty.LEGEND;
      runMatch({
        config, fastCutscenes: true, checker: 'none',
        onTick: () => { if (DEFEND_DEBUG.why0 === CH_SHOULDER || DEFEND_DEBUG.why1 === CH_SHOULDER) shoulders++; },
      });
    }
    expect(shoulders).toBe(0);
  });
});

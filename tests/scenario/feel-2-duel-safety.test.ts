/**
 * [FEEL-2 skeptic] Regression tests for the defects the FEEL-2 skeptics found in the first FEEL-2 defending (D-035):
 * no escort or shoulder-from-behind after a side step, no foul / card spike from challenges on a human running at the
 * defender (careful tackles while retreating, the jockey handing over to the block, a shoulder challenge through his
 * back or in the box), no "sold" lean on a steady diagonal, the dribbler's skill deciding more of the duel, and the
 * bot game untouched (bit-identical to cc2c605). Scenes: tests/scenario/feel-2-helpers.ts; runner
 * `npx tsx tests/scenario/feel-2-measure.ts [straight|chase|diagonal|weave|skill]`.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { runMatch } from '../../tools/headless';
import { chases, diagonalMoves, levelChases, sideStepGrid, straightRuns, weavingJogger } from './feel-2-helpers';

const TOP = [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];

describe('FEEL-2 skeptic: running straight at a Professional+ centre-back', () => {
  it('jogging (stick 0.6-0.9, straight or weaving), in R1 or sprinting from x 10 and 24: the ball is lost, no foul spike, no yellow, no penalty', () => {
    for (const lv of TOP) {
      const t = straightRuns(lv);
      console.log(`FEEL-2 straight runs ${Difficulty[lv]}: ${JSON.stringify(t)}`);
      // Measured lost 239 / 231 / 227 of 240, fouls 1 / 1 / 3 (each a slide's DOGSO red on the empty pitch, the
      // QF-13 slide unchanged). The first FEEL-2 commit: fouls up to 61 in a similar 432-scene set, cc2c605 16-28.
      expect(t.lost / t.n, Difficulty[lv]).toBeGreaterThanOrEqual(0.9);
      expect(t.fouls, Difficulty[lv]).toBeLessThanOrEqual(5);
      expect(t.yellows, Difficulty[lv]).toBe(0);
      expect(t.pens, Difficulty[lv]).toBe(0);
    }
  }, 300_000);

  it('the TAI-11 weaving jogger: still always dispossessed, fouls no higher than cc2c605 (7 / 5 / 5), never a yellow card', () => {
    const base = [7, 5, 5];
    TOP.forEach((lv, i) => {
      const t = weavingJogger(lv);
      console.log(`FEEL-2 weaving jogger ${Difficulty[lv]}: ${JSON.stringify(t)}`);
      expect(t.lost).toBe(t.n); // 48 of 48
      expect(t.fouls).toBeLessThanOrEqual(base[i]!); // measured 6 / 4 / 4 (first FEEL-2 commit 13 / 12 / 13)
      expect(t.yellows).toBe(0); // first FEEL-2 commit 4 / 7 / 4
    });
  }, 300_000);
});

describe('FEEL-2 skeptic: a beaten defender chasing a human', () => {
  it('chasing from 0-2.5 m behind (from x 10, and into the box from x 25): no foul, card or penalty', () => {
    for (const lv of TOP) for (const sx of [10, 25]) {
      const t = chases(lv, sx);
      expect(t.fouls, `${Difficulty[lv]} sx ${sx}`).toBe(0); // the first FEEL-2 commit: 4-11 fouls, up to 9 reds / 9 penalties
      expect(t.cards, `${Difficulty[lv]} sx ${sx}`).toBe(0);
      expect(t.pens, `${Difficulty[lv]} sx ${sx}`).toBe(0);
    }
  }, 300_000);

  it('level and alongside, World Class / Legend make the shoulder challenge, and it is never a foul', () => {
    let shoulders = 0;
    for (const lv of TOP) {
      const t = levelChases(lv);
      console.log(`FEEL-2 level chases ${Difficulty[lv]}: ${JSON.stringify(t)}`);
      expect(t.fouls, Difficulty[lv]).toBe(0);
      shoulders += t.shoulders;
    }
    expect(shoulders).toBeGreaterThanOrEqual(6); // measured 0 / 4 / 8 in 36 scenes a level
  }, 300_000);

  it('no escort: over the side-step grid at Professional / Legend no defender runs alongside for over 1.5 s more than a handful of times', () => {
    for (const lv of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      const g = sideStepGrid(lv, { seeds: [24, 25] });
      // The first FEEL-2 commit: escorts over 1.5 s in about 37-47% of these scenes (base cc2c605 about 0.5%).
      expect(g.escorts / g.n, Difficulty[lv]).toBeLessThanOrEqual(0.02);
    }
  }, 300_000);
});

describe('FEEL-2 skeptic: the sell needs a real side step', () => {
  it('a constant diagonal dribble (the lateral direction never changes) is never read as a move, at any level', () => {
    for (const lv of [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, ...TOP]) {
      const r = diagonalMoves(lv);
      expect(r.n).toBe(54);
      expect(r.moves, Difficulty[lv]).toBe(0); // the first FEEL-2 commit re-drew every 30 ticks of lateral speed
    }
  }, 300_000);

  it('the dribbler decides more of the duel: a 90-rated dribbler beats Professional / Legend far more often than a 35-rated one', () => {
    for (const lv of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      const good = sideStepGrid(lv, { seeds: [21], skill: 90 }), poor = sideStepGrid(lv, { seeds: [21], skill: 35 });
      const d = good.beat / good.n - poor.beat / poor.n;
      // Measured Professional 72.8 v 18.8%, Legend 44.1 v 9.0% (the first FEEL-2 commit: a 35-rated dribbler still beat
      // a Legend centre-back 78% of the time on the skeptics' grid).
      expect(d, Difficulty[lv]).toBeGreaterThanOrEqual(0.3);
      expect(poor.beat / poor.n, Difficulty[lv]).toBeLessThanOrEqual(0.25);
    }
  }, 300_000);
});

describe('FEEL-2: the bot game is untouched', () => {
  it('bot v bot (no human on either side) is bit-identical to cc2c605: pinned 3-minute-half hashes', () => {
    const out: string[] = [];
    for (const [seed, lv] of [[1, Difficulty.PROFESSIONAL], [2, Difficulty.LEGEND], [3, Difficulty.BEGINNER]] as const) {
      const config = createMatchConfig();
      config.seed = seed;
      config.halfMinutes = 3;
      config.difficulty = lv;
      config.humans = [{ ...config.humans[1]! }, { ...config.humans[1]! }];
      const r = runMatch({ config, fastCutscenes: true, checker: 'none' });
      out.push(`${seed}/${lv}:${r.hash.toString(16)}`);
    }
    // The same hashes on cc2c605 (before FEEL-2): every FEEL-2 change applies to human-controlled players only.
    expect(out.join(' ')).toBe('1/3:929d6427 2/5:856d9095 3/0:9d818051');
  }, 300_000);
});

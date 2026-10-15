/**
 * [QF-11 skeptic] Club balance lever: a carrier who does not see the pass decides noisier (T_AI.visionNoise*, TAI-08
 * option noise), weighted by level like composure (T_LEVEL.composureNoiseWeight). MOS (88) v ROO (62) won 76.5-78.8%
 * over 800 matches (target 80%) with composure alone; the clubs' vision gap (78 v 52) is where they differ while the
 * closest-rated pair (SND v GLA, 63 v 66) does not. The penalty is steeper than the bonus: a large bonus brings a strong
 * club's Professional as close to World Class (the ladder's top pair) as the penalty pushes a weak club away.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { T_AI, T_LEVEL } from '../../src/contracts/tuning';
import { composureNoiseMul, visionNoiseMul } from '../../src/ai/cpu/levels';

describe('QF-11 skeptic: vision noise multiplier', () => {
  it('is 1 at the reference, monotonic (sees the pass = cleaner), steeper below the reference than above, clamped', () => {
    expect(visionNoiseMul(T_AI.visionNoiseRef)).toBe(1);
    let prev = Infinity;
    for (let v = 1; v <= 99; v++) {
      const m = visionNoiseMul(v);
      expect(m).toBeLessThanOrEqual(prev);
      expect(m).toBeGreaterThanOrEqual(T_AI.visionNoiseMin);
      expect(m).toBeLessThanOrEqual(T_AI.visionNoiseMax);
      prev = m;
    }
    const below = visionNoiseMul(T_AI.visionNoiseRef - 10) - 1, above = 1 - visionNoiseMul(T_AI.visionNoiseRef + 10);
    expect(below).toBeGreaterThan(above);
    expect(above).toBeGreaterThanOrEqual(0); // no bonus at the kept visionNoiseBonusSlope 0
    expect(visionNoiseMul(Number.NaN)).toBe(1);
    expect(visionNoiseMul(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('is weighted by level like composure: none where the composure weight is 0, full at Professional', () => {
    for (let lv = Difficulty.BEGINNER; lv <= Difficulty.LEGEND; lv++) {
      const w = T_LEVEL.composureNoiseWeight[lv]!;
      const m = visionNoiseMul(40, lv);
      if (w === 0) expect(m).toBe(1);
      else expect(m).toBeGreaterThan(1);
      // The same weighting as composure, so the two levers act at the same levels.
      expect(m === 1).toBe(composureNoiseMul(40, lv) === 1);
    }
    expect(visionNoiseMul(40, 99 as Difficulty)).toBeCloseTo(visionNoiseMul(40, Difficulty.PROFESSIONAL), 12);
  });

  it('widens the noise gap between an 88-rated and a 62-rated side\'s typical carriers', () => {
    const top = composureNoiseMul(87) * visionNoiseMul(78);
    const bottom = composureNoiseMul(57) * visionNoiseMul(52);
    expect(bottom / top).toBeGreaterThan(composureNoiseMul(57) / composureNoiseMul(87));
  });
});

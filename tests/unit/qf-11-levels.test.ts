/**
 * [QF-11] Difficulty ladder plumbing: the extra per-level AI tables (T_LEVEL beyond LevelParams), their reader
 * (levelValue / teamLevel: a human side always plays its AI at Professional), the composure noise multiplier, and the
 * rule that Professional keeps the pre-QF-11 behaviour (the section 7 bands are measured there).
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { T_AI, T_LEVEL } from '../../src/contracts/tuning';
import { composureNoiseMul, LEVEL_COUNT, levelParams, levelValue, teamLevel } from '../../src/ai/cpu/levels';
import { makeScenario } from '../harness/scenario';

const EXTRA = ['carrierEvalTicks', 'markGapMul', 'lineRateMul', 'keeperReactTicks', 'composureNoiseWeight'] as const;
const PRO = Difficulty.PROFESSIONAL;

describe('QF-11 extra level tables', () => {
  it('every extra table has one finite entry per level', () => {
    for (const k of EXTRA) {
      const t = T_LEVEL[k] as readonly number[];
      expect(t.length, k).toBe(LEVEL_COUNT);
      for (const v of t) expect(Number.isFinite(v), k).toBe(true);
    }
  });

  it('Professional keeps the pre-QF-11 behaviour (the section 7 bands are measured there)', () => {
    expect(T_LEVEL.carrierEvalTicks[PRO]).toBe(T_AI.carrierEvalInterval);
    expect(T_LEVEL.markGapMul[PRO]).toBe(1);
    expect(T_LEVEL.lineRateMul[PRO]).toBe(1);
    expect(T_LEVEL.keeperReactTicks[PRO]).toBe(0);
  });

  it('periods are whole ticks >= 1 and multipliers positive', () => {
    for (const v of T_LEVEL.carrierEvalTicks) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(1); }
    for (const v of [...T_LEVEL.markGapMul, ...T_LEVEL.lineRateMul]) expect(v).toBeGreaterThan(0);
  });
});

describe('QF-11 teamLevel / levelValue', () => {
  it('a CPU side reads its own level; a human side (no active brain) and a bad level read Professional', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }] });
    expect(s.teams[0]!.cpu.active).toBe(0);
    expect(s.teams[1]!.cpu.active).toBe(1);
    const table = [10, 11, 12, 13, 14, 15];
    for (let lv = 0; lv < LEVEL_COUNT; lv++) {
      s.teams[0]!.cpu.level = lv as Difficulty;
      s.teams[1]!.cpu.level = lv as Difficulty;
      expect(teamLevel(s, 0)).toBe(PRO);
      expect(levelValue(s, 0, table)).toBe(13);
      expect(teamLevel(s, 1)).toBe(lv);
      expect(levelValue(s, 1, table)).toBe(10 + lv);
    }
    for (const bad of [-1, 6, 2.5, Number.NaN]) {
      s.teams[1]!.cpu.level = bad as Difficulty;
      expect(teamLevel(s, 1), String(bad)).toBe(PRO);
    }
    expect(teamLevel(s, 7)).toBe(PRO);
    // A short table or a non-finite entry falls back to the Professional entry.
    s.teams[1]!.cpu.level = Difficulty.LEGEND;
    expect(levelValue(s, 1, [1, 2, 3, 4])).toBe(4);
    expect(levelValue(s, 1, [1, 2, 3, 4, 5, Number.NaN])).toBe(4);
  });
});

describe('QF-11 composure noise multiplier', () => {
  it('is 1 at the reference, monotonic (calmer = cleaner), clamped, and 1 for a non-finite attribute', () => {
    expect(composureNoiseMul(T_AI.composureNoiseRef)).toBeCloseTo(1, 12);
    let prev = Infinity;
    for (let c = 1; c <= 99; c++) {
      const m = composureNoiseMul(c);
      expect(m).toBeLessThanOrEqual(prev + 1e-12);
      expect(m).toBeGreaterThanOrEqual(T_AI.composureNoiseMin);
      expect(m).toBeLessThanOrEqual(T_AI.composureNoiseMax);
      prev = m;
    }
    expect(composureNoiseMul(Number.NaN)).toBe(1);
  });

  it('weighs composure by level: none at World Class / Legend, full up to Professional; a bad level is Professional', () => {
    const c = T_AI.composureNoiseRef - 30;
    for (let lv = 0; lv < LEVEL_COUNT; lv++) {
      const w = T_LEVEL.composureNoiseWeight[lv]!;
      expect(composureNoiseMul(c, lv as Difficulty)).toBeCloseTo(
        Math.min(T_AI.composureNoiseMax, Math.max(T_AI.composureNoiseMin, 1 + w * T_AI.composureNoiseSlope)), 12);
    }
    expect(composureNoiseMul(c, 99 as Difficulty)).toBe(composureNoiseMul(c, Difficulty.PROFESSIONAL));
    expect(T_LEVEL.composureNoiseWeight[Difficulty.WORLD_CLASS]).toBe(0);
    expect(T_LEVEL.composureNoiseWeight[Difficulty.LEGEND]).toBe(0);
    expect(T_LEVEL.composureNoiseWeight[Difficulty.PROFESSIONAL]).toBe(1);
  });

  it('never makes a noiseless level noisy (it scales the level noise)', () => {
    for (let lv = 0; lv < LEVEL_COUNT; lv++) {
      const n = levelParams(lv as Difficulty).decisionNoise;
      for (const c of [1, 50, 99]) expect(n * composureNoiseMul(c) >= 0).toBe(true);
    }
  });
});

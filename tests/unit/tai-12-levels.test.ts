/**
 * TAI-12: difficulty levels (levelParams), team styles (styleWeights) and the execution-error helper
 * (applyExecutionError). Levels must be strictly monotonic in every parameter and never touch physics; styles must
 * differ meaningfully, each leading in its signature weight; execution noise must be deterministic, scale with the
 * level's executionError and touch nothing but s.rng.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, TeamStyle } from '../../src/contracts/enums';
import type { LevelParams, StyleWeights } from '../../src/contracts/systems';
import { T_LEVEL } from '../../src/contracts/tuning';
import { createMatchConfig, type RngState, type SimState } from '../../src/contracts/state';
import {
  applyExecutionError, LEVEL_COUNT, levelParams, LOCAL_TUNING, NEUTRAL_STYLE, STYLE_COUNT, styleWeights,
} from '../../src/ai/cpu/levels';
import { rngGauss, rngSeed } from '../../src/sim/core/rng';
import { initMatch } from '../../src/sim/init';

const LEVELS = [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];
const STYLES = [TeamStyle.POSSESSION, TeamStyle.COUNTER, TeamStyle.DIRECT, TeamStyle.HIGH_PRESS, TeamStyle.WING_PLAY];
const LEVEL_KEYS: (keyof LevelParams)[] = ['reactionTicks', 'decisionNoise', 'lookAheadTicks', 'executionError', 'pressIntensity', 'tackleTimingTicks', 'shotThresholdXg'];
const STYLE_KEYS: (keyof StyleWeights)[] = ['safety', 'progress', 'directness', 'width', 'dribble', 'longShot', 'press', 'counter'];

/** +1: the parameter rises from Beginner to Legend (a better CPU), -1: it falls. */
const BETTER_DIRECTION: Record<keyof LevelParams, 1 | -1> = {
  reactionTicks: -1, // reacts sooner
  decisionNoise: -1, // decides more accurately
  lookAheadTicks: 1, // sees further ahead
  executionError: -1, // executes more precisely
  pressIntensity: 1, // presses harder
  tackleTimingTicks: -1, // times tackles sooner after an exposure
  shotThresholdXg: 1, // waits for better chances
};

function state(seed = 1, difficulty = Difficulty.PROFESSIONAL): SimState {
  const c = createMatchConfig();
  c.seed = seed;
  c.difficulty = difficulty;
  c.humans = [c.humans[1]!, c.humans[1]!]; // bot v bot: both CPU brains active
  return initMatch(c);
}

function rngCopy(r: RngState): RngState {
  return { a: r.a, b: r.b, c: r.c, d: r.d };
}

describe('TAI-12 levelParams', () => {
  it('has six levels, each the T_LEVEL column of its Difficulty', () => {
    expect(LEVEL_COUNT).toBe(6);
    for (const lv of LEVELS) {
      const p = levelParams(lv);
      for (const k of LEVEL_KEYS) expect(p[k], `${k} @ ${lv}`).toBe((T_LEVEL[k] as readonly number[])[lv]);
    }
  });

  it('is strictly monotonic in every parameter from Beginner to Legend', () => {
    for (const k of LEVEL_KEYS) {
      for (let i = 1; i < LEVELS.length; i++) {
        const prev = levelParams(LEVELS[i - 1]!)[k];
        const cur = levelParams(LEVELS[i]!)[k];
        const d = (cur - prev) * BETTER_DIRECTION[k];
        expect(d, `${k}: level ${i - 1} -> ${i} (${prev} -> ${cur})`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every parameter finite and in a sane range', () => {
    for (const lv of LEVELS) {
      const p = levelParams(lv);
      for (const k of LEVEL_KEYS) expect(Number.isFinite(p[k]), k).toBe(true);
      expect(p.reactionTicks).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(p.reactionTicks)).toBe(true);
      expect(Number.isInteger(p.lookAheadTicks)).toBe(true);
      expect(Number.isInteger(p.tackleTimingTicks)).toBe(true);
      expect(p.decisionNoise).toBeGreaterThanOrEqual(0);
      expect(p.decisionNoise).toBeLessThanOrEqual(1);
      expect(p.executionError).toBeGreaterThan(0);
      expect(p.pressIntensity).toBeGreaterThan(0);
      expect(p.pressIntensity).toBeLessThanOrEqual(1);
      expect(p.shotThresholdXg).toBeGreaterThan(0);
      expect(p.shotThresholdXg).toBeLessThan(1);
    }
    // Professional is the reference for execution error (scale = sd at Professional).
    expect(levelParams(Difficulty.PROFESSIONAL).executionError).toBe(1);
  });

  it('never differs in physics: LevelParams holds exactly the seven AI parameters', () => {
    for (const lv of LEVELS) expect(Object.keys(levelParams(lv)).sort()).toEqual([...LEVEL_KEYS].sort());
  });

  it('never differs in physics: a match at Beginner and at Legend has identical players, attributes and ball', () => {
    const a = state(7, Difficulty.BEGINNER);
    const b = state(7, Difficulty.LEGEND);
    expect(a.teams[0]!.cpu.level).toBe(Difficulty.BEGINNER);
    expect(b.teams[0]!.cpu.level).toBe(Difficulty.LEGEND);
    expect(JSON.stringify(a.attrs)).toBe(JSON.stringify(b.attrs));
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
    expect(JSON.stringify(a.ball)).toBe(JSON.stringify(b.ball));
    expect(JSON.stringify(a.rng)).toBe(JSON.stringify(b.rng));
  });

  it('returns the same frozen object every call (no per-tick allocation, callers cannot corrupt it)', () => {
    for (const lv of LEVELS) {
      const p = levelParams(lv);
      expect(levelParams(lv)).toBe(p);
      expect(Object.isFrozen(p)).toBe(true);
    }
  });

  it('falls back to Professional for an invalid level', () => {
    const pro = levelParams(Difficulty.PROFESSIONAL);
    for (const bad of [-1, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      expect(levelParams(bad as Difficulty), String(bad)).toBe(pro);
    }
  });
});

describe('TAI-12 styleWeights', () => {
  it('defines all five styles with the eight StyleWeights fields, every weight finite in 0..1', () => {
    expect(STYLE_COUNT).toBe(5);
    expect(LOCAL_TUNING.style).toHaveLength(STYLE_COUNT);
    for (const st of STYLES) {
      const w = styleWeights(st);
      expect(Object.keys(w).sort()).toEqual([...STYLE_KEYS].sort());
      for (const k of STYLE_KEYS) {
        expect(Number.isFinite(w[k]), `${k} @ ${st}`).toBe(true);
        expect(w[k]).toBeGreaterThanOrEqual(0);
        expect(w[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  /** The style's weight `k` is strictly above (dir 1) / below (dir -1) every other style's. */
  function leads(style: TeamStyle, k: keyof StyleWeights, dir: 1 | -1): void {
    const v = styleWeights(style)[k];
    for (const other of STYLES) {
      if (other === style) continue;
      expect((v - styleWeights(other)[k]) * dir, `${TeamStyle[style]}.${k} vs ${TeamStyle[other]}`).toBeGreaterThan(0);
    }
  }

  it('possession: safety highest, directness lowest (and long shots / counter urgency lowest)', () => {
    leads(TeamStyle.POSSESSION, 'safety', 1);
    leads(TeamStyle.POSSESSION, 'directness', -1);
    leads(TeamStyle.POSSESSION, 'longShot', -1);
    leads(TeamStyle.POSSESSION, 'counter', -1);
    expect(styleWeights(TeamStyle.POSSESSION).safety).toBeGreaterThan(styleWeights(TeamStyle.POSSESSION).progress);
  });

  it('counter-attack: counter highest, directness high (above neutral), press lowest (sits off)', () => {
    leads(TeamStyle.COUNTER, 'counter', 1);
    leads(TeamStyle.COUNTER, 'press', -1);
    expect(styleWeights(TeamStyle.COUNTER).directness).toBeGreaterThan(NEUTRAL_STYLE.directness + 0.15);
  });

  it('direct: progress and directness (long balls) highest, long shots highest, dribble lowest', () => {
    leads(TeamStyle.DIRECT, 'progress', 1);
    leads(TeamStyle.DIRECT, 'directness', 1);
    leads(TeamStyle.DIRECT, 'longShot', 1);
    leads(TeamStyle.DIRECT, 'dribble', -1);
  });

  it('high press: press highest', () => {
    leads(TeamStyle.HIGH_PRESS, 'press', 1);
  });

  it('wing play: width (crosses) highest, dribble highest', () => {
    leads(TeamStyle.WING_PLAY, 'width', 1);
    leads(TeamStyle.WING_PLAY, 'dribble', 1);
  });

  it('every pair of styles differs meaningfully (L1 distance >= 1, some weight apart by >= 0.3)', () => {
    for (let i = 0; i < STYLES.length; i++) {
      for (let j = i + 1; j < STYLES.length; j++) {
        const a = styleWeights(STYLES[i]!);
        const b = styleWeights(STYLES[j]!);
        let l1 = 0;
        let maxD = 0;
        for (const k of STYLE_KEYS) {
          const d = Math.abs(a[k] - b[k]);
          l1 += d;
          if (d > maxD) maxD = d;
        }
        const name = `${TeamStyle[STYLES[i]!]} vs ${TeamStyle[STYLES[j]!]}`;
        expect(l1, name).toBeGreaterThanOrEqual(1);
        expect(maxD, name).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it('every style is biased away from neutral (some weight at least 0.3 off 0.5)', () => {
    for (const st of STYLES) {
      const w = styleWeights(st);
      let maxOff = 0;
      for (const k of STYLE_KEYS) maxOff = Math.max(maxOff, Math.abs(w[k] - 0.5));
      expect(maxOff, TeamStyle[st]).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('returns the same frozen object every call; an unknown style gets the neutral weights', () => {
    for (const st of STYLES) {
      expect(styleWeights(st)).toBe(styleWeights(st));
      expect(Object.isFrozen(styleWeights(st))).toBe(true);
    }
    for (const k of STYLE_KEYS) expect(NEUTRAL_STYLE[k]).toBe(0.5);
    for (const bad of [-1, 5, 1.5, Number.NaN]) expect(styleWeights(bad as TeamStyle), String(bad)).toBe(NEUTRAL_STYLE);
  });
});

describe('TAI-12 applyExecutionError', () => {
  it('adds rngGauss x scale x executionError of the team level, consuming exactly one rngGauss', () => {
    const s = state(3);
    s.teams[0]!.cpu.level = Difficulty.BEGINNER;
    s.teams[1]!.cpu.level = Difficulty.LEGEND;
    for (const team of [0, 1]) {
      const ref = rngCopy(s.rng);
      const g = rngGauss(ref);
      const v = applyExecutionError(s, team, 10, 0.5);
      const ex = levelParams(s.teams[team]!.cpu.level).executionError;
      expect(v).toBeCloseTo(10 + g * 0.5 * ex, 12);
      expect(s.rng).toEqual(ref);
    }
  });

  it('is deterministic: the same seed gives the same noisy values', () => {
    const run = (): number[] => {
      const s = state(11);
      s.teams[1]!.cpu.level = Difficulty.AMATEUR;
      const out: number[] = [];
      for (let i = 0; i < 50; i++) out.push(applyExecutionError(s, i & 1, i * 0.1, 0.3));
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('is noisier at lower levels: the empirical sd tracks scale x executionError for every level', () => {
    const s = state(5);
    const scale = 0.4;
    const N = 4000;
    let prevSd = Number.POSITIVE_INFINITY;
    for (const lv of LEVELS) {
      s.teams[0]!.cpu.level = lv;
      let sum = 0;
      let sum2 = 0;
      for (let i = 0; i < N; i++) {
        const d = applyExecutionError(s, 0, 3, scale) - 3;
        sum += d;
        sum2 += d * d;
      }
      const mean = sum / N;
      const sd = Math.sqrt(sum2 / N - mean * mean);
      const want = scale * levelParams(lv).executionError;
      expect(Math.abs(mean), `mean @ ${lv}`).toBeLessThan(0.1 * want);
      expect(sd / want, `sd @ ${lv}`).toBeGreaterThan(0.94);
      expect(sd / want, `sd @ ${lv}`).toBeLessThan(1.06);
      expect(sd).toBeLessThan(prevSd);
      prevSd = sd;
    }
  });

  it('touches nothing but s.rng (the physics stays the same)', () => {
    const s = state(9);
    const { rng: _r0, ...before } = s;
    const snap = JSON.stringify(before);
    for (let i = 0; i < 20; i++) applyExecutionError(s, i & 1, 1, 1);
    const { rng: _r1, ...after } = s;
    expect(JSON.stringify(after)).toBe(snap);
  });

  it('a zero, negative or non-finite scale adds no noise but still consumes the draw', () => {
    const s = state(2);
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ref = rngCopy(s.rng);
      rngGauss(ref);
      expect(applyExecutionError(s, 0, 4.25, scale), String(scale)).toBe(4.25);
      expect(s.rng).toEqual(ref);
    }
  });

  it('never returns a non-finite value (bad value in -> 0 out, draw still consumed)', () => {
    const s = state(2);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ref = rngCopy(s.rng);
      rngGauss(ref);
      expect(applyExecutionError(s, 1, value, 1)).toBe(0);
      expect(s.rng).toEqual(ref);
    }
    const v = applyExecutionError(s, 0, 1e308, 1e308);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('uses Professional for an invalid team index or brain level', () => {
    const s = state(4);
    const sdOf = (team: number, level: number): number => {
      s.teams[0]!.cpu.level = level as Difficulty;
      const r0 = rngCopy(s.rng);
      let sum2 = 0;
      for (let i = 0; i < 2000; i++) {
        const d = applyExecutionError(s, team, 0, 1);
        sum2 += d * d;
      }
      // Replay the same draws for the Professional reference.
      const ref: RngState = r0;
      let ref2 = 0;
      for (let i = 0; i < 2000; i++) {
        const d = rngGauss(ref) * levelParams(Difficulty.PROFESSIONAL).executionError;
        ref2 += d * d;
      }
      return Math.sqrt(sum2 / 2000) / Math.sqrt(ref2 / 2000);
    };
    expect(sdOf(2, Difficulty.BEGINNER)).toBeCloseTo(1, 10);
    expect(sdOf(-1, Difficulty.BEGINNER)).toBeCloseTo(1, 10);
    expect(sdOf(0, 99)).toBeCloseTo(1, 10);
    expect(sdOf(0, Difficulty.BEGINNER)).toBeCloseTo(levelParams(Difficulty.BEGINNER).executionError, 10);
  });

  it('re-seeding the rng reproduces the same noise', () => {
    const s = state(1);
    rngSeed(s.rng, 1234);
    const a = applyExecutionError(s, 0, 0, 1);
    rngSeed(s.rng, 1234);
    expect(applyExecutionError(s, 0, 0, 1)).toBe(a);
  });
});

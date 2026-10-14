/**
 * TAI-12 scenarios: levels and styles through the real consumers and the real tick pipeline.
 *  - Pressing (TAI-05 teamPressIntensity reads levelParams().pressIntensity and styleWeights().press): a CPU team
 *    presses harder at every higher level, and a high-press club harder than a possession club harder than a
 *    counter-attacking club at the same level.
 *  - Per-team levels survive the pipeline: nothing in step() rewrites cpu.level (the ladder relies on it), a
 *    Legend-vs-Beginner bot match runs clean under the core invariants, and the two levels play the same physics.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, MatchPhase, TeamPhase, TeamStyle } from '../../src/contracts/enums';
import { levelParams, styleWeights } from '../../src/ai/cpu/levels';
import { teamPressIntensity } from '../../src/ai/press';
import { makeScenario, runTicks } from '../harness/scenario';

const LEVELS = [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];

function pressFor(level: Difficulty, style: TeamStyle): number {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 21 });
  const t = s.teams[1]!;
  expect(t.cpu.active).toBe(1);
  t.cpu.level = level;
  t.style = style;
  t.phase = TeamPhase.DEFEND;
  return teamPressIntensity(s, 1);
}

describe('TAI-12 levels and styles through the press (TAI-05)', () => {
  it('a CPU team presses harder at every higher level (same style; high press tops out at full intensity)', () => {
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER, TeamStyle.DIRECT, TeamStyle.WING_PLAY, TeamStyle.HIGH_PRESS]) {
      let prev = -1;
      for (const lv of LEVELS) {
        const v = pressFor(lv, style);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeLessThanOrEqual(1);
        // TAI-05 clamps intensity to 1: a high-press club reaches full press at the top levels and stays there.
        if (prev < 1) expect(v, `${TeamStyle[style]} @ ${lv}`).toBeGreaterThan(prev);
        else expect(v, `${TeamStyle[style]} @ ${lv}`).toBe(1);
        if (style !== TeamStyle.HIGH_PRESS) expect(v, `${TeamStyle[style]} @ ${lv} below full press`).toBeLessThan(1);
        prev = v;
      }
    }
  });

  it('high press > possession > counter-attack at the same level', () => {
    for (const lv of [Difficulty.AMATEUR, Difficulty.PROFESSIONAL]) {
      const high = pressFor(lv, TeamStyle.HIGH_PRESS);
      const poss = pressFor(lv, TeamStyle.POSSESSION);
      const counter = pressFor(lv, TeamStyle.COUNTER);
      expect(high, `level ${lv}`).toBeGreaterThan(poss);
      expect(poss, `level ${lv}`).toBeGreaterThan(counter);
      // Meaningfully different: at least 20% apart from the counter side.
      expect(high / counter).toBeGreaterThan(1.2);
    }
    expect(styleWeights(TeamStyle.HIGH_PRESS).press).toBeGreaterThan(styleWeights(TeamStyle.COUNTER).press);
  });
});

describe('TAI-12 per-team levels in the real pipeline', () => {
  it('Legend vs Beginner: levels are never rewritten by step(), core invariants hold, state stays finite', () => {
    const s = makeScenario({ seed: 5 });
    expect(s.teams[0]!.cpu.active).toBe(1);
    expect(s.teams[1]!.cpu.active).toBe(1);
    s.teams[0]!.cpu.level = Difficulty.LEGEND;
    s.teams[1]!.cpu.level = Difficulty.BEGINNER;
    let rewritten = 0;
    runTicks(s, 1500, (_tick, st) => {
      if (st.teams[0]!.cpu.level !== Difficulty.LEGEND || st.teams[1]!.cpu.level !== Difficulty.BEGINNER) rewritten++;
    }, { check: 'core' });
    expect(rewritten).toBe(0);
    expect(s.teams[0]!.cpu.level).toBe(Difficulty.LEGEND);
    expect(s.teams[1]!.cpu.level).toBe(Difficulty.BEGINNER);
    expect(s.match.phase).not.toBe(MatchPhase.PRE_MATCH);
    for (const p of s.players) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.vx) && Number.isFinite(p.vz)).toBe(true);
    }
    expect(Number.isFinite(s.ball.x) && Number.isFinite(s.ball.z)).toBe(true);
  });

  it('levels do not change physics: both sides keep identical attributes and top speeds whatever the levels', () => {
    const s = makeScenario({ seed: 8, config: { awayClub: 0, homeClub: 0 } });
    s.teams[0]!.cpu.level = Difficulty.LEGEND;
    s.teams[1]!.cpu.level = Difficulty.BEGINNER;
    // Same club on both sides: slot i and slot i + 11 are the same player data.
    for (let i = 0; i < 11; i++) expect(s.attrs[i]).toEqual(s.attrs[i + 11]);
    const before = JSON.stringify(s.attrs);
    runTicks(s, 300, undefined, { check: 'core' });
    expect(JSON.stringify(s.attrs)).toBe(before);
    // LevelParams is AI-only: no attribute or speed field for a level to change.
    for (const lv of LEVELS) {
      for (const k of Object.keys(levelParams(lv))) expect(k).not.toMatch(/speed|accel|stamina|strength|attr|mass/i);
    }
  });
});

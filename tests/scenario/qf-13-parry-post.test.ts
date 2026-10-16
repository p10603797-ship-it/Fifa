/**
 * [QF-13] GKP-02 parry round the post: every parry went back into play (angle off the outward axis capped at 1.35 rad),
 * so a hard shot saved at full stretch by the post never gave a corner (0 corners from 0.4 parries a match; corners 0.5
 * a match, 7 of 15 from tips). A ball parried more than T_GK.parryPostBand off the goal centre is now often pushed round
 * the post and behind (chance parryPostChance x nearness to the post x parry quality), turned back only so far that it
 * crosses the goal line parryPostClear outside the post: never into the goal.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT } from '../../src/contracts/constants';
import { SaveKind } from '../../src/contracts/enums';
import { T_GK } from '../../src/contracts/tuning';
import { keeperScenario, lineCrossing, runShot, shoot } from '../unit/gkp-02-helpers';

interface Tally { parries: number; behind: number; inGoal: number; minBehindZ: number }

/** Shots at (tz, ty) from 16 m saved by a 75-rated keeper 2 m off his line; where do the parries go? */
function tally(tzs: number[], seeds: number, speed: number): Tally {
  const t: Tally = { parries: 0, behind: 0, inGoal: 0, minBehindZ: 99 };
  for (let seed = 1; seed <= seeds; seed++) {
    for (const tz of tzs) {
      for (const ty of [0.4, 0.9]) {
        const s = keeperScenario({ gk: 75, u: 2, seed });
        shoot(s, { u: 16, z: 0, tz, ty, speed });
        const r = runShot(s);
        if (r.outcome !== 'save' || r.save?.b !== SaveKind.PARRY) continue;
        t.parries++;
        const b = s.ball;
        const c = { z: 0, y: 0, t: 0 };
        if (lineCrossing(b, c, 240)) {
          if (Math.abs(c.z) < GOAL_HALF_WIDTH && c.y < GOAL_HEIGHT) t.inGoal++;
          else { t.behind++; if (Math.abs(c.z) < t.minBehindZ) t.minBehindZ = Math.abs(c.z); }
        }
      }
    }
  }
  return t;
}

describe('QF-13 GKP-02: parry round the post', () => {
  it('a shot parried by the post is often pushed round it for a corner, never into the goal', () => {
    const t = tally([-3.3, -3.1, -2.9, 2.9, 3.1, 3.3], 8, 24);
    expect(t.parries).toBeGreaterThan(60);
    expect(t.inGoal).toBe(0);
    expect(t.behind).toBeGreaterThan(0); // before: 0 (every parry went back into play)
    expect(t.behind).toBeLessThan(t.parries); // not every one: a chance, by nearness and quality
    // It clears the post by the margin (the post's inside edge + parryPostClear, less a little for the curve of drag).
    expect(t.minBehindZ).toBeGreaterThan(GOAL_HALF_WIDTH + 0.5 * T_GK.parryPostClear);
  });

  it('a parry of a shot at the middle of the goal is unchanged: back into play, away from goal', () => {
    const t = tally([-1.5, 0, 1.5], 6, 32);
    expect(t.parries).toBeGreaterThan(20);
    expect(t.behind).toBe(0);
    expect(t.inGoal).toBe(0);
  });
});

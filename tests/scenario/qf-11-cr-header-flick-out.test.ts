/**
 * [QF-11] CR for src/sim/kicks/aerial.ts (SIM-12, QF-10 area): an AI player's contested header outside the shooting
 * zone (aiChoose: HEADER_PASS, not a clearance) is aimed straight up the pitch (dirX = dir, dirZ = 0) at aiPassPower
 * with no look at teammates or the goal line, so attackers 10-35 m out flick the ball on over the goal line untouched.
 * Measured at Professional (16 bot matches, 4-minute halves): 2.0 such goal kicks per match, the largest single cause
 * of goal kicks (5.25 per match) and more than all corners (0.75 per match) together. Fix suggestion: head a contested
 * ball toward the best-placed teammate ahead (as TAI-09's pass target) or, with none, at a point short of the goal
 * line / back across the box; keep the defensive clearance as it is. Flip to it() when fixed.
 * [QF-13] Landed (aerial.ts solveAerial: back across the box, landing and roll kept inside the lines; regression tests
 * in tests/scenario/qf-13-header-flick.test.ts): flipped to it(). Seed 287, 8 Professional matches: 14 of 33 goal
 * kicks came off such a flick before, 0 of 22 after.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty, KickKind, RestartKind } from '../../src/contracts/enums';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

interface Tally { headerOut: number; goalKicks: number; corners: number; matches: number }

function scan(n: number, seed: number): Tally {
  const out: Tally = { headerOut: 0, goalKicks: 0, corners: 0, matches: n };
  for (let m = 0; m < n; m++) {
    const config = soakConfig(m, seed, { halfMinutes: 2, difficulty: Difficulty.PROFESSIONAL });
    let prevKind = RestartKind.NONE;
    let lastTouch = -1, lastKickBy = -1, lastKickKind = KickKind.NONE as KickKind;
    runMatch({
      config, checker: 'none', fastCutscenes: true,
      onTick: (s) => {
        const rk = s.match.restart.kind;
        if (rk !== prevKind && rk === RestartKind.GOAL_KICK) {
          out.goalKicks++;
          // The last touch was the header itself (nobody touched the ball after it).
          if (lastKickKind === KickKind.HEADER_PASS && lastKickBy === lastTouch) out.headerOut++;
        }
        if (rk !== prevKind && rk === RestartKind.CORNER) out.corners++;
        prevKind = rk;
        const b = s.ball;
        lastTouch = b.lastTouch; lastKickBy = b.lastKickBy; lastKickKind = b.lastKickKind;
      },
    });
  }
  return out;
}

describe('QF-11 CR: contested headers are not flicked on over the goal line', () => {
  const t = scan(6, 0x11f);

  it('the scan saw goal kicks (control)', () => {
    expect(t.goalKicks).toBeGreaterThan(0);
  });

  it('an attacker\'s headed flick-on (HEADER_PASS, untouched after) causes at most 1 goal kick in 6 short matches', () => {
    expect(t.headerOut).toBeLessThanOrEqual(1);
  });
});

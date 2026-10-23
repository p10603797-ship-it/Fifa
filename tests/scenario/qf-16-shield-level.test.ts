/**
 * [QF-16] TAI-11 against a human carrier: no hacking a shielding or strafing carrier, a shielding carrier backing in
 * does not walk the defender back, and the levels still differ (a lower level's defender may be beaten more often).
 *  - Shielding: the rash lunge (decision noise, the "occasional foul") went in at a carrier shielding the ball with his
 *    body between it and the defender, a ball nobody could play: 2-7 fouls and no ball won in 8 scenes of 10 s at every
 *    level from Beginner to World Class. Now no rash lunge at a shielding carrier, nor at a ball his body hides
 *    (ball-first now).
 *  - Backing in: a human holding SHIELD with his back to goal walked every level's defender back about 11 m in 10 s
 *    (SIM-05 gave the shielder the hold in the body contact; qf-16-shield-push), and the patience point moved with him.
 *    Now the defender holds his ground in front of him (T_LEVEL.blockRetreat) and the shielder backing into him is the
 *    one held off.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { mean, runScript } from './qf-16-helpers';

describe('QF-16 TAI-11: shielding and strafing carriers, level differences', () => {
  it('glitch: defender jockeys a dribbler for ever — no hacking a shielding carrier: no fouls at any level', () => {
    const rows: string[] = [];
    let fouls = 0;
    for (let level = Difficulty.BEGINNER; level <= Difficulty.LEGEND; level++) {
      const r = runScript('shieldStrafe', level, 8);
      rows.push(`level ${level}: kept ${r.kept}/8, won ${r.won}, fouls ${r.fouls}`);
      fouls += r.fouls;
    }
    expect(fouls, rows.join('\n')).toBe(0);
  });

  it('a strafing carrier (stick +-50 sideways) is not hacked: fouls in proportion to balls won at the top levels', () => {
    const rows: string[] = [];
    let fouls = 0, won = 0;
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      const r = runScript('strafe', level, 8);
      rows.push(`level ${level}: kept ${r.kept}/8, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
      fouls += r.fouls; won += r.won;
      expect(mean(r.gained), rows.at(-1)).toBeLessThan(1);
    }
    // Before: 18 fouls and 2 balls won over the three levels (rash lunges at a ball behind his body).
    expect(fouls, rows.join('\n')).toBeLessThanOrEqual(won + 3);
  });

  it('glitch: defender jockeys a dribbler for ever — a shielding carrier backing in does not walk a Professional / World Class / Legend defender back', () => {
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      const r = runScript('back', level, 8);
      const row = `level ${level}: kept ${r.kept}/8, gained ${mean(r.gained).toFixed(1)} m, fouls ${r.fouls}`;
      // Before: 10.8 m in 10 s at every level.
      expect(mean(r.gained), row).toBeLessThan(5.5);
      expect(r.fouls, row).toBe(0);
    }
  });

  it('the levels still differ: a Beginner defender is walked past more often and further than a Legend one', () => {
    let kept0 = 0, kept5 = 0, gain0 = 0, gain5 = 0;
    for (const name of ['straight50', 'jog100', 'diag45', 'strafeFwd', 'back']) {
      const b = runScript(name, Difficulty.BEGINNER, 8), l = runScript(name, Difficulty.LEGEND, 8);
      kept0 += b.kept; kept5 += l.kept; gain0 += mean(b.gained); gain5 += mean(l.gained);
    }
    expect(kept0).toBeGreaterThan(kept5);
    expect(gain0).toBeGreaterThan(gain5 * 1.5);
  });
});

/**
 * [QF-16 skeptic] A human shielding (L2) and walking forward into the CPU defender. The third attempt removed the
 * block's hold against a shielding carrier (SIM-05 shieldDriveSpeed holds off a shielder who backs into the man), but
 * the defender never stood there to be backed into: his guard point (T_LEVEL.patienceStandoff goal-side of the carrier)
 * walked him back at the shielder's pace. A shielder walking forward or diagonally kept the ball 7-8 of 8 at
 * Professional / World Class / Legend and gained 8.1-8.4 m in 10 s at all three (the second attempt, with the hold:
 * 3.2-5.5 m), the level differences gone. Now a human shielder is held as the second attempt did (the ground held at the
 * guard point, T_CPU.defendBlockShieldCos0; no challenge: the ball is behind the man); bot shielders unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { mean, runScript } from './qf-16-helpers';

describe('QF-16 skeptic TAI-11: a human cannot shield his way past a top-level CPU defender', () => {
  it('glitch: defender jockeys a dribbler for ever — a shielder walking forward is held, not walked back (no fouls)', () => {
    const rows: string[] = [];
    const byLevel: number[] = [];
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      const gains: number[] = [];
      let fouls = 0;
      for (const name of ['shieldFwd', 'shieldDiag', 'shieldDiagM']) {
        const r = runScript(name, level, 8);
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
        gains.push(mean(r.gained)); fouls += r.fouls;
      }
      const all = rows.slice(-3).join('\n');
      byLevel.push(mean(gains));
      // Before: 8.1-8.4 m at each of the three levels.
      expect(mean(gains), all).toBeLessThan(level === Difficulty.PROFESSIONAL ? 6.5 : 5.5);
      // No hacking a shielding carrier.
      expect(fouls, all).toBe(0);
    }
    // The level differences are back: Legend gives up the least ground.
    expect(byLevel[2]!, rows.join('\n')).toBeLessThan(byLevel[0]!);
  });
});

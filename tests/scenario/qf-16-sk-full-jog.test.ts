/**
 * [QF-16 skeptic] The escort at a full jog. The third attempt blocked a human carrier up to defendBlockJogSpeed
 * (stick (80, 40), 3.9 m/s: 0 of 8 kept from World Class up), but at full stick without sprint (113, +-57; 5.5 m/s for
 * this carrier, top speed 9.16) the blocking defender, jockeying (facing the carrier), was capped at a sprint jockey's
 * 0.55 x top (5.1 m/s) and could not get across: he ran alongside him, then was pushed along in front of him at 4-5 m/s
 * with the ball under his feet (SIM-06's under-the-feet steal stopped at an owner faster than 3 m/s). Kept (or run to
 * the byline) 4-8 of 8 at Professional, 2-4 at World Class, 1-3 at Legend, 17-46 m in 10 s. Now the blocking defender
 * runs instead of jockeying when the jogging human needs more than a sprint jockey's speed (defending.ts), and the
 * under-the-feet steal covers an owner up to a jog (possession.ts underMaxSpeed 6).
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { mean, runScript } from './qf-16-helpers';

describe('QF-16 skeptic TAI-11 / SIM-06: a human cannot jog past a CPU defender at full stick either', () => {
  it('glitch: defender jockeys a dribbler for ever — a full-stick diagonal jog (no sprint) is stopped from Professional up', () => {
    const rows: string[] = [];
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      let notStopped = 0, fouls = 0;
      const gains: number[] = [];
      for (const name of ['diagJogFull', 'diagJogFullM']) {
        const r = runScript(name, level, 8);
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, out ${r.out}, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
        notStopped += r.kept + r.out; fouls += r.fouls; gains.push(mean(r.gained));
      }
      const all = rows.slice(-2).join('\n');
      // Before: kept or out 13 / 8 / 6 of 16 at Professional / World Class / Legend, 17-46 m.
      expect(notStopped, all).toBeLessThanOrEqual(level === Difficulty.PROFESSIONAL ? 2 : 1);
      expect(mean(gains), all).toBeLessThan(level === Difficulty.PROFESSIONAL ? 24 : 16);
      expect(fouls, all).toBeLessThanOrEqual(3);
    }
  });
});

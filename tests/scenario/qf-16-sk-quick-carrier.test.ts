/**
 * [QF-16 skeptic] The jogging escort with other attributes: a quick human carrier (top speed 9.6 m/s, the maximum)
 * against a slow CPU defender (7.2 m/s). Two holes in the third attempt's jog block:
 *  - defendBlockJogSpeed 5.5 m/s sat below a quick player's jog (0.6 x 9.6 = 5.76 m/s): at full stick he was never
 *    blocked (kept or run to the byline 5 of 8 at Legend, 7 of 8 at Professional);
 *  - the blocking defender jockeyed (facing the carrier), capped at a sprint jockey's 0.55 x top (4.0 m/s for this one),
 *    so even the third attempt's own stick (80, 40) jog (3.9 m/s) outran him: kept 5-8 of 8, 25-35 m in 10 s.
 * Now the jog block reaches 6 m/s (above every jog) and the blocking defender runs instead of jockeying when the jogging
 * human needs more than a sprint jockey's speed.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { CARRIER, DEFENDER, mean, runScript } from './qf-16-helpers';

describe('QF-16 skeptic TAI-11: a quick human cannot jog past a slow top-level CPU defender', () => {
  it('glitch: defender jockeys a dribbler for ever — top speed 9.6 v 7.2: diagonal jogs are stopped at World Class / Legend', () => {
    const rows: string[] = [];
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      let notStopped = 0, fouls = 0;
      const gains: number[] = [];
      for (const name of ['diagJog', 'diagJogFull', 'diagJogFullM']) {
        const r = runScript(name, level, 8, 600, 10, 5, (s) => {
          s.attrs[CARRIER]!.topSpeed = 9.6;
          s.attrs[DEFENDER]!.topSpeed = 7.2;
        });
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, out ${r.out}, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
        notStopped += r.kept + r.out; fouls += r.fouls; gains.push(mean(r.gained));
      }
      const all = rows.slice(-3).join('\n');
      // Before: 10 / 14 of 24 not stopped at World Class / Legend, 23-41 m.
      expect(notStopped, all).toBeLessThanOrEqual(1);
      expect(mean(gains), all).toBeLessThan(16);
      expect(fouls, all).toBeLessThanOrEqual(4);
    }
  });
});

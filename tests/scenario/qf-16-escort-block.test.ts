/**
 * [QF-16] TAI-11 escort exploit with a human carrier (docs/TUNING.md QF-14 'Escorts: what remains (open)'). After
 * QF-14 a human walking at a CPU defender was challenged (the held challenge), but one walking diagonally or across him
 * (stick (30, 15)) kept the ball 6-8 of 8 times at Professional / World Class / Legend and gained 11-14 m in 10 s: the
 * controlled defender held the patience point on the carrier -> goal line, the ball went past him beside the carrier's
 * body and body contact pinned him alongside (cosine ~0.3 to the goal side), so neither challenge ever found the ball
 * presented. Now, once the carrier has had the ball T_LEVEL.blockTicks and walks (slower than blockWalkSpeed), the
 * defender blocks: his guard point is in the ball's path (the carrier -> ball line, at most acos(blockPathCos) off the
 * goal direction), reached round the carrier's body, tracked with the carrier's velocity, and in front of the ball or
 * the carrier he holds his ground (giving up only the level's T_LEVEL.blockRetreat share of the carrier's speed toward
 * goal); with the ball presented ball-first at the contact (lungePresented: the wind-up plants him, then he lunges) and
 * the carrier dribbling steadily, he pokes.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { T_LEVEL } from '../../src/contracts/tuning';
import { mean, runScript } from './qf-16-helpers';

const TOP = [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];

describe('QF-16 TAI-11: a human cannot walk past a top-level CPU defender', () => {
  it('reads the tables: earlier and firmer blocks at the higher levels', () => {
    for (let lv = 1; lv < 6; lv++) {
      expect(T_LEVEL.blockTicks[lv]!).toBeLessThanOrEqual(T_LEVEL.blockTicks[lv - 1]!);
      expect(T_LEVEL.blockRetreat[lv]!).toBeLessThanOrEqual(T_LEVEL.blockRetreat[lv - 1]!);
    }
    expect(T_LEVEL.blockRetreat[Difficulty.BEGINNER]).toBe(1);
  });

  it('glitch: defender jockeys a dribbler for ever — a Professional / World Class / Legend defender steps across a carrier walking diagonally or across him', () => {
    const rows: string[] = [];
    let kept = 0, won = 0, fouls = 0;
    for (const level of TOP) {
      for (const name of ['diagP', 'diagM', 'diag45', 'across']) {
        const r = runScript(name, level, 8);
        const g = mean(r.gained);
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, gained ${g.toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
        kept += r.kept; won += r.won; fouls += r.fouls;
        // Before: kept 6-8 of 8 at each of these levels, 11-14 m gained (diag45: 18-19 m).
        expect(g, rows.at(-1)).toBeLessThan(8);
      }
    }
    expect(kept, rows.join('\n')).toBeLessThanOrEqual(3);
    // A fair contest: the challenges meet the ball first; fewer fouls than balls won.
    expect(fouls, rows.join('\n')).toBeLessThan(won);
  });

  it('a carrier walking or jogging straight at him is stopped too (stick 65 / 100)', () => {
    const rows: string[] = [];
    for (const level of TOP) {
      for (const [name, maxGain] of [['straight65', 8], ['jog100', 14]] as const) {
        const r = runScript(name, level, 8);
        const g = mean(r.gained);
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, gained ${g.toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`);
        expect(r.kept, rows.at(-1)).toBeLessThanOrEqual(1);
        expect(g, rows.at(-1)).toBeLessThan(maxGain);
      }
    }
  });

  it('a zig-zag (stick (30, +-50) every 0.75 s) does not walk a World Class / Legend defender back', () => {
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      const r = runScript('strafeFwd', level, 8);
      const row = `level ${level}: kept ${r.kept}/8, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}`;
      expect(r.kept, row).toBeLessThanOrEqual(2);
      expect(mean(r.gained), row).toBeLessThan(7);
    }
  });
});

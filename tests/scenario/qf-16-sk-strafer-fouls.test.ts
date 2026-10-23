/**
 * [QF-16 skeptic] "No hacking a strafing carrier" with the strafe dribble (MOD_L, facing the attacked goal). Two
 * challenges went through a human strafer's body once he was blocked:
 *  - strafing across the defender (3 m/s, the ball on his far side) he is blocked since the jog block, and the careful
 *    tackle on his touches had no ball-first test: 6 / 7 fouls in 8 scenes at World Class / Legend (0-2 on the QF-14 and
 *    second-attempt trees). The careful tackle while blocking a human now wants the ball first from where the lunge
 *    takes him (lungePresented, blockPokeMargin), as the poke does;
 *  - walking diagonally into the defender, the block's poke was pressed with the ball already at the defender's feet
 *    (0.27 m from his centre), which SIM-06's under-the-feet steal was about to give him: a lunge from body contact that
 *    loses its roll is a foul (5 fouls in 8 scenes at Legend). No poke at a human's ball nearer than
 *    T_CPU.defendBlockFeetDist.
 *  - a rash tackle on an exposure (the low levels' decision noise) at a strafer whose ball his body hides: 8-9 fouls in 8
 *    scenes at Semi-Pro, no ball won. A rash tackle at a human carrier now wants the ball not hidden (ballFirstAt).
 * The balls are still won (kept 0-1 of 8 diagonally).
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { runScript } from './qf-16-helpers';

describe('QF-16 skeptic TAI-11: a blocked human strafer is not hacked', () => {
  it('glitch: defender jockeys a dribbler for ever — MOD_L strafing diagonally / across a World Class / Legend defender: balls won, few fouls', () => {
    const rows: string[] = [];
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      const d = runScript('strafeDiag', level, 8);
      const a = runScript('strafeAcross', level, 8);
      rows.push(`level ${level} strafeDiag: kept ${d.kept}/8, won ${d.won}, fouls ${d.fouls}`);
      rows.push(`level ${level} strafeAcross: kept ${a.kept}/8, won ${a.won}, fouls ${a.fouls}`);
      const all = rows.slice(-2).join('\n');
      // Before: 0 + 6 fouls at World Class, 5 + 1 (and 3 + 7 on the third attempt's tree) at Legend.
      expect(d.fouls + a.fouls, all).toBeLessThanOrEqual(3);
      expect(d.fouls, all).toBeLessThanOrEqual(1);
      // The diagonal strafer still loses the ball.
      expect(d.kept, all).toBeLessThanOrEqual(1);
      expect(d.won, all).toBeGreaterThanOrEqual(6);
    }
  });

  it('glitch: defender jockeys a dribbler for ever — a rash Amateur / Semi-Pro defender does not hack a human strafing across him', () => {
    // The rash tackle on an exposure (low levels' decision noise) had no ball-first test: a Semi-Pro defender fouled a
    // human strafing across him (the ball on his far side) 8-9 times in 8 scenes with no ball won (QF-14 tree: 7),
    // Amateur 3. Now a rash tackle at a human carrier wants the ball not hidden behind his body, as the rash lunge does.
    const rows: string[] = [];
    let fouls = 0;
    for (const level of [Difficulty.AMATEUR, Difficulty.SEMI_PRO]) {
      const r = runScript('strafeAcross', level, 8);
      rows.push(`level ${level} strafeAcross: kept ${r.kept}/8, won ${r.won}, fouls ${r.fouls}`);
      fouls += r.fouls;
    }
    expect(fouls, rows.join('\n')).toBeLessThanOrEqual(2);
    // The low levels still win balls from a walker (rash lunges at a presented ball stay).
    const w = runScript('diag45', Difficulty.SEMI_PRO, 8);
    expect(w.won, `diag45: kept ${w.kept}, won ${w.won}, fouls ${w.fouls}`).toBeGreaterThanOrEqual(6);
  });
});

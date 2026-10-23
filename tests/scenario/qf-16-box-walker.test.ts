/**
 * [QF-16 third attempt] A human walking the ball at a CPU defender inside the defender's own penalty area. The top
 * levels' box care (QF-13 boxBodyClear, the poke's boxClear: a lost challenge in body contact there is a penalty) held
 * back every challenge on a walker in body contact, and SIM-05 split the contact by mass, so the walker pushed the
 * defender standing in his path back: from 9.5-16.5 m out he kept the ball 5-8 of 8 times at Professional / World Class
 * / Legend and walked the defender back about 10 m, into the six-yard box, the ball under the defender's feet (0.03-0.3
 * m from his centre). Now SIM-05's brace holds the walker off a man standing his ground (qf-16-brace) and SIM-06 gives
 * the defender a ball under his feet (qf-16-under-feet): no challenge, so no penalty.
 */
import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { mean, runScript } from './qf-16-helpers';

const TOP = [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];
const WALKS = ['straight35', 'straight50', 'diagP', 'diagM', 'diag45', 'shuffle', 'walkStop'];

describe('QF-16 SIM-05 / SIM-06: a human cannot walk a top-level defender back through his own area', () => {
  it('glitch: ball stuck between two players — walking at a Professional / World Class / Legend defender in the box loses the ball, no penalty', () => {
    const rows: string[] = [];
    for (const level of TOP) {
      let kept = 0, pens = 0;
      const gains: number[] = [];
      for (const name of WALKS) {
        // Carrier 9.5-16.5 m from the goal line (bx 44: x = 44 - seed), 3 m from the defender.
        const r = runScript(name, level, 8, 600, 44, 5);
        rows.push(`level ${level} ${name}: kept ${r.kept}/8, gained ${mean(r.gained).toFixed(1)} m, won ${r.won}, fouls ${r.fouls}, pens ${r.pens}`);
        kept += r.kept; pens += r.pens; gains.push(mean(r.gained));
        // Before: kept 5-8 of 8 (straight / diagonal walks), about 10 m gained.
        expect(r.kept, rows.at(-1)).toBeLessThanOrEqual(2);
      }
      const all = rows.slice(-WALKS.length).join('\n');
      expect(kept, all).toBeLessThanOrEqual(3);
      expect(mean(gains), all).toBeLessThan(6);
      expect(pens, all).toBe(0);
    }
  });
});

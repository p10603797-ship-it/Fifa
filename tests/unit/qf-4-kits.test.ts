/**
 * [QF-4] QA-33 kit clashes, exhaustively: every ordered pair of clubs (a club against itself too, the mirror match),
 * both requested kit slots per side, high-contrast kits off and on. Every resolution must pass the GFX-08 clash check
 * (outfield shirts apart, both kits clear of the grass, each keeper clear of both outfield kits and the grass, keepers
 * apart) and give each shirt a readable number.
 */
import { describe, expect, it } from 'vitest';
import { CLUBS } from '../../src/data/clubs';
import { KitPattern } from '../../src/contracts/enums';
import { resolveKits } from '../../src/render/kits';

/** WCAG contrast ratio of two sRGB colours. */
function contrast(a: number, b: number): number {
  const lum = (c: number): number => {
    const ch = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('QF-4 QA-33: kit clashes for every club pair', () => {
  it('every club pair, both kit slots, high contrast off and on: a clean resolution with readable numbers', () => {
    let n = 0;
    const bad: string[] = [];
    let minNumber = Infinity;
    for (let i = 0; i < CLUBS.length; i++) {
      for (let j = 0; j < CLUBS.length; j++) {
        for (const hs of [0, 1]) for (const as of [0, 1]) for (const hc of [false, true]) {
          const r = resolveKits(CLUBS[i]!, CLUBS[j]!, hs, as, hc);
          n++;
          if (!r.report.clean && bad.length < 10) bad.push(`${CLUBS[i]!.name} v ${CLUBS[j]!.name} ${hs}/${as} hc=${hc}: ${JSON.stringify(r.report)}`);
          for (const k of [...r.outfield, ...r.keeper]) {
            const c = k.pattern === KitPattern.PLAIN ? contrast(k.number, k.shirt) : Math.min(contrast(k.number, k.shirt), contrast(k.number, k.shirt2));
            if (c < minNumber) minNumber = c;
          }
        }
      }
    }
    expect(n).toBe(CLUBS.length * CLUBS.length * 8);
    expect(bad, bad.join('\n')).toEqual([]);
    // Numbers: GFX-08 keeps a number colour only when it reads on the shirt (else white / near-black).
    console.log('QF-4 kits', JSON.stringify({ resolutions: n, minNumberContrast: minNumber }));
    expect(minNumber).toBeGreaterThanOrEqual(3);
  });
});

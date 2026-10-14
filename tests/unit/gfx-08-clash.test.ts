/**
 * GFX-08: the automatic kit clash check (BRIEF section 8: "picks kits by colour distance, including against the
 * grass and the other keeper") and high-contrast kits (section 12). Table-driven: same colours clash,
 * complementary colours pass, green kits clash with the grass, pattern-aware shirt mixes, keeper pairs, shorts,
 * fallbacks, hostile data; then every fixture of the real club data resolves clean.
 */
import { describe, expect, it } from 'vitest';
import type { Club, Kit } from '../../src/contracts/data';
import { KitPattern, KitSlot } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { contrastRatio, rgbToLab } from '../../src/render/kit/colour';
import {
  CLASH_THRESHOLD, FALLBACK_KEEPER, FALLBACK_OUTFIELD, GRASS_RGB, GRASS_TONES, colourDistance, grassScore, highContrastOutfield,
  mixDistance, resolveKits, resolveMatchKits, sanitizeKit, sharedShare, shirtDistance, shirtScore, shirtsClash, sleeveColour,
} from '../../src/render/kits';
import { initMatch } from '../../src/sim/init';

const P = KitPattern;
function k(shirt: number, pattern: KitPattern = P.PLAIN, shirt2 = 0xffffff, shorts = 0xffffff, number = 0xffffff): Kit {
  return { shirt, shirt2, pattern, shorts, socks: shirt, number };
}
function club(id: number, home: Kit, away: Kit, keeper: Kit = k(0xe4ff1a, P.PLAIN, 0x141414, 0x141414, 0x111111),
  keeper2: Kit = k(0x22ffee, P.PLAIN, 0x141414, 0x141414, 0x111111)): Club {
  return { ...CLUBS[0]!, id, home, away, keeper, keeper2 };
}

describe('GFX-08 clash check: colour table', () => {
  const RED = 0xd7263d, BLUE = 0x1f4fd1, NAVY = 0x14213d, WHITE = 0xf6f6f2, YELLOW = 0xffd23f, BLACK = 0x141414;
  const table: [string, Kit, Kit, boolean][] = [
    ['same red', k(RED), k(RED), true],
    ['red vs a slightly different red', k(RED), k(0xc8203a), true],
    ['red vs burnt orange', k(RED), k(0xc4501b), true],
    ['navy vs black', k(NAVY), k(BLACK), true],
    ['white vs silver', k(WHITE), k(0xc9ccd1), true],
    ['yellow vs gold', k(YELLOW), k(0xf2a900), true],
    ['royal blue vs purple', k(BLUE), k(0x5b2a86), true],
    ['red vs royal blue (complementary-ish)', k(RED), k(BLUE), false],
    ['navy vs yellow (complementary)', k(NAVY), k(YELLOW), false],
    ['red vs white', k(RED), k(WHITE), false],
    ['black vs white', k(BLACK), k(WHITE), false],
    ['sky blue vs orange (complementary)', k(0x5ec8f2), k(0xff7f11), false],
    ['plain red vs red-and-gold halves (shared half)', k(RED), k(RED, P.HALVES, 0xf2a900), true],
    ['red/white stripes vs white/red stripes', k(RED, P.STRIPES, WHITE), k(WHITE, P.STRIPES, RED), true],
    ['white with red sash vs white with blue sash', k(WHITE, P.SASH, RED), k(WHITE, P.SASH, BLUE), true],
    ['navy/white stripes vs red/yellow hoops', k(NAVY, P.STRIPES, WHITE), k(RED, P.HOOPS, YELLOW), false],
    ['plain navy vs navy/white stripes (shared dominant colour)', k(NAVY), k(NAVY, P.STRIPES, WHITE), true],
  ];
  for (const [name, a, b, clash] of table) {
    it(`${name}: ${clash ? 'clash' : 'clear'}`, () => {
      expect(shirtsClash(a, b)).toBe(clash);
      expect(shirtsClash(b, a)).toBe(clash); // symmetric
    });
  }

  it('a plain kit ignores its shirt2 (trim only) and a pattern mixes both colours', () => {
    expect(shirtDistance(k(RED, P.PLAIN, BLUE), k(RED, P.PLAIN, YELLOW))).toBe(0);
    expect(shirtDistance(k(RED, P.STRIPES, WHITE), k(WHITE, P.STRIPES, RED))).toBeCloseTo(0, 12);
    expect(mixDistance(RED, WHITE, 0.5, WHITE, WHITE, 0)).toBeCloseTo(0.5 * colourDistance(RED, WHITE), 12);
    expect(sharedShare(RED, WHITE, 0.5, WHITE, BLUE, 0.3)).toBeCloseTo(0.5, 12);
    expect(shirtScore(k(RED), k(RED))).toBe(0);
  });

  it('grass: green kits clash with the grass, bold kits do not', () => {
    for (const g of [0x2e7d32, 0x00a651, 0x3cb371, 0x66bb6a, 0x556b2f, 0x1b5e20, GRASS_RGB, ...GRASS_TONES]) {
      expect(grassScore(k(g)), g.toString(16)).toBeLessThan(1);
    }
    for (const c of [RED, BLUE, NAVY, WHITE, YELLOW, BLACK, 0xff5fa2, 0x5ec8f2, 0xe4ff1a, 0x22ffee]) {
      expect(grassScore(k(c)), c.toString(16)).toBeGreaterThanOrEqual(1);
    }
    // Half green: the green half blends in.
    expect(grassScore(k(WHITE, P.HALVES, 0x2e7d32))).toBeLessThan(1);
  });
});

describe('GFX-08 clash check: kit resolution', () => {
  const RED = k(0xd7263d), WHITE = k(0xf6f6f2, P.PLAIN, 0x14213d, 0x14213d, 0x14213d), BLUE = k(0x1f4fd1);

  it('the away side keeps a clear requested kit', () => {
    const r = resolveKits(club(0, RED, WHITE), club(1, k(0xffd23f), BLUE), KitSlot.HOME, KitSlot.AWAY);
    expect(r.slot).toEqual([KitSlot.HOME, KitSlot.AWAY]);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.report.clean).toBe(true);
  });

  it('same colours: the away side switches to its other kit', () => {
    const r = resolveKits(club(0, RED, WHITE), club(1, BLUE, k(0xd7263d)), KitSlot.HOME, KitSlot.AWAY);
    expect(r.slot[1]).toBe(KitSlot.HOME);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.fallback[1]).toBe(false);
    expect(r.report.shirtScore).toBeGreaterThanOrEqual(1);
  });

  it('both club kits clash: a built-in fallback kit, still clear of the home kit and the grass', () => {
    const r = resolveKits(club(0, RED, WHITE), club(1, k(0xd02a40), k(0xc8203a)), KitSlot.HOME, KitSlot.AWAY);
    expect(r.fallback[1]).toBe(true);
    expect(shirtsClash(r.outfield[0], r.outfield[1])).toBe(false);
    expect(grassScore(r.outfield[1])).toBeGreaterThanOrEqual(1);
    expect(r.report.clean).toBe(true);
  });

  it('a green home kit (grass clash) switches to the home side\'s other kit', () => {
    const r = resolveKits(club(0, k(0x2e7d32), RED), club(1, BLUE, WHITE), KitSlot.HOME, KitSlot.AWAY);
    expect(r.slot[0]).toBe(KitSlot.AWAY);
    expect(r.outfield[0].shirt).toBe(0xd7263d);
    expect(r.report.grassScore[0]).toBeGreaterThanOrEqual(1);
    expect(r.report.clean).toBe(true);
  });

  it('a green away kit switches even when it is far from the home shirt', () => {
    const r = resolveKits(club(0, RED, WHITE), club(1, k(0xffd23f), k(0x00a651)), KitSlot.HOME, KitSlot.AWAY);
    expect(r.slot[1]).toBe(KitSlot.HOME);
    expect(r.report.grassScore[1]).toBeGreaterThanOrEqual(1);
  });

  it('mirror match: the same club plays home kit vs away kit', () => {
    const c = CLUBS[3]!;
    const r = resolveKits(c, c, KitSlot.HOME, KitSlot.HOME);
    expect(r.slot).toEqual([KitSlot.HOME, KitSlot.AWAY]);
    expect(r.report.clean).toBe(true);
  });

  it('keeper vs the other keeper: identical keeper kits -> the away keeper changes first', () => {
    const keeper = k(0xe4ff1a, P.PLAIN, 0x141414, 0x141414, 0x111111);
    const r = resolveKits(club(0, RED, WHITE, keeper), club(1, BLUE, WHITE, keeper), KitSlot.HOME, KitSlot.AWAY);
    expect(r.keeperChoice).toEqual([0, 1]);
    expect(r.keeper[0].shirt).toBe(0xe4ff1a);
    expect(r.keeper[1].shirt).toBe(0x22ffee);
    expect(r.report.keeperPairScore).toBeGreaterThanOrEqual(1);
  });

  it('keeper vs both outfield kits: a keeper in the opponents\' colours changes to keeper2', () => {
    const r = resolveKits(club(0, RED, WHITE, k(0x1f4fd1), k(0xff3df2)), club(1, WHITE, BLUE), KitSlot.HOME, KitSlot.AWAY);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.keeperChoice[0]).toBe(1);
    expect(r.keeper[0].shirt).toBe(0xff3df2);
    const own = resolveKits(club(0, RED, WHITE, k(0xd7263d), k(0xe4ff1a)), club(1, BLUE, WHITE), KitSlot.HOME, KitSlot.AWAY);
    expect(own.keeperChoice[0]).toBe(1); // a keeper in his own team's colours changes too
    expect(own.report.clean).toBe(true);
  });

  it('keeper vs the grass: a green keeper kit changes', () => {
    const r = resolveKits(club(0, RED, WHITE, k(0x3cb371)), club(1, BLUE, WHITE), KitSlot.HOME, KitSlot.AWAY);
    expect(r.keeperChoice[0]).toBe(1);
    expect(r.report.keeperScore[0]).toBeGreaterThanOrEqual(1);
  });

  it('both keeper kits unusable: a built-in keeper fallback', () => {
    const r = resolveKits(club(0, RED, WHITE, k(0xd7263d), k(0x1f4fd1)), club(1, WHITE, BLUE), KitSlot.HOME, KitSlot.AWAY);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.keeperChoice[0]).toBeGreaterThanOrEqual(2);
    expect(FALLBACK_KEEPER.some((f) => f.shirt === r.keeper[0].shirt)).toBe(true);
    expect(r.report.clean).toBe(true);
  });

  it('shorts clash: the away side borrows its other kit\'s shorts', () => {
    const home = k(0xd7263d, P.PLAIN, 0xffffff, 0xffffff);
    const away = k(0x1f4fd1, P.PLAIN, 0xffffff, 0xf6f6f2);
    const awayOther = k(0xffd23f, P.PLAIN, 0x14213d, 0x14213d);
    const r = resolveKits(club(0, home, WHITE), club(1, awayOther, away), KitSlot.HOME, KitSlot.AWAY);
    expect(r.shortsSwapped[1]).toBe(true);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.outfield[1].shorts).toBe(0x14213d);
    expect(r.report.shortsDistance).toBeGreaterThanOrEqual(0.15);
  });

  it('no club data: red vs blue built-in kits, keepers distinct', () => {
    const r = resolveKits(null, null, KitSlot.HOME, KitSlot.AWAY);
    expect(r.outfield[0].shirt).toBe(0xd7263d);
    expect(r.outfield[1].shirt).toBe(0x1f4fd1);
    expect(r.fallback).toEqual([true, true]);
    expect(r.report.clean).toBe(true);
  });

  it('hostile data: NaN / out-of-range colours, bad patterns, bad slots, unknown clubs never throw and stay valid', () => {
    const bad = { shirt: NaN, shirt2: -5, pattern: 99 as KitPattern, shorts: 0x1ffffff, socks: Infinity, number: 0.5 } as Kit;
    const s = sanitizeKit(bad);
    for (const v of [s.shirt, s.shirt2, s.shorts, s.socks, s.number]) {
      expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(0xffffff);
    }
    expect(s.pattern).toBe(P.PLAIN);
    const r = resolveKits(club(0, bad, bad, bad, bad), club(1, bad, bad, bad, bad), 9, -1);
    expect(r.requested).toEqual([KitSlot.HOME, KitSlot.AWAY]);
    expect(r.report.clean).toBe(true);
    const st = initMatch(createMatchConfig());
    st.teams[0]!.clubIdx = 999; st.teams[1]!.clubIdx = -4; st.teams[0]!.kit = 9 as KitSlot; st.teams[1]!.kit = -1 as KitSlot;
    const m = resolveMatchKits(st, CLUBS);
    expect(m.report.clean).toBe(true);
  });

  it('numbers stay readable: an unreadable number colour becomes white or near-black', () => {
    const s = sanitizeKit(k(0xffd23f, P.PLAIN, 0xffffff, 0x141414, 0xfff0a0));
    expect(contrastRatio(s.number, s.shirt)).toBeGreaterThanOrEqual(3);
    // Navy / yellow stripes: nothing reaches 3:1 on both colours, so the better of white / near-black on the worse
    // colour wins (the atlas outline in the opposite tone carries the rest).
    const striped = sanitizeKit(k(0x14213d, P.STRIPES, 0xffd23f, 0x141414, 0xff5fa2));
    const worst = (c: number): number => Math.min(contrastRatio(c, 0x14213d), contrastRatio(c, 0xffd23f));
    expect(striped.number).toBe(worst(0xffffff) >= worst(0x111111) ? 0xffffff : 0x111111);
    // A readable kit number is kept as designed.
    expect(sanitizeKit(k(0x14213d, P.STRIPES, 0x5b2a86, 0x141414, 0xf3e9c6)).number).toBe(0xf3e9c6);
  });

  it('sleeves: halves give the left sleeve the second colour', () => {
    const h = k(0xd7263d, P.HALVES, 0xffffff);
    expect(sleeveColour(h, false)).toBe(0xd7263d);
    expect(sleeveColour(h, true)).toBe(0xffffff);
    expect(sleeveColour(k(0xd7263d, P.STRIPES, 0xffffff), true)).toBe(0xd7263d);
  });

  it('resolved kits are copies: the shared club data is never mutated', () => {
    const before = JSON.stringify(CLUBS.map((c) => [c.home, c.away, c.keeper, c.keeper2]));
    const r = resolveKits(CLUBS[0]!, CLUBS[1]!, KitSlot.HOME, KitSlot.AWAY, true);
    r.outfield[0].shirt = 0;
    expect(JSON.stringify(CLUBS.map((c) => [c.home, c.away, c.keeper, c.keeper2]))).toBe(before);
  });

  it('FND-05 compatibility: CLASH_THRESHOLD is the shirt threshold on the 0..1 colourDistance scale', () => {
    expect(CLASH_THRESHOLD).toBeGreaterThan(0.1);
    expect(CLASH_THRESHOLD).toBeLessThan(0.5);
    expect(FALLBACK_OUTFIELD.length).toBeGreaterThanOrEqual(6);
  });
});

describe('GFX-08 high-contrast kits', () => {
  it('plain shirts, L* at least 40 apart, boosted chroma, pure white / near-black numbers', () => {
    const [h, a] = highContrastOutfield(CLUBS[0]!.home, sanitizeKit(CLUBS[8]!.home)); // red vs claret halves
    expect(h.pattern).toBe(KitPattern.PLAIN);
    expect(a.pattern).toBe(KitPattern.PLAIN);
    expect(Math.abs(rgbToLab(h.shirt).L - rgbToLab(a.shirt).L)).toBeGreaterThanOrEqual(39);
    for (const kk of [h, a]) {
      expect(kk.number === 0xffffff || kk.number === 0x0a0a0a).toBe(true);
      expect(contrastRatio(kk.number, kk.shirt)).toBeGreaterThanOrEqual(4.5);
    }
    const lab0 = rgbToLab(CLUBS[0]!.home.shirt), labH = rgbToLab(h.shirt);
    expect(Math.hypot(labH.a, labH.b)).toBeGreaterThanOrEqual(Math.hypot(lab0.a, lab0.b) * 0.95);
  });

  it('high contrast never brings a shirt toward the grass (neutral silver vs yellow)', () => {
    const r = resolveKits(CLUBS[0]!, CLUBS[3]!, KitSlot.AWAY, KitSlot.HOME, true);
    expect(r.highContrast).toBe(true);
    expect(r.report.grassScore[0]).toBeGreaterThanOrEqual(1);
    expect(r.report.clean).toBe(true);
  });

  it('resolveMatchKits passes the high-contrast flag through', () => {
    const s = initMatch(createMatchConfig());
    const n = resolveMatchKits(s, CLUBS), hc = resolveMatchKits(s, CLUBS, true);
    expect(n.highContrast).toBe(false);
    expect(hc.highContrast).toBe(true);
    expect(hc.outfield[0].pattern).toBe(KitPattern.PLAIN);
  });
});

describe('GFX-08 every fixture of the real club data', () => {
  it('all 20 x 20 clubs x 4 kit requests resolve clean with no fallbacks; high contrast clean for the default kits', () => {
    const problems: string[] = [];
    for (const h of CLUBS) for (const a of CLUBS) {
      for (const hs of [KitSlot.HOME, KitSlot.AWAY]) for (const as of [KitSlot.HOME, KitSlot.AWAY]) {
        const r = resolveKits(h, a, hs, as);
        if (!r.report.clean) problems.push(`${h.code}-${a.code} ${hs}${as}`);
        if (r.fallback[0] || r.fallback[1]) problems.push(`${h.code}-${a.code} ${hs}${as} fallback`);
        if (r.slot[0] !== hs) problems.push(`${h.code}-${a.code} ${hs}${as} home changed`);
        if (r.keeperChoice[0] > 1 || r.keeperChoice[1] > 1) problems.push(`${h.code}-${a.code} keeper fallback`);
      }
      const hc = resolveKits(h, a, KitSlot.HOME, KitSlot.AWAY, true);
      if (!hc.report.clean) problems.push(`${h.code}-${a.code} high contrast`);
    }
    expect(problems).toEqual([]);
  });
});

/** DAT-03: kit generator (BRIEF §8 Look, §15, §2): determinism, pattern spread, number contrast >= 4.5:1, home/away
 *  contrast (light vs dark), no grass-green shirts, keeper kits distinct, distinct home kits, real-kit screen, and the
 *  colour helpers (contrastRatio, deltaE, kitContrast...). */
import { describe, expect, it } from 'vitest';
import type { Kit } from '../../src/contracts/data';
import { KitPattern } from '../../src/contracts/enums';
import type { RngState } from '../../src/contracts/state';
import {
  HOME_DESIGNS, KEEPER_EXTRA_PALETTE, KEEPER_PALETTE, KIT_RNG_DRAWS, KIT_RULES, NUMBER_COLOURS, OUTFIELD_PALETTE,
  awayPattern, contrastRatio, deltaE, describeKit, generateKits, iconicKitMatch, isGrassLike, keeperPattern,
  kitContrast, kitLuminanceRatio, kitShirtBlend, kitShirtLuminance, mixRgb, nearestPaletteColour, numberContrast,
  redmeanDistance, relativeLuminance, rgbToHsv, rgbToLab, validateClubKits, validateKit, type ClubKits,
} from '../../src/data/kits';
import { rngFloat, rngNext, rngSeed } from '../../src/sim/core/rng';

const PATTERNS = [KitPattern.PLAIN, KitPattern.STRIPES, KitPattern.HOOPS, KitPattern.HALVES, KitPattern.SASH];
const GRASS = [0x4a9440, 0x4f9a3f, 0x438a35];
const CLUBS = 20;

function rng(seed: number): RngState {
  const r: RngState = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed);
  return r;
}

/** A 20-club league from one RNG stream, the way tools/gen-data.ts calls the generator. */
function league(seed: number): ClubKits[] {
  const r = rng(seed);
  const out: ClubKits[] = [];
  for (let i = 0; i < CLUBS; i++) out.push(generateKits(r, i));
  return out;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const LEAGUES = SEEDS.map(league);
const ALL_CLUBS = LEAGUES.flat();
const KEYS = ['home', 'away', 'keeper', 'keeper2'] as const;
const ALL_KITS: Kit[] = ALL_CLUBS.flatMap((c) => KEYS.map((k) => c[k]));

function kit(shirt: number, shirt2: number, pattern: KitPattern, shorts = shirt, number = 0xffffff): Kit {
  return { shirt, shirt2, pattern, shorts, socks: shirt, number };
}

// ---------------------------------------------------------------- helpers

describe('DAT-03 colour helpers', () => {
  it('relativeLuminance and contrastRatio follow WCAG 2.x', () => {
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 10);
    expect(relativeLuminance(0x000000)).toBe(0);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 6);
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 6);
    expect(contrastRatio(0x777777, 0x777777)).toBe(1);
    // #767676 on white is the classic smallest grey passing AA (4.54:1).
    expect(contrastRatio(0x767676, 0xffffff)).toBeCloseTo(4.54, 2);
  });

  it('rgbToLab and deltaE (CIE76) give reference values', () => {
    const w = rgbToLab(0xffffff);
    expect(w.L).toBeCloseTo(100, 1);
    expect(Math.abs(w.a)).toBeLessThan(0.1);
    expect(Math.abs(w.b)).toBeLessThan(0.1);
    const red = rgbToLab(0xff0000);
    expect(red.L).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 0);
    expect(red.b).toBeCloseTo(67.2, 0);
    expect(deltaE(0x123456, 0x123456)).toBe(0);
    expect(deltaE(0xffffff, 0x000000)).toBeCloseTo(100, 1);
    expect(deltaE(0xd7263d, 0x14213d)).toBeCloseTo(deltaE(0x14213d, 0xd7263d), 12);
  });

  it('kitContrast is 0 for identical kits, symmetric, and blends patterns', () => {
    const red = kit(0xd7263d, 0xffffff, KitPattern.PLAIN);
    const navyStripes = kit(0x14213d, 0x1f4fd1, KitPattern.STRIPES);
    expect(kitContrast(red, red)).toBe(0);
    expect(kitContrast(red, navyStripes)).toBeCloseTo(kitContrast(navyStripes, red), 12);
    expect(kitLuminanceRatio(red, navyStripes)).toBeCloseTo(kitLuminanceRatio(navyStripes, red), 12);
    // A half-and-half pattern sits between its two colours.
    const bw = kit(0x000000, 0xffffff, KitPattern.HALVES);
    const l = kitShirtLuminance(bw);
    expect(l).toBeGreaterThan(0.45);
    expect(l).toBeLessThan(0.55);
    const blend = kitShirtBlend(bw);
    expect(deltaE(blend, 0x000000)).toBeGreaterThan(30);
    expect(deltaE(blend, 0xffffff)).toBeGreaterThan(20);
    // Plain kits are (almost) their shirt colour: the trim only covers collar and cuffs.
    expect(deltaE(kitShirtBlend(red), 0xd7263d)).toBeLessThan(8);
  });

  it('numberContrast checks every shirt colour under the number (both colours of a pattern)', () => {
    expect(numberContrast(kit(0x14213d, 0xffffff, KitPattern.PLAIN))).toBeCloseTo(contrastRatio(0xffffff, 0x14213d), 12);
    const stripes = kit(0x14213d, 0xffd23f, KitPattern.STRIPES, 0x14213d, 0xffffff);
    expect(numberContrast(stripes)).toBeCloseTo(contrastRatio(0xffffff, 0xffd23f), 12);
    expect(numberContrast(stripes)).toBeLessThan(KIT_RULES.numberMinContrast);
  });

  it('mixRgb, rgbToHsv and redmeanDistance basics', () => {
    expect(mixRgb(0x102030, 0xffffff, 0)).toBe(0x102030);
    expect(mixRgb(0x102030, 0xffffff, 1)).toBe(0xffffff);
    expect(mixRgb(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(rgbToHsv(0x00ff00).h).toBe(120);
    expect(rgbToHsv(0xff0000).h).toBe(0);
    expect(rgbToHsv(0x0000ff).h).toBe(240);
    expect(redmeanDistance(0x000000, 0xffffff)).toBeCloseTo(1, 6);
    expect(redmeanDistance(0x4a9440, 0x4a9440)).toBe(0);
  });

  it('isGrassLike flags pitch greens and leaves bold kit colours alone', () => {
    for (const g of [...GRASS, 0x228b22, 0x2e8b57, 0x32cd32, 0x9acd32, 0x006400, 0x3cb371]) expect(isGrassLike(g), g.toString(16)).toBe(true);
    for (const c of [0xd7263d, 0x14213d, 0xffffff, 0xffd23f, 0x5ec8f2, 0x5b2a86, 0xff7f11, 0x141414]) expect(isGrassLike(c), c.toString(16)).toBe(false);
  });

  it('describeKit names colours and pattern', () => {
    expect(describeKit(kit(0x14213d, 0x1f4fd1, KitPattern.STRIPES, 0xf6f6f2))).toBe('navy and royal blue stripes, white shorts');
    expect(describeKit(kit(0xd7263d, 0xffffff, KitPattern.PLAIN, 0x141414))).toBe('red, black shorts');
  });
});

// ---------------------------------------------------------------- palette

describe('DAT-03 palette', () => {
  it('every palette colour is bold enough, not grass-like and carries a readable number colour for its tone', () => {
    for (const c of [...OUTFIELD_PALETTE, ...KEEPER_PALETTE, ...KEEPER_EXTRA_PALETTE]) {
      expect(isGrassLike(c.rgb), c.name).toBe(false);
      const numberOnIt = c.dark ? 0xffffff : 0x111111;
      expect(contrastRatio(numberOnIt, c.rgb), c.name).toBeGreaterThanOrEqual(KIT_RULES.numberMinContrast);
      expect(nearestPaletteColour(c.rgb).name).toBe(c.name);
    }
  });

  it('keeper palette colours stay clear of every outfield colour and of each other', () => {
    for (const k of KEEPER_PALETTE) {
      for (const o of OUTFIELD_PALETTE) expect(deltaE(k.rgb, o.rgb), `${k.name} vs ${o.name}`).toBeGreaterThanOrEqual(KIT_RULES.keeperSafeMinDeltaE);
      for (const k2 of KEEPER_PALETTE) if (k2 !== k) expect(deltaE(k.rgb, k2.rgb)).toBeGreaterThanOrEqual(KIT_RULES.keeperPairMinDeltaE);
    }
  });

  it('home design table: 20 unique (colour, pattern) pairs, each pattern used 4 times', () => {
    expect(HOME_DESIGNS.length).toBe(CLUBS);
    const keys = HOME_DESIGNS.map((d) => `${d.primary.name}/${d.pattern}`);
    expect(new Set(keys).size).toBe(CLUBS);
    for (const p of PATTERNS) expect(HOME_DESIGNS.filter((d) => d.pattern === p).length, `pattern ${p}`).toBe(4);
    expect(new Set(HOME_DESIGNS.map((d) => d.primary.name)).size).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------- determinism

describe('DAT-03 generateKits determinism', () => {
  it('same seed gives identical kits; different seeds differ', () => {
    expect(league(1234)).toEqual(league(1234));
    expect(JSON.stringify(league(1))).not.toBe(JSON.stringify(league(2)));
  });

  it(`consumes exactly KIT_RNG_DRAWS (${KIT_RNG_DRAWS}) draws per call, whatever it picks`, () => {
    for (let i = 0; i < CLUBS; i++) {
      const r = rng(77 + i);
      const ref = { ...r };
      generateKits(r, i);
      for (let k = 0; k < KIT_RNG_DRAWS; k++) rngFloat(ref);
      expect(r).toEqual(ref);
    }
  });

  it('accepts the sim RngState, a float function or a uint32 function with identical results', () => {
    const a = rng(9), b = rng(9), c = rng(9);
    for (let i = 0; i < CLUBS; i++) {
      const k1 = generateKits(a, i);
      expect(generateKits(() => rngFloat(b), i)).toEqual(k1);
      expect(generateKits(() => rngNext(c), i)).toEqual(k1);
    }
  });

  it('rejects an rng that returns values outside [0, 1) and non-uint32s', () => {
    expect(() => generateKits(() => 1.5, 0)).toThrow(/rng returned/);
    expect(() => generateKits(() => -0.1, 0)).toThrow(/rng returned/);
    expect(() => generateKits(() => NaN, 0)).toThrow(/rng returned/);
  });

  it('club indices wrap onto the 20 designs; odd indices are normalised', () => {
    const at = (idx: number): ClubKits => generateKits(rng(5), idx);
    expect(at(20)).toEqual(at(0));
    expect(at(-1)).toEqual(at(19));
    expect(at(3.7)).toEqual(at(3));
    expect(at(NaN)).toEqual(at(0));
    expect(at(Infinity)).toEqual(at(0));
  });

  it('never throws and always validates over many seeds and index orders', () => {
    for (let seed = 1000; seed < 1040; seed++) {
      const r = rng(seed);
      for (let i = CLUBS - 1; i >= 0; i--) expect(validateClubKits(generateKits(r, i)), `seed ${seed} club ${i}`).toEqual([]);
    }
    for (const c of ALL_CLUBS) expect(validateClubKits(c)).toEqual([]);
  });

  it('every colour is a 0xRRGGBB integer and every pattern a KitPattern', () => {
    const bad: string[] = [];
    for (const k of ALL_KITS) {
      for (const v of [k.shirt, k.shirt2, k.shorts, k.socks, k.number]) {
        if (!Number.isInteger(v) || v < 0 || v > 0xffffff) bad.push(`colour ${v}`);
      }
      if (!PATTERNS.includes(k.pattern)) bad.push(`pattern ${k.pattern}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- pattern spread

describe('DAT-03 pattern spread', () => {
  it('home kits use each of the five patterns exactly 4 times in every league', () => {
    for (const l of LEAGUES) for (const p of PATTERNS) expect(l.filter((c) => c.home.pattern === p).length).toBe(4);
  });

  it('away kits: half plain, the rest cover all four patterns (>= 2 each) and avoid the home pattern', () => {
    for (const l of LEAGUES) {
      expect(l.filter((c) => c.away.pattern === KitPattern.PLAIN).length).toBe(10);
      for (const p of PATTERNS.slice(1)) expect(l.filter((c) => c.away.pattern === p).length, `pattern ${p}`).toBeGreaterThanOrEqual(2);
      for (const c of l) if (c.away.pattern !== KitPattern.PLAIN) expect(c.away.pattern).not.toBe(c.home.pattern);
    }
    for (let i = 0; i < CLUBS; i++) for (const p of PATTERNS) {
      const a = awayPattern(i, p);
      expect(PATTERNS).toContain(a);
      if (a !== KitPattern.PLAIN) expect(a).not.toBe(p);
    }
  });

  it('keeper kits: mostly plain with tonal patterns on some clubs; keeper2 is always plain', () => {
    for (const l of LEAGUES) {
      const patterned = l.filter((c) => c.keeper.pattern !== KitPattern.PLAIN);
      expect(patterned.length).toBeGreaterThanOrEqual(4);
      for (const c of l) expect(c.keeper2.pattern).toBe(KitPattern.PLAIN);
      for (let i = 0; i < CLUBS; i++) if (keeperPattern(i) === KitPattern.PLAIN) expect(l[i]!.keeper.pattern).toBe(KitPattern.PLAIN);
    }
  });

  it('all five patterns appear across every league', () => {
    for (const l of LEAGUES) {
      const used = new Set(l.flatMap((c) => KEYS.map((k) => c[k].pattern)));
      for (const p of PATTERNS) expect(used.has(p)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- readability

describe('DAT-03 number contrast', () => {
  it('number colour reaches WCAG >= 4.5:1 on the shirt, and on both colours of a patterned shirt', () => {
    const bad: string[] = [];
    let lowest = 21;
    for (const k of ALL_KITS) {
      const c = numberContrast(k);
      lowest = Math.min(lowest, c);
      if (contrastRatio(k.number, k.shirt) < 4.5) bad.push(`${describeKit(k)}: number on shirt`);
      if (k.pattern !== KitPattern.PLAIN && contrastRatio(k.number, k.shirt2) < 4.5) bad.push(`${describeKit(k)}: number on shirt2`);
      if (!NUMBER_COLOURS.includes(k.number)) bad.push(`number colour ${k.number.toString(16)}`);
    }
    expect(bad).toEqual([]);
    expect(lowest).toBeGreaterThanOrEqual(4.5);
  });

  it('outfield patterns are visible (two colours at least patternMinDeltaE apart)', () => {
    for (const c of ALL_CLUBS) for (const k of [c.home, c.away]) {
      if (k.pattern !== KitPattern.PLAIN) expect(deltaE(k.shirt, k.shirt2)).toBeGreaterThanOrEqual(KIT_RULES.patternMinDeltaE);
    }
  });
});

describe('DAT-03 home/away contrast', () => {
  it('away kit is light when home is dark and dark when home is light, far apart in colour and luminance', () => {
    for (const c of ALL_CLUBS) {
      const lh = kitShirtLuminance(c.home);
      const la = kitShirtLuminance(c.away);
      expect(kitContrast(c.home, c.away)).toBeGreaterThanOrEqual(50);
      expect(kitLuminanceRatio(c.home, c.away)).toBeGreaterThanOrEqual(2.5);
      if (la > lh) expect(la).toBeGreaterThanOrEqual(KIT_RULES.awayLightMinLuminance);
      else expect(la).toBeLessThanOrEqual(KIT_RULES.awayDarkMaxLuminance);
    }
    // The home tone decides the direction: dark home designs get light away kits and vice versa.
    for (const l of LEAGUES) {
      for (let i = 0; i < CLUBS; i++) {
        const lighter = kitShirtLuminance(l[i]!.away) > kitShirtLuminance(l[i]!.home);
        expect(lighter, `club ${i}`).toBe(HOME_DESIGNS[i]!.primary.dark === 1);
      }
    }
  });

  it('GFX-08 clash metric: home and away shirts are far apart (redmean > its 0.2 threshold)', () => {
    for (const c of ALL_CLUBS) expect(redmeanDistance(c.home.shirt, c.away.shirt)).toBeGreaterThan(0.2);
  });

  it('every fixture has an away-side kit that contrasts with the home side (kitContrast >= 25)', () => {
    let worst = Infinity;
    for (const l of LEAGUES) {
      for (let a = 0; a < CLUBS; a++) for (let b = 0; b < CLUBS; b++) {
        if (a === b) continue;
        const best = Math.max(kitContrast(l[a]!.home, l[b]!.home), kitContrast(l[a]!.home, l[b]!.away));
        worst = Math.min(worst, best);
      }
    }
    expect(worst).toBeGreaterThanOrEqual(25);
  });
});

describe('DAT-03 no grass-green shirts', () => {
  // Every kit colour comes from a small palette (+ keeper tones), so check each distinct colour once.
  const shirtColours = [...new Set(ALL_KITS.flatMap((k) => [k.shirt, k.shirt2]))];
  const otherColours = [...new Set(ALL_KITS.flatMap((k) => [k.shorts, k.socks]))];

  it('no shirt, pattern colour, shorts or socks is grass-like', () => {
    expect([...shirtColours, ...otherColours].filter(isGrassLike).map((v) => v.toString(16))).toEqual([]);
  });

  it('every shirt is far from each grass tone (CIE76 >= 45, GFX-08 redmean >= 0.26) and outside the green hue band', () => {
    const bad: string[] = [];
    for (const v of shirtColours) {
      for (const g of GRASS) {
        if (deltaE(v, g) < 45) bad.push(`${v.toString(16)} deltaE`);
        if (redmeanDistance(v, g) < 0.26) bad.push(`${v.toString(16)} redmean`);
      }
      const hsv = rgbToHsv(v);
      if (hsv.h >= 70 && hsv.h <= 170 && hsv.s >= 0.25 && hsv.v >= 0.15) bad.push(`${v.toString(16)} green hue`);
    }
    expect(bad).toEqual([]);
  });
});

describe('DAT-03 keeper kits distinct', () => {
  it('keeper and keeper2 differ from both outfield kits and from each other', () => {
    for (const c of ALL_CLUBS) {
      for (const k of [c.keeper, c.keeper2]) {
        expect(kitContrast(k, c.home)).toBeGreaterThanOrEqual(KIT_RULES.keeperMinDeltaE);
        expect(kitContrast(k, c.away)).toBeGreaterThanOrEqual(KIT_RULES.keeperMinDeltaE);
        const outfield = [c.home.shirt, c.away.shirt];
        if (c.home.pattern !== KitPattern.PLAIN) outfield.push(c.home.shirt2);
        if (c.away.pattern !== KitPattern.PLAIN) outfield.push(c.away.shirt2);
        for (const o of outfield) expect(deltaE(k.shirt, o)).toBeGreaterThanOrEqual(KIT_RULES.keeperColourMinDeltaE);
      }
      expect(kitContrast(c.keeper, c.keeper2)).toBeGreaterThanOrEqual(KIT_RULES.keeperPairMinDeltaE);
    }
  });

  it('keepers wear the bright keeper colours, never an outfield palette colour', () => {
    const keeperRgbs = new Set([...KEEPER_PALETTE, ...KEEPER_EXTRA_PALETTE].map((c) => c.rgb));
    const outfieldRgbs = new Set(OUTFIELD_PALETTE.map((c) => c.rgb));
    let fromMain = 0, total = 0;
    for (const c of ALL_CLUBS) {
      for (const k of [c.keeper, c.keeper2]) {
        total++;
        expect(keeperRgbs.has(k.shirt), k.shirt.toString(16)).toBe(true);
        expect(outfieldRgbs.has(k.shirt)).toBe(false);
        if (KEEPER_PALETTE.some((p) => p.rgb === k.shirt)) fromMain++;
      }
    }
    expect(fromMain / total).toBeGreaterThan(0.95);
  });

  it('every fixture has a keeper pairing clear of both outfield kits and of the other keeper (deltaE >= 30)', () => {
    let worst = Infinity;
    for (const l of LEAGUES) {
      for (let a = 0; a < CLUBS; a++) for (let b = 0; b < CLUBS; b++) {
        if (a === b) continue;
        const A = l[a]!, B = l[b]!;
        const outA = A.home;
        const outB = kitContrast(outA, B.home) >= kitContrast(outA, B.away) ? B.home : B.away;
        let best = 0;
        for (const ka of [A.keeper, A.keeper2]) for (const kb of [B.keeper, B.keeper2]) {
          best = Math.max(best, Math.min(kitContrast(ka, outA), kitContrast(ka, outB), kitContrast(kb, outA), kitContrast(kb, outB), kitContrast(ka, kb)));
        }
        worst = Math.min(worst, best);
      }
    }
    expect(worst).toBeGreaterThanOrEqual(30);
  });
});

describe('DAT-03 distinct, bold home kits', () => {
  it('no two clubs share a home kit, or even a home shirt colour with the same pattern', () => {
    for (const l of LEAGUES) {
      expect(new Set(l.map((c) => JSON.stringify(c.home))).size).toBe(CLUBS);
      expect(new Set(l.map((c) => `${c.home.shirt}/${c.home.pattern}`)).size).toBe(CLUBS);
      expect(new Set(l.map((c) => c.home.shirt)).size).toBeGreaterThanOrEqual(12);
    }
  });

  it('home shirts are bold: saturated colour, or a strong black/navy/white', () => {
    for (const c of ALL_CLUBS) {
      const lab = rgbToLab(c.home.shirt);
      const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
      expect(chroma >= 35 || lab.L <= 30 || lab.L >= 95, c.home.shirt.toString(16)).toBe(true);
    }
  });
});

describe('DAT-03 real-kit screen', () => {
  it('flags famous real-kit looks', () => {
    expect(iconicKitMatch(kit(0xd7263d, 0xf6f6f2, KitPattern.STRIPES))).not.toBeNull();
    expect(iconicKitMatch(kit(0xf6f6f2, 0xd7263d, KitPattern.STRIPES))).not.toBeNull();
    expect(iconicKitMatch(kit(0x141414, 0xf6f6f2, KitPattern.STRIPES))).not.toBeNull();
    expect(iconicKitMatch(kit(0xd7263d, 0x141414, KitPattern.STRIPES))).not.toBeNull();
    expect(iconicKitMatch(kit(0x1f4fd1, 0x141414, KitPattern.STRIPES))).not.toBeNull();
    expect(iconicKitMatch(kit(0xd7263d, 0x141414, KitPattern.HOOPS))).not.toBeNull();
    expect(iconicKitMatch(kit(0xf6f6f2, 0xd7263d, KitPattern.SASH))).not.toBeNull();
    expect(iconicKitMatch(kit(0x1f4fd1, 0xf6f6f2, KitPattern.HALVES))).not.toBeNull();
    expect(iconicKitMatch(kit(0xf6f6f2, 0x000000, KitPattern.PLAIN, 0xffffff))).not.toBeNull();
    expect(iconicKitMatch(kit(0xd7263d, 0x000000, KitPattern.PLAIN, 0xffffff))).not.toBeNull();
    expect(iconicKitMatch(kit(0x5ec8f2, 0x000000, KitPattern.PLAIN, 0xffffff))).not.toBeNull();
    expect(iconicKitMatch(kit(0xffd23f, 0x000000, KitPattern.PLAIN, 0x1f4fd1))).not.toBeNull();
    // Shirt/shorts rules are ordered: a white shirt with red shorts is not "red shirt, white shorts".
    expect(iconicKitMatch(kit(0xf6f6f2, 0x000000, KitPattern.PLAIN, 0xd7263d))).toBeNull();
    expect(iconicKitMatch(kit(0x14213d, 0x1f4fd1, KitPattern.STRIPES))).toBeNull();
    expect(iconicKitMatch(kit(0xff5fa2, 0xf6f6f2, KitPattern.HOOPS))).toBeNull();
  });

  it('the generator never produces a flagged look', () => {
    expect(ALL_KITS.filter((k) => iconicKitMatch(k) !== null).map(describeKit)).toEqual([]);
  });

  it('validateKit reports bad kits', () => {
    expect(validateKit(kit(0x4a9440, 0x4a9440, KitPattern.PLAIN), 'k').join(' ')).toMatch(/grass-like/);
    expect(validateKit(kit(0xffd23f, 0xffffff, KitPattern.PLAIN, 0x141414, 0xffffff), 'k').join(' ')).toMatch(/number contrast/);
    expect(validateKit({ ...kit(0xd7263d, 0x14213d, KitPattern.PLAIN), pattern: 9 as KitPattern }, 'k').join(' ')).toMatch(/KitPattern/);
    expect(validateKit({ ...kit(0xd7263d, 0x14213d, KitPattern.PLAIN), shirt: -1 }, 'k').join(' ')).toMatch(/0xRRGGBB/);
    const c = league(3)[0]!;
    expect(validateClubKits({ ...c, away: c.home }).join(' ')).toMatch(/home\/away/);
    expect(validateClubKits({ ...c, keeper2: c.keeper }).join(' ')).toMatch(/keeper\/keeper2/);
  });
});

/** DAT-01: club generator (BRIEF §15, §2): deterministic generation, committed data up to date, 20 clubs, unique
 *  codes, ratings 62..88, styles and formations spread, crests, denylist screening, and valid squads and kits. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, type Club } from '../../src/contracts/data';
import { FormationId, KitPattern, Role, TeamStyle } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUB_COUNT, CLUBS, CREST_EMBLEMS, CREST_LAYOUTS, CREST_SHAPES, findClubByCode, getClub } from '../../src/data/clubs';
import { getFormation } from '../../src/data/formations';
import { contrastRatio, validateClubKits, type ClubKits } from '../../src/data/kits';
import {
  CLUB_NICKNAMES, CLUB_SUFFIXES, ClubNameTemplate, EMBLEM_WORDS, FAMOUS_NAMES, FAMOUS_NICKNAMES, NATION_CODES,
  OFFENSIVE_CODES, PLACE_TAILS, REAL_CLUB_CODES, REAL_CLUB_NAMES, REAL_CLUB_TOKENS, TEMPLATE_RULES, codeCandidates,
  emblemHint, generateClubNames, isCodeAllowed, nameWords, pickCode, screenClubName,
} from '../../src/data/names';
import { roleGroup, squadRating, validateSquad } from '../../src/data/playerGen';
import { nameKey } from '../../src/data/screen';
import { rngFloat, rngSeed } from '../../src/sim/core/rng';
import { initMatch } from '../../src/sim/init';
import {
  DEFAULT_SEED, FORMATION_FIT, GENERATED_PATH, assignFormations, crestSecondary, emitClubsModule, generateLeague,
  leagueRatings, runGenData, validateLeague,
} from '../../tools/gen-data';

const ROOT = resolve(__dirname, '../..');

function uniform(seed: number): () => number {
  const r = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed);
  return () => rngFloat(r);
}

function deepCopy(clubs: readonly Club[]): Club[] {
  return JSON.parse(JSON.stringify(clubs)) as Club[];
}

const GENERATED = generateLeague(DEFAULT_SEED);

describe('DAT-01 generator: determinism and committed data', () => {
  it('generation is deterministic: two runs give identical clubs and identical module text', () => {
    const again = generateLeague(DEFAULT_SEED);
    expect(JSON.stringify(again)).toBe(JSON.stringify(GENERATED));
    expect(emitClubsModule(again, DEFAULT_SEED)).toBe(emitClubsModule(GENERATED, DEFAULT_SEED));
  });

  it('another seed gives a different, equally valid league (the generator is robust to reseeding)', () => {
    for (const seed of [1, 2, 3, 77, 2026, 0xffffffff]) {
      const league = generateLeague(seed); // throws when validateLeague finds a problem
      expect(validateLeague(league), `seed ${seed}`).toEqual([]);
      expect(league.map((c) => c.name)).not.toEqual(GENERATED.map((c) => c.name));
    }
  });

  it('the committed src/data/clubs.generated.ts is exactly the generator output (stale: run `npm run gen:data`)', () => {
    const committed = readFileSync(GENERATED_PATH, 'utf8');
    expect(committed === emitClubsModule(GENERATED, DEFAULT_SEED), 'clubs.generated.ts is stale: run `npm run gen:data`').toBe(true);
  });

  it('CLUBS (src/data/clubs.ts) decode to exactly the generated league', () => {
    expect(CLUBS).toEqual(GENERATED);
    for (const c of CLUBS) for (const p of c.squad) expect(Object.keys(p).sort()).toEqual(Object.keys(GENERATED[c.id]!.squad[0]!).sort());
  });

  it('npm run gen:data: two CLI runs write identical files; --check passes on the committed file, fails on a stale one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat01-'));
    try {
      const tsx = resolve(ROOT, 'node_modules/.bin/tsx');
      const run = (...args: string[]): { status: number | null; out: string } => {
        const r = spawnSync(tsx, ['tools/gen-data.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      };
      const a = join(dir, 'a.ts');
      const b = join(dir, 'b.ts');
      expect(run('--out', a).status).toBe(0);
      expect(run('--out', b).status).toBe(0);
      const textA = readFileSync(a, 'utf8');
      expect(readFileSync(b, 'utf8')).toBe(textA);
      expect(textA).toBe(readFileSync(GENERATED_PATH, 'utf8'));
      expect(run('--check').status).toBe(0);
      writeFileSync(b, `${textA}// edited by hand\n`);
      const stale = run('--check', '--out', b);
      expect(stale.status).toBe(1);
      expect(stale.out).toMatch(/STALE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('runGenData rejects unknown flags and stray arguments', () => {
    expect(() => runGenData(['--sed', '3'])).toThrow(/unknown flag/);
    expect(() => runGenData(['extra'])).toThrow(/unexpected arguments/);
  });
});

describe('DAT-01 league: the committed clubs', () => {
  it('20 clubs, id = index; getClub falls back to club 0; findClubByCode is case-insensitive', () => {
    expect(CLUBS).toHaveLength(20);
    expect(CLUB_COUNT).toBe(20);
    CLUBS.forEach((c, i) => expect(c.id).toBe(i));
    expect(getClub(7)).toBe(CLUBS[7]);
    expect(getClub(-1)).toBe(CLUBS[0]);
    expect(getClub(20)).toBe(CLUBS[0]);
    expect(getClub(2.5)).toBe(CLUBS[0]);
    expect(getClub(Number.NaN)).toBe(CLUBS[0]);
    expect(findClubByCode(CLUBS[5]!.code.toLowerCase())).toBe(CLUBS[5]);
    expect(findClubByCode('???')).toBeUndefined();
  });

  it('the committed league passes every league rule (validateLeague)', () => {
    expect(validateLeague(CLUBS)).toEqual([]);
  });

  it('unique 3-letter codes, none a real club, national-team or offensive code', () => {
    const codes = CLUBS.map((c) => c.code);
    expect(new Set(codes).size).toBe(20);
    const denied = new Set([...REAL_CLUB_CODES, ...NATION_CODES, ...OFFENSIVE_CODES]);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(denied.has(code), code).toBe(false);
    }
  });

  it('denylist respected: unique invented names and cities; no word is a real club, city, stadium, nickname or famous name', () => {
    expect(new Set(CLUBS.map((c) => nameKey(c.name))).size).toBe(20);
    expect(new Set(CLUBS.map((c) => nameKey(c.city))).size).toBe(20);
    const realFull = new Set([...REAL_CLUB_NAMES, ...FAMOUS_NAMES].map(nameKey));
    const realWords = new Set([...REAL_CLUB_TOKENS, ...FAMOUS_NAMES, ...FAMOUS_NICKNAMES].map(nameKey));
    for (const c of CLUBS) {
      expect(screenClubName(c.name, c.city), c.name).toBeNull();
      expect(realFull.has(nameKey(c.name)), c.name).toBe(false);
      expect(realFull.has(nameKey(c.city)), c.city).toBe(false);
      for (const w of [...nameWords(c.name), ...nameWords(c.city)]) expect(realWords.has(w), `${c.name}: ${w}`).toBe(false);
      expect(c.name.length).toBeLessThanOrEqual(20);
    }
  });

  it('ratings span 62..88: integers, roughly even, a few favourites and underdogs', () => {
    const r = CLUBS.map((c) => c.rating).sort((a, b) => b - a);
    for (const x of r) expect(Number.isInteger(x)).toBe(true);
    expect(r[0]).toBe(88);
    expect(r[19]).toBe(62);
    for (let i = 1; i < 20; i++) expect(r[i - 1]! - r[i]!).toBeLessThanOrEqual(3);
    expect(r.filter((x) => x >= 84).length).toBeGreaterThanOrEqual(3);
    expect(r.filter((x) => x <= 66).length).toBeGreaterThanOrEqual(3);
    for (let band = 0; band < 5; band++) {
      const lo = 62 + band * 5.4;
      const n = r.filter((x) => x >= lo && x < lo + 5.4 + (band === 4 ? 1 : 0)).length;
      expect(n, `band ${band}`).toBeGreaterThanOrEqual(3);
      expect(n, `band ${band}`).toBeLessThanOrEqual(5);
    }
    const perRating = new Map<number, number>();
    for (const x of r) perRating.set(x, (perRating.get(x) ?? 0) + 1);
    for (const k of perRating.values()) expect(k).toBeLessThanOrEqual(2);
  });

  it('styles: each of the five TeamStyles has four clubs, one in every rating tier of five', () => {
    for (let s = 0; s < 5; s++) expect(CLUBS.filter((c) => c.style === s).length, TeamStyle[s]).toBe(4);
    const byRating = [...CLUBS].sort((a, b) => b.rating - a.rating || a.id - b.id);
    for (let t = 0; t < 4; t++) {
      expect(new Set(byRating.slice(5 * t, 5 * t + 5).map((c) => c.style)).size, `tier ${t}`).toBe(5);
    }
  });

  it('preferred formations: all six used three or four times, fitting the style', () => {
    for (let f = 0; f < 6; f++) {
      const n = CLUBS.filter((c) => c.formation === f).length;
      expect(n, FormationId[f]).toBeGreaterThanOrEqual(3);
      expect(n, FormationId[f]).toBeLessThanOrEqual(4);
    }
    const fitSum = CLUBS.reduce((a, c) => a + FORMATION_FIT[c.style]![c.formation]!, 0);
    expect(fitSum / 20).toBeGreaterThanOrEqual(2);
    for (const c of CLUBS) expect(FORMATION_FIT[c.style]![c.formation]!, c.name).toBeGreaterThanOrEqual(1);
    // Variety: no style puts all four of its clubs on one formation.
    for (let s = 0; s < 5; s++) expect(new Set(CLUBS.filter((c) => c.style === s).map((c) => c.formation)).size).toBeGreaterThanOrEqual(2);
  });

  it('crests: valid ids and colours, balanced shapes / emblems / layouts, no two alike, home-shirt primary', () => {
    const pairs = new Set<string>();
    const shapes = new Array<number>(6).fill(0);
    const emblems = new Array<number>(10).fill(0);
    const layouts = new Array<number>(4).fill(0);
    for (const c of CLUBS) {
      const k = c.crest;
      expect(Number.isInteger(k.shape) && k.shape >= 0 && k.shape < CREST_SHAPES.length).toBe(true);
      expect(Number.isInteger(k.emblem) && k.emblem >= 0 && k.emblem < CREST_EMBLEMS.length).toBe(true);
      expect(Number.isInteger(k.layout) && k.layout >= 0 && k.layout < CREST_LAYOUTS.length).toBe(true);
      expect(k.primary).toBe(c.home.shirt);
      expect(contrastRatio(k.primary, k.secondary), c.name).toBeGreaterThanOrEqual(2);
      pairs.add(`${k.shape}/${k.emblem}`);
      shapes[k.shape]!++;
      emblems[k.emblem]!++;
      layouts[k.layout]!++;
    }
    expect(pairs.size).toBe(20);
    for (const n of shapes) expect([3, 4]).toContain(n);
    for (const n of emblems) expect(n).toBe(2);
    for (const n of layouts) expect(n).toBe(5);
  });

  it('kits (DAT-03): every club passes validateClubKits and no two clubs share a home kit', () => {
    for (const c of CLUBS) expect(validateClubKits(c), c.name).toEqual([]);
    expect(new Set(CLUBS.map((c) => JSON.stringify(c.home))).size).toBe(20);
  });

  it('every club valid: 18 players, 2 keepers (starter 0 and bench 11), formation roles covered, bench covers each line', () => {
    for (const c of CLUBS) {
      expect(c.squad, c.name).toHaveLength(18);
      expect(c.squad.filter((p) => p.pos === Role.GK), c.name).toHaveLength(2);
      expect(c.squad[0]!.pos).toBe(Role.GK);
      expect(c.squad[11]!.pos).toBe(Role.GK);
      const slots = getFormation(c.formation).slots;
      for (let i = 0; i < 11; i++) expect(c.squad[i]!.pos, `${c.name} slot ${i}`).toBe(slots[i]!.role);
      const bench = c.squad.slice(12).map((p) => roleGroup(p.pos));
      expect(bench.some((g) => g === 'CB' || g === 'FB' || g === 'WB'), `${c.name} defensive cover`).toBe(true);
      expect(bench.some((g) => g === 'DM' || g === 'CM' || g === 'AM'), `${c.name} midfield cover`).toBe(true);
      expect(bench.some((g) => g === 'ST' || g === 'CF'), `${c.name} striker cover`).toBe(true);
      expect(validateSquad(c.squad, c.formation), c.name).toEqual([]);
    }
  });

  it('squads: starters average the club rating, attributes are integers 1..99, shirts and player names unique', () => {
    const names = new Set<string>();
    for (const c of CLUBS) {
      expect(squadRating(c.squad), c.name).toBe(c.rating);
      expect(new Set(c.squad.map((p) => p.shirt)).size).toBe(18);
      for (const p of c.squad) {
        for (const k of ATTRIBUTE_KEYS) {
          expect(Number.isInteger(p[k]), `${p.name} ${k}`).toBe(true);
          expect(p[k]).toBeGreaterThanOrEqual(1);
          expect(p[k]).toBeLessThanOrEqual(99);
        }
        expect(names.has(nameKey(p.name)), p.name).toBe(false);
        names.add(nameKey(p.name));
      }
    }
    expect(names.size).toBe(360);
  });

  it('the strongest and weakest clubs load into a match with their preferred formations (sim/init.ts)', () => {
    const top = CLUBS.reduce((a, c) => (c.rating > a.rating ? c : a));
    const bottom = CLUBS.reduce((a, c) => (c.rating < a.rating ? c : a));
    const config = createMatchConfig();
    config.homeClub = top.id;
    config.awayClub = bottom.id;
    config.homeFormation = top.formation;
    config.awayFormation = bottom.formation;
    const s = initMatch(config, CLUBS);
    for (let team = 0; team < 2; team++) {
      const club = team === 0 ? top : bottom;
      expect(s.teams[team]!.clubIdx).toBe(club.id);
      expect(s.teams[team]!.style).toBe(club.style);
      for (let i = 0; i < 11; i++) {
        const slot = team * 11 + i;
        expect(s.players[slot]!.role).toBe(club.squad[i]!.pos);
        for (const k of ATTRIBUTE_KEYS) expect(s.attrs[slot]![k]).toBe(club.squad[i]![k]);
      }
    }
  });
});

describe('DAT-01 names: screening', () => {
  const REJECT: [string, string, string][] = [
    ['Arsenal', 'Arsenal', 'full'],
    ['Real Madrid', 'Madrid', 'full'],
    ['West Ham United', 'Saltmere', 'full'],
    ['Port Vale', 'Port Vale', 'full'],
    ['Leeds Rovers', 'Leeds', 'token'],
    ['Saltmere Rovers', 'Leeds', 'token'],
    ['Saltmere Rovers', 'Everton', 'full'],
    ['Anfield Athletic', 'Saltmere', 'token'],
    ['FC Stormgate', 'Stormgate', 'token'],
    ['Evertonmere Town', 'Evertonmere', 'contains'],
    ['Hullmere United', 'Hullmere', 'contains'],
    ['Arsenel Town', 'Arsenel', 'near'],
    ['Saltmere Wolves', 'Saltmere', 'nickname'],
    ['Saltmere Magpie', 'Saltmere', 'nickname'],
    ['Granite City', 'Saltmere', 'full'],
    ['Shitmere Town', 'Shitmere', 'offensive'],
  ];
  for (const [name, city, reason] of REJECT) {
    it(`rejects "${name}" (${city}) as ${reason}`, () => {
      expect(screenClubName(name, city)?.reason).toBe(reason);
    });
  }

  it('allows invented names, including generic suffixes that are also real club names (regression: "Rangers" contains "Angers")', () => {
    expect(screenClubName('Saltmere Rangers', 'Saltmere')).toBeNull();
    expect(screenClubName('Kestrel Athletic', 'Harbour Vale')).toBeNull();
    expect(screenClubName('Harbour Vale', 'Harbour Vale')).toBeNull();
    expect(screenClubName('Saltmere Albion', 'Saltmere')).toBeNull();
  });

  it('the word lists themselves are clean: no famous nickname, every nickname / emblem word / suffix screens clean', () => {
    const famous = new Set(FAMOUS_NICKNAMES.map(nameKey));
    for (const n of CLUB_NICKNAMES) {
      expect(famous.has(nameKey(n)), n).toBe(false);
      expect(screenClubName(`Saltmere ${n}`, 'Saltmere'), n).toBeNull();
    }
    for (const w of EMBLEM_WORDS) expect(screenClubName(`${w} Athletic`, 'Saltmere'), w).toBeNull();
    for (const s of CLUB_SUFFIXES) expect(screenClubName(`Saltmere ${s}`, 'Saltmere'), s).toBeNull();
  });

  it('codes: three capital letters, never a real club, national-team or offensive code', () => {
    for (const c of ['ARS', 'MUN', 'RMA', 'JUV', 'PSG', 'ENG', 'BRA', 'ASS', 'WTF']) expect(isCodeAllowed(c), c).toBe(false);
    for (const c of ['ab', 'ABCD', 'AB1', 'abc', '']) expect(isCodeAllowed(c), c).toBe(false);
    expect(isCodeAllowed('QXZ')).toBe(true);
  });

  it('code candidates: first three letters, then initials, then consonants; pickCode skips denied and used codes', () => {
    expect(codeCandidates(['Saltmere']).slice(0, 4)).toEqual(['SAL', 'SLT', 'SLM', 'SLR']);
    expect(pickCode(['Saltmere'], new Set())).toBe('SLT'); // SAL is denied (a real club code)
    expect(pickCode(['Saltmere'], new Set(['SLT']))).toBe('SLM');
    expect(codeCandidates(['Harbour', 'Vale']).slice(0, 3)).toEqual(['HAR', 'HVL', 'HAV']);
    expect(pickCode(['Harbour', 'Vale'], new Set())).toBe('HVL');
    expect(codeCandidates([])).toEqual([]);
    for (const c of codeCandidates(['Kestrel', 'Athletic'])) expect(c).toMatch(/^[A-Z]{3}$/);
  });
});

describe('DAT-01 names: generation', () => {
  it('generateClubNames is deterministic and gives distinct, screened names and codes over many seeds', () => {
    expect(generateClubNames(uniform(9), 20)).toEqual(generateClubNames(uniform(9), 20));
    const tailWords = new Set(PLACE_TAILS.map((t) => t.word));
    for (let seed = 1; seed <= 40; seed++) {
      const names = generateClubNames(uniform(seed), 20);
      expect(names).toHaveLength(20);
      const keys = new Set<string>();
      const codes = new Set<string>();
      const stems = new Set<string>();
      const tails = new Map<string, number>();
      const suffixes = new Map<string, number>();
      const templates = new Array<number>(TEMPLATE_RULES.length).fill(0);
      for (const n of names) {
        expect(screenClubName(n.name, n.city), `seed ${seed} ${n.name}`).toBeNull();
        expect(keys.has(nameKey(n.name)) || keys.has(nameKey(n.city)), `seed ${seed} ${n.name}`).toBe(false);
        keys.add(nameKey(n.name));
        keys.add(nameKey(n.city));
        expect(isCodeAllowed(n.code)).toBe(true);
        expect(codes.has(n.code)).toBe(false);
        codes.add(n.code);
        for (const s of n.stems) {
          expect(stems.has(s), `seed ${seed} stem ${s}`).toBe(false);
          stems.add(s);
        }
        expect(tailWords.has(n.tail)).toBe(true);
        tails.set(n.tail, (tails.get(n.tail) ?? 0) + 1);
        if (n.suffix !== '') suffixes.set(n.suffix, (suffixes.get(n.suffix) ?? 0) + 1);
        templates[n.template]!++;
        expect(n.name.length).toBeLessThanOrEqual(20);
        expect(n.city.length).toBeLessThanOrEqual(14);
      }
      for (const k of tails.values()) expect(k).toBe(1);
      for (const k of suffixes.values()) expect(k).toBeLessThanOrEqual(2);
      templates.forEach((k, t) => expect(k).toBeLessThanOrEqual(TEMPLATE_RULES[t]!.max));
    }
  });

  it('templates: place + suffix, two-word place, place + nickname, emblem + suffix (own city), FC + place', () => {
    const seen = new Set<ClubNameTemplate>();
    for (let seed = 1; seed <= 10; seed++) {
      for (const n of generateClubNames(uniform(seed), 20)) {
        seen.add(n.template);
        if (n.template === ClubNameTemplate.PLACE_APART || n.template === ClubNameTemplate.PLACE_NICKNAME
          || n.template === ClubNameTemplate.PLACE_SUFFIX || n.template === ClubNameTemplate.FC_PLACE) {
          expect(nameKey(n.name).includes(nameKey(n.city)), n.name).toBe(true);
        } else {
          expect(nameKey(n.name).includes(nameKey(n.city)), n.name).toBe(false);
        }
      }
    }
    expect(seen.size).toBe(5);
  });

  it('emblem hints follow the name (Comet -> star, Bay -> wave), none -> -1', () => {
    expect(CREST_EMBLEMS[emblemHint({ name: 'Comet Athletic', stems: ['comet', 'salt'], tail: 'mere' })]).toBe('star');
    expect(CREST_EMBLEMS[emblemHint({ name: 'Thorn Bay', stems: ['thorn'], tail: 'bay' })]).toBe('wave');
    expect(emblemHint({ name: 'Elderwick FC', stems: ['elder'], tail: 'wick' })).toBe(-1);
    expect(emblemHint({ name: 'Constructor Town', stems: ['constructor', 'tostring'], tail: '' })).toBe(-1);
  });

  it('asking for more clubs than the template limits allow fails loudly instead of looping', () => {
    expect(() => generateClubNames(uniform(1), 22)).toThrow(/maximum count/);
  });
});

describe('DAT-01 generator building blocks', () => {
  it('leagueRatings: 88 first, 62 last, non-increasing, interior strictly inside', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = leagueRatings(uniform(seed));
      expect(r).toHaveLength(20);
      expect(r[0]).toBe(88);
      expect(r[19]).toBe(62);
      for (let i = 1; i < 20; i++) expect(r[i]!).toBeLessThanOrEqual(r[i - 1]!);
      for (let i = 1; i < 19; i++) {
        expect(r[i]!).toBeGreaterThan(62);
        expect(r[i]!).toBeLessThan(88);
      }
    }
  });

  it('assignFormations: balanced quotas, every club at least a fair fit', () => {
    const styles = Array.from({ length: 20 }, (_, i) => (i % 5) as TeamStyle);
    for (let seed = 1; seed <= 10; seed++) {
      const f = assignFormations(uniform(seed), styles);
      for (let k = 0; k < 6; k++) expect([3, 4]).toContain(f.filter((x) => x === k).length);
      for (let i = 0; i < 20; i++) expect(FORMATION_FIT[styles[i]!]![f[i]!]!).toBeGreaterThanOrEqual(1);
    }
  });

  it('crestSecondary: the kit colour that stands out, else white or near-black', () => {
    const kit = (shirt: number, shirt2: number, pattern: KitPattern, number: number) => ({ shirt, shirt2, pattern, shorts: shirt, socks: shirt, number });
    const kits = (home: ReturnType<typeof kit>, awayShirt: number): ClubKits => ({
      home, away: kit(awayShirt, awayShirt, KitPattern.PLAIN, 0x111111), keeper: home, keeper2: home,
    });
    // Patterned home kit with a strong second colour: that colour.
    expect(crestSecondary(kits(kit(0x14213d, 0xffd23f, KitPattern.STRIPES, 0xffffff), 0xf6f6f2))).toBe(0xffd23f);
    // Plain kit: the number colour.
    expect(crestSecondary(kits(kit(0xd7263d, 0xd7263d, KitPattern.PLAIN, 0xffffff), 0xf6f6f2))).toBe(0xffffff);
    // Nothing stands out: black on a light shirt, white on a dark one.
    expect(crestSecondary(kits(kit(0xf6f6f2, 0xf6f6f2, KitPattern.PLAIN, 0xf6f6f2), 0xf6f6f2))).toBe(0x111111);
    expect(crestSecondary(kits(kit(0x14213d, 0x14213d, KitPattern.PLAIN, 0x14213d), 0x14213d))).toBe(0xffffff);
  });

  it('validateLeague catches broken data', () => {
    const errs = (mutate: (c: Club[]) => void): string => {
      const c = deepCopy(CLUBS);
      mutate(c);
      return validateLeague(c).join('\n');
    };
    expect(errs((c) => c.pop())).toMatch(/19 clubs/);
    expect(errs((c) => { c[3]!.code = c[4]!.code; })).toMatch(/duplicate code/);
    expect(errs((c) => { c[3]!.code = 'ARS'; })).toMatch(/code ARS is not allowed/);
    expect(errs((c) => { c[2]!.name = 'Arsenal'; })).toMatch(/screened \(full/);
    expect(errs((c) => { c[2]!.city = c[5]!.city; })).toMatch(/duplicate city/);
    expect(errs((c) => { const top = c.find((x) => x.rating === 88)!; top.rating = 90; })).toMatch(/outside 62\.\.88/);
    expect(errs((c) => { c[1]!.id = 7; })).toMatch(/not its index/);
    expect(errs((c) => { c[6]!.squad[3]!.pos = Role.GK; })).toMatch(/keepers|starter 3/);
    expect(errs((c) => { c[6]!.squad.pop(); })).toMatch(/17 players/);
    expect(errs((c) => { c[8]!.crest = { ...c[9]!.crest }; })).toMatch(/crest shape \+ emblem/);
    expect(errs((c) => { c[8]!.crest.secondary = c[8]!.crest.primary; })).toMatch(/do not contrast/);
    expect(errs((c) => { c[8]!.crest.emblem = 10; })).toMatch(/crest emblem 10/);
    expect(errs((c) => { c[0]!.squad[5]!.name = c[1]!.squad[5]!.name; })).toMatch(/already used in the league/);
    expect(errs((c) => { c[0]!.home.shirt = 0x2e8b3a; })).toMatch(/kits:/);
    expect(errs((c) => { c[0]!.style = 9 as TeamStyle; })).toMatch(/bad style/);
  });
});

/**
 * [DAT-01] Club data generator (BRIEF §15): 20 invented clubs with names, cities, unique 3-letter codes, geometric
 * crests, kits (DAT-03 src/data/kits.ts), a preferred formation, a style, a rating (62..88) and an 18-player squad
 * (DAT-02 src/data/playerGen.ts). Writes src/data/clubs.generated.ts, which is committed, so teams stay the same
 * between builds; src/data/clubs.ts re-exports it as CLUBS.
 *
 *   npm run gen:data                         (re)write src/data/clubs.generated.ts from DEFAULT_SEED
 *   npx tsx tools/gen-data.ts --check        exit 1 when the committed file differs from the generator output
 *   npx tsx tools/gen-data.ts --seed N --out path/file.ts      experiments (the committed data uses DEFAULT_SEED)
 *
 * Deterministic: seeded sfc32 streams (src/sim/core/rng.ts via tools/lib/rand.ts), integer seeding, no clocks, no
 * Math.random, no locale-dependent sorting. Every concern draws from its own stream (names, league layout, each
 * club's kits, each club's squad), so a change in one generator (say DAT-02's draw count) leaves the others' output
 * alone. The output text depends only on the seed and the generator code: two runs write identical bytes.
 *
 * League layout:
 * - Names and codes: src/data/names.ts (screened against real clubs, cities, stadiums, nicknames and codes).
 *   Clubs are listed alphabetically by name; the id is the index.
 * - Ratings: evenly spaced from 88 down to 62 with a little jitter (endpoints exact), shuffled over the clubs.
 * - Styles: clubs are split into rating tiers of five; each tier gets every style once, so each of the five
 *   TeamStyles has four clubs spread from favourite to underdog.
 * - Formations: every formation 3 or 4 times; a hill climb pairs them with the styles that suit them (FIT table).
 * - Crests: shape, emblem and layout from balanced quotas (emblems follow the name where a word suggests one, e.g.
 *   "Comet" -> star), no two clubs share a shape + emblem pair; colours are the home shirt plus a contrasting kit
 *   colour.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ATTRIBUTE_KEYS, type Club, type Crest, type Kit, type PlayerData } from '../src/contracts/data';
import { FormationId, Foot, KitPattern, Role, TeamStyle } from '../src/contracts/enums';
import type { RngState } from '../src/contracts/state';
import { getFormation } from '../src/data/formations';
import { contrastRatio, deltaE, generateKits, isRgb, validateClubKits, type ClubKits } from '../src/data/kits';
import { emblemHint, generateClubNames, isCodeAllowed, screenClubName, type ClubNameParts } from '../src/data/names';
import { nameKey } from '../src/data/screen';
import { generateSquad, squadRating, validateSquad } from '../src/data/playerGen';
import { num, parseArgs, str, bool } from './lib/args';
import { createRng, mix32, rngFloat } from './lib/rand';

const LOCAL_TUNING = { // TUNING-CR (club generation; generation-time only: re-run `npm run gen:data` after a change)
  /** Clubs in the league (BRIEF §15). */
  clubCount: 20,
  /** Overall club rating range (BRIEF §15: 62..88); the best club is exactly ratingMax, the weakest ratingMin. */
  ratingMin: 62,
  ratingMax: 88,
  /** Interior ratings: even spacing plus a uniform jitter of +- this many rating points before rounding. */
  ratingJitter: 0.45,
  /** At most this many clubs share one rating. */
  maxSameRating: 2,
  /** Clubs per style tier (one of each of the five styles per tier of clubs sorted by rating). */
  styleTier: 5,
  /** Formation assignment: fit points lost per extra pair of same-style clubs on the same formation (variety). */
  formationRepeatPenalty: 1,
  /** Crest secondary colour vs primary: minimum WCAG contrast ratio and minimum CIE76 deltaE. */
  crestMinContrast: 2,
  crestMinDeltaE: 35,
} as const;

/** Seed of the committed league. Changing it rewrites every club: only with the lead's approval. */
export const DEFAULT_SEED = 0x0d07c1c5;

/** Sub-stream ids (mixed with the seed): one independent RNG stream per concern. */
const STREAM = { names: 1, league: 2, kits: 0x100, squads: 0x200 } as const;

const STYLE_COUNT = TeamStyle.WING_PLAY + 1;
const FORMATION_COUNT = FormationId.F41212 + 1;
const SHAPE_COUNT = 6;
const EMBLEM_COUNT = 10;
const LAYOUT_COUNT = 4;

/**
 * How well a formation suits a style (0 poor .. 3 ideal), rows TeamStyle, columns FormationId
 * (4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2, 4-1-2-1-2).
 */
export const FORMATION_FIT: readonly (readonly number[])[] = [
  /* POSSESSION */ [1, 3, 2, 1, 0, 3],
  /* COUNTER    */ [3, 1, 2, 1, 3, 0],
  /* DIRECT     */ [3, 1, 0, 3, 2, 1],
  /* HIGH_PRESS */ [1, 3, 3, 2, 0, 2],
  /* WING_PLAY  */ [3, 2, 2, 3, 1, 0],
];

// ---------------------------------------------------------------- helpers

function stream(seed: number, id: number): RngState {
  return createRng(mix32(seed >>> 0, id));
}

function uniform(r: RngState): () => number {
  return () => rngFloat(r);
}

function pickIndex(next: () => number, n: number): number {
  const i = Math.floor(next() * n);
  return i < n ? i : n - 1;
}

/** Fisher-Yates shuffle in place. */
function shuffle<T>(next: () => number, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = pickIndex(next, i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** Sort key of a club name: compact, without a leading "FC" / "AFC" ("FC Ironholm" files under I). */
function sortKey(name: string): string {
  return nameKey(name.replace(/^A?FC\s+/, ''));
}

/** Locale-independent alphabetical order (code-unit compare of the sort keys, then of the raw names). */
function compareNames(a: string, b: string): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `n` items cycling through 0..k-1 (balanced quotas), shuffled. */
function balanced(next: () => number, n: number, k: number): number[] {
  const out: number[] = [];
  const order = shuffle(next, Array.from({ length: k }, (_, i) => i));
  for (let i = 0; i < n; i++) out.push(order[i % k]!);
  return shuffle(next, out);
}

// ---------------------------------------------------------------- ratings, styles, formations

/** League ratings, best first: ratingMax, evenly spaced (jittered) steps, ratingMin. */
export function leagueRatings(next: () => number, n: number = LOCAL_TUNING.clubCount): number[] {
  const T = LOCAL_TUNING;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) { out.push(T.ratingMax); continue; }
    if (i === n - 1) { out.push(T.ratingMin); continue; }
    const even = T.ratingMax - ((T.ratingMax - T.ratingMin) * i) / (n - 1);
    const r = Math.round(even + (next() * 2 - 1) * T.ratingJitter);
    out.push(Math.min(T.ratingMax - 1, Math.max(T.ratingMin + 1, r)));
  }
  return out;
}

/** Styles per club: tiers of `styleTier` clubs by rating (best first), every style once per tier. */
export function assignStyles(next: () => number, ratings: readonly number[]): TeamStyle[] {
  const n = ratings.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => ratings[b]! - ratings[a]! || a - b);
  const styles = new Array<TeamStyle>(n).fill(TeamStyle.POSSESSION);
  for (let t = 0; t < n; t += LOCAL_TUNING.styleTier) {
    const perm = shuffle(next, Array.from({ length: STYLE_COUNT }, (_, i) => i as TeamStyle));
    for (let k = 0; k < LOCAL_TUNING.styleTier && t + k < n; k++) styles[order[t + k]!] = perm[k % STYLE_COUNT]!;
  }
  return styles;
}

function fit(style: TeamStyle, f: FormationId): number {
  return FORMATION_FIT[style]![f]!;
}

/** Assignment score: style fit, minus a penalty per pair of same-style clubs sharing a formation. */
function formationScore(styles: readonly TeamStyle[], f: readonly FormationId[]): number {
  let score = 0;
  for (let i = 0; i < f.length; i++) {
    score += fit(styles[i]!, f[i]!);
    for (let j = 0; j < i; j++) if (styles[j] === styles[i] && f[j] === f[i]) score -= LOCAL_TUNING.formationRepeatPenalty;
  }
  return score;
}

/** Formations per club: balanced quotas (each formation 3 or 4 times in 20), then pairwise swaps that raise
 *  `formationScore` until none does (good fits, and clubs of one style spread over the formations that suit it). */
export function assignFormations(next: () => number, styles: readonly TeamStyle[]): FormationId[] {
  const f = balanced(next, styles.length, FORMATION_COUNT) as FormationId[];
  let best = formationScore(styles, f);
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        if (f[i] === f[j]) continue;
        const t = f[i]!;
        f[i] = f[j]!;
        f[j] = t;
        const s = formationScore(styles, f);
        if (s > best) {
          best = s;
          improved = true;
        } else {
          f[j] = f[i]!;
          f[i] = t;
        }
      }
    }
  }
  return f;
}

// ---------------------------------------------------------------- crests

function pairDuplicates(shapes: readonly number[], emblems: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = 0; j < i; j++) if (shapes[i] === shapes[j] && emblems[i] === emblems[j]) d++;
  }
  return d;
}

/** Secondary crest colour: the first of (patterned home kit's second colour, home number colour, away shirt) that
 *  stands out from the home shirt, else white or near-black, whichever contrasts more. */
export function crestSecondary(kits: ClubKits): number {
  const primary = kits.home.shirt;
  const candidates: number[] = [];
  if (kits.home.pattern !== KitPattern.PLAIN) candidates.push(kits.home.shirt2);
  candidates.push(kits.home.number, kits.away.shirt);
  for (const c of candidates) {
    if (contrastRatio(primary, c) >= LOCAL_TUNING.crestMinContrast && deltaE(primary, c) >= LOCAL_TUNING.crestMinDeltaE) return c;
  }
  return contrastRatio(primary, 0xffffff) >= contrastRatio(primary, 0x111111) ? 0xffffff : 0x111111;
}

/** Crests for the league: balanced shapes/emblems/layouts, name-hinted emblems, unique shape + emblem pairs. */
export function assignCrests(next: () => number, names: readonly ClubNameParts[], kits: readonly ClubKits[]): Crest[] {
  const n = names.length;
  const shapes = balanced(next, n, SHAPE_COUNT);
  const layouts = balanced(next, n, LAYOUT_COUNT);
  // Emblems: quota per emblem, name hints first, the rest from the shuffled remaining pool.
  const left = new Array<number>(EMBLEM_COUNT).fill(0);
  for (let i = 0; i < n; i++) left[i % EMBLEM_COUNT] = left[i % EMBLEM_COUNT]! + 1;
  const emblems = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const h = emblemHint(names[i]!);
    if (h >= 0 && left[h]! > 0) {
      emblems[i] = h;
      left[h] = left[h]! - 1;
    }
  }
  const pool: number[] = [];
  for (let e = 0; e < EMBLEM_COUNT; e++) for (let k = 0; k < left[e]!; k++) pool.push(e);
  shuffle(next, pool);
  for (let i = 0, k = 0; i < n; i++) if (emblems[i] === -1) emblems[i] = pool[k++]!;
  // Repair shared shape + emblem pairs by swapping shapes (emblems keep their name hints).
  for (let guard = 0; pairDuplicates(shapes, emblems) > 0; guard++) {
    if (guard > 10 * n * n) throw new Error('gen-data: could not make crest shape + emblem pairs unique');
    const before = pairDuplicates(shapes, emblems);
    const i = pickIndex(next, n);
    const k = pickIndex(next, n);
    const t = shapes[i]!;
    shapes[i] = shapes[k]!;
    shapes[k] = t;
    if (pairDuplicates(shapes, emblems) >= before) {
      shapes[k] = shapes[i]!;
      shapes[i] = t;
    }
  }
  const out: Crest[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ shape: shapes[i]!, primary: kits[i]!.home.shirt, secondary: crestSecondary(kits[i]!), emblem: emblems[i]!, layout: layouts[i]! });
  }
  return out;
}

// ---------------------------------------------------------------- league

/** The whole league for a seed (deterministic). Throws when the result fails `validateLeague`. */
export function generateLeague(seed: number = DEFAULT_SEED): Club[] {
  const n = LOCAL_TUNING.clubCount;
  const names = generateClubNames(uniform(stream(seed, STREAM.names)), n);
  names.sort((a, b) => compareNames(a.name, b.name));

  const league = uniform(stream(seed, STREAM.league));
  const ratings = shuffle(league, leagueRatings(league, n));
  const styles = assignStyles(league, ratings);
  const formations = assignFormations(league, styles);
  const kits: ClubKits[] = [];
  for (let id = 0; id < n; id++) kits.push(generateKits(stream(seed, STREAM.kits + id), id));
  const crests = assignCrests(league, names, kits);

  const usedNames = new Set<string>();
  const clubs: Club[] = [];
  for (let id = 0; id < n; id++) {
    const nm = names[id]!;
    const k = kits[id]!;
    const squad = generateSquad(stream(seed, STREAM.squads + id), { rating: ratings[id]!, formation: formations[id]!, style: styles[id]! }, { usedNames });
    clubs.push({
      id, name: nm.name, code: nm.code, city: nm.city, rating: ratings[id]!, style: styles[id]!, formation: formations[id]!,
      home: k.home, away: k.away, keeper: k.keeper, keeper2: k.keeper2, crest: crests[id]!, squad,
    });
  }
  const errors = validateLeague(clubs);
  if (errors.length > 0) throw new Error(`gen-data: generated league is invalid (seed ${seed}):\n  ${errors.join('\n  ')}`);
  return clubs;
}

function line(c: Club): string {
  return `${String(c.id).padStart(2)} ${c.code} ${c.rating} ${TeamStyle[c.style]!.padEnd(10)} ${FormationId[c.formation]!.padEnd(6)} ${c.name} (${c.city})`;
}

/** Every rule the committed league must meet (empty = valid). Used by the generator and the tests. */
export function validateLeague(clubs: readonly Club[]): string[] {
  const T = LOCAL_TUNING;
  const errs: string[] = [];
  if (clubs.length !== T.clubCount) errs.push(`${clubs.length} clubs, expected ${T.clubCount}`);
  const names = new Set<string>();
  const cities = new Set<string>();
  const codes = new Set<string>();
  const crestPairs = new Set<string>();
  const players = new Set<string>();
  const ratingCount = new Map<number, number>();
  const styleCount = new Array<number>(STYLE_COUNT).fill(0);
  const formationCount = new Array<number>(FORMATION_COUNT).fill(0);
  for (let i = 0; i < clubs.length; i++) {
    const c = clubs[i]!;
    const who = `club ${i} ${c.name}`;
    if (c.id !== i) errs.push(`${who}: id ${c.id} is not its index`);
    if (names.has(nameKey(c.name))) errs.push(`${who}: duplicate name`);
    names.add(nameKey(c.name));
    if (cities.has(nameKey(c.city))) errs.push(`${who}: duplicate city ${c.city}`);
    cities.add(nameKey(c.city));
    const hit = screenClubName(c.name, c.city);
    if (hit !== null) errs.push(`${who}: screened (${hit.reason}: ${hit.match})`);
    if (!isCodeAllowed(c.code)) errs.push(`${who}: code ${c.code} is not allowed`);
    if (codes.has(c.code)) errs.push(`${who}: duplicate code ${c.code}`);
    codes.add(c.code);
    if (!Number.isInteger(c.rating) || c.rating < T.ratingMin || c.rating > T.ratingMax) errs.push(`${who}: rating ${c.rating} outside ${T.ratingMin}..${T.ratingMax}`);
    ratingCount.set(c.rating, (ratingCount.get(c.rating) ?? 0) + 1);
    if (!Number.isInteger(c.style) || c.style < 0 || c.style >= STYLE_COUNT) errs.push(`${who}: bad style ${c.style}`);
    else styleCount[c.style] = styleCount[c.style]! + 1;
    if (!Number.isInteger(c.formation) || c.formation < 0 || c.formation >= FORMATION_COUNT) {
      errs.push(`${who}: bad formation ${c.formation}`);
      continue;
    }
    formationCount[c.formation] = formationCount[c.formation]! + 1;
    for (const e of validateClubKits(c)) errs.push(`${who}: kits: ${e}`);
    const cr = c.crest;
    if (!Number.isInteger(cr.shape) || cr.shape < 0 || cr.shape >= SHAPE_COUNT) errs.push(`${who}: crest shape ${cr.shape}`);
    if (!Number.isInteger(cr.emblem) || cr.emblem < 0 || cr.emblem >= EMBLEM_COUNT) errs.push(`${who}: crest emblem ${cr.emblem}`);
    if (!Number.isInteger(cr.layout) || cr.layout < 0 || cr.layout >= LAYOUT_COUNT) errs.push(`${who}: crest layout ${cr.layout}`);
    if (!isRgb(cr.primary) || !isRgb(cr.secondary)) errs.push(`${who}: crest colours are not 0xRRGGBB`);
    else if (contrastRatio(cr.primary, cr.secondary) < T.crestMinContrast) errs.push(`${who}: crest colours do not contrast`);
    const pair = `${cr.shape}/${cr.emblem}`;
    if (crestPairs.has(pair)) errs.push(`${who}: crest shape + emblem ${pair} already used`);
    crestPairs.add(pair);
    for (const e of validateSquad(c.squad, c.formation)) errs.push(`${who}: squad: ${e}`);
    const slots = getFormation(c.formation).slots;
    for (let s = 0; s < 11 && s < c.squad.length; s++) {
      if (c.squad[s]!.pos !== slots[s]!.role) errs.push(`${who}: starter ${s} is ${Role[c.squad[s]!.pos]}, formation needs ${Role[slots[s]!.role]}`);
    }
    if (c.squad.length === 18 && squadRating(c.squad) !== c.rating) errs.push(`${who}: starters average ${squadRating(c.squad)}, rating ${c.rating}`);
    for (const p of c.squad) {
      const key = nameKey(p.name);
      if (players.has(key)) errs.push(`${who}: player name ${p.name} already used in the league`);
      players.add(key);
    }
  }
  if (clubs.length > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of clubs) { lo = Math.min(lo, c.rating); hi = Math.max(hi, c.rating); }
    if (lo !== T.ratingMin || hi !== T.ratingMax) errs.push(`ratings span ${lo}..${hi}, expected ${T.ratingMin}..${T.ratingMax}`);
  }
  for (const [r, k] of ratingCount) if (k > T.maxSameRating) errs.push(`${k} clubs share rating ${r}`);
  for (let s = 0; s < STYLE_COUNT; s++) if (styleCount[s]! < Math.floor(clubs.length / STYLE_COUNT)) errs.push(`style ${TeamStyle[s]} used ${styleCount[s]} times`);
  for (let f = 0; f < FORMATION_COUNT; f++) if (formationCount[f]! < Math.floor(clubs.length / FORMATION_COUNT)) errs.push(`formation ${FormationId[f]} used ${formationCount[f]} times`);
  return errs;
}

// ---------------------------------------------------------------- module text

/** Player numbers in row order (after name, short, pos, foot). */
export const PLAYER_ROW_FIELDS = ['shirt', 'height', 'weakFoot', 'skillMoves', 'overall', ...ATTRIBUTE_KEYS] as const;

function hex(c: number): string {
  return `0x${(c >>> 0).toString(16).padStart(6, '0')}`;
}

function kitText(k: Kit): string {
  return `{ shirt: ${hex(k.shirt)}, shirt2: ${hex(k.shirt2)}, pattern: KitPattern.${KitPattern[k.pattern]}, shorts: ${hex(k.shorts)}, socks: ${hex(k.socks)}, number: ${hex(k.number)} }`;
}

function playerText(p: PlayerData): string {
  const nums = PLAYER_ROW_FIELDS.map((f) => {
    const v = p[f];
    if (!Number.isInteger(v)) throw new Error(`gen-data: ${p.name}.${f} = ${v} is not an integer`);
    return String(v);
  });
  return `p(${JSON.stringify(p.name)}, ${JSON.stringify(p.short)}, Role.${Role[p.pos]}, Foot.${Foot[p.foot]}, [${nums.join(', ')}])`;
}

function enumName(e: Record<number, string>, v: number, label: string): string {
  const s = e[v];
  if (s === undefined) throw new Error(`gen-data: ${label} ${v} has no enum name`);
  return s;
}

/** The text of src/data/clubs.generated.ts for a league (pure function of the clubs and the seed). */
export function emitClubsModule(clubs: readonly Club[], seed: number = DEFAULT_SEED): string {
  const out: string[] = [];
  const numsType = PLAYER_ROW_FIELDS.map(() => 'number').join(', ');
  out.push(
    '/**',
    ` * GENERATED by tools/gen-data.ts (DAT-01) from seed 0x${(seed >>> 0).toString(16).padStart(8, '0')}. Do not edit by hand: run \`npm run gen:data\`.`,
    ` * ${clubs.length} invented clubs (BRIEF §15). Names, cities and codes: src/data/names.ts (screened against real clubs);`,
    ' * kits: src/data/kits.ts (DAT-03); squads: src/data/playerGen.ts (DAT-02). Read through src/data/clubs.ts.',
    ' * Player rows: p(name, short, position, foot, [shirt, height cm, weak foot, skill moves, overall, then the 25',
    ' * attributes in contracts/data.ts ATTRIBUTE_KEYS order]).',
    ' */',
    "import type { Club, PlayerData } from '../contracts/data';",
    "import { FormationId, Foot, KitPattern, Role, TeamStyle } from '../contracts/enums';",
    '',
    "type RowField = Exclude<keyof PlayerData, 'name' | 'short' | 'pos' | 'foot'>;",
    '',
    '/** Order of the numbers in a player row. */',
    `const FIELDS: readonly RowField[] = [${PLAYER_ROW_FIELDS.map((f) => `'${f}'`).join(', ')}];`,
    '',
    `type Row = readonly [${numsType}];`,
    '',
    'function p(name: string, short: string, pos: Role, foot: Foot, v: Row): PlayerData {',
    "  const o: Record<string, string | number> = { name, short, shirt: v[0], pos, height: v[1], foot, weakFoot: v[2], skillMoves: v[3], overall: v[4] };",
    '  for (let i = 5; i < FIELDS.length; i++) o[FIELDS[i]!] = v[i]!;',
    '  return o as unknown as PlayerData;',
    '}',
    '',
    '/** Every club, index = id. */',
    'export const CLUBS_DATA: readonly Club[] = [',
  );
  for (const c of clubs) {
    const cr = c.crest;
    out.push(
      '  {',
      `    id: ${c.id}, name: ${JSON.stringify(c.name)}, code: ${JSON.stringify(c.code)}, city: ${JSON.stringify(c.city)}, rating: ${c.rating},`,
      `    style: TeamStyle.${enumName(TeamStyle, c.style, 'style')}, formation: FormationId.${enumName(FormationId, c.formation, 'formation')},`,
      `    home: ${kitText(c.home)},`,
      `    away: ${kitText(c.away)},`,
      `    keeper: ${kitText(c.keeper)},`,
      `    keeper2: ${kitText(c.keeper2)},`,
      `    crest: { shape: ${cr.shape}, primary: ${hex(cr.primary)}, secondary: ${hex(cr.secondary)}, emblem: ${cr.emblem}, layout: ${cr.layout} },`,
      '    squad: [',
    );
    for (const p of c.squad) out.push(`      ${playerText(p)},`);
    out.push('    ],', '  },');
  }
  out.push('];', '');
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the committed league lives. */
export const GENERATED_PATH = resolve(ROOT, 'src/data/clubs.generated.ts');

export interface GenDataResult {
  exitCode: number;
  lines: string[];
}

/** Run the tool with CLI arguments (exposed for tests). */
export function runGenData(argv: readonly string[]): GenDataResult {
  const { flags, positionals } = parseArgs(argv, { seed: 'number', out: 'string', check: 'boolean' });
  if (positionals.length > 0) throw new Error(`unexpected arguments: ${positionals.join(' ')}`);
  const seed = num(flags, 'seed', DEFAULT_SEED) >>> 0;
  const out = resolve(ROOT, str(flags, 'out', GENERATED_PATH));
  const clubs = generateLeague(seed);
  const text = emitClubsModule(clubs, seed);
  const lines = clubs.map(line);
  if (bool(flags, 'check')) {
    let current: string | null;
    try {
      current = readFileSync(out, 'utf8');
    } catch {
      current = null;
    }
    if (current === text) return { exitCode: 0, lines: [...lines, `OK: ${out} is up to date`] };
    const why = current === null ? 'is missing' : 'differs from the generator output';
    return { exitCode: 1, lines: [`STALE: ${out} ${why}; run \`npm run gen:data\``] };
  }
  writeFileSync(out, text);
  return { exitCode: 0, lines: [...lines, `wrote ${out} (${clubs.length} clubs, ${text.length} bytes)`] };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const r = runGenData(process.argv.slice(2));
    for (const l of r.lines) console.log(l);
    process.exit(r.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

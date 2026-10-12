/** DAT-02: squad generator (BRIEF §15): structure, determinism, attribute ranges and profiles, overall formula,
 *  rating scaling, feet, weak foot / skill moves, heights, shirt numbers and screened, unique names. */
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, type AttributeKey, type PlayerData } from '../../src/contracts/data';
import { FormationId, Foot, Role, TeamStyle } from '../../src/contracts/enums';
import type { RngState } from '../../src/contracts/state';
import { getFormation } from '../../src/data/formations';
import {
  OVERALL_WEIGHTS, assignShirtNumbers, benchRoles, computeOverall, displayName, generateSquad, rawName, roleGroup,
  seamOk, squadRating, validateSquad, type NameSource, type RoleGroup, type SquadParams,
} from '../../src/data/playerGen';
import { nameKey, screenName } from '../../src/data/screen';
import { rngFloat, rngNext, rngSeed } from '../../src/sim/core/rng';

const FORMATIONS = [FormationId.F442, FormationId.F433, FormationId.F4231, FormationId.F352, FormationId.F532, FormationId.F41212];
const STYLES = [TeamStyle.POSSESSION, TeamStyle.COUNTER, TeamStyle.DIRECT, TeamStyle.HIGH_PRESS, TeamStyle.WING_PLAY];
const OUTFIELD_KEYS = ATTRIBUTE_KEYS.slice(0, 20);
const GK_KEYS = ATTRIBUTE_KEYS.slice(20);

function rng(seed: number): RngState {
  const r: RngState = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed);
  return r;
}

/** A league-like sample: n squads over every formation, style and rating 62..88. */
function sample(n: number, seed = 1): { params: SquadParams; squad: PlayerData[] }[] {
  const r = rng(seed);
  const out: { params: SquadParams; squad: PlayerData[] }[] = [];
  for (let i = 0; i < n; i++) {
    const params: SquadParams = { rating: 62 + (i * 7) % 27, formation: FORMATIONS[i % 6]!, style: STYLES[i % 5]! };
    out.push({ params, squad: generateSquad(r, params) });
  }
  return out;
}

const SAMPLE = sample(150);
const ALL = SAMPLE.flatMap((s) => s.squad);

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Mean of an attribute over every generated player of a role group. */
function groupMean(g: RoleGroup, k: AttributeKey | 'height' | 'weakFoot' | 'skillMoves'): number {
  return mean(ALL.filter((p) => roleGroup(p.pos) === g).map((p) => p[k]));
}

describe('DAT-02 generator: squad structure', () => {
  it('18 players: starters in formation slot order (0 = GK), reserve keeper at 11, cover on the bench', () => {
    for (const f of FORMATIONS) {
      const squad = generateSquad(rng(10 + f), { rating: 75, formation: f, style: TeamStyle.POSSESSION });
      expect(squad).toHaveLength(18);
      const slots = getFormation(f).slots;
      for (let i = 0; i < 11; i++) expect(squad[i]!.pos, `formation ${f} slot ${i}`).toBe(slots[i]!.role);
      expect(squad[0]!.pos).toBe(Role.GK);
      expect(squad[11]!.pos).toBe(Role.GK);
      expect(squad.filter((p) => p.pos === Role.GK)).toHaveLength(2);
      const bench = squad.slice(11).map((p) => roleGroup(p.pos));
      expect(bench.some((g) => g === 'CB' || g === 'FB' || g === 'WB')).toBe(true);
      expect(bench.some((g) => g === 'DM' || g === 'CM' || g === 'AM')).toBe(true);
      expect(bench.some((g) => g === 'ST' || g === 'CF' || g === 'W')).toBe(true);
      expect(validateSquad(squad, f)).toEqual([]);
    }
  });

  it('bench roles follow the formation (wing-backs for back-three/five, CDM/CAM when used, side by flag)', () => {
    expect(benchRoles(FormationId.F442, true)).toEqual([Role.GK, Role.CB, Role.RB, Role.CM, Role.CM, Role.RM, Role.ST]);
    expect(benchRoles(FormationId.F433, false)).toEqual([Role.GK, Role.CB, Role.LB, Role.CDM, Role.CM, Role.LW, Role.ST]);
    expect(benchRoles(FormationId.F4231, true)).toEqual([Role.GK, Role.CB, Role.RB, Role.CDM, Role.CAM, Role.RM, Role.ST]);
    expect(benchRoles(FormationId.F352, false)).toEqual([Role.GK, Role.CB, Role.LWB, Role.CDM, Role.CM, Role.CB, Role.ST]);
    expect(benchRoles(FormationId.F532, true)).toEqual([Role.GK, Role.CB, Role.RWB, Role.CM, Role.CM, Role.CB, Role.ST]);
    expect(benchRoles(FormationId.F41212, true)).toEqual([Role.GK, Role.CB, Role.RB, Role.CDM, Role.CAM, Role.RW, Role.ST]);
  });

  it('every generated squad validates', () => {
    for (const { params, squad } of SAMPLE) expect(validateSquad(squad, params.formation)).toEqual([]);
  });

  it('validateSquad reports corrupted squads', () => {
    const squad = generateSquad(rng(3), { rating: 70, formation: FormationId.F433, style: TeamStyle.DIRECT });
    const bad = squad.map((p) => ({ ...p }));
    bad[2]!.shirt = bad[3]!.shirt;
    bad[4]!.finishing = 120;
    bad[5]!.overall += 3;
    bad[6]!.pos = Role.ST;
    bad[11]!.pos = Role.CB;
    bad[12]!.short = 'Messi';
    bad[12]!.name = 'L. Messi';
    const errs = validateSquad(bad, FormationId.F433);
    expect(errs.some((e) => e.includes('duplicate shirt'))).toBe(true);
    expect(errs.some((e) => e.includes('finishing=120'))).toBe(true);
    expect(errs.some((e) => e.includes('overall'))).toBe(true);
    expect(errs.some((e) => e.includes('starter 6'))).toBe(true);
    expect(errs.some((e) => e.includes('keepers'))).toBe(true);
    expect(errs.some((e) => e.includes('screened'))).toBe(true);
    expect(validateSquad(squad.slice(0, 17), FormationId.F433).some((e) => e.includes('17 players'))).toBe(true);
  });
});

describe('DAT-02 generator: determinism', () => {
  it('same seed and params give identical squads; another seed differs', () => {
    const p: SquadParams = { rating: 80, formation: FormationId.F4231, style: TeamStyle.WING_PLAY };
    const a = generateSquad(rng(42), p);
    const b = generateSquad(rng(42), p);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(generateSquad(rng(43), p))).not.toBe(JSON.stringify(a));
  });

  it('a whole league from one shared stream is reproducible (as gen-data uses it)', () => {
    const league = (): string => {
      const r = rng(2026);
      const used = new Set<string>();
      const out: PlayerData[][] = [];
      for (let c = 0; c < 20; c++) {
        out.push(generateSquad(r, { rating: 62 + c, formation: FORMATIONS[c % 6]!, style: STYLES[c % 5]! }, { usedNames: used }));
      }
      return JSON.stringify(out);
    };
    expect(league()).toBe(league());
  });

  it('accepts a [0,1) float function or a uint32 function and matches the RngState stream', () => {
    const p: SquadParams = { rating: 70, formation: FormationId.F442, style: TeamStyle.COUNTER };
    const viaState = generateSquad(rng(5), p);
    const r1 = rng(5);
    const viaFloat = generateSquad(() => rngFloat(r1), p);
    const r2 = rng(5);
    const viaUint = generateSquad(() => rngNext(r2), p);
    expect(JSON.stringify(viaFloat)).toBe(JSON.stringify(viaState));
    expect(JSON.stringify(viaUint)).toBe(JSON.stringify(viaState));
    expect(() => generateSquad(() => -1, p)).toThrow(/rng returned/);
    expect(() => generateSquad(() => Number.NaN, p)).toThrow(/rng returned/);
  });

  it('player objects carry exactly the PlayerData fields, all finite', () => {
    const p = ALL[0]!;
    const expected = ['name', 'short', 'shirt', 'pos', 'height', 'foot', 'weakFoot', 'skillMoves', 'overall', ...ATTRIBUTE_KEYS];
    expect(Object.keys(p)).toEqual(expected);
    for (const q of ALL) {
      for (const k of expected.slice(2)) expect(Number.isFinite((q as unknown as Record<string, number>)[k]), k).toBe(true);
    }
  });
});

describe('DAT-02 generator: attribute ranges', () => {
  it('every attribute is an integer in 1..99; heights 165..200; weak foot and skill moves 1..5; foot 0/1', () => {
    for (const p of ALL) {
      for (const k of ATTRIBUTE_KEYS) {
        expect(Number.isInteger(p[k]), k).toBe(true);
        expect(p[k]).toBeGreaterThanOrEqual(1);
        expect(p[k]).toBeLessThanOrEqual(99);
      }
      expect(Number.isInteger(p.height)).toBe(true);
      expect(p.height).toBeGreaterThanOrEqual(165);
      expect(p.height).toBeLessThanOrEqual(200);
      expect(p.weakFoot).toBeGreaterThanOrEqual(1);
      expect(p.weakFoot).toBeLessThanOrEqual(5);
      expect(p.skillMoves).toBeGreaterThanOrEqual(1);
      expect(p.skillMoves).toBeLessThanOrEqual(5);
      expect([Foot.RIGHT, Foot.LEFT]).toContain(p.foot);
      expect(Number.isInteger(p.overall)).toBe(true);
    }
  });

  it('extreme ratings stay in range', () => {
    for (const rating of [1, 40, 62, 88, 99]) {
      for (const f of FORMATIONS) {
        const squad = generateSquad(rng(rating * 7 + f), { rating, formation: f, style: TeamStyle.HIGH_PRESS });
        const errs = validateSquad(squad, f);
        expect(errs, `rating ${rating}`).toEqual([]);
      }
    }
  });

  it('keepers: gk* high and outfield skills low; outfield players: gk* low', () => {
    for (const p of ALL) {
      const gk = mean(GK_KEYS.map((k) => p[k]));
      const out = mean(OUTFIELD_KEYS.map((k) => p[k]));
      if (p.pos === Role.GK) {
        expect(gk).toBeGreaterThan(out + 20);
        expect(p.finishing).toBeLessThan(p.overall - 30);
        expect(p.skillMoves).toBe(1);
      } else {
        for (const k of GK_KEYS) expect(p[k], k).toBeLessThanOrEqual(20);
        expect(out).toBeGreaterThan(gk + 20);
      }
    }
  });
});

describe('DAT-02 generator: position profiles', () => {
  it('centre-backs out-defend strikers; strikers out-finish centre-backs', () => {
    expect(groupMean('CB', 'standingTackle')).toBeGreaterThan(groupMean('ST', 'standingTackle') + 25);
    expect(groupMean('CB', 'slidingTackle')).toBeGreaterThan(groupMean('ST', 'slidingTackle') + 25);
    expect(groupMean('CB', 'interceptions')).toBeGreaterThan(groupMean('ST', 'interceptions') + 15);
    expect(groupMean('CB', 'heading')).toBeGreaterThan(groupMean('W', 'heading') + 10);
    expect(groupMean('CB', 'strength')).toBeGreaterThan(groupMean('W', 'strength') + 10);
    expect(groupMean('ST', 'finishing')).toBeGreaterThan(groupMean('CB', 'finishing') + 25);
    expect(groupMean('ST', 'finishing')).toBeGreaterThan(groupMean('CM', 'finishing') + 8);
  });

  it('wide players are quick dribblers and crossers', () => {
    for (const g of ['W', 'WM'] as const) {
      expect(groupMean(g, 'sprintSpeed')).toBeGreaterThan(groupMean('CB', 'sprintSpeed') + 5);
      expect(groupMean(g, 'acceleration')).toBeGreaterThan(groupMean('CB', 'acceleration') + 5);
      expect(groupMean(g, 'dribbling')).toBeGreaterThan(groupMean('CB', 'dribbling') + 15);
      expect(groupMean(g, 'crossing')).toBeGreaterThan(groupMean('CB', 'crossing') + 15);
      expect(groupMean(g, 'crossing')).toBeGreaterThan(groupMean('ST', 'crossing') + 8);
    }
    expect(groupMean('FB', 'crossing')).toBeGreaterThan(groupMean('CB', 'crossing') + 15);
  });

  it('midfielders: holding players intercept, creators see passes', () => {
    expect(groupMean('DM', 'interceptions')).toBeGreaterThan(groupMean('AM', 'interceptions') + 15);
    expect(groupMean('DM', 'standingTackle')).toBeGreaterThan(groupMean('AM', 'standingTackle') + 20);
    expect(groupMean('AM', 'vision')).toBeGreaterThan(groupMean('CB', 'vision') + 15);
    expect(groupMean('CM', 'shortPassing')).toBeGreaterThan(groupMean('ST', 'shortPassing') + 8);
    expect(groupMean('CM', 'longPassing')).toBeGreaterThan(groupMean('W', 'longPassing') + 5);
  });

  it('the overall rewards the role\'s key attributes: a CB rates higher as CB than as ST, and vice versa', () => {
    for (const p of ALL) {
      if (p.pos === Role.CB) expect(computeOverall(p, Role.CB)).toBeGreaterThan(computeOverall(p, Role.ST));
      if (p.pos === Role.ST) expect(computeOverall(p, Role.ST)).toBeGreaterThan(computeOverall(p, Role.CB));
      if (p.pos === Role.GK) expect(computeOverall(p, Role.GK)).toBeGreaterThan(computeOverall(p, Role.CM) + 20);
    }
  });

  it('club style shapes the squad (possession passes, direct is strong in the air, wing play crosses)', () => {
    const byStyle = (st: TeamStyle, k: AttributeKey): number =>
      mean(SAMPLE.filter((s) => s.params.style === st).flatMap((s) => s.squad.filter((p) => p.pos !== Role.GK).map((p) => p[k] - p.overall)));
    expect(byStyle(TeamStyle.POSSESSION, 'shortPassing')).toBeGreaterThan(byStyle(TeamStyle.DIRECT, 'shortPassing') + 2);
    expect(byStyle(TeamStyle.DIRECT, 'heading')).toBeGreaterThan(byStyle(TeamStyle.POSSESSION, 'heading') + 2);
    expect(byStyle(TeamStyle.WING_PLAY, 'crossing')).toBeGreaterThan(byStyle(TeamStyle.COUNTER, 'crossing') + 2);
    expect(byStyle(TeamStyle.HIGH_PRESS, 'stamina')).toBeGreaterThan(byStyle(TeamStyle.POSSESSION, 'stamina') + 2);
    expect(byStyle(TeamStyle.COUNTER, 'sprintSpeed')).toBeGreaterThan(byStyle(TeamStyle.POSSESSION, 'sprintSpeed') + 2);
  });
});

describe('DAT-02 generator: overall formula', () => {
  it('weights are percentages summing to 100; outfield roles weigh outfield attributes only, keepers keeper ones', () => {
    for (const [g, w] of Object.entries(OVERALL_WEIGHTS)) {
      const entries = Object.entries(w) as [AttributeKey, number][];
      expect(entries.reduce((a, [, v]) => a + v, 0), g).toBe(100);
      for (const [k, v] of entries) {
        expect(v).toBeGreaterThan(0);
        expect(g === 'GK' ? GK_KEYS.includes(k) : OUTFIELD_KEYS.includes(k), `${g}.${k}`).toBe(true);
      }
    }
  });

  it('computeOverall is the rounded weighted mean and every player stores it for his own position', () => {
    for (const p of ALL) {
      const w = OVERALL_WEIGHTS[roleGroup(p.pos)];
      let sum = 0;
      for (const k of ATTRIBUTE_KEYS) sum += (w[k] ?? 0) * p[k];
      expect(p.overall).toBe(Math.round(sum / 100));
      expect(p.overall).toBe(computeOverall(p, p.pos));
    }
  });

  it('a weighted attribute moves the overall, an unweighted one does not', () => {
    const p = { ...ALL.find((q) => q.pos === Role.ST && q.finishing <= 80)!, finishing: 70 };
    const base = computeOverall(p, Role.ST);
    let raw = 0;
    for (const k of ATTRIBUTE_KEYS) raw += (OVERALL_WEIGHTS.ST[k] ?? 0) * p[k];
    // finishing weighs 20% for a striker: +10 finishing = +2.00 raw overall points.
    expect(OVERALL_WEIGHTS.ST.finishing).toBe(20);
    expect(computeOverall({ ...p, finishing: 80 }, Role.ST)).toBe(Math.round((raw + 200) / 100));
    expect(computeOverall({ ...p, finishing: 80 }, Role.ST)).toBe(base + 2);
    expect(computeOverall({ ...p, standingTackle: 99 }, Role.ST)).toBe(base);
    expect(computeOverall({ ...p, gkDiving: 99 }, Role.ST)).toBe(base);
  });
});

describe('DAT-02 generator: scaled to the club rating', () => {
  it('the starting eleven averages the club rating (62..88)', () => {
    for (let rating = 62; rating <= 88; rating++) {
      for (const f of [FormationId.F433, FormationId.F352]) {
        const squad = generateSquad(rng(rating * 31 + f), { rating, formation: f, style: TeamStyle.POSSESSION });
        expect(Math.abs(squadRating(squad) - rating), `rating ${rating}`).toBeLessThanOrEqual(1);
        const exact = mean(squad.slice(0, 11).map((p) => p.overall));
        expect(Math.abs(exact - rating)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stars and weaker players: starters spread around the rating, the bench is weaker', () => {
    const spreads = SAMPLE.map(({ squad }) => {
      const o = squad.slice(0, 11).map((p) => p.overall);
      return Math.max(...o) - Math.min(...o);
    });
    expect(Math.min(...spreads)).toBeGreaterThanOrEqual(4);
    expect(mean(spreads)).toBeGreaterThan(7);
    expect(mean(spreads)).toBeLessThan(16);
    for (const { params, squad } of SAMPLE) {
      const star = Math.max(...squad.slice(0, 11).map((p) => p.overall));
      expect(star).toBeGreaterThan(params.rating);
      const bench = mean(squad.slice(11).map((p) => p.overall));
      expect(bench).toBeLessThan(mean(squad.slice(0, 11).map((p) => p.overall)));
    }
  });

  it('a stronger club has better attributes across the board', () => {
    const top = generateSquad(rng(8), { rating: 88, formation: FormationId.F442, style: TeamStyle.POSSESSION });
    const bottom = generateSquad(rng(8), { rating: 62, formation: FormationId.F442, style: TeamStyle.POSSESSION });
    const avg = (sq: PlayerData[], k: AttributeKey): number => mean(sq.filter((p) => p.pos !== Role.GK).map((p) => p[k]));
    for (const k of OUTFIELD_KEYS) expect(avg(top, k), k).toBeGreaterThan(avg(bottom, k) + 10);
    expect(top[0]!.gkReflexes).toBeGreaterThan(bottom[0]!.gkReflexes + 10);
  });
});

describe('DAT-02 generator: height, feet, weak foot, skill moves', () => {
  it('keepers are tallest, centre-backs tall, wingers short', () => {
    for (const p of ALL) if (p.pos === Role.GK) expect(p.height).toBeGreaterThanOrEqual(183);
    expect(groupMean('GK', 'height')).toBeGreaterThan(groupMean('CM', 'height') + 7);
    expect(groupMean('CB', 'height')).toBeGreaterThan(groupMean('W', 'height') + 8);
    expect(mean(ALL.map((p) => p.height))).toBeGreaterThan(176);
    expect(mean(ALL.map((p) => p.height))).toBeLessThan(186);
  });

  it('about 75% right-footed; left-sided defenders mostly left-footed', () => {
    const right = ALL.filter((p) => p.foot === Foot.RIGHT).length / ALL.length;
    expect(right).toBeGreaterThan(0.68);
    expect(right).toBeLessThan(0.82);
    const leftShare = (r: Role): number => {
      const ps = ALL.filter((p) => p.pos === r);
      return ps.filter((p) => p.foot === Foot.LEFT).length / ps.length;
    };
    expect(leftShare(Role.LB)).toBeGreaterThan(0.45);
    expect(leftShare(Role.RB)).toBeLessThan(0.2);
  });

  it('weak foot and skill moves correlate with role', () => {
    expect(groupMean('W', 'skillMoves')).toBeGreaterThan(groupMean('CB', 'skillMoves') + 1.5);
    expect(groupMean('AM', 'skillMoves')).toBeGreaterThan(groupMean('DM', 'skillMoves') + 0.8);
    expect(groupMean('ST', 'weakFoot')).toBeGreaterThan(groupMean('CB', 'weakFoot') + 0.4);
    expect(groupMean('GK', 'skillMoves')).toBe(1);
    // Both ends of the scales occur.
    expect(ALL.some((p) => p.skillMoves === 5)).toBe(true);
    expect(ALL.some((p) => p.weakFoot === 5)).toBe(true);
    expect(ALL.some((p) => p.weakFoot === 1)).toBe(true);
  });
});

describe('DAT-02 generator: shirt numbers', () => {
  it('unique within a squad and in 1..99', () => {
    for (const { squad } of SAMPLE) {
      const shirts = squad.map((p) => p.shirt);
      expect(new Set(shirts).size).toBe(18);
      for (const n of shirts) expect(n >= 1 && n <= 99 && Number.isInteger(n)).toBe(true);
    }
  });

  it('conventional: 1 for the keeper, 2-5 for a back four, 9 for a striker, 7/11 on the wings, 10 for a CAM', () => {
    for (const { params, squad } of SAMPLE) {
      expect(squad[0]!.shirt).toBe(1);
      const starters = squad.slice(0, 11);
      const roles = starters.map((p) => p.pos);
      if (roles.includes(Role.RB)) {
        const defenders = starters.filter((p) => [Role.RB, Role.LB, Role.CB].includes(p.pos)).map((p) => p.shirt).sort((a, b) => a - b);
        expect(defenders, `formation ${params.formation}`).toEqual([2, 3, 4, 5]);
        expect(starters.find((p) => p.pos === Role.RB)!.shirt).toBe(2);
        expect(starters.find((p) => p.pos === Role.LB)!.shirt).toBe(3);
      }
      expect(starters.some((p) => p.pos === Role.ST && p.shirt === 9)).toBe(true);
      const cam = starters.find((p) => p.pos === Role.CAM);
      if (cam) expect(cam.shirt).toBe(10);
      for (const p of starters) {
        if (p.pos === Role.RM || p.pos === Role.RW) expect(p.shirt).toBe(7);
        if (p.pos === Role.LM || p.pos === Role.LW) expect(p.shirt).toBe(11);
      }
      expect(starters.map((p) => p.shirt).sort((a, b) => a - b), `formation ${params.formation}`)
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      for (const p of squad.slice(11)) expect(p.shirt).toBeGreaterThan(11);
      expect(squad[11]!.shirt).toBe(13);
    }
  });

  it('assignShirtNumbers never runs out and stays unique for odd role lists', () => {
    const roles = Array.from({ length: 18 }, () => Role.ST);
    const shirts = assignShirtNumbers(roles);
    expect(new Set(shirts).size).toBe(18);
    expect(shirts[0]).toBe(9);
    const keepers = assignShirtNumbers([Role.GK, Role.GK, Role.GK]);
    expect(keepers).toEqual([1, 13, 12]);
  });
});

describe('DAT-02 generator: names', () => {
  it('display "X. Surname", short = surname, unique within the squad, all pass strict screening', () => {
    for (const { squad } of SAMPLE) {
      const names = new Set<string>();
      const shorts = new Set<string>();
      for (const p of squad) {
        expect(p.name).toBe(displayName(p.name.charAt(0), p.short));
        expect(p.name).toMatch(/^\p{Lu}\. \S/u);
        expect(p.short.length).toBeGreaterThanOrEqual(3);
        expect(p.short.length).toBeLessThanOrEqual(15);
        expect(screenName(p.name.charAt(0), p.short, true), p.name).toBeNull();
        names.add(nameKey(p.name));
        shorts.add(nameKey(p.short));
      }
      expect(names.size).toBe(18);
      expect(shorts.size).toBe(18);
    }
  });

  it('a shared usedNames set keeps display names unique across a 20-club league', () => {
    const r = rng(77);
    const used = new Set<string>();
    const all: string[] = [];
    for (let c = 0; c < 20; c++) {
      for (const p of generateSquad(r, { rating: 70 + (c % 10), formation: FORMATIONS[c % 6]!, style: STYLES[c % 5]! }, { usedNames: used })) {
        all.push(nameKey(p.name));
      }
    }
    expect(new Set(all).size).toBe(360);
    expect(used.size).toBe(360);
  });

  it('names are mixed-origin and varied (many distinct surnames, some double-barrelled)', () => {
    const r = rng(78);
    const league: string[] = [];
    for (let c = 0; c < 20; c++) {
      for (const p of generateSquad(r, { rating: 75, formation: FORMATIONS[c % 6]!, style: STYLES[c % 5]! })) league.push(nameKey(p.short));
    }
    expect(new Set(league).size).toBeGreaterThan(300);
    const shorts = ALL.map((p) => p.short);
    expect(new Set(shorts).size).toBeGreaterThan(shorts.length * 0.5);
    expect(shorts.some((s) => s.includes('-'))).toBe(true);
    expect(shorts.some((s) => /[^ -~]/.test(s))).toBe(true);
  });

  it('injected famous names are screened out and replaced', () => {
    const famous: [string, string][] = [
      ['Lionel', 'Messi'], ['Cristiano', 'Ronaldo'], ['Luka', 'Modric'], ['Leo', 'Messy'], ['Nikola', 'Vidic'],
      ['Marko', 'Vidic'], ['Virgil', 'van Dijk'], ['Kylian', 'Mbappé'], ['Tomas', 'Holm-Pelé'], ['Arno', 'Fuckerson'],
    ];
    let calls = 0;
    const source: NameSource = (next) => {
      calls++;
      // Every other candidate is a famous collision; the rest are the normal invented names.
      if (calls % 2 === 1) {
        const [first, last] = famous[(calls >> 1) % famous.length]!;
        return { first, last };
      }
      return rawName(next);
    };
    const squad = generateSquad(rng(9), { rating: 75, formation: FormationId.F433, style: TeamStyle.COUNTER }, { nameSource: source });
    expect(validateSquad(squad, FormationId.F433)).toEqual([]);
    const keys = squad.map((p) => nameKey(p.short));
    for (const [, last] of famous) {
      for (const part of last.split('-')) expect(keys).not.toContain(nameKey(part));
    }
    expect(calls).toBeGreaterThanOrEqual(36);
  });

  it('a duplicate-only or famous-only source fails loudly instead of committing a bad name', () => {
    const famousOnly: NameSource = () => ({ first: 'Lionel', last: 'Messi' });
    expect(() => generateSquad(rng(1), { rating: 70, formation: FormationId.F442, style: TeamStyle.DIRECT }, { nameSource: famousOnly }))
      .toThrow(/no screened, unique name/);
    const sameName: NameSource = () => ({ first: 'Torvald', last: 'Holmqvist' });
    expect(() => generateSquad(rng(1), { rating: 70, formation: FormationId.F442, style: TeamStyle.DIRECT }, { nameSource: sameName }))
      .toThrow(/no screened, unique name/);
  });

  it('usedNames from another club are respected', () => {
    const used = new Set<string>([nameKey('T. Holmqvist')]);
    let n = 0;
    const source: NameSource = (next) => (n++ === 0 ? { first: 'Torvald', last: 'Holmqvist' } : rawName(next));
    const squad = generateSquad(rng(4), { rating: 70, formation: FormationId.F442, style: TeamStyle.DIRECT }, { nameSource: source, usedNames: used });
    expect(squad.map((p) => p.name)).not.toContain('T. Holmqvist');
  });

  it('raw invented names are pronounceable at the seams', () => {
    expect(seamOk('Ema', '+nuele')).toBe(true);
    expect(seamOk('Mas', '+nuele')).toBe(false);
    expect(seamOk('Or', 'rrete')).toBe(false);
    expect(seamOk('Car', 'nzo')).toBe(false);
    expect(seamOk('Ce', 'ay')).toBe(false);
    expect(seamOk('Le', 'andro')).toBe(true);
    expect(seamOk('Ti', 'icio')).toBe(true);
    expect(seamOk('Shima', 'shima')).toBe(false);
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const { first, last } = rawName(() => rngFloat(r));
      expect(first).not.toMatch(/(.)\1\1/u);
      expect(last).not.toMatch(/(.)\1\1/u);
      expect(first).not.toContain('+');
      expect(last).not.toContain('+');
    }
  });
});

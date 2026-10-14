/**
 * [DAT-05] tools/balance.ts: matchup selection, CLI flags, the match plan (CPU v CPU at Professional, mirror legs),
 * outcome classification, the per-matchup summary and PASS / FAIL verdict (BRIEF section 15: an 88-rated club beats a
 * 62-rated club at least 80% of the time over 200 matches; equal clubs split close to evenly), smoke runs through
 * tools/headless.ts runMatch (in-process and on a worker thread), and the static (type-aware) attribute audit.
 * The balance numbers themselves are not asserted here (tuning happens later); QA re-runs `npx tsx tools/balance.ts`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, type Club } from '../../src/contracts/data';
import { ControllerKind, Difficulty, KitSlot, MatchPhase, ModeId } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import {
  AUDIT_BEGIN, AUDIT_END, AUDIT_KEYS, balanceConfig, balanceWarnings, balanceRequestFromArgs, balanceSpecs, bottomClub, defaultBalanceOptions,
  equalPair, errorResult, formatAuditTable, formatMatchup, matchesFor, matchOutcome, matchSeed, matchupsFor, medianClub,
  medianRating, parseClub, parseSuites, replaceAuditBlock, runBalance, runBalanceMatch, runOnWorkers, staticAttributeAudit,
  summarizeMatchup, topClub, wilson, type BalanceMatchResult, type BalanceOptions, type Matchup,
} from '../../tools/balance';

/** Synthetic club list with the given ratings (squads etc. borrowed from the real clubs). */
function clubsWith(ratings: number[]): Club[] {
  return ratings.map((rating, id) => ({ ...CLUBS[id % CLUBS.length]!, id, rating }));
}

function opts(o: Partial<BalanceOptions> = {}): BalanceOptions {
  return { ...defaultBalanceOptions(), quiet: true, ...o };
}

/** A counted match result for summary tests. */
function res(m: Matchup, aResult: 'W' | 'D' | 'L' | 'E', aTeam = 0, aGoals = 1, bGoals = 0): BalanceMatchResult {
  return {
    id: 0, suite: m.suite, index: 0, aTeam, a: m.a, b: m.b, seed: 1,
    goals: aTeam === 0 ? [aGoals, bGoals] : [bGoals, aGoals], aResult, decidedBy: aResult === 'E' ? 'error' : aResult === 'D' ? 'draw' : 'goals',
    aGoals, bGoals,
    side: { shots: [4, 2], shotsOnTarget: [2, 1], passes: [10, 8], passesCompleted: [8, 4], possessionPct: [60, 40] },
    ticks: 100, finished: true, partial: false, invariantFailures: 0, watchdogs: 0, wallMs: 1,
    ...(aResult === 'E' ? { error: 'boom' } : {}),
  };
}

describe('DAT-05 balance: matchup selection', () => {
  it('top-bottom picks the 88-rated and the 62-rated club of the committed data', () => {
    expect(CLUBS[topClub(CLUBS)]!.rating).toBe(88);
    expect(CLUBS[bottomClub(CLUBS)]!.rating).toBe(62);
  });

  it('equal picks the closest-rated pair (higher first); ties go to the pair nearest the median, then lower ids', () => {
    const [a, b] = equalPair(CLUBS);
    expect(a).not.toBe(b);
    const d = CLUBS[a]!.rating - CLUBS[b]!.rating;
    expect(d).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < CLUBS.length; i++) {
      for (let j = i + 1; j < CLUBS.length; j++) expect(Math.abs(CLUBS[i]!.rating - CLUBS[j]!.rating)).toBeGreaterThanOrEqual(d);
    }
    // Ratings 60, 61 | 70, 71 | 80, 81 -> three pairs one apart; the median is 70.5, so (71, 70).
    expect(equalPair(clubsWith([60, 61, 70, 71, 80, 81]))).toEqual([3, 2]);
    // Equal ratings beat a one-point gap; between equal pairs the one nearest the median (75) wins, then lower ids.
    expect(equalPair(clubsWith([62, 70, 70, 75, 75, 88, 80]))).toEqual([3, 4]);
    expect(equalPair(clubsWith([62, 75, 75, 88, 70, 70]))).toEqual([1, 2]);
    expect(() => equalPair(clubsWith([70]))).toThrow();
  });

  it('median rating / median club (ties: lower rating, then lower id)', () => {
    expect(medianRating(clubsWith([62, 70, 88]))).toBe(70);
    expect(medianRating(clubsWith([62, 70, 80, 88]))).toBe(75);
    expect(medianRating([])).toBe(0);
    expect(medianClub(clubsWith([62, 70, 80, 88]))).toBe(1); // 70 and 80 both 5 from 75: the lower rating
    expect(topClub(clubsWith([80, 88, 88]))).toBe(1);
    expect(bottomClub(clubsWith([62, 70, 62]))).toBe(0);
  });

  it('matchupsFor keeps SUITES order, honours overrides and plays mirror legs except in the mirror suite', () => {
    const ms = matchupsFor(['mirror', 'top-bottom', 'equal'], CLUBS);
    expect(ms.map((m) => m.suite)).toEqual(['top-bottom', 'equal', 'mirror']);
    expect(ms.map((m) => m.mirrorLegs)).toEqual([true, true, false]);
    expect(ms[2]!.a).toBe(ms[2]!.b);
    const ov = matchupsFor(['top-bottom', 'equal', 'mirror'], CLUBS, { top: 2, bottom: 4, equal: [5, 6], mirror: 9 });
    expect(ov.map((m) => [m.a, m.b])).toEqual([[2, 4], [5, 6], [9, 9]]);
  });
});

describe('DAT-05 balance: CLI flags', () => {
  it('defaults: 200 matches per matchup, every suite, CPU v CPU at Professional, the brief targets, enforced', () => {
    const r = balanceRequestFromArgs([]);
    expect(r.mode).toBe('balance');
    const b = r.balance;
    expect(b.matches).toBe(200);
    expect(b.suites).toEqual(['top-bottom', 'equal', 'mirror']);
    expect(b.difficulty).toBe(Difficulty.PROFESSIONAL);
    expect(b.topTarget).toBe(0.8);
    expect(b.evenTol).toBe(0.1);
    expect(b.enforce).toBe(true);
    expect(b.maxTicks).toBeNull();
    expect(b.cup).toBe(false);
  });

  it('parses every flag (club codes or ids), and --audit / --help modes', () => {
    const r = balanceRequestFromArgs([
      '--matches', '40', '--suite', 'equal,top-bottom', '--workers', '0', '--seed', '9', '--halfMinutes', '3', '--difficulty', '5',
      '--cup', '--top-target', '0.7', '--even-tol', '0.05', '--top', 'mos', '--bottom', '12', '--equal', 'SND,GLA', '--mirror', 'GLA',
      '--checker', 'core', '--max-ticks', '600', '--job-timeout', '30', '--json', 'x.json', '--no-enforce', '--quiet',
    ]).balance;
    expect(r).toMatchObject({
      matches: 40, suites: ['equal', 'top-bottom'], workers: 0, seed: 9, halfMinutes: 3, difficulty: 5, cup: true, topTarget: 0.7,
      evenTol: 0.05, checker: 'core', maxTicks: 600, jobTimeoutSeconds: 30, json: 'x.json', enforce: false, quiet: true,
    });
    expect(r.overrides.top).toBe(CLUBS.find((c) => c.code === 'MOS')!.id);
    expect(r.overrides.bottom).toBe(12);
    expect(r.overrides.equal).toEqual([parseClub('SND'), parseClub('GLA')]);
    expect(balanceRequestFromArgs(['--audit', '--write-doc', 'd.md'])).toMatchObject({ mode: 'audit', writeDoc: 'd.md' });
    expect(balanceRequestFromArgs(['--help']).mode).toBe('help');
    expect(balanceRequestFromArgs(['--halfMinutes', '50']).balance.halfMinutes).toBe(10);
    expect(parseSuites('all')).toEqual(['top-bottom', 'equal', 'mirror']);
  });

  it('rejects bad input instead of silently running defaults', () => {
    const bad = [
      ['--suite', 'nope'], ['--top', 'XXX'], ['--top', '99'], ['--top', 'MOS', '--bottom', 'MOS'], ['--equal', 'MOS'],
      ['--equal', 'MOS,MOS'], ['--difficulty', '9'], ['--difficulty', '2.5'], ['--checker', 'some'], ['--top-target', '0'],
      ['--even-tol', '0.6'], ['--write-doc', 'a.md'], ['--frobnicate'], ['stray'], ['--matches'],
    ];
    for (const argv of bad) expect(() => balanceRequestFromArgs(argv), argv.join(' ')).toThrow();
  });
});

describe('DAT-05 balance: match plan', () => {
  it('mirror legs: an even number of matches, both legs share a seed, club A at home then away', () => {
    expect(matchesFor({ mirrorLegs: true }, 7)).toBe(8);
    expect(matchesFor({ mirrorLegs: false }, 7)).toBe(7);
    expect(matchesFor({ mirrorLegs: true }, 0)).toBe(2);
    const specs = balanceSpecs(opts({ matches: 3, suites: ['top-bottom'] }));
    expect(specs).toHaveLength(4);
    const top = topClub(CLUBS), bot = bottomClub(CLUBS);
    expect(specs.map((s) => [s.config.homeClub, s.config.awayClub, s.aTeam, s.index])).toEqual([
      [top, bot, 0, 0], [bot, top, 1, 0], [top, bot, 0, 1], [bot, top, 1, 1],
    ]);
    expect(specs[0]!.config.seed).toBe(specs[1]!.config.seed);
    expect(specs[2]!.config.seed).not.toBe(specs[0]!.config.seed);
    expect(specs.map((s) => s.id)).toEqual([0, 1, 2, 3]);
  });

  it('the mirror suite gives every match its own seed; suites never share seeds', () => {
    const specs = balanceSpecs(opts({ matches: 6, suites: ['mirror'] }));
    expect(new Set(specs.map((s) => s.config.seed)).size).toBe(6);
    expect(matchSeed(1, 'top-bottom', 0)).not.toBe(matchSeed(1, 'equal', 0));
    expect(matchSeed(1, 'top-bottom', 0)).not.toBe(matchSeed(2, 'top-bottom', 0));
  });

  it('configs are CPU v CPU at the chosen level, preferred formations, offside and fouls on, no replays', () => {
    const c = balanceConfig(77, 10, 12, { halfMinutes: 4, cup: false, difficulty: Difficulty.PROFESSIONAL });
    expect(c.seed).toBe(77);
    expect(c.humans.map((h) => h.kind)).toEqual([ControllerKind.NONE, ControllerKind.NONE]);
    expect(c.difficulty).toBe(Difficulty.PROFESSIONAL);
    expect(c.homeFormation).toBe(CLUBS[10]!.formation);
    expect(c.awayFormation).toBe(CLUBS[12]!.formation);
    expect([c.homeKit, c.awayKit]).toEqual([KitSlot.HOME, KitSlot.AWAY]);
    expect([c.offside, c.fouls, c.replaySeconds, c.cupRules, c.mode]).toEqual([1, 1, 0, 0, ModeId.KICK_OFF]);
    expect(c.startPhase).toBe(MatchPhase.KICK_OFF);
    const cup = balanceConfig(1, 0, 1, { halfMinutes: 2, cup: true, difficulty: Difficulty.LEGEND });
    expect([cup.cupRules, cup.mode, cup.difficulty, cup.halfMinutes]).toEqual([1, ModeId.CUP, Difficulty.LEGEND, 2]);
  });
});

describe('DAT-05 balance: outcomes and the verdict', () => {
  function state(g0: number, g1: number, extra: { forfeit?: number; winner?: number; shootout?: number } = {}): SimState {
    return {
      teams: [{ goals: g0 }, { goals: g1 }],
      match: { forfeitTeam: extra.forfeit ?? -1, winner: extra.winner ?? -1, shootout: { winner: extra.shootout ?? -1 } },
    } as unknown as SimState;
  }

  it('matchOutcome: a forfeit first, then the score, then the cup winner / shoot-out, else a draw', () => {
    expect(matchOutcome(state(2, 1))).toEqual({ winner: 0, decidedBy: 'goals' });
    expect(matchOutcome(state(0, 3))).toEqual({ winner: 1, decidedBy: 'goals' });
    expect(matchOutcome(state(5, 0, { forfeit: 0 }))).toEqual({ winner: 1, decidedBy: 'forfeit' });
    expect(matchOutcome(state(1, 1, { shootout: 1 }))).toEqual({ winner: 1, decidedBy: 'shootout' });
    expect(matchOutcome(state(1, 1, { winner: 0, shootout: 1 }))).toEqual({ winner: 0, decidedBy: 'shootout' });
    expect(matchOutcome(state(1, 1))).toEqual({ winner: -1, decidedBy: 'draw' });
  });

  it('wilson interval brackets the rate and narrows with n', () => {
    const [lo, hi] = wilson(160, 200);
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(hi - lo).toBeLessThan(wilson(16, 20)[1] - wilson(16, 20)[0]);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(wilson(0, 50)[0]).toBe(0);
    expect(wilson(50, 50)[1]).toBe(1);
  });

  it('top-bottom: judged on the win share of the higher-rated club (draws are not wins)', () => {
    const m: Matchup = { suite: 'top-bottom', a: 10, b: 12, mirrorLegs: true };
    const o = { topTarget: 0.8, evenTol: 0.1 };
    const pass = [...Array(8)].map((_, i) => res(m, 'W', i & 1)).concat([res(m, 'D'), res(m, 'L', 1, 0, 2)]);
    const x = summarizeMatchup(m, pass, o);
    expect([x.n, x.wins, x.draws, x.losses, x.winRate, x.pointsShare]).toEqual([10, 8, 1, 1, 0.8, 0.85]);
    expect([x.metric, x.met, x.pass, x.aHomeWins, x.aAwayWins]).toEqual(['wins', true, true, 4, 4]);
    expect(x.passCompletion[0]).toBeCloseTo(0.8);
    const fail = summarizeMatchup(m, [...Array(7)].map(() => res(m, 'W')).concat([res(m, 'D'), res(m, 'D'), res(m, 'D')]), o);
    expect(fail.pointsShare).toBeCloseTo(0.85);
    expect(fail.met).toBe(false);
    expect(formatMatchup(fail)[0]).toContain('FAIL');
    expect(formatMatchup(fail, false)[0]).toContain('below target');
    expect(formatMatchup(x)[0]).toContain('PASS');
  });

  it('equal / mirror: judged on the points share within 0.5 +- tolerance; a failed match fails the matchup', () => {
    const m: Matchup = { suite: 'equal', a: 14, b: 7, mirrorLegs: true };
    const o = { topTarget: 0.8, evenTol: 0.1 };
    const even = summarizeMatchup(m, [res(m, 'W'), res(m, 'L', 1, 0, 1), res(m, 'D'), res(m, 'D')], o);
    expect([even.metric, even.value, even.met, even.pass]).toEqual(['points', 0.5, true, true]);
    const lop = summarizeMatchup(m, [res(m, 'W'), res(m, 'W'), res(m, 'W'), res(m, 'D')], o);
    expect(lop.met).toBe(false);
    const err = summarizeMatchup(m, [res(m, 'W'), res(m, 'L', 0, 0, 1), res(m, 'E')], o);
    expect([err.n, err.errors, err.met, err.pass]).toEqual([2, 1, true, false]);
    expect(formatMatchup(err)[0]).toContain('FAIL (1 failed match(es))');
    // Results of other matchups are ignored.
    const other: Matchup = { suite: 'mirror', a: 7, b: 7, mirrorLegs: false };
    expect(summarizeMatchup(other, [res(m, 'W')], o).n).toBe(0);
    expect(summarizeMatchup(other, [res(m, 'W')], o).met).toBe(false);
  });

  it('warns (without changing the verdict) when draws dominate or hardly anyone scores', () => {
    const m: Matchup = { suite: 'equal', a: 14, b: 7, mirrorLegs: true };
    const o = { topTarget: 0.8, evenTol: 0.1 };
    const dull = summarizeMatchup(m, [res(m, 'D', 0, 0, 0), res(m, 'D', 1, 0, 0), res(m, 'W', 0, 1, 0)], o);
    expect(dull.met).toBe(true);
    const w = balanceWarnings([dull]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('66.7% draws');
    expect(w[0]).toContain('0.33 goals per match');
    const lively = summarizeMatchup(m, [res(m, 'W', 0, 3, 1), res(m, 'L', 1, 0, 2), res(m, 'D', 0, 1, 1)], o);
    expect(balanceWarnings([lively])).toEqual([]);
    expect(balanceWarnings([summarizeMatchup(m, [], o)])).toEqual([]);
  });
});

describe('DAT-05 balance: smoke runs through tools/headless runMatch', () => {
  it('a partial balance match (--max-ticks) runs both CPU brains and reports a counted result', () => {
    const spec = balanceSpecs(opts({ matches: 1, suites: ['top-bottom'], maxTicks: 900, checker: 'core' }))[1]!;
    const r = runBalanceMatch(spec);
    expect(r.error).toBeUndefined();
    expect(['W', 'D', 'L']).toContain(r.aResult);
    expect(r.ticks).toBe(900);
    expect(r.partial).toBe(true);
    expect(r.invariantFailures).toBe(0);
    expect(r.aTeam).toBe(1);
    expect(r.aGoals).toBe(r.goals[1]);
    // An error result never counts.
    expect(errorResult(spec, 'x').aResult).toBe('E');
  });

  it('runBalance in-process: every suite, targets reported but not enforced on a smoke run, JSON written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat05-'));
    const json = join(dir, 'b.json');
    const r = await runBalance(opts({ matches: 2, workers: 0, maxTicks: 300, json }));
    expect(r.matchups.map((m) => m.suite)).toEqual(['top-bottom', 'equal', 'mirror']);
    expect(r.results).toHaveLength(2 + 2 + 2);
    expect(r.results.every((x) => x.aResult !== 'E')).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.lines.at(-2)).toMatch(/^RESULT: PASS .*targets not enforced/);
    const out = JSON.parse(readFileSync(json, 'utf8')) as { tool: string; matchups: unknown[]; matches: unknown[] };
    expect(out.tool).toBe('balance');
    expect(out.matchups).toHaveLength(3);
    expect(out.matches).toHaveLength(6);
  });

  it('a worker thread plays the same match as the main thread (same score and ticks)', async () => {
    const specs = balanceSpecs(opts({ matches: 1, suites: ['equal'], maxTicks: 240 }));
    const inline = specs.map((s) => runBalanceMatch(s));
    const pooled = await runOnWorkers(specs, { workers: 1, jobTimeoutSeconds: 120 });
    expect(pooled.map((x) => x.error ?? null)).toEqual([null, null]);
    expect(pooled.map((x) => [x.goals, x.ticks, x.aResult])).toEqual(inline.map((x) => [x.goals, x.ticks, x.aResult]));
  });
});

describe('DAT-05 static attribute audit', () => {
  it('fixture: counts reads (property, element, destructuring, derived topSpeed), not writes or other interfaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat05-audit-'));
    writeFileSync(join(dir, 'fixture.ts'), [
      'interface PlayerAttrs { sprintSpeed: number; acceleration: number; finishing: number; heading: number; vision: number;',
      '  stamina: number; topSpeed: number; curve: number }',
      'interface PlayerState { stamina: number; curve: number }',
      'export function f(a: PlayerAttrs, p: PlayerState): number {',
      '  a.vision = 50;', // a write: not a consumer
      '  const { heading } = a;', // destructuring
      '  return a.finishing + a["curve"] + heading + a.topSpeed + p.stamina + p.curve;',
      '}',
    ].join('\n'));
    const rows = staticAttributeAudit({ root: dir, files: ['fixture.ts'] });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(rows.map((r) => r.key)).toEqual([...AUDIT_KEYS]);
    expect(by('finishing').direct).toEqual(['fixture.ts']);
    expect(by('curve').reads).toHaveLength(1); // a["curve"]; p.curve is PlayerState
    expect(by('heading').consumed).toBe(true);
    expect(by('vision').consumed).toBe(false);
    expect(by('stamina').consumed).toBe(false); // PlayerState.stamina is the condition, not the attribute
    expect(by('sprintSpeed').derived).toEqual(['fixture.ts']);
    expect(by('acceleration').derived).toEqual(['fixture.ts']);
    expect(by('sprintSpeed').direct).toEqual([]);
    const table = formatAuditTable(rows);
    expect(table.find((l) => l.startsWith('| vision |'))).toContain('**UNREAD**');
    expect(table.find((l) => l.startsWith('| sprintSpeed |'))).toContain('(via topSpeed / accel)');
  });

  it('every audited attribute (25 attributes + height, foot, weakFoot, skillMoves) is read by src/sim or src/ai', () => {
    const rows = staticAttributeAudit();
    expect(rows).toHaveLength(ATTRIBUTE_KEYS.length + 4);
    const unread = rows.filter((r) => !r.consumed).map((r) => r.key);
    expect(unread).toEqual([]);
    // Plumbing (init copy, hash, serialise) never counts as a consumer.
    for (const r of rows) for (const x of r.reads) expect(x.file).not.toBe('src/sim/init.ts');
  });

  it('replaceAuditBlock rewrites only the text between the markers; docs/ATTRIBUTE_AUDIT.md has the markers and every key', () => {
    const doc = `head\n${AUDIT_BEGIN}\nold table\n${AUDIT_END}\ntail\n`;
    const out = replaceAuditBlock(doc, ['| a |', '| b |']);
    expect(out).toBe(`head\n${AUDIT_BEGIN}\n| a |\n| b |\n${AUDIT_END}\ntail\n`);
    expect(replaceAuditBlock(out, ['| c |'])).toBe(`head\n${AUDIT_BEGIN}\n| c |\n${AUDIT_END}\ntail\n`);
    expect(() => replaceAuditBlock('no markers', ['x'])).toThrow();
    const real = readFileSync(join(__dirname, '../../docs/ATTRIBUTE_AUDIT.md'), 'utf8');
    expect(real).toContain('<!-- static-audit:begin');
    expect(real).toContain(AUDIT_END);
    for (const k of AUDIT_KEYS) expect(real).toContain(`| ${k} |`);
  });
});

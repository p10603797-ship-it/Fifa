/**
 * TAI-12: tools/ladder.ts, the difficulty-ladder runner (BRIEF section 7: each level beats the one below in >= 65% of
 * bot-v-bot matches; used by QA-19). Checks the match plan (mirror legs, same configs for every pair, bot-v-bot),
 * the per-team level override, outcome and summary maths (W/D/L, metrics, Wilson interval), and the CLI end to end on
 * worker threads (short, partial matches: the sim is not yet able to verify the ladder itself).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ControllerKind, MatchPhase, ModeId } from '../../src/contracts/enums';
import { CLUBS } from '../../src/data/clubs';
import { defaultMaxTicks } from '../../tools/headless';
import {
  adjacentPairs, defaultLadderOptions, formatPair, ladderConfig, ladderOptionsFromArgs, ladderSpecs, matchesPerPair,
  matchOutcome, parsePairs, runLadder, runLadderMatch, summarizePair, wilson, type LadderMatchResult, type LadderOptions,
} from '../../tools/ladder';
import { makeScenario } from '../harness/scenario';

const ROOT = resolve(__dirname, '../..');
const TMP = mkdtempSync(join(tmpdir(), 'tai12-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function opts(over: Partial<LadderOptions> = {}): LadderOptions {
  return { ...defaultLadderOptions(), quiet: true, ...over };
}

function tsx(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000, env: { ...process.env, FORCE_COLOR: '0' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('TAI-12 ladder options', () => {
  it('defaults: every adjacent pair, 40 matches, 4-minute halves, same clubs, wins >= 65%, enforced', () => {
    const o = defaultLadderOptions();
    expect(o.pairs).toEqual([{ hi: 1, lo: 0 }, { hi: 2, lo: 1 }, { hi: 3, lo: 2 }, { hi: 4, lo: 3 }, { hi: 5, lo: 4 }]);
    expect(adjacentPairs()).toEqual(o.pairs);
    expect(o.matches).toBe(40);
    expect(o.halfMinutes).toBe(4);
    expect(o.clubs).toBe('same');
    expect(o.metric).toBe('wins');
    expect(o.target).toBe(0.65);
    expect(o.enforce).toBe(true);
    expect(o.cup).toBe(false);
    expect(o.maxTicks).toBeNull();
  });

  it('parses pairs: adjacent lower levels, H:L pairs, all', () => {
    expect(parsePairs('0,4')).toEqual([{ hi: 1, lo: 0 }, { hi: 5, lo: 4 }]);
    expect(parsePairs('5:0, 3:2')).toEqual([{ hi: 5, lo: 0 }, { hi: 3, lo: 2 }]);
    expect(parsePairs('all')).toEqual(adjacentPairs());
    for (const bad of ['5', '6:0', '2:3', '3:3', 'x', '1:', '-1', ',']) expect(() => parsePairs(bad), bad).toThrow(/--pairs/);
  });

  it('parses flags and rejects bad values and unknown flags', () => {
    const o = ladderOptionsFromArgs(['--matches', '7', '--pairs', '2', '--workers', '0', '--seed', '9', '--halfMinutes', '3',
      '--clubs', 'mixed', '--cup', '--metric', 'decisive', '--target', '0.7', '--checker', 'core', '--max-ticks', '500',
      '--job-timeout', '30', '--json', 'x.json', '--no-enforce', '--quiet'])!;
    expect(o).toEqual({
      matches: 7, pairs: [{ hi: 3, lo: 2 }], workers: 0, seed: 9, halfMinutes: 3, clubs: 'mixed', cup: true, metric: 'decisive',
      target: 0.7, checker: 'core', maxTicks: 500, jobTimeoutSeconds: 30, json: 'x.json', enforce: false, quiet: true,
    });
    expect(ladderOptionsFromArgs(['--help'])).toBeNull();
    expect(ladderOptionsFromArgs(['--halfMinutes', '30'])!.halfMinutes).toBe(10);
    expect(ladderOptionsFromArgs(['--halfMinutes', '1'])!.halfMinutes).toBe(2);
    expect(() => ladderOptionsFromArgs(['--matchez', '3'])).toThrow(/unknown flag --matchez/);
    expect(() => ladderOptionsFromArgs(['--clubs', 'other'])).toThrow(/--clubs/);
    expect(() => ladderOptionsFromArgs(['--metric', 'goals'])).toThrow(/--metric/);
    expect(() => ladderOptionsFromArgs(['--target', '1.5'])).toThrow(/--target/);
    expect(() => ladderOptionsFromArgs(['--target', '0'])).toThrow(/--target/);
    expect(() => ladderOptionsFromArgs(['--checker', 'some'])).toThrow(/--checker/);
    expect(() => ladderOptionsFromArgs(['stray'])).toThrow(/unexpected argument/);
  });
});

describe('TAI-12 ladder match plan', () => {
  it('rounds matches per pair up to even (mirror legs)', () => {
    expect(matchesPerPair(1)).toBe(2);
    expect(matchesPerPair(3)).toBe(4);
    expect(matchesPerPair(40)).toBe(40);
    expect(matchesPerPair(0)).toBe(2);
  });

  it('plays every config twice with the levels swapped, the same configs for every pair', () => {
    const o = opts({ matches: 6, pairs: [{ hi: 1, lo: 0 }, { hi: 5, lo: 4 }] });
    const specs = ladderSpecs(o);
    expect(specs).toHaveLength(12);
    specs.forEach((sp, i) => expect(sp.id).toBe(i));
    for (let k = 0; k < 6; k += 2) {
      const a = specs[k]!, b = specs[k + 1]!;
      expect(a.config).toEqual(b.config);
      expect(a.index).toBe(b.index);
      expect(a.hiTeam).toBe(0);
      expect(b.hiTeam).toBe(1);
      expect(a.levels).toEqual([1, 0]);
      expect(b.levels).toEqual([0, 1]);
      // The second pair plays the same configs.
      expect(specs[6 + k]!.config).toEqual(a.config);
      expect(specs[6 + k]!.levels).toEqual([5, 4]);
    }
    expect(new Set(specs.slice(0, 6).map((s) => s.config.seed)).size).toBe(3);
    for (const sp of specs) {
      expect(sp.levels[sp.hiTeam]).toBe(sp.hi);
      expect(sp.levels[1 - sp.hiTeam]).toBe(sp.lo);
      expect(sp.maxTicks).toBe(defaultMaxTicks(sp.config));
      expect(sp.partial).toBe(false);
      expect(sp.checker).toBe('none');
    }
  });

  it('configs are bot-v-bot, deterministic per (seed, index), same club both sides by default, mixed on request', () => {
    const base = { halfMinutes: 4, clubs: 'same' as const, cup: false };
    for (let i = 0; i < 20; i++) {
      const c = ladderConfig(1, i, base);
      expect(c).toEqual(ladderConfig(1, i, base));
      expect(c.homeClub).toBe(c.awayClub);
      expect(c.homeFormation).toBe(CLUBS[c.homeClub]!.formation);
      expect(c.humans.every((h) => h.kind === ControllerKind.NONE)).toBe(true);
      expect(c.mode).toBe(ModeId.KICK_OFF);
      expect(c.cupRules).toBe(0);
      expect(c.offside).toBe(1);
      expect(c.fouls).toBe(1);
      expect(c.halfMinutes).toBe(4);
      expect(c.startPhase).toBe(MatchPhase.KICK_OFF);
      const m = ladderConfig(1, i, { ...base, clubs: 'mixed', cup: true });
      expect(m.homeClub).not.toBe(m.awayClub);
      expect(m.awayFormation).toBe(CLUBS[m.awayClub]!.formation);
      expect(m.cupRules).toBe(1);
      expect(m.mode).toBe(ModeId.CUP);
    }
    expect(ladderConfig(1, 0, base).seed).not.toBe(ladderConfig(2, 0, base).seed);
    expect(ladderConfig(1, 0, base).seed).not.toBe(ladderConfig(1, 1, base).seed);
  });

  it('--max-ticks marks every match partial with that tick limit', () => {
    const specs = ladderSpecs(opts({ matches: 2, pairs: [{ hi: 3, lo: 2 }], maxTicks: 123 }));
    for (const sp of specs) {
      expect(sp.maxTicks).toBe(123);
      expect(sp.partial).toBe(true);
    }
  });
});

describe('TAI-12 ladder outcome and summary', () => {
  it('matchOutcome: forfeit, then score, then cup winner / shoot-out, else draw', () => {
    const s = makeScenario({ seed: 1 });
    expect(matchOutcome(s)).toEqual({ winner: -1, decidedBy: 'draw' });
    s.teams[1]!.goals = 2;
    expect(matchOutcome(s)).toEqual({ winner: 1, decidedBy: 'goals' });
    s.teams[0]!.goals = 3;
    expect(matchOutcome(s)).toEqual({ winner: 0, decidedBy: 'goals' });
    s.teams[1]!.goals = 3;
    s.match.shootout.winner = 1;
    expect(matchOutcome(s)).toEqual({ winner: 1, decidedBy: 'shootout' });
    s.match.winner = 0;
    expect(matchOutcome(s)).toEqual({ winner: 0, decidedBy: 'shootout' });
    s.match.forfeitTeam = 0;
    expect(matchOutcome(s)).toEqual({ winner: 1, decidedBy: 'forfeit' });
  });

  it('wilson: [0, 1] with no data, known values, always inside [0, 1] and around the rate', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
    const [lo, hi] = wilson(65, 100);
    expect(lo).toBeCloseTo(0.5525, 3);
    expect(hi).toBeCloseTo(0.7364, 3);
    for (const [k, n] of [[0, 10], [10, 10], [3, 7], [12.5, 20]] as const) {
      const [a, b] = wilson(k, n);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(k / n);
      expect(b).toBeGreaterThanOrEqual(k / n);
    }
  });

  function result(hiResult: LadderMatchResult['hiResult'], hiTeam: number, hiGoals = 0, loGoals = 0, decidedBy: LadderMatchResult['decidedBy'] = 'goals'): LadderMatchResult {
    return {
      id: 0, hi: 2, lo: 1, index: 0, hiTeam, seed: 1, homeClub: 0, awayClub: 0, goals: hiTeam === 0 ? [hiGoals, loGoals] : [loGoals, hiGoals],
      winner: -1, decidedBy, hiResult, hiGoals, loGoals, ticks: 1, finished: true, partial: false, levelsAtEnd: [2, 1],
      invariantFailures: 0, watchdogs: 0, wallMs: 1,
    };
  }

  it('summarizePair counts W/D/L for the higher level and computes every metric', () => {
    const rs = [
      ...Array.from({ length: 6 }, (_, i) => result('W', i & 1, 2, 0)),
      result('D', 0, 1, 1, 'draw'), result('D', 1, 0, 0, 'draw'),
      result('L', 0, 0, 1), result('W', 1, 1, 1, 'shootout'),
      { ...result('W', 0), hi: 5, lo: 4 }, // another pair: ignored
    ];
    const x = summarizePair({ hi: 2, lo: 1 }, rs, 'wins', 0.65);
    expect([x.n, x.wins, x.draws, x.losses, x.errors]).toEqual([10, 7, 2, 1, 0]);
    expect(x.winRate).toBeCloseTo(0.7, 12);
    expect(x.decisiveWinRate).toBeCloseTo(7 / 8, 12);
    expect(x.pointsShare).toBeCloseTo(0.8, 12);
    expect(x.value).toBe(x.winRate);
    expect([x.ciLo, x.ciHi]).toEqual(wilson(7, 10));
    expect(x.pass).toBe(true);
    expect(x.hiHomeWins + x.hiAwayWins).toBe(7);
    expect(x.hiAwayWins).toBe(4);
    expect(x.shootouts).toBe(1);
    expect(x.hiGoalsAvg).toBeCloseTo((6 * 2 + 1 + 0 + 0 + 1) / 10, 12);
    expect(x.loGoalsAvg).toBeCloseTo((1 + 0 + 1 + 1) / 10, 12);
    expect(x.name).toBe('Semi-Pro vs Amateur');
    expect(summarizePair({ hi: 2, lo: 1 }, rs, 'decisive', 0.65).value).toBeCloseTo(7 / 8, 12);
    expect(summarizePair({ hi: 2, lo: 1 }, rs, 'points', 0.65).value).toBeCloseTo(0.8, 12);
    expect(summarizePair({ hi: 2, lo: 1 }, rs, 'wins', 0.75).pass).toBe(false);
    expect(formatPair(x)).toMatch(/Semi-Pro vs Amateur .* W {3}7 D {3}2 L {3}1 .*wins 70\.0% .*PASS$/);
    expect(formatPair(summarizePair({ hi: 2, lo: 1 }, rs, 'wins', 0.75), false)).toMatch(/below target$/);
  });

  it('a failed match is not counted and fails the pair; no matches never passes', () => {
    const rs = [result('W', 0), result('W', 1), { ...result('E', 0), error: 'boom' }];
    const x = summarizePair({ hi: 2, lo: 1 }, rs, 'wins', 0.65);
    expect([x.n, x.wins, x.errors]).toEqual([2, 2, 1]);
    expect(x.pass).toBe(false);
    expect(formatPair(x)).toMatch(/FAIL \(1 failed match\(es\)\)$/);
    const none = summarizePair({ hi: 2, lo: 1 }, [], 'wins', 0.65);
    expect([none.n, none.value, none.pass]).toEqual([0, 0, false]);
  });
});

describe('TAI-12 ladder matches (real pipeline, short)', () => {
  it('runLadderMatch applies the per-team levels for the whole run and reports a counted result', () => {
    const [a, b] = ladderSpecs(opts({ matches: 2, pairs: [{ hi: 5, lo: 0 }], maxTicks: 400, checker: 'core' }));
    for (const sp of [a!, b!]) {
      const r = runLadderMatch(sp);
      expect(r.error).toBeUndefined();
      expect(r.levelsAtEnd).toEqual(sp.levels);
      expect(r.ticks).toBe(400);
      expect(r.partial).toBe(true);
      expect(['W', 'D', 'L']).toContain(r.hiResult);
      expect(r.hiGoals).toBe(r.goals[sp.hiTeam]);
      expect(r.invariantFailures).toBe(0);
    }
  });

  it('an unfinished full match, or a side without a CPU brain, is a failed match', () => {
    const [sp] = ladderSpecs(opts({ matches: 2, pairs: [{ hi: 1, lo: 0 }] }));
    const short = runLadderMatch({ ...sp!, maxTicks: 200 });
    expect(short.hiResult).toBe('E');
    expect(short.error).toMatch(/unfinished/);
    const human = { ...sp!.config, humans: [{ ...sp!.config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 }, sp!.config.humans[1]!] };
    const r = runLadderMatch({ ...sp!, config: human, maxTicks: 50, partial: true });
    expect(r.hiResult).toBe('E');
    expect(r.error).toMatch(/no CPU brain/);
  });

  it('runLadder in-process: one result per match, PASS line for a smoke run, JSON report', async () => {
    const json = join(TMP, 'inproc.json');
    const r = await runLadder(opts({ matches: 2, pairs: [{ hi: 3, lo: 2 }], workers: 0, maxTicks: 300, json }));
    expect(r.results).toHaveLength(2);
    expect(r.pairs).toHaveLength(1);
    expect(r.exitCode).toBe(0); // partial matches never enforce the target
    expect(r.lines.at(-2)).toMatch(/^RESULT: PASS .*target not enforced/);
    const rep = JSON.parse(readFileSync(json, 'utf8')) as { tool: string; ok: boolean; matches: unknown[]; pairs: { n: number }[] };
    expect(rep.tool).toBe('ladder');
    expect(rep.ok).toBe(true);
    expect(rep.matches).toHaveLength(2);
    expect(rep.pairs[0]!.n).toBe(2);
  });
});

describe('TAI-12 ladder CLI', () => {
  it('runs bot-v-bot matches on worker threads and reports per-pair lines and a result', () => {
    const json = join(TMP, 'cli.json');
    const r = tsx(['tools/ladder.ts', '--matches', '2', '--pairs', '0,5:0', '--workers', '2', '--max-ticks', '300', '--json', json]);
    expect(r.out).toContain('2 worker(s)');
    expect(r.out).toMatch(/Amateur vs Beginner +n {3}2 /);
    expect(r.out).toMatch(/Legend vs Beginner +n {3}2 /);
    expect(r.out).toMatch(/RESULT: PASS/);
    expect(r.code).toBe(0);
    const rep = JSON.parse(readFileSync(json, 'utf8')) as { matches: LadderMatchResult[] };
    expect(rep.matches).toHaveLength(4);
    for (const m of rep.matches) {
      expect(m.error).toBeUndefined();
      expect(m.levelsAtEnd[m.hiTeam]).toBe(m.hi);
      expect(m.levelsAtEnd[1 - m.hiTeam]).toBe(m.lo);
    }
  }, 240_000);

  it('a hung match (time limit exceeded) fails the run instead of hanging it', () => {
    const r = tsx(['tools/ladder.ts', '--matches', '2', '--pairs', '0', '--workers', '1', '--job-timeout', '0.001']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/timed out/);
    expect(r.out).toMatch(/RESULT: FAIL/);
  }, 240_000);

  it('bad flags exit 2 with the usage; --help exits 0', () => {
    const bad = tsx(['tools/ladder.ts', '--matchez', '3']);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('unknown flag --matchez');
    expect(bad.out).toContain('usage: tsx tools/ladder.ts');
    const help = tsx(['tools/ladder.ts', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('usage: tsx tools/ladder.ts');
  }, 120_000);
});

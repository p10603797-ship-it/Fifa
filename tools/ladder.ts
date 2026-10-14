/**
 * [TAI-12] Difficulty ladder runner (BRIEF section 7 target: "Each level beats the one below in 65% or more of
 * bot-v-bot matches"). For every level pair it plays N headless bot-v-bot matches with tools/headless.ts runMatch,
 * the higher level on one side and the lower level on the other, and prints win / draw / loss counts, win rates with
 * a 95% Wilson interval, and a PASS / FAIL verdict per pair against the target. Used by QA-19.
 *
 *   npx tsx tools/ladder.ts [--matches 40] [--pairs 0,1,2,3,4 | 5:0,3:2] [--workers 4] [--seed 1] [--halfMinutes 4]
 *                           [--clubs same|mixed] [--cup] [--metric wins|decisive|points] [--target 0.65]
 *                           [--checker none|core|all] [--max-ticks T] [--job-timeout S] [--json out.json]
 *                           [--no-enforce] [--quiet]
 *
 * Fairness: every config (seed, clubs, formations) is played twice, once with the higher level at home and once
 * away (mirror legs), so kick-off, home side and club strength cancel out; --matches is rounded up to even. With
 * --clubs same (default) both sides are the same club (its preferred formation and style), so the difficulty is the
 * only difference between the teams; --clubs mixed draws two different clubs per config.
 * Per-team levels: MatchConfig has one difficulty for both CPU sides, so the runner sets s.teams[t].cpu.level before
 * every tick (the same as a per-team config; nothing else in the state is touched) and checks at the end that the
 * levels were still in place.
 * Outcome: a forfeit, else the score, else (with --cup: extra time and shoot-out) match.winner / shootout.winner,
 * else a draw. Metrics (n = matches without errors): wins = W / n (the literal reading of the target, the default),
 * decisive = W / (W + L), points = (W + D / 2) / n.
 * Exit code 0 when every pair meets the target (or --no-enforce) and no match failed (exception, unfinished match,
 * lost level override, crashed or hung worker); 1 otherwise; 2 for bad flags. With --max-ticks matches stop early
 * and count by the score at the stop: such a smoke run never enforces the target.
 * --workers 0 runs the matches in this thread (no worker threads).
 */
import './lib/env';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Difficulty, KitSlot, MatchPhase, ModeId } from '../src/contracts/enums';
import { createMatchConfig, type MatchConfig, type SimState } from '../src/contracts/state';
import { CLUBS } from '../src/data/clubs';
import { defaultMaxTicks, runMatch, type CheckerMode } from './headless';
import { bool, num, parseArgs, str } from './lib/args';
import { noHuman } from './lib/configs';
import { defaultWorkers, poolSize } from './lib/pool';
import { createRng, mix32, rngInt } from './lib/rand';
import { writeJson } from './lib/report';

export const LEVEL_NAMES: readonly string[] = ['Beginner', 'Amateur', 'Semi-Pro', 'Professional', 'World Class', 'Legend'];
const LEVEL_MAX = Difficulty.LEGEND;

export type LadderMetric = 'wins' | 'decisive' | 'points';
export type ClubMode = 'same' | 'mixed';

/** One level pair: `hi` (the stronger level) against `lo`. */
export interface LevelPair { hi: number; lo: number }

export interface LadderOptions {
  /** Matches per pair (rounded up to even: mirror legs). */
  matches: number;
  pairs: LevelPair[];
  /** Worker threads; 0 = run in this thread. */
  workers: number;
  seed: number;
  /** Real minutes per half, 2..10. */
  halfMinutes: number;
  clubs: ClubMode;
  /** Cup rules: extra time and a shoot-out decide level matches. */
  cup: boolean;
  metric: LadderMetric;
  /** Target share (0..1) of the metric for the higher level. */
  target: number;
  checker: CheckerMode;
  /** Tick limit per match (smoke runs); null = the full match (headless defaultMaxTicks). */
  maxTicks: number | null;
  /** Fixed per-match time limit in seconds (0 = none); null = derived from the tick limit. */
  jobTimeoutSeconds: number | null;
  json: string | null;
  /** Exit 1 when a pair misses the target. */
  enforce: boolean;
  quiet: boolean;
}

export function defaultLadderOptions(): LadderOptions {
  return {
    matches: 40, pairs: adjacentPairs(), workers: defaultWorkers(), seed: 1, halfMinutes: 4, clubs: 'same', cup: false,
    metric: 'wins', target: 0.65, checker: 'none', maxTicks: null, jobTimeoutSeconds: null, json: null, enforce: true,
    quiet: false,
  };
}

/** Every adjacent pair, Amateur vs Beginner .. Legend vs World Class. */
export function adjacentPairs(): LevelPair[] {
  const out: LevelPair[] = [];
  for (let lo = 0; lo < LEVEL_MAX; lo++) out.push({ hi: lo + 1, lo });
  return out;
}

export function levelName(level: number): string {
  return LEVEL_NAMES[level] ?? `level ${level}`;
}

export function pairName(p: LevelPair): string {
  return `${levelName(p.hi)} vs ${levelName(p.lo)}`;
}

function isLevel(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= LEVEL_MAX;
}

/** "0,1,4" (adjacent pairs by their lower level), "5:0" (hi:lo), "all"; mixed lists allowed. */
export function parsePairs(text: string): LevelPair[] {
  const t = text.trim();
  if (t === 'all' || t === '') return adjacentPairs();
  const out: LevelPair[] = [];
  for (const raw of t.split(',')) {
    const tok = raw.trim();
    if (tok === '') continue;
    const m = /^(\d+)(?::(\d+))?$/.exec(tok);
    if (!m) throw new Error(`--pairs: bad token "${tok}" (use L for L+1 vs L, or H:L)`);
    const a = Number(m[1]);
    if (m[2] === undefined) {
      if (!isLevel(a) || a >= LEVEL_MAX) throw new Error(`--pairs: lower level ${a} out of range 0..${LEVEL_MAX - 1}`);
      out.push({ hi: a + 1, lo: a });
    } else {
      const b = Number(m[2]);
      if (!isLevel(a) || !isLevel(b) || a <= b) throw new Error(`--pairs: "${tok}" needs H:L with ${LEVEL_MAX} >= H > L >= 0`);
      out.push({ hi: a, lo: b });
    }
  }
  if (out.length === 0) throw new Error('--pairs: no pair given');
  return out;
}

const SPEC = {
  matches: 'number', pairs: 'string', workers: 'number', seed: 'number', halfMinutes: 'number', clubs: 'string',
  cup: 'boolean', metric: 'string', target: 'number', checker: 'string', 'max-ticks': 'number', 'job-timeout': 'number',
  json: 'string', 'no-enforce': 'boolean', quiet: 'boolean', help: 'boolean',
} as const;

export const LADDER_USAGE = 'usage: tsx tools/ladder.ts [--matches N] [--pairs 0,1,2,3,4|H:L,...|all] [--workers W (0 = in-process)] ' +
  '[--seed S] [--halfMinutes M] [--clubs same|mixed] [--cup] [--metric wins|decisive|points] [--target 0.65] ' +
  '[--checker none|core|all] [--max-ticks T] [--job-timeout S] [--json out.json] [--no-enforce] [--quiet]';

/** Options from CLI flags; throws on unknown flags or bad values. Returns null for --help. */
export function ladderOptionsFromArgs(argv: readonly string[]): LadderOptions | null {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (bool(flags, 'help')) return null;
  if (positionals.length > 0) throw new Error(`unexpected argument "${positionals[0]}"`);
  const d = defaultLadderOptions();
  const clubs = str(flags, 'clubs', d.clubs);
  if (clubs !== 'same' && clubs !== 'mixed') throw new Error(`--clubs must be same or mixed, got ${clubs}`);
  const metric = str(flags, 'metric', d.metric);
  if (metric !== 'wins' && metric !== 'decisive' && metric !== 'points') {
    throw new Error(`--metric must be wins, decisive or points, got ${metric}`);
  }
  const checker = str(flags, 'checker', d.checker);
  if (checker !== 'none' && checker !== 'core' && checker !== 'all') throw new Error(`--checker must be none, core or all, got ${checker}`);
  const target = num(flags, 'target', d.target);
  if (!(target > 0 && target <= 1)) throw new Error(`--target must be in (0, 1], got ${target}`);
  const maxTicks = flags['max-ticks'];
  const jobTimeout = flags['job-timeout'];
  return {
    matches: Math.max(1, Math.floor(num(flags, 'matches', d.matches))),
    pairs: typeof flags.pairs === 'string' ? parsePairs(flags.pairs) : d.pairs,
    workers: Math.max(0, Math.floor(num(flags, 'workers', d.workers))),
    seed: num(flags, 'seed', d.seed) >>> 0,
    halfMinutes: Math.max(2, Math.min(10, Math.floor(num(flags, 'halfMinutes', d.halfMinutes)))),
    clubs,
    cup: bool(flags, 'cup'),
    metric,
    target,
    checker,
    maxTicks: typeof maxTicks === 'number' ? Math.max(1, Math.floor(maxTicks)) : null,
    jobTimeoutSeconds: typeof jobTimeout === 'number' ? Math.max(0, jobTimeout) : null,
    json: typeof flags.json === 'string' ? flags.json : null,
    enforce: !bool(flags, 'no-enforce'),
    quiet: bool(flags, 'quiet'),
  };
}

// ---------------------------------------------------------------- match plan

/**
 * Config `index` of a ladder run: deterministic from (seed, index) and independent of the level pair, so every pair
 * plays the same set of configs. Bot-v-bot, offside and fouls on, no replays; the difficulty field is overridden
 * per team by the runner.
 */
export function ladderConfig(seed: number, index: number, o: Pick<LadderOptions, 'halfMinutes' | 'clubs' | 'cup'>): MatchConfig {
  const r = createRng(mix32(seed ^ 0x1add3e, index));
  const c = createMatchConfig();
  c.seed = mix32(seed ^ 0x5eed12, index);
  const n = CLUBS.length;
  c.homeClub = rngInt(r, n);
  c.awayClub = o.clubs === 'same' || n < 2 ? c.homeClub : (c.homeClub + 1 + rngInt(r, n - 1)) % n;
  c.homeFormation = CLUBS[c.homeClub]!.formation;
  c.awayFormation = CLUBS[c.awayClub]!.formation;
  c.homeKit = KitSlot.HOME;
  c.awayKit = KitSlot.AWAY;
  c.halfMinutes = o.halfMinutes;
  c.cupRules = o.cup ? 1 : 0;
  c.mode = o.cup ? ModeId.CUP : ModeId.KICK_OFF;
  c.offside = 1;
  c.fouls = 1;
  c.night = 0;
  c.replaySeconds = 0;
  c.difficulty = Difficulty.PROFESSIONAL;
  c.humans = [noHuman(), noHuman()];
  c.startPhase = MatchPhase.KICK_OFF;
  return c;
}

export interface LadderMatchSpec {
  /** Position in the run (0..n-1). */
  id: number;
  hi: number;
  lo: number;
  /** Config index; the two mirror legs share it. */
  index: number;
  /** Team (0 home, 1 away) playing at the higher level. */
  hiTeam: number;
  /** CPU level per team [home, away]. */
  levels: [number, number];
  config: MatchConfig;
  maxTicks: number;
  /** Stopping at maxTicks is expected (smoke run): the score at the stop counts. */
  partial: boolean;
  checker: CheckerMode;
}

/** Matches per pair actually played (rounded up to even). */
export function matchesPerPair(matches: number): number {
  const m = Math.max(1, Math.floor(matches));
  return m + (m % 2);
}

/** Every match of a run, pair by pair; leg k of a pair uses config k >> 1 with the higher level at home when k is even. */
export function ladderSpecs(o: LadderOptions): LadderMatchSpec[] {
  const per = matchesPerPair(o.matches);
  const out: LadderMatchSpec[] = [];
  for (const p of o.pairs) {
    for (let k = 0; k < per; k++) {
      const index = k >> 1;
      const hiTeam = k & 1;
      const config = ladderConfig(o.seed, index, o);
      out.push({
        id: out.length, hi: p.hi, lo: p.lo, index, hiTeam, levels: hiTeam === 0 ? [p.hi, p.lo] : [p.lo, p.hi], config,
        maxTicks: o.maxTicks ?? defaultMaxTicks(config), partial: o.maxTicks !== null, checker: o.checker,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- one match

export type HiResult = 'W' | 'D' | 'L' | 'E';
export type DecidedBy = 'goals' | 'shootout' | 'forfeit' | 'draw' | 'error';

export interface LadderMatchResult {
  id: number;
  hi: number;
  lo: number;
  index: number;
  hiTeam: number;
  seed: number;
  homeClub: number;
  awayClub: number;
  /** Final score [home, away]. */
  goals: [number, number];
  /** Winning team (0 / 1), -1 for a draw or an error. */
  winner: number;
  decidedBy: DecidedBy;
  /** Result for the higher level; 'E' = the match failed (not counted). */
  hiResult: HiResult;
  hiGoals: number;
  loGoals: number;
  ticks: number;
  finished: boolean;
  partial: boolean;
  /** s.teams[t].cpu.level at the end (must equal the spec's levels). */
  levelsAtEnd: [number, number];
  invariantFailures: number;
  watchdogs: number;
  wallMs: number;
  error?: string;
}

function baseResult(spec: LadderMatchSpec): LadderMatchResult {
  return {
    id: spec.id, hi: spec.hi, lo: spec.lo, index: spec.index, hiTeam: spec.hiTeam, seed: spec.config.seed >>> 0,
    homeClub: spec.config.homeClub, awayClub: spec.config.awayClub, goals: [0, 0], winner: -1, decidedBy: 'error',
    hiResult: 'E', hiGoals: 0, loGoals: 0, ticks: 0, finished: false, partial: spec.partial, levelsAtEnd: [-1, -1],
    invariantFailures: 0, watchdogs: 0, wallMs: 0,
  };
}

/** A failed match (crashed / hung worker, bad spec). */
export function errorResult(spec: LadderMatchSpec, message: string): LadderMatchResult {
  return { ...baseResult(spec), error: message };
}

function setLevels(s: SimState, levels: readonly [number, number]): void {
  s.teams[0]!.cpu.level = levels[0] as Difficulty;
  s.teams[1]!.cpu.level = levels[1] as Difficulty;
}

function teamOrNone(v: number): number {
  return v === 0 || v === 1 ? v : -1;
}

/** Winner (0 / 1 / -1) and how it was decided, from the final state of a match that ran. */
export function matchOutcome(s: SimState): { winner: number; decidedBy: DecidedBy } {
  const forfeit = teamOrNone(s.match.forfeitTeam);
  if (forfeit >= 0) return { winner: 1 - forfeit, decidedBy: 'forfeit' };
  const g0 = s.teams[0]!.goals;
  const g1 = s.teams[1]!.goals;
  if (g0 !== g1) return { winner: g0 > g1 ? 0 : 1, decidedBy: 'goals' };
  const w = teamOrNone(s.match.winner) >= 0 ? s.match.winner : teamOrNone(s.match.shootout.winner);
  if (w >= 0) return { winner: w, decidedBy: 'shootout' };
  return { winner: -1, decidedBy: 'draw' };
}

/** Play one ladder match in this thread (never throws). */
export function runLadderMatch(spec: LadderMatchSpec): LadderMatchResult {
  const t0 = performance.now();
  const res = baseResult(spec);
  try {
    const levels = spec.levels;
    let noBrain = -1;
    const r = runMatch({
      config: spec.config, checker: spec.checker, fastCutscenes: true, maxTicks: spec.maxTicks,
      inputs: (_tick, s) => {
        if (s.teams[0]!.cpu.active !== 1) noBrain = 0;
        else if (s.teams[1]!.cpu.active !== 1) noBrain = 1;
        setLevels(s, levels);
      },
    });
    const s = r.state;
    res.ticks = r.ticks;
    res.finished = r.finished;
    res.goals = [s.teams[0]!.goals, s.teams[1]!.goals];
    res.levelsAtEnd = [s.teams[0]!.cpu.level, s.teams[1]!.cpu.level];
    res.invariantFailures = r.invariantFailures.count;
    res.watchdogs = r.watchdogs;
    res.hiGoals = res.goals[spec.hiTeam]!;
    res.loGoals = res.goals[1 - spec.hiTeam]!;
    let error: string | null = null;
    if (r.exception) error = `exception in ${r.exception.where} at t=${r.exception.tick}: ${r.exception.message}`;
    else if (noBrain >= 0) error = `team ${noBrain} has no CPU brain (not a bot-v-bot config)`;
    else if (res.levelsAtEnd[0] !== levels[0] || res.levelsAtEnd[1] !== levels[1]) {
      error = `level override lost: levels at the end ${res.levelsAtEnd.join('/')}, expected ${levels.join('/')}`;
    } else if (!r.finished && !spec.partial) {
      error = `unfinished: ended in ${MatchPhase[r.endPhase] ?? r.endPhase} after ${r.ticks} ticks`;
    } else if (spec.checker !== 'none' && r.invariantFailures.count > 0) {
      error = `invariants (${spec.checker}): ${r.invariantFailures.count} failure(s): ${r.invariantFailures.first[0] ?? ''}`;
    }
    if (error !== null) {
      res.error = error;
    } else {
      const o = matchOutcome(s);
      res.winner = o.winner;
      res.decidedBy = o.decidedBy;
      res.hiResult = o.winner < 0 ? 'D' : o.winner === spec.hiTeam ? 'W' : 'L';
    }
  } catch (err) {
    res.error = `runner: ${err instanceof Error ? err.message : String(err)}`;
    res.hiResult = 'E';
    res.decidedBy = 'error';
  }
  res.wallMs = performance.now() - t0;
  return res;
}

// ---------------------------------------------------------------- summary

/** 95% Wilson score interval of k successes in n trials (k may be fractional: draws as halves). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface PairSummary {
  hi: number;
  lo: number;
  name: string;
  /** Matches counted (without errors). */
  n: number;
  errors: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  decisiveWinRate: number;
  pointsShare: number;
  metric: LadderMetric;
  /** The chosen metric and its 95% Wilson interval. */
  value: number;
  ciLo: number;
  ciHi: number;
  target: number;
  pass: boolean;
  /** Average goals per match of the higher / lower level. */
  hiGoalsAvg: number;
  loGoalsAvg: number;
  shootouts: number;
  /** Wins of the higher level at home / away. */
  hiHomeWins: number;
  hiAwayWins: number;
  partial: boolean;
}

export function summarizePair(p: LevelPair, results: readonly LadderMatchResult[], metric: LadderMetric, target: number): PairSummary {
  let wins = 0, draws = 0, losses = 0, errors = 0, hiG = 0, loG = 0, shootouts = 0, homeW = 0, awayW = 0;
  let partial = false;
  for (const r of results) {
    if (r.hi !== p.hi || r.lo !== p.lo) continue;
    if (r.partial) partial = true;
    if (r.hiResult === 'E') { errors++; continue; }
    hiG += r.hiGoals;
    loG += r.loGoals;
    if (r.decidedBy === 'shootout') shootouts++;
    if (r.hiResult === 'W') {
      wins++;
      if (r.hiTeam === 0) homeW++; else awayW++;
    } else if (r.hiResult === 'D') draws++;
    else losses++;
  }
  const n = wins + draws + losses;
  const winRate = n > 0 ? wins / n : 0;
  const decisive = wins + losses > 0 ? wins / (wins + losses) : 0;
  const points = n > 0 ? (wins + draws / 2) / n : 0;
  let value: number, ci: [number, number];
  if (metric === 'decisive') { value = decisive; ci = wilson(wins, wins + losses); }
  else if (metric === 'points') { value = points; ci = wilson(wins + draws / 2, n); }
  else { value = winRate; ci = wilson(wins, n); }
  return {
    hi: p.hi, lo: p.lo, name: pairName(p), n, errors, wins, draws, losses, winRate, decisiveWinRate: decisive,
    pointsShare: points, metric, value, ciLo: ci[0], ciHi: ci[1], target, pass: errors === 0 && n > 0 && value >= target,
    hiGoalsAvg: n > 0 ? hiG / n : 0, loGoalsAvg: n > 0 ? loG / n : 0, shootouts, hiHomeWins: homeW, hiAwayWins: awayW,
    partial,
  };
}

export function summarizeLadder(results: readonly LadderMatchResult[], o: Pick<LadderOptions, 'pairs' | 'metric' | 'target'>): PairSummary[] {
  return o.pairs.map((p) => summarizePair(p, results, o.metric, o.target));
}

function pct(v: number): string {
  return `${(100 * v).toFixed(1)}%`;
}

/** One report line; `enforced` false (smoke runs, --no-enforce) words the verdict as meets / below target. */
export function formatPair(x: PairSummary, enforced = true): string {
  const ci = `[${(100 * x.ciLo).toFixed(1)}-${(100 * x.ciHi).toFixed(1)}]`;
  const met = x.n > 0 && x.value >= x.target;
  const verdict = x.errors > 0 ? `FAIL (${x.errors} failed match(es))` : enforced ? (met ? 'PASS' : 'FAIL') : (met ? 'meets target' : 'below target');
  return `  ${x.name.padEnd(28)} n ${String(x.n).padStart(3)}  W ${String(x.wins).padStart(3)} D ${String(x.draws).padStart(3)} ` +
    `L ${String(x.losses).padStart(3)}  ${x.metric} ${pct(x.value)} ${ci} (target ${pct(x.target)})  ` +
    `wins ${pct(x.winRate)}  decisive ${pct(x.decisiveWinRate)}  points ${pct(x.pointsShare)}  ` +
    `goals ${x.hiGoalsAvg.toFixed(2)}-${x.loGoalsAvg.toFixed(2)}  home/away wins ${x.hiHomeWins}/${x.hiAwayWins}` +
    `${x.shootouts > 0 ? `  shoot-outs ${x.shootouts}` : ''}  ${verdict}`;
}

// ---------------------------------------------------------------- worker threads

const WORKER_FLAG = 'tai12LadderWorker';

type ToWorker = { type: 'match'; spec: LadderMatchSpec } | { type: 'stop' };
type FromWorker = { type: 'ready' } | { type: 'result'; result: LadderMatchResult };

/**
 * Worker entry as a data: URL module: worker threads do not inherit tsx's loader hooks, so it registers tsx (by
 * absolute URL: a data: module cannot resolve bare specifiers) and then imports this file, which starts the worker
 * loop when it finds WORKER_FLAG in workerData.
 */
function workerBootUrl(): URL {
  const api = import.meta.resolve('tsx/esm/api');
  const code = `import { register } from ${JSON.stringify(api)};\nregister();\nawait import(${JSON.stringify(import.meta.url)});\n`;
  return new URL(`data:text/javascript,${encodeURIComponent(code)}`);
}

function startWorker(): void {
  const port = parentPort;
  if (!port) return;
  port.on('message', (m: ToWorker) => {
    if (m.type === 'stop') process.exit(0);
    let result: LadderMatchResult;
    try {
      result = runLadderMatch(m.spec);
    } catch (err) {
      result = errorResult(m.spec, `worker: ${err instanceof Error ? err.message : String(err)}`);
    }
    port.postMessage({ type: 'result', result } satisfies FromWorker);
  });
  port.postMessage({ type: 'ready' } satisfies FromWorker);
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[WORKER_FLAG] === true) startWorker();

export type ResultFn = (r: LadderMatchResult, done: number, total: number) => void;

/** Default per-match time limit: a minute plus 3 ms per tick of the limit (shared, slow CPUs). */
function timeoutMs(o: Pick<LadderOptions, 'jobTimeoutSeconds'>, spec: LadderMatchSpec): number {
  if (o.jobTimeoutSeconds !== null) return o.jobTimeoutSeconds * 1000;
  return 60_000 + 3 * spec.maxTicks;
}

/**
 * Run the specs on W worker threads; resolves with one result per spec in spec order (never rejects). A worker that
 * crashes or exceeds its match's time limit turns that match into an error result and is replaced; when no worker
 * can start at all the remaining matches fail as "not run".
 */
export function runOnWorkers(specs: readonly LadderMatchSpec[], o: Pick<LadderOptions, 'workers' | 'jobTimeoutSeconds'>, onResult?: ResultFn): Promise<LadderMatchResult[]> {
  const results: LadderMatchResult[] = new Array<LadderMatchResult>(specs.length);
  const total = specs.length;
  let next = 0, done = 0, live = 0, bootFailures = 0, settled = false;
  let lastBootError = '';
  const n = poolSize(Math.max(1, o.workers), total);
  const maxBootFailures = 2 * n;
  return new Promise((resolve) => {
    if (total === 0) { resolve(results); return; }
    const finish = (spec: LadderMatchSpec, r: LadderMatchResult): void => {
      if (results[spec.id] !== undefined) return;
      results[spec.id] = r;
      done++;
      onResult?.(r, done, total);
    };
    const settle = (): void => {
      if (settled) return;
      if (live === 0 && done < total) {
        while (next < total) {
          const sp = specs[next++]!;
          finish(sp, errorResult(sp, `not run: no worker thread could start (${bootFailures} boot failure(s)): ${lastBootError || 'unknown error'}`));
        }
      }
      if (live === 0 && done >= total) {
        settled = true;
        resolve(results);
      }
    };
    let url: URL | null = null;
    try {
      url = workerBootUrl();
    } catch (err) {
      lastBootError = `cannot build the worker entry: ${err instanceof Error ? err.message : String(err)}`;
    }
    const spawn = (): void => {
      live++;
      let w: Worker;
      try {
        if (url === null) throw new Error(lastBootError);
        w = new Worker(url, { workerData: { [WORKER_FLAG]: true } });
      } catch (err) {
        live--;
        bootFailures++;
        lastBootError = err instanceof Error ? err.message : String(err);
        if (url !== null && bootFailures <= maxBootFailures && next < total) spawn();
        else settle();
        return;
      }
      let ready = false;
      let closed = false;
      let current: LadderMatchSpec | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clearTimer = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
      const close = (why: string | null): void => {
        if (closed) return;
        closed = true;
        clearTimer();
        live--;
        if (!ready) {
          bootFailures++;
          lastBootError = why ?? 'worker exited before it was ready';
          if (bootFailures <= maxBootFailures && next < total) spawn();
        } else if (current) {
          finish(current, errorResult(current, `worker: ${why ?? 'exited'}`));
          current = null;
          if (next < total) spawn();
        }
        settle();
      };
      const feed = (): void => {
        if (next < total) {
          const spec = specs[next++]!;
          current = spec;
          w.postMessage({ type: 'match', spec } satisfies ToWorker);
          const ms = timeoutMs(o, spec);
          if (ms > 0) {
            timer = setTimeout(() => {
              timer = null;
              close(`match timed out after ${+(ms / 1000).toFixed(1)} s (hung or far too slow); its worker was terminated`);
              void w.terminate();
            }, ms);
          }
        } else {
          current = null;
          w.postMessage({ type: 'stop' } satisfies ToWorker);
        }
      };
      w.on('message', (m: FromWorker) => {
        if (closed) return;
        if (m.type === 'ready') {
          ready = true;
          feed();
          return;
        }
        clearTimer();
        if (current) finish(current, m.result);
        current = null;
        feed();
      });
      w.on('error', (err) => close(err instanceof Error ? err.message : String(err)));
      w.on('exit', (code) => close(current || !ready ? `worker exited with code ${code}` : null));
    };
    for (let i = 0; i < n; i++) spawn();
  });
}

/** Run the specs one after another in this thread. */
export function runInProcess(specs: readonly LadderMatchSpec[], onResult?: ResultFn): LadderMatchResult[] {
  const out: LadderMatchResult[] = [];
  for (const spec of specs) {
    const r = runLadderMatch(spec);
    out.push(r);
    onResult?.(r, out.length, specs.length);
  }
  return out;
}

// ---------------------------------------------------------------- run

export interface LadderResult {
  exitCode: number;
  ok: boolean;
  pairs: PairSummary[];
  results: LadderMatchResult[];
  lines: string[];
}

function configText(r: LadderMatchResult, o: LadderOptions): string {
  return `seed ${r.seed} config #${r.index} clubs ${r.homeClub}v${r.awayClub} levels ${r.hiTeam === 0 ? `${r.hi}/${r.lo}` : `${r.lo}/${r.hi}`}` +
    ` (re-run: npx tsx tools/ladder.ts --pairs ${r.hi}:${r.lo} --seed ${o.seed} --matches ${2 * (r.index + 1)} --halfMinutes ${o.halfMinutes}` +
    ` --clubs ${o.clubs}${o.cup ? ' --cup' : ''} --workers 0)`;
}

export async function runLadder(o: LadderOptions): Promise<LadderResult> {
  const t0 = performance.now();
  const lines: string[] = [];
  const log = (s: string): void => {
    lines.push(s);
    if (!o.quiet) console.log(s);
  };
  const specs = ladderSpecs(o);
  const per = matchesPerPair(o.matches);
  const workers = o.workers === 0 ? 0 : poolSize(o.workers, specs.length);
  log(`DotKick difficulty ladder: ${o.pairs.length} pair(s) x ${per} match(es) (mirror legs), ${o.halfMinutes}-minute halves, ` +
    `clubs ${o.clubs}, cup ${o.cup ? 'on' : 'off'}, metric ${o.metric} >= ${pct(o.target)}, ` +
    `${workers === 0 ? 'in-process' : `${workers} worker(s)`}, seed ${o.seed}, checker ${o.checker}` +
    `${o.maxTicks !== null ? `, partial matches (--max-ticks ${o.maxTicks}): target not enforced` : ''}`);
  const step = Math.max(1, Math.floor(specs.length / 20));
  const progress: ResultFn = (r, done, total) => {
    if (!o.quiet && total > 10 && (done % step === 0 || done === total)) {
      console.log(`  [${done}/${total}] ${((performance.now() - t0) / 1000).toFixed(1)} s, last ${levelName(r.hi)} vs ${levelName(r.lo)} ${r.hiResult}`);
    }
  };
  const results = workers === 0 ? runInProcess(specs, progress) : await runOnWorkers(specs, { workers, jobTimeoutSeconds: o.jobTimeoutSeconds }, progress);
  const pairs = summarizeLadder(results, o);
  const enforceTarget = o.enforce && o.maxTicks === null;
  for (const x of pairs) log(formatPair(x, enforceTarget));
  const failed = results.filter((r) => r.hiResult === 'E');
  if (failed.length > 0) {
    log(`  failed matches (${failed.length}):`);
    for (const r of failed.slice(0, 20)) log(`    #${r.id} ${levelName(r.hi)} vs ${levelName(r.lo)}: ${r.error ?? 'error'}; ${configText(r, o)}`);
    if (failed.length > 20) log(`    ... ${failed.length - 20} more`);
  }
  const targetsMet = pairs.every((x) => x.n > 0 && x.value >= x.target);
  const ok = failed.length === 0 && (targetsMet || !enforceTarget);
  const secs = (performance.now() - t0) / 1000;
  const met = pairs.filter((x) => x.n > 0 && x.value >= x.target).length;
  log(`RESULT: ${ok ? 'PASS' : 'FAIL'} (${met}/${pairs.length} pair(s) meet the target${enforceTarget ? '' : ', target not enforced'}` +
    `${failed.length > 0 ? `, ${failed.length} failed match(es)` : ''}) in ${secs.toFixed(1)} s`);
  if (o.json) {
    writeJson(o.json, { tool: 'ladder', options: o, ok, seconds: secs, pairs, matches: results });
    log(`  json report: ${o.json}`);
  }
  return { exitCode: ok ? 0 : 1, ok, pairs, results, lines };
}

const invokedDirectly = isMainThread && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Safety net: if the run never settles and the event loop empties, exit 1 with a FAIL line, never a silent 0.
  process.exitCode = 1;
  process.once('beforeExit', () => console.log('RESULT: FAIL (the ladder stopped before every match reported)'));
  let opts: LadderOptions | null;
  try {
    opts = ladderOptionsFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error(LADDER_USAGE);
    process.exit(2);
  }
  if (opts === null) {
    console.log(LADDER_USAGE);
    process.exit(0);
  }
  runLadder(opts).then(
    (r) => process.exit(r.exitCode),
    (err: unknown) => { console.error(err); process.exit(1); },
  );
}

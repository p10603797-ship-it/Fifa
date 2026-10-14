/**
 * [DAT-05] Rating balance runner and attribute audit (BRIEF section 15: "Balance check by simulation over 200 matches:
 * an 88-rated club beats a 62-rated club at least 80% of the time, and equal clubs split close to evenly." and
 * "Every attribute must visibly change play. Delete any that does not.").
 *
 * BALANCE (default mode). CPU vs CPU at one difficulty (default Professional) through tools/headless.ts runMatch, N
 * matches per matchup (default 200), each club in its preferred formation, offside and fouls on, no replays:
 *   top-bottom  the highest-rated club (A) vs the lowest-rated (B). Target: A wins >= --top-target (0.80) of the
 *               matches (wins / n, the literal reading of the brief; draws are not wins).
 *   equal       the two different clubs with the closest ratings (ties: the pair nearest the median rating, then the
 *               lower ids). Target: A's points share (W + D/2) / n within 0.5 +- --even-tol (0.10).
 *   mirror      the median-rated club against itself (A = the home side). Target: the home points share within
 *               0.5 +- --even-tol (side / kick-off bias; the only exactly equal pairing).
 * Fairness: top-bottom and equal play every config twice (mirror legs: same seed, A at home then away), so home side
 * and kick-off cancel; --matches is rounded up to even for them. The mirror suite gives every match its own seed (a
 * mirror leg of a club against itself would replay the identical match).
 * Outcome per match: a forfeit, else the score, else (with --cup) the extra-time / shoot-out winner, else a draw.
 * Exit code 0 when every matchup meets its target and no match failed; 1 otherwise (a failed match: exception,
 * unfinished match, invariant failure with a checker on, crashed or hung worker); 2 for bad flags. --no-enforce and
 * --max-ticks (smoke runs: matches stop early and count by the score at the stop) only report the targets.
 * WARN lines (advisory, never change the verdict) flag matchups with more than WARN_DRAW_RATE draws or fewer than
 * WARN_GOALS_PER_MATCH goals per match: an evenness PASS built on 0-0 draws says little.
 *
 *   npx tsx tools/balance.ts [--matches 200] [--suite all|top-bottom,equal,mirror] [--workers 4] [--seed 1]
 *                            [--halfMinutes 4] [--difficulty 3] [--cup] [--top-target 0.8] [--even-tol 0.1]
 *                            [--top CODE|ID] [--bottom CODE|ID] [--equal A,B] [--mirror CODE|ID]
 *                            [--checker none|core|all] [--max-ticks T] [--job-timeout S] [--json out.json]
 *                            [--no-enforce] [--quiet]
 *
 * ATTRIBUTE AUDIT (static half; the dynamic half is tests/sim/dat-05-attributes.test.ts):
 *   npx tsx tools/balance.ts --audit [--verbose] [--write-doc docs/ATTRIBUTE_AUDIT.md]
 * Type-aware (TypeScript compiler API, not a text grep): every read of a PlayerAttrs / PlayerData property in
 * src/sim and src/ai (property access, element access with a literal key, destructuring), so PlayerState.stamina
 * (the condition) or ActionRequest.curve never count as attribute reads. Reads of the derived PlayerAttrs.topSpeed /
 * accel count for sprintSpeed / acceleration ("via topSpeed"). Writes and the copy / hash / serialise plumbing are
 * not consumers. --write-doc rewrites the table between the static-audit markers of the audit document.
 *
 * Tuning: none (no gameplay constants; the targets are the brief's numbers, overridable by flag).
 */
import './lib/env';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import ts from 'typescript';
import { ATTRIBUTE_KEYS, type Club } from '../src/contracts/data';
import { Difficulty, KitSlot, MatchPhase, ModeId } from '../src/contracts/enums';
import { createMatchConfig, type MatchConfig, type SimState } from '../src/contracts/state';
import { CLUBS, findClubByCode } from '../src/data/clubs';
import { defaultMaxTicks, runMatch, type CheckerMode, type MatchStats } from './headless';
import { bool, num, parseArgs, str } from './lib/args';
import { noHuman } from './lib/configs';
import { defaultWorkers, poolSize } from './lib/pool';
import { mix32 } from './lib/rand';
import { writeJson } from './lib/report';

// ================================================================ matchups

export type SuiteName = 'top-bottom' | 'equal' | 'mirror';
export const SUITES: readonly SuiteName[] = ['top-bottom', 'equal', 'mirror'];

/** One matchup: club A (the side the target is about) against club B. */
export interface Matchup {
  suite: SuiteName;
  a: number;
  b: number;
  /** Mirror legs: every config is played twice with A at home, then away. */
  mirrorLegs: boolean;
}

export interface ClubOverrides {
  top?: number;
  bottom?: number;
  equal?: [number, number];
  mirror?: number;
}

function ratingOf(clubs: readonly Club[], id: number): number {
  return clubs[id]!.rating;
}

/** Median of the club ratings (mean of the two middle values for an even count). */
export function medianRating(clubs: readonly Club[]): number {
  const r = clubs.map((c) => c.rating).sort((x, y) => x - y);
  const n = r.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? r[(n - 1) >> 1]! : (r[n / 2 - 1]! + r[n / 2]!) / 2;
}

/** Highest-rated club (ties: lower id). */
export function topClub(clubs: readonly Club[]): number {
  let best = 0;
  for (let i = 1; i < clubs.length; i++) if (clubs[i]!.rating > clubs[best]!.rating) best = i;
  return best;
}

/** Lowest-rated club (ties: lower id). */
export function bottomClub(clubs: readonly Club[]): number {
  let best = 0;
  for (let i = 1; i < clubs.length; i++) if (clubs[i]!.rating < clubs[best]!.rating) best = i;
  return best;
}

/**
 * The two different clubs with the closest ratings: smallest |difference|, then the pair whose mean rating is nearest
 * the median, then the lower ids. Returned [higher-or-equal rated, other].
 */
export function equalPair(clubs: readonly Club[]): [number, number] {
  if (clubs.length < 2) throw new Error('equalPair: need at least two clubs');
  const med = medianRating(clubs);
  let bi = 0, bj = 1, bd = Infinity, bm = Infinity;
  for (let i = 0; i < clubs.length; i++) {
    for (let j = i + 1; j < clubs.length; j++) {
      const d = Math.abs(clubs[i]!.rating - clubs[j]!.rating);
      const m = Math.abs((clubs[i]!.rating + clubs[j]!.rating) / 2 - med);
      if (d < bd || (d === bd && m < bm)) { bi = i; bj = j; bd = d; bm = m; }
    }
  }
  return ratingOf(clubs, bi) >= ratingOf(clubs, bj) ? [bi, bj] : [bj, bi];
}

/** The club whose rating is nearest the median (ties: lower rating, then lower id). */
export function medianClub(clubs: readonly Club[]): number {
  const med = medianRating(clubs);
  let best = 0;
  for (let i = 1; i < clubs.length; i++) {
    const d = Math.abs(clubs[i]!.rating - med), bd = Math.abs(clubs[best]!.rating - med);
    if (d < bd || (d === bd && clubs[i]!.rating < clubs[best]!.rating)) best = i;
  }
  return best;
}

/** The matchups of a run, in SUITES order. */
export function matchupsFor(suites: readonly SuiteName[], clubs: readonly Club[], ov: ClubOverrides = {}): Matchup[] {
  const out: Matchup[] = [];
  for (const suite of SUITES) {
    if (!suites.includes(suite)) continue;
    if (suite === 'top-bottom') out.push({ suite, a: ov.top ?? topClub(clubs), b: ov.bottom ?? bottomClub(clubs), mirrorLegs: true });
    else if (suite === 'equal') {
      const [a, b] = ov.equal ?? equalPair(clubs);
      out.push({ suite, a, b, mirrorLegs: true });
    } else {
      const c = ov.mirror ?? medianClub(clubs);
      out.push({ suite, a: c, b: c, mirrorLegs: false });
    }
  }
  return out;
}

// ================================================================ options

export interface BalanceOptions {
  /** Matches per matchup (rounded up to even for mirror-leg suites). */
  matches: number;
  suites: SuiteName[];
  overrides: ClubOverrides;
  /** Worker threads; 0 = run in this thread. */
  workers: number;
  seed: number;
  /** Real minutes per half, 2..10. */
  halfMinutes: number;
  /** CPU level for both sides (Difficulty, default Professional). */
  difficulty: Difficulty;
  /** Cup rules: extra time and a shoot-out decide level matches. */
  cup: boolean;
  /** top-bottom: minimum win share of the higher-rated club. */
  topTarget: number;
  /** equal / mirror: maximum |points share - 0.5|. */
  evenTol: number;
  checker: CheckerMode;
  /** Tick limit per match (smoke runs); null = the full match. */
  maxTicks: number | null;
  /** Fixed per-match time limit in seconds (0 = none); null = derived from the tick limit. */
  jobTimeoutSeconds: number | null;
  json: string | null;
  enforce: boolean;
  quiet: boolean;
}

export function defaultBalanceOptions(): BalanceOptions {
  return {
    matches: 200, suites: [...SUITES], overrides: {}, workers: defaultWorkers(), seed: 1, halfMinutes: 4,
    difficulty: Difficulty.PROFESSIONAL, cup: false, topTarget: 0.8, evenTol: 0.1, checker: 'none', maxTicks: null,
    jobTimeoutSeconds: null, json: null, enforce: true, quiet: false,
  };
}

const SPEC = {
  matches: 'number', suite: 'string', workers: 'number', seed: 'number', halfMinutes: 'number', difficulty: 'number',
  cup: 'boolean', 'top-target': 'number', 'even-tol': 'number', top: 'string', bottom: 'string', equal: 'string',
  mirror: 'string', checker: 'string', 'max-ticks': 'number', 'job-timeout': 'number', json: 'string',
  'no-enforce': 'boolean', quiet: 'boolean', audit: 'boolean', verbose: 'boolean', 'write-doc': 'string', help: 'boolean',
} as const;

export const BALANCE_USAGE = 'usage: tsx tools/balance.ts [--matches 200] [--suite all|top-bottom,equal,mirror] ' +
  '[--workers W (0 = in-process)] [--seed S] [--halfMinutes M] [--difficulty 0..5] [--cup] [--top-target 0.8] ' +
  '[--even-tol 0.1] [--top C] [--bottom C] [--equal A,B] [--mirror C] [--checker none|core|all] [--max-ticks T] ' +
  '[--job-timeout S] [--json out.json] [--no-enforce] [--quiet]\n' +
  '       tsx tools/balance.ts --audit [--verbose] [--write-doc docs/ATTRIBUTE_AUDIT.md]   (C = club code or id)';

/** Club by 3-letter code (case-insensitive) or id. */
export function parseClub(text: string, clubs: readonly Club[] = CLUBS): number {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    if (id >= clubs.length) throw new Error(`club id ${id} out of range 0..${clubs.length - 1}`);
    return id;
  }
  const c = clubs === CLUBS ? findClubByCode(t) : clubs.find((x) => x.code === t.toUpperCase());
  if (!c) throw new Error(`unknown club "${t}" (use a 3-letter code or an id 0..${clubs.length - 1})`);
  return c.id;
}

export function parseSuites(text: string): SuiteName[] {
  const t = text.trim();
  if (t === '' || t === 'all') return [...SUITES];
  const out: SuiteName[] = [];
  for (const raw of t.split(',')) {
    const s = raw.trim();
    if (s === '') continue;
    if (!(SUITES as readonly string[]).includes(s)) throw new Error(`--suite: unknown suite "${s}" (use ${SUITES.join(', ')} or all)`);
    if (!out.includes(s as SuiteName)) out.push(s as SuiteName);
  }
  if (out.length === 0) throw new Error('--suite: no suite given');
  return out;
}

export interface CliRequest {
  mode: 'balance' | 'audit' | 'help';
  balance: BalanceOptions;
  verbose: boolean;
  writeDoc: string | null;
}

/** Parse CLI flags; throws on unknown flags or bad values. */
export function balanceRequestFromArgs(argv: readonly string[]): CliRequest {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const d = defaultBalanceOptions();
  const req: CliRequest = { mode: 'balance', balance: d, verbose: bool(flags, 'verbose'), writeDoc: null };
  if (bool(flags, 'help')) { req.mode = 'help'; return req; }
  if (positionals.length > 0) throw new Error(`unexpected argument "${positionals[0]}"`);
  if (bool(flags, 'audit')) {
    req.mode = 'audit';
    req.writeDoc = typeof flags['write-doc'] === 'string' ? flags['write-doc'] : null;
    return req;
  }
  if (flags['write-doc'] !== undefined) throw new Error('--write-doc needs --audit');
  const checker = str(flags, 'checker', d.checker);
  if (checker !== 'none' && checker !== 'core' && checker !== 'all') throw new Error(`--checker must be none, core or all, got ${checker}`);
  const topTarget = num(flags, 'top-target', d.topTarget);
  if (!(topTarget > 0 && topTarget <= 1)) throw new Error(`--top-target must be in (0, 1], got ${topTarget}`);
  const evenTol = num(flags, 'even-tol', d.evenTol);
  if (!(evenTol >= 0 && evenTol <= 0.5)) throw new Error(`--even-tol must be in [0, 0.5], got ${evenTol}`);
  const difficulty = num(flags, 'difficulty', d.difficulty);
  if (!(Number.isInteger(difficulty) && difficulty >= Difficulty.BEGINNER && difficulty <= Difficulty.LEGEND)) {
    throw new Error(`--difficulty must be an integer 0..${Difficulty.LEGEND}, got ${difficulty}`);
  }
  const ov: ClubOverrides = {};
  if (typeof flags.top === 'string') ov.top = parseClub(flags.top);
  if (typeof flags.bottom === 'string') ov.bottom = parseClub(flags.bottom);
  if (typeof flags.mirror === 'string') ov.mirror = parseClub(flags.mirror);
  if (typeof flags.equal === 'string') {
    const parts = flags.equal.split(',');
    if (parts.length !== 2) throw new Error(`--equal needs two clubs "A,B", got "${flags.equal}"`);
    const a = parseClub(parts[0]!), b = parseClub(parts[1]!);
    if (a === b) throw new Error('--equal needs two different clubs (the mirror suite plays a club against itself)');
    ov.equal = [a, b];
  }
  if (ov.top !== undefined && ov.top === ov.bottom) throw new Error('--top and --bottom must be different clubs');
  const maxTicks = flags['max-ticks'];
  const jobTimeout = flags['job-timeout'];
  req.balance = {
    matches: Math.max(1, Math.floor(num(flags, 'matches', d.matches))),
    suites: typeof flags.suite === 'string' ? parseSuites(flags.suite) : d.suites,
    overrides: ov,
    workers: Math.max(0, Math.floor(num(flags, 'workers', d.workers))),
    seed: num(flags, 'seed', d.seed) >>> 0,
    halfMinutes: Math.max(2, Math.min(10, Math.floor(num(flags, 'halfMinutes', d.halfMinutes)))),
    difficulty: difficulty as Difficulty,
    cup: bool(flags, 'cup'),
    topTarget,
    evenTol,
    checker,
    maxTicks: typeof maxTicks === 'number' ? Math.max(1, Math.floor(maxTicks)) : null,
    jobTimeoutSeconds: typeof jobTimeout === 'number' ? Math.max(0, jobTimeout) : null,
    json: typeof flags.json === 'string' ? flags.json : null,
    enforce: !bool(flags, 'no-enforce'),
    quiet: bool(flags, 'quiet'),
  };
  return req;
}

// ================================================================ match plan

/** Matches per matchup actually played (rounded up to even for mirror legs). */
export function matchesFor(m: Pick<Matchup, 'mirrorLegs'>, matches: number): number {
  const n = Math.max(1, Math.floor(matches));
  return m.mirrorLegs ? n + (n % 2) : n;
}

/** Config of a balance match: CPU vs CPU at one level, the clubs' preferred formations, offside and fouls on. */
export function balanceConfig(seed: number, home: number, away: number, o: Pick<BalanceOptions, 'halfMinutes' | 'cup' | 'difficulty'>, clubs: readonly Club[] = CLUBS): MatchConfig {
  const c = createMatchConfig();
  c.seed = seed >>> 0;
  c.homeClub = home;
  c.awayClub = away;
  c.homeFormation = clubs[home]!.formation;
  c.awayFormation = clubs[away]!.formation;
  c.homeKit = KitSlot.HOME;
  c.awayKit = KitSlot.AWAY;
  c.halfMinutes = o.halfMinutes;
  c.cupRules = o.cup ? 1 : 0;
  c.mode = o.cup ? ModeId.CUP : ModeId.KICK_OFF;
  c.offside = 1;
  c.fouls = 1;
  c.night = 0;
  c.replaySeconds = 0;
  c.difficulty = o.difficulty;
  c.humans = [noHuman(), noHuman()];
  c.startPhase = MatchPhase.KICK_OFF;
  return c;
}

/** Match seed for (run seed, suite, config index): different per suite, the same for both mirror legs. */
export function matchSeed(seed: number, suite: SuiteName, index: number): number {
  return mix32(seed ^ (0xba1a0000 + SUITES.indexOf(suite)), index);
}

export interface BalanceMatchSpec {
  /** Position in the run (0..n-1). */
  id: number;
  suite: SuiteName;
  /** Config index inside the matchup (mirror legs share it). */
  index: number;
  /** Team (0 home, 1 away) club A plays for. */
  aTeam: number;
  a: number;
  b: number;
  config: MatchConfig;
  maxTicks: number;
  /** Stopping at maxTicks is expected (smoke run): the score at the stop counts. */
  partial: boolean;
  checker: CheckerMode;
}

/** Every match of a run, matchup by matchup. Mirror-leg matchups: leg k uses config k >> 1, A at home when k is even. */
export function balanceSpecs(o: BalanceOptions, clubs: readonly Club[] = CLUBS): BalanceMatchSpec[] {
  const out: BalanceMatchSpec[] = [];
  for (const m of matchupsFor(o.suites, clubs, o.overrides)) {
    const n = matchesFor(m, o.matches);
    for (let k = 0; k < n; k++) {
      const index = m.mirrorLegs ? k >> 1 : k;
      const aTeam = m.mirrorLegs ? k & 1 : 0;
      const home = aTeam === 0 ? m.a : m.b;
      const away = aTeam === 0 ? m.b : m.a;
      const config = balanceConfig(matchSeed(o.seed, m.suite, index), home, away, o, clubs);
      out.push({
        id: out.length, suite: m.suite, index, aTeam, a: m.a, b: m.b, config,
        maxTicks: o.maxTicks ?? defaultMaxTicks(config), partial: o.maxTicks !== null, checker: o.checker,
      });
    }
  }
  return out;
}

// ================================================================ one match

export type AResult = 'W' | 'D' | 'L' | 'E';
export type DecidedBy = 'goals' | 'shootout' | 'forfeit' | 'draw' | 'error';

/** Per-side numbers from the match statistics, [A, B]. */
export interface SideStats {
  shots: [number, number];
  shotsOnTarget: [number, number];
  passes: [number, number];
  passesCompleted: [number, number];
  possessionPct: [number, number];
}

export interface BalanceMatchResult {
  id: number;
  suite: SuiteName;
  index: number;
  aTeam: number;
  a: number;
  b: number;
  seed: number;
  /** Final score [home, away]. */
  goals: [number, number];
  /** Club A's result; 'E' = the match failed (not counted). */
  aResult: AResult;
  decidedBy: DecidedBy;
  aGoals: number;
  bGoals: number;
  side: SideStats;
  ticks: number;
  finished: boolean;
  partial: boolean;
  invariantFailures: number;
  watchdogs: number;
  wallMs: number;
  error?: string;
}

function zeroSide(): SideStats {
  return { shots: [0, 0], shotsOnTarget: [0, 0], passes: [0, 0], passesCompleted: [0, 0], possessionPct: [0, 0] };
}

function baseResult(spec: BalanceMatchSpec): BalanceMatchResult {
  return {
    id: spec.id, suite: spec.suite, index: spec.index, aTeam: spec.aTeam, a: spec.a, b: spec.b, seed: spec.config.seed >>> 0,
    goals: [0, 0], aResult: 'E', decidedBy: 'error', aGoals: 0, bGoals: 0, side: zeroSide(), ticks: 0, finished: false,
    partial: spec.partial, invariantFailures: 0, watchdogs: 0, wallMs: 0,
  };
}

/** A failed match (crashed / hung worker, bad spec). */
export function errorResult(spec: BalanceMatchSpec, message: string): BalanceMatchResult {
  return { ...baseResult(spec), error: message };
}

function teamOrNone(v: number): number {
  return v === 0 || v === 1 ? v : -1;
}

/** Winner (0 / 1 / -1 draw) and how it was decided, from the final state of a match that ran. */
export function matchOutcome(s: SimState): { winner: number; decidedBy: DecidedBy } {
  const forfeit = teamOrNone(s.match.forfeitTeam);
  if (forfeit >= 0) return { winner: 1 - forfeit, decidedBy: 'forfeit' };
  const g0 = s.teams[0]!.goals, g1 = s.teams[1]!.goals;
  if (g0 !== g1) return { winner: g0 > g1 ? 0 : 1, decidedBy: 'goals' };
  const w = teamOrNone(s.match.winner) >= 0 ? s.match.winner : teamOrNone(s.match.shootout.winner);
  if (w >= 0) return { winner: w, decidedBy: 'shootout' };
  return { winner: -1, decidedBy: 'draw' };
}

function sidePair(v: readonly [number, number], aTeam: number): [number, number] {
  return [v[aTeam]!, v[1 - aTeam]!];
}

export function sideStats(st: MatchStats, aTeam: number): SideStats {
  return {
    shots: sidePair(st.shots, aTeam), shotsOnTarget: sidePair(st.shotsOnTarget, aTeam), passes: sidePair(st.passes, aTeam),
    passesCompleted: sidePair(st.passesCompleted, aTeam), possessionPct: sidePair(st.possessionPct, aTeam),
  };
}

/** Play one balance match in this thread (never throws). */
export function runBalanceMatch(spec: BalanceMatchSpec): BalanceMatchResult {
  const t0 = performance.now();
  const res = baseResult(spec);
  try {
    let noBrain = -1;
    const r = runMatch({
      config: spec.config, checker: spec.checker, fastCutscenes: true, maxTicks: spec.maxTicks,
      inputs: (_tick, s) => {
        if (noBrain < 0 && s.teams[0]!.cpu.active !== 1) noBrain = 0;
        else if (noBrain < 0 && s.teams[1]!.cpu.active !== 1) noBrain = 1;
      },
    });
    const s = r.state;
    res.ticks = r.ticks;
    res.finished = r.finished;
    res.goals = [s.teams[0]!.goals, s.teams[1]!.goals];
    res.aGoals = res.goals[spec.aTeam]!;
    res.bGoals = res.goals[1 - spec.aTeam]!;
    res.side = sideStats(r.stats, spec.aTeam);
    res.invariantFailures = r.invariantFailures.count;
    res.watchdogs = r.watchdogs;
    let error: string | null = null;
    if (r.exception) error = `exception in ${r.exception.where} at t=${r.exception.tick}: ${r.exception.message}`;
    else if (noBrain >= 0) error = `team ${noBrain} has no CPU brain (not a CPU-vs-CPU config)`;
    else if (!r.finished && !spec.partial) error = `unfinished: ended in ${MatchPhase[r.endPhase] ?? r.endPhase} after ${r.ticks} ticks`;
    else if (spec.checker !== 'none' && r.invariantFailures.count > 0) {
      error = `invariants (${spec.checker}): ${r.invariantFailures.count} failure(s): ${r.invariantFailures.first[0] ?? ''}`;
    }
    if (error !== null) res.error = error;
    else {
      const o = matchOutcome(s);
      res.decidedBy = o.decidedBy;
      res.aResult = o.winner < 0 ? 'D' : o.winner === spec.aTeam ? 'W' : 'L';
    }
  } catch (err) {
    res.error = `runner: ${err instanceof Error ? err.message : String(err)}`;
    res.aResult = 'E';
    res.decidedBy = 'error';
  }
  res.wallMs = performance.now() - t0;
  return res;
}

// ================================================================ summary

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

export interface MatchupSummary {
  suite: SuiteName;
  a: number;
  b: number;
  name: string;
  /** Matches counted (without errors). */
  n: number;
  errors: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  drawRate: number;
  /** (W + D/2) / n. */
  pointsShare: number;
  /** The judged value: winRate (top-bottom) or pointsShare (equal, mirror), with its 95% Wilson interval. */
  metric: 'wins' | 'points';
  value: number;
  ciLo: number;
  ciHi: number;
  /** Human-readable target. */
  target: string;
  /** The value meets the target (regardless of failed matches). */
  met: boolean;
  /** met, n > 0 and no failed match. */
  pass: boolean;
  aGoalsAvg: number;
  bGoalsAvg: number;
  /** Averages per counted match [A, B]. */
  shotsAvg: [number, number];
  onTargetAvg: [number, number];
  possessionAvg: [number, number];
  /** Pass completion share [A, B] over all counted matches (0 when no passes). */
  passCompletion: [number, number];
  shootouts: number;
  forfeits: number;
  /** Wins of A at home / away. */
  aHomeWins: number;
  aAwayWins: number;
  partial: boolean;
}

export function clubLabel(id: number, clubs: readonly Club[] = CLUBS): string {
  const c = clubs[id];
  return c ? `${c.code} (${c.rating})` : `club ${id}`;
}

export function matchupName(m: Pick<Matchup, 'suite' | 'a' | 'b'>, clubs: readonly Club[] = CLUBS): string {
  return `${m.suite}: ${clubLabel(m.a, clubs)} v ${clubLabel(m.b, clubs)}`;
}

export function summarizeMatchup(m: Matchup, results: readonly BalanceMatchResult[], o: Pick<BalanceOptions, 'topTarget' | 'evenTol'>, clubs: readonly Club[] = CLUBS): MatchupSummary {
  let wins = 0, draws = 0, losses = 0, errors = 0, aG = 0, bG = 0, shootouts = 0, forfeits = 0, homeW = 0, awayW = 0;
  const shots: [number, number] = [0, 0], onT: [number, number] = [0, 0], poss: [number, number] = [0, 0];
  const passes: [number, number] = [0, 0], done: [number, number] = [0, 0];
  let partial = false;
  for (const r of results) {
    if (r.suite !== m.suite || r.a !== m.a || r.b !== m.b) continue;
    if (r.partial) partial = true;
    if (r.aResult === 'E') { errors++; continue; }
    aG += r.aGoals;
    bG += r.bGoals;
    for (let i = 0; i < 2; i++) {
      shots[i] += r.side.shots[i]!;
      onT[i] += r.side.shotsOnTarget[i]!;
      poss[i] += r.side.possessionPct[i]!;
      passes[i] += r.side.passes[i]!;
      done[i] += r.side.passesCompleted[i]!;
    }
    if (r.decidedBy === 'shootout') shootouts++;
    if (r.decidedBy === 'forfeit') forfeits++;
    if (r.aResult === 'W') {
      wins++;
      if (r.aTeam === 0) homeW++; else awayW++;
    } else if (r.aResult === 'D') draws++;
    else losses++;
  }
  const n = wins + draws + losses;
  const avg = (v: number): number => (n > 0 ? v / n : 0);
  const winRate = avg(wins);
  const pointsShare = avg(wins + draws / 2);
  const metric = m.suite === 'top-bottom' ? 'wins' : 'points';
  const value = metric === 'wins' ? winRate : pointsShare;
  const ci = metric === 'wins' ? wilson(wins, n) : wilson(wins + draws / 2, n);
  const met = n > 0 && (metric === 'wins' ? value >= o.topTarget : Math.abs(value - 0.5) <= o.evenTol + 1e-12);
  const target = metric === 'wins' ? `wins >= ${pct(o.topTarget)}` : `points ${pct(0.5 - o.evenTol)}-${pct(0.5 + o.evenTol)}`;
  return {
    suite: m.suite, a: m.a, b: m.b, name: matchupName(m, clubs), n, errors, wins, draws, losses, winRate, drawRate: avg(draws),
    pointsShare, metric, value, ciLo: ci[0], ciHi: ci[1], target, met, pass: met && errors === 0,
    aGoalsAvg: avg(aG), bGoalsAvg: avg(bG), shotsAvg: [avg(shots[0]), avg(shots[1])], onTargetAvg: [avg(onT[0]), avg(onT[1])],
    possessionAvg: [avg(poss[0]), avg(poss[1])],
    passCompletion: [passes[0] > 0 ? done[0] / passes[0] : 0, passes[1] > 0 ? done[1] / passes[1] : 0],
    shootouts, forfeits, aHomeWins: homeW, aAwayWins: awayW, partial,
  };
}

function pct(v: number): string {
  return `${(100 * v).toFixed(1)}%`;
}

/** Report lines of one matchup; `enforced` false (smoke runs, --no-enforce) words the verdict as meets / below target. */
export function formatMatchup(x: MatchupSummary, enforced = true): string[] {
  const verdict = x.errors > 0 ? `FAIL (${x.errors} failed match(es))` : enforced ? (x.pass ? 'PASS' : 'FAIL') : (x.met ? 'meets target' : 'below target');
  const ci = `[${(100 * x.ciLo).toFixed(1)}-${(100 * x.ciHi).toFixed(1)}]`;
  return [
    `  ${x.name.padEnd(36)} n ${String(x.n).padStart(3)}  A: W ${String(x.wins).padStart(3)} D ${String(x.draws).padStart(3)} ` +
      `L ${String(x.losses).padStart(3)}  win ${pct(x.winRate)}  draw ${pct(x.drawRate)}  points ${pct(x.pointsShare)}  ` +
      `${x.metric} ${pct(x.value)} ${ci} (target ${x.target})  ${verdict}`,
    `      goals ${x.aGoalsAvg.toFixed(2)}-${x.bGoalsAvg.toFixed(2)}  shots ${x.shotsAvg[0].toFixed(1)}-${x.shotsAvg[1].toFixed(1)}  ` +
      `on target ${x.onTargetAvg[0].toFixed(1)}-${x.onTargetAvg[1].toFixed(1)}  possession ${x.possessionAvg[0].toFixed(1)}-` +
      `${x.possessionAvg[1].toFixed(1)}%  pass completion ${pct(x.passCompletion[0])}-${pct(x.passCompletion[1])}  ` +
      `A home/away wins ${x.aHomeWins}/${x.aAwayWins}${x.shootouts > 0 ? `  shoot-outs ${x.shootouts}` : ''}` +
      `${x.forfeits > 0 ? `  forfeits ${x.forfeits}` : ''}`,
  ];
}

/** Above this draw share a matchup's verdict says little (the equal / mirror targets pass on 0-0s alone). */
export const WARN_DRAW_RATE = 0.5;
/** Below this many goals per match (both sides) the sim is not scoring like football yet. */
export const WARN_GOALS_PER_MATCH = 1;

/** Advisory lines (never change the verdict): matchups dominated by draws or hardly any goals. */
export function balanceWarnings(sums: readonly MatchupSummary[]): string[] {
  const out: string[] = [];
  for (const x of sums) {
    if (x.n === 0) continue;
    const goals = x.aGoalsAvg + x.bGoalsAvg;
    const why: string[] = [];
    if (x.drawRate > WARN_DRAW_RATE) why.push(`${pct(x.drawRate)} draws`);
    if (goals < WARN_GOALS_PER_MATCH) why.push(`${goals.toFixed(2)} goals per match`);
    if (why.length > 0) out.push(`  WARN ${x.name}: ${why.join(', ')}: the verdict mostly reflects how rarely anyone scores`);
  }
  return out;
}

// ================================================================ worker threads

const WORKER_FLAG = 'dat05BalanceWorker';

type ToWorker = { type: 'match'; spec: BalanceMatchSpec } | { type: 'stop' };
type FromWorker = { type: 'ready' } | { type: 'result'; result: BalanceMatchResult };

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
    let result: BalanceMatchResult;
    try {
      result = runBalanceMatch(m.spec);
    } catch (err) {
      result = errorResult(m.spec, `worker: ${err instanceof Error ? err.message : String(err)}`);
    }
    port.postMessage({ type: 'result', result } satisfies FromWorker);
  });
  port.postMessage({ type: 'ready' } satisfies FromWorker);
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[WORKER_FLAG] === true) startWorker();

export type ResultFn = (r: BalanceMatchResult, done: number, total: number) => void;

/** Default per-match time limit: a minute plus 3 ms per tick of the limit (shared, slow CPUs). */
function timeoutMs(o: Pick<BalanceOptions, 'jobTimeoutSeconds'>, spec: BalanceMatchSpec): number {
  if (o.jobTimeoutSeconds !== null) return o.jobTimeoutSeconds * 1000;
  return 60_000 + 3 * spec.maxTicks;
}

/**
 * Run the specs on W worker threads; resolves with one result per spec in spec order (never rejects). A worker that
 * crashes or exceeds its match's time limit turns that match into an error result and is replaced; when no worker
 * can start at all the remaining matches fail as "not run".
 */
export function runOnWorkers(specs: readonly BalanceMatchSpec[], o: Pick<BalanceOptions, 'workers' | 'jobTimeoutSeconds'>, onResult?: ResultFn): Promise<BalanceMatchResult[]> {
  const results: BalanceMatchResult[] = new Array<BalanceMatchResult>(specs.length);
  const total = specs.length;
  let next = 0, done = 0, live = 0, bootFailures = 0, settled = false;
  let lastBootError = '';
  const n = poolSize(Math.max(1, o.workers), total);
  const maxBootFailures = 2 * n;
  return new Promise((resolvePromise) => {
    if (total === 0) { resolvePromise(results); return; }
    const finish = (spec: BalanceMatchSpec, r: BalanceMatchResult): void => {
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
        resolvePromise(results);
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
      let ready = false, closed = false;
      let current: BalanceMatchSpec | null = null;
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
export function runInProcess(specs: readonly BalanceMatchSpec[], onResult?: ResultFn): BalanceMatchResult[] {
  const out: BalanceMatchResult[] = [];
  for (const spec of specs) {
    const r = runBalanceMatch(spec);
    out.push(r);
    onResult?.(r, out.length, specs.length);
  }
  return out;
}

// ================================================================ run

export interface BalanceResult {
  exitCode: number;
  ok: boolean;
  matchups: MatchupSummary[];
  results: BalanceMatchResult[];
  lines: string[];
}

function reproText(r: BalanceMatchResult, o: BalanceOptions): string {
  const legs = r.suite === 'mirror' ? r.index + 1 : 2 * (r.index + 1);
  return `seed ${r.seed} config #${r.index} A on team ${r.aTeam} (re-run: npx tsx tools/balance.ts --suite ${r.suite} --seed ${o.seed} ` +
    `--matches ${legs} --halfMinutes ${o.halfMinutes} --difficulty ${o.difficulty}${o.cup ? ' --cup' : ''} --workers 0)`;
}

export async function runBalance(o: BalanceOptions, clubs: readonly Club[] = CLUBS): Promise<BalanceResult> {
  const t0 = performance.now();
  const lines: string[] = [];
  const log = (s: string): void => {
    lines.push(s);
    if (!o.quiet) console.log(s);
  };
  const matchups = matchupsFor(o.suites, clubs, o.overrides);
  const specs = balanceSpecs(o, clubs);
  const workers = o.workers === 0 ? 0 : poolSize(o.workers, specs.length);
  const enforceTarget = o.enforce && o.maxTicks === null;
  log(`DotKick rating balance: ${matchups.length} matchup(s), ${o.matches} match(es) each` +
    `${matchups.some((m) => m.mirrorLegs) ? ' (mirror legs: rounded up to even)' : ''}, ${o.halfMinutes}-minute halves, ` +
    `CPU v CPU at difficulty ${o.difficulty}, cup ${o.cup ? 'on' : 'off'}, ` +
    `${workers === 0 ? 'in-process' : `${workers} worker(s)`}, seed ${o.seed}, checker ${o.checker}` +
    `${o.maxTicks !== null ? `, partial matches (--max-ticks ${o.maxTicks}): targets not enforced` : ''}` +
    `${!o.enforce ? ', targets not enforced (--no-enforce)' : ''}`);
  const step = Math.max(1, Math.floor(specs.length / 20));
  const progress: ResultFn = (r, done, total) => {
    if (!o.quiet && total > 10 && (done % step === 0 || done === total)) {
      console.log(`  [${done}/${total}] ${((performance.now() - t0) / 1000).toFixed(1)} s, last ${r.suite} A ${r.aResult} ${r.aGoals}-${r.bGoals}`);
    }
  };
  const results = workers === 0 ? runInProcess(specs, progress) : await runOnWorkers(specs, { workers, jobTimeoutSeconds: o.jobTimeoutSeconds }, progress);
  const sums = matchups.map((m) => summarizeMatchup(m, results, o, clubs));
  for (const x of sums) for (const l of formatMatchup(x, enforceTarget)) log(l);
  for (const l of balanceWarnings(sums)) log(l);
  const failed = results.filter((r) => r.aResult === 'E');
  if (failed.length > 0) {
    log(`  failed matches (${failed.length}):`);
    for (const r of failed.slice(0, 20)) log(`    #${r.id} ${r.suite}: ${r.error ?? 'error'}; ${reproText(r, o)}`);
    if (failed.length > 20) log(`    ... ${failed.length - 20} more`);
  }
  const met = sums.filter((x) => x.met).length;
  const ok = failed.length === 0 && (met === sums.length || !enforceTarget);
  const secs = (performance.now() - t0) / 1000;
  log(`RESULT: ${ok ? 'PASS' : 'FAIL'} (${met}/${sums.length} matchup(s) meet the target${enforceTarget ? '' : ', targets not enforced'}` +
    `${failed.length > 0 ? `, ${failed.length} failed match(es)` : ''}) in ${secs.toFixed(1)} s`);
  if (o.json) {
    writeJson(o.json, { tool: 'balance', options: o, ok, seconds: secs, matchups: sums, matches: results });
    log(`  json report: ${o.json}`);
  }
  return { exitCode: ok ? 0 : 1, ok, matchups: sums, results, lines };
}

// ================================================================ static attribute audit

/** Squad fields audited besides ATTRIBUTE_KEYS (BRIEF section 15 "also per player"). */
export const EXTRA_AUDIT_KEYS = ['height', 'foot', 'weakFoot', 'skillMoves'] as const;
export const AUDIT_KEYS: readonly string[] = [...ATTRIBUTE_KEYS, ...EXTRA_AUDIT_KEYS];
/** Derived PlayerAttrs fields (sim/init.ts copyAttrs) and the attributes they come from. */
export const DERIVED_KEYS: Readonly<Record<string, readonly string[]>> = {
  topSpeed: ['sprintSpeed', 'acceleration'],
  accel: ['acceleration'],
};
/** Interfaces whose properties are player attributes. */
const ATTR_INTERFACES = new Set(['PlayerAttrs', 'PlayerData']);
/** Files that copy, hash, serialise or check attributes: plumbing, not consumers (repo-relative, '/' separators). */
export const PLUMBING_FILES: readonly string[] = [
  'src/sim/init.ts', 'src/sim/core/hash.ts', 'src/sim/core/serialize.ts', 'src/sim/core/clone.ts', 'src/sim/replay.ts',
  'src/sim/debug/invariants.ts',
];

export interface AttributeRead {
  /** Repo-relative path with '/' separators. */
  file: string;
  line: number;
  /** The property read (an audit key, or a derived key). */
  prop: string;
}

export interface StaticAuditRow {
  key: string;
  /** Consumer files (src/sim, src/ai) reading the attribute itself. */
  direct: string[];
  /** Consumer files reading it only through a derived field (topSpeed / accel). */
  derived: string[];
  /** Every read (direct and derived), sorted by file and line. */
  reads: AttributeRead[];
  /** direct + derived consumers > 0. */
  consumed: boolean;
}

export interface StaticAuditOptions {
  /** Repo root (default: the parent of tools/). */
  root?: string;
  /** Directories (repo-relative) scanned for consumers (default src/sim, src/ai). */
  dirs?: string[];
  /** Explicit files instead of dirs (absolute or root-relative); used by tests. */
  files?: string[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listTs(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listTs(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
}

function relPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Name of the interface declaring a property symbol (through mapped types such as Readonly<T>), or null. */
function declaringInterface(sym: ts.Symbol | undefined): string | null {
  const decls = sym?.declarations;
  if (!decls) return null;
  for (const d of decls) {
    const parent = d.parent;
    if (parent && ts.isInterfaceDeclaration(parent) && ATTR_INTERFACES.has(parent.name.text)) return parent.name.text;
  }
  return null;
}

/** Is this property-access / element-access node written to (assignment target, ++/--)? */
function isWrite(node: ts.Node): boolean {
  let n: ts.Node = node;
  while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    // Compound assignments (+=) also read, but only a plain write is never a consumer.
    return p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  return false;
}

/**
 * Static attribute audit: every read of a player-attribute property in the scanned files, resolved with the
 * TypeScript type checker. Never throws for parse errors in the scanned files (the checker is lenient).
 */
export function staticAttributeAudit(opts: StaticAuditOptions = {}): StaticAuditRow[] {
  const root = opts.root ?? REPO_ROOT;
  let files: string[] = [];
  if (opts.files) files = opts.files.map((f) => resolve(root, f));
  else for (const d of opts.dirs ?? ['src/sim', 'src/ai']) listTs(resolve(root, d), files);
  const scanned = new Set(files);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2023.d.ts'], allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const watched = new Set<string>([...AUDIT_KEYS, ...Object.keys(DERIVED_KEYS)]);
  const plumbing = new Set(PLUMBING_FILES);
  const reads: AttributeRead[] = [];

  for (const sf of program.getSourceFiles()) {
    if (!scanned.has(resolve(sf.fileName))) continue;
    const file = relPath(root, resolve(sf.fileName));
    if (plumbing.has(file)) continue;
    const record = (node: ts.Node, prop: string): void => {
      reads.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, prop });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && watched.has(node.name.text)) {
        if (!isWrite(node) && declaringInterface(checker.getSymbolAtLocation(node.name)) !== null) record(node, node.name.text);
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
        watched.has(node.argumentExpression.text)) {
        const t = checker.getTypeAtLocation(node.expression);
        if (!isWrite(node) && declaringInterface(t.getProperty(node.argumentExpression.text)) !== null) record(node, node.argumentExpression.text);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const nameNode = node.propertyName ?? node.name;
        const prop = ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) ? nameNode.text : null;
        if (prop !== null && watched.has(prop)) {
          const t = checker.getTypeAtLocation(node.parent);
          if (declaringInterface(t.getProperty(prop)) !== null) record(node, prop);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  reads.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line));
  return AUDIT_KEYS.map((key) => {
    const direct = new Set<string>();
    const derived = new Set<string>();
    const mine: AttributeRead[] = [];
    for (const r of reads) {
      if (r.prop === key) { direct.add(r.file); mine.push(r); } else if (DERIVED_KEYS[r.prop]?.includes(key)) { derived.add(r.file); mine.push(r); }
    }
    for (const f of direct) derived.delete(f);
    return { key, direct: [...direct].sort(), derived: [...derived].sort(), reads: mine, consumed: direct.size + derived.size > 0 };
  });
}

function shortFile(f: string): string {
  return f.replace(/^src\//, '').replace(/\.ts$/, '');
}

/** Markdown table of a static audit (one row per audited key). */
export function formatAuditTable(rows: readonly StaticAuditRow[]): string[] {
  const out = ['| Attribute | Static readers in src/sim, src/ai | Status |', '|---|---|---|'];
  for (const r of rows) {
    const parts = r.direct.map(shortFile);
    for (const f of r.derived) parts.push(`${shortFile(f)} (via topSpeed / accel)`);
    out.push(`| ${r.key} | ${parts.length > 0 ? parts.join(', ') : '-'} | ${r.consumed ? `read (${r.reads.length} site(s))` : '**UNREAD**'} |`);
  }
  return out;
}

export const AUDIT_BEGIN = '<!-- static-audit:begin (generated by `npx tsx tools/balance.ts --audit --write-doc docs/ATTRIBUTE_AUDIT.md`) -->';
export const AUDIT_END = '<!-- static-audit:end -->';

/** Replace the text between the static-audit markers with the table; throws when the markers are missing. */
export function replaceAuditBlock(doc: string, table: readonly string[]): string {
  const b = doc.indexOf('<!-- static-audit:begin');
  const e = doc.indexOf(AUDIT_END);
  if (b < 0 || e < 0 || e < b) throw new Error('static-audit markers not found (<!-- static-audit:begin ... --> ... <!-- static-audit:end -->)');
  return `${doc.slice(0, b)}${AUDIT_BEGIN}\n${table.join('\n')}\n${doc.slice(e)}`;
}

export function runAudit(verbose: boolean, writeDoc: string | null): number {
  const t0 = performance.now();
  const rows = staticAttributeAudit();
  const table = formatAuditTable(rows);
  for (const l of table) console.log(l);
  if (verbose) {
    for (const r of rows) {
      console.log(`\n${r.key}:`);
      for (const x of r.reads) console.log(`  ${x.file}:${x.line}${x.prop !== r.key ? ` (${x.prop})` : ''}`);
      if (r.reads.length === 0) console.log('  (no reads)');
    }
  }
  const unread = rows.filter((r) => !r.consumed).map((r) => r.key);
  if (writeDoc !== null) {
    const path = resolve(process.cwd(), writeDoc);
    writeFileSync(path, replaceAuditBlock(readFileSync(path, 'utf8'), table));
    console.log(`  wrote the static table into ${writeDoc}`);
  }
  console.log(`AUDIT: ${rows.length - unread.length}/${rows.length} audited keys read by src/sim or src/ai` +
    `${unread.length > 0 ? `; UNREAD: ${unread.join(', ')}` : ''} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  return 0;
}

// ================================================================ CLI

const invokedDirectly = isMainThread && process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  // Safety net: if the run never settles and the event loop empties, exit 1 with a FAIL line, never a silent 0.
  process.exitCode = 1;
  let req: CliRequest | null = null;
  try {
    req = balanceRequestFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error(BALANCE_USAGE);
    process.exit(2);
  }
  if (req.mode === 'help') {
    console.log(BALANCE_USAGE);
    process.exit(0);
  } else if (req.mode === 'audit') {
    try {
      process.exit(runAudit(req.verbose, req.writeDoc));
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  } else {
    process.once('beforeExit', () => console.log('RESULT: FAIL (the balance run stopped before every match reported)'));
    runBalance(req.balance).then(
      (r) => process.exit(r.exitCode),
      (err: unknown) => { console.error(err); process.exit(1); },
    );
  }
}

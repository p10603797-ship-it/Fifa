/**
 * [FND-06] Soak / fuzz reporting: totals, the section 7 statistics bands (PASS/FAIL lines), every failure with
 * seed + config + replay file for reproduction, and the JSON report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Difficulty } from '../../src/contracts/enums';
import type { MatchReport } from './jobs';

export interface Band {
  name: string;
  value: number;
  lo: number;
  hi: number;
  /** lo/hi are inclusive unless exclusiveHi. */
  exclusiveHi?: boolean;
  unit: string;
  pass: boolean;
  /** Matches the value was computed over. */
  n: number;
  note?: string;
}

export interface Totals {
  matches: number;
  ticks: number;
  finished: number;
  failed: number;
  exceptions: number;
  invariantFailures: number;
  enforcedInvariantFailures: number;
  invariantsByName: Record<string, number>;
  watchdogs: number;
  watchdogReasons: Record<string, number>;
  unfinished: number;
  eventsDropped: number;
  simMsAvg: number;
  simMsMax: number;
  checkMsAvg: number;
  wallMsSum: number;
}

export function totals(reports: readonly MatchReport[]): Totals {
  const t: Totals = {
    matches: reports.length, ticks: 0, finished: 0, failed: 0, exceptions: 0, invariantFailures: 0, enforcedInvariantFailures: 0,
    invariantsByName: {}, watchdogs: 0, watchdogReasons: {}, unfinished: 0, eventsDropped: 0, simMsAvg: 0, simMsMax: 0,
    checkMsAvg: 0, wallMsSum: 0,
  };
  let simSum = 0;
  let checkSum = 0;
  const runs = (r: MatchReport): (typeof r | NonNullable<typeof r.rematch>)[] => (r.rematch ? [r, r.rematch] : [r]);
  for (const r of reports) {
    if (r.failed) t.failed++;
    for (const x of runs(r)) {
      t.ticks += x.ticks;
      if (x.finished) t.finished++;
      else t.unfinished++;
      if (x.exception) t.exceptions++;
      t.invariantFailures += x.invariants.count;
      t.enforcedInvariantFailures += x.invariants.enforced;
      for (const [k, v] of Object.entries(x.invariants.byName)) if (v > 0) t.invariantsByName[k] = (t.invariantsByName[k] ?? 0) + v;
      t.watchdogs += x.watchdogs;
      for (const [k, v] of Object.entries(x.watchdogReasons)) t.watchdogReasons[k] = (t.watchdogReasons[k] ?? 0) + v;
      t.eventsDropped += x.eventsDropped;
      simSum += x.perf.simMsAvg * x.ticks;
      checkSum += x.perf.checkMsAvg * x.ticks;
      if (x.perf.simMsMax > t.simMsMax) t.simMsMax = x.perf.simMsMax;
      t.wallMsSum += x.perf.wallMs;
    }
  }
  t.simMsAvg = t.ticks > 0 ? simSum / t.ticks : 0;
  t.checkMsAvg = t.ticks > 0 ? checkSum / t.ticks : 0;
  return t;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function band(name: string, value: number, lo: number, hi: number, unit: string, n: number, opts: { exclusiveHi?: boolean; note?: string } = {}): Band {
  const pass = Number.isFinite(value) && value >= lo && (opts.exclusiveHi ? value < hi : value <= hi);
  return { name, value, lo, hi, unit, pass, n, ...opts };
}

/** Minimum Professional matches before the bands use only them (section 7: equal teams at Professional). */
const MIN_PRO_MATCHES = 20;

/**
 * Section 7 bands over the soak population: finished matches (all matches if none finished), restricted to
 * Professional difficulty when there are at least MIN_PRO_MATCHES of them. Possession is judged per match: the
 * mean share of the side with more of the ball must be at most 60% (so the other side averages at least 40%);
 * the mean home share is a second band that catches a home/away bias.
 */
export function bands(reports: readonly MatchReport[]): { bands: Band[]; population: string } {
  let pop = reports.filter((r) => !r.exception);
  const finished = pop.filter((r) => r.finished);
  let population: string;
  if (finished.length > 0) { pop = finished; population = 'finished matches'; } else population = 'all matches (none finished)';
  const pro = pop.filter((r) => r.config.difficulty === Difficulty.PROFESSIONAL);
  if (pro.length >= MIN_PRO_MATCHES) { pop = pro; population += ', Professional only'; }
  const n = pop.length;
  const goals = pop.map((r) => r.stats.goals[0] + r.stats.goals[1]);
  const shots = pop.map((r) => r.stats.shots[0] + r.stats.shots[1]);
  const homePoss = pop.filter((r) => r.stats.possessionTicks[0] + r.stats.possessionTicks[1] > 0).map((r) => r.stats.possessionPct[0]);
  let passes = 0;
  let completed = 0;
  for (const r of pop) { passes += r.stats.passes[0] + r.stats.passes[1]; completed += r.stats.passesCompleted[0] + r.stats.passesCompleted[1]; }
  const foulPop = pop.filter((r) => r.config.fouls === 1);
  const offPop = pop.filter((r) => r.config.offside === 1);
  const fouls = foulPop.map((r) => r.stats.fouls[0] + r.stats.fouls[1]);
  const offsides = offPop.map((r) => r.stats.offsides[0] + r.stats.offsides[1]);
  const blowouts = pop.filter((r) => Math.abs(r.stats.goals[0] - r.stats.goals[1]) >= 5).length;
  const homeAvg = mean(homePoss);
  // Section 7 "40-60% for each side" is a per-match split: judge the side with more of the ball in each match
  // (averaging the home share alone sits near 50% for any symmetric population, however lopsided each match is).
  const dominantShares = homePoss.map((p) => Math.max(p, 100 - p));
  const dominant = mean(dominantShares);
  const inBand = dominantShares.filter((p) => p <= 60).length;
  return {
    population,
    bands: [
      band('goals per match', mean(goals), 2.0, 3.6, '', n),
      band('shots per match', mean(shots), 14, 26, '', n),
      band('possession per match, side with more of the ball', dominant, 40, 60, '%', homePoss.length, {
        note: homePoss.length > 0 ? `${inBand}/${homePoss.length} matches inside 40-60` : 'nobody had the ball',
      }),
      band('possession home side', homeAvg, 40, 60, '%', homePoss.length, { note: 'home/away bias' }),
      band('pass completion', passes > 0 ? (100 * completed) / passes : NaN, 70, 88, '%', n, { note: `${completed}/${passes}` }),
      band('fouls per match', mean(fouls), 6, 16, '', fouls.length, { note: 'fouls on' }),
      band('offsides per match', mean(offsides), 0, 6, '', offsides.length, { note: 'offside on' }),
      band('blow-outs (5+ goal margin)', n > 0 ? (100 * blowouts) / n : NaN, 0, 5, '%', n, { exclusiveHi: true, note: `${blowouts} match(es)` }),
    ],
  };
}

export function fmtBand(b: Band): string {
  const v = Number.isFinite(b.value) ? b.value.toFixed(2) : 'n/a';
  const range = `${b.lo}-${b.hi}${b.unit}${b.exclusiveHi ? ' (upper exclusive)' : ''}`;
  return `  ${b.pass ? 'PASS' : 'FAIL'} ${b.name}: ${v}${b.unit} (band ${range}, n=${b.n}${b.note ? `, ${b.note}` : ''})`;
}

/** Human-readable reproduction block for one failed match. */
export function fmtFailure(r: MatchReport, rerun: string): string[] {
  const out: string[] = [];
  out.push(`  #${r.index} seed ${r.seed} (${r.label}) ticks ${r.ticks} end ${r.endPhase} hash ${r.hash}`);
  for (const reason of r.reasons) out.push(`    - ${reason}`);
  for (const m of r.invariants.first.slice(0, 5)) out.push(`      ${m}`);
  if (r.rematch) for (const m of r.rematch.invariants.first.slice(0, 3)) out.push(`      rematch ${m}`);
  if (r.exception && r.exception.stack !== r.exception.message) out.push(`      ${r.exception.stack.split('\n').slice(0, 4).join('\n      ')}`);
  out.push(`    config: ${JSON.stringify(r.config)}`);
  for (const f of r.replayFiles) out.push(`    replay: ${f}   (npx tsx tools/replay-inspect.ts ${f})`);
  if (r.replayFiles.length === 0) {
    out.push(r.exception?.where === 'worker'
      ? '    replay: none (the match never reported back: re-run it with the command below)'
      : '    replay: not saved (replay budget used up, or --max-replays 0)');
  }
  out.push(`    re-run: ${rerun} --only ${r.index}`);
  return out;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 1));
}

/** Compact per-match row for the JSON report (no invariant messages beyond the first few). */
export function compact(r: MatchReport): unknown {
  return {
    id: r.id, index: r.index, seed: r.seed, label: r.label, failed: r.failed, reasons: r.reasons, ticks: r.ticks, finished: r.finished,
    endPhase: r.endPhase, hash: r.hash, stats: r.stats, invariants: { count: r.invariants.count, enforced: r.invariants.enforced, first: r.invariants.first.slice(0, 5) },
    watchdogs: r.watchdogs, exception: r.exception?.message, replayFiles: r.replayFiles, perf: r.perf,
    config: r.config, ...(r.rematch ? { rematch: { seed: r.rematch.seed, hash: r.rematch.hash, rerunHash: r.rematch.rerunHash, ticks: r.rematch.ticks } } : {}),
  };
}

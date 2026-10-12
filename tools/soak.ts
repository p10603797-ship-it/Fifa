/**
 * [FND-06] Soak runner (brief section 14 point 2): many headless bot-v-bot matches in parallel worker threads
 * across seeds, clubs, formations, difficulties, rule toggles and cup rules, with invariants checked every tick.
 *
 *   npx tsx tools/soak.ts --matches 2000 [--workers 4] [--seed 1] [--enforce core|all] [--halfMinutes 4]
 *                         [--json reports/soak.json] [--max-replays 20] [--only K] [--difficulty D] [--no-bands]
 *                         [--job-timeout S]
 *   npx tsx tools/soak.ts --short     (10 matches, 2-minute halves, enforce core, bands reported only)
 *
 * Prints totals, the section 7 statistics bands as PASS/FAIL lines, a determinism check (match 0 is run again with
 * a recorded replay that is played back after a JSON round trip, and once more at the end of the queue right after
 * another match in the same worker: all hashes must match), and every failure with seed, config, saved replay
 * (reports/raw/) and an exact re-run command. Exit code 1 on any exception, invariant failure in the enforced
 * set, watchdog trigger / unfinished match / dropped events (enforce all), worker that crashed, never started or
 * timed out (--job-timeout, default from the job's tick limit), determinism failure, or a failed band (full runs
 * only; --short, --no-bands and --only K report bands without enforcing them: one match is no population).
 */
import './lib/env';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashHex } from '../src/sim/core/hash';
import { bool, num, parseArgs, str } from './lib/args';
import { soakConfig } from './lib/configs';
import { determinismJobs, determinismVerdict, timeoutFor, type EnforceSet, type Job, type MatchReport } from './lib/jobs';
import { defaultWorkers, poolSize, runPool } from './lib/pool';
import { bands, compact, fmtBand, fmtFailure, totals, writeJson } from './lib/report';
import type { Difficulty } from '../src/contracts/enums';

export interface SoakOptions {
  matches: number;
  workers: number;
  seed: number;
  enforce: EnforceSet;
  halfMinutes: number;
  short: boolean;
  enforceBands: boolean;
  json: string | null;
  maxReplays: number;
  /** Run only this job index of the batch (reproduction). */
  only: number | null;
  difficulty: Difficulty | null;
  quiet: boolean;
  /** Fixed per-job time limit in seconds (0 = none); null = derived from each job's tick limit (jobTimeoutMs). */
  jobTimeoutSeconds: number | null;
}

export interface SoakResult {
  exitCode: number;
  reports: MatchReport[];
  lines: string[];
}

const SPEC = {
  matches: 'number', workers: 'number', seed: 'number', short: 'boolean', enforce: 'string', halfMinutes: 'number',
  json: 'string', 'max-replays': 'number', only: 'number', difficulty: 'number', 'no-bands': 'boolean', quiet: 'boolean',
  'job-timeout': 'number', help: 'boolean',
} as const;

export function soakOptionsFromArgs(argv: readonly string[]): SoakOptions {
  const { flags } = parseArgs(argv, SPEC);
  if (bool(flags, 'help')) {
    console.log('usage: tsx tools/soak.ts [--short] [--matches N] [--workers W] [--seed S] [--enforce core|all] [--halfMinutes M] [--json out.json] [--max-replays K] [--only K] [--difficulty 0-5] [--no-bands] [--job-timeout S] [--quiet]');
    process.exit(0);
  }
  const short = bool(flags, 'short');
  const enforce = str(flags, 'enforce', short ? 'core' : 'all');
  if (enforce !== 'core' && enforce !== 'all') throw new Error(`--enforce must be core or all, got ${enforce}`);
  const difficulty = flags.difficulty;
  const only = typeof flags.only === 'number' ? Math.floor(flags.only) : null;
  const jobTimeout = flags['job-timeout'];
  return {
    matches: Math.max(1, Math.floor(num(flags, 'matches', short ? 10 : 100))),
    workers: Math.max(1, Math.floor(num(flags, 'workers', defaultWorkers()))),
    seed: num(flags, 'seed', 1) >>> 0,
    enforce,
    halfMinutes: Math.max(2, Math.min(10, num(flags, 'halfMinutes', short ? 2 : 4))),
    short,
    // Bands judge a population: never enforced for --short, --no-bands, or a single-match reproduction (--only).
    enforceBands: !short && !bool(flags, 'no-bands') && only === null,
    json: typeof flags.json === 'string' ? flags.json : null,
    maxReplays: Math.max(0, Math.floor(num(flags, 'max-replays', 20))),
    only,
    difficulty: typeof difficulty === 'number' ? (difficulty as Difficulty) : null,
    quiet: bool(flags, 'quiet'),
    jobTimeoutSeconds: typeof jobTimeout === 'number' ? Math.max(0, jobTimeout) : null,
  };
}

function rerunCommand(o: SoakOptions): string {
  return `npx tsx tools/soak.ts --seed ${o.seed} --enforce ${o.enforce} --halfMinutes ${o.halfMinutes}${o.difficulty !== null ? ` --difficulty ${o.difficulty}` : ''}`;
}

export function soakJobs(o: SoakOptions): Job[] {
  const ids = o.only !== null ? [o.only] : Array.from({ length: o.matches }, (_, i) => i);
  return ids.map((id, i) => {
    const config = soakConfig(id, o.seed, { halfMinutes: o.halfMinutes, ...(o.difficulty !== null ? { difficulty: o.difficulty } : {}) });
    return {
      id: i, index: id, kind: 'soak' as const, config, enforce: o.enforce, fastCutscenes: true, expectFinish: true,
      label: `soak #${id} clubs ${config.homeClub}v${config.awayClub} form ${config.homeFormation}/${config.awayFormation} diff ${config.difficulty} offside ${config.offside} fouls ${config.fouls} cup ${config.cupRules}`,
    };
  });
}

export async function runSoak(o: SoakOptions): Promise<SoakResult> {
  const t0 = performance.now();
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); console.log(s); };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const replayDir = fileURLToPath(new URL('../reports/raw/', import.meta.url));
  const jobs = soakJobs(o);
  // Determinism: job 0 again, recorded + replayed (queued first), and re-run last right after another match.
  const [detJob, rerunJob] = determinismJobs(jobs[0]!, jobs.length, jobs[1]);
  const poolJobs = [detJob, ...jobs, rerunJob];
  log(`DotKick soak: ${jobs.length} match(es), ${poolSize(o.workers, poolJobs.length)} worker(s), seed ${o.seed}, enforce ${o.enforce}, ${o.halfMinutes}-minute halves${o.short ? ' (short)' : ''}`);
  const step = Math.max(1, Math.floor(jobs.length / 20));
  const all = await runPool(poolJobs, {
    workers: o.workers, replayDir, replayPrefix: `soak-${runId}`, replayLimit: o.maxReplays, jobTimeoutMs: timeoutFor(o.jobTimeoutSeconds),
    onReport: (r, done, total) => {
      if (!o.quiet && total > 20 && (done % step === 0 || done === total)) {
        console.log(`  [${done}/${total}] ${((performance.now() - t0) / 1000).toFixed(1)} s, last #${r.id} ${r.failed ? 'FAIL' : 'ok'}`);
      }
    },
  });

  const reports = all.slice(0, jobs.length);
  const t = totals(reports);
  const failed = reports.filter((r) => r.failed);
  log(`  ticks ${t.ticks} (avg ${(t.ticks / Math.max(1, t.matches)).toFixed(0)}/match), finished ${t.finished}/${t.matches}, sim ${t.simMsAvg.toFixed(4)} ms/tick avg (max ${t.simMsMax.toFixed(2)}), invariant checks ${t.checkMsAvg.toFixed(4)} ms/tick`);
  log(`  exceptions ${t.exceptions}, invariant failures enforced(${o.enforce}) ${t.enforcedInvariantFailures} / all ${t.invariantFailures}${t.invariantFailures > 0 ? ` ${JSON.stringify(t.invariantsByName)}` : ''}`);
  log(`  watchdogs ${t.watchdogs}${t.watchdogs > 0 ? ` ${JSON.stringify(t.watchdogReasons)}` : ''}, unfinished ${t.unfinished}, events dropped ${t.eventsDropped}`);

  const det = determinismVerdict(all[0]!, all[jobs.length]!, all[jobs.length + 1]!);
  log(`  determinism: ${det.ok ? 'PASS' : 'FAIL'} (seed ${jobs[0]!.config.seed})`);
  for (const l of det.lines) log(`    ${l}`);

  const b = bands(reports);
  log(`  statistics bands (${b.population})${o.enforceBands ? '' : ` [reported, not enforced]${o.only !== null ? ' (single-match reproduction)' : ''}`}:`);
  for (const x of b.bands) log(fmtBand(x));
  const bandsOk = b.bands.every((x) => x.pass);

  if (failed.length > 0) {
    log(`  failures (${failed.length}):`);
    for (const r of failed) for (const l of fmtFailure(r, rerunCommand(o))) log(l);
  } else log('  failures: none');

  const ok = failed.length === 0 && det.ok && (bandsOk || !o.enforceBands);
  const secs = (performance.now() - t0) / 1000;
  log(`RESULT: ${ok ? 'PASS' : 'FAIL'} in ${secs.toFixed(1)} s${!bandsOk && !o.enforceBands ? ' (bands not enforced)' : ''}`);

  if (o.json) {
    writeJson(o.json, {
      tool: 'soak', options: o, ok, seconds: secs, totals: t, determinism: det, bands: b,
      failures: failed.map((r) => ({ index: r.index, seed: r.seed, reasons: r.reasons, first: r.invariants.first, config: r.config, replayFiles: r.replayFiles })),
      matches: reports.map(compact),
      firstHash: reports[0]?.hash ?? hashHex(0),
    });
    log(`  json report: ${o.json}`);
  }
  return { exitCode: ok ? 0 : 1, reports, lines };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Safety net: if the run never settles and the event loop empties, exit 1 with a FAIL line, never a silent 0.
  process.exitCode = 1;
  process.once('beforeExit', () => console.log('RESULT: FAIL (the soak stopped before every match reported)'));
  let opts: SoakOptions;
  try {
    opts = soakOptionsFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
  runSoak(opts).then(
    (r) => process.exit(r.exitCode),
    (err: unknown) => { console.error(err); process.exit(1); },
  );
}

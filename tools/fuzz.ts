/**
 * [FND-06] Fuzz runner (brief section 14 point 3): matches where one or both humans send hostile input (button
 * mashing, direction flips every tick, every button at once, SKIP / command spam with Command.SUBSTITUTE and random
 * args at every stoppage, random gestures with out-of-range values, extreme axes, idle / release-all bursts), in
 * kick-off, cup, friend, co-op, shoot-out and practice set-ups, plus quit-and-rematch mid-match (the rematch is
 * re-run from a clean start and must hash the same: no stale state between matches).
 *
 *   npx tsx tools/fuzz.ts --matches 500 [--workers 4] [--seed 1] [--enforce core|all] [--halfMinutes 2]
 *                         [--json reports/fuzz.json] [--max-replays 20] [--only K] [--job-timeout S] [--quiet]
 *
 * Same failure criteria and reporting as tools/soak.ts (no statistics bands: inputs are hostile), including
 * workers that crash, never start or time out. The determinism check also plays the first match's hostile replay
 * back after a JSON round trip, and re-runs it right after another hostile match in the same worker.
 */
import './lib/env';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bool, num, parseArgs, str } from './lib/args';
import { fuzzConfig } from './lib/configs';
import { HOSTILE_KINDS, type HostileKind } from './lib/hostile';
import { determinismJobs, determinismVerdict, timeoutFor, type EnforceSet, type Job, type MatchReport } from './lib/jobs';
import { defaultWorkers, poolSize, runPool } from './lib/pool';
import { createRng, mix32, rngChance, rngInt, rngIntIn } from './lib/rand';
import { compact, fmtFailure, totals, writeJson } from './lib/report';
import { defaultMaxTicks } from './headless';

export interface FuzzOptions {
  matches: number;
  workers: number;
  seed: number;
  enforce: EnforceSet;
  halfMinutes: number;
  json: string | null;
  maxReplays: number;
  only: number | null;
  quiet: boolean;
  /** Fixed per-job time limit in seconds (0 = none); null = derived from each job's tick limit. */
  jobTimeoutSeconds: number | null;
}

const SPEC = {
  matches: 'number', workers: 'number', seed: 'number', enforce: 'string', halfMinutes: 'number', json: 'string',
  'max-replays': 'number', only: 'number', quiet: 'boolean', 'job-timeout': 'number', help: 'boolean',
} as const;

export function fuzzOptionsFromArgs(argv: readonly string[]): FuzzOptions {
  const { flags } = parseArgs(argv, SPEC);
  if (bool(flags, 'help')) {
    console.log('usage: tsx tools/fuzz.ts [--matches N] [--workers W] [--seed S] [--enforce core|all] [--halfMinutes M] [--json out.json] [--max-replays K] [--only K] [--job-timeout S] [--quiet]');
    process.exit(0);
  }
  const enforce = str(flags, 'enforce', 'all');
  if (enforce !== 'core' && enforce !== 'all') throw new Error(`--enforce must be core or all, got ${enforce}`);
  return {
    matches: Math.max(1, Math.floor(num(flags, 'matches', 50))),
    workers: Math.max(1, Math.floor(num(flags, 'workers', defaultWorkers()))),
    seed: num(flags, 'seed', 1) >>> 0,
    enforce,
    halfMinutes: Math.max(2, Math.min(10, num(flags, 'halfMinutes', 2))),
    json: typeof flags.json === 'string' ? flags.json : null,
    maxReplays: Math.max(0, Math.floor(num(flags, 'max-replays', 20))),
    only: typeof flags.only === 'number' ? Math.floor(flags.only) : null,
    quiet: bool(flags, 'quiet'),
    jobTimeoutSeconds: typeof flags['job-timeout'] === 'number' ? Math.max(0, flags['job-timeout']) : null,
  };
}

/** Generators weighted toward 'mixed' (which cycles through all the others). */
function pickGen(r: ReturnType<typeof createRng>): HostileKind {
  return rngChance(r, 0.4) ? 'mixed' : HOSTILE_KINDS[rngInt(r, HOSTILE_KINDS.length)]!;
}

export function fuzzJobs(o: FuzzOptions): Job[] {
  const ids = o.only !== null ? [o.only] : Array.from({ length: o.matches }, (_, i) => i);
  return ids.map((index, id) => {
    const fc = fuzzConfig(index, o.seed, o.halfMinutes);
    const r = createRng(mix32(o.seed ^ 0xf00d, index));
    const humans = fc.config.humans.filter((h) => h.kind !== 0).length;
    const gens: (HostileKind | null)[] = [humans > 0 ? pickGen(r) : null, humans > 1 ? pickGen(r) : null];
    // One human sometimes plays normally (neutral input) while the other fuzzes.
    if (humans > 1 && rngChance(r, 0.2)) gens[rngInt(r, 2)] = null;
    const max = defaultMaxTicks(fc.config);
    const quitAt = rngChance(r, 0.25) ? rngIntIn(r, 1, Math.max(2, Math.floor(max / 2))) : -1;
    const plan = { gens, genSeed: mix32(o.seed ^ 0x6e6, index), quitAt, rematchSeed: mix32(o.seed ^ 0x4e3a7c, index) };
    return {
      id, index, kind: 'fuzz' as const, config: fc.config, enforce: o.enforce, fastCutscenes: false,
      expectFinish: fc.expectFinish, fuzz: plan,
      label: `fuzz #${index} ${fc.humans} gens ${gens.map((g) => g ?? 'neutral').join('/')} mode ${fc.config.mode}${fc.config.cupRules ? ' cup' : ''}${quitAt > 0 ? ` quit@${quitAt}` : ''}`,
    };
  });
}

export async function runFuzz(o: FuzzOptions): Promise<{ exitCode: number; reports: MatchReport[]; lines: string[] }> {
  const t0 = performance.now();
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); console.log(s); };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const replayDir = fileURLToPath(new URL('../reports/raw/', import.meta.url));
  const jobs = fuzzJobs(o);
  // Determinism: job 0 again, recorded + replayed (queued first), and re-run last right after another match.
  const [detJob, rerunJob] = determinismJobs(jobs[0]!, jobs.length, jobs[1]);
  const poolJobs = [detJob, ...jobs, rerunJob];
  log(`DotKick fuzz: ${jobs.length} match(es), ${poolSize(o.workers, poolJobs.length)} worker(s), seed ${o.seed}, enforce ${o.enforce}, up to ${o.halfMinutes}-minute halves`);
  const step = Math.max(1, Math.floor(jobs.length / 20));
  const all = await runPool(poolJobs, {
    workers: o.workers, replayDir, replayPrefix: `fuzz-${runId}`, replayLimit: o.maxReplays, jobTimeoutMs: timeoutFor(o.jobTimeoutSeconds),
    onReport: (r, done, total) => {
      if (!o.quiet && total > 20 && (done % step === 0 || done === total)) {
        console.log(`  [${done}/${total}] ${((performance.now() - t0) / 1000).toFixed(1)} s, last #${r.index} ${r.failed ? 'FAIL' : 'ok'}`);
      }
    },
  });
  const reports = all.slice(0, jobs.length);
  const t = totals(reports);
  const failed = reports.filter((r) => r.failed);
  const rematches = reports.filter((r) => r.rematch).length;
  log(`  runs ${t.matches} + ${rematches} rematch(es), ticks ${t.ticks}, finished ${t.finished}, sim ${t.simMsAvg.toFixed(4)} ms/tick avg (max ${t.simMsMax.toFixed(2)})`);
  log(`  exceptions ${t.exceptions}, invariant failures enforced(${o.enforce}) ${t.enforcedInvariantFailures} / all ${t.invariantFailures}${t.invariantFailures > 0 ? ` ${JSON.stringify(t.invariantsByName)}` : ''}`);
  log(`  watchdogs ${t.watchdogs}${t.watchdogs > 0 ? ` ${JSON.stringify(t.watchdogReasons)}` : ''}, unfinished ${t.unfinished}, events dropped ${t.eventsDropped}`);
  const det = determinismVerdict(all[0]!, all[jobs.length]!, all[jobs.length + 1]!);
  log(`  determinism: ${det.ok ? 'PASS' : 'FAIL'} (${jobs[0]!.label})`);
  for (const l of det.lines) log(`    ${l}`);
  const rerun = `npx tsx tools/fuzz.ts --seed ${o.seed} --enforce ${o.enforce} --halfMinutes ${o.halfMinutes}`;
  if (failed.length > 0) {
    log(`  failures (${failed.length}):`);
    for (const r of failed) for (const l of fmtFailure(r, rerun)) log(l);
  } else log('  failures: none');
  const ok = failed.length === 0 && det.ok;
  const secs = (performance.now() - t0) / 1000;
  log(`RESULT: ${ok ? 'PASS' : 'FAIL'} in ${secs.toFixed(1)} s`);
  if (o.json) {
    writeJson(o.json, {
      tool: 'fuzz', options: o, ok, seconds: secs, totals: t, determinism: det,
      failures: failed.map((r) => ({ index: r.index, seed: r.seed, label: r.label, reasons: r.reasons, first: r.invariants.first, config: r.config, replayFiles: r.replayFiles })),
      matches: reports.map(compact),
    });
    log(`  json report: ${o.json}`);
  }
  return { exitCode: ok ? 0 : 1, reports, lines };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Safety net: if the run never settles and the event loop empties, exit 1 with a FAIL line, never a silent 0.
  process.exitCode = 1;
  process.once('beforeExit', () => console.log('RESULT: FAIL (the fuzz run stopped before every match reported)'));
  let opts: FuzzOptions;
  try {
    opts = fuzzOptionsFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
  runFuzz(opts).then(
    (r) => process.exit(r.exitCode),
    (err: unknown) => { console.error(err); process.exit(1); },
  );
}

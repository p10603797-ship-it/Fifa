/**
 * [FND-06] One soak / fuzz match as a self-contained job: run it with runMatch, judge it against the enforced
 * invariant set, and (when it fails) save its replay for reproduction. Runs on the worker threads; the
 * determinism check is two extra jobs (determinismJobs) judged by determinismVerdict.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MatchPhase } from '../../src/contracts/enums';
import type { InputFrame } from '../../src/contracts/input';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import { hashHex } from '../../src/sim/core/hash';
import { INVARIANT_SETS, type InvariantName } from '../../src/sim/debug/invariants';
import { playReplay, type Replay } from '../../src/sim/replay';
import {
  defaultMaxTicks, goalAllowanceFor, runMatch, shootoutKickAllowanceFor, type InputsFn, type MatchStats, type RunException, type RunMatchResult,
} from '../headless';
import { createHostile, type HostileGen, type HostileKind } from './hostile';

export type EnforceSet = 'core' | 'all';
export type JobKind = 'soak' | 'fuzz';

export interface FuzzPlan {
  /** Generator per human controller index (null = neutral input). */
  gens: (HostileKind | null)[];
  genSeed: number;
  /** Quit the match at this tick and start a rematch with rematchSeed; -1 = play it out. */
  quitAt: number;
  rematchSeed: number;
}

export interface Job {
  /** Position in this run's job list (0..n-1). */
  id: number;
  /** Batch index the config was generated from (equals id unless --only was used). */
  index: number;
  kind: JobKind;
  config: MatchConfig;
  maxTicks?: number;
  enforce: EnforceSet;
  fastCutscenes: boolean;
  /** False for modes with no end (practice): not finishing is then not a failure. */
  expectFinish: boolean;
  fuzz?: FuzzPlan;
  /** Free text describing the variation (humans setup etc.). */
  label: string;
  /** 'determinism': record the match and play the replay back (see determinismJobs). Default: a normal match. */
  mode?: 'match' | 'determinism';
  /** False: never write replay files for this job (determinism duplicates). Default true. */
  saveReplays?: boolean;
  /**
   * Run this job first in the same worker, result discarded (determinism re-run: guarantees the measured match
   * runs after another match in the same thread, so module state leaking between matches changes its hash).
   */
  before?: Job;
}

export interface RunSummary {
  ticks: number;
  finished: boolean;
  endPhase: string;
  hash: string;
  stats: MatchStats;
  events: Record<string, number>;
  eventsDropped: number;
  invariants: { count: number; enforced: number; byName: Record<InvariantName, number>; first: string[] };
  watchdogs: number;
  watchdogReasons: Record<string, number>;
  exception?: RunException;
  perf: { wallMs: number; simMsAvg: number; simMsMax: number; checkMsAvg: number };
}

export interface MatchReport extends RunSummary {
  id: number;
  index: number;
  kind: JobKind;
  label: string;
  seed: number;
  config: MatchConfig;
  failed: boolean;
  /** Why it failed (empty when it passed). */
  reasons: string[];
  /** Saved replay files (failures only, within the replay budget). */
  replayFiles: string[];
  /** Fuzz quit + rematch: the rematch run, and the hash of the same rematch re-run (stale-state check). */
  rematch?: RunSummary & { seed: number; rerunHash: string };
  /** Determinism jobs: the recorded replay played back after a JSON round trip. */
  replayCheck?: { hash: string; divergedAt: number; ticks: number; error?: string };
}

export interface JobContext {
  /** Directory for failure replays. */
  replayDir: string;
  /** File name prefix (tool + run id). */
  replayPrefix: string;
  /** Returns true if one more replay file may be written. */
  replayBudget: () => boolean;
}

const MATCH_PHASE_NAMES = MatchPhase as unknown as Record<number, string>;

/** Input script for a fuzz plan (fresh generators each call, so re-runs are identical). */
export function fuzzInputs(plan: FuzzPlan, seedSalt: number): InputsFn | undefined {
  const gens: (HostileGen | null)[] = plan.gens.map((k, h) => (k === null ? null : createHostile(k, (plan.genSeed ^ seedSalt ^ (h * 0x9e37)) >>> 0, h)));
  if (gens.every((g) => g === null)) return undefined;
  return (tick: number, s: SimState, out: InputFrame[]) => {
    for (let h = 0; h < gens.length && h < out.length; h++) gens[h]?.fill(tick, s, out[h]!);
  };
}

function summarize(r: RunMatchResult, enforce: EnforceSet): RunSummary {
  let enforced = 0;
  for (const n of INVARIANT_SETS[enforce]) enforced += r.invariantFailures.byName[n] ?? 0;
  return {
    ticks: r.ticks,
    finished: r.finished,
    endPhase: MATCH_PHASE_NAMES[r.endPhase] ?? String(r.endPhase),
    hash: hashHex(r.hash),
    stats: r.stats,
    events: r.events,
    eventsDropped: r.eventsDropped,
    invariants: { count: r.invariantFailures.count, enforced, byName: r.invariantFailures.byName, first: r.invariantFailures.first },
    watchdogs: r.watchdogs,
    watchdogReasons: r.watchdogReasons,
    ...(r.exception ? { exception: r.exception } : {}),
    perf: r.perf,
  };
}

/** Failure reasons of one run under the enforced set. */
export function judge(sum: RunSummary, enforce: EnforceSet, expectFinish: boolean, stopped: boolean): string[] {
  const reasons: string[] = [];
  if (sum.exception) reasons.push(`exception in ${sum.exception.where} at t=${sum.exception.tick}: ${sum.exception.message}`);
  if (sum.invariants.enforced > 0) reasons.push(`invariants (${enforce}): ${sum.invariants.enforced} failure(s)`);
  if (enforce === 'all') {
    if (sum.watchdogs > 0) reasons.push(`watchdog: ${sum.watchdogs} trigger(s) ${JSON.stringify(sum.watchdogReasons)}`);
    if (expectFinish && !stopped && !sum.finished && !sum.exception) reasons.push(`unfinished: ended in ${sum.endPhase} at t=${sum.ticks}`);
    if (sum.eventsDropped > 0) reasons.push(`events dropped: ${sum.eventsDropped} (buffer overflow)`);
  }
  return reasons;
}

function saveReplay(ctx: JobContext, job: Job, name: string, replay: Replay | undefined, files: string[]): void {
  if (!replay || job.saveReplays === false || !ctx.replayBudget()) return;
  try {
    mkdirSync(ctx.replayDir, { recursive: true });
    const file = join(ctx.replayDir, `${ctx.replayPrefix}-${name}.replay.json`);
    writeFileSync(file, JSON.stringify(replay));
    files.push(file);
  } catch {
    /* disk problems must not hide the failure itself */
  }
}

/** Run one job (soak or fuzz) and judge it. Never throws for sim errors. */
export function runJob(job: Job, ctx: JobContext): MatchReport {
  if (job.before) runJob({ ...job.before, saveReplays: false }, ctx);
  const plan = job.fuzz;
  if (job.mode === 'determinism') return runDeterminismJob(job);
  const quitting = plan !== undefined && plan.quitAt > 0;
  const first = runMatch({
    config: job.config,
    inputs: plan ? fuzzInputs(plan, 0) : undefined,
    maxTicks: quitting ? plan.quitAt : job.maxTicks ?? defaultMaxTicks(job.config),
    goalAllowanceTicks: goalAllowance(job, quitting),
    shootoutKickAllowanceTicks: kickAllowance(job, quitting),
    checker: 'all',
    fastCutscenes: job.fastCutscenes,
    record: true,
  });
  const sum = summarize(first, job.enforce);
  const reasons = judge(sum, job.enforce, job.expectFinish, quitting);
  const replayFiles: string[] = [];
  if (reasons.length > 0) saveReplay(ctx, job, `m${job.index}-s${job.config.seed >>> 0}`, first.replay, replayFiles);

  let rematch: MatchReport['rematch'];
  if (quitting && !first.exception) {
    // Quit and rematch: same settings, new seed (as session.restart does), then play the rematch again from a
    // clean start of the same worker and compare hashes (module state leaking between matches = stale state).
    const config: MatchConfig = { ...job.config, seed: plan.rematchSeed >>> 0 };
    const opts = {
      config, maxTicks: job.maxTicks ?? defaultMaxTicks(config), goalAllowanceTicks: goalAllowance(job, false),
      shootoutKickAllowanceTicks: kickAllowance(job, false), checker: 'all' as const, fastCutscenes: job.fastCutscenes,
    };
    const second = runMatch({ ...opts, inputs: fuzzInputs(plan, 0x7e3a), record: true });
    const rerun = runMatch({ ...opts, inputs: fuzzInputs(plan, 0x7e3a), checker: 'none' });
    const rs = summarize(second, job.enforce);
    const rReasons = judge(rs, job.enforce, job.expectFinish, false);
    if (second.hash !== rerun.hash && !second.exception && !rerun.exception) {
      rReasons.push(`rematch stale state: rematch hash ${hashHex(second.hash)} != fresh re-run ${hashHex(rerun.hash)}`);
    }
    if (rReasons.length > 0) saveReplay(ctx, job, `m${job.index}-rematch-s${config.seed}`, second.replay, replayFiles);
    for (const x of rReasons) reasons.push(`rematch: ${x}`);
    rematch = { ...rs, seed: config.seed, rerunHash: hashHex(rerun.hash) };
  }

  return {
    ...sum,
    id: job.id,
    index: job.index,
    kind: job.kind,
    label: job.label,
    seed: job.config.seed >>> 0,
    config: job.config,
    failed: reasons.length > 0,
    reasons,
    replayFiles,
    ...(rematch ? { rematch } : {}),
  };
}

/**
 * [FEEL-2C, D-039] Per-goal tick allowance of a run: goalAllowanceFor(config) for a full match at the default limit
 * (0 in practice and Shoot-out mode), 0 for the first part of a quit-and-rematch job (it stops exactly at its quit
 * tick) or an explicit job.maxTicks.
 */
function goalAllowance(job: Job, stopped: boolean): number {
  return stopped || job.maxTicks !== undefined ? 0 : goalAllowanceFor(job.config);
}

/** [FEEL-2C, D-039] Per-shoot-out-kick tick allowance of a run, under the same conditions as goalAllowance. */
function kickAllowance(job: Job, stopped: boolean): number {
  return stopped || job.maxTicks !== undefined ? 0 : shootoutKickAllowanceFor(job.config);
}

/** Ticks the first part of a job runs (its quit tick for quit-and-rematch fuzz jobs). */
function firstPartTicks(job: Job): number {
  return job.fuzz && job.fuzz.quitAt > 0 ? job.fuzz.quitAt : job.maxTicks ?? defaultMaxTicks(job.config);
}

/** Determinism job: run the match recording a replay, then play the replay back after a JSON round trip. */
function runDeterminismJob(job: Job): MatchReport {
  const quits = job.fuzz !== undefined && job.fuzz.quitAt > 0;
  const r = runMatch({
    config: job.config, inputs: job.fuzz ? fuzzInputs(job.fuzz, 0) : undefined, maxTicks: firstPartTicks(job),
    goalAllowanceTicks: goalAllowance(job, quits), shootoutKickAllowanceTicks: kickAllowance(job, quits), checker: 'none',
    fastCutscenes: job.fastCutscenes, record: true,
  });
  const sum = summarize(r, job.enforce);
  let replayCheck: NonNullable<MatchReport['replayCheck']>;
  try {
    const p = playReplay(JSON.parse(JSON.stringify(r.replay)) as Replay);
    replayCheck = { hash: hashHex(p.hash), divergedAt: p.divergedAt, ticks: p.ticks };
  } catch (err) {
    replayCheck = { hash: hashHex(0), divergedAt: 0, ticks: 0, error: String(err) };
  }
  return {
    ...sum, id: job.id, index: job.index, kind: job.kind, label: `${job.label} (determinism)`, seed: job.config.seed >>> 0,
    config: job.config, failed: false, reasons: [], replayFiles: [], replayCheck,
  };
}

/**
 * Extra pool jobs for the determinism check of `base`: one recorded run + replay playback (queue it first) and one
 * plain re-run (queue it last) that first plays `other` (another batch match; default: `base` with another seed) in
 * the same worker, so module state leaking between matches shows up as a different hash whatever the pool size.
 * Ids continue from `firstId`.
 */
export function determinismJobs(base: Job, firstId: number, other?: Job): [Job, Job] {
  const pre: Job = other
    ? { ...other, saveReplays: false }
    : { ...base, config: { ...base.config, seed: (base.config.seed ^ 0x5bd1e995) >>> 0 }, label: `${base.label} (other seed)`, saveReplays: false };
  delete pre.before;
  delete pre.mode;
  return [
    { ...base, id: firstId, mode: 'determinism' },
    { ...base, id: firstId + 1, mode: 'match', label: `${base.label} (re-run after another match)`, saveReplays: false, before: pre },
  ];
}

/** Per-job time limit defaults: base allowance plus a generous cost per tick the job may step. */
export const JOB_TIMEOUT = {
  baseMs: 60_000,
  /** About 10x the cost of a tick with the checker on a desktop CPU (sim budget 2.5 ms on the iPad). */
  msPerTick: 3,
} as const;

/** Upper bound of the ticks a job steps over all its runs (rematch, re-run, replay playback, `before`). */
export function jobTicks(job: Job): number {
  const full = job.maxTicks ?? defaultMaxTicks(job.config);
  let t: number;
  if (job.mode === 'determinism') t = 2 * firstPartTicks(job); // run + replay playback
  else if (job.fuzz && job.fuzz.quitAt > 0) t = job.fuzz.quitAt + 2 * full; // first part + rematch + its re-run
  else t = full;
  if (job.before) t += jobTicks(job.before);
  return t;
}

/** Default per-job time limit for the pool (ms). A job over it is reported as hung and its worker replaced. */
export function jobTimeoutMs(job: Job): number {
  return JOB_TIMEOUT.baseMs + jobTicks(job) * JOB_TIMEOUT.msPerTick;
}

/** Per-job time limit for the pool: fixed `seconds` (0 = none), or jobTimeoutMs when null (CLI --job-timeout). */
export function timeoutFor(seconds: number | null): (job: Job) => number {
  return seconds === null ? jobTimeoutMs : () => seconds * 1000;
}

export interface DeterminismResult {
  ok: boolean;
  lines: string[];
}

/** Compare the base job's run with its determinism jobs' runs and the replay playback. */
export function determinismVerdict(base: MatchReport, recorded: MatchReport, rerun: MatchReport): DeterminismResult {
  const lines: string[] = [];
  let ok = true;
  for (const r of [base, recorded, rerun]) {
    if (r.exception) { ok = false; lines.push(`exception in ${r.label}: ${r.exception.message}`); }
  }
  const same = (a: string, b: string, what: string): void => {
    if (a === b) lines.push(`${what}: ${a} == ${b}`);
    else { ok = false; lines.push(`${what}: ${a} != ${b}`); }
  };
  same(base.hash, recorded.hash, 'same seed twice (batch run vs recorded run)');
  same(base.hash, rerun.hash, 'same seed again after another match in the same worker');
  const rc = recorded.replayCheck;
  if (!rc) { ok = false; lines.push('replay check missing'); } else if (rc.error) { ok = false; lines.push(`replay playback threw: ${rc.error}`); } else if (rc.divergedAt >= 0 || rc.hash !== recorded.hash) {
    ok = false;
    lines.push(`replay playback diverged at t=${rc.divergedAt}: ${rc.hash} != ${recorded.hash}`);
  } else lines.push(`replay (JSON round trip) plays back identically: ${rc.hash} over ${rc.ticks} ticks`);
  return { ok, lines };
}

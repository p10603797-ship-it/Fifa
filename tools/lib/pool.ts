/**
 * [FND-06] Worker-thread pool for soak and fuzz: W workers pull jobs one at a time. The pool always settles with
 * one report per job, so a run can never end silently:
 * - a worker that crashes (uncaught error, abort, exit) turns its in-flight job into an exception report and is
 *   replaced, so one bad match never stops the run;
 * - a job that runs past its time limit (jobTimeoutMs) is reported as hung and its worker terminated and replaced;
 * - a worker that dies before it is ready (boot failure) is replaced up to maxBootFailures times; after that, once
 *   no worker is left, every job not yet run is reported as failed ("not run").
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { Job, MatchReport } from './jobs';
import { createMatchStats } from '../headless';
import { INVARIANT_NAMES, type InvariantName } from '../../src/sim/debug/invariants';

export interface PoolOptions {
  workers: number;
  replayDir: string;
  replayPrefix: string;
  replayLimit: number;
  /** Time limit per job in ms (0 or absent = none). A job over it fails as hung; its worker is replaced. */
  jobTimeoutMs?: (job: Job) => number;
  /** Workers that may die before becoming ready before the pool stops replacing them (default: 2 per worker). */
  maxBootFailures?: number;
  /** Worker entry module (default ./worker-boot.mjs; tests use stand-ins). */
  workerUrl?: URL;
  onReport?: (r: MatchReport, done: number, total: number) => void;
}

export function defaultWorkers(): number {
  return Math.max(1, Math.min(4, availableParallelism()));
}

/** Workers the pool starts for `jobs` jobs. */
export function poolSize(workers: number, jobs: number): number {
  return Math.max(1, Math.min(workers, jobs));
}

/** Report for a job that did not produce one (worker crashed, timed out, or no worker could start). */
export function crashReport(job: Job, message: string): MatchReport {
  const byName = Object.fromEntries(INVARIANT_NAMES.map((n) => [n, 0])) as Record<InvariantName, number>;
  return {
    id: job.id, index: job.index, kind: job.kind, label: job.label, seed: (job.config?.seed ?? 0) >>> 0, config: job.config,
    ticks: 0, finished: false, endPhase: 'n/a', hash: '00000000', stats: createMatchStats(), events: {}, eventsDropped: 0,
    invariants: { count: 0, enforced: 0, byName, first: [] }, watchdogs: 0, watchdogReasons: {},
    exception: { message, stack: message, tick: -1, where: 'worker' },
    perf: { wallMs: 0, simMsAvg: 0, simMsMax: 0, checkMsAvg: 0 },
    failed: true, reasons: [message], replayFiles: [],
  };
}

type WorkerMsg = { type: 'ready' } | { type: 'report'; report: MatchReport };

/** Run every job on a worker pool; resolves with the reports in job order (never rejects, never hangs on a job). */
export function runPool(jobs: readonly Job[], opts: PoolOptions): Promise<MatchReport[]> {
  const reports: MatchReport[] = new Array<MatchReport>(jobs.length);
  const counter = new SharedArrayBuffer(4);
  const workerData = { replayDir: opts.replayDir, replayPrefix: opts.replayPrefix, replayLimit: opts.replayLimit, replayCounter: counter };
  const bootUrl = opts.workerUrl ?? new URL('./worker-boot.mjs', import.meta.url);
  const n = poolSize(opts.workers, jobs.length);
  const maxBootFailures = opts.maxBootFailures ?? 2 * n;
  let next = 0;
  let done = 0;
  let live = 0;
  let bootFailures = 0;
  let lastBootError = '';
  let settled = false;

  return new Promise((resolve) => {
    if (jobs.length === 0) { resolve(reports); return; }

    const finish = (job: Job, r: MatchReport): void => {
      if (reports[job.id] !== undefined) return;
      reports[job.id] = r;
      done++;
      opts.onReport?.(r, done, jobs.length);
    };

    /** Resolve once every job has a report and every worker is gone; fail the rest if no worker is left. */
    const settle = (): void => {
      if (settled) return;
      if (live === 0 && done < jobs.length) {
        const why = `not run: no worker thread could start (${bootFailures} boot failure(s)): ${lastBootError || 'unknown error'}`;
        while (next < jobs.length) {
          const job = jobs[next++]!;
          finish(job, crashReport(job, why));
        }
      }
      if (done >= jobs.length && live === 0) {
        settled = true;
        resolve(reports);
      }
    };

    const spawn = (): void => {
      live++;
      let w: Worker;
      try {
        w = new Worker(bootUrl, { workerData });
      } catch (err) {
        live--;
        bootFailures++;
        lastBootError = err instanceof Error ? err.message : String(err);
        if (bootFailures <= maxBootFailures && next < jobs.length) spawn();
        else settle();
        return;
      }
      let ready = false;
      let closed = false;
      let current: Job | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const clearTimer = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };

      const feed = (): void => {
        if (next < jobs.length) {
          const job = jobs[next++]!;
          current = job;
          w.postMessage({ type: 'job', job });
          const ms = opts.jobTimeoutMs?.(job) ?? 0;
          if (ms > 0) {
            timer = setTimeout(() => {
              timer = null;
              close(`job timed out after ${+(ms / 1000).toFixed(1)} s (hung in the sim or far too slow); its worker was terminated`, true);
              void w.terminate();
            }, ms);
          }
        } else {
          current = null;
          w.postMessage({ type: 'stop' });
        }
      };

      /** The worker is gone (why = null: it stopped normally after 'stop'; hung: its job timed out). */
      const close = (why: string | null, hung = false): void => {
        if (closed) return;
        closed = true;
        clearTimer();
        live--;
        if (!ready) {
          // Died before it could take a job: replace it a limited number of times.
          bootFailures++;
          lastBootError = why ?? 'worker exited before it was ready';
          if (bootFailures <= maxBootFailures && next < jobs.length) spawn();
        } else if (current) {
          finish(current, crashReport(current, hung && why !== null ? why : `worker crashed: ${why ?? 'exited'}`));
          current = null;
          if (next < jobs.length) spawn();
        }
        settle();
      };

      w.on('message', (msg: WorkerMsg) => {
        if (closed) return;
        if (msg.type === 'ready') {
          ready = true;
          feed();
          return;
        }
        clearTimer();
        if (current) finish(current, msg.report);
        current = null;
        feed();
      });
      w.on('error', (err) => close(err instanceof Error ? err.message : String(err)));
      w.on('exit', (code) => close(current || !ready ? `worker exited with code ${code}` : null));
    };

    for (let i = 0; i < n; i++) spawn();
  });
}

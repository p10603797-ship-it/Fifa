/**
 * FND-06 review fixes: regression tests for the worker pool (boot failures, crashes, hung jobs), the determinism
 * re-run after another match in the same worker, per-job time limits, the single-match reproduction (bands not
 * enforced), the per-match possession band, the bench proxy gate's percentile statistic, and the invariant
 * checker's allocation claim.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { BENCH_BUDGETS, computeBenchResult, percentile, type BenchSamples } from '../../src/platform/benchHook';
import { createMatchStats } from '../../tools/headless';
import {
  determinismJobs, JOB_TIMEOUT, jobTicks, jobTimeoutMs, runJob, timeoutFor, type Job, type JobContext, type MatchReport,
} from '../../tools/lib/jobs';
import { poolSize, runPool, type PoolOptions } from '../../tools/lib/pool';
import { bands } from '../../tools/lib/report';
import { soakJobs, soakOptionsFromArgs } from '../../tools/soak';

const ROOT = resolve(__dirname, '../..');
const TMP = mkdtempSync(join(tmpdir(), 'fnd06-fixes-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const STANDIN = new URL('../harness/pool-workers/standin.mjs', import.meta.url);

function jobs(n: number): Job[] {
  return soakJobs(soakOptionsFromArgs(['--short', '--matches', String(n)]));
}

function pool(mode: string, list: Job[], extra: Partial<PoolOptions> = {}): Promise<MatchReport[]> {
  return runPool(list, { workers: 2, replayDir: TMP, replayPrefix: mode, replayLimit: 0, workerUrl: STANDIN, ...extra });
}

// ---------------------------------------------------------------- worker pool

describe('FND-06 fixes: the worker pool always settles with one report per job', () => {
  it('workers that never start: every job is reported as not run (bounded retries), no silent hang', async () => {
    const list = jobs(3);
    const r = await pool('boot-fail', list, { maxBootFailures: 3 });
    expect(r).toHaveLength(3);
    for (const x of r) {
      expect(x.failed).toBe(true);
      expect(x.reasons.join()).toMatch(/not run: no worker thread could start \(\d+ boot failure\(s\)\): stand-in boot failure/);
    }
    expect(r.map((x) => x.id)).toEqual([0, 1, 2]);
  }, 30_000);

  it('a worker that exits cleanly before it is ready counts as a boot failure too', async () => {
    const r = await pool('exit-early', jobs(2), { maxBootFailures: 1 });
    expect(r.every((x) => x.failed && /worker exited with code 0/.test(x.reasons.join()))).toBe(true);
  }, 30_000);

  it('a worker that fails to boot once is replaced and every job runs', async () => {
    const r = await pool('boot-fail-once', jobs(4));
    expect(r.map((x) => x.hash)).toEqual(['h0', 'h1', 'h2', 'h3']);
    expect(r.every((x) => !x.failed)).toBe(true);
  }, 30_000);

  it('a hung job is reported as timed out (with its seed and config) and the other jobs still run', async () => {
    const list = jobs(3);
    const r = await pool('hang:1', list, { jobTimeoutMs: () => 500 });
    expect(r[0]!.hash).toBe('h0');
    expect(r[2]!.hash).toBe('h2');
    expect(r[1]!.failed).toBe(true);
    expect(r[1]!.reasons[0]).toMatch(/job timed out after 0.5 s/);
    expect(r[1]!.seed).toBe(list[1]!.config.seed >>> 0);
    expect(r[1]!.config).toEqual(list[1]!.config);
  }, 30_000);

  it('a job that kills its worker gets a crash report and a replacement worker runs the rest', async () => {
    const r = await pool('crash:0', jobs(4), { workers: 1 });
    expect(r[0]!.failed).toBe(true);
    expect(r[0]!.reasons[0]).toMatch(/worker crashed: worker exited with code 3/);
    expect(r.slice(1).map((x) => x.hash)).toEqual(['h1', 'h2', 'h3']);
  }, 30_000);

  it('pool size is min(workers, jobs), at least 1', () => {
    expect(poolSize(4, 3)).toBe(3);
    expect(poolSize(4, 12)).toBe(4);
    expect(poolSize(0, 5)).toBe(1);
  });
});

// ---------------------------------------------------------------- determinism re-run and time limits

const CTX: JobContext = { replayDir: TMP, replayPrefix: 'test', replayBudget: () => false };

describe('FND-06 fixes: determinism re-run and per-job time limits', () => {
  it('the re-run job always plays another match first in the same worker, whatever the pool size', () => {
    const list = jobs(2);
    const [det, rerun] = determinismJobs(list[0]!, 2, list[1]);
    expect(det.mode).toBe('determinism');
    expect(rerun.before?.config).toEqual(list[1]!.config);
    expect(rerun.before?.saveReplays).toBe(false);
    expect(rerun.before?.before).toBeUndefined();
    // --only K (one batch match): the other match is the same set-up with another seed.
    const [, solo] = determinismJobs(list[0]!, 1);
    expect(solo.before?.config.seed).not.toBe(list[0]!.config.seed);
    expect(solo.before?.config.homeClub).toBe(list[0]!.config.homeClub);
  });

  it('a match re-run after another match in the same thread hashes the same as a fresh run', () => {
    const base: Job = { ...jobs(1)[0]!, maxTicks: 240 };
    const other: Job = { ...jobs(2)[1]!, maxTicks: 240 };
    const [, rerun] = determinismJobs(base, 1, other);
    const a = runJob(base, CTX);
    const b = runJob(rerun, CTX);
    expect(a.exception).toBeUndefined();
    expect(b.ticks).toBe(240);
    expect(b.hash).toBe(a.hash);
  });

  it('time limits scale with every tick a job may step', () => {
    const base: Job = { ...jobs(1)[0]!, maxTicks: 1000 };
    const [det, rerun] = determinismJobs(base, 1, { ...base, maxTicks: 500 });
    expect(jobTicks(base)).toBe(1000);
    expect(jobTicks(det)).toBe(2000); // run + replay playback
    expect(jobTicks(rerun)).toBe(1500); // the other match first
    const quit: Job = { ...base, fuzz: { gens: [null, null], genSeed: 1, quitAt: 300, rematchSeed: 2 } };
    expect(jobTicks(quit)).toBe(300 + 2 * 1000); // first part + rematch + its re-run
    expect(jobTimeoutMs(base)).toBe(JOB_TIMEOUT.baseMs + 1000 * JOB_TIMEOUT.msPerTick);
    expect(timeoutFor(null)).toBe(jobTimeoutMs);
    expect(timeoutFor(0)(base)).toBe(0);
    expect(timeoutFor(7)(base)).toBe(7000);
  });

  it('soak options: bands are enforced only for a full population run', () => {
    expect(soakOptionsFromArgs(['--matches', '5']).enforceBands).toBe(true);
    expect(soakOptionsFromArgs(['--matches', '5', '--only', '3']).enforceBands).toBe(false);
    expect(soakOptionsFromArgs(['--short']).enforceBands).toBe(false);
    expect(soakOptionsFromArgs(['--no-bands']).enforceBands).toBe(false);
    expect(soakOptionsFromArgs(['--job-timeout', '7']).jobTimeoutSeconds).toBe(7);
    expect(soakOptionsFromArgs([]).jobTimeoutSeconds).toBeNull();
  });
});

// ---------------------------------------------------------------- possession band

function report(homePct: number): MatchReport {
  const config = createMatchConfig();
  config.difficulty = Difficulty.PROFESSIONAL;
  const stats = createMatchStats();
  stats.possessionTicks = [homePct * 100, (100 - homePct) * 100];
  stats.possessionPct = [homePct, 100 - homePct];
  return { finished: true, config, stats } as unknown as MatchReport;
}

function possession(pop: MatchReport[]): { name: string; value: number; pass: boolean }[] {
  return bands(pop).bands.filter((b) => b.name.startsWith('possession'));
}

describe('FND-06 fixes: the possession band judges each match split', () => {
  it('55/45 splits either way pass; 70/30 either way fails on the per-match band only', () => {
    const even = possession(Array.from({ length: 20 }, (_, i) => report(i % 2 ? 45 : 55)));
    expect(even.every((b) => b.pass)).toBe(true);
    const lopsided = possession(Array.from({ length: 20 }, (_, i) => report(i % 2 ? 30 : 70)));
    expect(lopsided.find((b) => b.name.startsWith('possession per match'))).toMatchObject({ value: 70, pass: false });
    expect(lopsided.find((b) => b.name === 'possession home side')!.pass).toBe(true);
  });

  it('a home bias fails the home-side band', () => {
    const b = possession(Array.from({ length: 20 }, () => report(65)));
    expect(b.find((x) => x.name === 'possession home side')!.pass).toBe(false);
  });
});

// ---------------------------------------------------------------- bench proxy gate statistic

function benchSamples(frameWorst: number[], over: Partial<BenchSamples> = {}): BenchSamples {
  const frameMs = new Float64Array(frameWorst.length).fill(1000 / 60);
  return {
    frameMs, frames: frameMs.length, drawCallsSum: 40 * frameMs.length, drawCallsMax: 45, trianglesSum: 1e5 * frameMs.length,
    trianglesMax: 150_000, renderSamples: frameMs.length, resolutionScale: 0.75, qualityTier: 1,
    simMsAvg: 0.3, simMsMax: Math.max(...frameWorst), simFrameMaxMs: Float64Array.from(frameWorst), simFrames: frameWorst.length,
    ticks: frameWorst.length, renderMsAvg: 3, renderMsMax: 6, ...over,
  };
}
const ENV = { seed: 1, userAgent: 'test', screen: '1x1@1' };

describe('FND-06 fixes: the bench proxy gate uses a stable sim statistic', () => {
  it('percentile is nearest-rank over the first n values', () => {
    expect(percentile([5, 1, 3], 3, 0.5)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 100, 0.99)).toBe(99);
    expect(percentile([9, 1, 2], 2, 1)).toBe(9);
    expect(percentile([], 0, 0.99)).toBeNull();
    // Excluding the slowest values: never the top `excludeTop`, never below the median.
    const v = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(percentile(v, 26, 0.99)).toBe(26);
    expect(percentile(v, 26, 0.99, 2)).toBe(24);
    expect(percentile(Array.from({ length: 5400 }, (_, i) => i + 1), 5400, 0.99, 2)).toBe(5346);
    expect(percentile([1, 2, 3], 3, 0.99, 2)).toBe(2);
  });

  it('a short throttled run (few frames) is not decided by its one or two slowest frames', () => {
    const worst = new Array<number>(26).fill(0.3);
    worst[3] = 8.5;
    worst[17] = 7.6;
    const r = computeBenchResult(benchSamples(worst), ENV);
    expect(r.simMsP99).toBeCloseTo(0.3, 9);
    expect(r.proxyPass).toBe(true);
    worst[20] = 6; // a third slow frame out of 26 is no longer a hitch
    expect(computeBenchResult(benchSamples(worst), ENV).proxyPass).toBe(false);
  });

  it('a few hitches (GC, JIT, scheduling) do not fail the proxy gate; the worst tick still fails the full verdict', () => {
    const worst = new Array<number>(5400).fill(0.4);
    for (let i = 0; i < 5; i++) worst[i * 1000] = 8.5;
    const r = computeBenchResult(benchSamples(worst), ENV);
    expect(r.simMsP99).toBeCloseTo(0.4, 9);
    expect(r.simFramesOverBudget).toBe(5);
    expect(r.proxyPass).toBe(true);
    expect(r.checks.find((c) => c.name === 'sim + AI ms/tick worst')).toMatchObject({ pass: false, proxy: false });
    expect(r.pass).toBe(false);
  });

  it('sustained slow ticks (over 1% of frames) fail the proxy gate', () => {
    const worst = new Array<number>(1000).fill(0.4);
    for (let i = 0; i < 20; i++) worst[i * 50] = BENCH_BUDGETS.simMsMax + 0.5;
    const r = computeBenchResult(benchSamples(worst), ENV);
    expect(r.simMsP99).toBe(BENCH_BUDGETS.simMsMax + 0.5);
    expect(r.proxyPass).toBe(false);
  });

  it('without a per-frame distribution the gate judges the maximum (never passes by default)', () => {
    const r = computeBenchResult(benchSamples([1], { simFrameMaxMs: undefined, simFrames: undefined, simMsMax: 4.2 }), ENV);
    expect(r.simMsP99).toBe(4.2);
    expect(r.simFramesOverBudget).toBeNull();
    expect(r.proxyPass).toBe(false);
  });
});

// ---------------------------------------------------------------- invariant checker allocation

describe('FND-06 fixes: invariant checker allocation (documented in its header)', () => {
  it("only the 'finite' scan allocates on the passing path, and only a little", () => {
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'tests/harness/alloc-probe.ts', '20000'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    for (const [name, b] of Object.entries(bytes)) {
      if (name === 'finite' || name === 'all') expect(b, name).toBeLessThan(512);
      else expect(b, name).toBeLessThan(8);
    }
  }, 150_000);
});

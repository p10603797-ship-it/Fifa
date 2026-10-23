/**
 * SIM-01 budgets: predictBall(120 ticks) < 0.1 ms; zero allocation in ballAirStep, predictBall, ticksToHeight and the
 * solvers. Timings are the best of many short batches so a busy runner does not make the check flaky.
 */
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT } from '../../src/contracts/constants';
import { createBallState, type BallState } from '../../src/contracts/state';
import { createBallPrediction } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import {
  ballAirStep, copyBallState, createLaunchSolution, groundPassSpeed, predictBall, solveLaunch,
  solveLaunchSpin, ticksToHeight,
} from '../../src/sim/ball/flight';
import { createV3 } from '../../src/sim/core/vec';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

function bestBatchMs(fn: () => void, iterations: number, batches: number): number {
  for (let i = 0; i < iterations; i++) fn(); // warm-up / JIT
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

function mk(x: number, y: number, z: number, vx: number, vy: number, vz: number, sy = 0): BallState {
  const b = createBallState();
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.sy = sy;
  b.grounded = y <= BALL_RADIUS && vy === 0 ? 1 : 0;
  return b;
}

const ROOT = resolve(__dirname, '../..');

const LOB = mk(-20, BALL_RADIUS, 0, 18, 13, 2, 6);
const SHOT = mk(30, 0.3, 0, 34, 2, 1);
const ROLL = mk(0, BALL_RADIUS, 0, 15, 0, 3);

/**
 * Bundle the ball modules like the production build does (one scope, no module-namespace getters on imported
 * constants) and import the bundle: Vitest's module runner adds a getter call to every access of an imported binding,
 * which inflates the cost of SIM-02's hot loop several times over and says nothing about the iPad build.
 */
async function importBundledBall(): Promise<BundledBall> {
  const dir = mkdtempSync(join(tmpdir(), 'sim-01-bench-'));
  const entry = join(dir, 'entry.ts');
  const src = (f: string): string => JSON.stringify(join(ROOT, f));
  writeFileSync(entry, [
    `export { predictBall } from ${src('src/sim/ball/flight')};`,
    `export { createBallState } from ${src('src/contracts/state')};`,
    `export { createBallPrediction } from ${src('src/contracts/systems')};`,
  ].join('\n'));
  const outfile = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error',
    define: { __DEV_BUILD__: 'false' } });
  try {
    return (await import(/* @vite-ignore */ pathToFileURL(outfile).href)) as BundledBall;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface BundledBall {
  predictBall: typeof predictBall;
  createBallState: typeof createBallState;
  createBallPrediction: typeof createBallPrediction;
}

describe('SIM-01 performance budgets', () => {
  it('predictBall(120 ticks) < 0.1 ms in a production-like bundle (lob, hard shot, ground pass)', async () => {
    const m = await importBundledBall();
    const p = m.createBallPrediction();
    for (const [name, src] of [['lob', LOB], ['shot', SHOT], ['roll', ROLL]] as [string, BallState][]) {
      const b = m.createBallState();
      copyBallState(b, src);
      // Many short batches: the best one finds a quiet slice even when other test workers load the machine.
      const ms = bestBatchMs(() => m.predictBall(b, 120, p), 20, 250);
      console.log(`predictBall(120) ${name} (bundled): ${(ms * 1000).toFixed(1)} us`);
      expect(ms).toBeLessThan(0.1);
    }
  }, 30_000);

  it('predictBall adds next to nothing over the 120 SIM-02 ballStepTick calls it makes', () => {
    const p = createBallPrediction();
    const scratch = createBallState();
    for (const [name, b] of [['lob', LOB], ['roll', ROLL]] as [string, BallState][]) {
      const floorFn = (): void => {
        copyBallState(scratch, b);
        for (let i = 0; i < 120; i++) ballStepTick(scratch, null);
      };
      const predFn = (): void => predictBall(b, 120, p);
      // Interleaved batches, best of each: both see the same machine load.
      let floor = Infinity;
      let ms = Infinity;
      for (let k = 0; k < 60; k++) {
        floor = Math.min(floor, bestBatchMs(floorFn, 10, 1));
        ms = Math.min(ms, bestBatchMs(predFn, 10, 1));
      }
      console.log(`predictBall(120) ${name}: ${(ms * 1000).toFixed(1)} us vs ballStepTick x120 ${(floor * 1000).toFixed(1)} us (unbundled)`);
      expect(ms - floor).toBeLessThan(Math.max(0.015, floor * 0.15));
    }
  });

  it('solvers are cheap enough to call from AI scans', () => {
    const v = createV3();
    const sol = createLaunchSolution();
    const msLaunch = bestBatchMs(() => solveLaunch(45, 12, 0.62, v), 200, 5);
    const msCurl = bestBatchMs(() => solveLaunchSpin(30, 10, 0.5, BALL_RADIUS, 9, 0, sol), 200, 5);
    const msGround = bestBatchMs(() => groundPassSpeed(27, 4), 5000, 5);
    console.log(`solveLaunch ${(msLaunch * 1000).toFixed(1)} us, curl ${(msCurl * 1000).toFixed(1)} us, groundPassSpeed ${(msGround * 1000).toFixed(2)} us`);
    // No brief budget for the solvers (called once per kick / per staggered AI scan): generous bounds, so a loaded
    // test runner never flakes; typical values are ~25 us, ~20 us and ~0.3 us.
    expect(msLaunch).toBeLessThan(0.5);
    expect(msCurl).toBeLessThan(0.5);
    expect(msGround).toBeLessThan(0.02);
  });
});

describe('SIM-01 zero allocation', () => {
  /**
   * Bytes allocated per call after warm-up. The per-tick paths must allocate nothing. The solvers create no objects,
   * arrays or closures either; what remains there is V8 boxing doubles (HeapNumber, 16 B) passed to / returned from
   * non-inlined calls (dlog, dsin, the solver's own return value), bounded below.
   */
  function bytesPerCall(fn: () => void, n = 4000): number {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    for (let i = 0; i < n; i++) fn(); // warm-up / JIT / inline caches
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    return (process.memoryUsage().heapUsed - h0) / n;
  }

  const p = createBallPrediction();
  const air = mk(0, 10, 0, 20, 5, 3, 9);
  const sink = new Float64Array(1);

  it('per-tick paths add no allocation: ballAirStep allocates nothing; predictBall / ticksToHeight add nothing to SIM-02', () => {
    const air1 = (): void => {
      air.x = 0; air.y = 10; air.vx = 20; air.vy = 5; air.vz = 3; air.sy = 9;
      ballAirStep(air, DT);
    };
    const bAir = bytesPerCall(air1);
    console.log(`ballAirStep: ${bAir.toFixed(2)} B/call`);
    expect(bAir).toBeLessThan(2);
    // predictBall = copy + n x SIM-02 ballStepTick. Whatever SIM-02 itself allocates (see the report) is the floor.
    const scratch = createBallState();
    for (const [name, b] of [['lob', LOB], ['shot', SHOT], ['roll', ROLL]] as [string, BallState][]) {
      const floor = bytesPerCall(() => {
        copyBallState(scratch, b);
        for (let i = 0; i < 120; i++) ballStepTick(scratch, null);
      }, 1500);
      const pred = bytesPerCall(() => predictBall(b, 120, p), 1500);
      console.log(`predictBall(120) ${name}: ${pred.toFixed(2)} B/call (SIM-02 ballStepTick x120 alone: ${floor.toFixed(2)})`);
      expect(pred, name).toBeLessThan(floor + 2 + floor * 0.02);
    }
    const k = ticksToHeight(LOB, 2);
    expect(k).toBeGreaterThan(0);
    const tFloor = bytesPerCall(() => {
      copyBallState(scratch, LOB);
      for (let i = 0; i < k; i++) ballStepTick(scratch, null);
    }, 1500);
    const tth = bytesPerCall(() => { sink[0] = ticksToHeight(LOB, 2); }, 1500);
    console.log(`ticksToHeight (${k} ticks): ${tth.toFixed(2)} B/call (SIM-02 floor ${tFloor.toFixed(2)})`);
    expect(tth).toBeLessThan(tFloor + 2 + tFloor * 0.02);
  });

  /**
   * [FIN-A] Measured in a child process (tests/unit/fin-a-sim-01-alloc-probe.ts) with the QF-7R exact-allocation flags,
   * like the TUN-7S sim / AI allocation tests. In this worker thread the count depended on CPU load and on what ran
   * before (background compiles arrive later under load, so more calls box doubles in the interpreter / baseline
   * tiers): groundRollTime read 1472 B/call once under parallel load and groundPassSpeed 814 B/call when this test ran
   * alone. --single-threaded compiles synchronously and the sampling heap profiler counts every byte of the window, so
   * the child reports the same bytes on every run. The limits are unchanged.
   */
  it('solvers create no objects (only bounded double boxing)', () => {
    const limits: [string, number][] = [
      ['solveLaunch', 64],
      ['solveLaunchSpin curl+backspin', 64],
      // Newton iterations on dlog: ~32 B of boxing per iteration.
      ['groundPassSpeed', 512],
      ['groundRollTime', 1024],
    ];
    const runs = [runSolverProbe(), runSolverProbe()];
    for (const r of runs) expect(r.singleThreaded, 'probe ran with --single-threaded').toBe(true);
    // Load independence: two runs give the same bytes to the last sample.
    expect(runs[1]!.cases, 'same bytes on every run').toEqual(runs[0]!.cases);
    for (const [name, max] of limits) {
      const b = runs[0]!.cases[name];
      console.log(`${name}: ${b?.toFixed(2)} B/call`);
      expect(b, name).toBeTypeOf('number');
      expect(b!, name).toBeLessThan(max);
    }
  }, 60_000);
});

/** One run of the SIM-01 solver allocation probe in a single-threaded child process. */
function runSolverProbe(): { singleThreaded: boolean; cases: Record<string, number> } {
  const r = spawnSync(process.execPath, [
    ...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/fin-a-sim-01-alloc-probe.ts', '4000', '1500',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as { singleThreaded: boolean; cases: Record<string, number> };
}

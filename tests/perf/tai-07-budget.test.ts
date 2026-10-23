/**
 * TAI-07 budget: chaser assignment for both teams (including the one SIM-01 predictBall per tick) plus arrival
 * steering for both teams < 0.1 ms per tick, and no allocation in TAI-07's own per-tick code.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * turns every imported binding into a getter on a module namespace object, which makes hot loops several times
 * slower than the shipped (bundled) code and would measure the test runner instead of the module. Best of many
 * short batches so a busy machine does not make the check flaky.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { assignChaser, executeJobs } = await import(${imp('src/ai/steer.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const CASES = {
    rolling: { x: 3, z: -4, vx: 14, vz: 5, owner: -1 },
    high: { x: -20, y: 1, z: 10, vx: 18, vy: 15, vz: -4, grounded: 0, owner: -1 },
    fastAway: { x: 45, z: 30, vx: 30, vz: 8, owner: -1 },
  };
  const ev = { emit() {} };
  const out = { us: {}, allocTick: {}, allocExec: 0 };
  for (const [name, ball] of Object.entries(CASES)) {
    const s = makeScenario({ phase: 2, ball });
    // Players spread over the pitch, some moving, as in open play.
    for (let i = 0; i < 22; i++) {
      const p = s.players[i];
      if (p.isKeeper === 1) continue;
      p.x = -40 + ((i * 37) % 80); p.z = -30 + ((i * 23) % 60);
      p.vx = ((i % 5) - 2) * 1.5; p.vz = ((i % 3) - 1) * 2;
      p.homeX = p.x + 3; p.homeZ = p.z - 2;
    }
    const tick = () => { s.tick++; for (let t = 0; t < 2; t++) { resetJobs(s, t); assignChaser(s, t, ev); executeJobs(s, t, ev); } };
    for (let i = 0; i < 4000; i++) tick();
    // Many short batches, best one: on a shared, busy machine a short batch is likely to catch a quiet slice.
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 400);
    }
    out.us[name] = best * 1000;
    if (s.teams[0].chaser < 0 || s.teams[1].chaser < 0) throw new Error('no chaser in ' + name);
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40000; i++) tick();
    out.allocTick[name] = (process.memoryUsage().heapUsed - h0) / 40000;
    if (name === 'rolling') {
      const exec = () => { for (let t = 0; t < 2; t++) executeJobs(s, t, ev); };
      for (let i = 0; i < 20000; i++) exec();
      globalThis.gc();
      const e0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100000; i++) exec();
      out.allocExec = (process.memoryUsage().heapUsed - e0) / 100000;
    }
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-07 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; allocTick: Record<string, number>; allocExec: number }
    : null;
  if (res) console.log(`TAI-07 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['rolling', 'high', 'fastAway']) {
    it(`assignChaser x2 (incl. predictBall) + executeJobs x2 < 0.1 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(100);
    });
  }

  it('executeJobs allocates nothing; the whole AI tick stays within V8 number boxing at the dependency calls', () => {
    expect(res).not.toBeNull();
    expect(res!.allocExec).toBeLessThan(2);
    // predictBall (SIM-01/02) and ticksToReach (SIM-04) box double arguments / results in V8 (tens of bytes per call);
    // any source-level allocation per candidate (an object literal, closure or array) would blow well past this.
    for (const v of Object.values(res!.allocTick)) expect(v).toBeLessThan(1024);
  });
});

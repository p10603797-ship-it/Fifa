/**
 * TAI-14 budget: receiverAssist (one predictBall + bounded ticksToReach while a job-driven receiver exists) plus
 * tacticsTick for both teams < 0.1 ms per tick; tacticsTick and a tick without a receiver allocate nothing, and the
 * receiver path stays within V8's number boxing at the SIM-01 / SIM-04 calls.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * turns every imported binding into a getter on a module namespace object, which makes hot loops several times
 * slower than the shipped (bundled) code. Best of many short batches so a busy machine does not make the check flaky
 * (measured ~11-16 us per tick on an idle core; predictBall dominates, its airborne path is the dearer one).
 * The receiver drifts every tick so the interception is re-evaluated on fresh geometry.
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
  const { receiverAssist, tacticsTick } = await import(${imp('src/ai/tactics.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const ev = { emit() {} };
  // KickKind: GROUND_PASS 1, LOB_PASS 4, THROUGH_GROUND 10.
  const CASES = {
    lob: { ball: { x: -10, y: 0.3, z: 5, vx: 13, vy: 9, vz: -2, grounded: 0, lastKickKind: 4 }, r: [16, 1], pass: [16, 1] },
    groundPass: { ball: { x: 0, z: 0, vx: 14, vz: 1, lastKickKind: 1 }, r: [24, 2], pass: [24, 2] },
    throughBall: { ball: { x: 0, z: 0, vx: 15, vz: 3.5, lastKickKind: 10 }, r: [10, 6], pass: [20, 4.66] },
    farAway: { ball: { x: 0, z: 0, vx: 24, vz: 0, lastKickKind: 1 }, r: [5, 28], pass: [5, 28] },
  };
  const out = { us: {}, alloc: {}, allocNoReceiver: 0, allocTactics: 0 };
  for (const [name, c] of Object.entries(CASES)) {
    const s = makeScenario({
      phase: 2, humans: [{ side: 0, slot: 2, autoSwitch: 0 }],
      ball: { ...c.ball, owner: -1, passTarget: 9, passX: c.pass[0], passZ: c.pass[1], lastKickTeam: 0, lastTouchTeam: 0, lastKickBy: 6, lastTouch: 6 },
    });
    const p = s.players[9];
    let k = 0;
    const tick = () => {
      s.tick++;
      k = (k + 1) % 64;
      p.x = c.r[0] + k * 0.05; p.z = c.r[1] - k * 0.03; p.vx = 2 - k * 0.05; p.vz = 0.5;
      tacticsTick(s, 0, ev); tacticsTick(s, 1, ev);
      resetJobs(s, 0); resetJobs(s, 1);
      receiverAssist(s, 0, ev); receiverAssist(s, 1, ev);
      if (p.job !== 12) throw new Error('no RECEIVE in ' + name);
    };
    for (let i = 0; i < 4000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 160; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 100);
    }
    out.us[name] = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40000; i++) tick();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 40000;
  }
  {
    // No receiver (ball owned): the common tick.
    const s = makeScenario({ phase: 2, ball: { x: 0, z: 0, owner: 6 } });
    const tick = () => { s.tick++; tacticsTick(s, 0, ev); tacticsTick(s, 1, ev); receiverAssist(s, 0, ev); receiverAssist(s, 1, ev); };
    for (let i = 0; i < 20000; i++) tick();
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200000; i++) tick();
    out.allocNoReceiver = (process.memoryUsage().heapUsed - h0) / 200000;
    const tt = () => { tacticsTick(s, 0, ev); tacticsTick(s, 1, ev); };
    for (let i = 0; i < 20000; i++) tt();
    globalThis.gc();
    const h1 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200000; i++) tt();
    out.allocTactics = (process.memoryUsage().heapUsed - h1) / 200000;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-14 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number>; allocNoReceiver: number; allocTactics: number }
    : null;
  if (res) console.log(`TAI-14 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['groundPass', 'throughBall', 'lob', 'farAway']) {
    it(`receiverAssist x2 (incl. predictBall) + tacticsTick x2 + resetJobs x2 < 0.1 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(100);
    });
  }

  it('tacticsTick and a tick without a receiver allocate nothing; the receiver path stays within call boxing', () => {
    expect(res).not.toBeNull();
    expect(res!.allocTactics).toBeLessThan(2);
    expect(res!.allocNoReceiver).toBeLessThan(2);
    // predictBall (SIM-01/02) and ticksToReach (SIM-04) box double arguments / results in V8 (tens of bytes per call);
    // any source-level allocation per sample (an object literal, closure or array) would blow well past this.
    for (const v of Object.values(res!.alloc)) expect(v).toBeLessThan(1024);
  });
});

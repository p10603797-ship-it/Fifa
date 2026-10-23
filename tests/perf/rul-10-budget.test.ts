/**
 * RUL-10 budget: the per-tick work of RUL-10 (subsTick + checkForfeit, which RUL-01 calls every tick) costs well under
 * a microsecond and allocates nothing, both with empty queues and with a substitution queued during open play.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * turns imported bindings into getters and would measure the test runner). Best of many short batches.
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
  const { subsTick, checkForfeit, requestSub } = await import(${imp('src/sim/rules/subs.ts')});
  const ev = { emit() {} };
  const idle = makeScenario({ phase: 2 });
  const queued = makeScenario({ phase: 2 });
  const out = { usIdle: 0, usQueued: 0, allocIdle: 0, allocQueued: 0, accepted: requestSub(queued, 0, 5, 12) };
  const tickIdle = () => { idle.tick++; subsTick(idle, ev); checkForfeit(idle, ev); };
  const tickQueued = () => { queued.tick++; subsTick(queued, ev); checkForfeit(queued, ev); };
  for (let i = 0; i < 20000; i++) { tickIdle(); tickQueued(); }
  let bestI = Infinity, bestQ = Infinity;
  for (let r = 0; r < 40; r++) {
    let t0 = performance.now();
    for (let i = 0; i < 5000; i++) tickIdle();
    bestI = Math.min(bestI, (performance.now() - t0) / 5000);
    t0 = performance.now();
    for (let i = 0; i < 5000; i++) tickQueued();
    bestQ = Math.min(bestQ, (performance.now() - t0) / 5000);
  }
  out.usIdle = bestI * 1000; out.usQueued = bestQ * 1000;
  globalThis.gc();
  let h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) tickIdle();
  out.allocIdle = (process.memoryUsage().heapUsed - h0) / 100000;
  globalThis.gc();
  h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) tickQueued();
  out.allocQueued = (process.memoryUsage().heapUsed - h0) / 100000;
  out.stillQueued = queued.teams[0].subCount;
  console.log(JSON.stringify(out));
`;

describe('RUL-10 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      usIdle: number; usQueued: number; allocIdle: number; allocQueued: number; accepted: number; stillQueued: number;
    }
    : null;
  if (res) console.log(`RUL-10 probe: ${JSON.stringify(res)}`);

  it('probe ran; the open-play request stayed queued (never applied IN_PLAY)', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.accepted).toBe(1);
    expect(res!.stillQueued).toBe(1);
  });

  it('subsTick + checkForfeit < 1 us per tick', () => {
    expect(res).not.toBeNull();
    expect(res!.usIdle).toBeLessThan(1);
    expect(res!.usQueued).toBeLessThan(1);
  });

  it('subsTick + checkForfeit allocate nothing per tick', () => {
    expect(res).not.toBeNull();
    expect(res!.allocIdle).toBeLessThan(2);
    expect(res!.allocQueued).toBeLessThan(2);
  });
});

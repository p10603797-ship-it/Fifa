/**
 * TAI-12 budget: levelParams, styleWeights and applyExecutionError are called per tick by the CPU modules, so they
 * must be cheap and allocate nothing per call.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * turns every imported binding into a getter and would measure the test runner). Best of many short batches so a
 * busy machine does not make the check flaky.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { levelParams, styleWeights, applyExecutionError } = await import(${imp('src/ai/cpu/levels.ts')});
  const s = makeScenario({ phase: 2, seed: 3 });
  // Results go into a Float64Array: a captured \`let acc\` would box a heap number per store and measure the probe.
  const acc = new Float64Array(1);
  const CASES = {
    levelParams: (k) => { acc[0] += levelParams(k % 6).executionError; },
    styleWeights: (k) => { acc[0] += styleWeights(k % 5).press; },
    applyExecutionError: (k) => { s.teams[k & 1].cpu.level = k % 6; acc[0] += applyExecutionError(s, k & 1, 1.5, 0.4); },
  };
  const out = { us: {}, alloc: {} };
  for (const [name, call] of Object.entries(CASES)) {
    let k = 0;
    for (let i = 0; i < 20000; i++) call(k++);
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) call(k++);
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    out.us[name] = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200000; i++) call(k++);
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 200000;
  }
  out.finite = Number.isFinite(acc[0]);
  console.log(JSON.stringify(out));
`;

describe('TAI-12 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number>; finite: boolean }
    : null;
  if (res) console.log(`TAI-12 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.finite).toBe(true);
  });

  for (const name of ['levelParams', 'styleWeights', 'applyExecutionError']) {
    it(`${name} < 1 us per call`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(1);
    });
    it(`${name}: no allocation per call`, () => {
      expect(res).not.toBeNull();
      // A returned object literal or a closure per call would be >= 16-50 bytes per call.
      expect(res!.alloc[name]!).toBeLessThan(4);
    });
  }
});

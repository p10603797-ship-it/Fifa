/**
 * [GKP-04] The distribution AI's per-tick paths do not allocate (common rules: no allocation in per-tick code).
 * Runs tests/unit/gkp-04-alloc-probe.ts in a child process with --expose-gc.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('GKP-04 allocation', () => {
  it('waiting, evaluating and deciding allocate nothing per call', () => {
    // [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): compiles synchronously, so the measured bytes do not
    // depend on CPU load (under load the optimised code arrived later and the window ran boxing baseline code).
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', 'tests/unit/gkp-04-alloc-probe.ts', '20000'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    expect(Object.keys(bytes).sort()).toEqual(['evaluateHold', 'evaluateRelease', 'waiting']);
    for (const [name, b] of Object.entries(bytes)) expect(b, name).toBeLessThan(8);
  }, 150_000);
});

/**
 * [QF-7R] CR for src/sim/core/clone.ts (FND-03; sim perf owner QF-7S): copyState(prev, curr), which the app loop runs
 * before every tick, allocates ~11 KB per tick in live play although prev and curr share every hidden class
 * (src/app/liveState.ts). The generic walk `for (const k in so) { const e = so[k]; dobj[k] = e; }` reads each field
 * through the for-in keyed load, and V8 boxes every double it reads that way (a fresh 16-byte heap number per
 * double field: ~700 per tick, ~680 KB per second at 60 Hz, the largest steady allocation of a live match and the
 * main cause of its minor GCs). Same bytes with the old dictionary-mode prev (the read boxes, not the store).
 * Proposed fix (clone.ts): a copier specialised per shape, built once from the state's own keys (e.g. per nested
 * object a list of [key, kind] with explicit numeric copies `d.x = s.x` through generated accessors, or a cached
 * `new Function` body per hidden class where the CSP allows), keeping the generic walk as the fallback for
 * mismatched shapes. Measured by tests/unit/qf-7r-live-state-probe.ts (exact allocation count, src/sim/core/clone.ts).
 * Marked it.fails until the CR lands; then drop `.fails`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('QF-7R CR: copyState allocation per tick', () => {
  it.fails('copyState(prev, curr) with matching shapes allocates nothing per tick in live play', () => {
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-live-state-probe.ts',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 200_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { copyBytesPerTick: number };
    console.log(`QF-7R CR copyState bytes per tick: ${res.copyBytesPerTick}`);
    expect(res.copyBytesPerTick).toBeLessThan(16);
  }, 240_000);
});

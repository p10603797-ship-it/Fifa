/**
 * PAD-08: the keyboard source (pollFrame + sample, every tick) and the menu input (poll, every animation frame)
 * allocate nothing per call (InputSource contract: "Must not allocate"). Runs tests/unit/pad-08-alloc-probe.ts in a
 * child process with --expose-gc.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('PAD-08 allocation', () => {
  it('keyboard tick and menu poll allocate nothing per call', () => {
    const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/pad-08-alloc-probe.ts', '20000'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    expect(Object.keys(bytes).sort()).toEqual(['keyboardDiagonal', 'keyboardHeld', 'keyboardIdle', 'menuIdle', 'menuRepeat']);
    // [QF-7R] Exact (ALLOC_FLAGS): the smallest allocation is 16 B, so < 2 means nothing per call. Diagonal movement
    // included: the PAD-05 tracker keeps its doubles in a Float64Array now (it boxed 64 B per update in closure
    // variables) and the keyboard hands both sticks over as one object.
    for (const name of ['keyboardDiagonal', 'keyboardHeld', 'keyboardIdle', 'menuIdle', 'menuRepeat']) expect(bytes[name], name).toBeLessThan(2);
  }, 150_000);
});

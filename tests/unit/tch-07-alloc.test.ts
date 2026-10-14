/**
 * TCH-07: the touch mapper's per-tick sample allocates nothing (InputSource contract: "Must not allocate"), idle, with
 * the stick and SPRINT held, and while handling a stream of taps, swipes, double taps and skills; a pitch gesture
 * costs only its projector calls. Runs
 * tests/unit/tch-07-alloc-probe.ts in a child process with --expose-gc.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('TCH-07 allocation', () => {
  it('mapper.sample allocates nothing per tick', () => {
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'tests/unit/tch-07-alloc-probe.ts', '20000'], {
      cwd: ROOT, encoding: 'utf8', timeout: 240_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    expect(Object.keys(bytes).sort()).toEqual(['busy', 'gestures', 'held', 'idle']);
    for (const name of ['idle', 'held', 'busy']) expect(bytes[name], name).toBeLessThan(8);
    // A pitch gesture calls the camera projector (CameraProjector takes and returns coordinates as doubles, which V8
    // boxes across the call): a few hundred bytes per gesture, never per tick. Bounded here (one gesture / 40 ticks).
    expect(bytes.gestures, 'gestures').toBeLessThan(16);
  }, 300_000);
});

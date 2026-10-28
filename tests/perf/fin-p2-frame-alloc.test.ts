/**
 * [FIN-P2] Ball vs goal frame (src/sim/ball/contact.ts frame) boxes nothing.
 *
 * frame() clamped the contact point onto the post and bar axes with `py < 0 ? 0 : py > FR_Y ? FR_Y : py`. In a bundle
 * (Vite / Rolldown and esbuild turn every top-level const into a var) V8 loads FR_Y as an untyped tagged value, so the
 * ternary was a tagged phi and the double py was boxed on every substep the ball spent near a goal: 816 B per
 * previewFlight call (the free-kick aim preview predicts the shot's flight into the goal mouth; rul-05-perf's limit),
 * and the same in every predictBall / ticksToHeight near a goal and in the ball's own step. The probe runs a
 * production-mode esbuild bundle in a child process with the exact-allocation flags and attributes every allocation
 * of 3000 previews to its function.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from './qf-7r-alloc-flags';

const ROOT = resolve(__dirname, '../..');

describe('FIN-P2 goal frame contact', () => {
  it('the goal-frame contact allocates nothing in a free-kick flight preview (production bundle)', () => {
    const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--import', 'tsx', 'tests/perf/fin-p2-preview-alloc-probe.ts', '3000'],
      { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.trim().split('\n').pop()!;
    const res = JSON.parse(line) as { perCall: number; byFn: Record<string, number> };
    // Before the fix: frame 816 B per call (previewFlight 1786 B in all, 970 B after).
    expect(res.byFn.frame ?? 0, line).toBe(0);
    expect(res.byFn.sweepFrame ?? 0, line).toBe(0);
  }, 300_000);
});

/**
 * [QF-7R] In-match input allocates nothing per frame with real analogue values (BRIEF section 13 "No allocation in hot
 * paths"; InputSource contract "Must not allocate"): a pad source with the real PAD-05 right-stick tracker (both
 * sticks sweeping, strokes, buttons, a fractional clock, the player facing a fractional direction), the same under a
 * rotated camera, and the keyboard with diagonal movement. Probe: tests/unit/qf-7r-input-alloc-probe.ts (sampling heap
 * profiler, attributed to src/input/ code only; ALLOC_FLAGS + STEADY_FLAGS: exact and load-independent).
 *
 * Regression for: the right-stick tracker kept its doubles (facing, clock, stick samples, stroke state) in closure
 * variables, which V8 boxes on every store (~64 B per keyboard tick with diagonal movement, every pad frame with
 * analogue sticks, every sample for the facing), and passed doubles through internal calls; the keyboard handed its
 * stick to the tracker and the axes as separate doubles.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, STEADY_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('QF-7R input allocation per frame', () => {
  it('pad (real right-stick tracker, analogue sticks), rotated camera and keyboard diagonal allocate nothing per frame', () => {
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-input-alloc-probe.ts', '20000',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    console.log(`QF-7R input bytes per frame: ${JSON.stringify(bytes)}`);
    expect(Object.keys(bytes).sort()).toEqual(['keyboardPlay', 'padRotated', 'padSticks']);
    // The smallest allocation is 16 B: anything per frame shows >= 16, anything per sample (every second frame) >= 8.
    // What remains (< 1 B) is event-time code: a skill or flick reported a few times a second in this drive.
    for (const [k, v] of Object.entries(bytes)) expect(v, k).toBeLessThan(2);
  }, 300_000);
});

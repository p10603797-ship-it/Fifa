/**
 * [QF-7R] The app frame around the renderer allocates nothing of its own (BRIEF section 13 "No allocation in hot paths";
 * src/app/loop.ts "No allocation per frame"): the rAF loop with its fixed-step timing at 60 Hz and 120 Hz, and the
 * real audio engine's frame (clock watch, crowd bed, sfx camera estimate, voices) with boot's per-frame camera x.
 * Probe: tests/unit/qf-7r-loop-alloc-probe.ts (every allocation sampled at its exact size, charged to the allocating
 * function's file: src/app/, and src/audio/ for the engine; ALLOC_FLAGS + STEADY_FLAGS).
 *
 * What remains is set by the contracts, not by this code: V8 boxes a double passed to a call it does not inline, and
 * src/contracts/app.ts hands the frame's numbers over as arguments: AudioEngine.update(state, dtSec) (one 16-byte heap
 * number every frame) and GameRenderer.render(prev, curr, alpha, frame) (alpha is 0 or 1, unboxed, at 60 Hz; 0.5 every
 * second frame at 120 Hz: 8 B per frame). So exactly: 16 B per frame at 60 Hz, 24 at 120 Hz, 16 with the audio engine.
 * Anything more every frame adds >= 16 B; anything every 16th frame >= 1 B.
 *
 * Regression for: the loop's doubles that outlive a frame (previous timestamp, alpha, smoothed frame interval) and the
 * stats' running sums in closure variables (a heap number per write); `dt = MAX_FRAME_MS` in loopMath.beginFrame and
 * `raw > MAX_FRAME_MS ? MAX_FRAME_MS : raw` in the loop (an imported binding as one arm made V8 box the other: three
 * heap numbers per frame); the busy time passed to afterFrame as a number; the audio engine's clock watch (last audio
 * time, stall and retry timers) in closure variables (a heap number per frame). 72-81 B per frame before (loop) and 16
 * more with the audio engine.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, STEADY_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('QF-7R app frame allocation', () => {
  it('the rAF loop and the audio engine frame allocate nothing beyond the contracts\' boxed frame numbers', () => {
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-loop-alloc-probe.ts', '10000',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    console.log(`QF-7R app frame bytes per frame: ${JSON.stringify(bytes)}`);
    expect(Object.keys(bytes).sort()).toEqual(['audio60', 'loop120', 'loop60']);
    expect(bytes.loop60, 'loop at 60 Hz: the audio dtSec argument only').toBeLessThan(16 + 1);
    expect(bytes.loop120, 'loop at 120 Hz: dtSec + alpha 0.5 every second frame').toBeLessThan(24 + 1);
    expect(bytes.audio60, 'loop + audio engine frame + camera x at 60 Hz').toBeLessThan(16 + 1);
  }, 300_000);
});

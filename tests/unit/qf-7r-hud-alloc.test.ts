/**
 * [QF-7R] The in-match HUD allocates nothing per frame in live play (BRIEF section 13 "No allocation in hot paths";
 * section 12 "draw the radar on a small 2D canvas at 20 Hz"): scoreboard, toasts, radar, player info, power bar and
 * hints over a live human v CPU match (real sim and events, two HUD frames per tick). Probe:
 * tests/unit/qf-7r-hud-alloc-probe.ts (DOM stand-in tests/unit/qf-7r-fake-dom.ts with its methods out of the optimiser
 * like the browser's bindings; every allocation sampled at its exact size, charged to src/ui/ code).
 *
 * Regression for: the radar drew its marks with arc() / fillRect() at fractional positions and radii (every number a
 * redraw passed to the canvas boxed by the binding: ~70 heap numbers per redraw, 192 B per frame here, ~465 B per frame
 * in Chromium at 60 fps) and kept its redraw timer in a closure variable (a heap number every frame): 213 B per frame
 * before, 2.4 now. What remains is event time (a set-piece hint's settings write, a toast's text).
 *
 * The power bar, shown only while a human charges a kick, projects his player twice a frame through the renderer's
 * CameraProjector.pitchToScreen(x, y, z, out) (src/contracts/input.ts): six numbers that are boxed when the call is not
 * inlined (96 B), plus the bar's transform string when it moves. Bounded here at that.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, STEADY_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('QF-7R HUD allocation per frame', () => {
  it('the HUD in live play allocates nothing per frame (radar marks as integer-positioned sprites)', () => {
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-hud-alloc-probe.ts', '3000',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 400_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      perFrame: number; chargingPerFrame: number; powerPerChargingFrame: number; chargingFrames: number; top: [string, number][];
    };
    console.log(`QF-7R HUD bytes per frame: ${JSON.stringify(res)}`);
    // Anything allocated every frame adds >= 16 B; every redraw of the radar (20 Hz at 120 Hz frames) >= 2.7 B.
    expect(res.perFrame, JSON.stringify(res.top)).toBeLessThan(4);
    expect(res.chargingPerFrame, 'everything but the power bar while charging').toBeLessThan(4);
    expect(res.chargingFrames).toBeGreaterThan(100);
    expect(res.powerPerChargingFrame, 'power bar: the projector\'s six numbers + its transform string').toBeLessThan(6 * 16 + 16);
  }, 450_000);
});

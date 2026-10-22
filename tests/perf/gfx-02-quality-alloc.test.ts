/**
 * [GFX-02] The quality module's per-frame path (update(): frame signal, dynamic resolution controller, tier
 * adaptation, Low Power detector; the scene.onAfterRender work mark) allocates nothing. Measured in a child process
 * with V8's sampling heap profiler (64-byte interval, minor-GC'd objects included): every sampled allocation whose
 * allocating frame is in src/render/quality.ts counts. The frame series alternates fast, slow, 30 fps-capped and
 * in-band phases so scale changes, failed probes, the tier adapter's holds and the Low Power detector all run while
 * measured. (The AUTO tier steps BALANCED -> PERFORMANCE once during the warm-up; a tier change is a rare event that
 * makes every module re-apply its tier, so it is not part of the per-frame budget.)
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from './qf-7r-alloc-flags';

describe('GFX-02 zero allocation per frame', () => {
  it('update() and the end-of-render mark allocate nothing; a few microseconds per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createQuality } = await import(${mod('src/render/quality.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.endsWith('render/quality.ts')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const settings = createDefaultSettings();
      const shadowMap = { enabled: false };
      const renderer = { shadowMap };
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      const ctx = { renderer, scene, camera, settings, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 },
        tier: 2, cameraSettings: { type: 0, height: 10, zoom: 10 }, reducedMotion: false, night: false };
      const clock = new Float64Array(1);
      const counts = new Int32Array(2);
      const q = createQuality(ctx, {
        setScale: (s) => { ctx.size.scale = s; counts[0]++; },
        setTier: () => { counts[1]++; },
      }, { now: () => clock[0], nextFrame: () => Promise.resolve(), hidden: () => true });
      const s = initMatch(createMatchConfig());
      const fi = { nowMs: 0, dtMs: 0, frame: 0, ticks: 1, paused: false };
      const frame = { prev: s, curr: s, alpha: 1, frame: fi, interp: createInterpState() };
      q.setMatch(s, []);
      const HZ = 1000 / 60;
      const pos = new Int32Array(1);
      const run = (n) => {
        for (let j = 0; j < n; j++) {
          const k = pos[0]++;
          const phase = ((k / 600) | 0) % 4; // 10 s phases
          const iv = phase === 0 ? HZ : phase === 1 ? (k % 3 === 0 ? 2 * HZ : HZ) : phase === 2 ? 2 * HZ : HZ + (k & 1) * 0.4;
          const work = phase === 3 ? 15 : 4 + (k & 3);
          clock[0] += iv;
          fi.nowMs = clock[0];
          fi.dtMs = iv;
          fi.frame++;
          fi.paused = k % 997 === 0;
          q.update(frame);
          const start = clock[0];
          clock[0] = start + work;
          scene.onAfterRender(renderer, scene, camera);
          clock[0] = start;
        }
      };
      const measure = async (n) => {
        run(30000);
        globalThis.gc();
        const h0 = process.memoryUsage().heapUsed;
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        const c0 = counts[0], t0 = counts[1];
        run(n);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return { bytes: mine(profile, n), heap: (process.memoryUsage().heapUsed - h0) / n, scaleChanges: counts[0] - c0, tierChanges: counts[1] - t0 };
      };
      const m = await measure(100000);
      const t0 = process.hrtime.bigint();
      run(50000);
      const usPerFrame = Number(process.hrtime.bigint() - t0) / 50000 / 1000;
      console.log(JSON.stringify({ ...m, usPerFrame, scale: q.scale, tier: q.tier }));
    `;
    // --no-concurrent-recompilation: hot functions are optimised on the main thread as soon as they are hot, so the
    // measured window always runs the optimised steady state. With background compilation on a loaded machine the
    // optimised code can arrive after the warm-up and the window then sees the interpreter boxing doubles (1-2 B /
    // frame of noise, reproduced with --concurrent-recompilation-delay=200), which is JIT warm-up, not the code.
    // Calibration: the clean module measures 0; one small object, array, closure or string per frame in update()
    // measures 0.76-1.56 here (the profiler under-reports small objects), so 0.25 keeps a 3x margin.
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, '--expose-gc', '--no-concurrent-recompilation', '--min-semi-space-size=256', '--max-semi-space-size=256',
      '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      bytes: number; heap: number; scaleChanges: number; tierChanges: number; usPerFrame: number; scale: number; tier: number;
    };
    console.log(`GFX-02 quality per frame: ${JSON.stringify(res)}`);
    expect(res.scaleChanges).toBeGreaterThan(5); // the measured run exercised the controller
    expect(res.bytes).toBeLessThan(0.25);
    expect(res.usPerFrame).toBeLessThan(20);
    expect(res.scale).toBeGreaterThanOrEqual(0.6);
    expect(res.scale).toBeLessThanOrEqual(1);
  });
});

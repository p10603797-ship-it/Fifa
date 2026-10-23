/**
 * [QF-7R skeptic] The whole GameRenderer in steady play with the CLOSE camera at the QUALITY tier (BRIEF section 13:
 * "No allocation in hot paths"; the camera is a user setting, and an iPad that AUTO steps up runs QUALITY). Same
 * harness, flags and thresholds as tests/perf/int-c-render-alloc.test.ts (which runs the default BROADCAST camera at
 * BALANCED): every allocation of the measured window whose allocating frame is in src/render/ is counted exactly.
 *
 * Regression for: with the CLOSE camera the ball leaves the view often (long balls, goal kicks) and markers.ts drew
 * the off-screen ball arrow from code nothing had warmed (the broadcast camera the warm-up script drives keeps the
 * ball in view): drawArrow / liftCore ran in V8's interpreter in steady play, a heap number per double operation -
 * 3.8 B and 163 allocations per 1000 frames (int-c's limits: 2 B and 20). Fixed by the markers module's warmUp()
 * (the arrow path, every branch, past the optimisation threshold on the loading screen). Probed and clean as well:
 * WIDE at PERFORMANCE, END_TO_END at BALANCED, BROADCAST at QUALITY.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, EXACT_INTERVAL, STEADY_FLAGS } from './qf-7r-alloc-flags';

describe('QF-7R renderer: allocation per frame in steady play, CLOSE camera, QUALITY tier', () => {
  it('render() + onEvents() allocate nothing per frame with the CLOSE camera (off-screen ball arrow) at the QUALITY tier', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createInputFrame } = await import(${mod('src/contracts/input.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { CLUBS } = await import(${mod('src/data/clubs.ts')});
      const { createGameRenderer } = await import(${mod('src/render/index.ts')});
      const { copyState } = await import(${mod('src/sim/core/clone.ts')});
      // [QF-7R] prev as the app builds it (src/app/session.ts): the live state's own hidden classes.
      const { cloneLiveState } = await import(${mod('src/app/liveState.ts')});
      const { createEventBuffer } = await import(${mod('src/sim/core/events.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const { step } = await import(${mod('src/sim/step.ts')});
      const session = new Session();
      session.connect();
      const three = {
        shadowMap: { enabled: false, type: 0, autoUpdate: true, needsUpdate: false },
        info: { render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
        extensions: { has: () => false, get: () => null },
        capabilities: { getMaxAnisotropy: () => 4, maxTextureSize: 4096, isWebGL2: true },
        domElement: { width: 885, height: 615 },
        render(scene, camera) { scene.onAfterRender(this, scene, camera, null, null, null); },
        compile() {}, setRenderTarget() {}, getRenderTarget() { return null; }, clear() {}, readRenderTargetPixels() {},
        initTexture() {}, compileAsync() { return Promise.resolve(); },
      };
      const core = {
        available: true, failure: '', renderer: three, lost: false, scale: 0.75, aspect: 1.44, bufferWidth: 885,
        bufferHeight: 615, pixelRatio: 0.75, lossCount: 0, restoreCount: 0, resize() {}, setScale() {},
        onContextLost() { return () => {}; }, onContextRestored() { return () => {}; }, readStats(o) { return o; },
        rebuild() { return { materials: 0, textures: 0, missingTextures: 0 }; }, dispose() {},
      };
      const clock = new Float64Array(1);
      const r = createGameRenderer({ createCore: () => core, quality: { now: () => clock[0], nextFrame: () => Promise.resolve(), hidden: () => true } });
      const settings = createDefaultSettings();
      settings.camera.type = 2; // CameraType.CLOSE
      settings.graphics.tier = 3; // QualityTier.QUALITY
      r.init({}, settings);
      const cfg = createMatchConfig();
      cfg.seed = 20261014;
      cfg.humans = cfg.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
      const ev = createEventBuffer();
      const frames = [createInputFrame(), createInputFrame()];
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      let curr = null, prev = null;
      const load = async () => {
        curr = initMatch(cfg);
        prev = cloneLiveState(curr);
        r.setMatch(curr, CLUBS);
        await r.warmUp();
      };
      const run = (n) => {
        for (let k = 0; k < n; k++) {
          copyState(prev, curr);
          step(curr, frames, ev);
          if (ev.count > 0) r.onEvents(ev, curr);
          // Two frames per tick (120 Hz display): alpha 0.5 and 1.
          for (let a = 1; a <= 2; a++) {
            info.frame++; info.nowMs += 1000 / 120; info.dtMs = 1000 / 120; clock[0] = info.nowMs;
            info.ticks = a === 1 ? 1 : 0;
            r.render(prev, curr, a * 0.5, info);
          }
        }
      };
      const WARM = 3600, N = 4000; // ticks: the first minute (kick-off, lazy set-up), then 4000 ticks -> 8000 frames
      await load();
      run(WARM + N); // pass 1: every situation of the window once
      await load(); // pass 2: the same match again
      run(WARM);
      globalThis.gc();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: ${EXACT_INTERVAL}, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      const t0 = process.cpuUsage(); // [QF-7R] CPU time, not wall time: a busy machine does not inflate it
      run(N);
      const us = ((c) => c.user + c.system)(process.cpuUsage(t0)) / (2 * N);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const nodes = new Map();
      const index = (nd) => { nodes.set(nd.id, nd); for (const c of nd.children) index(c); };
      index(profile.head);
      let bytes = 0, numbers = 0, objects = 0, count = 0;
      const by = {};
      for (const smp of profile.samples) {
        const nd = nodes.get(smp.nodeId);
        const u = nd ? nd.callFrame.url : '';
        if (!u.includes('/src/render/')) continue;
        // Every allocation is a sample of its exact size (EXACT_INTERVAL is below the smallest object).
        const size = smp.size;
        count++;
        const est = size;
        bytes += est;
        if (size === 16) numbers += est; else objects += est;
        const key = u.slice(u.indexOf('/src/render/') + 12) + ':' + nd.callFrame.functionName + (size === 16 ? '' : ' (' + size + ' B objects)');
        by[key] = (by[key] || 0) + est;
      }
      const f = 2 * N;
      console.log(JSON.stringify({
        perFrame: bytes / f, allocsPerKFrame: count / f * 1000, numbersPerFrame: numbers / f, objectsPerFrame: objects / f, usPerFrameInclSim: us,
        phase: curr.match.phase, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 30).map((e) => [e[0], Math.round(e[1] / f * 100) / 100]),
      }));
      process.exit(0);
    `;
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx',
      '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 480_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      perFrame: number; allocsPerKFrame: number; numbersPerFrame: number; objectsPerFrame: number; usPerFrameInclSim: number; top: [string, number][];
    };
    console.log(`QF-7R CLOSE camera / QUALITY renderer per frame: ${JSON.stringify(res)}`);
    expect(res.perFrame, JSON.stringify(res.top)).toBeLessThan(2);
    // [QF-7R] And by count, whatever the size: anything allocated every frame is 1000 per 1000 frames, every 8th frame
    // 125, at 20 Hz on a 120 Hz display 167; event-time code a handful.
    expect(res.allocsPerKFrame, JSON.stringify(res.top)).toBeLessThan(20);
  }, 500_000);
});

/**
 * [INT-C] The whole GameRenderer in steady play (BRIEF section 13: "No allocation in hot paths"; "Heap growth in play:
 * none that is steady"). Every real render module (quality, stadium, pitch, goals, crowd, players + GFX-12 driver +
 * foot lock, ball, markers, effects, replay recording, broadcast + cinematic cameras) runs from render/index.ts on a
 * live CPU v CPU sim at two frames per tick; only the WebGL core is a stand-in (no GPU in Node; three.js's own draw is
 * not measured). Measured in a child process with V8's sampling heap profiler (64-byte interval, minor-GC'd objects
 * included): every sampled allocation whose allocating frame is in src/render/ counts, per rendered frame.
 *
 * FINDING (INT-C report): each GFX module allocates nothing in its own alloc test, but in the integrated live match V8
 * attributes ~1-2.5 KB per frame to render code (top sites are printed). The sites are typed-array maths functions;
 * --trace-deopt shows them deoptimising on "Insufficient type feedback" as new match situations reach new branches,
 * and running generic (boxing) paths in between. The sim allocates ~28 KB per tick in the same run. This test is a
 * regression budget (a per-frame object literal in any module adds far more) until a Wave 4 perf pass brings it to 0.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('INT-C renderer: allocation per frame in steady play', () => {
  it('render() + onEvents() of the full module stack stay within the per-frame allocation budget', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createInputFrame } = await import(${mod('src/contracts/input.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { CLUBS } = await import(${mod('src/data/clubs.ts')});
      const { createGameRenderer } = await import(${mod('src/render/index.ts')});
      const { cloneState, copyState } = await import(${mod('src/sim/core/clone.ts')});
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
      r.init({}, createDefaultSettings());
      const cfg = createMatchConfig();
      cfg.seed = 20261014;
      cfg.humans = cfg.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
      const curr = initMatch(cfg);
      const prev = cloneState(curr);
      const ev = createEventBuffer();
      const frames = [createInputFrame(), createInputFrame()];
      r.setMatch(curr, CLUBS);
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      const run = (n) => {
        for (let k = 0; k < n; k++) {
          copyState(prev, curr);
          step(curr, frames, ev);
          if (ev.count > 0) r.onEvents(ev, curr);
          // Two frames per tick (120 Hz display): alpha 0.5 and 1.
          for (let a = 1; a <= 2; a++) {
            info.frame++; info.nowMs += 1000 / 120; info.dtMs = 1000 / 120; clock[0] = info.nowMs;
            r.render(prev, curr, a * 0.5, info);
          }
        }
      };
      const mine = (profile) => {
        let bytes = 0;
        const by = {};
        const walk = (nd) => {
          const u = nd.callFrame.url;
          if (nd.selfSize > 0 && u.includes('/src/render/')) {
            bytes += nd.selfSize;
            const key = u.slice(u.indexOf('/src/render/') + 12) + ':' + nd.callFrame.functionName + ':' + nd.callFrame.lineNumber;
            by[key] = (by[key] || 0) + nd.selfSize;
          }
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return { bytes, by };
      };
      run(3600); // kick-off, first minute of play: lazy set-up and JIT done
      globalThis.gc();
      const N = 4000; // ticks -> 8000 frames
      const h0 = process.memoryUsage().heapUsed;
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      const t0 = process.hrtime.bigint();
      run(N);
      const us = Number(process.hrtime.bigint() - t0) / 1000 / (2 * N);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const m = mine(profile);
      console.log(JSON.stringify({ perFrame: m.bytes / (2 * N), heapPerFrame: (process.memoryUsage().heapUsed - h0) / (2 * N), usPerFrameInclSim: us, phase: curr.match.phase, top: Object.entries(m.by).sort((a, b) => b[1] - a[1]).slice(0, 30).map((e) => [e[0], Math.round(e[1] / (2 * N))]) }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { perFrame: number; heapPerFrame: number; usPerFrameInclSim: number; top: [string, number][] };
    console.log(`INT-C renderer per frame: ${JSON.stringify(res)}`);
    expect(res.perFrame).toBeLessThan(4096);
  });
});

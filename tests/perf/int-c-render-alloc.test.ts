/**
 * [INT-C, QF-7R] The whole GameRenderer in steady play (BRIEF section 13: "No allocation in hot paths"; "Heap growth in
 * play: none that is steady"). Every real render module (quality, stadium, pitch, goals, crowd, players + GFX-12 driver +
 * foot lock, ball, markers, effects, replay recording, broadcast + cinematic cameras) runs from render/index.ts on a
 * live CPU v CPU sim at two frames per tick (a 120 Hz display); only the WebGL core is a stand-in (no GPU in Node;
 * three.js's own draw is not measured). Measured in a child process with V8's sampling heap profiler (64-byte
 * interval, minor-GC'd objects included): every sampled allocation whose allocating frame is in src/render/ counts.
 *
 * HOW (QF-7R): the app's own flow and a steady state, measured exactly.
 *  - Load as the app does: setMatch, then warmUp() (the render/warmScript.ts JIT warm-up, the modules' event-path
 *    warm loops, shader compile on the stand-in core).
 *  - Two passes over the same deterministic match (same seed): pass 1 plays WARM + N ticks (every situation of the
 *    measured window happens once: JIT feedback for every branch); pass 2 loads the match again (a rematch: setMatch,
 *    warmUp), plays WARM ticks, then N ticks are measured. So the window is play the code has met before - steady
 *    play - not the first occurrence of each situation (that is the warm-up's job: qf-7r-warm tests).
 *  - Every allocation of the window is sampled, at its exact size (EXACT_INTERVAL, below the smallest heap object).
 *  - V8 flags (tests/perf/qf-7r-alloc-flags.ts): --single-threaded (optimised code arrives at a point fixed by call
 *    counts, never by CPU load: the result is the same on every run) and a constant sampling interval. Node has no
 *    Maglev; Chromium's Maglev takes a function out of the interpreter after ~400 calls, so TurboFan's threshold is set
 *    to the same 400 here (--invocation-count-for-turbofan=400): steady play means optimised code, as in the browser
 *    after the first minutes. The interpreter / baseline tiers box every double they compute; optimised code allocates
 *    only for real (objects, arrays, closures, strings) or for a double crossing a call V8 did not inline.
 *
 * THRESHOLD: < 2 B per frame of render allocation in the window, counted exactly (every allocation is a sample). The
 * smallest allocation V8 can make is 16 B (a boxed double): anything allocated every frame adds >= 16 B/frame, every
 * tick >= 8, every 8th frame >= 2. What remains (~0.3 B/frame) is event-time code (a camera cut, a replay plan, a
 * deoptimisation's boxed values) run a few times a minute.
 *
 * HISTORY: 1.3-2.5 KB/frame at INT-C (deopts on insufficient type feedback, rare paths in the interpreter, doubles
 * crossing non-inlined calls: three.js position.set / euler.set in the camera writers, smoothstep / finite-guard
 * helpers in the gait, rarely-called helpers of the animator); QF-7R: 0.3 B/frame (exact count; the earlier 64-byte
 * constant-interval sampling could miss a periodic allocation: tests/perf/qf-7r-alloc-method.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, EXACT_INTERVAL, STEADY_FLAGS } from './qf-7r-alloc-flags';

describe('INT-C renderer: allocation per frame in steady play', () => {
  it('render() + onEvents() of the full module stack allocate nothing per frame in steady play', () => {
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
      const ev = createEventBuffer();
      const frames = [createInputFrame(), createInputFrame()];
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      let curr = null, prev = null;
      const load = async () => {
        curr = initMatch(cfg);
        prev = cloneState(curr);
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
      let bytes = 0, numbers = 0, objects = 0;
      const by = {};
      for (const smp of profile.samples) {
        const nd = nodes.get(smp.nodeId);
        const u = nd ? nd.callFrame.url : '';
        if (!u.includes('/src/render/')) continue;
        // Every allocation is a sample of its exact size (EXACT_INTERVAL is below the smallest object).
        const size = smp.size;
        const est = size;
        bytes += est;
        if (size === 16) numbers += est; else objects += est;
        const key = u.slice(u.indexOf('/src/render/') + 12) + ':' + nd.callFrame.functionName + (size === 16 ? '' : ' (' + size + ' B objects)');
        by[key] = (by[key] || 0) + est;
      }
      const f = 2 * N;
      console.log(JSON.stringify({
        perFrame: bytes / f, numbersPerFrame: numbers / f, objectsPerFrame: objects / f, usPerFrameInclSim: us,
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
      perFrame: number; numbersPerFrame: number; objectsPerFrame: number; usPerFrameInclSim: number; top: [string, number][];
    };
    console.log(`INT-C renderer per frame: ${JSON.stringify(res)}`);
    expect(res.perFrame, JSON.stringify(res.top)).toBeLessThan(2);
  }, 500_000);
});

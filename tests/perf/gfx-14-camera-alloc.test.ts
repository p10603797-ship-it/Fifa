/**
 * [GFX-14] The broadcast camera's per-frame update (follow, lead, apex tilt, framing solve with touch zones, glides
 * after restarts, End to End) and its projector allocate nothing. Measured in a child process with V8's sampling heap
 * profiler (64-byte interval, minor-GC'd objects included): every sampled allocation whose allocating frame is in
 * src/render/camera/broadcast.ts counts. A 16-byte boxed number per frame over 100k frames would read ~16 bytes/frame.
 * The raw heap delta of the whole loop is logged too (it also contains the harness's own boxing at call boundaries).
 * One camera instance switches type through setSettings, as in the app (one GameRenderer per page); types are visited
 * Broadcast, Wide, Close, End to End, then Broadcast and End to End again.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from './qf-7r-alloc-flags';

describe('GFX-14 zero allocation per frame', () => {
  it('update() and the projector allocate nothing per frame for every camera type', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createBroadcastCamera } = await import(${mod('src/render/camera/broadcast.ts')});
      const { fillInterp } = await import(${mod('src/render/index.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      /** Bytes per iteration allocated with a broadcast.ts frame on top of the stack. */
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.endsWith('render/camera/broadcast.ts')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const res = {};
      const settings = createDefaultSettings();
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), settings, clubs: [],
        size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 }, tier: 2, cameraSettings: { type: 0, height: 10, zoom: 20 },
        reducedMotion: false, night: false };
      const cam = createBroadcastCamera(ctx);
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      const interp = createInterpState();
      const frame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      cam.setMatch(s, []);
      const sp = { x: 0, y: 0 }, pp = { x: 0, z: 0 };
      const acc = new Float64Array(1);
      const N = 2400;
      const pathX = new Float64Array(N), pathY = new Float64Array(N), pathZ = new Float64Array(N);
      const pathVx = new Float64Array(N), pathVy = new Float64Array(N), pathVz = new Float64Array(N);
      for (let k = 0; k < N; k++) {
        // A loop over the pitch (no wrap-around jump), a lofted ball every few seconds, 6 m restart placements.
        const t = k / 60, w = (2 * Math.PI * k) / N;
        pathX[k] = 48 * Math.sin(w); pathZ[k] = 30 * Math.sin(2 * w) + (k % 600 < 300 ? 0 : 6);
        pathY[k] = 0.11 + Math.max(0, 14 * Math.sin(t * 1.9 * 1.0526));
        pathVx[k] = 7.5 * Math.cos(w); pathVz[k] = 9.4 * Math.cos(2 * w); pathVy[k] = 26 * Math.cos(t * 2);
      }
      const b = s.ball;
      const pos = new Int32Array(1); // path index carried across runs (no jump between measured loops)
      let pass = 0;
      for (const type of [0, 1, 2, 3, 0, 3]) {
        ctx.cameraSettings = { type, height: 10, zoom: 20 };
        cam.setSettings(ctx.cameraSettings, false);
        const runCam = (n) => {
          for (let j = 0; j < n; j++) {
            const i = pos[0]++ % N;
            b.x = pathX[i]; b.y = pathY[i]; b.z = pathZ[i]; b.vx = pathVx[i]; b.vy = pathVy[i]; b.vz = pathVz[i];
            b.owner = (j >> 6) % 3 === 0 ? 9 : (j >> 6) % 3 === 1 ? 20 : -1;
            fillInterp(interp, s, s, 1);
            cam.update(frame);
          }
        };
        const runProj = (n) => {
          for (let k = 0; k < n; k++) {
            const i = k % N;
            if (cam.pitchToScreen(pathX[i], pathY[i], pathZ[i], sp)) acc[0] += sp.y;
            if (cam.screenToPitch(300 + (k & 511) * 1.37, 300 + (k & 255) * 0.93, pp)) acc[0] += pp.x;
            acc[0] += cam.stickRotation();
          }
        };
        const measure = async (fn) => {
          fn(30000); // warm up / optimise
          globalThis.gc();
          const h0 = process.memoryUsage().heapUsed;
          await session.post('HeapProfiler.startSampling', {
            samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
          });
          fn(100000);
          const { profile } = await session.post('HeapProfiler.stopSampling');
          return { mine: mine(profile, 100000), heap: (process.memoryUsage().heapUsed - h0) / 100000 };
        };
        const cuts0 = cam.cuts;
        const c = await measure(runCam);
        const p = await measure(runProj);
        const t0 = process.hrtime.bigint();
        runCam(20000);
        res['pass' + pass++ + '-type' + type] = {
          camBytes: c.mine, camHeap: c.heap, projBytes: p.mine, projHeap: p.heap,
          usPerFrame: Number(process.hrtime.bigint() - t0) / 20000 / 1000, finite: Number.isFinite(acc[0]), cuts: cam.cuts - cuts0,
        };
      }
      console.log(JSON.stringify(res));
    `;
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, {
      camBytes: number; camHeap: number; projBytes: number; projHeap: number; usPerFrame: number; finite: boolean; cuts: number;
    }>;
    console.log(`GFX-14 camera per frame: ${JSON.stringify(res)}`);
    const keys = Object.keys(res);
    expect(keys).toHaveLength(6);
    for (const k of keys) {
      expect(res[k]!.finite, k).toBe(true);
      expect(res[k]!.camBytes, `${k} update()`).toBeLessThan(0.5);
      expect(res[k]!.projBytes, `${k} projector`).toBeLessThan(0.5);
      // The 6 m restart placements glide: no cuts while the ball moves continuously.
      expect(res[k]!.cuts, k).toBe(0);
      // Budget: the whole camera is a few microseconds per frame (sim + AI own the 2.5 ms; render frame 16 ms).
      expect(res[k]!.usPerFrame, k).toBeLessThan(60);
    }
  });
});

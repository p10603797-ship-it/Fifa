/**
 * [GFX-05] The stadium's per-frame update() (LED scroll, sky following the camera, debug view override) allocates
 * nothing. Measured in a child process with V8's sampling heap profiler (64-byte interval, minor-GC'd objects
 * included): every sampled allocation whose allocating frame is in src/render/stadium.ts counts. Pauses, long frames,
 * reduced camera motion and a debug view are mixed in.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-05 zero allocation per frame', () => {
  it('update() allocates nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createStadium } = await import(${mod('src/render/stadium.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.endsWith('render/stadium.ts')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const settings = createDefaultSettings();
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(22, 1.44, 2, 600), settings,
        clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: 2, cameraSettings: settings.camera,
        reducedMotion: false, night: false };
      const st = createStadium(ctx);
      const cfg = createMatchConfig();
      cfg.night = 1;
      const s = initMatch(cfg);
      st.setMatch(s, []);
      const interp = createInterpState();
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      const frame = { prev: s, curr: s, alpha: 1, frame: info, interp };
      const run = (n) => {
        for (let k = 0; k < n; k++) {
          info.paused = (k & 1023) > 1000;
          info.dtMs = (k & 255) === 0 ? 250 : 1000 / 60;
          ctx.reducedMotion = (k & 4095) > 4000;
          ctx.camera.position.x = (k % 600) * 0.1 - 30;
          st.update(frame);
        }
      };
      st.debug.view('far');
      run(5000);
      st.debug.view('');
      run(30000);
      globalThis.gc();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      run(100000);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const bytes = mine(profile, 100000);
      st.debug.view('corner');
      run(5000);
      globalThis.gc();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      run(50000);
      const p2 = await session.post('HeapProfiler.stopSampling');
      const viewBytes = mine(p2.profile, 50000);
      const t0 = process.hrtime.bigint();
      run(20000);
      console.log(JSON.stringify({ bytes, viewBytes, usPerFrame: Number(process.hrtime.bigint() - t0) / 20000 / 1000,
        offset: st.debug.snapshot().boardOffset }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytes: number; viewBytes: number; usPerFrame: number; offset: number };
    console.log(`GFX-05 stadium per frame: ${JSON.stringify(res)}`);
    expect(res.offset).toBeGreaterThanOrEqual(0);
    expect(res.offset).toBeLessThan(1);
    expect(res.bytes).toBeLessThan(0.5);
    expect(res.viewBytes).toBeLessThan(0.5);
    expect(res.usPerFrame).toBeLessThan(30);
  });
});

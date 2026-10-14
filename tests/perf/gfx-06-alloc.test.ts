/**
 * [GFX-06] The crowd's per-frame update() and onEvents() allocate nothing. Measured in a child process with V8's
 * sampling heap profiler (64-byte interval, minor-GC'd objects included): every sampled allocation whose allocating
 * frame is in src/render/crowd.ts counts. Events cycle through GOAL, SHOT, NEAR_MISS, POST, SAVE and ATTACK_BUILD so
 * every reaction path runs, with pauses and long frames mixed in.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-06 zero allocation per frame', () => {
  it('update() and onEvents() allocate nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createCrowd } = await import(${mod('src/render/crowd.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.endsWith('render/crowd.ts')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const settings = createDefaultSettings();
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), settings, clubs: [],
        size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: 2, cameraSettings: settings.camera,
        reducedMotion: false, night: false };
      const crowd = createCrowd(ctx);
      const s = initMatch(createMatchConfig());
      crowd.setMatch(s, []);
      const interp = createInterpState();
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      const frame = { prev: s, curr: s, alpha: 1, frame: info, interp };
      const types = [9, 14, 21, 2, 8, 27];
      const ev = { type: 9, tick: 0, a: 0, b: 0, c: 0.5, d: 0, x: 0, y: 0, z: 0 };
      const buf = { count: 1, get: () => ev, begin() {}, emit() {} };
      const run = (n) => {
        for (let k = 0; k < n; k++) {
          info.paused = (k & 1023) > 1000;
          info.dtMs = (k & 255) === 0 ? 250 : 1000 / 60;
          if ((k & 63) === 0) {
            ev.type = types[(k >> 6) % types.length];
            ev.a = (k >> 7) & 1 ? 9 : 1;
            crowd.onEvents(buf, s);
          }
          crowd.update(frame);
        }
      };
      run(30000);
      globalThis.gc();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      run(100000);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const t0 = process.hrtime.bigint();
      run(20000);
      console.log(JSON.stringify({ bytes: mine(profile, 100000), usPerFrame: Number(process.hrtime.bigint() - t0) / 20000 / 1000,
        excitement: crowd.excitement }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytes: number; usPerFrame: number; excitement: number };
    console.log(`GFX-06 crowd per frame: ${JSON.stringify(res)}`);
    expect(Number.isFinite(res.excitement)).toBe(true);
    expect(res.bytes).toBeLessThan(0.5);
    expect(res.usPerFrame).toBeLessThan(30);
  });
});

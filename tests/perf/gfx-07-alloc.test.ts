/**
 * [GFX-07] The player model's per-frame update allocates nothing: measured in a child process with V8's sampling
 * heap profiler (64-byte interval, objects collected by minor and major GC included). Every sampled allocation whose
 * allocating frame is in src/render/players/ (model.ts, fk.ts, parts.ts) counts. 22 players run, turn and change
 * height; one is sent off and back; poses come from a driver cycling through kick, crouch, dive and run poses with
 * setPose (the model's own path), then from the default driver (mapper stub API, which belongs to GFX-12 and is not
 * counted). Also reports the cost per frame.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-07 zero allocation per frame', () => {
  it('update() (FK, ground, placement, instance matrices) allocates nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createPose, PoseIdx } = await import(${mod('src/contracts/render.ts')});
      const { CLUBS } = await import(${mod('src/data/clubs.ts')});
      const { createPlayerModel } = await import(${mod('src/render/players/model.ts')});
      const { fillInterp } = await import(${mod('src/render/index.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.includes('render/players/')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const settings = createDefaultSettings();
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), settings, clubs: [],
        size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: 2, cameraSettings: { type: 0, height: 10, zoom: 20 },
        reducedMotion: false, night: false };
      const model = createPlayerModel(ctx);
      const s = initMatch(createMatchConfig());
      model.setMatch(s, CLUBS);
      const interp = createInterpState();
      const frame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      // Pose bank: kick, crouch, dive, run (prebuilt; the driver below allocates nothing).
      const bank = [createPose(), createPose(), createPose(), createPose()];
      bank[0][PoseIdx.HIP_R_PITCH] = 0.9; bank[0][PoseIdx.KNEE_L] = 0.3; bank[0][PoseIdx.SHOULDER_L_ROLL] = 0.8;
      bank[1][PoseIdx.ROOT_Y] = -0.3; bank[1][PoseIdx.KNEE_L] = 1.2; bank[1][PoseIdx.KNEE_R] = 1.2;
      bank[2][PoseIdx.ROOT_ROLL] = 1.3; bank[2][PoseIdx.ROOT_Y] = 0.2; bank[2][PoseIdx.SHOULDER_L_PITCH] = 2.8;
      bank[3][PoseIdx.HIP_L_PITCH] = 0.5; bank[3][PoseIdx.HIP_R_PITCH] = -0.5; bank[3][PoseIdx.ELBOW_L] = 1.2;
      const k = new Int32Array(1);
      const driver = (f, sink) => { for (let i = 0; i < 22; i++) sink.setPose(i, bank[(i + k[0]) & 3]); };
      const runFrames = (n) => {
        for (let j = 0; j < n; j++) {
          const t = k[0]++;
          for (let i = 0; i < 22; i++) {
            const p = s.players[i];
            const a = t * 0.01 + i;
            p.x = 40 * Math.sin(a * 0.3); p.z = 25 * Math.cos(a * 0.2); p.vx = 5; p.vz = 1;
            p.fx = Math.cos(a); p.fz = Math.sin(a);
            s.attrs[i].height = 170 + ((t + i) % 30);
          }
          s.players[13].active = (t >> 7) & 1;
          fillInterp(interp, s, s, 1);
          frame.frame.frame++;
          model.update(frame);
        }
      };
      const measure = async (fn) => {
        fn(3000);
        globalThis.gc();
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        fn(20000);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return mine(profile, 20000);
      };
      const res = {};
      model.setPoseDriver(driver);
      res.setPoseBytes = await measure(runFrames);
      let t0 = process.hrtime.bigint();
      runFrames(5000);
      res.usPerFrame = Number(process.hrtime.bigint() - t0) / 5000 / 1000;
      model.setPoseDriver(null);
      res.defaultDriverBytes = await measure(runFrames);
      const m = model.meshes[1].instanceMatrix.array;
      res.finite = Array.from(m).every(Number.isFinite);
      console.log(JSON.stringify(res));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { setPoseBytes: number; defaultDriverBytes: number; usPerFrame: number; finite: boolean };
    console.log(`GFX-07 player model per frame: ${JSON.stringify(res)}`);
    expect(res.finite).toBe(true);
    expect(res.setPoseBytes).toBeLessThan(0.5);
    expect(res.defaultDriverBytes).toBeLessThan(0.5);
    // Budget: FK + placement for 22 players is far below a millisecond (render frame budget 16 ms).
    expect(res.usPerFrame).toBeLessThan(400);
  });
});

/**
 * [GFX-16] Replay recording, replay playback (frame substitution, angle cuts, slow motion, start / stop on the REPLAY
 * phase) and the effects (trail, puffs, grass, flash) allocate nothing per frame. Measured in a child process with V8's
 * sampling heap profiler (64-byte interval, minor-GC'd objects included): every sampled allocation whose allocating
 * frame is in src/render/replay.ts or src/render/effects.ts counts. A scripted 20 s cycle (play with a hard shot, a
 * slide and a goal, the goal phase, a REPLAY phase with playback, kick-off) repeats through the measured loop.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-16 zero allocation per frame', () => {
  it('replay record / playback and effects allocate nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createReplay } = await import(${mod('src/render/replay.ts')});
      const { createEffects } = await import(${mod('src/render/effects.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const bytesIn = (profile, n, file) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.endsWith(file)) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const cam = new THREE.PerspectiveCamera(22, 1180 / 820, 2, 600);
      cam.position.set(0, 24, 74); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: cam, settings: createDefaultSettings(), clubs: [],
        size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 }, tier: 3, cameraSettings: { type: 0, height: 10, zoom: 10 },
        reducedMotion: false, night: false };
      const rep = createReplay(ctx);
      const fx = createEffects(ctx);
      fx.setQuality(3);
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      rep.setMatch(s, []);
      fx.setMatch(s, []);
      fx.warmUp();
      const interp = createInterpState();
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      const frame = { prev: s, curr: s, alpha: 1, frame: info, interp };
      // Preallocated events.
      const evGoal = { type: 9, tick: 0, a: 0, b: 9, c: -1, d: 0, x: 0, y: 0, z: 0 };
      const evToReplay = { type: 11, tick: 0, a: 9, b: 10, c: 0, d: 0, x: 0, y: 0, z: 0 };
      const evFromReplay = { type: 11, tick: 0, a: 10, b: 1, c: 0, d: 0, x: 0, y: 0, z: 0 };
      const evs = { one: evGoal, count: 0, get() { return this.one; }, begin() {}, emit() {} };
      const pos = new Int32Array(2); // [cycle frame, tick]
      const CYCLE = 1200;
      const run = (n) => {
        for (let j = 0; j < n; j++) {
          const k = pos[0]++ % CYCLE;
          const tick = ++pos[1];
          s.tick = tick;
          const b = s.ball;
          if (k < 700) {
            s.match.phase = 2;
            const u = k / 700;
            b.x = -40 + 92 * u; b.y = 0.11 + (k % 120 < 60 ? (k % 60) * 0.05 : 0); b.z = 10 - 10 * u;
            b.vx = k > 600 ? 30 : 8; b.vy = 0; b.vz = 0; b.owner = k > 600 ? -1 : 9; b.heldBy = -1; b.shotBy = k > 600 ? 9 : -1;
            b.inNet = k > 690 ? 1 : 0;
            for (let i = 0; i < 22; i++) {
              const p = s.players[i];
              p.x = -50 + i * 4 + u * 10; p.z = (i % 7) * 3 - 9; p.vx = 4; p.vz = 0; p.fx = 1; p.fz = 0;
              p.act = i === 6 && k % 200 < 40 ? 10 : 0;
            }
          } else if (k < 760) {
            if (k === 700) { s.match.goalTick = tick; s.match.phase = 8; evs.one = evGoal; evs.count = 1; rep.onEvents(evs, s); fx.onEvents(evs, s); }
          } else if (k < 1160) {
            if (k === 760) { s.match.phase = 10; evs.one = evToReplay; evs.count = 1; rep.onEvents(evs, s); fx.onEvents(evs, s); }
          } else {
            if (k === 1160) { s.match.phase = 1; evs.one = evFromReplay; evs.count = 1; rep.onEvents(evs, s); fx.onEvents(evs, s); }
            b.x = 0; b.y = 0.11; b.z = 0; b.inNet = 0; b.vx = 0; b.shotBy = -1;
          }
          frame.prev = s; frame.curr = s; frame.alpha = 1;
          for (let i = 0; i < 22; i++) {
            const p = s.players[i];
            interp.x[i] = p.x; interp.z[i] = p.z; interp.vx[i] = p.vx; interp.vz[i] = p.vz; interp.fx[i] = p.fx; interp.fz[i] = p.fz;
          }
          interp.ballX = b.x; interp.ballY = b.y; interp.ballZ = b.z;
          rep.update(frame);
          fx.update(frame);
        }
      };
      run(CYCLE * 10); // warm up / optimise
      globalThis.gc();
      const N = CYCLE * 50;
      const h0 = process.memoryUsage().heapUsed;
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      const t0 = process.hrtime.bigint();
      run(N);
      const us = Number(process.hrtime.bigint() - t0) / N / 1000;
      const { profile } = await session.post('HeapProfiler.stopSampling');
      console.log(JSON.stringify({
        replay: bytesIn(profile, N, 'render/replay.ts'), effects: bytesIn(profile, N, 'render/effects.ts'),
        heap: (process.memoryUsage().heapUsed - h0) / N, usPerFrame: us, replays: rep.ring.count > 0,
      }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { replay: number; effects: number; heap: number; usPerFrame: number; replays: boolean };
    console.log(`GFX-16 per frame: ${JSON.stringify(res)}`);
    expect(res.replays).toBe(true);
    expect(res.replay, 'replay.ts bytes / frame').toBeLessThan(0.5);
    expect(res.effects, 'effects.ts bytes / frame').toBeLessThan(0.5);
    expect(res.usPerFrame).toBeLessThan(100);
  });
});

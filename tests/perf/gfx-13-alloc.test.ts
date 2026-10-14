/**
 * [GFX-13] The ball and markers modules allocate nothing per frame and stay cheap. Measured in a child process with
 * V8's sampling heap profiler (64-byte interval, minor-GC'd objects included): every sampled allocation whose
 * allocating frame is in src/render/ball.ts or src/render/markers.ts counts. SIM-01/02 ball physics reached through
 * the landing prediction is logged separately (the sim's own code; the ball path itself is precomputed so the
 * measured loop runs physics only inside predictBall). The scene covers every aid: two humans with markers, colour-blind labels,
 * a charging power bar, the faint next-switch marker, a receiver ring, lofted balls with a landing target and
 * re-predictions after bounces, and the ball leaving the screen (off-screen arrow).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-13 zero allocation per frame', () => {
  it('ball + markers update() allocate nothing per frame and cost a few microseconds', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createBall } = await import(${mod('src/render/ball.ts')});
      const { createMarkers } = await import(${mod('src/render/markers.ts')});
      const { fillInterp } = await import(${mod('src/render/index.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { ballStepTick } = await import(${mod('src/sim/ball/contact.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const bytesIn = (profile, n, test) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && test(nd.callFrame.url)) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const settings = createDefaultSettings();
      settings.accessibility.colourBlindMarkers = true;
      const cam = new THREE.PerspectiveCamera(22, 1180 / 820, 2, 600);
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: cam, settings, clubs: [],
        size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 }, tier: 2, cameraSettings: { type: 0, height: 10, zoom: 10 },
        reducedMotion: false, night: false };
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      s.ctrl[0].kind = 1; s.ctrl[0].side = 0; s.ctrl[0].slot = 9;
      s.ctrl[1].kind = 1; s.ctrl[1].side = 1; s.ctrl[1].slot = 20;
      for (let i = 0; i < 22; i++) { s.players[i].active = 1; s.players[i].x = -40 + i * 4; s.players[i].z = (i % 5) * 5 - 10; }
      const ball = createBall(ctx);
      const markers = createMarkers(ctx);
      ball.setMatch(s, []);
      markers.setMatch(s, []);
      const interp = createInterpState();
      const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
      const frame = { prev: s, curr: s, alpha: 1, frame: info, interp };
      const b = s.ball;
      // Precomputed flight path (sim physics) so the only ball physics in the measured loop is the render's own
      // landing prediction. A loft every 240 frames; the path replays with ticks moving on.
      const P = 2400;
      const path = new Float64Array(P * 8);
      const kickRel = new Int32Array(P), bnc = new Int32Array(P);
      let kick = 0;
      for (let i = 0; i < P; i++) {
        if (i % 240 === 0) {
          b.x = -20 + (i % 40); b.y = 0.11; b.z = (i % 30) - 15; b.vx = 14; b.vy = 12; b.vz = 2;
          b.sx = 0; b.sy = 3; b.sz = 6; b.grounded = 0; b.bounces = 0; kick = i;
        }
        b.px = b.x; b.py = b.y; b.pz = b.z;
        ballStepTick(b, null);
        const o = i * 8;
        path[o] = b.x; path[o + 1] = b.y; path[o + 2] = b.z; path[o + 3] = b.vx; path[o + 4] = b.vy; path[o + 5] = b.vz;
        path[o + 6] = b.grounded; kickRel[i] = kick; bnc[i] = b.bounces;
      }
      b.owner = -1; b.heldBy = -1; b.shotBy = -1; b.inNet = 0; b.lastTouchTeam = 0; b.passTarget = 7; b.sx = 0; b.sy = 3; b.sz = 6;
      s.tick = 0;
      const pos = new Int32Array(1);
      const run = (n) => {
        for (let j = 0; j < n; j++) {
          const k = pos[0]++;
          const i = k % P, base = k - i, o = i * 8;
          b.x = path[o]; b.y = path[o + 1]; b.z = path[o + 2]; b.vx = path[o + 3]; b.vy = path[o + 4]; b.vz = path[o + 5];
          b.grounded = path[o + 6]; b.bounces = bnc[i]; b.lastKickTick = base + kickRel[i]; b.touchedTick = b.lastKickTick;
          s.tick = k + 1;
          // Camera sweeps so the ball leaves the screen for part of every cycle (off-screen arrow).
          const cx = ((k % 600) < 300 ? 0 : 60) - 30;
          cam.position.set(cx, 24, 74);
          cam.lookAt(cx, 0, 0);
          s.ctrl[0].powerBtn = (k >> 5) & 1; s.ctrl[0].power = (k % 60) / 60;
          s.ctrl[0].nextSwitch = (k >> 6) & 1 ? 6 : 8;
          for (let p = 0; p < 22; p++) s.players[p].x += (p & 1 ? 0.01 : -0.01);
          info.nowMs += 1000 / 60; info.frame++;
          fillInterp(interp, s, s, 1);
          ball.update(frame);
          markers.update(frame);
        }
      };
      const measure = async (n) => {
        run(20000);
        globalThis.gc();
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        run(n);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return {
          mine: bytesIn(profile, n, (u) => u.endsWith('render/ball.ts') || u.endsWith('render/markers.ts')),
          physics: bytesIn(profile, n, (u) => u.includes('/sim/ball/')),
        };
      };
      const m = await measure(60000);
      const t0 = process.hrtime.bigint();
      run(20000);
      const us = Number(process.hrtime.bigint() - t0) / 20000 / 1000;
      console.log(JSON.stringify({ ...m, usPerFrame: us, overlay: markers.overlay.geometry.drawRange.count, landings: markers.landing.predictions }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { mine: number; physics: number; usPerFrame: number; landings: number };
    console.log(`GFX-13 per frame: ${JSON.stringify(res)}`);
    expect(res.mine).toBeLessThan(0.5);
    // SIM-01/02 ball physics reached through predictBall is the sim's own code (reported to the lead when it
    // allocates); the render only predicts when a flight changes, never per frame.
    expect(res.landings).toBeGreaterThan(10); // the landing target really re-predicted during the run
    expect(res.landings).toBeLessThan(100000 / 20); // ... but nowhere near once per frame
    // Ball + aids are a small slice of a 16 ms frame (the sim tick is not included: ballStepTick runs in the loop).
    expect(res.usPerFrame).toBeLessThan(100);
  });
});

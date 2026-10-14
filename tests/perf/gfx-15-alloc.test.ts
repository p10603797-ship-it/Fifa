/**
 * [GFX-15] The cinematic camera director allocates nothing per frame: a scripted cycle runs every shot (main camera,
 * behind the taker with a blend to a nearby re-award and the shot hold, corner, goal kick, penalty, establishing orbit,
 * replay side / behind-goal angles through the real GFX-16 playback) plus the projector and stick rotation, in the
 * index.ts frame order (replay, broadcast, cinematic), measured after the JIT has settled, in a child process over an
 * allocation-free harness (precomputed inputs, small-integer projector arguments, preallocated events):
 *  - per frame: V8's sampling heap profiler, allocations in cinematic.ts outside a switch / event stack: < 0.5 B;
 *  - per switch (a cut or blend starting): small bound; whole pipeline: exact young-generation delta, far below one
 *    boxed number per frame (it includes GFX-14's and GFX-16's event-time costs).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GFX-15 zero allocation per frame', () => {
  it('director, shots, blends, replay angles and the projector allocate nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const THREE = await import('three');
      const v8 = await import('node:v8');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createBroadcastCamera } = await import(${mod('src/render/camera/broadcast.ts')});
      const { createCinematicCamera } = await import(${mod('src/render/camera/cinematic.ts')});
      const { createReplay } = await import(${mod('src/render/replay.ts')});
      const { fillInterp } = await import(${mod('src/render/index.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), settings: createDefaultSettings(),
        clubs: [], size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 }, tier: 2, cameraSettings: { type: 0, height: 10, zoom: 10 },
        reducedMotion: false, night: false };
      const bc = createBroadcastCamera(ctx);
      const cine = createCinematicCamera(ctx);
      const rep = createReplay(ctx);
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      bc.setMatch(s, []);
      rep.setMatch(s, []);
      cine.setMatch(s, []);
      const interp = createInterpState();
      const frame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      class Ev { constructor(t, a, b) { this.type = t; this.tick = 0; this.a = a; this.b = b; this.c = 0; this.d = 0; this.x = 0; this.y = 0; this.z = 0; } }
      class Buf { constructor() { this.one = null; this.count = 1; } get() { return this.one; } begin() {} emit() {} }
      const evs = new Buf();
      const evAward = new Ev(15, 5, 0), evToReplay = new Ev(11, 9, 10), evFromReplay = new Ev(11, 10, 1), evPhase = new Ev(11, 2, 6);
      const send = (e) => { evs.one = e; cine.onEvents(evs, s); bc.onEvents && bc.onEvents(evs, s); rep.onEvents(evs, s); };
      // Script: [startFrame, phase, restartKind, team, x, z, shotBy] per segment of a 2400-frame cycle.
      const SEG = [
        [0, 2, 0, 0, 0, 0, -1],        // in play (recorded; ball runs to the +x goal)
        [500, 6, 5, 0, 30, 8, -1],     // free kick near goal: behind the taker
        [560, 6, 5, 0, 31.5, 6.8, -1], // re-spotted close by (set up): blend
        [620, 2, 0, 0, 0, 0, 9],       // taken as a shot: hold
        [720, 5, 4, 0, 51.9, 33.4, -1],// corner
        [780, 4, 3, 1, 47, 4.6, -1],   // goal kick
        [840, 7, 6, 0, 41.5, 0, -1],   // penalty
        [900, 2, 0, 0, 0, 0, -1],      // in play, ball to the goal
        [1300, 8, 0, 0, 0, 0, -1],     // goal
        [1360, 9, 0, 0, 0, 0, -1],     // celebration
        [1500, 10, 0, 0, 0, 0, -1],    // replay (playback: side, then behind goal)
        [1940, 11, 0, 0, 0, 0, -1],    // half time: establishing orbit
        [2140, 0, 0, 0, 0, 0, -1],     // pre-match orbit
        [2300, 1, 0, 0, 0, 0, -1],     // kick-off
      ];
      const CYCLE = 2400;
      const BX = new Float64Array(CYCLE), BZ = new Float64Array(CYCLE);
      for (let k = 0; k < CYCLE; k++) {
        const u = (k % 400) / 400;
        BX[k] = -40 + 92 * u; BZ[k] = 6 - 12 * u;
      }
      const st = new Int32Array(4); // [frame, tick, segment, events]
      const acc = new Float64Array(1);
      const sp = { x: 0.5, y: 0.5 }, pp = { x: 0.5, z: 0.5 };
      function step() {
        const k = st[0]++ % CYCLE;
        const tick = ++st[1];
        s.tick = tick;
        let seg = 0;
        for (let i = 0; i < SEG.length; i++) if (SEG[i][0] <= k) seg = i;
        const row = SEG[seg];
        const b = s.ball;
        if (row[0] === k) {
          const from = s.match.phase;
          s.match.phase = row[1];
          if (row[2] > 0) {
            const r = s.match.restart;
            // [QF-4] A new award is set up 50 ticks later (ready below); the frame-560 row re-spots the set-up free kick
            // 2 m away (no new award), which blends.
            const respot = row[0] === 560;
            r.kind = row[2]; r.team = row[3]; r.x = row[4]; r.z = row[5]; r.ready = respot ? 1 : 0; r.taken = 0;
            if (!respot) { evAward.a = row[2]; evAward.b = row[3]; send(evAward); }
            b.x = row[4]; b.z = row[5]; b.vx = 0; b.vz = 0;
          }
          if (row[1] === 8) s.match.goalTick = tick;
          if (row[1] === 10) send(evToReplay);
          else if (from === 10) send(evFromReplay);
          else { evPhase.a = from; evPhase.b = row[1]; send(evPhase); }
        }
        b.shotBy = row[6];
        // [QF-4] The restart is set up (RUL-11 ready) 50 ticks after the award: set-piece shots start then.
        if (row[2] > 0 && (k - row[0] >= 50 || row[0] === 560)) s.match.restart.ready = 1;
        if (row[1] === 2 || row[1] === 8) { b.x = BX[k]; b.z = BZ[k]; b.vx = 9; b.inNet = row[1] === 8 ? 1 : 0; }
        b.y = 0.11;
        fillInterp(interp, s, s, 1);
        frame.prev = s; frame.curr = s; frame.alpha = 1;
        rep.update(frame);
        bc.update(frame);
        cine.update(frame);
        // Small-integer arguments: the harness itself must not box doubles at the call.
        if (cine.pitchToScreen((k % 80) - 40, 0, (k % 50) - 25, sp)) acc[0] += sp.x;
        if (cine.screenToPitch(300 + (k & 511), 300 + (k & 255), pp)) acc[0] += pp.x;
        acc[0] += cine.stickRotation();
      }
      function run(n) { for (let j = 0; j < n; j++) step(); }
      const young = () => { const a = v8.getHeapSpaceStatistics(); for (const x of a) if (x.space_name === 'new_space') return x.space_used_size; return 0; };
      const bytes = (n) => { globalThis.gc(); const h0 = young(); run(n); return young() - h0; };
      run(CYCLE * 25); // warm up: the JIT settles
      bytes(0);
      const probe = bytes(0);
      const cuts0 = cine.cuts, blends0 = cine.blends;
      const N = CYCLE * 40;
      // Allocations sampled by V8 (64-byte interval) and classified by stack: anything under a switch / event function
      // (a cut or blend starting, the sim's events, a replay starting, GFX-14's own cut) is per event; the rest is per frame.
      const { Session } = await import('node:inspector/promises');
      const session = new Session();
      session.connect();
      await session.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      const t0 = process.hrtime.bigint();
      const total = (bytes(N) - probe) / N;
      const us = Number(process.hrtime.bigint() - t0) / N / 1000;
      const { profile } = await session.post('HeapProfiler.stopSampling');
      session.disconnect();
      const EVENT = new Set(['transition', 'onEvents', 'start', 'stop', 'startForPhase', 'syncLive', 'cutToBall', 'snapTo', 'send']);
      let frameBytes = 0, eventBytes = 0;
      const walk = (nd, inEvent) => {
        const ev = inEvent || EVENT.has(nd.callFrame.functionName);
        if (nd.selfSize > 0 && nd.callFrame.url.endsWith('render/camera/cinematic.ts')) { if (ev) eventBytes += nd.selfSize; else frameBytes += nd.selfSize; }
        for (const c of nd.children) walk(c, ev);
      };
      walk(profile.head, false);
      const switches = (cine.cuts - cuts0) + (cine.blends - blends0);
      console.log(JSON.stringify({ perFrame: frameBytes / N, perSwitch: eventBytes / Math.max(1, switches), total, usPerFrame: us,
        cutsPerCycle: (cine.cuts - cuts0) / 40, blendsPerCycle: (cine.blends - blends0) / 40, finite: Number.isFinite(acc[0]) }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--no-concurrent-recompilation', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      perFrame: number; perSwitch: number; total: number; usPerFrame: number; cutsPerCycle: number; blendsPerCycle: number; finite: boolean;
    };
    console.log(`GFX-15 per frame: ${JSON.stringify(res)}`);
    expect(res.finite).toBe(true);
    // Every shot ran: cuts into / out of the set pieces, the orbits and the two replay angles; one blend per cycle.
    expect(res.cutsPerCycle).toBeGreaterThanOrEqual(8);
    expect(res.blendsPerCycle).toBeGreaterThanOrEqual(1);
    expect(res.perFrame, 'cinematic.ts bytes / frame outside switches').toBeLessThan(0.5);
    // A switch (cut / blend start) may allocate a little while its code is not optimised (rare by nature).
    expect(res.perSwitch, 'cinematic.ts bytes / switch').toBeLessThan(4096);
    // Whole pipeline (replay + broadcast + cinematic + projector, events included): far below one boxed number per frame.
    expect(res.total, 'young-generation bytes / frame, everything').toBeLessThan(8);
    expect(res.usPerFrame).toBeLessThan(100);
  });
});

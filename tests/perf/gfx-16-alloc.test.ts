/**
 * [GFX-16] Replay recording, replay playback (frame substitution, angle cuts, slow motion, start / stop on the REPLAY
 * phase) and the effects (trail, puffs, grass, flash) allocate nothing per frame. Exact heap deltas in a child process
 * (gc before, a 256 MB young generation so no GC runs inside the loop) over an allocation-free harness: per-frame
 * inputs are precomputed in typed arrays, events are preallocated class instances. A scripted 20 s cycle repeats:
 * play with a hard shot, a slide and the ball entering the net, the GOAL phase, a REPLAY phase with playback (two
 * angles, a replayed net entry), kick-off.
 *  - steady: the cycle without events (recording, effects; the replay is started outside the measured frames);
 *  - full: the whole cycle with the sim's events (replay start / stop, goal flash) after the event paths are optimised.
 *  - first goal: the first goal sequence of a fresh renderer (JIT still settling) stays under a one-off bound (sampling
 *    heap profiler attribution to the two files, since the harness is not optimised yet either).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, EXACT_INTERVAL } from './qf-7r-alloc-flags';

describe('GFX-16 zero allocation per frame', () => {
  it('replay record / playback and effects allocate nothing per frame', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const THREE = await import('three');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createReplay } = await import(${mod('src/render/replay.ts')});
      const { createEffects } = await import(${mod('src/render/effects.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
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
      const frame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      const CYCLE = 1200;
      const BX = new Float64Array(CYCLE), BY = new Float64Array(CYCLE), BZ = new Float64Array(CYCLE), PX = new Float64Array(CYCLE * 22);
      for (let k = 0; k < CYCLE; k++) {
        const u = Math.min(k, 699) / 700;
        BX[k] = k < 1160 ? -40 + 92 * u : 0; BY[k] = 0.11 + (k < 700 && k % 120 < 60 ? (k % 60) * 0.05 : 0); BZ[k] = k < 1160 ? 10 - 10 * u : 0;
        for (let i = 0; i < 22; i++) PX[k * 22 + i] = -50 + i * 4 + u * 10.5;
      }
      class Ev { constructor(t, a, b) { this.type = t; this.tick = 0; this.a = a; this.b = b; this.c = 0; this.d = 0; this.x = 0; this.y = 0; this.z = 0; } }
      const evGoal = new Ev(9, 0, 9), evTo = new Ev(11, 9, 10), evFrom = new Ev(11, 10, 1);
      class Buf { constructor() { this.one = evGoal; this.count = 1; } get() { return this.one; } begin() {} emit() {} }
      const evs = new Buf();
      const st = new Int32Array(4); // [cycle frame, tick, events on, playbacks seen]
      function step() {
        const k = st[0]++ % CYCLE;
        const tick = ++st[1];
        const events = st[2] === 1;
        s.tick = tick;
        const b = s.ball;
        if (k < 700) {
          s.match.phase = 2;
          b.vx = k > 600 ? 30 : 8; b.owner = k > 600 ? -1 : 9; b.shotBy = k > 600 ? 9 : -1; b.inNet = k > 690 ? 1 : 0;
        } else if (k === 700) {
          s.match.goalTick = tick; s.match.phase = 8;
          if (events) { evs.one = evGoal; rep.onEvents(evs, s); fx.onEvents(evs, s); }
        } else if (k === 760) {
          s.match.phase = 10;
          if (events) { evs.one = evTo; rep.onEvents(evs, s); fx.onEvents(evs, s); }
        } else if (k === 1160) {
          s.match.phase = 1; b.inNet = 0; b.vx = 0; b.shotBy = -1;
          if (events) { evs.one = evFrom; rep.onEvents(evs, s); fx.onEvents(evs, s); }
        }
        b.x = BX[k]; b.y = BY[k]; b.z = BZ[k];
        for (let i = 0; i < 22; i++) {
          const p = s.players[i];
          p.x = PX[k * 22 + i];
          p.act = i === 6 && k % 200 < 40 && k < 700 ? 10 : 0;
          interp.x[i] = p.x; interp.z[i] = p.z; interp.vx[i] = 4; interp.vz[i] = 0; interp.fx[i] = 1; interp.fz[i] = 0;
        }
        interp.ballX = b.x; interp.ballY = b.y; interp.ballZ = b.z;
        frame.prev = s; frame.curr = s;
        rep.update(frame);
        if (rep.playing) st[3]++;
        fx.update(frame);
      }
      function run(n) { for (let j = 0; j < n; j++) step(); }
      // Young-generation bytes (JS objects; JIT code and feedback live elsewhere), minus the probe's own overhead.
      const v8 = await import('node:v8');
      const young = () => { const sp = v8.getHeapSpaceStatistics(); for (const x of sp) if (x.space_name === 'new_space') return x.space_used_size; return 0; };
      const measureBytes = (n) => {
        globalThis.gc();
        const h0 = young();
        run(n);
        return young() - h0;
      };
      measureBytes(0);
      const probe = measureBytes(0);
      const measure = (n) => (measureBytes(n) - probe) / n;
      // First goal sequence of a fresh renderer (event paths still interpreted): a small one-off budget. The harness is
      // still interpreted here too, so this one is attributed by V8's sampling heap profiler to the module files.
      const { Session } = await import('node:inspector/promises');
      const session = new Session();
      session.connect();
      st[2] = 1;
      run(700);
      await session.post('HeapProfiler.startSampling', { samplingInterval: ${EXACT_INTERVAL}, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      run(CYCLE - 700);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      let firstGoal = 0;
      const walk = (nd) => {
        const u = nd.callFrame.url;
        if (nd.selfSize > 0 && (u.endsWith('render/replay.ts') || u.endsWith('render/effects.ts'))) firstGoal += nd.selfSize;
        for (const c of nd.children) walk(c);
      };
      walk(profile.head);
      session.disconnect();
      // Warm the event paths (as many goal sequences would), then measure.
      run(CYCLE * 20);
      for (let i = 0; i < 3000; i++) { rep.start(2 + (i % 6)); rep.stop(); }
      st[2] = 0;
      run(CYCLE * 5);
      st[3] = 0;
      const steady = measure(CYCLE * 40);
      const steadyPlayback = st[3];
      st[2] = 1;
      run(CYCLE * 5);
      st[3] = 0;
      const t0 = process.cpuUsage(); // [QF-7R] CPU time, not wall time: a busy machine does not inflate it
      const full = measure(CYCLE * 40);
      const us = ((c) => c.user + c.system)(process.cpuUsage(t0)) / (CYCLE * 40);
      console.log(JSON.stringify({ steady, full, firstGoal, usPerFrame: us, playbackFrames: st[3], steadyPlayback, recorded: rep.ring.count }));
    `;
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, '--expose-gc', '--no-concurrent-recompilation', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      steady: number; full: number; firstGoal: number; usPerFrame: number; playbackFrames: number; steadyPlayback: number; recorded: number;
    };
    console.log(`GFX-16 per frame: ${JSON.stringify(res)}`);
    // The cycle really exercised playback (40 cycles x ~400 REPLAY frames) and recording.
    expect(res.playbackFrames).toBeGreaterThan(40 * 300);
    expect(res.recorded).toBeGreaterThan(100);
    expect(res.steady, 'bytes / frame without events').toBeLessThan(0.5);
    expect(res.full, 'bytes / frame with the replay events').toBeLessThan(0.5);
    // One-off: before the JIT has re-optimised the playback path for the live objects, the first replay of a match
    // may run partly unoptimised (V8). Bounded so it costs at most one minor GC of a default 16 MB young generation.
    expect(res.firstGoal, 'bytes for the first goal sequence').toBeLessThan(8 * 1024 * 1024);
    expect(res.usPerFrame).toBeLessThan(100);
  });
});

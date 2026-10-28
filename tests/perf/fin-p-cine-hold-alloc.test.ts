/**
 * [FIN-P] The cinematic camera's free-kick shot hold allocates nothing per frame, the first time it happens in a match.
 *
 * Regression for: since FIN-K the int-c / qf-7r renderer allocation windows hold a free kick struck as a shot, and they
 * failed (78 allocations per 1000 frames against 20; top site camera/cinematic.ts holdLosesBall). holdLosesBall reads
 * the interpolated ball and the state's ball velocity and runs only on the frames of a shot hold; warmUpPaths warmed
 * holdLosesBallIn (the maths) but never holdLosesBall itself, so in play it ran unoptimised: a heap number for every
 * double field it read, on every frame of the hold. Fixed by warming holdLosesBall in warmUpPaths on the live state
 * setMatch receives (only read).
 *
 * Child process, exact allocation sampling (tests/perf/qf-7r-alloc-flags.ts, the int-c flags): the module is set up as
 * the renderer does (setMatch, which warms), runs open play long enough for the JIT to settle, then one free kick near
 * goal is awarded, set up and struck as a shot, and every allocation made under holdLosesBall during the hold is
 * counted (the director's own one-off costs of a new shot are not this test's business: gfx-15-alloc covers them).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, EXACT_INTERVAL, STEADY_FLAGS } from './qf-7r-alloc-flags';

describe('fin-p: cinematic shot hold allocation', () => {
  it('fin-p: the first free-kick shot hold of a match allocates nothing in holdLosesBall (warmed on the live state)', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const THREE = await import('three');
      const { Session } = await import('node:inspector/promises');
      const { createDefaultSettings } = await import(${mod('src/contracts/settings.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { MatchPhase, RestartKind } = await import(${mod('src/contracts/enums.ts')});
      const { EventType } = await import(${mod('src/contracts/events.ts')});
      const { createCinematicCamera, CineShot } = await import(${mod('src/render/camera/cinematic.ts')});
      const { fillInterp } = await import(${mod('src/render/index.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const { setShapeSettling } = await import(${mod('src/sim/core/clone.ts')});
      // As the shipped app builds the match state (production builds settle its hidden classes: sim/core/clone.ts).
      setShapeSettling(true);
      const ctx = { renderer: null, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), settings: createDefaultSettings(),
        clubs: [], size: { cssW: 1180, cssH: 820, dpr: 2, scale: 0.75 }, tier: 2, cameraSettings: { type: 0, height: 10, zoom: 10 },
        reducedMotion: false, night: false };
      const cine = createCinematicCamera(ctx);
      const s = initMatch(createMatchConfig());
      s.match.phase = MatchPhase.IN_PLAY;
      // The renderer's frame and interpolated state exist before the match is set (render/index.ts builds them once).
      const interp = createInterpState();
      const frame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      cine.setMatch(s, []);
      class Ev { constructor(t, a, b) { this.type = t; this.tick = 0; this.a = a; this.b = b; this.c = 0; this.d = 0; this.x = 0; this.y = 0; this.z = 0; } }
      class Buf { constructor() { this.one = null; this.count = 1; } get() { return this.one; } begin() {} emit() {} }
      const evs = new Buf();
      const send = (e) => { evs.one = e; cine.onEvents(evs, s); };
      const BX = new Float64Array(400), BZ = new Float64Array(400);
      for (let k = 0; k < 400; k++) { BX[k] = -40 + 0.2 * k; BZ[k] = 6 - 0.03 * k; }
      const b = s.ball;
      const st = new Int32Array(1);
      function frameAt() {
        s.tick = ++st[0];
        fillInterp(interp, s, s, 1);
        cine.update(frame);
      }
      // Open play, the ball rolling about: the director's per-frame paths settle.
      for (let k = 0; k < 6000; k++) { b.x = BX[k % 400]; b.z = BZ[k % 400]; b.y = 0.11; b.vx = 9.5; b.shotBy = -1; frameAt(); }
      // A free kick near goal (behind the taker), set up 50 ticks later.
      const r = s.match.restart;
      send(new Ev(EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.FREE_KICK));
      s.match.phase = MatchPhase.FREE_KICK;
      r.kind = RestartKind.FREE_KICK; r.team = 0; r.x = 30.5; r.z = 8.5; r.ready = 0; r.taken = 0;
      b.x = 30.5; b.z = 8.5; b.vx = 0; b.vz = 0; b.vy = 0;
      send(new Ev(EventType.RESTART_AWARDED, RestartKind.FREE_KICK, 0));
      for (let k = 0; k < 90; k++) { if (k === 50) r.ready = 1; frameAt(); }
      const behind = cine.shot === CineShot.BEHIND_TAKER;
      // Struck as a shot: in play, ball flying at goal and rising a little (in view): the hold runs holdLosesBall per frame.
      send(new Ev(EventType.PHASE_CHANGE, MatchPhase.FREE_KICK, MatchPhase.IN_PLAY));
      s.match.phase = MatchPhase.IN_PLAY;
      r.taken = 1;
      b.shotBy = 9;
      const session = new Session();
      session.connect();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: ${EXACT_INTERVAL}, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      let held = 0;
      for (let k = 0; k < 40; k++) {
        b.x = 30.5 + 0.3 * (k + 1); b.z = 8.5 - 0.05 * (k + 1); b.y = 0.2 + 0.02 * k; b.vx = 18.5; b.vz = -3.5; b.vy = 1.5;
        frameAt();
        if (cine.shot === CineShot.BEHIND_TAKER) held++;
      }
      const { profile } = await session.post('HeapProfiler.stopSampling');
      // Every allocation is one sample of its exact size (EXACT_INTERVAL); count those made under holdLosesBall.
      const under = new Map();
      const index = (nd, u) => { const v = u || nd.callFrame.functionName === 'holdLosesBall'; under.set(nd.id, v); for (const c of nd.children) index(c, v); };
      index(profile.head, false);
      let count = 0, bytes = 0;
      for (const smp of profile.samples) if (under.get(smp.nodeId)) { count++; bytes += smp.size; }
      console.log(JSON.stringify({ behind, held, count, bytes }));
      process.exit(0);
    `;
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { behind: boolean; held: number; count: number; bytes: number };
    console.log(`FIN-P cinematic shot hold: ${JSON.stringify(res)}`);
    // The scene is what it should be: the behind-the-taker view at the set free kick, kept through the hold.
    expect(res.behind).toBe(true);
    expect(res.held).toBeGreaterThanOrEqual(30);
    // Nothing allocated under holdLosesBall (before the fix: a heap number per double field read, every hold frame).
    expect(res.count, JSON.stringify(res)).toBe(0);
  }, 300_000);
});

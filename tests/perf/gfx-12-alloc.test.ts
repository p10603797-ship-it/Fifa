/**
 * [GFX-12] (with GFX-09/10/11) The animation driver allocates nothing per frame: measured in a child process with
 * V8's sampling heap profiler (64-byte interval, objects collected by minor and major GC included). Every sampled
 * allocation whose allocating frame is in src/render/anim/ (mapper, locomotion, actions, contact, poseMath) counts.
 * 22 players run, turn, kick, shoot, tackle, slide, fall, dive, hold the ball, celebrate and teleport, through the full
 * animator (createAnimator().update) and through the stub API the model's default driver uses (mapAnim / advanceCycle
 * / samplePose). Also reports the cost per frame for 22 players. Doubles never cross a call boundary on these paths
 * (module scratch arrays), so V8 does not box them; a long warm-up lets every cold path (action starts) optimise.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from './qf-7r-alloc-flags';

describe('[GFX-12] animation driver: zero allocation per frame, cost', () => {
  it('createAnimator().update and the stub API allocate nothing per frame and stay cheap', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { createPose } = await import(${mod('src/contracts/render.ts')});
      const { createInterpState } = await import(${mod('src/render/types.ts')});
      const M = await import(${mod('src/render/anim/mapper.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const mine = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          if (nd.selfSize > 0 && nd.callFrame.url.includes('render/anim/')) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      const interp = createInterpState();
      const frame = { prev: s, curr: s, alpha: 0.5, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
      const anim = M.createAnimator();
      const sink = { n: 0, setPose(slot, pose) { this.n += pose[0] > 99 ? 1 : 0; } };
      // Action schedule (prebuilt): kind, duration, contact, actA, actB.
      const ACTS = [[0, 60, -1, 0, 0], [1, 18, 8, 0, 0], [2, 24, 10, 0, 0], [8, 28, 6, 0, 0], [10, 66, 4, 0, 0], [14, 70, -1, 0, 0],
        [15, 30, -1, 0, 0], [16, 60, 20, 2, 1], [16, 60, 20, 0, -1], [25, 240, -1, 1, 0], [17, 362, -1, 0, 0], [28, 1, -1, 0, 0]];
      const k = new Int32Array(1);
      const step = (useStub, bank, smp, pose) => {
        const t = k[0]++;
        for (let i = 0; i < 22; i++) {
          const p = s.players[i];
          const a = ACTS[((t >> 6) + i) % ACTS.length];
          p.act = a[0]; p.actDur = a[1]; p.actContact = a[2]; p.actA = a[3]; p.actB = a[4];
          p.actT = (t & 63) % (a[1] + 1) + 1; p.actDone = p.actT >= a[2] ? 1 : 0; p.actKick = 13 + (i & 3);
          const ang = t * 0.02 + i;
          p.fx = Math.cos(ang); p.fz = Math.sin(ang);
          const v = (i % 6) * 1.6;
          p.vx = v * p.fx; p.vz = v * p.fz;
          p.x += p.vx / 60; p.z += p.vz / 60;
          if ((t + i * 37) % 900 === 0) p.x += 10; // teleport now and then
          p.sprinting = i % 3 === 0 ? 1 : 0; p.jockeying = i % 7 === 0 ? 1 : 0;
          interp.x[i] = p.x; interp.z[i] = p.z; interp.vx[i] = p.vx; interp.vz[i] = p.vz; interp.fx[i] = p.fx; interp.fz[i] = p.fz;
        }
        s.ball.heldBy = (t & 128) ? 0 : -1;
        s.tick = t;
        frame.alpha = (t % 7) / 7;
        if (!useStub) { anim.update(frame, sink); return; }
        for (let i = 0; i < 22; i++) {
          M.advanceCycle(bank, i, 0.08);
          const vx = interp.vx[i], vz = interp.vz[i];
          M.mapAnim(s, i, Math.sqrt(vx * vx + vz * vz), smp);
          M.samplePose(smp, bank.cycle[i], 3, pose);
        }
      };
      const bank = M.createAnimBank();
      const smp = M.createAnimSample();
      const pose = createPose();
      const runFull = (n) => { for (let j = 0; j < n; j++) step(false, bank, smp, pose); };
      const runStub = (n) => { for (let j = 0; j < n; j++) step(true, bank, smp, pose); };
      const measure = async (fn) => {
        fn(30000); // every path (cold action starts included) optimised before measuring
        globalThis.gc();
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        fn(12000);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return mine(profile, 12000);
      };
      const res = {};
      res.fullBytes = await measure(runFull);
      res.stubBytes = await measure(runStub);
      let t0 = process.hrtime.bigint();
      runFull(4000);
      res.usPerFrame = Number(process.hrtime.bigint() - t0) / 4000 / 1000;
      res.finite = anim.poses.every((p) => Array.from(p).every(Number.isFinite));
      console.log(JSON.stringify(res));
    `;
    const r = spawnSync(process.execPath, [
      ...ALLOC_FLAGS, '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { fullBytes: number; stubBytes: number; usPerFrame: number; finite: boolean };
    console.log(`GFX-12 animation driver per frame (22 players): ${JSON.stringify(res)}`);
    expect(res.finite).toBe(true);
    expect(res.fullBytes).toBeLessThan(1);
    expect(res.stubBytes).toBeLessThan(1);
    // Budget: the render frame is 16 ms on an iPad; animation for 22 players should be a small slice of it.
    expect(res.usPerFrame).toBeLessThan(600);
  });
});

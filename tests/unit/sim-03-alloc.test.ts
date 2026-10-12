/**
 * [SIM-03] detectCrossing and the per-tick geometry queries allocate nothing and are cheap (the sim calls
 * detectCrossing on every ball substep that ends beyond a line, e.g. every substep while the ball sits in a net).
 * Measured in a child process with --expose-gc and a 256 MB young generation, so no scavenge runs inside a measured
 * loop and the heap delta is everything the loop allocated (a GC in the middle would hide allocations).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SIM-03 zero allocation', () => {
  it('detectCrossing (every path, fresh doubles as arguments) and the queries allocate nothing per call', () => {
    const root = resolve(__dirname, '../..');
    const code = `
      const { createBallState } = await import(${JSON.stringify(resolve(root, 'src/contracts/state.ts'))});
      const G = await import(${JSON.stringify(resolve(root, 'src/sim/pitch/geometry.ts'))});
      const s = { ball: createBallState() };
      const b = s.ball;
      // Segments prepared up front (fresh doubles when loaded): goals, goal-line outs, touchline outs, side netting,
      // corner, inside, already out.
      const N = 4096;
      const seg = new Float64Array(N * 6);
      let x = 12345;
      const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
      for (let i = 0; i < N; i++) {
        const near = rnd() < 0.7;
        const x0 = near ? (rnd() < 0.5 ? 1 : -1) * (51.9 + rnd() * 0.7) : -52 + rnd() * 104;
        const z0 = near ? -6 + rnd() * 12 : -34.1 + rnd() * 68.2;
        const y0 = 0.11 + rnd() * 3;
        seg[i * 6] = x0; seg[i * 6 + 1] = y0; seg[i * 6 + 2] = z0;
        seg[i * 6 + 3] = x0 + (rnd() - 0.4) * 0.8 * (x0 < 0 ? -1 : 1); seg[i * 6 + 4] = y0 + (rnd() - 0.5) * 0.3;
        seg[i * 6 + 5] = z0 + (rnd() - 0.5) * 0.8;
      }
      const kinds = [0, 0, 0, 0];
      for (let k = 0; k < N; k++) {
        const o = k * 6; b.cross = 0; b.inNet = 0;
        kinds[G.detectCrossing(s, seg[o], seg[o + 1], seg[o + 2], seg[o + 3], seg[o + 4], seg[o + 5])]++;
      }
      const xs = new Float64Array(64);
      for (let i = 0; i < 64; i++) xs[i] = 52.3 + (i % 7) * 0.01;
      const out = { x: 0, z: 0 };
      let acc = 0;
      const loops = {
        mixed: (n) => {
          for (let k = 0; k < n; k++) {
            const o = (k & (N - 1)) * 6;
            b.cross = 0;
            b.inNet = (k & 7) === 0 ? 1 : 0;
            acc += G.detectCrossing(s, seg[o], seg[o + 1], seg[o + 2], seg[o + 3], seg[o + 4], seg[o + 5]);
          }
        },
        goal: (n) => { for (let k = 0; k < n; k++) { b.cross = 0; b.inNet = 0; const v = xs[k & 63]; acc += G.detectCrossing(s, v, 1, 0.5, v + 0.4, 1, 0.5); } },
        goalLine: (n) => { for (let k = 0; k < n; k++) { b.cross = 0; b.inNet = 0; const v = xs[k & 63]; acc += G.detectCrossing(s, -v, 1, 10.5, -v - 0.4, 1, 10.25); } },
        touchline: (n) => { for (let k = 0; k < n; k++) { b.cross = 0; const v = xs[k & 63]; acc += G.detectCrossing(s, v - 40, 1, 34, v - 39.75, 1, 34.5); } },
        inNet: (n) => { for (let k = 0; k < n; k++) { b.cross = 0; b.inNet = 1; const v = xs[k & 63]; acc += G.detectCrossing(s, G.BALL_OUT_X, 0.5, v - 52, v + 1, 0.5, v - 52); } },
        queries: (n) => {
          for (let k = 0; k < n; k++) {
            const o = (k & (N - 1)) * 6;
            const px = seg[o], py = seg[o + 1], pz = seg[o + 2];
            if (G.inPenaltyArea(px, pz, 1)) acc++;
            if (G.inGoalArea(px, pz, -1)) acc++;
            if (G.inCrossingZone(px, pz, 1)) acc++;
            if (G.onPitch(px, pz, 0.5)) acc++;
            acc += G.insideGoal(px, py, pz);
            if (G.inGoalMouth(py, pz)) acc++;
            if (G.ballOverLine(px, pz)) acc++;
            if (G.isInOwnHalf(px, 1)) acc++;
            G.clampToPitch(px * 1.2, pz * 1.2, 0.5, out);
            acc += out.x > 0 ? 1 : 0;
          }
        },
      };
      const res = { kinds };
      for (const [name, fn] of Object.entries(loops)) {
        fn(300000); // warm up / optimise
        let best = Infinity;
        for (let r = 0; r < 3; r++) {
          globalThis.gc();
          const h0 = process.memoryUsage().heapUsed;
          fn(1000000);
          best = Math.min(best, (process.memoryUsage().heapUsed - h0) / 1000000);
        }
        res[name] = best;
      }
      const t0 = process.hrtime.bigint();
      loops.mixed(1000000);
      res.nsPerCall = Number(process.hrtime.bigint() - t0) / 1000000;
      res.acc = acc;
      console.log(JSON.stringify(res));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number> & { kinds: number[] };
    console.log(`SIM-03 bytes/call: ${JSON.stringify(res)}`);
    // The mixed set really exercises every kind.
    for (const k of [0, 1, 2, 3]) expect(res.kinds[k]).toBeGreaterThan(0);
    // 1M calls per loop: a single 16-byte box per call would read 16. Allow only JIT noise.
    for (const name of ['mixed', 'goal', 'goalLine', 'touchline', 'inNet', 'queries']) expect(res[name], name).toBeLessThan(0.1);
    expect(res.nsPerCall).toBeLessThan(500);
  });
});

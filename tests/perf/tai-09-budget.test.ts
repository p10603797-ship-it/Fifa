/**
 * TAI-09 budget: one full scorePassOptions scan < 0.15 ms in the expensive situations (midfield build-up, several
 * forward runners — through balls and lobs —, a wide carrier in the crossing zone, a crowded midfield), laneSafety a
 * few microseconds, and no allocation per scan or per lane.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * turns every imported binding into a getter on a module namespace object, which makes hot loops several times
 * slower than the shipped (bundled) code. Best of many small batches, so a busy machine (many agents share 4 CPUs)
 * does not make it flaky. The allocation probe runs with a large young generation so no scavenge hides garbage.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { scorePassOptions, createPassOptions, laneSafety } = await import(${imp('src/ai/cpu/passing.ts')});
  const HOME = [[0,-45,0],[1,-8,24],[2,-15,8],[3,-15,-8],[4,-8,-24],[5,12,25],[6,5,4],[7,-2,-6],[8,12,-25],[9,22,6],[10,22,-8]];
  const AWAY = [[11,49,0],[12,28,-20],[13,27,-7],[14,27,7],[15,28,20],[16,14,-18],[17,12,-5],[18,13,9],[19,15,18],[20,-5,-6],[21,-4,8]];
  function scene(carrier) {
    const s = makeScenario({ phase: 2 });
    for (const [i, x, z] of [...HOME, ...AWAY]) {
      const p = s.players[i];
      p.x = x; p.z = z; p.vx = ((i % 5) - 2) * 0.7; p.vz = ((i % 3) - 1) * 0.5; p.fx = i < 11 ? 1 : -1; p.fz = 0;
    }
    s.teams[0].dir = 1; s.teams[1].dir = -1;
    const c = s.players[carrier];
    s.ball.owner = carrier; s.ball.x = c.x + 0.4; s.ball.z = c.z;
    return s;
  }
  const CASES = {
    midfield: () => [scene(6), 6],
    runners: () => {
      const s = scene(6);
      for (const [i, vx, vz] of [[9, 8, 0], [10, 7, 1], [5, 6, -1], [8, 6, 1], [7, 4, 0]]) { s.players[i].vx = vx; s.players[i].vz = vz; }
      s.players[9].job = 3; s.players[10].job = 5;
      return [s, 6];
    },
    cross: () => {
      const s = scene(5);
      const at = (i, x, z) => { s.players[i].x = x; s.players[i].z = z; };
      at(5, 38, 26); at(9, 41, 2); at(10, 39, -5); at(6, 30, 5); at(7, 32, -10); at(13, 45, -3); at(14, 45, 5); at(15, 37, 22);
      s.ball.x = 38.4; s.ball.z = 26;
      return [s, 5];
    },
    crowded: () => {
      const s = scene(6);
      for (let i = 1; i < 22; i++) { if (i === 11) continue; const p = s.players[i]; p.x = 5 + ((i * 7) % 23) - 11; p.z = ((i * 11) % 27) - 13; }
      s.players[6].x = 5; s.players[6].z = 0; s.ball.x = 5.4; s.ball.z = 0;
      return [s, 6];
    },
  };
  const out = createPassOptions(48);
  const res = { us: {}, alloc: {}, n: {}, laneUs: 0, laneAlloc: 0 };
  for (const [name, mk] of Object.entries(CASES)) {
    const [s, slot] = mk();
    for (let i = 0; i < 3000; i++) scorePassOptions(s, slot, out);
    let best = Infinity;
    for (let b = 0; b < 1500; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 8; i++) scorePassOptions(s, slot, out);
      best = Math.min(best, (performance.now() - t0) / 8);
    }
    res.us[name] = best * 1000;
    res.n[name] = scorePassOptions(s, slot, out);
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) scorePassOptions(s, slot, out);
    res.alloc[name] = (process.memoryUsage().heapUsed - h0) / 4000;
  }
  {
    const [s] = CASES.midfield();
    const acc = new Float64Array(1);
    const lane = (i) => { acc[0] += laneSafety(s, 0, 5.4, 4, 22, (i & 7) - 8, 14, i & 1); };
    for (let i = 0; i < 20000; i++) lane(i);
    let best = Infinity;
    for (let b = 0; b < 1500; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) lane(i);
      best = Math.min(best, (performance.now() - t0) / 50);
    }
    res.laneUs = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40000; i++) lane(i);
    res.laneAlloc = (process.memoryUsage().heapUsed - h0) / 40000;
  }
  console.log(JSON.stringify(res));
`;

describe('TAI-09 budget', () => {
  // [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): compiles synchronously, so the measured bytes do not
  // depend on CPU load (under load the optimised code arrived later and the window ran boxing baseline code).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--max-semi-space-size=128', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
    us: Record<string, number>; alloc: Record<string, number>; n: Record<string, number>; laneUs: number; laneAlloc: number;
  } : null;
  if (res) console.log(`TAI-09 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['midfield', 'runners', 'cross', 'crowded']) {
    it(`a full scan < 0.15 ms: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.n[name]!).toBeGreaterThan(0);
      expect(res!.us[name]!).toBeLessThan(150);
    });
    it(`a full scan allocates nothing: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.alloc[name]!).toBeLessThan(4);
    });
  }

  it('laneSafety is a few microseconds and allocates nothing', () => {
    expect(res).not.toBeNull();
    expect(res!.laneUs).toBeLessThan(10);
    expect(res!.laneAlloc).toBeLessThan(1);
  });
});

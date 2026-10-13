/**
 * TAI-04 budget: assignDefensiveShape for both teams < 0.05 ms per tick, and no allocation in its per-tick code.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * turns every imported binding into a getter on a module namespace object, which makes hot loops several times
 * slower than the shipped (bundled) code and would measure the test runner instead of the module. Best of many
 * short batches so a busy machine does not make the check flaky. Scenarios cover the expensive paths: zonal
 * marking with many attackers in zones, passing-lane covers near the box, and a loose ball after a backward pass
 * with the offside trap (loose-ball possession scan, step-up, runner checks).
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
  const { assignDefensiveShape } = await import(${imp('src/ai/defshape.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const ev = { emit() {} };
  // Team 0 defends (attacks +x); team 1 attackers placed in team 0's half.
  const place = (s, list) => { for (const [slot, x, z, vx] of list) { const p = s.players[slot]; p.x = x; p.z = z; p.vx = vx || 0; p.vz = 0; } };
  const CASES = {
    marking: (s) => {
      place(s, [[17, -4, 4], [20, -24, 7], [21, -24, -7], [16, -14, 24], [19, -14, -24], [18, -18, -3], [12, -20, 12], [13, -22, -14]]);
      for (let i = 1; i < 11; i++) { const p = s.players[i]; p.x = -28 + (i > 4 ? 9 : 0) + (i > 8 ? 9 : 0); p.z = -20 + ((i * 7) % 40); p.homeX = p.x; p.homeZ = p.z; }
      s.ball.owner = 17; s.ball.x = -4; s.ball.z = 4;
    },
    lanes: (s) => {
      place(s, [[17, -34, -24], [20, -44, 3], [21, -42, -6], [19, -40, 12], [18, -30, 0]]);
      for (let i = 1; i < 11; i++) { const p = s.players[i]; p.x = -44 + (i > 4 ? 10 : 0) + (i > 8 ? 8 : 0); p.z = -20 + ((i * 7) % 40); p.homeX = p.x; p.homeZ = p.z; }
      s.ball.owner = 17; s.ball.x = -34; s.ball.z = -24;
    },
    looseTrap: (s) => {
      place(s, [[17, -12, 0], [18, 8, 14], [20, -26, 5, -6], [21, -27, -5]]);
      for (let i = 1; i < 11; i++) { const p = s.players[i]; p.x = -30 + (i > 4 ? 9 : 0) + (i > 8 ? 9 : 0); p.z = -20 + ((i * 7) % 40); p.homeX = p.x; p.homeZ = p.z; }
      s.teams[0].offsideTrap = 1;
      const b = s.ball;
      b.owner = -1; b.x = -6; b.z = 3; b.vx = 13; b.vz = 7;
      b.lastKickBy = 17; b.lastKickTeam = 1; b.lastTouch = 17; b.lastTouchTeam = 1; b.passTarget = 18; b.passX = 8; b.passZ = 14;
    },
  };
  const out = { us: {}, alloc: {} };
  for (const [name, setup] of Object.entries(CASES)) {
    const s = makeScenario({ phase: 2, humans: 0 });
    setup(s);
    const kickTick = () => { s.ball.lastKickTick = s.tick - 10; };
    const tick = () => { s.tick++; kickTick(); for (let t = 0; t < 2; t++) { resetJobs(s, t); assignDefensiveShape(s, t, ev); } };
    for (let i = 0; i < 4000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 400);
    }
    out.us[name] = best * 1000;
    // Least allocation over several windows: concurrent JIT timing on a loaded machine can leave the probe's own
    // loop (or a not-yet-reoptimized caller) boxing for a while; an allocation in the module's source would show in
    // every window.
    let alloc = Infinity;
    for (let w = 0; w < 10; w++) {
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 8000; i++) tick();
      alloc = Math.min(alloc, (process.memoryUsage().heapUsed - h0) / 8000);
    }
    out.alloc[name] = alloc;
    let marks = 0, covers = 0;
    for (const p of s.players) { if (p.job === 6) marks++; if (p.job === 8) covers++; }
    out[name + 'Jobs'] = { marks, covers, lineX: s.teams[0].lineX };
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-04 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      us: Record<string, number>; alloc: Record<string, number>; [k: string]: unknown;
    }
    : null;
  if (res) console.log(`TAI-04 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('the scenarios exercise marking and lane covers', () => {
    expect(res).not.toBeNull();
    expect((res!['markingJobs'] as { marks: number }).marks).toBeGreaterThanOrEqual(3);
    expect((res!['lanesJobs'] as { covers: number }).covers).toBeGreaterThanOrEqual(1);
  });

  for (const name of ['marking', 'lanes', 'looseTrap']) {
    it(`assignDefensiveShape x2 (+ resetJobs x2) < 0.05 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(50);
    });
    it(`no allocation per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      // 0 B per tick in a quiet process. On a loaded machine (concurrent JIT timing) V8 has been seen to inline the
      // module into the probe's caller and compile the team.lineX store of the not-defending side generically, which
      // boxes that one double: 16 B per tick, whatever the source does. Allow exactly that; an object literal,
      // closure or array per tick, or any per-player allocation, is far more.
      expect(res!.alloc[name]!).toBeLessThan(17);
    });
  }
});

/**
 * TAI-10 budget: estimateXg, bestDribble and chooseSkill each < 0.05 ms per call in expensive situations (a crowded
 * box, a crowded midfield with everyone moving, a skill duel with space probes) and no allocation per call.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * makes hot loops several times slower than the shipped bundle). Best of many small batches so a busy machine does
 * not make it flaky; the allocation probe runs with a large young generation so no scavenge hides garbage.
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
  const { estimateXg, bestDribble, chooseSkill } = await import(${imp('src/ai/cpu/shooting.ts')});
  function scene(carrier, cx, cz, spread) {
    const s = makeScenario({ phase: 2 });
    s.teams[0].dir = 1; s.teams[1].dir = -1;
    for (let i = 0; i < 22; i++) {
      const p = s.players[i];
      p.x = cx + ((i * 7) % 23 - 11) * spread; p.z = cz + ((i * 11) % 27 - 13) * spread;
      p.vx = ((i % 5) - 2) * 1.3; p.vz = ((i % 3) - 1) * 1.1; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.act = 0; p.stunT = 0;
    }
    s.players[11].x = 51; s.players[11].z = 0.5;
    const c = s.players[carrier];
    c.x = cx; c.z = cz; c.vx = 4; c.vz = 1;
    s.ball.owner = carrier; s.ball.heldBy = -1; s.ball.x = cx + 0.4; s.ball.z = cz; s.ball.y = 0.11;
    s.attrs[carrier].skillMoves = 5;
    return s;
  }
  const CASES = {
    box: () => scene(9, 38, 4, 0.6),
    midfield: () => scene(6, 0, 0, 0.9),
    duel: () => { const s = scene(9, 20, 2, 1.5); const d = s.players[13]; d.x = 23; d.z = 2.3; d.vx = -3; return s; },
  };
  // Each probe accumulates into a typed array and returns nothing, so the harness's own (megamorphic) calls box no
  // doubles: what is measured is the functions' own allocation.
  const out = { x: 0, z: 0 };
  const acc = new Float64Array(1);
  const FNS = {
    xg: (s, slot) => { acc[0] += estimateXg(s, slot, s.players[slot].x, s.players[slot].z); },
    dribble: (s, slot) => { acc[0] += bestDribble(s, slot, out); },
    skill: (s, slot) => { acc[0] += chooseSkill(s, slot); },
  };
  const res = { us: {}, alloc: {}, v: {} };
  for (const [cname, mk] of Object.entries(CASES)) {
    const s = mk();
    const slot = s.ball.owner;
    for (const [fname, fn] of Object.entries(FNS)) {
      const key = cname + '.' + fname;
      for (let i = 0; i < 5000; i++) fn(s, slot);
      let best = Infinity;
      for (let b = 0; b < 1500; b++) {
        const t0 = performance.now();
        for (let i = 0; i < 16; i++) fn(s, slot);
        best = Math.min(best, (performance.now() - t0) / 16);
      }
      res.us[key] = best * 1000;
      acc[0] = 0; fn(s, slot); res.v[key] = acc[0];
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 20000; i++) fn(s, slot);
      res.alloc[key] = (process.memoryUsage().heapUsed - h0) / 20000;
    }
  }
  console.log(JSON.stringify(res));
`;

describe('TAI-10 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=128', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
    us: Record<string, number>; alloc: Record<string, number>; v: Record<string, number>;
  } : null;
  if (res) console.log(`TAI-10 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const c of ['box', 'midfield', 'duel']) {
    for (const f of ['xg', 'dribble', 'skill']) {
      const key = `${c}.${f}`;
      it(`${key} < 0.05 ms per call and allocates nothing`, () => {
        expect(res).not.toBeNull();
        expect(Number.isFinite(res!.v[key]!)).toBe(true);
        expect(res!.us[key]!).toBeLessThan(50);
        expect(res!.alloc[key]!).toBeLessThan(2);
      });
    }
  }

  it('the probe situations exercise the code (a box chance, a dribble, a skill)', () => {
    expect(res).not.toBeNull();
    expect(res!.v['box.xg']!).toBeGreaterThan(0);
    expect(res!.v['midfield.dribble']!).toBeGreaterThan(0);
    expect(res!.v['duel.skill']!).toBeGreaterThan(0);
  });
});

/**
 * TAI-03 budget: assignRuns for both teams < 0.05 ms per tick in the expensive situations (open play with the
 * carrier looking up, a pass wind-up with releases, an overlap, a box attack on a cross, a trigger run plus a pass
 * and go), and no allocation in the per-tick code.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * turns every imported binding into a getter on a module namespace object, which makes hot loops several times
 * slower than the shipped (bundled) code. Best of many short batches so a busy machine does not make it flaky.
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
  const { assignRuns, triggerRun } = await import(${imp('src/ai/runs.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const ROLE = { GK: 0, RB: 1, CB: 2, LB: 3, CM: 7, RM: 9, LM: 10, ST: 13 };
  const HOME = [[0,'GK',-45,0],[1,'RB',5,22],[2,'CB',-8,10],[3,'CB',-12,-8],[4,'LB',0,-24],[5,'RM',20,26],[6,'CM',6,6],
    [7,'CM',8,-5],[8,'LM',12,-25],[9,'ST',20,6],[10,'ST',20,-6]];
  const AWAY = [[11,'GK',49,0],[12,'RB',24,-18],[13,'CB',24,-6],[14,'CB',24,6],[15,'LB',24,18],[16,'RM',15,-20],
    [17,'CM',15,-8],[18,'CM',15,7],[19,'LM',15,20],[20,'ST',-5,-10],[21,'ST',-5,10]];
  function scene(carrier, carrierAt, opts) {
    const s = makeScenario({ phase: 2 });
    for (const [i, r, x, z] of [...HOME, ...AWAY]) {
      const p = s.players[i];
      p.role = ROLE[r]; p.isKeeper = r === 'GK' ? 1 : 0; p.x = x; p.z = z; p.homeX = x; p.homeZ = z;
      p.vx = ((i % 5) - 2) * 0.7; p.vz = ((i % 3) - 1) * 0.5; p.fx = i < 11 ? 1 : -1; p.fz = 0;
    }
    const c = s.players[carrier];
    if (carrierAt) { c.x = carrierAt[0]; c.z = carrierAt[1]; }
    const b = s.ball;
    b.owner = carrier; b.x = c.x + 0.5; b.z = c.z; b.px = b.x; b.pz = b.z; b.lastTouch = carrier; b.lastTouchTeam = 0;
    s.ctrl[2].slot = carrier; c.ctrl = 2;
    s.teams[0].phase = 1;
    if (opts && opts.kick) { c.act = 1; c.actKick = 10; c.actT = 2; c.actContact = 10; c.actDur = 20; }
    if (opts && opts.calls) { triggerRun(s, 0, ev); s.teams[0].passGoSlot = 6; s.teams[0].passGoT = 120; }
    return s;
  }
  const ev = { emit() {} };
  const CASES = {
    lookUp: () => scene(7, null, null),
    release: () => scene(7, null, { kick: true }),
    overlap: () => scene(5, null, null),
    box: () => scene(5, [43, 24], null),
    calls: () => scene(7, null, { calls: true }),
  };
  const out = { us: {}, alloc: {} };
  for (const [name, mk] of Object.entries(CASES)) {
    const s = mk();
    const tick = () => {
      s.tick++;
      for (let t = 0; t < 2; t++) { resetJobs(s, t); assignRuns(s, t, ev); }
      // keep the explicit calls alive so every tick does the full work
      if (s.teams[0].runCallT < 10 && name === 'calls') { s.teams[0].runCallT = 100; s.teams[0].passGoT = 100; s.teams[0].runSlot = 9; s.teams[0].passGoSlot = 6; }
    };
    for (let i = 0; i < 4000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 400);
    }
    out.us[name] = best * 1000;
    let runners = 0;
    for (let i = 0; i < 11; i++) if (s.players[i].job >= 3 && s.players[i].job <= 5) runners++;
    if (runners === 0) throw new Error('no runners in ' + name);
    // allocation of the module's own per-tick code (assignRuns only; resetJobs is lead-owned)
    const only = () => { s.tick++; assignRuns(s, 0, ev); assignRuns(s, 1, ev); };
    for (let i = 0; i < 20000; i++) only();
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100000; i++) only();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 100000;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-03 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number> } : null;
  if (res) console.log(`TAI-03 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['lookUp', 'release', 'overlap', 'box', 'calls']) {
    it(`assignRuns x2 < 0.05 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(50);
    });
    it(`assignRuns allocates nothing per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.alloc[name]!).toBeLessThan(1);
    });
  }
});

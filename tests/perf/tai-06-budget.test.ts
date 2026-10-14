/**
 * TAI-06 budget: updateTeamPhase + assignTransition for both teams per tick, in the expensive situations (a turnover
 * every tick: counter-space scans on both sides; transition windows held open: runner selection + recovery runs), is
 * far below the AI budget, and allocates nothing.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * makes hot loops several times slower than the shipped code). Best of many short batches so a busy machine does not
 * make the check flaky.
 *
 * Allocation: V8's background (concurrent) TurboFan compiles make its inlining decisions depend on thread timing; on a
 * busy machine a small callee (assignJob) is sometimes left out-of-line and its double arguments get boxed (16 B per
 * call: a JIT artifact, not an allocation in the source; the flaky "16.8 B/tick" failure). The probe therefore compiles
 * on the main thread (--no-concurrent-recompilation: the same code every run) and takes the smallest of several
 * batches after a GC, so one-off compiler / IC allocations do not count while any steady per-tick source-level
 * allocation (object/array literal, closure, string) still shows in every batch.
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
  const { updateTeamPhase, assignTransition } = await import(${imp('src/ai/transition.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const ev = { emit() {} };
  const s = makeScenario({ phase: 2, teams: [{ style: 1 }, { style: 0 }] });
  for (const p of s.players) p.ctrl = -1;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i];
    if (p.isKeeper === 1) continue;
    p.x = -40 + ((i * 37) % 80); p.z = -30 + ((i * 23) % 60); p.homeX = p.x + 3; p.homeZ = p.z - 2;
  }
  const own = (slot) => { const b = s.ball, p = s.players[slot]; b.x = p.x; b.z = p.z; b.px = p.x; b.pz = p.z; b.owner = slot;
    b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick; };
  const run = () => { for (let t = 0; t < 2; t++) { updateTeamPhase(s, t, ev); resetJobs(s, t); assignTransition(s, t, ev); } };
  const CASES = {
    // A turnover every tick: both teams take the "changed" path (counter-space scan) and assign jobs.
    flip: () => { s.tick++; own(s.tick % 2 === 0 ? 6 : 17); run(); },
    // Transition windows held open: stay checks + runner selection + recovery runs every tick.
    hold: () => { s.tick++; own(6); s.teams[0].phaseT = 20; s.teams[1].phaseT = 20; run(); },
  };
  const out = { us: {}, alloc: {}, phases: {} };
  for (const [name, tick] of Object.entries(CASES)) {
    for (let i = 0; i < 20000; i++) tick(); // let the optimising compiler settle first
    out.phases[name] = [s.teams[0].phase, s.teams[1].phase];
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 1000);
    }
    out.us[name] = best * 1000;
    let alloc = Infinity;
    for (let b = 0; b < 5; b++) {
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 40000; i++) tick();
      alloc = Math.min(alloc, (process.memoryUsage().heapUsed - h0) / 40000);
    }
    out.alloc[name] = alloc;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-06 budget', () => {
  const r = spawnSync(process.execPath, [
    '--expose-gc', '--no-concurrent-recompilation', '--import', 'tsx', '--input-type=module', '-e', PROBE,
  ], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number>; phases: Record<string, number[]> }
    : null;
  if (res) console.log(`TAI-06 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('the probe exercises the transition phases', () => {
    expect(res).not.toBeNull();
    expect(res!.phases.hold).toEqual([3, 4]); // TRANSITION_ATTACK / TRANSITION_DEFEND
  });

  for (const name of ['flip', 'hold']) {
    it(`phase + transition jobs for both teams < 0.02 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(20);
    });
    it(`no allocation per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      // Allowance: V8 may box the double arguments of an occasional ATTACK_BUILD emit (16 B each). Any per-player
      // source-level allocation (object/array literal, closure) would cost hundreds of bytes per tick.
      expect(res!.alloc[name]!).toBeLessThan(8);
    });
  }
});

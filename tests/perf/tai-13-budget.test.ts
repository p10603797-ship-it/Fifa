/**
 * TAI-13 budget: setPiecePositions for both teams plus cpuSetPiece for both CPU brains (the defending one lays out
 * the spots again to steer its player) per restart tick, and no allocation in that per-tick code.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (its module transform makes
 * hot loops several times slower than the shipped bundle). Best of many short batches so a busy machine does not make
 * the check flaky.
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
  const { awardRestart } = await import(${imp('src/sim/rules/restart.ts')});
  const { setPiecePositions, cpuSetPiece } = await import(${imp('src/ai/setpieces.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const { createInputFrame, clearInputFrame } = await import(${imp('src/contracts/input.ts')});
  const ev = { emit() {} };
  const CASES = {
    corner: [4, 0, 52.5, 34],
    freeKick: [5, 1, -28, 6],
    throwIn: [2, 0, 10, -34],
    penalty: [6, 1, -41.5, 0],
  };
  const out = { us: {}, alloc: {} };
  const f0 = createInputFrame(), f1 = createInputFrame();
  for (const [name, [kind, team, x, z]] of Object.entries(CASES)) {
    const s = makeScenario({ phase: 2, humans: 0 });
    awardRestart(s, kind, team, x, z, ev);
    const r = s.match.restart;
    r.ready = 1;
    r.t = 70; // ready, the CPU still waiting (layout + steering every tick)
    s.ctrl[2].slot = team === 0 ? r.taker : 13;
    s.ctrl[3].slot = team === 1 ? r.taker : 2;
    s.players[s.ctrl[2].slot].ctrl = 2;
    s.players[s.ctrl[3].slot].ctrl = 3;
    const tick = () => {
      s.tick++; r.t = 70; // keep the restart at the same age so the program never fires a kick
      clearInputFrame(f0); clearInputFrame(f1);
      cpuSetPiece(s, 0, f0, ev); cpuSetPiece(s, 1, f1, ev);
      for (let t = 0; t < 2; t++) { resetJobs(s, t); setPiecePositions(s, t, ev); }
    };
    for (let i = 0; i < 3000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 300);
    }
    out.us[name] = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30000; i++) tick();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 30000;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-13 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number> } : null;
  if (res) console.log(`TAI-13 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['corner', 'freeKick', 'throwIn', 'penalty']) {
    it(`set-piece layout x2 + CPU set piece x2 < 0.1 ms per restart tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(100);
    });
  }

  it('allocates (next to) nothing per tick', () => {
    expect(res).not.toBeNull();
    // Only V8 number boxing at non-inlined call boundaries may show up; any per-tick object, array or closure would
    // be hundreds of bytes per tick.
    for (const v of Object.values(res!.alloc)) expect(v).toBeLessThan(64);
  });
});

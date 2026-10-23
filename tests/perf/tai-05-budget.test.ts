/**
 * TAI-05 budget: assignPressing for both teams < 0.05 ms per tick, and no source-level allocation per tick.
 *
 * Measured in a plain Node child process on an esbuild bundle of the probe (one scope, like the production build), not
 * inside the Vitest worker: Vitest's SSR transform turns every imported binding into a getter on a module namespace
 * object, which makes hot loops several times slower than the shipped (bundled) code and would measure the test runner
 * instead of the module. [QF-2] The probe used to run unbundled under node --import tsx, where V8 boxed far more
 * at SIM-04 ticksToReach's call boundary (65-75 B a call, ~6 B bundled) and a scavenge inside the measuring window
 * made the reading jump between 6 and 390 B a tick for the same code: it now runs bundled with a large young
 * generation (as TAI-09's probe does), so the number is TAI-05's and SIM-04's real per-tick garbage. Best of many
 * short batches so a busy machine does not make the check flaky. Scenarios cover the expensive paths: a carrier in
 * our third with three runners (presser + cover + trackers), team press with a human front presser and a called
 * second defender (two pressers, side spots), and an opponent pass in flight (receiver pressed at the reception
 * point). The players move every tick (scripted drift) so arrival times are re-evaluated on fresh geometry.
 */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { assignPressing } = await import(${imp('src/ai/press.ts')});
  const { resetJobs } = await import(${imp('src/ai/jobs.ts')});
  const ev = { emit() {} };
  // Team 0 defends (attacks +x); team 1 attacks toward x = -52.5.
  const place = (s, list) => { for (const [slot, x, z, vx] of list) { const p = s.players[slot]; p.x = x; p.z = z; p.vx = vx || 0; p.vz = 0; } };
  const defend = (s, u) => { for (let i = 1; i < 11; i++) { const p = s.players[i]; p.x = u + (i > 4 ? 9 : 0) + (i > 8 ? 9 : 0); p.z = -20 + ((i * 7) % 40); p.homeX = p.x; p.homeZ = p.z; } };
  const CASES = {
    pressCoverRunners: (s) => {
      place(s, [[20, -20, 3, -3], [17, -18, 8, -6.5], [18, -16, -10, -7], [19, -15, 18, -6]]);
      defend(s, -32);
      s.ball.owner = 20; s.ball.x = -20.4; s.ball.z = 3;
    },
    teamPressHuman: (s) => {
      place(s, [[20, -5, 0, -2], [17, 5, 10, -5]]);
      defend(s, -25);
      s.teams[0].teamPress = 1;
      s.ctrl[0].kind = 1; s.ctrl[0].side = 0; s.ctrl[0].slot = 6; s.players[6].ctrl = 0;
      s.players[6].x = -7; s.players[6].z = 1;
      s.ctrl[0].secondDef = 7;
      s.ball.owner = 20; s.ball.x = -5.4; s.ball.z = 0;
    },
    passInFlight: (s) => {
      place(s, [[19, -8, -10], [20, -15, 8, -4]]);
      defend(s, -28);
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = -10; b.z = -4; b.vx = -8; b.vz = 8;
      b.lastTouch = 19; b.lastTouchTeam = 1; b.passTarget = 20; b.passX = -15; b.passZ = 7;
    },
  };
  const out = { us: {}, alloc: {} };
  for (const [name, setup] of Object.entries(CASES)) {
    const s = makeScenario({ phase: 2, humans: 0 });
    s.teams[0].phase = 2; // TeamPhase.DEFEND (TAI-06 sets it in a match)
    s.teams[1].phase = 1; // ATTACK
    setup(s);
    let k = 0;
    const tick = () => {
      s.tick++;
      k++;
      const w = (k % 120) < 60 ? 0.02 : -0.02; // drift: fresh geometry every tick
      for (let i = 1; i < 22; i++) { const p = s.players[i]; p.z += w; }
      for (let t = 0; t < 2; t++) { resetJobs(s, t); assignPressing(s, t, ev); }
    };
    for (let i = 0; i < 4000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 400);
    }
    out.us[name] = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40000; i++) tick();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 40000;
    let press = 0, cover = 0, track = 0;
    for (const p of s.players) { if (p.job === 10) press++; if (p.job === 8) cover++; if (p.job === 7) track++; }
    out[name + 'Jobs'] = { press, cover, track, pressSlot: s.teams[0].pressSlot };
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-05 budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tai-05-budget-'));
  const entry = join(dir, 'probe.mjs');
  const bundle = join(dir, 'probe.bundle.mjs');
  writeFileSync(entry, PROBE);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error' });
  // [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): compiles synchronously, so the measured bytes do not
  // depend on CPU load (under load the optimised code arrived later and the window ran boxing baseline code).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--max-semi-space-size=128', bundle], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  rmSync(dir, { recursive: true, force: true });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      us: Record<string, number>; alloc: Record<string, number>; [k: string]: unknown;
    }
    : null;
  if (res) console.log(`TAI-05 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('the scenarios exercise press, cover, team press and runners', () => {
    expect(res).not.toBeNull();
    const j = (n: string) => res![n + 'Jobs'] as { press: number; cover: number; track: number; pressSlot: number };
    expect(j('pressCoverRunners').press).toBe(1);
    expect(j('pressCoverRunners').cover).toBe(1);
    expect(j('pressCoverRunners').track).toBeGreaterThanOrEqual(1);
    expect(j('teamPressHuman').press).toBeGreaterThanOrEqual(1);
    expect(j('teamPressHuman').pressSlot).toBe(7); // the called second defender
    expect(j('passInFlight').press).toBe(1);
  });

  for (const name of ['pressCoverRunners', 'teamPressHuman', 'passInFlight']) {
    it(`assignPressing x2 (+ resetJobs x2) < 0.05 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(50);
    });
    it(`no source-level allocation per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      // ticksToReach (SIM-04) may box its double arguments in V8 (16 bytes each, ~20 calls per tick at most); any
      // object literal, closure or array per candidate would blow well past this.
      expect(res!.alloc[name]!).toBeLessThan(256);
    });
  }
});

/**
 * TAI-08 budget: cpuCarrier per-call cost and no source-level allocation per call.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (its SSR transform turns
 * every imported binding into a getter and would measure the test runner). Best of many short batches so a busy
 * machine does not make the check flaky. Scenarios:
 *  - decideEveryCall: the worst case, a full evaluation on every call (TAI-09 pass scan, TAI-10 xG / dribble / skill,
 *    every option scored) with defenders close around a carrier just inside the opposition half;
 *  - decideOwnHalf: the same in his own half, where no shot is scored (no TAI-10 estimateXg call);
 *  - steadyDribble: the normal case, executing a dribble (own half) with one evaluation every carrierEvalInterval ticks;
 *  - shotInBox: a carrier in the box, deciding and executing a shot (aim, press, hold).
 * Positions drift every call so nothing is cached between calls. The real TAI-09 / TAI-10 modules are measured too,
 * so their cost counts against the evaluation budget.
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
  const { cpuCarrier } = await import(${imp('src/ai/cpu/carrier.ts')});
  const { clearInputFrame } = await import(${imp('src/contracts/input.ts')});
  const ev = { emit() {} };
  const base = (carrier, cx, cz) => {
    const s = makeScenario({ phase: 2, humans: 0, seed: 4 });
    for (let i = 0; i < 22; i++) {
      const p = s.players[i]; const k = i % 11;
      p.x = k === 0 ? (i < 11 ? -51 : 51) : (i < 11 ? -20 : 10) + (k % 4) * 7; p.z = -25 + k * 5; p.vx = 0; p.vz = 0;
      p.fx = i < 11 ? 1 : -1; p.fz = 0;
    }
    const c = s.players[carrier]; c.x = cx; c.z = cz; c.vx = 3; c.vz = 0;
    const b = s.ball; b.owner = carrier; b.heldBy = -1; b.x = cx + 0.6; b.z = cz; b.y = 0.11; b.vx = 3; b.vz = 0; b.grounded = 1;
    b.lastTouch = carrier; b.lastTouchTeam = 0; b.ownerT = 200;
    s.ctrl[2].slot = carrier; c.ctrl = 2;
    s.teams[0].cpu.level = 5;
    return s;
  };
  const CASES = {
    decideEveryCall: [9, 0, 0, (s, k) => {
      const c = s.players[9]; c.x = (k % 50) * 0.02; c.z = 0;
      s.players[20].x = c.x + 2.2; s.players[20].z = 0.8; s.players[19].x = c.x + 3; s.players[19].z = -3;
      s.ball.x = c.x + 0.6; s.ball.z = 0;
      const br = s.teams[0].cpu; br.evalT = 0; br.plan = 4; br.reactT = 0; br.p1 = 5;
    }],
    decideOwnHalf: [9, -10, 0, (s, k) => {
      const c = s.players[9]; c.x = -10 - (k % 50) * 0.02; c.z = 0;
      s.players[20].x = c.x + 2.2; s.players[20].z = 0.8;
      s.ball.x = c.x + 0.6; s.ball.z = 0;
      const br = s.teams[0].cpu; br.evalT = 0; br.plan = 4; br.reactT = 0; br.p1 = 5;
    }],
    steadyDribble: [9, -10, 5, (s, k) => {
      const c = s.players[9]; c.x = -10 + (k % 50) * 0.02; c.z = 5;
      s.ball.x = c.x + 0.6; s.ball.z = 5;
    }],
    shotInBox: [9, 38, 2, (s, k) => {
      const c = s.players[9]; c.x = 38 + (k % 50) * 0.01; c.z = 2;
      s.ball.x = c.x + 0.6; s.ball.z = 2;
      const br = s.teams[0].cpu; if (br.plan !== 8) { br.evalT = 0; br.reactT = 0; }
    }],
  };
  const inspector = await import('node:inspector');
  const sess = new inspector.Session();
  sess.connect();
  const post = (m, p) => new Promise((res, rej) => sess.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  await post('HeapProfiler.enable');
  const out = { us: {}, alloc: {}, allocTotal: {}, plans: {} };
  for (const [name, [carrier, cx, cz, setup]] of Object.entries(CASES)) {
    const s = base(carrier, cx, cz);
    const f = s.teams[0].cpu.out;
    let k = 0;
    let plans = 0;
    const call = () => {
      s.tick++;
      k++;
      setup(s, k);
      clearInputFrame(f);
      cpuCarrier(s, 0, f, ev);
      plans |= 1 << s.teams[0].cpu.plan;
    };
    for (let i = 0; i < 3000; i++) call();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) call();
      best = Math.min(best, (performance.now() - t0) / 200);
    }
    out.us[name] = best * 1000;
    // Allocation, by V8's sampling heap profiler (garbage included): bytes per call allocated with a frame of
    // carrier.ts on top (its own code, incl. doubles it boxes for the calls it makes), and in total (incl. TAI-09 /
    // TAI-10 and the probe's setup).
    await post('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
    for (let i = 0; i < 20000; i++) call();
    const { profile } = await post('HeapProfiler.stopSampling');
    let own = 0, total = 0;
    const walk = (n) => {
      if (n.selfSize) { total += n.selfSize; if (n.callFrame.url.endsWith('/carrier.ts')) own += n.selfSize; }
      for (const ch of n.children) walk(ch);
    };
    walk(profile.head);
    out.alloc[name] = own / 20000;
    out.allocTotal[name] = total / 20000;
    out.plans[name] = plans;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-08 budget', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      us: Record<string, number>; alloc: Record<string, number>; allocTotal: Record<string, number>; plans: Record<string, number>;
    }
    : null;
  if (res) console.log(`TAI-08 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('the scenarios exercise the paths they are meant to (evaluations, dribble execution, a shot)', () => {
    expect(res).not.toBeNull();
    expect(res!.plans.steadyDribble! & (1 << 4)).not.toBe(0); // DRIBBLE
    expect(res!.plans.shotInBox! & (1 << 8)).not.toBe(0); // SHOOT
  });

  // Budget (desktop Node here; the iPad is ~3-4x slower): a full evaluation incl. the TAI-09 / TAI-10 scans < 0.25 ms,
  // run once per carrierEvalInterval ticks; plain execution ticks well under 0.05 ms.
  const LIMIT_US: Record<string, number> = { decideEveryCall: 250, decideOwnHalf: 250, steadyDribble: 40, shotInBox: 60 };
  // Bytes per call allocated by carrier.ts itself (sampled: a few bytes of noise). The source allocates nothing per call
  // (no literals, closures or arrays; doubles go through typed scratch on the hot paths). What remains is V8 boxing
  // doubles at call boundaries it did not inline (16 bytes each; JavaScriptCore on the iPad NaN-boxes doubles, so
  // there it is nothing): ~0 when a full evaluation runs every call (decide* cases, the sharp check), a few dozen bytes
  // per call in the mixed execute / evaluate cases. TAI-09 / TAI-10 allocation is reported (allocTotal), not judged.
  const LIMIT_B: Record<string, number> = { decideEveryCall: 64, decideOwnHalf: 32, steadyDribble: 200, shotInBox: 200 };
  for (const name of ['decideEveryCall', 'decideOwnHalf', 'steadyDribble', 'shotInBox']) {
    it(`cpuCarrier within budget per call: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(LIMIT_US[name]!);
    });
    it(`no source-level allocation per call: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.alloc[name]!).toBeLessThan(LIMIT_B[name]!);
    });
  }
});

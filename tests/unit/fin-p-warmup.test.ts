/**
 * [FIN-P] The sim warm-up (src/sim/init.ts warmUpSim) and the state shape settling in initMatch: the throttled proxy gate's
 * first-match ticks carried compile / deopt work and ran in slow tiers (tests/perf/fin-p-tick-trace.ts), so the loading
 * screen now plays a scratch match first (production builds), and every new state gets its fields' double
 * representations up front (production builds: core/clone.ts shapeSettlingOn; the child-process probes turn it on).
 * Both must be invisible to the simulation: same values, same hash timeline. [FIN-P final] Also: no deopt wave when the
 * match state is built after the warm-up, and no allocation burst from the state copier / hasher in the match's first
 * ticks.
 * Test order matters (one module instance per file): the dev-build check runs before any explicit warm-up.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_WARMUP } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { step } from '../../src/sim/step';
import { settleStateShapes } from '../../src/sim/core/clone';
import { initMatch, simWarmedPhases, simWarmedTicks, warmUpOnce, warmUpSim } from '../../src/sim/init';
import { benchSetup } from '../../src/platform/benchHook';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function run(seed: number, ticks: number, every: number): string[] {
  const s = initMatch(benchSetup(seed).config);
  const frames = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  const out: string[] = [];
  for (let t = 1; t <= ticks; t++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    step(s, frames, ev);
    if (t % every === 0) out.push(`${t}:${hashState(s)}`);
  }
  return out;
}

/** Every leaf of the state (numbers by Object.is, so -0 and NaN count), config and squads excluded. */
function leaves(s: SimState): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) { for (const e of v) walk(e, depth + 1); return; }
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      for (const k of Object.keys(v)) if (!(depth === 0 && (k === 'config' || k === 'squads'))) walk((v as Record<string, unknown>)[k], depth + 1);
      return;
    }
    if (ArrayBuffer.isView(v)) { out.push(Array.from(v as unknown as ArrayLike<number>)); return; }
    out.push(v);
  };
  walk(s, 0);
  return out;
}

function sameLeaves(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Array.isArray(x) && Array.isArray(y)) { if (!sameLeaves(x, y)) return false; } else if (!Object.is(x, y)) return false;
  }
  return true;
}

describe('fin-p: sim warm-up and state shapes', () => {
  // Recorded before anything in this file warms the sim up.
  const cold = run(1, 3000, 250);

  it('fin-p: initMatch in a dev / test build does not run the warm-up (the tests and tools stay fast)', () => {
    initMatch(benchSetup(1).config);
    expect(simWarmedTicks()).toBe(0);
  });

  it('fin-p: settleStateShapes leaves every value of a fresh and of a mid-match state unchanged (incl. -0 and NaN)', () => {
    const s = initMatch(benchSetup(3).config);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 0; t < 1200; t++) { clearInputFrame(frames[0]!); clearInputFrame(frames[1]!); step(s, frames, ev); }
    s.ball.sx = -0;
    s.players[4]!.tgtSpeed = Number.NaN;
    const before = leaves(s);
    const hash = hashState(s);
    settleStateShapes(s);
    expect(sameLeaves(leaves(s), before)).toBe(true);
    expect(hashState(s)).toBe(hash);
    s.players[4]!.tgtSpeed = 0;
    const fresh = initMatch(benchSetup(4).config);
    const f0 = leaves(fresh);
    settleStateShapes(fresh);
    expect(sameLeaves(leaves(fresh), f0)).toBe(true);
  });

  it('fin-p: a state keeps its hidden classes through play: open play and every restart kind (no map change -> no deopt wave)', () => {
    // Fails without initMatch's settleStateShapes: ball, restart, advantage, challenge, player, keeper, cpu, cpu frame and
    // controller objects changed map in play (V8 Smi -> Double field representation on a field's first fraction), which
    // deoptimised all optimised code that had read them (457 "wrong map" deopts in two Node matches).
    const r = spawnSync(process.execPath, ['--allow-natives-syntax', '--import', 'tsx', 'tests/perf/fin-p-shape-probe.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { objects: number; changed: string[]; ticks: number };
    expect(res.objects).toBe(14);
    expect(res.ticks).toBeGreaterThanOrEqual(T_WARMUP.openPlayTicks);
    expect(res.changed).toEqual([]);
  }, 150_000);

  it('fin-p: building the match state after the warm-up deoptimises no optimised code (no deopt wave in the first seconds of the match)', () => {
    // Fails without warmUpSim's thrown-away first state: the first state built after settleStateShapes had generalised
    // the hidden classes migrated the object literals' boilerplates, and the match's own initMatch then marked ~90
    // optimised sim / AI functions for deoptimisation ("code dependencies"), all re-optimised in the measured window.
    const r = spawnSync(process.execPath, ['--trace-deopt', '--import', 'tsx', 'tests/perf/fin-p-deopt-probe.ts', '300'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    const at = (m: string): number => lines.findIndex((l) => l.startsWith(`FINP-MARK ${m}`));
    const warmed = at('warmed'), built = at('built'), played = at('played');
    expect(warmed).toBeGreaterThan(0);
    expect(built).toBeGreaterThan(warmed);
    expect(played).toBeGreaterThan(built);
    const marks = (a: number, b: number): number => lines.slice(a, b).filter((l) => l.includes('marking dependent code')).length;
    // The warm-up itself optimises and deoptimises freely (that is its job).
    expect(marks(0, warmed)).toBeGreaterThan(0);
    expect(marks(warmed, built), 'deopt wave when the match state is built').toBe(0);
    expect(marks(built, played), 'dependent-code deopts in the first 300 ticks of the match').toBeLessThanOrEqual(2);
  }, 150_000);

  it('fin-p: the state copier and hasher box nothing in the first ticks of the match after the warm-up (no allocation burst)', () => {
    // The loop's copyState(prev, curr) and the replay recorder's hashState, the first 120 ticks after the warm-up, exact
    // sampling (tests/perf/fin-p-copier-probe.ts). Was 10.3 KB a tick: the copier was primed into dictionary-mode objects
    // (cloneState) so its stores went generic, the app's fresh interpolation state had small-integer slots and arrays that
    // changed map on the first fraction copied ("wrong map" deopts), and the warm-up never ran the copier or hasher.
    const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--import', 'tsx', 'tests/perf/fin-p-copier-probe.ts', '120'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { perTick: number; sites: [string, number][] };
    console.log(`FIN-P copier + hasher after warm-up: ${res.perTick.toFixed(0)} B/tick; ${JSON.stringify(res.sites.slice(0, 4))}`);
    expect(res.perTick, JSON.stringify(res.sites)).toBeLessThan(1500);
  }, 150_000);

  it('fin-p: warmUpSim plays open play and every restart kind on its own scratch state', () => {
    const ran = warmUpSim((c) => initMatch(c), benchSetup(1).config);
    expect(ran).toBeGreaterThanOrEqual(T_WARMUP.openPlayTicks);
    expect(simWarmedTicks()).toBe(ran);
    const ph = simWarmedPhases();
    for (const p of [MatchPhase.KICK_OFF, MatchPhase.IN_PLAY, MatchPhase.CORNER, MatchPhase.FREE_KICK, MatchPhase.PENALTY,
      MatchPhase.THROW_IN, MatchPhase.GOAL_KICK]) {
      expect((ph >> p) & 1, MatchPhase[p]).toBe(1);
    }
  }, 120_000);

  it('fin-p: a match after the warm-up is bit-identical to the same match before it (hash every 250 ticks)', () => {
    const before = simWarmedTicks();
    warmUpOnce((c) => initMatch(c), benchSetup(1).config);
    const once = simWarmedTicks();
    expect(once - before).toBeGreaterThanOrEqual(T_WARMUP.openPlayTicks);
    warmUpOnce((c) => initMatch(c), benchSetup(1).config); // once per process
    expect(simWarmedTicks()).toBe(once);
    expect(run(1, 3000, 250)).toEqual(cold);
  }, 120_000);

  it('fin-p: warmUpOnce never fails a match load (a throwing state builder is swallowed, and it is not retried)', async () => {
    vi.resetModules();
    const w = await import('../../src/sim/init');
    expect(() => w.warmUpOnce(() => { throw new Error('boom'); }, benchSetup(1).config)).not.toThrow();
    expect(w.simWarmedTicks()).toBe(0);
    w.warmUpOnce((c) => initMatch(c), benchSetup(1).config);
    expect(w.simWarmedTicks()).toBe(0);
  });
});

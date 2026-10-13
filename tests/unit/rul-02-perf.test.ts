/**
 * RUL-02 budgets: the per-tick throw-in paths (throwInTick with an AI-driven taker previewing his target, throwInInput
 * with the stick aiming, the THROW_IN handler while holding) are a tiny share of the 2.5 ms sim + AI tick and
 * allocate nothing per tick; the one-off throw solve stays well under a tenth of a tick budget.
 *
 * Measured on an esbuild bundle of the modules (one scope, like the production build): Vitest's module runner turns
 * every imported binding into a getter call, which inflates timings and makes V8 box doubles it would otherwise keep
 * unboxed. Timings are the best of many short batches.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import type { InputFrame } from '../../src/contracts/input';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import type { ActionHandler } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';

interface Solution { speed: number; angle: number; flightT: number; range: number; reached: number }
interface Bundle {
  awardRestart: (s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventBuffer) => void;
  restartTick: (s: SimState, ev: EventBuffer) => void;
  throwInTick: (s: SimState, ev: EventBuffer) => void;
  throwInInput: (s: SimState, c: number, f: InputFrame, ev: EventBuffer) => void;
  throwInHandler: ActionHandler;
  solveThrow: (d: number, y0: number, long: number, out: Solution) => void;
  createThrowSolution: () => Solution;
  ThrowState: { HOLD: number };
  initMatch: (c: MatchConfig) => SimState;
  createMatchConfig: () => MatchConfig;
  createEventBuffer: () => EventBuffer;
  createInputFrame: () => InputFrame;
}

const ROOT = resolve(__dirname, '../..');
let m: Bundle;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rul-02-bench-'));
  const src = (f: string): string => JSON.stringify(join(ROOT, f));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    `export { awardRestart, restartTick } from ${src('src/sim/rules/restart')};`,
    `export { throwInTick, throwInInput, throwInHandler, solveThrow, createThrowSolution, ThrowState } from ${src('src/sim/rules/throwin')};`,
    `export { initMatch } from ${src('src/sim/init')};`,
    `export { createMatchConfig } from ${src('src/contracts/state')};`,
    `export { createInputFrame } from ${src('src/contracts/input')};`,
    `export { createEventBuffer } from ${src('src/sim/core/events')};`,
  ].join('\n'));
  const outfile = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error',
    define: { __DEV_BUILD__: 'false' } });
  try {
    m = (await import(/* @vite-ignore */ pathToFileURL(outfile).href)) as Bundle;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throw-in for team 0 (human side, so nothing throws by itself), ready, taker holding the ball. */
function holding(ev: EventBuffer): { s: SimState; t: number } {
  const cfg = m.createMatchConfig();
  cfg.humans[0] = { kind: ControllerKind.HUMAN, side: 0, assist: 0, autoSwitch: 1, fastPower: 0 };
  const s = m.initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  // Everybody within throwing range of the spot (10, 34), so every receiver scan does its full work.
  for (let i = 1; i < 11; i++) {
    const a = s.players[i]!;
    a.x = 2 + (i % 5) * 5; a.z = 30 - Math.floor(i / 5) * 9 - (i % 3) * 2;
    const o = s.players[11 + i]!;
    o.x = a.x + 1.5; o.z = a.z - 1.5;
  }
  ev.begin(0);
  m.awardRestart(s, RestartKind.THROW_IN, 0, 10, 34, ev);
  for (let i = 0; i <= T_RULES.restartSetupTicks; i++) {
    ev.begin(i);
    s.match.phaseT++;
    m.restartTick(s, ev);
    m.throwInTick(s, ev);
  }
  const t = s.match.restart.taker;
  expect(s.match.restart.ready).toBe(1);
  expect(s.ball.owner).toBe(t);
  expect(s.players[t]!.actA).toBe(m.ThrowState.HOLD);
  s.match.restart.timeoutT = 1e9; // never reach the Default while measuring
  return { s, t };
}

function bestBatchMs(fn: () => void, iterations: number, batches: number): number {
  for (let i = 0; i < iterations; i++) fn();
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

function bytesPerCall(fn: () => void, n: number): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn();
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) fn();
  return (process.memoryUsage().heapUsed - h0) / n;
}

describe('RUL-02 budgets', () => {
  it('per-tick paths < 0.01 ms each; the throw solve < 0.25 ms', () => {
    const ev = m.createEventBuffer();
    const { s, t } = holding(ev);
    const p = s.players[t]!;
    const f = m.createInputFrame();
    const c = s.ctrl[0]!;
    const tick = (): void => { m.throwInTick(s, ev); };
    const input = (): void => { c.mx = 0.6; c.mz = -0.8; c.buttons = 0; c.prevButtons = 0; m.throwInInput(s, 0, f, ev); };
    const hold = (): void => { p.actT++; m.throwInHandler.update(s, t, ev); };
    expect(bestBatchMs(tick, 2000, 20)).toBeLessThan(0.01);
    expect(bestBatchMs(input, 2000, 20)).toBeLessThan(0.01);
    expect(bestBatchMs(hold, 2000, 20)).toBeLessThan(0.01);
    const sol = m.createThrowSolution();
    let d = 3;
    const solve = (): void => { m.solveThrow(d, 2.0, d > 20 ? 1 : 0, sol); d = d >= 40 ? 3 : d + 0.37; };
    expect(bestBatchMs(solve, 200, 10)).toBeLessThan(0.25);
    expect(s.match.restart.taken).toBe(0);
    expect(p.actA).toBe(m.ThrowState.HOLD);
  });

  it('per-tick paths allocate nothing (AI preview, stick aim, holding)', () => {
    const ev = m.createEventBuffer();
    const { s, t } = holding(ev);
    const p = s.players[t]!;
    const f = m.createInputFrame();
    const c = s.ctrl[0]!;
    expect(bytesPerCall(() => m.throwInTick(s, ev), 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { c.mx = 0.6; c.mz = -0.8; c.buttons = 0; c.prevButtons = 0; m.throwInInput(s, 0, f, ev); }, 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { p.actT++; m.throwInHandler.update(s, t, ev); }, 50000)).toBeLessThan(1);
    expect(s.match.restart.taken).toBe(0);
  });
});

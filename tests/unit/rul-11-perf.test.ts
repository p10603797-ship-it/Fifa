/**
 * RUL-11 budgets: restartTick (ready, with and without pushing an illegal opponent) and watchdogTick (IN_PLAY checks)
 * are a tiny share of the 2.5 ms sim + AI tick and allocate nothing per tick.
 *
 * Measured on an esbuild bundle of the modules (one scope, like the production build): Vitest's module runner turns
 * every imported binding into a getter call, which inflates timings and makes V8 box doubles it would otherwise keep
 * unboxed, so it says little about the iPad build. Timings are the best of many short batches.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';

interface Bundle {
  awardRestart: (s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventBuffer) => void;
  restartTick: (s: SimState, ev: EventBuffer) => void;
  isLegalRestartPosition: (s: SimState, slot: number) => boolean;
  watchdogTick: (s: SimState, ev: EventBuffer) => void;
  initMatch: (c: MatchConfig) => SimState;
  createMatchConfig: () => MatchConfig;
  createEventBuffer: () => EventBuffer;
}

const ROOT = resolve(__dirname, '../..');
let m: Bundle;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rul-11-bench-'));
  const src = (f: string): string => JSON.stringify(join(ROOT, f));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    `export { awardRestart, restartTick, isLegalRestartPosition } from ${src('src/sim/rules/restart')};`,
    `export { watchdogTick } from ${src('src/sim/rules/watchdog')};`,
    `export { initMatch } from ${src('src/sim/init')};`,
    `export { createMatchConfig } from ${src('src/contracts/state')};`,
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

function readyFreeKick(ev: EventBuffer): SimState {
  const s = m.initMatch(m.createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  ev.begin(0);
  m.awardRestart(s, RestartKind.FREE_KICK, 0, 20, 5, ev);
  for (let i = 0; i <= T_RULES.restartSetupTicks; i++) { ev.begin(i); m.restartTick(s, ev); }
  s.match.restart.timeoutT = 1e9; // never reach the Default while measuring
  return s;
}

function inPlay(): SimState {
  const s = m.initMatch(m.createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  return s;
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

describe('RUL-11 budgets', () => {
  it('restartTick (ready, pushing) < 0.01 ms and watchdogTick < 0.005 ms', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const p = s.players[15]!;
    const push = (): void => { p.x = 22; p.z = 6; p.vx = -1; p.vz = 0; m.restartTick(s, ev); };
    const w = inPlay();
    const dog = (): void => { w.ball.idleT = 100; w.match.phaseT = 100; m.watchdogTick(w, ev); };
    expect(bestBatchMs(push, 2000, 20)).toBeLessThan(0.01);
    expect(bestBatchMs(dog, 5000, 20)).toBeLessThan(0.005);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(w.match.watchdogCount).toBe(0);
  });

  it('per-tick paths allocate nothing (waiting, pushing, legality checks, watchdog)', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const p = s.players[15]!;
    const w = inPlay();
    expect(bytesPerCall(() => m.restartTick(s, ev), 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { p.x = 22; p.z = 6; p.vx = -1; p.vz = 0; m.restartTick(s, ev); }, 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { m.isLegalRestartPosition(s, 15); }, 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { w.ball.idleT = 100; w.match.phaseT = 100; m.watchdogTick(w, ev); }, 50000)).toBeLessThan(1);
  });
});

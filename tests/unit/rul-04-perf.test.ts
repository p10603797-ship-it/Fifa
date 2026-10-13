/**
 * RUL-04 budgets: the per-tick corner paths (cornerTick with the taker lining up, cornerInput moving the reticle with
 * both sticks and moving a defending player) are a tiny share of the 2.5 ms sim + AI tick and allocate nothing per
 * tick; the Default (run once per corner) stays well under a tenth of a millisecond.
 *
 * Measured on an esbuild bundle of the modules (one scope, like the production build), as RUL-11 / RUL-03 do: Vitest's
 * module runner turns imported bindings into getter calls and makes V8 box doubles it would otherwise keep unboxed.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import type { InputFrame } from '../../src/contracts/input';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';

interface Bundle {
  awardRestart: (s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventBuffer) => void;
  restartTick: (s: SimState, ev: EventBuffer) => void;
  cornerTick: (s: SimState, ev: EventBuffer) => void;
  cornerInput: (s: SimState, c: number, f: InputFrame, ev: EventBuffer) => void;
  cornerDefault: (s: SimState, ev: EventBuffer) => void;
  initMatch: (c: MatchConfig) => SimState;
  createMatchConfig: () => MatchConfig;
  createEventBuffer: () => EventBuffer;
  createInputFrame: () => InputFrame;
}

const ROOT = resolve(__dirname, '../..');
let m: Bundle;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rul-04-bench-'));
  const src = (f: string): string => JSON.stringify(join(ROOT, f));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    `export { awardRestart, restartTick } from ${src('src/sim/rules/restart')};`,
    `export { cornerTick, cornerInput, cornerDefault } from ${src('src/sim/rules/corner')};`,
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

/** Corner for home (human P1 holds the taker), ready, P2 human on the away side holding slot 15. */
function readyCorner(ev: EventBuffer): SimState {
  const cfg = m.createMatchConfig();
  cfg.humans[1] = { ...cfg.humans[0]!, kind: ControllerKind.HUMAN, side: 1 };
  const s = m.initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  ev.begin(0);
  m.awardRestart(s, RestartKind.CORNER, 0, 52, 33.5, ev);
  for (let i = 0; i <= T_RULES.restartSetupTicks; i++) { ev.begin(i); s.match.phaseT++; m.restartTick(s, ev); }
  if (s.match.restart.ready !== 1) throw new Error('corner not ready');
  s.match.restart.timeoutT = 1e9; // never reach the Default while measuring
  s.ctrl[0]!.slot = s.match.restart.taker;
  s.ctrl[1]!.slot = 15;
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

/** Heap bytes per call: the least of three measurements (a one-off JIT / GC bookkeeping blip is not per-call). */
function bytesPerCall(fn: () => void, n: number): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn();
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, (process.memoryUsage().heapUsed - h0) / n);
  }
  return best;
}

describe('RUL-04 budgets', () => {
  it('per-tick paths: cornerTick and cornerInput < 0.005 ms; Default < 0.1 ms', () => {
    const ev = m.createEventBuffer();
    const s = readyCorner(ev);
    const r = s.match.restart;
    const taker = s.players[r.taker]!;
    expect(taker.act).toBe(ActionKind.SET_PIECE);
    let flip = 0;
    const tick = (): void => { flip ^= 1; r.aimX = 44; r.aimZ = flip ? 6 : -6; m.cornerTick(s, ev); };
    const aim = m.createInputFrame();
    aim.mx = 60; aim.mz = -100; aim.ax = -40; aim.az = 90;
    const defend = m.createInputFrame();
    defend.mx = -127;
    const input = (): void => { flip ^= 1; aim.mz = flip ? -100 : 100; m.cornerInput(s, 0, aim, ev); m.cornerInput(s, 1, defend, ev); };
    expect(bestBatchMs(tick, 5000, 20)).toBeLessThan(0.005);
    expect(bestBatchMs(input, 5000, 20)).toBeLessThan(0.005);
    const dflt = (): void => { m.cornerDefault(s, ev); taker.act = ActionKind.SET_PIECE; };
    expect(bestBatchMs(dflt, 500, 10)).toBeLessThan(0.1);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(r.taken).toBe(0); // no actions tick runs here: no kick reaches its contact while measuring
  });

  it('per-tick paths allocate nothing (waiting taker lining up, reticle moving, defending player moving)', () => {
    const ev = m.createEventBuffer();
    const s = readyCorner(ev);
    const r = s.match.restart;
    let flip = 0;
    const aim = m.createInputFrame();
    aim.mx = 60; aim.mz = -100; aim.ax = -40; aim.az = 90;
    const defend = m.createInputFrame();
    defend.mx = -127; defend.mz = 30;
    expect(bytesPerCall(() => { flip ^= 1; r.aimZ = flip ? 6 : -6; m.cornerTick(s, ev); }, 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => { flip ^= 1; aim.mz = flip ? -100 : 100; m.cornerInput(s, 0, aim, ev); }, 50000)).toBeLessThan(1);
    expect(bytesPerCall(() => m.cornerInput(s, 1, defend, ev), 50000)).toBeLessThan(1);
  });
});

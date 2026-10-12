/**
 * SIM-01 determinism: ball flight, predictions and the solvers give identical bits in a fresh Node process, in this
 * warmed-up worker, and in Bun (JavaScriptCore, Safari's engine) when it is installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const src = (p: string): string => JSON.stringify(join(ROOT, 'src', p));

/** Probe: a pure function of the code under test; prints one JSON line when run as a script with --print. */
const PROBE = `
import { createBallState } from ${src('contracts/state.ts')};
import { createBallPrediction } from ${src('contracts/systems.ts')};
import {
  ballAirStep, createLaunchSolution, groundPassSpeed, groundRollTime, launchSpin, predictBall, solveLaunch,
  solveLaunchSpin, ticksToHeight,
} from ${src('sim/ball/flight.ts')};
import { hashValue } from ${src('sim/core/hash.ts')};

export function probe(): Record<string, number> {
  let x = 0x5101 >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const out: Record<string, number> = {};
  const air: number[] = [];
  const b = createBallState();
  for (let k = 0; k < 200; k++) {
    b.x = (rnd() - 0.5) * 80; b.y = 0.11 + rnd() * 10; b.z = (rnd() - 0.5) * 50;
    b.vx = (rnd() - 0.5) * 70; b.vy = (rnd() - 0.5) * 40; b.vz = (rnd() - 0.5) * 70;
    b.sx = (rnd() - 0.5) * 30; b.sy = (rnd() - 0.5) * 30; b.sz = (rnd() - 0.5) * 30;
    for (let i = 0; i < 50; i++) ballAirStep(b, (1 + Math.floor(rnd() * 8)) / 480);
    air.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.sx, b.sy, b.sz);
  }
  out.air = hashValue(air);
  const p = createBallPrediction();
  const pred: number[] = [];
  for (let k = 0; k < 60; k++) {
    b.x = (rnd() - 0.5) * 100; b.z = (rnd() - 0.5) * 64; b.y = rnd() < 0.3 ? 0.11 : 0.11 + rnd() * 6;
    b.vx = (rnd() - 0.5) * 60; b.vz = (rnd() - 0.5) * 40; b.vy = b.y === 0.11 && rnd() < 0.5 ? 0 : (rnd() - 0.2) * 20;
    b.sx = (rnd() - 0.5) * 20; b.sy = (rnd() - 0.5) * 20; b.sz = (rnd() - 0.5) * 20;
    b.grounded = b.y === 0.11 && b.vy === 0 ? 1 : 0; b.inNet = 0; b.owner = -1; b.heldBy = -1; b.bounces = 0;
    predictBall(b, 180, p);
    for (let i = 0; i < p.count; i++) pred.push(p.x[i], p.y[i], p.z[i]);
    pred.push(p.landIndex, ticksToHeight(b, 0.11 + rnd() * 3));
  }
  out.predict = hashValue(pred);
  const v = { x: 0, y: 0, z: 0 };
  const sol = createLaunchSolution();
  const solv: number[] = [];
  for (let k = 0; k < 80; k++) {
    // Inputs from the LCG only (Math.cos / Math.sin would differ between engines).
    const dx = (rnd() - 0.5) * 100;
    const dz = (rnd() - 0.5) * 100;
    solv.push(solveLaunch(dx, dz, 0.1 + rnd() * 1.3, v), v.x, v.y, v.z);
    solv.push(solveLaunchSpin(dx, dz, 0.2 + rnd(), 0.11 + rnd(), (rnd() - 0.5) * 24,
      (rnd() - 0.5) * 24, sol), sol.vx, sol.vy, sol.vz, sol.sx, sol.sy, sol.sz, sol.flightT, sol.landX, sol.landZ, sol.reached);
    solv.push(groundPassSpeed(rnd() * 60, rnd() * 10), groundRollTime(5 + rnd() * 30, rnd() * 50));
    launchSpin(rnd() - 0.5, rnd() - 0.5, rnd() * 9, rnd() * 12, v);
    solv.push(v.x, v.y, v.z);
  }
  out.solvers = hashValue(solv);
  return out;
}

if ((globalThis as { process?: { argv?: string[] } }).process?.argv?.includes('--print')) console.log(JSON.stringify(probe()));
`;

function findBun(): string | null {
  const candidates = [process.env.BUN_BIN, 'bun', join(homedir(), '.bun/bin/bun')].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

function writeProbe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sim-01-det-'));
  const file = join(dir, 'probe.ts');
  writeFileSync(file, PROBE);
  return file;
}

function runProbe(cmd: string, args: string[]): Record<string, number> {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
}

const BUN = findBun();
const TSX = existsSync(join(ROOT, 'node_modules/tsx'));

describe('SIM-01 determinism across processes and engines', () => {
  it.skipIf(!TSX)('fresh Node process == this warmed-up worker, and repeated runs agree', async () => {
    const file = writeProbe();
    try {
      const fresh = runProbe(process.execPath, ['--import', 'tsx', file, '--print']);
      const mod = (await import(/* @vite-ignore */ file)) as { probe: () => Record<string, number> };
      const first = mod.probe();
      for (let i = 0; i < 2; i++) mod.probe();
      expect(mod.probe()).toEqual(first);
      expect(first).toEqual(fresh);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(BUN === null || !TSX)('V8 (Node) and JavaScriptCore (Bun, the Safari engine) agree bit-for-bit', () => {
    const file = writeProbe();
    try {
      const v8 = runProbe(process.execPath, ['--import', 'tsx', file, '--print']);
      const jsc = runProbe(BUN!, [file, '--print']);
      expect(jsc).toEqual(v8);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  }, 180_000);
});

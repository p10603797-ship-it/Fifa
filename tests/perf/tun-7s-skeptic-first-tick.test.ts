/**
 * [TUN-7S skeptic] QF-7S (a) / QA-36: the generated hasher moved its whole cost into the first ticks of play. In a fresh
 * process (the app's first match) the first hashState of the live state (the replay recorder at tick 60, net desync at
 * tick 30) generated and compiled the hasher and built a ~28 KB shape signature: 1.59 MB allocated and a `new Function`
 * compile inside one tick (~13 ms without a profiler; HEAD's generic first hash ~2.3 ms; x4 on an iPad), and every later
 * match regenerated the hasher's code and the signature on its first hash (0.48 MB, ~7 ms). (The app builds prev with
 * app/liveState.ts cloneLiveState, whose copyState already validated the copy pair on the loading screen.) Now initMatch
 * (the loading screen) compiles and runs the copier and the hasher once per process, and a state of a compiled shape is
 * recognised by a generated shape checker (no signature string, no code generation). Measured exactly in a child
 * process by tests/perf/tun-7s-skeptic-first-tick-probe.ts (--single-threaded: synchronous compilation, constant 4-byte
 * sampling).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from './qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Row { match: number; codegenInit: number; codegenTick: number; tickBytes: number; copyMs: number; hashMs: number; initMs: number }

describe('TUN-7S skeptic: no copier / hasher generation in the first tick of a match', () => {
  const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/perf/tun-7s-skeptic-first-tick-probe.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  const rows: Row[] = r.status === 0 ? r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Row) : [];
  if (rows.length) console.log(`TUN-7S first tick: ${rows.map((x) => `match ${x.match}: ${x.tickBytes} B, copy ${x.copyMs.toFixed(1)} ms, hash ${x.hashMs.toFixed(1)} ms, initMatch ${x.initMs.toFixed(1)} ms`).join('; ')}`);

  it('probe ran (two matches)', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(rows.length).toBe(2);
  });

  it('the loading screen (initMatch + prev) compiles the copier and the hasher on the first match, never again', () => {
    expect(rows[0]!.codegenInit).toBeGreaterThanOrEqual(2);
    expect(rows[1]!.codegenInit).toBe(0);
  });

  it('the first tick of each match generates no code', () => {
    expect(rows[0]!.codegenTick).toBe(0);
    expect(rows[1]!.codegenTick).toBe(0);
  });

  it('the first tick\'s copyState + hashState build no signature / code (was 1.59 MB first match, 0.48 MB later)', () => {
    expect(rows[0]!.tickBytes).toBeLessThan(400_000);
    expect(rows[1]!.tickBytes).toBeLessThan(120_000);
  });
}, 180_000);

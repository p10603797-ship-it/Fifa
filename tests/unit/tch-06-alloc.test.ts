/**
 * TCH-06: the set-piece swipe allocates nothing per pointer move, per animation frame (throttled preview refresh) or
 * per whole swipe (down, moves, lift, emitted gesture), measured with a stub previewFlight so this is setpiece.ts
 * itself. Runs tests/unit/tch-06-alloc-probe.ts in child processes with --expose-gc (one per path).
 * (The probe's 'rul05' path measures the real RUL-05 previewFlight; reported to the lead, not asserted here.)
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function probe(path: string): number {
  const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/tch-06-alloc-probe.ts', path, '20000'], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  expect(r.status, r.stderr).toBe(0);
  const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
  expect(Object.keys(bytes)).toEqual([path]);
  return bytes[path]!;
}

describe('TCH-06 allocation', () => {
  it('pointer moves with the throttled flight preview allocate nothing', () => {
    expect(probe('moves')).toBeLessThan(4);
  }, 300_000);
  it('per-frame update() with the finger resting (refresh every 2nd frame) allocates nothing', () => {
    expect(probe('frames')).toBeLessThan(4);
  }, 300_000);
  it('a whole swipe (down, 12 moves, lift, gesture queued) allocates nothing to speak of', () => {
    expect(probe('gestures')).toBeLessThan(8);
  }, 300_000);
});

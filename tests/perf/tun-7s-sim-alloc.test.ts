/**
 * [TUN-7S] QF-7S (c): steady per-tick allocation of the sim + AI in live play (V8), measured exactly and
 * load-independently by tests/perf/tun-7s-sim-alloc-probe.ts in a child process (--single-threaded: synchronous
 * compilation; constant 4-byte sampling interval: every allocation sampled once at its size; TurboFan at Chromium's
 * Maglev threshold). The fixed sites were V8 boxing doubles: ticksToReach / ticksToReachAtSpeed took the target and the
 * speed cap as arguments (boxed at every call: computeEff, evalIntercept, press, keepers...), and merged the untyped speed
 * cap with a double (a tagged phi that boxed every double merged with it): 4.4 KB per tick in ticksToReachAtSpeed,
 * 1.3 KB in SIM-16 computeEff, 0.6 KB in TAI-07 evalIntercept. JavaScriptCore (iPad Safari) NaN-boxes doubles, so
 * there this was never allocation; Chromium / Android pay it as minor GCs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, STEADY_FLAGS } from './qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TICKS = 1500;

describe('TUN-7S sim + AI steady allocation', () => {
  const r = spawnSync(process.execPath, [
    ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/perf/tun-7s-sim-alloc-probe.ts',
    '2000', String(TICKS), '20261023', '3', '4', '15000',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
  const res = r.status === 0
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytesPerTick: number; sites: { site: string; bytes: number }[] }
    : null;
  const perTick = (fn: string): number => {
    let b = 0;
    for (const x of res?.sites ?? []) if (x.site.startsWith(`${fn} `)) b += x.bytes;
    return b / TICKS;
  };
  if (res) console.log(`TUN-7S sim+AI allocation: ${res.bytesPerTick.toFixed(0)} B/tick; top ${res.sites.slice(0, 5).map((x) => `${x.site} ${(x.bytes / TICKS).toFixed(0)}`).join(', ')}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('ticksToReach / ticksToReachAtSpeed box no doubles (target and cap through a scratch, no tagged phi)', () => {
    expect(res).not.toBeNull();
    expect(perTick('ticksToReachCore') + perTick('ticksToReachAtSpeed') + perTick('ticksToReach')).toBeLessThan(100);
  });

  it('their heaviest callers box no arguments for them (SIM-16 computeEff, TAI-07 evalIntercept)', () => {
    expect(res).not.toBeNull();
    expect(perTick('computeEff')).toBeLessThan(100);
    expect(perTick('evalIntercept')).toBeLessThan(100);
  });

  it('total sim + AI allocation stays under 10 KB per tick in this window (was 14.4 KB before QF-7S)', () => {
    expect(res).not.toBeNull();
    expect(res!.bytesPerTick).toBeLessThan(10_000);
  });
}, 300_000);

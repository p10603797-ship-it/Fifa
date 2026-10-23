/**
 * [TUN-7S] QA-37 / QF-7S (d): whole-step sim + AI tick time in worst cases against the 2.5 ms average iPad budget
 * (BRIEF §13 / _COMMON determinism rules). Measured in a child process by tests/perf/tun-7s-tick-probe.ts (live play, a
 * crowded box, 22 chasers, a corner, a free kick on the edge of the box, a shoot-out; Legend v Legend). Scale: this
 * container's Node is taken as 4x an iPad's JavaScriptCore (the factor the TAI budget tests use; conservative for an
 * M-series iPad), so each scenario's mean must stay under 2500 / 4 = 625 us here. Typical numbers: docs/PERF_REPORT.md.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IPAD_FACTOR = 4;
const BUDGET_US = 2500 / IPAD_FACTOR;
const SCENARIOS = ['livePlay', 'crowdedBox', 'chasers22', 'corner', 'freeKickEdgeOfBox', 'shootout'] as const;
/**
 * [TUN-7S skeptic] Minimum share of measured ticks that must be the scenario it names (the probe's `valid`): the measured
 * pass used to continue from the end of the warm-up pass, so the shoot-out timed 77% POST_MATCH ticks. A corner / free
 * kick window also holds the play right after the kick (reset every 240 ticks).
 */
const MIN_VALID: Record<(typeof SCENARIOS)[number], number> = {
  livePlay: 0.8, crowdedBox: 0.8, chasers22: 0.8, corner: 0.4, freeKickEdgeOfBox: 0.6, shootout: 0.9,
};

describe('TUN-7S worst-case tick time', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'tests/perf/tun-7s-tick-probe.ts', '3000'], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const res = r.status === 0
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, { meanUs: number; p99Us: number; maxUs: number; valid: number }>
    : null;
  if (res) {
    console.log(`TUN-7S tick time (us, mean / p99 / max): ${SCENARIOS.map((k) => `${k} ${res[k]!.meanUs.toFixed(0)} / ${res[k]!.p99Us.toFixed(0)} / ${res[k]!.maxUs.toFixed(0)}`).join('; ')}`);
  }

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const k of SCENARIOS) {
    it(`${k}: the measured ticks are the scenario (share >= ${MIN_VALID[k]})`, () => {
      expect(res).not.toBeNull();
      expect(res![k]!.valid).toBeGreaterThanOrEqual(MIN_VALID[k]);
    });
    it(`${k}: mean tick within the iPad budget (2.5 ms / ${IPAD_FACTOR})`, () => {
      expect(res).not.toBeNull();
      expect(res![k]!.meanUs).toBeLessThan(BUDGET_US);
    });
  }
}, 300_000);

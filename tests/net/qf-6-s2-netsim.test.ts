/**
 * [QF-6, second pass] Two-instance harness (DoD 5 style) on link shapes the first pass did not cover:
 *  - asymmetric links (a slow uplink on one side, e.g. a phone hotspot): time sync must settle the two sims at the
 *    centre so neither side stalls on every frame, with no desync;
 *  - periodic Wi-Fi scan blackouts (100 % loss and a latency jump for 400 ms every 7 s): every blackout is a short
 *    stall, never a desync or a deadlock.
 */
import { describe, expect, it } from 'vitest';
import { netsimConfig, runNetsim } from '../../tools/netsim';

describe('QF-6 second pass: asymmetric and bursty links in the two-instance harness', () => {
  it('glitch: desync — an asymmetric link (150 ms one way, 20 ms back) plays a full match clean in both directions', async () => {
    for (const dir of ['guestToHost', 'hostToGuest'] as const) {
      const r = await runNetsim({
        config: netsimConfig({ seed: 5, halfMinutes: 1 }),
        link: { latencyMs: 20, jitterMs: 5, loss: 0.02, seed: 11, [dir]: { latencyMs: 150, jitterMs: 10 } },
      });
      expect(r.ok, dir).toBe(true);
      expect(r.host.desyncs + r.guest.desyncs, dir).toBe(0);
      // Settled at the centre: only the odd short stall after the warm-up.
      for (const p of [r.host, r.guest]) {
        expect(p.stallsAfterWarmup, dir).toBeLessThan(30);
        expect(p.maxStallAfterWarmupMs, dir).toBeLessThanOrEqual(50);
      }
      // The asymmetry really is there: the slow direction carried the same traffic at 150 ms.
      expect(r.link.hostToGuest.inputsDelivered).toBeGreaterThan(1000);
      expect(r.link.guestToHost.inputsDelivered).toBeGreaterThan(1000);
    }
  }, 120_000);

  it('glitch: desync — Wi-Fi scan blackouts every 7 s at DoD conditions: short stalls only, the match finishes in step', async () => {
    const changes: { atMs: number; conditions: { loss: number; latencyMs: number } }[] = [];
    for (let t = 5000; t < 200_000; t += 7000) {
      changes.push({ atMs: t, conditions: { loss: 1, latencyMs: 300 } });
      changes.push({ atMs: t + 400, conditions: { loss: 0.05, latencyMs: 80 } });
    }
    const r = await runNetsim({
      config: netsimConfig({ seed: 2, halfMinutes: 1 }),
      link: { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05, seed: 2 },
      linkChanges: changes,
    });
    expect(r.ok).toBe(true);
    expect(r.host.desyncs + r.guest.desyncs).toBe(0);
    for (const p of [r.host, r.guest]) expect(p.maxStallAfterWarmupMs).toBeLessThan(700); // a blackout plus the catch-up
  }, 120_000);
});

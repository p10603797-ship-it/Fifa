/**
 * [QF-6] Playable input delay, time sync: a side that runs a little ahead of its friend stalls briefly on every late
 * frame. Time sync is meant to hold it back once, but (1) it never polled while the last frame had ended in a stall,
 * which is exactly what running ahead looks like, and (2) it only acted from a full tick ahead, while the delay formula
 * budgets no lead at all. A guest that started 2.5 s late (a slower load) on a tight link stalled on every other tick
 * for the whole match (1,336 stalls in 50 s). Now: short stalls still let it poll, and it holds from half a tick ahead.
 */
import { describe, expect, it } from 'vitest';
import { createTimeSync } from '../../src/net/adaptive';
import { formatNetsimReport, netsimConfig, runNetsim } from '../../tools/netsim';

describe('QF-6 time sync', () => {
  it('a guest that loaded 2.5 s later on a tight link is held back instead of stalling on every other tick', async () => {
    for (const [startOffsetMs, bw] of [[2500, 12_000], [80, 12_000]] as const) {
      const r = await runNetsim({
        config: netsimConfig({ seed: 12 }), maxTicks: 3000, startOffsetMs,
        link: { latencyMs: 80, jitterMs: 10, loss: 0.02, bandwidthBytesPerSec: bw, seed: 12 },
      });
      const line = formatNetsimReport(r);
      expect(r.ok, line).toBe(true);
      for (const p of [r.host, r.guest]) expect(p.stallsAfterWarmup, `offset ${startOffsetMs}: ${line}`).toBeLessThan(30);
    }
  }, 120_000);

  it('holds from half a tick ahead (a lead the delay formula has no room for)', () => {
    const ts = createTimeSync();
    for (let i = 0; i < 40; i++) ts.onPacket(101 + i, 100 + i, 0.4); // raw 1, the other side reports 0.4: 0.3 ahead
    expect(ts.poll(10_000)).toBe(0);
    const lead = createTimeSync();
    for (let i = 0; i < 40; i++) lead.onPacket(101 + i, 100 + i, -0.4); // 0.7 ahead
    expect(lead.advantage).toBeCloseTo(0.7, 1);
    expect(lead.poll(10_000)).toBe(1);
  });
});

/**
 * [QF-6] Definition of done 5 across seeds (two-instance harness, tools/netsim.ts): a full match at 80 ms each way,
 * 20 ms jitter and 5 % loss (inputs and reliable retransmissions) with no desync and a playable input delay. The NET-B
 * DoD test used one seed; seed 6 showed that the harness started every match cold at delay 3 (the app's lobby measures
 * the round trip first), so the first ~8 s of play stalled every other frame for up to 100 ms. The harness now has the
 * lobby phase and the lockstep continues from the transport's round-trip estimate.
 */
import { describe, expect, it } from 'vitest';
import { formatNetsimReport, netsimConfig, runNetsim } from '../../tools/netsim';

const DOD_LINK = { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05 };

describe('QF-6 definition of done 5 on more seeds', () => {
  it('glitch: desync — a full match at 80 ms each way, 20 ms jitter and 5 % loss on seeds 6 and 9: no desync, rare short stalls', async () => {
    for (const seed of [6, 9]) {
      const r = await runNetsim({ config: netsimConfig({ seed, halfMinutes: 2 }), link: { ...DOD_LINK, seed } });
      const line = formatNetsimReport(r);
      expect(r.ok, line).toBe(true);
      expect(r.finished).toBe(true);
      expect(r.hashesEqual).toBe(true);
      expect(r.framesEqual).toBe(true);
      expect(r.host.desyncs + r.guest.desyncs, line).toBe(0);
      expect(r.host.delayMin, line).toBe(8); // the lobby's measurement already asks for the delay this link needs
      for (const p of [r.host, r.guest]) {
        expect(p.maxStallAfterWarmupMs, line).toBeLessThanOrEqual(50);
        expect(p.stallsAfterWarmup, line).toBeLessThan(p.ticks / 200);
      }
    }
  }, 300_000);
});

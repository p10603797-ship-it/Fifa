/**
 * [NET-08] Network simulator and two-instance harness: deterministic runs, identical final hashes, induced desync
 * detected and repaired, a bandwidth-capped link, and definition of done 5 (a full match at 80 ms each way, 20 ms
 * jitter and 5 % loss with no desync; 2-minute halves in CI). NETSIM_LONG=1 runs the long version (4-minute halves,
 * three seeds; NETSIM_HALF_MINUTES overrides the length).
 */
import { describe, expect, it } from 'vitest';
import { formatNetsimReport, netsimConfig, runNetsim, type NetsimReport } from '../../tools/netsim';

const DOD_LINK = { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05 };

function strip(r: NetsimReport): Omit<NetsimReport, 'wallMs'> {
  const { wallMs, ...rest } = r;
  void wallMs;
  return rest;
}

describe('NET-08 two-instance harness', () => {
  it('is deterministic: the same seeds give the same report', async () => {
    const opts = { config: netsimConfig({ seed: 77 }), maxTicks: 600, link: { ...DOD_LINK, duplicate: 0.05, seed: 77 } };
    const a = await runNetsim(opts);
    const b = await runNetsim(opts);
    expect(strip(a)).toEqual(strip(b));
    expect(a.ok).toBe(true);
    expect(a.host.ticks).toBe(600);
    expect(a.hashesEqual).toBe(true);
    expect(a.host.finalHash).toBe(a.guest.finalHash);
  });

  it('reports an induced desync, repairs it and ends with identical hashes', async () => {
    const reports: unknown[] = [];
    const r = await runNetsim({
      config: netsimConfig({ seed: 78 }),
      maxTicks: 900,
      link: { latencyMs: 50, jitterMs: 10, seed: 78 },
      injectDesync: { peer: 1, tick: 300, mutate: (s) => { s.ball.vz += 2; } },
      log: (_k, m, d) => { if (m.includes('desync at tick')) reports.push(d); },
    });
    expect(r.injectedAtTick).toBe(300);
    expect(r.host.desyncs).toBe(1);
    expect(r.host.firstDesyncTick).toBeLessThanOrEqual(330);
    expect(r.guest.resyncs).toBe(1);
    expect(r.ok).toBe(true);
    // Each side logged seed, tick and the 30 ticks of inputs before the mismatch (both humans).
    expect(reports.length).toBe(2);
    const rep = reports[0] as { seed: number; tick: number; inputs: { tick: number; h0: number[]; h1: number[] }[] };
    expect(rep.seed).toBe(78);
    expect(rep.inputs.length).toBe(30);
    expect(rep.inputs.at(-1)!.tick).toBe(rep.tick);
    expect(rep.inputs[0]!.h0.length).toBe(19);
    expect(rep.inputs[0]!.h1.length).toBe(19);
  });

  it('copes with a bandwidth-capped link (32 kB/s each way)', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 79 }),
      maxTicks: 900,
      link: { latencyMs: 40, jitterMs: 10, loss: 0.02, bandwidthBytesPerSec: 32_000, seed: 79 },
    });
    expect(r.ok).toBe(true);
    const secs = r.virtualMs / 1000;
    expect(r.link.hostToGuest.bytesSent / secs).toBeLessThan(32_000);
    expect(r.host.stallsAfterWarmup).toBeLessThanOrEqual(10);
  });

  it('definition of done 5: a full match at 80 ms each way, 20 ms jitter and 5 % loss with no desync', async () => {
    const r = await runNetsim({ config: netsimConfig({ seed: 2026, halfMinutes: 2 }), link: { ...DOD_LINK, seed: 2026 } });
    console.log(formatNetsimReport(r));
    expect(r.finished).toBe(true);
    expect(r.endPhase).toBe(15); // MatchPhase.POST_MATCH
    expect(r.host.ticks).toBeGreaterThan(2 * 2 * 3600);
    expect(r.hashesEqual).toBe(true);
    expect(r.framesEqual).toBe(true);
    expect(r.host.desyncs + r.guest.desyncs).toBe(0);
    expect(r.host.resyncs + r.guest.resyncs).toBe(0);
    const dropped = r.link.hostToGuest.inputsDropped + r.link.guestToHost.inputsDropped;
    const sent = r.link.hostToGuest.inputsSent + r.link.guestToHost.inputsSent;
    expect(dropped / sent).toBeGreaterThan(0.04);
    expect(r.host.delayFinal).toBe(8);
    // After warm-up the sims are rarely held, and never for long.
    for (const p of [r.host, r.guest]) {
      expect(p.maxStallAfterWarmupMs).toBeLessThanOrEqual(50);
      expect(p.stallsAfterWarmup).toBeLessThan(p.ticks / 200);
    }
    expect(r.ok).toBe(true);
  }, 300_000);

  it.skipIf(process.env.NETSIM_LONG !== '1')('long version: full-length matches on three seeds (NETSIM_LONG=1)', async () => {
    const half = Number(process.env.NETSIM_HALF_MINUTES ?? 4);
    for (const seed of [1, 2, 3]) {
      const r = await runNetsim({ config: netsimConfig({ seed, halfMinutes: half }), link: { ...DOD_LINK, seed } });
      console.log(`seed ${seed}: ${formatNetsimReport(r)}`);
      expect(r.ok).toBe(true);
      expect(r.host.desyncs + r.guest.desyncs).toBe(0);
    }
  }, 3_600_000);
});

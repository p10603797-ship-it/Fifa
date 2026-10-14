/**
 * [QF-6] Playable input delay at kick-off: the lobby picks the start delay from the round trip it has measured for a
 * while, but the match's lockstep used to start its own estimator from nothing; RFC 6298 starts the jitter at rtt / 2,
 * so the first two pings raised the delay to 7-8 ticks (117-133 ms) for the first seconds of every match on a link
 * that needs 4. The estimator now starts from the transport's smoothed round trip and jitter.
 */
import { describe, expect, it } from 'vitest';
import { computeTargetDelay } from '../../src/net/adaptive';
import { createLockstepProvider } from '../../src/net/lockstep';
import { createManualClock, createMemoryTransportPair } from '../../src/net/memoryTransport';

describe('QF-6 input delay at the start of a match', () => {
  it('a measured link keeps its start delay at kick-off instead of jumping to 7-8 ticks', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) await kickOff(seed);
  });
});

async function kickOff(seed: number): Promise<void> {
  {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 40, jitterMs: 6, seed, now: clock.now, schedule: clock.schedule });
    const opened = Promise.all([pair.host.open('host', 'ABCDEF'), pair.guest.open('guest', 'ABCDEF')]);
    clock.advance(200);
    await opened;
    clock.advance(8000); // the lobby: pings for a while
    expect(pair.host.rtt).toBeGreaterThan(75);
    expect(pair.host.rtt).toBeLessThan(100);
    const start = computeTargetDelay(pair.host.rtt, pair.host.jitter);
    expect(start).toBeLessThanOrEqual(6);
    const host = createLockstepProvider({ transport: pair.host, localHuman: 0, localSources: [], delay: start });
    const guest = createLockstepProvider({ transport: pair.guest, localHuman: 1, localSources: [], delay: start });
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      clock.advance(100);
      worst = Math.max(worst, host.adaptive.target, guest.adaptive.target);
    }
    expect(worst, `seed ${seed}: start ${start}`).toBeLessThanOrEqual(start + 1); // was 7-8 within the first second
    expect(host.adaptive.rttMs).toBeGreaterThan(75);
    host.dispose();
    guest.dispose();
  }
}

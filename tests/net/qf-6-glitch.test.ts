/**
 * [QF-6] Glitch list (BRIEF §14 Online) regression tests on the two-peer app-session harness: desync repaired on either
 * peer through the real app sessions, and a rematch that never starts with stale state from the last match (late
 * input packets, hashes and a whole snapshot of match 1 delivered into match 2; counters, pauses and guards fresh).
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { FRAME_INTS } from '../../src/net/packet';
import { encodeSnapshotSync } from '../../src/net/desync';
import type { SimState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { createOnlinePair, hashState } from './net-06-harness';
import { finalWhistleTick, lastHashedTick } from './qf-15-harness';

type Pair = ReturnType<typeof createOnlinePair>;

async function toFullTime(h: Pair): Promise<void> {
  const ok = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000);
  expect(ok).toBe(true);
}

function expectInSync(h: Pair): void {
  expect(h.host.state!.tick).toBe(h.guest.state!.tick);
  expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
}

describe('QF-6 glitch list: online', () => {
  it('glitch: desync — a divergence on the guest, then on the host, is caught within 30 ticks and repaired; both app sessions end bit-identical', async () => {
    const h = createOnlinePair({ hashEvery: 30, config: { halfMinutes: 0.3 } });
    await h.startMatch();
    await h.run(1000);
    let guestHit = -1;
    let hostHit = -1;
    h.guest.onTick = (s) => {
      if (guestHit < 0 && s.tick >= 400) {
        guestHit = s.tick;
        s.players[5]!.x += 0.75; // a guest that drifts once (a float difference, a lost write)
      }
    };
    expect(await h.runUntil(() => (h.host.os!.stats.resyncs > 0 && h.host.os!.stats.verified > 0), 10_000)).toBe(true);
    expect(h.host.os!.stats.desyncs).toBe(1);
    expect(h.guest.os!.stats.resyncs).toBe(1);
    const detected = h.host.os!.provider.lockstep!.guard.stats.firstDesyncTick;
    expect(detected - guestHit).toBeLessThanOrEqual(30);
    h.host.onTick = (s) => {
      if (hostHit < 0 && s.tick >= guestHit + 700) {
        hostHit = s.tick;
        s.ball.vx += 0.5; // now the host (the authority) drifts: its state wins, the guest follows
      }
    };
    expect(await h.runUntil(() => h.host.os!.stats.desyncs >= 2 && h.host.os!.stats.verified >= 2, 30_000)).toBe(true);
    await toFullTime(h);
    expectInSync(h);
    for (const [t, hh] of h.host.hashes) if (t > hostHit + 60 && h.guest.hashes.has(t)) expect(h.guest.hashes.get(t), `tick ${t}`).toBe(hh);
    expect(h.host.os!.status.kind).toBe('finished'); // repaired: never ended as 'desync'
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.host.os!.stats.failedResyncs).toBe(0);
    await h.run(300);
    expect(h.host.os!.stats.finalCheck).toBe('ok'); // repaired long before the final whistle
    expect(h.guest.os!.stats.finalCheck).toBe('ok');
  }, 120_000);

  it('glitch: desync — a resync that waits on a friend held by a system pause is not a failed resync (no false "out of step" end)', async () => {
    const h = createOnlinePair({ config: { halfMinutes: 0.3 } });
    await h.startMatch();
    await h.run(1000);
    let hit = -1;
    let blocked = false;
    h.guest.onTick = (s) => {
      if (hit < 0 && s.tick >= 400) {
        hit = s.tick;
        s.players[2]!.x -= 0.8;
      }
      if (!blocked && hit >= 0 && h.guest.os!.provider.lockstep!.guard.resyncing) {
        blocked = true;
        h.guest.session.setBlocked(true); // the friend turns the iPad to portrait while the snapshot is on its way
      }
    };
    expect(await h.runUntil(() => blocked, 10_000)).toBe(true);
    await h.run(18_000); // longer than the old 15 s resync timeout, shorter than the 20 s unresponsive window
    // was: the host counted the wait as a failed resync and ended the match ('desync') for both
    expect(h.host.os!.status.kind).not.toBe('ended');
    expect(h.guest.os!.status.kind).not.toBe('ended');
    h.guest.session.setBlocked(false);
    expect(h.guest.session.resume(1)).toBe(true);
    expect(await h.runUntil(() => h.host.os!.stats.verified > 0, 10_000)).toBe(true);
    expect(h.guest.os!.stats.resyncs).toBe(1);
    await toFullTime(h);
    expectInSync(h);
    expect(h.host.os!.status.kind).toBe('finished');
  }, 120_000);

  it('glitch: desync — a divergence after the last 30-tick hash (the final whistle) is caught at full time and reported on both sides', async () => {
    // [QF-15] Since T_RULES.fullTimeMinTicks (90) the whistle phase lasts >= 90 ticks, so the first FULL_TIME tick (this
    // test's old nudge point) is no longer after the last periodic hash: three hash ticks follow it, the host's snapshot
    // repairs it and 'ok' is the right verdict (checked below). The nudge now goes to the first tick after the last
    // hash the exchange computes before POST_MATCH, found by a dry run of the same deterministic pair.
    const post = await finalWhistleTick();
    const last = lastHashedTick(post);
    const at = last + 1;
    expect(at).toBeLessThanOrEqual(post);
    const h = createOnlinePair();
    await h.startMatch();
    let hit = -1;
    h.guest.onTick = (s) => {
      if (hit < 0 && s.tick === at) {
        expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
        hit = s.tick;
        s.players[7]!.x += 0.4; // diverges during the full-time whistle, after the last state-hash exchange
      }
    };
    await toFullTime(h);
    await h.run(500);
    expect(hit).toBe(at);
    expect(h.host.state!.tick).toBe(post);
    expect(hashState(h.host.state!)).not.toBe(hashState(h.guest.state!)); // the 30-tick exchange never saw it
    // was: nothing noticed it (no hash exchange after the final tick): two different final states, no report
    expect(h.host.os!.stats.finalCheck).toBe('mismatch');
    expect(h.guest.os!.stats.finalCheck).toBe('mismatch');
    expect(h.host.logs.some((l) => l.includes('desync at full time'))).toBe(true);
    expect(h.guest.logs.some((l) => l.includes('desync at full time'))).toBe(true);
    expect(h.host.notices.some((n) => n.includes('did not agree at the final whistle'))).toBe(true);
    expect(h.guest.notices.some((n) => n.includes('did not agree at the final whistle'))).toBe(true);
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.host.lobby.phase).toBe('lobby'); // ended cleanly: the room stays open for a rematch
    expect(h.guest.lobby.phase).toBe('lobby');

    // The old nudge point (the first FULL_TIME tick) is now inside the repair window: caught, resynced, verdict 'ok'.
    const r = createOnlinePair();
    await r.startMatch();
    let early = -1;
    r.guest.onTick = (s) => {
      if (early < 0 && s.match.phase === MatchPhase.FULL_TIME) {
        early = s.tick;
        s.players[7]!.x += 0.4;
      }
    };
    await toFullTime(r);
    await r.run(500);
    expect(early).toBeGreaterThan(0);
    expect(post - early).toBeGreaterThanOrEqual(90);
    expect(r.guest.os!.stats.resyncs).toBe(1);
    expectInSync(r);
    expect(r.host.os!.stats.finalCheck).toBe('ok');
    expect(r.guest.os!.stats.finalCheck).toBe('ok');
  }, 120_000);

  it('glitch: rematch starting with stale state — late packets, hashes and a whole snapshot of match 1 never reach match 2', async () => {
    const h = createOnlinePair({ hashEvery: 60 });
    await h.startMatch();
    await h.run(800);
    h.guest.session.pause(1);
    await h.run(300);
    h.guest.session.resume(1);
    h.guest.onTick = (s) => {
      if (s.tick === 700) s.players[3]!.z += 0.6; // match 1 has a resync incident (epochs, reports)
    };
    await toFullTime(h);
    expectInSync(h);
    h.guest.onTick = null;
    expect(h.guest.os!.provider.lockstep!.guard.stats.epoch).toBeGreaterThan(0);
    const old: SimState = cloneState(h.host.state!);
    const oldTick = old.tick;
    const firstSeed = h.host.session.getSetup()!.config.seed;
    const oldHost = h.host.os!;
    await h.rematch();
    const os = h.host.os!;
    const gs = h.guest.os!;
    expect(os).not.toBe(oldHost);
    expect(h.host.session.getSetup()!.config.seed).not.toBe(firstSeed);
    expect(h.guest.session.getSetup()!.config.seed).toBe(h.host.session.getSetup()!.config.seed);
    expect(os.pausesLeftOf).toEqual([3, 3]);
    expect(gs.pausesLeftOf).toEqual([3, 3]);
    expect(gs.provider.lockstep!.guard.stats.epoch).toBe(0);
    expect(gs.stats.desyncs + gs.stats.resyncs + gs.stats.failedResyncs + gs.stats.rejoins).toBe(0);
    // Late traffic of match 1 (tag m1) arrives now: an input packet, a hash and the full final snapshot.
    const data = new Int16Array(FRAME_INTS);
    data[0] = 99;
    h.room.pair.host.sendInputs({ firstTick: oldTick - 3, count: 1, ack: oldTick, tick: oldTick, adv: 0, data });
    h.room.pair.host.sendReliable({ type: 'ls:hash', tick: 120, h: 1, e: 9, z: 0, mt: 'm1' });
    const snap = encodeSnapshotSync(old);
    snap.chunks.forEach((c, i) => {
      h.room.pair.host.sendReliable({ type: 'ls:snap', e: 9, tick: oldTick, i, n: snap.chunks.length, codec: 'json', seed: old.config.seed, data: c, mt: 'm1' });
    });
    await h.run(1500);
    expect(h.guest.state!.tick).toBeLessThan(400); // never jumped to the old final state
    expect(gs.provider.lockstep!.guard.stats.epoch).toBe(0);
    expect(gs.provider.lockstep!.stats.remoteAck).toBeLessThan(400);
    expect(h.guest.state!.config.seed).toBe(h.host.session.getSetup()!.config.seed);
    await toFullTime(h);
    expectInSync(h);
    expect(os.stats.desyncs + gs.stats.desyncs).toBe(0);
  }, 150_000);
});

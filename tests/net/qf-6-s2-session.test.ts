/**
 * [QF-6, second pass] Online session defects the first pass did not reach (two real app sessions on the in-memory link,
 * virtual time; tests/net/net-06-harness):
 *  - a guest that reloaded and rejoins loads the match again: the host must give it the start window (startWaitMs),
 *    not the 20 s mid-match window, before it offers Finish against CPU;
 *  - a snapshot lost with a dropped link is sent again after the rejoin (no false 'desync' end);
 *  - a rejoin request that arrives before the host has loaded is answered once it has;
 *  - a friend who comes back and pauses at once lifts the "not responding" verdict;
 *  - both players pausing at once: the guest's losing pause is withdrawn on the host too, and refunded on the guest
 *    even when it was over before the host's pause arrived;
 *  - after the friend left on purpose, this side stops re-dialling the closed room.
 */
import { describe, expect, it } from 'vitest';
import { T_NET } from '../../src/contracts/tuning';
import { createOnlinePair, hashState } from './net-06-harness';

type Pair = ReturnType<typeof createOnlinePair>;

async function toFullTime(h: Pair): Promise<void> {
  const ok = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000);
  expect(ok).toBe(true);
}

function expectInSync(h: Pair): void {
  expect(h.host.state!.tick).toBe(h.guest.state!.tick);
  expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
}

describe('QF-6 second pass: rejoin after a reload', () => {
  it('glitch: both sides waiting forever — a reloaded guest loading the match again is not declared unresponsive after 20 s', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(3000);
    const fresh = h.reloadGuest();
    fresh.lobby.onStart(() => {
      fresh.alive = false; // the reloaded page is busy loading the match (assets, shader warm-up) for a long while
    });
    expect(await h.runUntil(() => !!fresh.os, 15_000)).toBe(true);
    await h.run(T_NET.rejoinWaitMs + 8000);
    // was: 'opponent-gone' ("Ben is not responding", Finish against CPU offered) 20 s into the friend's load
    expect(h.host.os!.status.kind).toBe('stalled');
    expect(h.host.notices).not.toContain('Ben is not responding');
    fresh.alive = true; // loaded
    await h.run(2000);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(fresh.os!.status.kind).toBe('playing');
    await toFullTime(h);
    expectInSync(h);
  }, 120_000);

  it('a reloaded guest that never finishes loading still ends in "not responding" after the start window', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(3000);
    const fresh = h.reloadGuest();
    fresh.lobby.onStart(() => {
      fresh.alive = false; // hangs for good
    });
    expect(await h.runUntil(() => !!fresh.os, 15_000)).toBe(true);
    await h.run(47_000);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('unresponsive');
  }, 120_000);
});

describe('QF-6 second pass: resync across a dropped link', () => {
  it('glitch: desync — a snapshot lost with a dropped link is sent again after the rejoin (no false "out of step" end)', async () => {
    const h = createOnlinePair({ config: { halfMinutes: 0.4 } });
    await h.startMatch();
    await h.run(1000);
    let hit = -1;
    let cut = false;
    h.guest.onTick = (s) => {
      if (hit < 0 && s.tick >= 400) {
        hit = s.tick;
        s.players[6]!.x += 0.7; // the guest drifts once
      }
    };
    h.host.onTick = () => {
      if (!cut && hit >= 0 && h.host.os!.provider.lockstep!.guard.resyncing) {
        cut = true;
        h.room.pair.sever(); // the link drops just as the host sends its snapshot: it is lost with the link
      }
    };
    expect(await h.runUntil(() => cut, 10_000)).toBe(true);
    expect(await h.runUntil(() => h.host.os!.status.kind === 'playing' && h.guest.os!.status.kind === 'playing', 10_000)).toBe(true);
    // was: the host waited for an answer to the lost snapshot for good (one snapshot in flight at a time), the guest
    // kept its diverged state, and 900 ticks later the match ended as 'desync' for both
    expect(await h.runUntil(() => h.host.os!.stats.verified > 0, 15_000)).toBe(true);
    expect(h.guest.os!.stats.resyncs).toBeGreaterThan(0);
    await toFullTime(h);
    expectInSync(h);
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.guest.os!.status.kind).toBe('finished');
  }, 120_000);
});

describe('QF-6 second pass: rejoin request before the host has loaded', () => {
  it('glitch: both sides waiting forever — a reloaded guest that asks to rejoin while the host is still loading gets its start once the host has loaded', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(2000);
    const sess = h.host.ctx.session as unknown as { getState: () => unknown };
    const real = sess.getState;
    sess.getState = () => null; // the host's match is not loaded yet (no state to snapshot)
    const fresh = h.reloadGuest();
    await h.run(1500); // the new page has dialled and said hello with its token
    sess.getState = real; // the host finishes loading
    // was: the request was dropped; the new page waited for a start that never came and failed after 10 s
    expect(await h.runUntil(() => !!fresh.os && fresh.session.loaded, 8_000)).toBe(true);
    await h.run(1500);
    expect(fresh.lobby.phase).toBe('playing');
    expect(h.host.os!.stats.rejoins).toBe(1);
    expect(h.host.os!.status.kind).toBe('playing');
    await toFullTime(h);
    expectInSync(h);
  }, 120_000);
});

describe('QF-6 second pass: an unresponsive friend who pauses on return', () => {
  it('glitch: both sides waiting forever — the friend comes back and pauses at once: the "not responding" card gives way to the friend\'s pause', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(1500);
    h.guest.session.setBlocked(true); // portrait lock on the friend's iPad
    await h.run(T_NET.rejoinWaitMs + 2000);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('unresponsive');
    // Back in landscape, the friend resumes and pauses straight away (to fetch a drink) before play moves on.
    h.guest.session.setBlocked(false);
    expect(h.guest.session.resume(1)).toBe(true);
    h.guest.session.pause(1);
    await h.run(800);
    expect(h.host.session.pausedBy).toBe(1);
    // was: still "Ben is not responding" with Finish against CPU / End match while Ben's pause ran
    expect(h.host.os!.status.kind).toBe('paused');
    expect(h.host.os!.status.reason).toBeNull();
    expect(h.guest.session.resume(1)).toBe(true);
    await h.run(1500);
    expect(h.host.os!.status.kind).toBe('playing');
    await toFullTime(h);
    expectInSync(h);
  }, 120_000);
});

describe('QF-6 second pass: both players pausing at once', () => {
  it('glitch: both players pausing at once — the guest\'s pause loses the tie and is withdrawn on the host too, even when the host\'s own pause was already over', async () => {
    const h = createOnlinePair({ link: { latencyMs: 150, jitterMs: 0 } });
    await h.startMatch();
    await h.run(3000);
    h.host.session.pause(0);
    await h.run(130);
    h.guest.session.pause(1); // the host's pause is still on its way to the guest
    await h.run(130);
    expect(h.guest.session.pausedBy).toBe(0); // the tie on the guest: the host's pause wins, the guest's is refunded
    h.host.session.resume(0); // a short pause: over before the guest's pause reaches the host
    await h.run(1200);
    // was: the host applied the guest's (withdrawn) pause and sat in it while the guest played on; 20 s later the guest
    // read "Ana is not responding", and the two sides disagreed on the guest's pauses left
    expect(h.host.session.paused).toBe(false);
    expect(h.guest.session.paused).toBe(false);
    expect(h.host.os!.pausesLeftOf).toEqual([2, 3]);
    expect(h.guest.os!.pausesLeftOf).toEqual([2, 3]);
    await h.run(3000);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(h.guest.os!.status.kind).toBe('playing');
    // The ordinary tie (the host still paused when the guest's pause arrives) is unchanged.
    h.host.session.pause(0);
    await h.run(50);
    h.guest.session.pause(1);
    await h.run(1000);
    expect(h.host.session.pausedBy).toBe(0);
    expect(h.guest.session.pausedBy).toBe(0);
    expect(h.host.os!.pausesLeftOf).toEqual([1, 3]);
    expect(h.guest.os!.pausesLeftOf).toEqual([1, 3]);
    h.host.session.resume(0);
    await h.run(1000);
    expect(h.guest.session.paused).toBe(false);
    await toFullTime(h);
    expectInSync(h);
  }, 120_000);
});

describe('QF-6 second pass: after the friend left on purpose', () => {
  it('a friend who finished against the CPU closes the room: this side does not keep re-dialling it while the player chooses', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(1500);
    h.guest.session.setBlocked(true);
    await h.run(T_NET.rejoinWaitMs + 2000);
    expect(h.host.os!.status.reason).toBe('unresponsive');
    const t = h.room.pair.guest;
    const real = t.reconnect.bind(t);
    let dials = 0;
    (t as { reconnect: () => Promise<void> }).reconnect = () => {
      dials++;
      return real();
    };
    expect(h.host.os!.finishAgainstCpu()).toBe(true); // 'session:quit', then the host's room closes
    await h.run(10_000);
    expect(h.guest.os!.status.kind).toBe('opponent-gone');
    expect(h.guest.os!.status.reason).toBe('quit');
    // was: a re-dial every 1.5 s into the closed room (a broker request each time) until Ben picked an option
    expect(dials).toBe(0);
    expect(h.guest.os!.finishAgainstCpu()).toBe(true); // the choice still works
    h.guest.session.setBlocked(false);
    h.guest.session.resume(1);
    expect(await h.runUntil(() => h.guest.session.finished, 120_000)).toBe(true);
  }, 150_000);
});

describe('QF-6 second pass: both players pausing at once (the guest\'s pause already over)', () => {
  it('glitch: both players pausing at once — a guest pause the host ignored is refunded on the guest even when it ended before the host\'s pause arrived', async () => {
    const h = createOnlinePair({ link: { latencyMs: 150, jitterMs: 0 } });
    await h.startMatch();
    await h.run(3000);
    h.guest.session.pause(1);
    await h.run(133);
    h.host.session.pause(0); // the guest's pause reaches the host after this: the host's pause wins, the guest's is void
    await h.run(133);
    h.guest.session.resume(1); // the guest's pause is over before the host's pause reaches it
    await h.run(1000);
    expect(h.host.session.pausedBy).toBe(0);
    expect(h.guest.session.pausedBy).toBe(0);
    // was: the guest still counted its void pause ([2, 2] here, [2, 3] on the host): one pause fewer for the guest
    expect(h.host.os!.pausesLeftOf).toEqual([2, 3]);
    expect(h.guest.os!.pausesLeftOf).toEqual([2, 3]);
    h.host.session.resume(0);
    await h.run(1000);
    expect(h.guest.session.paused).toBe(false);
    // A later, ordinary guest pause counts as usual on both sides.
    h.guest.session.pause(1);
    await h.run(500);
    expect(h.host.session.pausedBy).toBe(1);
    expect(h.host.os!.pausesLeftOf).toEqual([2, 2]);
    expect(h.guest.os!.pausesLeftOf).toEqual([2, 2]);
    h.guest.session.resume(1);
    await toFullTime(h);
    expectInSync(h);
  }, 120_000);
});

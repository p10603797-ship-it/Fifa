/**
 * [QF-6, second pass] Reliable lockstep messages lost with a dropped link (a rejoin on the same pages opens new data
 * channels; whatever was queued on the old ones is gone):
 *  - a delay switch announced just before the drop is announced again, so both sides keep the same input delay;
 *  - the guest reports its target again (the host's view of it may be stale);
 *  - a snapshot in flight is sent again (unit level; the app-session case is in qf-6-s2-session);
 *  - a mismatch only the guest saw (its hash died with the link) stops waiting once later ticks agree;
 *  - a stall that spans a pause counts only the time spent waiting (no waiting pill at once after a pause).
 */
import { describe, expect, it } from 'vitest';
import { createAdaptiveDelay, createDelaySync, CTRL_DELAY, CTRL_TARGET } from '../../src/net/adaptive';
import { createDesyncGuard, CTRL_SNAP, CTRL_SNAP_OK } from '../../src/net/desync';
import type { ControlMessage } from '../../src/net/types';
import { initMatch } from '../../src/sim/init';
import { createMatchConfig } from '../../src/contracts/state';

describe('QF-6 second pass: delay agreement across a dropped link', () => {
  it('a delay switch lost with the link is announced again after the rejoin and both sides switch together', () => {
    const toGuest: ControlMessage[] = [];
    const toHost: ControlMessage[] = [];
    const ha = createAdaptiveDelay();
    const ga = createAdaptiveDelay();
    const host = createDelaySync({ isHost: true, adaptive: ha, send: (m) => toGuest.push(m) });
    const guest = createDelaySync({ isHost: false, adaptive: ga, send: (m) => toHost.push(m) });
    for (let i = 0; i < 4; i++) ha.sample(260); // the link got worse: the host raises the delay
    host.update(1000);
    expect(toGuest.filter((m) => m.type === CTRL_DELAY)).toHaveLength(1);
    toGuest.length = 0; // ... and the announcement dies with the link
    host.linkRestored();
    guest.linkRestored();
    host.update(1010);
    guest.update(1010);
    // was: never sent again; the guest kept delay 3 while the host played at 8
    const again = toGuest.filter((m) => m.type === CTRL_DELAY);
    expect(again).toHaveLength(1);
    for (const m of toGuest.splice(0)) guest.handle(m);
    expect(ga.switches).toEqual(ha.switches);
    const at = ha.switches[ha.switches.length - 1]!.atTick;
    expect(ga.delayFor(at)).toBe(ha.delayFor(at));
    expect(toHost).toContainEqual({ type: CTRL_TARGET, target: ga.target }); // the guest's target is reported again
    // A re-announcement of a switch the guest already has changes nothing (no duplicate switch, no "late" count).
    host.linkRestored();
    host.update(1020);
    for (const m of toGuest.splice(0)) guest.handle(m);
    expect(ga.switches).toEqual(ha.switches);
    expect(guest.late).toBe(0);
  });

  it('a re-announced switch whose tick has passed on the guest is not applied twice', () => {
    const ga = createAdaptiveDelay();
    const guest = createDelaySync({ isHost: false, adaptive: ga, send: () => {} });
    guest.update(100);
    guest.handle({ type: CTRL_DELAY, delay: 6, at: 150 });
    guest.update(400);
    ga.delayFor(400);
    guest.handle({ type: CTRL_DELAY, delay: 6, at: 150, re: 1 });
    expect(ga.switches).toEqual([{ delay: 6, atTick: 150 }]);
    expect(guest.late).toBe(0);
    // A lost one whose tick passed applies on the next tick, like any late announcement.
    guest.handle({ type: CTRL_DELAY, delay: 8, at: 380, re: 1 });
    expect(ga.switches[ga.switches.length - 1]).toEqual({ delay: 8, atTick: 401 });
  });
});

describe('QF-6 second pass: snapshot lost with the link (guard)', () => {
  it('glitch: desync — the host sends a fresh snapshot when the link comes back with one unacknowledged', () => {
    const toGuest: ControlMessage[] = [];
    const hostGuard = createDesyncGuard({ isHost: true, send: (m) => toGuest.push(m), compress: 'none' });
    const c = createMatchConfig();
    c.seed = 5;
    const s = initMatch(c);
    s.tick = 30;
    hostGuard.afterTick(s);
    hostGuard.remoteHash(30, 12345, 0); // the guest disagrees
    s.tick = 31;
    hostGuard.afterTick(s); // snapshot of tick 31 goes out...
    expect(toGuest.filter((m) => m.type === CTRL_SNAP).length).toBeGreaterThan(0);
    toGuest.length = 0; // ... and is lost with the link
    s.tick = 32;
    hostGuard.afterTick(s);
    expect(toGuest.filter((m) => m.type === CTRL_SNAP)).toHaveLength(0); // one in flight at a time
    hostGuard.linkRestored();
    s.tick = 33;
    hostGuard.afterTick(s);
    // was: nothing, for good (the session ended the match as 'desync' 900 ticks later)
    const snaps = toGuest.filter((m) => m.type === CTRL_SNAP);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[0]!.tick).toBe(33);
    expect(snaps[0]!.e).toBe(2);
    // The answer to the fresh snapshot completes the resync; one to the lost one would be ignored.
    expect(hostGuard.handle({ type: CTRL_SNAP_OK, e: 1, tick: 31, ok: 1 })).toBe(true);
    expect(hostGuard.resyncing).toBe(true);
    hostGuard.handle({ type: CTRL_SNAP_OK, e: 2, tick: 33, ok: 1 });
    expect(hostGuard.resyncing).toBe(false);
    expect(hostGuard.resyncs).toBe(1);
  });

  it('a guest drops partial snapshot chunks when the link comes back (the rest never arrives)', async () => {
    const toGuest: ControlMessage[] = [];
    const toHost: ControlMessage[] = [];
    const hostGuard = createDesyncGuard({ isHost: true, send: (m) => toGuest.push(m), compress: 'none' });
    const guestGuard = createDesyncGuard({ isHost: false, send: (m) => toHost.push(m), compress: 'none' });
    const c = createMatchConfig();
    c.seed = 9;
    const hs = initMatch(c);
    const gs = initMatch(c);
    gs.players[3]!.x += 1;
    hs.tick = gs.tick = 30;
    hostGuard.afterTick(hs);
    guestGuard.afterTick(gs);
    for (const m of toHost.splice(0)) hostGuard.handle(m);
    for (const m of toGuest.splice(0)) guestGuard.handle(m);
    hs.tick = 31;
    hostGuard.afterTick(hs);
    const first = toGuest.splice(0).filter((m) => m.type === CTRL_SNAP);
    expect(first.length).toBeGreaterThan(1);
    guestGuard.handle(first[0]!); // only the first chunk made it
    guestGuard.linkRestored();
    hostGuard.linkRestored();
    hs.tick = 32;
    hostGuard.afterTick(hs);
    for (const m of toGuest.splice(0)) guestGuard.handle(m);
    gs.tick = 32;
    expect(guestGuard.applyPending(gs)).toBe(true);
    expect(gs.tick).toBe(32);
    expect(gs.players[3]!.x).toBe(hs.players[3]!.x);
  });
});

describe('QF-6 second pass: a mismatch only the guest saw', () => {
  it('glitch: desync — a guest whose mismatching hash never reached the host stops waiting once later ticks agree (no false "out of step" end)', () => {
    const toHost: ControlMessage[] = [];
    const guestGuard = createDesyncGuard({ isHost: false, send: (m) => toHost.push(m), compress: 'none' });
    const c = createMatchConfig();
    c.seed = 3;
    const gs = initMatch(c);
    gs.tick = 30;
    guestGuard.afterTick(gs); // its hash for tick 30 dies with a dropped link: the host never compares tick 30
    expect(guestGuard.remoteHash(30, 0xdead, 0)).toBe(true); // ... but the host's hash for 30 reached the guest
    expect(guestGuard.resyncing).toBe(true);
    gs.tick = 60;
    const h60 = guestGuard.afterTick(gs);
    guestGuard.remoteHash(60, h60, 0); // tick 60 agrees: the divergence (a transient value) is gone
    // was: still waiting for a snapshot the host never meant to send; the session ended the match 900 ticks later
    expect(guestGuard.resyncing).toBe(false);
    expect(guestGuard.desyncs).toBe(1);
    // A real, lasting divergence keeps it waiting.
    gs.tick = 90;
    guestGuard.afterTick(gs);
    expect(guestGuard.remoteHash(90, 0xbeef, 0)).toBe(true);
    gs.tick = 120;
    guestGuard.afterTick(gs);
    guestGuard.remoteHash(120, 0xf00d, 0);
    expect(guestGuard.resyncing).toBe(true);
  });
});

describe('QF-6 second pass: stall timer across a pause', () => {
  it('a stall that spans a pause counts only the time spent waiting: no waiting pill at once after the pause', async () => {
    const { createLockstepProvider } = await import('../../src/net/lockstep');
    const { createManualClock, createMemoryTransportPair } = await import('../../src/net/memoryTransport');
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 20, now: clock.now, schedule: clock.schedule });
    const opened = Promise.all([pair.host.open('host', 'ABCDEF'), pair.guest.open('guest', 'ABCDEF')]);
    clock.advance(100);
    await opened;
    const host = createLockstepProvider({ transport: pair.host, localHuman: 0, localSources: [], delay: 3, timeSync: false });
    // The guest never sends: the host stalls at its first tick past the neutral frames it has from nobody.
    let now = 1000;
    host.pump(now);
    expect(host.ready(1)).toBe(false);
    now += 100;
    host.pump(now);
    expect(host.ready(1)).toBe(false);
    expect(host.waitingMs).toBeCloseTo(100, 0);
    // A 10 s pause: the app keeps pumping but never asks to tick.
    for (let i = 0; i < 600; i++) {
      now += 1000 / 60;
      host.pump(now);
    }
    expect(host.ready(1)).toBe(false); // first frame after the pause
    // was: ~10 100 ms (the pill showed "Waiting for Ben" at once and maxStallMs counted the pause)
    expect(host.waitingMs).toBeLessThan(200);
    expect(host.stats.maxStallMs).toBeLessThan(200);
    host.dispose();
    pair.host.close();
    pair.guest.close();
  });
});

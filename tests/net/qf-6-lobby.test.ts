/**
 * [QF-6] Lobby / rematch defects (in-memory link, manual clock):
 *  - a friend who finished first and readied up for the rematch while this side was still playing its last ticks
 *    looked "not ready" here for good (its state was dropped during 'playing'): the rematch never started;
 *  - after full time the host's lobby that lost the link says hello again; a guest still finishing its last ticks must
 *    answer, or the host drops back to an error after the hello timeout;
 *  - each side announces its match warm-up to the transport (expectBusy) and ends the grace once loaded.
 */
import { describe, expect, it } from 'vitest';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLobby, LOBBY_HELLO_TIMEOUT_MS } from '../../src/net/lobby';
import { createManualClock, createMemoryTransportPair } from '../../src/net/memoryTransport';
import { createOnlinePair } from './net-06-harness';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const clock = createManualClock();
  const pair = createMemoryTransportPair({ latencyMs: 20, seed: 3, now: clock.now, schedule: clock.schedule });
  const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const host = createLobby({ host: true, code: 'ABCDEF', nickname: 'Ana', transport: pair.host, timers, random: seeded(11), clubs: CLUBS });
  const guest = createLobby({ host: false, code: 'ABCDEF', nickname: 'Ben', transport: pair.guest, timers, clubs: CLUBS });
  const run = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 5) {
      clock.advance(5);
      await flush();
    }
  };
  return { clock, pair, host, guest, run };
}

async function firstMatch(h: ReturnType<typeof setup>): Promise<void> {
  await h.run(200);
  h.host.setConfig(createMatchConfig());
  h.host.setClub(2);
  h.guest.setClub(5);
  await h.run(100);
  h.guest.setReady(true);
  h.host.setReady(true);
  await h.run(1300);
  expect(h.host.phase).toBe('playing');
  expect(h.guest.phase).toBe('playing');
}

describe('QF-6 lobby: rematch handshakes', () => {
  it('glitch: both sides waiting forever — the guest readied for the rematch while the host was still finishing: the host sees it ready and the rematch starts', async () => {
    const h = setup();
    await firstMatch(h);
    h.guest.matchEnded(); // the guest reached full time first ...
    h.guest.setClub(7);
    h.guest.setReady(true); // ... and is ready for the rematch at once
    await h.run(200);
    expect(h.host.phase).toBe('playing'); // the host still plays its last ticks
    h.host.matchEnded();
    // was: peer.ready = false here for good, while the guest's screen said "ready": nobody could start
    expect(h.host.peer?.ready).toBe(true);
    expect(h.host.peer?.club).toBe(7);
    h.host.setReady(true);
    await h.run(1300);
    expect(h.host.started!.n).toBe(2);
    expect(h.guest.started!.n).toBe(2);
    expect(h.guest.started!.config.awayClub).toBe(7);
    expect(h.host.phase).toBe('playing');
  });

  it('a state from before the start (the last match) is never carried into the next lobby', async () => {
    const h = setup();
    await h.run(200);
    h.host.setConfig(createMatchConfig());
    h.host.setClub(2);
    h.guest.setClub(5);
    await h.run(100);
    h.guest.setReady(true);
    h.host.setReady(true);
    await h.run(1300);
    // A late copy of the guest's pre-match state (n = 0) arrives during the match: ignored.
    h.pair.guest.sendReliable({ type: 'lobby:state', club: 5, ready: true, n: 0 });
    await h.run(100);
    h.host.matchEnded();
    expect(h.host.peer?.ready).toBe(false);
  });

  it('glitch: both sides waiting forever — after full time the host\'s lobby says hello again; a guest still finishing answers', async () => {
    const h = setup();
    await firstMatch(h);
    h.host.matchEnded(); // host at full time, back in the room
    expect(h.host.phase).toBe('lobby');
    h.pair.sever(); // the link drops while the guest plays its last ticks
    await h.run(100);
    expect(h.host.phase).toBe('waiting');
    expect(h.guest.phase).toBe('playing'); // the session owns disconnects during a match
    const back = h.pair.guest.reconnect(); // the guest's session re-dials
    await h.run(300);
    await back;
    await h.run(300);
    // was: the guest ignored the hello while 'playing' -> the host failed with 'disconnected' after the hello timeout
    expect(h.host.phase).toBe('lobby');
    expect(h.host.peer?.nickname).toBe('Ben');
    h.guest.matchEnded();
    await h.run(LOBBY_HELLO_TIMEOUT_MS + 500);
    expect(h.host.phase).toBe('lobby');
    expect(h.guest.phase).toBe('lobby');
    expect(h.host.error).toBeNull();
    h.guest.setReady(true);
    h.host.setReady(true);
    await h.run(1300);
    expect(h.host.started!.n).toBe(2);
  });
});

describe('QF-6 session: warm-up grace', () => {
  it('announces the warm-up to the transport before loading and ends it once the match runs', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(500);
    expect(h.room.busy[0]).toBeGreaterThanOrEqual(20_000);
    expect(h.room.busy.slice(1)).toEqual([0]);
  }, 60_000);
});

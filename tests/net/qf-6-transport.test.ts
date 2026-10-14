/**
 * [QF-6] Transport defects found in the rejoin and silence paths (PeerJS transport over the fake broker, manual clock):
 *  - the rejoin race: a guest that re-dials before the host noticed the drop must get a fresh link, not a dead end;
 *  - every failure of a guest's reconnect() attempt stays retryable (a '$full', an ICE failure, ...);
 *  - a reloaded guest (new peer id) replaces the host's silent stale link instead of being told the room is full;
 *  - a long warm-up announced with expectBusy() is not mistaken for a disconnect (both sides wait).
 */
import { describe, expect, it } from 'vitest';
import { FRAME_INTS } from '../../src/net/packet';
import type { NetTransport } from '../../src/net/types';
import { collect, fakeSetup, type FakePeer } from './qf-6-fakepeer';

async function openBoth(env: ReturnType<typeof fakeSetup>): Promise<{ host: NetTransport; guest: NetTransport }> {
  const host = env.make();
  const guest = env.make();
  void host.open('host', 'ABCDEF').catch(() => undefined);
  await env.run(20);
  const gp = guest.open('guest', 'ABCDEF');
  await env.run(100);
  await gp;
  expect(host.state).toBe('open');
  expect(guest.state).toBe('open');
  return { host, guest };
}

const pkt = (tick: number) => ({ firstTick: tick, count: 1, ack: -1, tick, adv: 0, data: new Int16Array(FRAME_INTS).fill(tick) });

async function expectTalking(env: ReturnType<typeof fakeSetup>, host: NetTransport, guest: NetTransport, n: number): Promise<void> {
  const hc = collect(host);
  const gc = collect(guest);
  host.sendReliable({ type: 'session:sync', n });
  guest.sendReliable({ type: 'session:sync', n: n + 1 });
  guest.sendInputs(pkt(n));
  await env.run(40);
  expect(gc.control).toContainEqual({ type: 'session:sync', n });
  expect(hc.control).toContainEqual({ type: 'session:sync', n: n + 1 });
  expect(hc.inputs.map((p) => p.firstTick)).toContain(n);
}

describe('QF-6 transport: rejoins and silence', () => {
  it('glitch: both sides waiting forever — rejoin race: the guest re-dials before the host noticed the drop and gets a fresh link', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const hc = collect(host);
    const gc = collect(guest);
    const guestPeer = env.broker.created[1] as FakePeer;
    // Only the guest's end dies (Wi-Fi switch); the host still believes in the old link.
    guestPeer.dieLocally();
    await env.run(10);
    expect(guest.state).toBe('closed');
    expect(host.state).toBe('open');
    const back = guest.reconnect();
    await env.run(200);
    await back; // was: the host bolted the new channels onto the old link, no handshake -> 'version-mismatch', for good
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    expect(hc.events.map((e) => e.type).filter((t) => t !== 'rtt')).toEqual(['disconnected', 'connected']);
    expect(gc.events.some((e) => e.type === 'error')).toBe(false);
    await env.run(1500); // the old link's late close must not take the new one down; pings keep it alive
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    await expectTalking(env, host, guest, 40);
    host.close();
    guest.close();
  });

  it('glitch: both sides waiting forever — a reconnect answered with $full stays retryable and succeeds once the seat is free', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const guestPeer = env.broker.created[1] as FakePeer;
    for (const c of guestPeer.liveConns()) c.close(); // a clean drop: both sides see it
    await env.run(30);
    expect(host.state).toBe('connecting');
    void host.reconnect();
    const stranger = env.make();
    const sp = stranger.open('guest', 'ABCDEF'); // someone else with the code takes the seat meanwhile
    await env.run(100);
    await sp;
    const first = guest.reconnect();
    const check = expect(first).rejects.toThrow('room-full');
    await env.run(100);
    await check;
    expect(guest.state).toBe('closed'); // was 'failed': every later reconnect() rejected at once
    stranger.close(); // the session refused the stranger; it leaves
    await env.run(50);
    const second = guest.reconnect();
    await env.run(150);
    await second;
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    await expectTalking(env, host, guest, 7);
    host.close();
    guest.close();
  });

  it('glitch: both sides waiting forever — an ICE failure during a reconnect attempt is retryable', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    for (const c of (env.broker.created[1] as FakePeer).liveConns()) c.close();
    await env.run(30);
    void host.reconnect();
    env.broker.iceBlocked = true;
    const first = guest.reconnect();
    const check = expect(first).rejects.toThrow('blocked');
    await env.run(2200);
    await check;
    expect(guest.state).toBe('closed');
    env.broker.iceBlocked = false;
    const second = guest.reconnect();
    await env.run(150);
    await second;
    expect(guest.state).toBe('open');
    await env.run(2500); // timers of the failed attempt never fire into the new link
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    host.close();
    guest.close();
  });

  it('a reloaded guest (new peer id) replaces the host\'s silent stale link instead of getting room-full', async () => {
    const env = fakeSetup();
    const { host } = await openBoth(env);
    const hc = collect(host);
    (env.broker.created[1] as FakePeer).goSilent(); // the old page unloads without closing its channels
    await env.run(500); // > replaceSilentMs (400), < silenceTimeoutMs (1000): the host has not noticed yet
    expect(host.state).toBe('open');
    const fresh = env.make();
    const fp = fresh.open('guest', 'ABCDEF');
    await env.run(150);
    await fp; // was: '$full' -> room-full
    expect(fresh.state).toBe('open');
    expect(host.state).toBe('open');
    expect(hc.events.map((e) => e.type).filter((t) => t !== 'rtt')).toEqual(['disconnected', 'connected']);
    await expectTalking(env, host, fresh, 3);
    // A third device while the (new) guest is talking still gets room-full.
    const third = env.make();
    const tp = third.open('guest', 'ABCDEF');
    const check = expect(tp).rejects.toThrow('room-full');
    await env.run(150);
    await check;
    expect(fresh.state).toBe('open');
    host.close();
    fresh.close();
  });

  it('glitch: both sides waiting forever — a long warm-up announced with expectBusy is not read as a disconnect', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const hc = collect(host);
    const gc = collect(guest);
    guest.expectBusy!(3000);
    await env.run(20);
    env.broker.dropData = true; // the guest's main thread is blocked: nothing flows either way
    await env.run(2400); // > silenceTimeoutMs (1000)
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
    env.broker.dropData = false;
    guest.expectBusy!(0); // loaded
    await env.run(300);
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(false);
    expect(gc.events.some((e) => e.type === 'disconnected')).toBe(false);
    // Without a grace, silence is still a disconnect.
    env.broker.dropData = true;
    await env.run(1300);
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(true);
    expect(gc.events.some((e) => e.type === 'disconnected')).toBe(true);
    host.close();
    guest.close();
  });

  it('one side done loading never cancels the other side\'s warm-up grace (grace per direction)', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const hc = collect(host);
    const gc = collect(guest);
    host.expectBusy!(3000);
    guest.expectBusy!(3000);
    await env.run(20);
    host.expectBusy!(0); // the host loaded first; the guest is still compiling shaders
    await env.run(20);
    env.broker.dropData = true;
    await env.run(2200);
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(false);
    expect(gc.events.some((e) => e.type === 'disconnected')).toBe(false);
    env.broker.dropData = false;
    guest.expectBusy!(0);
    await env.run(200);
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
    host.close();
    guest.close();
  });

  it('room codes expire with their room: a share link opened after the host left reads code-not-found, a new room reuses nothing', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    host.close(); // the host leaves: its peer id (prefix + code) is released at the broker
    guest.close();
    await env.run(50);
    expect(env.broker.peers.has('dotkick-ABCDEF')).toBe(false);
    const late = env.make();
    const p = late.open('guest', 'ABCDEF');
    const check = expect(p).rejects.toThrow('code-not-found');
    await env.run(100);
    await check;
    expect(late.state).toBe('failed');
    // The same code hosted again later is a different room: the new host gets a fresh guest, not a stale link.
    const host2 = env.make();
    void host2.open('host', 'ABCDEF').catch(() => undefined);
    await env.run(20);
    const g2 = env.make();
    const gp = g2.open('guest', 'ABCDEF');
    await env.run(100);
    await gp;
    expect(host2.state).toBe('open');
    host2.close();
    g2.close();
  });

  it('a grace never outlives MAX_BUSY_MS and is ignored from a closed transport', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const hc = collect(host);
    guest.expectBusy!(10 * 60_000); // clamped to 60 s
    await env.run(20);
    (env.broker.created[1] as FakePeer).goSilent();
    await env.run(1500);
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(false);
    env.clock.advance(60_000);
    await env.run(300);
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(true);
    guest.close();
    guest.expectBusy!(1000); // no throw after close
    host.close();
  });
});

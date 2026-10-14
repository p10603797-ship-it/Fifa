/**
 * [QF-6, second pass] Transport defects in the rejoin paths that the first pass did not reach (PeerJS transport over the
 * fake broker, manual clock):
 *  - a guest page that dies during its match warm-up (iPad Safari kills a tab for memory while textures and shaders
 *    load) leaves the host holding a link in that page's '$busy' grace; the reloaded page must still get the seat
 *    instead of "Room is full";
 *  - a grace announced on an old link never carries over to the next link (a rejoined guest that goes silent is
 *    noticed after the normal silence timeout, not after the dead page's warm-up allowance).
 */
import { describe, expect, it } from 'vitest';
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

describe('QF-6 second pass: transport rejoins', () => {
  it('glitch: both sides waiting forever — a guest page that died during its warm-up grace: the reloaded page gets the seat, not "room full"', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const hc = collect(host);
    guest.expectBusy!(3000); // the match warm-up starts on the guest ('$busy' 3 s)
    await env.run(20);
    (env.broker.created[1] as FakePeer).goSilent(); // ... and the tab is killed mid-load: nothing more from it
    await env.run(600); // > replaceSilentMs (400): the reloaded page is back and dials under a new peer id
    expect(host.state).toBe('open'); // the host still holds the dead link (in its grace)
    const fresh = env.make();
    const fp = fresh.open('guest', 'ABCDEF');
    const outcome = fp.then(() => 'open', (e: unknown) => String((e as Error).message));
    await env.run(200);
    // was: '$full' -> 'room-full' (silence inside the dead page's grace counted as 0 ms), for the whole 3 s grace
    expect(await outcome).toBe('open');
    expect(fresh.state).toBe('open');
    expect(host.state).toBe('open');
    expect(hc.events.map((e) => e.type).filter((t) => t !== 'rtt')).toEqual(['disconnected', 'connected']);
    host.close();
    fresh.close();
  });

  it('a busy grace announced by a dead page does not shield the reloaded page\'s link from the silence timeout', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    guest.expectBusy!(5000);
    await env.run(20);
    (env.broker.created[1] as FakePeer).goSilent(); // killed mid-load
    await env.run(500);
    const fresh = env.make(); // the reloaded page takes the seat
    const fp = fresh.open('guest', 'ABCDEF');
    await env.run(150);
    await fp;
    expect(host.state).toBe('open');
    const hc = collect(host);
    (env.broker.created[2] as FakePeer).goSilent(); // ... and freezes too (no warm-up announced by this page)
    await env.run(1600); // > silenceTimeoutMs (1000), well inside the dead page's 5 s grace
    // was: the dead page's grace still suspended the check: 'open' for 5 s with nobody there
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(true);
    host.close();
    guest.close();
    fresh.close();
  });

  it('our own warm-up grace still running is announced again on a new link (a rejoin during the load)', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    guest.expectBusy!(4000);
    await env.run(20);
    for (const c of (env.broker.created[1] as FakePeer).liveConns()) c.close(); // a clean drop during the warm-up
    await env.run(30);
    void host.reconnect();
    const back = guest.reconnect();
    await env.run(150);
    await back;
    const hc = collect(host);
    env.broker.dropData = true; // the guest's main thread blocks for the rest of its load
    await env.run(2000); // > silenceTimeoutMs (1000), inside the guest's 4 s grace
    expect(hc.events.some((e) => e.type === 'disconnected')).toBe(false);
    env.broker.dropData = false;
    guest.expectBusy!(0);
    await env.run(300);
    expect(host.state).toBe('open');
    host.close();
    guest.close();
  });
});

describe('QF-6 second pass: a guest whose broker socket is gone', () => {
  it('glitch: both sides waiting forever — a rejoin through a broker that does not answer gives up after brokerTimeoutMs and the next attempt gets through', async () => {
    const env = fakeSetup();
    const { host, guest } = await openBoth(env);
    const gp = env.broker.created[1] as FakePeer;
    gp.loseBroker(); // iOS dropped the broker socket while the match ran (the data channels kept going)
    await env.run(20);
    expect(guest.state).toBe('open');
    for (const c of gp.liveConns()) c.close(); // later the link drops too
    await env.run(30);
    expect(guest.state).toBe('closed');
    void host.reconnect();
    env.broker.reachable = false; // the network is switching: the broker socket neither opens nor fails
    const first = guest.reconnect();
    const outcome = first.then(() => 'open', (e: unknown) => String((e as Error).message));
    await env.run(1500); // > brokerTimeoutMs (1000)
    env.broker.reachable = true;
    // was: still pending for ever (no timer on the broker reconnect): the session's re-dial loop waited on it, so the
    // guest never dialled again even once the network was back
    expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('broker-unreachable');
    expect(guest.state).toBe('closed');
    const second = guest.reconnect();
    await env.run(200);
    await second;
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    host.close();
    guest.close();
  });
});

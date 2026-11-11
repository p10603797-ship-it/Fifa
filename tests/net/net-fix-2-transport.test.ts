/**
 * [NET-FIX-2, D-045] Transport and lobby additions for same-Wi-Fi iPads (fake broker / in-memory pair, no network):
 *  - resume: a Peer that lost the broker while the page was hidden reconnects as soon as the page is visible again
 *    (once per return, not when still connected or destroyed, the pending broker retry is replaced), so a host who
 *    switched apps keeps the room; the listener is removed when the transport closes;
 *  - progress: 'broker' (with the relay wait when relay.json is loading), 'dialling' (relay flag), 'handshake', each
 *    with its stage's timeout;
 *  - build id: '$hello' and 'lobby:hello' carry it as information only: logged "peer build ...", a different build
 *    with the same protocol still connects, an old peer without the field too.
 */
import { describe, expect, it } from 'vitest';
import { CLUBS } from '../../src/data/clubs';
import { createLobby, LOBBY_HELLO } from '../../src/net/lobby';
import { createManualClock, createMemoryTransportPair } from '../../src/net/memoryTransport';
import { cleanBuildId, CTRL_HELLO, NET_PROTOCOL_VERSION } from '../../src/net/packet';
import { createPeerTransport, RELAY_WAIT_MS, type PeerTransportDeps } from '../../src/net/transport';
import type { ConnectProgress, NetTransport } from '../../src/net/types';
import { fakeSetup, FakePeer } from './qf-6-fakepeer';

function setup(deps: Partial<PeerTransportDeps> = {}, hostDeps: Partial<PeerTransportDeps> = {}) {
  const f = fakeSetup({ iceServers: [] });
  const lines: string[] = [];
  const timers = { now: f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout };
  const visible: (() => void)[] = [];
  let offs = 0;
  const onVisible = (fn: () => void): (() => void) => {
    visible.push(fn);
    return () => {
      offs++;
      const i = visible.indexOf(fn);
      if (i >= 0) visible.splice(i, 1);
    };
  };
  const make = (more: Partial<PeerTransportDeps> = {}): NetTransport => createPeerTransport(f.config, {
    createPeer: f.broker.factory, timers, log: (k, m) => lines.push(`[${k}] ${m}`), onVisible, ...deps, ...more,
  });
  return { ...f, lines, make, visible, showPage: () => { for (const fn of visible.slice()) fn(); }, offs: () => offs, hostDeps };
}

/** Counts reconnect() calls on a fake peer. */
function spyReconnect(p: FakePeer): { calls: number } {
  const c = { calls: 0 };
  const orig = p.reconnect.bind(p);
  p.reconnect = () => {
    c.calls++;
    orig();
  };
  return c;
}

describe('NET-FIX-2 resume: reconnect to the broker when the page is visible again', () => {
  it('a host whose broker socket dropped in the background re-registers at once on return, once per return', async () => {
    const s = setup();
    const host = s.make();
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(30);
    const peer = s.broker.created[0]!;
    expect(s.broker.peers.get(peer.id)).toBe(peer);
    const spy = spyReconnect(peer);
    // iOS closed the WebSocket while the app was in the background: the retry timer is frozen with the page.
    peer.loseBroker();
    expect(peer.disconnected).toBe(true);
    s.showPage();
    expect(spy.calls).toBe(1); // at once, not after brokerRetryMs
    expect(s.lines).toContain('[net] page visible again: reconnecting to the matchmaking server');
    s.showPage(); // still reconnecting (no longer 'disconnected'): no second call
    expect(spy.calls).toBe(1);
    await s.run(s.config.brokerRetryMs + 50);
    expect(spy.calls).toBe(1); // the scheduled retry was replaced by the visible-return reconnect
    expect(peer.disconnected).toBe(false);
    // The room still answers: a guest joins.
    const guest = s.make();
    await expect(Promise.all([guest.open('guest', 'KQZ7MP'), s.run(200)])).resolves.toBeDefined();
    expect(guest.state).toBe('open');
    expect(host.state).toBe('open');
    // A return while connected does nothing.
    s.showPage();
    expect(spy.calls).toBe(1);
    host.close();
    guest.close();
  });

  it('nothing to do when the Peer is connected, destroyed, or the transport closed; the listener goes with close()', async () => {
    const s = setup();
    const host = s.make();
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(30);
    const peer = s.broker.created[0]!;
    const spy = spyReconnect(peer);
    s.showPage();
    expect(spy.calls).toBe(0);
    expect(s.visible.length).toBe(1);
    host.close();
    expect(s.visible.length).toBe(0);
    expect(s.offs()).toBe(1);
    peer.disconnected = true;
    s.showPage();
    expect(spy.calls).toBe(0);
  });

  it('a guest that lost the broker during the lobby reconnects too (a later rejoin needs it); the link is untouched', async () => {
    const s = setup();
    const host = s.make();
    const guest = s.make();
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(20);
    await Promise.all([guest.open('guest', 'KQZ7MP'), s.run(200)]);
    const gp = s.broker.created[1]!;
    const spy = spyReconnect(gp);
    gp.loseBroker();
    s.showPage();
    expect(spy.calls).toBe(1);
    await s.run(50);
    expect(guest.state).toBe('open');
    expect(s.broker.connects.length).toBe(2); // no second dial
    host.close();
    guest.close();
  });

  it('deps.onVisible null: no visibility listener', () => {
    const s = setup({ onVisible: null });
    const t = s.make();
    void t.open('host', 'KQZ7MP').catch(() => undefined);
    expect(s.visible.length).toBe(0);
    t.close();
  });
});

describe('NET-FIX-2 connection progress', () => {
  it('guest: broker, then dialling, then handshake, each with its timeout', async () => {
    const s = setup();
    const host = s.make();
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(20);
    const guest = s.make();
    const seen: ConnectProgress[] = [];
    guest.onProgress!((p) => seen.push(p));
    expect(guest.progress).toBeNull();
    const opened = guest.open('guest', 'KQZ7MP');
    expect(guest.progress).toEqual({ stage: 'broker', timeoutMs: s.config.brokerTimeoutMs, relay: false });
    await Promise.all([opened, s.run(200)]);
    expect(seen.map((p) => p.stage)).toEqual(['broker', 'dialling', 'handshake']);
    expect(seen[1]).toEqual({ stage: 'dialling', timeoutMs: s.config.connectTimeoutMs, relay: false });
    expect(seen[2]).toEqual({ stage: 'handshake', timeoutMs: s.config.handshakeTimeoutMs, relay: false });
    host.close();
    guest.close();
  });

  it('with relay.json loading: the broker stage includes the relay wait; dialling says a relay is configured', async () => {
    const s = setup();
    const host = s.make();
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(20);
    const turn: RTCIceServer = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' };
    const guest = s.make({ extraIceServers: Promise.resolve([turn]), checkIceServers: null });
    const seen: ConnectProgress[] = [];
    guest.onProgress!((p) => seen.push(p));
    const opened = guest.open('guest', 'KQZ7MP');
    expect(seen[0]).toEqual({ stage: 'broker', timeoutMs: RELAY_WAIT_MS + s.config.brokerTimeoutMs, relay: false });
    await Promise.all([opened, s.run(200)]);
    expect(seen.find((p) => p.stage === 'dialling')).toEqual({ stage: 'dialling', timeoutMs: s.config.connectTimeoutMs, relay: true });
    host.close();
    guest.close();
  });
});

describe('NET-FIX-2 build id in the handshake (information only)', () => {
  it('cleanBuildId keeps printable ASCII up to 64 characters; anything else is unknown', () => {
    expect(cleanBuildId('0.1.0-abcdef0123')).toBe('0.1.0-abcdef0123');
    expect(cleanBuildId('a b\n<c>')).toBe('ab<c>');
    expect(cleanBuildId('x'.repeat(100))).toBe('x'.repeat(64));
    expect(cleanBuildId(undefined)).toBeNull();
    expect(cleanBuildId(42)).toBeNull();
    expect(cleanBuildId(' \t')).toBeNull();
  });

  it('$hello carries the build; a different build with the same protocol connects and both sides log it', async () => {
    const s = setup();
    const host = s.make({ build: '0.1.0-aaaaaaaaaa' });
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(20);
    const guest = s.make({ build: '0.1.0-bbbbbbbbbb' });
    await Promise.all([guest.open('guest', 'KQZ7MP'), s.run(200)]);
    expect(guest.state).toBe('open');
    expect(s.lines).toContain('[net] peer build 0.1.0-aaaaaaaaaa, this build 0.1.0-bbbbbbbbbb');
    expect(s.lines).toContain('[net] peer build 0.1.0-bbbbbbbbbb, this build 0.1.0-aaaaaaaaaa');
    // On the wire: { type: '$hello', v, b }.
    const hello = s.broker.created[1]!.conns.find((c) => c.label === 'control')!.sent
      .map((x) => (typeof x === 'string' ? JSON.parse(x) as Record<string, unknown> : null)).find((m) => m?.type === CTRL_HELLO);
    expect(hello).toEqual({ type: CTRL_HELLO, v: NET_PROTOCOL_VERSION, b: '0.1.0-bbbbbbbbbb' });
    host.close();
    guest.close();
  });

  it('an older peer without the field connects; its build is logged as unknown', async () => {
    const s = setup();
    const host = s.make({ build: '0.1.0-aaaaaaaaaa' });
    void host.open('host', 'KQZ7MP').catch(() => undefined);
    await s.run(20);
    const guest = s.make(); // no build: sends { type, v } only, like builds before NET-FIX-2
    await Promise.all([guest.open('guest', 'KQZ7MP'), s.run(200)]);
    expect(guest.state).toBe('open');
    expect(s.lines).toContain('[net] peer build unknown (older build), this build 0.1.0-aaaaaaaaaa');
    host.close();
    guest.close();
  });

  it('lobby:hello carries the build; a different build is logged and the lobby still opens', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 20, seed: 3, now: clock.now, schedule: clock.schedule });
    const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    const hostLines: string[] = [];
    const guestLines: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const sendReliable = pair.guest.sendReliable.bind(pair.guest);
    pair.guest.sendReliable = (m) => {
      sent.push(m);
      sendReliable(m);
    };
    const host = createLobby({ host: true, code: 'ABCDEF', nickname: 'Ana', transport: pair.host, timers, clubs: CLUBS, build: '0.1.0-host', log: (_k, m) => hostLines.push(m) });
    const guest = createLobby({ host: false, code: 'ABCDEF', nickname: 'Ben', transport: pair.guest, timers, clubs: CLUBS, build: '0.1.0-guest', log: (_k, m) => guestLines.push(m) });
    for (let t = 0; t < 500; t += 5) {
      clock.advance(5);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    expect(host.phase).toBe('lobby');
    expect(guest.phase).toBe('lobby');
    expect(sent.find((m) => m.type === LOBBY_HELLO)?.build).toBe('0.1.0-guest');
    expect(hostLines).toContain('lobby: peer build 0.1.0-guest, this build 0.1.0-host');
    expect(guestLines).toContain('lobby: peer build 0.1.0-host, this build 0.1.0-guest');
    host.leave();
    guest.leave();
  });
});

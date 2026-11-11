/**
 * [NET-FIX, D-044] The PeerJS transport and the ICE list / relay / connection-stage diagnostics (fake broker, no network):
 *  - the Peer is created with NET_CONFIG's STUN list plus the relay's servers (deps.extraIceServers), awaited first;
 *    a merged list the browser rejects (deps.checkIceServers) falls back to the STUN list alone;
 *  - a relay that fails or never answers costs at most RELAY_WAIT_MS and the room still opens (STUN only);
 *  - the broker timeout counts from when the ICE list is known;
 *  - channels that never open: the transport reports the candidate types and the failing stage (transport.ice and the
 *    diagnostics log), read from the RTCPeerConnection behind each DataConnection; a link that opens reports success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NET_CONFIG } from '../../src/net/config';
import { createPeerTransport, RELAY_WAIT_MS, type PeerTransportDeps } from '../../src/net/transport';
import type { NetTransport } from '../../src/net/types';
import { collect, fakeSetup, FakeConn } from './qf-6-fakepeer';

const TURN: RTCIceServer = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' };

interface FakePc {
  iceGatheringState: string;
  iceConnectionState: string;
  signalingState: string;
  localDescription: { sdp: string } | null;
  remoteDescription: { sdp: string } | null;
  listeners: Record<string, ((e: unknown) => void)[]>;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  fire(t: string, e?: unknown): void;
  getStats(): Promise<Map<string, unknown>>;
}

function fakePc(): FakePc {
  const pc: FakePc = {
    iceGatheringState: 'new', iceConnectionState: 'new', signalingState: 'have-local-offer', localDescription: null, remoteDescription: null,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); },
    fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f(e); },
    async getStats() {
      return new Map<string, unknown>([
        ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: 'relay' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx' }],
      ]);
    },
  };
  return pc;
}

// Every fake DataConnection gets an RTCPeerConnection, like PeerJS's (dataConnection.peerConnection).
const pcs: FakePc[] = [];
beforeEach(() => {
  pcs.length = 0;
  Object.defineProperty(FakeConn.prototype, 'peerConnection', {
    configurable: true,
    get(this: FakeConn & { _pc?: FakePc }) {
      if (!this._pc) {
        this._pc = fakePc();
        pcs.push(this._pc);
      }
      return this._pc;
    },
  });
});
afterEach(() => {
  delete (FakeConn.prototype as unknown as { peerConnection?: unknown }).peerConnection;
});

function setup(extra?: PeerTransportDeps['extraIceServers'], overrides = {}, check?: PeerTransportDeps['checkIceServers']) {
  const f = fakeSetup({ iceServers: NET_CONFIG.iceServers, ...overrides });
  const lines: string[] = [];
  const timers = { now: f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout };
  const make = (withExtra: boolean): NetTransport => createPeerTransport(f.config, {
    createPeer: f.broker.factory, timers, log: (k, m) => lines.push(`[${k}] ${m}`), ...(withExtra && extra ? { extraIceServers: extra } : {}),
    ...(check !== undefined ? { checkIceServers: check } : {}),
  });
  return { ...f, lines, make };
}

describe('NET-FIX transport ICE servers', () => {
  it('hands PeerJS the STUN list plus the relay\'s servers, after the relay resolved', async () => {
    let resolveRelay!: (v: readonly RTCIceServer[]) => void;
    const relay = new Promise<readonly RTCIceServer[]>((r) => { resolveRelay = r; });
    const s = setup(relay);
    const host = s.make(true);
    const guest = s.make(true);
    const hostDone = host.open('host', 'KQZ7MP');
    const guestDone = guest.open('guest', 'KQZ7MP');
    await s.run(50);
    expect(s.broker.created.length).toBe(0); // waits for the relay
    resolveRelay([TURN]);
    await s.run(200);
    await Promise.all([hostDone, guestDone]);
    expect(s.broker.created.length).toBe(2);
    for (const p of s.broker.created) {
      expect(p.options.config?.iceServers).toEqual([...NET_CONFIG.iceServers!, TURN]);
    }
    expect(host.state).toBe('open');
  });

  it('a relay list the browser rejects: both sides fall back to the STUN list alone and still connect', async () => {
    const odd = { urls: 'turn:odd.example:3478', username: 'u', credential: 'p' };
    const checked: RTCIceServer[][] = [];
    const check = (servers: RTCIceServer[]): string | null => {
      checked.push(servers);
      return servers.some((x) => x.urls === odd.urls) ? 'SyntaxError' : null;
    };
    const s = setup(Promise.resolve([odd]), {}, check);
    const host = s.make(true);
    const guest = s.make(true);
    const done = Promise.all([host.open('host', 'KQZ7MP'), guest.open('guest', 'KQZ7MP')]);
    await s.run(200);
    await done;
    expect(s.broker.created.length).toBe(2);
    for (const p of s.broker.created) expect(p.options.config?.iceServers).toEqual(NET_CONFIG.iceServers);
    expect(checked.length).toBe(2);
    expect(s.lines.filter((l) => l.includes('the browser rejects the ICE server list')).length).toBe(2);
    expect(s.lines.join('\n')).not.toContain('"p"');
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
  });

  it('the browser check runs only for run-time servers, and an accepted list is used as is', async () => {
    const calls: number[] = [];
    const s = setup(Promise.resolve([TURN]), {}, (servers) => { calls.push(servers.length); return null; });
    void s.make(true).open('host', 'KQZ7MP');
    await s.run(50);
    expect(calls).toEqual([NET_CONFIG.iceServers!.length + 1]);
    expect(s.broker.created[0]!.options.config?.iceServers).toEqual([...NET_CONFIG.iceServers!, TURN]);
    const s2 = setup(undefined, {}, () => { calls.push(-1); return 'SyntaxError'; });
    void s2.make(false).open('host', 'AAAAAA');
    await s2.run(50);
    expect(calls).toEqual([NET_CONFIG.iceServers!.length + 1]);
    expect(s2.broker.created[0]!.options.config?.iceServers).toEqual(NET_CONFIG.iceServers);
  });

  it('without a relay the Peer still gets the explicit STUN list (never PeerJS\'s TURN defaults)', async () => {
    const s = setup();
    const host = s.make(false);
    void host.open('host', 'KQZ7MP');
    await s.run(20);
    expect(s.broker.created[0]!.options.config?.iceServers).toEqual(NET_CONFIG.iceServers);
    expect(JSON.stringify(s.broker.created[0]!.options)).not.toMatch(/turn:/);
  });

  it('a rejected relay counts as none; a relay that never answers is given up after RELAY_WAIT_MS and the room opens', async () => {
    const s = setup(Promise.reject(new Error('boom')));
    const t = s.make(true);
    void t.open('host', 'AAAAAA');
    await s.run(20);
    expect(s.broker.created[0]!.options.config?.iceServers).toEqual(NET_CONFIG.iceServers);

    const s2 = setup(new Promise<readonly RTCIceServer[]>(() => undefined), { brokerTimeoutMs: 1000 });
    const host = s2.make(true);
    const guest = s2.make(false);
    const ev = collect(host);
    const done = host.open('host', 'BBBBBB');
    await s2.run(RELAY_WAIT_MS - 100);
    expect(s2.broker.created.length).toBe(0);
    expect(ev.events.filter((e) => e.type === 'error')).toEqual([]); // the broker timeout has not started yet
    await s2.run(200);
    expect(s2.broker.created.length).toBe(1);
    expect(s2.lines.join('\n')).toMatch(/relay: no answer within/);
    void guest.open('guest', 'BBBBBB');
    await s2.run(200);
    await done;
    expect(host.state).toBe('open');
  });
});

describe('NET-FIX connection-stage diagnostics', () => {
  it('channels that never open: candidate types and the failing stage in transport.ice and the diagnostics log', async () => {
    const s = setup(Promise.resolve([]), { connectTimeoutMs: 2000 });
    s.broker.iceBlocked = true;
    const host = s.make(true);
    const guest = s.make(true);
    void host.open('host', 'KQZ7MP');
    await s.run(20);
    const failed = guest.open('guest', 'KQZ7MP').catch((e: Error) => e.message);
    await s.run(40);
    expect(pcs.length).toBeGreaterThan(0);
    // ICE on every connection: both sides gathered host + srflx, the offers / answers and candidates crossed, no pair worked.
    for (const pc of pcs) {
      pc.fire('icecandidate', { candidate: { type: 'host', candidate: 'candidate:1 1 udp 1 192.168.1.2 5000 typ host' } });
      pc.fire('icecandidate', { candidate: { candidate: 'candidate:2 1 udp 1 81.2.3.4 5000 typ srflx raddr 0.0.0.0 rport 0' } });
      pc.iceGatheringState = 'complete';
      pc.signalingState = 'stable';
      pc.remoteDescription = { sdp: 'v=0\r\na=candidate:7 1 udp 1 100.64.0.9 6000 typ srflx raddr 0.0.0.0 rport 0\r\n' };
      pc.iceConnectionState = 'checking';
      pc.fire('iceconnectionstatechange');
    }
    await s.run(2100);
    expect(await failed).toBe('blocked');
    expect(guest.ice).toMatchObject({ stage: 'ice', local: ['host', 'srflx'], remote: ['srflx'], ice: 'checking', relayConfigured: false, servers: 3 });
    expect(s.lines.some((l) => /^\[net\] ice failed at ice: local host\+srflx, remote srflx, .*no TURN \(data channels did not open\)$/.test(l))).toBe(true);
    // The host saw the failed guest too.
    expect(host.ice?.stage).toBe('ice');
    expect(s.lines.filter((l) => l.includes('a guest could not connect')).length).toBe(1);
  });

  it('nothing heard back from the other side is a signalling failure; a TURN relay with no relay candidate is reported', async () => {
    const s = setup(Promise.resolve([TURN]), { connectTimeoutMs: 2000 });
    s.broker.iceBlocked = true;
    const host = s.make(true);
    const guest = s.make(true);
    void host.open('host', 'KQZ7MP');
    await s.run(20);
    const failed = guest.open('guest', 'KQZ7MP').catch((e: Error) => e.message);
    await s.run(40);
    for (const pc of pcs) pc.fire('icecandidate', { candidate: { type: 'host', candidate: '' } });
    await s.run(2100);
    expect(await failed).toBe('blocked');
    expect(guest.ice).toMatchObject({ stage: 'signalling', local: ['host'], remote: [], relayConfigured: true, servers: 4 });
  });

  it('a link that opens records success and logs the candidate pair in use (one getStats, no polling)', async () => {
    const s = setup(Promise.resolve([TURN]));
    const host = s.make(true);
    const guest = s.make(true);
    const a = host.open('host', 'KQZ7MP');
    await s.run(20);
    const b = guest.open('guest', 'KQZ7MP');
    await s.run(200);
    await Promise.all([a, b]);
    expect(guest.ice?.stage).toBeNull();
    await s.run(20);
    expect(s.lines.some((l) => /ice connected: .* incl\. TURN, pair relay -> srflx \(through the relay\)$/.test(l))).toBe(true);
    // Listeners only: the probe adds four per connection and nothing else.
    for (const pc of pcs) expect(Object.values(pc.listeners).reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(4);
  });
});

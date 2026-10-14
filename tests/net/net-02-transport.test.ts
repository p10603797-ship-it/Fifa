/**
 * [NET-02] Transport, config and wire codecs. No network: PeerJS is replaced by an in-process fake broker (FakePeer /
 * FakeConn below) driven by a manual clock, and the in-memory pair runs on the same clock.
 */
import { describe, expect, it } from 'vitest';
import { Command, GestureKind, SkillMove } from '../../src/contracts/enums';
import { Btn, createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createNetConfig, NET_CONFIG } from '../../src/net/config';
import { createManualClock, createMemoryTransportPair, type ManualClock } from '../../src/net/memoryTransport';
import {
  createControlCodec, CONTROL_FRAGMENT_CHARS, decodeInputPacket, encodeInputPacket, FRAME_INTS, inputPacketBytes,
  NET_PROTOCOL_VERSION, packSenderFrame, PACKET_HEADER_BYTES, reasonOf, unpackSenderFrame,
} from '../../src/net/packet';
import {
  createGuestTransport, createHostTransport, createPeerTransport, mapPeerError, peerOptions, type DataConnectionLike,
  type PeerFactory, type PeerLike, type PeerOptionsLike,
} from '../../src/net/transport';
import type { ControlMessage, InputPacket, NetTransport, TransportEvent } from '../../src/net/types';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function busyFrame(seed: number): InputFrame {
  const f = createInputFrame();
  f.mx = -127 + seed;
  f.mz = 100 - seed;
  f.ax = 5;
  f.az = -7;
  f.buttons = Btn.PASS | Btn.SPRINT | Btn.RS_HOLD | (1 << 15);
  f.power = 99;
  f.curve = -50;
  f.skill = SkillMove.DRAG_BACK;
  f.cmd = Command.SKIP;
  f.cmdArg = 3;
  f.gesture = GestureKind.SWIPE;
  f.gx = -520;
  f.gz = 340;
  f.gSlot = 21;
  f.gdx = 12;
  f.gdz = -12;
  f.gPower = 127;
  f.gCurve = -127;
  f.gFlags = 5;
  return f;
}

describe('NET-02 packet codec', () => {
  it('round-trips a frame through packSenderFrame / unpackSenderFrame (packFrames encoding)', () => {
    const f = busyFrame(3);
    const buf = new Int16Array(FRAME_INTS + 4);
    packSenderFrame(f, buf, 2);
    const out = createInputFrame();
    unpackSenderFrame(buf, 2, out);
    for (const k of INPUT_FIELDS) expect(out[k], k).toBe(f[k]);
    expect(FRAME_INTS).toBe(INPUT_FIELDS.length);
    expect(() => packSenderFrame(f, new Int16Array(FRAME_INTS - 1), 0)).toThrow(RangeError);
  });

  it('round-trips an input packet through the binary wire format', () => {
    const data = new Int16Array(3 * FRAME_INTS);
    for (let i = 0; i < 3; i++) packSenderFrame(busyFrame(i), data, i * FRAME_INTS);
    const p: InputPacket = { firstTick: 1234, count: 3, ack: 1229, tick: 1226, adv: -1.5625, data };
    const bytes = encodeInputPacket(p);
    expect(bytes.byteLength).toBe(inputPacketBytes(3)); // every value non-zero: the sparse format's largest size
    expect(bytes.byteLength).toBe(PACKET_HEADER_BYTES + 3 * (3 + FRAME_INTS * 2));
    const q = decodeInputPacket(bytes)!;
    expect(q).not.toBeNull();
    expect([q.firstTick, q.count, q.ack, q.tick, q.adv]).toEqual([1234, 3, 1229, 1226, -1.5625]);
    expect(Array.from(q.data)).toEqual(Array.from(data));
    // Typed-array views decode too, and the decoded data is a copy.
    const q2 = decodeInputPacket(new Uint8Array(bytes))!;
    expect(Array.from(q2.data)).toEqual(Array.from(data));
    expect(q2.data.buffer).not.toBe(bytes);
  });

  it('rejects malformed packets without throwing', () => {
    const good = encodeInputPacket({ firstTick: 1, count: 1, ack: 0, tick: 0, adv: 0, data: new Int16Array(FRAME_INTS) });
    expect(decodeInputPacket(null)).toBeNull();
    expect(decodeInputPacket('hello')).toBeNull();
    expect(decodeInputPacket(new ArrayBuffer(3))).toBeNull();
    expect(decodeInputPacket(good.slice(0, good.byteLength - 2))).toBeNull();
    const badMagic = good.slice(0);
    new DataView(badMagic).setUint32(0, 0x12345678, true);
    expect(decodeInputPacket(badMagic)).toBeNull();
    const badCount = good.slice(0);
    new DataView(badCount).setInt32(8, 0, true);
    expect(decodeInputPacket(badCount)).toBeNull();
    const negTick = good.slice(0);
    new DataView(negTick).setInt32(4, -5, true);
    expect(decodeInputPacket(negTick)).toBeNull();
    expect(() => encodeInputPacket({ firstTick: 1, count: 0, ack: 0, tick: 0, adv: 0, data: new Int16Array(0) })).toThrow(RangeError);
  });

  it('fragments long control messages and reassembles them in order', () => {
    const a = createControlCodec();
    const b = createControlCodec();
    const big = { type: 'ls:snap', data: 'x'.repeat(CONTROL_FRAGMENT_CHARS * 3 + 17), n: 1 };
    const parts = a.encode(big);
    expect(parts.length).toBe(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(CONTROL_FRAGMENT_CHARS + 32);
    let got: ControlMessage | null = null;
    for (const p of parts) {
      expect(got).toBeNull();
      got = b.decode(p);
    }
    expect(got).toEqual(big);
    expect(b.decode(a.encode({ type: 'small', v: [1, 2] })[0])).toEqual({ type: 'small', v: [1, 2] });
    // Junk never throws.
    expect(b.decode('{not json')).toBeNull();
    expect(b.decode('[1,2]')).toBeNull();
    expect(b.decode('~x:y')).toBeNull();
    expect(b.decode(42)).toBeNull();
    // A fragment out of sequence drops the partial message.
    expect(b.decode(parts[1])).toBeNull();
    expect(b.decode(parts[3])).toBeNull();
  });

  it('maps rejections to plain-language reasons', () => {
    expect(reasonOf(new Error('room-full'))).toBe('room-full');
    expect(reasonOf(new Error('boom'))).toBe('disconnected');
    expect(reasonOf('code-not-found')).toBe('code-not-found');
  });
});

describe('NET-02 config', () => {
  it('defaults to the public PeerJS broker with PeerJS default ICE servers and no keys', () => {
    expect(NET_CONFIG.host).toBe('0.peerjs.com');
    expect(NET_CONFIG.secure).toBe(true);
    expect(NET_CONFIG.iceServers).toBeUndefined();
    expect(NET_CONFIG.peerPrefix).toBe('dotkick-');
    expect(JSON.stringify(NET_CONFIG)).not.toMatch(/key|token|credential/i);
    const o = peerOptions(NET_CONFIG);
    expect('config' in o).toBe(false); // PeerJS keeps its default ICE config
    expect(o).toMatchObject({ host: '0.peerjs.com', port: 443, path: '/', secure: true });
  });

  it('is replaceable for a self-hosted PeerServer', () => {
    const c = createNetConfig({ host: 'peer.example.org', port: 9000, path: '/dk', secure: false, iceServers: [{ urls: 'stun:x' }] });
    expect(c).toMatchObject({ host: 'peer.example.org', port: 9000, path: '/dk', secure: false, peerPrefix: 'dotkick-' });
    expect(peerOptions(c).config).toEqual({ iceServers: [{ urls: 'stun:x' }] });
    expect(NET_CONFIG.host).toBe('0.peerjs.com'); // defaults untouched
  });
});

describe('NET-02 error mapping', () => {
  it('maps PeerJS error types to the plain-language reasons', () => {
    expect(mapPeerError('peer-unavailable', 'dial')).toBe('code-not-found');
    expect(mapPeerError('invalid-id', 'broker')).toBe('code-not-found');
    expect(mapPeerError('unavailable-id', 'broker')).toBe('code-taken');
    expect(mapPeerError('network', 'broker')).toBe('broker-unreachable');
    expect(mapPeerError('server-error', 'dial')).toBe('broker-unreachable');
    expect(mapPeerError('socket-closed', 'broker')).toBe('broker-unreachable');
    expect(mapPeerError('webrtc', 'dial')).toBe('blocked');
    expect(mapPeerError('negotiation-failed', 'dial')).toBe('blocked');
    expect(mapPeerError('browser-incompatible', 'broker')).toBe('unsupported');
    expect(mapPeerError('connection-closed', 'open')).toBe('disconnected');
    expect(mapPeerError(undefined, 'broker')).toBe('broker-unreachable');
    expect(mapPeerError('???', 'dial')).toBe('blocked');
  });
});

// ---------------------------------------------------------------- memory transport

function collect(t: NetTransport): { events: TransportEvent[]; inputs: InputPacket[]; control: ControlMessage[] } {
  const r = { events: [] as TransportEvent[], inputs: [] as InputPacket[], control: [] as ControlMessage[] };
  t.onEvent((e) => r.events.push(e));
  t.onInputs((p) => r.inputs.push(p));
  t.onReliable((m) => r.control.push(m));
  return r;
}

const pkt = (tick: number): InputPacket => ({ firstTick: tick, count: 1, ack: -1, tick, adv: 0, data: new Int16Array(FRAME_INTS).fill(tick) });

async function openPair(clock: ManualClock, pair: ReturnType<typeof createMemoryTransportPair>): Promise<void> {
  const p = Promise.all([pair.host.open('host', 'ABCDEF'), pair.guest.open('guest', 'ABCDEF')]);
  clock.advance(1000);
  await p;
}

describe('NET-02 memory transport', () => {
  it('opens both ends, delivers with latency, keeps the control channel ordered and measures RTT', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 40, jitterMs: 30, seed: 3, now: clock.now, schedule: clock.schedule });
    const g = collect(pair.guest);
    await openPair(clock, pair);
    expect(pair.host.state).toBe('open');
    expect(pair.guest.role).toBe('guest');
    expect(g.events[0]).toEqual({ type: 'connected' });
    for (let i = 0; i < 50; i++) pair.host.sendReliable({ type: 'lobby:n', i });
    clock.advance(39);
    expect(g.control.length).toBe(0);
    clock.advance(100);
    expect(g.control.map((m) => m.i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    // '$ping' is internal: it measured a round trip but never reached subscribers.
    clock.advance(2000);
    expect(pair.host.rtt).toBeGreaterThanOrEqual(80);
    expect(pair.host.rtt).toBeLessThanOrEqual(140);
    expect(g.events.some((e) => e.type === 'rtt')).toBe(true);
    expect(g.control.every((m) => !m.type.startsWith('$'))).toBe(true);
    pair.host.close();
    pair.guest.close();
  });

  it('drops, duplicates and reorders input packets reproducibly from the seed', async () => {
    const run = async (): Promise<number[]> => {
      const clock = createManualClock();
      const pair = createMemoryTransportPair({
        latencyMs: 30, jitterMs: 25, loss: 0.2, duplicate: 0.1, seed: 11, pingIntervalMs: 0, now: clock.now, schedule: clock.schedule,
      });
      const g = collect(pair.guest);
      await openPair(clock, pair);
      for (let t = 0; t < 200; t++) {
        pair.host.sendInputs(pkt(t));
        clock.advance(5);
      }
      clock.advance(500);
      const s = pair.stats.hostToGuest;
      expect(s.inputsSent).toBe(200);
      expect(s.inputsDropped).toBeGreaterThan(20);
      expect(s.inputsDuplicated).toBeGreaterThan(5);
      expect(g.inputs.length).toBe(200 - s.inputsDropped + s.inputsDuplicated);
      return g.inputs.map((p) => p.firstTick);
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    // jitter 25 ms vs 5 ms spacing: some packets arrive out of order
    let inversions = 0;
    for (let i = 1; i < a.length; i++) if (a[i]! < a[i - 1]!) inversions++;
    expect(inversions).toBeGreaterThan(0);
  });

  it('delays (never loses) control messages under reliableLoss and applies a bandwidth cap', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({
      latencyMs: 20, reliableLoss: 0.5, retransmitMs: 100, bandwidthBytesPerSec: 10_000, seed: 5, pingIntervalMs: 0,
      now: clock.now, schedule: clock.schedule,
    });
    const g = collect(pair.guest);
    await openPair(clock, pair);
    for (let i = 0; i < 20; i++) pair.host.sendReliable({ type: 'x', i, pad: 'p'.repeat(480) });
    clock.advance(500);
    expect(g.control.length).toBeLessThan(20); // 20 x ~500 B at 10 kB/s needs about a second
    clock.advance(5000);
    expect(g.control.map((m) => m.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(pair.stats.hostToGuest.reliableRetransmits).toBeGreaterThan(0);
  });

  it('reports code-not-found, version-mismatch and configured open errors', async () => {
    const clock = createManualClock();
    const p1 = createMemoryTransportPair({ now: clock.now, schedule: clock.schedule });
    const h1 = p1.host.open('host', 'AAAAAA');
    const g1 = p1.guest.open('guest', 'BBBBBB');
    clock.advance(10);
    await expect(g1).rejects.toThrow('code-not-found');
    expect(p1.guest.state).toBe('failed');
    p1.host.close();
    await expect(h1).rejects.toThrow('disconnected');

    const p2 = createMemoryTransportPair({ guestVersion: 'old', now: clock.now, schedule: clock.schedule });
    const both = Promise.allSettled([p2.host.open('host', 'C'), p2.guest.open('guest', 'C')]);
    clock.advance(10);
    const res = await both;
    expect(res.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual(['version-mismatch', 'version-mismatch']);

    const p3 = createMemoryTransportPair({ guestOpenError: 'blocked', now: clock.now, schedule: clock.schedule });
    void p3.host.open('host', 'D').catch(() => {});
    const g3 = p3.guest.open('guest', 'D');
    clock.advance(10);
    await expect(g3).rejects.toThrow('blocked');
  });

  it('sever(): both sides get disconnected, the host waits, the guest reconnects', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 10, now: clock.now, schedule: clock.schedule });
    const h = collect(pair.host);
    const g = collect(pair.guest);
    await openPair(clock, pair);
    pair.host.sendReliable({ type: 'lost' });
    pair.sever();
    clock.advance(100);
    expect(g.control.length).toBe(0); // in-flight messages die with the link
    expect(h.events.at(-1)).toEqual({ type: 'disconnected', reason: 'disconnected' });
    expect(g.events.at(-1)).toEqual({ type: 'disconnected', reason: 'disconnected' });
    expect(pair.host.state).toBe('connecting');
    expect(pair.guest.state).toBe('closed');
    pair.host.sendReliable({ type: 'dropped' }); // not open: ignored
    const hostBack = pair.host.reconnect();
    const guestBack = pair.guest.reconnect();
    clock.advance(100);
    await Promise.all([hostBack, guestBack]);
    expect(pair.host.state).toBe('open');
    expect(h.events.filter((e) => e.type === 'connected').length).toBe(2);
    pair.host.sendReliable({ type: 'again' });
    clock.advance(20);
    expect(g.control.map((m) => m.type)).toEqual(['again']);
    // close(): the other side hears about it.
    pair.guest.close();
    clock.advance(20);
    expect(h.events.at(-1)).toEqual({ type: 'disconnected', reason: 'disconnected' });
    pair.guest.close(); // idempotent
    await expect(pair.guest.reconnect()).rejects.toThrow('disconnected');
  });
});

// ---------------------------------------------------------------- PeerJS transport with a fake broker

interface Handlers {
  [event: string]: ((arg: never) => void)[];
}

class Emitter {
  private readonly h: Handlers = {};
  on(event: string, fn: (arg: never) => void): this {
    (this.h[event] ??= []).push(fn);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    for (const fn of this.h[event] ?? []) (fn as (a: unknown) => void)(arg);
  }
}

class FakeConn extends Emitter implements DataConnectionLike {
  open = false;
  closed = false;
  other: FakeConn | null = null;
  sent: unknown[] = [];
  constructor(readonly broker: FakeBroker, readonly peer: string, readonly label: string) {
    super();
  }
  send(data: unknown): void {
    if (!this.open) throw new Error('not open');
    this.sent.push(data);
    const o = this.other;
    if (this.broker.dropData) return;
    this.broker.later(() => {
      if (o && o.open) o.emit('data', data);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    const o = this.other;
    this.broker.later(() => o?.close());
  }
}

class FakePeer extends Emitter implements PeerLike {
  destroyed = false;
  disconnected = false;
  id: string;
  conns: FakeConn[] = [];
  constructor(readonly broker: FakeBroker, id: string | undefined, readonly options: PeerOptionsLike) {
    super();
    this.id = id ?? `guest-${++broker.n}`;
    broker.later(() => this.register());
  }
  private register(): void {
    if (this.destroyed) return;
    if (!this.broker.reachable) return; // silence: the transport's broker timeout fires
    if (this.broker.peers.has(this.id)) {
      this.emit('error', { type: 'unavailable-id', message: 'taken' });
      return;
    }
    this.broker.peers.set(this.id, this);
    this.emit('open', this.id);
  }
  connect(peerId: string, options: { label: string; reliable: boolean; serialization: string }): DataConnectionLike {
    const mine = new FakeConn(this.broker, peerId, options.label);
    this.conns.push(mine);
    this.broker.connects.push({ from: this.id, to: peerId, ...options });
    this.broker.later(() => {
      const target = this.broker.peers.get(peerId);
      if (!target || target.destroyed) {
        this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${peerId}` });
        return;
      }
      const theirs = new FakeConn(this.broker, this.id, options.label);
      target.conns.push(theirs);
      mine.other = theirs;
      theirs.other = mine;
      target.emit('connection', theirs);
      if (this.broker.iceBlocked) return; // channels never open
      this.broker.later(() => {
        mine.open = true;
        theirs.open = true;
        theirs.emit('open');
        mine.emit('open');
      });
    });
    return mine;
  }
  reconnect(): void {
    this.disconnected = false;
    this.broker.later(() => this.emit('open', this.id));
  }
  destroy(): void {
    this.destroyed = true;
    if (this.broker.peers.get(this.id) === this) this.broker.peers.delete(this.id);
    for (const c of this.conns) c.close();
  }
}

class FakeBroker {
  n = 0;
  reachable = true;
  iceBlocked = false;
  dropData = false;
  peers = new Map<string, FakePeer>();
  created: FakePeer[] = [];
  connects: { from: string; to: string; label: string; reliable: boolean; serialization: string }[] = [];
  constructor(readonly clock: ManualClock, readonly latency = 5) {}
  later(fn: () => void): void {
    this.clock.schedule(fn, this.latency);
  }
  factory: PeerFactory = (id, options) => {
    const p = new FakePeer(this, id, options);
    this.created.push(p);
    return p;
  };
}

function setup(): { clock: ManualClock; broker: FakeBroker; make: (version?: string) => NetTransport; run: (ms: number) => Promise<void> } {
  const clock = createManualClock();
  const broker = new FakeBroker(clock);
  const config = createNetConfig({ brokerTimeoutMs: 1000, connectTimeoutMs: 2000, handshakeTimeoutMs: 500, pingIntervalMs: 100, silenceTimeoutMs: 1000 });
  const timers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const make = (version?: string): NetTransport =>
    createPeerTransport(config, { createPeer: broker.factory, timers, version });
  const run = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 5) {
      await settle(); // let open() attach its Peer handlers first (real PeerJS events always come later)
      clock.advance(5);
      await settle();
    }
  };
  return { clock, broker, make, run };
}

describe('NET-02 PeerJS transport (mocked Peer / DataConnection)', () => {
  it('hosts under prefix + code, the guest dials two channels, both handshake and exchange data', async () => {
    const { broker, make, run } = setup();
    const host = make();
    const guest = make();
    const hc = collect(host);
    const gc = collect(guest);
    const hostOpen = host.open('host', 'ABCDEF');
    await run(20);
    expect(broker.peers.has('dotkick-ABCDEF')).toBe(true);
    expect(host.state).toBe('connecting');
    const guestOpen = guest.open('guest', 'ABCDEF');
    await run(100);
    await Promise.all([hostOpen, guestOpen]);
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
    expect(hc.events[0]).toEqual({ type: 'connected' });
    expect(broker.connects.map((c) => [c.label, c.reliable, c.serialization])).toEqual([
      ['control', true, 'raw'], ['inputs', false, 'raw'],
    ]);
    // Handshake carried the protocol version.
    const hostPeer = broker.created[0]!;
    const hostControl = hostPeer.conns.find((c) => c.label === 'control')!;
    expect(String(hostControl.sent[0])).toContain(NET_PROTOCOL_VERSION);

    const data = new Int16Array(2 * FRAME_INTS);
    packSenderFrame(busyFrame(1), data, FRAME_INTS);
    guest.sendInputs({ firstTick: 77, count: 2, ack: 70, tick: 75, adv: 0.5, data });
    host.sendReliable({ type: 'lobby:hello', nick: 'Ann', big: 'z'.repeat(20_000) });
    await run(50);
    expect(hc.inputs.length).toBe(1);
    expect(hc.inputs[0]!.firstTick).toBe(77);
    expect(Array.from(hc.inputs[0]!.data)).toEqual(Array.from(data));
    expect(gc.control).toEqual([{ type: 'lobby:hello', nick: 'Ann', big: 'z'.repeat(20_000) }]);
    // Pings measured the round trip (2 x 5 ms fake latency per hop) and stayed internal.
    await run(500);
    expect(host.rtt).toBeGreaterThan(0);
    expect(guest.jitter).toBeGreaterThanOrEqual(0);
    expect(gc.control.length).toBe(1);
    host.close();
    guest.close();
  });

  it('guest: unknown code -> code-not-found', async () => {
    const { make, run } = setup();
    const guest = make();
    const events = collect(guest).events;
    const p = guest.open('guest', 'NOPE42');
    const check = expect(p).rejects.toThrow('code-not-found');
    await run(50);
    await check;
    expect(guest.state).toBe('failed');
    expect(events).toContainEqual({ type: 'error', reason: 'code-not-found', detail: 'Could not connect to peer dotkick-NOPE42' });
  });

  it('broker silence -> broker-unreachable after brokerTimeoutMs', async () => {
    const { broker, make, run } = setup();
    broker.reachable = false;
    const host = make();
    const p = host.open('host', 'ABCDEF');
    const check = expect(p).rejects.toThrow('broker-unreachable');
    await run(900);
    expect(host.state).toBe('connecting');
    await run(200);
    await check;
    expect(broker.created[0]!.destroyed).toBe(true);
  });

  it('host: code already in use -> code-taken', async () => {
    const { make, run } = setup();
    const a = make();
    void a.open('host', 'SAME11').catch(() => {});
    await run(20);
    const b = make();
    const p = b.open('host', 'SAME11');
    const check = expect(p).rejects.toThrow('code-taken');
    await run(20);
    await check;
    a.close();
  });

  it('ICE failure -> blocked for the guest, the host keeps its room open', async () => {
    const { broker, make, run } = setup();
    const host = make();
    const hc = collect(host);
    void host.open('host', 'ABCDEF').catch(() => {});
    await run(20);
    broker.iceBlocked = true;
    const guest = make();
    const p = guest.open('guest', 'ABCDEF');
    const check = expect(p).rejects.toThrow('blocked');
    await run(2100);
    await check;
    expect(host.state).toBe('connecting');
    expect(hc.events).toContainEqual({ type: 'error', reason: 'blocked', detail: 'a guest could not connect' });
    // A later guest on a good network still gets in.
    broker.iceBlocked = false;
    const guest2 = make();
    const p2 = guest2.open('guest', 'ABCDEF');
    await run(100);
    await p2;
    expect(host.state).toBe('open');
    host.close();
    guest2.close();
  });

  it('version mismatch is reported on both sides', async () => {
    const { make, run } = setup();
    const host = make('1.0/sim1/net1');
    const guest = make('0.9/sim1/net1');
    const hp = host.open('host', 'ABCDEF');
    const hcheck = expect(hp).rejects.toThrow('version-mismatch');
    await run(20);
    const gp = guest.open('guest', 'ABCDEF');
    const gcheck = expect(gp).rejects.toThrow('version-mismatch');
    await run(100);
    await Promise.all([hcheck, gcheck]);
  });

  it('a second guest gets room-full', async () => {
    const { make, run } = setup();
    const host = make();
    void host.open('host', 'ABCDEF');
    await run(20);
    const g1 = make();
    const g2 = make();
    const p1 = g1.open('guest', 'ABCDEF');
    await run(100);
    await p1;
    const p2 = g2.open('guest', 'ABCDEF');
    const check = expect(p2).rejects.toThrow('room-full');
    await run(100);
    await check;
    expect(host.state).toBe('open');
    expect(g1.state).toBe('open');
    host.close();
    g1.close();
  });

  it('reconnect handling: the guest drops, the host waits in the same room and the guest rejoins', async () => {
    const { broker, make, run } = setup();
    const host = make();
    const guest = make();
    const hc = collect(host);
    const gc = collect(guest);
    void host.open('host', 'ABCDEF');
    await run(20);
    const gp = guest.open('guest', 'ABCDEF');
    await run(100);
    await gp;
    // The guest's channels die (Wi-Fi blip).
    const guestPeer = broker.created[1]!;
    for (const c of guestPeer.conns) c.close();
    await run(50);
    expect(gc.events.filter((e) => e.type === 'disconnected')).toEqual([{ type: 'disconnected', reason: 'disconnected' }]);
    expect(hc.events.filter((e) => e.type === 'disconnected')).toEqual([{ type: 'disconnected', reason: 'disconnected' }]);
    expect(host.state).toBe('connecting');
    expect(guest.state).toBe('closed');
    const hostBack = host.reconnect();
    const guestBack = guest.reconnect();
    await run(100);
    await Promise.all([hostBack, guestBack]);
    expect(host.state).toBe('open');
    expect(guest.state).toBe('open');
    guest.sendReliable({ type: 'session:resume' });
    await run(20);
    expect(hc.control).toEqual([{ type: 'session:resume' }]);
    // If the host is gone for good, a guest reconnect fails with code-not-found.
    host.close();
    await run(50);
    expect(guest.state).toBe('closed');
    const again = guest.reconnect();
    const check = expect(again).rejects.toThrow('code-not-found');
    await run(100);
    await check;
  });

  it('silence for silenceTimeoutMs means disconnected', async () => {
    const { broker, make, run } = setup();
    const host = make();
    const guest = make();
    const hc = collect(host);
    void host.open('host', 'ABCDEF');
    await run(20);
    const gp = guest.open('guest', 'ABCDEF');
    await run(100);
    await gp;
    broker.dropData = true; // the link goes quiet without closing
    await run(1300);
    expect(hc.events.at(-1)).toEqual({ type: 'disconnected', reason: 'disconnected' });
    expect(host.state).toBe('connecting');
  });

  it('createHostTransport / createGuestTransport use an explicit peer id; nothing happens before open()', async () => {
    const { broker, clock, run } = setup();
    const timers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    const host = createHostTransport(NET_CONFIG, 'custom-room', { createPeer: broker.factory, timers });
    const guest = createGuestTransport(NET_CONFIG, 'custom-room', { createPeer: broker.factory, timers });
    await run(50);
    expect(broker.created.length).toBe(0); // no network use before open()
    void host.open('host', 'ignored');
    await run(20);
    expect(broker.peers.has('custom-room')).toBe(true);
    const gp = guest.open('guest', 'ignored');
    await run(100);
    await gp;
    expect(guest.state).toBe('open');
    await expect(guest.open('guest', 'x')).rejects.toThrow('open() called twice');
    host.close();
    guest.close();
    host.close(); // idempotent
  });

  it('importing the transport never loads peerjs or touches WebRTC', async () => {
    expect((globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection).toBeUndefined();
    const mod = await import('../../src/net/transport');
    const t = mod.createPeerTransport(NET_CONFIG);
    expect(t.state).toBe('idle');
    t.close();
  });
});

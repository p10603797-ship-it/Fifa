/**
 * [QF-6] In-process fake PeerJS broker for transport tests (no network), extended from the NET-02 fake:
 *  - FakeConn.dieLocally(): one side of a data channel dies without the other side hearing about it (a NAT rebinding
 *    or Wi-Fi switch seen by one end first: the other end keeps an "open" channel until its silence timeout).
 *  - FakePeer.goSilent(): everything this peer sends is dropped from now on (a page that froze or was unloaded
 *    without closing its channels).
 *  - FakeBroker.iceBlocked: new channels never open (ICE failure), for one attempt at a time.
 *  - FakePeer.loseBroker() / FakeBroker.reachable = false: the broker socket drops; a reconnect to an unreachable broker
 *    neither opens nor fails (second pass).
 */
import { createNetConfig, type NetConfig } from '../../src/net/config';
import { createManualClock, type ManualClock } from '../../src/net/memoryTransport';
import { createPeerTransport, type DataConnectionLike, type PeerFactory, type PeerLike, type PeerOptionsLike } from '../../src/net/transport';
import type { ControlMessage, InputPacket, NetTransport, TransportEvent } from '../../src/net/types';

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
    for (const fn of (this.h[event] ?? []).slice()) (fn as (a: unknown) => void)(arg);
  }
}

export class FakeConn extends Emitter implements DataConnectionLike {
  open = false;
  closed = false;
  other: FakeConn | null = null;
  sent: unknown[] = [];
  constructor(readonly broker: FakeBroker, readonly owner: FakePeer, readonly peer: string, readonly label: string) {
    super();
  }
  send(data: unknown): void {
    if (!this.open) throw new Error('not open');
    this.sent.push(data);
    const o = this.other;
    if (this.broker.dropData || this.owner.silent) return;
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
    if (this.owner.silent) return;
    this.broker.later(() => o?.close());
  }
  /** This end dies; the other end is not told (it keeps sending into the void). */
  dieLocally(): void {
    const o = this.other;
    if (o) o.other = null;
    this.other = null;
    this.close();
  }
}

export class FakePeer extends Emitter implements PeerLike {
  destroyed = false;
  disconnected = false;
  silent = false;
  id: string;
  conns: FakeConn[] = [];
  constructor(readonly broker: FakeBroker, id: string | undefined, readonly options: PeerOptionsLike) {
    super();
    this.id = id ?? `guest-${++broker.n}`;
    broker.later(() => this.register());
  }
  private register(): void {
    if (this.destroyed) return;
    if (!this.broker.reachable) return;
    if (this.broker.peers.has(this.id)) {
      this.emit('error', { type: 'unavailable-id', message: 'taken' });
      return;
    }
    this.broker.peers.set(this.id, this);
    this.emit('open', this.id);
  }
  connect(peerId: string, options: { label: string; reliable: boolean; serialization: string }): DataConnectionLike {
    const mine = new FakeConn(this.broker, this, peerId, options.label);
    this.conns.push(mine);
    this.broker.connects.push({ from: this.id, to: peerId, ...options });
    this.broker.later(() => {
      const target = this.broker.peers.get(peerId);
      if (!target || target.destroyed) {
        this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${peerId}` });
        return;
      }
      const theirs = new FakeConn(this.broker, target, this.id, options.label);
      target.conns.push(theirs);
      mine.other = theirs;
      theirs.other = mine;
      target.emit('connection', theirs);
      if (this.broker.iceBlocked) return;
      this.broker.later(() => {
        if (mine.closed || theirs.closed) return;
        mine.open = true;
        theirs.open = true;
        theirs.emit('open');
        mine.emit('open');
      });
    });
    return mine;
  }
  reconnect(): void {
    // Like PeerJS: no longer 'disconnected' while it tries. An unreachable broker is a black hole (a Wi-Fi switch: the
    // WebSocket neither opens nor fails for a long time).
    this.disconnected = false;
    if (!this.broker.reachable) return;
    this.broker.later(() => this.emit('open', this.id));
  }
  /** The broker WebSocket drops (iOS closes sockets of a backgrounded page); data channels are not affected. */
  loseBroker(): void {
    this.disconnected = true;
    this.emit('disconnected');
  }
  destroy(): void {
    this.destroyed = true;
    if (this.broker.peers.get(this.id) === this) this.broker.peers.delete(this.id);
    for (const c of this.conns) c.close();
  }
  /** Every live channel of this peer to `remoteId`. */
  liveConns(remoteId?: string): FakeConn[] {
    return this.conns.filter((c) => !c.closed && (remoteId === undefined || c.peer === remoteId));
  }
  /** Every live channel of this peer dies on this side only (the remote ends are not told). */
  dieLocally(): void {
    const live = this.liveConns();
    for (const c of live) {
      if (c.other) c.other.other = null;
      c.other = null;
    }
    for (const c of live) c.close();
  }
  /** From now on nothing this peer sends arrives anywhere (frozen or unloaded page). */
  goSilent(): void {
    this.silent = true;
  }
}

export class FakeBroker {
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

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

export const FAKE_CONFIG: Partial<NetConfig> = {
  brokerTimeoutMs: 1000, connectTimeoutMs: 2000, handshakeTimeoutMs: 500, pingIntervalMs: 100, silenceTimeoutMs: 1000,
  replaceSilentMs: 400,
};

export function fakeSetup(overrides: Partial<NetConfig> = {}): {
  clock: ManualClock; broker: FakeBroker; config: NetConfig; make: () => NetTransport; run: (ms: number) => Promise<void>;
} {
  const clock = createManualClock();
  const broker = new FakeBroker(clock);
  const config = createNetConfig({ ...FAKE_CONFIG, ...overrides });
  const timers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const make = (): NetTransport => createPeerTransport(config, { createPeer: broker.factory, timers });
  const run = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 5) {
      await settle();
      clock.advance(5);
      await settle();
    }
  };
  return { clock, broker, config, make, run };
}

export function collect(t: NetTransport): { events: TransportEvent[]; inputs: InputPacket[]; control: ControlMessage[] } {
  const r = { events: [] as TransportEvent[], inputs: [] as InputPacket[], control: [] as ControlMessage[] };
  t.onEvent((e) => r.events.push(e));
  t.onInputs((p) => r.inputs.push(p));
  t.onReliable((m) => r.control.push(m));
  return r;
}

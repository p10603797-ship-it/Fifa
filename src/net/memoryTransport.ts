/**
 * [NET-02] In-memory NetTransport pair for tests and tools/netsim.ts (NET-08 drives its lossy network simulator
 * through these options). Never touches the network.
 *
 *   const clock = createManualClock();
 *   const pair = createMemoryTransportPair({ latencyMs: 80, jitterMs: 20, loss: 0.05, seed: 7, now: clock.now,
 *     schedule: clock.schedule });
 *   const opened = Promise.all([pair.host.open('host', 'ABCDEF'), pair.guest.open('guest', 'ABCDEF')]);
 *   clock.advance(100); await opened;
 *
 * The link is seeded and deterministic: the same options and the same sequence of sends give the same deliveries.
 *  - Every message is encoded exactly as on the real wire (encodeInputPacket / JSON), so receivers get copies.
 *  - 'inputs': one-way latency + uniform jitter 0..jitterMs (which reorders packets), dropped with `loss`, delivered
 *    twice with `duplicate`, held back an extra `reorderMs` with `reorder`.
 *  - 'control': same latency and jitter but always in order; with `reliableLoss` a message needs a retransmission
 *    (+ retransmitMs) and everything behind it waits (head-of-line blocking, like SCTP).
 *  - `bandwidthBytesPerSec` serialises each direction (a packet occupies the link for bytes / bandwidth).
 *  - The handshake mirrors transport.ts: the guest's open() rejects 'code-not-found' when no host has opened that
 *    code, 'version-mismatch' when hostVersion !== guestVersion, or `guestOpenError` when set.
 *  - Each endpoint runs the '$ping' meter every pingIntervalMs while open (rtt, jitter, 'rtt' events).
 *  - sever() drops the link: both sides get 'disconnected'; the host waits for a rejoin ('connecting'), the guest is
 *    'closed' and may reconnect().
 */
import { createRttMeter, NET_PING_INTERVAL_MS, type RttMeter } from './adaptive';
import {
  createEmitter, decodeInputPacket, encodeInputPacket, NET_PROTOCOL_VERSION, netError, parseControl,
} from './packet';
import type {
  ControlMessage, InputPacket, NetErrorReason, NetRole, NetTransport, TransportEvent, TransportState,
} from './types';

export interface MemoryLinkOptions {
  /** One-way latency, ms (default 0). */
  latencyMs?: number;
  /** Random extra delay 0..jitterMs, ms (default 0). */
  jitterMs?: number;
  /** Probability 0..1 that an 'inputs' packet is dropped (the reliable channel never drops). Default 0. */
  loss?: number;
  /** Probability 0..1 that an 'inputs' packet is delivered twice. Default 0. */
  duplicate?: number;
  /** Probability 0..1 that an 'inputs' packet is held back an extra reorderMs. Default 0. */
  reorder?: number;
  /** Extra hold-back for reordered packets, ms (default 40). */
  reorderMs?: number;
  /** Probability 0..1 that a control message needs a retransmission (delayed, never lost). Default 0. */
  reliableLoss?: number;
  /** Retransmission delay, ms (default 2 * latency + jitter + 50). */
  retransmitMs?: number;
  /** Per-direction bandwidth cap, bytes per second (0 = unlimited, the default). */
  bandwidthBytesPerSec?: number;
  /** Seed for the jitter / loss generator, so runs are reproducible. */
  seed?: number;
  /** Ping interval, ms (default 500; 0 = no pings). */
  pingIntervalMs?: number;
  /** Protocol versions announced by each side (default NET_PROTOCOL_VERSION). */
  hostVersion?: string;
  guestVersion?: string;
  /** Make the guest's open() fail with this reason (lobby error screens). */
  guestOpenError?: NetErrorReason;
  /** Clock and scheduler (tests drive time by hand). Default: performance.now / setTimeout. */
  now?(): number;
  schedule?(fn: () => void, delayMs: number): unknown;
}

/** Link conditions that may change mid-run (pair.configure). */
export type MemoryLinkConditions = Pick<MemoryLinkOptions,
  'latencyMs' | 'jitterMs' | 'loss' | 'duplicate' | 'reorder' | 'reorderMs' | 'reliableLoss' | 'retransmitMs' | 'bandwidthBytesPerSec'>;

/** Per-direction counters. */
export interface MemoryLinkStats {
  inputsSent: number;
  inputsDropped: number;
  inputsDuplicated: number;
  inputsReordered: number;
  inputsDelivered: number;
  reliableSent: number;
  reliableRetransmits: number;
  reliableDelivered: number;
  bytesSent: number;
}

/** A connected host / guest pair. Both open() calls resolve once the other side has opened too. */
export interface MemoryTransportPair {
  host: NetTransport;
  guest: NetTransport;
  /** Deliver everything due at the current time (manual scheduling). */
  flush(): void;
  /** Simulate the link dropping: both sides get 'disconnected'. */
  sever(): void;
  /** Change link conditions from now on (in-flight messages keep their times). */
  configure(conditions: MemoryLinkConditions): void;
  /** Counters for host -> guest and guest -> host. */
  readonly stats: { readonly hostToGuest: MemoryLinkStats; readonly guestToHost: MemoryLinkStats };
}

// ---------------------------------------------------------------- manual clock

/** Virtual time for tests and the netsim: timers run only when advance()/advanceTo() is called. */
export interface ManualClock {
  now(): number;
  /** Run `fn` after `delayMs` of virtual time. */
  schedule(fn: () => void, delayMs: number): number;
  setTimeout(fn: () => void, delayMs: number): number;
  clearTimeout(handle: unknown): void;
  /** Move time forward by `ms`, running due timers in time order (each sees now() = its due time). */
  advance(ms: number): void;
  advanceTo(timeMs: number): void;
  /** Due time of the earliest pending timer, or Infinity. */
  nextDue(): number;
  readonly pending: number;
}

interface Timer {
  due: number;
  seq: number;
  fn: () => void;
}

/** Binary min-heap on (due, seq). */
class TimerHeap {
  private readonly a: Timer[] = [];
  get size(): number { return this.a.length; }
  peek(): Timer | undefined { return this.a[0]; }
  push(t: Timer): void {
    const a = this.a;
    a.push(t);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!TimerHeap.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): Timer | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && TimerHeap.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && TimerHeap.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
  clear(): void { this.a.length = 0; }
  private static less(x: Timer, y: Timer): boolean {
    return x.due < y.due || (x.due === y.due && x.seq < y.seq);
  }
}

export function createManualClock(startMs = 0): ManualClock {
  let time = startMs;
  let seq = 0;
  const heap = new TimerHeap();
  const cancelled = new Set<number>();
  const schedule = (fn: () => void, delayMs: number): number => {
    const id = ++seq;
    heap.push({ due: time + (delayMs > 0 ? delayMs : 0), seq: id, fn });
    return id;
  };
  const clock: ManualClock = {
    now: () => time,
    schedule,
    setTimeout: schedule,
    clearTimeout(handle) {
      if (typeof handle === 'number') cancelled.add(handle);
    },
    advance(ms) {
      clock.advanceTo(time + ms);
    },
    advanceTo(t) {
      for (;;) {
        const top = heap.peek();
        if (!top || top.due > t) break;
        heap.pop();
        if (top.due > time) time = top.due;
        if (cancelled.delete(top.seq)) continue;
        top.fn();
      }
      if (t > time) time = t;
    },
    nextDue() {
      for (;;) {
        const top = heap.peek();
        if (!top) return Infinity;
        if (!cancelled.has(top.seq)) return top.due;
        heap.pop();
        cancelled.delete(top.seq);
      }
    },
    get pending() {
      return heap.size;
    },
  };
  return clock;
}

// ---------------------------------------------------------------- seeded link randomness

/** mulberry32: small, fast, seeded (link simulation only; never used by the sim). */
function createLinkRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyStats(): MemoryLinkStats {
  return {
    inputsSent: 0, inputsDropped: 0, inputsDuplicated: 0, inputsReordered: 0, inputsDelivered: 0,
    reliableSent: 0, reliableRetransmits: 0, reliableDelivered: 0, bytesSent: 0,
  };
}

// ---------------------------------------------------------------- pair

interface Endpoint extends NetTransport {
  readonly side: NetRole;
}

interface Delivery {
  due: number;
  seq: number;
  epoch: number;
  fn: () => void;
}

export function createMemoryTransportPair(opts: MemoryLinkOptions = {}): MemoryTransportPair {
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cond: Required<MemoryLinkConditions> = {
    latencyMs: 0, jitterMs: 0, loss: 0, duplicate: 0, reorder: 0, reorderMs: 40, reliableLoss: 0, retransmitMs: -1,
    bandwidthBytesPerSec: 0,
  };
  const configure = (c: MemoryLinkConditions): void => {
    for (const k of Object.keys(c) as (keyof MemoryLinkConditions)[]) {
      const v = c[k];
      if (typeof v === 'number' && Number.isFinite(v)) cond[k] = v;
    }
  };
  configure(opts);
  const seed = (opts.seed ?? 1) >>> 0;
  const pingMs = opts.pingIntervalMs ?? NET_PING_INTERVAL_MS;
  const versions: Record<NetRole, string> = {
    host: opts.hostVersion ?? NET_PROTOCOL_VERSION,
    guest: opts.guestVersion ?? NET_PROTOCOL_VERSION,
  };

  // Delivery queue shared by both directions, ordered by (due, seq).
  const queue: Delivery[] = [];
  let seq = 0;
  let epoch = 0;
  let flushing = false;

  function enqueue(due: number, fn: () => void): void {
    const d: Delivery = { due, seq: ++seq, epoch, fn };
    // Insertion keeps the queue sorted; queues stay short (a few hundred entries at most).
    let i = queue.length;
    while (i > 0 && (queue[i - 1]!.due > due)) i--;
    queue.splice(i, 0, d);
    const wait = due - now();
    schedule(flush, wait > 0 ? wait : 0);
  }

  function flush(): void {
    if (flushing) return;
    flushing = true;
    try {
      const t = now();
      while (queue.length > 0 && queue[0]!.due <= t) {
        const d = queue.shift()!;
        if (d.epoch === epoch) d.fn();
      }
    } finally {
      flushing = false;
    }
  }

  class Direction {
    readonly stats = emptyStats();
    readonly rand: () => number;
    lastReliableDue = 0;
    busyUntil = 0;
    constructor(dirSeed: number) {
      this.rand = createLinkRandom(dirSeed);
    }
    /** Time the message finishes crossing the link, before latency. */
    transmit(bytes: number): number {
      const t = now();
      if (cond.bandwidthBytesPerSec <= 0) return t;
      const start = this.busyUntil > t ? this.busyUntil : t;
      this.busyUntil = start + (bytes * 1000) / cond.bandwidthBytesPerSec;
      return this.busyUntil;
    }
    oneWay(): number {
      return cond.latencyMs + (cond.jitterMs > 0 ? this.rand() * cond.jitterMs : 0);
    }
  }
  const h2g = new Direction(seed ^ 0x9e3779b9);
  const g2h = new Direction(seed ^ 0x85ebca6b);

  function makeEndpoint(side: NetRole): Endpoint & {
    deliverInputs(buf: ArrayBuffer): void;
    deliverControl(json: string): void;
    linkUp(): void;
    linkDown(): void;
    failOpen(reason: NetErrorReason): void;
    readonly opened: boolean;
    readonly code: string;
    closedByUser: boolean;
  } {
    let state: TransportState = 'idle';
    let role: NetRole | null = null;
    let code = '';
    let opened = false;
    let closedByUser = false;
    let openWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
    let reconnectWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const inputs = createEmitter<InputPacket>();
    const reliable = createEmitter<ControlMessage>();
    const events = createEmitter<TransportEvent>();
    const out = side === 'host' ? h2g : g2h;
    let pingEpoch = 0;

    const sendControl = (msg: ControlMessage): void => {
      if (state !== 'open') return;
      const json = JSON.stringify(msg);
      const s = out.stats;
      s.reliableSent++;
      s.bytesSent += json.length;
      let due = out.transmit(json.length) + out.oneWay();
      if (cond.reliableLoss > 0 && out.rand() < cond.reliableLoss) {
        s.reliableRetransmits++;
        due += cond.retransmitMs >= 0 ? cond.retransmitMs : 2 * cond.latencyMs + cond.jitterMs + 50;
      }
      if (due < out.lastReliableDue) due = out.lastReliableDue; // ordered channel
      out.lastReliableDue = due;
      const other = side === 'host' ? guestEp : hostEp;
      enqueue(due, () => other.deliverControl(json));
    };

    const meter: RttMeter = createRttMeter({
      send: sendControl,
      intervalMs: pingMs,
      onSample: (sampleMs) => events.emit({ type: 'rtt', sampleMs }),
    });

    const startPings = (): void => {
      if (pingMs <= 0) return;
      const my = ++pingEpoch;
      const tickPing = (): void => {
        if (my !== pingEpoch || state !== 'open') return;
        meter.pump(now());
        schedule(tickPing, pingMs);
      };
      tickPing();
    };

    const ep = {
      side,
      get state() { return state; },
      get role() { return role; },
      get rtt() { return meter.rttMs; },
      get jitter() { return meter.jitterMs; },
      get opened() { return opened; },
      get code() { return code; },
      get closedByUser() { return closedByUser; },
      set closedByUser(v: boolean) { closedByUser = v; },
      open(r: NetRole, c: string): Promise<void> {
        if (r !== side) return Promise.reject(new Error(`memory transport: the ${side} endpoint must open as '${side}'`));
        if (state !== 'idle') return Promise.reject(new Error('memory transport: open() called twice'));
        role = r;
        code = c;
        state = 'connecting';
        opened = true;
        const p = new Promise<void>((resolve, reject) => {
          openWait = { resolve, reject };
        });
        tryConnect(side);
        return p;
      },
      reconnect(): Promise<void> {
        if (state === 'open') return Promise.resolve();
        if (closedByUser || role === null || state === 'failed') return Promise.reject(netError('disconnected'));
        const p = new Promise<void>((resolve, reject) => {
          reconnectWait = { resolve, reject };
        });
        if (side === 'guest') {
          state = 'connecting';
          tryConnect('guest');
        }
        return p;
      },
      sendInputs(packet: InputPacket): void {
        if (state !== 'open') return;
        const buf = encodeInputPacket(packet);
        const s = out.stats;
        s.inputsSent++;
        s.bytesSent += buf.byteLength;
        const sent = out.transmit(buf.byteLength);
        if (cond.loss > 0 && out.rand() < cond.loss) {
          s.inputsDropped++;
          return;
        }
        const other = side === 'host' ? guestEp : hostEp;
        let due = sent + out.oneWay();
        if (cond.reorder > 0 && out.rand() < cond.reorder) {
          s.inputsReordered++;
          due += cond.reorderMs;
        }
        enqueue(due, () => other.deliverInputs(buf));
        if (cond.duplicate > 0 && out.rand() < cond.duplicate) {
          s.inputsDuplicated++;
          enqueue(sent + out.oneWay(), () => other.deliverInputs(buf));
        }
      },
      sendReliable: sendControl,
      onInputs: (fn: (p: InputPacket) => void) => inputs.on(fn),
      onReliable: (fn: (m: ControlMessage) => void) => reliable.on(fn),
      onEvent: (fn: (e: TransportEvent) => void) => events.on(fn),
      close(): void {
        if (state === 'closed' && closedByUser) return;
        const wasOpen = state === 'open';
        closedByUser = true;
        state = 'closed';
        pingEpoch++;
        settleWaits(netError('disconnected'));
        if (wasOpen) {
          const other = side === 'host' ? guestEp : hostEp;
          const myEpoch = epoch;
          enqueue(now() + cond.latencyMs, () => {
            if (myEpoch === epoch) {
              epoch++;
              other.linkDown();
            }
          });
        }
      },
      deliverInputs(buf: ArrayBuffer): void {
        if (state !== 'open') return;
        const p = decodeInputPacket(buf);
        if (!p) return;
        (side === 'host' ? g2h : h2g).stats.inputsDelivered++;
        inputs.emit(p);
      },
      deliverControl(json: string): void {
        if (state !== 'open') return;
        const msg = parseControl(json);
        if (!msg) return;
        (side === 'host' ? g2h : h2g).stats.reliableDelivered++;
        if (meter.handle(msg, now())) return;
        if (msg.type.charCodeAt(0) === 36 /* $ */) return;
        reliable.emit(msg);
      },
      linkUp(): void {
        if (closedByUser) return;
        state = 'open';
        meter.reset();
        events.emit({ type: 'connected' });
        const w = openWait ?? reconnectWait;
        openWait = null;
        reconnectWait = null;
        startPings();
        w?.resolve();
      },
      linkDown(): void {
        if (state !== 'open') return;
        pingEpoch++;
        state = side === 'host' ? 'connecting' : 'closed';
        events.emit({ type: 'disconnected', reason: 'disconnected' });
      },
      failOpen(reason: NetErrorReason): void {
        state = 'failed';
        events.emit({ type: 'error', reason });
        const w = openWait ?? reconnectWait;
        openWait = null;
        reconnectWait = null;
        w?.reject(netError(reason));
      },
    };

    function settleWaits(err: Error): void {
      const ws = [openWait, reconnectWait];
      openWait = null;
      reconnectWait = null;
      for (const w of ws) w?.reject(err);
    }

    return ep;
  }

  const hostEp = makeEndpoint('host');
  const guestEp = makeEndpoint('guest');

  /** Called when either side opens or the guest re-dials. */
  function tryConnect(who: NetRole): void {
    if (who === 'host') {
      // A host only waits; a guest that already dialled this code before the host existed has failed already.
      return;
    }
    const dialEpoch = epoch;
    enqueue(now() + cond.latencyMs, () => {
      if (dialEpoch !== epoch || guestEp.state !== 'connecting') return;
      if (opts.guestOpenError) {
        guestEp.failOpen(opts.guestOpenError);
        return;
      }
      if (!hostEp.opened || hostEp.state !== 'connecting' || hostEp.code !== guestEp.code) {
        guestEp.failOpen(hostEp.state === 'open' ? 'room-full' : 'code-not-found');
        return;
      }
      // Handshake: both '$hello' messages cross the link (one more one-way trip).
      enqueue(now() + cond.latencyMs, () => {
        if (dialEpoch !== epoch) return;
        if (versions.host !== versions.guest) {
          hostEp.failOpen('version-mismatch');
          guestEp.failOpen('version-mismatch');
          return;
        }
        h2g.lastReliableDue = 0;
        g2h.lastReliableDue = 0;
        hostEp.linkUp();
        guestEp.linkUp();
      });
    });
  }

  return {
    host: hostEp,
    guest: guestEp,
    flush,
    sever() {
      epoch++;
      queue.length = 0;
      hostEp.linkDown();
      guestEp.linkDown();
    },
    configure,
    stats: { hostToGuest: h2g.stats, guestToHost: g2h.stats },
  };
}

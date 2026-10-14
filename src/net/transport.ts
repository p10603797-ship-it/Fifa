/**
 * [NET-02] PeerJS transport: one unordered channel ('inputs', binary InputPackets) and one reliable ordered channel
 * ('control', JSON strings, fragmented when long) per connection. Only src/net imports peerjs, and only through a
 * dynamic import inside open(): nothing touches the network at module load.
 *
 *   const t = createPeerTransport(NET_CONFIG);
 *   t.onEvent((e) => ...);                       // 'connected' | 'disconnected' | 'error' | 'rtt'
 *   await t.open('host', 'ABCDEF');              // peer id = NET_CONFIG.peerPrefix + code; resolves when a guest joins
 *   await t.open('guest', 'ABCDEF');             // dials the host; rejects with Error(NetErrorReason)
 *
 * Connection sequence
 *  1. Peer registered with the broker (host: id prefix + code; guest: broker-assigned id). brokerTimeoutMs without
 *     'open' -> 'broker-unreachable'.
 *  2. The guest dials two DataConnections to the host: label 'control' { reliable: true, serialization: 'raw' } and
 *     label 'inputs' { reliable: false (unordered), serialization: 'raw' }. Both must open within connectTimeoutMs,
 *     else 'blocked' (ICE failure: different networks without a usable relay). PeerJS errors map through
 *     mapPeerError (peer-unavailable -> 'code-not-found', network -> 'broker-unreachable', webrtc -> 'blocked' ...).
 *  3. Both sides send '$hello' { v: NET_PROTOCOL_VERSION } on 'control'; different versions -> 'version-mismatch'
 *     on both sides. A second guest gets '$full' and its open() rejects 'room-full'.
 *  4. Open: '$ping' / '$pong' every pingIntervalMs (rtt, jitter, 'rtt' events); silence for silenceTimeoutMs or a
 *     closed channel -> 'disconnected'. A host then waits for the guest to rejoin (state 'connecting', same room id,
 *     re-registering with the broker after brokerRetryMs if the broker dropped it); a guest is 'closed' and may call
 *     reconnect() to dial the same room again.
 *
 * Tests inject `createPeer` (a fake Peer / DataConnection pair, no network) and `timers` (a manual clock).
 */
import { createRttMeter, type RttMeter } from './adaptive';
import type { NetConfig } from './config';
import {
  createControlCodec, createEmitter, CTRL_FULL, CTRL_HELLO, decodeInputPacket, encodeInputPacket, NET_PROTOCOL_VERSION,
  netError, type ControlCodec,
} from './packet';
import type {
  ControlMessage, InputPacket, NetErrorReason, NetRole, NetTransport, TransportEvent, TransportState,
} from './types';

export type { ControlMessage, InputPacket, NetErrorReason, NetRole, NetTransport, TransportEvent, TransportState } from './types';

/** PeerJS-compatible error object (PeerError has `type`). */
export interface PeerErrorLike {
  type?: string;
  message?: string;
}

/** The subset of PeerJS DataConnection the transport uses. */
export interface DataConnectionLike {
  readonly peer: string;
  readonly label: string;
  readonly open: boolean;
  on(event: 'open' | 'close' | 'data' | 'error', fn: (arg: never) => void): unknown;
  send(data: unknown): unknown;
  close(): void;
}

/** The subset of PeerJS Peer the transport uses. */
export interface PeerLike {
  readonly destroyed: boolean;
  readonly disconnected: boolean;
  on(event: 'open' | 'connection' | 'disconnected' | 'close' | 'error', fn: (arg: never) => void): unknown;
  connect(peerId: string, options: { label: string; reliable: boolean; serialization: string }): DataConnectionLike;
  reconnect(): void;
  destroy(): void;
}

/** Options handed to the Peer constructor (only defined keys: PeerJS defaults fill the rest). */
export interface PeerOptionsLike {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  debug?: number;
  config?: { iceServers: RTCIceServer[] };
}

export type PeerFactory = (id: string | undefined, options: PeerOptionsLike) => PeerLike | Promise<PeerLike>;

/** Timer functions (defaults: performance.now / setTimeout / clearTimeout). */
export interface TransportTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PeerTransportDeps {
  createPeer?: PeerFactory;
  timers?: TransportTimers;
  /** Protocol version announced in the handshake (default NET_PROTOCOL_VERSION). */
  version?: string;
  /** Explicit peer id to host under / dial instead of NetConfig.peerPrefix + code. */
  peerId?: string;
}

/** PeerJS error type -> plain-language reason. `phase` is what was happening when it arrived. */
export function mapPeerError(type: string | undefined, phase: 'broker' | 'dial' | 'open'): NetErrorReason {
  switch (type) {
    case 'peer-unavailable':
    case 'invalid-id':
      return 'code-not-found';
    case 'unavailable-id':
      return 'code-taken';
    case 'browser-incompatible':
      return 'unsupported';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable':
    case 'invalid-key':
    case 'disconnected':
      return 'broker-unreachable';
    case 'webrtc':
    case 'negotiation-failed':
      return 'blocked';
    case 'connection-closed':
      return 'disconnected';
    default:
      return phase === 'broker' ? 'broker-unreachable' : phase === 'dial' ? 'blocked' : 'disconnected';
  }
}

/** Peer constructor options from a NetConfig (undefined keys are left out so PeerJS defaults apply). */
export function peerOptions(config: NetConfig): PeerOptionsLike {
  const o: PeerOptionsLike = { debug: config.debug };
  if (config.host !== undefined) o.host = config.host;
  if (config.port !== undefined) o.port = config.port;
  if (config.path !== undefined) o.path = config.path;
  if (config.secure !== undefined) o.secure = config.secure;
  if (config.iceServers !== undefined) o.config = { iceServers: config.iceServers };
  return o;
}

/** Loads peerjs on first use (dynamic import: no network or WebRTC work at module load). */
const defaultPeerFactory: PeerFactory = async (id, options) => {
  const mod = await import('peerjs');
  const Ctor = mod.Peer;
  return (id === undefined ? new Ctor(options) : new Ctor(id, options)) as unknown as PeerLike;
};

const defaultTimers: TransportTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Link {
  peerId: string;
  control: DataConnectionLike | null;
  inputs: DataConnectionLike | null;
  controlOpen: boolean;
  inputsOpen: boolean;
  helloSent: boolean;
  established: boolean;
  dead: boolean;
  codec: ControlCodec;
  timer: unknown;
}

type Wait = { resolve: () => void; reject: (e: Error) => void };

/** A PeerJS-backed transport; call open('host', code) or open('guest', code) to connect. */
export function createPeerTransport(config: NetConfig, deps: PeerTransportDeps = {}): NetTransport {
  const createPeer = deps.createPeer ?? defaultPeerFactory;
  const timers = deps.timers ?? defaultTimers;
  const version = deps.version ?? NET_PROTOCOL_VERSION;

  let state: TransportState = 'idle';
  let role: NetRole | null = null;
  let targetId = '';
  let peer: PeerLike | null = null;
  let brokerOpen = false;
  let link: Link | null = null;
  let openWait: Wait | null = null;
  let reconnectWait: Wait | null = null;
  let brokerTimer: unknown = null;
  let pingTimer: unknown = null;
  let retryTimer: unknown = null;
  let lastHeard = 0;
  let closed = false;

  const inputs = createEmitter<InputPacket>();
  const reliable = createEmitter<ControlMessage>();
  const events = createEmitter<TransportEvent>();

  const meter: RttMeter = createRttMeter({
    send: (m) => sendControl(link, m),
    intervalMs: config.pingIntervalMs,
    onSample: (sampleMs) => events.emit({ type: 'rtt', sampleMs }),
  });

  function clear(h: unknown): null {
    if (h !== null) timers.clearTimeout(h);
    return null;
  }

  function sendControl(l: Link | null, msg: ControlMessage): void {
    if (!l || l.dead || !l.control || !l.controlOpen) return;
    const parts = l.codec.encode(msg);
    try {
      for (const p of parts) l.control.send(p);
    } catch {
      // A failing send means the channel is going down; the close event follows.
    }
  }

  function settle(err: Error | null): void {
    const w = openWait ?? reconnectWait;
    openWait = null;
    reconnectWait = null;
    if (!w) return;
    if (err) w.reject(err);
    else w.resolve();
  }

  /** Opening failed for good: report, reject, tear down. */
  function fail(reason: NetErrorReason, detail?: string): void {
    if (closed || state === 'failed') return;
    state = 'failed';
    events.emit(detail === undefined ? { type: 'error', reason } : { type: 'error', reason, detail });
    settle(netError(reason));
    teardown();
  }

  function dropLink(l: Link): void {
    // Detach first: closing a channel fires 'close' synchronously, which must not re-enter linkLost for this link.
    l.dead = true;
    if (link === l) link = null;
    l.timer = clear(l.timer);
    l.codec.reset();
    for (const c of [l.control, l.inputs]) {
      try {
        c?.close();
      } catch {
        // already closed
      }
    }
  }

  function teardown(): void {
    brokerTimer = clear(brokerTimer);
    pingTimer = clear(pingTimer);
    retryTimer = clear(retryTimer);
    if (link) dropLink(link);
    const p = peer;
    peer = null;
    try {
      p?.destroy();
    } catch {
      // ignore
    }
  }

  /** The established link went away. */
  function linkLost(l: Link): void {
    if (link !== l) return;
    const wasEstablished = l.established;
    dropLink(l);
    if (closed || state === 'failed') return;
    if (!wasEstablished) {
      if (role === 'guest') fail('blocked', 'channel closed before the handshake');
      return;
    }
    pingTimer = clear(pingTimer);
    state = role === 'host' ? 'connecting' : 'closed';
    events.emit({ type: 'disconnected', reason: 'disconnected' });
  }

  function established(l: Link): void {
    l.established = true;
    l.timer = clear(l.timer);
    state = 'open';
    lastHeard = timers.now();
    meter.reset();
    events.emit({ type: 'connected' });
    settle(null);
    schedulePing();
  }

  function schedulePing(): void {
    pingTimer = clear(pingTimer);
    const period = config.pingIntervalMs > 0 ? config.pingIntervalMs : 1000;
    pingTimer = timers.setTimeout(() => {
      pingTimer = null;
      const l = link;
      if (!l || !l.established || state !== 'open') return;
      const now = timers.now();
      if (now - lastHeard > config.silenceTimeoutMs) {
        linkLost(l);
        return;
      }
      meter.pump(now);
      schedulePing();
    }, period);
  }

  function onControlData(l: Link, raw: unknown): void {
    if (l.dead) return;
    lastHeard = timers.now();
    const msg = l.codec.decode(raw);
    if (!msg) return;
    if (msg.type === CTRL_HELLO) {
      if (l.established) return;
      if (msg.v !== version) {
        sendHello(l);
        fail('version-mismatch', `local ${version}, remote ${String(msg.v)}`);
        return;
      }
      sendHello(l);
      established(l);
      return;
    }
    if (msg.type === CTRL_FULL) {
      if (role === 'guest' && !l.established) fail('room-full');
      return;
    }
    if (!l.established) return;
    if (meter.handle(msg, timers.now())) return;
    if (msg.type.charCodeAt(0) === 36 /* $ */) return;
    reliable.emit(msg);
  }

  function onInputsData(l: Link, raw: unknown): void {
    if (l.dead || !l.established) return;
    lastHeard = timers.now();
    const p = decodeInputPacket(raw);
    if (p) inputs.emit(p);
  }

  function sendHello(l: Link): void {
    if (l.helloSent) return;
    l.helloSent = true;
    sendControl(l, { type: CTRL_HELLO, v: version });
  }

  function channelOpened(l: Link): void {
    if (l.dead || !l.controlOpen || !l.inputsOpen) return;
    // Channels up: the handshake has handshakeTimeoutMs from here.
    l.timer = clear(l.timer);
    l.timer = timers.setTimeout(() => {
      l.timer = null;
      if (l.dead || l.established) return;
      if (role === 'guest') fail('version-mismatch', 'no handshake');
      else dropLink(l);
    }, config.handshakeTimeoutMs);
    sendHello(l);
  }

  function attach(l: Link, conn: DataConnectionLike): void {
    const isControl = conn.label === 'control';
    if (isControl) l.control = conn;
    else l.inputs = conn;
    conn.on('open', () => {
      if (l.dead) return;
      if (isControl) l.controlOpen = true;
      else l.inputsOpen = true;
      channelOpened(l);
    });
    conn.on('data', (raw: unknown) => {
      if (isControl) onControlData(l, raw);
      else onInputsData(l, raw);
    });
    conn.on('close', () => linkLost(l));
    conn.on('error', (err: PeerErrorLike) => {
      if (l.established) linkLost(l);
      else if (role === 'guest') fail(mapPeerError(err?.type, 'dial'), err?.message);
      else dropLink(l);
    });
    if (conn.open) {
      if (isControl) l.controlOpen = true;
      else l.inputsOpen = true;
      channelOpened(l);
    }
  }

  function newLink(peerId: string): Link {
    const l: Link = {
      peerId, control: null, inputs: null, controlOpen: false, inputsOpen: false, helloSent: false, established: false,
      dead: false, codec: createControlCodec(), timer: null,
    };
    l.timer = timers.setTimeout(() => {
      l.timer = null;
      if (l.dead || l.controlOpen && l.inputsOpen) return;
      if (role === 'guest') fail('blocked', 'data channels did not open');
      else {
        events.emit({ type: 'error', reason: 'blocked', detail: 'a guest could not connect' });
        dropLink(l);
      }
    }, config.connectTimeoutMs);
    return l;
  }

  /** Host: a guest dialled one of its channels. */
  function onConnection(conn: DataConnectionLike): void {
    if (closed || !peer) return;
    if (link && !link.dead && link.peerId !== conn.peer) {
      // Someone else already holds the room: tell them and hang up.
      const refuse = (): void => {
        try {
          if (conn.label === 'control') conn.send(JSON.stringify({ type: CTRL_FULL }));
        } catch {
          // ignore
        }
        timers.setTimeout(() => conn.close(), 1000);
      };
      if (conn.open) refuse();
      else conn.on('open', refuse);
      return;
    }
    if (!link || link.dead) link = newLink(conn.peer);
    attach(link, conn);
  }

  /** Guest: dial both channels of the host. */
  function dial(): void {
    if (!peer || closed) return;
    const l = newLink(targetId);
    link = l;
    try {
      attach(l, peer.connect(targetId, { label: 'control', reliable: true, serialization: 'raw' }));
      attach(l, peer.connect(targetId, { label: 'inputs', reliable: false, serialization: 'raw' }));
    } catch (err) {
      fail('blocked', err instanceof Error ? err.message : String(err));
    }
  }

  function onPeerError(err: PeerErrorLike): void {
    if (closed) return;
    const type = err?.type;
    const phase = !brokerOpen ? 'broker' : link && link.established ? 'open' : 'dial';
    const reason = mapPeerError(type, phase);
    if (state === 'connecting' && (openWait || role === 'guest')) {
      if (role === 'host' && phase !== 'broker' && reason !== 'code-taken' && reason !== 'unsupported') {
        // Host already registered: a failing guest attempt or a broker hiccup must not close the room.
        events.emit({ type: 'error', reason, detail: err?.message });
        scheduleBrokerRetry();
        return;
      }
      if (role === 'guest' && reconnectWait && !openWait) {
        state = 'closed';
        events.emit({ type: 'error', reason, detail: err?.message });
        settle(netError(reason));
        return;
      }
      fail(reason, err?.message);
      return;
    }
    // Open (or a host waiting for a rejoin): broker trouble does not end a peer-to-peer match.
    if (reason === 'broker-unreachable') scheduleBrokerRetry();
  }

  function scheduleBrokerRetry(): void {
    if (role !== 'host' || retryTimer !== null || closed) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (peer && !peer.destroyed && peer.disconnected && !closed) {
        try {
          peer.reconnect();
        } catch {
          scheduleBrokerRetry();
        }
      }
    }, config.brokerRetryMs);
  }

  async function startPeer(): Promise<void> {
    let p: PeerLike;
    try {
      p = await createPeer(role === 'host' ? targetId : undefined, peerOptions(config));
    } catch (err) {
      fail('unsupported', err instanceof Error ? err.message : String(err));
      return;
    }
    if (closed || state === 'failed') {
      p.destroy();
      return;
    }
    peer = p;
    p.on('open', () => {
      brokerTimer = clear(brokerTimer);
      retryTimer = clear(retryTimer);
      const first = !brokerOpen;
      brokerOpen = true;
      if (role === 'guest' && state === 'connecting' && (first || !link)) dial();
    });
    p.on('connection', (conn: DataConnectionLike) => {
      if (role === 'host') onConnection(conn);
      else conn.close();
    });
    p.on('error', (err: PeerErrorLike) => onPeerError(err));
    p.on('disconnected', () => {
      if (closed) return;
      if (!brokerOpen) fail('broker-unreachable');
      else scheduleBrokerRetry();
    });
    p.on('close', () => {
      if (closed || state === 'failed') return;
      if (state === 'connecting') fail(brokerOpen ? 'disconnected' : 'broker-unreachable');
    });
  }

  const transport: NetTransport = {
    get state() { return state; },
    get role() { return role; },
    get rtt() { return meter.rttMs; },
    get jitter() { return meter.jitterMs; },
    open(r, code) {
      if (state !== 'idle') return Promise.reject(new Error('open() called twice'));
      role = r;
      targetId = deps.peerId ?? config.peerPrefix + code;
      state = 'connecting';
      const p = new Promise<void>((resolve, reject) => {
        openWait = { resolve, reject };
      });
      brokerTimer = timers.setTimeout(() => {
        brokerTimer = null;
        if (!brokerOpen) fail('broker-unreachable', 'broker timeout');
      }, config.brokerTimeoutMs);
      void startPeer();
      return p;
    },
    reconnect() {
      if (state === 'open') return Promise.resolve();
      if (closed || role === null || state === 'failed' || state === 'idle') return Promise.reject(netError('disconnected'));
      const p = new Promise<void>((resolve, reject) => {
        const prev = reconnectWait;
        reconnectWait = {
          resolve: () => { prev?.resolve(); resolve(); },
          reject: (e) => { prev?.reject(e); reject(e); },
        };
      });
      if (role === 'guest' && state === 'closed') {
        state = 'connecting';
        if (peer && !peer.destroyed && !peer.disconnected) dial();
        else if (peer && !peer.destroyed) {
          try {
            peer.reconnect(); // 'open' fires again and dials
          } catch {
            state = 'closed';
            settle(netError('broker-unreachable'));
          }
        } else {
          state = 'closed';
          settle(netError('disconnected'));
        }
      }
      return p;
    },
    sendInputs(packet) {
      const l = link;
      if (state !== 'open' || !l || !l.established || !l.inputs || !l.inputsOpen) return;
      try {
        l.inputs.send(encodeInputPacket(packet));
      } catch {
        // channel going down; the close event follows
      }
    },
    sendReliable(message) {
      if (state !== 'open' || !link || !link.established) return;
      sendControl(link, message);
    },
    onInputs: (fn) => inputs.on(fn),
    onReliable: (fn) => reliable.on(fn),
    onEvent: (fn) => events.on(fn),
    close() {
      if (closed) return;
      closed = true;
      const wasActive = state === 'connecting' || state === 'open';
      state = 'closed';
      if (wasActive) {
        const w = openWait ?? reconnectWait;
        openWait = null;
        reconnectWait = null;
        w?.reject(netError('disconnected'));
      }
      teardown();
    },
  };
  return transport;
}

/** Host a room under `peerId` (call open('host', anyCode); the code is ignored). */
export function createHostTransport(config: NetConfig, peerId: string, deps: PeerTransportDeps = {}): NetTransport {
  return createPeerTransport(config, { ...deps, peerId });
}

/** Join the host `peerId` (call open('guest', anyCode); the code is ignored). */
export function createGuestTransport(config: NetConfig, peerId: string, deps: PeerTransportDeps = {}): NetTransport {
  return createPeerTransport(config, { ...deps, peerId });
}

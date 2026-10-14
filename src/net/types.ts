/**
 * [NET-02] Network transport types shared inside src/net (lockstep, lobby, session, desync, memory transport).
 * Type-only: importing it never touches the network. Nothing outside src/net may import it (brief section 11:
 * local play works with src/net removed).
 *
 * Two channels per connection:
 *  - 'inputs'  (unordered, unreliable where the browser allows it): InputPacket, each repeating up to
 *    T_NET.redundancy frames so a lost packet needs no resend (src/net/adaptive.ts builds and reads them).
 *  - 'control' (reliable, ordered): ControlMessage for lobby, pause, resync, state hashes and delay changes.
 *
 * Who builds what on top of the transport (module map, all in src/net):
 *  - packet.ts         wire codecs: InputPacket <-> bytes, control messages <-> string fragments, version string.
 *  - transport.ts      PeerJS NetTransport (createPeerTransport / createHostTransport / createGuestTransport).
 *  - memoryTransport.ts in-memory NetTransport pair with a seeded lossy link and a manual clock (tests, netsim).
 *  - adaptive.ts       RTT estimator + ping meter, adaptive input delay (2..8) with an agreed switch tick, frame ring
 *                      and the redundant packet encoder / de-duplicating decoder.
 *  - desync.ts         hash exchange every 30 ticks, mismatch detection, snapshot resync (host -> guest).
 *  - lockstep.ts       the TickInputProvider for online play (uses all of the above).
 *
 * Control message `type` namespaces (keep them apart so several modules can share one channel):
 *  - '$...'    transport-internal ('$hello', '$full', '$ping', '$pong', '$frag'); never delivered to onReliable.
 *  - 'ls:...'  lockstep, adaptive delay and desync guard ('ls:delay', 'ls:target', 'ls:hash', 'ls:snap', 'ls:snap-ok').
 *  - 'lobby:...' NET-03 lobby, 'session:...' NET-06 session (pause, resume, rejoin, finish).
 * Every subscriber sees every non-'$' message and must ignore types it does not own.
 */

/** Which side of the room this peer is. The host owns the match settings and is the resync authority. */
export type NetRole = 'host' | 'guest';

/**
 * Connection lifecycle:
 *  idle -> connecting (open() called) -> open (both channels up, versions agreed) -> closed (close() or peer gone)
 *  or -> failed (open() rejected). A host whose guest drops goes back to 'connecting' while it waits for a rejoin.
 */
export type TransportState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

/**
 * Plain-language failure reasons, mapped from PeerJS errors and the version handshake (screens show one sentence
 * per reason; NET-07):
 *  - 'broker-unreachable'  the PeerJS broker (signalling server) cannot be reached (offline, blocked, down).
 *  - 'code-not-found'      no room with that code (PeerJS 'peer-unavailable' / 'invalid-id').
 *  - 'room-full'           the room already has a guest.
 *  - 'version-mismatch'    the two builds differ (handshake on the control channel).
 *  - 'blocked'             the peer-to-peer connection never opened (ICE failure / timeout: suggest the same Wi-Fi
 *                          or a phone hotspot).
 *  - 'disconnected'        the other side went away (closed, crashed, or silent for NetConfig.silenceTimeoutMs).
 *  - 'code-taken'          host only: another room already uses this code (PeerJS 'unavailable-id'); pick a new code.
 *  - 'unsupported'         this browser lacks WebRTC data channels (PeerJS 'browser-incompatible').
 */
export type NetErrorReason =
  | 'broker-unreachable' | 'code-not-found' | 'room-full' | 'version-mismatch' | 'blocked' | 'disconnected'
  | 'code-taken' | 'unsupported';

/**
 * One input packet: the sender's own frames for ticks firstTick .. firstTick + count - 1. Each frame is FRAME_INTS
 * (= INPUT_FIELDS.length) int16 values encoded like packFrames (src/sim/core/serialize.ts) encodes one human; see
 * packSenderFrame / unpackSenderFrame in packet.ts. On the wire (encodeInputPacket) a 24-byte header carries
 * magic, firstTick, count, ack, tick and adv, followed by the int16 data (little-endian).
 */
export interface InputPacket {
  /** Tick of the first frame in `data`. */
  firstTick: number;
  /** Frames in the packet (1 .. MAX_PACKET_FRAMES): the newest plus up to T_NET.redundancy - 1 repeated ones. */
  count: number;
  /**
   * Newest tick up to which this side has received every frame of the other side (contiguous). The other side
   * starts its catch-up resends after it. -1 before anything arrived.
   */
  ack: number;
  /** The sender's latest simulated tick when it sent the packet (time sync). */
  tick: number;
  /**
   * The sender's smoothed raw frame advantage in ticks (its tick minus our tick as seen in our packets), carried as
   * 1/16 tick on the wire. Each side halves (own - other's) to learn how far ahead it runs (adaptive.ts TimeSync).
   */
  adv: number;
  /** At least count * FRAME_INTS values (extra values are ignored). Receivers copy what they keep (senders reuse it). */
  data: Int16Array;
}

/** Reliable-channel message (lobby, pause, resync, hash). Plain JSON data; `type` selects the handler. */
export interface ControlMessage {
  type: string;
  [field: string]: unknown;
}

/** Transport events with typed reasons. */
export type TransportEvent =
  /** Both channels are open and the versions agree (also fired again after a successful rejoin). */
  | { type: 'connected' }
  /** The other side went away. A host keeps listening for a rejoin (state 'connecting'); a guest is 'closed'. */
  | { type: 'disconnected'; reason: NetErrorReason }
  /**
   * A failure. Fatal when the state becomes 'failed' (open() / reconnect() rejects with the same reason); otherwise
   * informational (e.g. a host whose would-be guest was 'blocked' keeps the room open).
   */
  | { type: 'error'; reason: NetErrorReason; detail?: string }
  /** One raw round-trip sample from the transport's ping meter (every NetConfig.pingIntervalMs). */
  | { type: 'rtt'; sampleMs: number };

/** One peer-to-peer connection (PeerJS in transport.ts, in-memory pair in memoryTransport.ts for tests). */
export interface NetTransport {
  readonly state: TransportState;
  /** Set by open(); null before. */
  readonly role: NetRole | null;
  /** Smoothed round-trip time, ms (0 until measured). Measured with '$ping' / '$pong' on the control channel. */
  readonly rtt: number;
  /** Round-trip jitter estimate (smoothed mean deviation), ms (0 until measured). */
  readonly jitter: number;
  /**
   * Host a room (peer id = NetConfig.peerPrefix + code) or join one. Resolves once both channels are open and the
   * versions agree; rejects with an Error whose message is a NetErrorReason. No network use before this call.
   * A host's open() stays pending until a guest joins.
   */
  open(role: NetRole, code: string): Promise<void>;
  /**
   * After a 'disconnected' event: a guest dials the same room again; a host waits for a guest to rejoin. Resolves
   * on 'connected', rejects with a NetErrorReason (e.g. 'code-not-found' once the host has gone too).
   */
  reconnect(): Promise<void>;
  /** Unordered 'inputs' channel. Dropped silently when not open. */
  sendInputs(packet: InputPacket): void;
  /** Reliable, ordered 'control' channel; any size (the transport fragments large messages). Dropped when not open. */
  sendReliable(message: ControlMessage): void;
  /** Subscribe; each returns its unsubscribe function. */
  onInputs(fn: (packet: InputPacket) => void): () => void;
  onReliable(fn: (message: ControlMessage) => void): () => void;
  onEvent(fn: (event: TransportEvent) => void): () => void;
  /** Close both channels and the peer; idempotent. The other side gets 'disconnected'. */
  close(): void;
}

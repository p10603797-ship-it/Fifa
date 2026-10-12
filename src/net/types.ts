/**
 * [NET-02] Network transport types shared inside src/net (lockstep, lobby, session, desync, memory transport).
 * WAVE 0 STUB (FND-04): NET-02 owns and finalises this file. Type-only: importing it never touches the network.
 * Nothing outside src/net may import it (brief section 11: local play works with src/net removed).
 *
 * Two channels per connection: 'inputs' (unreliable, unordered: input packets, each repeating the last
 * T_NET.redundancy frames) and 'control' (reliable, ordered: lobby, pause, resync, state hashes).
 */

/** Which side of the room this peer is. The host owns the match settings. */
export type NetRole = 'host' | 'guest';

/** Connection lifecycle. */
export type TransportState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

/**
 * Plain-language failure reasons, mapped from PeerJS errors and the version handshake:
 * broker unreachable, code not found (peer-unavailable), room full, version mismatch, connection blocked (ICE
 * failure timeout), and the peer going away mid-match.
 */
export type NetErrorReason = 'broker-unreachable' | 'code-not-found' | 'room-full' | 'version-mismatch' | 'blocked' | 'disconnected';

/**
 * One input packet: the sender's frames for ticks firstTick .. firstTick + count - 1, packed with packFrames
 * (src/sim/core/serialize.ts, PACKED_FRAME_INTS Int16 values per frame).
 */
export interface InputPacket {
  /** Tick of the first frame in `data`. */
  firstTick: number;
  /** Frames in the packet: the newest plus up to T_NET.redundancy - 1 repeated ones. */
  count: number;
  /** Newest tick this side has received from the other side (acknowledgement, round-trip time). */
  ack: number;
  /** count * PACKED_FRAME_INTS values. */
  data: Int16Array;
}

/** Reliable-channel message (lobby, pause, resync, hash). Plain JSON data; `type` selects the handler. */
export interface ControlMessage {
  type: string;
  [field: string]: unknown;
}

/** Transport events with typed reasons. */
export type TransportEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: NetErrorReason }
  | { type: 'error'; reason: NetErrorReason; detail?: string };

/** One peer-to-peer connection (PeerJS in transport.ts, in-memory pair in memoryTransport.ts for tests). */
export interface NetTransport {
  readonly state: TransportState;
  /** Set by open(); null before. */
  readonly role: NetRole | null;
  /** Smoothed round-trip time, ms (0 until measured). */
  readonly rtt: number;
  /**
   * Host a room (peer id = NetConfig.peerPrefix + code) or join one. Resolves once both channels are open;
   * rejects with an Error whose message is a NetErrorReason. No network use before this call.
   */
  open(role: NetRole, code: string): Promise<void>;
  /** Unreliable, unordered 'inputs' channel. */
  sendInputs(packet: InputPacket): void;
  /** Reliable, ordered 'control' channel. */
  sendReliable(message: ControlMessage): void;
  /** Subscribe; each returns its unsubscribe function. */
  onInputs(fn: (packet: InputPacket) => void): () => void;
  onReliable(fn: (message: ControlMessage) => void): () => void;
  onEvent(fn: (event: TransportEvent) => void): () => void;
  /** Close both channels and the peer; idempotent. */
  close(): void;
}

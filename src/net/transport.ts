/**
 * [NET-02] PeerJS transport: one unordered/unreliable channel ('inputs') for input packets and one reliable
 * channel ('control') for lobby, pause and resync messages. WAVE 0 STUB (FND-04): factories throw until NET-02
 * lands. Only src/net imports peerjs, and never at module load.
 * The NetTransport interface lives in ./types (re-exported here for existing importers).
 */
import type { NetConfig } from './config';
import type { NetTransport } from './types';

export type { ControlMessage, InputPacket, NetErrorReason, NetRole, NetTransport, TransportEvent, TransportState } from './types';

/** A PeerJS-backed transport; call open('host', code) or open('guest', code) to connect. */
export function createPeerTransport(config: NetConfig): NetTransport {
  void config;
  throw new Error('not implemented (NET-02)');
}

/** Host a room under `peerId`. */
export function createHostTransport(config: NetConfig, peerId: string): NetTransport {
  void config;
  void peerId;
  throw new Error('not implemented (NET-02)');
}

/** Join the host `peerId`. */
export function createGuestTransport(config: NetConfig, peerId: string): NetTransport {
  void config;
  void peerId;
  throw new Error('not implemented (NET-02)');
}

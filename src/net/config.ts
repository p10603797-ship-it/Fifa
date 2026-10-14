/**
 * [NET-02] Network configuration: PeerJS broker and ICE servers in one object so a self-hosted PeerServer can
 * replace the defaults (brief section 11). No keys anywhere: the public PeerJS cloud broker needs none.
 *
 *   NET_CONFIG                         the defaults (free public PeerJS broker, PeerJS default ICE servers)
 *   createNetConfig({ host: 'peer.example.org', port: 9000, path: '/dotkick', secure: true })
 *                                      a self-hosted PeerServer (everything not given keeps the default)
 *
 * iceServers undefined means "PeerJS defaults" (one public STUN server plus the PeerJS public TURN relays), so the
 * defaults stay in step with the pinned peerjs version. Importing this file never touches the network.
 */

export interface NetConfig {
  /** PeerServer host. Default: the free public PeerJS broker ('0.peerjs.com'). */
  host?: string;
  /** PeerServer port. Default 443. */
  port?: number;
  /** PeerServer path. Default '/'. */
  path?: string;
  /** Use wss/https for the broker. Default true. */
  secure?: boolean;
  /** ICE servers; undefined = PeerJS defaults. */
  iceServers?: RTCIceServer[];
  /** PeerJS log level 0..3. */
  debug: number;
  /** Prefix for peer ids derived from room codes (keeps DotKick rooms apart on a shared broker). */
  peerPrefix: string;
  /** Broker connection (Peer 'open') must happen within this, ms; else 'broker-unreachable'. */
  brokerTimeoutMs: number;
  /** Both data channels must open within this after dialling / being dialled, ms; else 'blocked' (ICE failure). */
  connectTimeoutMs: number;
  /** The version handshake must finish within this after the channels open, ms; else 'version-mismatch'. */
  handshakeTimeoutMs: number;
  /** Ping interval on the control channel, ms (RTT and jitter for the adaptive input delay). */
  pingIntervalMs: number;
  /** No message at all from the other side for this long while open means it is gone ('disconnected'), ms. */
  silenceTimeoutMs: number;
  /** Delay before a host that lost the broker tries to re-register its room id, ms (rejoins need the broker). */
  brokerRetryMs: number;
}

/** Defaults: the free public PeerJS broker and its default ICE servers. */
export const NET_CONFIG: NetConfig = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 0,
  peerPrefix: 'dotkick-',
  brokerTimeoutMs: 10_000,
  connectTimeoutMs: 15_000,
  handshakeTimeoutMs: 5_000,
  pingIntervalMs: 500,
  silenceTimeoutMs: 6_000,
  brokerRetryMs: 2_000,
};

/** A config with `overrides` on top of NET_CONFIG (self-hosted PeerServer, custom ICE servers, test timeouts). */
export function createNetConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  const c: NetConfig = { ...NET_CONFIG };
  for (const k of Object.keys(overrides) as (keyof NetConfig)[]) {
    const v = overrides[k];
    if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
  }
  return c;
}

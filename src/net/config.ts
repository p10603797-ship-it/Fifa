/**
 * [NET-02] Network configuration: PeerJS broker and ICE servers in one object so a self-hosted PeerServer can
 * replace the defaults (brief section 11). No keys anywhere: the public PeerJS cloud broker needs none.
 *
 *   NET_CONFIG                         the defaults (free public PeerJS broker, DEFAULT_ICE_SERVERS)
 *   createNetConfig({ host: 'peer.example.org', port: 9000, path: '/dotkick', secure: true })
 *                                      a self-hosted PeerServer (everything not given keeps the default)
 *
 * [NET-FIX, D-044] The ICE servers are explicit: a few free public STUN servers and no TURN relay. PeerJS's own defaults
 * (stun.l.google.com plus the TURN relays eu-0 / us-0.turn.peerjs.com) are never used: both PeerJS TURN hostnames have
 * no DNS records any more, so they relayed nothing. There is no free TURN relay without an account; a deploy adds one
 * at run time with a relay.json file beside index.html (src/net/relay.ts, README "If online does not connect"), whose
 * servers are appended to this list for that room. Importing this file never touches the network.
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
  /** ICE servers (STUN / TURN); undefined = PeerJS's built-in defaults (dead TURN relays: avoid, D-044). */
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
  /**
   * No message at all from the other side for this long while open means it is gone ('disconnected'), ms. Long enough
   * for a GC pause or a slow frame burst; a known long stall (match warm-up) is announced with NetTransport.expectBusy.
   */
  silenceTimeoutMs: number;
  /**
   * Host: an established guest link that has been silent this long is given up when ANOTHER peer dials the room (a
   * guest whose page reloaded comes back under a new peer id before the old link timed out), ms.
   */
  replaceSilentMs: number;
  /** Delay before a host that lost the broker tries to re-register its room id, ms (rejoins need the broker). */
  brokerRetryMs: number;
}

/**
 * Free public STUN servers (each device learns its public address for a direct link). Four operators, so one outage
 * does not matter; kept short because every server costs ICE gathering time. No TURN here: see relay.json.
 */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = Object.freeze([
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]);

/** Defaults: the free public PeerJS broker and the public STUN servers above (a relay comes from relay.json). */
export const NET_CONFIG: NetConfig = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  iceServers: DEFAULT_ICE_SERVERS.map((s) => ({ ...s })),
  debug: 0,
  peerPrefix: 'dotkick-',
  brokerTimeoutMs: 10_000,
  connectTimeoutMs: 15_000,
  handshakeTimeoutMs: 5_000,
  pingIntervalMs: 500,
  silenceTimeoutMs: 10_000,
  replaceSilentMs: 2_000,
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

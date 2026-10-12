/**
 * [NET-02] Network configuration: PeerJS broker and ICE servers in one object so a self-hosted PeerServer can
 * replace the defaults (brief section 11). WAVE 0 version (FND-04). No keys anywhere.
 * Undefined fields mean "PeerJS default" (the free public broker and its default ICE servers).
 */

export interface NetConfig {
  /** PeerServer host; undefined = PeerJS public broker. */
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  /** ICE servers; undefined = PeerJS defaults. */
  iceServers?: RTCIceServer[];
  /** PeerJS log level 0..3. */
  debug: number;
  /** Prefix for peer ids derived from room codes (keeps DotKick rooms apart on a shared broker). */
  peerPrefix: string;
}

export const NET_CONFIG: NetConfig = {
  debug: 0,
  peerPrefix: 'dotkick-',
};

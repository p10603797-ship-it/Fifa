/**
 * [NET-FIX, D-044] Connection-stage diagnostics for the WebRTC link behind a PeerJS DataConnection.
 *
 * The transport watches the RTCPeerConnection of each data channel it dials or accepts (dataConnection.peerConnection)
 * with event listeners only (icecandidate, icegatheringstatechange, iceconnectionstatechange): no polling and nothing
 * per frame. When the channels fail to open it takes a synchronous snapshot (PeerJS drops the RTCPeerConnection as soon
 * as the connection closes) and reports:
 *  - which candidate types each side found: host (local address), srflx (public address learnt from STUN), prflx, relay
 *    (a TURN relay). Local types come from the icecandidate events and the local description; the other side's from
 *    the remote description (browsers add trickled remote candidates to it);
 *  - the stage that failed (failedStage): 'signalling' (the other side's offer / answer or candidates never arrived
 *    through the broker), 'gathering' (this device found no candidate at all), 'ice' (candidates on both sides, but no
 *    pair of them could reach each other: different networks without a relay), 'channel' (ICE connected, the data
 *    channels still did not open).
 * On success it logs, once, the candidate pair in use (getStats): a direct link or a relay.
 *
 * [NET-FIX-2, D-045] The snapshot also says, without any address leaving the probe:
 *  - what kind of host candidates each side offered: real local IP addresses ('ip'), only mDNS names ('mdns': what
 *    Safari offers unless the page holds a microphone or camera grant, src/net/localMode.ts), both, or none;
 *  - whether the two sides share a public address (sameNetwork): the srflx addresses this device gathered compared
 *    with the srflx candidates the other side sent, inside the page. Only the boolean is kept in the snapshot, logged
 *    or shown; null when either side has no srflx candidate (no STUN answer, or nothing arrived).
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type IceStage = 'signalling' | 'gathering' | 'ice' | 'channel';
/** What host candidates a side offered: real IP addresses, mDNS names only, both, or none. */
export type HostKind = 'none' | 'mdns' | 'ip' | 'ip+mdns';

const TYPES: readonly CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];

export interface IceSnapshot {
  /** Candidate types this device gathered (sorted host, srflx, prflx, relay). */
  local: CandidateType[];
  /** Candidate types the other device sent. */
  remote: CandidateType[];
  /** RTCPeerConnection.iceGatheringState ('' before any connection was watched). */
  gathering: string;
  /** RTCPeerConnection.iceConnectionState. */
  ice: string;
  /** RTCPeerConnection.signalingState. */
  signaling: string;
  /** The other side's offer / answer arrived. */
  remoteDescription: boolean;
  /** [NET-FIX-2] Host candidates this device offered (real IP, mDNS names only...). */
  localHost: HostKind;
  /** [NET-FIX-2] Host candidates the other device sent. */
  remoteHost: HostKind;
  /**
   * [NET-FIX-2] Both sides have the same public (srflx) address: very likely the same network (same Wi-Fi). null when
   * unknown. The addresses themselves never leave the probe.
   */
  sameNetwork: boolean | null;
}

/** What the transport records about the last link (failure or success). */
export interface IceReport extends IceSnapshot {
  /** The failing stage; null when the link opened. */
  stage: IceStage | null;
  /** The ICE server list had a TURN relay. */
  relayConfigured: boolean;
  /** Number of ICE servers given to the browser. */
  servers: number;
}

/** Candidate type from an RTCIceCandidate-like object (its `type`, else the ` typ X` field of its SDP line). Pure. */
export function candidateTypeOf(c: { type?: string | null; candidate?: string } | null | undefined): CandidateType | null {
  if (!c) return null;
  const t = typeof c.type === 'string' ? c.type : null;
  if (t && (TYPES as readonly string[]).includes(t)) return t as CandidateType;
  const m = typeof c.candidate === 'string' ? / typ (host|srflx|prflx|relay)\b/.exec(c.candidate) : null;
  return m ? (m[1] as CandidateType) : null;
}

/** Candidate types in an SDP blob (its a=candidate lines). Pure. */
export function candidateTypesFromSdp(sdp: string | null | undefined): CandidateType[] {
  const out = new Set<CandidateType>();
  if (typeof sdp !== 'string') return [];
  for (const m of sdp.matchAll(/^a=candidate:[^\r\n]* typ (host|srflx|prflx|relay)\b/gm)) out.add(m[1] as CandidateType);
  return sortTypes(out);
}

const CANDIDATE_RE = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (host|srflx|prflx|relay)\b/;

/** Address field and type of one candidate line (with or without 'a='), or null. Pure. */
function parseCandidate(line: string): { address: string; type: CandidateType } | null {
  const m = CANDIDATE_RE.exec(line);
  return m ? { address: m[1]!, type: m[2] as CandidateType } : null;
}

/** True for an mDNS host name (WebRTC hides local addresses behind '<uuid>.local'). Pure. */
export function isMdnsAddress(address: string): boolean {
  return /\.local\.?$/i.test(address);
}

/** Kind of host candidates from flags. Pure. */
export function hostKindOf(ip: boolean, mdns: boolean): HostKind {
  return ip && mdns ? 'ip+mdns' : ip ? 'ip' : mdns ? 'mdns' : 'none';
}

/** Same public address on both sides (any srflx address in common); null when either side has none. Pure. */
export function sameNetworkOf(local: ReadonlySet<string>, remote: ReadonlySet<string>): boolean | null {
  if (local.size === 0 || remote.size === 0) return null;
  for (const a of local) if (remote.has(a)) return true;
  return false;
}

/** Collects host-candidate kinds and srflx addresses of one side (the addresses stay inside the probe). */
interface SideAddrs {
  hostIp: boolean;
  hostMdns: boolean;
  srflx: Set<string>;
}

function noteCandidate(side: SideAddrs, address: string, type: CandidateType): void {
  if (!address) return;
  if (type === 'host') {
    if (isMdnsAddress(address)) side.hostMdns = true;
    else side.hostIp = true;
  } else if (type === 'srflx' && side.srflx.size < 16) {
    side.srflx.add(address.toLowerCase());
  }
}

function noteSdp(side: SideAddrs, sdp: string | null | undefined): void {
  if (typeof sdp !== 'string' || sdp.indexOf('a=candidate:') < 0) return;
  for (const line of sdp.split(/\r?\n/)) {
    const c = line.startsWith('a=candidate:') ? parseCandidate(line) : null;
    if (c) noteCandidate(side, c.address, c.type);
  }
}

function sortTypes(s: Iterable<CandidateType>): CandidateType[] {
  const set = new Set(s);
  return TYPES.filter((t) => set.has(t));
}

/** Which stage of the connection failed, from a snapshot taken when the channels did not open. Pure. */
export function failedStage(s: IceSnapshot): IceStage {
  if (!s.remoteDescription) return 'signalling';
  if (s.local.length === 0) return 'gathering';
  if (s.remote.length === 0) return 'signalling';
  if (s.ice !== 'connected' && s.ice !== 'completed') return 'ice';
  return 'channel';
}

/** One-line summary for the diagnostics log. Pure. */
export function describeIce(r: IceReport): string {
  const types = (t: readonly string[]): string => (t.length ? t.join('+') : 'none');
  const head = r.stage ? `failed at ${r.stage}` : 'connected';
  const hosts = (r.localHost && r.localHost !== 'none') || (r.remoteHost && r.remoteHost !== 'none')
    ? `, host addresses local ${r.localHost ?? 'none'} remote ${r.remoteHost ?? 'none'}` : '';
  const same = r.sameNetwork === true ? ', same network yes' : r.sameNetwork === false ? ', same network no' : '';
  return `ice ${head}: local ${types(r.local)}, remote ${types(r.remote)}, ice ${r.ice || '-'}, gathering ${r.gathering || '-'}, `
    + `signalling ${r.signaling || '-'}, ${r.servers} ICE server(s)${r.relayConfigured ? ' incl. TURN' : ', no TURN'}${hosts}${same}`;
}

/** The subset of RTCPeerConnection the probe reads. */
export interface PeerConnectionLike {
  readonly iceGatheringState?: string;
  readonly iceConnectionState?: string;
  readonly signalingState?: string;
  readonly localDescription?: { sdp?: string } | null;
  readonly remoteDescription?: { sdp?: string } | null;
  addEventListener?(type: string, fn: (e: never) => void): void;
  removeEventListener?(type: string, fn: (e: never) => void): void;
  getStats?(): Promise<Iterable<[string, unknown]> | { forEach(fn: (v: unknown) => void): void }>;
}

export interface IceProbe {
  /** Watch the RTCPeerConnection behind a DataConnection (anything without one is ignored). */
  watch(conn: unknown): void;
  /** What is known now (synchronous: read before the connection is torn down). */
  snapshot(): IceSnapshot;
  /** Types of the candidate pair in use, from getStats (null when unknown). */
  selectedPair(): Promise<{ local: CandidateType | null; remote: CandidateType | null } | null>;
  /** Remove the listeners. */
  dispose(): void;
}

/** The RTCPeerConnection of a PeerJS DataConnection, if it has one. */
export function peerConnectionOf(conn: unknown): PeerConnectionLike | null {
  if (typeof conn !== 'object' || conn === null) return null;
  const pc = (conn as { peerConnection?: unknown }).peerConnection;
  return typeof pc === 'object' && pc !== null ? (pc as PeerConnectionLike) : null;
}

const STATE_RANK: Record<string, number> = { new: 0, checking: 1, disconnected: 2, failed: 2, closed: 2, connected: 3, completed: 4 };

/** A probe over the RTCPeerConnections of one link (two data channels = two connections in PeerJS). */
export function createIceProbe(): IceProbe {
  const pcs: PeerConnectionLike[] = [];
  const local = new Set<CandidateType>();
  const remote = new Set<CandidateType>();
  const localAddrs: SideAddrs = { hostIp: false, hostMdns: false, srflx: new Set() };
  const remoteAddrs: SideAddrs = { hostIp: false, hostMdns: false, srflx: new Set() };
  const last = { gathering: '', ice: '', signaling: '', remoteDescription: false };
  const offs: (() => void)[] = [];

  function read(pc: PeerConnectionLike): void {
    try {
      const ls = pc.localDescription?.sdp;
      const rs = pc.remoteDescription?.sdp;
      for (const t of candidateTypesFromSdp(ls)) local.add(t);
      for (const t of candidateTypesFromSdp(rs)) remote.add(t);
      noteSdp(localAddrs, ls);
      noteSdp(remoteAddrs, rs);
      if (pc.remoteDescription) last.remoteDescription = true;
    } catch {
      /* a closed connection may throw on access */
    }
  }

  /** The most advanced states over the watched connections (the control channel and the inputs channel). */
  function states(): void {
    let ice = '';
    let gathering = '';
    let signaling = '';
    for (const pc of pcs) {
      // A closed connection says only 'closed' (PeerJS closes it on failure): keep what it said before.
      if (pc.signalingState === 'closed' || pc.iceConnectionState === 'closed') continue;
      const i = pc.iceConnectionState ?? '';
      if (i && (ice === '' || (STATE_RANK[i] ?? 0) > (STATE_RANK[ice] ?? 0))) ice = i;
      const g = pc.iceGatheringState ?? '';
      if (g && (gathering === '' || g === 'complete' || (g === 'gathering' && gathering === 'new'))) gathering = g;
      const s = pc.signalingState ?? '';
      if (s && (signaling === '' || s === 'stable')) signaling = s;
    }
    if (ice) last.ice = ice;
    if (gathering) last.gathering = gathering;
    if (signaling) last.signaling = signaling;
  }

  return {
    watch(conn) {
      const pc = peerConnectionOf(conn);
      if (!pc || pcs.includes(pc) || typeof pc.addEventListener !== 'function') return;
      pcs.push(pc);
      const onCandidate = (e: { candidate?: { type?: string | null; candidate?: string; address?: string | null } | null }): void => {
        const c = e?.candidate ?? null;
        const t = candidateTypeOf(c);
        if (!t) return;
        local.add(t);
        const addr = typeof c?.address === 'string' && c.address ? c.address
          : typeof c?.candidate === 'string' ? parseCandidate(c.candidate)?.address ?? '' : '';
        noteCandidate(localAddrs, addr, t);
      };
      const onState = (): void => {
        read(pc);
        states();
      };
      pc.addEventListener('icecandidate', onCandidate as (e: never) => void);
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('iceconnectionstatechange', onState);
      pc.addEventListener('signalingstatechange', onState);
      offs.push(() => {
        pc.removeEventListener?.('icecandidate', onCandidate as (e: never) => void);
        pc.removeEventListener?.('icegatheringstatechange', onState);
        pc.removeEventListener?.('iceconnectionstatechange', onState);
        pc.removeEventListener?.('signalingstatechange', onState);
      });
      onState();
    },
    snapshot() {
      for (const pc of pcs) read(pc);
      states();
      return {
        local: sortTypes(local), remote: sortTypes(remote), ...last,
        localHost: hostKindOf(localAddrs.hostIp, localAddrs.hostMdns),
        remoteHost: hostKindOf(remoteAddrs.hostIp, remoteAddrs.hostMdns),
        sameNetwork: sameNetworkOf(localAddrs.srflx, remoteAddrs.srflx),
      };
    },
    async selectedPair() {
      const pc = pcs[0];
      if (!pc || typeof pc.getStats !== 'function') return null;
      try {
        const report = await pc.getStats();
        const byId = new Map<string, Record<string, unknown>>();
        const add = (v: unknown): void => {
          if (typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string') byId.set((v as { id: string }).id, v as Record<string, unknown>);
        };
        if (typeof (report as { forEach?: unknown }).forEach === 'function') (report as { forEach(fn: (v: unknown) => void): void }).forEach(add);
        else for (const [, v] of report as Iterable<[string, unknown]>) add(v);
        let pair: Record<string, unknown> | null = null;
        for (const v of byId.values()) {
          if (v.type === 'transport' && typeof v.selectedCandidatePairId === 'string') pair = byId.get(v.selectedCandidatePairId) ?? pair;
        }
        if (!pair) {
          for (const v of byId.values()) {
            if (v.type === 'candidate-pair' && v.state === 'succeeded' && (v.nominated === true || v.selected === true)) pair = v;
          }
        }
        if (!pair) return null;
        const typeOf = (id: unknown): CandidateType | null => {
          const c = typeof id === 'string' ? byId.get(id) : undefined;
          const t = c?.candidateType;
          return typeof t === 'string' && (TYPES as readonly string[]).includes(t) ? (t as CandidateType) : null;
        };
        return { local: typeOf(pair.localCandidateId), remote: typeOf(pair.remoteCandidateId) };
      } catch {
        return null;
      }
    },
    dispose() {
      for (const o of offs) o();
      offs.length = 0;
      pcs.length = 0;
      localAddrs.srflx.clear();
      remoteAddrs.srflx.clear();
    },
  };
}

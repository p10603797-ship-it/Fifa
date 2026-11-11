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
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type IceStage = 'signalling' | 'gathering' | 'ice' | 'channel';

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
  return `ice ${head}: local ${types(r.local)}, remote ${types(r.remote)}, ice ${r.ice || '-'}, gathering ${r.gathering || '-'}, `
    + `signalling ${r.signaling || '-'}, ${r.servers} ICE server(s)${r.relayConfigured ? ' incl. TURN' : ', no TURN'}`;
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
  const last = { gathering: '', ice: '', signaling: '', remoteDescription: false };
  const offs: (() => void)[] = [];

  function read(pc: PeerConnectionLike): void {
    try {
      for (const t of candidateTypesFromSdp(pc.localDescription?.sdp)) local.add(t);
      for (const t of candidateTypesFromSdp(pc.remoteDescription?.sdp)) remote.add(t);
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
      const onCandidate = (e: { candidate?: { type?: string | null; candidate?: string } | null }): void => {
        const t = candidateTypeOf(e?.candidate ?? null);
        if (t) local.add(t);
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
      return { local: sortTypes(local), remote: sortTypes(remote), ...last };
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
    },
  };
}

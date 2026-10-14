/**
 * [NET-05] Hash exchange every 30 ticks, desync detection and snapshot resync (the host sends a full state, the guest
 * hard-syncs, both log seed, tick, inputs and the first differing field).
 *
 * Protocol (control channel, 'ls:' namespace):
 *  - 'ls:hash'    { tick, h, e, z }  after every tick that is a multiple of HASH_INTERVAL_TICKS (tick 0 included, so
 *                 different starting states are caught at once). e = the sender's resync epoch, z = 1 when the
 *                 sender can gunzip (DecompressionStream).
 *  - comparison   as soon as both hashes of a tick are known. A mismatch counts once per incident (the host ignores
 *                 guest hashes from before its latest snapshot; the guest counts again only after it hard-synced).
 *  - 'ls:snap'    { e, tick, i, n, codec, seed, data }  host -> guest, sent at the host's first tick after detecting
 *                 the mismatch: serializeState of that tick (captured synchronously), gzip + base64 when both sides
 *                 support CompressionStream (codec 'gzip'), plain JSON otherwise ('json'), in SNAPSHOT_CHUNK_CHARS chunks.
 *  - hard-sync    the guest applies the snapshot as soon as its own tick is >= the snapshot tick: copyState into the
 *                 live state (state.tick becomes the snapshot tick; lockstep.ts then re-simulates from tick + 1 with
 *                 the frames it kept, so input queues stay aligned), forgets its hashes after that tick, and answers
 *  - 'ls:snap-ok' { e, tick, ok }  (ok 0 = could not decode: the host sends a fresh snapshot).
 *  - verification the first comparison after the snapshot tick that matches counts as `verified`.
 * One snapshot is in flight at a time. Every incident is logged through opts.log (Diagnostics.log compatible) with
 * seed, tick, both hashes, the inputs around it (opts.describeInputs) and, on the guest, diffState(local, snapshot).
 */
import type { SimState } from '../contracts/state';
import { T_NET } from '../contracts/tuning';
import { copyState, diffState } from '../sim/core/clone';
import { hashHex, hashState } from '../sim/core/hash';
import { deserializeState, serializeState } from '../sim/core/serialize';
import type { ControlMessage } from './types';

export const HASH_INTERVAL_TICKS: number = T_NET.hashInterval;
/** Snapshot chunk size, chars (the transport fragments further if it needs to). */
export const SNAPSHOT_CHUNK_CHARS = 12_000;

export const CTRL_HASH = 'ls:hash';
export const CTRL_SNAP = 'ls:snap';
export const CTRL_SNAP_OK = 'ls:snap-ok';

/** Hash ticks remembered per side (64 x 30 ticks = 32 s of history). */
const HASH_SLOTS = 64;
/** Desync reports kept for the diagnostics screen. */
const REPORTS_KEPT = 8;
/** Ticks of inputs attached to a desync report. */
const REPORT_INPUT_TICKS = 30;

export type SnapshotCodec = 'gzip' | 'json';

export interface EncodedSnapshot {
  tick: number;
  codec: SnapshotCodec;
  chunks: string[];
  /** Total payload chars (all chunks). */
  chars: number;
}

/** True when CompressionStream and DecompressionStream exist (Safari 16.4+, Chrome 80+, Node 18+). */
export function compressionAvailable(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

function chunk(s: string, size = SNAPSHOT_CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  if (out.length === 0) out.push('');
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Snapshot as plain JSON chunks (synchronous). */
export function encodeSnapshotSync(state: SimState): EncodedSnapshot {
  const json = serializeState(state);
  return { tick: state.tick, codec: 'json', chunks: chunk(json), chars: json.length };
}

/**
 * Snapshot of `state` as it is now (serialised synchronously before the first await, so the caller may keep
 * stepping), gzip + base64 when `codec` is 'gzip' and compression exists, plain JSON otherwise.
 */
export async function encodeSnapshot(state: SimState, codec: SnapshotCodec): Promise<EncodedSnapshot> {
  const tick = state.tick;
  const json = serializeState(state);
  if (codec !== 'gzip' || !compressionAvailable()) return { tick, codec: 'json', chunks: chunk(json), chars: json.length };
  const b64 = toBase64(await gzip(json));
  return { tick, codec: 'gzip', chunks: chunk(b64), chars: b64.length };
}

/** Inverse of encodeSnapshot / encodeSnapshotSync. Throws (SyntaxError, TypeError) on bad data. */
export async function decodeSnapshot(codec: SnapshotCodec, chunks: readonly string[]): Promise<SimState> {
  const payload = chunks.join('');
  if (codec === 'json') return deserializeState(payload);
  if (!compressionAvailable()) throw new TypeError('decodeSnapshot: DecompressionStream unavailable');
  return deserializeState(await gunzip(fromBase64(payload)));
}

export interface DesyncReport {
  role: 'host' | 'guest';
  seed: number;
  tick: number;
  local: string;
  remote: string;
  /** Inputs of the REPORT_INPUT_TICKS ticks up to `tick` (from opts.describeInputs). */
  inputs: unknown;
  /** Guest only, filled when the snapshot is applied: first differing field of local vs snapshot. */
  diff: string | null;
}

export interface DesyncStats {
  /** Mismatch incidents detected by this side. */
  desyncs: number;
  /** Snapshots applied (guest) or acknowledged (host). */
  resyncs: number;
  lastResyncTick: number;
  firstDesyncTick: number;
  lastDesyncTick: number;
  /** Matching comparisons right after a resync. */
  verified: number;
  lastVerifiedTick: number;
  hashesSent: number;
  hashesCompared: number;
  /** Payload chars of the last snapshot sent or received. */
  snapshotChars: number;
  /** Resync epoch (snapshots sent by the host / applied by the guest). */
  epoch: number;
}

export interface DesyncGuardOptions {
  isHost: boolean;
  /** Sends 'ls:hash' / 'ls:snap' / 'ls:snap-ok' (transport.sendReliable). Without it the guard only compares. */
  send?: (msg: ControlMessage) => void;
  /** Hash interval in ticks (default 30). */
  interval?: number;
  /** Diagnostics.log compatible. */
  log?: (kind: string, message: string, data?: unknown) => void;
  /** Inputs of ticks from..to for reports (lockstep.ts supplies its kept frames). */
  describeInputs?: (fromTick: number, toTick: number) => unknown;
  /** Snapshot compression: 'auto' (gzip when both sides can), 'gzip' or 'none'. Default 'auto'. */
  compress?: 'auto' | 'gzip' | 'none';
  /** Guest: the live state was replaced by a snapshot of `tick` (it was at `fromTick`). */
  onApplied?: (tick: number, fromTick: number) => void;
}

export interface DesyncGuard {
  /** After each local tick: record the hash when due; returns the hash (sent when opts.send is set) or -1. The host
   *  also captures and sends the requested snapshot here. */
  afterTick(state: SimState): number;
  /** Remote hash for `tick` arrived; returns true on mismatch. */
  remoteHash(tick: number, hash: number, epoch?: number): boolean;
  /** Consume 'ls:hash', 'ls:snap', 'ls:snap-ok'; false for other messages. */
  handle(msg: ControlMessage): boolean;
  /** Guest: replace `state` by the received snapshot once state.tick >= its tick. True when it did. */
  applyPending(state: SimState): boolean;
  readonly desyncs: number;
  readonly resyncs: number;
  readonly lastResyncTick: number;
  /** An async snapshot encode / decode is running (harnesses on virtual time wait for it). */
  readonly busy: boolean;
  /** Guest: a mismatch was seen and the snapshot has not been applied yet. Host: a snapshot is requested or unacknowledged. */
  readonly resyncing: boolean;
  readonly stats: Readonly<DesyncStats>;
  readonly reports: readonly DesyncReport[];
  dispose(): void;
}

interface Collect {
  e: number;
  tick: number;
  n: number;
  codec: SnapshotCodec;
  parts: (string | undefined)[];
  got: number;
}

export function createDesyncGuard(opts: DesyncGuardOptions): DesyncGuard {
  const isHost = opts.isHost;
  const interval = Math.max(1, opts.interval ?? HASH_INTERVAL_TICKS);
  const compress = opts.compress ?? 'auto';
  const send = opts.send;
  const log = opts.log;
  const canGunzip = compressionAvailable() && compress !== 'none';

  const lt = new Float64Array(HASH_SLOTS).fill(-1);
  const lh = new Float64Array(HASH_SLOTS);
  const lc = new Uint8Array(HASH_SLOTS);
  const rt = new Float64Array(HASH_SLOTS).fill(-1);
  const rh = new Float64Array(HASH_SLOTS);
  const re = new Float64Array(HASH_SLOTS);
  const slot = (tick: number): number => Math.floor(tick / interval) % HASH_SLOTS;

  const stats: DesyncStats = {
    desyncs: 0, resyncs: 0, lastResyncTick: -1, firstDesyncTick: -1, lastDesyncTick: -1, verified: 0, lastVerifiedTick: -1,
    hashesSent: 0, hashesCompared: 0, snapshotChars: 0, epoch: 0,
  };
  const reports: DesyncReport[] = [];
  let lastHashed = -1;
  let seed = 0;
  let busy = 0;
  let disposed = false;
  let verifyAfter = -1;
  // host
  let snapRequested = false;
  let inFlight = false;
  let peerGzip = false;
  // guest
  let awaiting = false;
  let collect: Collect | null = null;
  let pending: { tick: number; state: SimState; e: number } | null = null;

  function report(tick: number, local: number, remote: number): void {
    const r: DesyncReport = {
      role: isHost ? 'host' : 'guest', seed, tick, local: hashHex(local), remote: hashHex(remote),
      inputs: opts.describeInputs ? opts.describeInputs(Math.max(0, tick - REPORT_INPUT_TICKS + 1), tick) : null, diff: null,
    };
    reports.push(r);
    if (reports.length > REPORTS_KEPT) reports.shift();
    log?.('net', `desync at tick ${tick} (seed ${seed}): local ${r.local} != remote ${r.remote}`, r);
  }

  function compareAt(tick: number): boolean {
    const i = slot(tick);
    if (lt[i] !== tick || lc[i] === 1 || rt[i] !== tick) return false;
    if (isHost && re[i] < stats.epoch) return false;
    lc[i] = 1;
    stats.hashesCompared++;
    if (lh[i] === rh[i]) {
      if (verifyAfter >= 0 && tick > verifyAfter) {
        stats.verified++;
        stats.lastVerifiedTick = tick;
        verifyAfter = -1;
        log?.('net', `resync verified at tick ${tick}`);
      }
      return false;
    }
    if (isHost ? snapRequested || inFlight : awaiting) return true; // same incident
    stats.desyncs++;
    if (stats.firstDesyncTick < 0) stats.firstDesyncTick = tick;
    stats.lastDesyncTick = tick;
    if (isHost) snapRequested = true;
    else awaiting = true;
    report(tick, lh[i]!, rh[i]!);
    return true;
  }

  function sendSnapshot(enc: EncodedSnapshot, e: number): void {
    if (disposed || e !== stats.epoch) return;
    stats.snapshotChars = enc.chars;
    const n = enc.chunks.length;
    for (let i = 0; i < n; i++) {
      send?.({ type: CTRL_SNAP, e, tick: enc.tick, i, n, codec: enc.codec, seed, data: enc.chunks[i]! });
    }
    log?.('net', `resync: snapshot of tick ${enc.tick} sent (${enc.codec}, ${enc.chars} chars, ${n} chunks, seed ${seed})`);
  }

  function startSnapshot(s: SimState): void {
    snapRequested = false;
    inFlight = true;
    const e = ++stats.epoch;
    const gz = compress === 'gzip' || (compress === 'auto' && peerGzip);
    if (!gz || !compressionAvailable()) {
      sendSnapshot(encodeSnapshotSync(s), e);
      return;
    }
    busy++;
    encodeSnapshot(s, 'gzip')
      .then((enc) => sendSnapshot(enc, e))
      .catch((err: unknown) => {
        log?.('net', `resync: compression failed (${String(err)}); sending JSON`);
        inFlight = false;
        snapRequested = true;
      })
      .finally(() => {
        busy--;
      });
  }

  function snapFailed(e: number, tick: number, why: string): void {
    log?.('net', `resync: snapshot ${e} of tick ${tick} unusable (${why})`);
    send?.({ type: CTRL_SNAP_OK, e, tick, ok: 0 });
  }

  function received(c: Collect): void {
    stats.snapshotChars = 0;
    for (const p of c.parts) stats.snapshotChars += p!.length;
    const accept = (st: SimState): void => {
      if (disposed) return;
      if (st.tick !== c.tick) {
        snapFailed(c.e, c.tick, `snapshot tick ${st.tick}`);
        return;
      }
      if (pending && pending.e > c.e) return;
      pending = { tick: c.tick, state: st, e: c.e };
    };
    if (c.codec === 'json') {
      try {
        accept(deserializeState(c.parts.join('')));
      } catch (err) {
        snapFailed(c.e, c.tick, String(err));
      }
      return;
    }
    busy++;
    decodeSnapshot(c.codec, c.parts as string[])
      .then(accept)
      .catch((err: unknown) => snapFailed(c.e, c.tick, String(err)))
      .finally(() => {
        busy--;
      });
  }

  function onSnapChunk(msg: ControlMessage): void {
    const { e, tick, i, n, codec, data } = msg;
    if (typeof e !== 'number' || typeof tick !== 'number' || typeof i !== 'number' || typeof n !== 'number' ||
      typeof data !== 'string' || (codec !== 'json' && codec !== 'gzip') || !Number.isInteger(i) || !Number.isInteger(n) ||
      n < 1 || i < 0 || i >= n || n > 100_000) return;
    if (e <= stats.epoch) return; // already applied
    if (!collect || collect.e !== e) {
      if (collect && e < collect.e) return;
      collect = { e, tick, n, codec, parts: new Array<string | undefined>(n), got: 0 };
    }
    if (collect.n !== n || collect.parts[i] !== undefined) return;
    collect.parts[i] = data;
    collect.got++;
    if (collect.got === collect.n) {
      const c = collect;
      collect = null;
      received(c);
    }
  }

  const guard: DesyncGuard = {
    get desyncs() { return stats.desyncs; },
    get resyncs() { return stats.resyncs; },
    get lastResyncTick() { return stats.lastResyncTick; },
    get busy() { return busy > 0; },
    get resyncing() { return isHost ? snapRequested || inFlight : awaiting || pending !== null; },
    get stats() { return stats; },
    get reports() { return reports; },
    afterTick(s) {
      if (disposed) return -1;
      seed = s.config.seed;
      const tick = s.tick;
      let out = -1;
      if (tick % interval === 0 && tick > lastHashed) {
        lastHashed = tick;
        const h = hashState(s);
        const i = slot(tick);
        lt[i] = tick;
        lh[i] = h;
        lc[i] = 0;
        if (send) {
          send({ type: CTRL_HASH, tick, h, e: stats.epoch, z: canGunzip ? 1 : 0 });
          stats.hashesSent++;
        }
        compareAt(tick);
        out = h;
      }
      if (isHost && snapRequested && !inFlight) startSnapshot(s);
      return out;
    },
    remoteHash(tick, hash, epoch = 0) {
      if (disposed || !Number.isInteger(tick) || tick < 0) return false;
      if (isHost && epoch < stats.epoch) return false; // from before our latest snapshot
      const i = slot(tick);
      rt[i] = tick;
      rh[i] = hash >>> 0;
      re[i] = epoch;
      return compareAt(tick);
    },
    handle(msg) {
      switch (msg.type) {
        case CTRL_HASH: {
          const { tick, h, e, z } = msg;
          if (isHost && z === 1) peerGzip = true;
          if (typeof tick === 'number' && typeof h === 'number') guard.remoteHash(tick, h, typeof e === 'number' ? e : 0);
          return true;
        }
        case CTRL_SNAP:
          if (!isHost && !disposed) onSnapChunk(msg);
          return true;
        case CTRL_SNAP_OK: {
          if (!isHost || disposed || msg.e !== stats.epoch) return true;
          inFlight = false;
          const tick = typeof msg.tick === 'number' ? msg.tick : -1;
          if (msg.ok === 1) {
            stats.resyncs++;
            stats.lastResyncTick = tick;
            verifyAfter = tick;
            log?.('net', `resync: guest hard-synced to tick ${tick}`);
          } else {
            snapRequested = true; // try again with a fresh snapshot
          }
          return true;
        }
        default:
          return false;
      }
    },
    applyPending(s) {
      if (isHost || disposed || !pending || s.tick < pending.tick) return false;
      const p = pending;
      pending = null;
      let diff: string | null = null;
      try {
        diff = diffState(s, p.state);
      } catch {
        diff = null;
      }
      const fromTick = s.tick;
      copyState(s, p.state);
      stats.epoch = p.e;
      stats.resyncs++;
      stats.lastResyncTick = p.tick;
      awaiting = false;
      verifyAfter = p.tick;
      for (let i = 0; i < HASH_SLOTS; i++) if (lt[i]! >= p.tick) lt[i] = -1;
      if (lastHashed >= p.tick) lastHashed = p.tick - 1;
      const last = reports[reports.length - 1];
      if (last && last.diff === null) last.diff = diff;
      send?.({ type: CTRL_SNAP_OK, e: p.e, tick: p.tick, ok: 1 });
      log?.('net', `resync: hard-synced to tick ${p.tick} from tick ${fromTick} (seed ${seed}); first difference: ${diff ?? 'none'}`, {
        seed, tick: p.tick, fromTick, diff,
      });
      opts.onApplied?.(p.tick, fromTick);
      return true;
    },
    dispose() {
      disposed = true;
      pending = null;
      collect = null;
    },
  };
  return guard;
}

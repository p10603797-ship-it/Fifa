/**
 * [NET-02] Wire codecs shared by both transports (PeerJS and in-memory) plus tiny transport helpers.
 * No network, no timers: pure functions and small objects, safe to import anywhere inside src/net.
 *
 *  - NET_PROTOCOL_VERSION: compared in the '$hello' handshake (different builds refuse to play: 'version-mismatch').
 *  - packSenderFrame / unpackSenderFrame: one human's InputFrame <-> FRAME_INTS int16 values, encoded exactly like
 *    packFrames (src/sim/core/serialize.ts) encodes one human (bitfields as uint16, other fields clamped to int16).
 *  - encodeInputPacket / decodeInputPacket: InputPacket <-> bytes (24-byte header + sparse frames: per frame a 3-byte
 *    mask of its non-zero values followed by those values as little-endian int16, or a 3-byte "same as the previous
 *    frame" marker). Most of a frame is zero and a held stick repeats, so a 10-frame packet is ~60-120 bytes instead
 *    of 404 (QF-6: 24 kB/s each way at 80 ms made links under that unplayable; now ~4-7 kB/s).
 *    The decoder never throws: malformed data returns null and is ignored.
 *  - createControlCodec: ControlMessage <-> JSON strings, fragmenting messages longer than CONTROL_FRAGMENT_CHARS
 *    ('~id:i:n:' prefix) so any size travels on data channels with a small message limit.
 *  - netError / reasonOf / isNetErrorReason: Errors whose message is a NetErrorReason.
 *  - createEmitter: minimal listener list used by the transports.
 */
import { GAME_VERSION, MAX_HUMANS, SIM_VERSION } from '../contracts/constants';
import { createInputFrame, INPUT_FIELDS, type InputFrame } from '../contracts/input';
import { PACKED_FRAME_INTS, packFrames, unpackFrames } from '../sim/core/serialize';
import type { ControlMessage, InputPacket, NetErrorReason } from './types';

/** Protocol identity exchanged in the handshake: game build, sim version and net protocol revision. */
export const NET_PROTOCOL_VERSION = `${GAME_VERSION}/sim${SIM_VERSION}/net2`;

/** int16 values per frame of one human on the wire. */
export const FRAME_INTS = INPUT_FIELDS.length;
/** Most frames one packet may carry (decoder limit; normal packets carry T_NET.redundancy at most). */
export const MAX_PACKET_FRAMES = 64;
/** Bytes before the frame data: magic, firstTick, count, ack, tick, adv * 16 (6 x int32, little-endian). */
export const PACKET_HEADER_BYTES = 24;
/** 'DKN3' (sparse frames). */
export const PACKET_MAGIC = 0x444b4e33;
/** Per-frame mask flag: this frame equals the previous one in the packet (no values follow). */
const FRAME_REPEAT = 1 << 23;
/** Bits a mask may use for values (one per frame field; the 3-byte mask holds 23 of them besides FRAME_REPEAT). */
const FRAME_VALUE_BITS = (1 << INPUT_FIELDS.length) - 1;
if (INPUT_FIELDS.length > 23) throw new Error('packet.ts: the sparse frame mask holds at most 23 fields');
/** Fixed-point scale of InputPacket.adv on the wire. */
export const PACKET_ADV_SCALE = 16;
/** Control strings longer than this are split into fragments (keeps every data-channel message < 16 KB in UTF-8). */
export const CONTROL_FRAGMENT_CHARS = 5000;
/** Largest reassembled control message, chars (guards memory against a broken or hostile peer). */
export const CONTROL_MAX_CHARS = 16 * 1024 * 1024;

/** Transport-internal control types (never delivered to onReliable subscribers). */
export const CTRL_HELLO = '$hello';
export const CTRL_FULL = '$full';
export const CTRL_PING = '$ping';
export const CTRL_PONG = '$pong';
/** { ms }: the sender will be busy (silent) for up to ms; 0 = done. */
export const CTRL_BUSY = '$busy';
/** Longest silence grace a '$busy' may ask for, ms. */
export const MAX_BUSY_MS = 60_000;

// ---------------------------------------------------------------- frames

const packScratch = new Int16Array(PACKED_FRAME_INTS);
const packList: InputFrame[] = [createInputFrame()];
const unpackList: InputFrame[] = [];
for (let h = 0; h < MAX_HUMANS; h++) unpackList.push(createInputFrame());
const unpackDummy = unpackList[0]!;

/** Write one frame as FRAME_INTS int16 values at out[offset..]. Throws a RangeError when out is too short. */
export function packSenderFrame(frame: InputFrame, out: Int16Array, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + FRAME_INTS > out.length) {
    throw new RangeError('packSenderFrame: no room for FRAME_INTS values at offset');
  }
  packList[0] = frame;
  packFrames(packList, packScratch, 0);
  for (let i = 0; i < FRAME_INTS; i++) out[offset + i] = packScratch[i]!;
}

/** Read one frame written by packSenderFrame into `out`. Throws a RangeError when src is too short. */
export function unpackSenderFrame(src: Int16Array, offset: number, out: InputFrame): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + FRAME_INTS > src.length) {
    throw new RangeError('unpackSenderFrame: FRAME_INTS values needed at offset');
  }
  for (let i = 0; i < FRAME_INTS; i++) packScratch[i] = src[offset + i]!;
  unpackList[0] = out;
  unpackFrames(packScratch, 0, unpackList);
  unpackList[0] = unpackDummy;
}

// ---------------------------------------------------------------- input packets

/** True when frame i of `d` equals frame i - 1. */
function sameAsPrevious(d: Int16Array, i: number): boolean {
  if (i === 0) return false;
  const a = i * FRAME_INTS;
  const b = a - FRAME_INTS;
  for (let k = 0; k < FRAME_INTS; k++) if (d[a + k] !== d[b + k]) return false;
  return true;
}

/** InputPacket -> bytes (a fresh ArrayBuffer: data channels may queue it). Reads count * FRAME_INTS values. */
export function encodeInputPacket(p: InputPacket): ArrayBuffer {
  const count = p.count | 0;
  if (count < 1 || count > MAX_PACKET_FRAMES || p.data.length < count * FRAME_INTS) {
    throw new RangeError(`encodeInputPacket: bad count ${p.count}`);
  }
  const d = p.data;
  let size = PACKET_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    size += 3;
    if (sameAsPrevious(d, i)) continue;
    const o = i * FRAME_INTS;
    for (let k = 0; k < FRAME_INTS; k++) if (d[o + k] !== 0) size += 2;
  }
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint32(0, PACKET_MAGIC, true);
  v.setInt32(4, p.firstTick | 0, true);
  v.setInt32(8, count, true);
  v.setInt32(12, p.ack | 0, true);
  v.setInt32(16, p.tick | 0, true);
  const adv = Math.round(p.adv * PACKET_ADV_SCALE);
  v.setInt32(20, Number.isFinite(adv) ? Math.max(-0x7fffffff, Math.min(0x7fffffff, adv)) : 0, true);
  let at = PACKET_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const o = i * FRAME_INTS;
    let mask = 0;
    if (sameAsPrevious(d, i)) mask = FRAME_REPEAT;
    else for (let k = 0; k < FRAME_INTS; k++) if (d[o + k] !== 0) mask |= 1 << k;
    v.setUint8(at, mask & 0xff);
    v.setUint8(at + 1, (mask >>> 8) & 0xff);
    v.setUint8(at + 2, (mask >>> 16) & 0xff);
    at += 3;
    if (mask === FRAME_REPEAT) continue;
    for (let k = 0; k < FRAME_INTS; k++) {
      if ((mask & (1 << k)) === 0) continue;
      v.setInt16(at, d[o + k]!, true);
      at += 2;
    }
  }
  return buf;
}

/** Bytes -> InputPacket, or null when the data is not a well-formed packet. Never throws. */
export function decodeInputPacket(raw: unknown): InputPacket | null {
  let v: DataView;
  if (raw instanceof ArrayBuffer) v = new DataView(raw);
  else if (ArrayBuffer.isView(raw)) v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  else return null;
  if (v.byteLength < PACKET_HEADER_BYTES || v.getUint32(0, true) !== PACKET_MAGIC) return null;
  const firstTick = v.getInt32(4, true);
  const count = v.getInt32(8, true);
  const ack = v.getInt32(12, true);
  const tick = v.getInt32(16, true);
  const adv = v.getInt32(20, true) / PACKET_ADV_SCALE;
  if (count < 1 || count > MAX_PACKET_FRAMES || firstTick < 0 || ack < -1 || tick < -1) return null;
  const len = v.byteLength;
  const data = new Int16Array(count * FRAME_INTS);
  let at = PACKET_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (at + 3 > len) return null;
    const mask = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16);
    at += 3;
    const o = i * FRAME_INTS;
    if (mask === FRAME_REPEAT) {
      if (i === 0) return null;
      for (let k = 0; k < FRAME_INTS; k++) data[o + k] = data[o - FRAME_INTS + k]!;
      continue;
    }
    if ((mask & ~FRAME_VALUE_BITS) !== 0) return null;
    for (let k = 0; k < FRAME_INTS; k++) {
      if ((mask & (1 << k)) === 0) continue;
      if (at + 2 > len) return null;
      data[o + k] = v.getInt16(at, true);
      at += 2;
    }
  }
  if (at !== len) return null;
  return { firstTick, count, ack, tick, adv, data };
}

/** Largest wire size of a packet of `count` frames (every value non-zero), bytes. */
export function inputPacketBytes(count: number): number {
  return PACKET_HEADER_BYTES + count * (3 + FRAME_INTS * 2);
}

// ---------------------------------------------------------------- control messages

export interface ControlCodec {
  /** One string per data-channel message (one, or several fragments). */
  encode(msg: ControlMessage): string[];
  /** A message, or null for a fragment of an incomplete message / malformed data. Never throws. */
  decode(raw: unknown): ControlMessage | null;
  /** Drop partial fragments (link reset). */
  reset(): void;
}

function isControlMessage(v: unknown): v is ControlMessage {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string';
}

/** Parse one control JSON string; null when malformed. */
export function parseControl(json: string): ControlMessage | null {
  try {
    const v: unknown = JSON.parse(json);
    return isControlMessage(v) ? v : null;
  } catch {
    return null;
  }
}

export function createControlCodec(maxChars = CONTROL_FRAGMENT_CHARS): ControlCodec {
  let nextId = 1;
  let partId = -1;
  let partTotal = 0;
  let parts: string[] = [];
  let partChars = 0;
  return {
    encode(msg) {
      const json = JSON.stringify(msg);
      if (json.length <= maxChars) return [json];
      const id = nextId++;
      const total = Math.ceil(json.length / maxChars);
      const out: string[] = [];
      for (let i = 0; i < total; i++) out.push(`~${id}:${i}:${total}:${json.slice(i * maxChars, (i + 1) * maxChars)}`);
      return out;
    },
    decode(raw) {
      if (typeof raw !== 'string') return null;
      if (raw.charCodeAt(0) !== 126 /* ~ */) return parseControl(raw);
      // ~id:i:n:payload. Fragments of one message arrive in order on the reliable channel.
      const a = raw.indexOf(':');
      const b = a < 0 ? -1 : raw.indexOf(':', a + 1);
      const c = b < 0 ? -1 : raw.indexOf(':', b + 1);
      if (c < 0) return null;
      const id = Number(raw.slice(1, a));
      const i = Number(raw.slice(a + 1, b));
      const total = Number(raw.slice(b + 1, c));
      if (!Number.isInteger(id) || !Number.isInteger(i) || !Number.isInteger(total) || total < 1 || i < 0 || i >= total) return null;
      if (id !== partId || i === 0) {
        partId = id;
        partTotal = total;
        parts = [];
        partChars = 0;
      }
      if (i !== parts.length || total !== partTotal) {
        partId = -1;
        parts = [];
        return null;
      }
      const piece = raw.slice(c + 1);
      partChars += piece.length;
      if (partChars > CONTROL_MAX_CHARS) {
        partId = -1;
        parts = [];
        return null;
      }
      parts.push(piece);
      if (parts.length < partTotal) return null;
      const json = parts.join('');
      partId = -1;
      parts = [];
      partChars = 0;
      return parseControl(json);
    },
    reset() {
      partId = -1;
      parts = [];
      partChars = 0;
    },
  };
}

// ---------------------------------------------------------------- errors

const REASONS: readonly NetErrorReason[] = [
  'broker-unreachable', 'code-not-found', 'room-full', 'version-mismatch', 'blocked', 'disconnected', 'code-taken', 'unsupported',
];

export function isNetErrorReason(v: unknown): v is NetErrorReason {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

/** An Error whose message is the reason (what open() / reconnect() reject with). */
export function netError(reason: NetErrorReason): Error {
  return new Error(reason);
}

/** The NetErrorReason carried by a rejection (unknown errors read as 'disconnected'). */
export function reasonOf(err: unknown): NetErrorReason {
  const m = err instanceof Error ? err.message : err;
  return isNetErrorReason(m) ? m : 'disconnected';
}

// ---------------------------------------------------------------- listeners

export interface Emitter<T> {
  on(fn: (v: T) => void): () => void;
  emit(v: T): void;
  clear(): void;
  readonly size: number;
}

/** Listener list; a throwing listener is reported to `onError` and never stops the others. */
export function createEmitter<T>(onError?: (err: unknown) => void): Emitter<T> {
  let list: ((v: T) => void)[] = [];
  return {
    on(fn) {
      list = list.concat(fn);
      return () => {
        list = list.filter((f) => f !== fn);
      };
    },
    emit(v) {
      const l = list; // copy-on-write: (un)subscribing during emit is safe
      for (let i = 0; i < l.length; i++) {
        try {
          l[i]!(v);
        } catch (err) {
          if (onError) onError(err);
          else console.error(err);
        }
      }
    },
    clear() {
      list = [];
    },
    get size() {
      return list.length;
    },
  };
}

/**
 * [NET-02] Wire codecs shared by both transports (PeerJS and in-memory) plus tiny transport helpers.
 * No network, no timers: pure functions and small objects, safe to import anywhere inside src/net.
 *
 *  - NET_PROTOCOL_VERSION: compared in the '$hello' handshake (different builds refuse to play: 'version-mismatch').
 *  - packSenderFrame / unpackSenderFrame: one human's InputFrame <-> FRAME_INTS int16 values, encoded exactly like
 *    packFrames (src/sim/core/serialize.ts) encodes one human (bitfields as uint16, other fields clamped to int16).
 *  - encodeInputPacket / decodeInputPacket: InputPacket <-> bytes (24-byte header + little-endian int16 frames).
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
export const NET_PROTOCOL_VERSION = `${GAME_VERSION}/sim${SIM_VERSION}/net1`;

/** int16 values per frame of one human on the wire. */
export const FRAME_INTS = INPUT_FIELDS.length;
/** Most frames one packet may carry (decoder limit; normal packets carry T_NET.redundancy at most). */
export const MAX_PACKET_FRAMES = 64;
/** Bytes before the frame data: magic, firstTick, count, ack, tick, adv * 16 (6 x int32, little-endian). */
export const PACKET_HEADER_BYTES = 24;
/** 'DKN2'. */
export const PACKET_MAGIC = 0x444b4e32;
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

/** InputPacket -> bytes (a fresh ArrayBuffer: data channels may queue it). Reads count * FRAME_INTS values. */
export function encodeInputPacket(p: InputPacket): ArrayBuffer {
  const count = p.count | 0;
  if (count < 1 || count > MAX_PACKET_FRAMES || p.data.length < count * FRAME_INTS) {
    throw new RangeError(`encodeInputPacket: bad count ${p.count}`);
  }
  const n = count * FRAME_INTS;
  const buf = new ArrayBuffer(PACKET_HEADER_BYTES + n * 2);
  const v = new DataView(buf);
  v.setUint32(0, PACKET_MAGIC, true);
  v.setInt32(4, p.firstTick | 0, true);
  v.setInt32(8, count, true);
  v.setInt32(12, p.ack | 0, true);
  v.setInt32(16, p.tick | 0, true);
  const adv = Math.round(p.adv * PACKET_ADV_SCALE);
  v.setInt32(20, Number.isFinite(adv) ? Math.max(-0x7fffffff, Math.min(0x7fffffff, adv)) : 0, true);
  for (let i = 0; i < n; i++) v.setInt16(PACKET_HEADER_BYTES + i * 2, p.data[i]!, true);
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
  const n = count * FRAME_INTS;
  if (v.byteLength !== PACKET_HEADER_BYTES + n * 2) return null;
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = v.getInt16(PACKET_HEADER_BYTES + i * 2, true);
  return { firstTick, count, ack, tick, adv, data };
}

/** Wire size of a packet, bytes. */
export function inputPacketBytes(count: number): number {
  return PACKET_HEADER_BYTES + count * FRAME_INTS * 2;
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

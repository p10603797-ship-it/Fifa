/**
 * Snapshots and replays. [FND-03]
 * Snapshot = JSON-safe serialisation of the full state (incl. config + squads) for online resync, recovery
 * and replay keyframes. Replay = { simVersion, config, squads hash, seed, inputs per tick } (FND-06 records).
 *
 * Snapshots round-trip bit-exactly: finite doubles survive JSON (shortest round-trip printing + correctly
 * rounded parsing), and the values JSON cannot carry are written as tagged objects:
 *   -0 -> {"$num":"-0"}, NaN -> {"$num":"NaN"}, +-Infinity -> {"$num":"Infinity"} / {"$num":"-Infinity"},
 *   typed arrays -> {"$typed":"Float64Array","v":[...]}.
 * Key order is preserved, so hashState(deserializeState(serializeState(s))) === hashState(s).
 */
import { MAX_HUMANS } from '../../contracts/constants';
import type { SimState } from '../../contracts/state';
import { INPUT_FIELDS, createInputFrame, type InputFrame } from '../../contracts/input';

const NUM_TAG = '$num';
const TYPED_TAG = '$typed';

type TypedCtor = new (values: ArrayLike<number>) => ArrayLike<number>;

/** Typed-array constructors allowed in snapshots (looked up by name; no BigInt arrays). */
function typedCtor(name: string): TypedCtor | null {
  switch (name) {
    case 'Float64Array': return Float64Array;
    case 'Float32Array': return Float32Array;
    case 'Int32Array': return Int32Array;
    case 'Uint32Array': return Uint32Array;
    case 'Int16Array': return Int16Array;
    case 'Uint16Array': return Uint16Array;
    case 'Int8Array': return Int8Array;
    case 'Uint8Array': return Uint8Array;
    case 'Uint8ClampedArray': return Uint8ClampedArray;
    default: return null;
  }
}

function replacer(_key: string, v: unknown): unknown {
  if (typeof v === 'number') {
    if (v === 0) return Object.is(v, -0) ? { [NUM_TAG]: '-0' } : 0;
    if (v !== v) return { [NUM_TAG]: 'NaN' };
    if (v === Infinity) return { [NUM_TAG]: 'Infinity' };
    if (v === -Infinity) return { [NUM_TAG]: '-Infinity' };
    return v;
  }
  if (typeof v === 'object' && v !== null && ArrayBuffer.isView(v)) {
    const name = v.constructor.name;
    if (v instanceof DataView || typedCtor(name) === null) throw new TypeError(`serializeState: unsupported ${name}`);
    return { [TYPED_TAG]: name, v: Array.from(v as unknown as ArrayLike<number>) };
  }
  return v;
}

function reviver(_key: string, v: unknown): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const num = o[NUM_TAG];
  if (typeof num === 'string') {
    switch (num) {
      case '-0': return -0;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case '-Infinity': return -Infinity;
      default: throw new SyntaxError(`deserializeState: bad number tag ${num}`);
    }
  }
  const typed = o[TYPED_TAG];
  if (typeof typed === 'string') {
    const C = typedCtor(typed);
    if (C === null || !Array.isArray(o.v)) throw new SyntaxError(`deserializeState: bad typed array ${typed}`);
    return new C(o.v as number[]);
  }
  return v;
}

/** Full snapshot (mutable state + config + squads) as a JSON string. */
export function serializeState(s: SimState): string {
  return JSON.stringify(s, replacer);
}

/** Inverse of serializeState. Throws on malformed input. */
export function deserializeState(json: string): SimState {
  const s = JSON.parse(json, reviver) as unknown;
  if (typeof s !== 'object' || s === null) throw new SyntaxError('deserializeState: not an object');
  const r = s as Record<string, unknown>;
  if (typeof r.tick !== 'number' || !Array.isArray(r.players) || typeof r.ball !== 'object' || typeof r.config !== 'object' ||
    !Array.isArray(r.squads)) {
    throw new SyntaxError('deserializeState: not a SimState snapshot');
  }
  return s as SimState;
}

// ---------------------------------------------------------------- input frames codec

/** int16 values per packed tick: MAX_HUMANS frames x INPUT_FIELDS. */
export const PACKED_FRAME_INTS = MAX_HUMANS * INPUT_FIELDS.length;

/** Bitfield fields are carried as uint16 (bit 15 safe); all other fields are signed and clamped to int16. */
function isBitField(k: string): boolean { return k === 'buttons' || k === 'gFlags'; }

const NEUTRAL = createInputFrame();

/**
 * Pack frames for all humans of one tick into a compact int array (network / replay). Writes exactly
 * PACKED_FRAME_INTS values (missing frames are written as neutral) and returns that count. Throws a
 * RangeError if `out` is too short. Allocation-free.
 */
export function packFrames(frames: readonly InputFrame[], out: Int16Array, offset: number): number {
  const nf = INPUT_FIELDS.length;
  if (offset < 0 || offset + PACKED_FRAME_INTS > out.length) throw new RangeError('packFrames: buffer too small');
  let o = offset;
  for (let hIdx = 0; hIdx < MAX_HUMANS; hIdx++) {
    const f = (frames[hIdx] ?? NEUTRAL) as unknown as Record<string, number>;
    for (let i = 0; i < nf; i++) {
      const k = INPUT_FIELDS[i]!;
      const v = f[k]!;
      out[o++] = isBitField(k) ? v & 0xffff : v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    }
  }
  return o - offset;
}

/**
 * Unpack MAX_HUMANS frames written by packFrames into `frames` (existing frame objects are reused; missing
 * entries are created). Returns the number of int16 values read (PACKED_FRAME_INTS). Throws a RangeError
 * if `src` is too short.
 */
export function unpackFrames(src: Int16Array, offset: number, frames: InputFrame[]): number {
  const nf = INPUT_FIELDS.length;
  if (offset < 0 || offset + PACKED_FRAME_INTS > src.length) throw new RangeError('unpackFrames: buffer too small');
  let o = offset;
  for (let hIdx = 0; hIdx < MAX_HUMANS; hIdx++) {
    if (frames[hIdx] === undefined) frames[hIdx] = createInputFrame();
    const f = frames[hIdx] as unknown as Record<string, number>;
    for (let i = 0; i < nf; i++) {
      const k = INPUT_FIELDS[i]!;
      const v = src[o++]!;
      f[k] = isBitField(k) ? v & 0xffff : v;
    }
  }
  return o - offset;
}

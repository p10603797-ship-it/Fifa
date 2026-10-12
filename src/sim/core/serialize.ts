/**
 * Snapshots and replays. [FND-03]
 * Snapshot = JSON-safe serialisation of the full state (incl. config + squads) for online resync, recovery
 * and replay keyframes. Replay = { simVersion, config, squads hash, seed, inputs per tick } (FND-06 records).
 *
 * Snapshots round-trip bit-exactly: finite doubles survive JSON (shortest round-trip printing + correctly
 * rounded parsing), and the values JSON cannot carry are written as tagged objects:
 *   -0 -> {"$num":"-0"}, NaN -> {"$num":"NaN"}, +-Infinity -> {"$num":"Infinity"} / {"$num":"-Infinity"},
 *   undefined (object value or array element) -> {"$undef":1},
 *   typed arrays -> {"$typed":"Float64Array","v":[...]}.
 * Functions, symbols and BigInts cannot be carried and make serializeState throw a TypeError.
 * Key order is preserved, so hashState(deserializeState(serializeState(s))) === hashState(s).
 *
 * Snapshots arrive from the network (online resync), so deserializeState is defensive: a "__proto__" key
 * anywhere, a wrong version or a missing / mistyped top-level member is a SyntaxError.
 */
import { MAX_HUMANS, NUM_CONTROLLERS, NUM_SLOTS, SIM_VERSION } from '../../contracts/constants';
import type { SimState } from '../../contracts/state';
import { INPUT_FIELDS, createInputFrame, type InputFrame } from '../../contracts/input';

const NUM_TAG = '$num';
const TYPED_TAG = '$typed';
const UNDEF_TAG = '$undef';

/**
 * Placeholder the reviver returns for {"$undef":1}: returning undefined itself would delete the key. Each
 * container swaps its placeholders back to undefined when the reviver reaches it (children come first).
 */
const UNDEF_MARK: object = Object.freeze({});

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

function replacer(key: string, v: unknown): unknown {
  if (v === undefined) return { [UNDEF_TAG]: 1 };
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
    throw new TypeError(`serializeState: unsupported ${typeof v} at key "${key}"`);
  }
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

function reviver(key: string, v: unknown): unknown {
  // JSON.parse keeps "__proto__" as an own key; any later generic walk would assign through the accessor.
  if (key === '__proto__') throw new SyntaxError('deserializeState: forbidden key "__proto__"');
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (v[i] === UNDEF_MARK) v[i] = undefined;
    return v;
  }
  const o = v as Record<string, unknown>;
  if (o[UNDEF_TAG] === 1) return UNDEF_MARK;
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
  for (const k in o) if (o[k] === UNDEF_MARK) o[k] = undefined;
  return v;
}

/** Non-null, non-array plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

/** Array of exactly `len` plain objects. */
function isRecordArray(v: unknown, len: number): boolean {
  if (!Array.isArray(v) || v.length !== len) return false;
  for (let i = 0; i < len; i++) if (!isRecord(v[i])) return false;
  return true;
}

/**
 * Top-level shape check of a parsed snapshot; returns the reason it is not a SimState, or null. Checks types
 * and fixed lengths only, never values: a snapshot must reproduce the sender's state exactly, whatever it is.
 */
function snapshotProblem(r: Record<string, unknown>): string | null {
  if (r.version !== SIM_VERSION) return `version ${String(r.version)} != SIM_VERSION ${SIM_VERSION}`;
  if (typeof r.tick !== 'number') return 'bad tick';
  const rng = r.rng;
  if (!isRecord(rng) || typeof rng.a !== 'number' || typeof rng.b !== 'number' || typeof rng.c !== 'number' ||
    typeof rng.d !== 'number') return 'bad rng';
  if (!isRecord(r.match)) return 'bad match';
  if (!isRecord(r.ball)) return 'bad ball';
  if (!isRecordArray(r.players, NUM_SLOTS)) return 'bad players';
  if (!isRecordArray(r.attrs, NUM_SLOTS)) return 'bad attrs';
  if (!isRecordArray(r.teams, 2)) return 'bad teams';
  if (!isRecordArray(r.ctrl, NUM_CONTROLLERS)) return 'bad ctrl';
  if (!isRecord(r.config)) return 'bad config';
  const sq = r.squads;
  if (!Array.isArray(sq) || sq.length !== 2) return 'bad squads';
  for (let t = 0; t < 2; t++) {
    const team: unknown = sq[t];
    if (!Array.isArray(team) || !isRecordArray(team, team.length)) return 'bad squads';
  }
  return null;
}

/** Full snapshot (mutable state + config + squads) as a JSON string. */
export function serializeState(s: SimState): string {
  return JSON.stringify(s, replacer);
}

/**
 * Inverse of serializeState. Throws a SyntaxError on malformed JSON, a "__proto__" key, a version other
 * than SIM_VERSION, or a missing / mistyped top-level member (fixed array lengths included). Members below
 * the top level are not checked field by field.
 */
export function deserializeState(json: string): SimState {
  const s = JSON.parse(json, reviver) as unknown;
  if (!isRecord(s)) throw new SyntaxError('deserializeState: not an object');
  const problem = snapshotProblem(s);
  if (problem !== null) throw new SyntaxError(`deserializeState: not a SimState snapshot (${problem})`);
  return s as unknown as SimState;
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
 * RangeError if `offset` is not a non-negative integer or `out` is too short. Allocation-free.
 */
export function packFrames(frames: readonly InputFrame[], out: Int16Array, offset: number): number {
  const nf = INPUT_FIELDS.length;
  if (!Number.isInteger(offset) || offset < 0 || offset + PACKED_FRAME_INTS > out.length) {
    throw new RangeError('packFrames: offset must be a non-negative integer with room for PACKED_FRAME_INTS');
  }
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
 * if `offset` is not a non-negative integer or `src` is too short.
 */
export function unpackFrames(src: Int16Array, offset: number, frames: InputFrame[]): number {
  const nf = INPUT_FIELDS.length;
  if (!Number.isInteger(offset) || offset < 0 || offset + PACKED_FRAME_INTS > src.length) {
    throw new RangeError('unpackFrames: offset must be a non-negative integer with PACKED_FRAME_INTS after it');
  }
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

/**
 * Deterministic state hash. [FND-03]
 * Walks the mutable part of SimState (skips IMMUTABLE_STATE_KEYS) in key-insertion order and hashes every
 * number by its float64 bit pattern (murmur3-style 32-bit word mixing). Same seed + inputs => same hash in
 * every engine.
 *
 * Details:
 *  - Numbers: -0 is hashed as +0 and every NaN as one canonical NaN; otherwise the exact float64 bits
 *    (low word, then high word) are mixed, so 0.1 + 0.2 and 0.3 hash differently.
 *  - Structure is hashed too: arrays mix a tag and their length, objects mix begin/end tags, so moving a
 *    value between nesting levels changes the hash.
 *  - hashState does not hash key names (layout is fixed by contracts/state.ts + SIM_VERSION) for speed;
 *    hashValue does (general plain data such as configs, squads or replay headers).
 *  - No allocation per number: one preallocated Float64Array with a Uint32Array view.
 */
import { IMMUTABLE_STATE_KEYS, type SimState } from '../../contracts/state';
import { INPUT_FIELDS, type InputFrame } from '../../contracts/input';

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
F64[0] = 1;
/** Index of the high (sign/exponent) word in U32 for this platform's byte order. */
const HI = U32[1] === 0x3ff00000 ? 1 : 0;
const LO = 1 - HI;

const TAG_ARRAY = 0x41525259;
const TAG_TYPED = 0x54595044;
const TAG_OBJECT = 0x4f424a42;
const TAG_END = 0x454e4421;
const TAG_STRING = 0x53545247;
const TAG_TRUE = 0x54525545;
const TAG_FALSE = 0x46414c53;
const TAG_NULL = 0x4e554c4c;
const TAG_UNDEFINED = 0x554e4446;
const TAG_OTHER = 0x4f544852;
const CANON_NAN_HI = 0x7ff80000;

/** Default seed for every hash function. */
export const HASH_SEED = 0x5f3759df;

// Running hash state (module scratch; the walkers are synchronous and not re-entrant across calls).
let h = 0;
let words = 0;
let withKeys = false;

function begin(seed: number): void {
  h = seed | 0;
  words = 0;
}

/** murmur3 32-bit block mix of one uint32 word. */
function mixWord(w: number): void {
  let k = Math.imul(w | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  words++;
}

/** murmur3 finaliser (avalanche). Returns a uint32. */
function finish(): number {
  let x = h ^ (words << 2);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Mix a number by its float64 bits (-0 -> +0, NaN canonical). */
function mixNumber(v: number): void {
  if (v === 0) { mixWord(0); mixWord(0); return; }
  if (v !== v) { mixWord(0); mixWord(CANON_NAN_HI); return; }
  F64[0] = v;
  mixWord(U32[LO]!);
  mixWord(U32[HI]!);
}

function mixString(str: string): void {
  mixWord(TAG_STRING);
  mixWord(str.length);
  for (let i = 0; i < str.length; i++) mixWord(str.charCodeAt(i));
}

function walk(v: unknown): void {
  if (typeof v === 'number') { mixNumber(v); return; }
  if (typeof v === 'object') {
    if (v === null) { mixWord(TAG_NULL); return; }
    if (Array.isArray(v)) {
      const n = v.length;
      mixWord(TAG_ARRAY);
      mixWord(n);
      for (let i = 0; i < n; i++) {
        const e: unknown = v[i];
        if (typeof e === 'number') mixNumber(e); else walk(e);
      }
      return;
    }
    if (ArrayBuffer.isView(v)) { walkView(v); return; }
    mixWord(TAG_OBJECT);
    const o = v as Record<string, unknown>;
    for (const k in o) {
      if (withKeys) mixString(k);
      const e = o[k];
      if (typeof e === 'number') mixNumber(e); else walk(e);
    }
    mixWord(TAG_END);
    return;
  }
  if (typeof v === 'boolean') { mixWord(v ? TAG_TRUE : TAG_FALSE); return; }
  if (typeof v === 'string') { mixString(v); return; }
  if (v === undefined) { mixWord(TAG_UNDEFINED); return; }
  if (typeof v === 'bigint') { mixWord(TAG_OTHER); mixString(v.toString()); return; }
  // Functions / symbols are not plain data: contribute a fixed tag so hashing never throws mid-match.
  mixWord(TAG_OTHER);
}

function walkView(v: ArrayBufferView): void {
  if (v instanceof DataView) {
    mixWord(TAG_TYPED);
    mixWord(v.byteLength);
    for (let i = 0; i < v.byteLength; i++) mixWord(v.getUint8(i));
    return;
  }
  const a = v as unknown as ArrayLike<number | bigint>;
  const n = a.length;
  mixWord(TAG_TYPED);
  mixWord(n);
  for (let i = 0; i < n; i++) {
    const e = a[i]!;
    if (typeof e === 'number') mixNumber(e); else walk(e);
  }
}

function isImmutableKey(k: string): boolean {
  for (let i = 0; i < IMMUTABLE_STATE_KEYS.length; i++) if (IMMUTABLE_STATE_KEYS[i] === k) return true;
  return false;
}

/** Hash of the mutable part of the state (config and squads are skipped). Uint32. Allocation-free. */
export function hashState(s: SimState): number {
  begin(HASH_SEED);
  withKeys = false;
  mixWord(TAG_OBJECT);
  const o = s as unknown as Record<string, unknown>;
  for (const k in o) {
    if (isImmutableKey(k)) continue;
    const e = o[k];
    if (typeof e === 'number') mixNumber(e); else walk(e);
  }
  mixWord(TAG_END);
  return finish();
}

/** Hash any plain data value (objects incl. key names, arrays, typed arrays, numbers, strings, booleans). */
export function hashValue(v: unknown, seed: number = HASH_SEED): number {
  begin(seed);
  withKeys = true;
  walk(v);
  withKeys = false;
  return finish();
}

/** Hash one input frame over INPUT_FIELDS (fixed order, independent of key insertion order). */
export function hashInputFrame(f: InputFrame, seed: number = HASH_SEED): number {
  begin(seed);
  const r = f as unknown as Record<string, number>;
  for (let i = 0; i < INPUT_FIELDS.length; i++) mixNumber(r[INPUT_FIELDS[i]!]!);
  return finish();
}

/** Hex string for logs. */
export function hashHex(h: number): string { return (h >>> 0).toString(16).padStart(8, '0'); }

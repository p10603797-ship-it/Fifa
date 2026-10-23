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
 *  - [QF-7S / TUN-7S] hashState runs a hasher generated per state shape (explicit named loads: no boxed doubles in V8)
 *    that mixes the same words; the generic walk stays as the fallback (see "specialised hashState").
 *  - An own "__proto__" key (JSON.parse output only) is skipped, matching clone.ts, which never copies it.
 */
import { IMMUTABLE_STATE_KEYS, type SimState } from '../../contracts/state';
import { INPUT_FIELDS, type InputFrame } from '../../contracts/input';
import { stateShapeIndex } from './clone';

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
/** Skipped by every object walk (clone.ts never copies it either). */
const PROTO_KEY = '__proto__';

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
      if (k === PROTO_KEY) continue;
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

// ---------------------------------------------------------------- specialised hashState [QF-7S / TUN-7S]
//
// The generic walk reads every field through the for-in keyed load, and V8 boxes every double read that way: ~10 KB per
// hashState of a live state (the replay recorder hashes every REPLAY_HASH_INTERVAL ticks of every match, net desync
// checks every T_NET.hashInterval). A hasher with explicit named loads (`F64[0] = o["x"]`) runs as optimised code that
// moves the raw double. It is generated once per state shape from the state's own keys (no hand-kept field list) with
// `new Function`; without it (a CSP that forbids eval) hashState stays on the generic walk. It mixes exactly the words
// the generic walk mixes, in the same order (tags, lengths, number bits with -0 as +0 and one canonical NaN), so the
// hash is identical; a state uses it only after it matched the shape (clone.ts stateShapeIndex: every key in order, value
// kind and array length, checked by a generated checker or the signature), and states keep their shape for life.

/** mixNumber of the value already in F64[0] (no double crosses the call). */
function mixF64(): void {
  const v = F64[0]!;
  if (v === 0) { mixWord(0); mixWord(0); return; }
  if (v !== v) { mixWord(0); mixWord(CANON_NAN_HI); return; }
  mixWord(U32[LO]!);
  mixWord(U32[HI]!);
}

type Hasher = (o: unknown) => void;
interface HashGen { fns: string[]; sigs: string[]; names: string[] }

function hashObjSig(v: Record<string, unknown>, root: boolean): string {
  let out = root ? 'R{' : '{';
  for (const k in v) {
    const e = v[k];
    out += `${JSON.stringify(k)}:${root && isImmutableKey(k) ? 'I' : valueSig(e)},`;
  }
  return `${out}}`;
}

function valueSig(e: unknown): string {
  if (typeof e === 'number') return 'n';
  if (Array.isArray(e)) {
    let out = `[${e.length}:`;
    for (let i = 0; i < e.length; i++) out += `${valueSig(e[i])},`;
    return `${out}]`;
  }
  return hashObjSig(e as Record<string, unknown>, false);
}

/** Generated "x is a plain object" test (the only values a generated per-shape hasher may be handed). */
function isPlainExpr(v: string): string {
  return `(${v} !== null && typeof ${v} === 'object' && !Array.isArray(${v}) && !ArrayBuffer.isView(${v}))`;
}

/**
 * [TUN-7S skeptic] Every generated load is guarded by the kind the shape had when it was validated: a number slot that
 * later holds a boolean / undefined / string / object, an object slot that later holds null, an array slot that holds
 * anything else go through the generic walk for that value, so the hash stays the generic walk's (and never throws:
 * "hashing never throws mid-match") instead of coercing the value to a double. In optimised code the typeof guard on a
 * double field folds away.
 */
function genHashObject(g: HashGen, v: Record<string, unknown>, root: boolean): string {
  const sig = hashObjSig(v, root);
  for (let i = 0; i < g.sigs.length; i++) if (g.sigs[i] === sig) return g.names[i]!;
  const name = `h${g.names.length}`;
  g.sigs.push(sig);
  g.names.push(name);
  let body = `mw(${TAG_OBJECT});\n`;
  let n = 0;
  for (const k in v) {
    if (root && isImmutableKey(k)) continue;
    const e = v[k];
    const p = `[${JSON.stringify(k)}]`;
    if (typeof e === 'number') body += `{ const x = o${p}; if (typeof x === 'number') { F64[0] = x; mf(); } else walk(x); }\n`;
    else if (Array.isArray(e)) {
      const a = `a${n++}`;
      body += `{ const ${a} = o${p}; if (!Array.isArray(${a})) walk(${a}); else { const n = ${a}.length; mw(${TAG_ARRAY}); mw(n);\n`;
      let allNum = true;
      let elem: string | null = null;
      let uniform = e.length > 0;
      for (let i = 0; i < e.length; i++) {
        const x: unknown = e[i];
        if (typeof x === 'number') { uniform = false; continue; }
        allNum = false;
        if (typeof x !== 'object' || x === null || Array.isArray(x) || ArrayBuffer.isView(x)) { uniform = false; continue; }
        const xs = hashObjSig(x as Record<string, unknown>, false);
        if (elem === null) elem = xs; else if (elem !== xs) uniform = false;
      }
      if (!allNum && uniform) {
        const fn = genHashObject(g, e[0] as Record<string, unknown>, false);
        body += `for (let i = 0; i < n; i++) { const x = ${a}[i]; if (${isPlainExpr('x')}) ${fn}(x); else walk(x); }\n`;
      } else body += `for (let i = 0; i < n; i++) { const x = ${a}[i]; if (typeof x === 'number') { F64[0] = x; mf(); } else walk(x); }\n`;
      body += '} }\n';
    } else {
      const fn = genHashObject(g, e as Record<string, unknown>, false);
      body += `{ const x = o${p}; if (${isPlainExpr('x')}) ${fn}(x); else walk(x); }\n`;
    }
  }
  body += `mw(${TAG_END});\n`;
  g.fns.push(`function ${name}(o) {\n${body}}\n`);
  return name;
}

/** Compiled hashers by clone.ts shape index (stateShapeIndex: the shape registry shared with copyState). */
const hasherFns: (Hasher | null)[] = [];
let hashCodegenOff = 0;
/** States already validated against a compiled hasher (small ring; null fn = generic). */
const H_RING = 6;
const hState: (SimState | null)[] = new Array<SimState | null>(H_RING).fill(null);
const hFn: (Hasher | null)[] = new Array<Hasher | null>(H_RING).fill(null);
let hNext = 0;

/**
 * The hasher of shape `k` (generated from `s`, which has that shape), compiled on first use; null when `new Function` is
 * unavailable.
 */
function hasherOfShape(k: number, s: SimState): Hasher | null {
  const have = k < hasherFns.length ? hasherFns[k] : undefined;
  if (have !== undefined && have !== null) return have;
  if (hashCodegenOff) return null;
  const g: HashGen = { fns: [], sigs: [], names: [] };
  const root = genHashObject(g, s as unknown as Record<string, unknown>, true);
  try {
    const make = new Function('mw', 'mf', 'F64', 'walk', `'use strict';\n${g.fns.join('')}return ${root};`) as
      (mw: (w: number) => void, mf: () => void, f64: Float64Array, walk: (v: unknown) => void) => Hasher;
    const fn = make(mixWord, mixF64, F64, walk);
    while (hasherFns.length <= k) hasherFns.push(null);
    hasherFns[k] = fn;
    return fn;
  } catch {
    hashCodegenOff = 1;
    return null;
  }
}

function hasherFor(s: SimState): Hasher | null {
  for (let i = 0; i < H_RING; i++) if (hState[i] === s) return hFn[i]!;
  // [TUN-7S skeptic] A state of a compiled shape is recognised by clone.ts's generated shape checker (no signature string:
  // the first hash of each match's new state cost a ~28 KB signature, ~0.6 ms warm and several ms cold, plus regenerating
  // the hasher's code, ~2 ms, even when it was compiled).
  const k = hashCodegenOff ? -1 : stateShapeIndex(s);
  const fn = k >= 0 ? hasherOfShape(k, s) : null;
  hState[hNext] = s;
  hFn[hNext] = fn;
  hNext = (hNext + 1) % H_RING;
  return fn;
}

/**
 * [TUN-7S skeptic] Generate and compile the hasher for `s`'s shape now (sim/init.ts initMatch: on the loading screen)
 * instead of inside the first hashState of the first match (~13 ms in a cold process, HEAD's generic first hash
 * ~2.3 ms: a hitch on an early tick of play). Once per process, like clone.ts primeStateCodegen; states are still
 * validated on their first hash.
 */
export function primeHashCodegen(s: SimState): void {
  if (hashCodegenOff || hasherFns.length > 0) return;
  const k = stateShapeIndex(s);
  const fn = k >= 0 ? hasherOfShape(k, s) : null;
  if (fn === null) return;
  // Run it once (its inner functions' bytecode is compiled on first call); the result is discarded.
  begin(HASH_SEED);
  withKeys = false;
  fn(s);
  finish();
}

/** True when hashState(s) runs the specialised hasher (tests, perf reports). */
export function hashStateIsSpecialised(s: SimState): boolean {
  return hasherFor(s) !== null;
}

/** Forget validated states (tests that reshape a state in place after hashing it). */
export function resetHashStateCache(): void {
  for (let i = 0; i < H_RING; i++) { hState[i] = null; hFn[i] = null; }
  hNext = 0;
}

/** Hash of the mutable part of the state (config and squads are skipped). Uint32. Allocation-free. */
export function hashState(s: SimState): number {
  const fn = hasherFor(s);
  if (fn !== null) {
    begin(HASH_SEED);
    withKeys = false;
    fn(s);
    return finish();
  }
  return hashStateGeneric(s);
}

/** The generic walk of hashState (its fallback; same hash). */
export function hashStateGeneric(s: SimState): number {
  begin(HASH_SEED);
  withKeys = false;
  mixWord(TAG_OBJECT);
  const o = s as unknown as Record<string, unknown>;
  for (const k in o) {
    if (k === PROTO_KEY || isImmutableKey(k)) continue;
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

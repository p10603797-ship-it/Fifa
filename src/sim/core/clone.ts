/**
 * State cloning without per-tick allocation. [FND-03]
 * copyState(dst, src) copies every mutable field (deep, arrays in place); IMMUTABLE_STATE_KEYS are copied
 * by reference. cloneState allocates a fresh deep copy (snapshots, tests, replay keyframes).
 *
 * Both walk the state generically in key-insertion order, so they follow contracts/state.ts without a
 * hand-maintained field list and preserve the hash order (hashState(cloneState(s)) === hashState(s)).
 * [QF-7S / TUN-7S] copyState runs a copier generated per state shape (explicit named accesses: no boxed doubles in
 * V8) once both states' shapes are validated; the generic walk stays as the fallback (see "specialised copier").
 *
 * An own "__proto__" key (only JSON.parse creates one; deserializeState rejects it) is skipped by every
 * walker here and in hash.ts: assigning it would re-parent the copy or, through copyInto(Object.prototype, e),
 * pollute every object in the app.
 */
import { IMMUTABLE_STATE_KEYS, type SimState } from '../../contracts/state';

type Rec = Record<string, unknown>;

/** The one key the walkers never copy, compare or hash (see the module doc). */
const PROTO_KEY = '__proto__';

function isImmutableKey(k: string): boolean {
  for (let i = 0; i < IMMUTABLE_STATE_KEYS.length; i++) if (IMMUTABLE_STATE_KEYS[i] === k) return true;
  return false;
}

function isTypedArray(v: object): v is ArrayBufferView & ArrayLike<number> {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** Deep copy of plain data (objects keep key insertion order; typed arrays keep their type). */
function cloneValue(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      const e: unknown = v[i];
      out.push(typeof e === 'object' && e !== null ? cloneValue(e) : e);
    }
    return out;
  }
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    return (v as unknown as { slice(): unknown }).slice();
  }
  const src = v as Rec;
  const out: Rec = {};
  for (const k in src) {
    if (k === PROTO_KEY) continue;
    const e = src[k];
    out[k] = typeof e === 'object' && e !== null ? cloneValue(e) : e;
  }
  return out;
}

/**
 * Copy src into d in place when the shapes match and return d; otherwise return a fresh clone of src
 * (allocates only on a shape mismatch: missing nested object, array length change, type change).
 */
function copyInto(d: unknown, s: object): unknown {
  if (typeof d !== 'object' || d === null) return cloneValue(s);
  if (Array.isArray(s)) {
    if (!Array.isArray(d)) return cloneValue(s);
    const n = s.length;
    if (d.length !== n) d.length = n;
    for (let i = 0; i < n; i++) {
      const e: unknown = s[i];
      d[i] = typeof e === 'object' && e !== null ? copyInto(d[i], e) : e;
    }
    return d;
  }
  if (isTypedArray(s)) {
    if (!isTypedArray(d) || d.constructor !== s.constructor || d.length !== s.length) return cloneValue(s);
    (d as unknown as { set(a: ArrayLike<number>): void }).set(s);
    return d;
  }
  if (Array.isArray(d) || ArrayBuffer.isView(d) || ArrayBuffer.isView(s)) return cloneValue(s);
  const so = s as Rec;
  const dobj = d as Rec;
  for (const k in so) {
    const e = so[k];
    // Hot path: only object/null values need the "__proto__" check (its setter ignores primitives).
    if (typeof e !== 'object') dobj[k] = e;
    else if (k !== PROTO_KEY) dobj[k] = e === null ? e : copyInto(dobj[k], e);
  }
  return d;
}

/** Fresh deep copy of the mutable part; config and squads are shared by reference. */
export function cloneState(s: SimState): SimState {
  const src = s as unknown as Rec;
  const out: Rec = {};
  for (const k in src) {
    if (k === PROTO_KEY) continue;
    const e = src[k];
    out[k] = isImmutableKey(k) || typeof e !== 'object' || e === null ? e : cloneValue(e);
  }
  return out as unknown as SimState;
}

/** The generic walk (fallback of copyState; also used when no specialised copier applies). */
export function copyStateGeneric(dst: SimState, src: SimState): void {
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (const k in s) {
    const e = s[k];
    if (typeof e !== 'object') d[k] = e; // primitives: the "__proto__" setter ignores them
    else if (k === PROTO_KEY) continue;
    else if (isImmutableKey(k) || e === null) d[k] = e;
    else d[k] = copyInto(d[k], e);
  }
}

// ---------------------------------------------------------------- specialised copier [QF-7S / TUN-7S]
//
// Why: the generic walk reads every field through the for-in keyed load, and V8 boxes every double read that way (a
// fresh 16-byte heap number per double field: ~10.4 KB per copyState of a live match, the app loop's largest steady
// allocation). A copier with explicit named accesses (`d["x"] = s["x"]`) runs as optimised code that moves the raw
// double, so it allocates nothing. It is generated once per state shape from the state's own keys (no hand-kept field
// list: it follows contracts/state.ts) with `new Function`; where that is unavailable (a CSP without 'unsafe-eval')
// copyState stays on the generic walk.
//
// Safety: a (dst, src) pair uses the generated copier only after both states' full shape signatures (every key, value
// kind and array length, in order) matched the shape the copier was built from; the last few validated pairs are
// remembered, so the app loop's (prev, curr) validates once per match. States keep their shape for life (the sim never
// adds, removes or retypes fields: contracts/state.ts), and the generated code still guards every value's kind and every
// array length (a value whose kind changed since validation, or an array whose length did, is copied by the generic
// copyInto). The result is exactly the generic walk's: same values, no shared nested references, same key order; the one
// assumption left is that a nested plain object keeps its key set (TypeScript's state types; nothing deletes a field).

type Copier = (d: unknown, s: unknown, copyInto: (d: unknown, s: object) => unknown) => void;

/** Shape signature: every key, value kind and array length in walk order (allocates; new pairs only). */
function shapeSig(v: unknown, root: boolean): string {
  if (typeof v !== 'object') return typeof v === 'number' ? 'n' : `?${typeof v}`;
  if (v === null) return '?null';
  if (ArrayBuffer.isView(v)) return '?view';
  if (Array.isArray(v)) {
    let out = `[${v.length}:`;
    for (let i = 0; i < v.length; i++) out += `${shapeSig(v[i], false)},`;
    return `${out}]`;
  }
  let out = '{';
  const o = v as Rec;
  for (const k in o) {
    if (k === PROTO_KEY) return '?proto';
    out += `${JSON.stringify(k)}:${root && isImmutableKey(k) ? 'R' : shapeSig(o[k], false)},`;
  }
  return `${out}}`;
}

/** Code generator state: one function per distinct object shape. */
interface Gen { fns: string[]; bySig: string[]; names: string[] }

function prop(k: string): string {
  return `[${JSON.stringify(k)}]`;
}

/**
 * Generated test "v is a plain object" (not null, not an array, not a typed array / DataView): the only values the
 * generated per-shape functions may be handed. [TUN-7S skeptic] Every generated access is guarded by the kind the shape
 * had when it was validated, so a value that later changes kind (a number slot given an object, an object slot null)
 * takes the generic copyInto path for that value: the result stays exactly the generic walk's (no shared reference, no
 * TypeError) instead of relying on the sim never doing it. In optimised code the guard on a double field folds away.
 */
function isPlainExpr(v: string): string {
  return `(${v} !== null && typeof ${v} === 'object' && !Array.isArray(${v}) && !ArrayBuffer.isView(${v}))`;
}

/** Statement copying the value `x` (already read from src) into `dst` (an lvalue), with the generic walk's semantics. */
function genericStore(dst: string, x: string): string {
  return `${dst} = typeof ${x} === 'object' && ${x} !== null ? ci(${dst}, ${x}) : ${x};`;
}

/** Name of the generated function copying objects of `v`'s shape (generated on first use). */
function genObject(g: Gen, v: Rec, root: boolean): string {
  const sig = shapeSig(v, root);
  for (let i = 0; i < g.bySig.length; i++) if (g.bySig[i] === sig) return g.names[i]!;
  const name = `c${g.names.length}`;
  g.bySig.push(sig);
  g.names.push(name);
  let body = '';
  let n = 0;
  for (const k in v) {
    const e = v[k];
    const p = prop(k);
    if (root && isImmutableKey(k)) body += `d${p} = s${p};\n`;
    // A primitive slot: copied as is unless it now holds an object (then deep-copied, as the generic walk does).
    else if (typeof e !== 'object') body += `{ const x = s${p}; if (typeof x !== 'object' || x === null) d${p} = x; else d${p} = ci(d${p}, x); }\n`;
    else if (Array.isArray(e)) body += genArray(g, e, p, n++);
    else {
      const fn = genObject(g, e as Rec, false);
      body += `{ const x = s${p}; const y = d${p}; if (${isPlainExpr('x')} && ${isPlainExpr('y')}) ${fn}(y, x, ci); else { ${genericStore(`d${p}`, 'x')} } }\n`;
    }
  }
  g.fns.push(`function ${name}(d, s, ci) {\n${body}}\n`);
  return name;
}

/** Statements copying the array at `d<p>` from `s<p>` (kind and length guarded; any mismatch -> generic copy). */
function genArray(g: Gen, a: unknown[], p: string, n: number): string {
  const sa = `sa${n}`;
  const da = `da${n}`;
  let out = `{ const ${sa} = s${p}; const ${da} = d${p};\n`;
  out += `if (!Array.isArray(${sa}) || !Array.isArray(${da}) || ${da}.length !== ${sa}.length) { ${genericStore(`d${p}`, sa)} }\nelse {\n`;
  let allNum = true;
  let elemSig: string | null = null;
  let uniform = a.length > 0;
  for (let i = 0; i < a.length; i++) {
    const e = a[i];
    if (typeof e === 'number') { uniform = false; continue; } // [TUN-7S skeptic] a number before the first object counted as uniform
    allNum = false;
    if (typeof e !== 'object' || e === null || Array.isArray(e) || ArrayBuffer.isView(e)) { uniform = false; continue; }
    const sig = shapeSig(e, false);
    if (elemSig === null) elemSig = sig;
    else if (elemSig !== sig) uniform = false;
  }
  if (!allNum && uniform && elemSig !== null) {
    const fn = genObject(g, a[0] as Rec, false);
    out += `for (let i = 0; i < ${sa}.length; i++) { const e = ${sa}[i]; const f = ${da}[i]; if (${isPlainExpr('e')} && ${isPlainExpr('f')}) ${fn}(f, e, ci); else { ${genericStore(`${da}[i]`, 'e')} } }\n`;
  } else {
    // Numbers (every array in today's state but the object lists) or mixed elements: per-element generic semantics.
    out += `for (let i = 0; i < ${sa}.length; i++) { const e = ${sa}[i]; ${genericStore(`${da}[i]`, 'e')} }\n`;
  }
  out += '}\n}\n';
  return out;
}

/** Compiled copiers by root shape signature (a handful at most: states of one SIM_VERSION share one shape). */
const compiledSig: string[] = [];
const compiledFn: (Copier | null)[] = [];
/** 1 once `new Function` was found unavailable (CSP): every copy stays generic. */
let codegenUnavailable = 0;

/** Validated (dst, src) pairs and their copier (small ring). */
const PAIR_RING = 6;
const pairDst: (SimState | null)[] = new Array<SimState | null>(PAIR_RING).fill(null);
const pairSrc: (SimState | null)[] = new Array<SimState | null>(PAIR_RING).fill(null);
const pairFn: (Copier | null)[] = new Array<Copier | null>(PAIR_RING).fill(null);
let pairNext = 0;

function compile(src: SimState, sig: string): Copier | null {
  if (codegenUnavailable) return null;
  const g: Gen = { fns: [], bySig: [], names: [] };
  const root = genObject(g, src as unknown as Rec, true);
  try {
    const make = new Function(`'use strict';\n${g.fns.join('')}return ${root};`) as () => Copier;
    const fn = make();
    compiledSig.push(sig);
    compiledFn.push(fn);
    return fn;
  } catch {
    codegenUnavailable = 1;
    return null;
  }
}

/** The specialised copier for this pair, or null (shapes differ / unsupported / no codegen). Allocates only on a new pair. */
function copierFor(dst: SimState, src: SimState): Copier | null {
  for (let i = 0; i < PAIR_RING; i++) if (pairDst[i] === dst && pairSrc[i] === src) return pairFn[i]!;
  if (codegenUnavailable) return null;
  const sig = shapeSig(src, true);
  let fn: Copier | null = null;
  if (sig.indexOf('?') < 0 && shapeSig(dst, true) === sig) {
    for (let i = 0; i < compiledSig.length; i++) if (compiledSig[i] === sig) fn = compiledFn[i]!;
    if (fn === null) fn = compile(src, sig);
  }
  pairDst[pairNext] = dst;
  pairSrc[pairNext] = src;
  pairFn[pairNext] = fn;
  pairNext = (pairNext + 1) % PAIR_RING;
  return fn;
}

/**
 * Shape signature of a state: every key, value kind and array length in walk order (immutable keys as references).
 * Contains '?' when some value is not a number / plain object / array (null, string, typed array, own "__proto__"...).
 * Allocates (a string); for one-off validation (hash.ts's specialised hasher). [TUN-7S]
 */
export function stateShapeSignature(s: SimState): string {
  return shapeSig(s, true);
}

/**
 * [TUN-7S skeptic] Generate and compile the copier for `s`'s shape now (sim/init.ts initMatch: on the loading screen)
 * instead of inside the first copyState(prev, curr) of the first match: generating and compiling cost ~11 ms there in a
 * cold process (HEAD's generic first copy ~0.85 ms), a hitch on the first tick of play (x4 on an iPad). Once per process:
 * after a copier exists this returns at once (every state of one SIM_VERSION has the same shape; a state of another
 * shape still compiles lazily on its first copy). Pairs are still validated on first use: nothing is assumed about `s`.
 */
export function primeStateCodegen(s: SimState): void {
  if (codegenUnavailable || compiledFn.length > 0) return;
  const sig = shapeSig(s, true);
  if (sig.indexOf('?') < 0) compile(s, sig);
}

/** Forget validated pairs (tests that reshape a state in place after copying it). */
export function resetCopyStateCache(): void {
  for (let i = 0; i < PAIR_RING; i++) { pairDst[i] = null; pairSrc[i] = null; pairFn[i] = null; }
  pairNext = 0;
}

/** True when copyState(dst, src) runs the specialised copier (tests, perf reports). */
export function copyStateIsSpecialised(dst: SimState, src: SimState): boolean {
  return copierFor(dst, src) !== null;
}

/**
 * Copy src into dst in place (the interpolation snapshot before each tick). Allocation-free when dst has
 * the same shape as src (any state made by createSimState/initMatch/cloneState). Immutable keys are
 * assigned by reference. Keys present only in dst are left untouched.
 */
export function copyState(dst: SimState, src: SimState): void {
  const fn = dst === src ? null : copierFor(dst, src);
  if (fn !== null) fn(dst, src, copyInto);
  else copyStateGeneric(dst, src);
}

// ---------------------------------------------------------------- diff (debug / desync reports)

/** Path segments of the current position (string = key, number = array index). Debug only. */
const pathStack: (string | number)[] = [];

function pathString(): string {
  let out = '';
  for (let i = 0; i < pathStack.length; i++) {
    const seg = pathStack[i]!;
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? seg : `.${seg}`;
  }
  return out;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return ArrayBuffer.isView(v) ? 'typed-array' : 'object';
  return String(v);
}

function report(a: unknown, b: unknown): string {
  return `${pathString()}: ${fmt(a)} != ${fmt(b)}`;
}

/** Numbers are equal if === (so -0 equals 0, matching hashState) or both NaN. */
function numEq(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

function diffValue(a: unknown, b: unknown): string | null {
  if (typeof a === 'number' && typeof b === 'number') return numEq(a, b) ? null : report(a, b);
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b ? null : report(a, b);
  const aArr = Array.isArray(a) || ArrayBuffer.isView(a);
  const bArr = Array.isArray(b) || ArrayBuffer.isView(b);
  if (aArr !== bArr) return report(a, b);
  if (aArr) {
    const x = a as ArrayLike<unknown>;
    const y = b as ArrayLike<unknown>;
    if (x.length !== y.length) {
      pathStack.push('length');
      const r = report(x.length, y.length);
      pathStack.pop();
      return r;
    }
    for (let i = 0; i < x.length; i++) {
      pathStack.push(i);
      const r = diffValue(x[i], y[i]);
      pathStack.pop();
      if (r !== null) return r;
    }
    return null;
  }
  const ao = a as Rec;
  const bo = b as Rec;
  for (const k in ao) {
    if (k === PROTO_KEY) continue;
    pathStack.push(k);
    const r = k in bo ? diffValue(ao[k], bo[k]) : `${pathString()}: present != missing`;
    pathStack.pop();
    if (r !== null) return r;
  }
  for (const k in bo) {
    if (k === PROTO_KEY || k in ao) continue;
    pathStack.push(k);
    const r = `${pathString()}: missing != present`;
    pathStack.pop();
    return r;
  }
  return null;
}

/**
 * Deep equality on the mutable part, returns the first differing path or null (debug, desync reports).
 * Format: "players[3].x: 1.2 != 1.3" (a's value first). -0 equals 0 and NaN equals NaN, like hashState.
 */
export function diffState(a: SimState, b: SimState): string | null {
  pathStack.length = 0;
  const ao = a as unknown as Rec;
  const bo = b as unknown as Rec;
  for (const k in ao) {
    if (k === PROTO_KEY || isImmutableKey(k)) continue;
    pathStack.push(k);
    const r = k in bo ? diffValue(ao[k], bo[k]) : `${pathString()}: present != missing`;
    pathStack.pop();
    if (r !== null) { pathStack.length = 0; return r; }
  }
  for (const k in bo) {
    if (k === PROTO_KEY || isImmutableKey(k) || k in ao) continue;
    return `${k}: missing != present`;
  }
  return null;
}

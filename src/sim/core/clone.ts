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
import { createSimState, IMMUTABLE_STATE_KEYS, type SimState } from '../../contracts/state';

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
// Safety: a (dst, src) pair uses the generated copier only after both states matched the shape the copier was built from
// (every key in order, value kind and array length: the shape's generated checker, or the full signature for a shape not
// compiled yet); the last few validated pairs are remembered, so the app loop's (prev, curr) validates once per match.
// initMatch compiles the copier on the loading screen (primeStateCodegen), so the first tick only runs the checkers. States keep their shape for life (the sim never
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

/**
 * Statement copying the value `x` (already read from src) into `dst` (an lvalue), with the generic walk's semantics.
 * [FIN-P] Two stores, not one store of a conditional: `dst = cond ? ci(dst, x) : x` merged a double element with the
 * call's result into one value, which V8 must box, a heap number per element per copy (2 KB a tick for the team and
 * shoot-out arrays once their elements hold doubles; tests/unit/fin-p-warmup.test.ts copier probe). Same result.
 */
function genericStore(dst: string, x: string): string {
  return `if (typeof ${x} !== 'object' || ${x} === null) ${dst} = ${x}; else ${dst} = ci(${dst}, ${x});`;
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

// ---- shape checkers [TUN-7S skeptic]
// Validating a new state against a compiled shape used to build its full signature string (shapeSig: ~28 KB, ~3000
// JSON.stringify calls; ~0.6 ms warm, several ms cold), twice per new copy pair and once per new hashed state, so the
// first tick of every match paid it (copyState(prev, curr) and the replay recorder's first hashState of the new state).
// Each compiled shape now carries a generated checker that answers "does this object have exactly this shape" (same
// keys in the same for-in order, same value kinds, same array lengths: what the signature encodes) with no allocation.

/** Code generator state for checkers: one function and one key list per distinct object shape. */
interface CheckGen { fns: string[]; bySig: string[]; names: string[]; n: number }

/** Statements returning false unless `x` (an expression read once into a local) has the kind / shape of `v`. */
function genCheckValue(g: CheckGen, x: string, v: unknown): string {
  if (typeof v === 'number') return `if (typeof ${x} !== 'number') return false;\n`;
  if (Array.isArray(v)) {
    const a = `a${g.n++}`;
    let out = `{ const ${a} = ${x}; if (!Array.isArray(${a}) || ${a}.length !== ${v.length}) return false;\n`;
    let allNum = true;
    let elemSig: string | null = null;
    let uniform = v.length > 0;
    for (let i = 0; i < v.length; i++) {
      const e: unknown = v[i];
      if (typeof e === 'number') { uniform = false; continue; }
      allNum = false;
      if (typeof e !== 'object' || e === null || Array.isArray(e) || ArrayBuffer.isView(e)) { uniform = false; continue; }
      const sig = shapeSig(e, false);
      if (elemSig === null) elemSig = sig; else if (elemSig !== sig) uniform = false;
    }
    if (allNum) out += `for (let i = 0; i < ${v.length}; i++) if (typeof ${a}[i] !== 'number') return false;\n`;
    else if (uniform) out += `for (let i = 0; i < ${v.length}; i++) if (!${genCheckObject(g, v[0] as Rec, false)}(${a}[i])) return false;\n`;
    else for (let i = 0; i < v.length; i++) out += genCheckValue(g, `${a}[${i}]`, v[i]);
    return `${out}}\n`;
  }
  return `if (!${genCheckObject(g, v as Rec, false)}(${x})) return false;\n`;
}

/** Name of the generated checker for objects of `v`'s shape (keys in order, then every value's kind / shape). */
function genCheckObject(g: CheckGen, v: Rec, root: boolean): string {
  const sig = shapeSig(v, root);
  for (let i = 0; i < g.bySig.length; i++) if (g.bySig[i] === sig) return g.names[i]!;
  const name = `k${g.names.length}`;
  g.bySig.push(sig);
  g.names.push(name);
  const keys: string[] = [];
  let body = '';
  for (const k in v) {
    keys.push(k);
    if (root && isImmutableKey(k)) continue; // referenced, any value (shapeSig: 'R')
    body += genCheckValue(g, `o${prop(k)}`, v[k]);
  }
  g.fns.push(`const ${name}K = ${JSON.stringify(keys)};\nfunction ${name}(o) {\n` +
    `if (o === null || typeof o !== 'object' || Array.isArray(o) || ArrayBuffer.isView(o)) return false;\n` +
    `let i = 0;\nfor (const k in o) { if (k !== ${name}K[i]) return false; i++; }\nif (i !== ${name}K.length) return false;\n` +
    `${body}return true;\n}\n`);
  return name;
}

type Checker = (o: unknown) => boolean;

/**
 * Compiled shapes (a handful at most: states of one SIM_VERSION share one shape): signature, copier and checker.
 * A shape is registered only from a state whose signature has no '?' (numbers, plain objects and arrays only).
 */
const compiledSig: string[] = [];
const compiledFn: Copier[] = [];
const compiledCheck: Checker[] = [];
/** 1 once `new Function` was found unavailable (CSP): every copy stays generic. */
let codegenUnavailable = 0;

/** Validated (dst, src) pairs and their copier (small ring). */
const PAIR_RING = 6;
const pairDst: (SimState | null)[] = new Array<SimState | null>(PAIR_RING).fill(null);
const pairSrc: (SimState | null)[] = new Array<SimState | null>(PAIR_RING).fill(null);
const pairFn: (Copier | null)[] = new Array<Copier | null>(PAIR_RING).fill(null);
let pairNext = 0;

/** Generate and compile the copier and checker of `src`'s shape (signature `sig`, no '?'); its index, or -1. */
function compile(src: SimState, sig: string): number {
  if (codegenUnavailable) return -1;
  const g: Gen = { fns: [], bySig: [], names: [] };
  const root = genObject(g, src as unknown as Rec, true);
  const cg: CheckGen = { fns: [], bySig: [], names: [], n: 0 };
  const rootCheck = genCheckObject(cg, src as unknown as Rec, true);
  try {
    const make = new Function(`'use strict';\n${g.fns.join('')}${cg.fns.join('')}return [${root}, ${rootCheck}];`) as
      () => [Copier, Checker];
    const [fn, check] = make();
    compiledSig.push(sig);
    compiledFn.push(fn);
    compiledCheck.push(check);
    return compiledFn.length - 1;
  } catch {
    codegenUnavailable = 1;
    return -1;
  }
}

/** Index of the compiled shape `s` has now (checkers first; no allocation when one matches), or -1. */
function matchShape(s: unknown): number {
  for (let i = 0; i < compiledCheck.length; i++) if (compiledCheck[i]!(s)) return i;
  return -1;
}

/**
 * Index of the compiled shape of `s`, compiling it when `s` has a new shape with no '?' (-1: not specialisable or no
 * codegen). For hash.ts's hasher: a state of a known shape is recognised by the checker, without a signature.
 */
export function stateShapeIndex(s: SimState): number {
  if (codegenUnavailable) return -1;
  const k = matchShape(s);
  if (k >= 0) return k;
  const sig = shapeSig(s, true);
  return sig.indexOf('?') < 0 ? compile(s, sig) : -1;
}

/** The specialised copier for this pair, or null (shapes differ / unsupported / no codegen). Allocates only on a new pair. */
function copierFor(dst: SimState, src: SimState): Copier | null {
  for (let i = 0; i < PAIR_RING; i++) if (pairDst[i] === dst && pairSrc[i] === src) return pairFn[i]!;
  if (codegenUnavailable) return null;
  let fn: Copier | null = null;
  const k = matchShape(src);
  if (k >= 0) {
    if (compiledCheck[k]!(dst)) fn = compiledFn[k]!;
  } else {
    // A shape not compiled yet: compile it when both states have it.
    const sig = shapeSig(src, true);
    if (sig.indexOf('?') < 0 && shapeSig(dst, true) === sig) {
      const c = compile(src, sig);
      if (c >= 0) fn = compiledFn[c]!;
    }
  }
  // [FIN-P] A new copy target gets the hidden classes the match states have (initMatch settles them): the app's
  // interpolation state is a fresh createSimState (app/liveState.ts cloneLiveState) whose integer slots and arrays only
  // became doubles when the copier first wrote a fraction into each, a map / elements-kind change per object kind in
  // the first ticks of every match, which deoptimised the optimised copier ("wrong map") and left it boxing every field
  // it copied while it re-optimised (tests/unit/fin-p-warmup.test.ts copier probe). No value changes. Production builds
  // (shapeSettlingOn below), like initMatch's.
  if (fn !== null && shapeSettlingOn()) settleStateShapes(dst);
  pairDst[pairNext] = dst;
  pairSrc[pairNext] = src;
  pairFn[pairNext] = fn;
  pairNext = (pairNext + 1) % PAIR_RING;
  return fn;
}

/**
 * Shape signature of a state: every key, value kind and array length in walk order (immutable keys as references).
 * Contains '?' when some value is not a number / plain object / array (null, string, typed array, own "__proto__"...).
 * Allocates (a string); for one-off validation and tests. [TUN-7S]
 */
export function stateShapeSignature(s: SimState): string {
  return shapeSig(s, true);
}

/**
 * [TUN-7S skeptic] Generate and compile the copier (and shape checker) for `s`'s shape now (sim/init.ts initMatch: on the
 * loading screen) instead of inside the first copyState(prev, curr) of the first match: generating and compiling cost
 * ~11 ms there in a cold process (HEAD's generic first copy ~0.85 ms), a hitch on the first tick of play (x4 on an iPad).
 * Once per process: after a shape is compiled this returns at once (every state of one SIM_VERSION has the same shape; a
 * state of another shape still compiles lazily on its first copy). Pairs are still validated on first use (by the
 * checker): nothing is assumed about `s`.
 */
export function primeStateCodegen(s: SimState): void {
  if (codegenUnavailable || compiledFn.length > 0) return;
  const sig = shapeSig(s, true);
  if (sig.indexOf('?') >= 0) return;
  const k = compile(s, sig);
  if (k < 0) return;
  // Run the checker and the copier once (into a throwaway clone): V8 / JSC compile a generated inner function's bytecode
  // on its first call, which would otherwise still land on the first tick. [FIN-P] The clone is built as the app builds
  // its interpolation state (createSimState: app/liveState.ts cloneLiveState), not with cloneState: cloneState's objects
  // are dictionary-mode (keyed stores), and the copier's first stores into them left dictionary maps in its store
  // feedback for the whole session, so in play it stored every double through the generic path, a heap number each
  // (10 KB a tick in the first match, tests/unit/fin-p-warmup.test.ts).
  compiledCheck[k]!(s);
  compiledFn[k]!(createSimState(s.config, s.squads), s, copyInto);
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

// ---------------------------------------------------------------- [FIN-P] shape settling
// Shared by sim/init.ts initMatch (every new match state), copierFor above (a new copy target, e.g. the app's
// interpolation state) and the sim warm-up (sim/init.ts warmUpSim). Values are never changed. Load-time only.

/**
 * Settling is on in production builds (the shipped app: V8 / Chromium, where it removes the deopt waves of play) and off
 * in dev builds, tests and the Node tools: there it only adds boxing in V8's lower tiers (an integer slot held as a
 * double is a heap number whenever unoptimised code reads it), which the allocation tests (QF-7R / TUN-7S) would then
 * measure instead of the code's own allocation. Values are identical either way, so the simulation and its hashes are
 * too. Probes of the production behaviour turn it on with setShapeSettling(true).
 */
let settling = typeof __DEV_BUILD__ !== 'undefined' && !__DEV_BUILD__;

/** Turn production shape settling on / off for this process (tests and probes of the production behaviour). */
export function setShapeSettling(on: boolean): void {
  settling = on;
}

/** True when initMatch and the state copier settle new states (production builds, or setShapeSettling(true)). */
export function shapeSettlingOn(): boolean {
  return settling;
}

/**
 * [FIN-P] Settle the hidden classes of a fresh state's objects up front, so they do not change in play: every numeric
 * field (and every all-number array) that holds an integer is written once with a fraction and then back, so V8 gives it
 * its double representation (and a mutable, non-constant field) now instead of on its first fractional value in play.
 * createSimState's literals start every number as a small integer (x: 0, vy: 0, ...); a field's first fraction (the
 * ball's first spin at tick ~6000, a restart's wall position, an advantage spot) changed the map of that object kind and
 * deoptimised every optimised function that had read it (Node: 457 "wrong map" deopts in two matches, 2 after this), so
 * the engine kept re-optimising for some 20000 ticks and paced ticks ran in slower tiers with boxed doubles.
 * Integer-only fields are settled too, on purpose: in Chromium (V8 14) under 4x throttling, settling only the 79 fields
 * that ever hold fractions left twice the Maglev recompilations, deopts and allocation per tick in the first match's
 * window (141 vs 62 recompilations, 34 vs 17 KB per tick, 39 vs 17 of 130 frames with a tick over 4 ms;
 * tests/perf/fin-p-tick-trace.ts). Node's V8 12 boxes more doubles in its lower tiers for it, so it is production-only
 * (shapeSettlingOn above). Values are unchanged (an integer plus 0.5 is exact, and the integer itself is
 * written back, -0 included), so this is invisible to the sim and its hash; JavaScriptCore has no field representations
 * and is unaffected. tests/unit/fin-p-warmup.test.ts plays matches and checks that no map changes. Load-time only.
 */
export function settleStateShapes(s: SimState): void {
  const r = s as unknown as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k === 'config' || k === 'squads') continue; // shared inputs, never written by the sim
    settleValue(r, k, 0);
  }
}

function settleValue(o: Record<string | number, unknown>, k: string | number, depth: number): void {
  const v = o[k];
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      o[k] = v + 0.5;
      o[k] = v;
    }
  } else if (Array.isArray(v)) {
    if (depth > 6) return;
    let allNum = v.length > 0;
    for (let i = 0; i < v.length; i++) if (typeof v[i] !== 'number') { allNum = false; break; }
    const a = v as unknown as Record<number, unknown>;
    if (allNum) settleValue(a, 0, depth + 1); // one store moves the whole array to double elements
    else for (let i = 0; i < v.length; i++) if (v[i] !== null && typeof v[i] === 'object') settleValue(a, i, depth + 1);
  } else if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    if (depth > 6) return;
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(obj)) settleValue(obj, key, depth + 1);
  }
}

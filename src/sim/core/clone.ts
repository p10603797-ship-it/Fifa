/**
 * State cloning without per-tick allocation. [FND-03]
 * copyState(dst, src) copies every mutable field (deep, arrays in place); IMMUTABLE_STATE_KEYS are copied
 * by reference. cloneState allocates a fresh deep copy (snapshots, tests, replay keyframes).
 *
 * Both walk the state generically in key-insertion order, so they follow contracts/state.ts without a
 * hand-maintained field list and preserve the hash order (hashState(cloneState(s)) === hashState(s)).
 */
import { IMMUTABLE_STATE_KEYS, type SimState } from '../../contracts/state';

type Rec = Record<string, unknown>;

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
    dobj[k] = typeof e === 'object' && e !== null ? copyInto(dobj[k], e) : e;
  }
  return d;
}

/** Fresh deep copy of the mutable part; config and squads are shared by reference. */
export function cloneState(s: SimState): SimState {
  const src = s as unknown as Rec;
  const out: Rec = {};
  for (const k in src) {
    const e = src[k];
    out[k] = isImmutableKey(k) || typeof e !== 'object' || e === null ? e : cloneValue(e);
  }
  return out as unknown as SimState;
}

/**
 * Copy src into dst in place (the interpolation snapshot before each tick). Allocation-free when dst has
 * the same shape as src (any state made by createSimState/initMatch/cloneState). Immutable keys are
 * assigned by reference. Keys present only in dst are left untouched.
 */
export function copyState(dst: SimState, src: SimState): void {
  const s = src as unknown as Rec;
  const d = dst as unknown as Rec;
  for (const k in s) {
    const e = s[k];
    if (isImmutableKey(k) || typeof e !== 'object' || e === null) d[k] = e;
    else d[k] = copyInto(d[k], e);
  }
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
    pathStack.push(k);
    const r = k in bo ? diffValue(ao[k], bo[k]) : `${pathString()}: present != missing`;
    pathStack.pop();
    if (r !== null) return r;
  }
  for (const k in bo) {
    if (k in ao) continue;
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
    if (isImmutableKey(k)) continue;
    pathStack.push(k);
    const r = k in bo ? diffValue(ao[k], bo[k]) : `${pathString()}: present != missing`;
    pathStack.pop();
    if (r !== null) { pathStack.length = 0; return r; }
  }
  for (const k in bo) {
    if (isImmutableKey(k) || k in ao) continue;
    return `${k}: missing != present`;
  }
  return null;
}

/**
 * [QF-7R] three.js float uniform uploads without heap allocation (BRIEF section 13 "No allocation in hot paths"; "no
 * garbage-collection pause over 4 ms").
 *
 * three.js (0.186) keeps the last uploaded value of every uniform in `uniform.cache` (a plain array from one literal,
 * `this.cache = []`) and its setters compare and copy through two helpers shared by every uniform of every program,
 * arraysEqual() and copyArray(). In V8 those helpers see every element kind there is (caches holding booleans and
 * texture units, empty caches, matrices with small-integer or double elements) and go megamorphic, and a megamorphic
 * keyed access boxes each double it moves: every model-view and normal matrix of every draw (16 + 9 heap numbers),
 * plus the three numbers uniform3f(x, y, z) and the one uniform1f(v) pass to the binding. Measured in the live
 * Chromium page (tests/perf/qf-7r-browser-bench.ts --dev --alloc): ~6-7 KB per frame in copyArray / setValueV3f /
 * setValueM4 / setValueV1f, more than all of src/render together; invisible to the Node allocation tests (their
 * WebGL core is a stand-in). Retyping the caches alone does not help: the helpers stay megamorphic (measured: more
 * allocation, not less). JavaScriptCore stores doubles unboxed, so this is a Chromium (proxy gate) cost.
 *
 * Fix: once per new program, every single (non-array) uniform of type FLOAT, FLOAT_VEC3, FLOAT_MAT3 or FLOAT_MAT4 gets
 * a Float64Array cache of its size (holding what three.js already uploaded; NaN where nothing was, so the next value
 * always differs, exactly as against an empty cache) and a setter of this module that compares and copies in its own
 * monomorphic loops and uploads through a Float32Array (uniform1fv / uniform3fv / uniformMatrix3fv / uniformMatrix4fv):
 * the same value reaches the same uniform, under the same "changed since the last upload" rule, with nothing boxed.
 * Inputs other than the common forms (number; Vector3 / Color / [r, g, b]; Matrix3 / Matrix4) go to three.js's own setter, which
 * works on the Float64Array cache unchanged (it only indexes, compares and copies element-wise).
 *
 * sync() runs once per frame before the draw; it does work only when three.js's program list changed (loading-screen
 * compile, a quality tier change, a context restore, a program first built at its first draw); otherwise it compares
 * the list with its copy, entry by entry (a few dozen reference compares, nothing allocated).
 */

/** GL uniform types handled here. */
const FLOAT = 0x1406;
const FLOAT_VEC3 = 0x8b51;
const FLOAT_MAT3 = 0x8b5b;
const FLOAT_MAT4 = 0x8b5c;

/** The parts of three.js's WebGLUniforms tree used here (SingleUniform, PureArrayUniform, StructuredUniform). */
export interface UniformNodeLike {
  seq?: UniformNodeLike[];
  cache?: unknown;
  type?: number;
  size?: number;
  addr?: unknown;
  setValue?: (gl: unknown, v: unknown, textures?: unknown) => void;
}
export interface ProgramLike {
  getUniforms(): UniformNodeLike;
  isReady?(): boolean;
}
export interface RendererLike {
  info: { programs: ProgramLike[] | null };
}

/** The WebGL calls the setters make. */
interface GlLike {
  uniform1fv(loc: unknown, v: Float32Array): void;
  uniform3fv(loc: unknown, v: Float32Array): void;
  uniformMatrix3fv(loc: unknown, transpose: boolean, v: Float32Array): void;
  uniformMatrix4fv(loc: unknown, transpose: boolean, v: Float32Array): void;
}

type Setter = (this: UniformNodeLike, gl: unknown, v: unknown, textures?: unknown) => void;

/** three.js's own setter of each converted uniform (fallback for uncommon inputs). */
const baseSetter = new WeakMap<object, Setter>();
/** Upload scratch (one upload at a time: WebGL copies the data during the call). */
const S1 = new Float32Array(1);
const S3 = new Float32Array(3);
const S9 = new Float32Array(9);
const S16 = new Float32Array(16);

function fallback(node: UniformNodeLike, gl: unknown, v: unknown): void {
  const base = baseSetter.get(node);
  if (base) base.call(node, gl, v);
}

function setFloat(this: UniformNodeLike, gl: unknown, v: unknown): void {
  if (typeof v !== 'number') { fallback(this, gl, v); return; }
  const c = this.cache as Float64Array;
  if (c[0] === v) return;
  S1[0] = v;
  (gl as GlLike).uniform1fv(this.addr, S1);
  c[0] = v;
}

interface Xyz { x?: number; y: number; z: number; r?: number; g: number; b: number; length?: number }

/**
 * Vector3 / Color / three-number array. The form is told by `in`, which yields a boolean: reading o.x first (as three.js
 * does) is a load over several hidden classes that gives a double for one and undefined for the others, and V8 boxes
 * the double to merge them. Each form then compares and copies in its own branch: a double merged from two branches
 * into one variable is boxed by V8's mid tier (Maglev), which runs this for the first minutes of play.
 */
function setVec3(this: UniformNodeLike, gl: unknown, v: unknown): void {
  const o = v as Xyz;
  const c = this.cache as Float64Array;
  if (typeof v !== 'object' || v === null) { fallback(this, gl, v); return; }
  if ('x' in o && o.x !== undefined) {
    if (c[0] === o.x && c[1] === o.y && c[2] === o.z) return;
    c[0] = o.x; c[1] = o.y; c[2] = o.z;
  } else if ('r' in o && o.r !== undefined) {
    if (c[0] === o.r && c[1] === o.g && c[2] === o.b) return;
    c[0] = o.r; c[1] = o.g; c[2] = o.b;
  } else if (o.length === 3) {
    const a = v as ArrayLike<number>;
    if (c[0] === a[0] && c[1] === a[1] && c[2] === a[2]) return;
    c[0] = a[0]!; c[1] = a[1]!; c[2] = a[2]!;
  } else {
    fallback(this, gl, v);
    return;
  }
  S3[0] = c[0]!; S3[1] = c[1]!; S3[2] = c[2]!;
  (gl as GlLike).uniform3fv(this.addr, S3);
}

function setMat3(this: UniformNodeLike, gl: unknown, v: unknown): void {
  const e = (v as { elements?: ArrayLike<number> }).elements;
  if (e === undefined) { fallback(this, gl, v); return; }
  const c = this.cache as Float64Array;
  let i = 0;
  while (i < 9 && c[i] === e[i]) i++;
  if (i === 9) return;
  for (let k = 0; k < 9; k++) { const x = e[k]!; S9[k] = x; c[k] = x; }
  (gl as GlLike).uniformMatrix3fv(this.addr, false, S9);
}

function setMat4(this: UniformNodeLike, gl: unknown, v: unknown): void {
  const e = (v as { elements?: ArrayLike<number> }).elements;
  if (e === undefined) { fallback(this, gl, v); return; }
  const c = this.cache as Float64Array;
  let i = 0;
  while (i < 16 && c[i] === e[i]) i++;
  if (i === 16) return;
  for (let k = 0; k < 16; k++) { const x = e[k]!; S16[k] = x; c[k] = x; }
  (gl as GlLike).uniformMatrix4fv(this.addr, false, S16);
}

/** Cache size of a handled GL type (0: three.js keeps the uniform). */
function sizeOf(type: number): number {
  return type === FLOAT ? 1 : type === FLOAT_VEC3 ? 3 : type === FLOAT_MAT3 ? 9 : type === FLOAT_MAT4 ? 16 : 0;
}

function setterOf(type: number): Setter {
  return type === FLOAT ? setFloat : type === FLOAT_VEC3 ? setVec3 : type === FLOAT_MAT3 ? setMat3 : setMat4;
}

/**
 * Convert one uniform node in place (a single uniform of a handled type whose cache holds only numbers); returns
 * whether it did. Idempotent.
 */
export function convertUniform(node: UniformNodeLike): boolean {
  if (node.size !== undefined || node.type === undefined || typeof node.setValue !== 'function') return false;
  if (baseSetter.has(node)) return false;
  const n = sizeOf(node.type);
  if (n === 0) return false;
  const old = node.cache;
  if (!Array.isArray(old) || old.length > n) return false;
  for (let i = 0; i < old.length; i++) if (typeof old[i] !== 'number') return false;
  const c = new Float64Array(n).fill(NaN);
  for (let i = 0; i < old.length; i++) c[i] = old[i] as number;
  baseSetter.set(node, node.setValue as Setter);
  node.cache = c;
  node.setValue = setterOf(node.type) as UniformNodeLike['setValue'];
  return true;
}

export interface UniformCacheRetyper {
  /** Convert the uniforms of programs three.js created since the last call (no work while the list is unchanged). */
  sync(r: RendererLike): void;
  /** Uniforms converted so far (diagnostics, tests). */
  readonly retyped: number;
}

export function createUniformCacheRetyper(): UniformCacheRetyper {
  const done = new WeakSet<object>();
  /** The program list as of the last conversion pass, by identity (grows only when three.js's list grows). */
  const seen: object[] = [];
  let seenList: object | null = null;
  let pending = false;
  let retyped = 0;

  function walk(node: UniformNodeLike): void {
    const seq = node.seq;
    if (Array.isArray(seq)) {
      for (let i = 0; i < seq.length; i++) walk(seq[i]!);
      return;
    }
    if (convertUniform(node)) retyped++;
  }

  return {
    get retyped() { return retyped; },
    sync(r: RendererLike): void {
      const progs = r.info ? r.info.programs : null;
      if (!progs) return;
      // [QF-7R skeptic] Compared entry by entry, not by length and last entry: three.js appends a new program and
      // removes a released one by moving the LAST entry into its slot (WebGLPrograms.releaseProgram), so a program
      // acquired and then an older one released (a material built and another disposed between two frames) leaves the
      // length and the last entry as they were, with the new program in the middle of the list.
      const n = progs.length;
      if (!pending && progs === seenList && n === seen.length) {
        let i = 0;
        while (i < n && progs[i] === seen[i]) i++;
        if (i === n) return;
      }
      seenList = progs;
      seen.length = n;
      for (let i = 0; i < n; i++) seen[i] = progs[i]!;
      pending = false;
      for (let i = 0; i < n; i++) {
        const p = progs[i]!;
        if (done.has(p)) continue;
        // A program still compiling in parallel (KHR_parallel_shader_compile): reading its uniforms would wait for it.
        if (typeof p.isReady === 'function' && !p.isReady()) {
          pending = true;
          continue;
        }
        done.add(p);
        try {
          walk(p.getUniforms());
        } catch {
          /* a program that failed to link: three.js reports it; nothing to convert */
        }
      }
    },
  };
}

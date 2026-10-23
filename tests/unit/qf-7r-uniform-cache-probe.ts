/**
 * [QF-7R] Allocation probe for tests/unit/qf-7r-uniform-cache.test.ts (child process):
 *   node --allow-natives-syntax --single-threaded --sampling-heap-profiler-suppress-randomness --expose-gc \
 *        --invocation-count-for-turbofan=400 --import tsx tests/unit/qf-7r-uniform-cache-probe.ts
 * Uploads changing model-view matrices (Matrix4), normal matrices (Matrix3), camera positions (Vector3), colours
 * (Color), [r, g, b] arrays and floats, as three.js does per draw, through (a) render/uniformCache.ts's converted
 * uniforms and (b) a transcription of three.js 0.186's own setters (setValueV1f / V3f / M3 / M4 over arraysEqual /
 * copyArray, plain-array caches from one literal), after feeding the shared helpers the element kinds a live page
 * feeds them (boolean and texture-unit caches, small-integer and double matrices, typed arrays). Prints bytes per
 * upload allocated by each (exact: every allocation sampled). The WebGL calls are kept out of the optimiser, like the
 * browser's bindings.
 */
import { Session } from 'node:inspector/promises';
import { Color, Matrix3, Matrix4, Vector3 } from 'three';
import { EXACT_INTERVAL } from '../perf/qf-7r-alloc-flags';
import { convertUniform, createUniformCacheRetyper, type UniformNodeLike } from '../../src/render/uniformCache';

const never = (0, eval)('(f) => %NeverOptimizeFunction(f)') as (f: unknown) => void;
const sink = new Float64Array(4);
const gl = {
  uniform1f(_l: unknown, v: number) { sink[0] = v; },
  uniform3f(_l: unknown, x: number, y: number, z: number) { sink[0] = x + y + z; },
  uniform1fv(_l: unknown, v: ArrayLike<number>) { sink[0] = v[0]!; },
  uniform3fv(_l: unknown, v: ArrayLike<number>) { sink[0] = v[0]!; },
  uniformMatrix3fv(_l: unknown, _t: boolean, v: ArrayLike<number>) { sink[0] = v[0]!; },
  uniformMatrix4fv(_l: unknown, _t: boolean, v: ArrayLike<number>) { sink[0] = v[0]!; },
  uniform1i(_l: unknown, v: unknown) { sink[1] = v ? 1 : 0; },
};
for (const k of Object.keys(gl)) never((gl as Record<string, unknown>)[k]);

// ---- three.js 0.186 setters, transcribed (src: node_modules/three/build/three.module.js).
function arraysEqual(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0, l = a.length; i < l; i++) if (a[i] !== b[i]) return false;
  return true;
}
function copyArray(a: unknown[], b: ArrayLike<unknown>): void {
  for (let i = 0, l = b.length; i < l; i++) a[i] = b[i];
}
const mat3array = new Float32Array(9);
const mat4array = new Float32Array(16);
type G = typeof gl;
type N = { cache: unknown[]; addr: unknown; setValue: (gl: G, v: unknown) => void };
function setValueV1f(this: N, g: G, v: number): void {
  const cache = this.cache;
  if (cache[0] === v) return;
  g.uniform1f(this.addr, v);
  cache[0] = v;
}
function setValueV1i(this: N, g: G, v: unknown): void {
  const cache = this.cache;
  if (cache[0] === v) return;
  g.uniform1i(this.addr, v);
  cache[0] = v;
}
function setValueV3f(this: N, g: G, v: { x?: number; y: number; z: number; r?: number; g: number; b: number }): void {
  const cache = this.cache;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z) {
      g.uniform3f(this.addr, v.x, v.y, v.z);
      cache[0] = v.x; cache[1] = v.y; cache[2] = v.z;
    }
  } else if (v.r !== undefined) {
    if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b) {
      g.uniform3f(this.addr, v.r, v.g, v.b);
      cache[0] = v.r; cache[1] = v.g; cache[2] = v.b;
    }
  } else {
    if (arraysEqual(cache, v as unknown as ArrayLike<number>)) return;
    g.uniform3fv(this.addr, v as unknown as ArrayLike<number>);
    copyArray(cache, v as unknown as ArrayLike<number>);
  }
}
function setValueM3(this: N, g: G, v: { elements?: ArrayLike<number> }): void {
  const cache = this.cache;
  const elements = v.elements;
  if (elements === undefined) {
    if (arraysEqual(cache, v as ArrayLike<number>)) return;
    g.uniformMatrix3fv(this.addr, false, v as ArrayLike<number>);
    copyArray(cache, v as ArrayLike<number>);
  } else {
    if (arraysEqual(cache, elements)) return;
    mat3array.set(elements);
    g.uniformMatrix3fv(this.addr, false, mat3array);
    copyArray(cache, elements);
  }
}
function setValueM4(this: N, g: G, v: { elements?: ArrayLike<number> }): void {
  const cache = this.cache;
  const elements = v.elements;
  if (elements === undefined) {
    if (arraysEqual(cache, v as ArrayLike<number>)) return;
    g.uniformMatrix4fv(this.addr, false, v as ArrayLike<number>);
    copyArray(cache, v as ArrayLike<number>);
  } else {
    if (arraysEqual(cache, elements)) return;
    mat4array.set(elements);
    g.uniformMatrix4fv(this.addr, false, mat4array);
    copyArray(cache, elements);
  }
}
/** SingleUniform as three.js builds it: one literal for every cache. */
function single(type: number, setValue: unknown): UniformNodeLike & N {
  return { id: 'u', addr: {}, cache: [], type, setValue } as unknown as UniformNodeLike & N;
}

// ---- What a live page feeds the shared helpers: boolean / texture-unit caches, integer and double data, typed arrays.
const flags = single(0x8b56, setValueV1i);
for (let i = 0; i < 50; i++) flags.setValue(gl, i % 2 === 0); // a boolean in a cache from the shared literal
/** A holey array (elements kind HOLEY_*), built without a sparse literal. */
function holey(): unknown[] {
  const a: unknown[] = [];
  a[0] = 1;
  a[2] = 3;
  return a;
}
const kinds: ArrayLike<unknown>[] = [[1, 0, 0, 1], [0.5, 1.5], [true, false], new Float32Array(4), new Int32Array(4), holey()];
for (let r = 0; r < 200; r++) for (const a of kinds) for (const b of kinds) { arraysEqual(a, b); copyArray([] as unknown[], b); }

// ---- The per-draw values.
const m4 = new Matrix4();
const m3 = new Matrix3();
const v3 = new Vector3();
const col = new Color();
const rgb = [0.1, 0.2, 0.3];
const T = new Float64Array(1);
function makeSet(conv: boolean): { m4: N; m3: N; v3: N; col: N; rgb: N; f: N } {
  const s = {
    m4: single(0x8b5c, setValueM4), m3: single(0x8b5b, setValueM3), v3: single(0x8b51, setValueV3f),
    col: single(0x8b51, setValueV3f), rgb: single(0x8b51, setValueV3f), f: single(0x1406, setValueV1f),
  };
  if (conv) for (const u of Object.values(s)) if (!convertUniform(u)) throw new Error('not converted');
  return s;
}
// [QF-7R skeptic] The render loop's per-frame sync() over an unchanged program list (30 programs) runs in the measured
// window too: it compares the list entry by entry and must allocate nothing.
const retyper = createUniformCacheRetyper();
const programs: { getUniforms(): UniformNodeLike }[] = [];
for (let i = 0; i < 30; i++) { const u: UniformNodeLike = { seq: [] }; programs.push({ getUniforms: () => u }); }
const glRenderer = { info: { programs } };
const draw = (s: ReturnType<typeof makeSet>, n: number): void => {
  for (let i = 0; i < n; i++) {
    retyper.sync(glRenderer);
    T[0] = T[0]! + 0.0137;
    const t = T[0]!;
    m4.makeRotationY(t).setPosition(t, 0.25 * t, -t);
    m3.getNormalMatrix(m4);
    v3.set(t, 1.5, -t);
    col.setRGB(0.5 + 0.1 * Math.sin(t), 0.25, 0.75);
    rgb[0] = 0.1 + 0.01 * Math.cos(t);
    s.m4.setValue(gl, m4); s.m4.setValue(gl, m4); // the second is a skip (unchanged)
    s.m3.setValue(gl, m3);
    s.v3.setValue(gl, v3);
    s.col.setValue(gl, col);
    s.rgb.setValue(gl, rgb);
    s.f.setValue(gl, t);
  }
};
never(draw);

const REF = new Set(['setValueV1f', 'setValueV3f', 'setValueM3', 'setValueM4', 'arraysEqual', 'copyArray']);
const profiler = new Session();
profiler.connect();
async function bytesPerDraw(conv: boolean): Promise<{ total: number; sites: Record<string, number> }> {
  const s = makeSet(conv);
  draw(s, 20000); // optimised code
  (globalThis as { gc?: () => void }).gc?.();
  const N = 3000;
  await profiler.post('HeapProfiler.startSampling', {
    samplingInterval: EXACT_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  draw(s, N);
  type Node = { id: number; callFrame: { url: string; functionName: string }; children: Node[] };
  const profile = (await profiler.post('HeapProfiler.stopSampling')).profile as unknown as {
    head: Node; samples: { size: number; nodeId: number }[];
  };
  const where = new Map<number, string>();
  const index = (nd: Node): void => {
    const u = nd.callFrame.url;
    // The setters under test only: the WebGL stand-ins box what they receive (they run unoptimised, like a binding's
    // argument conversion), the same for both.
    if (u.includes('/src/render/uniformCache') || (u.includes('qf-7r-uniform-cache-probe') && REF.has(nd.callFrame.functionName))) {
      where.set(nd.id, nd.callFrame.functionName);
    }
    for (const c of nd.children) index(c);
  };
  index(profile.head);
  let total = 0;
  const sites: Record<string, number> = {};
  for (const smp of profile.samples) {
    const w = where.get(smp.nodeId);
    if (w === undefined) continue;
    total += smp.size;
    sites[w] = (sites[w] ?? 0) + smp.size / N;
  }
  return { total: total / N, sites };
}
const converted = await bytesPerDraw(true);
const three = await bytesPerDraw(false);
console.log(JSON.stringify({ converted, three }));
process.exit(0);

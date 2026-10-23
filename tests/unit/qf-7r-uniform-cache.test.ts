/**
 * [QF-7R] render/uniformCache.ts: three.js float uniforms (FLOAT, FLOAT_VEC3, FLOAT_MAT3, FLOAT_MAT4) uploaded by this
 * module's setters over Float64Array caches upload exactly what three.js's own setters upload, skip exactly what they
 * skip, and allocate nothing per draw.
 *
 * Regression for: in the live Chromium page three.js's uniform uploads allocated ~6-7 KB per frame (copyArray /
 * arraysEqual gone megamorphic: every model-view and normal matrix element of every draw boxed; uniform3f / uniform1f
 * boxing their arguments), more than all of src/render together (tests/perf/qf-7r-browser-bench.ts --dev --alloc:
 * three.js 7.6 KB per frame before, 1.8 after, the rest being three.js's scene traversal and sorting).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Color, Matrix3, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, STEADY_FLAGS } from '../perf/qf-7r-alloc-flags';
import { convertUniform, createUniformCacheRetyper, type UniformNodeLike } from '../../src/render/uniformCache';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---- three.js 0.186 setters, transcribed (the guard test below checks they still match the installed three.js).
function arraysEqual(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0, l = a.length; i < l; i++) if (a[i] !== b[i]) return false;
  return true;
}
function copyArray(a: unknown[], b: ArrayLike<unknown>): void {
  for (let i = 0, l = b.length; i < l; i++) a[i] = b[i];
}
type Log = string[];
/** A WebGL stand-in recording every upload as `<kind>:<float32 values>` (uniform3f and uniform3fv are the same upload). */
function recorder(log: Log) {
  const f32 = (a: ArrayLike<number>): string => Array.from(Float32Array.from(a)).join(',');
  return {
    uniform1f: (_l: unknown, v: number) => log.push(`1:${f32([v])}`),
    uniform1fv: (_l: unknown, v: ArrayLike<number>) => log.push(`1:${f32(v)}`),
    uniform3f: (_l: unknown, x: number, y: number, z: number) => log.push(`3:${f32([x, y, z])}`),
    uniform3fv: (_l: unknown, v: ArrayLike<number>) => log.push(`3:${f32(v)}`),
    uniformMatrix3fv: (_l: unknown, _t: boolean, v: ArrayLike<number>) => log.push(`m3:${f32(v)}`),
    uniformMatrix4fv: (_l: unknown, _t: boolean, v: ArrayLike<number>) => log.push(`m4:${f32(v)}`),
  };
}
type Gl = ReturnType<typeof recorder>;
type N = UniformNodeLike & { cache: unknown[]; addr: unknown };
const mat3array = new Float32Array(9);
const mat4array = new Float32Array(16);
function setValueV1f(this: N, gl: Gl, v: number): void {
  const cache = this.cache;
  if (cache[0] === v) return;
  gl.uniform1f(this.addr, v);
  cache[0] = v;
}
function setValueV3f(this: N, gl: Gl, v: Record<string, number> & ArrayLike<number>): void {
  const cache = this.cache;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z) {
      gl.uniform3f(this.addr, v.x, v.y!, v.z!);
      cache[0] = v.x; cache[1] = v.y; cache[2] = v.z;
    }
  } else if (v.r !== undefined) {
    if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b) {
      gl.uniform3f(this.addr, v.r, v.g!, v.b!);
      cache[0] = v.r; cache[1] = v.g; cache[2] = v.b;
    }
  } else {
    if (arraysEqual(cache, v)) return;
    gl.uniform3fv(this.addr, v);
    copyArray(cache, v);
  }
}
function setValueMat(n: 3 | 4) {
  return function (this: N, gl: Gl, v: { elements?: ArrayLike<number> } & ArrayLike<number>): void {
    const cache = this.cache;
    const elements = v.elements;
    const up = n === 3 ? gl.uniformMatrix3fv : gl.uniformMatrix4fv;
    if (elements === undefined) {
      if (arraysEqual(cache, v)) return;
      up(this.addr, false, v);
      copyArray(cache, v);
    } else {
      if (arraysEqual(cache, elements)) return;
      const scratch = n === 3 ? mat3array : mat4array;
      scratch.set(elements);
      up(this.addr, false, scratch);
      copyArray(cache, elements);
    }
  };
}
const TYPES = { f: 0x1406, v3: 0x8b51, m3: 0x8b5b, m4: 0x8b5c } as const;
const SETTERS = { f: setValueV1f, v3: setValueV3f, m3: setValueMat(3), m4: setValueMat(4) };
function single(kind: keyof typeof TYPES): N {
  return { addr: {}, cache: [], type: TYPES[kind], setValue: SETTERS[kind] as N['setValue'] } as N;
}

/** Deterministic value streams with repeats (skips), every input form three.js passes, and some odd ones. */
function* values(kind: keyof typeof TYPES, n: number): Generator<unknown> {
  let seed = 12345;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (k: number): number => Math.floor(rnd() * k);
  const pool = [0, 1, -0.5, 0.1 + 0.2, 1e-7, 3.4e38, 123.456];
  const num = (): number => (rnd() < 0.7 ? pool[pick(pool.length)]! : rnd() * 10 - 5);
  let last: unknown = null;
  for (let i = 0; i < n; i++) {
    if (last !== null && rnd() < 0.3) { yield last; continue; } // unchanged: three.js skips it
    let v: unknown;
    if (kind === 'f') v = rnd() < 0.05 ? Number.NaN : num();
    else if (kind === 'v3') {
      const f = pick(4);
      v = f === 0 ? new Vector3(num(), num(), num()) : f === 1 ? new Color(num(), num(), num())
        : f === 2 ? [num(), num(), num()] : new Float32Array([num(), num(), num()]);
    } else if (kind === 'm3') {
      const f = pick(3);
      const m = new Matrix3().set(num(), num(), num(), num(), num(), num(), num(), num(), num());
      v = f === 0 ? m : f === 1 ? m.elements.slice() : new Float32Array(m.elements);
    } else {
      const f = pick(3);
      const m = new Matrix4().makeRotationY(num()).setPosition(num(), num(), num());
      if (rnd() < 0.2) m.identity(); // small-integer elements
      v = f === 0 ? m : f === 1 ? m.elements.slice() : new Float32Array(m.elements);
    }
    last = v;
    yield v;
  }
}

describe('QF-7R three.js uniform uploads (render/uniformCache.ts)', () => {
  for (const kind of ['f', 'v3', 'm3', 'm4'] as const) {
    it(`${kind}: converted setter uploads and skips exactly as three.js's, also when converted mid-stream`, () => {
      const refLog: Log = [], outLog: Log = [], midLog: Log = [];
      const refGl = recorder(refLog), outGl = recorder(outLog), midGl = recorder(midLog);
      const ref = single(kind), out = single(kind), mid = single(kind);
      expect(convertUniform(out)).toBe(true);
      expect(out.cache).toBeInstanceOf(Float64Array);
      expect(convertUniform(out)).toBe(false); // idempotent
      let i = 0;
      for (const v of values(kind, 3000)) {
        if (i === 1000) expect(convertUniform(mid)).toBe(true); // a program converted after its first draws
        ref.setValue!(refGl, v);
        out.setValue!(outGl, v);
        mid.setValue!(midGl, v);
        i++;
      }
      expect(refLog.length).toBeGreaterThan(1000);
      expect(refLog.length).toBeLessThan(3000); // some skips happened
      expect(outLog).toEqual(refLog);
      expect(midLog).toEqual(refLog);
    });
  }

  it('leaves integer, boolean, sampler, array and struct uniforms and non-numeric caches to three.js', () => {
    const keep = (n: UniformNodeLike): void => {
      const before = { cache: n.cache, setValue: n.setValue };
      expect(convertUniform(n)).toBe(false);
      expect(n.cache).toBe(before.cache);
      expect(n.setValue).toBe(before.setValue);
    };
    const f = (): void => {};
    keep({ type: 0x1404, cache: [], setValue: f }); // INT
    keep({ type: 0x8b56, cache: [], setValue: f }); // BOOL
    keep({ type: 0x8b5e, cache: [], setValue: f }); // SAMPLER_2D
    keep({ type: 0x8b52, cache: [], setValue: f }); // FLOAT_VEC4 (not converted)
    keep({ type: 0x8b5c, cache: [], size: 4, setValue: f }); // mat4 array uniform
    keep({ type: 0x1406, cache: [true], setValue: f }); // a cache holding a non-number
    keep({ seq: [], cache: undefined, setValue: f });
  });

  it('sync() converts each new program once, waits for programs still compiling, and notices a replaced program', () => {
    const r = createUniformCacheRetyper();
    const prog = (ready: { v: boolean }) => {
      const u = { seq: [single('m4'), { seq: [single('v3'), single('f')] }, { type: 0x8b56, cache: [], setValue: () => {} }] };
      return { getUniforms: () => u, isReady: () => ready.v, u };
    };
    const ready = { v: true }, later = { v: false };
    const a = prog(ready), b = prog(later);
    const renderer = { info: { programs: [a, b] } };
    r.sync(renderer);
    expect(r.retyped).toBe(3); // a: m4, v3, f (struct walked; bool kept); b still compiling
    expect((a.u.seq[0] as N).cache).toBeInstanceOf(Float64Array);
    r.sync(renderer);
    expect(r.retyped).toBe(3);
    later.v = true;
    r.sync(renderer);
    expect(r.retyped).toBe(6);
    // A release + acquire with the same length (three.js splices the old one out and appends the new one).
    const c = prog(ready);
    renderer.info.programs.splice(0, 1);
    renderer.info.programs.push(c);
    r.sync(renderer);
    expect(r.retyped).toBe(9);
    r.sync({ info: { programs: null } });
    expect(r.retyped).toBe(9);
  });

  it('sync() converts a program acquired before an older one is released (three.js moves the last entry into the freed slot)', () => {
    // [QF-7R skeptic] three.js WebGLPrograms: acquireProgram pushes; releaseProgram does
    // `programs[i] = programs[programs.length - 1]; programs.pop()`. Acquire D, then release B (both between two
    // frames): [A, B, C] -> [A, B, C, D] -> [A, D, C]: same length, same last entry, D new in the middle. sync() keyed
    // on length + last entry never converted D (its draws kept three.js's boxing setters for the rest of the match).
    const r = createUniformCacheRetyper();
    const prog = () => {
      const u = { seq: [single('m4'), single('v3')] };
      return { getUniforms: () => u, u };
    };
    const programs = [prog(), prog(), prog()];
    const renderer = { info: { programs } };
    const acquire = (p: ReturnType<typeof prog>) => { programs.push(p); };
    const release = (p: ReturnType<typeof prog>) => { const i = programs.indexOf(p); programs[i] = programs[programs.length - 1]!; programs.pop(); };
    r.sync(renderer);
    expect(r.retyped).toBe(6);
    const d = prog();
    acquire(d);
    release(programs[1]!);
    expect(programs.length).toBe(3);
    r.sync(renderer);
    expect((d.u.seq[0] as N).cache).toBeInstanceOf(Float64Array);
    expect(r.retyped).toBe(8);
    // Unchanged list: no further work; a context restore (three.js builds a new programs array) is seen too.
    r.sync(renderer);
    expect(r.retyped).toBe(8);
    const e = prog();
    r.sync({ info: { programs: [e] } });
    expect(r.retyped).toBe(10);
  });

  it('guard: the installed three.js still has the setters and SingleUniform fields this module replaces', () => {
    const src = readFileSync(resolve(ROOT, 'node_modules/three/build/three.module.js'), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('class SingleUniform { constructor( id, activeInfo, addr ) { this.id = id; this.addr = addr; this.cache = []; this.type = activeInfo.type; this.setValue = getSingularSetter( activeInfo.type );');
    expect(src).toContain('function setValueV1f( gl, v ) { const cache = this.cache; if ( cache[ 0 ] === v ) return; gl.uniform1f( this.addr, v ); cache[ 0 ] = v; }');
    expect(src).toContain('if ( v.x !== undefined ) { if ( cache[ 0 ] !== v.x || cache[ 1 ] !== v.y || cache[ 2 ] !== v.z ) { gl.uniform3f( this.addr, v.x, v.y, v.z );');
    expect(src).toContain('if ( arraysEqual( cache, elements ) ) return; mat4array.set( elements ); gl.uniformMatrix4fv( this.addr, false, mat4array ); copyArray( cache, elements );');
    expect(src).toContain('if ( arraysEqual( cache, elements ) ) return; mat3array.set( elements ); gl.uniformMatrix3fv( this.addr, false, mat3array ); copyArray( cache, elements );');
    expect(src).toContain('case 0x1406: return setValueV1f; // FLOAT');
    expect(src).toContain('info.programs = programCache.programs;');
  });

  it('uploads allocate nothing per draw (three.js\'s setters, under the same feedback, box every element)', () => {
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, ...STEADY_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-uniform-cache-probe.ts',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 200_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { converted: { total: number; sites: object }; three: { total: number } };
    console.log(`QF-7R uniform upload bytes per draw: ${JSON.stringify(res)}`);
    expect(res.converted.total, JSON.stringify(res.converted.sites)).toBe(0);
    expect(res.three.total).toBeGreaterThan(16 * 16); // the mechanism this module removes is present in the drive
  }, 240_000);
});

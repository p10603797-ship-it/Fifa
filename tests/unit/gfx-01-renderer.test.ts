/**
 * [GFX-01] Renderer core in Node: context attributes (section 13), WebGL2 fallback, sRGB output, pixel ratio =
 * devicePixelRatio x resolution scale with buffer / GPU limits, resize for 4:3..21:9, stats, context loss and
 * restore (pause notification, three.js-first ordering, clear colour and size re-applied), rebuild, dispose.
 * There is no WebGL in Node: the core runs on a fake canvas and a fake three.js renderer (createWebGLRenderer
 * option). The real GPU path is covered by tests/e2e/gfx-01-renderer.spec.ts.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DataTexture, Mesh, MeshBasicMaterial, MeshLambertMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene,
  ShaderMaterial, SRGBColorSpace, type WebGLRenderer,
} from 'three';
import type { RenderStats } from '../../src/contracts/render';
import { T_PERF } from '../../src/contracts/tuning';
import {
  ASPECT_MAX, ASPECT_MIN, DEFAULT_CLEAR_COLOR, MAX_BUFFER_SIDE, MIN_PIXEL_RATIO, aspectSupported, bufferSide,
  clampScale, contextAttributes, createRenderer, effectivePixelRatio, gpuMaxSide, viewAspect,
  type RendererCoreOptions,
} from '../../src/render/renderer';

// ------------------------------------------------------------------ fakes

type Listener = (e: Event) => void;

interface FakeCanvas {
  listeners: Record<string, Listener[]>;
  getContextCalls: { kind: string; attrs: WebGLContextAttributes | undefined }[];
  /** Dispatch synchronously, in registration order (like the DOM). Returns the event. */
  fire(type: string, extra?: Record<string, unknown>): Event & { defaultPrevented: boolean };
  asCanvas(): HTMLCanvasElement;
}

interface FakeGl {
  lost: boolean;
  params: Record<number, unknown>;
  isContextLost(): boolean;
  getParameter(p: number): unknown;
}

function fakeGl(params: Record<number, unknown> = {}): FakeGl {
  return {
    lost: false,
    params,
    isContextLost() { return this.lost; },
    getParameter(p: number) { return this.params[p] ?? null; },
  };
}

function fakeCanvas(getContext: (kind: string, attrs?: WebGLContextAttributes) => unknown): FakeCanvas {
  const listeners: Record<string, Listener[]> = {};
  const c: FakeCanvas = {
    listeners,
    getContextCalls: [],
    fire(type, extra = {}) {
      let prevented = false;
      const e = { type, ...extra, preventDefault() { prevented = true; } } as unknown as Event;
      const list = (listeners[type] ?? []).slice();
      for (const fn of list) fn(e);
      return Object.assign(e, { defaultPrevented: prevented }) as Event & { defaultPrevented: boolean };
    },
    asCanvas() {
      return {
        getContext: (kind: string, attrs?: WebGLContextAttributes) => {
          c.getContextCalls.push({ kind, attrs });
          return getContext(kind, attrs);
        },
        addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
        removeEventListener: (type: string, fn: Listener) => {
          const l = listeners[type];
          if (!l) return;
          const i = l.indexOf(fn);
          if (i >= 0) l.splice(i, 1);
        },
      } as unknown as HTMLCanvasElement;
    },
  };
  return c;
}

/** Minimal stand-in for three.js WebGLRenderer: records calls; resets like three.js on context restore. */
interface FakeThree {
  log: string[];
  clearColor: number;
  clearAlpha: number;
  pixelRatio: number;
  size: [number, number, boolean];
  outputColorSpace: string;
  toneMapping: number;
  info: { autoReset: boolean; render: { calls: number; triangles: number }; memory: { textures: number; geometries: number } };
  compiled: number;
  disposed: boolean;
  setClearColor(c: number, a: number): void;
  setPixelRatio(p: number): void;
  setSize(w: number, h: number, s: boolean): void;
  compile(scene: unknown, camera: unknown): void;
  dispose(): void;
}

function fakeThree(canvas: FakeCanvas): FakeThree {
  const t: FakeThree = {
    log: [],
    clearColor: 0,
    clearAlpha: 1,
    pixelRatio: 1,
    size: [0, 0, false],
    outputColorSpace: 'linear',
    toneMapping: 99,
    info: { autoReset: false, render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
    compiled: 0,
    disposed: false,
    setClearColor(c, a) { this.clearColor = c; this.clearAlpha = a; this.log.push(`clear:${c.toString(16)}`); },
    setPixelRatio(p) { this.pixelRatio = p; this.log.push(`pr:${p}`); },
    setSize(w, h, s) { this.size = [w, h, s]; this.log.push(`size:${w}x${h}`); },
    compile() { this.compiled++; this.log.push('compile'); },
    dispose() { this.disposed = true; },
  };
  // three.js registers its own context listeners inside its constructor (before the core's). On restore it
  // re-creates its state: background (clear colour) and info are reset.
  const asCanvas = canvas.asCanvas();
  asCanvas.addEventListener('webglcontextlost', () => { t.log.push('three:lost'); }); // (three.js also preventDefault()s; left out so the test sees the core's)
  asCanvas.addEventListener('webglcontextrestored', () => {
    t.log.push('three:restored');
    t.clearColor = 0;
    t.info = { autoReset: true, render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } };
  });
  return t;
}

interface Rig {
  canvas: FakeCanvas;
  gl: FakeGl;
  three: FakeThree;
  core: ReturnType<typeof createRenderer>;
}

function rig(opts: RendererCoreOptions = {}, glParams: Record<number, unknown> = {}): Rig {
  const gl = fakeGl(glParams);
  const canvas = fakeCanvas((kind) => (kind === 'webgl2' ? gl : null));
  let three: FakeThree | null = null;
  const core = createRenderer(canvas.asCanvas(), {
    ...opts,
    createWebGLRenderer: () => {
      three = fakeThree(canvas);
      return three as unknown as WebGLRenderer;
    },
  });
  return { canvas, gl, three: three!, core };
}

function stats(): RenderStats {
  return { drawCalls: -1, triangles: -1, textures: -1, geometries: -1, resolutionScale: -1, qualityTier: -1 };
}

function bytesPerCall(fn: () => void, n = 20000): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn();
  let best = 1e9;
  for (let r = 0; r < 4; r++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

// ------------------------------------------------------------------ tests

describe('GFX-01 context creation (section 13 "Context")', () => {
  it('asks for WebGL2 with high-performance power, an opaque canvas, no stencil, no preserved buffer, no AA', () => {
    const r = rig();
    expect(r.canvas.getContextCalls).toHaveLength(1);
    const call = r.canvas.getContextCalls[0]!;
    expect(call.kind).toBe('webgl2');
    expect(call.attrs).toEqual(contextAttributes(false));
    expect(call.attrs).toMatchObject({
      alpha: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', antialias: false,
      depth: true,
    });
    expect(r.core.available).toBe(true);
    expect(r.core.failure).toBe('');
    expect(r.core.renderer).toBe(r.three);
  });

  it('antialias is opt-in (QUALITY start) and reaches both the context and three.js', () => {
    let seenAa: boolean | null = null;
    const gl = fakeGl();
    const canvas = fakeCanvas(() => gl);
    createRenderer(canvas.asCanvas(), {
      antialias: true,
      createWebGLRenderer: (_c, _gl, aa) => { seenAa = aa; return fakeThree(canvas) as unknown as WebGLRenderer; },
    });
    expect(canvas.getContextCalls[0]!.attrs!.antialias).toBe(true);
    expect(seenAa).toBe(true);
  });

  it('sRGB output, no tone mapping, the clear colour, info.autoReset', () => {
    const r = rig({ clearColor: 0x123456 });
    expect(r.three.outputColorSpace).toBe(SRGBColorSpace);
    expect(r.three.toneMapping).toBe(NoToneMapping);
    expect(r.three.clearColor).toBe(0x123456);
    expect(r.three.clearAlpha).toBe(1);
    expect(r.three.info.autoReset).toBe(true);
    expect(rig().three.clearColor).toBe(DEFAULT_CLEAR_COLOR);
  });

  it('no WebGL2: unavailable with a reason (including the browser status message), every member inert', () => {
    const canvas = fakeCanvas(() => {
      canvas.fire('webglcontextcreationerror', { statusMessage: 'GPU process blocked' });
      return null;
    });
    const core = createRenderer(canvas.asCanvas(), { createWebGLRenderer: () => { throw new Error('must not be called'); } });
    expect(core.available).toBe(false);
    expect(core.renderer).toBeNull();
    expect(core.failure).toMatch(/WebGL 2 is not available/);
    expect(core.failure).toContain('GPU process blocked');
    // No listeners left behind on the canvas.
    for (const k of Object.keys(canvas.listeners)) expect(canvas.listeners[k]).toHaveLength(0);
    expect(() => core.resize(1180, 820, 2)).not.toThrow();
    expect(() => core.setScale(1)).not.toThrow();
    expect(core.scale).toBe(1);
    expect(core.bufferWidth).toBe(0);
    expect(core.pixelRatio).toBe(0);
    expect(core.aspect).toBeCloseTo(1180 / 820, 9);
    const st = core.readStats(stats(), 2);
    expect(st).toEqual({ drawCalls: 0, triangles: 0, textures: 0, geometries: 0, resolutionScale: 1, qualityTier: 2 });
    expect(core.rebuild(new Scene(), new PerspectiveCamera())).toEqual({ materials: 0, textures: 0, missingTextures: 0 });
    const off = core.onContextLost(() => {});
    expect(() => off()).not.toThrow();
    expect(() => core.dispose()).not.toThrow();
  });

  it('getContext throwing, three.js throwing, or an already lost context: unavailable, never throws', () => {
    const throwing = fakeCanvas(() => { throw new Error('boom'); });
    const a = createRenderer(throwing.asCanvas());
    expect(a.available).toBe(false);
    expect(a.failure).toMatch(/WebGL 2 failed to start: boom/);

    const gl = fakeGl();
    const c2 = fakeCanvas(() => gl);
    const b = createRenderer(c2.asCanvas(), { createWebGLRenderer: () => { throw new Error('bad attrs'); } });
    expect(b.available).toBe(false);
    expect(b.failure).toMatch(/WebGL 2 failed to start: bad attrs/);
    expect(c2.listeners.webglcontextlost ?? []).toHaveLength(0);

    // Created, then failing to configure: the half-built renderer is disposed.
    const c4 = fakeCanvas(() => fakeGl());
    let half: FakeThree | null = null;
    const d = createRenderer(c4.asCanvas(), {
      createWebGLRenderer: () => {
        half = fakeThree(c4);
        half.setClearColor = () => { throw new Error('no clear'); };
        return half as unknown as WebGLRenderer;
      },
    });
    expect(d.available).toBe(false);
    expect(d.failure).toMatch(/WebGL 2 failed to start: no clear/);
    expect(half!.disposed).toBe(true);

    const lostGl = fakeGl();
    lostGl.lost = true;
    const c3 = fakeCanvas(() => lostGl);
    const c = createRenderer(c3.asCanvas(), { createWebGLRenderer: () => { throw new Error('must not be called'); } });
    expect(c.available).toBe(false);
    expect(c.failure).toMatch(/WebGL 2 .*lost/);
  });
});

describe('GFX-01 size and pixel ratio', () => {
  it('pixel ratio = devicePixelRatio x resolution scale (0.75 of device pixels to start)', () => {
    const r = rig();
    expect(r.core.scale).toBe(T_PERF.resScaleInitial);
    expect(r.core.pixelRatio).toBe(0); // nothing applied before the first resize
    r.core.resize(1180, 820, 2);
    expect(r.three.pixelRatio).toBeCloseTo(1.5, 9);
    expect(r.three.size).toEqual([1180, 820, true]);
    expect(r.core.pixelRatio).toBeCloseTo(1.5, 9);
    expect(r.core.bufferWidth).toBe(1770); // 0.75 of 2360 device px
    expect(r.core.bufferHeight).toBe(1230);
    r.core.setScale(1);
    expect(r.three.pixelRatio).toBe(2);
    expect(r.core.bufferWidth).toBe(2360);
    r.core.setScale(0.3); // clamped to resScaleMin
    expect(r.core.scale).toBe(T_PERF.resScaleMin);
    expect(r.three.pixelRatio).toBeCloseTo(2 * T_PERF.resScaleMin, 9);
    r.core.setScale(5);
    expect(r.core.scale).toBe(T_PERF.resScaleMax);
    r.core.setScale(Number.NaN);
    expect(r.core.scale).toBe(T_PERF.resScaleInitial);
  });

  it('an unchanged size or scale does not touch the canvas (setting canvas.width reallocates and clears it)', () => {
    const r = rig();
    r.core.resize(1180, 820, 2);
    const n = r.three.log.length;
    r.core.resize(1180, 820, 2);
    r.core.resize(1180.2, 819.8, 2); // rounds to the same CSS size
    r.core.setScale(T_PERF.resScaleInitial);
    expect(r.three.log.length).toBe(n);
    r.core.resize(1180, 820, 1);
    expect(r.three.log.length).toBeGreaterThan(n);
  });

  it('degenerate inputs stay finite: zero / negative / NaN sizes and ratios', () => {
    const r = rig();
    r.core.resize(0, -5, 0);
    expect(r.three.size).toEqual([1, 1, true]);
    expect(Number.isFinite(r.three.pixelRatio) && r.three.pixelRatio >= MIN_PIXEL_RATIO).toBe(true);
    r.core.resize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(r.three.size).toEqual([1, 1, true]);
    expect(r.core.aspect).toBe(1);
    expect(Number.isFinite(r.three.pixelRatio)).toBe(true);
  });

  it('the longer buffer side stays within MAX_BUFFER_SIDE and the GPU limits', () => {
    const big = rig();
    big.core.resize(5000, 2000, 2);
    expect(big.core.bufferWidth).toBeLessThanOrEqual(MAX_BUFFER_SIDE);
    // A GPU with a 2048 renderbuffer limit.
    const small = rig({}, { 0x84e8: 2048, 0x0d33: 8192, 0x0d3a: new Int32Array([8192, 8192]) });
    small.core.resize(1366, 1024, 2);
    expect(small.core.bufferWidth).toBeLessThanOrEqual(2048);
    expect(small.core.bufferWidth).toBeGreaterThan(2000);
    expect(small.core.bufferHeight).toBeLessThanOrEqual(2048);
    // Viewport limit lower still.
    const vp = rig({}, { 0x84e8: 16384, 0x0d3a: new Int32Array([1600, 1200]) });
    vp.core.resize(1366, 1024, 2);
    expect(vp.core.bufferWidth).toBeLessThanOrEqual(1200);
  });

  it('resize for 4:3, 16:10, iPad and 21:9 windows exposes the aspect for the cameras', () => {
    const r = rig();
    const cases: [number, number, number][] = [[1024, 768, 4 / 3], [1280, 800, 16 / 10], [1180, 820, 1180 / 820], [1680, 720, 21 / 9]];
    for (const [w, h, a] of cases) {
      r.core.resize(w, h, 2);
      expect(r.core.aspect).toBeCloseTo(a, 9);
      expect(aspectSupported(r.core.aspect)).toBe(true);
      expect(r.three.size).toEqual([w, h, true]);
      expect(r.core.bufferWidth).toBe(Math.floor(w * 1.5));
      expect(r.core.bufferHeight).toBe(Math.floor(h * 1.5));
      // The buffer keeps the window's aspect (no stretching).
      expect(r.core.bufferWidth / r.core.bufferHeight).toBeCloseTo(a, 2);
    }
    expect(aspectSupported(1)).toBe(false);
    expect(aspectSupported(32 / 9)).toBe(false);
    expect(ASPECT_MIN).toBeCloseTo(4 / 3, 9);
    expect(ASPECT_MAX).toBeCloseTo(21 / 9, 9);
  });
});

describe('GFX-01 pure helpers', () => {
  it('clampScale / effectivePixelRatio / bufferSide / viewAspect / gpuMaxSide', () => {
    expect(clampScale(0.75)).toBe(0.75);
    expect(clampScale(0)).toBe(T_PERF.resScaleInitial);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(T_PERF.resScaleInitial);
    expect(effectivePixelRatio(1180, 820, 2, 0.75)).toBeCloseTo(1.5, 9);
    expect(effectivePixelRatio(1180, 820, Number.NaN, 0.75)).toBeCloseTo(0.75, 9);
    expect(effectivePixelRatio(100, 100, 0.1, 0.6)).toBe(MIN_PIXEL_RATIO);
    expect(effectivePixelRatio(4000, 3000, 2, 1, 2048) * 4000).toBeCloseTo(2048, 6);
    expect(effectivePixelRatio(4000, 3000, 2, 1, Number.NaN) * 4000).toBeCloseTo(MAX_BUFFER_SIDE, 6);
    expect(bufferSide(1180, 1.5)).toBe(1770);
    expect(bufferSide(0, 1.5)).toBe(1);
    expect(viewAspect(1680, 720)).toBeCloseTo(21 / 9, 9);
    expect(viewAspect(0, 0)).toBe(1);
    expect(gpuMaxSide(null)).toBe(MAX_BUFFER_SIDE);
    expect(gpuMaxSide({ getParameter: () => { throw new Error('lost'); } })).toBe(MAX_BUFFER_SIDE);
    expect(gpuMaxSide({ getParameter: () => null })).toBe(MAX_BUFFER_SIDE);
  });
});

describe('GFX-01 stats', () => {
  it('readStats fills RenderStats from renderer.info and the scale, into the caller object', () => {
    const r = rig();
    r.three.info.render.calls = 42;
    r.three.info.render.triangles = 123456;
    r.three.info.memory.textures = 7;
    r.three.info.memory.geometries = 19;
    const out = stats();
    expect(r.core.readStats(out, 1)).toBe(out);
    expect(out).toEqual({ drawCalls: 42, triangles: 123456, textures: 7, geometries: 19, resolutionScale: 0.75, qualityTier: 1 });
  });

  it('resize with an unchanged size, setScale and readStats allocate nothing (per-frame paths)', () => {
    const r = rig();
    r.core.resize(1180, 820, 2);
    const out = stats();
    // Measured one path at a time (as GKP-05 does): bundling calls into one closure measures V8 double boxing
    // from inlining decisions, not the code under test.
    expect(bytesPerCall(() => { r.core.readStats(out, 1); })).toBeLessThan(1);
    expect(bytesPerCall(() => { r.core.resize(1180, 820, 2); })).toBeLessThan(1);
    expect(bytesPerCall(() => { r.core.setScale(0.75); })).toBeLessThan(1);
  });
});

describe('GFX-01 context loss and restore (section 3)', () => {
  it('lost: preventDefault (so the browser restores), lost = true, listeners run once; nothing else drawn', () => {
    const r = rig();
    let lostCalls = 0;
    r.core.onContextLost(() => { lostCalls++; });
    const e = r.canvas.fire('webglcontextlost');
    expect(e.defaultPrevented).toBe(true);
    expect(r.core.lost).toBe(true);
    expect(lostCalls).toBe(1);
    expect(r.core.lossCount).toBe(1);
    // A duplicate loss event does not notify twice.
    r.canvas.fire('webglcontextlost');
    expect(lostCalls).toBe(1);
    expect(r.core.lossCount).toBe(1);
  });

  it('restored: runs after three.js re-initialised; clear colour, output and size re-applied; listeners once', () => {
    const r = rig({ clearColor: 0x07070d });
    r.core.resize(1280, 800, 2);
    let restored = 0;
    let clearSeenByListener = -1;
    r.core.onContextRestored(() => { restored++; clearSeenByListener = r.three.clearColor; });
    r.canvas.fire('webglcontextlost');
    r.three.log.length = 0;
    r.canvas.fire('webglcontextrestored');
    expect(r.core.lost).toBe(false);
    expect(restored).toBe(1);
    expect(r.core.restoreCount).toBe(1);
    // Order: three.js reset first, then the core re-applied the clear colour and the size, then the listeners.
    expect(r.three.log[0]).toBe('three:restored');
    expect(r.three.log).toContain('clear:7070d');
    expect(r.three.log.indexOf('clear:7070d')).toBeGreaterThan(0);
    expect(r.three.log).toContain('size:1280x800');
    expect(clearSeenByListener).toBe(0x07070d);
    expect(r.three.info.autoReset).toBe(true);
    expect(r.three.outputColorSpace).toBe(SRGBColorSpace);
    expect(r.core.bufferWidth).toBe(1920);
    // A restore without a loss is ignored.
    r.canvas.fire('webglcontextrestored');
    expect(restored).toBe(1);
  });

  it('resizes while lost are kept and applied on restore', () => {
    const r = rig();
    r.core.resize(1180, 820, 2);
    r.canvas.fire('webglcontextlost');
    r.core.resize(1680, 720, 2);
    r.core.setScale(1);
    r.canvas.fire('webglcontextrestored');
    expect(r.three.size).toEqual([1680, 720, true]);
    expect(r.three.pixelRatio).toBe(2);
    expect(r.core.aspect).toBeCloseTo(21 / 9, 9);
  });

  it('loss / restore cycles repeat cleanly', () => {
    const r = rig();
    let lostN = 0, restN = 0;
    r.core.onContextLost(() => { lostN++; });
    r.core.onContextRestored(() => { restN++; });
    for (let i = 0; i < 5; i++) {
      r.canvas.fire('webglcontextlost');
      r.canvas.fire('webglcontextrestored');
    }
    expect([lostN, restN, r.core.lossCount, r.core.restoreCount]).toEqual([5, 5, 5, 5]);
    expect(r.core.lost).toBe(false);
  });

  it('a throwing listener does not stop the others; the first error is re-thrown afterwards', () => {
    const r = rig();
    const seen: string[] = [];
    r.core.onContextLost(() => { seen.push('a'); throw new Error('first'); });
    r.core.onContextLost(() => { seen.push('b'); throw new Error('second'); });
    r.core.onContextLost(() => { seen.push('c'); });
    expect(() => r.canvas.fire('webglcontextlost')).toThrow('first');
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(r.core.lost).toBe(true);
  });

  it('a failure re-applying state on restore still notifies the session, then surfaces the error', () => {
    const r = rig();
    r.core.resize(1180, 820, 2);
    let restored = 0;
    r.core.onContextRestored(() => { restored++; });
    r.canvas.fire('webglcontextlost');
    const orig = r.three.setSize;
    r.three.setSize = () => { throw new Error('size failed'); };
    expect(() => r.canvas.fire('webglcontextrestored')).toThrow('size failed');
    expect(restored).toBe(1);
    expect(r.core.lost).toBe(false);
    // The size was not recorded as applied: the next resize retries it.
    r.three.setSize = orig;
    r.three.log.length = 0;
    r.core.resize(1180, 820, 2);
    expect(r.three.log).toContain('size:1180x820');
    expect(r.core.pixelRatio).toBeCloseTo(1.5, 9);
  });

  it('unsubscribe works, also from inside a listener during dispatch', () => {
    const r = rig();
    const seen: string[] = [];
    const offA = r.core.onContextRestored(() => { seen.push('a'); offA(); });
    const offB = r.core.onContextRestored(() => { seen.push('b'); });
    r.canvas.fire('webglcontextlost');
    r.canvas.fire('webglcontextrestored');
    expect(seen).toEqual(['a', 'b']);
    offB();
    r.canvas.fire('webglcontextlost');
    r.canvas.fire('webglcontextrestored');
    expect(seen).toEqual(['a', 'b']);
  });

  it('dispose removes the listeners, disposes three.js, and later events or subscriptions do nothing', () => {
    const r = rig();
    let n = 0;
    r.core.onContextLost(() => { n++; });
    r.core.dispose();
    expect(r.three.disposed).toBe(true);
    expect(r.core.available).toBe(false);
    expect(r.core.renderer).toBeNull();
    r.canvas.fire('webglcontextlost');
    expect(n).toBe(0);
    expect(r.core.lost).toBe(false);
    // Only three.js's own (fake) listeners remain.
    expect(r.canvas.listeners.webglcontextlost).toHaveLength(1);
    expect(r.canvas.listeners.webglcontextrestored).toHaveLength(1);
    const off = r.core.onContextRestored(() => { n++; });
    expect(() => off()).not.toThrow();
    expect(() => r.core.dispose()).not.toThrow();
  });
});

describe('GFX-01 rebuild after restore', () => {
  function sceneWithTextures(): { scene: Scene; camera: PerspectiveCamera } {
    const scene = new Scene();
    const geo = new PlaneGeometry(1, 1);
    const ok = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    ok.needsUpdate = true;
    const gone = new DataTexture(new Uint8Array(4), 1, 1);
    gone.needsUpdate = true;
    (gone.image as { data: Uint8Array | null }).data = null; // CPU copy dropped after upload
    const neverUploaded = new DataTexture(null, 1, 1); // version 0: nothing to restore
    const shared = new MeshLambertMaterial({ map: ok });
    scene.add(new Mesh(geo, shared));
    scene.add(new Mesh(geo, shared)); // the same material counts once
    scene.add(new Mesh(geo, [new MeshBasicMaterial({ map: gone }), new MeshBasicMaterial({ alphaMap: neverUploaded })]));
    scene.add(new Mesh(geo, new ShaderMaterial({ uniforms: { tex: { value: ok } } })));
    return { scene, camera: new PerspectiveCamera() };
  }

  it('compiles the scene and reports materials, textures and textures that cannot be re-uploaded', () => {
    const r = rig();
    const { scene, camera } = sceneWithTextures();
    const rep = r.core.rebuild(scene, camera);
    expect(r.three.compiled).toBe(1);
    expect(rep.materials).toBe(4);
    expect(rep.textures).toBe(3);
    expect(rep.missingTextures).toBe(1);
  });

  it('is a no-op while the context is lost and after dispose', () => {
    const r = rig();
    const { scene, camera } = sceneWithTextures();
    r.canvas.fire('webglcontextlost');
    expect(r.core.rebuild(scene, camera)).toEqual({ materials: 0, textures: 0, missingTextures: 0 });
    expect(r.three.compiled).toBe(0);
    r.canvas.fire('webglcontextrestored');
    r.core.dispose();
    expect(r.core.rebuild(scene, camera).materials).toBe(0);
  });
});

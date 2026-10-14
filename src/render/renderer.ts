/**
 * [GFX-01] Renderer setup: WebGL2 context options, size and pixel ratio, resolution scale, context-loss
 * recovery, render statistics. One RendererCore per GameRenderer (created by index.ts in init()).
 *
 * Context (section 13): powerPreference 'high-performance', an opaque canvas (alpha false), no stencil buffer, no
 * preserved drawing buffer, no anti-aliasing at the default tier (opts.antialias exists for a QUALITY start).
 * sRGB output, no tone mapping (unlit / Lambert look, section 8). If WebGL2 is unavailable createRenderer() never
 * throws: it returns an inert core whose `failure` explains why (index.ts shows the message in the canvas layer).
 *
 * Size: the drawing buffer is cssW x cssH CSS px at pixel ratio = devicePixelRatio x resolution scale (scale
 * 0.6..1.0 from GFX-02, starting at T_PERF.resScaleInitial = 0.75), limited to MAX_BUFFER_SIDE and the GPU's
 * renderbuffer / viewport limits. The DOM HUD stays at native resolution. Re-applying an unchanged size does
 * nothing (setting canvas.width reallocates and clears the buffer). Any aspect ratio works: `aspect` = cssW / cssH
 * is exposed for the cameras (GFX-14 / GFX-15 keep the vertical field of view, so narrow windows keep the vertical
 * framing and lose width, and wide windows show more pitch; section 8 "Main camera").
 *
 * Context loss (section 3 "Pause, restore, rebuild GPU resources, then resume from the pause menu"):
 *   - 'webglcontextlost' is preventDefault()ed so the browser may restore the context; `lost` turns true and the
 *     onContextLost listeners run once (index.ts -> the session pauses). Nothing is drawn while lost.
 *   - 'webglcontextrestored': three.js re-creates its GL state first (its listener is registered before ours,
 *     inside the WebGLRenderer constructor), then this core re-applies what three.js resets (clear colour) and
 *     the drawing-buffer size, and runs the onContextRestored listeners (index.ts rebuilds the modules, then the
 *     session redraws; the player resumes from the pause menu). Geometry, textures and programs are re-uploaded
 *     by three.js from their CPU copies; rebuild(scene, camera) compiles every material again so the first frame
 *     back does not hitch, and reports textures that cannot be re-uploaded because their CPU copy is gone.
 *   - A listener that throws does not stop the others; the first error is re-thrown after all ran (so the global
 *     error handler still sees it).
 *
 * Stats: readStats(out, tier) fills a RenderStats from renderer.info (draw calls and triangles of the last
 * rendered frame; live textures and geometries) without allocating. index.ts publishes
 * window.__dotkickRendererStats.
 *
 * No allocation per frame: resize/setScale/readStats allocate nothing; event handling and rebuild are rare.
 */

import { NoToneMapping, SRGBColorSpace, WebGLRenderer, type Camera, type Material, type Object3D, type Texture } from 'three';
import type { RenderStats } from '../contracts/render';
import { T_PERF } from '../contracts/tuning';

export interface RendererCoreOptions {
  /** Initial resolution scale (0.6..1). */
  scale?: number;
  /** Clear colour (0xRRGGBB) drawn behind everything. Re-applied after a context restore. */
  clearColor?: number;
  /**
   * Multisample anti-aliasing for the default framebuffer. A context-creation attribute: it cannot change later.
   * Default false (section 13: anti-aliasing only if the budget holds; QUALITY may add multisampling).
   */
  antialias?: boolean;
  /**
   * Builds the three.js renderer on the created context. Default: `new WebGLRenderer(...)`. Lets Node tests drive
   * the core with a fake renderer (there is no WebGL in Node); production code never passes it.
   */
  createWebGLRenderer?: (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, antialias: boolean) => WebGLRenderer;
}

/** What rebuild() found: materials compiled, textures seen, textures that cannot be re-uploaded (CPU copy gone). */
export interface RebuildReport {
  materials: number;
  textures: number;
  missingTextures: number;
}

/** GFX-01 renderer core. One per GameRenderer. */
export interface RendererCore {
  /** False when WebGL2 is unavailable; every other member is then inert and `renderer` is null. */
  readonly available: boolean;
  /** Reason WebGL2 could not start ('' when available). */
  readonly failure: string;
  readonly renderer: WebGLRenderer | null;
  /** True between 'webglcontextlost' and 'webglcontextrestored'. Do not draw while lost. */
  readonly lost: boolean;
  /** Current resolution scale. */
  readonly scale: number;
  /** CSS aspect ratio (width / height) of the last resize. Cameras use it for their projection. */
  readonly aspect: number;
  /** Drawing-buffer size in device pixels after scale and limits (0 while unavailable). */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Pixel ratio handed to three.js (devicePixelRatio x scale, limited). */
  readonly pixelRatio: number;
  /** Context losses and restores seen since creation (diagnostics). */
  readonly lossCount: number;
  readonly restoreCount: number;
  /** Resize the drawing buffer: CSS size and device pixel ratio. Applies the current resolution scale. */
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Change the resolution scale (clamped to T_PERF.resScaleMin..resScaleMax). */
  setScale(scale: number): void;
  onContextLost(fn: () => void): () => void;
  onContextRestored(fn: () => void): () => void;
  /**
   * Fill `out` with the statistics of the last rendered frame (draw calls, triangles) and the live GPU resources
   * (textures, geometries), plus the resolution scale and the given tier. Zeros when unavailable. No allocation.
   */
  readStats(out: RenderStats, qualityTier: number): RenderStats;
  /**
   * After a context restore (or any time): compile every material of `scene` for `camera` so the first frame does
   * not hitch, and count textures whose CPU copy is gone (they would draw blank). No-op while lost / unavailable.
   */
  rebuild(scene: Object3D, camera: Camera): RebuildReport;
  dispose(): void;
}

/** Upper bound on drawing-buffer pixels per side (keeps memory sane on large external displays). */
export const MAX_BUFFER_SIDE = 4096;
/** Lowest pixel ratio ever handed to three.js (tiny windows at scale 0.6 on a DPR-1 screen still draw). */
export const MIN_PIXEL_RATIO = 0.25;
/** Supported window aspect range (section 3 "Windowing": 4:3 to 21:9). Outside it the view still renders. */
export const ASPECT_MIN = 4 / 3;
export const ASPECT_MAX = 21 / 9;
/** Default clear colour (the Dot design system's background). */
export const DEFAULT_CLEAR_COLOR = 0x07070d;

/** WebGL enums read through getParameter (literal values so fake contexts in tests work). */
const GL_MAX_RENDERBUFFER_SIZE = 0x84e8;
const GL_MAX_VIEWPORT_DIMS = 0x0d3a;
const GL_MAX_TEXTURE_SIZE = 0x0d33;

export function clampScale(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return T_PERF.resScaleInitial;
  return Math.max(T_PERF.resScaleMin, Math.min(T_PERF.resScaleMax, scale));
}

/**
 * Pixel ratio handed to three.js for a CSS size, device pixel ratio and resolution scale: dpr x scale, at least
 * MIN_PIXEL_RATIO, and lowered so the longer side stays within `maxSide` device pixels. Pure.
 */
export function effectivePixelRatio(cssW: number, cssH: number, dpr: number, scale: number, maxSide = MAX_BUFFER_SIDE): number {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const s = scale > 0 && Number.isFinite(scale) ? scale : T_PERF.resScaleInitial;
  let pr = Math.max(MIN_PIXEL_RATIO, d * s);
  const w = cssW > 0 && Number.isFinite(cssW) ? cssW : 1;
  const h = cssH > 0 && Number.isFinite(cssH) ? cssH : 1;
  const side = Math.max(w, h, 1);
  const limit = maxSide > 0 && Number.isFinite(maxSide) ? maxSide : MAX_BUFFER_SIDE;
  if (side * pr > limit) pr = limit / side;
  return pr;
}

/** Drawing-buffer side in device pixels for a CSS side and pixel ratio (three.js floors). Pure. */
export function bufferSide(css: number, pixelRatio: number): number {
  return Math.max(1, Math.floor(css * pixelRatio));
}

/** CSS aspect ratio width / height, safe for degenerate sizes (never 0, NaN or Infinity). Pure. */
export function viewAspect(cssW: number, cssH: number): number {
  const w = cssW > 0 && Number.isFinite(cssW) ? cssW : 1;
  const h = cssH > 0 && Number.isFinite(cssH) ? cssH : 1;
  return w / h;
}

/** True when the aspect ratio is inside the supported 4:3..21:9 window range (small tolerance). Pure. */
export function aspectSupported(aspect: number): boolean {
  return aspect >= ASPECT_MIN - 1e-3 && aspect <= ASPECT_MAX + 1e-3;
}

/**
 * Largest drawing-buffer side the GPU accepts: min(MAX_BUFFER_SIDE, MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS,
 * MAX_TEXTURE_SIZE). Unknown or failing queries leave MAX_BUFFER_SIDE.
 */
export function gpuMaxSide(gl: Pick<WebGL2RenderingContext, 'getParameter'> | null): number {
  let side = MAX_BUFFER_SIDE;
  if (!gl) return side;
  try {
    const rb = Number(gl.getParameter(GL_MAX_RENDERBUFFER_SIZE));
    if (rb > 0) side = Math.min(side, rb);
    const tex = Number(gl.getParameter(GL_MAX_TEXTURE_SIZE));
    if (tex > 0) side = Math.min(side, tex);
    const vp = gl.getParameter(GL_MAX_VIEWPORT_DIMS) as ArrayLike<number> | null;
    if (vp && vp.length >= 2) {
      const v = Math.min(Number(vp[0]), Number(vp[1]));
      if (v > 0) side = Math.min(side, v);
    }
  } catch {
    /* keep the default */
  }
  return side;
}

/** Context attributes for section 13 "Context". */
export function contextAttributes(antialias: boolean): WebGLContextAttributes {
  return {
    alpha: false,
    antialias,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  };
}

function defaultWebGLRenderer(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, antialias: boolean): WebGLRenderer {
  return new WebGLRenderer({
    canvas, context: gl, alpha: false, antialias, depth: true, stencil: false,
    premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
}

/** Call every listener; one that throws does not stop the others. The first error is re-thrown afterwards. */
function emit(list: readonly (() => void)[]): void {
  if (list.length === 0) return;
  const snapshot = list.slice(); // rare event: a listener may unsubscribe itself while we iterate
  let firstError: unknown = null;
  let failed = false;
  for (let i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i]!();
    } catch (err) {
      if (!failed) { failed = true; firstError = err; }
    }
  }
  if (failed) throw firstError;
}

/** True when the texture has nothing on the CPU to re-upload after a context restore. */
function textureMissing(t: Texture): boolean {
  const tt = t as Texture & { isRenderTargetTexture?: boolean; isDepthTexture?: boolean; isVideoTexture?: boolean };
  if (tt.isRenderTargetTexture || tt.isDepthTexture) return false; // re-rendered every use
  if (t.version === 0) return false; // never uploaded: nothing to restore
  const img = t.image as unknown;
  if (img === null || img === undefined) return true;
  if (typeof img === 'object' && 'data' in (img as object)) {
    const data = (img as { data: unknown }).data;
    return data === null || data === undefined;
  }
  if (typeof img === 'object' && 'width' in (img as object)) {
    const w = Number((img as { width: unknown }).width);
    return !(w > 0); // closed ImageBitmap / released canvas
  }
  return false;
}

/** Create the WebGL2 renderer for `canvas`. Never throws: on failure returns an unavailable core. */
export function createRenderer(canvas: HTMLCanvasElement, opts: RendererCoreOptions = {}): RendererCore {
  let renderer: WebGLRenderer | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let failure = '';
  let lost = false;
  let disposed = false;
  let lossCount = 0;
  let restoreCount = 0;
  let scale = clampScale(opts.scale ?? T_PERF.resScaleInitial);
  const clearColor = opts.clearColor ?? DEFAULT_CLEAR_COLOR;
  const antialias = opts.antialias === true;
  let cssW = 1, cssH = 1, dpr = 1;
  let maxSide = MAX_BUFFER_SIDE;
  /** Last size handed to three.js (to skip redundant reallocations). -1 = never applied. */
  let appliedW = -1, appliedH = -1, appliedPr = -1;
  let bufW = 0, bufH = 0;
  const lostFns: (() => void)[] = [];
  const restoredFns: (() => void)[] = [];

  // Capture the browser's reason when context creation fails (fired synchronously by getContext).
  let creationMessage = '';
  const onCreationError = (e: Event): void => {
    const msg = (e as Event & { statusMessage?: string }).statusMessage;
    if (typeof msg === 'string' && msg) creationMessage = msg;
  };

  try {
    canvas.addEventListener('webglcontextcreationerror', onCreationError, false);
    const ctx = canvas.getContext('webgl2', contextAttributes(antialias)) as WebGL2RenderingContext | null;
    if (!ctx) {
      failure = `WebGL 2 is not available in this browser.${creationMessage ? ` (${creationMessage})` : ''}`;
    } else if (typeof ctx.isContextLost === 'function' && ctx.isContextLost()) {
      failure = 'WebGL 2 is not available right now: the graphics context is lost.';
    } else {
      gl = ctx;
      renderer = (opts.createWebGLRenderer ?? defaultWebGLRenderer)(canvas, ctx, antialias);
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = NoToneMapping;
      renderer.setClearColor(clearColor, 1);
      renderer.info.autoReset = true;
      maxSide = gpuMaxSide(ctx);
    }
  } catch (e) {
    if (renderer) {
      try {
        (renderer as WebGLRenderer).dispose(); // created, then failed to configure: release it
      } catch {
        /* already broken */
      }
    }
    renderer = null;
    gl = null;
    failure = `WebGL 2 failed to start: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      canvas.removeEventListener('webglcontextcreationerror', onCreationError, false);
    } catch {
      /* fake canvases in tests */
    }
  }

  function applySize(force: boolean): void {
    if (!renderer) return;
    const pr = effectivePixelRatio(cssW, cssH, dpr, scale, maxSide);
    if (!force && pr === appliedPr && cssW === appliedW && cssH === appliedH) return;
    appliedPr = -1; // until three.js accepted it (a throw below means: retry on the next call)
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, true);
    appliedPr = pr;
    appliedW = cssW;
    appliedH = cssH;
    bufW = bufferSide(cssW, pr);
    bufH = bufferSide(cssH, pr);
  }

  const onLost = (e: Event): void => {
    e.preventDefault(); // allow the browser to restore the context
    if (lost || disposed) return;
    lost = true;
    lossCount++;
    emit(lostFns);
  };
  const onRestored = (): void => {
    if (!lost || disposed) return;
    lost = false;
    restoreCount++;
    let reapplyError: unknown = null;
    if (renderer) {
      // three.js re-created its state (its own listener ran first): restore what it resets. A failure here must
      // not keep the session from hearing about the restore, so it is re-thrown after the listeners ran.
      try {
        renderer.setClearColor(clearColor, 1);
        renderer.outputColorSpace = SRGBColorSpace;
        renderer.toneMapping = NoToneMapping;
        renderer.info.autoReset = true;
        maxSide = gpuMaxSide(gl);
        applySize(true);
      } catch (err) {
        reapplyError = err;
      }
    }
    emit(restoredFns);
    if (reapplyError !== null) throw reapplyError;
  };
  if (renderer) {
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
  }

  function subscribe(list: (() => void)[], fn: () => void): () => void {
    if (disposed) return () => {};
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  return {
    get available() { return renderer !== null; },
    get failure() { return failure; },
    get renderer() { return renderer; },
    get lost() { return lost; },
    get scale() { return scale; },
    get aspect() { return viewAspect(cssW, cssH); },
    get bufferWidth() { return renderer ? bufW : 0; },
    get bufferHeight() { return renderer ? bufH : 0; },
    get pixelRatio() { return renderer && appliedPr > 0 ? appliedPr : 0; },
    get lossCount() { return lossCount; },
    get restoreCount() { return restoreCount; },
    resize(w, h, ratio) {
      cssW = w > 0 && Number.isFinite(w) ? Math.max(1, Math.round(w)) : 1;
      cssH = h > 0 && Number.isFinite(h) ? Math.max(1, Math.round(h)) : 1;
      dpr = ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
      applySize(false);
    },
    setScale(s) {
      const next = clampScale(s);
      if (next === scale) return;
      scale = next;
      applySize(false);
    },
    onContextLost: (fn) => subscribe(lostFns, fn),
    onContextRestored: (fn) => subscribe(restoredFns, fn),
    readStats(out, qualityTier) {
      const r = renderer;
      if (r) {
        const info = r.info;
        out.drawCalls = info.render.calls;
        out.triangles = info.render.triangles;
        out.textures = info.memory.textures;
        out.geometries = info.memory.geometries;
      } else {
        out.drawCalls = 0;
        out.triangles = 0;
        out.textures = 0;
        out.geometries = 0;
      }
      out.resolutionScale = scale;
      out.qualityTier = qualityTier;
      return out;
    },
    rebuild(scene, camera) {
      const report: RebuildReport = { materials: 0, textures: 0, missingTextures: 0 };
      const r = renderer;
      if (!r || lost || disposed) return report;
      const seenMaterials: Material[] = [];
      const seenTextures: Texture[] = [];
      const visitValue = (v: unknown): void => {
        if (!v || typeof v !== 'object' || (v as { isTexture?: boolean }).isTexture !== true) return;
        const t = v as Texture;
        if (seenTextures.indexOf(t) >= 0) return;
        seenTextures.push(t);
        if (textureMissing(t)) report.missingTextures++;
      };
      const visitMaterial = (m: Material): void => {
        if (seenMaterials.indexOf(m) >= 0) return;
        seenMaterials.push(m);
        const rec = m as unknown as Record<string, unknown>;
        for (const key in rec) visitValue(rec[key]);
        // ShaderMaterial / onBeforeCompile uniforms: { name: { value: Texture } }.
        const uniforms = rec.uniforms as Record<string, { value?: unknown } | undefined> | undefined;
        if (uniforms && typeof uniforms === 'object') {
          for (const key in uniforms) visitValue(uniforms[key]?.value);
        }
        // [QF-4] onBeforeCompile uniforms held in a closure, exposed as userData.uniforms.
        const ud = (rec.userData as { uniforms?: Record<string, { value?: unknown } | undefined> } | undefined)?.uniforms;
        if (ud && typeof ud === 'object') {
          for (const key in ud) visitValue(ud[key]?.value);
        }
      };
      scene.traverse((o) => {
        const mat = (o as Object3D & { material?: Material | Material[] }).material;
        if (!mat) return;
        if (Array.isArray(mat)) { for (let i = 0; i < mat.length; i++) visitMaterial(mat[i]!); }
        else visitMaterial(mat);
      });
      report.materials = seenMaterials.length;
      report.textures = seenTextures.length;
      // Programs are re-created lazily on first use after a restore; compile now (synchronously) instead.
      r.compile(scene, camera);
      return report;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      lostFns.length = 0;
      restoredFns.length = 0;
      if (renderer) renderer.dispose();
      renderer = null;
      gl = null;
      lost = false;
    },
  };
}

/**
 * [GFX-01] Renderer setup: WebGL2 context options, size and pixel ratio, resolution scale, context-loss
 * recovery. Section 13 "Context": powerPreference 'high-performance', opaque canvas, no stencil, no preserved
 * drawing buffer, no anti-aliasing at the default tier. The 3D canvas renders at `scale` (0.6..1.0, starting at
 * T_PERF.resScaleInitial = 0.75) of device pixels; the DOM HUD stays at native resolution.
 *
 * Context loss (section 3): 'webglcontextlost' is preventDefault()ed so the browser may restore it; listeners
 * registered with onContextLost / onContextRestored let the session pause, and index.ts rebuilds GPU state
 * (three.js re-uploads geometry and textures lazily after a restore).
 *
 * WAVE 0 BASELINE (FND-05). GFX-01 owns and refines this file.
 */

import { WebGLRenderer } from 'three';
import { T_PERF } from '../contracts/tuning';

export interface RendererCoreOptions {
  /** Initial resolution scale (0.6..1). */
  scale?: number;
  /** Clear colour (0xRRGGBB) drawn behind everything. */
  clearColor?: number;
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
  /** Resize the drawing buffer: CSS size and device pixel ratio. Applies the current resolution scale. */
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Change the resolution scale (clamped to T_PERF.resScaleMin..resScaleMax). */
  setScale(scale: number): void;
  onContextLost(fn: () => void): () => void;
  onContextRestored(fn: () => void): () => void;
  dispose(): void;
}

/** Upper bound on drawing-buffer pixels per side (keeps memory sane on large external displays). */
const MAX_BUFFER_SIDE = 4096;

export function clampScale(scale: number): number {
  if (!(scale > 0)) return T_PERF.resScaleInitial;
  return Math.max(T_PERF.resScaleMin, Math.min(T_PERF.resScaleMax, scale));
}

/** Pixel ratio handed to three.js for a device pixel ratio and resolution scale, limited by MAX_BUFFER_SIDE. */
export function effectivePixelRatio(cssW: number, cssH: number, dpr: number, scale: number): number {
  let pr = Math.max(0.25, dpr * scale);
  const side = Math.max(cssW, cssH, 1);
  if (side * pr > MAX_BUFFER_SIDE) pr = MAX_BUFFER_SIDE / side;
  return pr;
}

/** Create the WebGL2 renderer for `canvas`. Never throws: on failure returns an unavailable core. */
export function createRenderer(canvas: HTMLCanvasElement, opts: RendererCoreOptions = {}): RendererCore {
  let renderer: WebGLRenderer | null = null;
  let failure = '';
  let lost = false;
  let scale = clampScale(opts.scale ?? T_PERF.resScaleInitial);
  let cssW = 1, cssH = 1, dpr = 1;
  const lostFns: (() => void)[] = [];
  const restoredFns: (() => void)[] = [];

  const attrs: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  };

  try {
    const gl = canvas.getContext('webgl2', attrs);
    if (!gl) {
      failure = 'WebGL 2 is not available in this browser.';
    } else {
      renderer = new WebGLRenderer({
        canvas, context: gl, alpha: false, antialias: false, depth: true, stencil: false,
        premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      renderer.setClearColor(opts.clearColor ?? 0x07070d, 1);
      renderer.info.autoReset = true;
    }
  } catch (e) {
    renderer = null;
    failure = `WebGL 2 failed to start: ${e instanceof Error ? e.message : String(e)}`;
  }

  const onLost = (e: Event): void => {
    e.preventDefault(); // allow the browser to restore the context
    if (lost) return;
    lost = true;
    for (let i = 0; i < lostFns.length; i++) lostFns[i]!();
  };
  const onRestored = (): void => {
    if (!lost) return;
    lost = false;
    if (renderer) applySize();
    for (let i = 0; i < restoredFns.length; i++) restoredFns[i]!();
  };
  if (renderer) {
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
  }

  function applySize(): void {
    if (!renderer) return;
    renderer.setPixelRatio(effectivePixelRatio(cssW, cssH, dpr, scale));
    renderer.setSize(cssW, cssH, true);
  }

  function subscribe(list: (() => void)[], fn: () => void): () => void {
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
    resize(w, h, ratio) {
      cssW = Math.max(1, Math.round(w));
      cssH = Math.max(1, Math.round(h));
      dpr = ratio > 0 ? ratio : 1;
      applySize();
    },
    setScale(s) {
      const next = clampScale(s);
      if (next === scale) return;
      scale = next;
      applySize();
    },
    onContextLost: (fn) => subscribe(lostFns, fn),
    onContextRestored: (fn) => subscribe(restoredFns, fn),
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      lostFns.length = 0;
      restoredFns.length = 0;
      if (renderer) renderer.dispose();
      renderer = null;
    },
  };
}

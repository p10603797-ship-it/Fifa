/**
 * GameRenderer implementation (contracts/app.ts). [FND-05] Orchestrates the render modules in a FIXED order and
 * owns interpolation: once per animation frame it fills one preallocated InterpState from prev/curr/alpha, runs
 * every module's update, then draws the scene once.
 *
 * MODULE ORDER (creation, update, events):
 *   quality (GFX-02) -> stadium (GFX-05) -> pitch (GFX-03) -> goals (GFX-04) -> crowd (GFX-06)
 *   -> players/model (GFX-07, uses kits GFX-08 and anim GFX-09..12) -> ball + blob shadows (GFX-13)
 *   -> markers (GFX-13) -> effects (GFX-16) -> replay (GFX-16)
 *   cameras run first in update: replay records/substitutes the frame, then broadcast (GFX-14) and cinematic
 *   (GFX-15) place ctx.camera, then the scene modules above.
 *
 * Also sets window.__dotkickRendererStats = () => RenderStats for diagnostics, the benchmark and e2e tests.
 * If WebGL2 is unavailable, init() does not throw: the renderer stays inert, the projector still works (camera
 * maths only) and a clear message takes the canvas's place while a match is active. The message lives in the
 * canvas layer (right after #game, same z-index), so the HUD, the touch controls (PAUSE) and the pause menu stay
 * above it, visible and usable.
 *
 * SETTINGS: the SettingsStore replaces its Settings object on every update, so the snapshot handed to init() goes
 * stale. setSettings(s) / bindSettings(store) keep ctx.settings current for every module and re-apply camera and
 * graphics settings (tier and fixed resolution scale) when they change. [CR: GameRenderer.setSettings in
 * contracts/app.ts; the app calls it from its settings subscriber.]
 *
 * INTEGRATION [INT-C]
 *  - Quality (GFX-02): a tier the quality module picks on its own (AUTO startup test, step down) arrives through
 *    QualityHooks.setTier and is broadcast to every other module's setQuality, exactly like a settings change.
 *    QualityHooks.lowPowerSuspected only records `lowPowerSuspected` for diagnostics: the ONE Low Power hint path is
 *    GFX-02's detector -> render/quality.ts onLowPowerSuspected listeners -> platform/ipados.ts (toast, sets
 *    settings.lowPowerHintShown). The renderer never shows a hint itself.
 *  - MSAA is a context-creation attribute and is never recreated mid-session: the context gets multisampling only
 *    when the stored settings ask for the QUALITY tier when the renderer starts (TierParams.msaa of QUALITY). AUTO and
 *    later switches to QUALITY get the shadow map now and no multisampling (MSAA follows an explicit QUALITY choice
 *    from the next app start). A QUALITY context that steps down keeps its multisampling (`msaa` reports it).
 *  - Context loss (GFX-01): 'webglcontextlost' -> contextLost = true, nothing is drawn, onContextLost listeners run
 *    (the session pauses). 'webglcontextrestored' -> three.js re-creates its GL state, then this file rebuilds: the
 *    core recompiles every scene material (RendererCore.rebuild; geometry and textures re-upload from their CPU
 *    copies on the next draw) and the viewport is re-applied to every module; only then contextLost turns
 *    false and the onContextRestored listeners run (the session may offer resume). The session must not resume while
 *    contextLost is true (CR to the app owner).
 *  - cameraX(): x of the camera drawn last (the broadcast camera in open play) for stereo panning of sim events
 *    (audio/sfx.ts setCameraX; the app wires it once per frame).
 *  - Establishing shots: the GFX-15 director already shows them in PRE_MATCH (kick-off) and FULL_TIME / POST_MATCH,
 *    skippable through the sim's skip, so the app needs no establishing() calls.
 */

import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import type { FrameInfo, GameRenderer, SettingsStore } from '../contracts/app';
import { NUM_SLOTS, WORLD_MAX_X, WORLD_MIN_X } from '../contracts/constants';
import type { Club } from '../contracts/data';
import { QualityTier } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import type { CameraProjector } from '../contracts/input';
import type { RenderStats } from '../contracts/render';
import { createDefaultSettings, type CameraSettings, type Settings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { T_PERF } from '../contracts/tuning';
import { createBall } from './ball';
import { createBroadcastCamera } from './camera/broadcast';
import { createCinematicCamera } from './camera/cinematic';
import { createCrowd } from './crowd';
import { createEffects } from './effects';
import { createGoals } from './goals';
import { createMarkers } from './markers';
import { createPitch } from './pitch';
import { createPlayerModel } from './players/model';
import { createQuality, sanitizeTier, TIER_PARAMS, type QualityModule, type QualityOptions } from './quality';
import { createRenderer, type RebuildReport, type RendererCore, type RendererCoreOptions } from './renderer';
import { createReplay, type ReplayModule } from './replay';
import { createStadium } from './stadium';
import { createInterpState, type InterpState, type RenderContext, type RenderFrame, type RenderModule } from './types';

declare global {
  interface Window {
    /** Render statistics of the last drawn frame (diagnostics, benchmark, e2e). Set by createGameRenderer. */
    __dotkickRendererStats?: () => RenderStats;
  }
}

/** GameRenderer plus the GFX-01 context-loss hooks the session uses to pause and rebuild. */
export interface DotkickRenderer extends GameRenderer {
  /** False when WebGL2 could not start (init() then leaves the renderer inert). */
  readonly available: boolean;
  /** Why WebGL2 is unavailable ('' otherwise). */
  readonly failure: string;
  /** WebGL context lost: pause the match. Returns an unsubscribe function. */
  onContextLost(fn: () => void): () => void;
  /** Context restored and GPU resources rebuilt: resume from the pause menu. */
  onContextRestored(fn: () => void): () => void;
  /**
   * True from 'webglcontextlost' until the restored context is rebuilt (nothing is drawn meanwhile). The session must
   * keep the match paused (no resume) while this is true.
   */
  readonly contextLost: boolean;
  /** Rebuild report of the latest context restore (null before one happened). Diagnostics and tests. */
  readonly lastRebuild: Readonly<RebuildReport> | null;
  /** The WebGL context was created with multisample anti-aliasing (explicit QUALITY tier at start). */
  readonly msaa: boolean;
  /** GFX-02's Low Power Mode detector fired this page (diagnostics only; platform/ipados.ts shows the hint). */
  readonly lowPowerSuspected: boolean;
  /**
   * x (m) of the camera drawn last: the broadcast camera in open play, the set-piece / replay camera while one is
   * active. Clamped to the world bounds, 0 before the first frame. For stereo panning (audio sfx.setCameraX).
   */
  cameraX(): number;
  /**
   * Apply the latest settings snapshot. ctx.settings is replaced for every module; camera / reduced motion and
   * graphics (quality tier, fixed resolution scale) are re-applied only when they changed; modules get
   * RenderModule.onSettings. Cheap when nothing relevant changed. Safe before init() and after dispose().
   */
  setSettings(s: Readonly<Settings>): void;
  /**
   * Follow a SettingsStore: applies store.get() now and on every change until the returned function or dispose()
   * runs. Binding again replaces the previous binding.
   */
  bindSettings(store: Pick<SettingsStore, 'get' | 'subscribe'>): () => void;
}

/** Test seams and environment for createGameRenderer (production code passes nothing). */
export interface GameRendererOptions {
  /** Builds the GFX-01 core. Default createRenderer; Node tests pass a fake core (there is no WebGL in Node). */
  createCore?: (canvas: HTMLCanvasElement, opts: RendererCoreOptions) => RendererCore;
  /** Builds the scene modules after quality, in MODULE ORDER. Default: the GFX modules. Node tests pass stubs. */
  createModules?: (ctx: RenderContext) => RenderModule[];
  /** GFX-02 environment (clock, frame wait, page visibility); default the browser's. */
  quality?: QualityOptions;
}

/** The GFX scene modules after quality, in MODULE ORDER. */
function defaultModules(ctx: RenderContext): RenderModule[] {
  return [
    createStadium(ctx),
    createPitch(ctx),
    createGoals(ctx),
    createCrowd(ctx),
    createPlayerModel(ctx),
    createBall(ctx),
    createMarkers(ctx),
    createEffects(ctx),
  ];
}

/** Multisampling for a context created with these settings: explicit QUALITY only (see INTEGRATION above). Pure. */
export function msaaAtStart(settings: Readonly<Settings>): boolean {
  const t = sanitizeTier(settings.graphics.tier);
  return t === QualityTier.QUALITY && TIER_PARAMS[t]!.msaa;
}

/**
 * Interpolate render state: value = prev + (curr - prev) * alpha for every player and the ball. Facing is
 * blended and re-normalised. Pure; no allocation.
 */
export function fillInterp(out: InterpState, prev: ReadonlySimState, curr: ReadonlySimState, alpha: number): void {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = prev.players[i]!;
    const c = curr.players[i]!;
    out.x[i] = p.x + (c.x - p.x) * a;
    out.z[i] = p.z + (c.z - p.z) * a;
    out.vx[i] = p.vx + (c.vx - p.vx) * a;
    out.vz[i] = p.vz + (c.vz - p.vz) * a;
    let fx = p.fx + (c.fx - p.fx) * a;
    let fz = p.fz + (c.fz - p.fz) * a;
    const l = Math.sqrt(fx * fx + fz * fz);
    if (l > 1e-4) { fx /= l; fz /= l; } else { fx = c.fx; fz = c.fz; }
    out.fx[i] = fx;
    out.fz[i] = fz;
  }
  const pb = prev.ball, cb = curr.ball;
  out.ballX = pb.x + (cb.x - pb.x) * a;
  out.ballY = pb.y + (cb.y - pb.y) * a;
  out.ballZ = pb.z + (cb.z - pb.z) * a;
}

const MISSING_ID = 'dk-webgl-missing';

/** Same game settings field by field (only the parts the renderer follows). Pure. */
function sameCamera(a: Readonly<Settings>, b: Readonly<Settings>): boolean {
  return a.camera.type === b.camera.type && a.camera.height === b.camera.height && a.camera.zoom === b.camera.zoom
    && a.accessibility.reducedCameraMotion === b.accessibility.reducedCameraMotion;
}
function sameGraphics(a: Readonly<Settings>, b: Readonly<Settings>): boolean {
  return a.graphics.tier === b.graphics.tier && a.graphics.resolutionScale === b.graphics.resolutionScale;
}

/**
 * Show / hide the "3D view unavailable" message. It replaces the canvas visually and stays IN THE CANVAS LAYER:
 * inserted right after the canvas with the canvas's z-index, so #hud, #touch and #ui (higher z-index, later in the
 * DOM) draw above it and the pause control and pause menu stay usable. pointer-events: none.
 */
function showUnavailable(canvas: HTMLCanvasElement | null, reason: string, visible: boolean): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(MISSING_ID);
  if (!visible) {
    if (el) el.style.display = 'none';
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = MISSING_ID;
    el.setAttribute('role', 'alert');
    let z = '0';
    if (canvas && typeof getComputedStyle === 'function') {
      const cz = getComputedStyle(canvas).zIndex;
      if (cz && cz !== 'auto') z = cz;
    }
    el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;'
      + `background:#07070d;color:#f2f2f5;font:16px/1.5 system-ui,sans-serif;text-align:center;z-index:${z};pointer-events:none`;
    const box = document.createElement('div');
    box.style.cssText = 'max-width:520px';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:20px;font-weight:600;margin-bottom:8px;color:#ff6b35';
    h.textContent = '3D view unavailable';
    const p = document.createElement('div');
    p.textContent = `${reason} DotKick needs WebGL 2 to draw the match. Update iPadOS / Safari, or turn WebGL on in your browser settings.`;
    box.append(h, p);
    el.append(box);
    if (canvas && canvas.parentElement) canvas.after(el);
    else document.body.prepend(el);
  }
  el.style.display = 'flex';
}

export function createGameRenderer(opts: GameRendererOptions = {}): DotkickRenderer {
  const settings0 = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
    settings: settings0,
    clubs: [],
    size: { cssW: 1180, cssH: 820, dpr: 1, scale: T_PERF.resScaleInitial },
    tier: QualityTier.BALANCED,
    cameraSettings: { ...settings0.camera },
    reducedMotion: false,
    night: false,
  };
  ctx.scene.matrixWorldAutoUpdate = true;

  // Cameras exist before init so the projector works headless / without WebGL.
  const broadcast = createBroadcastCamera(ctx);
  const cinematic = createCinematicCamera(ctx);

  let core: RendererCore | null = null;
  let canvasEl: HTMLCanvasElement | null = null;
  let quality: QualityModule | null = null;
  let replay: ReplayModule | null = null;
  /** Scene modules in the fixed order (cameras and replay handled explicitly). */
  const modules: RenderModule[] = [];
  let matchActive = false;
  const interp = createInterpState();
  const frameObj: RenderFrame = {
    prev: null as unknown as ReadonlySimState,
    curr: null as unknown as ReadonlySimState,
    alpha: 0,
    frame: { nowMs: 0, dtMs: 0, frame: 0, ticks: 0, paused: false },
    interp,
  };
  const lostFns: (() => void)[] = [];
  const restoredFns: (() => void)[] = [];
  /** Tier last requested through setQuality / settings (re-requested when the fixed resolution scale changes). */
  let requestedTier: QualityTier = settings0.graphics.tier;
  let unbindSettings: (() => void) | null = null;
  /** Lost and not rebuilt yet (see DotkickRenderer.contextLost). */
  let lost = false;
  let lastRebuild: RebuildReport | null = null;
  let msaa = false;
  let lowPower = false;

  const projector: CameraProjector = {
    screenToPitch: (sx, sy, out) => (cinematic.active ? cinematic : broadcast).screenToPitch(sx, sy, out),
    pitchToScreen: (x, y, z, out) => (cinematic.active ? cinematic : broadcast).pitchToScreen(x, y, z, out),
    stickRotation: () => (cinematic.active ? cinematic : broadcast).stickRotation(),
  };

  function statsNow(): RenderStats {
    const r = core?.renderer;
    return {
      drawCalls: r ? r.info.render.calls : 0,
      triangles: r ? r.info.render.triangles : 0,
      textures: r ? r.info.memory.textures : 0,
      geometries: r ? r.info.memory.geometries : 0,
      resolutionScale: core ? core.scale : ctx.size.scale,
      qualityTier: ctx.tier,
    };
  }

  function subscribe(list: (() => void)[], fn: () => void): () => void {
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Run every listener (a copy: a listener may unsubscribe); one that throws does not stop the others. */
  function emitAll(list: (() => void)[]): void {
    const copy = list.slice();
    let first: unknown = null;
    for (let i = 0; i < copy.length; i++) {
      try {
        copy[i]!();
      } catch (err) {
        if (first === null) first = err;
      }
    }
    if (first !== null) throw first;
  }

  /** A resolved tier reaches every module but quality (which applied it), the replay and the cameras. */
  function broadcastTier(tier: QualityTier): void {
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i]!;
      if (m !== quality) m.setQuality?.(tier);
    }
    replay?.setQuality?.(tier);
    broadcast.setQuality?.(tier);
    cinematic.setQuality?.(tier);
  }

  /**
   * After 'webglcontextrestored' (three.js already re-created its GL state, keeping its JS-side flags such as
   * shadowMap.enabled, and the core re-applied clear colour and size): re-apply the viewport to every module and
   * recompile every material for the scene. Geometry and textures re-upload from their CPU copies on the next draw.
   */
  function rebuildAfterRestore(c: RendererCore): void {
    api.resize(ctx.size.cssW, ctx.size.cssH, ctx.size.dpr);
    const report = c.rebuild(ctx.scene, ctx.camera);
    lastRebuild = report;
    if (report.missingTextures > 0) {
      console.warn(`[render] context restored: ${report.missingTextures} texture(s) have no CPU copy and draw blank`);
    }
  }

  const api: DotkickRenderer = {
    projector,
    get available() { return core !== null && core.available; },
    get failure() { return core ? core.failure : ''; },
    get replaying() { return replay !== null && replay.playing; },
    get contextLost() { return lost; },
    get lastRebuild() { return lastRebuild; },
    get msaa() { return msaa; },
    get lowPowerSuspected() { return lowPower; },

    cameraX() {
      const x = ctx.camera.position.x;
      if (!Number.isFinite(x)) return 0;
      return x < WORLD_MIN_X ? WORLD_MIN_X : x > WORLD_MAX_X ? WORLD_MAX_X : x;
    },

    init(canvas: HTMLCanvasElement, settings: Readonly<Settings>) {
      if (core) return;
      canvasEl = canvas;
      ctx.settings = settings;
      requestedTier = settings.graphics.tier;
      ctx.cameraSettings = { ...settings.camera };
      ctx.reducedMotion = settings.accessibility.reducedCameraMotion;
      broadcast.setSettings(ctx.cameraSettings, ctx.reducedMotion);
      msaa = msaaAtStart(settings);
      core = (opts.createCore ?? createRenderer)(canvas, { clearColor: 0x07070d, antialias: msaa });
      if (typeof window !== 'undefined') window.__dotkickRendererStats = statsNow;
      if (!core.available || !core.renderer) {
        msaa = false;
        console.warn(`[render] ${core.failure}`);
        return;
      }
      ctx.renderer = core.renderer;
      const c = core;
      c.onContextLost(() => {
        lost = true;
        emitAll(lostFns);
      });
      c.onContextRestored(() => {
        try {
          rebuildAfterRestore(c);
        } catch (err) {
          console.error('[render] rebuild after context restore failed', err);
        } finally {
          lost = c.lost;
          if (!lost) emitAll(restoredFns);
        }
      });
      quality = createQuality(ctx, {
        setScale: (s) => {
          c.setScale(s);
          if (ctx.size.scale === c.scale) return;
          ctx.size.scale = c.scale;
          for (let i = 0; i < modules.length; i++) modules[i]!.resize?.(); // RenderModule.resize: scale is part of ctx.size
        },
        setTier: (t) => broadcastTier(t),
        lowPowerSuspected: () => { lowPower = true; },
      }, opts.quality);
      modules.push(quality);
      const scene = (opts.createModules ?? defaultModules)(ctx);
      for (let i = 0; i < scene.length; i++) modules.push(scene[i]!);
      replay = createReplay(ctx);
      if (typeof window !== 'undefined') {
        api.resize(window.innerWidth || 1180, window.innerHeight || 820, window.devicePixelRatio || 1);
      }
    },

    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      ctx.clubs = clubs;
      ctx.night = state.config.night === 1;
      if (!core || !core.available) {
        showUnavailable(canvasEl, core ? core.failure : 'The renderer was not initialised.', true);
        matchActive = false;
        return;
      }
      for (let i = 0; i < modules.length; i++) modules[i]!.setMatch?.(state, clubs);
      replay?.setMatch?.(state, clubs);
      broadcast.setMatch!(state, clubs);
      cinematic.setMatch?.(state, clubs);
      fillInterp(interp, state, state, 1);
      matchActive = true;
    },

    async warmUp() {
      if (!core || !core.available || !core.renderer || core.lost) return;
      const r = core.renderer;
      // Compile every material against the scene's lights with all match objects visible. compileAsync only when
      // parallel compilation exists (three.js warns otherwise, and e2e requires a clean console).
      try {
        if (r.extensions.has('KHR_parallel_shader_compile')) await r.compileAsync(ctx.scene, ctx.camera);
        else r.compile(ctx.scene, ctx.camera);
      } catch {
        r.compile(ctx.scene, ctx.camera);
      }
      for (let i = 0; i < modules.length; i++) {
        const w = modules[i]!.warmUp;
        if (w) await w();
      }
    },

    resize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
      ctx.size.cssW = Math.max(1, cssWidth);
      ctx.size.cssH = Math.max(1, cssHeight);
      ctx.size.dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
      if (core && core.available) {
        core.resize(ctx.size.cssW, ctx.size.cssH, ctx.size.dpr);
        ctx.size.scale = core.scale;
      }
      broadcast.resize!();
      cinematic.resize?.();
      for (let i = 0; i < modules.length; i++) modules[i]!.resize?.();
    },

    render(prev: ReadonlySimState, curr: ReadonlySimState, alpha: number, frame: FrameInfo) {
      if (!matchActive || !core || !core.renderer || core.lost || lost) return;
      fillInterp(interp, prev, curr, alpha);
      frameObj.prev = prev;
      frameObj.curr = curr;
      frameObj.alpha = alpha;
      frameObj.frame = frame;
      replay!.update(frameObj);
      broadcast.update(frameObj);
      cinematic.update(frameObj);
      for (let i = 0; i < modules.length; i++) modules[i]!.update(frameObj);
      core.renderer.render(ctx.scene, ctx.camera);
    },

    onEvents(events: EventBuffer, state: ReadonlySimState) {
      if (!matchActive) return;
      cinematic.onEvents?.(events, state);
      broadcast.onEvents?.(events, state);
      for (let i = 0; i < modules.length; i++) modules[i]!.onEvents?.(events, state);
      replay?.onEvents?.(events, state);
    },

    setCamera(c: CameraSettings, reducedMotion: boolean) {
      ctx.cameraSettings = { type: c.type, height: c.height, zoom: c.zoom };
      ctx.reducedMotion = reducedMotion;
      broadcast.setSettings(ctx.cameraSettings, reducedMotion);
      cinematic.setSettings(ctx.cameraSettings, reducedMotion);
    },

    setQuality(tier: QualityTier) {
      requestedTier = tier;
      if (!quality) return;
      broadcastTier(quality.request(tier));
    },

    stats: statsNow,

    startReplay(seconds: number) {
      return replay !== null && matchActive && replay.start(seconds);
    },
    stopReplay() { replay?.stop(); },

    clearMatch() {
      for (let i = 0; i < modules.length; i++) modules[i]!.clearMatch?.();
      replay?.clearMatch?.();
      broadcast.clearMatch?.();
      cinematic.clearMatch?.();
      matchActive = false;
      showUnavailable(canvasEl, '', false);
      if (core && core.renderer && !core.lost) {
        core.renderer.setRenderTarget(null);
        core.renderer.clear(true, true, false);
      }
    },

    setSettings(s: Readonly<Settings>) {
      const prev = ctx.settings;
      if (s === prev) return;
      ctx.settings = s;
      if (!sameCamera(prev, s)) api.setCamera(s.camera, s.accessibility.reducedCameraMotion);
      // quality.request (GFX-02) re-reads the fixed resolution scale from ctx.settings: a new tier is requested as
      // set; a scale-only change re-requests the current tier.
      if (s.graphics.tier !== prev.graphics.tier) api.setQuality(s.graphics.tier);
      else if (!sameGraphics(prev, s)) api.setQuality(requestedTier);
      for (let i = 0; i < modules.length; i++) modules[i]!.onSettings?.(s);
      replay?.onSettings?.(s);
    },

    bindSettings(store) {
      unbindSettings?.();
      const off = store.subscribe((s) => api.setSettings(s));
      api.setSettings(store.get());
      const unbind = (): void => {
        off();
        if (unbindSettings === unbind) unbindSettings = null;
      };
      unbindSettings = unbind;
      return unbind;
    },

    dispose() {
      unbindSettings?.();
      api.clearMatch();
      for (let i = modules.length - 1; i >= 0; i--) modules[i]!.dispose();
      modules.length = 0;
      replay?.dispose();
      replay = null;
      broadcast.dispose();
      cinematic.dispose();
      quality = null;
      core?.dispose();
      core = null;
      lostFns.length = 0;
      restoredFns.length = 0;
      lost = false;
      if (typeof window !== 'undefined' && window.__dotkickRendererStats === statsNow) delete window.__dotkickRendererStats;
    },

    onContextLost: (fn) => subscribe(lostFns, fn),
    onContextRestored: (fn) => subscribe(restoredFns, fn),
  };
  return api;
}

/**
 * Render-layer shared types. [FND-05] FROZEN after Wave 0: GFX-01..16 build against these; changes go
 * through the lead as a change request.
 *
 * Flow per animation frame (src/render/index.ts):
 *   1. index.ts fills one preallocated InterpState from prev/curr/alpha (the only place that interpolates).
 *   2. Every RenderModule.update(frame) runs in a fixed order (see MODULE ORDER in index.ts).
 *   3. index.ts draws the scene once with ctx.camera.
 *
 * Rules for every module:
 *   - No allocation in update(): preallocate vectors, matrices, colours; no closures or array helpers per frame.
 *   - Animation and visuals are derived from sim state and never feed back (ARCHITECTURE rule 3).
 *   - Read positions from frame.interp (interpolated), never from raw tick positions, so motion is smooth
 *     at any refresh rate. Discrete facts (phase, owner, actions) come from frame.curr.
 */

import type { WebGLRenderer, Scene, PerspectiveCamera } from 'three';
import type { FrameInfo } from '../contracts/app';
import type { Club } from '../contracts/data';
import type { QualityTier } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import type { CameraProjector } from '../contracts/input';
import type { AnimId, PoseFn } from '../contracts/render';
import type { CameraSettings, Settings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { NUM_SLOTS } from '../contracts/constants';

/** Viewport size. cssW/cssH in CSS px; dpr = window.devicePixelRatio; scale = 3D resolution scale (0.6..1). */
export interface RenderSize {
  cssW: number;
  cssH: number;
  dpr: number;
  /** Fraction of device pixels the 3D canvas renders at (T_PERF.resScaleInitial = 0.75 to start). */
  scale: number;
}

/** Shared context handed to every module factory. One instance per GameRenderer; fields are updated in place. */
export interface RenderContext {
  /**
   * The WebGL2 renderer (GFX-01). Always valid for modules index.ts creates after init(). Camera modules must
   * not use it: they are created before init() so the projector works headless and without WebGL.
   */
  renderer: WebGLRenderer;
  scene: Scene;
  /** The one camera drawn each frame. Camera modules (GFX-14/15) write its transform and projection. */
  camera: PerspectiveCamera;
  /** Latest settings snapshot (replaced by index.ts on init). */
  settings: Readonly<Settings>;
  /** Clubs of the current match source data (kits, crests). Empty until setMatch. */
  clubs: readonly Club[];
  size: RenderSize;
  /** Applied quality tier (never AUTO once resolved by GFX-02). */
  tier: QualityTier;
  /** Camera settings from the settings screen / pause menu (GameRenderer.setCamera). */
  cameraSettings: CameraSettings;
  /** Accessibility: reduced camera motion. */
  reducedMotion: boolean;
  /** Night match (floodlights) for the current match (config.night). */
  night: boolean;
}

/**
 * Interpolated render positions for the current animation frame, filled once per frame by index.ts:
 * value = prev + (curr - prev) * alpha. Preallocated; length NUM_SLOTS for player arrays.
 * Facing is interpolated and re-normalised (falls back to curr facing when the blend is degenerate).
 */
export interface InterpState {
  /** Player position x, z (m). */
  x: Float32Array;
  z: Float32Array;
  /** Player facing unit vector. */
  fx: Float32Array;
  fz: Float32Array;
  /** Player velocity (m/s). */
  vx: Float32Array;
  vz: Float32Array;
  /** Ball centre (m). */
  ballX: number;
  ballY: number;
  ballZ: number;
}

export function createInterpState(): InterpState {
  return {
    x: new Float32Array(NUM_SLOTS), z: new Float32Array(NUM_SLOTS),
    fx: new Float32Array(NUM_SLOTS), fz: new Float32Array(NUM_SLOTS),
    vx: new Float32Array(NUM_SLOTS), vz: new Float32Array(NUM_SLOTS),
    ballX: 0, ballY: 0.11, ballZ: 0,
  };
}

/** One animation frame as seen by modules. The object is reused every frame (never retain it). */
export interface RenderFrame {
  prev: ReadonlySimState;
  curr: ReadonlySimState;
  /** Blend factor between prev and curr, 0..1. */
  alpha: number;
  frame: FrameInfo;
  interp: InterpState;
}

/** A render module (one per file, created by index.ts in a fixed order). */
export interface RenderModule {
  /** Build match-specific resources (kits, lighting, crests). Called once per match before the first frame. */
  setMatch?(state: ReadonlySimState, clubs: readonly Club[]): void;
  /** Per animation frame while a match is shown. Must not allocate. */
  update(f: RenderFrame): void;
  /** Sim events of the latest tick (effects, crowd reactions, camera cuts). Must not allocate. */
  onEvents?(events: EventBuffer, state: ReadonlySimState): void;
  /** Loading screen: compile, upload and exercise everything once so the first use never hitches. */
  warmUp?(): void | Promise<void>;
  /** Apply a resolved quality tier (PERFORMANCE / BALANCED / QUALITY). */
  setQuality?(tier: QualityTier): void;
  /** ctx.size changed (CSS size, device pixel ratio or resolution scale). */
  resize?(): void;
  /** Leave the match: hide and release per-match resources (menus draw nothing). */
  clearMatch?(): void;
  dispose(): void;
}

/** A camera module (GFX-14 broadcast, GFX-15 cinematic). Writes ctx.camera when active. */
export interface CameraModule extends RenderModule, CameraProjector {
  /** True while this camera drives ctx.camera. */
  readonly active: boolean;
  /** Camera type / height / zoom sliders and reduced motion. */
  setSettings(c: CameraSettings, reducedMotion: boolean): void;
  /** Jump to the target pose with no smoothing (match start, restarts, cuts). */
  snap(): void;
}

/** Pose functions keyed by clip (GFX-09/10/11 each export one table; GFX-12 merges them). */
export type PoseTable = Partial<Record<AnimId, PoseFn>>;

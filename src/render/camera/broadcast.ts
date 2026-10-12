/**
 * [GFX-14] Main broadcast camera (section 8 "Main camera"). This view is what makes the game read as football.
 *
 * Baseline per T_CAMERA (contracts/tuning.ts):
 *  - Position: T_CAMERA.height (24 m) up, T_CAMERA.distance (40 m) behind the near touchline (z = 34 + 40), vertical
 *    FOV T_CAMERA.fovDeg (22 deg). Fixed vertical FOV: wider screens show more pitch, narrower ones lose width.
 *  - Follow: slides along the touchline at followFraction (70%) of the ball's x, clamped to +-followClamp (32 m),
 *    and turns to look at the ball, so it is square-on at midfield and angles toward goal near either box.
 *  - Framing: the look-at point leads the ball by leadMin..leadMax (3-6 m) in the direction of play; the ball is kept
 *    above ballBottomMargin (15%) of the screen height so it never sits under the touch controls. The margin is
 *    checked with the real camera transform (the ball is usually off-centre: lead + follow lag + yaw), and the
 *    look-at point is tilted toward the camera until the ball's projected height is inside it (enforceBottomMargin).
 *  - Motion: critically damped smoothing (smoothTime ~0.4 s) driven by INTERPOLATED render positions and real frame
 *    time; FOV widens by up to fovWidenMax for high or fast balls. No shake, no bob.
 *  - Settings: type (Broadcast / Wide / Close / End to End), Height and Zoom sliders 0..20 (10 = baseline);
 *    reduced camera motion slows the smoothing and disables FOV widening.
 * Implements CameraProjector for touch gestures and HUD anchoring (screen CSS px <-> pitch ground plane).
 *
 * WAVE 0 BASELINE (FND-05). GFX-14 owns and refines it (End to End camera, high-ball framing, edge cases).
 * No allocation per frame: all vectors are preallocated.
 */

import { Vector3 } from 'three';
import { HALF_WIDTH } from '../../contracts/constants';
import { CameraType } from '../../contracts/enums';
import type { CameraSettings } from '../../contracts/settings';
import { T_CAMERA } from '../../contracts/tuning';
import type { CameraModule, RenderContext, RenderFrame } from '../types';
import { projectPitchToScreen, projectScreenToPitch } from './project';

/** Fraction of the ball's z the look-at point follows (the rest keeps the pitch centre in view). */
export const LOOK_Z_FOLLOW = 0.75;
const NEAR = 2;
const FAR = 600;
const DEG = Math.PI / 180;
/** Bottom-margin solver: max iterations per frame (on-screen balls converge in <= 5) and the angular safety inside the margin (rad). */
const MARGIN_ITERS = 8;
const MARGIN_EPS = 2e-4;
/** Steepest camera pitch the margin solver may ask for (rad, just short of straight down). */
const MAX_PITCH = 89 * DEG;

/** Resolved camera rig for the current settings. */
export interface BroadcastRig {
  height: number;
  /** Camera z (m): near touchline + distance. */
  camZ: number;
  fovDeg: number;
  smoothTime: number;
  widenMax: number;
}

/** Camera rig from settings (sliders 0..20, 10 = the tuning baseline). Pure. */
export function broadcastRig(c: CameraSettings, reducedMotion: boolean, out: BroadcastRig): BroadcastRig {
  const h = Math.max(0, Math.min(20, c.height));
  const z = Math.max(0, Math.min(20, c.zoom));
  let fovScale = 1.3 - 0.03 * z;
  let distScale = 1;
  if (c.type === CameraType.WIDE) { fovScale *= 1.3; distScale = 1.1; }
  else if (c.type === CameraType.CLOSE) { fovScale *= 0.78; distScale = 0.9; }
  out.height = T_CAMERA.height * (0.7 + 0.03 * h);
  out.camZ = HALF_WIDTH + T_CAMERA.distance * distScale;
  out.fovDeg = T_CAMERA.fovDeg * fovScale;
  out.smoothTime = reducedMotion ? T_CAMERA.smoothTime * 1.6 : T_CAMERA.smoothTime;
  out.widenMax = reducedMotion ? 0 : T_CAMERA.fovWidenMax;
  return out;
}

/** Camera x along the touchline for a ball x. Pure. */
export function followX(ballX: number): number {
  const x = ballX * T_CAMERA.followFraction;
  return x > T_CAMERA.followClamp ? T_CAMERA.followClamp : x < -T_CAMERA.followClamp ? -T_CAMERA.followClamp : x;
}

/** Look-ahead lead (m) for a horizontal ball speed (m/s). Pure. */
export function leadFor(speed: number): number {
  const t = Math.max(0, Math.min(1, speed / 10));
  return T_CAMERA.leadMin + (T_CAMERA.leadMax - T_CAMERA.leadMin) * t;
}

/**
 * Critically damped smoothing step (Game Programming Gems 4, "SmoothDamp"). vel[i] holds the velocity state.
 * Returns the new value. Stable for any dt; no overshoot.
 */
export function smoothDamp(current: number, target: number, vel: Float64Array, i: number, smoothTime: number, dt: number): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel[i]! + omega * change) * dt;
  vel[i] = (vel[i]! - omega * temp) * e;
  return target + (change + temp) * e;
}

export interface BroadcastCameraModule extends CameraModule {
  readonly rig: Readonly<BroadcastRig>;
  /** Current smoothed look-at point (m). */
  readonly lookX: number;
  readonly lookZ: number;
  /** Aim at a ball position immediately (tests, match start). leadDir +1/-1. */
  snapTo(ballX: number, ballY: number, ballZ: number, leadDir: number): void;
}

// Smoothed channels (indices into the velocity array).
const CH_CAM_X = 0, CH_LOOK_X = 1, CH_LOOK_Z = 2, CH_FOV = 3, CH_LEAD = 4;

export function createBroadcastCamera(ctx: RenderContext): BroadcastCameraModule {
  const cam = ctx.camera;
  const rig = broadcastRig(ctx.cameraSettings, ctx.reducedMotion, { height: 0, camZ: 0, fovDeg: 0, smoothTime: 0, widenMax: 0 });
  const vel = new Float64Array(5);
  /** Scratch: ball in camera space (preallocated, no per-frame allocation). */
  const camSpace = new Vector3();
  let camX = 0, lookX = 0, lookZ = 0, fov = rig.fovDeg, lead: number = T_CAMERA.leadMin, leadDir = 1; // lead is signed (m along x)
  let active = true;

  cam.near = NEAR;
  cam.far = FAR;

  function applyAspect(): void {
    const a = ctx.size.cssW / Math.max(1, ctx.size.cssH);
    if (Math.abs(cam.aspect - a) > 1e-6) cam.aspect = a;
  }

  function applyView(): void {
    cam.position.set(camX, rig.height, rig.camZ);
    cam.lookAt(lookX, 0, lookZ);
    cam.updateMatrixWorld(true);
  }

  function applyPose(): void {
    applyAspect();
    if (Math.abs(cam.fov - fov) > 1e-4) cam.fov = fov;
    cam.updateProjectionMatrix();
    applyView();
  }

  /**
   * Keep the ball above the bottom margin with the REAL projection. The camera pose must be current. In camera space
   * a point's screen height depends only on its vertical angle phi = atan2(y, -z) (fixed vertical FOV), and pitching
   * the camera down by d raises every phi by exactly d, whatever the point's horizontal offset. So: measure the
   * ball's phi, pitch down by the shortfall (move the look-at point toward the camera, x unchanged), re-measure
   * (moving lookZ also yaws the camera slightly) until the ball is inside the margin. No allocation.
   */
  function enforceBottomMargin(bx: number, by: number, bz: number): void {
    const phiMin = Math.atan(-(1 - 2 * T_CAMERA.ballBottomMargin) * Math.tan((fov * DEG) / 2)) + MARGIN_EPS;
    for (let i = 0; i < MARGIN_ITERS; i++) {
      camSpace.set(bx, by, bz).applyMatrix4(cam.matrixWorldInverse);
      if (camSpace.z > -NEAR) return; // behind the camera: nothing sensible to frame
      const phi = Math.atan2(camSpace.y, -camSpace.z);
      if (phi >= phiMin - MARGIN_EPS) return;
      const dx = lookX - camX;
      const dz = rig.camZ - lookZ;
      const pitch = Math.atan2(rig.height, Math.sqrt(dx * dx + dz * dz));
      const want = Math.min(MAX_PITCH, pitch + (phiMin - phi));
      const dist = rig.height / Math.tan(want);
      lookZ = rig.camZ - (dist > Math.abs(dx) ? Math.sqrt(dist * dist - dx * dx) : 0);
      applyView();
    }
  }

  function snapTo(bx: number, by: number, bz: number, ld: number): void {
    leadDir = ld >= 0 ? 1 : -1;
    lead = T_CAMERA.leadMin * leadDir;
    camX = followX(bx);
    lookX = bx + lead;
    lookZ = bz * LOOK_Z_FOLLOW;
    fov = rig.fovDeg;
    vel.fill(0);
    applyPose();
    enforceBottomMargin(bx, by, bz);
  }

  snapTo(0, 0.11, 0, 1);

  const module: BroadcastCameraModule = {
    get active() { return active; },
    get rig() { return rig; },
    get lookX() { return lookX; },
    get lookZ() { return lookZ; },
    setMatch(state) {
      const b = state.ball;
      const owner = b.owner;
      const d = owner >= 0 ? state.teams[state.players[owner]!.team]!.dir : 1;
      snapTo(b.x, b.y, b.z, d);
    },
    update(f: RenderFrame) {
      if (!active) return;
      const it = f.interp;
      const s = f.curr;
      const dt = Math.max(0, Math.min(0.1, f.frame.dtMs / 1000));
      const b = s.ball;
      const speed = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
      // Direction of play: the possessing team's attack direction, else the ball's travel along x.
      if (b.owner >= 0) leadDir = s.teams[s.players[b.owner]!.team]!.dir >= 0 ? 1 : -1;
      else if (b.vx > 2) leadDir = 1;
      else if (b.vx < -2) leadDir = -1;
      lead = smoothDamp(lead, leadFor(speed) * leadDir, vel, CH_LEAD, rig.smoothTime * 2, dt);
      camX = smoothDamp(camX, followX(it.ballX), vel, CH_CAM_X, rig.smoothTime, dt);
      lookX = smoothDamp(lookX, it.ballX + lead, vel, CH_LOOK_X, rig.smoothTime, dt);
      lookZ = smoothDamp(lookZ, it.ballZ * LOOK_Z_FOLLOW, vel, CH_LOOK_Z, rig.smoothTime, dt);
      const high = Math.max(0, it.ballY - 3) / 12;
      const fast = Math.max(0, Math.sqrt(speed * speed + b.vy * b.vy) - 20) / 15;
      const widen = rig.widenMax * Math.min(1, high + fast);
      fov = smoothDamp(fov, rig.fovDeg + widen, vel, CH_FOV, rig.smoothTime * 1.5, dt);
      applyPose();
      enforceBottomMargin(it.ballX, it.ballY, it.ballZ);
    },
    resize() { applyPose(); },
    setSettings(c: CameraSettings, reducedMotion: boolean) {
      broadcastRig(c, reducedMotion, rig);
      fov = rig.fovDeg;
      applyPose();
    },
    snap() {
      vel.fill(0);
      fov = rig.fovDeg;
      applyPose();
    },
    snapTo,
    screenToPitch(sx: number, sy: number, out: { x: number; z: number }): boolean {
      return projectScreenToPitch(cam, ctx.size.cssW, ctx.size.cssH, sx, sy, out);
    },
    pitchToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
      return projectPitchToScreen(cam, ctx.size.cssW, ctx.size.cssH, x, y, z, out);
    },
    stickRotation() { return 0; },
    clearMatch() { vel.fill(0); },
    dispose() { active = false; },
  };
  return module;
}

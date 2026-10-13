/**
 * [GFX-14] Main broadcast camera (section 8 "Main camera"). This view is what makes the game read as football.
 *
 * Baseline per T_CAMERA (contracts/tuning.ts):
 *  - Position: T_CAMERA.height (24 m) up, T_CAMERA.distance (40 m) behind the near touchline (z = 34 + 40), vertical
 *    FOV T_CAMERA.fovDeg (22 deg). Fixed vertical FOV: wider screens show more pitch, narrower ones lose width.
 *  - Follow: slides along the touchline at followFraction (70%) of the ball's x, clamped to +-followClamp (32 m),
 *    and turns to look at the ball, so it is square-on at midfield and angles toward goal near either box.
 *  - Framing: the look-at point leads the ball by leadMin..leadMax (3-6 m) in the direction of play. Framing limits
 *    are solved every frame on the REAL camera transform: the ball stays above ballBottomMargin (15%) of the screen
 *    height, above the touch controls (button cluster and floating-stick rest zone, mirrored with the controls),
 *    below a top margin (scoreboard) and inside the side edges. Limits are soft-kneed (C1): the camera eases toward
 *    a limit and never jumps.
 *  - High balls: the camera tilts up ahead of time from the predicted apex so a lofted ball stays in view.
 *  - Motion: critically damped smoothing (smoothTime ~0.4 s) driven by INTERPOLATED render positions and real frame
 *    time; FOV widens by up to fovWidenMax for high or fast balls. No shake, no bob.
 *  - Restarts: a ball placed by the rules (teleport) glides the framing over LOCAL_TUNING.restartGlide (no snap);
 *    a long jump (kick-off after a goal, replay boundaries) is one clean cut, never a fly-over.
 *  - Settings: type (Broadcast / Wide / Close / End to End), Height and Zoom sliders 0..20 (10 = baseline);
 *    reduced camera motion slows the smoothing, disables FOV widening and cuts earlier instead of panning.
 *  - End to End: behind the human team's own goal, facing the goal it attacks (P1's side, else P2's; override with
 *    setViewTeam for online). stickRotation() = +pi/2 when that team attacks +x, -pi/2 when it attacks -x; the
 *    camera cuts when the team changes ends at half-time.
 * Implements CameraProjector for touch gestures and HUD anchoring (screen CSS px <-> pitch ground plane), with the
 * maths of ./project.ts written out on the matrix elements.
 * No allocation per frame (tests/perf/gfx-14-camera-alloc.test.ts): mutable numbers live in one Float64Array, update()
 * runs argument-free stages that pass everything through it, and hot clamps use Math.min / Math.max, so V8 never boxes
 * a double; the FOV goes into the projection matrix directly (see applyAspect).
 *
 * The camera never leaves cameraEnvelope(): GFX-05 keeps stand geometry out of that box (no dipping into the stand).
 */

import { Euler } from 'three';
import { HALF_LENGTH, HALF_WIDTH, WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../../contracts/constants';
import { CameraType, ControllerKind, MatchPhase } from '../../contracts/enums';
import type { CameraSettings, Settings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import { T_BALL, T_CAMERA, T_TOUCHUI } from '../../contracts/tuning';
import type { CameraModule, RenderContext, RenderFrame } from '../types';

export const LOCAL_TUNING = { // TUNING-CR (GFX-14 broadcast camera)
  // ---- settings sliders (0..20, 10 = the T_CAMERA baseline)
  /** Height slider: height multiplier = heightAt0 + heightPerStep * slider (0.7 .. 1.3). */
  heightAt0: 0.7,
  heightPerStep: 0.03,
  /** Zoom slider: vertical FOV multiplier = zoomAt0 - zoomPerStep * slider (1.3 .. 0.7). */
  zoomAt0: 1.3,
  zoomPerStep: 0.03,
  /** Wide / Close types: FOV and distance multipliers. */
  wideFov: 1.3,
  wideDist: 1.1,
  closeFov: 0.78,
  closeDist: 0.9,
  // ---- End to End camera (at slider 10)
  /** Height m, horizontal distance behind the ball m, vertical FOV deg. */
  e2eHeight: 17,
  e2eBack: 30,
  e2eFovDeg: 36,
  /** Fraction of the ball's z the camera (and its look point) follows. */
  e2eZFollow: 0.85,
  /** The camera never goes further than this beyond a goal line, m (stays over the boards, out of the end stand). */
  e2eOverrun: 5.5,
  /** Minimum horizontal distance from the camera to its look point, m. */
  e2eMinAhead: 6,
  // ---- motion
  /** Reduced camera motion: smoothing time multiplier. */
  reducedSmoothMul: 1.6,
  /** Lead / FOV / apex-tilt smoothing times as multiples of smoothTime. */
  leadSmoothMul: 2,
  fovSmoothMul: 1.5,
  tiltSmoothMul: 0.5,
  /** Horizontal ball speed (m/s) at which the lead reaches leadMax. */
  leadFullSpeed: 10,
  /** Loose ball: x speed (m/s) that sets the direction of play. */
  leadDirSpeed: 2,
  /** A new direction of play must hold this long (s) before the lead swaps sides (no sway on ping-pong). */
  leadDirDwell: 0.3,
  /** FOV widening: ball height (m) where it starts / is full; 3D ball speed (m/s) where it starts / is full. */
  widenHighStart: 3,
  widenHighFull: 15,
  widenFastStart: 20,
  widenFastFull: 35,
  // ---- restarts (ball teleports)
  /** Ball moved faster than this between frames (m/s, plus slack m): placed by the rules, not kicked. */
  teleportSpeed: 60,
  teleportSlack: 1.5,
  /** Teleports at least this long (m) cut to the new shot instead of gliding; reduced camera motion. */
  cutDistance: 25,
  cutDistanceReduced: 10,
  /** Restart placement glide, s (critically damped). */
  restartGlide: 0.3,
  // ---- framing (fractions of the screen)
  /** Ball kept at least this fraction of the screen height below the top edge (scoreboard). */
  ballTopMargin: 0.08,
  /** High balls: the predicted apex is kept this far below the top edge while the ball itself allows it. */
  apexTopMargin: 0.05,
  /** Ball kept at least this fraction of the screen width from either side edge. */
  ballSideMargin: 0.06,
  /** Soft-knee width of every framing limit, as a fraction of the FOV angle. */
  knee: 0.05,
  // ---- touch controls (CSS px)
  /** Clearance added around the button cluster (safe-area inset, ball size). */
  zonePad: 20,
  /** Floating-stick rest zone at the bottom of the stick side. */
  stickZoneW: 240,
  stickZoneH: 200,
  /** Horizontal ramp into a zone (px) so the camera eases in. */
  zoneRamp: 100,
  /** A zone never asks for more than this fraction of the screen height. */
  zoneMaxFrac: 0.4,
} as const;

const LT = LOCAL_TUNING;

/** Fraction of the ball's z the look-at point follows (the rest keeps the pitch centre in view). */
export const LOOK_Z_FOLLOW = 0.75;
const NEAR = 2;
const FAR = 600;
const DEG = Math.PI / 180;
/** Pitch limits (rad, positive looks down): never past straight down, never far above the horizon. */
const MAX_PITCH = 88 * DEG;
const MIN_PITCH = -30 * DEG;
/** Framing solver passes (vertical + horizontal; converges in 2). */
const SOLVE_ITERS = 3;
/** Ball closer than this along the view (m) cannot be framed: emergency cut. */
const MIN_AHEAD = 1;
/** Ball velocity components are clamped to this for prediction (m/s; guards garbage input). */
const BALL_V_MAX = 100;

/** Resolved camera rig for the current settings. */
export interface BroadcastRig {
  height: number;
  /** Camera z (m): near touchline + distance. End to End: 0 (the camera follows the ball's z). */
  camZ: number;
  fovDeg: number;
  smoothTime: number;
  widenMax: number;
  /** End to End: horizontal distance behind the ball (m). 0 for the side cameras. */
  back?: number;
  /** True for the End to End camera. */
  endToEnd?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, d: number): number {
  return Number.isFinite(v) ? v : d;
}

/** Camera rig from settings (sliders 0..20, 10 = the tuning baseline). Pure. */
export function broadcastRig(c: CameraSettings, reducedMotion: boolean, out: BroadcastRig): BroadcastRig {
  const h = clamp(finiteOr(c.height, 10), 0, 20);
  const z = clamp(finiteOr(c.zoom, 10), 0, 20);
  const hs = LT.heightAt0 + LT.heightPerStep * h;
  let fovScale = LT.zoomAt0 - LT.zoomPerStep * z;
  let distScale = 1;
  if (c.type === CameraType.WIDE) { fovScale *= LT.wideFov; distScale = LT.wideDist; }
  else if (c.type === CameraType.CLOSE) { fovScale *= LT.closeFov; distScale = LT.closeDist; }
  const e2e = c.type === CameraType.END_TO_END;
  if (e2e) {
    out.height = LT.e2eHeight * hs;
    out.camZ = 0;
    out.fovDeg = LT.e2eFovDeg * fovScale;
    out.back = LT.e2eBack * distScale;
  } else {
    out.height = T_CAMERA.height * hs;
    out.camZ = HALF_WIDTH + T_CAMERA.distance * distScale;
    out.fovDeg = T_CAMERA.fovDeg * fovScale;
    out.back = 0;
  }
  out.endToEnd = e2e;
  out.smoothTime = reducedMotion ? T_CAMERA.smoothTime * LT.reducedSmoothMul : T_CAMERA.smoothTime;
  out.widenMax = reducedMotion ? 0 : T_CAMERA.fovWidenMax;
  return out;
}

/** Box the camera position never leaves, over every setting and ball position (m). */
export interface CameraEnvelope {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/**
 * Where the camera can be for a camera type (all Height / Zoom slider values, any ball position). Pure.
 * GFX-05 keeps stand and roof geometry out of these boxes (glitch: "dipping into the stand").
 */
export function cameraEnvelope(type: CameraType, out: CameraEnvelope): CameraEnvelope {
  const lo = LT.heightAt0, hi = LT.heightAt0 + LT.heightPerStep * 20;
  if (type === CameraType.END_TO_END) {
    const x = HALF_LENGTH + LT.e2eOverrun;
    out.minX = -x; out.maxX = x;
    out.minY = LT.e2eHeight * lo; out.maxY = LT.e2eHeight * hi;
    // The camera z follows e2eZFollow of the ball's z (ball inside the world bounds).
    out.minZ = WORLD_MIN_Z * LT.e2eZFollow; out.maxZ = WORLD_MAX_Z * LT.e2eZFollow;
    return out;
  }
  const d = type === CameraType.WIDE ? LT.wideDist : type === CameraType.CLOSE ? LT.closeDist : 1;
  out.minX = -T_CAMERA.followClamp; out.maxX = T_CAMERA.followClamp;
  out.minY = T_CAMERA.height * lo; out.maxY = T_CAMERA.height * hi;
  out.minZ = out.maxZ = HALF_WIDTH + T_CAMERA.distance * d;
  return out;
}

/** Camera x along the touchline for a ball x. Pure. */
export function followX(ballX: number): number {
  const x = ballX * T_CAMERA.followFraction;
  return x > T_CAMERA.followClamp ? T_CAMERA.followClamp : x < -T_CAMERA.followClamp ? -T_CAMERA.followClamp : x;
}

/** Look-ahead lead (m) for a horizontal ball speed (m/s). Pure. */
export function leadFor(speed: number): number {
  const t = clamp(finiteOr(speed, 0) / LT.leadFullSpeed, 0, 1);
  return T_CAMERA.leadMin + (T_CAMERA.leadMax - T_CAMERA.leadMin) * t;
}

/** End to End camera x for a ball x when the view faces `facing` (+1 = toward +x). Clamped over the boards. Pure. */
export function endToEndCamX(ballX: number, facing: number, back: number): number {
  const lim = HALF_LENGTH + LT.e2eOverrun;
  return clamp(ballX - (facing >= 0 ? 1 : -1) * back, -lim, lim);
}

/**
 * Predicted apex height of a ball in flight (m) with quadratic drag on the vertical component:
 * h = y + ln(1 + k vy^2 / g) / (2k). The current height when the ball is not rising. Pure.
 */
export function predictApexY(y: number, vy: number): number {
  if (!(vy > 0)) return y;
  const k = T_BALL.dragK, g = T_BALL.gravity;
  return Math.min(WORLD_MAX_Y, y + Math.log(1 + (k * vy * vy) / g) / (2 * k));
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

/**
 * Soft band: v unchanged inside [lo + k, hi - k]; toward a limit it eases exponentially and never reaches it
 * (C1 continuous, strictly inside (lo, hi)). Requires hi - lo > 2k > 0. Pure.
 */
export function softBand(v: number, lo: number, hi: number, k: number): number {
  if (v < lo + k) return lo + k * Math.exp((v - lo) / k - 1);
  if (v > hi - k) return hi - k * Math.exp((hi - v) / k - 1);
  return v;
}

function smoothstep01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Screen regions the ball must stay above (CSS px, measured from the bottom-left / bottom-right corners). */
export interface TouchZones {
  /** Button cluster box at the bottom right (bottom left when mirrored). */
  clusterW: number;
  clusterH: number;
  /** Floating-stick rest box at the bottom left (bottom right when mirrored). */
  stickW: number;
  stickH: number;
  mirror: boolean;
}

/**
 * Touch-control zones from the touch settings: the cluster geometry of T_TOUCHUI (big button bottom right, three
 * small buttons on an arc above / left of it, systemEdgeMargin from the edges; same maths as
 * input/touch/attack.ts computeClusterLayout) grown by any per-button placement from the controls editor, plus
 * LOCAL_TUNING.zonePad; and the stick rest zone. Pure; not per frame (iterates the layout record).
 */
export function touchZones(s: Readonly<Settings> | null | undefined, out: TouchZones): TouchZones {
  const t = s?.controls?.touch;
  const spacing = Math.max(1, finiteOr(t?.spacing ?? 1, 1));
  let scale = 1;
  let extX = 0, extY = 0;
  const layout = t?.layout;
  if (layout) {
    for (const key in layout) {
      const id = Number(key);
      if (!(id >= 0 && id <= 7)) continue; // cluster buttons only (PAUSE sits at the top)
      const p = layout[key];
      if (!p) continue;
      const sc = clamp(finiteOr(p.scale, 1), 0.7, 1.4);
      scale = Math.max(scale, sc);
      extX = Math.max(extX, finiteOr(p.dx, 0) + T_TOUCHUI.bigButton * sc);
      extY = Math.max(extY, finiteOr(p.dy, 0) + T_TOUCHUI.bigButton * sc);
    }
  }
  const bigR = (T_TOUCHUI.bigButton / 2) * scale;
  const smallR = (T_TOUCHUI.smallButton / 2) * scale;
  const gap = T_TOUCHUI.buttonGap * spacing;
  const arcR = Math.max(bigR + smallR + gap, (2 * smallR + gap) / (2 * Math.sin(Math.PI / 8)));
  const ext = T_TOUCHUI.systemEdgeMargin + bigR + arcR + smallR;
  out.clusterW = Math.max(ext, extX) + LT.zonePad;
  out.clusterH = Math.max(ext, extY) + LT.zonePad;
  out.stickW = LT.stickZoneW;
  out.stickH = LT.stickZoneH;
  out.mirror = t?.mirror === true;
  return out;
}

/**
 * Bottom margin (fraction of the screen height) the ball needs at screen column sx (CSS px) to stay clear of the
 * touch-control zones; 0 away from them. Smooth in sx (LOCAL_TUNING.zoneRamp). Pure.
 */
export function touchZoneMargin(sx: number, w: number, h: number, z: Readonly<TouchZones>): number {
  const hh = Math.max(1, h);
  const clusterFrac = Math.min(LT.zoneMaxFrac, z.clusterH / hh);
  const stickFrac = Math.min(LT.zoneMaxFrac, z.stickH / hh);
  const intoCluster = z.mirror ? z.clusterW - sx : sx - (w - z.clusterW);
  const intoStick = z.mirror ? sx - (w - z.stickW) : z.stickW - sx;
  const a = clusterFrac * smoothstep01((intoCluster + LT.zoneRamp) / LT.zoneRamp);
  const b = stickFrac * smoothstep01((intoStick + LT.zoneRamp) / LT.zoneRamp);
  return a > b ? a : b;
}

/** True for phases where the restart team sets the direction of play. */
function isRestartPhase(p: MatchPhase): boolean {
  return p === MatchPhase.KICK_OFF || p === MatchPhase.THROW_IN || p === MatchPhase.GOAL_KICK || p === MatchPhase.CORNER
    || p === MatchPhase.FREE_KICK || p === MatchPhase.PENALTY;
}

export interface BroadcastCameraModule extends CameraModule {
  readonly rig: Readonly<BroadcastRig>;
  /** Current smoothed look-at point (m), before the framing limits. */
  readonly lookX: number;
  readonly lookZ: number;
  /** Final camera yaw (rad about +y; 0 looks toward -z, i.e. across the pitch from the near side). */
  readonly yaw: number;
  /** Final camera pitch (rad; positive looks down). */
  readonly pitch: number;
  /** Current apex tilt (rad the camera is raised for a high ball). */
  readonly tilt: number;
  /** Signed lead (m along x) currently applied to the look point. */
  readonly lead: number;
  /** Cuts (jumps without smoothing) since creation: match start, long restarts, settings, half-time ends. */
  readonly cuts: number;
  /** Aim at a ball position immediately (tests, match start, cuts). leadDir +1/-1. */
  snapTo(ballX: number, ballY: number, ballZ: number, leadDir: number): void;
  /** End to End view team (online: the local human's side); -1 = automatic (P1's side, else P2's, else home). */
  setViewTeam(team: number): void;
}

// Mutable per-frame state lives in one Float64Array: in V8 a closure `let` holding a double boxes a new HeapNumber
// on every write, which would allocate every frame. Smoothed channels share their index with the velocity array.
const S_CAM_X = 0, S_LOOK_X = 1, S_LOOK_Z = 2, S_FOV = 3, S_LEAD = 4, S_TILT = 5, S_OFF_X = 6, S_OFF_Y = 7, S_OFF_Z = 8;
const CHANNELS = 9;
/** Last raw (interpolated) ball, framing ball (ball + restart glide offset), predicted apex. */
const S_LAST_X = 9, S_LAST_Y = 10, S_LAST_Z = 11, S_FB_X = 12, S_FB_Y = 13, S_FB_Z = 14, S_APEX_X = 15, S_APEX_Y = 16, S_APEX_Z = 17;
/** Base pose from the smoothed channels (camera position, yaw, pitch), final pose, solver input, dwell timer. */
const S_CX = 18, S_CY = 19, S_CZ = 20, S_PSI0 = 21, S_THETA0 = 22, S_YAW = 23, S_PITCH = 24, S_THETA_PRE = 25, S_PENDING = 26;
/** This frame's inputs: dt (s), interpolated ball, ball velocity (curr state). */
const S_DT = 27, S_BX = 28, S_BY = 29, S_BZ = 30, S_BVX = 31, S_BVY = 32, S_BVZ = 33;
/** Per smoothed channel c: its target at S_TGT + c and its smoothing time (s) at S_STM + c. */
const S_TGT = 34, S_STM = S_TGT + CHANNELS;
/** Rig numbers read every frame (copied from BroadcastRig on settings changes). */
const S_R_HEIGHT = S_STM + CHANNELS, S_R_CAMZ = S_R_HEIGHT + 1, S_R_FOV = S_R_HEIGHT + 2, S_R_BACK = S_R_HEIGHT + 3, S_R_WIDEN = S_R_HEIGHT + 4;
const STATE_SIZE = S_R_WIDEN + 1;

export function createBroadcastCamera(ctx: RenderContext): BroadcastCameraModule {
  const cam = ctx.camera;
  const rig = broadcastRig(ctx.cameraSettings, ctx.reducedMotion, { height: 0, camZ: 0, fovDeg: 0, smoothTime: 0, widenMax: 0 });
  const S = new Float64Array(STATE_SIZE);
  const vel = new Float64Array(CHANNELS);
  const euler = new Euler(0, 0, 0, 'YXZ');
  const zones: TouchZones = { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false };
  let zonesFor: Readonly<Settings> | null = null;
  // Small integers only below (Smis never allocate).
  let leadDir = 1;
  let hasLast = false;
  let viewOverride = -1, facing = 1;
  let cuts = 0;
  let active = true;
  /** Next applyAspect() runs three's full updateProjectionMatrix(). */
  let projFull = true;
  /** 1 for the End to End camera (mirrors rig.endToEnd as a small integer for the per-frame code). */
  let e2e = 0;
  /** 1 with reduced camera motion (accessibility). */
  let reduced = ctx.reducedMotion ? 1 : 0;

  cam.near = NEAR;
  cam.far = FAR;

  function ensureZones(): void {
    if (zonesFor === ctx.settings) return;
    zonesFor = ctx.settings;
    touchZones(ctx.settings, zones);
  }

  function viewTeam(s: ReadonlySimState): number {
    if (viewOverride === 0 || viewOverride === 1) return viewOverride;
    for (let i = 0; i < 2; i++) {
      const c = s.ctrl[i];
      if (c && c.kind === ControllerKind.HUMAN && (c.side === 0 || c.side === 1)) return c.side;
    }
    return 0;
  }

  function facingOf(s: ReadonlySimState): number {
    const t = s.teams[viewTeam(s)];
    return t && t.dir < 0 ? -1 : 1;
  }

  /** Direction of play: possessing team, else the restart team, else the loose ball's travel along x. */
  function playDir(s: ReadonlySimState, current: number): number {
    const b = s.ball;
    if (b.owner >= 0) {
      const p = s.players[b.owner];
      const t = p ? s.teams[p.team] : undefined;
      if (t) return t.dir < 0 ? -1 : 1;
    }
    if (isRestartPhase(s.match.phase)) {
      const t = s.teams[s.match.restart.team];
      if (t) return t.dir < 0 ? -1 : 1;
    }
    if (b.vx > LT.leadDirSpeed) return 1;
    if (b.vx < -LT.leadDirSpeed) return -1;
    return current;
  }

  /** Follow targets for the framing ball (S_FB_*): camera x, look x (with the current lead), look z. */
  function followTargets(smooth: boolean): void {
    const fbx = S[S_FB_X]!, fbz = S[S_FB_Z]!;
    if (e2e === 1) {
      // endToEndCamX(), inline.
      const lim = HALF_LENGTH + LT.e2eOverrun;
      S[S_TGT + S_CAM_X] = Math.max(-lim, Math.min(lim, fbx - facing * S[S_R_BACK]!));
    } else {
      // followX(), inline.
      const c = T_CAMERA.followClamp;
      S[S_TGT + S_CAM_X] = Math.max(-c, Math.min(c, fbx * T_CAMERA.followFraction));
    }
    S[S_TGT + S_LOOK_X] = fbx + S[S_LEAD]!;
    S[S_TGT + S_LOOK_Z] = fbz * (e2e === 1 ? LT.e2eZFollow : LOOK_Z_FOLLOW);
    if (!smooth) {
      S[S_CAM_X] = S[S_TGT + S_CAM_X]!;
      S[S_LOOK_X] = S[S_TGT + S_LOOK_X]!;
      S[S_LOOK_Z] = S[S_TGT + S_LOOK_Z]!;
      return;
    }
    damp(S_CAM_X);
    damp(S_LOOK_X);
    damp(S_LOOK_Z);
  }

  /** Rig numbers, reduced motion and smoothing times into the per-frame state (settings change, creation). */
  function syncRig(): void {
    e2e = rig.endToEnd ? 1 : 0;
    S[S_R_HEIGHT] = rig.height;
    S[S_R_CAMZ] = rig.camZ;
    S[S_R_FOV] = rig.fovDeg;
    S[S_R_BACK] = rig.back ?? 0;
    S[S_R_WIDEN] = rig.widenMax;
    const st = rig.smoothTime;
    S[S_STM + S_CAM_X] = st;
    S[S_STM + S_LOOK_X] = st;
    S[S_STM + S_LOOK_Z] = st;
    S[S_STM + S_FOV] = st * LT.fovSmoothMul;
    S[S_STM + S_LEAD] = st * LT.leadSmoothMul;
    S[S_STM + S_TILT] = st * LT.tiltSmoothMul;
    const glide = LT.restartGlide * (reduced === 1 ? LT.reducedSmoothMul : 1);
    S[S_STM + S_OFF_X] = S[S_STM + S_OFF_Y] = S[S_STM + S_OFF_Z] = glide;
  }

  /**
   * Channel c one critically damped step toward S[S_TGT + c] over S[S_DT] (smoothDamp on the state array). Index
   * arguments only, so it never boxes a number whether or not V8 inlines it.
   */
  function damp(c: number): void {
    const st = Math.max(0.0001, S[S_STM + c]!);
    const dt = S[S_DT]!;
    const target = S[S_TGT + c]!;
    const omega = 2 / st;
    const x = omega * dt;
    const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = S[c]! - target;
    const temp = (vel[c]! + omega * change) * dt;
    vel[c] = (vel[c]! - omega * temp) * e;
    S[c] = target + (change + temp) * e;
  }

  /**
   * Aspect and FOV into ctx.camera. For the symmetric frustum this camera uses (zoom 1, no view or film offset) only
   * elements 0 and 5 of the projection depend on them, so they are written directly (three's
   * updateProjectionMatrix boxes its makePerspective arguments: per-frame garbage while the FOV widens); anything
   * else (first use, near / far / zoom / view changed by another camera) takes updateProjectionMatrix().
   */
  function applyAspect(): void {
    const a = Math.max(1, ctx.size.cssW) / Math.max(1, ctx.size.cssH);
    const fov = S[S_FOV]!;
    if (cam.near !== NEAR || cam.far !== FAR || projFull) {
      cam.near = NEAR; cam.far = FAR; cam.aspect = a; cam.fov = fov;
      cam.updateProjectionMatrix();
      projFull = false;
      return;
    }
    if (!(Math.abs(cam.aspect - a) > 1e-9) && !(Math.abs(cam.fov - fov) > 1e-9)) return;
    cam.aspect = a;
    cam.fov = fov;
    if (cam.zoom === 1 && cam.filmOffset === 0 && (cam.view === null || !cam.view.enabled)) {
      const t = Math.tan(fov * DEG * 0.5);
      const te = cam.projectionMatrix.elements;
      te[0] = 1 / (a * t);
      te[5] = 1 / t;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } else cam.updateProjectionMatrix();
  }

  /** Base pose from the smoothed channels: camera position, yaw psi0 toward the look point, pitch theta0. */
  function basePose(): void {
    const cx = S[S_CAM_X]!, cy = S[S_R_HEIGHT]!, lookX = S[S_LOOK_X]!, lookZ = S[S_LOOK_Z]!;
    S[S_CX] = cx;
    S[S_CY] = cy;
    if (e2e === 1) {
      S[S_CZ] = lookZ;
      S[S_PSI0] = facing > 0 ? -Math.PI / 2 : Math.PI / 2;
      const ahead = Math.max(LT.e2eMinAhead, (lookX - cx) * facing);
      S[S_THETA0] = Math.atan2(cy, ahead);
    } else {
      const cz = S[S_R_CAMZ]!;
      S[S_CZ] = cz;
      const dx = lookX - cx, dz = lookZ - cz;
      S[S_PSI0] = Math.atan2(-dx, -dz);
      S[S_THETA0] = Math.atan2(cy, Math.max(1e-3, Math.sqrt(dx * dx + dz * dz)));
    }
  }

  /**
   * Apex tilt target (rad >= 0): raise the view so the predicted apex sits under the top while the ball itself
   * allows it. Written into S_THETA_PRE as a scratch slot (the caller smooths it, then sets the real solver input).
   */
  function tiltTarget(): void {
    const apexY = S[S_APEX_Y]!, fby = S[S_FB_Y]!;
    S[S_THETA_PRE] = 0;
    if (!(apexY > LT.widenHighStart) && !(fby > LT.widenHighStart)) return;
    const fov = S[S_FOV]!;
    const cx = S[S_CX]!, cy = S[S_CY]!, cz = S[S_CZ]!, psi0 = S[S_PSI0]!, theta0 = S[S_THETA0]!;
    const tV = Math.tan((fov * DEG) / 2);
    const k = LT.knee * fov * DEG;
    const s = Math.sin(psi0), c = Math.cos(psi0);
    const ax = S[S_APEX_X]! - cx, az = S[S_APEX_Z]! - cz;
    const fdA = -s * ax - c * az;
    const bx = S[S_FB_X]! - cx, bz = S[S_FB_Z]! - cz;
    const fdB = -s * bx - c * bz;
    if (!(fdA > MIN_AHEAD) || !(fdB > MIN_AHEAD)) return;
    const phiA = Math.atan2(apexY - cy, fdA);
    const phiB = Math.atan2(fby - cy, fdB);
    const phiTopApex = Math.atan((1 - 2 * LT.apexTopMargin) * tV);
    const phiTopBall = Math.atan((1 - 2 * LT.ballTopMargin) * tV) - k;
    const phiBot = Math.atan((-1 + 2 * T_CAMERA.ballBottomMargin) * tV) + k;
    let want = Math.min(theta0, phiTopApex - phiA, phiTopBall - phiB);
    want = Math.max(want, phiBot - phiB); // never push the ball itself out of the bottom
    S[S_THETA_PRE] = Math.max(0, theta0 - want);
  }

  /**
   * Solve the framing limits on the real transform; input S_THETA_PRE (unconstrained pitch), output S_YAW / S_PITCH.
   * In camera space a point's screen height depends only on its elevation phi = atan2(y, depth), and pitching down by
   * d raises every phi by exactly d (any horizontal offset), so the vertical limits are closed-form in pitch; the
   * horizontal limit is met with Newton steps on yaw. The bottom limit follows the ball's screen column (touch
   * zones), so the two are iterated.
   */
  function solve(): void {
    ensureZones();
    const W = Math.max(1, ctx.size.cssW), H = Math.max(1, ctx.size.cssH);
    const fov = S[S_FOV]!;
    const thetaPre = S[S_THETA_PRE]!, psi0 = S[S_PSI0]!;
    const hfV = (fov * DEG) / 2;
    const tV = Math.tan(hfV);
    const tH = tV * (W / H);
    const kV = LT.knee * 2 * hfV;
    const kH = LT.knee * 2 * Math.atan(tH);
    const phiTop = Math.atan((1 - 2 * LT.ballTopMargin) * tV);
    const gamLim = Math.atan((1 - 2 * LT.ballSideMargin) * tH);
    const dx = S[S_FB_X]! - S[S_CX]!, dy = S[S_FB_Y]! - S[S_CY]!, dz = S[S_FB_Z]! - S[S_CZ]!;
    let psi = psi0, theta = thetaPre;
    for (let it = 0; it < SOLVE_ITERS; it++) {
      // Vertical: pitch from the unconstrained pitch, at the current yaw and screen column.
      const s = Math.sin(psi), c = Math.cos(psi);
      const fd = -s * dx - c * dz;
      if (!(fd > MIN_AHEAD)) break;
      const xc = c * dx - s * dz;
      const depth = fd * Math.cos(theta) - dy * Math.sin(theta);
      const ndcX = depth > MIN_AHEAD ? xc / (depth * tH) : 0;
      const sx = (ndcX + 1) * 0.5 * W;
      const mB = Math.max(T_CAMERA.ballBottomMargin, touchZoneMargin(sx, W, H, zones));
      const phiBot = Math.atan((-1 + 2 * mB) * tV);
      const phi = Math.atan2(dy, fd) + thetaPre;
      theta = thetaPre + softBand(phi, phiBot, phiTop, kV) - phi;
      // Horizontal: from the unconstrained yaw, Newton steps toward the soft-limited angle.
      psi = psi0;
      const s0 = Math.sin(psi0), c0 = Math.cos(psi0);
      const f0 = -s0 * dx - c0 * dz;
      const d0 = f0 * Math.cos(theta) - dy * Math.sin(theta);
      if (!(d0 > MIN_AHEAD)) continue;
      const g0 = Math.atan2(c0 * dx - s0 * dz, d0);
      const gT = softBand(g0, -gamLim, gamLim, kH);
      if (gT === g0) continue;
      for (let n = 0; n < 3; n++) {
        const ss = Math.sin(psi), cc = Math.cos(psi);
        const f2 = -ss * dx - cc * dz;
        const x2 = cc * dx - ss * dz;
        const d2 = f2 * Math.cos(theta) - dy * Math.sin(theta);
        if (!(d2 > MIN_AHEAD)) break;
        const g = Math.atan2(x2, d2);
        const deriv = (d2 * f2 + x2 * x2 * Math.cos(theta)) / (x2 * x2 + d2 * d2);
        psi += (gT - g) / Math.max(0.1, deriv);
      }
    }
    S[S_YAW] = psi;
    S[S_PITCH] = Math.max(MIN_PITCH, Math.min(MAX_PITCH, theta));
  }

  /** Write the pose into ctx.camera. */
  function writeCamera(): void {
    cam.position.set(S[S_CX]!, S[S_CY]!, S[S_CZ]!);
    euler.set(-S[S_PITCH]!, S[S_YAW]!, 0, 'YXZ');
    cam.quaternion.setFromEuler(euler);
    cam.updateMatrixWorld(true);
  }

  /** True when the framing ball projects inside the screen in front of the camera. */
  function ballVisible(): boolean {
    const yaw = S[S_YAW]!, pitch = S[S_PITCH]!;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const dx = S[S_FB_X]! - S[S_CX]!, dy = S[S_FB_Y]! - S[S_CY]!, dz = S[S_FB_Z]! - S[S_CZ]!;
    const fd = -s * dx - c * dz;
    const depth = fd * Math.cos(pitch) - dy * Math.sin(pitch);
    if (!(depth > NEAR)) return false;
    const up = fd * Math.sin(pitch) + dy * Math.cos(pitch);
    const xc = c * dx - s * dz;
    const tV = Math.tan((S[S_FOV]! * DEG) / 2);
    const tH = tV * (Math.max(1, ctx.size.cssW) / Math.max(1, ctx.size.cssH));
    return Math.abs(up / (depth * tV)) <= 1 && Math.abs(xc / (depth * tH)) <= 1;
  }

  /** Pose from the current channels (no smoothing step): resize, settings. */
  function applyPose(): void {
    applyAspect();
    basePose();
    S[S_THETA_PRE] = S[S_THETA0]! - S[S_TILT]!;
    solve();
    writeCamera();
  }

  function snapTo(bx: number, by: number, bz: number, ld: number): void {
    bx = clamp(finiteOr(bx, 0), WORLD_MIN_X, WORLD_MAX_X);
    by = clamp(finiteOr(by, 0.11), 0, WORLD_MAX_Y);
    bz = clamp(finiteOr(bz, 0), WORLD_MIN_Z, WORLD_MAX_Z);
    leadDir = ld >= 0 ? 1 : -1;
    S[S_PENDING] = 0;
    S[S_LEAD] = T_CAMERA.leadMin * leadDir;
    S[S_OFF_X] = S[S_OFF_Y] = S[S_OFF_Z] = 0;
    S[S_LAST_X] = S[S_FB_X] = S[S_APEX_X] = bx;
    S[S_LAST_Y] = S[S_FB_Y] = S[S_APEX_Y] = by;
    S[S_LAST_Z] = S[S_FB_Z] = S[S_APEX_Z] = bz;
    hasLast = true;
    followTargets(false);
    S[S_FOV] = S[S_R_FOV]!;
    vel.fill(0);
    applyAspect();
    basePose();
    tiltTarget();
    S[S_TILT] = S[S_THETA_PRE]!;
    S[S_THETA_PRE] = S[S_THETA0]! - S[S_TILT]!;
    solve();
    writeCamera();
    cuts++;
  }

  /** Cut to the current ball keeping the current lead (settings change, snap()). */
  function cutKeepLead(): void {
    const l = S[S_LEAD]!;
    snapTo(S[S_LAST_X]!, S[S_LAST_Y]!, S[S_LAST_Z]!, leadDir);
    S[S_LEAD] = l;
    S[S_LOOK_X] = S[S_FB_X]! + l;
    applyPose();
  }

  syncRig();
  snapTo(0, 0.11, 0, 1);
  cuts = 0;

  // ---- projector (CameraProjector). Same maths as ./project.ts (projectScreenToPitch / projectPitchToScreen) on
  // ctx.camera's current matrices, written out on the matrix elements so a call never boxes a number.

  /** Screen CSS px -> ground-plane (y = 0) point. False when the ray does not hit the ground in front of the camera. */
  function screenToPitch(sx: number, sy: number, out: { x: number; z: number }): boolean {
    const w = Math.max(1, ctx.size.cssW), h = Math.max(1, ctx.size.cssH);
    const nx = (sx / w) * 2 - 1, ny = -((sy / h) * 2 - 1);
    const mw = cam.matrixWorld.elements, pi = cam.projectionMatrixInverse.elements;
    // NDC (nx, ny, 0.5) -> view space (projectionMatrixInverse, perspective divide) -> world (matrixWorld).
    let iw = 1 / (pi[3]! * nx + pi[7]! * ny + pi[11]! * 0.5 + pi[15]!);
    const vx = (pi[0]! * nx + pi[4]! * ny + pi[8]! * 0.5 + pi[12]!) * iw;
    const vy = (pi[1]! * nx + pi[5]! * ny + pi[9]! * 0.5 + pi[13]!) * iw;
    const vz = (pi[2]! * nx + pi[6]! * ny + pi[10]! * 0.5 + pi[14]!) * iw;
    iw = 1 / (mw[3]! * vx + mw[7]! * vy + mw[11]! * vz + mw[15]!);
    const ox = mw[12]!, oy = mw[13]!, oz = mw[14]!;
    const dx = (mw[0]! * vx + mw[4]! * vy + mw[8]! * vz + mw[12]!) * iw - ox;
    const dy = (mw[1]! * vx + mw[5]! * vy + mw[9]! * vz + mw[13]!) * iw - oy;
    const dz = (mw[2]! * vx + mw[6]! * vy + mw[10]! * vz + mw[14]!) * iw - oz;
    if (!(dy < -1e-6)) return false;
    const t = -oy / dy;
    out.x = ox + dx * t;
    out.z = oz + dz * t;
    return true;
  }

  /** World point -> screen CSS px. False when the point is behind (or closer than the near plane to) the camera. */
  function pitchToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const m = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    let iw = 1 / (m[3]! * x + m[7]! * y + m[11]! * z + m[15]!);
    const vx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw;
    const vy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw;
    const vz = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw;
    if (!(vz <= -cam.near)) return false;
    iw = 1 / (p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]!);
    const nx = (p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]!) * iw;
    const ny = (p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]!) * iw;
    out.x = (nx + 1) * 0.5 * ctx.size.cssW;
    out.y = (1 - ny) * 0.5 * ctx.size.cssH;
    return true;
  }

  // ---- per-frame stages. update() calls them with no arguments and no return values in doubles: everything
  // passes through S, so V8 never boxes a number at a call boundary (zero allocation per frame).

  /** Frame inputs into S. */
  function readInputs(f: RenderFrame): void {
    const it = f.interp;
    const b = f.curr.ball;
    // Finite checks (v - v === 0 is false for NaN and +-Infinity) and clamps written out, one const per value, clamps
    // with Math.min / Math.max: helper calls, or ternaries mixing small-integer constants with doubles, make V8 box
    // the doubles (per-frame garbage).
    const dt = f.frame.dtMs / 1000;
    S[S_DT] = dt - dt === 0 ? Math.max(0, Math.min(0.1, dt)) : 0;
    const x = it.ballX, y = it.ballY, z = it.ballZ;
    S[S_BX] = Math.max(WORLD_MIN_X, Math.min(WORLD_MAX_X, x - x === 0 ? x : S[S_LAST_X]!));
    S[S_BY] = Math.max(0, Math.min(WORLD_MAX_Y, y - y === 0 ? y : S[S_LAST_Y]!));
    S[S_BZ] = Math.max(WORLD_MIN_Z, Math.min(WORLD_MAX_Z, z - z === 0 ? z : S[S_LAST_Z]!));
    const vx = b.vx, vy = b.vy, vz = b.vz;
    S[S_BVX] = vx - vx === 0 ? Math.max(-BALL_V_MAX, Math.min(BALL_V_MAX, vx)) : 0;
    S[S_BVY] = vy - vy === 0 ? Math.max(-BALL_V_MAX, Math.min(BALL_V_MAX, vy)) : 0;
    S[S_BVZ] = vz - vz === 0 ? Math.max(-BALL_V_MAX, Math.min(BALL_V_MAX, vz)) : 0;
  }

  /** Cut to this frame's ball (no smoothing). */
  function cutToBall(): void {
    snapTo(S[S_BX]!, S[S_BY]!, S[S_BZ]!, leadDir);
  }

  /** Direction of play with dwell (no sway when possession ping-pongs). */
  function stepDirection(s: ReadonlySimState): void {
    const cand = playDir(s, leadDir);
    if (cand !== leadDir) {
      S[S_PENDING] = S[S_PENDING]! + S[S_DT]!;
      if (S[S_PENDING]! >= LT.leadDirDwell) { leadDir = cand; S[S_PENDING] = 0; }
    } else S[S_PENDING] = 0;
  }

  /**
   * Restart placement: the rules moved the ball faster than any kick. A long jump cuts (returns true); a short one
   * keeps the framing ball where it was and lets it glide after the ball.
   */
  function stepTeleport(ticksIn: number): boolean {
    const bx = S[S_BX]!, by = S[S_BY]!, bz = S[S_BZ]!;
    if (hasLast) {
      const jx = bx - S[S_LAST_X]!, jy = by - S[S_LAST_Y]!, jz = bz - S[S_LAST_Z]!;
      const jump = Math.sqrt(jx * jx + jy * jy + jz * jz);
      const ticks = ticksIn >= 0 ? ticksIn : 0;
      const allowed = LT.teleportSpeed * Math.max(S[S_DT]!, (ticks + 1) / 60) + LT.teleportSlack;
      if (jump > allowed) {
        if (jump >= (reduced === 1 ? LT.cutDistanceReduced : LT.cutDistance)) {
          cutToBall();
          return true;
        }
        S[S_OFF_X] = S[S_OFF_X]! - jx;
        S[S_OFF_Y] = S[S_OFF_Y]! - jy;
        S[S_OFF_Z] = S[S_OFF_Z]! - jz;
      }
    }
    S[S_LAST_X] = bx; S[S_LAST_Y] = by; S[S_LAST_Z] = bz;
    hasLast = true;
    return false;
  }

  /** Restart glide offsets decay (critically damped); framing ball = ball + offset. */
  function stepGlide(): void {
    S[S_TGT + S_OFF_X] = S[S_TGT + S_OFF_Y] = S[S_TGT + S_OFF_Z] = 0;
    damp(S_OFF_X);
    damp(S_OFF_Y);
    damp(S_OFF_Z);
    S[S_FB_X] = S[S_BX]! + S[S_OFF_X]!;
    S[S_FB_Y] = Math.max(0, S[S_BY]! + S[S_OFF_Y]!);
    S[S_FB_Z] = S[S_BZ]! + S[S_OFF_Z]!;
  }

  /** Predicted apex of a rising ball (tilt and FOV widening start before the ball gets there). */
  function stepApex(): void {
    const fby = S[S_FB_Y]!, bvy = S[S_BVY]!;
    // predictApexY(), inline.
    const k = T_BALL.dragK;
    const rise = Math.log(1 + (k * Math.max(0, bvy) * bvy) / T_BALL.gravity) / (2 * k);
    S[S_APEX_Y] = Math.min(WORLD_MAX_Y, fby + rise);
    const tApex = bvy > 0 ? bvy / T_BALL.gravity : 0;
    S[S_APEX_X] = S[S_FB_X]! + S[S_BVX]! * tApex * 0.8;
    S[S_APEX_Z] = S[S_FB_Z]! + S[S_BVZ]! * tApex * 0.8;
  }

  /** Lead (direction of play, ball speed) and FOV widening (high or fast ball). */
  function stepLeadFov(): void {
    const bvx = S[S_BVX]!, bvy = S[S_BVY]!, bvz = S[S_BVZ]!;
    const speed = Math.sqrt(bvx * bvx + bvz * bvz);
    // leadFor(), inline.
    const lt = Math.min(1, speed / LT.leadFullSpeed);
    S[S_TGT + S_LEAD] = (T_CAMERA.leadMin + (T_CAMERA.leadMax - T_CAMERA.leadMin) * lt) * leadDir;
    damp(S_LEAD);
    const high = (S[S_APEX_Y]! - LT.widenHighStart) / (LT.widenHighFull - LT.widenHighStart);
    const fast = (Math.sqrt(speed * speed + bvy * bvy) - LT.widenFastStart) / (LT.widenFastFull - LT.widenFastStart);
    S[S_TGT + S_FOV] = S[S_R_FOV]! + S[S_R_WIDEN]! * Math.max(0, Math.min(1, Math.max(high, fast)));
    damp(S_FOV);
  }

  /** Apex tilt: smooth toward its target (tiltTarget() left it in S_THETA_PRE), then set the solver input. */
  function stepTilt(): void {
    S[S_TGT + S_TILT] = S[S_THETA_PRE]!;
    damp(S_TILT);
    S[S_THETA_PRE] = S[S_THETA0]! - S[S_TILT]!;
  }

  function update(f: RenderFrame): void {
    if (!active) return;
    const s = f.curr;
    readInputs(f);
    stepDirection(s);
    // The view team's attack direction (End to End orientation, stick rotation). It changes ends at half-time:
    // the End to End camera then makes one clean cut.
    const fc = facingOf(s);
    if (fc !== facing) {
      facing = fc;
      if (e2e === 1) { cutToBall(); return; }
    }
    if (stepTeleport(f.frame.ticks | 0)) return;
    stepGlide();
    stepApex();
    stepLeadFov();
    followTargets(true);
    applyAspect();
    basePose();
    tiltTarget();
    stepTilt();
    solve();
    writeCamera();
    // Safety net (never expected): the ball cannot be framed from here -> cut to it.
    if (!ballVisible()) cutToBall();
  }

  const module: BroadcastCameraModule = {
    get active() { return active; },
    get rig() { return rig; },
    get lookX() { return S[S_LOOK_X]!; },
    get lookZ() { return S[S_LOOK_Z]!; },
    get yaw() { return S[S_YAW]!; },
    get pitch() { return S[S_PITCH]!; },
    get tilt() { return S[S_TILT]!; },
    get lead() { return S[S_LEAD]!; },
    get cuts() { return cuts; },
    setMatch(state) {
      facing = facingOf(state);
      const b = state.ball;
      snapTo(b.x, b.y, b.z, playDir(state, 1));
    },
    update,
    resize() {
      projFull = true;
      applyPose();
    },
    setSettings(c: CameraSettings, reducedMotion: boolean) {
      broadcastRig(c, reducedMotion, rig);
      reduced = reducedMotion ? 1 : 0;
      syncRig();
      cutKeepLead();
    },
    snap() { cutKeepLead(); },
    snapTo,
    setViewTeam(team: number) {
      viewOverride = team === 0 || team === 1 ? team : -1;
    },
    screenToPitch,
    pitchToScreen,
    stickRotation() { return e2e === 1 ? (facing > 0 ? Math.PI / 2 : -Math.PI / 2) : 0; },
    clearMatch() {
      vel.fill(0);
      S[S_OFF_X] = S[S_OFF_Y] = S[S_OFF_Z] = 0;
      hasLast = false;
    },
    dispose() { active = false; },
  };
  return module;
}

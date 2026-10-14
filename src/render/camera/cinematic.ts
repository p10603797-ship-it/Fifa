/**
 * [GFX-15] Set-piece, intro and replay cameras (section 8 "Other cameras"): a camera director over the broadcast
 * camera (GFX-14), which keeps running underneath every frame.
 *
 * DIRECTOR (chooseShot, a pure decision table over the live phase, the restart and the replay playback):
 *   PRE_MATCH / HALF_TIME / EXTRA_TIME break / FULL_TIME / POST_MATCH -> ESTABLISHING (a short, slow orbit high inside
 *     the bowl looking at the centre spot; skippable: the sim's skip ends the phase, skip() ends the shot);
 *   KICK_OFF -> main camera (or ESTABLISHING while an establishing('kickoff') request is live and the kick-off is not
 *     ready); IN_PLAY / THROW_IN / GOAL / CELEBRATION -> main camera;
 *   GOAL_KICK / PENALTY / SHOOT_OUT -> BEHIND_TAKER; FREE_KICK -> BEHIND_TAKER within LOCAL_TUNING.fkNearGoal of the
 *     attacked goal, else the main camera; CORNER -> CORNER (raised view from behind the corner flag into the box);
 *   a free kick or penalty struck as a shot keeps the behind view while the shot is in flight (at most shotHold s);
 *   replay playback (GFX-16 replayPlaybackOf(ctx)) -> REPLAY_SIDE (side close-up) / REPLAY_GOAL (low behind the goal),
 *     tracking the replayed ball (the replay module substitutes the frame before the cameras run).
 * SWITCHING: a new shot (or a new restart spot / replay angle) either CUTS or BLENDS. It blends over T_CAMERA.blendTime
 *   (0.25 s, smoothstep) only when the camera would move at most blendMaxDist and turn at most blendMaxAngle; anything
 *   bigger is a cut, so the camera never flies across the pitch. Replay boundaries always cut. Reduced camera motion:
 *   cuts only, and the establishing shot holds still.
 * SHOTS (pure pose functions, all inside |x| <= maxX, |z| <= maxZ: in front of the stand walls, never in the goal):
 *   behind the taker: on the line from the attacked goal through the ball, takerBack behind it and takerHeight up, the
 *   pitch solved so the ball sits at takerBallY of the screen with the top of the goal in view; goal kicks use a lower,
 *   wider rig in front of the goal looking up-field. Corner: cornerBack beyond the flag on the line from the penalty
 *   spot through the flag, cornerHeight up, ball at cornerBallY. Replay side: near-side close-up trailing the ball;
 *   replay goal: low behind the goal, just above the bar so the view clears the net; both frame a constant height of
 *   pitch (FOV from distance).
 * PROJECTOR: while active the camera owns ctx.camera; screenToPitch / pitchToScreen follow it, and stickRotation()
 *   rotates the stick with the view for BEHIND_TAKER and CORNER so "up" aims where the camera looks (toward goal; up-field
 *   for goal kicks): rotation = -yaw (contracts/input.ts CameraProjector convention). 0 otherwise.
 *   Same-iPad 1v1 shares this one camera (section 8).
 * No allocation per frame: doubles live in one Float64Array and preallocated pose objects.
 * DEBUG: window.__dotkickCinematic (this module) for e2e.
 */

import { Euler, type PerspectiveCamera } from 'three';
import { BALL_RADIUS, GOAL_HEIGHT, HALF_LENGTH, PENALTY_SPOT_DIST } from '../../contracts/constants';
import { MatchPhase, RestartKind } from '../../contracts/enums';
import { EventType, type EventBuffer } from '../../contracts/events';
import type { CameraSettings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import { T_CAMERA } from '../../contracts/tuning';
import { ReplayAngle, replayPlaybackOf } from '../replay';
import { createInterpState, type CameraModule, type RenderContext, type RenderFrame } from '../types';
import { projectPitchToScreen, projectScreenToPitch } from './project';

export const LOCAL_TUNING = { // TUNING-CR (GFX-15 cinematic cameras)
  // ---- director
  /** Free kicks at most this far (m) from the attacked goal's centre get the behind-the-taker camera. */
  fkNearGoal: 35,
  /** A free kick / penalty struck as a shot keeps the behind view while in flight, at most this long, s. */
  shotHold: 1.2,
  /** An establishing('kickoff' | 'fulltime') request lasts at most this long, s. */
  establishingMax: 4,
  /** Blend (instead of cut) only when the camera moves at most blendMaxDist m, turns at most blendMaxAngle deg and
   *  changes its FOV by at most blendMaxFov deg. */
  blendMaxDist: 10,
  blendMaxAngle: 35,
  blendMaxFov: 12,
  /** A restart spot that moves further than this (m) is a new shot. */
  rekeyDist: 0.5,
  // ---- behind the taker (free kicks, penalties, shoot-out)
  /** Distance behind the ball m, height m, vertical FOV deg. */
  takerBack: 8,
  takerHeight: 3.2,
  takerFov: 36,
  /** Ball height on screen (fraction from the top) the pitch is solved for. INT-C: 0.74 -> 0.68, so the taker standing
   *  behind the ball (lower on screen) stays above the HUD radar at the bottom centre. */
  takerBallY: 0.68,
  /** The crossbar stays at least this fraction below the top edge. */
  takerTopMargin: 0.12,
  // ---- goal kicks (in front of the goal, looking up-field)
  goalKickBack: 5,
  goalKickHeight: 3.4,
  goalKickFov: 48,
  goalKickBallY: 0.76,
  /** Point on the kick line (m ahead of the ball) kept at least goalKickTopMargin below the top edge. */
  goalKickLook: 40,
  goalKickTopMargin: 0.18,
  /** Goal-kick cameras stay this far inside the goal line (m): the goal frame stays behind them. */
  goalKickLineInset: 0.5,
  /** [INT-C] Goal-kick camera offset sideways from the kick line toward the pitch's long axis (m), and the share of the
   *  angle between the far kick-line point and the ball the view turns toward the ball. Straight behind the ball the
   *  keeper taking the kick stood 3.5 m in front of the lens, filling the frame and hiding the ball. */
  goalKickSide: 2.2,
  goalKickBallYaw: 0.5,
  // ---- corner (raised view from behind the flag)
  cornerBack: 8,
  cornerHeight: 7,
  /** INT-C: 50 -> 56 with cornerBallY 0.8 -> 0.7: at 0.8 the ball sat just above the HUD radar and the taker behind it
   *  (lower on screen, toward the camera) stood under the radar, hiding the ball; the wider FOV keeps the goal frame
   *  ~10% below the top edge. */
  cornerFov: 56,
  /** Look target on the goal axis this far from the goal line, m (the penalty spot). */
  cornerLookIn: 11,
  cornerBallY: 0.7,
  // ---- establishing orbit (high, inside the bowl, around the centre spot)
  orbitRadiusX: 56,
  orbitRadiusZ: 40,
  orbitHeight: 26,
  orbitFov: 50,
  /** Start azimuth deg (0 = near-side centre, + toward +x), speed deg/s, total arc deg. */
  orbitStart: -28,
  orbitSpeed: 9,
  orbitArc: 56,
  // ---- replay angles
  /** Side close-up: distance toward the near side m, height m, trail behind the ball toward its own half m, framed
   *  pitch height m (FOV from distance). */
  sideDist: 24,
  sideHeight: 7,
  sideLag: 6,
  sideFrame: 12,
  /** Behind the goal: distance behind the goal line m (in front of the boards), height m (just above the bar: the line
   *  of sight clears the net roof and the keeper), framed height m, share of the goal z followed. */
  goalCamBack: 5,
  goalCamHeight: 3.4,
  goalFrame: 10,
  goalCamZFollow: 0.5,
  replayFovMin: 18,
  replayFovMax: 55,
  /** Look-point smoothing of the replay angles (critically damped), s. */
  replaySmooth: 0.12,
  /** Look height over a grounded ball m, and the share of the ball's height followed. */
  lookBaseY: 0.8,
  lookFollowY: 0.7,
  // ---- limits
  /** Camera box: in front of the stand walls (62 / 44 m) and above the grass. */
  maxX: 60,
  maxZ: 42.5,
  minY: 1.2,
  /** Longest real frame time a step advances, s. */
  maxStep: 0.1,
  /** setMatch warm-up iterations of the per-frame paths (pose solvers, blend, look smoothing). */
  warmUpIterations: 2000,
} as const;

const LT = LOCAL_TUNING;
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Camera shots the director can choose. */
export enum CineShot {
  /** The broadcast camera (GFX-14) drives ctx.camera. */
  NONE = 0,
  BEHIND_TAKER = 1,
  CORNER = 2,
  ESTABLISHING = 3,
  REPLAY_SIDE = 4,
  REPLAY_GOAL = 5,
}

/** A camera pose: position (m), yaw (rad about +y, 0 looks toward -z), pitch (rad, + looks down), vertical FOV (deg). */
export interface CinePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
}

// Classes (own hidden classes): `{ x, y, ... }` literals share maps across the codebase, and a double stored into a field
// another literal of that map uses for objects is boxed (allocation per frame).
class Pose implements CinePose {
  x = 0.5;
  y = 0.5;
  z = 0.5;
  yaw = 0.5;
  pitch = 0.5;
  fov = 22.5;
}

export function createCinePose(): CinePose {
  return new Pose();
}

/** Inputs of the decision table. */
export interface DirectorInput {
  phase: number;
  /** Distance (m) from the restart spot to the centre of the goal the restart team attacks. */
  goalDist: number;
  replayPlaying: boolean;
  replayAngle: ReplayAngle;
  /** An establishing() request is live. */
  establishing: boolean;
  /** The establishing shot of this phase was skipped. */
  skipped: boolean;
  /** A free kick / penalty shot struck from the behind view is still in flight. */
  holdShot: boolean;
}

class Input implements DirectorInput {
  phase: number = MatchPhase.IN_PLAY;
  goalDist = 100.5;
  replayPlaying = false;
  replayAngle: ReplayAngle = ReplayAngle.SIDE;
  establishing = false;
  skipped = false;
  holdShot = false;
}

export function createDirectorInput(): DirectorInput {
  return new Input();
}

/** The director's decision table (section 8 "Other cameras"). Pure. */
export function chooseShot(i: Readonly<DirectorInput>): CineShot {
  if (i.replayPlaying) return i.replayAngle === ReplayAngle.BEHIND_GOAL ? CineShot.REPLAY_GOAL : CineShot.REPLAY_SIDE;
  switch (i.phase) {
    case MatchPhase.PRE_MATCH:
    case MatchPhase.HALF_TIME:
    case MatchPhase.EXTRA_TIME:
    case MatchPhase.FULL_TIME:
    case MatchPhase.POST_MATCH:
      return i.skipped ? CineShot.NONE : CineShot.ESTABLISHING;
    case MatchPhase.KICK_OFF:
      return i.establishing && !i.skipped ? CineShot.ESTABLISHING : CineShot.NONE;
    case MatchPhase.GOAL_KICK:
    case MatchPhase.PENALTY:
    case MatchPhase.SHOOT_OUT:
      return CineShot.BEHIND_TAKER;
    case MatchPhase.FREE_KICK:
      return i.goalDist <= LT.fkNearGoal ? CineShot.BEHIND_TAKER : CineShot.NONE;
    case MatchPhase.CORNER:
      return CineShot.CORNER;
    case MatchPhase.IN_PLAY:
      return i.holdShot ? CineShot.BEHIND_TAKER : CineShot.NONE;
    default: // THROW_IN (main camera), GOAL, CELEBRATION, REPLAY without playback
      return CineShot.NONE;
  }
}

/** True when the shot drives the stick rotation (behind-the-taker style views). */
export function rotatesStick(shot: CineShot): boolean {
  return shot === CineShot.BEHIND_TAKER || shot === CineShot.CORNER;
}

/** Stick rotation for a camera yaw (contracts/input.ts: "up" maps to the view direction). Pure. */
export function stickRotationForYaw(yaw: number): number {
  let r = -yaw;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r === 0 ? 0 : r; // no -0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Screen height (0 top .. 1 bottom) of a point at depression theta for a camera pitch (point on the view plane). */
export function screenYAt(theta: number, pitch: number, fovDeg: number): number {
  return (1 + Math.tan(theta - pitch) / Math.tan(fovDeg * DEG * 0.5)) * 0.5;
}

// Pose solvers. Per-frame code calls the *In forms, which read their double inputs from PIN and use only inline maths
// (a double crossing a call boundary can box: one allocation per frame); the exported forms are thin wrappers.
const PIN = new Float64Array(8);
const TAN_HALF = (fovDeg: number): number => Math.tan(fovDeg * DEG * 0.5);
const T_TAKER = TAN_HALF(LT.takerFov), T_GOAL_KICK = TAN_HALF(LT.goalKickFov), T_CORNER = TAN_HALF(LT.cornerFov);

/** takerPose on PIN = [spotX, spotZ, aimX, aimZ]. */
function takerPoseIn(goalKick: boolean, out: CinePose): void {
  const spotX = PIN[0]!, spotZ = PIN[1]!, aimX = PIN[2]!, aimZ = PIN[3]!;
  let dx = aimX - spotX, dz = aimZ - spotZ;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l > 1e-3) { dx /= l; dz /= l; } else { dx = spotX > 0 ? -1 : 1; dz = 0; }
  const back = goalKick ? LT.goalKickBack : LT.takerBack;
  const maxX = goalKick ? HALF_LENGTH - LT.goalKickLineInset : LT.maxX;
  let cx = spotX - dx * back;
  let cz = spotZ - dz * back;
  if (goalKick) {
    // Sideways (perpendicular to the kick line) toward the pitch's long axis, so the taker is not in front of the lens.
    const pz = dx;
    const sgn = spotZ * pz > 0 ? -1 : 1;
    cx += -dz * LT.goalKickSide * sgn;
    cz += pz * LT.goalKickSide * sgn;
  }
  cx = Math.max(-maxX, Math.min(maxX, cx));
  cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, cz));
  const cy = goalKick ? LT.goalKickHeight : LT.takerHeight;
  const tanHalf = goalKick ? T_GOAL_KICK : T_TAKER;
  // Look point: the goal (free kick, penalty) or goalKickLook ahead on the kick line (goal kick).
  const lx = goalKick ? spotX + dx * LT.goalKickLook : aimX;
  const lz = goalKick ? spotZ + dz * LT.goalKickLook : aimZ;
  out.x = cx; out.y = cy; out.z = cz; out.fov = goalKick ? LT.goalKickFov : LT.takerFov;
  out.yaw = Math.atan2(-(lx - cx), -(lz - cz));
  if (goalKick) {
    // Turn part of the way toward the ball (now off the view axis) so ball, taker and the far kick line share the frame.
    let d = Math.atan2(-(spotX - cx), -(spotZ - cz)) - out.yaw;
    d -= TWO_PI * Math.floor((d + Math.PI) / TWO_PI);
    out.yaw += d * LT.goalKickBallYaw;
  }
  const bx = spotX - cx, bz = spotZ - cz;
  const thetaBall = Math.atan2(cy - BALL_RADIUS, Math.max(0.5, Math.sqrt(bx * bx + bz * bz)));
  const ballY = goalKick ? LT.goalKickBallY : LT.takerBallY;
  let pitch = thetaBall - Math.atan((2 * ballY - 1) * tanHalf);
  // Keep the top of the goal (or the far point of the kick line) in view.
  const ax = lx - cx, az = lz - cz;
  const thetaTop = Math.atan2(cy - (goalKick ? 0 : GOAL_HEIGHT), Math.max(0.5, Math.sqrt(ax * ax + az * az)));
  const topY = goalKick ? LT.goalKickTopMargin : LT.takerTopMargin;
  const maxPitch = thetaTop - Math.atan((2 * topY - 1) * tanHalf);
  if (pitch > maxPitch) pitch = maxPitch;
  out.pitch = pitch;
}

/**
 * Behind-the-taker pose for a ball at the spot aiming at (aimX, aimZ) (the attacked goal's centre for free kicks and
 * penalties). goalKick: the low, wide rig in front of the own goal looking up-field along the aim. Pure; writes out.
 */
export function takerPose(spotX: number, spotZ: number, aimX: number, aimZ: number, goalKick: boolean, out: CinePose): CinePose {
  PIN[0] = spotX; PIN[1] = spotZ; PIN[2] = aimX; PIN[3] = aimZ;
  takerPoseIn(goalKick, out);
  return out;
}

/** cornerPose on PIN = [cornerX, cornerZ]. */
function cornerPoseIn(out: CinePose): void {
  const cornerX = PIN[0]!, cornerZ = PIN[1]!;
  const end = cornerX < 0 ? -1 : 1;
  const tx = end * (HALF_LENGTH - LT.cornerLookIn), tz = 0;
  let dx = cornerX - tx, dz = cornerZ - tz;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l > 1e-3) { dx /= l; dz /= l; } else { dx = end; dz = 0; }
  const cx = Math.max(-LT.maxX, Math.min(LT.maxX, cornerX + dx * LT.cornerBack));
  const cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, cornerZ + dz * LT.cornerBack));
  const cy = LT.cornerHeight;
  out.x = cx; out.y = cy; out.z = cz; out.fov = LT.cornerFov;
  out.yaw = Math.atan2(-(tx - cx), -(tz - cz));
  const bx = cornerX - cx, bz = cornerZ - cz;
  const thetaBall = Math.atan2(cy - BALL_RADIUS, Math.max(0.5, Math.sqrt(bx * bx + bz * bz)));
  out.pitch = thetaBall - Math.atan((2 * LT.cornerBallY - 1) * T_CORNER);
}

/** Raised corner pose for a corner taken from (cornerX, cornerZ). Pure; writes out. */
export function cornerPose(cornerX: number, cornerZ: number, out: CinePose): CinePose {
  PIN[0] = cornerX; PIN[1] = cornerZ;
  cornerPoseIn(out);
  return out;
}

/** establishingPose on PIN = [t]. */
function establishingPoseIn(dir: number, reduced: boolean, out: CinePose): void {
  const t = PIN[0]!;
  const swept = reduced ? 0 : Math.min(LT.orbitArc, LT.orbitSpeed * Math.max(0, t));
  const az = (LT.orbitStart + swept) * DEG * (dir < 0 ? -1 : 1);
  const cx = LT.orbitRadiusX * Math.sin(az), cz = LT.orbitRadiusZ * Math.cos(az), cy = LT.orbitHeight;
  out.x = cx; out.y = cy; out.z = cz; out.fov = LT.orbitFov;
  out.yaw = Math.atan2(cx, cz);
  out.pitch = Math.atan2(cy, Math.sqrt(cx * cx + cz * cz));
}

/**
 * Establishing orbit at time t (s) of the shot. dir +1 sweeps toward +x (kick-off, half-time), -1 the other way (full
 * time). Reduced motion: holds the start pose. Pure; writes out.
 */
export function establishingPose(t: number, dir: number, reduced: boolean, out: CinePose): CinePose {
  PIN[0] = t;
  establishingPoseIn(dir, reduced, out);
  return out;
}

/** Shared tail of the replay poses: camera at (cx, cy, cz) looking at PIN[0..2], framing `frame` metres. */
function lookAtFramed(cx: number, cy: number, cz: number, frame: number, out: CinePose): void {
  const lx = PIN[0]!, ly = PIN[1]!, lz = PIN[2]!;
  const dx = lx - cx, dz = lz - cz;
  const h = Math.max(0.5, Math.sqrt(dx * dx + dz * dz));
  const dy = cy - ly;
  out.x = cx; out.y = cy; out.z = cz;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, h);
  const d = Math.max(0.5, Math.sqrt(h * h + dy * dy));
  out.fov = Math.max(LT.replayFovMin, Math.min(LT.replayFovMax, (2 * Math.atan(frame / (2 * d))) / DEG));
}

/** replaySidePose on PIN = [lx, ly, lz]. */
function replaySidePoseIn(goalEnd: number, out: CinePose): void {
  const cx = Math.max(-LT.maxX, Math.min(LT.maxX, PIN[0]! - (goalEnd < 0 ? -1 : 1) * LT.sideLag));
  const cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, PIN[2]! + LT.sideDist));
  lookAtFramed(cx, LT.sideHeight, cz, LT.sideFrame, out);
}

/** Replay side close-up looking at (lx, ly, lz), trailing toward the attacked goal `goalEnd`. Pure; writes out. */
export function replaySidePose(lx: number, ly: number, lz: number, goalEnd: number, out: CinePose): CinePose {
  PIN[0] = lx; PIN[1] = ly; PIN[2] = lz;
  replaySidePoseIn(goalEnd, out);
  return out;
}

/** replayGoalPose on PIN = [lx, ly, lz, goalZ]. */
function replayGoalPoseIn(goalEnd: number, out: CinePose): void {
  const cx = (goalEnd < 0 ? -1 : 1) * Math.min(LT.maxX, HALF_LENGTH + LT.goalCamBack);
  const cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, PIN[3]! * LT.goalCamZFollow));
  lookAtFramed(cx, LT.goalCamHeight, cz, LT.goalFrame, out);
}

/** Replay low camera behind the goal at end goalEnd, looking at (lx, ly, lz). Pure; writes out. */
export function replayGoalPose(lx: number, ly: number, lz: number, goalEnd: number, goalZ: number, out: CinePose): CinePose {
  PIN[0] = lx; PIN[1] = ly; PIN[2] = lz; PIN[3] = goalZ;
  replayGoalPoseIn(goalEnd, out);
  return out;
}

/** Angle (rad) between the view directions of two poses. Pure. */
export function poseAngle(a: Readonly<CinePose>, b: Readonly<CinePose>): number {
  const ca = Math.cos(a.pitch), cb = Math.cos(b.pitch);
  const d = Math.sin(a.yaw) * ca * Math.sin(b.yaw) * cb + Math.sin(a.pitch) * Math.sin(b.pitch)
    + Math.cos(a.yaw) * ca * Math.cos(b.yaw) * cb;
  return Math.acos(clamp(d, -1, 1));
}

/** Distance (m) between two poses' positions. Pure. */
export function poseDistance(a: Readonly<CinePose>, b: Readonly<CinePose>): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** True when switching from a to b may blend (small move, turn and zoom); otherwise it must cut. Pure. */
export function canBlend(a: Readonly<CinePose>, b: Readonly<CinePose>): boolean {
  return poseDistance(a, b) <= LT.blendMaxDist && poseAngle(a, b) <= LT.blendMaxAngle * DEG
    && Math.abs(a.fov - b.fov) <= LT.blendMaxFov;
}

/** Blend weight (smoothstep) after t seconds of a blend lasting `dur`. 1 when dur <= 0. Pure. */
export function blendWeight(t: number, dur: number): number {
  if (!(dur > 0)) return 1;
  const u = clamp(t / dur, 0, 1);
  return u * u * (3 - 2 * u);
}

/** out = a + (b - a) * w (yaw along the short arc). Pure. */
export function mixPose(a: Readonly<CinePose>, b: Readonly<CinePose>, w: number, out: CinePose): CinePose {
  PIN[7] = w;
  mixPoseIn(a, b, out);
  return out;
}

/** mixPose with the weight in PIN[7]. */
function mixPoseIn(a: Readonly<CinePose>, b: Readonly<CinePose>, out: CinePose): void {
  const w = PIN[7]!;
  let dy = b.yaw - a.yaw;
  dy -= TWO_PI * Math.round(dy / TWO_PI); // short arc, branch-free
  out.x = a.x + (b.x - a.x) * w;
  out.y = a.y + (b.y - a.y) * w;
  out.z = a.z + (b.z - a.z) * w;
  out.yaw = a.yaw + dy * w;
  out.pitch = a.pitch + (b.pitch - a.pitch) * w;
  out.fov = a.fov + (b.fov - a.fov) * w;
}

function copyPose(src: Readonly<CinePose>, dst: CinePose): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z; dst.yaw = src.yaw; dst.pitch = src.pitch; dst.fov = src.fov;
}

export interface CinematicCameraModule extends CameraModule {
  /** Request the establishing shot for kick-off / full time (skippable). Returns false if not available. */
  establishing(kind: 'kickoff' | 'fulltime'): boolean;
  /** End the current establishing shot now (cut to the main camera until the phase changes). */
  skip(): void;
  /** Shot the director chose for the latest frame. */
  readonly shot: CineShot;
  /** True while a blend is in progress. */
  readonly blending: boolean;
  /** Cuts and blends since creation. */
  readonly cuts: number;
  readonly blends: number;
  /** Pose written to ctx.camera on the latest active frame. */
  readonly pose: Readonly<CinePose>;
}

// Doubles in one Float64Array (no boxing per frame).
const S_DT = 0, S_BLEND_T = 1, S_SHOT_T = 2, S_EST_T = 3, S_HOLD_T = 4, S_SPOT_X = 5, S_SPOT_Z = 6, S_AIM_X = 7,
  S_AIM_Z = 8, S_KEY_X = 9, S_KEY_Z = 10, S_YAW_TGT = 11, S_LOOK_X = 12, S_LOOK_Y = 13, S_LOOK_Z = 14, S_LV_X = 15,
  S_LV_Y = 16, S_LV_Z = 17, S_GOAL_DIST = 18;
const S_SIZE = 19;

function isSetPiecePhase(p: number): boolean {
  return p === MatchPhase.GOAL_KICK || p === MatchPhase.CORNER || p === MatchPhase.FREE_KICK || p === MatchPhase.PENALTY
    || p === MatchPhase.SHOOT_OUT;
}

function restartKindOf(phase: number): number {
  switch (phase) {
    case MatchPhase.GOAL_KICK: return RestartKind.GOAL_KICK;
    case MatchPhase.CORNER: return RestartKind.CORNER;
    case MatchPhase.FREE_KICK: return RestartKind.FREE_KICK;
    case MatchPhase.PENALTY: return RestartKind.PENALTY;
    default: return RestartKind.NONE;
  }
}

export function createCinematicCamera(ctx: RenderContext): CinematicCameraModule {
  const cam: PerspectiveCamera = ctx.camera;
  const link = replayPlaybackOf(ctx);
  const S = new Float64Array(S_SIZE);
  const euler = new Euler(0, 0, 0, 'YXZ');
  const input = createDirectorInput();
  const target = createCinePose();
  const from = createCinePose();
  const out = createCinePose();
  const last = createCinePose();
  // Small integers / booleans only below (never allocate).
  let shot: CineShot = CineShot.NONE;
  let active = false;
  let blending = false;
  let reduced = ctx.reducedMotion;
  let matchOn = false;
  let goalKick = false;
  let orbitDir = 1;
  /** 0 none, 1 kick-off, 2 full time. */
  let estKind = 0;
  let skippedPhase = -1;
  let holdArmed = false;
  let restartSerial = 0;
  let keySerial = -1;
  let keyCuts = -1;
  let cuts = 0;
  let blends = 0;
  let lastPhase = -1;
  /** Stick rotation of the current behind-the-taker / corner view (a ready number: returning it never allocates). */
  let stickRot = 0;
  /** The static shot's target pose is solved (BEHIND_TAKER / CORNER); cleared on every switch. */
  let targetFresh = false;

  /** Aspect + the pose's FOV into the projection (only elements 0 and 5 depend on them for this symmetric frustum). */
  function applyProjection(p: Readonly<CinePose>): void {
    const fov = p.fov;
    const a = Math.max(1, ctx.size.cssW) / Math.max(1, ctx.size.cssH);
    if (cam.zoom !== 1 || cam.filmOffset !== 0 || (cam.view !== null && cam.view.enabled)) {
      cam.aspect = a; cam.fov = fov;
      cam.updateProjectionMatrix();
      return;
    }
    if (!(Math.abs(cam.fov - fov) > 1e-9) && !(Math.abs(cam.aspect - a) > 1e-9)) return;
    cam.aspect = a;
    cam.fov = fov;
    const t = Math.tan(fov * DEG * 0.5);
    const te = cam.projectionMatrix.elements;
    te[0] = 1 / (a * t);
    te[5] = 1 / t;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  function writeCamera(p: Readonly<CinePose>): void {
    cam.position.set(p.x, p.y, p.z);
    euler.set(-p.pitch, p.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(euler);
    applyProjection(p);
    cam.updateMatrixWorld(true);
  }

  /** The pose currently in ctx.camera (the broadcast camera's when this module is idle). */
  function readCamera(p: CinePose): void {
    p.x = cam.position.x; p.y = cam.position.y; p.z = cam.position.z;
    euler.setFromQuaternion(cam.quaternion, 'YXZ');
    p.pitch = -euler.x;
    p.yaw = euler.y;
    p.fov = cam.fov;
  }

  /** Restart spot / aim from the live state (set-piece phases only). */
  function readSpot(s: ReadonlySimState, f: RenderFrame): void {
    const phase = s.match.phase;
    const r = s.match.restart;
    if (phase === MatchPhase.SHOOT_OUT) {
      // Shoot-out: the penalty spot of the end the ball is at (stable while the ball moves).
      const end = f.interp.ballX < 0 ? -1 : 1;
      S[S_SPOT_X] = end * (HALF_LENGTH - PENALTY_SPOT_DIST);
      S[S_SPOT_Z] = 0;
      S[S_AIM_X] = end * HALF_LENGTH;
      S[S_AIM_Z] = 0;
      goalKick = false;
      S[S_GOAL_DIST] = PENALTY_SPOT_DIST;
      return;
    }
    const match = r.kind === restartKindOf(phase);
    const x = match ? r.x : f.interp.ballX;
    const z = match ? r.z : f.interp.ballZ;
    const t = match && (r.team === 0 || r.team === 1) ? s.teams[r.team]! : null;
    // Attacked goal: the restart team's direction; fallback: the goal nearest the spot (penalty / free kick) or the
    // far one (goal kick).
    let dir = t ? (t.dir < 0 ? -1 : 1) : (x < 0 ? -1 : 1);
    if (!t && phase === MatchPhase.GOAL_KICK) dir = -dir;
    S[S_SPOT_X] = x - x === 0 ? x : 0;
    S[S_SPOT_Z] = z - z === 0 ? z : 0;
    S[S_AIM_X] = dir * HALF_LENGTH;
    S[S_AIM_Z] = 0;
    goalKick = phase === MatchPhase.GOAL_KICK;
    const gx = S[S_AIM_X]! - S[S_SPOT_X]!, gz = S[S_SPOT_Z]!;
    S[S_GOAL_DIST] = Math.sqrt(gx * gx + gz * gz);
  }

  /** Critically damped look point for the replay angles (snap when `snap`). */
  function stepLook(f: RenderFrame, snap: boolean): void {
    const it = f.interp;
    const by = it.ballY;
    const ly = LT.lookBaseY + LT.lookFollowY * Math.max(0, (by - by === 0 ? by : 0) - BALL_RADIUS);
    const tx = it.ballX - it.ballX === 0 ? it.ballX : S[S_LOOK_X]!;
    const tz = it.ballZ - it.ballZ === 0 ? it.ballZ : S[S_LOOK_Z]!;
    if (snap) {
      S[S_LOOK_X] = tx; S[S_LOOK_Y] = ly; S[S_LOOK_Z] = tz;
      S[S_LV_X] = 0; S[S_LV_Y] = 0; S[S_LV_Z] = 0;
      return;
    }
    const dt = S[S_DT]!;
    const omega = 2 / LT.replaySmooth;
    const x = omega * dt;
    const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    for (let c = 0; c < 3; c++) {
      const tgt = c === 0 ? tx : c === 1 ? ly : tz;
      const ch = S[S_LOOK_X + c]! - tgt;
      const temp = (S[S_LV_X + c]! + omega * ch) * dt;
      S[S_LV_X + c] = (S[S_LV_X + c]! - omega * temp) * e;
      S[S_LOOK_X + c] = tgt + (ch + temp) * e;
    }
  }

  /** Target pose of the current shot into `target`. NONE: the broadcast camera's pose in ctx.camera. */
  function computeTarget(): void {
    switch (shot) {
      case CineShot.BEHIND_TAKER:
        if (targetFresh) return; // static shot: solved once per shot (transition / new spot)
        PIN[0] = S[S_SPOT_X]!; PIN[1] = S[S_SPOT_Z]!; PIN[2] = S[S_AIM_X]!; PIN[3] = S[S_AIM_Z]!;
        takerPoseIn(goalKick, target);
        break;
      case CineShot.CORNER:
        if (targetFresh) return;
        PIN[0] = S[S_SPOT_X]!; PIN[1] = S[S_SPOT_Z]!;
        cornerPoseIn(target);
        break;
      case CineShot.ESTABLISHING:
        PIN[0] = S[S_SHOT_T]!;
        establishingPoseIn(orbitDir, reduced, target);
        break;
      case CineShot.REPLAY_SIDE:
        PIN[0] = S[S_LOOK_X]!; PIN[1] = S[S_LOOK_Y]!; PIN[2] = S[S_LOOK_Z]!;
        replaySidePoseIn(link.goalEnd < 0 ? -1 : 1, target);
        break;
      case CineShot.REPLAY_GOAL:
        PIN[0] = S[S_LOOK_X]!; PIN[1] = S[S_LOOK_Y]!; PIN[2] = S[S_LOOK_Z]!; PIN[3] = link.goalZ;
        replayGoalPoseIn(link.goalEnd < 0 ? -1 : 1, target);
        break;
      default:
        readCamera(target);
        break;
    }
    if (shot !== CineShot.NONE) {
      if (target.y < LT.minY) target.y = LT.minY;
      if (rotatesStick(shot) && target.yaw !== S[S_YAW_TGT]) {
        // Stick rotation = -yaw in (-pi, pi]; kept as a ready number so stickRotation() never boxes a new one.
        let r = -target.yaw;
        while (r > Math.PI) r -= 2 * Math.PI;
        while (r <= -Math.PI) r += 2 * Math.PI;
        stickRot = r === 0 ? 0 : r;
        S[S_YAW_TGT] = target.yaw;
      }
    }
    targetFresh = shot === CineShot.BEHIND_TAKER || shot === CineShot.CORNER;
  }

  /**
   * Warm-up (setMatch, off screen, ~1 ms): run the pose solvers, the blend and the look smoothing on scratch data often
   * enough for the JIT to optimise them, so the first set piece, blend or replay angle never allocates (unoptimised
   * code boxes the doubles of its maths). Restores the module state afterwards.
   */
  function warmUpPaths(): void {
    const a = createCinePose(), b = createCinePose(), c = createCinePose();
    const f: RenderFrame = {
      prev: null as unknown as ReadonlySimState, curr: null as unknown as ReadonlySimState, alpha: 1,
      frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
    };
    for (let i = 0; i < LT.warmUpIterations; i++) {
      const u = (i % 100) * 0.01;
      PIN[0] = 20 + u * 15; PIN[1] = u * 20 - 10; PIN[2] = HALF_LENGTH; PIN[3] = 0;
      takerPoseIn((i & 1) === 0, a);
      PIN[0] = (i & 2) === 0 ? 51.9 : -51.9; PIN[1] = (i & 4) === 0 ? 33.4 : -33.4;
      cornerPoseIn(b);
      PIN[0] = u * 4;
      establishingPoseIn((i & 1) === 0 ? 1 : -1, false, c);
      PIN[0] = u * 50 - 25; PIN[1] = 1.5 + u; PIN[2] = u * 10 - 5; PIN[3] = 1.25;
      replaySidePoseIn((i & 1) === 0 ? 1 : -1, a);
      replayGoalPoseIn((i & 1) === 0 ? 1 : -1, b);
      PIN[7] = u;
      a.yaw = (i % 13) * 0.6 - 3.6; // wrap cases too
      mixPoseIn(a, b, c);
      if (canBlend(a, c)) S[0] = poseAngle(a, b);
      f.interp.ballX = u * 30; f.interp.ballY = 0.5 + u; f.interp.ballZ = u * 5;
      stepLook(f, (i % 50) === 0);
    }
    S.fill(0);
  }

  function isReplay(sh: CineShot): boolean {
    return sh === CineShot.REPLAY_SIDE || sh === CineShot.REPLAY_GOAL;
  }

  /** Switch to a new shot: cut, or blend when the move is small (never with reduced motion or around replays). */
  function transition(next: CineShot, f: RenderFrame): void {
    if (active) copyPose(last, from);
    else readCamera(from);
    const prevShot = shot;
    shot = next;
    targetFresh = false;
    S[S_SHOT_T] = 0;
    if (isReplay(next)) stepLook(f, true);
    computeTarget();
    const mayBlend = !reduced && T_CAMERA.blendTime > 0 && !isReplay(next) && !isReplay(prevShot)
      && (active || next !== CineShot.NONE) && canBlend(from, target);
    if (mayBlend) {
      blending = true;
      S[S_BLEND_T] = 0;
      blends++;
    } else {
      blending = false;
      S[S_BLEND_T] = T_CAMERA.blendTime;
      if (active || next !== CineShot.NONE) cuts++;
    }
  }

  function update(f: RenderFrame): void {
    if (!matchOn) return;
    const s = f.curr;
    const ms = f.frame.dtMs;
    S[S_DT] = f.frame.paused || !(ms > 0) ? 0 : Math.min(LT.maxStep, ms / 1000);
    const dt = S[S_DT]!;
    const phase = s.match.phase;
    if (phase !== lastPhase) {
      if (phase !== skippedPhase) skippedPhase = -1;
      lastPhase = phase;
    }
    // Establishing request.
    if (estKind !== 0) {
      S[S_EST_T] = S[S_EST_T]! + dt;
      const live = S[S_EST_T]! < LT.establishingMax && (estKind === 1
        ? phase === MatchPhase.PRE_MATCH || (phase === MatchPhase.KICK_OFF && s.match.restart.ready !== 1)
        : phase === MatchPhase.FULL_TIME || phase === MatchPhase.POST_MATCH);
      if (!live) estKind = 0;
    }
    // Set-piece spot and the shot hold after a free kick / penalty is struck.
    if (isSetPiecePhase(phase)) readSpot(s, f);
    if (phase === MatchPhase.FREE_KICK || phase === MatchPhase.PENALTY) {
      holdArmed = shot === CineShot.BEHIND_TAKER;
      S[S_HOLD_T] = 0;
    } else if (phase === MatchPhase.IN_PLAY && holdArmed) {
      S[S_HOLD_T] = S[S_HOLD_T]! + dt;
      if (s.ball.shotBy < 0 || S[S_HOLD_T]! > LT.shotHold) holdArmed = false;
    } else holdArmed = false;
    // Decision.
    input.phase = phase;
    input.goalDist = S[S_GOAL_DIST]!;
    input.replayPlaying = link.playing;
    input.replayAngle = link.angle;
    input.establishing = estKind !== 0;
    input.skipped = skippedPhase === phase;
    input.holdShot = holdArmed && phase === MatchPhase.IN_PLAY;
    const next = chooseShot(input);
    orbitDir = phase === MatchPhase.FULL_TIME || phase === MatchPhase.POST_MATCH ? -1 : 1;
    // A new shot, a new restart (spot or award) or a new replay angle switches.
    let rekey = next !== shot;
    if (!rekey && (next === CineShot.BEHIND_TAKER || next === CineShot.CORNER) && isSetPiecePhase(phase)) {
      const mx = S[S_SPOT_X]! - S[S_KEY_X]!, mz = S[S_SPOT_Z]! - S[S_KEY_Z]!;
      rekey = keySerial !== restartSerial || mx * mx + mz * mz > LT.rekeyDist * LT.rekeyDist;
    }
    if (!rekey && isReplay(next)) rekey = keyCuts !== link.cuts;
    if (rekey) {
      S[S_KEY_X] = S[S_SPOT_X]!;
      S[S_KEY_Z] = S[S_SPOT_Z]!;
      keySerial = restartSerial;
      keyCuts = link.cuts;
      transition(next, f);
    } else {
      S[S_SHOT_T] = S[S_SHOT_T]! + dt;
      if (isReplay(shot)) stepLook(f, false);
    }
    if (shot === CineShot.NONE && !blending) {
      active = false;
      return;
    }
    computeTarget();
    if (blending) {
      const bt = S[S_BLEND_T]! + dt;
      S[S_BLEND_T] = bt;
      const u = T_CAMERA.blendTime > 0 ? Math.max(0, Math.min(1, bt / T_CAMERA.blendTime)) : 1;
      const w = u * u * (3 - 2 * u); // blendWeight (smoothstep); mixPose written out (hot path, no call)
      let dyaw = target.yaw - from.yaw;
      dyaw -= TWO_PI * Math.round(dyaw / TWO_PI);
      out.x = from.x + (target.x - from.x) * w;
      out.y = from.y + (target.y - from.y) * w;
      out.z = from.z + (target.z - from.z) * w;
      out.yaw = from.yaw + dyaw * w;
      out.pitch = from.pitch + (target.pitch - from.pitch) * w;
      out.fov = from.fov + (target.fov - from.fov) * w;
      if (bt >= T_CAMERA.blendTime) blending = false;
    } else copyPose(target, out);
    writeCamera(out);
    copyPose(out, last);
    active = shot !== CineShot.NONE || blending;
  }

  const module: CinematicCameraModule = {
    get active() { return active; },
    get shot() { return shot; },
    get blending() { return blending; },
    get cuts() { return cuts; },
    get blends() { return blends; },
    get pose() { return last; },
    setMatch(state: ReadonlySimState) {
      warmUpPaths();
      targetFresh = false;
      matchOn = true;
      shot = CineShot.NONE;
      active = false;
      blending = false;
      estKind = 0;
      skippedPhase = -1;
      holdArmed = false;
      lastPhase = state.match.phase;
      keyCuts = link.cuts;
      S.fill(0);
      S[S_GOAL_DIST] = 100;
      stickRot = 0;
    },
    update,
    onEvents(events: EventBuffer, _state: ReadonlySimState) {
      for (let i = 0; i < events.count; i++) {
        const ev = events.get(i);
        if (ev.type === EventType.RESTART_AWARDED) restartSerial++;
        else if (ev.type === EventType.PHASE_CHANGE && ev.b !== skippedPhase) skippedPhase = -1;
      }
    },
    setSettings(_c: CameraSettings, reducedMotion: boolean) {
      reduced = reducedMotion;
      if (reduced && blending) {
        blending = false;
        S[S_BLEND_T] = T_CAMERA.blendTime;
      }
    },
    snap() {
      if (blending) {
        blending = false;
        S[S_BLEND_T] = T_CAMERA.blendTime;
      }
      if (active && shot !== CineShot.NONE) {
        copyPose(target, out);
        writeCamera(out);
        copyPose(out, last);
      } else if (shot === CineShot.NONE) active = false;
    },
    resize() {
      if (!active) return;
      applyProjection(last);
      cam.updateMatrixWorld(true);
    },
    establishing(kind: 'kickoff' | 'fulltime') {
      if (!matchOn) return false;
      estKind = kind === 'kickoff' ? 1 : 2;
      S[S_EST_T] = 0;
      skippedPhase = -1;
      return true;
    },
    skip() {
      if (shot !== CineShot.ESTABLISHING) return;
      estKind = 0;
      skippedPhase = lastPhase;
    },
    screenToPitch(sx, sy, o) { return projectScreenToPitch(cam, ctx.size.cssW, ctx.size.cssH, sx, sy, o); },
    pitchToScreen(x, y, z, o) { return projectPitchToScreen(cam, ctx.size.cssW, ctx.size.cssH, x, y, z, o); },
    stickRotation() { return active && rotatesStick(shot) ? stickRot : 0; },
    clearMatch() {
      matchOn = false;
      active = false;
      blending = false;
      shot = CineShot.NONE;
      estKind = 0;
    },
    dispose() {
      matchOn = false;
      active = false;
      if (typeof window !== 'undefined') {
        const w = window as unknown as { __dotkickCinematic?: CinematicCameraModule };
        if (w.__dotkickCinematic === module) delete w.__dotkickCinematic;
      }
    },
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __dotkickCinematic?: CinematicCameraModule }).__dotkickCinematic = module;
  }
  return module;
}

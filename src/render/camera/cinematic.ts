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
 *     [QF-4] goal kicks, penalties, free kicks and corners keep the main camera until the restart is set up
 *     (match.restart.ready): RUL-11 teleports every player still out of position in that tick (D-008), and the cut
 *     into the set-piece shot on that very frame hides it (index.ts draws teleports at their new spot, never halfway);
 *   a free kick or penalty struck as a shot keeps the behind view while the shot is in flight (at most shotHold s);
 *   replay playback (GFX-16 replayPlaybackOf(ctx)) -> REPLAY_SIDE (side close-up) / REPLAY_GOAL (low behind the goal),
 *     tracking the replayed ball (the replay module substitutes the frame before the cameras run).
 * SWITCHING: a new shot (or a new restart spot / replay angle) either CUTS or BLENDS. It blends over T_CAMERA.blendTime
 *   (0.25 s, smoothstep) only when the camera would move at most blendMaxDist and turn at most blendMaxAngle; anything
 *   bigger is a cut, so the camera never flies across the pitch. Replay boundaries always cut. Reduced camera motion:
 *   cuts only, and the establishing shot holds still.
 * SHOTS (pure pose functions, all inside |x| <= maxX, |z| <= maxZ: in front of the stand walls, never in the goal):
 *   behind the taker: takerBack from the ball, takerPhi (penalties: penaltyPhi) around it from the line from the attacked
 *   goal through the ball (on the taker's kicking-foot side; unknown taker: the side of that line facing the pitch's
 *   long axis, the near side for central spots) and takerHeight up, turned
 *   to centre the ball and both posts (ball within takerBallNdc of the centre, FOV widened up to takerFovMax so the goal
 *   fits a 4:3 screen), the pitch solved so the ball sits at takerBallY of the screen with the top of the goal in view.
 *   [QF-4] The waiting taker stands 0.6 m behind the ball on the aim line: straight behind him the ball showed between
 *   his legs. Goal kicks: a raised rig goalKickBack from the ball, goalKickPhi around it toward the touchline (over the
 *   goal-line area beside the goal, its frame out of view), looking up-field (the far kick-line point and the centre
 *   spot in view); the keeper stays small and clear of the ball. Corner: cornerBack beyond the corner spot on the line from the penalty spot through it,
 *   turned cornerPhi toward the goal-line side, cornerHeight up, ball at cornerBallY. Replay side: near-side close-up trailing the ball;
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
import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS, PENALTY_SPOT_DIST } from '../../contracts/constants';
import { MatchPhase, RestartKind } from '../../contracts/enums';
import { EventType, type EventBuffer } from '../../contracts/events';
import type { CameraSettings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import { T_BALL, T_CAMERA } from '../../contracts/tuning';
import { ShootoutSub } from '../../sim/rules/shootout';
import { ReplayAngle, replayPlaybackOf } from '../replay';
import { createInterpState, type CameraModule, type EulerFields, type RenderContext, type RenderFrame } from '../types';
import { projectPitchToScreen, projectScreenToPitch } from './project';

export const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: GFX-15 cinematic cameras)
  // ---- director
  /** Free kicks at most this far (m) from the attacked goal's centre get the behind-the-taker camera. */
  fkNearGoal: 35,
  /** A free kick / penalty struck as a shot keeps the behind view while in flight, at most this long, s. */
  shotHold: 1.2,
  /** [QF-4] ... and only while the ball and the predicted apex of a rising ball stay inside the held view: this much of
   *  the screen height clear of the top edge (scoreboard) and of the width clear of either side. A chipped or skied
   *  shot (SIM-11 chips leave at 0.5-0.8 rad) rose out of the top of the low behind view for ~0.6 s; now the director
   *  cuts back to the main camera (which tilts for high balls) on the frame the flight would leave the view. */
  holdTopMargin: 0.06,
  holdSideMargin: 0.04,
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
  /** [QF-4] The camera sits this far (deg) around the ball from straight behind it. The waiting taker stands 0.6 m
   *  behind the ball on the aim line (RUL-11 takerBehind), so straight behind him the ball showed between his legs;
   *  with this angle and the model's set-piece stance (players/model.ts stanceSide: he is drawn a step to his side away
   *  from the camera) the ball stays clear for every aim across the goal frame. [QF-4 skeptic] 28 -> 38, on the taker's
   *  kicking-foot side: at 28 deg the charged backswing (the CPU holds it ~0.35 s) hid the ball behind the support shin
   *  or the drawn-back kicking thigh whenever the aim swung a few degrees away from the camera. */
  takerPhi: 38,
  /** [QF-4] Penalties and shoot-out kicks: the aim can swing +-15 deg off the spot-to-goal line (a corner from 11 m), so
   *  the view sits further round (deg) to keep the charged backswing off the ball for either corner. */
  penaltyPhi: 46,
  /** [QF-4] Free kicks / penalties: the view centres the angular span of the ball and both goal posts, which must fit a
   *  4:3 screen (the narrowest supported) with this margin each side (deg); a wider span widens the FOV up to
   *  takerFovMax (deg). */
  takerSideMarginDeg: 4,
  takerFovMax: 50,
  /** [QF-4] ... while the ball stays within this horizontal NDC of the screen centre at 4:3 (x 0.38..0.62): further
   *  out it sat over the touch buttons / stick zone at the bottom corners. */
  takerBallNdc: 0.24,
  /** [QF-4] Spots within this |z| of the pitch's long axis put the camera on the near (broadcast, +z) side; wider spots
   *  put it on the side of the aim line facing the axis (crosses from wide positions turn toward that side). m. */
  centralZ: 4,
  /** [QF-4] A player closer than this to the behind-the-taker camera (m, horizontal) fills the frame: the shot takes the
   *  other side of the ball when a player is not as close there. */
  nearClear: 3.5,
  /** Ball height on screen (fraction from the top) the pitch is solved for. INT-C: 0.74 -> 0.68, so the taker standing
   *  behind the ball (lower on screen) stays above the HUD radar at the bottom centre. */
  takerBallY: 0.68,
  /** The crossbar stays at least this fraction below the top edge. */
  takerTopMargin: 0.12,
  // ---- goal kicks (raised, behind the taker, looking up-field)
  /** [QF-4] Distance from the ball m (around the ball by goalKickPhi toward the touchline: over the goal-line area
   *  beside the goal, whose frame stays out of view), height m, vertical FOV deg. The INT-C rig
   *  (5 m back, 3.4 m up) still had the keeper filling 38% of the screen height and covering the ball. */
  goalKickBack: 9,
  goalKickHeight: 5,
  goalKickFov: 48,
  goalKickBallY: 0.76,
  goalKickPhi: 35,
  /** Point on the kick line (m ahead of the ball) kept at least goalKickTopMargin below the top edge. */
  goalKickLook: 40,
  goalKickTopMargin: 0.18,
  /** [QF-4] Widest goal-kick FOV (deg) when the far kick-line point needs it (see takerBallNdc). */
  goalKickFovMax: 62,
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
  /** [QF-4] The camera turns this far (deg) around the corner spot from the penalty-spot line toward the goal-line side:
   *  the taker lines up on the penalty-spot line (the default aim), which hid the ball behind his legs; aims toward the
   *  goal mouth move him further from the view line (with the model's set-piece stance). */
  cornerPhi: 25,
  /** [QF-4] Share of the angle between the ball and the look target the view turns toward the target. */
  cornerLookMix: 0.8,
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
  /**
   * [QF-4] The restart is set up (match.restart.ready): RUL-11 moved every player still out of position onto a legal
   * spot in that tick (D-008, up to 60 m for a taker). Set-piece shots start then, so their cut hides those
   * teleports; until then the main camera shows the set-up. Omitted = ready.
   */
  ready?: boolean;
  /**
   * [QF-4] Shoot-out between kicks (RUL-07 RESULT, or a kick in FLIGHT that left the behind view): the main camera shows
   * the outcome. RUL-07 teleports the next kicker onto the spot, the last one back into the centre circle and swaps the
   * keepers at the next kick's SETUP; the cut back into the behind view on that very frame hides it (before, the static
   * behind view showed every swap). Omitted = no.
   */
  shootoutResult?: boolean;
}

class Input implements DirectorInput {
  phase: number = MatchPhase.IN_PLAY;
  goalDist = 100.5;
  replayPlaying = false;
  replayAngle: ReplayAngle = ReplayAngle.SIDE;
  establishing = false;
  skipped = false;
  holdShot = false;
  ready = true;
  shootoutResult = false;
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
    case MatchPhase.SHOOT_OUT:
      return i.shootoutResult === true ? CineShot.NONE : CineShot.BEHIND_TAKER;
    case MatchPhase.GOAL_KICK:
    case MatchPhase.PENALTY:
      return i.ready === false ? CineShot.NONE : CineShot.BEHIND_TAKER;
    case MatchPhase.FREE_KICK:
      return i.ready !== false && i.goalDist <= LT.fkNearGoal ? CineShot.BEHIND_TAKER : CineShot.NONE;
    case MatchPhase.CORNER:
      return i.ready === false ? CineShot.NONE : CineShot.CORNER;
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
  let ux = aimX - spotX, uz = aimZ - spotZ;
  const l = Math.sqrt(ux * ux + uz * uz);
  if (l > 1e-3) { ux /= l; uz /= l; } else { ux = spotX > 0 ? -1 : 1; uz = 0; }
  // [QF-4] Around the ball by phi from straight behind it, on the side of the aim line facing the pitch's long axis
  // (central spots: the near side): the waiting taker, 0.6 m behind the ball on the aim line, no longer hides it.
  // Goal kicks take the touchline side instead: toward the axis the camera hung over the own goal and its crossbar
  // came into view. Side +1 uses the normal n = (-uz, ux), whose z is ux.
  let side = spotZ < LT.centralZ && spotZ > -LT.centralZ ? (ux >= 0 ? 1 : -1) : (ux * -spotZ > 0 ? 1 : -1);
  // [QF-4] Free kicks / penalties: the taker's kicking-foot side (PIN[5], +1 = right of the aim line) when known. On the
  // support-foot side his planted shin hid the ball through the whole charged backswing (~0.35 s for the CPU, as long as
  // the power bar is held for a human): 24 of 102 penalty frames for a right-footer attacking -x.
  if (!goalKick && (PIN[5] === 1 || PIN[5] === -1)) side = PIN[5]! > 0 ? 1 : -1;
  if (goalKick) side = -side;
  if (PIN[4] === -1) side = -side; // the other side (a player stood where the camera would be)
  // Angle round from straight behind (deg in PIN[6], set by the caller: goalKickPhi / takerPhi / penaltyPhi; a branch on
  // it here made V8 box the doubles of the whole solver).
  const phi = PIN[6]! * DEG;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = -cp * ux - sp * uz * side, dz = -cp * uz + sp * ux * side;
  const back = goalKick ? LT.goalKickBack : LT.takerBack;
  const cx = Math.max(-LT.maxX, Math.min(LT.maxX, spotX + dx * back));
  const cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, spotZ + dz * back));
  const cy = goalKick ? LT.goalKickHeight : LT.takerHeight;
  // Look point: the goal (free kick, penalty) or goalKickLook ahead on the kick line (goal kick); the view turns part of
  // the way from the ball toward it so ball, taker and goal (or the far kick line) share the frame.
  const lx = goalKick ? spotX + ux * LT.goalKickLook : aimX;
  const lz = goalKick ? spotZ + uz * LT.goalKickLook : aimZ;
  out.x = cx; out.y = cy; out.z = cz;
  const yawBall = Math.atan2(-(spotX - cx), -(spotZ - cz));
  let tanHalf = goalKick ? T_GOAL_KICK : T_TAKER;
  // [QF-4] Must-see points (both posts; goal kicks: the far kick-line point and the centre spot) as angles from the ball's direction; the
  // view centres their span with the ball, keeps the ball within takerBallNdc of the centre at 4:3 (clear of the touch
  // controls in the bottom corners) and widens the FOV until the span fits a 4:3 screen.
  let lo = 0, hi = 0;
  for (let k = -1; k <= 1; k += 2) {
    const px = goalKick ? (k < 0 ? lx : 0) : aimX, pz = goalKick ? (k < 0 ? lz : 0) : aimZ + k * GOAL_HALF_WIDTH;
    let d = Math.atan2(-(px - cx), -(pz - cz)) - yawBall;
    d -= TWO_PI * Math.floor((d + Math.PI) / TWO_PI);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const margin = LT.takerSideMarginDeg * DEG;
  const tanMax = Math.tan((goalKick ? LT.goalKickFovMax : LT.takerFovMax) * DEG * 0.5);
  let c = (lo + hi) * 0.5;
  for (let it = 0; it < 4; it++) {
    const cMax = Math.atan(LT.takerBallNdc * tanHalf * (4 / 3));
    c = Math.max(-cMax, Math.min(cMax, (lo + hi) * 0.5));
    const half = Math.max(hi - c, c - lo) + margin;
    const need = half < 1.5 ? Math.tan(half) * (3 / 4) : tanMax;
    if (!(need > tanHalf)) break;
    tanHalf = Math.min(need, tanMax);
  }
  const yaw = yawBall + c;
  out.fov = (2 * Math.atan(tanHalf)) / DEG;
  out.yaw = yaw;
  // Pitch from the depth along the view (screen height depends on height over forward distance).
  const sy = Math.sin(yaw), cyw = Math.cos(yaw);
  const fB = -sy * (spotX - cx) - cyw * (spotZ - cz);
  const thetaBall = Math.atan2(cy - BALL_RADIUS, Math.max(0.5, fB));
  const ballY = goalKick ? LT.goalKickBallY : LT.takerBallY;
  let pitch = thetaBall - Math.atan((2 * ballY - 1) * tanHalf);
  // Keep the top of the goal (or the far point of the kick line) in view.
  const fL = -sy * (lx - cx) - cyw * (lz - cz);
  const thetaTop = Math.atan2(cy - (goalKick ? 0 : GOAL_HEIGHT), Math.max(0.5, fL));
  const topY = goalKick ? LT.goalKickTopMargin : LT.takerTopMargin;
  const maxPitch = thetaTop - Math.atan((2 * topY - 1) * tanHalf);
  if (pitch > maxPitch) pitch = maxPitch;
  out.pitch = pitch;
}

/**
 * Behind-the-taker pose for a ball at the spot aiming at (aimX, aimZ) (the attacked goal's centre for free kicks and
 * penalties). goalKick: the low, wide rig in front of the own goal looking up-field along the aim. footSide (free kicks,
 * penalties): +1 right-footed taker, -1 left-footed (the camera takes that side of the aim line), 0 unknown. phiDeg:
 * the angle round from straight behind (0 = LOCAL_TUNING.takerPhi / goalKickPhi; penalties use penaltyPhi). Pure;
 * writes out.
 */
export function takerPose(spotX: number, spotZ: number, aimX: number, aimZ: number, goalKick: boolean, out: CinePose, otherSide = false, footSide = 0, phiDeg = 0): CinePose {
  PIN[0] = spotX; PIN[1] = spotZ; PIN[2] = aimX; PIN[3] = aimZ; PIN[4] = otherSide ? -1 : 1; PIN[5] = footSide;
  PIN[6] = goalKick ? LT.goalKickPhi : phiDeg > 0 ? phiDeg : LT.takerPhi;
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
  // [QF-4] Turn the "behind the flag" direction by cornerPhi toward the goal-line side (|x| grows): the taker lines up
  // on the penalty-spot line and no longer hides the ball.
  const phi = LT.cornerPhi * DEG;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  // Rotation by +phi maps (dx, dz) to (dx cp - dz sp, dx sp + dz cp); pick the sign whose x moves toward the end.
  const sgn = (-dz * end) > 0 ? 1 : -1;
  const rx = dx * cp - dz * sp * sgn, rz = dx * sp * sgn + dz * cp;
  const cx = Math.max(-LT.maxX, Math.min(LT.maxX, cornerX + rx * LT.cornerBack));
  const cz = Math.max(-LT.maxZ, Math.min(LT.maxZ, cornerZ + rz * LT.cornerBack));
  const cy = LT.cornerHeight;
  out.x = cx; out.y = cy; out.z = cz; out.fov = LT.cornerFov;
  const yawBall = Math.atan2(-(cornerX - cx), -(cornerZ - cz));
  let d = Math.atan2(-(tx - cx), -(tz - cz)) - yawBall;
  d -= TWO_PI * Math.floor((d + Math.PI) / TWO_PI);
  const yaw = yawBall + d * LT.cornerLookMix;
  out.yaw = yaw;
  const fB = -Math.sin(yaw) * (cornerX - cx) - Math.cos(yaw) * (cornerZ - cz);
  const thetaBall = Math.atan2(cy - BALL_RADIUS, Math.max(0.5, fB));
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

/**
 * poseNdc inputs: world point x, y, z, the screen aspect (w / h), then the pose x, y, z, yaw, pitch, fov (deg); the hold
 * check's ball x, y, z, vx, vy, vz at 10..15. Output NDC = [ndcX, ndcY (+ up), view depth m]. Typed arrays only: a
 * double crossing a call boundary can box.
 */
const HIN = new Float64Array(16);
const NDC = new Float64Array(3);

/** The pose into HIN[4..9]. */
function poseToHin(p: Readonly<CinePose>): void {
  HIN[4] = p.x; HIN[5] = p.y; HIN[6] = p.z; HIN[7] = p.yaw; HIN[8] = p.pitch; HIN[9] = p.fov;
}

/**
 * [QF-4] NDC of the world point HIN[0..2] seen from the pose in HIN[4..9] at aspect HIN[3] (the camera this module writes:
 * YXZ Euler (-pitch, yaw, 0), symmetric frustum), into NDC; a point closer than 1 cm along the view gets NDC 9.5.
 */
function poseNdcIn(): void {
  const dx = HIN[0]! - HIN[4]!, dy = HIN[1]! - HIN[5]!, dz = HIN[2]! - HIN[6]!;
  const sy = Math.sin(HIN[7]!), cy = Math.cos(HIN[7]!), sp = Math.sin(HIN[8]!), cp = Math.cos(HIN[8]!);
  // forward (-cp sy, -sp, -cp cy), right (cy, 0, -sy), up (-sp sy, cp, -sp cy)
  const depth = -cp * sy * dx - sp * dy - cp * cy * dz;
  const rx = cy * dx - sy * dz;
  const uy = -sp * sy * dx + cp * dy - sp * cy * dz;
  const t = Math.tan(HIN[9]! * DEG * 0.5);
  NDC[2] = depth;
  NDC[0] = 9.5;
  NDC[1] = 9.5;
  if (depth > 0.01) {
    NDC[0] = rx / (depth * t * HIN[3]!);
    NDC[1] = uy / (depth * t);
  }
}

/** NDC of a world point through a pose (tests, tools). Pure; writes out = [ndcX, ndcY (+ up), depth]. */
export function poseNdc(p: Readonly<CinePose>, x: number, y: number, z: number, aspect: number, out: number[]): number[] {
  HIN[0] = x; HIN[1] = y; HIN[2] = z; HIN[3] = aspect;
  poseToHin(p);
  poseNdcIn();
  out[0] = NDC[0]!; out[1] = NDC[1]!; out[2] = NDC[2]!;
  return out;
}

/** True when the NDC point lies inside the held view's safe region (LOCAL_TUNING.holdTopMargin / holdSideMargin). */
function ndcInHoldView(): boolean {
  const nx = NDC[0]!, ny = NDC[1]!;
  return NDC[2]! > 0.5 && ny <= 1 - 2 * LT.holdTopMargin && ny >= -1 && nx <= 1 - 2 * LT.holdSideMargin
    && nx >= -1 + 2 * LT.holdSideMargin;
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
  /** [QF-4] The current set piece is a penalty or a shoot-out kick (LOCAL_TUNING.penaltyPhi). */
  let penaltyShot = false;
  let orbitDir = 1;
  /** 0 none, 1 kick-off, 2 full time. */
  let estKind = 0;
  let skippedPhase = -1;
  let holdArmed = false;
  /** [QF-4] A shoot-out kick in flight left the behind view: the main camera until the next kick's SETUP. */
  let soLost = false;
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
  /** [QF-4] The restart was set up on the previous frame (DirectorInput.ready); its edge forces a cut. */
  let wasReady = true;
  /** [QF-4] The frame being drawn (players for the near-camera check); the alternative set-piece pose. */
  let curFrame: RenderFrame | null = null;
  const alt = createCinePose();

  /** [QF-4] Kicking-foot side of the restart taker of the frame being drawn: +1 right-footed, -1 left, 0 unknown. */
  function takerFootSide(): number {
    const f = curFrame;
    if (!f) return 0;
    const t = f.curr.match.restart.taker;
    if (!(t >= 0 && t < NUM_SLOTS) || f.curr.players[t]!.active !== 1) return 0;
    return f.curr.attrs[t]!.foot === 1 ? -1 : 1;
  }

  /**
   * [QF-4] The struck free kick / penalty would leave the held behind view: the ball (interpolated) or, while it rises,
   * its predicted apex (drag-corrected height as GFX-14 predicts it, reached after vy / g; the horizontal travel to it
   * shortened by drag the same way) outside the safe region of the pose drawn last.
   */
  function holdLosesBall(f: RenderFrame): boolean {
    const it = f.interp, b = f.curr.ball;
    HIN[10] = it.ballX; HIN[11] = it.ballY; HIN[12] = it.ballZ;
    HIN[13] = b.vx; HIN[14] = b.vy; HIN[15] = b.vz;
    poseToHin(last);
    return holdLosesBallIn();
  }

  /** holdLosesBall on HIN: ball at 10..12, velocity at 13..15, pose at 4..9 (warm-up runs it on scratch data). */
  function holdLosesBallIn(): boolean {
    HIN[3] = Math.max(1, ctx.size.cssW) / Math.max(1, ctx.size.cssH);
    HIN[0] = HIN[10]!; HIN[1] = HIN[11]!; HIN[2] = HIN[12]!;
    poseNdcIn();
    if (!ndcInHoldView()) return true;
    const vy = HIN[14]!;
    if (!(vy > 0.5)) return false;
    const k = T_BALL.dragK;
    const rise = Math.log(1 + (k * vy * vy) / T_BALL.gravity) / (2 * k);
    const tApex = vy / T_BALL.gravity;
    HIN[0] = HIN[10]! + HIN[13]! * tApex * 0.8;
    HIN[1] = HIN[11]! + rise;
    HIN[2] = HIN[12]! + HIN[15]! * tApex * 0.8;
    poseNdcIn();
    return !ndcInHoldView();
  }

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
    // [QF-7R] Field writes, not position.set / euler.set (see EulerFields: no double crosses a call).
    const cp = cam.position;
    cp.x = p.x; cp.y = p.y; cp.z = p.z;
    const e = euler as unknown as EulerFields;
    e._x = -p.pitch; e._y = p.yaw; e._z = 0;
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
      penaltyShot = true;
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
    penaltyShot = phase === MatchPhase.PENALTY;
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
      case CineShot.BEHIND_TAKER: {
        if (targetFresh) return; // static shot: solved once per shot (transition / new spot)
        const foot = takerFootSide();
        const phiDeg = goalKick ? LT.goalKickPhi : penaltyShot ? LT.penaltyPhi : LT.takerPhi;
        PIN[0] = S[S_SPOT_X]!; PIN[1] = S[S_SPOT_Z]!; PIN[2] = S[S_AIM_X]!; PIN[3] = S[S_AIM_Z]!; PIN[4] = 1; PIN[5] = foot;
        PIN[6] = phiDeg;
        takerPoseIn(goalKick, target);
        // [QF-4] A player standing where the camera would be fills the frame: take the other side when it is clearer.
        // [QF-7R] nearestPlayer written out (twice): solved once per shot, a helper never leaves V8's baseline tier and
        // boxes every double of its loop.
        const fr = curFrame;
        let near = Infinity;
        if (fr) {
          const it = fr.interp, pl = fr.curr.players;
          let best = Infinity;
          for (let i = 0; i < NUM_SLOTS; i++) {
            if (pl[i]!.active !== 1) continue;
            const dx = it.x[i]! - target.x, dz = it.z[i]! - target.z;
            const d = dx * dx + dz * dz;
            if (d < best) best = d;
          }
          near = Math.sqrt(best);
        }
        if (near < LT.nearClear) {
          PIN[0] = S[S_SPOT_X]!; PIN[1] = S[S_SPOT_Z]!; PIN[2] = S[S_AIM_X]!; PIN[3] = S[S_AIM_Z]!; PIN[4] = -1; PIN[5] = foot;
          PIN[6] = phiDeg;
          takerPoseIn(goalKick, alt);
          let altNear = Infinity;
          if (fr) {
            const it = fr.interp, pl = fr.curr.players;
            let best = Infinity;
            for (let i = 0; i < NUM_SLOTS; i++) {
              if (pl[i]!.active !== 1) continue;
              const dx = it.x[i]! - alt.x, dz = it.z[i]! - alt.z;
              const d = dx * dx + dz * dz;
              if (d < best) best = d;
            }
            altNear = Math.sqrt(best);
          }
          if (altNear > near) copyPose(alt, target);
        }
        break;
      }
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
   * [FIN-P] `state` is the live match state (only read): holdLosesBall, which reads the interpolated ball and the
   * state's ball velocity, is warmed on it too, so its object reads have the live objects' feedback (shapes). Before,
   * only holdLosesBallIn was warmed and holdLosesBall itself first ran during a free kick's shot hold in play, unoptimised:
   * a heap number per field read on every frame of the hold (tests/perf/fin-p-cine-hold-alloc.test.ts).
   */
  function warmUpPaths(state: ReadonlySimState): void {
    const a = createCinePose(), b = createCinePose(), c = createCinePose();
    const f: RenderFrame = {
      prev: state, curr: state, alpha: 1,
      frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
    };
    for (let i = 0; i < LT.warmUpIterations; i++) {
      const u = (i % 100) * 0.01;
      // Spots out to the penalty spot and beyond, so every FOV-widening path of the solver is warm.
      PIN[0] = 20 + u * 28; PIN[1] = u * 20 - 10; PIN[2] = HALF_LENGTH; PIN[3] = 0; PIN[4] = (i & 8) === 0 ? 1 : -1;
      PIN[5] = (i % 3) - 1;
      PIN[6] = (i & 1) === 0 ? LT.goalKickPhi : (i & 4) === 0 ? LT.takerPhi : LT.penaltyPhi;
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
      // The shot-hold check: a behind-the-taker pose, balls in view, above it, behind the camera, rising or not.
      PIN[0] = 27 + u * 14; PIN[1] = u * 8 - 4; PIN[2] = HALF_LENGTH; PIN[3] = 0; PIN[4] = 1; PIN[5] = 1; PIN[6] = LT.takerPhi;
      takerPoseIn(false, c);
      poseToHin(c);
      HIN[10] = PIN[0]! + ((i % 7) - 1) * 4; HIN[11] = 0.11 + (i % 5) * 1.5; HIN[12] = PIN[1]!;
      HIN[13] = 10 + u * 12; HIN[14] = (i % 4) * 4 - 1; HIN[15] = u - 0.5;
      if (holdLosesBallIn()) S[0] = NDC[0]!;
    }
    // ... and through holdLosesBall on the live state's ball (velocity only read) and the pose drawn last, in a loop of
    // its own: called from the big loop above it was inlined there once that loop was optimised (on-stack), so it never
    // reached optimised code of its own (tests/perf/fin-p-cine-hold-alloc.test.ts).
    for (let i = 0; i < LT.warmUpIterations; i++) {
      const u = (i % 100) * 0.01;
      f.interp.ballX = 27 + u * 14; f.interp.ballY = 0.11 + (i % 5) * 1.5; f.interp.ballZ = u * 8 - 4;
      if (holdLosesBall(f)) S[0] = NDC[1]!;
    }
    S.fill(0);
  }

  function isReplay(sh: CineShot): boolean {
    return sh === CineShot.REPLAY_SIDE || sh === CineShot.REPLAY_GOAL;
  }

  /** Switch to a new shot: cut, or blend when the move is small (never with reduced motion or around replays). */
  function transition(next: CineShot, f: RenderFrame, forceCut: boolean): void {
    if (active) copyPose(last, from);
    else readCamera(from);
    const prevShot = shot;
    shot = next;
    targetFresh = false;
    S[S_SHOT_T] = 0;
    if (isReplay(next)) stepLook(f, true);
    computeTarget();
    const mayBlend = !forceCut && !reduced && T_CAMERA.blendTime > 0 && !isReplay(next) && !isReplay(prevShot)
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
    curFrame = f;
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
      if (s.ball.shotBy < 0 || S[S_HOLD_T]! > LT.shotHold || (active && holdLosesBall(f))) holdArmed = false;
    } else holdArmed = false;
    // Decision.
    input.phase = phase;
    input.goalDist = S[S_GOAL_DIST]!;
    input.replayPlaying = link.playing;
    input.replayAngle = link.angle;
    input.establishing = estKind !== 0;
    input.skipped = skippedPhase === phase;
    input.holdShot = holdArmed && phase === MatchPhase.IN_PLAY;
    input.ready = !isSetPiecePhase(phase) || phase === MatchPhase.SHOOT_OUT || s.match.restart.ready === 1;
    // Shoot-out: the main camera for the RESULT, and from the frame a kick in FLIGHT would leave the behind view (a
    // skied or deflected kick; latched until the next kick's SETUP), as for the free-kick / penalty shot hold.
    const soSub = phase === MatchPhase.SHOOT_OUT ? s.match.shootout.sub : -1;
    if (soSub !== ShootoutSub.FLIGHT && soSub !== ShootoutSub.RESULT) soLost = false;
    else if (soSub === ShootoutSub.FLIGHT && !soLost && active && shot === CineShot.BEHIND_TAKER && holdLosesBall(f)) soLost = true;
    input.shootoutResult = soSub === ShootoutSub.RESULT || soLost;
    const next = chooseShot(input);
    const readyNow = input.ready === true;
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
      // The set-up tick teleports players (D-008): entering a set-piece shot then is always a cut. So is entering the
      // shoot-out's behind view (the first kick, or the next kick's SETUP after the RESULT on the main camera: RUL-07
      // places the kicker, the last kicker and both keepers in that tick).
      transition(next, f, (input.ready === true && !wasReady) || (phase === MatchPhase.SHOOT_OUT && next === CineShot.BEHIND_TAKER));
    } else {
      S[S_SHOT_T] = S[S_SHOT_T]! + dt;
      if (isReplay(shot)) stepLook(f, false);
    }
    wasReady = readyNow;
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
      warmUpPaths(state);
      targetFresh = false;
      matchOn = true;
      shot = CineShot.NONE;
      active = false;
      blending = false;
      estKind = 0;
      skippedPhase = -1;
      holdArmed = false;
      soLost = false;
      lastPhase = state.match.phase;
      keyCuts = link.cuts;
      wasReady = true;
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

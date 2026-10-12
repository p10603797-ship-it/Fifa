/**
 * [SIM-01] Ball flight: gravity, quadratic air drag, Magnus force from spin (curl, dip, backspin float),
 * spin decay; trajectory prediction and launch solvers used by passes, shots, keepers and AI.
 * Section 6 "Ball". Reference feel: ground pass 9-22 m/s; a 15 m/s pass rolls ~30 m; hard shot 25-36 m/s;
 * goal kick carries 45-60 m; bounce height roughly halves each bounce. Constants: T_BALL.
 *
 * Forces on an airborne ball (world axes, SI units):
 *   a = (0, -gravity, 0) - dragK * |v| * v + magnusK * (spin x v)
 * Integrated with the explicit midpoint method (RK2): exact for the gravity parabola, second order for drag and
 * Magnus, stable for every substep length SIM-02 uses (dragK * |v| * dt < 0.01). Spin decays as
 * exp(-spinDecayAir * t) (second-order factor per substep; Magnus uses the half-step spin).
 *
 * SPIN CONVENTION (shared with SIM-09 crosses, SIM-11 shots, GKP, render). Spin is an angular velocity in rad/s on
 * world axes, right-hand rule:
 *  - CURL = sy (about +y). Magnus gives a_side = magnusK * sy * |v_h| toward the LEFT of the horizontal travel
 *    direction (left = the -90 degree side in the dmath/vec angle convention, where a positive angle turns toward
 *    +z = the right when facing +x). So POSITIVE sy CURLS LEFT, NEGATIVE sy CURLS RIGHT. Example: vx > 0, sy > 0
 *    bends toward -z (away from the broadcast camera). Use `curlSpinY(rightward)` to avoid sign slips.
 *  - BACKSPIN about the horizontal axis (-dirZ, 0, dirX) for travel direction (dirX, dirZ) gives lift (+y):
 *    a chip with backspin floats, negative backspin (topspin) dips. `launchSpin()` builds the world vector.
 *
 * predictBall / ticksToHeight copy the ball into module scratch and run SIM-02 ballStepTick(scratch, null), so a
 * prediction is the sim bit-for-bit for a free ball. solveLaunch / solveLaunchSpin integrate the air phase only
 * with ballAirStep (fixed step, fixed max iterations, deterministic). Everything is allocation-free.
 */
import { BALL_RADIUS, DT } from '../../contracts/constants';
import { T_BALL } from '../../contracts/tuning';
import { createBallState, type BallState } from '../../contracts/state';
import { MAX_PREDICT_TICKS, type BallPrediction } from '../../contracts/systems';
import { dcos, dlog, dsin } from '../core/dmath';
import type { V3 } from '../core/vec';
import { ballStepTick } from './contact';

const LOCAL_TUNING = {
  /**
   * Quadratic drag coefficient actually used, 1/m (a = -dragK * |v| * v). Replaces T_BALL.dragK (0.0133, Cd 0.25)
   * with Cd ~0.14 (post drag-crisis regime of a modern ball at 15-35 m/s): a 30 m/s goal kick at T_PASS.lobAngle
   * then carries ~60 m (reference feel: 45-60 m reachable at <= 30 m/s; 0.0133 tops out at ~50 m).
   */
  dragK: 0.0075,
  /**
   * Magnus coefficient actually used, (m/s^2) per (rad/s * m/s). Replaces T_BALL.magnusK (0.0042), which bends a
   * 9 rad/s, 25 m free kick only ~0.5 m; 0.025 bends it ~2.5-3 m (reference feel 2-4 m) and makes a 12 rad/s
   * backspin chip float.
   */
  magnusK: 0.025,
  /** predictBall landIndex threshold: ball-centre height (m) that counts as "landed" when descending. */
  landHeight: 0.5,
  /** ticksToHeight horizon (ticks). */
  ticksToHeightCap: 300,
  /** solveLaunch elevation clamp (rad): a lofted ball needs some loft; >= ~83 degrees is nonsense. */
  launchAngleMin: 0.02,
  launchAngleMax: 1.45,
} as const; // TUNING-CR

/** Magnus coefficient used by ballAirStep (see LOCAL_TUNING.magnusK). */
export const MAGNUS_K = LOCAL_TUNING.magnusK;
/** Drag coefficient used by ballAirStep (see LOCAL_TUNING.dragK). */
export const DRAG_K = LOCAL_TUNING.dragK;
/** Landing threshold used by predictBall (ball-centre height, m). */
export const LAND_HEIGHT = LOCAL_TUNING.landHeight;
/** Hot-loop copies of imported tuning (module-level: no import-binding lookups per substep). */
const GRAVITY = T_BALL.gravity;
const SPIN_DECAY_AIR = T_BALL.spinDecayAir;

// ---------------------------------------------------------------- air physics

/** Integrate an AIRBORNE ball by dt seconds (forces + spin decay). No collisions (SIM-02 does those). */
export function ballAirStep(b: BallState, dt: number): void {
  const k = DRAG_K;
  const m = MAGNUS_K;
  const g = GRAVITY;
  // Spin decay: second-order exp(-spinDecayAir * dt) (clamped >= 0); Magnus uses the half-step spin.
  const kd = SPIN_DECAY_AIR * dt;
  let fh = 1 - 0.5 * kd + 0.125 * kd * kd;
  let f = 1 - kd + 0.5 * kd * kd;
  if (kd >= 1) { f = 0; fh = 0; }
  const sx = b.sx;
  const sy = b.sy;
  const sz = b.sz;
  const vx = b.vx;
  const vy = b.vy;
  const vz = b.vz;
  // Acceleration at the start of the step.
  let sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let ax = -k * sp * vx + m * (sy * vz - sz * vy);
  let ay = -g - k * sp * vy + m * (sz * vx - sx * vz);
  let az = -k * sp * vz + m * (sx * vy - sy * vx);
  // Midpoint velocity and spin.
  const h = 0.5 * dt;
  const mx = vx + ax * h;
  const my = vy + ay * h;
  const mz = vz + az * h;
  const msx = sx * fh;
  const msy = sy * fh;
  const msz = sz * fh;
  // Acceleration at the midpoint.
  sp = Math.sqrt(mx * mx + my * my + mz * mz);
  ax = -k * sp * mx + m * (msy * mz - msz * my);
  ay = -g - k * sp * my + m * (msz * mx - msx * mz);
  az = -k * sp * mz + m * (msx * my - msy * mx);
  b.x += mx * dt;
  b.y += my * dt;
  b.z += mz * dt;
  b.vx = vx + ax * dt;
  b.vy = vy + ay * dt;
  b.vz = vz + az * dt;
  b.sx = sx * f;
  b.sy = sy * f;
  b.sz = sz * f;
}

/**
 * Curl spin (sy) that bends the ball toward the RIGHT of its travel direction by `rightward` rad/s of spin
 * (negative = toward the left). Right = the +angle side in the dmath/vec convention (facing +x, right is +z).
 */
export function curlSpinY(rightward: number): number {
  return 0 - rightward; // 0 - x: never -0
}

/**
 * World spin vector for a ball travelling along horizontal direction (dirX, dirZ) (need not be unit) with
 * `curl` = sy (positive curls LEFT, see header) and `backspin` rad/s (positive = backspin/lift, negative =
 * topspin/dip). Writes into out and returns it.
 */
export function launchSpin(dirX: number, dirZ: number, curl: number, backspin: number, out: V3): V3 {
  const l = Math.sqrt(dirX * dirX + dirZ * dirZ);
  let ux = 1;
  let uz = 0;
  if (l > 0) { ux = dirX / l; uz = dirZ / l; }
  out.x = 0 - uz * backspin; // 0 - x: never -0
  out.y = curl;
  out.z = ux * backspin + 0;
  return out;
}

// ---------------------------------------------------------------- ball copy + prediction

/** Copy every field of src into dst (allocation-free). */
export function copyBallState(dst: BallState, src: Readonly<BallState>): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.sx = src.sx; dst.sy = src.sy; dst.sz = src.sz;
  dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.grounded = src.grounded;
  dst.bounces = src.bounces;
  dst.owner = src.owner;
  dst.ownerT = src.ownerT;
  dst.heldBy = src.heldBy;
  dst.lastTouch = src.lastTouch;
  dst.lastTouchTeam = src.lastTouchTeam;
  dst.lastTouchTick = src.lastTouchTick;
  dst.touchedTick = src.touchedTick;
  dst.lastKickBy = src.lastKickBy;
  dst.lastKickTeam = src.lastKickTeam;
  dst.lastKickKind = src.lastKickKind;
  dst.lastKickTick = src.lastKickTick;
  dst.passTarget = src.passTarget;
  dst.passX = src.passX;
  dst.passZ = src.passZ;
  dst.shotBy = src.shotBy;
  dst.shotTick = src.shotTick;
  dst.shotOnTarget = src.shotOnTarget;
  dst.inNet = src.inNet;
  dst.idleT = src.idleT;
  dst.cross = src.cross;
  dst.crossX = src.crossX;
  dst.crossZ = src.crossZ;
  dst.crossEnd = src.crossEnd;
}

/** Scratch ball for predictBall (module-level: no allocation per call). */
const PRED = createBallState();
/** Scratch ball for ticksToHeight. */
const TTH = createBallState();

/**
 * Predict the ball path for `ticks` ticks (<= MAX_PREDICT_TICKS) using the same physics as the sim
 * (SIM-02 ballStepTick with no events, on a module scratch copy), without touching `b`. Fills out.x/y/z and out.landIndex
 * (first sample at or below 0.5 m while descending after being above it; -1 none).
 * A ball held in a keeper's hands (heldBy >= 0) is not integrated by the sim: every sample is its position.
 */
export function predictBall(b: Readonly<BallState>, ticks: number, out: BallPrediction): void {
  let n = Math.floor(ticks);
  if (!(n > 0)) n = 0;
  if (n > MAX_PREDICT_TICKS) n = MAX_PREDICT_TICKS;
  out.count = n;
  out.landIndex = -1;
  copyBallState(PRED, b);
  const held = b.heldBy >= 0;
  const thr = LAND_HEIGHT;
  let above = b.y > thr;
  const ox = out.x;
  const oy = out.y;
  const oz = out.z;
  for (let i = 0; i < n; i++) {
    if (!held) ballStepTick(PRED, null);
    const y = PRED.y;
    ox[i] = PRED.x;
    oy[i] = y;
    oz[i] = PRED.z;
    if (y > thr) above = true;
    else if (above && out.landIndex < 0) out.landIndex = i;
  }
}

/**
 * Ticks until an airborne ball descends to height h (or -1 if it never does within 300 ticks).
 * Returns 0 when the ball is already at or below h and not rising. Otherwise the first tick k (1..300) after
 * which the ball centre is at or below h and descending (lower than the tick before, or vy <= 0). Same physics as
 * the sim (SIM-02 ballStepTick on a scratch copy). A held ball (heldBy >= 0) does not move: 0 or -1.
 */
export function ticksToHeight(b: Readonly<BallState>, h: number): number {
  if (b.y <= h && b.vy <= 0) return 0;
  if (b.heldBy >= 0 || !(h >= BALL_RADIUS)) return -1;
  copyBallState(TTH, b);
  let prevY = TTH.y;
  const cap = LOCAL_TUNING.ticksToHeightCap;
  for (let k = 1; k <= cap; k++) {
    ballStepTick(TTH, null);
    const y = TTH.y;
    if (y <= h && (y < prevY || TTH.vy <= 0)) return k;
    prevY = y;
  }
  return -1;
}

// ---------------------------------------------------------------- ground passes

/** Newton iterations for the roll-model inversions (quadratic convergence; 8 is far more than needed). */
const ROLL_NEWTON_ITERS = 8;
/** Newton iterations for groundRollTime (starts far from the root, monotone; 16 reaches double precision). */
const ROLL_TIME_ITERS = 16;

/**
 * Launch speed for a ground pass that arrives at `dist` metres with roughly `arriveSpeed` m/s.
 * Roll model (SIM-02): dv/dt = -rollDecel - rollDamping * v, so the distance covered while slowing from v0 to v is
 *   x(v0, v) = (v0 - v) / c - (a / c^2) * ln((a + c*v0) / (a + c*v))   (a = rollDecel, c = rollDamping),
 * inverted for v0 by Newton (x is convex and increasing in v0). Result in [arriveSpeed, T_BALL.maxSpeed]; the
 * pass-type speed range (T_PASS.groundMin..groundMax) is the caller's choice.
 */
export function groundPassSpeed(dist: number, arriveSpeed: number): number {
  const a = T_BALL.rollDecel;
  const c = T_BALL.rollDamping;
  const vmax = T_BALL.maxSpeed;
  const v = arriveSpeed > 0 ? (arriveSpeed < vmax ? arriveSpeed : vmax) : 0;
  const d = dist > 0 ? dist : 0;
  if (!(d > 0)) return v;
  let v0 = Math.sqrt(v * v + 2 * a * d);
  if (c > 0) {
    const icc = a / (c * c);
    const lnBase = a + c * v;
    // Out of range: even a maxSpeed launch has slowed to the arrival speed before dist.
    if (!(d < (vmax - v) / c - icc * dlog((a + c * vmax) / lnBase))) return vmax;
    for (let i = 0; i < ROLL_NEWTON_ITERS; i++) {
      const f = (v0 - v) / c - icc * dlog((a + c * v0) / lnBase) - d;
      const fp = v0 / (a + c * v0);
      if (!(fp > 0)) break;
      const nv = v0 - f / fp;
      const dv = nv - v0;
      v0 = nv > v ? nv : v;
      if (dv < 1e-12 && dv > -1e-12) break; // converged (deterministic early exit)
    }
  }
  if (!(v0 < vmax)) return vmax;
  return v0;
}

/**
 * Time (seconds) a ground ball launched at v0 m/s takes to roll `dist` metres under the SIM-02 roll model, or -1
 * if it stops first. Pairs with groundPassSpeed for lead / interception timing (SIM-10, TAI-09).
 */
export function groundRollTime(v0: number, dist: number): number {
  const a = T_BALL.rollDecel;
  const c = T_BALL.rollDamping;
  if (!(dist > 0)) return 0;
  if (!(v0 > 0)) return -1;
  if (!(c > 0)) {
    const disc = v0 * v0 - 2 * a * dist;
    if (disc < 0) return -1;
    return (v0 - Math.sqrt(disc)) / a;
  }
  const icc = a / (c * c);
  const top = a + c * v0;
  // Full stopping distance x(v0, 0).
  const stop = v0 / c - icc * dlog(top / a);
  if (dist > stop) return -1;
  // Solve g(v) = x(v0, v) - dist = 0 for the speed v at dist. g is decreasing and concave in v
  // (g' = -v / (a + c v)), so Newton from v = v0 (g < 0) converges monotonically from above.
  let v = v0;
  for (let i = 0; i < ROLL_TIME_ITERS; i++) {
    if (!(v > 0)) break;
    const den = a + c * v;
    const f = (v0 - v) / c - icc * dlog(top / den) - dist;
    let nv = v + f * den / v;
    if (nv < 0) nv = 0;
    if (nv > v0) nv = v0;
    const dv = nv - v;
    v = nv;
    if (dv < 1e-12 && dv > -1e-12) break; // converged (deterministic early exit)
  }
  return dlog(top / (a + c * v)) / c;
}

// ---------------------------------------------------------------- lofted launch solver

/** Result of solveLaunchSpin. */
export interface LaunchSolution {
  /** Launch velocity, m/s. */
  vx: number; vy: number; vz: number;
  /** World spin to give the ball (rad/s), from the requested curl/backspin and the solved direction. */
  sx: number; sy: number; sz: number;
  /** |v|, m/s. */
  speed: number;
  /** Air time until the first landing (s) and the landing offset reached by the solved launch (m). */
  flightT: number;
  landX: number; landZ: number;
  /** 1 if the landing is within the solver tolerance of the target, 0 if out of reach (speed capped). */
  reached: number;
}

export function createLaunchSolution(): LaunchSolution {
  return { vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, speed: 0, flightT: 0, landX: 0, landZ: 0, reached: 0 };
}

/** Solver integration step (s): one tick; the midpoint integrator keeps landing errors to a few cm. */
const SOLVE_DT = DT;
/** Max air time simulated per trial (s). */
const SOLVE_MAX_T = 10;
/** Max solver iterations (fixed upper bound; exits early once within tolerance). */
const SOLVE_MAX_ITERS = 12;
/** Landing tolerance (m). */
const SOLVE_TOL = 0.01;
/** Minimum trial speed (m/s). */
const SOLVE_MIN_SPEED = 0.1;

/** Scratch flight ball and the last landing [x, z, t] (module-level; a typed array so stores never box). */
const FLY = createBallState();
const LAND = new Float64Array(3);

/**
 * Fly the FLY scratch ball (the caller sets its position, velocity and spin; no double arguments, so nothing is
 * boxed) through the air until its centre first comes down to BALL_RADIUS (ground contact). Writes LAND = [x, z, t]
 * relative to the start (interpolated inside the last step). Returns false if still airborne after SOLVE_MAX_T.
 */
function flyToGround(): boolean {
  FLY.x = 0; FLY.z = 0;
  const ground = BALL_RADIUS;
  const steps = Math.ceil(SOLVE_MAX_T / SOLVE_DT);
  let t = 0;
  for (let i = 0; i < steps; i++) {
    const px = FLY.x;
    const py = FLY.y;
    const pz = FLY.z;
    ballAirStep(FLY, SOLVE_DT);
    t += SOLVE_DT;
    if (FLY.y <= ground && FLY.vy < 0) {
      const dy = py - FLY.y;
      let f = dy > 0 ? (py - ground) / dy : 1;
      if (f < 0) f = 0;
      else if (f > 1) f = 1;
      LAND[0] = px + (FLY.x - px) * f;
      LAND[1] = pz + (FLY.z - pz) * f;
      LAND[2] = t - SOLVE_DT * (1 - f);
      return true;
    }
  }
  LAND[0] = FLY.x;
  LAND[1] = FLY.z;
  LAND[2] = t;
  return false;
}

const SOL = createLaunchSolution();

/**
 * Velocity for a lofted ball that lands at horizontal offset (dx, dz) from the ball, launched at `angle`
 * radians above horizontal, including drag (iterative). Writes the velocity into out and returns its speed.
 * Launch from the ground (ball centre at BALL_RADIUS), no spin; the FIRST landing (ground contact) is the target.
 * Out of reach (needs more than T_BALL.maxSpeed): returns the max-speed launch toward the target.
 */
export function solveLaunch(dx: number, dz: number, angle: number, out: V3): number {
  solveLaunchSpin(dx, dz, angle, BALL_RADIUS, 0, 0, SOL);
  out.x = SOL.vx;
  out.y = SOL.vy;
  out.z = SOL.vz;
  return SOL.speed;
}

/**
 * solveLaunch with launch height and spin: ball centre starts at height y0 (m; BALL_RADIUS on the ground), with
 * `curl` = sy (rad/s, positive curls LEFT; see header) and `backspin` (rad/s about the horizontal axis
 * perpendicular to travel; positive floats, negative dips). Solves speed (secant) and, with curl, the aim azimuth so
 * that the FIRST landing is at (dx, dz). Writes velocity, the matching world spin, flight time and landing into
 * `out`; returns the speed. Deterministic: fixed iteration bound, no allocation.
 */
export function solveLaunchSpin(
  dx: number, dz: number, angle: number, y0: number, curl: number, backspin: number, out: LaunchSolution,
): number {
  const g = T_BALL.gravity;
  const vmax = T_BALL.maxSpeed;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const h0 = y0 > BALL_RADIUS ? y0 : BALL_RADIUS;
  out.vx = 0; out.vy = 0; out.vz = 0; out.sx = 0; out.sy = 0; out.sz = 0;
  out.speed = 0; out.flightT = 0; out.landX = 0; out.landZ = 0; out.reached = 0;
  if (!(dist < Infinity)) return 0; // NaN or infinite target
  const curlV = curl === curl && curl < Infinity && curl > -Infinity ? curl + 0 : 0;
  const backV = backspin === backspin && backspin < Infinity && backspin > -Infinity ? backspin + 0 : 0;
  let th = angle === angle ? angle : LOCAL_TUNING.launchAngleMin;
  if (th < LOCAL_TUNING.launchAngleMin) th = LOCAL_TUNING.launchAngleMin;
  if (th > LOCAL_TUNING.launchAngleMax) th = LOCAL_TUNING.launchAngleMax;
  const ct = dcos(th);
  const st = dsin(th);
  // Unit aim direction (any direction for a zero offset).
  let ux = 1;
  let uz = 0;
  if (dist > 0) { ux = dx / dist; uz = dz / dist; }
  // Initial guess: drag-free range from the launch height.
  const hh = h0 - BALL_RADIUS;
  let v: number;
  if (dist <= 0) {
    v = 0;
  } else if (hh <= 0) {
    v = Math.sqrt(g * dist / (2 * st * ct));
  } else {
    // dist = v^2 c (s + sqrt(s^2 + 2 g hh / v^2)) / g: solve the quadratic in v^2.
    // v^2 = g dist^2 / (2 c^2 (dist * tan + hh)).
    v = Math.sqrt(g * dist * dist / (2 * ct * ct * (dist * st / ct + hh)));
  }
  if (!(v > SOLVE_MIN_SPEED)) v = dist > 0 ? SOLVE_MIN_SPEED : 0;
  if (v > vmax) v = vmax;
  // Aim rotation (cos, sin of the azimuth correction; only curl needs one).
  let ca = 1;
  let sa = 0;
  let prevV = -1;
  let prevL = 0;
  for (let it = 0; it < SOLVE_MAX_ITERS; it++) {
    const dirX = ux * ca - uz * sa;
    const dirZ = ux * sa + uz * ca;
    const vh = v * ct;
    FLY.y = h0;
    FLY.vx = vh * dirX; FLY.vy = v * st; FLY.vz = vh * dirZ;
    FLY.sx = 0 - dirZ * backV; FLY.sy = curlV; FLY.sz = dirX * backV + 0;
    const landed = flyToGround();
    const lx = LAND[0]!;
    const lz = LAND[1]!;
    const along = lx * ux + lz * uz;
    const side = lz * ux - lx * uz;
    const errD = dist - along;
    const absD = errD < 0 ? -errD : errD;
    const absS = side < 0 ? -side : side;
    if (landed && absD <= SOLVE_TOL && absS <= SOLVE_TOL) { out.reached = 1; break; }
    if (dist <= 0) { out.reached = 1; break; }
    // Azimuth: rotate the aim by the angle from the landing direction to the target direction.
    if (curlV !== 0 && (lx !== 0 || lz !== 0)) {
      // cos/sin of that angle straight from the landing vector (L = along * u + side * right).
      const ll = Math.sqrt(along * along + side * side);
      const cd = along / ll;
      const sd = (0 - side) / ll;
      const nca = ca * cd - sa * sd;
      const nsa = sa * cd + ca * sd;
      const nl = Math.sqrt(nca * nca + nsa * nsa);
      ca = nca / nl;
      sa = nsa / nl;
    }
    // Speed: secant on (speed, distance along the aim), proportional (range ~ v^2) on the first step.
    let nv: number;
    if (!landed) {
      nv = v * 0.7;
    } else if (prevV < 0 || along === prevL || !(along > 0)) {
      nv = along > 0 ? v * Math.sqrt(dist / along) : v * 1.5;
    } else {
      nv = v + (dist - along) * (v - prevV) / (along - prevL);
    }
    if (!(nv > v * 0.5)) nv = v * 0.5;
    if (nv > v * 2) nv = v * 2;
    if (nv < SOLVE_MIN_SPEED) nv = SOLVE_MIN_SPEED;
    if (nv > vmax) nv = vmax;
    if (nv === v && v === vmax && errD > 0 && curlV === 0) break; // out of reach: already at max speed
    prevV = v;
    prevL = along;
    v = nv;
  }
  // The final launch is the last one simulated only when the loop broke; recompute the outputs from v and aim.
  const dirX = ux * ca - uz * sa;
  const dirZ = ux * sa + uz * ca;
  const vhF = v * ct;
  out.vx = vhF * dirX;
  out.vy = v * st;
  out.vz = vhF * dirZ;
  out.sx = 0 - dirZ * backV;
  out.sy = curlV;
  out.sz = dirX * backV + 0;
  out.speed = v;
  if (out.reached === 0) {
    // Report the landing of the returned launch (the loop's last trial may have used a different speed).
    FLY.y = h0;
    FLY.vx = out.vx; FLY.vy = out.vy; FLY.vz = out.vz;
    FLY.sx = out.sx; FLY.sy = out.sy; FLY.sz = out.sz;
    flyToGround();
    const ex = LAND[0]! - dx;
    const ez = LAND[1]! - dz;
    if (ex * ex + ez * ez <= SOLVE_TOL * SOLVE_TOL * 4) out.reached = 1;
  }
  out.flightT = LAND[2]!;
  out.landX = LAND[0]!;
  out.landZ = LAND[1]!;
  return v;
}

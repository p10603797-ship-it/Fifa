/**
 * [SIM-02] Ball contact: ground bounce (restitution + spin friction), rolling resistance, posts and crossbar
 * as rigid cylinders, the net as a soft volume that absorbs and holds the ball, side netting / roof deflect
 * from outside, advertising boards. Swept / sub-stepped so nothing tunnels at 36 m/s.
 * Calls SIM-03 detectCrossing for every substep segment. Emits BOUNCE, POST, NET.
 * When s.ball.heldBy >= 0 the ball is carried in a keeper's hands (GKP-05 positions it): skip integration.
 *
 * TICK: N = ceil(|v| * DT / T_BALL.maxStep) equal substeps (1..MAX_SUBSTEPS). Each substep:
 *   1. integrate: airborne -> SIM-01 ballAirStep, then ground impact (restitution on vy, tangential friction,
 *      spin friction that turns part of the spin into roll); rolling -> rollDecel + rollDamping * v (trapezoid
 *      position update), rest below restSpeed.
 *   2. goal frame (swept time of impact, then a discrete push-out pass), net sheets, in-net hold + damping.
 *   3. advertising boards (thin walls T_BALL_CONTACT.boardHeight high) and the stand walls at the world bounds.
 *   4. speed clamp (maxSpeed); ballTick only: SIM-03 detectCrossing on the substep segment; then the inNet flag.
 *
 * GEOMETRY (end = +1 for the goal at x = +52.5, -1 at x = -52.5; u = end * x, so u grows into the goal). It matches
 * render/goals.ts exactly:
 *  - Posts: vertical cylinders, radius POST_RADIUS, axis at u = HALF_LENGTH - POST_RADIUS (back of the post on the
 *    goal line), |z| = GOAL_HALF_WIDTH + POST_RADIUS (inner face at GOAL_HALF_WIDTH), from the ground to the bar axis.
 *  - Bar: horizontal cylinder along z, axis at the same u, y = GOAL_HEIGHT + POST_RADIUS (underside GOAL_HEIGHT),
 *    between the post axes. Posts + bar = a union of three capsules (sphere-vs-capsule, clearance BALL_RADIUS +
 *    POST_RADIUS), restitution T_BALL.postRestitution, POST (a = end, b = 0 post / 1 bar, c = normal impact speed).
 *  - Net: box u in [HALF_LENGTH, HALF_LENGTH + GOAL_DEPTH], |z| <= GOAL_HALF_WIDTH, y <= GOAL_HEIGHT, open at the
 *    goal mouth (u = HALF_LENGTH). The roof, back and two sides are thin TWO-SIDED sheets: the ball centre can
 *    never cross one (the push-out side is the side the centre started the substep on). From outside they deflect
 *    (T_BALL.netOutsideRestitution), from inside they absorb (T_BALL_CONTACT.netInsideRestitution). The sheets are
 *    ignored while the centre is in front of the goal line (u < HALF_LENGTH): the frame covers their front edges.
 *    A last guard rejects any substep whose centre enters or leaves the box other than through the goal mouth.
 *  - In the net: on the substep whose centre crosses into the box past u = HALF_LENGTH + BALL_RADIUS (the whole
 *    ball over the goal line), inNet = end and NET is emitted once (after detectCrossing has seen that substep, so
 *    SIM-03 still sees inNet = 0 for the segment that scores). While inNet: horizontal speed, upward speed and spin
 *    lose T_BALL.netDamping per tick and a front wall at u = HALF_LENGTH + BALL_RADIUS keeps the ball in. inNet
 *    clears when the ball is found outside the box (a restart moved it); a kick clears it too (sim/core/kick.ts) and
 *    the ball may then leave through the mouth without a second NET.
 *  - bounces counts ground impacts that bounce (vertical speed after >= rollThresholdVy), reset by kicks.
 *  - Boards: rectangle |x| = BOARD_X, |z| = BOARD_Z, T_BALL_CONTACT.boardHeight high, two-sided, boardRestitution.
 *    Stand walls at the world bounds (same restitution) and a ceiling at WORLD_MAX_Y keep the ball in the world.
 * ANTI-STUCK: a ball on the net roof is given T_BALL_CONTACT.roofRollSpeed toward the nearest back/side edge; a ball
 * slower than stuckSpeed touching a post, the bar or a board is nudged away along the contact normal.
 * EVENTS: BOUNCE (c = normal impact speed, ground / boards / stands) and POST above T_BALL_CONTACT.eventMinSpeed.
 * Deterministic (no Math trig, no allocation: module-level scratch only).
 */
import {
  BALL_RADIUS, BOARD_X, BOARD_Z, DT, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, POST_RADIUS,
  WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z,
} from '../../contracts/constants';
import { EventType, type EventSink } from '../../contracts/events';
import { T_BALL, T_BALL_CONTACT } from '../../contracts/tuning';
import type { BallState, SimState } from '../../contracts/state';
import { dpow } from '../core/dmath';
import { detectCrossing } from '../pitch/geometry';
import { ballAirStep } from './flight';


/** SIM-02 local tuning (read-only; exported for tests, render and the lead's tuning review). */
export const BALL_CONTACT_TUNING = T_BALL_CONTACT;

// ---------------------------------------------------------------- geometry (end-relative u = end * x)

const R = BALL_RADIUS;
/** Goal line (u) and back of the net. */
const GL = HALF_LENGTH;
const GB = HALF_LENGTH + GOAL_DEPTH;
/** Side netting |z| (= inner face of the posts) and roof height (= underside of the bar). */
const GW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;
/** Frame axes: posts and bar at u = FR_U; post axes at |z| = FR_Z up to the bar axis height FR_Y. */
const FR_U = HALF_LENGTH - POST_RADIUS;
const FR_Z = GOAL_HALF_WIDTH + POST_RADIUS;
const FR_Y = GOAL_HEIGHT + POST_RADIUS;
/** Ball-centre clearance from a frame axis. */
const FR_R = BALL_RADIUS + POST_RADIUS;
const FR_R2 = FR_R * FR_R;
/** Region (m) around a goal where frame and net tests run (generous: a substep moves <= maxStep). */
const NEAR_MIN_U = GL - 1;
const NEAR_MAX_U = GB + 1;
const NEAR_Z = GW + 1;
const NEAR_Y = GH + 1;
const BOARD_NEAR = 1;
/** In-net front wall: the whole ball stays over the goal line. */
const NET_FRONT = GL + R;

/** Max substeps per tick (|v| is clamped to maxSpeed first). */
export const MAX_SUBSTEPS = Math.ceil(T_BALL.maxSpeed * DT / T_BALL.maxStep) + 1;
/**
 * Substep length per substep count: SUBSTEP_DT[n] = DT / n (exactly the division). Kept in a generic (tagged)
 * array so the per-tick value is an existing number, not a fresh double V8 would box when passing it on.
 */
const SUBSTEP_DT: (number | null)[] = [null]; // null at index 0 (unused) keeps the generic elements kind
/** In-net keep factor per substep for n substeps per tick: (1 - netDamping)^(1 / n), so n substeps = one tick. */
const NET_KEEP = new Float64Array(MAX_SUBSTEPS + 1);
for (let n = 1; n <= MAX_SUBSTEPS; n++) {
  SUBSTEP_DT.push(DT / n);
  NET_KEEP[n] = dpow(1 - T_BALL.netDamping, 1 / n);
}
/** Height tolerance for "on the ground" (m). */
const GROUND_EPS = 1e-9;
/** A contact normal whose horizontal part is shorter than this is treated as "on top" (nudge direction fallback). */
const MIN_HORIZONTAL_NORMAL = 0.3;

// ---------------------------------------------------------------- scratch (module-level, no allocation)

// Doubles shared between the helpers live in typed arrays, not in arguments, module lets or return values: V8
// boxes a fresh double passed to (or returned from) a call it does not inline. JSC never boxes doubles.

/** Working position / velocity (u|x, y, z) and the last contact normal. */
const P = new Float64Array(3);
const V = new Float64Array(3);
const N = new Float64Array(3);
/** Substep start: [0] u0 (end-relative, set by goal), [1] y0, [2] z0, [3] x0 (world), [4] substep length dt. */
const S0 = new Float64Array(5);
/** Closest axis point of the frame capsule under test (input of capsule()). */
const CP = new Float64Array(3);
/** nudgeIfStuck input: horizontal contact normal (hu, hz) and fallback direction (fu, fz). */
const TN = new Float64Array(4);
/** Swept frame hit: [0] parameter t along the substep (> 1 = none), [1..3] normal (u, y, z), [4] 1 = bar. */
const HIT = new Float64Array(5);
/** [0] normal impact speed of the last resolved contact (0 if it was not approaching). */
const IMP = new Float64Array(1);
/** Net damping cache: [0] substep length, [1] keep factor (1 - netDamping)^(dt / DT). */
const NK = new Float64Array(2);
NK[0] = -1;
NK[1] = 1;
/** Negated constants and restitutions as module constants (passed to helpers as existing numbers). */
const NEG_GW = -GW;
const NEG_BOARD_X = -BOARD_X;
const NEG_BOARD_Z = -BOARD_Z;
const E_POST = T_BALL.postRestitution;
const E_NET_OUT = T_BALL.netOutsideRestitution;
const E_NET_IN = T_BALL_CONTACT.netInsideRestitution;
const E_BOARD = T_BALL.boardRestitution;
const BOARD_H = T_BALL_CONTACT.boardHeight;

/**
 * Thin two-sided sheets (net and boards), one row of SHEET_COLS numbers each: the normal axis (0 = u|x, 1 = y,
 * 2 = z), the plane coordinate, the in-plane extents [aMin, aMax] on axis (axis + 1) % 3 and [bMin, bMax] on axis
 * (axis + 2) % 3, the outward side (+1/-1) and the restitution on the outward / inward side. Net sheets are in
 * end-relative coordinates (u = end * x), boards in world coordinates.
 */
const SHEET_COLS = 9;
const SH_ROOF = 0;
const SH_BACK = 1;
const SH_SIDE_POS = 2;
const SH_SIDE_NEG = 3;
const SH_BOARD_POS_X = 4;
const SH_BOARD_NEG_X = 5;
const SH_BOARD_POS_Z = 6;
const SH_BOARD_NEG_Z = 7;
const SHEETS = new Float64Array([
  1, GH, NEG_GW, GW, GL, GB, 1, E_NET_OUT, E_NET_IN, // roof: y = GH; z, u
  0, GB, 0, GH, NEG_GW, GW, 1, E_NET_OUT, E_NET_IN, // back: u = GB; y, z
  2, GW, GL, GB, 0, GH, 1, E_NET_OUT, E_NET_IN, // side netting z = +GW; u, y
  2, NEG_GW, GL, GB, 0, GH, -1, E_NET_OUT, E_NET_IN, // side netting z = -GW; u, y
  0, BOARD_X, 0, BOARD_H, NEG_BOARD_Z, BOARD_Z, 1, E_BOARD, E_BOARD, // board x = +BOARD_X; y, z
  0, NEG_BOARD_X, 0, BOARD_H, NEG_BOARD_Z, BOARD_Z, -1, E_BOARD, E_BOARD, // board x = -BOARD_X
  2, BOARD_Z, NEG_BOARD_X, BOARD_X, 0, BOARD_H, 1, E_BOARD, E_BOARD, // board z = +BOARD_Z; x, y
  2, NEG_BOARD_Z, NEG_BOARD_X, BOARD_X, 0, BOARD_H, -1, E_BOARD, E_BOARD, // board z = -BOARD_Z
]);

// ---------------------------------------------------------------- public API

/**
 * One pure physics substep of dt seconds for a ball (air or ground, bounce, roll, goal frame, net, boards).
 * ev may be null (prediction). Must be deterministic and allocation-free.
 */
export function ballPhysicsStep(b: BallState, dt: number, ev: EventSink | null): void {
  substep(b, dt, ev, null);
}

/**
 * Advance a free ball by exactly one tick (DT), sub-stepping as needed (T_BALL.maxStep) so nothing tunnels.
 * Used by ballTick AND by SIM-01 predictBall (with ev = null), so predictions match the sim bit-for-bit.
 */
export function ballStepTick(b: BallState, ev: EventSink | null): void {
  stepTick(b, ev, null);
}

/**
 * Per-tick ball update: records px/py/pz, skips when held in hands, ballStepTick, then SIM-03 detectCrossing on
 * the tick's segment (px,py,pz) -> (x,y,z), and keeps the ball inside the world bounds.
 * The crossing test runs on every substep segment (their union is the tick's path, bent by posts and nets), and
 * only where the substep ends beyond a goal line or touchline.
 */
export function ballTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  if (b.heldBy >= 0) return;
  stepTick(b, ev, s);
  clampWorld(b);
}

/** Number of substeps ballStepTick will use for this ball (after the speed clamp). */
export function ballSubsteps(b: Readonly<BallState>): number {
  let v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  const m = T_BALL.maxSpeed;
  if (!(v2 <= m * m)) v2 = m * m;
  let n = Math.ceil(Math.sqrt(v2) * DT / T_BALL.maxStep);
  if (!(n >= 1)) n = 1;
  else if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  return n;
}

// ---------------------------------------------------------------- tick + substep

function stepTick(b: BallState, ev: EventSink | null, s: SimState | null): void {
  sanitize(b);
  clampSpeed(b);
  const n = ballSubsteps(b);
  const dt = SUBSTEP_DT[n] as number;
  for (let i = 0; i < n; i++) substep(b, dt, ev, s);
}

function substep(b: BallState, dt: number, ev: EventSink | null, s: SimState | null): void {
  const x0 = b.x;
  const y0 = b.y;
  const z0 = b.z;
  S0[1] = y0; S0[2] = z0; S0[3] = x0; S0[4] = dt;
  // 1. integrate
  if (b.y > R + GROUND_EPS || b.vy !== 0) {
    b.grounded = 0;
    ballAirStep(b, dt);
    if (b.y < R) groundImpact(b, ev);
  } else {
    roll(b, dt);
  }
  // 2. goal frame and net
  let ax = b.x < 0 ? -b.x : b.x;
  if (ax > NEAR_MIN_U && ax < NEAR_MAX_U && b.z < NEAR_Z && b.z > -NEAR_Z && b.y < NEAR_Y) {
    goal(b, ev);
    ax = b.x < 0 ? -b.x : b.x;
  }
  // 3. boards and stands
  if (ax > BOARD_X - BOARD_NEAR || b.z > BOARD_Z - BOARD_NEAR || b.z < BOARD_NEAR - BOARD_Z) boards(b, ev);
  standWalls(b, ev);
  // 4. floor, speed clamp
  if (b.y < R) b.y = R;
  clampSpeed(b);
  // 5. line crossing on this substep segment (ballTick only; before the inNet update, see header)
  if (s !== null) {
    const ex = b.x < 0 ? -b.x : b.x;
    if (ex > HALF_LENGTH || b.z > HALF_WIDTH || b.z < -HALF_WIDTH) detectCrossing(s, x0, y0, z0, b.x, b.y, b.z);
  }
  // 6. in-net flag + NET
  netState(b, ev);
}

// ---------------------------------------------------------------- ground

function groundImpact(b: BallState, ev: EventSink | null): void {
  b.y = R;
  const vi = -b.vy;
  if (!(vi > 0)) return; // rising through the floor (started below it): just lift
  const fg = T_BALL_CONTACT.fullGripImpactSpeed;
  const grip = vi >= fg ? 1 : vi / fg;
  // Spin friction: part of the spin is lost; its contact-point speed (spin x (-r y)) partly becomes roll.
  const q = T_BALL_CONTACT.bounceSpinFriction * grip;
  const conv = T_BALL_CONTACT.spinToRoll * q * R;
  b.vx -= conv * b.sz;
  b.vz += conv * b.sx;
  const keep = 1 - q;
  b.sx *= keep;
  b.sy *= keep;
  b.sz *= keep;
  // Tangential friction.
  const f = 1 - T_BALL.bounceFriction * grip;
  b.vx *= f;
  b.vz *= f;
  const vy = vi * T_BALL.restitution;
  if (vy < T_BALL.rollThresholdVy) {
    b.vy = 0;
    b.grounded = 1;
  } else {
    b.vy = vy;
    b.grounded = 0;
    b.bounces++;
  }
  if (ev !== null && vi > T_BALL_CONTACT.eventMinSpeed) ev.emit(EventType.BOUNCE, 0, 0, vi, 0, b.x, b.y, b.z);
}

function roll(b: BallState, dt: number): void {
  b.grounded = 1;
  b.y = R;
  b.vy = 0;
  const vx = b.vx;
  const vz = b.vz;
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (sp > 0) {
    let ns = sp - (T_BALL.rollDecel + T_BALL.rollDamping * sp) * dt;
    if (ns < T_BALL.restSpeed) ns = 0;
    const k = ns / sp;
    const nx = vx * k;
    const nz = vz * k;
    b.x += 0.5 * (vx + nx) * dt;
    b.z += 0.5 * (vz + nz) * dt;
    b.vx = nx;
    b.vz = nz;
  }
  let f = 1 - T_BALL_CONTACT.groundSpinDecay * dt;
  if (f < 0) f = 0;
  b.sx *= f;
  b.sy *= f;
  b.sz *= f;
}

// ---------------------------------------------------------------- goal frame + net

function goal(b: BallState, ev: EventSink | null): void {
  const end = b.x < 0 ? -1 : 1;
  P[0] = end * b.x; P[1] = b.y; P[2] = b.z;
  V[0] = end * b.vx; V[1] = b.vy; V[2] = b.vz;
  S0[0] = end * S0[3];
  frame(b, end, ev);
  net(b, end);
  b.x = end * P[0]; b.y = P[1]; b.z = P[2];
  b.vx = end * V[0]; b.vy = V[1]; b.vz = V[2];
}

/**
 * Earliest contact of the ball centre moving from the substep start S0 (u0, y0, z0) to P, i.e. S0 + t * (P - S0)
 * with t in [0, 1], with the frame capsules. Writes HIT.
 */
function sweepFrame(): void {
  const u0 = S0[0];
  const y0 = S0[1];
  const z0 = S0[2];
  const du = P[0] - u0;
  const dy = P[1] - y0;
  const dz = P[2] - z0;
  let hitT = 2;
  let hitNU = 0;
  let hitNY = 0;
  let hitNZ = 0;
  let hitBar = 0;
  const a = u0 - FR_U;
  const e = y0 - FR_Y;
  // Bar: circle in the (u, y) plane, valid between the post axes.
  const Ab = du * du + dy * dy;
  if (Ab > 0) {
    const B = a * du + e * dy;
    const C = a * a + e * e - FR_R2;
    if (C > 0 && B < 0) {
      const disc = B * B - Ab * C;
      if (disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / Ab;
        const zt = z0 + t * dz;
        if (t <= 1 && zt <= FR_Z && zt >= -FR_Z) {
          hitT = t; hitBar = 1;
          hitNU = (a + t * du) / FR_R; hitNY = (e + t * dy) / FR_R; hitNZ = 0;
        }
      }
    }
  }
  const Ap = du * du + dz * dz;
  const As = Ap + dy * dy;
  for (let side = -1; side <= 1; side += 2) {
    const c = z0 - side * FR_Z;
    // Post: circle in the (u, z) plane, valid from the ground up to the bar axis.
    if (Ap > 0) {
      const B = a * du + c * dz;
      const C = a * a + c * c - FR_R2;
      if (C > 0 && B < 0) {
        const disc = B * B - Ap * C;
        if (disc >= 0) {
          const t = (-B - Math.sqrt(disc)) / Ap;
          if (t < hitT && t <= 1 && y0 + t * dy <= FR_Y) {
            hitT = t; hitBar = 0;
            hitNU = (a + t * du) / FR_R; hitNY = 0; hitNZ = (c + t * dz) / FR_R;
          }
        }
      }
    }
    // Joint (top of the post = end of the bar): sphere.
    if (As > 0) {
      const B = a * du + e * dy + c * dz;
      const C = a * a + e * e + c * c - FR_R2;
      if (C > 0 && B < 0) {
        const disc = B * B - As * C;
        if (disc >= 0) {
          const t = (-B - Math.sqrt(disc)) / As;
          if (t < hitT && t <= 1) {
            hitT = t;
            hitNU = (a + t * du) / FR_R; hitNY = (e + t * dy) / FR_R; hitNZ = (c + t * dz) / FR_R;
            hitBar = hitNZ * hitNZ < hitNU * hitNU + hitNY * hitNY ? 1 : 0;
          }
        }
      }
    }
  }
  HIT[0] = hitT; HIT[1] = hitNU; HIT[2] = hitNY; HIT[3] = hitNZ; HIT[4] = hitBar;
}

/** Reflect V about N (unit) with restitution e if approaching; sets IMP[0]. */
function reflect(e: number): void {
  const vn = V[0] * N[0] + V[1] * N[1] + V[2] * N[2];
  IMP[0] = 0;
  if (vn < 0) {
    const k = (1 + e) * vn;
    V[0] -= k * N[0];
    V[1] -= k * N[1];
    V[2] -= k * N[2];
    IMP[0] = -vn;
  }
}

function postHit(b: BallState, end: number, bar: number, ev: EventSink | null, emitted: number): number {
  const impact = IMP[0];
  if (impact <= 0) return emitted;
  const keep = T_BALL_CONTACT.postSpinKeep;
  b.sx *= keep; b.sy *= keep; b.sz *= keep;
  if (emitted === 0 && ev !== null && impact > T_BALL_CONTACT.eventMinSpeed) {
    ev.emit(EventType.POST, end, bar, impact, 0, end * P[0], P[1], P[2]);
    return 1;
  }
  return emitted;
}

/**
 * Ball vs one frame capsule whose closest axis point to the ball is CP = (cu, cy, cz): push out + reflect if
 * penetrating. Returns 1 if touching (within touchSlop), writing the normal into N and IMP.
 */
function capsule(): number {
  const cu = CP[0];
  const cy = CP[1];
  const cz = CP[2];
  const du = P[0] - cu;
  const dy = P[1] - cy;
  const dz = P[2] - cz;
  const d2 = du * du + dy * dy + dz * dz;
  const tr = FR_R + T_BALL_CONTACT.touchSlop;
  IMP[0] = 0;
  if (d2 >= tr * tr) return 0;
  if (d2 > 1e-18) {
    const d = Math.sqrt(d2);
    N[0] = du / d; N[1] = dy / d; N[2] = dz / d;
  } else {
    N[0] = -1; N[1] = 0; N[2] = 0; // on the axis (never in practice): toward the field
  }
  if (d2 < FR_R2) {
    P[0] = cu + N[0] * FR_R;
    P[1] = cy + N[1] * FR_R;
    P[2] = cz + N[2] * FR_R;
    reflect(E_POST);
  }
  return 1;
}

function frame(b: BallState, end: number, ev: EventSink | null): void {
  let emitted = 0;
  // Swept first contact along this substep.
  sweepFrame();
  const t = HIT[0];
  if (t <= 1) {
    const u0 = S0[0];
    const y0 = S0[1];
    const z0 = S0[2];
    P[0] = u0 + (P[0] - u0) * t;
    P[1] = y0 + (P[1] - y0) * t;
    P[2] = z0 + (P[2] - z0) * t;
    N[0] = HIT[1]; N[1] = HIT[2]; N[2] = HIT[3];
    reflect(E_POST);
    emitted = postHit(b, end, HIT[4] === 1 ? 1 : 0, ev, emitted);
    const rem = (1 - t) * S0[4];
    P[0] += V[0] * rem;
    P[1] += V[1] * rem;
    P[2] += V[2] * rem;
  }
  // Discrete pass: start overlaps, second contacts, resting contact (touch).
  let touch = 0;
  let tnU = 0;
  let tnZ = 0;
  for (let side = -1; side <= 1; side += 2) {
    const py = P[1];
    CP[0] = FR_U; CP[1] = py < 0 ? 0 : py > FR_Y ? FR_Y : py; CP[2] = side * FR_Z;
    if (capsule() === 1) {
      touch = 1; tnU = N[0]; tnZ = N[2];
      emitted = postHit(b, end, 0, ev, emitted);
    }
  }
  const pz = P[2];
  CP[0] = FR_U; CP[1] = FR_Y; CP[2] = pz < -FR_Z ? -FR_Z : pz > FR_Z ? FR_Z : pz;
  if (capsule() === 1) {
    touch = 1; tnU = N[0]; tnZ = N[2];
    postHit(b, end, 1, ev, emitted);
  }
  if (touch === 1) {
    TN[0] = tnU; TN[1] = tnZ; TN[2] = 1; TN[3] = 0;
    nudgeIfStuck();
  }
}

/**
 * A slow ball touching something is pushed away along the horizontal contact normal TN (hu, hz), or along the
 * fallback direction (fu, fz) when that normal is (nearly) vertical (the ball sits on top of it).
 */
function nudgeIfStuck(): void {
  const v2 = V[0] * V[0] + V[1] * V[1] + V[2] * V[2];
  const ss = T_BALL_CONTACT.stuckSpeed;
  if (v2 >= ss * ss) return;
  const hu = TN[0];
  const hz = TN[1];
  const hn = Math.sqrt(hu * hu + hz * hz);
  let du = TN[2];
  let dz = TN[3];
  if (hn >= MIN_HORIZONTAL_NORMAL) { du = hu / hn; dz = hz / hn; }
  const vd = V[0] * du + V[2] * dz;
  const ns = T_BALL_CONTACT.nudgeSpeed;
  if (vd < ns) {
    V[0] += du * (ns - vd);
    V[2] += dz * (ns - vd);
  }
}

/**
 * Sphere vs thin two-sided rectangle SHEETS[id] (see the table). s0 = +1/-1: side of the plane the centre started
 * the substep on (the push-out side). Returns 1 if touching (within touchSlop); pushes out + reflects (restitution
 * of that side) if penetrating; writes N and IMP.
 */
function sheet(id: number, s0: number): number {
  const o = id * SHEET_COLS;
  const axis = SHEETS[o] === 0 ? 0 : SHEETS[o] === 1 ? 1 : 2;
  const plane = SHEETS[o + 1]!;
  const aMin = SHEETS[o + 2]!;
  const aMax = SHEETS[o + 3]!;
  const bMin = SHEETS[o + 4]!;
  const bMax = SHEETS[o + 5]!;
  const e = s0 === SHEETS[o + 6] ? SHEETS[o + 7]! : SHEETS[o + 8]!;
  const ia = axis === 2 ? 0 : axis + 1;
  const ib = axis === 0 ? 2 : axis - 1;
  const pa = P[ia]!;
  const pb = P[ib]!;
  const ca = pa < aMin ? aMin : pa > aMax ? aMax : pa;
  const cb = pb < bMin ? bMin : pb > bMax ? bMax : pb;
  const da = pa - ca;
  const db = pb - cb;
  const dn = P[axis]! - plane;
  const tr = R + T_BALL_CONTACT.touchSlop;
  IMP[0] = 0;
  if (da === 0 && db === 0) {
    // Over the face: the normal is the plane normal on the start side, even if the centre crossed the plane.
    const dist = s0 * dn;
    if (dist >= tr) return 0;
    N[axis] = s0; N[ia] = 0; N[ib] = 0;
    if (dist < R) {
      P[axis] = plane + s0 * R;
      reflect(e);
    }
    return 1;
  }
  // Beyond an edge: closest point on the edge.
  const d2 = da * da + db * db + dn * dn;
  if (d2 >= tr * tr) return 0;
  const d = Math.sqrt(d2); // > 0: da or db is non-zero
  const nn = dn / d;
  const na = da / d;
  const nb = db / d;
  N[axis] = nn; N[ia] = na; N[ib] = nb;
  if (d2 < R * R) {
    P[axis] = plane + nn * R;
    P[ia] = ca + na * R;
    P[ib] = cb + nb * R;
    reflect(e);
  }
  return 1;
}

/** Centre strictly inside the net box (end-relative): the working position P / the substep start S0. */
function inBoxP(): boolean {
  return P[0] > GL && P[0] < GB && P[1] < GH && P[2] < GW && P[2] > NEG_GW;
}
function inBoxS0(): boolean {
  return S0[0] > GL && S0[0] < GB && S0[1] < GH && S0[2] < GW && S0[2] > NEG_GW;
}

function net(b: BallState, end: number): void {
  const u0 = S0[0];
  const y0 = S0[1];
  const z0 = S0[2];
  if (P[0] >= GL) {
    if (sheet(SH_ROOF, y0 >= GH ? 1 : -1) === 1 && y0 >= GH) roofRollOff();
    sheet(SH_BACK, u0 >= GB ? 1 : -1);
    sheet(SH_SIDE_POS, z0 >= GW ? 1 : -1);
    sheet(SH_SIDE_NEG, z0 <= NEG_GW ? -1 : 1);
  }
  // Guard: the centre enters or leaves the box only through the goal mouth.
  const in0 = inBoxS0();
  let in1 = inBoxP();
  if (in0 !== in1) {
    let legal = false;
    if ((u0 <= GL) !== (P[0] <= GL)) {
      const t = (GL - u0) / (P[0] - u0);
      const zc = z0 + (P[2] - z0) * t;
      const yc = y0 + (P[1] - y0) * t;
      legal = zc < GW && zc > NEG_GW && yc < GH;
    }
    if (!legal) {
      const e = in0 ? E_NET_IN : E_NET_OUT;
      P[0] = u0; P[1] = y0; P[2] = z0;
      V[0] *= -e; V[1] *= -e; V[2] *= -e;
      in1 = in0;
    }
  }
  // In the net: hold it behind the line and absorb.
  if (b.inNet === end && in1) {
    if (P[0] < NET_FRONT) {
      P[0] = NET_FRONT;
      if (V[0] < 0) V[0] = -V[0] * E_NET_IN;
    }
    const dt = S0[4];
    const n = Math.round(DT / dt);
    let k: number;
    if (n >= 1 && n <= MAX_SUBSTEPS && SUBSTEP_DT[n] === dt) {
      k = NET_KEEP[n]!;
    } else {
      // ballPhysicsStep called with a free substep length: compute (and cache) the factor.
      if (dt !== NK[0]) {
        NK[0] = dt;
        NK[1] = dpow(1 - T_BALL.netDamping, dt / DT);
      }
      k = NK[1]!;
    }
    V[0] *= k;
    V[2] *= k;
    if (V[1] > 0) V[1] *= k;
    b.sx *= k; b.sy *= k; b.sz *= k;
  }
}

/** On the roof from above: make sure the ball rolls off toward the nearest back or side edge (never the bar). */
function roofRollOff(): void {
  const rs = T_BALL_CONTACT.roofRollSpeed;
  if (V[0] * V[0] + V[2] * V[2] >= rs * rs) return;
  const az = P[2] < 0 ? -P[2] : P[2];
  let du = 0;
  let dz = 0;
  if (GW - az < GB - P[0]) dz = P[2] < 0 ? -1 : 1;
  else du = 1;
  const vd = V[0] * du + V[2] * dz;
  V[0] += du * (rs - vd);
  V[2] += dz * (rs - vd);
}

function netState(b: BallState, ev: EventSink | null): void {
  const ax = b.x < 0 ? -b.x : b.x;
  if (b.inNet === 0 && ax <= NET_FRONT) return;
  const end = b.x < 0 ? -1 : 1;
  const inside = ax > GL && ax < GB && b.y < GH && b.z < GW && b.z > NEG_GW;
  if (b.inNet !== 0 && (b.inNet !== end || !inside)) b.inNet = 0;
  // Enter only on the substep that carries the centre across the whole-ball plane: a ball kicked from inside the
  // net (applyKick clears inNet) is free to leave and does not emit NET again.
  if (b.inNet === 0 && inside && ax > NET_FRONT && end * S0[3] <= NET_FRONT) {
    b.inNet = end;
    if (ev !== null) {
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      ev.emit(EventType.NET, end, 0, sp, 0, b.x, b.y, b.z);
    }
  }
}

// ---------------------------------------------------------------- boards, stands, clamps

function boards(b: BallState, ev: EventSink | null): void {
  const x0 = S0[3];
  const z0 = S0[2];
  P[0] = b.x; P[1] = b.y; P[2] = b.z;
  V[0] = b.vx; V[1] = b.vy; V[2] = b.vz;
  let touch = 0;
  let tnX = 0;
  let tnZ = 0;
  let fx = 0;
  let fz = 0;
  // End boards (x = +-BOARD_X; extents y, z).
  const sx = P[0] < 0 ? -1 : 1;
  if (sx * P[0] > BOARD_X - BOARD_NEAR) {
    const s0 = sx * x0 >= BOARD_X ? sx : -sx;
    if (sheet(sx > 0 ? SH_BOARD_POS_X : SH_BOARD_NEG_X, s0) === 1) {
      touch = 1; tnX = N[0]; tnZ = N[2]; fx = s0; fz = 0;
      boardBounce(ev);
    }
  }
  // Side boards (z = +-BOARD_Z; extents x, y).
  const sz = P[2] < 0 ? -1 : 1;
  if (sz * P[2] > BOARD_Z - BOARD_NEAR) {
    const s0 = sz * z0 >= BOARD_Z ? sz : -sz;
    if (sheet(sz > 0 ? SH_BOARD_POS_Z : SH_BOARD_NEG_Z, s0) === 1) {
      touch = 1; tnX = N[0]; tnZ = N[2]; fx = 0; fz = s0;
      boardBounce(ev);
    }
  }
  if (touch === 1) {
    TN[0] = tnX; TN[1] = tnZ; TN[2] = fx; TN[3] = fz;
    nudgeIfStuck();
  }
  b.x = P[0]; b.y = P[1]; b.z = P[2];
  b.vx = V[0]; b.vy = V[1]; b.vz = V[2];
}

function boardBounce(ev: EventSink | null): void {
  if (ev !== null && IMP[0] > T_BALL_CONTACT.eventMinSpeed) ev.emit(EventType.BOUNCE, 0, 0, IMP[0], 0, P[0], P[1], P[2]);
}

/** Stand walls at the world bounds (boardRestitution) and the ceiling. */
function standWalls(b: BallState, ev: EventSink | null): void {
  const e = T_BALL.boardRestitution;
  let hit = 0;
  if (b.x > WORLD_MAX_X - R) {
    b.x = WORLD_MAX_X - R;
    if (b.vx > 0) { hit = b.vx; b.vx = -b.vx * e; }
  } else if (b.x < WORLD_MIN_X + R) {
    b.x = WORLD_MIN_X + R;
    if (b.vx < 0) { hit = -b.vx; b.vx = -b.vx * e; }
  }
  if (b.z > WORLD_MAX_Z - R) {
    b.z = WORLD_MAX_Z - R;
    if (b.vz > 0) { if (b.vz > hit) hit = b.vz; b.vz = -b.vz * e; }
  } else if (b.z < WORLD_MIN_Z + R) {
    b.z = WORLD_MIN_Z + R;
    if (b.vz < 0) { if (-b.vz > hit) hit = -b.vz; b.vz = -b.vz * e; }
  }
  if (b.y > WORLD_MAX_Y - R) {
    b.y = WORLD_MAX_Y - R;
    if (b.vy > 0) b.vy = 0;
  }
  if (ev !== null && hit > T_BALL_CONTACT.eventMinSpeed) ev.emit(EventType.BOUNCE, 0, 0, hit, 0, b.x, b.y, b.z);
}

function clampSpeed(b: BallState): void {
  const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  const m = T_BALL.maxSpeed;
  if (v2 > m * m) {
    const k = m / Math.sqrt(v2);
    b.vx *= k; b.vy *= k; b.vz *= k;
  }
}

/** Non-finite kinematics (a bug elsewhere) must not poison the state: fall back to the last good position, stop. */
function sanitize(b: BallState): void {
  if (!(b.x - b.x === 0 && b.y - b.y === 0 && b.z - b.z === 0)) {
    if (b.px - b.px === 0 && b.py - b.py === 0 && b.pz - b.pz === 0) {
      b.x = b.px; b.y = b.py; b.z = b.pz;
    } else {
      b.x = 0; b.y = R; b.z = 0;
    }
    b.vx = 0; b.vy = 0; b.vz = 0;
  }
  if (!(b.vx - b.vx === 0 && b.vy - b.vy === 0 && b.vz - b.vz === 0)) { b.vx = 0; b.vy = 0; b.vz = 0; }
  if (!(b.sx - b.sx === 0 && b.sy - b.sy === 0 && b.sz - b.sz === 0)) { b.sx = 0; b.sy = 0; b.sz = 0; }
  if (b.y < R) b.y = R;
}

/** Final safety clamp into the world bounds (the stand walls normally keep the ball well inside). */
function clampWorld(b: BallState): void {
  if (b.x > WORLD_MAX_X) { b.x = WORLD_MAX_X; if (b.vx > 0) b.vx = 0; }
  else if (b.x < WORLD_MIN_X) { b.x = WORLD_MIN_X; if (b.vx < 0) b.vx = 0; }
  if (b.z > WORLD_MAX_Z) { b.z = WORLD_MAX_Z; if (b.vz > 0) b.vz = 0; }
  else if (b.z < WORLD_MIN_Z) { b.z = WORLD_MIN_Z; if (b.vz < 0) b.vz = 0; }
  if (b.y > WORLD_MAX_Y) { b.y = WORLD_MAX_Y; if (b.vy > 0) b.vy = 0; }
  else if (b.y < R) b.y = R;
}

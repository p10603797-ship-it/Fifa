/**
 * [SIM-10] Through balls: THROUGH_GROUND, THROUGH_LOBBED, THROUGH_DINKED. "A through ball leads the runner
 * into space, weighted so he meets it in stride." Uses SIM-01 prediction/solvers and SIM-04 ticksToReach.
 *
 * STARTER (startThrough): the shared foot-kick starter of SIM-09 (kicks/lob.ts beginFootKick: SIM-08 startPass rules
 * and action-field layout); SIM-08's KICK handler calls solveThrough at the contact tick.
 *
 * LEAD POINT (throughLeadPoint / leadSearch, pure): candidate points every (leadMax - leadMin) / (leadSamples - 1) m
 * along the runner's run (his velocity direction; toward the attacked goal when he is slower than runMinSpeed or runs
 * backward), kept pitchMargin inside the touchlines and goalLineMargin out from the goal lines. For each: the runner's
 * time to get there sprinting (SIM-04 ticksToReach) and the ball's time:
 *  - ground: the launch speed that makes the ball arrive exactly then, in closed form from SIM-02's roll model
 *    (dv/dt = -a - c v: v0 = (D + kT) c / (1 - e^-cT) - k, k = a / c; arrival speed (v0 + k) e^-cT - k). Ideal = an
 *    arrival speed of at least arriveMin and within arriveRelMax of the runner's own velocity there (in stride; both x
 *    T_PASS.drivenMul for ReqFlag.DRIVEN) with v0 <= the max launch; slower = "early" (the ball waits, rolling softly
 *    ahead of him), faster relative to him = "firm", beyond the max launch = late (never).
 *  - lofted: the ball LANDS loftLandEarly before he arrives: drag-free tan(angle) = g T^2 / (2 D), inside the lobbed /
 *    dinked angle window (above it = early, below it = late) and loftSpeedMax (compared as tangents: no trig per
 *    sample). The solver then refines the angle with drag (loftTimeIters Newton steps on solveLaunchSpin's flight time).
 * Power scales the lead: the pick is lerp(first, last ideal sample, power) (short lead with a firm ball .. long lead
 * weighted to die into space); a point an opponent reaches first (reaction + run at oppSpeed within oppReach; the
 * keeper inside his penalty area with keeperReach / keeperMargin: his claim zone) or, for a ground ball, whose path an
 * opponent stands on (within blockReach) or reaches before the ball has rolled past his projection on it (closed-form
 * roll distance at his arrival time), moves to the nearest safe ideal sample (shorter first), then the nearest safe
 * early / firm one; with none safe the power pick stays. No ideal sample: the first early sample (safe first), else the
 * last firm one, else the least-late sample when it is at most maxLateSec late (ball at full speed / flattest angle).
 * Returns 0 when nothing is playable. Onside-ness is RUL-08's job.
 * SOLVER (solveThrough): runner = actSlot, else selectRunner (Assisted / Semi): teammates (keeper excluded) in the cone
 * of T_PASS.coneHalfAngle x coneMul around the stick (facing when idle), scored by alignment, forward run speed, being
 * at / beyond the opponents' second-last defender, plus a bonus for SIM-08 selectReceiver(lofted)'s pick. Target:
 * explicit point (gesture; the runner's time to it weights the ball), else the lead point, else (no runner / Manual)
 * along the request direction over lerp(spaceDistMin, spaceDistMax, power). Launch: ground = the timed speed (early:
 * SIM-01 groundPassSpeed to arrive at arriveMin; untimed: spaceArrive), Semi blends semiPowerBlend of the power-only
 * speed in, Manual = power-only speed; clamped to groundSpeedMin..groundSpeedMax (x drivenMul when driven). Lofted =
 * SIM-01 solveLaunchSpin at the timed angle (lobbedAngle / dinkedAngle untimed), capped at loftSpeedMax. Error: SIM-08
 * kickErrorAim with accuracy = visionShare x vision + the rest x SIM-08 passAccuracy over the distance; rotation plus a
 * lengthwise speed scale (two calls, always eight rng draws). launch.target = runner (or a teammate within
 * spaceReceiverRadius of a ball played into space), tx/tz = the lead point.
 * Determinism / cost: dmath + Math.sqrt + plain-arithmetic series, slot-order scans, strict tie breaks, module scratch
 * only. leadSearch is O(leadSamples x 11) with one SIM-04 ticksToReach per sample and no double arguments / returns
 * between its helpers (scratch Float64Array), so it allocates nothing of its own (CPU passing calls it a few times per
 * evaluation; ~4 us); the solver adds O(11 x 11) runner selection and, lofted, a few solveLaunchSpin calls.
 */
// Re-export the registry-facing shell FIRST: see throughHooks.ts (import-cycle safety with actions/registry).
export { solveThrough } from './throughHooks';
import { bindThroughImpl } from './throughHooks';
import {
  HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM, TICK_HZ,
} from '../../contracts/constants';
import { AssistLevel, KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { ReqFlag, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { T_BALL, T_PASS, T_PLAYER } from '../../contracts/tuning';
import { groundPassSpeed, solveLaunchSpin, type LaunchSolution } from '../ball/flight';
import { datan, dcos, dlog, dsin } from '../core/dmath';
import { secondLastDefenderX } from '../core/query';
import { maxSpeed, ticksToReach } from '../players/locomotion';
import { attackerNear, beginFootKick } from './lob';
import { kickErrorAim, passAccuracy, selectReceiver } from './pass';

/** TUNING-CR (SIM-10): proposed additions to T_PASS (units in the comments). */
export const LOCAL_TUNING = { // TUNING-CR
  // ---- lead search
  /** Lead distance range ahead of the runner along his run, m, and the number of samples over it. */
  leadMin: 0,
  leadMax: 30,
  leadSamples: 16,
  /** No sample in time: the least-late one is still played (ball at full speed / flattest angle) when it is at most
   *  this late for the runner, s. */
  maxLateSec: 0.6,
  /** Runners slower than this (or running backward) are led toward the attacked goal, m/s. */
  runMinSpeed: 1,
  /** Runner times below this cannot be met by a kicked ball, s. */
  minRunnerTime: 0.1,
  /** Lead points closer to the ball than this are skipped, m. */
  minBallDist: 3,
  /** In stride: a ground through ball arrives with at least arriveMin m/s and at most arriveRelMax m/s relative to the
   *  runner's velocity there (his sprint speed toward the point, accelerating from his current speed), m/s
   *  (both x T_PASS.drivenMul when driven). */
  arriveMin: 2.5,
  arriveRelMax: 6,
  /** Ground through-ball launch speed range, m/s (driven: max x T_PASS.drivenMul). */
  groundSpeedMin: 5,
  groundSpeedMax: 22,
  /** Lofted launch angle windows, rad: lobbed (over the line) and dinked. */
  lobbedAngleMin: 0.5,
  lobbedAngleMax: 1.0,
  dinkedAngleMin: 0.3,
  dinkedAngleMax: 0.6,
  /** Lofted angles when no runner timing applies, rad. */
  lobbedAngle: 0.7,
  dinkedAngle: 0.45,
  /** A lofted through ball lands this long before the runner reaches the lead point, s. */
  loftLandEarly: 0.05,
  /** Lofted flight-time refinement with drag: Newton steps on the launch angle, and the tolerance, s. */
  loftTimeIters: 3,
  loftTimeTol: 0.02,
  /** Shortest lofted flight considered, s. */
  minFlight: 0.25,
  /** Max launch speed of a lofted through ball, m/s. */
  loftSpeedMax: 30,
  /** Backspin of a lobbed through ball (a dinked one has none), rad/s. */
  lobbedBackspin: 2,
  // ---- space and danger
  /** Opponents: reaction time (s), run speed (m/s), reach (m) and the margin the runner must beat them by (s). */
  oppReact: 0.2,
  oppSpeed: 7.5,
  oppReach: 1.0,
  defMargin: 0.15,
  /** The keeper: run speed (m/s); inside his penalty area (claim zone) reach (m) and margin (s). */
  keeperSpeed: 6.5,
  /** A ground ball passing within this distance of an opponent runs into him (body + ball), m. */
  blockReach: 0.6,
  keeperReach: 2.0,
  keeperMargin: 0.4,
  /** Lead points stay this far inside the touchlines and this far out from the goal lines, m. */
  pitchMargin: 1.5,
  goalLineMargin: 4,
  // ---- into space / fallbacks
  /** Into space (no runner / Manual): distance at power 0 and 1, m; arrival speed, m/s. */
  spaceDistMin: 12,
  spaceDistMax: 40,
  spaceArrive: 4,
  /** Fallback lead when no sample is feasible: this many seconds of the runner's run, plus this many metres, s / m. */
  fallbackLeadSec: 1,
  fallbackLeadExtra: 3,
  /** Power floor (an instant tap), 0..1. */
  minPower: 0.05,
  /** Semi assistance: share of the power-only speed blended into the timed speed, 0..1. */
  semiPowerBlend: 0.4,
  /** Lengthwise error: speed x (1 + lengthErrorMul x a second angular error draw in rad), clamped to +-lengthErrorCap. */
  lengthErrorMul: 0.4,
  lengthErrorCap: 0.1,
  /** Accuracy = visionShare x vision + (1 - visionShare) x passing accuracy, 0..1. */
  visionShare: 0.5,
  // ---- runner selection
  /** Cone half-angle multipliers on T_PASS.coneHalfAngle: Assisted and Semi. */
  coneMul: 1.3,
  semiConeMul: 0.8,
  /** Candidate distance range from the passer, m. */
  minRunnerDist: 5,
  maxRunnerDist: 55,
  /** Score weights: alignment with the stick, forward run, at / beyond the line, SIM-08 selectReceiver pick. */
  wAlign: 0.4,
  wRun: 0.35,
  wBeyond: 0.25,
  wSim08: 0.2,
  /** Forward run speed that scores 1, m/s; the "beyond the line" score ramps up over this band behind the line, m. */
  runNorm: 7,
  beyondBand: 6,
} as const;

const LT = LOCAL_TUNING;

const NS = NUM_SLOTS;
const PPT = PLAYERS_PER_TEAM;
const HZ = TICK_HZ;
const G = T_BALL.gravity;
const ROLL_A = T_BALL.rollDecel;
const ROLL_C = T_BALL.rollDamping;
const ROLL_K = ROLL_C > 0 ? ROLL_A / ROLL_C : 0;
const LIM_X = HALF_LENGTH - LT.goalLineMargin;
const LIM_Z = HALF_WIDTH - LT.pitchMargin;
const SPACE_LIM_X = HALF_LENGTH - 1;
const SPACE_LIM_Z = HALF_WIDTH - 1;
const COS_CONE = dcos(T_PASS.coneHalfAngle * LT.coneMul);
const COS_CONE_SEMI = dcos(T_PASS.coneHalfAngle * LT.semiConeMul);
const N = LT.leadSamples;
/** tan of the lofted minimum / maximum angles by mode (index 1 lobbed, 2 dinked). */
const TAN_MIN = new Float64Array([0, dsin(LT.lobbedAngleMin) / dcos(LT.lobbedAngleMin), dsin(LT.dinkedAngleMin) / dcos(LT.dinkedAngleMin)]);
const TAN_MAX = new Float64Array([0, dsin(LT.lobbedAngleMax) / dcos(LT.lobbedAngleMax), dsin(LT.dinkedAngleMax) / dcos(LT.dinkedAngleMax)]);
const AIM_MIN_DIST = 0.25;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

/** Per-sample lead point, runner time (s), launch value (ground v0 m/s, lofted tan(angle)). */
const SX = new Float64Array(N);
const SZ = new Float64Array(N);
const STR = new Float64Array(N);
const SV = new Float64Array(N);
/** Per-sample lateness of the fastest ball (s; Infinity when not playable at all). */
const SLATE = new Float64Array(N);
/** Per-sample status: 0 late / infeasible, 1 ideal, 2 early, 3 firm; danger flag. */
const SST = new Uint8Array(N);
const SDG = new Uint8Array(N);
const ST_LATE = 0, ST_IDEAL = 1, ST_EARLY = 2, ST_FIRM = 3;

/** Launch solution scratch (a literal: nothing from a module in the registry import cycle is read at evaluation). */
const SOL: LaunchSolution = { vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, speed: 0, flightT: 0, landX: 0, landZ: 0, reached: 0 };
/** Solver scratch. */
const F = new Float64Array(24);
/** Lead result: point, runner time (s), launch value, status. */
const F_LX = 0, F_LZ = 1, F_LT = 2, F_LV = 3;
/** Target point, distance, unit aim. */
const F_TX = 4, F_TZ = 5, F_D = 6, F_UX = 7, F_UZ = 8;
/** Launch velocity (x, y, z) being built. */
const F_VX = 9, F_VY = 10, F_VZ = 11;
/** Lead-search model inputs / outputs (handed between helpers without double arguments): point, ball start, distance,
 *  time, launch speed, arrival speed, rolled distance, e^-x work slot. */
const F_CPX = 12, F_CPZ = 13, F_CBX = 14, F_CBZ = 15, F_CD = 16, F_CT = 17, F_V0 = 18, F_VA = 19, F_CX = 20, F_EX = 21;

// ---------------------------------------------------------------- small helpers

function validSlot(i: number): boolean { return i >= 0 && i < NS && (i | 0) === i; }
function fin(v: number): number { return v === v && v < Infinity && v > -Infinity ? v : 0; }
function clamp01(v: number): number { return v > 0 ? (v < 1 ? v : 1) : 0; }
function attr01(v: number): number { return clamp01((fin(v) - 1) / 98); }

/** True for THROUGH_GROUND, THROUGH_LOBBED, THROUGH_DINKED. */
export function isThroughKind(k: KickKind): boolean {
  return k === KickKind.THROUGH_GROUND || k === KickKind.THROUGH_LOBBED || k === KickKind.THROUGH_DINKED;
}

function isTeammate(s: SimState, slot: number, j: number): boolean {
  if (!validSlot(j) || j === slot) return false;
  const q = s.players[j]!;
  return q.active === 1 && q.team === s.players[slot]!.team;
}

/**
 * e^-x for 0 <= x <= ~1 (the roll model's e^-cT, cT < 1 over any horizon used here): plain-arithmetic Taylor series
 * (12 terms, error < 1e-9 there), evaluated in place from F[F_EX] into F[F_EX]. Allocation-free (dmath.dexp boxes its
 * result in V8), deterministic.
 */
function expNegInPlace(): void {
  const x = F[F_EX]!;
  let sum = 1, term = 1;
  for (let k = 1; k <= 12; k++) { term *= -x / k; sum += term; }
  F[F_EX] = sum;
}

/**
 * Ground launch speed (m/s) that covers D m in exactly T s under SIM-02's roll model, closed form (dv/dt = -a - c v:
 * v0 = (D + kT) c / (1 - e^-cT) - k, k = a / c). Reads D = F[F_CD], T = F[F_CT]; writes the launch speed to F[F_V0]
 * and the arrival speed to F[F_VA] (negative when the ball would have to stop first). No double arguments (V8 boxes
 * them), no allocation.
 */
function timedGroundSpeed(): void {
  const D = F[F_CD]!, T = F[F_CT]!;
  if (ROLL_C > 0) {
    F[F_EX] = ROLL_C * T;
    expNegInPlace();
    const e = F[F_EX]!;
    const v0 = (D + ROLL_K * T) * ROLL_C / (1 - e) - ROLL_K;
    F[F_V0] = v0;
    F[F_VA] = (v0 + ROLL_K) * e - ROLL_K;
    return;
  }
  const v0 = D / T + 0.5 * ROLL_A * T;
  F[F_V0] = v0;
  F[F_VA] = v0 - ROLL_A * T;
}

/**
 * Distance (m) a ground ball launched at F[F_V0] m/s has rolled after F[F_CT] s under SIM-02's roll model (closed form;
 * it stops at v = 0), into F[F_CX]. No allocation.
 */
function rolledDist(): void {
  const v0 = F[F_V0]!;
  let t = F[F_CT]!;
  if (!(v0 > 0) || !(t > 0)) { F[F_CX] = 0; return; }
  if (ROLL_C > 0) {
    F[F_EX] = ROLL_C * t;
    expNegInPlace();
    const e = F[F_EX]!;
    if ((v0 + ROLL_K) * e - ROLL_K >= 0) {
      F[F_CX] = (v0 + ROLL_K) * (1 - e) / ROLL_C - ROLL_K * t;
      return;
    }
    // Stopped before t: the full stopping distance x(v0, 0) = v0 / c - (k / c) ln((v0 + k) / k).
    F[F_CX] = v0 / ROLL_C - (ROLL_K / ROLL_C) * dlog((v0 + ROLL_K) / ROLL_K);
    return;
  }
  const ts = v0 / ROLL_A;
  if (t > ts) t = ts;
  F[F_CX] = v0 * t - 0.5 * ROLL_A * t * t;
}

/**
 * True if an opponent of `team` reaches the point (F_CPX, F_CPZ) before the runner (who needs F_CT s) with the margin,
 * or, for a ground ball launched at F_V0 m/s (0 = no path check) from (F_CBX, F_CBZ) over F_CD m, reaches its path before
 * the ball has passed his projection on it (or stands on it). Inputs in F (no boxed double arguments); allocation-free.
 */
function contested(s: SimState, team: number): boolean {
  const px = F[F_CPX]!, pz = F[F_CPZ]!, tr = F[F_CT]!, v0 = F[F_V0]!, bx = F[F_CBX]!, bz = F[F_CBZ]!, D = F[F_CD]!;
  const oFirst = team === 0 ? PPT : 0;
  const attDir = s.teams[team]!.dir >= 0 ? 1 : -1;
  // geometry.inPenaltyArea of the attacked end, inlined (no double arguments).
  const u = attDir * px;
  const inBox = u >= HALF_LENGTH - PENALTY_AREA_DEPTH && u <= HALF_LENGTH && pz >= -PENALTY_AREA_HALF_WIDTH && pz <= PENALTY_AREA_HALF_WIDTH;
  const lx = px - bx, lz = pz - bz;
  const ground = v0 > 0 && D > 1e-6;
  for (let j = oFirst; j < oFirst + PPT; j++) {
    const o = s.players[j]!;
    if (o.active !== 1) continue;
    const gk = o.isKeeper === 1;
    const claim = gk && inBox;
    const spd = gk ? LT.keeperSpeed : LT.oppSpeed;
    const reach = claim ? LT.keeperReach : LT.oppReach;
    const margin = claim ? LT.keeperMargin : LT.defMargin;
    const dx = o.x - px, dz = o.z - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    const to = LT.oppReact + (d > reach ? (d - reach) / spd : 0);
    if (to < tr + margin) return true;
    if (!ground) continue;
    const ox = o.x - bx, oz = o.z - bz;
    const along = (ox * lx + oz * lz) / D;
    if (!(along > 0 && along < D)) continue;
    let perp = (ox * lz - oz * lx) / D;
    if (perp < 0) perp = -perp;
    // On the path: the ball runs into him whatever his reaction.
    if (perp <= LT.blockReach) return true;
    const tOpp = LT.oppReact + (perp > LT.oppReach ? (perp - LT.oppReach) / spd : 0);
    // Cheap reject first: the ball is never faster than its launch speed.
    if (!(tOpp < along / v0)) continue;
    // Has the ball passed his projection by the time he gets there?
    F[F_CT] = tOpp;
    rolledDist();
    F[F_CT] = tr;
    if (F[F_CX]! < along) return true;
  }
  return false;
}

/** Nearest sample to `from` (shorter lead first on ties) with status in mask (bit per status) and no danger; -1. */
function nearestSafe(from: number, mask: number, n: number): number {
  for (let d = 0; d < n; d++) {
    const a = from - d;
    if (a >= 0 && ((mask >> SST[a]!) & 1) === 1 && SDG[a] === 0) return a;
    const b = from + d;
    if (d > 0 && b < n && ((mask >> SST[b]!) & 1) === 1 && SDG[b] === 0) return b;
  }
  return -1;
}

/**
 * Lead search for a through ball from slot to runner r (see the header). mode 0 = ground, 1 = lobbed, 2 = dinked;
 * driven scales the ground arrival window. Writes F_LX / F_LZ (point), F_LT (runner time, s), F_LV (ground v0 or
 * lofted tan(angle)). Returns 1, or 0 when no sample is feasible.
 */
function leadSearch(s: SimState, slot: number, r: number, power: number, mode: number, driven: boolean): number {
  const p = s.players[slot]!;
  const q = s.players[r]!;
  const b = s.ball;
  const team = p.team;
  const dir = s.teams[team]!.dir >= 0 ? 1 : -1;
  const qvx = fin(q.vx), qvz = fin(q.vz);
  const sp = Math.sqrt(qvx * qvx + qvz * qvz);
  let rx: number = dir, rz = 0;
  if (sp > LT.runMinSpeed && qvx * dir >= 0) { rx = qvx / sp; rz = qvz / sp; }
  const amul = driven ? T_PASS.drivenMul : 1;
  const amin = LT.arriveMin * amul, relMax = LT.arriveRelMax * amul;
  const vmaxG = LT.groundSpeedMax * amul;
  const top = maxSpeed(s, r, true);
  const acc = s.attrs[r]!.accel > 0 ? s.attrs[r]!.accel : T_PLAYER.accelMin;
  const step = (LT.leadMax - LT.leadMin) / (N - 1);
  const ground = mode === 0;
  let n = 0;
  for (let i = 0; i < N; i++) {
    const L = LT.leadMin + step * i;
    let px = q.x + rx * L, pz = q.z + rz * L;
    if (px < -LIM_X) px = -LIM_X; else if (px > LIM_X) px = LIM_X;
    if (pz < -LIM_Z) pz = -LIM_Z; else if (pz > LIM_Z) pz = LIM_Z;
    // Clamped against a line: further samples repeat the same point.
    if (i > 0 && px === SX[i - 1] && pz === SZ[i - 1]) break;
    SX[i] = px; SZ[i] = pz;
    n = i + 1;
    const tr = ticksToReach(s, r, px, pz) / HZ;
    STR[i] = tr;
    const dx = px - b.x, dz = pz - b.z;
    const D = Math.sqrt(dx * dx + dz * dz);
    let st = ST_LATE;
    SV[i] = 0;
    SLATE[i] = Infinity;
    F[F_CD] = D; F[F_CT] = tr;
    if (D >= LT.minBallDist && tr >= LT.minRunnerTime) {
      if (ground) {
        timedGroundSpeed();
        const v0 = F[F_V0]!;
        const va = F[F_VA]!;
        SV[i] = v0;
        if (v0 > vmaxG) {
          st = ST_LATE;
          // Lateness of a full-speed ball: its shortfall at tr over its speed then (closed form).
          F[F_V0] = vmaxG;
          rolledDist();
          const short = D - F[F_CX]!;
          F[F_EX] = ROLL_C * tr;
          expNegInPlace();
          const vt = ROLL_C > 0 ? (vmaxG + ROLL_K) * F[F_EX]! - ROLL_K : vmaxG - ROLL_A * tr;
          if (vt > 0.5) SLATE[i] = short / vt;
        }
        else if (va < amin || v0 < LT.groundSpeedMin) st = ST_EARLY;
        else {
          // Ball velocity at the meeting relative to his (sprinting toward the point, accelerating from now).
          const mx = px - q.x, mz = pz - q.z;
          const md = Math.sqrt(mx * mx + mz * mz);
          let vm = Math.sqrt(sp * sp + 2 * acc * md);
          if (vm > top) vm = top;
          const rvx = va * dx / D - (md > 1e-6 ? vm * mx / md : 0);
          const rvz = va * dz / D - (md > 1e-6 ? vm * mz / md : 0);
          st = rvx * rvx + rvz * rvz > relMax * relMax ? ST_FIRM : ST_IDEAL;
        }
      } else {
        // Drag-free flight time T = sqrt(2 D tan(th) / g): the angle for T = tf is tan(th) = g tf^2 / (2 D). Compared
        // and stored as tangents (no trig per sample); speed^2 = g D / sin(2 th) = g D (1 + t^2) / (2 t).
        const tf = tr - LT.loftLandEarly;
        if (tf >= LT.minFlight) {
          const t = G * tf * tf / (2 * D);
          const tMin = TAN_MIN[mode]!, tMax = TAN_MAX[mode]!;
          if (t < tMin) {
            SV[i] = tMin;
            SLATE[i] = Math.sqrt(2 * D * tMin / G) - tf;
          } else {
            const tc = t > tMax ? tMax : t;
            const v2 = G * D * (1 + tc * tc) / (2 * tc);
            SV[i] = tc;
            st = v2 > LT.loftSpeedMax * LT.loftSpeedMax ? ST_LATE : t > tMax ? ST_EARLY : ST_IDEAL;
          }
        }
      }
    }
    SST[i] = st;
    let v0 = 0;
    if (ground) {
      v0 = st === ST_LATE ? vmaxG : SV[i]!;
      // An early ball is launched to arrive at amin (no-damping estimate: a little slow, so the check errs safe).
      if (st === ST_EARLY) v0 = Math.sqrt(amin * amin + 2 * ROLL_A * D);
    }
    SDG[i] = 1;
    if (st !== ST_LATE || SLATE[i]! <= LT.maxLateSec) {
      F[F_CPX] = px; F[F_CPZ] = pz; F[F_CT] = tr; F[F_V0] = v0; F[F_CBX] = b.x; F[F_CBZ] = b.z; F[F_CD] = D;
      SDG[i] = contested(s, team) ? 1 : 0;
    }
  }
  // Power picks within the ideal samples; danger moves the pick.
  let lo = -1, hi = -1;
  for (let i = 0; i < n; i++) {
    if (SST[i] === ST_IDEAL) { if (lo < 0) lo = i; hi = i; }
  }
  const IDEAL = 1 << ST_IDEAL;
  const OTHER = (1 << ST_EARLY) | (1 << ST_FIRM);
  let pick = -1;
  if (lo >= 0) {
    pick = (lo + clamp01(power) * (hi - lo) + 0.5) | 0;
    if (SST[pick] !== ST_IDEAL) {
      // Non-contiguous ideal run: nearest ideal sample.
      for (let d = 1; d < n; d++) {
        if (pick - d >= 0 && SST[pick - d] === ST_IDEAL) { pick -= d; break; }
        if (pick + d < n && SST[pick + d] === ST_IDEAL) { pick += d; break; }
      }
    }
    if (SDG[pick] === 1) {
      let safe = nearestSafe(pick, IDEAL, n);
      if (safe < 0) safe = nearestSafe(pick, OTHER, n);
      if (safe >= 0) pick = safe;
    }
  } else {
    for (let i = 0; i < n && pick < 0; i++) if (SST[i] === ST_EARLY && SDG[i] === 0) pick = i;
    for (let i = 0; i < n && pick < 0; i++) if (SST[i] === ST_EARLY) pick = i;
    for (let i = n - 1; i >= 0 && pick < 0; i--) if (SST[i] === ST_FIRM) pick = i;
  }
  if (pick < 0) {
    // Nothing in time: the least-late sample (safe first) when it is late by at most maxLateSec.
    let best: number = LT.maxLateSec;
    for (let pass = 0; pass < 2 && pick < 0; pass++) {
      for (let i = 0; i < n; i++) {
        if (SST[i] !== ST_LATE || (pass === 0 && SDG[i] === 1)) continue;
        const late = SLATE[i]!;
        if (late <= best) { best = late; pick = i; }
      }
    }
  }
  if (pick < 0) return 0;
  F[F_LX] = SX[pick]!;
  F[F_LZ] = SZ[pick]!;
  F[F_LT] = STR[pick]!;
  F[F_LV] = SV[pick]!;
  return 1;
}

// ---------------------------------------------------------------- public queries

/** Lead point for a through ball to runner target from slot with power 0..1. Returns 0 if no sensible lead. */
export function throughLeadPoint(s: SimState, slot: number, target: number, power: number, lofted: number, out: { x: number; z: number }): number {
  if (!validSlot(slot) || !isTeammate(s, slot, target)) return 0;
  if (leadSearch(s, slot, target, clamp01(fin(power)), lofted === 1 ? 1 : 0, false) !== 1) return 0;
  out.x = F[F_LX]!;
  out.z = F[F_LZ]!;
  return 1;
}

/**
 * Runner for a through ball from slot (see the header): teammates in the cone around (dirX, dirZ) (facing when 0, 0)
 * scored by alignment, forward run, line position and SIM-08 selectReceiver's pick. Returns a slot or -1. Pure.
 */
export function selectRunner(s: SimState, slot: number, dirX: number, dirZ: number, power: number, assist: number, lofted: number): number {
  if (!validSlot(slot) || assist === AssistLevel.MANUAL) return -1;
  const p = s.players[slot]!;
  let ux = fin(dirX), uz = fin(dirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > 1e-6)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  ux /= ul; uz /= ul;
  const base = selectReceiver(s, slot, ux, uz, power, assist, lofted === 1 ? 1 : 0);
  const team = p.team;
  const dir = s.teams[team]!.dir >= 0 ? 1 : -1;
  const line = dir * secondLastDefenderX(s, team === 0 ? 1 : 0);
  const cosCone = assist === AssistLevel.SEMI ? COS_CONE_SEMI : COS_CONE;
  const first = team === 0 ? 0 : PPT;
  let best = -1;
  let bestScore = -1e18;
  for (let i = first; i < first + PPT; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!(d >= LT.minRunnerDist) || d > LT.maxRunnerDist) continue;
    const c = (dx * ux + dz * uz) / d;
    if (!(c >= cosCone)) continue;
    const align = (c - cosCone) / (1 - cosCone);
    let run = dir * fin(q.vx) / LT.runNorm;
    if (run > 1) run = 1; else if (run < -1) run = -1;
    const beyond = clamp01((dir * q.x - line + LT.beyondBand) / LT.beyondBand);
    const score = LT.wAlign * align + LT.wRun * run + LT.wBeyond * beyond + (i === base ? LT.wSim08 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best >= 0 ? best : base;
}

// ---------------------------------------------------------------- starter

export function startThrough(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot) || !isThroughKind(kind)) return 0;
  return beginFootKick(s, slot, kind, req);
}

// ---------------------------------------------------------------- solver

/** Distance from the ball to (F_TX, F_TZ) into F_D, unit aim into F_UX / F_UZ; false when on top of the ball. */
function aimDist(s: SimState): boolean {
  const b = s.ball;
  const dx = F[F_TX]! - b.x, dz = F[F_TZ]! - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  F[F_D] = d;
  if (!(d > AIM_MIN_DIST)) return false;
  F[F_UX] = dx / d;
  F[F_UZ] = dz / d;
  return true;
}

function solveThroughImpl(s: SimState, slot: number, out: KickLaunch): number {
  out.vx = 0; out.vy = 0; out.vz = 0; out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = KickKind.THROUGH_GROUND; out.target = -1; out.tx = 0; out.tz = 0; out.onTarget = 0;
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  const kind = isThroughKind(p.actKick) ? p.actKick : KickKind.THROUGH_GROUND;
  const mode = kind === KickKind.THROUGH_LOBBED ? 1 : kind === KickKind.THROUGH_DINKED ? 2 : 0;
  const meta = fin(p.actB) | 0;
  let assist = meta & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  const hasTarget = (meta >> 2) & 1;
  let power = clamp01(fin(p.actPower));
  if (power < LT.minPower) power = LT.minPower;
  const driven = mode === 0 && (fin(p.actA) & ReqFlag.DRIVEN) !== 0;
  const amul = driven ? T_PASS.drivenMul : 1;
  // Request direction (facing, then the attack direction, when unset).
  let ux = fin(p.actDirX), uz = fin(p.actDirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > 1e-6)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  ux /= ul; uz /= ul;
  let r = -1;
  if (isTeammate(s, slot, p.actSlot)) r = p.actSlot;
  else if (hasTarget === 0 && assist !== AssistLevel.MANUAL) r = selectRunner(s, slot, ux, uz, power, assist, mode !== 0 ? 1 : 0);
  let tr = -1;
  let have = false;
  if (hasTarget === 1) {
    F[F_TX] = p.actX; F[F_TZ] = p.actZ;
    have = aimDist(s);
    if (have && r >= 0) tr = ticksToReach(s, r, F[F_TX]!, F[F_TZ]!) / HZ;
  } else if (r >= 0 && assist !== AssistLevel.MANUAL) {
    if (leadSearch(s, slot, r, power, mode, driven) === 1) {
      F[F_TX] = F[F_LX]!; F[F_TZ] = F[F_LZ]!;
      have = aimDist(s);
      if (have) tr = F[F_LT]!;
    }
    if (!have) {
      // No feasible timing: a lead ahead of him along his run (toward goal when standing); the ball is untimed.
      const q = s.players[r]!;
      const dir = s.teams[p.team]!.dir >= 0 ? 1 : -1;
      const qvx = fin(q.vx), qvz = fin(q.vz);
      const sp = Math.sqrt(qvx * qvx + qvz * qvz);
      const lead = sp * LT.fallbackLeadSec + LT.fallbackLeadExtra;
      let rx: number = dir, rz = 0;
      if (sp > LT.runMinSpeed && qvx * dir >= 0) { rx = qvx / sp; rz = qvz / sp; }
      let tx = q.x + rx * lead, tz = q.z + rz * lead;
      if (tx < -LIM_X) tx = -LIM_X; else if (tx > LIM_X) tx = LIM_X;
      if (tz < -LIM_Z) tz = -LIM_Z; else if (tz > LIM_Z) tz = LIM_Z;
      F[F_TX] = tx; F[F_TZ] = tz;
      have = aimDist(s);
    }
  }
  if (!have) {
    // Into space along the request direction.
    const d = LT.spaceDistMin + (LT.spaceDistMax - LT.spaceDistMin) * power;
    let tx = b.x + ux * d, tz = b.z + uz * d;
    if (tx < -SPACE_LIM_X) tx = -SPACE_LIM_X; else if (tx > SPACE_LIM_X) tx = SPACE_LIM_X;
    if (tz < -SPACE_LIM_Z) tz = -SPACE_LIM_Z; else if (tz > SPACE_LIM_Z) tz = SPACE_LIM_Z;
    F[F_TX] = tx; F[F_TZ] = tz;
    if (!aimDist(s)) { F[F_TX] = b.x + ux * d; F[F_TZ] = b.z + uz * d; aimDist(s); }
    tr = -1;
  }
  const D = F[F_D]!;
  const timed = tr >= LT.minRunnerTime && assist !== AssistLevel.MANUAL;
  if (mode === 0) {
    let v: number;
    if (timed) {
      F[F_CD] = D; F[F_CT] = tr;
      timedGroundSpeed();
      v = F[F_V0]!;
      if (F[F_VA]! < LT.arriveMin * amul) v = groundPassSpeed(D, LT.arriveMin * amul);
    } else {
      v = groundPassSpeed(D, LT.spaceArrive * amul);
    }
    const pv = (T_PASS.groundMin + (T_PASS.groundMax - T_PASS.groundMin) * power) * amul;
    if (assist === AssistLevel.SEMI) v += (pv - v) * LT.semiPowerBlend;
    else if (assist === AssistLevel.MANUAL) v = pv;
    const vmax = LT.groundSpeedMax * amul;
    if (!(v >= LT.groundSpeedMin)) v = LT.groundSpeedMin;
    if (v > vmax) v = vmax;
    F[F_VX] = F[F_UX]! * v; F[F_VY] = 0; F[F_VZ] = F[F_UZ]! * v;
    out.sx = 0; out.sy = 0; out.sz = 0;
  } else {
    const thMin = mode === 2 ? LT.dinkedAngleMin : LT.lobbedAngleMin;
    const thMax = mode === 2 ? LT.dinkedAngleMax : LT.lobbedAngleMax;
    let th: number = mode === 2 ? LT.dinkedAngle : LT.lobbedAngle;
    const back = mode === 1 ? LT.lobbedBackspin : 0;
    const dx = F[F_TX]! - b.x, dz = F[F_TZ]! - b.z;
    if (timed) {
      let tf = tr - LT.loftLandEarly;
      if (tf < LT.minFlight) tf = LT.minFlight;
      th = datan(G * tf * tf / (2 * D));
      if (th < thMin) th = thMin;
      if (th > thMax) th = thMax;
      // Drag lengthens the flight: Newton steps on the solved flight time (drag-free slope dT/dth = T / sin 2th).
      for (let it = 0; it < LT.loftTimeIters; it++) {
        solveLaunchSpin(dx, dz, th, b.y, 0, back, SOL);
        const T = SOL.flightT;
        const e = T - tf;
        if (!(T > 0) || (e < LT.loftTimeTol && e > -LT.loftTimeTol)) break;
        let nth = th - e * dsin(2 * th) / T;
        if (nth < thMin) nth = thMin;
        if (nth > thMax) nth = thMax;
        if (nth === th) break;
        th = nth;
      }
    }
    solveLaunchSpin(dx, dz, th, b.y, 0, back, SOL);
    const k = SOL.speed > LT.loftSpeedMax && SOL.speed > 0 ? LT.loftSpeedMax / SOL.speed : 1;
    F[F_VX] = SOL.vx * k; F[F_VY] = SOL.vy * k; F[F_VZ] = SOL.vz * k;
    out.sx = SOL.sx; out.sy = SOL.sy; out.sz = SOL.sz;
  }
  if (r < 0) r = attackerNear(s, slot, F[F_TX]!, F[F_TZ]!, tr > 0 ? tr : 1);
  // Error: rotation and a lengthwise speed scale.
  const a = s.attrs[slot]!;
  const acc = LT.visionShare * attr01(a.vision) + (1 - LT.visionShare) * passAccuracy(s, slot, D);
  const vx0 = F[F_VX]!, vz0 = F[F_VZ]!;
  const err = kickErrorAim(s, slot, power, acc, vx0, vz0);
  const lenErr = kickErrorAim(s, slot, power, acc, vx0, vz0);
  let ks = 1 + LT.lengthErrorMul * lenErr;
  if (ks < 1 - LT.lengthErrorCap) ks = 1 - LT.lengthErrorCap;
  if (ks > 1 + LT.lengthErrorCap) ks = 1 + LT.lengthErrorCap;
  // The kind's max launch speed holds after the error too.
  const vcap = mode === 0 ? LT.groundSpeedMax * amul : LT.loftSpeedMax;
  const vy0 = F[F_VY]!;
  const sp = Math.sqrt(vx0 * vx0 + vy0 * vy0 + vz0 * vz0) * ks;
  if (sp > vcap && sp > 0) ks *= vcap / sp;
  const ce = dcos(err), se = dsin(err);
  out.vx = (vx0 * ce - vz0 * se) * ks;
  out.vz = (vx0 * se + vz0 * ce) * ks;
  out.vy = vy0 * ks;
  const sx0 = out.sx, sz0 = out.sz;
  out.sx = sx0 * ce - sz0 * se;
  out.sz = sx0 * se + sz0 * ce;
  out.kind = kind;
  out.target = r;
  out.tx = F[F_TX]!;
  out.tz = F[F_TZ]!;
  return 1;
}

bindThroughImpl({ solveThrough: solveThroughImpl });

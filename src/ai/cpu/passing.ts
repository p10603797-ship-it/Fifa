/**
 * [TAI-09] CPU pass, cross and through-ball evaluation: for each teammate, completion chance (lanes vs
 * opponents' reach using SIM-04 ticksToReach and SIM-01 prediction), progress, danger created; through-ball
 * lead points (SIM-10), cross targets (SIM-09). Allocation-free; results in a caller-provided array.
 *
 * HOW IT WORKS
 *  laneSafety(s, team, x0, z0, x1, z1, speed, lofted) — completion probability 0..1 of a ball from (x0, z0) to
 *  (x1, z1) struck at `speed` m/s (launch speed, capped at T_BALL.maxSpeed) for `team`, against every active
 *  opponent (keeper included):
 *   - Ball time along the lane. Ground: SIM-01/02's roll model (dv/dt = -rollDecel - rollDamping x v) solved in closed
 *     form for the time to the end (the same equations as SIM-01 groundRollTime, evaluated inline so nothing is
 *     boxed; tests pin the two together), then a constant-deceleration fit through (0, v0) and (L, t(L)) gives t(u) at
 *     any point u (sqrt only). A ball that stops short is judged up to its stop point and scaled by (stop / L)^2.
 *     Lofted: drag-free projectile on the low trajectory for that speed with a drag-equivalent range R x (1 +
 *     loftDragPerM x R) and flight time x (1 - loftTimePerM x R) (fitted to SIM-01 solveLaunchSpin); constant
 *     horizontal speed. Only the parts of a lofted lane below loftReachHeight (near the strike and the landing) can be
 *     reached. A speed that cannot carry the distance is taken to arrive anyway at the 45-degree horizontal speed (the
 *     caller chose the launch; this judges the lane).
 *   - Opponent time to a lane point (SIM-04 ticksToReach approximation, kept cheap): 0 when the path is within
 *     blockRadius of his body; reactS x (d - blockRadius) / (reach - blockRadius) when within his reach
 *     (T_TACKLE.interceptReach; a keeper in his own area keeperReachMul x that on the ground, keeperAirReach for
 *     lofted balls); else reactS + a run of (d - reach) from his speed toward the point (braking first at
 *     T_PLAYER.decel if moving away) accelerating to his top speed (attrs.topSpeed / accel x SIM-04 staminaFactor). A
 *     locked action or stun adds its remaining ticks.
 *   - Closest-approach geometry: per opponent and reachable segment, three candidate points: the foot of the
 *     perpendicular, the point where his chase angle matches the ball speed (along + perp x r / sqrt(1 - r^2), r =
 *     his top speed / ball speed there; the segment end when r >= chaseRatioMax) and the segment end. Interception
 *     chance at a point = cap x smoothstep(-marginLate, marginEarly, ball time - opponent time); cap = pMax, falling
 *     linearly to pEnd over the last endZone metres of a ground lane, and pEnd over a lofted ball's whole landing
 *     segment (the receiver competes there: an aerial duel). Completion = product over opponents of (1 - best
 *     chance). Opponents who cannot get near the lane in time are skipped early.
 *
 *  scorePassOptions(s, slot, out) — fills out[] with the carrier's options (the best out.length by score, sorted best
 *  first; ties keep scan order) and returns the count. The lanes start at the ball when he owns it, else at his feet.
 *  For each active teammate minDist .. T_PASS.maxRange away, not in an offside position (own computation of the
 *  RUL-08 rule — second-last defender, ball, halfway line — to stay out of an import cycle with sim/rules) and a keeper
 *  only within keeperMaxDist:
 *   - GROUND_PASS to his feet, led along his run over the travel time (SIM-08's model). Speed = SIM-01 groundPassSpeed
 *     (same inline roll model) for the distance and the arrival speed a CPU tap plays (groundArriveMin..Max by
 *     distance), clamped to T_PASS.groundMin..groundMax. The lane ends where he meets the ball (min(meetBackMax,
 *     meetBackFrac x distance) in front of him). Below drivenTrigger a DRIVEN_PASS (x T_PASS.drivenMul; completion x
 *     drivenCompletionMul [QF-11]) is tried too and the better one kept (a hard arrival above T_TOUCH.hardBallSpeed
 *     costs up to hardLoss).
 *   - LOB_PASS over a blocked lane (ground completion < lobTrigger, at least lobMinDist, carrier outside the crossing
 *     zone where a lob becomes a cross): lofted lane at T_PASS.lobAngle, led over the flight, aerial control
 *     lerp(aerialMin, aerialMax, ballControl).
 *   - THROUGH_GROUND for forward runners only (a run job RUN_IN_BEHIND / OVERLAP / LATE_RUN moving forward at >=
 *     runnerJobMinFwd, or running forward at >= runnerMinFwd with the forward share of his speed >= runnerFwdCos; never
 *     a keeper). Own lead model: his run (his velocity direction, accelerating to top speed) until the ball gets there
 *     (throughIters fixed-point steps), the ball arriving at least leadArriveMargin faster than he runs away from it
 *     (and at least throughArrive). SIM-10 throughLeadPoint replaces the point when it gives one (power = the own
 *     model's speed on the ground range, quantised to 0.2 steps). The lead must be >= throughMinLead ahead of him, the
 *     pass >= throughMinDist and forward. Completion also needs him there in time (own SIM-04-style run time vs the
 *     ball: late by more than throughSlackS loses up to all of it over throughLateS). Over a blocked lane a
 *     THROUGH_LOBBED (lob model) is tried too.
 *   - Every option: completion x receiver pressure at arrival (the nearest opponent's arrival at the reception point
 *     after the ball: x (1 - pressMax) at <= pressNear s, none at >= pressFar s) x accuracy (distance penalty: lateral
 *     miss = distance x sigma, sigma = T_PASS.errorMax x (accMinFrac + (1 - accMinFrac) x (1 - attr)^2) x (1 +
 *     accPressMul x carrier pressure) x loftErrMul when lofted; factor 1 / (1 + (miss / accTol)^2); attr = shortPassing
 *     .. longPassing blended over shortRange..longRange, vision blended in for through balls, crossing for crosses).
 *  Crosses (only while the carrier — not a keeper — is in the crossing zone): SIM-09 crossTarget at powers 0.3 / 0.6
 *  / 0.9 with the stick straight at the attacked goal line; a point outside the attacked penalty area means no answer
 *  and the own geometry is used (near post, penalty spot, far post); targets within crossDedupe of an earlier one are
 *  dropped. A target needs attacker presence: the onside outfield teammate (not the carrier) within crossAttackRange
 *  who gets there first must arrive no later than crossLateS after the ball (lofted at crossAngle); completion =
 *  lofted lane x his timing x crossing accuracy. Kind CROSS, target = that attacker.
 *  Progress = metres gained toward the attacked goal (dir x (x - ball x)). Danger 0..1 (xG-ish of the receiving spot;
 *  0 for a keeper): xgK x (angle subtended by the goal mouth)^2 capped at xgCap, x blockMul per outfield opponent in
 *  the shooting triangle (at most blockMax), + behindBonus (fading over behindRange m from goal) when the spot is
 *  behind the deepest outfield defender; a cross target x headerXgMul x lerp(0.6, 1, the attacker's heading).
 *  Score = weighted sum with the team style's weights (TAI-12 styleWeights; 0.5 = neutral):
 *    wCompletion x (0.5 + safety) x c + c x (wProgress x (0.5 + w) x clamp(progress / progressRef, -1, 1)
 *    + wDanger x (0.5 + w') x min(danger / dangerRef, dangerCapN)),
 *  w = directness for through balls and forward long balls (>= longBallDist), else progress; w' = directness
 *  (through), width (crosses), else progress.
 *
 * Determinism / cost: +, -, x, / and Math.sqrt only (logs by a fixed series, atan by a fixed polynomial), slot-order
 * loops with strict comparisons, no RNG; state is only read. Allocation-free: module-level typed scratch, and no
 * internal call passes or returns a double (V8 would box it). A full scan (10 teammates, ~25 lanes x 11 opponents
 * plus crosses) is well under 0.15 ms; callers stagger scans (T_AI.carrierEvalInterval).
 */
import {
  CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM, TICK_HZ,
} from '../../contracts/constants';
import { ActionKind, AiJob, KickKind } from '../../contracts/enums';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { T_BALL, T_PASS, T_PLAYER, T_RULES, T_TACKLE, T_TOUCH, T_PASSING } from '../../contracts/tuning';
import { crossTarget } from '../../sim/kicks/lob';
import { throughLeadPoint } from '../../sim/kicks/through';
import { staminaFactor } from '../../sim/players/locomotion';
import { styleWeights } from './levels';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_PASSING. */
export const LOCAL_TUNING = T_PASSING;


const LT = T_PASSING;

export interface PassOption {
  target: number;
  kind: KickKind;
  x: number;
  z: number;
  /** 0..1 */
  completion: number;
  /** metres gained toward goal */
  progress: number;
  /** 0..1 */
  danger: number;
  score: number;
}

export function createPassOptions(n: number): PassOption[] {
  return Array.from({ length: n }, () => ({ target: -1, kind: 0, x: 0, z: 0, completion: 0, progress: 0, danger: 0, score: 0 }));
}

// ---------------------------------------------------------------- scratch (module-level, typed: nothing is boxed)

/** Prepared opponents of the passing team (active only, slot order). */
const OX = new Float64Array(PLAYERS_PER_TEAM);
const OZ = new Float64Array(PLAYERS_PER_TEAM);
const OVX = new Float64Array(PLAYERS_PER_TEAM);
const OVZ = new Float64Array(PLAYERS_PER_TEAM);
const OTOP = new Float64Array(PLAYERS_PER_TEAM);
const OACC = new Float64Array(PLAYERS_PER_TEAM);
const OLOCK = new Float64Array(PLAYERS_PER_TEAM);
/** 1 = keeper; OBOX 1 = keeper inside his own penalty area (larger reach). */
const OKEEP = new Int32Array(PLAYERS_PER_TEAM);
const OBOX = new Int32Array(PLAYERS_PER_TEAM);
/** [0] = number of prepared opponents, [1] = number of options written by the current scan. */
const NI = new Int32Array(2);

/** Double registers: every internal function reads its double inputs and writes its results here. */
const F = new Float64Array(72);
// roll model (rollTime / passSpeed) and ln
const RS_V0 = 0, RS_D = 1, RS_VA = 2, RS_T = 3, RS_VEND = 4, LN_ARG = 5, LN_OUT = 6;
// a point (time kernels, pressure, danger)
const P_X = 7, P_Z = 8, P_REACH = 9, P_TB = 10, P_OUT = 11;
// lane inputs / outputs / internals
const L_X0 = 12, L_Z0 = 13, L_X1 = 14, L_Z1 = 15, L_SPEED = 16, L_SAFE = 17, L_TEND = 18, L_UX = 19, L_UZ = 20,
  L_LEN = 21, L_K = 22, L_VH = 23, L_LAND = 24, L_U = 25, L_P = 26, L_LO = 27, L_HI = 28, L_ALONG = 29, L_PERP = 30;
// scan context
const C_BX = 31, C_BZ = 32, C_DIR = 33, C_OFFU = 34, C_DEEPU = 35, C_PRESS = 36, C_SHORT = 37, C_LONG = 38,
  C_VISION = 39, C_CROSSING = 40, C_WC = 41, C_WP = 42, C_WPD = 43, C_WD = 44, C_WDD = 45, C_WDW = 46;
// option builders
const O_X = 47, O_Z = 48, O_V = 49, O_T = 50, O_C = 51, O_LANE = 52, O_ARR = 53, O_ACC_D = 54, O_ACC_A = 55;
// emit inputs
const E_X = 56, E_Z = 57, E_C = 58, E_PROG = 59, E_DANGER = 60, E_WP = 61, E_WD = 62;
/** Cross targets: F[CT + 2k] = x, F[CT + 2k + 1] = z for k = 0..2. */
const CT = 63;

/** SIM-09 / SIM-10 out-param. */
const PT = { x: 0, z: 0 };

/** sin(2a) for a launch angle a in (0, pi/4], by a fixed Taylor series (module load only). */
function sin2(a: number): number {
  const x = 2 * a;
  const x2 = x * x;
  let term = x, sum = x;
  for (let n = 1; n < 12; n++) {
    term *= -x2 / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

/** sin(2 x angle) of the lob and cross launch angles (deterministic constants). */
const SIN2_LOB = sin2(T_PASS.lobAngle);
const SIN2_CROSS = sin2(LT.crossAngle);

// ---------------------------------------------------------------- math kernels (typed-array I/O)

/** F[LN_OUT] = ln(F[LN_ARG]) for a positive argument: scale into [1, 2) by powers of 2, then the atanh series. */
function lnk(): void {
  let x = F[LN_ARG]!;
  if (!(x > 0) || !(x < 1e300)) { F[LN_OUT] = 0; return; }
  let k = 0;
  while (x >= 2) { x *= 0.5; k++; }
  while (x < 1) { x *= 2; k--; }
  const y = (x - 1) / (x + 1);
  const y2 = y * y;
  let t = y, sum = y;
  for (let n = 3; n <= 21; n += 2) {
    t *= y2;
    sum += t / n;
  }
  F[LN_OUT] = 2 * sum + k * 0.6931471805599453;
}

// [FIN-P2] Exact memo of the two roll-model solvers (rollTime, passSpeed): pure functions of their two inputs (the
// tuning they read never changes at run time), each a Newton solve of ~6-11 series logarithms. One carrier decision
// (scorePassOptions) solves rollTime ~79 times and passSpeed ~60 times, of which 13 and 21 with inputs it has already
// solved in that decision (the driven variant's first lead step, the through ball's own lead, the final solve at the
// lead point), so a small direct-mapped cache keyed by the inputs' exact bits returns the very doubles a solve would.
// Misses (and NaN inputs, which never match) solve as before. Results only depend on the inputs, so a hit can never
// change an outcome (tools/hash-table.ts IDENTICAL).
const MEMO_N = 64;
const MEMO_K = new Float64Array(2);
const MEMO_KW = new Uint32Array(MEMO_K.buffer);
const RT_IN = new Float64Array(2 * MEMO_N).fill(Number.NaN);
const RT_OUT = new Float64Array(2 * MEMO_N);
const PS_IN = new Float64Array(2 * MEMO_N).fill(Number.NaN);
const PS_OUT = new Float64Array(MEMO_N);

/** Slot of (MEMO_K[0], MEMO_K[1]) in a memo table: a mix of all four 32-bit words. */
function memoSlot(): number {
  let h = Math.imul(MEMO_KW[0]! ^ 0x9e3779b9, 0x85ebca6b) ^ MEMO_KW[1]!;
  h = Math.imul(h ^ (h >>> 15) ^ MEMO_KW[2]!, 0xc2b2ae35) ^ MEMO_KW[3]!;
  h ^= h >>> 13;
  return h & (MEMO_N - 1);
}

/** The roll-model tuning the memo was filled under (rollDecel, rollDamping, maxSpeed): a tool or test that changes
 *  T_BALL between calls empties the memo. */
const MEMO_T = new Float64Array(3).fill(Number.NaN);
function memoCheckTuning(): void {
  if (sameBits(MEMO_T[0]!, T_BALL.rollDecel) && sameBits(MEMO_T[1]!, T_BALL.rollDamping) && sameBits(MEMO_T[2]!, T_BALL.maxSpeed)) return;
  RT_IN.fill(Number.NaN);
  PS_IN.fill(Number.NaN);
  MEMO_T[0] = T_BALL.rollDecel; MEMO_T[1] = T_BALL.rollDamping; MEMO_T[2] = T_BALL.maxSpeed;
}

/** Same double, sign of zero included (NaN never matches: those inputs are always solved). */
function sameBits(a: number, b: number): boolean {
  return a === b && (a !== 0 || 1 / a === 1 / b);
}

/** rollTime through the memo (see above). */
function rollTime(): void {
  memoCheckTuning();
  const v0 = F[RS_V0]!, d = F[RS_D]!;
  MEMO_K[0] = v0; MEMO_K[1] = d;
  const k = memoSlot();
  if (sameBits(RT_IN[2 * k]!, v0) && sameBits(RT_IN[2 * k + 1]!, d)) {
    F[RS_T] = RT_OUT[2 * k]!; F[RS_VEND] = RT_OUT[2 * k + 1]!;
    return;
  }
  rollTimeSolve();
  RT_IN[2 * k] = v0; RT_IN[2 * k + 1] = d;
  RT_OUT[2 * k] = F[RS_T]!; RT_OUT[2 * k + 1] = F[RS_VEND]!;
}

/** passSpeed through the memo (see above). */
function passSpeed(): void {
  memoCheckTuning();
  const va = F[RS_VA]!, d = F[RS_D]!;
  MEMO_K[0] = va; MEMO_K[1] = d;
  const k = memoSlot();
  if (sameBits(PS_IN[2 * k]!, va) && sameBits(PS_IN[2 * k + 1]!, d)) {
    F[RS_V0] = PS_OUT[k]!;
    return;
  }
  passSpeedSolve();
  PS_IN[2 * k] = va; PS_IN[2 * k + 1] = d;
  PS_OUT[k] = F[RS_V0]!;
}

/**
 * SIM-01 groundRollTime (same roll model, inline): F[RS_T] = seconds for a ground ball launched at F[RS_V0] to roll
 * F[RS_D] m (-1 if it stops first), F[RS_VEND] = its speed there.
 */
function rollTimeSolve(): void {
  const v0 = F[RS_V0]!, d = F[RS_D]!;
  const a = T_BALL.rollDecel, c = T_BALL.rollDamping;
  if (!(d > 0)) { F[RS_T] = 0; F[RS_VEND] = v0 > 0 ? v0 : 0; return; }
  if (!(v0 > 0)) { F[RS_T] = -1; F[RS_VEND] = 0; return; }
  const disc = v0 * v0 - 2 * a * d;
  if (!(c > 1e-9)) {
    if (disc < 0) { F[RS_T] = -1; F[RS_VEND] = 0; return; }
    const ve = Math.sqrt(disc);
    F[RS_T] = (v0 - ve) / a; F[RS_VEND] = ve;
    return;
  }
  const icc = a / (c * c);
  const top = a + c * v0;
  F[LN_ARG] = top / a; lnk();
  const stopLn = F[LN_OUT]!;
  const stop = v0 / c - icc * stopLn;
  if (!(d <= stop * (1 + 1e-12) + 1e-12)) { F[RS_T] = -1; F[RS_VEND] = 0; return; }
  if (!(disc > 0) || d >= stop * (1 - 1e-12)) { F[RS_T] = stopLn / c; F[RS_VEND] = 0; return; } // comes to rest there
  // Newton on the speed at d, from the undamped speed (above the root; the residual is concave, so it converges
  // monotonically from above).
  let v = Math.sqrt(disc);
  for (let i = 0; i < 12; i++) {
    const den = a + c * v;
    F[LN_ARG] = top / den; lnk();
    const f = (v0 - v) / c - icc * F[LN_OUT]! - d;
    let nv = v + (f * den) / v;
    if (nv < 1e-9) nv = 1e-9;
    if (nv > v0) nv = v0;
    const dv = nv - v;
    v = nv;
    if (dv < 1e-10 && dv > -1e-10) break;
  }
  F[LN_ARG] = top / (a + c * v); lnk();
  F[RS_T] = F[LN_OUT]! / c;
  F[RS_VEND] = v;
}

/** SIM-01 groundPassSpeed (same roll model, inline): F[RS_V0] = launch speed that arrives at F[RS_D] m with F[RS_VA]
 *  m/s, in [arrival, T_BALL.maxSpeed]. */
function passSpeedSolve(): void {
  const a = T_BALL.rollDecel, c = T_BALL.rollDamping, vmax = T_BALL.maxSpeed;
  const va = F[RS_VA]!, d = F[RS_D]!;
  const v = va > 0 ? (va < vmax ? va : vmax) : 0;
  if (!(d > 0)) { F[RS_V0] = v; return; }
  let v0 = Math.sqrt(v * v + 2 * a * d);
  if (c > 1e-9) {
    const icc = a / (c * c);
    const lnBase = a + c * v;
    F[LN_ARG] = (a + c * vmax) / lnBase; lnk();
    if (!(d < (vmax - v) / c - icc * F[LN_OUT]!)) { F[RS_V0] = vmax; return; }
    for (let i = 0; i < 10; i++) {
      F[LN_ARG] = (a + c * v0) / lnBase; lnk();
      const f = (v0 - v) / c - icc * F[LN_OUT]! - d;
      const fp = v0 / (a + c * v0);
      if (!(fp > 0)) break;
      const nv = v0 - f / fp;
      const dv = nv - v0;
      v0 = nv > v ? nv : v;
      if (dv < 1e-10 && dv > -1e-10) break;
    }
  }
  F[RS_V0] = v0 < vmax ? v0 : vmax;
}

/** Ground speed for a pass of F[RS_D] m arriving at F[RS_VA] m/s, clamped to the pass range: into F[RS_V0]. */
function groundSpeed(): void {
  passSpeed();
  const v = F[RS_V0]!;
  F[RS_V0] = v < T_PASS.groundMin ? T_PASS.groundMin : v > T_PASS.groundMax ? T_PASS.groundMax : v;
}

/** Arrival speed of a CPU tap ground pass of F[RS_D] m: into F[RS_VA]. */
function tapArrive(): void {
  let f = F[RS_D]! / LT.groundArriveDist;
  f = f < LT.groundArriveFloor ? LT.groundArriveFloor : f > 1 ? 1 : f;
  F[RS_VA] = LT.groundArriveMin + (LT.groundArriveMax - LT.groundArriveMin) * f;
}

/** Lofted launch speed F[O_V] and flight time F[O_T] for F[RS_D] m at the lob angle (cross = 1: the cross angle). */
function loftSpeed(cross: number): void {
  const s2 = cross === 1 ? SIN2_CROSS : SIN2_LOB;
  const g = T_BALL.gravity;
  const d = F[RS_D]!;
  const v = Math.sqrt((g * d * (1 + LT.loftDragPerM * d)) / s2);
  const c2 = Math.sqrt(1 - s2 * s2);
  const sn = Math.sqrt((1 - c2) * 0.5);
  F[O_V] = v;
  F[O_T] = ((2 * v * sn) / g) * (1 - LT.loftTimePerM * d);
}

/**
 * [QF-2] Launch speed (m/s) of a lofted ball that carries `dist` m at T_PASS.lobAngle in the lane model (the speed
 * laneSafety(..., lofted = 1) expects). Callers that know a horizontal average speed (GKP-04's keeper kicks) pass this
 * instead: a slower launch is judged as arriving late and an open 50 m drop kick read as 7% safe.
 */
export function loftLaunchSpeed(dist: number): number {
  if (!(dist > 0) || !(dist < 1e4)) return 0;
  F[RS_D] = dist;
  loftSpeed(0);
  return F[O_V]!;
}

/**
 * [QF-7S] loftLaunchSpeed through a scratch for per-tick callers (GKP-04's keeper evaluation): LOFT_IO[0] = dist in,
 * LOFT_IO[0] = the launch speed out. Same arithmetic; no double crosses the call (V8 boxed the argument and the result
 * whenever the call was not inlined: 32 B per call, 256 B per keeper evaluation).
 */
export const LOFT_IO = new Float64Array(1);
export function loftLaunchSpeedIO(): void {
  const dist = LOFT_IO[0]!;
  if (!(dist > 0) || !(dist < 1e4)) { LOFT_IO[0] = 0; return; }
  F[RS_D] = dist;
  loftSpeed(0);
  LOFT_IO[0] = F[O_V]!;
}

// ---------------------------------------------------------------- players

/** Prepare the active opponents of `team` (end = the goal they defend: +1 at x = +52.5). */
function prepOpponents(s: SimState, team: number, end: number): void {
  const start = team === 0 ? PLAYERS_PER_TEAM : 0;
  let n = 0;
  for (let i = start; i < start + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const x = q.x, z = q.z;
    if (!(x < 1e6 && x > -1e6 && z < 1e6 && z > -1e6)) continue;
    const a = s.attrs[i]!;
    const sf = staminaFactor(q);
    const top = (a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin) * sf;
    const acc = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sf;
    let lock = 0;
    if (q.moveMode === MoveMode.LOCKED && q.act !== ActionKind.NONE && q.actDur > q.actT) lock = q.actDur - q.actT;
    if (q.stunT > lock) lock = q.stunT;
    const vx = q.vx, vz = q.vz;
    OX[n] = x; OZ[n] = z;
    OVX[n] = vx < 1e6 && vx > -1e6 ? vx : 0;
    OVZ[n] = vz < 1e6 && vz > -1e6 ? vz : 0;
    OTOP[n] = top > 0.1 ? top : 0.1;
    OACC[n] = acc > 0.1 ? acc : 0.1;
    OLOCK[n] = lock > 0 && lock < 1e6 ? lock / TICK_HZ : 0;
    const keeper = q.isKeeper === 1 ? 1 : 0;
    OKEEP[n] = keeper;
    const u = end * x;
    OBOX[n] = keeper === 1 && u >= HALF_LENGTH - PENALTY_AREA_DEPTH && u <= HALF_LENGTH &&
      z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH ? 1 : 0;
    n++;
  }
  NI[0] = n;
}

/** Seconds for prepared opponent j to get the ball at (F[P_X], F[P_Z]) with reach F[P_REACH]: into F[P_OUT]. */
function oppTimeAt(j: number): void {
  const dx = F[P_X]! - OX[j]!, dz = F[P_Z]! - OZ[j]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  const br = LT.blockRadius, reach = F[P_REACH]!;
  if (d <= br) { F[P_OUT] = 0; return; }
  if (d <= reach) { F[P_OUT] = (LT.reactS * (d - br)) / (reach - br) + OLOCK[j]!; return; }
  const run = d - reach;
  const top = OTOP[j]!, acc = OACC[j]!;
  let v = (OVX[j]! * dx + OVZ[j]! * dz) / d;
  let t = LT.reactS + OLOCK[j]!;
  if (v < 0) { t -= v / T_PLAYER.decel; v = 0; }
  if (v >= top) { F[P_OUT] = t + run / v; return; }
  const dAcc = (top * top - v * v) / (2 * acc);
  if (run <= dAcc) F[P_OUT] = t + (Math.sqrt(v * v + 2 * acc * run) - v) / acc;
  else F[P_OUT] = t + (top - v) / acc + (run - dAcc) / top;
}

/** Seconds for teammate q to reach (F[P_X], F[P_Z]) within T_TOUCH.receiveRadius (SIM-04-style run, mateReactS
 *  reaction, lock / stun added): into F[P_OUT]. */
function mateTimeAt(s: SimState, q: Readonly<PlayerState>): void {
  const a = s.attrs[q.slot]!;
  const sf = staminaFactor(q);
  let top = (a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin) * sf;
  let acc = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sf;
  if (!(top > 0.1)) top = 0.1;
  if (!(acc > 0.1)) acc = 0.1;
  let lock = 0;
  if (q.moveMode === MoveMode.LOCKED && q.act !== ActionKind.NONE && q.actDur > q.actT) lock = q.actDur - q.actT;
  if (q.stunT > lock) lock = q.stunT;
  const lockS = lock > 0 && lock < 1e6 ? lock / TICK_HZ : 0;
  const dx = F[P_X]! - q.x, dz = F[P_Z]! - q.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const reach = T_TOUCH.receiveRadius;
  if (!(d > reach)) { F[P_OUT] = lockS; return; }
  const vx = q.vx < 1e6 && q.vx > -1e6 ? q.vx : 0, vz = q.vz < 1e6 && q.vz > -1e6 ? q.vz : 0;
  let v = (vx * dx + vz * dz) / d;
  const run = d - reach;
  let t = LT.mateReactS + lockS;
  if (v < 0) { t -= v / T_PLAYER.decel; v = 0; }
  if (v >= top) { F[P_OUT] = t + run / v; return; }
  const dAcc = (top * top - v * v) / (2 * acc);
  if (run <= dAcc) F[P_OUT] = t + (Math.sqrt(v * v + 2 * acc * run) - v) / acc;
  else F[P_OUT] = t + (top - v) / acc + (run - dAcc) / top;
}

// ---------------------------------------------------------------- lane

/** Interception chance of prepared opponent j at the lane point F[L_U]: into F[L_P]. */
function pAt(j: number): void {
  const u = F[L_U]!;
  F[P_X] = F[L_X0]! + F[L_UX]! * u;
  F[P_Z] = F[L_Z0]! + F[L_UZ]! * u;
  oppTimeAt(j);
  let tb: number;
  const vh = F[L_VH]!;
  if (vh > 0) tb = u / vh;
  else {
    const v0 = F[L_SPEED]!, k = F[L_K]!;
    if (!(k > 0)) tb = u / v0;
    else {
      const q = v0 * v0 - 2 * k * u;
      tb = (v0 - (q > 0 ? Math.sqrt(q) : 0)) / k;
    }
  }
  const m = tb - F[P_OUT]!;
  if (m <= -LT.marginLate) { F[L_P] = 0; return; }
  // Near the end the receiver competes: a lofted ball's whole landing segment is an aerial duel (pEnd); on the
  // ground the cap falls from pMax to pEnd over the last endZone metres.
  let cap: number = LT.pMax;
  if (u >= F[L_LAND]!) cap = LT.pEnd;
  else {
    const fromEnd = F[L_LEN]! - u;
    if (fromEnd < LT.endZone) cap = LT.pEnd + ((LT.pMax - LT.pEnd) * (fromEnd > 0 ? fromEnd : 0)) / LT.endZone;
  }
  let t = (m + LT.marginLate) / (LT.marginLate + LT.marginEarly);
  if (t > 1) t = 1;
  F[L_P] = cap * t * t * (3 - 2 * t);
}

/** Best interception chance of opponent j over the lane segment [F[L_LO], F[L_HI]] given his lane coordinates
 *  F[L_ALONG], F[L_PERP]: into F[L_P]. */
function pSeg(j: number): void {
  const lo = F[L_LO]!, hi = F[L_HI]!, along = F[L_ALONG]!, perp = F[L_PERP]!;
  const u1 = along < lo ? lo : along > hi ? hi : along;
  F[L_U] = u1; pAt(j);
  let best = F[L_P]!;
  let vb: number;
  if (F[L_VH]! > 0) vb = F[L_VH]!;
  else {
    const v0 = F[L_SPEED]!;
    const q = v0 * v0 - 2 * F[L_K]! * u1;
    vb = q > 0.01 ? Math.sqrt(q) : 0.1;
  }
  const r = OTOP[j]! / vb;
  let u2 = hi;
  if (r < LT.chaseRatioMax) {
    u2 = along + (perp * r) / Math.sqrt(1 - r * r);
    u2 = u2 < lo ? lo : u2 > hi ? hi : u2;
  }
  if (u2 !== u1) {
    F[L_U] = u2; pAt(j);
    if (F[L_P]! > best) best = F[L_P]!;
  }
  if (hi !== u2 && hi !== u1) {
    F[L_U] = hi; pAt(j);
    if (F[L_P]! > best) best = F[L_P]!;
  }
  F[L_P] = best;
}

/**
 * Completion of the lane F[L_X0], F[L_Z0] -> F[L_X1], F[L_Z1] at launch speed F[L_SPEED] against the prepared
 * opponents: F[L_SAFE] (0..1) and F[L_TEND] (ball time to the end, s).
 */
function laneKernel(lofted: number): void {
  F[L_SAFE] = 0;
  F[L_TEND] = 0;
  const x0 = F[L_X0]!, z0 = F[L_Z0]!;
  let speed = F[L_SPEED]!;
  const dx = F[L_X1]! - x0, dz = F[L_Z1]! - z0;
  let L = Math.sqrt(dx * dx + dz * dz);
  if (!(L < 1e6) || !(speed > 0) || !(x0 < 1e6 && x0 > -1e6 && z0 < 1e6 && z0 > -1e6)) return;
  if (speed > T_BALL.maxSpeed) speed = T_BALL.maxSpeed;
  F[L_SPEED] = speed;
  if (L < 1e-6) { F[L_SAFE] = 1; return; }
  const ux = dx / L, uz = dz / L;
  let short = 1;
  let tEnd: number;
  let lo2 = 1, hi2 = 0, hi1: number;
  if (lofted === 0) {
    F[RS_V0] = speed; F[RS_D] = L; rollTime();
    let t = F[RS_T]!;
    if (!(t >= 0)) {
      // Stops short: judge the lane up to the stop point, scaled by the shortfall.
      const a = T_BALL.rollDecel, c = T_BALL.rollDamping;
      let stop: number;
      if (c > 1e-9) {
        F[LN_ARG] = 1 + (c * speed) / a; lnk();
        stop = speed / c - (a / (c * c)) * F[LN_OUT]!;
      } else stop = (speed * speed) / (2 * a);
      const f = stop / L;
      short = f > 0 ? (f < 1 ? f * f : 1) : 0;
      L = stop * 0.999;
      if (!(L > 1e-3)) return;
      F[RS_D] = L; rollTime();
      t = F[RS_T]!;
      if (!(t > 0)) t = (2 * L) / speed;
    }
    tEnd = t > 1e-6 ? t : L / speed;
    let k = (2 * (speed * tEnd - L)) / (tEnd * tEnd);
    if (!(k > 0)) k = 0;
    if (k > 0 && speed * speed - 2 * k * L < 0) k = (speed * speed) / (2 * L);
    F[L_K] = k;
    F[L_VH] = 0;
    hi1 = L;
  } else {
    const g = T_BALL.gravity;
    const s2 = (g * L * (1 + LT.loftDragPerM * L)) / (speed * speed);
    let sn: number, cs: number, T: number;
    if (s2 >= 1) {
      sn = Math.SQRT1_2; cs = Math.SQRT1_2;
      T = L / (speed * cs);
    } else {
      const c2 = Math.sqrt(1 - s2 * s2);
      sn = Math.sqrt((1 - c2) * 0.5);
      cs = Math.sqrt((1 + c2) * 0.5);
      T = ((2 * speed * sn) / g) * (1 - LT.loftTimePerM * L);
      const tMin = L / (speed * cs);
      if (!(T > tMin)) T = tMin;
    }
    tEnd = T;
    F[L_K] = 0;
    F[L_VH] = L / T;
    const vy = speed * sn;
    const H = ((vy * vy) / (2 * g)) * LT.loftApexMul;
    if (H > LT.loftReachHeight) {
      const f0 = (1 - Math.sqrt(1 - LT.loftReachHeight / H)) * 0.5;
      hi1 = f0 * L;
      lo2 = (1 - f0) * L;
      hi2 = L;
    } else hi1 = L;
  }
  F[L_UX] = ux; F[L_UZ] = uz; F[L_LEN] = L; F[L_TEND] = tEnd;
  F[L_LAND] = hi2 > lo2 ? lo2 : 1e9;
  let safe = 1;
  const n = NI[0]!;
  for (let j = 0; j < n; j++) {
    const rx = OX[j]! - x0, rz = OZ[j]! - z0;
    const along = rx * ux + rz * uz;
    let perp = rx * uz - rz * ux;
    if (perp < 0) perp = -perp;
    const reach = OBOX[j] === 1 ? (lofted === 1 ? LT.keeperAirReach : T_TACKLE.interceptReach * LT.keeperReachMul) : T_TACKLE.interceptReach;
    // Quick reject: his closest approach to the lane is beyond what he can run before the ball has passed.
    let seg: number;
    if (along < 0) seg = Math.sqrt(rx * rx + rz * rz);
    else if (along > L) { const ex = along - L; seg = Math.sqrt(ex * ex + perp * perp); } else seg = perp;
    if (seg - reach > OTOP[j]! * (tEnd + LT.marginLate) + LT.rejectSlack) continue;
    F[P_REACH] = reach;
    F[L_ALONG] = along; F[L_PERP] = perp;
    F[L_LO] = 0; F[L_HI] = hi1;
    pSeg(j);
    let p = F[L_P]!;
    if (hi2 > lo2) {
      F[L_LO] = lo2; F[L_HI] = hi2;
      pSeg(j);
      if (F[L_P]! > p) p = F[L_P]!;
    }
    safe *= 1 - p;
  }
  safe *= short;
  F[L_SAFE] = safe > 0 ? (safe < 1 ? safe : 1) : 0;
}

/** Completion probability of a ground/aerial ball from (x0,z0) to (x1,z1) at speed for the passing team. Pure. */
export function laneSafety(s: SimState, team: number, x0: number, z0: number, x1: number, z1: number, speed: number, lofted: number): number {
  if (team !== 0 && team !== 1) return 0;
  if (!(x1 < 1e6 && x1 > -1e6 && z1 < 1e6 && z1 > -1e6)) return 0;
  const end = s.teams[team]!.dir === -1 ? -1 : 1;
  prepOpponents(s, team, end);
  F[L_X0] = x0; F[L_Z0] = z0; F[L_X1] = x1; F[L_Z1] = z1; F[L_SPEED] = speed;
  laneKernel(lofted !== 0 && lofted === lofted ? 1 : 0);
  return F[L_SAFE]!;
}

// ---------------------------------------------------------------- receiver, accuracy, danger

/** Receiver pressure at (F[P_X], F[P_Z]) reached by the ball after F[P_TB] s: F[O_C] x= its factor. */
function applyPressure(): void {
  const px = F[P_X]!, pz = F[P_Z]!, tb = F[P_TB]!;
  let m = 1e9;
  const n = NI[0]!;
  F[P_REACH] = T_TACKLE.interceptReach;
  for (let j = 0; j < n; j++) {
    F[P_X] = px; F[P_Z] = pz;
    oppTimeAt(j);
    const t = F[P_OUT]! - tb;
    if (t < m) m = t;
  }
  let t = (m - LT.pressNear) / (LT.pressFar - LT.pressNear);
  t = t > 0 ? (t < 1 ? t : 1) : 0;
  F[O_C] = F[O_C]! * (1 - LT.pressMax * (1 - t * t * (3 - 2 * t)));
}

/** Accuracy (distance penalty) of a pass of F[O_ACC_D] m with attribute F[O_ACC_A] (1..99): F[O_C] x= its factor. */
function applyAccuracy(lofted: number): void {
  let a = (F[O_ACC_A]! - 1) / 98;
  a = 1 - (a > 0 ? (a < 1 ? a : 1) : 0);
  let sigma = T_PASS.errorMax * (LT.accMinFrac + (1 - LT.accMinFrac) * a * a) * (1 + LT.accPressMul * F[C_PRESS]!);
  if (lofted === 1) sigma *= LT.loftErrMul;
  const miss = (F[O_ACC_D]! * sigma) / LT.accTol;
  F[O_C] = F[O_C]! / (1 + miss * miss);
}

/** Pass attribute for a pass of F[O_ACC_D] m into F[O_ACC_A]: shortPassing .. longPassing blended. */
function passAttr(): void {
  let f = (F[O_ACC_D]! - LT.shortRange) / (LT.longRange - LT.shortRange);
  f = f > 0 ? (f < 1 ? f : 1) : 0;
  F[O_ACC_A] = F[C_SHORT]! + (F[C_LONG]! - F[C_SHORT]!) * f;
}

/** Danger (xG-ish 0..1) of receiving at (F[P_X], F[P_Z]) for the passing team (opponents prepared): into F[P_OUT].
 *  behindOk = 1 adds the behind-the-line bonus. */
function spotDanger(behindOk: number): void {
  const x = F[P_X]!, z = F[P_Z]!;
  const dir = F[C_DIR]!;
  const ax = dir * HALF_LENGTH - x;
  const adx = ax < 0 ? -ax : ax;
  const gh = GOAL_HALF_WIDTH;
  // Angle subtended by the goal mouth = atan2(|v1 x v2|, v1 . v2) with v1 / v2 toward the posts (cross >= 0), by a
  // fixed polynomial atan (|error| ~1e-5 rad).
  const cr = adx * 2 * gh;
  const dot = ax * ax + z * z - gh * gh;
  const adot = dot < 0 ? -dot : dot;
  let ang = 0;
  const mx = cr > adot ? cr : adot;
  if (mx > 0) {
    const r = (cr > adot ? adot : cr) / mx;
    const r2 = r * r;
    ang = ((-0.0464964749 * r2 + 0.15931422) * r2 - 0.327622764) * r2 * r + r;
    if (cr > adot) ang = 1.5707963267948966 - ang;
    if (dot < 0) ang = 3.141592653589793 - ang;
  }
  let xg = LT.xgK * ang * ang;
  if (xg > LT.xgCap) xg = LT.xgCap;
  const g = Math.sqrt(ax * ax + z * z);
  if (xg > LT.blockerMinXg && g > 0.5) {
    // Outfield blockers in the shooting triangle (spot -> posts).
    const ux = ax / g, uz = -z / g;
    let nb = 0;
    const n = NI[0]!;
    for (let j = 0; j < n && nb < LT.blockMax; j++) {
      if (OKEEP[j] === 1) continue;
      const rx = OX[j]! - x, rz = OZ[j]! - z;
      const t = rx * ux + rz * uz;
      if (t <= 0 || t >= g) continue;
      let side = rx * uz - rz * ux;
      if (side < 0) side = -side;
      if (side < (gh * t) / g + LT.blockLane) nb++;
    }
    for (let k = 0; k < nb; k++) xg *= LT.blockMul;
  }
  if (behindOk === 1 && dir * x > F[C_DEEPU]! && g < LT.behindRange) xg += LT.behindBonus * (1 - g / LT.behindRange);
  F[P_OUT] = xg > 0 ? (xg < 1 ? xg : 1) : 0;
}

// ---------------------------------------------------------------- output

/** Write option (target, kind, F[E_*]) keeping the best out.length by score. */
function emit(out: PassOption[], target: number, kind: KickKind): void {
  let c = F[E_C]!;
  c = c > 0 ? (c < 1 ? c : 1) : 0;
  let prog = F[E_PROG]!;
  if (!(prog < 1e6 && prog > -1e6)) prog = 0;
  let dang = F[E_DANGER]!;
  dang = dang > 0 ? (dang < 1 ? dang : 1) : 0;
  let pn = prog / LT.progressRef;
  pn = pn > 1 ? 1 : pn < -1 ? -1 : pn;
  let dn = dang / LT.dangerRef;
  if (dn > LT.dangerCapN) dn = LT.dangerCapN;
  let score = F[C_WC]! * c + c * (F[E_WP]! * pn + F[E_WD]! * dn);
  if (!(score < 1e6 && score > -1e6)) score = 0;
  const cap = out.length;
  let idx = NI[1]!;
  if (idx >= cap) {
    // Full: replace the worst (lowest score; the last of equals) if this one is better.
    let wi = -1;
    let ws = score;
    for (let i = 0; i < cap; i++) {
      const sc = out[i]!.score;
      if (sc < ws || (sc === ws && wi >= 0)) { ws = sc; wi = i; }
    }
    if (wi < 0) return;
    idx = wi;
  } else NI[1] = idx + 1;
  const o = out[idx]!;
  const x = F[E_X]!, z = F[E_Z]!;
  o.target = target; o.kind = kind;
  o.x = x < 1e6 && x > -1e6 ? x : 0;
  o.z = z < 1e6 && z > -1e6 ? z : 0;
  o.completion = c; o.progress = prog; o.danger = dang; o.score = score;
}

/** Sort out[0..n) by score, best first (stable insertion sort; reorders the caller's objects). */
function sortOut(out: PassOption[], n: number): void {
  for (let i = 1; i < n; i++) {
    const o = out[i]!;
    const sc = o.score;
    let j = i - 1;
    while (j >= 0 && out[j]!.score < sc) { out[j + 1] = out[j]!; j--; }
    out[j + 1] = o;
  }
}

// ---------------------------------------------------------------- option builders

/** Ground (driven = 1: driven) pass to teammate q led along his run: completion F[O_C], point F[O_X/Z], speed F[O_V]. */
function groundPass(q: Readonly<PlayerState>, driven: number): void {
  const bx = F[C_BX]!, bz = F[C_BZ]!;
  const vx = q.vx < 1e6 && q.vx > -1e6 ? q.vx : 0, vz = q.vz < 1e6 && q.vz > -1e6 ? q.vz : 0;
  const mul = driven === 1 ? T_PASS.drivenMul : 1;
  const xm = HALF_LENGTH - LT.pitchMargin, zm = HALF_WIDTH - LT.pitchMargin;
  let rx = q.x, rz = q.z;
  for (let it = 0; it < 2; it++) {
    const ix = rx - bx, iz = rz - bz;
    F[RS_D] = Math.sqrt(ix * ix + iz * iz);
    tapArrive(); groundSpeed();
    F[RS_V0] = F[RS_V0]! * mul;
    rollTime();
    let t = F[RS_T]!;
    if (!(t >= 0) || t > LT.leadMaxS) t = LT.leadMaxS;
    // [QF-2] As SIM-08: his run is extrapolated only until it comes within leadLineMargin of a line.
    const lmx = HALF_LENGTH - LT.leadLineMargin, lmz = HALF_WIDTH - LT.leadLineMargin;
    if (vx > 1e-6 && q.x + vx * t > lmx) t = q.x < lmx ? (lmx - q.x) / vx : 0;
    else if (vx < -1e-6 && q.x + vx * t < -lmx) t = q.x > -lmx ? (-lmx - q.x) / vx : 0;
    if (vz > 1e-6 && q.z + vz * t > lmz) t = q.z < lmz ? (lmz - q.z) / vz : 0;
    else if (vz < -1e-6 && q.z + vz * t < -lmz) t = q.z > -lmz ? (-lmz - q.z) / vz : 0;
    rx = q.x + vx * t; rz = q.z + vz * t;
    rx = rx > xm ? xm : rx < -xm ? -xm : rx;
    rz = rz > zm ? zm : rz < -zm ? -zm : rz;
  }
  const dx = rx - bx, dz = rz - bz;
  const d = Math.sqrt(dx * dx + dz * dz);
  F[O_X] = rx; F[O_Z] = rz;
  F[RS_D] = d;
  tapArrive(); groundSpeed();
  const v = F[RS_V0]! * mul;
  F[O_V] = v;
  if (!(d > 1e-6)) { F[O_C] = 0; return; }
  let mb = d * LT.meetBackFrac;
  if (mb > LT.meetBackMax) mb = LT.meetBackMax;
  F[L_X0] = bx; F[L_Z0] = bz; F[L_X1] = rx - (dx / d) * mb; F[L_Z1] = rz - (dz / d) * mb; F[L_SPEED] = v;
  laneKernel(0);
  F[O_C] = F[L_SAFE]!;
  F[RS_V0] = v; F[RS_D] = d; rollTime();
  let tb = F[RS_T]!;
  const va = F[RS_VEND]!;
  if (!(tb >= 0)) tb = F[L_TEND]!;
  F[O_T] = tb;
  F[P_X] = rx; F[P_Z] = rz; F[P_TB] = tb;
  applyPressure();
  F[O_ACC_D] = d; passAttr(); applyAccuracy(0);
  if (driven === 1) {
    const hb = T_TOUCH.hardBallSpeed;
    if (va > hb) {
      const f = (va - hb) / hb;
      F[O_C] = F[O_C]! * (1 - LT.hardLoss * (f < 1 ? f : 1));
    }
  }
}

/** Lob to teammate q (led over the flight): completion F[O_C], point F[O_X/Z]. */
function lobPass(s: SimState, q: Readonly<PlayerState>): void {
  const bx = F[C_BX]!, bz = F[C_BZ]!;
  const vx = q.vx < 1e6 && q.vx > -1e6 ? q.vx : 0, vz = q.vz < 1e6 && q.vz > -1e6 ? q.vz : 0;
  const xm = HALF_LENGTH - LT.pitchMargin, zm = HALF_WIDTH - LT.pitchMargin;
  let rx = q.x, rz = q.z;
  for (let it = 0; it < 2; it++) {
    const ix = rx - bx, iz = rz - bz;
    F[RS_D] = Math.sqrt(ix * ix + iz * iz);
    loftSpeed(0);
    let t = F[O_T]!;
    if (t > LT.leadMaxS) t = LT.leadMaxS;
    rx = q.x + vx * t; rz = q.z + vz * t;
    rx = rx > xm ? xm : rx < -xm ? -xm : rx;
    rz = rz > zm ? zm : rz < -zm ? -zm : rz;
  }
  const dx = rx - bx, dz = rz - bz;
  const d = Math.sqrt(dx * dx + dz * dz);
  F[O_X] = rx; F[O_Z] = rz;
  if (!(d > 1e-6)) { F[O_C] = 0; return; }
  F[RS_D] = d; loftSpeed(0);
  const tf = F[O_T]!;
  F[L_X0] = bx; F[L_Z0] = bz; F[L_X1] = rx; F[L_Z1] = rz; F[L_SPEED] = F[O_V]!;
  laneKernel(1);
  F[O_C] = F[L_SAFE]!;
  F[P_X] = rx; F[P_Z] = rz; F[P_TB] = tf;
  applyPressure();
  F[O_ACC_D] = d; passAttr(); applyAccuracy(1);
  let ac = (s.attrs[q.slot]!.ballControl - 1) / 98;
  ac = ac > 0 ? (ac < 1 ? ac : 1) : 0;
  F[O_C] = F[O_C]! * (LT.aerialMin + (LT.aerialMax - LT.aerialMin) * ac);
}

/** True when teammate q is making a forward run (through-ball candidate) toward `dir`. */
function isRunner(q: Readonly<PlayerState>, dir: number): boolean {
  if (q.isKeeper === 1) return false;
  const vx = q.vx < 1e6 && q.vx > -1e6 ? q.vx : 0, vz = q.vz < 1e6 && q.vz > -1e6 ? q.vz : 0;
  const fwd = dir * vx;
  const job = q.job;
  if ((job === AiJob.RUN_IN_BEHIND || job === AiJob.OVERLAP || job === AiJob.LATE_RUN) && fwd >= LT.runnerJobMinFwd) return true;
  const sp = Math.sqrt(vx * vx + vz * vz);
  return fwd >= LT.runnerMinFwd && fwd >= LT.runnerFwdCos * sp;
}

/**
 * Own through-ball lead for runner q: his run (his velocity direction, accelerating to top speed) until the ball
 * arrives. Point F[O_X/Z], ball speed F[O_V], ball time F[O_T], arrival F[O_ARR]; returns 1 if usable.
 */
function ownLead(s: SimState, q: Readonly<PlayerState>, lofted: number): number {
  const a = s.attrs[q.slot]!;
  const bx = F[C_BX]!, bz = F[C_BZ]!;
  const vx = q.vx < 1e6 && q.vx > -1e6 ? q.vx : 0, vz = q.vz < 1e6 && q.vz > -1e6 ? q.vz : 0;
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (!(sp > 0.1)) return 0;
  const ux = vx / sp, uz = vz / sp;
  const sf = staminaFactor(q);
  const top = (a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin) * sf;
  const acc = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sf;
  if (!(top > 0.1) || !(acc > 0.1)) return 0;
  const v0 = sp < top ? sp : top;
  const tAcc = (top - v0) / acc;
  const xm = HALF_LENGTH - LT.pitchMargin, zm = HALF_WIDTH - LT.pitchMargin;
  const dx0 = q.x - bx, dz0 = q.z - bz;
  let t = Math.sqrt(dx0 * dx0 + dz0 * dz0) / LT.throughSeedSpeed;
  let lx = q.x, lz = q.z, v = 0;
  let arrive: number = LT.throughArrive;
  for (let it = 0; it < LT.throughIters; it++) {
    const run = t <= tAcc ? v0 * t + 0.5 * acc * t * t : v0 * tAcc + 0.5 * acc * tAcc * tAcc + top * (t - tAcc);
    lx = q.x + ux * run; lz = q.z + uz * run;
    lx = lx > xm ? xm : lx < -xm ? -xm : lx;
    lz = lz > zm ? zm : lz < -zm ? -zm : lz;
    const dx = lx - bx, dz = lz - bz;
    const d = Math.sqrt(dx * dx + dz * dz);
    F[RS_D] = d;
    if (lofted === 1) {
      loftSpeed(0);
      v = F[O_V]!;
      t = F[O_T]!;
    } else {
      // Arrive faster than he runs away from the ball so it catches him (his speed at the meeting).
      const vm = t <= tAcc ? v0 + acc * t : top;
      const away = d > 1e-6 ? (vm * (ux * dx + uz * dz)) / d : 0;
      arrive = away + LT.leadArriveMargin > LT.throughArrive ? away + LT.leadArriveMargin : LT.throughArrive;
      F[RS_VA] = arrive; groundSpeed();
      v = F[RS_V0]!;
      rollTime();
      t = F[RS_T]!;
      if (!(t >= 0)) return 0;
    }
    if (t > LT.leadMaxS * 2) t = LT.leadMaxS * 2;
  }
  F[O_X] = lx; F[O_Z] = lz; F[O_V] = v; F[O_T] = t; F[O_ARR] = arrive;
  return 1;
}

/** Through ball (ground or lofted) to runner q; emits it when sensible. The lane completion (for the lob trigger)
 *  goes to F[O_LANE], -1 when there is no option. */
function throughBall(s: SimState, out: PassOption[], slot: number, q: Readonly<PlayerState>, lofted: number): void {
  const dir = F[C_DIR]!;
  const bx = F[C_BX]!, bz = F[C_BZ]!;
  F[O_LANE] = -1;
  if (ownLead(s, q, lofted) !== 1) return;
  let lx = F[O_X]!, lz = F[O_Z]!;
  const arrive = F[O_ARR]!;
  // SIM-10's lead point when it gives one. Power from the own model's speed on the ground range, quantised to 0.2
  // steps and passed as literal constants (a computed double argument would be boxed).
  const pw = (F[O_V]! - T_PASS.groundMin) / (T_PASS.groundMax - T_PASS.groundMin);
  PT.x = 0; PT.z = 0;
  let got: number;
  if (pw < 0.3) got = throughLeadPoint(s, slot, q.slot, 0.2, lofted, PT);
  else if (pw < 0.5) got = throughLeadPoint(s, slot, q.slot, 0.4, lofted, PT);
  else if (pw < 0.7) got = throughLeadPoint(s, slot, q.slot, 0.6, lofted, PT);
  else if (pw < 0.9) got = throughLeadPoint(s, slot, q.slot, 0.8, lofted, PT);
  else got = throughLeadPoint(s, slot, q.slot, 1, lofted, PT);
  if (got === 1) {
    const px = PT.x, pz = PT.z;
    if (px <= HALF_LENGTH && px >= -HALF_LENGTH && pz <= HALF_WIDTH && pz >= -HALF_WIDTH) {
      const xm = HALF_LENGTH - LT.pitchMargin, zm = HALF_WIDTH - LT.pitchMargin;
      lx = px > xm ? xm : px < -xm ? -xm : px;
      lz = pz > zm ? zm : pz < -zm ? -zm : pz;
    }
  }
  if (dir * (lx - q.x) < LT.throughMinLead) return;
  const dx = lx - bx, dz = lz - bz;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < LT.throughMinDist || d > T_PASS.maxRange || dir * dx <= 0) return;
  F[RS_D] = d;
  let v: number, tb: number;
  if (lofted === 1) {
    loftSpeed(0);
    v = F[O_V]!; tb = F[O_T]!;
  } else {
    F[RS_VA] = arrive; groundSpeed();
    v = F[RS_V0]!;
    rollTime();
    tb = F[RS_T]!;
    if (!(tb >= 0)) return;
  }
  F[L_X0] = bx; F[L_Z0] = bz; F[L_X1] = lx; F[L_Z1] = lz; F[L_SPEED] = v;
  laneKernel(lofted);
  const lane = F[L_SAFE]!;
  F[P_X] = lx; F[P_Z] = lz;
  mateTimeAt(s, q);
  const late = F[P_OUT]! - tb - LT.throughSlackS;
  let tl = late / LT.throughLateS;
  tl = tl > 0 ? (tl < 1 ? tl : 1) : 0;
  F[O_C] = lane * (1 - tl * tl * (3 - 2 * tl));
  F[P_X] = lx; F[P_Z] = lz; F[P_TB] = tb + (late > 0 ? late + LT.throughSlackS : 0);
  applyPressure();
  F[O_ACC_D] = d; passAttr();
  F[O_ACC_A] = 0.5 * (F[O_ACC_A]! + F[C_VISION]!);
  applyAccuracy(lofted);
  if (lofted === 1) {
    let ac = (s.attrs[q.slot]!.ballControl - 1) / 98;
    ac = ac > 0 ? (ac < 1 ? ac : 1) : 0;
    F[O_C] = F[O_C]! * (LT.aerialMin + (LT.aerialMax - LT.aerialMin) * ac);
  }
  // [INT-A] Calibration against soak outcomes (estimated 38% / 12%, completed 19% / 0%).
  F[O_C] = F[O_C]! * (lofted === 1 ? LT.throughLobCompletionMul : LT.throughGroundCompletionMul);
  F[P_X] = lx; F[P_Z] = lz; spotDanger(1);
  F[E_X] = lx; F[E_Z] = lz; F[E_C] = F[O_C]!; F[E_PROG] = dir * dx; F[E_DANGER] = F[P_OUT]!;
  F[E_WP] = F[C_WPD]!; F[E_WD] = F[C_WDD]!;
  emit(out, q.slot, lofted === 1 ? KickKind.THROUGH_LOBBED : KickKind.THROUGH_GROUND);
  F[O_LANE] = lane;
}

/** Cross target k (0 near post, 1 penalty spot, 2 far post): SIM-09 crossTarget when it answers inside the attacked
 *  penalty area, else the own geometry. Into F[CT + 2k], F[CT + 2k + 1]. */
function crossTargetInto(s: SimState, slot: number, k: number, dir: number, side: number): void {
  PT.x = 0; PT.z = 0;
  // Literal powers and an integer stick (straight at the goal line): no boxed arguments.
  if (k === 0) crossTarget(s, slot, 0.3, dir, 0, PT);
  else if (k === 1) crossTarget(s, slot, 0.6, dir, 0, PT);
  else crossTarget(s, slot, 0.9, dir, 0, PT);
  let tx = PT.x, tz = PT.z;
  const u = dir * tx;
  if (!(u >= HALF_LENGTH - PENALTY_AREA_DEPTH && u <= HALF_LENGTH && tz >= -PENALTY_AREA_HALF_WIDTH && tz <= PENALTY_AREA_HALF_WIDTH)) {
    if (k === 0) { tx = dir * (HALF_LENGTH - LT.nearPostDepth); tz = side * LT.nearPostZ; }
    else if (k === 1) { tx = dir * (HALF_LENGTH - PENALTY_SPOT_DIST); tz = side * LT.spotZ; }
    else { tx = dir * (HALF_LENGTH - LT.farPostDepth); tz = -side * LT.farPostZ; }
  }
  F[CT + 2 * k] = tx;
  F[CT + 2 * k + 1] = tz;
}

/** Cross options from the crossing zone (targets with attacker presence). */
function crosses(s: SimState, out: PassOption[], slot: number, team: number, dir: number, offside: number): void {
  const bx = F[C_BX]!, bz = F[C_BZ]!;
  const side = bz >= 0 ? 1 : -1;
  const start = team === 0 ? 0 : PLAYERS_PER_TEAM;
  const r2 = LT.crossAttackRange * LT.crossAttackRange;
  for (let k = 0; k < 3; k++) {
    crossTargetInto(s, slot, k, dir, side);
    const tx = F[CT + 2 * k]!, tz = F[CT + 2 * k + 1]!;
    let dup = 0;
    for (let m = 0; m < k; m++) {
      const ddx = F[CT + 2 * m]! - tx, ddz = F[CT + 2 * m + 1]! - tz;
      if (ddx * ddx + ddz * ddz < LT.crossDedupe * LT.crossDedupe) dup = 1;
    }
    if (dup === 1) continue;
    const dx = tx - bx, dz = tz - bz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!(d > 1)) continue;
    F[RS_D] = d; loftSpeed(1);
    const v = F[O_V]!, tf = F[O_T]!;
    // Attacker presence: the first onside outfield teammate to get there.
    let best = -1, bestT = 1e9;
    for (let i = start; i < start + PLAYERS_PER_TEAM; i++) {
      if (i === slot) continue;
      const q = s.players[i]!;
      if (q.active !== 1 || q.isKeeper === 1) continue;
      const ax = q.x - tx, az = q.z - tz;
      if (!(ax * ax + az * az <= r2)) continue;
      if (offside === 1 && dir * q.x > F[C_OFFU]! + T_RULES.offsideMargin) continue;
      F[P_X] = tx; F[P_Z] = tz;
      mateTimeAt(s, q);
      if (F[P_OUT]! < bestT) { bestT = F[P_OUT]!; best = i; }
    }
    if (best < 0 || bestT > tf + LT.crossLateS) continue;
    F[L_X0] = bx; F[L_Z0] = bz; F[L_X1] = tx; F[L_Z1] = tz; F[L_SPEED] = v;
    laneKernel(1);
    let tl = (bestT - tf) / LT.crossLateS;
    tl = tl > 0 ? (tl < 1 ? tl : 1) : 0;
    // [INT-A] Calibration: the lofted landing-duel model put crosses at 0.05-0.2 while soak crosses reached an
    // attacker about half the time (a header at goal counts), so CPUs never crossed from the wings.
    let cc = F[L_SAFE]! * LT.crossCompletionMul + LT.crossCompletionAdd;
    if (cc > 1) cc = 1;
    F[O_C] = cc * (1 - tl * tl * (3 - 2 * tl));
    F[O_ACC_D] = d; F[O_ACC_A] = F[C_CROSSING]!;
    applyAccuracy(1);
    F[P_X] = tx; F[P_Z] = tz; spotDanger(0);
    let head = (s.attrs[best]!.heading - 1) / 98;
    head = head > 0 ? (head < 1 ? head : 1) : 0;
    F[E_X] = tx; F[E_Z] = tz; F[E_C] = F[O_C]!; F[E_PROG] = dir * dx;
    F[E_DANGER] = F[P_OUT]! * LT.headerXgMul * (LT.headerDangerBase + LT.headerDangerHeadW * head);
    F[E_WP] = F[C_WP]!; F[E_WD] = F[C_WDW]!;
    emit(out, best, KickKind.CROSS);
  }
}

// ---------------------------------------------------------------- the scan

/** Fill out[] with options for the carrier; returns the number written. */
export function scorePassOptions(s: SimState, slot: number, out: PassOption[]): number {
  NI[1] = 0;
  if (!(slot >= 0 && slot < NUM_SLOTS) || (slot | 0) !== slot || out.length === 0) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || (p.team !== 0 && p.team !== 1)) return 0;
  const team = p.team;
  const t = s.teams[team]!;
  const dir = t.dir === -1 ? -1 : 1;
  const b = s.ball;
  let bx = p.x, bz = p.z;
  if (b.owner === slot && b.x < 1e6 && b.x > -1e6 && b.z < 1e6 && b.z > -1e6) { bx = b.x; bz = b.z; }
  if (!(bx < 1e6 && bx > -1e6 && bz < 1e6 && bz > -1e6)) return 0;
  prepOpponents(s, team, dir);
  const a = s.attrs[slot]!;
  F[C_BX] = bx; F[C_BZ] = bz; F[C_DIR] = dir;
  F[C_SHORT] = a.shortPassing; F[C_LONG] = a.longPassing; F[C_VISION] = a.vision; F[C_CROSSING] = a.crossing;
  // Carrier pressure (core/query pressureOn's ramp), the offside line (RUL-08: second-last defender, ball, halfway
  // line) and the deepest outfield defender.
  let first = -1e9, second = -1e9, deep = -1e9, near2 = 1e18;
  const n = NI[0]!;
  for (let j = 0; j < n; j++) {
    const u = dir * OX[j]!;
    if (u > first) { second = first; first = u; } else if (u > second) second = u;
    if (OKEEP[j] === 0 && u > deep) deep = u;
    const ex = OX[j]! - p.x, ez = OZ[j]! - p.z;
    const e2 = ex * ex + ez * ez;
    if (e2 < near2) near2 = e2;
  }
  const pr = 1 - (Math.sqrt(near2) - LT.pressDistNear) / (LT.pressDistFar - LT.pressDistNear);
  F[C_PRESS] = pr > 0 ? (pr < 1 ? pr : 1) : 0;
  let offU = second > -1e9 ? second : first;
  const bu = dir * b.x;
  if (bu > offU) offU = bu;
  if (offU < 0) offU = 0;
  F[C_OFFU] = offU;
  const offside = s.config.offside === 0 ? 0 : 1;
  F[C_DEEPU] = deep > -1e9 ? deep : HALF_LENGTH;
  // Style weights (TAI-12).
  const sw = styleWeights(t.style);
  let w = sw.safety; w = w > 0 ? (w < 1 ? w : 1) : 0;
  F[C_WC] = LT.wCompletion * (LT.styleWeightBase + w);
  w = sw.progress; w = w > 0 ? (w < 1 ? w : 1) : 0;
  F[C_WP] = LT.wProgress * (LT.styleWeightBase + w);
  F[C_WD] = LT.wDanger * (LT.styleWeightBase + w);
  w = sw.directness; w = w > 0 ? (w < 1 ? w : 1) : 0;
  F[C_WPD] = LT.wProgress * (LT.styleWeightBase + w);
  F[C_WDD] = LT.wDanger * (LT.styleWeightBase + w);
  w = sw.width; w = w > 0 ? (w < 1 ? w : 1) : 0;
  F[C_WDW] = LT.wDanger * (LT.styleWeightBase + w);
  const inZone = p.isKeeper === 0 && dir * bx >= HALF_LENGTH - CROSS_ZONE_DEPTH && (bz >= CROSS_ZONE_MIN_Z || bz <= -CROSS_ZONE_MIN_Z);
  const start = team === 0 ? 0 : PLAYERS_PER_TEAM;
  for (let i = start; i < start + PLAYERS_PER_TEAM; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const qx = q.x, qz = q.z;
    if (!(qx < 1e6 && qx > -1e6 && qz < 1e6 && qz > -1e6)) continue;
    const dx = qx - bx, dz = qz - bz;
    const d0 = Math.sqrt(dx * dx + dz * dz);
    if (d0 < LT.minDist || d0 > T_PASS.maxRange) continue;
    if (offside === 1 && dir * qx > offU + T_RULES.offsideMargin) continue;
    const keeper = q.isKeeper === 1;
    if (keeper && d0 > LT.keeperMaxDist) continue;
    // Ground pass (driven when that is better).
    groundPass(q, 0);
    let gc = F[O_C]!, gx = F[O_X]!, gz = F[O_Z]!;
    let kind = KickKind.GROUND_PASS;
    const gdx = gx - bx, gdz = gz - bz;
    const gd = Math.sqrt(gdx * gdx + gdz * gdz);
    if (gc < LT.drivenTrigger && gd >= LT.drivenMinDist) {
      groundPass(q, 1);
      const dc = F[O_C]! * LT.drivenCompletionMul;
      if (dc > gc) { gc = dc; gx = F[O_X]!; gz = F[O_Z]!; kind = KickKind.DRIVEN_PASS; }
    }
    const gp = dir * (gx - bx);
    F[E_X] = gx; F[E_Z] = gz; F[E_C] = gc; F[E_PROG] = gp; F[E_WD] = F[C_WD]!;
    if (keeper) {
      F[E_DANGER] = 0; F[E_WP] = F[C_WP]!;
      emit(out, i, kind);
      continue;
    }
    F[P_X] = gx; F[P_Z] = gz; spotDanger(1);
    F[E_DANGER] = F[P_OUT]!;
    F[E_WP] = gd >= LT.longBallDist && gp > 0 ? F[C_WPD]! : F[C_WP]!;
    emit(out, i, kind);
    // Lob over a blocked lane (a lob in the crossing zone becomes a cross: crosses cover it there).
    if (!inZone && gc < LT.lobTrigger && d0 >= LT.lobMinDist) {
      lobPass(s, q);
      const lx = F[O_X]!, lz = F[O_Z]!;
      const ldx = lx - bx, ldz = lz - bz;
      const lp = dir * ldx;
      const lc = F[O_C]!;
      F[P_X] = lx; F[P_Z] = lz; spotDanger(1);
      F[E_X] = lx; F[E_Z] = lz; F[E_C] = lc; F[E_PROG] = lp; F[E_DANGER] = F[P_OUT]!;
      F[E_WP] = ldx * ldx + ldz * ldz >= LT.longBallDist * LT.longBallDist && lp > 0 ? F[C_WPD]! : F[C_WP]!;
      F[E_WD] = F[C_WD]!;
      emit(out, i, KickKind.LOB_PASS);
    }
    // Through balls to forward runners.
    if (isRunner(q, dir)) {
      throughBall(s, out, slot, q, 0);
      const lane = F[O_LANE]!;
      if (lane >= 0 && lane < LT.lobTrigger) throughBall(s, out, slot, q, 1);
    }
  }
  if (inZone) crosses(s, out, slot, team, dir, offside);
  const cnt = NI[1]!;
  sortOut(out, cnt);
  return cnt;
}

// ---------------------------------------------------------------- test hook

/** The SIM-01 roll-model mirror used by the lanes, for tests: [launch speed for (dist, arrive), seconds to roll dist at
 *  that speed (-1 if it stops)]. Allocates (test use only). */
export function rollModelForTest(dist: number, arrive: number): [number, number] {
  F[RS_D] = dist; F[RS_VA] = arrive; passSpeed();
  const v = F[RS_V0]!;
  rollTime();
  return [v, F[RS_T]!];
}

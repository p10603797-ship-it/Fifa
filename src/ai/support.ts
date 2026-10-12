/**
 * [TAI-02] Attacking support play and passing angles: offer passing triangles to the ball carrier, stretch the
 * width, show for the ball between lines; SUPPORT jobs for teammates of the carrier. "Call for support" (R1 tap
 * from a human, ctrl seq) brings the nearest midfielder toward the carrier.
 *
 * Design (BRIEF §7 "In possession: offer passing triangles, stretch the width ... call-for-support inputs override"):
 *  - Anchor: the ball carrier of `team`, or, while our pass is in flight, its intended receiver at the reception
 *    point (support is offered for the next pass). No anchor (opponent ball, loose ball) -> no support jobs.
 *  - Called supporter (team.supportSlot / supportCallT, set by callSupport, counted down here once per tick):
 *    comes to ~callDist from the carrier on the most open lane, at sprint speed, for callSeconds.
 *  - Holding midfielder (CDM, else the deepest CM): when the carrier is 3-26 m ahead of his home he offers a safe
 *    back option on a fan of points 10-14 m behind the carrier (further up he keeps his rest-defence spot).
 *  - Width: wide roles (RM/LM/RW/LW/RWB/LWB) hold a spot near the touchline at their home x while the ball is
 *    outside the final third (always in BUILD_UP); in BUILD_UP a side with no wide role uses its full-back.
 *  - Near supporters (2-3 incl. holder and called player): the teammates nearest the carrier score candidate
 *    points on two rings around their home (pulled toward the carrier when far) by lane openness (interception
 *    reach model vs every opponent), space, the 8-20 m distance band, progress, the cost of moving there (from the
 *    position the player's velocity is carrying him to: hysteresis without memory), crowding of teammates' planned
 *    spots (hard minimum spacing) and overlap with lanes already taken (triangles, not lines). Centre-backs join
 *    only in BUILD_UP (rest defence). Supporters jog; only the called supporter sprints.
 *  - Every target is clamped onside (behind max(offside line - margin, anchor, halfway)), inside the pitch and
 *    outside the own goal area. Everything is mirrored by team.dir (point reflection of the pitch).
 *  - Evaluation runs every tick and is a pure function of the current state: no cross-tick memory outside
 *    SimState, so snapshot resync (NET-05), replays and interleaved matches stay bit-identical. Module scratch is
 *    rewritten before every use. Budget measured < 0.05 ms per tick.
 * Jobs go through ai/jobs.ts assignJob (only overrides lower-or-equal priority jobs); players that already hold a
 * job above HOLD_SHAPE this tick (chaser, transition runs, ...) are left alone.
 */
import {
  CROSS_ZONE_DEPTH, GOAL_AREA_DEPTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, secToTicks,
} from '../contracts/constants';
import { AiJob, MatchPhase, Role, TeamPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { dcos, dsin, PI } from '../sim/core/dmath';
import { otherTeam, teamEnd, teamStart } from '../sim/core/query';
import { assignJob, isJobDriven } from './jobs';

/** TUNING-CR: move into contracts/tuning.ts as T_SUPPORT. */
export const LOCAL_TUNING = {
  /** Distance band of a triangle support point from the carrier, m (hard minimum, soft maximum). */
  bandMin: 8,
  bandMax: 20,
  /** No support target (width spot, called supporter fan) closer than this to the carrier, m. */
  minFromCarrier: 5,
  /** Close options around the carrier (near supporters + holding midfielder + called supporter), count. */
  maxClose: 3,
  /** Selection range: 0.5 * (|home - carrier| + |position - carrier|) must be within this, m. */
  selectRange: 35,
  /** Candidate rings around a supporter's (pulled) home, m. */
  ringInner: 4.5,
  ringOuter: 9,
  /** A home farther than this from the carrier is pulled toward him to this distance before the rings, m. */
  pullDist: 15,
  /** Lane interception reach of a defender: base (m) + growth per metre of pass distance (m/m). */
  laneReachBase: 0.9,
  laneReachPerM: 0.22,
  /** Lane clearance scoring cap (+-), m. */
  laneCap: 5,
  /** Space (nearest opponent to the point) scoring cap, m. */
  spaceCap: 8,
  /** Score weights, per metre (wAngle per unit of normalised lane overlap). */
  wLane: 1.5,
  wSpace: 0.4,
  wBand: 1.0,
  wProg: 0.08,
  wMove: 0.12,
  wHome: 0.08,
  wCrowd: 1.2,
  wAngle: 3,
  /** Progress term cap, m. */
  progCap: 10,
  /** Move cost is measured from where the player's velocity carries him in this time, s (commitment). */
  commitLookahead: 0.6,
  /** Soft spacing to teammates' planned spots, m; candidates closer than hardSeparation are rejected, m. */
  minSeparation: 6,
  hardSeparation: 3,
  /** Two lanes from the carrier with direction cosine above this overlap (cos 20 deg). */
  laneCosMax: 0.94,
  /** Width: wide players hold this far inside the touchline, m; full-back fallback in build-up, m. */
  widthMargin: 3,
  fbWidthMargin: 5,
  /** Holding midfielder back option: carrier at least holdAheadMin and at most holdAheadMax ahead of his home
   *  (beyond that he keeps the rest-defence position), m; fan radii behind the carrier, m. */
  holdAheadMin: 3,
  holdAheadMax: 26,
  holdNear: 10,
  holdFar: 14,
  /** Call for support: duration s; distance from the carrier the called player comes to, m; max range, m. */
  callSeconds: 2,
  callDist: 6.5,
  callRange: 45,
  /** Call selection penalty for forwards / defenders (m-equivalent; midfielders 0). */
  callPenaltyFwd: 6,
  callPenaltyDef: 10,
  /** Speed caps as a fraction of the player's top speed: supporters jog (= T_PLAYER.jogFraction); a called
   *  supporter sprints (TAI-07 should set wantSprint for a SUPPORT job whose cap is above jog speed). */
  speedSupport: 0.6,
  speedWidth: 0.6,
  speedHold: 0.6,
  speedCall: 1.0,
  /** Margin behind the offside line, m. */
  onsideMargin: 0.8,
  /** Targets stay this far inside the touchlines and goal lines (and outside the own goal area), m. */
  edgeMargin: 1.0,
} as const; // TUNING-CR

const T = LOCAL_TUNING;
/** Ticks a call for support lasts. */
export const SUPPORT_CALL_TICKS = secToTicks(T.callSeconds);
const REJECT = -1e18;
const DEG = PI / 180;

// ---------------------------------------------------------------- candidate tables (module constants)

const S3 = Math.sqrt(3) / 2;
/** Ring candidates around a supporter's anchor: centre, 6 inner, 6 outer (offset 30 deg). Unit offsets * radius. */
const RING_N = 13;
const RING_X = new Float64Array([0, 1, 0.5, -0.5, -1, -0.5, 0.5, S3, 0, -S3, -S3, 0, S3]);
const RING_Z = new Float64Array([0, 0, S3, S3, 0, -S3, -S3, 0.5, 1, 0.5, -0.5, -1, -0.5]);
const RING_R = new Float64Array(RING_N);
for (let k = 1; k < RING_N; k++) RING_R[k] = k <= 6 ? T.ringInner : T.ringOuter;

/** Holding-midfielder fan behind the carrier: angles (cos, sin) x two radii. */
const HOLD_ANGLES = [0, 30, -30, 55, -55];
const HOLD_N = HOLD_ANGLES.length;
const HOLD_C = new Float64Array(HOLD_N);
const HOLD_S = new Float64Array(HOLD_N);
for (let k = 0; k < HOLD_N; k++) { HOLD_C[k] = dcos(HOLD_ANGLES[k]! * DEG); HOLD_S[k] = dsin(HOLD_ANGLES[k]! * DEG); }

/** Called-supporter fan around the carrier -> supporter direction. */
const CALL_ANGLES = [0, 35, -35, 70, -70];
const CALL_N = CALL_ANGLES.length;
const CALL_C = new Float64Array(CALL_N);
const CALL_S = new Float64Array(CALL_N);
for (let k = 0; k < CALL_N; k++) { CALL_C[k] = dcos(CALL_ANGLES[k]! * DEG); CALL_S[k] = dsin(CALL_ANGLES[k]! * DEG); }

// ---------------------------------------------------------------- per-call scratch (rewritten before every use)

const oppX = new Float64Array(PLAYERS_PER_TEAM);
const oppZ = new Float64Array(PLAYERS_PER_TEAM);
let oppN = 0;
/**
 * Double scratch. Internal helpers take and return no doubles (a double crossing a call that V8 does not inline,
 * or stored in a module `let`, boxes a heap number); they read and write these slots instead.
 */
const F = new Float64Array(28);
/** laneClear: endpoints in, clearance and space (nearest opponent to the end point) out. */
const F_LA_X = 0, F_LA_Z = 1, F_LB_X = 2, F_LB_Z = 3, F_LANE = 4, F_SPACE = 5;
/** scorePoint: candidate (clamped in place by clampCandidate), heading, home, bound in; score out. */
const F_CX = 6, F_CZ = 7, F_PROJ_X = 8, F_PROJ_Z = 9, F_HOME_X = 10, F_HOME_Z = 11, F_BOUND = 12, F_SCORE = 13;
/** Best candidate of the last evaluation / target handed to give(). */
const F_BEST_X = 14, F_BEST_Z = 15;
/** findAnchor result; anchor of the current pass; onside limit (dir * x must not exceed it). */
const F_ANCHOR_X = 16, F_ANCHOR_Z = 17, F_AX = 18, F_AZ = 19, F_ONSIDE = 20;
/** evalRing centre; evalFan base direction and radii; loadOpponents: offside line in attack coordinates. */
const F_CENTRE_X = 21, F_CENTRE_Z = 22, F_BASE_X = 23, F_BASE_Z = 24, F_R0 = 25, F_R1 = 26, F_LINE_U = 27;
/** 1 = slot already handled by this module this tick. */
const taken = new Uint8Array(NUM_SLOTS);
/**
 * Teammates' planned spots for crowding (index slot - teamStart): job target for AI-driven players (updated as
 * this module assigns jobs), else the current position; planOn = 0 for inactive players and the anchor.
 */
const planX = new Float64Array(PLAYERS_PER_TEAM);
const planZ = new Float64Array(PLAYERS_PER_TEAM);
const planOn = new Uint8Array(PLAYERS_PER_TEAM);
/** Unit directions (from the carrier) of the close-support lanes chosen so far this tick. */
const MAX_LANES = 8;
const laneUx = new Float64Array(MAX_LANES);
const laneUz = new Float64Array(MAX_LANES);
let laneN = 0;
/** Context of the current evaluation (integers only). */
let ctxTeam = 0;
let ctxDir = 1;
let ctxAnchor = -1;

/** Speed kinds for give() (Smi codes so no double crosses the call). */
const SPEED_SUPPORT = 0, SPEED_WIDTH = 1, SPEED_HOLD = 2, SPEED_CALL = 3;

/** Anchor written by supportAnchor (exported for tests and other AI modules). */
export interface SupportAnchor { slot: number; x: number; z: number }

// ---------------------------------------------------------------- role helpers

function isWideRole(r: Role): boolean {
  return r === Role.RM || r === Role.LM || r === Role.RW || r === Role.LW || r === Role.RWB || r === Role.LWB;
}
function isMidRole(r: Role): boolean {
  return r === Role.CDM || r === Role.CM || r === Role.CAM || r === Role.RM || r === Role.LM;
}
function isFwdRole(r: Role): boolean {
  return r === Role.RW || r === Role.LW || r === Role.ST || r === Role.CF;
}
function isFullBack(r: Role): boolean {
  return r === Role.RB || r === Role.LB;
}

// ---------------------------------------------------------------- anchor

/**
 * Slot the team supports and its position (written to F_ANCHOR_X/Z): the team's ball owner, or the intended
 * receiver of our pass in flight (at the reception point, clamped to the pitch). -1 when the team has no ball.
 */
function findAnchor(s: SimState, team: number): number {
  const b = s.ball;
  if (b.owner >= 0) {
    const o = s.players[b.owner]!;
    if (o.team !== team || o.active !== 1) return -1;
    F[F_ANCHOR_X] = o.x;
    F[F_ANCHOR_Z] = o.z;
    return b.owner;
  }
  const r = b.passTarget;
  if (r < 0 || r >= NUM_SLOTS || b.lastKickTeam !== team || b.lastTouchTeam !== team) return -1;
  const p = s.players[r]!;
  if (p.team !== team || p.active !== 1) return -1;
  const px = b.passX, pz = b.passZ;
  F[F_ANCHOR_X] = px > HALF_LENGTH ? HALF_LENGTH : px < -HALF_LENGTH ? -HALF_LENGTH : px;
  F[F_ANCHOR_Z] = pz > HALF_WIDTH ? HALF_WIDTH : pz < -HALF_WIDTH ? -HALF_WIDTH : pz;
  return r;
}

/** The point the team currently supports: ball owner or receiver of our pass in flight. Returns the slot or -1. */
export function supportAnchor(s: SimState, team: number, out: SupportAnchor): number {
  const a = findAnchor(s, team);
  out.slot = a;
  out.x = a >= 0 ? F[F_ANCHOR_X]! : 0;
  out.z = a >= 0 ? F[F_ANCHOR_Z]! : 0;
  return a;
}

// ---------------------------------------------------------------- lanes

/**
 * Load the active opponents of `team` into the scratch and the offside line (second-deepest opponent toward his
 * own goal, keeper included, = query.secondLastDefenderX) in attack coordinates u = dir * x into F_LINE_U.
 */
function loadOpponents(s: SimState, team: number, dir: number): void {
  const opp = otherTeam(team);
  const end = teamEnd(opp);
  let first = -1e9, second = -1e9;
  oppN = 0;
  for (let i = teamStart(opp); i < end; i++) {
    const o = s.players[i]!;
    if (o.active !== 1) continue;
    oppX[oppN] = o.x;
    oppZ[oppN] = o.z;
    oppN++;
    const u = dir * o.x;
    if (u > first) { second = first; first = u; } else if (u > second) second = u;
  }
  F[F_LINE_U] = second <= -1e9 ? first : second;
}

/**
 * Clearance (m) of the pass lane A -> B (F_LA_*, F_LB_*) against the loaded opponents into F_LANE: min over
 * opponents ahead of the passer of (distance to the lane) - (interception reach at that point of the lane).
 * Positive = open. Opponents behind the passer (relative to this lane) do not block it. F_SPACE = nearest
 * opponent to B.
 */
function laneClear(): void {
  const ax = F[F_LA_X]!, az = F[F_LA_Z]!, bx = F[F_LB_X]!, bz = F[F_LB_Z]!;
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const len = Math.sqrt(l2);
  let clear = 1e9;
  let space = 1e9;
  for (let k = 0; k < oppN; k++) {
    const ox = oppX[k]! - ax, oz = oppZ[k]! - az;
    const ex = oppX[k]! - bx, ez = oppZ[k]! - bz;
    const de = Math.sqrt(ex * ex + ez * ez);
    if (de < space) space = de;
    const proj = ox * dx + oz * dz;
    if (proj <= 0 || l2 <= 0) continue;
    let d: number, u: number;
    if (proj >= l2) { d = de; u = len; } else {
      const t = proj / l2;
      const px = ox - dx * t, pz = oz - dz * t;
      d = Math.sqrt(px * px + pz * pz);
      u = t * len;
    }
    const c = d - (T.laneReachBase + T.laneReachPerM * u);
    if (c < clear) clear = c;
  }
  F[F_LANE] = clear;
  F[F_SPACE] = space;
}

/**
 * Lane clearance (m) of a pass from (ax, az) to (bx, bz) by `team` against the active opponents (positive = open;
 * same model the support scoring uses). Pure helper for other AI modules and tests.
 */
export function laneClearance(s: SimState, team: number, ax: number, az: number, bx: number, bz: number): number {
  loadOpponents(s, team, s.teams[team]!.dir >= 0 ? 1 : -1);
  F[F_LA_X] = ax; F[F_LA_Z] = az; F[F_LB_X] = bx; F[F_LB_Z] = bz;
  laneClear();
  return F[F_LANE]!;
}

// ---------------------------------------------------------------- targets

/** Clamp the candidate (F_CX, F_CZ) in place: onside, inside the pitch, outside the own goal area. */
function clampCandidate(): void {
  let u = ctxDir * F[F_CX]!;
  const on = F[F_ONSIDE]!;
  if (u > on) u = on;
  const hi = HALF_LENGTH - T.edgeMargin;
  const lo = -HALF_LENGTH + GOAL_AREA_DEPTH + T.edgeMargin;
  if (u > hi) u = hi; else if (u < lo) u = lo;
  F[F_CX] = ctxDir * u;
  const z = F[F_CZ]!;
  const lim = HALF_WIDTH - T.edgeMargin;
  F[F_CZ] = z > lim ? lim : z < -lim ? -lim : z;
}

/**
 * Score of the candidate (F_CX, F_CZ) for `slot` into F_SCORE (higher is better): REJECT when illegal or when it
 * cannot beat F_BOUND. F_PROJ = where the player is heading (commitment), F_HOME = his reference spot.
 * band = 1: triangle point (8-20 m band, hard minimum); 0: fan point (minFromCarrier only).
 */
function scorePoint(s: SimState, slot: number, band: number): void {
  F[F_SCORE] = REJECT;
  const ax = F[F_AX]!, az = F[F_AZ]!, cx = F[F_CX]!, cz = F[F_CZ]!;
  const dx = cx - ax, dz = cz - az;
  const d = Math.sqrt(dx * dx + dz * dz);
  // Triangle points never come inside the band (crowding the carrier); the upper bound is soft.
  if (d < (band === 1 ? T.bandMin : T.minFromCarrier)) return;
  let sc = 0;
  if (band === 1 && d > T.bandMax) sc -= T.wBand * (d - T.bandMax);
  let prog = ctxDir * dx;
  if (prog > T.progCap) prog = T.progCap; else if (prog < -T.progCap) prog = -T.progCap;
  sc += T.wProg * prog;
  let mx = cx - F[F_PROJ_X]!, mz = cz - F[F_PROJ_Z]!;
  sc -= T.wMove * Math.sqrt(mx * mx + mz * mz);
  mx = cx - F[F_HOME_X]!; mz = cz - F[F_HOME_Z]!;
  sc -= T.wHome * Math.sqrt(mx * mx + mz * mz);
  // Crowding: teammates' planned spots.
  const hard2 = T.hardSeparation * T.hardSeparation;
  const soft2 = T.minSeparation * T.minSeparation;
  const self = slot - teamStart(ctxTeam);
  for (let j = 0; j < PLAYERS_PER_TEAM; j++) {
    if (j === self || planOn[j] === 0) continue;
    const ex = cx - planX[j]!, ez = cz - planZ[j]!;
    const e2 = ex * ex + ez * ez;
    if (e2 < hard2) return;
    if (e2 < soft2) sc -= T.wCrowd * (T.minSeparation - Math.sqrt(e2));
  }
  // Overlap with lanes already offered (one supporter screening another).
  const ux = dx / d, uz = dz / d;
  for (let l = 0; l < laneN; l++) {
    const cs = ux * laneUx[l]! + uz * laneUz[l]!;
    if (cs > T.laneCosMax) sc -= T.wAngle * (cs - T.laneCosMax) / (1 - T.laneCosMax);
  }
  if (sc + T.wLane * T.laneCap + T.wSpace * T.spaceCap <= F[F_BOUND]!) return;
  F[F_LA_X] = ax; F[F_LA_Z] = az; F[F_LB_X] = cx; F[F_LB_Z] = cz;
  laneClear();
  let lane = F[F_LANE]!;
  if (lane > T.laneCap) lane = T.laneCap; else if (lane < -T.laneCap) lane = -T.laneCap;
  const sp = F[F_SPACE]!;
  F[F_SCORE] = sc + T.wLane * lane + T.wSpace * (sp < T.spaceCap ? sp : T.spaceCap);
}

/** Set F_PROJ (where the player's velocity carries him: commitment) and F_HOME for `slot`. */
function loadPlayer(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  F[F_PROJ_X] = p.x + p.vx * T.commitLookahead;
  F[F_PROJ_Z] = p.z + p.vz * T.commitLookahead;
  F[F_HOME_X] = p.homeX;
  F[F_HOME_Z] = p.homeZ;
}

/** Score the clamped candidate and keep it in F_BEST when it beats the bound (F_BOUND tracks the best score). */
function tryCandidate(s: SimState, slot: number, band: number): void {
  clampCandidate();
  scorePoint(s, slot, band);
  if (F[F_SCORE]! > F[F_BOUND]!) {
    F[F_BOUND] = F[F_SCORE]!;
    F[F_BEST_X] = F[F_CX]!;
    F[F_BEST_Z] = F[F_CZ]!;
  }
}

/** Best ring point around (F_CENTRE_X, F_CENTRE_Z) for a near supporter into F_BEST; false if none legal. */
function evalRing(s: SimState, slot: number): boolean {
  loadPlayer(s, slot);
  F[F_BOUND] = REJECT;
  const cx = F[F_CENTRE_X]!, cz = F[F_CENTRE_Z]!;
  for (let k = 0; k < RING_N; k++) {
    const r = RING_R[k]! * ctxDir;
    F[F_CX] = cx + RING_X[k]! * r;
    F[F_CZ] = cz + RING_Z[k]! * r;
    tryCandidate(s, slot, 1);
  }
  return F[F_BOUND]! > REJECT;
}

/**
 * Best point of a fan around the anchor into F_BEST: base unit (F_BASE_X, F_BASE_Z) rotated by the table angles
 * at radii F_R0 and F_R1 (one radius when equal). False if none legal.
 */
function evalFan(s: SimState, slot: number, cosT: Float64Array, sinT: Float64Array, n: number, band: number): boolean {
  loadPlayer(s, slot);
  F[F_BOUND] = REJECT;
  const ax = F[F_AX]!, az = F[F_AZ]!, bx = F[F_BASE_X]!, bz = F[F_BASE_Z]!, r0 = F[F_R0]!, r1 = F[F_R1]!;
  const radii = r1 === r0 ? 1 : 2;
  for (let ri = 0; ri < radii; ri++) {
    const rad = ri === 0 ? r0 : r1;
    for (let k = 0; k < n; k++) {
      const c = cosT[k]!, sn = sinT[k]!;
      F[F_CX] = ax + (bx * c - bz * sn) * rad;
      F[F_CZ] = az + (bx * sn + bz * c) * rad;
      tryCandidate(s, slot, band);
    }
  }
  return F[F_BOUND]! > REJECT;
}

/** Remember the lane to F_BEST (from the anchor) as offered. */
function pushLane(): void {
  if (laneN >= MAX_LANES) return;
  const dx = F[F_BEST_X]! - F[F_AX]!, dz = F[F_BEST_Z]! - F[F_AZ]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= 1e-6) return;
  laneUx[laneN] = dx / d;
  laneUz[laneN] = dz / d;
  laneN++;
}

/** Eligible for a support job this tick: AI-driven outfield player still holding shape, not the anchor. */
function isFree(s: SimState, slot: number): boolean {
  return slot !== ctxAnchor && taken[slot] === 0 && isJobDriven(s, slot) && s.players[slot]!.job === AiJob.HOLD_SHAPE;
}

/** SUPPORT job at F_BEST for `slot` with the speed of `kind`; marks the slot handled. True if applied. */
function give(s: SimState, slot: number, kind: number): boolean {
  taken[slot] = 1;
  const frac = kind === SPEED_CALL ? T.speedCall : kind === SPEED_HOLD ? T.speedHold
    : kind === SPEED_WIDTH ? T.speedWidth : T.speedSupport;
  if (!assignJob(s, slot, AiJob.SUPPORT, F[F_BEST_X]!, F[F_BEST_Z]!, s.attrs[slot]!.topSpeed * frac, ctxAnchor)) return false;
  const j = slot - teamStart(ctxTeam);
  planX[j] = F[F_BEST_X]!;
  planZ[j] = F[F_BEST_Z]!;
  return true;
}

/** Holding midfielder of the team (CDM, else CM; deepest home, then nearest the anchor laterally, then slot). */
function findHolder(s: SimState, team: number, dir: number): number {
  const az = F[F_AZ]!;
  let best = -1, bestRank = 9, bestDepth = 1e9, bestLat = 1e9;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    const rank = p.role === Role.CDM ? 0 : p.role === Role.CM ? 1 : 9;
    if (rank === 9) continue;
    const depth = dir * p.homeX;
    const lat = p.homeZ > az ? p.homeZ - az : az - p.homeZ;
    if (rank < bestRank || (rank === bestRank && (depth < bestDepth || (depth === bestDepth && lat < bestLat)))) {
      best = i; bestRank = rank; bestDepth = depth; bestLat = lat;
    }
  }
  return best;
}

/** Hold width: spot at home x near the touchline on the side of his home (fullBack = 1: full-back margin). */
function holdWidth(s: SimState, slot: number, fullBack: number): void {
  const p = s.players[slot]!;
  if (p.homeZ < 1 && p.homeZ > -1) return;
  const side = p.homeZ > 0 ? 1 : -1;
  F[F_CX] = p.homeX;
  F[F_CZ] = side * (HALF_WIDTH - (fullBack === 1 ? T.fbWidthMargin : T.widthMargin));
  clampCandidate();
  const x = F[F_CX]!, z = F[F_CZ]!;
  // Keep clear of the carrier and of teammates' planned spots.
  const dx = x - F[F_AX]!, dz = z - F[F_AZ]!;
  if (dx * dx + dz * dz < T.minFromCarrier * T.minFromCarrier) return;
  const hard2 = T.hardSeparation * T.hardSeparation;
  const self = slot - teamStart(ctxTeam);
  for (let j = 0; j < PLAYERS_PER_TEAM; j++) {
    if (j === self || planOn[j] === 0) continue;
    const ex = x - planX[j]!, ez = z - planZ[j]!;
    if (ex * ex + ez * ez < hard2) return;
  }
  F[F_BEST_X] = x;
  F[F_BEST_Z] = z;
  give(s, slot, SPEED_WIDTH);
}

function widthPass(s: SimState, team: number, buildUp: boolean): void {
  const end = teamEnd(team);
  let wideR = 0, wideL = 0;
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1 || !isWideRole(p.role)) continue;
    if (p.homeZ > 0) wideR = 1; else if (p.homeZ < 0) wideL = 1;
    if (isFree(s, i)) holdWidth(s, i, 0);
  }
  if (!buildUp) return;
  // A side without a wide role (diamond, short-handed): its full-back provides the width in build-up.
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || !isFullBack(p.role) || !isFree(s, i)) continue;
    if ((p.homeZ > 0 && wideR === 0) || (p.homeZ < 0 && wideL === 0)) holdWidth(s, i, 1);
  }
}

// ---------------------------------------------------------------- call for support

/**
 * The teammate a call for support would bring (pure): nearest to the carrier with midfielders preferred
 * (forwards and defenders pay a distance penalty), AI-driven, within callRange. -1 if none.
 */
export function pickCallSupporter(s: SimState, team: number): number {
  const a = findAnchor(s, team);
  if (a < 0) return -1;
  const ax = F[F_ANCHOR_X]!, az = F[F_ANCHOR_Z]!;
  let best = -1, bestKey = 1e18;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (i === a || !isJobDriven(s, i)) continue;
    const p = s.players[i]!;
    const dx = p.x - ax, dz = p.z - az;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > T.callRange) continue;
    const key = d + (isMidRole(p.role) ? 0 : isFwdRole(p.role) ? T.callPenaltyFwd : T.callPenaltyDef);
    if (key < bestKey) { bestKey = key; best = i; }
  }
  return best;
}

/** Human pressed call-for-support: mark a supporter (stored via job SUPPORT with high urgency for N ticks). */
export function callSupport(s: SimState, team: number, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const slot = pickCallSupporter(s, team);
  if (slot < 0) return;
  const t = s.teams[team]!;
  t.supportSlot = slot;
  t.supportCallT = SUPPORT_CALL_TICKS;
}

function cancelCall(s: SimState, team: number): void {
  const t = s.teams[team]!;
  t.supportSlot = -1;
  t.supportCallT = 0;
}

/** Validate the active call against the anchor; returns the called slot to serve this tick or -1. */
function activeCall(s: SimState, team: number, anchor: number): number {
  const t = s.teams[team]!;
  if (t.supportCallT <= 0 || t.supportSlot < 0) {
    if (t.supportSlot !== -1 || t.supportCallT !== 0) cancelCall(s, team);
    return -1;
  }
  const c = t.supportSlot;
  if (c < teamStart(team) || c >= teamEnd(team) || !isJobDriven(s, c)) { cancelCall(s, team); return -1; }
  if (anchor < 0) {
    // The opponent has the ball: the call is over. A loose ball keeps it alive (pass in flight, bobble).
    const o = s.ball.owner;
    if (o >= 0 && s.players[o]!.team !== team) cancelCall(s, team);
    return -1;
  }
  if (c === anchor) { cancelCall(s, team); return -1; }
  return c;
}

function countDownCall(s: SimState, team: number): void {
  const t = s.teams[team]!;
  if (t.supportCallT > 0) {
    t.supportCallT--;
    if (t.supportCallT === 0) t.supportSlot = -1;
  }
}

// ---------------------------------------------------------------- main pass

export function assignSupport(s: SimState, team: number, ev: EventSink): void {
  const anchor = findAnchor(s, team);
  const called = activeCall(s, team, anchor);
  if (anchor < 0) { countDownCall(s, team); return; }

  const tm = s.teams[team]!;
  const dir = tm.dir >= 0 ? 1 : -1;
  ctxTeam = team;
  ctxDir = dir;
  ctxAnchor = anchor;
  const ax = F[F_ANCHOR_X]!, az = F[F_ANCHOR_Z]!;
  F[F_AX] = ax;
  F[F_AZ] = az;
  loadOpponents(s, team, dir);
  const lineU = F[F_LINE_U]! - T.onsideMargin;
  const anchorU = dir * ax;
  const onside = lineU > anchorU ? lineU : anchorU;
  F[F_ONSIDE] = onside > 0 ? onside : 0;
  laneN = 0;
  const start = teamStart(team), end = teamEnd(team);
  for (let i = start; i < end; i++) {
    taken[i] = 0;
    const q = s.players[i]!;
    const j = i - start;
    planOn[j] = q.active === 1 && i !== anchor ? 1 : 0;
    if (isJobDriven(s, i)) { planX[j] = q.tgtX; planZ[j] = q.tgtZ; } else { planX[j] = q.x; planZ[j] = q.z; }
  }
  taken[anchor] = 1;

  const buildUp = tm.phase === TeamPhase.BUILD_UP;
  const finalThird = anchorU > HALF_LENGTH - CROSS_ZONE_DEPTH;
  let close = 0;

  // 1. Called supporter: toward the carrier on the most open lane, at sprint speed.
  if (called >= 0) {
    const p = s.players[called]!;
    if (p.job <= AiJob.SUPPORT) {
      let bx = p.x - ax, bz = p.z - az;
      const bl = Math.sqrt(bx * bx + bz * bz);
      if (bl > 1e-6) { bx /= bl; bz /= bl; } else { bx = -dir; bz = 0; }
      F[F_BASE_X] = bx; F[F_BASE_Z] = bz; F[F_R0] = T.callDist; F[F_R1] = T.callDist;
      if (!evalFan(s, called, CALL_C, CALL_S, CALL_N, 0)) {
        F[F_CX] = ax + bx * T.callDist;
        F[F_CZ] = az + bz * T.callDist;
        clampCandidate();
        F[F_BEST_X] = F[F_CX]!;
        F[F_BEST_Z] = F[F_CZ]!;
      }
      if (give(s, called, SPEED_CALL)) { pushLane(); close++; }
    }
  }
  countDownCall(s, team);

  // 2. Holding midfielder: safe back option behind the carrier.
  const holder = findHolder(s, team, dir);
  if (holder >= 0 && isFree(s, holder)) {
    const ahead = anchorU - dir * s.players[holder]!.homeX;
    if (ahead >= T.holdAheadMin && ahead <= T.holdAheadMax) {
      F[F_BASE_X] = -dir; F[F_BASE_Z] = 0; F[F_R0] = T.holdNear; F[F_R1] = T.holdFar;
      if (evalFan(s, holder, HOLD_C, HOLD_S, HOLD_N, 1)) {
        if (give(s, holder, SPEED_HOLD)) { pushLane(); close++; }
      } else taken[holder] = 1;
    }
  }

  // 3. Width (before the triangles in build-up so wide players stay wide).
  if (buildUp) widthPass(s, team, true);

  // 4. Near supporters: nearest free teammates offer open lanes in the 8-20 m band.
  let want = T.maxClose - close;
  if (want < 1) want = 1;
  while (want > 0) {
    let pick = -1, pickKey = 1e18;
    for (let i = start; i < end; i++) {
      if (!isFree(s, i)) continue;
      const p = s.players[i]!;
      if (!buildUp && p.role === Role.CB) continue; // rest defence stays home in attack
      const hx = p.homeX - ax, hz = p.homeZ - az;
      const px = p.x - ax, pz = p.z - az;
      const key = 0.5 * (Math.sqrt(hx * hx + hz * hz) + Math.sqrt(px * px + pz * pz));
      if (key <= T.selectRange && key < pickKey) { pickKey = key; pick = i; }
    }
    if (pick < 0) break;
    const p = s.players[pick]!;
    const hx = p.homeX - ax, hz = p.homeZ - az;
    const hd = Math.sqrt(hx * hx + hz * hz);
    if (hd > T.pullDist) {
      F[F_CENTRE_X] = ax + hx * (T.pullDist / hd);
      F[F_CENTRE_Z] = az + hz * (T.pullDist / hd);
    } else {
      F[F_CENTRE_X] = p.homeX;
      F[F_CENTRE_Z] = p.homeZ;
    }
    if (evalRing(s, pick)) {
      if (give(s, pick, SPEED_SUPPORT)) { pushLane(); want--; }
    } else taken[pick] = 1;
  }

  // 5. Width for the remaining wide players outside the final third.
  if (!buildUp && !finalThird) widthPass(s, team, false);
}

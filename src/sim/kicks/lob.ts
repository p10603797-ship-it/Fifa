/**
 * [SIM-09] Lobs and crosses: LOB_PASS, HIGH_LOB, DRIVEN_LOB, CROSS, GROUND_CROSS, LOW_CROSS.
 * "In the crossing zone, a lob becomes a cross aimed at the near post, far post or penalty spot from power
 * and stick." Corner tactics (team.cornerTactic) bias cross targets. Uses SIM-01 solveLaunch.
 *
 * STARTER (startLob): LOB_PASS by a player inside geometry.inCrossingZone (his position, his team's attack direction)
 * is played as CROSS, DRIVEN_LOB as LOW_CROSS; every other kind as asked (GOAL_KICK, which the registry also maps to
 * solveLob, is accepted as a plain lob). The shared foot-kick starter beginFootKick (also used by SIM-10) validates like
 * SIM-08 startPass (free player, phase live for him, ball not held / owned by someone else, at his feet, in reach or
 * arriving within the wind-up) and fills the KICK action fields in SIM-08's layout: actKick, actPower / actCharging,
 * actDirX/Z = unit request direction (0, 0 = facing), actSlot = explicit teammate or -1, actX/Z = explicit point,
 * actCurve, actA = ReqFlag bits, actB = AssistLevel | hasTarget << 2. Contact at T_PASS.windup; SIM-08's KICK handler
 * runs the wind-up / charging / contact / recovery and calls KICK_SOLVERS (solveLob / solveCross) at contact.
 *
 * LOB SOLVER (solveLob, LOB_PASS / HIGH_LOB / DRIVEN_LOB / GOAL_KICK): launch angle T_PASS.lobAngle / highLobAngle /
 * drivenLobAngle with a little backspin (topspin on the driven lob), curl only from an explicit request curve.
 *  - Receiver: actSlot, else SIM-08 selectReceiver(lofted = 1) (Assisted / Semi; none with an explicit point or Manual).
 *  - Landing point: explicit point; else the receiver's predicted position when the ball lands (his velocity times the
 *    flight time: fixed-point iterations on SIM-01 solveLaunchSpin's flight time, LT.lobLeadIters, capped at
 *    LT.lobLeadMaxSec, kept inside the pitch); Semi blends LT.semiPowerBlend of the power-implied distance (lobDistMin ..
 *    lobDistMax) into that distance; no receiver / Manual: along the request direction (facing when unset) over the
 *    power-implied distance, and a teammate within LT.spaceReceiverRadius of the landing point becomes the target.
 *  - Launch: SIM-01 solveLaunchSpin from the ball's height to the FIRST landing; launch speed capped at LT.loftSpeedMax
 *    (a farther target falls short).
 * CROSS SOLVER (solveCross):
 *  - Aim: explicit point (corner reticle, gesture post spot); explicit receiver: his predicted position (lead); Manual:
 *    request direction x lerp(crossDistMin, crossDistMax, power); otherwise crossTarget: near post / penalty spot /
 *    far post from power (bands powerNear / powerFar; a GROUND_CROSS only near post / penalty spot), nudged by the stick
 *    (lateral toward the far / near side up to stickSideShift, pulling back away from goal up to stickBackShift; a
 *    stick straight at the goal line is neutral) and pulled cornerTacticWeight toward the team's corner tactic zone
 *    (team.cornerTactic: near post, far post, edge of the box, crowd the keeper).
 *  - CROSS: launch at crossAngle (floatCrossAngle with ReqFlag.LOFTED), LOW_CROSS: lowCrossAngle (fast and flat), both
 *    whipped with curl spin sy from the crossing attribute (crossCurlMin..Max, x lowCrossCurlMul / floatCrossCurlMul)
 *    bending AWAY from the keeper (toward the side of the aim point away from the goal centre; SIM-01 convention:
 *    positive sy curls LEFT of travel, built with curlSpinY); an explicit request curve sets the curl instead.
 *    solveLaunchSpin solves speed and the aim azimuth with that curl so the first landing is the aim point.
 *    GROUND_CROSS: along the floor (SIM-01 groundPassSpeed to arrive with lerp(groundCrossArriveMin, Max, power) m/s).
 *    A zone aim farther than crossMaxDist (a cross asked for far from the box, e.g. LOB, LOB in midfield) goes to the
 *    teammate SIM-08 selectReceiver picks (led like a pass) when there is one.
 *  - launch.target = actSlot, else the best attacker (closest teammate, keeper excluded, at his position
 *    LT.receiverLookSec-capped ahead along his run) within LT.spaceReceiverRadius of the aim point, else -1.
 * ERROR (both): SIM-08 kickErrorAim (accuracy longPassing for lobs, crossing for crosses; facing, pressure, sprint,
 * weak foot, power, stamina) rotates the launch; a second draw scales the speed by 1 + lengthErrorMul x error (clamped;
 * the kind's max launch speed still holds). A cross's power only picks its zone, so its error sees at most SIM-08's
 * power knee (no "extreme power" penalty for a far-post cross).
 * crossTarget is pure (CPU passing uses it). Determinism / cost: dmath + Math.sqrt, s.rng only in the solvers (always
 * eight draws: two kickErrorAim calls), slot-order scans with strict tie breaks, module scratch only. At contact: one
 * solveLaunchSpin (<= 12 drag flights of ~1-3 s), up to LT.lobLeadIters for a led receiver, O(11 x 11) selection.
 */
// Re-export the registry-facing shells FIRST: see lobHooks.ts (import-cycle safety with actions/registry).
export { solveCross, solveLob } from './lobHooks';
import { bindLobImpl } from './lobHooks';
import { beginAction, isFree } from '../actions/dispatch';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ } from '../../contracts/constants';
import { ActionKind, AssistLevel, Command, KickKind, MatchPhase, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { ReqFlag, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_PASS } from '../../contracts/tuning';
import { curlSpinY, groundPassSpeed, groundRollTime, solveLaunchSpin, type LaunchSolution } from '../ball/flight';
import { dcos, dsin } from '../core/dmath';
import { inCrossingZone } from '../pitch/geometry';
import { ballInReach, kickErrorAim, LOCAL_TUNING as PASS_TUNING, selectReceiver } from './pass';

/** TUNING-CR (SIM-09): proposed additions to T_PASS (units in the comments). */
export const LOCAL_TUNING = { // TUNING-CR
  // ---- lobs
  /** Lead of a moving receiver: fixed-point iterations on the flight time, the tolerance (s) and the max look-ahead (s). */
  lobLeadIters: 4,
  lobLeadTol: 0.02,
  lobLeadMaxSec: 3.5,
  /** Receivers slower than this are not led (one solve), m/s. */
  lobLeadMinSpeed: 0.3,
  /** Backspin (rad/s; + floats, - dips) of LOB_PASS / GOAL_KICK, HIGH_LOB and DRIVEN_LOB. */
  lobBackspin: 3,
  highLobBackspin: 4,
  drivenLobBackspin: -2,
  /** Curl spin at |request curve| = 1 on a lob, rad/s. */
  lobCurlSpin: 5,
  /** Power-implied lob distance at power 0 and 1 (no receiver / Manual / Semi blend), m. */
  lobDistMin: 12,
  lobDistMax: 50,
  /** Max launch speed of a lob, m/s (a farther target falls short). */
  loftSpeedMax: 32,
  /** Max launch speed of an aerial cross, m/s (a low cross needs pace). */
  crossSpeedMax: 36,
  /** Semi assistance: share of the power-implied distance blended into the receiver's distance, 0..1. */
  semiPowerBlend: 0.5,
  /** Power floor of a lob / cross (an instant tap), 0..1. */
  minPower: 0.05,
  /** A teammate within this distance of the landing / aim point becomes the target, m ... */
  spaceReceiverRadius: 6,
  /** ... judged at his position this far ahead along his run (at most), s. */
  receiverLookSec: 1.5,
  /** Lengthwise error: speed x (1 + lengthErrorMul x a second angular error draw in rad), clamped to +-lengthErrorCap. */
  lengthErrorMul: 0.35,
  lengthErrorCap: 0.1,
  /** Target points stay this far inside the touchlines and goal lines, m. */
  pitchMargin: 1,
  // ---- cross targets: depth from the attacked goal line, lateral offset toward the crosser's side (+) / far side (-), m
  nearPostDepth: 5.5,
  nearPostSide: 3.5,
  spotDepth: 11,
  spotSide: 0,
  farPostDepth: 6,
  farPostSide: -5,
  /** Power bands (0..1): below powerNear = near post, below powerFar = penalty spot, else far post. */
  powerNear: 1 / 3,
  powerFar: 2 / 3,
  /** Ground cross: power below this = near post, else penalty spot (0..1). */
  groundPowerSplit: 0.5,
  /** Stick nudge: lateral (toward the far side) up to this, m ... */
  stickSideShift: 3,
  /** ... and pulling back (stick pointing away from the goal) up to this, m. */
  stickBackShift: 5,
  /** Pull of the cross target toward the team's corner-tactic zone, 0..1. */
  cornerTacticWeight: 0.75,
  /** Corner-tactic zones (depth, side as above): far post, edge of the box, crowd the keeper, near post, m. */
  cornerFarDepth: 6,
  cornerFarSide: -5,
  cornerEdgeDepth: 15.8,
  cornerEdgeSide: 0,
  cornerKeeperDepth: 3,
  cornerKeeperSide: 0,
  cornerNearDepth: 5.5,
  cornerNearSide: 3.5,
  /** Cross targets stay at least this far out from the goal line, m. */
  crossMinDepth: 1.5,
  // ---- cross launch
  /** Launch angles: whipped cross, floated cross (ReqFlag.LOFTED), low driven cross, rad. */
  crossAngle: 0.38,
  floatCrossAngle: 0.55,
  lowCrossAngle: 0.2,
  /** Whip: curl spin from the crossing attribute 1 -> 99, rad/s. */
  crossCurlMin: 3,
  crossCurlMax: 7,
  /** Curl multipliers of the low cross and the floated cross. */
  lowCrossCurlMul: 0.5,
  floatCrossCurlMul: 0.8,
  /** |request curve| above this sets the curl (sign = side, x the whip) instead of the automatic outswinger, 0..1. */
  curveDeadZone: 0.05,
  /** Ground cross arrival speed at the target at power 0 and 1, m/s. */
  groundCrossArriveMin: 6,
  groundCrossArriveMax: 10,
  /** Manual cross distance along the request direction at power 0 and 1, m. */
  crossDistMin: 15,
  crossDistMax: 45,
  /** A zone aim farther than this from the ball (a cross asked for far from the box) goes to a teammate chosen like a
   *  pass (SIM-08 selectReceiver) when there is one, m. */
  crossMaxDist: 45,
  /** Ground cross lead: travel-time look-ahead cap, s. */
  groundLeadMaxSec: 3,
} as const;

const LT = LOCAL_TUNING;

const NS = NUM_SLOTS;
const PPT = PLAYERS_PER_TEAM;
const HZ = TICK_HZ;
const LIM_X = HALF_LENGTH - LT.pitchMargin;
const LIM_Z = HALF_WIDTH - LT.pitchMargin;
const DEFAULT_REC = T_PASS.contact + T_PASS.recovery;
/** Aim points closer to the ball than this give no direction, m. */
const AIM_MIN_DIST = 0.25;

/** 1 for restart phases (index = MatchPhase). */
const RESTART_PHASE = new Uint8Array(MatchPhase.POST_MATCH + 1);
for (const ph of RESTART_PHASES) RESTART_PHASE[ph] = 1;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

/** Launch solution scratch (a literal, not SIM-01's factory: nothing imported from a module that can sit in the
 *  registry import cycle is read while this module evaluates). SIM-08 tuning (PASS_TUNING) is likewise read only inside
 *  functions, at call time. */
const SOL: LaunchSolution = { vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, speed: 0, flightT: 0, landX: 0, landZ: 0, reached: 0 };
/** Solver scratch (doubles handed between helpers without boxing). */
const F = new Float64Array(12);
/** Target point, its distance from the ball, travel / flight time (s). */
const F_TX = 0, F_TZ = 1, F_D = 2, F_T = 3;
/** Request direction (unit). */
const F_UX = 4, F_UZ = 5;
/** Launch velocity and spin being built. */
const F_VX = 6, F_VY = 7, F_VZ = 8, F_SX = 9, F_SY = 10, F_SZ = 11;

// ---------------------------------------------------------------- small helpers

function validSlot(i: number): boolean { return i >= 0 && i < NS && (i | 0) === i; }
function fin(v: number): number { return v === v && v < Infinity && v > -Infinity ? v : 0; }
function clamp01(v: number): number { return v > 0 ? (v < 1 ? v : 1) : 0; }
function clampX(x: number): number { return x < -LIM_X ? -LIM_X : x > LIM_X ? LIM_X : x; }
function clampZ(z: number): number { return z < -LIM_Z ? -LIM_Z : z > LIM_Z ? LIM_Z : z; }
/** Attribute 1..99 -> 0..1. */
function attr01(v: number): number { return clamp01((fin(v) - 1) / 98); }

/** True for the kinds startLob accepts (lob and cross kinds, plus GOAL_KICK which the registry maps to solveLob). */
export function isLobKind(k: KickKind): boolean {
  return (k >= KickKind.LOB_PASS && k <= KickKind.LOW_CROSS) || k === KickKind.GOAL_KICK;
}

/** True for CROSS, GROUND_CROSS, LOW_CROSS. */
export function isCrossKind(k: KickKind): boolean {
  return k === KickKind.CROSS || k === KickKind.GROUND_CROSS || k === KickKind.LOW_CROSS;
}

/** True for the lofted pass kinds solveLob plays (LOB_PASS, HIGH_LOB, DRIVEN_LOB, GOAL_KICK). */
function isLoftKind(k: KickKind): boolean {
  return k === KickKind.LOB_PASS || k === KickKind.HIGH_LOB || k === KickKind.DRIVEN_LOB || k === KickKind.GOAL_KICK;
}

/** Active teammate of slot (not slot himself). */
function isTeammate(s: SimState, slot: number, j: number): boolean {
  if (!validSlot(j) || j === slot) return false;
  const q = s.players[j]!;
  return q.active === 1 && q.team === s.players[slot]!.team;
}

/** May `slot` play the ball in the current phase? IN_PLAY; a restart phase as its taker or once taken; the shoot-out kicker. */
export function kickLiveFor(s: SimState, slot: number): boolean {
  const m = s.match;
  const ph = m.phase;
  if (ph === MatchPhase.IN_PLAY) return true;
  if (ph >= 0 && ph < RESTART_PHASE.length && RESTART_PHASE[ph] === 1) return m.restart.taken === 1 || m.restart.taker === slot;
  if (ph === MatchPhase.SHOOT_OUT) return m.shootout.kicker === slot;
  return false;
}

/**
 * A loose, low ball whose path relative to the (moving) player enters a circle of radius `lane` around him within
 * `ticks` ticks (straight-line relative motion; the same test SIM-08 startPass uses).
 */
function ballArriving(s: SimState, slot: number, ticks: number, lane: number): boolean {
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return false;
  if (!(b.y <= PASS_TUNING.startArriveHeight)) return false;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
  const rv2 = rvx * rvx + rvz * rvz;
  if (!(rv2 > 1e-9)) return false;
  const t = -(dx * rvx + dz * rvz) / rv2;
  if (!(t >= 0)) return false;
  const mx = dx + rvx * t, mz = dz + rvz * t;
  const miss2 = mx * mx + mz * mz;
  const l2 = lane * lane;
  if (!(miss2 <= l2)) return false;
  const tin = t - Math.sqrt((l2 - miss2) / rv2);
  return tin * HZ <= ticks;
}

// ---------------------------------------------------------------- starter

/**
 * Shared KICK-action starter of SIM-09 / SIM-10 kinds (validation and action fields as SIM-08 startPass; see the
 * header). Does not check the kind. Returns 1 if started.
 */
export function beginFootKick(s: SimState, slot: number, kind: KickKind, req: ActionRequest): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  if (!isFree(p) || !kickLiveFor(s, slot)) return 0;
  const b = s.ball;
  if (b.heldBy >= 0) return 0;
  if (b.owner >= 0 && b.owner !== slot) return 0;
  if (b.owner !== slot && !ballInReach(s, slot) &&
      !ballArriving(s, slot, T_PASS.windup + PASS_TUNING.startArriveTicks, PASS_TUNING.startArriveLane)) return 0;
  beginAction(p, ActionKind.KICK, T_PASS.windup + DEFAULT_REC, T_PASS.windup);
  p.actKick = kind;
  p.actSkill = SkillMove.NONE;
  p.actPower = clamp01(fin(req.power));
  p.actCharging = req.charging === 1 ? 1 : 0;
  let dx = fin(req.dirX), dz = fin(req.dirZ);
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = 0; dz = 0; }
  p.actDirX = dx;
  p.actDirZ = dz;
  p.actSlot = isTeammate(s, slot, req.targetSlot) ? req.targetSlot : -1;
  const ht = req.hasTarget === 1 ? 1 : 0;
  p.actX = ht === 1 ? clampX(fin(req.targetX)) : 0;
  p.actZ = ht === 1 ? clampZ(fin(req.targetZ)) : 0;
  const c = fin(req.curve);
  p.actCurve = c < -1 ? -1 : c > 1 ? 1 : c;
  p.actA = fin(req.flags) & 0xff;
  const a = req.assist;
  p.actB = (a === AssistLevel.SEMI || a === AssistLevel.MANUAL ? a : AssistLevel.ASSISTED) + ht * 4;
  return 1;
}

/**
 * The kind `slot` actually plays for a requested lob kind: inside the crossing zone (his position, his attack
 * direction) LOB_PASS becomes CROSS and DRIVEN_LOB becomes LOW_CROSS; everything else is unchanged. Pure.
 */
export function lobKindAt(s: SimState, slot: number, kind: KickKind): KickKind {
  if (!validSlot(slot) || (kind !== KickKind.LOB_PASS && kind !== KickKind.DRIVEN_LOB)) return kind;
  const p = s.players[slot]!;
  if (!inCrossingZone(p.x, p.z, s.teams[p.team]!.dir)) return kind;
  return kind === KickKind.LOB_PASS ? KickKind.CROSS : KickKind.LOW_CROSS;
}

/** Start a lob or cross (kind decided by caller; in the crossing zone LOB_PASS upgrades to CROSS). */
export function startLob(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot) || !isLobKind(kind)) return 0;
  return beginFootKick(s, slot, lobKindAt(s, slot, kind), req);
}

// ---------------------------------------------------------------- cross targets

/** Corner-tactic zone of Command cmd into (F_VX = depth, F_VZ = side); false for none. */
function cornerZone(cmd: number): boolean {
  switch (cmd) {
    case Command.CORNER_FAR_POST: F[F_VX] = LT.cornerFarDepth; F[F_VZ] = LT.cornerFarSide; return true;
    case Command.CORNER_EDGE_OF_BOX: F[F_VX] = LT.cornerEdgeDepth; F[F_VZ] = LT.cornerEdgeSide; return true;
    case Command.CORNER_CROWD_KEEPER: F[F_VX] = LT.cornerKeeperDepth; F[F_VZ] = LT.cornerKeeperSide; return true;
    case Command.CORNER_NEAR_POST: F[F_VX] = LT.cornerNearDepth; F[F_VZ] = LT.cornerNearSide; return true;
    default: return false;
  }
}

/**
 * Cross aim of slot into F_TX / F_TZ: zone from power (ground = near post / penalty spot only), stick nudge
 * (dirX, dirZ; 0,0 = none), corner-tactic pull, kept on the pitch and crossMinDepth off the goal line.
 */
function crossAim(s: SimState, slot: number, ground: boolean, power: number, dirX: number, dirZ: number): void {
  const p = s.players[slot]!;
  const t = s.teams[p.team]!;
  const dir = t.dir >= 0 ? 1 : -1;
  const side = p.z >= 0 ? 1 : -1;
  const pw = clamp01(fin(power));
  let depth: number, lat: number;
  if (ground ? pw < LT.groundPowerSplit : pw < LT.powerNear) { depth = LT.nearPostDepth; lat = LT.nearPostSide; }
  else if (ground || pw < LT.powerFar) { depth = LT.spotDepth; lat = LT.spotSide; }
  else { depth = LT.farPostDepth; lat = LT.farPostSide; }
  let sx = fin(dirX), sz = fin(dirZ);
  const sl = Math.sqrt(sx * sx + sz * sz);
  if (sl > 1e-6) {
    sx /= sl; sz /= sl;
    // Lateral component toward the far side (+) shifts the aim across; pointing away from goal pulls it back.
    lat -= sz * (0 - side) * LT.stickSideShift;
    const fwd = sx * dir;
    if (fwd < 0) depth -= fwd * LT.stickBackShift;
  }
  if (cornerZone(t.cornerTactic)) {
    const w = LT.cornerTacticWeight;
    depth += (F[F_VX]! - depth) * w;
    lat += (F[F_VZ]! - lat) * w;
  }
  if (depth < LT.crossMinDepth) depth = LT.crossMinDepth;
  F[F_TX] = clampX(dir * (HALF_LENGTH - depth));
  F[F_TZ] = clampZ(side * lat);
}

/** Cross aim point (near post / far post / penalty spot) from power 0..1 and stick, for the team attacking dir. */
export function crossTarget(s: SimState, slot: number, power: number, dirX: number, dirZ: number, out: { x: number; z: number }): void {
  out.x = 0; out.z = 0;
  if (!validSlot(slot)) return;
  crossAim(s, slot, false, power, dirX, dirZ);
  out.x = F[F_TX]!;
  out.z = F[F_TZ]!;
}

/** Ground-cross variant of crossTarget (near post at low power, penalty spot at high power). */
export function groundCrossTarget(s: SimState, slot: number, power: number, dirX: number, dirZ: number, out: { x: number; z: number }): void {
  out.x = 0; out.z = 0;
  if (!validSlot(slot)) return;
  crossAim(s, slot, true, power, dirX, dirZ);
  out.x = F[F_TX]!;
  out.z = F[F_TZ]!;
}

/**
 * Best attacker for a ball arriving at (x, z) in about `t` s: the teammate of slot (keeper excluded) whose position
 * (at most LT.receiverLookSec ahead along his run) is closest, within LT.spaceReceiverRadius. -1 if none. Pure.
 */
export function attackerNear(s: SimState, slot: number, x: number, z: number, t: number): number {
  if (!validSlot(slot)) return -1;
  const p = s.players[slot]!;
  const first = p.team === 0 ? 0 : PPT;
  let look = fin(t);
  if (look < 0) look = 0;
  if (look > LT.receiverLookSec) look = LT.receiverLookSec;
  const r2 = LT.spaceReceiverRadius * LT.spaceReceiverRadius;
  let best = -1;
  let bestD = r2;
  for (let i = first; i < first + PPT; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const dx = clampX(q.x + fin(q.vx) * look) - x;
    const dz = clampZ(q.z + fin(q.vz) * look) - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD || (d2 === bestD && best < 0)) { bestD = d2; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- launch helpers

/** Aerial launch from the ball to (F_TX, F_TZ) at `angle` with curl / backspin into F_V* / F_S*; F_T = flight time. */
function aerialTo(s: SimState, angle: number, curl: number, back: number, vmax: number): void {
  const b = s.ball;
  solveLaunchSpin(F[F_TX]! - b.x, F[F_TZ]! - b.z, angle, b.y, curl, back, SOL);
  let k = 1;
  if (SOL.speed > vmax && SOL.speed > 0) k = vmax / SOL.speed;
  F[F_VX] = SOL.vx * k; F[F_VY] = SOL.vy * k; F[F_VZ] = SOL.vz * k;
  F[F_SX] = SOL.sx; F[F_SY] = SOL.sy; F[F_SZ] = SOL.sz;
  F[F_T] = SOL.flightT;
}

/**
 * Lead receiver r for an aerial ball: F_TX / F_TZ = his position after the flight time (fixed-point iterations on
 * solveLaunchSpin's flight time), launch left in F_V* / F_S*. Semi blends toward the power-implied distance.
 */
function leadAerial(s: SimState, r: number, angle: number, curl: number, back: number, vmax: number): void {
  const q = s.players[r]!;
  const qx = q.x, qz = q.z, vx = fin(q.vx), vz = fin(q.vz);
  const moving = vx * vx + vz * vz > LT.lobLeadMinSpeed * LT.lobLeadMinSpeed;
  let T = 0;
  for (let it = 0; it < LT.lobLeadIters; it++) {
    F[F_TX] = clampX(qx + vx * T);
    F[F_TZ] = clampZ(qz + vz * T);
    aerialTo(s, angle, curl, back, vmax);
    if (!moving) break;
    let tn = F[F_T]!;
    if (!(tn > 0)) tn = 0;
    if (tn > LT.lobLeadMaxSec) tn = LT.lobLeadMaxSec;
    const d = tn - T;
    T = tn;
    if (d < LT.lobLeadTol && d > -LT.lobLeadTol) break;
  }
}

/** Distance from the ball to (F_TX, F_TZ) into F_D; the unit direction into F_UX / F_UZ when it is long enough. */
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

/** Ground launch to (F_TX, F_TZ) arriving with `arrive` m/s (speed range groundMin .. groundMax x drivenMul). */
function groundTo(s: SimState, arrive: number): void {
  aimDist(s);
  const D = F[F_D]!;
  let v = groundPassSpeed(D, arrive);
  const vmax = T_PASS.groundMax * T_PASS.drivenMul;
  if (v < T_PASS.groundMin) v = T_PASS.groundMin;
  if (v > vmax) v = vmax;
  let t = groundRollTime(v, D);
  if (!(t >= 0) || t > LT.groundLeadMaxSec) t = LT.groundLeadMaxSec;
  F[F_T] = t;
  F[F_VX] = F[F_UX]! * v; F[F_VY] = 0; F[F_VZ] = F[F_UZ]! * v;
  F[F_SX] = 0; F[F_SY] = 0; F[F_SZ] = 0;
}

/** Request direction of slot's action (facing, then the attack direction, when unset) into F_UX / F_UZ. */
function requestDir(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  let ux = fin(p.actDirX), uz = fin(p.actDirZ);
  let ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) { ux = fin(p.fx); uz = fin(p.fz); ul = Math.sqrt(ux * ux + uz * uz); }
  if (!(ul > 1e-6)) { ux = s.teams[p.team]!.dir; uz = 0; ul = 1; }
  F[F_UX] = ux / ul;
  F[F_UZ] = uz / ul;
}

/**
 * Apply the kick error to the launch in F_V* / F_S* (rotation by kickErrorAim, speed scale by a second draw) and write
 * velocity and spin into out. Always draws twice (eight rng draws).
 */
function applyError(s: SimState, slot: number, power: number, accuracy: number, vmax: number, out: KickLaunch): void {
  const vx0 = F[F_VX]!, vz0 = F[F_VZ]!;
  const err = kickErrorAim(s, slot, power, accuracy, vx0, vz0);
  const lenErr = kickErrorAim(s, slot, power, accuracy, vx0, vz0);
  let k = 1 + LT.lengthErrorMul * lenErr;
  if (k < 1 - LT.lengthErrorCap) k = 1 - LT.lengthErrorCap;
  if (k > 1 + LT.lengthErrorCap) k = 1 + LT.lengthErrorCap;
  // The kind's max launch speed holds after the error too.
  const vy0 = F[F_VY]!;
  const sp = Math.sqrt(vx0 * vx0 + vy0 * vy0 + vz0 * vz0) * k;
  if (sp > vmax && sp > 0) k *= vmax / sp;
  const ce = dcos(err), se = dsin(err);
  out.vx = (vx0 * ce - vz0 * se) * k;
  out.vz = (vx0 * se + vz0 * ce) * k;
  out.vy = vy0 * k;
  const sx0 = F[F_SX]!, sz0 = F[F_SZ]!;
  out.sx = sx0 * ce - sz0 * se;
  out.sy = F[F_SY]!;
  out.sz = sx0 * se + sz0 * ce;
}

function resetOut(out: KickLaunch, kind: KickKind): void {
  out.vx = 0; out.vy = 0; out.vz = 0; out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = kind; out.target = -1; out.tx = 0; out.tz = 0; out.onTarget = 0;
}

// ---------------------------------------------------------------- lob solver

function solveLobImpl(s: SimState, slot: number, out: KickLaunch): number {
  resetOut(out, KickKind.LOB_PASS);
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  const kind = isLoftKind(p.actKick) ? p.actKick : KickKind.LOB_PASS;
  const meta = fin(p.actB) | 0;
  let assist = meta & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  const hasTarget = (meta >> 2) & 1;
  let power = clamp01(fin(p.actPower));
  if (power < LT.minPower) power = LT.minPower;
  const angle = kind === KickKind.HIGH_LOB ? T_PASS.highLobAngle : kind === KickKind.DRIVEN_LOB ? T_PASS.drivenLobAngle : T_PASS.lobAngle;
  const back = kind === KickKind.HIGH_LOB ? LT.highLobBackspin : kind === KickKind.DRIVEN_LOB ? LT.drivenLobBackspin : LT.lobBackspin;
  const curl = curlSpinY(fin(p.actCurve) * LT.lobCurlSpin);
  requestDir(s, slot);
  const ux = F[F_UX]!, uz = F[F_UZ]!;
  const dPow = LT.lobDistMin + (LT.lobDistMax - LT.lobDistMin) * power;
  let r = -1;
  if (isTeammate(s, slot, p.actSlot)) r = p.actSlot;
  else if (hasTarget === 0 && assist !== AssistLevel.MANUAL) r = selectReceiver(s, slot, ux, uz, power, assist, 1);
  let aimed = false;
  if (hasTarget === 1) {
    F[F_TX] = clampX(p.actX);
    F[F_TZ] = clampZ(p.actZ);
    aimed = aimDist(s);
    if (aimed) aerialTo(s, angle, curl, back, LT.loftSpeedMax);
  } else if (r >= 0 && assist !== AssistLevel.MANUAL) {
    leadAerial(s, r, angle, curl, back, LT.loftSpeedMax);
    aimed = aimDist(s);
    if (aimed && assist === AssistLevel.SEMI) {
      const d = F[F_D]! + (dPow - F[F_D]!) * LT.semiPowerBlend;
      F[F_TX] = clampX(b.x + F[F_UX]! * d);
      F[F_TZ] = clampZ(b.z + F[F_UZ]! * d);
      aimed = aimDist(s);
      if (aimed) aerialTo(s, angle, curl, back, LT.loftSpeedMax);
    }
  }
  if (!aimed) {
    // Into space along the request direction over the power-implied distance (Manual, or no receiver).
    F[F_TX] = clampX(b.x + ux * dPow);
    F[F_TZ] = clampZ(b.z + uz * dPow);
    if (!aimDist(s)) { F[F_TX] = b.x + ux * dPow; F[F_TZ] = b.z + uz * dPow; }
    aerialTo(s, angle, curl, back, LT.loftSpeedMax);
  }
  if (r < 0) r = attackerNear(s, slot, F[F_TX]!, F[F_TZ]!, F[F_T]!);
  applyError(s, slot, power, attr01(s.attrs[slot]!.longPassing), LT.loftSpeedMax, out);
  out.kind = kind;
  out.target = r;
  out.tx = F[F_TX]!;
  out.tz = F[F_TZ]!;
  return 1;
}

// ---------------------------------------------------------------- cross solver

/**
 * Curl spin (sy) of an aerial cross toward (F_TX, F_TZ): an explicit request curve sets the side, else the whip bends
 * away from the keeper (toward the side of the aim point away from the attacked goal centre).
 */
function crossCurl(s: SimState, slot: number, kind: KickKind, floated: boolean): number {
  const p = s.players[slot]!;
  const b = s.ball;
  let mag = LT.crossCurlMin + (LT.crossCurlMax - LT.crossCurlMin) * attr01(s.attrs[slot]!.crossing);
  if (kind === KickKind.LOW_CROSS) mag *= LT.lowCrossCurlMul;
  else if (floated) mag *= LT.floatCrossCurlMul;
  const c = fin(p.actCurve);
  if (c > LT.curveDeadZone || c < -LT.curveDeadZone) return curlSpinY(c * mag);
  const dir = s.teams[p.team]!.dir >= 0 ? 1 : -1;
  let tx = F[F_TX]! - b.x, tz = F[F_TZ]! - b.z;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (!(tl > 1e-6)) return 0;
  tx /= tl; tz /= tl;
  // Away from the keeper: from the goal centre toward the aim point (straight out of the goal when on the line).
  let ax = F[F_TX]! - dir * HALF_LENGTH, az = F[F_TZ]!;
  if (!(ax * ax + az * az > 1e-6)) { ax = 0 - dir; az = 0; }
  // Right of travel is (-tz, tx).
  const rightDot = ax * (0 - tz) + az * tx;
  return curlSpinY(rightDot >= 0 ? mag : 0 - mag);
}

function solveCrossImpl(s: SimState, slot: number, out: KickLaunch): number {
  resetOut(out, KickKind.CROSS);
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  const kind = isCrossKind(p.actKick) ? p.actKick : KickKind.CROSS;
  const ground = kind === KickKind.GROUND_CROSS;
  const floated = kind === KickKind.CROSS && (fin(p.actA) & ReqFlag.LOFTED) !== 0;
  const meta = fin(p.actB) | 0;
  let assist = meta & 3;
  if (assist > AssistLevel.MANUAL) assist = AssistLevel.ASSISTED;
  const hasTarget = (meta >> 2) & 1;
  let power = clamp01(fin(p.actPower));
  if (power < LT.minPower) power = LT.minPower;
  const angle = kind === KickKind.LOW_CROSS ? LT.lowCrossAngle : floated ? LT.floatCrossAngle : LT.crossAngle;
  const arrive = LT.groundCrossArriveMin + (LT.groundCrossArriveMax - LT.groundCrossArriveMin) * power;
  let r = isTeammate(s, slot, p.actSlot) ? p.actSlot : -1;
  // Lead an explicit receiver (no explicit point, assisted) unless he stands on the ball.
  let lead = false;
  if (r >= 0 && hasTarget === 0 && assist !== AssistLevel.MANUAL) {
    const q = s.players[r]!;
    F[F_TX] = clampX(q.x);
    F[F_TZ] = clampZ(q.z);
    lead = aimDist(s);
  }
  // Aim point (a led receiver's is set above).
  if (!lead) {
    if (hasTarget === 1) {
      F[F_TX] = clampX(p.actX);
      F[F_TZ] = clampZ(p.actZ);
    } else if (assist === AssistLevel.MANUAL) {
      requestDir(s, slot);
      const d = LT.crossDistMin + (LT.crossDistMax - LT.crossDistMin) * power;
      F[F_TX] = clampX(b.x + F[F_UX]! * d);
      F[F_TZ] = clampZ(b.z + F[F_UZ]! * d);
    } else {
      crossAim(s, slot, ground, power, p.actDirX, p.actDirZ);
      if (aimDist(s) && F[F_D]! > LT.crossMaxDist) {
        // Far from the box (e.g. LOB, LOB in midfield): play it to a teammate like a pass when there is one.
        requestDir(s, slot);
        const rr = selectReceiver(s, slot, F[F_UX]!, F[F_UZ]!, power, assist, ground ? 0 : 1);
        if (rr >= 0) {
          const q = s.players[rr]!;
          const zx = F[F_TX]!, zz = F[F_TZ]!;
          F[F_TX] = clampX(q.x);
          F[F_TZ] = clampZ(q.z);
          lead = aimDist(s);
          if (lead) r = rr;
          else { F[F_TX] = zx; F[F_TZ] = zz; }
        }
      }
    }
    if (!lead && !aimDist(s)) {
      // On top of the ball: fall back to the zone aim, then to the request direction.
      crossAim(s, slot, ground, power, 0, 0);
      if (!aimDist(s)) { requestDir(s, slot); F[F_TX] = b.x + F[F_UX]! * LT.crossDistMin; F[F_TZ] = b.z + F[F_UZ]! * LT.crossDistMin; }
    }
  }
  if (ground) {
    if (lead) {
      // Lead the explicit receiver: his position after the roll time (a few fixed-point steps).
      const q = s.players[r]!;
      let T = 0;
      for (let it = 0; it < LT.lobLeadIters; it++) {
        F[F_TX] = clampX(q.x + fin(q.vx) * T);
        F[F_TZ] = clampZ(q.z + fin(q.vz) * T);
        groundTo(s, arrive);
        const d = F[F_T]! - T;
        T = F[F_T]!;
        if (d < LT.lobLeadTol && d > -LT.lobLeadTol) break;
      }
    } else {
      groundTo(s, arrive);
    }
  } else {
    if (lead) {
      // Curl side from his current position, then lead with that curl.
      const curl0 = crossCurl(s, slot, kind, floated);
      leadAerial(s, r, angle, curl0, 0, LT.crossSpeedMax);
    } else {
      aerialTo(s, angle, crossCurl(s, slot, kind, floated), 0, LT.crossSpeedMax);
    }
  }
  if (r < 0) r = attackerNear(s, slot, F[F_TX]!, F[F_TZ]!, F[F_T]!);
  // The power bar picks the cross's zone (the launch speed is solved), so it is no "extreme power" strike: the error
  // sees at most SIM-08's power knee.
  const knee = PASS_TUNING.powerKnee;
  const errPower = power < knee ? power : knee;
  applyError(s, slot, errPower, attr01(s.attrs[slot]!.crossing), ground ? T_PASS.groundMax * T_PASS.drivenMul : LT.crossSpeedMax, out);
  out.kind = kind;
  out.target = r;
  out.tx = F[F_TX]!;
  out.tz = F[F_TZ]!;
  return 1;
}

bindLobImpl({ solveLob: solveLobImpl, solveCross: solveCrossImpl });

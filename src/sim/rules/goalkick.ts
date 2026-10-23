/**
 * [RUL-03] Goal kicks - ball in the goal area, keeper (or nominated) taker, opponents outside the penalty area until the ball is played; short or long.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 *
 * Implementation notes (RUL-03):
 *  - Setup (called by RUL-11 awardRestart after it filled s.match.restart): the ball goes on the goal-area line of the
 *    kicking team's own end, on the side the ball went out (sign of the award z, else of ball.crossZ), |z| clamped to
 *    T_GOAL_KICK.spotZMin..spotZMax; restart.side = that side; aim reset onto the ball; taker = the keeper, else the
 *    nearest defender, else the nearest outfield player (players who are down are avoided when possible). RUL-11 then
 *    adopts the ball position as the spot, places everybody legally at ready (opponents outside the kicking team's
 *    penalty area and >= 9.15 m from the ball) and keeps pushing intruders out every tick until the ball is played.
 *  - Input (SETPIECE_INPUT[GOAL_KICK], SIM-15 routes every controller's frame here during GOAL_KICK): the controller
 *    holding the taker, once restart.ready: left stick aims (restart.aimX/aimZ; never backward over the own goal line,
 *    sideways is fine); PASS = short ground pass (SIM-08 startPass GROUND_PASS; R1 + PASS = DRIVEN_PASS); LOB = long kick
 *    (SIM-09 startLob LOB_PASS; L1 + LOB = HIGH_LOB; L1 + R1 + LOB = DRIVEN_LOB). Power: hold the button (charging,
 *    the resolver fills the bar) or the frame's explicit power. Without a stick aim (Assisted / Semi) PASS targets the
 *    best short option and LOB the target man; with an aim (or Manual) the direction goes to the starter, which picks
 *    the receiver from direction + power. Gestures: TAP a teammate = ground pass to him (lob beyond tapGroundMax),
 *    DOUBLE_TAP = the lobbed version; a tap on a pitch spot kicks to that spot. Every kick carries ReqFlag.SET_PIECE.
 *    Kicks whose line runs into the kicking team's own goal mouth are refused. Any other controller (defending side,
 *    or a second human on the taking side) moves his free controlled player with the stick (RUL-11 keeps him legal).
 *  - Tick: the waiting taker lines up behind the ball along the aim (slides lineUpStep per tick, inside RUL-11's
 *    reach); restart.aimPower mirrors the power bar while he charges; a side with no human takes the kick by Default
 *    T_GOAL_KICK.cpuGraceTicks after T_RULES.cpuRestartDelay (retried every cpuRetryTicks) if its CPU brain (TAI-13)
 *    has not, so RUL-11's 4 s CPU watchdog never has to fire.
 *  - Default (RUL-11 calls it at the human timeout; also the CPU fallback): short ground pass to an open defender
 *    (receiver >= openDist from every opponent and a safe lane: TAI-09 laneSafety >= laneSafeMin while it gives any
 *    signal, otherwise no opponent within laneClear of the lane), else a long LOB_PASS to the target man (forwards
 *    first, best in the air), else a short pass to the best available teammate, else a long kick straight ahead. The
 *    AI's own targets are forward or sideways (back only away from the goal on the ball's side, never across the
 *    goal mouth).
 *    A taker already kicking is left alone (no double kick). chooseGoalKick exposes the decision (TAI-13 may reuse it).
 *  - No offside from goal kicks: the kick's contact happens while the phase is still GOAL_KICK (applyKick marks the
 *    restart taken; RUL-01 returns to IN_PLAY after the rules of that tick), which RUL-08 checks at kick time.
 * Per-tick work is O(1) (Default/choice: O(11 x 11), once per kick); allocation-free (module scratch only).
 */
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind, Role } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, UNIT_SCALE, type InputFrame } from '../../contracts/input';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { createActionRequest, ReqFlag } from '../../contracts/systems';
import { T_INPUT, T_PASS, T_RULES, T_GOAL_KICK, T_RESTART_COMMON, T_RESTART } from '../../contracts/tuning';
import { laneSafety } from '../../ai/cpu/passing';
import { groundPassSpeed } from '../ball/flight';
import { releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import { startLob } from '../kicks/lob';
import { startPass } from '../kicks/pass';
import { restartLookPoint } from './restartCommon';
import { isValidTaker, prepareTakerKick } from './restart';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_GOAL_KICK. */
export const LOCAL_TUNING = T_GOAL_KICK;


// ---------------------------------------------------------------- module scratch (no allocation per tick)

const REQ = createActionRequest();
const LOOK = { x: 0, z: 0 };
const AIM = { x: 0, z: 0 };
/** Lane evaluation output: clearance of the lane and openness of the receiver (nearest opponent), m. */
const LANE = { lane: 0, open: 0 };

/** A goal-kick decision (chooseGoalKick). */
export interface GoalKickChoice {
  /** GROUND_PASS (short) or LOB_PASS (long); NONE when nothing could be chosen. */
  kind: KickKind;
  /** Intended receiver slot, -1 = a point. */
  target: number;
  /** Target point (the receiver's position or the point kicked to). */
  x: number;
  z: number;
  /** Kick power 0..1. */
  power: number;
}

export function createGoalKickChoice(): GoalKickChoice {
  return { kind: KickKind.NONE, target: -1, x: 0, z: 0, power: 0 };
}

const CHOICE = createGoalKickChoice();

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isDown(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.STUMBLE || p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP || p.stunT > 0;
}

function isDefenderRole(role: Role): boolean {
  return role === Role.RB || role === Role.CB || role === Role.LB || role === Role.RWB || role === Role.LWB;
}

/** Target-man tier of a role: forwards 3, attacking midfielders / wingers 2, other midfielders 1, the rest 0. */
function targetTier(role: Role): number {
  switch (role) {
    case Role.ST: case Role.CF: return 3;
    case Role.CAM: case Role.LW: case Role.RW: return 2;
    case Role.CM: case Role.CDM: case Role.LM: case Role.RM: return 1;
    default: return 0;
  }
}

function isLobKind(kind: KickKind): boolean {
  return kind === KickKind.LOB_PASS || kind === KickKind.HIGH_LOB || kind === KickKind.DRIVEN_LOB;
}

function insidePitch(x: number, z: number, margin: number): boolean {
  return x >= -HALF_LENGTH + margin && x <= HALF_LENGTH - margin && z >= -HALF_WIDTH + margin && z <= HALF_WIDTH - margin;
}

/** True while this restart is an untaken goal kick in the GOAL_KICK phase. */
function goalKickLive(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.GOAL_KICK && m.restart.kind === RestartKind.GOAL_KICK && m.restart.taken === 0;
}

/**
 * True if a kick from (x0, z0) along (dx, dz) does not run into the own goal mouth of `team` (the line continued to
 * the own goal line passes outside the posts by more than ownGoalMargin). Sideways and forward kicks are always clear.
 */
export function clearOfOwnGoal(s: SimState, team: number, x0: number, z0: number, dx: number, dz: number): boolean {
  const e = -s.teams[team === 1 ? 1 : 0]!.dir; // own end
  if (e * dx <= 1e-9) return true;
  const t = (e * HALF_LENGTH - x0) / dx;
  const zHit = z0 + dz * t;
  const lim = GOAL_HALF_WIDTH + T_GOAL_KICK.ownGoalMargin;
  return zHit > lim || zHit < -lim;
}

/**
 * Stricter rule for the kicks the AI picks itself (Default, assisted targets): forward or sideways, or back toward the
 * own goal line only on the ball's side moving away from the goal (never back across the goal mouth), and clear of it.
 */
function aiLaneOk(s: SimState, team: number, x0: number, z0: number, dx: number, dz: number): boolean {
  if (s.teams[team === 1 ? 1 : 0]!.dir * dx >= 0) return true;
  if ((z0 < 0 ? -dz : dz) <= 0) return false;
  return clearOfOwnGoal(s, team, x0, z0, dx, dz);
}

/** Ball at rest on the ground at (x, z); possession and hands released (not a contact). */
function placeBall(s: SimState, x: number, z: number, ev: EventSink): void {
  const b = s.ball;
  if (b.owner >= 0) releasePossession(s, ev);
  b.owner = -1;
  b.ownerT = 0;
  b.heldBy = -1;
  b.x = x; b.y = BALL_RADIUS; b.z = z;
  b.px = x; b.py = BALL_RADIUS; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1;
  b.bounces = 0;
  b.inNet = 0;
}

/**
 * Lane from (x0, z0) to (x1, z1) for a pass by `team`: LANE.lane = closest approach of any active opponent to the
 * segment, LANE.open = nearest active opponent to the end point (m; 1e9 when there are no opponents).
 */
function evalLane(s: SimState, team: number, x0: number, z0: number, x1: number, z1: number): void {
  const opp = team === 0 ? 1 : 0;
  const first = teamFirstSlot(opp);
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz;
  let lane2 = 1e18;
  let open2 = 1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const ox = q.x - x1, oz = q.z - z1;
    const o2 = ox * ox + oz * oz;
    if (o2 < open2) open2 = o2;
    let t = l2 > 1e-9 ? ((q.x - x0) * dx + (q.z - z0) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + dx * t - q.x, cz = z0 + dz * t - q.z;
    const c2 = cx * cx + cz * cz;
    if (c2 < lane2) lane2 = c2;
  }
  LANE.lane = lane2 >= 1e18 ? 1e9 : Math.sqrt(lane2);
  LANE.open = open2 >= 1e18 ? 1e9 : Math.sqrt(open2);
}

/** Power 0..1 of a ground pass over `d` metres (the speed it needs, mapped onto the T_PASS ground speed range). */
export function shortPower(d: number): number {
  const v = clamp(groundPassSpeed(d, T_GOAL_KICK.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
  const p = (v - T_PASS.groundMin) / (T_PASS.groundMax - T_PASS.groundMin);
  return clamp(p, T_GOAL_KICK.shortPowerMin, 1);
}

/** Power 0..1 of a long kick over `d` metres. */
export function longPower(d: number): number {
  return clamp(d / T_GOAL_KICK.longPowerRange, T_GOAL_KICK.longPowerMin, 1);
}

// ---------------------------------------------------------------- taker, spot

/**
 * Goal-kick taker for `team`: the keeper; else the nearest defender (RB/CB/LB/RWB/LWB) to (x, z); else the nearest
 * outfield player. Players who are down (stumbling, fallen, getting up, stunned) are avoided when possible. -1 if
 * the team has nobody active.
 */
export function pickGoalKickTaker(s: SimState, team: number, x: number, z: number): number {
  const tm = team === 1 ? 1 : 0;
  const first = teamFirstSlot(tm);
  const k = s.teams[tm]!.keeperSlot;
  const keeperOk = k >= first && k < first + PLAYERS_PER_TEAM && s.players[k]!.active === 1 && s.players[k]!.isKeeper === 1;
  for (let pass = 0; pass < 2; pass++) {
    if (keeperOk && (pass === 1 || !isDown(s.players[k]!))) return k;
    for (let group = 0; group < 2; group++) { // 0: defenders, 1: any outfield player
      let best = -1;
      let bestD = 1e18;
      for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
        const p = s.players[slot]!;
        if (p.active !== 1 || p.isKeeper === 1) continue;
        if (group === 0 && !isDefenderRole(p.role)) continue;
        if (pass === 0 && isDown(p)) continue;
        const dx = p.x - x, dz = p.z - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = slot; }
      }
      if (best >= 0) return best;
    }
  }
  // Only keepers left (flagged differently from keeperSlot): any active player of the team.
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) if (s.players[slot]!.active === 1) return slot;
  return -1;
}

/**
 * Goal-kick spot for `team` with the ball gone out on side `side` (-1/+1), the award's |z| hint `absZ`: on the
 * goal-area line of the team's own end, |z| clamped to spotZMin..spotZMax. Written to `out`.
 */
export function goalKickSpot(s: SimState, team: number, side: number, absZ: number, out: { x: number; z: number }): void {
  const e = -s.teams[team === 1 ? 1 : 0]!.dir;
  const az = absZ === absZ ? (absZ < 0 ? -absZ : absZ) : 0;
  out.x = e * (HALF_LENGTH - GOAL_AREA_DEPTH);
  out.z = (side < 0 ? -1 : 1) * clamp(az, T_GOAL_KICK.spotZMin, T_GOAL_KICK.spotZMax);
}

// ---------------------------------------------------------------- choice (Default / assisted targets)

/**
 * Best short option for the current goal kick of `team` (taker excluded, keepers excluded): teammates inside the pitch
 * shortMin..shortMax from the spot, forward / sideways or back only away from the goal on the ball's side. strict = 1: defenders only, and only
 * when open (receiver >= openDist from every opponent, lane safe: TAI-09 laneSafety >= laneSafeMin if laneSafety
 * returns any signal for these lanes, else no opponent within laneClear of the lane). strict = 0: the best
 * teammate whatever the pressure. -1 if none.
 */
export function bestShortOption(s: SimState, team: number, taker: number, strict: number): number {
  const r = s.match.restart;
  const x0 = r.x, z0 = r.z;
  const tm = team === 1 ? 1 : 0;
  const first = teamFirstSlot(tm);
  const T = T_GOAL_KICK;
  let bestGeo = -1, bestGeoScore = -1e18;
  let bestLs = -1, bestLsScore = -1e18;
  let anyLs = 0;
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (slot === taker) continue;
    const q = s.players[slot]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    if (!insidePitch(q.x, q.z, T.targetPitchMargin)) continue;
    const dx = q.x - x0, dz = q.z - z0;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < T.shortMin || d > T.shortMax) continue;
    if (!aiLaneOk(s, tm, x0, z0, dx, dz)) continue;
    const def = isDefenderRole(q.role);
    if (strict === 1 && !def) continue;
    evalLane(s, tm, x0, z0, q.x, q.z);
    const open = LANE.open, lane = LANE.lane;
    const v = clamp(groundPassSpeed(d, T.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
    let ls = laneSafety(s, tm, x0, z0, q.x, q.z, v, 0);
    if (!(ls > 0)) ls = 0; // NaN / stub
    if (ls > 1) ls = 1;
    if (ls > 0) anyLs = 1;
    if (strict === 1 && open < T.openDist) continue;
    const base = (open < T.openCap ? open : T.openCap) + (def ? T.defenderBonus : 0) - T.distWeight * d;
    if (strict === 0 || lane >= T.laneClear) {
      const sc = base + T.laneWeight * (lane < T.laneCap ? lane : T.laneCap);
      if (sc > bestGeoScore) { bestGeoScore = sc; bestGeo = slot; }
    }
    if (strict === 0 || ls >= T.laneSafeMin) {
      const sc = base + T.laneWeight * T.laneCap * ls;
      if (sc > bestLsScore) { bestLsScore = sc; bestLs = slot; }
    }
  }
  return anyLs === 1 ? bestLs : bestGeo;
}

/**
 * Target man for a long goal kick of `team`: outfield teammates inside the pitch longMin..longMax from the spot, not
 * back across the own goal; forwards first (role tier), then best in the air (heading + height), then the more open. -1 if none.
 */
export function bestLongOption(s: SimState, team: number, taker: number): number {
  const r = s.match.restart;
  const x0 = r.x, z0 = r.z;
  const tm = team === 1 ? 1 : 0;
  const first = teamFirstSlot(tm);
  const T = T_GOAL_KICK;
  let best = -1;
  let bestScore = -1e18;
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (slot === taker) continue;
    const q = s.players[slot]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    if (!insidePitch(q.x, q.z, T.targetPitchMargin)) continue;
    const dx = q.x - x0, dz = q.z - z0;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < T.longMin || d > T.longMax) continue;
    if (!aiLaneOk(s, tm, x0, z0, dx, dz)) continue;
    const a = s.attrs[slot]!;
    evalLane(s, tm, x0, z0, q.x, q.z);
    const open = LANE.open < T.openCap ? LANE.open : T.openCap;
    const sc = T.tierWeight * targetTier(q.role) + a.heading + T.heightWeight * (a.height - 180) + T.longOpenWeight * open;
    if (sc > bestScore) { bestScore = sc; best = slot; }
  }
  return best;
}

/**
 * The AI's goal kick for the current restart, written to `out`: short ground pass to an open defender, else a long
 * LOB_PASS to the target man, else a short pass to the best available teammate, else a long kick straight ahead.
 * Returns 1 (0 only when no goal kick is set up).
 */
export function chooseGoalKick(s: SimState, out: GoalKickChoice): number {
  const r = s.match.restart;
  out.kind = KickKind.NONE;
  out.target = -1;
  out.x = r.x;
  out.z = r.z;
  out.power = 0;
  if (r.kind !== RestartKind.GOAL_KICK) return 0;
  const team = r.team === 1 ? 1 : 0;
  const taker = r.taker;
  let target = bestShortOption(s, team, taker, 1);
  let lob = false;
  if (target < 0) {
    target = bestLongOption(s, team, taker);
    lob = target >= 0;
  }
  if (target < 0) target = bestShortOption(s, team, taker, 0);
  if (target >= 0) {
    const q = s.players[target]!;
    const dx = q.x - r.x, dz = q.z - r.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    out.kind = lob ? KickKind.LOB_PASS : KickKind.GROUND_PASS;
    out.target = target;
    out.x = q.x;
    out.z = q.z;
    out.power = lob ? longPower(d) : shortPower(d);
    return 1;
  }
  const dir = s.teams[team]!.dir;
  out.kind = KickKind.LOB_PASS;
  out.x = clamp(r.x + dir * T_GOAL_KICK.longFallbackDist, -HALF_LENGTH, HALF_LENGTH);
  out.z = r.z;
  out.power = longPower(T_GOAL_KICK.longFallbackDist);
  return 1;
}

// ---------------------------------------------------------------- kicking

/** Unit aim direction of the current restart into AIM; returns 1 if an aim away from the ball is set, else forward. */
function aimDirection(s: SimState): number {
  const r = s.match.restart;
  const dx = r.aimX - r.x, dz = r.aimZ - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > T_RESTART_COMMON.aimMinDist) { AIM.x = dx / d; AIM.z = dz / d; return 1; }
  AIM.x = s.teams[r.team === 1 ? 1 : 0]!.dir;
  AIM.z = 0;
  return 0;
}

/** Point the aim at (x, z) (clamped to the pitch). */
function setAimPoint(s: SimState, x: number, z: number): void {
  const r = s.match.restart;
  r.aimX = clamp(x, -HALF_LENGTH, HALF_LENGTH);
  r.aimZ = clamp(z, -HALF_WIDTH, HALF_WIDTH);
}

/**
 * Start the taker's kick of `kind` from REQ (already filled): ends his SET_PIECE wait (RUL-11 prepareTakerKick), turns
 * him along the kick, calls SIM-08 startPass / SIM-09 startLob. Returns 1 if started (if refused, RUL-11 puts him
 * back into SET_PIECE next tick).
 */
function startTakerKick(s: SimState, slot: number, kind: KickKind, ev: EventSink): number {
  if (prepareTakerKick(s, slot) !== 1) return 0;
  const p = s.players[slot]!;
  const d = Math.sqrt(REQ.dirX * REQ.dirX + REQ.dirZ * REQ.dirZ);
  if (d > 1e-6) { p.fx = REQ.dirX / d; p.fz = REQ.dirZ / d; }
  const ok = isLobKind(kind) ? startLob(s, slot, kind, REQ, ev) : startPass(s, slot, kind, REQ, ev);
  if (ok === 1) s.match.restart.aimPower = REQ.charging === 1 ? 0 : REQ.power;
  return ok === 1 ? 1 : 0;
}

/** Fill REQ's direction (unit vector) from the spot toward (x, z); falls back to AIM when the point is on the ball. */
function reqDirTo(s: SimState, x: number, z: number): void {
  const r = s.match.restart;
  const dx = x - r.x, dz = z - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-6) { REQ.dirX = dx / d; REQ.dirZ = dz / d; return; }
  aimDirection(s);
  REQ.dirX = AIM.x;
  REQ.dirZ = AIM.z;
}

function resetReq(assist: AssistLevel, flags: number): void {
  REQ.power = 0;
  REQ.charging = 0;
  REQ.dirX = 0;
  REQ.dirZ = 0;
  REQ.targetSlot = -1;
  REQ.hasTarget = 0;
  REQ.targetX = 0;
  REQ.targetZ = 0;
  REQ.curve = 0;
  REQ.assist = assist;
  REQ.flags = ReqFlag.SET_PIECE | flags;
}

/** Waiting states of the taker in which a new kick may start. */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE;
}

/** Default kick (shared by goalKickDefault and the CPU fallback). Returns 1 if the kick started. */
function takeDefault(s: SimState, ev: EventSink): number {
  if (!goalKickLive(s)) return 0;
  const r = s.match.restart;
  let t = r.taker;
  if (!isValidTaker(s, t)) {
    t = pickGoalKickTaker(s, r.team, r.x, r.z);
    if (t < 0) return 0;
    r.taker = t;
  }
  if (!takerWaiting(s.players[t]!)) return 0; // already kicking (no double kick) or down: the safety nets take over
  if (chooseGoalKick(s, CHOICE) === 0) return 0;
  resetReq(AssistLevel.ASSISTED, 0);
  reqDirTo(s, CHOICE.x, CHOICE.z);
  REQ.power = CHOICE.power;
  REQ.targetSlot = CHOICE.target;
  if (CHOICE.target < 0) {
    REQ.hasTarget = 1;
    REQ.targetX = CHOICE.x;
    REQ.targetZ = CHOICE.z;
  }
  setAimPoint(s, CHOICE.x, CHOICE.z);
  return startTakerKick(s, t, CHOICE.kind, ev);
}

// ---------------------------------------------------------------- input helpers

/**
 * Stick aim from the frame (when the stick is past T_INPUT.stickIdle): the aim point goes aimDist along it, with the
 * backward component toward the own goal line removed (sideways is fine). Reads the frame directly so the per-tick
 * path passes no doubles through calls.
 */
function aimWithStick(s: SimState, f: Readonly<InputFrame>): void {
  let ax = f.mx / AXIS_SCALE, az = f.mz / AXIS_SCALE;
  if (!(ax === ax && az === az)) return;
  const idle = T_INPUT.stickIdle;
  if (ax * ax + az * az <= idle * idle) return;
  const r = s.match.restart;
  const dir = s.teams[r.team === 1 ? 1 : 0]!.dir;
  if (dir * ax < 0) ax = 0; // never back toward the own goal line
  const d = Math.sqrt(ax * ax + az * az);
  if (d < 1e-6) { ax = dir; az = 0; } else { ax /= d; az /= d; }
  const x = r.x + ax * T_GOAL_KICK.aimDist, z = r.z + az * T_GOAL_KICK.aimDist;
  r.aimX = x < -HALF_LENGTH ? -HALF_LENGTH : x > HALF_LENGTH ? HALF_LENGTH : x;
  r.aimZ = z < -HALF_WIDTH ? -HALF_WIDTH : z > HALF_WIDTH ? HALF_WIDTH : z;
}

/** PASS / LOB press by the taker's controller. */
function buttonKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel; buttons: number }>, slot: number,
  lob: boolean, f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const modL = (c.buttons & Btn.MOD_L) !== 0;
  const modR = (c.buttons & Btn.MOD_R) !== 0;
  let kind: KickKind;
  if (lob) kind = modL ? (modR ? KickKind.DRIVEN_LOB : KickKind.HIGH_LOB) : KickKind.LOB_PASS;
  else kind = modR ? KickKind.DRIVEN_PASS : KickKind.GROUND_PASS;
  resetReq(c.assist, c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0);
  if (f.power > 0) {
    REQ.power = clamp(f.power / UNIT_SCALE, 0, 1);
    REQ.charging = 0;
  } else {
    REQ.power = 0;
    REQ.charging = 1; // the resolver attaches the power bar to the pressed button (adoptCharge)
  }
  const aimed = aimDirection(s) === 1;
  let target = -1;
  if (!aimed && c.assist !== AssistLevel.MANUAL) {
    target = lob ? bestLongOption(s, team, slot) : bestShortOption(s, team, slot, 0);
    if (target < 0 && lob) target = bestShortOption(s, team, slot, 0);
  }
  if (target >= 0) {
    const q = s.players[target]!;
    REQ.targetSlot = target;
    reqDirTo(s, q.x, q.z);
    setAimPoint(s, q.x, q.z);
  } else {
    REQ.dirX = AIM.x;
    REQ.dirZ = AIM.z;
    if (!aimed) setAimPoint(s, r.x + AIM.x * T_GOAL_KICK.aimDist, r.z + AIM.z * T_GOAL_KICK.aimDist);
  }
  return startTakerKick(s, slot, kind, ev);
}

/**
 * Gesture by the taker's controller: TAP / DOUBLE_TAP on a teammate (ground pass to feet / lobbed) or on a pitch spot
 * (kick to that spot). Returns 1 if the gesture was used (kick started or refused by the starter), 0 if ignored.
 */
function gestureKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  let target = -1;
  let tx: number, tz: number;
  const g = f.gSlot;
  if (g >= 0 && g < NUM_SLOTS) {
    const q = s.players[g]!;
    if (g === slot || q.active !== 1 || q.team !== team) return 0; // the taker himself or an opponent: not a target
    target = g;
    tx = q.x;
    tz = q.z;
  } else {
    const gx = f.gx / GESTURE_POS_SCALE, gz = f.gz / GESTURE_POS_SCALE;
    if (!(gx === gx && gz === gz)) return 0;
    tx = clamp(gx, -HALF_LENGTH + T_GOAL_KICK.targetPitchMargin, HALF_LENGTH - T_GOAL_KICK.targetPitchMargin);
    tz = clamp(gz, -HALF_WIDTH + T_GOAL_KICK.targetPitchMargin, HALF_WIDTH - T_GOAL_KICK.targetPitchMargin);
  }
  const dx = tx - r.x, dz = tz - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < T_GOAL_KICK.tapMinDist || !clearOfOwnGoal(s, team, r.x, r.z, dx, dz)) return 0;
  const lob = f.gesture === GestureKind.DOUBLE_TAP || d > T_GOAL_KICK.tapGroundMax;
  resetReq(c.assist, ReqFlag.GESTURE | (c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0));
  REQ.dirX = dx / d;
  REQ.dirZ = dz / d;
  REQ.power = lob ? longPower(d) : shortPower(d);
  REQ.targetSlot = target;
  if (target < 0) {
    REQ.hasTarget = 1;
    REQ.targetX = tx;
    REQ.targetZ = tz;
  }
  setAimPoint(s, tx, tz);
  startTakerKick(s, slot, lob ? KickKind.LOB_PASS : KickKind.GROUND_PASS, ev);
  return 1;
}

/** A controller not holding the taker moves his free controlled player with the stick (RUL-11 keeps him legal). */
function moveOffBall(s: SimState, c: Readonly<{ slot: number; side: number; buttons: number }>, f: Readonly<InputFrame>): void {
  const slot = c.slot;
  if (slot < 0 || slot >= NUM_SLOTS || slot === s.match.restart.taker) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== c.side || p.act !== ActionKind.NONE || p.stunT > 0) return;
  let mx = f.mx / AXIS_SCALE, mz = f.mz / AXIS_SCALE;
  if (!(mx === mx && mz === mz)) return;
  const m = Math.sqrt(mx * mx + mz * mz);
  if (m <= T_INPUT.stickIdle) return; // the resolver has already stopped a stale intent
  if (m > 1) { mx /= m; mz /= m; }
  p.moveMode = MoveMode.DIRECT;
  p.ix = mx;
  p.iz = mz;
  p.wantSprint = (c.buttons & Btn.SPRINT) !== 0 ? 1 : 0;
  p.lookAt = 0;
}

// ---------------------------------------------------------------- restart API

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function goalKickSetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.GOAL_KICK) return;
  const team = r.team === 1 ? 1 : 0;
  const b = s.ball;
  const side = r.z < 0 ? -1 : r.z > 0 ? 1 : b.crossZ < 0 ? -1 : 1;
  goalKickSpot(s, team, side, r.z, LOOK);
  r.x = LOOK.x;
  r.z = LOOK.z;
  r.side = side;
  r.aimX = LOOK.x;
  r.aimZ = LOOK.z;
  r.aimPower = 0;
  r.aimCurve = 0;
  placeBall(s, LOOK.x, LOOK.z, ev);
  r.taker = pickGoalKickTaker(s, team, LOOK.x, LOOK.z);
}

/** Per tick while the phase is active. */
export function goalKickTick(s: SimState, ev: EventSink): void {
  if (!goalKickLive(s)) return;
  const r = s.match.restart;
  if (r.ready !== 1) return;
  const t = r.taker;
  if (!isValidTaker(s, t)) return; // RUL-11 re-picks
  const p = s.players[t]!;
  if (p.act === ActionKind.SET_PIECE) {
    // Line up behind the ball along the aim (within RUL-11's reach of the spot), sliding a little per tick.
    restartLookPoint(s, LOOK);
    let ux = LOOK.x - r.x, uz = LOOK.z - r.z;
    const ul = Math.sqrt(ux * ux + uz * uz);
    if (ul > 1e-6) {
      ux /= ul; uz /= ul;
      const behind = T_RESTART.takerBehind;
      const dx = r.x - ux * behind - p.x, dz = r.z - uz * behind - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const step = T_GOAL_KICK.lineUpStep;
      if (d <= step) { p.x += dx; p.z += dz; } else if (d > 1e-9) { p.x += (dx / d) * step; p.z += (dz / d) * step; }
      // Never closer to the ball than his spot (the slide follows the circle around it, not the chord).
      const bx = p.x - r.x, bz = p.z - r.z;
      const bd = Math.sqrt(bx * bx + bz * bz);
      if (bd > 1e-6 && bd < behind) { p.x = r.x + (bx / bd) * behind; p.z = r.z + (bz / bd) * behind; }
    }
  } else if (p.actCharging === 1 && (p.act === ActionKind.KICK || p.act === ActionKind.SHOT)) {
    r.aimPower = clamp(p.actPower, 0, 1);
  }
  // A side without a human: the CPU brain (TAI-13) normally takes it after cpuRestartDelay; fall back to the Default.
  if (!teamHasHuman(s, r.team)) {
    const waited = r.t - T_RULES.restartSetupTicks;
    const due = T_RULES.cpuRestartDelay + T_GOAL_KICK.cpuGraceTicks;
    if (waited >= due && (waited - due) % T_GOAL_KICK.cpuRetryTicks === 0) takeDefault(s, ev);
  }
}

/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function goalKickInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  if (!goalKickLive(s)) return;
  if (!(ctrlIdx >= 0 && ctrlIdx < s.ctrl.length)) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || (c.side !== 0 && c.side !== 1)) return;
  const r = s.match.restart;
  if (r.ready !== 1) return;
  const t = r.taker;
  if (c.side !== r.team || c.slot !== t) {
    moveOffBall(s, c, f);
    return;
  }
  if (!isValidTaker(s, t) || !takerWaiting(s.players[t]!)) return; // kicking already (power bar) or down
  aimWithStick(s, f);
  if (f.gesture === GestureKind.TAP || f.gesture === GestureKind.DOUBLE_TAP) {
    if (gestureKick(s, c, t, f, ev) === 1) return;
  }
  const pressed = c.buttons & ~c.prevButtons;
  if ((pressed & Btn.PASS) !== 0) buttonKick(s, c, t, false, f, ev);
  else if ((pressed & Btn.LOB) !== 0) buttonKick(s, c, t, true, f, ev);
}

/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function goalKickDefault(s: SimState, ev: EventSink): void {
  takeDefault(s, ev);
}

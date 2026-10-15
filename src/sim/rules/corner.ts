/**
 * [RUL-04] Corners - ball in the corner arc on the correct side, opponents 9.15 m; lob cross (LOB), short pass (PASS), aim with left stick, target reticle with right stick; corner tactics (team.cornerTactic).
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 *
 * Implementation notes (RUL-04):
 *  - Setup (RUL-11 awardRestart calls it after filling s.match.restart): the ball goes in the corner arc of the end the
 *    team attacks (team.dir), on the side of the award (sign of restart.z, else of ball.crossZ): an awarded spot whose
 *    centre is in the arc with the whole ball inside both lines is kept, anything else (the flag itself, a spot on a
 *    line or outside the arc) goes on the canonical spot LOCAL_TUNING.spotInset x CORNER_ARC_RADIUS inside both lines
 *    (never resting on a line); restart.side = that side (-1/+1). The aim reticle (restart.aimX/aimZ) starts
 *    on the penalty-spot area zone; aimPower / aimCurve reset. Taker = the team's best crosser (crossing + curve
 *    weight) among outfield players NOT needed in the box (the boxHeaders best in the air by heading + height are kept
 *    for the box); players who are down are avoided when possible; fallbacks: any outfield player, then anyone active.
 *    RUL-11 then places everybody legally at ready (opponents >= 9.15 m) and pushes intruders out every tick.
 *  - Input (SETPIECE_INPUT[CORNER]; SIM-15 routes every controller's frame here during CORNER), the controller holding
 *    the taker once restart.ready, while the taker waits:
 *      left stick moves the aim reticle at aimSpeed, right stick at reticleSpeed (m/s at full deflection); the reticle
 *      is always clamped inside the attacked penalty area (aimLineMargin off the goal line, aimBoxMargin inside the
 *      box lines). A CORNER_* tactic Command in the frame (TAI-14 has applied it to team.cornerTactic earlier in the
 *      same tick) moves the reticle onto the zone of the team's current tactic.
 *      LOB = cross to the reticle: SIM-09 startLob(CROSS) with req.hasTarget = 1 at the reticle (L1 + R1 + LOB =
 *      LOW_CROSS, L1 + LOB = CROSS with ReqFlag.LOFTED); power from the hold (charging; the resolver fills the bar) or
 *      the frame's explicit power; curl from frame.curve.
 *      PASS = short corner: SIM-08 startPass(GROUND_PASS; R1 + PASS = DRIVEN_PASS) to the nearest outfield teammate
 *      (TAI-13 places one short option), power from the hold or the frame.
 *      Gestures: TAP / DOUBLE_TAP a teammate -> cross to him when he is in the cross area (the box, extended
 *      crossAreaExtra beyond its line), a ground pass (lofted on DOUBLE_TAP) when he is within shortTapMax of the ball,
 *      else a lob pass; TAP a spot -> cross to it when it is in the box, a ground pass when it is outside the box within
 *      shortTapMax, else a cross to the nearest point of the box. SWIPE / CURVED_SWIPE flagged FROM_BALL: direction
 *      gdx/gdz (landing: the gesture point when it is in the box, else the point of the swipe line through the box
 *      nearest the reticle), gPower sets the height (GROUND_CROSS / LOW_CROSS / CROSS / CROSS + LOFTED by band) and is
 *      the request power, gCurve the curl. Every kick carries ReqFlag.SET_PIECE (+ GESTURE / CPU).
 *    Any other controller (the defending side, or a second human on the taking side) moves its free controlled player
 *    with the stick (RUL-11 keeps defenders 9.15 m away).
 *  - Tick: keeps the reticle inside the box (re-seeded on the penalty-spot zone when something else wrote it, e.g. a
 *    phase adopted by RUL-11 without a Setup); the waiting taker lines up behind the ball along the aim (slides
 *    lineUpStep per tick inside RUL-11's reach); restart.aimPower mirrors the power bar while he charges; a side with
 *    no human takes the corner by Default cpuGraceTicks after T_RULES.cpuRestartDelay past ready (retried every
 *    cpuRetryTicks) if its CPU brain (TAI-13) has not, so RUL-11's 4 s CPU watchdog never has to fire.
 *  - Default (RUL-11 calls it at the human timeout; also the CPU fallback): a CROSS to the zone of the team's corner
 *    tactic (team.cornerTactic: penalty-spot area by default, far post, edge of the box, the keeper's six-yard box,
 *    near post): the best header within zoneRadius of the zone (heading + height + openness - distance to the zone)
 *    as receiver and target point, else the zone point itself. chooseCornerCross exposes the decision.
 *  - No offside from corners: the kick's contact happens while the phase is still CORNER (applyKick marks the restart
 *    taken; RUL-01 returns to IN_PLAY after the rules of that tick), which RUL-08 checks at kick time.
 * Per-tick work is O(1) (Default / choice O(11 x 11), once per kick); allocation-free (module scratch only).
 */
import {
  BALL_RADIUS, CORNER_ARC_RADIUS, DT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
  PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, Command, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, GestureFlag, UNIT_SCALE, type InputFrame } from '../../contracts/input';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { createActionRequest, ReqFlag } from '../../contracts/systems';
import { T_INPUT, T_PASS, T_RULES } from '../../contracts/tuning';
import { groundPassSpeed } from '../ball/flight';
import { releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import { startLob } from '../kicks/lob';
import { startPass } from '../kicks/pass';
import { restartLookPoint } from './restartCommon';
import { LOCAL_TUNING as RESTART_TUNING, isValidTaker, prepareTakerKick } from './restart';

/** TUNING-CR (RUL-04): proposed T_CORNER block (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Corner spot: inset from both lines, fraction of CORNER_ARC_RADIUS (0.5 -> 0.71 m from the flag, inside the arc). */
  spotInset: 0.5,
  /** Taker choice: this many best headers (heading + height) are kept for the box and never take the corner. */
  boxHeaders: 3,
  /** Taker choice: crossing + this weight x curve (attribute points). */
  takerCurveWeight: 0.5,
  /** Aerial score: heading + this many points per cm above 180 cm. */
  heightWeight: 0.5,
  /** Aim reticle: at least this far in front of the goal line, m, and this far inside the box lines, m. */
  aimLineMargin: 1,
  aimBoxMargin: 0.5,
  /** Reticle speed at full deflection: left stick (aim) and right stick (target reticle), m/s. */
  aimSpeed: 14,
  reticleSpeed: 22,
  /** Zones per corner tactic (0 default = penalty-spot area, 1 far post, 2 edge of the box, 3 crowd the keeper,
   *  4 near post): depth from the goal line, m, and lateral offset toward the corner's side (negative = far side), m. */
  zoneDepth: [10, 6, 15.8, 3, 5.5] as readonly number[],
  zoneSide: [0, -5, 0, 0, 3.5] as readonly number[],
  /** Default: headers within this distance of the tactic zone are receivers, m (< the ~5.5 m between zones, so a
   *  tactic never falls back on its neighbour's runner). */
  zoneRadius: 5,
  /** Default receiver score: openness (nearest opponent) capped at this, m, times this weight; minus this weight per
   *  metre from the zone (attribute-point scale). */
  zoneOpenCap: 3,
  zoneOpenWeight: 4,
  zoneDistWeight: 4,
  /** Cross power for a tap / the Default = clamp(distance / crossPowerRange, crossPowerMin, crossPowerMax), 0..1. */
  crossPowerRange: 45,
  crossPowerMin: 0.45,
  crossPowerMax: 0.9,
  /** A teammate this far beyond the 16.5 m line (and inside the box width) still gets a cross, m (edge of the box). */
  crossAreaExtra: 5,
  /** A tap outside the cross area within this distance of the ball is a ground pass (short corner), m. */
  shortTapMax: 15,
  /** Taps closer than this to the ball are ignored, m. */
  tapMinDist: 2,
  /** Ground passes are sized for this arrival speed (SIM-01 groundPassSpeed), m/s; lowest power 0..1. */
  shortArrive: 5,
  shortPowerMin: 0.15,
  /** Lob pass (tap on a far teammate outside the cross area) power = clamp(d / lobPowerRange, lobPowerMin, 1). */
  lobPowerRange: 70,
  lobPowerMin: 0.45,
  /** Swipe height bands (gPower / 127): below groundCrossMax a ground cross, below lowCrossMax a low cross, from
   *  highCrossMin a high (LOFTED) cross, else a normal cross. */
  groundCrossMax: 0.2,
  lowCrossMax: 0.45,
  highCrossMin: 0.8,
  /** The waiting taker slides toward his spot behind the ball along the aim at most this far per tick, m/tick. */
  lineUpStep: 0.05,
  /** CPU fallback: Default this many ticks after T_RULES.cpuRestartDelay past ready (ticks, 2.3 s) ... */
  cpuGraceTicks: 140, // [QF-10] was 60: TAI-13 waits for its box runners (QF-2 CR); due 200 < RUL-11's 240-tick CPU watchdog
  /** ... retried every this many ticks while the kick has not started, ticks. */
  cpuRetryTicks: 30,
} as const;

// ---------------------------------------------------------------- module scratch (no allocation per tick)

const REQ = createActionRequest();
const PT = { x: 0, z: 0 };
const LOOK = { x: 0, z: 0 };
/** 1 for the boxHeaders best in the air of the team being considered (pickCornerTaker). */
const KEEP_IN_BOX = new Uint8Array(NUM_SLOTS);

/** A corner decision (chooseCornerCross). */
export interface CornerChoice {
  /** CROSS (NONE when no corner is set up). */
  kind: KickKind;
  /** Intended receiver slot, -1 = the zone point. */
  target: number;
  /** Target point (the receiver's position or the zone point). */
  x: number;
  z: number;
  /** Kick power 0..1. */
  power: number;
}

export function createCornerChoice(): CornerChoice {
  return { kind: KickKind.NONE, target: -1, x: 0, z: 0, power: 0 };
}

const CHOICE = createCornerChoice();

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isDown(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.STUMBLE || p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP || p.stunT > 0;
}

function isLobKind(kind: KickKind): boolean {
  return kind === KickKind.LOB_PASS || kind === KickKind.HIGH_LOB || kind === KickKind.DRIVEN_LOB ||
    kind === KickKind.CROSS || kind === KickKind.GROUND_CROSS || kind === KickKind.LOW_CROSS;
}

/** Waiting states of the taker in which a new kick may start. */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  return p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE;
}

/** True while this restart is an untaken corner in the CORNER phase. */
function cornerLive(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.CORNER && m.restart.kind === RestartKind.CORNER && m.restart.taken === 0;
}

function attackDir(s: SimState, team: number): number {
  return s.teams[team === 1 ? 1 : 0]!.dir;
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

/** Aerial score of a player (heading + height bonus), attribute points. */
function aerialScore(s: SimState, slot: number): number {
  const a = s.attrs[slot]!;
  return a.heading + LOCAL_TUNING.heightWeight * (a.height - 180);
}

/** Nearest active opponent of `team` to (x, z), m (1e9 when none). */
function openness(s: SimState, team: number, x: number, z: number): number {
  const first = teamFirstSlot(team === 0 ? 1 : 0);
  let best = 1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - x, dz = q.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best >= 1e18 ? 1e9 : Math.sqrt(best);
}

/** Power 0..1 of a ground pass over `d` metres (the speed it needs on the T_PASS ground speed range). */
export function cornerShortPower(d: number): number {
  const v = clamp(groundPassSpeed(d, LOCAL_TUNING.shortArrive), T_PASS.groundMin, T_PASS.groundMax);
  return clamp((v - T_PASS.groundMin) / (T_PASS.groundMax - T_PASS.groundMin), LOCAL_TUNING.shortPowerMin, 1);
}

/** Power 0..1 of a cross over `d` metres. */
export function cornerCrossPower(d: number): number {
  return clamp(d / LOCAL_TUNING.crossPowerRange, LOCAL_TUNING.crossPowerMin, LOCAL_TUNING.crossPowerMax);
}

function lobPower(d: number): number {
  return clamp(d / LOCAL_TUNING.lobPowerRange, LOCAL_TUNING.lobPowerMin, 1);
}

// ---------------------------------------------------------------- geometry: spot, box, zones

/** Index 0..4 of a corner tactic Command (0 = none / default). */
export function cornerTacticIndex(cmd: number): number {
  switch (cmd) {
    case Command.CORNER_FAR_POST: return 1;
    case Command.CORNER_EDGE_OF_BOX: return 2;
    case Command.CORNER_CROWD_KEEPER: return 3;
    case Command.CORNER_NEAR_POST: return 4;
    default: return 0;
  }
}

/** Canonical corner spot for `team` on side `side` (-1/+1) of the end it attacks: inside the arc and both lines. */
export function cornerSpot(s: SimState, team: number, side: number, out: { x: number; z: number }): void {
  const e = attackDir(s, team);
  const inset = CORNER_ARC_RADIUS * LOCAL_TUNING.spotInset;
  out.x = e * (HALF_LENGTH - inset);
  out.z = (side < 0 ? -1 : 1) * (HALF_WIDTH - inset);
}

/**
 * True if (x, z) is a legal corner spot for `team` on side `side`: ball centre inside the corner arc at the end the team
 * attacks, and the whole ball inside both lines (never resting on, or partly over, a line).
 */
export function isCornerSpot(s: SimState, team: number, side: number, x: number, z: number): boolean {
  const e = attackDir(s, team);
  const sd = side < 0 ? -1 : 1;
  const dx = e * HALF_LENGTH - x, dz = sd * HALF_WIDTH - z;
  if (!(dx * dx + dz * dz <= CORNER_ARC_RADIUS * CORNER_ARC_RADIUS)) return false; // NaN fails too
  return e * dx >= BALL_RADIUS && sd * dz >= BALL_RADIUS;
}

/**
 * Clamp (x, z) into the aim region of a corner by `team`: its attacked penalty area, at least aimLineMargin in front of
 * the goal line and aimBoxMargin inside the box lines. Non-finite inputs fall back to the penalty spot.
 */
export function clampToCornerBox(s: SimState, team: number, x: number, z: number, out: { x: number; z: number }): void {
  const e = attackDir(s, team);
  const T = LOCAL_TUNING;
  let u = HALF_LENGTH - e * x;
  if (!(u === u) || u === Infinity || u === -Infinity) u = T.zoneDepth[0]!;
  let w = z;
  if (!(w === w) || w === Infinity || w === -Infinity) w = 0;
  u = clamp(u, T.aimLineMargin, PENALTY_AREA_DEPTH - T.aimBoxMargin);
  const wl = PENALTY_AREA_HALF_WIDTH - T.aimBoxMargin;
  out.x = e * (HALF_LENGTH - u);
  out.z = clamp(w, -wl, wl);
}

/** True if (x, z) lies inside the aim region of a corner by `team` (see clampToCornerBox), within `slack` m. */
export function inCornerBox(s: SimState, team: number, x: number, z: number, slack: number): boolean {
  const e = attackDir(s, team);
  const T = LOCAL_TUNING;
  const u = HALF_LENGTH - e * x;
  const wl = PENALTY_AREA_HALF_WIDTH - T.aimBoxMargin + slack;
  return u >= T.aimLineMargin - slack && u <= PENALTY_AREA_DEPTH - T.aimBoxMargin + slack && z >= -wl && z <= wl;
}

/** Inside the attacked penalty area of `team` (raw box lines), extended `extra` m beyond the 16.5 m line. */
function inAttackedBox(s: SimState, team: number, x: number, z: number, extra: number): boolean {
  const u = HALF_LENGTH - attackDir(s, team) * x;
  return u >= 0 && u <= PENALTY_AREA_DEPTH + extra && z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH;
}

/**
 * Zone point of corner tactic `cmd` (Command.CORNER_* or 0) for a corner by `team` from side `side` (-1/+1), written
 * to `out`: zoneDepth from the attacked goal line, zoneSide toward the corner's side.
 */
export function cornerZone(s: SimState, team: number, side: number, cmd: number, out: { x: number; z: number }): void {
  const i = cornerTacticIndex(cmd);
  const e = attackDir(s, team);
  out.x = e * (HALF_LENGTH - LOCAL_TUNING.zoneDepth[i]!);
  out.z = (side < 0 ? -1 : 1) * LOCAL_TUNING.zoneSide[i]!;
}

function setAim(s: SimState, x: number, z: number): void {
  const r = s.match.restart;
  clampToCornerBox(s, r.team, x, z, PT);
  r.aimX = PT.x;
  r.aimZ = PT.z;
}

/**
 * Per-tick variant of setAim: clamps restart.aimX/aimZ into the box in place, reading them from state (no doubles pass
 * through calls on the hot path: V8 boxes doubles handed to functions it does not inline). A reticle already inside is
 * left untouched (bit for bit). Returns 1 if it was inside, 0 if it had to be clamped.
 */
function clampAimInPlace(s: SimState): number {
  const r = s.match.restart;
  const T = LOCAL_TUNING;
  const e = s.teams[r.team === 1 ? 1 : 0]!.dir;
  let u = HALF_LENGTH - e * r.aimX;
  let w = r.aimZ;
  const uMin = T.aimLineMargin, uMax = PENALTY_AREA_DEPTH - T.aimBoxMargin;
  const wl = PENALTY_AREA_HALF_WIDTH - T.aimBoxMargin;
  if (u >= uMin && u <= uMax && w >= -wl && w <= wl) return 1; // NaN fails every comparison
  if (!(u === u) || u === Infinity || u === -Infinity) u = T.zoneDepth[0]!;
  if (!(w === w) || w === Infinity || w === -Infinity) w = 0;
  u = u < uMin ? uMin : u > uMax ? uMax : u;
  w = w < -wl ? -wl : w > wl ? wl : w;
  r.aimX = e * (HALF_LENGTH - u);
  r.aimZ = w;
  return 0;
}

function cornerSide(s: SimState): number {
  const r = s.match.restart;
  return r.side < 0 ? -1 : r.side > 0 ? 1 : r.z < 0 ? -1 : 1;
}

// ---------------------------------------------------------------- taker

/**
 * Corner taker for `team`: the best crosser (crossing + takerCurveWeight x curve) among active outfield players who
 * are not among the boxHeaders best in the air (heading + height). Players who are down are avoided when possible;
 * fallbacks: any outfield player (headers included), then any active player. Ties go to the lower slot. -1 if the team
 * has nobody active.
 */
export function pickCornerTaker(s: SimState, team: number): number {
  const tm = team === 1 ? 1 : 0;
  const first = teamFirstSlot(tm);
  const end = first + PLAYERS_PER_TEAM;
  for (let i = 0; i < NUM_SLOTS; i++) KEEP_IN_BOX[i] = 0;
  for (let k = 0; k < LOCAL_TUNING.boxHeaders; k++) {
    let best = -1;
    let bestScore = -1e18;
    for (let slot = first; slot < end; slot++) {
      const p = s.players[slot]!;
      if (p.active !== 1 || p.isKeeper === 1 || KEEP_IN_BOX[slot] === 1) continue;
      const sc = aerialScore(s, slot);
      if (sc > bestScore) { bestScore = sc; best = slot; }
    }
    if (best < 0) break;
    KEEP_IN_BOX[best] = 1;
  }
  // pass 0: not a header, not down; 1: not a header; 2: any outfield, not down; 3: any outfield; 4: anyone active.
  for (let pass = 0; pass < 5; pass++) {
    let best = -1;
    let bestScore = -1e18;
    for (let slot = first; slot < end; slot++) {
      const p = s.players[slot]!;
      if (p.active !== 1) continue;
      if (pass < 4 && p.isKeeper === 1) continue;
      if (pass < 2 && KEEP_IN_BOX[slot] === 1) continue;
      if ((pass === 0 || pass === 2) && isDown(p)) continue;
      const a = s.attrs[slot]!;
      const sc = a.crossing + LOCAL_TUNING.takerCurveWeight * a.curve;
      if (sc > bestScore) { bestScore = sc; best = slot; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---------------------------------------------------------------- choice (Default)

/**
 * The AI's corner for the current restart, written to `out`: a CROSS to the zone of the team's corner tactic, aimed at
 * the best header within zoneRadius of it (heading + height + openness - distance to the zone), else at the zone
 * point. Returns 1 (0 when no corner is set up).
 */
export function chooseCornerCross(s: SimState, out: CornerChoice): number {
  const r = s.match.restart;
  out.kind = KickKind.NONE;
  out.target = -1;
  out.x = r.x;
  out.z = r.z;
  out.power = 0;
  if (r.kind !== RestartKind.CORNER) return 0;
  const team = r.team === 1 ? 1 : 0;
  const T = LOCAL_TUNING;
  cornerZone(s, team, cornerSide(s), s.teams[team]!.cornerTactic, PT);
  const zx = PT.x, zz = PT.z;
  const first = teamFirstSlot(team);
  const rad2 = T.zoneRadius * T.zoneRadius;
  let best = -1;
  let bestScore = -1e18;
  for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
    if (slot === r.taker) continue;
    const q = s.players[slot]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const dx = q.x - zx, dz = q.z - zz;
    const d2 = dx * dx + dz * dz;
    if (d2 > rad2) continue;
    const open = openness(s, team, q.x, q.z);
    const sc = aerialScore(s, slot) + T.zoneOpenWeight * (open < T.zoneOpenCap ? open : T.zoneOpenCap) -
      T.zoneDistWeight * Math.sqrt(d2);
    if (sc > bestScore) { bestScore = sc; best = slot; }
  }
  out.kind = KickKind.CROSS;
  if (best >= 0) {
    out.target = best;
    out.x = s.players[best]!.x;
    out.z = s.players[best]!.z;
  } else {
    out.x = zx;
    out.z = zz;
  }
  const dx = out.x - r.x, dz = out.z - r.z;
  out.power = cornerCrossPower(Math.sqrt(dx * dx + dz * dz));
  return 1;
}

// ---------------------------------------------------------------- kicking

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

/** Fill REQ's direction (unit vector) from the spot toward (x, z); toward the aim when the point is on the ball. */
function reqDirTo(s: SimState, x: number, z: number): void {
  const r = s.match.restart;
  let dx = x - r.x, dz = z - r.z;
  let d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) {
    dx = r.aimX - r.x;
    dz = r.aimZ - r.z;
    d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) { dx = attackDir(s, r.team); dz = 0; d = 1; }
  }
  REQ.dirX = dx / d;
  REQ.dirZ = dz / d;
}

/** Explicit power from the frame (0 = none -> charging from the hold). */
function reqPowerFrom(f: Readonly<InputFrame>): void {
  const pw = f.power;
  if (pw > 0 && pw === pw) {
    REQ.power = clamp(pw / UNIT_SCALE, 0, 1);
    REQ.charging = 0;
  } else {
    REQ.power = 0;
    REQ.charging = 1; // the resolver attaches the power bar to the pressed button (adoptCharge)
  }
}

/**
 * Start the taker's kick of `kind` from REQ (already filled): ends his SET_PIECE wait (RUL-11 prepareTakerKick), turns
 * him along the kick, calls SIM-09 startLob / SIM-08 startPass. Returns 1 if started (if refused, RUL-11 puts him back
 * into SET_PIECE next tick).
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

/** Cross request toward (x, z) (already a landing point), receiver `target` or -1. */
function fillCross(s: SimState, x: number, z: number, target: number): void {
  reqDirTo(s, x, z);
  REQ.targetSlot = target;
  REQ.hasTarget = 1;
  REQ.targetX = x;
  REQ.targetZ = z;
}

/** Default kick (shared by cornerDefault and the CPU fallback). Returns 1 if the kick started. */
function takeDefault(s: SimState, ev: EventSink): number {
  if (!cornerLive(s)) return 0;
  const r = s.match.restart;
  let t = r.taker;
  if (!isValidTaker(s, t)) {
    t = pickCornerTaker(s, r.team);
    if (t < 0) return 0;
    r.taker = t;
  }
  if (!takerWaiting(s.players[t]!)) return 0; // already kicking (no double kick) or down: the safety nets take over
  if (chooseCornerCross(s, CHOICE) === 0) return 0;
  resetReq(AssistLevel.ASSISTED, 0);
  fillCross(s, CHOICE.x, CHOICE.z, CHOICE.target);
  REQ.power = CHOICE.power;
  setAim(s, CHOICE.x, CHOICE.z);
  return startTakerKick(s, t, CHOICE.kind, ev);
}

// ---------------------------------------------------------------- input helpers

/**
 * Move the reticle with the left stick (aimSpeed) and the right stick (reticleSpeed); always clamped in the box. Reads
 * the frame directly and clamps in place, so the per-tick path passes no doubles through calls.
 */
function moveReticle(s: SimState, f: Readonly<InputFrame>): void {
  const r = s.match.restart;
  const idle2 = T_INPUT.stickIdle * T_INPUT.stickIdle;
  let dx = 0, dz = 0;
  let mx = f.mx / AXIS_SCALE, mz = f.mz / AXIS_SCALE;
  if (mx === mx && mz === mz && mx * mx + mz * mz > idle2) {
    const k = LOCAL_TUNING.aimSpeed * DT;
    mx = mx < -1 ? -1 : mx > 1 ? 1 : mx;
    mz = mz < -1 ? -1 : mz > 1 ? 1 : mz;
    dx += mx * k;
    dz += mz * k;
  }
  let ax = f.ax / AXIS_SCALE, az = f.az / AXIS_SCALE;
  if (ax === ax && az === az && ax * ax + az * az > idle2) {
    const k = LOCAL_TUNING.reticleSpeed * DT;
    ax = ax < -1 ? -1 : ax > 1 ? 1 : ax;
    az = az < -1 ? -1 : az > 1 ? 1 : az;
    dx += ax * k;
    dz += az * k;
  }
  if (dx === 0 && dz === 0) return;
  r.aimX += dx;
  r.aimZ += dz;
  clampAimInPlace(s);
}

/** PASS press by the taker's controller: short corner to the nearest outfield teammate. */
function shortCorner(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel; buttons: number }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const first = teamFirstSlot(team);
  let best = -1;
  let bestD = 1e18;
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      if (i === slot) continue;
      const q = s.players[i]!;
      if (q.active !== 1 || (pass === 0 && q.isKeeper === 1)) continue;
      const dx = q.x - r.x, dz = q.z - r.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  if (best < 0) return 0;
  resetReq(c.assist, c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0);
  reqPowerFrom(f);
  const q = s.players[best]!;
  reqDirTo(s, q.x, q.z);
  REQ.targetSlot = best;
  const kind = (c.buttons & Btn.MOD_R) !== 0 ? KickKind.DRIVEN_PASS : KickKind.GROUND_PASS;
  return startTakerKick(s, slot, kind, ev);
}

/** LOB press by the taker's controller: cross to the reticle. */
function crossToReticle(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel; buttons: number }>,
  slot: number, f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const modL = (c.buttons & Btn.MOD_L) !== 0;
  const modR = (c.buttons & Btn.MOD_R) !== 0;
  const kind = modL && modR ? KickKind.LOW_CROSS : KickKind.CROSS;
  resetReq(c.assist, (c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0) | (modL && !modR ? ReqFlag.LOFTED : 0));
  reqPowerFrom(f);
  setAim(s, r.aimX, r.aimZ);
  fillCross(s, r.aimX, r.aimZ, -1);
  const cv = f.curve;
  if (cv !== 0 && cv === cv) {
    REQ.curve = clamp(cv / AXIS_SCALE, -1, 1);
    r.aimCurve = REQ.curve;
  }
  return startTakerKick(s, slot, kind, ev);
}

/**
 * TAP / DOUBLE_TAP by the taker's controller on a teammate or a spot. Returns 1 if the gesture was used (kick started
 * or refused by the starter), 0 if ignored.
 */
function tapKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const T = LOCAL_TUNING;
  let target = -1;
  let tx: number, tz: number;
  const g = f.gSlot;
  if (g === slot) return 0; // the taker himself (a tap on the ball): not a target
  if (g >= 0 && g < NUM_SLOTS && s.players[g]!.active === 1 && s.players[g]!.team === team) {
    target = g;
    tx = s.players[g]!.x;
    tz = s.players[g]!.z;
  } else {
    // A spot (or an opponent standing on it).
    const gx = f.gx / GESTURE_POS_SCALE, gz = f.gz / GESTURE_POS_SCALE;
    if (!(gx === gx && gz === gz) || gx === Infinity || gx === -Infinity || gz === Infinity || gz === -Infinity) return 0;
    tx = clamp(gx, -HALF_LENGTH, HALF_LENGTH);
    tz = clamp(gz, -HALF_WIDTH, HALF_WIDTH);
  }
  const dx = tx - r.x, dz = tz - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < T.tapMinDist) return 0;
  const dbl = f.gesture === GestureKind.DOUBLE_TAP;
  const flags = ReqFlag.GESTURE | (c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0);
  resetReq(c.assist, flags);
  let kind: KickKind;
  if (target >= 0 ? inAttackedBox(s, team, tx, tz, T.crossAreaExtra) : inAttackedBox(s, team, tx, tz, 0)) {
    // Cross: to the teammate where he stands, or to the spot (inside the aim region).
    if (target < 0) { clampToCornerBox(s, team, tx, tz, PT); tx = PT.x; tz = PT.z; }
    kind = KickKind.CROSS;
    if (dbl) REQ.flags |= ReqFlag.LOFTED;
    fillCross(s, tx, tz, target);
    REQ.power = cornerCrossPower(Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z)));
  } else if (d <= T.shortTapMax) {
    kind = dbl ? KickKind.LOB_PASS : KickKind.GROUND_PASS;
    reqDirTo(s, tx, tz);
    REQ.targetSlot = target;
    if (target < 0) { REQ.hasTarget = 1; REQ.targetX = tx; REQ.targetZ = tz; }
    REQ.power = dbl ? lobPower(d) : cornerShortPower(d);
  } else if (target >= 0) {
    kind = KickKind.LOB_PASS;
    reqDirTo(s, tx, tz);
    REQ.targetSlot = target;
    REQ.power = lobPower(d);
  } else {
    // A far spot outside the box: cross to the nearest point of the box.
    clampToCornerBox(s, team, tx, tz, PT);
    tx = PT.x; tz = PT.z;
    kind = KickKind.CROSS;
    if (dbl) REQ.flags |= ReqFlag.LOFTED;
    fillCross(s, tx, tz, -1);
    REQ.power = cornerCrossPower(Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z)));
  }
  const pw = f.power;
  if (pw > 0 && pw === pw) REQ.power = clamp(pw / UNIT_SCALE, 0, 1);
  setAim(s, tx, tz);
  startTakerKick(s, slot, kind, ev);
  return 1;
}

/**
 * Landing point of a swipe from the ball along (ux, uz) (unit) into PT: the point of the swipe line inside the aim
 * region nearest the reticle; a line that misses the region gives its point nearest the reticle, clamped into it.
 * Returns 0 if the swipe points away from the box (ignored).
 */
function swipeLanding(s: SimState, ux: number, uz: number): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const e = attackDir(s, team);
  const T = LOCAL_TUNING;
  // Aim region as an x / z interval (world coordinates).
  const xa = e * (HALF_LENGTH - (PENALTY_AREA_DEPTH - T.aimBoxMargin));
  const xb = e * (HALF_LENGTH - T.aimLineMargin);
  const xlo = xa < xb ? xa : xb, xhi = xa < xb ? xb : xa;
  const wl = PENALTY_AREA_HALF_WIDTH - T.aimBoxMargin;
  // Clip the ray (t >= 0) against the rectangle (slab method).
  let t0 = 0, t1 = 1e9;
  if (ux > 1e-9 || ux < -1e-9) {
    let ta = (xlo - r.x) / ux, tb = (xhi - r.x) / ux;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (r.x < xlo || r.x > xhi) {
    t1 = -1;
  }
  if (uz > 1e-9 || uz < -1e-9) {
    let ta = (-wl - r.z) / uz, tb = (wl - r.z) / uz;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (r.z < -wl || r.z > wl) {
    t1 = -1;
  }
  const tAim = (r.aimX - r.x) * ux + (r.aimZ - r.z) * uz;
  if (t0 <= t1) {
    const t = clamp(tAim, t0, t1);
    PT.x = r.x + ux * t;
    PT.z = r.z + uz * t;
    clampToCornerBox(s, team, PT.x, PT.z, PT); // rounding only
    return 1;
  }
  // The line misses the box: only a swipe toward the box's side of the ball counts.
  const cx = e * (HALF_LENGTH - PENALTY_AREA_DEPTH * 0.5) - r.x, cz = -r.z;
  if (ux * cx + uz * cz <= 0) return 0;
  const t = tAim > 0 ? tAim : 0;
  clampToCornerBox(s, team, r.x + ux * t, r.z + uz * t, PT);
  return 1;
}

/**
 * SWIPE / CURVED_SWIPE from the ball by the taker's controller: cross along the swipe, gPower = height, gCurve = curl.
 * Returns 1 if used, 0 if ignored (not from the ball, or pointing away from the box).
 */
function swipeKick(s: SimState, c: Readonly<{ kind: ControllerKind; assist: AssistLevel }>, slot: number,
  f: Readonly<InputFrame>, ev: EventSink): number {
  if ((f.gFlags & GestureFlag.FROM_BALL) === 0) return 0;
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const T = LOCAL_TUNING;
  const gx = f.gx / GESTURE_POS_SCALE, gz = f.gz / GESTURE_POS_SCALE;
  if (gx === gx && gz === gz && inAttackedBox(s, team, gx, gz, 0)) {
    clampToCornerBox(s, team, gx, gz, PT); // the swipe ended (or targets) inside the box: land there
  } else {
    let ux = f.gdx / AXIS_SCALE, uz = f.gdz / AXIS_SCALE;
    if (!(ux === ux && uz === uz)) return 0;
    let d = Math.sqrt(ux * ux + uz * uz);
    if (d < 1e-6) { ux = r.aimX - r.x; uz = r.aimZ - r.z; d = Math.sqrt(ux * ux + uz * uz); }
    if (d < 1e-6) return 0;
    if (swipeLanding(s, ux / d, uz / d) === 0) return 0;
  }
  const tx = PT.x, tz = PT.z;
  let h = f.gPower / UNIT_SCALE;
  h = h === h ? clamp(h, 0, 1) : 0;
  const kind = h < T.groundCrossMax ? KickKind.GROUND_CROSS : h < T.lowCrossMax ? KickKind.LOW_CROSS : KickKind.CROSS;
  resetReq(c.assist, ReqFlag.GESTURE | (c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0) |
    (h >= T.highCrossMin ? ReqFlag.LOFTED : 0));
  fillCross(s, tx, tz, -1);
  REQ.power = h;
  let cv = f.gCurve / AXIS_SCALE;
  cv = cv === cv ? clamp(cv, -1, 1) : 0;
  REQ.curve = cv;
  setAim(s, tx, tz);
  r.aimCurve = cv;
  r.aimPower = h;
  startTakerKick(s, slot, kind, ev);
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
export function cornerSetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.CORNER) return;
  const team = r.team === 1 ? 1 : 0;
  const b = s.ball;
  const side = r.z < 0 ? -1 : r.z > 0 ? 1 : b.crossZ < 0 ? -1 : 1;
  // A legal spot in the arc is kept as awarded; anything else (the flag itself, on a line, outside the arc) goes on
  // the canonical spot.
  if (isCornerSpot(s, team, side, r.x, r.z)) { LOOK.x = r.x; LOOK.z = r.z; } else cornerSpot(s, team, side, LOOK);
  r.x = LOOK.x;
  r.z = LOOK.z;
  r.side = side;
  placeBall(s, LOOK.x, LOOK.z, ev);
  cornerZone(s, team, side, 0, LOOK); // penalty-spot area
  setAim(s, LOOK.x, LOOK.z);
  r.aimPower = 0;
  r.aimCurve = 0;
  r.taker = pickCornerTaker(s, team);
}

/** Per tick while the phase is active. */
export function cornerTick(s: SimState, ev: EventSink): void {
  if (!cornerLive(s)) return;
  const r = s.match.restart;
  // The reticle always lies in the box (re-seeded when something else wrote it, e.g. an adopted phase).
  if (clampAimInPlace(s) === 0) {
    cornerZone(s, r.team, cornerSide(s), 0, LOOK);
    setAim(s, LOOK.x, LOOK.z);
  }
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
      const behind = RESTART_TUNING.takerBehind;
      const dx = r.x - ux * behind - p.x, dz = r.z - uz * behind - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const step = LOCAL_TUNING.lineUpStep;
      if (d <= step) { p.x += dx; p.z += dz; } else if (d > 1e-9) { p.x += (dx / d) * step; p.z += (dz / d) * step; }
      // Never closer to the ball than his spot (the slide follows the circle around it, not the chord).
      const bx = p.x - r.x, bz = p.z - r.z;
      const bd = Math.sqrt(bx * bx + bz * bz);
      if (bd > 1e-6 && bd < behind) { p.x = r.x + (bx / bd) * behind; p.z = r.z + (bz / bd) * behind; }
    }
  } else if (p.actCharging === 1 && p.act === ActionKind.KICK) {
    r.aimPower = clamp(p.actPower, 0, 1);
  }
  // A side without a human: the CPU brain (TAI-13) normally takes it after cpuRestartDelay; fall back to the Default.
  if (!teamHasHuman(s, r.team)) {
    const waited = r.t - T_RULES.restartSetupTicks;
    const due = T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks;
    if (waited >= due && (waited - due) % LOCAL_TUNING.cpuRetryTicks === 0) takeDefault(s, ev);
  }
}

/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function cornerInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  if (!cornerLive(s)) return;
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
  const cmd = f.cmd;
  if (cmd >= Command.CORNER_FAR_POST && cmd <= Command.CORNER_NEAR_POST) {
    // TAI-14 applied the tactic earlier this tick: show its zone (penalty-spot area when toggled off).
    cornerZone(s, r.team, cornerSide(s), s.teams[r.team === 1 ? 1 : 0]!.cornerTactic, LOOK);
    setAim(s, LOOK.x, LOOK.z);
  }
  moveReticle(s, f);
  const g = f.gesture;
  if (g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) {
    if (tapKick(s, c, t, f, ev) === 1) return;
  } else if (g === GestureKind.SWIPE || g === GestureKind.CURVED_SWIPE) {
    if (swipeKick(s, c, t, f, ev) === 1) return;
  }
  const pressed = c.buttons & ~c.prevButtons;
  if ((pressed & Btn.LOB) !== 0) crossToReticle(s, c, t, f, ev);
  else if ((pressed & Btn.PASS) !== 0) shortCorner(s, c, t, f, ev);
}

/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function cornerDefault(s: SimState, ev: EventSink): void {
  takeDefault(s, ev);
}

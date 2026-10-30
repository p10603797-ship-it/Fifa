/**
 * [RUL-11] Restart safety and the common restart flow: awardRestart (fills s.match.restart, emits
 * RESTART_AWARDED, calls the kind's Setup, sets the phase), restartTick (setup delay T_RULES.restartSetupTicks,
 * then legal positions for every player — opponents >= 9.15 m / 2 m at throw-ins, kick-off halves — by
 * teleporting anyone not there in time; ready flag; timeout default for humans after 12 s; CPU takes after
 * T_RULES.cpuRestartDelay), never two restarts queued, never the wrong team, taker always valid (re-pick if sent
 * off / substituted). SET_PIECE action handler (taker waiting). SETPIECE_INPUT routes controller frames by kind.
 *
 * Flow (all deterministic, allocation-free per tick; module scratch objects only):
 *  - awardRestart(kind, team, x, z): refused while a restart is pending (restart phase, not taken) or while an award
 *    is in progress (a Setup calling back), or when the phase may not go to the kind's phase (contracts/transitions;
 *    a taken restart goes through IN_PLAY first). The spot is made legal for the kind and team: kick-off (0,0),
 *    penalty spot of the attacked goal, throw-in on the touchline, goal kick in the own goal area, corner in the arc
 *    of the attacked end, free kick inside the pitch (attackers never inside the opponents' goal area). A corner /
 *    goal kick / penalty whose spot is clearly at the wrong end for that team is a wrong-team award: refused and
 *    logged (WATCHDOG OTHER) — the ball stays out of play and the watchdog awards the right restart from the last
 *    touch. Then: an active advantage is resolved as played on (ADVANTAGE a=0, pending card shown via RUL-09
 *    showCard; RUL-09 clears advantage itself before a bring-back award), offside flags cleared, restart filled
 *    (t = ready = taken = 0, timeoutT, wall cleared, aim on the ball), ball still on the spot (possession, hands,
 *    shot and pass target cleared), every action interrupted except falls (STUMBLE / FALLEN / GET_UP finish),
 *    RESTART_AWARDED + WHISTLE(SHORT) (no whistle for a kick-off: RUL-01 blows START), the kind's Setup (RUL-01
 *    setupKickOff for KICK_OFF), the Setup's ball position adopted as the spot (not for kick-off / penalty), a taker
 *    picked if the Setup left none, setPhase(kind phase).
 *  - restartTick (RUL-01 calls it first in every restart phase): t++; taker re-picked whenever invalid (inactive,
 *    other team, keeper at a throw-in); ball re-placed on the spot whenever it strays, moves, rises, goes out of play
 *    or is owned by anyone but the taker (the throw-in taker holding it is RUL-02's). [QF-10] Walked set-ups
 *    (isWalkedSetup: throw-ins and free kicks further than cutFreeKickGoalDist from the attacked goal, which GFX-15
 *    shows on the main camera): from the award the free-kick taker runs to his spot in SET_PIECE (RUL-02 walks the
 *    throw-in taker) and every illegal player walks out (his velocity away from his nearest legal spot raised to
 *    setupWalkSpeed); ready once the taker is in place (holding the ball at a throw-in) and everyone is legal, at the
 *    earliest at restartSetupTicks and at the latest setupStragglerMaxTicks later, or setupExtendMaxTicks later while the
 *    taker is still running in ([QF-10 skeptic] takerRunningIn) (restart.t is then set back to
 *    restartSetupTicks, so "ticks past ready" readings keep their meaning). Other set-ups (camera cut) at
 *    t = restartSetupTicks. At ready: legalizePositions (teleports whoever is still not there: with a camera cut,
 *    D-008, or a walked straggler at the cap), taker into SET_PIECE (THROW_IN for
 *    throw-ins), ready = 1, timeoutT = 12 s (human side) or 4 s (CPU side). While ready: taker kept on his spot and in
 *    his waiting action; illegal players are pushed toward the nearest legal spot (a slide of at most pushMaxStep per
 *    tick with their velocity away from it removed, so nobody blocks for more than ~1 s and no mid-view teleport is
 *    needed); timeout -> the kind's Default (CPU side: logged WATCHDOG RESTART_BLOCKED; [FIN-K] held at its last tick
 *    while a newly chosen free-kick taker is still running in, never placing him); if still not taken
 *    defaultGraceTicks later -> forceRestartKick (logged).
 *  - Legal positions: everybody but the taker inside the pitch; kick-off: own half for all, opponents outside the
 *    centre circle; throw-in / corner / free kick: opponents >= 2 / 9.15 / 9.15 m from the ball; goal kick: opponents
 *    outside the kicking team's penalty area and >= 9.15 m; free kick in the kicking team's own penalty area:
 *    opponents also outside that area; free kick less than 9.15 m from goal: defenders may stand on their goal line
 *    between the posts; penalty: all but the taker and the defending keeper outside the area and the arc, the keeper
 *    on his line between the posts.
 *
 * Helper module: restartCommon.ts (leaf; SET_PIECE handler, phase/kind tables, logWatchdog).
 */
export { setPieceHandler } from './restartCommon';
import {
  BALL_RADIUS, CENTRE_CIRCLE_RADIUS, CORNER_ARC_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH,
  HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_ARC_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
  PENALTY_SPOT_DIST, PLAYERS_PER_TEAM, POST_RADIUS, RESTART_DISTANCE, THROW_IN_DISTANCE, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, CardKind, KickKind, MatchPhase, RestartKind, WatchdogReason } from '../../contracts/enums';
import { EventType, WhistleKind, type EventSink } from '../../contracts/events';
import type { PlayerState, SimState } from '../../contracts/state';
import { createKickLaunch, type SetPieceInputFn } from '../../contracts/systems';
import { isLegalTransition } from '../../contracts/transitions';
import { T_BALL, T_PASS, T_PLAYER, T_RULES, T_RESTART, T_RESTART_COMMON } from '../../contracts/tuning';
import { beginAction, endAction } from '../actions/dispatch';
import { NULL_SINK } from '../core/events';
import { applyKick, releasePossession } from '../core/kick';
import { dcos, dsin } from '../core/dmath';
import { teamHasHuman } from '../core/query';
import { rngInt } from '../core/rng';
import { bodyRadiusOf } from '../players/bodies';
import { kickOffDefault, kickOffInput, setPhase, setupKickOff } from './machine';
import { throwInDefault, throwInInput, throwInSetup } from './throwin';
import { goalKickDefault, goalKickInput, goalKickSetup } from './goalkick';
import { cornerDefault, cornerInput, cornerSetup } from './corner';
import { freeKickDefault, freeKickInput, freeKickSetup } from './freekick';
import { penaltyDefault, penaltyInput, penaltySetup } from './penalty';
import { showCard } from './fouls';
import {
  KIND_PHASE, PHASE_KIND, isRestartPhase, logWatchdog, restartForward, restartLookPoint, restartPending, takerRunning,
} from './restartCommon';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_RESTART. */
export const LOCAL_TUNING = T_RESTART;

export { isRestartPhase, isRestartTaker, restartPending, restartForward, restartLookPoint } from './restartCommon';


// ---------------------------------------------------------------- module scratch (no allocation per tick)

const SPOT = { x: 0, z: 0 };
const SPOT2 = { x: 0, z: 0 };
const CAND = { x: 0, z: 0 };
const FWD = { x: 0, z: 0 };
const LOOK = { x: 0, z: 0 };
const LAUNCH = createKickLaunch();
/** 1 while awardRestart runs (a Setup calling awardRestart again is ignored: never two restarts queued). */
let awarding = 0;

/** Legality context of the current restart (filled by buildCtx). */
const ctx = {
  kind: RestartKind.NONE as RestartKind,
  team: 0,
  taker: -1,
  /** Centre of the exclusion disc (ball, or the thrower's hands). */
  cx: 0,
  cz: 0,
  /** Exclusion radius, m. */
  r: 0,
  /** End (+-1) of a penalty area opponents (everyone at a penalty) must stay out of, 0 = none. */
  paEnd: 0,
  /** Free kick near goal: end (+-1) whose goal line between the posts is legal for defenders, 0 = none. */
  goalLineEnd: 0,
  /** Penalty: the defending keeper (on his line), -1 = none; x of that goal line. */
  defKeeper: -1,
  keeperLineX: 0,
  /** [QF-10] 1 when the whole body must be clear of the area and the arc (penalty): judged with the body radius. */
  bodyClear: 0,
};

/** Unit directions for the ring search of legal spots (built once at module load, deterministic dmath). */
const RING_N = 16;
const RING_X = new Float64Array(RING_N);
const RING_Z = new Float64Array(RING_N);
for (let i = 0; i < RING_N; i++) {
  const a = (i * 2 * Math.PI) / RING_N;
  RING_X[i] = dcos(a);
  RING_Z[i] = dsin(a);
}
const RING_RADII_EXTRA: readonly number[] = [0, 3, 8, 14, 22];

// ---------------------------------------------------------------- small helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, d: number): number {
  return v - v === 0 ? v : d;
}

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

/** Inside the field of play (lines included). */
function inField(x: number, z: number): boolean {
  return x >= -HALF_LENGTH && x <= HALF_LENGTH && z >= -HALF_WIDTH && z <= HALF_WIDTH;
}

/** Inside the penalty area of `end` (+-1), goal line to the 16.5 m line. */
function inPenaltyArea(x: number, z: number, end: number): boolean {
  const ex = end * x;
  return ex >= HALF_LENGTH - PENALTY_AREA_DEPTH && ex <= HALF_LENGTH && z >= -PENALTY_AREA_HALF_WIDTH &&
    z <= PENALTY_AREA_HALF_WIDTH;
}

/** Inside the goal area of `end` (+-1). */
function inGoalArea(x: number, z: number, end: number): boolean {
  const ex = end * x;
  return ex >= HALF_LENGTH - GOAL_AREA_DEPTH && ex <= HALF_LENGTH && z >= -GOAL_AREA_HALF_WIDTH && z <= GOAL_AREA_HALF_WIDTH;
}

function isDownAct(act: ActionKind): boolean {
  return act === ActionKind.STUMBLE || act === ActionKind.FALLEN || act === ActionKind.GET_UP;
}

function isDown(p: Readonly<PlayerState>): boolean {
  return isDownAct(p.act) || p.stunT > 0;
}

/** Waiting states of a taker (anything else means he is kicking or down: leave him alone). */
function isWaitingAct(act: ActionKind): boolean {
  return act === ActionKind.NONE || act === ActionKind.SET_PIECE || act === ActionKind.THROW_IN;
}

function placePlayer(s: SimState, slot: number, x: number, z: number, lookX: number, lookZ: number): void {
  const p = s.players[slot]!;
  p.x = x;
  p.z = z;
  p.vx = 0;
  p.vz = 0;
  const dx = lookX - x;
  const dz = lookZ - z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-6) { p.fx = dx / d; p.fz = dz / d; }
}

/** Ball at rest on the ground at (x, z); possession and hands released. Not a contact (no touch recorded). */
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

// ---------------------------------------------------------------- spot, taker

/**
 * Legal spot for a restart of `kind` for `team` near (x, z), written to `out`. Returns 0 when the spot is clearly at
 * the wrong end for that team (a corner at its own end, a goal kick or penalty at the end it attacks).
 */
export function restartSpot(s: SimState, kind: RestartKind, team: number, x: number, z: number, out: { x: number; z: number }): number {
  const dir = s.teams[team === 1 ? 1 : 0]!.dir;
  x = finiteOr(x, 0);
  z = finiteOr(z, 0);
  const sz = z < 0 ? -1 : 1;
  const wrongEnd = HALF_LENGTH * 0.5;
  switch (kind) {
    case RestartKind.KICK_OFF:
      out.x = 0; out.z = 0;
      return 1;
    case RestartKind.PENALTY:
      if (dir * x < -wrongEnd) return 0;
      out.x = dir * (HALF_LENGTH - PENALTY_SPOT_DIST); out.z = 0;
      return 1;
    case RestartKind.THROW_IN:
      out.x = clamp(x, -HALF_LENGTH, HALF_LENGTH); out.z = sz * HALF_WIDTH;
      return 1;
    case RestartKind.GOAL_KICK: {
      const e = -dir;
      if (e * x < -wrongEnd) return 0;
      if (inGoalArea(x, z, e)) { out.x = x; out.z = z; return 1; }
      out.x = e * (HALF_LENGTH - GOAL_AREA_DEPTH);
      out.z = sz * clamp(z < 0 ? -z : z, 0, GOAL_AREA_HALF_WIDTH);
      return 1;
    }
    case RestartKind.CORNER: {
      const e = dir;
      if (e * x < -wrongEnd) return 0;
      const dx = x - e * HALF_LENGTH;
      const dz = z - sz * HALF_WIDTH;
      if (inField(x, z) && dx * dx + dz * dz <= CORNER_ARC_RADIUS * CORNER_ARC_RADIUS) { out.x = x; out.z = z; return 1; }
      const inset = CORNER_ARC_RADIUS * 0.5;
      out.x = e * (HALF_LENGTH - inset); out.z = sz * (HALF_WIDTH - inset);
      return 1;
    }
    case RestartKind.FREE_KICK: {
      let fx = clamp(x, -HALF_LENGTH, HALF_LENGTH);
      const fz = clamp(z, -HALF_WIDTH, HALF_WIDTH);
      if (inGoalArea(fx, fz, dir)) fx = dir * (HALF_LENGTH - GOAL_AREA_DEPTH);
      out.x = fx; out.z = fz;
      return 1;
    }
    default:
      return 0;
  }
}

/** True if `slot` may take the current restart (active, right team; never the keeper at a throw-in). */
export function isValidTaker(s: SimState, slot: number): boolean {
  if (slot < 0 || slot >= NUM_SLOTS) return false;
  const r = s.match.restart;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.team !== r.team) return false;
  return !(r.kind === RestartKind.THROW_IN && p.isKeeper === 1);
}

/**
 * Pick a taker for the current restart (fallback when the kind's Setup chose none or he became invalid): goal kick
 * -> the keeper; penalty -> best finishing + composure; otherwise the nearest outfield player to the spot (the keeper
 * also for a free kick in his own area). Players who are down are avoided when possible. -1 if nobody is available.
 */
export function pickRestartTaker(s: SimState, exclude: number): number {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = s.teams[team]!.dir;
  const first = teamFirstSlot(team);
  const keeperOk = r.kind === RestartKind.GOAL_KICK ||
    (r.kind === RestartKind.FREE_KICK && inPenaltyArea(r.x, r.z, -dir));
  for (let pass = 0; pass < 2; pass++) {
    if (r.kind === RestartKind.GOAL_KICK) {
      const k = s.teams[team]!.keeperSlot;
      if (k !== exclude && isValidTaker(s, k) && s.players[k]!.isKeeper === 1 && (pass === 1 || !isDown(s.players[k]!))) return k;
    }
    let best = -1;
    let bestScore = -1e18;
    for (let slot = first; slot < first + PLAYERS_PER_TEAM; slot++) {
      if (slot === exclude || !isValidTaker(s, slot)) continue;
      const p = s.players[slot]!;
      if (pass === 0 && (isDown(p) || (p.isKeeper === 1 && !keeperOk))) continue;
      let score: number;
      if (r.kind === RestartKind.PENALTY) {
        const a = s.attrs[slot]!;
        score = a.finishing + a.composure - (p.isKeeper === 1 ? 1000 : 0);
      } else {
        const dx = p.x - r.x, dz = p.z - r.z;
        score = -(dx * dx + dz * dz);
      }
      if (score > bestScore) { bestScore = score; best = slot; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Where the taker stands for the current restart: behind the ball, or just outside the touchline at a throw-in. */
export function restartTakerSpot(s: SimState, out: { x: number; z: number }): void {
  const r = s.match.restart;
  if (r.kind === RestartKind.THROW_IN) {
    out.x = clamp(r.x, -HALF_LENGTH, HALF_LENGTH);
    out.z = (r.z < 0 ? -1 : 1) * (HALF_WIDTH + T_RESTART.throwInTakerOut);
    return;
  }
  restartForward(s, FWD);
  out.x = r.x - FWD.x * T_RESTART.takerBehind;
  out.z = r.z - FWD.z * T_RESTART.takerBehind;
}

/** Taker close enough to take: within reach of the spot (throw-in: within the leash of his spot by the line). */
function takerInPlace(s: SimState, slot: number): boolean {
  const r = s.match.restart;
  const p = s.players[slot]!;
  if (r.kind === RestartKind.THROW_IN) {
    restartTakerSpot(s, CAND);
    const dx = p.x - CAND.x, dz = p.z - CAND.z;
    const l = T_RESTART.throwInLeash;
    return dx * dx + dz * dz <= l * l;
  }
  if (r.kind === RestartKind.KICK_OFF && s.teams[p.team]!.dir * p.x > 0) return false; // own half at a kick-off
  const dx = p.x - r.x, dz = p.z - r.z;
  const reach = T_RESTART.takerReach;
  return dx * dx + dz * dz <= reach * reach;
}

function placeTakerOnSpot(s: SimState, slot: number): void {
  restartTakerSpot(s, CAND);
  restartLookPoint(s, LOOK);
  placePlayer(s, slot, CAND.x, CAND.z, LOOK.x, LOOK.z);
}

function beginTakerAction(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  if (s.match.restart.kind === RestartKind.THROW_IN) {
    beginAction(p, ActionKind.THROW_IN, T_RULES.phaseMaxTicks[MatchPhase.THROW_IN]! + T_RESTART_COMMON.setPieceWaitTicks, -1);
  } else {
    beginAction(p, ActionKind.SET_PIECE, T_RESTART_COMMON.setPieceWaitTicks, -1);
    p.actA = 0;
  }
}

/** Ready and waiting: taker on his spot and in his waiting action (never while he is kicking or down). [QF-10] A taker
 *  chosen at a free kick runs there (restartCommon takerRunning) and is placed only if the run overruns. */
function settleTaker(s: SimState): void {
  const r = s.match.restart;
  const t = r.taker;
  if (t < 0) return;
  const p = s.players[t]!;
  if (!isWaitingAct(p.act)) return;
  if (!takerInPlace(s, t) && !takerRunning(p)) placeTakerOnSpot(s, t);
  if (p.act === ActionKind.NONE) beginTakerAction(s, t);
}

/**
 * Make the restart taker free to start his kick (ends his SET_PIECE wait). Set-piece inputs and Defaults call this
 * right before startPass / startLob / startShot (starters need isFree). Returns 1 if `slot` is the waiting taker and
 * is now free; if the start is refused, restartTick puts him back into SET_PIECE next tick.
 */
export function prepareTakerKick(s: SimState, slot: number): number {
  const r = s.match.restart;
  if (!isRestartPhase(s.match.phase) || r.taken === 1 || slot < 0 || slot !== r.taker) return 0;
  const p = s.players[slot]!;
  // [FIN-K] Still running in after "choose the taker": not free yet (no kick from afar, and no teleport onto his spot:
  // the Default / CPU fallback retries, RUL-11's timeout waits for him).
  if (takerRunning(p)) return 0;
  if (p.act === ActionKind.SET_PIECE) endAction(s, slot, 0);
  return p.act === ActionKind.NONE ? 1 : 0;
}

// ---------------------------------------------------------------- legality

function buildCtx(s: SimState): void {
  const r = s.match.restart;
  const b = s.ball;
  const team = r.team === 1 ? 1 : 0;
  const dir = s.teams[team]!.dir;
  ctx.kind = r.kind;
  ctx.team = team;
  ctx.taker = r.taker;
  ctx.cx = r.x;
  ctx.cz = r.z;
  if (r.kind === RestartKind.THROW_IN && r.taker >= 0 && b.owner === r.taker) { ctx.cx = b.x; ctx.cz = b.z; }
  ctx.r = r.kind === RestartKind.THROW_IN ? THROW_IN_DISTANCE
    : r.kind === RestartKind.KICK_OFF ? CENTRE_CIRCLE_RADIUS
      : r.kind === RestartKind.PENALTY ? PENALTY_ARC_RADIUS : RESTART_DISTANCE;
  ctx.paEnd = 0;
  ctx.goalLineEnd = 0;
  ctx.defKeeper = -1;
  ctx.keeperLineX = 0;
  ctx.bodyClear = r.kind === RestartKind.PENALTY ? 1 : 0;
  if (r.kind === RestartKind.GOAL_KICK) {
    ctx.paEnd = -dir;
  } else if (r.kind === RestartKind.FREE_KICK) {
    if (inPenaltyArea(r.x, r.z, -dir)) ctx.paEnd = -dir;
    if (HALF_LENGTH - dir * r.x < RESTART_DISTANCE) ctx.goalLineEnd = dir;
  } else if (r.kind === RestartKind.PENALTY) {
    ctx.paEnd = dir;
    const k = s.teams[other(team)]!.keeperSlot;
    if (k >= 0 && k < NUM_SLOTS && s.players[k]!.active === 1 && s.players[k]!.isKeeper === 1) {
      ctx.defKeeper = k;
      ctx.keeperLineX = dir * HALF_LENGTH;
    }
  }
}

function onGoalLine(x: number, z: number, end: number): boolean {
  const dx = x - end * HALF_LENGTH;
  return dx >= -T_RESTART.goalLineSlack && dx <= T_RESTART.goalLineSlack && z >= -GOAL_HALF_WIDTH && z <= GOAL_HALF_WIDTH;
}

/**
 * Point under test for the legality checks. The hot path passes it through this module object instead of call
 * arguments: V8 boxes doubles passed to (or returned from) functions it does not inline, which would allocate
 * per player per tick.
 */
const PT = { x: 0, z: 0 };

/** [QF-10] Goal-frame clearance of outfield bodies (see ptInGoalFrame), m. */
const FRAME_FRONT = HALF_LENGTH - T_PLAYER.bodyRadius;
const FRAME_SIDE = GOAL_HALF_WIDTH + POST_RADIUS + T_PLAYER.bodyRadius;

function ptInField(): boolean {
  const x = PT.x, z = PT.z;
  return x >= -HALF_LENGTH && x <= HALF_LENGTH && z >= -HALF_WIDTH && z <= HALF_WIDTH;
}

/**
 * [QF-10] PT where an outfield body would overlap a goal frame: within FRAME_FRONT of a goal line and within FRAME_SIDE
 * of the goal's centre line (SIM-04/05 keep outfield bodies a body radius in front of the goal line; a legal spot there
 * was a body pushed into the post or net, e.g. a player behind the goal line placed at 0.3 m inside the pitch).
 */
function ptInGoalFrame(): boolean {
  const ax = PT.x < 0 ? -PT.x : PT.x, az = PT.z < 0 ? -PT.z : PT.z;
  return ax > FRAME_FRONT && az < FRAME_SIDE;
}

/** PT inside the penalty area of `end`, the area grown by `grow` m on its pitch sides (a body of that radius touching it). */
function ptInArea(end: number, grow: number): boolean {
  const ex = end * PT.x, z = PT.z;
  return ex >= HALF_LENGTH - PENALTY_AREA_DEPTH - grow && ex <= HALF_LENGTH && z >= -PENALTY_AREA_HALF_WIDTH - grow &&
    z <= PENALTY_AREA_HALF_WIDTH + grow;
}

/** Body radius counted for slot's legality (ctx must be built): his SIM-05 radius when the body must be clear, else 0. */
function clearRadius(s: SimState, slot: number): number {
  return ctx.bodyClear === 1 ? bodyRadiusOf(s, slot) : 0;
}

function ptOnGoalLine(end: number): boolean {
  const dx = PT.x - end * HALF_LENGTH, z = PT.z;
  return dx >= -T_RESTART.goalLineSlack && dx <= T_RESTART.goalLineSlack && z >= -GOAL_HALF_WIDTH && z <= GOAL_HALF_WIDTH;
}

/** Is PT a legal position for `slot` in the current restart (ctx must be built)? The taker is always legal. */
function legalPt(s: SimState, slot: number): boolean {
  if (slot === ctx.taker) return true;
  const x = PT.x, z = PT.z;
  if (slot === ctx.defKeeper) {
    const dx = x - ctx.keeperLineX;
    return dx >= -T_RESTART.keeperLineSlack && dx <= T_RESTART.keeperLineSlack && z >= -GOAL_HALF_WIDTH &&
      z <= GOAL_HALF_WIDTH && ptInField();
  }
  if (!ptInField()) return false;
  const p = s.players[slot]!;
  if (p.isKeeper !== 1 && ptInGoalFrame()) return false;
  const opp = p.team !== ctx.team;
  const dx = x - ctx.cx, dz = z - ctx.cz;
  const br = clearRadius(s, slot);
  const rr = ctx.r + br - T_RESTART.legalSlack;
  const inDisc = dx * dx + dz * dz < rr * rr;
  switch (ctx.kind) {
    case RestartKind.KICK_OFF:
      if (s.teams[p.team]!.dir * x > 0) return false;
      return !(opp && inDisc);
    case RestartKind.PENALTY:
      // [QF-10] Outside the area and the arc with the whole body (a centre on the line leaves half of him inside).
      return !inDisc && !ptInArea(ctx.paEnd, br > T_RESTART.legalSlack ? br - T_RESTART.legalSlack : 0);
    case RestartKind.GOAL_KICK:
      return !opp || (!inDisc && !ptInArea(ctx.paEnd, 0));
    case RestartKind.FREE_KICK:
      if (!opp) return true;
      if (ctx.paEnd !== 0 && ptInArea(ctx.paEnd, 0)) return false;
      if (!inDisc) return true;
      return ctx.goalLineEnd !== 0 && ptOnGoalLine(ctx.goalLineEnd);
    default: // THROW_IN, CORNER
      return !(opp && inDisc);
  }
}

/** Is (x, z) legal for `slot` (search paths; ctx must be built)? */
function legalFor(s: SimState, slot: number, x: number, z: number): boolean {
  PT.x = x;
  PT.z = z;
  return legalPt(s, slot);
}

/** Is `slot` legal where he stands (per-tick path; ctx must be built)? */
function legalNow(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  PT.x = p.x;
  PT.z = p.z;
  return legalPt(s, slot);
}

/** Does the exclusion disc apply to this player (ctx must be built)? */
function discApplies(s: SimState, slot: number): boolean {
  if (ctx.kind === RestartKind.PENALTY) return true;
  return s.players[slot]!.team !== ctx.team;
}

/** Does the penalty-area exclusion apply to this player? */
function areaApplies(s: SimState, slot: number): boolean {
  if (ctx.paEnd === 0) return false;
  if (ctx.kind === RestartKind.PENALTY) return true;
  return s.players[slot]!.team !== ctx.team;
}

function distSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

/**
 * Nearest legal position for `slot` from where he stands, written to `out` (ctx must be built): iterated projections onto
 * the constraints (pitch, kick-off half, exclusion disc, penalty area), the goal line between the posts where that is
 * legal, and a ring search around the ball as a guaranteed fallback.
 */
function nearestLegal(s: SimState, slot: number, out: { x: number; z: number }): void {
  const br = clearRadius(s, slot);
  const m = T_RESTART.placeMargin + br;
  const p = s.players[slot]!;
  const x = p.x, z = p.z;
  const pdir = s.teams[p.team]!.dir;
  if (slot === ctx.defKeeper) {
    out.x = ctx.keeperLineX - (ctx.keeperLineX > 0 ? 1 : -1) * T_RESTART.lineInset;
    out.z = clamp(z, -GOAL_HALF_WIDTH + m, GOAL_HALF_WIDTH - m);
    return;
  }
  let bestD = 1e18;
  let bx = x, bz = z;
  // 1. projections
  let px = x, pz = z;
  for (let it = 0; it < 3; it++) {
    if (px < -HALF_LENGTH) px = -HALF_LENGTH + m; else if (px > HALF_LENGTH) px = HALF_LENGTH - m;
    if (pz < -HALF_WIDTH) pz = -HALF_WIDTH + m; else if (pz > HALF_WIDTH) pz = HALF_WIDTH - m;
    PT.x = px; PT.z = pz;
    if (p.isKeeper !== 1 && ptInGoalFrame()) px = (px < 0 ? -1 : 1) * (FRAME_FRONT - T_RESTART.placeMargin);
    if (ctx.kind === RestartKind.KICK_OFF && pdir * px > 0) px = -pdir * m;
    if (discApplies(s, slot) && !(ctx.goalLineEnd !== 0 && onGoalLine(px, pz, ctx.goalLineEnd))) {
      const dx = px - ctx.cx, dz = pz - ctx.cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < ctx.r - T_RESTART.legalSlack) {
        let ux = -pdir, uz = 0; // toward his own goal when standing on the ball
        if (d > 1e-6) { ux = dx / d; uz = dz / d; }
        px = ctx.cx + ux * (ctx.r + m);
        pz = ctx.cz + uz * (ctx.r + m);
      }
    }
    PT.x = px; PT.z = pz;
    if (areaApplies(s, slot) && ptInArea(ctx.paEnd, br)) {
      const e = ctx.paEnd;
      const frontX = e * (HALF_LENGTH - PENALTY_AREA_DEPTH - m);
      const sideZ = (pz < 0 ? -1 : 1) * (PENALTY_AREA_HALF_WIDTH + m);
      const dFront = (px - frontX) * (px - frontX);
      const dSide = (pz - sideZ) * (pz - sideZ);
      if (dFront <= dSide) px = frontX; else pz = sideZ;
    }
    if (legalFor(s, slot, px, pz)) break;
  }
  if (legalFor(s, slot, px, pz)) { bestD = distSq(px, pz, x, z); bx = px; bz = pz; }
  // 2. on the goal line between the posts (free kick near goal, defenders)
  if (ctx.goalLineEnd !== 0 && discApplies(s, slot)) {
    const gx = ctx.goalLineEnd * (HALF_LENGTH - T_RESTART.goalLineInset);
    const gz = clamp(z, -GOAL_HALF_WIDTH + m, GOAL_HALF_WIDTH - m);
    const d = distSq(gx, gz, x, z);
    if (d < bestD && legalFor(s, slot, gx, gz)) { bestD = d; bx = gx; bz = gz; }
  }
  // 3. ring search around the ball (always finds a legal spot for every restart geometry)
  if (bestD >= 1e18) {
    for (let k = 0; k < RING_RADII_EXTRA.length; k++) {
      const rad = ctx.r + m + RING_RADII_EXTRA[k]!;
      for (let i = 0; i < RING_N; i++) {
        const cx = clamp(ctx.cx + RING_X[i]! * rad, -HALF_LENGTH + m, HALF_LENGTH - m);
        const cz = clamp(ctx.cz + RING_Z[i]! * rad, -HALF_WIDTH + m, HALF_WIDTH - m);
        if (!legalFor(s, slot, cx, cz)) continue;
        const d = distSq(cx, cz, x, z);
        if (d < bestD) { bestD = d; bx = cx; bz = cz; }
      }
      if (bestD < 1e18) break;
    }
  }
  if (bestD >= 1e18) { // unreachable in practice: deep in his own half
    bx = -pdir * (HALF_LENGTH * 0.5);
    bz = 0;
  }
  out.x = bx;
  out.z = bz;
}

/** True if no other active player stands within placeSpacing of (x, z). */
function spotFree(s: SimState, slot: number, x: number, z: number): boolean {
  const sp = T_RESTART.placeSpacing;
  const sp2 = sp * sp;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    if (distSq(q.x, q.z, x, z) < sp2) return false;
  }
  return true;
}

/**
 * Move a legal spot to the nearest legal spot no other player stands on: first sideways (tangent to the ball, so the
 * player keeps his distance), then rings of growing radius around it. Stays where it is if nothing is free.
 */
function freeSpot(s: SimState, slot: number, spot: { x: number; z: number }): void {
  if (spotFree(s, slot, spot.x, spot.z)) return;
  let tx = -(spot.z - ctx.cz);
  let tz = spot.x - ctx.cx;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl < 1e-6) { tx = 0; tz = 1; } else { tx /= tl; tz /= tl; }
  const step = T_RESTART.placeSpacing;
  for (let k = 1; k <= 4; k++) {
    for (let sgn = 1; sgn >= -1; sgn -= 2) {
      const x = spot.x + tx * step * k * sgn;
      const z = spot.z + tz * step * k * sgn;
      if (legalFor(s, slot, x, z) && spotFree(s, slot, x, z)) { spot.x = x; spot.z = z; return; }
    }
  }
  for (let k = 1; k <= 8; k++) {
    for (let i = 0; i < RING_N; i++) {
      const x = spot.x + RING_X[i]! * step * k;
      const z = spot.z + RING_Z[i]! * step * k;
      if (legalFor(s, slot, x, z) && spotFree(s, slot, x, z)) { spot.x = x; spot.z = z; return; }
    }
  }
}

/** Is `slot` in a legal position for the current restart right now? (Builds the context; for tests and modules.) */
export function isLegalRestartPosition(s: SimState, slot: number): boolean {
  if (slot < 0 || slot >= NUM_SLOTS) return false;
  const r = s.match.restart;
  if (!(r.kind >= RestartKind.KICK_OFF && r.kind <= RestartKind.PENALTY)) return true;
  const p = s.players[slot]!;
  if (p.active !== 1) return true;
  buildCtx(s);
  if (slot === ctx.taker) return takerInPlace(s, slot);
  return legalNow(s, slot);
}

/** Move every player not in a legal position for the current restart to the nearest legal spot (teleport). */
export function legalizePositions(s: SimState): void {
  const r = s.match.restart;
  if (!(r.kind >= RestartKind.KICK_OFF && r.kind <= RestartKind.PENALTY)) return;
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
  buildCtx(s);
  const t = r.taker;
  if (t >= 0 && !takerInPlace(s, t)) placeTakerOnSpot(s, t);
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (slot === t) continue;
    const p = s.players[slot]!;
    if (p.active !== 1 || legalNow(s, slot)) continue;
    nearestLegal(s, slot, SPOT2);
    freeSpot(s, slot, SPOT2);
    placePlayer(s, slot, SPOT2.x, SPOT2.z, ctx.cx, ctx.cz);
  }
  if (r.taken === 0) keepBallOnSpot(s, NULL_SINK);
}

/** While ready: slide every illegal player toward his nearest legal spot (no teleport); kill velocity away from it. */
function pushOutIllegal(s: SimState): void {
  buildCtx(s);
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (slot === ctx.taker) continue;
    const p = s.players[slot]!;
    if (p.active !== 1 || legalNow(s, slot)) continue;
    nearestLegal(s, slot, SPOT2);
    const dx = SPOT2.x - p.x, dz = SPOT2.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-9) continue;
    const ux = dx / d, uz = dz / d;
    const step = clamp(d * T_RESTART.pushGain, T_RESTART.pushMinStep, T_RESTART.pushMaxStep);
    if (step >= d) { p.x = SPOT2.x; p.z = SPOT2.z; } else { p.x += ux * step; p.z += uz * step; }
    const vu = p.vx * ux + p.vz * uz;
    if (vu < 0) { p.vx -= vu * ux; p.vz -= vu * uz; }
  }
}

// ---------------------------------------------------------------- ball safety

/** Ball out of play / moved / owned by the wrong player before the restart is taken: put it back on the spot. */
function keepBallOnSpot(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  const b = s.ball;
  const t = r.taker;
  if (r.kind === RestartKind.THROW_IN && t >= 0 && b.owner === t && b.heldBy < 0) return; // RUL-02 holds it
  if (b.heldBy >= 0 || (b.owner >= 0 && b.owner !== t)) { placeBall(s, r.x, r.z, ev); return; }
  const fx = b.x - r.x, fz = b.z - r.z;
  const far = fx * fx + fz * fz > T_RESTART.replaceDist * T_RESTART.replaceDist;
  if (b.owner >= 0) { // the taker controls it (kick wind-up)
    if (far) placeBall(s, r.x, r.z, ev);
    return;
  }
  const sp2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  const rs = T_RESTART.replaceSpeed;
  if (far || sp2 > rs * rs || b.y > BALL_RADIUS + T_RESTART.replaceHeight || b.inNet !== 0) placeBall(s, r.x, r.z, ev);
}

// ---------------------------------------------------------------- award

function fillRestart(s: SimState, kind: RestartKind, team: number, x: number, z: number): void {
  const r = s.match.restart;
  r.kind = kind;
  r.team = team;
  r.x = x;
  r.z = z;
  r.taker = -1;
  r.t = 0;
  r.ready = 0;
  r.taken = 0;
  r.timeoutT = T_RULES.restartTimeoutTicks;
  r.wallCount = 0;
  for (let i = 0; i < r.wall.length; i++) r.wall[i] = -1;
  r.wallX = 0;
  r.wallZ = 0;
  r.aimX = x;
  r.aimZ = z;
  r.aimPower = 0;
  r.aimCurve = 0;
  r.side = 0;
}

/** An advantage still running when play stops is over: played on, pending card shown (as RUL-01 does at goals). */
function resolveAdvantage(s: SimState, ev: EventSink): void {
  const a = s.match.advantage;
  if (a.active !== 1) return;
  a.active = 0;
  ev.emit(EventType.ADVANTAGE, 0, a.team);
  const off = a.offender;
  if (a.card !== CardKind.NONE && off >= 0 && off < NUM_SLOTS && s.players[off]!.active === 1) showCard(s, off, a.card, ev);
  a.card = CardKind.NONE;
}

function interruptActions(s: SimState): void {
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    if (p.act === ActionKind.NONE) continue;
    if (p.active === 1 && isDownAct(p.act)) continue; // fallen players finish
    endAction(s, slot, 1);
  }
}

function callSetup(s: SimState, kind: RestartKind, ev: EventSink): void {
  switch (kind) {
    case RestartKind.KICK_OFF: setupKickOff(s, s.match.restart.team, ev); break;
    case RestartKind.THROW_IN: throwInSetup(s, ev); break;
    case RestartKind.GOAL_KICK: goalKickSetup(s, ev); break;
    case RestartKind.CORNER: cornerSetup(s, ev); break;
    case RestartKind.FREE_KICK: freeKickSetup(s, ev); break;
    case RestartKind.PENALTY: penaltySetup(s, ev); break;
    default: break;
  }
}

function callDefault(s: SimState, kind: RestartKind, ev: EventSink): void {
  switch (kind) {
    case RestartKind.KICK_OFF: kickOffDefault(s, ev); break;
    case RestartKind.THROW_IN: throwInDefault(s, ev); break;
    case RestartKind.GOAL_KICK: goalKickDefault(s, ev); break;
    case RestartKind.CORNER: cornerDefault(s, ev); break;
    case RestartKind.FREE_KICK: freeKickDefault(s, ev); break;
    case RestartKind.PENALTY: penaltyDefault(s, ev); break;
    default: break;
  }
}

/** After the kind's Setup: its ball position is the spot (kick-off / penalty spots are fixed); a taker exists. */
function afterSetup(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  const b = s.ball;
  if (r.kind === RestartKind.KICK_OFF || r.kind === RestartKind.PENALTY) {
    if (b.owner >= 0 || b.x !== r.x || b.z !== r.z || b.y !== BALL_RADIUS) placeBall(s, r.x, r.z, ev);
  } else if (b.owner < 0 && b.heldBy < 0) {
    let x = clamp(finiteOr(b.x, r.x), -HALF_LENGTH, HALF_LENGTH);
    let z = clamp(finiteOr(b.z, r.z), -HALF_WIDTH, HALF_WIDTH);
    if (r.kind === RestartKind.THROW_IN) z = (z < 0 ? -1 : z > 0 ? 1 : r.z < 0 ? -1 : 1) * HALF_WIDTH;
    if (r.kind === RestartKind.FREE_KICK && inGoalArea(x, z, s.teams[r.team]!.dir)) x = s.teams[r.team]!.dir * (HALF_LENGTH - GOAL_AREA_DEPTH);
    r.x = x;
    r.z = z;
    if (b.x !== x || b.z !== z || b.y !== BALL_RADIUS || b.vx !== 0 || b.vy !== 0 || b.vz !== 0) placeBall(s, x, z, ev);
  }
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
}

/**
 * Award a restart. Refused (no effect) while another restart is pending or being awarded, for an invalid kind/team,
 * or when the phase may not go to the kind's phase; refused and logged (WATCHDOG OTHER) for a wrong-team spot.
 */
export function awardRestart(s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventSink): void {
  if (awarding !== 0) return;
  if (!(kind >= RestartKind.KICK_OFF && kind <= RestartKind.PENALTY) || (team !== 0 && team !== 1)) return;
  const m = s.match;
  const r = m.restart;
  if (restartPending(s)) return;
  const to = KIND_PHASE[kind]! as MatchPhase;
  let viaInPlay = false;
  if (!isLegalTransition(m.phase, to)) {
    // A restart that was just taken: play is live again, so go through IN_PLAY (e.g. a foul right after a corner).
    if (!(isRestartPhase(m.phase) && r.taken === 1 && isLegalTransition(m.phase, MatchPhase.IN_PLAY) &&
      isLegalTransition(MatchPhase.IN_PLAY, to))) return;
    viaInPlay = true;
  }
  if (restartSpot(s, kind, team, x, z, SPOT) === 0) {
    logWatchdog(s, ev, WatchdogReason.OTHER, kind);
    return;
  }
  const sx = SPOT.x;
  const sz = SPOT.z;
  awarding = 1;
  try {
    if (viaInPlay) setPhase(s, MatchPhase.IN_PLAY, ev);
    resolveAdvantage(s, ev);
    m.offside.flags = 0;
    fillRestart(s, kind, team, sx, sz);
    const b = s.ball;
    placeBall(s, sx, sz, ev);
    b.shotBy = -1;
    b.shotOnTarget = 0;
    b.passTarget = -1;
    interruptActions(s);
    ev.emit(EventType.RESTART_AWARDED, kind, team, 0, 0, sx, BALL_RADIUS, sz);
    if (kind !== RestartKind.KICK_OFF) ev.emit(EventType.WHISTLE, WhistleKind.SHORT);
    callSetup(s, kind, ev);
    afterSetup(s, ev);
    if (m.phase !== to) setPhase(s, to, ev);
  } finally {
    awarding = 0;
  }
}

// ---------------------------------------------------------------- per tick

/** A restart phase entered without its restart record (or with a stale kind): adopt it with sensible defaults. */
function adoptPhase(s: SimState): void {
  const m = s.match;
  const kind = PHASE_KIND[m.phase]! as RestartKind;
  const b = s.ball;
  const team = kind === RestartKind.KICK_OFF ? (m.kickoffTeam === 1 ? 1 : 0)
    : b.lastTouchTeam === 0 || b.lastTouchTeam === 1 ? other(b.lastTouchTeam) : (m.restart.team === 1 ? 1 : 0);
  if (restartSpot(s, kind, team, b.x, b.z, SPOT) === 0) {
    SPOT.x = clamp(finiteOr(b.x, 0), -HALF_LENGTH, HALF_LENGTH);
    SPOT.z = clamp(finiteOr(b.z, 0), -HALF_WIDTH, HALF_WIDTH);
  }
  fillRestart(s, kind, team, SPOT.x, SPOT.z);
  m.restart.taker = pickRestartTaker(s, -1);
}

/**
 * [FEEL-2C, D-039] Side `side` was just handed to its CPU (Command.HAND_TO_CPU, a pad disconnect) during its own
 * restart, after ready and before the Default fell due: the CPU gets its own take window (cpuTakeTimeoutTicks, as at
 * a CPU side's ready) from now, plus what is left of a newly chosen free-kick taker's run-in. The human's 12 s were
 * mostly gone (fuzz seed 3 #33: 31 ticks left, a taker 10 m away), so the timeout fell due the tick that taker reached
 * the spot, before the CPU could act, and logged "CPU never acted" (WATCHDOG RESTART_BLOCKED). Never shortens it.
 */
export function restartHandedToCpu(s: SimState, side: number): void {
  const m = s.match;
  const r = m.restart;
  if (!isRestartPhase(m.phase) || r.team !== side || r.ready !== 1 || r.taken === 1 || r.timeoutT <= 0) return;
  let w = T_RESTART.cpuTakeTimeoutTicks;
  const t = r.taker;
  if (t >= 0 && t < NUM_SLOTS) {
    const p = s.players[t]!;
    if (takerRunning(p)) w += T_RESTART_COMMON.swapRunMaxTicks - p.actT;
  }
  if (r.timeoutT < w) r.timeoutT = w;
}

function becomeReady(s: SimState): void {
  const r = s.match.restart;
  if (!isValidTaker(s, r.taker) || isDown(s.players[r.taker]!)) {
    const t = pickRestartTaker(s, -1);
    if (t >= 0) r.taker = t;
  }
  const t = r.taker;
  if (t >= 0 && !isWaitingAct(s.players[t]!.act)) endAction(s, t, 1);
  legalizePositions(s);
  r.ready = 1;
  r.timeoutT = teamHasHuman(s, r.team) ? T_RULES.restartTimeoutTicks : T_RESTART.cpuTakeTimeoutTicks;
  settleTaker(s);
}

// ---------------------------------------------------------------- walked set-ups (QF-10)

/**
 * True when the current restart's set-up is shown on the main camera (no camera cut at ready hides a teleport):
 * throw-ins, and free kicks further than cutFreeKickGoalDist from the attacked goal centre.
 */
export function isWalkedSetup(s: SimState): boolean {
  const r = s.match.restart;
  if (r.kind === RestartKind.THROW_IN) return true;
  if (r.kind !== RestartKind.FREE_KICK) return false;
  const gx = s.teams[r.team === 1 ? 1 : 0]!.dir * HALF_LENGTH - r.x;
  const d = T_RESTART.cutFreeKickGoalDist;
  return gx * gx + r.z * r.z > d * d;
}

/** Free kick taker of a walked set-up: into SET_PIECE (its handler runs him to his spot) unless he is down / busy. */
function approachTaker(s: SimState): void {
  const r = s.match.restart;
  if (r.kind !== RestartKind.FREE_KICK) return; // throw-ins: RUL-02's THROW_IN APPROACH
  const t = r.taker;
  if (t < 0 || !isValidTaker(s, t)) return;
  const p = s.players[t]!;
  if (p.act !== ActionKind.NONE || isDown(p)) return;
  beginTakerAction(s, t);
}

/** Every illegal non-taker player walks out: his velocity away from his nearest legal spot is raised to setupWalkSpeed. */
function walkOutIllegal(s: SimState): void {
  buildCtx(s);
  const w = T_RESTART.setupWalkSpeed;
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (slot === ctx.taker) continue;
    const p = s.players[slot]!;
    if (p.active !== 1 || isDown(p) || legalNow(s, slot)) continue;
    nearestLegal(s, slot, SPOT2);
    const dx = SPOT2.x - p.x, dz = SPOT2.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-9) continue;
    const ux = dx / d, uz = dz / d;
    const vu = p.vx * ux + p.vz * uz;
    if (vu < w) { p.vx += (w - vu) * ux; p.vz += (w - vu) * uz; }
  }
}

/** Walked set-up settled: the taker in place (holding the ball at a throw-in) and every other player legal. */
function setupSettled(s: SimState): boolean {
  const r = s.match.restart;
  const t = r.taker;
  if (t >= 0) {
    const p = s.players[t]!;
    if (r.kind === RestartKind.THROW_IN) {
      if (p.act !== ActionKind.THROW_IN || s.ball.owner !== t) return false;
    } else if (!takerInPlace(s, t)) return false;
  }
  buildCtx(s);
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (slot === t) continue;
    const p = s.players[slot]!;
    if (p.active === 1 && !legalNow(s, slot)) return false;
  }
  return true;
}

/**
 * [QF-10 skeptic] Walked set-up: the taker is still running in (not in place, or a throw-in taker not yet holding the
 * ball) and closing on his spot at setupTakerRunMinSpeed or more. The set-up then waits up to setupExtendMaxTicks
 * instead of placing him from afar at setupStragglerMaxTicks.
 */
function takerRunningIn(s: SimState): boolean {
  const r = s.match.restart;
  const t = r.taker;
  if (t < 0 || t >= NUM_SLOTS) return false;
  const p = s.players[t]!;
  if (p.active !== 1 || isDown(p)) return false;
  if (r.kind === RestartKind.THROW_IN) {
    if (p.act === ActionKind.THROW_IN && s.ball.owner === t) return false;
  } else if (takerInPlace(s, t)) return false;
  restartTakerSpot(s, CAND);
  const dx = CAND.x - p.x, dz = CAND.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > 1e-6)) return false;
  return (p.vx * dx + p.vz * dz) / d >= T_RESTART.setupTakerRunMinSpeed;
}

/** Per tick during a restart phase (RUL-01 calls it before the kind's tick). */
export function restartTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const r = m.restart;
  if (!isRestartPhase(m.phase)) return;
  if (r.kind !== PHASE_KIND[m.phase]) adoptPhase(s);
  // Awarded during this tick's rules (RUL-01 calls restartTick right after): restart.t counts ticks since the award.
  if (m.phaseT === 0 && r.t === 0) return;
  r.t++;
  if (r.taken === 1) return;
  if (!isValidTaker(s, r.taker)) {
    r.taker = pickRestartTaker(s, -1);
    if (r.ready === 1) settleTaker(s);
  }
  keepBallOnSpot(s, ev);
  const setup = T_RULES.restartSetupTicks;
  // [QF-10] Main-camera set-ups walk everybody into place instead of teleporting them at the set-up tick (D-008): the
  // taker runs to his spot, illegal players walk out, and the set-up waits for them (capped).
  const walked = r.ready === 0 && isWalkedSetup(s);
  if (walked) {
    approachTaker(s);
    walkOutIllegal(s);
  }
  if ((!walked && r.t === setup) ||
    (r.ready === 0 && r.t >= setup && (!walked || setupSettled(s) || (r.t >= setup + T_RESTART.setupStragglerMaxTicks &&
      (r.t >= setup + T_RESTART.setupExtendMaxTicks || !takerRunningIn(s)))))) {
    // A set-up that ran long is counted as restartSetupTicks: every "ticks past ready" reading (r.t - setup: the kind
    // modules' CPU fallbacks, TAI-13's cpuRestartDelay) keeps its meaning.
    if (r.t > setup) r.t = setup;
    becomeReady(s);
    return;
  }
  if (r.ready === 0 || r.t < setup) return;
  settleTaker(s);
  pushOutIllegal(s);
  // [FIN-K] The timeout never fires on a taker still running in after "choose the taker" (it placed him on his spot):
  // it waits at its last tick until he is there (the run is capped at swapRunMaxTicks; RUL-05 allows no new choice then).
  if (!(r.timeoutT === 1 && r.taker >= 0 && takerRunning(s.players[r.taker]!))) r.timeoutT--;
  if (r.timeoutT === 0) {
    if (!teamHasHuman(s, r.team)) logWatchdog(s, ev, WatchdogReason.RESTART_BLOCKED, r.kind); // CPU never acted
    if (r.taker >= 0) prepareTakerKick(s, r.taker);
    callDefault(s, r.kind, ev);
  } else if (r.timeoutT <= -T_RESTART.defaultGraceTicks) {
    logWatchdog(s, ev, WatchdogReason.RESTART_BLOCKED, r.kind); // the Default did not take it
    forceRestartKick(s, ev);
  }
}

// ---------------------------------------------------------------- forced kick (safety net)

/** Nearest active teammate of the taker for a safety-net kick (outfield preferred; inside the pitch). */
function forcedTarget(s: SimState, taker: number): number {
  const p = s.players[taker]!;
  const first = teamFirstSlot(p.team);
  const b = s.ball;
  let best = -1;
  let bestD = 1e18;
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      const q = s.players[i]!;
      if (i === taker || q.active !== 1 || !inField(q.x, q.z)) continue;
      if (pass === 0 && q.isKeeper === 1) continue;
      const d = distSq(q.x, q.z, b.x, b.z);
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

function kickKindFor(kind: RestartKind): KickKind {
  switch (kind) {
    case RestartKind.KICK_OFF: return KickKind.KICK_OFF;
    case RestartKind.THROW_IN: return KickKind.THROW_IN;
    case RestartKind.GOAL_KICK: return KickKind.GOAL_KICK;
    case RestartKind.PENALTY: return KickKind.PENALTY;
    default: return KickKind.GROUND_PASS;
  }
}

/**
 * Safety net: take the current restart now with a plain kick through applyKick (no action, no animation): a ground
 * pass to the nearest teammate (a lofted throw at throw-ins, a shot at a corner of the goal at penalties). Re-picks
 * the taker if needed and puts ball and taker on the spot first. Marks the restart taken (also when nobody can take
 * it). Returns 1 if the ball was kicked. Callers log it.
 */
export function forceRestartKick(s: SimState, ev: EventSink): number {
  const r = s.match.restart;
  if (r.kind === RestartKind.NONE || r.taken === 1) return 0;
  if (!isValidTaker(s, r.taker)) r.taker = pickRestartTaker(s, -1);
  const t = r.taker;
  if (t < 0) { r.taken = 1; return 0; }
  const p = s.players[t]!;
  if (p.act !== ActionKind.NONE) endAction(s, t, 1);
  const b = s.ball;
  const held = r.kind === RestartKind.THROW_IN && b.owner === t && b.heldBy < 0;
  if (!held) placeBall(s, r.x, r.z, ev);
  if (!takerInPlace(s, t)) placeTakerOnSpot(s, t);
  const L = LAUNCH;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.onTarget = 0;
  L.kind = kickKindFor(r.kind);
  const g = T_BALL.gravity;
  if (r.kind === RestartKind.PENALTY) {
    const dir = s.teams[r.team]!.dir;
    const tx = dir * HALF_LENGTH;
    const tz = (rngInt(s.rng, 2) === 0 ? -1 : 1) * T_RESTART.forcedPenaltyZ;
    const dx = tx - b.x, dz = tz - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const v = T_RESTART.forcedPenaltySpeed;
    const tf = d / v;
    L.vx = (dx / d) * v;
    L.vz = (dz / d) * v;
    L.vy = (T_RESTART.forcedPenaltyY - b.y) / tf + 0.5 * g * tf;
    L.target = -1;
    L.tx = tx;
    L.tz = tz;
    L.onTarget = 1;
  } else {
    const mate = forcedTarget(s, t);
    let tx: number, tz: number;
    if (mate >= 0) {
      tx = s.players[mate]!.x;
      tz = s.players[mate]!.z;
    } else {
      restartForward(s, FWD);
      tx = b.x + FWD.x * T_RESTART.forcedAheadDist;
      tz = b.z + FWD.z * T_RESTART.forcedAheadDist;
    }
    let dx = tx - b.x, dz = tz - b.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) { restartForward(s, FWD); dx = FWD.x; dz = FWD.z; d = 1; }
    const ux = dx / d, uz = dz / d;
    if (r.kind === RestartKind.THROW_IN) {
      const vh = clamp(T_RESTART.forcedThrowBase + T_RESTART.forcedThrowPerM * d, T_RESTART.forcedThrowMin, T_RESTART.forcedThrowMax);
      L.vx = ux * vh;
      L.vz = uz * vh;
      L.vy = clamp(0.5 * g * (d / vh), T_RESTART.forcedThrowVyMin, T_RESTART.forcedThrowVyMax);
    } else {
      const a = T_RESTART.forcedPassArrive;
      const v0 = clamp(Math.sqrt(a * a + 2 * T_BALL.rollDecel * d), T_PASS.groundMin, T_PASS.groundMax);
      L.vx = ux * v0;
      L.vz = uz * v0;
      L.vy = 0;
    }
    L.target = mate;
    L.tx = tx;
    L.tz = tz;
  }
  const hv = Math.sqrt(L.vx * L.vx + L.vz * L.vz);
  if (hv > 1e-6) { p.fx = L.vx / hv; p.fz = L.vz / hv; }
  applyKick(s, t, L, T_RESTART.forcedPower, ev);
  r.taken = 1;
  return 1;
}

// ---------------------------------------------------------------- input routing

/**
 * Set-piece input routing by RestartKind. The kind modules export these as hoisted function declarations, so the
 * table holds the real functions whatever the module evaluation order (tests/unit/rul-11-import-order.test.ts).
 */
export const SETPIECE_INPUT: readonly (SetPieceInputFn | null)[] = [
  null, kickOffInput, throwInInput, goalKickInput, cornerInput, freeKickInput, penaltyInput,
];

/**
 * [RUL-07] Penalty shoot-out: five each, then sudden death, every eligible player takes one before anyone
 * repeats; alternate teams; keepers on the line; result tracking in s.match.shootout; ends in POST_MATCH with a
 * winner. Used after extra time in cups and directly by Shoot-out mode (config.startPhase = SHOOT_OUT).
 *
 * Implementation notes (RUL-07):
 *  - shootoutStart (RUL-01 calls it from PRE_MATCH / FULL_TIME, then sets the SHOOT_OUT phase itself): active = 1,
 *    tallies cleared, the team to kick first and the end both by coin toss (s.rng), kick orders built, every action
 *    ended, outfield players teleported into the centre circle (the same two-rows-per-team layout TAI-13 keeps them
 *    in), then the first kick's SETUP.
 *  - The end: every kick is taken at one goal, END = +1 (x = +52.5) or -1. "dir handling": at every kick the kicking
 *    team gets dir = END and the defending team dir = -END, so every module that derives goals from team.dir (SIM-11
 *    shot aim, GKP keeper positioning and saves, the HUD) sees the kicker attacking the shoot-out goal and the keeper
 *    defending his own goal. Hence END = teams[shootout.team].dir at all times (shootoutEnd).
 *  - Kick order (shootout.order = team 0, order2 = team 1; squad / roster indices, -1 = unused): active players, best
 *    takers first (finishing + composure, shot power breaks ties, then slot), the keeper last. Both teams use the same
 *    number of kickers, n = the smaller team's active count (Laws of the Game: the team with more players excludes
 *    some; here its lowest-ranked, so the keeper first). shootout.next[t] = index of the next kicker; when it reaches
 *    n a new rotation starts at the top, so every eligible player kicks once before anyone repeats. An entry whose
 *    player is no longer on the pitch is skipped.
 *  - Sub-states (shootout.sub / subT, ShootoutSub):
 *      SETUP  (T_RULES.restartSetupTicks, camera cut): kicking team's dirs set; next kicker picked; the defending
 *             keeper = the other team's keeperSlot; match.restart filled like a penalty (kind PENALTY, team, taker =
 *             kicker, spot, ready 0, taken 0, aim at the goal centre, side 0, aimPower 0); every action ended; the
 *             previous kicker back into the centre circle, the kicker behind the ball on the spot facing the goal,
 *             the defending keeper on his line, the kicking team's keeper waiting on the goal line where it meets the
 *             penalty-area line (outside the area, -z side), the ball still on the spot.
 *      AIM    (restart.ready = 1, WHISTLE START): the kicker's controller aims and shoots (shootoutInput), the defending
 *             keeper's human controller moves along the line and commits a dive. Kicker, keeper and ball are held in
 *             place until the kick. Timeouts: a side with a human -> Default after T_RULES.restartTimeoutTicks (12 s,
 *             not logged); a CPU side (TAI-13 normally kicks ~2 s in) -> Default after T_SHOOTOUT.cpuTimeoutTicks
 *             (logged WATCHDOG RESTART_BLOCKED); either way, a kick still not struck defaultGraceTicks later is forced
 *             through core/kick applyKick (logged). restart.timeoutT shows the remaining ticks.
 *      FLIGHT (core/kick applyKick marks restart.taken when shootout.kicker strikes): the ball is live until it enters
 *             the net at END (ball.cross GOAL at END or ball.inNet === END: scored), crosses any line (missed), is held
 *             by a keeper (saved, missed), stops (missed), rolls back out beyond deadDist (missed), is touched by anyone
 *             but the defending keeper after the kick (no rebounds count: missed) or flightMaxTicks pass (missed). A
 *             ball parried / off the post into the net is a goal (same kick).
 *      RESULT (resultTicks): kicks[team * MAX_SHOOTOUT_KICKS + i] = 1 scored / 2 missed, taken++, goals++ on a goal,
 *             SHOOTOUT_KICK (a = team, b = 0-based kick index of that team, c = 1 scored, x/y/z = ball); the winner is
 *             decided as soon as it is unreachable (shootoutDecided: after 5 each, or earlier when the trailing team
 *             cannot catch up; then sudden-death pairs). Then the next kick by the other team (suddenDeath = 1 from
 *             the sixth round) or the end: shootout.winner and match.winner, active = 0, sub = DONE, restart cleared,
 *             WHISTLE FINAL, RUL-01 setPhase(POST_MATCH). Safety cap: still level after MAX_SHOOTOUT_KICKS each ->
 *             decided by lot (s.rng, logged WATCHDOG OTHER).
 *  - Input (SIM-15 routes every controller's frame here in SHOOT_OUT; SIM-16 gives the kicking side's controller the
 *    kicker and the other side's controller the defending keeper). Only during AIM and before the kick:
 *      kicker: left stick aims (restart.aimX/aimZ = where the stick's ray from the spot meets the goal line, |z|
 *      clamped to aimMaxZ inside the posts; the aim persists when the stick is released); SHOOT press -> SIM-11
 *      startShot(PENALTY), R1 + SHOOT -> SHOT_FINESSE, L1 + SHOOT -> SHOT_CHIP, L1 + R1 + SHOOT -> SHOT_POWER, with
 *      ReqFlag.SET_PIECE (+ CPU), dir = unit vector spot -> aim point, hasTarget = 1 / target = the aim point, curve
 *      from frame.curve, power from the frame (charging 0) or charging = 1 (the resolver's adoptCharge attaches the
 *      power bar to SHOOT). Touch: SWIPE toward the goal = penalty along the swipe (gPower = power: faster is harder
 *      to save and less accurate, by SIM-11's error model), CURVED_SWIPE = finesse with gCurve, BACK_FORTH_SWIPE =
 *      power shot; TAP / DOUBLE_TAP on the goal (GestureFlag.ON_GOAL) = chip at that point.
 *      defending keeper (human): left stick moves him along his line (|z| <= keeperMaxZ, easing in over
 *      keeperBrakeDist, facing the ball; a keeper beyond keeperMaxZ is clamped to it before the kick); a right
 *      stick flick (Btn.RS_FLICK + ax/az), a swipe (gdx/gdz) or a tap (gz) commits a dive, stored for GKP-06 like
 *      RUL-06 does at penalties: restart.side = dive side in pitch z (-1 toward -z, +1 toward +z, 0 none / stay in
 *      the middle), restart.aimPower = height class 0 low / 1 mid / 2 high (0 when none). Flick / swipe: lateral
 *      share >= diveSideShare picks the side; the share along END (away from the kicker, "up" behind the taker) >=
 *      diveHeightShare is high, toward the kicker is low, else mid. Tap: side of the keeper the tap lies on beyond
 *      diveTapBand, mid height. The latest choice before the kick wins. AI keepers dive by GKP-06.
 *  - Default (human timeout / CPU fallback): the aim the kicker set, else a corner chosen by s.rng (inset
 *    defaultInsetMin..Max from a post); SIM-11 startShot(PENALTY) at defaultPower (no charging). Never while the
 *    kicker is already kicking or down; retried every tick until it starts or the forced kick is due.
 *  - Exports beyond the stub: ShootoutSub, KICK_SCORED / KICK_MISSED, LOCAL_TUNING (= T_SHOOTOUT), shootoutEnd, shootoutDecided,
 *    shootoutKeeperSpot (where each keeper stands; for GKP-06), shootoutCircleSpot.
 * Determinism: s.rng only at the start coin tosses, the default aim, forced-kick error and the lot. Per-tick work is
 * O(1) (O(22) once per kick at SETUP); allocation-free (module scratch only).
 */
import {
  BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import {
  ActionKind, AssistLevel, ControllerKind, CrossKind, GestureKind, KickKind, MatchPhase, RestartKind, WatchdogReason,
} from '../../contracts/enums';
import { EventType, WhistleKind, type EventSink } from '../../contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, GestureFlag, UNIT_SCALE, type InputFrame } from '../../contracts/input';
import {
  MAX_SHOOTOUT_KICKS, MoveMode, type ControllerState, type PlayerState, type ShootoutState, type SimState,
} from '../../contracts/state';
import { createActionRequest, createKickLaunch, ReqFlag } from '../../contracts/systems';
import { T_BALL, T_INPUT, T_RULES, T_SHOOTOUT } from '../../contracts/tuning';
import { endAction, isFree } from '../actions/dispatch';
import { applyKick, releasePossession } from '../core/kick';
import { teamHasHuman } from '../core/query';
import { rngGauss, rngInt, rngRange } from '../core/rng';
import { startShot } from '../kicks/shot';
import { setPhase } from './machine';
import { logWatchdog } from './restartCommon';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_SHOOTOUT. */
export const LOCAL_TUNING = T_SHOOTOUT;

const LT = T_SHOOTOUT;

/** Sub-states of one kick (match.shootout.sub). */
export const ShootoutSub = {
  /** Kicker on the spot, keepers placed, ball on the spot (camera cut); subT counts to T_RULES.restartSetupTicks. */
  SETUP: 0,
  /** The kicker may kick: aim / shoot, keeper dive choice, timeouts. */
  AIM: 1,
  /** Ball struck and live until the kick is decided. */
  FLIGHT: 2,
  /** Result recorded and shown for resultTicks. */
  RESULT: 3,
  /** Shoot-out over (winner decided). */
  DONE: 4,
} as const;

/** kicks[] values. */
export const KICK_SCORED = 1;
export const KICK_MISSED = 2;

// ---------------------------------------------------------------- module scratch (rewritten before every use)

const REQ = createActionRequest();
const LAUNCH = createKickLaunch();
const PT = { x: 0, z: 0 };
const ORD_SLOT = new Int32Array(PLAYERS_PER_TEAM);
const ORD_SCORE = new Float64Array(PLAYERS_PER_TEAM);

// ---------------------------------------------------------------- small helpers

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS;
}

function kickingTeam(so: Readonly<ShootoutState>): number {
  return so.team === 1 ? 1 : 0;
}

/** The goal every kick is taken at: +1 (x = +52.5) or -1. The kicking team attacks it (its dir). */
export function shootoutEnd(s: SimState): number {
  return s.teams[kickingTeam(s.match.shootout)]!.dir >= 0 ? 1 : -1;
}

/**
 * Winner of the shoot-out from the tallies, or -1 while it is still open: one team leads by more than the other can
 * still score in the current rounds (five each, then sudden-death pairs). Pure.
 */
export function shootoutDecided(so: Readonly<ShootoutState>): number {
  const t0 = so.taken[0]!, t1 = so.taken[1]!;
  const g0 = so.goals[0]!, g1 = so.goals[1]!;
  let rounds = t0 > t1 ? t0 : t1;
  if (rounds < LT.regulationKicks) rounds = LT.regulationKicks;
  if (g0 > g1 + (rounds - t1)) return 0;
  if (g1 > g0 + (rounds - t0)) return 1;
  return -1;
}

/** Centre-circle spot of an outfield player (two rows per team, team 0 on the -z side), into out. */
export function shootoutCircleSpot(s: SimState, slot: number, out: { x: number; z: number }): void {
  const p = s.players[slot]!;
  const idx = slot - teamFirstSlot(p.team);
  const j = idx >> 1;
  out.x = (idx & 1) === 0 ? -LT.circleRowX : LT.circleRowX;
  out.z = (p.team === 0 ? -1 : 1) * (LT.circleZ0 + LT.circleGapZ * j);
}

/**
 * Where a keeper stands during the shoot-out (for GKP-06): the defending keeper on his goal line centre, the kicking
 * team's keeper (unless he is the kicker) on the goal line where it meets the penalty-area line. Returns 1 with the
 * spot in out, 0 for anybody else or when no shoot-out runs.
 */
export function shootoutKeeperSpot(s: SimState, slot: number, out: { x: number; z: number }): number {
  const so = s.match.shootout;
  if (so.active !== 1 || !validSlot(slot)) return 0;
  const end = shootoutEnd(s);
  if (slot === so.keeper) {
    out.x = end * (HALF_LENGTH - LT.keeperLineInset);
    out.z = 0;
    return 1;
  }
  if (slot !== so.kicker && slot === s.teams[kickingTeam(so)]!.keeperSlot) {
    out.x = end * (HALF_LENGTH - LT.waitInsetX);
    out.z = -LT.waitZ;
    return 1;
  }
  return 0;
}

/** Teleport a player (camera cut) standing still, facing (fx, fz), intent cleared. */
function placePlayer(p: PlayerState, x: number, z: number, fx: number, fz: number): void {
  p.x = x;
  p.z = z;
  p.vx = 0;
  p.vz = 0;
  p.fx = fx;
  p.fz = fz;
  p.moveMode = MoveMode.STOP;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
}

/** Ball still on (x, z): possession, hands, shot, pass target and net state cleared. */
function placeBall(s: SimState, x: number, z: number, ev: EventSink): void {
  releasePossession(s, ev);
  const b = s.ball;
  b.owner = -1;
  b.ownerT = 0;
  b.heldBy = -1;
  b.x = x; b.y = BALL_RADIUS; b.z = z;
  b.px = x; b.py = BALL_RADIUS; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1;
  b.bounces = 0;
  b.shotBy = -1;
  b.shotOnTarget = 0;
  b.passTarget = -1;
  b.inNet = 0;
  b.idleT = 0;
  b.cross = CrossKind.NONE;
}

/** Penalty spot x at the shoot-out end. */
function spotX(end: number): number {
  return end * (HALF_LENGTH - PENALTY_SPOT_DIST);
}

function kickerSpot(s: SimState, out: { x: number; z: number }): void {
  const r = s.match.restart;
  out.x = r.x - shootoutEnd(s) * LT.kickerBehind;
  out.z = r.z;
}

/** The kicking team attacks the shoot-out end, the other team defends it. */
function setKickingTeam(s: SimState, team: number, end: number): void {
  s.match.shootout.team = team;
  s.teams[team]!.dir = end;
  s.teams[other(team)]!.dir = -end;
}

// ---------------------------------------------------------------- kick order

function takerScore(s: SimState, slot: number): number {
  const a = s.attrs[slot]!;
  const base = a.finishing + a.composure + a.shotPower / 1000;
  return s.players[slot]!.isKeeper === 1 ? base - 1000 : base;
}

function activeCount(s: SimState, team: number): number {
  const first = teamFirstSlot(team);
  let n = 0;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (s.players[i]!.active === 1) n++;
  return n;
}

/** Kick orders: active players, best takers first, keeper last; both teams cut to the same number of kickers. */
function buildOrders(s: SimState): void {
  const so = s.match.shootout;
  const n0 = activeCount(s, 0), n1 = activeCount(s, 1);
  const n = n0 < n1 ? n0 : n1;
  for (let team = 0; team < 2; team++) {
    const ord = team === 0 ? so.order : so.order2;
    for (let i = 0; i < ord.length; i++) ord[i] = -1;
    so.next[team] = 0;
    const first = teamFirstSlot(team);
    let m = 0;
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      if (s.players[i]!.active !== 1) continue;
      // Insertion sort: higher score first, equal scores by slot (stable in slot order).
      const sc = takerScore(s, i);
      let k = m;
      while (k > 0 && ORD_SCORE[k - 1]! < sc) {
        ORD_SCORE[k] = ORD_SCORE[k - 1]!;
        ORD_SLOT[k] = ORD_SLOT[k - 1]!;
        k--;
      }
      ORD_SCORE[k] = sc;
      ORD_SLOT[k] = i;
      m++;
    }
    const cnt = m < n ? m : n;
    for (let i = 0; i < cnt && i < ord.length; i++) ord[i] = s.players[ORD_SLOT[i]!]!.rosterIdx;
  }
}

function orderCount(ord: readonly number[]): number {
  let n = 0;
  while (n < ord.length && ord[n]! >= 0) n++;
  return n;
}

/** Active slot of `team` playing roster index r, -1 if none. */
function slotOfRoster(s: SimState, team: number, r: number): number {
  if (r < 0) return -1;
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.rosterIdx === r) return i;
  }
  return -1;
}

/** Next kicker of `team` from its order (advances next[team]; a new rotation starts after the last). */
function pickKicker(s: SimState, team: number): number {
  const so = s.match.shootout;
  const ord = team === 0 ? so.order : so.order2;
  const n = orderCount(ord);
  for (let k = 0; k < n; k++) {
    let i = so.next[team]!;
    if (!(i >= 0 && i < n)) i = 0;
    so.next[team] = i + 1;
    const slot = slotOfRoster(s, team, ord[i]!);
    if (slot >= 0) return slot;
  }
  // Nobody of the order is on the pitch (never in normal flows): any active outfield player, else the keeper.
  const first = teamFirstSlot(team);
  let keeper = -1;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    if (p.isKeeper !== 1) return i;
    keeper = i;
  }
  return keeper;
}

// ---------------------------------------------------------------- kick flow

/** SETUP of the next kick by shootout.team (its dir is already the end). */
function beginKick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const so = m.shootout;
  const r = m.restart;
  const team = kickingTeam(so);
  const end = shootoutEnd(s);
  so.sub = ShootoutSub.SETUP;
  so.subT = 0;
  so.suddenDeath = so.taken[0]! >= LT.regulationKicks && so.taken[1]! >= LT.regulationKicks ? 1 : 0;
  for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.act !== ActionKind.NONE) endAction(s, i, 1);

  const prev = so.kicker;
  so.kicker = pickKicker(s, team);
  const k = s.teams[other(team)]!.keeperSlot;
  so.keeper = validSlot(k) && s.players[k]!.active === 1 ? k : -1;

  r.kind = RestartKind.PENALTY;
  r.team = team;
  r.taker = so.kicker;
  r.x = spotX(end);
  r.z = 0;
  r.t = 0;
  r.ready = 0;
  r.taken = 0;
  r.timeoutT = 0;
  r.wallCount = 0;
  r.aimX = end * HALF_LENGTH;
  r.aimZ = 0;
  r.aimPower = 0;
  r.aimCurve = 0;
  r.side = 0;

  // The previous kicker goes back into the circle (unless he is a keeper: placed below).
  if (validSlot(prev) && prev !== so.kicker) {
    const q = s.players[prev]!;
    if (q.active === 1 && prev !== s.teams[q.team]!.keeperSlot) {
      shootoutCircleSpot(s, prev, PT);
      placePlayer(q, PT.x, PT.z, end, 0);
    }
  }
  placeBall(s, r.x, r.z, ev);
  if (validSlot(so.kicker)) {
    const p = s.players[so.kicker]!;
    kickerSpot(s, PT);
    placePlayer(p, PT.x, PT.z, end, 0);
    p.stunT = 0;
    p.lookAt = 1;
    p.lookX = r.aimX;
    p.lookZ = r.aimZ;
  }
  for (let t = 0; t < 2; t++) {
    const ks = s.teams[t]!.keeperSlot;
    if (!validSlot(ks) || ks === so.kicker || s.players[ks]!.active !== 1) continue;
    if (shootoutKeeperSpot(s, ks, PT) !== 1) continue;
    const p = s.players[ks]!;
    if (ks === so.keeper) {
      placePlayer(p, PT.x, PT.z, -end, 0);
    } else {
      // Waiting keeper faces the spot.
      const dx = r.x - PT.x, dz = r.z - PT.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      placePlayer(p, PT.x, PT.z, d > 1e-6 ? dx / d : -end, d > 1e-6 ? dz / d : 0);
    }
    p.stunT = 0;
  }
}

function beginAim(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  const r = s.match.restart;
  so.sub = ShootoutSub.AIM;
  so.subT = 0;
  r.ready = 1;
  r.timeoutT = teamHasHuman(s, kickingTeam(so)) ? T_RULES.restartTimeoutTicks : LT.cpuTimeoutTicks;
  if (!validSlot(so.kicker)) { // nobody can kick (never in normal flows): the kick counts as missed
    recordResult(s, KICK_MISSED, ev);
    return;
  }
  ev.emit(EventType.WHISTLE, WhistleKind.START);
}

function beginFlight(s: SimState): void {
  const so = s.match.shootout;
  so.sub = ShootoutSub.FLIGHT;
  so.subT = 0;
  s.match.restart.timeoutT = 0;
}

/** Record the kick's result, emit SHOOTOUT_KICK, decide the winner if it can no longer change, enter RESULT. */
function recordResult(s: SimState, res: number, ev: EventSink): void {
  const so = s.match.shootout;
  const team = kickingTeam(so);
  const idx = so.taken[team]!;
  if (idx >= 0 && idx < MAX_SHOOTOUT_KICKS) so.kicks[team * MAX_SHOOTOUT_KICKS + idx] = res;
  so.taken[team] = idx + 1;
  if (res === KICK_SCORED) so.goals[team] = so.goals[team]! + 1;
  const b = s.ball;
  ev.emit(EventType.SHOOTOUT_KICK, team, idx, res === KICK_SCORED ? 1 : 0, 0, b.x, b.y, b.z);
  so.sub = ShootoutSub.RESULT;
  so.subT = 0;
  s.match.restart.ready = 0;
  s.match.restart.timeoutT = 0;
  let w = shootoutDecided(so);
  if (w < 0 && so.taken[0]! >= MAX_SHOOTOUT_KICKS && so.taken[1]! >= MAX_SHOOTOUT_KICKS) {
    w = rngInt(s.rng, 2); // safety cap (kicks[] is full): drawing of lots
    logWatchdog(s, ev, WatchdogReason.OTHER, -1);
  }
  if (w >= 0) so.winner = w;
}

/** End of the shoot-out: winner recorded, restart cleared, POST_MATCH (RUL-01). */
function finish(s: SimState, ev: EventSink): void {
  const m = s.match;
  const so = m.shootout;
  const r = m.restart;
  so.active = 0;
  so.sub = ShootoutSub.DONE;
  so.subT = 0;
  m.winner = so.winner;
  r.kind = RestartKind.NONE;
  r.taker = -1;
  r.ready = 0;
  r.taken = 0;
  r.timeoutT = 0;
  r.side = 0;
  r.aimPower = 0;
  ev.emit(EventType.WHISTLE, WhistleKind.FINAL);
  if (m.phase === MatchPhase.SHOOT_OUT) setPhase(s, MatchPhase.POST_MATCH, ev);
}

/** Keep kicker, defending keeper and ball in place until the kick (SETUP / AIM). */
function holdPositions(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  const r = s.match.restart;
  const end = shootoutEnd(s);
  const b = s.ball;
  if (r.taken === 0) {
    const dx = b.x - r.x, dz = b.z - r.z;
    const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (b.owner >= 0 || b.heldBy >= 0 || dx * dx + dz * dz > LT.ballStrayDist * LT.ballStrayDist ||
      v2 > LT.ballStraySpeed * LT.ballStraySpeed || b.y > BALL_RADIUS + LT.ballStrayHeight) {
      placeBall(s, r.x, r.z, ev);
    }
  }
  const k = so.kicker;
  if (validSlot(k)) {
    const p = s.players[k]!;
    if (p.active === 1 && p.act === ActionKind.NONE) {
      kickerSpot(s, PT);
      const dx = p.x - PT.x, dz = p.z - PT.z;
      if (dx * dx + dz * dz > LT.kickerPinTol * LT.kickerPinTol) placePlayer(p, PT.x, PT.z, end, 0);
      p.moveMode = MoveMode.STOP;
      p.ix = 0;
      p.iz = 0;
      p.wantSprint = 0;
      p.lookAt = 1;
      p.lookX = r.aimX;
      p.lookZ = r.aimZ;
    }
  }
  const g = so.keeper;
  if (validSlot(g)) {
    const p = s.players[g]!;
    if (p.active === 1 && p.act === ActionKind.NONE) {
      const lineX = end * (HALF_LENGTH - LT.keeperLineInset);
      if (Math.abs(p.x - lineX) > LT.keeperLineSlack) placePlayer(p, lineX, clamp(p.z, -LT.keeperMaxZ, LT.keeperMaxZ), -end, 0);
      if (p.z > LT.keeperMaxZ) {
        p.z = LT.keeperMaxZ;
        if (p.vz > 0) p.vz = 0;
      } else if (p.z < -LT.keeperMaxZ) {
        p.z = -LT.keeperMaxZ;
        if (p.vz < 0) p.vz = 0;
      }
    }
  }
}

/** Default aim (once, when the timeout fires): keep an aim the kicker set, else a corner by s.rng. */
function chooseDefaultAim(s: SimState): void {
  const r = s.match.restart;
  r.aimX = shootoutEnd(s) * HALF_LENGTH;
  if (r.aimZ > 0.01 || r.aimZ < -0.01) return;
  const side = rngInt(s.rng, 2) === 0 ? -1 : 1;
  r.aimZ = side * (GOAL_HALF_WIDTH - rngRange(s.rng, LT.defaultInsetMin, LT.defaultInsetMax));
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

/** Start the kicker's shot of `kind` from REQ (power / charging / curve / flags set) at the current aim point. */
function startKick(s: SimState, k: number, kind: KickKind, ev: EventSink): number {
  const r = s.match.restart;
  const p = s.players[k]!;
  const dx = r.aimX - r.x, dz = r.aimZ - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const end = shootoutEnd(s);
  REQ.dirX = d > 1e-6 ? dx / d : end;
  REQ.dirZ = d > 1e-6 ? dz / d : 0;
  REQ.hasTarget = 1;
  REQ.targetX = r.aimX;
  REQ.targetZ = r.aimZ;
  REQ.targetSlot = -1;
  p.fx = REQ.dirX;
  p.fz = REQ.dirZ;
  return startShot(s, k, kind, REQ, ev) === 1 ? 1 : 0;
}

/** Default kick (human timeout / CPU fallback) when the kicker is free. */
function takeDefault(s: SimState, ev: EventSink): void {
  const k = s.match.shootout.kicker;
  if (!validSlot(k) || !isFree(s.players[k]!)) return;
  resetReq(AssistLevel.ASSISTED, 0);
  REQ.power = LT.defaultPower;
  startKick(s, k, KickKind.PENALTY, ev);
}

/** Safety net: strike the kick now through applyKick toward the aim (with error, so it can miss). Logged. */
function forceKick(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  const r = s.match.restart;
  const k = so.kicker;
  logWatchdog(s, ev, WatchdogReason.RESTART_BLOCKED, k);
  if (!validSlot(k) || s.players[k]!.active !== 1) {
    recordResult(s, KICK_MISSED, ev);
    return;
  }
  const p = s.players[k]!;
  if (p.act !== ActionKind.NONE) endAction(s, k, 1);
  const end = shootoutEnd(s);
  placeBall(s, r.x, r.z, ev);
  kickerSpot(s, PT);
  placePlayer(p, PT.x, PT.z, end, 0);
  const b = s.ball;
  const tx = end * HALF_LENGTH;
  const lim = GOAL_HALF_WIDTH + 1.5;
  const tz = clamp(r.aimZ + rngGauss(s.rng) * LT.forcedAimErr, -lim, lim);
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const v = LT.forcedSpeed;
  const tf = d / v;
  const L = LAUNCH;
  L.vx = (dx / d) * v;
  L.vz = (dz / d) * v;
  L.vy = (LT.forcedHeight - b.y) / tf + 0.5 * T_BALL.gravity * tf;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = KickKind.PENALTY;
  L.target = -1;
  L.tx = tx;
  L.tz = tz;
  L.onTarget = tz > -GOAL_HALF_WIDTH + BALL_RADIUS && tz < GOAL_HALF_WIDTH - BALL_RADIUS ? 1 : 0;
  p.fx = dx / d;
  p.fz = dz / d;
  applyKick(s, k, L, LT.forcedPower, ev);
  r.taken = 1;
  beginFlight(s);
}

function aimTick(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  const r = s.match.restart;
  if (r.taken === 1) { beginFlight(s); flightTick(s, ev); return; }
  holdPositions(s, ev);
  const human = teamHasHuman(s, kickingTeam(so));
  const limit = human ? T_RULES.restartTimeoutTicks : LT.cpuTimeoutTicks;
  const t = so.subT;
  r.timeoutT = t < limit ? limit - t : 0;
  if (t < limit) return;
  if (t >= limit + LT.defaultGraceTicks) { forceKick(s, ev); return; }
  if (t === limit) {
    chooseDefaultAim(s);
    if (!human) logWatchdog(s, ev, WatchdogReason.RESTART_BLOCKED, so.kicker); // CPU safety net
  }
  takeDefault(s, ev);
}

function flightTick(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  const b = s.ball;
  const end = shootoutEnd(s);
  const start = s.tick - so.subT;
  let res = 0;
  if ((b.cross === CrossKind.GOAL && b.crossEnd === end) || b.inNet === end) {
    res = KICK_SCORED;
  } else if (b.cross !== CrossKind.NONE || b.inNet !== 0) {
    res = KICK_MISSED; // wide, over, out of play
  } else if (b.heldBy >= 0) {
    res = KICK_MISSED; // saved and held
  } else if (b.lastTouchTick > start && b.lastTouch !== so.keeper) {
    res = KICK_MISSED; // touched again by someone else than the keeper: no rebounds
  } else {
    const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    const stopped = v2 < LT.restSpeed * LT.restSpeed && b.y <= BALL_RADIUS + LT.restHeight;
    const dead = end * b.vx < 0 && end * b.x < HALF_LENGTH - LT.deadDist;
    if (stopped || dead || so.subT >= LT.flightMaxTicks) res = KICK_MISSED;
  }
  if (res !== 0) recordResult(s, res, ev);
}

/** End of RESULT: the next kick by the other team, or the end. */
function nextKick(s: SimState, ev: EventSink): void {
  const so = s.match.shootout;
  if (so.winner >= 0) {
    finish(s, ev);
    return;
  }
  setKickingTeam(s, other(kickingTeam(so)), shootoutEnd(s));
  beginKick(s, ev);
}

// ---------------------------------------------------------------- input

/** Aim from a direction (stick / swipe) in pitch space: where its ray from the spot meets the goal line. */
function aimAlong(s: SimState, dx: number, dz: number): number {
  const r = s.match.restart;
  const end = shootoutEnd(s);
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > 1e-6)) return 0;
  const fwd = (end * dx) / d;
  const lat = dz / d;
  let z: number;
  if (fwd > LT.aimMinForward) z = r.z + (lat / fwd) * (HALF_LENGTH - end * r.x);
  else z = lat > 0 ? LT.aimMaxZ : lat < 0 ? -LT.aimMaxZ : 0;
  r.aimX = end * HALF_LENGTH;
  r.aimZ = clamp(z, -LT.aimMaxZ, LT.aimMaxZ);
  return 1;
}

function shotKindFor(buttons: number): KickKind {
  const l = (buttons & Btn.MOD_L) !== 0;
  const rr = (buttons & Btn.MOD_R) !== 0;
  if (l && rr) return KickKind.SHOT_POWER;
  if (rr) return KickKind.SHOT_FINESSE;
  if (l) return KickKind.SHOT_CHIP;
  return KickKind.PENALTY;
}

function kickerInput(s: SimState, c: ControllerState, f: Readonly<InputFrame>, ev: EventSink): void {
  const k = s.match.shootout.kicker;
  const p = s.players[k]!;
  if (!isFree(p)) return; // kicking already (power bar) or down
  const cpu = c.kind === ControllerKind.CPU ? ReqFlag.CPU : 0;
  const idle = T_INPUT.stickIdle;
  if (c.mx * c.mx + c.mz * c.mz > idle * idle) aimAlong(s, c.mx, c.mz);
  const g = f.gesture;
  if (g === GestureKind.SWIPE || g === GestureKind.CURVED_SWIPE || g === GestureKind.BACK_FORTH_SWIPE) {
    let dx = f.gdx, dz = f.gdz;
    if (dx === 0 && dz === 0) {
      const r = s.match.restart;
      dx = f.gx / GESTURE_POS_SCALE - r.x;
      dz = f.gz / GESTURE_POS_SCALE - r.z;
    }
    if (shootoutEnd(s) * dx <= 0) return; // not toward the goal
    aimAlong(s, dx, dz);
    resetReq(c.assist, ReqFlag.GESTURE | cpu);
    REQ.power = f.gPower > 0 ? clamp(f.gPower / UNIT_SCALE, 0, 1) : LT.gesturePower;
    if (g === GestureKind.CURVED_SWIPE) REQ.curve = clamp(f.gCurve / AXIS_SCALE, -1, 1);
    const kind = g === GestureKind.CURVED_SWIPE ? KickKind.SHOT_FINESSE
      : g === GestureKind.BACK_FORTH_SWIPE ? KickKind.SHOT_POWER : KickKind.PENALTY;
    startKick(s, k, kind, ev);
    return;
  }
  if ((g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) && (f.gFlags & GestureFlag.ON_GOAL) !== 0) {
    const r = s.match.restart;
    r.aimX = shootoutEnd(s) * HALF_LENGTH;
    r.aimZ = clamp(f.gz / GESTURE_POS_SCALE, -LT.aimMaxZ, LT.aimMaxZ);
    resetReq(c.assist, ReqFlag.GESTURE | cpu);
    REQ.power = f.gPower > 0 ? clamp(f.gPower / UNIT_SCALE, 0, 1) : LT.chipTapPower;
    startKick(s, k, KickKind.SHOT_CHIP, ev);
    return;
  }
  const pressed = c.buttons & ~c.prevButtons;
  if ((pressed & Btn.SHOOT) === 0) return;
  resetReq(c.assist, cpu);
  if (f.power > 0) {
    REQ.power = clamp(f.power / UNIT_SCALE, 0, 1);
  } else {
    REQ.charging = 1; // the resolver attaches the power bar to SHOOT (adoptCharge)
  }
  REQ.curve = clamp(f.curve / AXIS_SCALE, -1, 1);
  startKick(s, k, shotKindFor(c.buttons), ev);
}

/** Keeper dive choice from a direction (flick / swipe) in pitch space. */
function diveAlong(s: SimState, dx: number, dz: number): void {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > 1e-6)) return;
  const r = s.match.restart;
  const lat = dz / d;
  const lon = (shootoutEnd(s) * dx) / d;
  r.side = lat >= LT.diveSideShare ? 1 : lat <= -LT.diveSideShare ? -1 : 0;
  r.aimPower = lon >= LT.diveHeightShare ? 2 : lon <= -LT.diveHeightShare ? 0 : 1;
}

function keeperInput(s: SimState, c: ControllerState, f: Readonly<InputFrame>): void {
  const so = s.match.shootout;
  const r = s.match.restart;
  const p = s.players[so.keeper]!;
  if (p.active !== 1) return;
  const pressed = c.buttons & ~c.prevButtons;
  const g = f.gesture;
  if ((pressed & Btn.RS_FLICK) !== 0) {
    diveAlong(s, f.ax, f.az);
  } else if (g === GestureKind.SWIPE || g === GestureKind.CURVED_SWIPE || g === GestureKind.BACK_FORTH_SWIPE) {
    diveAlong(s, f.gdx, f.gdz);
  } else if (g === GestureKind.TAP || g === GestureKind.DOUBLE_TAP) {
    const gz = f.gz / GESTURE_POS_SCALE;
    r.side = gz > p.z + LT.diveTapBand ? 1 : gz < p.z - LT.diveTapBand ? -1 : 0;
    r.aimPower = 1;
  }
  // Left stick: along the line only, facing the ball.
  if (!isFree(p)) return;
  const idle = T_INPUT.stickIdle;
  if (c.mz * c.mz <= idle * idle) return; // the resolver has already stopped a stale stick intent
  let iz = c.mz * LT.keeperStickFrac;
  const room = iz > 0 ? LT.keeperMaxZ - p.z : LT.keeperMaxZ + p.z;
  iz *= clamp(room / LT.keeperBrakeDist, 0, 1); // ease into the limit
  p.moveMode = MoveMode.DIRECT;
  p.ix = 0;
  p.iz = iz;
  p.wantSprint = 0;
  p.lookAt = 1;
  p.lookX = r.x;
  p.lookZ = r.z;
}

// ---------------------------------------------------------------- API

export function shootoutStart(s: SimState, ev: EventSink): void {
  const m = s.match;
  const so = m.shootout;
  so.active = 1;
  so.taken[0] = 0; so.taken[1] = 0;
  so.goals[0] = 0; so.goals[1] = 0;
  so.next[0] = 0; so.next[1] = 0;
  for (let i = 0; i < so.kicks.length; i++) so.kicks[i] = 0;
  so.sub = ShootoutSub.SETUP;
  so.subT = 0;
  so.kicker = -1;
  so.keeper = -1;
  so.suddenDeath = 0;
  so.winner = -1;
  m.winner = -1;
  const first = rngInt(s.rng, 2);
  const end = rngInt(s.rng, 2) === 0 ? 1 : -1;
  setKickingTeam(s, first, end);
  buildOrders(s);
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.act !== ActionKind.NONE) endAction(s, i, 1);
    if (p.active !== 1) continue;
    p.stunT = 0;
    if (i === s.teams[p.team]!.keeperSlot) continue; // keepers: beginKick
    shootoutCircleSpot(s, i, PT);
    placePlayer(p, PT.x, PT.z, end, 0);
  }
  beginKick(s, ev);
}

export function shootoutTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (m.phase !== MatchPhase.SHOOT_OUT) return;
  const so = m.shootout;
  if (so.active !== 1) {
    if (so.winner >= 0) { finish(s, ev); return; } // decided earlier but the phase did not change
    logWatchdog(s, ev, WatchdogReason.OTHER, 0); // phase entered without shootoutStart
    shootoutStart(s, ev);
    return;
  }
  so.subT++;
  m.restart.t++;
  switch (so.sub) {
    case ShootoutSub.SETUP:
      holdPositions(s, ev);
      if (so.subT >= T_RULES.restartSetupTicks) beginAim(s, ev);
      return;
    case ShootoutSub.AIM:
      aimTick(s, ev);
      return;
    case ShootoutSub.FLIGHT:
      flightTick(s, ev);
      return;
    case ShootoutSub.RESULT:
      if (so.subT >= LT.resultTicks) nextKick(s, ev);
      return;
    default:
      if (so.winner >= 0) finish(s, ev);
      else beginKick(s, ev);
  }
}

export function shootoutInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  const m = s.match;
  const so = m.shootout;
  if (m.phase !== MatchPhase.SHOOT_OUT || so.active !== 1 || so.sub !== ShootoutSub.AIM || m.restart.taken === 1) return;
  if (!(ctrlIdx >= 0 && ctrlIdx < s.ctrl.length)) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || (c.side !== 0 && c.side !== 1)) return;
  if (c.side === kickingTeam(so)) {
    if (validSlot(so.kicker) && c.slot === so.kicker) kickerInput(s, c, f, ev);
    return;
  }
  if (validSlot(so.keeper) && c.slot === so.keeper) keeperInput(s, c, f);
}

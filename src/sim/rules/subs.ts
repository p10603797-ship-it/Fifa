/**
 * [RUL-10] Substitutions (up to 5, at any stoppage, from Command.SUBSTITUTE; a substituted player cannot
 * return; attributes copied into s.attrs; stamina fresh), sending off (slot inactive, team plays short, AI
 * reshapes; keeper sent off -> bench keeper replaces an outfield player, or with no subs left an outfield player
 * goes in goal), forfeit (below 7 players -> 3-0, FORFEIT). Maintains team.roster / onPitch / keeperSlot.
 * Never 12 players. Emits SUBSTITUTION.
 *
 * Implementation notes (RUL-10):
 *  - Slots are containers: a substitution puts the incoming squad member into the outgoing player's slot, so the
 *    slot keeps its formation position (formIdx, role, x/z) and a team can never field more than 11. A sent-off slot
 *    stays inactive (parked off the pitch) for the rest of the match.
 *  - requestSub validates (team 0/1, slot active on that team, roster BENCH, subsUsed + pending < MAX_SUBS, neither
 *    the slot nor the squad member already queued, match not over / forfeited / in a shoot-out, keeper rule) and
 *    queues into team.subOut / subIn / subCount. Stale queue entries (out player sent off, ...) are pruned first.
 *  - Keeper rule: a keeper can only be replaced by a keeper and a bench keeper can only replace the keeper. The one
 *    exception is a keeper sent off: sendOff then brings the bench keeper on for an outfield player itself.
 *  - subsTick applies the queue in order at any stoppage (restart phase or cut-scene; never IN_PLAY, SHOOT_OUT or
 *    POST_MATCH), re-validating each entry (invalid entries are dropped). An entry whose out player is the restart
 *    taker in the middle of taking it is deferred; it stays queued and is applied at a later stoppage tick. Waiting
 *    (applied at once) = no action, the SET_PIECE wait, or a THROW_IN not yet committed (RUL-02 sub-states APPROACH,
 *    HOLD, CHARGE: the thrower is in ActionKind.THROW_IN for the whole phase); busy = any kick action, a committed
 *    throw (WINDUP or released), or down. Applying: action ended (interrupted) and ball released if he had it (a
 *    throw-in taker's action ends first so RUL-02 puts the ball he holds back on the line), roster
 *    out -> SUBBED_OFF and in -> PLAYING, rosterIdx, copyAttrs (src/sim/init.ts), stamina 1, no yellow card, motion
 *    and stun cleared, role GK / isKeeper / keeperSlot when a keeper comes on, control released through SIM-16
 *    releasePlayer (which re-picks at once), subsUsed++, SUBSTITUTION (a = team, b = slot, c = in roster index,
 *    d = out roster index).
 *  - sendOff: ball released, action ended (same order as above), active = 0, parked off the pitch (LOCAL_TUNING park spot, near-side
 *    touchline beyond the boards, one spot per slot), motion cleared, roster SENT_OFF, onPitch--, team / ball /
 *    controller references to him cleared (chaser, press/cover, support/run/pass-and-go calls, pass target, receiver,
 *    second defender), queued subs for him dropped. A keeper sent off is replaced: the bench keeper (if a substitution
 *    is left and the team is not forfeiting) comes on for the most advanced outfield player (formation nx; avoids
 *    the ball owner and the restart taker) and is placed in his goal mouth; otherwise the outfield player with the
 *    best gk attributes (sum of the five gk* attributes, then height, then lower slot) goes in goal (no teleport;
 *    keeper AI walks him back). New keepers get formIdx 0 (keeper home, kick-off placement), role GK, keeperSlot.
 *    Then control is released (SIM-16 re-picks), the team shape is invalidated (TAI-01 reshapes for fewer players)
 *    and checkForfeit runs.
 *  - checkForfeit counts active players (the truth the invariants use) and flags the first team below MIN_PLAYERS:
 *    match.forfeitTeam + FORFEIT. Never in practice modes, after the match is finished or twice. RUL-01 applies the
 *    3-0 and ends the match.
 *  - Per-tick cost: subsTick returns at once when both queues are empty; checkForfeit is O(22). No allocation.
 *
 * Extra exports: canRequestSub (pure validation for menus), isSubStoppage, subsLeft, LOCAL_TUNING.
 */
import {
  HALF_LENGTH, MAX_SUBS, MIN_PLAYERS, NUM_CONTROLLERS, NUM_SLOTS, PLAYERS_PER_TEAM, SQUAD_SIZE, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, AiJob, MatchPhase, ModeId, PracticeKind, RestartKind, Role } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { MoveMode, RosterStatus, type PlayerState, type SimState } from '../../contracts/state';
import { getFormation } from '../../data/formations';
import { invalidateShape } from '../../ai/shape';
import { endAction } from '../actions/dispatch';
import { releasePlayer } from '../control/switching';
import { releasePossession } from '../core/kick';
import { copyAttrs } from '../init';
// ThrowState is only read at tick time (never while modules evaluate), so the import cycle subs -> throwin ->
// restart -> machine -> subs is harmless; throwin.ts is already in this module's graph through actions/dispatch.
import { ThrowState } from './throwin';

/** TUNING-CR (RUL-10): proposed additions to T_RULES (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Parking spot of players who left the pitch: z (m), near-side touchline beyond the boards (BOARD_Z = 40) and
   *  inside the world bounds (WORLD_MAX_Z = 44). */
  parkZ: 42,
  /** Parking x: the first spot is this far from the halfway line on the team's own side (team 0 at -x), m ... */
  parkX0: 2,
  /** ... and each further slot of the team this much further along, m. */
  parkDX: 1.5,
  /** A keeper coming on from the bench after a red card is placed this far in front of his goal line, centred, m. */
  keeperSpawnDepth: 1,
} as const;

// ---------------------------------------------------------------- helpers

function isIndex(v: number, n: number): boolean {
  return v >= 0 && v < n && v === Math.floor(v);
}

function isPractice(s: SimState): boolean {
  return s.config.mode === ModeId.PRACTICE || s.config.practice !== PracticeKind.NONE;
}

function isRestartPhase(phase: MatchPhase): boolean {
  return phase === MatchPhase.KICK_OFF || (phase >= MatchPhase.THROW_IN && phase <= MatchPhase.PENALTY);
}

/**
 * Phases in which queued substitutions are applied: every restart phase (KICK_OFF, THROW_IN, GOAL_KICK, CORNER,
 * FREE_KICK, PENALTY) and every cut-scene / break before the end (PRE_MATCH, GOAL, CELEBRATION, REPLAY,
 * HALF_TIME, FULL_TIME, EXTRA_TIME). Never IN_PLAY, SHOOT_OUT or POST_MATCH.
 */
export function isSubStoppage(phase: MatchPhase): boolean {
  switch (phase) {
    case MatchPhase.PRE_MATCH:
    case MatchPhase.KICK_OFF:
    case MatchPhase.THROW_IN:
    case MatchPhase.GOAL_KICK:
    case MatchPhase.CORNER:
    case MatchPhase.FREE_KICK:
    case MatchPhase.PENALTY:
    case MatchPhase.GOAL:
    case MatchPhase.CELEBRATION:
    case MatchPhase.REPLAY:
    case MatchPhase.HALF_TIME:
    case MatchPhase.FULL_TIME:
    case MatchPhase.EXTRA_TIME:
      return true;
    default:
      return false;
  }
}

/** Substitutions a team can still request (MAX_SUBS - used - queued), >= 0. */
export function subsLeft(s: SimState, team: number): number {
  if (team !== 0 && team !== 1) return 0;
  const t = s.teams[team]!;
  const n = MAX_SUBS - t.subsUsed - queueLen(s, team);
  return n > 0 ? n : 0;
}

function queueLen(s: SimState, team: number): number {
  const t = s.teams[team]!;
  const n = t.subCount;
  const cap = t.subOut.length < t.subIn.length ? t.subOut.length : t.subIn.length;
  return isIndex(n, cap + 1) ? n : n > cap ? cap : 0;
}

/** Number of active players of a team. */
function activeCount(s: SimState, team: number): number {
  const first = teamFirstSlot(team);
  let n = 0;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (s.players[i]!.active === 1) n++;
  return n;
}

function isBenchKeeper(s: SimState, team: number, roster: number): boolean {
  const d = s.squads[team]?.[roster];
  return d !== undefined && d.pos === Role.GK;
}

/** The substitution itself is legal now (ignores the queue and the sub count). */
function subValid(s: SimState, team: number, outSlot: number, inRoster: number): boolean {
  if (!isIndex(outSlot, NUM_SLOTS) || !isIndex(inRoster, SQUAD_SIZE)) return false;
  const p = s.players[outSlot]!;
  if (p.active !== 1 || p.team !== team) return false;
  const t = s.teams[team]!;
  if (inRoster >= t.roster.length || t.roster[inRoster] !== RosterStatus.BENCH) return false;
  if (s.squads[team]?.[inRoster] === undefined) return false;
  // Keeper rule: a keeper only for a keeper (a keeper sent off is handled by sendOff, not by a queued sub).
  return (p.isKeeper === 1) === isBenchKeeper(s, team, inRoster);
}

/** Drop queued entries that can no longer apply (and any beyond the remaining substitutions). */
function pruneQueue(s: SimState, team: number): void {
  const t = s.teams[team]!;
  const n = queueLen(s, team);
  let keep = 0;
  for (let i = 0; i < n; i++) {
    const out = t.subOut[i]!;
    const inR = t.subIn[i]!;
    if (t.subsUsed + keep >= MAX_SUBS || !subValid(s, team, out, inR)) continue;
    t.subOut[keep] = out;
    t.subIn[keep] = inR;
    keep++;
  }
  clearQueueFrom(s, team, keep);
}

function clearQueueFrom(s: SimState, team: number, keep: number): void {
  const t = s.teams[team]!;
  for (let i = keep; i < t.subOut.length; i++) t.subOut[i] = -1;
  for (let i = keep; i < t.subIn.length; i++) t.subIn[i] = -1;
  t.subCount = keep;
}

/**
 * The restart taker is still waiting to take it: no action, the SET_PIECE wait, or a THROW_IN not yet committed
 * (RUL-02 keeps the thrower in ActionKind.THROW_IN for the whole phase; APPROACH / HOLD / CHARGE are its waiting
 * sub-states, and its end handler puts a held ball back on the line).
 */
function takerWaiting(p: Readonly<PlayerState>): boolean {
  if (p.act === ActionKind.NONE || p.act === ActionKind.SET_PIECE) return true;
  if (p.act !== ActionKind.THROW_IN || p.actDone !== 0) return false;
  return p.actA === ThrowState.APPROACH || p.actA === ThrowState.HOLD || p.actA === ThrowState.CHARGE;
}

/**
 * The restart taker is in the middle of taking the restart (kick started, throw committed: WINDUP or released; or
 * he is down): his substitution waits.
 */
function takerBusy(s: SimState, slot: number): boolean {
  const m = s.match;
  const r = m.restart;
  if (!isRestartPhase(m.phase) || r.taken === 1 || r.taker !== slot) return false;
  return !takerWaiting(s.players[slot]!);
}

/** Ball no longer with `slot` (possession and hands). */
function takeBallFrom(s: SimState, slot: number, ev: EventSink): void {
  const b = s.ball;
  if (b.owner === slot) releasePossession(s, ev);
  if (b.heldBy === slot) {
    ev.emit(EventType.KEEPER_HANDS, slot, 0);
    b.heldBy = -1;
  }
}

/**
 * `slot` leaves whatever he was doing and gives up the ball. A throw-in taker's action ends first so RUL-02 puts the
 * ball he holds back on the line (otherwise it would be left hanging at head height); everyone else gives the ball up
 * first (keeper hands: KEEPER_HANDS), then the action ends (interrupted).
 */
function stopPlayer(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (p.act === ActionKind.THROW_IN) endAction(s, slot, 1);
  takeBallFrom(s, slot, ev);
  if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
}

/** Motion, intent, stun and AI-job state of a player who just came on or went off. */
function resetBody(p: PlayerState): void {
  p.vx = 0; p.vz = 0;
  p.moveMode = MoveMode.STOP;
  p.ix = 0; p.iz = 0;
  p.tgtX = p.x; p.tgtZ = p.z; p.tgtSpeed = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  p.sprinting = 0; p.jockeying = 0; p.shielding = 0;
  p.stunT = 0;
  p.touchCd = 0;
  p.noTouchT = 0;
  p.job = AiJob.NONE;
  p.jobT = 0;
  p.jobSlot = -1;
}

/** Release whichever controller holds `slot` (SIM-16 re-picks at once). Always when `force`. */
function releaseControl(s: SimState, slot: number, force: boolean, ev: EventSink): void {
  let held = force || s.players[slot]!.ctrl !== -1;
  for (let k = 0; k < NUM_CONTROLLERS && !held; k++) if (s.ctrl[k]!.slot === slot) held = true;
  if (held) releasePlayer(s, slot, ev);
}

/**
 * Put squad member `inRoster` into `slot` (no validation). `keeperSpawn` = a bench keeper coming on for an outfield
 * player after a red card: formation keeper index and placed in his goal mouth. Emits SUBSTITUTION.
 */
function substitute(s: SimState, slot: number, inRoster: number, keeperSpawn: boolean, ev: EventSink): void {
  const p = s.players[slot]!;
  const team = p.team;
  const t = s.teams[team]!;
  const outRoster = p.rosterIdx;
  stopPlayer(s, slot, ev);
  if (isIndex(outRoster, t.roster.length)) t.roster[outRoster] = RosterStatus.SUBBED_OFF;
  t.roster[inRoster] = RosterStatus.PLAYING;
  p.rosterIdx = inRoster;
  copyAttrs(s.attrs[slot]!, s.squads[team]![inRoster]!);
  p.stamina = 1;
  p.yellow = 0;
  p.lastTouchTick = -1;
  if (keeperSpawn) {
    const dir = t.dir === -1 ? -1 : 1;
    p.formIdx = 0;
    p.x = -dir * (HALF_LENGTH - LOCAL_TUNING.keeperSpawnDepth);
    p.z = 0;
    p.fx = dir;
    p.fz = 0;
  }
  resetBody(p);
  if (isBenchKeeper(s, team, inRoster)) {
    p.isKeeper = 1;
    p.role = Role.GK;
    t.keeperSlot = slot;
  }
  t.subsUsed++;
  releaseControl(s, slot, false, ev);
  ev.emit(EventType.SUBSTITUTION, team, slot, inRoster, outRoster);
}

// ---------------------------------------------------------------- substitutions

/**
 * Pure validation of a substitution request (for menus): 1 if requestSub would accept it now. Does not prune stale
 * queue entries, so it may refuse where requestSub (which prunes first) accepts.
 */
export function canRequestSub(s: SimState, team: number, outSlot: number, inRoster: number): number {
  if (team !== 0 && team !== 1) return 0;
  if (!isIndex(outSlot, NUM_SLOTS) || !isIndex(inRoster, SQUAD_SIZE)) return 0;
  const m = s.match;
  if (m.finished === 1 || m.forfeitTeam >= 0) return 0;
  if (m.phase === MatchPhase.SHOOT_OUT || m.phase === MatchPhase.POST_MATCH) return 0;
  const t = s.teams[team]!;
  const n = queueLen(s, team);
  if (n >= t.subOut.length || n >= t.subIn.length) return 0;
  if (t.subsUsed + n >= MAX_SUBS) return 0;
  for (let i = 0; i < n; i++) if (t.subOut[i] === outSlot || t.subIn[i] === inRoster) return 0;
  return subValid(s, team, outSlot, inRoster) ? 1 : 0;
}

/** Queue a substitution; returns 1 if accepted (valid, subs left, not already queued). */
export function requestSub(s: SimState, team: number, outSlot: number, inRoster: number): number {
  if (team !== 0 && team !== 1) return 0;
  pruneQueue(s, team);
  if (canRequestSub(s, team, outSlot, inRoster) !== 1) return 0;
  const t = s.teams[team]!;
  const n = t.subCount;
  t.subOut[n] = outSlot;
  t.subIn[n] = inRoster;
  t.subCount = n + 1;
  return 1;
}

/** Apply a team's queue in order (stoppage only). Invalid entries are dropped, a busy taker's entry deferred. */
function applyQueue(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  const n = queueLen(s, team);
  let keep = 0;
  for (let i = 0; i < n; i++) {
    const out = t.subOut[i]!;
    const inR = t.subIn[i]!;
    if (t.subsUsed >= MAX_SUBS || !subValid(s, team, out, inR)) continue;
    if (takerBusy(s, out)) {
      t.subOut[keep] = out;
      t.subIn[keep] = inR;
      keep++;
      continue;
    }
    substitute(s, out, inR, false, ev);
  }
  clearQueueFrom(s, team, keep);
}

export function subsTick(s: SimState, ev: EventSink): void {
  const t0 = s.teams[0]!;
  const t1 = s.teams[1]!;
  if (t0.subCount === 0 && t1.subCount === 0) return;
  const m = s.match;
  if (m.finished === 1 || m.forfeitTeam >= 0 || m.phase === MatchPhase.POST_MATCH) {
    // The match is over: queued substitutions never apply.
    clearQueueFrom(s, 0, 0);
    clearQueueFrom(s, 1, 0);
    return;
  }
  if (!isSubStoppage(m.phase)) return;
  if (t0.subCount !== 0) applyQueue(s, 0, ev);
  if (t1.subCount !== 0) applyQueue(s, 1, ev);
}

// ---------------------------------------------------------------- sending off

/** Clear every team / ball / controller reference to a player who left the pitch. */
function clearReferences(s: SimState, slot: number): void {
  const t = s.teams[s.players[slot]!.team]!;
  if (t.chaser === slot) { t.chaser = -1; t.chaserT = 0; }
  if (t.pressSlot === slot) t.pressSlot = -1;
  if (t.coverSlot === slot) t.coverSlot = -1;
  if (t.supportSlot === slot) { t.supportSlot = -1; t.supportCallT = 0; }
  if (t.runSlot === slot) { t.runSlot = -1; t.runCallT = 0; }
  if (t.passGoSlot === slot) { t.passGoSlot = -1; t.passGoT = 0; }
  if (s.ball.passTarget === slot) s.ball.passTarget = -1;
  for (let k = 0; k < NUM_CONTROLLERS; k++) {
    const c = s.ctrl[k]!;
    if (c.receiver === slot) c.receiver = -1;
    if (c.secondDef === slot) c.secondDef = -1;
  }
}

/** Parking spot off the pitch for a slot (unique per slot, inside the world bounds). */
function park(p: PlayerState): void {
  const idx = p.slot - teamFirstSlot(p.team);
  const side = p.team === 0 ? -1 : 1;
  p.x = side * (LOCAL_TUNING.parkX0 + idx * LOCAL_TUNING.parkDX);
  p.z = LOCAL_TUNING.parkZ;
  p.fx = 0;
  p.fz = -1;
}

/** Most advanced active outfield player (formation nx; ties: lower slot), avoiding the ball owner and the taker. */
function sacrificeOutfielder(s: SimState, team: number): number {
  const form = getFormation(s.teams[team]!.formation);
  const first = teamFirstSlot(team);
  const r = s.match.restart;
  const taker = isRestartPhase(s.match.phase) && r.taken === 0 ? r.taker : -1;
  for (let pass = 0; pass < 2; pass++) {
    let best = -1;
    let bestNx = -1e9;
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.isKeeper === 1) continue;
      if (pass === 0 && (i === s.ball.owner || i === taker)) continue;
      const fs = form.slots[p.formIdx] ?? form.slots[0]!;
      if (fs.nx > bestNx) { best = i; bestNx = fs.nx; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Active outfield player with the best goalkeeping (sum of gk attributes, then height, then lower slot). */
function bestGkOutfielder(s: SimState, team: number): number {
  const first = teamFirstSlot(team);
  let best = -1;
  let bestScore = -1;
  let bestH = -1;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    const a = s.attrs[i]!;
    const sc = a.gkDiving + a.gkHandling + a.gkReflexes + a.gkPositioning + a.gkKicking;
    if (sc > bestScore || (sc === bestScore && a.height > bestH)) { best = i; bestScore = sc; bestH = a.height; }
  }
  return best;
}

/** First bench keeper of a team (lowest squad index), -1 none. */
function benchKeeper(s: SimState, team: number): number {
  const t = s.teams[team]!;
  for (let r = 0; r < t.roster.length; r++) {
    if (t.roster[r] === RosterStatus.BENCH && isBenchKeeper(s, team, r)) return r;
  }
  return -1;
}

/** Make an active outfield player the team's keeper. */
function makeKeeper(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const t = s.teams[p.team]!;
  const m = s.match;
  const r = m.restart;
  // A keeper may not take a throw-in: free him (RUL-11 re-picks the taker).
  if (isRestartPhase(m.phase) && r.taken === 0 && r.taker === slot && r.kind === RestartKind.THROW_IN) {
    stopPlayer(s, slot, ev);
  }
  p.isKeeper = 1;
  p.role = Role.GK;
  p.formIdx = 0;
  t.keeperSlot = slot;
}

/** The keeper was sent off: bench keeper for an outfield player (a substitution), else an outfielder in goal. */
function replaceKeeper(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  const forfeiting = !isPractice(s) && activeCount(s, team) < MIN_PLAYERS;
  const bk = forfeiting || t.subsUsed >= MAX_SUBS ? -1 : benchKeeper(s, team);
  if (bk >= 0) {
    const out = sacrificeOutfielder(s, team);
    if (out >= 0) {
      substitute(s, out, bk, true, ev);
      return;
    }
  }
  const g = bestGkOutfielder(s, team);
  if (g >= 0) makeKeeper(s, g, ev);
}

/** Send a player off: the team plays short (keeper replaced if he was the keeper), then the forfeit check. */
export function sendOff(s: SimState, slot: number, ev: EventSink): void {
  if (!isIndex(slot, NUM_SLOTS)) return;
  const p = s.players[slot]!;
  if (p.active !== 1 || (p.team !== 0 && p.team !== 1)) return;
  const team = p.team;
  const t = s.teams[team]!;
  const wasKeeper = p.isKeeper === 1 || t.keeperSlot === slot;
  stopPlayer(s, slot, ev);
  p.active = 0;
  p.isKeeper = 0;
  park(p);
  resetBody(p);
  if (isIndex(p.rosterIdx, t.roster.length)) t.roster[p.rosterIdx] = RosterStatus.SENT_OFF;
  t.onPitch = activeCount(s, team);
  clearReferences(s, slot);
  if (wasKeeper) replaceKeeper(s, team, ev);
  pruneQueue(s, team);
  releaseControl(s, slot, true, ev);
  invalidateShape(s, team);
  checkForfeit(s, ev);
}

// ---------------------------------------------------------------- forfeit

/** Ends the match 3-0 when a team is below MIN_PLAYERS. Returns 1 if it did. */
export function checkForfeit(s: SimState, ev: EventSink): number {
  const m = s.match;
  if (m.forfeitTeam === 0 || m.forfeitTeam === 1 || m.finished === 1 || isPractice(s)) return 0;
  if (m.phase === MatchPhase.POST_MATCH) return 0;
  for (let team = 0; team < 2; team++) {
    if (activeCount(s, team) < MIN_PLAYERS) {
      m.forfeitTeam = team;
      ev.emit(EventType.FORFEIT, team);
      return 1;
    }
  }
  return 0;
}

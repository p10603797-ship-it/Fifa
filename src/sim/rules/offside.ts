/**
 * [RUL-08] Offside (config.offside). Judged at the moment a teammate plays the ball (ball.lastKickTick === tick
 * and the kick is not a goal kick / throw-in / corner, i.e. the phase at that tick is IN_PLAY or FREE_KICK...),
 * against the second-last defender, the ball and the halfway line, with T_RULES.offsideMargin benefit to the
 * attacker. Flags players in s.match.offside.flags; calls it only when a flagged player becomes involved
 * (touches the ball / challenges / receives); restart = indirect-as-direct free kick where he was. Never in his
 * own half. Emits OFFSIDE.
 *
 * Implementation notes (RUL-08):
 *  - offsideTick runs first in rulesTick (clock phases only). Order per tick: (0) the late snapshot of a safety-net
 *    free kick from the previous tick (see below); (1) involvement of a flagged player (his touch this tick; a
 *    ChallengeRecord he made after the pass; the intended receiver within LOCAL_TUNING.receiverReach of a playable
 *    ball) -> OFFSIDE + free kick to the defending team at his position (RUL-11 awardRestart; it clears the flags);
 *    (2) resets: a touch by an unflagged teammate (a new phase of play), a deliberate play or possession by an
 *    opponent, the ball over a line; otherwise the save window may close (see below); (3) a new snapshot when the
 *    ball was played this tick.
 *  - Snapshot moments: a pass / cross / through ball / shot / header / volley / clearance / keeper throw or kick /
 *    direct free-kick shot (PLAY_KIND), while the phase at that tick is IN_PLAY, or FREE_KICK with the free kick
 *    taken this tick. Dribble, skill and first touches, knock-ons, deflections, tackle pokes, saves and the
 *    restart kinds without offside (goal kick, throw-in, kick-off, penalty) never snapshot; THROW_IN, GOAL_KICK,
 *    CORNER, KICK_OFF and PENALTY phases clear the flags.
 *  - Offside position (attack frame u = dir * x of the attacking team): u > max(second-last defender, ball, 0) +
 *    offsideMargin. Level is onside, the margin is the attacker's benefit, his own half is never offside, behind
 *    the ball is never offside. The keeper counts as a defender; sent-off (inactive) players count for nobody.
 *  - The snapshot runs in rulesTick, after a kick made in actionsTick has already been followed by one tick of
 *    locomotion and ball flight. The attacker gets the benefit of that one-tick window: each player is judged at
 *    the more favourable of his position now and one tick earlier (x - vx * DT), and the ball at the more
 *    advanced of ball.px / ball.x. In a static scene this is exactly isOffsidePosition().
 *  - Not deliberate (flags kept): a deflection or rebound off an opponent (DEFLECTION, or a touch without a kick),
 *    a keeper parry / tip, and a save: the first contact by the defending team after an on-target shot that set
 *    the flags (any kind but taking possession). Everything else an opponent does with the ball resets offside.
 *    A save that is also a pass kind (a headed / kicked clearance off the line) keeps the attackers' snapshot and
 *    starts none for the defending team (one snapshot at a time; the attackers' offside is the one that matters).
 *  - Save window: open while the flags come from an on-target shot nobody has met yet (ball.shotTick ===
 *    offside.passTick, shotOnTarget). It closes, by moving offside.passTick to the current tick, at the first
 *    contact that keeps the flags (save, block, deflection, parry, tip) and when the ball stops going toward the
 *    goal without a contact (off the woodwork, or rolling to a stop: goalward speed <= saveMinGoalSpeed). After that
 *    no contact is a save, so the next deliberate play by the defending team resets offside, also when it is the
 *    player who made the first contact. passTick is therefore "the tick involvement is judged from" (only this
 *    module reads it; challenges before it were already judged on their own tick).
 *  - Safety-net free kick: RUL-11 forceRestartKick (restartTick or watchdogTick) kicks after this tick's offsideTick
 *    and the phase is IN_PLAY by the next tick. Such a free kick (previous tick, phase entered from FREE_KICK one
 *    tick ago, kicked by the restart taker, not yet judged) is judged on the next tick with the same one-tick
 *    benefit window (the players and the ball have moved exactly one tick since the kick, as on the normal path).
 *  - Event: OFFSIDE a = offside slot, x/z = the restart spot (his position made legal by RUL-11), emitted after
 *    awardRestart has set up the free kick (so RESTART_AWARDED / WHISTLE come first in the tick's events).
 *  - Allocation-free; the per-tick cost is O(MAX_CHALLENGES) without a kick, O(22) on a kick tick.
 */
import { DT, HALF_LENGTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
import { ActionKind, CrossKind, KickKind, MatchPhase, RestartKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { T_RULES } from '../../contracts/tuning';
import { awardRestart } from './restart';

/** TUNING-CR (RUL-08): proposed additions to T_RULES (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** A flagged intended receiver is involved once the ball is this close to him, horizontal m (brief: 2 m). */
  receiverReach: 2,
  /** ... and no higher than this, m (a ball he could still head; higher balls fly over him). */
  receiverMaxBallHeight: 2.6,
  /**
   * An on-target shot whose speed toward the centre of the goal drops to this or less without a contact (off the
   * woodwork, or rolling to a stop) is no longer "going into the goal": the save window closes, m/s.
   */
  saveMinGoalSpeed: 0.5,
} as const;

/** Kick kinds that are a teammate "playing" the ball for offside: PLAY_KIND[kind] = 1. */
const PLAY_KIND = new Uint8Array(64);
for (let k = KickKind.GROUND_PASS; k <= KickKind.CLEARANCE; k++) PLAY_KIND[k] = 1; // passes .. shots .. headers, volleys
for (let k = KickKind.GK_THROW; k <= KickKind.GK_DRIVEN_KICK; k++) PLAY_KIND[k] = 1; // keeper distribution
PLAY_KIND[KickKind.FREE_KICK_SHOT] = 1;

/** Sentinel for "no player" in attack-frame comparisons. */
const NONE_U = -1e9;

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === (slot | 0);
}

/** True if `slot` is flagged by the current snapshot (and still belongs to the passing team). */
function isFlagged(s: SimState, slot: number): boolean {
  const o = s.match.offside;
  if (!validSlot(slot) || ((o.flags >>> slot) & 1) === 0) return false;
  const p = s.players[slot]!;
  return p.active === 1 && p.team === o.passTeam;
}

/**
 * Offside limit for attackers of `team` in their attack frame (u = dir * x): max(second-last defender, ball, 0).
 * `bracket` = 1 judges the one-tick window of a snapshot (defenders at their more advanced of now / one tick
 * earlier, ball at the more advanced of x / px); 0 uses the positions as they are. Returns +1e9 with no defenders.
 */
function offsideLimitU(s: SimState, team: number, bracket: number): number {
  const dir = s.teams[team]!.dir;
  const def = other(team);
  let first = NONE_U;
  let second = NONE_U;
  const start = teamFirstSlot(def);
  const end = start + PLAYERS_PER_TEAM;
  for (let i = start; i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    let u = dir * p.x;
    if (bracket === 1) {
      const u0 = dir * (p.x - p.vx * DT);
      if (u0 > u) u = u0;
    }
    if (u > first) { second = first; first = u; } else if (u > second) second = u;
  }
  if (first <= NONE_U) return 1e9;
  const line = second <= NONE_U ? first : second;
  const b = s.ball;
  let ub = dir * b.x;
  if (bracket === 1) {
    const ub0 = dir * b.px;
    if (ub0 > ub) ub = ub0;
  }
  let lim = line > ub ? line : ub;
  if (lim < 0) lim = 0;
  return lim;
}

/** Attack-frame position of a player: now, or (bracket = 1) the less advanced of now / one tick earlier. */
function attackerU(s: SimState, slot: number, dir: number, bracket: number): number {
  const p = s.players[slot]!;
  let u = dir * p.x;
  if (bracket === 1) {
    const u0 = dir * (p.x - p.vx * DT);
    if (u0 < u) u = u0;
  }
  return u;
}

/**
 * World x of the offside line for attackers of `team` right now: the more advanced (toward the goal they attack)
 * of the second-last defender, the ball and the halfway line, without the margin. Pure; for AI and debug views.
 */
export function offsideLineX(s: SimState, team: number): number {
  const t = team === 1 ? 1 : 0;
  return s.teams[t]!.dir * offsideLimitU(s, t, 0);
}

/** True if slot is in an offside position right now (ignores involvement). Pure. */
export function isOffsidePosition(s: SimState, slot: number): boolean {
  if (s.config.offside === 0 || !validSlot(slot)) return false;
  const p = s.players[slot]!;
  if (p.active !== 1 || (p.team !== 0 && p.team !== 1)) return false;
  const dir = s.teams[p.team]!.dir;
  return dir * p.x > offsideLimitU(s, p.team, 0) + T_RULES.offsideMargin;
}

/**
 * Take the snapshot for a ball played by `kicker` at `kickTick` (this tick, or the previous one for a safety-net free
 * kick; either way the scene has moved exactly one tick since the kick).
 */
function snapshot(s: SimState, kicker: number, kickTick: number): void {
  const o = s.match.offside;
  const team = s.players[kicker]!.team === 1 ? 1 : 0;
  const dir = s.teams[team]!.dir;
  const lim = offsideLimitU(s, team, 1) + T_RULES.offsideMargin;
  let flags = 0;
  const start = teamFirstSlot(team);
  const end = start + PLAYERS_PER_TEAM;
  for (let i = start; i < end; i++) {
    if (i === kicker || s.players[i]!.active !== 1) continue;
    if (attackerU(s, i, dir, 1) > lim) flags |= 1 << i;
  }
  o.flags = flags;
  o.passTick = kickTick;
  o.passTeam = team;
  o.passBy = kicker;
}

/** True when the last kick is of a kind offside is judged from. */
function isPlayKind(k: number): boolean {
  return k >= 0 && k < PLAY_KIND.length && PLAY_KIND[k] === 1;
}

/** True when the ball was played this tick by a kick that offside is judged from (phase checked by the caller). */
function playedThisTick(s: SimState): boolean {
  const b = s.ball;
  const k = b.lastKickBy;
  return b.lastKickTick === s.tick && validSlot(k) && b.lastTouch === k && b.lastTouchTick === s.tick &&
    isPlayKind(b.lastKickKind) && s.players[k]!.active === 1;
}

/**
 * The kicker of a free kick taken on the previous tick by RUL-11's safety net (forceRestartKick runs after
 * offsideTick, and the phase is IN_PLAY by now) that has not been judged yet, else -1. Call in IN_PLAY only.
 */
function unjudgedFreeKick(s: SimState): number {
  const m = s.match;
  const r = m.restart;
  const b = s.ball;
  const k = b.lastKickBy;
  const t = s.tick - 1;
  if (m.prevPhase !== MatchPhase.FREE_KICK || m.phaseT !== 1 || b.lastKickTick !== t || m.offside.passTick === t) return -1;
  if (!validSlot(k) || k !== r.taker || r.taken !== 1 || !isPlayKind(b.lastKickKind)) return -1;
  const p = s.players[k]!;
  return p.active === 1 && p.team === r.team ? k : -1;
}

/**
 * True while the flags come from an on-target shot that nobody has met yet: the next contact by the defending team
 * is a save (flags kept). Closed by closeSaveWindow at the first such contact or when the shot stops going in.
 */
function saveWindowOpen(s: SimState): boolean {
  const b = s.ball;
  const o = s.match.offside;
  return o.passTick >= 0 && b.shotTick === o.passTick && b.shotOnTarget === 1;
}

/** The shot has been met (or is no longer going in): from now on involvement is judged from this tick. */
function closeSaveWindow(s: SimState): void {
  s.match.offside.passTick = s.tick;
}

/** Ball speed toward the centre of the goal the passing team attacks, m/s (negative: away from it). */
function goalwardSpeed(s: SimState): number {
  const b = s.ball;
  const team = s.match.offside.passTeam === 1 ? 1 : 0;
  const dx = s.teams[team]!.dir * HALF_LENGTH - b.x;
  const dz = -b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return 0;
  return (dx * b.vx + dz * b.vz) / d;
}

/** A flagged player who challenged an opponent after the pass (ChallengeRecord), or -1. */
function flaggedChallenger(s: SimState): number {
  const m = s.match;
  const o = m.offside;
  const recs = m.challenges;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.active !== 1 || r.tick <= o.passTick || r.tick > s.tick || !isFlagged(s, r.tackler)) continue;
    if (validSlot(r.victim) && s.players[r.victim]!.team === o.passTeam) continue; // not an opponent
    return r.tackler;
  }
  return -1;
}

/** True when any player touched the ball strictly between ticks t0 and t1. */
function touchedBetween(s: SimState, t0: number, t1: number): boolean {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const t = s.players[i]!.lastTouchTick;
    if (t > t0 && t < t1) return true;
  }
  return false;
}

/** True when this tick's touch by opponent `slot` of the passing team is a deliberate play (resets offside). */
function playedDeliberately(s: SimState, slot: number): boolean {
  const b = s.ball;
  const o = s.match.offside;
  if (b.owner === slot) return true; // gained possession (incl. a keeper catch)
  if (b.lastKickTick !== s.tick || b.lastKickBy !== slot) return false; // a deflection / rebound off him
  const k = b.lastKickKind;
  if (k === KickKind.DEFLECTION || k === KickKind.GK_PARRY || k === KickKind.GK_TIP) return false;
  // A save: the first contact after an on-target shot that set the flags (the window closes at any contact; the
  // touch scan also covers a contact this module did not see on its own tick).
  if (saveWindowOpen(s) && !touchedBetween(s, o.passTick, s.tick)) return false;
  return true;
}

/** True when the flagged intended receiver `slot` is within reach of a playable ball. */
function receiverArrives(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP) return false;
  const b = s.ball;
  if (b.y > LOCAL_TUNING.receiverMaxBallHeight) return false;
  const dx = b.x - p.x;
  const dz = b.z - p.z;
  const r = LOCAL_TUNING.receiverReach;
  return dx * dx + dz * dz <= r * r;
}

/** Penalise `slot`: free kick to the defending team where he is, OFFSIDE event. Returns 1 if awarded. */
function callOffside(s: SimState, slot: number, ev: EventSink): number {
  const m = s.match;
  const p = s.players[slot]!;
  const def = other(p.team);
  m.offside.flags = 0;
  awardRestart(s, RestartKind.FREE_KICK, def, p.x, p.z, ev);
  const r = m.restart;
  if (m.phase !== MatchPhase.FREE_KICK || r.kind !== RestartKind.FREE_KICK || r.team !== def || r.taken !== 0) return 0;
  ev.emit(EventType.OFFSIDE, slot, 0, 0, 0, r.x, 0, r.z);
  return 1;
}

/** IN_PLAY with flags set: involvement (returns 1 when offside was given) and resets. */
function checkInvolvement(s: SimState, ev: EventSink): number {
  const b = s.ball;
  const o = s.match.offside;
  const touch = b.lastTouchTick === s.tick && validSlot(b.lastTouch) ? b.lastTouch : -1;
  // (1) a flagged player plays, receives, heads or is hit by the ball
  if (touch >= 0 && isFlagged(s, touch)) return callOffside(s, touch, ev);
  // (2) a flagged player challenges an opponent for it
  const c = flaggedChallenger(s);
  if (c >= 0) return callOffside(s, c, ev);
  // (3) this tick's touch: an unflagged teammate starts a new phase of play; an opponent's deliberate play resets;
  // an opponent's save / block / deflection / parry keeps the flags and closes the save window (the shot is met)
  if (touch >= 0) {
    if (s.players[touch]!.team === o.passTeam || playedDeliberately(s, touch)) {
      o.flags = 0;
      return 0;
    }
    if (saveWindowOpen(s)) closeSaveWindow(s);
  }
  // (4) any opponent in possession
  const own = b.owner;
  if (validSlot(own) && s.players[own]!.team !== o.passTeam) {
    o.flags = 0;
    return 0;
  }
  // (5) the intended receiver arriving at the ball
  const rcv = b.passTarget;
  if (isFlagged(s, rcv) && receiverArrives(s, rcv)) return callOffside(s, rcv, ev);
  // (6) an unmet on-target shot that stopped going in (woodwork, or rolling to a stop) can no longer be saved
  if (touch < 0 && saveWindowOpen(s) && goalwardSpeed(s) <= LOCAL_TUNING.saveMinGoalSpeed) closeSaveWindow(s);
  return 0;
}

export function offsideTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const o = m.offside;
  if (s.config.offside === 0) {
    o.flags = 0;
    return;
  }
  const phase = m.phase;
  if (phase === MatchPhase.IN_PLAY) {
    // A safety-net free kick from the previous tick is judged now (before this tick's involvement).
    const fk = s.ball.cross === CrossKind.NONE ? unjudgedFreeKick(s) : -1;
    if (fk >= 0) snapshot(s, fk, s.tick - 1);
    if (o.flags !== 0 && checkInvolvement(s, ev) === 1) return;
  } else {
    // Dead ball or a restart without offside: nothing carries over.
    o.flags = 0;
    if (phase !== MatchPhase.FREE_KICK || m.restart.taken !== 1) return;
  }
  if (s.ball.cross !== CrossKind.NONE) {
    o.flags = 0;
    return;
  }
  // Flags still set here mean this tick's touch (if any) was an opponent's save or deflection: the attackers'
  // snapshot stands and that contact starts no snapshot of its own.
  if (o.flags === 0 && playedThisTick(s)) snapshot(s, s.ball.lastKickBy, s.tick);
}

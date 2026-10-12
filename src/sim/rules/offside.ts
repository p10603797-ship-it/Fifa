/**
 * [RUL-08] Offside (config.offside). Judged at the moment a teammate plays the ball (ball.lastKickTick === tick
 * and the kick is not a goal kick / throw-in / corner, i.e. the phase at that tick is IN_PLAY or FREE_KICK...),
 * against the second-last defender, the ball and the halfway line, with T_RULES.offsideMargin benefit to the
 * attacker. Flags players in s.match.offside.flags; calls it only when a flagged player becomes involved
 * (touches the ball / challenges / receives); restart = indirect-as-direct free kick where he was. Never in his
 * own half. Emits OFFSIDE.
 *
 * Implementation notes (RUL-08):
 *  - offsideTick runs first in rulesTick (clock phases only). Order per tick: (1) involvement of a flagged player
 *    (his touch this tick; a ChallengeRecord he made after the pass; the intended receiver within
 *    LOCAL_TUNING.receiverReach of a playable ball) -> OFFSIDE + free kick to the defending team at his position
 *    (RUL-11 awardRestart; it clears the flags); (2) resets: a touch by an unflagged teammate (a new phase of play),
 *    a deliberate play or possession by an opponent, the ball over a line; (3) a new snapshot when the ball was
 *    played this tick.
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
 *  - Event: OFFSIDE a = offside slot, x/z = the restart spot (his position made legal by RUL-11), emitted after
 *    awardRestart has set up the free kick (so RESTART_AWARDED / WHISTLE come first in the tick's events).
 *  - Allocation-free; the per-tick cost is O(MAX_CHALLENGES) without a kick, O(22) on a kick tick.
 */
import { DT, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
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

/** Take the snapshot for a ball played by `kicker` this tick. */
function snapshot(s: SimState, kicker: number): void {
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
  o.passTick = s.tick;
  o.passTeam = team;
  o.passBy = kicker;
}

/** True when the ball was played this tick by a kick that offside is judged from (phase checked by the caller). */
function playedThisTick(s: SimState): boolean {
  const b = s.ball;
  const k = b.lastKickBy;
  return b.lastKickTick === s.tick && validSlot(k) && b.lastTouch === k && b.lastTouchTick === s.tick &&
    b.lastKickKind >= 0 && b.lastKickKind < PLAY_KIND.length && PLAY_KIND[b.lastKickKind] === 1 &&
    s.players[k]!.active === 1;
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
  // A save: the first contact after an on-target shot that set the flags.
  if (o.passTick >= 0 && b.shotTick === o.passTick && b.shotOnTarget === 1 && !touchedBetween(s, o.passTick, s.tick)) {
    return false;
  }
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
  // (3) this tick's touch: an unflagged teammate starts a new phase of play; an opponent's deliberate play resets
  if (touch >= 0) {
    if (s.players[touch]!.team === o.passTeam || playedDeliberately(s, touch)) {
      o.flags = 0;
      return 0;
    }
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
  if (o.flags === 0 && playedThisTick(s)) snapshot(s, s.ball.lastKickBy);
}

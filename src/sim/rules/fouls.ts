/**
 * [RUL-09] Foul classification, advantage, cards, send-offs (config.fouls; arcade mode = off).
 * Consumes s.match.challenges each tick: classify from who touched the ball first, contact direction, closing
 * speed and slide -> clean, foul, foul+yellow, foul+red, penalty inside the area. Advantage: play on for up to
 * 3 s when the fouled team keeps a good position, then wave it away or bring play back. Second yellow = red
 * (RUL-10 sendOff). Emits FOUL, CARD, ADVANTAGE. Cards go to the right player.
 *
 * Implementation notes (RUL-09):
 *  - foulsTick runs in rulesTick after offsideTick, in clock phases only. Per tick: (1) an active advantage is updated
 *    (or, if play is dead, ended as played on); (2) a card pending from a waved-away advantage is shown at the first
 *    stoppage (restart phase, ball over a line this tick, or the period clock running out); (3) every active
 *    ChallengeRecord is consumed (active = 0) and, while play is live (IN_PLAY or a restart taken this tick) and
 *    config.fouls != 0, classified. Records of a dead ball (restart pending, or after a whistle earlier in the same
 *    tick) are discarded, and so is a second record of the same contact (same pair earlier in the tick, or the running
 *    advantage's offender on its victim within sameIncidentTicks).
 *  - Classification (classifyChallenge): invalid records (bad slots, same team, inactive) and config.fouls = 0 are
 *    CLEAN without RNG draws. ballFirst = 1 and not reckless -> CLEAN. Otherwise one RNG draw (an integer draw, see
 *    ROLL_SCALE) against foulChance(rec) = baseFoulChance * kind weight (slide > hard > keeper > stand > push/pull >>
 *    shoulder) * direction (behind > side > front) * closing speed, halved for a reckless challenge that played the
 *    ball first.
 *    A foul is then: FOUL_RED with chance slideFromBehindRed (half that for a hard tackle) for serious foul play
 *    (slide / hard tackle from behind, no ball, closing speed >= recklessSpeed * seriousSpeedMul; else FOUL_YELLOW);
 *    FOUL_RED for denying an obvious goal-scoring chance (DOGSO: the victim had the ball near him within
 *    dogsoMaxGoalDist of the goal mouth and no other outfield defender covers the line to goal; downgraded to a
 *    yellow inside the penalty area when the challenge was an attempt to play the ball, i.e. not a push/pull);
 *    FOUL_YELLOW for a reckless challenge (from behind above recklessSpeed, a slide from behind, or any challenge
 *    above recklessSpeed * allOutSpeedMul); FOUL otherwise.
 *  - A foul: FOUL event (a offender, b victim, c outcome, d 1 if in the penalty area, x/z the spot) at the victim's
 *    position. Penalty when the victim is inside the offender's own penalty area. Then either advantage or an
 *    immediate whistle: victim knocked down (SIM-14 knockDown FALLEN, before the award so he finishes his fall), any
 *    earlier advantage ended as played on with its card, the card shown at once, RUL-11 awardRestart(FREE_KICK or
 *    PENALTY, fouled team, spot).
 *  - Advantage is played (ADVANTAGE a=1) only in IN_PLAY, never for a red-card foul, never while another advantage or
 *    pending card exists, never when the offending team has the ball. Free-kick fouls: the fouled team owns the ball,
 *    or it is loose and either last touched by them or a fouled-team player is nearest to it (excluding offender and
 *    victim); and the ball is in their attacking half or "promising" (beyond their own third with at most
 *    advPromisingMaxOpp opponents, offender excluded, within advPromisingRadius). Penalty fouls: only while an
 *    on-target shot by the fouled team is in flight (the goal is the advantage; anything else brings back the
 *    penalty). The victim is knocked down unless he kept the ball himself (he plays through the foul).
 *  - Advantage update (every tick, from the tick after it started): goal for the fouled team -> nothing (RUL-01
 *    resolves it as played on and shows the card); goal for the other team or the ball over any other line -> bring
 *    back; the fouled team's human presses SHIELD + SPRINT (press edge of the pair) -> bring back; the offending team
 *    owns the ball (keeper hands included) -> bring back; a shot by the fouled team after the foul (free-kick
 *    advantages only) -> wave away; after advantageKeepTicks the ball must be under the fouled team's control
 *    (owner, or loose and last touched by them) or it is brought back; at advantageTicks: wave away if under their
 *    control, else bring back. So an advantage always resolves within advantageTicks.
 *  - Wave away: ADVANTAGE a=0; the card (if any) stays pending in advantage.card / offender with active = 0 and is
 *    shown at the next stoppage (see above; checked before RUL-10 subsTick can change who is in the slot). Bring
 *    back: ADVANTAGE a=2, card shown at once, then awardRestart at the foul spot (advantage already cleared, so
 *    RUL-11 does not resolve it again). The offender recorded in the challenge is the only player ever carded.
 *  - showCard: YELLOW -> p.yellow = 1 + CARD; a second YELLOW (or SECOND_YELLOW) -> CARD SECOND_YELLOW + RUL-10
 *    sendOff; RED -> CARD RED + sendOff. Invalid or inactive slots get nothing.
 *  - Allocation-free; per tick O(MAX_CHALLENGES) plus O(22) on a foul tick.
 */
import { GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
import {
  ActionKind, CardKind, ChallengeKind, ChallengeOutcome, ControllerKind, CrossKind, MatchPhase, RestartKind, isShotKind,
} from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { Btn } from '../../contracts/input';
import type { AdvantageState, ChallengeRecord, SimState } from '../../contracts/state';
import { T_FOUL, T_RULES } from '../../contracts/tuning';
import { rngInt } from '../core/rng';
import { knockDown } from '../defend/tackle';
import { inPenaltyArea } from '../pitch/geometry';
import { awardRestart } from './restart';
import { isRestartPhase } from './restartCommon';
import { sendOff } from './subs';

/** TUNING-CR (RUL-09): proposed additions to T_FOUL (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Foul weight per ChallengeKind (index: STAND, HARD, SLIDE, SHOULDER, PUSH_PULL, KEEPER), 0..1. */
  kindFoulWeight: [0.6, 0.8, 1.0, 0.12, 0.5, 0.75] as readonly number[],
  /** fromBehind (dot, -1 front .. 1 behind) at or above this counts as "from behind". */
  behindDot: 0.5,
  /** Foul-chance multiplier for a challenge straight from behind (fromBehind = 1); side (0) = 1, linear between. */
  behindFoulMul: 1.4,
  /** Foul-chance multiplier for a challenge from the front (fromBehind = -1), linear from the side. */
  frontFoulMul: 0.8,
  /** Foul-chance multiplier at closing speed 0 and at >= recklessSpeed, linear between. */
  speedFoulMulLow: 0.7,
  speedFoulMulHigh: 1.3,
  /** Foul-chance multiplier when the tackler played the ball first but the challenge was reckless. */
  ballFirstFoulMul: 0.5,
  /** Cap on the foul chance of one challenge, 0..1. */
  maxFoulChance: 0.97,
  /** A challenge faster than recklessSpeed * this is reckless from any direction. */
  allOutSpeedMul: 1.4,
  /** Serious foul play: slide / hard tackle from behind without the ball at >= recklessSpeed * this. */
  seriousSpeedMul: 1.3,
  /** Red chance of serious foul play by a hard tackle, as a fraction of slideFromBehindRed. */
  hardRedMul: 0.5,
  /** DOGSO: the victim within this distance of the attacked goal mouth, m. */
  dogsoMaxGoalDist: 30,
  /** DOGSO: the ball within this distance of the victim, m ... */
  dogsoBallReach: 2.5,
  /** ... and owned by him, or loose and touched by him within this many ticks (0.75 s). */
  dogsoRecentTouchTicks: 45,
  /** DOGSO: an outfield defender nearer the goal than the victim and within this distance of the victim-goal line covers, m. */
  dogsoCoverDist: 9,
  /** Advantage: the ball at or beyond this attack-frame x (m; 0 = halfway line) is a good position. */
  advAttackMinU: 0,
  /** Advantage "promising": the ball at or beyond this attack-frame x (m; -17.5 = end of the own third) ... */
  advPromisingMinU: -17.5,
  /** ... with at most this many opponents (offender excluded) within advPromisingRadius m of the ball. */
  advPromisingRadius: 8,
  advPromisingMaxOpp: 1,
  /** A record of the advantage's offender on its victim this soon after the foul is the same incident, ticks (0.5 s). */
  sameIncidentTicks: 30,
} as const;

const CANCEL_BUTTONS = Btn.SHIELD | Btn.SPRINT;

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === (slot | 0);
}

function finiteOr(v: number, d: number): number {
  return v === v && v !== Infinity && v !== -Infinity ? v : d;
}

/** Play is live: in play, or a restart taken this tick (RUL-01 returns to IN_PLAY later in the tick). */
function isLive(s: SimState): boolean {
  const m = s.match;
  return m.phase === MatchPhase.IN_PLAY || (isRestartPhase(m.phase) && m.restart.taken === 1);
}

/** Team in control of the ball: the owner's team, else the team that touched it last (-1 none). */
function controlTeam(s: SimState): number {
  const b = s.ball;
  return b.owner >= 0 && b.owner < NUM_SLOTS ? s.players[b.owner]!.team : b.lastTouchTeam;
}

// ================================================================ classification

/** True if a record names two active players of opposite teams. */
export function isValidChallenge(s: SimState, rec: Readonly<ChallengeRecord>): boolean {
  if (!validSlot(rec.tackler) || !validSlot(rec.victim)) return false;
  const t = s.players[rec.tackler]!;
  const v = s.players[rec.victim]!;
  return t.active === 1 && v.active === 1 && t.team !== v.team;
}

/**
 * Scratch (allocation-free, and no double returned across a call that might not inline):
 * [0] foul chance, [1] red chance, [2] fromBehind clamped to -1..1 (non-finite -> 0), [3] closing speed >= 0
 * (non-finite -> 0), [4] kind foul weight.
 */
const F = new Float64Array(5);

/** Fill F[2..4] from a record. */
function readRecord(rec: Readonly<ChallengeRecord>): void {
  const fb = rec.fromBehind;
  F[2] = fb === fb && fb !== Infinity && fb !== -Infinity ? (fb < -1 ? -1 : fb > 1 ? 1 : fb) : 0;
  const v = rec.closingSpeed;
  F[3] = v > 0 && v !== Infinity ? v : 0;
  const w = LOCAL_TUNING.kindFoulWeight;
  const k = rec.kind;
  F[4] = k >= 0 && k < w.length && k === (k | 0) ? w[k]! : w[ChallengeKind.STAND]!;
}

/** Reckless: from behind above recklessSpeed, a slide from behind, or any challenge above recklessSpeed * allOutSpeedMul. */
export function isReckless(rec: Readonly<ChallengeRecord>): boolean {
  readRecord(rec);
  const behind = F[2]! >= LOCAL_TUNING.behindDot;
  if (behind && F[3]! > T_FOUL.recklessSpeed) return true;
  if (behind && rec.kind === ChallengeKind.SLIDE) return true;
  return F[3]! > T_FOUL.recklessSpeed * LOCAL_TUNING.allOutSpeedMul;
}

/** F[0] = foul chance of rec (see foulChance). */
function computeFoulChance(rec: Readonly<ChallengeRecord>): void {
  const L = LOCAL_TUNING;
  readRecord(rec);
  const fb = F[2]!;
  const dirMul = fb >= 0 ? 1 + (L.behindFoulMul - 1) * fb : 1 + (1 - L.frontFoulMul) * fb;
  let sp = F[3]! / T_FOUL.recklessSpeed;
  sp = sp > 1 ? 1 : sp;
  const spdMul = L.speedFoulMulLow + (L.speedFoulMulHigh - L.speedFoulMulLow) * sp;
  let p = T_FOUL.baseFoulChance * F[4]! * dirMul * spdMul;
  if (rec.ballFirst === 1) p *= L.ballFirstFoulMul;
  F[0] = p < 0 ? 0 : p > L.maxFoulChance ? L.maxFoulChance : p;
}

/** F[1] = red chance for serious foul play (see seriousFoulRedChance). */
function computeRedChance(rec: Readonly<ChallengeRecord>): void {
  readRecord(rec);
  let p = 0;
  if (rec.ballFirst !== 1 && F[2]! >= LOCAL_TUNING.behindDot && F[3]! >= T_FOUL.recklessSpeed * LOCAL_TUNING.seriousSpeedMul) {
    if (rec.kind === ChallengeKind.SLIDE) p = T_FOUL.slideFromBehindRed;
    else if (rec.kind === ChallengeKind.HARD) p = T_FOUL.slideFromBehindRed * LOCAL_TUNING.hardRedMul;
  }
  F[1] = p;
}

/** Chance (0..maxFoulChance) that a challenge that did not play the ball cleanly is a foul. */
export function foulChance(rec: Readonly<ChallengeRecord>): number {
  computeFoulChance(rec);
  return F[0]!;
}

/** Red chance for serious foul play (0 when the challenge is not serious foul play). */
export function seriousFoulRedChance(rec: Readonly<ChallengeRecord>): number {
  computeRedChance(rec);
  return F[1]!;
}

/**
 * Denying an obvious goal-scoring chance: the victim had the ball (owner, or loose near him after his recent touch)
 * within dogsoMaxGoalDist of the goal he attacks, and no outfield defender other than the offender covers (nearer
 * the goal mouth and within dogsoCoverDist of the line from the victim to the goal centre).
 */
export function isDogso(s: SimState, rec: Readonly<ChallengeRecord>): boolean {
  if (!isValidChallenge(s, rec)) return false;
  const L = LOCAL_TUNING;
  const v = s.players[rec.victim]!;
  const b = s.ball;
  const recent = v.lastTouchTick >= 0 && s.tick - v.lastTouchTick <= L.dogsoRecentTouchTicks;
  if (!(b.owner === rec.victim || (b.owner < 0 && recent))) return false;
  const vx = v.x, vz = v.z;
  const bdx = b.x - vx, bdz = b.z - vz;
  if (bdx * bdx + bdz * bdz > L.dogsoBallReach * L.dogsoBallReach) return false;
  // Squared distance to the goal-mouth segment of the attacked goal (x = gx, |z| <= GOAL_HALF_WIDTH).
  const gx = s.teams[v.team]!.dir * HALF_LENGTH;
  let dx = gx - vx;
  let az = vz < 0 ? -vz : vz;
  let dz = az > GOAL_HALF_WIDTH ? az - GOAL_HALF_WIDTH : 0;
  const goal2 = dx * dx + dz * dz;
  if (goal2 > L.dogsoMaxGoalDist * L.dogsoMaxGoalDist) return false;
  // Victim -> goal centre segment, for the cover test.
  const sx = gx - vx, sz = -vz;
  const sl2 = sx * sx + sz * sz;
  const cover2 = L.dogsoCoverDist * L.dogsoCoverDist;
  const first = teamFirstSlot(other(v.team));
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === rec.tackler) continue;
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    dx = gx - p.x;
    az = p.z < 0 ? -p.z : p.z;
    dz = az > GOAL_HALF_WIDTH ? az - GOAL_HALF_WIDTH : 0;
    if (dx * dx + dz * dz >= goal2) continue; // not nearer the goal than the victim
    let t = sl2 > 0 ? ((p.x - vx) * sx + (p.z - vz) * sz) / sl2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = vx + sx * t - p.x, ez = vz + sz * t - p.z;
    if (ex * ex + ez * ez <= cover2) return false;
  }
  return true;
}

/** Victim inside the offender's own penalty area (a penalty offence). */
function isPenaltyOffence(s: SimState, offender: number, x: number, z: number): boolean {
  return inPenaltyArea(x, z, -s.teams[s.players[offender]!.team]!.dir);
}

/**
 * RNG rolls are integer draws: rngInt(s.rng, ROLL_SCALE) < p * ROLL_SCALE (chance ceil(p * ROLL_SCALE) / ROLL_SCALE).
 * One draw per roll, as rngChance, but only small integers cross the call, so a roll never boxes a float even when
 * the JIT declines to inline the RNG.
 */
export const ROLL_SCALE = 1 << 24;

/** One RNG draw against the foul chance. */
function rollFoul(s: SimState, rec: Readonly<ChallengeRecord>): boolean {
  computeFoulChance(rec);
  return rngInt(s.rng, ROLL_SCALE) < F[0]! * ROLL_SCALE;
}

/** Serious foul play: 0 = not serious (no draw), 1 = serious, red roll failed (yellow), 2 = red. */
function rollRed(s: SimState, rec: Readonly<ChallengeRecord>): number {
  computeRedChance(rec);
  if (!(F[1]! > 0)) return 0;
  return rngInt(s.rng, ROLL_SCALE) < F[1]! * ROLL_SCALE ? 2 : 1;
}

/** Classify a challenge (deterministic; may use s.rng). */
export function classifyChallenge(s: SimState, rec: Readonly<ChallengeRecord>): ChallengeOutcome {
  if (s.config.fouls === 0 || !isValidChallenge(s, rec)) return ChallengeOutcome.CLEAN;
  const reckless = isReckless(rec);
  if (rec.ballFirst === 1 && !reckless) return ChallengeOutcome.CLEAN;
  if (!rollFoul(s, rec)) return ChallengeOutcome.CLEAN;
  const red = rollRed(s, rec);
  if (red !== 0) return red === 2 ? ChallengeOutcome.FOUL_RED : ChallengeOutcome.FOUL_YELLOW;
  if (isDogso(s, rec)) {
    const v = s.players[rec.victim]!;
    const attempt = rec.kind !== ChallengeKind.PUSH_PULL;
    return attempt && isPenaltyOffence(s, rec.tackler, v.x, v.z) ? ChallengeOutcome.FOUL_YELLOW : ChallengeOutcome.FOUL_RED;
  }
  return reckless ? ChallengeOutcome.FOUL_YELLOW : ChallengeOutcome.FOUL;
}

// ================================================================ cards

/** Show a card to slot (handles second yellow -> red via RUL-10 sendOff). */
export function showCard(s: SimState, slot: number, kind: CardKind, ev: EventSink): void {
  if (!validSlot(slot)) return;
  const p = s.players[slot]!;
  if (p.active !== 1) return;
  if (kind === CardKind.YELLOW && p.yellow === 0) {
    p.yellow = 1;
    ev.emit(EventType.CARD, slot, CardKind.YELLOW);
    return;
  }
  if (kind === CardKind.YELLOW || kind === CardKind.SECOND_YELLOW) {
    p.yellow = 1;
    ev.emit(EventType.CARD, slot, CardKind.SECOND_YELLOW);
    sendOff(s, slot, ev);
    return;
  }
  if (kind === CardKind.RED) {
    ev.emit(EventType.CARD, slot, CardKind.RED);
    sendOff(s, slot, ev);
  }
}

function cardOf(outcome: ChallengeOutcome): CardKind {
  return outcome === ChallengeOutcome.FOUL_YELLOW ? CardKind.YELLOW : outcome === ChallengeOutcome.FOUL_RED ? CardKind.RED : CardKind.NONE;
}

// ================================================================ advantage

function clearAdvantage(a: AdvantageState): void {
  a.active = 0;
  a.team = -1;
  a.offender = -1;
  a.victim = -1;
  a.x = 0;
  a.z = 0;
  a.startTick = -1;
  a.card = CardKind.NONE;
  a.penalty = 0;
}

/** Show a card left pending by a waved-away advantage (to the recorded offender) and clear the record. */
function flushPendingCard(s: SimState, ev: EventSink): void {
  const a = s.match.advantage;
  if (a.active === 1) return;
  const card = a.card;
  const off = a.offender;
  clearAdvantage(a);
  if (card !== CardKind.NONE) showCard(s, off, card, ev);
}

/** Advantage over, played on: ADVANTAGE a=0; the card stays pending until the next stoppage. */
function waveAway(s: SimState, ev: EventSink): void {
  const a = s.match.advantage;
  a.active = 0;
  ev.emit(EventType.ADVANTAGE, 0, a.team);
  if (a.card === CardKind.NONE) clearAdvantage(a);
}

/** Advantage did not accrue: ADVANTAGE a=2, card now, restart at the foul spot. */
function bringBack(s: SimState, ev: EventSink): void {
  const a = s.match.advantage;
  const team = a.team;
  const kind = a.penalty === 1 ? RestartKind.PENALTY : RestartKind.FREE_KICK;
  const x = a.x;
  const z = a.z;
  a.active = 0;
  ev.emit(EventType.ADVANTAGE, 2, team);
  flushPendingCard(s, ev);
  if (team === 0 || team === 1) awardRestart(s, kind, team, x, z, ev);
}

/** The fouled team's human pressed SHIELD + SPRINT this tick (both held, the pair newly complete). */
export function cancelAdvantagePressed(s: SimState, team: number): boolean {
  for (let i = 0; i < 2 && i < s.ctrl.length; i++) {
    const c = s.ctrl[i]!;
    if (c.kind !== ControllerKind.HUMAN || c.side !== team) continue;
    if ((c.buttons & CANCEL_BUTTONS) === CANCEL_BUTTONS && (c.prevButtons & CANCEL_BUTTONS) !== CANCEL_BUTTONS) return true;
  }
  return false;
}

/** Team scoring when the ball crosses the goal line at end e (-1/+1): the team attacking that end. */
function scoringTeam(s: SimState, end: number): number {
  return s.teams[0]!.dir === end ? 0 : 1;
}

function updateAdvantage(s: SimState, ev: EventSink): void {
  const a = s.match.advantage;
  const b = s.ball;
  const team = a.team;
  if (team !== 0 && team !== 1) { ev.emit(EventType.ADVANTAGE, 0, team); clearAdvantage(a); return; }
  const el = s.tick - a.startTick;
  if (el === 0) return; // started this tick
  // Ball out of play this tick (RUL-01 handles the crossing after us).
  if (b.cross === CrossKind.GOAL) {
    if (scoringTeam(s, b.crossEnd) !== team) bringBack(s, ev);
    return; // a goal for the fouled team is the advantage: RUL-01 ends it as played on
  }
  if (b.cross !== CrossKind.NONE) { bringBack(s, ev); return; }
  if (cancelAdvantagePressed(s, team)) { bringBack(s, ev); return; }
  if (b.owner >= 0 && b.owner < NUM_SLOTS && s.players[b.owner]!.team !== team) { bringBack(s, ev); return; }
  if (a.penalty === 0 && b.lastKickTick > a.startTick && b.lastKickTeam === team && isShotKind(b.lastKickKind)) {
    waveAway(s, ev);
    return;
  }
  const ctl = controlTeam(s);
  if (el >= T_FOUL.advantageKeepTicks && ctl !== team) { bringBack(s, ev); return; }
  if (el >= T_RULES.advantageTicks || el < 0) {
    if (ctl === team) waveAway(s, ev); else bringBack(s, ev);
  }
}

/** Ball in the fouled team's attacking half, or beyond their own third with space around it. */
function goodPosition(s: SimState, team: number, offender: number): boolean {
  const L = LOCAL_TUNING;
  const b = s.ball;
  const u = s.teams[team]!.dir * b.x;
  if (u >= L.advAttackMinU) return true;
  if (u < L.advPromisingMinU) return false;
  const opp = other(team);
  const first = teamFirstSlot(opp);
  const r2 = L.advPromisingRadius * L.advPromisingRadius;
  let n = 0;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === offender) continue;
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const dx = p.x - b.x, dz = p.z - b.z;
    if (dx * dx + dz * dz <= r2) n++;
  }
  return n <= L.advPromisingMaxOpp;
}

/** Nearest active player to the ball, excluding two slots; -1 if none. */
function nearestToBall(s: SimState, ex1: number, ex2: number): number {
  const b = s.ball;
  let best = -1;
  let bestD = 1e18;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === ex1 || i === ex2) continue;
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const dx = p.x - b.x, dz = p.z - b.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function canPlayAdvantage(s: SimState, rec: Readonly<ChallengeRecord>, team: number, penalty: boolean): boolean {
  const m = s.match;
  if (m.phase !== MatchPhase.IN_PLAY) return false;
  const a = m.advantage;
  if (a.active === 1 || a.card !== CardKind.NONE) return false;
  const b = s.ball;
  if (b.owner >= 0) {
    if (b.owner >= NUM_SLOTS || s.players[b.owner]!.team !== team) return false;
  }
  if (penalty) {
    return b.owner < 0 && validSlot(b.shotBy) && s.players[b.shotBy]!.team === team && b.shotOnTarget === 1;
  }
  if (b.owner < 0 && b.lastTouchTeam !== team) {
    const n = nearestToBall(s, rec.tackler, rec.victim);
    if (n < 0 || s.players[n]!.team !== team) return false;
  }
  return goodPosition(s, team, rec.tackler);
}

// ================================================================ fouls

function callFoul(s: SimState, rec: Readonly<ChallengeRecord>, outcome: ChallengeOutcome, ev: EventSink): void {
  const off = rec.tackler;
  const vic = rec.victim;
  const v = s.players[vic]!;
  const team = other(s.players[off]!.team);
  const x = finiteOr(v.x, finiteOr(rec.x, 0));
  const z = finiteOr(v.z, finiteOr(rec.z, 0));
  const pen = isPenaltyOffence(s, off, x, z);
  const card = cardOf(outcome);
  ev.emit(EventType.FOUL, off, vic, outcome, pen ? 1 : 0, x, 0, z);
  const a = s.match.advantage;
  if (card !== CardKind.RED && canPlayAdvantage(s, rec, team, pen)) {
    a.active = 1;
    a.team = team;
    a.offender = off;
    a.victim = vic;
    a.x = x;
    a.z = z;
    a.startTick = s.tick;
    a.card = card;
    a.penalty = pen ? 1 : 0;
    ev.emit(EventType.ADVANTAGE, 1, team);
    if (s.ball.owner !== vic) knockDown(s, vic, ActionKind.FALLEN, ev);
    return;
  }
  // Whistle now.
  knockDown(s, vic, ActionKind.FALLEN, ev);
  if (a.active === 1) {
    a.active = 0;
    ev.emit(EventType.ADVANTAGE, 0, a.team);
  }
  flushPendingCard(s, ev);
  showCard(s, off, card, ev);
  awardRestart(s, pen ? RestartKind.PENALTY : RestartKind.FREE_KICK, team, x, z, ev);
}

/** A stoppage is happening (or the period may end) this tick: show a card left pending by a waved-away advantage. */
function stoppageNow(s: SimState): boolean {
  const m = s.match;
  if (m.phase !== MatchPhase.IN_PLAY || s.ball.cross !== CrossKind.NONE) return true;
  return m.clockRunning === 1 && m.periodT + 1 >= m.periodLen + m.addedT;
}

export function foulsTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const a = m.advantage;
  if (a.active === 1) {
    if (isLive(s)) {
      updateAdvantage(s, ev);
    } else {
      // Safety net: play stopped without anyone resolving the advantage -> played on.
      a.active = 0;
      ev.emit(EventType.ADVANTAGE, 0, a.team);
    }
  }
  if (a.active === 0 && (a.card !== CardKind.NONE || a.offender !== -1) && stoppageNow(s)) flushPendingCard(s, ev);
  const recs = m.challenges;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.active !== 1) continue;
    r.active = 0;
    if (s.config.fouls === 0 || !isLive(s) || r.tick > s.tick || sameIncident(s, recs, i)) continue;
    const out = classifyChallenge(s, r);
    if (out !== ChallengeOutcome.CLEAN) callFoul(s, r, out, ev);
  }
}

/**
 * The same contact recorded twice must not be judged twice: an earlier record of this tick with the same tackler and
 * victim, or the incident the running advantage is for (same pair within sameIncidentTicks of its start).
 */
function sameIncident(s: SimState, recs: readonly ChallengeRecord[], i: number): boolean {
  const r = recs[i]!;
  for (let j = 0; j < i; j++) {
    const q = recs[j]!;
    if (q.tackler === r.tackler && q.victim === r.victim && q.tick === r.tick) return true;
  }
  const a = s.match.advantage;
  return a.active === 1 && a.offender === r.tackler && a.victim === r.victim && s.tick - a.startTick <= LOCAL_TUNING.sameIncidentTicks;
}

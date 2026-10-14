/**
 * [RUL-01] Match state machine, clock, halves, added time, extra time, kick-off, celebrations.
 * One explicit table-driven machine: setPhase() checks contracts/transitions.ts LEGAL_TRANSITIONS and throws in
 * test builds (__DEV_BUILD__) on an illegal transition. rulesTick runs every tick after contacts and calls, in
 * order: offsideTick (RUL-08), foulsTick (RUL-09), ball-crossing handling (goal -> GOAL; out -> awardRestart
 * with the right kind/team from the last touch), restartTick (RUL-11) + per-kind ticks (RUL-02..06) during
 * restart phases, shootoutTick (RUL-07), subsTick (RUL-10), clock and period logic.
 * Clock: half length 2-10 real minutes scaled to 45:00 per half, added time shown; a half ends only when the
 * ball is out of play or in a neutral area (not during a shot, a cross in flight or an attack in the final
 * 25 m), extension capped at 20 real seconds. Home attacks +x in the first half; sides swap at half-time.
 * Goal -> celebration -> replay -> kick-off, skippable (Command.SKIP / Btn.SKIP from any human), 12 s max.
 * Cup matches level at full time: extra time (two periods, each a third of a half) then shoot-out.
 *
 * Implementation notes (RUL-01):
 *  - Live rules (offside, fouls) run only in clock phases (play + restarts); a goal or period end resolves a
 *    pending advantage (played on, pending card shown) and clears challenge records and offside flags.
 *  - A goal straight from a throw-in (no other touch) does not count; neither does an own goal straight from a
 *    goal kick or kick-off: the ball is treated as out over the goal line (goal kick / corner, as in Laws 13-16).
 *  - The clock (match.periodT) only ever advances by 1 per clock-phase tick; the display is derived from it, so it
 *    cannot drift. Added time accrues during the restart phases of regulation time that run the clock (throw-ins,
 *    goal kicks, corners, free kicks, penalties; never a kick-off, D-013) and is frozen once regulation ends.
 *  - A shot in flight always defers the period end (bounded by LOCAL_TUNING.shotFlightMaxTicks after the strike);
 *    a cross in flight or an attack in the final 25 m defers it until the 20 s extension cap.
 *  - Kick-off: both teams are teleported into formation in their own halves (opponents outside the centre
 *    circle), taker beside the ball on the spot facing his attacking direction, a teammate beside him. The kick is
 *    a SIM-08 startPass(KICK_OFF) from the kicking side's PASS press (any controller of that side) or the default
 *    after the timeout; if the pass cannot start, a direct short kick through applyKick is forced (WATCHDOG logged).
 *  - celebrateHandler / dejectedHandler are hoisted function objects carrying update/end so the action registry
 *    receives valid references even when this module is first reached through an import cycle (UI -> machine ->
 *    rules -> dispatch -> registry -> machine).
 *  - Extra exports: setPhaseSafe (non-throwing transition), kickOffTick / kickOffDefault (RUL-11 calls the
 *    default on timeout), advanceCutscene (end a cut-scene / break as a skip would; for the watchdog), isTimeUp,
 *    LOCAL_TUNING.
 */
import {
  CENTRE_CIRCLE_RADIUS, CORNER_ARC_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH,
  BALL_RADIUS, MIN_PLAYERS, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../contracts/constants';
import {
  ActionKind, AssistLevel, CardKind, ControllerKind, CrossKind, KickKind, MatchPhase, ModeId, Period, PracticeKind,
  RestartKind, WatchdogReason,
} from '../../contracts/enums';
import { EventType, WhistleKind, type EventSink } from '../../contracts/events';
import { Btn, type InputFrame } from '../../contracts/input';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { clearActionRequest, createActionRequest, createKickLaunch, ReqFlag } from '../../contracts/systems';
import { CLOCK_PHASES, CUTSCENE_PHASES, LEGAL_TRANSITIONS, RESTART_PHASES } from '../../contracts/transitions';
import { T_RULES } from '../../contracts/tuning';
import { getFormation } from '../../data/formations';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import { applyKick, releasePossession } from '../core/kick';
import { rngInt } from '../core/rng';
import { periodLength } from '../init';
import { startPass } from '../kicks/pass';
import { cornerTick } from './corner';
import { foulsTick, showCard } from './fouls';
import { freeKickTick } from './freekick';
import { goalKickTick } from './goalkick';
import { offsideTick } from './offside';
import { penaltyTick } from './penalty';
import { awardRestart, legalizePositions, restartTick } from './restart';
import { shootoutStart, shootoutTick } from './shootout';
import { checkForfeit, subsTick } from './subs';
import { throwInTick } from './throwin';
import { practiceTeam } from './practice';

/** RUL-01 constants not yet in contracts/tuning.ts. */
export const LOCAL_TUNING = {
  /** PRE_MATCH length before the first kick-off / shoot-out, ticks (2 s). */
  preMatchTicks: 120,
  /** Half-time break between the two extra-time periods, ticks (2 s; "short break"). */
  etHalfTimeTicks: 120,
  /** An assist must precede the scorer's touch by at most this many ticks (10 s). */
  assistWindowTicks: 600,
  /** A shot in flight defers the period end for at most this many ticks after the strike (3 s). */
  shotFlightMaxTicks: 180,
  /** A cross counts as in flight for at most this many ticks after the kick (4 s) ... */
  crossFlightMaxTicks: 240,
  /** ... while airborne or rolling faster than this, m/s. */
  crossLiveSpeed: 4,
  /** Kick-off: taker stands this far behind the ball on his own side, m. */
  kickOffTakerBehind: 0.45,
  /** Kick-off: the partner stands this far behind the halfway line, m, and this far to the side, m. */
  kickOffPartnerBehind: 0.6,
  kickOffPartnerSide: 1.8,
  /** Kick-off: everyone else at least this far inside his own half, m. */
  kickOffHalfMargin: 1,
  /** Kick-off: defending players at least this far outside the centre circle, m. */
  kickOffCircleMargin: 0.85,
  /** Kick-off: formation scale, fraction of the half length / half width. */
  kickOffDepthScale: 0.95,
  kickOffWidthScale: 0.9,
  /** Kick-off: minimum spacing between placed players, m; keep-inside margin from the lines, m. */
  kickOffMinSpacing: 1.5,
  kickOffPitchMargin: 1,
  /** Kick-off pass power 0..1 (short pass) and the forced fallback kick speed, m/s. */
  kickOffPower: 0.25,
  kickOffForceSpeed: 8,
  /** Kick-off: CPU / AI taker default after ready + T_RULES.cpuRestartDelay + this many ticks (1 s). */
  kickOffCpuGraceTicks: 60,
  /** Kick-off: forced direct kick this many ticks after the default became due (1 s). */
  kickOffForceTicks: 60,
  /** Kick-off: taker re-pinned to his spot when further than this, m; ball re-spotted when further than this, m. */
  kickOffPinTolerance: 0.6,
  kickOffBallTolerance: 0.25,
  /** Celebration: teammates within this radius of the scorer join, m, at most this many. */
  celebrateJoinRadius: 25,
  celebrateMaxJoin: 4,
  /** Celebration: scorer run speed m/s, per-variant speed multipliers, joiners' speed m/s, joiners' offset m. */
  celebrateRunSpeed: 6.5,
  celebrateVariantSpeed: [1, 0.85, 0.7] as readonly number[],
  celebrateJoinSpeed: 6,
  celebrateJoinDist: 1.6,
  /** Celebration spot inset from the goal line and from the touchline, m; keep-inside margin, m. */
  celebrateSpotInsetX: 8,
  celebrateSpotInsetZ: 6,
  celebrateInsideMargin: 1.5,
  /** Dejected players walk back toward their formation spot at this speed, m/s. */
  dejectedWalkSpeed: 1.4,
  /** Corner spot inset from the corner on each axis, fraction of CORNER_ARC_RADIUS (inside the arc). */
  cornerSpotInset: 0.5,
  /** Goal kick spot: fraction of the goal-area half width toward the side the ball went out. */
  goalKickSideFrac: 0.5,
} as const; // TUNING-CR

/** Displayed length of a normal period and of an extra-time period, match seconds (presentation, not gameplay). */
const HALF_DISPLAY_SEC = 45 * 60;
const ET_DISPLAY_SEC = 15 * 60;
/** Displayed minute at the start of each period (index = Period). */
const PERIOD_BASE_MIN: readonly number[] = [0, 0, 45, 90, 105, 120];

const N_PHASES = MatchPhase.POST_MATCH + 1;
const IS_CLOCK = new Uint8Array(N_PHASES);
const IS_RESTART = new Uint8Array(N_PHASES);
const IS_CUTSCENE = new Uint8Array(N_PHASES);
for (let i = 0; i < CLOCK_PHASES.length; i++) IS_CLOCK[CLOCK_PHASES[i]!] = 1;
for (let i = 0; i < RESTART_PHASES.length; i++) IS_RESTART[RESTART_PHASES[i]!] = 1;
for (let i = 0; i < CUTSCENE_PHASES.length; i++) IS_CUTSCENE[CUTSCENE_PHASES[i]!] = 1;
/** LEGAL[from * N_PHASES + to] = 1 for every legal transition. */
const LEGAL = new Uint8Array(N_PHASES * N_PHASES);
for (let f = 0; f < N_PHASES; f++) {
  const tos = LEGAL_TRANSITIONS[f as MatchPhase];
  for (let i = 0; i < tos.length; i++) LEGAL[f * N_PHASES + tos[i]!] = 1;
}

/** Preallocated scratch (no allocation per tick). */
const REQ = createActionRequest();
const LAUNCH = createKickLaunch();
const SPOT = { x: 0, z: 0 };
const PLACE_X = new Float64Array(NUM_SLOTS);
const PLACE_Z = new Float64Array(NUM_SLOTS);
/** Per slot: 1 = fixed during kick-off de-overlap (taker, partner). */
const PLACE_FIXED = new Uint8Array(NUM_SLOTS);

const DEV = typeof __DEV_BUILD__ !== 'undefined' && __DEV_BUILD__;

// ================================================================ small helpers

function isPhase(p: number): boolean {
  return p === (p | 0) && p >= 0 && p < N_PHASES;
}

function isLegal(from: number, to: number): boolean {
  return isPhase(from) && isPhase(to) && LEGAL[from * N_PHASES + to] === 1;
}

function isPractice(s: SimState): boolean {
  return s.config.mode === ModeId.PRACTICE || s.config.practice !== PracticeKind.NONE;
}

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function isCup(s: SimState): boolean {
  return s.config.cupRules > 0;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Actions a goal / kick-off may not cut short (the player finishes them naturally). */
function isUninterruptible(act: ActionKind): boolean {
  return act === ActionKind.FALLEN || act === ActionKind.GET_UP || act === ActionKind.STUMBLE || act === ActionKind.GK_DIVE;
}

/** True once the current period's playing time (incl. added time) has run out. Never in practice. */
export function isTimeUp(s: SimState): boolean {
  const m = s.match;
  return !isPractice(s) && m.periodT >= m.periodLen + m.addedT;
}

/** Any HUMAN controller's SKIP press edge; with no humans at all, controller 0's (headless fast-forward). */
function skipPressed(s: SimState): boolean {
  let humans = 0;
  for (let i = 0; i < s.ctrl.length; i++) {
    const c = s.ctrl[i]!;
    if (c.kind !== ControllerKind.HUMAN) continue;
    humans++;
    if ((c.buttons & Btn.SKIP) !== 0 && (c.prevButtons & Btn.SKIP) === 0) return true;
  }
  if (humans === 0 && s.ctrl.length > 0) {
    const c = s.ctrl[0]!;
    if ((c.buttons & Btn.SKIP) !== 0 && (c.prevButtons & Btn.SKIP) === 0) return true;
  }
  return false;
}

// ================================================================ phase transitions

function setPhaseImpl(s: SimState, to: MatchPhase, ev: EventSink, strict: boolean): number {
  const m = s.match;
  const from = m.phase;
  if (!isLegal(from, to)) {
    if (strict) {
      const fn = (MatchPhase as unknown as Record<number, string | undefined>)[from] ?? String(from);
      const tn = (MatchPhase as unknown as Record<number, string | undefined>)[to] ?? String(to);
      throw new Error(`[RUL-01] illegal phase transition ${fn} -> ${tn} at tick ${s.tick}`);
    }
    m.watchdogCount++;
    ev.emit(EventType.WATCHDOG, WatchdogReason.OTHER, from, to);
    return 0;
  }
  m.prevPhase = from;
  m.phase = to;
  m.phaseT = 0;
  m.clockRunning = IS_CLOCK[to] === 1 && !isPractice(s) && m.finished === 0 ? 1 : 0;
  if (to === MatchPhase.IN_PLAY) m.restart.kind = RestartKind.NONE;
  if (to === MatchPhase.POST_MATCH) {
    if (from === MatchPhase.SHOOT_OUT && m.winner < 0 && m.shootout.winner >= 0) m.winner = m.shootout.winner;
    m.finished = 1;
    m.clockRunning = 0;
  }
  ev.emit(EventType.PHASE_CHANGE, from, to);
  return 1;
}

/** Transition to a new phase (validated). Resets phaseT, emits PHASE_CHANGE. */
export function setPhase(s: SimState, to: MatchPhase, ev: EventSink): void {
  setPhaseImpl(s, to, ev, DEV);
}

/**
 * Non-throwing transition (shipped-game behaviour): an illegal transition is refused, counted in
 * match.watchdogCount and logged as WATCHDOG (a = OTHER, b = from, c = to). Returns 1 if the phase changed.
 */
export function setPhaseSafe(s: SimState, to: MatchPhase, ev: EventSink): number {
  return setPhaseImpl(s, to, ev, false);
}

// ================================================================ stoppages

/** Play stopped (goal / period end): resolve a pending advantage (played on), clear challenges and offside flags. */
function resolveStoppage(s: SimState, ev: EventSink): void {
  const m = s.match;
  const a = m.advantage;
  if (a.active === 1) {
    a.active = 0;
    ev.emit(EventType.ADVANTAGE, 0, a.team);
    const off = a.offender;
    if (a.card !== CardKind.NONE && off >= 0 && off < NUM_SLOTS && s.players[off]!.active === 1) showCard(s, off, a.card, ev);
    a.card = CardKind.NONE;
  }
  for (let i = 0; i < m.challenges.length; i++) m.challenges[i]!.active = 0;
  m.offside.flags = 0;
}

/** End set-piece actions that belong to an abandoned restart. */
function endSetPieceActions(s: SimState): void {
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const act = s.players[slot]!.act;
    if (act === ActionKind.SET_PIECE || act === ActionKind.THROW_IN || act === ActionKind.WALL_JUMP) endAction(s, slot, 1);
  }
}

// ================================================================ goals and out of play

/** A goal that may not stand: straight from a throw-in, or an own goal straight from a goal kick or kick-off. */
function noGoalDirect(s: SimState, scoringTeam: number): boolean {
  const b = s.ball;
  if (b.lastKickBy < 0 || b.lastKickBy !== b.lastTouch || b.lastKickTick !== b.lastTouchTick) return false;
  const k = b.lastKickKind;
  if (k === KickKind.THROW_IN) return true;
  return (k === KickKind.GOAL_KICK || k === KickKind.KICK_OFF) && b.lastKickTeam >= 0 && b.lastKickTeam !== scoringTeam;
}

/** Assist for a goal by `scorer`: the latest teammate touch before the scorer's, within the window, since the
 *  previous goal, with no opponent touch in between; -1 if none. */
function findAssist(s: SimState, scorer: number): number {
  const m = s.match;
  const sp = s.players[scorer]!;
  const team = sp.team;
  const tTouch = s.ball.lastTouchTick;
  let minTick = tTouch - LOCAL_TUNING.assistWindowTicks;
  if (m.goalTick >= 0 && m.goalTick + 1 > minTick) minTick = m.goalTick + 1;
  if (minTick < 0) minTick = 0;
  let best = -1;
  let bestT = -1;
  const first = teamFirstSlot(team);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === scorer) continue;
    const t = s.players[i]!.lastTouchTick;
    if (t >= minTick && t < tTouch && t > bestT) { bestT = t; best = i; }
  }
  if (best < 0) return -1;
  const ofirst = teamFirstSlot(other(team));
  for (let j = ofirst; j < ofirst + PLAYERS_PER_TEAM; j++) {
    const t = s.players[j]!.lastTouchTick;
    if (t > bestT && t < tTouch) return -1;
  }
  return best;
}

function scoreGoal(s: SimState, scoring: number, ev: EventSink): void {
  const b = s.ball;
  const m = s.match;
  const conceding = other(scoring);
  const scorer = b.lastTouch >= 0 && b.lastTouch < NUM_SLOTS ? b.lastTouch : -1;
  const own = scorer >= 0 && s.players[scorer]!.team === conceding ? 1 : 0;
  const assist = own === 1 || scorer < 0 ? -1 : findAssist(s, scorer);
  s.teams[scoring]!.goals++;
  m.goalTeam = scoring;
  m.goalScorer = scorer;
  m.goalAssist = assist;
  m.goalOwn = own;
  m.goalTick = s.tick;
  m.kickoffTeam = conceding;
  releasePossession(s, ev);
  resolveStoppage(s, ev);
  ev.emit(EventType.GOAL, scoring, scorer, assist, own, b.x, b.y, b.z);
  ev.emit(EventType.WHISTLE, WhistleKind.SHORT);
  setPhase(s, MatchPhase.GOAL, ev);
}

/** Ball wholly over the goal line at `end` outside the goal (or a goal that may not stand). */
function outOverGoalLine(s: SimState, end: number, ev: EventSink): void {
  const b = s.ball;
  const defending = s.teams[0]!.dir === -end ? 0 : 1;
  const attacking = other(defending);
  const side = b.crossZ < 0 ? -1 : 1;
  if (b.lastTouchTeam === defending) {
    const inset = CORNER_ARC_RADIUS * LOCAL_TUNING.cornerSpotInset;
    awardRestart(s, RestartKind.CORNER, attacking, end * (HALF_LENGTH - inset), side * (HALF_WIDTH - inset), ev);
  } else {
    awardRestart(s, RestartKind.GOAL_KICK, defending, end * (HALF_LENGTH - GOAL_AREA_DEPTH),
      side * GOAL_AREA_HALF_WIDTH * LOCAL_TUNING.goalKickSideFrac, ev);
  }
}

/** IN_PLAY: the ball wholly crossed a line this tick (ball.cross from SIM-03). */
function handleCrossing(s: SimState, ev: EventSink): void {
  const b = s.ball;
  const kind = b.cross;
  if (kind === CrossKind.TOUCHLINE) {
    let team: number;
    if (b.lastTouchTeam === 0 || b.lastTouchTeam === 1) team = other(b.lastTouchTeam);
    else team = s.teams[0]!.dir === (b.crossX < 0 ? 1 : -1) ? 0 : 1; // nobody touched it: the team defending that half
    const x = clampNum(b.crossX, -HALF_LENGTH, HALF_LENGTH);
    awardRestart(s, RestartKind.THROW_IN, team, x, (b.crossZ < 0 ? -1 : 1) * HALF_WIDTH, ev);
    return;
  }
  if (kind !== CrossKind.GOAL && kind !== CrossKind.GOAL_LINE) return;
  const end = b.crossEnd === 1 || b.crossEnd === -1 ? b.crossEnd : b.crossX >= 0 ? 1 : -1;
  if (kind === CrossKind.GOAL) {
    const scoring = s.teams[0]!.dir === end ? 0 : 1;
    if (!noGoalDirect(s, scoring)) {
      scoreGoal(s, scoring, ev);
      return;
    }
  }
  outOverGoalLine(s, end, ev);
}

// ================================================================ forfeit

/** Fallback when RUL-10 has not flagged a forfeit: a team below MIN_PLAYERS forfeits. */
function fallbackForfeit(s: SimState, ev: EventSink): void {
  for (let t = 0; t < 2; t++) {
    const first = teamFirstSlot(t);
    let n = 0;
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (s.players[i]!.active === 1) n++;
    if (n < MIN_PLAYERS) {
      s.match.forfeitTeam = t;
      ev.emit(EventType.FORFEIT, t);
      return;
    }
  }
}

/** Forfeit result: 3-0 to the other team unless it already leads by more. Idempotent. */
function applyForfeitScore(s: SimState): void {
  const f = s.match.forfeitTeam;
  if (f !== 0 && f !== 1) return;
  const w = other(f);
  const tw = s.teams[w]!;
  const tf = s.teams[f]!;
  if (tw.goals - tf.goals > 3) return;
  tw.goals = 3;
  tf.goals = 0;
}

function handleForfeit(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (m.phase === MatchPhase.FULL_TIME || m.phase === MatchPhase.POST_MATCH) return;
  if (!isLegal(m.phase, MatchPhase.FULL_TIME)) return; // wait for a phase that may end the match
  applyForfeitScore(s);
  resolveStoppage(s, ev);
  endSetPieceActions(s);
  m.restart.kind = RestartKind.NONE;
  ev.emit(EventType.PERIOD_END, m.period);
  ev.emit(EventType.WHISTLE, WhistleKind.FINAL);
  setPhase(s, MatchPhase.FULL_TIME, ev);
}

// ================================================================ clock and periods

/** Max added time for the current period in ticks (addedTimeMaxMinutes displayed). */
function maxAddedT(s: SimState): number {
  const m = s.match;
  const lenSec = m.period >= Period.ET_FIRST ? ET_DISPLAY_SEC : HALF_DISPLAY_SEC;
  return (T_RULES.addedTimeMaxMinutes * 60 * m.periodLen) / lenSec;
}

function isCrossKick(k: KickKind): boolean {
  return k === KickKind.CROSS || k === KickKind.LOW_CROSS || k === KickKind.GROUND_CROSS;
}

/** A shot struck and not yet resolved (bounded in time). */
function shotInFlight(s: SimState): boolean {
  const b = s.ball;
  return b.shotBy >= 0 && s.tick - b.shotTick <= LOCAL_TUNING.shotFlightMaxTicks;
}

/** A cross in flight: no touch since the cross, airborne or still moving, bounded in time. */
function crossInFlight(s: SimState): boolean {
  const b = s.ball;
  if (!isCrossKick(b.lastKickKind) || b.lastKickTick < 0) return false;
  if (b.lastTouchTick !== b.lastKickTick || s.tick - b.lastKickTick > LOCAL_TUNING.crossFlightMaxTicks) return false;
  const v = LOCAL_TUNING.crossLiveSpeed;
  return b.grounded === 0 || b.vx * b.vx + b.vz * b.vz > v * v;
}

/** Ball within halfEndAttackZone of a goal line, loose or owned by the team attacking that goal. */
function attackInFinalZone(s: SimState): boolean {
  const b = s.ball;
  const zone = HALF_LENGTH - T_RULES.halfEndAttackZone;
  if (b.x < zone && b.x > -zone) return false;
  if (b.owner < 0) return true;
  const end = b.x >= 0 ? 1 : -1;
  return s.teams[s.players[b.owner]!.team]!.dir === end;
}

/** True when this period end is the end of the match (no extra time or shoot-out follows). */
function isFinalWhistle(s: SimState): boolean {
  const m = s.match;
  const level = s.teams[0]!.goals === s.teams[1]!.goals;
  if (m.period === Period.SECOND_HALF) return !(isCup(s) && level);
  if (m.period === Period.ET_SECOND) return !level;
  return false;
}

function endPeriod(s: SimState, ev: EventSink): void {
  const m = s.match;
  resolveStoppage(s, ev);
  endSetPieceActions(s);
  m.restart.kind = RestartKind.NONE;
  ev.emit(EventType.PERIOD_END, m.period);
  ev.emit(EventType.WHISTLE, isFinalWhistle(s) ? WhistleKind.FINAL : WhistleKind.LONG);
  const odd = m.period === Period.FIRST_HALF || m.period === Period.ET_FIRST;
  setPhase(s, odd ? MatchPhase.HALF_TIME : MatchPhase.FULL_TIME, ev);
}

/** Time is up: end the period now unless the ball is in a live, dangerous situation (bounded). */
function periodEndCheck(s: SimState, ev: EventSink): void {
  const m = s.match;
  const ph = m.phase;
  if (ph === MatchPhase.KICK_OFF || ph === MatchPhase.PENALTY) { m.extensionT++; return; }
  if (ph === MatchPhase.IN_PLAY) {
    if (shotInFlight(s)) { m.extensionT++; return; }
    if ((crossInFlight(s) || attackInFinalZone(s)) && m.extensionT < T_RULES.halfEndExtensionTicks) { m.extensionT++; return; }
  }
  endPeriod(s, ev);
}

function clockTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (IS_CLOCK[m.phase] !== 1 || isPractice(s) || m.forfeitTeam >= 0 || m.finished === 1) return;
  m.periodT++;
  // Stoppage: the clock-running restart phases of regulation time (a kick-off never runs the clock, D-013).
  if (IS_RESTART[m.phase] === 1 && m.periodT <= m.periodLen) {
    const cap = maxAddedT(s);
    m.addedT += T_RULES.addedTimeScale;
    if (m.addedT > cap) m.addedT = cap;
  }
  if (m.periodT >= m.periodLen + m.addedT) periodEndCheck(s, ev);
}

function resetPeriodClock(s: SimState, period: Period): void {
  const m = s.match;
  m.period = period;
  m.periodT = 0;
  m.periodLen = period <= Period.ET_SECOND ? periodLength(s.config, period) : m.periodLen;
  m.addedT = 0;
  m.extensionT = 0;
}

// ================================================================ cut-scenes and breaks

function beginKickOff(s: SimState, team: number, ev: EventSink): void {
  setupKickOff(s, team, ev);
  if (s.match.phase !== MatchPhase.KICK_OFF) setPhase(s, MatchPhase.KICK_OFF, ev);
}

function enterShootOut(s: SimState, ev: EventSink): void {
  resetPeriodClock(s, Period.SHOOT_OUT);
  shootoutStart(s, ev);
  if (s.match.phase !== MatchPhase.SHOOT_OUT) setPhase(s, MatchPhase.SHOOT_OUT, ev);
}

function finishMatch(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (m.forfeitTeam === 0 || m.forfeitTeam === 1) {
    applyForfeitScore(s);
    m.winner = other(m.forfeitTeam);
  } else {
    const g0 = s.teams[0]!.goals;
    const g1 = s.teams[1]!.goals;
    m.winner = g0 > g1 ? 0 : g1 > g0 ? 1 : -1;
  }
  setPhase(s, MatchPhase.POST_MATCH, ev);
}

function afterFullTime(s: SimState, ev: EventSink): void {
  const m = s.match;
  const level = s.teams[0]!.goals === s.teams[1]!.goals;
  if (m.forfeitTeam < 0 && level && m.period === Period.SECOND_HALF && isCup(s)) {
    setPhase(s, MatchPhase.EXTRA_TIME, ev);
  } else if (m.forfeitTeam < 0 && level && m.period === Period.ET_SECOND) {
    enterShootOut(s, ev);
  } else {
    finishMatch(s, ev);
  }
}

function afterHalfTime(s: SimState, ev: EventSink): void {
  const m = s.match;
  s.teams[0]!.dir = -s.teams[0]!.dir;
  s.teams[1]!.dir = -s.teams[0]!.dir;
  resetPeriodClock(s, m.period === Period.ET_FIRST ? Period.ET_SECOND : Period.SECOND_HALF);
  beginKickOff(s, other(m.firstKickoffTeam), ev);
}

function afterExtraTimeBreak(s: SimState, ev: EventSink): void {
  const m = s.match;
  resetPeriodClock(s, Period.ET_FIRST);
  // Re-toss for extra time; firstKickoffTeam then means "kicked off the first period of this pair".
  m.firstKickoffTeam = rngInt(s.rng, 2);
  beginKickOff(s, m.firstKickoffTeam, ev);
}

/** After the replay (or a skipped one): kick-off by the conceding team, or the period ends if time is up. */
function afterReplay(s: SimState, ev: EventSink): void {
  if (isTimeUp(s)) endPeriod(s, ev);
  else beginKickOff(s, s.match.kickoffTeam, ev);
}

function replayTicks(s: SimState): number {
  const sec = s.config.replaySeconds;
  if (!(sec > 0)) return 0;
  const t = Math.round(sec * 60);
  return t < T_RULES.replayTicks ? t : T_RULES.replayTicks;
}

function enterReplay(s: SimState, ev: EventSink): void {
  setPhase(s, MatchPhase.REPLAY, ev);
  if (replayTicks(s) <= 0 || s.tick - s.match.goalTick >= T_RULES.goalSequenceMaxTicks) afterReplay(s, ev);
}

function startMatch(s: SimState, ev: EventSink): void {
  if (s.config.startPhase === MatchPhase.SHOOT_OUT) enterShootOut(s, ev);
  else if (s.config.startPhase === MatchPhase.IN_PLAY) startInPlay(s, ev);
  else beginKickOff(s, s.match.firstKickoffTeam, ev);
}

/**
 * [QF-1] config.startPhase IN_PLAY (practice, D-013: PRE_MATCH -> IN_PLAY is legal): both teams in their kick-off
 * layout with the ball on the centre spot at the feet of the practising side's taker (practice) or the side that
 * won the toss, and play live at once (no kick-off phase, no whistle wait). It used to start with a kick-off.
 */
function startInPlay(s: SimState, ev: EventSink): void {
  setupKickOff(s, isPractice(s) ? practiceTeam(s.config) : s.match.firstKickoffTeam, ev);
  s.match.restart.taker = -1;
  s.match.restart.ready = 0;
  setPhase(s, MatchPhase.IN_PLAY, ev);
}

/** Leave the current cut-scene / break phase the normal way (timer expired or skipped). */
function exitCutscene(s: SimState, ev: EventSink): void {
  switch (s.match.phase) {
    case MatchPhase.PRE_MATCH: startMatch(s, ev); break;
    case MatchPhase.GOAL:
      setPhase(s, MatchPhase.CELEBRATION, ev);
      startCelebrations(s, ev);
      break;
    case MatchPhase.CELEBRATION: enterReplay(s, ev); break;
    case MatchPhase.REPLAY: afterReplay(s, ev); break;
    case MatchPhase.HALF_TIME: afterHalfTime(s, ev); break;
    case MatchPhase.FULL_TIME: afterFullTime(s, ev); break;
    case MatchPhase.EXTRA_TIME: afterExtraTimeBreak(s, ev); break;
    default: break;
  }
}

/** Ticks the current cut-scene / break phase lasts (goal sequence phases also bounded by goalSequenceMaxTicks). */
function cutsceneLength(s: SimState): number {
  const m = s.match;
  switch (m.phase) {
    case MatchPhase.PRE_MATCH: return LOCAL_TUNING.preMatchTicks;
    case MatchPhase.GOAL: return T_RULES.goalPhaseTicks;
    case MatchPhase.CELEBRATION: return T_RULES.celebrationTicks;
    case MatchPhase.REPLAY: return replayTicks(s);
    case MatchPhase.HALF_TIME: return m.period >= Period.ET_FIRST ? LOCAL_TUNING.etHalfTimeTicks : T_RULES.halfTimeTicks;
    case MatchPhase.FULL_TIME: return T_RULES.fullTimeTicks;
    case MatchPhase.EXTRA_TIME: return T_RULES.extraTimeBreakTicks;
    default: return 0;
  }
}

/**
 * End the current cut-scene or break now, exactly as a skip would (for RUL-11's watchdog). Returns 1 if the phase
 * was a cut-scene / break (PRE_MATCH, GOAL, CELEBRATION, REPLAY, HALF_TIME, FULL_TIME, EXTRA_TIME), else 0.
 */
export function advanceCutscene(s: SimState, ev: EventSink): number {
  const ph = s.match.phase;
  if (!isPhase(ph) || IS_CUTSCENE[ph] !== 1 || ph === MatchPhase.POST_MATCH) return 0;
  exitCutscene(s, ev);
  return 1;
}

/** Timers and skips of the non-clock phases. */
function phaseTimers(s: SimState, ev: EventSink): void {
  const m = s.match;
  const ph = m.phase;
  if (IS_CUTSCENE[ph] !== 1 || ph === MatchPhase.POST_MATCH) return;
  // A skip only counts in a phase that was already showing (never cascades through phases in one tick).
  let due = m.phaseT >= cutsceneLength(s) || (m.phaseT > 0 && skipPressed(s));
  if (ph === MatchPhase.GOAL || ph === MatchPhase.CELEBRATION || ph === MatchPhase.REPLAY) {
    if (s.tick - m.goalTick >= T_RULES.goalSequenceMaxTicks) due = true;
  }
  if (due) exitCutscene(s, ev);
}

// ================================================================ rulesTick

function restartKindTick(s: SimState, ev: EventSink): void {
  switch (s.match.phase) {
    case MatchPhase.KICK_OFF: kickOffTick(s, ev); break;
    case MatchPhase.THROW_IN: throwInTick(s, ev); break;
    case MatchPhase.GOAL_KICK: goalKickTick(s, ev); break;
    case MatchPhase.CORNER: cornerTick(s, ev); break;
    case MatchPhase.FREE_KICK: freeKickTick(s, ev); break;
    case MatchPhase.PENALTY: penaltyTick(s, ev); break;
    default: break;
  }
}

export function rulesTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (!isPhase(m.phase) || m.phase === MatchPhase.POST_MATCH) return;
  // (1) live rules
  if (IS_CLOCK[m.phase] === 1) {
    offsideTick(s, ev);
    foulsTick(s, ev);
  }
  // (2) ball over a line in play
  if (m.phase === MatchPhase.IN_PLAY && s.ball.cross !== CrossKind.NONE) handleCrossing(s, ev);
  // (3) restarts
  if (IS_RESTART[m.phase] === 1) {
    restartTick(s, ev);
    restartKindTick(s, ev);
    if (IS_RESTART[m.phase] === 1 && m.restart.taken === 1) {
      setPhase(s, MatchPhase.IN_PLAY, ev);
      // Out of play straight from the restart kick in the same tick.
      if (s.ball.cross !== CrossKind.NONE) handleCrossing(s, ev);
    }
  } else if (m.phase === MatchPhase.SHOOT_OUT) {
    // (4) shoot-out
    shootoutTick(s, ev);
  }
  // (5) substitutions and forfeit
  subsTick(s, ev);
  if (m.finished === 0 && !isPractice(s)) {
    if (m.forfeitTeam < 0) {
      checkForfeit(s, ev);
      if (m.forfeitTeam < 0) fallbackForfeit(s, ev);
    }
    if (m.forfeitTeam >= 0) handleForfeit(s, ev);
  }
  // (6) clock, periods, cut-scenes and breaks
  clockTick(s, ev);
  phaseTimers(s, ev);
}

// ================================================================ kick-off

/** Formation spot of a player for a kick-off of his team's current direction (own half, inside the pitch). */
function formationSpot(s: SimState, slot: number, out: { x: number; z: number }): void {
  const p = s.players[slot]!;
  const t = s.teams[p.team]!;
  const dir = t.dir;
  const form = getFormation(t.formation);
  const fs = form.slots[p.formIdx] ?? form.slots[0]!;
  let x = dir * fs.nx * HALF_LENGTH * LOCAL_TUNING.kickOffDepthScale;
  const z = dir * fs.nz * HALF_WIDTH * LOCAL_TUNING.kickOffWidthScale;
  if (dir * x > -LOCAL_TUNING.kickOffHalfMargin) x = -dir * LOCAL_TUNING.kickOffHalfMargin;
  const mx = HALF_LENGTH - LOCAL_TUNING.kickOffPitchMargin;
  const mz = HALF_WIDTH - LOCAL_TUNING.kickOffPitchMargin;
  out.x = clampNum(x, -mx, mx);
  out.z = clampNum(z, -mz, mz);
}

/** Most advanced active outfield player of a team (formation nx; ties: smaller |nz|, then lower slot); -1 none. */
function pickAdvanced(s: SimState, team: number, exclude: number): number {
  const t = s.teams[team]!;
  const form = getFormation(t.formation);
  const first = teamFirstSlot(team);
  let best = -1;
  let bestNx = -1e9;
  let bestNz = 1e9;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1 || i === exclude) continue;
    const fs = form.slots[p.formIdx] ?? form.slots[0]!;
    const nz = fs.nz < 0 ? -fs.nz : fs.nz;
    if (fs.nx > bestNx || (fs.nx === bestNx && nz < bestNz)) { best = i; bestNx = fs.nx; bestNz = nz; }
  }
  return best;
}

/** Active keeper of a team, -1 if none. */
function activeKeeper(s: SimState, team: number): number {
  const k = s.teams[team]!.keeperSlot;
  return k >= 0 && k < NUM_SLOTS && s.players[k]!.active === 1 && s.players[k]!.team === team ? k : -1;
}

/** Keep a placed player legal: own half, defending team outside the centre circle, inside the pitch. */
function constrainKickOff(s: SimState, slot: number, kickTeam: number): void {
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir;
  let x = PLACE_X[slot]!;
  let z = PLACE_Z[slot]!;
  if (dir * x > -LOCAL_TUNING.kickOffHalfMargin) x = -dir * LOCAL_TUNING.kickOffHalfMargin;
  if (p.team !== kickTeam) {
    const r = CENTRE_CIRCLE_RADIUS + LOCAL_TUNING.kickOffCircleMargin;
    const d = Math.sqrt(x * x + z * z);
    if (d < r) {
      if (d < 1e-6) { x = -dir * r; z = 0; } else { x = (x / d) * r; z = (z / d) * r; }
    }
  }
  const mx = HALF_LENGTH - LOCAL_TUNING.kickOffPitchMargin;
  const mz = HALF_WIDTH - LOCAL_TUNING.kickOffPitchMargin;
  PLACE_X[slot] = clampNum(x, -mx, mx);
  PLACE_Z[slot] = clampNum(z, -mz, mz);
}

function resetPlayerForKickOff(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir;
  p.x = PLACE_X[slot]!;
  p.z = PLACE_Z[slot]!;
  p.vx = 0; p.vz = 0;
  p.fx = dir; p.fz = 0;
  p.moveMode = MoveMode.STOP;
  p.ix = 0; p.iz = 0;
  p.tgtX = p.x; p.tgtZ = p.z; p.tgtSpeed = 0;
  p.wantSprint = 0; p.lookAt = 0; p.lookX = 0; p.lookZ = 0;
  p.sprinting = 0; p.jockeying = 0; p.shielding = 0;
  p.stunT = 0; p.touchCd = 0; p.noTouchT = 0;
}

/** Set up a kick-off for team (positions both teams in their halves, taker on the spot). */
export function setupKickOff(s: SimState, team: number, ev: EventSink): void {
  const m = s.match;
  let kt = team === 1 ? 1 : 0;
  // A side with no outfield player (practice: a lone keeper) cannot kick off: the other side does.
  let taker = pickAdvanced(s, kt, -1);
  if (taker < 0) {
    const alt = pickAdvanced(s, other(kt), -1);
    if (alt >= 0) { kt = other(kt); taker = alt; } else taker = activeKeeper(s, kt);
  }
  m.kickoffTeam = kt;
  // Stale rule state from the previous phase of play.
  m.advantage.active = 0;
  m.advantage.card = CardKind.NONE;
  for (let i = 0; i < m.challenges.length; i++) m.challenges[i]!.active = 0;
  m.offside.flags = 0;
  // Everyone stops what he is doing.
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    PLACE_FIXED[slot] = 0;
    if (p.active !== 1) continue;
    if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
    formationSpot(s, slot, SPOT);
    PLACE_X[slot] = SPOT.x;
    PLACE_Z[slot] = SPOT.z;
  }
  // Taker beside the ball on the spot, a teammate beside him.
  const dir = s.teams[kt]!.dir;
  const partner = taker >= 0 ? pickAdvanced(s, kt, taker) : -1;
  if (taker >= 0) {
    PLACE_X[taker] = -dir * LOCAL_TUNING.kickOffTakerBehind;
    PLACE_Z[taker] = 0;
    PLACE_FIXED[taker] = 1;
  }
  if (partner >= 0) {
    const pz = PLACE_Z[partner]!;
    const side = pz < 0 ? -1 : 1;
    PLACE_X[partner] = -dir * LOCAL_TUNING.kickOffPartnerBehind;
    PLACE_Z[partner] = side * LOCAL_TUNING.kickOffPartnerSide;
    PLACE_FIXED[partner] = 1;
  }
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    if (s.players[slot]!.active === 1 && PLACE_FIXED[slot] === 0) constrainKickOff(s, slot, kt);
  }
  // De-overlap (rare: formation data is spread out); fixed players never move.
  const min2 = LOCAL_TUNING.kickOffMinSpacing * LOCAL_TUNING.kickOffMinSpacing;
  for (let pass = 0; pass < 6; pass++) {
    let moved = 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      if (s.players[i]!.active !== 1 || PLACE_FIXED[i] === 1) continue;
      for (let j = 0; j < NUM_SLOTS; j++) {
        if (j === i || s.players[j]!.active !== 1) continue;
        if (PLACE_FIXED[j] === 0 && j > i) continue; // each loose pair once: the later slot moves
        const dx = PLACE_X[i]! - PLACE_X[j]!;
        const dz = PLACE_Z[i]! - PLACE_Z[j]!;
        if (dx * dx + dz * dz >= min2) continue;
        const away = dz < 0 ? -1 : dz > 0 ? 1 : PLACE_Z[i]! <= 0 ? 1 : -1;
        PLACE_Z[i] = PLACE_Z[j]! + away * LOCAL_TUNING.kickOffMinSpacing;
        constrainKickOff(s, i, kt);
        moved++;
      }
    }
    if (moved === 0) break;
  }
  for (let slot = 0; slot < NUM_SLOTS; slot++) if (s.players[slot]!.active === 1) resetPlayerForKickOff(s, slot);
  // Ball still on the centre spot.
  const b = s.ball;
  releasePossession(s, ev);
  b.x = 0; b.y = BALL_RADIUS; b.z = 0;
  b.px = 0; b.py = BALL_RADIUS; b.pz = 0;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1; b.bounces = 0;
  b.owner = -1; b.ownerT = 0; b.heldBy = -1;
  b.passTarget = -1; b.shotBy = -1; b.shotOnTarget = 0; b.inNet = 0; b.idleT = 0;
  b.cross = CrossKind.NONE;
  // Restart record.
  const r = m.restart;
  r.kind = RestartKind.KICK_OFF;
  r.team = kt;
  r.x = 0; r.z = 0;
  r.taker = taker;
  r.t = 0; r.ready = 0; r.taken = 0;
  r.timeoutT = T_RULES.restartTimeoutTicks;
  r.wallCount = 0;
  for (let i = 0; i < r.wall.length; i++) r.wall[i] = -1;
  r.wallX = 0; r.wallZ = 0;
  r.aimX = partner >= 0 ? s.players[partner]!.x : 0;
  r.aimZ = partner >= 0 ? s.players[partner]!.z : 0;
  r.aimPower = 0; r.aimCurve = 0;
  r.side = 0; // KICK_OFF use: 1 once the start whistle has blown
  legalizePositions(s);
}

/** Nearest active teammate of `slot` to the ball, -1 if none. */
function nearestTeammate(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const first = teamFirstSlot(p.team);
  const b = s.ball;
  let best = -1;
  let bestD = 1e18;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (i === slot || q.active !== 1) continue;
    const dx = q.x - b.x, dz = q.z - b.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function validTaker(s: SimState): number {
  const r = s.match.restart;
  const t = r.taker;
  if (t >= 0 && t < NUM_SLOTS) {
    const p = s.players[t]!;
    if (p.active === 1 && p.team === r.team) return t;
  }
  return -1;
}

/** Start the kick-off pass (SIM-08 startPass KICK_OFF to the nearest teammate). ctrlIdx -1 = default. 1 = started. */
function takeKickOff(s: SimState, ctrlIdx: number, ev: EventSink): number {
  const taker = validTaker(s);
  if (taker < 0) return 0;
  const p = s.players[taker]!;
  if (p.act === ActionKind.KICK || p.act === ActionKind.SHOT) return 0; // already kicking
  if (p.act === ActionKind.SET_PIECE) endAction(s, taker, 0);
  if (!isFree(p)) return 0;
  const recv = nearestTeammate(s, taker);
  clearActionRequest(REQ);
  const dir = s.teams[p.team]!.dir;
  REQ.dirX = dir;
  REQ.dirZ = 0;
  if (recv >= 0) {
    const q = s.players[recv]!;
    const dx = q.x - s.ball.x, dz = q.z - s.ball.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) { REQ.dirX = dx / d; REQ.dirZ = dz / d; }
    REQ.targetSlot = recv;
  }
  REQ.power = LOCAL_TUNING.kickOffPower;
  REQ.charging = 0;
  REQ.flags = ReqFlag.SET_PIECE;
  REQ.assist = AssistLevel.ASSISTED;
  if (ctrlIdx >= 0 && ctrlIdx < s.ctrl.length) {
    const c = s.ctrl[ctrlIdx]!;
    REQ.assist = c.assist;
    if (c.kind === ControllerKind.CPU) REQ.flags |= ReqFlag.CPU;
  }
  return startPass(s, taker, KickKind.KICK_OFF, REQ, ev);
}

/** Safety net: kick the ball straight to the nearest teammate through applyKick (logged as WATCHDOG). */
function forceKickOff(s: SimState, ev: EventSink): void {
  const m = s.match;
  const taker = validTaker(s);
  if (taker < 0) return;
  const p = s.players[taker]!;
  if (p.act !== ActionKind.NONE) endAction(s, taker, 1);
  const b = s.ball;
  const recv = nearestTeammate(s, taker);
  const dir = s.teams[p.team]!.dir;
  let ux = dir, uz = 0, tx = b.x + dir * 5, tz = b.z;
  if (recv >= 0) {
    const q = s.players[recv]!;
    const dx = q.x - b.x, dz = q.z - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) { ux = dx / d; uz = dz / d; }
    tx = q.x; tz = q.z;
  }
  const L = LAUNCH;
  L.vx = ux * LOCAL_TUNING.kickOffForceSpeed; L.vy = 0; L.vz = uz * LOCAL_TUNING.kickOffForceSpeed;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = KickKind.KICK_OFF;
  L.target = recv;
  L.tx = tx; L.tz = tz;
  L.onTarget = 0;
  m.watchdogCount++;
  ev.emit(EventType.WATCHDOG, WatchdogReason.RESTART_BLOCKED, MatchPhase.KICK_OFF);
  applyKick(s, taker, L, LOCAL_TUNING.kickOffPower, ev);
}

/** Default kick-off (timeout / CPU fallback): short pass to the nearest teammate. */
export function kickOffDefault(s: SimState, ev: EventSink): void {
  const m = s.match;
  if (m.phase !== MatchPhase.KICK_OFF || m.restart.kind !== RestartKind.KICK_OFF || m.restart.taken === 1) return;
  takeKickOff(s, -1, ev);
}

/** Per tick during KICK_OFF (called by rulesTick after RUL-11 restartTick): keeps taker and ball on the spot,
 *  readiness + start whistle, timeout default, forced kick safety net. */
export function kickOffTick(s: SimState, ev: EventSink): void {
  const m = s.match;
  const r = m.restart;
  if (m.phase !== MatchPhase.KICK_OFF || r.kind !== RestartKind.KICK_OFF || r.taken === 1) return;
  const dir = s.teams[r.team === 1 ? 1 : 0]!.dir;
  // Taker valid (re-pick if sent off / substituted) and on his spot.
  let taker = validTaker(s);
  if (taker < 0) {
    const team = r.team === 1 ? 1 : 0;
    taker = pickAdvanced(s, team, -1);
    if (taker < 0) taker = activeKeeper(s, team);
    r.taker = taker;
  }
  if (taker >= 0) {
    const p = s.players[taker]!;
    if (p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) {
      const sx = -dir * LOCAL_TUNING.kickOffTakerBehind;
      const dx = p.x - sx, dz = p.z;
      const tol = LOCAL_TUNING.kickOffPinTolerance;
      if (dx * dx + dz * dz > tol * tol) {
        p.x = sx; p.z = 0; p.vx = 0; p.vz = 0; p.fx = dir; p.fz = 0;
      }
    }
  }
  // Ball still on the spot until it is played.
  const b = s.ball;
  if (b.owner >= 0 && b.owner !== taker) releasePossession(s, ev);
  const bt = LOCAL_TUNING.kickOffBallTolerance;
  const far = b.x * b.x + b.z * b.z > bt * bt;
  // Loose: back on the spot if moved or moving. Owned by the taker (kick wind-up): only if he took it away.
  if (b.owner < 0 ? far || b.vx !== 0 || b.vz !== 0 || b.vy !== 0 || b.y !== BALL_RADIUS : far) {
    b.x = 0; b.y = BALL_RADIUS; b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0;
    b.sx = 0; b.sy = 0; b.sz = 0; b.grounded = 1; b.inNet = 0;
  }
  // Ready after the setup delay (RUL-11 normally sets it at the same moment).
  if (r.ready !== 1 && m.phaseT >= T_RULES.restartSetupTicks) r.ready = 1;
  if (r.ready !== 1) return;
  if (r.side === 0) {
    r.side = 1;
    ev.emit(EventType.WHISTLE, WhistleKind.START);
  }
  const waited = m.phaseT - T_RULES.restartSetupTicks;
  const human = teamHasHumanCtrl(s, r.team);
  const due = human ? T_RULES.restartTimeoutTicks : T_RULES.cpuRestartDelay + LOCAL_TUNING.kickOffCpuGraceTicks;
  if (waited >= due) kickOffDefault(s, ev);
  // [QF-1] Never force over a kick-off kick that is under way: a side handed to the CPU mid kick-off (Command.HAND_TO_CPU,
  // a pad disconnect) drops `due` from 12 s to 2 s at once, so the Default and the forced kick used to fall in the same
  // tick: the Default's pass had just started its wind-up and the safety net kicked over it (WATCHDOG RESTART_BLOCKED).
  const tk = r.taker >= 0 && r.taker < NUM_SLOTS ? s.players[r.taker]! : null;
  const kicking = tk !== null && (tk.act === ActionKind.KICK || tk.act === ActionKind.SHOT);
  if (r.taken !== 1 && !kicking && waited >= due + LOCAL_TUNING.kickOffForceTicks) forceKickOff(s, ev);
}

function teamHasHumanCtrl(s: SimState, team: number): boolean {
  for (let i = 0; i < s.ctrl.length; i++) {
    const c = s.ctrl[i]!;
    if (c.kind === ControllerKind.HUMAN && c.side === team) return true;
  }
  return false;
}

/** Kick-off set-piece input (taker presses PASS). */
export function kickOffInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void {
  const m = s.match;
  const r = m.restart;
  if (m.phase !== MatchPhase.KICK_OFF || r.kind !== RestartKind.KICK_OFF || r.taken === 1 || r.ready !== 1) return;
  if (ctrlIdx < 0 || ctrlIdx >= s.ctrl.length) return;
  const c = s.ctrl[ctrlIdx]!;
  if (c.kind === ControllerKind.NONE || c.side !== r.team) return;
  // The resolver has already edge-tracked this frame into c.buttons / c.prevButtons.
  const pressed = (c.buttons & Btn.PASS) !== 0 && (c.prevButtons & Btn.PASS) === 0;
  if (!pressed || (f.buttons & Btn.PASS) === 0) return;
  takeKickOff(s, ctrlIdx, ev);
}

// ================================================================ clock display

/** Displayed clock: minutes, seconds (scaled to 45:00 halves) and added minutes for the period. Pure. */
export function displayClock(s: SimState, out: { min: number; sec: number; added: number; period: number }): void {
  const m = s.match;
  const per = m.period;
  out.period = per;
  out.added = 0;
  if (per >= Period.SHOOT_OUT || per < Period.FIRST_HALF) {
    out.min = per >= Period.SHOOT_OUT && s.config.mode !== ModeId.SHOOT_OUT ? PERIOD_BASE_MIN[Period.SHOOT_OUT]! : 0;
    out.sec = 0;
    return;
  }
  const base = PERIOD_BASE_MIN[per]!;
  const len = m.periodLen;
  if (!(len > 0)) { out.min = base; out.sec = 0; return; }
  const lenSec = per >= Period.ET_FIRST ? ET_DISPLAY_SEC : HALF_DISPLAY_SEC;
  const t = m.periodT > 0 ? m.periodT : 0;
  const total = Math.floor((t * lenSec) / len);
  out.min = base + Math.floor(total / 60);
  out.sec = total % 60;
  if (t >= len && m.addedT > 0) {
    const mins = Math.ceil((m.addedT * lenSec) / (len * 60));
    out.added = mins < T_RULES.addedTimeMaxMinutes ? mins : T_RULES.addedTimeMaxMinutes;
  }
}

// ================================================================ celebrations

/** Start a CELEBRATE action: leader = -1 for the scorer (runs to the spot), else the slot he joins at an offset. */
function startCelebrate(s: SimState, slot: number, leader: number, spotX: number, spotZ: number, offX: number, offZ: number): void {
  const p = s.players[slot]!;
  if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
  beginAction(p, ActionKind.CELEBRATE, T_RULES.celebrationTicks, -1);
  p.actA = rngInt(s.rng, 3);
  p.actB = leader < 0 ? 1 : 0;
  p.actSlot = leader;
  p.actX = spotX;
  p.actZ = spotZ;
  p.actDirX = offX;
  p.actDirZ = offZ;
}

function startDejected(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
  beginAction(p, ActionKind.DEJECTED, T_RULES.celebrationTicks, -1);
  formationSpot(s, slot, SPOT);
  p.actX = SPOT.x;
  p.actZ = SPOT.z;
}

/** Joiner offsets around the leader (unit, x toward the leader's own goal side, z across). */
const JOIN_OX: readonly number[] = [-1, 0, 0, -0.7, -0.7];
const JOIN_OZ: readonly number[] = [0, 1, -1, 0.7, -0.7];

/** On entering CELEBRATION: scorer + nearby teammates CELEBRATE, the conceding team DEJECTED. */
function startCelebrations(s: SimState, ev: EventSink): void {
  void ev;
  const m = s.match;
  const scoring = m.goalTeam;
  if (scoring !== 0 && scoring !== 1) return;
  const conceding = other(scoring);
  const end = s.teams[scoring]!.dir;
  // Leader: the scorer (not for an own goal), else the scoring team's outfield player nearest the ball.
  let leader = -1;
  const sc = m.goalScorer;
  if (m.goalOwn === 0 && sc >= 0 && sc < NUM_SLOTS && s.players[sc]!.active === 1 && s.players[sc]!.team === scoring) leader = sc;
  if (leader < 0 || isUninterruptible(s.players[leader]!.act)) {
    leader = -1;
    let bestD = 1e18;
    const first = teamFirstSlot(scoring);
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.isKeeper === 1 || isUninterruptible(p.act)) continue;
      const dx = p.x - s.ball.x, dz = p.z - s.ball.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; leader = i; }
    }
  }
  if (leader >= 0) {
    const lp = s.players[leader]!;
    const side = lp.z < 0 ? -1 : 1;
    const spotX = end * (HALF_LENGTH - LOCAL_TUNING.celebrateSpotInsetX);
    const spotZ = side * (HALF_WIDTH - LOCAL_TUNING.celebrateSpotInsetZ);
    startCelebrate(s, leader, -1, spotX, spotZ, 0, 0);
    let chosen = 0;
    const r2 = LOCAL_TUNING.celebrateJoinRadius * LOCAL_TUNING.celebrateJoinRadius;
    const first = teamFirstSlot(scoring);
    for (let k = 0; k < LOCAL_TUNING.celebrateMaxJoin && k < JOIN_OX.length; k++) {
      let best = -1;
      let bestD = r2;
      for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
        if (i === leader || ((chosen >>> i) & 1) === 1) continue;
        const p = s.players[i]!;
        if (p.active !== 1 || p.isKeeper === 1 || isUninterruptible(p.act)) continue;
        const dx = p.x - lp.x, dz = p.z - lp.z;
        const d = dx * dx + dz * dz;
        if (d <= bestD) { bestD = d; best = i; }
      }
      if (best < 0) break;
      chosen |= 1 << best;
      const jd = LOCAL_TUNING.celebrateJoinDist;
      startCelebrate(s, best, leader, spotX, spotZ, -end * JOIN_OX[k]! * jd, JOIN_OZ[k]! * jd);
    }
  }
  const cf = teamFirstSlot(conceding);
  for (let i = cf; i < cf + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || isUninterruptible(p.act)) continue;
    startDejected(s, i);
  }
}

function setArrive(p: PlayerState, x: number, z: number, speed: number): void {
  const mx = HALF_LENGTH - LOCAL_TUNING.celebrateInsideMargin;
  const mz = HALF_WIDTH - LOCAL_TUNING.celebrateInsideMargin;
  p.moveMode = MoveMode.ARRIVE;
  p.tgtX = clampNum(x, -mx, mx);
  p.tgtZ = clampNum(z, -mz, mz);
  p.tgtSpeed = speed;
  p.wantSprint = 0;
  p.lookAt = 0;
}

/** Action end: free to move, and inside the pitch (glitch: players staying off the pitch after a celebration). */
function endCutsceneAction(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.moveMode = MoveMode.STOP;
  p.ix = 0; p.iz = 0;
  p.tgtSpeed = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  const mx = HALF_LENGTH - LOCAL_TUNING.celebrateInsideMargin;
  const mz = HALF_WIDTH - LOCAL_TUNING.celebrateInsideMargin;
  if (p.x > mx || p.x < -mx || p.z > mz || p.z < -mz) {
    p.x = clampNum(p.x, -mx, mx);
    p.z = clampNum(p.z, -mz, mz);
    p.vx = 0; p.vz = 0;
  }
}

function celebrateUpdate(s: SimState, slot: number, ev: EventSink): void {
  void ev;
  const p = s.players[slot]!;
  const l = p.actSlot;
  if (l >= 0 && l < NUM_SLOTS) {
    const lp = s.players[l]!;
    if (lp.active === 1 && lp.act === ActionKind.CELEBRATE) setArrive(p, lp.x + p.actDirX, lp.z + p.actDirZ, LOCAL_TUNING.celebrateJoinSpeed);
    else setArrive(p, p.x, p.z, LOCAL_TUNING.celebrateJoinSpeed);
    return;
  }
  const v = p.actA >= 0 && p.actA < LOCAL_TUNING.celebrateVariantSpeed.length ? LOCAL_TUNING.celebrateVariantSpeed[p.actA]! : 1;
  setArrive(p, p.actX, p.actZ, LOCAL_TUNING.celebrateRunSpeed * v);
}

function celebrateEnd(s: SimState, slot: number, interrupted: number): void {
  void interrupted;
  endCutsceneAction(s, slot);
}

function dejectedUpdate(s: SimState, slot: number, ev: EventSink): void {
  void ev;
  const p = s.players[slot]!;
  setArrive(p, p.actX, p.actZ, LOCAL_TUNING.dejectedWalkSpeed);
}

function dejectedEnd(s: SimState, slot: number, interrupted: number): void {
  void interrupted;
  endCutsceneAction(s, slot);
}

/**
 * ActionKind.CELEBRATE handler (actA = variant 0..2, actB = 1 for the leader, actSlot = leader for joiners,
 * actX/actZ = celebration spot, actDirX/actDirZ = joiner offset from the leader). A hoisted function object so
 * the registry gets a valid reference even inside an import cycle; update/end are attached below.
 */
export function celebrateHandler(): void { /* see celebrateHandler.update / .end */ }
celebrateHandler.update = celebrateUpdate;
celebrateHandler.end = celebrateEnd;

/** ActionKind.DEJECTED handler (actX/actZ = formation spot the player trudges back to). Hoisted like celebrateHandler. */
export function dejectedHandler(): void { /* see dejectedHandler.update / .end */ }
dejectedHandler.update = dejectedUpdate;
dejectedHandler.end = dejectedEnd;

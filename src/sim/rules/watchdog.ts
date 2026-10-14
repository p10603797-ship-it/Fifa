/**
 * [RUL-11] Watchdog: if a stopped state outlasts its maximum time (T_RULES.phaseMaxTicks), a player stays in an
 * action past its tick budget, or the ball lies unreachable or untouched for 8 s in play, force the nearest legal
 * restart (drop-ball-free: give a free kick / throw-in / goal kick to the sensible team) and log it (WATCHDOG
 * event, match.watchdogCount++). In soak tests any trigger is a failure; in the shipped game it is a safety net.
 *
 * Runs last in every tick (step.ts stage 10). Checks, in order:
 *  1. ACTION_OVERRUN: a player in an action with actT > actDur + actionOverrunTicks (charging: + chargeOverrunTicks),
 *     or an action left on an inactive (sent-off) player -> endAction(interrupted). b = slot.
 *  2. PHASE_TIMEOUT: phaseT >= T_RULES.phaseMaxTicks[phase] (0 = unlimited) -> force the next legal step (b = phase):
 *     restart phases: forceRestartKick (if not taken) then IN_PLAY; PRE_MATCH -> first kick-off / shoot-out;
 *     GOAL -> CELEBRATION -> REPLAY -> kick-off by the conceding team (or HALF_TIME / FULL_TIME when time is up);
 *     HALF_TIME -> next period's kick-off (directions swapped, clock reset); FULL_TIME -> EXTRA_TIME / SHOOT_OUT (cup,
 *     level) or POST_MATCH; EXTRA_TIME -> first extra-time kick-off. Fires at phaseT == max, so the phase-max
 *     invariant (phaseT > max) never fails.
 *  3. IN_PLAY ball checks (b = RestartKind awarded):
 *     BALL_UNREACHABLE: the whole ball beyond a line by more than outSlack with no restart given (a missed crossing),
 *       in a net while play goes on, or resting above reach height (crossbar top / net roof).
 *     BALL_UNTOUCHED: ball.idleT >= T_RULES.ballIdleTicks (8 s) while loose or held in a keeper's hands (not in
 *       practice mode). An owned ball being dribbled is never "lying". [QF-1] Nor is a loose ball still on its way:
 *       sim/step counts ball.idleT only while the ball lies (horizontal speed below 1 m/s) or is in a keeper's hands
 *       (a long goal kick that bounced and rolled 85 m with both chasers running after it used to be "untouched for
 *       8 s" while still doing 5 m/s: false watchdogs in fuzz), and holds it at 0 while a field player owns the ball
 *       (a still ball at a standing owner's feet is his, not lying).
 *     Restart: team = the team that did not touch last (nobody: the team defending that half); beyond a touchline ->
 *     throw-in; beyond a goal line / in a net -> goal kick for the defenders or corner for the attackers; otherwise a
 *     free kick where the ball is (moved to the edge of the box when it lies in the opponents' penalty area).
 */
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../contracts/constants';
import { ActionKind, MatchPhase, ModeId, Period, RestartKind, WatchdogReason } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { T_RULES } from '../../contracts/tuning';
import { endAction } from '../actions/dispatch';
import { rngInt } from '../core/rng';
import { periodLength } from '../init';
import { advanceCutscene, setPhase } from './machine';
import { awardRestart, forceRestartKick } from './restart';
import { isRestartPhase, logWatchdog } from './restartCommon';
import { shootoutStart } from './shootout';

/** TUNING-CR (RUL-11): proposed additions to T_RULES (units in comments). */
export const LOCAL_TUNING = { // TUNING-CR
  /** An action overruns when actT > actDur + this, ticks. */
  actionOverrunTicks: 30,
  /** A charging action (power bar held) overruns when actT > actDur + this, ticks. */
  chargeOverrunTicks: 150,
  /** The ball centre this far beyond (line + BALL_RADIUS) counts as out of play, m. */
  outSlack: 0.05,
  /** A resting ball whose centre is above this height cannot be played, m (head + jump reach is ~2.3 m). */
  unreachableHeight: 2.2,
  /** A ball counts as resting when it moved less than this during the tick, m ... */
  restEps: 1e-4,
  /** ... is slower than this, m/s ... */
  restSpeed: 0.05,
  /** ... and has been untouched at least this long, ticks. */
  restingTicks: 60,
  /** A watchdog free kick in the opponents' penalty area is moved this far outside the area, m. */
  boxMargin: 1,
} as const;

function other(team: number): number {
  return team === 0 ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- 1. action overruns

function actionOverruns(s: SimState, ev: EventSink): void {
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    if (p.act === ActionKind.NONE) continue;
    let over = p.active !== 1;
    if (!over) {
      const lim = p.actCharging === 1 ? LOCAL_TUNING.chargeOverrunTicks : LOCAL_TUNING.actionOverrunTicks;
      over = p.actT > p.actDur + lim;
    }
    if (!over) continue;
    logWatchdog(s, ev, WatchdogReason.ACTION_OVERRUN, slot);
    endAction(s, slot, 1);
  }
}

// ---------------------------------------------------------------- 2. phase timeouts

function timeUp(s: SimState): boolean {
  const m = s.match;
  return m.periodT >= m.periodLen + m.addedT;
}

function beginKickOff(s: SimState, team: number, ev: EventSink): void {
  s.match.kickoffTeam = team;
  awardRestart(s, RestartKind.KICK_OFF, team, 0, 0, ev);
}

function resetClock(s: SimState, period: Period): void {
  const m = s.match;
  m.period = period;
  m.periodT = 0;
  m.addedT = 0;
  m.extensionT = 0;
  m.periodLen = periodLength(s.config, period);
}

/** Shoot-out as RUL-01 enters it: period SHOOT_OUT, RUL-07 shootoutStart, then the phase if it did not set it. */
function enterShootOut(s: SimState, ev: EventSink): void {
  const m = s.match;
  m.period = Period.SHOOT_OUT;
  m.periodT = 0;
  m.addedT = 0;
  m.extensionT = 0;
  shootoutStart(s, ev);
  if (m.phase !== MatchPhase.SHOOT_OUT) setPhase(s, MatchPhase.SHOOT_OUT, ev);
}

function finish(s: SimState, ev: EventSink): void {
  const m = s.match;
  const g0 = s.teams[0]!.goals;
  const g1 = s.teams[1]!.goals;
  m.winner = m.forfeitTeam === 0 || m.forfeitTeam === 1 ? other(m.forfeitTeam) : g0 > g1 ? 0 : g1 > g0 ? 1 : -1;
  setPhase(s, MatchPhase.POST_MATCH, ev);
  m.finished = 1;
}

/** Force the next legal step of a phase that outlasted its maximum (minimal RUL-01 bookkeeping). */
function forcePhaseStep(s: SimState, ev: EventSink): void {
  const m = s.match;
  const phase = m.phase;
  if (isRestartPhase(phase)) {
    if (m.restart.taken === 0) forceRestartKick(s, ev);
    setPhase(s, MatchPhase.IN_PLAY, ev);
    m.restart.kind = RestartKind.NONE;
    return;
  }
  switch (phase) {
    case MatchPhase.PRE_MATCH:
      // RUL-01's own start (kick-off, shoot-out, or straight into play for config.startPhase IN_PLAY).
      advanceCutscene(s, ev);
      return;
    case MatchPhase.GOAL:
      setPhase(s, MatchPhase.CELEBRATION, ev);
      return;
    case MatchPhase.CELEBRATION:
      setPhase(s, MatchPhase.REPLAY, ev);
      return;
    case MatchPhase.REPLAY:
      if (timeUp(s)) {
        const odd = m.period === Period.FIRST_HALF || m.period === Period.ET_FIRST;
        setPhase(s, odd ? MatchPhase.HALF_TIME : MatchPhase.FULL_TIME, ev);
      } else {
        const conceding = m.goalTeam === 0 || m.goalTeam === 1 ? other(m.goalTeam) : (m.kickoffTeam === 1 ? 1 : 0);
        beginKickOff(s, conceding, ev);
      }
      return;
    case MatchPhase.HALF_TIME:
      if (m.period === Period.FIRST_HALF) {
        resetClock(s, Period.SECOND_HALF);
        s.teams[0]!.dir = -1; // home attacks +x in the first half, -x in the second
        s.teams[1]!.dir = 1;
      } else if (m.period === Period.ET_FIRST) {
        resetClock(s, Period.ET_SECOND);
        s.teams[0]!.dir = -s.teams[0]!.dir;
        s.teams[1]!.dir = -s.teams[0]!.dir;
      }
      beginKickOff(s, other(m.firstKickoffTeam === 1 ? 1 : 0), ev);
      return;
    case MatchPhase.FULL_TIME: {
      const level = s.teams[0]!.goals === s.teams[1]!.goals;
      if (m.forfeitTeam < 0 && level && s.config.cupRules === 1 && m.period === Period.SECOND_HALF) {
        setPhase(s, MatchPhase.EXTRA_TIME, ev);
      } else if (m.forfeitTeam < 0 && level && m.period === Period.ET_SECOND) {
        enterShootOut(s, ev);
      } else {
        finish(s, ev);
      }
      return;
    }
    case MatchPhase.EXTRA_TIME:
      resetClock(s, Period.ET_FIRST);
      m.firstKickoffTeam = rngInt(s.rng, 2);
      beginKickOff(s, m.firstKickoffTeam, ev);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- 3. ball in play

/** Ball resting (not just at the top of its flight) above reach height: on the crossbar or the net roof. */
function restingUnreachable(s: SimState): boolean {
  const b = s.ball;
  if (b.owner >= 0 || b.y < LOCAL_TUNING.unreachableHeight || b.idleT < LOCAL_TUNING.restingTicks) return false;
  const rs = LOCAL_TUNING.restSpeed;
  if (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz > rs * rs) return false;
  const moved = Math.abs(b.x - b.px) + Math.abs(b.y - b.py) + Math.abs(b.z - b.pz);
  return moved < LOCAL_TUNING.restEps;
}

/** Award the nearest sensible restart for a ball the game cannot continue with. */
function awardForBall(s: SimState, ev: EventSink, reason: WatchdogReason, beyondX: number, beyondZ: number): void {
  const b = s.ball;
  const t0dir = s.teams[0]!.dir;
  let team: number;
  if (b.lastTouchTeam === 0 || b.lastTouchTeam === 1) team = other(b.lastTouchTeam);
  else team = t0dir * b.x <= 0 ? 0 : 1; // nobody touched it: the team defending that half
  const sideZ = b.z < 0 ? -1 : 1;
  let kind: RestartKind;
  let x: number;
  let z: number;
  const out = beyondX > LOCAL_TUNING.outSlack || beyondZ > LOCAL_TUNING.outSlack;
  if (out && beyondZ >= beyondX) {
    kind = RestartKind.THROW_IN;
    x = clamp(b.x, -HALF_LENGTH, HALF_LENGTH);
    z = sideZ * HALF_WIDTH;
  } else if (out || b.inNet !== 0) {
    const end = b.inNet === 1 || b.inNet === -1 ? b.inNet : b.x >= 0 ? 1 : -1;
    const defending = t0dir === -end ? 0 : 1;
    if (team === defending) {
      kind = RestartKind.GOAL_KICK;
      x = end * HALF_LENGTH;
      z = b.z;
    } else {
      kind = RestartKind.CORNER;
      x = end * HALF_LENGTH;
      z = sideZ * HALF_WIDTH;
    }
  } else {
    kind = RestartKind.FREE_KICK;
    x = clamp(b.x, -HALF_LENGTH, HALF_LENGTH);
    z = clamp(b.z, -HALF_WIDTH, HALF_WIDTH);
    const att = s.teams[team]!.dir;
    if (att * x >= HALF_LENGTH - PENALTY_AREA_DEPTH && z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH) {
      x = att * (HALF_LENGTH - PENALTY_AREA_DEPTH - LOCAL_TUNING.boxMargin);
    }
  }
  logWatchdog(s, ev, reason, kind);
  awardRestart(s, kind, team, x, z, ev);
}

function ballChecks(s: SimState, ev: EventSink): void {
  const b = s.ball;
  const beyondX = Math.abs(b.x) - HALF_LENGTH - BALL_RADIUS;
  const beyondZ = Math.abs(b.z) - HALF_WIDTH - BALL_RADIUS;
  const out = beyondX > LOCAL_TUNING.outSlack || beyondZ > LOCAL_TUNING.outSlack;
  if (out || b.inNet !== 0 || restingUnreachable(s)) {
    awardForBall(s, ev, WatchdogReason.BALL_UNREACHABLE, beyondX, beyondZ);
    return;
  }
  if (s.config.mode === ModeId.PRACTICE) return;
  if (b.idleT >= T_RULES.ballIdleTicks && (b.owner < 0 || b.heldBy >= 0)) {
    awardForBall(s, ev, WatchdogReason.BALL_UNTOUCHED, beyondX, beyondZ);
  }
}

export function watchdogTick(s: SimState, ev: EventSink): void {
  actionOverruns(s, ev);
  const m = s.match;
  const max = T_RULES.phaseMaxTicks[m.phase] ?? 0;
  if (max > 0 && m.phaseT >= max) {
    logWatchdog(s, ev, WatchdogReason.PHASE_TIMEOUT, m.phase);
    forcePhaseStep(s, ev);
    return;
  }
  if (m.phase === MatchPhase.IN_PLAY) ballChecks(s, ev);
}

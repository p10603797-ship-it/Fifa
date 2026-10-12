/**
 * [MOD-05] Match stats tracking and summary (Wave 0 version by FND-04).
 *
 * Minimal real tracker fed by the loop after every tick: goals (GOAL events, score from state), shots and shots on
 * target (SHOT), possession (ticks with state.ball.owner per team), passes (KICK with a pass kind) and completed
 * passes (PASS_COMPLETE), tackles, fouls, cards, offsides, corners, saves and interceptions. MOD-05 adds player
 * ratings, player of the match and records.
 * onTick allocates nothing except a GoalRecord when a goal is scored.
 */
import type { GoalRecord, MatchSummary, StatsTracker, TeamMatchStats } from '../contracts/app';
import { slotTeam } from '../contracts/constants';
import { CardKind, isFootPassKind, RestartKind } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { ReadonlySimState, SimState } from '../contracts/state';
import { displayClock } from '../sim/rules/machine';

export function emptyTeamStats(): TeamMatchStats {
  return {
    goals: 0, shots: 0, shotsOnTarget: 0, possession: 0.5, passes: 0, passesCompleted: 0, tackles: 0, tacklesWon: 0,
    fouls: 0, yellow: 0, red: 0, offsides: 0, corners: 0, saves: 0, interceptions: 0,
  };
}

const teamOf = (slot: number): number => (slot >= 0 && slot < 22 ? slotTeam(slot) : -1);

export function createStatsTracker(): StatsTracker {
  const teams: [TeamMatchStats, TeamMatchStats] = [emptyTeamStats(), emptyTeamStats()];
  const possTicks = [0, 0];
  const goals: GoalRecord[] = [];
  const clock = { min: 0, sec: 0, added: 0, period: 0 };

  function reset(): void {
    teams[0] = emptyTeamStats();
    teams[1] = emptyTeamStats();
    possTicks[0] = 0;
    possTicks[1] = 0;
    goals.length = 0;
  }

  return {
    reset(state) {
      void state;
      reset();
    },
    onTick(state, events: EventBuffer) {
      const owner = state.ball.owner;
      if (owner >= 0) {
        const t = teamOf(owner);
        if (t >= 0) possTicks[t]!++;
      }
      for (let i = 0; i < events.count; i++) {
        const e = events.get(i);
        switch (e.type) {
          case EventType.SHOT: {
            const t = teamOf(e.a);
            if (t < 0) break;
            teams[t]!.shots++;
            if (e.b) teams[t]!.shotsOnTarget++;
            break;
          }
          case EventType.GOAL: {
            const team = e.a === 1 ? 1 : 0;
            const scorer = state.players[e.b];
            const assist = e.c >= 0 ? state.players[e.c] : undefined;
            displayClock(state as unknown as SimState, clock);
            goals.push({
              team,
              rosterIdx: scorer ? scorer.rosterIdx : -1,
              assistRosterIdx: assist ? assist.rosterIdx : -1,
              ownGoal: e.d === 1,
              minute: Math.floor(clock.min) + 1,
            });
            break;
          }
          case EventType.KICK: {
            const t = teamOf(e.a);
            if (t >= 0 && isFootPassKind(e.b)) teams[t]!.passes++;
            break;
          }
          case EventType.PASS_COMPLETE: {
            const t = teamOf(e.b);
            if (t >= 0) teams[t]!.passesCompleted++;
            break;
          }
          case EventType.TACKLE: {
            const t = teamOf(e.a);
            if (t < 0) break;
            teams[t]!.tackles++;
            if (e.c) teams[t]!.tacklesWon++;
            break;
          }
          case EventType.FOUL: {
            const t = teamOf(e.a);
            if (t >= 0) teams[t]!.fouls++;
            break;
          }
          case EventType.CARD: {
            const t = teamOf(e.a);
            if (t < 0) break;
            if (e.b === CardKind.YELLOW) teams[t]!.yellow++;
            else if (e.b === CardKind.RED || e.b === CardKind.SECOND_YELLOW) teams[t]!.red++;
            break;
          }
          case EventType.OFFSIDE: {
            const t = teamOf(e.a);
            if (t >= 0) teams[t]!.offsides++;
            break;
          }
          case EventType.RESTART_AWARDED:
            if (e.a === RestartKind.CORNER && (e.b === 0 || e.b === 1)) teams[e.b]!.corners++;
            break;
          case EventType.SAVE: {
            const t = teamOf(e.a);
            if (t >= 0) teams[t]!.saves++;
            break;
          }
          case EventType.INTERCEPT: {
            const t = teamOf(e.a);
            if (t >= 0) teams[t]!.interceptions++;
            break;
          }
          default:
            break;
        }
      }
    },
    summary(state: ReadonlySimState): MatchSummary {
      const total = possTicks[0]! + possTicks[1]!;
      const out: [TeamMatchStats, TeamMatchStats] = [{ ...teams[0] }, { ...teams[1] }];
      for (let t = 0; t < 2; t++) {
        out[t]!.goals = state.teams[t]!.goals;
        out[t]!.possession = total > 0 ? possTicks[t]! / total : 0.5;
      }
      const so = state.match.shootout;
      const shootout: [number, number] | null = so.active || so.winner >= 0 ? [so.goals[0]!, so.goals[1]!] : null;
      let winner = state.match.winner;
      if (winner !== 0 && winner !== 1) {
        if (out[0].goals > out[1].goals) winner = 0;
        else if (out[1].goals > out[0].goals) winner = 1;
        else if (shootout && shootout[0] !== shootout[1]) winner = shootout[0] > shootout[1] ? 0 : 1;
        else winner = -1;
      }
      return {
        teams: out,
        players: [],
        goals: goals.map((g) => ({ ...g })),
        playerOfMatch: null,
        shootout,
        winner,
        forfeit: state.match.forfeitTeam,
        ticks: state.tick,
      };
    },
  };
}

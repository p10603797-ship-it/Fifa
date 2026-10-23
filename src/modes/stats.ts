/**
 * [MOD-05] Match stats tracking and the full-time summary (BRIEF §12 full time: stats and player of the match; §7
 * statistics bands). The app loop feeds the tracker after every sim tick (contracts/app.ts StatsTracker); QA bands
 * use the same tracker, so the definitions below are the single source of truth for every statistic.
 *
 * DEFINITIONS (team stats; per-player stats use the same rules for the player's own events):
 *  - goals: the authoritative score in state.teams[t].goals at summary time (includes a forfeit's 3-0). Each GOAL event
 *    (a = scoring team, b = scorer slot, c = assist slot, d = 1 own goal) adds a GoalRecord: team = scoring team,
 *    rosterIdx = scorer's squad index (for an own goal this indexes the squad of the OTHER team, 1 - team),
 *    assistRosterIdx (-1 none, never set for own goals), minute = displayed match minute (displayClock min + 1, capped
 *    at the end of the period: 45, 90, 105, 120, so added-time goals read 45' / 90').
 *  - shots / shotsOnTarget: SHOT events (a = shooter slot, b = 1 on target).
 *  - Nothing from the shoot-out period (Period.SHOOT_OUT) counts as a match statistic (its kicks emit SHOT / SAVE).
 *  - possession: share of IN_PLAY ticks in which a team had the ball. The ball belongs to the team of ball.owner; a
 *    loose ball (in flight, rolling) stays with the team that owned it last. Ticks before anyone owned it are not
 *    counted. possession[0] + possession[1] === 1 exactly (0.5 / 0.5 when nobody had the ball in play).
 *  - passes: KICK events (a = slot, b = KickKind) of a pass kind: GROUND_PASS..THROUGH_DINKED (ground, driven, dinked,
 *    lob, high lob, driven lob, crosses, through balls) and VOLLEY_PASS. NOT passes: HEADER_PASS, THROW_IN,
 *    keeper throws / rolls / kicks from hands, GOAL_KICK, KICK_OFF, CLEARANCE, shots, touches and deflections.
 *  - passesCompleted: PASS_COMPLETE events (a = receiver, b = passer) whose passer's latest KICK was a counted pass
 *    and whose receiver is a teammate; each counted pass completes at most once. So completion = completed / passes
 *    is always within 0..1 and header passes or throw-ins never inflate it.
 *  - tackles / tacklesWon: TACKLE events (a = tackler, c = 1 won the ball).
 *  - fouls: FOUL events (a = offender) with an outcome other than CLEAN.
 *  - yellow / red: CARD events. YELLOW = 1 yellow; RED = 1 red; SECOND_YELLOW = 1 yellow + 1 red (the card shown is a
 *    yellow, then the red), so a player sent off for two bookings counts 2 yellows and 1 red.
 *  - offsides: OFFSIDE events (a = offside player).
 *  - corners: RESTART_AWARDED events with a = CORNER (b = team awarded).
 *  - saves: SAVE events (a = keeper slot).
 *  - interceptions: INTERCEPT events (a = intercepting slot).
 *  - shootout: [home, away] goals from state.match.shootout when a shoot-out was played, else null.
 *  - winner: state.match.winner when decided (0/1), else by goals, else by the shoot-out, else -1 (draw).
 *  - forfeit: state.match.forfeitTeam (-1 none).
 *
 * PLAYERS: one PlayerMatchStats per squad member who was on the pitch at some point (starters and used subs), keyed by
 * (team, rosterIdx) read from the slot at the time of each event (substitutions reuse slots). minutes = displayed
 * match minutes on the pitch: clock ticks (clockRunning) while active, scaled so a full half is 45 (extra-time periods
 * use the same scale, so 15 each); added time counts. tackles = tackles won.
 * RATING (0..10, one decimal), from RATING below: start at `base`; + goal, assist, shot on target, completed pass,
 * tackle won, interception, save; - shot off target, failed pass, missed tackle, foul, yellow, red, own goal, goal
 * conceded while on the pitch (keepers and defenders); + clean sheet for keepers / defenders who played at least
 * `cleanSheetShare` of the match; + win / - loss for everyone who appeared; clamped to [min, max].
 * PLAYER OF THE MATCH: the highest rating; ties go to more goals, then more assists, then the winning side, then the
 * home side, then the lower squad index. null when nobody played.
 *
 * Per-tick cost: O(events + 22); onTick allocates nothing except one GoalRecord per goal. summary() allocates.
 * Robust to partial states (test doubles, a state missing players or config): missing parts count as nothing; the
 * tracker never throws into the loop.
 */
import type { GoalRecord, MatchSummary, PlayerMatchStats, StatsTracker, TeamMatchStats } from '../contracts/app';
import { NUM_SLOTS, PLAYERS_PER_TEAM, SQUAD_SIZE } from '../contracts/constants';
import { CardKind, ChallengeOutcome, KickKind, MatchPhase, Period, RestartKind, Role } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { ReadonlySimState, SimState } from '../contracts/state';
import { displayClock } from '../sim/rules/machine';

/** Player-rating weights (rating points). Presentation numbers. // LOCAL_TUNING (non-gameplay: MOD-05 post-match ratings) */
export const RATING = {
  base: 6.0,
  goal: 1.0,
  assist: 0.7,
  shotOnTarget: 0.12,
  shotOffTarget: -0.05,
  passCompleted: 0.03,
  passFailed: -0.04,
  tackleWon: 0.25,
  tackleLost: -0.05,
  interception: 0.2,
  save: 0.4,
  foul: -0.25,
  yellow: -0.5,
  red: -2.0,
  ownGoal: -1.0,
  /** Per goal conceded while on the pitch. */
  concededKeeper: -0.35,
  concededDefender: -0.15,
  /** No goal conceded and on the pitch for at least cleanSheetShare of the team's clock ticks (0..1). */
  cleanSheetKeeper: 0.6,
  cleanSheetDefender: 0.3,
  cleanSheetShare: 0.6,
  win: 0.3,
  loss: -0.3,
  min: 3.0,
  max: 10.0,
} as const;

/** Displayed minute at which each period ends (index = Period). */
const PERIOD_END_MIN: readonly number[] = [0, 45, 90, 105, 120, 120];
/** Displayed minutes of a full half (minutes scale). */
const HALF_DISPLAY_MIN = 45;
/** Ticks per real minute (60 Hz). */
const TICKS_PER_MIN = 3600;

const NP = 2 * SQUAD_SIZE;

export function emptyTeamStats(): TeamMatchStats {
  return {
    goals: 0, shots: 0, shotsOnTarget: 0, possession: 0.5, passes: 0, passesCompleted: 0, tackles: 0, tacklesWon: 0,
    fouls: 0, yellow: 0, red: 0, offsides: 0, corners: 0, saves: 0, interceptions: 0,
  };
}

/** True for kick kinds counted as pass attempts (see DEFINITIONS). */
export function isPassStatKind(k: number): boolean {
  return (k >= KickKind.GROUND_PASS && k <= KickKind.THROUGH_DINKED) || k === KickKind.VOLLEY_PASS;
}

/** Pass completion 0..1 (0 when no passes). */
export function passCompletion(t: Readonly<TeamMatchStats>): number {
  return t.passes > 0 ? t.passesCompleted / t.passes : 0;
}

function isDefenderRole(r: number): boolean {
  return r === Role.RB || r === Role.CB || r === Role.LB || r === Role.RWB || r === Role.LWB;
}

function teamOfSlot(slot: number): number {
  return slot === (slot | 0) && slot >= 0 && slot < NUM_SLOTS ? (slot < PLAYERS_PER_TEAM ? 0 : 1) : -1;
}

/** Per-player counters, indexed team * SQUAD_SIZE + rosterIdx. */
interface PlayerCounters {
  appeared: Uint8Array;
  onTicks: Float64Array;
  goals: Int32Array;
  ownGoals: Int32Array;
  assists: Int32Array;
  shots: Int32Array;
  shotsOn: Int32Array;
  passes: Int32Array;
  passesDone: Int32Array;
  tackles: Int32Array;
  tacklesWon: Int32Array;
  interceptions: Int32Array;
  saves: Int32Array;
  fouls: Int32Array;
  yellow: Int32Array;
  red: Int32Array;
  conceded: Int32Array;
  role: Int32Array;
}

function createCounters(): PlayerCounters {
  return {
    appeared: new Uint8Array(NP), onTicks: new Float64Array(NP), goals: new Int32Array(NP), ownGoals: new Int32Array(NP),
    assists: new Int32Array(NP), shots: new Int32Array(NP), shotsOn: new Int32Array(NP), passes: new Int32Array(NP),
    passesDone: new Int32Array(NP), tackles: new Int32Array(NP), tacklesWon: new Int32Array(NP),
    interceptions: new Int32Array(NP), saves: new Int32Array(NP), fouls: new Int32Array(NP), yellow: new Int32Array(NP),
    red: new Int32Array(NP), conceded: new Int32Array(NP), role: new Int32Array(NP),
  };
}

function clearCounters(c: PlayerCounters): void {
  for (const k of Object.keys(c) as (keyof PlayerCounters)[]) c[k].fill(0);
}

/** Rating for one player's counters (see RATING). Pure. */
export function playerRating(p: {
  goals: number; ownGoals: number; assists: number; shots: number; shotsOn: number; passes: number; passesDone: number;
  tackles: number; tacklesWon: number; interceptions: number; saves: number; fouls: number; yellow: number; red: number;
  conceded: number; keeper: boolean; defender: boolean; cleanSheet: boolean; result: number;
}): number {
  const R = RATING;
  let r: number = R.base;
  r += p.goals * R.goal + p.assists * R.assist;
  r += p.shotsOn * R.shotOnTarget + Math.max(0, p.shots - p.shotsOn) * R.shotOffTarget;
  r += p.passesDone * R.passCompleted + Math.max(0, p.passes - p.passesDone) * R.passFailed;
  r += p.tacklesWon * R.tackleWon + Math.max(0, p.tackles - p.tacklesWon) * R.tackleLost;
  r += p.interceptions * R.interception + p.saves * R.save;
  r += p.fouls * R.foul + p.yellow * R.yellow + p.red * R.red + p.ownGoals * R.ownGoal;
  if (p.keeper) r += p.conceded * R.concededKeeper + (p.cleanSheet ? R.cleanSheetKeeper : 0);
  else if (p.defender) r += p.conceded * R.concededDefender + (p.cleanSheet ? R.cleanSheetDefender : 0);
  if (p.result > 0) r += R.win;
  else if (p.result < 0) r += R.loss;
  if (!(r === r)) r = R.base;
  r = r < R.min ? R.min : r > R.max ? R.max : r;
  return Math.round(r * 10) / 10;
}

/** Index of the player of the match in `players` (highest rating, documented tie-breaks), or -1. Pure. */
export function pickPlayerOfMatch(players: readonly PlayerMatchStats[], winner: number): number {
  let best = -1;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = players[best]!;
    if (p.rating !== b.rating) {
      if (p.rating > b.rating) best = i;
      continue;
    }
    if (p.goals !== b.goals) {
      if (p.goals > b.goals) best = i;
      continue;
    }
    if (p.assists !== b.assists) {
      if (p.assists > b.assists) best = i;
      continue;
    }
    const pw = p.team === winner ? 1 : 0;
    const bw = b.team === winner ? 1 : 0;
    if (pw !== bw) {
      if (pw > bw) best = i;
      continue;
    }
    if (p.team !== b.team) {
      if (p.team < b.team) best = i;
      continue;
    }
    if (p.rosterIdx < b.rosterIdx) best = i;
  }
  return best;
}

export function createStatsTracker(): StatsTracker {
  const teams: [TeamMatchStats, TeamMatchStats] = [emptyTeamStats(), emptyTeamStats()];
  const possTicks = [0, 0];
  /** Team that owned the ball last (sticky possession), -1 before the first owner. */
  let possTeam = -1;
  /** Clock ticks per team (for the clean-sheet share). */
  const clockTicks = [0, 0];
  /** Latest KICK kind per slot (pass completion bookkeeping). */
  const lastKick = new Int32Array(NUM_SLOTS);
  const pc = createCounters();
  const goals: GoalRecord[] = [];
  const clock = { min: 0, sec: 0, added: 0, period: 0 };

  function idxOf(state: ReadonlySimState, slot: number): number {
    const t = teamOfSlot(slot);
    if (t < 0) return -1;
    const p = state.players?.[slot];
    if (!p) return -1;
    const r = p.rosterIdx;
    return r === (r | 0) && r >= 0 && r < SQUAD_SIZE ? t * SQUAD_SIZE + r : -1;
  }

  /** Mark active players as appeared, remember roles and add clock time. */
  function scanPlayers(state: ReadonlySimState, clockTick: boolean): void {
    const players = state.players;
    if (!players) return;
    const n = players.length < NUM_SLOTS ? players.length : NUM_SLOTS;
    for (let slot = 0; slot < n; slot++) {
      const p = players[slot];
      if (!p || p.active !== 1) continue;
      const i = idxOf(state, slot);
      if (i < 0) continue;
      pc.appeared[i] = 1;
      pc.role[i] = p.isKeeper === 1 ? Role.GK : p.role;
      if (clockTick) pc.onTicks[i]! += 1;
    }
  }

  function reset(state: ReadonlySimState | null): void {
    teams[0] = emptyTeamStats();
    teams[1] = emptyTeamStats();
    possTicks[0] = 0;
    possTicks[1] = 0;
    possTeam = -1;
    clockTicks[0] = 0;
    clockTicks[1] = 0;
    lastKick.fill(KickKind.NONE);
    clearCounters(pc);
    goals.length = 0;
    if (state) scanPlayers(state, false);
  }

  function onGoal(state: ReadonlySimState, team: number, scorer: number, assist: number, own: boolean): void {
    const sIdx = idxOf(state, scorer);
    const aIdx = own ? -1 : idxOf(state, assist);
    if (sIdx >= 0) {
      if (own) pc.ownGoals[sIdx]!++;
      else pc.goals[sIdx]!++;
    }
    if (aIdx >= 0 && aIdx !== sIdx) pc.assists[aIdx]!++;
    const conceding = 1 - team;
    const players = state.players;
    const n = players ? (players.length < NUM_SLOTS ? players.length : NUM_SLOTS) : 0;
    for (let slot = 0; slot < n; slot++) {
      const p = players[slot];
      if (!p || p.active !== 1 || teamOfSlot(slot) !== conceding) continue;
      const i = idxOf(state, slot);
      if (i >= 0) pc.conceded[i]!++;
    }
    displayClock(state as unknown as SimState, clock);
    const per = clock.period;
    const cap = PERIOD_END_MIN[per >= Period.FIRST_HALF && per <= Period.SHOOT_OUT ? per : 0] ?? 0;
    let minute = Math.floor(clock.min) + 1;
    if (cap > 0 && minute > cap) minute = cap;
    goals.push({
      team,
      rosterIdx: sIdx >= 0 ? sIdx % SQUAD_SIZE : -1,
      assistRosterIdx: aIdx >= 0 && aIdx !== sIdx ? aIdx % SQUAD_SIZE : -1,
      ownGoal: own,
      minute,
    });
  }

  return {
    reset(state) {
      reset(state);
    },
    onTick(state, events: EventBuffer) {
      const m = state.match;
      if (!m) return;
      if (m.phase === MatchPhase.IN_PLAY && state.ball) {
        const ot = teamOfSlot(state.ball.owner);
        if (ot >= 0) possTeam = ot;
        if (possTeam >= 0) possTicks[possTeam]!++;
      }
      const clockTick = m.clockRunning === 1;
      if (clockTick) {
        clockTicks[0]!++;
        clockTicks[1]!++;
      }
      scanPlayers(state, clockTick);
      // Shoot-out kicks are not match statistics (shots, saves, passes); the tally comes from match.shootout.
      if (m.period === Period.SHOOT_OUT) return;
      for (let i = 0; i < events.count; i++) {
        const e = events.get(i);
        switch (e.type) {
          case EventType.KICK: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            lastKick[e.a] = e.b;
            if (isPassStatKind(e.b)) {
              teams[t]!.passes++;
              const pi = idxOf(state, e.a);
              if (pi >= 0) pc.passes[pi]!++;
            }
            break;
          }
          case EventType.PASS_COMPLETE: {
            const t = teamOfSlot(e.b);
            if (t < 0 || teamOfSlot(e.a) !== t || !isPassStatKind(lastKick[e.b]!)) break;
            lastKick[e.b] = KickKind.NONE;
            teams[t]!.passesCompleted++;
            const pi = idxOf(state, e.b);
            if (pi >= 0) pc.passesDone[pi]!++;
            break;
          }
          case EventType.SHOT: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            const on = e.b === 1;
            teams[t]!.shots++;
            if (on) teams[t]!.shotsOnTarget++;
            const pi = idxOf(state, e.a);
            if (pi >= 0) {
              pc.shots[pi]!++;
              if (on) pc.shotsOn[pi]!++;
            }
            break;
          }
          case EventType.GOAL: {
            const team = e.a === 1 ? 1 : 0;
            onGoal(state, team, e.b, e.c, e.d === 1);
            break;
          }
          case EventType.TACKLE: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            const won = e.c === 1;
            teams[t]!.tackles++;
            if (won) teams[t]!.tacklesWon++;
            const pi = idxOf(state, e.a);
            if (pi >= 0) {
              pc.tackles[pi]!++;
              if (won) pc.tacklesWon[pi]!++;
            }
            break;
          }
          case EventType.FOUL: {
            const t = teamOfSlot(e.a);
            if (t < 0 || e.c === ChallengeOutcome.CLEAN) break;
            teams[t]!.fouls++;
            const pi = idxOf(state, e.a);
            if (pi >= 0) pc.fouls[pi]!++;
            break;
          }
          case EventType.CARD: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            const pi = idxOf(state, e.a);
            const y = e.b === CardKind.YELLOW || e.b === CardKind.SECOND_YELLOW ? 1 : 0;
            const r = e.b === CardKind.RED || e.b === CardKind.SECOND_YELLOW ? 1 : 0;
            teams[t]!.yellow += y;
            teams[t]!.red += r;
            if (pi >= 0) {
              pc.yellow[pi]! += y;
              pc.red[pi]! += r;
            }
            break;
          }
          case EventType.OFFSIDE: {
            const t = teamOfSlot(e.a);
            if (t >= 0) teams[t]!.offsides++;
            break;
          }
          case EventType.RESTART_AWARDED:
            if (e.a === RestartKind.CORNER && (e.b === 0 || e.b === 1)) teams[e.b]!.corners++;
            break;
          case EventType.SAVE: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            teams[t]!.saves++;
            const pi = idxOf(state, e.a);
            if (pi >= 0) pc.saves[pi]!++;
            break;
          }
          case EventType.INTERCEPT: {
            const t = teamOfSlot(e.a);
            if (t < 0) break;
            teams[t]!.interceptions++;
            const pi = idxOf(state, e.a);
            if (pi >= 0) pc.interceptions[pi]!++;
            break;
          }
          case EventType.SUBSTITUTION:
            if (teamOfSlot(e.b) >= 0) lastKick[e.b] = KickKind.NONE;
            break;
          default:
            break;
        }
      }
    },
    summary(state: ReadonlySimState): MatchSummary {
      const out: [TeamMatchStats, TeamMatchStats] = [{ ...teams[0] }, { ...teams[1] }];
      const total = possTicks[0]! + possTicks[1]!;
      out[0].possession = total > 0 ? possTicks[0]! / total : 0.5;
      out[1].possession = 1 - out[0].possession;
      out[0].goals = state.teams?.[0]?.goals ?? teams[0].goals;
      out[1].goals = state.teams?.[1]?.goals ?? teams[1].goals;
      const so = state.match?.shootout;
      const shootout: [number, number] | null = so && (so.active === 1 || so.winner >= 0) ? [so.goals[0]!, so.goals[1]!] : null;
      let winner = state.match?.winner ?? -1;
      if (winner !== 0 && winner !== 1) {
        if (out[0].goals > out[1].goals) winner = 0;
        else if (out[1].goals > out[0].goals) winner = 1;
        else if (shootout && shootout[0] !== shootout[1]) winner = shootout[0] > shootout[1] ? 0 : 1;
        else winner = -1;
      }
      const halfMinutes = state.config?.halfMinutes;
      const halfTicks = Math.max(1, (typeof halfMinutes === 'number' && halfMinutes > 0 ? halfMinutes : 4) * TICKS_PER_MIN);
      const players: PlayerMatchStats[] = [];
      for (let i = 0; i < NP; i++) {
        if (pc.appeared[i] !== 1) continue;
        const team = i < SQUAD_SIZE ? 0 : 1;
        const role = pc.role[i]!;
        const keeper = role === Role.GK;
        const share = clockTicks[team]! > 0 ? pc.onTicks[i]! / clockTicks[team]! : 1;
        const rating = playerRating({
          goals: pc.goals[i]!, ownGoals: pc.ownGoals[i]!, assists: pc.assists[i]!, shots: pc.shots[i]!, shotsOn: pc.shotsOn[i]!,
          passes: pc.passes[i]!, passesDone: pc.passesDone[i]!, tackles: pc.tackles[i]!, tacklesWon: pc.tacklesWon[i]!,
          interceptions: pc.interceptions[i]!, saves: pc.saves[i]!, fouls: pc.fouls[i]!, yellow: pc.yellow[i]!, red: pc.red[i]!,
          conceded: pc.conceded[i]!, keeper, defender: isDefenderRole(role),
          cleanSheet: out[1 - team]!.goals === 0 && pc.conceded[i] === 0 && share >= RATING.cleanSheetShare,
          result: winner === team ? 1 : winner === 1 - team ? -1 : 0,
        });
        players.push({
          team, rosterIdx: i % SQUAD_SIZE, goals: pc.goals[i]!, assists: pc.assists[i]!, shots: pc.shots[i]!,
          passes: pc.passes[i]!, passesCompleted: pc.passesDone[i]!, tackles: pc.tacklesWon[i]!, saves: pc.saves[i]!, rating,
          minutes: Math.round((pc.onTicks[i]! * HALF_DISPLAY_MIN) / halfTicks),
        });
      }
      const pom = pickPlayerOfMatch(players, winner);
      return {
        teams: out,
        players,
        goals: goals.map((g) => ({ ...g })),
        playerOfMatch: pom >= 0 ? { team: players[pom]!.team, rosterIdx: players[pom]!.rosterIdx } : null,
        shootout,
        winner,
        forfeit: state.match?.forfeitTeam ?? -1,
        ticks: state.tick,
      };
    },
  };
}

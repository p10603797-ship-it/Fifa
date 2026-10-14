/**
 * [QF-1, from MOD-04] Practice rules inside the sim (BRIEF §11 Practice). They used to run in the app tick
 * (app/loop stepWithModes, app/session prepareModeState); a replay or a headless run that called the plain sim step
 * then played a different game. Now:
 *  - sim/init initMatch calls preparePracticeState once on the fresh state: FREE_PLAY takes the opponent's outfield
 *    players off the pitch (RUL-10 sendOff: active 0, parked beyond the boards), so your team faces the keeper alone.
 *  - sim/step calls practiceRulesTick once per tick right after rulesTick (before the watchdog): set-piece practice
 *    (FREE_KICKS / CORNERS / PENALTIES) awards the practised restart again after every attempt. In any other restart
 *    phase (a goal kick, throw-in, the kick-off after a goal, a free kick for the defenders) the pending restart is
 *    cancelled through IN_PLAY and the practice restart is awarded instead. In IN_PLAY the attempt ends when the
 *    defending side owns the ball (keeper catch included) or after attemptTicks (penalties: penaltyAttemptTicks) of
 *    live play; IN_PLAY entered from anything but the practice restart (the start) awards at once. FREE_PLAY: a restart
 *    for the lone opposing keeper that he cannot take (throw-in, corner, penalty, free kick outside his area) becomes
 *    his goal kick.
 * Both hooks are no-ops outside practice and idempotent, so the app's older calls (modes/practice) may stay until
 * they are removed. Behaviour and numbers are MOD-04's (modes/practice.ts); the spot geometry is mirrored here
 * because sim/ may not import modes/ (eslint layering). The chosen spot travels as config.practiceSpot (proposed
 * MatchConfig field), read through practiceSpotIndex.
 * Deterministic, allocation-free per tick, slot-index loops.
 */
import {
  HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM,
} from '../../contracts/constants';
import { ControllerKind, MatchPhase, ModeId, PracticeKind, RestartKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { MatchConfig, SimState } from '../../contracts/state';
import { NULL_SINK } from '../core/events';
import { setPhase } from './machine';
import { awardRestart } from './restart';
import { sendOff } from './subs';

/** TUNING-CR (MOD-04, moved by QF-1): practice attempt timing (ticks at 60 Hz). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Live play allowed after a free kick or corner is taken before the attempt is over, ticks (6 s). */
  attemptTicks: 360,
  /** Live play allowed after a penalty kick before the attempt is over, ticks (3 s). */
  penaltyAttemptTicks: 180,
  /** A pending free kick / penalty of the practised kind within this of the practice spot is the practice one, m. */
  spotTolerance: 1,
} as const;

/**
 * Spot geometry per practice kind, as MOD-04's PRACTICE_SPOTS: [dist out from the attacked goal line (m), metres to the
 * attacker's right (+z when attacking +x)] pairs, in the order of the setup's `spot` option.
 */
const SPOT_GEOMETRY: Readonly<Record<number, readonly number[]>> = {
  [PracticeKind.FREE_KICKS]: [22, 0, 21, -9, 21, 9, 30, 4, 14, -26, 14, 26],
  [PracticeKind.CORNERS]: [0, -HALF_WIDTH, 0, HALF_WIDTH],
  [PracticeKind.PENALTIES]: [PENALTY_SPOT_DIST, 0],
};

const RESTART_PHASE: readonly number[] = [
  MatchPhase.IN_PLAY, MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK,
  MatchPhase.PENALTY,
];

const SPOT_OUT = { x: 0, z: 0 };

function isPracticeState(s: SimState): boolean {
  return s.config.mode === ModeId.PRACTICE && s.config.practice !== PracticeKind.NONE;
}

/** Restart kind practised by a practice kind (NONE for free play / tutorial). */
export function practiceRestartKind(kind: PracticeKind): RestartKind {
  if (kind === PracticeKind.FREE_KICKS) return RestartKind.FREE_KICK;
  if (kind === PracticeKind.CORNERS) return RestartKind.CORNER;
  if (kind === PracticeKind.PENALTIES) return RestartKind.PENALTY;
  return RestartKind.NONE;
}

/** Number of spots for a practice kind (0 when it has none). */
export function practiceSpotTotal(kind: PracticeKind): number {
  const g = SPOT_GEOMETRY[kind];
  return g ? g.length >> 1 : 0;
}

/** Spot index carried by a config (proposed MatchConfig.practiceSpot); 0 when absent or out of range. */
export function practiceSpotIndex(config: Readonly<MatchConfig>): number {
  const v = (config as Readonly<MatchConfig> & { practiceSpot?: unknown }).practiceSpot;
  const n = practiceSpotTotal(config.practice);
  return typeof v === 'number' && v === (v | 0) && v >= 0 && v < n ? v : 0;
}

/** Side the human(s) play (home preferred); 0 when nobody does. */
export function practiceTeam(config: Readonly<MatchConfig>): number {
  let side = -1;
  for (let h = 0; h < config.humans.length; h++) {
    const c = config.humans[h]!;
    if (c.kind === ControllerKind.HUMAN && (c.side === 0 || c.side === 1) && (side < 0 || c.side < side)) side = c.side;
  }
  return side < 0 ? 0 : side;
}

/** World position of practice spot `spot` of `kind` for a team attacking `dir` (+1 / -1). Pure; (0, 0) when none. */
export function practiceSpotPoint(kind: PracticeKind, spot: number, dir: number, out: { x: number; z: number }): void {
  const g = SPOT_GEOMETRY[kind];
  const n = g ? g.length >> 1 : 0;
  if (!g || n === 0) { out.x = 0; out.z = 0; return; }
  const i = spot === (spot | 0) && spot >= 0 && spot < n ? spot : 0;
  const d = dir < 0 ? -1 : 1;
  out.x = d * (HALF_LENGTH - g[2 * i]!);
  out.z = d * g[2 * i + 1]!;
}

/**
 * Practice layout on a fresh state (sim/init calls it once, before the first tick). FREE_PLAY: every opponent outfield
 * player leaves the pitch (sendOff). Other kinds: no change. Returns the number of players removed (0 when it has
 * already run).
 */
export function preparePracticeState(s: SimState): number {
  if (!isPracticeState(s) || s.config.practice !== PracticeKind.FREE_PLAY) return 0;
  const opp = 1 - practiceTeam(s.config);
  const first = opp === 0 ? 0 : PLAYERS_PER_TEAM;
  let removed = 0;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    const slot = first + i;
    const p = s.players[slot]!;
    if (p.active !== 1 || p.isKeeper === 1 || s.teams[opp]!.keeperSlot === slot) continue;
    sendOff(s, slot, NULL_SINK);
    if (s.players[slot]!.active !== 1) removed++;
  }
  return removed;
}

function isRestartPhase(p: number): boolean {
  return p === MatchPhase.KICK_OFF || (p >= MatchPhase.THROW_IN && p <= MatchPhase.PENALTY);
}

/** True when the current set-piece attempt (live play after the practice restart) is over. Pure. */
export function practiceAttemptDone(s: SimState, team: number, kind: RestartKind): boolean {
  const m = s.match;
  if (m.phase !== MatchPhase.IN_PLAY) return false;
  if (m.prevPhase !== RESTART_PHASE[kind]) return true;
  const o = s.ball.owner;
  const ot = o >= 0 && o < NUM_SLOTS ? s.players[o]!.team : -1;
  if (ot >= 0 && ot !== team) return true;
  const limit = kind === RestartKind.PENALTY ? LOCAL_TUNING.penaltyAttemptTicks : LOCAL_TUNING.attemptTicks;
  return m.phaseT >= limit;
}

/**
 * [QF-1] The pending restart stands at the practice spot (SPOT_OUT): free kicks and penalties within spotTolerance,
 * corners at the same corner. A foul on the practising side during an attempt gives it a free kick of the practised
 * kind somewhere else, which used to pass for the practice restart.
 */
function atPracticeSpot(kind: RestartKind, x: number, z: number): boolean {
  if (kind === RestartKind.CORNER) return (x < 0) === (SPOT_OUT.x < 0) && (z < 0) === (SPOT_OUT.z < 0);
  const dx = x - SPOT_OUT.x, dz = z - SPOT_OUT.z;
  return dx * dx + dz * dz <= LOCAL_TUNING.spotTolerance * LOCAL_TUNING.spotTolerance;
}

/**
 * [QF-1] FREE_PLAY: the opponents are their keeper alone, and a keeper may not take a throw-in (RUL-02) nor reach a
 * corner, free kick or penalty out of his own area in time: such a restart had no taker, ran into its timeout and the
 * safety-net kick (two RESTART_BLOCKED watchdogs per ball out, 11 in fuzz seed 303 #91). It becomes the keeper's goal
 * kick instead, on the side of the ball. Returns 1 when it replaced the restart this tick.
 */
function freePlayRestart(s: SimState, ev: EventSink): number {
  const m = s.match;
  const r = m.restart;
  if (m.finished === 1 || m.phase === MatchPhase.KICK_OFF || !isRestartPhase(m.phase) || r.taken === 1) return 0;
  const opp = 1 - practiceTeam(s.config);
  if (r.team !== opp || r.kind === RestartKind.GOAL_KICK) return 0;
  const e = -s.teams[opp]!.dir; // the end he defends
  const inOwnBox = e * r.x >= HALF_LENGTH - PENALTY_AREA_DEPTH && r.z >= -PENALTY_AREA_HALF_WIDTH && r.z <= PENALTY_AREA_HALF_WIDTH;
  if (r.kind === RestartKind.FREE_KICK && inOwnBox) return 0; // his own free kick in his area: he takes it
  const z = r.z;
  setPhase(s, MatchPhase.IN_PLAY, ev);
  awardRestart(s, RestartKind.GOAL_KICK, opp, e * (HALF_LENGTH + 1), z, ev);
  return m.phase === MatchPhase.GOAL_KICK ? 1 : 0;
}

/**
 * Per tick after rulesTick: set-piece practice awards the practice restart again when an attempt is over or another
 * restart is pending (see header); free play gives the lone keeper his restarts as goal kicks (freePlayRestart).
 * Returns 1 when it awarded a restart this tick.
 */
export function practiceRulesTick(s: SimState, ev: EventSink): number {
  if (!isPracticeState(s)) return 0;
  if (s.config.practice === PracticeKind.FREE_PLAY) return freePlayRestart(s, ev);
  const kind = practiceRestartKind(s.config.practice);
  if (kind === RestartKind.NONE) return 0;
  const m = s.match;
  if (m.finished === 1 || m.phase === MatchPhase.POST_MATCH) return 0;
  const team = practiceTeam(s.config);
  const r = m.restart;
  practiceSpotPoint(s.config.practice, practiceSpotIndex(s.config), s.teams[team]!.dir, SPOT_OUT);
  if (isRestartPhase(m.phase)) {
    if (r.taken === 1) return 0;
    if (r.kind === kind && r.team === team && atPracticeSpot(kind, r.x, r.z)) return 0;
    setPhase(s, MatchPhase.IN_PLAY, ev);
  } else if (m.phase !== MatchPhase.IN_PLAY || !practiceAttemptDone(s, team, kind)) {
    return 0;
  }
  awardRestart(s, kind, team, SPOT_OUT.x, SPOT_OUT.z, ev);
  return m.phase === RESTART_PHASE[kind] ? 1 : 0;
}

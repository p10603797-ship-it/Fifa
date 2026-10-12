/**
 * [RUL-11] Shared restart helpers and the SET_PIECE action handler (restart taker waiting).
 *
 * This module is a LEAF of the import graph on purpose: it imports only contracts. src/sim/actions/registry.ts reads
 * `setPieceHandler` while it is being evaluated (module init), and registry is reached from restart.ts through
 * sim/actions/dispatch. If the handler lived in restart.ts, entering the graph at restart.ts (or at any module that
 * imports it first, e.g. machine.ts from the HUD) would make registry read the handler before restart.ts had defined
 * it. restart.ts re-exports `setPieceHandler` from here as its first statement, so the handler always exists first.
 *
 * SET_PIECE contract (RUL-01..06, SIM-08..11 starters):
 *  - RUL-11 puts the taker into ActionKind.SET_PIECE (THROW_IN for throw-ins, RUL-02's handler) once the restart is
 *    ready. The handler keeps him LOCKED on his spot facing the aim point (restart.aimX/aimZ when set, otherwise the
 *    kind's default direction) and extends its own budget while he waits, so it never overruns.
 *  - It ends itself (next dispatcher check) as soon as the restart is taken, the phase is no longer a restart phase,
 *    or he is no longer restart.taker.
 *  - Starters need isFree(p) (act NONE): a set-piece input / Default calls restart.ts prepareTakerKick(s, taker)
 *    right before startPass / startLob / startShot. If the start is refused, restartTick puts him back into SET_PIECE.
 */
import { HALF_LENGTH, PENALTY_SPOT_DIST } from '../../contracts/constants';
import { MatchPhase, RestartKind, type WatchdogReason } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import type { ActionHandler } from '../../contracts/systems';
import { MoveMode, type SimState } from '../../contracts/state';

/** TUNING-CR (RUL-11): proposed additions to T_RULES. */
export const COMMON_TUNING = { // TUNING-CR
  /** SET_PIECE wait budget; the handler extends it by this much whenever it is about to expire, ticks. */
  setPieceWaitTicks: 60,
  /** Aim points closer than this to the ball are ignored for the taker's facing, m. */
  aimMinDist: 0.5,
  /** Distance of the default look point ahead of the ball, m. */
  lookAhead: 10,
} as const;

const N_PHASES = MatchPhase.POST_MATCH + 1;

/** MatchPhase of each RestartKind (index = RestartKind; NONE -> -1). */
export const KIND_PHASE: readonly number[] = [
  -1, MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK,
  MatchPhase.PENALTY,
];

/** RestartKind of each MatchPhase (index = MatchPhase; NONE for non-restart phases). */
export const PHASE_KIND: readonly number[] = (() => {
  const out = new Array<number>(N_PHASES).fill(RestartKind.NONE);
  for (let k = RestartKind.KICK_OFF; k <= RestartKind.PENALTY; k++) out[KIND_PHASE[k]!] = k;
  return out;
})();

/** True for KICK_OFF, THROW_IN, GOAL_KICK, CORNER, FREE_KICK, PENALTY (allocation-free). */
export function isRestartPhase(phase: number): boolean {
  return phase >= 0 && phase < N_PHASES && PHASE_KIND[phase] !== RestartKind.NONE;
}

/** True while a restart phase is active and its restart has not been taken yet (never queue a second one). */
export function restartPending(s: SimState): boolean {
  return isRestartPhase(s.match.phase) && s.match.restart.taken === 0;
}

/** True if `slot` is the taker of the current, ready, not yet taken restart. */
export function isRestartTaker(s: SimState, slot: number): boolean {
  const r = s.match.restart;
  return slot >= 0 && slot === r.taker && r.ready === 1 && r.taken === 0 && isRestartPhase(s.match.phase);
}

/**
 * Default kick direction of the current restart (unit vector): kick-off and goal kick toward the attacked end,
 * throw-in into the pitch, corner toward the penalty spot, free kick and penalty toward the attacked goal.
 */
export function restartForward(s: SimState, out: { x: number; z: number }): void {
  const r = s.match.restart;
  const team = r.team === 1 ? 1 : 0;
  const dir = s.teams[team]!.dir;
  let tx: number;
  let tz: number;
  switch (r.kind) {
    case RestartKind.THROW_IN:
      out.x = 0; out.z = r.z >= 0 ? -1 : 1;
      return;
    case RestartKind.CORNER:
      tx = dir * (HALF_LENGTH - PENALTY_SPOT_DIST); tz = 0;
      break;
    case RestartKind.FREE_KICK:
    case RestartKind.PENALTY:
      tx = dir * HALF_LENGTH; tz = 0;
      break;
    default:
      out.x = dir; out.z = 0;
      return;
  }
  const dx = tx - r.x;
  const dz = tz - r.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) { out.x = dir; out.z = 0; return; }
  out.x = dx / d; out.z = dz / d;
}

const FWD = { x: 0, z: 0 };

/** Point the waiting taker looks at: the aim point when set away from the ball, else ahead along restartForward. */
export function restartLookPoint(s: SimState, out: { x: number; z: number }): void {
  const r = s.match.restart;
  const dx = r.aimX - r.x;
  const dz = r.aimZ - r.z;
  const md = COMMON_TUNING.aimMinDist;
  if (dx * dx + dz * dz > md * md) { out.x = r.aimX; out.z = r.aimZ; return; }
  restartForward(s, FWD);
  out.x = r.x + FWD.x * COMMON_TUNING.lookAhead;
  out.z = r.z + FWD.z * COMMON_TUNING.lookAhead;
}

/** Log a watchdog intervention: match.watchdogCount++ and WATCHDOG (a = reason, b = detail, x/y/z = ball). */
export function logWatchdog(s: SimState, ev: EventSink, reason: WatchdogReason, detail: number): void {
  s.match.watchdogCount++;
  const b = s.ball;
  ev.emit(EventType.WATCHDOG, reason, detail, 0, 0, b.x, b.y, b.z);
}

const LOOK = { x: 0, z: 0 };

/** ActionKind.SET_PIECE: the restart taker waits on his spot facing the target until the restart is taken. */
export const setPieceHandler: ActionHandler = {
  update(s, slot) {
    const p = s.players[slot]!;
    const m = s.match;
    const r = m.restart;
    if (p.active !== 1 || !isRestartPhase(m.phase) || r.taken === 1 || r.taker !== slot) {
      p.actDur = p.actT; // the dispatcher ends the action after this update
      return;
    }
    p.moveMode = MoveMode.LOCKED;
    p.ix = 0;
    p.iz = 0;
    p.wantSprint = 0;
    restartLookPoint(s, LOOK);
    p.lookAt = 1;
    p.lookX = LOOK.x;
    p.lookZ = LOOK.z;
    if (p.actT + 1 >= p.actDur) p.actDur = p.actT + COMMON_TUNING.setPieceWaitTicks;
  },
  end(s, slot) {
    const p = s.players[slot]!;
    p.lookAt = 0;
    if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
  },
};

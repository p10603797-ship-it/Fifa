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
 *  - [QF-10] Walked set-ups (free kicks away from goal, shown on the main camera: no cut hides a teleport) put the
 *    taker into SET_PIECE from the award: until the restart is ready and while he is more than approachArrive from his
 *    spot (takerBehind behind the ball along restartForward) the handler runs him there (ARRIVE at approachSpeedFrac of
 *    his top speed, sprinting when that is above a jog); then he waits LOCKED as above.
 *  - [QF-10] "Choose the taker" at a walked free kick (RUL-05 cycleFreeKickTaker) runs the new taker to the spot after
 *    the restart is ready instead of teleporting him: his SET_PIECE carries SET_PIECE_RUN in p.actA, and the handler
 *    runs him as above until he arrives (or swapRunMaxTicks into the action; RUL-11 settleTaker then places him). While
 *    he runs (takerRunning) RUL-05 ignores kick inputs and RUL-11 neither places him nor lets a kick start from afar.
 */
import { HALF_LENGTH, PENALTY_SPOT_DIST } from '../../contracts/constants';
import { ActionKind, MatchPhase, RestartKind, type WatchdogReason } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import type { ActionHandler } from '../../contracts/systems';
import { MoveMode, type SimState } from '../../contracts/state';
import { T_PLAYER } from '../../contracts/tuning';

/** TUNING-CR (RUL-11): proposed additions to T_RULES. */
export const COMMON_TUNING = { // TUNING-CR
  /** SET_PIECE wait budget; the handler extends it by this much whenever it is about to expire, ticks. */
  setPieceWaitTicks: 60,
  /** Aim points closer than this to the ball are ignored for the taker's facing, m. */
  aimMinDist: 0.5,
  /** Distance of the default look point ahead of the ball, m. */
  lookAhead: 10,
  /** The taker stands this far behind the ball (opposite the default kick direction), m (RUL-11 takerBehind). */
  takerBehind: 0.6,
  /** [QF-10] Before a walked set-up is ready the taker runs to his spot at this fraction of his top speed ... */
  approachSpeedFrac: 0.85,
  /** ... and has arrived within this distance of it, m; a straight run passing closer than approachClear to the ball
   *  goes round it (via the point approachClear beside it), m. */
  approachArrive: 0.25,
  approachClear: 0.8,
  /** [QF-10] A waiting taker turns this fraction of the way to his look point per tick (RUL-06 faceGain). */
  faceGain: 0.2,
  /** [QF-10] A taker swapped in at a walked free kick runs to his spot for at most this many ticks (RUL-05 takers
   *  stand within takerWalkMaxDist 18 m: ~3 s at approachSpeedFrac), then RUL-11 places him. */
  swapRunMaxTicks: 240,
} as const;

/** p.actA bit of a SET_PIECE action: the taker runs to his spot although the restart is ready (walked taker swap). */
export const SET_PIECE_RUN = 1;

/** The restart taker `p` is still running to his spot after a walked taker swap (see SET_PIECE_RUN). */
export function takerRunning(p: Readonly<{ act: number; actA: number; actT: number }>): boolean {
  return p.act === ActionKind.SET_PIECE && (p.actA & SET_PIECE_RUN) !== 0 && p.actT < COMMON_TUNING.swapRunMaxTicks;
}

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
    if (p.actT + 1 >= p.actDur) p.actDur = p.actT + COMMON_TUNING.setPieceWaitTicks;
    if ((p.actA & SET_PIECE_RUN) !== 0 && !takerRunning(p)) p.actA = (p.actA & ~SET_PIECE_RUN) >>> 0; // ran too long
    if (r.ready !== 1 || (p.actA & SET_PIECE_RUN) !== 0) {
      // [QF-10] Walked set-up: run to the taker spot behind the ball.
      restartForward(s, FWD);
      let sx = r.x - FWD.x * COMMON_TUNING.takerBehind, sz = r.z - FWD.z * COMMON_TUNING.takerBehind;
      const dx = sx - p.x, dz = sz - p.z;
      const ar = COMMON_TUNING.approachArrive;
      if (dx * dx + dz * dz > ar * ar) {
        // Round the ball, not over it: the run's closest point to the ball inside approachClear -> via the side.
        const d2 = dx * dx + dz * dz;
        const bx = r.x - p.x, bz = r.z - p.z;
        const t = (bx * dx + bz * dz) / d2;
        const c = COMMON_TUNING.approachClear;
        if (t > 0 && t < 1) {
          const cx = p.x + dx * t - r.x, cz = p.z + dz * t - r.z;
          const cd = Math.sqrt(cx * cx + cz * cz);
          if (cd < c) {
            let nx = cx, nz = cz;
            if (cd < 1e-6) { nx = -dz; nz = dx; }
            const nl = Math.sqrt(nx * nx + nz * nz);
            sx = r.x + (nx / nl) * c;
            sz = r.z + (nz / nl) * c;
          }
        }
        const top = s.attrs[slot]!.topSpeed > 0 ? s.attrs[slot]!.topSpeed : T_PLAYER.topSpeedMin;
        const sp = top * COMMON_TUNING.approachSpeedFrac;
        p.moveMode = MoveMode.ARRIVE;
        p.tgtX = sx;
        p.tgtZ = sz;
        p.tgtSpeed = sp;
        p.wantSprint = sp > top * T_PLAYER.jogFraction ? 1 : 0;
        p.lookAt = 0;
        p.ix = 0;
        p.iz = 0;
        return;
      }
      p.actA = (p.actA & ~SET_PIECE_RUN) >>> 0; // arrived
    }
    p.moveMode = MoveMode.LOCKED;
    p.ix = 0;
    p.iz = 0;
    p.wantSprint = 0;
    restartLookPoint(s, LOOK);
    p.lookAt = 1;
    p.lookX = LOOK.x;
    p.lookZ = LOOK.z;
    // [QF-10] SIM-04 does not turn a LOCKED player: a taker who ran in (walked set-up) turns to the look point here
    // (a fraction faceGain of the way per tick; one placed at ready already faces it).
    const dx = LOOK.x - p.x, dz = LOOK.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) {
      const g = COMMON_TUNING.faceGain;
      let tx = dx / d, tz = dz / d;
      // Facing straight away: the blend would not turn him; head for his side first (a quarter turn away).
      if (p.fx * tx + p.fz * tz < -0.95) { tx = -p.fz; tz = p.fx; }
      const fx = p.fx + (tx - p.fx) * g, fz = p.fz + (tz - p.fz) * g;
      const fl = Math.sqrt(fx * fx + fz * fz);
      if (fl > 1e-6) { p.fx = fx / fl; p.fz = fz / fl; }
    }
  },
  end(s, slot) {
    const p = s.players[slot]!;
    p.lookAt = 0;
    if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
  },
};

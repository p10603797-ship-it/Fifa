/**
 * The match state machine's legal transitions (section 5). Lead-owned, frozen after Wave 0.
 * RUL-01 implements the machine with setPhase(); any transition not listed here fails an assertion
 * in test builds and is refused (logged) in the shipped game.
 *
 *   PRE_MATCH -> KICK_OFF | SHOOT_OUT (shoot-out mode) | IN_PLAY (practice free play and test setups: config.startPhase)
 *   KICK_OFF  -> IN_PLAY
 *   IN_PLAY  <-> THROW_IN | GOAL_KICK | CORNER | FREE_KICK | PENALTY
 *   IN_PLAY   -> GOAL -> CELEBRATION -> REPLAY -> KICK_OFF | HALF_TIME | FULL_TIME
 *   IN_PLAY   -> HALF_TIME -> KICK_OFF
 *   IN_PLAY   -> FULL_TIME -> POST_MATCH | EXTRA_TIME | SHOOT_OUT
 *   EXTRA_TIME -> KICK_OFF            (extra-time periods are played as normal periods 3 and 4)
 *   SHOOT_OUT -> POST_MATCH
 *   Restarts (except PENALTY) -> HALF_TIME | FULL_TIME when time expires during the stoppage,
 *   and any restart -> FULL_TIME for a forfeit.
 */

import { MatchPhase as P } from './enums';

export const LEGAL_TRANSITIONS: Readonly<Record<P, readonly P[]>> = {
  [P.PRE_MATCH]: [P.KICK_OFF, P.SHOOT_OUT, P.IN_PLAY],
  [P.KICK_OFF]: [P.IN_PLAY, P.FULL_TIME],
  [P.IN_PLAY]: [P.THROW_IN, P.GOAL_KICK, P.CORNER, P.FREE_KICK, P.PENALTY, P.GOAL, P.HALF_TIME, P.FULL_TIME],
  [P.THROW_IN]: [P.IN_PLAY, P.HALF_TIME, P.FULL_TIME],
  [P.GOAL_KICK]: [P.IN_PLAY, P.HALF_TIME, P.FULL_TIME],
  [P.CORNER]: [P.IN_PLAY, P.HALF_TIME, P.FULL_TIME],
  [P.FREE_KICK]: [P.IN_PLAY, P.HALF_TIME, P.FULL_TIME],
  [P.PENALTY]: [P.IN_PLAY, P.FULL_TIME],
  [P.GOAL]: [P.CELEBRATION],
  [P.CELEBRATION]: [P.REPLAY],
  [P.REPLAY]: [P.KICK_OFF, P.HALF_TIME, P.FULL_TIME],
  [P.HALF_TIME]: [P.KICK_OFF],
  [P.FULL_TIME]: [P.POST_MATCH, P.EXTRA_TIME, P.SHOOT_OUT],
  [P.EXTRA_TIME]: [P.KICK_OFF],
  [P.SHOOT_OUT]: [P.POST_MATCH],
  [P.POST_MATCH]: [],
};

export function isLegalTransition(from: P, to: P): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Phases in which the match clock runs (play and restarts, as in real football). Time spent in restart phases also
 * accumulates added time (T_RULES.addedTimeScale). The clock does not run before a kick-off is taken and stops during
 * cut-scenes (goal, celebration, replay, half/full time).
 */
export const CLOCK_PHASES: readonly P[] = [P.IN_PLAY, P.THROW_IN, P.GOAL_KICK, P.CORNER, P.FREE_KICK, P.PENALTY];

/** Restart phases (a taker is waiting). */
export const RESTART_PHASES: readonly P[] = [P.KICK_OFF, P.THROW_IN, P.GOAL_KICK, P.CORNER, P.FREE_KICK, P.PENALTY];

/** Cut-scene phases (inputs only skip). */
export const CUTSCENE_PHASES: readonly P[] = [P.GOAL, P.CELEBRATION, P.REPLAY, P.HALF_TIME, P.FULL_TIME, P.EXTRA_TIME, P.PRE_MATCH, P.POST_MATCH];

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
 */
import type { MatchPhase } from '../../contracts/enums';
import type { ActionHandler } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function rulesTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Transition to a new phase (validated). Resets phaseT, emits PHASE_CHANGE. */
export function setPhase(s: SimState, to: MatchPhase, ev: EventSink): void { /* stub */ }
/** Set up a kick-off for team (positions both teams in their halves, taker on the spot). */
export function setupKickOff(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Kick-off set-piece input (taker presses PASS). */
export function kickOffInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Displayed clock: minutes, seconds (scaled to 45:00 halves) and added minutes for the period. Pure. */
export function displayClock(s: SimState, out: { min: number; sec: number; added: number; period: number }): void {
  out.min = 0; out.sec = 0; out.added = 0; out.period = s.match.period;
}
export const celebrateHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const dejectedHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};

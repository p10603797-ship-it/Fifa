/**
 * [RUL-11] Watchdog: if a stopped state outlasts its maximum time (T_RULES.phaseMaxTicks), a player stays in an
 * action past its tick budget, or the ball lies unreachable or untouched for 8 s in play, force the nearest legal
 * restart (drop-ball-free: give a free kick / throw-in / goal kick to the sensible team) and log it (WATCHDOG
 * event, match.watchdogCount++). In soak tests any trigger is a failure; in the shipped game it is a safety net.
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function watchdogTick(s: SimState, ev: EventSink): void { /* stub */ }

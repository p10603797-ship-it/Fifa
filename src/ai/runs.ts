/**
 * [TAI-03] Attacking runs: in behind while staying onside (time the run against the offside line), overlaps
 * from full-back when there is cover, late arrivals in the box from midfield; RUN_IN_BEHIND / OVERLAP /
 * LATE_RUN jobs. Trigger-run input (L1 tap / THROUGH swipe down) sends the best runner (triggerRun).
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function assignRuns(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function triggerRun(s: SimState, team: number, ev: EventSink): void { /* stub */ }

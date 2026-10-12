/**
 * [TAI-05] Pressing, cover, marking, tracking runners: press with the nearest man (team.pressSlot), cover with
 * the next (team.coverSlot), track runners, honour team.teamPress and the called second defender
 * (ctrl.secondDef); PRESS / COVER / TRACK_RUNNER jobs. Intensity from style + difficulty (TAI-12).
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function assignPressing(s: SimState, team: number, ev: EventSink): void { /* stub */ }

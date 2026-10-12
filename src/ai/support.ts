/**
 * [TAI-02] Attacking support play and passing angles: offer passing triangles to the ball carrier, stretch the
 * width, show for the ball between lines; SUPPORT jobs for teammates of the carrier. "Call for support" (R1 tap
 * from a human, ctrl seq) brings the nearest midfielder toward the carrier.
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function assignSupport(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Human pressed call-for-support: mark a supporter (stored via job SUPPORT with high urgency for N ticks). */
export function callSupport(s: SimState, team: number, ev: EventSink): void { /* stub */ }

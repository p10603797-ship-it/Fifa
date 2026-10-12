/**
 * [TAI-08] CPU ball-carrier decision engine. On the ball the CPU scores its options every few ticks
 * (T_AI.carrierEvalInterval, brain.evalT): each pass candidate (TAI-09), through ball, cross, dribble into
 * space, skill move, shield, clear, and shoot (TAI-10 xG). Team style weights (TAI-12) and difficulty
 * (reaction, noise, look-ahead, execution error) shape choices. Executes the chosen plan ONLY by writing the
 * CPU InputFrame (stick, buttons held for the power it wants, aim, gestures for explicit targets) — the same
 * frame a human would produce. Never reads human inputs; no stat boosts.
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function cpuCarrier(s: SimState, team: number, out: InputFrame, ev: EventSink): void { /* stub */ }

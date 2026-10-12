/**
 * [RUL-08] Offside (config.offside). Judged at the moment a teammate plays the ball (ball.lastKickTick === tick
 * and the kick is not a goal kick / throw-in / corner, i.e. the phase at that tick is IN_PLAY or FREE_KICK...),
 * against the second-last defender, the ball and the halfway line, with T_RULES.offsideMargin benefit to the
 * attacker. Flags players in s.match.offside.flags; calls it only when a flagged player becomes involved
 * (touches the ball / challenges / receives); restart = indirect-as-direct free kick where he was. Never in his
 * own half. Emits OFFSIDE.
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function offsideTick(s: SimState, ev: EventSink): void { /* stub */ }
/** True if slot is in an offside position right now (ignores involvement). Pure. */
export function isOffsidePosition(s: SimState, slot: number): boolean { return false; }

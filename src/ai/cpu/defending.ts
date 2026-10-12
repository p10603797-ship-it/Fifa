/**
 * [TAI-11] CPU defending: picks which defender to control (via gesture TAP on a teammate or SWITCH), jockeys
 * (SHIELD hold), contains (PASS hold), times tackles after a reaction delay (TAI-12 tackleTimingTicks,
 * brain.tackleCd), calls the second defender (MOD_R hold), rushes the keeper when sensible, occasionally fouls.
 * Writes only the CPU InputFrame.
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function cpuDefend(s: SimState, team: number, out: InputFrame, ev: EventSink): void { /* stub */ }

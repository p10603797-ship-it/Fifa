/**
 * State cloning without per-tick allocation. [FND-03]
 * copyState(dst, src) copies every mutable field (deep, arrays in place); IMMUTABLE_STATE_KEYS are copied
 * by reference. cloneState allocates a fresh deep copy (snapshots, tests, replay keyframes).
 */
import type { SimState } from '../../contracts/state';

export function cloneState(s: SimState): SimState { throw new Error('FND-03'); }
export function copyState(dst: SimState, src: SimState): void { throw new Error('FND-03'); }
/** Deep equality on the mutable part, returns the first differing path or null (debug, desync reports). */
export function diffState(a: SimState, b: SimState): string | null { throw new Error('FND-03'); }

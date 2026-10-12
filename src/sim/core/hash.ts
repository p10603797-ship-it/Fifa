/**
 * Deterministic state hash. [FND-03]
 * Walks the mutable part of SimState (skips IMMUTABLE_STATE_KEYS) in key-insertion order and hashes every
 * number by its float64 bit pattern (FNV-1a 32 or similar). Same seed + inputs => same hash in every engine.
 */
import type { SimState } from '../../contracts/state';
import type { InputFrame } from '../../contracts/input';

export function hashState(s: SimState): number { throw new Error('FND-03'); }
/** Hash any plain data value (objects, arrays, typed arrays, numbers). */
export function hashValue(v: unknown, seed?: number): number { throw new Error('FND-03'); }
export function hashInputFrame(f: InputFrame, seed?: number): number { throw new Error('FND-03'); }
/** Hex string for logs. */
export function hashHex(h: number): string { return (h >>> 0).toString(16).padStart(8, '0'); }

/**
 * [NET-05] Hash exchange every 30 ticks, desync detection and snapshot resync (host sends a full state, guest
 * hard-syncs, both log seed, tick and inputs). WAVE 0 STUB (FND-04): factories throw until NET-05 lands.
 */
import type { SimState } from '../contracts/state';

export const HASH_INTERVAL_TICKS = 30;

export interface DesyncGuard {
  /** After each local tick: record the hash when due; returns the hash to send or -1. */
  afterTick(state: SimState): number;
  /** Remote hash for `tick` arrived; returns true on mismatch. */
  remoteHash(tick: number, hash: number): boolean;
  readonly desyncs: number;
}

export function createDesyncGuard(opts: { isHost: boolean }): DesyncGuard {
  void opts;
  throw new Error('not implemented (NET-05)');
}

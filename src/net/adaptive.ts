/**
 * [NET-04] Adaptive input delay from measured round-trip time (2..8 ticks, start 3), redundancy (last 10 frames in
 * every packet). WAVE 0 STUB (FND-04): factories throw until NET-04 lands.
 */

export const NET_DELAY_MIN = 2;
export const NET_DELAY_MAX = 8;
export const NET_DELAY_START = 3;
export const NET_REDUNDANCY = 10;

export interface AdaptiveDelay {
  /** Current input delay in ticks. */
  readonly delay: number;
  /** Smoothed round-trip time, ms. */
  readonly rttMs: number;
  /** Feed one RTT sample (ms). */
  sample(rttMs: number): void;
  /** Delay to use for the input of `tick` (changes only at agreed ticks). */
  delayFor(tick: number): number;
}

export function createAdaptiveDelay(): AdaptiveDelay {
  throw new Error('not implemented (NET-04)');
}

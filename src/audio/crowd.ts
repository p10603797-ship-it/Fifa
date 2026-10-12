/**
 * [AUD-02] Crowd bed and reactions. WAVE 0 STUB (FND-04): silent.
 * AUD-02: a synthesised crowd bed on ctx.crowd whose intensity follows the match (EventType.ATTACK_BUILD, SHOT,
 * NEAR_MISS, GOAL, lulls); loops must not click; fade out on matchEnd and duck on setPaused(true).
 */
import type { AudioCtx, AudioModule } from './types';

export function createCrowd(ctx: AudioCtx): AudioModule {
  void ctx;
  return {
    dispose() {
      /* nothing allocated yet */
    },
  };
}

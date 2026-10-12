/**
 * [AUD-03] Ball, body and goal-frame sounds. WAVE 0 STUB (FND-04): silent.
 * AUD-03: kicks scaled by power (EventType.KICK c), bounces, post and bar (POST), net (NET), tackles and body
 * contact, saves; all synthesised on ctx.effects. Limit voices so sounds never stack after a pause.
 */
import type { AudioCtx, AudioModule } from './types';

export function createSfx(ctx: AudioCtx): AudioModule {
  void ctx;
  return {
    dispose() {
      /* nothing allocated yet */
    },
  };
}

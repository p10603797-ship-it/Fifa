/**
 * [AUD-04] Whistles and match stings. WAVE 0 STUB (FND-04): silent.
 * AUD-04: EventType.WHISTLE by WhistleKind (short for fouls, start, long for half/full time, final three blasts),
 * kick-off and goal stings, synthesised on ctx.effects.
 */
import type { AudioCtx, AudioModule } from './types';

export function createWhistles(ctx: AudioCtx): AudioModule {
  void ctx;
  return {
    dispose() {
      /* nothing allocated yet */
    },
  };
}

/**
 * [AUD-05] Event-to-sound map. WAVE 0 STUB (FND-04): no mapping yet.
 * AUD-05: a table from EventType (and its a/b/c fields) to sound cues and gains, used by the other modules or as
 * its own module for cross-cutting cues (goal sting + crowd roar ordering, card sounds, substitution chime).
 */
import type { AudioCtx, AudioModule } from './types';

export function createEventMap(ctx: AudioCtx): AudioModule {
  void ctx;
  return {
    dispose() {
      /* nothing allocated yet */
    },
  };
}

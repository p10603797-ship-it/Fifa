/**
 * [GFX-16] Small effects driven by sim events (ARCHITECTURE rule 4): kick puffs, net bulge assist, goal flash,
 * card and whistle cues on the pitch. Pooled, preallocated particles; warmed up during loading so the first use
 * never hitches (section 13 "Warm-up").
 *
 * WAVE 0 STUB (FND-05): no effects.
 */

import type { EventBuffer } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export function createEffects(_ctx: RenderContext): RenderModule {
  return {
    update(_f: RenderFrame) { /* GFX-16 */ },
    onEvents(_events: EventBuffer, _state: ReadonlySimState) { /* GFX-16 */ },
    dispose() { /* nothing owned */ },
  };
}

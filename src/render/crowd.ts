/**
 * [GFX-06] Crowd: a simple instanced crowd in the stands that reacts to events (section 8 "Look": "one stadium
 * with stands, a simple instanced crowd that reacts to events"). Budget: one or two draw calls (instanced or
 * merged), no per-frame allocation; reactions driven by onEvents (GOAL, NEAR_MISS, SAVE, ATTACK_BUILD).
 *
 * WAVE 0 STUB (FND-05): no geometry. GFX-06 implements it.
 */

import type { EventBuffer } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export interface CrowdModule extends RenderModule {
  /** Current excitement 0..1 (smoothed), for diagnostics and audio sync. */
  readonly excitement: number;
}

export function createCrowd(_ctx: RenderContext): CrowdModule {
  return {
    excitement: 0,
    update(_f: RenderFrame) { /* GFX-06 */ },
    onEvents(_events: EventBuffer, _state: ReadonlySimState) { /* GFX-06 */ },
    dispose() { /* nothing owned */ },
  };
}

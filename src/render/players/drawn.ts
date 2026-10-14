/**
 * [QF-4] Where the player model draws each player relative to his sim (interpolated) position: the GFX-07 model adds
 * render-only offsets (INT-C foot lock, up to 0.3 m; QF-4 set-piece stance, 0.42 m) and writes their sum here every
 * frame; modules that draw on or above players (GFX-13 markers: overhead marker, ground ring, power bar) add it so
 * they stay on the drawn body. One Float64Array per renderer context: [dx0, dz0, dx1, dz1, ...] (m), 0 for hidden slots.
 * The model runs before the markers in render/index.ts MODULE ORDER.
 */
import { NUM_SLOTS } from '../../contracts/constants';
import type { RenderContext } from '../types';

const OFFSETS = new WeakMap<RenderContext, Float64Array>();

/** The drawn-offset array of a renderer context (created on first use; never allocates afterwards). */
export function drawnOffsetsOf(ctx: RenderContext): Float64Array {
  let a = OFFSETS.get(ctx);
  if (!a) {
    a = new Float64Array(NUM_SLOTS * 2);
    OFFSETS.set(ctx, a);
  }
  return a;
}

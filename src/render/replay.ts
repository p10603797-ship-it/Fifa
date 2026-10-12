/**
 * [GFX-16] Replay buffer and playback (section 8: "Goal replays: two angles from a ring buffer of the last 8 s of
 * render state. Skippable."). Records the interpolated render state (InterpState + the few discrete facts the
 * model needs) every frame into a preallocated ring buffer; playback substitutes the recorded frames for the live
 * ones while GameRenderer.replaying is true. The sim keeps running its REPLAY phase; skip ends playback.
 * No allocation per frame: the ring is sized for 8 s at 120 Hz up front.
 *
 * WAVE 0 STUB (FND-05): records nothing; start() returns false.
 */

import type { RenderContext, RenderFrame, RenderModule } from './types';

/** Seconds of render history kept for replays. */
export const REPLAY_SECONDS = 8;

export interface ReplayModule extends RenderModule {
  /** True while playing back. */
  readonly playing: boolean;
  /** Start playing back the last `seconds` of render state. False when nothing is recorded. */
  start(seconds: number): boolean;
  stop(): void;
}

export function createReplay(_ctx: RenderContext): ReplayModule {
  return {
    get playing() { return false; },
    start(_seconds: number) { return false; },
    stop() { /* GFX-16 */ },
    update(_f: RenderFrame) { /* GFX-16: record the frame */ },
    clearMatch() { /* GFX-16: reset the ring */ },
    dispose() { /* nothing owned */ },
  };
}

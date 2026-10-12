/**
 * [TCH-07] Touch -> InputFrame mapping (section 9 tables; contracts/touch.ts flow). Once per tick the mapper reads
 * the TouchIntentState written by the controls and fills one InputFrame:
 *  - stick (screen x right, y down) -> mx / mz via quantAxis, rotated by CameraProjector.stickRotation()
 *    (broadcast camera: screen x -> +x, screen y -> +z);
 *  - SPRINT & SKILL held -> Btn.SPRINT (tap = skill move, swipes = skill / knock-on / hard stop: TCH-07);
 *  - PASS / THROUGH / SHOOT -> their positional bits, held while the finger is down; a press that starts and ends
 *    between two ticks is still reported for one tick (DOWN events are latched from the queue). A DOWN that is
 *    followed by a CANCEL of the same button in the same queue drain (an iPadOS system gesture that starts on the
 *    button, blur, pause) is dropped: TouchEdge.CANCEL means "release without action" (latchedDownBits);
 *  - swipes / double taps -> modifier bits, skill and power fields per the section 9 rows (TCH-07);
 *  - gestures -> InputFrame gesture fields via CameraProjector.screenToPitch (TCH-05/07);
 *  - cluster mode (attack / defence / keeper / set piece) chosen from sim context each tick (TCH-04 helper).
 * The event queues are drained every sample.
 *
 * WAVE 0 BASELINE (FND-05): stick, sprint hold, PASS / THROUGH / SHOOT hold + latched taps. TCH-07 owns and
 * completes the tables.
 */

import { Btn, clearInputFrame, type InputFrame, type InputSampleContext } from '../../contracts/input';
import { TouchButtonId, TouchEdge, type TouchButtonEvent, type TouchIntentState } from '../../contracts/touch';
import { writeMoveAxes } from '../axes';
import { chooseClusterMode } from './cluster';

/** InputFrame bit for each touch button in the attack cluster (0 = no direct bit). Indexed by TouchButtonId. */
export const TOUCH_HOLD_BITS: readonly number[] = [
  /* PASS */ Btn.PASS,
  /* THROUGH */ Btn.THROUGH,
  /* SHOOT */ Btn.SHOOT,
  /* SPRINT_SKILL */ Btn.SPRINT,
  /* SPRINT_TACKLE */ Btn.SPRINT,
  /* SLIDE */ Btn.LOB,
  /* SWITCH */ Btn.MOD_L,
  /* SECOND_DEF */ Btn.MOD_R,
  /* PAUSE */ 0,
];

/** Buttons whose touch-down is latched so a sub-tick tap still reaches the sim. */
const LATCH_MASK = (1 << TouchButtonId.PASS) | (1 << TouchButtonId.THROUGH) | (1 << TouchButtonId.SHOOT)
  | (1 << TouchButtonId.SLIDE) | (1 << TouchButtonId.SWITCH) | (1 << TouchButtonId.SECOND_DEF);

/** Btn bits for a held-button mask (bit = TouchButtonId). Pure. */
export function heldToButtons(held: number): number {
  let bits = 0;
  for (let i = 0; i < TOUCH_HOLD_BITS.length; i++) if (held & (1 << i)) bits |= TOUCH_HOLD_BITS[i]!;
  return bits;
}

/**
 * Latched presses in a button event queue, as a mask over TouchButtonId (only LATCH_MASK buttons). Walks the queue
 * in order: a DOWN arms its button, an UP commits the armed press (a real tap shorter than a tick), a CANCEL
 * disarms it (release without action). A press still armed at the end of the queue is committed (the finger is
 * down; its held bit covers later ticks). Pure; no allocation.
 */
export function latchedDownMask(events: readonly TouchButtonEvent[], count: number): number {
  let armed = 0;
  let latched = 0;
  for (let i = 0; i < count; i++) {
    const e = events[i]!;
    const bit = 1 << e.button;
    if ((LATCH_MASK & bit) === 0) continue;
    if (e.edge === TouchEdge.DOWN) armed |= bit;
    else if (e.edge === TouchEdge.UP) { latched |= armed & bit; armed &= ~bit; }
    else if (e.edge === TouchEdge.CANCEL) armed &= ~bit;
  }
  return latched | armed;
}

export interface TouchMapper {
  /** Fill `out` for the coming tick from the intent state; drains the event queues. No allocation. */
  sample(out: InputFrame, ctx: InputSampleContext): void;
}

export function createTouchMapper(state: TouchIntentState): TouchMapper {
  return {
    sample(out, ctx) {
      clearInputFrame(out);
      state.mode = chooseClusterMode(ctx.state, ctx.side);
      if (state.stickActive) writeMoveAxes(out, state.stickX, state.stickY, ctx.projector);
      const bits = heldToButtons(state.held | latchedDownMask(state.buttonEvents, state.buttonEventCount));
      state.buttonEventCount = 0;
      state.gestureEventCount = 0;
      out.buttons = bits;
    },
  };
}

/**
 * [TCH-06] Set-piece touch controls and flight preview (section 9 "Set pieces on touch"):
 *  - Kick-off: PASS. Throw-ins and goal kicks: tap a teammate or use the buttons.
 *  - Corners and wide free kicks: tap a teammate / a spot in the box, or swipe from the ball (speed = height,
 *    curve = curl); PASS plays it short.
 *  - Free kicks at goal: swipe from the ball toward goal (speed = power and height, curve = curl) with a dotted
 *    preview of the first part of the flight (TouchIntentState.previewX/Y/Count, drawn by TCH-09).
 *  - Penalties: swipe toward the part of the goal you want; to save, tap or swipe the dive direction.
 * Active only while ClusterMode.SET_PIECE (the mapper sets the mode from the restart phase).
 *
 * WAVE 0 STUB (FND-05): claims no pointers. TCH-06 implements it.
 */

import type { TouchControl, TouchIntentState } from '../../contracts/touch';

export interface SetPieceSwipeOptions {
  state: TouchIntentState;
  /** Screen position of the ball (CSS px); false when off screen. */
  ballScreen?(out: { x: number; y: number }): boolean;
}

export function createSetPieceSwipe(_opts: SetPieceSwipeOptions): TouchControl {
  return {
    hit: () => false,
    down() { /* TCH-06 */ },
    move() { /* TCH-06 */ },
    up() { /* TCH-06 */ },
    cancel() { /* TCH-06 */ },
    releaseAll() { /* TCH-06 */ },
  };
}

/**
 * [TCH-05] Pitch gestures (section 9 "Pitch gestures"): tap, double-tap, swipe, curved swipe, back-and-forth swipe
 * on the pitch, recognised only when they start outside the stick zone and the button cluster (the pointer manager
 * routes those to their own controls first). Thresholds: T_TOUCHUI.tapMaxPt / tapMaxMs / doubleTapMs. Results go
 * into TouchIntentState.gestureEvents (pushGestureEvent) in screen space; the mapper (TCH-07) projects them onto
 * the pitch with CameraProjector.screenToPitch and fills the InputFrame gesture fields. Each gesture can be turned
 * off (settings.controls.touch.gestureEnabled) and all of them with settings.controls.touch.gestures.
 *
 * WAVE 0 STUB (FND-05): claims no pointers. TCH-05 implements recognition.
 */

import type { TouchControl, TouchIntentState } from '../../contracts/touch';

export interface PitchGestureOptions {
  state: TouchIntentState;
  /** True where a gesture may start (right half outside the cluster, or anywhere outside the stick zone). */
  zone(x: number, y: number): boolean;
  /** Screen position of the ball (CSS px) for "fromBall" detection; false when off screen. */
  ballScreen?(out: { x: number; y: number }): boolean;
  /** Gestures enabled (settings). */
  enabled?(): boolean;
}

export function createPitchGestures(_opts: PitchGestureOptions): TouchControl {
  return {
    hit: () => false,
    down() { /* TCH-05 */ },
    move() { /* TCH-05 */ },
    up() { /* TCH-05 */ },
    cancel() { /* TCH-05 */ },
    releaseAll() { /* TCH-05 */ },
  };
}

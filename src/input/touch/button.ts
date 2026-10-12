/**
 * [TCH-03] Generic touch button (section 9 "Touch quality bar"): responds on touch-down within one frame
 * (state.held bit + a DOWN event, the overlay shows the pressed state synchronously); a short press released
 * without travel is a TAP; travel of T_TOUCHUI.buttonSwipePt (24 pt) from the button is a SWIPE with a direction
 * (the finger may stay down); a second tap inside T_TOUCHUI.doubleTapMs is a DOUBLE_TAP; a thumb that slides off a
 * held button keeps the hold until it lifts (pointer capture); cancel releases without an action.
 * Events go into the TouchIntentState queue; the mapper (TCH-07) turns them into InputFrame bits.
 *
 * WAVE 0 BASELINE (FND-05): DOWN / UP / TAP / DOUBLE_TAP / SWIPE / CANCEL. TCH-03 adds HOLD and hint timing.
 */

import {
  pushButtonEvent, SwipeDir, TouchEdge, type TouchButtonId, type TouchControl, type TouchIntentState,
} from '../../contracts/touch';
import { T_INPUT, T_TOUCHUI } from '../../contracts/tuning';

/** Button circle in CSS px. */
export interface ButtonGeom {
  cx: number;
  cy: number;
  r: number;
}

/** Extra hit radius around a button (CSS px) so near-misses still count. */
export const BUTTON_SLOP = 8;
/** Max press duration that still counts as a tap (ms). */
export const TAP_MS = (T_INPUT.tapTicks * 1000) / 60;

/** Swipe direction for a travel vector (screen space), or NONE below the threshold. Pure. */
export function swipeDir(dx: number, dy: number, threshold: number): SwipeDir {
  if (dx * dx + dy * dy < threshold * threshold) return SwipeDir.NONE;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? SwipeDir.RIGHT : SwipeDir.LEFT;
  return dy > 0 ? SwipeDir.DOWN : SwipeDir.UP;
}

export interface TouchButtonOptions {
  state: TouchIntentState;
  id: TouchButtonId;
  geom: ButtonGeom;
  /** Hidden buttons claim nothing (gestures-only setting, cluster swaps). */
  enabled?(): boolean;
}

export interface TouchButtonControl extends TouchControl {
  readonly id: TouchButtonId;
  /** Pointer id holding the button, -1 when up. */
  readonly pointerId: number;
  /** Geometry (mutable: relayout writes it). */
  readonly geom: ButtonGeom;
}

export function createTouchButton(opts: TouchButtonOptions): TouchButtonControl {
  const st = opts.state;
  const bit = 1 << opts.id;
  const g = opts.geom;
  let pid = -1;
  let downT = 0;
  let sx = 0, sy = 0;
  let swiped = false;
  let lastTapT = -1e9;
  let mode = st.mode;

  function clear(): void {
    pid = -1;
    st.held &= ~bit;
    st.downAt[opts.id] = 0;
  }

  return {
    id: opts.id,
    get pointerId() { return pid; },
    geom: g,
    hit(x, y) {
      if (opts.enabled && !opts.enabled()) return false;
      const dx = x - g.cx, dy = y - g.cy, rr = g.r + BUTTON_SLOP;
      return dx * dx + dy * dy <= rr * rr;
    },
    down(id, x, y, t) {
      if (pid !== -1) return;
      pid = id;
      downT = t;
      sx = x; sy = y;
      swiped = false;
      mode = st.mode; // a thumb keeps the meaning it had when it went down
      st.held |= bit;
      st.downAt[opts.id] = t;
      pushButtonEvent(st, opts.id, TouchEdge.DOWN, SwipeDir.NONE, t, mode);
    },
    move(id, x, y, t) {
      if (id !== pid || swiped) return;
      const d = swipeDir(x - sx, y - sy, T_TOUCHUI.buttonSwipePt);
      if (d !== SwipeDir.NONE) {
        swiped = true;
        pushButtonEvent(st, opts.id, TouchEdge.SWIPE, d, t, mode);
      }
    },
    up(id, _x, _y, t) {
      if (id !== pid) return;
      clear();
      pushButtonEvent(st, opts.id, TouchEdge.UP, SwipeDir.NONE, t, mode);
      if (!swiped && t - downT <= TAP_MS) {
        const dbl = t - lastTapT <= T_TOUCHUI.doubleTapMs;
        pushButtonEvent(st, opts.id, dbl ? TouchEdge.DOUBLE_TAP : TouchEdge.TAP, SwipeDir.NONE, t, mode);
        lastTapT = dbl ? -1e9 : t;
      }
    },
    cancel(id, t) {
      if (id !== pid) return;
      clear();
      pushButtonEvent(st, opts.id, TouchEdge.CANCEL, SwipeDir.NONE, t, mode);
    },
    releaseAll(t) {
      if (pid === -1) return;
      clear();
      pushButtonEvent(st, opts.id, TouchEdge.CANCEL, SwipeDir.NONE, t, mode);
    },
  };
}

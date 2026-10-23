/**
 * [TCH-03] Generic touch button (section 9 "Touch quality bar"), a TouchControl that turns one finger on a button into
 * TouchButtonEvents in the TouchIntentState queue (the mapper, TCH-07, turns them into InputFrame bits):
 *  - DOWN at once on touch-down: the held bit and downAt are set synchronously, so the overlay shows the pressed
 *    state within the same frame.
 *  - SWIPE with a SwipeDir once the finger is T_TOUCHUI.buttonSwipePt (24 pt) away from where it was at some
 *    moment of the last LOCAL_TUNING.swipeWindowMs (the touch-down point while the press is younger than that; a
 *    still finger sends no moves, so its last position before the window counts too). Direction = dominant axis of
 *    that travel. One swipe per press, possibly after a HOLD; the finger may stay down and the hold continues
 *    (power). A held thumb that slowly drifts (rolls, slides off the button) is not a swipe: sprinting never turns
 *    into a skill move by accident. The lift position counts as a last move.
 *  - HOLD once the press outlives the tap time (TAP_MS = T_INPUT.tapTicks at 60 Hz) without a swipe. Emitted by
 *    update(t) (call it every animation frame), by the next move, or at the latest just before UP.
 *  - UP when the finger lifts, followed by TAP when the press was shorter than TAP_MS and never swiped (any travel
 *    below the swipe threshold still counts as a tap, so a sloppy tap never does nothing), or by DOUBLE_TAP instead
 *    of TAP when the button has a double tap (option doubleTap) and the previous press of the same button, with the
 *    same meaning (id and mode), was a tap that lifted at most T_TOUCHUI.doubleTapMs before this touch-down. A
 *    double tap closes the window (a third tap is a TAP again).
 *  - CANCEL (pointercancel, lost capture, blur, pause; releaseAll): release without an action. Cancels forget a
 *    pending first tap.
 *  - A thumb that slides off a held button keeps the hold until it lifts (the pointer manager keeps routing it here).
 *    Further fingers that land on a held button are claimed and ignored (they never become pitch gestures).
 *  - Every event of a press carries the TouchButtonId and the ClusterMode it had at touch-down (a thumb keeps its
 *    meaning until it lifts, even when the cluster swaps or setId() retargets the button meanwhile).
 *  - Direction hints: when the hold reaches T_TOUCHUI.hintHoldMs (250 ms) without a swipe and opts.hint(id, mode)
 *    says so, `hint` turns on until the swipe, lift or cancel (the overlay draws the arrows; attack.ts gates it on
 *    TouchSettings.hintMatchesLeft).
 * No allocation per pointer event or per update: all scratch lives in the closure.
 */

import {
  ClusterMode, pushButtonEvent, SwipeDir, TouchEdge, type TouchButtonId, type TouchControl, type TouchIntentState,
} from '../../contracts/touch';
import { T_INPUT, T_TOUCH_BUTTON, T_TOUCHUI } from '../../contracts/tuning';

/** Button recogniser constants: contracts/tuning.ts T_TOUCH_BUTTON ([TUN-2]; the old name is kept for importers). */
export const LOCAL_TUNING = T_TOUCH_BUTTON;

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

/** Swipe direction for a travel vector (screen space, y down), or NONE below the threshold. Ties go horizontal. Pure. */
export function swipeDir(dx: number, dy: number, threshold: number): SwipeDir {
  if (!(dx * dx + dy * dy >= threshold * threshold)) return SwipeDir.NONE; // also NaN
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? SwipeDir.RIGHT : SwipeDir.LEFT;
  return dy > 0 ? SwipeDir.DOWN : SwipeDir.UP;
}

/**
 * Edge kind of a lift that never swiped: TAP / DOUBLE_TAP for a short press, -1 for a hold. `prevTapUpMs` is when the
 * previous tap of the same meaning lifted (-Infinity when none). Pure (the recogniser's tap rule).
 */
export function classifyRelease(downMs: number, upMs: number, prevTapUpMs: number, doubleTap: boolean): TouchEdge.TAP | TouchEdge.DOUBLE_TAP | -1 {
  if (!(upMs - downMs <= TAP_MS)) return -1;
  if (doubleTap && downMs - prevTapUpMs <= T_TOUCHUI.doubleTapMs) return TouchEdge.DOUBLE_TAP;
  return TouchEdge.TAP;
}

export interface TouchButtonOptions {
  state: TouchIntentState;
  id: TouchButtonId;
  geom: ButtonGeom;
  /** Hidden buttons claim nothing (gestures-only setting, cluster swaps). */
  enabled?(): boolean;
  /**
   * Extra hit predicate after the circle test (attack.ts: the nearest of the cluster's live buttons wins inside
   * overlapping slop). Default: claim.
   */
  claim?(x: number, y: number): boolean;
  /** Whether a second quick tap of this meaning is a DOUBLE_TAP (else every tap is a TAP). Default: yes. */
  doubleTap?(id: TouchButtonId, mode: ClusterMode): boolean;
  /** Whether a 250 ms hold of this meaning shows direction hints. Default: no. */
  hint?(id: TouchButtonId, mode: ClusterMode): boolean;
}

export interface TouchButtonControl extends TouchControl {
  /** Current identity (setId may change it; a press keeps the id it had at touch-down, see pressId). */
  readonly id: TouchButtonId;
  /** Pointer id holding the button, -1 when up. */
  readonly pointerId: number;
  /** Geometry (mutable: relayout writes it). */
  readonly geom: ButtonGeom;
  /** Id and cluster mode of the current press (as at touch-down); pressId -1 when up. */
  readonly pressId: TouchButtonId | -1;
  readonly pressMode: ClusterMode;
  /** Swipe of the current press (NONE until recognised or when up). */
  readonly swipe: SwipeDir;
  /** The current press has become a HOLD. */
  readonly holding: boolean;
  /** Direction hints are showing for the current press. */
  readonly hint: boolean;
  /** Advance the hold and hint timers (call once per animation frame and before each sample). No allocation. */
  update(tMs: number): void;
  /** Retarget the button (cluster identity swap). A press already down keeps its old id until it lifts. */
  setId(id: TouchButtonId): void;
}

const NEVER = -Infinity;
/** Minimum time between stored path samples, ms (the buffer then spans more than the swipe window). */
const MIN_GAP = LOCAL_TUNING.swipeWindowMs / (LOCAL_TUNING.pathSamples - 4);

export function createTouchButton(opts: TouchButtonOptions): TouchButtonControl {
  const st = opts.state;
  const g = opts.geom;
  const N = LOCAL_TUNING.pathSamples;
  // Recent finger path of the current press (ring buffer).
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pt = new Float64Array(N);
  let head = 0; // next write index
  let count = 0;

  let id: TouchButtonId = opts.id;
  let pid = -1;
  let pressId: TouchButtonId | -1 = -1;
  let mode: ClusterMode = st.mode;
  let downT = 0;
  let swiped: SwipeDir = SwipeDir.NONE;
  let holding = false;
  let hint = false;
  let hintChecked = false;
  // Double-tap memory: the last tap's lift time and meaning.
  let lastTapT = NEVER;
  let lastTapId: TouchButtonId | -1 = -1;
  let lastTapMode: ClusterMode = ClusterMode.ATTACK;

  function forgetTap(): void {
    lastTapT = NEVER;
    lastTapId = -1;
  }

  function clear(): void {
    if (pressId !== -1) {
      st.held &= ~(1 << pressId);
      st.downAt[pressId] = 0;
    }
    pid = -1;
    pressId = -1;
    hint = false;
    count = 0;
  }

  function push(x: number, y: number, t: number): void {
    // Keep samples at least MIN_GAP apart so the buffer always spans the whole swipe window, however fast the
    // pointer events come (coalesced 120 Hz moves, pens).
    if (count > 0 && t - pt[(head - 1 + N) % N]! < MIN_GAP) return;
    px[head] = x; py[head] = y; pt[head] = t;
    head = (head + 1) % N;
    if (count < N) count++;
  }

  /**
   * Swipe from the oldest recent sample at least the threshold away from (x, y), or NONE. Recent = inside the swipe
   * window, plus the newest sample before it: a still finger sends no moves, so that is where the finger was when
   * the window opened (a hold followed by a flick, or a main-thread stall between two events, still measures from it).
   */
  function detectSwipe(x: number, y: number, t: number): SwipeDir {
    const from = t - LOCAL_TUNING.swipeWindowMs;
    let k = count; // k = 1 is the newest sample, k = count the oldest
    while (k > 1 && pt[(head - k + 1 + N) % N]! < from) k--;
    for (; k >= 1; k--) {
      const i = (head - k + N) % N;
      const d = swipeDir(x - px[i]!, y - py[i]!, T_TOUCHUI.buttonSwipePt);
      if (d !== SwipeDir.NONE) return d;
    }
    return SwipeDir.NONE;
  }

  /** Hold and hint timers of the current press. */
  function timers(t: number): void {
    if (pressId === -1 || swiped !== SwipeDir.NONE) return;
    const age = t - downT;
    if (!holding && age > TAP_MS) {
      holding = true;
      pushButtonEvent(st, pressId, TouchEdge.HOLD, SwipeDir.NONE, t, mode);
    }
    if (!hintChecked && age >= T_TOUCHUI.hintHoldMs) {
      hintChecked = true;
      hint = !!opts.hint && opts.hint(pressId, mode);
    }
  }

  /** Track the finger; recognise the press's one swipe. */
  function track(x: number, y: number, t: number): void {
    if (pressId === -1 || swiped !== SwipeDir.NONE) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const d = detectSwipe(x, y, t);
    if (d !== SwipeDir.NONE) {
      swiped = d;
      hint = false;
      hintChecked = true;
      pushButtonEvent(st, pressId, TouchEdge.SWIPE, d, t, mode);
    }
    push(x, y, t);
  }

  function cancelPress(t: number): void {
    const b = pressId;
    clear();
    forgetTap();
    if (b !== -1) pushButtonEvent(st, b, TouchEdge.CANCEL, SwipeDir.NONE, t, mode);
  }

  return {
    get id() { return id; },
    get pointerId() { return pid; },
    geom: g,
    get pressId() { return pressId; },
    get pressMode() { return mode; },
    get swipe() { return swiped; },
    get holding() { return holding; },
    get hint() { return hint; },
    hit(x, y) {
      if (opts.enabled && !opts.enabled()) return false;
      const dx = x - g.cx, dy = y - g.cy, rr = g.r + BUTTON_SLOP;
      if (!(dx * dx + dy * dy <= rr * rr)) return false;
      return !opts.claim || opts.claim(x, y);
    },
    down(pointer, x, y, t) {
      if (pid !== -1) return; // a second finger on a held button is swallowed
      pid = pointer;
      pressId = id;
      mode = st.mode; // a thumb keeps the meaning it had when it went down
      downT = t;
      swiped = SwipeDir.NONE;
      holding = false;
      hint = false;
      hintChecked = false;
      count = 0;
      push(x, y, t);
      st.held |= 1 << pressId;
      st.downAt[pressId] = t;
      pushButtonEvent(st, pressId, TouchEdge.DOWN, SwipeDir.NONE, t, mode);
    },
    move(pointer, x, y, t) {
      if (pointer !== pid) return;
      timers(t);
      track(x, y, t);
    },
    up(pointer, x, y, t) {
      if (pointer !== pid) return;
      timers(t);
      track(x, y, t);
      const b = pressId as TouchButtonId;
      const m = mode;
      const wasSwipe = swiped !== SwipeDir.NONE;
      const prevTap = lastTapId === b && lastTapMode === m ? lastTapT : NEVER;
      const kind = wasSwipe ? -1 : classifyRelease(downT, t, prevTap, !opts.doubleTap || opts.doubleTap(b, m));
      clear();
      pushButtonEvent(st, b, TouchEdge.UP, SwipeDir.NONE, t, m);
      if (kind === -1) {
        forgetTap();
        return;
      }
      pushButtonEvent(st, b, kind, SwipeDir.NONE, t, m);
      if (kind === TouchEdge.DOUBLE_TAP) {
        forgetTap();
      } else {
        lastTapT = t;
        lastTapId = b;
        lastTapMode = m;
      }
    },
    cancel(pointer, t) {
      if (pointer !== pid) return;
      cancelPress(t);
    },
    releaseAll(t) {
      if (pid === -1) {
        forgetTap();
        return;
      }
      cancelPress(t);
    },
    update(t) {
      timers(t);
    },
    setId(next) {
      id = next;
    },
  };
}

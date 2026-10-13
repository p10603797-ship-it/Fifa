/**
 * [TCH-05] Pitch gestures (section 9 "Pitch gestures"): tap, double-tap, swipe, curved swipe, back-and-forth swipe
 * on the pitch, recognised only when they start outside the stick zone and the button cluster (the pointer manager
 * routes those to their own controls first). Results go into TouchIntentState.gestureEvents (queueGesture: the
 * pushGestureEvent queue, written field by field so nothing is boxed) in screen space (CSS px, y down); the mapper
 * (TCH-07) projects them onto the pitch with CameraProjector.screenToPitch and fills the InputFrame gesture fields,
 * and the sim (SIM-15) resolves what they mean (pass, through ball, shot, press, switch...). This module produces
 * clean geometric gestures only.
 *
 * Recognition (pure core: classifyPath; thresholds T_TOUCHUI.tapMaxPt / tapMaxMs / doubleTapMs + LOCAL_TUNING):
 *  - Every pitch pointer keeps its path (x, y, t) in a fixed per-pointer sample buffer (LOCAL_TUNING.pathSamples).
 *    When it fills up, the older samples are thinned in place (every other one; the touch-down point and the newest
 *    sample stay), so the start of a long path is never lost and nothing is allocated.
 *  - TAP: lifted within tapMaxMs, never further than tapMaxPt from the touch-down point. A longer still press is
 *    nothing. (sx, sy) = touch-down point, (ex, ey) = lift point.
 *  - DOUBLE_TAP: a tap followed by a second tap whose touch-down lands within doubleTapMs of the first touch-down
 *    (down to down, like the stick's double tap) and within LOCAL_TUNING.doubleTapSlopPt of it. Because the sim acts
 *    on a TAP at once, a single tap is held back until its double-tap window closes (emitted by update(t), by the
 *    next pointer event or by a timer) and a double tap emits ONLY the DOUBLE_TAP. (sx, sy) = first tap's touch-down
 *    (the target), (ex, ey) = second tap's lift. When no double-tap rule is enabled, or during cut-scenes
 *    (ClusterMode.HIDDEN: any tap skips), taps are emitted at lift without waiting. If the second touch turns into a
 *    swipe or a hold, the first tap is emitted as a TAP right then and the second touch is classified on its own;
 *    a cancelled second touch cancels the double tap (nothing is emitted).
 *  - Swipes: travel above tapMaxPt, finished within LOCAL_TUNING.swipeMaxMs, mean speed along the path at least
 *    LOCAL_TUNING.swipeMinSpeed, and the finger not resting more than LOCAL_TUNING.swipeRestMaxMs before it lifts.
 *    Anything else (slow drags, drag-and-hold, short wiggles below LOCAL_TUNING.swipeMinPt) is ignored.
 *     - BACK_FORTH_SWIPE: the path reverses at least once (each stroke >= LOCAL_TUNING.reverseMinPt, the return
 *       stroke at least 120 degrees from the one before). (sx, sy) -> (ex, ey) is the main (longest, later on ties)
 *       stroke, so its direction is "toward goal" whether the player pulls back first or flicks first; vx / vy is
 *       the velocity at the end of that stroke; curve = 0.
 *     - otherwise SWIPE or CURVED_SWIPE from touch-down to lift. Signed curvature = signed area between the path and
 *       its chord (shoelace over every sample) / chord^2, scaled by LOCAL_TUNING.curveFullRatio and clamped to
 *       -1..1; positive = bends clockwise on screen. |curve| >= LOCAL_TUNING.curvedMin makes it a CURVED_SWIPE.
 *     - vx / vy (px/ms): end velocity over the last LOCAL_TUNING.velWindowMs of movement (a finger that stops just
 *       before it lifts does not dilute it: the trailing still samples are skipped).
 *  - fromBall: the touch-down was within LOCAL_TUNING.fromBallPt of opts.ballScreen().
 *  - tMs: the lift time of the gesture's last finger.
 * Settings: everything is off when opts.enabled() is false or TouchSettings.gestures is false; each section 9 rule
 * can be turned off in TouchSettings.gestureEnabled (keys = GestureRule values, missing = on). A gesture kind is
 * recognised while any rule that uses it is on (gestureKindFor): a curved swipe with the finesse rule off is reported
 * as a plain SWIPE, a back-and-forth swipe with the power-shot rule off as a SWIPE along its main stroke. Rules that
 * share a kind (tap a teammate / tap the goal / tap the carrier...) can only be told apart with match context, so
 * the mapper drops those with isGestureRuleOn (TCH-07).
 * Lifecycle: up to LOCAL_TUNING.pointers pitch pointers at once, each independent. cancel (pointercancel, lost
 * capture) drops that pointer without an action; releaseAll (blur, visibilitychange, pause) drops every pointer and
 * any pending tap. Touch-downs inside the system-gesture margins (T_TOUCHUI.systemEdgeMargin from the top and
 * bottom of the window) are not claimed.
 * Wiring (TCH-07, index.ts): pass `settings: () => settings.get().controls.touch` and `ballScreen`, and call
 * update(now) every animation frame (pollFrame) with the pointer manager's clock; the built-in timer covers it
 * meanwhile. No allocation per pointer event: per-pointer state lives in preallocated typed arrays and doubles in
 * object fields (never in closure variables or computed call arguments, which V8 would box).
 */

import { GestureKind } from '../../contracts/enums';
import type { TouchSettings } from '../../contracts/settings';
import {
  ClusterMode, TOUCH_QUEUE_SIZE, type TouchControl, type TouchGestureEvent, type TouchIntentState,
} from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';

/** Pitch gesture recogniser constants (TUNING-CR: candidates for T_TOUCHUI). Distances in CSS pt (= px), times ms. */
export const LOCAL_TUNING = {
  /** Minimum straight travel of a swipe (of the main stroke of a back-and-forth swipe), pt. */
  swipeMinPt: 36,
  /** A swipe of any kind must be finished within this from touch-down, ms. Slower paths are drags (ignored). */
  swipeMaxMs: 700,
  /** Minimum mean speed along the path for a swipe, pt/ms. */
  swipeMinSpeed: 0.3,
  /** A finger resting longer than this before it lifts makes the path a drag-and-hold (ignored), ms. */
  swipeRestMaxMs: 120,
  /** Movement within this distance of the lift point counts as resting, pt. */
  restPt: 4,
  /** End velocity is measured over this much of the final movement, ms. */
  velWindowMs: 50,
  /** |signed area| / chord^2 that gives curve = +-1 (a circular arc of about 100 degrees). */
  curveFullRatio: 0.16,
  /** |curve| from which a swipe is a CURVED_SWIPE (about a 37 degree arc), 0..1. */
  curvedMin: 0.33,
  /** Each stroke of a back-and-forth swipe is at least this long, pt. */
  reverseMinPt: 24,
  /** The return stroke turns at least 120 degrees from the stroke before it (cosine at most this). */
  reverseCos: -0.5,
  /** The second tap of a double tap lands within this distance of the first, pt. */
  doubleTapSlopPt: 44,
  /** A touch-down within this distance of the ball's screen position is "from the ball", pt. */
  fromBallPt: 44,
  /** Path samples kept per pointer (thinned in place when full). */
  pathSamples: 128,
  /** Pitch pointers tracked at once. */
  pointers: 5,
} as const; // TUNING-CR

// ================================================================== section 9 rules (settings keys)

/** Section 9 pitch-gesture rules; the values are the TouchSettings.gestureEnabled keys (missing key = on). */
export const GestureRule = {
  /** Tap a teammate, or just behind him: ground pass to feet. */
  PASS: 'passToFeet',
  /** Tap the space in front of a teammate: through ball into that space. */
  THROUGH: 'throughBall',
  /** Double-tap either of those: the lobbed version. */
  LOBBED: 'lobbed',
  /** In the crossing zone, double-tap toward a post: cross to the near or far post. */
  CROSS: 'crossToPost',
  /** Swipe toward goal: shot (a faster swipe is harder and higher). */
  SHOT: 'shot',
  /** Curved swipe toward goal: finesse shot that bends with the swipe. */
  FINESSE: 'finesseShot',
  /** Tap on the goal: chip shot. */
  CHIP: 'chipShot',
  /** Quick back-and-forth swipe toward goal: power shot. */
  POWER: 'powerShot',
  /** Tap the opposing ball carrier: press him. */
  PRESS: 'press',
  /** Swipe in your own half without the ball: slide tackle. */
  SLIDE: 'slideTackle',
  /** Swipe in your own half with the ball: clearance. */
  CLEAR: 'clearance',
  /** Double-tap the pitch when defending: second defender. */
  SECOND_DEF: 'secondDefender',
  /** Tap your keeper when defending: keeper rushes out. */
  KEEPER_RUSH: 'keeperRush',
  /** Tap a teammate when defending: switch to him. */
  SWITCH: 'switchPlayer',
} as const;
export type GestureRule = (typeof GestureRule)[keyof typeof GestureRule];

/** Every rule, in section 9 table order (controls editor toggles, TCH-08). */
export const GESTURE_RULES: readonly GestureRule[] = [
  GestureRule.PASS, GestureRule.THROUGH, GestureRule.LOBBED, GestureRule.CROSS, GestureRule.SHOT, GestureRule.FINESSE,
  GestureRule.CHIP, GestureRule.POWER, GestureRule.PRESS, GestureRule.SLIDE, GestureRule.CLEAR, GestureRule.SECOND_DEF,
  GestureRule.KEEPER_RUSH, GestureRule.SWITCH,
];

/** Gesture kind each rule is made of. */
export const GESTURE_RULE_KIND: Readonly<Record<GestureRule, GestureKind>> = {
  [GestureRule.PASS]: GestureKind.TAP,
  [GestureRule.THROUGH]: GestureKind.TAP,
  [GestureRule.LOBBED]: GestureKind.DOUBLE_TAP,
  [GestureRule.CROSS]: GestureKind.DOUBLE_TAP,
  [GestureRule.SHOT]: GestureKind.SWIPE,
  [GestureRule.FINESSE]: GestureKind.CURVED_SWIPE,
  [GestureRule.CHIP]: GestureKind.TAP,
  [GestureRule.POWER]: GestureKind.BACK_FORTH_SWIPE,
  [GestureRule.PRESS]: GestureKind.TAP,
  [GestureRule.SLIDE]: GestureKind.SWIPE,
  [GestureRule.CLEAR]: GestureKind.SWIPE,
  [GestureRule.SECOND_DEF]: GestureKind.DOUBLE_TAP,
  [GestureRule.KEEPER_RUSH]: GestureKind.TAP,
  [GestureRule.SWITCH]: GestureKind.TAP,
};

/** Section 9 wording of each rule (controls editor labels). */
export const GESTURE_RULE_LABEL: Readonly<Record<GestureRule, string>> = {
  [GestureRule.PASS]: 'Tap a teammate: pass to feet',
  [GestureRule.THROUGH]: 'Tap space ahead of a teammate: through ball',
  [GestureRule.LOBBED]: 'Double-tap: lobbed pass',
  [GestureRule.CROSS]: 'Double-tap toward a post: cross',
  [GestureRule.SHOT]: 'Swipe toward goal: shot',
  [GestureRule.FINESSE]: 'Curved swipe: finesse shot',
  [GestureRule.CHIP]: 'Tap on the goal: chip shot',
  [GestureRule.POWER]: 'Back-and-forth swipe: power shot',
  [GestureRule.PRESS]: 'Tap the ball carrier: press',
  [GestureRule.SLIDE]: 'Swipe in own half: slide tackle',
  [GestureRule.CLEAR]: 'Swipe in own half with the ball: clearance',
  [GestureRule.SECOND_DEF]: 'Double-tap when defending: second defender',
  [GestureRule.KEEPER_RUSH]: 'Tap your keeper: keeper rushes out',
  [GestureRule.SWITCH]: 'Tap a teammate when defending: switch',
};

/** The part of TouchSettings the gestures read. */
export type GestureSettings = Readonly<Pick<TouchSettings, 'gestures' | 'gestureEnabled'>>;

/** Is this section 9 rule on? (gestures master switch and the rule's own toggle; no settings = on). Pure. */
export function isGestureRuleOn(touch: GestureSettings | null | undefined, rule: GestureRule): boolean {
  if (!touch) return true;
  if (touch.gestures === false) return false;
  const map = touch.gestureEnabled;
  return !map || map[rule] !== false;
}

/** Is any rule made of this gesture kind on? Pure. */
export function isGestureKindOn(touch: GestureSettings | null | undefined, kind: GestureKind): boolean {
  for (let i = 0; i < GESTURE_RULES.length; i++) {
    const r = GESTURE_RULES[i]!;
    if (GESTURE_RULE_KIND[r] === kind && isGestureRuleOn(touch, r)) return true;
  }
  return false;
}

/**
 * The kind to report for a recognised gesture under these settings, or NONE when no rule can use it: a curved swipe
 * without the finesse rule falls back to a plain SWIPE, a back-and-forth swipe without the power-shot rule to a
 * plain SWIPE (its main stroke), and a SWIPE needs one of shot / slide tackle / clearance. Pure.
 */
export function gestureKindFor(kind: GestureKind, touch: GestureSettings | null | undefined): GestureKind {
  switch (kind) {
    case GestureKind.TAP:
    case GestureKind.DOUBLE_TAP:
    case GestureKind.SWIPE:
      return isGestureKindOn(touch, kind) ? kind : GestureKind.NONE;
    case GestureKind.CURVED_SWIPE:
    case GestureKind.BACK_FORTH_SWIPE:
      if (isGestureKindOn(touch, kind)) return kind;
      return isGestureKindOn(touch, GestureKind.SWIPE) ? GestureKind.SWIPE : GestureKind.NONE;
    default:
      return GestureKind.NONE;
  }
}

/** True when any pitch gesture rule is on. Pure. */
export function anyGestureOn(touch: GestureSettings | null | undefined): boolean {
  for (let i = 0; i < GESTURE_RULES.length; i++) if (isGestureRuleOn(touch, GESTURE_RULES[i]!)) return true;
  return false;
}

// ================================================================== pure path classification

/** Result of classifyPath (screen space, CSS px, y down). */
export interface PathClass {
  kind: GestureKind;
  /** Start / end: touch-down / lift (tap, swipe, curved swipe) or the main stroke (back-and-forth swipe). */
  sx: number; sy: number;
  ex: number; ey: number;
  /** End velocity, px/ms (0 for a tap). */
  vx: number; vy: number;
  /** -1..1 signed curvature, positive = bends clockwise on screen (0 for taps and back-and-forth swipes). */
  curve: number;
  /** Touch-down to lift, ms. */
  durMs: number;
  /** Strokes in the path (1 + direction reversals). */
  strokes: number;
}

export function createPathClass(): PathClass {
  return { kind: GestureKind.NONE, sx: 0, sy: 0, ex: 0, ey: 0, vx: 0, vy: 0, curve: 0, durMs: 0, strokes: 0 };
}

function d2(xs: ArrayLike<number>, ys: ArrayLike<number>, i: number, j: number): number {
  const dx = xs[j]! - xs[i]!, dy = ys[j]! - ys[i]!;
  return dx * dx + dy * dy;
}

/** Velocity (px/ms) at sample e over the last LOCAL_TUNING.velWindowMs, looking back no further than sample b. */
function velocityAt(xs: ArrayLike<number>, ys: ArrayLike<number>, ts: ArrayLike<number>, b: number, e: number, out: PathClass): void {
  out.vx = 0;
  out.vy = 0;
  if (e <= b) return;
  const te = ts[e]!;
  let j = e - 1;
  while (j > b && te - ts[j]! < LOCAL_TUNING.velWindowMs) j--;
  const dt = Math.max(1, te - ts[j]!);
  out.vx = (xs[e]! - xs[j]!) / dt;
  out.vy = (ys[e]! - ys[j]!) / dt;
}

/** Scratch for classifyPath's minTravel2 (kept in a typed array so no double is boxed on the way in). */
const TRAVEL_IN = new Float64Array(1);

/**
 * Classify one pointer path: samples 0..n-1 (touch-down first, lift last) of x / y (CSS px) and t (ms,
 * non-decreasing). Fills `out` and returns its kind: TAP, SWIPE, CURVED_SWIPE, BACK_FORTH_SWIPE or NONE (long press,
 * slow drag, drag-and-hold, too short). DOUBLE_TAP is a sequence of two taps, see createPitchGestures. `minTravel2`
 * is the squared max distance from the touch-down seen while tracking (covers thinned samples). Pure, no allocation.
 */
export function classifyPath(
  xs: ArrayLike<number>, ys: ArrayLike<number>, ts: ArrayLike<number>, n: number, out: PathClass, minTravel2 = 0,
): GestureKind {
  TRAVEL_IN[0] = minTravel2;
  return classifyCore(xs, ys, ts, n, out, TRAVEL_IN, 0);
}

/** classifyPath with minTravel2 read from travel[ti]. */
function classifyCore(
  xs: ArrayLike<number>, ys: ArrayLike<number>, ts: ArrayLike<number>, n: number, out: PathClass,
  travel: Float64Array, ti: number,
): GestureKind {
  out.kind = GestureKind.NONE;
  out.sx = 0; out.sy = 0; out.ex = 0; out.ey = 0; out.vx = 0; out.vy = 0; out.curve = 0; out.durMs = 0; out.strokes = 0;
  if (!(n >= 1)) return GestureKind.NONE;
  const last = n - 1;
  const sx = xs[0]!, sy = ys[0]!;
  out.sx = sx; out.sy = sy; out.ex = xs[last]!; out.ey = ys[last]!;
  const dur = Math.max(0, ts[last]! - ts[0]!);
  out.durMs = dur;
  out.strokes = 1;

  const given = travel[ti]!;
  let travel2 = given > 0 ? given : 0;
  let len = 0;
  for (let i = 1; i < n; i++) {
    const t2 = d2(xs, ys, 0, i);
    if (t2 > travel2) travel2 = t2;
    len += Math.sqrt(d2(xs, ys, i - 1, i));
  }
  const tapPt = T_TOUCHUI.tapMaxPt;
  if (travel2 <= tapPt * tapPt) {
    if (dur <= T_TOUCHUI.tapMaxMs) out.kind = GestureKind.TAP;
    return out.kind;
  }
  // Swipes: quick, fast enough, and still moving when the finger lifts.
  if (dur > LOCAL_TUNING.swipeMaxMs) return GestureKind.NONE;
  if (len < LOCAL_TUNING.swipeMinSpeed * Math.max(1, dur)) return GestureKind.NONE;
  const rest2 = LOCAL_TUNING.restPt * LOCAL_TUNING.restPt;
  let k = last;
  while (k > 0 && d2(xs, ys, k - 1, last) <= rest2) k--;
  if (ts[last]! - ts[k]! > LOCAL_TUNING.swipeRestMaxMs) return GestureKind.NONE;

  // Strokes: K = start of the current stroke, F = its farthest point from K. A return of >= reverseMinPt from F at
  // >= 120 degrees closes the stroke K->F and starts the next one at F.
  const rev2 = LOCAL_TUNING.reverseMinPt * LOCAL_TUNING.reverseMinPt;
  let K = 0, F = 0, reversals = 0, bestS = 0, bestE = 0, best2 = -1;
  for (let i = 1; i <= k; i++) {
    const kf2 = d2(xs, ys, K, F);
    if (d2(xs, ys, K, i) > kf2) { F = i; continue; }
    if (kf2 < rev2) continue;
    const fi2 = d2(xs, ys, F, i);
    if (fi2 < rev2) continue;
    const dot = (xs[F]! - xs[K]!) * (xs[i]! - xs[F]!) + (ys[F]! - ys[K]!) * (ys[i]! - ys[F]!);
    if (dot > LOCAL_TUNING.reverseCos * Math.sqrt(kf2 * fi2)) continue;
    if (kf2 >= best2) { best2 = kf2; bestS = K; bestE = F; }
    reversals++;
    K = F;
    F = i;
  }
  const swipe2 = LOCAL_TUNING.swipeMinPt * LOCAL_TUNING.swipeMinPt;
  if (reversals > 0) {
    const fin2 = d2(xs, ys, K, k);
    if (fin2 >= best2) { best2 = fin2; bestS = K; bestE = k; }
    out.strokes = reversals + 1;
    if (best2 < swipe2) return GestureKind.NONE;
    out.sx = xs[bestS]!; out.sy = ys[bestS]!; out.ex = xs[bestE]!; out.ey = ys[bestE]!;
    velocityAt(xs, ys, ts, bestS, bestE, out);
    out.kind = GestureKind.BACK_FORTH_SWIPE;
    return out.kind;
  }

  const cx = out.ex - sx, cy = out.ey - sy;
  const c2 = cx * cx + cy * cy;
  if (c2 < swipe2) return GestureKind.NONE;
  // Signed area between the path and its chord (shoelace about the start; the closing chord adds nothing).
  // y is down, so a positive sum bends clockwise on screen.
  let area2 = 0;
  for (let i = 0; i < last; i++) {
    area2 += (xs[i]! - sx) * (ys[i + 1]! - sy) - (ys[i]! - sy) * (xs[i + 1]! - sx);
  }
  const c = area2 / 2 / c2 / LOCAL_TUNING.curveFullRatio;
  out.curve = c > 1 ? 1 : c < -1 ? -1 : c;
  velocityAt(xs, ys, ts, 0, k, out);
  out.kind = Math.abs(out.curve) >= LOCAL_TUNING.curvedMin ? GestureKind.CURVED_SWIPE : GestureKind.SWIPE;
  return out.kind;
}

/** Thin a full path buffer in place: keep sample 0, every other sample after it, and the newest. Returns the count. */
function thinPath(xs: Float64Array, ys: Float64Array, ts: Float64Array, n: number): number {
  let w = 1;
  for (let r = 2; r < n - 1; r += 2) { xs[w] = xs[r]!; ys[w] = ys[r]!; ts[w] = ts[r]!; w++; }
  xs[w] = xs[n - 1]!; ys[w] = ys[n - 1]!; ts[w] = ts[n - 1]!;
  return w + 1;
}

/**
 * Append a sample to a path buffer of capacity `cap` holding n samples; when full, the older samples are first
 * thinned in place (every other one; the first and the newest stay). Returns the new count. Pure, no allocation.
 */
export function pushPathSample(
  xs: Float64Array, ys: Float64Array, ts: Float64Array, n: number, cap: number, x: number, y: number, t: number,
): number {
  if (n >= cap) n = thinPath(xs, ys, ts, n);
  xs[n] = x; ys[n] = y; ts[n] = t;
  return n + 1;
}

/** Copy a gesture event field by field (Object.assign would box every fractional field). */
function copyGesture(d: TouchGestureEvent, g: Readonly<TouchGestureEvent>): void {
  d.kind = g.kind;
  d.sx = g.sx; d.sy = g.sy; d.ex = g.ex; d.ey = g.ey;
  d.vx = g.vx; d.vy = g.vy; d.curve = g.curve; d.tMs = g.tMs; d.fromBall = g.fromBall;
}

/**
 * Same as contracts/touch.ts pushGestureEvent (append; drops the oldest on overflow) but copies fields explicitly,
 * so pushing a gesture with fractional coordinates allocates nothing.
 */
export function queueGesture(s: TouchIntentState, g: Readonly<TouchGestureEvent>): void {
  const q = s.gestureEvents;
  if (s.gestureEventCount >= TOUCH_QUEUE_SIZE) {
    for (let i = 1; i < TOUCH_QUEUE_SIZE; i++) copyGesture(q[i - 1]!, q[i]!);
    s.gestureEventCount = TOUCH_QUEUE_SIZE - 1;
  }
  copyGesture(q[s.gestureEventCount++]!, g);
}

// ================================================================== the control

export interface PitchGestureOptions {
  state: TouchIntentState;
  /** True where a gesture may start (right half outside the cluster, or anywhere outside the stick zone). */
  zone(x: number, y: number): boolean;
  /** Screen position of the ball (CSS px) for "fromBall" detection; false when off screen. */
  ballScreen?(out: { x: number; y: number }): boolean;
  /** Gestures enabled (settings). */
  enabled?(): boolean;
  /**
   * Live touch settings: `gestures` (master switch) and `gestureEnabled` (per rule, GestureRule keys, missing = on),
   * read at every touch-down and gesture. Default: every rule on.
   */
  settings?(): GestureSettings | null | undefined;
  /**
   * Emit a held-back single tap from a timer once its double-tap window closes, even when no pointer event or
   * update() call follows. Default true where setTimeout exists; tests driving update() themselves pass false.
   */
  timers?: boolean;
}

export interface PitchGestureControl extends TouchControl {
  /**
   * Emit what is due at tMs (same clock as the pointer events): a held-back single tap whose double-tap window has
   * closed, or whose second touch can no longer be a tap. Call it every animation frame; cheap when idle.
   */
  update(tMs: number): void;
  /** Pitch pointers being tracked. */
  readonly active: number;
  /** A completed tap is waiting for its double-tap window. */
  readonly pendingTap: boolean;
}

/** Window height when there is a window (browser), else 0 (Node tests). */
function windowHeight(): number {
  const h = (globalThis as { innerHeight?: unknown }).innerHeight;
  return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

export function createPitchGestures(opts: PitchGestureOptions): PitchGestureControl {
  const st = opts.state;
  const P = LOCAL_TUNING.pointers;
  const CAP = LOCAL_TUNING.pathSamples;
  const TAP_PT2 = T_TOUCHUI.tapMaxPt * T_TOUCHUI.tapMaxPt;
  const SLOP2 = LOCAL_TUNING.doubleTapSlopPt * LOCAL_TUNING.doubleTapSlopPt;
  const BALL2 = LOCAL_TUNING.fromBallPt * LOCAL_TUNING.fromBallPt;

  // Per-pointer table (fixed size). Doubles live in typed arrays / object fields, never in closure variables or call
  // arguments, so V8 never boxes them (no allocation per pointer event).
  const used = new Uint8Array(P);
  const ids = new Float64Array(P);
  const count = new Int32Array(P);
  const travel2 = new Float64Array(P);
  const downT = new Float64Array(P);
  const lastT = new Float64Array(P);
  const fromBall = new Uint8Array(P);
  const hiddenAtDown = new Uint8Array(P);
  const xsAll = new Float64Array(P * CAP);
  const ysAll = new Float64Array(P * CAP);
  const tsAll = new Float64Array(P * CAP);
  const xsV: Float64Array[] = [];
  const ysV: Float64Array[] = [];
  const tsV: Float64Array[] = [];
  for (let i = 0; i < P; i++) {
    xsV.push(xsAll.subarray(i * CAP, (i + 1) * CAP));
    ysV.push(ysAll.subarray(i * CAP, (i + 1) * CAP));
    tsV.push(tsAll.subarray(i * CAP, (i + 1) * CAP));
  }
  let active = 0;

  /**
   * Clock and held-back tap: `now` = time of the event being handled; `clock` = latest finite time seen (fallback for
   * a non-finite tMs); the tap's touch-down / lift points and times; the timer's due time.
   */
  const T = { now: 0.5, clock: 0.5, timerDue: 0.5, sx: 0.5, sy: 0.5, ex: 0.5, ey: 0.5, downT: 0.5, upT: 0.5 };
  T.now = 0; T.clock = 0; T.timerDue = 0; T.sx = 0; T.sy = 0; T.ex = 0; T.ey = 0; T.downT = 0; T.upT = 0;
  let pend = false;
  let pBall = false;
  /** Slot of the second touch that may complete the double tap, -1 = none. */
  let pCand = -1;

  // Timer fallback for the held-back tap.
  const useTimers = opts.timers !== false && typeof globalThis.setTimeout === 'function';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cls = createPathClass();
  const G: TouchGestureEvent = { kind: GestureKind.NONE, sx: 0, sy: 0, ex: 0, ey: 0, vx: 0, vy: 0, curve: 0, tMs: 0, fromBall: false };
  const ballPt = { x: 0, y: 0 };

  function settings(): GestureSettings | null | undefined {
    return opts.settings ? opts.settings() : null;
  }
  function masterOn(): boolean {
    return !(opts.enabled && opts.enabled() === false);
  }
  function allowed(kind: GestureKind): GestureKind {
    return masterOn() ? gestureKindFor(kind, settings()) : GestureKind.NONE;
  }
  function doubleTapOn(): boolean {
    return allowed(GestureKind.DOUBLE_TAP) === GestureKind.DOUBLE_TAP;
  }
  /** T.now = tMs (or the latest finite time when tMs is not finite); advances T.clock. */
  function setNow(tMs: number): void {
    if (Number.isFinite(tMs)) {
      T.now = tMs;
      if (tMs > T.clock) T.clock = tMs;
    } else {
      T.now = T.clock;
    }
  }
  /** setNow, but never earlier than the pointer's last sample. */
  function setNowFor(s: number, tMs: number): void {
    setNow(tMs);
    if (T.now < lastT[s]!) T.now = lastT[s]!;
  }
  function slotOf(id: number): number {
    for (let i = 0; i < P; i++) if (used[i] === 1 && ids[i] === id) return i;
    return -1;
  }
  function freeSlot(): number {
    for (let i = 0; i < P; i++) if (used[i] === 0) return i;
    return -1;
  }
  function release(s: number): void {
    used[s] = 0;
    count[s] = 0;
    active--;
  }
  /** Append (x, y) at T.now to pointer s's path. */
  function push(s: number, x: number, y: number): void {
    const xs = xsV[s]!, ys = ysV[s]!, ts = tsV[s]!;
    let n = count[s]!;
    if (n >= CAP) n = thinPath(xs, ys, ts, n);
    xs[n] = x; ys[n] = y; ts[n] = T.now;
    count[s] = n + 1;
    lastT[s] = T.now;
    const dx = x - xs[0]!, dy = y - ys[0]!;
    const dd = dx * dx + dy * dy;
    if (dd > travel2[s]!) travel2[s] = dd;
  }
  /** Repeat pointer s's last sample at T.now (a lift without usable coordinates). */
  function pushLast(s: number): void {
    const n = count[s]!;
    if (n >= CAP) {
      count[s] = thinPath(xsV[s]!, ysV[s]!, tsV[s]!, n);
    }
    const m = count[s]!;
    xsV[s]![m] = xsV[s]![m - 1]!;
    ysV[s]![m] = ysV[s]![m - 1]!;
    tsV[s]![m] = T.now;
    count[s] = m + 1;
    lastT[s] = T.now;
  }
  function nearBall(x: number, y: number): boolean {
    if (!opts.ballScreen || !opts.ballScreen(ballPt)) return false;
    const dx = x - ballPt.x, dy = y - ballPt.y;
    return Number.isFinite(dx) && Number.isFinite(dy) && dx * dx + dy * dy <= BALL2;
  }
  function clearOfEdges(y: number): boolean {
    const h = windowHeight();
    if (!(h > 0)) return true;
    const m = T_TOUCHUI.systemEdgeMargin;
    return y >= m && y <= h - m;
  }

  /** Push the gesture in `cls` (taps without motion) stamped T.now. */
  function emitCls(kind: GestureKind, ball: boolean): void {
    G.kind = kind;
    G.sx = cls.sx; G.sy = cls.sy; G.ex = cls.ex; G.ey = cls.ey;
    if (kind === GestureKind.TAP || kind === GestureKind.DOUBLE_TAP) {
      G.vx = 0; G.vy = 0; G.curve = 0;
    } else {
      G.vx = cls.vx; G.vy = cls.vy;
      G.curve = kind === GestureKind.BACK_FORTH_SWIPE ? 0 : cls.curve;
    }
    G.tMs = T.now;
    G.fromBall = ball;
    queueGesture(st, G);
  }
  /** Push the held-back tap as `kind` (TAP; DOUBLE_TAP takes its end from cls and its time from T.now). */
  function emitPending(kind: GestureKind): void {
    G.kind = kind;
    G.sx = T.sx; G.sy = T.sy;
    if (kind === GestureKind.DOUBLE_TAP) {
      G.ex = cls.ex; G.ey = cls.ey; G.tMs = T.now;
    } else {
      G.ex = T.ex; G.ey = T.ey; G.tMs = T.upT;
    }
    G.vx = 0; G.vy = 0; G.curve = 0;
    G.fromBall = pBall;
    queueGesture(st, G);
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }
  function onTimer(): void {
    timer = null;
    T.now = T.timerDue;
    due();
  }
  /** Arm the timer for T.timerDue (relative to T.now). */
  function arm(): void {
    if (!useTimers) return;
    cancelTimer();
    timer = setTimeout(onTimer, Math.max(0, T.timerDue - T.now));
  }

  /** Forget the held-back tap without an action. */
  function dropPending(): void {
    pend = false;
    pCand = -1;
    cancelTimer();
  }
  /** Emit the held-back tap as a single TAP (it will not become a double tap). */
  function flushPending(): void {
    if (!pend) return;
    dropPending();
    const k = allowed(GestureKind.TAP);
    if (k !== GestureKind.NONE) emitPending(k);
  }
  /** Emit what is due at T.now. */
  function due(): void {
    if (!pend) return;
    if (pCand >= 0) {
      if (T.now - downT[pCand]! > T_TOUCHUI.tapMaxMs) flushPending();
    } else if (T.now - T.downT > T_TOUCHUI.doubleTapMs) {
      flushPending();
    }
  }

  return {
    get active() { return active; },
    get pendingTap() { return pend; },
    update(tMs) {
      if (!pend) return;
      setNow(tMs);
      due();
    },
    hit(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (!opts.zone(x, y) || !clearOfEdges(y)) return false;
      if (st.mode === ClusterMode.HIDDEN) return true;
      return masterOn() && anyGestureOn(settings());
    },
    down(id, x, y, tMs) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || slotOf(id) >= 0) return;
      setNow(tMs);
      due();
      const s = freeSlot();
      if (s < 0) return;
      used[s] = 1;
      ids[s] = id;
      active++;
      count[s] = 0;
      travel2[s] = 0;
      downT[s] = T.now;
      hiddenAtDown[s] = st.mode === ClusterMode.HIDDEN ? 1 : 0;
      fromBall[s] = nearBall(x, y) ? 1 : 0;
      push(s, x, y);
      if (!pend) return;
      const dx = x - T.sx, dy = y - T.sy;
      if (pCand < 0 && hiddenAtDown[s] === 0 && T.now - T.downT <= T_TOUCHUI.doubleTapMs && dx * dx + dy * dy <= SLOP2) {
        // Possible second tap: hold the first one back until this touch lifts (or stops being a tap).
        pCand = s;
        T.timerDue = T.now + T_TOUCHUI.tapMaxMs + 1;
        arm();
      } else {
        flushPending();
      }
    },
    move(id, x, y, tMs) {
      const s = slotOf(id);
      if (s < 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
      setNowFor(s, tMs);
      push(s, x, y);
      if (pCand === s && travel2[s]! > TAP_PT2) flushPending();
      due();
    },
    up(id, x, y, tMs) {
      const s = slotOf(id);
      if (s < 0) return;
      setNowFor(s, tMs);
      if (Number.isFinite(x) && Number.isFinite(y)) push(s, x, y);
      else pushLast(s);
      due();
      const kind = classifyCore(xsV[s]!, ysV[s]!, tsV[s]!, count[s]!, cls, travel2, s);
      const cand = pend && pCand === s;
      const hidden = hiddenAtDown[s] === 1;
      const ball = fromBall[s] === 1;
      release(s);
      if (kind === GestureKind.TAP) {
        if (cand) {
          if (doubleTapOn()) {
            dropPending();
            emitPending(GestureKind.DOUBLE_TAP);
            return;
          }
          flushPending();
        }
        if (hidden) {
          // Cut-scene: any tap skips, whatever the gesture settings.
          flushPending();
          emitCls(GestureKind.TAP, ball);
          return;
        }
        flushPending();
        if (!doubleTapOn()) {
          const k = allowed(GestureKind.TAP);
          if (k !== GestureKind.NONE) emitCls(k, ball);
          return;
        }
        pend = true;
        pCand = -1;
        T.sx = cls.sx; T.sy = cls.sy; T.ex = cls.ex; T.ey = cls.ey; T.downT = downT[s]!; T.upT = T.now; pBall = ball;
        T.timerDue = T.downT + T_TOUCHUI.doubleTapMs + 1;
        arm();
        return;
      }
      // Not a tap: a held-back first tap stands alone (and comes first).
      if (cand) flushPending();
      if (kind === GestureKind.NONE) return;
      const k = allowed(kind);
      if (k === GestureKind.NONE) return;
      flushPending();
      emitCls(k, ball);
    },
    cancel(id, tMs) {
      const s = slotOf(id);
      if (s < 0) return;
      setNow(tMs);
      // A cancelled second touch cancels the double tap it was completing.
      if (pend && pCand === s) dropPending();
      release(s);
    },
    releaseAll(tMs) {
      setNow(tMs);
      for (let i = 0; i < P; i++) used[i] = 0;
      count.fill(0);
      active = 0;
      dropPending();
    },
  };
}

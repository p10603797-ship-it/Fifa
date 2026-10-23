/**
 * [TCH-06] Set-piece touch controls and flight preview (section 9 "Set pieces on touch"):
 *  - Kick-off: PASS. Throw-ins and goal kicks: tap a teammate or use the buttons. (Buttons are TCH-03's cluster in
 *    ClusterMode.SET_PIECE and taps are TCH-05's pitch gestures; this control never claims a touch at those restarts,
 *    so the stick and the pitch gestures keep them.)
 *  - Corners and wide free kicks: tap a teammate / a spot in the box, or swipe from the ball (speed = height,
 *    curve = curl); PASS plays it short.
 *  - Free kicks at goal: swipe from the ball toward goal (speed = power and height, curve = curl) with a dotted
 *    preview of the first part of the flight (TouchIntentState.previewX/Y/Count, drawn by TCH-09).
 *  - Penalties (and shoot-out kicks): swipe toward the part of the goal you want; to save, tap or swipe the dive
 *    direction.
 * Active only while ClusterMode.SET_PIECE (the mapper sets the mode from the restart phase).
 *
 * Claiming (hit, called by the pointer manager before the stick and the pitch gestures): a touch-down within
 * LOCAL_TUNING.ballPt of the ball's screen position (opts.ballScreen) while the mode is SET_PIECE, the restart is one
 * where a swipe from the ball means something (setPieceSwipePhase: CORNER, FREE_KICK, PENALTY, SHOOT_OUT, not yet
 * taken) and no set-piece swipe is already in progress (one at a time; a second finger falls through to the next
 * control). Not inside the system-gesture margins (T_TOUCHUI.systemEdgeMargin from the top and bottom of the window),
 * like the pitch gestures. Taps elsewhere are never claimed: they reach the pitch gestures (TCH-05) and pass through
 * to the mapper as TAP / DOUBLE_TAP gestures (tap a teammate or a spot). Without opts.getState the restart is unknown
 * and nothing is claimed (the pitch gestures still report swipes from the ball, without a preview), so the touch
 * source passes getState / getProjector and calls update() every frame and before each sample (index.ts).
 *
 * Recognition at the lift (pure core: classifySetPiecePath):
 *  - TAP: never further than T_TOUCHUI.tapMaxPt from the touch-down, lifted within tapMaxMs (a teammate standing at the
 *    ball, e.g. a short corner). Emitted at once as a TAP with fromBall = true. A longer still press is nothing.
 *  - A finger that rests before it lifts does not change the swipe: the path is classified up to where it came to rest
 *    (samples within TCH-05's restPt of the lift point are dropped). So the preview shown while the finger rests is
 *    exactly what the lift plays.
 *  - Quick swipes: TCH-05's classifyPath (SWIPE / CURVED_SWIPE / BACK_FORTH_SWIPE, same thresholds, curvature and end
 *    velocity), so a set-piece swipe means what a pitch swipe means.
 *  - Slower swipes (beyond TCH-05's swipeMaxMs or below its mean speed) still count at a set piece, since speed sets
 *    the power: SWIPE / CURVED_SWIPE from the touch-down to the rest point when that chord is at least TCH-05's
 *    swipeMinPt; curvature and end velocity measured as TCH-05 does. Shorter (dragged back onto the ball) = nothing.
 *  Every swipe is emitted with fromBall = true (sx, sy = touch-down or the main stroke's start; ex, ey = rest / lift
 *  point; vx, vy = end velocity, which the mapper turns into gPower; curve = signed curvature -> gCurve).
 *  Nothing is emitted when the context is gone at the lift or was lost during the hold (mode no longer SET_PIECE, the
 *  restart taken or changed, opts.enabled() false): a swipe started at a free kick never becomes an open-play shot.
 *
 * Preview (while dragging; TouchIntentState.previewX / previewY / previewCount, CSS px; point 0 is always the ball):
 *  - On touch-down: the ball point alone (the visible pressed state, within the same frame).
 *  - Flight: when the path would be a swipe if lifted now, opts.getState / opts.getProjector are available and RUL-05
 *    previewFlight returns a flight (an untaken free kick with the taker waiting): the swipe is converted into the
 *    InputFrame gesture fields exactly as the mapper converts the emitted gesture (setPieceSwipeFrame: gx / gz, gdx /
 *    gdz, gPower, gCurve, FROM_BALL), previewFlight predicts the flight with the sim's own kick solver and ball physics,
 *    and one dot every LOCAL_TUNING.previewStepTicks of the first LOCAL_TUNING.previewTicks is projected to the
 *    screen (CameraProjector.pitchToScreen; the dots stop where the projection fails).
 *  - Otherwise (corners, penalties, a path that is not a swipe yet, no projector): the finger trail, one dot every
 *    LOCAL_TUNING.trailSpacingPt along the path from the touch-down.
 *  - Refreshed at most every LOCAL_TUNING.previewEveryMs (every 2nd frame at 60 Hz) while the finger is down: by a
 *    move, by update(t) (call it every animation frame) or by a timer when no update comes (opts.timers), so the dots
 *    follow a moving camera and the last move is never left out. Cleared at the lift, on cancel / releaseAll and as
 *    soon as the context is lost.
 * Lifecycle: cancel (pointercancel, lost capture) and releaseAll (blur, visibilitychange, pause) drop the swipe and the
 * preview without an action (no stuck preview).
 * No allocation per pointer event or preview refresh (preallocated typed arrays and scratch objects; previewFlight is
 * allocation-free after its first call). The CameraProjector calls receive doubles, which V8 may box when it does not
 * inline the projector (contract-level).
 */

import { WORLD_MAX_X, WORLD_MAX_Z } from '../../contracts/constants';
import { GestureKind, MatchPhase } from '../../contracts/enums';
import {
  clearInputFrame, createInputFrame, GestureFlag, quantAxis, quantPos, quantUnit, type CameraProjector, type InputFrame,
} from '../../contracts/input';
import type { ReadonlySimState, SimState } from '../../contracts/state';
import { createBallPrediction, type BallPrediction } from '../../contracts/systems';
import { ClusterMode, type TouchControl, type TouchGestureEvent, type TouchIntentState } from '../../contracts/touch';
import { T_TOUCH_SETPIECE, T_TOUCHUI } from '../../contracts/tuning';
import { previewFlight as rulPreviewFlight } from '../../sim/rules/freekick';
import { quantStick, writeAimAxes } from '../axes';
import { classifyPath, createPathClass, LOCAL_TUNING as GESTURE_TUNING, queueGesture, type PathClass } from './gestures';
import { LOCAL_TUNING as MAPPER_TUNING } from './mapper';

/** Set-piece swipe constants: contracts/tuning.ts T_TOUCH_SETPIECE ([TUN-2]; the old name is kept for importers). */
export const LOCAL_TUNING = T_TOUCH_SETPIECE;

/** What TouchIntentState.preview* holds. */
export const PreviewKind = {
  /** Nothing (count 0). */
  NONE: 0,
  /** The ball point and the finger trail (touch-down, no flight to show). */
  TRAIL: 1,
  /** The ball point and the predicted flight. */
  FLIGHT: 2,
} as const;
export type PreviewKind = (typeof PreviewKind)[keyof typeof PreviewKind];

/** Flight preview source: fills `out` with the flight (sample i = after i + 1 ticks); 0 = nothing to preview. */
export type PreviewFlightFn = (s: SimState, out: BallPrediction, f: Readonly<InputFrame>) => number;

export interface SetPieceSwipeOptions {
  state: TouchIntentState;
  /** Screen position of the ball (CSS px); false when off screen. */
  ballScreen?(out: { x: number; y: number }): boolean;
  /**
   * Live sim state (read only): which restart is on (setPieceSwipePhase) and the free-kick flight preview. Without it
   * (or while it returns null) nothing is claimed.
   */
  getState?(): ReadonlySimState | null;
  /** Active camera projection (swipe -> pitch for the preview, flight -> screen). Without it: finger trail only. */
  getProjector?(): CameraProjector | null;
  /** Set-piece swipes enabled (default on). Read at touch-down and at the lift. */
  enabled?(): boolean;
  /** Flight preview source (default RUL-05 previewFlight; it never writes the state it is given). */
  previewFlight?: PreviewFlightFn;
  /**
   * Refresh the preview from a timer while the finger is down, even when no move or update() follows (camera motion,
   * the move skipped by the throttle). Default true where setTimeout exists; tests driving update() pass false.
   */
  timers?: boolean;
}

export interface SetPieceSwipeControl extends TouchControl {
  /** Refresh what is due at tMs (same clock as the pointer events): the throttled preview. Call every animation frame. */
  update(tMs: number): void;
  /** A set-piece swipe is in progress (claimed and still meaningful). */
  readonly active: boolean;
  /** What the preview holds now. */
  readonly previewKind: PreviewKind;
  /** Flight previews computed so far (throttle diagnostics). */
  readonly previewComputations: number;
}

// ================================================================== pure helpers

/**
 * True when a swipe from the ball means something in this restart: an untaken corner, free kick, penalty or
 * shoot-out kick. Kick-offs, throw-ins and goal kicks are played with the buttons and taps. No state = false. Pure.
 */
export function setPieceSwipePhase(s: ReadonlySimState | null | undefined): boolean {
  if (!s) return false;
  const m = s.match;
  switch (m.phase) {
    case MatchPhase.CORNER:
    case MatchPhase.FREE_KICK:
    case MatchPhase.PENALTY:
    case MatchPhase.SHOOT_OUT:
      return m.restart.taken !== 1;
    default:
      return false;
  }
}

function isSwipeKind(k: GestureKind): boolean {
  return k === GestureKind.SWIPE || k === GestureKind.CURVED_SWIPE || k === GestureKind.BACK_FORTH_SWIPE;
}

function d2(xs: ArrayLike<number>, ys: ArrayLike<number>, i: number, j: number): number {
  const dx = xs[j]! - xs[i]!, dy = ys[j]! - ys[i]!;
  return dx * dx + dy * dy;
}

function resetCls(out: PathClass): void {
  out.kind = GestureKind.NONE;
  out.sx = 0; out.sy = 0; out.ex = 0; out.ey = 0; out.vx = 0; out.vy = 0; out.curve = 0; out.durMs = 0; out.strokes = 0;
}

/** Scratch for classifySetPiecePath's minTravel2 (kept in a typed array so no double is boxed on the way in). */
const TRAVEL_IN = new Float64Array(1);

/**
 * Classify a set-piece path: samples 0..n-1 (touch-down first, lift last) of x / y (CSS px) and t (ms,
 * non-decreasing). Fills `out` (TCH-05 PathClass) and returns TAP, SWIPE, CURVED_SWIPE, BACK_FORTH_SWIPE or NONE (long
 * press, dragged back onto the ball, too short). `minTravel2` is the squared max distance from the touch-down seen
 * while tracking (covers thinned samples). See the header for the rules. Pure, no allocation.
 */
export function classifySetPiecePath(
  xs: ArrayLike<number>, ys: ArrayLike<number>, ts: ArrayLike<number>, n: number, out: PathClass, minTravel2 = 0,
): GestureKind {
  TRAVEL_IN[0] = minTravel2;
  return classifyCore(xs, ys, ts, n, out, TRAVEL_IN, 0);
}

/** classifySetPiecePath with minTravel2 read from travel[ti]. */
function classifyCore(
  xs: ArrayLike<number>, ys: ArrayLike<number>, ts: ArrayLike<number>, n: number, out: PathClass,
  travel: Float64Array, ti: number,
): GestureKind {
  resetCls(out);
  if (!(n >= 1)) return GestureKind.NONE;
  const last = n - 1;
  out.sx = xs[0]!; out.sy = ys[0]!; out.ex = xs[last]!; out.ey = ys[last]!;
  out.durMs = Math.max(0, ts[last]! - ts[0]!);
  out.strokes = 1;
  // Taps: never further than tapMaxPt from the touch-down (also across thinned samples), lifted in time.
  const given = travel[ti]!;
  let t2 = given > 0 ? given : 0;
  for (let i = 1; i < n; i++) {
    const a = d2(xs, ys, 0, i);
    if (a > t2) t2 = a;
  }
  const tapPt = T_TOUCHUI.tapMaxPt;
  if (t2 <= tapPt * tapPt) {
    if (out.durMs <= T_TOUCHUI.tapMaxMs) out.kind = GestureKind.TAP;
    return out.kind;
  }
  // A finger resting before the lift does not change the swipe: classify up to where it came to rest.
  const rest2 = GESTURE_TUNING.restPt * GESTURE_TUNING.restPt;
  let k = last;
  while (k > 0 && d2(xs, ys, k - 1, last) <= rest2) k--;
  // Quick swipes: exactly the pitch gestures' recogniser (TCH-05).
  const quick = classifyPath(xs, ys, ts, k + 1, out);
  if (isSwipeKind(quick)) return quick;
  // Slower swipes still count at a set piece (speed sets the power): touch-down -> rest point.
  resetCls(out);
  const sx = xs[0]!, sy = ys[0]!;
  out.sx = sx; out.sy = sy; out.ex = xs[k]!; out.ey = ys[k]!;
  out.durMs = Math.max(0, ts[k]! - ts[0]!);
  out.strokes = 1;
  const cx = out.ex - sx, cy = out.ey - sy;
  const c2 = cx * cx + cy * cy;
  if (c2 < GESTURE_TUNING.swipeMinPt * GESTURE_TUNING.swipeMinPt) return GestureKind.NONE;
  // Signed area between the path and its chord (shoelace about the start), as TCH-05: positive = clockwise on screen.
  let area2 = 0;
  for (let i = 0; i < k; i++) {
    area2 += (xs[i]! - sx) * (ys[i + 1]! - sy) - (ys[i]! - sy) * (xs[i + 1]! - sx);
  }
  const c = area2 / 2 / c2 / GESTURE_TUNING.curveFullRatio;
  out.curve = c > 1 ? 1 : c < -1 ? -1 : c;
  // End velocity over the last velWindowMs of movement (TCH-05 velocityAt).
  const te = ts[k]!;
  let j = k - 1;
  while (j > 0 && te - ts[j]! < GESTURE_TUNING.velWindowMs) j--;
  const dt = Math.max(1, te - ts[j]!);
  out.vx = (xs[k]! - xs[j]!) / dt;
  out.vy = (ys[k]! - ys[j]!) / dt;
  out.kind = Math.abs(out.curve) >= GESTURE_TUNING.curvedMin ? GestureKind.CURVED_SWIPE : GestureKind.SWIPE;
  return out.kind;
}

function finiteOr(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** setPieceSwipeFrame scratch (module level: no allocation per call). */
const FP0 = { x: 0.5, z: 0.5 };
const FP1 = { x: 0.5, z: 0.5 };
const FAIM = createInputFrame();
const FQ = { qx: 0, qy: 0 };
FP0.x = 0; FP0.z = 0; FP1.x = 0; FP1.z = 0;

/**
 * The InputFrame gesture fields the mapper (TCH-07 convertGesture) produces for this classified swipe, written into
 * `out` (cleared first): gesture, gx / gz (decimetres; the end point on the ground, else the start), gdx / gdz (unit
 * direction start -> end on the ground, else the screen direction rotated like the stick), gPower (end speed /
 * gestureFullSpeed, at least gestureMinPower), gCurve, gFlags = FROM_BALL, gSlot = -1 (unused by set-piece swipes).
 * Returns false (frame cleared) when `cls` is not a swipe or cannot be projected. Pure apart from `out`.
 */
export function setPieceSwipeFrame(cls: Readonly<PathClass>, proj: CameraProjector, out: InputFrame): boolean {
  clearInputFrame(out);
  const kind = cls.kind;
  if (!isSwipeKind(kind)) return false;
  const okS = Number.isFinite(cls.sx) && Number.isFinite(cls.sy) && proj.screenToPitch(cls.sx, cls.sy, FP0);
  const okE = Number.isFinite(cls.ex) && Number.isFinite(cls.ey) && proj.screenToPitch(cls.ex, cls.ey, FP1);
  if (!okE && !okS) return false;
  const px = okE ? FP1.x : FP0.x, pz = okE ? FP1.z : FP0.z;
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
  const mx = WORLD_MAX_X * 10, mz = WORLD_MAX_Z * 10;
  out.gesture = kind;
  out.gx = clampInt(quantPos(px), -mx, mx);
  out.gz = clampInt(quantPos(pz), -mz, mz);
  let dx = 0, dz = 0;
  if (okS && okE) { dx = FP1.x - FP0.x; dz = FP1.z - FP0.z; }
  if (!(dx * dx + dz * dz > 1e-6) || !Number.isFinite(dx) || !Number.isFinite(dz)) {
    writeAimAxes(FAIM, finiteOr(cls.ex - cls.sx), finiteOr(cls.ey - cls.sy), proj);
    dx = FAIM.ax; dz = FAIM.az;
  }
  const m = Math.sqrt(dx * dx + dz * dz);
  if (m > 1e-9) {
    quantStick(dx / m, dz / m, FQ);
    out.gdx = FQ.qx; out.gdz = FQ.qy;
  }
  const vx = finiteOr(cls.vx), vy = finiteOr(cls.vy);
  const pw = Math.sqrt(vx * vx + vy * vy) / MAPPER_TUNING.gestureFullSpeed;
  const lo = MAPPER_TUNING.gestureMinPower;
  out.gPower = Math.max(1, quantUnit(pw < lo ? lo : pw > 1 ? 1 : pw));
  out.gCurve = quantAxis(finiteOr(cls.curve));
  out.gSlot = -1;
  out.gFlags = GestureFlag.FROM_BALL;
  return true;
}

/** Window height when there is a window (browser), else 0 (Node tests). */
function windowHeight(): number {
  const h = (globalThis as { innerHeight?: unknown }).innerHeight;
  return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

// ================================================================== the control

// Scalar doubles of the control live in one Float64Array (closure variables holding doubles would be boxed by V8).
const F_ID = 0;
const F_DOWN_T = 1;
const F_NOW = 2;
const F_CLOCK = 3;
const F_PREV_T = 4;
const F_DUE = 5;
const F_BX = 6;
const F_BY = 7;
const F_COUNT = 8;

export function createSetPieceSwipe(opts: SetPieceSwipeOptions): SetPieceSwipeControl {
  const st = opts.state;
  const CAP = GESTURE_TUNING.pathSamples;
  const BALL2 = LOCAL_TUNING.ballPt * LOCAL_TUNING.ballPt;
  const preview: PreviewFlightFn = opts.previewFlight ?? rulPreviewFlight;

  const xs = new Float64Array(CAP);
  const ys = new Float64Array(CAP);
  const ts = new Float64Array(CAP);
  const travel = new Float64Array(1);
  const F = new Float64Array(F_COUNT);
  let n = 0;
  let tracking = false;
  /** The context was lost during the hold: the lift does nothing. */
  let voided = false;
  /** Moves since the last preview refresh. */
  let dirty = false;
  let pkind: PreviewKind = PreviewKind.NONE;
  let computations = 0;

  const cls = createPathClass();
  const G: TouchGestureEvent = { kind: GestureKind.NONE, sx: 0.5, sy: 0.5, ex: 0.5, ey: 0.5, vx: 0.5, vy: 0.5, curve: 0.5, tMs: 0.5, fromBall: true };
  const BS = { x: 0.5, y: 0.5 };
  const SP = { x: 0.5, y: 0.5 };
  const PF = createInputFrame();
  const PRED = createBallPrediction();

  const useTimers = opts.timers !== false && typeof globalThis.setTimeout === 'function';
  let timer: ReturnType<typeof setTimeout> | null = null;

  function enabled(): boolean {
    return !(opts.enabled && opts.enabled() === false);
  }
  function simState(): ReadonlySimState | null {
    return opts.getState ? opts.getState() : null;
  }
  function projector(): CameraProjector | null {
    return opts.getProjector ? opts.getProjector() : null;
  }
  /** Mode, restart and setting still allow this set-piece swipe (no state wired = never). */
  function contextOk(): boolean {
    return st.mode === ClusterMode.SET_PIECE && enabled() && setPieceSwipePhase(simState());
  }
  /** F_NOW = tMs (or the latest finite time when tMs is not finite); advances F_CLOCK. */
  function setNow(tMs: number): void {
    if (Number.isFinite(tMs)) {
      F[F_NOW] = tMs;
      if (tMs > F[F_CLOCK]!) F[F_CLOCK] = tMs;
    } else {
      F[F_NOW] = F[F_CLOCK]!;
    }
    if (n > 0 && F[F_NOW]! < ts[n - 1]!) F[F_NOW] = ts[n - 1]!;
  }
  function clearOfEdges(y: number): boolean {
    const h = windowHeight();
    if (!(h > 0)) return true;
    const m = T_TOUCHUI.systemEdgeMargin;
    return y >= m && y <= h - m;
  }
  /** Ball screen position into BS; false when unknown / off screen / not finite. */
  function ballPoint(): boolean {
    if (!opts.ballScreen || !opts.ballScreen(BS)) return false;
    return Number.isFinite(BS.x) && Number.isFinite(BS.y);
  }

  /** Thin a full path in place: keep sample 0, every other sample after it, and the newest. */
  function thin(): void {
    let w = 1;
    for (let r = 2; r < n - 1; r += 2) { xs[w] = xs[r]!; ys[w] = ys[r]!; ts[w] = ts[r]!; w++; }
    xs[w] = xs[n - 1]!; ys[w] = ys[n - 1]!; ts[w] = ts[n - 1]!;
    n = w + 1;
  }
  /** Append (x, y) at F_NOW. */
  function push(x: number, y: number): void {
    if (n >= CAP) thin();
    xs[n] = x; ys[n] = y; ts[n] = F[F_NOW]!;
    n++;
    const dx = x - xs[0]!, dy = y - ys[0]!;
    const dd = dx * dx + dy * dy;
    if (dd > travel[0]!) travel[0] = dd;
  }
  /** Repeat the last sample at F_NOW (a lift without usable coordinates). */
  function pushLast(): void {
    if (n >= CAP) thin();
    xs[n] = xs[n - 1]!; ys[n] = ys[n - 1]!; ts[n] = F[F_NOW]!;
    n++;
  }

  // ---------------------------------------------------------------- preview

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }
  function onTimer(): void {
    timer = null;
    if (!tracking || voided) return;
    if (F[F_DUE]! > F[F_NOW]!) F[F_NOW] = F[F_DUE]!;
    if (!contextOk()) { voidSwipe(); return; }
    // Armed for this refresh; an update() / move that refreshed meanwhile just pushes it back.
    if (F[F_NOW]! - F[F_PREV_T]! >= LOCAL_TUNING.previewEveryMs - 1) refresh();
    else arm();
  }
  /** Keep a timer armed for the next refresh while the finger is down. */
  function arm(): void {
    if (!useTimers || timer !== null || !tracking || voided) return;
    F[F_DUE] = F[F_PREV_T]! + LOCAL_TUNING.previewEveryMs;
    timer = setTimeout(onTimer, Math.max(0, F[F_DUE]! - F[F_NOW]!));
  }
  function clearPreview(): void {
    st.previewCount = 0;
    pkind = PreviewKind.NONE;
  }
  /** Preview = the ball point alone (touch-down: the pressed state). */
  function showBallDot(): void {
    if (st.previewX.length < 1 || st.previewY.length < 1) { clearPreview(); return; }
    st.previewX[0] = F[F_BX]!;
    st.previewY[0] = F[F_BY]!;
    st.previewCount = 1;
    pkind = PreviewKind.TRAIL;
  }
  /** Ball point (re-projected: the camera may move) into preview slot 0. */
  function writeBallPoint(): void {
    if (ballPoint()) { F[F_BX] = BS.x; F[F_BY] = BS.y; }
    st.previewX[0] = F[F_BX]!;
    st.previewY[0] = F[F_BY]!;
  }
  /** Flight dots after the ball point; returns the count (1 = no flight dot could be projected). */
  function writeFlight(proj: CameraProjector, cap: number): number {
    writeBallPoint();
    let c = 1;
    const step = LOCAL_TUNING.previewStepTicks;
    const lim = Math.min(PRED.count, LOCAL_TUNING.previewTicks, PRED.x.length);
    for (let i = step - 1; i < lim && c < cap; i += step) {
      const px = PRED.x[i]!, py = PRED.y[i]!, pz = PRED.z[i]!;
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) break;
      if (!proj.pitchToScreen(px, py, pz, SP)) break;
      if (!Number.isFinite(SP.x) || !Number.isFinite(SP.y)) break;
      st.previewX[c] = SP.x;
      st.previewY[c] = SP.y;
      c++;
    }
    return c;
  }
  /** Ball point, then one dot every trailSpacingPt along the finger path from the touch-down; returns the count. */
  function writeTrail(cap: number): number {
    writeBallPoint();
    let c = 1;
    const sp = LOCAL_TUNING.trailSpacingPt;
    let need = 0; // path length until the next dot (the touch-down point gets the first one)
    for (let i = 0; i < n && c < cap; i++) {
      if (i === 0) {
        st.previewX[c] = xs[0]!; st.previewY[c] = ys[0]!; c++;
        need = sp;
        continue;
      }
      const ax = xs[i - 1]!, ay = ys[i - 1]!;
      const dx = xs[i]! - ax, dy = ys[i]! - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 0)) continue;
      let at = need;
      while (at <= len && c < cap) {
        const f = at / len;
        st.previewX[c] = ax + dx * f;
        st.previewY[c] = ay + dy * f;
        c++;
        at += sp;
      }
      need = at - len;
    }
    return c;
  }
  /** Recompute the preview now (F_NOW). */
  function refresh(): void {
    F[F_PREV_T] = F[F_NOW]!;
    dirty = false;
    if (!tracking || voided) return;
    const cap = Math.min(st.previewX.length, st.previewY.length);
    if (cap < 1) { clearPreview(); return; }
    const kind = classifyCore(xs, ys, ts, n, cls, travel, 0);
    let c = 0;
    const s = simState();
    const proj = projector();
    if (s && proj && isSwipeKind(kind) && setPieceSwipeFrame(cls, proj, PF)) {
      computations++;
      // previewFlight never writes the state it is given (RUL-05: it runs on a private scratch copy).
      if (preview(s as unknown as SimState, PRED, PF) > 0 && PRED.count > 0) {
        c = writeFlight(proj, cap);
        if (c <= 1) c = 0;
      }
    }
    if (c > 0) {
      pkind = PreviewKind.FLIGHT;
    } else {
      c = writeTrail(cap);
      pkind = PreviewKind.TRAIL;
    }
    st.previewCount = c;
    arm();
  }
  /** Refresh when the throttle allows (moves since the last one, or the camera may have moved). */
  function due(): void {
    if (!tracking || voided) return;
    if (!contextOk()) { voidSwipe(); return; }
    if (F[F_NOW]! - F[F_PREV_T]! >= LOCAL_TUNING.previewEveryMs) refresh();
    else if (dirty) arm();
  }
  /** Context lost during the hold: hide the preview; the lift will do nothing. */
  function voidSwipe(): void {
    voided = true;
    dirty = false;
    cancelTimer();
    clearPreview();
  }
  /** Forget the swipe and its preview. */
  function release(): void {
    tracking = false;
    voided = false;
    dirty = false;
    n = 0;
    travel[0] = 0;
    cancelTimer();
    clearPreview();
  }

  function emit(kind: GestureKind): void {
    G.kind = kind;
    G.sx = cls.sx; G.sy = cls.sy; G.ex = cls.ex; G.ey = cls.ey;
    if (kind === GestureKind.TAP) {
      G.vx = 0; G.vy = 0; G.curve = 0;
    } else {
      G.vx = cls.vx; G.vy = cls.vy;
      G.curve = kind === GestureKind.BACK_FORTH_SWIPE ? 0 : cls.curve;
    }
    G.tMs = F[F_NOW]!;
    G.fromBall = true;
    queueGesture(st, G);
  }

  F[F_ID] = -1;

  return {
    get active() { return tracking && !voided; },
    get previewKind() { return pkind; },
    get previewComputations() { return computations; },
    hit(x, y) {
      if (tracking || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (st.mode !== ClusterMode.SET_PIECE || !clearOfEdges(y) || !contextOk()) return false;
      if (!ballPoint()) return false;
      const dx = x - BS.x, dy = y - BS.y;
      return dx * dx + dy * dy <= BALL2;
    },
    down(id, x, y, tMs) {
      if (tracking || !Number.isFinite(x) || !Number.isFinite(y)) return;
      n = 0;
      setNow(tMs);
      tracking = true;
      voided = false;
      dirty = false;
      travel[0] = 0;
      F[F_ID] = id;
      F[F_DOWN_T] = F[F_NOW]!;
      if (ballPoint()) { F[F_BX] = BS.x; F[F_BY] = BS.y; } else { F[F_BX] = x; F[F_BY] = y; }
      push(x, y);
      // The first move refreshes at once; until then the ball point is the pressed state.
      F[F_PREV_T] = F[F_NOW]! - LOCAL_TUNING.previewEveryMs;
      if (!contextOk()) { voidSwipe(); return; }
      showBallDot();
    },
    move(id, x, y, tMs) {
      if (!tracking || F[F_ID] !== id || !Number.isFinite(x) || !Number.isFinite(y)) return;
      setNow(tMs);
      push(x, y);
      if (voided) return;
      dirty = true;
      due();
    },
    up(id, x, y, tMs) {
      if (!tracking || F[F_ID] !== id) return;
      setNow(tMs);
      if (Number.isFinite(x) && Number.isFinite(y)) push(x, y);
      else pushLast();
      const ok = !voided && contextOk();
      const kind = ok ? classifyCore(xs, ys, ts, n, cls, travel, 0) : GestureKind.NONE;
      release();
      if (kind === GestureKind.TAP || isSwipeKind(kind)) emit(kind);
    },
    cancel(id, tMs) {
      if (!tracking || F[F_ID] !== id) return;
      setNow(tMs);
      release();
    },
    releaseAll(tMs) {
      setNow(tMs);
      release();
    },
    update(tMs) {
      if (!tracking || voided) return;
      setNow(tMs);
      due();
    },
  };
}

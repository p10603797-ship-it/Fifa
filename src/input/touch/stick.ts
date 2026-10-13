/**
 * [TCH-02] Floating virtual stick (section 9 "Layout", the strafe note under "Attack buttons", "Touch quality bar").
 *  - Zone: the left half of the screen (the right half when mirrored for left-handers). The stick appears where the
 *    thumb lands (floating stick, TouchSettings.floatingStick, the default) or sits at a fixed origin (fixed stick,
 *    placed by the controls editor under TouchSettings.layout[STICK_LAYOUT_KEY]).
 *  - Vector = (thumb - origin) / radius with a radial dead zone (rescaled, so deflection starts at 0) and a radial
 *    clamp: partial tilt jogs, full tilt runs. Written to TouchIntentState.stickX / stickY (screen space, -1..1,
 *    y down) together with the origin and thumb positions for the overlay on every touch-down and move.
 *  - Drag-along (floating stick only): once the thumb is more than LOCAL_TUNING.followMul (1.4) radii from the origin
 *    the origin is pulled after it and stays exactly that far behind, so long pushes keep working and a reversal
 *    never needs more than followMul + 1 radii of travel. The overlay clamps the knob to the rim.
 *  - Double-tap and hold: a tap on the stick (at most T_TOUCHUI.tapMaxMs long, at most T_TOUCHUI.tapMaxPt of travel)
 *    followed by a touch-down within T_TOUCHUI.doubleTapMs (down to down) and within LOCAL_TUNING.doubleTapSlopMul
 *    radii of the tap sets stickStrafe for as long as that second touch is held (face-up strafe dribble; the mapper
 *    turns it into the strafe modifier). A lift-and-replant after a real push is not a tap and never strafes.
 *  - Release: up, cancel (pointercancel / lost capture) and releaseAll (blur, visibilitychange, pause) set
 *    stickActive false, stickX / stickY 0 and stickStrafe false at once. A cancelled touch never counts as the first
 *    tap of a double tap; releaseAll forgets a pending tap.
 *  - The stick never starts inside the system-gesture margins (T_TOUCHUI.systemEdgeMargin from the bottom and top
 *    edges of the safe area) or outside the safe area; anywhere else in its zone is fine (inStickZone). A fixed stick
 *    claims only touches within LOCAL_TUNING.fixedCatchMul radii of its origin; the rest of the half stays free for
 *    pitch gestures.
 *  - One pointer drives the stick. Further pointers that land in the zone while it is held are claimed and ignored:
 *    they never steal the stick and never become pitch gestures inside the stick zone.
 * Wiring (TCH-07, index.ts): pass `config: () => cfg` and keep `cfg` up to date with computeStickConfig() on every
 * relayout. Without a config the stick is floating, `zone` alone picks the half, and the window height (when there is
 * a window) still keeps touch-downs out of the system-gesture margins.
 * No allocation per pointer event: all scratch lives in the closure.
 */

import type { TouchSettings } from '../../contracts/settings';
import type { TouchControl, TouchIntentState } from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';

/** Stick feel constants (TUNING-CR: candidates for T_TOUCHUI). */
export const LOCAL_TUNING = {
  /** Radial dead zone, fraction of the radius (0..1). Deflection is rescaled to start at 0 just past it. */
  deadZone: 0.12,
  /** Floating origin is dragged along once the thumb is further than this from it, x radius. */
  followMul: 1.4,
  /** Fixed stick: touch-downs within this distance of the fixed origin are claimed, x radius. */
  fixedCatchMul: 2,
  /** Fixed stick default centre: offset from the safe-area left edge (right edge when mirrored), pt. */
  fixedDx: 160,
  /** Fixed stick default centre: offset from the safe-area bottom edge, pt. */
  fixedDy: 150,
  /** Double tap: the second touch-down must land within this distance of the first, x radius. */
  doubleTapSlopMul: 1,
  /** Size multiplier range of the editor's stick placement (ControlPlacement.scale). */
  scaleMin: 0.7,
  scaleMax: 1.4,
} as const; // TUNING-CR

/** Radial dead zone of the touch stick (fraction of the radius). */
export const STICK_DEAD_ZONE = LOCAL_TUNING.deadZone;

/** Key of the stick's ControlPlacement in TouchSettings.layout (the buttons use their TouchButtonId as the key). */
export const STICK_LAYOUT_KEY = 'stick';

/**
 * Stick vector for a thumb at (tx, ty) relative to the origin (ox, oy), radius r (CSS px): radial dead zone `dead`
 * rescaled, magnitude clamped to 1. Screen space (y down). Writes out.x / out.y. Pure.
 */
export function computeStick(ox: number, oy: number, tx: number, ty: number, r: number, dead: number, out: { x: number; y: number }): void {
  const dx = tx - ox, dy = ty - oy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const m = d / Math.max(1, r);
  if (!(m > dead) || !Number.isFinite(m)) { out.x = 0; out.y = 0; return; }
  const scaled = Math.min(1, (m - dead) / (1 - dead));
  out.x = (dx / d) * scaled;
  out.y = (dy / d) * scaled;
}

/**
 * Drag the origin toward the thumb so it never lies further than `r` away (the leash; createStick passes
 * LOCAL_TUNING.followMul x radius). Writes out.x / out.y (new origin). Pure.
 */
export function followOrigin(ox: number, oy: number, tx: number, ty: number, r: number, out: { x: number; y: number }): void {
  const dx = tx - ox, dy = ty - oy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > r)) { out.x = ox; out.y = oy; return; }
  const k = (d - r) / d;
  out.x = ox + dx * k;
  out.y = oy + dy * k;
}

/** Safe-area insets, CSS px (PlatformInfo.safeArea()). */
export interface StickInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Live stick settings and viewport geometry (computeStickConfig fills it; the stick reads it on every touch-down). */
export interface StickConfig {
  /** Floating (origin where the thumb lands) or fixed (origin at fixedX / fixedY). */
  floating: boolean;
  /** Left-handed layout: the stick zone is the right half. */
  mirror: boolean;
  /** Stick radius, CSS px (T_TOUCHUI.stickRadius x the editor's size). The overlay draws the base with it. */
  radius: number;
  /** Viewport, CSS px. 0 = unknown: no viewport checks, and a fixed stick behaves as a floating one. */
  width: number;
  height: number;
  /** Safe-area insets, CSS px. */
  safeTop: number;
  safeRight: number;
  safeBottom: number;
  safeLeft: number;
  /** Fixed-stick origin, CSS px (kept inside the half, the safe area and clear of the system-gesture margins). */
  fixedX: number;
  fixedY: number;
}

export function createStickConfig(): StickConfig {
  return {
    floating: true, mirror: false, radius: T_TOUCHUI.stickRadius, width: 0, height: 0,
    safeTop: 0, safeRight: 0, safeBottom: 0, safeLeft: 0, fixedX: 0, fixedY: 0,
  };
}

const finiteOr = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampLo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Fill `out` from the viewport (w x h CSS px), the safe-area insets and the touch settings: floating or fixed,
 * mirror, radius (T_TOUCHUI.stickRadius x layout[STICK_LAYOUT_KEY].scale, clamped 0.7..1.4) and the fixed origin.
 * Placement: dx = centre offset from the safe-area left edge (right edge when mirrored), dy = centre offset from the
 * safe-area bottom edge, pt (defaults LOCAL_TUNING.fixedDx / fixedDy). The fixed ring is kept inside its half and
 * the safe area, T_TOUCHUI.systemEdgeMargin clear of the top and bottom edges. Pure (no allocation).
 */
export function computeStickConfig(
  w: number, h: number, safe: Readonly<StickInsets>,
  touch: Readonly<Pick<TouchSettings, 'floatingStick' | 'mirror' | 'layout'>>,
  out: StickConfig = createStickConfig(),
): StickConfig {
  out.width = Math.max(0, finiteOr(w, 0));
  out.height = Math.max(0, finiteOr(h, 0));
  out.safeTop = Math.max(0, finiteOr(safe.top, 0));
  out.safeRight = Math.max(0, finiteOr(safe.right, 0));
  out.safeBottom = Math.max(0, finiteOr(safe.bottom, 0));
  out.safeLeft = Math.max(0, finiteOr(safe.left, 0));
  out.floating = touch.floatingStick !== false;
  out.mirror = touch.mirror === true;
  const place = touch.layout ? touch.layout[STICK_LAYOUT_KEY] : undefined;
  const scale = clampLo(finiteOr(place?.scale, 1), LOCAL_TUNING.scaleMin, LOCAL_TUNING.scaleMax);
  const r = T_TOUCHUI.stickRadius * scale;
  out.radius = r;
  const dx = finiteOr(place?.dx, LOCAL_TUNING.fixedDx);
  const dy = finiteOr(place?.dy, LOCAL_TUNING.fixedDy);
  const W = out.width, H = out.height, m = T_TOUCHUI.systemEdgeMargin;
  const half = W / 2;
  const cx = out.mirror ? W - out.safeRight - dx : out.safeLeft + dx;
  const loX = out.mirror ? Math.max(half, out.safeLeft) + r : out.safeLeft + r;
  const hiX = out.mirror ? W - out.safeRight - r : Math.min(half, W - out.safeRight) - r;
  out.fixedX = clampLo(cx, loX, hiX);
  out.fixedY = clampLo(H - out.safeBottom - dy, out.safeTop + m + r, H - out.safeBottom - m - r);
  return out;
}

/** True when y is clear of the system-gesture margins (T_TOUCHUI.systemEdgeMargin inside the safe area, top and bottom). */
export function clearOfSystemEdges(y: number, h: number, safeTop: number, safeBottom: number): boolean {
  const m = T_TOUCHUI.systemEdgeMargin;
  return y >= safeTop + m && y <= h - safeBottom - m;
}

/**
 * May the stick start at (x, y)? Its half (left, right when mirrored), inside the safe area, clear of the
 * system-gesture margins; a fixed stick also needs the touch within LOCAL_TUNING.fixedCatchMul radii of its origin.
 * With an unknown viewport (width or height 0) every finite point qualifies. Pure.
 */
export function inStickZone(cfg: Readonly<StickConfig>, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const w = cfg.width, h = cfg.height;
  if (!(w > 0 && h > 0)) return true;
  if (!clearOfSystemEdges(y, h, cfg.safeTop, cfg.safeBottom)) return false;
  if (x < cfg.safeLeft || x > w - cfg.safeRight) return false;
  if (cfg.mirror ? x < w / 2 : x >= w / 2) return false;
  if (!cfg.floating && Number.isFinite(cfg.fixedX) && Number.isFinite(cfg.fixedY)) {
    const c = LOCAL_TUNING.fixedCatchMul * Math.max(1, finiteOr(cfg.radius, T_TOUCHUI.stickRadius));
    const dx = x - cfg.fixedX, dy = y - cfg.fixedY;
    return dx * dx + dy * dy <= c * c;
  }
  return true;
}

export interface StickOptions {
  state: TouchIntentState;
  /** Claim pointers that land here (left half, outside other controls). */
  zone(x: number, y: number): boolean;
  /** Radius in CSS px (T_TOUCHUI.stickRadius by default). Overridden by config().radius when a config is given. */
  radius?: number;
  /**
   * Live settings and geometry (floating / fixed, mirror, viewport, safe area, radius), read on hit and touch-down;
   * a touch keeps the values it started with until it lifts. Without it: floating, `zone` alone picks the half.
   */
  config?: () => Readonly<StickConfig>;
}

export interface StickControl extends TouchControl {
  /** Pointer id driving the stick, -1 when idle. */
  readonly pointerId: number;
  /** Radius in use (CSS px): the active touch's, else the configured one. */
  readonly radius: number;
}

/** Viewport height from the window when there is one (browser), else 0 (Node tests). */
function windowHeight(): number {
  const h = (globalThis as { innerHeight?: unknown }).innerHeight;
  return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

export function createStick(opts: StickOptions): StickControl {
  const st = opts.state;
  const baseR = Math.max(1, finiteOr(opts.radius, T_TOUCHUI.stickRadius));
  const radiusOf = (cfg: Readonly<StickConfig> | null): number => (cfg ? Math.max(1, finiteOr(cfg.radius, baseR)) : baseR);
  let pid = -1;
  /** Current touch: radius, floating, down time / point, max squared travel, is the hold of a double tap. */
  let r = baseR;
  let floating = true;
  let downT = 0, downX = 0, downY = 0, travel2 = 0;
  let strafeTouch = false;
  /** Last completed tap (first half of a double tap). */
  let tapPending = false, tapT = 0, tapX = 0, tapY = 0;
  const v = { x: 0, y: 0 };
  const o = { x: 0, y: 0 };

  function apply(x: number, y: number): void {
    if (floating) {
      followOrigin(st.stickOriginX, st.stickOriginY, x, y, LOCAL_TUNING.followMul * r, o);
      st.stickOriginX = o.x;
      st.stickOriginY = o.y;
    }
    st.stickThumbX = x;
    st.stickThumbY = y;
    computeStick(st.stickOriginX, st.stickOriginY, x, y, r, STICK_DEAD_ZONE, v);
    st.stickX = v.x;
    st.stickY = v.y;
  }
  function track(x: number, y: number): void {
    const dx = x - downX, dy = y - downY;
    const d2 = dx * dx + dy * dy;
    if (d2 > travel2) travel2 = d2;
  }
  function reset(): void {
    pid = -1;
    strafeTouch = false;
    st.stickActive = false;
    st.stickX = 0;
    st.stickY = 0;
    st.stickStrafe = false;
    st.stickThumbX = st.stickOriginX;
    st.stickThumbY = st.stickOriginY;
  }

  return {
    get pointerId() { return pid; },
    get radius() { return pid !== -1 ? r : radiusOf(opts.config ? opts.config() : null); },
    hit(x, y) {
      if (!opts.zone(x, y)) return false;
      if (opts.config) return inStickZone(opts.config(), x, y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const h = windowHeight();
      return !(h > 0) || clearOfSystemEdges(y, h, 0, 0);
    },
    down(id, x, y, tMs) {
      if (pid !== -1 || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const cfg = opts.config ? opts.config() : null;
      r = radiusOf(cfg);
      floating = !cfg || cfg.floating || !(cfg.width > 0 && cfg.height > 0) ||
        !Number.isFinite(cfg.fixedX) || !Number.isFinite(cfg.fixedY);
      pid = id;
      // Double tap: this down follows a tap closely in time and place -> strafe while this touch is held.
      const sdx = x - tapX, sdy = y - tapY, slop = LOCAL_TUNING.doubleTapSlopMul * r;
      strafeTouch = tapPending && tMs >= tapT && tMs - tapT <= T_TOUCHUI.doubleTapMs && sdx * sdx + sdy * sdy <= slop * slop;
      tapPending = false;
      downT = tMs; downX = x; downY = y; travel2 = 0;
      st.stickActive = true;
      st.stickStrafe = strafeTouch;
      st.stickOriginX = floating ? x : cfg!.fixedX;
      st.stickOriginY = floating ? y : cfg!.fixedY;
      apply(x, y);
    },
    move(id, x, y) {
      if (id !== pid || !Number.isFinite(x) || !Number.isFinite(y)) return;
      track(x, y);
      apply(x, y);
    },
    up(id, x, y, tMs) {
      if (id !== pid) return;
      if (Number.isFinite(x) && Number.isFinite(y)) track(x, y);
      const maxT = T_TOUCHUI.tapMaxPt;
      tapPending = !strafeTouch && tMs >= downT && tMs - downT <= T_TOUCHUI.tapMaxMs && travel2 <= maxT * maxT;
      tapT = downT; tapX = downX; tapY = downY;
      reset();
    },
    cancel(id) {
      if (id !== pid) return;
      tapPending = false;
      reset();
    },
    releaseAll() {
      tapPending = false;
      reset();
    },
  };
}

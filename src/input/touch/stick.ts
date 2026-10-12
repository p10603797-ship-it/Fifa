/**
 * [TCH-02] Floating virtual stick (section 9 "Layout"): in the left half of the screen, appears where the thumb
 * lands; deflection is analogue (partial tilt jogs, full tilt runs); releasing it stops the player. Writes
 * TouchIntentState.stickActive / stickX / stickY (screen space, -1..1, y down, dead-zoned and radially clamped)
 * and the origin/thumb positions for the overlay. When the thumb travels past the radius the origin is dragged
 * along so reversing direction is instant. Double-tap-and-hold for strafe dribble is TCH-02 work.
 *
 * WAVE 0 BASELINE (FND-05). TCH-02 owns and refines it.
 */

import type { TouchControl, TouchIntentState } from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';

/** Radial dead zone of the touch stick (fraction of the radius). */
export const STICK_DEAD_ZONE = 0.12;

/**
 * Stick vector for a thumb at (tx, ty) relative to the origin (ox, oy), radius r (CSS px): radial dead zone `dead`
 * rescaled, magnitude clamped to 1. Screen space (y down). Writes out.x / out.y. Pure.
 */
export function computeStick(ox: number, oy: number, tx: number, ty: number, r: number, dead: number, out: { x: number; y: number }): void {
  const dx = tx - ox, dy = ty - oy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const m = d / Math.max(1, r);
  if (!(m > dead)) { out.x = 0; out.y = 0; return; }
  const scaled = Math.min(1, (m - dead) / (1 - dead));
  out.x = (dx / d) * scaled;
  out.y = (dy / d) * scaled;
}

/** Drag the origin toward the thumb so it never lies further than r away. Writes out.x / out.y (new origin). Pure. */
export function followOrigin(ox: number, oy: number, tx: number, ty: number, r: number, out: { x: number; y: number }): void {
  const dx = tx - ox, dy = ty - oy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r) { out.x = ox; out.y = oy; return; }
  const k = (d - r) / d;
  out.x = ox + dx * k;
  out.y = oy + dy * k;
}

export interface StickOptions {
  state: TouchIntentState;
  /** Claim pointers that land here (left half, outside other controls). */
  zone(x: number, y: number): boolean;
  /** Radius in CSS px (T_TOUCHUI.stickRadius by default). */
  radius?: number;
}

export interface StickControl extends TouchControl {
  /** Pointer id driving the stick, -1 when idle. */
  readonly pointerId: number;
}

export function createStick(opts: StickOptions): StickControl {
  const st = opts.state;
  const r = opts.radius ?? T_TOUCHUI.stickRadius;
  let pid = -1;
  const v = { x: 0, y: 0 };
  const o = { x: 0, y: 0 };

  function apply(x: number, y: number): void {
    followOrigin(st.stickOriginX, st.stickOriginY, x, y, r, o);
    st.stickOriginX = o.x;
    st.stickOriginY = o.y;
    st.stickThumbX = x;
    st.stickThumbY = y;
    computeStick(st.stickOriginX, st.stickOriginY, x, y, r, STICK_DEAD_ZONE, v);
    st.stickX = v.x;
    st.stickY = v.y;
  }
  function reset(): void {
    pid = -1;
    st.stickActive = false;
    st.stickX = 0;
    st.stickY = 0;
    st.stickStrafe = false;
  }

  return {
    get pointerId() { return pid; },
    hit: (x, y) => opts.zone(x, y),
    down(id, x, y) {
      if (pid !== -1) return;
      pid = id;
      st.stickActive = true;
      st.stickOriginX = x;
      st.stickOriginY = y;
      apply(x, y);
    },
    move(id, x, y) {
      if (id === pid) apply(x, y);
    },
    up(id) {
      if (id === pid) reset();
    },
    cancel(id) {
      if (id === pid) reset();
    },
    releaseAll() {
      reset();
    },
  };
}

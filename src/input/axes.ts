/**
 * Shared device-side axis helpers. [FND-05 helper, frozen with the input skeleton; used by touch (TCH-07),
 * pads (PAD-02) and keyboard (PAD-08)].
 *
 * Screen/stick space: x right, y down (Gamepad API "up" is negative y; touch y grows downward).
 * Pitch space (contracts/input.ts): +x toward the right of the broadcast camera, +z toward the camera.
 * CameraProjector.stickRotation() rotates screen axes into pitch axes (0 for the broadcast camera:
 * stick right -> +x, stick down -> +z, stick up -> -z; DECISIONS D-011).
 */

import { AXIS_SCALE, type CameraProjector, type InputFrame } from '../contracts/input';

/** Radial dead zone: magnitude below `inner` -> 0; inner..outer rescaled to 0..1; above outer -> 1. Writes out.x/out.y. */
export function radialDeadZone(x: number, y: number, inner: number, outer: number, out: { x: number; y: number }): void {
  const m = Math.sqrt(x * x + y * y);
  if (!(m > inner) || !Number.isFinite(m)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const span = Math.max(1e-6, outer - inner);
  const scaled = Math.min(1, (m - inner) / span);
  const k = scaled / m;
  out.x = x * k;
  out.y = y * k;
}

/**
 * Quantise a stick vector (each component -1..1, magnitude clamped to 1) to InputFrame axes so that the integer
 * magnitude never exceeds AXIS_SCALE (radial). Writes out.qx / out.qy.
 */
export function quantStick(x: number, y: number, out: { qx: number; qy: number }): void {
  let fx = Number.isFinite(x) ? x : 0;
  let fy = Number.isFinite(y) ? y : 0;
  const m = Math.sqrt(fx * fx + fy * fy);
  if (m > 1) { fx /= m; fy /= m; }
  let qx = Math.round(fx * AXIS_SCALE);
  let qy = Math.round(fy * AXIS_SCALE);
  const lim = AXIS_SCALE * AXIS_SCALE;
  while (qx * qx + qy * qy > lim) {
    if (Math.abs(qx) >= Math.abs(qy)) qx -= Math.sign(qx); else qy -= Math.sign(qy);
  }
  out.qx = qx === 0 ? 0 : qx; // normalise -0
  out.qy = qy === 0 ? 0 : qy;
}

/** Rotate a screen-space stick (x right, y down) into pitch space using the camera's stick rotation (radians). */
export function screenToPitchAxes(sx: number, sy: number, rot: number, out: { x: number; y: number }): void {
  if (rot === 0) {
    out.x = sx;
    out.y = sy;
    return;
  }
  const c = Math.cos(rot), s = Math.sin(rot);
  out.x = c * sx - s * sy;
  out.y = s * sx + c * sy;
}

const tmpRot = { x: 0, y: 0 };
const tmpQ = { qx: 0, qy: 0 };

/** Screen-space stick (-1..1, y down) -> quantised pitch movement axes out.mx / out.mz. No allocation. */
export function writeMoveAxes(out: InputFrame, sx: number, sy: number, projector: CameraProjector | null): void {
  screenToPitchAxes(sx, sy, projector ? projector.stickRotation() : 0, tmpRot);
  quantStick(tmpRot.x, tmpRot.y, tmpQ);
  out.mx = tmpQ.qx;
  out.mz = tmpQ.qy;
}

/** Screen-space stick (-1..1, y down) -> quantised pitch aim axes out.ax / out.az. No allocation. */
export function writeAimAxes(out: InputFrame, sx: number, sy: number, projector: CameraProjector | null): void {
  screenToPitchAxes(sx, sy, projector ? projector.stickRotation() : 0, tmpRot);
  quantStick(tmpRot.x, tmpRot.y, tmpQ);
  out.ax = tmpQ.qx;
  out.az = tmpQ.qy;
}

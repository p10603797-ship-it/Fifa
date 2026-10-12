/**
 * Shared camera projection maths for CameraProjector implementations (GFX-14 broadcast, GFX-15 cinematic).
 * [FND-05 helper, frozen with render/types.ts]. Works on any PerspectiveCamera whose matrices are current
 * (call camera.updateMatrixWorld() after moving it). No allocation: module-level scratch vectors.
 * Screen coordinates are CSS pixels (y down) over a viewport of cssW x cssH.
 */

import { Vector3, type PerspectiveCamera } from 'three';

const v = new Vector3();
const origin = new Vector3();
const dir = new Vector3();

/** Screen CSS px -> ground-plane (y = 0) point. False when the ray does not hit the ground in front of the camera. */
export function projectScreenToPitch(cam: PerspectiveCamera, cssW: number, cssH: number, sx: number, sy: number, out: { x: number; z: number }): boolean {
  const w = Math.max(1, cssW), h = Math.max(1, cssH);
  origin.setFromMatrixPosition(cam.matrixWorld);
  dir.set((sx / w) * 2 - 1, -((sy / h) * 2 - 1), 0.5).unproject(cam).sub(origin);
  if (dir.y > -1e-6) return false;
  const t = -origin.y / dir.y;
  out.x = origin.x + dir.x * t;
  out.z = origin.z + dir.z * t;
  return true;
}

/** World point -> screen CSS px. False when the point is behind (or closer than the near plane to) the camera. */
export function projectPitchToScreen(cam: PerspectiveCamera, cssW: number, cssH: number, x: number, y: number, z: number, out: { x: number; y: number }): boolean {
  v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
  if (v.z > -cam.near) return false;
  v.applyMatrix4(cam.projectionMatrix);
  out.x = (v.x + 1) * 0.5 * cssW;
  out.y = (1 - v.y) * 0.5 * cssH;
  return true;
}

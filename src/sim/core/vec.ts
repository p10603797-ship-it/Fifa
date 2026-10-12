/**
 * Allocation-free 2D/3D vector helpers on plain objects. [FND-03]
 * Use module-level scratch vectors created once (createV2/createV3), never allocate per tick.
 *
 * Angles follow dmath.angleOf: angle(x, z) = datan2(z, x), so rotating +x by +angle turns toward +z
 * (seen from above, +y). Facing +x a player's right is +z, so a positive angle turns right.
 */
import { PI, dcos, dsin } from './dmath';

export interface V2 { x: number; z: number }
export interface V3 { x: number; y: number; z: number }

export function createV2(x = 0, z = 0): V2 { return { x, z }; }
export function createV3(x = 0, y = 0, z = 0): V3 { return { x, y, z }; }
export function setV2(o: V2, x: number, z: number): V2 { o.x = x; o.z = z; return o; }
export function setV3(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }

/** Normalise (x, z) into o; returns the original length (0 leaves o = (0,0)). */
export function normalize2(o: V2, x: number, z: number): number {
  const len = Math.sqrt(x * x + z * z);
  if (len > 0) {
    o.x = x / len;
    o.z = z / len;
  } else {
    o.x = 0;
    o.z = 0;
  }
  return len;
}

/** Rotate (x, z) by angle (radians, deterministic trig) into o. o may alias the input object. */
export function rotate2(o: V2, x: number, z: number, angle: number): V2 {
  const c = dcos(angle);
  const s = dsin(angle);
  o.x = x * c - z * s;
  o.z = x * s + z * c;
  return o;
}

/**
 * Rotate unit vector (fx, fz) toward (tx, tz) by at most maxAngle radians into o (unit result).
 * - Never overshoots: when the target is within maxAngle the result is exactly the normalised target.
 * - Exactly opposite vectors (cross product 0) turn by +maxAngle (toward +z from +x, i.e. to the right).
 * - A zero target leaves the (normalised) facing; a zero facing snaps to the target; both zero -> (1, 0).
 * - maxAngle <= 0 keeps the facing; maxAngle >= PI always reaches the target.
 */
export function rotateToward2(o: V2, fx: number, fz: number, tx: number, tz: number, maxAngle: number): V2 {
  const tl = Math.sqrt(tx * tx + tz * tz);
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (tl === 0) {
    if (fl === 0) { o.x = 1; o.z = 0; } else { o.x = fx / fl; o.z = fz / fl; }
    return o;
  }
  const ux = tx / tl;
  const uz = tz / tl;
  if (fl === 0) { o.x = ux; o.z = uz; return o; }
  const nx = fx / fl;
  const nz = fz / fl;
  if (!(maxAngle > 0)) { o.x = nx; o.z = nz; return o; }
  const dot = nx * ux + nz * uz;
  const c = dcos(maxAngle);
  if (maxAngle >= PI || dot >= c) { o.x = ux; o.z = uz; return o; }
  // Turn by maxAngle toward the target side (cross > 0: target is at a positive angle from the facing).
  const cross = nx * uz - nz * ux;
  const s = cross >= 0 ? dsin(maxAngle) : -dsin(maxAngle);
  const rx = nx * c - nz * s;
  const rz = nx * s + nz * c;
  const rl = Math.sqrt(rx * rx + rz * rz);
  o.x = rx / rl;
  o.z = rz / rl;
  return o;
}

export function dot2(ax: number, az: number, bx: number, bz: number): number { return ax * bx + az * bz; }
/**
 * 2D cross (ax*bz - az*bx). Positive when b is at a positive angle from a (datan2 convention), i.e. b is
 * clockwise from a seen from above (+y) with +x right and +z down the screen; facing a, b lies to the right.
 */
export function cross2(ax: number, az: number, bx: number, bz: number): number { return ax * bz - az * bx; }

/** Closest point on segment a-b to p; returns t in [0,1] and writes the point into o. Degenerate a == b gives t = 0. */
export function closestOnSegment2(o: V2, ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > 0) {
    t = ((px - ax) * dx + (pz - az) * dz) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  if (t === 1) { o.x = bx; o.z = bz; } else { o.x = ax + dx * t; o.z = az + dz * t; }
  return t;
}

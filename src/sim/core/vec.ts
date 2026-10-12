/**
 * Allocation-free 2D/3D vector helpers on plain objects. [FND-03]
 * Use module-level scratch vectors created once (createV2/createV3), never allocate per tick.
 */
export interface V2 { x: number; z: number }
export interface V3 { x: number; y: number; z: number }

export function createV2(x = 0, z = 0): V2 { return { x, z }; }
export function createV3(x = 0, y = 0, z = 0): V3 { return { x, y, z }; }
export function setV2(o: V2, x: number, z: number): V2 { o.x = x; o.z = z; return o; }
export function setV3(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }
/** Normalise (x, z) into o; returns the original length (0 leaves o = (0,0)). */
export function normalize2(o: V2, x: number, z: number): number { throw new Error('FND-03'); }
/** Rotate (x, z) by angle (radians, deterministic trig) into o. */
export function rotate2(o: V2, x: number, z: number, angle: number): V2 { throw new Error('FND-03'); }
/** Rotate unit vector (fx, fz) toward (tx, tz) by at most maxAngle radians into o (unit result). */
export function rotateToward2(o: V2, fx: number, fz: number, tx: number, tz: number, maxAngle: number): V2 { throw new Error('FND-03'); }
export function dot2(ax: number, az: number, bx: number, bz: number): number { return ax * bx + az * bz; }
/** 2D cross (ax*bz - az*bx). Positive when b is clockwise from a seen from above (+y)... see doc in FND-03 tests. */
export function cross2(ax: number, az: number, bx: number, bz: number): number { return ax * bz - az * bx; }
/** Closest point on segment a-b to p; returns t in [0,1] and writes the point into o. */
export function closestOnSegment2(o: V2, ax: number, az: number, bx: number, bz: number, px: number, pz: number): number { throw new Error('FND-03'); }

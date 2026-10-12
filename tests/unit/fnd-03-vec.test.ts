/** FND-03: allocation-free vector helpers. */
import { describe, expect, it } from 'vitest';
import { HALF_PI, PI, angleOf, dcos, dsin } from '../../src/sim/core/dmath';
import { closestOnSegment2, createV2, cross2, dot2, normalize2, rotate2, rotateToward2 } from '../../src/sim/core/vec';

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const close = (a: number, b: number, eps = 1e-12): boolean => Math.abs(a - b) <= eps;

describe('normalize2', () => {
  it('normalises and returns the original length', () => {
    const o = createV2();
    expect(normalize2(o, 3, 4)).toBe(5);
    expect(o).toEqual({ x: 0.6, z: 0.8 });
    expect(normalize2(o, 0, -2)).toBe(2);
    expect(o).toEqual({ x: 0, z: -1 });
  });

  it('zero vector leaves (0,0) and returns 0', () => {
    const o = createV2(5, 5);
    expect(normalize2(o, 0, 0)).toBe(0);
    expect(o).toEqual({ x: 0, z: 0 });
  });

  it('results are unit length', () => {
    const rnd = lcg(1);
    const o = createV2();
    for (let i = 0; i < 1000; i++) {
      const x = (rnd() - 0.5) * 200, z = (rnd() - 0.5) * 200;
      normalize2(o, x, z);
      expect(close(Math.sqrt(o.x * o.x + o.z * o.z), 1, 1e-15)).toBe(true);
    }
  });
});

describe('rotate2', () => {
  it('rotates +x toward +z for positive angles (angleOf convention)', () => {
    const o = createV2();
    rotate2(o, 1, 0, HALF_PI);
    expect(close(o.x, 0) && close(o.z, 1)).toBe(true);
    rotate2(o, 1, 0, PI);
    expect(close(o.x, -1) && close(o.z, 0)).toBe(true);
    rotate2(o, 2, 0, 0.3);
    expect(close(angleOf(o.x, o.z), 0.3) && close(Math.hypot(o.x, o.z), 2)).toBe(true);
  });

  it('matches the rotation matrix and allows aliasing', () => {
    const rnd = lcg(2);
    const o = createV2();
    for (let i = 0; i < 1000; i++) {
      const x = rnd() - 0.5, z = rnd() - 0.5, a = (rnd() - 0.5) * 20;
      rotate2(o, x, z, a);
      expect(close(o.x, x * Math.cos(a) - z * Math.sin(a))).toBe(true);
      expect(close(o.z, x * Math.sin(a) + z * Math.cos(a))).toBe(true);
    }
    const v = createV2(1, 0);
    rotate2(v, v.x, v.z, HALF_PI);
    expect(close(v.x, 0) && close(v.z, 1)).toBe(true);
  });
});

describe('rotateToward2', () => {
  it('snaps exactly to the (normalised) target when within maxAngle', () => {
    const o = createV2();
    rotateToward2(o, 1, 0, 0, 2, HALF_PI + 1e-9);
    expect(o).toEqual({ x: 0, z: 1 });
    rotateToward2(o, 1, 0, 3, 4, 1);
    expect(o).toEqual({ x: 0.6, z: 0.8 });
  });

  it('turns by exactly maxAngle toward the shorter side, never overshooting', () => {
    const rnd = lcg(3);
    const o = createV2();
    for (let i = 0; i < 5000; i++) {
      const fa = (rnd() * 2 - 1) * PI, ta = (rnd() * 2 - 1) * PI, max = rnd() * 0.5;
      const fx = dcos(fa), fz = dsin(fa), tx = dcos(ta) * 3, tz = dsin(ta) * 3;
      rotateToward2(o, fx, fz, tx, tz, max);
      expect(close(Math.hypot(o.x, o.z), 1, 1e-15)).toBe(true);
      let diff = ta - fa;
      while (diff > PI) diff -= 2 * PI;
      while (diff <= -PI) diff += 2 * PI;
      const turned = Math.atan2(fx * o.z - fz * o.x, fx * o.x + fz * o.z);
      if (Math.abs(diff) <= max) {
        expect(close(turned, diff, 1e-9)).toBe(true);
      } else {
        expect(close(Math.abs(turned), max, 1e-9)).toBe(true);
        expect(Math.sign(turned)).toBe(Math.sign(diff));
      }
    }
  });

  it('repeated application converges without overshoot or oscillation', () => {
    const o = createV2(1, 0);
    let steps = 0;
    while (!(o.x === 0 && o.z === -1) && steps < 100) {
      rotateToward2(o, o.x, o.z, 0, -1, 0.1);
      steps++;
    }
    expect(steps).toBe(16); // ceil((PI/2) / 0.1)
  });

  it('opposite vectors turn deterministically by +maxAngle (to the right, toward +z from +x)', () => {
    const o = createV2();
    rotateToward2(o, 1, 0, -1, 0, 0.5);
    expect(close(o.x, Math.cos(0.5)) && close(o.z, Math.sin(0.5))).toBe(true);
    rotateToward2(o, 0, 1, 0, -1, HALF_PI);
    expect(close(o.x, -1) && close(o.z, 0)).toBe(true);
  });

  it('degenerate inputs', () => {
    const o = createV2();
    rotateToward2(o, 2, 0, 0, 0, 1); // zero target keeps (normalised) facing
    expect(o).toEqual({ x: 1, z: 0 });
    rotateToward2(o, 0, 0, 0, 5, 0.1); // zero facing snaps to target
    expect(o).toEqual({ x: 0, z: 1 });
    rotateToward2(o, 0, 0, 0, 0, 0.1);
    expect(o).toEqual({ x: 1, z: 0 });
    rotateToward2(o, 0, 3, 1, 0, 0); // maxAngle 0 keeps facing
    expect(o).toEqual({ x: 0, z: 1 });
    rotateToward2(o, 0, 3, 1, 0, -1); // negative maxAngle keeps facing
    expect(o).toEqual({ x: 0, z: 1 });
    rotateToward2(o, 1, 0, -1, 1e-30, PI); // maxAngle >= PI always reaches the target
    expect(o.x).toBe(-1);
  });
});

describe('dot2 / cross2', () => {
  it('cross2 > 0 when b is at a positive angle from a', () => {
    expect(dot2(1, 2, 3, 4)).toBe(11);
    expect(cross2(1, 0, 0, 1)).toBe(1);
    expect(cross2(0, 1, 1, 0)).toBe(-1);
    expect(angleOf(0, 1) - angleOf(1, 0)).toBeGreaterThan(0);
  });
});

describe('closestOnSegment2', () => {
  it('projects inside the segment', () => {
    const o = createV2();
    expect(closestOnSegment2(o, 0, 0, 10, 0, 4, 3)).toBe(0.4);
    expect(o).toEqual({ x: 4, z: 0 });
  });

  it('clamps to the end points', () => {
    const o = createV2();
    expect(closestOnSegment2(o, 0, 0, 10, 0, -5, 1)).toBe(0);
    expect(o).toEqual({ x: 0, z: 0 });
    expect(closestOnSegment2(o, 1, 1, 4, 5, 100, 100)).toBe(1);
    expect(o).toEqual({ x: 4, z: 5 });
  });

  it('degenerate segment returns a with t = 0', () => {
    const o = createV2();
    expect(closestOnSegment2(o, 2, 3, 2, 3, 9, 9)).toBe(0);
    expect(o).toEqual({ x: 2, z: 3 });
  });

  it('the closest point is perpendicular to the segment for interior t', () => {
    const rnd = lcg(4);
    const o = createV2();
    for (let i = 0; i < 1000; i++) {
      const ax = rnd() * 10, az = rnd() * 10, bx = rnd() * 10, bz = rnd() * 10, px = rnd() * 10, pz = rnd() * 10;
      const t = closestOnSegment2(o, ax, az, bx, bz, px, pz);
      expect(t >= 0 && t <= 1).toBe(true);
      if (t > 0 && t < 1) expect(Math.abs((px - o.x) * (bx - ax) + (pz - o.z) * (bz - az))).toBeLessThan(1e-9);
    }
  });
});

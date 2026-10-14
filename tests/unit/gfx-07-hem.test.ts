/**
 * [GFX-07] Regression: "shorts teeth" through the shirt hem. With the hips flexed (running stride, keeper ready
 * stance), the tops of the thighs (shorts legs) used to cut through the lower shirt and show as jagged shorts-coloured
 * spikes above the hem (seen in the e2e keeper close-up). The thigh tops now taper inside the shirt and the shirt
 * front is fuller at the hem.
 *
 * Exact check: every sampled point of the real thigh triangles, placed by the real FK for a pose, is expressed in the
 * torso's (spine) frame; above the hem it must not lie outside the real torso surface (horizontal ray cast from the
 * torso axis against the torso triangles). The height above the hem of the highest outside point is the "teeth
 * height".
 */
import { describe, expect, it } from 'vitest';
import { createPose, PoseIdx } from '../../src/contracts/render';
import { createSkeleton, FRAME_SIZE, Joint, solvePoseFK } from '../../src/render/players/fk';
import { buildPartSoup, Part, TORSO_Y0 } from '../../src/render/players/parts';

const torso = buildPartSoup(Part.TORSO).pos;
const thigh = buildPartSoup(Part.UPPER_LEG).pos;

/** Distance from the torso axis (0, y, 0) to the torso surface along the horizontal direction (dx, dz); 0 = miss. */
function rayHit(y: number, dx: number, dz: number): number {
  let best = 0;
  for (let t = 0; t < torso.length; t += 9) {
    const ax = torso[t]!, ay = torso[t + 1]!, az = torso[t + 2]!;
    const e1x = torso[t + 3]! - ax, e1y = torso[t + 4]! - ay, e1z = torso[t + 5]! - az;
    const e2x = torso[t + 6]! - ax, e2y = torso[t + 7]! - ay, e2z = torso[t + 8]! - az;
    const px = -dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = -ax, sy = y - ay, sz = -az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const qy = sz * e1x - sx * e1z;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (d > best) best = d;
  }
  return best;
}

/** Torso surface radius at height y toward angle a (a ray through a vertex is retried slightly off it). */
function shirtRadius(y: number, a: number): number {
  for (const da of [0, 1e-4, -1e-4]) {
    const r = rayHit(y, Math.cos(a + da), Math.sin(a + da));
    if (r > 0) return r;
  }
  return 0;
}

/** Highest point (m above the hem) of the thigh surfaces outside the shirt for a pose. */
function teethHeight(set: (p: Float32Array) => void): number {
  const pose = createPose();
  set(pose);
  const sk = createSkeleton();
  solvePoseFK(pose, sk);
  const so = Joint.SPINE * FRAME_SIZE;
  const S = 6;
  let worst = 0;
  for (const j of [Joint.HIP_L, Joint.HIP_R]) {
    const o = j * FRAME_SIZE;
    for (let t = 0; t < thigh.length; t += 9) {
      for (let a = 0; a <= S; a++) {
        for (let b = 0; a + b <= S; b++) {
          const u = a / S, v = b / S, w = 1 - u - v;
          const lx = thigh[t]! * w + thigh[t + 3]! * u + thigh[t + 6]! * v;
          const ly = thigh[t + 1]! * w + thigh[t + 4]! * u + thigh[t + 7]! * v;
          const lz = thigh[t + 2]! * w + thigh[t + 5]! * u + thigh[t + 8]! * v;
          const dx = sk[o]! * lx + sk[o + 3]! * ly + sk[o + 6]! * lz + sk[o + 9]! - sk[so + 9]!;
          const dy = sk[o + 1]! * lx + sk[o + 4]! * ly + sk[o + 7]! * lz + sk[o + 10]! - sk[so + 10]!;
          const dz = sk[o + 2]! * lx + sk[o + 5]! * ly + sk[o + 8]! * lz + sk[o + 11]! - sk[so + 11]!;
          const tx = sk[so]! * dx + sk[so + 1]! * dy + sk[so + 2]! * dz;
          const ty = sk[so + 3]! * dx + sk[so + 4]! * dy + sk[so + 5]! * dz;
          const tz = sk[so + 6]! * dx + sk[so + 7]! * dy + sk[so + 8]! * dz;
          if (ty < TORSO_Y0 + 0.002 || ty > 0.3 || ty - TORSO_Y0 <= worst) continue;
          const r = Math.sqrt(tx * tx + tz * tz);
          if (r < 0.05) continue; // near the axis: inside any shirt cross-section
          const R = shirtRadius(ty, Math.atan2(tz, tx));
          expect(R, `torso ray at y ${ty.toFixed(3)}`).toBeGreaterThan(0);
          if (r > R + 0.001) worst = ty - TORSO_Y0;
        }
      }
    }
  }
  return worst;
}

const hips = (pitchL: number, pitchR: number, roll = 0) => (p: Float32Array): void => {
  p[PoseIdx.HIP_L_PITCH] = pitchL; p[PoseIdx.HIP_R_PITCH] = pitchR; p[PoseIdx.HIP_L_ROLL] = roll; p[PoseIdx.HIP_R_ROLL] = roll;
};

describe('GFX-07 glitch: shorts teeth through the shirt hem', () => {
  it('standing, walking and side steps: no thigh surface shows through the shirt', () => {
    expect(teethHeight(hips(0, 0))).toBe(0);
    expect(teethHeight(hips(0.3, -0.3))).toBe(0);
    expect(teethHeight(hips(0, 0, 0.3))).toBe(0);
  });

  it('keeper ready stance (the e2e close-up pose: crouch, lean, hips 0.45 rad, roll 0.15): under 1 cm', () => {
    const h = teethHeight((p) => {
      hips(0.45, 0.45, 0.15)(p);
      p[PoseIdx.ROOT_Y] = -0.16; p[PoseIdx.ROOT_PITCH] = 0.25; p[PoseIdx.KNEE_L] = 0.8; p[PoseIdx.KNEE_R] = 0.8;
    });
    expect(h).toBeLessThan(0.01);
  });

  it('running stride (hip +0.6 / -0.5 rad): at most a 2 cm sliver right at the hem', () => {
    expect(teethHeight(hips(0.6, -0.5))).toBeLessThan(0.02);
  });
});

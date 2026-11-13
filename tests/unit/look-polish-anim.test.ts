/**
 * [POLISH] Look review round 2, animation minors (render only):
 *  - item 1: the keeper creeping at 0.05..0.25 m/s steps (each boot leaves the grass) instead of gliding on the set
 *    position, and from 0.1 m/s a planted boot slides under 2 cm per contact;
 *  - item 6: idle, jockey and strafe hold the arms in (hands by the hips), not out wide.
 * Measured on the drawn pose (FK + ground snap with the gait's flight clearance), the cycle advancing with distance
 * as the mapper drives it.
 */
import { describe, expect, it } from 'vitest';
import { AnimId, createPose } from '../../src/contracts/render';
import { GAIT_AIR, LOCOMOTION_POSES, strideLengthFor } from '../../src/render/anim/locomotion';
import { footPoint, GROUND_AIR, handPoint } from '../../src/render/players/fk';

const TAU = Math.PI * 2;

/** Keeper ready moving along `dir` (fraction of a turn) at v m/s for `secs`: per boot the highest toe lift, and the
 *  largest slide of a planted toe (toe within 3 mm of the grass) over each contact after the first second. */
function creep(v: number, dir: number, secs = 8): { lift: number[]; slip: number } {
  const out = createPose();
  const o = [0, 0, 0];
  const a = dir * TAU, dx = Math.cos(a), dz = Math.sin(a);
  let cycle = 0, x = 0, slip = 0;
  const lift = [0, 0];
  const start: (number[] | null)[] = [null, null];
  for (let f = 0; f < 60 * secs; f++) {
    const d = v / 60;
    x += d;
    cycle = (cycle + (d / strideLengthFor(AnimId.KEEPER_READY, v)) * TAU) % TAU;
    LOCOMOTION_POSES[AnimId.KEEPER_READY]!(out, dir, cycle, v, 1, 0);
    for (let s = 0; s < 2; s++) {
      GROUND_AIR[0] = GAIT_AIR[0]!;
      footPoint(out, s === 0 ? 1 : -1, 1, o);
      GROUND_AIR[0] = 0;
      lift[s] = Math.max(lift[s]!, o[1]!);
      const wx = o[0]! + x * dx, wz = o[2]! + x * dz;
      if (o[1]! < 0.003) {
        const g = start[s];
        if (!g) start[s] = [wx, wz];
        else if (f > 60) slip = Math.max(slip, Math.hypot(wx - g[0]!, wz - g[1]!));
      } else start[s] = null;
    }
  }
  return { lift, slip };
}

describe('[POLISH] keeper creep and arm carriage', () => {
  it('the keeper creeping at 0.05..0.25 m/s steps with both boots; from 0.1 m/s planted boots slide < 2 cm', () => {
    for (const dir of [0, 0.25, 0.5]) for (const v of [0.05, 0.1, 0.15, 0.2, 0.25]) {
      const r = creep(v, dir);
      expect(Math.min(r.lift[0]!, r.lift[1]!), `boot lift at ${v} m/s, dir ${dir}`).toBeGreaterThan(0.008);
      if (v >= 0.1) expect(r.slip, `planted slide at ${v} m/s, dir ${dir}`).toBeLessThan(0.02);
    }
  });

  it('idle, strafe and jockey keep the hands in by the hips (not held out wide), clear of the shorts', () => {
    const o = [0, 0, 0];
    const p = createPose();
    const widest = (anim: AnimId, t: number, v: number): [number, number] => {
      let mx = 0, mn = 9;
      for (let k = 0; k < 16; k++) {
        LOCOMOTION_POSES[anim]!(p, anim === AnimId.IDLE ? k / 16 : t, (k / 16) * TAU, v, 1, 0);
        for (const s of [-1, 1]) { handPoint(p, s, o); mx = Math.max(mx, Math.abs(o[2]!)); mn = Math.min(mn, Math.abs(o[2]!)); }
      }
      return [mn, mx];
    };
    // Hand tips sideways from the body's centre line (m): the shorts reach about 0.19.
    for (const [anim, cap] of [[AnimId.IDLE, 0.33], [AnimId.STRAFE, 0.36], [AnimId.JOCKEY, 0.43]] as const) {
      for (const v of [0, 1, 2.5]) for (const t of [0, 0.25, 0.5]) {
        const [mn, mx] = widest(anim, t, v);
        expect(mx, `anim ${anim} at ${v} m/s`).toBeLessThan(cap);
        expect(mn, `anim ${anim} at ${v} m/s`).toBeGreaterThan(0.24);
      }
    }
  });
});

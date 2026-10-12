/**
 * SIM-01 ball flight: physics sanity (gravity, drag, Magnus, spin decay, integrator), the spin sign convention shared
 * with SIM-09 / SIM-11, and the reference feel numbers of BRIEF section 6 "Ball".
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT } from '../../src/contracts/constants';
import { createBallState, type BallState } from '../../src/contracts/state';
import { T_BALL, T_PASS, T_SHOT } from '../../src/contracts/tuning';
import { ballStepTick } from '../../src/sim/ball/contact';
import {
  ballAirStep, copyBallState, curlSpinY, DRAG_K, groundRollTime, launchSpin, MAGNUS_K, solveLaunch,
} from '../../src/sim/ball/flight';
import { dcos, dsin } from '../../src/sim/core/dmath';
import { createV3 } from '../../src/sim/core/vec';

/** A ball at (x, y, z) with velocity and spin. */
function ball(x: number, y: number, z: number, vx: number, vy: number, vz: number, sx = 0, sy = 0, sz = 0): BallState {
  const b = createBallState();
  b.x = x; b.y = y; b.z = z; b.px = x; b.py = y; b.pz = z;
  b.vx = vx; b.vy = vy; b.vz = vz; b.sx = sx; b.sy = sy; b.sz = sz;
  b.grounded = 0;
  return b;
}

/** Ground launch along +x at speed v and elevation th (rad). */
function launch(v: number, th: number, sx = 0, sy = 0, sz = 0): BallState {
  return ball(0, BALL_RADIUS, 0, v * dcos(th), v * dsin(th), 0, sx, sy, sz);
}

/** Air-only flight with ballAirStep at step dt until the centre comes back to BALL_RADIUS (interpolated). */
function airLanding(b: BallState, dt: number): { x: number; z: number; t: number; apex: number } {
  let t = 0;
  let apex = b.y;
  for (let i = 0; i < 100000; i++) {
    const px = b.x;
    const py = b.y;
    const pz = b.z;
    ballAirStep(b, dt);
    t += dt;
    if (b.y > apex) apex = b.y;
    if (b.y <= BALL_RADIUS && b.vy < 0) {
      const f = (py - BALL_RADIUS) / (py - b.y);
      return { x: px + (b.x - px) * f, z: pz + (b.z - pz) * f, t: t - dt * (1 - f), apex };
    }
  }
  throw new Error('never landed');
}

/** Specific mechanical energy (per unit mass). */
function energy(b: BallState): number {
  return 0.5 * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz) + T_BALL.gravity * b.y;
}

describe('SIM-01 physics sanity', () => {
  it('free fall from rest follows 1/2 g t^2 (drag only starts to matter)', () => {
    const b = ball(0, 50, 0, 0, 0, 0);
    for (let i = 0; i < 60; i++) ballAirStep(b, DT);
    const drop = 50 - b.y;
    expect(drop).toBeGreaterThan(0.5 * T_BALL.gravity * 0.97);
    expect(drop).toBeLessThan(0.5 * T_BALL.gravity);
    expect(b.vy).toBeLessThan(0);
    expect(b.x).toBe(0);
    expect(b.z).toBe(0);
  });

  it('drag decelerates a fast ball by dragK * |v|^2', () => {
    const b = ball(0, 20, 0, 30, 0, 0);
    ballAirStep(b, 0.01);
    const decel = (30 - b.vx) / 0.01;
    expect(decel).toBeGreaterThan(DRAG_K * 900 * 0.97);
    expect(decel).toBeLessThan(DRAG_K * 900 * 1.03);
  });

  it('mechanical energy never increases in flight, even with large spin (Magnus does no work)', () => {
    const b = launch(32, 0.4, 3, -14, 8);
    let e = energy(b);
    for (let i = 0; i < 120 && b.y > BALL_RADIUS; i++) {
      ballAirStep(b, DT / 4);
      const e2 = energy(b);
      expect(e2).toBeLessThanOrEqual(e + 1e-9);
      e = e2;
    }
  });

  it('spin decays by spinDecayAir per second in the air', () => {
    const b = ball(0, 200, 0, 0, 0, 0, 4, 9, -12);
    for (let i = 0; i < 60; i++) ballAirStep(b, DT);
    const f = Math.exp(-T_BALL.spinDecayAir); // exponential decay, 1 s
    expect(Math.abs(b.sy / 9 - f)).toBeLessThan(1e-6);
    expect(b.sx / 4).toBeCloseTo(b.sy / 9, 12);
    expect(b.sz / -12).toBeCloseTo(b.sy / 9, 12);
  });

  it('dt = 0 changes nothing; extreme inputs stay finite', () => {
    const b = launch(25, 0.3, 1, 2, 3);
    const c = createBallState();
    copyBallState(c, b);
    ballAirStep(b, 0);
    expect(b).toEqual(c);
    const e = ball(0, 40, 0, 40, 40, -40, 80, -80, 80);
    for (let i = 0; i < 2000; i++) ballAirStep(e, DT);
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'sx', 'sy', 'sz'] as const) expect(Number.isFinite(e[k])).toBe(true);
  });

  it('midpoint integrator: second order and stable for every SIM-02 substep length', () => {
    const ref = airLanding(launch(28, 0.6, 0, 9, 0), DT / 64);
    const e1 = airLanding(launch(28, 0.6, 0, 9, 0), DT);
    const e2 = airLanding(launch(28, 0.6, 0, 9, 0), DT / 2);
    const err1 = Math.hypot(e1.x - ref.x, e1.z - ref.z);
    const err2 = Math.hypot(e2.x - ref.x, e2.z - ref.z);
    expect(err1).toBeLessThan(0.05); // a whole tick per step is still within 5 cm over ~50 m
    expect(err2).toBeLessThan(err1 / 2.5); // ~4x per halving (second order)
    // A substep of DT/8 (36 m/s with 0.08 m substeps) lands within a centimetre of the reference.
    const e8 = airLanding(launch(28, 0.6, 0, 9, 0), DT / 8);
    expect(Math.hypot(e8.x - ref.x, e8.z - ref.z)).toBeLessThan(0.01);
  });

  it('flight is rotation invariant in the ground plane (curl included)', () => {
    const base = airLanding(launch(24, 0.5, 0, 7, 0), DT);
    for (const ang of [0.7, 1.9, -2.4, 3.0]) {
      const c = dcos(ang);
      const s = dsin(ang);
      const v = 24 * dcos(0.5);
      const b = ball(0, BALL_RADIUS, 0, v * c, 24 * dsin(0.5), v * s, 0, 7, 0);
      const r = airLanding(b, DT);
      // Rotate the base landing by the same angle (vec.rotate2 convention).
      const ex = base.x * c - base.z * s;
      const ez = base.x * s + base.z * c;
      expect(Math.abs(r.x - ex)).toBeLessThan(1e-9);
      expect(Math.abs(r.z - ez)).toBeLessThan(1e-9);
    }
  });
});

describe('SIM-01 spin convention (shared with SIM-09 crosses, SIM-11 shots)', () => {
  it('positive sy with vx > 0 curls toward -z (left of travel); negative toward +z', () => {
    const l = airLanding(launch(22, 0.3, 0, 9, 0), DT);
    const r = airLanding(launch(22, 0.3, 0, -9, 0), DT);
    expect(l.z).toBeLessThan(-0.5);
    expect(r.z).toBeGreaterThan(0.5);
    expect(l.z).toBeCloseTo(-r.z, 9);
  });

  it('curlSpinY(rightward > 0) bends to the right of travel in every direction', () => {
    for (const ang of [0, 1.2, 2.8, -1.6]) {
      const c = dcos(ang);
      const s = dsin(ang);
      const v = 22 * dcos(0.3);
      const b = ball(0, BALL_RADIUS, 0, v * c, 22 * dsin(0.3), v * s, 0, curlSpinY(9), 0);
      const land = airLanding(b, DT);
      // Cross of travel direction and landing offset > 0 => landing at a positive angle => right.
      const cross = c * land.z - s * land.x;
      expect(cross).toBeGreaterThan(0.5);
    }
    expect(Object.is(curlSpinY(0), 0)).toBe(true);
  });

  it('launchSpin: backspin lifts (floats), topspin dips, for any travel direction', () => {
    const o = createV3();
    for (const ang of [0, 2.2, -0.9]) {
      const c = dcos(ang);
      const s = dsin(ang);
      const mk = (back: number): BallState => {
        launchSpin(c, s, 0, back, o);
        const v = 15 * dcos(0.7);
        return ball(0, BALL_RADIUS, 0, v * c, 15 * dsin(0.7), v * s, o.x, o.y, o.z);
      };
      const none = airLanding(mk(0), DT);
      const back = airLanding(mk(12), DT);
      const top = airLanding(mk(-12), DT);
      expect(back.t).toBeGreaterThan(none.t);
      expect(back.apex).toBeGreaterThan(none.apex);
      expect(top.t).toBeLessThan(none.t);
      // No sideways drift from pure backspin/topspin.
      const sideB = c * back.z - s * back.x;
      expect(Math.abs(sideB)).toBeLessThan(1e-9);
    }
    launchSpin(0, 0, 3, 5, o); // zero direction falls back to +x
    expect(o.x).toBe(0);
    expect(o.y).toBe(3);
    expect(o.z).toBe(5);
    launchSpin(1, 0, 0, 0, o);
    expect(Object.is(o.x, 0) && Object.is(o.z, 0)).toBe(true);
  });
});

describe('SIM-01 reference feel (BRIEF section 6 Ball)', () => {
  it('a 9 rad/s curl bends a 25 m free kick 2-4 m sideways', () => {
    // Free kicks struck at 24-28 m/s, lifted 0.26-0.30 rad: over a wall, under the bar at 25 m.
    const kicks: [number, number][] = [[24, 0.3], [26, 0.26], [26, 0.3], [28, 0.26]];
    for (const [v, th] of kicks) {
      const b = launch(v, th, 0, T_SHOT.finesseSpin, 0);
      let side = NaN;
      let h = NaN;
      for (let i = 0; i < 180; i++) {
        const px = b.x;
        const py = b.y;
        const pz = b.z;
        ballStepTick(b, null);
        if (b.x >= 25) {
          const f = (25 - px) / (b.x - px);
          side = Math.abs(pz + (b.z - pz) * f);
          h = py + (b.y - py) * f;
          break;
        }
      }
      expect(h, `height at 25 m for ${v} m/s @ ${th}`).toBeGreaterThan(0.5);
      expect(h).toBeLessThan(2.44);
      expect(side, `bend for ${v} m/s @ ${th}`).toBeGreaterThanOrEqual(2);
      expect(side).toBeLessThanOrEqual(4);
    }
  });

  it('a 45-60 m goal kick is reachable at <= 30 m/s (T_PASS.lobAngle)', () => {
    const v = createV3();
    for (let d = 45; d <= 60; d += 5) {
      const sp = solveLaunch(d, 0, T_PASS.lobAngle, v);
      expect(sp, `${d} m`).toBeLessThanOrEqual(30);
      expect(sp).toBeGreaterThan(20);
    }
    // And a full-power 30 m/s kick at the best angle carries into the band.
    let best = 0;
    for (let th = 0.4; th <= 0.9; th += 0.05) best = Math.max(best, airLanding(launch(30, th), DT / 4).x);
    expect(best).toBeGreaterThanOrEqual(45);
    expect(best).toBeLessThanOrEqual(66);
  });

  it('hard shots at 25-36 m/s reach the goal from 20 m in under a second, in the air, and stay fast', () => {
    for (const [v, th] of [[25, 0.24], [30, 0.18], [T_SHOT.powerShotMax, 0.13]] as [number, number][]) {
      const b = launch(v, th);
      let t = 0;
      while (b.x < 20 && t < 120) { ballStepTick(b, null); t++; }
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      expect(t * DT, `${v} m/s`).toBeLessThan(1);
      expect(b.bounces).toBe(0);
      expect(speed / v).toBeGreaterThan(0.8);
      expect(b.y).toBeGreaterThan(0.3);
      expect(b.y).toBeLessThan(2.44); // under the bar
    }
  });

  it('bounce height roughly halves each bounce (with SIM-02)', () => {
    const b = ball(0, 3, 0, 0, 0, 0);
    const apex: number[] = [];
    let up = false;
    let top = b.y;
    for (let i = 0; i < 600 && apex.length < 3; i++) {
      const py = b.y;
      ballStepTick(b, null);
      if (b.y > py) { up = true; top = b.y; } else if (up && b.y < py) { apex.push(top - BALL_RADIUS); up = false; } else if (b.y > top) top = b.y;
    }
    expect(apex.length).toBeGreaterThanOrEqual(2);
    let prev = 3 - BALL_RADIUS;
    for (const a of apex) {
      if (a < 0.05) break; // tiny hops are below the bounce/roll threshold
      const r = a / prev;
      expect(r).toBeGreaterThan(0.33);
      expect(r).toBeLessThan(0.62);
      prev = a;
    }
  });

  it('backspin chip floats: longer hang, higher apex than the same strike without spin', () => {
    const o = createV3();
    launchSpin(1, 0, 0, T_SHOT.chipBackspin, o);
    const chip = airLanding(launch(15, 0.75, o.x, o.y, o.z), DT);
    const flat = airLanding(launch(15, 0.75), DT);
    expect(chip.t / flat.t).toBeGreaterThan(1.15);
    expect(chip.apex).toBeGreaterThan(flat.apex * 1.15);
  });

  it('a 15 m/s ground pass rolls about 30 m under the documented roll model', () => {
    expect(groundRollTime(15, 26)).toBeGreaterThan(0); // reaches 26 m
    expect(groundRollTime(15, 37)).toBe(-1); // but stops before 37 m
    // Stopping distance (closed form of the roll model).
    const a = T_BALL.rollDecel;
    const c = T_BALL.rollDamping;
    const stop = 15 / c - (a / (c * c)) * Math.log(1 + (c * 15) / a);
    expect(stop).toBeGreaterThan(27);
    expect(stop).toBeLessThan(36);
  });

  it('constants actually used are the tuned ones (TUNING-CR values)', () => {
    expect(MAGNUS_K).toBe(0.025);
    expect(DRAG_K).toBe(0.0075);
  });
});

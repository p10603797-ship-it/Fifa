/**
 * SIM-01 solvers: solveLaunch / solveLaunchSpin land on target (air reference and the real sim), groundPassSpeed is
 * calibrated against the roll model (reference integration, and SIM-02's real roll once it implements the model),
 * groundRollTime, edge cases and determinism.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT } from '../../src/contracts/constants';
import { createBallState, type BallState } from '../../src/contracts/state';
import { T_BALL, T_PASS } from '../../src/contracts/tuning';
import { ballStepTick } from '../../src/sim/ball/contact';
import {
  ballAirStep, createLaunchSolution, groundPassSpeed, groundRollTime, solveLaunch, solveLaunchSpin,
} from '../../src/sim/ball/flight';
import { createV3 } from '../../src/sim/core/vec';

function mkBall(y: number, vx: number, vy: number, vz: number, sx = 0, sy = 0, sz = 0): BallState {
  const b = createBallState();
  b.x = 0; b.y = y; b.z = 0; b.px = 0; b.py = y; b.pz = 0;
  b.vx = vx; b.vy = vy; b.vz = vz; b.sx = sx; b.sy = sy; b.sz = sz;
  b.grounded = y <= BALL_RADIUS && vy === 0 ? 1 : 0;
  return b;
}

/** Fine air-only reference landing (ballAirStep at DT/16, interpolated). */
function refLanding(b: BallState): { x: number; z: number } {
  const dt = DT / 16;
  for (let i = 0; i < 200000; i++) {
    const px = b.x;
    const py = b.y;
    const pz = b.z;
    ballAirStep(b, dt);
    if (b.y <= BALL_RADIUS && b.vy < 0) {
      const f = (py - BALL_RADIUS) / (py - b.y);
      return { x: px + (b.x - px) * f, z: pz + (b.z - pz) * f };
    }
  }
  throw new Error('never landed');
}

/**
 * First ground contact in the REAL sim (SIM-02 ballStepTick): the last airborne sample is extrapolated with its
 * velocity and gravity down to BALL_RADIUS (sub-tick accuracy whatever SIM-02's substepping is).
 */
function simLanding(b: BallState): { x: number; z: number } {
  const g = T_BALL.gravity;
  for (let i = 0; i < 1200; i++) {
    const x = b.x;
    const y = b.y;
    const z = b.z;
    const vx = b.vx;
    const vy = b.vy;
    const vz = b.vz;
    const bounces = b.bounces;
    ballStepTick(b, null);
    const touched = b.bounces !== bounces || b.y <= BALL_RADIUS + 1e-9 || (vy < 0 && b.vy >= 0);
    if (touched && i > 0) {
      const t = (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0, y - BALL_RADIUS))) / g;
      return { x: x + vx * t, z: z + vz * t };
    }
  }
  throw new Error('never landed');
}

describe('SIM-01 solveLaunch accuracy', () => {
  it('lands within 0.1 m of the target in the fine air reference across distances, angles and directions', () => {
    const v = createV3();
    let worst = 0;
    for (const d of [3, 8, 15, 25, 40, 55, 65]) {
      for (const angle of [0.2, T_PASS.drivenLobAngle, T_PASS.lobAngle, T_PASS.highLobAngle, 1.2]) {
        for (const dir of [0, 1.1, 2.6, -2.0]) {
          const dx = d * Math.cos(dir);
          const dz = d * Math.sin(dir);
          const sp = solveLaunch(dx, dz, angle, v);
          if (sp >= T_BALL.maxSpeed) continue; // out of reach (checked separately)
          expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(sp, 9);
          expect(Math.atan2(v.y, Math.hypot(v.x, v.z))).toBeCloseTo(angle, 9);
          const land = refLanding(mkBall(BALL_RADIUS, v.x, v.y, v.z));
          worst = Math.max(worst, Math.hypot(land.x - dx, land.z - dz));
        }
      }
    }
    expect(worst).toBeLessThan(0.1);
  });

  it('first landing in the real sim (SIM-02 ballStepTick) is within 0.5 m of the target', () => {
    const v = createV3();
    for (const d of [10, 20, 30, 45, 60]) {
      for (const angle of [T_PASS.drivenLobAngle, T_PASS.lobAngle, T_PASS.highLobAngle]) {
        const dx = d * 0.8;
        const dz = -d * 0.6;
        const sp = solveLaunch(dx, dz, angle, v);
        if (sp >= T_BALL.maxSpeed) continue;
        const land = simLanding(mkBall(BALL_RADIUS, v.x, v.y, v.z));
        expect(Math.hypot(land.x - dx, land.z - dz), `${d} m @ ${angle}`).toBeLessThan(0.5);
      }
    }
  });

  it('solveLaunchSpin: curl, backspin and a raised launch still land on target', () => {
    const sol = createLaunchSolution();
    for (const [dx, dz] of [[30, 10], [-18, 22], [40, -5], [12, 0]] as [number, number][]) {
      for (const [curl, back, y0] of [[9, 0, BALL_RADIUS], [-9, 0, BALL_RADIUS], [15, 0, BALL_RADIUS], [0, 12, BALL_RADIUS],
        [0, -12, BALL_RADIUS], [-6, 8, 1.0], [0, 0, 1.6]] as [number, number, number][]) {
        const sp = solveLaunchSpin(dx, dz, 0.55, y0, curl, back, sol);
        expect(sol.reached, `${dx},${dz} curl ${curl} back ${back} y0 ${y0}`).toBe(1);
        expect(sol.speed).toBe(sp);
        expect(sol.sy).toBe(curl);
        // Backspin axis is horizontal and perpendicular to the solved horizontal velocity.
        expect(sol.sx * sol.vx + sol.sz * sol.vz).toBeCloseTo(0, 9);
        expect(sol.flightT).toBeGreaterThan(0);
        const land = refLanding(mkBall(y0, sol.vx, sol.vy, sol.vz, sol.sx, sol.sy, sol.sz));
        expect(Math.hypot(land.x - dx, land.z - dz)).toBeLessThan(0.1);
      }
    }
  });

  it('curl is compensated by aiming the other way (positive sy curls left, so the aim goes right)', () => {
    const sol = createLaunchSolution();
    solveLaunchSpin(30, 0, 0.4, BALL_RADIUS, 9, 0, sol);
    expect(sol.vz).toBeGreaterThan(0.3); // aims toward +z (right of +x) to curl back left onto the target
    solveLaunchSpin(30, 0, 0.4, BALL_RADIUS, -9, 0, sol);
    expect(sol.vz).toBeLessThan(-0.3);
  });

  it('out of reach: max speed toward the target, reached = 0', () => {
    const sol = createLaunchSolution();
    const sp = solveLaunchSpin(150, 0, T_PASS.lobAngle, BALL_RADIUS, 0, 0, sol);
    expect(sp).toBe(T_BALL.maxSpeed);
    expect(sol.reached).toBe(0);
    expect(sol.vx).toBeGreaterThan(0);
    expect(sol.vz).toBe(0);
    const v = createV3();
    expect(solveLaunch(0, -150, 0.6, v)).toBe(T_BALL.maxSpeed);
    expect(v.z).toBeLessThan(0);
  });

  it('degenerate inputs: zero distance, NaN, extreme angles stay finite', () => {
    const v = createV3();
    expect(solveLaunch(0, 0, 0.6, v)).toBe(0);
    expect([v.x, v.y, v.z]).toEqual([0, 0, 0]);
    expect(solveLaunch(Number.NaN, 3, 0.6, v)).toBe(0);
    expect(solveLaunch(Infinity, 3, 0.6, v)).toBe(0);
    for (const a of [-1, 0, Number.NaN, 1.5707963, 3]) {
      const sp = solveLaunch(20, 5, a, v);
      expect(Number.isFinite(sp) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      expect(sp).toBeGreaterThan(0);
      expect(sp).toBeLessThanOrEqual(T_BALL.maxSpeed);
    }
    const sol = createLaunchSolution();
    solveLaunchSpin(20, 0, 0.5, BALL_RADIUS, Number.NaN, Infinity, sol);
    expect(sol.sx === 0 && sol.sy === 0 && sol.sz === 0).toBe(true);
    expect(sol.reached).toBe(1);
  });

  it('tiny distances give tiny, accurate launches', () => {
    const v = createV3();
    const sp = solveLaunch(0.3, 0, 0.6, v);
    expect(sp).toBeGreaterThan(0);
    expect(sp).toBeLessThan(3);
    const land = refLanding(mkBall(BALL_RADIUS, v.x, v.y, v.z));
    expect(Math.abs(land.x - 0.3)).toBeLessThan(0.02);
  });
});

/** Reference integration of the documented roll model dv/dt = -a - c v: speed when the ball reaches dist (or 0). */
function rollRef(v0: number, dist: number): { v: number; t: number } {
  const a = T_BALL.rollDecel;
  const c = T_BALL.rollDamping;
  const dt = 1e-4;
  let x = 0;
  let v = v0;
  let t = 0;
  while (x < dist) {
    const nv = v - (a + c * v) * dt;
    if (nv <= 0) return { v: 0, t: -1 };
    const nx = x + 0.5 * (v + nv) * dt;
    if (nx >= dist) {
      const f = (dist - x) / (nx - x);
      return { v: v + (nv - v) * f, t: t + dt * f };
    }
    x = nx;
    v = nv;
    t += dt;
  }
  return { v, t };
}

/** Distance at which a real-sim rolling ball (SIM-02) has slowed to `speed` (interpolated), or its stop point. */
function simRollDistanceTo(v0: number, speed: number): number {
  const b = mkBall(BALL_RADIUS, v0, 0, 0);
  let prevX = 0;
  let prevV = v0;
  for (let i = 0; i < 3000; i++) {
    ballStepTick(b, null);
    const sp = Math.hypot(b.vx, b.vz);
    if (sp <= speed) {
      const f = prevV > sp ? (prevV - speed) / (prevV - sp) : 1;
      return prevX + (b.x - prevX) * f;
    }
    prevX = b.x;
    prevV = sp;
  }
  return b.x;
}

/** True while contact.ts is still the Wave 0 baseline roll (constant rollDecel only, no rollDamping). */
function sim02IsBaselineRoll(): boolean {
  const b = mkBall(BALL_RADIUS, 10, 0, 0);
  for (let i = 0; i < 60; i++) ballStepTick(b, null);
  return Math.abs(Math.hypot(b.vx, b.vz) - (10 - T_BALL.rollDecel)) < 0.02;
}
const SIM02_BASELINE = sim02IsBaselineRoll();
if (SIM02_BASELINE) console.warn('[SIM-01] contact.ts still has the Wave 0 baseline roll: real-sim roll calibration skipped');

describe('SIM-01 groundPassSpeed / groundRollTime', () => {
  it('calibrated against a fine integration of the roll model: arrival speed and distance within 5%', () => {
    for (const d of [3, 6, 10, 15, 20, 30, 40, 50]) {
      for (const arrive of [0, 1, 3, 5, 8, 12]) {
        const v0 = groundPassSpeed(d, arrive);
        if (v0 >= T_BALL.maxSpeed) continue;
        expect(v0).toBeGreaterThanOrEqual(arrive);
        if (arrive === 0) {
          // Stops at d: just reaches it.
          expect(rollRef(v0 * 1.05, d).v).toBeGreaterThan(0);
          expect(rollRef(v0 * 0.95, d).t).toBe(-1);
        } else {
          const r = rollRef(v0, d);
          expect(Math.abs(r.v - arrive), `${d} m @ ${arrive}`).toBeLessThanOrEqual(Math.max(0.05 * arrive, 0.01));
        }
      }
    }
  });

  it.skipIf(SIM02_BASELINE)('calibrated against the real SIM-02 roll: arrival point within 5% of the distance', () => {
    for (const d of [5, 10, 20, 30, 40]) {
      for (const arrive of [0.5, 2, 5, 8]) {
        const v0 = groundPassSpeed(d, arrive);
        if (v0 > T_PASS.groundMax * 1.5) continue;
        const x = simRollDistanceTo(v0, arrive);
        expect(Math.abs(x - d) / d, `${d} m @ ${arrive} m/s (v0 ${v0.toFixed(2)})`).toBeLessThan(0.05);
      }
    }
  });

  it('reference feel: the 15 m/s pass arrives ~30 m away at walking pace; zero-arrival 30 m pass needs ~14 m/s', () => {
    const v0 = groundPassSpeed(30, 0);
    expect(v0).toBeGreaterThan(12.5);
    expect(v0).toBeLessThan(16);
    expect(groundPassSpeed(30, 2)).toBeGreaterThan(v0);
  });

  it('monotonic in distance and arrival speed; dist 0 = arrival speed; capped at maxSpeed; finite for bad input', () => {
    let prev = 0;
    for (let d = 0; d <= 80; d += 2.5) {
      const v = groundPassSpeed(d, 3);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(groundPassSpeed(20, 6)).toBeGreaterThan(groundPassSpeed(20, 4));
    expect(groundPassSpeed(0, 3)).toBe(3);
    expect(groundPassSpeed(-5, 3)).toBe(3);
    expect(groundPassSpeed(1000, 5)).toBe(T_BALL.maxSpeed);
    expect(groundPassSpeed(Infinity, 1)).toBe(T_BALL.maxSpeed);
    expect(groundPassSpeed(120, 0)).toBeLessThan(T_BALL.maxSpeed); // a 120 m roll is still reachable at < 40 m/s
    expect(groundPassSpeed(10, 100)).toBe(T_BALL.maxSpeed);
    expect(groundPassSpeed(10, -4)).toBeCloseTo(groundPassSpeed(10, 0), 12);
    for (const [d, a] of [[Number.NaN, 2], [10, Number.NaN], [Infinity, 1]] as [number, number][]) {
      expect(Number.isFinite(groundPassSpeed(d, a))).toBe(true);
    }
  });

  it('groundRollTime matches the reference integration and pairs with groundPassSpeed', () => {
    for (const v0 of [6, 10, 15, 22]) {
      for (const d of [2, 8, 15, 25]) {
        const r = rollRef(v0, d);
        const t = groundRollTime(v0, d);
        if (r.t < 0) { expect(t).toBe(-1); continue; }
        expect(Math.abs(t - r.t), `${v0} m/s, ${d} m`).toBeLessThan(0.002 + 0.001 * r.t);
      }
    }
    const v0 = groundPassSpeed(25, 4);
    expect(Math.abs(groundRollTime(v0, 25) - rollRef(v0, 25).t)).toBeLessThan(0.01);
    expect(groundRollTime(10, 0)).toBe(0);
    expect(groundRollTime(0, 5)).toBe(-1);
    expect(groundRollTime(5, 1000)).toBe(-1);
  });
});

describe('SIM-01 solver determinism', () => {
  it('identical results on repeated and interleaved calls (no hidden state leaks between calls)', () => {
    const a = createLaunchSolution();
    const b = createLaunchSolution();
    solveLaunchSpin(33, -7, 0.5, BALL_RADIUS, 9, 3, a);
    const v = createV3();
    solveLaunch(12, 40, 0.9, v);
    groundPassSpeed(17, 3);
    solveLaunchSpin(150, 0, 0.6, 1, -4, 0, b);
    solveLaunchSpin(33, -7, 0.5, BALL_RADIUS, 9, 3, b);
    expect(b).toEqual(a);
    const v1 = createV3();
    const v2 = createV3();
    const s1 = solveLaunch(44, 3, T_PASS.lobAngle, v1);
    const s2 = solveLaunch(44, 3, T_PASS.lobAngle, v2);
    expect(s1).toBe(s2);
    expect(v1).toEqual(v2);
    expect(groundPassSpeed(23.5, 4.25)).toBe(groundPassSpeed(23.5, 4.25));
  });
});

/**
 * SIM-02 ball contact: ground bounce (restitution, tangential + spin friction), rolling resistance, rest, substeps,
 * BOUNCE events. BRIEF section 6 "Ball": bounce height roughly halves each bounce; a 15 m/s pass rolls about 30 m.
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/contracts/constants';
import { EventType } from '../../src/contracts/events';
import { T_BALL } from '../../src/contracts/tuning';
import { BALL_CONTACT_TUNING, MAX_SUBSTEPS, ballPhysicsStep, ballStepTick, ballSubsteps } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { R, allFinite, ball, ofType, runBall, speed } from './sim-02-helpers';

/** Peak heights (ball bottom above the grass) of successive bounces of a ball dropped from h. */
function bouncePeaks(h: number, vx = 0): number[] {
  const b = ball({ y: h + R, vx });
  const peaks: number[] = [];
  let prev = b.y;
  let rising = false;
  for (let i = 0; i < 900; i++) {
    ballStepTick(b, null);
    if (b.y > prev) rising = true;
    else if (rising) { peaks.push(prev - R); rising = false; }
    prev = b.y;
  }
  return peaks;
}

describe('SIM-02 ground bounce', () => {
  it('bounce heights roughly halve each bounce', () => {
    for (const h of [2, 4, 8]) {
      const peaks = bouncePeaks(h);
      expect(peaks.length).toBeGreaterThanOrEqual(4);
      let prev = h;
      for (let i = 0; i < 4; i++) {
        const ratio = peaks[i]! / prev;
        expect(ratio).toBeGreaterThan(0.35);
        expect(ratio).toBeLessThan(0.6);
        prev = peaks[i]!;
      }
    }
  });

  it('a bouncing ball ends up rolling at rest on the grass (grounded, vy 0, y = radius)', () => {
    const b = ball({ y: 5, vx: 3 });
    runBall(b, 900);
    expect(b.grounded).toBe(1);
    expect(b.vy).toBe(0);
    expect(b.y).toBe(R);
    expect(b.vx).toBe(0);
    expect(b.vz).toBe(0);
    expect(b.bounces).toBeGreaterThanOrEqual(3);
  });

  it('emits BOUNCE with c = impact speed only for impacts above 1 m/s', () => {
    const b = ball({ y: 3 });
    const { events } = runBall(b, 600);
    const bounces = ofType(events, EventType.BOUNCE);
    expect(bounces.length).toBeGreaterThanOrEqual(3);
    // First impact from 2.89 m: about sqrt(2 g h) (drag makes it a little slower).
    const vi = Math.sqrt(2 * T_BALL.gravity * (3 - R));
    expect(bounces[0]!.c).toBeGreaterThan(vi * 0.9);
    expect(bounces[0]!.c).toBeLessThanOrEqual(vi + 1e-9);
    expect(bounces[0]!.y).toBe(R);
    for (const e of bounces) expect(e.c).toBeGreaterThan(BALL_CONTACT_TUNING.eventMinSpeed);
    // Successive impacts get weaker.
    for (let i = 1; i < bounces.length; i++) expect(bounces[i]!.c).toBeLessThan(bounces[i - 1]!.c);
  });

  it('a full-grip bounce loses bounceFriction of the horizontal speed (no spin)', () => {
    const b = ball({ y: R + 0.001, vy: -6, vx: 10 });
    ballPhysicsStep(b, DT / 4, null);
    // The air step adds a little drag; friction removes 12%.
    expect(b.vx).toBeGreaterThan(10 * (1 - T_BALL.bounceFriction) * 0.98);
    expect(b.vx).toBeLessThan(10 * (1 - T_BALL.bounceFriction) + 1e-9);
    expect(b.vy).toBeGreaterThan(0);
  });

  it('a tiny hop barely grips (a ground pass with a small vy does not lose 12%)', () => {
    const b = ball({ y: R, vy: 0.2, vx: 15 });
    runBall(b, 3);
    expect(b.grounded).toBe(1);
    // Rolling resistance for 3 ticks ~ (2.2 + 1.8) * 0.05 = 0.2 m/s; friction scaled by 0.2 / 2 -> ~0.15 m/s.
    expect(b.vx).toBeGreaterThan(14.5);
  });

  it('spin friction: backspin checks the bounce, topspin speeds it up, spin is reduced', () => {
    // Travel +x: backspin is +sz (flight.ts convention: axis (-dirZ, 0, dirX)).
    const mk = (sz: number) => {
      const b = ball({ y: R + 0.001, vy: -5, vx: 12, sz });
      ballPhysicsStep(b, DT / 8, null);
      return b;
    };
    const none = mk(0);
    const back = mk(40);
    const top = mk(-40);
    expect(back.vx).toBeLessThan(none.vx);
    expect(top.vx).toBeGreaterThan(none.vx);
    expect(Math.abs(back.sz)).toBeLessThan(40);
    expect(Math.abs(top.sz)).toBeLessThan(40);
    // Sidespin about x (sx) pushes sideways the same way: contact velocity -r*sx along z.
    const side = ball({ y: R + 0.001, vy: -5, vx: 12, sx: 30 });
    ballPhysicsStep(side, DT / 8, null);
    expect(side.vz).toBeGreaterThan(0);
  });
});

describe('SIM-02 rolling', () => {
  it('a 15 m/s ground pass rolls about 30 m (rollDecel + rollDamping) and stops', () => {
    const b = ball({ vx: 15 });
    let t = 0;
    while ((b.vx !== 0 || b.vz !== 0) && t < 1200) { ballStepTick(b, null); t++; }
    expect(b.x).toBeGreaterThan(27);
    expect(b.x).toBeLessThan(36);
    expect(b.vx).toBe(0);
    expect(b.y).toBe(R);
    expect(b.vy).toBe(0);
  });

  it('matches the continuous roll model dv/dt = -a - c v (SIM-01 groundPassSpeed relies on it) within 2%', () => {
    const a = T_BALL.rollDecel;
    const c = T_BALL.rollDamping;
    for (const v0 of [5, 9, 15, 22, 28]) {
      // Start deep in one half so even the longest roll (~80 m) stays clear of goals and boards.
      const b = ball({ x: -50, z: 10, vx: v0 * 0.96, vz: v0 * 0.28 });
      for (let t = 0; t < 2000 && speed(b) > 0; t++) ballStepTick(b, null);
      const dist = Math.hypot(b.x + 50, b.z - 10);
      const exact = v0 / c - (a / (c * c)) * Math.log(1 + (c * v0) / a);
      expect(Math.abs(dist - exact) / exact).toBeLessThan(0.02);
    }
  });

  it('comes to rest below restSpeed and stays exactly still (no creep, no events)', () => {
    const b = ball({ vx: T_BALL.restSpeed * 0.9 + T_BALL.rollDecel * DT });
    ballStepTick(b, null);
    expect(b.vx).toBe(0);
    const x = b.x;
    const { events } = runBall(b, 300);
    expect(b.x).toBe(x);
    expect(b.z).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('spin decays while rolling', () => {
    const b = ball({ vx: 5, sy: 10, sx: 3 });
    runBall(b, 120);
    expect(Math.abs(b.sy)).toBeLessThan(10 * 0.01);
    expect(Math.abs(b.sx)).toBeLessThan(3 * 0.01);
  });

  it('a rolling ball keeps vy exactly 0 and y exactly the radius', () => {
    const b = ball({ vx: 20, vz: -7 });
    runBall(b, 200, (_i, bb) => {
      expect(bb.vy).toBe(0);
      expect(bb.y).toBe(R);
      expect(bb.grounded).toBe(1);
    });
  });
});

describe('SIM-02 substeps and clamps', () => {
  it('uses N = ceil(|v| DT / maxStep) substeps, at least 1, at most MAX_SUBSTEPS', () => {
    expect(ballSubsteps(ball())).toBe(1);
    expect(ballSubsteps(ball({ vx: 36 }))).toBe(Math.ceil(36 * DT / T_BALL.maxStep));
    expect(ballSubsteps(ball({ vx: 1e6 }))).toBeLessThanOrEqual(MAX_SUBSTEPS);
    expect(ballSubsteps(ball({ vx: NaN }))).toBeGreaterThanOrEqual(1);
  });

  it('clamps speed to maxSpeed', () => {
    const b = ball({ y: 5, vx: 100, vy: 20, vz: -30 });
    ballStepTick(b, null);
    expect(speed(b)).toBeLessThanOrEqual(T_BALL.maxSpeed + 1e-9);
  });

  it('recovers from non-finite kinematics (falls back to the last good position, stops)', () => {
    const b = ball({ x: 10, y: 1, z: 2, vx: NaN, sy: Infinity });
    ballStepTick(b, null);
    expect(allFinite(b)).toBe(true);
    const c = ball({ x: NaN, px: 3, py: 0.5, pz: -1, vx: 4 });
    ballStepTick(c, null);
    expect(allFinite(c)).toBe(true);
    expect(c.x).toBeCloseTo(3, 6);
  });

  it('a ball below the grass is lifted onto it', () => {
    const b = ball({ y: -1, vy: 0, grounded: 1 });
    ballStepTick(b, null);
    expect(b.y).toBe(R);
  });

  it('ballPhysicsStep with events emits through the sink; with null it is silent', () => {
    const ev = createEventBuffer();
    ev.begin(1);
    const b = ball({ y: R + 0.01, vy: -8 });
    ballPhysicsStep(b, DT / 4, ev);
    expect(ofType(ev.toArray(), EventType.BOUNCE)).toHaveLength(1);
    const c = ball({ y: R + 0.01, vy: -8 });
    ballPhysicsStep(c, DT / 4, null);
    expect(c.vy).toBe(b.vy);
  });
});

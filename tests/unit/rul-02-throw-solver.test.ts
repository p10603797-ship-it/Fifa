/**
 * RUL-02 unit tests: the throw launch solver (speed range 8-18 m/s, first landing on the target, short vs long arcs,
 * out-of-reach and hostile inputs), the hands height, and noGoalDirectFromThrow (glitch "goal scored direct from a
 * throw-in": the rule itself).
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT } from '../../src/contracts/constants';
import { KickKind } from '../../src/contracts/enums';
import { createBallState } from '../../src/contracts/state';
import { ballAirStep } from '../../src/sim/ball/flight';
import {
  LOCAL_TUNING, createThrowSolution, noGoalDirectFromThrow, solveThrow, throwHandsHeight,
} from '../../src/sim/rules/throwin';
import { makeScenario } from '../harness/scenario';

/** Fly a throw with the sim's air physics; returns [first landing distance, apex height]. */
function fly(speed: number, angle: number, y0: number): [number, number] {
  const b = createBallState();
  b.x = 0; b.y = y0; b.z = 0;
  b.vx = speed * Math.cos(angle); b.vy = speed * Math.sin(angle); b.vz = 0;
  let apex = y0;
  for (let i = 0; i < 600; i++) {
    const px = b.x, py = b.y;
    ballAirStep(b, DT);
    if (b.y > apex) apex = b.y;
    if (b.y <= BALL_RADIUS && b.vy < 0) return [px + (b.x - px) * ((py - BALL_RADIUS) / (py - b.y)), apex];
  }
  return [b.x, apex];
}

describe('RUL-02 throw solver', () => {
  const sol = createThrowSolution();
  const T = LOCAL_TUNING;

  it('every throw is 8-18 m/s and lands on the target within reach (short and long, 3..28 m)', () => {
    for (const long of [0, 1]) {
      for (let d = T.minThrowDist; d <= T.longMaxDist; d += 0.5) {
        solveThrow(d, 2.0, long, sol);
        expect(sol.speed).toBeGreaterThanOrEqual(T.speedMin);
        expect(sol.speed).toBeLessThanOrEqual(T.speedMax);
        expect(sol.reached).toBe(1);
        expect(Math.abs(sol.range - d)).toBeLessThan(0.05);
        // The reported launch really lands there with the sim's ball physics.
        const [land] = fly(sol.speed, sol.angle, 2.0);
        expect(Math.abs(land - d)).toBeLessThan(0.06);
        expect(sol.flightT).toBeGreaterThan(0);
      }
    }
  });

  it('short throws are flat, long throws lofted (higher apex for the same distance)', () => {
    for (const d of [8, 12, 18]) {
      solveThrow(d, 2.0, 0, sol);
      const shortApex = fly(sol.speed, sol.angle, 2.0)[1];
      const shortAngle = sol.angle;
      solveThrow(d, 2.0, 1, sol);
      const longApex = fly(sol.speed, sol.angle, 2.0)[1];
      expect(sol.angle).toBeGreaterThan(shortAngle);
      expect(longApex).toBeGreaterThan(shortApex);
    }
  });

  it('very short throws stay at the minimum speed and are flattened; mid-range ones use the nominal elevation', () => {
    solveThrow(T.minThrowDist, 2.0, 0, sol);
    expect(sol.speed).toBe(T.speedMin);
    expect(sol.angle).toBeLessThan(T.shortAngle);
    solveThrow(12, 2.0, 0, sol);
    expect(sol.angle).toBe(T.shortAngle);
    expect(sol.speed).toBeGreaterThan(T.speedMin);
    expect(sol.speed).toBeLessThan(T.speedMax);
  });

  it('out of reach: the longest throw (18 m/s at maxRangeAngle), reached = 0; hostile inputs stay finite', () => {
    solveThrow(60, 2.0, 1, sol);
    expect(sol.speed).toBe(T.speedMax);
    expect(sol.angle).toBe(T.maxRangeAngle);
    expect(sol.reached).toBe(0);
    expect(sol.range).toBeGreaterThan(T.longMaxDist);
    expect(T.longAngle).toBeLessThan(T.maxRangeAngle);
    for (const [d, y] of [[NaN, 2], [Infinity, 2], [-5, 2], [10, NaN], [10, -1], [0, 2]] as [number, number][]) {
      solveThrow(d, y, 0, sol);
      for (const v of [sol.speed, sol.angle, sol.range, sol.flightT]) expect(Number.isFinite(v)).toBe(true);
      expect(sol.speed).toBeGreaterThanOrEqual(T.speedMin);
      expect(sol.speed).toBeLessThanOrEqual(T.speedMax);
    }
  });

  it('hands height follows the thrower and stays in range', () => {
    const s = makeScenario();
    s.attrs[3]!.height = 180;
    expect(throwHandsHeight(s, 3)).toBeCloseTo(1.8 + T.ballAboveHead, 9);
    s.attrs[3]!.height = 300;
    expect(throwHandsHeight(s, 3)).toBe(T.handsMax);
    s.attrs[3]!.height = NaN;
    expect(Number.isFinite(throwHandsHeight(s, 3))).toBe(true);
  });
});

describe('RUL-02 noGoalDirectFromThrow (glitch: goal scored direct from a throw-in)', () => {
  it('true only while the throw itself is the last touch', () => {
    const s = makeScenario();
    const b = s.ball;
    b.lastKickBy = 4; b.lastKickTeam = 0; b.lastKickKind = KickKind.THROW_IN; b.lastKickTick = 100;
    b.lastTouch = 4; b.lastTouchTeam = 0; b.lastTouchTick = 100;
    expect(noGoalDirectFromThrow(s)).toBe(true);
    // Touched by anyone afterwards (keeper, defender, the thrower's teammate): a goal counts.
    b.lastTouch = 12; b.lastTouchTeam = 1; b.lastTouchTick = 130;
    expect(noGoalDirectFromThrow(s)).toBe(false);
    b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = 130;
    expect(noGoalDirectFromThrow(s)).toBe(false);
    // Other kicks never.
    b.lastTouch = 4; b.lastTouchTick = 100;
    b.lastKickKind = KickKind.LOB_PASS;
    expect(noGoalDirectFromThrow(s)).toBe(false);
    b.lastKickKind = KickKind.THROW_IN; b.lastKickBy = -1;
    expect(noGoalDirectFromThrow(s)).toBe(false);
  });
});

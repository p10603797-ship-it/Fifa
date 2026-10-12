/**
 * [SIM-03] Pitch geometry queries: exact to contracts/constants (lines belong to the areas they bound), both ends,
 * mirror symmetry, and the helpers (inGoalMouth, ballOverLine, penaltySpot, isInOwnHalf, distToGoalMouth).
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_DEPTH, GOAL_HALF_WIDTH,
  GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST,
} from '../../src/contracts/constants';
import {
  BALL_OUT_X, BALL_OUT_Z, ballOverLine, clampToPitch, distToGoalMouth, inCrossingZone, inGoalArea, inGoalMouth,
  inPenaltyArea, insideGoal, isInOwnHalf, onPitch, penaltySpot,
} from '../../src/sim/pitch/geometry';

const E = 1e-6;

describe('SIM-03 out-of-play planes', () => {
  it('are the lines plus one ball radius', () => {
    expect(BALL_OUT_X).toBe(HALF_LENGTH + BALL_RADIUS);
    expect(BALL_OUT_Z).toBe(HALF_WIDTH + BALL_RADIUS);
    expect(BALL_OUT_X).toBeCloseTo(52.61, 12);
    expect(BALL_OUT_Z).toBeCloseTo(34.11, 12);
  });

  it('ballOverLine: whole ball over a goal line or touchline', () => {
    expect(ballOverLine(0, 0)).toBe(false);
    expect(ballOverLine(HALF_LENGTH, 0)).toBe(false);
    expect(ballOverLine(BALL_OUT_X, BALL_OUT_Z)).toBe(false);
    expect(ballOverLine(-BALL_OUT_X, -BALL_OUT_Z)).toBe(false);
    expect(ballOverLine(BALL_OUT_X + E, 0)).toBe(true);
    expect(ballOverLine(-BALL_OUT_X - E, 0)).toBe(true);
    expect(ballOverLine(0, BALL_OUT_Z + E)).toBe(true);
    expect(ballOverLine(0, -BALL_OUT_Z - E)).toBe(true);
    expect(ballOverLine(NaN, 0)).toBe(false);
  });
});

describe('SIM-03 areas', () => {
  for (const end of [1, -1]) {
    it(`penalty area at end ${end}: 16.5 x 40.32, lines included, nothing behind the goal line`, () => {
      const front = end * (HALF_LENGTH - PENALTY_AREA_DEPTH);
      const line = end * HALF_LENGTH;
      expect(inPenaltyArea(front, 0, end)).toBe(true);
      expect(inPenaltyArea(front - end * E, 0, end)).toBe(false);
      expect(inPenaltyArea(line, 0, end)).toBe(true);
      expect(inPenaltyArea(line + end * E, 0, end)).toBe(false);
      for (const sz of [1, -1]) {
        expect(inPenaltyArea(front, sz * PENALTY_AREA_HALF_WIDTH, end)).toBe(true);
        expect(inPenaltyArea(line, sz * PENALTY_AREA_HALF_WIDTH, end)).toBe(true);
        expect(inPenaltyArea(front + end, sz * (PENALTY_AREA_HALF_WIDTH + E), end)).toBe(false);
      }
      expect(inPenaltyArea(end * penaltySpot(1), 0, end)).toBe(true);
      expect(inPenaltyArea(line, 0, -end)).toBe(false);
      expect(inPenaltyArea(0, 0, end)).toBe(false);
      expect(PENALTY_AREA_HALF_WIDTH).toBeCloseTo(20.16, 12);
    });

    it(`goal area at end ${end}: 5.5 x 18.32, lines included`, () => {
      const front = end * (HALF_LENGTH - GOAL_AREA_DEPTH);
      const line = end * HALF_LENGTH;
      expect(inGoalArea(front, 0, end)).toBe(true);
      expect(inGoalArea(front - end * E, 0, end)).toBe(false);
      expect(inGoalArea(line, GOAL_AREA_HALF_WIDTH, end)).toBe(true);
      expect(inGoalArea(line, -GOAL_AREA_HALF_WIDTH, end)).toBe(true);
      expect(inGoalArea(line, GOAL_AREA_HALF_WIDTH + E, end)).toBe(false);
      expect(inGoalArea(line + end * E, 0, end)).toBe(false);
      expect(inGoalArea(line, 0, -end)).toBe(false);
      expect(GOAL_AREA_HALF_WIDTH).toBeCloseTo(9.16, 12);
    });

    it(`crossing zone attacking toward ${end}: last ${CROSS_ZONE_DEPTH} m, |z| >= ${CROSS_ZONE_MIN_Z}`, () => {
      const x0 = end * (HALF_LENGTH - CROSS_ZONE_DEPTH);
      expect(inCrossingZone(x0, CROSS_ZONE_MIN_Z, end)).toBe(true);
      expect(inCrossingZone(x0, -CROSS_ZONE_MIN_Z, end)).toBe(true);
      expect(inCrossingZone(x0 - end * E, 20, end)).toBe(false);
      expect(inCrossingZone(x0, CROSS_ZONE_MIN_Z - E, end)).toBe(false);
      expect(inCrossingZone(end * 50, 0, end)).toBe(false);
      expect(inCrossingZone(end * 50, 30, end)).toBe(true);
      expect(inCrossingZone(end * 50, 30, -end)).toBe(false);
    });
  }

  it('onPitch: lines included, margin shrinks', () => {
    expect(onPitch(HALF_LENGTH, HALF_WIDTH)).toBe(true);
    expect(onPitch(-HALF_LENGTH, -HALF_WIDTH)).toBe(true);
    expect(onPitch(HALF_LENGTH + E, 0)).toBe(false);
    expect(onPitch(0, -HALF_WIDTH - E)).toBe(false);
    expect(onPitch(HALF_LENGTH - 1, 0, 1)).toBe(true);
    expect(onPitch(HALF_LENGTH - 1 + E, 0, 1)).toBe(false);
    expect(onPitch(0, HALF_WIDTH + 1, -1)).toBe(true);
    expect(onPitch(NaN, 0)).toBe(false);
  });
});

describe('SIM-03 goal volume and mouth', () => {
  it('inGoalMouth: between the inner faces of the posts, under the bar (strict)', () => {
    expect(inGoalMouth(1, 0)).toBe(true);
    expect(inGoalMouth(GOAL_HEIGHT - E, GOAL_HALF_WIDTH - E)).toBe(true);
    expect(inGoalMouth(GOAL_HEIGHT - E, -GOAL_HALF_WIDTH + E)).toBe(true);
    expect(inGoalMouth(GOAL_HEIGHT, 0)).toBe(false);
    expect(inGoalMouth(1, GOAL_HALF_WIDTH)).toBe(false);
    expect(inGoalMouth(1, -GOAL_HALF_WIDTH)).toBe(false);
    expect(inGoalMouth(NaN, 0)).toBe(false);
  });

  for (const end of [1, -1]) {
    it(`insideGoal at end ${end}: whole ball over the line, inside the net box`, () => {
      expect(insideGoal(end * 53.5, 1, 0)).toBe(end);
      expect(insideGoal(end * (BALL_OUT_X + E), BALL_RADIUS, GOAL_HALF_WIDTH - E)).toBe(end);
      expect(insideGoal(end * BALL_OUT_X, 1, 0)).toBe(0); // only partly over the line
      expect(insideGoal(end * HALF_LENGTH, 1, 0)).toBe(0);
      expect(insideGoal(end * (HALF_LENGTH + GOAL_DEPTH - E), 1, 0)).toBe(end);
      expect(insideGoal(end * (HALF_LENGTH + GOAL_DEPTH), 1, 0)).toBe(0); // behind the back netting
      expect(insideGoal(end * 56, 1, 0)).toBe(0);
      expect(insideGoal(end * 53.5, GOAL_HEIGHT, 0)).toBe(0); // on / above the roof
      expect(insideGoal(end * 53.5, 1, GOAL_HALF_WIDTH)).toBe(0); // beside it (outside the side netting)
      expect(insideGoal(end * 53.5, 1, -5)).toBe(0);
      expect(insideGoal(end * 40, 1, 0)).toBe(0);
    });
  }

  it('penaltySpot: 11 m from each goal line', () => {
    expect(penaltySpot(1)).toBe(HALF_LENGTH - PENALTY_SPOT_DIST);
    expect(penaltySpot(-1)).toBe(-(HALF_LENGTH - PENALTY_SPOT_DIST));
    expect(penaltySpot(1)).toBe(41.5);
  });

  it('distToGoalMouth: to the goal-line segment between the posts', () => {
    expect(distToGoalMouth(HALF_LENGTH - 11, 0, 1)).toBeCloseTo(11, 12);
    expect(distToGoalMouth(HALF_LENGTH - 11, 3, 1)).toBeCloseTo(11, 12);
    expect(distToGoalMouth(HALF_LENGTH - 3, GOAL_HALF_WIDTH + 4, 1)).toBeCloseTo(5, 12);
    expect(distToGoalMouth(-HALF_LENGTH + 3, -GOAL_HALF_WIDTH - 4, -1)).toBeCloseTo(5, 12);
    expect(distToGoalMouth(HALF_LENGTH, 0, 1)).toBe(0);
    expect(distToGoalMouth(0, 0, 1)).toBeCloseTo(HALF_LENGTH, 12);
    expect(distToGoalMouth(0, 0, -1)).toBeCloseTo(HALF_LENGTH, 12);
    // Mirror symmetric, bit-identical.
    for (const [x, z] of [[10, 7], [40.25, -12.5], [52, 3.7]] as const) {
      expect(distToGoalMouth(-x, z, -1)).toBe(distToGoalMouth(x, z, 1));
      expect(distToGoalMouth(x, -z, 1)).toBe(distToGoalMouth(x, z, 1));
    }
  });

  it('isInOwnHalf: the halfway line counts as own half', () => {
    expect(isInOwnHalf(-10, 1)).toBe(true);
    expect(isInOwnHalf(10, 1)).toBe(false);
    expect(isInOwnHalf(10, -1)).toBe(true);
    expect(isInOwnHalf(-10, -1)).toBe(false);
    expect(isInOwnHalf(0, 1)).toBe(true);
    expect(isInOwnHalf(0, -1)).toBe(true);
  });
});

describe('SIM-03 clampToPitch', () => {
  const out = { x: 0, z: 0 };
  it('keeps points inside, clamps points outside (with margin)', () => {
    clampToPitch(10, -5, 0, out);
    expect(out).toEqual({ x: 10, z: -5 });
    clampToPitch(70, -50, 0, out);
    expect(out).toEqual({ x: HALF_LENGTH, z: -HALF_WIDTH });
    clampToPitch(-70, 50, 2, out);
    expect(out).toEqual({ x: -HALF_LENGTH + 2, z: HALF_WIDTH - 2 });
    clampToPitch(52, 33.5, 1, out);
    expect(out).toEqual({ x: HALF_LENGTH - 1, z: HALF_WIDTH - 1 });
  });

  it('never outputs NaN: NaN -> centre line, margin larger than the half-size -> 0', () => {
    clampToPitch(NaN, NaN, 1, out);
    expect(out).toEqual({ x: 0, z: 0 });
    clampToPitch(Infinity, -Infinity, 1, out);
    expect(out).toEqual({ x: HALF_LENGTH - 1, z: -HALF_WIDTH + 1 });
    clampToPitch(10, 10, 40, out);
    expect(out).toEqual({ x: 10, z: 0 });
    clampToPitch(10, 10, 60, out);
    expect(out).toEqual({ x: 0, z: 0 });
  });
});

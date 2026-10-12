/**
 * SIM-01 through the real step pipeline: a free ball's predictBall path equals what step() does to it, bit for bit,
 * for as long as nobody touches it (AI, keepers and rules all run). Also checks the flight stays finite and in bounds.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import { createBallPrediction } from '../../src/contracts/systems';
import { predictBall } from '../../src/sim/ball/flight';
import { makeScenario, runTicks } from '../harness/scenario';

describe('SIM-01 predictBall == step() for an untouched ball', () => {
  const cases: [string, number, Record<string, number>][] = [
    ['high ball over midfield', 11, { x: 0, y: 8, z: 0, vx: 6, vy: 14, vz: -3, sy: 4 }],
    ['curling lofted switch of play', 12, { x: -10, y: 3, z: 20, vx: 14, vy: 16, vz: -16, sy: -7 }],
    ['skied clearance with backspin', 13, { x: -30, y: 1.5, z: -5, vx: 12, vy: 22, vz: 2, sz: 9 }],
  ];
  for (const [name, seed, ball] of cases) {
    it(name, () => {
      const s = makeScenario({ seed, phase: MatchPhase.IN_PLAY, ball: { ...ball, grounded: 0, owner: -1, heldBy: -1 } });
      const pred = createBallPrediction();
      predictBall(s.ball, 120, pred);
      const touched = s.ball.touchedTick;
      let compared = 0;
      for (let i = 0; i < pred.count; i++) {
        runTicks(s, 1);
        const b = s.ball;
        if (b.touchedTick !== touched || b.owner >= 0 || b.heldBy >= 0 || s.match.phase !== MatchPhase.IN_PLAY) break;
        expect(Object.is(b.x, pred.x[i]) && Object.is(b.y, pred.y[i]) && Object.is(b.z, pred.z[i]),
          `tick ${i}: sim (${b.x}, ${b.y}, ${b.z}) vs predicted (${pred.x[i]}, ${pred.y[i]}, ${pred.z[i]})`).toBe(true);
        expect(b.x >= WORLD_MIN_X && b.x <= WORLD_MAX_X && b.z >= WORLD_MIN_Z && b.z <= WORLD_MAX_Z && b.y <= WORLD_MAX_Y).toBe(true);
        compared++;
      }
      // The ball is out of reach for at least its first second in the air.
      expect(compared).toBeGreaterThanOrEqual(60);
    });
  }
});

/**
 * SIM-02 + SIM-03 end to end (real ballTick + real detectCrossing): glitch list "Goals" lines -
 *  - not given when the ball crosses and bounces out, counted twice, given through the side netting;
 *  - Ball stuck resting on the goal line (never out, never a goal).
 * ballTick feeds every substep segment to detectCrossing before it flags inNet, so the scoring segment counts once.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { CrossKind, MatchPhase } from '../../src/contracts/enums';
import { createBallState, type BallState, type SimState } from '../../src/contracts/state';
import { T_BALL } from '../../src/contracts/tuning';
import { ballTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';
import { FR_R, FR_U, FR_Y, FR_Z, GB, GH, GL, GW, R } from './sim-02-helpers';

const G = T_BALL.gravity;
const S = makeScenario({ phase: MatchPhase.IN_PLAY });
const FRESH = createBallState();
const EV = createEventBuffer();

interface Crossings { goal: number; out: number; touch: number; first: CrossKind }

/** Run n ticks of ballTick (cross cleared each tick as step() does); count the crossings reported. */
function play(over: Partial<BallState>, n: number): { c: Crossings; s: SimState } {
  const s = S;
  Object.assign(s.ball, FRESH, over);
  if (over.y !== undefined && over.grounded === undefined) s.ball.grounded = over.y > R ? 0 : 1;
  const c: Crossings = { goal: 0, out: 0, touch: 0, first: CrossKind.NONE };
  for (let i = 0; i < n; i++) {
    s.tick++;
    EV.begin(s.tick);
    s.ball.cross = CrossKind.NONE;
    ballTick(s, EV);
    const k = s.ball.cross as CrossKind;
    if (k === CrossKind.GOAL) c.goal++;
    else if (k === CrossKind.GOAL_LINE) c.out++;
    else if (k === CrossKind.TOUCHLINE) c.touch++;
    if (k !== CrossKind.NONE && c.first === CrossKind.NONE) c.first = k;
  }
  return { c, s };
}

describe('Glitch: Goals counted twice / not given when the ball crosses and bounces out (SIM-02 + SIM-03)', () => {
  it('every shot that ends in the net is exactly one GOAL (sweep of speeds, angles, heights, both ends)', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (const sp of [10, 20, 30, 36, 40]) {
        for (let deg = -40; deg <= 40; deg += 10) {
          for (const tz of [-3.3, -1.5, 0, 1.5, 3.3]) {
            for (const ty of [0.3, 1.2, 2.2]) {
              const th = (deg * Math.PI) / 180;
              const d = 6;
              const T = d / sp;
              const { c, s } = play({
                x: end * (GL - Math.cos(th) * d), y: ty, z: tz - Math.sin(th) * d,
                vx: end * Math.cos(th) * sp, vy: (G * T) / 2, vz: Math.sin(th) * sp,
              }, 240);
              runs++;
              expect(s.ball.inNet).toBe(end);
              expect(c.goal).toBe(1);
              expect(c.out).toBe(0);
              expect(c.touch).toBe(0);
            }
          }
        }
      }
    }
    expect(runs).toBe(2 * 5 * 9 * 5 * 3);
  });

  it('shots off the inside of a post: GOAL exactly when the ball ends in the net, never both', () => {
    let goals = 0;
    let saved = 0;
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k <= 40; k++) {
          // Aim across the inner face of the post, from in-the-net to off-the-post.
          const zAim = side * (FR_Z - FR_R - 0.1 + (k / 40) * 0.3);
          for (const deg of [-25, 0, 25]) {
            const th = (side * deg * Math.PI) / 180;
            const d = 8;
            const sp = 28;
            const T = d / sp;
            const { c, s } = play({
              x: end * (FR_U - Math.cos(th) * d), y: 0.9, z: zAim - Math.sin(th) * d,
              vx: end * Math.cos(th) * sp, vy: (G * T) / 2, vz: Math.sin(th) * sp,
            }, 240);
            if (s.ball.inNet === end) { goals++; expect(c.goal).toBe(1); } else { saved++; expect(c.goal).toBe(0); }
            expect(c.goal + c.out + c.touch).toBeLessThanOrEqual(1);
          }
        }
      }
    }
    expect(goals).toBeGreaterThan(20);
    expect(saved).toBeGreaterThan(20);
  });

  it('a ball off the underside of the bar that drops behind the line is one GOAL; one that comes back out is none', () => {
    let goal = 0;
    let none = 0;
    for (const end of [-1, 1]) {
      for (let vy = 5; vy <= 8.5; vy += 0.05) {
        const { c, s } = play({ x: end * (GL - 6), y: 1.2, z: 0.4, vx: end * 30, vy }, 240);
        if (s.ball.inNet === end) { goal++; expect(c.goal).toBe(1); } else expect(c.goal).toBe(0);
        if (c.goal === 0 && c.out === 0) none++;
      }
    }
    expect(goal).toBeGreaterThan(4);
    expect(none).toBeGreaterThan(4);
  });
});

describe('Glitch: Goals given through the side netting (SIM-02 + SIM-03)', () => {
  it('shots into the side netting, roof and back from outside are never a GOAL (sweep)', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (const sp of [8, 20, 36]) {
          for (let deg = -60; deg <= 60; deg += 15) {
            for (const tu of [GL + 0.05, GL + 1, GB - 0.05]) {
              for (const ty of [R, 1.2, GH - 0.1]) {
                const th = (deg * Math.PI) / 180;
                const dz = -side * Math.cos(th);
                const du = Math.sin(th);
                const d = 3;
                const T = d / sp;
                const x = end * (tu - du * d);
                const z = side * GW - dz * d;
                // Start outside the side netting AND outside the goal mouth corridor (beyond the post line).
                if (Math.abs(z) <= GW + 0.5) continue;
                runs++;
                const { c, s } = play({ x, y: ty, z, vx: end * du * sp, vy: ty > R ? (G * T) / 2 : 0, vz: dz * sp }, 180);
                expect(c.goal).toBe(0);
                expect(s.ball.inNet).toBe(0);
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(200);
    // Lobs dropping onto the roof from in front of the goal.
    for (const end of [-1, 1]) {
      for (let k = 0; k < 30; k++) {
        const { c, s } = play({
          x: end * (GL - 3 - (k % 5)), y: 1, z: -3 + (k % 7), vx: end * (5 + (k % 4)), vy: 7 + (k % 3), vz: 0,
        }, 240);
        if (s.ball.inNet === end) expect(c.goal).toBe(1);
        else expect(c.goal).toBe(0);
      }
    }
  });
});

describe('Glitch: Ball stuck resting on the goal line (SIM-02 + SIM-03)', () => {
  it('a ball resting on or rolling onto the goal line is neither out nor a goal', () => {
    for (const end of [-1, 1]) {
      for (const z of [-3.3, 0, 2.2, 10, -25]) {
        for (const du of [-R, 0, R]) {
          const { c, s } = play({ x: end * (HALF_LENGTH + du), y: R, z }, 120);
          expect(c.goal + c.out + c.touch).toBe(0);
          expect(s.ball.x).toBe(end * (HALF_LENGTH + du));
        }
      }
    }
  });

  it('the bar and posts never let a ball count from on top: a ball rolling off the roof is out, not a goal', () => {
    for (const end of [-1, 1]) {
      const { c } = play({ x: end * FR_U, y: FR_Y + FR_R, z: 1, grounded: 0 }, 600);
      expect(c.goal).toBe(0);
    }
  });
});

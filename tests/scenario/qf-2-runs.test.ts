/**
 * [QF-2] QA-18 attacking movement: the box is attacked with the carrier in the central final third, not only for a
 * cross (TAI-03 boxAttackDepth). Before, with the carrier 20-30 m out centrally, one teammate on average was in the
 * box and one ahead of the ball.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { AiJob, MatchPhase, Role, TeamPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { resetJobs } from '../../src/ai/jobs';
import { assignRuns, LOCAL_TUNING as T } from '../../src/ai/runs';
import { NULL_SINK } from '../../src/sim/core/events';
import { secondLastDefenderX } from '../../src/sim/core/query';
import { makeScenario } from '../harness/scenario';

type Spot = [number, Role, number, number];
/** Home 4-4-2 attacking +x: the CM carrier 7 central, forwards on the back line, the rest behind the ball. */
const HOME: Spot[] = [
  [0, Role.GK, -45, 0], [1, Role.RB, 5, 24], [2, Role.CB, -5, 8], [3, Role.CB, -5, -8], [4, Role.LB, 5, -24],
  [5, Role.RM, 20, 25], [6, Role.CM, 16, 6], [7, Role.CM, 0, 0], [8, Role.LM, 20, -25], [9, Role.ST, 34, 5], [10, Role.ST, 34, -5],
];
/** Away back four on x = 36, midfield at 30, keeper at 50. */
const AWAY: Spot[] = [
  [11, Role.GK, 50, 0], [12, Role.RB, 36, -15], [13, Role.CB, 36, -5], [14, Role.CB, 36, 5], [15, Role.LB, 36, 15],
  [16, Role.RM, 30, -18], [17, Role.CM, 30, -6], [18, Role.CM, 30, 6], [19, Role.LM, 30, 18], [20, Role.ST, 10, -8], [21, Role.ST, 10, 8],
];

function scene(carrierX: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  for (const [slot, role, x, z] of [...HOME, ...AWAY]) {
    const p = s.players[slot]!;
    p.role = role; p.isKeeper = role === Role.GK ? 1 : 0;
    p.x = slot === 7 ? carrierX : x; p.z = z; p.homeX = p.x; p.homeZ = z; p.vx = 0; p.vz = 0;
    p.fx = slot < 11 ? 1 : -1; p.fz = 0; p.moveMode = MoveMode.STOP;
  }
  const c = s.players[7]!;
  const b = s.ball;
  b.owner = 7; b.x = c.x + 0.5; b.z = c.z; b.px = b.x; b.pz = b.z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
  b.lastTouch = 7; b.lastTouchTeam = 0; b.passTarget = -1;
  s.ctrl[2]!.slot = 7; c.ctrl = 2;
  s.teams[0]!.phase = TeamPhase.ATTACK;
  s.teams[1]!.phase = TeamPhase.DEFEND;
  return s;
}

const RUNS = [AiJob.RUN_IN_BEHIND, AiJob.LATE_RUN];
const inBoxZone = (x: number, z: number): boolean =>
  x >= HALF_LENGTH - PENALTY_AREA_DEPTH - T.lateStageDepth && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH + 2;

describe('QF-2 TAI-03 box attack from the central final third', () => {
  it('carrier 26 m out centrally: forwards and a late runner head for the box spots, onside', () => {
    const s = scene(HALF_LENGTH - 26);
    resetJobs(s, 0);
    assignRuns(s, 0, NULL_SINK);
    const runners: number[] = [];
    for (let i = 1; i < 11; i++) if (RUNS.includes(s.players[i]!.job)) runners.push(i);
    expect(runners.length).toBeGreaterThanOrEqual(3);
    expect(runners).toEqual(expect.arrayContaining([9, 10]));
    // A midfielder arrives late (only the box attack gives LATE_RUN in open play).
    expect(runners.some((i) => s.players[i]!.job === AiJob.LATE_RUN)).toBe(true);
    const line = secondLastDefenderX(s, 1);
    for (const i of runners) {
      const p = s.players[i]!;
      expect(inBoxZone(p.tgtX, p.tgtZ), `runner ${i} -> (${p.tgtX.toFixed(1)}, ${p.tgtZ.toFixed(1)})`).toBe(true);
      // Onside before the pass: never beyond the opponents' second-last defender.
      expect(p.tgtX).toBeLessThanOrEqual(Math.max(line, s.ball.x) + 1e-9);
    }
  });

  it('carrier 40 m out (beyond boxAttackDepth): no box attack, the usual open-play runs', () => {
    const s = scene(HALF_LENGTH - 40);
    resetJobs(s, 0);
    assignRuns(s, 0, NULL_SINK);
    expect(T.boxAttackDepth).toBeLessThan(40);
    for (let i = 1; i < 11; i++) expect(s.players[i]!.job).not.toBe(AiJob.LATE_RUN);
  });
});

/**
 * [QF-1] QA-02 goal-line and touchline detection in the real pipeline: crossings at every speed and angle, the
 * restart going to the right team, and no ball contact after the ball is already out.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

/** Park every player except `keep` far from the ball (spread so nobody overlaps). */
function parkOthers(s: SimState, keep: readonly number[]): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i)) continue;
    const p = s.players[i]!;
    p.x = i < 11 ? -20 - (i % 11) * 2 : 20 + (i % 11) * 2;
    p.z = -10 + (i % 11) * 2;
    p.vx = 0; p.vz = 0;
  }
}

describe('QF-1 QA-02 nobody touches a ball that is already out', () => {
  for (const vz of [0.6, 1, 2, 4, 8]) {
    it(`glitch restart given to the wrong team — an opponent at the touchline cannot pick up a ball already over it (${vz} m/s)`, () => {
      // Team 0 (slot 5) touched it last and it rolls over the near touchline; team 1's slot 14 stands just inside.
      const s = makeScenario({
        phase: MatchPhase.IN_PLAY,
        ball: { x: 0, y: BALL_RADIUS, z: HALF_WIDTH + BALL_RADIUS - 0.005, vz, lastTouch: 5, lastTouchTeam: 0, lastTouchTick: 0 },
        players: [{ slot: 14, x: 0, z: HALF_WIDTH - 0.4, vx: 0, vz: 0, fx: 0, fz: 1 }],
      });
      parkOthers(s, [14]);
      const ev = runTicks(s, 3, undefined, { check: 'core' });
      const aw = findEvents(ev, EventType.RESTART_AWARDED);
      expect(aw).toHaveLength(1);
      expect(aw[0]!.a).toBe(RestartKind.THROW_IN);
      expect(aw[0]!.b).toBe(1);
      expect(s.ball.lastTouch).toBe(5);
    });
  }

  it('glitch restart given to the wrong team — a defender beside the post cannot turn a goal kick into a corner', () => {
    // Team 0 attacks +x; its slot 9 shot wide; team 1's defender (slot 13) stands on the goal line next to the post.
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      ball: { x: HALF_LENGTH + BALL_RADIUS - 0.01, y: BALL_RADIUS, z: 4.6, vx: 3, lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 0 },
      players: [{ slot: 13, x: HALF_LENGTH - 0.45, z: 4.9, vx: 0, vz: 0, fx: 1, fz: 0 }],
    });
    parkOthers(s, [13]);
    const ev = runTicks(s, 3, undefined, { check: 'core' });
    const aw = findEvents(ev, EventType.RESTART_AWARDED);
    expect(aw).toHaveLength(1);
    expect(aw[0]!.a).toBe(RestartKind.GOAL_KICK);
    expect(aw[0]!.b).toBe(1);
  });

  it('a keeper standing in his goal does not become the scorer of a ball already over the line', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      ball: { x: HALF_LENGTH + BALL_RADIUS - 0.01, y: 0.5, z: 0.4, vx: 4, vy: 0, lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 0, grounded: 0 },
      players: [{ slot: 11, x: HALF_LENGTH + 0.5, z: 0.4, vx: 0, vz: 0, fx: -1, fz: 0 }],
    });
    parkOthers(s, [11]);
    const ev = runTicks(s, 3);
    const goals = findEvents(ev, EventType.GOAL);
    expect(goals).toHaveLength(1);
    expect(goals[0]!.a).toBe(0);
    expect(goals[0]!.b).toBe(9);
    expect(goals[0]!.d).toBe(0);
    expect(s.match.phase).toBe(MatchPhase.GOAL);
  });
});

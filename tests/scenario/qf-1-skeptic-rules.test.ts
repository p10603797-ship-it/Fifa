/**
 * [QF-1 skeptic] Rule cases the first QF-1 pass did not attack, through the real pipeline.
 *  - QA-02 / QA-06: an own goal straight from a restart kick is no goal (Laws 13, 16, 17: corner to the opponents).
 *    Free kicks and corners are struck with pass / shot kinds, so only goal kicks and kick-offs were caught.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

/** Park every player except `keep` far from the ball (spread so nobody overlaps). */
function parkOthers(s: SimState, keep: readonly number[]): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i)) continue;
    const p = s.players[i]!;
    p.x = i < 11 ? 10 + (i % 11) * 2 : 25 + (i % 11) * 2;
    p.z = 25 - (i % 11) * 2;
    p.vx = 0; p.vz = 0;
  }
}

/**
 * Team 0 (attacking +x, own goal at -x) has just taken a `from` restart with slot 4 (one tick ago): the ball runs at
 * 25 m/s into `end`'s goal, nobody else near it. `touched` = a teammate (slot 6) touched it after the kick.
 */
function restartKickInto(from: MatchPhase, end: number, kind: KickKind, touched = false): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, match: { periodT: 2000 } });
  s.tick = 100;
  const m = s.match;
  m.prevPhase = from;
  m.phaseT = 1;
  m.restart.taker = 4;
  m.restart.kind = RestartKind.NONE;
  const b = s.ball;
  b.x = end * (HALF_LENGTH - 6); b.y = 0.11; b.z = 0.5; b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = end * 25; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1; b.grounded = 1;
  b.lastKickBy = 4; b.lastKickTeam = 0; b.lastKickKind = kind; b.lastKickTick = 99;
  b.lastTouch = 4; b.lastTouchTeam = 0; b.lastTouchTick = 99; b.touchedTick = 99;
  s.players[4]!.lastTouchTick = 99;
  if (touched) {
    b.lastTouch = 6; b.lastTouchTick = 99; b.lastKickBy = 4;
    s.players[6]!.lastTouchTick = 99;
  }
  parkOthers(s, []);
  return s;
}

function outcome(s: SimState): { goals: number; awards: { kind: number; team: number }[] } {
  const ev = runTicks(s, 30, undefined, {
    check: 'core', until: (_st, e) => e.some((x) => x.type === EventType.GOAL || x.type === EventType.RESTART_AWARDED),
  });
  return {
    goals: findEvents(ev, EventType.GOAL).length,
    awards: findEvents(ev, EventType.RESTART_AWARDED).map((e) => ({ kind: e.a, team: e.b })),
  };
}

describe('QF-1 skeptic: own goal straight from a restart kick', () => {
  for (const [from, kind] of [
    [MatchPhase.FREE_KICK, KickKind.GROUND_PASS], [MatchPhase.FREE_KICK, KickKind.FREE_KICK_SHOT],
    [MatchPhase.CORNER, KickKind.CROSS], [MatchPhase.GOAL_KICK, KickKind.GROUND_PASS],
  ] as [MatchPhase, KickKind][]) {
    it(`a ${MatchPhase[from]} struck (${KickKind[kind]}) straight into the kicker's own goal is no goal: corner to the opponents`, () => {
      const s = restartKickInto(from, -1, kind);
      const o = outcome(s);
      expect(o.goals).toBe(0);
      expect(o.awards).toEqual([{ kind: RestartKind.CORNER, team: 1 }]);
      expect(s.teams[1]!.goals).toBe(0);
    });
  }

  it('a free kick struck straight into the opponents\' goal counts (all free kicks are direct)', () => {
    const s = restartKickInto(MatchPhase.FREE_KICK, 1, KickKind.FREE_KICK_SHOT);
    const o = outcome(s);
    expect(o.goals).toBe(1);
    expect(s.teams[0]!.goals).toBe(1);
  });

  it('an own goal after a teammate touched the free kick counts', () => {
    const s = restartKickInto(MatchPhase.FREE_KICK, -1, KickKind.GROUND_PASS, true);
    const o = outcome(s);
    expect(o.goals).toBe(1);
    expect(s.teams[1]!.goals).toBe(1);
  });

  it('an own goal from open play (the previous restart long ago) still counts', () => {
    const s = restartKickInto(MatchPhase.FREE_KICK, -1, KickKind.GROUND_PASS);
    s.match.phaseT = 400; // the free kick was 400 ticks ago; this kick (tick 99) was a later one by the same player
    const o = outcome(s);
    expect(o.goals).toBe(1);
  });
});

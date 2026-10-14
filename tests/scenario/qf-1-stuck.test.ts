/**
 * [QF-1] QA-01 ball-stuck scenarios and the goal glitches of BRIEF §14, through the real pipeline (bot v bot, team AI,
 * keepers, contacts, rules, watchdog): every stuck ball resolves within a bounded time without the watchdog.
 * (SIM-02's physics-only versions are in tests/unit/sim-02-glitches.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, BOARD_X, BOARD_Z, GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH,
  POST_RADIUS,
} from '../../src/contracts/constants';
import { CrossKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { BallState, SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

const R = BALL_RADIUS;
const GL = HALF_LENGTH;

/** Bot-v-bot match in play; team 0 attacks +x; the ball as given, last touched by team 0's slot 9. */
function inPlay(ball: Partial<BallState>, seed = 5): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, match: { periodT: 600 },
    ball: { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 0, ...ball },
  });
  s.players[9]!.lastTouchTick = 0;
  return s;
}

interface Outcome { events: SimEvent[]; resolvedAt: number; how: 'touch' | 'restart' | 'none' }

/** Run until a player touches the ball or a restart is awarded (or `max` ticks); the watchdog must stay silent. */
function resolve(s: SimState, max: number): Outcome {
  const start = s.tick;
  let how: Outcome['how'] = 'none';
  const events = runTicks(s, max, undefined, {
    check: 'core',
    until: (st, ev) => {
      if (ev.some((e) => e.type === EventType.RESTART_AWARDED)) { how = 'restart'; return true; }
      if (st.ball.lastTouchTick > start) { how = 'touch'; return true; }
      return false;
    },
  });
  expect(findEvents(events, EventType.WATCHDOG)).toEqual([]);
  return { events, resolvedAt: s.tick - start, how };
}

describe('QF-1 QA-01 ball stuck (real pipeline)', { timeout: 600_000 }, () => {
  it('glitch ball stuck on the roof of the net — a ball dropped on the roof in play rolls off and play restarts within 4 s', () => {
    for (const end of [1, -1]) {
      for (const du of [0.0, 0.04, 0.08, R]) {
        for (const z of [0, 1.5, -3.4]) {
          // On the front edge of the roof with the ball not yet wholly over the line: still in play while it sits there.
          // (Further back it is out of play and could only have got there by crossing the line: next test.)
          const s = inPlay({ x: end * (GL + du), y: GOAL_HEIGHT + R + 0.05, z, vx: 0, vy: 0, vz: 0, grounded: 0 });
          const o = resolve(s, 240);
          expect(o.how, `end ${end} du ${du} z ${z}`).not.toBe('none');
          expect(s.ball.y < GOAL_HEIGHT || s.match.phase !== MatchPhase.IN_PLAY).toBe(true);
          if (o.how === 'restart') {
            const aw = findEvents(o.events, EventType.RESTART_AWARDED)[0]!;
            // Over the goal line outside the goal: goal kick (team 0 touched it last attacking +x) or corner at -x.
            expect([RestartKind.GOAL_KICK, RestartKind.CORNER]).toContain(aw.a);
            expect(findEvents(o.events, EventType.GOAL)).toEqual([]);
          }
        }
      }
    }
  });

  it('glitch ball stuck on the roof of the net — a lob onto the roof is a goal kick at once, and the ball is back on the spot for it', () => {
    // Over the bar (2.8 m at the line) and down onto the roof ~0.6 m behind it.
    const s = inPlay({ x: GL - 4, y: 2, z: 1, vx: 6, vy: 4.5, vz: 0, grounded: 0 });
    const ev = runTicks(s, 180, undefined, { check: 'core', until: (st) => st.match.phase === MatchPhase.GOAL_KICK && st.match.restart.ready === 1 });
    expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
    expect(findEvents(ev, EventType.GOAL)).toEqual([]);
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    expect(s.match.restart.team).toBe(1);
    expect(Math.abs(s.ball.x)).toBeLessThanOrEqual(GL - GOAL_AREA_DEPTH + 0.01);
    expect(s.ball.y).toBeLessThan(R + 0.01);
  });

  it('glitch ball stuck behind the goal — a ball rolling out behind the goal is a restart the tick it crosses, then placed on the spot', () => {
    for (const end of [1, -1]) {
      for (const z of [GOAL_HALF_WIDTH + 0.3, -(GOAL_HALF_WIDTH + 2), 12]) {
        const s = inPlay({ x: end * (GL + R - 0.02), y: R, z, vx: end * 1.5, vz: 0 });
        const o = resolve(s, 10);
        expect(o.how).toBe('restart');
        expect(o.resolvedAt).toBeLessThanOrEqual(2);
        const aw = findEvents(o.events, EventType.RESTART_AWARDED)[0]!;
        expect(aw.a).toBe(end === 1 ? RestartKind.GOAL_KICK : RestartKind.CORNER);
        // The ball goes back on the restart spot (inside the pitch) and the restart is taken: never left behind the net.
        const ev = runTicks(s, 600, undefined, { check: 'core', until: (st) => st.match.phase === MatchPhase.IN_PLAY });
        expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
        expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      }
    }
  });

  it('glitch ball stuck behind the goal — a shot over the bar that drops behind the net is a goal kick before it lands', () => {
    for (const end of [1, -1]) {
      for (const [vx, vy] of [[18, 8.5], [24, 9], [12, 9.2]] as [number, number][]) {
        const s = inPlay({ x: end * (GL - 14), y: 0.3, z: -1, vx: end * vx, vy, vz: 0.2, grounded: 0 }, 9);
        for (let i = 0; i < 22; i++) { const p = s.players[i]!; if (Math.abs(p.x) > GL - 20) p.x = Math.sign(p.x) * (GL - 20); }
        const o = resolve(s, 120);
        expect(o.how).toBe('restart');
        expect(findEvents(o.events, EventType.GOAL)).toEqual([]);
        const aw = findEvents(o.events, EventType.RESTART_AWARDED)[0]!;
        expect(aw.a).toBe(end === 1 ? RestartKind.GOAL_KICK : RestartKind.CORNER);
      }
    }
  });

  it('glitch ball wedged against a post or board — a ball at rest against the outside of a post at the goal line gets played or restarted', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        // Outside face of the post, centre still on the field side of the out-of-play plane.
        const zc = side * (GOAL_HALF_WIDTH + 2 * POST_RADIUS + R + 0.001);
        const s = inPlay({ x: end * (GL - POST_RADIUS), y: R, z: zc, vx: 0, vy: 0, vz: 0 });
        const o = resolve(s, T_RULES.ballIdleTicks - 30);
        expect(o.how, `end ${end} side ${side}`).not.toBe('none');
      }
    }
  });

  it('glitch ball wedged against a post or board — a ball rolled into the corner of the boards is a restart at once and comes back to the spot', () => {
    for (const [x, z] of [[BOARD_X - R - 0.01, BOARD_Z - R - 0.01], [-(BOARD_X - R - 0.01), -(BOARD_Z - R - 0.01)], [10, BOARD_Z - R - 0.01]] as [number, number][]) {
      // Rolling out over a line toward the boards: the crossing gives the restart; the boards stop the ball.
      const sx = Math.abs(x) > GL ? Math.sign(x) * (GL + R - 0.02) : x;
      const sz = Math.abs(z) > HALF_WIDTH ? Math.sign(z) * (HALF_WIDTH + R - 0.02) : z;
      const s = inPlay({ x: sx, y: R, z: sz, vx: Math.abs(x) > GL ? Math.sign(x) * 3 : 0, vz: Math.sign(z) * 3 });
      const o = resolve(s, 10);
      expect(o.how).toBe('restart');
      const ev = runTicks(s, 900, undefined, { check: 'core', until: (st) => st.match.phase === MatchPhase.IN_PLAY });
      expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(Math.abs(s.ball.x)).toBeLessThan(BOARD_X - 2);
      expect(Math.abs(s.ball.z)).toBeLessThan(BOARD_Z - 2);
    }
  });

  it('glitch ball resting on the goal line — a still ball on the line between the posts is no goal and is played within the idle limit', () => {
    for (const end of [1, -1]) {
      for (const z of [0, 2.5, -3.2]) {
        for (const u of [GL - R, GL, GL + R]) { // on the line, centre on it, centre exactly on the out-of-play plane
          const s = inPlay({ x: end * u, y: R, z, vx: 0, vy: 0, vz: 0 }, 11);
          const o = resolve(s, T_RULES.ballIdleTicks - 30);
          expect(findEvents(o.events, EventType.GOAL), `end ${end} z ${z} u ${u}`).toEqual([]);
          expect(o.how, `end ${end} z ${z} u ${u}`).not.toBe('none');
        }
      }
    }
  });
});

describe('QF-1 QA-02 goals through the real pipeline', { timeout: 600_000 }, () => {
  it('glitch goal given through the side netting — a ball driven into the side netting from outside is a goal kick, never a goal', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        for (const [vx, vz, vy] of [[6, -2, 0], [14, -5, 1], [25, -9, 2], [4, -1, 3]] as [number, number, number][]) {
          // From beside the goal, outside the post, toward the side netting (the ball's z stays outside the mouth until
          // the netting stops it).
          const s = inPlay({ x: end * (GL - 2), y: R + 0.2, z: side * (GOAL_HALF_WIDTH + 1.6), vx: end * vx, vy, vz: side * vz, grounded: 0 });
          const ev = runTicks(s, 120, undefined, { check: 'core', until: (st) => st.match.phase !== MatchPhase.IN_PLAY });
          expect(findEvents(ev, EventType.GOAL), `end ${end} side ${side} v ${vx},${vz}`).toEqual([]);
          expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
          if (s.match.phase !== MatchPhase.IN_PLAY) expect([MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.THROW_IN]).toContain(s.match.phase);
        }
      }
    }
  });

  it('a ball crossing into the goal mouth counts once at every speed and height (swept: 1..40 m/s)', () => {
    for (const end of [1, -1]) {
      for (const v of [2.5, 4, 10, 20, 30, 36, 40]) {
        for (const [z, y] of [[0, R], [2.5, 1], [-3.3, 2.1]] as [number, number][]) {
          const s = inPlay({ x: end * (GL - 0.5), y, z, vx: end * v, vy: 0, vz: 0, grounded: y <= R ? 1 : 0 });
          // Nobody can reach it: the keeper and everyone else far away.
          for (let i = 0; i < 22; i++) { const p = s.players[i]!; if (Math.abs(p.x) > GL - 12) p.x = Math.sign(p.x) * (GL - 12); }
          const ev = runTicks(s, 60, undefined, { check: 'core', until: (st) => st.match.phase !== MatchPhase.IN_PLAY });
          const goals = findEvents(ev, EventType.GOAL);
          expect(goals, `end ${end} v ${v} z ${z} y ${y}`).toHaveLength(1);
          expect(goals[0]!.a).toBe(end === 1 ? 0 : 1);
          expect(s.ball.cross === CrossKind.NONE || s.ball.cross === CrossKind.GOAL).toBe(true);
        }
      }
    }
  });
});

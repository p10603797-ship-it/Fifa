/**
 * RUL-01: ball over a line in play (goal / throw-in / goal kick / corner), scorer + assist + own goals, the goal
 * cut-scene flow (GOAL -> CELEBRATION -> REPLAY -> KICK_OFF, timings, skip, 12 s cap) and celebrations.
 *
 * SIM-03 line detection is still a stub, so crossings are injected right before rulesTick through a wrapper around
 * the lead's contactsTick (the real step() pipeline runs otherwise). awardRestart (RUL-11) is wrapped to record its
 * arguments and perform a minimal restart (fill match.restart + setPhase) so flows can continue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS } from '../../src/contracts/constants';
import {
  ActionKind, CardKind, ControllerKind, CrossKind, KickKind, MatchPhase, Period, RestartKind,
} from '../../src/contracts/enums';
import { EventType, WhistleKind, type EventSink, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { LOCAL_TUNING, rulesTick, setPhase } from '../../src/sim/rules/machine';
import { findEvents, makeScenario, runTicks, runUntil, type ScenarioOptions } from '../harness/scenario';

const hooks = vi.hoisted(() => ({
  beforeRules: null as null | ((s: SimState) => void),
  awards: [] as { kind: number; team: number; x: number; z: number; tick: number }[],
  cards: [] as { slot: number; kind: number }[],
  setPhase: null as null | ((s: SimState, to: number, ev: EventSink) => void),
}));

vi.mock('../../src/sim/contacts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/contacts')>();
  return {
    ...mod,
    contactsTick: (s: SimState, ev: EventSink) => {
      mod.contactsTick(s, ev);
      if (hooks.beforeRules) hooks.beforeRules(s);
    },
  };
});

vi.mock('../../src/sim/rules/restart', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/rules/restart')>();
  const PHASE_OF = [0, 1, 3, 4, 5, 6, 7];
  return {
    ...mod,
    awardRestart: (s: SimState, kind: number, team: number, x: number, z: number, ev: EventSink) => {
      hooks.awards.push({ kind, team, x, z, tick: s.tick });
      const r = s.match.restart;
      r.kind = kind; r.team = team; r.x = x; r.z = z; r.t = 0; r.ready = 0; r.taken = 0; r.taker = -1;
      s.ball.x = x; s.ball.z = z; s.ball.px = x; s.ball.pz = z; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
      s.ball.shotBy = -1;
      hooks.setPhase!(s, PHASE_OF[kind]!, ev);
    },
  };
});

vi.mock('../../src/sim/rules/fouls', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/rules/fouls')>();
  return { ...mod, showCard: (_s: SimState, slot: number, kind: number) => { hooks.cards.push({ slot, kind }); } };
});

hooks.setPhase = setPhase as (s: SimState, to: number, ev: EventSink) => void;

beforeEach(() => {
  hooks.beforeRules = null;
  hooks.awards.length = 0;
  hooks.cards.length = 0;
});

interface CrossSpec {
  kind: CrossKind;
  x: number;
  z: number;
  end: number;
  /** Ball touch history to set at the injection tick. */
  lastTouch?: number;
  kick?: KickKind;
  /** Ticks before the injection the last touch happened. */
  touchAgo?: number;
}

/** Inject a crossing on the first tick after `afterTick` (in the real pipeline, just before rulesTick). */
function injectAt(tick: number, c: CrossSpec): void {
  hooks.beforeRules = (s) => {
    if (s.tick !== tick) return;
    const b = s.ball;
    if (c.lastTouch !== undefined) {
      const ago = c.touchAgo ?? 3;
      const p = s.players[c.lastTouch]!;
      b.lastTouch = c.lastTouch;
      b.lastTouchTeam = p.team;
      b.lastTouchTick = s.tick - ago;
      p.lastTouchTick = s.tick - ago;
      if (c.kick !== undefined) {
        b.lastKickBy = c.lastTouch;
        b.lastKickTeam = p.team;
        b.lastKickKind = c.kick;
        b.lastKickTick = s.tick - ago;
      }
    }
    b.cross = c.kind;
    b.crossX = c.x;
    b.crossZ = c.z;
    b.crossEnd = c.end;
    b.x = c.x; b.z = c.z;
  };
}

/** IN_PLAY scenario well into the match (tick 5000, so touch history can lie in the past). */
function inPlay(opts: ScenarioOptions = {}): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    ball: { x: 40, y: 0.11, z: 0 },
    ...opts,
    match: { periodT: 1000, ...(opts.match ?? {}) },
  });
  s.tick = 5000;
  return s;
}

function phaseChanges(ev: readonly SimEvent[]): string[] {
  return findEvents(ev, EventType.PHASE_CHANGE).map((e) => `${e.tick}:${MatchPhase[e.a]}->${MatchPhase[e.b]}`);
}

// ================================================================ goals

describe('RUL-01 goals', () => {
  it('a goal counts once: score, scorer, assist, GOAL + WHISTLE(SHORT) + IN_PLAY -> GOAL in the same tick', () => {
    const s = inPlay();
    const t = s.tick + 5;
    injectAt(t, { kind: CrossKind.GOAL, x: HALF_LENGTH + 0.2, z: 1, end: 1, lastTouch: 9, touchAgo: 10 });
    hooks.beforeRules = ((inner) => (st: SimState) => {
      if (st.tick === t) st.players[7]!.lastTouchTick = st.tick - 80; // the pass before the shot
      inner!(st);
    })(hooks.beforeRules);
    const ev = runTicks(s, 6, undefined, { check: 'core' });
    expect(s.match.phase).toBe(MatchPhase.GOAL);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([1, 0]);
    const goals = findEvents(ev, EventType.GOAL);
    expect(goals).toHaveLength(1);
    expect([goals[0]!.tick, goals[0]!.a, goals[0]!.b, goals[0]!.c, goals[0]!.d]).toEqual([t, 0, 9, 7, 0]);
    expect(findEvents(ev, EventType.WHISTLE, (e) => e.tick === t).map((e) => e.a)).toEqual([WhistleKind.SHORT]);
    expect(phaseChanges(ev)).toEqual([`${t}:IN_PLAY->GOAL`]);
    const m = s.match;
    expect([m.goalTeam, m.goalScorer, m.goalAssist, m.goalOwn, m.goalTick, m.kickoffTeam]).toEqual([0, 9, 7, 0, t, 1]);
    expect(s.ball.owner).toBe(-1);
  });

  it('goals are given to the team attacking that end (second half, directions swapped)', () => {
    const s = inPlay({ match: { period: Period.SECOND_HALF }, teams: [{ dir: -1 }, { dir: 1 }] });
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: HALF_LENGTH + 0.2, z: 0, end: 1, lastTouch: 18 });
    runTicks(s, 3, undefined, { check: 'core' });
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([0, 1]);
    expect(s.match.goalScorer).toBe(18);
    expect(s.match.kickoffTeam).toBe(0);
  });

  it('glitch "goal counted twice": repeated GOAL crossings while the ball sits in the net count once', () => {
    const s = inPlay();
    const t = s.tick + 2;
    hooks.beforeRules = (st) => {
      if (st.tick < t || st.tick > t + 40) return;
      Object.assign(st.ball, { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: t - 3, cross: CrossKind.GOAL, crossX: 52.8, crossZ: 0, crossEnd: 1, x: 53 });
    };
    const ev = runTicks(s, 45, undefined, { check: 'core' });
    expect(findEvents(ev, EventType.GOAL)).toHaveLength(1);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([1, 0]);
  });

  it('glitch "goal not given when the ball crosses and bounces out": the goal stands from the crossing tick', () => {
    const s = inPlay();
    const t = s.tick + 2;
    hooks.beforeRules = (st) => {
      if (st.tick === t) Object.assign(st.ball, { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: t - 3, cross: CrossKind.GOAL, crossX: 52.7, crossZ: 2, crossEnd: 1, x: 52.7 });
      if (st.tick === t + 1) Object.assign(st.ball, { x: 51, vx: -8, inNet: 0 }); // spun back out off the stanchion
    };
    const ev = runTicks(s, 10, undefined, { check: 'core' });
    expect(findEvents(ev, EventType.GOAL)).toHaveLength(1);
    expect(s.teams[0]!.goals).toBe(1);
    expect(s.match.phase).toBe(MatchPhase.GOAL);
  });

  it('own goal: the defender who touched last is recorded, own = 1, no assist', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: HALF_LENGTH + 0.3, z: -2, end: 1, lastTouch: 13 });
    const ev = runTicks(s, 3, undefined, { check: 'core' });
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([1, 0]);
    const g = findEvents(ev, EventType.GOAL)[0]!;
    expect([g.a, g.b, g.c, g.d]).toEqual([0, 13, -1, 1]);
  });

  it('assist: none when the teammate touch is older than the window', () => {
    const s = inPlay();
    const t = s.tick + 3;
    hooks.beforeRules = (st) => {
      if (st.tick !== t) return;
      st.players[7]!.lastTouchTick = st.tick - 5 - LOCAL_TUNING.assistWindowTicks - 1;
      Object.assign(st.ball, { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: st.tick - 5, cross: CrossKind.GOAL, crossX: 52.7, crossZ: 0, crossEnd: 1 });
      st.players[9]!.lastTouchTick = st.tick - 5;
    };
    runTicks(s, 4);
    expect(s.match.goalAssist).toBe(-1);
  });

  it('assist: none when an opponent touched the ball between the pass and the goal', () => {
    const s = inPlay();
    const t = s.tick + 3;
    hooks.beforeRules = (st) => {
      if (st.tick !== t) return;
      st.players[7]!.lastTouchTick = st.tick - 100;
      st.players[12]!.lastTouchTick = st.tick - 50; // defender deflection / keeper parry
      Object.assign(st.ball, { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: st.tick - 5, cross: CrossKind.GOAL, crossX: 52.7, crossZ: 0, crossEnd: 1 });
      st.players[9]!.lastTouchTick = st.tick - 5;
    };
    runTicks(s, 4);
    expect(s.match.goalAssist).toBe(-1);
  });

  it('assist: the latest teammate touch wins; touches from before the previous goal never count', () => {
    const s = inPlay({ match: { goalTick: 1 } });
    const t = s.tick + 3;
    hooks.beforeRules = (st) => {
      if (st.tick !== t) return;
      st.match.goalTick = st.tick - 40; // previous goal 40 ticks ago
      st.players[6]!.lastTouchTick = st.tick - 60; // before the previous goal
      st.players[8]!.lastTouchTick = st.tick - 20;
      st.players[5]!.lastTouchTick = st.tick - 30;
      Object.assign(st.ball, { lastTouch: 9, lastTouchTeam: 0, lastTouchTick: st.tick - 5, cross: CrossKind.GOAL, crossX: 52.7, crossZ: 0, crossEnd: 1 });
      st.players[9]!.lastTouchTick = st.tick - 5;
    };
    runTicks(s, 4);
    expect(s.match.goalAssist).toBe(8);
  });

  it('a goal with nobody having touched the ball: scorer -1, not an own goal', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: -HALF_LENGTH - 0.3, z: 0, end: -1 });
    const ev = runTicks(s, 3, undefined, { check: 'core' });
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([0, 1]);
    const g = findEvents(ev, EventType.GOAL)[0]!;
    expect([g.a, g.b, g.c, g.d]).toEqual([1, -1, -1, 0]);
  });

  it('a pending advantage is played on at a goal: ADVANTAGE(0) and the pending card is shown to the offender', () => {
    const s = inPlay({ match: { advantage: { active: 1, team: 0, offender: 14, victim: 9, x: 30, z: 0, startTick: 1, card: CardKind.YELLOW, penalty: 0 } } });
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: 52.8, z: 0, end: 1, lastTouch: 9 });
    const ev = runTicks(s, 3);
    expect(s.match.advantage.active).toBe(0);
    expect(findEvents(ev, EventType.ADVANTAGE).map((e) => [e.a, e.b])).toEqual([[0, 0]]);
    expect(hooks.cards).toEqual([{ slot: 14, kind: CardKind.YELLOW }]);
    expect(s.match.phase).toBe(MatchPhase.GOAL);
  });

  it('a crossing is ignored outside IN_PLAY (cut-scenes, restart not yet taken)', () => {
    for (const phase of [MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.CORNER, MatchPhase.HALF_TIME]) {
      const s = makeScenario({ phase, match: { periodT: 1000, goalTick: 0 } });
      if (phase === MatchPhase.CORNER) s.match.restart.kind = RestartKind.CORNER;
      injectAt(s.tick + 1, { kind: CrossKind.GOAL, x: 52.8, z: 0, end: 1, lastTouch: 9 });
      const ev = runTicks(s, 1);
      expect(findEvents(ev, EventType.GOAL), MatchPhase[phase]).toHaveLength(0);
      expect(s.teams[0]!.goals).toBe(0);
      expect(hooks.awards).toHaveLength(0);
    }
  });
});

// ================================================================ glitch: no goal direct from a throw-in

describe('RUL-01 goals that may not stand', () => {
  it('glitch "goal scored direct from a throw-in": thrown into the opponents\' goal -> goal kick', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: 52.8, z: 1.5, end: 1, lastTouch: 9, kick: KickKind.THROW_IN });
    const ev = runTicks(s, 3, undefined, { check: 'core' });
    expect(findEvents(ev, EventType.GOAL)).toHaveLength(0);
    expect(s.teams[0]!.goals).toBe(0);
    expect(hooks.awards).toHaveLength(1);
    const a = hooks.awards[0]!;
    expect([a.kind, a.team]).toEqual([RestartKind.GOAL_KICK, 1]);
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
  });

  it('thrown straight into his own goal -> corner to the opponents', () => {
    const s = inPlay();
    // Team 1 defends +x in the first half; a team-1 thrower puts it straight into his own goal.
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: 52.8, z: -1, end: 1, lastTouch: 15, kick: KickKind.THROW_IN });
    runTicks(s, 3, undefined, { check: 'core' });
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([0, 0]);
    const a = hooks.awards[0]!;
    expect([a.kind, a.team]).toEqual([RestartKind.CORNER, 0]);
    expect(a.z).toBeLessThan(0);
  });

  it('a throw-in touched by anyone else before going in counts', () => {
    const s = inPlay();
    const t = s.tick + 2;
    hooks.beforeRules = (st) => {
      if (st.tick !== t) return;
      Object.assign(st.ball, {
        lastKickBy: 4, lastKickTeam: 0, lastKickKind: KickKind.THROW_IN, lastKickTick: st.tick - 30,
        lastTouch: 9, lastTouchTeam: 0, lastTouchTick: st.tick - 4, cross: CrossKind.GOAL, crossX: 52.8, crossZ: 0, crossEnd: 1,
      });
      st.players[9]!.lastTouchTick = st.tick - 4;
      st.players[4]!.lastTouchTick = st.tick - 30;
    };
    runTicks(s, 3);
    expect(s.teams[0]!.goals).toBe(1);
    expect(s.match.goalAssist).toBe(4);
  });

  it('an own goal straight from a goal kick or kick-off -> corner; into the opponents\' goal it counts', () => {
    for (const kick of [KickKind.GOAL_KICK, KickKind.KICK_OFF]) {
      const own = inPlay();
      injectAt(own.tick + 2, { kind: CrossKind.GOAL, x: -52.8, z: 0.5, end: -1, lastTouch: 2, kick });
      runTicks(own, 3);
      expect([own.teams[0]!.goals, own.teams[1]!.goals], KickKind[kick]).toEqual([0, 0]);
      expect(hooks.awards.at(-1)!.kind).toBe(RestartKind.CORNER);
      expect(hooks.awards.at(-1)!.team).toBe(1);
      const fair = inPlay();
      injectAt(fair.tick + 2, { kind: CrossKind.GOAL, x: 52.8, z: 0.5, end: 1, lastTouch: 2, kick });
      runTicks(fair, 3);
      expect(fair.teams[0]!.goals, KickKind[kick]).toBe(1);
    }
  });
});

// ================================================================ out of play

describe('RUL-01 out of play', () => {
  it('touchline: throw-in to the other team of the last toucher at the crossing point on that touchline', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.TOUCHLINE, x: 12.5, z: -HALF_WIDTH - 0.2, end: 0, lastTouch: 9 });
    runTicks(s, 3, undefined, { check: 'core' });
    expect(hooks.awards).toEqual([{ kind: RestartKind.THROW_IN, team: 1, x: 12.5, z: -HALF_WIDTH, tick: s.tick - 1 }]);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
  });

  it('touchline: x is clamped to the pitch length; last touch by team 1 -> team 0 throws', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.TOUCHLINE, x: 53.4, z: HALF_WIDTH + 0.4, end: 0, lastTouch: 17 });
    runTicks(s, 3);
    const a = hooks.awards[0]!;
    expect([a.kind, a.team, a.x, a.z]).toEqual([RestartKind.THROW_IN, 0, HALF_LENGTH, HALF_WIDTH]);
  });

  it('goal line: attackers touched last -> goal kick for the defenders, on the side it went out', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.GOAL_LINE, x: HALF_LENGTH + 0.2, z: 20, end: 1, lastTouch: 9 });
    runTicks(s, 3, undefined, { check: 'core' });
    const a = hooks.awards[0]!;
    expect([a.kind, a.team]).toEqual([RestartKind.GOAL_KICK, 1]);
    expect(a.x).toBeCloseTo(HALF_LENGTH - 5.5, 6);
    expect(a.z).toBeGreaterThan(0);
    expect(Math.abs(a.z)).toBeLessThanOrEqual(9.16);
  });

  it('goal line: defenders touched last -> corner for the attackers inside the arc on that side', () => {
    const s = inPlay();
    injectAt(s.tick + 2, { kind: CrossKind.GOAL_LINE, x: -HALF_LENGTH - 0.2, z: -15, end: -1, lastTouch: 3 });
    runTicks(s, 3, undefined, { check: 'core' });
    const a = hooks.awards[0]!;
    expect([a.kind, a.team]).toEqual([RestartKind.CORNER, 1]);
    const dx = a.x - -HALF_LENGTH, dz = a.z - -HALF_WIDTH;
    expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(1);
    expect(a.x).toBeGreaterThan(-HALF_LENGTH);
    expect(a.z).toBeGreaterThan(-HALF_WIDTH);
  });

  it('ball out straight from a restart kick in the same tick is handled (restart -> IN_PLAY -> new restart)', () => {
    const s = makeScenario({ phase: MatchPhase.THROW_IN, match: { periodT: 1000 } });
    s.match.restart.kind = RestartKind.THROW_IN;
    s.match.restart.team = 0;
    const t = s.tick + 2;
    hooks.beforeRules = (st) => {
      if (st.tick !== t) return;
      st.match.restart.taken = 1;
      Object.assign(st.ball, { lastTouch: 4, lastTouchTeam: 0, lastTouchTick: st.tick, cross: CrossKind.TOUCHLINE, crossX: -10, crossZ: 34.3, crossEnd: 0 });
    };
    const ev = runTicks(s, 3, undefined, { check: 'core' });
    expect(phaseChanges(ev)).toEqual([`${t}:THROW_IN->IN_PLAY`, `${t}:IN_PLAY->THROW_IN`]);
    expect(hooks.awards[0]!.team).toBe(1);
  });

  it('a restart taken returns to IN_PLAY and clears the restart kind', () => {
    const s = makeScenario({ phase: MatchPhase.CORNER, match: { periodT: 1000 } });
    s.match.restart.kind = RestartKind.CORNER;
    const t = s.tick + 4;
    hooks.beforeRules = (st) => { if (st.tick === t) st.match.restart.taken = 1; };
    const ev = runTicks(s, 5, undefined, { check: 'core' });
    expect(phaseChanges(ev)).toEqual([`${t}:CORNER->IN_PLAY`]);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
  });
});

// ================================================================ goal flow

function scoreAt(s: SimState, tick: number, scorer = 9): void {
  injectAt(tick, { kind: CrossKind.GOAL, x: 52.8, z: 0.5, end: s.teams[s.players[scorer]!.team]!.dir, lastTouch: scorer });
}

describe('RUL-01 goal sequence', () => {
  it('GOAL (1 s) -> CELEBRATION (4 s) -> REPLAY (replayTicks) -> KICK_OFF by the conceding team, within 12 s', () => {
    const s = inPlay({ config: { replaySeconds: 12 } });
    const g = s.tick + 2;
    scoreAt(s, g);
    const ev = runTicks(s, 2 + T_RULES.goalSequenceMaxTicks + 5, undefined, { check: 'all' });
    const c1 = g + T_RULES.goalPhaseTicks;
    const c2 = c1 + T_RULES.celebrationTicks;
    const c3 = c2 + T_RULES.replayTicks;
    expect(phaseChanges(ev)).toEqual([`${g}:IN_PLAY->GOAL`, `${c1}:GOAL->CELEBRATION`, `${c2}:CELEBRATION->REPLAY`, `${c3}:REPLAY->KICK_OFF`]);
    expect(c3 - g).toBeLessThanOrEqual(T_RULES.goalSequenceMaxTicks);
    expect(s.match.restart.kind).toBe(RestartKind.KICK_OFF);
    expect(s.match.restart.team).toBe(1);
    expect(s.match.kickoffTeam).toBe(1);
  });

  it('the replay length follows config.replaySeconds (3 s)', () => {
    const s = inPlay({ config: { replaySeconds: 3 } });
    const g = s.tick + 2;
    scoreAt(s, g);
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 800);
    expect(reached).toBe(true);
    expect(s.tick - g).toBe(T_RULES.goalPhaseTicks + T_RULES.celebrationTicks + 180);
  });

  it('replaySeconds = 0 skips the replay immediately (CELEBRATION -> REPLAY -> KICK_OFF in one tick)', () => {
    const s = inPlay({ config: { replaySeconds: 0 } });
    const g = s.tick + 2;
    scoreAt(s, g);
    const ev = runTicks(s, 2 + T_RULES.goalPhaseTicks + T_RULES.celebrationTicks + 2, undefined, { check: 'core' });
    const c2 = g + T_RULES.goalPhaseTicks + T_RULES.celebrationTicks;
    expect(phaseChanges(ev).slice(-2)).toEqual([`${c2}:CELEBRATION->REPLAY`, `${c2}:REPLAY->KICK_OFF`]);
  });

  it('a human SKIP press edge skips each cut-scene phase (one phase per press, no cascade)', () => {
    const s = inPlay({ humans: 1 });
    const g = s.tick + 2;
    scoreAt(s, g);
    const presses = new Set([g, g + 10, g + 11, g + 20, g + 30]); // g: same tick as the goal; g+11: held, no edge
    const ev = runTicks(s, 40, (tick, _st, out) => { if (presses.has(tick)) out[0]!.buttons = Btn.SKIP; }, { check: 'core' });
    expect(phaseChanges(ev)).toEqual([
      `${g}:IN_PLAY->GOAL`, `${g + 10}:GOAL->CELEBRATION`, `${g + 20}:CELEBRATION->REPLAY`, `${g + 30}:REPLAY->KICK_OFF`,
    ]);
  });

  it('a held SKIP (no new edge) does not skip; CPU controllers never skip', () => {
    const s = inPlay({ humans: 1 });
    const g = s.tick + 2;
    scoreAt(s, g);
    const ev = runTicks(s, 30, (tick, st, out) => {
      out[0]!.buttons = tick >= g - 1 ? Btn.SKIP : 0; // pressed before the goal and held
      st.teams[1]!.cpu.out.buttons = Btn.SKIP;
    });
    expect(phaseChanges(ev)).toEqual([`${g}:IN_PLAY->GOAL`]);
  });

  it('the whole goal sequence never exceeds goalSequenceMaxTicks, even with slow phases', () => {
    const s = inPlay({ config: { replaySeconds: 12 } });
    const g = s.tick + 2;
    scoreAt(s, g);
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 2000);
    expect(reached).toBe(true);
    expect(s.tick - g).toBeLessThanOrEqual(T_RULES.goalSequenceMaxTicks);
  });

  it('a goal when time is up: REPLAY -> HALF_TIME (first half) with PERIOD_END and a LONG whistle', () => {
    const s = inPlay({ match: { periodT: 14400, periodLen: 14400 }, config: { replaySeconds: 1 } });
    const g = s.tick + 1;
    scoreAt(s, g);
    const { events, reached } = runUntil(s, (st) => st.match.phase === MatchPhase.HALF_TIME, 800, undefined, 'core');
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.PERIOD_END).map((e) => e.a)).toEqual([Period.FIRST_HALF]);
    expect(findEvents(events, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.SHORT, WhistleKind.LONG]);
    expect(s.match.prevPhase).toBe(MatchPhase.REPLAY);
  });

  it('a late winner in the second half of a friendly: REPLAY -> FULL_TIME -> POST_MATCH with the scorer\'s team winning', () => {
    const s = inPlay({ match: { period: Period.SECOND_HALF, periodT: 14400, periodLen: 14400 }, teams: [{ dir: -1 }, { dir: 1 }], config: { replaySeconds: 0 } });
    scoreAt(s, s.tick + 1, 18);
    const { events, reached } = runUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 2000, undefined, 'core');
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.SHORT, WhistleKind.FINAL]);
    expect([s.match.winner, s.match.finished]).toEqual([1, 1]);
  });
});

// ================================================================ celebrations

describe('RUL-01 celebrations', () => {
  function celebrationState(seed = 5): SimState {
    const s = inPlay({
      seed,
      players: [
        { slot: 9, x: 54, z: 2 }, // the scorer ran past the goal line
        { slot: 10, x: 46, z: -4 }, { slot: 7, x: 45, z: 6 }, { slot: 6, x: 44, z: -8 }, { slot: 8, x: 43, z: 1 },
        { slot: 5, x: 10, z: 25 }, // too far to join (> 25 m)
        { slot: 13, x: 48, z: 3, act: ActionKind.FALLEN, actT: 0, actDur: 400 }, // fallen defender finishes his fall
      ],
    });
    scoreAt(s, s.tick + 2);
    runUntil(s, (st) => st.match.phase === MatchPhase.CELEBRATION, 200);
    return s;
  }

  it('scorer + nearby teammates CELEBRATE (variant 0..2), the conceding team is DEJECTED', () => {
    const s = celebrationState();
    const sc = s.players[9]!;
    expect(sc.act).toBe(ActionKind.CELEBRATE);
    expect(sc.actB).toBe(1);
    expect([0, 1, 2]).toContain(sc.actA);
    const joiners = [10, 7, 6, 8].filter((i) => s.players[i]!.act === ActionKind.CELEBRATE);
    expect(joiners).toHaveLength(LOCAL_TUNING.celebrateMaxJoin);
    for (const i of joiners) {
      expect(s.players[i]!.actSlot).toBe(9);
      expect([0, 1, 2]).toContain(s.players[i]!.actA);
    }
    expect(s.players[5]!.act).not.toBe(ActionKind.CELEBRATE);
    expect(s.players[0]!.act).not.toBe(ActionKind.CELEBRATE); // scoring keeper stays home
    for (let i = 11; i < 22; i++) {
      if (i === 13) expect(s.players[i]!.act).toBe(ActionKind.FALLEN);
      else expect(s.players[i]!.act, `slot ${i}`).toBe(ActionKind.DEJECTED);
    }
  });

  it('celebration variants are chosen by the seeded RNG (deterministic)', () => {
    const a = celebrationState(77);
    const b = celebrationState(77);
    const va = a.players.map((p) => (p.act === ActionKind.CELEBRATE ? p.actA : -1));
    const vb = b.players.map((p) => (p.act === ActionKind.CELEBRATE ? p.actA : -1));
    expect(va).toEqual(vb);
  });

  it('celebrating players are steered to a spot inside the pitch', () => {
    const s = celebrationState();
    runTicks(s, 2);
    const p = s.players[9]!;
    expect(p.act).toBe(ActionKind.CELEBRATE);
    expect(Math.abs(p.tgtX)).toBeLessThan(HALF_LENGTH);
    expect(Math.abs(p.tgtZ)).toBeLessThan(HALF_WIDTH);
    expect(p.tgtSpeed).toBeGreaterThan(0);
  });

  it('glitch "stay off the pitch after a celebration": every player is inside the pitch when it ends and at kick-off', () => {
    const s = celebrationState();
    // Hold the scorer outside the pitch (as if locomotion could not move him) to prove the end-of-action safety net.
    runTicks(s, T_RULES.celebrationTicks + 2, (_t, st) => {
      const p = st.players[9]!;
      if (p.act === ActionKind.CELEBRATE) { p.x = 54; p.vx = 0; }
    });
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      if (p.act === ActionKind.CELEBRATE || p.act === ActionKind.DEJECTED) continue;
      expect(Math.abs(p.x), `slot ${i}`).toBeLessThanOrEqual(HALF_LENGTH);
      expect(Math.abs(p.z), `slot ${i}`).toBeLessThanOrEqual(HALF_WIDTH);
    }
    expect(s.players[9]!.act).toBe(ActionKind.NONE);
    expect(Math.abs(s.players[9]!.x)).toBeLessThan(HALF_LENGTH);
    runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 1000);
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      expect(Math.abs(p.x)).toBeLessThan(HALF_LENGTH);
      expect(Math.abs(p.z)).toBeLessThan(HALF_WIDTH);
      expect(p.act).not.toBe(ActionKind.CELEBRATE);
      expect(p.act).not.toBe(ActionKind.DEJECTED);
    }
  });

  it('an own goal is celebrated by the scoring team\'s player nearest the ball', () => {
    const s = inPlay({ players: [{ slot: 10, x: 47, z: 1 }, { slot: 9, x: 30, z: 0 }] });
    injectAt(s.tick + 2, { kind: CrossKind.GOAL, x: 52.8, z: 0, end: 1, lastTouch: 12 });
    runUntil(s, (st) => st.match.phase === MatchPhase.CELEBRATION, 200);
    expect(s.players[10]!.act).toBe(ActionKind.CELEBRATE);
    expect(s.players[10]!.actB).toBe(1);
    expect(s.players[12]!.act).toBe(ActionKind.DEJECTED);
  });

  it('no-human match: a SKIP edge recorded in ctrl[0] (soak fast-forward) skips; with a human it does not', () => {
    // The resolver (SIM-15) records humanFrames[0].buttons into ctrl[0] in a no-human match; the machine reads
    // that record. Drive rulesTick directly so this checks the machine's side of the contract only.
    const tickRules = (st: SimState) => {
      const ev = createEventBuffer();
      st.tick++;
      ev.begin(st.tick);
      st.match.phaseT++;
      rulesTick(st, ev);
    };
    const s = makeScenario({ phase: MatchPhase.GOAL, match: { goalTick: 0 } });
    s.match.goalTick = s.tick;
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.NONE);
    tickRules(s);
    s.ctrl[0]!.prevButtons = 0;
    s.ctrl[0]!.buttons = Btn.SKIP;
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.CELEBRATION);
    s.ctrl[0]!.prevButtons = Btn.SKIP; // held: no edge
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.CELEBRATION);

    const h = makeScenario({ phase: MatchPhase.GOAL });
    h.match.goalTick = h.tick;
    h.ctrl[1]!.kind = ControllerKind.HUMAN; // P2 is the only human
    h.ctrl[1]!.side = 1;
    tickRules(h);
    h.ctrl[0]!.prevButtons = 0;
    h.ctrl[0]!.buttons = Btn.SKIP; // ctrl[0] is not a human here: ignored
    h.ctrl[2]!.prevButtons = 0;
    h.ctrl[2]!.buttons = Btn.SKIP; // CPU brain: ignored
    tickRules(h);
    expect(h.match.phase).toBe(MatchPhase.GOAL);
    h.ctrl[1]!.prevButtons = 0;
    h.ctrl[1]!.buttons = Btn.SKIP;
    tickRules(h);
    expect(h.match.phase).toBe(MatchPhase.CELEBRATION);
  });
});

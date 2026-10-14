/**
 * FND-06: invariant checker (brief section 14 point 1). A fresh match passes every check; each handcrafted
 * violation is caught with a message naming the tick and the ids involved.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase, ModeId, Period } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createMatchConfig, RosterStatus, type SimState } from '../../src/contracts/state';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import {
  createInvariantChecker, INVARIANT_LIMITS, INVARIANT_NAMES, INVARIANT_SETS, type InvariantChecker,
} from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';

function fresh(): SimState {
  return initMatch(createMatchConfig());
}

/** Events stamped with `tick`. Each entry: [type, a, b, c, d]. */
function events(tick: number, list: [EventType, number?, number?, number?, number?][] = []): EventBufferImpl {
  const ev = createEventBuffer();
  ev.begin(tick);
  for (const [type, a, b, c, d] of list) ev.emit(type, a, b, c, d);
  return ev;
}

/** Baseline check at the current tick, then advance one tick, mutate, and return the second check's messages. */
function afterTick(s: SimState, mutate: (s: SimState) => void, ev: [EventType, number?, number?, number?, number?][] = [], c: InvariantChecker = createInvariantChecker('all')): readonly string[] {
  c.check(s, events(s.tick));
  s.tick++;
  mutate(s);
  return c.check(s, events(s.tick, ev));
}

function joined(msgs: readonly string[]): string {
  return msgs.join('\n');
}

describe('FND-06 invariant checker: passing states', () => {
  it('a fresh initMatch state passes every invariant, twice in a row', () => {
    const s = fresh();
    const c = createInvariantChecker('all');
    expect(c.check(s, null)).toEqual([]);
    s.tick++;
    expect(c.check(s, events(s.tick))).toEqual([]);
    expect(c.total).toBe(0);
  });

  it('returns the same frozen empty array when everything passes (no allocation)', () => {
    const s = fresh();
    const c = createInvariantChecker('all');
    const a = c.check(s, null);
    s.tick++;
    const b = c.check(s, null);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('a legal transition with its PHASE_CHANGE event passes', () => {
    const s = fresh();
    const msgs = afterTick(s, (st) => { st.match.phase = MatchPhase.KICK_OFF; st.match.phaseT = 0; },
      [[EventType.PHASE_CHANGE, MatchPhase.PRE_MATCH, MatchPhase.KICK_OFF]]);
    expect(msgs).toEqual([]);
  });

  it('a goal with exactly one GOAL event and its IN_PLAY -> GOAL transition passes', () => {
    // A goal is legal only as the rules machine scores it: GOAL event + score + IN_PLAY -> GOAL in the same tick.
    const s = fresh();
    s.match.phase = MatchPhase.IN_PLAY;
    const msgs = afterTick(s, (st) => {
      st.teams[1]!.goals = 1;
      st.match.prevPhase = MatchPhase.IN_PLAY;
      st.match.phase = MatchPhase.GOAL;
      st.match.phaseT = 0;
    }, [[EventType.GOAL, 1, 15, -1, 0], [EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.GOAL]], createInvariantChecker(['score', 'phase', 'clock']));
    expect(msgs).toEqual([]);
  });

  it('a GOAL event outside a scoring transition fails, and so does entering GOAL without one', () => {
    const s = fresh(); // PRE_MATCH: no goal can be scored
    let msgs = afterTick(s, (st) => { st.teams[1]!.goals = 1; }, [[EventType.GOAL, 1, 15, -1, 0]]);
    expect(joined(msgs)).toContain('[score] 1 GOAL event(s) but 0 scoring transition(s) into GOAL (phase PRE_MATCH -> PRE_MATCH)');
    const s2 = fresh();
    s2.match.phase = MatchPhase.IN_PLAY;
    msgs = afterTick(s2, (st) => { st.match.phase = MatchPhase.GOAL; st.match.phaseT = 0; },
      [[EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.GOAL]], createInvariantChecker(['score']));
    expect(joined(msgs)).toContain('[score] play entered the GOAL phase without a GOAL event');
    // Same without the PHASE_CHANGE event: the transition is read from the previous tick's phase.
    const s3 = fresh();
    s3.match.phase = MatchPhase.IN_PLAY;
    msgs = afterTick(s3, (st) => { st.match.phase = MatchPhase.GOAL; }, [], createInvariantChecker(['score']));
    expect(joined(msgs)).toContain('[score] play entered the GOAL phase without a GOAL event');
  });

  it('named sets: core is a subset of all, all lists every invariant', () => {
    expect(INVARIANT_SETS.all).toEqual(INVARIANT_NAMES);
    for (const n of INVARIANT_SETS.core) expect(INVARIANT_SETS.all).toContain(n);
    expect(INVARIANT_SETS.core).toEqual(['finite', 'bounds', 'phase', 'owner', 'players', 'controllers', 'score', 'clock']);
  });
});

describe('FND-06 invariant checker: finite and bounds', () => {
  it('catches NaN with its state path and tick', () => {
    const s = fresh();
    s.tick = 42;
    s.players[3]!.x = NaN;
    const msgs = createInvariantChecker('core').check(s, null);
    expect(joined(msgs)).toContain('t=42 [finite] players[3].x=NaN');
  });

  it('catches Infinity inside nested arrays and non-numeric values', () => {
    const s = fresh();
    s.teams[1]!.homeX[4] = Infinity;
    (s.ball as unknown as Record<string, unknown>).spinTag = 'x';
    const msgs = joined(createInvariantChecker('core').check(s, null));
    expect(msgs).toContain('teams[1].homeX[4]=Infinity');
    expect(msgs).toContain('ball.spinTag=string (not a number)');
  });

  it('ignores config and squads (immutable, may hold strings)', () => {
    const s = fresh();
    expect(typeof s.squads[0]![0]!.name).toBe('string');
    expect(createInvariantChecker('core').check(s, null)).toEqual([]);
  });

  it('catches the ball and an active player outside the world bounds, and the ball below the grass', () => {
    const s = fresh();
    s.ball.x = 70;
    s.players[5]!.z = -50;
    let msgs = joined(createInvariantChecker('core').check(s, null));
    expect(msgs).toContain('[bounds] ball out of world bounds');
    expect(msgs).toContain('[bounds] player 5 out of world bounds');
    const s2 = fresh();
    s2.ball.y = -0.3;
    msgs = joined(createInvariantChecker('core').check(s2, null));
    expect(msgs).toContain('[bounds] ball out of world bounds');
  });
});

describe('FND-06 invariant checker: phase and transitions', () => {
  it('catches an invalid phase value', () => {
    const s = fresh();
    s.match.phase = 99 as MatchPhase;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('[phase] invalid phase 99');
  });

  // PRE_MATCH -> IN_PLAY became legal with D-013 (practice free play, test setups); PRE_MATCH -> CORNER never is.
  it('catches an illegal transition reported by PHASE_CHANGE (PRE_MATCH -> CORNER)', () => {
    const s = fresh();
    const msgs = afterTick(s, (st) => { st.match.phase = MatchPhase.CORNER; },
      [[EventType.PHASE_CHANGE, MatchPhase.PRE_MATCH, MatchPhase.CORNER]]);
    expect(joined(msgs)).toContain('illegal transition PRE_MATCH -> CORNER');
  });

  it('catches a phase change without a PHASE_CHANGE event', () => {
    const s = fresh();
    const msgs = afterTick(s, (st) => { st.match.phase = MatchPhase.KICK_OFF; });
    expect(joined(msgs)).toContain('phase changed PRE_MATCH -> KICK_OFF without a PHASE_CHANGE event');
  });

  it('catches a PHASE_CHANGE whose "from" is not the previous phase, and an event chain ending elsewhere', () => {
    const s = fresh();
    const msgs = joined(afterTick(s, (st) => { st.match.phase = MatchPhase.IN_PLAY; },
      [[EventType.PHASE_CHANGE, MatchPhase.KICK_OFF, MatchPhase.IN_PLAY]]));
    expect(msgs).toContain('PHASE_CHANGE from KICK_OFF but phase was PRE_MATCH');
    const s2 = fresh();
    const msgs2 = joined(afterTick(s2, (st) => { st.match.phase = MatchPhase.IN_PLAY; },
      [[EventType.PHASE_CHANGE, MatchPhase.PRE_MATCH, MatchPhase.KICK_OFF]]));
    expect(msgs2).toContain('phase is IN_PLAY but the last PHASE_CHANGE went to KICK_OFF');
  });

  it('accepts a chain of legal transitions within one tick', () => {
    const s = fresh();
    s.match.phase = MatchPhase.REPLAY;
    const msgs = afterTick(s, (st) => { st.match.phase = MatchPhase.IN_PLAY; }, [
      [EventType.PHASE_CHANGE, MatchPhase.REPLAY, MatchPhase.KICK_OFF],
      [EventType.PHASE_CHANGE, MatchPhase.KICK_OFF, MatchPhase.IN_PLAY],
    ]);
    expect(msgs).toEqual([]);
  });

  it('flags a phase past T_RULES.phaseMaxTicks (all set only)', () => {
    const s = fresh();
    s.match.phase = MatchPhase.GOAL;
    s.match.phaseT = 121;
    expect(joined(createInvariantChecker('all').check(s, null))).toContain('[phaseMax] GOAL lasted 121 ticks (max 120)');
    expect(createInvariantChecker('core').check(s, null)).toEqual([]);
    s.match.phase = MatchPhase.IN_PLAY; // 0 = unlimited
    s.match.phaseT = 1e6;
    expect(createInvariantChecker('all').check(s, null)).toEqual([]);
  });
});

describe('FND-06 invariant checker: ball owner', () => {
  it('catches two owners (owner and heldBy disagree)', () => {
    const s = fresh();
    s.ball.owner = 5;
    s.ball.heldBy = 0;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('two owners: ball.owner=5 but ball.heldBy=0');
  });

  it('catches an owner who is not on the pitch and a non-keeper holding the ball', () => {
    const s = fresh();
    s.ball.owner = 6;
    s.players[6]!.active = 0;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('ball owner 6 is not on the pitch');
    const s2 = fresh();
    s2.ball.owner = 4;
    s2.ball.heldBy = 4;
    expect(joined(createInvariantChecker('core').check(s2, null))).toContain('ball held in hands by non-keeper 4');
  });

  it('catches an out-of-range owner index without throwing', () => {
    const s = fresh();
    s.ball.owner = 40;
    expect(joined(createInvariantChecker('all').check(s, null))).toContain('invalid ball.owner 40');
  });
});

describe('FND-06 invariant checker: players', () => {
  it('catches 12 players after a substitution (12 PLAYING roster entries)', () => {
    const s = fresh();
    s.teams[0]!.roster[11] = RosterStatus.PLAYING;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('team 0 has 12 PLAYING roster entries but 11 active players');
  });

  it('catches a team below 7 players unless it forfeited', () => {
    const s = fresh();
    for (let slot = 12; slot <= 16; slot++) {
      s.players[slot]!.active = 0;
      s.teams[1]!.roster[s.players[slot]!.rosterIdx] = RosterStatus.SENT_OFF;
    }
    s.teams[1]!.onPitch = 6;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('team 1 has 6 players on the pitch (allowed 7..11)');
    s.match.forfeitTeam = 1;
    expect(createInvariantChecker('core').check(s, null)).toEqual([]);
  });

  it('practice mode may field a reduced side (free play against a keeper)', () => {
    const cfg = createMatchConfig();
    cfg.mode = ModeId.PRACTICE;
    const s = initMatch(cfg);
    for (let slot = 12; slot <= 21; slot++) s.players[slot]!.active = 0;
    s.teams[1]!.onPitch = 1;
    expect(createInvariantChecker('all').check(s, null)).toEqual([]);
    s.players[11]!.active = 0; // not even a keeper
    s.teams[1]!.onPitch = 0;
    expect(joined(createInvariantChecker('core').check(s, null))).toContain('team 1 has 0 players on the pitch (allowed 1..11)');
  });

  it('catches two keepers, a wrong keeperSlot and onPitch drift', () => {
    const s = fresh();
    s.players[4]!.isKeeper = 1;
    s.teams[1]!.keeperSlot = 13;
    s.teams[1]!.onPitch = 10;
    const msgs = joined(createInvariantChecker('core').check(s, null));
    expect(msgs).toContain('team 0 has 2 active keepers (expected 1)');
    expect(msgs).toContain('team 1 keeperSlot 13 is not an active keeper');
    expect(msgs).toContain('team 1 onPitch=10 but 11 players are active');
  });

  it('catches a sent-off player who still acts or is controlled, and a duplicated roster index', () => {
    const s = fresh();
    s.players[7]!.active = 0;
    s.teams[0]!.roster[7] = RosterStatus.SENT_OFF;
    s.teams[0]!.onPitch = 10;
    s.players[7]!.act = ActionKind.KICK;
    s.players[7]!.ctrl = 0;
    s.players[8]!.rosterIdx = 9;
    const msgs = joined(createInvariantChecker('core').check(s, null));
    expect(msgs).toContain('player 7 is off the pitch but acts (KICK)');
    expect(msgs).toContain('player 7 is off the pitch but controlled by 0');
    expect(msgs).toContain('team 0 roster 9 is on the pitch twice');
  });
});

describe('FND-06 invariant checker: controllers', () => {
  it('catches a controller on the wrong side, on an inactive player, and a broken back-reference', () => {
    const s = fresh();
    const cpu = s.ctrl[2]!; // CPU brain slot of team 0 (unused by default: P1 plays home), enabled here
    cpu.kind = ControllerKind.CPU;
    cpu.side = 0;
    cpu.slot = 15;
    s.players[15]!.ctrl = 2;
    let msgs = joined(createInvariantChecker('core').check(s, null));
    expect(msgs).toContain('controller 2 (side 0) controls player 15 of team 1');

    const s2 = fresh();
    s2.ctrl[0]!.slot = 9;
    s2.players[9]!.ctrl = 0;
    s2.players[9]!.active = 0;
    s2.teams[0]!.roster[9] = RosterStatus.SENT_OFF;
    s2.teams[0]!.onPitch = 10;
    msgs = joined(createInvariantChecker('core').check(s2, null));
    expect(msgs).toContain('controller 0 controls player 9 who is not on the pitch');

    const s3 = fresh();
    s3.ctrl[0]!.slot = 9;
    s3.players[9]!.ctrl = 1;
    msgs = joined(createInvariantChecker('core').check(s3, null));
    expect(msgs).toContain('controller 0 controls player 9 but player.ctrl=1');
  });

  it('allows a controller without a player briefly during play, then flags it', () => {
    const s = fresh();
    s.match.phase = MatchPhase.IN_PLAY;
    s.ctrl[0]!.slot = -1;
    const c = createInvariantChecker('core');
    const all: string[] = [];
    for (let i = 0; i <= INVARIANT_LIMITS.controllerGraceTicks + 1; i++) {
      s.tick++;
      all.push(...c.check(s, null));
    }
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toContain(`controller 0 (side 0) has controlled no player for ${INVARIANT_LIMITS.controllerGraceTicks + 1} ticks in IN_PLAY`);
  });
});

describe('FND-06 invariant checker: score and clock', () => {
  it('catches a goal without a GOAL event', () => {
    const s = fresh();
    const msgs = afterTick(s, (st) => { st.teams[0]!.goals = 1; });
    expect(joined(msgs)).toContain('[score] team 0 score changed by 1 with 0 GOAL event(s)');
  });

  it('catches a goal counted twice (two GOAL events, one goal) and twice the goals for one event', () => {
    const s = fresh();
    let msgs = afterTick(s, (st) => { st.teams[0]!.goals = 1; }, [[EventType.GOAL, 0, 9], [EventType.GOAL, 0, 9]]);
    expect(joined(msgs)).toContain('team 0 score changed by 1 with 2 GOAL event(s)');
    const s2 = fresh();
    msgs = afterTick(s2, (st) => { st.teams[1]!.goals = 2; }, [[EventType.GOAL, 1, 20]]);
    expect(joined(msgs)).toContain('team 1 score changed by 2 with 1 GOAL event(s)');
  });

  it('ignores stale events from another tick', () => {
    const s = fresh();
    const c = createInvariantChecker('core');
    c.check(s, null);
    s.tick++;
    s.teams[0]!.goals = 1;
    const stale = events(s.tick - 1, [[EventType.GOAL, 0, 9]]);
    expect(joined(c.check(s, stale))).toContain('score changed by 1 with 0 GOAL event(s)');
  });

  it('catches the clock running backwards and the period going backwards', () => {
    const s = fresh();
    s.match.periodT = 100;
    let msgs = afterTick(s, (st) => { st.match.periodT = 50; });
    expect(joined(msgs)).toContain('[clock] clock ran backwards in period 1: 100 -> 50');
    const s2 = fresh();
    s2.match.period = Period.SECOND_HALF;
    msgs = afterTick(s2, (st) => { st.match.period = Period.FIRST_HALF; });
    expect(joined(msgs)).toContain('period went backwards 2 -> 1');
  });

  it('catches the clock running during a cut-scene (all set)', () => {
    const s = fresh();
    s.match.phase = MatchPhase.CELEBRATION;
    s.match.periodT = 500;
    const msgs = afterTick(s, (st) => { st.match.periodT = 501; });
    expect(joined(msgs)).toContain('[clockStop] clock ran during CELEBRATION: 500 -> 501');
  });
});

describe('FND-06 invariant checker: actions, overlap, keeper, chaser (all set)', () => {
  it('catches an action past its tick budget, and not in the core set', () => {
    const s = fresh();
    const p = s.players[6]!;
    p.act = ActionKind.KICK;
    p.actDur = 10;
    p.actT = 10 + INVARIANT_LIMITS.actionSlackTicks + 1;
    expect(joined(createInvariantChecker('all').check(s, null))).toContain('player 6 in KICK past its budget: actT=13 actDur=10');
    expect(createInvariantChecker('core').check(s, null)).toEqual([]);
    p.actT = 12;
    expect(createInvariantChecker('all').check(s, null)).toEqual([]);
  });

  it('allows charging up to the limit, then flags it', () => {
    const s = fresh();
    const p = s.players[6]!;
    p.act = ActionKind.SHOT;
    p.actCharging = 1;
    p.actDur = 10;
    p.actT = 500;
    const c = createInvariantChecker('all');
    const msgs: string[] = [];
    for (let i = 0; i < INVARIANT_LIMITS.maxChargeTicks + 1; i++) {
      s.tick++;
      msgs.push(...c.check(s, null));
    }
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(`player 6 has charged SHOT for ${INVARIANT_LIMITS.maxChargeTicks + 1} ticks`);
  });

  it('catches two players overlapping for more than 60 consecutive ticks, not before', () => {
    const s = fresh();
    s.players[3]!.x = 10; s.players[3]!.z = 5;
    s.players[14]!.x = 10.2; s.players[14]!.z = 5;
    const c = createInvariantChecker('all');
    const counts: number[] = [];
    for (let i = 0; i < INVARIANT_LIMITS.overlapTicks + 1; i++) {
      s.tick++;
      counts.push(c.check(s, null).length);
    }
    expect(counts.slice(0, INVARIANT_LIMITS.overlapTicks).every((n) => n === 0)).toBe(true);
    expect(counts[INVARIANT_LIMITS.overlapTicks]).toBe(1);
    s.tick++;
    expect(joined(c.check(s, null))).toContain('players 3 (NONE) and 14 (NONE) overlap for 62 ticks');
    // Separating resets the counter.
    s.players[14]!.x = 12;
    s.tick++;
    expect(c.check(s, null)).toEqual([]);
  });

  it('catches a keeper holding the ball outside his own penalty area (IN_PLAY)', () => {
    const s = fresh();
    s.match.phase = MatchPhase.IN_PLAY;
    s.teams[0]!.chaser = 5;
    s.teams[1]!.chaser = 15;
    const k = s.players[0]!; // home keeper, team dir +1 -> own goal at x = -52.5
    s.ball.owner = 0;
    s.ball.heldBy = 0;
    k.x = -45; k.z = 3;
    s.ball.x = -44.6; s.ball.z = 3;
    expect(createInvariantChecker('all').check(s, null)).toEqual([]);
    k.x = -30; s.ball.x = -29.6;
    expect(joined(createInvariantChecker('all').check(s, null))).toContain('[keeperArea] keeper 0 holds the ball outside his own area');
    k.x = -54; s.ball.x = -53.8; // behind his own goal line
    expect(joined(createInvariantChecker('all').check(s, null))).toContain('[keeperArea]');
  });

  it('requires exactly one valid chaser per team while the ball is loose in play', () => {
    const s = fresh();
    s.match.phase = MatchPhase.IN_PLAY;
    s.ball.owner = -1;
    s.teams[0]!.chaser = 5;
    s.teams[1]!.chaser = -1;
    const c = createInvariantChecker('all');
    s.tick++;
    expect(c.check(s, null)).toEqual([]); // grace tick (AI runs before kicks)
    s.tick++;
    expect(joined(c.check(s, null))).toContain('[chaser] ball loose for 2 ticks but team 1 chaser is -1');
    s.teams[1]!.chaser = 3; // wrong team
    s.tick++;
    expect(joined(c.check(s, null))).toContain('team 1 chaser is 3');
    s.teams[1]!.chaser = 18;
    s.tick++;
    expect(c.check(s, null)).toEqual([]);
  });
});

describe('FND-06 invariant checker: bookkeeping', () => {
  it('counts every failure but returns at most messageLimit messages', () => {
    const s = fresh();
    s.match.phase = MatchPhase.GOAL;
    s.match.phaseT = 500;
    const c = createInvariantChecker('all', { messageLimit: 3 });
    let returned = 0;
    for (let i = 0; i < 10; i++) {
      s.tick++;
      returned += c.check(s, null).length;
    }
    expect(returned).toBe(3);
    expect(c.total).toBe(10);
    expect(c.counts.phaseMax).toBe(10);
    expect(c.counts.finite).toBe(0);
  });

  it('reset() forgets the previous tick and the counters', () => {
    const s = fresh();
    const c = createInvariantChecker('all');
    c.check(s, null);
    s.tick++;
    s.teams[0]!.goals = 1;
    expect(c.check(s, null).length).toBe(1);
    c.reset();
    expect(c.total).toBe(0);
    s.tick++;
    s.teams[0]!.goals = 2;
    expect(c.check(s, null)).toEqual([]); // no baseline after reset
  });

  it('re-baselines when the tick does not advance by one (new match / loaded state)', () => {
    const s = fresh();
    const c = createInvariantChecker('all');
    s.match.periodT = 100;
    c.check(s, null);
    s.tick = 500;
    s.match.periodT = 10;
    expect(c.check(s, null)).toEqual([]);
  });

  it('accepts an explicit list of invariant names', () => {
    const s = fresh();
    s.players[2]!.x = NaN;
    s.ball.x = 100;
    const c = createInvariantChecker(['bounds']);
    expect(c.names).toEqual(['bounds']);
    const msgs = c.check(s, null);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('[bounds] ball');
  });
});

/**
 * RUL-07 penalty shoot-out through the real step pipeline (RUL-01 entry, SIM-15/16 routing and switching, TAI-13
 * layout and CPU kickers, GKP keepers, RUL-11 watchdog). SIM-11 startShot / GKP-06 dives may still be Wave 1 stubs:
 * kicks with a known outcome are struck through core/kick applyKick by the shoot-out kicker (tests/scenario/
 * rul-07-helpers.ts), and the CPU flows complete through RUL-07's own safety nets until the real modules land.
 * The input contract with a working startShot is covered in rul-07-pipeline.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, CENTRE_CIRCLE_RADIUS, HALF_LENGTH, NUM_SLOTS, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM,
  teamFirstSlot,
} from '../../src/contracts/constants';
import { GestureKind, MatchPhase, ModeId, Period, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType, WhistleKind, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MAX_SHOOTOUT_KICKS, RosterStatus, type ShootoutState, type SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { recordTouch } from '../../src/sim/core/kick';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { keeperPickUp } from '../../src/sim/keeper/handling';
import {
  KICK_MISSED, KICK_SCORED, LOCAL_TUNING as LT, ShootoutSub, shootoutDecided, shootoutEnd, shootoutKeeperSpot,
} from '../../src/sim/rules/shootout';
import { findEvents, makeScenario, runTicks, runUntil } from '../harness/scenario';
import { playKick, playKicks, shootoutScenario, strike, untilPostMatch, untilSub } from './rul-07-helpers';

const other = (t: number): number => (t === 0 ? 1 : 0);

function orderOf(so: ShootoutState, team: number): number[] {
  const ord = team === 0 ? so.order : so.order2;
  return ord.filter((r) => r >= 0);
}

/** Expected order: active players by finishing + composure (shot power, then slot, breaks ties), keeper last. */
function expectedOrder(s: SimState, team: number): number[] {
  const slots: number[] = [];
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) if (s.players[i]!.active === 1) slots.push(i);
  const score = (i: number): number => {
    const a = s.attrs[i]!;
    return a.finishing + a.composure + a.shotPower / 1000 - (s.players[i]!.isKeeper === 1 ? 1000 : 0);
  };
  slots.sort((a, b) => score(b) - score(a) || a - b);
  return slots.map((i) => s.players[i]!.rosterIdx);
}

function kicksOf(events: readonly SimEvent[]): SimEvent[] {
  return findEvents(events, EventType.SHOOTOUT_KICK);
}

describe('RUL-07 start', () => {
  it('shoot-out mode: PRE_MATCH -> SHOOT_OUT; coin tosses for the first team and the end; kicker, keepers, others placed', () => {
    const firsts = new Set<number>();
    const ends = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = shootoutScenario(seed);
      const m = s.match;
      const so = m.shootout;
      const r = m.restart;
      expect(m.period).toBe(Period.SHOOT_OUT);
      expect(so.active).toBe(1);
      expect(so.winner).toBe(-1);
      expect(so.taken).toEqual([0, 0]);
      expect(so.sub).toBe(ShootoutSub.SETUP);
      const end = shootoutEnd(s);
      firsts.add(so.team);
      ends.add(end);
      // dir handling: the kicking team attacks the shoot-out end, the other defends it
      expect(s.teams[so.team]!.dir).toBe(end);
      expect(s.teams[other(so.team)]!.dir).toBe(-end);
      // kicker behind the ball on the spot, facing the goal
      const k = s.players[so.kicker]!;
      expect(k.team).toBe(so.team);
      expect(k.x).toBeCloseTo(end * (HALF_LENGTH - PENALTY_SPOT_DIST) - end * LT.kickerBehind, 6);
      expect(k.z).toBeCloseTo(0, 6);
      expect(k.fx).toBe(end);
      expect(s.ball.x).toBeCloseTo(end * (HALF_LENGTH - PENALTY_SPOT_DIST), 6);
      expect(s.ball.z).toBe(0);
      expect(s.ball.y).toBe(BALL_RADIUS);
      // keepers
      expect(so.keeper).toBe(s.teams[other(so.team)]!.keeperSlot);
      const g = s.players[so.keeper]!;
      expect(g.x).toBeCloseTo(end * (HALF_LENGTH - LT.keeperLineInset), 6);
      expect(g.z).toBe(0);
      const w = s.players[s.teams[so.team]!.keeperSlot]!;
      expect(w.x).toBeCloseTo(end * (HALF_LENGTH - LT.waitInsetX), 6);
      expect(w.z).toBeCloseTo(-(PENALTY_AREA_HALF_WIDTH + 1.2), 6);
      // restart mirrors a penalty
      expect(r.kind).toBe(RestartKind.PENALTY);
      expect(r.team).toBe(so.team);
      expect(r.taker).toBe(so.kicker);
      expect([r.ready, r.taken, r.side, r.aimPower]).toEqual([0, 0, 0, 0]);
      // everyone else in the centre circle
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        if (i === so.kicker || i === s.teams[p.team]!.keeperSlot) continue;
        expect(Math.hypot(p.x, p.z)).toBeLessThan(CENTRE_CIRCLE_RADIUS);
      }
      // AIM after the setup cut, with the referee's whistle
      const ev = untilSub(s, ShootoutSub.AIM);
      expect(r.ready).toBe(1);
      expect(findEvents(ev, EventType.WHISTLE, (e) => e.a === WhistleKind.START)).toHaveLength(1);
    }
    expect([...firsts].sort()).toEqual([0, 1]);
    expect([...ends].sort()).toEqual([-1, 1]);
  });

  it('kick order: every active player, best takers (finishing + composure) first, the keeper last', () => {
    const s = shootoutScenario(3);
    const so = s.match.shootout;
    for (const team of [0, 1]) {
      const ord = orderOf(so, team);
      expect(ord).toEqual(expectedOrder(s, team));
      expect(ord).toHaveLength(PLAYERS_PER_TEAM);
      expect(ord[ord.length - 1]).toBe(s.players[s.teams[team]!.keeperSlot]!.rosterIdx);
      const pad = (team === 0 ? so.order : so.order2).slice(PLAYERS_PER_TEAM);
      expect(pad.every((v) => v === -1)).toBe(true);
    }
    // The first kicker of the starting team is its best taker.
    expect(s.players[so.kicker]!.rosterIdx).toBe(orderOf(so, so.team)[0]);
  });

  it('equal numbers: with a man sent off, the other side excludes its lowest-ranked player (the keeper)', () => {
    const s = makeScenario({ seed: 4, humans: 0, config: { mode: ModeId.SHOOT_OUT, startPhase: MatchPhase.SHOOT_OUT } });
    const off = s.players[15]!;
    off.active = 0;
    off.x = 0; off.z = 39;
    s.teams[1]!.roster[off.rosterIdx] = RosterStatus.SENT_OFF;
    s.teams[1]!.onPitch = 10;
    runUntil(s, (st) => st.match.phase === MatchPhase.SHOOT_OUT, 400, undefined, 'core');
    const so = s.match.shootout;
    const o0 = orderOf(so, 0), o1 = orderOf(so, 1);
    expect(o0).toHaveLength(10);
    expect(o1).toHaveLength(10);
    expect(o0).toEqual(expectedOrder(s, 0).slice(0, 10));
    expect(o0).not.toContain(s.players[s.teams[0]!.keeperSlot]!.rosterIdx);
    expect(o1).not.toContain(off.rosterIdx);
    expect(o1[9]).toBe(s.players[s.teams[1]!.keeperSlot]!.rosterIdx);
  });

  it('SHOOT_OUT entered without shootoutStart is started by the first tick (logged)', () => {
    const s = makeScenario({ seed: 2, humans: 0, phase: MatchPhase.SHOOT_OUT });
    expect(s.match.shootout.active).toBe(0);
    const ev = runTicks(s, 1, undefined, { check: 'core' });
    expect(s.match.shootout.active).toBe(1);
    expect(s.match.shootout.sub).toBe(ShootoutSub.SETUP);
    expect(findEvents(ev, EventType.WATCHDOG, (e) => e.a === WatchdogReason.OTHER)).toHaveLength(1);
  });
});

describe('RUL-07 kicks', () => {
  it('alternation: teams alternate every kick, the end never changes, the keeper is always the other team\'s', () => {
    const s = shootoutScenario(5);
    const so = s.match.shootout;
    const first = so.team;
    const end = shootoutEnd(s);
    const teams: number[] = [];
    for (let i = 0; i < 6; i++) {
      untilSub(s, ShootoutSub.AIM);
      teams.push(so.team);
      expect(shootoutEnd(s)).toBe(end);
      expect(s.teams[so.team]!.dir).toBe(end);
      expect(s.teams[other(so.team)]!.dir).toBe(-end);
      expect(s.players[so.kicker]!.team).toBe(so.team);
      expect(so.keeper).toBe(s.teams[other(so.team)]!.keeperSlot);
      const { kick } = playKick(s, 'goal');
      expect(kick.a).toBe(so.team);
    }
    expect(teams).toEqual([first, other(first), first, other(first), first, other(first)]);
    expect(so.taken).toEqual([3, 3]);
  });

  it('results: goal scored; wide, over the bar, a ball that stops and a ball saved and held are missed', () => {
    const s = shootoutScenario(6);
    const so = s.match.shootout;
    const first = so.team;
    const goal = playKick(s, 'goal');
    expect(goal.kick.c).toBe(1);
    expect(findEvents(goal.events, EventType.NET)).toHaveLength(1);
    expect(playKick(s, 'wide').kick.c).toBe(0);
    expect(playKick(s, 'over').kick.c).toBe(0);
    expect(playKick(s, 'soft').kick.c).toBe(0);
    // saved and held: the keeper takes the ball into his hands during the flight
    untilSub(s, ShootoutSub.AIM);
    strike(s, 'soft', 1);
    runTicks(s, 2, undefined, { check: 'core' });
    expect(so.sub).toBe(ShootoutSub.FLIGHT);
    const g = s.players[so.keeper]!;
    s.ball.x = g.x - shootoutEnd(s) * 0.5; s.ball.z = g.z; s.ball.y = 1;
    keeperPickUp(s, so.keeper, NULL_SINK);
    const held = runTicks(s, 1, undefined, { check: 'core' });
    expect(kicksOf(held)).toHaveLength(1);
    expect(kicksOf(held)[0]!.c).toBe(0);
    expect(so.taken[first]).toBe(3);
    expect(so.taken[other(first)]).toBe(2);
    expect(so.goals).toEqual([first === 0 ? 1 : 0, first === 1 ? 1 : 0]);
    const A = first * MAX_SHOOTOUT_KICKS, B = other(first) * MAX_SHOOTOUT_KICKS;
    expect(so.kicks.slice(A, A + 4)).toEqual([KICK_SCORED, KICK_MISSED, KICK_MISSED, 0]);
    expect(so.kicks.slice(B, B + 3)).toEqual([KICK_MISSED, KICK_MISSED, 0]);
    // Shoot-out goals are not match goals.
    expect(s.teams[0]!.goals + s.teams[1]!.goals).toBe(0);
    // The held ball is released and re-spotted for the next kick.
    const next = untilSub(s, ShootoutSub.AIM);
    expect(s.ball.heldBy).toBe(-1);
    expect(s.ball.x).toBeCloseTo(shootoutEnd(s) * (HALF_LENGTH - PENALTY_SPOT_DIST), 6);
    expect(findEvents(next, EventType.KEEPER_HANDS, (e) => e.b === 0).length).toBeLessThanOrEqual(1);
  });

  it('early decision: 3-0 after three each ends the shoot-out at once (not after the leader\'s third kick)', () => {
    const s = shootoutScenario(7);
    const so = s.match.shootout;
    const A = so.team;
    playKicks(s, ['goal', 'wide', 'goal', 'wide', 'goal']);
    expect(so.winner).toBe(-1); // 3-0 but B has three kicks left
    const { kick } = playKick(s, 'wide');
    expect(kick.a).toBe(other(A));
    expect(so.winner).toBe(A);
    const ev = untilPostMatch(s);
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(kicksOf(ev)).toHaveLength(0);
    expect(so.taken).toEqual([3, 3]);
    expect(so.goals[A]).toBe(3);
    expect(so.goals[other(A)]).toBe(0);
    const pc = findEvents(ev, EventType.PHASE_CHANGE);
    expect(pc.map((e) => [e.a, e.b])).toEqual([[MatchPhase.SHOOT_OUT, MatchPhase.POST_MATCH]]);
    expect(pc[0]!.tick - kick.tick).toBe(LT.resultTicks);
  });

  it('POST_MATCH reached with a winner: match.winner, shoot-out closed, restart cleared, final whistle', () => {
    const s = shootoutScenario(8);
    const so = s.match.shootout;
    const A = so.team;
    // 4-2 after four each (B cannot reach 4 with one kick left).
    playKicks(s, ['goal', 'goal', 'goal', 'goal', 'goal', 'wide', 'goal', 'wide']);
    expect(so.winner).toBe(A);
    const ev = untilPostMatch(s);
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(s.match.winner).toBe(A);
    expect(s.match.finished).toBe(1);
    expect(so.active).toBe(0);
    expect(so.sub).toBe(ShootoutSub.DONE);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
    expect(findEvents(ev, EventType.WHISTLE, (e) => e.a === WhistleKind.FINAL)).toHaveLength(1);
    expect(so.goals[A]).toBe(4);
    expect(so.goals[other(A)]).toBe(2);
    // Nothing runs after the end.
    expect(kicksOf(runTicks(s, 300))).toHaveLength(0);
  });

  it('level after five each -> sudden death in pairs: decided only when one scores and the other misses', () => {
    const s = shootoutScenario(9);
    const so = s.match.shootout;
    const A = so.team, B = other(A);
    playKicks(s, ['goal', 'goal', 'goal', 'goal', 'goal', 'goal', 'goal', 'goal', 'wide', 'wide']);
    expect(so.taken).toEqual([5, 5]);
    expect(so.winner).toBe(-1);
    untilSub(s, ShootoutSub.AIM);
    expect(so.suddenDeath).toBe(1);
    expect(so.team).toBe(A);
    playKicks(s, ['goal', 'goal']); // 5-5 after six each: still level
    expect(so.winner).toBe(-1);
    playKick(s, 'wide'); // A misses: B can still win
    expect(so.winner).toBe(-1);
    const { kick } = playKick(s, 'goal'); // B scores: B wins 6-5
    expect(kick.a).toBe(B);
    expect(so.winner).toBe(B);
    untilPostMatch(s);
    expect(s.match.winner).toBe(B);
    expect(so.goals[B]).toBe(6);
    expect(so.goals[A]).toBe(5);
    expect(so.taken).toEqual([7, 7]);
  });

  it('rotation: every eligible player kicks once before anyone repeats (keeper eleventh, then the best taker)', () => {
    const s = shootoutScenario(10);
    const so = s.match.shootout;
    const seq: number[][] = [[], []];
    for (let i = 0; i < 24; i++) {
      untilSub(s, ShootoutSub.AIM);
      seq[so.team]!.push(s.players[so.kicker]!.rosterIdx);
      playKick(s, 'goal');
    }
    for (const team of [0, 1]) {
      const ord = orderOf(so, team);
      expect(seq[team]).toEqual([...ord, ord[0]!]);
      expect(seq[team]![10]).toBe(s.players[s.teams[team]!.keeperSlot]!.rosterIdx);
    }
  });

  it('no rebound goals: a second touch by the kicker or a teammate ends the kick as missed; a keeper touch does not', () => {
    const s = shootoutScenario(11);
    const so = s.match.shootout;
    // Kicker plays the ball again and puts it in the net: missed.
    untilSub(s, ShootoutSub.AIM);
    strike(s, 'soft');
    runTicks(s, 8, undefined, { check: 'core' });
    expect(so.sub).toBe(ShootoutSub.FLIGHT);
    strike(s, 'goal'); // the rebound: struck by the kicker from where the ball is
    const ev1 = runUntil(s, (st) => st.match.shootout.sub === ShootoutSub.RESULT, 200, undefined, 'core').events;
    expect(kicksOf(ev1)[0]!.c).toBe(0);
    const net = runTicks(s, 60, undefined, { check: 'core' });
    expect(findEvents(net, EventType.NET)).toHaveLength(1); // it did go in
    expect(so.goals[0] + so.goals[1]).toBe(0);
    // A teammate touching the ball: missed.
    untilSub(s, ShootoutSub.AIM);
    strike(s, 'goal');
    runTicks(s, 3, undefined, { check: 'core' });
    const kt = s.players[so.kicker]!.team;
    const mate = so.kicker === teamFirstSlot(kt) + 5 ? teamFirstSlot(kt) + 6 : teamFirstSlot(kt) + 5;
    recordTouch(s, mate);
    const ev2 = runUntil(s, (st) => st.match.shootout.sub === ShootoutSub.RESULT, 200, undefined, 'core').events;
    expect(kicksOf(ev2)[0]!.c).toBe(0);
    // The defending keeper touches it and it still goes in: a goal.
    untilSub(s, ShootoutSub.AIM);
    strike(s, 'goal');
    runTicks(s, 3, undefined, { check: 'core' });
    recordTouch(s, so.keeper);
    const ev3 = runUntil(s, (st) => st.match.shootout.sub === ShootoutSub.RESULT, 200, undefined, 'core').events;
    expect(kicksOf(ev3)[0]!.c).toBe(1);
  });

  it('ball, kicker and keeper are held in place until the kick', () => {
    const s = shootoutScenario(12);
    const so = s.match.shootout;
    untilSub(s, ShootoutSub.AIM);
    const end = shootoutEnd(s);
    const b = s.ball;
    b.x -= end * 3; b.vx = 4; b.vz = 2;
    s.players[so.kicker]!.x -= end * 4;
    s.players[so.keeper]!.x -= end * 3;
    runTicks(s, 1, undefined, { check: 'core' });
    expect(b.x).toBeCloseTo(end * (HALF_LENGTH - PENALTY_SPOT_DIST), 6);
    expect([b.vx, b.vz]).toEqual([0, 0]);
    expect(Math.abs(s.players[so.kicker]!.x - (b.x - end * LT.kickerBehind))).toBeLessThan(LT.kickerPinTol);
    expect(Math.abs(s.players[so.keeper]!.x - end * (HALF_LENGTH - LT.keeperLineInset))).toBeLessThan(LT.keeperLineSlack);
    expect(so.sub).toBe(ShootoutSub.AIM);
    expect(s.match.restart.taken).toBe(0);
  });

  it('safety cap: still level after MAX_SHOOTOUT_KICKS each -> decided by lot (logged)', () => {
    const s = shootoutScenario(13);
    const so = s.match.shootout;
    untilSub(s, ShootoutSub.AIM);
    so.taken[0] = MAX_SHOOTOUT_KICKS - 1; so.taken[1] = MAX_SHOOTOUT_KICKS - 1;
    so.goals[0] = 20; so.goals[1] = 20;
    playKick(s, 'goal');
    expect(so.winner).toBe(-1);
    const { events } = playKick(s, 'goal');
    expect(so.taken).toEqual([MAX_SHOOTOUT_KICKS, MAX_SHOOTOUT_KICKS]);
    expect([0, 1]).toContain(so.winner);
    expect(findEvents(events, EventType.WATCHDOG, (e) => e.a === WatchdogReason.OTHER)).toHaveLength(1);
    untilPostMatch(s);
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(s.match.winner).toBe(so.winner);
  });
});

describe('RUL-07 whole shoot-outs', () => {
  it.each([1, 2])('CPU v CPU shoot-out completes to POST_MATCH with a winner (seed %i), invariants hold', (seed) => {
    const s = shootoutScenario(seed);
    const events = untilPostMatch(s, 30000);
    const so = s.match.shootout;
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect([0, 1]).toContain(so.winner);
    expect(s.match.winner).toBe(so.winner);
    expect(so.goals[so.winner]!).toBeGreaterThan(so.goals[other(so.winner)]!);
    expect(so.taken[0]! + so.taken[1]!).toBe(kicksOf(events).length);
    expect(Math.abs(so.taken[0]! - so.taken[1]!)).toBeLessThanOrEqual(1);
    for (const e of kicksOf(events)) expect(so.kicks[e.a * MAX_SHOOTOUT_KICKS + e.b]).toBe(e.c === 1 ? KICK_SCORED : KICK_MISSED);
    expect(s.teams[0]!.goals + s.teams[1]!.goals).toBe(0);
    expect(shootoutDecided(so)).toBe(so.winner);
  });

  it('cup: level after extra time -> RUL-01 starts the shoot-out -> POST_MATCH with the shoot-out winner', () => {
    const s = makeScenario({
      seed: 14, humans: 0, phase: MatchPhase.FULL_TIME, config: { cupRules: 1, mode: ModeId.CUP },
      match: { period: Period.ET_SECOND },
    });
    s.teams[0]!.goals = 1; s.teams[1]!.goals = 1;
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.SHOOT_OUT, 600, undefined, 'core');
    expect(reached).toBe(true);
    expect(s.match.period).toBe(Period.SHOOT_OUT);
    expect(s.match.shootout.active).toBe(1);
    untilPostMatch(s, 30000);
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect([0, 1]).toContain(s.match.winner);
    expect(s.match.winner).toBe(s.match.shootout.winner);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([1, 1]);
  });

  it('determinism: the same seed gives the same state hash and the same kicks', () => {
    const run = (): { hash: number; kicks: string } => {
      const s = shootoutScenario(21);
      const ev = runTicks(s, 2500);
      return { hash: hashState(s), kicks: kicksOf(ev).map((e) => `${e.tick}:${e.a}:${e.b}:${e.c}`).join(' ') };
    };
    const a = run(), b = run();
    expect(a.kicks.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('human timeout: a human kicker who does nothing gets the default kick after 12 s, not before', () => {
    const s = shootoutScenario(15, [{ side: 0 }, { side: 1 }]);
    const so = s.match.shootout;
    untilSub(s, ShootoutSub.AIM);
    const t0 = s.tick;
    const k = so.kicker;
    expect(s.ctrl[so.team]!.slot).toBe(k);
    const before = runTicks(s, T_RULES.restartTimeoutTicks - 1, undefined, { check: 'core' });
    expect(findEvents(before, EventType.KICK)).toHaveLength(0);
    expect(findEvents(before, EventType.WATCHDOG)).toHaveLength(0);
    expect(s.match.restart.taken).toBe(0);
    expect(s.match.restart.timeoutT).toBe(1);
    const after = runTicks(s, LT.defaultGraceTicks + 20, undefined, { check: 'core' });
    const kicks = findEvents(after, EventType.KICK, (e) => e.a === k);
    expect(kicks).toHaveLength(1);
    expect(kicks[0]!.tick - t0).toBeGreaterThanOrEqual(T_RULES.restartTimeoutTicks);
    expect(kicks[0]!.tick - t0).toBeLessThanOrEqual(T_RULES.restartTimeoutTicks + LT.defaultGraceTicks);
    const res = untilSub(s, ShootoutSub.RESULT);
    expect(kicksOf([...after, ...res])).toHaveLength(1);
    expect(so.taken[s.players[k]!.team]).toBe(1);
  });
});

describe('RUL-07 input', () => {
  /** Both sides human (no CPU kicker can interfere); returns at AIM with team 1 kicking (P1 holds the keeper). */
  function keeperScenario(): SimState {
    const s = shootoutScenario(16, [{ side: 0 }, { side: 1 }]);
    if (s.match.shootout.team !== 1) playKick(s, 'wide');
    untilSub(s, ShootoutSub.AIM, 3000, undefined, 1);
    expect(s.ctrl[0]!.slot).toBe(s.match.shootout.keeper);
    return s;
  }

  it('human keeper: the stick moves him along his line (|z| <= keeperMaxZ), never off it', () => {
    const s = keeperScenario();
    const so = s.match.shootout;
    const g = s.players[so.keeper]!;
    const lineX = shootoutEnd(s) * (HALF_LENGTH - LT.keeperLineInset);
    runTicks(s, 50, (_t, _st, out) => { out[0]!.mz = 127; }, { check: 'core' });
    expect(g.z).toBeGreaterThan(0.3);
    expect(Math.abs(g.x - lineX)).toBeLessThan(0.3);
    g.z = LT.keeperMaxZ - 0.05;
    runTicks(s, 40, (_t, _st, out) => { out[0]!.mz = 127; }, { check: 'core' });
    expect(g.z).toBeLessThan(LT.keeperMaxZ + 0.25);
    runTicks(s, 90, (_t, _st, out) => { out[0]!.mz = -127; }, { check: 'core' });
    expect(g.z).toBeLessThan(LT.keeperMaxZ - 0.3);
    expect(Math.abs(g.x - lineX)).toBeLessThan(0.3);
  });

  it('human keeper: RS flick, swipe or tap commit a dive (restart.side = pitch-z side, aimPower = height class)', () => {
    const s = keeperScenario();
    const so = s.match.shootout;
    const r = s.match.restart;
    const end = shootoutEnd(s);
    const flick = (ax: number, az: number): void => {
      runTicks(s, 1, (_t, _st, out) => { out[0]!.buttons = Btn.RS_FLICK; out[0]!.ax = ax; out[0]!.az = az; });
      runTicks(s, 1);
    };
    flick(0, 127);
    expect([r.side, r.aimPower]).toEqual([1, 1]);
    flick(Math.round(end * 90), -90); // up-left behind the taker: high, toward -z
    expect([r.side, r.aimPower]).toEqual([-1, 2]);
    flick(Math.round(-end * 127), 0); // toward the kicker: stay, low
    expect([r.side, r.aimPower]).toEqual([0, 0]);
    runTicks(s, 1, (_t, _st, out) => { out[0]!.gesture = GestureKind.SWIPE; out[0]!.gdx = 0; out[0]!.gdz = -100; });
    expect([r.side, r.aimPower]).toEqual([-1, 1]);
    const gz = s.players[so.keeper]!.z;
    runTicks(s, 1, (_t, _st, out) => { out[0]!.gesture = GestureKind.TAP; out[0]!.gx = Math.round(end * 520); out[0]!.gz = Math.round((gz + 2) * 10); });
    expect([r.side, r.aimPower]).toEqual([1, 1]);
    runTicks(s, 1, (_t, _st, out) => { out[0]!.gesture = GestureKind.TAP; out[0]!.gx = Math.round(end * 520); out[0]!.gz = Math.round(gz * 10); });
    expect([r.side, r.aimPower]).toEqual([0, 1]);
    // After the kick the choice is frozen; the next kick starts with none.
    flick(0, -127);
    expect(r.side).toBe(-1);
    strike(s, 'wide');
    runTicks(s, 2);
    flick(0, 127);
    expect(r.side).toBe(-1);
    untilSub(s, ShootoutSub.AIM);
    expect([r.side, r.aimPower]).toEqual([0, 0]);
  });

  it('human kicker: the stick aims where its ray from the spot meets the goal line; the aim persists', () => {
    const s = shootoutScenario(17, [{ side: 0 }, { side: 1 }]);
    const so = s.match.shootout;
    const r = s.match.restart;
    untilSub(s, ShootoutSub.AIM);
    const ci = so.team;
    expect(s.ctrl[ci]!.slot).toBe(so.kicker);
    const end = shootoutEnd(s);
    runTicks(s, 2, (_t, _st, out) => { out[ci]!.mx = end * 120; out[ci]!.mz = 24; });
    expect(r.aimX).toBe(end * HALF_LENGTH);
    expect(r.aimZ).toBeCloseTo((PENALTY_SPOT_DIST * 24) / 120, 2);
    runTicks(s, 5);
    expect(r.aimZ).toBeCloseTo((PENALTY_SPOT_DIST * 24) / 120, 2);
    runTicks(s, 1, (_t, _st, out) => { out[ci]!.mz = -127; });
    expect(r.aimZ).toBeCloseTo(-LT.aimMaxZ, 6);
    runTicks(s, 1, (_t, _st, out) => { out[ci]!.mx = end * 127; out[ci]!.mz = 127; });
    expect(r.aimZ).toBeCloseTo(LT.aimMaxZ, 6);
    // The kicker faces the aim point while waiting.
    expect(s.players[so.kicker]!.lookAt).toBe(1);
    expect(s.players[so.kicker]!.lookZ).toBeCloseTo(LT.aimMaxZ, 6);
  });

  it('input outside AIM (setup cut, after the kick) and from the defending side for the kicker is ignored', () => {
    const s = shootoutScenario(18, [{ side: 0 }, { side: 1 }]);
    const so = s.match.shootout;
    const r = s.match.restart;
    expect(so.sub).toBe(ShootoutSub.SETUP);
    const ki = so.team, gi = other(so.team);
    runTicks(s, 3, (_t, _st, out) => {
      out[ki]!.mz = 127; out[ki]!.mx = 0;
      out[gi]!.buttons = Btn.RS_FLICK; out[gi]!.az = 127;
    });
    expect([r.aimZ, r.side]).toEqual([0, 0]);
    untilSub(s, ShootoutSub.AIM);
    // The keeper's controller pushing SHOOT never kicks.
    const ev = runTicks(s, 30, (t, _st, out) => { out[gi]!.buttons = t % 2 === 0 ? Btn.SHOOT : 0; }, { check: 'core' });
    expect(findEvents(ev, EventType.KICK)).toHaveLength(0);
    expect(r.taken).toBe(0);
  });
});

describe('RUL-07 shootoutDecided', () => {
  const so = (taken: [number, number], goals: [number, number]): ShootoutState => ({
    active: 1, team: 0, taken, goals, order: [], order2: [], next: [0, 0], kicks: [], sub: 0, subT: 0, kicker: -1, keeper: -1,
    suddenDeath: 0, winner: -1,
  });
  it.each([
    { taken: [0, 0], goals: [0, 0], w: -1 },
    { taken: [3, 2], goals: [3, 0], w: -1 }, // B can still make 3
    { taken: [3, 3], goals: [3, 0], w: 0 }, // 3-0 after three each
    { taken: [3, 3], goals: [0, 3], w: 1 },
    { taken: [4, 3], goals: [4, 1], w: 0 }, // B can reach 3 at most
    { taken: [4, 4], goals: [3, 2], w: -1 },
    { taken: [5, 4], goals: [4, 3], w: -1 }, // B's fifth can level
    { taken: [5, 4], goals: [3, 4], w: 1 }, // A has no kicks left in five rounds
    { taken: [5, 5], goals: [4, 4], w: -1 },
    { taken: [6, 5], goals: [5, 4], w: -1 }, // sudden death: B still to kick
    { taken: [6, 6], goals: [5, 4], w: 0 },
    { taken: [6, 5], goals: [5, 5], w: -1 }, // A missed his sixth: B still to kick
    { taken: [7, 7], goals: [6, 7], w: 1 },
  ])('taken $taken goals $goals -> $w', ({ taken, goals, w }) => {
    expect(shootoutDecided(so(taken as [number, number], goals as [number, number]))).toBe(w);
  });
});

describe('RUL-07 shootoutKeeperSpot', () => {
  it('defending keeper on his line centre, the kicking team\'s keeper waiting by the penalty-area line, others none', () => {
    const s = shootoutScenario(19);
    const so = s.match.shootout;
    const end = shootoutEnd(s);
    const pt = { x: 0, z: 0 };
    expect(shootoutKeeperSpot(s, so.keeper, pt)).toBe(1);
    expect(pt).toEqual({ x: end * (HALF_LENGTH - LT.keeperLineInset), z: 0 });
    expect(shootoutKeeperSpot(s, s.teams[so.team]!.keeperSlot, pt)).toBe(1);
    expect(pt.x).toBeCloseTo(end * (HALF_LENGTH - LT.waitInsetX), 9);
    expect(pt.z).toBeLessThan(-PENALTY_AREA_HALF_WIDTH);
    expect(shootoutKeeperSpot(s, so.kicker, pt)).toBe(0);
  });
});

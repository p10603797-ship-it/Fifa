/**
 * RUL-10: substitutions (queue, validation, max 5, stoppages only, cannot return, keeper rules, attributes copied,
 * control released), sending off (plays short, keeper sent off with and without substitutions left), forfeit below
 * 7 players, and the glitch-list lines "12 players after a substitution", "a team below 7 players not ending the
 * match" and "lands on a sent-off or substituted player".
 *
 * Unit-style cases call requestSub / subsTick / sendOff / checkForfeit directly on an initMatch state (or the rules
 * machine alone via rulesTick); flow cases step the real pipeline (step.ts) with the invariant checker.
 * SIM-16 releasePlayer is wrapped (real implementation, calls recorded) so control release can be asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALL_RADIUS, BOARD_Z, HALF_LENGTH, HALF_WIDTH, MAX_SUBS, MIN_PLAYERS, NUM_SLOTS, PLAYERS_PER_TEAM, WORLD_MAX_X, WORLD_MAX_Z,
  teamFirstSlot,
} from '../../src/contracts/constants';
import type { Club } from '../../src/contracts/data';
import { ActionKind, Command, KickKind, MatchPhase, ModeId, RestartKind, Role } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { RosterStatus, createPlayerAttrs, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { getFormation } from '../../src/data/formations';
import { beginAction } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { copyAttrs } from '../../src/sim/init';
import { rulesTick } from '../../src/sim/rules/machine';
import { awardRestart } from '../../src/sim/rules/restart';
import { ThrowState } from '../../src/sim/rules/throwin';
import { T_RULES } from '../../src/contracts/tuning';
import {
  LOCAL_TUNING, canRequestSub, checkForfeit, isSubStoppage, requestSub, sendOff, subsLeft, subsTick,
} from '../../src/sim/rules/subs';
import { step } from '../../src/sim/step';
import { findEvents, makeScenario, type ScenarioOptions } from '../harness/scenario';

const H = vi.hoisted(() => ({ released: [] as number[] }));

vi.mock('../../src/sim/control/switching', async (orig) => {
  const m = await orig<typeof import('../../src/sim/control/switching')>();
  return {
    ...m,
    releasePlayer: (s: Parameters<typeof m.releasePlayer>[0], slot: number, ev: Parameters<typeof m.releasePlayer>[2]) => {
      H.released.push(slot);
      m.releasePlayer(s, slot, ev);
    },
  };
});

beforeEach(() => { H.released.length = 0; });

const EV = createEventBuffer();

/** Run fn with a fresh event buffer for the current tick; returns its result and the events. */
function withEv<T>(s: SimState, fn: () => T): { r: T; ev: SimEvent[] } {
  EV.begin(s.tick);
  const r = fn();
  return { r, ev: EV.toArray() };
}

function doSendOff(s: SimState, slot: number): SimEvent[] {
  return withEv(s, () => sendOff(s, slot, EV)).ev;
}

function doSubsTick(s: SimState): SimEvent[] {
  return withEv(s, () => subsTick(s, EV)).ev;
}

/** One rulesTick with step()'s bookkeeping (tick, events, phaseT, cross reset). */
function tickRules(s: SimState): SimEvent[] {
  s.tick++;
  EV.begin(s.tick);
  s.match.phaseT++;
  s.ball.cross = 0;
  rulesTick(s, EV);
  return EV.toArray();
}

const checker = (): ReturnType<typeof createInvariantChecker> => createInvariantChecker(['players', 'controllers', 'owner']);

/** Static invariants (players, controllers, owner) of a state; [] when fine. */
function staticFailures(s: SimState): readonly string[] {
  return checker().check(s, null);
}

function benchKeeperIdx(s: SimState, team: number): number {
  return s.squads[team]!.findIndex((p, i) => i >= PLAYERS_PER_TEAM && p.pos === Role.GK);
}

function benchOutfield(s: SimState, team: number): number[] {
  const out: number[] = [];
  s.squads[team]!.forEach((p, i) => { if (i >= PLAYERS_PER_TEAM && p.pos !== Role.GK) out.push(i); });
  return out;
}

function activeSlots(s: SimState, team: number): number[] {
  const first = teamFirstSlot(team);
  const out: number[] = [];
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) if (s.players[i]!.active === 1) out.push(i);
  return out;
}

function activeKeepers(s: SimState, team: number): number[] {
  return activeSlots(s, team).filter((i) => s.players[i]!.isKeeper === 1);
}

function playingCount(s: SimState, team: number): number {
  return s.teams[team]!.roster.filter((r) => r === RosterStatus.PLAYING).length;
}

/** Deep-enough copy of the clubs so tests can give squad members distinctive attributes. */
function cloneClubs(): Club[] {
  return CLUBS.map((c) => ({ ...c, squad: c.squad.map((p) => ({ ...p })) }));
}

function scen(opts: ScenarioOptions = {}): SimState {
  return makeScenario({ phase: MatchPhase.THROW_IN, ...opts });
}

// ================================================================ requestSub validation

describe('RUL-10 requestSub validation', () => {
  it('queues a valid request (team.subOut / subIn / subCount) and applies nothing yet', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const inR = benchOutfield(s, 0)[0]!;
    expect(requestSub(s, 0, 5, inR)).toBe(1);
    const t = s.teams[0]!;
    expect([t.subCount, t.subOut[0], t.subIn[0]]).toEqual([1, 5, inR]);
    expect(t.roster[inR]).toBe(RosterStatus.BENCH);
    expect(s.players[5]!.rosterIdx).toBe(5);
    expect(t.subsUsed).toBe(0);
    expect(subsLeft(s, 0)).toBe(MAX_SUBS - 1);
  });

  it('refuses invalid requests', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const inR = benchOutfield(s, 0)[0]!;
    const inR1 = benchOutfield(s, 1)[0]!;
    const cases: [string, number, number, number][] = [
      ['bad team', 2, 5, inR], ['team -1', -1, 5, inR], ['NaN team', NaN, 5, inR],
      ['slot out of range', 0, NUM_SLOTS, inR], ['negative slot', 0, -1, inR], ['fractional slot', 0, 5.5, inR],
      ['slot of the other team', 0, 15, inR], ['roster out of range', 0, 5, 18], ['negative roster', 0, 5, -1],
      ['starter (PLAYING) as incoming', 0, 5, 3], ['home slot requested by the away team', 1, 5, inR1],
    ];
    for (const [name, team, out, r] of cases) expect(requestSub(s, team, out, r), name).toBe(0);
    s.players[6]!.active = 0;
    expect(requestSub(s, 0, 6, inR), 'inactive slot').toBe(0);
    s.players[6]!.active = 1;
    s.teams[0]!.roster[inR] = RosterStatus.SENT_OFF;
    expect(requestSub(s, 0, 5, inR), 'roster SENT_OFF').toBe(0);
    s.teams[0]!.roster[inR] = RosterStatus.BENCH;
    expect(s.teams[0]!.subCount + s.teams[1]!.subCount).toBe(0);
  });

  it('refuses a slot or a squad member that is already queued', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const [a, b] = benchOutfield(s, 0) as [number, number];
    expect(requestSub(s, 0, 5, a)).toBe(1);
    expect(requestSub(s, 0, 5, b), 'same slot').toBe(0);
    expect(requestSub(s, 0, 6, a), 'same bench player').toBe(0);
    expect(requestSub(s, 0, 6, b)).toBe(1);
    expect(s.teams[0]!.subCount).toBe(2);
  });

  it('refuses once the match is over, forfeited, in a shoot-out or after it', () => {
    for (const set of [
      (s: SimState) => { s.match.finished = 1; },
      (s: SimState) => { s.match.forfeitTeam = 1; },
      (s: SimState) => { s.match.phase = MatchPhase.SHOOT_OUT; },
      (s: SimState) => { s.match.phase = MatchPhase.POST_MATCH; },
    ]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY });
      set(s);
      expect(requestSub(s, 0, 5, benchOutfield(s, 0)[0]!)).toBe(0);
      expect(s.teams[0]!.subCount).toBe(0);
    }
  });

  it('max 5: at most MAX_SUBS used + queued; the sixth request is refused', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const bench = benchOutfield(s, 0);
    expect(bench.length).toBeGreaterThanOrEqual(MAX_SUBS);
    for (let i = 0; i < MAX_SUBS; i++) expect(requestSub(s, 0, 1 + i, bench[i]!), `sub ${i + 1}`).toBe(1);
    expect(subsLeft(s, 0)).toBe(0);
    expect(requestSub(s, 0, 8, bench[5] ?? bench[0]!)).toBe(0);
    // Apply three, the rest stay; still never more than MAX_SUBS in total.
    const t = s.teams[0]!;
    s.match.phase = MatchPhase.THROW_IN;
    doSubsTick(s);
    expect([t.subsUsed, t.subCount]).toEqual([MAX_SUBS, 0]);
    expect(requestSub(s, 0, 8, bench[5] ?? benchKeeperIdx(s, 0))).toBe(0);
    expect(subsLeft(s, 0)).toBe(0);
  });

  it('after three substitutions only two more can be queued', () => {
    const s = scen();
    const bench = benchOutfield(s, 0);
    for (let i = 0; i < 3; i++) requestSub(s, 0, 2 + i, bench[i]!);
    doSubsTick(s);
    expect(s.teams[0]!.subsUsed).toBe(3);
    expect(subsLeft(s, 0)).toBe(2);
    expect(requestSub(s, 0, 6, bench[3]!)).toBe(1);
    expect(requestSub(s, 0, 7, bench[4]!)).toBe(1);
    expect(requestSub(s, 0, 8, bench[5] ?? bench[0]!)).toBe(0);
  });

  it('keeper rule: a keeper only for a keeper; a bench keeper never for an outfield player', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const bk = benchKeeperIdx(s, 0);
    const out = benchOutfield(s, 0)[0]!;
    expect(bk).toBeGreaterThanOrEqual(PLAYERS_PER_TEAM);
    expect(requestSub(s, 0, 0, out), 'outfield bench player for the keeper').toBe(0);
    expect(requestSub(s, 0, 4, bk), 'bench keeper for an outfield player').toBe(0);
    expect(canRequestSub(s, 0, 0, bk)).toBe(1);
    expect(requestSub(s, 0, 0, bk), 'bench keeper for the keeper').toBe(1);
    const bk1 = benchKeeperIdx(s, 1);
    expect(requestSub(s, 1, 11, bk1)).toBe(1);
  });

  it('canRequestSub is pure (no queue change)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const inR = benchOutfield(s, 0)[0]!;
    const h = hashState(s);
    expect(canRequestSub(s, 0, 5, inR)).toBe(1);
    expect(canRequestSub(s, 0, 15, inR)).toBe(0);
    expect(hashState(s)).toBe(h);
  });
});

// ================================================================ stoppages only

describe('RUL-10 substitutions only at stoppages', () => {
  const STOPPAGES = [
    MatchPhase.PRE_MATCH, MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER,
    MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY,
    MatchPhase.HALF_TIME, MatchPhase.FULL_TIME, MatchPhase.EXTRA_TIME,
  ];

  it('a queued substitution applies in every restart phase and cut-scene, never IN_PLAY / SHOOT_OUT / POST_MATCH', () => {
    for (let phase = MatchPhase.PRE_MATCH; phase <= MatchPhase.POST_MATCH; phase++) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY });
      const inR = benchOutfield(s, 0)[0]!;
      expect(requestSub(s, 0, 5, inR)).toBe(1);
      s.match.phase = phase;
      const ev = doSubsTick(s);
      const applied = STOPPAGES.includes(phase);
      expect(isSubStoppage(phase), MatchPhase[phase]).toBe(applied);
      expect(findEvents(ev, EventType.SUBSTITUTION).length, MatchPhase[phase]).toBe(applied ? 1 : 0);
      expect(s.players[5]!.rosterIdx, MatchPhase[phase]).toBe(applied ? inR : 5);
      // POST_MATCH: the match is over, the queue is dropped; IN_PLAY / SHOOT_OUT keep it.
      const queued = phase === MatchPhase.IN_PLAY || phase === MatchPhase.SHOOT_OUT ? 1 : 0;
      expect(s.teams[0]!.subCount, MatchPhase[phase]).toBe(queued);
    }
  });

  it('queued substitutions are dropped (not applied) once the match is finished', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    requestSub(s, 0, 5, benchOutfield(s, 0)[0]!);
    s.match.phase = MatchPhase.FULL_TIME;
    s.match.finished = 1;
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION)).toHaveLength(0);
    expect(s.teams[0]!.subCount).toBe(0);
    expect(s.players[5]!.rosterIdx).toBe(5);
  });

  it('pipeline: Command.SUBSTITUTE in open play waits for the next stoppage (throw-in), invariants hold every tick', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 7 }], ball: { x: 0, y: 0.11, z: 0 } });
    const inR = benchOutfield(s, 0)[0]!;
    const frames = [createInputFrame(), createInputFrame()];
    const inv = createInvariantChecker('core');
    let subTick = -1;
    let subPhase = -1;
    for (let i = 0; i < 150 && subTick < 0; i++) {
      clearInputFrame(frames[0]!);
      clearInputFrame(frames[1]!);
      if (i === 0) { frames[0]!.cmd = Command.SUBSTITUTE; frames[0]!.cmdArg = 7 | (inR << 8); }
      if (i === 60 && s.match.phase === MatchPhase.IN_PLAY) {
        // Force a stoppage the natural way: the loose ball rolls over the near touchline.
        const b = s.ball;
        if (b.owner >= 0) b.owner = -1;
        b.heldBy = -1;
        b.x = 0; b.z = HALF_WIDTH - 0.5; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
        b.vx = 0; b.vy = 0; b.vz = 12; b.grounded = 1;
      }
      step(s, frames, EV);
      expect(inv.check(s, EV)).toEqual([]);
      const ev = EV.toArray();
      if (i === 0) expect(s.teams[0]!.subCount).toBe(1);
      const sub = findEvents(ev, EventType.SUBSTITUTION);
      if (sub.length > 0) {
        expect(sub).toHaveLength(1);
        expect([sub[0]!.a, sub[0]!.b, sub[0]!.c, sub[0]!.d]).toEqual([0, 7, inR, 7]);
        subTick = s.tick;
        subPhase = s.match.phase;
      } else if (s.match.phase === MatchPhase.IN_PLAY) {
        expect(s.players[7]!.rosterIdx).toBe(7);
      }
    }
    expect(subTick).toBeGreaterThan(0);
    expect(isSubStoppage(subPhase)).toBe(true);
    expect(s.players[7]!.rosterIdx).toBe(inR);
    expect(s.teams[0]!.subsUsed).toBe(1);
    // Keep going: the substitute plays on, invariants keep holding.
    for (let i = 0; i < 60; i++) {
      clearInputFrame(frames[0]!);
      step(s, frames, EV);
      expect(inv.check(s, EV)).toEqual([]);
    }
  });
});

// ================================================================ applying a substitution

describe('RUL-10 applying a substitution', () => {
  it('attributes copied, stamina fresh, roster statuses, slot keeps its formation position, SUBSTITUTION event', () => {
    const clubs = cloneClubs();
    const s0 = makeScenario({ phase: MatchPhase.IN_PLAY });
    const inR = benchOutfield(s0, 0)[2]!;
    const sq = clubs[s0.config.homeClub]!.squad[inR]!;
    sq.sprintSpeed = 97; sq.finishing = 11; sq.height = 201; sq.shirt = 77; sq.gkDiving = 3; sq.weakFoot = 5; sq.skillMoves = 4;
    const s = scen({ clubs });
    const p = s.players[6]!;
    const before = { x: p.x, z: p.z, formIdx: p.formIdx, role: p.role };
    p.stamina = 0.31; p.yellow = 1; p.stunT = 20; p.vx = 3; p.vz = -2;
    beginAction(p, ActionKind.STUMBLE, 30, -1);
    expect(requestSub(s, 0, 6, inR)).toBe(1);
    const ev = doSubsTick(s);
    const expected = createPlayerAttrs();
    copyAttrs(expected, s.squads[0]![inR]!);
    expect(s.attrs[6]).toEqual(expected);
    expect([s.attrs[6]!.sprintSpeed, s.attrs[6]!.height, s.attrs[6]!.shirt]).toEqual([97, 201, 77]);
    expect([p.rosterIdx, p.stamina, p.yellow, p.stunT, p.vx, p.vz, p.act]).toEqual([inR, 1, 0, 0, 0, 0, ActionKind.NONE]);
    expect({ x: p.x, z: p.z, formIdx: p.formIdx, role: p.role }).toEqual(before);
    expect([p.active, p.isKeeper, p.team, p.slot]).toEqual([1, 0, 0, 6]);
    const t = s.teams[0]!;
    expect([t.roster[6], t.roster[inR], t.subsUsed, t.onPitch, t.keeperSlot]).toEqual([RosterStatus.SUBBED_OFF, RosterStatus.PLAYING, 1, 11, 0]);
    const sub = findEvents(ev, EventType.SUBSTITUTION);
    expect(sub.map((e) => [e.a, e.b, e.c, e.d])).toEqual([[0, 6, inR, 6]]);
    expect(staticFailures(s)).toEqual([]);
  });

  it('a substituted player cannot return (any slot), the substitute can himself be substituted', () => {
    const s = scen();
    const [a, b] = benchOutfield(s, 0) as [number, number];
    requestSub(s, 0, 4, a);
    doSubsTick(s);
    expect(s.teams[0]!.roster[4]).toBe(RosterStatus.SUBBED_OFF);
    expect(requestSub(s, 0, 4, 4), 'back into his own slot').toBe(0);
    expect(requestSub(s, 0, 7, 4), 'into another slot').toBe(0);
    expect(requestSub(s, 0, 4, b), 'the substitute goes off again').toBe(1);
    doSubsTick(s);
    expect([s.players[4]!.rosterIdx, s.teams[0]!.roster[a], s.teams[0]!.subsUsed]).toEqual([b, RosterStatus.SUBBED_OFF, 2]);
    expect(requestSub(s, 0, 5, a), 'the first substitute cannot return either').toBe(0);
    expect(staticFailures(s)).toEqual([]);
  });

  it('glitch "12 players after a substitution": five substitutions keep 11 players and 11 PLAYING roster entries', () => {
    const s = scen();
    const bench = benchOutfield(s, 0);
    for (let i = 0; i < MAX_SUBS; i++) expect(requestSub(s, 0, 1 + i * 2, bench[i]!)).toBe(1);
    doSubsTick(s);
    for (const team of [0, 1]) {
      expect(activeSlots(s, team)).toHaveLength(PLAYERS_PER_TEAM);
      expect(playingCount(s, team)).toBe(PLAYERS_PER_TEAM);
      expect(s.teams[team]!.onPitch).toBe(PLAYERS_PER_TEAM);
      expect(activeKeepers(s, team)).toHaveLength(1);
    }
    expect(s.teams[0]!.subsUsed).toBe(MAX_SUBS);
    expect(staticFailures(s)).toEqual([]);
  });

  it('glitch "12 players after a substitution": deterministic fuzz of requests, phases and send-offs never breaks the counts', () => {
    let seed = 12345;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
    const phases = [MatchPhase.IN_PLAY, MatchPhase.THROW_IN, MatchPhase.CORNER, MatchPhase.GOAL, MatchPhase.HALF_TIME, MatchPhase.FREE_KICK];
    for (let round = 0; round < 12; round++) {
      const s = scen();
      for (let i = 0; i < 120; i++) {
        s.match.phase = phases[rnd(phases.length)]!;
        const k = rnd(10);
        if (k < 7) requestSub(s, rnd(3) - (rnd(9) === 0 ? 1 : 0), rnd(NUM_SLOTS + 2) - 1, rnd(20) - 1);
        else if (k === 7 && rnd(4) === 0) {
          const team = rnd(2);
          if (activeSlots(s, team).length > MIN_PLAYERS) doSendOff(s, teamFirstSlot(team) + rnd(PLAYERS_PER_TEAM));
        }
        doSubsTick(s);
        for (const team of [0, 1]) {
          const t = s.teams[team]!;
          const act = activeSlots(s, team).length;
          expect(act).toBeLessThanOrEqual(PLAYERS_PER_TEAM);
          expect(playingCount(s, team)).toBe(act);
          expect(t.onPitch).toBe(act);
          expect(t.subsUsed).toBeLessThanOrEqual(MAX_SUBS);
          expect(t.subsUsed + t.subCount).toBeLessThanOrEqual(MAX_SUBS);
          expect(activeKeepers(s, team)).toEqual([t.keeperSlot]);
        }
        const fails = staticFailures(s);
        if (fails.length > 0) throw new Error(`round ${round} step ${i}: ${fails.join('; ')}`);
      }
    }
  });

  it('keeper for keeper: the bench keeper takes the keeper slot (isKeeper, role GK, keeperSlot unchanged)', () => {
    const s = scen();
    const bk = benchKeeperIdx(s, 1);
    expect(requestSub(s, 1, 11, bk)).toBe(1);
    const ev = doSubsTick(s);
    const p = s.players[11]!;
    expect([p.rosterIdx, p.isKeeper, p.role, p.formIdx, s.teams[1]!.keeperSlot]).toEqual([bk, 1, Role.GK, 0, 11]);
    const exp = createPlayerAttrs();
    copyAttrs(exp, s.squads[1]![bk]!);
    expect(s.attrs[11]).toEqual(exp);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => [e.a, e.b, e.c])).toEqual([[1, 11, bk]]);
    expect(activeKeepers(s, 1)).toEqual([11]);
    expect(staticFailures(s)).toEqual([]);
  });

  it('glitch "lands on a substituted player": control of the substituted slot is released and re-validated at once', () => {
    const s = scen({ humans: [{ side: 0, slot: 7 }, { side: 1, slot: 18 }] });
    const inR = benchOutfield(s, 0)[0]!;
    requestSub(s, 0, 7, inR);
    requestSub(s, 0, 8, benchOutfield(s, 0)[1]!); // not controlled: no release needed
    doSubsTick(s);
    expect(H.released).toEqual([7]);
    const c = s.ctrl[0]!;
    expect(c.slot).toBeGreaterThanOrEqual(0);
    expect(s.players[c.slot]!.active).toBe(1);
    expect(s.players[c.slot]!.team).toBe(0);
    expect(s.players[c.slot]!.ctrl).toBe(0);
    expect(s.ctrl[1]!.slot).toBe(18);
    expect(staticFailures(s)).toEqual([]);
  });

  it('a CPU-controlled slot is released too', () => {
    const s = scen();
    const c = s.ctrl[2]!; // CPU brain of team 0
    c.slot = 9; s.players[9]!.ctrl = 2;
    requestSub(s, 0, 9, benchOutfield(s, 0)[0]!);
    doSubsTick(s);
    expect(H.released).toEqual([9]);
    expect(s.players[c.slot]!.ctrl).toBe(2);
  });

  it('a substituted ball owner / keeper holding the ball gives it up', () => {
    const s = scen({ phase: MatchPhase.HALF_TIME });
    s.ball.owner = 0; s.ball.heldBy = 0;
    requestSub(s, 0, 0, benchKeeperIdx(s, 0));
    const ev = doSubsTick(s);
    expect([s.ball.owner, s.ball.heldBy]).toEqual([-1, -1]);
    expect(findEvents(ev, EventType.KEEPER_HANDS).map((e) => [e.a, e.b])).toEqual([[0, 0]]);
    expect(findEvents(ev, EventType.SUBSTITUTION)).toHaveLength(1);
  });

  it('the restart taker mid-kick is substituted only after the kick; waiting in SET_PIECE he is substituted at once', () => {
    const s = scen({ phase: MatchPhase.FREE_KICK });
    const r = s.match.restart;
    r.kind = RestartKind.FREE_KICK; r.team = 0; r.taker = 6; r.taken = 0; r.ready = 1;
    const p = s.players[6]!;
    beginAction(p, ActionKind.KICK, 30, 10);
    p.actKick = KickKind.GROUND_PASS;
    const [a, b] = benchOutfield(s, 0) as [number, number];
    requestSub(s, 0, 6, a);
    requestSub(s, 0, 2, b);
    let ev = doSubsTick(s);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => e.b)).toEqual([2]); // the other one is applied
    expect([s.teams[0]!.subCount, s.teams[0]!.subOut[0], s.players[6]!.rosterIdx]).toEqual([1, 6, 6]);
    expect(p.act).toBe(ActionKind.KICK);
    // Waiting again (e.g. the kick was refused): applied now; the slot stays the taker.
    beginAction(p, ActionKind.SET_PIECE, 60, -1);
    ev = doSubsTick(s);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => e.b)).toEqual([6]);
    expect([s.players[6]!.rosterIdx, p.act, r.taker, s.teams[0]!.subCount]).toEqual([a, ActionKind.NONE, 6, 0]);
  });

  it('a queued substitution whose player was sent off is dropped and uses no substitution', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const [a, b] = benchOutfield(s, 0) as [number, number];
    requestSub(s, 0, 5, a);
    requestSub(s, 0, 6, b);
    doSendOff(s, 5);
    expect([s.teams[0]!.subCount, s.teams[0]!.subOut[0]]).toEqual([1, 6]);
    s.match.phase = MatchPhase.FREE_KICK;
    const ev = doSubsTick(s);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => [e.b, e.c])).toEqual([[6, b]]);
    expect([s.teams[0]!.subsUsed, s.teams[0]!.roster[a]]).toEqual([1, RosterStatus.BENCH]);
    expect(s.players[5]!.active).toBe(0);
  });
});

// ================================================================ the throw-in taker

/**
 * Gap (checker): a substitution queued for the throw-in taker was held past that throw-in, because RUL-02 keeps the
 * thrower in ActionKind.THROW_IN for the whole phase (APPROACH / HOLD / CHARGE are its waiting sub-states). Only a
 * committed throw (WINDUP, or released) defers it now.
 */
describe('RUL-10 substituting the throw-in taker', () => {
  const NEAR = 1; // throw-ins on the +z touchline

  /** A real throw-in for `team` at x on the near touchline (awardRestart), stepped `ticks` through the pipeline. */
  function throwIn(team: number, ticks: number, humans = 0): SimState {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans });
    const b = s.ball;
    b.x = -8; b.y = BALL_RADIUS; b.z = NEAR * (HALF_WIDTH - 3); b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
    EV.begin(s.tick);
    awardRestart(s, RestartKind.THROW_IN, team, -8, NEAR * HALF_WIDTH, EV);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < ticks; i++) step(s, frames, EV);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    return s;
  }

  /** Ball lying on the touchline at the throw-in spot, nobody holding it. */
  function expectBallOnLine(s: SimState): void {
    const b = s.ball;
    const r = s.match.restart;
    expect([b.owner, b.heldBy]).toEqual([-1, -1]);
    expect([b.x, b.y, b.z]).toEqual([r.x, BALL_RADIUS, NEAR * HALF_WIDTH]);
    expect([b.vx, b.vy, b.vz]).toEqual([0, 0, 0]);
  }

  /** Step until the throw-in is taken (phase leaves THROW_IN); invariants every tick. Returns the THROW_IN kicks. */
  function playThrow(s: SimState, max: number): SimEvent[] {
    const frames = [createInputFrame(), createInputFrame()];
    const inv = createInvariantChecker('core');
    const kicks: SimEvent[] = [];
    for (let i = 0; i < max && s.match.phase === MatchPhase.THROW_IN; i++) {
      step(s, frames, EV);
      expect(inv.check(s, EV)).toEqual([]);
      for (const e of EV.toArray()) if (e.type === EventType.KICK && e.b === KickKind.THROW_IN) kicks.push(e);
    }
    return kicks;
  }

  it('waiting in APPROACH (walking to the line): the substitution applies at once; the substitute takes the throw', () => {
    const s = throwIn(0, 1);
    const r = s.match.restart;
    const t = r.taker;
    const p = s.players[t]!;
    expect([p.act, p.actA, s.ball.owner]).toEqual([ActionKind.THROW_IN, ThrowState.APPROACH, -1]);
    const inR = benchOutfield(s, 0)[0]!;
    expect(requestSub(s, 0, t, inR)).toBe(1);
    const ev = doSubsTick(s);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => [e.a, e.b, e.c])).toEqual([[0, t, inR]]);
    expect([p.rosterIdx, p.act, r.taker, s.teams[0]!.subCount, s.teams[0]!.subsUsed]).toEqual([inR, ActionKind.NONE, t, 0, 1]);
    expectBallOnLine(s);
    expect(staticFailures(s)).toEqual([]);
    const kicks = playThrow(s, 600);
    expect(kicks.map((e) => e.a)).toEqual([t]);
    expect(s.players[t]!.rosterIdx).toBe(inR);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('waiting in HOLD (ball in his hands): applied at once, the held ball goes back on the line, the substitute throws', () => {
    const s = throwIn(0, T_RULES.restartSetupTicks + 2);
    const r = s.match.restart;
    const t = r.taker;
    const p = s.players[t]!;
    expect([r.ready, p.act, p.actA, s.ball.owner]).toEqual([1, ActionKind.THROW_IN, ThrowState.HOLD, t]);
    expect(s.ball.y).toBeGreaterThan(1.5); // above his head
    const inR = benchOutfield(s, 0)[1]!;
    expect(requestSub(s, 0, t, inR)).toBe(1);
    const ev = doSubsTick(s);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => [e.b, e.c])).toEqual([[t, inR]]);
    expect([p.rosterIdx, p.act, r.taker, r.taken]).toEqual([inR, ActionKind.NONE, t, 0]);
    expectBallOnLine(s);
    expect(staticFailures(s)).toEqual([]);
    const kicks = playThrow(s, 600);
    expect(kicks.map((e) => e.a)).toEqual([t]);
    expect(s.players[t]!.rosterIdx).toBe(inR);
  });

  it('waiting in CHARGE (long-throw power filling): applied at once, the ball goes back on the line', () => {
    const s = throwIn(1, T_RULES.restartSetupTicks + 2);
    const t = s.match.restart.taker;
    const p = s.players[t]!;
    expect([p.actA, s.ball.owner]).toEqual([ThrowState.HOLD, t]);
    p.actA = ThrowState.CHARGE; p.actCharging = 1; p.actPower = 0.4; // LOB held
    const inR = benchOutfield(s, 1)[0]!;
    expect(requestSub(s, 1, t, inR)).toBe(1);
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION).map((e) => e.b)).toEqual([t]);
    expect([p.rosterIdx, p.act, p.actCharging]).toEqual([inR, ActionKind.NONE, 0]);
    expectBallOnLine(s);
  });

  it('a committed throw (WINDUP, or already released) defers the substitution; waiting again applies it', () => {
    const s = throwIn(0, T_RULES.restartSetupTicks + 2);
    const t = s.match.restart.taker;
    const p = s.players[t]!;
    const inR = benchOutfield(s, 0)[0]!;
    expect(requestSub(s, 0, t, inR)).toBe(1);
    p.actA = ThrowState.WINDUP; p.actDone = 0;
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION)).toHaveLength(0);
    expect([p.rosterIdx, p.act, s.teams[0]!.subCount, s.teams[0]!.subOut[0]]).toEqual([t, ActionKind.THROW_IN, 1, t]);
    p.actA = ThrowState.HOLD; p.actDone = 1; // released (defensive: any done throw counts as committed)
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION)).toHaveLength(0);
    expect(s.teams[0]!.subCount).toBe(1);
    p.actDone = 0; // waiting again: applied now
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION).map((e) => e.b)).toEqual([t]);
    expect([p.rosterIdx, s.teams[0]!.subCount]).toEqual([inR, 0]);
  });

  it('the throw-in taker sent off while holding the ball: the ball goes back on the line, a teammate throws', () => {
    const s = throwIn(0, T_RULES.restartSetupTicks + 2);
    const t = s.match.restart.taker;
    expect(s.ball.owner).toBe(t);
    doSendOff(s, t);
    expect(s.players[t]!.active).toBe(0);
    expectBallOnLine(s);
    const kicks = playThrow(s, 600);
    expect(kicks).toHaveLength(1);
    expect(kicks[0]!.a).not.toBe(t);
    expect(s.players[kicks[0]!.a]!.team).toBe(0);
  });

  /**
   * The checker's probe through the real step(): the ball rolls over the touchline, and on the first THROW_IN tick
   * the taker's substitution is requested. It must apply within that throw-in (not at a later stoppage), and the
   * substitute takes it. humans = 0 (CPU v CPU) and 2 (the throwing side has a human: the 12 s timeout throws).
   */
  for (const humans of [0, 2]) {
    it(`pipeline (humans=${humans}): a substitution queued for the taker on the first THROW_IN tick applies at that throw-in`, () => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans, ball: { x: 0, y: 0.11, z: 0 } });
      const frames = [createInputFrame(), createInputFrame()];
      const inv = createInvariantChecker('core');
      let team = -1;
      let taker = -1;
      let inR = -1;
      let reqTick = -1;
      const subs: { tick: number; phase: MatchPhase; slot: number }[] = [];
      const kicks: { slot: number; roster: number }[] = [];
      let watchdog = 0;
      for (let i = 0; i < 1200; i++) {
        clearInputFrame(frames[0]!);
        clearInputFrame(frames[1]!);
        if (i === 0) {
          // The loose ball rolls over the near touchline.
          const b = s.ball;
          b.owner = -1; b.heldBy = -1;
          b.x = 0; b.z = HALF_WIDTH - 0.5; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
          b.vx = 0; b.vy = 0; b.vz = 12; b.grounded = 1;
        }
        step(s, frames, EV);
        expect(inv.check(s, EV)).toEqual([]);
        for (const e of EV.toArray()) {
          if (e.type === EventType.SUBSTITUTION) subs.push({ tick: s.tick, phase: s.match.phase, slot: e.b });
          if (e.type === EventType.KICK && e.b === KickKind.THROW_IN) kicks.push({ slot: e.a, roster: s.players[e.a]!.rosterIdx });
          if (e.type === EventType.WATCHDOG && reqTick >= 0) watchdog++;
        }
        if (reqTick < 0 && s.match.phase === MatchPhase.THROW_IN) {
          const r = s.match.restart;
          team = r.team; taker = r.taker;
          expect(taker).toBeGreaterThanOrEqual(0);
          expect(s.players[taker]!.act).toBe(ActionKind.THROW_IN); // the thrower is in his THROW_IN action already
          inR = benchOutfield(s, team)[0]!;
          expect(requestSub(s, team, taker, inR)).toBe(1);
          reqTick = s.tick;
        }
        if (reqTick >= 0 && s.match.phase !== MatchPhase.THROW_IN) break;
      }
      expect(reqTick).toBeGreaterThan(0);
      // Applied on the very next tick, inside the same THROW_IN phase.
      expect(subs).toEqual([{ tick: reqTick + 1, phase: MatchPhase.THROW_IN, slot: taker }]);
      expect([s.players[taker]!.rosterIdx, s.teams[team]!.subsUsed, s.teams[team]!.subCount]).toEqual([inR, 1, 0]);
      // The throw-in was then taken (by the substitute in the same slot), and play went on.
      expect(kicks).toEqual([{ slot: taker, roster: inR }]);
      expect(s.match.phase).not.toBe(MatchPhase.THROW_IN);
      expect(watchdog).toBe(0); // a normal throw (CPU or the human timeout default), never a forced restart
      const tp = s.players[taker]!;
      expect(tp.act !== ActionKind.THROW_IN || tp.actA === ThrowState.RECOVER).toBe(true); // stepping back in, or free
    });
  }
});

// ================================================================ sending off

describe('RUL-10 sending off', () => {
  it('outfield player: inactive, parked off the pitch, roster SENT_OFF, onPitch 10, references cleared, AI reshapes', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[1]!;
    const p = s.players[15]!;
    t.chaser = 15; t.pressSlot = 15; t.coverSlot = 15; t.supportSlot = 15; t.supportCallT = 30;
    t.runSlot = 15; t.runCallT = 30; t.passGoSlot = 15; t.passGoT = 30; t.shapeT = 7;
    s.ball.passTarget = 15;
    s.ctrl[3]!.receiver = 15; s.ctrl[3]!.secondDef = 15;
    beginAction(p, ActionKind.SLIDE_TACKLE, 40, 10);
    p.vx = 6; p.wantSprint = 1;
    const ev = doSendOff(s, 15);
    expect([p.active, p.act, p.ctrl, p.vx, p.vz, p.wantSprint, p.isKeeper]).toEqual([0, ActionKind.NONE, -1, 0, 0, 0, 0]);
    expect(Math.abs(p.z)).toBeGreaterThan(BOARD_Z);
    expect(Math.abs(p.z)).toBeLessThanOrEqual(WORLD_MAX_Z);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(WORLD_MAX_X);
    expect([t.roster[p.rosterIdx], t.onPitch, t.keeperSlot]).toEqual([RosterStatus.SENT_OFF, 10, 11]);
    expect([t.chaser, t.pressSlot, t.coverSlot, t.supportSlot, t.supportCallT, t.runSlot, t.runCallT, t.passGoSlot, t.passGoT])
      .toEqual([-1, -1, -1, -1, 0, -1, 0, -1, 0]);
    expect([s.ball.passTarget, s.ctrl[3]!.receiver, s.ctrl[3]!.secondDef]).toEqual([-1, -1, -1]);
    expect(t.shapeT).toBe(0); // TAI-01 recomputes the shape for 10 at once
    expect(findEvents(ev, EventType.FORFEIT)).toHaveLength(0);
    expect(findEvents(ev, EventType.SUBSTITUTION)).toHaveLength(0);
    expect(H.released).toEqual([15]);
    expect(staticFailures(s)).toEqual([]);
    // Idempotent; a substituted / sent-off player cannot be brought back in his slot.
    const h = hashState(s);
    doSendOff(s, 15);
    expect(hashState(s)).toBe(h);
    expect(requestSub(s, 1, 15, benchOutfield(s, 1)[0]!)).toBe(0);
  });

  it('parking spots are off the pitch and distinct per slot', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const spots = new Set<string>();
    for (const slot of [1, 2, 3, 12, 13, 14]) {
      doSendOff(s, slot);
      const p = s.players[slot]!;
      expect(Math.abs(p.z) > HALF_WIDTH || Math.abs(p.x) > HALF_LENGTH).toBe(true);
      spots.add(`${p.x},${p.z}`);
    }
    expect(spots.size).toBe(6);
    expect(LOCAL_TUNING.parkZ).toBeGreaterThan(BOARD_Z);
    expect(LOCAL_TUNING.parkZ).toBeLessThan(WORLD_MAX_Z);
  });

  it('invalid slots are ignored (no throw, no change)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const h = hashState(s);
    for (const slot of [-1, NUM_SLOTS, 3.5, NaN, Infinity]) expect(doSendOff(s, slot)).toEqual([]);
    expect(hashState(s)).toBe(h);
  });

  it('the restart taker sent off while waiting: RUL-11 re-picks a valid taker of the same team', () => {
    const s = makeScenario({ phase: MatchPhase.FREE_KICK });
    const r = s.match.restart;
    r.kind = RestartKind.FREE_KICK; r.team = 0; r.x = 10; r.z = 5; r.taker = 6; r.taken = 0;
    s.ball.x = 10; s.ball.z = 5; s.ball.px = 10; s.ball.pz = 5;
    doSendOff(s, 6);
    tickRules(s);
    expect(r.taker).not.toBe(6);
    expect(s.players[r.taker]!.active).toBe(1);
    expect(s.players[r.taker]!.team).toBe(0);
  });

  it('sent-off ball owner: the ball is released', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    s.ball.owner = 9;
    doSendOff(s, 9);
    expect(s.ball.owner).toBe(-1);
    expect(staticFailures(s)).toEqual([]);
  });

  it('glitch "lands on a sent-off player": the controller re-picks an active teammate at once', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 7 }] });
    doSendOff(s, 7);
    const c = s.ctrl[0]!;
    expect(c.slot).not.toBe(7);
    expect(c.slot).toBeGreaterThanOrEqual(0);
    expect(s.players[c.slot]!.active).toBe(1);
    expect(s.players[c.slot]!.ctrl).toBe(0);
    expect(s.players[7]!.ctrl).toBe(-1);
    expect(staticFailures(s)).toEqual([]);
  });

  it('keeper sent off with substitutions left: the bench keeper replaces the most advanced outfield player', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    const bk = benchKeeperIdx(s, 0);
    const form = getFormation(t.formation);
    const outfield = activeSlots(s, 0).filter((i) => s.players[i]!.isKeeper === 0);
    const maxNx = Math.max(...outfield.map((i) => form.slots[s.players[i]!.formIdx]!.nx));
    const ev = doSendOff(s, 0);
    const subs = findEvents(ev, EventType.SUBSTITUTION);
    expect(subs).toHaveLength(1);
    const slot = subs[0]!.b;
    const outRoster = subs[0]!.d;
    expect([subs[0]!.a, subs[0]!.c]).toEqual([0, bk]);
    expect(outfield).toContain(slot);
    expect(form.slots[outRoster]!.nx).toBe(maxNx); // starters' roster index = formation index
    const k = s.players[slot]!;
    expect([k.active, k.isKeeper, k.role, k.formIdx, k.rosterIdx, t.keeperSlot]).toEqual([1, 1, Role.GK, 0, bk, slot]);
    expect(k.x).toBeCloseTo(-t.dir * (HALF_LENGTH - LOCAL_TUNING.keeperSpawnDepth), 6);
    expect(k.z).toBe(0);
    const exp = createPlayerAttrs();
    copyAttrs(exp, s.squads[0]![bk]!);
    expect(s.attrs[slot]).toEqual(exp);
    expect([t.roster[0], t.roster[outRoster], t.roster[bk]]).toEqual([RosterStatus.SENT_OFF, RosterStatus.SUBBED_OFF, RosterStatus.PLAYING]);
    expect([t.subsUsed, t.onPitch, s.players[0]!.active, s.players[0]!.isKeeper]).toEqual([1, 10, 0, 0]);
    expect(activeKeepers(s, 0)).toEqual([slot]);
    expect(playingCount(s, 0)).toBe(10);
    expect(staticFailures(s)).toEqual([]);
  });

  it('keeper sent off with no substitutions left: the outfield player with the best gk attributes goes in goal', () => {
    const s = makeScenario({ phase: MatchPhase.FREE_KICK });
    const t = s.teams[1]!;
    t.subsUsed = MAX_SUBS;
    const a = s.attrs[17]!;
    a.gkDiving = 60; a.gkHandling = 55; a.gkReflexes = 58; a.gkPositioning = 50; a.gkKicking = 40;
    s.attrs[14]!.gkDiving = 70; // one high value, lower total
    const xz = [s.players[17]!.x, s.players[17]!.z];
    const ev = doSendOff(s, 11);
    expect(findEvents(ev, EventType.SUBSTITUTION)).toHaveLength(0);
    const p = s.players[17]!;
    expect([p.isKeeper, p.role, p.formIdx, p.rosterIdx, t.keeperSlot, t.subsUsed, t.onPitch]).toEqual([1, Role.GK, 0, 6, 17, MAX_SUBS, 10]);
    expect([p.x, p.z]).toEqual(xz); // walks back; no teleport
    expect(s.attrs[17]!.gkDiving).toBe(60); // keeps his own attributes
    expect(t.roster[benchKeeperIdx(s, 1)]).toBe(RosterStatus.BENCH);
    expect(activeKeepers(s, 1)).toEqual([17]);
    expect(staticFailures(s)).toEqual([]);
  });

  it('keeper sent off with substitutions left but no bench keeper: an outfield player goes in goal', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    // Bench keeper already on (keeper substituted earlier), then the new keeper is sent off.
    requestSub(s, 0, 0, benchKeeperIdx(s, 0));
    s.match.phase = MatchPhase.CORNER;
    doSubsTick(s);
    expect(t.subsUsed).toBe(1);
    const ev = doSendOff(s, 0);
    expect(findEvents(ev, EventType.SUBSTITUTION)).toHaveLength(0);
    expect(t.subsUsed).toBe(1);
    expect(t.keeperSlot).not.toBe(0);
    expect(activeKeepers(s, 0)).toEqual([t.keeperSlot]);
    expect(s.players[t.keeperSlot]!.formIdx).toBe(0);
    expect(staticFailures(s)).toEqual([]);
  });

  it('keeper sent off: the bench keeper does not take the ball owner or the restart taker off', () => {
    const s = makeScenario({ phase: MatchPhase.THROW_IN });
    const form = getFormation(s.teams[0]!.formation);
    const outfield = activeSlots(s, 0).filter((i) => s.players[i]!.isKeeper === 0);
    const byNx = [...outfield].sort((x, y) => form.slots[s.players[y]!.formIdx]!.nx - form.slots[s.players[x]!.formIdx]!.nx || x - y);
    s.match.restart.kind = RestartKind.THROW_IN; s.match.restart.team = 0; s.match.restart.taker = byNx[0]!; s.match.restart.taken = 0;
    s.ball.owner = byNx[1]!;
    const ev = doSendOff(s, 0);
    const slot = findEvents(ev, EventType.SUBSTITUTION)[0]!.b;
    expect(slot).not.toBe(byNx[0]);
    expect(slot).not.toBe(byNx[1]);
    expect(s.players[slot]!.isKeeper).toBe(1);
  });

  it('keeper sent off while holding the ball: hands released', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    s.ball.owner = 0; s.ball.heldBy = 0;
    const ev = doSendOff(s, 0);
    expect([s.ball.owner, s.ball.heldBy]).toEqual([-1, -1]);
    expect(findEvents(ev, EventType.KEEPER_HANDS).map((e) => [e.a, e.b])).toEqual([[0, 0]]);
  });

  it('keeper sent off with one substitution left and one queued: the bench keeper uses it, the queued one is dropped', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    t.subsUsed = MAX_SUBS - 1;
    const inR = benchOutfield(s, 0)[0]!;
    expect(requestSub(s, 0, 5, inR)).toBe(1);
    doSendOff(s, 0);
    expect([t.subsUsed, t.subCount]).toEqual([MAX_SUBS, 0]);
    s.match.phase = MatchPhase.THROW_IN;
    expect(findEvents(doSubsTick(s), EventType.SUBSTITUTION)).toHaveLength(0);
    expect(t.roster[inR]).toBe(RosterStatus.BENCH);
    expect(staticFailures(s)).toEqual([]);
  });

  it('keeper sent off with a keeper-for-keeper substitution queued: the queued one is dropped', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    const bk = benchKeeperIdx(s, 0);
    requestSub(s, 0, 0, bk);
    const ev = doSendOff(s, 0);
    expect(findEvents(ev, EventType.SUBSTITUTION).map((e) => e.c)).toEqual([bk]); // came on for an outfielder
    expect(t.subCount).toBe(0);
    expect(t.subsUsed).toBe(1);
  });

  it('pipeline: a keeper sent off in open play; play continues with 10 and every invariant holds', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 0 }], ball: { x: 10, y: 0.11, z: 0 } });
    const inv = createInvariantChecker('core');
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 20; i++) { step(s, frames, EV); expect(inv.check(s, EV)).toEqual([]); }
    EV.begin(s.tick); // the send-off belongs to the next tick's events in a real game; here it is between ticks
    sendOff(s, 0, EV);
    for (let i = 0; i < 120; i++) {
      step(s, frames, EV);
      expect(inv.check(s, EV)).toEqual([]);
    }
    expect(activeSlots(s, 0)).toHaveLength(10);
    expect(activeKeepers(s, 0)).toEqual([s.teams[0]!.keeperSlot]);
    expect(s.players[0]!.active).toBe(0);
  });
});

// ================================================================ forfeit

describe('RUL-10 forfeit', () => {
  it('glitch "a team below 7 players not ending the match": the fifth red card (6 left) forfeits 3-0', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, y: 0.11, z: 0 } });
    s.teams[0]!.goals = 0; s.teams[1]!.goals = 2;
    const reds = [12, 13, 14, 15];
    for (const slot of reds) expect(findEvents(doSendOff(s, slot), EventType.FORFEIT)).toHaveLength(0);
    expect([s.teams[1]!.onPitch, s.match.forfeitTeam]).toEqual([MIN_PLAYERS, -1]);
    const ev = doSendOff(s, 16);
    expect(findEvents(ev, EventType.FORFEIT).map((e) => e.a)).toEqual([1]);
    expect([s.teams[1]!.onPitch, s.match.forfeitTeam]).toEqual([MIN_PLAYERS - 1, 1]);
    // RUL-01 ends the match: FULL_TIME, 3-0 to the other team.
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([3, 0]);
    // No second FORFEIT ever.
    expect(withEv(s, () => checkForfeit(s, EV)).r).toBe(0);
    for (let i = 0; i < 600 && s.match.phase !== MatchPhase.POST_MATCH; i++) {
      expect(findEvents(tickRules(s), EventType.FORFEIT)).toHaveLength(0);
    }
    expect([s.match.phase, s.match.winner]).toEqual([MatchPhase.POST_MATCH, 0]);
  });

  it('pipeline: the team reduced to 6 forfeits through the real step(), invariants hold to POST_MATCH', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, y: 0.11, z: 0 } });
    const inv = createInvariantChecker('core');
    const frames = [createInputFrame(), createInputFrame()];
    for (const slot of [1, 2, 3, 4]) doSendOff(s, slot);
    for (let i = 0; i < 10; i++) { step(s, frames, EV); expect(inv.check(s, EV)).toEqual([]); }
    expect(s.match.forfeitTeam).toBe(-1);
    EV.begin(s.tick);
    sendOff(s, 5, EV);
    expect(s.match.forfeitTeam).toBe(0);
    let reached = false;
    for (let i = 0; i < 1200 && !reached; i++) {
      step(s, frames, EV);
      expect(inv.check(s, EV)).toEqual([]);
      reached = s.match.phase === MatchPhase.POST_MATCH;
    }
    expect(reached).toBe(true);
    expect([s.teams[0]!.goals, s.teams[1]!.goals, s.match.winner]).toEqual([0, 3, 1]);
  });

  it('keeper sent off at 7 players: forfeit, no substitution spent, still exactly one keeper', () => {
    const s = makeScenario({ phase: MatchPhase.FREE_KICK });
    for (const slot of [1, 2, 3, 4]) doSendOff(s, slot);
    const ev = doSendOff(s, 0);
    expect(findEvents(ev, EventType.FORFEIT).map((e) => e.a)).toEqual([0]);
    expect(findEvents(ev, EventType.SUBSTITUTION)).toHaveLength(0);
    expect(s.teams[0]!.subsUsed).toBe(0);
    expect(activeKeepers(s, 0)).toEqual([s.teams[0]!.keeperSlot]);
    expect(staticFailures(s)).toEqual([]);
  });

  it('checkForfeit: counts active players; never twice, never once finished, never in practice', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    expect(withEv(s, () => checkForfeit(s, EV)).r).toBe(0);
    for (const slot of [12, 13, 14, 15, 16]) s.players[slot]!.active = 0; // bypassing sendOff (another module's bug)
    const { r, ev } = withEv(s, () => checkForfeit(s, EV));
    expect([r, s.match.forfeitTeam]).toEqual([1, 1]);
    expect(findEvents(ev, EventType.FORFEIT).map((e) => e.a)).toEqual([1]);
    expect(withEv(s, () => checkForfeit(s, EV)).r).toBe(0);

    const f = makeScenario({ phase: MatchPhase.FULL_TIME });
    f.match.finished = 1;
    for (const slot of [1, 2, 3, 4, 5]) f.players[slot]!.active = 0;
    expect(withEv(f, () => checkForfeit(f, EV)).r).toBe(0);
    expect(f.match.forfeitTeam).toBe(-1);

    const pr = makeScenario({ phase: MatchPhase.IN_PLAY, config: { mode: ModeId.PRACTICE } });
    for (const slot of [1, 2, 3, 4, 5, 6, 7]) doSendOff(pr, slot);
    expect(pr.match.forfeitTeam).toBe(-1);
    expect(withEv(pr, () => checkForfeit(pr, EV)).r).toBe(0);
  });

  it('no forfeit at exactly 7 players', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    for (const slot of [1, 2, 3, 4]) doSendOff(s, slot);
    expect(activeSlots(s, 0)).toHaveLength(MIN_PLAYERS);
    expect(withEv(s, () => checkForfeit(s, EV)).r).toBe(0);
    expect(s.match.forfeitTeam).toBe(-1);
  });
});

// ================================================================ determinism

describe('RUL-10 determinism', () => {
  it('the same substitutions and send-offs give the same state hash', () => {
    const run = (): number => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 99, ball: { x: 0, y: 0.11, z: 0 } });
      const frames = [createInputFrame(), createInputFrame()];
      requestSub(s, 1, 14, benchOutfield(s, 1)[1]!);
      for (let i = 0; i < 30; i++) step(s, frames, EV);
      EV.begin(s.tick);
      sendOff(s, 11, EV);
      sendOff(s, 3, EV);
      s.match.phase = MatchPhase.THROW_IN;
      EV.begin(s.tick);
      subsTick(s, EV);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

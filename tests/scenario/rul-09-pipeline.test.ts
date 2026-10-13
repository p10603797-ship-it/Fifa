/**
 * RUL-09 through the real step() pipeline: rulesTick order (offside -> fouls -> crossings -> restarts -> subs ->
 * clock), real ball flight and line crossing, the real RUL-01 machine (goal / period end resolve a running advantage
 * and call showCard) and the RUL-11 restart flow.
 *
 * Mocked so only the test decides what happens: team AI and CPU brains are no-ops (players stand still); the contact
 * stage is a per-test hook that writes challenge records and possession changes the way SIM-14 / SIM-06 would. The
 * foul roll is pinned (always passes) only in the tick a record is pushed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CardKind, ChallengeKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { hashState } from '../../src/sim/core/hash';
import { INVARIANT_NAMES } from '../../src/sim/debug/invariants';
import { findEvents, runTicks } from '../harness/scenario';
import { challenge, foulScene, give, putU } from './rul-09-setup';

const H = vi.hoisted(() => ({
  hook: null as null | ((s: unknown, ev: unknown) => void),
  pin: false,
}));

vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()),
  teamAiTick: () => { /* none */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()),
  cpuThink: () => { /* none */ },
}));
vi.mock('../../src/sim/contacts', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/contacts')>()),
  contactsTick: (s: unknown, ev: unknown) => { H.pin = false; H.hook?.(s, ev); },
}));
vi.mock('../../src/sim/core/rng', async (orig) => {
  const m = await orig<typeof import('../../src/sim/core/rng')>();
  // RUL-09 rolls are rngInt(s.rng, ROLL_SCALE = 2^24) < p * ROLL_SCALE: pinned to pass (0) while H.pin is set.
  return { ...m, rngInt: (r: Parameters<typeof m.rngInt>[0], n: number) => (H.pin && n === 1 << 24 ? 0 : m.rngInt(r, n)) };
});

beforeEach(() => { H.hook = null; H.pin = false; });

type Hook = (s: SimState, ev: EventSink, k: number) => void;
/** Install a contact-stage hook; k counts the ticks since install (1 = first tick). */
function setHook(fn: Hook): void {
  let k = 0;
  H.hook = (s, ev) => { k++; fn(s as SimState, ev as EventSink, k); };
}

const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser' && n !== 'phaseMax');
const VIC = 9;
const TAC = 15;
const TAC2 = 16;

/** Home striker 9 on the ball at attack-frame u (attacking half), away 15 beside him. */
function scene(u = 15, seed = 5): SimState {
  const s = foulScene({ seed });
  putU(s, VIC, u, 0);
  s.players[TAC]!.x = s.players[VIC]!.x - 0.8; s.players[TAC]!.z = 0.5;
  give(s, VIC);
  return s;
}

/** Push a reckless (yellow) foul by 15 on 9 at hook tick 1, pinning the roll for this tick. */
function foulAt1(s: SimState, k: number): void {
  if (k !== 1) return;
  H.pin = true;
  challenge(s, { tackler: TAC, victim: VIC, kind: ChallengeKind.STAND, fromBehind: 1, closingSpeed: 7 });
  s.match.challenges[0]!.tick = s.tick;
}

const tickOf = (evs: readonly SimEvent[], t: EventType, f?: (e: SimEvent) => boolean): number => findEvents(evs, t, f)[0]?.tick ?? -1;

describe('RUL-09 through step()', () => {
  it('foul -> FOUL + free kick: RUL-01 phase FREE_KICK, RUL-11 restart flow becomes ready', () => {
    const s = scene(-35); // own third: no advantage
    setHook((st, ev, k) => foulAt1(st, k));
    const ev = runTicks(s, T_RULES.restartSetupTicks + 5, undefined, { check: 'core' });
    expect(findEvents(ev, EventType.FOUL).map((e) => [e.a, e.b, e.d])).toEqual([[TAC, VIC, 0]]);
    expect(findEvents(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW]]);
    const r = findEvents(ev, EventType.RESTART_AWARDED)[0]!;
    expect([r.a, r.b]).toEqual([RestartKind.FREE_KICK, 0]);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.ready).toBe(1);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('advantage, then the fouled team scores: goal stands, RUL-01 plays the advantage on and shows the card to the offender', () => {
    const s = scene(30);
    setHook((st, ev, k) => {
      foulAt1(st, k);
      if (k === 20) { // shot from 9 into the net
        const b = st.ball;
        b.owner = -1; b.x = 49; b.z = 0.5; b.y = 0.5; b.px = b.x; b.pz = b.z; b.py = b.y;
        b.vx = 25 * st.teams[0]!.dir; b.vy = 0; b.vz = 0; b.grounded = 0;
        b.lastTouch = VIC; b.lastTouchTeam = 0; b.lastTouchTick = st.tick;
      }
    });
    const ev = runTicks(s, 40, undefined, { check: CHECKS as never });
    const adv = findEvents(ev, EventType.ADVANTAGE).map((e) => [e.a, e.b]);
    expect(adv).toEqual([[1, 0], [0, 0]]);
    const goalT = tickOf(ev, EventType.GOAL);
    expect(goalT).toBeGreaterThan(0);
    expect(findEvents(ev, EventType.GOAL)[0]!.a).toBe(0);
    const cards = findEvents(ev, EventType.CARD);
    expect(cards.map((e) => [e.a, e.b, e.tick])).toEqual([[TAC, CardKind.YELLOW, goalT]]);
    expect(findEvents(ev, EventType.RESTART_AWARDED, (e) => e.a === RestartKind.FREE_KICK)).toEqual([]);
    expect(s.teams[0]!.goals).toBe(1);
  });

  it('advantage lost to the opponents: brought back, card and free kick at the foul spot in the same tick', () => {
    const s = scene(20);
    let spotX = 0;
    setHook((st, ev, k) => {
      foulAt1(st, k);
      if (k === 1) spotX = st.players[VIC]!.x;
      if (k === 30) give(st, TAC2);
    });
    const ev = runTicks(s, 40, undefined, { check: CHECKS as never });
    const back = findEvents(ev, EventType.ADVANTAGE, (e) => e.a === 2)[0]!;
    const card = findEvents(ev, EventType.CARD)[0]!;
    const r = findEvents(ev, EventType.RESTART_AWARDED)[0]!;
    expect([card.a, card.tick]).toEqual([TAC, back.tick]);
    expect([r.a, r.b, r.tick]).toEqual([RestartKind.FREE_KICK, 0, back.tick]);
    expect(r.x).toBeCloseTo(spotX, 6);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  });

  it('advantage waved away, ball later out of play: the card is shown in the stoppage tick, before the restart', () => {
    const s = scene(20);
    setHook((st, ev, k) => {
      foulAt1(st, k);
      if (k === T_RULES.advantageTicks + 20) { // a clearance into touch by another away player
        const b = st.ball;
        b.owner = -1; b.x = 10; b.z = 33.5; b.y = 0.11; b.px = 10; b.pz = 33.5; b.vx = 0; b.vy = 0; b.vz = 12; b.grounded = 1;
        b.lastTouch = TAC2; b.lastTouchTeam = 1; b.lastTouchTick = st.tick;
      }
    });
    const ev = runTicks(s, T_RULES.advantageTicks + 30, undefined, { check: CHECKS as never });
    expect(findEvents(ev, EventType.ADVANTAGE).map((e) => e.a)).toEqual([1, 0]);
    const card = findEvents(ev, EventType.CARD)[0]!;
    const r = findEvents(ev, EventType.RESTART_AWARDED)[0]!;
    expect(card.a).toBe(TAC);
    expect(r.a).toBe(RestartKind.THROW_IN);
    expect(card.tick).toBe(r.tick);
    expect(ev.indexOf(card)).toBeLessThan(ev.indexOf(r));
    expect(s.match.advantage.card).toBe(CardKind.NONE);
  });

  it('advantage waved away and the half ends before any other stoppage: the card is still shown, before PERIOD_END', () => {
    const s = scene(20);
    const m = s.match;
    m.periodT = m.periodLen - (T_RULES.advantageTicks + 40);
    setHook((st, ev, k) => {
      foulAt1(st, k);
      if (k === T_RULES.advantageTicks + 5) { // play drifts back to midfield (neutral: the half may end)
        st.ball.owner = -1;
        st.ball.x = 0; st.ball.z = 0; st.ball.px = 0; st.ball.pz = 0; st.ball.vx = 0; st.ball.vz = 0;
        st.ball.lastTouch = VIC; st.ball.lastTouchTeam = 0; st.ball.lastTouchTick = st.tick;
      }
    });
    const ev = runTicks(s, T_RULES.advantageTicks + 80, undefined, { check: CHECKS as never });
    const end = findEvents(ev, EventType.PERIOD_END)[0]!;
    expect(end).toBeDefined();
    const card = findEvents(ev, EventType.CARD)[0]!;
    expect(card.a).toBe(TAC);
    expect(ev.indexOf(card)).toBeLessThan(ev.indexOf(end));
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('arcade mode through step(): records consumed, nothing called', () => {
    const s = foulScene({ fouls: 0 });
    putU(s, VIC, 45, 0);
    s.players[TAC]!.x = s.players[VIC]!.x - 0.8;
    give(s, VIC);
    setHook((st, ev, k) => { if (k <= 3) challenge(st, { tackler: TAC, victim: VIC, kind: ChallengeKind.SLIDE, fromBehind: 1, closingSpeed: 9, i: 0 }); });
    const ev = runTicks(s, 6);
    expect(findEvents(ev, EventType.FOUL)).toEqual([]);
    expect(findEvents(ev, EventType.CARD)).toEqual([]);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('determinism through step(): same scenario twice -> same hash every tick and same events', () => {
    const run = (): { hashes: number[]; ev: SimEvent[] } => {
      const s = scene(30, 21);
      setHook((st, ev, k) => {
        if (k % 13 === 1 && st.match.phase === MatchPhase.IN_PLAY) {
          const vic = 1 + (k % 10);
          putU(st, vic, -10 + (k % 40), -10 + (k % 20));
          st.players[TAC]!.x = st.players[vic]!.x + 0.5; st.players[TAC]!.z = st.players[vic]!.z;
          if (k % 2 === 0) give(st, vic); else give(st, TAC);
          challenge(st, { tackler: TAC, victim: vic, kind: (k % 6) as ChallengeKind, fromBehind: ((k % 5) - 2) / 2, closingSpeed: k % 9, i: 0 });
          st.match.challenges[0]!.tick = st.tick;
        }
      });
      const hashes: number[] = [];
      const ev = runTicks(s, 300, undefined, { until: (st) => { hashes.push(hashState(st)); return false; } });
      return { hashes, ev };
    };
    const a = run();
    const b = run();
    expect(b.hashes).toEqual(a.hashes);
    expect(b.ev).toEqual(a.ev);
    expect(findEvents(a.ev, EventType.FOUL).length).toBeGreaterThan(0);
  });
});

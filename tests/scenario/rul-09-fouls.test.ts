/**
 * RUL-09 fouls, advantage and cards: foulsTick driven directly (one rules stage per tick) on quiet scenes built with
 * makeScenario; restarts go through the real RUL-11 awardRestart and RUL-01 setPhase. SIM-14 knockDown and RUL-10
 * sendOff are wrapped (the real functions still run) so the tests can see who was knocked down / sent off.
 * The foul / red roll (rngInt at ROLL_SCALE) is wrapped too: H.draw = a number pins every roll to `draw < p` (flow tests:
 * 0 = every foul roll passes);
 * H.draw = null uses the real seeded RNG (determinism and rate tests).
 *
 * Glitch list "Discipline" lines covered here: "glitch: advantage that never resolves", "glitch: card shown to the
 * wrong player" (named tests below).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import {
  ActionKind, CardKind, ChallengeKind, ChallengeOutcome, CrossKind, KickKind, MatchPhase, RestartKind,
} from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { ChallengeRecord, SimState } from '../../src/contracts/state';
import { T_FOUL, T_RULES } from '../../src/contracts/tuning';
import { hashState } from '../../src/sim/core/hash';
import { rngFloat, rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING, classifyChallenge, foulsTick, showCard } from '../../src/sim/rules/fouls';
import {
  EVB, challenge, foulScene, give, loose, ofType, putU, runFouls, tickFouls, xOf,
} from './rul-09-setup';

const H = vi.hoisted(() => ({
  draw: 0 as number | null,
  knock: [] as { slot: number; kind: number; phase: number; tick: number }[],
  sent: [] as number[],
}));

vi.mock('../../src/sim/core/rng', async (orig) => {
  const m = await orig<typeof import('../../src/sim/core/rng')>();
  return {
    ...m,
    // RUL-09 rolls are rngInt(s.rng, ROLL_SCALE = 2^24) < p * ROLL_SCALE: pinned to `draw < p` when H.draw is set.
    rngInt: (r: Parameters<typeof m.rngInt>[0], n: number) =>
      (H.draw === null || n !== 1 << 24 ? m.rngInt(r, n) : Math.floor(H.draw * n)),
  };
});
vi.mock('../../src/sim/defend/tackle', async (orig) => {
  const m = await orig<typeof import('../../src/sim/defend/tackle')>();
  return {
    ...m,
    knockDown: (s: SimState, slot: number, kind: ActionKind, ev: Parameters<typeof m.knockDown>[3]) => {
      H.knock.push({ slot, kind, phase: s.match.phase, tick: s.tick });
      m.knockDown(s, slot, kind, ev);
    },
  };
});
vi.mock('../../src/sim/rules/subs', async (orig) => {
  const m = await orig<typeof import('../../src/sim/rules/subs')>();
  return {
    ...m,
    sendOff: (s: SimState, slot: number, ev: Parameters<typeof m.sendOff>[2]) => {
      H.sent.push(slot);
      m.sendOff(s, slot, ev);
    },
  };
});

beforeEach(() => {
  H.draw = 0;
  H.knock.length = 0;
  H.sent.length = 0;
});

const K = ChallengeKind;
const O = ChallengeOutcome;
const VIC = 9; // home striker (team 0)
const MATE = 10; // home teammate
const TAC = 15; // away defender (team 1)
const TAC2 = 16; // another away defender

const types = (evs: readonly SimEvent[]): EventType[] => evs.map((e) => e.type);
const restartOf = (evs: readonly SimEvent[]): SimEvent | undefined => evs.find((e) => e.type === EventType.RESTART_AWARDED);
const advOf = (evs: readonly SimEvent[]): number[] => ofType(evs, EventType.ADVANTAGE).map((e) => e.a);

/** Victim 9 at attack-frame (u, z) with tackler 15 next to him. */
function duel(s: SimState, u: number, z = 0): void {
  putU(s, VIC, u, z);
  const v = s.players[VIC]!;
  s.players[TAC]!.x = v.x - 0.8 * s.teams[0]!.dir;
  s.players[TAC]!.z = z + 0.5;
}

/** A plain foul (stand tackle from the side, no card). */
const plain = (s: SimState, tackler = TAC, victim = VIC): ChallengeRecord => challenge(s, { tackler, victim, kind: K.STAND, fromBehind: 0, closingSpeed: 3 });
/** A reckless foul (stand tackle from behind above recklessSpeed): yellow. */
const reckless = (s: SimState, tackler = TAC, victim = VIC): ChallengeRecord =>
  challenge(s, { tackler, victim, kind: K.STAND, fromBehind: 1, closingSpeed: T_FOUL.recklessSpeed + 1 });
/** Serious foul play (slide from behind, very fast, no ball): red when the red roll passes. */
const violent = (s: SimState, tackler = TAC, victim = VIC): ChallengeRecord =>
  challenge(s, { tackler, victim, kind: K.SLIDE, fromBehind: 1, closingSpeed: 9 });

/** Start an advantage: victim 9 keeps the ball in the attacking half and is fouled by 15. Returns the start events. */
function startAdvantage(s: SimState, foul: (s: SimState) => ChallengeRecord = plain, u = 10): SimEvent[] {
  duel(s, u, 0);
  give(s, VIC);
  foul(s);
  const ev = tickFouls(s);
  expect(advOf(ev)).toEqual([1]);
  return ev;
}

// ================================================================ whistle, spot, penalty

describe('RUL-09 foul -> restart', () => {
  it('foul outside the area: FOUL (offender, victim, outcome, d = 0) and a free kick to the fouled team at the victim', () => {
    const s = foulScene();
    duel(s, -30, 6);
    give(s, TAC); // the tackler came away with the ball: no advantage
    plain(s);
    const ev = tickFouls(s);
    const f = ofType(ev, EventType.FOUL);
    expect(f).toHaveLength(1);
    expect([f[0]!.a, f[0]!.b, f[0]!.c, f[0]!.d]).toEqual([TAC, VIC, O.FOUL, 0]);
    const r = restartOf(ev)!;
    expect([r.a, r.b]).toEqual([RestartKind.FREE_KICK, 0]);
    expect(r.x).toBeCloseTo(s.players[VIC]!.x, 6);
    expect(r.z).toBeCloseTo(6, 6);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.team).toBe(0);
    expect(ofType(ev, EventType.CARD)).toHaveLength(0);
    expect(advOf(ev)).toEqual([]);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('the victim is knocked down (FALLEN) before the restart is awarded, so he finishes his fall', () => {
    const s = foulScene();
    duel(s, -30);
    give(s, TAC);
    plain(s);
    tickFouls(s);
    expect(H.knock).toEqual([{ slot: VIC, kind: ActionKind.FALLEN, phase: MatchPhase.IN_PLAY, tick: s.tick }]);
  });

  // [second half?, victim team] -> penalty to the victim's team at the right end
  for (const swap of [false, true]) {
    for (const vTeam of [0, 1]) {
      it(`foul by a defender in his own area -> PENALTY (d = 1) [${swap ? '2nd' : '1st'} half, victim team ${vTeam}]`, () => {
        const s = foulScene({ swap });
        const victim = vTeam === 0 ? VIC : 20;
        const tackler = vTeam === 0 ? TAC : 4;
        putU(s, victim, 45, 3); // attack frame of the victim: inside the area he attacks
        s.players[tackler]!.x = s.players[victim]!.x; s.players[tackler]!.z = 4;
        give(s, tackler);
        plain(s, tackler, victim);
        const ev = tickFouls(s);
        const f = ofType(ev, EventType.FOUL)[0]!;
        expect([f.a, f.b, f.d]).toEqual([tackler, victim, 1]);
        const r = restartOf(ev)!;
        expect([r.a, r.b]).toEqual([RestartKind.PENALTY, vTeam]);
        expect(r.x).toBeCloseTo(xOf(s, vTeam, HALF_LENGTH - 11), 6);
        expect(s.match.phase).toBe(MatchPhase.PENALTY);
      });
    }
  }

  it('penalty area line counts (lines are part of the area); just outside is a free kick', () => {
    const on = foulScene();
    duel(on, HALF_LENGTH - 16.5, 20.16);
    give(on, TAC);
    plain(on);
    expect(restartOf(tickFouls(on))!.a).toBe(RestartKind.PENALTY);
    const off = foulScene();
    duel(off, HALF_LENGTH - 16.6, 0);
    give(off, TAC);
    plain(off);
    expect(restartOf(tickFouls(off))!.a).toBe(RestartKind.FREE_KICK);
  });

  it('a foul by an attacker inside the opponents\' area is a free kick to the defenders, not a penalty', () => {
    const s = foulScene();
    putU(s, 13, -45, 0); // away defender deep in his own area (away frame)
    s.players[VIC]!.x = s.players[13]!.x - 0.7; s.players[VIC]!.z = 0.5;
    give(s, 13);
    plain(s, VIC, 13);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)[0]!.d).toBe(0);
    const r = restartOf(ev)!;
    expect([r.a, r.b]).toEqual([RestartKind.FREE_KICK, 1]);
  });

  it('records are consumed every tick; a dead ball (restart pending) discards them without a foul', () => {
    const s = foulScene();
    s.match.phase = MatchPhase.THROW_IN;
    s.match.restart.kind = RestartKind.THROW_IN;
    s.match.restart.taken = 0;
    duel(s, 0);
    violent(s);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)).toHaveLength(0);
    expect(s.match.challenges[0]!.active).toBe(0);
    expect(H.knock).toHaveLength(0);
  });

  it('a foul in the tick a restart was taken is whistled through IN_PLAY', () => {
    const s = foulScene();
    s.match.phase = MatchPhase.CORNER;
    s.match.restart.kind = RestartKind.CORNER;
    s.match.restart.taken = 1;
    duel(s, 30, 10);
    give(s, TAC);
    plain(s);
    const ev = tickFouls(s);
    const ph = ofType(ev, EventType.PHASE_CHANGE).map((e) => [e.a, e.b]);
    expect(ph).toEqual([[MatchPhase.CORNER, MatchPhase.IN_PLAY], [MatchPhase.IN_PLAY, MatchPhase.FREE_KICK]]);
    expect(restartOf(ev)!.b).toBe(0);
  });

  it('two fouls in one tick: the first is whistled, the second record is discarded', () => {
    const s = foulScene();
    duel(s, -30);
    give(s, TAC);
    plain(s);
    putU(s, MATE, -20, 10);
    s.players[TAC2]!.x = s.players[MATE]!.x; s.players[TAC2]!.z = 10.5;
    reckless(s, TAC2, MATE);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)).toHaveLength(1);
    expect(ofType(ev, EventType.CARD)).toHaveLength(0);
    expect(ofType(ev, EventType.RESTART_AWARDED)).toHaveLength(1);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('the same contact recorded twice in one tick is judged once', () => {
    const s = foulScene();
    duel(s, 10);
    give(s, VIC);
    reckless(s);
    reckless(s);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)).toHaveLength(1);
    expect(advOf(ev)).toEqual([1]);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('a repeat record of the incident the advantage is for is ignored; a later one is a new foul', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    reckless(s); // same pair, next tick (SIM-14 recording the contact again)
    let ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)).toEqual([]);
    expect(s.match.advantage.active).toBe(1);
    runFouls(s, LOCAL_TUNING.sameIncidentTicks);
    reckless(s); // a fresh challenge by the same player on the same victim, later: a second foul -> whistle
    ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)).toHaveLength(1);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW], [TAC, CardKind.SECOND_YELLOW]]);
    expect(H.sent).toEqual([TAC]);
  });

  it('a clean challenge emits nothing and changes nothing but the record', () => {
    const s = foulScene();
    duel(s, 0);
    give(s, VIC);
    challenge(s, { tackler: TAC, victim: VIC, kind: K.STAND, ballFirst: 1, fromBehind: -1, closingSpeed: 2 });
    const h0 = hashState(s);
    const ev = tickFouls(s);
    expect(ev).toEqual([]);
    expect(s.match.challenges[0]!.active).toBe(0);
    s.match.challenges[0]!.active = 1; // only the record changed
    s.tick--;
    expect(hashState(s)).toBe(h0);
  });
});

// ================================================================ arcade mode

describe('RUL-09 arcade mode (config.fouls = 0)', () => {
  it('every challenge is clean: no FOUL / CARD / ADVANTAGE / restart, no knock-down, RNG untouched, records cleared', () => {
    H.draw = null;
    const s = foulScene({ fouls: 0 });
    duel(s, 45, 0);
    give(s, VIC);
    violent(s);
    reckless(s, TAC2, VIC);
    const rng0 = { ...s.rng };
    const ev = runFouls(s, 5);
    expect(ev).toEqual([]);
    expect(s.rng).toEqual(rng0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(H.knock).toHaveLength(0);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
    for (let i = 0; i < NUM_SLOTS; i++) expect(s.players[i]!.yellow).toBe(0);
  });
});

// ================================================================ cards

describe('RUL-09 cards', () => {
  it('showCard: yellow, second yellow -> SECOND_YELLOW + sendOff, red -> sendOff', () => {
    const s = foulScene();
    const out: SimEvent[] = [];
    const sink = { emit: (type: EventType, a = 0, b = 0) => { out.push({ type, tick: s.tick, a, b, c: 0, d: 0, x: 0, y: 0, z: 0 }); } };
    showCard(s, 7, CardKind.YELLOW, sink);
    expect(s.players[7]!.yellow).toBe(1);
    expect(H.sent).toEqual([]);
    showCard(s, 7, CardKind.YELLOW, sink);
    expect(H.sent).toEqual([7]);
    showCard(s, 18, CardKind.RED, sink);
    expect(H.sent).toEqual([7, 18]);
    expect(s.players[18]!.yellow).toBe(0);
    showCard(s, 19, CardKind.SECOND_YELLOW, sink);
    expect(H.sent).toEqual([7, 18, 19]);
    expect(out.map((e) => [e.type, e.a, e.b])).toEqual([
      [EventType.CARD, 7, CardKind.YELLOW], [EventType.CARD, 7, CardKind.SECOND_YELLOW], [EventType.CARD, 18, CardKind.RED],
      [EventType.CARD, 19, CardKind.SECOND_YELLOW],
    ]);
  });

  it('showCard ignores NONE, invalid slots and players no longer on the pitch', () => {
    const s = foulScene();
    const out: number[] = [];
    const sink = { emit: (type: EventType) => { out.push(type); } };
    showCard(s, 5, CardKind.NONE, sink);
    for (const bad of [-1, 22, 1.5, NaN]) showCard(s, bad, CardKind.RED, sink);
    s.players[6]!.active = 0;
    showCard(s, 6, CardKind.YELLOW, sink);
    showCard(s, 6, CardKind.RED, sink);
    expect(out).toEqual([]);
    expect(H.sent).toEqual([]);
    expect(s.players[6]!.yellow).toBe(0);
  });

  it('reckless foul: yellow to the tackler at the whistle; a second reckless foul by him: second yellow + sendOff', () => {
    const s = foulScene();
    duel(s, -30);
    give(s, TAC);
    reckless(s);
    let ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)[0]!.c).toBe(O.FOUL_YELLOW);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW]]);
    // Play resumes; the same player commits another reckless foul.
    s.match.restart.taken = 1;
    duel(s, -25);
    give(s, TAC);
    reckless(s);
    ev = tickFouls(s);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.SECOND_YELLOW]]);
    expect(H.sent).toEqual([TAC]);
  });

  it('serious foul play: straight red (no advantage even with the ball kept in a great position)', () => {
    const s = foulScene();
    duel(s, 30, 0);
    give(s, VIC);
    putU(s, 13, 40, 0); // cover: not DOGSO, so the red is for the tackle itself
    violent(s);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)[0]!.c).toBe(O.FOUL_RED);
    expect(advOf(ev)).toEqual([]);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.RED]]);
    expect(H.sent).toEqual([TAC]);
    expect(restartOf(ev)!.a).toBe(RestartKind.FREE_KICK);
    // card before the restart (the offender is off before the free kick is set up)
    expect(types(ev).indexOf(EventType.CARD)).toBeLessThan(types(ev).indexOf(EventType.RESTART_AWARDED));
  });

  it('DOGSO: last defender fouls a carrier through on goal -> red and free kick', () => {
    const s = foulScene();
    duel(s, 28, 0);
    give(s, VIC);
    for (let i = 12; i < 22; i++) if (i !== TAC) s.players[i]!.x = 0; // everyone else upfield of the victim
    plain(s);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)[0]!.c).toBe(O.FOUL_RED);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.RED]]);
  });

  it('gap: violent DOGSO foul only a yellow — a last-defender slide from behind on a through carrier is red on every seed', () => {
    H.draw = null; // the real seeded RNG: the serious-foul-play red roll fails on most of these seeds
    let reds = 0;
    for (let seed = 1; seed <= 40; seed++) {
      H.sent.length = 0;
      const s = foulScene({ seed });
      duel(s, 28, 0);
      give(s, VIC);
      for (let i = 12; i < 22; i++) if (i !== TAC) s.players[i]!.x = 0; // everyone else upfield of the victim
      violent(s);
      const ev = tickFouls(s);
      const f = ofType(ev, EventType.FOUL);
      if (f.length === 0) continue; // the 3% foul roll failure
      expect(f[0]!.c, `seed ${seed}`).toBe(O.FOUL_RED);
      expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.RED]]);
      expect(H.sent).toEqual([TAC]);
      expect(restartOf(ev)!.a).toBe(RestartKind.FREE_KICK);
      reds++;
    }
    expect(reds).toBeGreaterThan(30);
  });

  it('glitch: card shown to the wrong player — the card always goes to the tackler of the record', () => {
    // Away slot 18 fouls home slot 3 while others (incl. a booked victim, the ball owner, the nearest player) are about.
    const s = foulScene();
    putU(s, 3, -28, -8);
    s.players[3]!.yellow = 1; // the victim already has a yellow: must not get a second
    s.players[18]!.x = s.players[3]!.x - 0.5; s.players[18]!.z = -8.4;
    s.players[TAC]!.x = s.players[3]!.x + 0.3; s.players[TAC]!.z = -8; // a different away player is nearer the ball
    give(s, TAC);
    challenge(s, { tackler: 18, victim: 3, kind: K.SLIDE, fromBehind: 1, closingSpeed: 4 });
    const ev = tickFouls(s);
    const cards = ofType(ev, EventType.CARD);
    expect(cards.map((e) => [e.a, e.b])).toEqual([[18, CardKind.YELLOW]]);
    expect(s.players[18]!.yellow).toBe(1);
    expect(s.players[TAC]!.yellow).toBe(0);
    expect(H.sent).toEqual([]);
  });
});

// ================================================================ advantage

describe('RUL-09 advantage', () => {
  it('fouled team keeps the ball in the attacking half: FOUL + ADVANTAGE(1), play on, victim stays up', () => {
    const s = foulScene();
    const ev = startAdvantage(s);
    const a = s.match.advantage;
    expect(types(ev)).toEqual([EventType.FOUL, EventType.ADVANTAGE]);
    expect(ofType(ev, EventType.ADVANTAGE)[0]!.b).toBe(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect([a.active, a.team, a.offender, a.victim, a.penalty, a.startTick]).toEqual([1, 0, TAC, VIC, 0, s.tick]);
    expect(a.x).toBeCloseTo(s.players[VIC]!.x, 6);
    expect(H.knock).toEqual([]);
  });

  it('a teammate has the ball: advantage and the victim goes down', () => {
    const s = foulScene();
    duel(s, 15);
    putU(s, MATE, 20, 8);
    give(s, MATE);
    plain(s);
    expect(advOf(tickFouls(s))).toEqual([1]);
    expect(H.knock.map((k) => [k.slot, k.kind])).toEqual([[VIC, ActionKind.FALLEN]]);
  });

  it('own third: never advantage; own half beyond the third: only with space (promising)', () => {
    const deep = foulScene();
    startNoAdv(deep, -40);
    const crowded = foulScene();
    crowded.players[TAC2]!.x = xOf(crowded, 0, -11); crowded.players[TAC2]!.z = 3; // another opponent close by
    crowded.players[17]!.x = xOf(crowded, 0, -14); crowded.players[17]!.z = -4; // (the offender does not count)
    startNoAdv(crowded, -12);
    const space = foulScene();
    duel(space, -12, 0);
    give(space, VIC);
    space.players[TAC2]!.x = xOf(space, 0, -11); space.players[TAC2]!.z = 3; // one opponent near is still promising
    plain(space);
    expect(advOf(tickFouls(space))).toEqual([1]);

    function startNoAdv(s: SimState, u: number): void {
      const ex = s.players[TAC2]!.x, ez = s.players[TAC2]!.z;
      duel(s, u, 0);
      s.players[TAC2]!.x = ex; s.players[TAC2]!.z = ez;
      give(s, VIC);
      plain(s);
      const ev = tickFouls(s);
      expect(advOf(ev)).toEqual([]);
      expect(restartOf(ev)!.a).toBe(RestartKind.FREE_KICK);
    }
  });

  it('loose ball: advantage only when a fouled-team player is favourite to get it (or touched it last)', () => {
    const yes = foulScene();
    duel(yes, 10);
    putU(yes, MATE, 14, 2);
    loose(yes, xOf(yes, 0, 13), 1, TAC); // poked loose by the tackler, home mate nearest
    plain(yes);
    expect(advOf(tickFouls(yes))).toEqual([1]);
    const no = foulScene();
    duel(no, 10);
    putU(no, TAC2, 10, 12); // away player (team 1 frame u=10 -> x=-10)... place him by x instead
    no.players[TAC2]!.x = xOf(no, 0, 13); no.players[TAC2]!.z = 2;
    loose(no, xOf(no, 0, 13), 1, TAC);
    plain(no);
    expect(advOf(tickFouls(no))).toEqual([]);
    const pass = foulScene(); // the victim had just released a pass
    duel(pass, 10);
    loose(pass, xOf(pass, 0, 20), 5, VIC);
    pass.ball.vx = 12 * pass.teams[0]!.dir;
    plain(pass);
    expect(advOf(tickFouls(pass))).toEqual([1]);
  });

  it('possession kept for advantageTicks: waved away (ADVANTAGE 0) exactly once, no restart, card held until the stoppage', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    expect(s.match.advantage.card).toBe(CardKind.YELLOW);
    const t0 = s.match.advantage.startTick;
    const ev = runFouls(s, T_RULES.advantageTicks + 30);
    const adv = ofType(ev, EventType.ADVANTAGE);
    expect(adv.map((e) => [e.a, e.b, e.tick - t0])).toEqual([[0, 0, T_RULES.advantageTicks]]);
    expect(ofType(ev, EventType.CARD)).toEqual([]);
    expect(restartOf(ev)).toBeUndefined();
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    // Next stoppage: the ball goes out off another away player -> the card goes to the offender, that tick.
    const out = tickFouls(s, (st) => { st.ball.cross = CrossKind.TOUCHLINE; st.ball.lastTouch = TAC2; st.ball.lastTouchTeam = 1; });
    expect(ofType(out, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW]]);
    expect(advOf(out)).toEqual([]);
    expect(restartOf(out)).toBeUndefined(); // the out-of-play restart is RUL-01's
    expect(s.match.advantage.card).toBe(CardKind.NONE);
    expect(s.match.advantage.offender).toBe(-1);
  });

  it('possession lost within the window: brought back (ADVANTAGE 2), card at once, free kick at the foul spot', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    const fx = s.match.advantage.x, fz = s.match.advantage.z;
    runFouls(s, 20);
    putU(s, VIC, 20, 5); // play moved on
    const ev = tickFouls(s, (st) => give(st, TAC2));
    expect(advOf(ev)).toEqual([2]);
    expect(ofType(ev, EventType.ADVANTAGE)[0]!.b).toBe(0);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW]]);
    const r = restartOf(ev)!;
    expect([r.a, r.b]).toEqual([RestartKind.FREE_KICK, 0]);
    expect(r.x).toBeCloseTo(fx, 6);
    expect(r.z).toBeCloseTo(fz, 6);
    const ty = types(ev);
    expect(ty.indexOf(EventType.ADVANTAGE)).toBeLessThan(ty.indexOf(EventType.CARD));
    expect(ty.indexOf(EventType.CARD)).toBeLessThan(ty.indexOf(EventType.RESTART_AWARDED));
    expect(s.match.advantage.active).toBe(0);
  });

  it('the keeper of the offending team taking the ball in his hands is a loss', () => {
    const s = foulScene();
    startAdvantage(s);
    const ev = tickFouls(s, (st) => { give(st, 11); st.ball.heldBy = 11; });
    expect(advOf(ev)).toEqual([2]);
  });

  it('loose ball not collected by the fouled team within advantageKeepTicks: brought back at that tick', () => {
    const s = foulScene();
    duel(s, 10);
    putU(s, MATE, 14, 2);
    loose(s, xOf(s, 0, 13), 1, TAC);
    plain(s);
    const t0 = s.tick + 1;
    const ev = runFouls(s, 60);
    const adv = ofType(ev, EventType.ADVANTAGE);
    expect(adv.map((e) => [e.a, e.tick - t0])).toEqual([[1, 0], [2, T_FOUL.advantageKeepTicks]]);
  });

  it('a teammate collects within advantageKeepTicks: advantage kept, waved away at advantageTicks', () => {
    const s = foulScene();
    duel(s, 10);
    putU(s, MATE, 14, 2);
    loose(s, xOf(s, 0, 13), 1, TAC);
    plain(s);
    const t0 = s.tick + 1;
    const ev = runFouls(s, T_RULES.advantageTicks + 5, (st, k) => { if (k === 30) give(st, MATE); });
    expect(ofType(ev, EventType.ADVANTAGE).map((e) => [e.a, e.tick - t0])).toEqual([[1, 0], [0, T_RULES.advantageTicks]]);
  });

  it('a pass between teammates in flight at the keep deadline is still possession; a defender\'s touch after it is a loss', () => {
    const s = foulScene();
    startAdvantage(s);
    const t0 = s.match.advantage.startTick;
    runFouls(s, T_FOUL.advantageKeepTicks - 3);
    loose(s, xOf(s, 0, 15), 3, VIC); // pass released
    let ev = runFouls(s, 10);
    expect(advOf(ev)).toEqual([]);
    ev = tickFouls(s, (st) => loose(st, xOf(st, 0, 18), 4, TAC2)); // intercepted / deflected by an opponent
    expect(advOf(ev)).toEqual([2]);
    expect(s.tick - t0).toBeGreaterThan(T_FOUL.advantageKeepTicks);
  });

  it('a shot by the fouled team realises the advantage at once (waved away); its miss does not bring play back', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    runFouls(s, 10);
    const shot = tickFouls(s, (st) => {
      loose(st, xOf(st, 0, 30), 0, VIC);
      st.ball.lastKickBy = VIC; st.ball.lastKickTeam = 0; st.ball.lastKickKind = KickKind.SHOT_POWER; st.ball.lastKickTick = st.tick;
    });
    expect(advOf(shot)).toEqual([0]);
    expect(ofType(shot, EventType.CARD)).toEqual([]);
    const out = tickFouls(s, (st) => { st.ball.cross = CrossKind.GOAL_LINE; });
    expect(advOf(out)).toEqual([]);
    expect(restartOf(out)).toBeUndefined();
    expect(ofType(out, EventType.CARD).map((e) => e.a)).toEqual([TAC]);
  });

  it('ball over a line during the advantage (no shot): brought back to the free kick, not the throw-in', () => {
    const s = foulScene();
    startAdvantage(s);
    runFouls(s, 25);
    const ev = tickFouls(s, (st) => { st.ball.cross = CrossKind.TOUCHLINE; });
    expect(advOf(ev)).toEqual([2]);
    expect(restartOf(ev)!.a).toBe(RestartKind.FREE_KICK);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  });

  it('goal for the fouled team: left to RUL-01 (played on there); own goal by the fouled team: brought back', () => {
    const g = foulScene();
    startAdvantage(g);
    runFouls(g, 5);
    const ev = tickFouls(g, (st) => { st.ball.cross = CrossKind.GOAL; st.ball.crossEnd = st.teams[0]!.dir; });
    expect(ev).toEqual([]);
    expect(g.match.advantage.active).toBe(1);
    const og = foulScene();
    startAdvantage(og);
    runFouls(og, 5);
    const ev2 = tickFouls(og, (st) => { st.ball.cross = CrossKind.GOAL; st.ball.crossEnd = -st.teams[0]!.dir; });
    expect(advOf(ev2)).toEqual([2]);
  });

  it('the fouled team\'s human cancels with SHIELD + SPRINT (press edge): brought back', () => {
    const s = foulScene({ humans: [{ side: 0 }] });
    startAdvantage(s);
    const c = s.ctrl[0]!;
    // Pair held from before (no new press): nothing.
    c.buttons = Btn.SHIELD | Btn.SPRINT; c.prevButtons = Btn.SHIELD | Btn.SPRINT;
    expect(advOf(tickFouls(s))).toEqual([]);
    // Only one of the two: nothing.
    c.buttons = Btn.SPRINT; c.prevButtons = 0;
    expect(advOf(tickFouls(s))).toEqual([]);
    // Pair completed this tick.
    c.buttons = Btn.SHIELD | Btn.SPRINT; c.prevButtons = Btn.SPRINT;
    const ev = tickFouls(s);
    expect(advOf(ev)).toEqual([2]);
    expect(restartOf(ev)!.b).toBe(0);
  });

  it('the offending team\'s human cannot cancel the advantage', () => {
    const s = foulScene({ humans: [{ side: 1 }] });
    startAdvantage(s);
    const c = s.ctrl[0]!;
    c.buttons = Btn.SHIELD | Btn.SPRINT; c.prevButtons = 0;
    expect(advOf(tickFouls(s))).toEqual([]);
    expect(s.match.advantage.active).toBe(1);
  });

  it('penalty offence with an on-target shot in flight: advantage; keeper saves -> penalty brought back', () => {
    const s = foulScene();
    duel(s, 44, 2);
    loose(s, xOf(s, 0, 47), 1, MATE);
    s.ball.shotBy = MATE; s.ball.shotOnTarget = 1; s.ball.vx = 25 * s.teams[0]!.dir;
    plain(s);
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.FOUL)[0]!.d).toBe(1);
    expect(advOf(ev)).toEqual([1]);
    expect(s.match.advantage.penalty).toBe(1);
    const save = tickFouls(s, (st) => { give(st, 11); st.ball.heldBy = 11; });
    expect(advOf(save)).toEqual([2]);
    const r = restartOf(save)!;
    expect([r.a, r.b]).toEqual([RestartKind.PENALTY, 0]);
  });

  it('penalty advantage: a goal stands (RUL-01); a miss over the line brings back the penalty; later shots do not wave it away', () => {
    const mk = (): SimState => {
      const s = foulScene();
      duel(s, 44, 2);
      loose(s, xOf(s, 0, 47), 1, MATE);
      s.ball.shotBy = MATE; s.ball.shotOnTarget = 1;
      plain(s);
      expect(advOf(tickFouls(s))).toEqual([1]);
      return s;
    };
    const goal = mk();
    expect(tickFouls(goal, (st) => { st.ball.cross = CrossKind.GOAL; st.ball.crossEnd = st.teams[0]!.dir; })).toEqual([]);
    const miss = mk();
    const ev = tickFouls(miss, (st) => { st.ball.cross = CrossKind.GOAL_LINE; });
    expect(restartOf(ev)!.a).toBe(RestartKind.PENALTY);
    const again = mk();
    const ev2 = tickFouls(again, (st) => {
      loose(st, xOf(st, 0, 48), 0, MATE);
      st.ball.lastKickBy = MATE; st.ball.lastKickTeam = 0; st.ball.lastKickKind = KickKind.SHOT_NORMAL; st.ball.lastKickTick = st.tick;
    });
    expect(advOf(ev2)).toEqual([]);
    expect(again.match.advantage.active).toBe(1);
  });

  it('penalty offence without a shot in flight: penalty at once, even if the attackers keep the ball', () => {
    const s = foulScene();
    duel(s, 44, 2);
    putU(s, MATE, 40, -5);
    give(s, MATE);
    plain(s);
    const ev = tickFouls(s);
    expect(advOf(ev)).toEqual([]);
    expect(restartOf(ev)!.a).toBe(RestartKind.PENALTY);
    const off = foulScene(); // a shot that is off target is no advantage either
    duel(off, 44, 2);
    loose(off, xOf(off, 0, 47), 1, MATE);
    off.ball.shotBy = MATE; off.ball.shotOnTarget = 0;
    plain(off);
    expect(restartOf(tickFouls(off))!.a).toBe(RestartKind.PENALTY);
  });

  it('a second foul during the advantage is whistled: earlier advantage played on, each card to its own offender', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    runFouls(s, 30);
    putU(s, MATE, 25, -6);
    give(s, MATE);
    s.players[TAC2]!.x = s.players[MATE]!.x - 0.7; s.players[TAC2]!.z = -6;
    plain(s, TAC2, MATE);
    const ev = tickFouls(s);
    expect(types(ev).filter((t) => t !== EventType.WHISTLE && t !== EventType.PHASE_CHANGE)).toEqual([
      EventType.FOUL, EventType.ADVANTAGE, EventType.CARD, EventType.RESTART_AWARDED,
    ]);
    expect(advOf(ev)).toEqual([0]);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW]]);
    const r = restartOf(ev)!;
    expect(r.x).toBeCloseTo(s.players[MATE]!.x, 6);
    expect(s.players[TAC2]!.yellow).toBe(0);
  });

  it('a card pending from a waved-away advantage blocks a new advantage and is shown at the new whistle first', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    runFouls(s, T_RULES.advantageTicks + 2);
    expect(s.match.advantage.active).toBe(0);
    expect(s.match.advantage.card).toBe(CardKind.YELLOW);
    duel(s, 20, 3);
    s.players[TAC]!.x = 0; // the first offender is elsewhere now
    s.players[TAC2]!.x = s.players[VIC]!.x - 0.7; s.players[TAC2]!.z = 3;
    give(s, VIC);
    reckless(s, TAC2, VIC);
    const ev = tickFouls(s);
    expect(advOf(ev)).toEqual([]);
    expect(ofType(ev, EventType.CARD).map((e) => [e.a, e.b])).toEqual([[TAC, CardKind.YELLOW], [TAC2, CardKind.YELLOW]]);
    expect(restartOf(ev)!.a).toBe(RestartKind.FREE_KICK);
  });

  it('a pending card is shown when the period clock runs out (before the half can end)', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    runFouls(s, T_RULES.advantageTicks + 2);
    const m = s.match;
    m.periodT = m.periodLen + m.addedT - 5;
    const ev: SimEvent[] = [];
    for (let k = 0; k < 6; k++) { ev.push(...tickFouls(s)); m.periodT++; }
    const cards = ofType(ev, EventType.CARD);
    expect(cards.map((e) => e.a)).toEqual([TAC]);
    expect(cards[0]!.tick).toBe(s.tick - 1); // the tick that starts with periodT + 1 = end (RUL-01 may end the half in it)
  });

  it('a pending card is shown at a stoppage made by someone else (offside, watchdog...): first restart-phase tick', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    runFouls(s, T_RULES.advantageTicks + 2);
    s.match.phase = MatchPhase.FREE_KICK;
    s.match.restart.kind = RestartKind.FREE_KICK;
    s.match.restart.taken = 0;
    const ev = tickFouls(s);
    expect(ofType(ev, EventType.CARD).map((e) => e.a)).toEqual([TAC]);
    expect(tickFouls(s)).toEqual([]);
  });

  it('safety net: an advantage still active when play is dead is ended as played on, card shown', () => {
    const s = foulScene();
    startAdvantage(s, reckless);
    s.match.phase = MatchPhase.CORNER;
    s.match.restart.kind = RestartKind.CORNER;
    s.match.restart.taken = 0;
    const ev = tickFouls(s);
    expect(advOf(ev)).toEqual([0]);
    expect(ofType(ev, EventType.CARD).map((e) => e.a)).toEqual([TAC]);
    expect(s.match.advantage.active).toBe(0);
  });

  it('glitch: advantage that never resolves — random play after random fouls always resolves within advantageTicks', () => {
    H.draw = null;
    const g = { a: 0, b: 0, c: 0, d: 0 };
    let started = 0;
    for (let trial = 0; trial < 300; trial++) {
      rngSeed(g, 1000 + trial);
      const s = foulScene({ seed: 77 + trial, humans: [{ side: 0 }] });
      H.draw = 0;
      const u = -15 + rngFloat(g) * 60;
      duel(s, u, -20 + rngFloat(g) * 40);
      const who = rngFloat(g);
      if (who < 0.5) give(s, VIC);
      else if (who < 0.8) { putU(s, MATE, u + 3, 2); give(s, MATE); }
      else loose(s, s.players[VIC]!.x + 1, s.players[VIC]!.z, VIC);
      if (rngFloat(g) < 0.5) reckless(s); else plain(s);
      const ev0 = tickFouls(s);
      H.draw = null;
      if (advOf(ev0).length === 0) continue;
      started++;
      let resolvedAt = -1;
      for (let k = 1; k <= T_RULES.advantageTicks + 40 && resolvedAt < 0; k++) {
        const ev = tickFouls(s, (st) => {
          const r = rngFloat(g);
          const c = st.ctrl[0]!;
          c.prevButtons = c.buttons; c.buttons = 0;
          if (r < 0.01) give(st, 12 + Math.floor(rngFloat(g) * 10)); // offending team wins it
          else if (r < 0.03) give(st, 1 + Math.floor(rngFloat(g) * 10)); // fouled team
          else if (r < 0.04) loose(st, st.ball.x, st.ball.z, 12 + Math.floor(rngFloat(g) * 10));
          else if (r < 0.05) loose(st, st.ball.x, st.ball.z, 1 + Math.floor(rngFloat(g) * 10));
          else if (r < 0.055) st.ball.cross = rngFloat(g) < 0.5 ? CrossKind.TOUCHLINE : CrossKind.GOAL_LINE;
          else if (r < 0.058) c.buttons = Btn.SHIELD | Btn.SPRINT;
        });
        if (advOf(ev).length > 0) resolvedAt = k;
        if (s.match.phase !== MatchPhase.IN_PLAY && s.match.advantage.active === 1) throw new Error('active advantage in a dead phase');
      }
      expect(resolvedAt, `trial ${trial}`).toBeGreaterThan(0);
      expect(resolvedAt).toBeLessThanOrEqual(T_RULES.advantageTicks);
      expect(s.match.advantage.active).toBe(0);
      // The pending card (if any) is gone by the next stoppage.
      tickFouls(s, (st) => { st.ball.cross = CrossKind.TOUCHLINE; });
      expect(s.match.advantage.card).toBe(CardKind.NONE);
    }
    expect(started).toBeGreaterThan(100);
  });
});

// ================================================================ determinism and rates

/** Scripted sequence of challenges (real RNG) -> events and the final hash. */
function scripted(seed: number): { events: SimEvent[]; hash: number } {
  H.draw = null;
  const s = foulScene({ seed });
  const g = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(g, 4242);
  const events: SimEvent[] = [];
  for (let k = 0; k < 400; k++) {
    events.push(...tickFouls(s, (st) => {
      if (st.match.phase !== MatchPhase.IN_PLAY) { st.match.phase = MatchPhase.IN_PLAY; st.match.restart.kind = RestartKind.NONE; }
      if (k % 7 !== 0) return;
      const vic = 1 + Math.floor(rngFloat(g) * 10);
      const tac = 12 + Math.floor(rngFloat(g) * 10);
      putU(st, vic, -40 + rngFloat(g) * 90, -25 + rngFloat(g) * 50);
      st.players[tac]!.x = st.players[vic]!.x + 0.6; st.players[tac]!.z = st.players[vic]!.z;
      if (rngFloat(g) < 0.5) give(st, vic); else give(st, tac);
      st.match.challenges[0]!.active = 0;
      challenge(st, {
        tackler: tac, victim: vic, kind: Math.floor(rngFloat(g) * 6) as ChallengeKind, ballFirst: rngFloat(g) < 0.4 ? 1 : 0,
        fromBehind: -1 + 2 * rngFloat(g), closingSpeed: 9 * rngFloat(g),
      });
      st.match.challenges[0]!.tick = st.tick;
    }));
  }
  return { events, hash: hashState(s) };
}

describe('RUL-09 determinism and foul rates', () => {
  it('same seed and inputs -> identical events and state hash; another seed differs', () => {
    const a = scripted(11);
    const b = scripted(11);
    expect(b.hash).toBe(a.hash);
    expect(b.events).toEqual(a.events);
    expect(ofType(a.events, EventType.FOUL).length).toBeGreaterThan(5);
    const c = scripted(12);
    expect(c.hash === a.hash && JSON.stringify(c.events) === JSON.stringify(a.events)).toBe(false);
  });

  it('fouls per match 6-16 over seeds for a representative challenge mix (sanity of the calibration)', () => {
    // Assumed SIM-14 output for a 2 x 4-minute match: ~34 contact records, mixed as below (document in the report).
    H.draw = null;
    const g = { a: 0, b: 0, c: 0, d: 0 };
    const perMatch: number[] = [];
    let yellows = 0, reds = 0;
    const matches = 200;
    for (let seed = 1; seed <= matches; seed++) {
      const s = foulScene({ seed });
      rngSeed(g, seed * 7919);
      duel(s, 0, 0); // victim without the ball in midfield: no DOGSO
      let fouls = 0;
      for (let i = 0; i < 34; i++) {
        const r = rngFloat(g);
        const kind = r < 0.55 ? K.STAND : r < 0.68 ? K.SLIDE : r < 0.78 ? K.HARD : r < 0.9 ? K.SHOULDER : r < 0.97 ? K.PUSH_PULL : K.KEEPER;
        const rec = challenge(s, {
          tackler: TAC, victim: VIC, kind, i: 0, ballFirst: rngFloat(g) < 0.45 ? 1 : 0,
          fromBehind: -1 + 2 * rngFloat(g), closingSpeed: 1 + 6.5 * rngFloat(g),
        });
        const out = classifyChallenge(s, rec);
        if (out !== O.CLEAN) fouls++;
        if (out === O.FOUL_YELLOW) yellows++;
        if (out === O.FOUL_RED) reds++;
      }
      perMatch.push(fouls);
    }
    const mean = perMatch.reduce((x, y) => x + y, 0) / matches;
    const inBand = perMatch.filter((f) => f >= 6 && f <= 16).length / matches;
    console.log(`RUL-09 rate sanity: mean fouls/match ${mean.toFixed(2)}, in 6-16: ${(inBand * 100).toFixed(0)}%, ` +
      `yellows/match ${(yellows / matches).toFixed(2)}, reds/match ${(reds / matches).toFixed(3)}`);
    expect(mean).toBeGreaterThanOrEqual(8);
    expect(mean).toBeLessThanOrEqual(14);
    expect(inBand).toBeGreaterThan(0.85);
    expect(yellows / matches).toBeGreaterThan(0.5);
    expect(yellows / matches).toBeLessThan(4);
    expect(reds / matches).toBeLessThan(0.4);
  });

  it('foul chance per challenge stays in sane bands (real RNG frequencies match foulChance)', () => {
    H.draw = null;
    const s = foulScene({ seed: 99 });
    duel(s, 0, 0);
    const rows: [ChallengeKind, number, number, number][] = [
      [K.STAND, 0, 3, 0.4], [K.SLIDE, 1, 6, LOCAL_TUNING.maxFoulChance], [K.SHOULDER, 0, 3, 0.08],
    ];
    for (const [kind, fb, cs, approx] of rows) {
      let n = 0;
      const N = 3000;
      for (let i = 0; i < N; i++) {
        const rec = challenge(s, { tackler: TAC, victim: VIC, kind, fromBehind: fb, closingSpeed: cs, i: 0 });
        if (classifyChallenge(s, rec) !== O.CLEAN) n++;
      }
      expect(Math.abs(n / N - approx)).toBeLessThan(0.04);
    }
  });
});

// ================================================================ direct foulsTick robustness

describe('RUL-09 foulsTick robustness', () => {
  it('stale / future / garbage records are consumed without effect', () => {
    const s = foulScene();
    duel(s, 0);
    const r = plain(s);
    r.tick = s.tick + 50; // from the future
    const r2 = s.match.challenges[1]!;
    Object.assign(r2, { active: 1, tackler: 40, victim: -3, kind: 99, ballFirst: NaN, fromBehind: NaN, closingSpeed: NaN, x: NaN, z: NaN, tick: s.tick });
    challenge(s, { tackler: 3, victim: 4, i: 2 }); // teammates
    const ev = tickFouls(s);
    expect(ev).toEqual([]);
    for (const c of s.match.challenges) expect(c.active).toBe(0);
  });

  it('a non-finite victim position falls back to the record position for the spot', () => {
    const s = foulScene();
    duel(s, -30, 4);
    give(s, TAC);
    const r = plain(s);
    s.players[VIC]!.x = NaN;
    const ev = tickFouls(s);
    const f = ofType(ev, EventType.FOUL)[0]!;
    expect(f.x).toBeCloseTo(r.x, 6);
    expect(Number.isFinite(restartOf(ev)!.x)).toBe(true);
    s.players[VIC]!.x = r.x;
  });

  it('foulsTick with an event sink that drops everything still updates state', () => {
    const s = foulScene();
    startAdvantage(s);
    s.tick++;
    foulsTick(s, { emit() { /* drop */ } });
    expect(s.match.advantage.active).toBe(1);
    EVB.begin(s.tick);
  });
});

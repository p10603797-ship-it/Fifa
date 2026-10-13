/**
 * RUL-09 classification table: challenge -> outcome, with the RNG draw pinned (the integer roll mocked to `draw < p`, the
 * same draw for the foul roll and the red roll), so every row is exact. Plus the shape of foulChance (kind order, direction,
 * speed, ball-first), recklessness, serious foul play, DOGSO and arcade mode. Real-RNG rates live in
 * tests/scenario/rul-09-fouls.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChallengeKind, ChallengeOutcome } from '../../src/contracts/enums';
import type { ChallengeRecord, SimState } from '../../src/contracts/state';
import { T_FOUL } from '../../src/contracts/tuning';
import {
  LOCAL_TUNING, ROLL_SCALE, classifyChallenge, foulChance, isDogso, isReckless, isValidChallenge, seriousFoulRedChance,
} from '../../src/sim/rules/fouls';
import { challenge, foulScene, give, loose, putU } from '../scenario/rul-09-setup';

const H = vi.hoisted(() => ({ draw: 0 as number | null, calls: 0 }));
/** RUL-09 rolls are rngInt(s.rng, ROLL_SCALE = 2^24) < p * ROLL_SCALE: pin them to `draw < p` (draw in [0, 1)). */
vi.mock('../../src/sim/core/rng', async (orig) => {
  const m = await orig<typeof import('../../src/sim/core/rng')>();
  return {
    ...m,
    rngInt: (r: Parameters<typeof m.rngInt>[0], n: number) => {
      if (n !== 1 << 24) return m.rngInt(r, n);
      H.calls++;
      return H.draw === null ? m.rngInt(r, n) : Math.floor(H.draw * n);
    },
  };
});

const K = ChallengeKind;
const O = ChallengeOutcome;
/** Home (team 0, attacks +x) victim 9, away tackler 15 (no ball near: no DOGSO). */
const VIC = 9;
const TAC = 15;

function rec(s: SimState, kind: ChallengeKind, ballFirst: number, fromBehind: number, closingSpeed: number): ChallengeRecord {
  return challenge(s, { tackler: TAC, victim: VIC, kind, ballFirst, fromBehind, closingSpeed, i: 0 });
}

function midScene(fouls = 1): SimState {
  const s = foulScene({ fouls });
  putU(s, VIC, 0, 0);
  putU(s, TAC, 1, 0); // team 1 frame: u = 1 -> x = -1
  return s;
}

describe('RUL-09 classifyChallenge table (pinned draw)', () => {
  // kind, ballFirst, fromBehind, closingSpeed m/s, draw, expected
  const rows: [string, ChallengeKind, number, number, number, number, ChallengeOutcome][] = [
    ['stand, ball first, side', K.STAND, 1, 0, 3, 0, O.CLEAN],
    ['slide, ball first, from the front', K.SLIDE, 1, -1, 3, 0, O.CLEAN],
    ['slide, ball first, from behind (reckless), roll passes', K.SLIDE, 1, 1, 3, 0, O.FOUL_YELLOW],
    ['slide, ball first, from behind (reckless), roll fails', K.SLIDE, 1, 1, 3, 0.999, O.CLEAN],
    ['slide, ball first, from behind at 9 m/s: not serious foul play (ball first)', K.SLIDE, 1, 1, 9, 0, O.FOUL_YELLOW],
    ['stand, man first, side, roll passes', K.STAND, 0, 0, 3, 0, O.FOUL],
    ['stand, man first, side, roll fails', K.STAND, 0, 0, 3, 0.999, O.CLEAN],
    ['stand from behind below recklessSpeed', K.STAND, 0, 1, 5, 0, O.FOUL],
    ['stand from behind above recklessSpeed', K.STAND, 0, 1, 6, 0, O.FOUL_YELLOW],
    ['stand from the front at 7.5 m/s (not all-out)', K.STAND, 0, -1, 7.5, 0, O.FOUL],
    ['stand from the front at 8 m/s (all-out lunge)', K.STAND, 0, -1, 8, 0, O.FOUL_YELLOW],
    ['stand from behind at 9 m/s: reckless, never serious', K.STAND, 0, 1, 9, 0, O.FOUL_YELLOW],
    ['slide from the side, slow', K.SLIDE, 0, 0, 2, 0, O.FOUL],
    ['slide from behind, slow (reckless)', K.SLIDE, 0, 1, 2, 0, O.FOUL_YELLOW],
    ['slide from behind at 7.5 m/s, red roll passes', K.SLIDE, 0, 1, 7.5, 0.3, O.FOUL_RED],
    ['slide from behind at 7.5 m/s, red roll fails', K.SLIDE, 0, 1, 7.5, 0.5, O.FOUL_YELLOW],
    ['hard from behind at 7.5 m/s, red roll passes (half chance)', K.HARD, 0, 1, 7.5, 0.1, O.FOUL_RED],
    ['hard from behind at 7.5 m/s, red roll fails', K.HARD, 0, 1, 7.5, 0.2, O.FOUL_YELLOW],
    ['shoulder from the side: rare foul, roll fails at 0.1', K.SHOULDER, 0, 0, 3, 0.1, O.CLEAN],
    ['shoulder from the side: roll passes at 0.05', K.SHOULDER, 0, 0, 3, 0.05, O.FOUL],
    ['push/pull from behind (chasing), slow', K.PUSH_PULL, 0, 1, 4, 0, O.FOUL],
    ['keeper takes the man', K.KEEPER, 0, 0, 3, 0, O.FOUL],
  ];
  for (const [name, kind, bf, fb, cs, draw, want] of rows) {
    it(`${name} -> ${O[want]}`, () => {
      const s = midScene();
      H.draw = draw;
      expect(classifyChallenge(s, rec(s, kind, bf, fb, cs))).toBe(want);
      H.draw = 0;
    });
  }

  it('the roll scale is the one the RNG mock intercepts', () => {
    expect(ROLL_SCALE).toBe(1 << 24);
  });

  it('a clean ball-first challenge and arcade mode draw nothing from the RNG', () => {
    const s = midScene();
    H.calls = 0;
    expect(classifyChallenge(s, rec(s, K.STAND, 1, 0, 3))).toBe(O.CLEAN);
    const s2 = midScene(0);
    expect(classifyChallenge(s2, rec(s2, K.SLIDE, 0, 1, 9))).toBe(O.CLEAN);
    expect(H.calls).toBe(0);
  });

  it('arcade mode (config.fouls = 0): every row is CLEAN, even serious foul play', () => {
    const s = midScene(0);
    for (const [, kind, bf, fb, cs] of rows) expect(classifyChallenge(s, rec(s, kind, bf, fb, cs))).toBe(O.CLEAN);
  });

  it('invalid records are CLEAN: same team, inactive, bad slots, tackler = victim', () => {
    const s = midScene();
    const r = rec(s, K.SLIDE, 0, 1, 9);
    r.tackler = 5; // teammate of the victim
    expect(isValidChallenge(s, r)).toBe(false);
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
    r.tackler = TAC; r.victim = TAC;
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
    r.victim = VIC; r.tackler = -1;
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
    r.tackler = 22;
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
    r.tackler = TAC;
    s.players[TAC]!.active = 0;
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
    s.players[TAC]!.active = 1;
    s.players[VIC]!.active = 0;
    expect(classifyChallenge(s, r)).toBe(O.CLEAN);
  });

  it('non-finite record fields are treated as side-on, standing still', () => {
    const s = midScene();
    const r = rec(s, K.STAND, 0, NaN, NaN);
    expect(foulChance(r)).toBeCloseTo(T_FOUL.baseFoulChance * 0.6 * LOCAL_TUNING.speedFoulMulLow, 10);
    expect(classifyChallenge(s, r)).toBe(O.FOUL);
    r.closingSpeed = Infinity;
    expect(Number.isFinite(foulChance(r))).toBe(true);
  });
});

describe('RUL-09 foul chance shape', () => {
  const s = foulScene();
  const at = (kind: ChallengeKind, fb = 0, cs = 3, bf = 0): number =>
    foulChance({ active: 1, tackler: TAC, victim: VIC, kind, ballFirst: bf, fromBehind: fb, closingSpeed: cs, x: 0, z: 0, tick: 0 });

  it('kind order: slide > hard > stand > push/pull > shoulder (rarely)', () => {
    expect(at(K.SLIDE)).toBeGreaterThan(at(K.HARD));
    expect(at(K.HARD)).toBeGreaterThan(at(K.STAND));
    expect(at(K.STAND)).toBeGreaterThan(at(K.PUSH_PULL));
    expect(at(K.PUSH_PULL)).toBeGreaterThan(at(K.SHOULDER));
    expect(at(K.SHOULDER)).toBeLessThan(0.12);
  });

  it('direction: behind > side > front; speed: faster > slower; ball first halves it', () => {
    expect(at(K.STAND, 1)).toBeGreaterThan(at(K.STAND, 0));
    expect(at(K.STAND, 0)).toBeGreaterThan(at(K.STAND, -1));
    expect(at(K.STAND, 0, 5)).toBeGreaterThan(at(K.STAND, 0, 1));
    expect(at(K.STAND, 0, 9)).toBeCloseTo(at(K.STAND, 0, T_FOUL.recklessSpeed), 10); // saturates at recklessSpeed
    expect(at(K.STAND, 0, 3, 1)).toBeCloseTo(at(K.STAND, 0, 3) * LOCAL_TUNING.ballFirstFoulMul, 10);
    expect(at(K.SLIDE, 1, 9)).toBe(LOCAL_TUNING.maxFoulChance);
    expect(at(K.STAND, 0, 3)).toBeGreaterThan(0.2);
    expect(at(K.STAND, 0, 3)).toBeLessThan(0.6);
    void s;
  });

  it('reckless and serious foul play thresholds', () => {
    const r = (kind: ChallengeKind, fb: number, cs: number, bf = 0): ChallengeRecord =>
      ({ active: 1, tackler: TAC, victim: VIC, kind, ballFirst: bf, fromBehind: fb, closingSpeed: cs, x: 0, z: 0, tick: 0 });
    expect(isReckless(r(K.STAND, 1, T_FOUL.recklessSpeed + 0.01))).toBe(true);
    expect(isReckless(r(K.STAND, 1, T_FOUL.recklessSpeed - 0.01))).toBe(false);
    expect(isReckless(r(K.STAND, 0.4, 6))).toBe(false); // not from behind
    expect(isReckless(r(K.SLIDE, 0.5, 0))).toBe(true);
    expect(isReckless(r(K.SLIDE, 0.49, 0))).toBe(false);
    expect(isReckless(r(K.PUSH_PULL, -1, T_FOUL.recklessSpeed * LOCAL_TUNING.allOutSpeedMul + 0.01))).toBe(true);
    const serious = T_FOUL.recklessSpeed * LOCAL_TUNING.seriousSpeedMul;
    expect(seriousFoulRedChance(r(K.SLIDE, 1, serious))).toBe(T_FOUL.slideFromBehindRed);
    expect(seriousFoulRedChance(r(K.HARD, 1, serious))).toBe(T_FOUL.slideFromBehindRed * LOCAL_TUNING.hardRedMul);
    expect(seriousFoulRedChance(r(K.SLIDE, 1, serious - 0.01))).toBe(0);
    expect(seriousFoulRedChance(r(K.SLIDE, 0, serious + 3))).toBe(0);
    expect(seriousFoulRedChance(r(K.SLIDE, 1, serious + 3, 1))).toBe(0);
    expect(seriousFoulRedChance(r(K.STAND, 1, serious + 3))).toBe(0);
  });
});

describe('RUL-09 DOGSO (denying an obvious goal-scoring chance)', () => {
  /** Victim 9 (home, attacks +x) with the ball at u, tackler 15 beside him; away outfielders parked deep or moved. */
  function through(u: number, z = 0, clearDefenders = true): SimState {
    const s = foulScene();
    putU(s, VIC, u, z);
    give(s, VIC);
    s.players[TAC]!.x = s.players[VIC]!.x - 0.8; s.players[TAC]!.z = z + 0.6;
    if (clearDefenders) for (let i = 12; i < 22; i++) if (i !== TAC) s.players[i]!.x = -30; // all upfield of the victim
    return s;
  }

  it('last defender fouls a carrier through on goal outside the area -> red', () => {
    const s = through(25);
    const r = rec(s, K.STAND, 0, 0, 3);
    expect(isDogso(s, r)).toBe(true);
    H.draw = 0;
    expect(classifyChallenge(s, r)).toBe(O.FOUL_RED);
  });

  it('the keeper does not count as cover', () => {
    const s = through(25);
    s.players[11]!.x = 51; // keeper on his line
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(true);
  });

  it('a covering outfield defender between victim and goal -> no DOGSO (plain foul)', () => {
    const s = through(25);
    s.players[13]!.x = 40; s.players[13]!.z = 2;
    const r = rec(s, K.STAND, 0, 0, 3);
    expect(isDogso(s, r)).toBe(false);
    expect(classifyChallenge(s, r)).toBe(O.FOUL);
  });

  it('a defender goal-side but far wide of the line to goal does not cover', () => {
    const s = through(25);
    s.players[13]!.x = 40; s.players[13]!.z = -15;
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(true);
  });

  it('too far from goal, or ball not with the victim -> no DOGSO', () => {
    const far = through(15);
    expect(isDogso(far, rec(far, K.STAND, 0, 0, 3))).toBe(false);
    const s = through(25);
    loose(s, s.players[VIC]!.x + 5, 0, VIC);
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(false);
    loose(s, s.players[VIC]!.x + 1, 0, VIC); // loose next to him after his touch
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(true);
    s.players[VIC]!.lastTouchTick = s.tick - LOCAL_TUNING.dogsoRecentTouchTicks - 1;
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(false);
  });

  it('in the penalty area: an attempt to play the ball is a yellow, a push/pull stays red', () => {
    const s = through(45, 2);
    H.draw = 0;
    expect(classifyChallenge(s, rec(s, K.STAND, 0, 0, 3))).toBe(O.FOUL_YELLOW);
    expect(classifyChallenge(s, rec(s, K.SLIDE, 0, 0, 3))).toBe(O.FOUL_YELLOW);
    expect(classifyChallenge(s, rec(s, K.PUSH_PULL, 0, 0, 3))).toBe(O.FOUL_RED);
  });

  it('serious foul play is decided before DOGSO (red roll fails -> yellow)', () => {
    const s = through(25);
    H.draw = 0.5;
    expect(classifyChallenge(s, rec(s, K.SLIDE, 0, 1, 8))).toBe(O.FOUL_YELLOW);
    H.draw = 0;
  });

  it('works in the second half (directions swapped)', () => {
    const s = foulScene({ swap: true });
    putU(s, VIC, 25, 0);
    give(s, VIC);
    s.players[TAC]!.x = s.players[VIC]!.x + 0.8;
    for (let i = 12; i < 22; i++) if (i !== TAC) s.players[i]!.x = 30;
    expect(s.players[VIC]!.x).toBe(-25);
    expect(isDogso(s, rec(s, K.STAND, 0, 0, 3))).toBe(true);
  });
});

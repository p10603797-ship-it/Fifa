/**
 * SIM-14 challenge records as RUL-09 receives them. RUL-09's foulsTick is replaced by a recorder (copies every active
 * record, then consumes it like RUL-09 does) so the exact fields can be checked: from-behind slides record fromBehind
 * ~1 and ballFirst 0, a won front tackle that also hits the man records ballFirst 1, shoulder / push kinds, closing speed
 * and the queue (pushChallenge drops when full).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeRecord, SimState } from '../../src/contracts/state';

const SEEN: ChallengeRecord[] = [];
vi.mock('../../src/sim/rules/fouls', async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    foulsTick: (s: SimState): void => {
      for (const c of s.match.challenges) {
        if (c.active !== 1) continue;
        SEEN.push({ ...c });
        c.active = 0;
      }
    },
  };
});

import { ActionKind, ChallengeKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MAX_CHALLENGES, createChallengeRecord } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { pushChallenge, startTackle } from '../../src/sim/defend/tackle';
import { P1, P2, owned, place, scene, stepN, trial } from './sim-14-helpers';

const EV = createEventBuffer();

beforeEach(() => { SEEN.length = 0; });

describe('SIM-14 challenge records for RUL-09', () => {
  it('a slide from behind that reaches the man first records SLIDE, ballFirst 0, fromBehind ~1, closing speed', () => {
    let n = 0;
    for (let seed = 1; seed <= 8; seed++) {
      SEEN.length = 0;
      const s = scene(seed);
      place(s, P1, 0, 0, 1, 0, 3);
      owned(s, P1, 0.7, 0);
      place(s, P2, -2.4, 0.05, 1, 0, 7.5);
      startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV);
      const ev = stepN(s, 30);
      expect(SEEN.length).toBeLessThanOrEqual(1);
      if (SEEN.length === 0) continue;
      n++;
      const r = SEEN[0]!;
      expect(r.tackler).toBe(P2);
      expect(r.victim).toBe(P1);
      expect(r.kind).toBe(ChallengeKind.SLIDE);
      expect(r.ballFirst).toBe(0);
      expect(r.fromBehind).toBeGreaterThan(0.9);
      expect(r.closingSpeed).toBeGreaterThan(0);
      expect(r.tick).toBeGreaterThan(0);
      const t = ev.filter((e) => e.type === EventType.TACKLE);
      expect(t).toHaveLength(1);
      expect(t[0]!.c).toBe(0);
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it('a won front tackle that also hits the man records ballFirst 1 and fromBehind ~-1', () => {
    const base = scene(3);
    place(base, P1, 0, 0, 1, 0);
    owned(base, P1, 0.45, 0);
    place(base, P2, 1.05, 0, -1, 0);
    base.attrs[P2]!.standingTackle = 99;
    let found = 0;
    for (let k = 0; k < 60 && found < 3; k++) {
      SEEN.length = 0;
      const s = trial(base, k);
      startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
      const ev = stepN(s, 8);
      const t = ev.filter((e) => e.type === EventType.TACKLE);
      if (t[0]?.c !== 1) continue;
      found++;
      expect(SEEN).toHaveLength(1);
      expect(SEEN[0]!.ballFirst).toBe(1);
      expect(SEEN[0]!.kind).toBe(ChallengeKind.STAND);
      expect(SEEN[0]!.fromBehind).toBeLessThan(-0.9);
    }
    expect(found).toBeGreaterThan(0);
  });

  it('a clean poke with no body contact records nothing', () => {
    const base = scene(4);
    place(base, P1, 0, 0, 1, 0);
    owned(base, P1, 1.0, 0);
    place(base, P2, 2.5, 0, -1, 0);
    base.attrs[P2]!.standingTackle = 99;
    let won = 0;
    for (let k = 0; k < 60; k++) {
      SEEN.length = 0;
      const s = trial(base, k);
      startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
      const t = stepN(s, 8).filter((e) => e.type === EventType.TACKLE);
      if (t[0]?.c !== 1) continue;
      won++;
      expect(SEEN).toHaveLength(0);
    }
    expect(won).toBeGreaterThan(0);
  });

  it('shoulder and push / pull record their kinds (side-on and from behind)', () => {
    const s = scene(5);
    place(s, P1, 0, 0, 1, 0, 6);
    owned(s, P1, 0.9, 0);
    place(s, P2, 0, 0.8, 1, 0, 6);
    startTackle(s, P2, ActionKind.SHOULDER, -1, EV);
    stepN(s, 14);
    expect(SEEN).toHaveLength(1);
    expect(SEEN[0]!.kind).toBe(ChallengeKind.SHOULDER);
    expect(Math.abs(SEEN[0]!.fromBehind)).toBeLessThan(0.3);

    SEEN.length = 0;
    const p = scene(6);
    p.attrs[P2]!.strength = 1;
    place(p, P1, 0, 0, 1, 0, 6);
    owned(p, P1, 1.0, 0);
    place(p, P2, -0.9, 0.1, 1, 0, 6.5);
    startTackle(p, P2, ActionKind.PUSH_PULL, -1, EV);
    stepN(p, 18);
    expect(SEEN).toHaveLength(1);
    expect(SEEN[0]!.kind).toBe(ChallengeKind.PUSH_PULL);
    expect(SEEN[0]!.fromBehind).toBeGreaterThan(0.8);
    expect(SEEN[0]!.ballFirst).toBe(0);
  });

  it('pushChallenge fills free entries, sanitises, and drops when the queue is full', () => {
    const s = scene(7);
    const r = createChallengeRecord();
    r.tackler = P2; r.victim = P1; r.kind = ChallengeKind.HARD; r.fromBehind = 5; r.closingSpeed = -3; r.x = Number.NaN;
    for (let i = 0; i < MAX_CHALLENGES + 2; i++) { r.tick = i; pushChallenge(s, r); }
    const q = s.match.challenges;
    expect(q.every((c) => c.active === 1)).toBe(true);
    expect(q.map((c) => c.tick)).toEqual([0, 1, 2, 3]);
    expect(q[0]!.fromBehind).toBe(1);
    expect(q[0]!.closingSpeed).toBe(0);
    expect(q[0]!.x).toBe(0);
    q[2]!.active = 0;
    r.tick = 99;
    pushChallenge(s, r);
    expect(q[2]!.tick).toBe(99);
    r.victim = -1;
    q[1]!.active = 0;
    pushChallenge(s, r); // invalid victim: dropped
    expect(q[1]!.active).toBe(0);
  });
});

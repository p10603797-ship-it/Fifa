/**
 * MOD-02: Cup draw, bracket, quick results, save. Draw determinism, bracket progression, quick results favour stronger
 * clubs (statistically over seeds), no draws in cup results, save/load round trip, two humans (co-op / opposing
 * paths), the human tie setup and its onFinish, champion detection and records.
 */
import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../../src/contracts/app';
import { ControllerKind, ModeId } from '../../src/contracts/enums';
import { ANY_DEVICE } from '../../src/app/localInput';
import {
  advanceCup, createCup, createCupState, cupBindings, CUP_PROGRESS_KEY, CUP_SCHEMA, drawCup, isPlayed, loadCup, pendingHumanTie,
  quickResult, quickShootout, roundName, validateCupState, clearCup, type CupState, type CupTie,
} from '../../src/modes/cup';
import { loadRecords } from '../../src/modes/records';
import { CLUBS } from '../../src/data/clubs';
import { DEVICES, fakeCtx, pad } from './mod-01-fakes';

function summary(g0: number, g1: number, shootout: [number, number] | null = null, winner?: number): MatchSummary {
  const w = winner ?? (g0 > g1 ? 0 : g1 > g0 ? 1 : shootout ? (shootout[0] > shootout[1] ? 0 : 1) : -1);
  return {
    teams: [{ goals: g0 } as MatchSummary['teams'][0], { goals: g1 } as MatchSummary['teams'][1]],
    players: [], goals: [], playerOfMatch: null, shootout, winner: w, forfeit: -1, ticks: 1000,
  };
}

function humanTie(state: CupState): CupTie {
  const p = pendingHumanTie(state)!;
  return state.rounds[p.round]![p.tie]!;
}

describe('MOD-02 draw', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = createCupState(CLUBS, { size: 16, humanClubs: [3], seed: 42 });
    const b = createCupState(CLUBS, { size: 16, humanClubs: [3], seed: 42 });
    expect(a).toEqual(b);
    const orders = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) orders.add(createCupState(CLUBS, { size: 8, humanClubs: [3], seed }).clubs!.join(','));
    expect(orders.size).toBeGreaterThan(15);
  });

  it('draws `size` distinct clubs including the humans; 8 and 16 team brackets', () => {
    for (const size of [8, 16] as const) {
      for (let seed = 0; seed < 30; seed++) {
        const s = createCupState(CLUBS, { size, humanClubs: [seed % CLUBS.length], seed });
        expect(new Set(s.clubs).size).toBe(size);
        expect(s.clubs).toContain(seed % CLUBS.length);
        expect(s.rounds.map((r) => r.length)).toEqual(size === 16 ? [8, 4, 2, 1] : [4, 2, 1]);
        expect(s.rounds[0]!.flatMap((t) => [t.home, t.away])).toEqual(s.clubs);
        expect(s.rounds.slice(1).flat().every((t) => t.home === -1 && t.away === -1)).toBe(true);
      }
    }
    expect(roundName(16, 0)).toBe('Round of 16');
    expect(roundName(16, 1)).toBe('Quarter-finals');
    expect(roundName(8, 1)).toBe('Semi-finals');
    expect(roundName(8, 2)).toBe('Final');
  });

  it('two opposing humans are drawn into opposite halves (can only meet in the final)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const order = drawCup({ rng: seed }, CLUBS.length, 8, [1, 2], false);
      const a = order.indexOf(1);
      const b = order.indexOf(2);
      expect(a >= 0 && b >= 0).toBe(true);
      expect(a < 4).not.toBe(b < 4);
    }
  });
});

describe('MOD-02 quick results', () => {
  it('never end level: extra time, then a shoot-out', () => {
    let et = 0;
    let pens = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const h = { rng: seed };
      const r = quickResult(h, 70 + (seed % 15), 70 + ((seed * 7) % 15));
      if (r.homeGoals === r.awayGoals) {
        expect(r.extraTime).toBe(true);
        expect(r.shootout).not.toBeNull();
        expect(r.shootout![0]).not.toBe(r.shootout![1]);
        expect(r.winner).toBe(r.shootout![0] > r.shootout![1] ? 0 : 1);
        pens++;
      } else {
        expect(r.shootout).toBeNull();
        expect(r.winner).toBe(r.homeGoals > r.awayGoals ? 0 : 1);
      }
      if (r.extraTime) et++;
      expect(r.homeGoals).toBeLessThanOrEqual(20);
    }
    expect(et).toBeGreaterThan(100);
    expect(pens).toBeGreaterThan(30);
  });

  it('favour the stronger club statistically', () => {
    let strong = 0;
    let equalHome = 0;
    const n = 3000;
    for (let seed = 1; seed <= n; seed++) {
      if (quickResult({ rng: seed * 7919 }, 86, 66).winner === 0) strong++;
      if (quickResult({ rng: seed * 104729 }, 75, 75).winner === 0) equalHome++;
    }
    expect(strong / n).toBeGreaterThan(0.8);
    expect(equalHome / n).toBeGreaterThan(0.44);
    expect(equalHome / n).toBeLessThan(0.56);
  });

  it('shoot-outs follow the five-then-sudden-death format', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const [a, b] = quickShootout({ rng: seed }, 75, 75);
      expect(a).not.toBe(b);
      expect(Math.abs(a - b) <= 3).toBe(true);
      if (Math.max(a, b) > 5) expect(Math.abs(a - b)).toBe(1);
    }
  });
});

describe('MOD-02 bracket progression', () => {
  it('a human tie result advances the round; other ties are quick results; winners fill the next round', () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 8, humanClubs: [5], seed: 9 });
    const s = run.state;
    expect(s.round).toBe(0);
    expect(s.rounds[0]!.filter(isPlayed)).toHaveLength(0); // other results only after the human's match
    const t = humanTie(s);
    const humanHome = t.home === 5;
    expect(run.recordResult(humanHome ? summary(2, 1) : summary(1, 2))).toBe(true);
    expect(s.rounds[0]!.every(isPlayed)).toBe(true);
    expect(t.winner).toBe(5);
    expect(s.round).toBe(1);
    for (let j = 0; j < 2; j++) {
      expect(s.rounds[1]![j]!.home).toBe(s.rounds[0]![2 * j]!.winner);
      expect(s.rounds[1]![j]!.away).toBe(s.rounds[0]![2 * j + 1]!.winner);
    }
    expect(s.rounds[1]!.filter(isPlayed)).toHaveLength(0);
    // Win the semi and the final.
    for (let r = 1; r < 3; r++) {
      const ht = humanTie(s);
      run.recordResult(ht.home === 5 ? summary(1, 1, [5, 4]) : summary(1, 1, [4, 5]));
      expect(ht.winner).toBe(5);
      expect(ht.shootout).not.toBeNull();
      expect(ht.extraTime).toBe(true);
    }
    expect(s.finished).toBe(true);
    expect(s.champion).toBe(5);
    expect(run.nextMatch()).toBeNull();
    expect(loadRecords(ctx.settings).cupsWon).toBe(1);
    run.simulateRest();
    expect(loadRecords(ctx.settings).cupsWon).toBe(1);
  });

  it('when the human is knocked out the cup plays out to a champion; no tie is ever level', () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 16, humanClubs: [0], seed: 1234 });
    const t = humanTie(run.state);
    run.recordResult(t.home === 0 ? summary(0, 3) : summary(3, 0));
    expect(run.humanAlive()).toBe(false);
    expect(run.state.finished).toBe(true);
    expect(run.state.champion).toBeGreaterThanOrEqual(0);
    expect(run.state.champion).not.toBe(0);
    for (const tie of run.state.rounds.flat()) {
      expect(isPlayed(tie)).toBe(true);
      expect(tie.winner === tie.home || tie.winner === tie.away).toBe(true);
      if (tie.homeGoals === tie.awayGoals) expect(tie.shootout![0]).not.toBe(tie.shootout![1]);
    }
    expect(loadRecords(ctx.settings).cupsWon).toBe(0);
  });

  it('a level human result without a decided winner is settled (forfeit, else a quick shoot-out)', () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 8, humanClubs: [4], seed: 3 });
    const t = humanTie(run.state);
    run.recordResult({ ...summary(0, 0), winner: -1, forfeit: t.home === 4 ? 1 : 0 });
    expect(t.winner).toBe(4);
    const run2 = createCup(ctx, { size: 8, humanClubs: [4], seed: 4 });
    const t2 = humanTie(run2.state);
    run2.recordResult({ ...summary(2, 2), winner: -1 });
    expect(t2.winner === t2.home || t2.winner === t2.away).toBe(true);
    expect(t2.shootout).not.toBeNull();
  });

  it('a result for another tie (stale onFinish) is refused', () => {
    const run = createCup(fakeCtx(), { size: 8, humanClubs: [4], seed: 3 });
    expect(run.recordResult(summary(1, 0), { round: 2, tie: 0 })).toBe(false);
    expect(run.pendingTie()).not.toBeNull();
  });
});

describe('MOD-02 next human tie -> MatchSetup', () => {
  it('cup rules, the tie\'s clubs, the human on his club\'s side, and onFinish records the result', () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 8, humanClubs: [7], seed: 77, halfMinutes: 3 });
    const t = humanTie(run.state);
    let finished = 0;
    const setup = run.nextMatch({ onFinished: () => { finished++; } })!;
    expect(setup.config.mode).toBe(ModeId.CUP);
    expect(setup.config.cupRules).toBe(1);
    expect(setup.config.halfMinutes).toBe(3);
    expect([setup.config.homeClub, setup.config.awayClub]).toEqual([t.home, t.away]);
    const side = t.home === 7 ? 0 : 1;
    expect(setup.config.humans[0]).toMatchObject({ kind: ControllerKind.HUMAN, side });
    expect(setup.config.humans[1]!.kind).toBe(ControllerKind.NONE);
    expect(setup.bindings[0]!.deviceIds).toContain(ANY_DEVICE);
    expect(setup.modeData).toMatchObject({ kind: 'cup', round: 0 });
    // A quit leaves the tie unplayed.
    setup.onFinish!(null, true);
    expect(finished).toBe(1);
    expect(run.pendingTie()).not.toBeNull();
    // Played to the end: recorded (also in the lifetime records) and saved.
    const again = run.nextMatch({ onFinished: () => { finished++; } })!;
    again.onFinish!(side === 0 ? summary(3, 1) : summary(1, 3), false);
    again.onFinish!(side === 0 ? summary(0, 1) : summary(1, 0), false); // duplicate call ignored
    expect(finished).toBe(2);
    const saved = loadCup(ctx)!;
    expect(saved.state.round).toBe(1);
    expect(saved.state.rounds[0]!.find((x) => x.home === 7 || x.away === 7)!.winner).toBe(7);
    expect(loadRecords(ctx.settings)).toMatchObject({ played: 1, won: 1 });
  });

  it('two humans co-op: both on the club\'s side with separate devices', () => {
    const ctx = fakeCtx({ devices: [...DEVICES, pad(0), pad(1)] });
    const run = createCup(ctx, { size: 8, humanClubs: [2], coop: true, seed: 5 });
    expect(run.state.humans).toBe(2);
    const setup = run.nextMatch()!;
    const side = humanTie(run.state).home === 2 ? 0 : 1;
    expect(setup.config.humans.map((h) => [h.kind, h.side])).toEqual([[ControllerKind.HUMAN, side], [ControllerKind.HUMAN, side]]);
    expect(setup.bindings).toEqual([
      { human: 0, deviceIds: ['touch', 'keyboard', 'pad:0'] },
      { human: 1, deviceIds: ['pad:1', ANY_DEVICE] },
    ]);
  });

  it('two humans on opposing paths: each plays his own ties; they meet only in the final', () => {
    const ctx = fakeCtx({ devices: [DEVICES[0]!, pad(0)] });
    const run = createCup(ctx, { size: 8, humanClubs: [1, 2], seed: 11 });
    const s = run.state;
    let guard = 0;
    while (!s.finished && guard++ < 10) {
      const t = humanTie(s);
      const setup = run.nextMatch()!;
      const h0 = s.humanClubs[0]!;
      const h1 = s.humanClubs[1]!;
      const sideOf = (c: number): number => (t.home === c ? 0 : t.away === c ? 1 : -1);
      expect(setup.config.humans[0]!.side).toBe(sideOf(h0));
      expect(setup.config.humans[1]!.side).toBe(sideOf(h1));
      if (s.round < 2) expect(sideOf(h0) >= 0 && sideOf(h1) >= 0).toBe(false);
      // The human club always wins (home side if both are humans).
      const humanSide = sideOf(h0) >= 0 ? sideOf(h0) : sideOf(h1);
      run.recordResult(humanSide === 0 ? summary(1, 0) : summary(0, 1));
    }
    expect(s.finished).toBe(true);
    const final = s.rounds[2]![0]!;
    expect([final.home, final.away].sort()).toEqual([1, 2]);
  });

  it('device bindings: one human gets everything; two humans split touch / pads', () => {
    expect(cupBindings(DEVICES, 1)).toEqual([{ human: 0, deviceIds: ['touch', 'keyboard', ANY_DEVICE] }]);
    expect(cupBindings([DEVICES[0]!, pad(0)], 2)).toEqual([{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['pad:0', ANY_DEVICE] }]);
    expect(cupBindings(DEVICES, 2)).toEqual([{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['keyboard', ANY_DEVICE] }]);
  });
});

describe('MOD-02 save / load', () => {
  it('round trip after every step; schema versioned', () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 16, humanClubs: [6], seed: 2024 });
    expect(loadCup(ctx)!.state).toEqual(run.state);
    const raw = ctx.settings.loadProgress<{ schema: number }>(CUP_PROGRESS_KEY)!;
    expect(raw.schema).toBe(CUP_SCHEMA);
    const t = humanTie(run.state);
    run.recordResult(t.home === 6 ? summary(2, 0) : summary(0, 2));
    const loaded = loadCup(ctx)!;
    expect(loaded.state).toEqual(run.state);
    // The loaded cup continues identically (same generator state).
    const t2 = humanTie(loaded.state);
    const res = t2.home === 6 ? summary(1, 0) : summary(0, 1);
    loaded.recordResult(res);
    run.recordResult(res);
    expect(loaded.state).toEqual(run.state);
  });

  it('missing, older-schema or malformed saves load as null; clearCup forgets', () => {
    const ctx = fakeCtx();
    expect(loadCup(ctx)).toBeNull();
    const run = createCup(ctx, { size: 8, humanClubs: [1], seed: 1 });
    const good = JSON.parse(JSON.stringify(run.state)) as CupState;
    ctx.settings.saveProgress(CUP_PROGRESS_KEY, { schema: 0, state: good });
    expect(loadCup(ctx)).toBeNull();
    const bad: unknown[] = [
      { ...good, size: 12 },
      { ...good, humanClubs: [] },
      { ...good, rounds: good.rounds.slice(1) },
      { ...good, round: 9 },
      { ...good, rounds: [[{ ...good.rounds[0]![0]!, winner: 19 }, ...good.rounds[0]!.slice(1)], ...good.rounds.slice(1)] },
      { ...good, rounds: [[{ ...good.rounds[0]![0]!, home: 99 }, ...good.rounds[0]!.slice(1)], ...good.rounds.slice(1)] },
      { ...good, finished: true, champion: -1 },
      'nonsense',
    ];
    for (const b of bad) {
      ctx.settings.saveProgress(CUP_PROGRESS_KEY, { schema: CUP_SCHEMA, state: b });
      expect(loadCup(ctx)).toBeNull();
    }
    expect(validateCupState(good, CLUBS.length)).toEqual(good);
    clearCup(ctx);
    expect(loadCup(ctx)).toBeNull();
  });

  it('advanceCup is idempotent on a cup waiting for its human', () => {
    const s = createCupState(CLUBS, { size: 8, humanClubs: [3], seed: 8 });
    const before = JSON.stringify(s);
    advanceCup(s, CLUBS);
    expect(JSON.stringify(s)).toBe(before);
  });
});

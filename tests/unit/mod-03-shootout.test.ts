/**
 * MOD-03: Shoot-out mode. Setup validity (straight to SHOOT_OUT, cup rules, human sides from side select, CPU sides),
 * kicker preview, winner banner, rematch; a CPU v CPU shoot-out runs PRE_MATCH -> SHOOT_OUT -> POST_MATCH through the
 * headless runner with a winner and the stats tracker reports the tally.
 */
import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../../src/contracts/app';
import { ControllerKind, MatchPhase, ModeId, Role } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { buildShootoutSetup, rematchShootout, shootoutHeadline, shootoutKickers } from '../../src/modes/shootout';
import { createStatsTracker } from '../../src/modes/stats';
import { loadRecords } from '../../src/modes/records';
import { runMatch } from '../../tools/headless';
import { CLUBS } from '../../src/data/clubs';
import { fakeCtx } from './mod-01-fakes';


describe('MOD-03 shoot-out setup', () => {
  it('starts straight in SHOOT_OUT with cup rules; human 0 at home by default, away CPU', () => {
    const ctx = fakeCtx();
    const s = buildShootoutSetup(ctx, { homeClub: 1, awayClub: 2 });
    expect(s.config.mode).toBe(ModeId.SHOOT_OUT);
    expect(s.config.startPhase).toBe(MatchPhase.SHOOT_OUT);
    expect(s.config.cupRules).toBe(1);
    expect([s.config.homeClub, s.config.awayClub]).toEqual([1, 2]);
    expect(s.config.humans[0]).toMatchObject({ kind: ControllerKind.HUMAN, side: 0 });
    const st = initMatch(s.config);
    expect(st.ctrl[3]!.kind).toBe(ControllerKind.CPU);
  });

  it('human sides follow side select (two humans, one each side)', () => {
    const ctx = fakeCtx();
    const s = buildShootoutSetup(ctx, { humans: [{ human: 0, side: 1, deviceIds: ['pad:0'] }, { human: 1, side: 0, deviceIds: ['pad:1'] }] });
    expect(s.config.humans.map((h) => h.side)).toEqual([1, 0]);
    expect(s.bindings).toEqual([{ human: 0, deviceIds: ['pad:0'] }, { human: 1, deviceIds: ['pad:1'] }]);
    const st = initMatch(s.config);
    expect([st.ctrl[2]!.kind, st.ctrl[3]!.kind]).toEqual([ControllerKind.NONE, ControllerKind.NONE]);
  });

  it('rematch keeps everything but the seed', () => {
    const s = buildShootoutSetup(fakeCtx());
    const r = rematchShootout(s, 31337);
    expect(r.config.seed).toBe(31337);
    expect({ ...r.config, seed: 0 }).toEqual({ ...s.config, seed: 0 });
    expect(r.onFinish).toBe(s.onFinish);
  });

  it('kicker preview: five outfield starters, best penalty takers first', () => {
    for (const club of CLUBS) {
      const k = shootoutKickers(club);
      expect(k).toHaveLength(5);
      for (const i of k) {
        expect(i).toBeLessThan(11);
        expect(club.squad[i]!.pos).not.toBe(Role.GK);
      }
    }
    expect(shootoutKickers(undefined)).toEqual([]);
  });

  it('winner banner text', () => {
    const base: MatchSummary = {
      teams: [{ goals: 0 } as MatchSummary['teams'][0], { goals: 0 } as MatchSummary['teams'][1]],
      players: [], goals: [], playerOfMatch: null, shootout: [4, 5], winner: 1, forfeit: -1, ticks: 1,
    };
    expect(shootoutHeadline(base, CLUBS, 0, 1)).toBe(`${CLUBS[1]!.code} win 5-4 on penalties`);
    expect(shootoutHeadline({ ...base, shootout: [6, 5], winner: 0 }, CLUBS, 3, 1)).toBe(`${CLUBS[3]!.code} win 6-5 on penalties`);
    expect(shootoutHeadline(null, CLUBS, 0, 1)).toBe('Shoot-out abandoned');
  });
});

describe('MOD-03 CPU v CPU shoot-out', () => {
  it('completes to POST_MATCH via runMatch with a winner', () => {
    const ctx = fakeCtx();
    for (const seed of [11, 12]) {
      const s = buildShootoutSetup(ctx, { homeClub: 0, awayClub: 5, humans: [] });
      s.config.seed = seed;
      const r = runMatch({ config: s.config, checker: 'core' });
      expect(r.exception).toBeUndefined();
      expect(r.endPhase).toBe(MatchPhase.POST_MATCH);
      expect(r.events.SHOOTOUT_KICK ?? 0).toBeGreaterThanOrEqual(6);
    }
  });

  it('the stats tracker reports the tally and the winner; the result reaches the records', () => {
    const ctx = fakeCtx();
    const setup = buildShootoutSetup(ctx, { homeClub: 2, awayClub: 3 });
    setup.config.seed = 5;
    // CPU plays both sides but the human config stays (records count the home side).
    const cfg = { ...setup.config, humans: setup.config.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 })) };
    const st = initMatch(cfg);
    const tracker = createStatsTracker();
    tracker.reset(st);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    let kicks = 0;
    for (let i = 0; i < 60 * 60 * 6 && st.match.phase !== MatchPhase.POST_MATCH; i++) {
      step(st, frames, ev);
      for (let k = 0; k < ev.count; k++) if (ev.get(k).type === EventType.SHOOTOUT_KICK) kicks++;
      tracker.onTick(st, ev);
    }
    expect(st.match.phase).toBe(MatchPhase.POST_MATCH);
    const sum = tracker.summary(st);
    expect(sum.shootout).not.toBeNull();
    expect(sum.shootout![0]).not.toBe(sum.shootout![1]);
    expect(sum.winner).toBe(sum.shootout![0] > sum.shootout![1] ? 0 : 1);
    expect(kicks).toBeGreaterThanOrEqual(6);
    expect([sum.teams[0].goals, sum.teams[1].goals]).toEqual([0, 0]);
    // Shoot-out kicks are not match shots or saves.
    expect([sum.teams[0].shots, sum.teams[1].shots, sum.teams[0].saves, sum.teams[1].saves]).toEqual([0, 0, 0, 0]);
    setup.onFinish!(sum, false);
    const rec = loadRecords(ctx.settings);
    expect(rec.played).toBe(1);
    expect(rec.won + rec.lost).toBe(1);
    expect([rec.goalsFor, rec.goalsAgainst]).toEqual([0, 0]);
  });
});

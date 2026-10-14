/**
 * MOD-01: Kick-Off flow and match configuration. Builders produce valid configs (humans / sides consistent with
 * bindings, CPU sides, halves clamp 2..10, clash-checked kits, clubs' formations), rematch changes the seed only,
 * flow helpers and remembered choices.
 */
import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../../src/contracts/app';
import { ControllerKind, Difficulty, FormationId, KitSlot, MatchPhase, ModeId, PracticeKind } from '../../src/contracts/enums';
import { ANY_DEVICE } from '../../src/app/localInput';
import { initMatch } from '../../src/sim/init';
import { resolveKits } from '../../src/render/kits';
import {
  buildKickOffSetup, changeTeamsTarget, choicesFromConfig, choicesFromSettings, nextKickOffScreen, prevKickOffScreen,
  rematchSetup, rememberChoices,
} from '../../src/modes/kickoff';
import { loadRecords } from '../../src/modes/records';
import { buildSetup, clampHalfMinutes, defaultSetup, humansFromChoices, resolveKitSlots } from '../../src/modes/setup';
import { createStatsTracker } from '../../src/modes/stats';
import { fakeCtx, fakeSettings } from './mod-01-fakes';

/** Every human with a side has exactly one binding and vice versa; sides without humans become CPU in the sim. */
function expectConsistent(setup: ReturnType<typeof buildSetup>): void {
  const c = setup.config;
  for (let h = 0; h < 2; h++) {
    const cfg = c.humans[h]!;
    const b = setup.bindings.filter((x) => x.human === h);
    if (cfg.kind === ControllerKind.HUMAN) {
      expect(cfg.side === 0 || cfg.side === 1).toBe(true);
      expect(b).toHaveLength(1);
      expect(b[0]!.deviceIds.length).toBeGreaterThan(0);
    } else {
      expect(cfg.side).toBe(-1);
      expect(b).toHaveLength(0);
    }
  }
  const s = initMatch(c);
  for (let team = 0; team < 2; team++) {
    const human = c.humans.some((h) => h.kind === ControllerKind.HUMAN && h.side === team);
    expect(s.ctrl[2 + team]!.kind).toBe(human ? ControllerKind.NONE : ControllerKind.CPU);
  }
}

describe('MOD-01 buildSetup', () => {
  it('default choices: human 0 at home on every local device, away CPU, values from settings.match', () => {
    const ctx = fakeCtx({ settings: fakeSettings((s) => { s.match.halfMinutes = 6; s.match.difficulty = Difficulty.WORLD_CLASS; }) });
    const setup = buildSetup(ctx);
    expect(setup.bindings).toEqual([{ human: 0, deviceIds: ['touch', 'keyboard', ANY_DEVICE] }]);
    expect(setup.config.humans[0]!.kind).toBe(ControllerKind.HUMAN);
    expect(setup.config.humans[0]!.side).toBe(0);
    expect(setup.config.halfMinutes).toBe(6);
    expect(setup.config.difficulty).toBe(Difficulty.WORLD_CLASS);
    expect(setup.config.mode).toBe(ModeId.KICK_OFF);
    expect(setup.config.startPhase).toBe(MatchPhase.KICK_OFF);
    expectConsistent(setup);
  });

  it('humans and sides follow the side-select bindings (P1 away, P2 sits out; two humans; nobody)', () => {
    const ctx = fakeCtx();
    const a = buildSetup(ctx, { humans: [{ human: 0, side: 1, deviceIds: ['pad:0'] }, { human: 1, side: -1, deviceIds: ['touch'] }] });
    expect(a.config.humans[0]).toMatchObject({ kind: ControllerKind.HUMAN, side: 1 });
    expect(a.config.humans[1]).toMatchObject({ kind: ControllerKind.NONE, side: -1 });
    expect(a.bindings).toEqual([{ human: 0, deviceIds: ['pad:0'] }]);
    expectConsistent(a);

    const b = buildSetup(ctx, { mode: ModeId.FRIEND_LOCAL, humans: [{ human: 1, side: 1, deviceIds: ['pad:1'] }, { human: 0, side: 0, deviceIds: ['touch', 'touch'] }] });
    expect(b.bindings).toEqual([{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['pad:1'] }]);
    expectConsistent(b);

    const cpu = buildSetup(ctx, { humans: [] });
    expect(cpu.bindings).toEqual([]);
    expectConsistent(cpu);
  });

  it('a human without devices, a bad side or a duplicate entry sits out', () => {
    const r = humansFromChoices(fakeSettings().get(), [
      { human: 0, side: 0, deviceIds: [] },
      { human: 1, side: 3, deviceIds: ['pad:0'] },
      { human: 1, side: 1, deviceIds: ['pad:1'] },
      { human: 7, side: 0, deviceIds: ['x'] },
    ]);
    expect(r.humans.map((h) => h.kind)).toEqual([ControllerKind.NONE, ControllerKind.NONE]);
    expect(r.bindings).toEqual([]);
  });

  it('half length clamps to 2..10 whole minutes; difficulty and clubs clamp to valid values', () => {
    expect([clampHalfMinutes(1), clampHalfMinutes(2), clampHalfMinutes(7.4), clampHalfMinutes(10), clampHalfMinutes(99), clampHalfMinutes(Number.NaN)])
      .toEqual([2, 2, 7, 10, 10, 4]);
    const ctx = fakeCtx();
    const s = buildSetup(ctx, { halfMinutes: 0.5, difficulty: 42 as Difficulty, homeClub: -3, awayClub: 999 });
    expect(s.config.halfMinutes).toBe(2);
    expect(s.config.difficulty).toBe(Difficulty.LEGEND);
    expect(s.config.homeClub).toBeGreaterThanOrEqual(0);
    expect(s.config.awayClub).toBeLessThan(ctx.clubs.length);
    expect(buildSetup(ctx, { halfMinutes: 12 }).config.halfMinutes).toBe(10);
  });

  it('formations default to the clubs\' preferred formations; explicit choices win', () => {
    const ctx = fakeCtx();
    const s = buildSetup(ctx, { homeClub: 3, awayClub: 4 });
    expect(s.config.homeFormation).toBe(ctx.clubs[3]!.formation);
    expect(s.config.awayFormation).toBe(ctx.clubs[4]!.formation);
    const t = buildSetup(ctx, { homeClub: 3, awayClub: 4, homeFormation: FormationId.F352, awayFormation: FormationId.F532 });
    expect([t.config.homeFormation, t.config.awayFormation]).toEqual([FormationId.F352, FormationId.F532]);
  });

  it('kits go through the GFX-08 clash check (a mirror match changes the away kit slot or keeps a clear pair)', () => {
    const ctx = fakeCtx();
    for (let c = 0; c < ctx.clubs.length; c++) {
      const [hk, ak] = resolveKitSlots(ctx.clubs, c, c, KitSlot.HOME, KitSlot.HOME);
      const k = resolveKits(ctx.clubs[c]!, ctx.clubs[c]!, KitSlot.HOME, KitSlot.HOME);
      if (!k.fallback[1]) expect(ak).toBe(k.slot[1]);
      expect(hk === KitSlot.HOME || hk === KitSlot.AWAY).toBe(true);
    }
    const s = buildSetup(ctx, { homeClub: 2, awayClub: 2, homeKit: KitSlot.HOME, awayKit: KitSlot.HOME });
    const k = resolveKits(ctx.clubs[2]!, ctx.clubs[2]!, KitSlot.HOME, KitSlot.HOME);
    expect(s.config.awayKit).toBe(k.fallback[1] ? KitSlot.HOME : k.slot[1]);
    expect(buildSetup(ctx, { homeClub: 2, awayClub: 2, homeKit: KitSlot.HOME, awayKit: KitSlot.HOME, rawKits: true }).config.awayKit).toBe(KitSlot.HOME);
  });

  it('every setup gets a fresh seed unless one is given', () => {
    const ctx = fakeCtx();
    const seeds = new Set<number>();
    for (let i = 0; i < 20; i++) seeds.add(buildSetup(ctx).config.seed);
    expect(seeds.size).toBeGreaterThan(15);
    expect(buildSetup(ctx, { seed: 1234 }).config.seed).toBe(1234);
  });

  it('mode rules: shoot-out starts in SHOOT_OUT with cup rules; practice starts IN_PLAY; cup forces cup rules', () => {
    const ctx = fakeCtx();
    const so = buildSetup(ctx, { mode: ModeId.SHOOT_OUT });
    expect([so.config.startPhase, so.config.cupRules]).toEqual([MatchPhase.SHOOT_OUT, 1]);
    const pr = buildSetup(ctx, { mode: ModeId.PRACTICE, practice: PracticeKind.CORNERS });
    expect([pr.config.startPhase, pr.config.practice]).toEqual([MatchPhase.IN_PLAY, PracticeKind.CORNERS]);
    expect(buildSetup(ctx, { mode: ModeId.CUP }).config.cupRules).toBe(1);
    expect(buildSetup(ctx, { cupRules: true }).config.cupRules).toBe(1);
    expect(buildSetup(ctx, { cupRules: false }).config.cupRules).toBe(0);
    expect(buildSetup(ctx, { night: true, offside: false, fouls: false }).config).toMatchObject({ night: 1, offside: 0, fouls: 0 });
  });
});

describe('MOD-01 Kick-Off flow', () => {
  it('rematch changes the seed only', () => {
    const ctx = fakeCtx();
    const a = buildKickOffSetup(ctx, { homeClub: 5, awayClub: 6, halfMinutes: 3, humans: [{ human: 0, side: 1, deviceIds: ['touch'] }] });
    const b = rematchSetup(a, 999);
    expect(b.config.seed).toBe(999);
    expect({ ...b.config, seed: 0 }).toEqual({ ...a.config, seed: 0 });
    expect(b.bindings).toEqual(a.bindings);
    expect(b.onFinish).toBe(a.onFinish);
    expect(b.config).not.toBe(a.config);
    expect(rematchSetup(a).config.seed).not.toBe(a.config.seed);
  });

  it('next screen after each step; Back steps; change teams starts from the finished match', () => {
    expect(nextKickOffScreen(null)).toBe('mode-setup');
    expect(nextKickOffScreen('mode-setup')).toBe('team-select');
    expect(nextKickOffScreen('team-select')).toBe('side-select');
    expect(nextKickOffScreen('side-select')).toBe('match-settings');
    expect(nextKickOffScreen('match-settings')).toBeNull();
    expect(prevKickOffScreen('team-select')).toBe('mode-setup');
    expect(prevKickOffScreen('mode-setup')).toBe('main');
    const ctx = fakeCtx();
    const s = buildKickOffSetup(ctx, { homeClub: 7, awayClub: 8, mode: ModeId.FRIEND_LOCAL });
    const [id, params] = changeTeamsTarget(s);
    expect(id).toBe('team-select');
    expect((params.choices as { homeClub: number }).homeClub).toBe(7);
    expect(changeTeamsTarget(null)).toEqual(['team-select', {}]);
    expect(choicesFromConfig(s.config).mode).toBe(ModeId.FRIEND_LOCAL);
  });

  it('remembers the last choices in settings.match', () => {
    const ctx = fakeCtx();
    rememberChoices(ctx, { homeClub: 9, awayClub: 10, homeKit: KitSlot.AWAY, halfMinutes: 15, difficulty: Difficulty.LEGEND, night: true, offside: false });
    const m = ctx.settings.get().match;
    expect(m).toMatchObject({ homeClub: 9, awayClub: 10, homeKit: KitSlot.AWAY, halfMinutes: 10, difficulty: Difficulty.LEGEND, night: true, offside: false });
    rememberChoices(ctx, { homeClub: 999 });
    expect(ctx.settings.get().match.homeClub).toBe(9);
    expect(choicesFromSettings(ctx.settings.get())).toMatchObject({ homeClub: 9, awayClub: 10, halfMinutes: 10 });
    const next = buildSetup(ctx);
    expect([next.config.homeClub, next.config.awayClub, next.config.halfMinutes]).toEqual([9, 10, 10]);
  });

  it('a finished Kick-Off / Play now match adds to the lifetime records (quits do not)', () => {
    const ctx = fakeCtx();
    const setup = defaultSetup(ctx);
    const s = initMatch(setup.config);
    s.teams[0]!.goals = 2;
    s.match.winner = 0;
    const tracker = createStatsTracker();
    tracker.reset(s);
    const summary: MatchSummary = tracker.summary(s);
    setup.onFinish!(summary, true);
    expect(loadRecords(ctx.settings).played).toBe(0);
    setup.onFinish!(summary, false);
    expect(loadRecords(ctx.settings)).toMatchObject({ played: 1, won: 1, goalsFor: 2 });
    const k = buildKickOffSetup(ctx, {});
    k.onFinish!(summary, false);
    expect(loadRecords(ctx.settings).played).toBe(2);
  });
});
